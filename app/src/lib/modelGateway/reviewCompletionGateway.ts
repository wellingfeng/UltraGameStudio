import { createSkillReviewModelPort } from './skillReviewGateway';
import type { GatewaySelection } from './types';
import { redactSkillText } from '@/runtime/skills/evidence';

export interface ReviewCompletionOptions {
  signal?: AbortSignal;
  maxCalls?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export interface ReviewCompletionUsage {
  calls: number;
  inputTokens: number;
  outputTokens?: number;
  estimated: boolean;
}

export interface ReviewCompletionInvoker {
  (system: string, userContent: string): Promise<string>;
  readonly usage: ReviewCompletionUsage;
}

/** Text-only auxiliary channel. A failed reviewer never inherits foreground tools. */
export function createReviewCompletionInvoker(
  selection: GatewaySelection,
  options: ReviewCompletionOptions = {},
): ReviewCompletionInvoker {
  for (const key of ['maxCalls', 'maxInputTokens', 'maxOutputTokens', 'timeoutMs'] as const) {
    const value = options[key];
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new Error('REVIEW_INVALID_BUDGET: 复盘预算必须为有限正数');
  }
  const model = createSkillReviewModelPort({ ...selection });
  const signal = options.signal ?? new AbortController().signal;
  const maxCalls = Math.max(1, Math.min(6, Math.floor(options.maxCalls ?? 6)));
  const maxInputTokens = Math.max(1, Math.min(24000, Math.floor(options.maxInputTokens ?? 24000)));
  const maxOutputTokens = Math.max(1, Math.min(4000, Math.floor(options.maxOutputTokens ?? 4000)));
  const deadline = performance.now() + Math.max(1, Math.min(120000, options.timeoutMs ?? 120000));
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let unknownOutput = false;
  let estimated = false;
  const invoke = async (system: string, userContent: string) => {
    if (signal.aborted) throw new DOMException('Review cancelled', 'AbortError');
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) throw new DOMException('REVIEW_TIME_BUDGET: 复盘时间已达上限', 'TimeoutError');
    if (calls >= maxCalls) throw new Error('REVIEW_CALL_BUDGET: 复盘调用次数已达上限');
    system = redactSkillText(system, 8000);
    userContent = redactSkillText(userContent, 48000);
    // Admission is an estimate, not a promise about provider billing.
    const inputEstimate = Math.ceil((system.length + userContent.length) / 3);
    if (inputTokens + inputEstimate > maxInputTokens) throw new Error('REVIEW_INPUT_BUDGET: 复盘输入预算已达上限');
    if (outputTokens >= maxOutputTokens) throw new Error('REVIEW_OUTPUT_BUDGET: 复盘输出预算已达上限');
    calls++;
    inputTokens += inputEstimate;
    let onAbort!: () => void;
    let timer!: ReturnType<typeof setTimeout>;
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(new DOMException('Review cancelled', 'AbortError'));
      signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => reject(new DOMException('REVIEW_TIME_BUDGET: 复盘时间已达上限', 'TimeoutError')), remainingMs);
    });
    try {
      const response = await Promise.race([cancelled, model.complete({
        system, userContent, signal,
        maxOutputTokens: maxOutputTokens - outputTokens,
        timeoutMs: remainingMs,
      })]);
      if (signal.aborted) throw new DOMException('Review cancelled', 'AbortError');
      inputTokens += Math.max(0, (response.usage?.inputTokens ?? inputEstimate) - inputEstimate);
      outputTokens += response.usage?.outputTokens ?? Math.ceil(response.text.length / 3);
      estimated ||= response.usage?.estimated === true || response.usage?.inputTokens === undefined || response.usage?.outputTokens === undefined;
      return response.text;
    } catch (error) {
      unknownOutput = true;
      estimated = true;
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  };
  return Object.defineProperty(invoke, 'usage', { get: () => ({
    calls, inputTokens, outputTokens: unknownOutput ? undefined : outputTokens, estimated,
  }) }) as ReviewCompletionInvoker;
}
