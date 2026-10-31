import { beforeEach, expect, it } from 'vitest';
import { applyMemoryOp, renderFrozenMemorySnapshot, renderMemorySnapshotCompact, resetFrozenMemorySnapshot } from './memoryStore';

beforeEach(() => { localStorage.clear(); resetFrozenMemorySnapshot(); });

it('derives full and compact prompts from the same persisted session snapshot', async () => {
  await applyMemoryOp('user', { action: 'add', content: 'original compact' });
  const compact = await renderMemorySnapshotCompact('A', 600, 'shared-session');
  await applyMemoryOp('user', { action: 'add', content: 'later compact' });
  expect(await renderMemorySnapshotCompact('A', 600, 'shared-session')).toBe(compact);
  const full = await renderFrozenMemorySnapshot('A', 'shared-session');
  expect(full).toContain('original compact'); expect(full).not.toContain('later compact');
});

it('restores the exact original snapshot after a renderer restart', async () => {
  await applyMemoryOp('user', { action: 'add', content: 'before restart' });
  const original = await renderFrozenMemorySnapshot('A', 'persisted-session');
  await applyMemoryOp('user', { action: 'add', content: 'after restart' });
  resetFrozenMemorySnapshot();
  expect(await renderFrozenMemorySnapshot('A', 'persisted-session')).toBe(original);
});

it('retains the original session snapshot after more than 32 newer sessions', async () => {
  await applyMemoryOp('user', { action: 'add', content: 'original snapshot' });
  const first = await renderFrozenMemorySnapshot('A', 'original-session');
  await applyMemoryOp('user', { action: 'add', content: 'later fact' });
  for (let i = 0; i < 35; i += 1) await renderFrozenMemorySnapshot('A', `new-session-${i}`);
  expect(await renderFrozenMemorySnapshot('A', 'original-session')).toBe(first);
  expect(await renderFrozenMemorySnapshot('A', 'brand-new')).toContain('later fact');
});
