/**
 * CONTRACT: segmentMessage(text) -> Segment[]
 *
 * Splits one assistant message's plain text into ordered segments so the
 * renderer can show collapsible reasoning blocks and structured tool cards
 * separately from the answer prose.
 *
 * Many models (DeepSeek-R1 raw, local/CLI models, some proxies) inline their
 * chain-of-thought as `<think>…</think>` / `<thinking>…</thinking>` right in the
 * text stream. We pull those spans out into `reasoning` segments and leave the
 * rest as `answer` segments, preserving stream order so think → answer → think →
 * answer interleaving renders correctly.
 *
 * This remains a pure whole-string segmenter, with bounded revision caching
 * and reuse of already closed tool projections. Streaming tails still use the
 * original decoder: an *unclosed* trailing `<think>` is treated as reasoning
 * that is still in progress (`done: false`), and a
 * trailing partial tag (e.g. `…</thin`) is held back rather than leaked into the
 * answer text.
 */

export type Segment =
  | { type: 'reasoning'; text: string; done: boolean }
  | { type: 'answer'; text: string }
  | { type: 'tools'; events: ToolEvent[] };

import {
  mergeToolPatches,
  hasToolSentinel,
  type ToolEvent,
  type ToolEventPatch,
} from './toolEvent';
import {
  hasLegacyXmlTool,
  legacyXmlToolsToSentinels,
} from './legacyXmlTool';
import { parseToolLine } from './toolLine';
import { compactRuntimeHeartbeatLines } from '@/core/interaction';
import { createBoundedTextCache } from './boundedTextCache';
import { cachedToolProjection as extractToolSentinels } from './cachedToolProjection';

const OPEN = /<think(?:ing)?>/i;
const CLOSE = /<\/think(?:ing)?>/i;

const PARTIAL_TAG_CANDIDATES = [
  '<think>',
  '<thinking>',
  '</think>',
  '</thinking>',
];

/**
 * If the tail of `s` could be the prefix of a think tag (split across a chunk
 * boundary), return the index where the partial tag starts; else -1.
 */
function partialTagStart(s: string): number {
  const lt = s.lastIndexOf('<');
  if (lt === -1) return -1;
  const tail = s.slice(lt).toLowerCase();
  // A complete tag is handled elsewhere; only hold back a strict prefix.
  if (PARTIAL_TAG_CANDIDATES.some((t) => t !== tail && t.startsWith(tail))) {
    return lt;
  }
  return -1;
}

/** Does the text contain any think tag at all? Fast path for plain answers. */
export function hasReasoning(text: string): boolean {
  return OPEN.test(text);
}

/**
 * Segment a full message into ordered reasoning/answer chunks. `streaming`
 * controls whether a dangling open `<think>` (no close yet) is reported as
 * in-progress reasoning (true) or simply closed off (false, final render).
 */
const segmentCache = createBoundedTextCache<Segment[]>(128, 1_000_000);

export function segmentMessage(text: string, streaming = false): Segment[] {
  return segmentCache.get(`${streaming ? '1' : '0'}${text}`, () => parseMessage(text, streaming),
    (segments) => segments.reduce((size, segment) => size +
      (segment.type === 'tools' ? JSON.stringify(segment.events).length : segment.text.length), 0));
}

