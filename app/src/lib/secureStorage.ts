import {
  isTauri,
  secureSecretDelete,
  secureSecretGetMany,
  secureSecretSet,
} from "@/lib/tauri";

export const PROVIDER_API_KEYS_SECRET = "providers.apiKeys.v1";
export const GATEWAY_CHANNEL_API_KEYS_SECRET = "gateway.channelApiKeys.v1";
export const FREE_CHANNEL_API_KEYS_SECRET = "freeChannels.apiKeys.v1";
export const FREE_PROXY_TOKEN_SECRET = "freeProxy.token.v1";
export const REMOTE_WORKSPACE_SECRET = "remoteWorkspaces.secrets.v1";
export const REMOTE_RUNNER_CONNECTION_SECRET = "remoteRunner.connection.v1";

const SECRET_NAMES = [
  PROVIDER_API_KEYS_SECRET,
  GATEWAY_CHANNEL_API_KEYS_SECRET,
  FREE_CHANNEL_API_KEYS_SECRET,
  FREE_PROXY_TOKEN_SECRET,
  REMOTE_WORKSPACE_SECRET,
  REMOTE_RUNNER_CONNECTION_SECRET,
];

const PROVIDERS_STORAGE = "ugs_providers";
const ACTIVE_PROVIDER_STORAGE = "ugs_active_provider_id";
const API_KEY_STORAGE = "ugs_anthropic_key";
const BASE_URL_STORAGE = "ugs_anthropic_base_url";
const GATEWAY_CONFIG_STORAGE = "ugs_model_gateway_v1";
const FREE_CHANNEL_KEYS_STORAGE = "ugs_free_channel_keys_v1";
const FREE_PROXY_TOKEN_STORAGE = "ugs_free_proxy_token_v1";
const LEGACY_FREE_CHANNEL_KEYS_STORAGE = [
  "owf_free_channel_keys_v1",
  "ultragamestudio.free_channel_keys_v1",
  "ultragamestudio.freeChannels.keys",
];

const memorySecrets = new Map<string, string>();
const secretReadErrors = new Map<string, unknown>();
const storedSecretNames = new Set<string>();
let initialized = false;
let initializationPromise: Promise<void> | null = null;
let readsCompleted = false;
let initializationError: unknown = null;
let secureReady = false;

export function secureStorageAvailable(): boolean {
  return secureReady;
}

/** A failed/pending read is not an absent secret; callers must not hydrate it. */
export function secureStorageReadFailed(secretName: string): boolean {
  return isTauri() && (!readsCompleted || secretReadErrors.has(secretName));
}

/** Inline values are a first-migration source, never a deleted-entry fallback. */
export function secureStorageAllowsInlineFallback(secretName: string): boolean {
  return !isTauri() || (readsCompleted && !initializationPromise
    && !secretReadErrors.has(secretName) && !storedSecretNames.has(secretName)
    && !secretWriteChains.has(secretName) && !secretWriteErrors.has(secretName));
}

function assertSecretWritable(secretName: string, duringInitialization = false): void {
  if (!isTauri()) return;
  if (!readsCompleted || (initializationPromise && !duringInitialization)) {
    throw new Error(`安全存储尚未完成初始化 (${secretName})`);
  }
  if (secretReadErrors.has(secretName)) {
    throw new Error(`安全存储读取失败 (${secretName})，拒绝覆盖未读取的密钥`);
  }
}

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

