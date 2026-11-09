import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, FileWarning, Loader2 } from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useStore } from '@/store/useStore';
import { t, tArgs } from '@/lib/i18n';
import { PDF_DOCUMENT_OPTIONS } from '@/lib/pdfAssets'; // Moon Add
import ImagePreviewPane from './ImagePreviewPane';
import PreviewZoomControls from './PreviewZoomControls';
import { usePreviewZoom, zoomFromWheel } from './lib/previewZoom';
import { pdfImageRegions } from './lib/pdfImageRegions';

type PdfState =
  | { status: 'loading' }
  | { status: 'ready'; doc: PDFDocumentProxy }
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

/**
 * Paged PDF reader. The document is loaded straight from its asset-protocol
 * URL, so pdf.js issues Range requests and only the pages the reader actually
 * visits are fetched and rasterised — a 500-page manual never travels through
 * the IPC bridge as one base64 string.
 */
export default function PdfPreview({ url }: { url: string }) {
  const locale = useStore((s) => s.locale);
  const [state, setState] = useState<PdfState>({ status: 'loading' });
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { zoom, setZoom } = usePreviewZoom(url);
  const [containerWidth, setContainerWidth] = useState(900);
  const [imageRegions, setImageRegions] = useState<Array<{ x: number; y: number; width: number; height: number }>>([]);
  const [imagePreview, setImagePreview] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || state.status !== 'ready') return;
    const update = () => setContainerWidth(container.clientWidth || 900);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, [state.status]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || state.status !== 'ready') return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      setZoom(zoomFromWheel(zoom, event.deltaY, event.deltaMode, container.clientHeight));
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, [state.status, zoom, setZoom]);

  useEffect(() => {
    if (!imagePreview) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); setImagePreview(null); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [imagePreview]);

  useEffect(() => { setImagePreview(null); setImageRegions([]); }, [url, pageNumber]);

  useEffect(() => {
    let disposed = false;
    let loadingTask: { destroy: () => Promise<void> } | null = null;
    setState({ status: 'loading' });
    void loadPdfJs()
      .then((pdfjs) => {
        const task = pdfjs.getDocument({ url, ...PDF_DOCUMENT_OPTIONS }); // Moon Modified
        loadingTask = task;
        return task.promise;
      })
      .then((doc) => {
        if (disposed) return;
        setPageCount(doc.numPages);
        setPageNumber(1);
        setState({ status: 'ready', doc });
      })
      .catch((err: unknown) => {
        if (!disposed) {
          setState({
            status: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      disposed = true;
      void loadingTask?.destroy();
    };
  }, [url]);

  useEffect(() => {
    if (state.status !== 'ready') return;
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;
    void (async () => {
      const page = await state.doc.getPage(pageNumber);
      if (cancelled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const available = Math.max(1, containerWidth - 32);
      const unscaled = page.getViewport({ scale: 1 });
      const scale = Math.min(available / unscaled.width, 3) * zoom;
      const viewport = page.getViewport({ scale });
      // Keep very large pages within a reasonable canvas memory budget.
      const ratio = Math.min(window.devicePixelRatio || 1, Math.sqrt(16_000_000 / (viewport.width * viewport.height)));
      const rendered = document.createElement('canvas');
      rendered.width = Math.max(1, Math.floor(viewport.width * ratio));
      rendered.height = Math.max(1, Math.floor(viewport.height * ratio));
      const renderTask = page.render({
        canvas: rendered,
        viewport,
        recordImages: true,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });
      task = renderTask;
      await renderTask.promise;
      if (cancelled) return;
      canvas.width = rendered.width;
      canvas.height = rendered.height;
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      canvas.getContext('2d')?.drawImage(rendered, 0, 0);
      setImageRegions(pdfImageRegions(page.imageCoordinates));
    })().catch((err: unknown) => {
      const name = (err as { name?: string } | null)?.name;
      if (!cancelled && name !== 'RenderingCancelledException') {
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [state, pageNumber, containerWidth, zoom]);

  const goToPage = useCallback(
    (delta: number) => {
      setPageNumber((current) =>
        Math.min(Math.max(1, current + delta), Math.max(1, pageCount)),
      );
    },
    [pageCount],
  );

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

  const navButton =
    'flex h-6 w-6 items-center justify-center rounded border border-border text-fg-dim transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-40';

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-center gap-3 border-b border-border-soft px-3 py-1.5 text-xs text-fg-dim">
        <PreviewZoomControls zoom={zoom} onZoom={setZoom} />
        <button
          type="button"
          className={navButton}
          onClick={() => goToPage(-1)}
          disabled={pageNumber <= 1}
          title={t(locale, 'doc.prevPage')}
        >
          <ChevronLeft size={13} />
        </button>
        <span className="font-mono tabular-nums">
          {tArgs(locale, 'doc.pageOf', { current: pageNumber, total: pageCount })}
        </span>
        <button
          type="button"
          className={navButton}
          onClick={() => goToPage(1)}
          disabled={pageNumber >= pageCount}
          title={t(locale, 'doc.nextPage')}
        >
          <ChevronRight size={13} />
        </button>
      </div>
      <div
        ref={containerRef}
        className="min-h-0 flex-1 overflow-auto bg-neutral-800 p-4"
      >
        <div className="flex min-w-full w-max justify-center">
          <div className="relative h-fit w-fit shadow-lg">
            <canvas ref={canvasRef} className="block h-fit" />
            {imageRegions.map((region, index) => <button key={index} type="button" aria-label="查看 PDF 图片" title="点击放大图片"
              className="absolute cursor-zoom-in border-0 bg-transparent p-0 hover:outline hover:outline-2 hover:outline-accent"
              style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }}
              onClick={() => {
                const canvas = canvasRef.current;
                if (!canvas) return;
                const crop = document.createElement('canvas');
                crop.width = Math.max(1, Math.round(region.width * canvas.width));
                crop.height = Math.max(1, Math.round(region.height * canvas.height));
                crop.getContext('2d')?.drawImage(canvas, region.x * canvas.width, region.y * canvas.height, region.width * canvas.width, region.height * canvas.height, 0, 0, crop.width, crop.height);
                setImagePreview(crop.toDataURL('image/png'));
              }} />)}
          </div>
        </div>
      </div>
      {imagePreview && <div role="dialog" aria-label="PDF 图片查看" className="absolute inset-0 z-10 flex flex-col bg-bg">
        <div className="flex justify-end border-b border-border-soft px-3 py-1.5" onClick={(event) => { if (event.target === event.currentTarget) setImagePreview(null); }}><button type="button" onClick={() => setImagePreview(null)} className="rounded px-2 py-1 text-xs text-fg-dim hover:bg-panel-2">关闭</button></div>
        <ImagePreviewPane src={imagePreview} alt="PDF 图片" onDismiss={() => setImagePreview(null)} />
      </div>}
    </div>
  );
}
