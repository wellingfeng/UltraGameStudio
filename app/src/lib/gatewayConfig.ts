import type { IRGraph } from '@/core/ir';
import type { RuntimeAdapterId } from '@/lib/adapters';
import { tauriAvailable } from '@/lib/tauri';
import {
  FREE_CHANNEL_PROVIDER_PREFIX,
  freeChannelGatewayProviders,
} from '@/lib/freeChannels';
import {
  DEFAULT_GATEWAY_SELECTION,
  type GatewayConfig,
  type GatewayProvider,
  type GatewaySelection,
  type GatewayTransport,
} from '@/lib/modelGateway/types';
import {
  GATEWAY_CHANNEL_API_KEYS_SECRET,
  PROVIDER_API_KEYS_SECRET,
  gatewayChannelSecretKey,
  readSecureRecord,
  readSecureRecordValue,
  secureStorageAllowsInlineFallback,
  secureStorageAvailable,
  writeSecureRecord,
} from '@/lib/secureStorage';
import {
  isRemoteProfileActive,
  readRemoteProfileRaw,
  writeRemoteProfileRaw,
} from '@/lib/settingsProfile';

/** Remote-profile KV relPath for the gateway config (channels + inline keys). */
const GATEWAY_PROFILE_RELPATH = 'settings/modelGateway.v1.json';
const ACTIVE_SELECTION_PROFILE_RELPATH =
  'settings/activeGatewaySelection.v1.json';

/** remote-runner / freecc providers are not per-project; keep them local. */
function isLocalOnlyGatewayId(id: string): boolean {
  return id.startsWith('remote-runner:') || id.startsWith(FREE_CHANNEL_PROVIDER_PREFIX);
}

export const GATEWAY_CONFIG_STORAGE = 'ugs_model_gateway_v1';
export const ACTIVE_GATEWAY_SELECTION_STORAGE =
  'ugs_active_gateway_selection_v1';

const LEGACY_ACTIVE_PROVIDER_STORAGE = 'ugs_active_provider_id';

const hasWindow = (): boolean => typeof window !== 'undefined';

// The gateway config + active channel selection used to live only in
// localStorage, which has a ~5MB quota shared with everything else. Once that
// quota fills, setItem throws, the write is silently lost, and the default
// channel "resets" to the first provider on reopen. So — exactly like
// generationSettingsStore — under Tauri these two keys are persisted durably to
// disk (the source of truth), with localStorage kept as a synchronous mirror so
// reads stay sync and the browser/dev build keeps working unchanged.
const DISK_BACKED_KEYS: Readonly<Record<string, string>> = {
  [GATEWAY_CONFIG_STORAGE]: 'settings/modelGateway.v1.json',
  [ACTIVE_GATEWAY_SELECTION_STORAGE]: 'settings/activeGatewaySelection.v1.json',
};

// key -> serialized value. Authoritative in-memory view for disk-backed keys
// once initializeGatewayConfigStore() has run under Tauri.
const diskCache = new Map<string, string>();
let diskReady = false;
const diskReadErrors = new Set<string>();

async function getInvoke() {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke;
}

// Serialize writes per key, as apiConfig does. Provider synchronization can
// write a default selection just before settings writes the thinking level;
// concurrent writes would let that older value overwrite the user's choice.
const pendingDiskWrites = new Map<string, Promise<void>>();

function diskWriteSoon(key: string, relPath: string): void {
  if (!tauriAvailable() || diskReadErrors.has(key)) return;
  const previous = pendingDiskWrites.get(key) ?? Promise.resolve();
  const write = previous.catch(() => {}).then(async () => {
    const json = diskCache.get(key) ?? 'null';
    try {
      const invoke = await getInvoke();
      await invoke<void>('history_write_json', { relPath, json });
    } catch (err) {
      console.error('[gatewayConfig] disk write failed', relPath, err);
    }
  });
  pendingDiskWrites.set(key, write);
}

