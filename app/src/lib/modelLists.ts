import type { Provider } from '@/lib/apiConfig';
import {
  FREE_CHANNELS,
  FREE_CHANNEL_AUTO_ID,
  FREE_CHANNEL_AUTO_MODEL,
  getFreeChannelKey,
  getFreeChannelModel,
  getFreeChannelModelOverride,
  type FreeChannel,
} from '@/lib/freeChannels';
import { listLocalModels, listRemoteModels, tauriAvailable } from '@/lib/tauri';
import { readSettingsRaw, writeSettingsRaw } from '@/lib/generationSettingsStore';

const MODEL_LIST_CACHE_STORAGE = 'ugs_model_list_cache_v1';
const MODEL_LIST_CACHE_REL_PATH = 'settings/modelListCache.v1.json';
// Models the user explicitly removed (via the × button), keyed by the same cache
// key. These stay hidden even if they are built-in catalog entries or come back
// from a later "fetch models" call, so a deleted/outdated model does not reappear.
const MODEL_LIST_HIDDEN_STORAGE = 'ugs_model_list_hidden_v1';
const MODEL_LIST_HIDDEN_REL_PATH = 'settings/modelListHidden.v1.json';

interface CachedModelList {
  models: string[];
  updatedAt: number;
}

export interface ModelListResult {
  models: string[];
  source: 'remote' | 'local' | 'catalog' | 'cache';
  /** Exact live response, before merging older cached or manually added IDs. */
  availableModels?: string[];
  updatedAt?: number;
  error?: string;
}

type ProviderModelSource = Pick<
  Provider,
  'kind' | 'apiKey' | 'baseUrl' | 'model' | 'models'
>;

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function readCache(): Record<string, CachedModelList> {
  try {
    if (!hasWindow()) return {};
    const raw = readSettingsRaw(MODEL_LIST_CACHE_REL_PATH, MODEL_LIST_CACHE_STORAGE);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Record<string, CachedModelList> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== 'object' || value === null) continue;
      const entry = value as Record<string, unknown>;
      if (!Array.isArray(entry.models)) continue;
      const models = entry.models.filter(
        (model): model is string => typeof model === 'string' && !!model.trim(),
      );
      const updatedAt =
        typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt)
          ? entry.updatedAt
          : 0;
      out[key] = { models: uniqueModels(models), updatedAt };
    }
    return out;
  } catch {
    return {};
  }
}

function writeCache(cache: Record<string, CachedModelList>): void {
  if (!hasWindow()) return;
  const next = JSON.stringify(cache);
  if (readSettingsRaw(MODEL_LIST_CACHE_REL_PATH, MODEL_LIST_CACHE_STORAGE) === next) {
    return;
  }
  if (!writeSettingsRaw(MODEL_LIST_CACHE_REL_PATH, MODEL_LIST_CACHE_STORAGE, next)) {
    console.error('[modelLists] failed to persist model cache');
    return;
  }
  window.dispatchEvent(new Event('ugs:model-list-changed'));
}

function sameModels(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((model, index) => model === b[index]);
}

function saveCachedModels(key: string, models: string[]): CachedModelList {
  const cache = readCache();
  const normalized = uniqueModels(models);
  const existing = cache[key];
  if (existing && sameModels(existing.models, normalized)) return existing;
  const entry = { models: normalized, updatedAt: Date.now() };
  writeCache({ ...cache, [key]: entry });
  return entry;
}

export function getCachedModels(key: string): CachedModelList | null {
  const cached = readCache()[key];
  return cached && cached.models.length > 0 ? cached : null;
}

export function addCachedModel(key: string, model: string): CachedModelList | null {
  return addCachedModels(key, [model]);
}

export function addCachedModels(
  key: string,
  models: Array<string | undefined | null>,
): CachedModelList | null {
  const additions = uniqueModels(models);
  if (additions.length === 0) return getCachedModels(key);
  const cached = getCachedModels(key);
  return saveCachedModels(key, [...additions, ...(cached?.models ?? [])]);
}

export function removeCachedModel(key: string, model: string): CachedModelList | null {
  const trimmed = model.trim();
  if (!trimmed) return getCachedModels(key);
  const cache = readCache();
  const existing = cache[key];
  if (!existing) return null;
  const nextModels = existing.models.filter(
    (item) => item.toLowerCase() !== trimmed.toLowerCase(),
  );
  if (sameModels(existing.models, nextModels)) return existing;
  if (nextModels.length === 0) {
    const next = { ...cache };
    delete next[key];
    writeCache(next);
    return null;
  }
  return saveCachedModels(key, nextModels);
}

