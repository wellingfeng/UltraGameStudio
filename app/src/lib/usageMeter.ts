import type { GatewaySelection } from '@/core/ir';
import { estimateTokenCount } from '@/lib/contextUsage';
import type { ResolvedGatewayRoute } from '@/lib/modelGateway/types';

export interface ModelUsageReport {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export interface UsageMeterCall {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  cachePercent: number;
  estimated: boolean;
  providerLabel: string;
  modelLabel: string;
  updatedAt: number;
}

export interface UsageMeterSnapshot {
  version: 1;
  totals: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cachedInputTokens: number;
    /**
     * Input / cached tokens accumulated from *real* (server-reported) calls
     * only. The session cache-hit percentage is computed from these so that
     * estimated turns (cached = 0) don't dilute the ratio. See
     * {@link sessionCachePercent}.
     */
    realInputTokens: number;
    realCachedInputTokens: number;
  };
  lastCall: UsageMeterCall;
}

/**
 * Per-turn token usage stamped onto an assistant message. Computed as the delta
 * of the session snapshot across a single chat turn (a turn may issue several
 * model sub-calls), so it survives reloads alongside the message itself.
 */
export interface UsageTurnDelta {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cachePercent: number;
  estimated: boolean;
}

export interface UsageMeterContext {
  workspaceId?: string | null;
  sessionId?: string | null;
}

type UsageRoute = Partial<
  Pick<
    ResolvedGatewayRoute,
    | 'selection'
    | 'baseUrl'
    | 'model'
    | 'providerName'
    | 'channelName'
    | 'label'
  >
> & {
  selection?: GatewaySelection;
};

const LEGACY_USAGE_STORAGE_KEY = 'fuc_usage_meter_v1';
const USAGE_STORAGE_KEY = 'fuc_usage_meter_by_session_v1';
const USAGE_GLOBAL_CONTEXT_KEY = '__global__';
const USAGE_DEFAULT_WORKSPACE_KEY = '__default_workspace__';
const USAGE_CHANGE_EVENT = 'fuc:usage-meter-changed';

const ZERO_CALL: UsageMeterCall = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cachedInputTokens: 0,
  cacheCreationInputTokens: 0,
  cachePercent: 0,
  estimated: true,
  providerLabel: '',
  modelLabel: '',
  updatedAt: 0,
};

const EMPTY_SNAPSHOT: UsageMeterSnapshot = {
  version: 1,
  totals: {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    realInputTokens: 0,
    realCachedInputTokens: 0,
  },
  lastCall: ZERO_CALL,
};

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function emitChange(eventName: string): void {
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event(eventName));
    }
  } catch {
    /* ignore */
  }
}

