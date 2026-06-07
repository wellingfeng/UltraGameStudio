import type { GatewaySelection } from '@/core/ir';
import type { GatewayProvider } from '@/lib/modelGateway/types';
import { freeChannelAutoKeys, freeProxyEnsure, isTauri } from '@/lib/tauri';

/**
 * CONTRACT: catalog + helpers for the built-in "free channels" feature.
 *
 * When the user picks the `claude-code` runtime, a second "Channel" dropdown
 * lets them route the claude CLI through one of the free upstreams below
 * (translated/reverse-proxied by the built-in local Rust proxy at
 * 127.0.0.1:<port>/ch/<id>). A free-channel selection is encoded as a normal
 * GatewaySelection whose providerId is `freecc:<id>`; `loadGatewayConfig()`
 * merges synthetic CLI providers so the existing resolver/launcher pathway
 * (gatewayRouteEnv -> ANTHROPIC_BASE_URL/...) lights up unchanged.
 *
 * Storage keys (localStorage):
 *   fuc_free_channel_keys_v1   -> { [id]: apiKey }
 *   fuc_free_channel_models_v1 -> { [id]: modelOverride }
 *   fuc_free_proxy_port_v1     -> number (default 8766)
 *   fuc_free_proxy_token_v1    -> per-process local proxy auth token
 *
 * Exports the UI phase relies on:
 *   FREE_CHANNELS, FREE_CHANNEL_PROVIDER_PREFIX, freeChannelById,
 *   getFreeChannelKey, setFreeChannelKey, getFreeChannelModel,
 *   setFreeChannelModel, freeChannelReady, getCachedFreeProxyPort,
 *   freeChannelSelection, isFreeChannelSelection, ensureFreeProxy,
 *   freeChannelGatewayProviders.
 */

export type FreeChannelTransport = 'openai' | 'anthropic' | 'auto';

export const FREE_CHANNEL_AUTO_ID = 'auto';
export const FREE_CHANNEL_AUTO_MODEL = 'auto';

export interface FreeChannel {
  /** Stable id, e.g. 'groq'. */
  id: string;
  /** Display label, e.g. 'Groq'. */
  label: string;
  /** Upstream wire protocol the proxy speaks. */
  transport: FreeChannelTransport;
  /** Upstream base url (proxy appends /v1/messages or /chat/completions). */
  upstreamBaseUrl: string;
  /** Default model id sent upstream. */
  defaultModel: string;
  /** Extra model ids to try when the upstream rejects the selected model. */
  fallbackModels?: string[];
  /** Where to obtain an API key (shown in UI). */
  credentialUrl?: string;
  /** Where to install/configure a local runtime (shown for local channels). */
  setupUrl?: string;
  /** Local runtime (ollama/lmstudio/llamacpp) — no key needed. */
  local: boolean;
  /** Whether an API key is required. */
  needsKey: boolean;
  note?: string;
}

export interface FreeChannelsExport {
  type: 'openworkflow.freeChannels';
  version: 1;
  keys: Record<string, string>;
  models: Record<string, string>;
}

export interface FreeChannelsImportResult {
  keys: number;
  models: number;
  skipped: number;
}

export const FREE_CHANNEL_PROVIDER_PREFIX = 'freecc:';

const DEFAULT_FREE_PROXY_PORT = 8766;
const MAX_FREE_PROXY_PORT = 8799;

const KEYS_STORAGE = 'fuc_free_channel_keys_v1';
const MODELS_STORAGE = 'fuc_free_channel_models_v1';
const PORT_STORAGE = 'fuc_free_proxy_port_v1';
const TOKEN_STORAGE = 'fuc_free_proxy_token_v1';
const LEGACY_RECORD_STORAGE: Record<string, string[]> = {
  [KEYS_STORAGE]: [
    'owf_free_channel_keys_v1',
    'openworkflow.free_channel_keys_v1',
    'openworkflow.freeChannels.keys',
  ],
  [MODELS_STORAGE]: [
    'owf_free_channel_models_v1',
    'openworkflow.free_channel_models_v1',
    'openworkflow.freeChannels.models',
  ],
};

