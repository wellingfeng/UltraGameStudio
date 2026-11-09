import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MainSurfaceProvider, useMainSurface } from '@/components/MainSurface';
import { TitleBarContent, TitleBarLayout } from '@/components/TitleBar';
import { PROJECT_RIGHT_PANEL_VISIBILITY_EVENT, CLOSE_PROJECT_RIGHT_PANEL_EVENT } from '@/panels/projectRightPanelEvents';
import { FilePreviewTabs } from '@/components/ai/FilePreviewTabs';
import { filePreviewScope, useFilePreviewTabs } from '@/store/filePreviewTabs';
import { useStore } from '@/store/useStore';
import BrowserOpenButton from './BrowserOpenButton';
import WorkspaceToolsLayout from './WorkspaceToolsLayout';

vi.mock('@/components/WorkspaceMainSurface', () => ({ default: () => {
  const scope = filePreviewScope(useStore((state) => state.composer.workspace));
  return <div data-ugs-chat-surface><TitleBarContent enabled><header>
    <FilePreviewTabs scope={scope}><button>测试会话</button></FilePreviewTabs>
    <div className="ugs-chat-header-actions"><BrowserOpenButton scope={scope} /><button>复制</button></div>
  </header></TitleBarContent>聊天</div>;
} }));
vi.mock('./BrowserPane', () => ({ default: ({ onClose, expanded, visible = true, onExpandedChange }: { onClose: () => void; expanded: boolean; visible?: boolean; onExpandedChange: (value: boolean) => void }) => <aside data-ugs-browser-panel data-expanded={expanded} hidden={!visible}><button onClick={() => onExpandedChange(!expanded)}>{expanded ? '还原侧栏' : '放大浏览器'}</button><button onClick={onClose}>关闭浏览器</button></aside> }));

function SurfaceControls() {
  const { setSurface } = useMainSurface();
  return <><button onClick={() => setSurface('scheduled-tasks')}>切换到任务</button><button onClick={() => setSurface('chat')}>切换到会话</button></>;
}

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  useFilePreviewTabs.setState({ tabs: [], activeByScope: {}, browserTabs: [] });
  useStore.setState({ composer: { ...useStore.getState().composer, workspace: 'E:/Game' } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<MainSurfaceProvider><TitleBarLayout><WorkspaceToolsLayout /><SurfaceControls /></TitleBarLayout></MainSurfaceProvider>));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useFilePreviewTabs.setState({ tabs: [], activeByScope: {}, browserTabs: [] }); });

async function click(selector: string) {
  const button = container.querySelector<HTMLElement>(selector);
  expect(button).not.toBeNull();
  await act(async () => button!.click());
}

async function clickText(text: string) {
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent === text);
  expect(button).not.toBeUndefined();
  await act(async () => button!.click());
}

