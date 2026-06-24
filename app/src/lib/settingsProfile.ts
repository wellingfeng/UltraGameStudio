// CONTRACT: the GLOBAL active "settings profile" + a synchronous remote KV cache
// for the programming-channel config (providers/gateway).
//
// Why this exists: `apiConfig`/`gatewayConfig` expose SYNCHRONOUS, no-arg
// singletons (`listProviders()`, `loadGatewayConfig()`) that the run engine,
// resolver and UI all read. To make those channels follow the active remote
// project we keep a process-wide "active profile" and a synchronous in-memory
// mirror of the remote project's channel config, hydrated once from the Runner's
// `/user-settings` KV (subsequent reads hit the cache; writes go write-behind to
// the server). The local profile keeps the existing disk/localStorage path
// unchanged — this module only adds the remote overlay.
//
// Scope note: this profile applies ONLY to ordinary programming channels.
// `remote-runner:` execution providers and `freecc:` free channels stay on the
// local profile (they are not per-project), so callers must carve them out.

import { tauriAvailable } from '@/lib/tauri';

export const LOCAL_PROFILE_ID = 'local';
export const REMOTE_PROFILE_PREFIX = 'remote:';
const REMOTE_WORKSPACE_PATH_PREFIX = 'remote://';

/** Channel-config files mirrored per remote profile (relPath under settings/). */
export const CHANNEL_PROFILE_RELPATHS = [
  'settings/providers.v1.json',
  'settings/activeProviderByKind.v1.json',
  'settings/modelGateway.v1.json',
  'settings/activeGatewaySelection.v1.json',
] as const;

export type ChannelProfileRelPath = (typeof CHANNEL_PROFILE_RELPATHS)[number];

// Active profile id ('local' or 'remote:<workspaceId>').
let activeProfileId: string = LOCAL_PROFILE_ID;
// `${profileId}\0${relPath}` -> serialized JSON. Synchronous source of truth for
// remote profiles once preloaded.
const remoteCache = new Map<string, string>();
// profileIds whose channel config has been pulled from the server at least once.
const hydratedProfiles = new Set<string>();

/** Result of one write-behind remote-profile write. */
export interface RemoteWriteResult {
  relPath: string;
  ok: boolean;
  error?: string;
}

// In-flight write-behind remote writes. `flushRemoteProfileWrites()` awaits the
// current set so callers (e.g. the cc-switch import) can confirm the data
// actually reached the remote account before claiming success.
const pendingRemoteWrites = new Set<Promise<RemoteWriteResult>>();

export function normalizeProfileId(id: string | null | undefined): string {
  const trimmed = id?.trim();
  if (!trimmed || trimmed === LOCAL_PROFILE_ID) return LOCAL_PROFILE_ID;
  return trimmed;
}

export function isRemoteProfile(id: string | null | undefined): boolean {
  return normalizeProfileId(id).startsWith(REMOTE_PROFILE_PREFIX);
}

export function remoteWorkspaceIdForProfile(id: string | null | undefined): string {
  const normalized = normalizeProfileId(id);
  if (!normalized.startsWith(REMOTE_PROFILE_PREFIX)) return '';
  return normalized.slice(REMOTE_PROFILE_PREFIX.length);
}

export function profileIdForRemoteWorkspaceId(workspaceId: string): string {
  const trimmed = workspaceId.trim();
  return trimmed ? `${REMOTE_PROFILE_PREFIX}${trimmed}` : LOCAL_PROFILE_ID;
}

/** Map a workspace path to the channel profile id; non-remote paths -> local. */
export function profileIdForWorkspacePath(
  path: string | null | undefined,
): string {
  const trimmed = path?.trim();
  if (!trimmed?.startsWith(REMOTE_WORKSPACE_PATH_PREFIX)) return LOCAL_PROFILE_ID;
  return profileIdForRemoteWorkspaceId(
    trimmed.slice(REMOTE_WORKSPACE_PATH_PREFIX.length),
  );
}

export function getActiveProfileId(): string {
  return activeProfileId;
}

export function isRemoteProfileActive(): boolean {
  return isRemoteProfile(activeProfileId);
}

function cacheKey(profileId: string, relPath: string): string {
  return `${profileId}\0${relPath}`;
}

/** Synchronous read of a remote-profile channel file; null when absent. */
export function readRemoteProfileRaw(
  relPath: string,
  profileId: string = activeProfileId,
): string | null {
  if (!isRemoteProfile(profileId)) return null;
  const value = remoteCache.get(cacheKey(profileId, relPath));
  return value != null && value !== '' && value !== 'null' ? value : null;
}

