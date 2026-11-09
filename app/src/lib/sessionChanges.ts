import { invoke } from '@tauri-apps/api/core';
import {
  ensureWorkspaceChangesBaseline,
  listWorkspaceChanges,
  readWorkspaceChangesCache,
  tauriAvailable,
  type WorkspaceChanges,
} from './tauri';

const SESSION_CHANGES_CACHE_PREFIX = 'ultragamestudio.sessionChanges.v5:';
const SESSION_CHANGES_CACHE_KEY_VERSION = 'v5';
const memoryCache = new Map<string, WorkspaceChanges>();
const MEMORY_CACHE_LIMIT = 20;
export const SESSION_CHANGES_UPDATED_EVENT = 'ultragamestudio:session-changes-updated';

export function sessionChangesCacheKey(
  workspaceId: string | null | undefined,
  sessionId: string | null | undefined,
  rootPath?: string | null,
): string | null {
  if (!workspaceId || !sessionId) return null;
  const root = rootPath?.trim().replace(/\\/g, '/').replace(/\/+$/g, '');
  return root
    ? `${SESSION_CHANGES_CACHE_KEY_VERSION}:${workspaceId}:${sessionId}:${root}`
    : `${SESSION_CHANGES_CACHE_KEY_VERSION}:${workspaceId}:${sessionId}`;
}

function localStorageKey(cacheKey: string | null): string | null {
  return cacheKey ? `${SESSION_CHANGES_CACHE_PREFIX}${cacheKey}` : null;
}

export function readCachedSessionChanges(cacheKey: string | null): WorkspaceChanges | null {
  const key = localStorageKey(cacheKey);
  if (!key || typeof window === 'undefined') return null;
  if (memoryCache.has(key)) return memoryCache.get(key)!;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WorkspaceChanges;
    if (!parsed || !Array.isArray(parsed.files)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCachedSessionChanges(cacheKey: string | null, snapshot: WorkspaceChanges): void {
  const key = localStorageKey(cacheKey);
  if (!key || typeof window === 'undefined') return;
  memoryCache.delete(key);
  memoryCache.set(key, snapshot);
  if (memoryCache.size > MEMORY_CACHE_LIMIT) memoryCache.delete(memoryCache.keys().next().value!);
  if (!tauriAvailable()) {
    try { window.localStorage.setItem(key, JSON.stringify(snapshot)); } catch { /* browser cache is best effort */ }
  }
  window.dispatchEvent(
    new CustomEvent(SESSION_CHANGES_UPDATED_EVENT, {
      detail: { cacheKey, rootPath: snapshot.rootPath },
    }),
  );
}

async function archivedCachePath(cacheKey: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(cacheKey));
  return `session-changes-archive/${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')}.json`;
}

async function readArchivedSessionChanges(cacheKey: string): Promise<WorkspaceChanges | null> {
  const relPath = await archivedCachePath(cacheKey);
  const raw = await invoke<string | null>('history_read_json', { relPath });
  if (!raw) return null;
  const saved = JSON.parse(raw) as { cacheKey?: string; snapshot?: WorkspaceChanges };
  if (saved.cacheKey !== cacheKey || !saved.snapshot || !Array.isArray(saved.snapshot.files)) throw new Error('归档格式无效');
  return saved.snapshot;
}

// Archive old browser copies first; remove only after exact disk verification.
export async function prunePersistedSessionChangesCache(): Promise<void> {
  if (!tauriAvailable() || typeof window === 'undefined') return;
  let keys: string[];
  try {
    keys = Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i))
      .filter((key): key is string => !!key && key.startsWith(SESSION_CHANGES_CACHE_PREFIX));
  } catch { return; }
  for (const key of keys) {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) continue;
      const local = JSON.parse(raw) as WorkspaceChanges;
      if (!local || typeof local.rootPath !== 'string' || !Array.isArray(local.files)) continue;
      const cacheKey = key.slice(SESSION_CHANGES_CACHE_PREFIX.length);
      const disk = await readWorkspaceChangesCache(local.rootPath, cacheKey);
      let verified = !!disk && JSON.stringify(disk) === JSON.stringify(local);
      if (!verified) {
        const relPath = await archivedCachePath(cacheKey);
        const json = JSON.stringify({ cacheKey, snapshot: local });
        const existing = await invoke<string | null>('history_read_json', { relPath });
        if (existing === null) await invoke('history_write_json', { relPath, json });
        const restored = await invoke<string | null>('history_read_json', { relPath });
        verified = restored === json;
      }
      if (verified && window.localStorage.getItem(key) === raw) window.localStorage.removeItem(key);
    } catch { /* Preserve unreadable or unavailable entries. */ }
  }
}

export async function ensureCachedSessionChangesBaseline(
  rootPath: string,
  cacheKey: string | null,
  baselineAtMs?: number | null,
): Promise<void> {
  if (!rootPath || !cacheKey) return;
  await ensureWorkspaceChangesBaseline(rootPath, cacheKey, baselineAtMs);
}

export async function readPersistedSessionChanges(
  rootPath: string,
  cacheKey: string | null,
): Promise<WorkspaceChanges | null> {
  const local = readCachedSessionChanges(cacheKey);
  if (local) return local;
  if (!rootPath || !cacheKey) return null;
  const snapshot = await readWorkspaceChangesCache(rootPath, cacheKey);
  let archived: WorkspaceChanges | null = null;
  if (tauriAvailable()) {
    try { archived = await readArchivedSessionChanges(cacheKey); } catch { /* Continue with the workspace copy. */ }
  }
  const latest = archived && (!snapshot || archived.generatedAtMs > snapshot.generatedAtMs) ? archived : snapshot;
  if (latest) writeCachedSessionChanges(cacheKey, latest);
  return latest;
}

export async function refreshCachedSessionChanges(
  rootPath: string,
  cacheKey: string | null,
  baselineAtMs?: number | null,
): Promise<WorkspaceChanges> {
  if (!rootPath || !cacheKey) {
    throw new Error('缺少工作区或会话。');
  }
  const snapshot = await listWorkspaceChanges(rootPath, cacheKey, baselineAtMs);
  writeCachedSessionChanges(cacheKey, snapshot);
  return snapshot;
}
