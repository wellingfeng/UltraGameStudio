/**
 * CONTRACT: structured tool-call events carried inline in the message stream.
 *
 * The CLI runtime can no longer convey tool status/duration/args/result through
 * a flat `🔧 name: detail` text line. Instead it emits inline sentinel blocks:
 *
 *   <<UGS_TOOL>>{ ...json ToolEventPatch... }<<UGS_TOOL_END>>
 *
 * woven into the normal text stream (the same approach as the `<<UGS_ASK>>`
 * interaction sentinel). Each block is a *patch* keyed by `id`: a `running`
 * patch when the call starts, then a `done`/`error` patch (with `durationMs`
 * and `result`) when it finishes. The renderer's segmenter accumulates patches
 * by id into a single {@link ToolEvent} so a tool card updates in place.
 *
 * This module is pure (parse/serialise + merge) so it is shared by the runtime
 * emitter, the render-layer segmenter, and tests.
 */

export type ToolStatus = 'running' | 'done' | 'error';

/** Native task bookkeeping has its own composer disclosure. */
export function isChatTaskTool(name: string): boolean {
  const normalized = name.split(/[:./]/).at(-1)!.replace(/[_-]/g, '').toLowerCase();
  return ['updateplan', 'todowrite', 'todolist', 'todo', 'plan', 'taskcreate', 'taskupdate', 'tasklist'].includes(normalized);
}

export interface ToolEvent {
  /** Stable id correlating the start patch with its completion patch. */
  id: string;
  /** Tool name, e.g. 'Bash' / 'read_file' / 'command_execution'. */
  name: string;
  /** One-line human subject (command / path / pattern). */
  subject?: string;
  /** Raw arguments object (pretty-printed in the expanded card). */
  args?: unknown;
  /** Compact native file changes, captured before large arguments are clipped. */
  fileChanges?: import('@/lib/turnFileChanges').TurnFileChange[];
  status: ToolStatus;
  /** Native success verdict is distinct from UI lifecycle completion. */
  evidenceStatus?: 'success' | 'error' | 'unknown';
  /** Result/output body once the call finishes. */
  result?: string;
  /** Wall-clock duration in milliseconds. */
  durationMs?: number;
  /** True when the result body was clipped by the runtime. */
  truncated?: boolean;
  /** Parent tool id for nested sub-agent (task) calls. */
  parentId?: string;
  /** Origin of this patch; UI finalization is never native evidence. */
  provenance?: import('@/runtime/skills/types').SkillEvidenceProvenance;
  /** Native exit status only when explicitly present in the source event. */
  exitCode?: number | null;
  /** Transient runtime status; render live but do not persist into final answers. */
  ephemeral?: boolean;
}

/** A partial update to a {@link ToolEvent}; `id` is required, rest optional. */
export type ToolEventPatch = Partial<ToolEvent> & { id: string };

export const TOOL_OPEN = '<<UGS_TOOL>>';
export const TOOL_CLOSE = '<<UGS_TOOL_END>>';

/**
 * Escape `<`/`>` in a serialised JSON payload as `<` / `>`. JSON.parse
 * decodes these back to the literal characters, so the payload round-trips
 * byte-for-byte — but a tool result that itself contains the literal sentinel
 * markers (e.g. reading this very file) can no longer produce a `<<UGS_TOOL_END>>`
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

export interface ExtractToolSentinelsOptions {
  /**
   * While the live bubble is streaming, a trailing sentinel can be *half*
   * arrived — `<<UGS_TOOL>>{…` with no `<<UGS_TOOL_END>>` yet (common when a
   * tool's args carry a large `new_string`/`content` body that spans many
   * stdout chunks). With this flag the incomplete tail is rendered as an
   * in-progress tool card (best-effort name + subject from the fields that have
   * arrived) instead of leaking the raw JSON fragment as prose.
   */
  streamingTail?: boolean;
}

/** Stable id for the placeholder card when the streamed sentinel has no id yet. */
const STREAMING_TOOL_ID = 'streaming-tool-tail';

