import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Box, ExternalLink, Play, RotateCcw } from 'lucide-react';
import {
  fetchModelAssetDataUrl,
  openExternal,
  openLocalPath,
  readModelAssetDataUrl,
} from '@/lib/tauri';
import { canPreviewModelUrl, modelExtension } from './lib/modelLink';

type ThreeModule = typeof import('three');
type Object3D = import('three').Object3D;
type Scene = import('three').Scene;
type PerspectiveCamera = import('three').PerspectiveCamera;
type WebGLRenderer = import('three').WebGLRenderer;
type BufferGeometry = import('three').BufferGeometry;
type Material = import('three').Material;
type AnimationAction = import('three').AnimationAction;
type AnimationClip = import('three').AnimationClip;
type AnimationMixer = import('three').AnimationMixer;
type OrbitControls = import('three/addons/controls/OrbitControls.js').OrbitControls;
type GLTF = import('three/addons/loaders/GLTFLoader.js').GLTF;
type BVHLoadResult = { skeleton: import('three').Skeleton; clip: AnimationClip };

type ViewerStatus = 'loading' | 'ready' | 'unsupported' | 'error';
type LoadedModel = { object: Object3D; animations: AnimationClip[] };
type AnimationOption = { id: string; label: string; source: 'clip' | 'requested' };

