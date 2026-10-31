/**
 * CONTRACT: model-agnostic "save to long-term memory" protocol.
 *
 * Like the interaction protocol (see core/interaction.ts), a chat turn is a
 * one-shot CLI/API call that can't invoke provider-specific tools mid-stream.
 * So we impose ONE convention on every model: to persist a durable fact, emit a
 * delimited JSON block anywhere in its reply (typically at the very end):
 *
 *     <<UGS_MEMORY>>
 *     { "target": "user", "operations": [ { "action": "add", "content": "偏好 Unity" } ] }
 *     <<UGS_MEMORY_END>>
 *
 * After the turn completes the run loop parses the block, applies it to the
 * on-disk store (lib/memoryStore.ts), and strips it from the visible message.
 * The write lands on the NEXT session's frozen system-prompt snapshot — it does
 * NOT mutate the current session's prompt, preserving the native-CLI prefix
 * cache (see lib/memoryStore.ts CONTRACT).
 *
 * This module is pure (no IO, no React, no store). It owns: the sentinels, the
 * op/target types, the tolerant parse/strip helpers, and the instruction text
 * injected into the chat system prompt.
 */

export type MemoryTarget = 'memory' | 'user';

export interface MemoryOp {
  action: 'add' | 'replace' | 'remove';
  content?: string;
  /** A short unique substring identifying the entry for replace/remove. */
  oldText?: string;
  /**
   * AI-suggested importance tier: 'must' | 'important' | 'minor' (Chinese
   * variants are accepted and normalized). Defaults to 'important' on add;
   * on replace it overrides the existing tier.
   */
  importance?: string;
}

/** A parsed memory-write request: a batch of ops against one target store. */
export interface MemoryWriteRequest {
  target: MemoryTarget;
  operations: MemoryOp[];
}

export const MEMORY_OPEN = '<<UGS_MEMORY>>';
export const MEMORY_CLOSE = '<<UGS_MEMORY_END>>';

// Tolerant sentinel matchers, mirroring core/interaction.ts. Models routinely
// fumble the exact delimiter — dropping a `>` (`<<UGS_MEMORY>`), adding a third
// (`<<UGS_MEMORY>>>`), or slipping in whitespace (`<< UGS_MEMORY >>`). A strict
// `indexOf('<<UGS_MEMORY>>')` misses those, so the whole reply (raw protocol
// JSON and all) leaks into the chat bubble. These regexes accept any positive
// number of trailing `>` and stray inner whitespace. The open matcher can't
// collide with the close sentinel because `UGS_MEMORY` there is immediately
// followed by `_END`, not `>`/whitespace.
const MEMORY_OPEN_RE = /<<\s*UGS_MEMORY\s*>+/;
const MEMORY_CLOSE_RE = /<<\s*UGS_MEMORY_END\s*>+/;

/** Locate a sentinel; returns its start index and matched length, or null. */
function findSentinel(
  text: string,
  re: RegExp,
  from = 0,
): { index: number; length: number } | null {
  const scoped = new RegExp(re.source, 'g');
  scoped.lastIndex = from;
  const m = scoped.exec(text);
  return m ? { index: m.index, length: m[0].length } : null;
}



export function normalizeMemoryOp(raw: unknown): MemoryOp | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (Object.keys(obj).some((key) => !['action', 'content', 'oldText', 'old_text', 'importance'].includes(key))) return null;
  const action = obj.action;
  if (action !== 'add' && action !== 'replace' && action !== 'remove') return null;
  if ('oldText' in obj && 'old_text' in obj) return null;
  const old = obj.oldText ?? obj.old_text;
  if (action !== 'remove' && (typeof obj.content !== 'string' || !obj.content.trim())) return null;
  if (action === 'remove' && ('content' in obj || 'importance' in obj)) return null;
  if (action === 'add' && ('oldText' in obj || 'old_text' in obj)) return null;
  if (action !== 'add' && (typeof old !== 'string' || !old.trim())) return null;
  if ('importance' in obj && (typeof obj.importance !== 'string' ||
      !['must', 'critical', '必须', 'important', '重要', 'minor', 'low', 'trivial', '不重要'].includes(obj.importance.trim().toLowerCase()))) return null;
  return {
    action,
    ...(typeof obj.content === 'string' ? { content: obj.content } : {}),
    ...(typeof old === 'string' ? { oldText: old } : {}),
    ...(typeof obj.importance === 'string' ? { importance: obj.importance } : {}),
  };
}

/** Validate the WHOLE submission before any host read or mutation. */
export function normalizeMemoryRequests(raw: unknown): MemoryWriteRequest[] | null {
  if (!Array.isArray(raw)) return null;
  const requests: MemoryWriteRequest[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const obj = value as Record<string, unknown>;
    if (Object.keys(obj).some((key) => !['target', 'operations'].includes(key))) return null;
    if (obj.target !== 'user' && obj.target !== 'memory') return null;
    if (!Array.isArray(obj.operations) || !obj.operations.length) return null;
    const operations = obj.operations.map(normalizeMemoryOp);
    if (operations.some((op) => op === null)) return null;
    requests.push({ target: obj.target, operations: operations as MemoryOp[] });
  }
  return requests;
}