function numberFrom(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

function cleanUsage(report: ModelUsageReport): Required<ModelUsageReport> {
  const inputTokens = Math.round(report.inputTokens ?? 0);
  const outputTokens = Math.round(report.outputTokens ?? 0);
  const totalTokens = Math.round(report.totalTokens ?? inputTokens + outputTokens);
  return {
    inputTokens: Math.max(0, inputTokens),
    outputTokens: Math.max(0, outputTokens),
    totalTokens: Math.max(0, totalTokens),
    cacheReadInputTokens: Math.max(0, Math.round(report.cacheReadInputTokens ?? 0)),
    cacheCreationInputTokens: Math.max(
      0,
      Math.round(report.cacheCreationInputTokens ?? 0),
    ),
  };
}

function parseSnapshot(value: unknown): UsageMeterSnapshot {
  if (typeof value !== 'object' || value === null) return EMPTY_SNAPSHOT;
  const raw = value as Partial<UsageMeterSnapshot>;
  const totals = raw.totals ?? EMPTY_SNAPSHOT.totals;
  const last = raw.lastCall ?? ZERO_CALL;
  return {
    version: 1,
    totals: {
      calls: numberFrom(totals.calls) ?? 0,
      inputTokens: numberFrom(totals.inputTokens) ?? 0,
      outputTokens: numberFrom(totals.outputTokens) ?? 0,
      totalTokens: numberFrom(totals.totalTokens) ?? 0,
      cachedInputTokens: numberFrom(totals.cachedInputTokens) ?? 0,
      // Legacy snapshots predate the real-only fields; default them to 0 so the
      // session cache % simply stays `--` until the next real call lands.
      realInputTokens: numberFrom(totals.realInputTokens) ?? 0,
      realCachedInputTokens: numberFrom(totals.realCachedInputTokens) ?? 0,
    },
    lastCall: {
      inputTokens: numberFrom(last.inputTokens) ?? 0,
      outputTokens: numberFrom(last.outputTokens) ?? 0,
      totalTokens: numberFrom(last.totalTokens) ?? 0,
      cachedInputTokens: numberFrom(last.cachedInputTokens) ?? 0,
      cacheCreationInputTokens: numberFrom(last.cacheCreationInputTokens) ?? 0,
      cachePercent: numberFrom(last.cachePercent) ?? 0,
      estimated: last.estimated !== false,
      providerLabel: typeof last.providerLabel === 'string' ? last.providerLabel : '',
      modelLabel: typeof last.modelLabel === 'string' ? last.modelLabel : '',
      updatedAt: numberFrom(last.updatedAt) ?? 0,
    },
  };
}

function usageContextKey(context?: UsageMeterContext): string {
  const sessionId = context?.sessionId?.trim();
  if (!sessionId) return USAGE_GLOBAL_CONTEXT_KEY;
  const workspaceId =
    context?.workspaceId?.trim() || USAGE_DEFAULT_WORKSPACE_KEY;
  return `${workspaceId}:${sessionId}`;
}

function readUsageSnapshotMap(): Record<string, UsageMeterSnapshot> {
  const raw = storage()?.getItem(USAGE_STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [
        key,
        parseSnapshot(value),
      ]),
    );
  } catch {
    return {};
  }
}

function readLegacyUsageSnapshot(): UsageMeterSnapshot | null {
  const raw = storage()?.getItem(LEGACY_USAGE_STORAGE_KEY);
  if (!raw) return null;
  try {
    return parseSnapshot(JSON.parse(raw));
  } catch {
    return null;
  }
}

function snapshotHasUsage(snapshot: UsageMeterSnapshot | undefined): boolean {
  if (!snapshot) return false;
  return snapshot.totals.calls > 0 || snapshot.totals.totalTokens > 0;
}

function usageContextFallbackKey(
  context: UsageMeterContext | undefined,
): string | null {
  const sessionId = context?.sessionId?.trim();
  const workspaceId = context?.workspaceId?.trim();
  if (!sessionId || !workspaceId) return null;
  return `${USAGE_DEFAULT_WORKSPACE_KEY}:${sessionId}`;
}

function saveUsageSnapshot(
  snapshot: UsageMeterSnapshot,
  context?: UsageMeterContext,
): void {
  const store = storage();
  if (!store) return;
  try {
    const map = readUsageSnapshotMap();
    map[usageContextKey(context)] = snapshot;
    store.setItem(USAGE_STORAGE_KEY, JSON.stringify(map));
    emitChange(USAGE_CHANGE_EVENT);
  } catch {
    /* ignore quota/private mode */
  }
}

export function readUsageMeterSnapshot(
  context?: UsageMeterContext,
): UsageMeterSnapshot {
  const key = usageContextKey(context);
  const map = readUsageSnapshotMap();
  const snapshot = map[key];
  const fallbackKey = usageContextFallbackKey(context);
  const fallback = fallbackKey ? map[fallbackKey] : undefined;
  if (snapshotHasUsage(snapshot) || !snapshotHasUsage(fallback)) {
    if (snapshot) return snapshot;
  }
  if (fallback) return fallback;
  if (key === USAGE_GLOBAL_CONTEXT_KEY) {
    return readLegacyUsageSnapshot() ?? EMPTY_SNAPSHOT;
  }
  return EMPTY_SNAPSHOT;
}

