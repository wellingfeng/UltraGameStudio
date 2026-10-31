import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MainSurfaceProvider } from '@/components/MainSurface';
import { OPEN_TEMPORARY_CHAT_EVENT } from '@/components/temporaryChat/TemporaryChatWindows';
import { CLOSE_PROJECT_RIGHT_PANEL_EVENT, PROJECT_RIGHT_PANEL_VISIBILITY_EVENT, SELECT_PROJECT_RIGHT_PANEL_TAB_EVENT } from '@/panels/projectRightPanelEvents';
import WorkspaceToolsLayout from './WorkspaceToolsLayout';

vi.mock('@/components/WorkspaceMainSurface', () => ({ default: () => <div data-ugs-chat-surface>聊天</div> }));
vi.mock('./BrowserPane', () => ({ default: ({ onClose, expanded, onExpandedChange }: { onClose: () => void; expanded: boolean; onExpandedChange: (value: boolean) => void }) => <aside data-ugs-browser-panel><button onClick={() => onExpandedChange(!expanded)}>{expanded ? '还原侧栏' : '放大浏览器'}</button><button onClick={onClose}>关闭浏览器</button></aside> }));

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<MainSurfaceProvider><WorkspaceToolsLayout /></MainSurfaceProvider>));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

function button(label: string): HTMLButtonElement {
  const result = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(result).not.toBeNull();
  return result!;
}

function toolbar(): HTMLElement {
  return container.querySelector<HTMLElement>('[role="toolbar"]')!;
}

