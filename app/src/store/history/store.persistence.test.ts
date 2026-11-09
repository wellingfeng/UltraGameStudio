import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { handleSerialization } from './serializeValue';
import { PersistenceQueue } from './persistenceQueue';
import * as serialization from './serialization';
import * as payloadBudget from './payloadBudget';
import { splitSessionPayload } from './chunkedSession';

// This two-message fixture has 31,220 accounting bytes with empty old text.
// Each ASCII unit adds four retained 16-byte copies and 12 output bytes.
// The refusal test below checks both the base and the exact next-unit boundary.
const deltaSeedBaseOverlap = 31_220;
const deltaSeedUnitOverlap = 4 * 16 + 12;
const deltaSeedUnits = Math.floor((payloadBudget.HISTORY_PENDING_BYTES - deltaSeedBaseOverlap) / deltaSeedUnitOverlap);

// The production serializer reuses an idle Worker across tests. Its fixture
// must record into the current shared sink rather than an earlier test closure.
const workerRequests: any[] = [];
class SerializationWorkerFixture {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  postMessage(request: any) {
    const cloned = structuredClone(request);
    workerRequests.push(cloned.value);
    queueMicrotask(() => this.onmessage?.({ data: handleSerialization(cloned) }));
  }
  terminate() {}
}

const backend = vi.hoisted(() => ({ bytes: new Map<string, string>(), reads: [] as string[], writes: [] as Array<{ relPath: string; json: string; streamCheckpoint: boolean }>, failPath: null as string | null, pause: null as null | (() => Promise<void>) }));
vi.mock('@/lib/tauri', () => ({ tauriAvailable: () => true }));
const nativeInvoke = async (name: string, args: Record<string, any> = {}) => {
  if (name === 'history_read_json') { backend.reads.push(args.relPath); return backend.bytes.get(args.relPath) ?? null; }
  if (name === 'history_read_chunks') {
    backend.reads.push(...args.relPaths);
    return args.relPaths.map((path: string) => backend.bytes.get(path) ?? null);
  }
  if (name === 'history_write_json') {
    if (args.relPath === backend.failPath) { backend.failPath = null; throw new Error('injected final failure'); }
    if (args.streamCheckpoint && backend.pause) { const pause = backend.pause; backend.pause = null; await pause(); }
    backend.writes.push(args as any);
    const payload = JSON.parse(args.json);
    if (payload.__ugsJournal === 1) {
      const saved = JSON.parse(backend.bytes.get(args.relPath)!);
      Object.assign(saved, payload.fields);
      for (const key of payload.deleted ?? []) delete saved[key];
      const byId = new Map(saved.messages.map((m: any) => [m.id, m]));
      for (const message of payload.messages.upserts) byId.set(message.id, message);
      saved.messages = (payload.messages.order ?? saved.messages.map((m: any) => m.id)).map((id: string) => byId.get(id));
      backend.bytes.set(args.relPath, JSON.stringify(saved));
    } else backend.bytes.set(args.relPath, args.json);
    return;
  }
  if (name === 'history_list_dir') {
    const prefix = args.relPath + '/';
    return [...new Set([...backend.bytes.keys()].filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length).split('/')[0]))];
  }
  if (name === 'history_remove') { for (const p of backend.bytes.keys()) if (p === args.relPath || p.startsWith(args.relPath + '/')) backend.bytes.delete(p); return; }
  throw new Error('Unexpected native boundary: ' + name);
};
import { __resetHistorySessionCacheForTests, historyStore } from './store';
const ws = 'fixture-workspace';
const path = (id: string) => `workspaces/${ws}/sessions/${id}.json`;
const msg = (id: string, text = id, rev = 1) => ({ id, text, role: 'assistant' as const, createdAt: 1, streamUpdatedAt: rev });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };
beforeEach(() => {
  workerRequests.length = 0;
  backend.bytes.clear(); backend.reads = []; backend.writes = []; backend.pause = null; backend.failPath = null;
  (window as any).__TAURI_INTERNALS__ = { invoke: nativeInvoke };
});
afterEach(async () => { await historyStore.flush().catch(() => {}); __resetHistorySessionCacheForTests(); vi.unstubAllGlobals(); });

