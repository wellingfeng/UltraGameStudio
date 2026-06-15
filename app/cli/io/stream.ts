/**
 * Streaming stdout/stderr helpers + tool-use summarisation for the Node CLI.
 *
 * A faithful port of the relevant pieces of `src-tauri/src/lib.rs`:
 *   - `summarize_tool_use`          -> {@link summarizeToolUse}
 *   - `codex_progress_line`         -> {@link codexProgressLine}
 *   - `codex_completed_item`        -> {@link codexCompletedItem}
 *   - `codex_turn_completion_status`-> {@link codexTurnCompletionStatus}
 *   - `codex_turn_usage`            -> {@link codexTurnUsage}
 *   - `codex_status_success`        -> {@link codexStatusSuccess}
 *
 * Pure (no spawn): consumed by `cli/io/cli-spawn.ts` while it walks the JSONL
 * stream, and re-usable by tests.
 */

/**
 * Summarise a Claude `tool_use` block into one readable progress line, e.g.
 * `🔧 Bash: ls app/src` / `🔧 Read: app/src/core/ir.ts`. Mirrors
 * `summarize_tool_use` in lib.rs exactly (same key precedence + 200-char clamp).
 */
export function summarizeToolUse(name: string, input: unknown): string {
  const keys = [
    'command',
    'pattern',
    'file_path',
    'path',
    'query',
    'url',
    'description',
    'prompt',
    'old_string',
    'title',
  ];
  let detail = '';
  const obj =
    typeof input === 'object' && input !== null
      ? (input as Record<string, unknown>)
      : null;
  if (obj) {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'string') {
        const s = v.trim();
        if (s) {
          detail = s;
          break;
        }
      }
    }
  }
  if (!detail) {
    if (input == null) {
      detail = '';
    } else {
      try {
        const s = JSON.stringify(input);
        detail = s === 'null' ? '' : s;
      } catch {
        detail = '';
      }
    }
  }
  detail = detail.replace(/[\r\n]/g, ' ').slice(0, 200);
  return detail ? `🔧 ${name}: ${detail}` : `🔧 ${name}`;
}

/** Extract a one-line subject (command/path/pattern) from a tool input object. */
export function toolSubject(input: unknown): string {
  const keys = ['command', 'pattern', 'file_path', 'path', 'query', 'url', 'description'];
  const obj =
    typeof input === 'object' && input !== null
      ? (input as Record<string, unknown>)
      : null;
  if (obj) {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'string' && v.trim()) {
        return v.trim().replace(/[\r\n]/g, ' ').slice(0, 200);
      }
    }
  }
  return '';
}

// Inline tool-event sentinel protocol (mirrors src/components/ai/lib/toolEvent.ts).
const TOOL_OPEN = '<<FUC_TOOL>>';
const TOOL_CLOSE = '<<FUC_TOOL_END>>';

/** Serialise a tool-event patch into an inline sentinel block for the stream. */
export function encodeToolPatch(patch: Record<string, unknown>): string {
  // Escape `<`/`>` in the payload (JSON.parse restores them) so a tool result
  // that itself contains the literal sentinel markers can't produce a stray
  // `<<FUC_TOOL_END>>` that would prematurely close the block.
  const payload = JSON.stringify(patch).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return `\n${TOOL_OPEN}${payload}${TOOL_CLOSE}\n`;
}

/** The method/type discriminator of a codex JSONL event. */
function codexEventKind(event: Record<string, unknown>): string | undefined {
  const method = event.method;
  if (typeof method === 'string') return method;
  const type = event.type;
  if (typeof type === 'string') return type;
  return undefined;
}

