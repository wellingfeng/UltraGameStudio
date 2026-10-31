import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PdfPreview from './PdfPreview';

const mocks = vi.hoisted(() => ({
  render: vi.fn(),
  getDocument: vi.fn(),
}));
vi.mock('pdfjs-dist', () => ({ getDocument: mocks.getDocument, GlobalWorkerOptions: {} }));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'worker.js' }));

describe('PDF preview zoom', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AA==');
    mocks.render.mockReset().mockImplementation(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
    const page = {
      getViewport: ({ scale }: { scale: number }) => ({ width: 500 * scale, height: 700 * scale }),
      imageCoordinates: new Float32Array([0.1, 0.2, 0.1, 0.6, 0.8, 0.2]),
      render: mocks.render,
    };
    mocks.getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: 1, getPage: async () => page }), destroy: vi.fn() });
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('rerenders the page at higher resolution and opens its image region', async () => {
    await act(async () => { root.render(createElement(PdfPreview, { url: 'sample.pdf' })); });
    const canvas = container.querySelector('canvas')!;
    const originalWidth = canvas.width;
    expect(mocks.render.mock.lastCall?.[0].recordImages).toBe(true);
    expect(container.querySelector('[aria-label="查看 PDF 图片"]')).not.toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="放大预览"]')!.click());
    expect(canvas.width).toBeGreaterThan(originalWidth);
    expect(container.querySelector('output[aria-label="预览缩放比例"]')?.textContent).toBe('120%');
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100 });
    await act(async () => canvas.dispatchEvent(wheel));
    expect(wheel.defaultPrevented).toBe(true);
    expect(container.querySelector('output[aria-label="预览缩放比例"]')?.textContent).toBe('147%');
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="查看 PDF 图片"]')!.click());
    expect(container.querySelector('[role="dialog"][aria-label="PDF 图片查看"]')).not.toBeNull();
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(container.querySelector('[role="dialog"][aria-label="PDF 图片查看"]')).toBeNull();
  });
});
