/**
 * CONTRACT: the unified Asset Hub registry. It is the single source of truth
 * for every asset the app produces or pulls in, regardless of how it arrived:
 *   - generated  : images/video/audio/sprite/mesh created by a model (cloud or
 *                  local), saved into the workspace.
 *   - downloaded : files fetched from a remote URL (e.g. a 3D model asset).
 *   - searched   : results auto-saved from an online library search (mesh).
 *   - installed  : capabilities/tools provisioned locally (MCP binaries,
 *                  SKILLs, ComfyUI, LSP servers, plugins).
 *
 * Design:
 *  - In-memory list of `AssetEntry`, newest first.
 *  - Pub/sub via `subscribe*` so React can bind through `useSyncExternalStore`.
 *  - Terminal entries persist to localStorage so history survives a reload;
 *    `pending` entries are never persisted (an in-flight task cannot resume).
 *  - A one-time migration folds the legacy `downloads.v1` history into the new
 *    `assets.v1` store.
 *
 * The registry does NOT perform any work itself — callers open a `pending`
 * entry then mark it succeeded/failed. This keeps transfer/generation logic
 * where it already lives and makes instrumentation a two-line change per site.
 *
 * Backward compatibility: the original Download* API (startDownload,
 * markDownloadDone, ...) is retained as thin wrappers mapping onto the asset
 * model with `source: 'downloaded'`, so existing call sites need no changes.
 */

/** Lifecycle status. `pending` replaces the old `downloading`. */
import { collectTurnArtifacts } from './turnArtifacts';
import { displayFileRefPath } from '@/components/ai/lib/filePath';
import { desktopAssetIndexIO, readAssetIndex, writeAssetIndex, type AssetIndexIO, type AssetIndexSnapshot } from './assetIndex';
import type { TurnFileChanges } from './turnFileChanges';

export type AssetStatus = 'pending' | 'success' | 'error';

/**
 * What the asset *is*. Drives icon, preview style and the "category" filter.
 * `music`/`speech` are kept distinct from the generic `audio` so existing
 * download history keeps its icon, but new code should prefer `audio`.
 */
export type AssetKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'music'
  | 'speech'
  | 'mesh'
  | 'model'
  | 'sprite'
  | 'mcp'
  | 'skill'
  | 'plugin'
  | 'file';

/** How the asset arrived. Drives the "source" filter and the row actions. */
export type AssetSource = 'generated' | 'downloaded' | 'searched' | 'installed' | 'modified' | 'input';

export interface AssetEvent {
  id: string;
  operation: AssetSource | 'referenced';
  at: number;
  sessionId?: string;
  workspaceId?: string | null;
  messageId?: string;
  provenance: 'recorded' | 'answer' | 'inferred';
}

/** Where the asset was produced/fetched from. Lets the UI filter local vs cloud. */
export type AssetOrigin = 'local' | 'remote';

export interface AssetEntry {
  /** Stable id, also used as the React key. */
  id: string;
  /** What the asset is. */
  kind: AssetKind;
  /** How it arrived. */
  source: AssetSource;
  /** Local model/file vs remote provider/url. */
  origin: AssetOrigin;
  /** Human-friendly title (file name, skill name, MCP name…). */
  title: string;
  status: AssetStatus;

  /** Resolved local path once the asset is on disk. */
  localPath?: string;
  /** Original remote address, when the asset came from the network. */
  remoteUrl?: string;
  /** Inline preview/thumbnail (data URL or remote URL) for media assets. */
  previewUrl?: string;
  /** Total bytes on disk, when known. */
  sizeBytes?: number;

  /** Provider/library/tool id this came from (e.g. 'siliconflow', 'sketchfab'). */
  provider?: string;
  /** Generation model, when applicable. */
  model?: string;
  /** Generation prompt/text, enabling a one-click "re-generate". */
  prompt?: string;
  /** Conversation this asset belongs to, to jump back to context. */
  sessionId?: string;
  /** Workspace bucket for the owning conversation. */
  workspaceId?: string | null;
  /** Message that introduced this asset, for precise chat-stream jumps. */
  messageId?: string;

  /** Failure message when `status === 'error'`. */
  error?: string;
  /** Epoch ms when the entry was created. */
  startedAt: number;
  /** Epoch ms when the entry reached a terminal status. */
  finishedAt?: number;
  /** Type-specific extension fields (mesh format, skill targetId, …). */
  meta?: Record<string, unknown>;
  sessionTitle?: string;
  provenance?: AssetEvent['provenance'];
  availability?: 'available' | 'missing' | 'unknown';
  favorite?: boolean;
  tags?: string[];
  events?: AssetEvent[];
}

export function assetMatchesWorkspace(
  entry: Pick<AssetEntry, 'workspaceId' | 'events'>,
  workspaceId: string | null | undefined,
): boolean {
  if (!workspaceId) return true;
  return entry.workspaceId === workspaceId || Boolean(entry.events?.some(event => event.workspaceId === workspaceId));
}

export function isOutputAsset(entry: AssetEntry): boolean {
  return entry.source !== 'input' && entry.source !== 'installed';
}

/* ----------------------------- legacy aliases ----------------------------- */

/** @deprecated Use {@link AssetStatus}. `downloading` maps to `pending`. */
export type DownloadStatus = 'downloading' | 'success' | 'error';

