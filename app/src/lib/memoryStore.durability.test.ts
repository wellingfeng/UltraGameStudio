import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applyMemoryOp, applyMemoryWrites, loadMemory, setMemoryLimits, DEFAULT_MEMORY_LIMITS } from './memoryStore';

const key = 'ultragamestudio.memory.v1:memories/user.json';
beforeEach(() => { localStorage.clear(); setMemoryLimits(DEFAULT_MEMORY_LIMITS); });
afterEach(() => vi.restoreAllMocks());

it('rejects malformed workspace identities rather than normalizing them onto another project', async () => {
  await expect(applyMemoryOp('memory', { action: 'add', content: 'wrong scope' }, 'A/B')).rejects.toThrow(/workspace|scope/i);
  expect(await loadMemory('memory', 'A_B')).toEqual([]);
});

it.each(['{broken', '{"version":2,"entries":[{"text":"valid"},42]}', '{"version":999,"entries":[]}'])('refuses to overwrite unknown or corrupt JSON: %s', async (raw) => {
  localStorage.setItem(key, raw);
  await expect(applyMemoryOp('user', { action: 'add', content: 'new' })).rejects.toThrow();
  expect(localStorage.getItem(key)).toBe(raw);
});

it('serializes simultaneous additions without losing either entry', async () => {
  const results = await Promise.all([
    applyMemoryOp('user', { action: 'add', content: 'alpha' }),
    applyMemoryOp('user', { action: 'add', content: 'beta' }),
  ]);
  expect(results.every((result) => result.success)).toBe(true);
  expect((await loadMemory('user')).map((entry) => entry.text)).toEqual(['alpha', 'beta']);
});

it('rejects a stale exact base rather than overwriting a later edit', async () => {
  await applyMemoryOp('user', { action: 'add', content: 'base' });
  const expectedRaw = localStorage.getItem(key);
  await applyMemoryOp('user', { action: 'add', content: 'later edit' });
  const opts = { expectedRaw, evictOnOverflow: false };
  const result = await applyMemoryOp('user', { action: 'replace', oldText: 'base', content: 'changed' }, undefined, opts);
  expect(result.success).toBe(false);
  expect(result.error).toMatch(/conflict/i);
  expect((await loadMemory('user')).map((entry) => entry.text)).toEqual(['base', 'later edit']);
});

it('propagates storage quota failure without reporting a saved entry', async () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  await expect(applyMemoryOp('user', { action: 'add', content: 'durable fact' })).rejects.toThrow('quota');
  expect(await loadMemory('user')).toEqual([]);
});

it('prevalidates every request before applying any valid subset', async () => {
  const requests = [
    { target: 'user' as const, operations: [{ action: 'add' as const, content: 'must not persist' }] },
    { target: 'memory' as const, operations: [{ action: 'replace' as const, oldText: 'old', content: 'bad', root: 'C:/' }] },
  ];
  const result = await applyMemoryWrites(requests);
  expect(result.every((entry) => !entry.success)).toBe(true);
  expect(await loadMemory('user')).toEqual([]);
});

it('cancels a pending target lock without dispatching a late storage write', async () => {
  const { withMemoryLock } = await import('./memoryTransactions');
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const gate = withMemoryLock('memories/user.json', () => new Promise<void>((resolve) => { release = resolve; entered(); }));
  await ready;
  const controller = new AbortController();
  const write = applyMemoryOp('user', { action: 'add', content: 'late' }, undefined, { signal: controller.signal });
  controller.abort(); release(); await gate;
  await expect(write).rejects.toThrow(/cancel|abort/i);
  expect(await loadMemory('user')).toEqual([]);
});