export const FREE_CHANNELS: FreeChannel[] = [
  {
    id: FREE_CHANNEL_AUTO_ID,
    label: 'Auto',
    transport: 'auto',
    upstreamBaseUrl: '',
    defaultModel: '',
    local: false,
    needsKey: false,
    note: 'Routes through the best currently available configured free channel and automatically skips channels that hit rate limits or upstream errors.',
  },
  {
    id: 'nvidia_nim',
    label: 'NVIDIA NIM',
    transport: 'openai',
    upstreamBaseUrl: 'https://integrate.api.nvidia.com/v1',
    defaultModel: 'nvidia/nemotron-3-super-120b-a12b',
    fallbackModels: ['nvidia/llama-3.1-nemotron-ultra-253b-v1'],
    credentialUrl: 'https://build.nvidia.com/settings/api-keys',
    local: false,
    needsKey: true,
  },
  {
    id: 'open_router',
    label: 'OpenRouter',
    transport: 'openai',
    upstreamBaseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'z-ai/glm-4.6',
    fallbackModels: ['z-ai/glm-5.1', 'z-ai/glm-4.7', 'z-ai/glm-4.5-air:free'],
    credentialUrl: 'https://openrouter.ai/keys',
    local: false,
    needsKey: true,
  },
  {
    id: 'github_models',
    label: 'GitHub Models',
    transport: 'openai',
    upstreamBaseUrl: 'https://models.github.ai/inference',
    defaultModel: 'openai/gpt-4.1-mini',
    fallbackModels: ['openai/gpt-4.1', 'xai/grok-code-fast-1'],
    credentialUrl: 'https://github.com/marketplace/models',
    local: false,
    needsKey: true,
    note: 'Official OpenAI-compatible GitHub Models endpoint with free rate-limited usage for eligible accounts.',
  },
  {
    id: 'huggingface_router',
    label: 'Hugging Face Router',
    transport: 'openai',
    upstreamBaseUrl: 'https://router.huggingface.co/v1',
    defaultModel: 'deepseek-ai/DeepSeek-V4-Pro',
    fallbackModels: ['Qwen/Qwen3-Coder-480B-A35B-Instruct', 'zai-org/GLM-4.6'],
    credentialUrl: 'https://huggingface.co/settings/tokens',
    local: false,
    needsKey: true,
    note: 'OpenAI-compatible HF Inference Router. Use text-only/coding-capable routed models.',
  },
  {
    id: 'sambanova',
    label: 'SambaNova Cloud',
    transport: 'openai',
    upstreamBaseUrl: 'https://api.sambanova.ai/v1',
    defaultModel: 'DeepSeek-V3.1',
    fallbackModels: ['DeepSeek-V3.2', 'Meta-Llama-3.3-70B-Instruct'],
    credentialUrl: 'https://cloud.sambanova.ai/apis',
    local: false,
    needsKey: true,
    note: 'OpenAI-compatible endpoint with signup/free-credit availability depending on account limits.',
  },
  {
    id: 'together',
    label: 'Together AI',
    transport: 'openai',
    upstreamBaseUrl: 'https://api.together.xyz/v1',
    defaultModel: 'Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8',
    fallbackModels: ['meta-llama/Llama-3.3-70B-Instruct-Turbo'],
    credentialUrl: 'https://api.together.ai/settings/api-keys',
    local: false,
    needsKey: true,
    note: 'OpenAI-compatible endpoint; choose Qwen/DeepSeek/Llama text models for coding workflows.',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    transport: 'openai',
    upstreamBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.5-flash',
    fallbackModels: ['gemini-2.5-flash-lite', 'gemini-2.0-flash'],
    credentialUrl: 'https://aistudio.google.com/apikey',
    local: false,
    needsKey: true,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    transport: 'anthropic',
    upstreamBaseUrl: 'https://api.deepseek.com/anthropic',
    defaultModel: 'deepseek-chat',
    fallbackModels: ['deepseek-reasoner'],
    credentialUrl: 'https://platform.deepseek.com/api_keys',
    local: false,
    needsKey: true,
  },
  {
    // Volcengine Ark (火山方舟) — ByteDance's model platform. OpenAI-compatible
    // endpoint at /api/v3/chat/completions; modern Ark accepts the bare model
    // id directly (e.g. deepseek-v3-250324) so no inference-endpoint (ep-xxxx)
    // is required. Each model grants a free token quota after you enable it in
    // the console. The intro video that prompted this channel demoed
    // deepseek-r1-250120 here.
    id: 'volcengine',
    label: 'Volcengine Ark (火山方舟)',
    transport: 'openai',
    upstreamBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: 'deepseek-v3-250324',
    fallbackModels: ['deepseek-r1-250528', 'deepseek-r1-250120'],
    credentialUrl:
      'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    local: false,
    needsKey: true,
    note: 'Enable the model in the Ark console (each gets a free token quota), then call it by its Model ID. Override the model to any Ark id (DeepSeek / Doubao / Kimi …).',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    transport: 'openai',
    upstreamBaseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-large-latest',
    fallbackModels: ['mistral-small-latest'],
    credentialUrl: 'https://console.mistral.ai/',
    local: false,
    needsKey: true,
  },
  {
    id: 'mistral_codestral',
    label: 'Mistral Codestral',
    transport: 'openai',
    upstreamBaseUrl: 'https://codestral.mistral.ai/v1',
    defaultModel: 'codestral-latest',
    fallbackModels: ['codestral-2405'],
    credentialUrl: 'https://console.mistral.ai/',
    local: false,
    needsKey: true,
  },
  {
    id: 'opencode',
    label: 'OpenCode Zen',
    transport: 'openai',
    upstreamBaseUrl: 'https://opencode.ai/zen/v1',
    defaultModel: 'glm-5.1',
    fallbackModels: ['glm-4.6'],
    credentialUrl: 'https://opencode.ai/auth',
    local: false,
    needsKey: true,
  },
  {
    id: 'opencode_go',
    label: 'OpenCode Go',
    transport: 'openai',
    upstreamBaseUrl: 'https://opencode.ai/zen/go/v1',
    defaultModel: 'glm-5.1',
    fallbackModels: ['glm-4.6'],
    credentialUrl: 'https://opencode.ai/auth',
    local: false,
    needsKey: true,
  },
  {
    id: 'wafer',
    label: 'Wafer',
    transport: 'anthropic',
    upstreamBaseUrl: 'https://pass.wafer.ai',
    defaultModel: 'GLM-5.1',
    fallbackModels: ['glm-5.1', 'glm-4.6'],
    credentialUrl: 'https://www.wafer.ai/pass',
    local: false,
    needsKey: true,
  },
  {
    id: 'kimi',
    label: 'Kimi (Moonshot)',
    transport: 'anthropic',
    upstreamBaseUrl: 'https://api.moonshot.ai/anthropic',
    defaultModel: 'kimi-k2.5',
    fallbackModels: ['kimi-k2-0905-preview', 'moonshot-v1-32k'],
    credentialUrl: 'https://platform.moonshot.cn/console/api-keys',
    local: false,
    needsKey: true,
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    transport: 'openai',
    upstreamBaseUrl: 'https://api.cerebras.ai/v1',
    defaultModel: 'llama-3.3-70b',
    fallbackModels: ['llama3.1-8b'],
    credentialUrl: 'https://cloud.cerebras.ai',
    local: false,
    needsKey: true,
  },
  {
    id: 'groq',
    label: 'Groq',
    transport: 'openai',
    upstreamBaseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    fallbackModels: ['llama-3.1-8b-instant', 'openai/gpt-oss-120b'],
    credentialUrl: 'https://console.groq.com/keys',
    local: false,
    needsKey: true,
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    transport: 'anthropic',
    upstreamBaseUrl: 'https://api.fireworks.ai/inference',
    defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    fallbackModels: ['accounts/fireworks/models/llama-v3p1-8b-instruct'],
    credentialUrl: 'https://fireworks.ai/account/api-keys',
    local: false,
    needsKey: true,
  },
  {
    id: 'zai',
    label: 'Z.ai GLM',
    transport: 'anthropic',
    upstreamBaseUrl: 'https://api.z.ai/api/anthropic',
    defaultModel: 'glm-5.1',
    fallbackModels: ['glm-4.6'],
    credentialUrl: 'https://z.ai/manage-apikey/apikey-list',
    local: false,
    needsKey: true,
  },
  {
    id: 'llm7',
    label: 'LLM7',
    transport: 'openai',
    upstreamBaseUrl: 'https://api.llm7.io/v1',
    defaultModel: 'codestral-latest',
    fallbackModels: ['qwen3-235b'],
    local: false,
    needsKey: false,
    note: 'Keyless experimental channel. codestral-latest and qwen3-235b passed a small coding smoke test; avoid sensitive prompts.',
  },
  {
    id: 'kilo',
    label: 'Kilo Gateway',
    transport: 'openai',
    upstreamBaseUrl: 'https://api.kilo.ai/api/gateway/v1',
    defaultModel: 'poolside/laguna-xs.2:free',
    local: false,
    needsKey: false,
    note: 'Keyless experimental channel. Prompts may be logged by the upstream; use only for non-sensitive coding tasks.',
  },
  {
    // LM Studio's local server is OpenAI-compatible only (it serves
    // /v1/chat/completions, not Anthropic /v1/messages), so route via the
    // 'openai' translator. Leave the model empty: the user must pick whichever
    // model they have loaded (settings → free channels → model override).
    id: 'lmstudio',
    label: 'LM Studio (local)',
    transport: 'openai',
    upstreamBaseUrl: 'http://localhost:1234/v1',
    defaultModel: '',
    setupUrl: 'https://lmstudio.ai/download',
    local: true,
    needsKey: false,
    note: 'Set a model override to the id you loaded in LM Studio.',
  },
  {
    // llama.cpp's server exposes an OpenAI-compatible endpoint at /v1; it does
    // not natively speak the Anthropic Messages protocol.
    id: 'llamacpp',
    label: 'llama.cpp (local)',
    transport: 'openai',
    upstreamBaseUrl: 'http://localhost:8080/v1',
    defaultModel: '',
    setupUrl: 'https://github.com/ggml-org/llama.cpp/releases',
    local: true,
    needsKey: false,
    note: 'Set a model override to the model your llama.cpp server is hosting.',
  },
  {
    // Ollama's native API is /api/chat; its OpenAI-compatible shim lives at
    // /v1/chat/completions. It has no Anthropic /v1/messages endpoint.
    id: 'ollama',
    label: 'Ollama (local)',
    transport: 'openai',
    upstreamBaseUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3.1',
    setupUrl: 'https://ollama.com/download',
    local: true,
    needsKey: false,
    note: 'Override the model to match a tag you have pulled (e.g. llama3.3).',
  },
];

