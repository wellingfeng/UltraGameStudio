import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OfficePreviewPane from './OfficePreviewPane';
import { previewOfficeDocument, renderPresentationPreview } from '@/lib/tauri';
import { t, tArgs } from '@/lib/i18n';
import { useStore } from '@/store/useStore';

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri')>()),
  previewOfficeDocument: vi.fn(),
  renderPresentationPreview: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) =>
    `http://asset.localhost/${encodeURIComponent(path)}`,
}));

vi.mock('./PdfPreview', () => ({
  default: ({ url }: { url: string }) => createElement('div', { 'data-pdf-url': url }),
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
    vi.mocked(renderPresentationPreview).mockReset();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    if (rootStyle === null) document.documentElement.removeAttribute('style');
    else document.documentElement.setAttribute('style', rootStyle);
  });

  it.each([
    { mime: PPTX_MIME, extension: 'pptx' },
    { mime: 'application/vnd.ms-powerpoint', extension: 'ppt' },
  ])('loads rendered .$extension slides through the asset protocol', async ({ mime, extension }) => {
    const path = `E:\\分享资料\\案例.${extension}`;
    const pdfPath = 'E:\\预览缓存\\演示.pdf';
    vi.mocked(renderPresentationPreview).mockResolvedValue(pdfPath);

    await act(async () => {
      root.render(createElement(OfficePreviewPane, {
        path, streamPath: path, mime, fileName: `案例.${extension}`,
      }));
    });

    expect(renderPresentationPreview).toHaveBeenCalledExactlyOnceWith(path);
    expect(previewOfficeDocument).not.toHaveBeenCalled();
    expect(container.querySelector('[data-pdf-url]')?.getAttribute('data-pdf-url')).toBe(
      `http://asset.localhost/${encodeURIComponent(pdfPath)}`,
    );
  });

  it('shows the simplified PPTX preview and its page limit when rendering fails', async () => {
    vi.mocked(renderPresentationPreview).mockRejectedValue(new Error('PowerPoint is unavailable'));
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

    const html = container.querySelector('iframe')?.getAttribute('srcdoc');
    expect(html).toContain('封面');
    expect(html).toContain('目录');
    // 断言按当前语言算，测试不依赖 store 的初始 locale。
    const locale = useStore.getState().locale;
    expect(container.textContent).toContain(t(locale, 'doc.presentationLayoutFallback'));
    expect(container.querySelector(`[title="${t(locale, 'doc.nextPage')}"]`)).toBeNull();
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
    expect(renderPresentationPreview).not.toHaveBeenCalled();
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
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe.srcdoc).toContain('Content-Security-Policy');
    expect(iframe.srcdoc).toMatch(/script-src 'nonce-[0-9a-f]+'/);
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