/**
 * Await all in-flight disk writes so the on-disk settings files are current
 * before the process exits. Called from the quit-flush handshake; resolves
 * even if individual writes failed (errors are logged inside diskWriteSoon).
 */
export async function flushGatewayConfigDiskWrites(): Promise<void> {
  await Promise.all([...pendingDiskWrites.values()]);
}

function diskDeleteSoon(key: string, relPath: string): void {
  // history_write_json validates the payload as JSON, so a deletion is recorded
  // as the JSON literal `null`; the sync readers treat "null"/"" as absent.
  diskWriteSoon(key, relPath);
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

/**
 * Boot-time hydrate of the disk-backed gateway keys into the in-memory cache so
 * the synchronous rawGet() readers see durable data. Migrates an existing
 * localStorage value to disk once when disk has nothing yet. Must be awaited
 * before the store seed reads the active selection. No-op in the browser.
 */
export async function initializeGatewayConfigStore(): Promise<void> {
  if (diskReady) return;
  if (!tauriAvailable()) return;
  let loaded = false;
  try {
    const invoke = await getInvoke();
    const results = await Promise.allSettled(
      Object.entries(DISK_BACKED_KEYS).map(async ([key, relPath]) => {
        // Retry only failed/unknown keys; a healthy cache may contain a newer
        // queued edit than disk and must not be replaced by a read snapshot.
        if (diskCache.has(key) && !diskReadErrors.has(key)) return;
        let fromDisk: string | null;
        try {
          fromDisk = await invoke<string | null>('history_read_json', { relPath });
          diskReadErrors.delete(key);
        } catch (error) {
          diskReadErrors.add(key);
          throw error;
        }
        if (fromDisk != null && fromDisk !== '' && fromDisk !== 'null') {
          diskCache.set(key, fromDisk);
          // Keep the localStorage mirror in sync for any sync reader.
          if (secureStorageAvailable()) localStorageSet(key, fromDisk);
          return;
        }
        // One-time migration: seed disk from the legacy localStorage value.
        let legacy: string | null = null;
        try {
          legacy = hasWindow() ? window.localStorage.getItem(key) : null;
        } catch {
          legacy = null;
        }
        diskCache.set(key, legacy ?? 'null');
        if (legacy != null) {
          if (secureStorageAvailable()) diskWriteSoon(key, relPath);
        }
      }),
    );
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    loaded = true;
  } catch (err) {
    console.warn(
      '[gatewayConfig] disk init failed; keeping localStorage fallback',
      err,
    );
  }
  diskReady = loaded && diskReadErrors.size === 0;
}

function rawGet(key: string): string | null {
  if (tauriAvailable() && key in DISK_BACKED_KEYS && diskCache.has(key)) {
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
  const relPath = DISK_BACKED_KEYS[key];
  if (relPath && tauriAvailable()) {
    // Disk is the durable sink; cache+disk always accept the write, so the
    // change event fires reliably even when the localStorage mirror is full.
    diskCache.set(key, value);
    localStorageSet(key, value); // best-effort mirror
    diskWriteSoon(key, relPath);
    if (hasWindow()) window.dispatchEvent(new Event('ugs:gateway-config-changed'));
    return;
  }
  if (localStorageSet(key, value) && hasWindow()) {
    window.dispatchEvent(new Event('ugs:gateway-config-changed'));
  }
}

function rawRemove(key: string): void {
  const relPath = DISK_BACKED_KEYS[key];
  if (relPath && tauriAvailable()) {
    // Retain authoritative absence: deleting the cache entry makes a retry
    // reload an older on-disk pin while its queued deletion is still pending.
    diskCache.set(key, 'null');
    try {
      if (hasWindow()) window.localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
    diskDeleteSoon(key, relPath);
    if (hasWindow()) window.dispatchEvent(new Event('ugs:gateway-config-changed'));
    return;
  }
  try {
    if (!hasWindow()) return;
    window.localStorage.removeItem(key);
    window.dispatchEvent(new Event('ugs:gateway-config-changed'));
  } catch {
    /* ignore */
  }
}

/** Test-only: reset the disk-backed cache between cases. */
export function resetGatewayConfigStoreForTests(): void {
  diskCache.clear();
  pendingDiskWrites.clear();
  diskReady = false;
  diskReadErrors.clear();
}

function normalizeAdapter(value: unknown): RuntimeAdapterId {
  if (
    value === 'codex' ||
    value === 'gemini' ||
    value === 'kimi' ||
    value === 'deepseek-harness' ||
    value === 'zcode' ||
    value === 'grok'
  ) {
    return value;
  }
  return 'claude-code';
}

function normalizeTransport(value: unknown): GatewayTransport {
  if (
    value === 'anthropic' ||
    value === 'openai-compatible' ||
    value === 'cli' ||
    value === 'simulator'
  ) {
    return value;
  }
  return 'anthropic';
}

export function modelClassFromModelId(model: string | undefined): string {
  const lower = (model ?? '').toLowerCase();
  if (lower.includes('haiku')) return 'haiku';
  if (lower.includes('opus')) return 'opus';
  return 'sonnet';
}

function normalizeSelection(value: unknown): GatewaySelection | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const modelClass =
    typeof raw.modelClass === 'string'
      ? raw.modelClass
      : modelClassFromModelId(
          typeof raw.model === 'string' ? raw.model : undefined,
        );
  const systemDefault = raw.systemDefault === true;
  const modelOverride =
    typeof raw.modelOverride === 'string' && raw.modelOverride.trim()
      ? raw.modelOverride.trim()
      : undefined;
  const thinkingLevel =
    typeof raw.thinkingLevel === 'string' && raw.thinkingLevel.trim()
      ? raw.thinkingLevel.trim()
      : undefined;
  return {
    adapter: normalizeAdapter(raw.adapter),
    modelClass,
    ...(modelOverride ? { modelOverride } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(systemDefault ? { systemDefault: true } : {}),
    ...(systemDefault
      ? {}
      : {
          providerId:
            typeof raw.providerId === 'string' && raw.providerId
              ? raw.providerId
              : undefined,
          channelId:
            typeof raw.channelId === 'string' && raw.channelId
              ? raw.channelId
              : undefined,
        }),
  };
}

function normalizeProvider(value: unknown): GatewayProvider | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  const providerId = raw.id;
  const adapter = normalizeAdapter(raw.adapter);
  const kind = typeof raw.kind === 'string' ? raw.kind : adapter;
  const rawChannels = Array.isArray(raw.channels) ? raw.channels : [];
  const channels = rawChannels
    .map((channel) => {
      if (typeof channel !== 'object' || channel === null) return null;
      const c = channel as Record<string, unknown>;
      const route =
        typeof c.route === 'object' && c.route !== null
          ? (c.route as Record<string, unknown>)
          : {};
      return {
        id: typeof c.id === 'string' && c.id ? c.id : 'default',
        name: typeof c.name === 'string' && c.name ? c.name : 'Default',
        apiKey: gatewayChannelApiKey(
          providerId,
          typeof c.id === 'string' && c.id ? c.id : 'default',
          typeof c.apiKey === 'string' ? c.apiKey : undefined,
        ),
        baseUrl: typeof c.baseUrl === 'string' ? c.baseUrl : undefined,
        model: typeof c.model === 'string' ? c.model : undefined,
        models:
          typeof c.models === 'object' && c.models !== null
            ? stringRecord(c.models)
            : undefined,
        route: {
          transport: normalizeTransport(route.transport ?? kind),
          baseUrl:
            typeof route.baseUrl === 'string' ? route.baseUrl : undefined,
          model: typeof route.model === 'string' ? route.model : undefined,
          models:
            typeof route.models === 'object' && route.models !== null
              ? stringRecord(route.models)
              : undefined,
        },
      };
    })
    .filter((channel): channel is GatewayProvider['channels'][number] =>
      Boolean(channel),
    );
  return {
    id: providerId,
    kind,
    name: typeof raw.name === 'string' && raw.name ? raw.name : raw.id,
    adapter,
    channels,
  };
}

function gatewayChannelApiKey(
  providerId: string,
  channelId: string,
  fallback?: string,
): string | undefined {
  // The secure cache contains individually verified healthy records; a failure
  // in a different record must not blank this channel's already loaded key.
  return (
    readSecureRecordValue(
      GATEWAY_CHANNEL_API_KEYS_SECRET,
      gatewayChannelSecretKey(providerId, channelId),
    ) ||
    readSecureRecordValue(PROVIDER_API_KEYS_SECRET, providerId) ||
    (secureStorageAllowsInlineFallback(GATEWAY_CHANNEL_API_KEYS_SECRET)
      && secureStorageAllowsInlineFallback(PROVIDER_API_KEYS_SECRET) ? fallback : undefined)
  );
}

function stringRecord(value: object): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === 'string') out[key] = val;
  }
  return out;
}

