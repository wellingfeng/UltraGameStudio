import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, FileWarning, Loader2 } from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { previewOfficeDocument, renderPresentationPreview, type OfficePreview } from '@/lib/tauri';
import { useStore } from '@/store/useStore';
import { t, tArgs } from '@/lib/i18n';
import { usePreviewTheme } from './lib/previewTheme';
import PdfPreview from './PdfPreview';
import PreviewZoomControls from './PreviewZoomControls';
import { usePreviewZoom, withPreviewInteractions } from './lib/previewZoom';

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const PPT_MIME = 'application/vnd.ms-powerpoint';
// Office previews previously disabled scripts entirely. Only the injected
// interaction script is allowed; document-provided scripts remain blocked.
const OFFICE_PREVIEW_NONCE = Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('');

/** Rendered inside the sandboxed preview iframe; keeps the extracted OOXML
 *  readable without pulling a stylesheet into the app bundle. */
const OFFICE_STYLE = [
  'html,body{background:var(--bg);color:var(--fg);}',
  'body{margin:0;padding:16px;box-sizing:border-box;font-family:var(--ugs-font-family);line-height:1.6;overflow-wrap:anywhere;}',
  'h2{font-size:15px;font-weight:600;margin:0 0 12px;padding-bottom:8px;border-bottom:1px solid var(--border-soft);}',
  '.preview-slide + .preview-slide{margin-top:24px;padding-top:16px;border-top:1px solid var(--border-soft);}',
  'p{margin:0 0 8px;white-space:pre-wrap;}',
  'table{border-collapse:collapse;font-size:12px;max-width:100%;}',
  'td,th{border:1px solid var(--border);padding:4px 8px;vertical-align:top;}',
  'th{background:var(--panel-2);}',
  'th.preview-row-number{color:var(--fg-faint);text-align:right;font-weight:400;width:44px;}',
  '.preview-empty{color:var(--fg-faint);font-size:12px;}',
  'a{color:var(--accent);}',
  'blockquote{margin-left:0;padding-left:12px;border-left:3px solid var(--border);}',
  'img{max-width:100%;height:auto;}',
  'pre{overflow:auto;padding:12px;background:var(--panel-2);}',
  'hr{border:0;border-top:1px solid var(--border-soft);}',
].join('');

type OfficeState =
  | { status: 'loading' }
  | { status: 'docx'; html: string }
  | { status: 'presentation'; pdfPath: string }
  | { status: 'paged'; preview: OfficePreview; layoutError?: string }
  | { status: 'error'; message: string };

function wrapOfficeHtml(body: string, theme: string): string {
  return withPreviewInteractions(`<!doctype html><html><head><meta charset="utf-8"><style>${theme}${OFFICE_STYLE}</style></head><body>${body}</body></html>`, OFFICE_PREVIEW_NONCE);
}

/**
 * Word/PowerPoint/Excel preview.
 *
 * Presentations use a rendered PDF when available. The OOXML reader supplies
 * sheet previews and a limited PPTX preview if the layout renderer fails.
 */
