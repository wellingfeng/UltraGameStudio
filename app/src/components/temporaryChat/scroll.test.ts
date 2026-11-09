import { afterEach, expect, it, vi } from 'vitest';
import { TemporaryChat, handleChatAction, type ChatPort } from './chat';
import { temporaryChatDocument } from './document';
import { chatSessions } from './sessions';

const frames: HTMLIFrameElement[] = [];
const chats: TemporaryChat[] = [];
const port: ChatPort = { models: async () => [], start: async () => {}, cancel: async () => {} };
const source = (key: string) => ({ key, label: key, load: async () => undefined });
const turn = { user: '问题', assistant: '很长的回答', status: 'done' as const };

function open(key: string) {
  const html = temporaryChatDocument({ fileTab: true });
  const frame = document.createElement('iframe');
  frames.push(frame); document.body.append(frame);
  const doc = frame.contentWindow!.document;
  doc.open(); doc.write(html.slice(0, html.indexOf('<script nonce')) + '</body></html>'); doc.close();
  const main = doc.querySelector('main')!;
  let top = 0;
  let visible = true;
  Object.defineProperties(main, {
    clientHeight: { configurable: true, get: () => visible ? 300 : 0 },
    scrollHeight: { configurable: true, get: () => main.querySelector('.turn') ? 1800 : 300 },
    scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, main.scrollHeight - main.clientHeight)); } },
  });
  let receive: (event: { source: unknown; data: unknown }) => void = () => {};
  let chat: TemporaryChat;
  const parent = { postMessage: (action: unknown) => handleChatAction(chat, action) };
  const fakeWindow = { addEventListener: (type: string, listener: typeof receive) => { if (type === 'message') receive = listener; } };
  chat = new TemporaryChat(state => receive({ source: parent, data: { scope: 'ugs-temporary-chat', type: 'state', state } }), port, source(key));
  chats.push(chat);
  const script = html.slice(html.indexOf('>', html.indexOf('<script nonce')) + 1, html.lastIndexOf('</script>'));
  let resize: () => void = () => {};
  const Observer = class { constructor(callback: () => void) { resize = callback; } observe() {} };
  new Function('window', 'document', 'parent', 'setInterval', 'ResizeObserver', script)(fakeWindow, doc, parent, () => 0, Observer);
  const scroll = (position: number) => { main.scrollTop = position; main.dispatchEvent(new Event('scroll')); };
  const setVisible = (value: boolean) => { visible = value; resize(); };
  return { chat, frame, main, scroll, setVisible };
}

afterEach(() => { chats.splice(0).forEach(chat => chat.dispose()); frames.splice(0).forEach(frame => frame.remove()); vi.restoreAllMocks(); });

it('随手聊会话切换和页面重建后，各会话恢复自己的滚动位置', async () => {
  const key = `scroll-sessions-${crypto.randomUUID()}`;
  const group = chatSessions(key);
  await group.ready;
  group.sessions[0].turns = [turn]; group.notify();
  const firstId = group.selectedId;
  const view = open(key);
  view.scroll(235);
  view.chat.newSession();
  const secondId = view.chat.state.sessionId;
  group.sessions.find(session => session.id === secondId)!.turns = [turn]; group.notify();
  view.scroll(410);
  view.chat.selectSession(firstId);
  expect(view.main.scrollTop).toBe(235);
  view.chat.selectSession(secondId);
  expect(view.main.scrollTop).toBe(410);
  view.chat.dispose(); view.frame.remove();
  const reopened = open(key);
  expect(reopened.main.scrollTop).toBe(410);
});

it('切换聊天来源并返回后，恢复各来源的滚动位置', async () => {
  const firstKey = `scroll-source-a-${crypto.randomUUID()}`;
  const secondKey = `scroll-source-b-${crypto.randomUUID()}`;
  const first = chatSessions(firstKey); const second = chatSessions(secondKey);
  await Promise.all([first.ready, second.ready]);
  first.sessions[0].turns = [turn]; second.sessions[0].turns = [turn];
  const view = open(firstKey);
  view.scroll(180);
  view.chat.setSource(source(secondKey));
  view.scroll(520);
  view.chat.setSource(source(firstKey));
  expect(view.main.scrollTop).toBe(180);
  view.chat.setSource(source(secondKey));
  expect(view.main.scrollTop).toBe(520);
});

it('隐藏期间的重绘和零位置事件不会覆盖阅读位置，显示后恢复', async () => {
  const key = `scroll-hidden-${crypto.randomUUID()}`;
  const group = chatSessions(key);
  await group.ready;
  group.sessions[0].turns = [turn];
  const view = open(key);
  view.scroll(280);
  view.setVisible(false);
  view.scroll(0);
  group.notify();
  expect(group.sessions[0].scrollTop).toBe(280);
  view.setVisible(true);
  expect(view.main.scrollTop).toBe(280);
});

it('内容更新时保留阅读位置，接近底部则跟随最新回复', async () => {
  const key = `scroll-stream-${crypto.randomUUID()}`;
  const group = chatSessions(key);
  await group.ready;
  group.sessions[0].turns = [turn];
  const view = open(key);
  view.scroll(230);
  group.notify();
  expect(view.main.scrollTop).toBe(230);
  view.scroll(1480);
  group.notify();
  expect(view.main.scrollTop).toBe(1500);
});
