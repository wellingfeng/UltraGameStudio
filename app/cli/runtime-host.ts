/**
 * Node host for the shared run engine. Assembles a {@link RunGateway} +
 * {@link RunCallbacks} + {@link RunContext} against Node IO (child_process spawn,
 * fetch, readline) and drives `executeWorkflowDag` from `src/runtime`.
 *
 * The desktop GUI implements the SAME contract against Zustand + the Tauri spawn
 * seam, so a `runBlueprint` run is observably identical to a GUI run: same DAG
 * order, retries, interaction loop and terminal state.
 *
 *   runBlueprint(ir, opts) -> Promise<RunResult>
 *
 * Direct-HTTP completion reuses `lib/anthropic#streamAnthropic` for the
 * anthropic transport and an inline SSE reader for openai-compatible
 * (codex/gemini relays). The CLI subprocess path is `io/cli-spawn#spawnCliAgent`.
 * RunCallbacks fan node state / logs / streaming chunks out as structured events
 * (consumed by Phase 2's stderr logger + `--json` output).
 *
 * Pure Node: imports only `src/core`, `src/runtime`, `src/lib/anthropic`
 * (pure fetch streamer), and the sibling `io/` + `config/` modules. No react /
 * zustand / tauri / `@/store/useStore` / `@tauri-apps/*`.
 */
import type { GatewaySelection, IRGraph, IRNode, IRRunStatus } from '../src/core/ir';
import type {
  InteractionAnswer,
  InteractionRequest,
} from '../src/core/interaction';
import { streamAnthropic } from '../src/lib/anthropic';
import {
  executeWorkflowDag,
  type ExecuteWorkflowOptions,
  type RunCallbacks,
  type RunContext,
  type RunFailure,
  type RunGateway,
  type RunResult,
  type RunStreamHandle,
  type RunTimeoutPolicy,
} from '../src/runtime';
import {
  applyOverride as applyGatewayOverride,
  cliRouteEnv,
  loadFucConfig,
  modelClassFromModelId,
  resolveCliRoute,
  resolveDirectRoute,
  resolveSelection,
  type ResolvedRoute,
} from './config/providers';
import { spawnCliAgent } from './io/cli-spawn';
import { createTerminalInteraction } from './io/interaction';
import { whichCli } from './io/which-cli';

/** Options for {@link runBlueprint}. */
export interface RunOptions {
  /** Adapter override (`--adapter`). */
  adapter?: string;
  /** Model override (`--model`). */
  model?: string;
  /** Provider id override (`--provider`). */
  providerId?: string;
  /** Working directory for the agent CLIs (`--cwd`, default process.cwd()). */
  cwd?: string;
  /** Permission mode: 'full' | 'readonly' | 'ask' (default 'full'). */
  permission?: string;
  /** Bounded concurrency for independent nodes (`--concurrency`, default 3). */
  concurrency?: number;
  /** Auto-retry budget for transient failures (`--max-retries`, default 2). */
  maxRetries?: number;
  /** Default consensus fan-out samples (default 3). */
  consensusSamples?: number;
  runtimeVoteSamplesMin?: number;
  runtimeVoteSamplesMax?: number;
  terminalVoteSamplesMin?: number;
  terminalVoteSamplesMax?: number;
  complexityScaling?: number;
  escalationBudget?: number;
  adaptiveEscalation?: boolean;
  /** Per-node hard timeout seconds (`--timeout`). */
  timeoutSeconds?: number;
  idleTimeoutSeconds?: number;
  /** Disable terminal interaction (`--non-interactive`); requests auto-skip. */
  nonInteractive?: boolean;
  /** Resume seed (from a previous run snapshot). */
  resumeFromNodeId?: string | null;
  seedOutputs?: Record<string, string>;
  seedRunState?: Record<string, IRRunStatus>;
  /** Pre-resolved selection (skips flag/config resolution). */
  selection?: GatewaySelection;
  /** Injected gateway (testing seam — bypasses real spawn/HTTP). */
  gateway?: RunGateway;
  /** Structured run-event sink (Phase 2 stderr logger / --json consumer). */
  onEvent?: (event: RunEvent) => void;
  /** Override interaction handler (default terminal / non-interactive). */
  promptInteraction?: (req: InteractionRequest) => Promise<InteractionAnswer | null>;
  /** Cancellation signal: aborting kills in-flight CLI processes. */
  signal?: AbortSignal;
}