export default function ModelViewer({
  src,
  label,
  cwd,
  defaultAnimations,
}: {
  src: string;
  label?: string;
  cwd?: string;
  defaultAnimations?: string[];
}) {
  const viewportRef = useRef<HTMLSpanElement | null>(null);
  const resetViewRef = useRef<() => void>(() => {});
  const animationMixerRef = useRef<AnimationMixer | null>(null);
  const animationActionsRef = useRef<Map<string, AnimationAction>>(new Map());
  const previewable = canPreviewModelUrl(src);
  const defaultAnimationKey = (defaultAnimations ?? [])
    .map((name) => name.trim())
    .filter(Boolean)
    .join('\u0001');
  const defaultAnimationOptions = useMemo(
    () =>
      defaultAnimationKey
        ? defaultAnimationKey.split('\u0001').map(previewAnimationOption)
        : [],
    [defaultAnimationKey],
  );
  const [status, setStatus] = useState<ViewerStatus>(
    previewable ? 'loading' : 'unsupported',
  );
  const [error, setError] = useState('');
  const [animations, setAnimations] = useState<AnimationOption[]>(
    defaultAnimationOptions,
  );
  const [selectedAnimationId, setSelectedAnimationId] = useState(
    defaultAnimationOptions[0]?.id ?? '',
  );
  const [canPlayAnimations, setCanPlayAnimations] = useState(false);
  const [animationMessage, setAnimationMessage] = useState('');
  const title = label?.trim() || '3D 模型';

  useEffect(() => {
    setStatus(previewable ? 'loading' : 'unsupported');
    setError('');
    setAnimations(defaultAnimationOptions);
    setSelectedAnimationId(defaultAnimationOptions[0]?.id ?? '');
    setCanPlayAnimations(false);
    setAnimationMessage('');
  }, [defaultAnimationOptions, previewable, src]);

  useEffect(() => {
    playAnimationAction(animationActionsRef.current, selectedAnimationId);
  }, [selectedAnimationId]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!previewable || !viewport) return;

    let disposed = false;
    let frameId = 0;
    let scene: Scene | null = null;
    let renderer: WebGLRenderer | null = null;
    let controls: OrbitControls | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let cleanupResize = () => {};
    animationMixerRef.current?.stopAllAction();
    animationMixerRef.current = null;
    animationActionsRef.current.clear();

    const start = async () => {
      try {
        const [
          THREE,
          controlsModule,
          gltfModule,
          objModule,
          stlModule,
          fbxModule,
          plyModule,
          bvhModule,
        ] = await Promise.all([
          import('three'),
          import('three/addons/controls/OrbitControls.js'),
          import('three/addons/loaders/GLTFLoader.js'),
          import('three/addons/loaders/OBJLoader.js'),
          import('three/addons/loaders/STLLoader.js'),
          import('three/addons/loaders/FBXLoader.js'),
          import('three/addons/loaders/PLYLoader.js'),
          import('three/addons/loaders/BVHLoader.js'),
        ]);
        if (disposed) return;

        while (viewport.firstChild) viewport.removeChild(viewport.firstChild);

        scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
        camera.position.set(2.5, 1.7, 2.5);

        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.domElement.className = 'ai-model-viewer__canvas';
        viewport.appendChild(renderer.domElement);

        scene.add(new THREE.HemisphereLight(0xffffff, 0x475569, 2.2));
        const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
        keyLight.position.set(4, 6, 5);
        scene.add(keyLight);
        const fillLight = new THREE.DirectionalLight(0x8fd7ff, 0.9);
        fillLight.position.set(-4, 2, -3);
        scene.add(fillLight);

        const grid = new THREE.GridHelper(8, 16, 0x64748b, 0x334155);
        const clock = new THREE.Clock();
        const gridMaterial = Array.isArray(grid.material)
          ? grid.material
          : [grid.material];
        for (const material of gridMaterial) {
          material.transparent = true;
          material.opacity = 0.24;
        }
        scene.add(grid);

        controls = new controlsModule.OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.enablePan = true;
        controls.screenSpacePanning = true;
        controls.target.set(0, 0, 0);
        controls.update();

        let viewportVisible = true;
        const resize = () => {
          if (!renderer) return;
          const rect = viewport.getBoundingClientRect();
          viewportVisible = rect.width > 0 && rect.height > 0;
          if (!viewportVisible) return;
          const width = Math.max(1, Math.floor(rect.width));
          const height = Math.max(1, Math.floor(rect.height));
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
          renderer.setSize(width, height, false);
        };
        resize();
        if (typeof ResizeObserver !== 'undefined') {
          resizeObserver = new ResizeObserver(resize);
          resizeObserver.observe(viewport);
        } else {
          window.addEventListener('resize', resize);
          cleanupResize = () => window.removeEventListener('resize', resize);
        }

        const previewSrc = await resolveModelPreviewSrc(src, cwd);
        if (disposed) return;

        const object = await loadModel(
          THREE,
          {
            gltf: gltfModule,
            obj: objModule,
            stl: stlModule,
            fbx: fbxModule,
            ply: plyModule,
            bvh: bvhModule,
          },
          previewSrc,
          src,
        );
        if (disposed || !scene || !controls) return;
        scene.add(object.object);
        const clipAnimationOptions = object.animations.map(animationOption);
        const hasSkeleton = hasSkinnedMesh(object.object);
        const playableAnimations = hasSkeleton && clipAnimationOptions.length > 0;
        const animationOptions = playableAnimations
          ? clipAnimationOptions
          : clipAnimationOptions.length
            ? clipAnimationOptions
            : defaultAnimationOptions;
        const nextAnimationId = playableAnimations
          ? animationOptions[0]?.id ?? ''
          : '';
        setAnimations(animationOptions);
        setSelectedAnimationId(nextAnimationId);
        setCanPlayAnimations(playableAnimations);
        setAnimationMessage(
          animationReadinessMessage({
            hasSkeleton,
            hasAnimations: object.animations.length > 0,
            expectsAnimation: defaultAnimationOptions.length > 0 ||
              clipAnimationOptions.length > 0,
          }),
        );
        if (playableAnimations) {
          const mixer = new THREE.AnimationMixer(object.object);
          const actions = new Map<string, AnimationAction>();
          object.animations.forEach((clip, index) => {
            actions.set(animationClipId(index), mixer.clipAction(clip));
          });
          animationMixerRef.current = mixer;
          animationActionsRef.current = actions;
          playAnimationAction(actions, nextAnimationId);
        }
        const activeControls = controls;
        const reset = () =>
          frameObject(THREE, object.object, camera, activeControls);
        resetViewRef.current = reset;
        reset();
        setStatus('ready');

        const animate = () => {
          if (disposed || !renderer || !scene || !controls) return;
          const delta = clock.getDelta();
          if (viewportVisible) {
            animationMixerRef.current?.update(delta);
            controls.update();
            renderer.render(scene, camera);
          }
          frameId = window.requestAnimationFrame(animate);
        };
        animate();
      } catch (err) {
        if (disposed) return;
        setStatus('error');
        setError(modelPreviewErrorMessage(err));
      }
    };

    void start();

    return () => {
      disposed = true;
      cleanupResize();
      resizeObserver?.disconnect();
      if (frameId) window.cancelAnimationFrame(frameId);
      controls?.dispose();
      animationMixerRef.current?.stopAllAction();
      animationMixerRef.current = null;
      animationActionsRef.current.clear();
      if (renderer) {
        renderer.dispose();
        if (renderer.domElement.parentNode === viewport) {
          viewport.removeChild(renderer.domElement);
        }
      }
      if (scene) disposeObject(scene);
      resetViewRef.current = () => {};
    };
  }, [cwd, defaultAnimationOptions, previewable, src]);

  const openAsset = (event: MouseEvent<HTMLAnchorElement>) => {
    if (/^data:/i.test(src)) return;
    event.preventDefault();
    if (/^https?:/i.test(src)) {
      void openExternal(src);
      return;
    }
    void openLocalPath(src, { cwd });
  };

  const playAnimation = (animationId: string) => {
    if (!canPlayAnimations) return;
    if (animationId === selectedAnimationId) {
      playAnimationAction(animationActionsRef.current, animationId);
      return;
    }
    setSelectedAnimationId(animationId);
  };

  const statusText =
    status === 'loading'
      ? '正在加载模型…'
      : status === 'unsupported'
        ? '当前格式暂不支持内嵌预览，可打开或下载模型。'
        : status === 'error'
          ? `模型预览失败：${error || '无法加载模型'}`
          : '';

  return (
    <span className="ai-model-viewer my-2 w-full max-w-2xl overflow-hidden rounded-md border border-border bg-bg-alt">
      <span className="ai-model-viewer__header flex min-w-0 items-center justify-between gap-2 border-b border-border-soft px-2 py-1.5">
        <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-fg-dim">
          <Box size={13} className="shrink-0 text-accent" />
          <span className="truncate">{title}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => resetViewRef.current()}
            disabled={status !== 'ready'}
            title="重置视角"
            aria-label="重置视角"
            className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-panel-2 text-fg-dim transition-colors hover:border-accent hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RotateCcw size={13} />
          </button>
          {animations.length > 0 ? (
            <span
              className="flex max-w-56 min-w-0 items-center gap-1 overflow-x-auto"
              aria-label="模型动画"
            >
              {animations.map((animation) => {
                const selected = selectedAnimationId === animation.id;
                return (
                  <button
                    key={animation.id}
                    type="button"
                    onClick={() => playAnimation(animation.id)}
                    disabled={status !== 'ready' || !canPlayAnimations}
                    title={
                      canPlayAnimations
                        ? `播放动画 ${animation.label}`
                        : '模型未包含可播放的骨骼动画'
                    }
                    aria-label={`播放动画 ${animation.label}`}
                    aria-pressed={selected}
                    className={
                      'flex h-7 min-w-0 shrink-0 items-center gap-1 rounded-md border px-2 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-45 ' +
                      (selected
                        ? 'border-accent bg-border-soft text-fg'
                        : 'border-border bg-panel-2 text-fg-dim hover:border-accent hover:text-fg')
                    }
                  >
                    <Play size={11} className="shrink-0" />
                    <span className="max-w-16 truncate">{animation.label}</span>
                  </button>
                );
              })}
            </span>
          ) : null}
          <a
            href={src}
            download={!/^https?:/i.test(src) ? 'model.glb' : undefined}
            onClick={openAsset}
            title="打开或下载"
            aria-label="打开或下载"
            className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-panel-2 text-fg-dim transition-colors hover:border-accent hover:text-fg"
          >
            <ExternalLink size={13} />
          </a>
        </span>
      </span>
      <span className="ai-model-viewer__body">
        <span
          ref={viewportRef}
          role="img"
          aria-label="3D 模型视口"
          className="ai-model-viewer__viewport"
        />
        {statusText ? (
          <span className="ai-model-viewer__status text-xs text-fg-dim">
            {statusText}
          </span>
        ) : null}
        {status === 'ready' && animationMessage ? (
          <span className="ai-model-viewer__status text-xs text-fg-dim">
            {animationMessage}
          </span>
        ) : null}
      </span>
    </span>
  );
}

