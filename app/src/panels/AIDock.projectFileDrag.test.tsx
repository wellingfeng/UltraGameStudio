import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultBlueprint } from '@/core/defaultBlueprint';
import {
  clearProjectFileDragData,
  hasProjectFileDragData,
  PROJECT_FILE_DRAG_MIME,
  setProjectFileDragData,
} from '@/lib/projectFileDrag';
import { encodeToolPatch } from '@/components/ai/lib/toolEvent';
import {
  remoteWorkspacePath,
  saveRemoteRunnerConnection,
  saveRemoteWorkspace,
} from '@/lib/remoteWorkspace';
import { resetSecureStorageForTests } from '@/lib/secureStorage';
import { CLOUD_PROJECTS_ENABLED } from '@/lib/cloudProjects';
import { sessionChangesCacheKey } from '@/lib/sessionChanges';
import type { WorkspaceTreeEntry } from '@/lib/tauri';
import { defaultComposer, samplePromptGroups } from '@/store/sampleSessions';
import { useStore } from '@/store/useStore';
import AIDock from './AIDock';
import ProjectFileTree from './ProjectFileTree';
import { requestProjectRightPanelToggle } from './projectRightPanelEvents';

type NativeDragDropEvent = {
  payload:
    | { type: 'enter' | 'over'; position: { x: number; y: number } }
    | { type: 'drop'; position: { x: number; y: number }; paths: string[] }
    | { type: 'leave' };
};

const tauriWebviewMock = vi.hoisted(() => {
  const listeners: Array<(event: NativeDragDropEvent) => void> = [];
  const onDragDropEvent = vi.fn(
    async (listener: (event: NativeDragDropEvent) => void) => {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
  );
  return { listeners, onDragDropEvent };
});

const tauriMocks = vi.hoisted(() => ({
  readLocalFileForUpload: vi.fn(),
  collectWorkspacePathsToP4PendingList: vi.fn(async () => ({
    rootPath: 'E:/UltraGameStudio',
    requestedCount: 1,
    openedCount: 1,
    stdout: '',
    stderr: '',
  })),
}));

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: tauriWebviewMock.onDragDropEvent,
  }),
}));

