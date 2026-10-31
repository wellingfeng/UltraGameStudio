import { describe, expect, it, vi } from 'vitest';
import { SkillLearningQueue } from './skillLearningQueue';
import { acquireReviewBackground } from '@/runtime/memory/review';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('skill learning foreground priority', () => {
  it('retains shared-slot work behind memory and wakes on release without timer polling', async () => {
    const memory = acquireReviewBackground('memory')!;
    const queue = new SkillLearningQueue<string, string>('skills:test');
    const ran: string[] = [];
    const pending = queue.enqueue('source', 'reserved-evidence', async (job) => { ran.push(job); return job; });
    const timer = vi.spyOn(globalThis, 'setTimeout');
    try {
      for (let i = 0; i < 12; i++) await Promise.resolve();
      expect(ran).toEqual([]);
      expect(timer).not.toHaveBeenCalled();
      memory.release();
      await expect(pending).resolves.toEqual({ status: 'completed', result: 'reserved-evidence' });
      expect(ran).toEqual(['reserved-evidence']);
    } finally { memory.release(); queue.cancel(); await pending; timer.mockRestore(); }
  });
  it('reviews a completed session while an unrelated session is still running', async () => {
    const queue = new SkillLearningQueue<string, string>();
    const releaseOther = queue.foregroundStarted('session-b');
    const ran: string[] = [];
    const result = queue.enqueue('session-a', 'job-a', async (job) => {
      ran.push(job); return 'applied';
    });
    try {
      for (let i = 0; i < 8; i++) await Promise.resolve();
      expect(ran).toEqual(['job-a']);
      await expect(result).resolves.toEqual({ status: 'completed', result: 'applied' });
    } finally { releaseOther(); await result; }
  });

  it('keeps source-session foreground priority without blocking other queued sessions', async () => {
    const queue = new SkillLearningQueue<string, string>();
    const release = queue.foregroundStarted('session-a');
    const ran: string[] = [];
    const first = queue.enqueue('session-a', 'a', async (job) => { ran.push(job); return job; });
    const second = queue.enqueue('session-b', 'b', async (job) => { ran.push(job); return job; });
    try {
      for (let i = 0; i < 8; i++) await Promise.resolve();
      expect(ran).toEqual(['b']);
    } finally { release(); await Promise.all([first, second]); }
    expect(ran).toEqual(['b', 'a']);
  });

  it('holds review work until foreground execution has released its slot', async () => {
    const ran: string[] = [];
    const queue = new SkillLearningQueue<string, string>();
    const release = queue.foregroundStarted();
    const result = queue.enqueue('workspace-a:session-a', 'job-a', async (job) => {
      ran.push(job); return 'applied';
    });
    await Promise.resolve();
    expect(ran).toEqual([]);
    release();
    expect(await result).toEqual({ status: 'completed', result: 'applied' });
    expect(ran).toEqual(['job-a']);
  });

  it('aborts an uncommitted background review as soon as a new foreground task starts', async () => {
    const queue = new SkillLearningQueue<string, string>();
    const started = deferred<AbortSignal>();
    const result = queue.enqueue('session-a', 'job-a', async (_job, signal) => {
      started.resolve(signal);
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      return 'unreachable';
    });
    const signal = await started.promise;
    const release = queue.foregroundStarted();
    expect(signal.aborted).toBe(true);
    expect(await result).toEqual({ status: 'cancelled' });
    release();
  });

  it('cancels a matching queued origin without draining unrelated background work', async () => {
    const queue = new SkillLearningQueue<string, string>();
    const release = queue.foregroundStarted();
    const cancelled = queue.enqueue('session-a', 'a', async (job) => job);
    const kept = queue.enqueue('session-b', 'b', async (job) => job);
    queue.cancel('session-a');
    expect(queue.foregroundActive).toBe(true);
    await expect(cancelled).resolves.toEqual({ status: 'cancelled' });
    release();
    expect(queue.foregroundActive).toBe(false);
    await expect(kept).resolves.toEqual({ status: 'completed', result: 'b' });
  });

  it('does not dispatch a reserved callback cancelled before its execution microtask', async () => {
    const queue = new SkillLearningQueue<string, string>();
    const dispatched: string[] = [];
    const result = queue.enqueue('session-a', 'reserved', async (job) => {
      dispatched.push(job); return 'applied';
    });
    // The queue has reserved the entry, but its asynchronous callback has not run.
    await Promise.resolve();
    const release = queue.foregroundStarted();
    try {
      await expect(result).resolves.toEqual({ status: 'cancelled' });
      expect(dispatched).toEqual([]);
    } finally { release(); }
  });

  it('does not dispatch a reserved callback explicitly cancelled before its execution microtask', async () => {
    const queue = new SkillLearningQueue<string, string>();
    const dispatched: string[] = [];
    const result = queue.enqueue('session-a', 'reserved', async (job) => { dispatched.push(job); return 'applied'; });
    await Promise.resolve();
    queue.cancel('session-a');
    await expect(result).resolves.toEqual({ status: 'cancelled' });
    expect(dispatched).toEqual([]);
  });

  it('waits for a dispatched host outcome instead of replacing an applied commit with cancellation', async () => {
    const queue = new SkillLearningQueue<string, string>();
    const started = deferred<AbortSignal>();
    const committed = deferred<string>();
    const result = queue.enqueue('session-a', 'committing', async (_job, signal) => {
      started.resolve(signal);
      return committed.promise;
    });
    const signal = await started.promise;
    queue.cancel('session-a');
    expect(signal.aborted).toBe(true);
    committed.resolve('applied');
    await expect(result).resolves.toEqual({ status: 'completed', result: 'applied' });
  });

  it('settles replaced queued work rather than leaving its caller pending forever', async () => {
    const queue = new SkillLearningQueue<string, string>();
    const release = queue.foregroundStarted();
    const old = queue.enqueue('session-a', 'old', async (job) => job);
    const next = queue.enqueue('session-a', 'new', async (job) => job);
    release();
    await expect(old).resolves.toEqual({ status: 'cancelled' });
    await expect(next).resolves.toEqual({ status: 'completed', result: 'new' });
  });
});
