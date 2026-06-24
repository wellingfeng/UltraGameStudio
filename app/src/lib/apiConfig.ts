/**
 * CONTRACT: single source of truth for the locally-stored set of model
 * providers and which one is currently active.
 *
 * A Claude provider is one Anthropic-compatible endpoint: a name + API key +
 * optional custom base URL + optional model. Codex/Gemini are local CLI
 * runtimes today, but the stored shape is typed so older Claude entries keep
 * their meaning and future non-Claude provider records do not get mistaken for
 * Anthropic API endpoints. In the Tauri desktop shell API keys live in the OS
 * keychain; localStorage keeps only provider metadata.
 * Exactly one provider may be "active"; direct API readers only expose the
 * active provider when it is Anthropic-backed.
 *
 * Consumers:
 *   - the store (`sendPrompt` / prompt translation) reads `readApiKey()` /
 *     `readBaseUrl()` to decide between the direct browser->Anthropic API path
 *     and the local CLI fallback. Those two functions now resolve to the ACTIVE
 *     provider, so the store needs no changes.
 *   - the Settings "Models" tab UI which lists / adds / edits / deletes /
 *     selects providers and imports them from cc-switch.
 *
 * When no Anthropic provider is active, `readApiKey()` returns '' and the app
 * falls back to the selected system CLI where available.
 */

import {
  PROVIDER_API_KEYS_SECRET,
  readSecureRecordValue,
  secureStorageAvailable,
  writeSecureRecord,
} from '@/lib/secureStorage';
import {
  loadGatewayConfig,
  modelClassFromModelId,
  saveGatewayConfig,
  setActiveGatewaySelection,
} from '@/lib/gatewayConfig';
import { tauriAvailable } from '@/lib/tauri';
import {
  isRemoteProfileActive,
  readRemoteProfileRaw,
  writeRemoteProfileRaw,
} from '@/lib/settingsProfile';
import type { RuntimeAdapterId } from '@/lib/adapters';
import type { GatewayProvider, GatewayTransport } from '@/lib/modelGateway/types';

/** remote-runner execution providers are per-project and never profile-scoped. */
function isRemoteRunnerProviderId(id: string): boolean {
  return id.startsWith('remote-runner:');
}

/** Remote-profile KV relPaths for the channel config. */
const PROVIDERS_PROFILE_RELPATH = 'settings/providers.v1.json';
const ACTIVE_BY_KIND_PROFILE_RELPATH = 'settings/activeProviderByKind.v1.json';

export type ProviderKind = 'anthropic' | 'codex' | 'gemini';
export type ProviderTransport = 'direct' | 'cli';

/** One locally stored provider configuration. */
export interface Provider {
  /** Stable local id (uuid). */
  id: string;
  /** Provider runtime family. Legacy records without this field are Anthropic. */
  kind: ProviderKind;
  /** User-facing label. */
  name: string;
  /** Anthropic API key / auth token. */
  apiKey: string;
  /** Optional custom base URL ('' = default api.anthropic.com). */
  baseUrl: string;
  /**
   * How UltraGameStudio should execute this provider. Manual Anthropic entries
   * default to browser-direct API calls; cc-switch imports default to CLI
   * because they are copied from local agent environment config.
   */
  transport?: ProviderTransport;
  /** Optional model override (informational; the app uses `composer.model`). */
  model?: string;
  /** User-added model ids kept selectable for this provider. */
  models?: string[];
}

export type ProviderRuntimeStatus = 'direct' | 'cli' | 'unavailable';

export interface ProviderRuntimeInfo {
  status: ProviderRuntimeStatus;
  hasApiKey: boolean;
  hasBaseUrl: boolean;
  baseUrlValid: boolean;
  baseUrlHost: string;
  canUseCliFallback: boolean;
}

export interface DefaultChannelsExport {
  type: 'ultragamestudio.defaultChannels';
  version: 1;
  providers: Provider[];
  activeProviderIds: Partial<Record<ProviderKind, string>>;
}

export interface DefaultChannelsImportResult {
  imported: number;
  updated: number;
  skipped: number;
}

/** localStorage key holding the JSON array of providers. */
export const PROVIDERS_STORAGE = 'ugs_providers';
/**
 * @deprecated Legacy single-active-provider key. Still written as a mirror of
 * the anthropic (Claude Code) default so the gateway's "inherit global"
 * fallback keeps working; superseded by {@link ACTIVE_PROVIDER_BY_KIND_STORAGE}.
 */
export const ACTIVE_PROVIDER_STORAGE = 'ugs_active_provider_id';
/**
 * localStorage key holding the active/default provider id PER category
 * (`{ anthropic, codex, gemini }`). Each runtime family has its own default,
 * so activating a Codex channel never changes the Claude Code default.
 */
export const ACTIVE_PROVIDER_BY_KIND_STORAGE = 'ugs_active_provider_by_kind_v1';

/* --- legacy single-key storage (read once for migration, never removed) --- */
/** @deprecated legacy single-key storage; kept for migration + rollback. */
export const API_KEY_STORAGE = 'ugs_anthropic_key';
/** @deprecated legacy single-base-url storage; kept for migration + rollback. */
export const BASE_URL_STORAGE = 'ugs_anthropic_base_url';