async function resolveModelPreviewSrc(src: string, cwd?: string): Promise<string> {
  if (/^data:/i.test(src)) return src;
  try {
    if (/^https?:\/\//i.test(src)) return await fetchModelAssetDataUrl(src);
    return await readModelAssetDataUrl(src, { cwd });
  } catch (err) {
    if (err instanceof Error && err.message === 'NO_BACKEND') return src;
    throw err;
  }
}

function modelPreviewErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message === 'Failed to fetch') {
    return '远程模型资源被浏览器/WebView 拦截，或链接已过期。可点右上角打开或下载。';
  }
  return message;
}

async function loadModel(
  THREE: ThreeModule,
  modules: {
    gltf: typeof import('three/addons/loaders/GLTFLoader.js');
    obj: typeof import('three/addons/loaders/OBJLoader.js');
    stl: typeof import('three/addons/loaders/STLLoader.js');
    fbx: typeof import('three/addons/loaders/FBXLoader.js');
    ply: typeof import('three/addons/loaders/PLYLoader.js');
    bvh: typeof import('three/addons/loaders/BVHLoader.js');
  },
  src: string,
  extensionSrc = src,
): Promise<LoadedModel> {
  const previewExt = modelExtension(src);
  const ext = previewExt === 'zip' || previewExt === 'usdz'
    ? previewExt
    : modelExtension(extensionSrc);
  if (ext === 'glb' || ext === 'gltf') {
    const gltf = await loadFromLoader<GLTF>(new modules.gltf.GLTFLoader(), src);
    return { object: gltf.scene, animations: gltf.animations ?? [] };
  }
  if (ext === 'obj') {
    return {
      object: await loadFromLoader<Object3D>(new modules.obj.OBJLoader(), src),
      animations: [],
    };
  }
  if (ext === 'fbx') {
    const object = await loadFromLoader<Object3D>(new modules.fbx.FBXLoader(), src);
    return { object, animations: object.animations ?? [] };
  }
  if (ext === 'bvh') {
    const result = await loadFromLoader<BVHLoadResult>(new modules.bvh.BVHLoader(), src);
    const rootBone = result.skeleton.bones[0];
    const container = new THREE.Group();
    if (rootBone) container.add(rootBone);
    const helper = new THREE.SkeletonHelper(rootBone ?? container);
    (helper as typeof helper & { skeleton: import('three').Skeleton }).skeleton =
      result.skeleton;
    container.add(helper);
    return { object: container, animations: result.clip ? [result.clip] : [] };
  }
  if (ext === 'stl') {
    const geometry = await loadFromLoader<BufferGeometry>(
      new modules.stl.STLLoader(),
      src,
    );
    return {
      object: new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({
          color: 0x9bd1ff,
          roughness: 0.62,
          metalness: 0.08,
        }),
      ),
      animations: [],
    };
  }
  if (ext === 'ply') {
    const geometry = await loadFromLoader<BufferGeometry>(
      new modules.ply.PLYLoader(),
      src,
    );
    geometry.computeVertexNormals();
    return {
      object: new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({
          color: 0xc7f9cc,
          roughness: 0.68,
          metalness: 0.04,
        }),
      ),
      animations: [],
    };
  }
  throw new Error(`${ext.toUpperCase()} 暂不支持内嵌预览`);
}

