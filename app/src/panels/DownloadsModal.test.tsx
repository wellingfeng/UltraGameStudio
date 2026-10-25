import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Locale } from '@/lib/i18n';
import type { Message } from '@/store/types';
import {
  __resetAssetsForTest,
  mergeCachedAssetsFromDisk,
} from '@/lib/downloadRegistry';

const storeMocks = vi.hoisted(() => ({
  selectSession: vi.fn(),
}));

const mockState = vi.hoisted(() => ({
  locale: 'zh-CN' as Locale,
  historyReady: true,
  workspaces: [
    {
      id: 'w_1',
      path: 'E:\\UltraGameStudio',
      name: 'UltraGameStudio',
      updatedAt: 1,
      sessionCount: 1,
      lastActiveSessionId: 's_1',
    },
  ],
  activeSessionId: 's_current',
  activeWorkspaceId: 'w_1',
  composer: { workspace: 'E:\\UltraGameStudio' },
  messages: [] as Message[],
  selectSession: storeMocks.selectSession,
}));

const historyMocks = vi.hoisted(() => ({
  listSessions: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock('@/store/useStore', () => ({
  useStore: <T,>(selector: (state: typeof mockState) => T): T =>
    selector(mockState),
}));

vi.mock('@/store/history/store', () => ({
  historyStore: {
    listSessions: historyMocks.listSessions,
    getSession: historyMocks.getSession,
  },
}));

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>(
    '@/lib/tauri',
  );
  return {
    ...actual,
    listCachedAssets: vi.fn(async () => []),
    openExternal: vi.fn(async () => undefined),
    openLocalPath: vi.fn(async () => true),
    previewLocalFile: vi.fn(),
    tauriAvailable: vi.fn(() => false),
  };
});

import DownloadsModal from './DownloadsModal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

async function renderModal(): Promise<{
  container: HTMLDivElement;
  cleanup: () => Promise<void>;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(<DownloadsModal locale="zh-CN" onClose={vi.fn()} />);
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

async function waitFor(
  predicate: () => boolean,
  label: string,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 1000) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe('DownloadsModal conversation jumps', () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetAssetsForTest();
    mockState.activeSessionId = 's_current';
    mockState.activeWorkspaceId = 'w_1';
    mockState.messages = [];
    storeMocks.selectSession.mockClear();
    historyMocks.listSessions.mockReset();
    historyMocks.listSessions.mockResolvedValue([]);
    historyMocks.getSession.mockReset();
    historyMocks.getSession.mockResolvedValue(null);
  });

  afterEach(() => {
    __resetAssetsForTest();
  });

  it('renders artifacts as a main page without a modal backdrop', async () => {
    const view = await renderModal();
    try {
      expect(view.container.querySelector('[data-ugs-artifacts]')).not.toBeNull();
      expect(view.container.querySelector('[role="dialog"]')).toBeNull();
      expect(view.container.querySelector('[aria-modal]')).toBeNull();
      expect(view.container.querySelector('[aria-label="返回对话"]')).not.toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  it('renders answer links as a three-column list and opens details inside the main surface', async () => {
    mockState.messages = [{ id: 'm_link', role: 'assistant', text: '[官方参考](https://example.com/api)', createdAt: 100 }];
    const view = await renderModal();
    try {
      const category = Array.from(view.container.querySelectorAll('button')).find(button => button.textContent?.startsWith('链接'));
      await act(async () => { category?.click(); });
      expect(view.container.querySelector('.artifact-table-head')?.textContent).toBe('链接标题URL会话');
      expect(view.container.querySelector('.artifact-location-cell')?.textContent).toBe('https://example.com/api');
      const title = view.container.querySelector<HTMLButtonElement>('[aria-label="查看产物：官方参考"]');
      await act(async () => { title?.click(); });
      expect(view.container.querySelector('[role="region"][aria-label="产物详情"]')).not.toBeNull();
      expect(view.container.querySelector('[role="dialog"]')).toBeNull();
      expect(storeMocks.selectSession).not.toHaveBeenCalled();
      await act(async () => { view.container.querySelector<HTMLButtonElement>('[aria-label="关闭详情"]')?.click(); });
      expect(view.container.querySelector('[aria-label="产物详情"][role="region"]')).toBeNull();
      expect(view.container.querySelector('.artifact-table')).not.toBeNull();
    } finally { await view.cleanup(); }
  });

  it('links an existing clipboard image from a user message before jumping', async () => {
    const path =
      'E:\\UltraGameStudio\\.ultragamestudio\\clipboard-images\\pasted-1.png';
    mergeCachedAssetsFromDisk([
      {
        kind: 'image',
        source: 'generated',
        title: 'pasted-1.png',
        localPath: path,
        sizeBytes: 2,
        createdAtMs: 100,
        modifiedAtMs: 300,
      },
    ]);
    historyMocks.listSessions.mockResolvedValue([
      {
        id: 's_1',
        title: 'Pasted image chat',
        createdAt: 1,
        updatedAt: 2,
        isWorkflow: false,
        messageCount: 1,
      },
    ]);
    historyMocks.getSession.mockResolvedValue({
      id: 's_1',
      title: 'Pasted image chat',
      createdAt: 1,
      updatedAt: 2,
      isWorkflow: false,
      messages: [
        {
          id: 'm_user',
          role: 'user',
          text: `请看这张图 ${path}`,
          createdAt: 1,
        },
      ],
    });

    const events: unknown[] = [];
    const onJump = (event: Event) => {
      events.push((event as CustomEvent).detail);
    };
    window.addEventListener('ugs:asset-session-jump', onJump);
    const view = await renderModal();

    try {
      expect(view.container.querySelector('[role="button"]')).toBeNull();
      await act(async () => { Array.from(view.container.querySelectorAll('button')).find(button => button.textContent?.startsWith('输入素材'))?.click(); });
      const row = view.container.querySelector('[role="button"]');
      expect(row?.textContent).toContain('pasted-1.png');

      await act(async () => {
        row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      await waitFor(
        () => storeMocks.selectSession.mock.calls.length > 0,
        'asset jump session selection',
      );
      expect(storeMocks.selectSession).toHaveBeenCalledWith('s_1', 'w_1');
      expect(events).toEqual([
        {
          assetId: 'disk:e:/ultragamestudio/.ultragamestudio/clipboard-images/pasted-1.png',
          sessionId: 's_1',
          workspaceId: 'w_1',
          messageId: 'm_user',
        },
      ]);
    } finally {
      window.removeEventListener('ugs:asset-session-jump', onJump);
      await view.cleanup();
    }
  });

  it('links a current-session clipboard image from the active user message', async () => {
    const path =
      'E:\\UltraGameStudio\\.ultragamestudio\\clipboard-images\\pasted-current.png';
    mockState.messages = [
      {
        id: 'm_current_user',
        role: 'user',
        text: `当前图 ${path}`,
        createdAt: 1,
      },
    ];
    mergeCachedAssetsFromDisk([
      {
        kind: 'image',
        source: 'generated',
        title: 'pasted-current.png',
        localPath: path,
        sizeBytes: 2,
        createdAtMs: 100,
        modifiedAtMs: 300,
      },
    ]);

    const events: unknown[] = [];
    const onJump = (event: Event) => {
      events.push((event as CustomEvent).detail);
    };
    window.addEventListener('ugs:asset-session-jump', onJump);
    const view = await renderModal();

    try {
      expect(view.container.querySelector('[role="button"]')).toBeNull();
      await act(async () => { Array.from(view.container.querySelectorAll('button')).find(button => button.textContent?.startsWith('输入素材'))?.click(); });
      const row = view.container.querySelector('[role="button"]');
      expect(row?.textContent).toContain('pasted-current.png');

      await act(async () => {
        row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      await waitFor(
        () => storeMocks.selectSession.mock.calls.length > 0,
        'current asset jump session selection',
      );
      expect(storeMocks.selectSession).toHaveBeenCalledWith('s_current', 'w_1');
      expect(events).toEqual([
        {
          assetId: 'disk:e:/ultragamestudio/.ultragamestudio/clipboard-images/pasted-current.png',
          sessionId: 's_current',
          workspaceId: 'w_1',
          messageId: 'm_current_user',
        },
      ]);
    } finally {
      window.removeEventListener('ugs:asset-session-jump', onJump);
      await view.cleanup();
    }
  });

  it('links a cached generated image to the nearest active message before jumping', async () => {
    const path =
      'E:\\UltraGameStudio\\.ultragamestudio\\assets\\image\\image.png';
    mockState.messages = [
      {
        id: 'm_current_user',
        role: 'user',
        text: '/image 一张海报',
        createdAt: 1_000,
      },
      {
        id: 'm_current_assistant',
        role: 'assistant',
        text:
          '✓ 图片生成完成\n\n![生成图片 1](data:image/png;base64,AAAA)',
        createdAt: 1_020,
      },
    ];
    mergeCachedAssetsFromDisk([
      {
        kind: 'image',
        source: 'generated',
        title: 'image.png',
        localPath: path,
        sizeBytes: 2,
        createdAtMs: 1_010,
        modifiedAtMs: 1_030,
        workspaceId: 'w_1',
      },
    ]);

    const events: unknown[] = [];
    const onJump = (event: Event) => {
      events.push((event as CustomEvent).detail);
    };
    window.addEventListener('ugs:asset-session-jump', onJump);
    const view = await renderModal();

    try {
      await waitFor(
        () => Boolean(view.container.querySelector('[role="button"]')),
        'nearest-linked asset row',
      );
      const row = view.container.querySelector('[role="button"]');
      expect(row?.textContent).toContain('image.png');

      await act(async () => {
        row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      await waitFor(
        () => storeMocks.selectSession.mock.calls.length > 0,
        'nearest asset jump session selection',
      );
      expect(storeMocks.selectSession).toHaveBeenCalledWith('s_current', 'w_1');
      expect(events).toEqual([
        {
          assetId: 'disk:e:/ultragamestudio/.ultragamestudio/assets/image/image.png',
          sessionId: 's_current',
          workspaceId: 'w_1',
          messageId: 'm_current_assistant',
        },
      ]);
    } finally {
      window.removeEventListener('ugs:asset-session-jump', onJump);
      await view.cleanup();
    }
  });
});
