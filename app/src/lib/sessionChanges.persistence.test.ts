import { beforeEach, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ read: vi.fn(), list: vi.fn(), invoke: vi.fn() }));
vi.mock('./tauri', () => ({
  tauriAvailable: () => true,
  ensureWorkspaceChangesBaseline: vi.fn(),
  listWorkspaceChanges: native.list,
  readWorkspaceChangesCache: native.read,
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));

import { prunePersistedSessionChangesCache, readPersistedSessionChanges, refreshCachedSessionChanges } from './sessionChanges';

const prefix = 'ultragamestudio.sessionChanges.v5:';
const snapshot = (time: number) => ({ rootPath: 'E:/project', generatedAtMs: time, source: 'snapshot', files: [], truncated: false });

beforeEach(() => {
  localStorage.clear();
  native.list.mockReset();
  native.read.mockReset();
  const files = new Map<string, string>();
  native.invoke.mockReset();
  native.invoke.mockImplementation(async (command: string, args: { relPath: string; json?: string }) => {
    if (command === 'history_read_json') return files.get(args.relPath) ?? null;
    if (command === 'history_write_json') { files.set(args.relPath, args.json!); return; }
    throw new Error('unexpected command');
  });
});

it('桌面刷新只更新内存和已有磁盘缓存，不占用浏览器配额', async () => {
  native.list.mockResolvedValue(snapshot(3));
  const write = vi.spyOn(Storage.prototype, 'setItem');
  await refreshCachedSessionChanges('E:/project', 'new-key');
  expect(write).not.toHaveBeenCalled();
  write.mockRestore();
});

it('先归档回读核验，保留损坏、归档失败或清理过程中变化的旧缓存', async () => {
  localStorage.setItem(prefix + 'same', JSON.stringify(snapshot(1)));
  localStorage.setItem(prefix + 'different', JSON.stringify(snapshot(2)));
  localStorage.setItem(prefix + 'missing', JSON.stringify(snapshot(3)));
  localStorage.setItem(prefix + 'bad', '{');
  localStorage.setItem(prefix + 'changed', JSON.stringify(snapshot(4)));
  localStorage.setItem(prefix + 'write-failed', JSON.stringify(snapshot(7)));
  native.read.mockImplementation(async (_root: string, key: string) => {
    if (key === 'same') return snapshot(1);
    if (key === 'different') return snapshot(5);
    if (key === 'changed') { localStorage.setItem(prefix + 'changed', JSON.stringify(snapshot(6))); return snapshot(4); }
    return null;
  });
  const write = native.invoke.getMockImplementation()!;
  native.invoke.mockImplementation(async (command: string, args: { relPath: string; json?: string }) => {
    if (command === 'history_write_json' && args.json?.includes('"generatedAtMs":7')) throw new Error('写入失败');
    return write(command, args);
  });
  Object.defineProperty(crypto, 'subtle', { configurable: true, value: (await import('node:crypto')).webcrypto.subtle });
  await prunePersistedSessionChangesCache();
  expect(localStorage.getItem(prefix + 'same')).toBeNull();
  expect(localStorage.getItem(prefix + 'different')).toBeNull();
  expect(localStorage.getItem(prefix + 'missing')).toBeNull();
  expect(localStorage.getItem(prefix + 'bad')).toBe('{');
  expect(JSON.parse(localStorage.getItem(prefix + 'changed')!).generatedAtMs).toBe(6);
  expect(localStorage.getItem(prefix + 'write-failed')).not.toBeNull();
  native.read.mockResolvedValue(null);
  expect((await readPersistedSessionChanges('E:/project', 'missing'))?.generatedAtMs).toBe(3);
  native.read.mockResolvedValue(snapshot(9));
  expect((await readPersistedSessionChanges('E:/project', 'different'))?.generatedAtMs).toBe(9);
});
