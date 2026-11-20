import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FileWarning, Loader2 } from 'lucide-react';
import type { PDFDocumentProxy, PDFDocumentLoadingTask, PDFPageProxy } from 'pdfjs-dist';
import { useStore } from '@/store/useStore';
import { t, tArgs, type Locale } from '@/lib/i18n';
import { PDF_DOCUMENT_OPTIONS } from '@/lib/pdfAssets'; // Moon Add
import ImagePreviewPane from './ImagePreviewPane';
import PreviewZoomControls from './PreviewZoomControls';
import { MAX_PREVIEW_ZOOM, MIN_PREVIEW_ZOOM, useCtrlWheelZoom, usePreviewZoom } from './lib/previewZoom';
import { pdfImageRegions } from './lib/pdfImageRegions';

type PageSize = { width: number; height: number };
type PdfState =
  | { status: 'loading' }
  | { status: 'ready'; doc: PDFDocumentProxy; firstPageSize: PageSize }
  | { status: 'error'; message: string };

// pdf.js rasterises on a worker thread. Without a real worker URL it silently
// falls back to the main thread, where one large PDF locks up the whole window,
// so the library and its worker are wired together exactly once.
let pdfJsPromise: Promise<typeof import('pdfjs-dist')> | null = null;

function loadPdfJs(): Promise<typeof import('pdfjs-dist')> {
  pdfJsPromise ??= (async () => {
    const pdfjs = await import('pdfjs-dist');
    const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  })();
  return pdfJsPromise;
}

function pageSize(page: PDFPageProxy): PageSize {
  const { width, height } = page.getViewport({ scale: 1 });
  return { width, height };
}

function pdfError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Keep page geometry when its canvas scrolls out of the render window. */
const PdfPageView = memo(function PdfPageView({
  doc, number, active, firstPageSize, availableWidth, zoom, locale, onImage,
}: {
  doc: PDFDocumentProxy;
  number: number;
  active: boolean;
  firstPageSize: PageSize;
  availableWidth: number;
  zoom: number;
  locale: Locale;
  onImage: (image: string) => void;
}) {
  const [size, setSize] = useState(firstPageSize);
  const [error, setError] = useState<string | null>(null);
  const scale = Math.min(availableWidth / size.width, 3) * zoom;
  const width = Math.max(1, Math.floor(size.width * scale));
  const height = Math.max(1, Math.floor(size.height * scale));

  return (
    <div
      role="group"
      aria-label={tArgs(locale, 'doc.pageOf', { current: number, total: doc.numPages })}
      className="relative shrink-0 bg-neutral-700 shadow-lg"
      style={{ width, height }}
    >
      {active && error === null && (
        <PdfPageCanvas
          doc={doc}
          number={number}
          availableWidth={availableWidth}
          zoom={zoom}
          onSize={setSize}
          onError={setError}
          onImage={onImage}
        />
      )}
      {error !== null && (
        <div className="absolute inset-0 flex items-center justify-center gap-2 overflow-hidden p-3 text-sm text-fg-dim" title={error}>
          <FileWarning size={16} className="shrink-0 text-status-error" />
          {t(locale, 'doc.cannotRender')}
        </div>
      )}
    </div>
  );
});