function rawGet(key: string): string | null {
  try {
    if (!hasWindow()) return null;
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function rawSet(key: string, value: string): void {
  try {
    if (!hasWindow()) return;
    window.localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function rawRemove(key: string): void {
  try {
    if (!hasWindow()) return;
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function parseStringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed) out[key] = trimmed;
  }
  return out;
}

function parseStoredRecord(key: string): Record<string, string> {
  return parseStringRecord(parseJsonObject(rawGet(key)));
}

function parseSecretRecord(secretName: string): Record<string, string> {
  return parseStringRecord(
    parseJsonObject(memorySecrets.get(secretName) ?? null),
  );
}

function serializeRecord(record: Record<string, string>): string {
  const clean: Record<string, string> = {};
  for (const [key, raw] of Object.entries(record)) {
    const value = raw.trim();
    if (value) clean[key] = value;
  }
  return Object.keys(clean).length > 0 ? JSON.stringify(clean) : "";
}

function cacheSecret(secretName: string, value: string): void {
  if (value) memorySecrets.set(secretName, value);
  else memorySecrets.delete(secretName);
}

function cacheLoadedSecret(secretName: string, loaded: Record<string, string>): void {
  // Only an omitted native record is eligible for first-time inline migration.
  // An existing record owns even its absent entries (including partial deletes).
  // Native whole-record delete tombstones are own empty-string entries, so they
  // remain authoritative too; genuinely never-stored records are omitted.
  if (Object.prototype.hasOwnProperty.call(loaded, secretName)) {
    storedSecretNames.add(secretName);
  } else {
    storedSecretNames.delete(secretName);
  }
  cacheSecret(secretName, loaded[secretName] ?? '');
  secretReadErrors.delete(secretName);
}

const pendingSecretWrites = new Set<Promise<void>>();
const secretWriteChains = new Map<string, Promise<void>>();
const secretWriteErrors = new Map<string, unknown>();
const latestSecretWrites = new Map<string, string>();

function queueSecretPersistence(
  secretName: string,
  value: string,
): Promise<void> {
  latestSecretWrites.set(secretName, value);
  const active = secretWriteChains.get(secretName);
  if (active) return active;

  const task = (async () => {
    while (latestSecretWrites.has(secretName)) {
      const next = latestSecretWrites.get(secretName) ?? '';
      latestSecretWrites.delete(secretName);
      try {
        if (next) await secureSecretSet(secretName, next);
        else await secureSecretDelete(secretName);
        // This session's successful writes/deletes establish native ownership
        // just like an own record read during startup, including tombstones.
        storedSecretNames.add(secretName);
        secretWriteErrors.delete(secretName);
      } catch (err) {
        secretWriteErrors.set(secretName, err);
      }
    }
    const error = secretWriteErrors.get(secretName);
    if (error) throw error;
  })();
  secretWriteChains.set(secretName, task);
  pendingSecretWrites.add(task);
  const finalize = () => {
    pendingSecretWrites.delete(task);
    if (secretWriteChains.get(secretName) === task) {
      secretWriteChains.delete(secretName);
    }
    if (latestSecretWrites.has(secretName)) {
      void queueSecretPersistence(
        secretName,
        latestSecretWrites.get(secretName) ?? '',
      ).catch(() => undefined);
    }
  };
  void task.then(finalize, (error) => {
    finalize();
    console.warn('[secureStorage] failed to persist secret', secretName, error);
  });
  return task;
}

async function persistSecretNow(
  secretName: string,
  value: string,
): Promise<void> {
  assertSecretWritable(secretName, true);
  cacheSecret(secretName, value);
  if (!isTauri()) return;
  await queueSecretPersistence(secretName, value);
}

function persistSecretSoon(secretName: string, value: string): void {
  assertSecretWritable(secretName);
  cacheSecret(secretName, value);
  if (!isTauri()) return;
  void queueSecretPersistence(secretName, value).catch(() => undefined);
}

async function drainSecretWrites(): Promise<void> {
  while (pendingSecretWrites.size > 0) {
    await Promise.allSettled([...pendingSecretWrites]);
  }
  if (secretWriteErrors.size > 0) {
    const [secretName, error] = secretWriteErrors.entries().next().value as [
      string,
      unknown,
    ];
    throw new Error(`安全存储写入失败 (${secretName}): ${String(error)}`);
  }
}

/**
 * Await all in-flight OS keychain writes so callers can confirm secrets actually
 * reached durable storage before claiming success (or before the app exits).
 * A failed desktop read/initialization is an error, not a successful flush.
 * Browser builds keep their memory-only behavior.
 */
export async function flushSecureStorage(): Promise<void> {
  if (!isTauri()) return;
  if (initializationPromise) await initializationPromise;
  else if (!readsCompleted) await initializeSecureStorage();
  await drainSecretWrites();
  if (secretReadErrors.size > 0) {
    assertSecretWritable(secretReadErrors.keys().next().value!);
  }
  if (initializationError) throw new Error('安全存储初始化失败，尚未完成安全迁移');
  if (!readsCompleted) throw new Error('安全存储尚未完成初始化');
}

/**
 * Synchronous-write variant of {@link writeSecureRecord}: waits for the OS keychain
 * call to complete before returning. Use this when the caller must guarantee the
 * secret is durable before continuing (e.g., before closing a settings dialog).
 */
export async function writeSecureRecordAwaited(
  secretName: string,
  record: Record<string, string>,
): Promise<void> {
  if (isTauri()) {
    if (initializationPromise) await initializationPromise;
    else if (!readsCompleted) await initializeSecureStorage();
  }
  assertSecretWritable(secretName);
  const next = serializeRecord(record);
  const prev = memorySecrets.get(secretName) ?? "";
  if (next === prev && !secretWriteErrors.has(secretName)) {
    // Matching optimistic memory does not prove the accepted native write is
    // durable. Join its chain so a delayed failure reaches this awaited caller.
    await secretWriteChains.get(secretName);
    return;
  }
  await persistSecretNow(secretName, next);
}

export function readSecureRecord(secretName: string): Record<string, string> {
  return parseSecretRecord(secretName);
}

export function readSecureRecordValue(secretName: string, key: string): string {
  return readSecureRecord(secretName)[key] ?? "";
}

export function writeSecureRecord(
  secretName: string,
  record: Record<string, string>,
): boolean {
  assertSecretWritable(secretName);
  const next = serializeRecord(record);
  const prev = memorySecrets.get(secretName) ?? "";
  if (next === prev && !secretWriteErrors.has(secretName)) return false;
  persistSecretSoon(secretName, next);
  return true;
}

export function setSecureRecordValue(
  secretName: string,
  key: string,
  value: string,
): boolean {
  const record = readSecureRecord(secretName);
  const trimmed = value.trim();
  if (trimmed) record[key] = trimmed;
  else delete record[key];
  return writeSecureRecord(secretName, record);
}

export function readSecureSecret(secretName: string): string {
  return memorySecrets.get(secretName) ?? "";
}

export function writeSecureSecret(secretName: string, value: string): boolean {
  assertSecretWritable(secretName);
  const next = value.trim();
  const prev = memorySecrets.get(secretName) ?? "";
  if (next === prev && !secretWriteErrors.has(secretName)) return false;
  persistSecretSoon(secretName, next);
  return true;
}

export function gatewayChannelSecretKey(
  providerId: string,
  channelId: string,
): string {
  return JSON.stringify([providerId, channelId]);
}

function genProviderId(): string {
  try {
    const crypto = globalThis.crypto;
    if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* ignore */
  }
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function stripProviderSecrets(providerKeys: Record<string, string>, migrateKeys: boolean): {
  value: string | null;
  changed: boolean;
} {
  const raw = rawGet(PROVIDERS_STORAGE);
  if (raw === null) {
    if (!migrateKeys) return { value: null, changed: false };
    const legacyKey = (rawGet(API_KEY_STORAGE) ?? "").trim();
    if (!legacyKey) return { value: null, changed: false };
    const id = genProviderId();
    providerKeys[id] = legacyKey;
    const provider = {
      id,
      kind: "anthropic",
      name: "Claude",
      baseUrl: (rawGet(BASE_URL_STORAGE) ?? "").trim(),
    };
    rawSet(ACTIVE_PROVIDER_STORAGE, id);
    return { value: JSON.stringify([provider]), changed: true };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return { value: null, changed: false };
    let changed = false;
    const sanitized = parsed.map((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        return item;
      }
      const record = item as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id : "";
      const apiKey =
        typeof record.apiKey === "string" ? record.apiKey.trim() : "";
      // Import only into a genuinely missing native logical record. An absent
      // entry in an existing record may have been deleted after this quit mirror.
      if (migrateKeys && id && apiKey && !providerKeys[id]) providerKeys[id] = apiKey;
      if ("apiKey" in record) {
        changed = true;
        const rest = { ...record };
        delete rest.apiKey;
        return rest;
      }
      return item;
    });
    return { value: changed ? JSON.stringify(sanitized) : null, changed };
  } catch {
    return { value: null, changed: false };
  }
}

function stripGatewaySecrets(gatewayKeys: Record<string, string>, migrateKeys: boolean): {
  value: string | null;
  changed: boolean;
} {
  const raw = parseJsonObject(rawGet(GATEWAY_CONFIG_STORAGE));
  if (!raw || !Array.isArray(raw.providers))
    return { value: null, changed: false };
  let changed = false;
  const providers = raw.providers.map((provider) => {
    if (
      typeof provider !== "object" ||
      provider === null ||
      Array.isArray(provider)
    ) {
      return provider;
    }
    const providerRecord = provider as Record<string, unknown>;
    const providerId =
      typeof providerRecord.id === "string" ? providerRecord.id : "";
    if (!Array.isArray(providerRecord.channels)) return provider;
    const channels = providerRecord.channels.map((channel) => {
      if (
        typeof channel !== "object" ||
        channel === null ||
        Array.isArray(channel)
      ) {
        return channel;
      }
      const channelRecord = channel as Record<string, unknown>;
      const channelId =
        typeof channelRecord.id === "string" && channelRecord.id
          ? channelRecord.id
          : "default";
      const apiKey =
        typeof channelRecord.apiKey === "string"
          ? channelRecord.apiKey.trim()
          : "";
      if (migrateKeys && providerId && apiKey) {
        const key = gatewayChannelSecretKey(providerId, channelId);
        if (!gatewayKeys[key]) gatewayKeys[key] = apiKey;
      }
      if ("apiKey" in channelRecord) {
        changed = true;
        const rest = { ...channelRecord };
        delete rest.apiKey;
        return rest;
      }
      return channel;
    });
    return { ...providerRecord, channels };
  });
  return {
    value: changed ? JSON.stringify({ ...raw, providers }) : null,
    changed,
  };
}

function collectFreeChannelKeys(): {
  record: Record<string, string>;
  keysToRemove: string[];
} {
  const record = parseStoredRecord(FREE_CHANNEL_KEYS_STORAGE);
  const keysToRemove = [FREE_CHANNEL_KEYS_STORAGE];
  for (const legacyKey of LEGACY_FREE_CHANNEL_KEYS_STORAGE) {
    const legacy = parseStoredRecord(legacyKey);
    for (const [id, value] of Object.entries(legacy)) {
      if (!record[id]) record[id] = value;
    }
    keysToRemove.push(legacyKey);
  }
  return { record, keysToRemove };
}

async function persistVerifiedMigration(secretName: string, value: string): Promise<void> {
  const previous = memorySecrets.get(secretName) ?? '';
  try {
    await persistSecretNow(secretName, value);
    const readback = await secureSecretGetMany([secretName]);
    if ((readback[secretName] ?? '') !== value) {
      throw new Error(`安全存储迁移校验失败 (${secretName})`);
    }
  } catch (error) {
    // A resolved write is not enough to discard the last recoverable fallback.
    cacheSecret(secretName, previous);
    secretReadErrors.set(secretName, error);
    throw error;
  }
}

async function migrateLocalStorageSecrets(): Promise<void> {
  const providerKeys = readSecureRecord(PROVIDER_API_KEYS_SECRET);
  const gatewayKeys = readSecureRecord(GATEWAY_CHANNEL_API_KEYS_SECRET);
  const freeChannelKeys = readSecureRecord(FREE_CHANNEL_API_KEYS_SECRET);
  const providerStorage = stripProviderSecrets(providerKeys, !storedSecretNames.has(PROVIDER_API_KEYS_SECRET));
  const gatewayStorage = stripGatewaySecrets(gatewayKeys, !storedSecretNames.has(GATEWAY_CHANNEL_API_KEYS_SECRET));
  const freeKeys = collectFreeChannelKeys();
  for (const [id, value] of Object.entries(freeKeys.record)) {
    if (value && !storedSecretNames.has(FREE_CHANNEL_API_KEYS_SECRET)) freeChannelKeys[id] = value;
  }
  const proxyToken = (rawGet(FREE_PROXY_TOKEN_STORAGE) ?? "").trim();

  // Persist back ONLY when the migration actually merged/stripped something.
  // The previous version rewrote all three records on every boot; for chunked
  // (oversized) records each rewrite re-shards and then deletes the old
  // shards, so every boot opened a fresh crash window in which the manifest
  // could end up pointing at deleted shards — after which the next save of an
  // unrelated provider could truncate the whole record.
  const providerSerialized = serializeRecord(providerKeys);
  if (providerSerialized !== serializeRecord(readSecureRecord(PROVIDER_API_KEYS_SECRET))) {
    await persistVerifiedMigration(PROVIDER_API_KEYS_SECRET, providerSerialized);
  }
  const gatewaySerialized = serializeRecord(gatewayKeys);
  if (gatewaySerialized !== serializeRecord(readSecureRecord(GATEWAY_CHANNEL_API_KEYS_SECRET))) {
    await persistVerifiedMigration(GATEWAY_CHANNEL_API_KEYS_SECRET, gatewaySerialized);
  }
  const freeChannelSerialized = serializeRecord(freeChannelKeys);
  if (freeChannelSerialized !== serializeRecord(readSecureRecord(FREE_CHANNEL_API_KEYS_SECRET))) {
    await persistVerifiedMigration(FREE_CHANNEL_API_KEYS_SECRET, freeChannelSerialized);
  }
  if (proxyToken && !storedSecretNames.has(FREE_PROXY_TOKEN_SECRET)
    && proxyToken !== readSecureSecret(FREE_PROXY_TOKEN_SECRET)) {
    await persistVerifiedMigration(FREE_PROXY_TOKEN_SECRET, proxyToken);
  }

  if (providerStorage.value !== null)
    rawSet(PROVIDERS_STORAGE, providerStorage.value);
  if (gatewayStorage.value !== null) {
    rawSet(GATEWAY_CONFIG_STORAGE, gatewayStorage.value);
  }
  for (const key of freeKeys.keysToRemove) rawRemove(key);
  rawRemove(API_KEY_STORAGE);
  rawRemove(FREE_PROXY_TOKEN_STORAGE);
}

async function loadSecureStorage(): Promise<void> {
  initializationError = null;
  try {
    // The initialization promise gates new public writes before this task starts.
    // Drain accepted optimistic writes before taking a read/migration snapshot;
    // a failed write must retain its cache/error rather than reload stale data.
    if (pendingSecretWrites.size > 0 || secretWriteErrors.size > 0) {
      await drainSecretWrites();
    }
    try {
      const loaded = await secureSecretGetMany(SECRET_NAMES);
      for (const name of SECRET_NAMES) {
        cacheLoadedSecret(name, loaded);
      }
    } catch {
      // One damaged record must not hide every other healthy secret.
      await Promise.all(SECRET_NAMES.map(async (name) => {
        try {
          const loaded = await secureSecretGetMany([name]);
          cacheLoadedSecret(name, loaded);
        } catch (error) {
          secretReadErrors.set(name, error);
        }
      }));
    }
    readsCompleted = true;
    // Neither complete mirrors nor readback prove freshness of an unreadable
    // primary. Without an atomic native precondition, recovery must be manual.
    secureReady = secretReadErrors.size === 0;
    if (!secureReady) return;
    await migrateLocalStorageSecrets();
    initialized = true;
  } catch (err) {
    secureReady = false;
    initializationError = err;
    console.warn(
      "[secureStorage] initialization failed; keeping localStorage fallback",
      err,
    );
  }
}

export function initializeSecureStorage(): Promise<void> {
  if (initializationPromise) return initializationPromise;
  if (initialized) return Promise.resolve();
  if (!isTauri()) {
    initialized = true;
    return Promise.resolve();
  }
  // Install the gate synchronously, before native reads or migration can run.
  const task = Promise.resolve().then(loadSecureStorage);
  initializationPromise = task;
  void task.finally(() => {
    if (initializationPromise === task) initializationPromise = null;
  });
  return task;
}

/**
 * 同步把内存中的密钥记录回写进 localStorage 对应位置，作为「进程即将被终止
 * （如系统托盘右键菜单退出）时 OS keychain 异步写可能尚未落盘」的兜底。
 *
 * 这是纯同步操作（localStorage.setItem），可在 beforeunload / 退出握手事件里
 * 安全调用。下次启动时 initializeSecureStorage 的迁移逻辑（migrateLocalStorageSecrets）
 * 只会在原生逻辑记录从未存储（读取结果省略该记录）时导入明文 key，并经回读
 * 校验后剥离。已有原生记录（包括删除标记及缺失的单项）始终优先，避免旧副本
 * 回滚新值或复活已删除的 key；读取失败时保留恢复副本，不自动覆盖。
 */
export function flushSecretsToLocalStorageFallback(): void {
  if (!hasWindow()) return;

  const providerKeys = readSecureRecord(PROVIDER_API_KEYS_SECRET);
  if (Object.keys(providerKeys).length > 0) {
    const raw = rawGet(PROVIDERS_STORAGE);
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          const next = parsed.map((item) => {
            if (
              typeof item !== "object" ||
              item === null ||
              Array.isArray(item)
            ) {
              return item;
            }
            const record = item as Record<string, unknown>;
            const id = typeof record.id === "string" ? record.id : "";
            const key = id ? providerKeys[id] : "";
            if (!key) return item;
            return { ...record, apiKey: key };
          });
          rawSet(PROVIDERS_STORAGE, JSON.stringify(next));
        }
      } catch {
        /* corrupt — keep the stored value as-is */
      }
    }
  }

  const gatewayKeys = readSecureRecord(GATEWAY_CHANNEL_API_KEYS_SECRET);
  if (Object.keys(gatewayKeys).length > 0) {
    const raw = parseJsonObject(rawGet(GATEWAY_CONFIG_STORAGE));
    if (raw && Array.isArray(raw.providers)) {
      try {
        const providers = raw.providers.map((provider) => {
          if (
            typeof provider !== "object" ||
            provider === null ||
            Array.isArray(provider)
          ) {
            return provider;
          }
          const providerRecord = provider as Record<string, unknown>;
          const providerId =
            typeof providerRecord.id === "string" ? providerRecord.id : "";
          if (!Array.isArray(providerRecord.channels)) return provider;
          const channels = providerRecord.channels.map((channel) => {
            if (
              typeof channel !== "object" ||
              channel === null ||
              Array.isArray(channel)
            ) {
              return channel;
            }
            const channelRecord = channel as Record<string, unknown>;
            const channelId =
              typeof channelRecord.id === "string" && channelRecord.id
                ? channelRecord.id
                : "default";
            const key = providerId
              ? gatewayKeys[gatewayChannelSecretKey(providerId, channelId)]
              : "";
            if (!key) return channel;
            return { ...channelRecord, apiKey: key };
          });
          return { ...providerRecord, channels };
        });
        rawSet(GATEWAY_CONFIG_STORAGE, JSON.stringify({ ...raw, providers }));
      } catch {
        /* corrupt — keep the stored value as-is */
      }
    }
  }

  const freeChannelKeys = readSecureRecord(FREE_CHANNEL_API_KEYS_SECRET);
  if (Object.keys(freeChannelKeys).length > 0) {
    rawSet(FREE_CHANNEL_KEYS_STORAGE, serializeRecord(freeChannelKeys));
  }

  const proxyToken = readSecureSecret(FREE_PROXY_TOKEN_SECRET);
  if (proxyToken) {
    rawSet(FREE_PROXY_TOKEN_STORAGE, proxyToken);
  }
}

export function resetSecureStorageForTests(): void {
  memorySecrets.clear();
  secretReadErrors.clear();
  storedSecretNames.clear();
  pendingSecretWrites.clear();
  secretWriteChains.clear();
  secretWriteErrors.clear();
  latestSecretWrites.clear();
  initialized = false;
  initializationPromise = null;
  readsCompleted = false;
  initializationError = null;
  secureReady = false;
}
