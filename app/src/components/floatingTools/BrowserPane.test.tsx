import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BrowserPane, { browserAddress } from './BrowserPane';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => undefined), openExternal: vi.fn(async () => undefined), listeners: new Map<string, (event: { payload: string }) => void>() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async (name: string, callback: (event: { payload: string }) => void) => { mocks.listeners.set(name, callback); return () => mocks.listeners.delete(name); } }));
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
    mocks.invoke.mockClear(); mocks.openExternal.mockClear(); mocks.listeners.clear();
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    function Harness() { const [expanded, setExpanded] = useState(false); return <BrowserPane expanded={expanded} onExpandedChange={setExpanded} onClose={() => {}} />; }
    await act(async () => root.render(<Harness />));
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
  const click = async (label: string) => { await act(async () => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click()); };
  const location = async (url: string) => { await act(async () => mocks.listeners.get('ugs:browser-location')!({ payload: url })); };

  it('放大及还原时保留地址且不关闭原生视图', async () => {
    await location('https://example.com/path');
    await click('在信息流区域打开');
    expect(host.querySelector('.ugs-browser-pane-expanded')).not.toBeNull();
    expect(host.querySelector<HTMLInputElement>('[aria-label="浏览器地址"]')?.value).toBe('https://example.com/path');
    await click('还原到侧栏');
    expect(host.querySelector('.ugs-browser-pane-expanded')).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalledWith('floating_browser_close');
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