function readStoredGatewayConfig(): GatewayConfig {
  if (isRemoteProfileActive()) return readRemoteProfileGatewayConfig();
  return readLocalStoredGatewayConfig();
}

/**
 * Remote profile: gateway providers come from the project's `/user-settings`
 * with API keys inlined (no keychain). remote-runner/freecc execution channels
 * stay sourced locally so the active project can still run.
 */
function readRemoteProfileGatewayConfig(): GatewayConfig {
  const localKept = readLocalStoredGatewayConfig().providers.filter((provider) =>
    isLocalOnlyGatewayId(provider.id),
  );
  const stored = readRemoteProfileRaw(GATEWAY_PROFILE_RELPATH);
  let remote: GatewayProvider[] = [];
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as unknown;
      const raw =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as Record<string, unknown>)
          : {};
      remote = Array.isArray(raw.providers)
        ? raw.providers
            .map(normalizeProviderInlineKeys)
            .filter((p): p is GatewayProvider => p !== null)
            .filter((p) => !isLocalOnlyGatewayId(p.id))
        : [];
    } catch {
      remote = [];
    }
  }
  const seen = new Set(remote.map((p) => p.id));
  return {
    version: 1,
    providers: [...remote, ...localKept.filter((p) => !seen.has(p.id))],
  };
}

