import { afterEach, expect, it, vi } from 'vitest';
import { historyStore } from './history/store';
import { flushComposerDraftPersist, resetComposerDraftPersistForTests, scheduleComposerDraftPersist } from './composerDraftPersistence';

afterEach(async () => {
  vi.restoreAllMocks();
  resetComposerDraftPersistForTests();
  await historyStore.flush().catch(() => {});
});

it('retains a failed draft write and saves the same text on the next flush', async () => {
  resetComposerDraftPersistForTests();
  await historyStore.ready();
  const id = 'draft-write-retry';
  await historyStore.createSession({ workspaceId: '__default__', id, isWorkflow: false, messages: [] });
  const key = `ultragamestudio.history.v1:workspaces/__default__/sessions/${id}.json`;
  const original = Storage.prototype.setItem;
  const failingWrite = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, name, value) {
    if (name === key) throw new Error('fixture draft write failed');
    original.call(this, name, value);
  });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    scheduleComposerDraftPersist('__default__', id, 'exact unsubmitted draft');
    await expect(flushComposerDraftPersist()).rejects.toThrow('fixture draft write failed');
    expect(JSON.parse(localStorage.getItem(key)!).meta?.composerDraft).toBeUndefined();
    failingWrite.mockRestore();
    // Consume the queue's record of the failed first attempt as quit does.
    await expect(historyStore.flush()).rejects.toThrow('fixture draft write failed');
    await flushComposerDraftPersist();
    await historyStore.flush();
    expect(JSON.parse(localStorage.getItem(key)!).meta?.composerDraft).toBe('exact unsubmitted draft');
  } finally {
    failingWrite.mockRestore();
    log.mockRestore();
  }
});

it.each(['newer draft', ''])('preserves the newest draft %j while an older write is in flight', async (latest) => {
  resetComposerDraftPersistForTests();
  await historyStore.ready();
  const id = latest ? 'draft-newer-version' : 'draft-cleared-version';
  await historyStore.createSession({ workspaceId: '__default__', id, isWorkflow: false, messages: [] });
  scheduleComposerDraftPersist('__default__', id, '');
  await flushComposerDraftPersist();
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const writing = new Promise<void>((resolve) => { started = resolve; });
  const update = historyStore.updateSessionIfGeneration.bind(historyStore);
  vi.spyOn(historyStore, 'updateSessionIfGeneration').mockImplementation(async (workspaceId, sessionId, origin, patch, reconciliation, options) => {
    if (patch.meta?.composerDraft === 'older draft') {
      started();
      await gate;
    }
    return update(workspaceId, sessionId, origin, patch, reconciliation, options);
  });
  try {
    scheduleComposerDraftPersist('__default__', id, 'older draft');
    const flushing = flushComposerDraftPersist();
    await writing;
    scheduleComposerDraftPersist('__default__', id, latest);
    release();
    await flushing;
    await historyStore.flush();
    const key = `ultragamestudio.history.v1:workspaces/__default__/sessions/${id}.json`;
    expect(JSON.parse(localStorage.getItem(key)!).meta?.composerDraft).toBe(latest);
  } finally {
    release();
  }
});

it('does not block quit with a pending draft for a deleted session', async () => {
  await historyStore.ready();
  const id = 'draft-deleted-before-quit';
  const key = `ultragamestudio.history.v1:workspaces/__default__/sessions/${id}.json`;
  await historyStore.createSession({ workspaceId: '__default__', id, isWorkflow: false });
  scheduleComposerDraftPersist('__default__', id, 'draft for deleted session');
  await historyStore.deleteSession('__default__', id, false);

  await expect(flushComposerDraftPersist()).resolves.toBeUndefined();
  await expect(historyStore.flush()).resolves.toBeUndefined();
  expect(localStorage.getItem(key)).toBeNull();
  await expect(flushComposerDraftPersist()).resolves.toBeUndefined();
});

it('retires a draft whose workspace was deleted while the draft was pending', async () => {
  await historyStore.ready();
  const workspace = await historyStore.resolveWorkspaceByPath('E:/fixture-draft-deleted-workspace');
  const id = 'draft-deleted-workspace';
  const key = `ultragamestudio.history.v1:workspaces/${workspace.id}/sessions/${id}.json`;
  await historyStore.createSession({ workspaceId: workspace.id, id, isWorkflow: false });
  scheduleComposerDraftPersist(workspace.id, id, 'deleted workspace draft');
  await historyStore.deleteWorkspace(workspace.id, false);
  await expect(flushComposerDraftPersist()).resolves.toBeUndefined();
  await expect(historyStore.flush()).resolves.toBeUndefined();
  expect(localStorage.getItem(key)).toBeNull();
});

it('does not write an old draft into a same-clock replacement before quit', async () => {
  await historyStore.ready();
  vi.spyOn(Date, 'now').mockReturnValue(1234);
  const id = 'draft-replaced-before-quit';
  const key = `ultragamestudio.history.v1:workspaces/__default__/sessions/${id}.json`;
  await historyStore.createSession({ workspaceId: '__default__', id, isWorkflow: false });
  scheduleComposerDraftPersist('__default__', id, 'old incarnation draft');
  await historyStore.deleteSession('__default__', id, false);
  await historyStore.createSession({ workspaceId: '__default__', id, isWorkflow: false, meta: { composerDraft: 'replacement draft' } });
  const before = localStorage.getItem(key);
  await flushComposerDraftPersist();
  expect(localStorage.getItem(key)).toBe(before);
});

