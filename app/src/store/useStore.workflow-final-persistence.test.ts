import { afterEach, expect, it, vi } from 'vitest';
import { simpleBlueprint } from '@/core/defaultBlueprint';
import { historyStore, __resetHistorySessionCacheForTests } from './history/store';
import { activeRuns, activeAiEdits, aiEditSnapshots } from './channelRegistry';
import { flushChatPersistenceForQuit, useStore } from './useStore';
import type { RunChannel } from './channelTypes';

const prefix = 'workflow-final-fixture';
const storageKey = (id: string, workspace = '__default__') => `ultragamestudio.history.v1:workspaces/${workspace}/sessions/${id}.json`;
async function fixture(id: string): Promise<RunChannel> {
  await historyStore.ready();
  const workflow = simpleBlueprint('Workflow final fixture');
  await historyStore.createSession({ workspaceId: '__default__', id, isWorkflow: true, workflow, messages: [] });
  useStore.setState({ activeWorkspaceId: 'other', activeSessionId: 'other', messages: [] });
  const ch: RunChannel = { key: `__default__::${id}`, workspaceId: '__default__', sessionId: id,
    cancelled: false, workflow, config: {}, cliRunIds: new Set(),
    messages: [{ id: 'final', role: 'assistant', text: 'exact workflow final', createdAt: 1 }],
    runState: {}, runOutputs: { node: 'final output' }, failedNodeId: null, error: null };
  activeRuns.set(ch.key, ch);
  return ch;
}
function failWrites(id: string) {
  const original = Storage.prototype.setItem;
  return vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (key === storageKey(id)) throw new Error('fixture workflow final write failure');
    original.call(this, key, value);
  });
}
afterEach(async () => {
  vi.restoreAllMocks();
  activeRuns.clear(); activeAiEdits.clear(); aiEditSnapshots.clear();
  await flushChatPersistenceForQuit().catch(() => {});
  await historyStore.flush().catch(() => {});
  __resetHistorySessionCacheForTests();
});

it('retains a final rejected at admission until explicit retry and releases the successful payload', async () => {
  const id = `${prefix}-admission`;
  await fixture(id);
  const original = historyStore.updateSessionIfGeneration.bind(historyStore);
  const ordinaryUpdate = historyStore.updateSession.bind(historyStore);
  let admitted = false;
  // Quit may also emit an ordinary running checkpoint; block the same final
  // payload at BOTH real admission seams rather than letting that write mask failure.
  vi.spyOn(historyStore, 'updateSession').mockImplementation(async (workspace, session, patch) => {
    if (session === id && patch.messages?.some((message) => message.id === 'final') && !admitted)
      throw new Error('HISTORY_QUEUE_BYTES_EXCEEDED');
    return ordinaryUpdate(workspace, session, patch);
  });
  let finalCalls = 0;
  vi.spyOn(historyStore, 'updateSessionIfGeneration').mockImplementation(async (workspace, session, origin, patch, reconciliation) => {
    if (session === id && patch.messages?.some((message) => message.id === 'final')) {
      finalCalls += 1;
      if (!admitted) throw new Error('HISTORY_QUEUE_BYTES_EXCEEDED');
    }
    return original(workspace, session, origin, patch, reconciliation);
  });
  await expect(flushChatPersistenceForQuit()).rejects.toThrow('HISTORY_QUEUE_BYTES_EXCEEDED');
  await expect(flushChatPersistenceForQuit()).rejects.toThrow('HISTORY_QUEUE_BYTES_EXCEEDED');
  expect(JSON.parse(localStorage.getItem(storageKey(id))!).messages).toEqual([]);
  admitted = true;
  await flushChatPersistenceForQuit();
  const acknowledgedCalls = finalCalls;
  await flushChatPersistenceForQuit();
  expect(finalCalls).toBe(acknowledgedCalls);
  expect(JSON.parse(localStorage.getItem(storageKey(id))!).messages.some((message: { id: string }) => message.id === 'final')).toBe(true);
});

