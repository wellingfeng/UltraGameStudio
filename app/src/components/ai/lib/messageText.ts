import { segmentMessage } from './segmenter';
import { hasToolSentinel } from './toolEvent';
import { cachedToolProjection } from './cachedToolProjection';
import { createBoundedTextCache } from './boundedTextCache';
import { formatClock, formatDuration } from '@/runtime/format';

const ROUTE_LINE_RE =
  /^⚙ (?:(?:路由：(?<route>.*?)(?: · 模型：(?<model>.*))?)|(?:模型：(?<modelOnly>.*)))$/m;

/** Leading `⏱ HH:MM:SS → HH:MM:SS · 耗时 …` line prepended to assistant turns. */
const TIMING_LINE_RE = /^⏱[^\n]*(?:\n|$)/;
const cleanTextCache = createBoundedTextCache<string>(128, 1_000_000);

export function routeLabelFromText(text: string): string {
  const match = text.match(ROUTE_LINE_RE);
  const groups = match?.groups;
  if (!groups) return '';
  const route = groups.route?.trim() ?? '';
  const model = (groups.model ?? groups.modelOnly ?? '').trim();
  return [route, model].filter(Boolean).join(' · ');
}

export function stripRouteLine(text: string): string {
  return text.replace(ROUTE_LINE_RE, '').replace(/\n{3,}/g, '\n\n').trimStart();
}

/**
 * Strip inline tool sentinels (`<<UGS_TOOL>>...`) from a message's text so
 * search indexes and plain fallbacks never show raw protocol JSON.
 */
export function cleanMessageText(text: string): string {
  return cleanTextCache.get(text, () => {
    const visible = hasToolSentinel(text) ? cachedToolProjection(text).text : text;
    return stripRouteLine(visible.replace(TIMING_LINE_RE, ''));
  }, (value) => value.length);
}

export function renderMessageText(text: string): string {
  return stripRouteLine(text.replace(TIMING_LINE_RE, ''));
}

/**
 * Extract the leading `⏱ …` timing line verbatim (if any) so the UI can hoist
 * it out of the message bubble and pin it to the bottom of the stream.
 */
export function timingLineFromText(text: string): string {
  const match = text.match(/^⏱[^\n]*/);
  return match ? match[0] : '';
}

/**
 * Resolve a turn's `⏱ HH:MM:SS → HH:MM:SS · 耗时 …` label for a message.
 *
 * The leading text line is authoritative (it is what the turn actually wrote),
 * but not every assistant bubble carries one: follow-up bubbles appended to the
 * same turn, and turns whose text was rewritten while streaming, lose the
 * prefix. Fall back to the structured `createdAt` / `completedAt` pair so every
 * completed assistant turn still shows its own clock instead of only the last
 * one. Returns '' when the message cannot produce a real timing.
 */
export function turnTimingFromMessage(message: {
  text: string;
  createdAt?: number;
  completedAt?: number;
}): string {
  const fromText = timingLineFromText(message.text);
  if (fromText) return fromText;
  const { createdAt, completedAt } = message;
  if (
    typeof createdAt !== 'number' ||
    !Number.isFinite(createdAt) ||
    typeof completedAt !== 'number' ||
    !Number.isFinite(completedAt) ||
    completedAt <= createdAt
  ) {
    return '';
  }
  return `⏱ ${formatClock(createdAt)} → ${formatClock(completedAt)} · 耗时 ${formatDuration(
    completedAt - createdAt,
  )}`;
}

/**
 * Text payload for per-answer actions. Keeps answer prose only: no route/timing
 * chrome, reasoning, legacy tool lines, or structured tool cards.
 */
export function answerActionText(text: string): string {
  const visible = stripRouteLine(text).replace(/^⏱[^\n]*\n/u, '');
  return segmentMessage(visible, false)
    .filter((segment) => segment.type === 'answer')
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
}