export default function OfficePreviewPane({
  path,
  streamPath,
  mime,
  fileName,
}: {
  path: string;
  streamPath?: string | null;
  mime: string;
  fileName: string;
}) {
  const locale = useStore((s) => s.locale);
  const theme = usePreviewTheme();
  const [state, setState] = useState<OfficeState>({ status: 'loading' });
  const [pageNumber, setPageNumber] = useState(1);
  const { zoom, setZoom, frameRef, onFrameLoad } = usePreviewZoom(path);

  useEffect(() => {
    let disposed = false;
    setState({ status: 'loading' });
    setPageNumber(1);

    if (mime === DOCX_MIME) {
      const source = streamPath ? convertFileSrc(streamPath) : null;
      if (!source) {
        setState({ status: 'error', message: t(locale, 'doc.decodeFailed') });
        return;
      }
      void fetch(source)
        .then((response) => {
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          return response.arrayBuffer();
        })
        .then((buffer) => import('mammoth/mammoth.browser').then((mammoth) =>
          mammoth.convertToHtml({ arrayBuffer: buffer }),
        ))
        .then((result) => {
          if (!disposed) setState({ status: 'docx', html: result.value });
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
      };
    }

    const source = streamPath || path;
    const readPreview = async (): Promise<OfficeState> => {
      if (mime === PPT_MIME || mime === PPTX_MIME) {
        try {
          return { status: 'presentation', pdfPath: await renderPresentationPreview(source) };
        } catch (err) {
          if (mime === PPT_MIME || disposed) throw err;
          return {
            status: 'paged',
            preview: await previewOfficeDocument(source),
            layoutError: err instanceof Error ? err.message : String(err),
          };
        }
      }
      return { status: 'paged', preview: await previewOfficeDocument(source) };
    };

    void readPreview()
      .then((previewState) => {
        if (!disposed) setState(previewState);
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
    };
  }, [locale, mime, path, streamPath]);

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

  if (state.status === 'docx') {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-bg">
        <div className="flex shrink-0 justify-end border-b border-border-soft bg-panel px-3 py-1.5"><PreviewZoomControls zoom={zoom} onZoom={setZoom} /></div>
        <iframe
          ref={frameRef}
          onLoad={onFrameLoad}
          title={fileName}
          sandbox="allow-scripts"
          srcDoc={wrapOfficeHtml(state.html, theme)}
          className="min-h-0 flex-1 border-0 bg-bg"
        />
      </div>
    );
  }

  if (state.status === 'presentation') {
    return <PdfPreview url={convertFileSrc(state.pdfPath)} />;
  }

  const { preview, layoutError } = state;
  const isSlides = preview.kind === 'pptx';
  const total = Math.max(1, preview.pages.length);
  const current = preview.pages[Math.min(pageNumber, total) - 1];
  const html = isSlides
    ? preview.pages.map((page) => `<section class="preview-slide">${page.html}</section>`).join('')
    : current?.html ?? '';
  const navButton =
    'flex h-6 w-6 items-center justify-center rounded border border-border text-fg-dim transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-40';

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg">
      {layoutError !== undefined && (
        <div role="status" title={layoutError} className="shrink-0 border-b border-border-soft px-3 py-1.5 text-xs text-fg-dim">
          {t(locale, 'doc.presentationLayoutFallback')}
        </div>
      )}
      <div className="flex shrink-0 items-center justify-center gap-3 border-b border-border-soft bg-panel px-3 py-1.5 text-xs text-fg-dim">
        <PreviewZoomControls zoom={zoom} onZoom={setZoom} />
        {!isSlides && (
          <>
            <button
              type="button"
              className={navButton}
              onClick={() => setPageNumber((value) => Math.max(1, value - 1))}
              disabled={pageNumber <= 1}
              title={t(locale, 'doc.prevPage')}
            >
              <ChevronLeft size={13} />
            </button>
            <span className="font-mono tabular-nums">
              {tArgs(locale, 'doc.pageOf', { current: pageNumber, total })}
            </span>
            <button
              type="button"
              className={navButton}
              onClick={() => setPageNumber((value) => Math.min(total, value + 1))}
              disabled={pageNumber >= total}
              title={t(locale, 'doc.nextPage')}
            >
              <ChevronRight size={13} />
            </button>
          </>
        )}
        {preview.truncated && (
          <span className="text-fg-faint">
            {tArgs(locale, 'doc.truncatedPages', {
              shown: preview.pages.length,
              total: preview.pageCount,
            })}
          </span>
        )}
      </div>
      <iframe
        ref={frameRef}
        onLoad={onFrameLoad}
        title={isSlides ? fileName : `${fileName} · ${current?.index ?? 1}`}
        sandbox="allow-scripts"
        srcDoc={wrapOfficeHtml(html, theme)}
        className="min-h-0 flex-1 border-0 bg-bg"
      />
    </div>
  );
}
