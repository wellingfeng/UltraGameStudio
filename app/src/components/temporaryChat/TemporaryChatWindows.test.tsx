import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MainSurfaceProvider } from '@/components/MainSurface';
import WorkspaceToolsLayout from '@/components/floatingTools/WorkspaceToolsLayout';
import TemporaryChatWindows, { requestTemporaryChat } from './TemporaryChatWindows';

const native = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => undefined),
  listen: vi.fn(async (_name: string, _handler: (event: { payload: never }) => void) => vi.fn()),
  emitTo: vi.fn(async () => undefined),
}));
vi.mock('@/lib/tauri', () => ({ tauriAvailable: () => true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke, Channel: class {} }));
vi.mock('@tauri-apps/api/event', () => ({ listen: native.listen, emitTo: native.emitTo }));
vi.mock('./context', () => ({ currentSource: () => undefined, browserSource: () => undefined }));
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

it('从悬浮工具栏创建独立系统聊天窗口，底部不再显示重复入口', async () => {
  await act(async () => root.render(<MainSurfaceProvider><WorkspaceToolsLayout /><footer><TemporaryChatWindows /></footer></MainSurfaceProvider>));
  expect(host.querySelector('footer button')).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>('.ugs-floating-tools button[aria-label="新建临时聊天"]')!.click());
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