/** @deprecated Use {@link AssetEntry}. Retained for the download-only call sites. */
export interface DownloadEntry {
  id: string;
  fileName: string;
  url?: string;
  path?: string;
  sizeBytes?: number;
  kind: 'model' | 'image' | 'video' | 'music' | 'speech' | 'file';
  status: DownloadStatus;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

const STORAGE_KEY = 'ultragamestudio.assets.v1';
const LEGACY_STORAGE_KEY = 'ultragamestudio.downloads.v1';
/**
 * Path keys the user explicitly cleared from the Asset Hub. The disk-cache poll
 * (`mergeCachedAssetsFromDisk`) would otherwise re-discover the still-on-disk
 * files and resurrect the rows the user just cleared. Persisting the dismissals
 * keeps "清空已完成" sticky across the 15s poll and reloads, while a genuinely
 * new generation at the same path lifts the dismissal so the asset reappears.
 */
const DISMISSED_STORAGE_KEY = 'ultragamestudio.assets.dismissed.v1';
const MAX_PERSISTED = Number.POSITIVE_INFINITY;
const MAX_DISMISSED = 5000;
/**
 * Largest inline `data:` preview we are willing to write to localStorage.
 * Generated media (a 1024px PNG is ~1–2MB as base64) would otherwise blow the
 * ~5MB quota after only a few assets, making the whole history fail to persist.
 * Disk-backed assets can rebuild their preview from `localPath`, so the inline
 * copy is dropped on persist; only small thumbnails / remote URLs are kept.
 */
const MAX_INLINE_PREVIEW_CHARS = 64 * 1024;

let entries: AssetEntry[] = [];
let hydrated = false;
/**
 * Path keys (see {@link pathKey}) the user has cleared. The disk poll skips any
 * file whose path is in this set so cleared assets stay cleared. Hydrated lazily
 * alongside `entries`.
 */
let dismissedPaths = new Set<string>();
const listeners = new Set<() => void>();
let indexIO: AssetIndexIO | null = null;
let indexReady: Promise<void> | null = null;
let indexQueue: Promise<void> = Promise.resolve();
let indexError: string | null = null;
let indexLoaded = false;
let indexRevision = 0;
let pendingIndex: AssetIndexSnapshot | null = null;
let indexWriting = false;
const revivedDuringLoad = new Set<string>();
const removedDuringLoad = new Set<string>();
const assetAliases = new Map<string, string>();
function canonicalAssetId(id: string): string {
  const seen = new Set<string>();
  while (assetAliases.has(id) && !seen.has(id)) { seen.add(id); id = assetAliases.get(id)!; }
  return id;
}

export function getAssetIndexError(): string | null { return indexError; }

/** Awaitable for shutdown/verification; normal writes are serialized. */
export async function flushAssetIndex(): Promise<void> {
  await indexReady;
  for (;;) {
    const queue = indexQueue;
    await queue;
    if (queue === indexQueue) break;
  }
  if (indexError) throw new Error(indexError);
}

function persistIndex(): void {
  if (!indexIO || !indexLoaded) return;
  const io = indexIO;
  pendingIndex = { version: 2 as const, entries: entries.filter(e => e.status !== 'pending').map(trimForPersist), dismissedPaths: [...dismissedPaths] };
  if (indexWriting) return;
  indexWriting = true;
  indexQueue = indexQueue.then(async () => {
    while (pendingIndex) {
      const snapshot = pendingIndex;
      pendingIndex = null;
      await writeAssetIndex(io, snapshot);
      indexError = null;
    }
  }).catch(error => {
    indexError = `资产索引写入失败：${String(error)}`;
    emit();
  }).finally(() => { indexWriting = false; if (pendingIndex) persistIndex(); });
}

export function initializeAssetIndex(io: AssetIndexIO | null = desktopAssetIndexIO()): Promise<void> {
  if (indexReady) return indexReady;
  if (!io) return Promise.resolve();
  indexIO = io;
  hydrate();
  const revision = indexRevision;
  indexReady = (async () => {
    try {
      const saved = await readAssetIndex(io);
      if (saved) {
        const currentById = new Map(entries.map(e => [e.id, e]));
        // Keep registrations/removals made while disk reads were in flight.
        for (const key of saved.dismissedPaths) if (!revivedDuringLoad.has(key)) dismissedPaths.add(key);
        for (const [id, entry] of currentById) {
          if (entry.localPath && dismissedPaths.has(pathKey(entry.localPath))) currentById.delete(id);
        }
        const restored = saved.entries.filter(isAssetEntry).filter(e => !removedDuringLoad.has(e.id) && (!e.localPath || !dismissedPaths.has(pathKey(e.localPath))));
        for (const entry of restored) {
          if (!currentById.has(entry.id)) currentById.set(entry.id, entry);
          else if (revision === indexRevision) currentById.set(entry.id, entry);
        }
        entries = deduplicateAssets(sortAssets([...currentById.values()]));
      } else {
        // Retain the complete legacy payload before the first migration.
        if (!await io.read('assets/migration-v1.json')) {
          await io.write('assets/migration-v1.json', JSON.stringify({ entries: entries.map(trimForPersist), dismissedPaths: [...dismissedPaths] }));
        }
      }
      indexLoaded = true;
      persist();
      emit();
    } catch (error) {
      indexError = `资产索引读取失败：${String(error)}`;
      emit();
    }
  })();
  return indexReady;
}

function normalizeAssetRole(entry: AssetEntry): AssetEntry {
  if (entry.source === 'generated' && !entry.events?.some(event => event.provenance === 'recorded') &&
    /[\\/](?:clipboard-images|session-captures)[\\/]/i.test(entry.localPath ?? '')) {
    return { ...entry, source: 'input' };
  }
  return entry;
}

function deduplicateAssets(list: AssetEntry[]): AssetEntry[] {
  const byKey = new Map<string, AssetEntry>();
  for (const raw of list) {
    const entry = normalizeAssetRole(raw);
    const key = entry.localPath ? `path:${pathKey(entry.localPath)}` : entry.remoteUrl ? `url:${entry.remoteUrl}` : `id:${entry.id}`;
    const old = byKey.get(key);
    if (!old) { assetAliases.delete(entry.id); byKey.set(key, entry); continue; }
    if (entry.id !== old.id) assetAliases.set(entry.id, old.id);
    const events = new Map([...(old.events ?? []), ...(entry.events ?? [])].map(event => [event.id, event]));
    byKey.set(key, {
      ...entry, ...old,
      sessionId: old.sessionId ?? entry.sessionId,
      messageId: old.messageId ?? entry.messageId,
      workspaceId: old.workspaceId ?? entry.workspaceId,
      favorite: old.favorite || entry.favorite,
      tags: [...new Set([...(old.tags ?? []), ...(entry.tags ?? [])])],
      events: [...events.values()].sort((a, b) => b.at - a.at),
    });
  }
  return [...byKey.values()];
}

function entrySortTime(entry: Pick<AssetEntry, 'finishedAt' | 'startedAt'>): number {
  return entry.finishedAt ?? entry.startedAt ?? 0;
}

function sortAssets(list: AssetEntry[]): AssetEntry[] {
  return [...list].sort((a, b) => entrySortTime(b) - entrySortTime(a));
}

function hasStorage(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.localStorage;
  } catch {
    return false;
  }
}

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  if (!hasStorage()) return;
  hydrateDismissed();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        entries = deduplicateAssets(sortAssets(parsed.filter(isAssetEntry)));
        return;
      }
    }
    // No new-format store yet — fold the legacy download history in once.
    migrateLegacyDownloads();
  } catch {
    entries = [];
  }
}

