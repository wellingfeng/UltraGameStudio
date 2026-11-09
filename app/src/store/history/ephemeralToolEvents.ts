import { TOOL_CLOSE, TOOL_OPEN } from '@/components/ai/lib/toolEvent';

/** Runtime status cards are live-only; preserve all prose and durable patches. */
export function stripEphemeralToolEvents(text: string): string {
  if (!text.includes('"ephemeral"') || !text.includes(TOOL_OPEN)) return text;
  const kept: string[] = [];
  let search = 0, copied = 0;
  for (;;) {
    const open = text.indexOf(TOOL_OPEN, search);
    if (open < 0) break;
    const close = text.indexOf(TOOL_CLOSE, open + TOOL_OPEN.length);
    if (close < 0) break;
    const body = text.slice(open + TOOL_OPEN.length, close);
    let ephemeral = false;
    if (body.includes('"ephemeral"')) {
      try {
        const patch: unknown = JSON.parse(body);
        ephemeral = !!patch && typeof patch === 'object' && typeof (patch as { id?: unknown }).id === 'string'
          && (patch as { ephemeral?: unknown }).ephemeral === true;
      } catch { /* Literal or incomplete protocol text remains intact. */ }
    }
    if (ephemeral) {
      kept.push(text.slice(copied, open));
      copied = close + TOOL_CLOSE.length;
      search = copied;
    } else search = open + TOOL_OPEN.length;
  }
  return kept.length ? kept.join('') + text.slice(copied) : text;
}
