/**
 * Capture the current chat conversation as a long screenshot (PNG).
 *
 * The conversation stream (the `fuc-ai-return-stream` scroll container in
 * AIDock) is rasterized at its *full* scrollHeight — not just the visible
 * viewport — so the resulting image is one continuous "long screenshot" of the
 * whole session. Browser <canvas> has a per-axis pixel ceiling (~32k on most
 * engines), so very long sessions are split into multiple stitched page images
 * instead of being silently clipped.
 *
 * Saving: inside the Tauri desktop shell images are written automatically under
 * the active workspace's `.omc/session-captures` folder (or a temp fallback when
 * no workspace is selected). In a plain browser the image is offered as a normal
 * download. Multi-page captures save each page as `<base>-1.png`,
 * `<base>-2.png`, … so the pieces can be viewed/stitched in order.
 *
 * Faithful capture depends on every message already being mounted with its rich
 * renderer — off-screen messages in AIDock render as cheap plain text until they
 * scroll into view (see LazyMessageContent). The caller is responsible for
 * forcing eager rendering and waiting a frame before invoking capture.
 */
import {
  fetchCaptureImageDataUrl,
  saveSessionCapture,
  tauriAvailable,
} from '@/lib/tauri';
import { convertColorTokens, sanitizeClonedColors } from '@/lib/sanitizeOklab';

/** Lazily load html2canvas so it stays out of the initial bundle. */
async function loadHtml2Canvas() {
  const mod = await import('html2canvas');
  return mod.default;
}

/**
 * Safe maximum height (CSS px, pre-scale) for a single captured page. Kept well
 * under the ~32767px canvas ceiling so that, after the 2x device scale, the
 * backing canvas stays valid across Chromium/WebKit. Sessions taller than this
 * are split into multiple pages.
 */
const MAX_PAGE_HEIGHT = 12000;

/** Render scale — 2x for crisp text on hi-dpi displays. */
export const CAPTURE_SCALE = 2;

const IMAGE_READY_TIMEOUT_MS = 8000;
const CAPTURE_EDGE_PADDING = 24;
const MIN_CAPTURE_WIDTH = 360;
const CAPTURE_EXCLUDE_SELECTOR = '[data-fuc-capture-exclude="true"]';

export interface CaptureResult {
  /** Number of page images produced. */
  pages: number;
  /** Where the images were written (file paths, or a browser-download note). */
  destination: string;
  /** Individual local paths written on desktop; empty in browser-download mode. */
  paths: string[];
  /** True when split across multiple stitched pages. */
  stitched: boolean;
  /**
   * Small downscaled PNG data URL of the first page, for an inline chat preview.
   * The full-resolution image lives on disk (see `destination`); this thumbnail
   * keeps the chat message light. Empty string if a preview couldn't be made.
   */
  previewDataUrl: string;
}

export interface CaptureOptions {
  /** Optional file base name (no extension). */
  baseName?: string;
  /** Active workspace path; desktop saves under `<cwd>/.omc/session-captures`. */
  cwd?: string;
}

export interface CaptureCrop {
  /** Horizontal crop offset within the expanded scroll container, in CSS px. */
  x: number;
  /** Horizontal crop width, in CSS px. */
  width: number;
}

/**
 * Downscale a source canvas to at most `maxWidth` wide / `maxHeight` tall and
 * return it as a PNG data URL. Used for a lightweight inline chat preview.
 */
function makePreviewDataUrl(
  source: HTMLCanvasElement,
  maxWidth = 480,
  maxHeight = 1600,
): string {
  try {
    const scale = Math.min(
      1,
      maxWidth / source.width,
      maxHeight / source.height,
    );
    const w = Math.max(1, Math.round(source.width * scale));
    const h = Math.max(1, Math.round(source.height * scale));
    const thumb = document.createElement('canvas');
    thumb.width = w;
    thumb.height = h;
    const ctx = thumb.getContext('2d');
    if (!ctx) return '';
    ctx.drawImage(source, 0, 0, w, h);
    return thumb.toDataURL('image/png');
  } catch {
    return '';
  }
}