const hasWindow = (): boolean => typeof window !== 'undefined';

/**
 * Provider metadata used to live only in localStorage, whose ~5MB quota is
 * shared with everything else. Once it fills, `setItem` throws, the write is
 * silently lost, and a freshly-added channel "vanishes" on reopen. So — exactly
 * like `gatewayConfig` and `generationSettingsStore` — under Tauri these keys
 * are persisted durably to disk (the source of truth), with localStorage kept
 * as a synchronous mirror so reads stay sync and the browser/dev build keeps
 * working unchanged.
 */
const DISK_BACKED_PATHS: Readonly<Record<string, string>> = {
  [PROVIDERS_STORAGE]: 'settings/providers.v1.json',
  [ACTIVE_PROVIDER_BY_KIND_STORAGE]: 'settings/activeProviderByKind.v1.json',
  [ACTIVE_PROVIDER_STORAGE]: 'settings/activeProvider.v1.json',
};

// key -> serialized value. Authoritative in-memory view for disk-backed keys
// once initializeApiConfigStore() has run under Tauri.
const diskCache = new Map<string, string>();
let diskReady = false;

function tauriBacked(): boolean {
  return diskReady && tauriAvailable();
}

async function getInvoke() {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke;
}

// Serialize write-behind per disk key. Each scheduled flush writes the CURRENT
// cache value (not a stale snapshot), so even when two writes to the same key
// race within one operation — e.g. loadProviders() migrating `[]` and then
// addProvider() saving `[new]` — the last-set cache value always wins on disk.
const pendingFlush = new Map<string, Promise<void>>();

function diskWriteSoon(key: string, relPath: string): void {
  if (!tauriAvailable()) return;
  const prev = pendingFlush.get(key) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(async () => {
      const value = diskCache.has(key) ? diskCache.get(key)! : 'null';
      try {
        const invoke = await getInvoke();
        await invoke<void>('history_write_json', { relPath, json: value });
      } catch (err) {
        console.error('[apiConfig] disk write failed', relPath, err);
      }
    });
  pendingFlush.set(key, next);
}