/**
 * Decode one fully-closed `"key":"value"` pair from a (possibly truncated) JSON
 * fragment. The currently-streaming field is unterminated, so it simply won't
 * match — we only read fields that already finished arriving. Matches the first
 * occurrence, which for our payloads is the real key (real keys precede any
 * mention inside a long value body).
 */
function extractStringField(fragment: string, key: string): string | undefined {
  const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
  const m = re.exec(fragment);
  if (!m) return undefined;
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return m[1];
  }
}

/** Best-effort tool name from the arg keys that have streamed so far. */
function inferToolName(fragment: string): string {
  if (/"command"\s*:/.test(fragment)) return 'Bash';
  if (/"new_string"\s*:/.test(fragment) || /"old_string"\s*:/.test(fragment)) return 'Edit';
  if (/"content"\s*:/.test(fragment) && /"file_path"\s*:/.test(fragment)) return 'Write';
  if (/"pattern"\s*:/.test(fragment)) return 'Grep';
  if (/"file_path"\s*:/.test(fragment) || /"path"\s*:/.test(fragment)) return 'Read';
  return 'tool';
}

/** Pick a one-line subject (command/path/pattern) from the streamed fields. */
function pickStreamingSubject(fragment: string): string | undefined {
  const raw =
    extractStringField(fragment, 'subject') ??
    extractStringField(fragment, 'command') ??
    extractStringField(fragment, 'pattern') ??
    extractStringField(fragment, 'file_path') ??
    extractStringField(fragment, 'path') ??
    extractStringField(fragment, 'query') ??
    extractStringField(fragment, 'url') ??
    extractStringField(fragment, 'description');
  if (!raw) return undefined;
  return raw.replace(/[\r\n]+/g, ' ').trim().slice(0, 200) || undefined;
}

/**
 * Cut a streamed JSON fragment right after the opening quote of the first "big
 * body" value (`new_string` / `old_string` / `content` / `result`). That value
 * is the one still arriving, so it is unterminated and its (escaped) contents
 * must not be scanned for fields — a `"name": …` inside a file body is not the
 * tool's name. The body *key* is kept (so name inference still sees it), but the
 * value is dropped. Everything before it (id, name, subject, file_path, …) has
 * finished arriving.
 */
function safeFieldPrefix(fragment: string): string {
  let cut = fragment.length;
  for (const key of ['new_string', 'old_string', 'content', 'result']) {
    const re = new RegExp(`"${key}"\\s*:\\s*"`);
    const m = re.exec(fragment);
    if (m) {
      const end = m.index + m[0].length;
      if (end < cut) cut = end;
    }
  }
  return fragment.slice(0, cut);
}

/**
 * Turn a half-streamed sentinel body (`{…` with no closing brace yet) into an
 * in-progress patch. Returns null when the fragment doesn't look like our JSON
 * payload (so a literal `<<UGS_TOOL>>` the model typed in prose is left alone).
 */
