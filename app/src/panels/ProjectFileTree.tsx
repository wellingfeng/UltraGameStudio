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
  Crosshair,
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
import GameTeamPanel, {
  OPEN_GAME_TEAM_DETAILS_EVENT,
  type OpenGameTeamDetailsEventDetail,
} from '@/panels/GameTeamPanel';
import {
  OPEN_PROJECT_RIGHT_PANEL_FILE_PREVIEW_EVENT,
  type OpenProjectRightPanelFilePreviewEventDetail,
} from '@/panels/projectRightPanelEvents';
import { t, type Locale } from '@/lib/i18n';
import {
  buildSessionFileTree,
  countSessionFileChanges,
  extractSessionFiles,
  mergeSessionFilesWithWorkspaceChanges,
  type SessionFileEntry,
  type SessionFileTreeNode,
} from '@/lib/sessionFiles';
import {
  SESSION_CHANGES_UPDATED_EVENT,
  readPersistedSessionChanges,
  sessionChangesCacheKey,
} from '@/lib/sessionChanges';
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
  PROJECT_FILE_TREE_MIN_WIDTH,
  projectFileTreeDefaultWidth,
  projectFileTreeMaxWidth,
} from '@/lib/projectFileTreeSizing';
import {
  listWorkspaceDirectory,
  openLocalPath,
  engineRevealAsset,
  previewLocalFile,
  type WorkspaceChanges,
  type WorkspaceTreeEntry,
} from '@/lib/tauri';
import { useResizableWidth } from '@/lib/useResizableWidth';
import {
  uniqueWorkspaceHistory,
  workspacePathKey,
} from '@/lib/workspaceHistory';
import {
  isRemoteWorkspacePath,
  listRemoteWorkspaceDirectory,
  previewRemoteWorkspaceFile,
  REMOTE_WORKSPACE_FILES_UPDATED_EVENT,
  type RemoteWorkspaceFilesUpdatedDetail,
} from '@/lib/remoteWorkspace';
import { basename } from '@/lib/folderPicker';
import { useStore } from '@/store/useStore';

type ProjectPanelTab = 'files' | 'session';
type ProjectTreeViewMode = 'tree' | 'preview';
type ProjectEngine = 'unreal' | 'unity' | 'godot' | 'cocos' | 'generic';

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

interface ProjectTreeRenderEntry {
  entry: WorkspaceTreeEntry;
  virtualDeleted: boolean;
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
  cocos: 'Cocos',
  generic: '项目',
};

const ENGINE_BADGES: Record<ProjectEngine, string> = {
  unreal: 'UE',
  unity: 'UNITY',
  godot: 'GODOT',
  cocos: 'COCOS',
  generic: 'FILE',
};

