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
  X,
  XCircle,
  FileDown,
  ExternalLink,
  type LucideIcon,
} from 'lucide-react';
import { t } from '@/lib/i18n';
import type { Locale } from '@/lib/i18n';
import {
  clearFinishedAssets,
  getAssets,
  linkKnownManagedAssetsFromMessageText,
  linkManagedAssetsFromMessageText,
  mergeCachedAssetsFromDisk,
  removeAsset,
  subscribeAssets,
  type AssetEntry,
  type AssetKind,
} from '@/lib/downloadRegistry';
import {
  listCachedAssets,
  openExternal,
  openLocalPath,
  previewLocalFile,
  tauriAvailable,
} from '@/lib/tauri';
import { useStore } from '@/store/useStore';
import { historyStore } from '@/store/history/store';
import VideoPlayer from '@/components/ai/VideoPlayer';

/**
 * CONTRACT: the unified Asset Hub modal. Lists every tracked asset (see
 * lib/downloadRegistry) regardless of source — generated, downloaded, searched
 * or installed. Supports filtering by kind + source, free-text search, inline
 * media previews, per-source row actions (open file / reveal / open source),
 * and conversation jumps for session-backed assets. Splits entries into "in
 * progress" and "ready" sections.
 */

const ASSET_SESSION_JUMP_EVENT = 'fuc:asset-session-jump';
const INITIAL_RENDERED_ASSETS = 40;
const RENDER_ASSET_PAGE_SIZE = 40;

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
    entry.localPath?.toLowerCase().includes('.freeultracode'),
  );
}

async function linkKnownManagedAssetsFromHistory(
  workspaceIds: string[],
  isCancelled: () => boolean = () => false,
): Promise<void> {
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
        // Only AI-produced messages count: the Asset Hub tracks what the
        // assistant generated/downloaded/modified, not paths the user typed.
        if (message.role !== 'assistant') continue;
        if (!message.text.includes('.freeultracode')) continue;
        linkKnownManagedAssetsFromMessageText({
          text: message.text,
          sessionId: record.id,
          workspaceId,
          messageId: message.id,
        });
      }
    }
  }
}

function StatusBadge({
  entry,
  locale,
}: {
  entry: AssetEntry;
  locale: Locale;
}) {
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
      <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400">
        <CheckCircle2 size={12} aria-hidden="true" />
        {t(locale, 'downloads.statusSuccess')}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-rose-400">
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
    void previewLocalFile(entry.localPath)
      .then((preview) => {
        if (cancelled) return;
        if (preview.kind === 'image' && preview.base64) {
          const mime = preview.mime ?? 'image/png';
          setResolved(`data:${mime};base64,${preview.base64}`);
        }
      })
      .catch(() => {
        if (!cancelled) setResolved(null);
      });
    return () => {
      cancelled = true;
    };
  }, [entry.previewUrl, entry.localPath, entry.kind]);

  return resolved;
}

