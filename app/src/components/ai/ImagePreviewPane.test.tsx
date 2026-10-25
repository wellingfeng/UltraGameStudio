import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ImagePreviewPane from './ImagePreviewPane';

describe('ImagePreviewPane', () => {
  let container: HTMLDivElement;
  let root: Root;
  let viewport: HTMLDivElement;
  const image = () => container.querySelector('img')!;
  const pointer = async (type: string, button: number, x: number, y: number) => {
    const event = new MouseEvent(type, { bubbles: true, button, clientX: x, clientY: y });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    await act(async () => { viewport.dispatchEvent(event); });
  };
  const wheel = async (deltaY: number, x = 400, y = 300) => {
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY, clientX: x, clientY: y });
    await act(async () => { viewport.dispatchEvent(event); });
    return event;
  };

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(createElement(ImagePreviewPane, { src: 'a.png', alt: '测试图片' })); });
    viewport = container.querySelector('.ai-image-preview-viewport')!;
    viewport.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect;
    viewport.setPointerCapture = vi.fn();
    viewport.hasPointerCapture = vi.fn(() => true);
    viewport.releasePointerCapture = vi.fn();
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('zooms around the cursor and blocks page scrolling', async () => {
    const event = await wheel(-Math.log(2) / 0.002, 600, 400);
    expect(event.defaultPrevented).toBe(true);
    expect(image().style.transform).toBe('translate(-200px, -100px) scale(2)');
    expect(container.querySelector('output')?.textContent).toBe('200%');
    await wheel(Math.log(2) / 0.002, 600, 400);
    expect(image().style.transform).toBe('translate(0px, 0px) scale(1)');
  });

  it('only pans with the left button, captures the pointer, and stops on release', async () => {
    await pointer('pointerdown', 2, 100, 100);
    await pointer('pointermove', 2, 130, 140);
    expect(image().style.transform).toBe('translate(0px, 0px) scale(1)');
    await pointer('pointerdown', 0, 100, 100);
    expect(viewport.setPointerCapture).toHaveBeenCalledWith(1);
    await pointer('pointermove', 0, 130, 140);
    expect(image().style.transform).toBe('translate(30px, 40px) scale(1)');
    expect(viewport.style.cursor).toBe('grabbing');
    await pointer('pointerup', 0, 130, 140);
    expect(viewport.releasePointerCapture).toHaveBeenCalledWith(1);
    await pointer('pointermove', 0, 200, 200);
    expect(image().style.transform).toBe('translate(30px, 40px) scale(1)');
    expect(viewport.style.cursor).toBe('grab');
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    viewport.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
  });

  it('clamps zoom and resets size and position on request or image change', async () => {
    await wheel(-100000);
    expect(container.querySelector('output')?.textContent).toBe('1600%');
    await wheel(100000);
    expect(container.querySelector('output')?.textContent).toBe('10%');
    await pointer('pointerdown', 0, 100, 100);
    await pointer('pointermove', 0, 150, 120);
    await act(async () => { container.querySelector('button')!.click(); });
    expect(image().style.transform).toBe('translate(0px, 0px) scale(1)');
    await wheel(-200);
    await act(async () => { root.render(createElement(ImagePreviewPane, { src: 'b.png', alt: '另一张图片' })); });
    expect(image().style.transform).toBe('translate(0px, 0px) scale(1)');
    expect(viewport.style.cursor).toBe('grab');
  });
});
