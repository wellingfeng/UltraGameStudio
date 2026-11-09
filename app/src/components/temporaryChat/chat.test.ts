import { describe, expect, it, vi } from 'vitest';
import { TemporaryChat, handleChatAction, type ChatEvent, type ChatPort, type ChatRequest } from './chat';
import { ChatSessions } from './sessions';

function fixture() {
  const requests: ChatRequest[] = [];
  const callbacks: ((event: ChatEvent) => void)[] = [];
  const port: ChatPort = {
    models: async () => [{ providerId: 'test', model: 'gemini-test', label: '测试渠道' }],
    start: vi.fn(async (r, cb) => { requests.push(r); callbacks.push(cb); }),
    cancel: vi.fn(async () => {}),
  };
  const changed = vi.fn();
  return { chat: new TemporaryChat(changed, port), port, requests, callbacks, changed };
}
describe('isolated temporary chat', () => {
  it('streams and carries only this panel’s successful text history', async () => {
    const a = fixture(); const b = fixture(); await a.chat.refresh(); await b.chat.refresh();
    a.chat.send('记住：海鸥'); a.callbacks[0]({ type: 'delta', text: '已记' }); a.callbacks[0]({ type: 'delta', text: '住' }); a.callbacks[0]({ type: 'done' });
    expect(a.chat.state.turns[0].assistant).toBe('已记住');
    a.chat.send('刚才是什么？');
    expect(a.requests[1].messages).toEqual([{ role: 'user', content: '记住：海鸥' }, { role: 'assistant', content: '已记住' }, { role: 'user', content: '刚才是什么？' }]);
    b.chat.send('你好'); expect(b.requests[0].messages).toEqual([{ role: 'user', content: '你好' }]);
    expect(Object.keys(a.requests[0]).sort()).toEqual(['messages', 'model', 'providerId', 'requestId']);
  });
  it('cancels close/stop even when IPC admission resolves late; discards late deltas', async () => {
    const f = fixture(); let admitted!: () => void;
    f.port.start = async (r, cb) => { f.requests.push(r); f.callbacks.push(cb); await new Promise<void>(resolve => { admitted = resolve; }); };
    await f.chat.refresh(); f.chat.send('长回答'); f.chat.stop(); f.callbacks[0]({ type: 'delta', text: '迟到的文本' });
    expect(f.chat.state.turns[0].assistant).toBe(''); expect(f.port.cancel).not.toHaveBeenCalled();
    admitted(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.port.cancel).toHaveBeenCalledWith(f.requests[0].requestId);
    f.chat.dispose(); expect(f.chat.state.turns[0].status).toBe('stopped');
  });
  it('retries errors without duplicating the user turn and rejects unsupported bridge actions', async () => {
    const f = fixture(); await f.chat.refresh();
    handleChatAction(f.chat, { scope: 'ugs-temporary-chat', type: 'invoke', command: 'write_file' });
    handleChatAction(f.chat, { scope: 'wrong', type: 'send', text: '不能发送' });
    handleChatAction(f.chat, { scope: 'ugs-temporary-chat', type: 'send', text: {} });
    expect(f.requests).toHaveLength(0);
    f.chat.send('你好'); f.chat.send('重复点击'); expect(f.requests).toHaveLength(1);
    f.callbacks[0]({ type: 'error', message: 'HTTP 429' }); f.chat.retry();
    expect(f.chat.state.turns).toHaveLength(1); expect(f.requests[1].messages).toEqual(f.requests[0].messages);
  });
  it('shares the loaded snapshot on every request and allows removing it', async () => {
    const f = fixture();
    const chat = new TemporaryChat(f.changed, f.port, { label: '文件', load: async () => ({ label: '测试.png', text: '文件内容', image: { mime: 'image/jpeg', base64: 'YWJj' } }) });
    await chat.refresh(); await Promise.resolve();
    expect(chat.state.reference).toMatchObject({ label: '测试.png', status: 'ready' });
    chat.send('这是什么');
    expect(f.requests[0].context).toEqual({ text: '文件内容', image: { mime: 'image/jpeg', base64: 'YWJj' } });
    f.callbacks[0]({ type: 'delta', text: '图片' }); f.callbacks[0]({ type: 'done' });
    chat.send('继续'); expect(f.requests[1].context).toEqual(f.requests[0].context);
    f.callbacks[1]({ type: 'done' }); chat.removeContext(); chat.send('不引用');
    expect(f.requests[2].context).toBeUndefined();
  });
  it('does not send while a reference fails or after it was removed during loading', async () => {
    const f = fixture(); let resolve!: (value: { label: string; text: string }) => void;
    const chat = new TemporaryChat(f.changed, f.port, { label: '网页', load: () => new Promise(r => { resolve = r; }) });
    await chat.refresh(); chat.send('问题'); expect(f.requests).toHaveLength(0);
    chat.removeContext(); resolve({ label: '旧网页', text: '旧内容' }); await Promise.resolve();
    chat.send('问题'); expect(f.requests[0].context).toBeUndefined();
    const failed = new TemporaryChat(f.changed, f.port, { label: '文件', load: async () => { throw new Error('读取失败'); } });
    await failed.refresh(); await Promise.resolve(); failed.send('问题');
    expect(failed.state.reference).toMatchObject({ status: 'error', note: '读取失败' });
    expect(f.requests).toHaveLength(1);
  });
  it('keeps multiple sessions isolated while replies finish after switching', async () => {
    const f = fixture(); await f.chat.refresh();
    f.chat.send('第一条');
    const first = f.chat.state.sessionId;
    f.chat.newSession();
    const second = f.chat.state.sessionId;
    f.chat.send('第二条');
    f.callbacks[0]({ type: 'delta', text: '第一答' }); f.callbacks[0]({ type: 'done' });
    expect(f.chat.state.turns[0].user).toBe('第二条');
    f.callbacks[1]({ type: 'delta', text: '第二答' }); f.callbacks[1]({ type: 'done' });
    f.chat.selectSession(first);
    expect(f.chat.state.turns[0]).toMatchObject({ user: '第一条', assistant: '第一答', status: 'done' });
    f.chat.send('追问');
    expect(f.requests[2].messages).toEqual([{ role: 'user', content: '第一条' }, { role: 'assistant', content: '第一答' }, { role: 'user', content: '追问' }]);
    f.callbacks[2]({ type: 'done' });
    f.chat.deleteSession(second);
    expect(f.chat.state.sessions.map(s => s.id)).toEqual([first]);
  });
  it('shares one source across windows, separates other sources, and restores saved turns', async () => {
    const f = fixture();
    const key = `file-a-${crypto.randomUUID()}`;
    const a = { key, label: '文件 A', load: async () => ({ label: '文件 A', text: '仅引用，不存储' }) };
    const b = { key: `${key}-other`, label: '文件 B', load: async () => ({ label: '文件 B', text: '文件 B 内容' }) };
    const one = new TemporaryChat(f.changed, f.port, a);
    const otherWindow = new TemporaryChat(f.changed, f.port, a);
    await one.refresh(); await otherWindow.refresh(); await Promise.resolve();
    one.send('文件 A 问题'); f.callbacks[0]({ type: 'delta', text: '文件 A 回答' }); f.callbacks[0]({ type: 'done' });
    expect(otherWindow.state.turns[0].assistant).toBe('文件 A 回答');
    one.newSession(); one.send('新会话问题'); f.callbacks[1]({ type: 'done' });
    one.setSource(b); await Promise.resolve();
    expect(one.state.sessions).toHaveLength(1); expect(one.state.turns).toEqual([]);
    one.send('文件 B 问题'); f.callbacks[2]({ type: 'done' });
    one.setSource(a); await Promise.resolve();
    expect(one.state.sessions).toHaveLength(2);
    const restored = new ChatSessions(key);
    expect(restored.sessions.flatMap(s => s.turns.map(t => t.user))).toEqual(expect.arrayContaining(['文件 A 问题', '新会话问题']));
    expect(JSON.stringify(restored.sessions)).not.toContain('仅引用，不存储');
    one.dispose(); otherWindow.dispose();
  });
  it('protects unreadable stored history and reports write failures', () => {
    const key = `invalid-${crypto.randomUUID()}`;
    const storageKey = `ultragamestudio.temporaryChat.sessions.v1:${encodeURIComponent(key)}`;
    localStorage.setItem(storageKey, '{');
    const group = new ChatSessions(key); group.create();
    expect(group.storageError).toContain('停止写入');
    expect(localStorage.getItem(storageKey)).toBe('{');
    localStorage.removeItem(storageKey);
    const quota = new ChatSessions(`quota-${crypto.randomUUID()}`);
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    quota.create();
    expect(quota.storageError).toContain('保存失败');
    write.mockRestore();
  });
});