function AssetPreview({ entry }: { entry: AssetEntry }) {
  const src = useResolvedPreview(entry);
  if (!src) return null;
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
        className="mt-2 max-h-44 w-full rounded border border-border-soft bg-black object-contain"
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
}: {
  entry: AssetEntry;
  locale: Locale;
  onJumpToSession?: (entry: AssetEntry) => void | Promise<void>;
}) {
  const Icon = KIND_ICON[entry.kind] ?? FileDown;
  const size = formatBytes(entry.sizeBytes);
  const isTerminal = entry.status !== 'pending';
  const canJumpToSession = Boolean(
    onJumpToSession && (entry.sessionId || isManagedLocalAsset(entry)),
  );

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
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              void onJumpToSession?.(entry);
            }
          : undefined
      }
      className={`flex items-start gap-3 rounded-md border border-border-soft bg-bg-alt px-3 py-2.5 ${
        canJumpToSession
          ? 'cursor-pointer transition-colors hover:border-accent/50 hover:bg-panel-2/75 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60'
          : ''
      }`}
      style={{ contentVisibility: 'auto', containIntrinsicSize: '0 220px' }}
    >
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border-soft bg-panel-2 text-fg-faint">
        <Icon size={15} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="min-w-0 flex-1 truncate text-sm text-fg"
            title={entry.localPath ?? entry.remoteUrl ?? entry.title}
          >
            {entry.title}
          </span>
          <StatusBadge entry={entry} locale={locale} />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10px] text-fg-faint">
          {entry.provider && <span>{entry.provider}</span>}
          {entry.model && <span>{entry.model}</span>}
          {size && <span>{size}</span>}
          <span>{formatTime(entry.finishedAt ?? entry.startedAt)}</span>
          {entry.remoteUrl && (
            <span
              className="min-w-0 max-w-[14rem] truncate"
              title={entry.remoteUrl}
            >
              {entry.remoteUrl}
            </span>
          )}
        </div>
        {entry.prompt && (
          <div
            className="mt-1 line-clamp-2 text-[11px] leading-snug text-fg-dim"
            title={entry.prompt}
          >
            {entry.prompt}
          </div>
        )}
        {entry.status === 'success' && <AssetPreview entry={entry} />}
        {entry.status === 'error' && entry.error && (
          <div className="mt-1 break-words text-[11px] leading-snug text-rose-300">
            {entry.error}
          </div>
        )}
      </div>
      <div
        className="flex shrink-0 items-center gap-1"
        onClick={(event) => event.stopPropagation()}
      >
        {entry.status === 'success' && entry.localPath && (
          <>
            <button
              type="button"
              title={t(locale, 'downloads.openFile')}
              aria-label={t(locale, 'downloads.openFile')}
              onClick={() => void handleOpen(false)}
              className="flex h-7 w-7 items-center justify-center rounded border border-border-soft bg-panel-2 text-fg-faint transition-colors hover:border-accent hover:text-fg"
            >
              <FolderOpen size={13} aria-hidden="true" />
            </button>
            <button
              type="button"
              title={t(locale, 'downloads.revealFile')}
              aria-label={t(locale, 'downloads.revealFile')}
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
            className="flex h-7 w-7 items-center justify-center rounded border border-border-soft bg-panel-2 text-fg-faint transition-colors hover:border-rose-400 hover:text-rose-300"
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
}: {
  title: string;
  count: number;
  countClassName: string;
  entries: AssetEntry[];
  locale: Locale;
  scrollRootRef: RefObject<HTMLDivElement>;
  onJumpToSession: (entry: AssetEntry) => void;
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
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-faint">
        {title}
        <span className={`ml-1.5 ${countClassName}`}>{count}</span>
      </h3>
      <ul className="flex flex-col gap-2">
        {visibleEntries.map((entry) => (
          <DownloadRow
            key={entry.id}
            entry={entry}
            locale={locale}
            onJumpToSession={onJumpToSession}
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

export default function DownloadsModal({
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
  const scrollRootRef = useRef<HTMLDivElement | null>(null);

  const assetCacheCwd = useMemo(() => {
    const activeWorkspace = activeWorkspaceId
      ? workspaces.find((workspace) => workspace.id === activeWorkspaceId)
      : null;
    return activeWorkspace?.path?.trim() || composerWorkspace.trim() || null;
  }, [activeWorkspaceId, composerWorkspace, workspaces]);
  const historyWorkspaceIds = useMemo(
    () =>
      activeWorkspaceId
        ? [activeWorkspaceId]
        : workspaces.map((workspace) => workspace.id),
    [activeWorkspaceId, workspaces],
  );
  const unlinkedManagedAssetScanKey = useMemo(
    () =>
      assets
        .filter(
          (entry) =>
            entry.localPath &&
            !entry.sessionId &&
            entry.localPath.toLowerCase().includes('.freeultracode'),
        )
        .map((entry) => entry.id)
        .join('|'),
    [assets],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (!tauriAvailable()) return;
    let cancelled = false;
    void listCachedAssets(assetCacheCwd)
      .then((files) => {
        if (!cancelled) mergeCachedAssetsFromDisk(files);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [assetCacheCwd]);

  useEffect(() => {
    if (!activeSessionId) return;
    for (const message of messages) {
      // Skip user messages: a path the user mentions is not an AI-handled asset.
      if (message.role !== 'assistant') continue;
      if (!message.text.includes('.freeultracode')) continue;
      linkManagedAssetsFromMessageText({
        text: message.text,
        sessionId: activeSessionId,
        workspaceId: activeWorkspaceId,
        messageId: message.id,
      });
    }
  }, [activeSessionId, activeWorkspaceId, messages]);

  useEffect(() => {
    if (!historyReady || !unlinkedManagedAssetScanKey || historyWorkspaceIds.length === 0) {
      return;
    }
    let cancelled = false;
    void linkKnownManagedAssetsFromHistory(
      historyWorkspaceIds,
      () => cancelled,
    );

    return () => {
      cancelled = true;
    };
  }, [historyReady, historyWorkspaceIds, unlinkedManagedAssetScanKey]);

  const handleJumpToSession = useCallback(
    async (entry: AssetEntry) => {
      if (typeof window === 'undefined') return;
      let target = entry;
      if (!target.sessionId && isManagedLocalAsset(target)) {
        await linkKnownManagedAssetsFromHistory(historyWorkspaceIds);
        target =
          getAssets().find(
            (item) =>
              item.id === entry.id ||
              (entry.localPath && item.localPath === entry.localPath),
          ) ?? entry;
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
    [historyWorkspaceIds, onClose, selectSession],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return assets.filter((entry) => {
      if (q) {
        const haystack = [
          entry.title,
          entry.prompt,
          entry.provider,
          entry.model,
          entry.remoteUrl,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [assets, query]);

  const active = filtered.filter((entry) => entry.status === 'pending');
  const finished = filtered.filter((entry) => entry.status !== 'pending');
  const finishedAll = assets.filter((entry) => entry.status !== 'pending');
  const isEmpty = assets.length === 0;
  const noMatch = !isEmpty && filtered.length === 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 sm:p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="downloads-title"
        className="flex max-h-[calc(100vh-2.5rem)] w-[calc(100vw-2.5rem)] max-w-[720px] flex-col overflow-hidden rounded-lg border border-border bg-panel shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="shrink-0 border-b border-border-soft bg-bg-alt px-5 py-4">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent text-bg">
              <Boxes size={18} strokeWidth={2.2} />
            </span>
            <div className="min-w-0 flex-1">
              <h2
                id="downloads-title"
                className="text-base font-semibold text-fg"
              >
                {t(locale, 'downloads.title')}
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-fg-faint">
                {t(locale, 'downloads.subtitle')}
              </p>
            </div>
            {finishedAll.length > 0 && (
              <button
                type="button"
                onClick={() => clearFinishedAssets()}
                className="shrink-0 rounded-md border border-border bg-panel-2 px-2.5 py-1.5 text-xs text-fg-dim transition-colors hover:border-rose-400 hover:text-rose-300"
              >
                {t(locale, 'downloads.clearFinished')}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              title={t(locale, 'common.close')}
              aria-label={t(locale, 'common.close')}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-panel-2 text-fg-faint transition-colors hover:border-accent hover:text-fg"
            >
              <X size={15} strokeWidth={2.2} />
            </button>
          </div>

          {!isEmpty && (
            <div className="mt-3">
              <input
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t(locale, 'downloads.searchPlaceholder')}
                className="w-full rounded-md border border-border-soft bg-panel-2 px-3 py-1.5 text-sm text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none"
              />
            </div>
          )}
        </div>

        <div ref={scrollRootRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {isEmpty ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-sm text-fg-faint">
              <Boxes
                size={28}
                className="text-fg-faint/60"
                aria-hidden="true"
              />
              <span>{t(locale, 'downloads.empty')}</span>
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
                />
              )}

              {finished.length > 0 && (
                <AssetSection
                  title={t(locale, 'downloads.completed')}
                  count={finished.length}
                  countClassName="text-fg-dim"
                  entries={finished}
                  locale={locale}
                  scrollRootRef={scrollRootRef}
                  onJumpToSession={handleJumpToSession}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
