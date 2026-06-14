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
export type AssetSource = 'generated' | 'downloaded' | 'searched' | 'installed';

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

  /** Failure message when `status === 'error'`. */
  error?: string;
  /** Epoch ms when the entry was created. */
  startedAt: number;
  /** Epoch ms when the entry reached a terminal status. */
  finishedAt?: number;
  /** Type-specific extension fields (mesh format, skill targetId, …). */
  meta?: Record<string, unknown>;
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

const STORAGE_KEY = 'freeultracode.assets.v1';
const LEGACY_STORAGE_KEY = 'freeultracode.downloads.v1';
const MAX_PERSISTED = 200;

let entries: AssetEntry[] = [];
let hydrated = false;
const listeners = new Set<() => void>();

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
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        entries = parsed.filter(isAssetEntry);
        return;
      }
    }
    // No new-format store yet — fold the legacy download history in once.
    migrateLegacyDownloads();
  } catch {
    entries = [];
  }
}

/** One-time migration of the old `downloads.v1` history into the asset store. */
function migrateLegacyDownloads(): void {
  if (!hasStorage()) return;
  try {
    const legacyRaw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!legacyRaw) return;
    const legacy = JSON.parse(legacyRaw) as unknown;
    if (!Array.isArray(legacy)) return;
    entries = legacy
      .filter(isLegacyDownloadEntry)
      .map(legacyToAsset);
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

function persist(): void {
  if (!hasStorage()) return;
  try {
    // Only terminal entries are meaningful across reloads; an in-flight
    // task cannot survive a page refresh.
    const terminal = entries
      .filter((entry) => entry.status !== 'pending')
      .slice(0, MAX_PERSISTED);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(terminal));
  } catch {
    /* storage full / unavailable — history is best-effort */
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

function commit(next: AssetEntry[]): void {
  entries = next;
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

let counter = 0;
function nextId(): string {
  counter += 1;
  return `as-${Date.now().toString(36)}-${counter.toString(36)}`;
}

/* ------------------------------ subscription ------------------------------ */

/** Subscribe to registry changes. Returns an unsubscribe function. */
export function subscribeAssets(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Snapshot of all entries, newest first. Stable identity until next change. */
export function getAssets(): AssetEntry[] {
  hydrate();
  return entries;
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
  error?: string;
  meta?: Record<string, unknown>;
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
  const title =
    input.title?.trim() ||
    (input.remoteUrl ? fileNameFromUrl(input.remoteUrl) : '') ||
    (input.localPath ? fileNameFromUrl(input.localPath) : '') ||
    '资产';
  const entry: AssetEntry = {
    id,
    kind: input.kind,
    source: input.source,
    origin: input.origin ?? (input.remoteUrl ? 'remote' : 'local'),
    title,
    status,
    localPath: input.localPath,
    remoteUrl: input.remoteUrl,
    previewUrl: input.previewUrl,
    sizeBytes: input.sizeBytes,
    provider: input.provider,
    model: input.model,
    prompt: input.prompt,
    sessionId: input.sessionId,
    error: input.error,
    startedAt: Date.now(),
    finishedAt: status === 'pending' ? undefined : Date.now(),
    meta: input.meta,
  };
  commit([entry, ...entries]);
  return id;
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
  commit(
    entries.map((entry) =>
      entry.id === id
        ? {
            ...entry,
            status: 'success',
            localPath: result?.localPath ?? entry.localPath,
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
  commit(
    entries.map((entry) =>
      entry.id === id
        ? { ...entry, status: 'error', error, finishedAt: Date.now() }
        : entry,
    ),
  );
}

/** Remove a single entry (terminal entries only; pending ones are ignored). */
export function removeAsset(id: string): void {
  hydrate();
  commit(entries.filter((entry) => entry.id !== id));
}

/** Clear every terminal entry, keeping anything still pending. */
export function clearFinishedAssets(): void {
  hydrate();
  commit(entries.filter((entry) => entry.status === 'pending'));
}

/** @deprecated Use {@link removeAsset}. */
export const removeDownload = removeAsset;

/** @deprecated Use {@link clearFinishedAssets}. */
export const clearFinishedDownloads = clearFinishedAssets;

export interface StartDownloadInput {
  fileName?: string;
  url?: string;
  kind?: DownloadEntry['kind'];
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
  entries = [];
  hydrated = false;
  counter = 0;
  listeners.clear();
  if (hasStorage()) {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
      window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }
}

/** Test-only alias. */
export const __resetAssetsForTest = __resetDownloadsForTest;
