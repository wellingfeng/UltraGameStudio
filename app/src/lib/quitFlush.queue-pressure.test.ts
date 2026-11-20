import { afterEach, expect, it, vi } from 'vitest';
import { historyStore } from '@/store/history/store';
import * as serialization from '@/store/history/serialization';
import { flushComposerDraftsOnQuit, resetComposerDraftPersistForTests, scheduleComposerDraftPersist } from '@/store/composerDraftPersistence';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(name: string) => Promise<void>>().mockResolvedValue(undefined),
  listen: vi.fn<(name: string, handler: () => void) => Promise<() => void>>().mockResolvedValue(() => {}),
}));
vi.mock('@/lib/tauri', async (original) => ({ ...(await original()), isTauri: () => true, tauriAvailable: () => false }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@/lib/secureStorage', async (original) => ({ ...(await original()), flushSecureStorage: async () => {}, flushSecretsToLocalStorageFallback: () => {} }));
vi.mock('@/lib/generationSettingsStore', async (original) => ({ ...(await original()), flushGenerationSettings: async () => {} }));
vi.mock('@/lib/settingsProfile', async (original) => ({ ...(await original()), flushRemoteProfileWrites: async () => {} }));
vi.mock('@/lib/apiConfig', async (original) => ({ ...(await original()), flushApiConfigDiskWrites: async () => {} }));
vi.mock('@/lib/gatewayConfig', async (original) => ({ ...(await original()), flushGatewayConfigDiskWrites: async () => {} }));
vi.mock('@/lib/composerStorage', async (original) => ({ ...(await original()), flushPersonalInstructionsDiskWrites: async () => {} }));
vi.mock('@/lib/downloadRegistry', async (original) => ({ ...(await original()), flushAssetIndex: async () => {} }));
vi.mock('@/components/temporaryChat/sessions', async (original) => ({ ...(await original()), flushTemporaryChatSessions: async () => {} }));

import { installQuitFlushHandler, registerQuitFlushTask, resetQuitFlushForTests } from './quitFlush';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

afterEach(async () => {
  vi.restoreAllMocks();
  resetComposerDraftPersistForTests();
  resetQuitFlushForTests();
  await historyStore.flush().catch(() => {});
});

it('tray quit waits for queue capacity and durably saves the pending draft before notifying the host', async () => {
  resetQuitFlushForTests();
  resetComposerDraftPersistForTests();
  vi.clearAllMocks();
  // Warm the real dynamic quit producer before holding the queue; module
  // transformation is not part of the pressure condition being tested.
  await import('@/store/useStore');
  await historyStore.ready();
  const id = 'quit-pressure-draft';
  await historyStore.createSession({ workspaceId: '__default__', id, isWorkflow: false, messages: [] });
  const path = `workspaces/__default__/sessions/${id}.json`;
  const started = deferred(), release = deferred();
  const serialize = serialization.serializeHistory;
  let held = false;
  vi.spyOn(serialization, 'serializeHistory').mockImplementation(async (value, options) => {
    if (!held && options?.relPath === path) {
      held = true;
      started.resolve();
      await release.promise;
    }
    return serialize(value, options);
  });
  const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const queued: Promise<unknown>[] = [];
  try {
    queued.push(historyStore.updateSession('__default__', id, { meta: { favorite: true } }));
    await started.promise;
    for (let i = 0; i < 127; i += 1) {
      queued.push(historyStore.updateSession('__default__', id, { meta: { favorite: i % 2 === 0 } }));
    }
    scheduleComposerDraftPersist('__default__', id, 'unsubmitted draft must survive');
    await installQuitFlushHandler();
    const quit = mocks.listen.mock.calls.find(([name]) => name === 'ugs:before-quit')![1];
    quit();
    // Give the async quit listener an event-loop turn while the real queue is full.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(mocks.invoke).not.toHaveBeenCalledWith('ugs_quit_flush_done');
    release.resolve();
    await Promise.all(queued);
    await vi.waitFor(() => expect(mocks.invoke.mock.calls.some(([name]) => name === 'ugs_quit_flush_done' || name === 'ugs_quit_cancel')).toBe(true));
    expect(mocks.invoke).toHaveBeenCalledWith('ugs_quit_flush_done');
    expect(mocks.invoke).not.toHaveBeenCalledWith('ugs_quit_cancel');
    expect(alert).not.toHaveBeenCalled();
    const saved = JSON.parse(localStorage.getItem(`ultragamestudio.history.v1:${path}`)!);
    expect(saved.meta?.composerDraft).toBe('unsubmitted draft must survive');
  } finally {
    release.resolve();
    await Promise.allSettled(queued);
    error.mockRestore();
    alert.mockRestore();
  }
});

it('a failed draft blocks quit and the next explicit attempt persists it after storage recovers', async () => {
  resetQuitFlushForTests();
  resetComposerDraftPersistForTests();
  vi.clearAllMocks();
  await import('@/store/useStore');
  await historyStore.ready();
  const id = 'quit-draft-retry';
  await historyStore.createSession({ workspaceId: '__default__', id, isWorkflow: false, messages: [] });
  const key = `ultragamestudio.history.v1:workspaces/__default__/sessions/${id}.json`;
  const original = Storage.prototype.setItem;
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, name, value) {
    if (name === key) throw new Error('fixture draft storage unavailable');
    original.call(this, name, value);
  });
  const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    scheduleComposerDraftPersist('__default__', id, 'retry this exact draft');
    registerQuitFlushTask(flushComposerDraftsOnQuit);
    await installQuitFlushHandler();
    const quit = mocks.listen.mock.calls.find(([name]) => name === 'ugs:before-quit')![1];
    quit();
    await vi.waitFor(() => expect(alert).toHaveBeenCalledWith(expect.stringContaining('fixture draft storage unavailable')));
    expect(mocks.invoke).toHaveBeenCalledWith('ugs_quit_cancel');
    expect(mocks.invoke).not.toHaveBeenCalledWith('ugs_quit_flush_done');
    expect(JSON.parse(localStorage.getItem(key)!).meta?.composerDraft).toBeUndefined();
    write.mockRestore();
    await Promise.resolve();
    quit();
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('ugs_quit_flush_done'));
    expect(JSON.parse(localStorage.getItem(key)!).meta?.composerDraft).toBe('retry this exact draft');
  } finally {
    write.mockRestore();
    error.mockRestore();
    alert.mockRestore();
  }
});