export function subscribeUsageMeter(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const onStorage = (event: StorageEvent) => {
    if (
      event.key === USAGE_STORAGE_KEY ||
      event.key === LEGACY_USAGE_STORAGE_KEY
    ) {
      listener();
    }
  };
  window.addEventListener(USAGE_CHANGE_EVENT, listener);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(USAGE_CHANGE_EVENT, listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function mergeUsageReports(
  current: ModelUsageReport | null | undefined,
  next: ModelUsageReport | null | undefined,
): ModelUsageReport | null {
  if (!next) return current ?? null;
  if (!current) return next;
  return {
    inputTokens: next.inputTokens ?? current.inputTokens,
    outputTokens: next.outputTokens ?? current.outputTokens,
    totalTokens: next.totalTokens ?? current.totalTokens,
    cacheReadInputTokens:
      next.cacheReadInputTokens ?? current.cacheReadInputTokens,
    cacheCreationInputTokens:
      next.cacheCreationInputTokens ?? current.cacheCreationInputTokens,
  };
}

export function usageReportFromOpenAI(value: unknown): ModelUsageReport | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const promptDetails =
    typeof raw.prompt_tokens_details === 'object' &&
    raw.prompt_tokens_details !== null
      ? (raw.prompt_tokens_details as Record<string, unknown>)
      : {};
  const inputDetails =
    typeof raw.input_tokens_details === 'object' &&
    raw.input_tokens_details !== null
      ? (raw.input_tokens_details as Record<string, unknown>)
      : {};
  const report: ModelUsageReport = {
    inputTokens: numberFrom(raw.prompt_tokens) ?? numberFrom(raw.input_tokens),
    outputTokens:
      numberFrom(raw.completion_tokens) ?? numberFrom(raw.output_tokens),
    totalTokens: numberFrom(raw.total_tokens),
    cacheReadInputTokens:
      numberFrom(promptDetails.cached_tokens) ??
      numberFrom(inputDetails.cached_tokens) ??
      numberFrom(promptDetails.cache_read_input_tokens) ??
      numberFrom(raw.cache_read_input_tokens),
    cacheCreationInputTokens: numberFrom(raw.cache_creation_input_tokens),
  };
  return Object.values(report).some((item) => item !== undefined) ? report : null;
}

export function usageReportFromCodex(value: unknown): ModelUsageReport | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const inputTokens =
    numberFrom(raw.input_tokens) ?? numberFrom(raw.inputTokens);
  const outputTokens =
    numberFrom(raw.output_tokens) ?? numberFrom(raw.outputTokens);
  const report: ModelUsageReport = {
    inputTokens,
    outputTokens,
    totalTokens:
      numberFrom(raw.total_tokens) ??
      numberFrom(raw.totalTokens) ??
      (inputTokens !== undefined || outputTokens !== undefined
        ? (inputTokens ?? 0) + (outputTokens ?? 0)
        : undefined),
    cacheReadInputTokens:
      numberFrom(raw.cached_input_tokens) ??
      numberFrom(raw.cachedInputTokens) ??
      numberFrom(raw.cache_read_input_tokens),
    cacheCreationInputTokens:
      numberFrom(raw.cache_creation_input_tokens) ??
      numberFrom(raw.cacheCreationInputTokens),
  };
  return Object.values(report).some((item) => item !== undefined) ? report : null;
}

/**
 * Normalize the raw usage payload streamed back by a CLI adapter (claude / codex
 * / gemini) into a {@link ModelUsageReport}. The shape differs per provider:
 *
 * - Codex / OpenAI-style: `input_tokens` already *includes* the cached portion
 *   (`cached_input_tokens` is a subset), so the cached/total ratio is correct as-is.
 * - Anthropic-style: `input_tokens` counts only the *uncached* prefix, with cache
 *   hits/writes reported separately (`cache_read_input_tokens` /
 *   `cache_creation_input_tokens`). We fold those back into a single total so the
 *   meter's cached÷total math stays correct.
 *
 * Returns null when the payload carries no recognizable token counts.
 */
