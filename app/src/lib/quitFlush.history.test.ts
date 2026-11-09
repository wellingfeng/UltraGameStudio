import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  flushHistory: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  invoke: vi.fn(async (_name: string) => undefined),
  listen: vi.fn(async (_name: string, _callback: () => void) => () => {}),
}));
vi.mock('@/lib/tauri', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@/lib/secureStorage', () => ({ flushSecureStorage: async () => {}, flushSecretsToLocalStorageFallback: () => {} }));
vi.mock('@/lib/generationSettingsStore', () => ({ flushGenerationSettings: async () => {} }));
vi.mock('@/lib/settingsProfile', () => ({ flushRemoteProfileWrites: async () => {} }));
vi.mock('@/lib/apiConfig', () => ({ flushApiConfigDiskWrites: async () => {} }));
vi.mock('@/lib/gatewayConfig', () => ({ flushGatewayConfigDiskWrites: async () => {} }));
vi.mock('@/lib/composerStorage', () => ({ flushPersonalInstructionsDiskWrites: async () => {} }));
vi.mock('@/lib/downloadRegistry', () => ({ flushAssetIndex: async () => {} }));
vi.mock('@/store/composerDraftPersistence', () => ({ flushComposerDraftPersist: async () => {} }));
vi.mock('@/components/temporaryChat/sessions', () => ({ flushTemporaryChatSessions: async () => {} }));
vi.mock('@/store/channelRegistry', () => ({ activeRunChannels: () => [], activeAiEditChannels: () => [] }));
vi.mock('@/store/useStore', () => ({ flushChatPersistenceForQuit: mocks.flushHistory }));

import { installQuitFlushHandler, resetQuitFlushForTests } from './quitFlush';

beforeEach(() => {
  resetQuitFlushForTests();
  vi.clearAllMocks();
  mocks.flushHistory.mockResolvedValue(undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

it('tray quit waits for producer finalization and durable history before notifying the host', async () => {
  let finish!: () => void;
  mocks.flushHistory.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  await installQuitFlushHandler();
  mocks.listen.mock.calls.find(([name]) => name === 'ugs:before-quit')![1]();
  await vi.waitFor(() => expect(mocks.flushHistory).toHaveBeenCalledOnce());
  expect(mocks.invoke).not.toHaveBeenCalledWith('ugs_quit_flush_done');
  finish();
  await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('ugs_quit_flush_done'));
});

it('failed durable history cancels quit instead of swallowing the write failure', async () => {
  mocks.flushHistory.mockRejectedValueOnce(new Error('history fixture write failed'));
  const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await installQuitFlushHandler();
  mocks.listen.mock.calls.find(([name]) => name === 'ugs:before-quit')![1]();
  await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('ugs_quit_cancel'));
  expect(mocks.invoke).not.toHaveBeenCalledWith('ugs_quit_flush_done');
  expect(alert).toHaveBeenCalledWith(expect.stringContaining('history fixture write failed'));
});