vi.mock('@/lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tauri')>();
  return {
    ...actual,
    tauriAvailable: () => true,
    listWorkspaceDirectory: vi.fn(
      async (rootPath: string, relativePath: string) => ({
        rootPath,
        relativePath,
        entries: relativePath
          ? []
          : [
              {
                path: 'E:\\UltraGameStudio\\app\\src\\ProjectFileTree.tsx',
                relativePath: 'app/src/ProjectFileTree.tsx',
                name: 'ProjectFileTree.tsx',
                kind: 'file',
                hidden: false,
              },
            ],
        truncated: false,
        totalEntries: relativePath ? 0 : 1,
      }),
    ),
    listWorkspaceVcsStatus: vi.fn(async (rootPath: string) => ({
      rootPath,
      generatedAtMs: 1,
      source: 'git',
      files: [],
      truncated: false,
      scanScope: 'full',
    })),
    listWorkspaceVcsStatusShallow: vi.fn(async (rootPath: string) => ({
      rootPath,
      generatedAtMs: 1,
      source: 'git',
      files: [],
      truncated: false,
      scanScope: 'root',
    })),
    slashCatalog: async () => ({
      scannedAtMs: 1,
      ready: true,
      entries: [],
    }),
    onSlashCatalogUpdated: async () => () => {},
    readLocalFileForUpload: tauriMocks.readLocalFileForUpload,
    collectWorkspacePathsToP4PendingList:
      tauriMocks.collectWorkspacePathsToP4PendingList,
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

type ComposerDragEvent = {
  dataTransfer: DataTransfer;
  currentTarget: HTMLElement;
  target: EventTarget;
  relatedTarget: EventTarget | null;
  preventDefault: () => void;
  stopPropagation: () => void;
};

type ComposerDropProps = {
  onDragOver?: (event: ComposerDragEvent) => void;
  onDrop?: (event: ComposerDragEvent) => void;
};

type ProjectEntryDragProps = {
  onDragStart?: (event: { dataTransfer: DataTransfer }) => void;
  onDrag?: (event: {
    dataTransfer: DataTransfer;
    clientX: number;
    clientY: number;
  }) => void;
  onDragEnd?: (event: { clientX: number; clientY: number }) => void;
};

function resetStore(options: { withWorkspace?: boolean } = {}): void {
  const workspace = {
    id: 'ws_project_file_drag',
    path: 'E:\\UltraGameStudio',
    name: 'UltraGameStudio',
    updatedAt: 1,
    sessionCount: 1,
    lastActiveSessionId: 's_project_file_drag',
  };
  useStore.setState({
    mode: 'design',
    workflow: defaultBlueprint('Project file drag'),
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
    messages: [],
    workspaces: options.withWorkspace ? [workspace] : [],
    activeWorkspaceId: options.withWorkspace ? workspace.id : null,
    activeSessionId: 's_project_file_drag',
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

async function renderProjectDragHarness(): Promise<{
  container: HTMLDivElement;
  cleanup: () => Promise<void>;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(
      <>
        <AIDock />
        <ProjectFileTree />
      </>,
    );
  });
  await act(async () => requestProjectRightPanelToggle());
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }

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

function composerCard(container: HTMLElement): HTMLDivElement {
  const card = container.querySelector<HTMLDivElement>('.ugs-ai-input-card');
  if (!card) throw new Error('Missing AI input card');
  return card;
}

function reactProps<T>(element: HTMLElement): T {
  const key = Object.keys(element).find((name) => name.startsWith('__reactProps$'));
  if (!key) throw new Error('Missing React props');
  return (element as unknown as Record<string, T>)[key];
}

function projectDataTransfer(paths: string[]): DataTransfer {
  return {
    dropEffect: 'none',
    effectAllowed: 'copy',
    files: [],
    items: [],
    types: [PROJECT_FILE_DRAG_MIME],
    getData: vi.fn((type: string) =>
      type === PROJECT_FILE_DRAG_MIME ? JSON.stringify({ paths }) : '',
    ),
    setData: vi.fn(),
    clearData: vi.fn(),
    setDragImage: vi.fn(),
  } as unknown as DataTransfer;
}

function plainDataTransfer(): DataTransfer {
  return {
    dropEffect: 'none',
    effectAllowed: 'copy',
    files: [],
    items: [],
    types: ['text/plain'],
    getData: vi.fn(() => ''),
    setData: vi.fn(),
    clearData: vi.fn(),
    setDragImage: vi.fn(),
  } as unknown as DataTransfer;
}

function fileItemDataTransfer(file: File): DataTransfer {
  return {
    dropEffect: 'none',
    effectAllowed: 'copy',
    files: [],
    items: [
      {
        kind: 'file',
        type: file.type,
        getAsFile: () => file,
      },
    ],
    types: ['Files'],
    getData: vi.fn(() => ''),
    setData: vi.fn(),
    clearData: vi.fn(),
    setDragImage: vi.fn(),
  } as unknown as DataTransfer;
}

async function waitForExpect(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < 20; i += 1) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 10));
      });
    }
  }
  throw lastError;
}

const dragEntry: WorkspaceTreeEntry = {
  path: 'E:\\UltraGameStudio\\app\\src\\ProjectFileTree.tsx',
  relativePath: 'app/src/ProjectFileTree.tsx',
  name: 'ProjectFileTree.tsx',
  kind: 'file',
  hidden: false,
};

afterEach(() => {
  clearProjectFileDragData();
  tauriMocks.readLocalFileForUpload.mockReset();
  tauriMocks.collectWorkspacePathsToP4PendingList.mockClear();
  tauriWebviewMock.listeners.length = 0;
  tauriWebviewMock.onDragDropEvent.mockClear();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  resetSecureStorageForTests();
  document.body.innerHTML = '';
});