/**
 * Parse a turn's output for ALL memory-write blocks. Keyed strictly on the
 * `<<UGS_MEMORY>>` sentinel so ordinary JSON in a reply never false-positives.
 * Returns one request per valid block (multiple blocks → multiple requests),
 * or an empty array when none are present.
 */
export function parseMemoryWrites(text: string): MemoryWriteRequest[] {
  if (!text || !findSentinel(text, MEMORY_OPEN_RE)) return [];
  const out: MemoryWriteRequest[] = [];
  let cursor = 0;
  for (;;) {
    const open = findSentinel(text, MEMORY_OPEN_RE, cursor);
    if (!open) break;
    const afterOpen = text.slice(open.index + open.length);
    const close = findSentinel(afterOpen, MEMORY_CLOSE_RE);
    if (!close) return []; // one incomplete block invalidates the whole payload
    const body = afterOpen.slice(0, close.index).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    cursor = open.index + open.length + close.index + close.length;

    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return [];
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    let request: unknown = raw;
    if (!('operations' in raw)) {
      const { target, ...inline } = raw;
      const single = normalizeMemoryOp(inline);
      if (!single) return [];
      request = { target, operations: [single] };
    }
    const requests = normalizeMemoryRequests([request]);
    if (!requests) return [];
    out.push(...requests);
  }
  return out;
}

/** Remove every memory-write block from the text so it isn't shown to the user. */
export function stripMemoryWrites(text: string): string {
  if (!text || !findSentinel(text, MEMORY_OPEN_RE)) return text;
  let result = '';
  let cursor = 0;
  for (;;) {
    const open = findSentinel(text, MEMORY_OPEN_RE, cursor);
    if (!open) {
      result += text.slice(cursor);
      break;
    }
    result += text.slice(cursor, open.index);
    const afterOpen = text.slice(open.index + open.length);
    const close = findSentinel(afterOpen, MEMORY_CLOSE_RE);
    if (!close) {
      // Unterminated block: drop everything from the sentinel onward.
      break;
    }
    cursor = open.index + open.length + close.index + close.length;
  }
  return result.trim();
}

/**
 * The instruction block injected into the chat system prompt teaching the model
 * when and how to write durable memory. Mirrors Hermes' guidance, including the
 * critical "do NOT record" list that prevents environment-specific failures
 * from hardening into permanent self-imposed constraints. Begins with "\n\n" so
 * it concatenates cleanly onto the rest of the system prompt.
 */
export const MEMORY_WRITE_INSTRUCTION =
  '\n\n【长期记忆写入协议】你可以把"跨会话仍然有用"的稳定事实写入长期记忆。' +
  '需要写入时，在回复的末尾输出一个记忆块（用户看不到它，会被自动剥离），然后正常结束：\n' +
  `${MEMORY_OPEN}\n` +
  '{"target":"user","operations":[{"action":"add","content":"简短的一条事实","importance":"important"}]}\n' +
  `${MEMORY_CLOSE}\n` +
  '- target：`user`=关于用户是谁（称呼、角色、偏好、沟通风格、常用引擎）；`memory`=你的笔记（当前项目引擎判读结果、资源目录约定、工具链怪癖、踩过的坑）。\n' +
  '- operations：原子批量执行，只在最终结果校验字数上限，所以同一个块里可以先 remove/replace 腾出空间再 add。action ∈ add|replace|remove；replace/remove 需要 oldText（已有条目的一段唯一子串）。\n' +
  '- importance（重要度，add/replace 必须给出）：`must`=必须（用户明确纠正、硬性偏好、会导致返工的约定）；`important`=重要（环境、引擎、约定、工作流等稳定事实，默认值）；`minor`=不重要（锦上添花的细节，可被最先淘汰）。存储层接受中英文写法（必须/重要/不重要）。replace 不带 importance 时保留原条目的重要度。\n' +
  '- 何时写：用户表达偏好/纠正/个人信息，或你确认了关于其环境、约定、工作流的稳定事实时，主动写。优先级：用户偏好与纠正 > 环境事实 > 流程。最好的记忆能让用户不必重复自己。\n' +
  '- 不要写（这些会变成日后反噬你的"自我强加约束"）：环境型失败（缺二进制、命令找不到、未装依赖、未配置凭据）；对工具/功能的负面断言（"X 工具坏了""无法用 Y"）；会话内已解决的临时错误；一次性任务叙述；琐碎或可随时重新发现的信息。\n' +
  '- 条目要短、信息密度高。每条一句话。无需写入时不要输出记忆块。';
