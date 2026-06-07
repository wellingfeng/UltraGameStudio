/**
 * Record the current chat conversation as a scrolling-playback GIF.
 *
 * Unlike {@link captureConversation} (one static long image), this produces an
 * animated GIF that scrolls the whole conversation from top to bottom — a
 * "replay" of the session. Implementation:
 *
 *   1. Reuse the screenshot primitives to expand the scroll container to its
 *      full height and rasterize it once into a single tall source canvas
 *      (sliced + stacked to dodge the per-axis <canvas> pixel ceiling).
 *   2. Step a viewport-sized window down that tall canvas, emitting one GIF
 *      frame per step. Frame count is capped so very long sessions stay a
 *      reasonable file size (the scroll step grows instead).
 *   3. Quantize each frame to a 256-colour palette and encode with gifenc.
 *
 * Saving mirrors the PNG path: automatic desktop save under
 * `.omc/session-captures`, blob download in the browser.
 *
 * As with the static capture, faithful frames require every message to already
 * be mounted with its rich renderer — the caller forces eager rendering and
 * waits a frame before invoking this.
 */
import { saveSessionCapture, tauriAvailable } from '@/lib/tauri';
import {
  CAPTURE_SCALE,
  captureBytesToBase64,
  captureSlice,
  measureCaptureCrop,
  measureCaptureContentWidth,
  resolveBackground,
  withCompactCaptureLayout,
  withCaptureExcludedElementsHidden,
  withCaptureReadyImages,
  withExpandedContainer,
  type CaptureCrop,
  type CaptureOptions,
} from '@/lib/sessionScreenshot';

/**
 * Max canvas height per html2canvas pass (CSS px, pre-scale). The full
 * conversation is rendered in chunks this tall and stacked into one source
 * canvas. Matches the static-screenshot ceiling rationale.
 */
const MAX_SLICE_HEIGHT = 12000;

/** Hard cap on emitted frames — bounds encode time and GIF file size. */
const MAX_FRAMES = 120;

/** Default vertical travel per frame (CSS px) before the frame cap kicks in. */
const DEFAULT_SCROLL_STEP = 90;

/** Frame delay in ms (≈12.5 fps) — smooth enough for a scroll, small files. */
const FRAME_DELAY_MS = 80;

/** Trailing frames that hold on the final view so the end doesn't snap away. */
const TAIL_HOLD_FRAMES = 8;

export interface GifResult {
  /** Number of frames encoded. */
  frames: number;
  /** Where the GIF was written (file path, or a browser-download note). */
  destination: string;
  /** Local GIF path written on desktop; empty in browser-download mode. */
  paths: string[];
  /**
   * Small GIF data URL of the full animation, for an inline chat preview. GIFs
   * are already palette-quantized and compact, so the encoded bytes are embedded
   * directly. Empty string if a preview couldn't be made.
   */
  previewDataUrl: string;
}