it('persists a new source message when a legacy session already contains a very large message', async () => {
  vi.stubGlobal('crypto', webcrypto);
  await historyStore.createSession({ workspaceId: ws, id: 'large-legacy', isWorkflow: false, messages: [msg('old')] });
  const original = JSON.parse(backend.bytes.get(path('large-legacy'))!);
  const bigText = '大型输出🌍'.repeat(950_000);
  original.messages[0].text = bigText;
  backend.bytes.set(path('large-legacy'), JSON.stringify(original));
  __resetHistorySessionCacheForTests();

  const source = { id: 'source', role: 'user' as const, text: '下一条消息', createdAt: 2 };
  await historyStore.appendMessage(ws, 'large-legacy', source);
  __resetHistorySessionCacheForTests();
  const recovered = await historyStore.getSessionForGeneration(ws, 'large-legacy');
  expect(recovered?.messages[0].text).toBe(bigText);
  expect(recovered?.messages[1]).toEqual(source);
  const chunk = [...backend.bytes.keys()].find((key) => key.includes('.json.chunks/'))!;
  backend.bytes.delete(chunk);
  __resetHistorySessionCacheForTests();
  await expect(historyStore.getSession(ws, 'large-legacy')).rejects.toThrow('HISTORY_CHUNK_CORRUPT');
});

it('defers loading chunked history until the session is opened', async () => {
  vi.stubGlobal('crypto', webcrypto);
  await historyStore.createSession({ workspaceId: ws, id: 'lazy', isWorkflow: false, messages: [msg('large', 'x'.repeat(1_000_000))] });
  __resetHistorySessionCacheForTests();
  backend.reads = [];
  vi.useFakeTimers();
  try {
    await historyStore.listSessions(ws);
    await vi.advanceTimersByTimeAsync(0);
    await historyStore.flush();
    expect(backend.reads.some((item) => item.includes('.json.chunks/'))).toBe(false);
    expect((await historyStore.getSession(ws, 'lazy'))?.messages[0].text).toHaveLength(1_000_000);
    expect(backend.reads.some((item) => item.includes('.json.chunks/'))).toBe(true);
  } finally { vi.useRealTimers(); }
});

it('restores a chunked draft without loading the session messages into the cache', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const rel = path('draft-only');
  const draft = 'draft '.repeat(90);
  const saved = await splitSessionPayload({ id: 'draft-only', workspaceId: ws, messages: [msg('large', 'message '.repeat(200))], meta: { composerDraft: draft } }, rel,
    async (p) => backend.bytes.has(p) ? JSON.parse(backend.bytes.get(p)!) : null,
    async (p, value) => { backend.bytes.set(p, JSON.stringify(value)); }) as any;
  backend.bytes.set(rel, JSON.stringify(saved));
  __resetHistorySessionCacheForTests();
  backend.reads = [];
  expect(await historyStore.getSessionComposerDraft(ws, 'draft-only')).toBe(draft);
  const reads = backend.reads.filter((p) => p.includes('.json.chunks/'));
  expect(reads).toEqual([`${rel}.chunks/${saved.meta.composerDraft.chunks[0]}.json`]);
  backend.reads = [];
  expect((await historyStore.getSession(ws, 'draft-only'))?.messages[0].text).toBe('message '.repeat(200));
  expect(backend.reads.some((p) => p.includes(saved.messages[0].text.chunks[0]))).toBe(true);
});