async function runnerClientForProfile(profileId: string) {
  const workspaceId = remoteWorkspaceIdForProfile(profileId);
  if (!workspaceId) return null;
  const remote = await import('@/lib/remoteWorkspace');
  const config = remote.getRemoteWorkspace(workspaceId);
  if (!config) return null;
  const connection = remote.resolveRemoteRunnerConnection(config);
  if (!connection) return null;
  return new remote.RunnerClient(connection.serverUrl, connection.token);
}

/** Write-behind a remote-profile channel file to the server; updates the cache. */
export function writeRemoteProfileRaw(
  relPath: string,
  json: string,
  profileId: string = activeProfileId,
): void {
  if (!isRemoteProfile(profileId)) return;
  remoteCache.set(cacheKey(profileId, relPath), json);
  const task = (async (): Promise<RemoteWriteResult> => {
    try {
      const client = await runnerClientForProfile(profileId);
      if (!client) {
        const error = 'remote runner connection unavailable';
        console.error('[settingsProfile] remote write failed', relPath, error);
        return { relPath, ok: false, error };
      }
      await client.writeUserSetting(relPath, json);
      return { relPath, ok: true };
    } catch (err) {
      console.error('[settingsProfile] remote write failed', relPath, err);
      return {
        relPath,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  })();
  pendingRemoteWrites.add(task);
  void task.finally(() => pendingRemoteWrites.delete(task));
}

/**
 * Await all currently in-flight remote-profile write-behind writes and report
 * per-file success. Lets callers (e.g. the cc-switch import) confirm the data
 * actually reached the remote account instead of silently dropping on a failed
 * fire-and-forget write. Returns [] when nothing was pending.
 */
export async function flushRemoteProfileWrites(): Promise<RemoteWriteResult[]> {
  const inFlight = [...pendingRemoteWrites];
  if (inFlight.length === 0) return [];
  return Promise.all(inFlight);
}

export function removeRemoteProfileRaw(
  relPath: string,
  profileId: string = activeProfileId,
): void {
  if (!isRemoteProfile(profileId)) return;
  remoteCache.delete(cacheKey(profileId, relPath));
  void (async () => {
    try {
      const client = await runnerClientForProfile(profileId);
      await client?.deleteUserSetting(relPath);
    } catch (err) {
      console.error('[settingsProfile] remote delete failed', relPath, err);
    }
  })();
}

/**
 * Pull a remote profile's channel config from the server into the synchronous
 * cache. Runs at most once per profile unless `force` is set (first switch pulls
 * fresh data; later switches reuse the cache, per the product requirement).
 */
export async function hydrateRemoteProfile(
  profileId: string,
  options: { force?: boolean } = {},
): Promise<void> {
  if (!isRemoteProfile(profileId)) return;
  if (!options.force && hydratedProfiles.has(profileId)) return;
  const client = await runnerClientForProfile(profileId);
  if (!client) return;
  await Promise.all(
    CHANNEL_PROFILE_RELPATHS.map(async (relPath) => {
      try {
        const text = await client.readUserSetting(relPath);
        if (text != null) {
          remoteCache.set(cacheKey(profileId, relPath), text);
        }
      } catch (err) {
        console.warn('[settingsProfile] remote read failed', relPath, err);
      }
    }),
  );
  hydratedProfiles.add(profileId);
}

/**
 * Switch the global active channel profile. Remote profiles are hydrated (once)
 * before activation so the synchronous singletons immediately see project data.
 * Fires `ugs:gateway-config-changed` so the channel UI + selector refresh.
 */
export async function setActiveSettingsProfile(
  profileId: string | null | undefined,
): Promise<void> {
  const normalized = normalizeProfileId(profileId);
  if (isRemoteProfile(normalized)) {
    await hydrateRemoteProfile(normalized);
  }
  if (activeProfileId === normalized) return;
  activeProfileId = normalized;
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('ugs:gateway-config-changed'));
    }
  } catch {
    /* ignore */
  }
}

/** Synchronously set the active profile without hydrating (browser/dev/tests). */
export function setActiveSettingsProfileSync(
  profileId: string | null | undefined,
): void {
  activeProfileId = normalizeProfileId(profileId);
}

/** Remote profiles never have a usable cache in the browser/non-Tauri build. */
export function remoteProfileSupported(): boolean {
  return tauriAvailable() || typeof window !== 'undefined';
}

/** Test-only reset. */
export function resetSettingsProfileForTests(): void {
  activeProfileId = LOCAL_PROFILE_ID;
  remoteCache.clear();
  hydratedProfiles.clear();
  pendingRemoteWrites.clear();
}