function PdfPageCanvas({
  doc, number, availableWidth, zoom, onSize, onError, onImage,
}: {
  doc: PDFDocumentProxy;
  number: number;
  availableWidth: number;
  zoom: number;
  onSize: (size: PageSize) => void;
  onError: (error: string) => void;
  onImage: (image: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const [imageRegions, setImageRegions] = useState<ReturnType<typeof pdfImageRegions>>([]);

  useEffect(() => {
    let disposed = false;
    let loadedPage: PDFPageProxy | undefined;
    void doc.getPage(number).then((result) => {
      if (disposed) return;
      loadedPage = result;
      onSize(pageSize(result));
      setPage(result);
    }).catch((error: unknown) => {
      if (!disposed) onError(pdfError(error));
    });
    return () => {
      disposed = true;
      loadedPage?.cleanup();
    };
  }, [doc, number, onSize, onError]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!page || !canvas) return;
    let cancelled = false;
    const rendered = document.createElement('canvas');
    const unscaled = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(availableWidth / unscaled.width, 3) * zoom });
    // Bound canvas memory at high zoom and on high DPI screens.
    const ratio = Math.min(window.devicePixelRatio || 1, Math.sqrt(16_000_000 / (viewport.width * viewport.height)));
    rendered.width = Math.max(1, Math.floor(viewport.width * ratio));
    rendered.height = Math.max(1, Math.floor(viewport.height * ratio));
    let task: ReturnType<PDFPageProxy['render']> | undefined;
    void (async () => {
      task = page.render({
        canvas: rendered,
        viewport,
        recordImages: true,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });
      await task.promise;
      if (cancelled) return;
      canvas.width = rendered.width;
      canvas.height = rendered.height;
      canvas.getContext('2d')?.drawImage(rendered, 0, 0);
      setImageRegions(pdfImageRegions(task.imageCoordinates));
    })().catch((error: unknown) => {
      if (!cancelled && (error as { name?: string } | null)?.name !== 'RenderingCancelledException') {
        onError(pdfError(error));
      }
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [page, availableWidth, zoom, onError]);

  return (
    <>
      <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full" />
      {imageRegions.map((region, index) => (
        <button
          key={index}
          type="button"
          aria-label="查看 PDF 图片"
          title="点击放大图片"
          className="absolute cursor-zoom-in border-0 bg-transparent p-0 hover:outline hover:outline-2 hover:outline-accent"
          style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }}
          onClick={() => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            const crop = document.createElement('canvas');
            crop.width = Math.max(1, Math.round(region.width * canvas.width));
            crop.height = Math.max(1, Math.round(region.height * canvas.height));
            crop.getContext('2d')?.drawImage(canvas, region.x * canvas.width, region.y * canvas.height, region.width * canvas.width, region.height * canvas.height, 0, 0, crop.width, crop.height);
            onImage(crop.toDataURL('image/png'));
          }}
        />
      ))}
    </>
  );
}

// Page offsets are relative to the positioned list. Binary search also handles
// a large wheel or scrollbar jump without measuring every page on each scroll.
function pageAtOffset(list: HTMLDivElement, offset: number) {
  let first = 0;
  let last = list.children.length - 1;
  while (first < last) {
    const middle = Math.floor((first + last) / 2);
    const page = list.children[middle] as HTMLElement;
    if (page.offsetTop + page.offsetHeight > offset) last = middle;
    else first = middle + 1;
  }
  return first;
}