it('keeps the legacy session intact if publishing its chunk references fails', async () => {
  vi.stubGlobal('crypto', webcrypto);
  await historyStore.createSession({ workspaceId: ws, id: 'interrupted', isWorkflow: false, messages: [msg('old')] });
  const original = JSON.parse(backend.bytes.get(path('interrupted'))!);
  original.messages[0].text = 'unlost🌍'.repeat(300_000);
  const prior = JSON.stringify(original);
  backend.bytes.set(path('interrupted'), prior);
  __resetHistorySessionCacheForTests();
  backend.failPath = path('interrupted');
  await expect(historyStore.appendMessage(ws, 'interrupted', { id: 'source', role: 'user', text: 'source', createdAt: 2 }))
    .rejects.toThrow('injected final failure');
  expect(backend.bytes.get(path('interrupted'))).toBe(prior);
  await expect(historyStore.flush()).rejects.toThrow('injected final failure');
  await historyStore.appendMessage(ws, 'interrupted', { id: 'source', role: 'user', text: 'source', createdAt: 2 });
  __resetHistorySessionCacheForTests();
  const restored = await historyStore.getSessionForGeneration(ws, 'interrupted');
  expect(restored?.messages[0].text).toBe(original.messages[0].text);
  expect(restored?.messages[1].id).toBe('source');
});

it('checkpoints and finalizes one huge streaming message without rewriting stable chunks', async () => {
  vi.stubGlobal('crypto', webcrypto);
  await historyStore.createSession({ workspaceId: ws, id: 'large-stream', isWorkflow: false, messages: [msg('active')] });
  const text = '工具输出🌍'.repeat(950_000);
  await historyStore.updateSession(ws, 'large-stream', { streamCheckpoint: true, messages: [msg('active', text, 2)] });
  const chunksBefore = backend.writes.filter((write) => write.relPath.includes('.json.chunks/')).length;
  await historyStore.updateSession(ws, 'large-stream', { streamCheckpoint: true, messages: [msg('active', text + '结尾', 3)] });
  expect(backend.writes.filter((write) => write.relPath.includes('.json.chunks/')).length).toBe(chunksBefore);
  __resetHistorySessionCacheForTests();
  expect((await historyStore.getSessionForGeneration(ws, 'large-stream'))?.messages[0].text).toBe(text + '结尾');
  await historyStore.updateSession(ws, 'large-stream', { messages: [msg('active', text + '结尾', 4)] });
  __resetHistorySessionCacheForTests();
  expect((await historyStore.getSessionForGeneration(ws, 'large-stream'))?.messages[0].text).toBe(text + '结尾');
});

it('persists a terminal status and index without reserializing large existing messages', async () => {
  await historyStore.createSession({ workspaceId: ws, id: 'status-delta', isWorkflow: false, messages: [msg('old')] });
  const original = JSON.parse(backend.bytes.get(path('status-delta'))!);
  original.messages[0].text = 'x'.repeat(1_000_000);
  original.meta = { runStatus: 'interrupted' };
  backend.bytes.set(path('status-delta'), JSON.stringify(original));
  __resetHistorySessionCacheForTests();
  backend.writes = [];
  const serialize = serialization.serializeHistory;
  const spy = vi.spyOn(serialization, 'serializeHistory').mockImplementation((value, options) => {
    if (Array.isArray((value as { messages?: unknown })?.messages)) {
      return Promise.reject(new Error('full session serialization refused'));
    }
    return serialize(value, options);
  });
  try {
    await historyStore.updateSession(ws, 'status-delta', {
      meta: { runStatus: 'success', unreadCompletion: false }, terminalStatusOnly: true,
    });
    const write = backend.writes.find((entry) => entry.relPath === path('status-delta'));
    expect(JSON.parse(write!.json)).toMatchObject({
      __ugsJournal: 1, fields: { meta: { runStatus: 'success' } }, messages: { upserts: [] },
    });
    __resetHistorySessionCacheForTests();
    const saved = await historyStore.getSession(ws, 'status-delta');
    expect(saved?.meta?.runStatus).toBe('success');
    expect(saved?.messages[0].text).toBe(original.messages[0].text);
    expect((await historyStore.listSessions(ws)).find((item) => item.id === 'status-delta')?.runStatus).toBe('success');
  } finally { spy.mockRestore(); }
});

