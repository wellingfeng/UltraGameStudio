import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultComposer } from '@/store/sampleSessions';
import { useStore } from '@/store/useStore';
import ProjectFileTree from './ProjectFileTree';
import SessionChangesSummary from '@/components/ai/SessionChangesSummary';
import { collectSessionFileChanges } from '@/lib/turnFileChanges';
import { encodeToolPatch } from '@/components/ai/lib/toolEvent';
import { requestProjectRightPanelFilePreview, requestProjectRightPanelToggle, requestProjectRightPanelSessionFiles } from './projectRightPanelEvents';
import { listWorkspaceDirectory, previewLocalFile } from '@/lib/tauri';

// Only the desktop filesystem boundary is stubbed; the panel, store, resize
// hook, file tree, and embedded preview remain their real implementations.
vi.mock('@/lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tauri')>();
  return {
    ...actual,
    listWorkspaceDirectory: vi.fn(async (rootPath: string, relativePath: string) => ({
      rootPath,
      relativePath,
      entries: [],
      truncated: false,
      totalEntries: 0,
    })),
    previewLocalFile: vi.fn(async (path: string) => ({
      path,
      fileName: path.split(/[\\/]/).pop() ?? path,
      kind: 'text' as const,
      text: '',
      mime: 'text/plain',
      sizeBytes: 0,
      truncated: false,
    })),
    workspaceFileDiff: vi.fn(async () => null),
  };
});

const originalInnerWidth = window.innerWidth;
let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 });
  useStore.setState({
    locale: 'zh-CN',
    workspaces: [],
    activeWorkspaceId: null,
    activeSessionId: 'file-panel-layout',
    composer: { ...defaultComposer, workspace: '', workspaceFolders: [] },
    messages: [],
    aiEditingSessions: [],
    chattingSessions: [],
    runningSessions: [],
  });
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  container.remove();
  window.localStorage.clear();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
  vi.restoreAllMocks();
});

async function renderPanel(): Promise<void> {
  root = createRoot(container);
  await act(async () => { root!.render(<ProjectFileTree />); });
}

function panel(): HTMLElement {
  const aside = container.querySelector('aside');
  expect(aside).toBeInstanceOf(HTMLElement);
  return aside!;
}