const FREE_CHANNEL_BY_ID = new Map(FREE_CHANNELS.map((c) => [c.id, c]));

export function freeChannelById(id: string): FreeChannel | undefined {
  return FREE_CHANNEL_BY_ID.get(id);
}

const hasWindow = (): boolean => typeof window !== 'undefined';

function readRecord(key: string): Record<string, string> {
  try {
    if (!hasWindow()) return {};
    const raw = window.localStorage.getItem(key);
    const out: Record<string, string> = {};

    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (typeof parsed === 'object' && parsed !== null) {
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === 'string') out[k] = v;
          }
        }
      } catch {
        /* ignore corrupt current records; legacy recovery below may still work */
      }
    }

    let mergedLegacy = false;
    for (const legacyKey of LEGACY_RECORD_STORAGE[key] ?? []) {
      const legacyRaw = window.localStorage.getItem(legacyKey);
      if (!legacyRaw) continue;
      try {
        const legacyParsed = JSON.parse(legacyRaw) as unknown;
        const legacy = knownFreeChannelRecord(legacyParsed).record;
        for (const [id, value] of Object.entries(legacy)) {
          if (out[id]?.trim()) continue;
          out[id] = value;
          mergedLegacy = true;
        }
      } catch {
        /* ignore corrupt legacy records */
      }
    }

    if (mergedLegacy) writeRecord(key, out);
    return out;
  } catch {
    return {};
  }
}