/** Pull the `item` payload out of a codex `item.completed`/`item/completed` event. */
export function codexCompletedItem(
  event: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const kind = codexEventKind(event);
  if (kind === 'item.completed' || kind === 'item/completed') {
    const item = event.item;
    if (typeof item === 'object' && item !== null) {
      return item as Record<string, unknown>;
    }
    const params = event.params;
    if (typeof params === 'object' && params !== null) {
      const nested = (params as Record<string, unknown>).item;
      if (typeof nested === 'object' && nested !== null) {
        return nested as Record<string, unknown>;
      }
    }
  }
  return undefined;
}

/** Build a readable progress line from a completed codex item (mirrors codex_progress_line). */
export function codexProgressLine(item: Record<string, unknown>): string | null {
  const itemType = typeof item.type === 'string' ? item.type : '';
  if (itemType === 'agent_message') {
    const text = item.text;
    if (typeof text === 'string' && text.length > 0) return text;
    return null;
  }
  if (!itemType) return null;

  const keys = ['command', 'name', 'path', 'file_path', 'query', 'text', 'status'];
  let detail = '';
  for (const k of keys) {
    const v = item[k];
    if (typeof v === 'string') {
      const s = v.trim();
      if (s) {
        detail = s.replace(/[\r\n]/g, ' ');
        break;
      }
    }
  }
  detail = detail.slice(0, 200);
  return detail ? `\n🔧 ${itemType}: ${detail}\n` : `\n🔧 ${itemType}\n`;
}

/** Extract a codex turn-completion status, or undefined (mirrors codex_turn_completion_status). */
export function codexTurnCompletionStatus(
  event: Record<string, unknown>,
): string | undefined {
  const kind = codexEventKind(event);
  if (kind === 'turn.completed' || kind === 'turn/completed' || kind === 'turn_complete') {
    const params = event.params as Record<string, unknown> | undefined;
    const turn =
      params && typeof params.turn === 'object' && params.turn !== null
        ? (params.turn as Record<string, unknown>)
        : undefined;
    const eventTurn =
      typeof event.turn === 'object' && event.turn !== null
        ? (event.turn as Record<string, unknown>)
        : undefined;
    const status =
      (turn && typeof turn.status === 'string' ? turn.status : undefined) ??
      (eventTurn && typeof eventTurn.status === 'string' ? eventTurn.status : undefined) ??
      (typeof event.status === 'string' ? event.status : undefined) ??
      'completed';
    return status;
  }
  return undefined;
}

/** Extract a codex turn-completion usage payload, when the JSONL event includes one. */
export function codexTurnUsage(
  event: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const kind = codexEventKind(event);
  if (kind !== 'turn.completed' && kind !== 'turn/completed' && kind !== 'turn_complete') {
    return undefined;
  }
  if (typeof event.usage === 'object' && event.usage !== null) {
    return event.usage as Record<string, unknown>;
  }
  const params =
    typeof event.params === 'object' && event.params !== null
      ? (event.params as Record<string, unknown>)
      : undefined;
  if (params && typeof params.usage === 'object' && params.usage !== null) {
    return params.usage as Record<string, unknown>;
  }
  const turn =
    params && typeof params.turn === 'object' && params.turn !== null
      ? (params.turn as Record<string, unknown>)
      : typeof event.turn === 'object' && event.turn !== null
        ? (event.turn as Record<string, unknown>)
        : undefined;
  if (turn && typeof turn.usage === 'object' && turn.usage !== null) {
    return turn.usage as Record<string, unknown>;
  }
  return undefined;
}

/** Whether a codex turn status string indicates success (mirrors codex_status_success). */
export function codexStatusSuccess(status: string): boolean {
  const s = status.trim().toLowerCase();
  return s === 'completed' || s === 'success' || s === 'succeeded' || s === 'ok';
}

/** A live sink for a CLI agent's progress chunks (stderr by default). */
export interface ProgressSink {
  write(chunk: string): void;
}

/** Build a {@link ProgressSink} that writes chunks to a stream (default process.stderr). */
export function streamSink(out: NodeJS.WriteStream = process.stderr): ProgressSink {
  return {
    write(chunk: string) {
      out.write(chunk);
    },
  };
}
