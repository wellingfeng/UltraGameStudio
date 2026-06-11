import {
  type ReactNode,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AlertTriangle,
  Box,
  ChevronRight,
  Code2,
  File,
  FilePen,
  // FileDiff, // 工作区改动 tab 已移除，不再使用该图标。
  FileText,
  Folder,
  FolderOpen,
  History,
  Image as ImageIcon,
  LayoutGrid,
  List,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import FilePreviewDrawer from '@/components/ai/FilePreviewDrawer';
import type { FileRef } from '@/components/ai/lib/filePath';
import { t } from '@/lib/i18n';
import {
  extractSessionFiles,
  type SessionFileEntry,
} from '@/lib/sessionFiles';
import {
  buildSessionIgnorePredicate,
  sessionIgnoreRootFromContents,
  type SessionIgnoreRoot,
} from '@/lib/sessionFileIgnore';
import { IGNORE_FILE_NAMES } from '@/lib/ignoreRules';
import {
  applyProjectFileDragDropEffect,
  finishProjectFileDrag,
  setProjectFileDragData,
  updateProjectFileDragPoint,
} from '@/lib/projectFileDrag';
import {
  // 文件修改状态扫描功能已停用：这些 P4/VCS 扫描接口会对服务器（尤其是
  // Perforce 大型 depot）发起海量 reconcile 请求，存在压垮服务器的风险，
  // 因此整个“扫描文件修改状态”功能连同其后台扫描调用一并注释关闭。
  // listWorkspaceVcsStatusShallow,
  // readWorkspaceVcsStatusCache,
  // startWorkspaceVcsStatusScan,
  // onWorkspaceVcsScanProgress,
  // type WorkspaceVcsScanProgress,
  listWorkspaceDirectory,
  openLocalPath,
  previewLocalFile,
  type WorkspaceChanges,
  type WorkspaceTreeEntry,
} from '@/lib/tauri';
import { useResizableWidth } from '@/lib/useResizableWidth';
import {
  uniqueWorkspaceHistory,
  workspacePathKey,
} from '@/lib/workspaceHistory';
import { basename } from '@/lib/folderPicker';
import {
  buildWorkspaceVcsTreeStatus,
  workspaceVcsStatusForEntry,
  workspaceVcsStatusLabel,
  type WorkspaceVcsTreeStatusIndex,
  type WorkspaceVcsTreeStatusKind,
  type WorkspaceVcsVirtualTreeEntry,
} from '@/lib/workspaceVcsTreeStatus';
import { useStore } from '@/store/useStore';

type ProjectPanelTab = 'files' | 'session';
type ProjectTreeViewMode = 'tree' | 'preview';
type ProjectEngine = 'unreal' | 'unity' | 'godot' | 'generic';

type ThumbnailState =
  | { status: 'loading'; lastAccessed: number }
  | { status: 'ready'; dataUrl: string; lastAccessed: number }
  | { status: 'error'; lastAccessed: number };

type ThumbnailCache = Record<string, ThumbnailState>;
type ThumbnailVisibility = Record<string, true>;
type ProjectEntryContextMenuState =
  | null
  | {
      x: number;
      y: number;
      entry: WorkspaceTreeEntry;
    };

type DirectoryState =
  | {
      status: 'loading';
      entries: WorkspaceTreeEntry[];
    }
  | {
      status: 'ready';
      entries: WorkspaceTreeEntry[];
      truncated: boolean;
      totalEntries: number;
    }
  | {
      status: 'error';
      entries: WorkspaceTreeEntry[];
      message: string;
    };

interface WorkspaceTreeState {
  rootPath: string;
  directories: Record<string, DirectoryState>;
  expanded: Record<string, boolean>;
}

type WorkspaceTreeCache = Record<string, WorkspaceTreeState>;

type WorkspaceVcsTreeState =
  | { status: 'idle'; snapshot: WorkspaceChanges | null; message?: undefined }
  | { status: 'loading'; snapshot: WorkspaceChanges | null; message?: undefined }
  | { status: 'ready'; snapshot: WorkspaceChanges; message?: undefined }
  | { status: 'error'; snapshot: WorkspaceChanges | null; message: string };

interface ProjectTreeRenderEntry {
  entry: WorkspaceTreeEntry;
  virtualDeleted: boolean;
  vcsStatus?: WorkspaceVcsTreeStatusKind;
  vcsScanning?: boolean;
}

const IMAGE_EXTENSIONS = new Set([
  'png',
  'apng',
  'jpg',
  'jpeg',
  'jpe',
  'jfif',
  'gif',
  'webp',
  'bmp',
  'dib',
  'ico',
  'cur',
  'svg',
  'avif',
]);

const CODE_EXTENSIONS = new Set([
  'c',
  'cc',
  'cpp',
  'cs',
  'css',
  'gd',
  'h',
  'hpp',
  'html',
  'js',
  'json',
  'jsx',
  'rs',
  'ts',
  'tsx',
  'vue',
  'xml',
  'yaml',
  'yml',
]);

const ENGINE_LABELS: Record<ProjectEngine, string> = {
  unreal: 'Unreal',
  unity: 'Unity',
  godot: 'Godot',
  generic: '项目',
};

const ENGINE_BADGES: Record<ProjectEngine, string> = {
  unreal: 'UE',
  unity: 'UNITY',
  godot: 'GODOT',
  generic: 'FILE',
};

const THUMBNAIL_CACHE_LIMIT = 96;
const THUMBNAIL_LOAD_BATCH_SIZE = 12;
const THUMBNAIL_ROOT_MARGIN = '280px 0px';
const CONTEXT_MENU_WIDTH = 176;
const CONTEXT_MENU_HEIGHT = 36;
const CONTEXT_MENU_MARGIN = 8;
// 文件修改状态扫描已停用，扫描轮询间隔与开关偏好读取不再需要。
// const VCS_TREE_REFRESH_INTERVAL_MS = 30_000;
// const VCS_STATUS_SCAN_ENABLED_STORAGE_KEY =
//   'freeultracode.projectFileTreeVcsScan.v1';
//
// function readVcsScanEnabledPreference(): boolean {
//   if (typeof window === 'undefined') return false;
//   // Default OFF: scanning file modification status runs many VCS commands, so
//   // it stays disabled until the user explicitly opts in.
//   return (
//     window.localStorage.getItem(VCS_STATUS_SCAN_ENABLED_STORAGE_KEY) === 'on'
//   );
// }
const VCS_STATUS_ICON_SRC: Record<WorkspaceVcsTreeStatusKind, string> = {
  added: `${import.meta.env.BASE_URL}vcs/tortoisegit/AddedIcon.png`,
  modified: `${import.meta.env.BASE_URL}vcs/tortoisegit/ModifiedIcon.png`,
  deleted: `${import.meta.env.BASE_URL}vcs/tortoisegit/DeletedIcon.png`,
  renamed: `${import.meta.env.BASE_URL}vcs/tortoisegit/ReplacedIcon.png`,
};

function changeSourceLabel(source?: string): string {
  if (source === 'git') return 'Git';
  if (source === 'svn') return 'SVN';
  if (source === 'p4') return 'P4';
  if (source === 'none') return '无 VCS';
  return '快照';
}

function directoryKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

function isImageEntry(entry: WorkspaceTreeEntry): boolean {
  return entry.kind === 'file' && IMAGE_EXTENSIONS.has(fileExtension(entry.name));
}

function thumbnailKey(entry: WorkspaceTreeEntry): string {
  return `${entry.path}::${entry.modifiedAtMs ?? ''}::${entry.sizeBytes ?? ''}`;
}

function pruneThumbnailCache(
  cache: ThumbnailCache,
  visibleThumbnails: ThumbnailVisibility,
): ThumbnailCache {
  const readyEntries = Object.entries(cache).filter(
    ([, thumbnail]) => thumbnail.status === 'ready',
  );
  if (readyEntries.length <= THUMBNAIL_CACHE_LIMIT) return cache;

  const evictable = readyEntries
    .filter(([key]) => !visibleThumbnails[key])
    .sort(([, a], [, b]) => a.lastAccessed - b.lastAccessed);
  const overflow = readyEntries.length - THUMBNAIL_CACHE_LIMIT;
  if (overflow <= 0 || evictable.length === 0) return cache;

  const next = { ...cache };
  for (const [key] of evictable.slice(0, overflow)) {
    delete next[key];
  }
  return next;
}

function detectProjectEngine(entries: WorkspaceTreeEntry[] | undefined): ProjectEngine {
  if (!entries || entries.length === 0) return 'generic';
  const names = new Set(entries.map((entry) => entry.name.toLowerCase()));
  const hasDirectory = (name: string) =>
    entries.some(
      (entry) => entry.kind === 'directory' && entry.name.toLowerCase() === name,
    );
  const hasFile = (name: string) =>
    entries.some(
      (entry) => entry.kind === 'file' && entry.name.toLowerCase() === name,
    );

  if (
    entries.some(
      (entry) =>
        entry.kind === 'file' && entry.name.toLowerCase().endsWith('.uproject'),
    )
  ) {
    return 'unreal';
  }
  if (
    hasDirectory('content') &&
    hasDirectory('config') &&
    (hasDirectory('source') || names.has('saved'))
  ) {
    return 'unreal';
  }
  if (hasFile('project.godot')) return 'godot';
  if (
    hasDirectory('assets') &&
    hasDirectory('projectsettings') &&
    (hasDirectory('packages') || hasDirectory('library'))
  ) {
    return 'unity';
  }
  return 'generic';
}

function entryPreviewLabel(entry: WorkspaceTreeEntry, engine: ProjectEngine): string {
  if (entry.kind === 'directory') {
    const lower = entry.name.toLowerCase();
    if (engine === 'unreal' && lower === 'content') return 'CONTENT';
    if (engine === 'unity' && lower === 'assets') return 'ASSETS';
    if (engine === 'godot' && lower === 'addons') return 'ADDONS';
    return 'DIR';
  }

  const ext = fileExtension(entry.name);
  if (IMAGE_EXTENSIONS.has(ext)) return ext.toUpperCase() || 'IMG';

  if (engine === 'unreal') {
    if (ext === 'umap') return 'MAP';
    if (ext === 'uasset') return 'ASSET';
    if (ext === 'uproject') return 'UPROJ';
  }
  if (engine === 'unity') {
    if (ext === 'unity') return 'SCENE';
    if (ext === 'prefab') return 'PREFAB';
    if (ext === 'mat') return 'MAT';
    if (ext === 'asset') return 'ASSET';
    if (ext === 'cs') return 'C#';
  }
  if (engine === 'godot') {
    if (ext === 'tscn' || ext === 'scn') return 'SCENE';
    if (ext === 'tres' || ext === 'res') return 'RES';
    if (ext === 'gd') return 'GD';
    if (entry.name.toLowerCase() === 'project.godot') return 'PROJECT';
  }

  if (CODE_EXTENSIONS.has(ext)) return ext.toUpperCase();
  return ext ? ext.toUpperCase() : 'FILE';
}

function previewSurface(engine: ProjectEngine, entry: WorkspaceTreeEntry): string {
  if (entry.kind === 'directory') {
    return 'linear-gradient(135deg, color-mix(in oklab, var(--accent-2) 34%, var(--panel-2)), var(--panel))';
  }
  if (isImageEntry(entry)) {
    return 'linear-gradient(135deg, color-mix(in oklab, var(--accent-3) 36%, var(--panel-2)), var(--panel))';
  }
  if (engine === 'unreal') {
    return 'linear-gradient(135deg, #111827, #334155 48%, #f59e0b)';
  }
  if (engine === 'unity') {
    return 'linear-gradient(135deg, #0f172a, #1f2937 48%, #38bdf8)';
  }
  if (engine === 'godot') {
    return 'linear-gradient(135deg, #0b1220, #1d4ed8 48%, #60a5fa)';
  }
  return 'linear-gradient(135deg, var(--panel-2), color-mix(in oklab, var(--accent) 28%, var(--panel)))';
}

function contextMenuPosition(
  event: ReactMouseEvent,
): Pick<NonNullable<ProjectEntryContextMenuState>, 'x' | 'y'> {
  if (typeof window === 'undefined') {
    return { x: event.clientX, y: event.clientY };
  }
  return {
    x: Math.max(
      CONTEXT_MENU_MARGIN,
      Math.min(
        event.clientX,
        window.innerWidth - CONTEXT_MENU_WIDTH - CONTEXT_MENU_MARGIN,
      ),
    ),
    y: Math.max(
      CONTEXT_MENU_MARGIN,
      Math.min(
        event.clientY,
        window.innerHeight - CONTEXT_MENU_HEIGHT - CONTEXT_MENU_MARGIN,
      ),
    ),
  };
}

function PreviewGlyph({
  entry,
  engine,
}: {
  entry: WorkspaceTreeEntry;
  engine: ProjectEngine;
}) {
  if (entry.kind === 'directory') return <FolderOpen size={28} />;
  if (isImageEntry(entry)) return <ImageIcon size={28} />;
  if (CODE_EXTENSIONS.has(fileExtension(entry.name))) return <Code2 size={28} />;
  if (engine !== 'generic') return <Box size={29} />;
  return <FileText size={28} />;
}

function PreviewCard({
  entry,
  engine,
  vcsStatus,
  vcsScanning,
  thumbnail,
  thumbnailId,
  draggable,
  onVisibilityChange,
  onOpen,
  onDragStart,
  onDrag,
  onDragEnd,
  onContextMenu,
}: {
  entry: WorkspaceTreeEntry;
  engine: ProjectEngine;
  vcsStatus?: WorkspaceVcsTreeStatusKind;
  vcsScanning?: boolean;
  thumbnail?: ThumbnailState;
  thumbnailId: string;
  draggable: boolean;
  onVisibilityChange: (key: string, visible: boolean) => void;
  onOpen: () => void;
  onDragStart: (event: ReactDragEvent<HTMLButtonElement>) => void;
  onDrag: (event: ReactDragEvent<HTMLButtonElement>) => void;
  onDragEnd: (event: ReactDragEvent<HTMLButtonElement>) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  const cardRef = useRef<HTMLButtonElement | null>(null);
  const dataUrl = thumbnail?.status === 'ready' ? thumbnail.dataUrl : null;
  const label = entryPreviewLabel(entry, engine);
  const imageEntry = isImageEntry(entry);

  useEffect(() => {
    if (!imageEntry) return;
    const node = cardRef.current;
    if (!node) return;

    if (typeof window === 'undefined' || !('IntersectionObserver' in window)) {
      onVisibilityChange(thumbnailId, true);
      return () => onVisibilityChange(thumbnailId, false);
    }

    const observer = new IntersectionObserver(
      ([observed]) => {
        onVisibilityChange(thumbnailId, observed?.isIntersecting === true);
      },
      {
        root: null,
        rootMargin: THUMBNAIL_ROOT_MARGIN,
        threshold: 0.01,
      },
    );
    observer.observe(node);

    return () => {
      observer.disconnect();
      onVisibilityChange(thumbnailId, false);
    };
  }, [imageEntry, onVisibilityChange, thumbnailId]);

  return (
    <button
      ref={cardRef}
      type="button"
      draggable={draggable}
      onDragStart={onDragStart}
      onDrag={onDrag}
      onDragEnd={onDragEnd}
      onContextMenu={onContextMenu}
      onClick={onOpen}
      title={entry.path}
      className={
        'group min-w-0 overflow-hidden rounded-md border border-border bg-panel-2 text-left transition-colors hover:border-accent hover:bg-panel ' +
        (draggable ? 'cursor-grab active:cursor-grabbing ' : 'cursor-default ') +
        (entry.hidden ? 'opacity-65' : '')
      }
    >
      <div
        className="relative flex h-[76px] items-center justify-center overflow-hidden border-b border-border-soft text-white"
        style={{ background: previewSurface(engine, entry) }}
      >
        {dataUrl ? (
          <img
            src={dataUrl}
            alt=""
            draggable={false}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-black/10 text-white/90">
            <PreviewGlyph entry={entry} engine={engine} />
            <span className="max-w-[86%] truncate text-[10px] font-semibold tracking-normal">
              {engine === 'generic' ? entryPreviewLabel(entry, engine) : ENGINE_BADGES[engine]}
            </span>
          </div>
        )}
        {thumbnail?.status === 'loading' && (
          <Loader2 size={16} className="absolute right-1.5 top-1.5 animate-spin text-white/80" />
        )}
        {vcsStatus && (
          <img
            src={VCS_STATUS_ICON_SRC[vcsStatus]}
            alt=""
            title={workspaceVcsStatusLabel(vcsStatus)}
            draggable={false}
            className="absolute left-1.5 top-1.5 h-5 w-5 drop-shadow-[0_1px_2px_rgba(0,0,0,0.65)]"
          />
        )}
        {!vcsStatus && vcsScanning && (
          <span
            title="正在扫描状态"
            className="absolute left-1.5 top-1.5 inline-flex rounded-full bg-black/45 p-0.5 text-amber-300 drop-shadow-[0_1px_2px_rgba(0,0,0,0.65)]"
          >
            <Loader2 size={18} className="animate-spin" />
          </span>
        )}
        <span className="absolute bottom-1 left-1 rounded bg-black/55 px-1.5 py-0.5 text-[9px] font-medium leading-none text-white/90">
          {label}
        </span>
      </div>
      <span
        className="block h-9 overflow-hidden px-1.5 py-1 text-[11px] leading-4 text-fg-dim group-hover:text-fg"
        style={{
          display: '-webkit-box',
          WebkitBoxOrient: 'vertical',
          WebkitLineClamp: 2,
        }}
      >
        {entry.name}
      </span>
    </button>
  );
}

function ProjectEntryContextMenu({
  x,
  y,
  label,
  onReveal,
}: {
  x: number;
  y: number;
  label: string;
  onReveal: () => void;
}) {
  return (
    <div
      role="menu"
      className="fixed z-[70] min-w-[176px] rounded-md border border-border bg-panel py-1 text-xs text-fg shadow-xl"
      style={{ left: x, top: y }}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <button
        type="button"
        role="menuitem"
        onClick={onReveal}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-border-soft"
      >
        <FolderOpen size={13} className="shrink-0 text-fg-faint" />
        <span className="truncate">{label}</span>
      </button>
    </div>
  );
}

function fileRefFromEntry(entry: WorkspaceTreeEntry): FileRef {
  return {
    path: entry.path,
    basename: entry.name,
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message === 'NO_BACKEND') {
    return '当前浏览器模式不能读取本机文件。请使用桌面端。';
  }
  return err instanceof Error ? err.message : String(err);
}

function VcsStatusOverlay({
  status,
  scanning,
}: {
  status?: WorkspaceVcsTreeStatusKind;
  scanning?: boolean;
}) {
  if (!status && !scanning) return null;
  return (
    <span
      title={status ? workspaceVcsStatusLabel(status) : '正在扫描状态'}
      className="pointer-events-none absolute -bottom-1 -right-1 flex h-[13px] w-[13px] items-center justify-center"
    >
      {status ? (
        <img
          src={VCS_STATUS_ICON_SRC[status]}
          alt=""
          draggable={false}
          className="h-4 w-4 max-w-none drop-shadow-[0_1px_1px_rgba(0,0,0,0.75)]"
        />
      ) : (
        <Loader2
          size={13}
          className="animate-spin rounded-full bg-bg/85 p-[1px] text-amber-300 drop-shadow-[0_1px_1px_rgba(0,0,0,0.75)]"
        />
      )}
    </span>
  );
}

function rootPathForVirtualEntry(rootPath: string, relativePath: string): string {
  const root = rootPath.replace(/[\\/]+$/g, '');
  return root ? `${root}/${relativePath}` : relativePath;
}

function workspaceTreeEntryFromVirtual(
  rootPath: string,
  entry: WorkspaceVcsVirtualTreeEntry,
): WorkspaceTreeEntry {
  return {
    name: entry.name,
    path: rootPathForVirtualEntry(rootPath, entry.relativePath),
    relativePath: entry.relativePath,
    kind: entry.kind,
    hidden: entry.name.startsWith('.'),
    sizeBytes: null,
    modifiedAtMs: null,
  };
}

function compareTreeEntries(a: WorkspaceTreeEntry, b: WorkspaceTreeEntry): number {
  if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
  return a.name
    .toLocaleLowerCase()
    .localeCompare(b.name.toLocaleLowerCase()) || a.name.localeCompare(b.name);
}

function buildRenderEntries(
  entries: WorkspaceTreeEntry[],
  directory: string,
  rootPath: string,
  vcsIndex: WorkspaceVcsTreeStatusIndex,
): ProjectTreeRenderEntry[] {
  const realPaths = new Set(entries.map((entry) => directoryKey(entry.relativePath)));
  // No per-directory spinners: while the background scan runs, directories
  // without a known status simply keep their default icon (no overlay). The
  // overall scan progress is shown as a thin top progress bar instead.
  const renderEntries: ProjectTreeRenderEntry[] = entries.map((entry) => {
    const vcsStatus = workspaceVcsStatusForEntry(entry, vcsIndex);
    return {
      entry,
      virtualDeleted: false,
      vcsStatus,
      vcsScanning: false,
    };
  });

  for (const virtualEntry of vcsIndex.virtualEntriesByDirectory[directory] ?? []) {
    const key = directoryKey(virtualEntry.relativePath);
    if (realPaths.has(key)) continue;
    renderEntries.push({
      entry: workspaceTreeEntryFromVirtual(rootPath, virtualEntry),
      virtualDeleted: true,
      vcsStatus: virtualEntry.status,
    });
  }

  return renderEntries.sort((a, b) => compareTreeEntries(a.entry, b.entry));
}

function treeVcsStatusLine(
  workspaceLabel: string,
  state: WorkspaceVcsTreeState,
): string {
  if (state.status === 'loading') {
    const source = state.snapshot?.source && state.snapshot.source !== 'none'
      ? changeSourceLabel(state.snapshot.source)
      : 'VCS';
    if (state.snapshot?.source && state.snapshot.source !== 'none') {
      return `${workspaceLabel} · ${source} · ${state.snapshot.files.length} 项 · 正在后台扫描...`;
    }
    return `正在刷新 ${source} 状态...`;
  }
  if (state.status === 'error') return `VCS 状态刷新失败：${state.message}`;
  if (state.snapshot?.source && state.snapshot.source !== 'none') {
    const suffix = state.snapshot.truncated ? ' · 部分目录未完成收集' : '';
    return `${workspaceLabel} · ${changeSourceLabel(state.snapshot.source)} · ${state.snapshot.files.length} 项改动${suffix}`;
  }
  return workspaceLabel;
}

export default function ProjectFileTree() {
  const locale = useStore((s) => s.locale);
  const workspaces = useStore((s) => s.workspaces);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const composerWorkspace = useStore((s) => s.composer.workspace);
  const composerWorkspaceFolders = useStore((s) => s.composer.workspaceFolders);
  // 「会话文件」标签的数据来源：当前会话里 AI 工具调用（<<FUC_TOOL>> 内联事件）
  // 读取/修改过的文件。完全不依赖 git/p4/svn 等版本管理指令。
  const sessionMessages = useStore((s) => s.messages);
  // 文件修改状态扫描已停用，会话忙/闲状态不再用于触发自动重扫。
  // const activeSessionId = useStore((s) => s.activeSessionId);
  // const aiEditingSessions = useStore((s) => s.aiEditingSessions);
  // const chattingSessions = useStore((s) => s.chattingSessions);
  // const runningSessions = useStore((s) => s.runningSessions);
  const [cache, setCache] = useState<WorkspaceTreeCache>({});
  const cacheRef = useRef(cache);
  const [previewRef, setPreviewRef] = useState<FileRef | null>(null);
  // 「工作区改动」tab 已停用（会触发 P4 reconcile 洪水）。改为「会话文件」tab：
  // 只展示当前会话里 AI 读取/修改过的文件，纯前端解析消息流，不碰版本管理。
  const [panelTab, setPanelTab] = useState<ProjectPanelTab>(() => {
    if (typeof window === 'undefined') return 'files';
    return window.localStorage.getItem('freeultracode.projectRightPanelTab.v1') ===
      'session'
      ? 'session'
      : 'files';
  });
  const [viewMode, setViewMode] = useState<ProjectTreeViewMode>(() => {
    if (typeof window === 'undefined') return 'tree';
    return window.localStorage.getItem('freeultracode.projectFileTreeView.v1') ===
      'preview'
      ? 'preview'
      : 'tree';
  });
  // 文件修改状态扫描已停用。保留一个恒定的 idle 快照，使文件树渲染逻辑
  // （vcsTreeStatusIndex / treeVcsStatusLine）继续工作但永远不显示状态图标，
  // 也不会触发任何后台 P4/VCS 扫描请求。
  const vcsTreeState: WorkspaceVcsTreeState = { status: 'idle', snapshot: null };
  // const [vcsTreeState, setVcsTreeState] = useState<WorkspaceVcsTreeState>({
  //   status: 'idle',
  //   snapshot: null,
  // });
  // const [vcsScanProgress, setVcsScanProgress] =
  //   useState<WorkspaceVcsScanProgress | null>(null);
  // const [vcsScanEnabled, setVcsScanEnabled] = useState<boolean>(
  //   readVcsScanEnabledPreference,
  // );
  const [previewDirectories, setPreviewDirectories] = useState<Record<string, string>>({});
  const [thumbnailCache, setThumbnailCache] = useState<ThumbnailCache>({});
  const [visibleThumbnails, setVisibleThumbnails] = useState<ThumbnailVisibility>({});
  const [contextMenu, setContextMenu] = useState<ProjectEntryContextMenuState>(null);
  const visibleThumbnailsRef = useRef<ThumbnailVisibility>({});
  // 文件修改状态扫描已停用，相关序列号 / in-flight 标记不再需要。
  // const vcsTreeLoadSeqRef = useRef(0);
  // const vcsTreeRefreshInFlightRef = useRef(false);
  // const activeSessionBusyRef = useRef(false);

  useEffect(() => {
    cacheRef.current = cache;
  }, [cache]);

  useEffect(() => {
    visibleThumbnailsRef.current = visibleThumbnails;
  }, [visibleThumbnails]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [contextMenu]);

  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === activeWorkspaceId),
    [activeWorkspaceId, workspaces],
  );
  const activeWorkspacePath = activeWorkspace?.path?.trim() ?? '';


  // The right-hand panel browses every folder attached to the active session:
  // the composer's primary workspace plus its extra folders (configured in
  // Project Settings → 概览 and inherited by new sessions). The folder bar lets
  // the user pick which root to browse; the tree below shows that root.
  const rootFolders = useMemo(() => {
    const folders = uniqueWorkspaceHistory([
      composerWorkspace,
      ...composerWorkspaceFolders,
      activeWorkspacePath,
    ]);
    return folders;
  }, [composerWorkspace, composerWorkspaceFolders, activeWorkspacePath]);

  // 会话文件过滤：读取每个根目录下的 .gitignore/.p4ignore/.svnignore（纯文本读取，
  // 不调用任何 git/p4/svn 指令），编译成忽略匹配器，用于隐藏不在版本管理中的文件。
  const [ignoreRoots, setIgnoreRoots] = useState<SessionIgnoreRoot[]>([]);
  const rootFoldersKey = useMemo(
    () => rootFolders.map((path) => workspacePathKey(path)).join('|'),
    [rootFolders],
  );
  useEffect(() => {
    let cancelled = false;
    const roots = rootFolders.filter((path) => path.trim());
    if (roots.length === 0) {
      setIgnoreRoots([]);
      return;
    }
    void (async () => {
      const loaded = await Promise.all(
        roots.map(async (root): Promise<SessionIgnoreRoot> => {
          const contents = await Promise.all(
            IGNORE_FILE_NAMES.map(async (name) => {
              try {
                const preview = await previewLocalFile(name, { cwd: root });
                return preview.kind === 'text' && preview.text ? preview.text : '';
              } catch {
                // Missing ignore file (or no desktop backend) → no rules from it.
                return '';
              }
            }),
          );
          return sessionIgnoreRootFromContents(root, contents);
        }),
      );
      if (!cancelled) setIgnoreRoots(loaded);
    })();
    return () => {
      cancelled = true;
    };
    // rootFoldersKey captures the identity of the root set; reload on change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootFoldersKey]);

  // 当前会话相关文件：从消息流里的 AI 工具调用事件解析得到，纯前端、零 VCS 请求。
  // 再用上面读取到的 ignore 规则过滤掉不受版本管理的文件。
  const sessionFiles = useMemo(() => {
    const isIgnored = buildSessionIgnorePredicate(ignoreRoots);
    return extractSessionFiles(sessionMessages, { isIgnored });
  }, [sessionMessages, ignoreRoots]);
  const [selectedRootKey, setSelectedRootKey] = useState<string>('');
  const selectedRootPath = useMemo(() => {
    if (rootFolders.length === 0) return '';
    const match = rootFolders.find(
      (path) => workspacePathKey(path) === selectedRootKey,
    );
    return match ?? rootFolders[0];
  }, [rootFolders, selectedRootKey]);
  const activeRootKey = selectedRootPath ? workspacePathKey(selectedRootPath) : '';

  useEffect(() => {
    if (!selectedRootPath) return;
    const key = workspacePathKey(selectedRootPath);
    if (key !== selectedRootKey) setSelectedRootKey(key);
  }, [selectedRootPath, selectedRootKey]);

  // 文件修改状态扫描已停用，不再计算会话忙/闲状态。
  // const activeSessionBusy = useMemo(() => {
  //   if (!activeSessionId) return false;
  //   const matchesActive = (key: { workspaceId: string | null; sessionId: string | null }) =>
  //     key.sessionId === activeSessionId &&
  //     (key.workspaceId ?? null) === (activeWorkspaceId ?? null);
  //   return (
  //     aiEditingSessions.some(matchesActive) ||
  //     chattingSessions.some(matchesActive) ||
  //     runningSessions.some(matchesActive)
  //   );
  // }, [
  //   activeSessionId,
  //   activeWorkspaceId,
  //   aiEditingSessions,
  //   chattingSessions,
  //   runningSessions,
  // ]);
  // 文件修改状态扫描已停用，无需后台 VCS 状态缓存键。
  // const vcsStatusCacheKey = useMemo(
  //   () => changesCacheKey ?? `vcs:${activeWorkspace?.id ?? 'default'}`,
  //   [changesCacheKey, activeWorkspace?.id],
  // );
  const activeTree = activeRootKey ? cache[activeRootKey] : undefined;
  const rootState = activeTree?.directories[''];
  const projectEngine = useMemo(
    () => detectProjectEngine(rootState?.entries),
    [rootState?.entries],
  );
  const previewDirectory = activeRootKey
    ? previewDirectories[activeRootKey] ?? ''
    : '';
  const previewDirectoryKey = directoryKey(previewDirectory);
  const previewDirectoryState = activeTree?.directories[previewDirectoryKey];
  const previewDirectoryEntries = previewDirectoryState?.entries ?? [];
  const vcsTreeStatusIndex = useMemo(
    () => buildWorkspaceVcsTreeStatus(vcsTreeState.snapshot),
    [vcsTreeState.snapshot],
  );

  const { width, onResizeStart } = useResizableWidth({
    storageKey: 'freeultracode.projectFileTreeWidth.v1',
    defaultWidth: 280,
    min: 220,
    max: 520,
    edge: 'left',
  });

  const loadDirectory = useCallback(
    async (
      workspaceId: string,
      rootPath: string,
      relativePath: string,
      options: { force?: boolean } = {},
    ) => {
      const key = directoryKey(relativePath);
      const current = cacheRef.current[workspaceId];
      const sameRoot = current?.rootPath === rootPath;
      const existing = sameRoot ? current?.directories[key] : undefined;
      if (!options.force && existing) return;

      setCache((prev) => {
        const previous = prev[workspaceId];
        const keepWorkspace = previous?.rootPath === rootPath && !options.force;
        const nextTree: WorkspaceTreeState = {
          rootPath,
          directories: keepWorkspace ? { ...previous.directories } : {},
          expanded: keepWorkspace ? { ...previous.expanded } : {},
        };
        nextTree.directories[key] = {
          status: 'loading',
          entries: keepWorkspace
            ? previous.directories[key]?.entries ?? []
            : [],
        };
        const next = {
          ...prev,
          [workspaceId]: nextTree,
        };
        cacheRef.current = next;
        return next;
      });

      try {
        const listing = await listWorkspaceDirectory(rootPath, key);
        setCache((prev) => {
          const previous = prev[workspaceId];
          if (!previous || previous.rootPath !== rootPath) return prev;
          const nextTree: WorkspaceTreeState = {
            ...previous,
            rootPath: listing.rootPath,
            directories: {
              ...previous.directories,
              [key]: {
                status: 'ready',
                entries: listing.entries,
                truncated: listing.truncated,
                totalEntries: listing.totalEntries,
              },
            },
          };
          const next = {
            ...prev,
            [workspaceId]: nextTree,
          };
          cacheRef.current = next;
          return next;
        });
      } catch (err) {
        setCache((prev) => {
          const previous = prev[workspaceId];
          if (!previous || previous.rootPath !== rootPath) return prev;
          const nextTree: WorkspaceTreeState = {
            ...previous,
            directories: {
              ...previous.directories,
              [key]: {
                status: 'error',
                entries: previous.directories[key]?.entries ?? [],
                message: errorMessage(err),
              },
            },
          };
          const next = {
            ...prev,
            [workspaceId]: nextTree,
          };
          cacheRef.current = next;
          return next;
        });
      }
    },
    [],
  );

  const updateViewMode = useCallback((nextMode: ProjectTreeViewMode) => {
    setViewMode(nextMode);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('freeultracode.projectFileTreeView.v1', nextMode);
    }
  }, []);

  // 文件修改状态扫描已停用，开关切换逻辑不再需要。
  // const toggleVcsScanEnabled = useCallback(() => {
  //   setVcsScanEnabled((prev) => {
  //     const next = !prev;
  //     if (typeof window !== 'undefined') {
  //       window.localStorage.setItem(
  //         VCS_STATUS_SCAN_ENABLED_STORAGE_KEY,
  //         next ? 'on' : 'off',
  //       );
  //     }
  //     return next;
  //   });
  // }, []);

  const updatePanelTab = useCallback((nextTab: ProjectPanelTab) => {
    setPanelTab(nextTab);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('freeultracode.projectRightPanelTab.v1', nextTab);
    }
  }, []);

  const openSessionFile = useCallback((entry: SessionFileEntry) => {
    setPreviewRef({ path: entry.path, basename: entry.basename });
  }, []);

  // ===========================================================================
  // 文件修改状态扫描（VCS status scan）—— 已整体停用
  //
  // 该功能会对版本控制服务器发起大量请求：在 Perforce 大型 depot（如 UE 引擎库）
  // 下，它会按目录递归执行 `p4 reconcile -n -ead <dir>/...`，单次扫描可产生数百条
  // reconcile 请求，足以拖垮 P4 服务器。为彻底消除该风险，整段后台扫描逻辑连同其
  // 触发点一并注释关闭。`refreshVcsTreeStatus` 保留为 no-op，使现有调用点无需改动。
  // 如需恢复，请同时取消注释顶部的 tauri 导入、相关 state/ref 与下方各 effect。
  // ===========================================================================
  const refreshVcsTreeStatus = useCallback(() => {
    /* no-op: 文件修改状态扫描已停用 */
  }, []);

  // const refreshVcsTreeStatus = useCallback(() => {
  //   if (!vcsScanEnabled) return;
  //   if (!activeWorkspacePath || vcsTreeRefreshInFlightRef.current) return;
  //   vcsTreeRefreshInFlightRef.current = true;
  //   const seq = vcsTreeLoadSeqRef.current + 1;
  //   vcsTreeLoadSeqRef.current = seq;
  //
  //   void (async () => {
  //     // 1) Render the last cached snapshot instantly so switching back to a
  //     //    workspace shows icons immediately without re-scanning from zero.
  //     try {
  //       const cached = await readWorkspaceVcsStatusCache(
  //         activeWorkspacePath,
  //         vcsStatusCacheKey,
  //       );
  //       if (vcsTreeLoadSeqRef.current !== seq) return;
  //       if (cached) {
  //         setVcsTreeState({ status: 'ready', snapshot: cached });
  //       } else {
  //         setVcsTreeState((prev) => ({ status: 'loading', snapshot: prev.snapshot }));
  //       }
  //     } catch {
  //       setVcsTreeState((prev) => ({ status: 'loading', snapshot: prev.snapshot }));
  //     }
  //
  //     // 2) Quick shallow root-level pass so top-level icons update fast.
  //     try {
  //       const shallowSnapshot = await listWorkspaceVcsStatusShallow(activeWorkspacePath);
  //       if (vcsTreeLoadSeqRef.current !== seq) return;
  //       setVcsTreeState((prev) => {
  //         // Don't downgrade a richer cached/full snapshot to the shallow one.
  //         if (prev.status === 'ready' && prev.snapshot.scanScope === 'full') {
  //           return prev;
  //         }
  //         return { status: 'loading', snapshot: shallowSnapshot };
  //       });
  //     } catch {
  //       // Background scan below will surface the real error via progress events.
  //     }
  //
  //     // 3) Kick off the background full scan. It runs in a backend worker,
  //     //    caches its result, and reports progress via events. We don't await
  //     //    the full scan here, so the UI stays responsive on large projects.
  //     try {
  //       await startWorkspaceVcsStatusScan(activeWorkspacePath, vcsStatusCacheKey);
  //     } catch (err) {
  //       if (vcsTreeLoadSeqRef.current !== seq) return;
  //       setVcsTreeState((prev) => ({
  //         status: 'error',
  //         snapshot: prev.snapshot,
  //         message: errorMessage(err),
  //       }));
  //     } finally {
  //       if (vcsTreeLoadSeqRef.current === seq) {
  //         vcsTreeRefreshInFlightRef.current = false;
  //       }
  //     }
  //   })();
  // }, [activeWorkspacePath, vcsStatusCacheKey, vcsScanEnabled]);

  // Drive UI from background scan progress events: update the thin progress bar
  // while scanning, and re-read the cached result when a scan completes.
  // 已停用：不再监听后台扫描进度事件。
  // useEffect(() => {
  //   if (!activeWorkspacePath) return;
  //   let unlisten: (() => void) | undefined;
  //   let disposed = false;
  //   void onWorkspaceVcsScanProgress((progress) => {
  //     if (progress.phase === 'scanning') {
  //       setVcsScanProgress(progress);
  //       return;
  //     }
  //     if (progress.phase === 'error') {
  //       setVcsScanProgress(null);
  //       setVcsTreeState((prev) => ({
  //         status: 'error',
  //         snapshot: prev.snapshot,
  //         message: progress.message ?? 'VCS 状态扫描失败',
  //       }));
  //       return;
  //     }
  //     // phase === 'done': pull the freshly cached snapshot.
  //     setVcsScanProgress(null);
  //     const seq = vcsTreeLoadSeqRef.current;
  //     void readWorkspaceVcsStatusCache(activeWorkspacePath, vcsStatusCacheKey)
  //       .then((snapshot) => {
  //         if (vcsTreeLoadSeqRef.current !== seq || !snapshot) return;
  //         setVcsTreeState({ status: 'ready', snapshot });
  //       })
  //       .catch(() => {});
  //   }).then((fn) => {
  //     if (disposed) {
  //       fn();
  //     } else {
  //       unlisten = fn;
  //     }
  //   });
  //   return () => {
  //     disposed = true;
  //     unlisten?.();
  //   };
  // }, [activeWorkspacePath, vcsStatusCacheKey]);

  // 已停用：不再在挂载 / 切换工作区时启动扫描，也不再每 30 秒轮询扫描。
  // useEffect(() => {
  //   vcsTreeLoadSeqRef.current = vcsTreeLoadSeqRef.current + 1;
  //   vcsTreeRefreshInFlightRef.current = false;
  //   setVcsScanProgress(null);
  //   setVcsTreeState({ status: 'idle', snapshot: null });
  //   if (!activeWorkspacePath || !vcsScanEnabled) return;
  //
  //   refreshVcsTreeStatus();
  //   if (typeof window === 'undefined') return;
  //
  //   const interval = window.setInterval(
  //     refreshVcsTreeStatus,
  //     VCS_TREE_REFRESH_INTERVAL_MS,
  //   );
  //   return () => window.clearInterval(interval);
  // }, [activeWorkspacePath, refreshVcsTreeStatus, vcsScanEnabled]);

  useEffect(() => {
    if (!activeRootKey || !selectedRootPath) return;
    const tree = cacheRef.current[activeRootKey];
    if (tree?.rootPath === selectedRootPath && tree.directories['']) return;
    void loadDirectory(activeRootKey, selectedRootPath, '');
  }, [activeRootKey, selectedRootPath, loadDirectory]);

  useEffect(() => {
    setVisibleThumbnails({});
  }, [activeRootKey, previewDirectoryKey, viewMode]);

  useEffect(() => {
    if (viewMode !== 'preview' || !selectedRootPath) return;
    const imageEntries = previewDirectoryEntries.filter(
      (entry) => isImageEntry(entry) && visibleThumbnails[thumbnailKey(entry)],
    );
    const missing = imageEntries
      .filter((entry) => !thumbnailCache[thumbnailKey(entry)])
      .slice(0, THUMBNAIL_LOAD_BATCH_SIZE);
    if (missing.length === 0) return;

    setThumbnailCache((prev) => {
      const next = { ...prev };
      const now = Date.now();
      for (const entry of missing) {
        const key = thumbnailKey(entry);
        if (!next[key]) {
          next[key] = { status: 'loading', lastAccessed: now };
        }
      }
      return pruneThumbnailCache(next, visibleThumbnailsRef.current);
    });

    for (const entry of missing) {
      const key = thumbnailKey(entry);
      void previewLocalFile(entry.path, { cwd: selectedRootPath })
        .then((result) => {
          if (result.kind !== 'image' || !result.base64 || !result.mime) {
            throw new Error('not image');
          }
          setThumbnailCache((prev) => ({
            ...pruneThumbnailCache(
              {
                ...prev,
                [key]: {
                  status: 'ready',
                  dataUrl: `data:${result.mime};base64,${result.base64}`,
                  lastAccessed: Date.now(),
                },
              },
              visibleThumbnailsRef.current,
            ),
          }));
        })
        .catch(() => {
          setThumbnailCache((prev) => ({
            ...prev,
            [key]: { status: 'error', lastAccessed: Date.now() },
          }));
        });
    }
  }, [
    selectedRootPath,
    previewDirectoryEntries,
    thumbnailCache,
    visibleThumbnails,
    viewMode,
  ]);

  useEffect(() => {
    setThumbnailCache((prev) =>
      pruneThumbnailCache(prev, visibleThumbnailsRef.current),
    );
  }, [visibleThumbnails]);

  const updateThumbnailVisibility = useCallback(
    (key: string, visible: boolean) => {
      setVisibleThumbnails((prev) => {
        if (visible) {
          if (prev[key]) return prev;
          return { ...prev, [key]: true };
        }
        if (!prev[key]) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });

      if (visible) {
        setThumbnailCache((prev) => {
          const thumbnail = prev[key];
          if (!thumbnail) return prev;
          return {
            ...prev,
            [key]: {
              ...thumbnail,
              lastAccessed: Date.now(),
            },
          };
        });
      }
    },
    [],
  );

  const startEntryDrag = useCallback(
    (event: ReactDragEvent<HTMLElement>, entry: WorkspaceTreeEntry) => {
      setProjectFileDragData(event.dataTransfer, entry);
      updateProjectFileDragPoint(event);
      applyProjectFileDragDropEffect(event.dataTransfer);
    },
    [],
  );

  const trackEntryDrag = useCallback((event: ReactDragEvent<HTMLElement>) => {
    updateProjectFileDragPoint(event);
    applyProjectFileDragDropEffect(event.dataTransfer);
  }, []);

  const finishEntryDrag = useCallback((event: ReactDragEvent<HTMLElement>) => {
    finishProjectFileDrag(event);
  }, []);

  const openEntryContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>, entry: WorkspaceTreeEntry) => {
      event.preventDefault();
      event.stopPropagation();
      setContextMenu({
        ...contextMenuPosition(event),
        entry,
      });
    },
    [],
  );

  const revealContextMenuEntry = useCallback(() => {
    if (!contextMenu) return;
    const targetPath = contextMenu.entry.path;
    setContextMenu(null);
    void openLocalPath(targetPath, {
      cwd: selectedRootPath || undefined,
      reveal: true,
    }).then((opened) => {
      if (!opened && typeof window !== 'undefined') {
        window.alert('当前环境不能打开系统文件浏览器。请使用桌面端。');
      }
    });
  }, [selectedRootPath, contextMenu]);

  const toggleDirectory = useCallback(
    (entry: WorkspaceTreeEntry, options: { skipLoad?: boolean } = {}) => {
      if (!activeRootKey || !selectedRootPath) return;
      const key = directoryKey(entry.relativePath);
      const tree = cacheRef.current[activeRootKey];
      const nextExpanded = !(tree?.expanded[key] === true);

      setCache((prev) => {
        const previous = prev[activeRootKey];
        if (!previous) return prev;
        const next = {
          ...prev,
          [activeRootKey]: {
            ...previous,
            expanded: {
              ...previous.expanded,
              [key]: nextExpanded,
            },
          },
        };
        cacheRef.current = next;
        return next;
      });

      if (nextExpanded && !tree?.directories[key] && !options.skipLoad) {
        void loadDirectory(activeRootKey, selectedRootPath, key);
      }
    },
    [activeRootKey, selectedRootPath, loadDirectory],
  );

  const refreshActiveWorkspace = useCallback(() => {
    if (!activeRootKey || !selectedRootPath) return;
    setPreviewDirectories((prev) => ({
      ...prev,
      [activeRootKey]: '',
    }));
    refreshVcsTreeStatus();
    void loadDirectory(activeRootKey, selectedRootPath, '', {
      force: true,
    });
  }, [activeRootKey, selectedRootPath, loadDirectory, refreshVcsTreeStatus]);

  // 工作区改动扫描已停用：原实现会调用 refreshCachedSessionChanges →
  // listWorkspaceChanges → 后端 p4_workspace_changes，对 P4 发起大量 reconcile
  // 请求。改动 tab 入口已移除（改为「会话文件」tab）。

  // const refreshSessionChanges = useCallback(() => {
  //   if (!workspaceChangesRootPath || !changesCacheKey) return;
  //   const seq = changesLoadSeqRef.current + 1;
  //   changesLoadSeqRef.current = seq;
  //   setSelectedChangeKey(null);
  //   setChangesState((prev) => ({
  //     status: 'loading',
  //     snapshot: prev.snapshot,
  //   }));
  //   void refreshCachedSessionChanges(
  //     workspaceChangesRootPath,
  //     changesCacheKey,
  //     null,
  //   )
  //     .then((snapshot) => {
  //       if (changesLoadSeqRef.current !== seq) return;
  //       setChangesState({ status: 'ready', snapshot });
  //     })
  //     .catch((err) => {
  //       if (changesLoadSeqRef.current !== seq) return;
  //       setChangesState((prev) => ({
  //         status: 'error',
  //         snapshot: prev.snapshot,
  //         message: errorMessage(err),
  //       }));
  //     });
  // }, [workspaceChangesRootPath, changesCacheKey]);

  // 已停用：不再在切换到“工作区改动”标签时自动发起改动扫描。
  // 该扫描在 P4 工作区下同样会触发大量 reconcile 请求；如需查看改动，
  // 请改用面板底部的“刷新改动”按钮手动触发。
  // useEffect(() => {
  //   if (panelTab !== 'changes') return;
  //   if (!vcsScanEnabled) return;
  //   if (!workspaceChangesRootPath || !changesCacheKey) return;
  //   if (changesState.status !== 'idle') return;
  //   refreshSessionChanges();
  // }, [
  //   vcsScanEnabled,
  //   workspaceChangesRootPath,
  //   changesCacheKey,
  //   changesState.status,
  //   panelTab,
  //   refreshSessionChanges,
  // ]);

  // 已停用：会话从忙变闲时不再自动重扫工作区改动 / 文件状态。
  // useEffect(() => {
  //   const wasBusy = activeSessionBusyRef.current;
  //   activeSessionBusyRef.current = activeSessionBusy;
  //   if (!wasBusy || activeSessionBusy) return;
  //   if (!vcsScanEnabled) return;
  //   if (!workspaceChangesRootPath || !changesCacheKey) return;
  //   refreshSessionChanges();
  //   refreshVcsTreeStatus();
  // }, [
  //   activeSessionBusy,
  //   vcsScanEnabled,
  //   workspaceChangesRootPath,
  //   changesCacheKey,
  //   refreshSessionChanges,
  //   refreshVcsTreeStatus,
  // ]);

  const openPreviewDirectory = useCallback(
    (relativePath: string, options: { skipLoad?: boolean } = {}) => {
      if (!activeRootKey || !selectedRootPath) return;
      const key = directoryKey(relativePath);
      setPreviewDirectories((prev) => ({
        ...prev,
        [activeRootKey]: key,
      }));
      if (!options.skipLoad && !cacheRef.current[activeRootKey]?.directories[key]) {
        void loadDirectory(activeRootKey, selectedRootPath, key);
      }
    },
    [activeRootKey, selectedRootPath, loadDirectory],
  );

  const renderDirectory = useCallback(
    (relativePath: string, level: number): ReactNode => {
      if (!activeTree) return null;
      const key = directoryKey(relativePath);
      const directory = activeTree.directories[key];
      const renderEntries = buildRenderEntries(
        directory?.entries ?? [],
        key,
        selectedRootPath,
        vcsTreeStatusIndex,
      );

      if (!directory && renderEntries.length === 0) return null;
      if (
        directory?.status === 'loading' &&
        directory.entries.length === 0 &&
        renderEntries.length === 0
      ) {
        return (
          <div
            className="flex h-7 items-center gap-2 px-2 text-xs text-fg-faint"
            style={{ paddingLeft: 10 + level * 14 }}
          >
            <Loader2 size={13} className="animate-spin text-accent" />
            <span>{t(locale, 'projectTree.loading')}</span>
          </div>
        );
      }
      if (
        directory?.status === 'error' &&
        directory.entries.length === 0 &&
        renderEntries.length === 0
      ) {
        return (
          <div
            className="flex items-start gap-2 px-2 py-1.5 text-xs leading-snug text-status-error"
            style={{ paddingLeft: 10 + level * 14 }}
          >
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span className="break-words">{directory.message}</span>
          </div>
        );
      }

      return (
        <>
          {renderEntries.map(({ entry, virtualDeleted, vcsStatus, vcsScanning }) => {
            const entryKey = directoryKey(entry.relativePath);
            const expanded = activeTree.expanded[entryKey] === true;
            const isDirectory = entry.kind === 'directory';
            const isDeleted = vcsStatus === 'deleted';
            const iconStatusClass = isDirectory ? 'text-accent-2' : 'text-fg-faint';

            return (
              <div key={`${virtualDeleted ? 'deleted:' : ''}${entry.path}`}>
                <button
                  type="button"
                  draggable={!virtualDeleted}
                  onDragStart={(event) => {
                    if (virtualDeleted) {
                      event.preventDefault();
                      return;
                    }
                    startEntryDrag(event, entry);
                  }}
                  onDrag={trackEntryDrag}
                  onDragEnd={finishEntryDrag}
                  onContextMenu={(event) => {
                    if (virtualDeleted) {
                      event.preventDefault();
                      return;
                    }
                    openEntryContextMenu(event, entry);
                  }}
                  onClick={() => {
                    if (isDirectory) {
                      toggleDirectory(entry, { skipLoad: virtualDeleted });
                    } else if (!virtualDeleted && !isDeleted) {
                      setPreviewRef(fileRefFromEntry(entry));
                    }
                  }}
                  title={
                    vcsStatus
                      ? `${entry.path}\n${workspaceVcsStatusLabel(vcsStatus)}`
                      : vcsScanning
                        ? `${entry.path}\n正在扫描状态`
                      : entry.path
                  }
                  className={
                    'group flex h-7 w-full min-w-0 items-center gap-1.5 px-2 text-left text-xs transition-colors hover:bg-panel-2 hover:text-fg ' +
                    (virtualDeleted
                      ? 'cursor-default '
                      : 'cursor-grab active:cursor-grabbing ') +
                    (entry.hidden ? 'text-fg-faint ' : 'text-fg-dim ') +
                    (isDeleted ? 'opacity-80' : '')
                  }
                  style={{ paddingLeft: 8 + level * 14 }}
                >
                  {isDirectory ? (
                    <ChevronRight
                      size={13}
                      className={
                        'shrink-0 text-fg-faint transition-transform ' +
                        (expanded ? 'rotate-90' : '')
                      }
                    />
                  ) : (
                    <span className="w-[13px] shrink-0" />
                  )}
                  <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
                    {isDirectory ? (
                      expanded ? (
                        <FolderOpen size={14} className={'shrink-0 ' + iconStatusClass} />
                      ) : (
                        <Folder size={14} className={'shrink-0 ' + iconStatusClass} />
                      )
                    ) : (
                      <File size={14} className={'shrink-0 ' + iconStatusClass} />
                    )}
                    <VcsStatusOverlay status={vcsStatus} scanning={vcsScanning} />
                  </span>
                  <span className={'min-w-0 flex-1 truncate ' + (isDeleted ? 'line-through' : '')}>
                    {entry.name}
                  </span>
                </button>
                {isDirectory && expanded && renderDirectory(entry.relativePath, level + 1)}
              </div>
            );
          })}
          {directory?.status === 'ready' && directory.truncated && (
            <div
              className="px-2 py-1 text-[11px] text-fg-faint"
              style={{ paddingLeft: 10 + level * 14 }}
            >
              {t(locale, 'projectTree.truncated').replace(
                '{count}',
                String(directory.totalEntries),
              )}
            </div>
          )}
          {directory?.status === 'error' && directory.entries.length > 0 && (
            <div
              className="px-2 py-1 text-[11px] text-status-error"
              style={{ paddingLeft: 10 + level * 14 }}
            >
              {directory.message}
            </div>
          )}
        </>
      );
    },
    [
      activeTree,
      selectedRootPath,
      finishEntryDrag,
      locale,
      openEntryContextMenu,
      startEntryDrag,
      toggleDirectory,
      trackEntryDrag,
      vcsTreeStatusIndex,
    ],
  );

  const renderPreviewMode = useCallback((): ReactNode => {
    const directory = previewDirectoryState;
    const renderEntries = buildRenderEntries(
      directory?.entries ?? [],
      previewDirectoryKey,
      selectedRootPath,
      vcsTreeStatusIndex,
    );
    const segments = previewDirectoryKey
      ? previewDirectoryKey.split('/').filter(Boolean)
      : [];
    let breadcrumbPath = '';
    const breadcrumbs = segments.map((segment) => {
      breadcrumbPath = directoryKey(
        breadcrumbPath ? `${breadcrumbPath}/${segment}` : segment,
      );
      return { label: segment, path: breadcrumbPath };
    });

    return (
      <div className="space-y-2 px-2 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1 text-[11px] text-fg-faint">
          <button
            type="button"
            onClick={() => openPreviewDirectory('')}
            className="max-w-[7rem] truncate rounded px-1.5 py-0.5 hover:bg-panel-2 hover:text-fg"
            title={selectedRootPath}
          >
            {t(locale, 'projectTree.previewRoot')}
          </button>
          {breadcrumbs.map((crumb) => (
            <span key={crumb.path} className="flex min-w-0 items-center gap-1">
              <span>/</span>
              <button
                type="button"
                onClick={() => openPreviewDirectory(crumb.path)}
                className="max-w-[7rem] truncate rounded px-1.5 py-0.5 hover:bg-panel-2 hover:text-fg"
                title={crumb.path}
              >
                {crumb.label}
              </button>
            </span>
          ))}
          <span className="ml-auto shrink-0 rounded border border-border-soft px-1.5 py-0.5 text-[10px] text-fg-faint">
            {ENGINE_LABELS[projectEngine]}
          </span>
        </div>

        {(!directory && renderEntries.length === 0) ||
        (directory?.status === 'loading' &&
          directory.entries.length === 0 &&
          renderEntries.length === 0) ? (
          <div className="flex h-16 items-center justify-center gap-2 text-xs text-fg-faint">
            <Loader2 size={14} className="animate-spin text-accent" />
            <span>{t(locale, 'projectTree.loading')}</span>
          </div>
        ) : directory?.status === 'error' &&
          directory.entries.length === 0 &&
          renderEntries.length === 0 ? (
          <div className="flex items-start gap-2 rounded-md border border-status-error/40 bg-status-error/10 p-2 text-xs leading-snug text-status-error">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span className="break-words">{directory.message}</span>
          </div>
        ) : renderEntries.length === 0 ? (
          <div className="px-2 py-8 text-center text-xs text-fg-faint">
            {t(locale, 'projectTree.previewEmpty')}
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(92px,1fr))] gap-2">
            {renderEntries.map(({ entry, virtualDeleted, vcsStatus, vcsScanning }) => {
              const key = thumbnailKey(entry);
              return (
                <PreviewCard
                  key={`${virtualDeleted ? 'deleted:' : ''}${entry.path}`}
                  entry={entry}
                  engine={projectEngine}
                  vcsStatus={vcsStatus}
                  vcsScanning={vcsScanning}
                  thumbnailId={key}
                  draggable={!virtualDeleted}
                  thumbnail={
                    !virtualDeleted && isImageEntry(entry) ? thumbnailCache[key] : undefined
                  }
                  onVisibilityChange={updateThumbnailVisibility}
                  onDragStart={(event) => {
                    if (virtualDeleted) {
                      event.preventDefault();
                      return;
                    }
                    startEntryDrag(event, entry);
                  }}
                  onDrag={trackEntryDrag}
                  onDragEnd={finishEntryDrag}
                  onContextMenu={(event) => {
                    if (virtualDeleted) {
                      event.preventDefault();
                      return;
                    }
                    openEntryContextMenu(event, entry);
                  }}
                  onOpen={() => {
                    if (entry.kind === 'directory') {
                      openPreviewDirectory(entry.relativePath, {
                        skipLoad: virtualDeleted,
                      });
                    } else if (!virtualDeleted && vcsStatus !== 'deleted') {
                      setPreviewRef(fileRefFromEntry(entry));
                    }
                  }}
                />
              );
            })}
          </div>
        )}

        {directory?.status === 'ready' && directory.truncated && (
          <div className="px-1 text-[11px] text-fg-faint">
            {t(locale, 'projectTree.truncated').replace(
              '{count}',
              String(directory.totalEntries),
            )}
          </div>
        )}
        {directory?.status === 'error' && directory.entries.length > 0 && (
          <div className="px-1 text-[11px] text-status-error">{directory.message}</div>
        )}
      </div>
    );
  }, [
    selectedRootPath,
    locale,
    openEntryContextMenu,
    openPreviewDirectory,
    previewDirectoryKey,
    previewDirectoryState,
    projectEngine,
    finishEntryDrag,
    startEntryDrag,
    thumbnailCache,
    trackEntryDrag,
    updateThumbnailVisibility,
    vcsTreeStatusIndex,
  ]);

  const renderSessionFiles = useCallback((): ReactNode => {
    if (sessionFiles.length === 0) {
      return (
        <div className="space-y-2 px-3 py-6 text-center">
          <History size={20} className="mx-auto text-fg-faint" />
          <p className="text-xs leading-relaxed text-fg-faint">
            {t(locale, 'sessionFiles.empty')}
          </p>
        </div>
      );
    }

    return (
      <div className="space-y-1.5 px-2 py-2">
        <p className="px-1 text-[10px] leading-relaxed text-fg-faint">
          {t(locale, 'sessionFiles.hint')}
        </p>
        {sessionFiles.map((entry) => {
          const dragEntry: WorkspaceTreeEntry = {
            name: entry.basename,
            path: entry.path,
            relativePath: entry.path,
            kind: 'file',
            hidden: false,
            sizeBytes: null,
            modifiedAtMs: null,
          };
          const edited = entry.action === 'edited';
          return (
            <button
              key={entry.path}
              type="button"
              draggable
              onDragStart={(event) => startEntryDrag(event, dragEntry)}
              onDrag={trackEntryDrag}
              onDragEnd={finishEntryDrag}
              onClick={() => openSessionFile(entry)}
              title={entry.path}
              className="group flex w-full min-w-0 cursor-grab items-center gap-2 rounded-md border border-border-soft bg-panel-2/60 px-2 py-2 text-left transition-colors hover:border-accent/45 hover:bg-panel-2 active:cursor-grabbing"
            >
              <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
                {edited ? (
                  <FilePen size={14} className="text-accent" />
                ) : (
                  <FileText size={14} className="text-fg-faint" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-[11px] text-fg" title={entry.path}>
                  {entry.basename}
                </span>
                <span className="mt-0.5 block truncate text-[10px] text-fg-faint">
                  {entry.path}
                </span>
              </span>
              <span
                className={
                  'shrink-0 rounded border px-1.5 py-0.5 text-[10px] leading-none ' +
                  (edited
                    ? 'border-accent/45 text-accent'
                    : 'border-border-soft text-fg-faint')
                }
              >
                {edited
                  ? t(locale, 'sessionFiles.actionEdited')
                  : t(locale, 'sessionFiles.actionRead')}
              </span>
              {entry.touchCount > 1 && (
                <span className="shrink-0 font-mono text-[10px] text-fg-faint">
                  {t(locale, 'sessionFiles.touchCount').replace(
                    '{count}',
                    String(entry.touchCount),
                  )}
                </span>
              )}
            </button>
          );
        })}
      </div>
    );
  }, [
    locale,
    sessionFiles,
    startEntryDrag,
    trackEntryDrag,
    finishEntryDrag,
    openSessionFile,
  ]);

  const rootLoading = rootState?.status === 'loading';
  const canRefresh = Boolean(selectedRootPath && !rootLoading);
  const projectTreeStatusTitle = treeVcsStatusLine(
    selectedRootPath
      ? basename(selectedRootPath) || selectedRootPath
      : activeWorkspace?.name ?? t(locale, 'projectTree.noWorkspace'),
    vcsTreeState,
  );
  // Folder bar sizing: show every attached folder, but cap the visible height at
  // 3 rows (≈30px each) and scroll beyond that. The bar only renders when there
  // are 2+ folders, so a single-folder project stays compact.
  const FOLDER_ROW_HEIGHT = 30;
  const MAX_VISIBLE_FOLDERS = 3;
  const folderBarMaxHeight = FOLDER_ROW_HEIGHT * MAX_VISIBLE_FOLDERS;

  return (
    <>
      <aside
        className="relative flex h-full shrink-0 flex-col border-l border-border bg-panel"
        style={{ width }}
      >
        <div
          onMouseDown={onResizeStart}
          title={t(locale, 'common.resizeWidth')}
          className="group absolute -left-1 bottom-0 top-0 z-20 flex w-2 cursor-col-resize items-center justify-center"
        >
          <div className="h-full w-0.5 bg-transparent transition-colors group-hover:bg-accent/40" />
        </div>

        <header className="shrink-0 border-b border-border-soft px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <div
              role="tablist"
              aria-label="右侧项目面板"
              className="flex min-w-0 flex-1 rounded-md border border-border-soft bg-panel-2 p-0.5"
            >
              <button
                type="button"
                role="tab"
                aria-selected={panelTab === 'files'}
                onClick={() => updatePanelTab('files')}
                className={
                  'flex h-7 min-w-0 flex-1 items-center justify-center gap-1.5 rounded px-2 text-xs transition-colors hover:text-fg ' +
                  (panelTab === 'files' ? 'bg-panel text-fg' : 'text-fg-faint')
                }
              >
                <FolderOpen size={13} className="shrink-0 text-accent-2" />
                <span className="truncate">{t(locale, 'projectTree.title')}</span>
              </button>
              {/* 「会话文件」tab：只展示当前会话里 AI 读取/修改过的文件，纯前端解析消息流，
                  不触发任何 git/p4/svn 等版本管理指令（旧的「工作区改动」tab 会触发 P4
                  reconcile 洪水，已彻底移除）。 */}
              <button
                type="button"
                role="tab"
                aria-selected={panelTab === 'session'}
                onClick={() => updatePanelTab('session')}
                className={
                  'flex h-7 min-w-0 flex-1 items-center justify-center gap-1.5 rounded px-2 text-xs transition-colors hover:text-fg ' +
                  (panelTab === 'session' ? 'bg-panel text-fg' : 'text-fg-faint')
                }
              >
                <History size={13} className="shrink-0 text-accent" />
                <span className="truncate">{t(locale, 'sessionFiles.tab')}</span>
                {sessionFiles.length > 0 && (
                  <span className="shrink-0 rounded bg-accent/15 px-1 font-mono text-[10px] text-accent">
                    {sessionFiles.length}
                  </span>
                )}
              </button>
            </div>
            {panelTab === 'files' && (
              <div className="ml-auto flex shrink-0 rounded-md border border-border-soft bg-panel-2 p-0.5">
                {/* 文件修改状态扫描已停用，移除其开关按钮（眼睛图标）。 */}
              <button
                type="button"
                aria-pressed={viewMode === 'tree'}
                title={t(locale, 'projectTree.treeMode')}
                onClick={() => updateViewMode('tree')}
                className={
                  'flex h-6 w-6 items-center justify-center rounded text-fg-faint transition-colors hover:text-fg ' +
                  (viewMode === 'tree' ? 'bg-panel text-fg' : '')
                }
              >
                <List size={13} />
              </button>
              <button
                type="button"
                aria-pressed={viewMode === 'preview'}
                title={t(locale, 'projectTree.previewMode')}
                onClick={() => updateViewMode('preview')}
                className={
                  'flex h-6 w-6 items-center justify-center rounded text-fg-faint transition-colors hover:text-fg ' +
                  (viewMode === 'preview' ? 'bg-panel text-fg' : '')
                }
              >
                <LayoutGrid size={13} />
              </button>
              </div>
            )}
          </div>
          <div
            className="mt-1 truncate font-mono text-[10px] text-fg-faint"
            title={panelTab === 'session' ? t(locale, 'sessionFiles.title') : selectedRootPath}
          >
            {panelTab === 'session'
              ? t(locale, 'sessionFiles.count').replace(
                  '{count}',
                  String(sessionFiles.length),
                )
              : projectTreeStatusTitle}
          </div>
        </header>

        {/* 工作区文件夹条：展示当前会话挂载的多个文件夹（在“项目设置 → 概览”中配置，
            新建对话自动继承）。仅 2 个及以上文件夹时显示；高度随数量增长，但最多显示
            3 个，超出可滚动。点击切换当前浏览的文件夹根。 */}
        {panelTab === 'files' && rootFolders.length > 1 && (
          <div
            className="shrink-0 overflow-y-auto border-b border-border-soft px-1.5 py-1"
            style={{ maxHeight: folderBarMaxHeight }}
          >
            {rootFolders.map((path) => {
              const key = workspacePathKey(path);
              const active = key === activeRootKey;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSelectedRootKey(key)}
                  title={path}
                  className={
                    'flex h-[28px] w-full min-w-0 items-center gap-1.5 rounded px-2 text-left text-xs transition-colors ' +
                    (active
                      ? 'bg-panel-2 text-fg'
                      : 'text-fg-dim hover:bg-panel-2/60 hover:text-fg')
                  }
                >
                  {active ? (
                    <FolderOpen size={13} className="shrink-0 text-accent-2" />
                  ) : (
                    <Folder size={13} className="shrink-0 text-fg-faint" />
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {basename(path) || path}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto py-1">
          {panelTab === 'session' ? (
            renderSessionFiles()
          ) : !selectedRootPath ? (
            <div className="px-3 py-4 text-sm leading-relaxed text-fg-faint">
              {t(locale, 'projectTree.empty')}
            </div>
          ) : viewMode === 'preview' ? (
            renderPreviewMode()
          ) : (
            renderDirectory('', 0)
          )}
        </div>

        {/* 「会话文件」tab 的列表随消息流实时更新，无需手动刷新按钮；仅文件树 tab
            提供刷新（重新列目录）。 */}
        {panelTab === 'files' && (
          <div className="shrink-0 border-t border-border-soft p-2">
            <button
              type="button"
              disabled={!canRefresh}
              onClick={refreshActiveWorkspace}
              title={t(locale, 'projectTree.refresh')}
              className="flex h-8 w-full items-center justify-center gap-2 rounded-md border border-border bg-panel-2 px-2 text-sm text-fg-dim transition-colors hover:border-accent hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw
                size={14}
                className={rootLoading ? 'animate-spin text-accent' : 'text-fg-faint'}
              />
              <span>
                {rootLoading
                  ? t(locale, 'projectTree.refreshing')
                  : t(locale, 'projectTree.refresh')}
              </span>
            </button>
          </div>
        )}
      </aside>

      {contextMenu && (
        <ProjectEntryContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          label={t(locale, 'projectTree.revealInExplorer')}
          onReveal={revealContextMenuEntry}
        />
      )}

      <FilePreviewDrawer
        refData={previewRef}
        cwd={selectedRootPath || undefined}
        onClose={() => setPreviewRef(null)}
      />
    </>
  );
}
