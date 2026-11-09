import { describe, expect, it } from 'vitest';
import type { Message } from './types';
import { indexMessages, messageById, replaceIndexedMessage, indexedOwnedMessages } from './indexedMessages';

const message = (id: string): Message => ({ id, role: 'assistant', text: id, createdAt: 1 });

describe('immutable message indexes', () => {
  it('inherits an index for replacements without changing sealed messages', () => {
    const messages = [message('one'), message('two')];
    const index = indexMessages(messages);
    const update = { ...messages[1], text: 'new' };
    const next = replaceIndexedMessage(messages, update);
    expect(next[0]).toBe(messages[0]);
    expect(messages[1].text).toBe('two');
    expect(messageById(next, 'two')).toBe(update);
    expect(indexMessages(next)).toBe(index);
    expect(replaceIndexedMessage(next, message('missing'))).toBe(next);
  });

  it('returns owned messages in conversation order rather than Set insertion order', () => {
    const messages = [message('one'), message('two'), message('three')];
    expect(indexedOwnedMessages(messages, new Set(['three', 'missing', 'one']))).toEqual([messages[0], messages[2]]);
    expect(messageById(messages, 'missing')).toBeUndefined();
  });
});