it('rejects a terminal-status-only patch that also changes messages', async () => {
  await historyStore.createSession({ workspaceId: ws, id: 'status-guard', isWorkflow: false, messages: [msg('old')] });
  await expect(historyStore.updateSession(ws, 'status-guard', {
    terminalStatusOnly: true, meta: { runStatus: 'success' }, messages: [msg('new')],
  })).rejects.toThrow('HISTORY_TERMINAL_STATUS_PATCH_INVALID');
  __resetHistorySessionCacheForTests();
  expect((await historyStore.getSession(ws, 'status-guard'))?.messages[0].id).toBe('old');
});

it('compacts a full checkpoint journal without losing the latest message', async () => {
  await historyStore.createSession({ workspaceId: ws, id: 'full-journal', isWorkflow: false, messages: [msg('old')] });
  let refused = false;
  (window as any).__TAURI_INTERNALS__.invoke = async (name: string, args: any) => {
    if (name === 'history_write_json' && args.relPath === path('full-journal') && JSON.parse(args.json).__ugsJournal === 1 && !refused) {
      refused = true;
      throw 'HISTORY_JOURNAL_FULL';
    }
    return nativeInvoke(name, args);
  };
  await historyStore.updateSession(ws, 'full-journal', { streamCheckpoint: true, messages: [msg('latest')] });
  __resetHistorySessionCacheForTests();
  expect(refused).toBe(true);
  expect((await historyStore.getSessionForGeneration(ws, 'full-journal'))?.messages[0].id).toBe('latest');
});

it('oversized final records and closure messages reject before worker/IPC and remain visible to flush', async () => {
  await historyStore.createSession({ workspaceId: ws, id: 'bounded', isWorkflow: false, messages: [msg('durable')] });
  backend.writes = [];
  let posted = 0;
  class WorkerFixture { postMessage() { posted++; } terminate() {} }
  vi.stubGlobal('Worker', WorkerFixture);
  const realEstimate = payloadBudget.estimateHistoryBytes;
  const smallBound = vi.spyOn(payloadBudget, 'estimateHistoryBytes').mockImplementation((value, limit) => realEstimate(value, Math.min(limit ?? 4000, 4000)));
  const oversized = msg('recoverable-final', 'x'.repeat(500));
  try {
    const producers = [
      () => historyStore.createSession({ workspaceId: ws, id: 'oversized', isWorkflow: false, messages: [oversized] }),
      () => historyStore.appendMessage(ws, 'bounded', oversized),
      () => historyStore.upsertMessage(ws, 'bounded', oversized),
      () => historyStore.updateSession(ws, 'bounded', { messages: [oversized] }),
    ];
    for (const produce of producers) await expect(produce()).rejects.toThrow('HISTORY_QUEUE_BYTES_FULL');
    await expect(historyStore.flush()).rejects.toThrow('HISTORY_QUEUE_BYTES_FULL');
    expect(posted).toBe(0); expect(backend.writes).toEqual([]);
    expect(JSON.parse(backend.bytes.get(path('bounded'))!).messages[0].id).toBe('durable');
    expect(oversized.text).toHaveLength(500);
  } finally { smallBound.mockRestore(); }
});

it('production writeJson hands actual I/O to the serialization permit lifetime', async () => {
  await historyStore.createSession({ workspaceId: ws, id: 'permit', isWorkflow: false });
  const spy = vi.spyOn(serialization, 'serializeHistory');
  const started = deferred(), release = deferred();
  backend.pause = async () => { started.resolve(); await release.promise; };
  const write = historyStore.updateSession(ws, 'permit', { streamCheckpoint: true, messages: [msg('held')] });
  await started.promise;
  const options = spy.mock.calls[0]?.[1];
  release.resolve(); await write; spy.mockRestore();
  expect(options?.relPath).toBe(path('permit'));
  expect(typeof options?.onSerialized).toBe('function');
});

it('meters records and messages retained by enqueue closures rather than undefined', async () => {
  const admission = vi.spyOn(PersistenceQueue.prototype, 'enqueue');
  try {
    const input = { workspaceId: ws, id: 'metered', isWorkflow: false, messages: [msg('created')] };
    await historyStore.createSession(input);
    const appended = msg('appended'); await historyStore.appendMessage(ws, 'metered', appended);
    const upserted = msg('upserted'); await historyStore.upsertMessage(ws, 'metered', upserted);
    const captured = admission.mock.calls.map((call) => call[1]);
    expect(captured).toContain(input);
    expect(captured).toContain(appended);
    expect(captured).toContain(upserted);
  } finally { admission.mockRestore(); }
});

