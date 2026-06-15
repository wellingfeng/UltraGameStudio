import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AIDock from './AIDock';
import { defaultBlueprint } from '@/core/defaultBlueprint';
import { defaultComposer, samplePromptGroups } from '@/store/sampleSessions';
import { useStore } from '@/store/useStore';

const tauriMocks = vi.hoisted(() => ({
  listWorkspaceDirectory: vi.fn(),
}));

vi.mock('@/lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tauri')>();
  return {
    ...actual,
    tauriAvailable: () => true,
    listWorkspaceDirectory: tauriMocks.listWorkspaceDirectory,
    slashCatalog: async () => ({
      scannedAtMs: 1,
      ready: true,
      entries: [],
    }),
    onSlashCatalogUpdated: async () => () => {},
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

(globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver =
  ResizeObserverStub as typeof ResizeObserver;

function resetStore(options: { workspaceFolders?: string[] } = {}): void {
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
      workspace: 'E:\\OpenWorkflows',
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
  window.localStorage.clear();
  document.body.innerHTML = '';
});

describe('AIDock file mentions', () => {
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
                  path: 'E:\\OpenWorkflows\\app',
                  relativePath: 'app',
                  kind: 'directory',
                  hidden: false,
                },
              ]
            : relativePath === 'app'
              ? [
                  {
                    name: 'src',
                    path: 'E:\\OpenWorkflows\\app\\src',
                    relativePath: 'app/src',
                    kind: 'directory',
                    hidden: false,
                  },
                ]
              : [
                  {
                    name: 'App.tsx',
                    path: 'E:\\OpenWorkflows\\app\\src\\App.tsx',
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
        'E:\\OpenWorkflows',
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
          'E:\\OpenWorkflows',
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
          'E:\\OpenWorkflows',
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
          rootPath === 'E:\\OpenWorkflows'
            ? [
                {
                  name: 'app',
                  path: 'E:\\OpenWorkflows\\app',
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
        'E:\\OpenWorkflows',
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
});
