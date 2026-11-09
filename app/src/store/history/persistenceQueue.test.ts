import { expect, it } from 'vitest';
import { PersistenceQueue } from './persistenceQueue';
const gate = () => { let release!: () => void; const promise = new Promise<void>((r) => { release = r; }); return { promise, release }; };

it('a flush after rejected admission observes failure even when an older same-target barrier already sampled it', async () => {
  const q = new PersistenceQueue({ maxPayloadBytes: 32 });
  const first = q.flush();
  // The empty barrier runs in the first microtask, but its public Promise has
  // not settled yet. No accepted job advances its admission target.
  await Promise.resolve();
  const rejected = q.enqueue(async () => {}, 'xx').then(() => 'accepted', (error: Error) => error.message);
  const second = q.flush();
  await expect(first).resolves.toBeUndefined();
  await expect(second).rejects.toThrow('HISTORY_QUEUE_BYTES_FULL');
  expect(await rejected).toBe('HISTORY_QUEUE_BYTES_FULL');
});

it('a later flush waits for B admitted after the first flush while B stays blocked', async () => {
  const q = new PersistenceQueue(), a = gate(), b = gate(), bStarted = gate();
  const first = q.enqueue(() => a.promise, null, 'a');
  const f1 = q.flush();
  expect(q.flush()).toBe(f1);
  const second = q.enqueue(async () => { bStarted.release(); await b.promise; }, null, 'b');
  const f2 = q.flush();
  let settled = false; void f2.then(() => { settled = true; });
  a.release(); await first; await f1; await bStarted.promise;
  // Microtasks are drained with B deliberately unresolved, not a timer race.
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  const premature = settled;
  b.release(); await Promise.all([second, f2]);
  expect(premature).toBe(false);
  expect(f2).not.toBe(f1);
});

it('charges pending and in-flight payload bytes until the operation actually completes', async () => {
  const q = new PersistenceQueue({ maxBytes: 600, maxPayloadBytes: 600 }), blocked = gate();
  const held = q.enqueue(() => blocked.promise, 'x'.repeat(20), 'a');
  const overflow = q.enqueue(async () => {}, 'x'.repeat(20), 'b').then(() => 'accepted', (e: Error) => e.message);
  const outcome = await overflow;
  blocked.release(); await held;
  await q.enqueue(async () => {}, 'x'.repeat(20), 'b');
  await expect(q.flush()).rejects.toThrow('HISTORY_QUEUE_BYTES_FULL');
  expect(outcome).toBe('HISTORY_QUEUE_BYTES_FULL');
});

it('rejects coalesced growth without replacing the already admitted checkpoint', async () => {
  const q = new PersistenceQueue({ maxBytes: 700, maxPayloadBytes: 700 }), blocked = gate();
  const seen: string[] = [];
  const held = q.enqueue(() => blocked.promise, null, 'a');
  const write = (value: string) => q.enqueue(async (v) => { seen.push(v); }, value, 'a', (a, b) => a + b);
  const admitted = write('x'.repeat(20));
  const overflow = write('y'.repeat(30)).then(() => 'accepted', (e: Error) => e.message);
  blocked.release(); await Promise.all([held, admitted]);
  const outcome = await overflow;
  expect(outcome).toBe('HISTORY_QUEUE_BYTES_FULL');
  expect(seen).toEqual(['x'.repeat(20)]);
  await expect(q.flush()).rejects.toThrow('HISTORY_QUEUE_BYTES_FULL');
});

it('rejects admission beyond the bound including coalesced callers', async () => {
  const q = new PersistenceQueue();
  const blocked = gate();
  const first = q.enqueue(() => blocked.promise, 0, 'a');
  const rest = Array.from({ length: 127 }, (_, i) => q.enqueue(async (n) => n, i, 'a', (_a, b) => b));
  const overflow = q.enqueue(async (n) => n, 128, 'a', (_a, b) => b);
  const result = overflow.then(() => 'accepted', (error: Error) => error.message);
  // Drain after capturing rejection: an unbounded queue would accept this.
  await Promise.resolve(); blocked.release();
  await Promise.all([first, ...rest]);
  expect(await result).toBe('HISTORY_QUEUE_FULL');
});

it('coalesces each waiting session lane despite interleaved checkpoints from other lanes', async () => {
  const q = new PersistenceQueue(), blocked = gate(); const seen: string[] = [];
  const active = ['a', 'b', 'c', 'd'].map((key) => q.enqueue(() => blocked.promise, null, key));
  const write = (key: string, value: string) => q.enqueue(async (merged) => { seen.push(`${key}:${merged}`); }, value, key, (before, after) => before + after);
  const pending = [write('a', '1'), write('b', '1'), write('a', '2'), write('b', '2')];
  blocked.release(); await Promise.all([...active, ...pending]);
  expect(seen.sort()).toEqual(['a:12', 'b:12']);
});

it('does not merge across a final barrier that already started in another lane', async () => {
  const q = new PersistenceQueue(), blocked = gate(), finalStarted = gate(), finalBlocked = gate(); const seen: string[] = [];
  const active = q.enqueue(() => blocked.promise, null, 'a');
  const write = (value: string) => q.enqueue(async (merged) => { seen.push(`a:${merged}`); }, value, 'a', (before, after) => before + after);
  const first = write('1');
  const final = q.enqueue(async () => { finalStarted.release(); await finalBlocked.promise; seen.push('final'); }, null, 'b');
  await finalStarted.promise;
  const second = write('2');
  blocked.release(); finalBlocked.release(); await Promise.all([active, first, final, second]);
  expect(seen.sort()).toEqual(['a:1', 'a:2', 'final']);
});

it('keeps final and global barriers ahead of subsequent same-session checkpoints', async () => {
  const q = new PersistenceQueue(); const blocked = gate(); const seen: string[] = [];
  const first = q.enqueue(() => blocked.promise, null, 'a');
  const call = (label: string, key?: string, merge = false) => q.enqueue(async (value) => { seen.push(value); }, label, key, merge ? (_a, b) => b : undefined);
  const writes = [call('checkpoint-1', 'a', true), call('final', 'a'), call('checkpoint-2', 'a', true), call('flush'), call('checkpoint-3', 'a', true)];
  blocked.release(); await Promise.all([first, ...writes]);
  expect(seen).toEqual(['checkpoint-1', 'final', 'checkpoint-2', 'flush', 'checkpoint-3']);
});