function parseMessage(text: string, streaming: boolean): Segment[] {
  const displayText = compactRuntimeHeartbeatLines(text);
  if (!hasReasoning(displayText)) {
    return expandTools(displayText ? [{ type: 'answer', text: displayText }] : [], streaming);
  }

  const segments: Segment[] = [];
  let rest = displayText;
  let mode: 'answer' | 'reasoning' = 'answer';

  const pushAnswer = (chunk: string) => {
    if (!chunk) return;
    const last = segments[segments.length - 1];
    if (last && last.type === 'answer') last.text += chunk;
    else segments.push({ type: 'answer', text: chunk });
  };
  const pushReasoning = (chunk: string, done: boolean) => {
    const last = segments[segments.length - 1];
    if (last && last.type === 'reasoning') {
      last.text += chunk;
      last.done = done;
    } else {
      segments.push({ type: 'reasoning', text: chunk, done });
    }
  };

  for (;;) {
    const re = mode === 'answer' ? OPEN : CLOSE;
    const m = re.exec(rest);

    if (!m) {
      // No more complete tags. Emit remainder, holding back a partial tag tail
      // only while streaming (a final render has no more chunks coming).
      let chunk = rest;
      if (streaming) {
        const p = partialTagStart(rest);
        if (p !== -1) chunk = rest.slice(0, p);
      }
      if (mode === 'answer') pushAnswer(chunk);
      else pushReasoning(chunk, !streaming); // unclosed think: done iff not streaming
      break;
    }

    const before = rest.slice(0, m.index);
    if (mode === 'answer') {
      pushAnswer(before);
      mode = 'reasoning';
      // Seed an empty reasoning segment so an immediately-closing tag still
      // produces a (possibly empty) block in order.
      pushReasoning('', false);
    } else {
      pushReasoning(before, true);
      mode = 'answer';
    }
    rest = rest.slice(m.index + m[0].length);
    // Tolerate a stray, unmatched close tag from sloppy/nested output so we
    // never leak a literal `</think>` into the rendered answer.
    if (mode === 'answer') rest = rest.replace(/^<\/think(?:ing)?>/i, '');
  }

  // Drop empty answer segments (produced by adjacent tags), and drop reasoning
  // blocks that ended up empty once finalized — but keep an empty reasoning
  // block while it is still streaming so the "思考中…" header can show.
  const cleaned = segments.filter((s) => {
    if (s.type === 'reasoning') return s.text.length > 0 || !s.done;
    if (s.type === 'answer') return s.text.length > 0;
    return true;
  });
  return expandTools(cleaned, streaming);
}

/**
 * Second pass: split each answer segment on inline tool sentinels
 * (`<<UGS_TOOL>>…`), turning them into ordered answer/tools segments. Adjacent
 * tool events across the whole message are merged by id so a `running` event
 * and its later `done` patch collapse into one card. The merge is global (not
 * per answer-segment) so a tool that starts before a reasoning block and
 * finishes after it still resolves to a single event.
 */
function expandTools(segments: Segment[], streaming: boolean): Segment[] {
  const anySentinels = segments.some(
    (s) => s.type === 'answer' && hasToolSentinel(s.text),
  );
  const anyLegacyXmlTools = segments.some(
    (s) => s.type === 'answer' && hasLegacyXmlTool(s.text),
  );
  const anyLegacyToolLines = segments.some(
    (s) => s.type === 'answer' && hasLegacyToolMarker(s.text),
  );
  if (!anySentinels && !anyLegacyXmlTools && !anyLegacyToolLines) return segments;

  // Decode every patch first (in stream order) so we can merge globally by id.
  // Only the final answer segment can carry a half-streamed trailing sentinel,
  // so we pass `streamingTail` just for that segment while live.
  const lastAnswerIndex = (() => {
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      if (segments[i].type === 'answer') return i;
    }
    return -1;
  })();
  const allPatches: ToolEventPatch[] = [];
  const projections: Array<{ text: string; split: ReturnType<typeof extractToolSentinels> | null } | null> = [];
  for (let i = 0; i < segments.length; i += 1) {
    const s = segments[i];
    if (s.type === 'answer') {
      const streamingTail = streaming && i === lastAnswerIndex;
      const toolText = legacyXmlToolsToSentinels(s.text, { streamingTail });
      const split = hasToolSentinel(toolText) ? extractToolSentinels(toolText, { streamingTail }) : null;
      projections.push({ text: toolText, split });
      if (split) allPatches.push(...split.patches);
    } else projections.push(null);
  }
  const merged = mergeToolPatches(allPatches);
  const byId = new Map(merged.map((e) => [e.id, e]));
  const trailingEphemeralId = streaming
    ? findTrailingEphemeralToolId(segments, byId)
    : null;
  const patchCounts = new Map<string, number>();
  for (const patch of allPatches) {
    patchCounts.set(patch.id, (patchCounts.get(patch.id) ?? 0) + 1);
  }

  const out: Segment[] = [];
  const emitted = new Set<string>();
  const seenPatchCounts = new Map<string, number>();
  let legacyId = 0;
  const pushAnswerText = (text: string) => {
    const trimmed = text.replace(/^\n+|\n+$/g, '');
    if (trimmed.length === 0) return;
    out.push({ type: 'answer', text: trimmed });
  };
  const pushToolEvent = (event: ToolEvent) => {
    const last = out[out.length - 1];
    if (last && last.type === 'tools') last.events.push(event);
    else out.push({ type: 'tools', events: [event] });
  };
  const pushTool = (patch: ToolEventPatch) => {
    // Global dedup: a tool's `running` and later `done` patch resolve to one
    // card, placed at the FIRST (running) position — even when prose or a
    // reasoning block streams between the two patches.
    const id = patch.id;
    const seenCount = (seenPatchCounts.get(id) ?? 0) + 1;
    seenPatchCounts.set(id, seenCount);
    if (emitted.has(id)) return;
    const event = byId.get(id);
    if (!event) return;
    // Older Codex histories incorrectly encoded the user's prompt as a tool.
    if ((event.name === 'userMessage' || event.name === 'user_message') &&
        typeof event.args === 'object' && event.args !== null &&
        (event.args as { type?: string }).type === event.name) return;
    if (event.ephemeral) {
      // Runtime heartbeats are transient. Show only the latest heartbeat when
      // it is the current tail of the live stream; once real output appears
      // after it, the old "still running" card disappears.
      if (id !== trailingEphemeralId) return;
      if (seenCount !== (patchCounts.get(id) ?? 0)) return;
    }
    emitted.add(id);
    pushToolEvent(event);
  };
  const pushTextWithLegacyTools = (text: string) => {
    for (const part of splitLegacyTools(text)) {
      if ('text' in part) pushAnswerText(part.text);
      else {
        pushToolEvent({
          id: `legacy-${legacyId++}`,
          name: part.tool.name,
          subject: part.tool.detail,
          status: 'done',
        });
      }
    }
  };

  for (let i = 0; i < segments.length; i += 1) {
    const s = segments[i];
    if (s.type !== 'answer') {
      out.push(s);
      continue;
    }
    const projection = projections[i]!;
    if (!projection.split) {
      pushTextWithLegacyTools(projection.text);
      continue;
    }
    // Walk the ordered parts so tool cards land exactly between prose runs.
    for (const part of projection.split.parts) {
      if ('text' in part) pushTextWithLegacyTools(part.text);
      else pushTool(part.patch);
    }
  }

  return out;
}