describe('标题栏浏览器入口', () => {
  it('每次点击都新建浏览器标签，切换及关闭时保留其他标签', async () => {
    await click('[aria-label="打开浏览器"]');
    const first = container.querySelector<HTMLElement>('[data-ugs-browser-panel]')!;
    await click('[aria-label="打开浏览器"]');
    const tabs = container.querySelectorAll<HTMLElement>('[role="tab"][aria-label="浏览器"]');
    const panes = container.querySelectorAll<HTMLElement>('[data-ugs-browser-panel]');
    expect(tabs).toHaveLength(2);
    expect(panes).toHaveLength(2);
    expect(first.hidden).toBe(true);
    expect(panes[1].hidden).toBe(false);
    await act(async () => tabs[0].click());
    expect(first.hidden).toBe(false);
    expect(panes[1].hidden).toBe(true);
    const closeButtons = container.querySelectorAll<HTMLButtonElement>('[aria-label="关闭预览：浏览器"]');
    await act(async () => closeButtons[0].click());
    expect(container.querySelectorAll('[role="tab"][aria-label="浏览器"]')).toHaveLength(1);
    expect(container.querySelector('[data-ugs-browser-panel]')).toBe(panes[1]);
    expect(panes[1].hidden).toBe(false);
  });

  it('位于标题栏操作区首位，移除原工作区悬浮工具', async () => {
    const action = container.querySelector<HTMLButtonElement>('[aria-label="打开浏览器"]')!;
    expect(action.closest('.ugs-titlebar-content')).not.toBeNull();
    expect(action.parentElement?.firstElementChild).toBe(action);
    expect(container.querySelector('.ugs-workspace-chat-region [aria-label="快捷工具"]')).toBeNull();
    expect(container.querySelector('.ugs-workspace-chat-region [aria-label="会话文件"]')).toBeNull();
    expect(container.querySelector('.ugs-workspace-chat-region [aria-label="项目文件"]')).toBeNull();
    expect(container.querySelector('.ugs-workspace-chat-region [aria-label="新建临时聊天"]')).toBeNull();
  });

  it('首次点击直接打开信息流标签，不关闭项目文件面板', async () => {
    const closed = vi.fn();
    window.addEventListener(CLOSE_PROJECT_RIGHT_PANEL_EVENT, closed);
    try {
      await click('[aria-label="打开浏览器"]');
      const pane = container.querySelector<HTMLElement>('[data-ugs-browser-panel]')!;
      expect(pane.dataset.expanded).toBe('true');
      expect(pane.hidden).toBe(false);
      expect(container.querySelector('[role="tab"][aria-label="浏览器"]')?.getAttribute('aria-selected')).toBe('true');
      expect(closed).not.toHaveBeenCalled();
    } finally { window.removeEventListener(CLOSE_PROJECT_RIGHT_PANEL_EVENT, closed); }
  });

  it('切换会话时保留浏览器，重新点击入口新建标签', async () => {
    await click('[aria-label="打开浏览器"]');
    const first = container.querySelector<HTMLElement>('[data-ugs-browser-panel]')!;
    await click('[aria-label="会话信息流"]');
    expect(first.hidden).toBe(true);
    await click('[aria-label="打开浏览器"]');
    const panes = container.querySelectorAll<HTMLElement>('[data-ugs-browser-panel]');
    expect(panes).toHaveLength(2);
    expect(panes[0]).toBe(first);
    expect(first.hidden).toBe(true);
    expect(panes[1].hidden).toBe(false);
    expect(container.querySelectorAll('[role="tab"][aria-label="浏览器"]')).toHaveLength(2);
  });

  it('切换文件、工作区和其他主界面时隐藏网页，返回后保留原浏览器', async () => {
    await click('[aria-label="打开浏览器"]');
    const pane = container.querySelector<HTMLElement>('[data-ugs-browser-panel]')!;
    await act(async () => useFilePreviewTabs.getState().open({ scope: 'e:/game', ref: { path: 'one.md', basename: 'one.md' }, previewFile: vi.fn(), diffEnabled: false, canOpenExternally: false }));
    expect(pane.hidden).toBe(true);
    await click('[role="tab"][aria-label="浏览器"]');
    expect(pane.hidden).toBe(false);
    await act(async () => useStore.setState({ composer: { ...useStore.getState().composer, workspace: 'E:/Other' } }));
    expect(pane.hidden).toBe(true);
    await act(async () => useStore.setState({ composer: { ...useStore.getState().composer, workspace: 'E:/Game' } }));
    expect(pane.hidden).toBe(false);
    await clickText('切换到任务');
    expect(pane.hidden).toBe(true);
    await clickText('切换到会话');
    expect(container.querySelector('[data-ugs-browser-panel]')).toBe(pane);
    expect(pane.hidden).toBe(false);
  });

  it('还原到侧栏后点击标题栏，新建标签并保留原浏览器', async () => {
    await click('[aria-label="打开浏览器"]');
    const pane = container.querySelector<HTMLElement>('[data-ugs-browser-panel]')!;
    await clickText('还原侧栏');
    expect(container.querySelector('[role="tab"][aria-label="浏览器"]')).toBeNull();
    expect(pane.dataset.expanded).toBe('false');
    expect(pane.hidden).toBe(false);
    await click('[aria-label="打开浏览器"]');
    const panes = container.querySelectorAll<HTMLElement>('[data-ugs-browser-panel]');
    expect(panes).toHaveLength(2);
    expect(panes[0]).toBe(pane);
    expect(pane.dataset.expanded).toBe('true');
    expect(pane.hidden).toBe(true);
    expect(panes[1].hidden).toBe(false);
    expect(container.querySelectorAll('[role="tab"][aria-label="浏览器"]')).toHaveLength(2);
  });

  it('手动还原到侧栏后，打开文件面板会关闭浏览器侧栏', async () => {
    await click('[aria-label="打开浏览器"]');
    await clickText('还原侧栏');
    await act(async () => window.dispatchEvent(new CustomEvent(PROJECT_RIGHT_PANEL_VISIBILITY_EVENT, { detail: { open: true } })));
    expect(container.querySelector('[data-ugs-browser-panel]')).toBeNull();
  });
});