it('tray quit retires a deleted session draft and still saves the surviving session draft', async () => {
  resetQuitFlushForTests();
  resetComposerDraftPersistForTests();
  vi.clearAllMocks();
  await import('@/store/useStore');
  await historyStore.ready();
  const deleted = 'quit-deleted-draft', kept = 'quit-surviving-draft';
  for (const id of [deleted, kept]) {
    await historyStore.createSession({ workspaceId: '__default__', id, isWorkflow: false });
    scheduleComposerDraftPersist('__default__', id, `pending draft: ${id}`);
  }
  await historyStore.deleteSession('__default__', deleted, false);
  const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    registerQuitFlushTask(flushComposerDraftsOnQuit);
    await installQuitFlushHandler();
    mocks.listen.mock.calls.find(([name]) => name === 'ugs:before-quit')![1]();
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('ugs_quit_flush_done'));
    expect(mocks.invoke).not.toHaveBeenCalledWith('ugs_quit_cancel');
    expect(alert).not.toHaveBeenCalled();
    expect(localStorage.getItem(`ultragamestudio.history.v1:workspaces/__default__/sessions/${deleted}.json`)).toBeNull();
    const saved = JSON.parse(localStorage.getItem(`ultragamestudio.history.v1:workspaces/__default__/sessions/${kept}.json`)!);
    expect(saved.meta.composerDraft).toBe(`pending draft: ${kept}`);
  } finally {
    error.mockRestore();
    alert.mockRestore();
  }
});
