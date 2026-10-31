import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { applyMemoryOp, loadMemory, setMemoryLimits, DEFAULT_MEMORY_LIMITS } from './memoryStore';
import { listPendingMemoryWrites, queuePendingMemoryWrites, resolvePendingMemoryWrites } from './memoryPending';

beforeEach(() => { localStorage.clear(); setMemoryLimits(DEFAULT_MEMORY_LIMITS); });
afterEach(() => vi.restoreAllMocks());

it('isolates legacy project proposals instead of guessing the approval page workspace', async () => {
  localStorage.setItem('ultragamestudio.memory.v1:memories/pending.json', JSON.stringify({ version: 1, writes: [
    { id: 'legacy-project', target: 'memory', op: { action: 'add', content: 'unknown origin' }, source: 'review', proposedAt: 1000 },
    { id: 'legacy-user', target: 'user', op: { action: 'add', content: 'legacy preference' }, source: 'review', proposedAt: 1001 },
  ] }));
  const pending = await listPendingMemoryWrites();
  expect(pending.map((batch) => batch.status)).toEqual(['needs_source_confirmation', 'needs_base_confirmation']);
  const outcome = await resolvePendingMemoryWrites(pending.map((batch) => batch.id), 'approve', 'current-B');
  expect(outcome.resolvedIds).toEqual([]);
  expect(await loadMemory('memory', 'current-B')).toEqual([]);
  expect(await loadMemory('user')).toEqual([]);
  expect(await listPendingMemoryWrites()).toHaveLength(2);
});

it('keeps an over-limit whole batch pending with zero applied count', async () => {
  await queuePendingMemoryWrites([{ target: 'user', operations: [{ action: 'add', content: 'x'.repeat(1500) }] }], 'review');
  const [batch] = await listPendingMemoryWrites();
  const outcome = await resolvePendingMemoryWrites([batch.id], 'approve');
  expect(outcome.outcomes[0].status).toBe('failed');
  expect(outcome.outcomes[0].appliedCount).toBe(0);
  expect(outcome.outcomes[0].error).toMatch(/limit/i);
  expect(await loadMemory('user')).toEqual([]);
  expect((await listPendingMemoryWrites())[0].operations).toEqual(batch.operations);
});

it('rejects an invalid submission without persisting its valid subset', async () => {
  await expect(queuePendingMemoryWrites([
    { target: 'user', operations: [{ action: 'add', content: 'valid subset' }] },
    { target: 'memory', operations: [{ action: 'add', content: '' }] },
  ], 'review', 'A')).rejects.toThrow(/invalid/i);
  expect(await listPendingMemoryWrites()).toEqual([]);
});

it('does not persist a cancelled proposal waiting behind another queue transaction', async () => {
  const { withMemoryLock } = await import('./memoryTransactions');
  let entered!: () => void; let release!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const blocker = withMemoryLock('memories/pending.json', () => new Promise<void>((resolve) => { release = resolve; entered(); }));
  await ready;
  const controller = new AbortController();
  const enqueue = queuePendingMemoryWrites([{ target: 'user', operations: [{ action: 'add', content: 'late' }] }], 'review', undefined, { signal: controller.signal });
  controller.abort(); release(); await blocker;
  await expect(enqueue).rejects.toThrow(/cancel|abort/i);
  expect(await listPendingMemoryWrites()).toEqual([]);
});

it('reconciles a committed batch after queue acknowledgement fails without replaying it', async () => {
  await queuePendingMemoryWrites([{ target: 'user', operations: [{ action: 'add', content: 'once' }] }], 'review');
  const [batch] = await listPendingMemoryWrites();
  const original = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (key.endsWith('pending.json')) throw new Error('queue quota');
    original.call(this, key, value);
  });
  await expect(resolvePendingMemoryWrites([batch.id], 'approve')).rejects.toThrow('queue quota');
  expect(await listPendingMemoryWrites()).toHaveLength(1);
  expect((await loadMemory('user')).map((entry) => entry.text)).toEqual(['once']);
  vi.restoreAllMocks();
  const retry = await resolvePendingMemoryWrites([batch.id], 'approve');
  expect(retry.resolvedIds).toEqual([batch.id]);
  expect(await listPendingMemoryWrites()).toEqual([]);
  expect((await loadMemory('user')).map((entry) => entry.text)).toEqual(['once']);
});

it('retains an original-workspace complete batch and approving on B only mutates A', async () => {
  await applyMemoryOp('memory', { action: 'add', content: 'A original' }, 'workspace-A');
  await queuePendingMemoryWrites([{ target: 'memory', operations: [
    { action: 'remove', oldText: 'A original' }, { action: 'add', content: 'A replacement' },
  ] }], 'review', 'workspace-A');
  const pending = await listPendingMemoryWrites();
  expect(pending).toHaveLength(1);
  const resolution = await resolvePendingMemoryWrites([pending[0].id], 'approve', 'workspace-B');
  expect(resolution.resolvedIds).toEqual([pending[0].id]);
  expect((await loadMemory('memory', 'workspace-A')).map((entry) => entry.text)).toEqual(['A replacement']);
  expect(await loadMemory('memory', 'workspace-B')).toEqual([]);
  expect(await listPendingMemoryWrites()).toEqual([]);
});