function setClonedImagesEager(doc: Document): void {
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    img.setAttribute('loading', 'eager');
    img.setAttribute('decoding', 'sync');
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function isDataImageUrl(src: string): boolean {
  return /^data:image\//i.test(src.trim());
}

function isHttpUrl(src: string): boolean {
  return /^https?:\/\//i.test(src.trim());
}

function isBlobUrl(src: string): boolean {
  return /^blob:/i.test(src.trim());
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      result ? resolve(result) : reject(new Error('EMPTY_DATA_URL'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('BLOB_READ_FAILED'));
    reader.readAsDataURL(blob);
  });
}

async function browserFetchImageDataUrl(src: string): Promise<string | null> {
  try {
    const response = await fetch(src);
    if (!response.ok) return null;
    const blob = await response.blob();
    if (!blob.type.toLowerCase().startsWith('image/')) return null;
    return await blobToDataUrl(blob);
  } catch {
    return null;
  }
}

async function imageDataUrlForCapture(src: string): Promise<string | null> {
  const trimmed = src.trim();
  if (!trimmed || isDataImageUrl(trimmed)) return null;
  if (isBlobUrl(trimmed)) return browserFetchImageDataUrl(trimmed);
  if (!isHttpUrl(trimmed)) return null;

  if (tauriAvailable()) {
    try {
      return await fetchCaptureImageDataUrl(trimmed);
    } catch {
      // Fall back to browser fetch for providers that already expose CORS.
    }
  }

  return browserFetchImageDataUrl(trimmed);
}

async function waitForImageReady(img: HTMLImageElement): Promise<void> {
  const src = img.currentSrc || img.src || img.getAttribute('src') || '';
  if (!src.trim()) return;

  img.loading = 'eager';
  img.decoding = 'sync';

  const loaded = img.complete
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        const done = () => {
          img.removeEventListener('load', done);
          img.removeEventListener('error', done);
          resolve();
        };
        img.addEventListener('load', done);
        img.addEventListener('error', done);
      });

  await Promise.race([loaded, wait(IMAGE_READY_TIMEOUT_MS)]);
  if (img.complete && img.naturalWidth > 0) {
    await Promise.race([
      img.decode().catch(() => undefined),
      wait(IMAGE_READY_TIMEOUT_MS),
    ]);
  }
}

function restoreAttribute(
  el: Element,
  name: string,
  value: string | null,
): void {
  if (value === null) el.removeAttribute(name);
  else el.setAttribute(name, value);
}

async function prepareImageForCapture(img: HTMLImageElement): Promise<() => void> {
  const original = {
    src: img.getAttribute('src'),
    srcset: img.getAttribute('srcset'),
    loading: img.getAttribute('loading'),
    decoding: img.getAttribute('decoding'),
  };

  img.loading = 'eager';
  img.decoding = 'sync';

  try {
    const src = img.currentSrc || img.src || img.getAttribute('src') || '';
    const dataUrl = await imageDataUrlForCapture(src);
    if (dataUrl) {
      img.removeAttribute('srcset');
      img.src = dataUrl;
    }
    await waitForImageReady(img);
  } catch {
    await waitForImageReady(img);
  }

  return () => {
    restoreAttribute(img, 'src', original.src);
    restoreAttribute(img, 'srcset', original.srcset);
    restoreAttribute(img, 'loading', original.loading);
    restoreAttribute(img, 'decoding', original.decoding);
  };
}

/**
 * Make chat images canvas-readable before html2canvas snapshots the stream.
 *
 * Image-mode providers often return remote `https://...` URLs. The WebView can
 * display them, but html2canvas cannot draw cross-origin pixels unless the
 * image is CORS-readable. For desktop captures we temporarily replace those
 * sources with backend-fetched data URLs, wait for decode, capture, then restore
 * the live DOM.
 */
