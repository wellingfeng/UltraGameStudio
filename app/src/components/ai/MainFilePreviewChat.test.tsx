import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FilePreviewTabs, MainFilePreview } from './FilePreviewTabs';
import { useFilePreviewTabs } from '@/store/filePreviewTabs';
import { useStore } from '@/store/useStore';
import type { LocalFilePreview } from '@/lib/tauri';

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tauri-apps/api/core')>(),
  invoke: native.invoke,
  Channel: class { onmessage?: (event: unknown) => void; },
}));
vi.mock('@/components/temporaryChat/context', () => ({
  fileSource: (ref: { basename: string }, cwd?: string) => ({ key: JSON.stringify(['file', cwd, ref.basename]), label: ref.basename, load: async () => ({ label: ref.basename, text: `内容：${ref.basename}` }) }),
  registerVisibleSource: () => () => {},
  currentSource: () => undefined,
  browserSource: () => undefined,
  observeCurrentSource: () => () => {},
}));

const scope = 'e:/game';
const chatWidthKey = 'ultragamestudio.previewChatWidth.v1';
const previewFile = async (path: string): Promise<LocalFilePreview> => ({
  path, fileName: path, kind: 'text', mime: 'text/markdown', text: `# ${path}`,
  sizeBytes: 32, truncated: false, base64: null,
});
let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  localStorage.removeItem(chatWidthKey);
  native.invoke.mockReset();
  native.invoke.mockImplementation(async (command: string, args?: { onEvent?: { onmessage?: (event: unknown) => void } }) => {
    if (command === 'temporary_chat_models') return [{ providerId: 'p', model: 'm', label: '测试' }];
    if (command === 'temporary_chat_start') {
      args?.onEvent?.onmessage?.({ type: 'delta', text: '收到' });
      args?.onEvent?.onmessage?.({ type: 'done' });
    }
    return undefined;
  });
  useFilePreviewTabs.setState({ tabs: [], activeByScope: {}, browserTabs: [] });
  useStore.setState({ composer: { ...useStore.getState().composer, workspace: 'E:/Game' } });
  for (const name of ['one.md', 'two.md']) useFilePreviewTabs.getState().open({
    scope, ref: { path: name, basename: name }, cwd: 'E:/Game', previewFile,
    diffEnabled: false, canOpenExternally: false,
  });
  const first = useFilePreviewTabs.getState().tabs[0];
  useFilePreviewTabs.getState().select(scope, first.id);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<><FilePreviewTabs scope={scope}><span>会话</span></FilePreviewTabs><MainFilePreview scope={scope} /></>));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useFilePreviewTabs.setState({ tabs: [], activeByScope: {}, browserTabs: [] });
  localStorage.removeItem(chatWidthKey);
});

async function click(selector: string) {
  const button = host.querySelector<HTMLButtonElement>(selector);
  expect(button, selector).not.toBeNull();
  await act(async () => button!.click());
}

async function send(frame: HTMLIFrameElement, text: string) {
  await act(async () => window.dispatchEvent(new MessageEvent('message', {
    source: frame.contentWindow,
    data: { scope: 'ugs-temporary-chat', type: 'send', text },
  })));
}

