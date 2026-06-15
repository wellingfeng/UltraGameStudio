/**
 * CONTRACT: model-agnostic "node asks the user" protocol.
 *
 * A running workflow node is a one-shot CLI call (`claude -p`, `codex exec`,
 * `gemini …`). It cannot pause mid-turn to ask a question. So instead of relying
 * on each model's native tool-calling format, we *impose* a single convention on
 * every model: when a node needs the user to choose between options or type
 * something, it emits a delimited JSON block and ends its turn:
 *
 *     <<FUC_ASK>>
 *     { "type": "select", "prompt": "选择部署环境", "options": ["staging","prod"] }
 *     <<FUC_ASK_END>>
 *
 * The run loop parses that block, renders an interactive widget in the AI-return
 * dock, waits for the user's answer, appends the answer to the node prompt, and
 * re-invokes the node (bounded loop). Because the instruction is injected by us
 * — not parsed out of a provider-specific tool schema — the same parser works
 * for Claude, Codex, Gemini, and any future CLI.
 *
 * This module is pure (no React / no store). It owns: the protocol instruction
 * text, the request/answer types, and the tolerant parse / strip / format-back
 * helpers.
 */

/** The kinds of user interaction a node can request. */
export type InteractionKind = 'select' | 'input' | 'confirm';

/** A request emitted by a node that the UI renders as a widget. */
export interface InteractionRequest {
  type: InteractionKind;
  /** Question / instruction shown to the user. */
  prompt: string;
  /** `select`: the choices. */
  options?: string[];
  /** `select`: allow choosing more than one. */
  multi?: boolean;
  /** `input`: placeholder text for the field. */
  placeholder?: string;
  /** `input`: render a multi-line textarea instead of a single-line field. */
  multiline?: boolean;
  /** `confirm`: label for the affirmative button (default "确定"). */
  confirmLabel?: string;
  /** `confirm`: label for the negative button (default "取消"). */
  cancelLabel?: string;
}

/** The user's reply to an {@link InteractionRequest}. */
export interface InteractionAnswer {
  kind: InteractionKind;
  /** `select`: the chosen option label(s). */
  values?: string[];
  /** `input`: the typed text. */
  text?: string;
  /** `confirm`: whether the user confirmed. */
  confirmed?: boolean;
}

const ASK_OPEN = '<<FUC_ASK>>';
const ASK_CLOSE = '<<FUC_ASK_END>>';

/**
 * Instruction block appended to every executable node prompt. Kept terse and
 * imperative so weaker models still follow it. The key rules: ask only when
 * genuinely blocked, emit ONLY the block (no surrounding prose), one block at a
 * time, and never invent options the user didn't imply.
 */
export const INTERACTION_PROTOCOL = `---
用户交互协议（重要）：
当且仅当你确实需要用户做出选择，或需要用户补充一段你无法自行决定的信息时，不要用自然语言提问，而是只输出下面这个交互块，然后立刻结束本回合，不要再输出其它任何文字：

${ASK_OPEN}
{"type":"select","prompt":"问题（简体中文）","options":["选项A","选项B"],"multi":false}
${ASK_CLOSE}

可用的 type：
- "select"：让用户在 options 中选择；需要多选时设 "multi":true。
- "input"：让用户输入文本；可选 "placeholder"、"multiline":true（多行）。
- "confirm"：让用户确认是否继续；可选 "confirmLabel"、"cancelLabel"。
规则：
- prompt 用简体中文，简洁清楚。
- 一次只问一个交互块。
- 块内必须是单个合法 JSON，不要加注释或多余文字。
- 如果你已经掌握足够信息（例如下方已给出用户的上一次回答），就不要再提问，直接给出最终结果。
- 不需要用户参与时，正常输出结果即可，不要输出交互块。`;

/** Coerce an unknown value into a clean string[]; drops empties, de-dupes. */
function toOptions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of value) {
    const s = typeof v === 'string' ? v.trim() : String(v ?? '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** Pull the first balanced `{…}` object span out of a string, or null. */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse a node's output for an interaction request. Keyed strictly on the
 * `<<FUC_ASK>>` sentinel — a unique token we inject and instruct every model to
 * use — so normal output that happens to contain JSON (e.g. a code-generating
 * node) never false-positives and wrongly pauses the run. Returns null when no
 * valid request is present.
 */
export function parseInteraction(text: string): InteractionRequest | null {
  if (!text) return null;

  const open = text.indexOf(ASK_OPEN);
  if (open === -1) return null;
  const afterOpen = text.slice(open + ASK_OPEN.length);
  const close = afterOpen.indexOf(ASK_CLOSE);
  if (close === -1) return null;
  const body = afterOpen.slice(0, close);
  const jsonSpan = firstJsonObject(body);
  if (!jsonSpan) return null;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(jsonSpan) as Record<string, unknown>;
  } catch {
    return null;
  }

  const type = raw.type;
  if (type !== 'select' && type !== 'input' && type !== 'confirm') return null;
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
  if (!prompt) return null;

  if (type === 'select') {
    const options = toOptions(raw.options);
    if (options.length === 0) return null; // a select with no options is unusable
    return { type, prompt, options, multi: raw.multi === true };
  }
  if (type === 'input') {
    return {
      type,
      prompt,
      placeholder:
        typeof raw.placeholder === 'string' ? raw.placeholder : undefined,
      multiline: raw.multiline === true,
    };
  }
  return {
    type,
    prompt,
    confirmLabel:
      typeof raw.confirmLabel === 'string' ? raw.confirmLabel : undefined,
    cancelLabel:
      typeof raw.cancelLabel === 'string' ? raw.cancelLabel : undefined,
  };
}

/**
 * Return the node output with the interaction block (and anything after it)
 * removed, so the streamed message doesn't show raw protocol JSON. Any prose the
 * model emitted *before* the block is preserved.
 */
export function stripInteraction(text: string): string {
  const open = text.indexOf(ASK_OPEN);
  if (open !== -1) return text.slice(0, open).trim();
  return text.trim();
}

/**
 * The prefix of a streaming reply that is safe to show live: everything before
 * either a ``` code fence (the hidden IRGraph payload in the AI-edit flow) or an
 * interaction block. Keeps both the JSON graph and the raw protocol out of the
 * visible message while tokens are still arriving.
 */
export function liveProse(text: string): string {
  const cuts: number[] = [];
  const ask = text.indexOf(ASK_OPEN);
  if (ask !== -1) cuts.push(ask);
  const fence = text.indexOf('```');
  if (fence !== -1) cuts.push(fence);
  if (cuts.length === 0) return text;
  return text.slice(0, Math.min(...cuts)).trimEnd();
}

/** Human-readable one-line summary of an answer (for the answered widget). */
export function summarizeAnswer(
  req: InteractionRequest,
  answer: InteractionAnswer,
): string {
  switch (req.type) {
    case 'select':
      return (answer.values ?? []).join('、') || '(未选择)';
    case 'input':
      return (answer.text ?? '').trim() || '(空)';
    case 'confirm':
      return answer.confirmed
        ? req.confirmLabel ?? '确定'
        : req.cancelLabel ?? '取消';
  }
}

/**
 * Build the appendix fed back into the node prompt on re-invocation, so the
 * model continues with the user's answer instead of asking again.
 */
export function formatAnswerForPrompt(
  req: InteractionRequest,
  answer: InteractionAnswer,
): string {
  return `---
用户已回复你上一次的交互请求：
- 你的问题：${req.prompt}
- 用户的回答：${summarizeAnswer(req, answer)}
请基于这个回答继续，不要重复提问，直接产出最终结果。`;
}