/** Encode GIF bytes as a data URL for inline preview. */
function gifBytesToDataUrl(bytes: Uint8Array): string {
  try {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return `data:image/gif;base64,${btoa(binary)}`;
  } catch {
    return '';
  }
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

function normalizeCaptureOptions(
  input?: string | CaptureOptions,
): Required<Pick<CaptureOptions, 'baseName'>> & Pick<CaptureOptions, 'cwd'> {
  if (typeof input === 'string') return { baseName: input, cwd: undefined };
  return { baseName: input?.baseName ?? '', cwd: input?.cwd };
}

/** Trigger a browser download for the GIF. */
function browserDownloadGif(fileName: string, bytes: Uint8Array<ArrayBuffer>): void {
  const blob = new Blob([bytes], { type: 'image/gif' });
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
 * Render the full (expanded) conversation into one tall source canvas. The DOM
 * is captured in <=MAX_SLICE_HEIGHT chunks and drawn stacked, so the source
 * canvas can exceed a single html2canvas pass without being clipped.
 */
async function renderSourceCanvas(
  target: HTMLElement,
  fullHeight: number,
  background: string,
  crop: CaptureCrop,
): Promise<HTMLCanvasElement> {
  const scale = CAPTURE_SCALE;
  const out = document.createElement('canvas');
  out.width = Math.ceil(crop.width * scale);
  out.height = Math.ceil(fullHeight * scale);
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('CANVAS_2D_UNAVAILABLE');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, out.width, out.height);

  for (let y = 0; y < fullHeight; y += MAX_SLICE_HEIGHT) {
    const sliceHeight = Math.min(MAX_SLICE_HEIGHT, fullHeight - y);
    const sliceCanvas = await captureSlice(target, y, sliceHeight, background, crop);
    ctx.drawImage(sliceCanvas, 0, Math.round(y * scale));
  }
  return out;
}

/**
 * Plan the vertical scroll offsets (in source-canvas px) for each frame. Steps
 * from 0 down to the bottom of the scrollable range, capping frame count by
 * widening the step for long sessions. Always includes the final bottom offset
 * plus a short hold so the GIF settles on the end of the conversation.
 */
export function planScrollOffsets(
  sourceHeight: number,
  viewportHeight: number,
  opts: { maxFrames?: number; step?: number; tailHold?: number } = {},
): number[] {
  const maxFrames = opts.maxFrames ?? MAX_FRAMES;
  const baseStep = opts.step ?? DEFAULT_SCROLL_STEP * CAPTURE_SCALE;
  const tailHold = opts.tailHold ?? TAIL_HOLD_FRAMES;

  const maxOffset = Math.max(0, sourceHeight - viewportHeight);
  // Whole conversation already fits the viewport — a single still frame.
  if (maxOffset <= 0) return [0];

  // Reserve some frames for the tail hold; widen the step if the natural number
  // of scroll frames would exceed the budget.
  const scrollBudget = Math.max(1, maxFrames - tailHold);
  let step = baseStep;
  const naturalFrames = Math.ceil(maxOffset / step) + 1;
  if (naturalFrames > scrollBudget) {
    step = Math.ceil(maxOffset / (scrollBudget - 1));
  }

  const offsets: number[] = [];
  for (let y = 0; y < maxOffset; y += step) {
    offsets.push(Math.round(y));
  }
  offsets.push(maxOffset);
  for (let i = 0; i < tailHold; i++) offsets.push(maxOffset);
  return offsets;
}

/**
 * Record `target` (the conversation scroll container) as a scrolling GIF and
 * persist it. Returns a summary; throws on capture/encode failure.
 *
 * @param target   The scrollable conversation element.
 * @param baseName Optional file base name (no extension).
 */
export async function recordConversationGif(
  target: HTMLElement,
  options?: string | CaptureOptions,
): Promise<GifResult> {
  const totalHeight = Math.max(target.scrollHeight, target.clientHeight);
  if (totalHeight <= 0) throw new Error('EMPTY_CONVERSATION');

  const { baseName, cwd } = normalizeCaptureOptions(options);
  const background = resolveBackground(target);
  // The playback viewport height is the container's normal (collapsed) height.
  const viewportCssHeight = Math.max(target.clientHeight, 1);

  const source = await withExpandedContainer(target, (fullHeight) =>
    withCaptureExcludedElementsHidden(target, () =>
      withCaptureReadyImages(target, () => {
        const contentWidth = measureCaptureContentWidth(target);
        return withCompactCaptureLayout(target, contentWidth, () => {
          const compactFullHeight = Math.max(target.scrollHeight, fullHeight);
          const crop = measureCaptureCrop(target);
          return renderSourceCanvas(target, compactFullHeight, background, crop);
        });
      }),
    ),
  );

  const scale = CAPTURE_SCALE;
  const frameWidth = source.width;
  const frameHeight = Math.min(
    source.height,
    Math.round(viewportCssHeight * scale),
  );

  const offsets = planScrollOffsets(source.height, frameHeight);

  // Lazy-load the encoder so it stays out of the initial bundle.
  const { GIFEncoder, quantize, applyPalette } = await import('gifenc');
  const gif = GIFEncoder();

  // Reusable frame canvas — we crop a viewport-sized window out of the tall
  // source canvas for each scroll offset.
  const frameCanvas = document.createElement('canvas');
  frameCanvas.width = frameWidth;
  frameCanvas.height = frameHeight;
  const frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true });
  if (!frameCtx) throw new Error('CANVAS_2D_UNAVAILABLE');

  for (const offset of offsets) {
    frameCtx.fillStyle = background;
    frameCtx.fillRect(0, 0, frameWidth, frameHeight);
    frameCtx.drawImage(
      source,
      0,
      offset,
      frameWidth,
      frameHeight,
      0,
      0,
      frameWidth,
      frameHeight,
    );
    const { data } = frameCtx.getImageData(0, 0, frameWidth, frameHeight);
    const palette = quantize(data, 256);
    const index = applyPalette(data, palette);
    gif.writeFrame(index, frameWidth, frameHeight, {
      palette,
      delay: FRAME_DELAY_MS,
    });
  }
  gif.finish();

  const bytes = gif.bytes() as Uint8Array<ArrayBuffer>;
  const base = (baseName.trim() || defaultBaseName()).replace(/\.gif$/i, '');
  const fileName = `${base}.gif`;
  // Embed the animation inline only when it's small enough to keep the chat
  // message light (~2MB of base64); otherwise rely on the saved file path.
  const previewDataUrl =
    bytes.length <= 1_500_000 ? gifBytesToDataUrl(bytes) : '';

  if (!tauriAvailable()) {
    browserDownloadGif(fileName, bytes);
    return {
      frames: offsets.length,
      destination: 'browser-download',
      paths: [],
      previewDataUrl,
    };
  }

  const path = await saveSessionCapture({
    bytesBase64: captureBytesToBase64(bytes),
    mime: 'image/gif',
    fileName,
    cwd: cwd ?? null,
  });
  return {
    frames: offsets.length,
    destination: path,
    paths: [path],
    previewDataUrl,
  };
}