/** Generate a stable id; `crypto.randomUUID` with a best-effort fallback. */
function genId(): string {
  try {
    if (hasWindow() && typeof window.crypto?.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
  } catch {
    /* ignore */
  }
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function localStorageSet(key: string, value: string): boolean {
  try {
    if (!hasWindow()) return false;
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function rawGet(key: string): string | null {
  if (tauriBacked() && key in DISK_BACKED_PATHS) {
    const cached = diskCache.get(key);
    if (cached != null) return cached && cached !== 'null' ? cached : null;
  }
  try {
    if (!hasWindow()) return null;
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function rawSet(key: string, value: string): void {
  const relPath = DISK_BACKED_PATHS[key];
  if (relPath && tauriAvailable()) {
    // Disk is the durable sink; cache+disk always accept the write even when
    // the localStorage mirror is full, so a new channel never silently vanishes.
    diskCache.set(key, value);
    localStorageSet(key, value); // best-effort mirror
    diskWriteSoon(key, relPath);
    return;
  }
  localStorageSet(key, value);
}

function rawRemove(key: string): void {
  const relPath = DISK_BACKED_PATHS[key];
  if (relPath && tauriAvailable()) {
    diskCache.delete(key);
    diskWriteSoon(key, relPath);
  }
  try {
    if (hasWindow()) window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

function notifyProviderConfigChanged(): void {
  try {
    if (!hasWindow()) return;
    window.dispatchEvent(new Event('ugs:gateway-config-changed'));
  } catch {
    /* ignore */
  }
}

/**
 * Boot-time hydrate of the disk-backed provider keys into the in-memory cache
 * so the synchronous loaders see durable data. Migrates an existing
 * localStorage value to disk once when disk has nothing yet. Must be awaited
 * before the store seed / first render reads providers. No-op in the browser.
 */
export async function initializeApiConfigStore(): Promise<void> {
  if (diskReady) return;
  if (!tauriAvailable()) return;
  try {
    const invoke = await getInvoke();
    await Promise.all(
      Object.entries(DISK_BACKED_PATHS).map(async ([key, relPath]) => {
        const fromDisk = await invoke<string | null>('history_read_json', {
          relPath,
        });
        if (fromDisk != null && fromDisk !== '' && fromDisk !== 'null') {
          diskCache.set(key, fromDisk);
          // Keep the localStorage mirror in sync for any sync reader.
          localStorageSet(key, fromDisk);
          return;
        }
        // One-time migration: seed disk from the legacy localStorage value.
        let legacy: string | null = null;
        try {
          legacy = hasWindow() ? window.localStorage.getItem(key) : null;
        } catch {
          legacy = null;
        }
        if (legacy != null) {
          diskCache.set(key, legacy);
          diskWriteSoon(key, relPath);
        }
      }),
    );
  } catch (err) {
    console.warn(
      '[apiConfig] disk init failed; keeping localStorage fallback',
      err,
    );
  } finally {
    diskReady = true;
  }
}

/** Test-only: reset the in-memory disk cache between cases. */
export function resetApiConfigStoreForTests(): void {
  diskCache.clear();
  diskReady = false;
}

const PROVIDER_KINDS: ProviderKind[] = ['anthropic', 'codex', 'gemini'];

type ActiveByKind = Partial<Record<ProviderKind, string>>;

/**
 * Read the per-category active map, migrating once from the legacy single-id
 * key. Migration assigns the legacy active id to its provider's own category.
 */
function loadActiveByKind(): ActiveByKind {
  if (isRemoteProfileActive()) {
    const stored = readRemoteProfileRaw(ACTIVE_BY_KIND_PROFILE_RELPATH);
    if (stored !== null) {
      try {
        const parsed = JSON.parse(stored);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const out: ActiveByKind = {};
          for (const kind of PROVIDER_KINDS) {
            const value = (parsed as Record<string, unknown>)[kind];
            if (typeof value === 'string' && value) out[kind] = value;
          }
          return out;
        }
      } catch {
        /* corrupt — fall through to empty */
      }
    }
    return {};
  }
  return loadLocalActiveByKind();
}

function loadLocalActiveByKind(): ActiveByKind {
  const stored = rawGet(ACTIVE_PROVIDER_BY_KIND_STORAGE);
  if (stored !== null) {
    try {
      const parsed = JSON.parse(stored);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const out: ActiveByKind = {};
        for (const kind of PROVIDER_KINDS) {
          const value = (parsed as Record<string, unknown>)[kind];
          if (typeof value === 'string' && value) out[kind] = value;
        }
        return out;
      }
    } catch {
      /* corrupt — fall through to empty */
    }
    return {};
  }

  // Migration: seed from the legacy single active id (assigned to its kind).
  const legacy = (rawGet(ACTIVE_PROVIDER_STORAGE) ?? '').trim();
  const map: ActiveByKind = {};
  if (legacy) {
    const provider = loadProviders().find((p) => p.id === legacy);
    if (provider) map[provider.kind] = legacy;
  }
  rawSet(ACTIVE_PROVIDER_BY_KIND_STORAGE, JSON.stringify(map));
  return map;
}

/**
 * Persist the per-category active map and mirror the anthropic default back to
 * the legacy single-id key (the gateway's "inherit global" fallback reads it).
 */
function saveActiveByKind(map: ActiveByKind): void {
  if (isRemoteProfileActive()) {
    writeRemoteProfileRaw(
      ACTIVE_BY_KIND_PROFILE_RELPATH,
      JSON.stringify(map),
    );
    return;
  }
  rawSet(ACTIVE_PROVIDER_BY_KIND_STORAGE, JSON.stringify(map));
  const anthropic = (map.anthropic ?? '').trim();
  if (anthropic) {
    rawSet(ACTIVE_PROVIDER_STORAGE, anthropic);
  } else {
    try {
      if (hasWindow()) window.localStorage.removeItem(ACTIVE_PROVIDER_STORAGE);
    } catch {
      /* ignore */
    }
  }
}

/** Resolve a category's active id, falling back to the first provider of it. */
function resolveActiveForKind(
  list: Provider[],
  map: ActiveByKind,
  kind: ProviderKind,
): string {
  const ofKind = list.filter((p) => p.kind === kind);
  const stored = map[kind];
  if (stored && ofKind.some((p) => p.id === stored)) return stored;
  if (kind === 'anthropic') {
    const cliBacked = ofKind.find(
      (p) => normalizeProviderTransport(kind, p.transport) === 'cli',
    );
    if (cliBacked) return cliBacked.id;
  }
  return ofKind[0]?.id ?? '';
}

function loadProviders(): Provider[] {
  if (isRemoteProfileActive()) return loadProvidersForRemoteProfile();
  return loadLocalProviders();
}

/**
 * Remote profile: ordinary channels come from the project's `/user-settings`
 * (API keys inlined in the JSON, per the cross-device-sync product choice),
 * while `remote-runner:` execution providers stay sourced from the local store
 * so the active project can still run.
 */
function loadProvidersForRemoteProfile(): Provider[] {
  const localRunners = loadLocalProviders().filter((provider) =>
    isRemoteRunnerProviderId(provider.id),
  );
  const stored = readRemoteProfileRaw(PROVIDERS_PROFILE_RELPATH);
  let remote: Provider[] = [];
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        remote = parsed
          .map(normalizeRemoteProfileProvider)
          .filter((p): p is Provider => p !== null)
          .filter((p) => !isRemoteRunnerProviderId(p.id));
      }
    } catch {
      remote = [];
    }
  }
  const seen = new Set(remote.map((p) => p.id));
  return [...remote, ...localRunners.filter((p) => !seen.has(p.id))];
}

/** Remote-profile providers carry their apiKey inline (no keychain). */
function normalizeRemoteProfileProvider(value: unknown): Provider | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string') return null;
  const kind = normalizeProviderKind(v.kind ?? v.adapter);
  return {
    id: v.id,
    kind,
    name: typeof v.name === 'string' ? v.name : 'Claude',
    apiKey: typeof v.apiKey === 'string' ? v.apiKey : '',
    baseUrl: typeof v.baseUrl === 'string' ? v.baseUrl : '',
    transport: normalizeProviderTransport(kind, v.transport),
    model: typeof v.model === 'string' ? v.model : undefined,
    models: normalizeProviderModels(v.models),
  };
}

/**
 * Read the provider list, running a one-time migration from the legacy
 * single-key storage when the new key is absent. The presence of
 * `PROVIDERS_STORAGE` (even an empty array) is the migration sentinel, so this
 * runs at most once per device.
 */
function loadLocalProviders(): Provider[] {
  const stored = rawGet(PROVIDERS_STORAGE);
  if (stored !== null) {
    try {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        const providers = parsed
          .map(normalizeStoredProvider)
          .filter((p): p is Provider => p !== null);
        if (
          secureStorageAvailable() &&
          parsed.some(
            (value) =>
              typeof value === 'object' &&
              value !== null &&
              typeof (value as Record<string, unknown>).apiKey === 'string',
          )
        ) {
          saveLocalProviders(providers);
        }
        return providers;
      }
    } catch {
      /* corrupt — fall through to empty */
    }
    return [];
  }

  // Migration: synthesize a provider from the legacy single key (if any).
  const legacyKey = (rawGet(API_KEY_STORAGE) ?? '').trim();
  const legacyUrl = (rawGet(BASE_URL_STORAGE) ?? '').trim();
  let migrated: Provider[] = [];
  if (legacyKey) {
    const p: Provider = {
      id: genId(),
      kind: 'anthropic',
      name: 'Claude',
      apiKey: legacyKey,
      baseUrl: legacyUrl,
    };
    migrated = [p];
    rawSet(ACTIVE_PROVIDER_STORAGE, p.id);
  }
  saveLocalProviders(migrated);
  rawRemove(API_KEY_STORAGE);
  return migrated;
}

function normalizeStoredProvider(value: unknown): Provider | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string') {
    return null;
  }
  const rawApiKey = typeof v.apiKey === 'string' ? v.apiKey : '';
  const secureApiKey = secureStorageAvailable()
    ? readSecureRecordValue(PROVIDER_API_KEYS_SECRET, v.id)
    : '';
  return {
    id: v.id,
    kind: normalizeProviderKind(v.kind ?? v.adapter),
    name: typeof v.name === 'string' ? v.name : 'Claude',
    apiKey: secureApiKey || rawApiKey,
    baseUrl: typeof v.baseUrl === 'string' ? v.baseUrl : '',
    transport: normalizeProviderTransport(
      normalizeProviderKind(v.kind ?? v.adapter),
      v.transport,
    ),
    model: typeof v.model === 'string' ? v.model : undefined,
    models: normalizeProviderModels(v.models),
  };
}

