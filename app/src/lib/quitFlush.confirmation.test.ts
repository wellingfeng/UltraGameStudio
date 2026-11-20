import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  confirm: vi.fn<() => Promise<boolean>>(),
  invoke: vi.fn(async (_name: string) => undefined),
  listen: vi.fn(async (_name: string, _callback: () => void) => () => {}),
  flushSecureStorage: vi.fn(async () => undefined),
  flushHistory: vi.fn(async () => undefined),
  running: true,
}));

vi.mock('@/lib/tauri', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: mocks.confirm }));
vi.mock('@/lib/secureStorage', () => ({ flushSecureStorage: mocks.flushSecureStorage, flushSecretsToLocalStorageFallback: () => {} }));
vi.mock('@/lib/generationSettingsStore', () => ({ flushGenerationSettings: async () => {} }));
vi.mock('@/lib/settingsProfile', () => ({ flushRemoteProfileWrites: async () => {} }));
vi.mock('@/lib/apiConfig', () => ({ flushApiConfigDiskWrites: async () => {} }));
vi.mock('@/lib/gatewayConfig', () => ({ flushGatewayConfigDiskWrites: async () => {} }));
vi.mock('@/lib/composerStorage', () => ({ flushPersonalInstructionsDiskWrites: async () => {} }));
vi.mock('@/lib/downloadRegistry', () => ({ flushAssetIndex: async () => {} }));
vi.mock('@/store/composerDraftPersistence', () => ({ flushComposerDraftPersist: async () => {} }));
vi.mock('@/components/temporaryChat/sessions', () => ({ flushTemporaryChatSessions: async () => {} }));
vi.mock('@/store/channelRegistry', () => ({ activeRunChannels: () => mocks.running ? [{}] : [], activeAiEditChannels: () => [] }));
vi.mock('@/store/useStore', () => ({ flushChatPersistenceForQuit: mocks.flushHistory }));

import { installQuitFlushHandler, resetQuitFlushForTests } from './quitFlush';

function triggerQuit(): void {
  mocks.listen.mock.calls.find(([name]) => name === 'ugs:before-quit')![1]();
}

beforeEach(() => {
  vi.clearAllMocks();
  resetQuitFlushForTests();
  mocks.running = true;
  mocks.confirm.mockResolvedValue(false);
});

it('restores the hidden main window and waits for confirmation; repeated requests share one attempt', async () => {
  let decide!: (ok: boolean) => void;
  mocks.confirm.mockImplementation(() => new Promise(resolve => { decide = resolve; }));
  await installQuitFlushHandler();
  triggerQuit();
  await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());
  expect(mocks.invoke).toHaveBeenCalledWith('focus_main_window');
  expect(mocks.invoke.mock.invocationCallOrder[0]).toBeLessThan(mocks.confirm.mock.invocationCallOrder[0]);
  triggerQuit();
  await Promise.resolve();
  expect(mocks.confirm).toHaveBeenCalledOnce();
  expect(mocks.flushSecureStorage).not.toHaveBeenCalled();
  expect(mocks.invoke).not.toHaveBeenCalledWith('ugs_quit_flush_done');
  decide(false);
  await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('ugs_quit_cancel'));
  expect(mocks.invoke).not.toHaveBeenCalledWith('ugs_quit_flush_done');
});

it('only flushes and exits after the running-session confirmation is accepted', async () => {
  mocks.confirm.mockResolvedValue(true);
  await installQuitFlushHandler();
  triggerQuit();
  await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('ugs_quit_flush_done'));
  expect(mocks.confirm).toHaveBeenCalledOnce();
  expect(mocks.flushHistory).toHaveBeenCalledOnce();
});

it('cancels quit instead of interrupting active sessions when the confirmation fails', async () => {
  mocks.confirm.mockRejectedValue(new Error('dialog unavailable'));
  const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await installQuitFlushHandler();
    triggerQuit();
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('ugs_quit_cancel'));
    expect(alert).toHaveBeenCalledWith(expect.stringContaining('dialog unavailable'));
    expect(mocks.invoke).not.toHaveBeenCalledWith('ugs_quit_flush_done');
    expect(mocks.flushSecureStorage).not.toHaveBeenCalled();
  } finally {
    alert.mockRestore();
    error.mockRestore();
  }
});
