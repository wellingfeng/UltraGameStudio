import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tauriAvailable } from '@/lib/tauri';
import AIDock from './AIDock';
import { MESSAGE_FILE_CHIP_LIMIT } from '@/components/ai/lib/fileChipBudget';
import { defaultBlueprint } from '@/core/defaultBlueprint';
import {
  remoteWorkspacePath,
  saveRemoteRunnerConnection,
  saveRemoteWorkspace,
} from '@/lib/remoteWorkspace';
import { resetSecureStorageForTests } from '@/lib/secureStorage';
import { CLOUD_PROJECTS_ENABLED } from '@/lib/cloudProjects';
import { defaultComposer, samplePromptGroups } from '@/store/sampleSessions';
import { useStore } from '@/store/useStore';

const tauriMocks = vi.hoisted(() => ({
  saveClipboardImage: vi.fn(),
  previewLocalFile: vi.fn(),
}));

vi.mock('@/lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tauri')>();
  return {
    ...actual,
    tauriAvailable: () => true,
    fileExists: vi.fn(async () => true),
    previewLocalFile: tauriMocks.previewLocalFile,
    saveClipboardImage: tauriMocks.saveClipboardImage,
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

function resetStore(): void {
  useStore.setState({
    mode: 'design',
    workflow: defaultBlueprint('Paste image'),
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
    activeWorkspaceId: null,
    activeSessionId: 's_paste',
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

function textarea(container: HTMLElement): HTMLTextAreaElement {
  const input = container.querySelector('textarea');
  if (!input) throw new Error('Missing AI input textarea');
  return input;
}

function dispatchPaste(input: HTMLTextAreaElement, clipboardData: DataTransfer) {
  const key = Object.keys(input).find((name) => name.startsWith('__reactProps$'));
  if (!key) throw new Error('Missing React props on textarea');
  const props = (input as unknown as Record<string, { onPaste?: (event: unknown) => void }>)[key];
  if (!props.onPaste) throw new Error('Missing paste handler');
  const preventDefault = vi.fn();
  props.onPaste({
    clipboardData,
    currentTarget: input,
    preventDefault,
  });
  return preventDefault;
}

function clipboardWithImage(file: File): DataTransfer {
  return {
    files: [file],
    items: [
      {
        kind: 'file',
        type: file.type,
        getAsFile: () => file,
      },
    ],
  } as unknown as DataTransfer;
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
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

afterEach(() => {
  tauriMocks.saveClipboardImage.mockReset();
  tauriMocks.previewLocalFile.mockReset();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  resetSecureStorageForTests();
  document.body.innerHTML = '';
});

describe('AIDock pasted clipboard images', () => {
  it('saves pasted image files and inserts the returned path', async () => {
    resetStore();
    expect(tauriAvailable()).toBe(true);
    tauriMocks.saveClipboardImage.mockResolvedValue(
      'E:\\UltraGameStudio\\.ultragamestudio\\clipboard-images\\shot.png',
    );
    tauriMocks.previewLocalFile.mockResolvedValue({
      path: 'E:\\UltraGameStudio\\.ultragamestudio\\clipboard-images\\shot.png',
      fileName: 'shot.png',
      kind: 'image',
      mime: 'image/png',
      sizeBytes: 3,
      truncated: false,
      text: null,
      base64: 'AQID',
    });
    const view = await renderDock();

    try {
      const input = textarea(view.container);
      const file = new File([new Uint8Array([1, 2, 3])], 'screenshot.png', {
        type: 'image/png',
      });
      Object.defineProperty(file, 'arrayBuffer', {
        value: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer),
      });

      await act(async () => {
        const preventDefault = dispatchPaste(input, clipboardWithImage(file));
        expect(preventDefault).toHaveBeenCalled();
        await flushAsync();
      });

      expect(tauriMocks.saveClipboardImage).toHaveBeenCalledWith({
        bytesBase64: 'AQID',
        mime: 'image/png',
        fileName: 'screenshot.png',
        cwd: 'E:\\UltraGameStudio',
      });
      expect(input.value).toBe(
        '`E:\\UltraGameStudio\\.ultragamestudio\\clipboard-images\\shot.png`',
      );
    } finally {
      await view.cleanup();
    }
  });

  it('deduplicates screenshot images exposed through files and items', async () => {
    resetStore();
    tauriMocks.saveClipboardImage.mockResolvedValue(
      'E:\\UltraGameStudio\\.ultragamestudio\\clipboard-images\\shot.png',
    );
    tauriMocks.previewLocalFile.mockResolvedValue({
      path: 'E:\\UltraGameStudio\\.ultragamestudio\\clipboard-images\\shot.png',
      fileName: 'shot.png',
      kind: 'image',
      mime: 'image/png',
      sizeBytes: 3,
      truncated: false,
      text: null,
      base64: 'AQID',
    });
    const view = await renderDock();

    try {
      const input = textarea(view.container);
      const fileFromFiles = new File([new Uint8Array([1, 2, 3])], 'screenshot.png', {
        type: 'image/png',
        lastModified: 1,
      });
      const fileFromItems = new File([new Uint8Array([1, 2, 3])], 'screenshot.png', {
        type: 'image/png',
        lastModified: 1,
      });
      Object.defineProperty(fileFromItems, 'arrayBuffer', {
        value: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer),
      });

      await act(async () => {
        const preventDefault = dispatchPaste(input, {
          files: [fileFromFiles],
          items: [
            {
              kind: 'file',
              type: 'image/png',
              getAsFile: () => fileFromItems,
            },
          ],
        } as unknown as DataTransfer);
        expect(preventDefault).toHaveBeenCalled();
        await flushAsync();
      });

      expect(tauriMocks.saveClipboardImage).toHaveBeenCalledTimes(1);
      expect(input.value).toBe(
        '`E:\\UltraGameStudio\\.ultragamestudio\\clipboard-images\\shot.png`',
      );
    } finally {
      await view.cleanup();
    }
  });

  it.runIf(CLOUD_PROJECTS_ENABLED)('uploads pasted images to the remote project instead of inserting local paths', async () => {
    resetStore();
    saveRemoteRunnerConnection(
      { serverUrl: 'https://runner.test' },
      { token: 'runner-token' },
    );
    const remotePath = remoteWorkspacePath('rw_paste');
    saveRemoteWorkspace({
      id: 'rw_paste',
      label: '远程项目',
      serverUrl: 'https://runner.test',
      adapter: 'codex',
      projectId: 'proj_paste',
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
            path: 'remote-project://proj_paste/.ultragamestudio/clipboard-images/shot.png',
            relativePath: '.ultragamestudio/clipboard-images/shot.png',
            fileName: 'shot.png',
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
      const input = textarea(view.container);
      const file = new File([new Uint8Array([1, 2, 3])], 'screenshot.png', {
        type: 'image/png',
      });
      Object.defineProperty(file, 'arrayBuffer', {
        value: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer),
      });

      await act(async () => {
        const preventDefault = dispatchPaste(input, clipboardWithImage(file));
        expect(preventDefault).toHaveBeenCalled();
        await flushAsync();
      });

      expect(tauriMocks.saveClipboardImage).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledWith(
        'https://runner.test/projects/proj_paste/files',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer runner-token',
            'content-type': 'application/json',
          }),
        }),
      );
      expect(input.value).toBe('`.ultragamestudio/clipboard-images/shot.png`');
    } finally {
      await view.cleanup();
    }
  });

  it.runIf(CLOUD_PROJECTS_ENABLED)('surfaces remote pasted image upload failures', async () => {
    resetStore();
    saveRemoteRunnerConnection(
      { serverUrl: 'https://runner.test' },
      { token: 'runner-token' },
    );
    const remotePath = remoteWorkspacePath('rw_paste_fail');
    saveRemoteWorkspace({
      id: 'rw_paste_fail',
      label: '远程项目',
      serverUrl: 'https://runner.test',
      adapter: 'codex',
      projectId: 'proj_paste_fail',
      repoUrl: 'https://github.com/me/game.git',
    });
    useStore.setState({
      composer: { ...defaultComposer, workspace: remotePath },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: false, error: 'upload rejected' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const view = await renderDock();

    try {
      const input = textarea(view.container);
      const file = new File([new Uint8Array([1, 2, 3])], 'screenshot.png', {
        type: 'image/png',
      });
      Object.defineProperty(file, 'arrayBuffer', {
        value: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer),
      });

      await act(async () => {
        dispatchPaste(input, clipboardWithImage(file));
        await flushAsync();
      });

      await waitForExpect(() => {
        expect(input.value).toBe('');
        expect(view.container.textContent).toContain(
          '远程文件上传失败：upload rejected',
        );
      });
    } finally {
      await view.cleanup();
    }
  });

  it('renders user file paths as compact clickable previews', async () => {
    resetStore();
    useStore.setState({
      messages: [
        {
          id: 'm_user_file',
          role: 'user',
          text: 'app/src/App.tsx',
          createdAt: 1,
        },
      ],
    });
    tauriMocks.previewLocalFile.mockResolvedValue({
      path: 'E:\\UltraGameStudio\\app\\src\\App.tsx',
      fileName: 'App.tsx',
      kind: 'text',
      mime: 'text/typescript',
      sizeBytes: 12,
      truncated: false,
      text: 'export {};\n',
      base64: null,
    });
    const view = await renderDock();

    try {
      const chip = view.container.querySelector<HTMLButtonElement>('.ai-file-chip');
      expect(chip).not.toBeNull();
      expect(chip!.textContent).toContain('app/src/App.tsx');
      expect(chip!.title).toContain('app/src/App.tsx');

      await act(async () => {
        chip!.click();
        await flushAsync();
      });

      expect(tauriMocks.previewLocalFile).toHaveBeenCalledWith(
        'app/src/App.tsx',
        { cwd: 'E:\\UltraGameStudio' },
      );
      expect(view.container.textContent).toContain(
        'E:\\UltraGameStudio\\app\\src\\App.tsx',
      );
    } finally {
      await view.cleanup();
    }
  });

  it('renders an unsent draft path as a clickable preview chip', async () => {
    resetStore();
    useStore.setState({
      composerDraft:
        'E:\\UltraGameStudio\\.ultragamestudio\\clipboard-images\\shot.png 没什么',
    });
    tauriMocks.previewLocalFile.mockResolvedValue({
      path: 'E:\\UltraGameStudio\\.ultragamestudio\\clipboard-images\\shot.png',
      fileName: 'shot.png',
      kind: 'image',
      mime: 'image/png',
      sizeBytes: 3,
      truncated: false,
      text: null,
      base64: 'AQID',
    });
    const view = await renderDock();

    try {
      const strip = view.container.querySelector(
        '[data-testid="composer-file-refs"]',
      );
      expect(strip).not.toBeNull();
      // Image references render as a clickable thumbnail card; the full path
      // rides along in the button's title/alt rather than its text content.
      const chip = strip!.querySelector<HTMLButtonElement>('.ai-file-chip-thumb');
      expect(chip).not.toBeNull();
      expect(chip!.title).toContain(
        'E:\\UltraGameStudio\\.ultragamestudio\\clipboard-images\\shot.png',
      );

      await act(async () => {
        chip!.click();
        await flushAsync();
      });

      expect(tauriMocks.previewLocalFile).toHaveBeenCalledWith(
        'E:\\UltraGameStudio\\.ultragamestudio\\clipboard-images\\shot.png',
        { cwd: 'E:\\UltraGameStudio' },
      );
    } finally {
      await view.cleanup();
    }
  });

  it('only renders unsent image paths as composer preview chips', async () => {
    resetStore();
    useStore.setState({
      composerDraft: [
        'E:\\UltraGameStudio\\app\\src\\App.tsx',
        'E:\\UltraGameStudio\\.ultragamestudio\\clipboard-images\\shot.png',
        'E:\\UltraGameStudio\\notes.txt',
      ].join('\n'),
    });
    tauriMocks.previewLocalFile.mockResolvedValue({
      path: 'E:\\UltraGameStudio\\.ultragamestudio\\clipboard-images\\shot.png',
      fileName: 'shot.png',
      kind: 'image',
      mime: 'image/png',
      sizeBytes: 3,
      truncated: false,
      text: null,
      base64: 'AQID',
    });
    const view = await renderDock();

    try {
      const strip = view.container.querySelector(
        '[data-testid="composer-file-refs"]',
      );
      expect(strip).not.toBeNull();
      // Image refs render as a thumbnail-only tile: the path text is gone (it
      // stays in the textarea), so the strip stays one horizontal row.
      expect(
        strip!.querySelectorAll('.ai-file-chip, .ai-file-chip-thumb'),
      ).toHaveLength(1);
      expect(strip!.querySelector('.ai-file-chip-thumb')).not.toBeNull();
      expect(strip!.querySelector('.ai-file-chip')).toBeNull();
      expect(strip!.textContent).toBe('');
      expect(strip!.textContent).not.toContain('App.tsx');
      expect(strip!.textContent).not.toContain('notes.txt');
    } finally {
      await view.cleanup();
    }
  });

  it('caps unsent image preview chips in the composer', async () => {
    resetStore();
    const B = String.fromCharCode(92);
    useStore.setState({
      composerDraft: Array.from(
        { length: MESSAGE_FILE_CHIP_LIMIT + 3 },
        (_, i) =>
          `E:${B}UltraGameStudio${B}.ultragamestudio${B}clipboard-images${B}shot-${i}.png`,
      ).join('\n'),
    });
    tauriMocks.previewLocalFile.mockResolvedValue({
      path: 'E:\\UltraGameStudio\\.ultragamestudio\\clipboard-images\\shot.png',
      fileName: 'shot.png',
      kind: 'image',
      mime: 'image/png',
      sizeBytes: 3,
      truncated: false,
      text: null,
      base64: 'AQID',
    });
    const view = await renderDock();

    try {
      const strip = view.container.querySelector(
        '[data-testid="composer-file-refs"]',
      );
      expect(strip).not.toBeNull();
      expect(strip!.querySelectorAll('.ai-file-chip-thumb')).toHaveLength(
        MESSAGE_FILE_CHIP_LIMIT,
      );
      expect(strip!.querySelectorAll('.ai-file-chip-limit')).toHaveLength(1);
    } finally {
      await view.cleanup();
    }
  });

  it('lays the composer image previews out in one horizontal, scrollable row', async () => {
    resetStore();
    const B = String.fromCharCode(92);
    useStore.setState({
      composerDraft: ['a', 'b', 'c']
        .map(
          (name) =>
            `E:${B}UltraGameStudio${B}.ultragamestudio${B}clipboard-images${B}${name}.png`,
        )
        .join('\n'),
    });
    tauriMocks.previewLocalFile.mockResolvedValue({
      path: 'E:\\UltraGameStudio\\.ultragamestudio\\clipboard-images\\a.png',
      fileName: 'a.png',
      kind: 'image',
      mime: 'image/png',
      sizeBytes: 3,
      truncated: false,
      text: null,
      base64: 'AQID',
    });
    const view = await renderDock();

    try {
      const strip = view.container.querySelector<HTMLElement>(
        '[data-testid="composer-file-refs"]',
      );
      expect(strip).not.toBeNull();
      // Horizontal single row instead of a wrapping stack: three 56px tiles
      // share one line, the row scrolls when it runs out of width.
      expect(strip!.className).toContain('flex-nowrap');
      expect(strip!.className).toContain('overflow-x-auto');
      expect(strip!.querySelectorAll('.ai-file-chip-thumb')).toHaveLength(3);
      expect(strip!.textContent).toBe('');
    } finally {
      await view.cleanup();
    }
  });

  it('removes the draft path when a composer image preview is deleted', async () => {
    resetStore();
    const imagePath =
      'E:\\UltraGameStudio\\.ultragamestudio\\clipboard-images\\shot.png';
    useStore.setState({
      composerDraft: `\`${imagePath}\`\n看下这张图`,
    });
    tauriMocks.previewLocalFile.mockResolvedValue({
      path: imagePath,
      fileName: 'shot.png',
      kind: 'image',
      mime: 'image/png',
      sizeBytes: 3,
      truncated: false,
      text: null,
      base64: 'AQID',
    });
    const view = await renderDock();

    try {
      const strip = view.container.querySelector(
        '[data-testid="composer-file-refs"]',
      );
      const remove = strip!.querySelector<HTMLButtonElement>(
        'button[aria-label^="删除"]',
      );
      expect(remove).not.toBeNull();

      await act(async () => {
        remove!.click();
        await flushAsync();
      });

      expect(useStore.getState().composerDraft).toBe('看下这张图');
      expect(
        view.container.querySelector('[data-testid="composer-file-refs"]'),
      ).toBeNull();
    } finally {
      await view.cleanup();
    }
  });
});