/** Like normalizeProvider but trusts inline channel.apiKey (remote profile). */
function normalizeProviderInlineKeys(value: unknown): GatewayProvider | null {
  const base = normalizeProvider(value);
  if (!base) return null;
  if (typeof value !== 'object' || value === null) return base;
  const rawChannels = (value as Record<string, unknown>).channels;
  if (!Array.isArray(rawChannels)) return base;
  return {
    ...base,
    channels: base.channels.map((channel, i) => {
      const raw = rawChannels[i];
      const inlineKey =
        typeof raw === 'object' && raw !== null
          ? (raw as Record<string, unknown>).apiKey
          : undefined;
      return typeof inlineKey === 'string' && inlineKey
        ? { ...channel, apiKey: inlineKey }
        : channel;
    }),
  };
}

function readLocalStoredGatewayConfig(): GatewayConfig {
  const stored = rawGet(GATEWAY_CONFIG_STORAGE);
  if (!stored) return { version: 1, providers: [] };
  try {
    const parsed = JSON.parse(stored) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      return { version: 1, providers: [] };
    }
    const raw = parsed as Record<string, unknown>;
    const providers = Array.isArray(raw.providers)
      ? raw.providers
          .map(normalizeProvider)
          .filter((provider): provider is GatewayProvider => provider !== null)
      : [];
    if (
      secureStorageAvailable() &&
      Array.isArray(raw.providers) &&
      raw.providers.some(providerHasInlineApiKey)
    ) {
      saveGatewayConfig({ version: 1, providers });
    }
    return { version: 1, providers };
  } catch {
    return { version: 1, providers: [] };
  }
}

