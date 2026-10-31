import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import NativeTemporaryChat from './NativeTemporaryChat';

const native = vi.hoisted(() => ({
  listen: vi.fn(async () => vi.fn()),
  emitTo: vi.fn(async () => undefined),
  window: {
    startDragging: vi.fn(async () => undefined),
    startResizeDragging: vi.fn(async (_direction: string) => undefined),
    close: vi.fn(async () => undefined),
    innerSize: vi.fn(async () => ({ width: 540, height: 630 })),
    scaleFactor: vi.fn(async () => 1.5),
    setSize: vi.fn(async (_size: unknown) => undefined),
    setMinSize: vi.fn(async (_size: unknown) => undefined),
  },
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: native.listen, emitTo: native.emitTo }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => native.window }));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function render() { await act(async () => root.render(<NativeTemporaryChat id="test-id" number="1" />)); }

it('四边和四角使用对应的系统窗口缩放方向', async () => {
  await render();
  const directions = ['North', 'NorthEast', 'East', 'SouthEast', 'South', 'SouthWest', 'West', 'NorthWest'];
  for (const direction of directions) {
    const handle = host.querySelector(`[data-resize-direction="${direction}"]`);
    expect(handle).not.toBeNull();
    await act(async () => handle!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })));
  }
  expect(native.window.startResizeDragging.mock.calls.map(call => call[0])).toEqual(directions);
});

it('标题栏拖动系统窗口，按钮不触发拖动', async () => {
  await render();
  await act(async () => host.querySelector('.native-chat-name')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })));
  await act(async () => host.querySelector('button')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })));
  expect(native.window.startDragging).toHaveBeenCalledTimes(1);
});

it('收起后恢复原尺寸，关闭使用系统窗口', async () => {
  await render();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="收起临时聊天 1"]')!.click());
  expect(host.querySelector('iframe')?.hidden).toBe(true);
  expect(native.window.setSize.mock.calls[0][0]).toMatchObject({ width: 360, height: 40 });
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="恢复临时聊天 1"]')!.click());
  expect(host.querySelector('iframe')?.hidden).toBe(false);
  expect(native.window.setSize.mock.calls[1][0]).toMatchObject({ width: 540, height: 630 });
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="关闭临时聊天 1"]')!.click());
  expect(native.window.close).toHaveBeenCalledOnce();
});
