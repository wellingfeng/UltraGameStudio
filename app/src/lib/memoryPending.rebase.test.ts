import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applyMemoryOp, loadMemory } from './memoryStore';
import { listPendingMemoryWrites, queuePendingMemoryWrites, resolvePendingMemoryWrites } from './memoryPending';
import * as transactions from './memoryTransactions';

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

it('approves independent batches created against the same base', async () => {
  for (const content of ['first fact', 'second fact']) {
    await queuePendingMemoryWrites([{ target: 'user', operations: [{ action: 'add', content }] }], 'review');
  }
  const pending = await listPendingMemoryWrites();
  const result = await resolvePendingMemoryWrites(pending.map((batch) => batch.id), 'approve');
  expect(result.outcomes.map((outcome) => outcome.status)).toEqual(['applied', 'applied']);
  expect((await loadMemory('user')).map((entry) => entry.text)).toEqual(['first fact', 'second fact']);
  expect(await listPendingMemoryWrites()).toEqual([]);
});

it('approves an unchanged target after an unrelated memory edit', async () => {
  await applyMemoryOp('memory', { action: 'add', content: 'original target' }, 'A');
  await queuePendingMemoryWrites([{ target: 'memory', operations: [
    { action: 'remove', oldText: 'original target' }, { action: 'add', content: 'replacement' },
  ] }], 'review', 'A');
  const [pending] = await listPendingMemoryWrites();
  await applyMemoryOp('memory', { action: 'add', content: 'unrelated edit' }, 'A');
  const result = await resolvePendingMemoryWrites([pending.id], 'approve');
  expect(result.outcomes[0].status).toBe('applied');
  expect((await loadMemory('memory', 'A')).map((entry) => entry.text)).toEqual(['unrelated edit', 'replacement']);
});

it('keeps a stale targeted edit pending when the target changed', async () => {
  await applyMemoryOp('user', { action: 'add', content: 'original target' });
  await queuePendingMemoryWrites([{ target: 'user', operations: [{ action: 'remove', oldText: 'target' }] }], 'review');
  const [pending] = await listPendingMemoryWrites();
  await applyMemoryOp('user', { action: 'replace', oldText: 'target', content: 'changed target' });
  const result = await resolvePendingMemoryWrites([pending.id], 'approve');
  expect(result.outcomes[0].status).toBe('conflicted');
  expect((await loadMemory('user')).map((entry) => entry.text)).toEqual(['changed target']);
  expect(await listPendingMemoryWrites()).toHaveLength(1);
});

it('rejects an ambiguous match introduced by a concurrent edit', async () => {
  await applyMemoryOp('user', { action: 'add', content: 'shared original' });
  await queuePendingMemoryWrites([{ target: 'user', operations: [{ action: 'remove', oldText: 'shared' }] }], 'review');
  const [pending] = await listPendingMemoryWrites();
  await applyMemoryOp('user', { action: 'add', content: 'shared newer' });
  const result = await resolvePendingMemoryWrites([pending.id], 'approve');
  expect(result.outcomes[0]).toMatchObject({ status: 'conflicted', appliedCount: 0 });
  expect((await loadMemory('user')).map((entry) => entry.text)).toEqual(['shared original', 'shared newer']);
});

it('reconciles a rebased commit after the queue acknowledgement fails', async () => {
  await queuePendingMemoryWrites([{ target: 'user', operations: [{ action: 'add', content: 'approved fact' }] }], 'review');
  const [pending] = await listPendingMemoryWrites();
  await applyMemoryOp('user', { action: 'add', content: 'intervening fact' });
  const original = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (key.endsWith('pending.json')) throw new Error('queue quota');
    original.call(this, key, value);
  });
  await expect(resolvePendingMemoryWrites([pending.id], 'approve')).rejects.toThrow('queue quota');
  vi.restoreAllMocks();
  const retry = await resolvePendingMemoryWrites([pending.id], 'approve');
  expect(retry.outcomes[0].status).toBe('skipped');
  expect(await listPendingMemoryWrites()).toEqual([]);
  expect((await loadMemory('user')).map((entry) => entry.text)).toEqual(['intervening fact', 'approved fact']);
});

it('does not overwrite a new change between approval and the final CAS', async () => {
  await queuePendingMemoryWrites([{ target: 'user', operations: [{ action: 'add', content: 'approved fact' }] }], 'review');
  const [pending] = await listPendingMemoryWrites();
  await applyMemoryOp('user', { action: 'add', content: 'intervening fact' });
  const compare = transactions.compareExchangeMemoryJson;
  vi.spyOn(transactions, 'compareExchangeMemoryJson').mockImplementation(async (path, expected, json, signal, beforeDispatch) => {
    if (path === 'memories/user.json') {
      localStorage.setItem('ultragamestudio.memory.v1:memories/user.json', JSON.stringify({ version: 2, entries: [{ text: 'concurrent fact' }] }));
    }
    return compare(path, expected, json, signal, beforeDispatch);
  });
  const result = await resolvePendingMemoryWrites([pending.id], 'approve');
  expect(result.outcomes[0]).toMatchObject({ status: 'conflicted', appliedCount: 0 });
  expect((await loadMemory('user')).map((entry) => entry.text)).toEqual(['concurrent fact']);
  expect(await listPendingMemoryWrites()).toHaveLength(1);
});

it('compares the batch in order when it creates and then edits an entry', async () => {
  await queuePendingMemoryWrites([{ target: 'user', operations: [
    { action: 'add', content: 'temporary fact' }, { action: 'replace', oldText: 'temporary fact', content: 'final fact' },
  ] }], 'review');
  const [pending] = await listPendingMemoryWrites();
  await applyMemoryOp('user', { action: 'add', content: 'unrelated fact' });
  const result = await resolvePendingMemoryWrites([pending.id], 'approve');
  expect(result.outcomes[0].status).toBe('applied');
  expect((await loadMemory('user')).map((entry) => entry.text)).toEqual(['unrelated fact', 'final fact']);
});