function providerHasInlineApiKey(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const channels = (value as Record<string, unknown>).channels;
  return (
    Array.isArray(channels) &&
    channels.some(
      (channel) =>
        typeof channel === 'object' &&
        channel !== null &&
        typeof (channel as Record<string, unknown>).apiKey === 'string',
    )
  );
}

export function preferredGatewayProvider(
  providers: GatewayProvider[],
  adapter: RuntimeAdapterId,
): GatewayProvider | undefined {
  // Free channels (freecc:*) are synthetic providers that must only be used
  // when the user explicitly selects them. Exclude them from the implicit
  // default so an unconfigured user keeps the plain system claude-code default
  // instead of being silently routed to a free upstream they never set up.
  const matches = providers.filter(
    (provider) =>
      provider.adapter === adapter &&
      !provider.id.startsWith(FREE_CHANNEL_PROVIDER_PREFIX),
  );
  return (
    matches.find((provider) =>
      provider.channels.some((channel) => channel.route.transport === 'cli'),
    ) ?? matches[0]
  );
}

function selectionFromProvider(provider: GatewayProvider): GatewaySelection {
  const channel = provider.channels[0];
  return {
    adapter: provider.adapter,
    modelClass: modelClassFromModelId(channel?.model),
    providerId: provider.id,
    channelId: channel?.id,
  };
}

export function loadGatewayConfig(): GatewayConfig {
  const stored = readStoredGatewayConfig();
  const free = freeChannelGatewayProviders();
  // The gateway mirror is now maintained exclusively by apiConfig's sync path
  // (add/update/delete/import) plus the boot-time `syncGatewayFromProviders()`.
  // We deliberately no longer overlay `readLegacyProviders()` here: that legacy
  // overlay read the best-effort localStorage mirror of `ugs_providers`, which
  // goes stale when the 5MB localStorage quota fills, and then re-clobbered the
  // freshly-synced gateway name with an old one (e.g. "ExampleGemini" rendered as
  // "ExampleAI" in the run header while the channel picker showed "ExampleGemini").
  return { version: 1, providers: [...stored.providers, ...free] };
}

export function saveGatewayConfig(config: GatewayConfig): void {
  if (isRemoteProfileActive()) {
    saveGatewayConfigForRemoteProfile(config);
    return;
  }
  if (tauriAvailable() && (!secureStorageAvailable() || diskReadErrors.has(GATEWAY_CONFIG_STORAGE))) {
    throw new Error('渠道安全存储尚未加载成功，已阻止覆盖网关配置。请重试后再保存。');
  }
  if (secureStorageAvailable()) {
    // Merge, never replace: this runs on every boot-time sync from the
    // provider list, where channels whose apiKey failed to hydrate into memory
    // (transient keychain read failure) carry `undefined`. Replacing the whole
    // record with that partial view wiped every other channel's token.
    // Removals are handled explicitly by removeGatewayProvider in apiConfig.
    const apiKeys = readSecureRecord(GATEWAY_CHANNEL_API_KEYS_SECRET);
    for (const provider of config.providers) {
      for (const channel of provider.channels) {
        const apiKey = channel.apiKey?.trim();
        if (apiKey) {
          apiKeys[gatewayChannelSecretKey(provider.id, channel.id)] = apiKey;
        }
      }
    }
    writeSecureRecord(GATEWAY_CHANNEL_API_KEYS_SECRET, apiKeys);
  }
  rawSet(
    GATEWAY_CONFIG_STORAGE,
    JSON.stringify({
      version: 1,
      providers: config.providers.map(gatewayProviderForStorage),
    }),
  );
}

