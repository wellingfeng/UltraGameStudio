import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OfficePreviewPane from './OfficePreviewPane';
import { previewOfficeDocument } from '@/lib/tauri';
import { tArgs } from '@/lib/i18n';
import { useStore } from '@/store/useStore';

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri')>()),
  previewOfficeDocument: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) =>
    `http://asset.localhost/${encodeURIComponent(path)}`,
}));

const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

describe('OfficePreviewPane', () => {
  let container: HTMLDivElement;
  let root: Root;
  let rootStyle: string | null;

  beforeEach(() => {
    rootStyle = document.documentElement.getAttribute('style');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.mocked(previewOfficeDocument).mockReset();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    if (rootStyle === null) document.documentElement.removeAttribute('style');
    else document.documentElement.setAttribute('style', rootStyle);
  });

  it('shows one slide at a time and admits what was not read', async () => {
    vi.mocked(previewOfficeDocument).mockResolvedValue({
      kind: 'pptx',
      pageCount: 42,
      truncated: true,
      pages: [
        { index: 1, html: '<h2>第 1 页</h2><p>封面</p>' },
        { index: 2, html: '<h2>第 2 页</h2><p>目录</p>' },
      ],
    });

    await act(async () => {
      root.render(
        createElement(OfficePreviewPane, {
          path: 'E:\\deck.pptx',
          streamPath: 'E:\\deck.pptx',
          mime: PPTX_MIME,
          fileName: 'deck.pptx',
        }),
      );
    });
    await act(async () => {});

    expect(container.querySelector('iframe')?.getAttribute('srcdoc')).toContain(
      '封面',
    );
    // 断言按当前语言算，测试不依赖 store 的初始 locale。
    const locale = useStore.getState().locale;
    expect(container.textContent).toContain(
      tArgs(locale, 'doc.pageOf', { current: 1, total: 2 }),
    );
    // 只解析了前两页，必须明确告诉用户还剩多少页没读。
    expect(container.textContent).toContain(
      tArgs(locale, 'doc.truncatedPages', { shown: 2, total: 42 }),
    );
  });

  it('pages through the already-parsed slides without re-reading the file', async () => {
    vi.mocked(previewOfficeDocument).mockResolvedValue({
      kind: 'xlsx',
      pageCount: 2,
      truncated: false,
      pages: [
        { index: 1, html: '<h2>工作表 1</h2>' },
        { index: 2, html: '<h2>工作表 2</h2>' },
      ],
    });

    await act(async () => {
      root.render(
        createElement(OfficePreviewPane, {
          path: 'E:\\book.xlsx',
          streamPath: 'E:\\book.xlsx',
          mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          fileName: 'book.xlsx',
        }),
      );
    });
    await act(async () => {});

    const next = Array.from(container.querySelectorAll('button')).at(-1);
    await act(async () => {
      next?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelector('iframe')?.getAttribute('srcdoc')).toContain(
      '工作表 2',
    );
    expect(container.textContent).toContain(
      tArgs(useStore.getState().locale, 'doc.pageOf', { current: 2, total: 2 }),
    );
    // 翻页只是切换已解析的内容，不该再打一次后端。
    expect(previewOfficeDocument).toHaveBeenCalledTimes(1);
  });

  it('updates an open preview from the app palette without re-reading or changing pages', async () => {
    const appRoot = document.documentElement;
    appRoot.style.setProperty('--bg', '#191919');
    appRoot.style.setProperty('--fg', '#d4d4d4');
    appRoot.style.colorScheme = 'dark';
    vi.mocked(previewOfficeDocument).mockResolvedValue({
      kind: 'xlsx', pageCount: 2, truncated: false,
      pages: [{ index: 1, html: '<p>第一页</p>' }, { index: 2, html: '<p>第二页</p>' }],
    });
    await act(async () => {
      root.render(createElement(OfficePreviewPane, {
        path: 'E:\\book.xlsx', streamPath: 'E:\\book.xlsx',
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        fileName: 'book.xlsx',
      }));
    });
    const iframe = container.querySelector('iframe')!;
    expect(iframe.getAttribute('sandbox')).toBe('');
    expect(iframe.srcdoc).toContain('--bg:#191919;');
    expect(iframe.srcdoc).toContain('--fg:#d4d4d4;');
    expect(iframe.srcdoc).toContain('color-scheme:dark;');
    await act(async () => {
      Array.from(container.querySelectorAll('button')).at(-1)?.click();
    });
    await act(async () => {
      appRoot.style.setProperty('--bg', '#f6f7f9');
      appRoot.style.setProperty('--fg', '#202124');
      appRoot.style.colorScheme = 'light';
    });
    expect(iframe.srcdoc).toContain('--bg:#f6f7f9;');
    expect(iframe.srcdoc).toContain('--fg:#202124;');
    expect(iframe.srcdoc).toContain('color-scheme:light;');
    expect(iframe.srcdoc).toContain('第二页');
    expect(previewOfficeDocument).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.bg-white')).toBeNull();
  });
});