it('a failed final index write propagates without letting the next patch overwrite durable messages', async () => {
  await historyStore.createSession({ workspaceId: ws, id: 'a', isWorkflow: false, messages: [msg('original')] });
  backend.failPath = `workspaces/${ws}/sessions/index.json`;
  await expect(historyStore.updateSession(ws, 'a', { messages: [msg('durable-final')] })).rejects.toThrow('injected final failure');
  await historyStore.updateSession(ws, 'a', { meta: { favorite: true } });
  __resetHistorySessionCacheForTests();
  expect((await historyStore.getSession(ws, 'a'))?.messages.map((m) => m.id)).toEqual(['durable-final']);
  await expect(historyStore.flush()).rejects.toThrow('injected final failure');
});

it('flush propagates a failed checkpoint even after its caller catches the rejection', async () => {
  await historyStore.createSession({ workspaceId: ws, id: 'a', isWorkflow: false, messages: [msg('original')] });
  backend.pause = async () => { throw new Error('disk full'); };
  await expect(historyStore.updateSession(ws, 'a', { streamCheckpoint: true, messages: [msg('failed')] })).rejects.toThrow('disk full');
  await expect(historyStore.flush()).rejects.toThrow('disk full');
  __resetHistorySessionCacheForTests();
  expect((await historyStore.getSession(ws, 'a'))?.messages.map((m) => m.id)).toEqual(['original']);
});

it('preserves extensible metadata from creation and coalesced checkpoints', async () => {
  await historyStore.createSession({ workspaceId: ws, id: 'a', isWorkflow: false, metadata: { origin: 'fixture' } });
  const started = deferred(), release = deferred();
  backend.pause = async () => { started.resolve(); await release.promise; };
  const running = historyStore.updateSession(ws, 'a', { streamCheckpoint: true }); await started.promise;
  const first = historyStore.updateSession(ws, 'a', { streamCheckpoint: true, metadata: { first: 'kept' } });
  const second = historyStore.updateSession(ws, 'a', { streamCheckpoint: true, metadata: { second: 'kept' } });
  release.resolve(); await Promise.all([running, first, second]); __resetHistorySessionCacheForTests();
  expect((await historyStore.getSession(ws, 'a'))?.metadata).toEqual({ origin: 'fixture', first: 'kept', second: 'kept' });
});

it('coalesces only pending checkpoints while preserving their fields and merged messages', async () => {
  await historyStore.createSession({ workspaceId: ws, id: 'a', isWorkflow: false, messages: [msg('original')] });
  backend.writes = [];
  const started = deferred(), release = deferred();
  backend.pause = async () => { started.resolve(); await release.promise; };
  const running = historyStore.updateSession(ws, 'a', { streamCheckpoint: true, mergeMessages: true, messages: [msg('first')] });
  await started.promise;
  const p1 = historyStore.updateSession(ws, 'a', { streamCheckpoint: true, mergeMessages: true, messages: [msg('second')], title: 'kept', meta: { favorite: true } });
  const p2 = historyStore.updateSession(ws, 'a', { streamCheckpoint: true, mergeMessages: true, messages: [msg('third')], meta: { pinned: true } });
  release.resolve();
  await Promise.all([running, p1, p2]);
  expect(backend.writes.filter((w) => w.relPath === path('a'))).toHaveLength(2);
  __resetHistorySessionCacheForTests();
  const saved = await historyStore.getSession(ws, 'a');
  expect(saved?.messages.map((m) => m.id)).toEqual(['original', 'first', 'second', 'third']);
  expect(saved).toMatchObject({ title: 'kept', meta: { favorite: true, pinned: true } });
});

