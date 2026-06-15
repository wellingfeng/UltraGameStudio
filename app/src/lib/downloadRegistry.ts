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
const MAX_PERSISTED = 1000;
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
const listeners = new Set<() => void>();

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
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        entries = sortAssets(parsed.filter(isAssetEntry));
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
  entries = sortAssets(next);
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

/**
 * Fold disk-backed cached files into the registry. This is the durable fallback
 * for assets whose localStorage row was lost while the file still exists under
 * the workspace `.freeultracode` cache.
 */
export function mergeCachedAssetsFromDisk(files: CachedAssetFileInput[]): void {
  hydrate();
  if (!files.length) return;

  const byPath = new Map<string, AssetEntry>();
  const withoutPath: AssetEntry[] = [];

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
    const diskEntry = diskAssetToEntry({ ...file, localPath });
    if (!existing) {
      byPath.set(key, diskEntry);
      continue;
    }
    byPath.set(key, {
      ...existing,
      status: existing.status === 'pending' ? existing.status : 'success',
      localPath,
      sizeBytes: existing.sizeBytes ?? diskEntry.sizeBytes,
      startedAt: Math.min(existing.startedAt, diskEntry.startedAt),
      finishedAt: Math.max(entrySortTime(existing), entrySortTime(diskEntry)),
    });
  }

  commit([...withoutPath, ...byPath.values()]);
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
  };
}

const IMAGE_EXT = new Set(['png', 'apng', 'jpg', 'jpeg', 'jpe', 'jfif', 'pjpeg', 'pjp', 'gif', 'webp', 'bmp', 'dib', 'ico', 'cur', 'svg', 'avif']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a']);
const MESH_EXT = new Set(['glb', 'gltf', 'obj', 'stl', 'fbx', 'ply', 'usdz', 'blend']);
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
  /(?:file:\/\/\/)?(?:[A-Za-z]:[/\\]|[/\\]{1,2}|~[/\\]|\$\w+[/\\]|\.[/\\])?[^\s"'`<>()[\]{}]*?\.freeultracode[/\\][^\s"'`<>()[\]{}]*?\.(?:jpeg|pjpeg|apng|jfif|webp|avif|gltf|blend|html|jpg|jpe|pjp|gif|bmp|dib|ico|cur|svg|png|mp4|webm|mov|m4v|mp3|wav|ogg|flac|aac|m4a|glb|obj|stl|fbx|ply|usdz|zip|json|htm|md|txt|pdf)(?=$|[\s"'`<>()[\]{}.,;:!?，。；、！？])/gi;

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
  const freeIdx = lower.indexOf('.freeultracode');
  const start = freeIdx >= 0 ? freeIdx + '.freeultracode'.length : 0;

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

  if (existingIndex >= 0) {
    commit(
      entries.map((entry, index) =>
        index === existingIndex
          ? {
              ...entry,
              kind: entry.kind ?? kind,
              title: entry.title || title,
              localPath,
              sessionId,
              workspaceId: input.workspaceId ?? null,
              messageId,
              status: entry.status === 'pending' ? entry.status : 'success',
              finishedAt: entry.finishedAt ?? now,
            }
          : entry,
      ),
    );
    return;
  }

  commit([
    {
      id: diskAssetId(localPath),
      kind,
      source: 'generated',
      origin: 'local',
      title,
      status: 'success',
      localPath,
      sessionId,
      workspaceId: input.workspaceId ?? null,
      messageId,
      startedAt: now,
      finishedAt: now,
    },
    ...entries,
  ]);
}

export function linkManagedAssetsFromMessageText(input: {
  text: string;
  sessionId?: string | null;
  workspaceId?: string | null;
  messageId?: string | null;
}): void {
  for (const localPath of managedAssetPathsFromText(input.text)) {
    linkLocalAssetToMessage({
      localPath,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      messageId: input.messageId,
    });
  }
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
  const title =
    input.title?.trim() ||
    (input.remoteUrl ? fileNameFromUrl(input.remoteUrl) : '') ||
    (localPath ? fileNameFromUrl(localPath) : '') ||
    '资产';
  const entry: AssetEntry = {
    id,
    kind: input.kind,
    source: input.source,
    origin: input.origin ?? (input.remoteUrl ? 'remote' : 'local'),
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
            localPath: result?.localPath ? normalizeLocalPath(result.localPath) : entry.localPath,
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