it('大预览的聊天贴在右侧，随文件切换并保留各自对话', async () => {
  const opened = vi.fn();
  window.addEventListener('ugs:temporary-chat-open', opened);
  try {
    await click('[aria-label="针对当前文件随手聊"]');
    expect(opened).not.toHaveBeenCalled();
    const first = host.querySelector<HTMLIFrameElement>('.ugs-main-file-preview-content:not([hidden]) .ugs-preview-chat iframe')!;
    expect(first).toBeTruthy();
    await send(first, '第一份文件的问题');
    expect(native.invoke).toHaveBeenCalledWith('temporary_chat_start', expect.objectContaining({ request: expect.objectContaining({
      context: { text: '内容：one.md' }, messages: [{ role: 'user', content: '第一份文件的问题' }],
    }) }));

    await click('[role="tab"][title="E:/Game/two.md"]');
    const second = host.querySelector<HTMLIFrameElement>('.ugs-main-file-preview-content:not([hidden]) .ugs-preview-chat iframe')!;
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    await send(second, '第二份文件的问题');
    expect(native.invoke).toHaveBeenCalledWith('temporary_chat_start', expect.objectContaining({ request: expect.objectContaining({
      context: { text: '内容：two.md' }, messages: [{ role: 'user', content: '第二份文件的问题' }],
    }) }));

    await click('[role="tab"][title="E:/Game/one.md"]');
    expect(host.querySelector('.ugs-main-file-preview-content:not([hidden]) .ugs-preview-chat iframe')).toBe(first);
    await send(first, '继续第一份');
    expect(native.invoke).toHaveBeenCalledWith('temporary_chat_start', expect.objectContaining({ request: expect.objectContaining({
      context: { text: '内容：one.md' },
      messages: [{ role: 'user', content: '第一份文件的问题' }, { role: 'assistant', content: '收到' }, { role: 'user', content: '继续第一份' }],
    }) }));

    await click('[aria-label="关闭文件随手聊"]');
    expect(first.closest('.ugs-preview-chat')?.hasAttribute('hidden')).toBe(true);
    await click('[aria-label="针对当前文件随手聊"]');
    expect(host.querySelector('.ugs-main-file-preview-content:not([hidden]) .ugs-preview-chat iframe')).toBe(first);
    expect(first.closest('.ugs-preview-chat')?.hasAttribute('hidden')).toBe(false);

    await click('[aria-label="会话信息流"]');
    expect(host.querySelector('.ugs-main-file-preview')?.hasAttribute('hidden')).toBe(true);
    await click('[role="tab"][title="E:/Game/one.md"]');
    expect(host.querySelector('.ugs-main-file-preview-content:not([hidden]) .ugs-preview-chat iframe')).toBe(first);
    await click('[aria-label="关闭预览：one.md"]');
    expect(first.isConnected).toBe(false);
  } finally {
    window.removeEventListener('ugs:temporary-chat-open', opened);
  }
});

it('关闭所有文件后重新预览，聊天面板默认收起', async () => {
  await click('[aria-label="针对当前文件随手聊"]');
  await click('[aria-label="关闭预览：one.md"]');
  await click('[aria-label="关闭预览：two.md"]');
  await act(async () => useFilePreviewTabs.getState().open({
    scope, ref: { path: 'three.md', basename: 'three.md' }, cwd: 'E:/Game', previewFile,
    diffEnabled: false, canOpenExternally: false,
  }));
  expect(host.querySelector('.ugs-preview-chat')).toBeNull();
});

it('拖动边框按实际宽度调整，限制范围并在切换与重新打开后恢复', async () => {
  await click('[aria-label="针对当前文件随手聊"]');
  const chat = host.querySelector<HTMLElement>('.ugs-main-file-preview-content:not([hidden]) .ugs-preview-chat')!;
  const handle = chat.querySelector<HTMLElement>('[aria-label="拖动调整随手聊宽度"]')!;
  const capture = vi.fn();
  handle.setPointerCapture = capture;
  vi.spyOn(chat, 'getBoundingClientRect').mockReturnValue({ width: 360 } as DOMRect);
  vi.spyOn(chat.parentElement!, 'getBoundingClientRect').mockReturnValue({ width: 1000 } as DOMRect);
  const pointer = async (type: string, x: number, pointerId = 1) => {
    const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x });
    Object.defineProperty(event, 'pointerId', { value: pointerId });
    await act(async () => handle.dispatchEvent(event));
  };

  await pointer('pointerdown', 600);
  expect(capture).toHaveBeenCalledWith(1);
  await pointer('pointermove', 450, 2);
  expect(chat.style.getPropertyValue('--ugs-preview-chat-width')).toBe('');
  await pointer('pointermove', 450);
  expect(chat.style.getPropertyValue('--ugs-preview-chat-width')).toBe('510px');
  await pointer('pointermove', -500);
  expect(chat.style.getPropertyValue('--ugs-preview-chat-width')).toBe('800px');
  await pointer('pointermove', 2000);
  expect(chat.style.getPropertyValue('--ugs-preview-chat-width')).toBe('240px');
  await pointer('pointermove', 600);
  expect(chat.style.getPropertyValue('--ugs-preview-chat-width')).toBe('360px');
  await pointer('pointermove', 450);
  await pointer('pointerup', 450);
  expect(localStorage.getItem(chatWidthKey)).toBe('510');

  await click('[role="tab"][title="E:/Game/two.md"]');
  expect(host.querySelector<HTMLElement>('.ugs-main-file-preview-content:not([hidden]) .ugs-preview-chat')?.style.getPropertyValue('--ugs-preview-chat-width')).toBe('510px');
  await click('[aria-label="关闭文件随手聊"]');
  await click('[aria-label="针对当前文件随手聊"]');
  expect(host.querySelector<HTMLElement>('.ugs-main-file-preview-content:not([hidden]) .ugs-preview-chat')?.style.getPropertyValue('--ugs-preview-chat-width')).toBe('510px');
  await act(async () => root.render(null));
  await act(async () => root.render(<MainFilePreview scope={scope} />));
  expect(host.querySelector<HTMLElement>('.ugs-main-file-preview-content:not([hidden]) .ugs-preview-chat')?.style.getPropertyValue('--ugs-preview-chat-width')).toBe('510px');
});