describe('AIDock project file drag', () => {
  it('uses Tauri native OS drops so external files insert full paths', async () => {
    resetStore();
    const view = await renderDock();

    try {
      const card = composerCard(view.container);
      const input = textarea(view.container);
      const fullPath =
        'E:\\project_moon_ue5\\MoonGame\\Client\\Game\\Content\\Assets\\Scene\\Temp\\WaterDemo\\WaterSlopeDemo.umap';

      Object.defineProperty(card, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
          left: 0,
          top: 0,
          right: 800,
          bottom: 300,
          width: 800,
          height: 300,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }),
      });

      for (let i = 0; i < 3 && tauriWebviewMock.listeners.length === 0; i += 1) {
        await act(async () => {
          await new Promise((resolve) => window.setTimeout(resolve, 0));
        });
      }

      expect(tauriWebviewMock.listeners).toHaveLength(1);

      await act(async () => {
        tauriWebviewMock.listeners[0]({
          payload: {
            type: 'drop',
            position: { x: 40, y: 40 },
            paths: [fullPath],
          },
        });
      });

      expect(input.value).toBe(`\`${fullPath}\``);
    } finally {
      await view.cleanup();
    }
  });

  it.runIf(CLOUD_PROJECTS_ENABLED)('uploads native OS drops before inserting paths for remote workspaces', async () => {
    resetStore();
    saveRemoteRunnerConnection(
      { serverUrl: 'https://runner.test' },
      { token: 'runner-token' },
    );
    const remotePath = remoteWorkspacePath('rw_drag');
    saveRemoteWorkspace({
      id: 'rw_drag',
      label: '远程项目',
      serverUrl: 'https://runner.test',
      adapter: 'codex',
      projectId: 'proj_drag',
      repoUrl: 'https://github.com/me/game.git',
    });
    useStore.setState({
      composer: { ...defaultComposer, workspace: remotePath },
    });
    tauriMocks.readLocalFileForUpload.mockResolvedValue({
      bytesBase64: 'AQID',
      fileName: 'local.png',
      mime: 'image/png',
      sizeBytes: 3,
    });
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          file: {
            path: 'remote-project://proj_drag/.ultragamestudio/uploads/local.png',
            relativePath: '.ultragamestudio/uploads/local.png',
            fileName: 'local.png',
            mime: 'image/png',
            sizeBytes: 3,
          },
        }),
        {
          status: 201,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const view = await renderDock();

    try {
      const card = composerCard(view.container);
      const input = textarea(view.container);
      const fullPath = 'E:\\Users\\me\\Pictures\\local.png';

      Object.defineProperty(card, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
          left: 0,
          top: 0,
          right: 800,
          bottom: 300,
          width: 800,
          height: 300,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }),
      });

      for (let i = 0; i < 3 && tauriWebviewMock.listeners.length === 0; i += 1) {
        await act(async () => {
          await new Promise((resolve) => window.setTimeout(resolve, 0));
        });
      }

      await act(async () => {
        tauriWebviewMock.listeners[0]({
          payload: {
            type: 'drop',
            position: { x: 40, y: 40 },
            paths: [fullPath],
          },
        });
      });

      await vi.waitFor(() =>
        expect(input.value).toBe('`.ultragamestudio/uploads/local.png`'),
      );
      expect(tauriMocks.readLocalFileForUpload).toHaveBeenCalledWith(fullPath);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://runner.test/projects/proj_drag/files',
        expect.objectContaining({ method: 'POST' }),
      );
    } finally {
      await view.cleanup();
    }
  });

  it.runIf(CLOUD_PROJECTS_ENABLED)('uploads browser file drops from DataTransfer items for remote workspaces', async () => {
    resetStore();
    saveRemoteRunnerConnection(
      { serverUrl: 'https://runner.test' },
      { token: 'runner-token' },
    );
    const remotePath = remoteWorkspacePath('rw_items_drag');
    saveRemoteWorkspace({
      id: 'rw_items_drag',
      label: '远程项目',
      serverUrl: 'https://runner.test',
      adapter: 'codex',
      projectId: 'proj_items_drag',
      repoUrl: 'https://github.com/me/game.git',
    });
    useStore.setState({
      composer: { ...defaultComposer, workspace: remotePath },
    });
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          file: {
            path: 'remote-project://proj_items_drag/.ultragamestudio/uploads/item.png',
            relativePath: '.ultragamestudio/uploads/item.png',
            fileName: 'item.png',
            mime: 'image/png',
            sizeBytes: 3,
          },
        }),
        {
          status: 201,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const view = await renderDock();

    try {
      const card = composerCard(view.container);
      const input = textarea(view.container);
      const props = reactProps<ComposerDropProps>(card);
      const file = new File([new Uint8Array([1, 2, 3])], 'item.png', {
        type: 'image/png',
      });
      Object.defineProperty(file, 'arrayBuffer', {
        value: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer),
      });

      await act(async () => {
        props.onDrop?.({
          dataTransfer: fileItemDataTransfer(file),
          currentTarget: card,
          target: card,
          relatedTarget: null,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        });
      });

      await waitForExpect(() => {
        expect(input.value).toBe('`.ultragamestudio/uploads/item.png`');
      });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://runner.test/projects/proj_items_drag/files',
        expect.objectContaining({ method: 'POST' }),
      );
    } finally {
      await view.cleanup();
    }
  });

  it('accepts project file and folder drops on the whole AI input card', async () => {
    resetStore();
    const view = await renderDock();

    try {
      const card = composerCard(view.container);
      const input = textarea(view.container);
      const props = reactProps<ComposerDropProps>(card);
      const dataTransfer = projectDataTransfer([
        'E:\\UltraGameStudio\\app\\src\\App.tsx',
        'E:\\UltraGameStudio\\app\\src\\panels',
      ]);
      const dragPreventDefault = vi.fn();
      const dropPreventDefault = vi.fn();
      const dropStopPropagation = vi.fn();

      await act(async () => {
        props.onDragOver?.({
          dataTransfer,
          currentTarget: card,
          target: card,
          relatedTarget: null,
          preventDefault: dragPreventDefault,
          stopPropagation: vi.fn(),
        });
      });

      expect(dragPreventDefault).toHaveBeenCalled();
      expect(dataTransfer.dropEffect).toBe('copy');

      await act(async () => {
        props.onDrop?.({
          dataTransfer,
          currentTarget: card,
          target: card,
          relatedTarget: null,
          preventDefault: dropPreventDefault,
          stopPropagation: dropStopPropagation,
        });
      });

      expect(dropPreventDefault).toHaveBeenCalled();
      expect(dropStopPropagation).toHaveBeenCalled();
      expect(input.value).toBe(
        '`E:\\UltraGameStudio\\app\\src\\App.tsx`\n`E:\\UltraGameStudio\\app\\src\\panels`',
      );
    } finally {
      await view.cleanup();
    }
  });

  it('keeps accepting project drags when the WebView strips the custom MIME type', async () => {
    resetStore();
    const view = await renderDock();

    try {
      setProjectFileDragData(plainDataTransfer(), dragEntry);

      const card = composerCard(view.container);
      const input = textarea(view.container);
      const props = reactProps<ComposerDropProps>(card);
      const targetDataTransfer = plainDataTransfer();
      const dragPreventDefault = vi.fn();
      const dropPreventDefault = vi.fn();

      expect(hasProjectFileDragData(targetDataTransfer)).toBe(true);

      await act(async () => {
        props.onDragOver?.({
          dataTransfer: targetDataTransfer,
          currentTarget: card,
          target: card,
          relatedTarget: null,
          preventDefault: dragPreventDefault,
          stopPropagation: vi.fn(),
        });
      });

      expect(dragPreventDefault).toHaveBeenCalled();

      await act(async () => {
        props.onDrop?.({
          dataTransfer: targetDataTransfer,
          currentTarget: card,
          target: card,
          relatedTarget: null,
          preventDefault: dropPreventDefault,
          stopPropagation: vi.fn(),
        });
      });

      expect(dropPreventDefault).toHaveBeenCalled();
      expect(input.value).toBe(`\`${dragEntry.path}\``);
      expect(hasProjectFileDragData(targetDataTransfer)).toBe(false);
    } finally {
      await view.cleanup();
    }
  });

  it('connects ProjectFileTree dragstart to the AI input drop fallback', async () => {
    resetStore({ withWorkspace: true });
    const view = await renderProjectDragHarness();

    try {
      const source = Array.from(
        view.container.querySelectorAll<HTMLButtonElement>('button[title]'),
      ).find((button) => button.title === dragEntry.path);
      if (!source) throw new Error('Missing project tree source entry');

      const sourceProps = reactProps<ProjectEntryDragProps>(source);
      sourceProps.onDragStart?.({ dataTransfer: plainDataTransfer() });

      const card = composerCard(view.container);
      const input = textarea(view.container);
      const props = reactProps<ComposerDropProps>(card);
      const targetDataTransfer = plainDataTransfer();

      await act(async () => {
        props.onDragOver?.({
          dataTransfer: targetDataTransfer,
          currentTarget: card,
          target: card,
          relatedTarget: null,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        });
      });

      await act(async () => {
        props.onDrop?.({
          dataTransfer: targetDataTransfer,
          currentTarget: card,
          target: card,
          relatedTarget: null,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        });
      });

      expect(input.value).toBe(`\`${dragEntry.path}\``);
    } finally {
      await view.cleanup();
    }
  });

  it.runIf(CLOUD_PROJECTS_ENABLED)('connects remote ProjectFileTree drags to the AI input as relative paths', async () => {
    resetStore();
    saveRemoteRunnerConnection(
      { serverUrl: 'https://runner.test' },
      { token: 'runner-token' },
    );
    const remotePath = remoteWorkspacePath('rw_tree_drag');
    saveRemoteWorkspace({
      id: 'rw_tree_drag',
      label: '远程项目',
      serverUrl: 'https://runner.test',
      adapter: 'codex',
      projectId: 'proj_tree_drag',
      repoUrl: 'https://github.com/me/game.git',
    });
    useStore.setState({
      workspaces: [
        {
          id: 'ws_tree_drag',
          path: remotePath,
          name: '远程项目',
          updatedAt: 1,
          sessionCount: 1,
          lastActiveSessionId: 's_project_file_drag',
        },
      ],
      activeWorkspaceId: 'ws_tree_drag',
      composer: { ...defaultComposer, workspace: remotePath },
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://runner.test/projects/proj_tree_drag/files') {
        return new Response(
          JSON.stringify({
            ok: true,
            listing: {
              rootPath: 'remote-project://proj_tree_drag',
              relativePath: '',
              entries: [
                {
                  name: 'RemoteFile.ts',
                  path: 'remote-project://proj_tree_drag/src/RemoteFile.ts',
                  relativePath: 'src/RemoteFile.ts',
                  kind: 'file',
                  hidden: false,
                },
              ],
              truncated: false,
              totalEntries: 1,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ ok: false, error: 'unexpected' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const view = await renderProjectDragHarness();

    try {
      await waitForExpect(() => {
        expect(view.container.textContent).toContain('RemoteFile.ts');
      });
      const source = Array.from(
        view.container.querySelectorAll<HTMLButtonElement>('button[title]'),
      ).find((button) => button.title === `${remotePath}/src/RemoteFile.ts`);
      if (!source) throw new Error('Missing remote project tree source entry');

      expect(source.draggable).toBe(true);
      const sourceProps = reactProps<ProjectEntryDragProps>(source);
      sourceProps.onDragStart?.({ dataTransfer: plainDataTransfer() });

      const card = composerCard(view.container);
      const input = textarea(view.container);
      const props = reactProps<ComposerDropProps>(card);

      await act(async () => {
        props.onDrop?.({
          dataTransfer: plainDataTransfer(),
          currentTarget: card,
          target: card,
          relatedTarget: null,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        });
      });

      expect(input.value).toBe('`src/RemoteFile.ts`');
      expect(
        fetchMock.mock.calls.filter(
          ([url]) => url === 'https://runner.test/projects/proj_tree_drag/files',
        ),
      ).toHaveLength(1);
    } finally {
      await view.cleanup();
    }
  });

  it('shows confirmed session change counts in the session files tab', async () => {
    window.localStorage.setItem('ultragamestudio.projectRightPanelTab.v1', 'session');
    resetStore({ withWorkspace: true });
    useStore.setState({
      messages: [
        {
          id: 'assistant-session-files',
          role: 'assistant',
          createdAt: 25,
          fileChanges: {
            source: 'agent',
            rootPath: useStore.getState().composer.workspace,
            files: [
              { path: 'app/src/ProjectFileTree.tsx', status: 'modified' },
              { path: 'app/src/new.ts', status: 'added' },
              { path: 'app/src/gone.ts', status: 'deleted' },
            ],
          },
          text:
            encodeToolPatch({
              id: 'project-file-tree',
              name: 'Edit',
              status: 'done',
              args: { file_path: 'app/src/ProjectFileTree.tsx' },
            }) +
            encodeToolPatch({
              id: 'new-file',
              name: 'Write',
              status: 'done',
              args: { file_path: 'app/src/new.ts' },
            }) +
            encodeToolPatch({
              id: 'deleted-file',
              name: 'Edit',
              status: 'done',
              args: { file_path: 'app/src/gone.ts' },
            }),
        },
      ],
    });
    const view = await renderProjectDragHarness();

    try {
      await waitForExpect(() => {
        expect(view.container.textContent).toContain(
          '3 个文件 · 新增 1 · 修改 1 · 删除 1',
        );
        expect(view.container.textContent).toContain('ProjectFileTree.tsx');
        expect(view.container.textContent).toContain('new.ts');
        expect(view.container.textContent).toContain('gone.ts');
      });
    } finally {
      await view.cleanup();
    }
  });

  it('collects a P4 session file to the pending list from the context menu', async () => {
    resetStore({ withWorkspace: true });
    const workspaceRoot = useStore.getState().composer.workspace;
    const filePath = `${workspaceRoot}/app/src/ProjectFileTree.tsx`;
    window.localStorage.setItem('ultragamestudio.projectRightPanelTab.v1', 'session');
    window.localStorage.setItem(
      `ultragamestudio.sessionChanges.v5:${sessionChangesCacheKey(
        'ws_project_file_drag', 's_project_file_drag', workspaceRoot,
      )}`,
      JSON.stringify({
        rootPath: workspaceRoot,
        generatedAtMs: 50,
        source: 'p4',
        truncated: false,
        files: [
          {
            path: 'app/src/ProjectFileTree.tsx',
            oldPath: null,
            status: 'modified',
            binary: false,
            truncated: false,
            lines: [],
          },
        ],
      }),
    );
    useStore.setState({
      messages: [
        {
          id: 'assistant-session-files-p4',
          role: 'assistant',
          createdAt: 25,
          text: encodeToolPatch({
            id: 'project-file-tree-p4',
            name: 'Edit',
            status: 'done',
            args: { file_path: 'app/src/ProjectFileTree.tsx' },
          }),
        },
      ],
    });
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const view = await renderProjectDragHarness();

    try {
      let source: HTMLButtonElement | undefined;
      await waitForExpect(() => {
        source = Array.from(
          view.container.querySelectorAll<HTMLButtonElement>('button[title]'),
        ).find((candidate) => candidate.title.replace(/\\/g, '/') === filePath.replace(/\\/g, '/') &&
          !candidate.closest('[data-ugs-edited-files]'));
        expect(source).toBeTruthy();
      });

      await act(async () => {
        source!.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: 20,
            clientY: 20,
          }),
        );
      });

      const collectItem = Array.from(
        view.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
      ).find((button) => (button.textContent ?? '').includes('收集到 pending list'));
      expect(collectItem).toBeTruthy();

      await act(async () => {
        collectItem!.click();
      });

      await waitForExpect(() => {
        expect(tauriMocks.collectWorkspacePathsToP4PendingList).toHaveBeenCalledWith(
          workspaceRoot,
          [filePath],
        );
        expect(alertSpy).toHaveBeenCalledWith(
          '已收集到 P4 pending list：1 个新打开，1 个已处理。',
        );
      });
    } finally {
      await view.cleanup();
      alertSpy.mockRestore();
    }
  });

  it('falls back to the project drag end point when WebView never delivers drop', async () => {
    resetStore({ withWorkspace: true });
    const view = await renderProjectDragHarness();

    try {
      const source = Array.from(
        view.container.querySelectorAll<HTMLButtonElement>('button[title]'),
      ).find((button) => button.title === dragEntry.path);
      if (!source) throw new Error('Missing project tree source entry');

      const card = composerCard(view.container);
      const input = textarea(view.container);
      Object.defineProperty(card, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
          left: 0,
          top: 0,
          right: 800,
          bottom: 300,
          width: 800,
          height: 300,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }),
      });

      const sourceProps = reactProps<ProjectEntryDragProps>(source);
      sourceProps.onDragStart?.({ dataTransfer: plainDataTransfer() });

      await act(async () => {
        sourceProps.onDragEnd?.({ clientX: 40, clientY: 40 });
      });

      expect(input.value).toBe(`\`${dragEntry.path}\``);
    } finally {
      await view.cleanup();
    }
  });

  it('shows a copy drop effect while project files are dragged over the AI input', async () => {
    resetStore({ withWorkspace: true });
    const view = await renderProjectDragHarness();

    try {
      const source = Array.from(
        view.container.querySelectorAll<HTMLButtonElement>('button[title]'),
      ).find((button) => button.title === dragEntry.path);
      if (!source) throw new Error('Missing project tree source entry');

      const card = composerCard(view.container);
      Object.defineProperty(card, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
          left: 0,
          top: 0,
          right: 800,
          bottom: 300,
          width: 800,
          height: 300,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }),
      });

      const sourceProps = reactProps<ProjectEntryDragProps>(source);
      sourceProps.onDragStart?.({ dataTransfer: plainDataTransfer() });

      const overInputTransfer = plainDataTransfer();
      await act(async () => {
        sourceProps.onDrag?.({
          dataTransfer: overInputTransfer,
          clientX: 40,
          clientY: 40,
        });
      });

      expect(overInputTransfer.dropEffect).toBe('copy');
      expect(card.className).toContain('ugs-ai-input--drop');

      const outsideTransfer = plainDataTransfer();
      await act(async () => {
        sourceProps.onDrag?.({
          dataTransfer: outsideTransfer,
          clientX: 900,
          clientY: 400,
        });
      });

      expect(outsideTransfer.dropEffect).toBe('none');
      expect(card.className).not.toContain('ugs-ai-input--drop');
    } finally {
      await view.cleanup();
    }
  });
});