export async function withCaptureReadyImages<T>(
  target: HTMLElement,
  fn: () => Promise<T>,
): Promise<T> {
  const images = Array.from(target.querySelectorAll<HTMLImageElement>('img'));
  if (images.length === 0) return fn();

  const restoreFns: Array<() => void> = [];
  try {
    restoreFns.push(...(await Promise.all(images.map(prepareImageForCapture))));
    await nextAnimationFrame();
    return await fn();
  } finally {
    for (const restore of restoreFns.reverse()) restore();
  }
}

function finiteNumber(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function numericCssPx(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function visibleRect(rect: DOMRect | DOMRectReadOnly): boolean {
  return rect.width > 0 && rect.height > 0;
}

function measuredCropWidth(contentRight: number, maxWidth: number): number {
  if (maxWidth <= 0) return 1;
  if (contentRight <= 0) return maxWidth;
  const minWidth = Math.min(MIN_CAPTURE_WIDTH, maxWidth);
  return Math.min(maxWidth, Math.max(minWidth, Math.ceil(contentRight)));
}

function directMessageList(target: HTMLElement): HTMLElement | null {
  return Array.from(target.children).find(
    (child): child is HTMLElement => child instanceof HTMLElement && child.tagName === 'UL',
  ) ?? null;
}

export async function withCaptureExcludedElementsHidden<T>(
  target: HTMLElement,
  fn: () => Promise<T>,
): Promise<T> {
  const elements = Array.from(
    target.querySelectorAll<HTMLElement>(CAPTURE_EXCLUDE_SELECTOR),
  );
  if (elements.length === 0) return fn();

  const prevDisplay = elements.map((el) => el.style.display);
  try {
    for (const el of elements) el.style.display = 'none';
    void target.offsetHeight;
    await nextAnimationFrame();
    return await fn();
  } finally {
    elements.forEach((el, index) => {
      el.style.display = prevDisplay[index] ?? '';
    });
  }
}

function targetContentAreaWidth(target: HTMLElement): number {
  const style = getComputedStyle(target);
  const horizontalPadding =
    numericCssPx(style.paddingLeft) + numericCssPx(style.paddingRight);
  return Math.max(
    1,
    Math.max(target.scrollWidth, target.clientWidth) - horizontalPadding,
  );
}

function cropCanvasHorizontally(
  source: HTMLCanvasElement,
  crop: CaptureCrop,
  background: string,
): HTMLCanvasElement {
  const scale = CAPTURE_SCALE;
  const x = Math.max(0, Math.floor(crop.x * scale));
  const width = Math.min(source.width - x, Math.ceil(crop.width * scale));
  if (x <= 0 && width >= source.width) return source;

  const out = document.createElement('canvas');
  out.width = Math.max(1, width);
  out.height = source.height;
  const ctx = out.getContext('2d');
  if (!ctx) return source;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(
    source,
    x,
    0,
    out.width,
    source.height,
    0,
    0,
    out.width,
    source.height,
  );
  return out;
}

/**
 * The scroll container can be much wider than the actual transcript column,
 * especially in dock mode. Capture only the area that contains rendered text,
 * images, and message chrome instead of preserving a large empty right side.
 */
export function measureCaptureCrop(target: HTMLElement): CaptureCrop {
  const targetRect = target.getBoundingClientRect();
  const targetLeft = finiteNumber(targetRect.left) ?? 0;
  const scrollLeft = target.scrollLeft || 0;
  const maxWidth = Math.max(target.scrollWidth, target.clientWidth, 1);
  let contentRight = 0;

  const includeRect = (rect: DOMRect | DOMRectReadOnly) => {
    if (!visibleRect(rect)) return;
    const localRight = rect.right - targetLeft + scrollLeft;
    if (Number.isFinite(localRight)) {
      contentRight = Math.max(contentRight, localRight);
    }
  };

  const doc = target.ownerDocument;
  const textWalker = doc.createTreeWalker(target, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const style = getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden') {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  for (let node = textWalker.nextNode(); node; node = textWalker.nextNode()) {
    const range = doc.createRange();
    range.selectNodeContents(node);
    for (const rect of Array.from(range.getClientRects())) includeRect(rect);
    range.detach();
  }

  const visualSelector = [
    'img',
    'canvas',
    'svg',
    'video',
    'table',
    'pre',
    'blockquote',
    'button',
    'input',
    'textarea',
    'select',
    '.ai-generated-image',
    '.ai-stream-user-bubble',
    '.ai-file-chip',
    '.ai-tool-card',
    '.ai-tool-panel',
    '.ai-callout',
    '.ai-table-wrap',
    '.ai-reasoning',
    '.ai-code',
  ].join(',');

  for (const el of Array.from(target.querySelectorAll<HTMLElement>(visualSelector))) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    includeRect(el.getBoundingClientRect());
  }

  const style = getComputedStyle(target);
  const rightPadding =
    numericCssPx(style.paddingRight) + numericCssPx(style.borderRightWidth);
  return {
    x: 0,
    width: measuredCropWidth(contentRight + rightPadding + CAPTURE_EDGE_PADDING, maxWidth),
  };
}

/**
 * Measure how wide the transcript column needs to be when it is not stretched
 * across the whole return pane. Uses actual text line widths and visual blocks,
 * not their absolute x-position, so right-aligned user bubbles do not force the
 * screenshot to keep a large empty right side.
 */
export function measureCaptureContentWidth(target: HTMLElement): number {
  const maxWidth = targetContentAreaWidth(target);
  let contentWidth = 0;

  const includeRect = (rect: DOMRect | DOMRectReadOnly) => {
    if (!visibleRect(rect) || !Number.isFinite(rect.width)) return;
    contentWidth = Math.max(contentWidth, rect.width);
  };

  const doc = target.ownerDocument;
  const textWalker = doc.createTreeWalker(target, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const style = getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden') {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  for (let node = textWalker.nextNode(); node; node = textWalker.nextNode()) {
    const range = doc.createRange();
    range.selectNodeContents(node);
    for (const rect of Array.from(range.getClientRects())) includeRect(rect);
    range.detach();
  }

  const visualSelector = [
    'img',
    'canvas',
    'svg',
    'video',
    'table',
    'pre',
    'blockquote',
    'button',
    'input',
    'textarea',
    'select',
    '.ai-generated-image',
    '.ai-stream-user-bubble',
    '.ai-file-chip',
    '.ai-tool-card',
    '.ai-tool-panel',
    '.ai-callout',
    '.ai-table-wrap',
    '.ai-reasoning',
    '.ai-code',
  ].join(',');

  for (const el of Array.from(target.querySelectorAll<HTMLElement>(visualSelector))) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    includeRect(el.getBoundingClientRect());
  }

  return measuredCropWidth(contentWidth + CAPTURE_EDGE_PADDING * 2, maxWidth);
}

