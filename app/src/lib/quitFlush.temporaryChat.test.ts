import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  flush: vi.fn(),
  invoke: vi.fn(async () => undefined),
  listen: vi.fn(async (_name: string, _handler: () => void) => () => {}),
}));
vi.mock('@/components/temporaryChat/sessions', () => ({ flushTemporaryChatSessions: mocks.flush }));
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
vi.mock('@/store/channelRegistry', () => ({ activeRunChannels: () => [], activeAiEditChannels: () => [] }));

import { installQuitFlushHandler, resetQuitFlushForTests } from './quitFlush';

it('退出前等待随手聊落盘；落盘失败时取消退出', async () => {
  resetQuitFlushForTests();
  let reject!: (error: Error) => void;
  mocks.flush.mockImplementation(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await installQuitFlushHandler();
    const listener = mocks.listen.mock.calls.find(([name]) => name === 'ugs:before-quit')![1];
    listener();
    await vi.waitFor(() => expect(reject).toBeDefined());
    expect(mocks.invoke).not.toHaveBeenCalledWith('ugs_quit_flush_done');
    reject(new Error('随手聊历史尚未保存'));
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('ugs_quit_cancel'));
    expect(alert).toHaveBeenCalledWith(expect.stringContaining('随手聊历史尚未保存'));
    expect(mocks.invoke).not.toHaveBeenCalledWith('ugs_quit_flush_done');
  } finally { alert.mockRestore(); error.mockRestore(); }
});