function PdfScrollView({
  doc, firstPageSize, url, locale,
}: {
  doc: PDFDocumentProxy;
  firstPageSize: PageSize;
  url: string;
  locale: Locale;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const zoomAnchor = useRef<{ page: HTMLElement; fraction: number } | null>(null);
  const { zoom, setZoom } = usePreviewZoom(url);
  const [containerWidth, setContainerWidth] = useState(900);
  const [range, setRange] = useState({ start: 0, end: 0, current: 0 });
  const [imagePreview, setImagePreview] = useState<string | null>(null);

  const syncScroll = useCallback(() => {
    const container = containerRef.current;
    const list = listRef.current;
    if (!container || !list || !container.clientHeight) return;
    const top = container.getBoundingClientRect().top - list.getBoundingClientRect().top;
    const bottom = top + container.clientHeight;
    const maxScroll = container.scrollHeight - container.clientHeight;
    const atEnd = maxScroll > 1 && container.scrollTop >= maxScroll - 1;
    const current = atEnd ? doc.numPages - 1 : pageAtOffset(list, top);
    const start = pageAtOffset(list, top - container.clientHeight / 2);
    const end = pageAtOffset(list, bottom + container.clientHeight / 2);
    setRange((previous) => previous.start === start && previous.end === end && previous.current === current
      ? previous
      : { start, end, current });
  }, [doc.numPages]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const list = listRef.current;
    if (!container || !list) return;
    const update = () => {
      if (container.clientWidth) setContainerWidth(container.clientWidth);
      syncScroll();
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    observer.observe(list);
    return () => observer.disconnect();
  }, [syncScroll]);

  const zoomAroundPage = useCallback((value: number) => {
    const next = Math.min(MAX_PREVIEW_ZOOM, Math.max(MIN_PREVIEW_ZOOM, value));
    if (next === zoom) return;
    const container = containerRef.current;
    const list = listRef.current;
    if (container && list && container.scrollTop > 0) {
      const top = container.getBoundingClientRect().top - list.getBoundingClientRect().top;
      const page = list.children[pageAtOffset(list, top)] as HTMLElement;
      zoomAnchor.current = { page, fraction: (top - page.offsetTop) / Math.max(1, page.offsetHeight) };
    }
    setZoom(next);
  }, [setZoom, zoom]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const list = listRef.current;
    const anchor = zoomAnchor.current;
    if (container && list && anchor) {
      const top = container.getBoundingClientRect().top - list.getBoundingClientRect().top;
      container.scrollTop += anchor.page.offsetTop + anchor.page.offsetHeight * anchor.fraction - top;
      zoomAnchor.current = null;
    }
    syncScroll();
  }, [zoom, syncScroll]);

  useCtrlWheelZoom(containerRef, zoom, zoomAroundPage);

  useEffect(() => {
    if (!imagePreview) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); setImagePreview(null); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [imagePreview]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-center gap-3 border-b border-border-soft px-3 py-1.5 text-xs text-fg-dim">
        <PreviewZoomControls zoom={zoom} onZoom={zoomAroundPage} />
        <span className="font-mono tabular-nums">
          {tArgs(locale, 'doc.pageOf', { current: range.current + 1, total: doc.numPages })}
        </span>
      </div>
      <div
        ref={containerRef}
        onScroll={syncScroll}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto overscroll-contain bg-neutral-800 p-4"
      >
        <div ref={listRef} className="relative flex w-max min-w-full flex-col items-center gap-4">
          {Array.from({ length: doc.numPages }, (_, index) => (
            <PdfPageView
              key={index}
              doc={doc}
              number={index + 1}
              active={index >= range.start && index <= range.end}
              firstPageSize={firstPageSize}
              availableWidth={Math.max(1, containerWidth - 32)}
              zoom={zoom}
              locale={locale}
              onImage={setImagePreview}
            />
          ))}
        </div>
      </div>
      {imagePreview && <div role="dialog" aria-label="PDF 图片查看" className="absolute inset-0 z-10 flex flex-col bg-bg">
        <div className="flex justify-end border-b border-border-soft px-3 py-1.5" onClick={(event) => { if (event.target === event.currentTarget) setImagePreview(null); }}><button type="button" onClick={() => setImagePreview(null)} className="rounded px-2 py-1 text-xs text-fg-dim hover:bg-panel-2">关闭</button></div>
        <ImagePreviewPane src={imagePreview} alt="PDF 图片" onDismiss={() => setImagePreview(null)} />
      </div>}
    </div>
  );
}

/** Load from the asset URL so pdf.js can use Range requests for large files. */
function PdfDocumentPreview({ url }: { url: string }) {
  const locale = useStore((s) => s.locale);
  const [state, setState] = useState<PdfState>({ status: 'loading' });

  useEffect(() => {
    let disposed = false;
    let loadingTask: PDFDocumentLoadingTask | undefined;
    void (async () => {
      const pdfjs = await loadPdfJs();
      if (disposed) return;
      loadingTask = pdfjs.getDocument({ url, ...PDF_DOCUMENT_OPTIONS }); // Moon Modified
      const doc = await loadingTask.promise;
      if (disposed) return;
      const firstPage = await doc.getPage(1);
      if (!disposed) setState({ status: 'ready', doc, firstPageSize: pageSize(firstPage) });
    })().catch((error: unknown) => {
      if (!disposed) setState({ status: 'error', message: pdfError(error) });
    });
    return () => {
      disposed = true;
      void loadingTask?.destroy();
    };
  }, [url]);

  if (state.status === 'loading') {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-fg-dim">
        <Loader2 size={16} className="animate-spin text-accent" />
        {t(locale, 'doc.rendering')}
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <div className="max-w-md rounded-md border border-status-error/40 bg-status-error/10 p-4 text-sm leading-relaxed text-fg-dim">
          <div className="mb-2 flex items-center gap-2 font-medium text-status-error">
            <FileWarning size={16} />
            {t(locale, 'doc.cannotRender')}
          </div>
          {state.message}
        </div>
      </div>
    );
  }
  return <PdfScrollView doc={state.doc} firstPageSize={state.firstPageSize} url={url} locale={locale} />;
}

export default function PdfPreview({ url }: { url: string }) {
  return <PdfDocumentPreview key={url} url={url} />;
}
