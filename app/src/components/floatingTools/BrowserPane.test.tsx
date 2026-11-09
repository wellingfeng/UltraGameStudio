import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BrowserPane, { browserAddress } from './BrowserPane';
import { useFilePreviewTabs } from '@/store/filePreviewTabs';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => undefined), openExternal: vi.fn(async () => undefined), listeners: new Map<string, Set<(event: { payload: { browserId: string; url: string } }) => void>>() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async (name: string, callback: (event: { payload: { browserId: string; url: string } }) => void) => {
  const callbacks = mocks.listeners.get(name) ?? new Set(); callbacks.add(callback); mocks.listeners.set(name, callbacks);
  return () => callbacks.delete(callback);
} }));
vi.mock('@/lib/tauri', () => ({ tauriAvailable: () => true, openExternal: mocks.openExternal }));

describe('浏览器地址', () => {
  it('保留网址和本地路径，识别本地服务与搜索词', () => {
    expect(browserAddress(' https://example.com/path ')).toBe('https://example.com/path');
    expect(browserAddress('example.com')).toBe('https://example.com');
    expect(browserAddress('localhost:3000')).toBe('http://localhost:3000');
    expect(browserAddress('C:\\work\\a.html')).toBe('C:\\work\\a.html');
    expect(browserAddress('渲染 入门')).toBe('https://www.bing.com/search?q=%E6%B8%B2%E6%9F%93%20%E5%85%A5%E9%97%A8');
  });

});