it('coalescing does not erase an earlier checkpoint field with a no-op undefined patch', async () => {
  await historyStore.createSession({ workspaceId: ws, id: 'a', isWorkflow: false });
  const started = deferred(), release = deferred();
  backend.pause = async () => { started.resolve(); await release.promise; };
  const running = historyStore.updateSession(ws, 'a', { streamCheckpoint: true, mergeMessages: true });
  await started.promise;
  const first = historyStore.updateSession(ws, 'a', { streamCheckpoint: true, mergeMessages: true, title: 'kept', messages: [msg('kept')] });
  const second = historyStore.updateSession(ws, 'a', { streamCheckpoint: true, mergeMessages: true, title: undefined, messages: undefined });
  release.resolve(); await Promise.all([running, first, second]);
  __resetHistorySessionCacheForTests();
  expect(await historyStore.getSession(ws, 'a')).toMatchObject({ title: 'kept', messages: [{ id: 'kept' }] });
});

it('lets a different session checkpoint finish while one lane is blocked', async () => {
  for (const id of ['a', 'b']) await historyStore.createSession({ workspaceId: ws, id, isWorkflow: false });
  const started = deferred(), release = deferred();
  backend.pause = async () => { started.resolve(); await release.promise; };
  const running = historyStore.updateSession(ws, 'a', { streamCheckpoint: true, messages: [msg('blocked')] });
  await started.promise;
  let completed = false;
  const other = historyStore.updateSession(ws, 'b', { streamCheckpoint: true, messages: [msg('independent')] }).then(() => { completed = true; });
  try { await vi.waitFor(() => expect(completed).toBe(true), { timeout: 150, interval: 10 }); }
  finally { release.resolve(); await Promise.all([running, other]); }
});

it('preserves both workspace and session index updates from concurrent final saves', async () => {
  const one = await historyStore.resolveWorkspaceByPath('E:/fixture-one');
  const two = await historyStore.resolveWorkspaceByPath('E:/fixture-two');
  for (const workspace of [one, two]) for (const id of ['a', 'b']) {
    await historyStore.createSession({ workspaceId: workspace.id, id, isWorkflow: false });
  }
  await Promise.all([one, two].flatMap((workspace) => ['a', 'b'].map((id) =>
    historyStore.updateSession(workspace.id, id, { title: `updated-${id}`, messages: [msg(id)] }))));
  __resetHistorySessionCacheForTests();
  for (const workspace of [one, two]) {
    const index = JSON.parse(backend.bytes.get(`workspaces/${workspace.id}/sessions/index.json`)!);
    expect(index.map((s: any) => s.title).sort()).toEqual(['updated-a', 'updated-b']);
  }
  const index = JSON.parse(backend.bytes.get('workspaces/index.json')!);
  expect(index).toHaveLength(2);
  expect(index.every((w: any) => w.sessionCount === 2)).toBe(true);
});

it('reads after an accepted checkpoint as an ordered barrier, not stale cache', async () => {
  await historyStore.createSession({ workspaceId: ws, id: 'a', isWorkflow: false });
  const started = deferred(), release = deferred();
  backend.pause = async () => { started.resolve(); await release.promise; };
  const running = historyStore.updateSession(ws, 'a', { streamCheckpoint: true, messages: [msg('fresh')] });
  await started.promise;
  const read = historyStore.getSession(ws, 'a');
  release.resolve(); await running;
  expect((await read)?.messages.map((m) => m.id)).toEqual(['fresh']);
});

it('opens a different session while a checkpoint is still saving', async () => {
  for (const id of ['a', 'b']) await historyStore.createSession({ workspaceId: ws, id, isWorkflow: false });
  const started = deferred(), release = deferred();
  backend.pause = async () => { started.resolve(); await release.promise; };
  const running = historyStore.updateSession(ws, 'a', { streamCheckpoint: true, messages: [msg('blocked')] });
  await started.promise;
  let opened = false;
  const read = historyStore.getSession(ws, 'b').then((record) => { opened = record?.id === 'b'; });
  try { await vi.waitFor(() => expect(opened).toBe(true), { timeout: 300, interval: 10 }); }
  finally { release.resolve(); await Promise.all([running, read]); }
});