function writeRecord(key: string, value: Record<string, string>): boolean {
  try {
    if (!hasWindow()) return false;
    const next = JSON.stringify(value);
    if (window.localStorage.getItem(key) === next) return false;
    window.localStorage.setItem(key, next);
    window.dispatchEvent(new Event('fuc:gateway-config-changed'));
    return true;
  } catch {
    /* ignore */
    return false;
  }
}

function knownFreeChannelRecord(value: unknown): {
  record: Record<string, string>;
  skipped: number;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { record: {}, skipped: 0 };
  }
  const record: Record<string, string> = {};
  let skipped = 0;
  for (const [id, raw] of Object.entries(value)) {
    if (!FREE_CHANNEL_BY_ID.has(id)) {
      skipped += 1;
      continue;
    }
    if (typeof raw !== 'string') {
      skipped += 1;
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed) record[id] = trimmed;
  }
  return { record, skipped };
}

function readFreeChannelsPayload(value: unknown): {
  keys: Record<string, string>;
  models: Record<string, string>;
  skipped: number;
} | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const source = value as Record<string, unknown>;
  const keys = knownFreeChannelRecord(source.keys);
  const models = knownFreeChannelRecord(source.models);
  if (!source.keys && !source.models) {
    const directKeys = knownFreeChannelRecord(source);
    if (Object.keys(directKeys.record).length === 0) return null;
    return { keys: directKeys.record, models: {}, skipped: directKeys.skipped };
  }
  return {
    keys: keys.record,
    models: models.record,
    skipped: keys.skipped + models.skipped,
  };
}

