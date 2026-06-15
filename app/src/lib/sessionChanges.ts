import {
  ensureWorkspaceChangesBaseline,
  listWorkspaceChanges,
  readWorkspaceChangesCache,
  type WorkspaceChanges,
} from './tauri';

const SESSION_CHANGES_CACHE_PREFIX = 'freeultracode.sessionChanges.v5:';
const SESSION_CHANGES_CACHE_KEY_VERSION = 'v5';
export const SESSION_CHANGES_UPDATED_EVENT = 'freeultracode:session-changes-updated';

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
  try {
    window.localStorage.setItem(key, JSON.stringify(snapshot));
    window.dispatchEvent(
      new CustomEvent(SESSION_CHANGES_UPDATED_EVENT, {
        detail: { cacheKey, rootPath: snapshot.rootPath },
      }),
    );
  } catch {
    /* ignore cache quota errors */
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
  if (snapshot) writeCachedSessionChanges(cacheKey, snapshot);
  return snapshot;
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