async function enterToolbar() {
  await act(async () => toolbar().dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
}

async function leaveToolbar() {
  await act(async () => toolbar().dispatchEvent(new MouseEvent('mouseout', { bubbles: true })));
}

describe('右上角快捷工具', () => {
  it('仅显示四个图标，并切换现有文件面板', async () => {
    expect(container.querySelector('[role="toolbar"]')?.querySelectorAll('button')).toHaveLength(4);
    await enterToolbar();
    const selected = vi.fn();
    window.addEventListener(SELECT_PROJECT_RIGHT_PANEL_TAB_EVENT, selected);
    await act(async () => button('会话文件').click());
    expect(selected.mock.calls[0][0].detail.tab).toBe('session');
    await act(async () => window.dispatchEvent(new CustomEvent(PROJECT_RIGHT_PANEL_VISIBILITY_EVENT, { detail: { open: true, tab: 'session' } })));
    expect(button('会话文件').getAttribute('aria-pressed')).toBe('true');
    await act(async () => button('项目文件').click());
    expect(selected.mock.calls[1][0].detail.tab).toBe('files');
    window.removeEventListener(SELECT_PROJECT_RIGHT_PANEL_TAB_EVENT, selected);
  });

  it('浏览器与文件面板互斥，临时聊天沿用现有入口', async () => {
    const closed = vi.fn();
    const chat = vi.fn();
    window.addEventListener(CLOSE_PROJECT_RIGHT_PANEL_EVENT, closed);
    window.addEventListener(OPEN_TEMPORARY_CHAT_EVENT, chat);
    await enterToolbar();
    await act(async () => button('浏览器').click());
    expect(closed).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-ugs-browser-panel]')).not.toBeNull();
    await act(async () => button('新建临时聊天').click());
    expect(chat).toHaveBeenCalledOnce();
    await act(async () => button('项目文件').click());
    expect(container.querySelector('[data-ugs-browser-panel]')).toBeNull();
    window.removeEventListener(CLOSE_PROJECT_RIGHT_PANEL_EVENT, closed);
    window.removeEventListener(OPEN_TEMPORARY_CHAT_EVENT, chat);
  });

  it('放大时隐藏信息流，恢复时保留浏览器并显示信息流', async () => {
    await act(async () => button('浏览器').click());
    const pane = container.querySelector('[data-ugs-browser-panel]');
    const region = container.querySelector<HTMLElement>('.ugs-workspace-chat-region')!;
    await act(async () => [...container.querySelectorAll('button')].find((item) => item.textContent === '放大浏览器')!.click());
    expect(region.style.display).toBe('none');
    expect(container.querySelector('[data-ugs-browser-panel]')).toBe(pane);
    await act(async () => [...container.querySelectorAll('button')].find((item) => item.textContent === '还原侧栏')!.click());
    expect(region.style.display).toBe('');
    expect(container.querySelector('[data-ugs-browser-panel]')).toBe(pane);
    expect(toolbar().dataset.expanded).toBe('false');
  });
  it('默认收起，靠近展开，离开一秒后收起', async () => {
    vi.useFakeTimers();
    try {
      const more = container.querySelector<HTMLElement>('.ugs-floating-tools-more')!;
      expect(toolbar().dataset.expanded).toBe('false');
      expect(more.getAttribute('aria-hidden')).toBe('true');
      expect(button('浏览器').tabIndex).toBe(0);
      expect(button('会话文件').tabIndex).toBe(-1);
      await enterToolbar();
      expect(toolbar().dataset.expanded).toBe('true');
      expect(more.getAttribute('aria-hidden')).toBe('false');
      expect(button('会话文件').tabIndex).toBe(0);
      await leaveToolbar();
      await act(async () => vi.advanceTimersByTime(999));
      expect(toolbar().dataset.expanded).toBe('true');
      await act(async () => vi.advanceTimersByTime(1));
      expect(toolbar().dataset.expanded).toBe('false');
    } finally {
      vi.useRealTimers();
    }
  });

  it('延时期间重新靠近会取消收起', async () => {
    vi.useFakeTimers();
    try {
      await enterToolbar();
      await leaveToolbar();
      await act(async () => vi.advanceTimersByTime(500));
      await enterToolbar();
      await act(async () => vi.advanceTimersByTime(1000));
      expect(toolbar().dataset.expanded).toBe('true');
      await leaveToolbar();
      await act(async () => vi.advanceTimersByTime(1000));
      expect(toolbar().dataset.expanded).toBe('false');
    } finally {
      vi.useRealTimers();
    }
  });

  it('鼠标点击后的焦点不会阻止离开时收起', async () => {
    vi.useFakeTimers();
    try {
      const browser = button('浏览器');
      const matches = vi.spyOn(browser, 'matches').mockReturnValue(false);
      await enterToolbar();
      await act(async () => browser.focus());
      await leaveToolbar();
      await act(async () => vi.advanceTimersByTime(1000));
      expect(toolbar().dataset.expanded).toBe('false');
      matches.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('收起前移除隐藏入口的鼠标焦点', async () => {
    vi.useFakeTimers();
    try {
      await enterToolbar();
      const fileButton = button('会话文件');
      const matches = vi.spyOn(fileButton, 'matches').mockReturnValue(false);
      await act(async () => fileButton.focus());
      await leaveToolbar();
      await act(async () => vi.advanceTimersByTime(1000));
      expect(toolbar().dataset.expanded).toBe('false');
      expect(document.activeElement).not.toBe(fileButton);
      matches.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('键盘聚焦时保持展开，焦点移出后延时收起', async () => {
    vi.useFakeTimers();
    const outside = document.createElement('button');
    document.body.append(outside);
    try {
      await act(async () => button('浏览器').focus());
      expect(toolbar().dataset.expanded).toBe('true');
      await act(async () => button('会话文件').focus());
      await enterToolbar();
      await leaveToolbar();
      await act(async () => vi.advanceTimersByTime(1000));
      expect(toolbar().dataset.expanded).toBe('true');
      await act(async () => outside.focus());
      await act(async () => vi.advanceTimersByTime(1000));
      expect(toolbar().dataset.expanded).toBe('false');
    } finally {
      outside.remove();
      vi.useRealTimers();
    }
  });
});
