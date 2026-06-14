import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
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
  removeAsset,
  subscribeAssets,
  type AssetEntry,
  type AssetKind,
  type AssetSource,
} from '@/lib/downloadRegistry';
import { openExternal, openLocalPath } from '@/lib/tauri';
import VideoPlayer from '@/components/ai/VideoPlayer';

/**
 * CONTRACT: the unified Asset Hub modal. Lists every tracked asset (see
 * lib/downloadRegistry) regardless of source — generated, downloaded, searched
 * or installed. Supports filtering by kind + source, free-text search, inline
 * media previews, and per-source row actions (open file / reveal / open
 * source). Splits entries into "in progress" and "ready" sections.
 */

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

/** Coarse kind buckets used by the filter bar (music/speech fold into audio). */
type KindFilter =
  | 'all'
  | 'image'
  | 'video'
  | 'audio'
  | 'mesh'
  | 'sprite'
  | 'skill'
  | 'mcp'
  | 'plugin'
  | 'file';

const KIND_FILTERS: KindFilter[] = [
  'all',
  'image',
  'video',
  'audio',
  'mesh',
  'sprite',
  'skill',
  'mcp',
  'plugin',
  'file',
];

const SOURCE_FILTERS: Array<'all' | AssetSource> = [
  'all',
  'generated',
  'downloaded',
  'searched',
  'installed',
];

function matchesKindFilter(entry: AssetEntry, filter: KindFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'audio')
    return entry.kind === 'audio' || entry.kind === 'music' || entry.kind === 'speech';
  if (filter === 'mesh') return entry.kind === 'mesh' || entry.kind === 'model';
  return entry.kind === filter;
}

function isImagePreview(entry: AssetEntry): boolean {
  return (
    (entry.kind === 'image' || entry.kind === 'sprite') &&
    Boolean(entry.previewUrl)
  );
}

function isVideoPreview(entry: AssetEntry): boolean {
  return entry.kind === 'video' && Boolean(entry.previewUrl);
}

function isAudioPreview(entry: AssetEntry): boolean {
  return (
    (entry.kind === 'audio' || entry.kind === 'music' || entry.kind === 'speech') &&
    Boolean(entry.previewUrl)
  );
}

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

// __APPEND_1__

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

function MetaTags({ entry, locale }: { entry: AssetEntry; locale: Locale }) {
  const sourceLabel = t(locale, `downloads.filterSource.${entry.source}` as const);
  const originLabel = t(
    locale,
    entry.origin === 'local' ? 'downloads.originLocal' : 'downloads.originRemote',
  );
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[10px] text-fg-dim">
        {sourceLabel}
      </span>
      <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[10px] text-fg-faint">
        {originLabel}
      </span>
      {entry.provider && (
        <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[10px] text-fg-faint">
          {entry.provider}
        </span>
      )}
    </span>
  );
}

function AssetPreview({ entry }: { entry: AssetEntry }) {
  const src = entry.previewUrl;
  if (!src) return null;
  if (isImagePreview(entry)) {
    return (
      <img
        src={src}
        alt={entry.title}
        loading="lazy"
        className="mt-2 max-h-44 w-full rounded border border-border-soft bg-black object-contain"
      />
    );
  }
  if (isVideoPreview(entry)) {
    return (
      <div className="mt-2">
        <VideoPlayer src={src} label={entry.title} />
      </div>
    );
  }
  if (isAudioPreview(entry)) {
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
}: {
  entry: AssetEntry;
  locale: Locale;
}) {
  const Icon = KIND_ICON[entry.kind] ?? FileDown;
  const size = formatBytes(entry.sizeBytes);
  const isTerminal = entry.status !== 'pending';

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
    <li className="flex items-start gap-3 rounded-md border border-border-soft bg-bg-alt px-3 py-2.5">
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
        <div className="mt-1">
          <MetaTags entry={entry} locale={locale} />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10px] text-fg-faint">
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
      <div className="flex shrink-0 items-center gap-1">
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

function FilterChip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 rounded-full border px-2.5 py-1 text-xs transition-colors ${
        active
          ? 'border-accent bg-accent/15 text-fg'
          : 'border-border-soft bg-panel-2 text-fg-faint hover:border-accent hover:text-fg'
      }`}
    >
      {label}
    </button>
  );
}

// __APPEND_2__

export default function DownloadsModal({
  locale,
  onClose,
}: {
  locale: Locale;
  onClose: () => void;
}) {
  const assets = useSyncExternalStore(subscribeAssets, getAssets);
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [sourceFilter, setSourceFilter] = useState<'all' | AssetSource>('all');
  const [query, setQuery] = useState('');

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return assets.filter((entry) => {
      if (!matchesKindFilter(entry, kindFilter)) return false;
      if (sourceFilter !== 'all' && entry.source !== sourceFilter) return false;
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
  }, [assets, kindFilter, sourceFilter, query]);

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
            <div className="mt-3 flex flex-col gap-2">
              <input
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t(locale, 'downloads.searchPlaceholder')}
                className="w-full rounded-md border border-border-soft bg-panel-2 px-3 py-1.5 text-sm text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none"
              />
              <div className="flex flex-wrap gap-1.5">
                {KIND_FILTERS.map((filter) => (
                  <FilterChip
                    key={filter}
                    active={kindFilter === filter}
                    label={t(locale, `downloads.filterKind.${filter}` as const)}
                    onClick={() => setKindFilter(filter)}
                  />
                ))}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {SOURCE_FILTERS.map((filter) => (
                  <FilterChip
                    key={filter}
                    active={sourceFilter === filter}
                    label={t(locale, `downloads.filterSource.${filter}` as const)}
                    onClick={() => setSourceFilter(filter)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
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
                <section>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-faint">
                    {t(locale, 'downloads.active')}
                    <span className="ml-1.5 text-accent">{active.length}</span>
                  </h3>
                  <ul className="flex flex-col gap-2">
                    {active.map((entry) => (
                      <DownloadRow
                        key={entry.id}
                        entry={entry}
                        locale={locale}
                      />
                    ))}
                  </ul>
                </section>
              )}

              {finished.length > 0 && (
                <section>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-faint">
                    {t(locale, 'downloads.completed')}
                    <span className="ml-1.5 text-fg-dim">
                      {finished.length}
                    </span>
                  </h3>
                  <ul className="flex flex-col gap-2">
                    {finished.map((entry) => (
                      <DownloadRow
                        key={entry.id}
                        entry={entry}
                        locale={locale}
                      />
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
