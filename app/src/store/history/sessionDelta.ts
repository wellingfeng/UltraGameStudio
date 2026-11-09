import type { Message } from '@/store/types';
import type { SessionRecord } from './types';

export interface SessionDelta {
  __ugsJournal: 1;
  fields: Record<string, unknown>;
  deleted: string[];
  messages: { upserts: Message[]; order?: string[] };
}

/** Compare immutable references, not full text serialization, on the UI thread. */
export function sessionDelta(previous: SessionRecord, next: SessionRecord): SessionDelta {
  const fields: Record<string, unknown> = {};
  const deleted: string[] = [];
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (key === 'messages') continue;
    const before = (previous as unknown as Record<string, unknown>)[key];
    const after = (next as unknown as Record<string, unknown>)[key];
    if (after === before) continue;
    if (after === undefined) deleted.push(key); else fields[key] = after;
  }
  const byId = new Map(previous.messages.map((message) => [message.id, message]));
  const upserts = next.messages.filter((message) => byId.get(message.id) !== message);
  const changedOrder = previous.messages.length !== next.messages.length ||
    next.messages.some((message, index) => previous.messages[index]?.id !== message.id);
  return { __ugsJournal: 1, fields, deleted,
    messages: { upserts, ...(changedOrder ? { order: next.messages.map((message) => message.id) } : {}) } };
}