it('validates draft incarnation atomically after a paused queued admission', async () => {
  await historyStore.ready();
  vi.spyOn(Date, 'now').mockReturnValue(1234);
  const id = 'draft-replaced-at-admission';
  const key = `ultragamestudio.history.v1:workspaces/__default__/sessions/${id}.json`;
  await historyStore.createSession({ workspaceId: '__default__', id, isWorkflow: false });
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const update = historyStore.updateSessionIfGeneration.bind(historyStore);
  vi.spyOn(historyStore, 'updateSessionIfGeneration').mockImplementation(async (...args) => {
    started();
    await gate;
    return update(...args);
  });
  scheduleComposerDraftPersist('__default__', id, 'old queued draft');
  const flushing = flushComposerDraftPersist();
  try {
    await entered;
    await historyStore.deleteSession('__default__', id, false);
    await historyStore.createSession({ workspaceId: '__default__', id, isWorkflow: false, meta: { composerDraft: 'replacement draft' } });
    const before = localStorage.getItem(key);
    release();
    await flushing;
    expect(localStorage.getItem(key)).toBe(before);
  } finally {
    release();
    await Promise.allSettled([flushing]);
  }
});

it.each(['{broken', 'null', '{}', '[]', '42'])('retains the exact draft when backing bytes are invalid: %s', async (invalid) => {
  await historyStore.ready();
  const id = `draft-invalid-${invalid.length}-${invalid}`;
  const key = `ultragamestudio.history.v1:workspaces/__default__/sessions/${id}.json`;
  await historyStore.createSession({ workspaceId: '__default__', id, isWorkflow: false });
  scheduleComposerDraftPersist('__default__', id, 'exact draft after read recovery');
  await historyStore.getSessionForGeneration('__default__', id);
  const before = localStorage.getItem(key)!;
  localStorage.setItem(key, invalid);
  await expect(flushComposerDraftPersist()).rejects.toThrow();
  expect(localStorage.getItem(key)).toBe(invalid);
  await historyStore.flush().catch(() => {});
  localStorage.setItem(key, before);
  await flushComposerDraftPersist();
  expect(JSON.parse(localStorage.getItem(key)!).meta.composerDraft).toBe('exact draft after read recovery');
});

it('retains an unknown initial origin without rebinding it after backing recovery', async () => {
  await historyStore.ready();
  const id = 'draft-origin-read-failed';
  const key = `ultragamestudio.history.v1:workspaces/__default__/sessions/${id}.json`;
  await historyStore.createSession({ workspaceId: '__default__', id, isWorkflow: false });
  const reader = vi.spyOn(historyStore, 'getSessionForGeneration').mockRejectedValueOnce(new Error('draft origin read failed'));
  scheduleComposerDraftPersist('__default__', id, 'unknown-origin draft');
  await expect(flushComposerDraftPersist()).rejects.toThrow('draft origin read failed');
  const before = localStorage.getItem(key);
  scheduleComposerDraftPersist('__default__', id, 'newer unknown-origin draft');
  await expect(flushComposerDraftPersist()).rejects.toThrow('draft origin read failed');
  expect(reader).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem(key)).toBe(before);
});

it('keeps initial absence fixed even if the id is subsequently created', async () => {
  await historyStore.ready();
  const id = 'draft-initially-absent';
  const key = `ultragamestudio.history.v1:workspaces/__default__/sessions/${id}.json`;
  scheduleComposerDraftPersist('__default__', id, 'unbound old draft');
  await historyStore.createSession({ workspaceId: '__default__', id, isWorkflow: false, meta: { composerDraft: 'new session draft' } });
  const before = localStorage.getItem(key);
  await flushComposerDraftPersist();
  expect(localStorage.getItem(key)).toBe(before);
});

it('cannot resurrect a maintenance-retired record behind a hydrated cache', async () => {
  await historyStore.ready();
  const id = 'draft-retired-behind-cache';
  const key = `ultragamestudio.history.v1:workspaces/__default__/sessions/${id}.json`;
  await historyStore.createSession({ workspaceId: '__default__', id, isWorkflow: false });
  // Leave the store cache populated, as a native maintenance sweep can do.
  localStorage.removeItem(key);
  scheduleComposerDraftPersist('__default__', id, 'retired cached draft');
  await expect(flushComposerDraftPersist()).resolves.toBeUndefined();
  await expect(historyStore.flush()).resolves.toBeUndefined();
  expect(localStorage.getItem(key)).toBeNull();
});

it('keeps a draft retryable when backing storage access fails after origin capture', async () => {
  await historyStore.ready();
  const id = 'draft-storage-access';
  const key = `ultragamestudio.history.v1:workspaces/__default__/sessions/${id}.json`;
  await historyStore.createSession({ workspaceId: '__default__', id, isWorkflow: false });
  scheduleComposerDraftPersist('__default__', id, 'exact draft after storage access recovers');
  const access = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new Error('storage denied'); });
  try {
    await expect(flushComposerDraftPersist()).rejects.toThrow('HISTORY_STORAGE_UNAVAILABLE');
    await historyStore.flush().catch(() => {});
  } finally {
    access.mockRestore();
  }
  await flushComposerDraftPersist();
  expect(JSON.parse(localStorage.getItem(key)!).meta.composerDraft).toBe('exact draft after storage access recovers');
});