const THUMBNAIL_CACHE_LIMIT = 96;
const THUMBNAIL_LOAD_BATCH_SIZE = 12;
const THUMBNAIL_ROOT_MARGIN = '280px 0px';
const CONTEXT_MENU_WIDTH = 176;
const CONTEXT_MENU_HEIGHT = 36;
const CONTEXT_MENU_MARGIN = 8;
function projectRightPanelVisible(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia === 'function') {
    return window.matchMedia('(min-width: 1024px)').matches;
  }
  return window.innerWidth >= 1024;
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
    (hasFile('project.json') || hasDirectory('settings'))
  ) {
    return 'cocos';
  }
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
    if (engine === 'cocos' && lower === 'assets') return 'ASSETS';
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
  if (engine === 'cocos') {
    if (ext === 'scene') return 'SCENE';
    if (ext === 'prefab') return 'PREFAB';
    if (ext === 'fire') return 'SCENE';
    if (ext === 'ts') return 'TS';
    if (entry.name.toLowerCase() === 'project.json') return 'PROJECT';
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
  if (engine === 'cocos') {
    return 'linear-gradient(135deg, #102331, #145c64 48%, #22d3ee)';
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
  revealLabel,
  engineLabel,
  showEngineItem,
  onReveal,
  onRevealInEngine,
}: {
  x: number;
  y: number;
  revealLabel: string;
  engineLabel: string;
  showEngineItem: boolean;
  onReveal: () => void;
  onRevealInEngine: () => void;
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
      {showEngineItem && (
        <button
          type="button"
          role="menuitem"
          onClick={onRevealInEngine}
          className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-border-soft"
        >
          <Crosshair size={13} className="shrink-0 text-fg-faint" />
          <span className="truncate">{engineLabel}</span>
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        onClick={onReveal}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-border-soft"
      >
        <FolderOpen size={13} className="shrink-0 text-fg-faint" />
        <span className="truncate">{revealLabel}</span>
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

function compareTreeEntries(a: WorkspaceTreeEntry, b: WorkspaceTreeEntry): number {
  if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
  return a.name
    .toLocaleLowerCase()
    .localeCompare(b.name.toLocaleLowerCase()) || a.name.localeCompare(b.name);
}

function buildRenderEntries(entries: WorkspaceTreeEntry[]): ProjectTreeRenderEntry[] {
  return entries
    .map((entry) => ({ entry, virtualDeleted: false }))
    .sort((a, b) => compareTreeEntries(a.entry, b.entry));
}

function sessionFileBadgeLabel(locale: Locale, entry: SessionFileEntry): string {
  if (entry.changeStatus === 'added') return t(locale, 'sessionFiles.statusAdded');
  if (entry.changeStatus === 'deleted') return t(locale, 'sessionFiles.statusDeleted');
  if (entry.changeStatus === 'renamed') return t(locale, 'sessionFiles.statusRenamed');
  if (entry.changeStatus === 'modified') return t(locale, 'sessionFiles.statusModified');
  return entry.action === 'edited'
    ? t(locale, 'sessionFiles.actionEdited')
    : t(locale, 'sessionFiles.actionRead');
}

function sessionFileBadgeClass(entry: SessionFileEntry): string {
  if (entry.changeStatus === 'added') return 'border-emerald-400/45 text-emerald-300';
  if (entry.changeStatus === 'deleted') return 'border-status-error/45 text-status-error';
  if (entry.changeStatus === 'renamed') return 'border-amber-300/45 text-amber-300';
  if (entry.changeStatus === 'modified') return 'border-accent/45 text-accent';
  return entry.action === 'edited'
    ? 'border-accent/45 text-accent'
    : 'border-border-soft text-fg-faint';
}

function sessionFileCountLine(
  locale: Locale,
  total: number,
  counts: ReturnType<typeof countSessionFileChanges>,
): string {
  const base = t(locale, 'sessionFiles.count').replace('{count}', String(total));
  const changed = counts.added + counts.modified + counts.deleted + counts.renamed;
  if (changed === 0) return base;
  const parts = [
    `${t(locale, 'sessionFiles.statusAdded')} ${counts.added}`,
    `${t(locale, 'sessionFiles.statusModified')} ${counts.modified}`,
    `${t(locale, 'sessionFiles.statusDeleted')} ${counts.deleted}`,
  ];
  if (counts.renamed > 0) {
    parts.push(`${t(locale, 'sessionFiles.statusRenamed')} ${counts.renamed}`);
  }
  return `${base} · ${parts.join(' · ')}`;
}

export default function ProjectFileTree() {
  const locale = useStore((s) => s.locale);
  const workspaces = useStore((s) => s.workspaces);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const composerWorkspace = useStore((s) => s.composer.workspace);
  const composerWorkspaceFolders = useStore((s) => s.composer.workspaceFolders);
  // 「会话文件」标签的数据来源：当前会话里 AI 工具调用（<<UGS_TOOL>> 内联事件）
  // 修改过的文件，并合并运行结束时已经持久化的会话改动缓存。
  const sessionMessages = useStore((s) => s.messages);
  const sessionActivityVersion = useStore(
    (s) =>
      `${s.aiEditingSessions.length}:${s.chattingSessions.length}:${s.runningSessions.length}`,
  );
  const [cache, setCache] = useState<WorkspaceTreeCache>({});
  const cacheRef = useRef(cache);
  const [previewRef, setPreviewRef] = useState<FileRef | null>(null);
  const [teamDetailsPreview, setTeamDetailsPreview] = useState<{
    nodeId?: string;
  } | null>(null);
  // 预览抽屉解析相对路径时使用的工作目录。「文件」标签用当前选中的根目录，
  // 「会话文件」标签则用会话自己的工作目录（见 openSessionFile），二者解耦，
  // 避免会话文件因为文件夹下拉条被切到子目录而解析到错误的绝对路径。
  const [previewCwd, setPreviewCwd] = useState<string | undefined>(undefined);
  const [previewDiffEnabled, setPreviewDiffEnabled] = useState(false);
  // 「工作区改动」tab 已停用（会触发 P4 reconcile 洪水）。改为「会话文件」tab：
  // 只展示当前会话里 AI 修改过的文件；新增/修改/删除来自已落盘缓存。
  const [panelTab, setPanelTab] = useState<ProjectPanelTab>(() => {
    if (typeof window === 'undefined') return 'files';
    const stored = window.localStorage.getItem(
      'ultragamestudio.projectRightPanelTab.v1',
    );
    return stored === 'session' ? stored : 'files';
  });
  const [viewMode, setViewMode] = useState<ProjectTreeViewMode>(() => {
    if (typeof window === 'undefined') return 'tree';
    return window.localStorage.getItem('ultragamestudio.projectFileTreeView.v1') ===
      'preview'
      ? 'preview'
      : 'tree';
  });
  const [previewDirectories, setPreviewDirectories] = useState<Record<string, string>>({});
  const [thumbnailCache, setThumbnailCache] = useState<ThumbnailCache>({});
  const [visibleThumbnails, setVisibleThumbnails] = useState<ThumbnailVisibility>({});
  const [contextMenu, setContextMenu] = useState<ProjectEntryContextMenuState>(null);
  const [collapsedSessionDirs, setCollapsedSessionDirs] = useState<Record<string, true>>({});
  const visibleThumbnailsRef = useRef<ThumbnailVisibility>({});

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
  const remoteWorkspaceSelected = isRemoteWorkspacePath(activeWorkspacePath);


  // The right-hand panel browses every folder attached to the active session:
  // the composer's primary workspace plus its extra folders (configured in
  // Project Settings → 概览 and inherited by new sessions). The folder bar lets
  // the user pick which root to browse; the tree below shows that root.
  const rootFolders = useMemo(() => {
    if (remoteWorkspaceSelected) return activeWorkspacePath ? [activeWorkspacePath] : [];
    const folders = uniqueWorkspaceHistory([
      composerWorkspace,
      ...composerWorkspaceFolders,
      activeWorkspacePath,
    ]);
    return folders;
  }, [
    composerWorkspace,
    composerWorkspaceFolders,
    activeWorkspacePath,
    remoteWorkspaceSelected,
  ]);
  const sessionChangesRootPath = rootFolders[0] ?? '';
  const activeSessionChangesCacheKey = useMemo(
    () =>
      sessionChangesCacheKey(
        activeWorkspaceId,
        activeSessionId,
        sessionChangesRootPath,
      ),
    [activeWorkspaceId, activeSessionId, sessionChangesRootPath],
  );
  const [sessionChangesSnapshot, setSessionChangesSnapshot] =
    useState<WorkspaceChanges | null>(null);
  const [sessionChangesVersion, setSessionChangesVersion] = useState(0);

  useEffect(() => {
    if (typeof window === 'undefined' || !activeSessionChangesCacheKey) return;
    const onUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ cacheKey?: string }>).detail;
      if (detail?.cacheKey === activeSessionChangesCacheKey) {
        setSessionChangesVersion((value) => value + 1);
      }
    };
    window.addEventListener(SESSION_CHANGES_UPDATED_EVENT, onUpdated);
    return () => {
      window.removeEventListener(SESSION_CHANGES_UPDATED_EVENT, onUpdated);
    };
  }, [activeSessionChangesCacheKey]);

  useEffect(() => {
    let cancelled = false;
    if (!sessionChangesRootPath || !activeSessionChangesCacheKey) {
      setSessionChangesSnapshot(null);
      return;
    }
    if (isRemoteWorkspacePath(sessionChangesRootPath)) {
      setSessionChangesSnapshot(null);
      return;
    }
    void readPersistedSessionChanges(
      sessionChangesRootPath,
      activeSessionChangesCacheKey,
    )
      .then((snapshot) => {
        if (!cancelled) setSessionChangesSnapshot(snapshot);
      })
      .catch(() => {
        if (!cancelled) setSessionChangesSnapshot(null);
      });
    return () => {
      cancelled = true;
    };
  }, [
    sessionChangesRootPath,
    activeSessionChangesCacheKey,
    sessionChangesVersion,
    sessionActivityVersion,
    sessionMessages.length,
  ]);

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
          if (isRemoteWorkspacePath(root)) {
            return sessionIgnoreRootFromContents(root, []);
          }
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

  // 当前会话修改文件：从消息流里的 AI 工具调用事件解析，并合并运行结束时
  // 已持久化的会话改动快照；读取行为不进入右侧“会话文件”列表。
  const sessionFiles = useMemo(() => {
    const isIgnored = buildSessionIgnorePredicate(ignoreRoots);
    const activityFiles = extractSessionFiles(sessionMessages, { isIgnored });
    return mergeSessionFilesWithWorkspaceChanges(
      activityFiles,
      sessionChangesSnapshot,
      { isIgnored },
    ).filter((entry) => entry.action === 'edited' || entry.changeStatus);
  }, [sessionMessages, ignoreRoots, sessionChangesSnapshot]);
  const sessionFileChangeCounts = useMemo(
    () => countSessionFileChanges(sessionFiles),
    [sessionFiles],
  );
  const sessionFileTree = useMemo(
    () => buildSessionFileTree(sessionFiles),
    [sessionFiles],
  );
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
  const previewDirectoryEntries = useMemo(
    () => previewDirectoryState?.entries ?? [],
    [previewDirectoryState?.entries],
  );
  const { width, onResizeStart } = useResizableWidth({
    storageKey: 'ultragamestudio.projectFileTreeWidth.v1',
    defaultWidth: projectFileTreeDefaultWidth(),
    min: PROJECT_FILE_TREE_MIN_WIDTH,
    max: projectFileTreeMaxWidth(),
    edge: 'left',
  });

  const loadDirectory = useCallback(
    async (
      workspaceId: string,
      rootPath: string,
      relativePath: string,
      options: { force?: boolean; sync?: boolean } = {},
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
        const listing = isRemoteWorkspacePath(rootPath)
          ? await listRemoteWorkspaceDirectory(rootPath, key, {
              sync: options.sync,
            })
          : await listWorkspaceDirectory(rootPath, key);
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
      window.localStorage.setItem('ultragamestudio.projectFileTreeView.v1', nextMode);
    }
  }, []);

  const updatePanelTab = useCallback((nextTab: ProjectPanelTab) => {
    setTeamDetailsPreview(null);
    setPanelTab(nextTab);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('ultragamestudio.projectRightPanelTab.v1', nextTab);
    }
  }, []);

  useEffect(() => {
    const openTeamDetails = (event: Event) => {
      const detail = (event as CustomEvent<OpenGameTeamDetailsEventDetail>).detail;
      setPreviewRef(null);
      setPreviewDiffEnabled(false);
      setTeamDetailsPreview({ nodeId: detail?.nodeId });
    };
    window.addEventListener(OPEN_GAME_TEAM_DETAILS_EVENT, openTeamDetails);
    return () =>
      window.removeEventListener(OPEN_GAME_TEAM_DETAILS_EVENT, openTeamDetails);
  }, []);

  useEffect(() => {
    const openFilePreview = (event: Event) => {
      if (!projectRightPanelVisible()) return;
      const detail =
        (event as CustomEvent<OpenProjectRightPanelFilePreviewEventDetail>)
          .detail;
      if (!detail?.ref) return;

      event.preventDefault();
      setTeamDetailsPreview(null);
      setPreviewCwd(detail.cwd || undefined);
      setPreviewDiffEnabled(false);
      setPreviewRef(detail.ref);
    };
    window.addEventListener(
      OPEN_PROJECT_RIGHT_PANEL_FILE_PREVIEW_EVENT,
      openFilePreview,
    );
    return () =>
      window.removeEventListener(
        OPEN_PROJECT_RIGHT_PANEL_FILE_PREVIEW_EVENT,
        openFilePreview,
      );
  }, []);

  const openSessionFile = useCallback(
    (entry: SessionFileEntry) => {
      // 会话文件的路径是 AI 工具调用原样上报的（可能是相对路径）。解析相对路径
      // 时必须用会话自己运行的工作目录，而不是右侧「文件」标签那个会被用户切换的
      // selectedRootPath，否则会拼出错误的绝对路径导致点击打不开。优先用会话主
      // 工作目录（composer.workspace），回退到会话改动根目录或首个根文件夹。
      const sessionCwd =
        composerWorkspace?.trim() ||
        sessionChangesRootPath?.trim() ||
        rootFolders[0] ||
        undefined;
      setTeamDetailsPreview(null);
      setPreviewCwd(sessionCwd || undefined);
      setPreviewDiffEnabled(true);
      setPreviewRef({ path: entry.path, basename: entry.basename });
    },
    [composerWorkspace, sessionChangesRootPath, rootFolders],
  );

  const toggleSessionDirectory = useCallback((key: string) => {
    setCollapsedSessionDirs((prev) => {
      if (prev[key]) {
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return { ...prev, [key]: true };
    });
  }, []);

  useEffect(() => {
    if (!activeRootKey || !selectedRootPath) return;
    const tree = cacheRef.current[activeRootKey];
    if (tree?.rootPath === selectedRootPath && tree.directories['']) return;
    void loadDirectory(activeRootKey, selectedRootPath, '');
  }, [activeRootKey, selectedRootPath, loadDirectory]);

  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      !activeRootKey ||
      !selectedRootPath ||
      !isRemoteWorkspacePath(selectedRootPath)
    ) {
      return;
    }
    const onRemoteFilesUpdated = (event: Event) => {
      const detail = (event as CustomEvent<RemoteWorkspaceFilesUpdatedDetail>)
        .detail;
      if (detail?.workspacePath !== selectedRootPath) return;
      void loadDirectory(activeRootKey, selectedRootPath, '', { force: true });
      if (previewDirectoryKey) {
        void loadDirectory(activeRootKey, selectedRootPath, previewDirectoryKey, {
          force: true,
        });
      }
    };
    window.addEventListener(
      REMOTE_WORKSPACE_FILES_UPDATED_EVENT,
      onRemoteFilesUpdated,
    );
    return () => {
      window.removeEventListener(
        REMOTE_WORKSPACE_FILES_UPDATED_EVENT,
        onRemoteFilesUpdated,
      );
    };
  }, [activeRootKey, loadDirectory, previewDirectoryKey, selectedRootPath]);

  useEffect(() => {
    setVisibleThumbnails({});
  }, [activeRootKey, previewDirectoryKey, viewMode]);

  useEffect(() => {
    if (viewMode !== 'preview' || !selectedRootPath) return;
    if (isRemoteWorkspacePath(selectedRootPath)) return;
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

  const revealContextMenuEntryInEngine = useCallback(() => {
    if (!contextMenu) return;
    const targetPath = contextMenu.entry.path;
    setContextMenu(null);
    if (!selectedRootPath) {
      if (typeof window !== 'undefined') {
        window.alert(t(locale, 'projectTree.revealInEngineUnsupported'));
      }
      return;
    }
    void engineRevealAsset(selectedRootPath, targetPath).then((result) => {
      // Only nag with a dialog when the jump did not happen; a successful
      // sync is self-evident in the editor and needs no popup.
      if (!result.ok && typeof window !== 'undefined') {
        window.alert(result.message);
      }
    });
  }, [selectedRootPath, contextMenu, locale]);

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
    // For remote projects, an explicit refresh should pull the repo's latest
    // commits (sync) — not just re-list the stale first-clone snapshot.
    void loadDirectory(activeRootKey, selectedRootPath, '', {
      force: true,
      sync: isRemoteWorkspacePath(selectedRootPath),
    });
  }, [activeRootKey, selectedRootPath, loadDirectory]);

  const previewProjectFile = useCallback(
    (path: string, opts?: { cwd?: string }) => {
      const cwd = opts?.cwd;
      if (cwd && isRemoteWorkspacePath(cwd)) {
        return previewRemoteWorkspaceFile(cwd, path);
      }
      return previewLocalFile(path, opts);
    },
    [],
  );

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
      const renderEntries = buildRenderEntries(directory?.entries ?? []);

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
          {renderEntries.map(({ entry, virtualDeleted }) => {
            const entryKey = directoryKey(entry.relativePath);
            const expanded = activeTree.expanded[entryKey] === true;
            const isDirectory = entry.kind === 'directory';
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
                    if (virtualDeleted || remoteWorkspaceSelected) {
                      event.preventDefault();
                      return;
                    }
                    openEntryContextMenu(event, entry);
                  }}
                  onClick={() => {
                    if (isDirectory) {
                      toggleDirectory(entry, { skipLoad: virtualDeleted });
                    } else if (!virtualDeleted) {
                      setTeamDetailsPreview(null);
                      setPreviewCwd(selectedRootPath || undefined);
                      setPreviewDiffEnabled(false);
                      setPreviewRef(fileRefFromEntry(entry));
                    }
                  }}
                  title={entry.path}
                  className={
                    'group flex h-7 w-full min-w-0 items-center gap-1.5 px-2 text-left text-xs transition-colors hover:bg-panel-2 hover:text-fg ' +
                    (virtualDeleted
                      ? 'cursor-default '
                      : remoteWorkspaceSelected && !isDirectory
                        ? 'cursor-pointer '
                        : remoteWorkspaceSelected
                          ? 'cursor-default '
                          : 'cursor-grab active:cursor-grabbing ') +
                    (entry.hidden ? 'text-fg-faint ' : 'text-fg-dim ')
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
                  </span>
                  <span className="min-w-0 flex-1 truncate">
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
      remoteWorkspaceSelected,
      startEntryDrag,
      toggleDirectory,
      trackEntryDrag,
    ],
  );

  const renderPreviewMode = useCallback((): ReactNode => {
    const directory = previewDirectoryState;
    const renderEntries = buildRenderEntries(directory?.entries ?? []);
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
            {renderEntries.map(({ entry, virtualDeleted }) => {
              const key = thumbnailKey(entry);
              return (
                <PreviewCard
                  key={`${virtualDeleted ? 'deleted:' : ''}${entry.path}`}
                  entry={entry}
                  engine={projectEngine}
                  thumbnailId={key}
                  draggable={!virtualDeleted}
                  thumbnail={
                    !virtualDeleted && !remoteWorkspaceSelected && isImageEntry(entry)
                      ? thumbnailCache[key]
                      : undefined
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
                    if (virtualDeleted || remoteWorkspaceSelected) {
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
                    } else if (
                      !virtualDeleted
                    ) {
                      setTeamDetailsPreview(null);
                      setPreviewCwd(selectedRootPath || undefined);
                      setPreviewDiffEnabled(false);
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
    remoteWorkspaceSelected,
    finishEntryDrag,
    startEntryDrag,
    thumbnailCache,
    trackEntryDrag,
    updateThumbnailVisibility,
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

    const renderNodes = (nodes: SessionFileTreeNode[], level: number): ReactNode =>
      nodes.map((node) => {
        if (node.type === 'directory') {
          const expanded = collapsedSessionDirs[node.key] !== true;
          return (
            <div key={node.key}>
              <button
                type="button"
                onClick={() => toggleSessionDirectory(node.key)}
                title={node.path}
                className="group flex h-7 w-full min-w-0 items-center gap-1.5 px-2 text-left text-xs text-fg-dim transition-colors hover:bg-panel-2 hover:text-fg"
                style={{ paddingLeft: 8 + level * 14 }}
              >
                <ChevronRight
                  size={13}
                  className={
                    'shrink-0 text-fg-faint transition-transform ' +
                    (expanded ? 'rotate-90' : '')
                  }
                />
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                  {expanded ? (
                    <FolderOpen size={14} className="shrink-0 text-accent-2" />
                  ) : (
                    <Folder size={14} className="shrink-0 text-accent-2" />
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate">{node.name}</span>
                <span className="shrink-0 font-mono text-[10px] text-fg-faint">
                  {node.fileCount}
                </span>
              </button>
              {expanded && renderNodes(node.children, level + 1)}
            </div>
          );
        }

        const entry = node.entry;
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
        const deleted = entry.changeStatus === 'deleted';
        const badgeLabel = sessionFileBadgeLabel(locale, entry);
        return (
          <button
            key={node.key}
            type="button"
            draggable
            onDragStart={(event) => startEntryDrag(event, dragEntry)}
            onDrag={trackEntryDrag}
            onDragEnd={finishEntryDrag}
            onContextMenu={(event) => openEntryContextMenu(event, dragEntry)}
            onClick={() => openSessionFile(entry)}
            title={entry.path}
            className={
              'group flex h-7 w-full min-w-0 cursor-grab items-center gap-1.5 px-2 text-left text-xs text-fg-dim transition-colors hover:bg-panel-2 hover:text-fg active:cursor-grabbing ' +
              (deleted ? 'opacity-80' : '')
            }
            style={{ paddingLeft: 8 + level * 14 }}
          >
            <span className="w-[13px] shrink-0" />
            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
              {edited ? (
                <FilePen size={14} className="shrink-0 text-accent" />
              ) : (
                <FileText size={14} className="shrink-0 text-fg-faint" />
              )}
            </span>
            <span
              className={
                'min-w-0 flex-1 truncate font-mono text-[11px] ' +
                (deleted ? 'line-through' : '')
              }
            >
              {node.name}
            </span>
            <span
              className={
                'shrink-0 rounded border px-1.5 py-0.5 text-[10px] leading-none ' +
                sessionFileBadgeClass(entry)
              }
            >
              {badgeLabel}
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
      });

    return (
      <div className="px-2 py-2">
        <p className="px-1 text-[10px] leading-relaxed text-fg-faint">
          {t(locale, 'sessionFiles.hint')}
        </p>
        <div className="mt-1">{renderNodes(sessionFileTree, 0)}</div>
      </div>
    );
  }, [
    collapsedSessionDirs,
    locale,
    sessionFileTree,
    sessionFiles,
    startEntryDrag,
    trackEntryDrag,
    finishEntryDrag,
    openEntryContextMenu,
    openSessionFile,
    toggleSessionDirectory,
  ]);

  const rootLoading = rootState?.status === 'loading';
  const canRefresh = Boolean(selectedRootPath && !rootLoading);
  const projectTreeStatusTitle = selectedRootPath
    ? basename(selectedRootPath) || selectedRootPath
    : activeWorkspace?.name ?? t(locale, 'projectTree.noWorkspace');
  // Folder bar sizing: show every attached folder, but cap the visible height at
  // 3 rows (≈30px each) and scroll beyond that. The bar only renders when there
  // are 2+ folders, so a single-folder project stays compact.
  const FOLDER_ROW_HEIGHT = 30;
  const MAX_VISIBLE_FOLDERS = 3;
  const folderBarMaxHeight = FOLDER_ROW_HEIGHT * MAX_VISIBLE_FOLDERS;
  const previewPanelOpen = Boolean(previewRef || teamDetailsPreview);

  return (
    <>
      <aside
        className="relative flex h-full shrink-0 flex-col border-l border-border bg-panel"
        style={{ width }}
      >
        <div
          onMouseDown={onResizeStart}
          title={t(locale, 'common.resizeWidth')}
          data-file-preview-ignore-outside-pointer="true"
          className="group absolute -left-1 bottom-0 top-0 z-20 flex w-2 cursor-col-resize items-center justify-center"
        >
          <div className="h-full w-0.5 bg-transparent transition-colors group-hover:bg-accent/40" />
        </div>

        {previewPanelOpen ? (
          <FilePreviewDrawer
            refData={teamDetailsPreview ? null : previewRef}
            customContent={
              teamDetailsPreview
                ? {
                    label: '岗位视角和 Skill',
                    path: '专家视角库 / 岗位视角与 Skill',
                    children: (
                      <GameTeamPanel
                        mode="details"
                        selectedNodeId={teamDetailsPreview.nodeId ?? null}
                      />
                    ),
                  }
                : null
            }
            cwd={previewCwd}
            previewFile={previewProjectFile}
            diffEnabled={
              previewDiffEnabled &&
              Boolean(previewCwd && !isRemoteWorkspacePath(previewCwd))
            }
            canOpenExternally={!previewCwd || !isRemoteWorkspacePath(previewCwd)}
            variant="embedded"
            onClose={() => {
              setPreviewRef(null);
              setTeamDetailsPreview(null);
              setPreviewDiffEnabled(false);
            }}
          />
        ) : (
          <>
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
              {/* 「会话文件」tab：只展示当前会话里 AI 修改过的文件；新增/修改/删除
                  来自已持久化的会话改动缓存，不在面板渲染时发起 VCS 扫描。 */}
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
            title={
              panelTab === 'session'
                ? t(locale, 'sessionFiles.title')
                : selectedRootPath
            }
          >
            {panelTab === 'session'
              ? sessionFileCountLine(
                  locale,
                  sessionFiles.length,
                  sessionFileChangeCounts,
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

        <div
          className={
            'min-h-0 flex-1 ' +
            'overflow-auto py-1'
          }
        >
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
          </>
        )}
      </aside>

      {contextMenu && (
        <ProjectEntryContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          revealLabel={t(locale, 'projectTree.revealInExplorer')}
          engineLabel={t(locale, 'projectTree.revealInEngine')}
          showEngineItem={
            contextMenu.entry.kind === 'file' && projectEngine !== 'generic'
          }
          onReveal={revealContextMenuEntry}
          onRevealInEngine={revealContextMenuEntryInEngine}
        />
      )}

    </>
  );
}