it('does not write a retained final into a replacement created between target read and queued update', async () => {
  const id = `${prefix}-concurrent-generation`;
  const time = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(time);
  await fixture(id);
  const writer = failWrites(id);
  await expect(flushChatPersistenceForQuit()).rejects.toThrow();
  writer.mockRestore();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const update = historyStore.updateSessionIfGeneration.bind(historyStore);
  vi.spyOn(historyStore, 'updateSessionIfGeneration').mockImplementation(async (workspace, session, origin, patch, reconciliation) => {
    if (session === id && patch.messages?.some((message) => message.id === 'final')) {
      entered();
      await held;
    }
    return update(workspace, session, origin, patch, reconciliation);
  });
  const retry = flushChatPersistenceForQuit();
  await started;
  await historyStore.deleteSession('__default__', id, false);
  await historyStore.createSession({ workspaceId: '__default__', id, isWorkflow: true,
    workflow: simpleBlueprint('Concurrent replacement'),
    messages: [{ id: 'replacement', role: 'user', text: 'new incarnation', createdAt: time }] });
  release();
  await retry;
  const saved = JSON.parse(localStorage.getItem(storageKey(id))!);
  expect(saved.messages.some((message: { id: string }) => message.id === 'replacement')).toBe(true);
  expect(saved.messages.some((message: { id: string }) => message.id === 'final')).toBe(false);
  expect(saved.workflow.meta.name).toBe('Concurrent replacement');
});

it('does not merge unchanged historical messages or replace a newer workflow on retry', async () => {
  const id = `${prefix}-owned-merge`;
  const ch = await fixture(id);
  const old = { id: 'old', role: 'user' as const, text: 'old history', createdAt: 1 };
  await historyStore.updateSession('__default__', id, { messages: [old] });
  ch.messages = [old, ...ch.messages];
  const writer = failWrites(id);
  await expect(flushChatPersistenceForQuit()).rejects.toThrow();
  writer.mockRestore();
  await historyStore.updateSession('__default__', id, { messages: [{ id: 'new-source', role: 'user', text: 'new prompt', createdAt: 2 }],
    workflow: simpleBlueprint('Newer edited workflow') });
  await flushChatPersistenceForQuit();
  const saved = JSON.parse(localStorage.getItem(storageKey(id))!);
  expect(saved.messages.some((message: { id: string }) => message.id === 'old')).toBe(false);
  expect(saved.messages.some((message: { id: string }) => message.id === 'new-source')).toBe(true);
  expect(saved.messages.some((message: { id: string }) => message.id === 'final')).toBe(true);
  expect(saved.workflow.meta.name).toBe('Newer edited workflow');
});

it('a browser run without history retains a recoverable transcript after failed quit', async () => {
  await historyStore.ready();
  const ch: RunChannel = { key: 'browser-final-fixture', workspaceId: null, sessionId: null,
    cancelled: false, workflow: simpleBlueprint('Browser final'), config: {}, cliRunIds: new Set(),
    messages: [{ id: 'browser-final', role: 'assistant', text: 'recoverable browser transcript', createdAt: 1 }],
    runState: {}, runOutputs: {}, failedNodeId: null, error: null };
  useStore.setState({ historyReady: false, activeWorkspaceId: null, activeSessionId: null, currentFilePath: null, messages: ch.messages });
  activeRuns.set(ch.key, ch);
  const key = `ultragamestudio.workflow-final-recovery.v1:${ch.key}`;
  const original = Storage.prototype.setItem;
  const writer = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, name, value) {
    if (name === key) throw new Error('fixture fallback unavailable');
    original.call(this, name, value);
  });
  await expect(flushChatPersistenceForQuit()).rejects.toThrow();
  writer.mockRestore();
  await flushChatPersistenceForQuit();
  expect(JSON.parse(localStorage.getItem(key)!).messages.find((message: { id: string }) => message.id === 'browser-final').text).toBe('recoverable browser transcript');
});

it('an overlapping quit must await a newly admitted workflow final producer', async () => {
  const first = await fixture(`${prefix}-overlap-a`);
  const original = historyStore.updateSessionIfGeneration.bind(historyStore);
  const releases = new Map<string, () => void>();
  vi.spyOn(historyStore, 'updateSessionIfGeneration').mockImplementation(async (workspace, session, origin, patch, reconciliation) => {
    if (session.startsWith(`${prefix}-overlap`) && patch.messages?.length) {
      await new Promise<void>((resolve) => { releases.set(session, resolve); });
    }
    return original(workspace, session, origin, patch, reconciliation);
  });
  let firstDone = false;
  const quit1 = flushChatPersistenceForQuit().then(() => { firstDone = true; });
  await vi.waitFor(() => expect(releases.has(first.sessionId!)).toBe(true));
  const second = await fixture(`${prefix}-overlap-b`);
  const quit2 = flushChatPersistenceForQuit();
  await vi.waitFor(() => expect(releases.has(second.sessionId!)).toBe(true));
  releases.get(first.sessionId!)!();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const settledBeforeSecondFinal = firstDone;
  releases.get(second.sessionId!)!();
  await Promise.all([quit1, quit2]);
  expect(settledBeforeSecondFinal).toBe(false);
  expect(JSON.parse(localStorage.getItem(storageKey(second.sessionId!))!).messages.some((message: { id: string }) => message.id === 'final')).toBe(true);
});

