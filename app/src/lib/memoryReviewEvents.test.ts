import { expect, it } from 'vitest';
import { getMemoryReviewStates, publishMemoryReview, subscribeMemoryReview, memoryReviewIdentity } from './memoryReviewEvents';
const state = (id: string) => ({ id, source: { hostId: 'fixture', namespaceId: 'isolated', workspaceId: 'workspace',
  sessionId: id, turnId: 'turn', sourceMessageId: 'turn', runId: 'run' }, phase: 'cancelled' as const,
  appliedOps: 0, queuedOps: 0, updatedAt: 1 });
it('isolates observer mutations and failures from later observers and the producer snapshot', () => {
  const input = state('observer-isolation');
  const observed: string[] = [];
  const stopBroken = subscribeMemoryReview(event => { event.source.sessionId = 'mutated'; throw new Error('UI observer failed'); });
  const stopHealthy = subscribeMemoryReview(event => { observed.push(event.source.sessionId); });
  try {
    expect(() => publishMemoryReview(input)).not.toThrow();
    expect(observed).toEqual(['observer-isolation']);
    expect(input.source.sessionId).toBe('observer-isolation');
    const snapshot = getMemoryReviewStates();
    const found = snapshot.find(entry => entry.id === input.id)!;
    expect(found.source.sessionId).toBe('observer-isolation');
    found.source.sessionId = 'snapshot-mutated';
    expect(getMemoryReviewStates().find(entry => entry.id === input.id)?.source.sessionId).toBe('observer-isolation');
  } finally { stopBroken(); stopHealthy(); }
});
it('unsubscribes without polling or replaying an old event', () => {
  const observed: string[] = [];
  const stop = subscribeMemoryReview(event => observed.push(event.id));
  expect(observed).toEqual([]);
  publishMemoryReview(state('before-unsubscribe'));
  stop(); publishMemoryReview(state('after-unsubscribe'));
  expect(observed).toEqual(['before-unsubscribe']);
});
it('bounds snapshots and preserves exact source identity across run and workspace changes', () => {
  for (let index = 0; index < 120; index++) publishMemoryReview(state(`bounded-${index}`));
  expect(getMemoryReviewStates()).toHaveLength(100);
  expect(getMemoryReviewStates().some(entry => entry.id === 'bounded-0')).toBe(false);
  const input = state('exact');
  expect(memoryReviewIdentity(input)).not.toBe(memoryReviewIdentity({ source: { ...input.source, runId: 'other' } }));
  expect(memoryReviewIdentity(input)).not.toBe(memoryReviewIdentity({ source: { ...input.source, workspaceId: 'other' } }));
});
