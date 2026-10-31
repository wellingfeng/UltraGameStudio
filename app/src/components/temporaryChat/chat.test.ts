import { describe, expect, it, vi } from 'vitest';
import { TemporaryChat, handleChatAction, type ChatEvent, type ChatPort, type ChatRequest } from './chat';

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
    f.chat.dispose(); expect(f.chat.state.turns).toEqual([]);
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
});
