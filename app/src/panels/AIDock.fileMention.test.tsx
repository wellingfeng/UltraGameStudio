import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AIDock from './AIDock';
import { defaultBlueprint } from '@/core/defaultBlueprint';
import { defaultComposer, samplePromptGroups } from '@/store/sampleSessions';
import { useStore } from '@/store/useStore';
import {
  OPEN_PROJECT_RIGHT_PANEL_FILE_PREVIEW_EVENT,
  type OpenProjectRightPanelFilePreviewEventDetail,
} from './projectRightPanelEvents';
import {
  remoteWorkspacePath,
  saveRemoteWorkspace,
} from '@/lib/remoteWorkspace';
import { CLOUD_PROJECTS_ENABLED } from '@/lib/cloudProjects';

const tauriMocks = vi.hoisted(() => ({
  listWorkspaceDirectory: vi.fn(),
}));

const dialogMocks = vi.hoisted(() => ({
  open: vi.fn(),
}));

const remoteWorkspaceMocks = vi.hoisted(() => ({
  listRemoteWorkspaceDirectory: vi.fn(),
}));

vi.mock('@/lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tauri')>();
  return {
    ...actual,
    tauriAvailable: () => true,
    fileExists: vi.fn(async () => true),
    listWorkspaceDirectory: tauriMocks.listWorkspaceDirectory,
    slashCatalog: async () => ({
      scannedAtMs: 1,
      ready: true,
      entries: [],
    }),
    onSlashCatalogUpdated: async () => () => {},
  };
});

vi.mock('@/lib/remoteWorkspace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/remoteWorkspace')>();
  return {
    ...actual,
    listRemoteWorkspaceDirectory:
      remoteWorkspaceMocks.listRemoteWorkspaceDirectory,
  };
});

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: dialogMocks.open,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

(globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver =
  ResizeObserverStub as typeof ResizeObserver;

function resetStore(
  options: { workspace?: string; workspaceFolders?: string[] } = {},
): void {
  useStore.setState({
    mode: 'design',
    workflow: defaultBlueprint('File mention'),
    selectedNodeId: null,
    aiStreaming: false,
    aiEditingSessions: [],
    chattingSessions: [],
    locale: 'zh-CN',
    promptGroups: samplePromptGroups,
    composer: {
      ...defaultComposer,
      workspace: options.workspace ?? 'E:\\UltraGameStudio',
      workspaceFolders: options.workspaceFolders ?? [],
    },
    composerDraft: '',
    composerDrafts: {},
    composerFocusVersion: 0,
    messages: [],
    activeWorkspaceId: null,
    activeSessionId: 's_file_mention',
    workspaceHistory: [],
    runningSessionProgress: {},
  });
}

async function renderDock(): Promise<{
  container: HTMLDivElement;
  cleanup: () => Promise<void>;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(<AIDock />);
  });
  await act(async () => {
    await Promise.resolve();
  });

  return {
    container,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function textarea(container: HTMLElement): HTMLTextAreaElement {
  const input = container.querySelector('textarea');
  if (!input) throw new Error('Missing AI input textarea');
  return input;
}

function typeTextarea(input: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
  input.setSelectionRange(value.length, value.length);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function keyDown(input: HTMLTextAreaElement, key: string): void {
  input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitForExpect(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await flushAsync();
    }
  }
  throw lastError;
}

afterEach(() => {
  tauriMocks.listWorkspaceDirectory.mockReset();
  dialogMocks.open.mockReset();
  remoteWorkspaceMocks.listRemoteWorkspaceDirectory.mockReset();
  window.localStorage.clear();
  document.body.innerHTML = '';
});

describe('AIDock file mentions', () => {
  it('routes clicked chat file chips into the project right panel when available', async () => {
    resetStore();
    useStore.setState({
      messages: [
        {
          id: 'u_file_preview',
          role: 'user',
          createdAt: 1,
          text: 'app/src/App.tsx',
        },
      ],
    });
    const capturedDetail: {
      current: OpenProjectRightPanelFilePreviewEventDetail | null;
    } = { current: null };
    const handlePreviewRequest = (event: Event) => {
      capturedDetail.current =
        (event as CustomEvent<OpenProjectRightPanelFilePreviewEventDetail>)
          .detail;
      event.preventDefault();
    };
    window.addEventListener(
      OPEN_PROJECT_RIGHT_PANEL_FILE_PREVIEW_EVENT,
      handlePreviewRequest,
    );
    const view = await renderDock();

    try {
      const chip = view.container.querySelector<HTMLButtonElement>('.ai-file-chip');
      expect(chip).toBeInstanceOf(HTMLButtonElement);

      await act(async () => {
        chip?.click();
      });

      expect(capturedDetail.current?.ref.path).toBe('app/src/App.tsx');
      expect(capturedDetail.current?.cwd).toBe('E:\\UltraGameStudio');
      expect(view.container.querySelector('.fixed.inset-0')).toBeNull();
    } finally {
      window.removeEventListener(
        OPEN_PROJECT_RIGHT_PANEL_FILE_PREVIEW_EVENT,
        handlePreviewRequest,
      );
      await view.cleanup();
    }
  });

  it('walks workspace directories from @ and inserts the chosen file', async () => {
    resetStore();
    tauriMocks.listWorkspaceDirectory.mockImplementation(
      async (rootPath: string, relativePath = '') => ({
        rootPath,
        relativePath,
        truncated: false,
        totalEntries: 1,
        entries:
          relativePath === ''
            ? [
                {
                  name: 'app',
                  path: 'E:\\UltraGameStudio\\app',
                  relativePath: 'app',
                  kind: 'directory',
                  hidden: false,
                },
              ]
            : relativePath === 'app'
              ? [
                  {
                    name: 'src',
                    path: 'E:\\UltraGameStudio\\app\\src',
                    relativePath: 'app/src',
                    kind: 'directory',
                    hidden: false,
                  },
                ]
              : [
                  {
                    name: 'App.tsx',
                    path: 'E:\\UltraGameStudio\\app\\src\\App.tsx',
                    relativePath: 'app/src/App.tsx',
                    kind: 'file',
                    hidden: false,
                  },
                ],
      }),
    );
    const view = await renderDock();

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(input, '@');
        await flushAsync();
      });

      expect(tauriMocks.listWorkspaceDirectory).toHaveBeenCalledWith(
        'E:\\UltraGameStudio',
        '',
      );
      const appOption = Array.from(
        view.container.querySelectorAll('[role="option"]'),
      ).find((option) => option.textContent?.includes('app/'));
      expect(appOption).toBeInstanceOf(HTMLElement);

      await act(async () => {
        appOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushAsync();
      });

      expect(input.value).toBe('@app/');
      await waitForExpect(() => {
        expect(tauriMocks.listWorkspaceDirectory).toHaveBeenCalledWith(
          'E:\\UltraGameStudio',
          'app',
        );
      });

      const srcOption = Array.from(
        view.container.querySelectorAll('[role="option"]'),
      ).find((option) => option.textContent?.includes('src/'));
      expect(srcOption).toBeInstanceOf(HTMLElement);

      await act(async () => {
        srcOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(input.value).toBe('@app/src/');
      await waitForExpect(() => {
        expect(tauriMocks.listWorkspaceDirectory).toHaveBeenCalledWith(
          'E:\\UltraGameStudio',
          'app/src',
        );
      });

      await act(async () => {
        keyDown(input, 'Enter');
      });

      expect(input.value).toBe('@app/src/App.tsx ');
    } finally {
      await view.cleanup();
    }
  });

  it('lists additional workspace folders and inserts absolute @ file paths', async () => {
    resetStore({ workspaceFolders: ['E:\\ProjectMoon\\MoonEngine'] });
    tauriMocks.listWorkspaceDirectory.mockImplementation(
      async (rootPath: string, relativePath = '') => ({
        rootPath,
        relativePath,
        truncated: false,
        totalEntries: 1,
        entries:
          rootPath === 'E:\\UltraGameStudio'
            ? [
                {
                  name: 'app',
                  path: 'E:\\UltraGameStudio\\app',
                  relativePath: 'app',
                  kind: 'directory',
                  hidden: false,
                },
              ]
            : relativePath === ''
              ? [
                  {
                    name: 'Engine',
                    path: 'E:\\ProjectMoon\\MoonEngine\\Engine',
                    relativePath: 'Engine',
                    kind: 'directory',
                    hidden: false,
                  },
                ]
              : [
                  {
                    name: 'Runtime.cpp',
                    path: 'E:\\ProjectMoon\\MoonEngine\\Engine\\Runtime.cpp',
                    relativePath: 'Engine/Runtime.cpp',
                    kind: 'file',
                    hidden: false,
                  },
                ],
      }),
    );
    const view = await renderDock();

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(input, '@');
        await flushAsync();
      });

      expect(tauriMocks.listWorkspaceDirectory).toHaveBeenCalledWith(
        'E:\\UltraGameStudio',
        '',
      );
      expect(tauriMocks.listWorkspaceDirectory).toHaveBeenCalledWith(
        'E:\\ProjectMoon\\MoonEngine',
        '',
      );

      const engineOption = Array.from(
        view.container.querySelectorAll('[role="option"]'),
      ).find((option) =>
        option.textContent?.includes('E:/ProjectMoon/MoonEngine/Engine'),
      );
      expect(engineOption).toBeInstanceOf(HTMLElement);

      await act(async () => {
        engineOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushAsync();
      });

      expect(input.value).toBe('@E:/ProjectMoon/MoonEngine/Engine/');
      await waitForExpect(() => {
        expect(tauriMocks.listWorkspaceDirectory).toHaveBeenCalledWith(
          'E:\\ProjectMoon\\MoonEngine',
          'Engine',
        );
      });

      await act(async () => {
        keyDown(input, 'Enter');
      });

      expect(input.value).toBe('@E:/ProjectMoon/MoonEngine/Engine/Runtime.cpp ');
    } finally {
      await view.cleanup();
    }
  });

  it('does not treat Cloudflare model ids as local file mentions', async () => {
    resetStore();
    tauriMocks.listWorkspaceDirectory.mockImplementation(
      async (rootPath: string, relativePath = '') => {
        if (relativePath === 'cf') {
          throw new Error(
            '读取目录失败：系统找不到指定的路径。 (os error 3)',
          );
        }
        return {
          rootPath,
          relativePath,
          truncated: false,
          totalEntries: 1,
          entries: [
            {
              name: 'app',
              path: 'E:\\UltraGameStudio\\app',
              relativePath: 'app',
              kind: 'directory' as const,
              hidden: false,
            },
          ],
        };
      },
    );
    const view = await renderDock();

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(input, '@cf/black-forest-labs/flux-1-schnell');
        await flushAsync();
      });

      await waitForExpect(() => {
        expect(tauriMocks.listWorkspaceDirectory).toHaveBeenCalledTimes(1);
      });
      expect(tauriMocks.listWorkspaceDirectory).toHaveBeenCalledWith(
        'E:\\UltraGameStudio',
        '',
      );
      expect(tauriMocks.listWorkspaceDirectory).not.toHaveBeenCalledWith(
        'E:\\UltraGameStudio',
        'cf',
      );
      expect(view.container.textContent).not.toContain('读取目录失败');
    } finally {
      await view.cleanup();
    }
  });

  it.runIf(CLOUD_PROJECTS_ENABLED)('walks remote workspace directories from @ without reading local files', async () => {
    const remotePath = remoteWorkspacePath('rw_file_mention');
    saveRemoteWorkspace({
      id: 'rw_file_mention',
      label: '远程项目',
      serverUrl: 'https://runner.test',
      projectId: 'proj_file_mention',
      repoUrl: 'https://example.test/repo.git',
      adapter: 'codex',
      model: 'gpt-remote',
      useOwnModelKey: false,
    });
    resetStore({ workspace: remotePath });
    remoteWorkspaceMocks.listRemoteWorkspaceDirectory.mockImplementation(
      async (rootPath: string, relativePath = '') => ({
        rootPath,
        relativePath,
        truncated: false,
        totalEntries: 1,
        entries:
          relativePath === ''
            ? [
                {
                  name: 'src',
                  path: `${rootPath}/src`,
                  relativePath: 'src',
                  kind: 'directory',
                  hidden: false,
                },
              ]
            : [
                {
                  name: 'Remote.ts',
                  path: `${rootPath}/src/Remote.ts`,
                  relativePath: 'src/Remote.ts',
                  kind: 'file',
                  hidden: false,
                },
              ],
      }),
    );
    const view = await renderDock();

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(input, '@');
        await flushAsync();
      });

      expect(remoteWorkspaceMocks.listRemoteWorkspaceDirectory).toHaveBeenCalledWith(
        remotePath,
        '',
      );
      await act(async () => {
        await flushAsync();
      });
      expect(tauriMocks.listWorkspaceDirectory).not.toHaveBeenCalled();

      let srcOption: Element | undefined;
      await waitForExpect(() => {
        srcOption = Array.from(
          view.container.querySelectorAll('[role="option"]'),
        ).find((option) => option.textContent?.includes('src/'));
        expect(srcOption).toBeInstanceOf(HTMLElement);
      });

      await act(async () => {
        srcOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushAsync();
      });

      await waitForExpect(() => {
        expect(remoteWorkspaceMocks.listRemoteWorkspaceDirectory).toHaveBeenCalledWith(
          remotePath,
          'src',
        );
      });

      await act(async () => {
        keyDown(input, 'Enter');
      });

      expect(input.value).toBe('@src/Remote.ts ');
    } finally {
      await view.cleanup();
    }
  });

  it.runIf(CLOUD_PROJECTS_ENABLED)('shows remote project session controls instead of local cache/worktree controls', async () => {
    const remotePath = remoteWorkspacePath('rw_toolbar');
    saveRemoteWorkspace({
      id: 'rw_toolbar',
      label: '远程项目',
      serverUrl: 'https://runner.test',
      projectId: 'proj_toolbar',
      repoUrl: 'https://example.test/repo.git',
      adapter: 'codex',
      model: 'gpt-remote',
      useOwnModelKey: false,
    });
    resetStore({ workspace: remotePath });
    const view = await renderDock();

    try {
      const toolbarText =
        view.container.querySelector('.ugs-ai-input-toolbar')?.textContent ?? '';
      expect(toolbarText).toContain('服务端管理');
      expect(toolbarText).toContain('远程处理');
      expect(toolbarText).not.toContain('5 分钟');
      expect(toolbarText).not.toContain('在本地处理');
      expect(toolbarText).not.toContain('新工作树');
    } finally {
      await view.cleanup();
    }
  });

  it.runIf(CLOUD_PROJECTS_ENABLED)('opens remote workspace files from the add-file button', async () => {
    const remotePath = remoteWorkspacePath('rw_add_file');
    saveRemoteWorkspace({
      id: 'rw_add_file',
      label: '远程项目',
      serverUrl: 'https://runner.test',
      projectId: 'proj_add_file',
      repoUrl: 'https://example.test/repo.git',
      adapter: 'codex',
      model: 'gpt-remote',
      useOwnModelKey: false,
    });
    resetStore({ workspace: remotePath });
    dialogMocks.open.mockResolvedValue(null);
    remoteWorkspaceMocks.listRemoteWorkspaceDirectory.mockImplementation(
      async (rootPath: string, relativePath = '') => ({
        rootPath,
        relativePath,
        truncated: false,
        totalEntries: 1,
        entries:
          relativePath === ''
            ? [
                {
                  name: 'src',
                  path: `${rootPath}/src`,
                  relativePath: 'src',
                  kind: 'directory',
                  hidden: false,
                },
              ]
            : [
                {
                  name: 'Remote.ts',
                  path: `${rootPath}/src/Remote.ts`,
                  relativePath: 'src/Remote.ts',
                  kind: 'file',
                  hidden: false,
                },
              ],
      }),
    );
    const view = await renderDock();

    try {
      const input = textarea(view.container);
      const addButton = view.container.querySelector(
        'button[aria-label="添加文件路径"]',
      );
      expect(addButton).toBeInstanceOf(HTMLButtonElement);

      await act(async () => {
        addButton?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        addButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushAsync();
      });

      expect(dialogMocks.open).not.toHaveBeenCalled();
      expect(remoteWorkspaceMocks.listRemoteWorkspaceDirectory).toHaveBeenCalledWith(
        remotePath,
        '',
      );
      let srcOption: Element | undefined;
      await waitForExpect(() => {
        srcOption = Array.from(
          view.container.querySelectorAll('[role="option"]'),
        ).find((option) => option.textContent?.includes('src/'));
        expect(srcOption).toBeInstanceOf(HTMLElement);
      });

      await act(async () => {
        srcOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushAsync();
      });

      await waitForExpect(() => {
        expect(remoteWorkspaceMocks.listRemoteWorkspaceDirectory).toHaveBeenCalledWith(
          remotePath,
          'src',
        );
      });

      let fileOption: Element | undefined;
      await waitForExpect(() => {
        fileOption = Array.from(
          view.container.querySelectorAll('[role="option"]'),
        ).find((option) => option.textContent?.includes('Remote.ts'));
        expect(fileOption).toBeInstanceOf(HTMLElement);
      });

      await act(async () => {
        fileOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(input.value).toBe('src/Remote.ts ');
    } finally {
      await view.cleanup();
    }
  });
});