/**
 * Temporarily shrink the `<ul>` transcript to its natural content column before
 * capture. Without this, right-aligned user bubbles keep their far-right
 * position in the full pane, so crop measurement must preserve blank space.
 */
export async function withCompactCaptureLayout<T>(
  target: HTMLElement,
  contentWidth: number,
  fn: () => Promise<T>,
): Promise<T> {
  const list = directMessageList(target);
  if (!list) return fn();

  const prevStyle = {
    width: list.style.width,
    maxWidth: list.style.maxWidth,
    minWidth: list.style.minWidth,
  };

  try {
    const width = Math.min(targetContentAreaWidth(target), Math.max(1, contentWidth));
    list.style.width = `${Math.ceil(width)}px`;
    list.style.maxWidth = 'none';
    list.style.minWidth = '0';
    void list.offsetHeight;
    await nextAnimationFrame();
    return await fn();
  } finally {
    list.style.width = prevStyle.width;
    list.style.maxWidth = prevStyle.maxWidth;
    list.style.minWidth = prevStyle.minWidth;
  }
}

/** Read the page background so transparent gaps don't render black. */
export function resolveBackground(el: HTMLElement): string {
  try {
    const bg = getComputedStyle(document.body).backgroundColor;
    if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
      return convertColorTokens(bg);
    }
    const own = getComputedStyle(el).backgroundColor;
    if (own && own !== 'rgba(0, 0, 0, 0)' && own !== 'transparent') {
      return convertColorTokens(own);
    }
  } catch {
    /* getComputedStyle can throw in detached nodes — fall through */
  }
  return '#0b0d12';
}

