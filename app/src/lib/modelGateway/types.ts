import type {
  GatewaySelection,
  ModelClass,
  NodeGatewayOverride,
} from '@/core/ir';
import type { ProviderRuntimeStatus } from '@/lib/apiConfig';
import type { RuntimeAdapterId } from '@/lib/adapters';
import type { UsageMeterContext } from '@/lib/usageMeter';

export type { GatewaySelection, ModelClass, NodeGatewayOverride };

export type GatewayTransport =
  | 'anthropic'
  | 'openai-compatible'
  | 'cli'
  | 'simulator';

export const DEFAULT_GATEWAY_SELECTION: GatewaySelection = {
  adapter: 'claude-code',
  modelClass: 'sonnet',
};

export const MODEL_CLASSES = [
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'opus', label: 'Opus' },
  { id: 'haiku', label: 'Haiku' },
] as const satisfies ReadonlyArray<{ id: ModelClass; label: string }>;

export interface GatewayChannel {
  id: string;
  name: string;
  apiKey: string | undefined;
  baseUrl: string | undefined;
  model: string | undefined;
  models: Record<string, string> | undefined;
  route: {
    transport: GatewayTransport;
    baseUrl: string | undefined;
    model: string | undefined;
    models: Record<string, string> | undefined;
  };
}

export interface GatewayProvider {
  id: string;
  kind: string;
  name: string;
  adapter: RuntimeAdapterId;
  channels: GatewayChannel[];
}

export interface GatewayConfig {
  version: 1;
  providers: GatewayProvider[];
}

export interface GatewayRunOption {
  id: string;
  selection: GatewaySelection;
  label: string;
  hint: string;
  transport: GatewayTransport;
  providerName?: string;
  channelName?: string;
}

export interface GatewayRouteOption {
  id: string;
  selection: GatewaySelection;
  label: string;
  hint: string;
  providerLabel: string;
  channelLabel: string;
  modelLabel: string;
  status: ProviderRuntimeStatus;
}

export interface ResolvedGatewayRoute {
  selection: GatewaySelection;
  adapter: RuntimeAdapterId;
  modelClass: ModelClass;
  model?: string;
  providerId?: string;
  providerName?: string;
  channelId?: string;
  channelName?: string;
  transport: GatewayTransport;
  mode: 'direct' | 'cli' | 'simulator';
  apiKey?: string;
  baseUrl?: string;
  cliCommand?: string;
  label: string;
  source: 'global' | 'node' | 'fallback';
  env?: Record<string, string>;
}

export interface GatewayTextRequest {
  route: ResolvedGatewayRoute;
  system: string;
  userContent: string;
  /**
   * Optional images attached to the user turn for multimodal (vision) prompts.
   * Each entry is a `data:` URL or an http(s) URL. Only the direct transports
   * (`anthropic`, `openai-compatible`) consume these; the CLI transport ignores
   * them. Used by the asset-verification loop so a vision model can "see" a
   * freshly generated image/sprite render and judge whether it matches intent.
   */
  userImages?: string[];
  maxTokens?: number;
  signal?: AbortSignal;
  runId?: string;
  usageContext?: UsageMeterContext;
  onDelta?: (chunk: string) => void;
  onUsage?: (usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  }) => void;
  permission?: string;
  cwd?: string;
  forceCli?: boolean;
  timeoutSeconds?: number;
  idleTimeoutSeconds?: number;
}