function exportKnownRecord(key: string): Record<string, string> {
  const stored = readRecord(key);
  const out: Record<string, string> = {};
  for (const channel of FREE_CHANNELS) {
    const value = stored[channel.id]?.trim();
    if (value) out[channel.id] = value;
  }
  return out;
}

export function exportFreeChannelsConfig(): FreeChannelsExport {
  return {
    type: 'openworkflow.freeChannels',
    version: 1,
    keys: exportKnownRecord(KEYS_STORAGE),
    models: exportKnownRecord(MODELS_STORAGE),
  };
}

export function importFreeChannelsConfig(
  value: unknown,
): FreeChannelsImportResult {
  const payload = readFreeChannelsPayload(value);
  if (!payload) {
    throw new Error('Unsupported free channels JSON');
  }

  const nextKeys = readRecord(KEYS_STORAGE);
  const nextModels = readRecord(MODELS_STORAGE);
  let keys = 0;
  let models = 0;

  for (const [id, value] of Object.entries(payload.keys)) {
    if (nextKeys[id] !== value) keys += 1;
    nextKeys[id] = value;
  }
  for (const [id, value] of Object.entries(payload.models)) {
    if (nextModels[id] !== value) models += 1;
    nextModels[id] = value;
  }

  writeRecord(KEYS_STORAGE, nextKeys);
  writeRecord(MODELS_STORAGE, nextModels);

  return { keys, models, skipped: payload.skipped };
}

