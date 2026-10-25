import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react';
import {
  Boxes,
  CheckCircle2,
  Download,
  FolderOpen,
  Image as ImageIcon,
  Loader2,
  Music,
  Package,
  Puzzle,
  Sparkles,
  Trash2,
  Video,
  Wand2,
  XCircle,
  FileDown,
  ExternalLink,
  Star,
  Info,
  ArrowLeft,
  Link2,
  Search,
  type LucideIcon,
} from 'lucide-react';
import { t } from '@/lib/i18n';
import type { Locale } from '@/lib/i18n';
import {
  isOutputAsset,
  linkConversationUrls,
  getAssetIndexError,
  clearFinishedAssets,
  getAssets,
  linkKnownAssetsToNearestMessages,
  linkKnownManagedAssetsFromMessageText,
  linkManagedAssetsFromMessageText,
  linkModifiedAssetsFromMessage,
  mergeCachedAssetsFromDisk,
  removeAsset,
  subscribeAssets,
  updateAssetDetails,
  type AssetEntry,
  type AssetKind,
} from '@/lib/downloadRegistry';
import {
  listCachedAssets,
  openExternal,
  openLocalPath,
  tauriAvailable,
} from '@/lib/tauri';
import { useStore } from '@/store/useStore';
import { historyStore } from '@/store/history/store';
import VideoPlayer from '@/components/ai/VideoPlayer';
import AssetDetails from '@/components/ai/AssetDetails';
import { assetThumbnail, probeAssetFile } from '@/lib/assetPreviewCache';
import { ASSET_CATEGORIES, ASSET_SOURCE_LABELS, assetCategory, assetInScope, filterHubAssets, type AssetCategory, type AssetScope } from '@/lib/assetHubModel';
import './ArtifactsPanel.css';

/**
 * CONTRACT: the unified Asset Hub main page. Lists every tracked asset (see
 * lib/downloadRegistry) regardless of source — generated, downloaded, searched
 * or installed. Supports filtering by kind + source, free-text search, inline
 * media previews, per-source row actions (open file / reveal / open source),
 * and conversation jumps for session-backed assets. Splits entries into "in
 * progress" and "ready" sections.
 */

const ASSET_SESSION_JUMP_EVENT = 'ugs:asset-session-jump';
const INITIAL_RENDERED_ASSETS = 40;
const RENDER_ASSET_PAGE_SIZE = 40;
const ACTIVE_ASSET_MESSAGE_LINK_WINDOW_MS = 2 * 60 * 60 * 1000;
const HISTORY_ASSET_MESSAGE_LINK_WINDOW_MS = 12 * 60 * 60 * 1000;

const KIND_ICON: Record<AssetKind, LucideIcon> = {
  image: ImageIcon,
  video: Video,
  audio: Music,
  music: Music,
  speech: Music,
  mesh: Boxes,
  model: Boxes,
  sprite: Sparkles,
  mcp: Package,
  skill: Wand2,
  plugin: Puzzle,
  file: FileDown,
};

function formatBytes(bytes: number | undefined): string | null {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return null;
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded =
    value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1);
  return `${rounded} ${units[unit]}`;
}

