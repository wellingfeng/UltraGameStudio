import { beforeEach, expect, it } from 'vitest';
import * as pending from './memoryPending';
import { loadMemory, readMemoryBase } from './memoryStore';

const queueKey = 'ultragamestudio.memory.v1:memories/pending.json';
const sourceKey = 'ultragamestudio.history.v1:workspaces/A/sessions/s.json';
function seed() {
  localStorage.setItem(queueKey, JSON.stringify({ version: 1, writes: [{ id: 'legacy', target: 'memory', op: { action: 'add', content: 'proposed' }, source: 'review', proposedAt: 1000 }] }));
  localStorage.setItem(sourceKey, JSON.stringify({ id: 's', workspaceId: 'A', messages: [{ id: 'u', role: 'user', text: 'explicit original request' }] }));
}
beforeEach(() => { localStorage.clear(); seed(); });
it('retains a known legacy workspace instead of allowing confirmation to rebind it to another project', async () => {
  const original = JSON.parse(localStorage.getItem(queueKey)!);
  original.writes[0].workspaceId = 'A';
  localStorage.setItem(queueKey, JSON.stringify(original));
  localStorage.setItem('ultragamestudio.history.v1:workspaces/B/sessions/s.json', JSON.stringify({ id: 's', workspaceId: 'B', messages: [{ id: 'u', role: 'user', text: 'unrelated project' }] }));
  const raw = localStorage.getItem(queueKey);
  await expect(pending.preparePendingMemoryConfirmation('legacy', { workspaceId: 'B', sessionId: 's', sourceMessageId: 'u' })).rejects.toThrow(/workspace mismatch/i);
  expect(localStorage.getItem(queueKey)).toBe(raw);
  expect(await loadMemory('memory', 'A')).toEqual([]);
  expect(await loadMemory('memory', 'B')).toEqual([]);
});
it.each(['queue', 'base', 'source', 'unconfirmed', 'missing-source'] as const)('retains legacy queue when confirmation is invalid: %s', async (kind) => {
  const preview = await pending.preparePendingMemoryConfirmation('legacy', { workspaceId: 'A', sessionId: 's', sourceMessageId: 'u' });
  if (kind === 'queue') localStorage.setItem(queueKey, localStorage.getItem(queueKey)!.replace('proposed', 'concurrent'));
  if (kind === 'base') { const { applyMemoryOp } = await import('./memoryStore'); await applyMemoryOp('memory', { action: 'add', content: 'later manual edit' }, 'A'); }
  if (kind === 'source') localStorage.setItem(sourceKey, localStorage.getItem(sourceKey)!.replace('explicit original request', 'edited source'));
  if (kind === 'missing-source') localStorage.removeItem(sourceKey);
  const raw = localStorage.getItem(queueKey);
  await expect(pending.confirmPendingMemorySource(preview, kind !== 'unconfirmed')).rejects.toThrow();
  expect(localStorage.getItem(queueKey)).toBe(raw);
});

it('rebuilds a legacy proposal only after explicit fresh persisted source and full current-base confirmation', async () => {
  expect(typeof pending.preparePendingMemoryConfirmation).toBe('function');
  const preview = await pending.preparePendingMemoryConfirmation('legacy', { workspaceId: 'A', sessionId: 's', sourceMessageId: 'u' });
  expect(preview.source.message.text).toBe('explicit original request');
  expect(preview.batch.operations).toEqual([{ action: 'add', content: 'proposed' }]);
  expect(preview.base.raw).toBe(null);
  const rebuilt = await pending.confirmPendingMemorySource(preview, true);
  expect(rebuilt.id).not.toBe('legacy');
  expect(rebuilt.workspaceId).toBe('A');
  expect(rebuilt.reviewSource).toBeUndefined();
  expect(rebuilt.sourceConfirmation?.legacyId).toBe('legacy');
  expect(rebuilt.sourceConfirmation?.provenance).toBe('user_confirmed_rebinding');
  expect(await loadMemory('memory', 'A')).toEqual([]);
  await pending.resolvePendingMemoryWrites([rebuilt.id], 'approve', 'B');
  expect(await loadMemory('memory', 'B')).toEqual([]);
  const committed = JSON.parse((await readMemoryBase('memory', 'A')).raw!);
  expect(committed.receipts[0].sourceConfirmation.message.text).toBe('explicit original request');
});
