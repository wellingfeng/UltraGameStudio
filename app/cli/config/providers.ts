/**
 * CLI-side provider / gateway resolution. Replaces the GUI's localStorage-backed
 * `gatewayConfig` / `apiConfig` / `cliConfig` with environment variables + an
 * `~/.fuc/config.json` / `./.fuc/config.json` file (spec §10.2).
 *
 * Credentials only ever live in `process.env` or in-memory route objects — they
 * are NEVER written to disk or logged by this module. The config FILE carries
 * defaults + non-secret routing (adapter/model/baseUrl/transport); API keys are
 * read exclusively from env (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` /
 * `GEMINI_API_KEY` / `GOOGLE_API_KEY`).
 *
 * Pure Node: `node:fs` / `node:path` / `node:os` + `process.env`. No react /
 * zustand / tauri. Reuses the pure model-class helpers locally (mirrors
 * resolver.ts so the CLI need not import the browser-only resolver).
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  GatewaySelection,
  NodeGatewayOverride,
} from '../../src/core/ir';
import { adapterProtocol } from '../io/which-cli';

export type GatewayTransport = 'anthropic' | 'openai-compatible' | 'cli';

/** A resolved route: enough to do direct HTTP, or to spawn a CLI with env. */
export interface ResolvedRoute {
  selection: GatewaySelection;
  adapter: string;
  modelClass: string;
  model?: string;
  transport: GatewayTransport;
  mode: 'direct' | 'cli';
  apiKey?: string;
  baseUrl?: string;
  /** Per-spawn env overlay (credentials for CLI adapters). */
  env?: Record<string, string>;
}

const CLI_TIER_ALIASES = new Set(['sonnet', 'opus', 'haiku']);

const DEFAULT_SELECTION: GatewaySelection = {
  adapter: 'claude-code',
  modelClass: 'sonnet',
};

/** Mirror of resolver.ts#looksLikeClaudeModelId. */
function looksLikeClaudeModelId(model: unknown): boolean {
  if (typeof model !== 'string') return false;
  const lower = model.trim().toLowerCase();
  if (!lower) return false;
  return lower.startsWith('claude') || CLI_TIER_ALIASES.has(lower);
}

/** Mirror of resolver.ts#modelClassFromModelId. */
export function modelClassFromModelId(model: unknown): string {
  if (typeof model !== 'string') return DEFAULT_SELECTION.modelClass;
  const lower = model.toLowerCase();
  if (lower.includes('haiku')) return 'haiku';
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  return DEFAULT_SELECTION.modelClass;
}

function normalizeAdapter(value: unknown): string {
  if (value === 'codex' || value === 'gemini') return value;
  if (value === 'claude' || value === 'claude-code') return 'claude-code';
  return typeof value === 'string' && value ? value : 'claude-code';
}

function providerHost(baseUrl: string | undefined): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return '';
  try {
    return new URL(trimmed).host.toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

function normalizeKnownProviderModel(
  baseUrl: string | undefined,
  model: string | undefined,
): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;

  const host = providerHost(baseUrl);
  const lower = trimmed.toLowerCase();
  if (host.includes('integrate.api.nvidia.com')) {
    if (!trimmed.includes('/') && lower.includes('nemotron')) {
      return `nvidia/${lower}`;
    }
  }
  if (host.includes('openrouter.ai')) {
    if (/^glm-\d/i.test(trimmed)) return `z-ai/${lower}`;
    if (lower.startsWith('z-ai/glm-')) return lower;
  }
  if (host.includes('fireworks.ai')) {
    if (!trimmed.includes('/') && lower.startsWith('llama-')) {
      return `accounts/fireworks/models/${lower}`;
    }
  }
  if (
    host.includes('opencode.ai') ||
    host.includes('z.ai') ||
    host.includes('bigmodel.cn')
  ) {
    if (/^glm-\d/i.test(trimmed)) return lower;
  }
  return trimmed;
}

/** Merge a per-node/spec override onto a selection (mirror of mergeGatewaySelection). */
export function applyOverride(
  selection: GatewaySelection,
  override?: NodeGatewayOverride,
): GatewaySelection {
  if (!override) return { ...selection };
  const hasProviderOverride =
    override.providerId !== undefined || override.channelId !== undefined;
  const providerId =
    override.providerId !== undefined
      ? override.providerId
      : override.channelId
        ? undefined
        : selection.providerId;
  return {
    adapter: selection.adapter,
    modelClass: override.modelClass ?? selection.modelClass,
    providerId,
    channelId: override.channelId ?? selection.channelId,
    ...(hasProviderOverride ? {} : selection.systemDefault ? { systemDefault: true } : {}),
  };
}