function formatTime(ts: number | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes(),
  ).padStart(2, '0')}`;
}

function isManagedLocalAsset(entry: AssetEntry): boolean {
  return Boolean(
    entry.localPath?.toLowerCase().includes('.ultragamestudio'),
  );
}

async function linkKnownManagedAssetsFromHistory(
  workspaceIds: string[],
  isCancelled: () => boolean = () => false,
  workspacePaths: Record<string, string> = {},
): Promise<void> {
  const userFallbacks: Array<{
    text: string;
    sessionId: string;
    workspaceId: string;
    messageId: string;
  }> = [];
  const nearestCandidates: Array<{
    sessionId: string;
    workspaceId: string;
    messageId: string;
    role: 'user' | 'assistant' | 'system';
    createdAt: number;
  }> = [];

  for (const workspaceId of workspaceIds) {
    let sessions: Awaited<ReturnType<typeof historyStore.listSessions>>;
    try {
      sessions = await historyStore.listSessions(workspaceId);
    } catch {
      continue;
    }

    for (const session of sessions) {
      if (isCancelled()) return;
      let record: Awaited<ReturnType<typeof historyStore.getSession>>;
      try {
        record = await historyStore.getSession(workspaceId, session.id);
      } catch {
        continue;
      }
      if (!record) continue;

      for (const message of record.messages) {
        if (isCancelled()) return;
        nearestCandidates.push({
          sessionId: record.id,
          workspaceId,
          messageId: message.id,
          role: message.role,
          createdAt: message.createdAt,
        });
        if (message.role === 'assistant') {
            linkConversationUrls({ text: message.text, sessionId: record.id, workspaceId, messageId: message.id, at: message.createdAt, sessionTitle: record.title });
            linkManagedAssetsFromMessageText({
              text: message.text,
              sessionId: record.id,
              workspaceId,
              messageId: message.id,
              at: message.createdAt,
              sessionTitle: record.title,
              cwd: message.fileChanges?.rootPath ?? workspacePaths[workspaceId],
            });
            linkModifiedAssetsFromMessage({ changes: message.fileChanges, sessionId: record.id, workspaceId, messageId: message.id, at: message.createdAt, sessionTitle: record.title });
          continue;
        }
        if (message.role === 'user') {
          if (!message.text.includes('.ultragamestudio')) continue;
          userFallbacks.push({
            text: message.text,
            sessionId: record.id,
            workspaceId,
            messageId: message.id,
          });
        }
      }
    }
  }

  // Only link hub rows that remain unlinked after assistant output was tried.
  // This lets pasted clipboard images jump back without turning arbitrary user
  // paths into asset rows.
  for (const message of userFallbacks) {
    if (isCancelled()) return;
    linkKnownManagedAssetsFromMessageText(message);
  }

  if (isCancelled()) return;
  linkKnownAssetsToNearestMessages({
    messages: nearestCandidates,
    maxDistanceMs: HISTORY_ASSET_MESSAGE_LINK_WINDOW_MS,
  });
}

function linkManagedAssetsFromActiveMessage(input: {
  text: string;
  role: 'user' | 'assistant' | 'system';
  sessionId: string;
  workspaceId: string | null;
  messageId: string;
  cwd?: string;
  at?: number;
}): void {
  {
    if (input.role === 'assistant') {
      linkConversationUrls(input);
      linkManagedAssetsFromMessageText({
        text: input.text,
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        messageId: input.messageId,
        cwd: input.cwd,
        at: input.at,
      });
    } else if (input.role === 'user') {
      linkKnownManagedAssetsFromMessageText({
        text: input.text,
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        messageId: input.messageId,
      });
    }
  }
}

function refreshAssetEntry(entry: AssetEntry): AssetEntry {
  return (
    getAssets().find(
      (item) =>
        item.id === entry.id ||
        Boolean(entry.localPath && item.localPath === entry.localPath),
    ) ?? entry
  );
}

function StatusBadge({
  entry,
  locale,
}: {
  entry: AssetEntry;
  locale: Locale;
}) {
  if (entry.availability === 'missing' && entry.status !== 'pending') {
    return <span className="inline-flex items-center gap-1 text-[11px] text-status-error"><XCircle size={12} aria-hidden="true" />文件缺失</span>;
  }
  if (entry.status === 'pending') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-accent">
        <Loader2 size={12} className="animate-spin" aria-hidden="true" />
        {t(locale, 'downloads.statusDownloading')}
      </span>
    );
  }
  if (entry.status === 'success') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-status-success">
        <CheckCircle2 size={12} aria-hidden="true" />
        {t(locale, 'downloads.statusSuccess')}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-status-error">
      <XCircle size={12} aria-hidden="true" />
      {t(locale, 'downloads.statusError')}
    </span>
  );
}

/**
 * Resolve a displayable source for a media asset. Prefers the inline preview;
 * when it is absent (e.g. a large generated image whose base64 was dropped on
 * persist to keep the history under the localStorage quota) but a `localPath`
 * exists, lazily read the file back through the desktop backend and cache the
 * resulting data URL on the entry id. Returns null while loading / when there
 * is nothing to show.
 */
function useResolvedPreview(entry: AssetEntry): string | null {
  const [resolved, setResolved] = useState<string | null>(
    entry.previewUrl ?? null,
  );

  useEffect(() => {
    if (entry.previewUrl) {
      setResolved(entry.previewUrl);
      return;
    }
    // Only image/sprite previews are worth rebuilding inline; other kinds are
    // opened on demand via the row actions instead.
    const rebuildable =
      (entry.kind === 'image' || entry.kind === 'sprite') &&
      Boolean(entry.localPath) &&
      tauriAvailable();
    if (!rebuildable || !entry.localPath) {
      setResolved(null);
      return;
    }
    let cancelled = false;
    setResolved(null);
    void assetThumbnail(entry.localPath, entry.finishedAt)
      .then((preview) => {
        if (cancelled) return;
        setResolved(preview);
      })
      .catch(() => {
        if (!cancelled) setResolved(null);
      });
    return () => {
      cancelled = true;
    };
  }, [entry.previewUrl, entry.localPath, entry.kind, entry.finishedAt]);

  return resolved;
}

function AssetPreview({ entry }: { entry: AssetEntry }) {
  const src = useResolvedPreview(entry);
  if (!src) return <div className="artifact-preview-empty"><ImageIcon size={24} strokeWidth={1} /><span>{entry.availability === 'missing' ? '文件缺失' : '暂无缩略图'}</span></div>;
  const isImage = entry.kind === 'image' || entry.kind === 'sprite';
  const isVideo = entry.kind === 'video';
  const isAudio =
    entry.kind === 'audio' || entry.kind === 'music' || entry.kind === 'speech';
  if (isImage) {
    return (
      <img
        src={src}
        alt={entry.title}
        loading="lazy"
        className="artifact-preview-image"
      />
    );
  }
  if (isVideo) {
    return (
      <div className="mt-2">
        <VideoPlayer src={src} label={entry.title} />
      </div>
    );
  }
  if (isAudio) {
    return (
      <audio
        src={src}
        controls
        preload="metadata"
        className="mt-2 w-full"
      />
    );
  }
  return null;
}

function DownloadRow({
  entry,
  locale,
  onJumpToSession,
  onDetails,
  grid = false,
}: {
  entry: AssetEntry;
  locale: Locale;
  onJumpToSession?: (entry: AssetEntry) => void | Promise<void>;
  onDetails: (entry: AssetEntry) => void;
  grid?: boolean;
}) {
  const isLink = assetCategory(entry) === 'link';
  const Icon = isLink ? Link2 : KIND_ICON[entry.kind] ?? FileDown;
  const size = formatBytes(entry.sizeBytes);
  const isTerminal = entry.status !== 'pending';
  const canJumpToSession = Boolean(
    onJumpToSession && entry.sessionId,
  );

  useEffect(() => {
    if (!entry.localPath || !tauriAvailable()) return;
    let cancelled = false;
    void probeAssetFile(entry.localPath).then(exists => {
      const availability = exists ? 'available' : 'missing';
      if (!cancelled && entry.availability !== availability) updateAssetDetails(entry.id, { availability });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [entry.id, entry.localPath, entry.availability]);

  const handleOpen = useCallback(
    async (reveal: boolean) => {
      if (!entry.localPath) return;
      const ok = await openLocalPath(entry.localPath, { reveal });
      if (!ok && typeof window !== 'undefined') {
        window.alert(t(locale, 'downloads.openFailed'));
      }
    },
    [entry.localPath, locale],
  );

  const handleOpenSource = useCallback(async () => {
    if (!entry.remoteUrl) return;
    await openExternal(entry.remoteUrl);
  }, [entry.remoteUrl]);

  return (
    <li
      role={canJumpToSession ? 'button' : undefined}
      tabIndex={canJumpToSession ? 0 : undefined}
      aria-label={canJumpToSession ? t(locale, 'downloads.openSession') : undefined}
      onClick={canJumpToSession ? () => void onJumpToSession?.(entry) : undefined}
      onKeyDown={
        canJumpToSession
          ? (event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              void onJumpToSession?.(entry);
            }
          : undefined
      }
      className={`artifact-entry ${grid ? 'artifact-card' : 'artifact-table-row'} ${canJumpToSession ? 'has-session' : ''}`}
      style={{ contentVisibility: 'auto', containIntrinsicSize: grid ? '0 260px' : '0 64px' }}
    >
      {grid && <button type="button" className="artifact-card-preview" aria-label={`预览产物：${entry.title}`} onClick={event => { event.stopPropagation(); onDetails(entry); }}>
        {['image', 'sprite', 'video', 'audio', 'music', 'speech'].includes(entry.kind) && entry.status === 'success' ? <AssetPreview entry={entry} /> : <Icon size={32} strokeWidth={1} />}
      </button>}
      <div className="artifact-name-cell">
        <span className="artifact-kind-icon"><Icon size={14} aria-hidden="true" /></span>
        <div className="artifact-name-content">
          {grid && <span className="artifact-kind-label">{isLink ? '链接' : ASSET_CATEGORIES.find(item => item.id === assetCategory(entry))?.label ?? '文件'}</span>}
          <button type="button" className="artifact-title" title={entry.title} aria-label={`查看产物：${entry.title}`} onClick={event => { event.stopPropagation(); onDetails(entry); }}>{entry.title}{isLink && <ExternalLink size={10} />}</button>
          {entry.status !== 'success' || entry.availability === 'missing' ? <div className="artifact-status"><StatusBadge entry={entry} locale={locale} />{entry.error && <span title={entry.error}>{entry.error}</span>}</div> : null}
          {!grid && size && <span className="artifact-kind-label">{size}</span>}
        </div>
      </div>
      <div className="artifact-location-cell" title={entry.localPath ?? entry.remoteUrl}>{entry.localPath ?? entry.remoteUrl ?? '暂无路径'}</div>
      <div className="artifact-session-cell">
        <span title={entry.sessionTitle ?? entry.sessionId}>{entry.sessionTitle ?? (entry.sessionId ? '来源会话' : '来源未知')}{entry.provenance === 'inferred' ? ' · 推断' : ''}</span>
        <time>{new Date(entry.finishedAt ?? entry.startedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })} {formatTime(entry.finishedAt ?? entry.startedAt)}</time>
        {grid && <span className="artifact-conversation"><FolderOpen size={11} />{canJumpToSession ? '查看对话' : ASSET_SOURCE_LABELS[entry.source]}</span>}
      </div>
      <div
        className="artifact-row-actions"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <button type="button" aria-label={entry.favorite ? '取消收藏' : '收藏产物'} title={entry.favorite ? '取消收藏' : '收藏产物'} onClick={() => updateAssetDetails(entry.id, { favorite: !entry.favorite })} className="flex h-7 w-7 items-center justify-center rounded border border-border-soft text-accent"><Star size={13} fill={entry.favorite ? 'currentColor' : 'none'} /></button>
        <button type="button" aria-label="产物详情" title="产物详情" onClick={() => onDetails(entry)} className="flex h-7 w-7 items-center justify-center rounded border border-border-soft text-fg-dim"><Info size={13} /></button>
        {entry.status === 'success' && entry.localPath && (
          <>
            <button
              type="button"
              title={t(locale, 'downloads.openFile')}
              aria-label={t(locale, 'downloads.openFile')}
              disabled={entry.availability === 'missing'}
              onClick={() => void handleOpen(false)}
              className="flex h-7 w-7 items-center justify-center rounded border border-border-soft bg-panel-2 text-fg-faint transition-colors hover:border-accent hover:text-fg"
            >
              <FolderOpen size={13} aria-hidden="true" />
            </button>
            <button
              type="button"
              title={t(locale, 'downloads.revealFile')}
              aria-label={t(locale, 'downloads.revealFile')}
              disabled={entry.availability === 'missing'}
              onClick={() => void handleOpen(true)}
              className="flex h-7 w-7 items-center justify-center rounded border border-border-soft bg-panel-2 text-fg-faint transition-colors hover:border-accent hover:text-fg"
            >
              <Download size={13} aria-hidden="true" />
            </button>
          </>
        )}
        {entry.status === 'success' && !entry.localPath && entry.remoteUrl && (
          <button
            type="button"
            title={t(locale, 'downloads.openSource')}
            aria-label={t(locale, 'downloads.openSource')}
            onClick={() => void handleOpenSource()}
            className="flex h-7 w-7 items-center justify-center rounded border border-border-soft bg-panel-2 text-fg-faint transition-colors hover:border-accent hover:text-fg"
          >
            <ExternalLink size={13} aria-hidden="true" />
          </button>
        )}
        {isTerminal && (
          <button
            type="button"
            title={t(locale, 'downloads.remove')}
            aria-label={t(locale, 'downloads.remove')}
            onClick={() => removeAsset(entry.id)}
            className="flex h-7 w-7 items-center justify-center rounded border border-border-soft bg-panel-2 text-fg-faint transition-colors hover:border-status-error hover:text-status-error"
          >
            <Trash2 size={13} aria-hidden="true" />
          </button>
        )}
      </div>
    </li>
  );
}

function AssetSection({
  title,
  count,
  countClassName,
  entries,
  locale,
  scrollRootRef,
  onJumpToSession,
  onDetails,
  layout,
}: {
  title: string;
  count: number;
  countClassName: string;
  entries: AssetEntry[];
  locale: Locale;
  scrollRootRef: RefObject<HTMLDivElement>;
  onJumpToSession: (entry: AssetEntry) => void;
  onDetails: (entry: AssetEntry) => void;
  layout: 'auto' | 'grid' | 'list';
}) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [visibleCount, setVisibleCount] = useState(INITIAL_RENDERED_ASSETS);
  const resetKey = `${entries.length}:${entries[0]?.id ?? ''}:${
    entries[entries.length - 1]?.id ?? ''
  }`;
  const visibleEntries = entries.slice(0, visibleCount);
  const hasMore = visibleCount < entries.length;

  useEffect(() => {
    setVisibleCount(INITIAL_RENDERED_ASSETS);
  }, [resetKey]);

  useEffect(() => {
    if (!hasMore) return;
    if (typeof window === 'undefined' || typeof window.IntersectionObserver === 'undefined') {
      return;
    }
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new window.IntersectionObserver(
      (items) => {
        if (!items.some((item) => item.isIntersecting)) return;
        setVisibleCount((current) =>
          Math.min(entries.length, current + RENDER_ASSET_PAGE_SIZE),
        );
      },
      {
        root: scrollRootRef.current,
        rootMargin: '360px 0px',
      },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [entries.length, hasMore, scrollRootRef]);

  const loadMore = useCallback(() => {
    setVisibleCount((current) =>
      Math.min(entries.length, current + RENDER_ASSET_PAGE_SIZE),
    );
  }, [entries.length]);

  return (
    <section className="artifact-section">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-faint">
        {title}
        <span className={`ml-1.5 ${countClassName}`}>{count}</span>
      </h3>
      {(layout === 'list' || (layout === 'auto' && !entries.every(entry => ['image', 'sprite'].includes(entry.kind)))) && <div className="artifact-table-head" aria-hidden="true"><span>{entries.every(entry => assetCategory(entry) === 'link') ? '链接标题' : '名称'}</span><span>{entries.every(entry => assetCategory(entry) === 'link') ? 'URL' : '路径'}</span><span>会话</span></div>}
      <ul className={layout === 'grid' || (layout === 'auto' && entries.every(entry => ['image', 'sprite'].includes(entry.kind))) ? 'artifacts-grid' : 'artifact-table'}>
        {visibleEntries.map((entry) => (
          <DownloadRow
            key={entry.id}
            entry={entry}
            locale={locale}
            onJumpToSession={onJumpToSession}
            onDetails={onDetails}
            grid={layout === 'grid' || (layout === 'auto' && entries.every(entry => ['image', 'sprite'].includes(entry.kind)))}
          />
        ))}
      </ul>
      {hasMore && (
        <div ref={sentinelRef} className="mt-3 flex justify-center">
          <button
            type="button"
            onClick={loadMore}
            className="rounded-md border border-border-soft bg-panel-2 px-3 py-1.5 text-xs text-fg-dim transition-colors hover:border-accent hover:text-fg"
          >
            {t(locale, 'downloads.loadMore')}
          </button>
        </div>
      )}
    </section>
  );
}

export default function ArtifactsPanel({
  locale,
  onClose,
}: {
  locale: Locale;
  onClose: () => void;
}) {
  const assets = useSyncExternalStore(subscribeAssets, getAssets);
  const selectSession = useStore((s) => s.selectSession);
  const historyReady = useStore((s) => s.historyReady);
  const workspaces = useStore((s) => s.workspaces);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const composerWorkspace = useStore((s) => s.composer.workspace);
  const messages = useStore((s) => s.messages);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<AssetCategory>('all');
  const [source, setSource] = useState('all');
  const [scope, setScope] = useState<AssetScope>(activeWorkspaceId ? 'workspace' : 'all');
  const [layout, setLayout] = useState<'auto' | 'grid' | 'list'>('auto');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [oldestFirst, setOldestFirst] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [indexing, setIndexing] = useState(false);
  const scrollRootRef = useRef<HTMLDivElement | null>(null);

  const assetCacheCwd = useMemo(() => {
    const activeWorkspace = activeWorkspaceId
      ? workspaces.find((workspace) => workspace.id === activeWorkspaceId)
      : null;
    return activeWorkspace?.path?.trim() || composerWorkspace.trim() || null;
  }, [activeWorkspaceId, composerWorkspace, workspaces]);
  const historyWorkspaceIds = useMemo(
    () =>
      scope !== 'all' && activeWorkspaceId
        ? [activeWorkspaceId]
        : workspaces.map((workspace) => workspace.id),
    [activeWorkspaceId, workspaces, scope],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { if (detailId) setDetailId(null); else onClose(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, detailId]);

  useEffect(() => {
    if (!tauriAvailable()) return;
    let cancelled = false;
    const targets = scope === 'all' ? workspaces.filter(w => w.path).map(w => ({ path: w.path, id: w.id })) : [{ path: assetCacheCwd, id: activeWorkspaceId }];
    void (async () => {
      for (const target of targets) {
        if (cancelled) return;
        try {
          const files = await listCachedAssets(target.path);
          if (!cancelled) mergeCachedAssetsFromDisk(files, target.id);
        } catch { /* other indexed projects remain browsable */ }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, assetCacheCwd, scope, workspaces]);

  useEffect(() => {
    if (!activeSessionId) return;
    for (const message of messages) {
      linkManagedAssetsFromActiveMessage({
        text: message.text,
        role: message.role,
        sessionId: activeSessionId,
        workspaceId: activeWorkspaceId,
        messageId: message.id,
        cwd: assetCacheCwd ?? undefined,
        at: message.createdAt,
      });
      if (message.role === 'assistant') linkModifiedAssetsFromMessage({ changes: message.fileChanges, sessionId: activeSessionId, workspaceId: activeWorkspaceId, messageId: message.id, at: message.createdAt });
    }
    linkKnownAssetsToNearestMessages({
      messages: messages.map((message) => ({
        sessionId: activeSessionId,
        workspaceId: activeWorkspaceId,
        messageId: message.id,
        role: message.role,
        createdAt: message.createdAt,
      })),
      maxDistanceMs: ACTIVE_ASSET_MESSAGE_LINK_WINDOW_MS,
    });
  }, [activeSessionId, activeWorkspaceId, assetCacheCwd, messages]);

  useEffect(() => {
    if (!historyReady || historyWorkspaceIds.length === 0) {
      return;
    }
    let cancelled = false;
    setIndexing(true);
    void linkKnownManagedAssetsFromHistory(
      historyWorkspaceIds,
      () => cancelled,
      Object.fromEntries(workspaces.map(workspace => [workspace.id, workspace.path])),
    ).finally(() => { if (!cancelled) setIndexing(false); });

    return () => {
      cancelled = true;
    };
  }, [historyReady, historyWorkspaceIds, workspaces]);

  const handleJumpToSession = useCallback(
    async (entry: AssetEntry) => {
      if (typeof window === 'undefined') return;
      if (activeSessionId) {
        linkKnownAssetsToNearestMessages({
          messages: messages.map((message) => ({
            sessionId: activeSessionId,
            workspaceId: activeWorkspaceId,
            messageId: message.id,
            role: message.role,
            createdAt: message.createdAt,
          })),
          maxDistanceMs: ACTIVE_ASSET_MESSAGE_LINK_WINDOW_MS,
        });
      }
      let target = refreshAssetEntry(entry);
      if (
        (!target.sessionId || !target.messageId) &&
        (isManagedLocalAsset(target) ||
          target.source === 'generated' ||
          target.source === 'downloaded')
      ) {
        await linkKnownManagedAssetsFromHistory(historyWorkspaceIds, () => false, Object.fromEntries(workspaces.map(workspace => [workspace.id, workspace.path])));
        target = refreshAssetEntry(entry);
      }
      if (!target.sessionId) return;

      selectSession(target.sessionId, target.workspaceId ?? undefined);
      window.dispatchEvent(
        new CustomEvent(ASSET_SESSION_JUMP_EVENT, {
          detail: {
            assetId: target.id,
            sessionId: target.sessionId,
            workspaceId: target.workspaceId ?? null,
            messageId: target.messageId ?? null,
          },
        }),
      );
      onClose();
    },
    [activeSessionId, activeWorkspaceId, historyWorkspaceIds, messages, onClose, selectSession, workspaces],
  );

  const filtered = useMemo(() => {
    return filterHubAssets(assets, { query, category, source, scope, workspaceId: activeWorkspaceId, sessionId: activeSessionId, favoritesOnly, oldestFirst });
  }, [activeWorkspaceId, activeSessionId, assets, query, category, source, scope, favoritesOnly, oldestFirst]);
  const scoped = assets.filter(entry => assetInScope(entry, scope, activeWorkspaceId, activeSessionId));
  const counts = new Map<AssetCategory, number>();
  for (const entry of scoped) {
    const kind = assetCategory(entry);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    if (isOutputAsset(entry)) counts.set('all', (counts.get('all') ?? 0) + 1);
  }

  const active = filtered.filter((entry) => entry.status === 'pending');
  const finished = filtered.filter((entry) => entry.status !== 'pending');
  const finishedAll = filtered.filter((entry) => entry.status !== 'pending');
  const isEmpty = scoped.length === 0 && !query && category === 'all' && source === 'all' && !favoritesOnly;
  const noMatch = !isEmpty && filtered.length === 0;

  return (
    <div
      data-ugs-artifacts
      className="artifacts-page"
    >
      <div className="artifacts-body">
      <section
        aria-labelledby="downloads-title"
        className="flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden"
      >
        <div className="artifacts-header">
          <div className="flex flex-wrap items-center gap-3">
            <h2 id="downloads-title" className="artifacts-heading">{t(locale, 'downloads.title')}</h2>
            <label className="artifacts-search"><Search size={14} aria-hidden="true" /><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索名称、路径或会话" aria-label="搜索产物" /></label>
            {finishedAll.length > 0 && (
              <button
                type="button"
                onClick={() =>
                  clearFinishedAssets((entry) => filtered.some(item => item.id === entry.id))
                }
                className="shrink-0 rounded-md border border-border bg-panel-2 px-2.5 py-1.5 text-xs text-fg-dim transition-colors hover:border-status-error hover:text-status-error"
              >
                清除当前结果
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              title="返回对话"
              aria-label="返回对话"
              className="flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-xs text-fg-faint transition-colors hover:bg-panel-2 hover:text-fg"
            >
              <ArrowLeft size={14} />返回对话
            </button>
          </div>

          <div className="artifacts-filters">
            <select aria-label="查看范围" value={scope} onChange={event => setScope(event.target.value as AssetScope)} className="rounded border border-border bg-panel-2 px-2 py-1.5 text-fg">
              <option value="workspace" disabled={!activeWorkspaceId}>当前项目</option><option value="session" disabled={!activeSessionId || !activeWorkspaceId}>当前会话</option><option value="all">全部已索引项目</option>
            </select>
            <select aria-label="产物来源" value={source} onChange={event => setSource(event.target.value)} className="rounded border border-border bg-panel-2 px-2 py-1.5 text-fg"><option value="all">全部来源</option>{Object.entries(ASSET_SOURCE_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
            <select aria-label="显示方式" value={layout} onChange={event => setLayout(event.target.value as typeof layout)} className="rounded border border-border bg-panel-2 px-2 py-1.5 text-fg"><option value="auto">图片网格 / 文件列表</option><option value="grid">网格</option><option value="list">列表</option></select>
            <select aria-label="时间排序" value={oldestFirst ? 'oldest' : 'newest'} onChange={event => setOldestFirst(event.target.value === 'oldest')} className="rounded border border-border bg-panel-2 px-2 py-1.5 text-fg"><option value="newest">最新优先</option><option value="oldest">最早优先</option></select>
            <button type="button" aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly(!favoritesOnly)} className={`rounded border px-2 py-1.5 ${favoritesOnly ? 'border-accent text-accent' : 'border-border text-fg-dim'}`}>只看收藏</button>
            <span className="ml-auto text-fg-faint">{indexing ? '正在回填历史…' : `${filtered.length} 项结果`}</span>
          </div>
          <div className="artifacts-categories" aria-label="产物分类">{ASSET_CATEGORIES.map(item => <button key={item.id} type="button" aria-pressed={category === item.id} onClick={() => { setCategory(item.id); setSource('all'); }} className={category === item.id ? 'is-active' : ''}>{item.label}<span>{counts.get(item.id) ?? 0}</span></button>)}</div>
          {getAssetIndexError() && <p role="alert" className="mt-2 text-xs text-status-error">{getAssetIndexError()}</p>}
        </div>

        <div ref={scrollRootRef} className="artifacts-scroll">
          {isEmpty ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-sm text-fg-faint">
              <Boxes
                size={28}
                className="text-fg-faint/60"
                aria-hidden="true"
              />
              <span>暂无产物。生成、下载或修改文件后会出现在这里。</span>
            </div>
          ) : noMatch ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-sm text-fg-faint">
              <span>{t(locale, 'downloads.noMatch')}</span>
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              {active.length > 0 && (
                <AssetSection
                  title={t(locale, 'downloads.active')}
                  count={active.length}
                  countClassName="text-accent"
                  entries={active}
                  locale={locale}
                  scrollRootRef={scrollRootRef}
                  onJumpToSession={handleJumpToSession}
                  onDetails={entry => setDetailId(entry.id)}
                  layout="list"
                />
              )}

              {finished.length > 0 && layout !== 'auto' && (
                <AssetSection
                  title={t(locale, 'downloads.completed')}
                  count={finished.length}
                  countClassName="text-fg-dim"
                  entries={finished}
                  locale={locale}
                  scrollRootRef={scrollRootRef}
                  onJumpToSession={handleJumpToSession}
                  onDetails={entry => setDetailId(entry.id)}
                  layout={layout}
                />
              )}
              {layout === 'auto' && ['image', 'file', 'link'].map(group => {
                const items = finished.filter(entry => (['image', 'sprite'].includes(entry.kind) ? 'image' : assetCategory(entry) === 'link' ? 'link' : 'file') === group);
                return items.length ? <AssetSection key={group} title={group === 'image' ? '图片' : group === 'link' ? '链接' : '文件与媒体'} count={items.length} countClassName="text-fg-dim" entries={items} locale={locale} scrollRootRef={scrollRootRef} onJumpToSession={handleJumpToSession} onDetails={entry => setDetailId(entry.id)} layout={group === 'image' ? 'grid' : 'list'} /> : null;
              })}
            </div>
          )}
        </div>
      </section>
      {detailId && assets.find(entry => entry.id === detailId) && <AssetDetails inline key={detailId} entry={assets.find(entry => entry.id === detailId)!} onClose={() => setDetailId(null)} onJump={handleJumpToSession} onReuse={onClose} />}
      </div>
    </div>
  );
}