it('a newer same-id success does not acknowledge an older failed final revision', async () => {
  const id = `${prefix}-exact-revision`;
  await fixture(id);
  const writer = failWrites(id);
  await expect(flushChatPersistenceForQuit()).rejects.toThrow();
  writer.mockRestore();
  await historyStore.upsertMessage('__default__', id, { id: 'final', role: 'assistant', text: 'newer revision', createdAt: 1, streamUpdatedAt: Date.now() + 1000 });
  await expect(flushChatPersistenceForQuit()).rejects.toThrow('WORKFLOW_FINAL_REVISION_NOT_PERSISTED');
  await expect(flushChatPersistenceForQuit()).rejects.toThrow('WORKFLOW_FINAL_REVISION_NOT_PERSISTED');
  expect(JSON.parse(localStorage.getItem(storageKey(id))!).messages.find((message: { id: string }) => message.id === 'final').text).toBe('newer revision');
  await historyStore.deleteSession('__default__', id, false);
  await flushChatPersistenceForQuit();
});

it.each(['session', 'workspace', 'message', 'generation'] as const)('does not resurrect a deleted %s when retrying a failed workflow final', async (kind) => {
  const id = `${prefix}-delete-${kind}`;
  await fixture(id);
  const writer = failWrites(id);
  await expect(flushChatPersistenceForQuit()).rejects.toThrow();
  writer.mockRestore();
  if (kind === 'session' || kind === 'generation') await historyStore.deleteSession('__default__', id, false);
  if (kind === 'workspace') await historyStore.deleteWorkspace('__default__', false);
  if (kind === 'message') {
    useStore.setState({ activeWorkspaceId: '__default__', activeSessionId: id,
      historyReady: true, messages: [{ id: 'final', role: 'assistant', text: 'exact workflow final', createdAt: 1 }],
      sessions: [{ id, workspaceId: '__default__', isWorkflow: true } as never] });
    useStore.getState().deleteMessage('final');
    await historyStore.flush();
    useStore.setState({ activeWorkspaceId: 'other', activeSessionId: 'other', messages: [] });
  }
  if (kind === 'generation') {
    await new Promise((resolve) => setTimeout(resolve, 2));
    await historyStore.createSession({ workspaceId: '__default__', id, isWorkflow: true,
      workflow: simpleBlueprint('Replacement'), messages: [{ id: 'replacement', role: 'user', text: 'new generation', createdAt: Date.now() }] });
  }
  await expect(flushChatPersistenceForQuit()).resolves.toBeUndefined();
  const bytes = localStorage.getItem(storageKey(id));
  if (kind === 'session' || kind === 'workspace') expect(bytes).toBeNull();
  else expect(JSON.parse(bytes!).messages.some((message: { id: string }) => message.id === 'final')).toBe(false);
});

it('unavailable storage access rejects quit and retains exact final bytes for recovery', async () => {
  const id = `${prefix}-storage-access`;
  const ch = await fixture(id);
  const writer = failWrites(id);
  await expect(flushChatPersistenceForQuit()).rejects.toThrow();
  writer.mockRestore();
  expect(activeRuns.has(ch.key)).toBe(false);
  const access = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
    throw new Error('storage-access-denied');
  });
  await expect(flushChatPersistenceForQuit()).rejects.toThrow('HISTORY_STORAGE_UNAVAILABLE');
  access.mockRestore();
  await flushChatPersistenceForQuit();
  expect(JSON.parse(localStorage.getItem(storageKey(id))!).messages.find((message: { id: string }) => message.id === 'final').text)
    .toBe('exact workflow final');
});

