import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@/lib/tauri', () => ({ tauriAvailable: () => true }));
vi.mock('@/store/useStore', () => ({ useStore: (selector: (state: { workspaces: { id: string; name: string }[]; activeWorkspaceId: string }) => unknown) => selector({ workspaces: [{ id: 'project', name: '消息项目' }], activeWorkspaceId: 'project' }) }));
import MessagePlatformsPanel from './MessagePlatformsPanel';
import { defaultPlatformConfig, MESSAGE_PLATFORMS } from '@/lib/messagePlatforms';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLDivElement;
afterEach(async () => { if (root) await act(async () => root.unmount()); container?.remove(); mocks.invoke.mockReset(); });
async function render() {
  mocks.invoke.mockImplementation(async (command: string, args: { config: ReturnType<typeof defaultPlatformConfig> }) => {
    if (command === 'message_platform_load') return MESSAGE_PLATFORMS.map((p) => defaultPlatformConfig(p.id));
    if (command === 'message_platform_save') return { ...args.config, hasSecret: true };
    return {};
  });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  const close = vi.fn();
  await act(async () => { root.render(<MessagePlatformsPanel onClose={close} />); });
  return close;
}
async function click(text: string) {
  const button = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text || b.textContent?.includes(text));
  expect(button).toBeTruthy(); await act(async () => button!.click());
}
describe('消息平台设置', () => {
  it('飞书凭据进入 IPC，保存后清空输入，启用与连接按顺序执行', async () => {
    await render();
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    const appId = document.querySelector<HTMLInputElement>('input[placeholder="cli_…"]')!;
    const secret = document.querySelector<HTMLInputElement>('input[type="password"]')!;
    await act(async () => { set.call(appId, 'cli_test'); appId.dispatchEvent(new Event('input', { bubbles: true })); set.call(secret, 'private-secret'); secret.dispatchEvent(new Event('input', { bubbles: true })); });
    await click('保存并连接');
    expect(mocks.invoke).toHaveBeenCalledWith('message_platform_save', expect.objectContaining({ config: expect.objectContaining({ id: 'feishu', enabled: true, appId: 'cli_test', workspaceId: 'project', allowAllUsers: false }), secret: 'private-secret' }));
    expect(mocks.invoke).toHaveBeenCalledWith('message_platform_request', { id: 'feishu', method: 'connect', params: {} });
    expect(document.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe('');
    expect(document.body.textContent).not.toContain('private-secret');
  });
  it('切换平台显示微信扫码、群通知与可选加签，Esc 返回对话', async () => {
    const close = await render();
    await click('微信'); expect(document.body.textContent).toContain('获取登录二维码');
    await click('企业微信'); expect(document.body.textContent).toContain('会话完成后发送结果到群');
    await click('钉钉'); expect(document.body.textContent).toContain('加签密钥（可选）');
    await act(async () => container.querySelector('section')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(close).toHaveBeenCalledOnce();
  });
  it('设置嵌入当前区域，搜索筛选平台且不限制侧栏键盘导航', async () => {
    const close = await render();
    const panel = container.querySelector('[data-ugs-message-platforms]')!;
    expect(panel).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[aria-modal]')).toBeNull();
    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { set.call(search, '微信'); search.dispatchEvent(new Event('input', { bubbles: true })); });
    const nav = container.querySelector('nav')!;
    expect(nav.textContent).toContain('微信');
    expect(nav.textContent).not.toContain('钉钉');
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    panel.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    await click('返回对话');
    expect(close).toHaveBeenCalledOnce();
  });
});