export function usageReportFromCliUsage(value: unknown): ModelUsageReport | null {
  if (typeof value !== 'object' || value === null) return null;
  const container = value as Record<string, unknown>;
  const nestedUsage =
    typeof container.usage === 'object' && container.usage !== null
      ? (container.usage as Record<string, unknown>)
      : typeof container.token_usage === 'object' &&
          container.token_usage !== null
        ? (container.token_usage as Record<string, unknown>)
        : typeof container.total_token_usage === 'object' &&
            container.total_token_usage !== null
          ? (container.total_token_usage as Record<string, unknown>)
          : null;
  const raw = nestedUsage ?? container;
  const promptDetails =
    typeof raw.prompt_tokens_details === 'object' &&
    raw.prompt_tokens_details !== null
      ? (raw.prompt_tokens_details as Record<string, unknown>)
      : {};
  const inputDetails =
    typeof raw.input_tokens_details === 'object' &&
    raw.input_tokens_details !== null
      ? (raw.input_tokens_details as Record<string, unknown>)
      : {};
  const anthropicStyle =
    raw.cache_read_input_tokens !== undefined ||
    raw.cache_creation_input_tokens !== undefined ||
    raw.cache_read_tokens !== undefined ||
    raw.cache_creation_tokens !== undefined;
  const cacheRead =
    numberFrom(raw.cache_read_input_tokens) ??
    numberFrom(raw.cached_input_tokens) ??
    numberFrom(raw.cachedInputTokens) ??
    numberFrom(promptDetails.cached_tokens) ??
    numberFrom(inputDetails.cached_tokens) ??
    numberFrom(raw.cache_read_tokens) ??
    numberFrom(raw.cached_tokens);
  const cacheCreation =
    numberFrom(raw.cache_creation_input_tokens) ??
    numberFrom(raw.cacheCreationInputTokens) ??
    numberFrom(raw.cache_creation_tokens);
  const rawInput =
    numberFrom(raw.input_tokens) ??
    numberFrom(raw.inputTokens) ??
    numberFrom(raw.prompt_tokens) ??
    numberFrom(raw.promptTokens);
  const outputTokens =
    numberFrom(raw.output_tokens) ??
    numberFrom(raw.outputTokens) ??
    numberFrom(raw.completion_tokens) ??
    numberFrom(raw.completionTokens);
  // Anthropic keeps the cached prefix out of `input_tokens`; sum it back in so
  // the gauge reflects cache-of-total. Codex/OpenAI already report the full
  // input, so leave it untouched.
  const inputTokens = anthropicStyle
    ? (rawInput ?? 0) + (cacheRead ?? 0) + (cacheCreation ?? 0)
    : rawInput;
  const computedTotal =
    inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined;
  const reportedTotal =
    numberFrom(raw.total_tokens) ?? numberFrom(raw.totalTokens);
  const report: ModelUsageReport = {
    inputTokens,
    outputTokens,
    totalTokens:
      anthropicStyle && computedTotal !== undefined
        ? Math.max(computedTotal, reportedTotal ?? 0)
        : (reportedTotal ?? computedTotal),
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreation,
  };
  return Object.values(report).some((item) => item !== undefined) ? report : null;
}

export function usageReportFromAnthropic(value: unknown): ModelUsageReport | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const report: ModelUsageReport = {
    inputTokens: numberFrom(raw.input_tokens),
    outputTokens: numberFrom(raw.output_tokens),
    cacheReadInputTokens:
      numberFrom(raw.cache_read_input_tokens) ?? numberFrom(raw.cache_read_tokens),
    cacheCreationInputTokens:
      numberFrom(raw.cache_creation_input_tokens) ??
      numberFrom(raw.cache_creation_tokens),
  };
  const input = report.inputTokens ?? 0;
  const output = report.outputTokens ?? 0;
  if (input || output) report.totalTokens = input + output;
  return Object.values(report).some((item) => item !== undefined) ? report : null;
}

