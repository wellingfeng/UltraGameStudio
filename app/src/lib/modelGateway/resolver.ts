import type { IRGraph, IRNode } from '@/core/ir';
import {
  RUNTIME_ADAPTERS,
  runtimeAdapterLabel,
  type RuntimeAdapterId,
} from '@/lib/adapters';
import {
  getActiveProviderId,
  isProviderBaseUrlValid,
  providerBaseUrlHost,
  type ProviderKind,
} from '@/lib/apiConfig';
import {
  getCliRuntimeSnapshot,
  isCliAdapterAvailable,
} from '@/lib/cliConfig';
import {
  FREE_CHANNEL_AUTO_ID,
  FREE_CHANNEL_AUTO_MODEL,
  FREE_CHANNEL_PROVIDER_PREFIX,
  freeChannelReady,
  isFreeChannelAutoModel,
} from '@/lib/freeChannels';
import {
  getDefaultGatewaySelection,
  getExplicitActiveGatewaySelection,
  listGatewayProviders,
  preferredGatewayProvider,
  setActiveGatewaySelection,
} from '@/lib/gatewayConfig';
import {
  DEFAULT_GATEWAY_SELECTION,
  MODEL_CLASSES,
  type GatewayProvider,
  type GatewayRunOption,
  type GatewaySelection,
  type ModelClass,
  type NodeGatewayOverride,
  type ResolvedGatewayRoute,
} from './types';

// Bare tier words the claude CLI maps to a concrete model on its own. Passing
// these as --model is safe; the CLI resolves them against the active endpoint.
const CLI_TIER_ALIASES = new Set(['sonnet', 'opus', 'haiku']);

/**
 * True only for strings that are safe to pass as a claude CLI `--model` value:
 * a genuine `claude-*` model id, or a bare tier alias the CLI maps. cc-switch
 * route labels such as `kimi-for-coding` are still meaningful as
 * `ANTHROPIC_MODEL`, but should not be sent as a CLI flag.
 */
export function looksLikeClaudeModelId(model: unknown): boolean {
  if (typeof model !== 'string') return false;
  const lower = model.trim().toLowerCase();
  if (!lower) return false;
  return lower.startsWith('claude') || CLI_TIER_ALIASES.has(lower);
}

export function modelClassFromModelId(model: unknown): ModelClass {
  if (typeof model !== 'string') return DEFAULT_GATEWAY_SELECTION.modelClass;
  const lower = model.toLowerCase();
  if (lower.includes('haiku')) return 'haiku';
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  // A label that names no Claude tier (e.g. a cc-switch plan id like
  // "kimi-for-coding") must NOT be persisted as a modelClass. Default to the
  // standard tier so it never leaks downstream as a --model value.
  return DEFAULT_GATEWAY_SELECTION.modelClass;
}

export function normalizeGatewaySelection(
  value: Partial<GatewaySelection> | null | undefined,
): GatewaySelection {
  const adapter = normalizeAdapter(value?.adapter);
  const systemDefault = value?.systemDefault === true;
  const modelOverride =
    typeof value?.modelOverride === 'string' && value.modelOverride.trim()
      ? value.modelOverride.trim()
      : undefined;
  return {
    adapter,
    modelClass:
      typeof value?.modelClass === 'string' && value.modelClass
        ? value.modelClass
        : DEFAULT_GATEWAY_SELECTION.modelClass,
    ...(modelOverride ? { modelOverride } : {}),
    ...(systemDefault ? { systemDefault: true } : {}),
    ...(systemDefault
      ? {}
      : {
          providerId: value?.providerId || undefined,
          channelId: value?.channelId || undefined,
        }),
  };
}

export function systemDefaultGatewaySelection(
  adapterValue: unknown,
): GatewaySelection {
  return {
    adapter: normalizeAdapter(adapterValue),
    modelClass: 'default',
    systemDefault: true,
  };
}

export function workflowGatewaySelection(
  workflow: IRGraph,
  legacyModel?: string,
): GatewaySelection {
  const current = getExplicitActiveGatewaySelection();
  if (current) {
    return normalizeGatewaySelection({
      ...current,
      modelClass: current.modelClass || modelClassFromModelId(legacyModel),
    });
  }

  const defaults = workflow.meta.gateway?.defaults;
  if (defaults) return normalizeGatewaySelection(defaults);
  const active = getDefaultGatewaySelection();
  return normalizeGatewaySelection({
    ...active,
    adapter: normalizeAdapter(workflow.meta.adapter ?? active.adapter),
    modelClass: active.modelClass ?? modelClassFromModelId(legacyModel),
  });
}