// ---------------------------------------------------------------------------
// Editable model lists (user add / delete, per provider).
//
// The visible options for a channel are: the currently-selected model, the
// fetched/added models in the cache, and the built-in catalog models — minus
// any the user explicitly deleted (the "hidden" set). Deleting a built-in model
// just hides it; adding re-includes it. Fetch merges into the cache and never
// resurrects a hidden model.
// ---------------------------------------------------------------------------

function readHidden(): Record<string, string[]> {
  try {
    if (!hasWindow()) return {};
    const raw = readSettingsRaw(
      MODEL_LIST_HIDDEN_REL_PATH,
      MODEL_LIST_HIDDEN_STORAGE,
    );
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue;
      const models = value.filter(
        (item): item is string => typeof item === 'string' && !!item.trim(),
      );
      if (models.length > 0) out[key] = models;
    }
    return out;
  } catch {
    return {};
  }
}

function writeHidden(hidden: Record<string, string[]>): void {
  if (!hasWindow()) return;
  const next = JSON.stringify(hidden);
  if (
    readSettingsRaw(MODEL_LIST_HIDDEN_REL_PATH, MODEL_LIST_HIDDEN_STORAGE) === next
  ) {
    return;
  }
  if (
    !writeSettingsRaw(MODEL_LIST_HIDDEN_REL_PATH, MODEL_LIST_HIDDEN_STORAGE, next)
  ) {
    console.error('[modelLists] failed to persist hidden models');
    return;
  }
  window.dispatchEvent(new Event('ugs:model-list-changed'));
}

function hiddenSet(key: string): Set<string> {
  return new Set(readHidden()[key]?.map((m) => m.toLowerCase()) ?? []);
}

function setHidden(key: string, models: Iterable<string>): void {
  const list = uniqueModels([...models]);
  const all = readHidden();
  if (list.length === 0) {
    if (!(key in all)) return;
    const next = { ...all };
    delete next[key];
    writeHidden(next);
    return;
  }
  writeHidden({ ...all, [key]: list });
}

/**
 * The full set of model options to show for a provider: selected + cached +
 * built-in catalog, minus the user-hidden models, de-duplicated (case-insensitive,
 * first spelling wins).
 */
export function editableModelOptions(
  key: string,
  builtins: Array<string | undefined | null>,
  current?: string | null,
): string[] {
  const hidden = hiddenSet(key);
  const cached = getCachedModels(key)?.models ?? [];
  return uniqueModels([current, ...cached, ...builtins]).filter(
    (model) => !hidden.has(model.toLowerCase()),
  );
}

/** Add a user-typed model: store in the cache and clear it from the hidden set. */
export function addUserModel(key: string, model: string): void {
  const trimmed = model.trim();
  if (!trimmed) return;
  const all = readHidden();
  const current = all[key];
  if (current) {
    const next = current.filter((m) => m.toLowerCase() !== trimmed.toLowerCase());
    if (next.length !== current.length) setHidden(key, next);
  }
  addCachedModels(key, [trimmed]);
}

/** Delete a model from the visible list: drop it from the cache and hide it so
 * neither the built-in catalog nor a later fetch brings it back. */
export function removeUserModel(key: string, model: string): void {
  const trimmed = model.trim();
  if (!trimmed) return;
  removeCachedModel(key, trimmed);
  const hidden = readHidden()[key] ?? [];
  if (!hidden.some((m) => m.toLowerCase() === trimmed.toLowerCase())) {
    setHidden(key, [...hidden, trimmed]);
  }
}


/** Cache key for generation provider model lists (keyed by base URL). */
export function endpointModelCacheKey(
  scope: 'image' | 'music' | 'video' | 'sprite' | 'speech' | 'mesh' | 'vision',
  providerId: string,
  baseUrl: string,
): string {
  return [scope, providerId, stripTrailingSlash(baseUrl).toLowerCase()].join(':');
}

/**
 * Fetch the model list for an OpenAI-compatible endpoint (image/music
 * commercial providers). Results are cached so the select stays populated
 * across panel reopens. Falls back to cached/catalog models on failure.
 */