/** The CLI config-file shape (spec §10.2). All fields optional; secrets excluded. */
interface FucConfigFile {
  version?: number;
  defaults?: {
    adapter?: string;
    model?: string;
    modelClass?: string;
    concurrency?: number;
    maxRetries?: number;
    timeoutSeconds?: number;
  };
  /** Per-adapter direct-HTTP routing (baseUrl/transport/model). Keys are non-secret. */
  providers?: Record<
    string,
    {
      transport?: GatewayTransport;
      baseUrl?: string;
      model?: string;
      /** Per-tier model map for claude (litellm style). */
      models?: Record<string, string>;
    }
  >;
  /** Per-adapter CLI executable paths. */
  adapters?: Record<string, { path?: string }>;
}

let cachedConfig: FucConfigFile | null = null;
let cachedConfigLoaded = false;

/**
 * Load + merge `~/.fuc/config.json` then `./.fuc/config.json` (project wins).
 * Pre-rebrand `.owf/` and `.owf.json` paths are read as lower-priority fallbacks.
 */
export function loadFucConfig(cwd: string = process.cwd()): FucConfigFile {
  if (cachedConfigLoaded) return cachedConfig ?? {};
  cachedConfigLoaded = true;
  const home = homedir();
  // `.owf` paths are the pre-rebrand locations, kept as lower-priority
  // fallbacks so existing configs keep working; `.fuc` paths override them.
  const candidates = [
    join(home, '.owf', 'config.json'),
    join(home, '.owf.json'),
    join(home, '.fuc', 'config.json'),
    join(home, '.fuc.json'),
    join(cwd, '.owf', 'config.json'),
    join(cwd, '.owf.json'),
    join(cwd, '.fuc', 'config.json'),
    join(cwd, '.fuc.json'),
  ];
  let merged: FucConfigFile = {};
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as FucConfigFile;
      merged = {
        ...merged,
        ...parsed,
        defaults: { ...merged.defaults, ...parsed.defaults },
        providers: { ...merged.providers, ...parsed.providers },
        adapters: { ...merged.adapters, ...parsed.adapters },
      };
    } catch {
      /* ignore malformed config */
    }
  }
  cachedConfig = merged;
  return merged;
}

/** Reset the memoised config (testing seam). */
export function resetFucConfigCache(): void {
  cachedConfig = null;
  cachedConfigLoaded = false;
}

/** Read an API key from env for an adapter (never from the config file). */
function apiKeyForAdapter(adapter: string): string | undefined {
  const protocol = adapterProtocol(adapter);
  const pick = (...names: string[]): string | undefined => {
    for (const n of names) {
      const v = process.env[n]?.trim();
      if (v) return v;
    }
    return undefined;
  };
  if (protocol === 'codex') return pick('OPENAI_API_KEY');
  if (protocol === 'gemini') return pick('GEMINI_API_KEY', 'GOOGLE_API_KEY');
  return pick('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN');
}

