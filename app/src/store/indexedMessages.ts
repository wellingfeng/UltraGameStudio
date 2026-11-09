import type { Message } from './types';

// Arrays are immutable. Replacements inherit the same ID index; structural
// changes pay for a rebuild once, rather than on every streamed text revision.
const indexes = new WeakMap<Message[], Map<string, number>>();

export function indexMessages(messages: Message[]): Map<string, number> {
  let index = indexes.get(messages);
  if (!index) {
    index = new Map(messages.map((message, position) => [message.id, position]));
    indexes.set(messages, index);
  }
  return index;
}

export function messageById(messages: Message[], id: string): Message | undefined {
  const position = indexMessages(messages).get(id);
  return position === undefined ? undefined : messages[position];
}

export function replaceIndexedMessage(messages: Message[], message: Message): Message[] {
  const index = indexMessages(messages);
  const position = index.get(message.id);
  if (position === undefined || messages[position] === message) return messages;
  const next = messages.slice();
  next[position] = message;
  indexes.set(next, index);
  return next;
}

export function indexedOwnedMessages(messages: Message[], ids: Set<string>): Message[] {
  const index = indexMessages(messages);
  return [...ids].map((id) => index.get(id)).filter((position): position is number => position !== undefined)
    .sort((a, b) => a - b).map((position) => messages[position]);
}
