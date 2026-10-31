import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import * as memory from './memoryStore';

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

it.each([{ before: [{ text: 'bad', injected: true }] }, { after: [42] }, { afterRevision: 12 }, { reviewSource: { workspaceId: 'A' } },
  { sourceConfirmation: { provenance: 'fabricated' } }, { mystery: true }])('fails closed on malformed extended receipt %j', async (fields) => {
  const raw = JSON.stringify({ version: 2, entries: [], receipts: [{ id: 'old', signature: 's', appliedCount: 1, skippedCount: 0, ...fields }] });
  localStorage.setItem('ultragamestudio.memory.v1:memories/user.json', raw);
  await expect(memory.loadMemory('user')).rejects.toThrow(/receipt/i);
  expect(localStorage.getItem('ultragamestudio.memory.v1:memories/user.json')).toBe(raw);
});

it('does not undo over a later manual edit or a stale preview', async () => {
  await memory.applyMemoryOp('user', { action: 'add', content: 'base' }, undefined, { transactionId: 'batch', expectedRaw: null });
  const committed = await memory.readMemoryBase('user');
  await memory.applyMemoryOp('user', { action: 'add', content: 'later' });
  const later = await memory.readMemoryBase('user');
  for (const raw of [committed.raw, later.raw]) {
    const result = await memory.undoMemoryTransaction('user', 'batch', undefined, raw);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/conflict/i);
  }
  expect((await memory.readMemoryBase('user')).raw).toBe(later.raw);
});
const source = { hostId: 'desktop', namespaceId: 'local', workspaceId: 'A', sessionId: 's', turnId: 'u', sourceMessageId: 'u', runId: 'r' };
it('roundtrips a source-bound global-memory receipt without inventing a workspace', async () => {
  const globalSource = { ...source, workspaceId: '' };
  const applied = await memory.applyMemoryBatch('memory', [{ action: 'add', content: 'global fact' }], undefined,
    { transactionId: 'global-batch', expectedRaw: null, reviewSource: globalSource });
  expect(applied.success).toBe(true);
  expect((await memory.readMemoryBase('memory')).entries.map((entry) => entry.text)).toEqual(['global fact']);
});
it('undoes a confirmed original-workspace commit by a new CAS transaction and retains source/audit', async () => {
  await memory.applyMemoryOp('memory', { action: 'add', content: 'before' }, 'A');
  const before = await memory.readMemoryBase('memory', 'A');
  await memory.applyMemoryBatch('memory', [{ action: 'replace', oldText: 'before', content: 'after' }], 'A',
    { expectedRaw: before.raw, transactionId: 'batch', reviewSource: source } as memory.MemoryBatchOptions);
  expect(typeof memory.undoMemoryTransaction).toBe('function');
  const current = await memory.readMemoryBase('memory', 'A');
  const undone = await memory.undoMemoryTransaction('memory', 'batch', 'A', current.raw);
  expect(undone.success).toBe(true);
  expect(await memory.loadMemory('memory', 'A')).toEqual(before.entries);
  expect(await memory.loadMemory('memory', 'B')).toEqual([]);
  const raw = JSON.parse((await memory.readMemoryBase('memory', 'A')).raw!);
  expect(raw.receipts.find((receipt: { id: string }) => receipt.id === 'batch').reviewSource).toEqual(source);
  expect(raw.receipts.find((receipt: { undoes?: string }) => receipt.undoes === 'batch')).toBeTruthy();
  const again = await memory.undoMemoryTransaction('memory', 'batch', 'A', current.raw);
  expect(again.alreadyApplied).toBe(true);
});
