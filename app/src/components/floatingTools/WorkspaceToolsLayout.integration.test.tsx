import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { MainSurfaceProvider } from '@/components/MainSurface';
import { TitleBarLayout } from '@/components/TitleBar';
import { simpleBlueprint } from '@/core/defaultBlueprint';
import { defaultComposer, samplePromptGroups } from '@/store/sampleSessions';
import { useFilePreviewTabs } from '@/store/filePreviewTabs';
import { useStore } from '@/store/useStore';
import WorkspaceToolsLayout from './WorkspaceToolsLayout';

it('真实会话标题栏创建多个浏览器，分别保留网页并可切换关闭', async () => {
  const originalResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  } as unknown as typeof ResizeObserver;
  useFilePreviewTabs.setState({ tabs: [], activeByScope: {}, browserTabs: [] });
  useStore.setState({
    mode: 'design', workflow: simpleBlueprint('浏览器测试'), selectedNodeId: null,
    aiStreaming: false, aiEditingSessions: [], chattingSessions: [], blockedSendTip: null,
    locale: 'zh-CN', promptAutoTranslate: false, promptGroups: samplePromptGroups,
    composer: { ...defaultComposer, workspace: 'E:/Game' }, composerDraft: '', composerDrafts: {},
    composerFocusVersion: 0, messages: [], activeWorkspaceId: null, activeSessionId: 's_browser_test',
    workspaceHistory: [], runningSessionProgress: {},
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<MainSurfaceProvider><TitleBarLayout><WorkspaceToolsLayout /></TitleBarLayout></MainSurfaceProvider>));
    const action = host.querySelector<HTMLButtonElement>('.ugs-titlebar-content .ugs-chat-header-actions [aria-label="打开浏览器"]');
    expect(action).not.toBeNull();
    expect(action?.parentElement?.firstElementChild).toBe(action);
    expect(host.querySelector('[aria-label="快捷工具"]')).toBeNull();
    await act(async () => action!.click());
    const pane = host.querySelector<HTMLElement>('[data-ugs-browser-panel]')!;
    expect(pane?.dataset.expanded).toBe('true');
    expect(pane.hidden).toBe(false);
    expect(host.querySelector('[role="tab"][aria-label="浏览器"]')?.getAttribute('aria-selected')).toBe('true');
    await act(async () => host.querySelector<HTMLElement>('[aria-label="会话信息流"]')!.click());
    expect(pane.hidden).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>('[role="tab"][aria-label="浏览器"]')!.click());
    expect(pane.hidden).toBe(false);
    const navigate = async (panel: HTMLElement, value: string) => {
      const input = panel.querySelector<HTMLInputElement>('[aria-label="浏览器地址"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
    };
    await navigate(pane, 'https://first.example/');
    await act(async () => action!.click());
    const panes = host.querySelectorAll<HTMLElement>('[data-ugs-browser-panel]');
    const tabs = host.querySelectorAll<HTMLButtonElement>('[role="tab"][aria-label="浏览器"]');
    expect(panes).toHaveLength(2);
    expect(tabs).toHaveLength(2);
    expect(pane.hidden).toBe(true);
    await navigate(panes[1], 'https://second.example/');
    expect(panes[0].querySelector('iframe')?.getAttribute('src')).toBe('https://first.example/');
    expect(panes[1].querySelector('iframe')?.getAttribute('src')).toBe('https://second.example/');
    await act(async () => tabs[0].click());
    expect(pane.hidden).toBe(false);
    expect(panes[1].hidden).toBe(true);
    expect(pane.querySelector<HTMLInputElement>('[aria-label="浏览器地址"]')?.value).toBe('https://first.example/');
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="关闭预览：浏览器"]')!.click());
    expect(host.querySelectorAll('[data-ugs-browser-panel]')).toHaveLength(1);
    expect(panes[1].hidden).toBe(false);
    expect(panes[1].querySelector<HTMLInputElement>('[aria-label="浏览器地址"]')?.value).toBe('https://second.example/');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    useFilePreviewTabs.setState({ tabs: [], activeByScope: {}, browserTabs: [] });
    globalThis.ResizeObserver = originalResizeObserver;
  }
});