/**
 * Remote profile: persist ordinary gateway providers (API keys inlined) to the
 * project's `/user-settings`. remote-runner/freecc channels are not per-project,
 * so they are excluded here and remain in the local store.
 */
function saveGatewayConfigForRemoteProfile(config: GatewayConfig): void {
  const ordinary = config.providers.filter(
    (provider) => !isLocalOnlyGatewayId(provider.id),
  );
  writeRemoteProfileRaw(
    GATEWAY_PROFILE_RELPATH,
    JSON.stringify({
      version: 1,
      providers: ordinary.map((provider) => ({
        ...provider,
        channels: provider.channels.map((channel) => ({
          ...channel,
          // Inline the key for cross-device sync (per product choice).
          apiKey: channel.apiKey ?? undefined,
          route: { ...channel.route },
        })),
      })),
    }),
  );
  if (hasWindow()) {
    window.dispatchEvent(new Event('ugs:gateway-config-changed'));
  }
}

function gatewayProviderForStorage(provider: GatewayProvider): GatewayProvider {
  if (!secureStorageAvailable()) {
    return {
      ...provider,
      channels: provider.channels.map((channel) => ({
        ...channel,
        route: { ...channel.route },
      })),
    };
  }
  return {
    ...provider,
    channels: provider.channels.map((channel) => {
      return { ...channel, apiKey: undefined, route: { ...channel.route } };
    }),
  };
}

export function listGatewayProviders(): GatewayProvider[] {
  return loadGatewayConfig().providers;
}

export function getExplicitActiveGatewaySelection(): GatewaySelection | null {
  const stored = isRemoteProfileActive()
    ? readRemoteProfileRaw(ACTIVE_SELECTION_PROFILE_RELPATH)
    : rawGet(ACTIVE_GATEWAY_SELECTION_STORAGE);
  if (stored) {
    try {
      const selection = normalizeSelection(JSON.parse(stored));
      if (selection) return selection;
    } catch {
      /* fall through to legacy active provider */
    }
  }
  if (isRemoteProfileActive()) return null;

  const activeProviderId = (rawGet(LEGACY_ACTIVE_PROVIDER_STORAGE) ?? '').trim();
  if (!activeProviderId) return null;
  const providers = loadGatewayConfig().providers;
  const provider = providers.find((candidate) => candidate.id === activeProviderId);
  return provider ? selectionFromProvider(provider) : null;
}

export function getDefaultGatewaySelection(): GatewaySelection {
  const provider = preferredGatewayProvider(
    loadGatewayConfig().providers,
    'claude-code',
  );
  return provider ? selectionFromProvider(provider) : DEFAULT_GATEWAY_SELECTION;
}

export function getActiveGatewaySelection(): GatewaySelection {
  return getExplicitActiveGatewaySelection() ?? getDefaultGatewaySelection();
}

export function setActiveGatewaySelection(selection: GatewaySelection): void {
  if (isRemoteProfileActive()) {
    writeRemoteProfileRaw(
      ACTIVE_SELECTION_PROFILE_RELPATH,
      JSON.stringify(selection),
    );
    if (hasWindow()) {
      window.dispatchEvent(new Event('ugs:gateway-config-changed'));
    }
    return;
  }
  rawSet(ACTIVE_GATEWAY_SELECTION_STORAGE, JSON.stringify(selection));
}

export const writeStoredGatewaySelection = setActiveGatewaySelection;

/**
 * Clear the explicit composer/run model pin so resolution falls back to the
 * Settings-active provider (the "inherit global selection" state). Leaves the
 * Settings active provider and the legacy pointer untouched.
 */
export function clearActiveGatewaySelection(): void {
  if (isRemoteProfileActive()) {
    writeRemoteProfileRaw(ACTIVE_SELECTION_PROFILE_RELPATH, 'null');
    if (hasWindow()) {
      window.dispatchEvent(new Event('ugs:gateway-config-changed'));
    }
    return;
  }
  rawRemove(ACTIVE_GATEWAY_SELECTION_STORAGE);
}

