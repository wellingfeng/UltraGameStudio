import { afterEach, expect, it, vi } from 'vitest';
import { temporaryChatDocument } from './document';

let frame: HTMLIFrameElement | undefined;
afterEach(() => { frame?.remove(); frame = undefined; vi.restoreAllMocks(); });

it('会话列表支持新建、切换和二次确认删除，并在切换时恢复空状态及草稿', () => {
  const html = temporaryChatDocument({ fileTab: true });
  frame = document.createElement('iframe'); document.body.append(frame);
  const win = frame.contentWindow!;
  const doc = win.document;
  doc.open(); doc.write(html.slice(0, html.indexOf('<script nonce')) + '</body></html>'); doc.close();
  const script = html.slice(html.indexOf('>', html.indexOf('<script nonce')) + 1, html.lastIndexOf('</script>'));
  const post = vi.fn();
  const parent = { postMessage: post };
  let receive: (event: { source: unknown; data: unknown }) => void = () => {};
  const fakeWindow = { addEventListener: (type: string, listener: typeof receive) => { if (type === 'message') receive = listener; } };
  new Function('window', 'document', 'parent', 'setInterval', script)(fakeWindow, doc, parent, () => 0);
  const state = { models: [], selected: 0, busy: false, status: '', error: '', storageError: '',
    sessionId: 'a', sessions: [{ id: 'a', title: '第一条', updatedAt: 1 }, { id: 'b', title: '第二条', updatedAt: 2 }],
    turns: [{ user: '第一条', assistant: ['回答 $x^2$', '', String.raw`$$\frac{a}{b}$$`].join('\n'), status: 'done' }] };
  const publish = (next: unknown) => receive({ source: parent, data: { scope: 'ugs-temporary-chat', type: 'state', state: next } });
  publish(state);
  expect(doc.querySelectorAll('.assistant math')).toHaveLength(2);
  expect(doc.querySelector('.assistant mfrac')).not.toBeNull();
  const draft = doc.querySelector('textarea')!;
  draft.value = '第一会话草稿';
  (doc.querySelector('.session-toggle') as HTMLButtonElement).click();
  expect(doc.querySelectorAll('.session-row')).toHaveLength(2);
  (doc.querySelector('[aria-label="打开会话：第二条"]') as HTMLButtonElement).click();
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'select-session', id: 'b' }), '*');
  publish({ ...state, sessionId: 'b', turns: [] });
  expect(doc.querySelector('main')?.textContent).toContain('有什么想聊的');
  expect(draft.value).toBe('');
  publish(state);
  expect(draft.value).toBe('第一会话草稿');
  (doc.querySelector('.session-toggle') as HTMLButtonElement).click();
  (doc.querySelector('[aria-label="删除会话：第二条"]') as HTMLButtonElement).click();
  expect((doc.querySelector('.session-menu') as HTMLElement).hidden).toBe(false);
  expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'delete-session' }), '*');
  (doc.querySelector('.session-confirm') as HTMLButtonElement).click();
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'delete-session', id: 'b' }), '*');
  (doc.querySelector('.session-new') as HTMLButtonElement).click();
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'new-session' }), '*');
});

it('拖拽输入区顶部调整高度，并在输入、窗口变化和取消拖拽时保持正确行为', () => {
  const html = temporaryChatDocument({ fileTab: true });
  frame = document.createElement('iframe'); document.body.append(frame);
  const win = frame.contentWindow! as Window & typeof globalThis;
  const doc = win.document;
  doc.open(); doc.write(html.slice(0, html.indexOf('<script nonce')) + '</body></html>'); doc.close();
  const script = html.slice(html.indexOf('>', html.indexOf('<script nonce')) + 1, html.lastIndexOf('</script>'));
  const listeners = new Map<string, EventListener>();
  const fakeWindow = { addEventListener: (type: string, listener: EventListener) => listeners.set(type, listener) };
  const input = doc.querySelector<HTMLTextAreaElement>('textarea')!;
  const handle = doc.querySelector<HTMLElement>('[aria-label="拖动调整输入框高度"]')!;
  const main = doc.querySelector<HTMLElement>('main')!;
  let availableHeight = 400;
  let visible = true;
  const inputHeight = () => Math.max(64, parseFloat(input.style.height) || 64);
  vi.spyOn(input, 'getClientRects').mockImplementation(() => ({ length: visible ? 1 : 0 } as DOMRectList));
  vi.spyOn(input, 'getBoundingClientRect').mockImplementation(() => ({ height: inputHeight() } as DOMRect));
  vi.spyOn(main, 'getBoundingClientRect').mockImplementation(() => ({ height: Math.max(0, availableHeight - inputHeight()) } as DOMRect));
  vi.spyOn(doc.documentElement, 'clientHeight', 'get').mockReturnValue(600);
  vi.spyOn(doc.body, 'scrollHeight', 'get').mockImplementation(() => 600 + Math.max(0, inputHeight() - availableHeight));
  handle.setPointerCapture = vi.fn();
  new Function('window', 'document', 'parent', 'setInterval', script)(fakeWindow, doc, { postMessage: vi.fn() }, () => 0);
  const pointer = (type: string, y: number, pointerId = 1, button = 0) => {
    const event = new win.MouseEvent(type, { bubbles: true, clientY: y, button });
    Object.defineProperty(event, 'pointerId', { value: pointerId });
    handle.dispatchEvent(event);
  };

  pointer('pointerdown', 300);
  expect(handle.setPointerCapture).toHaveBeenCalledWith(1);
  pointer('pointermove', 160, 2);
  expect(inputHeight()).toBe(64);
  pointer('pointermove', 160);
  pointer('pointerup', 160);
  expect(inputHeight()).toBe(204);
  input.value = '输入后保留高度';
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  expect(inputHeight()).toBe(204);
  expect(input.style.maxHeight).toBe('none');

  availableHeight = 160;
  listeners.get('resize')!(new win.Event('resize'));
  expect(inputHeight()).toBe(80);
  availableHeight = 400;
  listeners.get('resize')!(new win.Event('resize'));
  expect(inputHeight()).toBe(204);

  pointer('pointerdown', 160);
  pointer('pointermove', -1000);
  expect(inputHeight()).toBe(320);
  pointer('pointercancel', -1000);
  expect(inputHeight()).toBe(204);
  pointer('pointerdown', 160);
  pointer('pointermove', 1000);
  pointer('pointerup', 1000);
  expect(inputHeight()).toBe(64);
  handle.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, bubbles: true }));
  expect(inputHeight()).toBe(114);

  availableHeight = 160;
  listeners.get('resize')!(new win.Event('resize'));
  expect(inputHeight()).toBe(80);
  visible = false;
  availableHeight = 400;
  listeners.get('resize')!(new win.Event('resize'));
  expect(inputHeight()).toBe(80);
  visible = true;
  listeners.get('resize')!(new win.Event('resize'));
  expect(inputHeight()).toBe(114);
});