function parsePartialToolPatch(fragment: string): ToolEventPatch | null {
  if (!/^\s*\{/.test(fragment)) return null;
  const safe = safeFieldPrefix(fragment);
  const id = extractStringField(safe, 'id') ?? STREAMING_TOOL_ID;
  const name = extractStringField(safe, 'name') ?? inferToolName(safe);
  const subject = pickStreamingSubject(safe);
  const patch: ToolEventPatch = { id, name, status: 'running' };
  if (subject) patch.subject = subject;
  return patch;
}

/**
 * Pull every `<<UGS_TOOL>>…<<UGS_TOOL_END>>` block out of `text`, returning the
 * cleaned text, the decoded patches, and an ordered parts list that preserves
 * each sentinel's position relative to the surrounding prose. Malformed or
 * incomplete blocks (e.g. a half-streamed sentinel with no close yet) are left
 * in place so they resolve on the next chunk rather than leaking as garbage.
 */
export function extractToolSentinels(
  text: string,
  options: ExtractToolSentinelsOptions = {},
): ToolSentinelSplit {
  if (!text.includes(TOOL_OPEN)) {
    return { text, patches: [], parts: text ? [{ text }] : [] };
  }

  const { streamingTail = false } = options;
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
      // Incomplete trailing sentinel — `<<UGS_TOOL>>{…` with no close yet.
      const fragment = text.slice(open + TOOL_OPEN.length);
      const partial = streamingTail ? parsePartialToolPatch(fragment) : null;
      if (partial) {
        // Render the still-arriving call as an in-progress card instead of
        // leaking the raw JSON fragment as prose. Emit the prose before the
        // marker, then a fresh `running` patch; the unfinished body is dropped
        // from the text projection (it isn't real prose).
        const before = text.slice(cursor, open);
        out += before;
        pendingText += before;
        flushText();
        patches.push(partial);
        parts.push({ patch: partial });
      } else {
        // Not streaming, or the fragment is a literal marker the model typed in
        // prose — keep everything from `open` verbatim so it can complete on the
        // next chunk (or survive as the literal text it is).
        const tail = text.slice(cursor);
        out += tail;
        pendingText += tail;
      }
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
      // The `<<UGS_TOOL>>` marker is literal prose: the model wrote the token
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

/**
 * Append a synthetic terminal patch for every tool sentinel in `text` whose
 * merged status is still `running`. A turn can legitimately reach its final
 * answer while a tool call it started never got a matching `done`/`error`
 * patch (model moved on without waiting, CLI process exited mid-stream,
 * round budget ran out, etc.). Without this, the persisted message freezes
 * that tool card in a permanent spinner even though the turn is long over —
 * indistinguishable in the UI from "still actually running".
 */
export function closeDanglingToolPatches(text: string): string {
  if (!hasToolSentinel(text)) return text;
  const dangling = mergeToolPatches(extractToolSentinels(text).patches).filter(
    (event) => event.status === 'running',
  );
  if (dangling.length === 0) return text;
  const closers = dangling.map((event) =>
    encodeToolPatch({
      id: event.id,
      status: 'error',
      provenance: 'ui-synthetic',
      result: '本轮已结束，未收到该工具调用的完成事件（可能被中断或超时）。',
    }),
  );
  return `${text}${closers.join('')}`;
}

/**
 * Finalize tool sentinels in a message text before persisting to session history.
 *
 * When a session is cancelled mid-stream, the in-progress assistant message may
 * contain an unclosed `<<UGS_TOOL>>{…` sentinel (no `<<UGS_TOOL_END>>` yet).
 * `extractToolSentinels` without `streamingTail` skips incomplete sentinels,
 * so `extractSessionFiles` cannot recover the file paths the tool touched —
 * the files vanish from the session-files list after reload even though the
 * edits are on disk.
 *
 * This function:
 * 1. Finds the last unclosed `<<UGS_TOOL>>` (if any).
 * 2. Parses the partial JSON fragment (best-effort: extracts id, name, subject,
 *    file path from whatever fields have arrived).
 * 3. Replaces the incomplete sentinel with a properly closed one.
 * 4. Calls {@link closeDanglingToolPatches} to append terminal patches for any
 *    tool calls still in `running` status.
 *
 * For text with no tool sentinels or only complete ones, this is a no-op
 * (after `closeDanglingToolPatches`).
 */
export function finalizeToolSentinelsForPersistence(text: string): string {
  if (!hasToolSentinel(text)) return text;

  // Find the last unclosed TOOL_OPEN.
  const lastOpen = text.lastIndexOf(TOOL_OPEN);
  if (lastOpen === -1) return closeDanglingToolPatches(text);

  const closeAfter = text.indexOf(TOOL_CLOSE, lastOpen + TOOL_OPEN.length);
  if (closeAfter !== -1) {
    // All sentinels are properly closed — just close dangling patches.
    return closeDanglingToolPatches(text);
  }

  // The sentinel starting at lastOpen is unclosed. Parse the partial fragment.
  const fragment = text.slice(lastOpen + TOOL_OPEN.length);
  const partial = parsePartialToolPatch(fragment);

  if (!partial) {
    // Can't parse — append a close marker so it's at least syntactically
    // complete, then close dangling patches.
    return closeDanglingToolPatches(text + TOOL_CLOSE);
  }

  // Replace the incomplete sentinel with a properly closed one, then close
  // any dangling running patches (including this one).
  const before = text.slice(0, lastOpen);
  return closeDanglingToolPatches(before + encodeToolPatch(partial));
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(obj) as Array<keyof T>) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}