/**
 * Resolve the workflow's own preferred selection, preferring the workflow's
 * pinned defaults and only falling back to the current global/default choice
 * when the workflow has never been pinned.
 */
export function workflowDefaultGatewaySelection(
  workflow: IRGraph,
  legacyModel?: string,
): GatewaySelection {
  const defaults = workflow.meta.gateway?.defaults;
  if (defaults) {
    return normalizeGatewaySelection({
      ...defaults,
      modelClass: defaults.modelClass || modelClassFromModelId(legacyModel),
    });
  }

  const active = getExplicitActiveGatewaySelection() ?? getDefaultGatewaySelection();
  return normalizeGatewaySelection({
    ...active,
    adapter: normalizeAdapter(workflow.meta.adapter ?? active.adapter),
    modelClass: active.modelClass ?? modelClassFromModelId(legacyModel),
  });
}

export function withWorkflowGatewaySelection(
  workflow: IRGraph,
  selection: GatewaySelection,
): IRGraph {
  const normalized = normalizeGatewaySelection(selection);
  setActiveGatewaySelection(normalized);
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

/**
 * Drop the workflow's pinned gateway defaults so model resolution falls back to
 * the Settings-active provider. Pairs with clearActiveGatewaySelection() to put
 * the composer into the "inherit global selection" state.
 */
export function withoutWorkflowGatewayDefaults(workflow: IRGraph): IRGraph {
  if (!workflow.meta.gateway?.defaults && workflow.meta.adapter === undefined) {
    return workflow;
  }
  const meta = { ...workflow.meta };
  delete meta.adapter;
  if (meta.gateway) {
    const gateway = { ...meta.gateway };
    delete gateway.defaults;
    meta.gateway = gateway;
  }
  return { ...workflow, meta };
}

export function normalizeGatewayWorkflow(
  workflow: IRGraph,
  legacyModel?: string,
): IRGraph {
  const defaults = workflowGatewaySelection(workflow, legacyModel);
  let changed = !workflow.meta.gateway?.defaults;
  const nodes = workflow.nodes.map((node) => {
    const normalized = normalizeGatewayParams(node.params);
    if (normalized === node.params) return node;
    changed = true;
    return { ...node, params: normalized };
  });
  if (!changed && workflow.meta.adapter === defaults.adapter) return workflow;
  return {
    ...workflow,
    meta: {
      ...workflow.meta,
      adapter: defaults.adapter,
      gateway: {
        ...(workflow.meta.gateway ?? {}),
        defaults,
      },
    },
    nodes,
  };
}

function normalizeGatewayParams(
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
    const normalized = normalizeGatewaySpecList(value);
    if (normalized !== value) ensureNext()[key] = normalized;
  }

  return next ?? params;
}

