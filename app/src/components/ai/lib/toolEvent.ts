/**
 * CONTRACT: structured tool-call events carried inline in the message stream.
 *
 * The CLI runtime can no longer convey tool status/duration/args/result through
 * a flat `🔧 name: detail` text line. Instead it emits inline sentinel blocks:
 *
 *   <<FUC_TOOL>>{ ...json ToolEventPatch... }<<FUC_TOOL_END>>
 *
 * woven into the normal text stream (the same approach as the `<<FUC_ASK>>`
 * interaction sentinel). Each block is a *patch* keyed by `id`: a `running`
 * patch when the call starts, then a `done`/`error` patch (with `durationMs`
 * and `result`) when it finishes. The renderer's segmenter accumulates patches
 * by id into a single {@link ToolEvent} so a tool card updates in place.
 *
 * This module is pure (parse/serialise + merge) so it is shared by the runtime
 * emitter, the render-layer segmenter, and tests.
 */

export type ToolStatus = 'running' | 'done' | 'error';

export interface ToolEvent {
  /** Stable id correlating the start patch with its completion patch. */
  id: string;
  /** Tool name, e.g. 'Bash' / 'read_file' / 'command_execution'. */
  name: string;
  /** One-line human subject (command / path / pattern). */
  subject?: string;
  /** Raw arguments object (pretty-printed in the expanded card). */
  args?: unknown;
  status: ToolStatus;
  /** Result/output body once the call finishes. */
  result?: string;
  /** Wall-clock duration in milliseconds. */
  durationMs?: number;
  /** True when the result body was clipped by the runtime. */
  truncated?: boolean;
  /** Parent tool id for nested sub-agent (task) calls. */
  parentId?: string;
}

/** A partial update to a {@link ToolEvent}; `id` is required, rest optional. */
export type ToolEventPatch = Partial<ToolEvent> & { id: string };

export const TOOL_OPEN = '<<FUC_TOOL>>';
export const TOOL_CLOSE = '<<FUC_TOOL_END>>';

/**
 * Escape `<`/`>` in a serialised JSON payload as `<` / `>`. JSON.parse
 * decodes these back to the literal characters, so the payload round-trips
 * byte-for-byte — but a tool result that itself contains the literal sentinel
 * markers (e.g. reading this very file) can no longer produce a `<<FUC_TOOL_END>>`
 * substring that would prematurely close the block and leak the rest as prose.
 */
function escapeSentinelPayload(json: string): string {
  return json.replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

/** Serialise a patch into an inline sentinel block for the text stream. */
export function encodeToolPatch(patch: ToolEventPatch): string {
  return `\n${TOOL_OPEN}${escapeSentinelPayload(JSON.stringify(patch))}${TOOL_CLOSE}\n`;
}

/** True when the text contains at least one tool sentinel (fast pre-check). */
export function hasToolSentinel(text: string): boolean {
  return text.includes(TOOL_OPEN);
}

export interface ToolSentinelSplit {
  /** The text with all tool sentinel blocks removed (in original order). */
  text: string;
  /** Patches decoded from the sentinels, in stream order. */
  patches: ToolEventPatch[];
  /**
   * Ordered parts: plain-text runs interleaved with decoded patches, preserving
   * the original position so the renderer can place tool cards exactly where
   * they occurred between prose.
   */
  parts: Array<{ text: string } | { patch: ToolEventPatch }>;
}

/**
 * Pull every `<<FUC_TOOL>>…<<FUC_TOOL_END>>` block out of `text`, returning the
 * cleaned text, the decoded patches, and an ordered parts list that preserves
 * each sentinel's position relative to the surrounding prose. Malformed or
 * incomplete blocks (e.g. a half-streamed sentinel with no close yet) are left
 * in place so they resolve on the next chunk rather than leaking as garbage.
 */
export function extractToolSentinels(text: string): ToolSentinelSplit {
  if (!text.includes(TOOL_OPEN)) {
    return { text, patches: [], parts: text ? [{ text }] : [] };
  }

  const patches: ToolEventPatch[] = [];
  const parts: Array<{ text: string } | { patch: ToolEventPatch }> = [];
  let out = '';
  let cursor = 0;
  let pendingText = '';

  const flushText = () => {
    if (pendingText) {
      parts.push({ text: pendingText });
      pendingText = '';
    }
  };

  for (;;) {
    const open = text.indexOf(TOOL_OPEN, cursor);
    if (open === -1) {
      const tail = text.slice(cursor);
      out += tail;
      pendingText += tail;
      break;
    }
    const close = text.indexOf(TOOL_CLOSE, open + TOOL_OPEN.length);
    if (close === -1) {
      // Incomplete trailing sentinel — keep everything from `open` verbatim so
      // it can complete on the next streamed chunk.
      const tail = text.slice(cursor);
      out += tail;
      pendingText += tail;
      break;
    }
    const before = text.slice(cursor, open);
    out += before;
    pendingText += before;
    const json = text.slice(open + TOOL_OPEN.length, close);
    let parsed: ToolEventPatch | null = null;
    try {
      const candidate = JSON.parse(json) as ToolEventPatch;
      if (candidate && typeof candidate.id === 'string') parsed = candidate;
    } catch {
      /* not a real sentinel payload — fall through to literal handling */
    }
    if (parsed) {
      flushText();
      patches.push(parsed);
      parts.push({ patch: parsed });
      cursor = close + TOOL_CLOSE.length;
    } else {
      // The `<<FUC_TOOL>>` marker is literal prose: the model wrote the token
      // itself (e.g. while explaining this protocol), so its body isn't a valid
      // patch — and its `close` actually paired with a genuine sentinel further
      // downstream. Keep the marker verbatim and resume scanning right after it
      // so real sentinels (and everything between) still parse instead of being
      // swallowed and dropped as one giant unparseable block.
      out += TOOL_OPEN;
      pendingText += TOOL_OPEN;
      cursor = open + TOOL_OPEN.length;
    }
  }
  flushText();

  // Collapse the blank lines the encoder added around each sentinel.
  out = out.replace(/\n{3,}/g, '\n\n');
  return { text: out, patches, parts };
}

/**
 * Merge an ordered list of patches into deduplicated {@link ToolEvent}s, keyed
 * by id, preserving first-seen order. A later patch shallow-overrides earlier
 * fields (so a `done` patch updates status/result/duration of its `running`
 * event). Status is monotonic — a terminal `done`/`error` never reverts to
 * `running` even if patches arrive out of order — and `name` falls back across
 * patches so a completion-only patch keeps the name from its start patch.
 */
export function mergeToolPatches(patches: ToolEventPatch[]): ToolEvent[] {
  const byId = new Map<string, ToolEvent>();
  const order: string[] = [];
  const rank: Record<ToolStatus, number> = { running: 0, done: 1, error: 1 };
  for (const p of patches) {
    const existing = byId.get(p.id);
    if (existing) {
      const patch = stripUndefined(p);
      // Never demote a terminal status back to running.
      if (patch.status && rank[patch.status] < rank[existing.status]) {
        delete patch.status;
      }
      Object.assign(existing, patch);
    } else {
      order.push(p.id);
      byId.set(p.id, {
        id: p.id,
        name: p.name ?? 'tool',
        status: p.status ?? 'running',
        ...stripUndefined(p),
      });
    }
  }
  return order.map((id) => byId.get(id)!);
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(obj) as Array<keyof T>) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}
