import { afterEach, expect, it, vi } from 'vitest';
import { historyStore, __resetHistorySessionCacheForTests } from './store';
import * as payloadBudget from './payloadBudget';
import * as tauri from '@/lib/tauri';
import * as tauriCore from '@tauri-apps/api/core';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const ws = 'generation-contract-fixture';
const key = (id: string) => `ultragamestudio.history.v1:workspaces/${ws}/sessions/${id}.json`;
afterEach(async () => { vi.restoreAllMocks(); await historyStore.flush().catch(() => {}); __resetHistorySessionCacheForTests(); });

it.each(['missing', 'failure'] as const)('native backing %s is not replaced by browser fallback bytes', async (kind) => {
  const origin = await historyStore.createSession({ workspaceId: ws, id: `native-${kind}`, isWorkflow: false });
  const before = localStorage.getItem(key(origin.id));
  vi.spyOn(tauri, 'tauriAvailable').mockReturnValue(true);
  const invoke = vi.mocked(tauriCore.invoke).mockReset().mockImplementation(async (name) => {
    if (name !== 'history_read_json') throw new Error('unexpected-native-command');
    if (kind === 'failure') throw new Error('native-backing-read-io');
    return null as never;
  });
  const result = historyStore.updateSessionIfGeneration(ws, origin.id, origin, {
    messages: [{ id: 'stale', role: 'assistant', text: 'must not fallback', createdAt: 1 }],
  });
  if (kind === 'failure') await expect(result).rejects.toThrow('native-backing-read-io');
  else await expect(result).resolves.toBeNull();
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem(key(origin.id))).toBe(before);
});

it('backing origin capture cannot treat a hydrated UI cache as authority', async () => {
  const origin = await historyStore.createSession({ workspaceId: ws, id: 'origin-read', isWorkflow: false });
  const before = localStorage.getItem(key(origin.id));
  const get = Storage.prototype.getItem;
  const reader = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, path) {
    if (path === key(origin.id)) throw new Error('origin-backing-read-io');
    return get.call(this, path);
  });
  // getSession is deliberately UI-tolerant; the new safety boundary must not use it.
  await expect(historyStore.getSessionForGeneration(ws, origin.id)).rejects.toThrow('origin-backing-read-io');
  reader.mockRestore();
  expect((await historyStore.getSessionForGeneration(ws, origin.id))?.generation).toBe(origin.generation);
  expect(localStorage.getItem(key(origin.id))).toBe(before);
});

it('rejects stale conditional updates after queued same-millisecond delete and recreation without writing replacement bytes', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(654321);
  const origin = await historyStore.createSession({ workspaceId: ws, id: 'cas', isWorkflow: false });
  const deletion = historyStore.deleteSession(ws, origin.id, false);
  const creation = historyStore.createSession({ workspaceId: ws, id: origin.id, isWorkflow: false,
    messages: [{ id: 'replacement', role: 'user', text: 'replacement', createdAt: 1 }] });
  const patch = { messages: [{ id: 'stale-final', role: 'assistant' as const, text: 'stale', createdAt: 1 }], mergeMessages: true };
  const result = historyStore.updateSessionIfGeneration(ws, origin.id, origin, patch);
  await Promise.all([deletion, creation]);
  expect(await result).toBeNull();
  expect(JSON.parse(localStorage.getItem(key(origin.id))!).messages.map((m: { id: string }) => m.id)).toEqual(['replacement']);
});

it('cannot resurrect a cached source record retired by workspace reconciliation', async () => {
  const canonical = await historyStore.resolveWorkspaceByPath('E:/generation-migration-fixture');
  const legacy = 'legacy-generation-fixture';
  const base = 'ultragamestudio.history.v1:';
  localStorage.setItem(base + `workspaces/${legacy}/meta.json`, JSON.stringify({ ...canonical, id: legacy }));
  const index = JSON.parse(localStorage.getItem(base + 'workspaces/index.json')!);
  localStorage.setItem(base + 'workspaces/index.json', JSON.stringify([...index, { ...canonical, id: legacy }]));
  const origin = await historyStore.createSession({ workspaceId: legacy, id: 'moved-final', isWorkflow: false });
  await historyStore.ready();
  const sourceKey = base + `workspaces/${legacy}/sessions/${origin.id}.json`;
  expect(localStorage.getItem(sourceKey)).toBeNull();
  const result = await historyStore.updateSessionIfGeneration(legacy, origin.id, origin, {
    messages: [{ id: 'stale', role: 'assistant', text: 'retired source', createdAt: 1 }], mergeMessages: true,
  });
  expect(result).toBeNull();
  expect(localStorage.getItem(sourceKey)).toBeNull();
  expect(await historyStore.getSession(canonical.id, origin.id)).not.toBeNull();
});

it('byte-admits the entire inert reconciliation payload and leaves rejected finals retryable', async () => {
  const origin = await historyStore.createSession({ workspaceId: ws, id: 'admission', isWorkflow: false });
  const estimate = payloadBudget.estimateHistoryBytes;
  const bound = vi.spyOn(payloadBudget, 'estimateHistoryBytes').mockImplementation((value, limit) => estimate(value, Math.min(limit ?? 4000, 4000)));
  const patch = { messages: [{ id: 'final', role: 'assistant' as const, text: 'final', createdAt: 1 }], mergeMessages: true };
  const reconciliation = { originMessages: [{ id: 'old', role: 'user' as const, text: 'x'.repeat(500), createdAt: 1 }], snapshot: { status: 'interrupted' as const } };
  await expect(historyStore.updateSessionIfGeneration(ws, origin.id, origin, patch, reconciliation)).rejects.toThrow('HISTORY_QUEUE_BYTES_FULL');
  await expect(historyStore.flush()).rejects.toThrow('HISTORY_QUEUE_BYTES_FULL');
  expect(JSON.parse(localStorage.getItem(key(origin.id))!).messages).toEqual([]);
  bound.mockRestore();
  await historyStore.updateSessionIfGeneration(ws, origin.id, origin, patch, reconciliation);
  expect(JSON.parse(localStorage.getItem(key(origin.id))!).messages.map((m: { id: string }) => m.id)).toEqual(['final']);
});

it('persists distinct generations for same-id creation in the same millisecond across cache eviction', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(123456);
  const first = await historyStore.createSession({ workspaceId: ws, id: 'same-ms', isWorkflow: false });
  await historyStore.deleteSession(ws, first.id, false);
  const replacement = await historyStore.createSession({ workspaceId: ws, id: first.id, isWorkflow: false });
  expect(replacement.createdAt).toBe(first.createdAt);
  expect(first.generation).toEqual(expect.any(String));
  expect(replacement.generation).not.toBe(first.generation);
  for (let i = 0; i < 8; i++) await historyStore.createSession({ workspaceId: ws, id: `evict-${i}`, isWorkflow: false });
  __resetHistorySessionCacheForTests();
  expect((await historyStore.getSession(ws, first.id))?.generation).toBe(replacement.generation);
  expect(JSON.parse(localStorage.getItem(key(first.id))!).generation).toBe(replacement.generation);
});