function normalizeGatewaySpecList(value: unknown): unknown {
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

export function nodeGatewayOverride(
  nodeOrParams: IRNode | Record<string, unknown>,
): NodeGatewayOverride | undefined {
  const rawParams = 'params' in nodeOrParams ? nodeOrParams.params : nodeOrParams;
  const params =
    typeof rawParams === 'object' && rawParams !== null
      ? (rawParams as Record<string, unknown>)
      : {};
  const rawGateway = params.gateway;
  const gateway =
    typeof rawGateway === 'object' && rawGateway !== null
      ? (rawGateway as Record<string, unknown>)
      : {};
  const override: NodeGatewayOverride = {};
  if (typeof gateway.modelClass === 'string') {
    override.modelClass = gateway.modelClass;
  }
  if (typeof gateway.providerId === 'string') {
    override.providerId = gateway.providerId || undefined;
  }
  if (typeof gateway.channelId === 'string') {
    override.channelId = gateway.channelId || undefined;
  }
  if (!override.modelClass && typeof params.model === 'string') {
    override.modelClass = modelClassFromModelId(params.model);
  }
  return Object.values(override).some(Boolean) ? override : undefined;
}

export function nodeParamsWithGatewayOverride(
  params: Record<string, unknown>,
  override: NodeGatewayOverride | null,
): Record<string, unknown> {
  const next = { ...params };
  delete next.model;
  delete next.gateway;

  const gateway = compactNodeGatewayOverride(override);
  if (!gateway) return next;

  return {
    ...next,
    ...(gateway.modelClass ? { model: gateway.modelClass } : {}),
    gateway,
  };
}

export function mergeGatewaySelection(
  global: GatewaySelection,
  override?: NodeGatewayOverride,
): GatewaySelection {
  if (!override) return normalizeGatewaySelection(global);
  const hasProviderOverride =
    override.providerId !== undefined || override.channelId !== undefined;
  const providerId =
    override.providerId !== undefined
      ? override.providerId
      : override.channelId
        ? undefined
        : global.providerId;
  return normalizeGatewaySelection({
    ...global,
    modelClass: override.modelClass ?? global.modelClass,
    modelOverride: override.modelClass ? undefined : global.modelOverride,
    providerId,
    channelId: override.channelId ?? global.channelId,
    systemDefault: hasProviderOverride ? undefined : global.systemDefault,
  });
}

export function resolveGatewayRoute(
  workflow: IRGraph,
  override?: NodeGatewayOverride,
): ResolvedGatewayRoute {
  const workflowSelection = workflowDefaultGatewaySelection(workflow);
  const selection = mergeGatewaySelection(workflowSelection, override);
  const source: ResolvedGatewayRoute['source'] = override ? 'node' : 'global';
  if (selection.systemDefault) {
    return cliFallbackRoute(selection, source);
  }
  const providers = listGatewayProviders();
  const provider = resolveProvider(providers, selection);
  const channel = provider
    ? selection.channelId
      ? provider.channels.find(
          (candidate) => candidate.id === selection.channelId,
        )
      : provider.channels[0]
    : undefined;

  if (!provider || !channel) {
    return cliFallbackRoute(selection, source);
  }

  const model = resolveChannelModel(provider, channel, selection);
  const baseUrl = (channel.route.baseUrl ?? channel.baseUrl ?? '').trim();
  const apiKey = (channel.apiKey ?? '').trim();
  const route: ResolvedGatewayRoute = {
    selection: {
      ...selection,
      providerId: provider.id,
      channelId: channel.id,
    },
    adapter: provider.adapter,
    modelClass: selection.modelClass,
    model,
    providerId: provider.id,
    providerName: provider.name,
    channelId: channel.id,
    channelName: channel.name,
    transport: channel.route.transport,
    mode:
      channel.route.transport === 'anthropic' ||
      channel.route.transport === 'openai-compatible'
        ? 'direct'
        : 'cli',
    apiKey,
    baseUrl,
    label: `${runtimeAdapterLabel(provider.adapter)} · ${provider.name} · ${channel.name} · ${selection.modelClass}`,
    source,
  };
  const env = gatewayRouteEnv(route);
  return env ? { ...route, env } : route;
}

export function listGatewayRunOptions(): GatewayRunOption[] {
  const providers = listGatewayProviders();
  const options: GatewayRunOption[] = [];
  const cliRuntime = getCliRuntimeSnapshot();

  for (const adapter of RUNTIME_ADAPTERS) {
    const selection = {
      adapter: adapter.id,
      modelClass: 'default',
      systemDefault: true,
    };
    options.push({
      id: selectionKey(selection),
      label: runtimeAdapterLabel(adapter.id),
      hint: 'System default',
      selection,
      transport: 'cli',
      channelName: 'System CLI',
    });
  }

  for (const provider of providers) {
    for (const channel of provider.channels) {
      if (!gatewayChannelAvailable(provider, channel)) continue;
      if (provider.adapter === 'claude-code') {
        // Claude exposes three model tiers; surface one option per tier.
        for (const modelClass of MODEL_CLASSES) {
          const selection = {
            adapter: provider.adapter,
            modelClass: modelClass.id,
            providerId: provider.id,
            channelId: channel.id,
          };
          options.push({
            id: selectionKey(selection),
            label: `${provider.name} · ${channel.name} · ${modelClass.label}`,
            hint: gatewayChannelHint(provider, channel),
            selection,
            transport: channel.route.transport,
            providerName: provider.name,
            channelName: channel.name,
          });
        }
      } else {
        // Codex / Gemini have no Claude-style tiers — one option per channel,
        // using the channel's own model (e.g. gpt-5.5).
        const model = (channel.model ?? channel.route.model ?? '').trim();
        const selection = {
          adapter: provider.adapter,
          modelClass: model || 'default',
          providerId: provider.id,
          channelId: channel.id,
        };
        options.push({
          id: selectionKey(selection),
          label: `${provider.name} · ${channel.name}`,
          hint: gatewayChannelHint(provider, channel),
          selection,
          transport: channel.route.transport,
          providerName: provider.name,
          channelName: channel.name,
        });
      }
    }
  }

  const cliCandidates = cliRuntime.candidates.filter(
    (candidate) => candidate.status === 'available',
  );
  for (const candidate of cliCandidates) {
    const adapter = normalizeAdapter(candidate.adapter);
    const channelName =
      candidate.source === 'custom' ? 'Custom CLI' : 'System CLI';
    if (adapter === 'claude-code') {
      for (const modelClass of MODEL_CLASSES) {
        const selection = {
          adapter,
          modelClass: modelClass.id,
          channelId: candidate.id,
        };
        options.push({
          id: selectionKey(selection),
          label: `${runtimeAdapterLabel(adapter)} · ${candidate.command} · ${modelClass.label}`,
          hint: candidate.path ?? candidate.command,
          selection,
          transport: 'cli',
          channelName,
        });
      }
    } else {
      // Codex / Gemini system CLI: one entry; the model comes from the CLI's
      // own config, so no Claude tier is shown.
      const selection = { adapter, modelClass: 'default', channelId: candidate.id };
      options.push({
        id: selectionKey(selection),
        label: `${runtimeAdapterLabel(adapter)} · ${candidate.command}`,
        hint: candidate.path ?? candidate.command,
        selection,
        transport: 'cli',
        channelName,
      });
    }
  }

  return options;
}

function compactNodeGatewayOverride(
  override: NodeGatewayOverride | null,
): NodeGatewayOverride | undefined {
  if (!override) return undefined;
  const gateway: NodeGatewayOverride = {
    ...(override.modelClass ? { modelClass: override.modelClass } : {}),
    ...(override.providerId ? { providerId: override.providerId } : {}),
    ...(override.channelId ? { channelId: override.channelId } : {}),
  };
  return Object.values(gateway).some(Boolean) ? gateway : undefined;
}

export function selectionKey(selection: GatewaySelection): string {
  return [
    selection.adapter,
    selection.modelClass,
    selection.providerId ?? '',
    selection.channelId ?? '',
    selection.systemDefault ? 'system' : '',
    selection.modelOverride ?? '',
  ].join('|');
}

export function bestAvailableSelection(
  current: GatewaySelection,
  options: GatewayRunOption[],
): GatewaySelection {
  const currentKey = selectionKey(current);
  return (
    options.find((option) => option.id === currentKey)?.selection ??
    options.find((option) => option.selection.adapter === current.adapter)
      ?.selection ??
    options[0]?.selection ??
    current
  );
}

export function selectionFromKey(key: string): GatewaySelection | null {
  const [
    adapter,
    modelClass,
    providerId,
    channelId,
    systemDefault,
    modelOverride,
  ] =
    key.split('|');
  if (!adapter || !modelClass) return null;
  return normalizeGatewaySelection({
    adapter: normalizeAdapter(adapter),
    modelClass,
    modelOverride: modelOverride || undefined,
    providerId: providerId || undefined,
    channelId: channelId || undefined,
    systemDefault: systemDefault === 'system' || systemDefault === 'true',
  });
}

export function gatewayRouteEnv(
  route: Pick<
    ResolvedGatewayRoute,
    'transport' | 'adapter' | 'apiKey' | 'baseUrl' | 'model'
  >,
): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  if (route.transport === 'anthropic') {
    if (route.apiKey) {
      env.ANTHROPIC_API_KEY = route.apiKey;
      env.ANTHROPIC_AUTH_TOKEN = route.apiKey;
    }
    if (route.baseUrl) env.ANTHROPIC_BASE_URL = route.baseUrl;
    if (route.model) env.ANTHROPIC_MODEL = route.model;
  } else if (route.transport === 'openai-compatible') {
    if (route.apiKey) env.OPENAI_API_KEY = route.apiKey;
    if (route.baseUrl) env.OPENAI_BASE_URL = route.baseUrl;
    if (route.model) env.OPENAI_MODEL = route.model;
  } else if (route.transport === 'cli') {
    // CLI adapters read credentials from their own config or env. Inject the
    // selected channel's key + base url so imported cc-switch providers target
    // the same relay/model without re-running cc-switch.
    if (route.adapter === 'claude-code') {
      if (route.apiKey) {
        env.ANTHROPIC_API_KEY = route.apiKey;
        env.ANTHROPIC_AUTH_TOKEN = route.apiKey;
      }
      if (route.baseUrl) env.ANTHROPIC_BASE_URL = route.baseUrl;
      if (route.model) env.ANTHROPIC_MODEL = route.model;
    } else if (route.adapter === 'codex') {
      if (route.apiKey) env.OPENAI_API_KEY = route.apiKey;
      if (route.baseUrl) env.OPENAI_BASE_URL = route.baseUrl;
    } else if (route.adapter === 'gemini') {
      if (route.apiKey) {
        env.GEMINI_API_KEY = route.apiKey;
        env.GOOGLE_API_KEY = route.apiKey;
      }
      if (route.baseUrl) env.GOOGLE_GEMINI_BASE_URL = route.baseUrl;
    }
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

function normalizeKnownProviderModel(
  baseUrl: string | undefined,
  model: string | undefined,
): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;

  const host = providerBaseUrlHost(baseUrl ?? '').toLowerCase();
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

function adapterToProviderKind(adapter: string): ProviderKind {
  if (adapter === 'codex') return 'codex';
  if (adapter === 'gemini') return 'gemini';
  return 'anthropic';
}

function resolveProvider(
  providers: GatewayProvider[],
  selection: GatewaySelection,
): GatewayProvider | undefined {
  const adapter = normalizeAdapter(selection.adapter);
  if (selection.providerId) {
    const selected = providers.find(
      (provider) => provider.id === selection.providerId,
    );
    if (selected && selected.adapter === adapter) {
      if (selected.id.startsWith(FREE_CHANNEL_PROVIDER_PREFIX)) {
        const freeId = selected.id.slice(FREE_CHANNEL_PROVIDER_PREFIX.length);
        if (!freeChannelReady(freeId)) return undefined;
      }
      return selected;
    }
  }
  // No (or stale) channel pinned → fall back to the category default, then
  // prefer any CLI-backed provider for the adapter before taking the first
  // remaining match. This keeps cc-switch imports on the local runtime.
  const activeId = getActiveProviderId(
    adapterToProviderKind(adapter),
  );
  if (activeId) {
    const active = providers.find((provider) => provider.id === activeId);
    if (active && active.adapter === adapter) return active;
  }
  return preferredGatewayProvider(providers, adapter);
}

function gatewayChannelAvailable(
  provider: GatewayProvider,
  channel: GatewayProvider['channels'][number],
): boolean {
  const transport = channel.route.transport;
  if (transport === 'anthropic' || transport === 'openai-compatible') {
    const apiKey = (channel.apiKey ?? '').trim();
    const baseUrl = (channel.route.baseUrl ?? channel.baseUrl ?? '').trim();
    return apiKey.length > 0 && isProviderBaseUrlValid(baseUrl);
  }
  if (transport === 'cli') {
    if (!isCliAdapterAvailable(provider.adapter, getCliRuntimeSnapshot())) {
      return false;
    }
    // freecc:* synthetic providers reuse the claude-code CLI transport but
    // carry only a placeholder apiKey ('freecc'); their real upstream key lives
    // in localStorage. Gate them on freeChannelReady so a channel with no key
    // (or a local channel) is only "available" when it can actually be reached
    // through the proxy — otherwise the run 404s with no clear remediation.
    if (provider.id.startsWith(FREE_CHANNEL_PROVIDER_PREFIX)) {
      return freeChannelReady(
        provider.id.slice(FREE_CHANNEL_PROVIDER_PREFIX.length),
      );
    }
    return true;
  }
  return false;
}

function gatewayChannelHint(
  provider: GatewayProvider,
  channel: GatewayProvider['channels'][number],
): string {
  const transport = channel.route.transport;
  if (transport === 'anthropic' || transport === 'openai-compatible') {
    const baseUrl = channel.route.baseUrl ?? channel.baseUrl ?? '';
    return `${transport === 'anthropic' ? 'Anthropic API' : 'OpenAI-compatible'} · ${providerBaseUrlHost(baseUrl)}`;
  }
  if (transport === 'cli') {
    const baseUrl = channel.route.baseUrl ?? channel.baseUrl ?? '';
    const host = baseUrl.trim() ? ` · ${providerBaseUrlHost(baseUrl)}` : '';
    return `${runtimeAdapterLabel(provider.adapter)} CLI${host}`;
  }
  return transport;
}

function resolveChannelModel(
  provider: GatewayProvider,
  channel: GatewayProvider['channels'][number],
  selection: GatewaySelection,
): string | undefined {
  const baseUrl = channel.route.baseUrl ?? channel.baseUrl;
  const isFreeAutoProvider =
    provider.id === `${FREE_CHANNEL_PROVIDER_PREFIX}${FREE_CHANNEL_AUTO_ID}`;
  const modelOverride = normalizeKnownProviderModel(
    baseUrl,
    isFreeAutoProvider && isFreeChannelAutoModel(selection.modelOverride)
      ? undefined
      : selection.modelOverride,
  );
  if (modelOverride) return modelOverride;

  const modelClass = isFreeAutoProvider
    ? FREE_CHANNEL_AUTO_MODEL
    : selection.modelClass;
  // litellm-style per-tier maps win: an explicit tier->modelId mapping is a
  // deliberate real model id, so it is always honoured (claude-code included).
  const tierModel =
    channel.route.models?.[modelClass] ?? channel.models?.[modelClass];
  if (tierModel) return normalizeKnownProviderModel(baseUrl, tierModel);

  const channelModel = normalizeKnownProviderModel(
    baseUrl,
    isFreeAutoProvider && isFreeChannelAutoModel(channel.route.model ?? channel.model)
      ? undefined
      : channel.route.model ?? channel.model,
  );

  if (provider.adapter === 'claude-code') {
    if (channelModel) {
      // A channel model from cc-switch may be a relay route label rather than a
      // Claude model id. Preserve it so gatewayRouteEnv can export
      // ANTHROPIC_MODEL and the selected relay/channel is actually used; the
      // Rust launcher still filters non-Claude labels out of the `--model` CLI
      // flag via should_pass_model().
      return channelModel;
    }
    // No channel model configured. For CLI launches the bare tier aliases are
    // safe and useful because the claude CLI maps them. For browser-direct
    // Anthropic calls, omit the model so streamAnthropic uses its concrete
    // default instead of sending an invalid tier alias like "sonnet".
    return channel.route.transport === 'cli' && looksLikeClaudeModelId(modelClass)
      ? modelClass
      : undefined;
  }

  // codex / gemini: their model ids are real upstream ids; pass through.
  return channelModel ?? modelClass;
}

function cliFallbackRoute(
  selection: GatewaySelection,
  source: ResolvedGatewayRoute['source'],
): ResolvedGatewayRoute {
  const adapter = normalizeAdapter(selection.adapter);
  const modelLabel = selection.modelOverride?.trim() || selection.modelClass;
  const model =
    modelLabel === 'default'
      ? undefined
      : adapter === 'claude-code'
      ? // Tier alias (sonnet/opus/haiku) -> let the CLI map it; any other
        // modelClass (a custom label) -> omit --model and use the relay default.
        CLI_TIER_ALIASES.has(modelLabel)
        ? modelLabel
        : undefined
      : modelLabel;
  return {
    selection: { ...selection, adapter },
    adapter,
    modelClass: selection.modelClass,
    model,
    providerId: selection.providerId,
    channelId: selection.channelId,
    transport: 'cli',
    mode: 'cli',
    label: `${runtimeAdapterLabel(adapter)} CLI · ${
      selection.systemDefault ? 'system default' : modelLabel
    }`,
    source,
  };
}

function normalizeAdapter(value: unknown): RuntimeAdapterId {
  if (value === 'codex' || value === 'gemini') return value;
  return 'claude-code';
}