/**
 * True when an explicit composer/run model pin is stored — i.e. the user has
 * chosen a specific channel rather than inheriting the global default.
 */
export function hasExplicitGatewayPin(): boolean {
  const stored = isRemoteProfileActive()
    ? readRemoteProfileRaw(ACTIVE_SELECTION_PROFILE_RELPATH)
    : rawGet(ACTIVE_GATEWAY_SELECTION_STORAGE);
  if (!stored) return false;
  try {
    return normalizeSelection(JSON.parse(stored)) !== null;
  } catch {
    return false;
  }
}

export function workflowGatewaySelection(
  workflow: IRGraph,
  fallbackModel?: string,
): GatewaySelection {
  const current = getExplicitActiveGatewaySelection();
  if (current) {
    return {
      ...current,
      adapter: normalizeAdapter(current.adapter),
      modelClass: current.modelClass || modelClassFromModelId(fallbackModel),
    };
  }

  const defaults = workflow.meta.gateway?.defaults;
  if (defaults) {
    return {
      adapter: normalizeAdapter(defaults.adapter),
      modelClass: defaults.modelClass || modelClassFromModelId(fallbackModel),
      providerId: defaults.providerId,
      channelId: defaults.channelId,
    };
  }
  const stored = getDefaultGatewaySelection();
  return {
    ...stored,
    adapter: normalizeAdapter(workflow.meta.adapter ?? stored.adapter),
    modelClass: stored.modelClass || modelClassFromModelId(fallbackModel),
  };
}

export function withGatewayDefaults(
  workflow: IRGraph,
  selection: GatewaySelection,
): IRGraph {
  const normalized = normalizeSelection(selection) ?? DEFAULT_GATEWAY_SELECTION;
  return {
    ...workflow,
    meta: {
      ...workflow.meta,
      adapter: normalized.adapter,
      gateway: {
        ...(workflow.meta.gateway ?? {}),
        defaults: normalized,
      },
    },
  };
}

export function migrateWorkflowGateway(
  workflow: IRGraph,
  fallbackModel?: string,
): IRGraph {
  const defaults = workflowGatewaySelection(workflow, fallbackModel);
  let changed =
    workflow.meta.adapter !== defaults.adapter || !workflow.meta.gateway?.defaults;
  const nodes = workflow.nodes.map((node) => {
    const normalized = normalizeWorkflowGatewayParams(node.params);
    if (normalized === node.params) return node;
    changed = true;
    return { ...node, params: normalized };
  });
  const next = withGatewayDefaults({ ...workflow, nodes }, defaults);
  return changed ? next : workflow;
}

function normalizeWorkflowGatewayParams(
  params: Record<string, unknown>,
): Record<string, unknown> {
  let next: Record<string, unknown> | null = null;
  const ensureNext = () => {
    next ??= { ...params };
    return next;
  };

  if (params.model === 'sonnet' && !hasGatewayObject(params.gateway)) {
    delete ensureNext().model;
  }

  for (const key of ['branches', 'stages'] as const) {
    const value = (next ?? params)[key];
    const normalized = normalizeWorkflowGatewaySpecList(value);
    if (normalized !== value) ensureNext()[key] = normalized;
  }

  return next ?? params;
}

function normalizeWorkflowGatewaySpecList(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  let next: unknown[] | null = null;
  value.forEach((item, index) => {
    if (
      typeof item !== 'object' ||
      item === null ||
      Array.isArray(item) ||
      (item as Record<string, unknown>).model !== 'sonnet' ||
      hasGatewayObject((item as Record<string, unknown>).gateway)
    ) {
      return;
    }
    next ??= [...value];
    const spec = { ...(item as Record<string, unknown>) };
    delete spec.model;
    next[index] = spec;
  });
  return next ?? value;
}

function hasGatewayObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}