export function estimateUsageForText(
  inputText: string,
  outputText: string,
): ModelUsageReport {
  const inputTokens = estimateTokenCount(inputText);
  const outputTokens = estimateTokenCount(outputText);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

export function estimateGatewayUsage(
  system: string,
  userContent: string,
  outputText: string,
): ModelUsageReport {
  const input = [system, userContent].filter((part) => part.trim()).join('\n\n');
  return estimateUsageForText(input, outputText);
}

function providerLabel(route: UsageRoute): string {
  return route.providerName || route.channelName || route.selection?.adapter || '';
}

function modelLabel(route: UsageRoute): string {
  return route.model || route.selection?.modelOverride || route.selection?.modelClass || '';
}

export function recordModelUsageForRoute(
  route: UsageRoute,
  report: ModelUsageReport,
  options: { estimated?: boolean; context?: UsageMeterContext } = {},
): UsageMeterSnapshot {
  const usage = cleanUsage(report);
  const cachedInputTokens = Math.min(
    usage.inputTokens,
    usage.cacheReadInputTokens + usage.cacheCreationInputTokens,
  );
  const updatedAt = Date.now();
  const call: UsageMeterCall = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    cachedInputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    cachePercent:
      usage.inputTokens > 0 ? (cachedInputTokens / usage.inputTokens) * 100 : 0,
    estimated: options.estimated === true,
    providerLabel: providerLabel(route),
    modelLabel: modelLabel(route),
    updatedAt,
  };
  const current = readUsageMeterSnapshot(options.context);
  const isReal = call.estimated === false;
  const next: UsageMeterSnapshot = {
    version: 1,
    totals: {
      calls: current.totals.calls + 1,
      inputTokens: current.totals.inputTokens + call.inputTokens,
      outputTokens: current.totals.outputTokens + call.outputTokens,
      totalTokens: current.totals.totalTokens + call.totalTokens,
      cachedInputTokens: current.totals.cachedInputTokens + call.cachedInputTokens,
      realInputTokens:
        current.totals.realInputTokens + (isReal ? call.inputTokens : 0),
      realCachedInputTokens:
        current.totals.realCachedInputTokens +
        (isReal ? call.cachedInputTokens : 0),
    },
    lastCall: call,
  };
  saveUsageSnapshot(next, options.context);
  return next;
}

export function recordEstimatedModelUsageForSelection(
  selection: GatewaySelection,
  prompt: string,
  outputText: string,
  route: Omit<UsageRoute, 'selection'> = {},
  options: { context?: UsageMeterContext } = {},
): UsageMeterSnapshot {
  return recordModelUsageForRoute(
    { ...route, selection },
    estimateUsageForText(prompt, outputText),
    { estimated: true, context: options.context },
  );
}

/**
 * Rebuild a session snapshot from the per-turn usage deltas stamped onto each
 * assistant message. The live meter only accumulates while real-time calls land
 * in *this* client's localStorage, so opening a historical session (different
 * device, cleared storage, or pre-meter session) leaves the status bar at 0 /
 * `--`. Each persisted message still carries its turn's usage, so we can fold
 * those back into an equivalent snapshot for display.
 *
 * Note: a turn delta sums every sub-call of that turn and only exposes a single
 * `estimated` flag (true when no real input landed). For a mixed turn we credit
 * the whole turn's input as "real" so the cache ratio stays close to reality;
 * mixed turns are rare in practice.
 */