function normalizeProviderModels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const model = raw.trim();
    if (!model) continue;
    const key = model.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(model);
  }
  return out.length > 0 ? out : undefined;
}

function normalizeProviderKind(value: unknown): ProviderKind {
  if (value === 'anthropic' || value === 'claude-code' || value === 'claude') {
    return 'anthropic';
  }
  if (value === 'codex') return 'codex';
  if (value === 'gemini') return 'gemini';
  return 'anthropic';
}

function normalizeProviderTransport(
  kind: ProviderKind,
  value: unknown,
): ProviderTransport {
  if (value === 'cli' || value === 'direct') return value;
  return kind === 'anthropic' ? 'direct' : 'cli';
}

function saveProviders(list: Provider[]): void {
  if (isRemoteProfileActive()) {
    saveProvidersForRemoteProfile(list);
    return;
  }
  saveLocalProviders(list);
}

/**
 * Remote profile: persist ordinary channels (keys inlined) to the project's
 * `/user-settings`, and keep any `remote-runner:` execution providers in the
 * local store so the active project keeps its run channel.
 */
function saveProvidersForRemoteProfile(list: Provider[]): void {
  const runners = list.filter((provider) => isRemoteRunnerProviderId(provider.id));
  const ordinary = list.filter((provider) => !isRemoteRunnerProviderId(provider.id));
  // Mirror remote-runner providers back into the local store unchanged.
  const localRunnersPrev = loadLocalProviders().filter((provider) =>
    isRemoteRunnerProviderId(provider.id),
  );
  if (
    runners.length !== localRunnersPrev.length ||
    runners.some(
      (provider, i) =>
        JSON.stringify(provider) !== JSON.stringify(localRunnersPrev[i]),
    )
  ) {
    const localNonRunner = loadLocalProviders().filter(
      (provider) => !isRemoteRunnerProviderId(provider.id),
    );
    saveLocalProviders([...localNonRunner, ...runners]);
  }
  writeRemoteProfileRaw(
    PROVIDERS_PROFILE_RELPATH,
    JSON.stringify(ordinary),
  );
  notifyProviderConfigChanged();
}

function saveLocalProviders(list: Provider[]): void {
  if (secureStorageAvailable()) {
    const apiKeys: Record<string, string> = {};
    for (const provider of list) {
      const key = provider.apiKey.trim();
      if (key) apiKeys[provider.id] = key;
    }
    writeSecureRecord(PROVIDER_API_KEYS_SECRET, apiKeys);
  }
  rawSet(PROVIDERS_STORAGE, JSON.stringify(list.map(providerForStorage)));
  notifyProviderConfigChanged();
}