describe('浏览器面板操作', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(async () => {
    mocks.invoke.mockReset(); mocks.openExternal.mockClear(); mocks.listeners.clear();
    mocks.invoke.mockImplementation(async (command) => command === 'temporary_chat_models' ? [] : command === 'floating_browser_page_context' ? { url: 'https://example.com/path', title: '测试网页', text: '测试正文' } : undefined);
    useFilePreviewTabs.setState({ chatOpenByScope: {} });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    function Harness() {
      const [expanded, setExpanded] = useState(false);
      const [visible, setVisible] = useState(true);
      const [second, setSecond] = useState(false);
      return <><button aria-label="添加第二个面板" onClick={() => setSecond(true)} /><button aria-label="切换网页可见性" onClick={() => setVisible(!visible)} />
        <BrowserPane browserId="first-1" expanded={expanded} visible={visible} onExpandedChange={setExpanded} onClose={() => {}} />
        {second && <BrowserPane browserId="second-2" expanded visible onExpandedChange={() => {}} onClose={() => {}} />}</>;
    }
    await act(async () => root.render(<Harness />));
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
  const click = async (label: string) => { await act(async () => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click()); };
  const location = async (url: string, browserId = 'first-1') => { await act(async () => {
    mocks.listeners.get('ugs:browser-location')?.forEach((callback) => callback({ payload: { browserId, url } }));
  }); };

  it('展开的网页随手聊显示在右侧，普通侧栏仍使用悬浮窗口', async () => {
    const opened = vi.fn();
    window.addEventListener('ugs:temporary-chat-open', opened);
    try {
      await location('https://example.com/path');
      await click('在信息流区域打开');
      await click('针对当前网页随手聊');
      expect(opened).not.toHaveBeenCalled();
      expect(host.querySelector('.ugs-browser-pane-expanded .ugs-preview-chat iframe')).not.toBeNull();
      await click('关闭网页随手聊');
      expect(host.querySelector('.ugs-browser-pane-expanded .ugs-preview-chat')?.hasAttribute('hidden')).toBe(true);
      await click('还原到侧栏');
      await click('针对当前网页随手聊');
      expect(opened).toHaveBeenCalledTimes(1);
    } finally { window.removeEventListener('ugs:temporary-chat-open', opened); }
  });

  it('放大及还原时保留地址且不关闭原生视图', async () => {
    await location('https://example.com/path');
    await click('在信息流区域打开');
    expect(host.querySelector('.ugs-browser-pane-expanded')).not.toBeNull();
    expect(host.querySelector<HTMLInputElement>('[aria-label="浏览器地址"]')?.value).toBe('https://example.com/path');
    await click('还原到侧栏');
    expect(host.querySelector('.ugs-browser-pane-expanded')).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalledWith('floating_browser_close', { browserId: 'first-1' });
  });

  it('切换标签时隐藏原生视图，返回时先更新位置再显示并保留网页', async () => {
    const viewport = host.querySelector<HTMLElement>('.ugs-browser-viewport')!;
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ x: 20, y: 30, width: 800, height: 600 } as DOMRect);
    await location('https://example.com/path');
    mocks.invoke.mockClear();
    await click('切换网页可见性');
    expect(host.querySelector('[data-ugs-browser-panel]')?.hasAttribute('hidden')).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith('floating_browser_visibility', { browserId: 'first-1', visible: false });
    mocks.invoke.mockClear();
    await click('切换网页可见性');
    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual(['floating_browser_bounds', 'floating_browser_visibility']);
    expect(mocks.invoke).toHaveBeenLastCalledWith('floating_browser_visibility', { browserId: 'first-1', visible: true });
    expect(host.querySelector<HTMLInputElement>('[aria-label="浏览器地址"]')?.value).toBe('https://example.com/path');
    expect(mocks.invoke).not.toHaveBeenCalledWith('floating_browser_close', { browserId: 'first-1' });
  });

  it('不同浏览器的页面事件、操作和网页内容相互隔离', async () => {
    await click('添加第二个面板');
    await location('https://first.example/', 'first-1');
    await location('https://second.example/', 'second-2');
    const panes = host.querySelectorAll<HTMLElement>('[data-ugs-browser-panel]');
    expect(panes[0].querySelector<HTMLInputElement>('[aria-label="浏览器地址"]')?.value).toBe('https://first.example/');
    expect(panes[1].querySelector<HTMLInputElement>('[aria-label="浏览器地址"]')?.value).toBe('https://second.example/');
    mocks.invoke.mockClear();
    await act(async () => panes[1].querySelector<HTMLButtonElement>('[aria-label="刷新"]')!.click());
    expect(mocks.invoke).toHaveBeenCalledWith('floating_browser_action', { browserId: 'second-2', action: 'reload' });
    expect(mocks.invoke).not.toHaveBeenCalledWith('floating_browser_action', { browserId: 'first-1', action: 'reload' });
    const viewport = panes[1].querySelector<HTMLElement>('.ugs-browser-viewport')!;
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ x: 20, y: 30, width: 800, height: 600 } as DOMRect);
    mocks.invoke.mockClear();
    await act(async () => mocks.listeners.get('ugs:browser-open-url')?.forEach((callback) => callback({
      payload: { browserId: 'second-2', url: 'https://popup.example/' },
    })));
    expect(mocks.invoke).toHaveBeenCalledWith('floating_browser_open', expect.objectContaining({ browserId: 'second-2', url: 'https://popup.example/' }));
    expect(panes[0].querySelector<HTMLInputElement>('[aria-label="浏览器地址"]')?.value).toBe('https://first.example/');
    expect(panes[1].querySelector<HTMLInputElement>('[aria-label="浏览器地址"]')?.value).toBe('https://popup.example/');
  });

  it('系统打开使用当前页面地址，支持网址和本地网页', async () => {
    expect(host.querySelector<HTMLButtonElement>('[aria-label="用系统浏览器打开"]')?.disabled).toBe(true);
    await location('https://example.com/original');
    mocks.invoke.mockResolvedValueOnce('https://example.com/current'); await click('用系统浏览器打开');
    expect(mocks.openExternal).toHaveBeenCalledWith('https://example.com/current');
    await location('file:///E:/%E6%B5%8B%E8%AF%95/a%20b.html');
    mocks.invoke.mockResolvedValueOnce('file:///E:/%E6%B5%8B%E8%AF%95/a%20b.html'); await click('用系统浏览器打开');
    expect(mocks.invoke).toHaveBeenCalledWith('floating_browser_open_system_file', { url: 'file:///E:/%E6%B5%8B%E8%AF%95/a%20b.html' });
  });

  it('系统浏览器打开失败时显示错误', async () => {
    await location('file:///E:/test.html');
    mocks.invoke.mockResolvedValueOnce('file:///E:/test.html').mockRejectedValueOnce(new Error('无法读取系统浏览器设置'));
    await click('用系统浏览器打开');
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('无法读取系统浏览器设置');
  });
});
