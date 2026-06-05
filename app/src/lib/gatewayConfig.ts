import type { IRGraph } from '@/core/ir';
import type { RuntimeAdapterId } from '@/lib/adapters';
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

export const GATEWAY_CONFIG_STORAGE = 'fuc_model_gateway_v1';
export const ACTIVE_GATEWAY_SELECTION_STORAGE =
  'fuc_active_gateway_selection_v1';

const LEGACY_PROVIDERS_STORAGE = 'fuc_providers';
const LEGACY_ACTIVE_PROVIDER_STORAGE = 'fuc_active_provider_id';

interface LegacyProvider {
  id: string;
  kind?: string;
  adapter?: string;
  name?: string;
  apiKey?: string;
  baseUrl?: string;
  transport?: string;
  model?: string;
}

const hasWindow = (): boolean => typeof window !== 'undefined';

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
    window.dispatchEvent(new Event('fuc:gateway-config-changed'));
  } catch {
    /* ignore */
  }
}

function rawRemove(key: string): void {
  try {
    if (!hasWindow()) return;
    window.localStorage.removeItem(key);
    window.dispatchEvent(new Event('fuc:gateway-config-changed'));
  } catch {
    /* ignore */
  }
}

function normalizeAdapter(value: unknown): RuntimeAdapterId {
  if (value === 'codex' || value === 'gemini') return value;
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
  return {
    adapter: normalizeAdapter(raw.adapter),
    modelClass,
    ...(modelOverride ? { modelOverride } : {}),
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
        apiKey: typeof c.apiKey === 'string' ? c.apiKey : undefined,
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
    id: raw.id,
    kind,
    name: typeof raw.name === 'string' && raw.name ? raw.name : raw.id,
    adapter,
    channels,
  };
}

function stringRecord(value: object): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === 'string') out[key] = val;
  }
  return out;
}

function readStoredGatewayConfig(): GatewayConfig {
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
    return { version: 1, providers };
  } catch {
    return { version: 1, providers: [] };
  }
}

function readLegacyProviders(): LegacyProvider[] {
  const stored = rawGet(LEGACY_PROVIDERS_STORAGE);
  if (stored === null) return [];
  try {
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((value): LegacyProvider | null => {
        if (typeof value !== 'object' || value === null) return null;
        const raw = value as Record<string, unknown>;
        if (typeof raw.id !== 'string') return null;
        return {
          id: raw.id,
          kind: typeof raw.kind === 'string' ? raw.kind : undefined,
          adapter: typeof raw.adapter === 'string' ? raw.adapter : undefined,
          name: typeof raw.name === 'string' ? raw.name : undefined,
          apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : undefined,
          baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : undefined,
          transport:
            typeof raw.transport === 'string' ? raw.transport : undefined,
          model: typeof raw.model === 'string' ? raw.model : undefined,
        };
      })
      .filter((provider): provider is LegacyProvider => provider !== null);
  } catch {
    return [];
  }
}

function legacyKind(value: LegacyProvider): string {
  if (
    value.kind === 'codex' ||
    value.adapter === 'codex' ||
    value.kind === 'gemini' ||
    value.adapter === 'gemini'
  ) {
    return normalizeAdapter(value.kind ?? value.adapter);
  }
  return 'anthropic';
}

function legacyTransport(value: LegacyProvider): GatewayTransport {
  if (value.transport === 'cli') return 'cli';
  if (value.transport === 'direct') {
    return legacyKind(value) === 'anthropic' ? 'anthropic' : 'cli';
  }
  const kind = legacyKind(value);
  return kind === 'anthropic' ? 'anthropic' : 'cli';
}

function legacyProviderToGateway(provider: LegacyProvider): GatewayProvider {
  const kind = legacyKind(provider);
  const adapter = normalizeAdapter(kind === 'anthropic' ? 'claude-code' : kind);
  const transport = legacyTransport(provider);
  const name =
    provider.name?.trim() ||
    (adapter === 'claude-code' ? 'Claude' : adapter);
  return {
    id: provider.id,
    kind,
    name,
    adapter,
    channels: [
      {
        id: 'default',
        name: provider.model?.trim() || 'Default',
        apiKey: provider.apiKey ?? '',
        baseUrl: provider.baseUrl ?? '',
        model: provider.model,
        models: undefined,
        route: {
          transport,
          baseUrl: provider.baseUrl ?? '',
          model: provider.model,
          models: undefined,
        },
      },
    ],
  };
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
  const legacy = readLegacyProviders();
  const free = freeChannelGatewayProviders();

  if (legacy.length === 0) {
    return { version: 1, providers: [...stored.providers, ...free] };
  }

  const legacyIds = new Set(legacy.map((provider) => provider.id));
  const nonLegacy = stored.providers.filter(
    (provider) => !legacyIds.has(provider.id),
  );
  return {
    version: 1,
    providers: [...legacy.map(legacyProviderToGateway), ...nonLegacy, ...free],
  };
}

export function saveGatewayConfig(config: GatewayConfig): void {
  rawSet(
    GATEWAY_CONFIG_STORAGE,
    JSON.stringify({
      version: 1,
      providers: config.providers.map((provider) => ({
        ...provider,
        channels: provider.channels.map((channel) => ({
          ...channel,
          route: { ...channel.route },
        })),
      })),
    }),
  );
}

export function listGatewayProviders(): GatewayProvider[] {
  return loadGatewayConfig().providers;
}

export function getExplicitActiveGatewaySelection(): GatewaySelection | null {
  const stored = rawGet(ACTIVE_GATEWAY_SELECTION_STORAGE);
  if (stored) {
    try {
      const selection = normalizeSelection(JSON.parse(stored));
      if (selection) return selection;
    } catch {
      /* fall through to legacy active provider */
    }
  }

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
  rawSet(ACTIVE_GATEWAY_SELECTION_STORAGE, JSON.stringify(selection));
}

export const writeStoredGatewaySelection = setActiveGatewaySelection;

/**
 * Clear the explicit composer/run model pin so resolution falls back to the
 * Settings-active provider (the "inherit global selection" state). Leaves the
 * Settings active provider and the legacy pointer untouched.
 */
export function clearActiveGatewaySelection(): void {
  rawRemove(ACTIVE_GATEWAY_SELECTION_STORAGE);
}

/**
 * True when an explicit composer/run model pin is stored — i.e. the user has
 * chosen a specific channel rather than inheriting the global default.
 */
export function hasExplicitGatewayPin(): boolean {
  const stored = rawGet(ACTIVE_GATEWAY_SELECTION_STORAGE);
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
