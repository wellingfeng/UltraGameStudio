import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import PreviewFloatingTools from './PreviewFloatingTools';

const key = 'ultragamestudio.previewFloatingTools.position.v1';
const source = () => ({ label: '测试', load: async () => undefined });
const rect = (left: number, top: number, width: number, height: number) => ({
  x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => ({}),
}) as DOMRect;

let host: HTMLDivElement;
let root: Root;
let pane = rect(100, 50, 600, 400);
let secondPane = rect(50, 70, 700, 400);
let opened: Mock<() => void>;

beforeEach(() => {
  localStorage.removeItem(key);
  pane = rect(100, 50, 600, 400);
  secondPane = rect(50, 70, 700, 400);
  opened = vi.fn();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.pane === 'one') return pane;
    if (this.dataset.pane === 'two') return secondPane;
    if (this.classList.contains('ugs-browser-viewport')) return rect(pane.left, pane.top, pane.width - 46, pane.height);
    if (this.classList.contains('ugs-preview-floating-tools')) {
      const parent = this.parentElement?.dataset.pane === 'two' ? secondPane : pane;
      return rect(parent.left + (parseFloat(this.style.left) || 400), parent.top + (parseFloat(this.style.top) || 50), 37, 37);
    }
    return rect(0, 0, 0, 0);
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  localStorage.removeItem(key);
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as Partial<HTMLElement>).setPointerCapture;
});

async function render(two = false, browser = false) {
  await act(async () => root.render(<>
    <div data-pane="one" className={browser ? 'ugs-browser-body-gutter' : ''}>
      {browser && <div className="ugs-browser-viewport" />}
      <PreviewFloatingTools label="文件随手聊" source={source} onOpen={opened} />
    </div>
    {two && <div data-pane="two"><PreviewFloatingTools label="网页随手聊" source={source} onOpen={opened} /></div>}
  </>));
}

async function pointer(button: HTMLElement, type: string, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  await act(async () => button.dispatchEvent(event));
}

async function click(button: HTMLElement) {
  await act(async () => button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
}

it('拖动后保存全局位置并同步其他预览，松开不会打开聊天，重新挂载后恢复', async () => {
  await render(true);
  const button = host.querySelector<HTMLElement>('[aria-label="文件随手聊"]')!;
  await pointer(button, 'pointerdown', 510, 110);
  await pointer(button, 'pointermove', 310, 210);
  await pointer(button, 'pointerup', 310, 210);
  await click(button);
  expect(opened).not.toHaveBeenCalled();
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ x: 300, y: 200 });
  expect(button.parentElement?.style.left).toBe('200px');
  expect(host.querySelector<HTMLElement>('[aria-label="网页随手聊"]')?.parentElement?.style.left).toBe('250px');
  await click(button);
  expect(opened).toHaveBeenCalledTimes(1);

  await act(async () => root.render(null));
  await act(async () => root.render(<div data-pane="two"><PreviewFloatingTools label="重新打开" source={source} onOpen={opened} /></div>));
  const restored = host.querySelector<HTMLElement>('[aria-label="重新打开"]')!.parentElement!;
  expect(restored.style.left).toBe('250px');
  expect(restored.style.top).toBe('130px');
});

it('普通点击保留原行为，轻微抖动不会保存位置', async () => {
  await render();
  const button = host.querySelector<HTMLElement>('[aria-label="文件随手聊"]')!;
  await pointer(button, 'pointerdown', 510, 110);
  await pointer(button, 'pointerup', 512, 111);
  await click(button);
  expect(opened).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem(key)).toBeNull();
});

it('预览区缩小时限制显示位置，不覆盖原来的全局位置', async () => {
  localStorage.setItem(key, JSON.stringify({ x: 650, y: 350 }));
  await render();
  const rail = host.querySelector<HTMLElement>('.ugs-preview-floating-tools')!;
  expect(rail.style.left).toBe('550px');
  pane = rect(100, 50, 300, 200);
  await act(async () => window.dispatchEvent(new Event('resize')));
  expect(rail.style.left).toBe('263px');
  expect(rail.style.top).toBe('163px');
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ x: 650, y: 350 });
  pane = rect(100, 50, 600, 400);
  await act(async () => window.dispatchEvent(new Event('resize')));
  expect(rail.style.left).toBe('550px');
  expect(rail.style.top).toBe('300px');
});

it('原生浏览器视图保持按钮位于可点击的侧边区域', async () => {
  localStorage.setItem(key, JSON.stringify({ x: 300, y: 200 }));
  await render(false, true);
  const rail = host.querySelector<HTMLElement>('.ugs-preview-floating-tools')!;
  expect(rail.style.left).toBe('554px');
  expect(rail.style.top).toBe('150px');
});

it('取消拖动恢复原位置，方向键移动并保存', async () => {
  await render();
  const button = host.querySelector<HTMLElement>('[aria-label="文件随手聊"]')!;
  await pointer(button, 'pointerdown', 510, 110);
  await pointer(button, 'pointermove', 310, 210);
  await pointer(button, 'pointercancel', 310, 210);
  expect(button.parentElement?.style.left).toBe('');
  expect(localStorage.getItem(key)).toBeNull();
  await act(async () => button.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowLeft' })));
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ x: 484, y: 100 });
});