export async function refreshEndpointModels(params: {
  cacheKey: string;
  baseUrl: string;
  apiKey?: string;
  fallback?: string[];
  urls?: string[];
  transport?: 'openai' | 'anthropic';
}): Promise<ModelListResult> {
  const fallback = uniqueModels(params.fallback ?? []);
  const transport = params.transport ?? 'openai';
  const urls =
    params.urls && params.urls.length > 0
      ? uniqueModels(params.urls)
      : modelListUrls(params.baseUrl, transport);
  if (urls.length === 0) {
    return { models: fallback, source: 'catalog' };
  }
  try {
    const response = await listRemoteModels({
      urls,
      apiKey: params.apiKey ?? '',
      transport,
    });
    const models = uniqueModels(response.models);
    if (models.length > 0) {
      // Merge fetched models with anything already in the cache (manual adds,
      // earlier fetches) so "fetch models" never wipes the user's own entries.
      const existing = getCachedModels(params.cacheKey)?.models ?? [];
      const cached = saveCachedModels(params.cacheKey, [...models, ...existing]);
      return { models: cached.models, source: 'remote', updatedAt: cached.updatedAt };
    }
    return { models: fallback, source: 'catalog' };
  } catch (err) {
    const cached = getCachedModels(params.cacheKey);
    if (cached) {
      return {
        models: cached.models,
        source: 'cache',
        updatedAt: cached.updatedAt,
        error: errorMessage(err),
      };
    }
    return { models: fallback, source: 'catalog', error: errorMessage(err) };
  }
}

function uniqueModels(models: Array<string | undefined | null>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of models) {
    const model = value?.trim();
    if (!model) continue;
    const key = model.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(model);
  }
  return out;
}

function stripTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function providerDefaultBaseUrl(provider: ProviderModelSource): string {
  if (provider.baseUrl.trim()) return provider.baseUrl.trim();
  if (provider.kind === 'anthropic') return 'https://api.anthropic.com/v1';
  if (provider.kind === 'gemini') {
    return 'https://generativelanguage.googleapis.com/v1beta/openai';
  }
  return '';
}

function providerTransport(provider: ProviderModelSource): 'anthropic' | 'openai' {
  return provider.kind === 'anthropic' ? 'anthropic' : 'openai';
}

function endpointOrigin(base: string): string | null {
  try {
    return new URL(base).origin;
  } catch {
    return null;
  }
}

function modelListUrls(
  baseUrl: string,
  transport: 'anthropic' | 'openai',
): string[] {
  const base = stripTrailingSlash(baseUrl);
  if (!base) return [];
  const urls = [`${base}/models`];

  if (transport === 'anthropic') {
    const anthropicTrimmed = base.replace(/\/anthropic$/i, '');
    if (anthropicTrimmed !== base) urls.push(`${anthropicTrimmed}/v1/models`);
    const origin = endpointOrigin(base);
    if (origin) urls.push(`${origin}/v1/models`);
  }

  return uniqueModels(urls);
}

export function providerModelCacheKey(provider: ProviderModelSource): string {
  return [
    'provider',
    provider.kind,
    stripTrailingSlash(providerDefaultBaseUrl(provider)).toLowerCase(),
  ].join(':');
}

export function freeChannelModelCacheKey(channelId: string): string {
  return `free:${channelId}`;
}

export function freeChannelModelOptions(channel: FreeChannel): string[] {
  if (channel.id === FREE_CHANNEL_AUTO_ID) {
    return uniqueModels([
      FREE_CHANNEL_AUTO_MODEL,
      getFreeChannelModelOverride(FREE_CHANNEL_AUTO_ID),
      ...FREE_CHANNELS.filter((candidate) => candidate.id !== FREE_CHANNEL_AUTO_ID)
        .flatMap((candidate) => [
          getFreeChannelModelOverride(candidate.id),
          getFreeChannelModel(candidate.id),
          ...(getCachedModels(freeChannelModelCacheKey(candidate.id))?.models ?? []),
          candidate.defaultModel,
          ...(candidate.fallbackModels ?? []),
        ]),
    ]);
  }
  const cached = getCachedModels(freeChannelModelCacheKey(channel.id));
  return uniqueModels([
    getFreeChannelModelOverride(channel.id),
    getFreeChannelModel(channel.id),
    ...(cached?.models ?? []),
    channel.defaultModel,
    ...(channel.fallbackModels ?? []),
  ]);
}

