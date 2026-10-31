import { describe, expect, it } from 'vitest';
import { MemoryReviewScheduler, acquireReviewBackground, beginReviewForeground, cancelReviewBackground, preemptReviewBackground, subscribeReviewAvailable, subscribeReviewCancellation } from './review';

const source = { hostId: 'local', workspaceId: 'workspace', sessionId: 'session', turnId: 'user-1', runId: 'run-1' };
const job = { source, config: { reviewEnabled: true, writeEnabled: true, reviewMinMessages: 2, reviewMinIntervalMinutes: 0 },
  messages: [{ id: 'user-1', role: 'user', text: 'User fact' }, { id: 'answer-1', role: 'assistant', text: 'Verified answer' }] };

describe('renderer review coordination', () => {
  it('preempts only the active matching owner without cancelling undispatched waiters or releasing its slot', () => {
    const preempt = preemptReviewBackground;
    const slot = acquireReviewBackground('skills:remote')!;
    const cancelled: (string | undefined)[] = [];
    const stop = subscribeReviewCancellation((owner) => { cancelled.push(owner); });
    try {
      preempt('memory');
      expect(slot.signal.aborted).toBe(false);
      preempt('skills:remote');
      expect(slot.signal.aborted).toBe(true);
      expect(acquireReviewBackground()).toBeUndefined();
      expect(cancelled).toEqual([]);
    } finally { stop(); slot.release(); }
  });

  it('broadcasts explicit cancellation to pending listeners even without an active matching owner', () => {
    const slot = acquireReviewBackground('skills:remote')!;
    const cancelled: (string | undefined)[] = [];
    const stop = subscribeReviewCancellation((owner) => { cancelled.push(owner); });
    try {
      cancelReviewBackground('memory');
      expect(slot.signal.aborted).toBe(false);
      expect(cancelled).toEqual(['memory']);
      cancelReviewBackground();
      expect(slot.signal.aborted).toBe(true);
      expect(cancelled).toEqual(['memory', undefined]);
      expect(acquireReviewBackground()).toBeUndefined();
    } finally { stop(); slot.release(); }
  });

  it('does not broadcast pending cancellation when any foreground owner preempts active work', () => {
    const slot = acquireReviewBackground('memory')!;
    const cancelled: (string | undefined)[] = [];
    const stop = subscribeReviewCancellation((owner) => { cancelled.push(owner); });
    const end = beginReviewForeground('accepted-send');
    try {
      expect(slot.signal.aborted).toBe(true);
      expect(cancelled).toEqual([]);
      slot.release();
      expect(acquireReviewBackground()).toBeUndefined();
    } finally { stop(); slot.release(); end(); }
  });

  it('scopes module cancellation and holds cancelled transactions until their explicit release', () => {
    const skill = acquireReviewBackground('skills:remote')!;
    try {
      cancelReviewBackground('memory');
      expect(skill.signal.aborted).toBe(false);
      cancelReviewBackground('skills:remote');
      expect(skill.signal.aborted).toBe(true);
      expect(acquireReviewBackground()).toBeUndefined();
    } finally { skill.release(); }
  });

  it('notifies availability asynchronously only after every foreground owner and transaction release', async () => {
    const slot = acquireReviewBackground('skills:local')!;
    const first = beginReviewForeground('local');
    const second = beginReviewForeground('remote');
    const calls: string[] = [];
    const stop = subscribeReviewAvailable(() => { calls.push('available'); });
    try {
      slot.release(); first(); first();
      await Promise.resolve();
      expect(calls).toEqual([]);
      second();
      expect(calls).toEqual([]);
      await Promise.resolve();
      expect(calls).toEqual(['available']);
      second();
      await Promise.resolve();
      expect(calls).toEqual(['available']);
    } finally { stop(); slot.release(); first(); second(); }
  });
});