export function getFreeChannelKey(id: string): string {
  return readRecord(KEYS_STORAGE)[id] ?? '';
}

export function setFreeChannelKey(id: string, key: string): boolean {
  const next = readRecord(KEYS_STORAGE);
  const trimmed = key.trim();
  if (trimmed) next[id] = trimmed;
  else delete next[id];
  return writeRecord(KEYS_STORAGE, next);
}

export function getFreeChannelModel(id: string): string {
  const override = (readRecord(MODELS_STORAGE)[id] ?? '').trim();
  if (id === FREE_CHANNEL_AUTO_ID) {
    if (override && !isFreeChannelAutoModel(override)) {
      return normalizeFreeChannelModel(id, override);
    }
    return FREE_CHANNEL_AUTO_MODEL;
  }
  if (override) return normalizeFreeChannelModel(id, override);
  return freeChannelById(id)?.defaultModel ?? '';
}

export function isFreeChannelAutoModel(model: string | undefined | null): boolean {
  return model?.trim().toLowerCase() === FREE_CHANNEL_AUTO_MODEL;
}

export function getFreeChannelRouteModel(id: string, model = getFreeChannelModel(id)): string {
  if (id === FREE_CHANNEL_AUTO_ID && isFreeChannelAutoModel(model)) return '';
  return model;
}

export function getFreeChannelFallbackModels(id: string): string[] {
  const channel = freeChannelById(id);
  if (!channel) return [];
  const primary = getFreeChannelModel(id);
  return uniqueModels([
    ...(channel.fallbackModels ?? []).map((model) =>
      normalizeFreeChannelModel(id, model),
    ),
    normalizeFreeChannelModel(id, channel.defaultModel),
  ]).filter((model) => model && model !== primary);
}

function normalizeFreeChannelModel(id: string, model: string): string {
  const normalized = model.trim();
  const lower = normalized.toLowerCase();
  switch (id) {
    case 'open_router':
      if (/^glm-\d/i.test(normalized)) return `z-ai/${lower}`;
      if (lower.startsWith('z-ai/glm-')) return lower;
      return normalized;
    case 'nvidia_nim':
      if (!normalized.includes('/') && lower.includes('nemotron')) {
        return `nvidia/${lower}`;
      }
      return normalized;
    case 'fireworks':
      if (!normalized.includes('/') && lower.startsWith('llama-')) {
        return `accounts/fireworks/models/${lower}`;
      }
      return normalized;
    case 'opencode':
    case 'opencode_go':
    case 'zai':
      if (/^glm-\d/i.test(normalized)) return lower;
      return normalized;
    default:
      return normalized;
  }
}