export function rebuildSnapshotFromTurns(
  turns: ReadonlyArray<UsageTurnDelta | null | undefined>,
): UsageMeterSnapshot {
  let lastReal: UsageMeterCall | null = null;
  const totals = { ...EMPTY_SNAPSHOT.totals };
  for (const turn of turns) {
    if (!turn) continue;
    const inputTokens = numberFrom(turn.inputTokens) ?? 0;
    const outputTokens = numberFrom(turn.outputTokens) ?? 0;
    const totalTokens =
      numberFrom(turn.totalTokens) ?? inputTokens + outputTokens;
    const cachedInputTokens = Math.min(
      inputTokens,
      numberFrom(turn.cachedInputTokens) ?? 0,
    );
    if (totalTokens <= 0 && inputTokens <= 0 && outputTokens <= 0) continue;
    const isReal = turn.estimated === false;
    totals.calls += 1;
    totals.inputTokens += inputTokens;
    totals.outputTokens += outputTokens;
    totals.totalTokens += totalTokens;
    totals.cachedInputTokens += cachedInputTokens;
    totals.realInputTokens += isReal ? inputTokens : 0;
    totals.realCachedInputTokens += isReal ? cachedInputTokens : 0;
    if (isReal) {
      lastReal = {
        inputTokens,
        outputTokens,
        totalTokens,
        cachedInputTokens,
        cacheCreationInputTokens: 0,
        cachePercent: numberFrom(turn.cachePercent) ?? 0,
        estimated: false,
        providerLabel: '',
        modelLabel: '',
        updatedAt: 0,
      };
    }
  }
  return {
    version: 1,
    totals,
    lastCall: lastReal ?? ZERO_CALL,
  };
}

/**
 * Pick whichever snapshot carries more accumulated usage. Used so a historical
 * session that has live local usage keeps it, while one that has none falls back
 * to the rebuilt-from-messages snapshot.
 */
export function preferRicherSnapshot(
  live: UsageMeterSnapshot,
  rebuilt: UsageMeterSnapshot,
): UsageMeterSnapshot {
  if (live.totals.totalTokens >= rebuilt.totals.totalTokens) return live;
  return rebuilt;
}

/**
 * Session-wide cache-hit percentage, computed from *real* (server-reported)
 * calls only. Returns null when no real usage has been recorded yet, so callers
 * can render a `--` placeholder instead of a misleading 0%.
 */
export function sessionCachePercent(
  snapshot: UsageMeterSnapshot,
): number | null {
  const input = snapshot.totals.realInputTokens;
  if (input <= 0) return null;
  const cached = Math.min(input, snapshot.totals.realCachedInputTokens);
  return (cached / input) * 100;
}

/**
 * Per-turn token usage as the delta between the session snapshot before and
 * after a chat turn. A turn may issue several model sub-calls (research lenses,
 * candidate generation, the final answer); summing the delta captures the whole
 * turn. `estimated` is true when no real (server-reported) input landed during
 * the turn, in which case the cache percentage is meaningless and reported as 0.
 */
export function usageTurnFromSnapshots(
  before: UsageMeterSnapshot,
  after: UsageMeterSnapshot,
): UsageTurnDelta {
  const inputTokens = Math.max(
    0,
    after.totals.inputTokens - before.totals.inputTokens,
  );
  const outputTokens = Math.max(
    0,
    after.totals.outputTokens - before.totals.outputTokens,
  );
  const totalTokens = Math.max(
    0,
    after.totals.totalTokens - before.totals.totalTokens,
  );
  const cachedInputTokens = Math.max(
    0,
    after.totals.cachedInputTokens - before.totals.cachedInputTokens,
  );
  const realInput = Math.max(
    0,
    after.totals.realInputTokens - before.totals.realInputTokens,
  );
  const realCached = Math.max(
    0,
    after.totals.realCachedInputTokens - before.totals.realCachedInputTokens,
  );
  const estimated = realInput <= 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens,
    cachePercent: estimated
      ? 0
      : (Math.min(realInput, realCached) / realInput) * 100,
    estimated,
  };
}
