import { expect, it } from 'vitest';
import { isMemoryReviewMessageInWindow } from './memoryHistoryWindow';

it('uses each message timestamp rather than the enclosing session update', () => {
  const cutoff = 2000; const now = 4000;
  expect(isMemoryReviewMessageInWindow({ role: 'user', text: 'old', createdAt: 1999 }, cutoff, now)).toBe(false);
  expect(isMemoryReviewMessageInWindow({ role: 'assistant', text: 'boundary', createdAt: cutoff }, cutoff, now)).toBe(true);
  expect(isMemoryReviewMessageInWindow({ role: 'user', text: 'new', createdAt: now }, cutoff, now)).toBe(true);
  expect(isMemoryReviewMessageInWindow({ role: 'user', text: 'future', createdAt: 4001 }, cutoff, now)).toBe(false);
  expect(isMemoryReviewMessageInWindow({ role: 'user', text: 'unknown' }, cutoff, now)).toBe(false);
  expect(isMemoryReviewMessageInWindow({ role: 'user', text: 'unknown', createdAt: NaN }, cutoff, now)).toBe(false);
});
