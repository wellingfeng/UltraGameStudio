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
import type { WorkspaceTreeEntry } from '@/lib/tauri';
import { defaultComposer, samplePromptGroups } from '@/store/sampleSessions';
import { useStore } from '@/store/useStore';
import AIDock from './AIDock';
import ProjectFileTree from './ProjectFileTree';

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
                path: 'E:\\OpenWorkflows\\app\\src\\ProjectFileTree.tsx',
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
    path: 'E:\\OpenWorkflows',
    name: 'OpenWorkflows',
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
    composer: { ...defaultComposer, workspace: 'E:\\OpenWorkflows' },
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
  const card = container.querySelector<HTMLDivElement>('.fuc-ai-input-card');
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

const dragEntry: WorkspaceTreeEntry = {
  path: 'E:\\OpenWorkflows\\app\\src\\ProjectFileTree.tsx',
  relativePath: 'app/src/ProjectFileTree.tsx',
  name: 'ProjectFileTree.tsx',
  kind: 'file',
  hidden: false,
};

afterEach(() => {
  clearProjectFileDragData();
  tauriWebviewMock.listeners.length = 0;
  tauriWebviewMock.onDragDropEvent.mockClear();
  window.localStorage.clear();
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
        'E:\\project_moon_ue5\\MoonGame\\Client\\Game\\Content\\Assets\\Scene\\Temp\\KuroWaterDemo\\KuroWaterSlopeDemo.umap';

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

      expect(input.value).toBe(fullPath);
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
        'E:\\OpenWorkflows\\app\\src\\App.tsx',
        'E:\\OpenWorkflows\\app\\src\\panels',
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
        'E:\\OpenWorkflows\\app\\src\\App.tsx\nE:\\OpenWorkflows\\app\\src\\panels',
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
      expect(input.value).toBe(dragEntry.path);
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

      expect(input.value).toBe(dragEntry.path);
    } finally {
      await view.cleanup();
    }
  });

  it('shows persisted session change counts in the session files tab', async () => {
    window.localStorage.setItem('freeultracode.projectRightPanelTab.v1', 'session');
    window.localStorage.setItem(
      'freeultracode.sessionChanges.v5:v5:ws_project_file_drag:s_project_file_drag:E:/OpenWorkflows',
      JSON.stringify({
        rootPath: 'E:/OpenWorkflows',
        generatedAtMs: 50,
        source: 'snapshot',
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
          {
            path: 'app/src/new.ts',
            oldPath: null,
            status: 'added',
            binary: false,
            truncated: false,
            lines: [],
          },
          {
            path: 'app/src/gone.ts',
            oldPath: null,
            status: 'deleted',
            binary: false,
            truncated: false,
            lines: [],
          },
        ],
      }),
    );
    resetStore({ withWorkspace: true });
    const view = await renderProjectDragHarness();

    try {
      expect(view.container.textContent).toContain(
        '3 个文件 · 新增 1 · 修改 1 · 删除 1',
      );
      expect(view.container.textContent).toContain('ProjectFileTree.tsx');
      expect(view.container.textContent).toContain('new.ts');
      expect(view.container.textContent).toContain('gone.ts');
    } finally {
      await view.cleanup();
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

      expect(input.value).toBe(dragEntry.path);
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
      expect(card.className).toContain('fuc-ai-input--drop');

      const outsideTransfer = plainDataTransfer();
      await act(async () => {
        sourceProps.onDrag?.({
          dataTransfer: outsideTransfer,
          clientX: 900,
          clientY: 400,
        });
      });

      expect(outsideTransfer.dropEffect).toBe('none');
      expect(card.className).not.toContain('fuc-ai-input--drop');
    } finally {
      await view.cleanup();
    }
  });
});