function providerForStorage(provider: Provider): Omit<Provider, 'apiKey'> | Provider {
  if (!secureStorageAvailable()) return provider;
  const stored = { ...provider };
  delete (stored as Partial<Provider>).apiKey;
  return stored;
}

function providerAdapter(provider: Pick<Provider, 'kind'>): RuntimeAdapterId {
  if (provider.kind === 'codex') return 'codex';
  if (provider.kind === 'gemini') return 'gemini';
  return 'claude-code';
}

function providerTransport(provider: Provider): GatewayTransport {
  if (provider.transport === 'cli' || provider.kind !== 'anthropic') return 'cli';
  return 'anthropic';
}

function providerToGatewayProvider(provider: Provider): GatewayProvider {
  const model = provider.model?.trim() || undefined;
  const models = provider.models?.length
    ? Object.fromEntries(provider.models.map((item) => [item, item]))
    : undefined;
  const transport = providerTransport(provider);
  const adapter = providerAdapter(provider);
  return {
    id: provider.id,
    kind: provider.kind,
    name: provider.name,
    adapter,
    channels: [
      {
        id: 'default',
        name: model ?? 'Default',
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
        model,
        models,
        route: {
          transport,
          baseUrl: provider.baseUrl,
          model,
          models,
        },
      },
    ],
  };
}

function syncGatewayProvidersFromProviders(list: Provider[]): void {
  const current = loadGatewayConfig();
  const legacyIds = new Set(list.map((provider) => provider.id));
  const nextProviders = current.providers.filter(
    (provider) =>
      !legacyIds.has(provider.id) && !provider.id.startsWith('freecc:'),
  );
  nextProviders.push(...list.map(providerToGatewayProvider));
  saveGatewayConfig({ version: 1, providers: nextProviders });
}

function upsertGatewayProvider(provider: Provider): void {
  const gatewayProvider = providerToGatewayProvider(provider);
  const current = loadGatewayConfig();
  const nextProviders = current.providers.filter(
    (candidate) =>
      candidate.id !== provider.id && !candidate.id.startsWith('freecc:'),
  );
  nextProviders.push(gatewayProvider);
  saveGatewayConfig({ version: 1, providers: nextProviders });
}

function removeGatewayProvider(providerId: string): void {
  const current = loadGatewayConfig();
  const nextProviders = current.providers.filter(
    (candidate) =>
      candidate.id !== providerId && !candidate.id.startsWith('freecc:'),
  );
  saveGatewayConfig({ version: 1, providers: nextProviders });
}

function selectGatewayProvider(provider: Provider): void {
  setActiveGatewaySelection({
    adapter: providerAdapter(provider),
    modelClass: modelClassFromModelId(provider.model),
    providerId: provider.id,
    channelId: 'default',
  });
}

function normalizeImportProvider(value: unknown): Provider | null {
  const stored = normalizeStoredProvider(value);
  if (stored) return stored;
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.name !== 'string') return null;
  return {
    id: genId(),
    kind: normalizeProviderKind(v.kind ?? v.adapter),
    name: v.name,
    apiKey: typeof v.apiKey === 'string' ? v.apiKey : '',
    baseUrl: typeof v.baseUrl === 'string' ? v.baseUrl : '',
    transport: normalizeProviderTransport(
      normalizeProviderKind(v.kind ?? v.adapter),
      v.transport,
    ),
    model: typeof v.model === 'string' ? v.model : undefined,
    models: normalizeProviderModels(v.models),
  };
}

function normalizeActiveProviderIds(value: unknown): ActiveByKind {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  const raw = value as Record<string, unknown>;
  const out: ActiveByKind = {};
  for (const kind of PROVIDER_KINDS) {
    const id = raw[kind];
    if (typeof id === 'string' && id.trim()) out[kind] = id.trim();
  }
  return out;
}

function readDefaultChannelsPayload(value: unknown): {
  providers: Provider[];
  activeProviderIds: ActiveByKind;
} | null {
  const source =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const rawProviders = Array.isArray(value)
    ? value
    : Array.isArray(source?.providers)
      ? source.providers
      : null;
  if (!rawProviders) return null;
  const providers = rawProviders
    .map(normalizeImportProvider)
    .filter((p): p is Provider => p !== null);
  if (providers.length === 0 && rawProviders.length > 0) return null;
  return {
    providers,
    activeProviderIds: normalizeActiveProviderIds(source?.activeProviderIds),
  };
}