it('quit message-only log cannot contaminate a same-millisecond replacement before final CAS', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(333);
  const id = `${prefix}-quit-log-replacement`;
  const ch = await fixture(id);
  // Model the origin read captured by startWorkflowRun, which is disabled in this
  // UI fixture; the independent memory-transform probe exercises capture itself.
  const origin = await historyStore.getSessionForGeneration('__default__', id);
  const reader = vi.spyOn(historyStore, 'getSessionForGeneration').mockResolvedValue(origin);
  await historyStore.deleteSession('__default__', id, false);
  const replacement = await historyStore.createSession({ workspaceId: '__default__', id, isWorkflow: true,
    workflow: simpleBlueprint('Replacement'), messages: [{ id: 'replacement', role: 'user', text: 'new', createdAt: 333 }] });
  const before = localStorage.getItem(storageKey(id));
  await flushChatPersistenceForQuit();
  reader.mockRestore();
  expect(activeRuns.has(ch.key)).toBe(false);
  expect(JSON.parse(localStorage.getItem(storageKey(id))!).generation).toBe(replacement.generation);
  expect(localStorage.getItem(storageKey(id))).toBe(before);
});

it.each(['', 'null', '{}', '42', '[]'])('non-record backing bytes %j reject quit without retiring the final', async (invalid) => {
  const id = `${prefix}-invalid-${invalid.length}-${invalid || 'empty'}`;
  await fixture(id);
  const writer = failWrites(id);
  await expect(flushChatPersistenceForQuit()).rejects.toThrow();
  writer.mockRestore();
  const bytes = localStorage.getItem(storageKey(id))!;
  localStorage.setItem(storageKey(id), invalid);
  await expect(flushChatPersistenceForQuit()).rejects.toThrow();
  expect(localStorage.getItem(storageKey(id))).toBe(invalid);
  localStorage.setItem(storageKey(id), bytes);
  await flushChatPersistenceForQuit();
  expect(JSON.parse(localStorage.getItem(storageKey(id))!).messages.find((message: { id: string }) => message.id === 'final').text)
    .toBe('exact workflow final');
});

it('malformed backing JSON rejects quit and retains the retired final until bytes recover', async () => {
  const id = `${prefix}-malformed-json`;
  await fixture(id);
  const writer = failWrites(id);
  await expect(flushChatPersistenceForQuit()).rejects.toThrow();
  writer.mockRestore();
  const bytes = localStorage.getItem(storageKey(id))!;
  localStorage.setItem(storageKey(id), '{broken');
  await expect(flushChatPersistenceForQuit()).rejects.toThrow();
  expect(localStorage.getItem(storageKey(id))).toBe('{broken');
  localStorage.setItem(storageKey(id), bytes);
  await flushChatPersistenceForQuit();
  expect(JSON.parse(localStorage.getItem(storageKey(id))!).messages.find((message: { id: string }) => message.id === 'final').text)
    .toBe('exact workflow final');
});

it('transient CAS backing read failure rejects quit and preserves the retired final for exact retry', async () => {
  const id = `${prefix}-transient-read`;
  const ch = await fixture(id);
  const writer = failWrites(id);
  await expect(flushChatPersistenceForQuit()).rejects.toThrow();
  writer.mockRestore();
  expect(activeRuns.has(ch.key)).toBe(false);
  const get = Storage.prototype.getItem;
  const reader = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
    if (key === storageKey(id)) throw new Error('transient-backing-read-io');
    return get.call(this, key);
  });
  await expect(flushChatPersistenceForQuit()).rejects.toThrow('transient-backing-read-io');
  reader.mockRestore();
  await flushChatPersistenceForQuit();
  expect(JSON.parse(localStorage.getItem(storageKey(id))!).messages.find((message: { id: string }) => message.id === 'final').text)
    .toBe('exact workflow final');
});

it('retries the retired workflow final on second quit and verifies real backing JSON', async () => {
  const id = `${prefix}-retry`;
  const ch = await fixture(id);
  const writer = failWrites(id);
  await expect(flushChatPersistenceForQuit()).rejects.toThrow();
  expect(activeRuns.has(ch.key)).toBe(false);
  expect(JSON.parse(localStorage.getItem(storageKey(id))!).messages).toEqual([]);
  writer.mockRestore();
  await flushChatPersistenceForQuit();
  __resetHistorySessionCacheForTests();
  const bytes = JSON.parse(localStorage.getItem(storageKey(id))!);
  expect(bytes.messages.find((message: { id: string }) => message.id === 'final')?.text).toBe('exact workflow final');
  expect(bytes.workflow.meta.run.status).toBe('interrupted');
  expect(bytes.meta.runOutputs.node).toBe('final output');
});
