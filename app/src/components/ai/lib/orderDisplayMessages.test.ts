import { describe, expect, it } from 'vitest';
import type { Message } from '@/store/types';
import { orderDisplayMessages } from './orderDisplayMessages';

function msg(
  id: string,
  role: Message['role'],
  createdAt: number,
  extra: Partial<Message> = {},
): Message {
  return { id, role, text: `${id}`, createdAt, ...extra };
}

function ids(messages: Message[]): string[] {
  return messages.map((m) => m.id);
}

describe('orderDisplayMessages', () => {
  it('shows only the latest edited input across repeated sends and reloads without hiding replies', () => {
    const messages = [msg('u1', 'user', 100), msg('a1', 'assistant', 200),
      msg('u2', 'user', 300, { replacesMessageId: 'u1' }), msg('a2', 'assistant', 400),
      msg('u3', 'user', 500, { replacesMessageId: 'u2' })];
    expect(ids(orderDisplayMessages(JSON.parse(JSON.stringify(messages)), ['u3']))).toEqual(['a1', 'a2', 'u3']);
    expect(ids(messages)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3']);
    expect(ids(orderDisplayMessages(messages.slice(0, -1)))).toEqual(['a1', 'u2', 'a2']);
  });

  it('keeps queued prompts after an answered interaction and its later continuation', () => {
    const messages = [
      msg('u1', 'user', 100),
      msg('question', 'assistant', 200, { interactionStatus: 'answered' }),
      msg('continuation', 'assistant', 400),
      msg('queued', 'user', 300),
    ];
    expect(ids(orderDisplayMessages(messages, ['queued']))).toEqual([
      'u1', 'question', 'continuation', 'queued',
    ]);
    expect(ids(messages)).toEqual(['u1', 'question', 'continuation', 'queued']);
    expect(messages[3].createdAt).toBe(300);
  });

  it('keeps the queued tail in FIFO order and ignores queue IDs from other sessions', () => {
    const messages = [msg('q2', 'user', 200), msg('a1', 'assistant', 400), msg('q1', 'user', 300)];
    expect(ids(orderDisplayMessages(messages, ['other-session', 'q1', 'q2']))).toEqual(['a1', 'q1', 'q2']);
    expect(ids(orderDisplayMessages(messages, ['q2']))).toEqual(['q1', 'a1', 'q2']);
    expect(ids(orderDisplayMessages(messages, []))).toEqual(['q2', 'q1', 'a1']);
  });

  it('does not let a queued prompt break legacy interjection anchoring', () => {
    const messages = [
      msg('u1', 'user', 100), msg('a1', 'assistant', 200),
      msg('queued', 'user', 250), msg('i1', 'user', 300, { interjected: true }),
    ];
    expect(ids(orderDisplayMessages(messages, ['queued']))).toEqual(['u1', 'i1', 'a1', 'queued']);
  });

  it('returns the same array reference when already monotonic', () => {
    const messages = [
      msg('u1', 'user', 100),
      msg('a1', 'assistant', 200),
    ];
    expect(orderDisplayMessages(messages)).toBe(messages);
  });

  it('sorts out-of-order messages by createdAt when no interjection is present', () => {
    const messages = [
      msg('a2', 'assistant', 300),
      msg('u2', 'user', 200),
      msg('a1', 'assistant', 100),
    ];
    expect(ids(orderDisplayMessages(messages))).toEqual(['a1', 'u2', 'a2']);
  });

  it('keeps an interjection just above the reply it interrupted', () => {
    // Store order: user1 → interjection → reply. The interjection was sent
    // after the reply started, so its createdAt is later than the reply's.
    const messages = [
      msg('u1', 'user', 100),
      msg('i1', 'user', 300, { interjected: true }),
      msg('a1', 'assistant', 200),
    ];
    expect(ids(orderDisplayMessages(messages))).toEqual(['u1', 'i1', 'a1']);
  });

  it('keeps consecutive interjections above their shared reply in store order', () => {
    const messages = [
      msg('u1', 'user', 100),
      msg('i2', 'user', 400, { interjected: true }),
      msg('i1', 'user', 300, { interjected: true }),
      msg('a1', 'assistant', 200),
    ];
    expect(ids(orderDisplayMessages(messages))).toEqual(['u1', 'i2', 'i1', 'a1']);
  });

  it('anchors legacy trailing interjections to the preceding reply', () => {
    const messages = [
      msg('u1', 'user', 100),
      msg('a1', 'assistant', 200),
      msg('i1', 'user', 300, { interjected: true }),
    ];
    expect(ids(orderDisplayMessages(messages))).toEqual(['u1', 'i1', 'a1']);
  });

  it('ignores local skill cards when repairing a legacy interjection', () => {
    const messages = [
      msg('u0', 'user', 10),
      msg('a0', 'assistant', 20),
      msg('skill0', 'assistant', 30, { localOnly: true }),
      msg('u1', 'user', 100),
      msg('a1', 'assistant', 200, { completedAt: 203 }),
      msg('i1', 'user', 300, { interjected: true }),
      msg('skill1', 'assistant', 400, { localOnly: true }),
    ];
    expect(ids(orderDisplayMessages(messages))).toEqual([
      'u0', 'a0', 'skill0', 'u1', 'i1', 'a1', 'skill1',
    ]);
  });

  it('uses the persisted reply ID even if store ordering has drifted', () => {
    const messages = [
      msg('u1', 'user', 100),
      msg('a1', 'assistant', 200),
      msg('i1', 'user', 300, { interjected: true, interjectedReplyId: 'a1' }),
      msg('u2', 'user', 400),
      msg('a2', 'assistant', 500),
    ];
    expect(ids(orderDisplayMessages(messages))).toEqual(['u1', 'i1', 'a1', 'u2', 'a2']);
    expect(ids(messages)).toEqual(['u1', 'a1', 'i1', 'u2', 'a2']);
  });

  it('does not pull a later ordinary send above an anchored interjection', () => {
    const messages = [
      msg('u1', 'user', 100),
      msg('i1', 'user', 300, { interjected: true, interjectedReplyId: 'a1' }),
      msg('a1', 'assistant', 200),
      msg('u2', 'user', 400),
    ];
    expect(ids(orderDisplayMessages(messages))).toEqual(['u1', 'i1', 'a1', 'u2']);
  });
});
