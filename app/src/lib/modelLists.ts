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

const MODEL_LIST_CACHE_STORAGE = 'fuc_model_list_cache_v1';

interface CachedModelList {
  models: string[];
  updatedAt: number;
}

export interface ModelListResult {
  models: string[];
  source: 'remote' | 'local' | 'catalog' | 'cache';
  updatedAt?: number;
  error?: string;
}

type ProviderModelSource = Pick<Provider, 'kind' | 'apiKey' | 'baseUrl' | 'model'>;

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function readCache(): Record<string, CachedModelList> {
  try {
    if (!hasWindow()) return {};
    const raw = window.localStorage.getItem(MODEL_LIST_CACHE_STORAGE);
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
  try {
    if (!hasWindow()) return;
    const next = JSON.stringify(cache);
    if (window.localStorage.getItem(MODEL_LIST_CACHE_STORAGE) === next) return;
    window.localStorage.setItem(MODEL_LIST_CACHE_STORAGE, next);
    window.dispatchEvent(new Event('fuc:model-list-changed'));
  } catch {
    /* ignore */
  }
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

/** Cache key for image/music provider model lists (keyed by base URL). */
export function endpointModelCacheKey(
  scope: 'image' | 'music' | 'video' | 'sprite' | 'speech',
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
}): Promise<ModelListResult> {
  const fallback = uniqueModels(params.fallback ?? []);
  const urls = modelListUrls(params.baseUrl, 'openai');
  if (urls.length === 0) {
    return { models: fallback, source: 'catalog' };
  }
  try {
    const response = await listRemoteModels({
      urls,
      apiKey: params.apiKey ?? '',
      transport: 'openai',
    });
    const models = uniqueModels(response.models);
    if (models.length > 0) {
      const cached = saveCachedModels(params.cacheKey, models);
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
  return uniqueModels([provider.model, ...(cached?.models ?? [])]);
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
  const catalog = uniqueModels([
    getFreeChannelModel(channel.id),
    channel.defaultModel,
    ...(channel.fallbackModels ?? []),
  ]);

  if (channel.local) {
    try {
      const models = await listLocalModels(channel.id);
      if (models.length > 0) {
        const cached = saveCachedModels(cacheKey, models);
        return { models: cached.models, source: 'local', updatedAt: cached.updatedAt };
      }
      return { models: catalog, source: 'catalog' };
    } catch (err) {
      const cached = getCachedModels(cacheKey);
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
      const cached = saveCachedModels(cacheKey, models);
      return { models: cached.models, source: 'remote', updatedAt: cached.updatedAt };
    }
    return { models: catalog, source: 'catalog' };
  } catch (err) {
    const cached = getCachedModels(cacheKey);
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
  const fallback = uniqueModels([provider.model]);
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
    const models = uniqueModels(response.models);
    if (models.length > 0) {
      const cached = saveCachedModels(cacheKey, models);
      return { models: cached.models, source: 'remote', updatedAt: cached.updatedAt };
    }
    return { models: fallback, source: 'catalog' };
  } catch (err) {
    const cached = getCachedModels(cacheKey);
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