function hydrateDismissed(): void {
  if (!hasStorage()) return;
  try {
    const raw = window.localStorage.getItem(DISMISSED_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      dismissedPaths = new Set(parsed.filter((v): v is string => typeof v === 'string'));
    }
  } catch {
    dismissedPaths = new Set();
  }
}

function persistDismissed(): void {
  if (!hasStorage()) return;
  try {
    const list = [...dismissedPaths].slice(-MAX_DISMISSED);
    window.localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* best-effort */
  }
}

/**
 * Lift a path's dismissal so a freshly produced asset at that path can show up
 * in the hub again. Called whenever a real (non-disk-poll) registration lands a
 * local path. No-op when the path was never dismissed.
 */
function undismissPath(localPath: string | undefined): void {
  if (!localPath) return;
  if (!indexLoaded) revivedDuringLoad.add(pathKey(localPath));
  if (dismissedPaths.delete(pathKey(localPath))) persistDismissed();
}

/** One-time migration of the old `downloads.v1` history into the asset store. */
function migrateLegacyDownloads(): void {
  if (!hasStorage()) return;
  try {
    const legacyRaw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!legacyRaw) return;
    const legacy = JSON.parse(legacyRaw) as unknown;
    if (!Array.isArray(legacy)) return;
    entries = sortAssets(legacy.filter(isLegacyDownloadEntry).map(legacyToAsset));
    persist();
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    /* best-effort migration */
  }
}

function isAssetEntry(value: unknown): value is AssetEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.title === 'string' &&
    typeof entry.kind === 'string' &&
    typeof entry.source === 'string' &&
    typeof entry.status === 'string' &&
    typeof entry.startedAt === 'number'
  );
}

function isLegacyDownloadEntry(value: unknown): value is DownloadEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.fileName === 'string' &&
    typeof entry.status === 'string' &&
    typeof entry.startedAt === 'number'
  );
}

function legacyToAsset(legacy: DownloadEntry): AssetEntry {
  return {
    id: legacy.id,
    kind: legacy.kind === 'model' ? 'mesh' : legacy.kind,
    source: 'downloaded',
    origin: 'remote',
    title: legacy.fileName,
    status: legacy.status === 'downloading' ? 'pending' : legacy.status,
    localPath: legacy.path,
    remoteUrl: legacy.url,
    sizeBytes: legacy.sizeBytes,
    error: legacy.error,
    startedAt: legacy.startedAt,
    finishedAt: legacy.finishedAt,
  };
}

/**
 * Strip an entry's inline `data:` preview when it is too large to persist and a
 * disk-backed copy exists to rebuild it from. Remote (`http(s)`) previews and
 * small inline thumbnails are kept verbatim. Returns the entry unchanged when
 * nothing needs trimming so identity is preserved for the common case.
 */
function trimForPersist(entry: AssetEntry): AssetEntry {
  const preview = entry.previewUrl;
  if (!preview || !preview.startsWith('data:')) return entry;
  if (preview.length <= MAX_INLINE_PREVIEW_CHARS) return entry;
  // Too big to store inline. Drop it: it can be lazily rebuilt from localPath
  // (desktop) on next load. Without a localPath there is nothing to rebuild
  // from, but persisting a multi-MB string would break the whole history.
  return { ...entry, previewUrl: undefined };
}