it('窄预览区保留文件空间，并在拖拽取消后停止响应', async () => {
  await click('[aria-label="针对当前文件随手聊"]');
  const chat = host.querySelector<HTMLElement>('.ugs-main-file-preview-content:not([hidden]) .ugs-preview-chat')!;
  const handle = chat.querySelector<HTMLElement>('[aria-label="拖动调整随手聊宽度"]')!;
  handle.setPointerCapture = vi.fn();
  vi.spyOn(chat, 'getBoundingClientRect').mockReturnValue({ width: 210 } as DOMRect);
  vi.spyOn(chat.parentElement!, 'getBoundingClientRect').mockReturnValue({ width: 500 } as DOMRect);
  const pointer = async (type: string, x: number) => {
    const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    await act(async () => handle.dispatchEvent(event));
  };
  await pointer('pointerdown', 290);
  await pointer('pointermove', 0);
  expect(chat.style.getPropertyValue('--ugs-preview-chat-width')).toBe('300px');
  await pointer('pointermove', 500);
  expect(chat.style.getPropertyValue('--ugs-preview-chat-width')).toBe('210px');
  await pointer('pointercancel', 500);
  await pointer('pointermove', 0);
  expect(chat.style.getPropertyValue('--ugs-preview-chat-width')).toBe('210px');
  expect(localStorage.getItem(chatWidthKey)).toBe('210');
});

it('关闭文件标签再打开后恢复该文件的多个会话', async () => {
  await act(async () => useFilePreviewTabs.getState().open({
    scope, ref: { path: 'persist-one.md', basename: 'persist-one.md' }, cwd: 'E:/Game', previewFile,
    diffEnabled: false, canOpenExternally: false,
  }));
  await click('[aria-label="针对当前文件随手聊"]');
  const frame = host.querySelector<HTMLIFrameElement>('.ugs-main-file-preview-content:not([hidden]) iframe[title^="文件随手聊"]')!;
  await send(frame, '持久会话一');
  await act(async () => window.dispatchEvent(new MessageEvent('message', {
    source: frame.contentWindow, data: { scope: 'ugs-temporary-chat', type: 'new-session' },
  })));
  await send(frame, '持久会话二');
  await click('[aria-label="关闭预览：persist-one.md"]');
  await act(async () => useFilePreviewTabs.getState().open({
    scope, ref: { path: 'persist-one.md', basename: 'persist-one.md' }, cwd: 'E:/Game', previewFile,
    diffEnabled: false, canOpenExternally: false,
  }));
  const reopened = host.querySelector<HTMLIFrameElement>('.ugs-main-file-preview-content:not([hidden]) iframe[title^="文件随手聊"]')!;
  expect(reopened).not.toBe(frame);
  await send(reopened, '继续第二会话');
  expect(native.invoke).toHaveBeenCalledWith('temporary_chat_start', expect.objectContaining({ request: expect.objectContaining({
    messages: [{ role: 'user', content: '持久会话二' }, { role: 'assistant', content: '收到' }, { role: 'user', content: '继续第二会话' }],
  }) }));
});