it('opens another session even when a navigation config write follows a blocked checkpoint', async () => {
  for (const id of ['a', 'b']) await historyStore.createSession({ workspaceId: ws, id, isWorkflow: false });
  const started = deferred(), release = deferred();
  backend.pause = async () => { started.resolve(); await release.promise; };
  const running = historyStore.updateSession(ws, 'a', { streamCheckpoint: true, messages: [msg('blocked')] });
  await started.promise;
  const config = historyStore.patchConfig({ lastActiveWorkspaceId: ws, lastActiveSessionId: 'a' });
  let opened = false;
  const read = historyStore.getSession(ws, 'b').then((record) => { opened = record?.id === 'b'; });
  try { await vi.waitFor(() => expect(opened).toBe(true), { timeout: 300, interval: 10 }); }
  finally { release.resolve(); await Promise.all([running, config, read]); }
});

it('merges consecutive config changes in order on their own lane', async () => {
  await Promise.all([
    historyStore.patchConfig({ lastActiveWorkspaceId: 'saved-workspace' }),
    historyStore.patchConfig({ lastActiveSessionId: 'saved-session' }),
  ]);
  expect(await historyStore.getConfig()).toMatchObject({
    lastActiveWorkspaceId: 'saved-workspace', lastActiveSessionId: 'saved-session',
  });
});

it('production checkpoints send only changed messages to worker cleaning and stringify', async () => {
  const sent = workerRequests;
  vi.stubGlobal('Worker', SerializationWorkerFixture);
  const old = msg('old', 'x'.repeat(deltaSeedUnits));
  await historyStore.createSession({ workspaceId: ws, id: 'delta', isWorkflow: false, messages: [old, msg('active')] });
  sent.length = 0;
  await historyStore.updateSession(ws, 'delta', {
    streamCheckpoint: true, mergeMessages: true, messages: [old, msg('active', 'new\ud83d 🚀', 2)], meta: { favorite: true },
  });
  expect(sent).toHaveLength(1);
  expect(sent[0].__ugsJournal).toBe(1);
  expect(sent[0].messages.upserts.map((m: any) => m.id)).toEqual(['active']);
  expect(JSON.stringify(sent[0])).not.toContain('x'.repeat(100));
  __resetHistorySessionCacheForTests();
  expect((await historyStore.getSession(ws, 'delta'))?.messages[1].text).toBe('new� 🚀');
});

it('output overlap refusal falls back to bounded chunks without losing the session', async () => {
  await historyStore.createSession({ workspaceId: ws, id: 'sentinel', isWorkflow: false, messages: [msg('durable')] });
  const before = [...backend.bytes];
  backend.writes = [];
  let budget: payloadBudget.HistoryByteBudget | undefined;
  const reserve = payloadBudget.HistoryByteBudget.prototype.reserve;
  const reserveSpy = vi.spyOn(payloadBudget.HistoryByteBudget.prototype, 'reserve').mockImplementation(function (this: payloadBudget.HistoryByteBudget, bytes, error) {
    budget = this;
    return reserve.call(this, bytes, error);
  });
  const sent = workerRequests;
  vi.stubGlobal('Worker', SerializationWorkerFixture);
  const old = msg('old', 'x'.repeat(1_000_000));
  try {
    const saved = await historyStore.createSession({ workspaceId: ws, id: 'delta', isWorkflow: false, messages: [old, msg('active')] });
    await historyStore.flush();
    expect(saved.id).toBe('delta');
    expect([...backend.bytes].length).toBeGreaterThan(before.length);
    expect(backend.writes.some((write) => write.relPath.includes('.json.chunks/'))).toBe(true);
    expect(sent.length).toBeGreaterThan(1);
    expect(old.text).toHaveLength(1_000_000);
    const overlap = (value: unknown) => {
      const result = handleSerialization({ id: 1, value: payloadBudget.prepareHistoryTransport(value), canonicalVersion: 1 });
      if (result.json === undefined) throw new Error(result.error ?? 'Missing fixture JSON');
      return payloadBudget.historySerializationPeakBytes(payloadBudget.estimateHistoryBytes(value))
        + payloadBudget.historyJsonEnvelopeBytes(result.json, path('delta'));
    };
    const inputPeak = payloadBudget.historySerializationPeakBytes(payloadBudget.estimateHistoryBytes(sent[0]));
    expect(inputPeak).toBeLessThanOrEqual(payloadBudget.HISTORY_PENDING_BYTES);
    expect(overlap(sent[0])).toBeGreaterThan(payloadBudget.HISTORY_PENDING_BYTES);
    const zero = { ...sent[0], messages: [{ ...sent[0].messages[0], text: '' }, sent[0].messages[1]] };
    const base = overlap(zero);
    expect(base).toBe(deltaSeedBaseOverlap);
    expect(base + deltaSeedUnitOverlap * deltaSeedUnits).toBeLessThanOrEqual(payloadBudget.HISTORY_PENDING_BYTES);
    expect(base + deltaSeedUnitOverlap * (deltaSeedUnits + 1)).toBeGreaterThan(payloadBudget.HISTORY_PENDING_BYTES);
    expect(budget).toBeDefined();
    const release = budget!.reserve(budget!.limit);
    release();
  } finally { reserveSpy.mockRestore(); }
});