function persist(): void {
  persistIndex();
  if (!hasStorage()) return;
  try {
    // Only terminal entries are meaningful across reloads; an in-flight
    // task cannot survive a page refresh.
    const terminal = entries
      .filter((entry) => entry.status !== 'pending')
      .slice(0, MAX_PERSISTED)
      .map(trimForPersist);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(terminal));
  } catch {
    /* storage full / unavailable — history is best-effort */
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

function commit(next: AssetEntry[]): void {
  indexRevision += 1;
  entries = deduplicateAssets(sortAssets(next));
  persist();
  emit();
}

function fileNameFromUrl(url: string): string {
  try {
    const clean = url.trim().split(/[?#]/, 1)[0] ?? '';
    const tail = clean.split(/[/\\]/).filter(Boolean).pop();
    return tail || url;
  } catch {
    return url;
  }
}

function pathFromFileUrl(raw: string): string | null {
  if (!/^file:\/\//i.test(raw.trim())) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'file:') return null;
    let path = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    if (url.hostname) path = `//${url.hostname}${path}`;
    return path;
  } catch {
    return null;
  }
}

function normalizeLocalPath(path: string): string {
  return pathFromFileUrl(path) ?? path.trim();
}

function hasLocalDiskPath(path: string | undefined): boolean {
  return Boolean(path && !/^https?:\/\//i.test(path.trim()));
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `as-${Date.now().toString(36)}-${counter.toString(36)}`;
}

/* ------------------------------ subscription ------------------------------ */

/** Subscribe to registry changes. Returns an unsubscribe function. */
export function subscribeAssets(listener: () => void): () => void {
  listeners.add(listener);
  void initializeAssetIndex();
  return () => {
    listeners.delete(listener);
  };
}

/** Snapshot of all entries, newest first. Stable identity until next change. */
export function getAssets(): AssetEntry[] {
  hydrate();
  return entries;
}

/** Index answer links with their exact source message; never fetch the URL. */
export function linkConversationUrls(input: {
  text: string; sessionId: string; workspaceId?: string | null;
  messageId: string; at?: number; sessionTitle?: string;
}): void {
  hydrate();
  const text = input.text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g, '');
  const urls = new Map<string, string>();
  const add = (raw: string, title?: string) => {
    try {
      const url = new URL(raw);
      if (!['http:', 'https:'].includes(url.protocol)) return;
      if (!urls.has(url.href) || title) urls.set(url.href, title?.trim() || url.hostname);
    } catch { /* Ignore incomplete URLs during streaming. */ }
  };
  const withoutMarkdown = text.replace(/(!?)\[([^\]\n]+)\]\(<?(https?:\/\/[^\s>]+?)>?(?:\s+"[^"]*")?\)/g, (_match, image, title, url) => {
    if (!image) add(url, title);
    return '';
  });
  for (const match of withoutMarkdown.matchAll(/https?:\/\/[^\s<>[\]"'`]+/g)) add(match[0].replace(/[.,;!?)，。；！）]+$/, ''));
  const next = [...entries];
  let changed = false;
  for (const [remoteUrl, title] of urls) {
    if (dismissedPaths.has(`link-url:${remoteUrl}`)) continue;
    const id = `link:${input.workspaceId ?? ''}:${input.sessionId}:${remoteUrl}`;
    const eventId = `${id}:${input.messageId}`;
    const index = next.findIndex(entry => !entry.localPath && entry.remoteUrl === remoteUrl);
    if (index >= 0 && next[index].meta?.artifactType !== 'link') continue;
    const at = input.at ?? Date.now();
    if (index >= 0 && next[index].events?.some(event => event.id === eventId)) {
      const previous = next[index];
      const latestTitle = at >= previous.startedAt ? title : previous.title;
      const sessionTitle = input.sessionTitle ?? previous.sessionTitle;
      if (previous.title !== latestTitle || previous.sessionTitle !== sessionTitle) {
        next[index] = { ...previous, title: latestTitle, sessionTitle };
        changed = true;
      }
      continue;
    }
    const event: AssetEvent = { id: eventId, operation: 'referenced', at, sessionId: input.sessionId, workspaceId: input.workspaceId, messageId: input.messageId, provenance: 'answer' };
    const previous = next[index];
    const entry: AssetEntry = {
      ...previous, id: previous?.id ?? id, kind: 'file', source: 'generated', origin: 'remote', status: 'success', remoteUrl,
      title: previous && previous.startedAt > at ? previous.title : title,
      startedAt: Math.max(previous?.startedAt ?? 0, at), finishedAt: Math.max(previous?.finishedAt ?? 0, at),
      sessionId: previous && previous.startedAt > at ? previous.sessionId : input.sessionId,
      workspaceId: previous && previous.startedAt > at ? previous.workspaceId : input.workspaceId,
      messageId: previous && previous.startedAt > at ? previous.messageId : input.messageId,
      sessionTitle: input.sessionTitle ?? previous?.sessionTitle, provenance: 'answer',
      meta: { ...previous?.meta, artifactType: 'link' }, events: [...(previous?.events ?? []), event],
    };
    if (index >= 0) next[index] = entry; else next.push(entry);
    changed = true;
  }
  if (changed) commit(next);
}

/**
 * Fold disk-backed cached files into the registry. This is the durable fallback
 * for assets whose localStorage row was lost while the file still exists under
 * the workspace `.ultragamestudio` cache.
 */
export function mergeCachedAssetsFromDisk(files: CachedAssetFileInput[], workspaceId?: string | null): void {
  hydrate();
  if (!files.length) return;

  const byPath = new Map<string, AssetEntry>();
  const withoutPath: AssetEntry[] = [];
  let changed = false;

  for (const entry of entries) {
    if (!entry.localPath) {
      withoutPath.push(entry);
      continue;
    }
    byPath.set(pathKey(entry.localPath), entry);
  }

  for (const file of files) {
    const localPath = normalizeLocalPath(file.localPath ?? '');
    if (!localPath) continue;
    const key = pathKey(localPath);
    const existing = byPath.get(key);
    // The user cleared this asset; don't resurrect it from disk unless it is
    // still a live row (e.g. re-registered by a fresh generation).
    if (!existing && dismissedPaths.has(key)) continue;
    const diskEntry = diskAssetToEntry({ ...file, localPath, workspaceId: workspaceId ?? file.workspaceId });
    if (!existing) {
      changed = true;
      byPath.set(key, diskEntry);
      continue;
    }
    const merged: AssetEntry = {
      ...existing,
      workspaceId: existing.workspaceId ?? workspaceId ?? file.workspaceId,
      availability: 'available',
      localPath,
      sizeBytes: existing.sizeBytes ?? diskEntry.sizeBytes,
      startedAt: Math.min(existing.startedAt, diskEntry.startedAt),
      finishedAt: Math.max(entrySortTime(existing), entrySortTime(diskEntry)),
    };
    if (merged.workspaceId !== existing.workspaceId || merged.availability !== existing.availability ||
      merged.sizeBytes !== existing.sizeBytes || merged.startedAt !== existing.startedAt || merged.finishedAt !== existing.finishedAt || merged.localPath !== existing.localPath) {
      changed = true;
      byPath.set(key, merged);
    }
  }

  if (changed) commit([...withoutPath, ...byPath.values()]);
}

/** @deprecated Use {@link subscribeAssets}. */
export const subscribeDownloads = subscribeAssets;

/** @deprecated Use {@link getAssets}. Returns the same list typed as assets. */
export const getDownloads = getAssets;

/* -------------------------------- register -------------------------------- */

export interface RegisterAssetInput {
  kind: AssetKind;
  source: AssetSource;
  origin?: AssetOrigin;
  title?: string;
  status?: AssetStatus;
  localPath?: string;
  remoteUrl?: string;
  previewUrl?: string;
  sizeBytes?: number;
  provider?: string;
  model?: string;
  prompt?: string;
  sessionId?: string;
  workspaceId?: string | null;
  messageId?: string;
  error?: string;
  meta?: Record<string, unknown>;
}

export interface CachedAssetFileInput {
  kind: AssetKind;
  source?: AssetSource;
  origin?: AssetOrigin;
  title: string;
  localPath: string;
  sizeBytes?: number;
  createdAtMs?: number | null;
  modifiedAtMs?: number | null;
  workspaceId?: string | null;
}

function pathKey(path: string): string {
  const normalized = normalizeLocalPath(path).replace(/\\/g, '/').replace(/\/+/g, '/');
  if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')) {
    return normalized.toLowerCase();
  }
  return normalized;
}

function diskAssetId(localPath: string): string {
  return `disk:${pathKey(localPath)}`;
}

function diskAssetToEntry(input: CachedAssetFileInput): AssetEntry {
  const localPath = normalizeLocalPath(input.localPath);
  const modifiedAt = input.modifiedAtMs ?? input.createdAtMs ?? Date.now();
  return {
    id: diskAssetId(localPath),
    kind: input.kind,
    source: input.source ?? 'generated',
    origin: input.origin ?? 'local',
    title: input.title.trim() || fileNameFromUrl(localPath),
    status: 'success',
    localPath,
    sizeBytes: input.sizeBytes,
    startedAt: input.createdAtMs ?? modifiedAt,
    finishedAt: modifiedAt,
    workspaceId: input.workspaceId,
    availability: 'available',
  };
}

const IMAGE_EXT = new Set(['png', 'apng', 'jpg', 'jpeg', 'jpe', 'jfif', 'pjpeg', 'pjp', 'gif', 'webp', 'bmp', 'dib', 'ico', 'cur', 'svg', 'avif']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a']);
const MESH_EXT = new Set(['glb', 'gltf', 'obj', 'stl', 'fbx', 'bvh', 'asf', 'amc', 'ply', 'usdz', 'blend']);
const MANAGED_ASSET_EXT = new Set([
  ...IMAGE_EXT,
  ...VIDEO_EXT,
  ...AUDIO_EXT,
  ...MESH_EXT,
  'zip',
  'json',
  'html',
  'htm',
  'md',
  'txt',
  'pdf',
  'doc', 'docx', 'rtf', 'odt', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'tsv', 'markdown',
]);
const MANAGED_ASSET_EXT_BY_LENGTH = [...MANAGED_ASSET_EXT].sort(
  (a, b) => b.length - a.length,
);
const MANAGED_ASSET_TERMINATORS = new Set([
  '"',
  "'",
  '`',
  '<',
  '>',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  ',',
  ';',
  ':',
  '!',
  '?',
  '，',
  '。',
  '；',
  '、',
  '！',
  '？',
]);
const MANAGED_ASSET_PATH_RE =
  /(?:file:\/\/\/)?(?:[A-Za-z]:[/\\]|[/\\]{1,2}|~[/\\]|\$\w+[/\\]|\.[/\\])?[^\s"'`<>()[\]{}]*?\.ultragamestudio[/\\][^\s"'`<>()[\]{}]*?\.(?:jpeg|pjpeg|apng|jfif|webp|avif|gltf|blend|html|jpg|jpe|pjp|gif|bmp|dib|ico|cur|svg|png|mp4|webm|mov|m4v|mp3|wav|ogg|flac|aac|m4a|glb|obj|stl|fbx|bvh|asf|amc|ply|usdz|zip|json|htm|md|txt|pdf|docx?|rtf|odt|xlsx?|pptx?|csv|tsv|markdown)(?=$|[\s"'`<>()[\]{}.,;:!?，。；、！？])/gi;
const ASSET_MESSAGE_LINK_MAX_DISTANCE_MS = 2 * 60 * 60 * 1000;

function extensionFromPath(path: string): string {
  const base = fileNameFromUrl(path);
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function kindForManagedPath(path: string): AssetKind {
  const normalized = path.replace(/\\/g, '/').toLowerCase();
  const ext = extensionFromPath(path);
  if (normalized.includes('/sprite/') || normalized.includes('/sprites/')) return 'sprite';
  if (normalized.includes('/model-assets/') || MESH_EXT.has(ext)) return 'mesh';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  return 'file';
}

function managedAssetPathEndIndex(path: string): number | null {
  const lower = path.toLowerCase();
  const freeIdx = lower.indexOf('.ultragamestudio');
  const start = freeIdx >= 0 ? freeIdx + '.ultragamestudio'.length : 0;

  for (let i = start; i < lower.length; i += 1) {
    if (lower[i] !== '.') continue;
    for (const ext of MANAGED_ASSET_EXT_BY_LENGTH) {
      if (!lower.startsWith(ext, i + 1)) continue;
      const endIndex = i + 1 + ext.length;
      const next = path[endIndex];
      if (
        next === undefined ||
        /\s/u.test(next) ||
        MANAGED_ASSET_TERMINATORS.has(next)
      ) {
        return endIndex;
      }
    }
  }

  return null;
}

function trimAssetPathToken(path: string): string {
  let raw = path.trim();
  const fileUrlIdx = raw.toLowerCase().lastIndexOf('file:///');
  if (fileUrlIdx > 0) raw = raw.slice(fileUrlIdx);
  const driveMatch = /[A-Za-z]:[/\\]/.exec(raw);
  if (driveMatch && driveMatch.index > 0) raw = raw.slice(driveMatch.index);
  const normalized = normalizeLocalPath(raw).trim();
  const endIndex = managedAssetPathEndIndex(normalized);
  const clipped = endIndex == null ? normalized : normalized.slice(0, endIndex);
  return clipped.replace(/[.,;:!?，。；、！？]+$/u, '');
}

export function managedAssetPathsFromText(text: string): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const match of text.matchAll(MANAGED_ASSET_PATH_RE)) {
    const path = trimAssetPathToken(match[0] ?? '');
    if (!path) continue;
    const key = pathKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(path);
  }
  return paths;
}

export interface LinkLocalAssetToMessageInput {
  localPath: string;
  sessionId?: string | null;
  workspaceId?: string | null;
  messageId?: string | null;
  title?: string;
  kind?: AssetKind;
  source?: AssetSource;
  provenance?: AssetEvent['provenance'];
  at?: number;
  sessionTitle?: string;
}

export function linkLocalAssetToMessage(input: LinkLocalAssetToMessageInput): void {
  const sessionId = input.sessionId?.trim();
  const messageId = input.messageId?.trim();
  if (!sessionId || !messageId) return;
  const localPath = normalizeLocalPath(input.localPath);
  if (!localPath) return;
  hydrate();

  const key = pathKey(localPath);
  const title = input.title?.trim() || fileNameFromUrl(localPath);
  const kind = input.kind ?? kindForManagedPath(localPath);
  const now = Date.now();
  const existingIndex = entries.findIndex(
    (entry) => entry.localPath && pathKey(entry.localPath) === key,
  );
  const operation = input.source ?? (existingIndex >= 0 ? 'referenced' : 'generated');
  const event: AssetEvent = { id: `${sessionId}:${messageId}:${operation}`, operation, at: input.at ?? now, sessionId, messageId, workspaceId: input.workspaceId, provenance: input.provenance ?? 'answer' };

  if (existingIndex >= 0) {
    const existing = entries[existingIndex];
    if (!input.source && existing.events?.some(e => e.sessionId === sessionId && e.messageId === messageId)) {
      if (input.sessionTitle && existing.sessionId === sessionId && existing.sessionTitle !== input.sessionTitle) updateAssetDetails(existing.id, { sessionTitle: input.sessionTitle });
      return;
    }
    if (existing.events?.some(e => e.id === event.id) && (!input.sessionTitle || existing.sessionTitle === input.sessionTitle)) return;
    commit(
      entries.map((entry, index) =>
        index === existingIndex
          ? {
              ...entry,
              kind: entry.kind ?? kind,
              title: entry.title || title,
              localPath,
              ...(!entry.events?.length || event.at >= entry.events[0].at ? { sessionId, workspaceId: input.workspaceId ?? null, messageId, source: input.source ?? entry.source, provenance: event.provenance, sessionTitle: input.sessionTitle ?? entry.sessionTitle } : {}),
              events: [event, ...(entry.events ?? []).filter(e => e.id !== event.id)].sort((a, b) => b.at - a.at),
              status: entry.status === 'pending' ? entry.status : 'success',
              finishedAt: entry.finishedAt ?? now,
            }
          : entry,
      ),
    );
    return;
  }

  // Don't recreate an asset the user cleared just because an old chat message
  // still references its path.
  if (dismissedPaths.has(key)) return;

  commit([
    {
      id: diskAssetId(localPath),
      kind,
      source: input.source ?? 'generated',
      origin: 'local',
      title,
      status: 'success',
      localPath,
      sessionId,
      workspaceId: input.workspaceId ?? null,
      messageId,
      startedAt: input.at ?? now,
      finishedAt: input.at ?? now,
      provenance: event.provenance,
      sessionTitle: input.sessionTitle,
      events: [event],
      availability: 'unknown',
    },
    ...entries,
  ]);
}

export function linkManagedAssetsFromMessageText(input: {
  text: string;
  sessionId?: string | null;
  workspaceId?: string | null;
  messageId?: string | null;
  cwd?: string;
  at?: number;
  sessionTitle?: string;
}): void {
  const paths = new Map<string, { path: string; title?: string }>();
  for (const artifact of collectTurnArtifacts(input.text, input.cwd)) {
    const path = displayFileRefPath(artifact.ref, input.cwd);
    paths.set(pathKey(path), { path, title: artifact.label });
  }
  for (const { path: localPath, title } of paths.values()) {
    // A clipboard input mentioned by an answer remains an input.
    if (/[\\/](?:clipboard-images|session-captures)[\\/]/i.test(localPath)) continue;
    linkLocalAssetToMessage({
      localPath,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      messageId: input.messageId,
      title,
      at: input.at,
      sessionTitle: input.sessionTitle,
    });
  }
}

/** Confirmed successful file changes, including project files outside caches. */
export function linkModifiedAssetsFromMessage(input: {
  changes?: TurnFileChanges;
  sessionId: string;
  workspaceId?: string | null;
  messageId: string;
  at?: number;
  sessionTitle?: string;
}): void {
  for (const file of input.changes?.files ?? []) {
    if (file.status === 'deleted') continue;
    const root = input.changes?.rootPath;
    const path = root && !/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(file.path)
      ? `${root.replace(/[\\/]+$/, '')}/${file.path.replace(/^\.\//, '')}` : file.path;
    linkLocalAssetToMessage({ ...input, localPath: path, source: file.status === 'added' ? 'generated' : 'modified', provenance: 'recorded' });
  }
}

export function updateAssetDetails(id: string, patch: Pick<AssetEntry, 'favorite' | 'tags' | 'availability' | 'sessionTitle'>): void {
  hydrate();
  id = canonicalAssetId(id);
  commit(entries.map(entry => entry.id === id ? { ...entry, ...patch,
    ...(patch.tags ? { tags: [...new Set(patch.tags.map(tag => tag.trim()).filter(Boolean))] } : {}) } : entry));
}

export function linkKnownManagedAssetsFromMessageText(input: {
  text: string;
  sessionId?: string | null;
  workspaceId?: string | null;
  messageId?: string | null;
}): void {
  const sessionId = input.sessionId?.trim();
  const messageId = input.messageId?.trim();
  if (!sessionId || !messageId) return;
  hydrate();
  const knownUnlinkedPaths = new Set(
    entries
      .filter((entry) => entry.localPath && !entry.sessionId)
      .map((entry) => pathKey(entry.localPath as string)),
  );
  if (knownUnlinkedPaths.size === 0) return;

  for (const localPath of managedAssetPathsFromText(input.text)) {
    if (!knownUnlinkedPaths.has(pathKey(localPath))) continue;
    linkLocalAssetToMessage({
      localPath,
      sessionId,
      workspaceId: input.workspaceId,
      messageId,
    });
  }
}

export interface AssetMessageLinkCandidate {
  sessionId?: string | null;
  workspaceId?: string | null;
  messageId?: string | null;
  role?: 'user' | 'assistant' | 'system';
  createdAt?: number | null;
}

interface NormalizedAssetMessageLinkCandidate {
  sessionId: string;
  workspaceId: string | null;
  messageId: string;
  role?: 'user' | 'assistant' | 'system';
  createdAt: number;
}

function finiteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function assetLinkTimes(entry: AssetEntry): number[] {
  const times = [entry.startedAt, entry.finishedAt].filter(finiteTimestamp);
  return [...new Set(times)];
}

function assetCanBelongToSession(entry: AssetEntry): boolean {
  return entry.source !== 'installed' && entry.source !== 'input';
}

function messageRolePenalty(role: AssetMessageLinkCandidate['role']): number {
  if (role === 'assistant') return 0;
  if (role === 'user') return 5_000;
  return 15_000;
}

function workspaceCompatible(
  entry: AssetEntry,
  candidate: NormalizedAssetMessageLinkCandidate,
): boolean {
  if (entry.workspaceId == null) return true;
  return candidate.workspaceId === entry.workspaceId;
}

function sessionCompatible(
  entry: AssetEntry,
  candidate: NormalizedAssetMessageLinkCandidate,
): boolean {
  if (!entry.sessionId) return true;
  return candidate.sessionId === entry.sessionId;
}

function messageCompatible(
  entry: AssetEntry,
  candidate: NormalizedAssetMessageLinkCandidate,
): boolean {
  if (!entry.messageId) return true;
  return candidate.messageId === entry.messageId;
}

/**
 * Link already-known assets to the nearest chat message by timestamp.
 *
 * This is the recovery path for durable cache files discovered from disk after
 * their localStorage row was lost, and for older generated images whose chat
 * markdown only contained an inline/remote preview rather than the final local
 * `.ultragamestudio` path.
 */
export function linkKnownAssetsToNearestMessages(input: {
  messages: AssetMessageLinkCandidate[];
  maxDistanceMs?: number;
}): void {
  const candidates: NormalizedAssetMessageLinkCandidate[] = [];
  for (const message of input.messages) {
    const sessionId = message.sessionId?.trim();
    const messageId = message.messageId?.trim();
    if (!sessionId || !messageId || !finiteTimestamp(message.createdAt)) continue;
    candidates.push({
      sessionId,
      workspaceId: message.workspaceId ?? null,
      messageId,
      role: message.role,
      createdAt: message.createdAt,
    });
  }
  if (candidates.length === 0) return;

  hydrate();
  const maxDistanceMs =
    input.maxDistanceMs ?? ASSET_MESSAGE_LINK_MAX_DISTANCE_MS;
  let changed = false;

  const next = entries.map((entry) => {
    if (!assetCanBelongToSession(entry)) return entry;
    if (entry.workspaceId == null && !entry.sessionId) return entry;
    if (entry.sessionId && entry.messageId) return entry;
    const times = assetLinkTimes(entry);
    if (times.length === 0) return entry;

    let best:
      | {
          candidate: (typeof candidates)[number];
          distance: number;
          score: number;
        }
      | null = null;

    for (const candidate of candidates) {
      if (!workspaceCompatible(entry, candidate)) continue;
      if (!sessionCompatible(entry, candidate)) continue;
      if (!messageCompatible(entry, candidate)) continue;
      const distance = Math.min(
        ...times.map((time) => Math.abs(time - candidate.createdAt)),
      );
      if (distance > maxDistanceMs) continue;
      const score = distance + messageRolePenalty(candidate.role);
      if (!best || score < best.score) {
        best = { candidate, distance, score };
      }
    }

    if (!best) return entry;
    changed = true;
    return {
      ...entry,
      sessionId: entry.sessionId ?? best.candidate.sessionId,
      workspaceId: entry.workspaceId ?? best.candidate.workspaceId ?? null,
      messageId: entry.messageId ?? best.candidate.messageId,
      provenance: 'inferred' as const,
    };
  });

  if (changed) commit(next);
}

/**
 * Register an asset. When `status` is omitted it defaults to `pending` so the
 * caller can later mark it terminal with {@link markAssetDone} /
 * {@link markAssetFailed}; pass a terminal status to record a finished asset in
 * one shot (e.g. an installed SKILL). Returns the entry id.
 */
export function registerAsset(input: RegisterAssetInput): string {
  hydrate();
  const id = nextId();
  const status = input.status ?? 'pending';
  const localPath = input.localPath ? normalizeLocalPath(input.localPath) : undefined;
  const origin =
    hasLocalDiskPath(localPath) ? 'local' : (input.origin ?? (input.remoteUrl ? 'remote' : 'local'));
  // A new registration at a previously-cleared path means the user produced a
  // fresh asset there; let it surface again.
  undismissPath(localPath);
  const title =
    input.title?.trim() ||
    (input.remoteUrl ? fileNameFromUrl(input.remoteUrl) : '') ||
    (localPath ? fileNameFromUrl(localPath) : '') ||
    '资产';
  const entry: AssetEntry = {
    id,
    kind: input.kind,
    source: input.source,
    origin,
    title,
    status,
    localPath,
    remoteUrl: input.remoteUrl,
    previewUrl: input.previewUrl,
    sizeBytes: input.sizeBytes,
    provider: input.provider,
    model: input.model,
    prompt: input.prompt,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    messageId: input.messageId,
    error: input.error,
    startedAt: Date.now(),
    finishedAt: status === 'pending' ? undefined : Date.now(),
    meta: input.meta,
    provenance: 'recorded',
    availability: localPath ? 'unknown' : undefined,
    events: [{ id: `${id}:produced`, operation: input.source, at: Date.now(), sessionId: input.sessionId, workspaceId: input.workspaceId, messageId: input.messageId, provenance: 'recorded' }],
  };
  commit([entry, ...entries]);
  return entries.find(e => localPath ? e.localPath && pathKey(e.localPath) === pathKey(localPath) : e.id === id)?.id ?? id;
}

export interface MarkAssetDoneInput {
  localPath?: string;
  remoteUrl?: string;
  previewUrl?: string;
  sizeBytes?: number;
  title?: string;
  meta?: Record<string, unknown>;
}

/** Mark a pending asset as completed. */
export function markAssetDone(id: string, result?: MarkAssetDoneInput): void {
  hydrate();
  id = canonicalAssetId(id);
  const localPath = result?.localPath ? normalizeLocalPath(result.localPath) : undefined;
  if (localPath) undismissPath(localPath);
  commit(
    entries.map((entry) =>
      entry.id === id
        ? {
            ...entry,
            status: 'success',
            origin: hasLocalDiskPath(localPath ?? entry.localPath) ? 'local' : entry.origin,
            localPath: localPath ?? entry.localPath,
            remoteUrl: result?.remoteUrl ?? entry.remoteUrl,
            previewUrl: result?.previewUrl ?? entry.previewUrl,
            sizeBytes: result?.sizeBytes ?? entry.sizeBytes,
            title: result?.title?.trim() || entry.title,
            meta: result?.meta ?? entry.meta,
            finishedAt: Date.now(),
          }
        : entry,
    ),
  );
}

/** Mark a pending asset as failed. */
export function markAssetFailed(id: string, error: string): void {
  hydrate();
  id = canonicalAssetId(id);
  commit(
    entries.map((entry) =>
      entry.id === id
        ? { ...entry, status: 'error', error, finishedAt: Date.now() }
        : entry,
    ),
  );
}

/** Remove a single entry. Its disk path is dismissed so the poll won't re-add it. */
export function removeAsset(id: string): void {
  hydrate();
  id = canonicalAssetId(id);
  const target = entries.find((entry) => entry.id === id);
  if (!indexLoaded) removedDuringLoad.add(id);
  if (target?.localPath) {
    dismissedPaths.add(pathKey(target.localPath));
    persistDismissed();
  }
  if (target?.meta?.artifactType === 'link' && target.remoteUrl) {
    dismissedPaths.add(`link-url:${target.remoteUrl}`);
    persistDismissed();
  }
  commit(entries.filter((entry) => entry.id !== id));
}

/** Clear terminal entries matched by `predicate`, keeping anything still pending. */
export function clearFinishedAssets(
  predicate: (entry: AssetEntry) => boolean = () => true,
): void {
  hydrate();
  let changed = false;
  for (const entry of entries) {
    if (!indexLoaded && entry.status !== 'pending' && predicate(entry)) removedDuringLoad.add(entry.id);
    if (entry.status !== 'pending' && predicate(entry) && entry.meta?.artifactType === 'link' && entry.remoteUrl) {
      dismissedPaths.add(`link-url:${entry.remoteUrl}`);
      changed = true;
    }
    if (entry.status !== 'pending' && predicate(entry) && entry.localPath) {
      dismissedPaths.add(pathKey(entry.localPath));
      changed = true;
    }
  }
  if (changed) persistDismissed();
  commit(
    entries.filter(
      (entry) => entry.status === 'pending' || !predicate(entry),
    ),
  );
}

/** @deprecated Use {@link removeAsset}. */
export const removeDownload = removeAsset;

/** @deprecated Use {@link clearFinishedAssets}. */
export const clearFinishedDownloads = clearFinishedAssets;

export interface StartDownloadInput {
  fileName?: string;
  url?: string;
  kind?: DownloadEntry['kind'];
  sessionId?: string;
  workspaceId?: string | null;
  messageId?: string;
}

/**
 * @deprecated Prefer {@link registerAsset}. Register a new in-flight download
 * and return its id. Callers mark it terminal with `markDownloadDone` /
 * `markDownloadFailed`.
 */
export function startDownload(input: StartDownloadInput): string {
  return registerAsset({
    kind: input.kind === 'model' ? 'mesh' : (input.kind ?? 'file'),
    source: 'downloaded',
    origin: 'remote',
    title: input.fileName,
    remoteUrl: input.url,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    messageId: input.messageId,
  });
}

/** @deprecated Prefer {@link markAssetDone}. */
export function markDownloadDone(
  id: string,
  result?: { path?: string; sizeBytes?: number; fileName?: string },
): void {
  markAssetDone(id, {
    localPath: result?.path,
    sizeBytes: result?.sizeBytes,
    title: result?.fileName,
  });
}

/** @deprecated Prefer {@link markAssetFailed}. */
export function markDownloadFailed(id: string, error: string): void {
  markAssetFailed(id, error);
}

/**
 * @deprecated Prefer {@link trackAsset}. Convenience helper for one-shot
 * tracking around a download promise.
 */
export async function trackDownload<T>(
  input: StartDownloadInput,
  run: () => Promise<T>,
  resolve?: (value: T) => { path?: string; sizeBytes?: number; fileName?: string },
): Promise<T> {
  const id = startDownload(input);
  try {
    const value = await run();
    markDownloadDone(id, resolve?.(value));
    return value;
  } catch (err) {
    markDownloadFailed(id, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

/** Convenience helper for one-shot tracking around an async asset task. */
export async function trackAsset<T>(
  input: RegisterAssetInput,
  run: () => Promise<T>,
  resolve?: (value: T) => MarkAssetDoneInput,
): Promise<T> {
  const id = registerAsset(input);
  try {
    const value = await run();
    markAssetDone(id, resolve?.(value));
    return value;
  } catch (err) {
    markAssetFailed(id, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

/** Test-only: reset all state. */
export function __resetDownloadsForTest(): void {
  indexIO = null;
  indexReady = null;
  indexQueue = Promise.resolve();
  indexError = null;
  indexLoaded = false;
  indexRevision = 0;
  pendingIndex = null;
  indexWriting = false;
  revivedDuringLoad.clear();
  removedDuringLoad.clear();
  assetAliases.clear();
  entries = [];
  dismissedPaths = new Set();
  hydrated = false;
  counter = 0;
  listeners.clear();
  if (hasStorage()) {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
      window.localStorage.removeItem(LEGACY_STORAGE_KEY);
      window.localStorage.removeItem(DISMISSED_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }
}

/** Test-only alias. */
export const __resetAssetsForTest = __resetDownloadsForTest;
