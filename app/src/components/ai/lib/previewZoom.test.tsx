import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { withPreviewInteractions, zoomFromWheel } from './previewZoom';
import { pdfImageRegions } from './pdfImageRegions';

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options: { runScripts: 'dangerously' }) => { window: Window & typeof globalThis };
};

describe('document preview interactions', () => {
  it('scales with Ctrl-wheel and leaves ordinary scrolling alone', () => {
    const dom = new JSDOM(withPreviewInteractions('<html><head></head><body><p>正文</p></body></html>'), { runScripts: 'dangerously' });
    const { window } = dom;
    const plainWheel = new window.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 });
    window.document.body.dispatchEvent(plainWheel);
    expect(plainWheel.defaultPrevented).toBe(false);
    const zoomWheel = new window.WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100 });
    window.document.body.dispatchEvent(zoomWheel);
    expect(zoomWheel.defaultPrevented).toBe(true);
    expect(Number(window.document.documentElement.style.zoom)).toBeGreaterThan(1);
    dom.window.close();
  });

  it('opens a clicked image and closes it on Escape without triggering its link', () => {
    const dom = new JSDOM(withPreviewInteractions('<html><head></head><body><a href="https://example.com"><img src="data:image/png;base64,AA==" alt="示例图"></a></body></html>'), { runScripts: 'dangerously' });
    const { window } = dom;
    const image = window.document.querySelector('img')!;
    Object.defineProperty(image, 'currentSrc', { value: image.src });
    const click = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    image.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(window.document.documentElement.lastElementChild?.tagName).toBe('DIV');
    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(window.document.documentElement.lastElementChild?.tagName).toBe('BODY');
    dom.window.close();
  });

  it('bounds zoom and converts PDF image coordinates to visible rectangles', () => {
    expect(zoomFromWheel(1, -10000)).toBe(4);
    expect(zoomFromWheel(1, 10000)).toBe(0.25);
    const [region] = pdfImageRegions([0.1, 0.2, 0.1, 0.6, 0.8, 0.2]);
    expect(region.x).toBeCloseTo(0.1);
    expect(region.y).toBeCloseTo(0.2);
    expect(region.width).toBeCloseTo(0.7);
    expect(region.height).toBeCloseTo(0.4);
  });
});