export function providerModelOptions(provider: ProviderModelSource): string[] {
  const cached = getCachedModels(providerModelCacheKey(provider));
  return uniqueModels([
    provider.model,
    ...(provider.models ?? []),
    ...(cached?.models ?? []),
  ]);
}

export function allFreeChannelModelOptions(channelId: string): string[] {
  const channel = FREE_CHANNELS.find((candidate) => candidate.id === channelId);
  return channel ? freeChannelModelOptions(channel) : [];
}

export async function refreshFreeChannelModels(
  channel: FreeChannel,
): Promise<ModelListResult> {
  if (channel.id === FREE_CHANNEL_AUTO_ID) {
    return {
      models: freeChannelModelOptions(channel),
      source: 'catalog',
    };
  }

  const cacheKey = freeChannelModelCacheKey(channel.id);
  const cached = getCachedModels(cacheKey);
  const catalog = uniqueModels([
    getFreeChannelModel(channel.id),
    ...(cached?.models ?? []),
    channel.defaultModel,
    ...(channel.fallbackModels ?? []),
  ]);

  if (channel.local) {
    try {
      const localModels = await listLocalModels(channel.id);
      if (localModels.length > 0) {
        const nextCached = saveCachedModels(cacheKey, [
          ...localModels,
          ...(cached?.models ?? []),
        ]);
        return {
          models: nextCached.models,
          source: 'local',
          availableModels: uniqueModels(localModels),
          updatedAt: nextCached.updatedAt,
        };
      }
      return { models: catalog, source: 'catalog' };
    } catch (err) {
      if (cached) {
        return {
          models: cached.models,
          source: 'cache',
          updatedAt: cached.updatedAt,
          error: errorMessage(err),
        };
      }
      return { models: catalog, source: 'catalog', error: errorMessage(err) };
    }
  }

  const transport: 'anthropic' | 'openai' =
    channel.transport === 'anthropic' ? 'anthropic' : 'openai';
  const urls = modelListUrls(channel.upstreamBaseUrl, transport);
  try {
    const response = await listRemoteModels({
      urls,
      apiKey: getFreeChannelKey(channel.id),
      transport,
    });
    const models = uniqueModels(response.models);
    if (models.length > 0) {
      const nextCached = saveCachedModels(cacheKey, [
        ...models,
        ...(cached?.models ?? []),
      ]);
      return {
        models: nextCached.models,
        source: 'remote',
        availableModels: models,
        updatedAt: nextCached.updatedAt,
      };
    }
    return { models: catalog, source: 'catalog' };
  } catch (err) {
    if (cached) {
      return {
        models: cached.models,
        source: 'cache',
        updatedAt: cached.updatedAt,
        error: errorMessage(err),
      };
    }
    return { models: catalog, source: 'catalog', error: errorMessage(err) };
  }
}

export async function refreshProviderModels(
  provider: ProviderModelSource,
): Promise<ModelListResult> {
  const cacheKey = providerModelCacheKey(provider);
  const cached = getCachedModels(cacheKey);
  const fallback = uniqueModels([
    provider.model,
    ...(provider.models ?? []),
    ...(cached?.models ?? []),
  ]);
  const baseUrl = providerDefaultBaseUrl(provider);
  const urls = modelListUrls(baseUrl, providerTransport(provider));
  if (urls.length === 0) {
    return { models: fallback, source: 'catalog' };
  }

  try {
    const response = await listRemoteModels({
      urls,
      apiKey: provider.apiKey,
      transport: providerTransport(provider),
    });
    const availableModels = uniqueModels(response.models);
    const models = uniqueModels([
      ...availableModels,
      ...(provider.models ?? []),
      ...(cached?.models ?? []),
    ]);
    if (availableModels.length > 0) {
      const nextCached = saveCachedModels(cacheKey, models);
      return {
        models: nextCached.models,
        source: 'remote',
        availableModels,
        updatedAt: nextCached.updatedAt,
      };
    }
    return { models: fallback, source: 'catalog' };
  } catch (err) {
    if (cached) {
      return {
        models: cached.models,
        source: 'cache',
        updatedAt: cached.updatedAt,
        error: errorMessage(err),
      };
    }
    return { models: fallback, source: 'catalog', error: errorMessage(err) };
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function canRefreshFreeChannelModels(channel: FreeChannel): boolean {
  if (channel.id === FREE_CHANNEL_AUTO_ID) return false;
  if (channel.local) return tauriAvailable();
  return !channel.needsKey || getFreeChannelKey(channel.id).trim().length > 0;
}
