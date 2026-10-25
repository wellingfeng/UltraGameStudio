import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultBlueprint } from '@/core/defaultBlueprint';
import { defaultComposer, samplePromptGroups } from '@/store/sampleSessions';
import { useStore } from '@/store/useStore';
import AIDock from './AIDock';
import ProjectFileTree from './ProjectFileTree';

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/tauri')>(),
  tauriAvailable: () => true,
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  window.localStorage.clear();
  useStore.setState({
    mode: 'design',
    workflow: defaultBlueprint('Workspace design'),
    selectedNodeId: null,
    aiStreaming: false,
    aiEditingSessions: [],
    chattingSessions: [],
    locale: 'zh-CN',
    promptGroups: samplePromptGroups,
    composer: { ...defaultComposer, workspace: 'E:\\UltraGameStudio' },
    composerDraft: '',
    composerDrafts: {},
    composerFocusVersion: 0,
    composerToolButtonsVisible: false,
    composerHintRowVisible: false,
    messages: [{ id: 'answer', role: 'assistant', text: 'Ready.', createdAt: Date.now() }],
    activeWorkspaceId: null,
    activeSessionId: 's_workspace_design',
    workspaceHistory: [],
    runningSessionProgress: {},
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

async function renderDock() {
  await act(async () => root.render(<AIDock layout="chat" />));
}

describe('UGS focused workspace composer', () => {
  it('shows session totals above the input and clears them on session switch', async () => {
    useStore.setState({ messages: [
      { id: 'u', role: 'user', text: 'edit', createdAt: 1 },
      { id: 'a', role: 'assistant', text: 'done', createdAt: 2, fileChanges: {
        source: 'agent', rootPath: 'E:/UltraGameStudio', files: [
          { path: 'app.ts', added: 8, deleted: 3 }, { path: 'readme.md', added: 2, deleted: 0 },
        ],
      } },
    ] });
    await renderDock();
    const summary = container.querySelector<HTMLElement>('[data-ugs-session-changes]');
    expect(summary).not.toBeNull();
    expect(summary?.textContent).toContain('2 个文件');
    expect(summary?.textContent).toContain('+10');
    expect(summary?.textContent).toContain('−3');
    const inputCard = container.querySelector('.ugs-ai-input-card');
    expect(summary!.compareDocumentPosition(inputCard!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => useStore.setState({ activeSessionId: 'empty-session', messages: [] }));
    expect(container.querySelector('[data-ugs-session-changes]')).toBeNull();
  });
  it('provides a manual file-panel entry whose expanded state follows closing', async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 });
    useStore.setState({ composer: { ...defaultComposer, workspace: '' } });
    try {
      await act(async () => root.render(<><AIDock layout="chat" /><ProjectFileTree /></>));
      const trigger = container.querySelector<HTMLButtonElement>('[data-ugs-file-panel-toggle]');
      expect(trigger).not.toBeNull();
      expect(trigger?.getAttribute('aria-expanded')).toBe('false');
      expect(trigger?.getAttribute('aria-label')).toBe('显示右侧栏');
      expect(trigger?.textContent).toBe('');
      expect(trigger?.parentElement?.lastElementChild).toBe(trigger);
      await act(async () => trigger!.click());
      expect(trigger?.getAttribute('aria-expanded')).toBe('true');
      expect(trigger?.getAttribute('aria-label')).toBe('隐藏右侧栏');
      expect(container.querySelector('#ugs-project-file-panel')).not.toBeNull();
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="收起文件面板"]')!.click());
      expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
    }
  });

  it.skip('starts with a compact composer and grows with draft content (awaiting edit approval)', async () => {
    await renderDock();
    const section = container.querySelector<HTMLElement>('[data-ugs-composer]');
    const input = container.querySelector<HTMLTextAreaElement>('.ugs-ai-input-card textarea');
    expect(section).not.toBeNull();
    expect(input).not.toBeNull();
    expect(parseFloat(section!.style.height)).toBeLessThanOrEqual(180);
    const initial = parseFloat(section!.style.height);
    Object.defineProperty(input!, 'scrollHeight', { configurable: true, value: 220 });
    await act(async () => useStore.getState().setComposerDraft('A longer draft\nwith several lines'));
    expect(parseFloat(section!.style.height)).toBeGreaterThan(initial);
    await act(async () => useStore.getState().setComposerDraft(''));
    Object.defineProperty(input!, 'scrollHeight', { configurable: true, value: 24 });
    await act(async () => useStore.getState().setComposerDraft('short'));
    expect(parseFloat(section!.style.height)).toBe(initial);
  });

  it('keeps startup and cache options in an accessible secondary disclosure', async () => {
    await renderDock();
    const trigger = container.querySelector<HTMLButtonElement>('[data-ugs-composer-options-trigger]');
    expect(trigger).not.toBeNull();
    expect(trigger!.getAttribute('aria-expanded')).toBe('false');
    const panel = container.querySelector<HTMLElement>('[data-ugs-composer-options-panel]');
    expect(panel?.hidden).toBe(true);
    await act(async () => trigger!.click());
    expect(trigger!.getAttribute('aria-expanded')).toBe('true');
    expect(panel?.hidden).toBe(false);
    expect(panel?.querySelector('[title*="缓存"]')).not.toBeNull();
    expect(panel?.querySelector('[title*="启动"]')).not.toBeNull();
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(panel?.hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps high-risk permission visible without a solid danger fill when enabled', async () => {
    useStore.setState({ composerHintRowVisible: true });
    await act(async () => useStore.setState({ composer: { ...useStore.getState().composer, permission: 'full' } }));
    await renderDock();
    const active = container.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]');
    expect(active?.textContent).toContain('完全访问权限');
    expect(active?.className).toContain('text-status-warning');
    expect(active?.className).not.toContain('bg-status-error text-status-error-contrast');
    expect(active?.querySelector('svg')).not.toBeNull();
  });

  it('renders conversation actions as quiet controls and gives send the primary style', async () => {
    await renderDock();
    const actions = Array.from(container.querySelectorAll<HTMLButtonElement>('button'));
    const copy = actions.find((button) => button.title === '复制会话' || button.title === '复制');
    expect(copy).toBeDefined();
    expect(copy?.className).not.toContain('border-border bg-panel-2');
    expect(copy?.className).toContain('ugs-control');
    const send = actions.find((button) => button.querySelector('.lucide-arrow-up'));
    expect(send?.className).toContain('ugs-composer-send');
    expect(send?.className).toContain('bg-accent');
  });
});
