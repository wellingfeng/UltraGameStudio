import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TitleBarContent, TitleBarLayout } from './TitleBar';

const native = vi.hoisted(() => ({
  available: true,
  window: {
    isMaximized: vi.fn(async () => false),
    isFocused: vi.fn(async () => true),
    onResized: vi.fn(async (callback: unknown) => { void callback; return vi.fn(); }),
    onFocusChanged: vi.fn(async (callback: unknown) => { void callback; return vi.fn(); }),
    minimize: vi.fn(async () => {}),
    toggleMaximize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    startDragging: vi.fn(async () => {}),
  },
}));
vi.mock('@/lib/tauri', () => ({ tauriAvailable: () => native.available }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => native.window }));
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  native.available = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function render() {
  await act(async () => root.render(
    <TitleBarLayout><main><TitleBarContent enabled><header data-tauri-drag-region><div className="ugs-preview-tabs"><button>会话标题</button><div data-testid="titlebar-blank"><span>空白区</span></div><button role="tab"><span>文件</span></button><input aria-label="编辑会话标题" /></div></header></TitleBarContent></main></TitleBarLayout>,
  ));
}

it('moves the existing chat header into chrome without duplicating it', async () => {
  await render();
  expect(host.querySelector('.ugs-titlebar-content header')).toBeTruthy();
  expect(host.querySelector('main header')).toBeNull();
  expect(host.querySelectorAll('header')).toHaveLength(1);
});

it('places agent usage immediately before model rankings', async () => {
  await render();
  const usage = host.querySelector('.ugs-agent-usage');
  expect(usage?.nextElementSibling).toBe(host.querySelector('.ugs-model-rankings'));
});

it('uses native window actions and does not maximize when editing the title', async () => {
  await render();
  for (const [label, method] of [['最小化', 'minimize'], ['最大化', 'toggleMaximize'], ['关闭窗口', 'close']] as const) {
    await act(async () => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click());
    expect(native.window[method]).toHaveBeenCalledTimes(1);
  }
  await act(async () => host.querySelector('header button')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, detail: 2 })));
  expect(native.window.toggleMaximize).toHaveBeenCalledTimes(1);
  await act(async () => host.querySelector('.ugs-titlebar-brand span')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, detail: 2 })));
  expect(native.window.toggleMaximize).toHaveBeenCalledTimes(2);
});

it('drags nested blank space in the portaled header exactly once before Tauri document handlers', async () => {
  await render();
  const documentHandler = vi.fn();
  document.addEventListener('mousedown', documentHandler);
  try {
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail: 1 });
    await act(async () => host.querySelector('[data-testid="titlebar-blank"] span')!.dispatchEvent(event));
    expect(native.window.startDragging).toHaveBeenCalledTimes(1);
    expect(documentHandler).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    await act(async () => host.querySelector('[data-testid="titlebar-blank"] span')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, detail: 2 })));
    expect(native.window.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(native.window.startDragging).toHaveBeenCalledTimes(1);
  } finally {
    document.removeEventListener('mousedown', documentHandler);
  }
});

it('preserves controls, editing, file tabs, right click and canceled mouse events', async () => {
  await render();
  for (const selector of ['header button', '[role="tab"] span', 'header input', '[aria-label="最小化"]']) {
    await act(async () => host.querySelector(selector)!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, detail: 1 })));
  }
  const blank = host.querySelector('[data-testid="titlebar-blank"]')!;
  await act(async () => blank.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2, detail: 1 })));
  const canceled = new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail: 1 });
  canceled.preventDefault();
  await act(async () => blank.dispatchEvent(canceled));
  expect(native.window.startDragging).not.toHaveBeenCalled();
  expect(native.window.toggleMaximize).not.toHaveBeenCalled();
});

it('shows native dragging failures instead of silently ignoring them', async () => {
  await render();
  native.window.startDragging.mockRejectedValueOnce(new Error('drag rejected'));
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await act(async () => host.querySelector('[data-testid="titlebar-blank"]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, detail: 1 })));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('窗口操作失败');
  } finally { error.mockRestore(); }
});

it('updates maximize state on native resize and releases listeners', async () => {
  await render();
  native.window.isMaximized.mockResolvedValueOnce(true);
  const resize = native.window.onResized.mock.calls[0][0] as () => void;
  await act(async () => resize());
  expect(host.querySelector('[aria-label="还原窗口"]')).toBeTruthy();
  const stops = await Promise.all([native.window.onResized.mock.results[0].value, native.window.onFocusChanged.mock.results[0].value]);
  await act(async () => root.unmount());
  stops.forEach((stop) => expect(stop).toHaveBeenCalledTimes(1));
});

it('hides native controls in the browser', async () => {
  native.available = false;
  await render();
  expect(host.querySelector('.ugs-titlebar-controls')).toBeNull();
  expect(native.window.isMaximized).not.toHaveBeenCalled();
  await act(async () => host.querySelector('[data-testid="titlebar-blank"]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, detail: 1 })));
  expect(native.window.startDragging).not.toHaveBeenCalled();
});

it('leaves native macOS title bar handling to Tauri', async () => {
  const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  try {
    await render();
    await act(async () => host.querySelector('[data-testid="titlebar-blank"]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, detail: 1 })));
    expect(native.window.startDragging).not.toHaveBeenCalled();
    expect(host.querySelector('.ugs-titlebar-controls')).toBeNull();
  } finally { platform.mockRestore(); }
});

it('keeps the left sidebar toggle first and separate from window actions', async () => {
  const toggle = vi.fn();
  await act(async () => root.render(
    <TitleBarLayout sidebarOpen onToggleSidebar={toggle}><main /></TitleBarLayout>,
  ));
  const button = host.querySelector<HTMLButtonElement>('[data-ugs-sidebar-toggle="left"]')!;
  expect(host.querySelector('.ugs-titlebar-brand')?.firstElementChild).toBe(button);
  expect(button.getAttribute('aria-label')).toBe('隐藏左侧栏');
  expect(button.getAttribute('aria-controls')).toBe('ugs-left-sidebar');
  await act(async () => button.click());
  expect(toggle).toHaveBeenCalledTimes(1);
  await act(async () => button.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  expect(native.window.toggleMaximize).not.toHaveBeenCalled();
  await act(async () => root.render(
    <TitleBarLayout sidebarOpen={false} onToggleSidebar={toggle}><main /></TitleBarLayout>,
  ));
  expect(button.getAttribute('aria-label')).toBe('显示左侧栏');
  expect(button.getAttribute('aria-expanded')).toBe('false');
});

it('keeps standalone dock rendering valid without a title bar provider', async () => {
  await act(async () => root.render(<TitleBarContent enabled><header>会话</header></TitleBarContent>));
  expect(host.querySelector('header')?.textContent).toBe('会话');
});