/**
 * Rasterize one vertical slice [y, y+height) of `el` into a canvas. html2canvas
 * `windowHeight`/`y`/`height` capture a region of the element's full scroll box
 * without us having to actually scroll the live DOM.
 */
export async function captureSlice(
  el: HTMLElement,
  y: number,
  height: number,
  background: string,
  crop: CaptureCrop = { x: 0, width: el.scrollWidth },
): Promise<HTMLCanvasElement> {
  const html2canvas = await loadHtml2Canvas();
  const canvas = await html2canvas(el, {
    backgroundColor: background,
    scale: CAPTURE_SCALE,
    useCORS: true,
    logging: false,
    width: el.scrollWidth,
    height,
    y,
    scrollX: 0,
    scrollY: 0,
    windowWidth: el.scrollWidth,
    windowHeight: el.scrollHeight,
    // The app's theme uses color-mix(in oklab, …) extensively; html2canvas's
    // 1.4.1 color parser can't read the resulting oklab() computed values and
    // would abort. Rewrite the cloned DOM to sRGB before it rasterizes.
    onclone: (doc) => {
      sanitizeClonedColors(doc);
      setClonedImagesEager(doc);
    },
  });
  return cropCanvasHorizontally(canvas, crop, background);
}

/**
 * Temporarily expand a scrollable (overflow-y-auto, fixed-height) container to
 * its full content height with visible overflow, run `fn` (which captures the
 * now fully-laid-out box), then restore the original inline styles and scroll
 * position. html2canvas otherwise clips such a container to its visible box.
 *
 * `fn` receives the measured full content height in CSS px.
 */
export async function withExpandedContainer<T>(
  target: HTMLElement,
  fn: (fullHeight: number) => Promise<T>,
): Promise<T> {
  const totalHeight = Math.max(target.scrollHeight, target.clientHeight);
  const prevStyle = {
    height: target.style.height,
    maxHeight: target.style.maxHeight,
    overflow: target.style.overflow,
  };
  const prevScrollTop = target.scrollTop;
  try {
    target.style.height = `${totalHeight}px`;
    target.style.maxHeight = 'none';
    target.style.overflow = 'visible';
    // Force reflow so the expanded layout is measurable before rasterizing.
    void target.offsetHeight;
    const fullHeight = Math.max(target.scrollHeight, totalHeight);
    return await fn(fullHeight);
  } finally {
    target.style.height = prevStyle.height;
    target.style.maxHeight = prevStyle.maxHeight;
    target.style.overflow = prevStyle.overflow;
    target.scrollTop = prevScrollTop;
  }
}

/** Convert a canvas to PNG bytes. */
function canvasToBytes(canvas: HTMLCanvasElement): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('CANVAS_ENCODE_FAILED'));
        return;
      }
      blob
        .arrayBuffer()
        .then((buf) => resolve(new Uint8Array(buf)))
        .catch(reject);
    }, 'image/png');
  });
}

/** Default file base name, e.g. `session-2026-06-07-1432`. */
function defaultBaseName(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `session-${stamp}`;
}

export function captureBytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function normalizeCaptureOptions(
  input?: string | CaptureOptions,
): Required<Pick<CaptureOptions, 'baseName'>> & Pick<CaptureOptions, 'cwd'> {
  if (typeof input === 'string') return { baseName: input, cwd: undefined };
  return { baseName: input?.baseName ?? '', cwd: input?.cwd };
}

/**
 * Split a total CSS-pixel height into evenly-sized page slices, each at most
 * {@link MAX_PAGE_HEIGHT} tall. Returns `[y, height]` pairs covering the whole
 * box with no gaps or overlap. Exported for testing.
 */
