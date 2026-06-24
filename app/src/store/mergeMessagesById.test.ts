import { describe, it, expect } from 'vitest';
import { mergeMessagesById } from './useStore';
import type { Message } from './types';

const msg = (id: string, role: Message['role'], text = id): Message => ({
  id,
  role,
  text,
  createdAt: 1,
});

describe('mergeMessagesById', () => {
  it('returns base unchanged when there are no updates', () => {
    const base = [msg('u1', 'user'), msg('a1', 'assistant')];
    expect(mergeMessagesById(base, [])).toBe(base);
  });

  it('applies in-place edits without reordering existing messages', () => {
    const base = [msg('u1', 'user'), msg('a1', 'assistant', 'old')];
    const merged = mergeMessagesById(base, [msg('a1', 'assistant', 'new')]);
    expect(merged.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(merged[1].text).toBe('new');
  });

  it('inserts a new reply right after its prompt instead of at the tail', () => {
    // Interjection scenario: the base transcript already holds BOTH user
    // prompts (the second was appended while turn 1 was still resolving). The
    // turn-1 channel now commits its owned [user1, assistant1]; assistant1 must
    // land directly after user1, not below the later user2.
    const base = [msg('u1', 'user'), msg('u2', 'user')];
    const updates = [msg('u1', 'user'), msg('a1', 'assistant')];
    const merged = mergeMessagesById(base, updates);
    expect(merged.map((m) => m.id)).toEqual(['u1', 'a1', 'u2']);
  });

  it('keeps multiple new messages contiguous after their anchor', () => {
    const base = [msg('u1', 'user'), msg('u2', 'user')];
    const updates = [
      msg('u1', 'user'),
      msg('a1a', 'assistant'),
      msg('a1b', 'assistant'),
    ];
    const merged = mergeMessagesById(base, updates);
    expect(merged.map((m) => m.id)).toEqual(['u1', 'a1a', 'a1b', 'u2']);
  });

  it('appends new messages with no prior anchor at the front', () => {
    const base = [msg('u1', 'user')];
    const updates = [msg('a0', 'assistant'), msg('u1', 'user')];
    const merged = mergeMessagesById(base, updates);
    expect(merged.map((m) => m.id)).toEqual(['a0', 'u1']);
  });
});