function findTrailingEphemeralToolId(
  segments: Segment[],
  byId: Map<string, ToolEvent>,
): string | null {
  for (let segmentIndex = segments.length - 1; segmentIndex >= 0; segmentIndex -= 1) {
    const segment = segments[segmentIndex];
    if (segment.type === 'reasoning') {
      if (segment.text.trim().length > 0) return null;
      continue;
    }
    if (segment.type === 'tools') return null;
    const parts = hasToolSentinel(segment.text)
      ? extractToolSentinels(segment.text).parts
      : [{ text: segment.text }];
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex];
      if ('text' in part) {
        if (part.text.trim().length > 0) return null;
        continue;
      }
      const event = byId.get(part.patch.id);
      return event?.ephemeral ? part.patch.id : null;
    }
  }
  return null;
}

const LEGACY_TOOL_MARKER = /🔧\s*([A-Za-z][A-Za-z0-9_.-]{0,80})\s*:\s*/gu;

function hasLegacyToolMarker(text: string): boolean {
  LEGACY_TOOL_MARKER.lastIndex = 0;
  for (let m = LEGACY_TOOL_MARKER.exec(text); m; m = LEGACY_TOOL_MARKER.exec(text)) {
    if (parseToolLine(`🔧 ${m[1].trim()}: detail`)) return true;
  }
  return false;
}

function splitLegacyTools(
  text: string,
): Array<{ text: string } | { tool: { name: string; detail: string } }> {
  const matches: Array<{
    emojiStart: number;
    detailStart: number;
    name: string;
  }> = [];

  LEGACY_TOOL_MARKER.lastIndex = 0;
  for (let m = LEGACY_TOOL_MARKER.exec(text); m; m = LEGACY_TOOL_MARKER.exec(text)) {
    const name = m[1].trim();
    if (!parseToolLine(`🔧 ${name}: detail`)) continue;
    matches.push({
      emojiStart: m.index,
      detailStart: m.index + m[0].length,
      name,
    });
  }

  if (matches.length === 0) return text ? [{ text }] : [];

  const out: Array<{ text: string } | { tool: { name: string; detail: string } }> = [];
  let cursor = 0;
  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    const next = matches[i + 1];
    const detailEnd = next ? next.emojiStart : legacyDetailEnd(text, current.detailStart);
    const before = text.slice(cursor, current.emojiStart);
    if (before) out.push({ text: before });
    out.push({
      tool: {
        name: current.name,
        detail: text.slice(current.detailStart, detailEnd).trim(),
      },
    });
    cursor = detailEnd;
  }
  const tail = text.slice(cursor);
  if (tail) out.push({ text: tail });
  return out;
}

function legacyDetailEnd(text: string, detailStart: number): number {
  const newline = text.indexOf('\n', detailStart);
  if (newline !== -1) return newline;
  return text.length;
}