export function planPageSlices(totalHeight: number): Array<[number, number]> {
  if (totalHeight <= 0) return [];
  const pageCount = Math.max(1, Math.ceil(totalHeight / MAX_PAGE_HEIGHT));
  const pageHeight = Math.ceil(totalHeight / pageCount);
  const slices: Array<[number, number]> = [];
  for (let i = 0; i < pageCount; i++) {
    const y = i * pageHeight;
    const height = Math.min(pageHeight, totalHeight - y);
    if (height <= 0) break;
    slices.push([y, height]);
  }
  return slices;
}

/**
 * Given the path the user picked for page 1 (e.g. `…/foo-1.png` or `…/foo.png`)
 * and a 0-based page index > 0, derive the sibling path for that page in the
 * same directory (`…/foo-2.png`, …). Handles both `/` and `\` separators.
 * Exported for testing.
 */
export function siblingPagePath(firstPath: string, pageIndex: number): string {
  const sepIndex = Math.max(
    firstPath.lastIndexOf('/'),
    firstPath.lastIndexOf('\\'),
  );
  const dir = sepIndex >= 0 ? firstPath.slice(0, sepIndex + 1) : '';
  const pickedName = sepIndex >= 0 ? firstPath.slice(sepIndex + 1) : firstPath;
  // Strip a trailing `-1.png` / `.png` to recover the user's base name.
  const pickedBase = pickedName.replace(/\.png$/i, '').replace(/-1$/, '');
  return `${dir}${pickedBase}-${pageIndex + 1}.png`;
}

/** Trigger a browser download for one PNG page. */
function browserDownloadPng(fileName: string, bytes: Uint8Array<ArrayBuffer>): void {
  const blob = new Blob([bytes], { type: 'image/png' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Capture `target` (the conversation scroll container) as one or more PNG pages
 * and persist them. Returns a summary; throws on capture/encode failure.
 *
 * @param target  The scrollable conversation element.
 * @param baseName Optional file base name (no extension).
 */
export async function captureConversation(
  target: HTMLElement,
  options?: string | CaptureOptions,
): Promise<CaptureResult> {
  const totalHeight = Math.max(target.scrollHeight, target.clientHeight);
  if (totalHeight <= 0) throw new Error('EMPTY_CONVERSATION');

  const { baseName, cwd } = normalizeCaptureOptions(options);
  const background = resolveBackground(target);

  const pages: Uint8Array<ArrayBuffer>[] = [];
  let previewDataUrl = '';
  await withExpandedContainer(target, async (fullHeight) => {
    await withCaptureExcludedElementsHidden(target, async () => {
      await withCaptureReadyImages(target, async () => {
        const contentWidth = measureCaptureContentWidth(target);
        await withCompactCaptureLayout(target, contentWidth, async () => {
          const compactFullHeight = Math.max(target.scrollHeight, fullHeight);
          const crop = measureCaptureCrop(target);
          // Slice the full scroll box into page-sized chunks so we never exceed the
          // canvas pixel ceiling. One chunk for short sessions; many for long ones.
          const slices = planPageSlices(compactFullHeight);
          for (let i = 0; i < slices.length; i++) {
            const [y, height] = slices[i];
            const canvas = await captureSlice(target, y, height, background, crop);
            // First page doubles as the inline chat preview thumbnail.
            if (i === 0) previewDataUrl = makePreviewDataUrl(canvas);
            pages.push(await canvasToBytes(canvas));
          }
        });
      });
    });
  });

  const base = (baseName.trim() || defaultBaseName()).replace(/\.png$/i, '');
  const stitched = pages.length > 1;
  const fileName = (index: number) =>
    stitched ? `${base}-${index + 1}.png` : `${base}.png`;

  if (!tauriAvailable()) {
    pages.forEach((bytes, i) => browserDownloadPng(fileName(i), bytes));
    return {
      pages: pages.length,
      destination: 'browser-download',
      paths: [],
      stitched,
      previewDataUrl,
    };
  }

  const written: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    const path = await saveSessionCapture({
      bytesBase64: captureBytesToBase64(pages[i]),
      mime: 'image/png',
      fileName: fileName(i),
      cwd: cwd ?? null,
    });
    written.push(path);
  }

  return {
    pages: written.length,
    destination: written.join('\n'),
    paths: written,
    stitched,
    previewDataUrl,
  };
}
