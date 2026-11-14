import { beforeEach, expect, it, vi } from 'vitest';

const seams = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('./tauri', () => ({ tauriAvailable: () => true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: seams.invoke }));

import { createMemoryIpcFixture } from '@/test/nativePersistenceFixture';
import { applyMemoryOp, loadMemory } from './memoryStore';
import { listPendingMemoryWrites, queuePendingMemoryWrites, resolvePendingMemoryWrites } from './memoryPending';

beforeEach(() => {
  localStorage.clear();
  const fixture = createMemoryIpcFixture();
  seams.invoke.mockReset().mockImplementation((command, payload) => fixture.invoke(command, payload));
});

it('rebases independent approvals through the desktop memory IPC and retains target scope', async () => {
  await applyMemoryOp('memory', { action: 'add', content: 'original' }, 'A');
  await queuePendingMemoryWrites([{ target: 'memory', operations: [{ action: 'add', content: 'first' }] }], 'review', 'A');
  await queuePendingMemoryWrites([{ target: 'memory', operations: [{ action: 'remove', oldText: 'original' }] }], 'review', 'A');
  const batches = await listPendingMemoryWrites();
  const result = await resolvePendingMemoryWrites(batches.map((batch) => batch.id), 'approve', 'B');
  expect(result.outcomes.map((outcome) => outcome.status)).toEqual(['applied', 'applied']);
  expect((await loadMemory('memory', 'A')).map((entry) => entry.text)).toEqual(['first']);
  expect(await loadMemory('memory', 'B')).toEqual([]);
  expect(await listPendingMemoryWrites()).toEqual([]);
  expect(seams.invoke).toHaveBeenCalledWith('memory_compare_exchange_json', expect.objectContaining({ relPath: 'memories/workspaces/A/memory.json' }));
});