/** A structured run event (the CLI's machine-readable equivalent of GUI side effects). */
export type RunEvent =
  | { kind: 'node_start'; nodeId: string; nodeType: string; label?: string }
  | { kind: 'node_success'; nodeId: string; output: string | null }
  | { kind: 'node_failure'; nodeId: string; failure: RunFailure; state: IRRunStatus }
  | {
      kind: 'node_retry';
      nodeId: string;
      failure: RunFailure;
      attempt: number;
      maxRetries: number;
      backoffMs: number;
    }
  | { kind: 'log'; text: string; role: 'system' | 'assistant' | 'node' | 'error' }
  | { kind: 'stream_begin'; header: string; streamId: number }
  | { kind: 'stream_append'; streamId: number; chunk: string }
  | { kind: 'stream_finalize'; streamId: number; text: string }
  | { kind: 'stream_fail'; streamId: number; text: string };

/** ANSI-free SSE reader for an OpenAI-compatible chat-completions endpoint. */
async function completeOpenAICompatible(args: {
  apiKey: string;
  baseUrl?: string;
  model: string;
  prompt: string;
  maxTokens?: number;
  signal?: AbortSignal;
  onDelta?: (chunk: string) => void;
}): Promise<string> {
  const endpoint = resolveChatEndpoint(args.baseUrl);
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${args.apiKey}`,
    },
    body: JSON.stringify({
      model: args.model,
      stream: true,
      max_tokens: args.maxTokens ?? 4096,
      messages: [{ role: 'user', content: args.prompt }],
    }),
    signal: args.signal,
  });
  if (!res.ok || !res.body) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 500);
    } catch {
      detail = '<no body>';
    }
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const evt = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const chunk = evt.choices?.[0]?.delta?.content;
        if (chunk) {
          full += chunk;
          args.onDelta?.(chunk);
        }
      } catch {
        /* ignore keep-alive */
      }
    }
  }
  return full;
}

function resolveChatEndpoint(baseUrl?: string): string {
  const raw = baseUrl?.trim().replace(/\/+$/, '');
  if (!raw) return 'https://api.openai.com/v1/chat/completions';
  if (raw.endsWith('/chat/completions')) return raw;
  if (raw.endsWith('/v1')) return `${raw}/chat/completions`;
  return `${raw}/v1/chat/completions`;
}

/** Per-call timeout policy (mirrors GUI timeoutPolicyForSelection's intent). */
function nodeTimeoutPolicy(): RunTimeoutPolicy {
  const t = Number(process.env.FREEULTRACODE_AI_CLI_TIMEOUT_SECS);
  const i = Number(process.env.FREEULTRACODE_AI_CLI_IDLE_TIMEOUT_SECS);
  return {
    timeoutSeconds: Number.isFinite(t) && t >= 60 ? Math.floor(t) : 1800,
    idleTimeoutSeconds: Number.isFinite(i) && (i === 0 || i >= 30) ? Math.floor(i) : 300,
  };
}

/**
 * Build the Node {@link RunGateway}. Direct HTTP when a provider transport +
 * env key resolve; otherwise the CLI subprocess. Selection / override / model-
 * class resolution reuse the pure helpers in config/providers.ts.
 */
export function buildNodeGateway(opts: { cwd?: string; signal?: AbortSignal } = {}): RunGateway {
  const cwd = opts.cwd;
  return {
    resolveDirectRoute: (selection) => {
      const direct = resolveDirectRoute(selection, cwd);
      return direct ? { adapter: direct.adapter, model: direct.model } : null;
    },
    resolveCliRoute: async (selection) => {
      const cli = resolveCliRoute(selection, cwd);
      return {
        adapter: cli.adapter,
        model: cli.model,
        // Spawn-time which-cli resolution; bare binary name is fine here.
        cliCommand: whichCli(cli.adapter),
        env: cli.env,
      };
    },
    completeText: async ({ selection, model, omitModel, prompt, onDelta }) => {
      const direct = resolveDirectRoute(selection, cwd);
      if (!direct) throw new Error('NO_MODEL_GATEWAY_BACKEND');
      const useModel = omitModel ? undefined : model ?? direct.model;
      const text = await runDirect(direct, prompt, useModel, onDelta, opts.signal);
      return { text, adapter: direct.adapter };
    },
    spawnCliAgent: (prompt, adapter, spawnOpts) =>
      spawnCliAgent(prompt, {
        adapter,
        model: spawnOpts.model,
        cliCommand: spawnOpts.cliCommand,
        cwd: spawnOpts.cwd ?? cwd,
        permission: spawnOpts.permission,
        env: spawnOpts.env,
        timeoutSeconds: spawnOpts.timeoutSeconds,
        idleTimeoutSeconds: spawnOpts.idleTimeoutSeconds,
        onProgress: spawnOpts.onProgress,
        sessionId: spawnOpts.sessionId,
        resume: spawnOpts.resume,
        signal: opts.signal,
      }),
    applyOverride: (selection, override) => applyGatewayOverride(selection, override),
    nodeGatewayOverride: (nodeOrParams) => readNodeGatewayOverride(nodeOrParams),
    modelClassFromModelId: (m) => modelClassFromModelId(m),
    recordCall: () => {
      /* CLI telemetry is a no-op (speed tiers are not persisted headlessly). */
    },
    timeoutPolicy: () => nodeTimeoutPolicy(),
    effectiveConcurrency: (configured) => Math.max(1, configured),
    effectiveConsensusSamples: (configured) => Math.min(7, Math.max(2, configured)),
  };
}

/** Run a direct-HTTP completion over the resolved route. */
async function runDirect(
  route: ResolvedRoute,
  prompt: string,
  model: string | undefined,
  onDelta: ((chunk: string) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<string> {
  const apiKey = route.apiKey?.trim();
  if (!apiKey) throw new Error('NO_API_KEY');
  if (route.transport === 'anthropic') {
    return streamAnthropic({
      apiKey,
      baseUrl: route.baseUrl,
      model,
      system: '',
      userContent: prompt,
      maxTokens: 8192,
      signal,
      onDelta,
    });
  }
  // openai-compatible
  if (!model) throw new Error('NO_MODEL');
  return completeOpenAICompatible({
    apiKey,
    baseUrl: route.baseUrl,
    model,
    prompt,
    maxTokens: 8192,
    signal,
    onDelta,
  });
}

/** Pure reader for a node/params gateway override (mirror of resolver.ts#nodeGatewayOverride). */
function readNodeGatewayOverride(
  nodeOrParams: { params?: Record<string, unknown> } | Record<string, unknown>,
): { modelClass?: string; providerId?: string; channelId?: string } | undefined {
  const rawParams =
    'params' in nodeOrParams && nodeOrParams.params
      ? (nodeOrParams.params as Record<string, unknown>)
      : (nodeOrParams as Record<string, unknown>);
  const rawGateway = rawParams.gateway;
  const gateway =
    typeof rawGateway === 'object' && rawGateway !== null
      ? (rawGateway as Record<string, unknown>)
      : {};
  const override: { modelClass?: string; providerId?: string; channelId?: string } = {};
  if (typeof gateway.modelClass === 'string') override.modelClass = gateway.modelClass;
  if (typeof gateway.providerId === 'string') override.providerId = gateway.providerId || undefined;
  if (typeof gateway.channelId === 'string') override.channelId = gateway.channelId || undefined;
  if (!override.modelClass && typeof rawParams.model === 'string') {
    override.modelClass = modelClassFromModelId(rawParams.model);
  }
  return Object.values(override).some(Boolean) ? override : undefined;
}

let streamSeq = 0;

/** Build the Node {@link RunCallbacks} that fan side effects out as {@link RunEvent}s. */
function buildNodeCallbacks(
  signal: AbortSignal | undefined,
  onEvent: ((event: RunEvent) => void) | undefined,
  promptInteraction: (req: InteractionRequest) => Promise<InteractionAnswer | null>,
): RunCallbacks {
  const emit = (event: RunEvent) => onEvent?.(event);
  return {
    onNodeStart: (node: IRNode) =>
      emit({ kind: 'node_start', nodeId: node.id, nodeType: node.type, label: node.label }),
    onNodeSuccess: (node, output) =>
      emit({ kind: 'node_success', nodeId: node.id, output }),
    onNodeFailure: (node, failure, state) =>
      emit({ kind: 'node_failure', nodeId: node.id, failure, state }),
    onNodeRetry: (node, failure, attempt, maxRetries, backoffMs) =>
      emit({ kind: 'node_retry', nodeId: node.id, failure, attempt, maxRetries, backoffMs }),
    onLog: (text, role) => emit({ kind: 'log', text, role: role ?? 'system' }),
    beginStream: (header: string): RunStreamHandle => {
      const streamId = (streamSeq += 1);
      emit({ kind: 'stream_begin', header, streamId });
      return {
        append: (chunk) => emit({ kind: 'stream_append', streamId, chunk }),
        finalize: (text) => emit({ kind: 'stream_finalize', streamId, text }),
        fail: (text) => emit({ kind: 'stream_fail', streamId, text }),
      };
    },
    isCancelled: () => signal?.aborted ?? false,
    promptInteraction,
  };
}

/**
 * Execute an {@link IRGraph} headlessly. Resolves the run's gateway selection
 * (flags > config > env), assembles the Node ports, and runs `executeWorkflowDag`.
 */
export async function runBlueprint(ir: IRGraph, opts: RunOptions = {}): Promise<RunResult> {
  const cwd = opts.cwd ?? process.cwd();
  loadFucConfig(cwd);

  const selection =
    opts.selection ??
    resolveSelection({
      adapter: opts.adapter,
      model: opts.model,
      providerId: opts.providerId,
      cwd,
    });

  const gateway = opts.gateway ?? buildNodeGateway({ cwd, signal: opts.signal });
  const promptInteraction =
    opts.promptInteraction ??
    createTerminalInteraction({ nonInteractive: opts.nonInteractive });
  const callbacks = buildNodeCallbacks(opts.signal, opts.onEvent, promptInteraction);

  const context: RunContext = {
    selection,
    cwd,
    permission: opts.permission ?? 'full',
    concurrency: clampPositive(opts.concurrency, 3),
    maxRetries: clampNonNeg(opts.maxRetries, 2),
    consensusSamples: clampPositive(opts.consensusSamples, 3),
    runtimeVoteSamplesMin: opts.runtimeVoteSamplesMin,
    runtimeVoteSamplesMax: opts.runtimeVoteSamplesMax,
    terminalVoteSamplesMin: opts.terminalVoteSamplesMin,
    terminalVoteSamplesMax: opts.terminalVoteSamplesMax,
    complexityScaling: opts.complexityScaling,
    escalationBudget: opts.escalationBudget,
    adaptiveEscalation: opts.adaptiveEscalation,
    gateway,
  };

  const execOptions: ExecuteWorkflowOptions = {
    resumeFromNodeId: opts.resumeFromNodeId ?? null,
    seedOutputs: opts.seedOutputs,
    seedRunState: opts.seedRunState,
  };

  return executeWorkflowDag(ir, callbacks, context, execOptions);
}

function clampPositive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback;
}

function clampNonNeg(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

export { cliRouteEnv };
