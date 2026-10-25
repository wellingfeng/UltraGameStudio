import { extractToolSentinels } from '@/components/ai/lib/toolEvent';
import type { RuntimeAdapterId } from '@/lib/adapters';
import type { Message } from '@/store/types';
import { estimateTokenCount } from '@/runtime/tokenEstimate';
export { estimateTokenCount } from '@/runtime/tokenEstimate';

export const SIMPLE_CHAT_CONTEXT_MESSAGE_LIMIT = 20;
export const SIMPLE_CHAT_CONTEXT_INITIAL_MESSAGE_LIMIT = 5;

const DEFAULT_CONTEXT_LIMIT_TOKENS = 200_000;
const GEMINI_CONTEXT_LIMIT_TOKENS = 1_000_000;
const LOCAL_CONTEXT_LIMIT_TOKENS = 32_000;

export type ContextUsageTone = 'ok' | 'warn' | 'danger';

export interface ContextUsageEstimate {
  usedTokens: number;
  limitTokens: number;
  percent: number;
  displayPercent: string;
  tone: ContextUsageTone;
}

function stripRouteLine(text: string): string {
  return text
    .replace(/^⏱ [^\n]*(?:\n|$)/, '')
    .replace(/^⚙ (?:(?:路由|模型)：)[^\n]*(?:\n|$)/, '')
    .trim();
}

function contextMessageText(message: Message): string {
  const raw =
    message.role === 'assistant' && message.text.includes('<<UGS_TOOL>>')
      ? extractToolSentinels(message.text).text
      : message.text;
  return stripRouteLine(raw);
}

function explicitContextLimitFromModel(model: string): number | null {
  const normalized = model.toLowerCase();
  const million = normalized.match(/(?:^|[^0-9])(\d+(?:\.\d+)?)\s*m(?:[^a-z]|$)/);
  if (million) return Math.round(Number(million[1]) * 1_000_000);

  const thousand = normalized.match(/(?:^|[^0-9])(\d+(?:\.\d+)?)\s*k(?:[^a-z]|$)/);
  if (thousand) return Math.round(Number(thousand[1]) * 1_000);

  return null;
}

function contextMessagesForEstimate(
  messages: Message[],
  simpleChatMode: boolean,
  simpleChatMessageLimit = SIMPLE_CHAT_CONTEXT_MESSAGE_LIMIT,
): Array<{ message: Message; text: string }> {
  if (!simpleChatMode) {
    return messages.flatMap((message) => {
      if (message.role === 'system') return [];
      const text = contextMessageText(message);
      return text ? [{ message, text }] : [];
    });
  }

  const out: Array<{ message: Message; text: string }> = [];
  for (
    let i = messages.length - 1;
    i >= 0 && out.length < simpleChatMessageLimit;
    i -= 1
  ) {
    const message = messages[i];
    if (message.role === 'system') continue;
    const text = contextMessageText(message);
    if (text) out.push({ message, text });
  }
  out.reverse();
  return out;
}

export function contextLimitForModel(
  adapter: RuntimeAdapterId,
  model: string | undefined | null,
): number {
  const normalized = (model ?? '').trim().toLowerCase();
  const explicit = normalized ? explicitContextLimitFromModel(normalized) : null;
  if (explicit && Number.isFinite(explicit) && explicit > 0) return explicit;

  if (normalized.includes('gemini') || adapter === 'gemini') {
    return GEMINI_CONTEXT_LIMIT_TOKENS;
  }
  if (
    normalized.includes('ollama') ||
    normalized.includes('lmstudio') ||
    normalized.includes('llamacpp')
  ) {
    return LOCAL_CONTEXT_LIMIT_TOKENS;
  }
  return DEFAULT_CONTEXT_LIMIT_TOKENS;
}

function formatPercent(percent: number): string {
  if (percent <= 0) return '0%';
  if (percent < 1) return '<1%';
  if (percent > 100) return '100%+';
  return `${Math.round(percent)}%`;
}

function toneForPercent(percent: number): ContextUsageTone {
  if (percent > 80) return 'danger';
  if (percent >= 60) return 'warn';
  return 'ok';
}

export function estimateContextUsage({
  messages,
  draft,
  adapter,
  model,
  simpleChatMode,
  simpleChatMessageLimit,
}: {
  messages: Message[];
  draft: string;
  adapter: RuntimeAdapterId;
  model?: string | null;
  simpleChatMode: boolean;
  simpleChatMessageLimit?: number;
}): ContextUsageEstimate {
  const contextMessages = contextMessagesForEstimate(
    messages,
    simpleChatMode,
    simpleChatMessageLimit,
  );
  const transcript = contextMessages
    .map(({ message, text }) => {
      const role = message.role === 'user' ? 'User' : 'Assistant';
      return `${role}: ${text}`;
    })
    .join('\n\n');
  const nextInput = draft.trim() ? `User: ${draft.trim()}` : '';
  const contextText = [transcript, nextInput].filter(Boolean).join('\n\n');
  const systemAndFramingTokens = contextText ? 700 : 0;
  const turnOverheadTokens = contextMessages.length * 4 + (nextInput ? 4 : 0);
  const usedTokens =
    estimateTokenCount(contextText) + systemAndFramingTokens + turnOverheadTokens;
  const limitTokens = contextLimitForModel(adapter, model);
  const percent = limitTokens > 0 ? (usedTokens / limitTokens) * 100 : 0;

  return {
    usedTokens,
    limitTokens,
    percent,
    displayPercent: formatPercent(percent),
    tone: toneForPercent(percent),
  };
}

export function formatCompactTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    const value = tokens / 1_000_000;
    return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    const value = tokens / 1_000;
    return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}k`;
  }
  return String(tokens);
}