describe('memory review scheduler', () => {
  it('does not merge evidence or cooldown across namespaces', () => {
    const scheduler = new MemoryReviewScheduler();
    const first = { ...job, source: { ...source, namespaceId: 'account-A' } };
    const reserved = scheduler.reserve(first, 'completed', 1000)!;
    scheduler.finish(reserved.id, 'noop', 1001);
    expect(scheduler.reserve({ ...job, source: { ...source, namespaceId: 'account-B' } }, 'completed', 1002)).not.toBeNull();
  });
  it('bounds retained identity windows without rebilling evicted evidence', () => {
    const scheduler = new MemoryReviewScheduler();
    for (let n = 0; n < 400; n++) {
      const entry = { ...job, source: { ...source, turnId: `turn-${n}` }, messages: [
        { id: `u-${n}`, role: 'user', text: 'Fact' }, { id: `a-${n}`, role: 'assistant', text: 'Done' },
      ] };
      const reserved = scheduler.reserve(entry, 'completed', n * 1000)!;
      scheduler.finish(reserved.id, 'noop', n * 1000);
    }
    const state = scheduler.snapshot();
    expect(state.attempted.length).toBeLessThanOrEqual(256);
    expect(state.consumed.every(([, ids]) => ids.length <= 256)).toBe(true);
    const restored = new MemoryReviewScheduler(state);
    expect(restored.reserve({ ...job, source: { ...source, turnId: 'new-turn' }, messages: [{ id: 'u-0', role: 'user', text: 'Fact' }, { id: 'a-0', role: 'assistant', text: 'Done' }] }, 'completed', 500000)).toBeNull();
  });
  it('restores consumed ranges and failed-attempt replay fences across restart', () => {
    const scheduler = new MemoryReviewScheduler();
    const reserved = scheduler.reserve(job, 'completed', 1000)!;
    scheduler.finish(reserved.id, 'noop', 1001);
    expect(scheduler).toHaveProperty('snapshot');
    const restored = new MemoryReviewScheduler(scheduler.snapshot());
    expect(restored.reserve({ ...job, source: { ...source, turnId: 'user-2' } }, 'completed', 1002)).toBeNull();
    const failedSource = { ...job, source: { ...source, sessionId: 'failed-restart' } };
    const failed = scheduler.reserve(failedSource, 'completed', 1003)!;
    scheduler.finish(failed.id, 'failed', 1004);
    const afterFailure = new MemoryReviewScheduler(scheduler.snapshot());
    expect(afterFailure.reserve(failedSource, 'completed', 1005)).toBeNull();
    expect(afterFailure.reserve({ ...failedSource, source: { ...failedSource.source, turnId: 'next-turn' } }, 'completed', 1006)).not.toBeNull();
  });
  it('holds one reservation per scope and starts cooldown only after confirmed completion', () => {
    const scheduler = new MemoryReviewScheduler();
    const timed = { ...job, config: { ...job.config, reviewMinIntervalMinutes: 1 } };
    const reserved = scheduler.reserve(timed, 'completed', 1000)!;
    const next = { ...timed, source: { ...source, turnId: 'user-2' }, messages: [{ id: 'user-2', role: 'user', text: 'Next' }, { id: 'answer-2', role: 'assistant', text: 'Done' }] };
    expect(scheduler.reserve(next, 'completed', 1001)).toBeNull();
    scheduler.finish(reserved.id, 'noop', 1002);
    expect(scheduler.reserve(next, 'completed', 1003)).toBeNull();
    expect(scheduler.reserve(next, 'completed', 61002)).not.toBeNull();
  });
  it('requires a completed source turn before reserving a review', async () => {
    const module = await import('./review').catch(() => ({}));
    expect(module).toHaveProperty('MemoryReviewScheduler');
    if (!('MemoryReviewScheduler' in module)) return;
    const scheduler = new module.MemoryReviewScheduler();
    expect(scheduler.reserve(job, 'running', 1000)).toBeNull();
    expect(scheduler.reserve(job, 'completed', 1000)).not.toBeNull();
  });

  it('consumes only the reserved message range after a confirmed outcome', () => {
    const scheduler = new MemoryReviewScheduler();
    const reservation = scheduler.reserve(job, 'completed', 1000)!;
    expect(scheduler).toHaveProperty('finish');
    scheduler.finish(reservation.id, 'applied', 1000);
    const next = { ...job, source: { ...source, turnId: 'user-2' },
      messages: [...job.messages, { id: 'user-2', role: 'user', text: 'Next request' }] };
    expect(scheduler.reserve(next, 'completed', 1001)).toBeNull();
  });

  it('does not rebill a failed source retry but preserves its evidence for a later turn', () => {
    const scheduler = new MemoryReviewScheduler();
    const reservation = scheduler.reserve(job, 'completed', 1000)!;
    scheduler.finish(reservation.id, 'failed', 1000);
    expect(scheduler.reserve(job, 'completed', 1001)).toBeNull();
    expect(scheduler.reserve({ ...job, source: { ...source, turnId: 'user-2' } }, 'completed', 1002)?.job.messages).toEqual(job.messages);
  });
});