export function isProviderBaseUrlValid(baseUrl: string): boolean {
  const raw = baseUrl.trim();
  if (!raw) return true;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function providerBaseUrlHost(baseUrl: string): string {
  const raw = baseUrl.trim();
  if (!raw) return 'api.anthropic.com';
  try {
    return new URL(raw).host;
  } catch {
    return raw;
  }
}

export function getProviderRuntimeInfo(
  provider: Pick<Provider, 'apiKey' | 'baseUrl'> &
    Partial<Pick<Provider, 'kind' | 'transport'>>,
  options: { canUseCliFallback?: boolean } = {},
): ProviderRuntimeInfo {
  const kind = normalizeProviderKind(provider.kind);
  const transport = normalizeProviderTransport(kind, provider.transport);
  const hasApiKey = provider.apiKey.trim().length > 0;
  const hasBaseUrl = provider.baseUrl.trim().length > 0;
  const baseUrlValid = isProviderBaseUrlValid(provider.baseUrl);
  const canUseCliFallback = options.canUseCliFallback === true;
  const status: ProviderRuntimeStatus =
    kind === 'anthropic'
      ? transport === 'cli'
        ? baseUrlValid && canUseCliFallback
          ? 'cli'
          : 'unavailable'
        : hasApiKey && baseUrlValid
          ? 'direct'
          : !hasApiKey && baseUrlValid && canUseCliFallback
            ? 'cli'
            : 'unavailable'
      : canUseCliFallback
        ? 'cli'
        : 'unavailable';

  return {
    status,
    hasApiKey,
    hasBaseUrl,
    baseUrlValid,
    baseUrlHost: kind === 'anthropic' ? providerBaseUrlHost(provider.baseUrl) : '',
    canUseCliFallback,
  };
}

export function providerMetadataSignature(
  p: Pick<Provider, 'name' | 'baseUrl' | 'model'> &
    Partial<Pick<Provider, 'kind' | 'transport'>>,
): string {
  const kind = normalizeProviderKind(p.kind);
  return [
    kind,
    normalizeProviderTransport(kind, p.transport),
    p.name.trim().toLowerCase(),
    p.baseUrl.trim().replace(/\/+$/, '').toLowerCase(),
    (p.model ?? '').trim().toLowerCase(),
  ].join('\0');
}

/** List all configured providers (browser-safe; '[]' when none / non-browser). */
export function listProviders(): Provider[] {
  return loadProviders();
}

/**
 * Id of the active/default provider for a category, or '' when that category
 * has none. With no `kind` it returns the anthropic (Claude Code) default,
 * preserving the legacy single-active contract for direct-API callers.
 */
export function getActiveProviderId(kind: ProviderKind = 'anthropic'): string {
  return resolveActiveForKind(loadProviders(), loadActiveByKind(), kind);
}

/** The active/default provider id for every category. */
export function getActiveProviderIds(): Record<ProviderKind, string> {
  const list = loadProviders();
  const map = loadActiveByKind();
  return {
    anthropic: resolveActiveForKind(list, map, 'anthropic'),
    codex: resolveActiveForKind(list, map, 'codex'),
    gemini: resolveActiveForKind(list, map, 'gemini'),
  };
}

export function exportDefaultChannelsConfig(): DefaultChannelsExport {
  return {
    type: 'ultragamestudio.defaultChannels',
    version: 1,
    providers: loadProviders(),
    activeProviderIds: getActiveProviderIds(),
  };
}

export function importDefaultChannelsConfig(
  value: unknown,
): DefaultChannelsImportResult {
  const payload = readDefaultChannelsPayload(value);
  if (!payload) {
    throw new Error('Unsupported default channels JSON');
  }

  const list = loadProviders();
  const activeMap = loadActiveByKind();
  const byId = new Map(list.map((provider) => [provider.id, provider]));
  const bySignature = new Map(
    list.map((provider) => [providerMetadataSignature(provider), provider]),
  );
  const idRemap = new Map<string, string>();
  const incomingIds = new Set<string>();
  let imported = 0;
  let updated = 0;
  let skipped = 0;

  for (const provider of payload.providers) {
    if (incomingIds.has(provider.id)) {
      skipped += 1;
      continue;
    }
    incomingIds.add(provider.id);

    const signature = providerMetadataSignature(provider);
    const target = byId.get(provider.id) ?? bySignature.get(signature);
    if (target) {
      const index = list.findIndex((candidate) => candidate.id === target.id);
      if (index === -1) {
        skipped += 1;
        continue;
      }
      const next = { ...provider, id: target.id };
      list[index] = next;
      byId.set(next.id, next);
      bySignature.set(providerMetadataSignature(next), next);
      idRemap.set(provider.id, next.id);
      updated += 1;
      continue;
    }

    list.push(provider);
    byId.set(provider.id, provider);
    bySignature.set(signature, provider);
    idRemap.set(provider.id, provider.id);
    imported += 1;
  }

  for (const kind of PROVIDER_KINDS) {
    const exportedActive = payload.activeProviderIds[kind];
    const remapped = exportedActive ? idRemap.get(exportedActive) : undefined;
    if (remapped && list.some((provider) => provider.id === remapped)) {
      activeMap[kind] = remapped;
    }
    const valid =
      !!activeMap[kind] &&
      list.some((provider) => provider.kind === kind && provider.id === activeMap[kind]);
    if (!valid) {
      const first = list.find((provider) => provider.kind === kind);
      if (first) activeMap[kind] = first.id;
      else delete activeMap[kind];
    }
  }

  saveProviders(list);
  syncGatewayProvidersFromProviders(list);
  saveActiveByKind(activeMap);
  notifyProviderConfigChanged();

  return { imported, updated, skipped };
}

/** Set the default provider for its own category. Unknown ids are ignored. */
export function setActiveProviderId(id: string): void {
  const trimmed = id.trim();
  if (!trimmed) return;
  const provider = loadProviders().find((p) => p.id === trimmed);
  if (!provider) return;
  const map = loadActiveByKind();
  map[provider.kind] = trimmed;
  saveActiveByKind(map);
  upsertGatewayProvider(provider);
  selectGatewayProvider(provider);
  notifyProviderConfigChanged();
}

/** The active anthropic (Claude Code) provider object, or null when none. */
export function getActiveProvider(): Provider | null {
  const list = loadProviders();
  const id = resolveActiveForKind(list, loadActiveByKind(), 'anthropic');
  if (!id) return null;
  return list.find((p) => p.id === id) ?? null;
}

/**
 * Add a provider; the first one of its category becomes that category's
 * default. Returns the created provider.
 */
export function addProvider(p: Omit<Provider, 'id'>): Provider {
  const list = loadProviders();
  const map = loadActiveByKind();
  const created: Provider = { ...p, id: genId() };
  // Resolve the category's current default BEFORE adding: only promote the new
  // provider when its category has no default yet (i.e. it is the first one).
  const existingDefault = resolveActiveForKind(list, map, created.kind);
  list.push(created);
  saveProviders(list);
  syncGatewayProvidersFromProviders(list);
  if (!existingDefault) {
    map[created.kind] = created.id;
    saveActiveByKind(map);
    selectGatewayProvider(created);
    notifyProviderConfigChanged();
  }
  return created;
}

/** Patch a provider in place. */
export function updateProvider(
  id: string,
  patch: Partial<Omit<Provider, 'id'>>,
): void {
  const list = loadProviders();
  const idx = list.findIndex((p) => p.id === id);
  if (idx === -1) return;
  list[idx] = { ...list[idx], ...patch };
  saveProviders(list);
  upsertGatewayProvider(list[idx]);
}

/**
 * Delete a provider; if it was its category's default, promote the first
 * remaining provider of that same category (categories stay independent).
 */
export function deleteProvider(id: string): void {
  const list = loadProviders();
  const target = list.find((p) => p.id === id);
  const next = list.filter((p) => p.id !== id);
  saveProviders(next);
  removeGatewayProvider(id);
  if (!target) return;
  const map = loadActiveByKind();
  if (map[target.kind] === id) {
    const promote = next.find((p) => p.kind === target.kind);
    if (promote) {
      map[target.kind] = promote.id;
      selectGatewayProvider(promote);
    } else {
      delete map[target.kind];
    }
    saveActiveByKind(map);
  }
  notifyProviderConfigChanged();
}

/**
 * Identity of a provider for cc-switch dedup, IGNORING transport: a relay is the
 * same relay whether a stale entry recorded it as `direct` or the import records
 * it as `cli`. Used only when `collapseTransport` is set so the general import
 * contract (direct vs cli kept distinct) is preserved for non-cc-switch callers.
 */
function providerIdentityKey(
  p: Pick<Provider, 'name' | 'baseUrl' | 'model'> & Partial<Pick<Provider, 'kind'>>,
): string {
  return [
    normalizeProviderKind(p.kind),
    p.name.trim().toLowerCase(),
    p.baseUrl.trim().replace(/\/+$/, '').toLowerCase(),
    (p.model ?? '').trim().toLowerCase(),
  ].join('\0');
}

/**
 * Import a batch of providers (e.g. from cc-switch). Dedupes against existing
 * entries by provider metadata (name + baseUrl + model), never by API key.
 * `makeActiveMatch`, if given, marks the matching imported provider as the new
 * active one.
 *
 * `opts.collapseTransport` (used by the cc-switch import) dedupes ignoring the
 * transport field and upgrades a matching stale `direct` entry in place to the
 * freshly-imported `cli` runtime, so re-importing never leaves two copies of the
 * same relay (one pre-`transport` `direct`, one `cli`).
 */
export function importProviders(
  incoming: Array<Omit<Provider, 'id'>>,
  makeActiveMatch?: (p: Omit<Provider, 'id'>) => boolean,
  opts: { collapseTransport?: boolean } = {},
): { imported: number; skipped: number } {
  const loaded = loadProviders();
  const collapse = opts.collapseTransport === true;
  const keyOf = (p: Parameters<typeof providerMetadataSignature>[0]): string =>
    collapse ? providerIdentityKey(p) : providerMetadataSignature(p);

  // When collapsing, first fold any PRE-EXISTING duplicates of the same relay
  // (e.g. a stale `direct` entry left beside a `cli` one by an older import)
  // into a single entry, preferring the cli-backed runtime. `idRemap` records
  // dropped-id -> kept-id so active pointers can be repaired below.
  const idRemap = new Map<string, string>();
  let list = loaded;
  if (collapse) {
    const winners = new Map<string, Provider>();
    for (const p of loaded) {
      const k = keyOf(p);
      const prev = winners.get(k);
      if (!prev) {
        winners.set(k, p);
        continue;
      }
      const winner = prev.transport === 'cli' || p.transport !== 'cli' ? prev : p;
      const loser = winner === prev ? p : prev;
      winners.set(k, winner);
      idRemap.set(loser.id, winner.id);
    }
    if (idRemap.size > 0) list = loaded.filter((p) => !idRemap.has(p.id));
  }

  const byKey = new Map(list.map((e) => [keyOf(e), e]));
  const seen = new Set(byKey.keys());
  let imported = 0;
  let skipped = 0;
  let activeTarget: string | null = null;

  for (const p of incoming) {
    const sig = keyOf(p);
    if (seen.has(sig)) {
      const existing = byKey.get(sig) ?? list.find((e) => keyOf(e) === sig);
      // When collapsing, upgrade a stale entry to the imported runtime in place
      // (e.g. a pre-`transport` `direct` relay -> `cli`) instead of duplicating.
      if (collapse && existing) {
        existing.apiKey = p.apiKey;
        existing.baseUrl = p.baseUrl;
        if (p.transport) existing.transport = p.transport;
        if (p.model !== undefined) existing.model = p.model;
      }
      // Already present — still let it be the active target if requested.
      if (makeActiveMatch?.(p) && existing) activeTarget = existing.id;
      skipped += 1;
      continue;
    }
    seen.add(sig);
    const created: Provider = { ...p, id: genId() };
    list.push(created);
    byKey.set(sig, created);
    imported += 1;
    if (makeActiveMatch?.(p)) activeTarget = created.id;
  }

  saveProviders(list);
  syncGatewayProvidersFromProviders(list);

  // Ensure every category has a default (first of its kind when unset), then
  // let an explicit active match override its own category's default.
  const map = loadActiveByKind();
  for (const kind of PROVIDER_KINDS) {
    // Repoint any default that referenced a folded-away duplicate id.
    const remapped = map[kind] ? idRemap.get(map[kind]) : undefined;
    if (remapped) map[kind] = remapped;
    const valid =
      !!map[kind] && list.some((p) => p.kind === kind && p.id === map[kind]);
    if (!valid) {
      const first = list.find((p) => p.kind === kind);
      if (first) map[kind] = first.id;
      else delete map[kind];
    }
  }
  if (activeTarget) {
    const target = list.find((p) => p.id === activeTarget);
    if (target) {
      map[target.kind] = activeTarget;
      selectGatewayProvider(target);
    }
  }
  saveActiveByKind(map);
  notifyProviderConfigChanged();

  return { imported, skipped };
}

/**
 * Upsert providers with caller-owned stable ids. Used by integrations where an
 * external account identity must remain addressable from saved chat selections.
 */
export function upsertProviders(
  incoming: Provider[],
  opts: { removeIds?: string[]; makeActiveId?: string } = {},
): void {
  const list = loadProviders();
  const byId = new Map(list.map((provider, index) => [provider.id, index]));
  for (const provider of incoming) {
    const index = byId.get(provider.id);
    if (index === undefined) {
      byId.set(provider.id, list.length);
      list.push(provider);
    } else {
      list[index] = provider;
    }
  }
  const removeIds = new Set(opts.removeIds ?? []);
  const next = removeIds.size > 0
    ? list.filter((provider) => !removeIds.has(provider.id))
    : list;
  saveProviders(next);
  syncGatewayProvidersFromProviders(next);
  for (const id of removeIds) removeGatewayProvider(id);

  const map = loadActiveByKind();
  if (opts.makeActiveId) {
    const active = next.find((provider) => provider.id === opts.makeActiveId);
    if (active) {
      map[active.kind] = active.id;
      selectGatewayProvider(active);
    }
  }
  for (const kind of PROVIDER_KINDS) {
    const valid =
      !!map[kind] &&
      next.some((provider) => provider.kind === kind && provider.id === map[kind]);
    if (!valid) {
      const first = next.find((provider) => provider.kind === kind);
      if (first) map[kind] = first.id;
      else delete map[kind];
    }
  }
  saveActiveByKind(map);
  notifyProviderConfigChanged();
}

/**
 * Read the ACTIVE provider's API key. Returns '' when none configured.
 * Signature preserved for existing consumers (store / prompt translation).
 */
export function readApiKey(): string {
  const provider = getActiveProvider();
  return provider?.kind === 'anthropic' && provider.transport !== 'cli'
    ? provider.apiKey.trim()
    : '';
}

/**
 * Read the ACTIVE provider's custom base URL. Returns '' when none / default.
 * Signature preserved for existing consumers.
 */
export function readBaseUrl(): string {
  const provider = getActiveProvider();
  return provider?.kind === 'anthropic' && provider.transport !== 'cli'
    ? provider.baseUrl.trim()
    : '';
}

/**
 * @deprecated Use {@link addProvider}/{@link updateProvider} instead. Repoints
 * at the active provider so any stray caller stays coherent for one release.
 */
export function writeApiKey(value: string): void {
  const v = value.trim();
  const active = getActiveProvider();
  if (active?.kind === 'anthropic' && active.transport !== 'cli') {
    updateProvider(active.id, { apiKey: v });
  } else if (v) {
    const created = addProvider({
      kind: 'anthropic',
      name: 'Claude',
      apiKey: v,
      baseUrl: readBaseUrl(),
    });
    setActiveProviderId(created.id);
  }
}

/**
 * @deprecated Use {@link updateProvider} instead. Repoints at the active
 * provider so any stray caller stays coherent for one release.
 */
export function writeBaseUrl(value: string): void {
  const active = getActiveProvider();
  if (active?.kind === 'anthropic' && active.transport !== 'cli') {
    updateProvider(active.id, { baseUrl: value.trim() });
  }
}
