import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MainSurfaceProvider } from '@/components/MainSurface';
import PreviewFloatingTools from '@/components/floatingTools/PreviewFloatingTools';
import TemporaryChatWindows, { requestTemporaryChat } from './TemporaryChatWindows';

const native = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => undefined),
  listen: vi.fn(async (_name: string, _handler: (event: { payload: never }) => void) => vi.fn()),
  emitTo: vi.fn(async (_target: string, _event: string, _payload: unknown) => undefined),
  observe: vi.fn((_callback: (source: unknown) => void) => () => {}),
}));
vi.mock('@/lib/tauri', () => ({ tauriAvailable: () => true }));
vi.mock('@/store/useStore', () => ({ useStore: (selector: (state: { composer: { workspace: string } }) => unknown) => selector({ composer: { workspace: 'E:/Game' } }) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke, Channel: class {} }));
vi.mock('@tauri-apps/api/event', () => ({ listen: native.listen, emitTo: native.emitTo }));
vi.mock('./context', () => ({ currentSource: () => undefined, browserSource: () => undefined, observeCurrentSource: native.observe }));
vi.mock('@/components/WorkspaceMainSurface', () => ({ default: () => <div data-ugs-chat-surface /> }));
vi.mock('@/components/floatingTools/BrowserPane', () => ({ default: () => null }));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it('从预览悬浮按钮创建独立系统聊天窗口，底部不再显示重复入口', async () => {
  const source = { label: '当前网页', load: async () => undefined };
  await act(async () => root.render(<MainSurfaceProvider><PreviewFloatingTools label="针对当前网页随手聊" source={() => source} /><footer><TemporaryChatWindows /></footer></MainSurfaceProvider>));
  expect(host.querySelector('footer button')).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="针对当前网页随手聊"]')!.click());
  expect(native.invoke).toHaveBeenCalledWith('temporary_chat_window_open', expect.objectContaining({ id: expect.any(String), number: 1 }));
  expect(document.querySelector('.temporary-chat-window')).toBeNull();
});

it('不同窗口的消息各自转发，关闭后不再转发', async () => {
  const handlers = new Map<string, (event: { payload: unknown }) => void>();
  native.listen.mockImplementation(async (name, handler) => { handlers.set(name, handler as (event: { payload: unknown }) => void); return vi.fn(); });
  native.invoke.mockImplementation(async command => command === 'temporary_chat_models'
    ? [{ providerId: 'p', model: 'm', label: '测试' }] : undefined);
  await act(async () => root.render(<TemporaryChatWindows />));
  await act(async () => requestTemporaryChat());
  await act(async () => requestTemporaryChat());
  const calls = native.invoke.mock.calls.filter(call => call[0] === 'temporary_chat_window_open');
  const [first, second] = calls.map(call => (call[1] as { id: string }).id);
  await act(async () => handlers.get('ugs:temporary-chat-action')!({ payload: { id: first, action: { scope: 'ugs-temporary-chat', type: 'ready' } } }));
  expect(native.emitTo).toHaveBeenCalledWith(`temporary-chat-${first}`, 'ugs:temporary-chat-state', expect.anything());
  await act(async () => handlers.get('ugs:temporary-chat-action')!({ payload: { id: second, action: { scope: 'ugs-temporary-chat', type: 'ready' } } }));
  expect(native.emitTo).toHaveBeenCalledWith(`temporary-chat-${second}`, 'ugs:temporary-chat-state', expect.anything());
  await act(async () => handlers.get('ugs:temporary-chat-closed')!({ payload: first }));
  native.emitTo.mockClear();
  await act(async () => handlers.get('ugs:temporary-chat-action')!({ payload: { id: first, action: { scope: 'ugs-temporary-chat', type: 'ready' } } }));
  expect(native.emitTo).not.toHaveBeenCalled();
});

it('原生窗口随来源切换会话列表并恢复原来源', async () => {
  const handlers = new Map<string, (event: { payload: unknown }) => void>();
  native.listen.mockImplementation(async (name, handler) => { handlers.set(name, handler as (event: { payload: unknown }) => void); return vi.fn(); });
  const sourceA = { key: 'native-source-a', label: '文件 A', load: async () => ({ label: '文件 A', text: 'A' }) };
  const sourceB = { key: 'native-source-b', label: '文件 B', load: async () => ({ label: '文件 B', text: 'B' }) };
  await act(async () => root.render(<TemporaryChatWindows />));
  await act(async () => requestTemporaryChat(sourceA));
  const call = native.invoke.mock.calls.find(item => item[0] === 'temporary_chat_window_open')!;
  const id = (call[1] as { id: string }).id;
  await act(async () => handlers.get('ugs:temporary-chat-action')!({ payload: { id, action: { scope: 'ugs-temporary-chat', type: 'new-session' } } }));
  const state = () => native.emitTo.mock.lastCall?.[2] as { sessions: unknown[] };
  expect(state().sessions).toHaveLength(2);
  const changeSource = native.observe.mock.calls[0][0];
  await act(async () => changeSource(sourceB));
  expect(state().sessions).toHaveLength(1);
  await act(async () => changeSource(sourceA));
  expect(state().sessions).toHaveLength(2);
});