describe('ProjectFileTree on-demand layout', () => {
  it.each(['files', 'session'])('locks the %s tab across outside clicks, session changes and remounts', async (tab) => {
    await renderPanel();
    await act(async () => {
      if (tab === 'session') requestProjectRightPanelSessionFiles();
      else requestProjectRightPanelToggle();
    });
    const lock = panel().querySelector<HTMLButtonElement>('[aria-label="锁定文件面板"]')!;
    expect(lock.previousElementSibling?.getAttribute('aria-label')).toBe('收起文件面板');
    await act(async () => lock.click());
    expect(lock.getAttribute('aria-pressed')).toBe('true');
    expect(window.localStorage.getItem('ultragamestudio.projectRightPanelLocked.v1')).toBe('true');
    await act(async () => document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    expect(panel()).not.toBeNull();
    await act(async () => useStore.setState({ activeSessionId: 'another-session', activeWorkspaceId: 'another-workspace' }));
    expect(panel()).not.toBeNull();
    await act(async () => root!.unmount());
    await renderPanel();
    expect(panel().querySelector('[aria-pressed="true"][aria-label="解锁文件面板"]')).not.toBeNull();
    await act(async () => panel().querySelector<HTMLButtonElement>('[aria-label="解锁文件面板"]')!.click());
    expect(panel()).not.toBeNull();
    await act(async () => document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    expect(container.querySelector('aside')).toBeNull();
    expect(window.localStorage.getItem('ultragamestudio.projectRightPanelLocked.v1')).toBe('false');
  });

  it('allows manual close while locked and returns to locked tabs when a preview closes', async () => {
    window.localStorage.setItem('ultragamestudio.projectRightPanelLocked.v1', 'true');
    await renderPanel();
    await act(async () => panel().querySelector<HTMLButtonElement>('[aria-label="收起文件面板"]')!.click());
    expect(container.querySelector('aside')).toBeNull();
    await act(async () => requestProjectRightPanelFilePreview({ ref: { path: 'app.ts', basename: 'app.ts' }, cwd: 'E:/Game' }));
    expect(panel().querySelector('[role="tablist"]')).toBeNull();
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(panel().querySelector('[role="tablist"]')).not.toBeNull();
    expect(panel().querySelector('[aria-label="解锁文件面板"]')).not.toBeNull();
  });

  it.each(['files', 'session'])('closes the %s tab on an outside blank-area pointer press', async (tab) => {
    await renderPanel();
    await act(async () => {
      if (tab === 'session') requestProjectRightPanelSessionFiles();
      else requestProjectRightPanelToggle();
    });
    expect(panel()).not.toBeNull();
    await act(async () => document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    expect(container.querySelector('aside')).toBeNull();
  });

  it('keeps file tabs open for inside clicks and resize gestures', async () => {
    await renderPanel();
    await act(async () => requestProjectRightPanelSessionFiles());
    const projectTab = container.querySelector<HTMLButtonElement>('[role="tab"]')!;
    await act(async () => {
      projectTab.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      projectTab.click();
    });
    expect(panel().querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('项目文件');
    const handle = panel().querySelector<HTMLElement>('[title="拖动调整宽度"]')!;
    await act(async () => handle.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    expect(panel()).not.toBeNull();
  });

  it('preserves the toggle button through pointerdown so a real click closes the panel', async () => {
    const toggle = document.createElement('button');
    toggle.setAttribute('aria-controls', 'ugs-project-file-panel');
    toggle.addEventListener('click', requestProjectRightPanelToggle);
    await renderPanel();
    document.body.appendChild(toggle);
    try {
      await act(async () => toggle.click());
      await act(async () => toggle.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
      expect(panel()).not.toBeNull();
      await act(async () => toggle.click());
      expect(container.querySelector('aside')).toBeNull();
    } finally {
      toggle.remove();
    }
  });

  it('closes on a chat blank-area press even if its handler stops propagation', async () => {
    await renderPanel();
    await act(async () => requestProjectRightPanelSessionFiles());
    const blank = document.createElement('div');
    blank.addEventListener('pointerdown', (event) => event.stopPropagation());
    document.body.appendChild(blank);
    try {
      await act(async () => blank.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
      expect(container.querySelector('aside')).toBeNull();
    } finally {
      blank.remove();
    }
  });

  it('keeps the project file context menu clickable outside the aside', async () => {
    vi.mocked(listWorkspaceDirectory).mockResolvedValueOnce({
      rootPath: 'E:/Game', relativePath: '', truncated: false, totalEntries: 1,
      entries: [{ name: 'app.ts', relativePath: 'app.ts', path: 'E:/Game/app.ts', kind: 'file', hidden: false }],
    });
    useStore.setState({ composer: { ...defaultComposer, workspace: 'E:/Game' } });
    await renderPanel();
    await act(async () => requestProjectRightPanelToggle());
    const file = panel().querySelector<HTMLButtonElement>('button[draggable="true"]')!;
    await act(async () => file.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    const menu = container.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu).not.toBeNull();
    expect(panel().contains(menu)).toBe(false);
    await act(async () => menu.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    expect(panel()).not.toBeNull();
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
  });

  it('starts hidden with a remembered tab and collapses again when switching sessions', async () => {
    window.localStorage.setItem('ultragamestudio.projectRightPanelTab.v1', 'session');
    await renderPanel();
    expect(container.querySelector('aside')).toBeNull();
    await act(async () => requestProjectRightPanelSessionFiles());
    expect(panel()).not.toBeNull();
    await act(async () => useStore.setState({ activeSessionId: 'another-session' }));
    expect(container.querySelector('aside')).toBeNull();
  });

  it('opens the hidden session tab from the summary with the same confirmed files', async () => {
    const event = (id: string, status: 'done' | 'running' | 'error', path: string) =>
      encodeToolPatch({ id, name: 'Edit', status, args: { file_path: path } });
    useStore.setState({
      composer: { ...defaultComposer, workspace: 'E:/Game' },
      messages: [
        { id: 'u1', role: 'user', text: 'first turn', createdAt: 1 },
        { id: 'saved', role: 'assistant', createdAt: 2,
          text: event('saved-tool', 'done', 'src/app.ts'),
          fileChanges: { source: 'agent', rootPath: 'E:/Game', files: [
            { path: 'src/app.ts', added: 3, deleted: 1 },
            { path: '.ultragamestudio/docs/report.md', added: 2, deleted: 0 },
          ] } },
        { id: 'u2', role: 'user', text: 'second turn', createdAt: 3 },
        { id: 'live', role: 'assistant', createdAt: 4,
          text: event('live-tool', 'done', 'E:\\Game\\src\\APP.ts') +
            event('unfinished', 'running', 'unfinished.ts') +
            event('failed', 'error', 'failed.ts') },
        { id: 'note', role: 'assistant', localOnly: true, createdAt: 5,
          text: event('local-tool', 'done', 'unrelated.ts') },
      ],
    });
    const changes = collectSessionFileChanges(useStore.getState().messages, 'E:/Game')!;
    root = createRoot(container);
    await act(async () => root!.render(<>
      <SessionChangesSummary changes={changes} locale="zh-CN" onOpenSessionFiles={requestProjectRightPanelSessionFiles} />
      <ProjectFileTree />
    </>));
    expect(container.querySelector('aside')).toBeNull();
    const summary = container.querySelector<HTMLButtonElement>('[data-ugs-session-changes] button')!;
    expect(summary.textContent).toContain('已修改 2 个文件');
    await act(async () => summary.click());
    for (let i = 0; i < 3; i++) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('会话文件2');
    const paths = Array.from(panel().querySelectorAll<HTMLButtonElement>('button[draggable="true"]')).map((button) => button.title);
    expect(paths).toHaveLength(changes.files.length);
    expect(paths).toEqual(expect.arrayContaining(changes.files.map((file) => file.path)));
    expect(container.querySelector('[data-ugs-session-changes] details')).toBeNull();
    await act(async () => summary.click());
    expect(panel()).not.toBeNull();
    expect(window.localStorage.getItem('ultragamestudio.projectRightPanelTab.v1')).toBe('session');
  });
  it('returns to the session-files tab from an embedded preview', async () => {
    await renderPanel();
    await act(async () => requestProjectRightPanelFilePreview({ ref: { path: 'app.ts', basename: 'app.ts' }, cwd: 'E:/Game' }));
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    await act(async () => requestProjectRightPanelSessionFiles());
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('会话文件');
    expect(container.querySelector('[aria-label="关闭"]')).toBeNull();
  });
  it('starts completely hidden instead of reserving a file rail', async () => {
    await renderPanel();
    expect(container.querySelector('aside')).toBeNull();
    expect(container.querySelector('[role="tablist"]')).toBeNull();
  });
  it('does not read workspace files until the hidden panel is opened', async () => {
    vi.mocked(listWorkspaceDirectory).mockClear();
    vi.mocked(previewLocalFile).mockClear();
    useStore.setState({ composer: { ...defaultComposer, workspace: 'E:/Game' } });
    await renderPanel();
    expect(listWorkspaceDirectory).not.toHaveBeenCalled();
    expect(previewLocalFile).not.toHaveBeenCalled();
    await act(async () => requestProjectRightPanelToggle());
    expect(listWorkspaceDirectory).toHaveBeenCalled();
  });
  it('resets a preview when switching sessions instead of displaying the previous file', async () => {
    await renderPanel();
    await act(async () => requestProjectRightPanelFilePreview({ ref: { path: 'old.ts', basename: 'old.ts' } }));
    expect(panel()).not.toBeNull();
    await act(async () => useStore.setState({ activeSessionId: 'new-session' }));
    expect(container.querySelector('aside')).toBeNull();
  });
  it('opens a requested preview and releases all width when it closes', async () => {
    await renderPanel();
    let accepted = false;
    await act(async () => {
      accepted = requestProjectRightPanelFilePreview({
        ref: { path: 'app.ts', basename: 'app.ts' }, cwd: 'E:/Game',
      });
    });
    expect(accepted).toBe(true);
    expect(panel().style.width).toBe('280px');
    expect(container.textContent).toContain('app.ts');
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(container.querySelector('aside')).toBeNull();
  });
  it('opens the file tabs manually and closes without leaving a rail', async () => {
    await renderPanel();
    await act(async () => requestProjectRightPanelToggle());
    expect(container.querySelector('[role="tablist"]')).not.toBeNull();
    expect(panel().id).toBe('ugs-project-file-panel');
    const close = container.querySelector<HTMLButtonElement>('[aria-label="收起文件面板"]');
    expect(close).not.toBeNull();
    await act(async () => close!.click());
    expect(container.querySelector('aside')).toBeNull();
    await act(async () => requestProjectRightPanelToggle());
    expect(panel().style.width).toBe('280px');
  });
  it('retains scrollbar feedback after the initially hidden file list mounts', async () => {
    await renderPanel();
    await act(async () => requestProjectRightPanelToggle());
    const list = container.querySelector<HTMLElement>('.ugs-autohide-scroll')!;
    list.dispatchEvent(new Event('scroll'));
    expect(list.classList.contains('is-scrolling')).toBe(true);
  });
  it('declines embedded preview at narrow widths so the caller can use its overlay', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 900 });
    await renderPanel();
    expect(requestProjectRightPanelFilePreview({ ref: { path: 'app.ts', basename: 'app.ts' } })).toBe(false);
    expect(container.querySelector('aside')).toBeNull();
  });
});