function animationClipId(index: number): string {
  return `clip:${index}`;
}

function animationOption(clip: AnimationClip, index: number): AnimationOption {
  const label = clip.name?.trim() || `动画 ${index + 1}`;
  return { id: animationClipId(index), label, source: 'clip' };
}

function previewAnimationOption(label: string, index: number): AnimationOption {
  return {
    id: `requested:${index}:${label.toLowerCase()}`,
    label,
    source: 'requested',
  };
}

function playAnimationAction(
  actions: Map<string, AnimationAction>,
  selectedId: string,
): void {
  for (const [id, action] of actions) {
    if (id === selectedId) {
      action.reset().fadeIn(0.15).play();
    } else {
      action.fadeOut(0.15);
    }
  }
}

function loadFromLoader<T>(
  loader: {
    load: (
      url: string,
      onLoad: (value: T) => void,
      onProgress?: (event: ProgressEvent) => void,
      onError?: (event: unknown) => void,
    ) => void;
  },
  url: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    loader.load(url, resolve, undefined, (event) => {
      reject(event instanceof Error ? event : new Error('模型资源加载失败'));
    });
  });
}

function hasSkinnedMesh(object: Object3D): boolean {
  let found = false;
  object.traverse((child) => {
    const candidate = child as Object3D & {
      isSkinnedMesh?: boolean;
      skeleton?: unknown;
    };
    if (candidate.isSkinnedMesh || candidate.skeleton) found = true;
  });
  return found;
}

function animationReadinessMessage({
  hasSkeleton,
  hasAnimations,
  expectsAnimation,
}: {
  hasSkeleton: boolean;
  hasAnimations: boolean;
  expectsAnimation: boolean;
}): string {
  if (hasSkeleton && hasAnimations) return '';
  if (!expectsAnimation) return '';
  if (!hasSkeleton && !hasAnimations) {
    return '模型未包含真实骨骼/动画，需要先生成动画版模型。';
  }
  if (!hasSkeleton) return '模型有动画片段，但未检测到骨骼蒙皮，暂不播放。';
  return '模型已绑定骨骼，但缺少可播放动画片段。';
}

function frameObject(
  THREE: ThreeModule,
  object: Object3D,
  camera: PerspectiveCamera,
  controls: OrbitControls,
): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) {
    camera.position.set(2.6, 1.8, 2.6);
    camera.lookAt(0, 0, 0);
    controls.target.set(0, 0, 0);
    controls.update();
    return;
  }

  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  object.position.sub(center);

  const maxSize = Math.max(size.x, size.y, size.z, 1);
  const distance = (maxSize / (2 * Math.tan((Math.PI * camera.fov) / 360))) * 1.45;
  camera.near = Math.max(distance / 100, 0.01);
  camera.far = Math.max(distance * 100, 100);
  camera.position.set(distance, distance * 0.72, distance);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  controls.minDistance = Math.max(distance / 25, 0.02);
  controls.maxDistance = Math.max(distance * 8, 10);
  controls.target.set(0, 0, 0);
  controls.update();
}

function disposeObject(root: Object3D): void {
  root.traverse((child) => {
    const mesh = child as Object3D & {
      geometry?: BufferGeometry;
      material?: Material | Material[];
    };
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material)
      ? mesh.material
      : mesh.material
        ? [mesh.material]
        : [];
    for (const material of materials) material.dispose();
  });
}