/** Build the per-spawn env overlay for a CLI route (mirror of gatewayRouteEnv, cli branch). */
export function cliRouteEnv(route: ResolvedRoute): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  const { adapter, apiKey, baseUrl, model } = route;
  const protocol = adapterProtocol(adapter);
  if (protocol === 'codex') {
    if (apiKey) env.OPENAI_API_KEY = apiKey;
    if (baseUrl) env.OPENAI_BASE_URL = baseUrl;
  } else if (protocol === 'gemini') {
    if (apiKey) {
      env.GEMINI_API_KEY = apiKey;
      env.GOOGLE_API_KEY = apiKey;
    }
    if (baseUrl) env.GOOGLE_GEMINI_BASE_URL = baseUrl;
  } else {
    if (apiKey) {
      env.ANTHROPIC_API_KEY = apiKey;
      env.ANTHROPIC_AUTH_TOKEN = apiKey;
    }
    if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
    if (model) env.ANTHROPIC_MODEL = model;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

/**
 * Resolve the run's default {@link GatewaySelection} from flags + config + env.
 * `flags` come from `fuc run --adapter/--model/--provider`.
 */
export function resolveSelection(flags: {
  adapter?: string;
  model?: string;
  providerId?: string;
  cwd?: string;
} = {}): GatewaySelection {
  const config = loadFucConfig(flags.cwd);
  const adapter = normalizeAdapter(
    flags.adapter ?? config.defaults?.adapter ?? DEFAULT_SELECTION.adapter,
  );
  const modelHint =
    flags.model ?? config.defaults?.model ?? config.defaults?.modelClass;
  const modelClass = modelHint
    ? adapter === 'claude-code'
      ? modelClassFromModelId(modelHint)
      : modelHint
    : DEFAULT_SELECTION.modelClass;
  return {
    adapter,
    modelClass,
    providerId: flags.providerId,
  };
}

/**
 * Resolve a direct-HTTP route for a selection, or null when none is configured.
 * A direct route requires: an explicit `anthropic` / `openai-compatible`
 * transport for the adapter in config AND an API key in env. Otherwise the run
 * falls back to the CLI path.
 */
export function resolveDirectRoute(
  selection: GatewaySelection,
  cwd?: string,
): ResolvedRoute | null {
  const config = loadFucConfig(cwd);
  const adapter = normalizeAdapter(selection.adapter);
  const provider = providerForSelection(config, selection, adapter);
  const transport = provider?.transport;
  if (transport !== 'anthropic' && transport !== 'openai-compatible') return null;
  const apiKey = apiKeyForAdapter(adapter);
  if (!apiKey) return null;
  const model = resolveModel(adapter, selection.modelClass, provider, transport);
  return {
    selection,
    adapter,
    modelClass: selection.modelClass,
    model,
    transport,
    mode: 'direct',
    apiKey,
    baseUrl: provider?.baseUrl?.trim() || undefined,
  };
}

/**
 * Resolve a CLI route (executable + env). Always succeeds for a known adapter:
 * the CLI binary is located lazily at spawn time (which-cli). Injects any
 * configured channel credentials so an imported relay still targets the right
 * endpoint, exactly like the GUI's CLI-transport branch.
 */
export function resolveCliRoute(
  selection: GatewaySelection,
  cwd?: string,
): ResolvedRoute {
  const config = loadFucConfig(cwd);
  const adapter = normalizeAdapter(selection.adapter);
  const provider = providerForSelection(config, selection, adapter);
  const model = resolveModel(adapter, selection.modelClass, provider, 'cli');
  const apiKey = apiKeyForAdapter(adapter);
  const route: ResolvedRoute = {
    selection,
    adapter,
    modelClass: selection.modelClass,
    model,
    transport: 'cli',
    mode: 'cli',
    apiKey,
    baseUrl: provider?.baseUrl?.trim() || undefined,
  };
  const env = cliRouteEnv(route);
  return env ? { ...route, env } : route;
}

/** Resolve the concrete model id/flag for a route (mirror of resolveChannelModel + cliFallbackRoute). */
type ProviderEntry = NonNullable<FucConfigFile['providers']>[string];

function providerForSelection(
  config: FucConfigFile,
  selection: GatewaySelection,
  adapter: string,
): ProviderEntry | undefined {
  const providerId = selection.providerId?.trim();
  if (providerId) {
    const explicit = config.providers?.[providerId];
    if (explicit) return explicit;
  }
  return config.providers?.[adapter] ?? config.providers?.[selection.adapter];
}

function resolveModel(
  adapter: string,
  modelClass: string,
  provider: ProviderEntry | undefined,
  transport: GatewayTransport,
): string | undefined {
  const tierModel = provider?.models?.[modelClass];
  if (tierModel) return normalizeKnownProviderModel(provider?.baseUrl, tierModel);
  const channelModel = normalizeKnownProviderModel(
    provider?.baseUrl,
    provider?.model,
  );

  if (adapter === 'claude-code') {
    if (channelModel) return channelModel;
    if (modelClass === 'default') return undefined;
    // CLI: bare tier alias is mapped by the claude CLI. Direct: omit so the
    // SDK uses its concrete default rather than sending an invalid alias.
    return transport === 'cli' && looksLikeClaudeModelId(modelClass)
      ? modelClass
      : undefined;
  }
  // codex / gemini: real upstream ids pass through.
  return channelModel ?? (modelClass === 'default' ? undefined : modelClass);
}