it('failed final IO holds output admission until completion and allows an exact retry', async () => {
  await historyStore.createSession({ workspaceId: ws, id: 'final', isWorkflow: false, messages: [msg('durable')] });
  const before = backend.bytes.get(path('final'))!;
  backend.writes = [];
  const final = { ...msg('final', 'exact\ud83d 🚀', 9), completedAt: 11, toolCalls: [{ id: 'tool', name: 'test', arguments: '完整' }] };
  const patch = { messages: [final], title: 'exact title', meta: { favorite: true }, metadata: { kept: '完整' } };
  const retained = JSON.stringify(patch);
  let budget: payloadBudget.HistoryByteBudget | undefined;
  const reserve = payloadBudget.HistoryByteBudget.prototype.reserve;
  const reserveSpy = vi.spyOn(payloadBudget.HistoryByteBudget.prototype, 'reserve').mockImplementation(function (this: payloadBudget.HistoryByteBudget, bytes, error) {
    budget = this;
    return reserve.call(this, bytes, error);
  });
  const started = deferred(), release = deferred();
  let received: string | undefined;
  (window as any).__TAURI_INTERNALS__.invoke = async (name: string, args: any) => {
    if (name === 'history_write_json' && args.relPath === path('final')) {
      received = args.json;
      started.resolve();
      await release.promise;
      throw new Error('injected held final IO failure');
    }
    return nativeInvoke(name, args);
  };
  const write = historyStore.updateSession(ws, 'final', patch);
  const rejected = expect(write).rejects.toThrow('injected held final IO failure');
  try {
    await started.promise;
    expect(budget).toBeDefined();
    expect(() => budget!.reserve(budget!.limit)).toThrow('HISTORY_SERIALIZATION_BYTES_FULL');
    expect(backend.bytes.get(path('final'))).toBe(before);
    release.resolve();
    await rejected;
    await expect(historyStore.flush()).rejects.toThrow('injected held final IO failure');
    expect(JSON.stringify(patch)).toBe(retained);
    const all = budget!.reserve(budget!.limit);
    all();
    (window as any).__TAURI_INTERNALS__.invoke = nativeInvoke;
    await historyStore.updateSession(ws, 'final', patch);
    await historyStore.flush();
    __resetHistorySessionCacheForTests();
    const bytes = backend.bytes.get(path('final'))!, saved = JSON.parse(bytes);
    expect(bytes).toBe(received);
    expect(saved.messages).toEqual([{ ...final, text: 'exact� 🚀' }]);
    expect(saved).toMatchObject({ title: patch.title, meta: patch.meta, metadata: patch.metadata });
  } finally {
    release.resolve();
    (window as any).__TAURI_INTERNALS__.invoke = nativeInvoke;
    reserveSpy.mockRestore();
  }
});
