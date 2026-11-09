import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@/lib/tauri', () => ({ tauriAvailable: () => true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke, Channel: class {} }));

import { TemporaryChat, type ChatEvent, type ChatPort } from './chat';
import { ChatSessions, chatSessions } from './sessions';

const prefix = 'ultragamestudio.temporaryChat.sessions.v1:';
let files: Map<string, string>;

beforeEach(() => {
  localStorage.clear();
  files = new Map();
  Object.defineProperty(crypto, 'subtle', { configurable: true, value: webcrypto.subtle });
  native.invoke.mockReset();
  native.invoke.mockImplementation(async (command: string, args: { relPath: string; json?: string }) => {
    if (command === 'history_read_json') return files.get(args.relPath) ?? null;
    if (command === 'history_write_json') { files.set(args.relPath, args.json!); return; }
    throw new Error(`unexpected command: ${command}`);
  });
});
afterEach(() => vi.restoreAllMocks());

describe('随手聊桌面历史', () => {
  it('浏览器配额满时仍能保存回答，并从磁盘恢复', async () => {
    const key = `quota-${crypto.randomUUID()}`;
    let receive!: (event: ChatEvent) => void;
    const port: ChatPort = {
      models: async () => [{ providerId: 'p', model: 'm', label: '测试' }],
      start: async (_request, callback) => { receive = callback; },
      cancel: async () => {},
    };
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError'); });
    const chat = new TemporaryChat(() => {}, port, { key, label: '文件', load: async () => ({ label: '文件', text: '引用内容不保存' }) });
    const group = chatSessions(key);
    await group.ready;
    await chat.refresh();
    await Promise.resolve();
    chat.send('问题'); receive({ type: 'delta', text: '回答' }); receive({ type: 'done' });
    await group.flush();
    expect(chat.state.storageError).toBe('');
    expect([...files.keys()]).toEqual([expect.stringMatching(/^temporary-chat\/[a-f0-9]{64}\.json$/)]);
    expect([...files.values()][0]).not.toContain('引用内容不保存');
    const restored = new ChatSessions(key);
    await restored.ready;
    expect(restored.sessions[0].turns).toMatchObject([{ user: '问题', assistant: '回答', status: 'done' }]);
    chat.dispose();
  });

  it('迁移旧历史成功后再删除旧副本；失败时保留并可重试', async () => {
    const key = `legacy-${crypto.randomUUID()}`;
    const storageKey = prefix + encodeURIComponent(key);
    localStorage.setItem(storageKey, JSON.stringify({ selectedId: 's', sessions: [{ id: 's', title: '旧对话', updatedAt: 1, turns: [{ user: '旧问题', assistant: '旧回答', status: 'done' }] }] }));
    let fail = true;
    native.invoke.mockImplementation(async (command: string, args: { relPath: string; json?: string }) => {
      if (command === 'history_read_json') return files.get(args.relPath) ?? null;
      if (fail) throw new Error('磁盘写入失败');
      files.set(args.relPath, args.json!);
    });
    const group = new ChatSessions(key);
    await group.ready;
    expect(group.sessions[0].turns[0].assistant).toBe('旧回答');
    expect(group.storageError).toContain('磁盘写入失败');
    expect(localStorage.getItem(storageKey)).not.toBeNull();
    fail = false;
    group.notify(true);
    await group.flush();
    expect(group.storageError).toBe('');
    expect(localStorage.getItem(storageKey)).toBeNull();
    expect([...files.values()][0]).toContain('旧回答');
  });

  it('历史加载期间禁止改写；加载或解析失败时保护原数据', async () => {
    let release!: (value: string) => void;
    native.invoke.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const group = new ChatSessions(`slow-${crypto.randomUUID()}`);
    expect(group.loading).toBe(true);
    const initial = group.selectedId;
    group.create();
    expect(group.selectedId).toBe(initial);
    await vi.waitFor(() => expect(release).toBeDefined());
    release(JSON.stringify({ selectedId: 'old', sessions: [{ id: 'old', title: '旧记录', updatedAt: 1, turns: [] }] }));
    await group.ready;
    expect(group.selectedId).toBe('old');
    expect(group.sessions).toHaveLength(1);

    native.invoke.mockImplementationOnce(async () => '{');
    const corrupt = new ChatSessions(`corrupt-${crypto.randomUUID()}`);
    await corrupt.ready;
    corrupt.create();
    await corrupt.flush();
    expect(corrupt.storageError).toContain('停止写入');
    expect(files.size).toBe(0);
  });

  it('按顺序写入，旧快照不能覆盖新快照', async () => {
    const group = new ChatSessions(`order-${crypto.randomUUID()}`);
    await group.ready;
    let release!: () => void;
    native.invoke.mockImplementationOnce(async (_command: string, args: { relPath: string; json: string }) => {
      await new Promise<void>(resolve => { release = resolve; });
      files.set(args.relPath, args.json);
    });
    group.create();
    await vi.waitFor(() => expect(release).toBeDefined());
    group.create();
    release();
    await group.flush();
    expect(JSON.parse([...files.values()][0]).sessions).toHaveLength(3);
  });

  it('滚动位置随各会话保存到磁盘，立即退出前也会刷新待保存位置', async () => {
    const key = `scroll-${crypto.randomUUID()}`;
    const group = new ChatSessions(key);
    await group.ready;
    const firstId = group.selectedId;
    group.setScrollPosition(firstId, 237);
    const secondId = group.create();
    group.setScrollPosition(secondId, 518);
    group.setScrollPosition(secondId, NaN);
    group.setScrollPosition(secondId, -1);
    expect(group.hasUnsavedChanges()).toBe(true);
    await group.flush();
    expect(group.hasUnsavedChanges()).toBe(false);

    const restored = new ChatSessions(key);
    await restored.ready;
    expect(restored.sessions.find(session => session.id === firstId)?.scrollTop).toBe(237);
    expect(restored.sessions.find(session => session.id === secondId)?.scrollTop).toBe(518);
  });
});