function uniqueModels(models: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    const trimmed = model.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * The user's raw model override for a channel (empty when none is set). Unlike
 * getFreeChannelModel this does NOT fall back to the channel default, so a
 * settings input can show an empty field with the default as placeholder.
 */
export function getFreeChannelModelOverride(id: string): string {
  const override = (readRecord(MODELS_STORAGE)[id] ?? '').trim();
  if (id === FREE_CHANNEL_AUTO_ID && isFreeChannelAutoModel(override)) return '';
  return override;
}

export function setFreeChannelModel(id: string, model: string): boolean {
  const next = readRecord(MODELS_STORAGE);
  const trimmed = model.trim();
  if (id === FREE_CHANNEL_AUTO_ID && isFreeChannelAutoModel(trimmed)) {
    delete next[id];
  } else if (trimmed) next[id] = trimmed;
  else delete next[id];
  return writeRecord(MODELS_STORAGE, next);
}

export function freeChannelReady(id: string): boolean {
  const channel = freeChannelById(id);
  if (!channel) return false;
  if (channel.id === FREE_CHANNEL_AUTO_ID) {
    return FREE_CHANNELS.some(
      (candidate) =>
        candidate.id !== FREE_CHANNEL_AUTO_ID && freeChannelReadyBase(candidate),
    );
  }
  return freeChannelReadyBase(channel);
}

function freeChannelReadyBase(channel: FreeChannel): boolean {
  if (channel.local) return getFreeChannelModelOverride(channel.id).length > 0;
  if (!channel.needsKey) return true;
  return getFreeChannelKey(channel.id).length > 0;
}

export function applyFreeChannelEnvKeys(keys: Record<string, string>): string[] {
  const imported: string[] = [];
  const next = readRecord(KEYS_STORAGE);
  for (const channel of FREE_CHANNELS) {
    if (channel.local || !channel.needsKey) continue;
    if (next[channel.id]) continue;
    const key = keys[channel.id]?.trim();
    if (!key) continue;
    next[channel.id] = key;
    imported.push(channel.id);
  }
  if (imported.length > 0) writeRecord(KEYS_STORAGE, next);
  return imported;
}

export async function importFreeChannelKeysFromAutoConfig(): Promise<string[]> {
  if (!isTauri()) return [];
  try {
    return applyFreeChannelEnvKeys(await freeChannelAutoKeys());
  } catch {
    return [];
  }
}

export async function loadFreeChannelKeyFromAutoConfig(id: string): Promise<string> {
  const stored = getFreeChannelKey(id);
  if (stored) return stored;
  if (!isTauri()) return '';
  try {
    applyFreeChannelEnvKeys(await freeChannelAutoKeys());
  } catch {
    return '';
  }
  return getFreeChannelKey(id);
}

export function getCachedFreeProxyPort(): number {
  try {
    if (!hasWindow()) return DEFAULT_FREE_PROXY_PORT;
    const raw = window.localStorage.getItem(PORT_STORAGE);
    if (!raw) return DEFAULT_FREE_PROXY_PORT;
    const port = Number.parseInt(raw, 10);
    if (
      Number.isFinite(port) &&
      port >= DEFAULT_FREE_PROXY_PORT &&
      port <= MAX_FREE_PROXY_PORT
    ) {
      return port;
    }
    window.localStorage.removeItem(PORT_STORAGE);
    return DEFAULT_FREE_PROXY_PORT;
  } catch {
    return DEFAULT_FREE_PROXY_PORT;
  }
}

function setCachedFreeProxyPort(port: number): void {
  try {
    if (!hasWindow()) return;
    const prev = window.localStorage.getItem(PORT_STORAGE);
    const next = String(port);
    window.localStorage.setItem(PORT_STORAGE, next);
    // The cached port is baked into every freecc:* provider baseUrl
    // (http://127.0.0.1:<port>/ch/<id>). If the proxy rebinds to a different
    // port, subscribers (NodeInspector run options / gateway hints) must
    // re-read; mirror writeRecord's dispatch so they refresh. Only fire when
    // the value actually changed to avoid redundant refreshes.
    if (prev !== next) {
      window.dispatchEvent(new Event('fuc:gateway-config-changed'));
    }
  } catch {
    /* ignore */
  }
}

function getCachedFreeProxyToken(): string {
  try {
    if (!hasWindow()) return '';
    return window.localStorage.getItem(TOKEN_STORAGE)?.trim() ?? '';
  } catch {
    return '';
  }
}

function setCachedFreeProxyToken(token: string): void {
  try {
    if (!hasWindow()) return;
    const trimmed = token.trim();
    const prev = window.localStorage.getItem(TOKEN_STORAGE);
    if (trimmed) window.localStorage.setItem(TOKEN_STORAGE, trimmed);
    else window.localStorage.removeItem(TOKEN_STORAGE);
    if (prev !== trimmed) {
      window.dispatchEvent(new Event('fuc:gateway-config-changed'));
    }
  } catch {
    /* ignore */
  }
}

export function freeChannelSelection(
  id: string,
  modelClass?: string,
): GatewaySelection {
  const model = modelClass?.trim();
  return {
    adapter: 'claude-code',
    modelClass: model || (id === FREE_CHANNEL_AUTO_ID ? FREE_CHANNEL_AUTO_MODEL : 'sonnet'),
    providerId: FREE_CHANNEL_PROVIDER_PREFIX + id,
    channelId: 'default',
  };
}

/**
 * Returns the free channel id when the selection points at one (providerId
 * `freecc:<id>`), otherwise null.
 */
export function isFreeChannelSelection(
  sel: GatewaySelection | undefined | null,
): string | null {
  const providerId = sel?.providerId;
  if (typeof providerId !== 'string') return null;
  if (!providerId.startsWith(FREE_CHANNEL_PROVIDER_PREFIX)) return null;
  const id = providerId.slice(FREE_CHANNEL_PROVIDER_PREFIX.length);
  return FREE_CHANNEL_BY_ID.has(id) ? id : null;
}

/**
 * Build synthetic CLI gateway providers (one per free channel), pointed at the
 * local proxy. Merged into loadGatewayConfig() so resolveGatewayRoute() resolves
 * a free channel to a claude-code CLI route whose env exports
 * ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/ch/<id>.
 */
export function freeChannelGatewayProviders(): GatewayProvider[] {
  const port = getCachedFreeProxyPort();
  const proxyToken = getCachedFreeProxyToken();
  return FREE_CHANNELS.map((c) => {
    const baseUrl = `http://127.0.0.1:${port}/ch/${c.id}`;
    const model = getFreeChannelRouteModel(c.id);
    return {
      id: FREE_CHANNEL_PROVIDER_PREFIX + c.id,
      kind: 'anthropic',
      name: c.label,
      adapter: 'claude-code',
      channels: [
        {
          id: 'default',
          name: c.label,
          apiKey: proxyToken || 'freecc',
          baseUrl,
          model,
          models: undefined,
          route: {
            transport: 'cli',
            baseUrl,
            model,
            models: undefined,
          },
        },
      ],
    } satisfies GatewayProvider;
  });
}

/**
 * Ensure the local proxy is running with the latest channel config (idempotent).
 * Gathers every ready channel, calls the Rust IPC, and caches the chosen port.
 * No-op (returns the cached port) outside the desktop shell.
 */
export async function ensureFreeProxy(
  opts: { strict?: boolean; modelOverrides?: Record<string, string | undefined> } = {},
): Promise<number> {
  if (!isTauri()) return getCachedFreeProxyPort();
  const channels = FREE_CHANNELS.filter((c) => freeChannelReady(c.id)).map(
    (c) => {
      const model = opts.modelOverrides?.[c.id] ?? getFreeChannelModel(c.id);
      return {
        id: c.id,
        label: c.label,
        transport: c.transport,
        baseUrl: c.upstreamBaseUrl,
        apiKey: c.local ? '' : getFreeChannelKey(c.id),
        model: getFreeChannelRouteModel(c.id, model),
        fallbackModels: getFreeChannelFallbackModels(c.id),
      };
    },
  );
  try {
    const info = await freeProxyEnsure(channels);
    if (info && Number.isFinite(info.port) && info.port > 0) {
      setCachedFreeProxyPort(info.port);
      if (typeof info.token === 'string') {
        setCachedFreeProxyToken(info.token);
      }
      return info.port;
    }
    if (opts.strict) {
      throw new Error('free proxy did not return a valid port');
    }
  } catch (err) {
    if (opts.strict) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`free proxy failed to start: ${message}`);
    }
    // Don't fail silently: the caller will route the claude CLI at the cached
    // port and, if the proxy never actually came up, the launch surfaces an
    // opaque ECONNREFUSED. Surfacing the underlying error here at least leaves
    // a breadcrumb in the console for diagnosis.
    console.warn('[freeChannels] ensureFreeProxy failed; using cached port', err);
  }
  return getCachedFreeProxyPort();
}
