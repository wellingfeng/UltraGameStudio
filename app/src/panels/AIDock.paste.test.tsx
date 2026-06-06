import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tauriAvailable } from '@/lib/tauri';
import AIDock from './AIDock';
import { defaultBlueprint } from '@/core/defaultBlueprint';
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
    composer: { ...defaultComposer, workspace: 'E:\\OpenWorkflows' },
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

afterEach(() => {
  tauriMocks.saveClipboardImage.mockReset();
  tauriMocks.previewLocalFile.mockReset();
  window.localStorage.clear();
  document.body.innerHTML = '';
});

describe('AIDock pasted clipboard images', () => {
  it('saves pasted image files and inserts the returned path', async () => {
    resetStore();
    expect(tauriAvailable()).toBe(true);
    tauriMocks.saveClipboardImage.mockResolvedValue(
      'E:\\OpenWorkflows\\.omc\\clipboard-images\\shot.png',
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
        const preventDefault = dispatchPaste(input, clipboardWithImage(file));
        expect(preventDefault).toHaveBeenCalled();
        await flushAsync();
      });

      expect(tauriMocks.saveClipboardImage).toHaveBeenCalledWith({
        bytesBase64: 'AQID',
        mime: 'image/png',
        fileName: 'screenshot.png',
        cwd: 'E:\\OpenWorkflows',
      });
      expect(input.value).toBe(
        'E:\\OpenWorkflows\\.omc\\clipboard-images\\shot.png',
      );
    } finally {
      await view.cleanup();
    }
  });

  it('deduplicates screenshot images exposed through files and items', async () => {
    resetStore();
    tauriMocks.saveClipboardImage.mockResolvedValue(
      'E:\\OpenWorkflows\\.omc\\clipboard-images\\shot.png',
    );
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
        'E:\\OpenWorkflows\\.omc\\clipboard-images\\shot.png',
      );
    } finally {
      await view.cleanup();
    }
  });

  it('renders user file paths as clickable full-path previews', async () => {
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
      path: 'E:\\OpenWorkflows\\app\\src\\App.tsx',
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
      expect(chip!.textContent).toContain('E:\\OpenWorkflows\\app\\src\\App.tsx');

      await act(async () => {
        chip!.click();
        await flushAsync();
      });

      expect(tauriMocks.previewLocalFile).toHaveBeenCalledWith(
        'app/src/App.tsx',
        { cwd: 'E:\\OpenWorkflows' },
      );
      expect(view.container.textContent).toContain(
        'E:\\OpenWorkflows\\app\\src\\App.tsx',
      );
    } finally {
      await view.cleanup();
    }
  });
});
