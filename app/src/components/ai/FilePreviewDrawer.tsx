import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Code2,
  ExternalLink,
  FileText,
  FileWarning,
  FolderOpen,
  Globe2,
  Image as ImageIcon,
  Loader2,
  Maximize2,
  MessageSquarePlus,
  Minimize2,
  Video,
  X,
} from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { requestTemporaryChat } from '@/components/temporaryChat/TemporaryChatWindows';
import { fileSource, registerVisibleSource } from '@/components/temporaryChat/context';
import {
  openLocalPath,
  previewLocalFile,
  type LocalFilePreview,
  type WorkspaceChangeFile,
  type WorkspaceChangeLine,
  type WorkspaceChangeLineKind,
} from '@/lib/tauri';
import { useStore } from '@/store/useStore';
import { filePreviewScope, useFilePreviewTabs } from '@/store/filePreviewTabs';
import { cn } from '@/lib/cn';
import { createObjectUrlFromBase64, revokeObjectUrl } from '@/lib/objectUrl';
import { readWorkspaceFileDiffOnDemand } from '@/lib/scanHost';
import { useResizableWidth } from '@/lib/useResizableWidth';
import {
  displayFileRefPath,
  parentDirectoryPath,
  type FileRef,
} from './lib/filePath';
import { highlightCode } from './lib/highlight';
import Markdown from './Markdown';
import OfficePreviewPane from './OfficePreviewPane';
import HtmlPreviewPane from './HtmlPreviewPane';
import PdfPreview from './PdfPreview';
import CopyButton from './CopyButton';
import { directImagePreviewSource } from './lib/imagePreview';
import ImagePreviewPane from './ImagePreviewPane';
import PreviewZoomControls from './PreviewZoomControls';
import { useCtrlWheelZoom, usePreviewZoom } from './lib/previewZoom';

type PreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; file: LocalFilePreview }
  | { status: 'error'; message: string };

type DiffState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; diff: WorkspaceChangeFile | null }
  | { status: 'error'; message: string };

const HTML_PREVIEW_EXT = new Set(['html', 'htm', 'xhtml', 'xht', 'shtml', 'hta']);
const MARKDOWN_PREVIEW_EXT = new Set([
  'md',
  'mdx',
  'markdown',
  'mkd',
  'mkdn',
  'mdown',
  'mdwn',
  'mdtxt',
  'mdtext',
  'rmd',
  'qmd',
]);

type TextPreviewMode = 'code' | 'html' | 'markdown';
type FilePreviewDrawerVariant = 'overlay' | 'embedded' | 'main';

export interface FilePreviewCustomContent {
  label: string;
  path?: string;
  meta?: string;
  children: ReactNode;
}

export const FILE_PREVIEW_DRAWER_LAYOUT_EVENT =
  'ugs:file-preview-drawer-layout';

export interface FilePreviewDrawerLayoutDetail {
  id: string;
  open: boolean;
  width: number;
  expanded: boolean;
}

const FILE_PREVIEW_DEFAULT_WIDTH = 760;
const FILE_PREVIEW_MIN_WIDTH = 360;
const FILE_PREVIEW_MAX_WIDTH = 1280;
// Keep preview entries in place until their click switches the file; closing
// on pointerdown would reflow the chat before pointerup reaches the entry.
const FILE_PREVIEW_OUTSIDE_POINTER_IGNORE_SELECTOR =
  '[data-file-preview-ignore-outside-pointer="true"], ' +
  '[data-file-preview-trigger="true"]:not(:disabled)';

function publishFilePreviewDrawerLayout(
  detail: FilePreviewDrawerLayoutDetail,
): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<FilePreviewDrawerLayoutDetail>(
      FILE_PREVIEW_DRAWER_LAYOUT_EVENT,
      { detail },
    ),
  );
}

function filePreviewMaxWidth(): number {
  if (typeof window === 'undefined') return FILE_PREVIEW_MAX_WIDTH;
  return Math.max(
    FILE_PREVIEW_MIN_WIDTH,
    Math.min(FILE_PREVIEW_MAX_WIDTH, window.innerWidth - 48),
  );
}

function filePreviewDefaultWidth(): number {
  return Math.min(FILE_PREVIEW_DEFAULT_WIDTH, filePreviewMaxWidth());
}

function shouldIgnoreOutsidePointer(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(FILE_PREVIEW_OUTSIDE_POINTER_IGNORE_SELECTOR) !== null
  );
}

function extensionFromPath(path: string): string {
  const clean = path.split(/[?#]/, 1)[0] ?? path;
  const base = clean.replace(/[\\/]+$/, '');
  const dot = base.lastIndexOf('.');
  if (dot === -1 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

function languageFromPath(path: string): string {
  const ext = extensionFromPath(path);
  if (ext === 'ts' || ext === 'tsx' || ext === 'mts' || ext === 'cts') return 'typescript';
  if (ext === 'js' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs') return 'javascript';
  if (ext === 'json' || ext === 'jsonc' || ext === 'json5') return 'json';
  if (ext === 'css' || ext === 'scss' || ext === 'sass' || ext === 'less') return 'css';
  if (ext === 'html' || ext === 'htm' || ext === 'xml' || ext === 'svg' || ext === 'vue') {
    return 'xml';
  }
  if (MARKDOWN_PREVIEW_EXT.has(ext)) return 'markdown';
  if (ext === 'yml' || ext === 'yaml') return 'yaml';
  if (ext === 'py' || ext === 'pyw' || ext === 'pyi') return 'python';
  if (ext === 'rs') return 'rust';
  if (ext === 'sh' || ext === 'bash' || ext === 'zsh') return 'bash';
  if (ext === 'ps1' || ext === 'psm1' || ext === 'psd1') return 'powershell';
  if (ext === 'bat' || ext === 'cmd') return 'dos';
  if (ext === 'c' || ext === 'h') return 'c';
  if (ext === 'cc' || ext === 'cpp' || ext === 'cxx' || ext === 'hpp' || ext === 'hh') {
    return 'cpp';
  }
  if (ext === 'cs') return 'csharp';
  if (ext === 'glsl' || ext === 'vert' || ext === 'frag') return 'glsl';
  if (ext === 'hlsl' || ext === 'fx' || ext === 'fxh' || ext === 'usf' || ext === 'ush') {
    return 'hlsl';
  }
  if (ext === 'diff' || ext === 'patch' || ext === 'rej') return 'diff';
  return 'plaintext';
}

function textPreviewModeFromPath(path: string, mime?: string | null): TextPreviewMode {
  const normalizedMime = (mime ?? '').toLowerCase();
  const ext = extensionFromPath(path);
  if (normalizedMime.includes('html') || HTML_PREVIEW_EXT.has(ext)) return 'html';
  if (normalizedMime.includes('markdown') || MARKDOWN_PREVIEW_EXT.has(ext)) {
    return 'markdown';
  }
  return 'code';
}

export { rewriteLocalAssetsInHtml } from './lib/localHtmlAssets';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message === 'NO_BACKEND') {
    return '当前浏览器模式不能读取本机文件。请使用桌面端预览。';
  }
  return err instanceof Error ? err.message : String(err);
}

function useBase64ObjectUrl(
  base64: string | null | undefined,
  mime: string | null | undefined,
): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    setUrl(null);
    if (!base64 || !mime) return;

    let disposed = false;
    let createdUrl: string | null = null;
    let timer: number | null = null;

    const createUrl = async () => {
      try {
        const nextUrl = await createObjectUrlFromBase64(base64, mime);
        if (disposed) {
          revokeObjectUrl(nextUrl);
          return;
        }
        createdUrl = nextUrl;
        setUrl(createdUrl);
      } catch {
        if (!disposed) setUrl(`data:${mime};base64,${base64}`);
      }
    };

    timer = window.setTimeout(() => {
      void createUrl();
    }, 0);

    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      revokeObjectUrl(createdUrl);
    };
  }, [base64, mime]);

  return url;
}

type DiffLineTone = 'added' | 'deleted' | 'replacedAdded' | 'replacedDeleted';

interface DiffPreviewRow {
  key: string;
  text: string;
  newLine: number | null;
  oldLine: number | null;
  anchorLine: number;
  tone: DiffLineTone | null;
  marker: string;
  virtual: boolean;
}

function splitPreviewLines(text: string): string[] {
  if (text.length === 0) return [''];
  const lines = text.split(/\r\n|\r|\n/);
  if (/[ \t]*\r?\n$/.test(text) && lines.length > 1) lines.pop();
  return lines.length > 0 ? lines : [''];
}

function isAddedDiffKind(kind: WorkspaceChangeLineKind): boolean {
  return kind === 'added' || kind === 'replacedAdded';
}

function isDeletedDiffKind(kind: WorkspaceChangeLineKind): boolean {
  return kind === 'deleted' || kind === 'replacedDeleted';
}

function clampLine(line: number, totalLines: number): number {
  return Math.max(1, Math.min(Math.max(1, totalLines + 1), line));
}

function deletedAnchorLine(
  diffLines: WorkspaceChangeLine[],
  index: number,
  totalLines: number,
): number {
  for (let next = index + 1; next < diffLines.length; next += 1) {
    const newLine = diffLines[next]?.newLine;
    if (typeof newLine === 'number' && newLine > 0) {
      return clampLine(newLine, totalLines);
    }
  }
  for (let previous = index - 1; previous >= 0; previous -= 1) {
    const newLine = diffLines[previous]?.newLine;
    if (typeof newLine === 'number' && newLine > 0) {
      return clampLine(newLine + 1, totalLines);
    }
  }
  const oldLine = diffLines[index]?.oldLine;
  return clampLine(typeof oldLine === 'number' && oldLine > 0 ? oldLine : 1, totalLines);
}

function buildDiffPreviewRows(text: string, diff: WorkspaceChangeFile | null): DiffPreviewRow[] {
  const lines = splitPreviewLines(text);
  const totalLines = lines.length;
  const currentLineKinds = new Map<number, DiffLineTone>();
  const deletedBefore = new Map<number, WorkspaceChangeLine[]>();

  for (let index = 0; index < (diff?.lines.length ?? 0); index += 1) {
    const line = diff?.lines[index];
    if (!line) continue;
    if (isAddedDiffKind(line.kind) && typeof line.newLine === 'number') {
      currentLineKinds.set(line.newLine, line.kind);
    } else if (isDeletedDiffKind(line.kind)) {
      const anchor = deletedAnchorLine(diff?.lines ?? [], index, totalLines);
      const bucket = deletedBefore.get(anchor) ?? [];
      bucket.push(line);
      deletedBefore.set(anchor, bucket);
    }
  }

  const rows: DiffPreviewRow[] = [];
  for (let lineNo = 1; lineNo <= totalLines + 1; lineNo += 1) {
    const deleted = deletedBefore.get(lineNo) ?? [];
    for (let index = 0; index < deleted.length; index += 1) {
      const line = deleted[index];
      rows.push({
        key: `deleted:${line.oldLine ?? lineNo}:${index}:${line.content}`,
        text: line.content,
        newLine: null,
        oldLine: line.oldLine ?? null,
        anchorLine: lineNo,
        tone: line.kind,
        marker: '-',
        virtual: true,
      });
    }

    if (lineNo > totalLines) continue;
    const tone = currentLineKinds.get(lineNo) ?? null;
    rows.push({
      key: `line:${lineNo}`,
      text: lines[lineNo - 1] ?? '',
      newLine: lineNo,
      oldLine: null,
      anchorLine: lineNo,
      tone,
      marker: tone ? '+' : '',
      virtual: false,
    });
  }

  return rows;
}

function minimapTop(line: number, totalLines: number): string {
  if (totalLines <= 1) return '0%';
  const top = ((Math.max(1, Math.min(totalLines, line)) - 1) / (totalLines - 1)) * 100;
  return `${top.toFixed(3)}%`;
}

function DiffCodePreview({
  text,
  diff,
  language,
  zoom,
  onZoom,
}: {
  text: string;
  diff: WorkspaceChangeFile | null;
  language: string;
  zoom: number;
  onZoom: (value: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useCtrlWheelZoom(scrollRef, zoom, onZoom);
  const rows = useMemo(() => buildDiffPreviewRows(text, diff), [diff, text]);
  const highlightedRows = useMemo(
    () =>
      rows.map((row) => {
        const highlighted = highlightCode(row.text, language);
        return { ...row, html: highlighted.html || ' ', highlightClass: highlighted.className };
      }),
    [language, rows],
  );
  const totalLines = splitPreviewLines(text).length;
  const lineNumberWidth = Math.max(3, String(totalLines).length + 1);
  const markers = highlightedRows.filter((row) => row.tone);

  const scrollToLine = (line: number) => {
    const root = scrollRef.current;
    if (!root) return;
    const target = root.querySelector<HTMLElement>(
      `[data-vcs-line="${line}"], [data-vcs-anchor="${line}"]`,
    );
    target?.scrollIntoView({ block: 'center', inline: 'nearest' });
  };

  return (
    <div className="ai-file-preview-diff">
      <div ref={scrollRef} className="ai-file-preview-diff__scroll" tabIndex={0}>
        <div
          className="ai-file-preview-diff__code"
          style={{ '--line-number-width': `${lineNumberWidth}ch`, zoom } as CSSProperties}
        >
          {highlightedRows.map((row) => (
            <div
              key={row.key}
              data-vcs-line={row.newLine ?? undefined}
              data-vcs-anchor={row.anchorLine}
              data-vcs-kind={row.tone ?? undefined}
              className={
                'ai-file-preview-diff__line ' +
                (row.tone ? `ai-file-preview-diff__line--${row.tone}` : '') +
                (row.virtual ? ' ai-file-preview-diff__line--virtual' : '')
              }
            >
              <span className="ai-file-preview-diff__line-no">
                {row.virtual ? row.oldLine ?? '' : row.newLine}
              </span>
              <span className="ai-file-preview-diff__marker">{row.marker}</span>
              <code
                className={`ai-file-preview-diff__text ${row.highlightClass}`}
                dangerouslySetInnerHTML={{ __html: row.html }}
              />
            </div>
          ))}
        </div>
      </div>
      {markers.length > 0 && (
        <div className="ai-file-preview-diff__minimap" aria-label="差异缩略条">
          {markers.map((row, index) => (
            <button
              key={`${row.key}:marker:${index}`}
              type="button"
              className={
                'ai-file-preview-diff__minimap-mark ' +
                (row.tone ? `ai-file-preview-diff__minimap-mark--${row.tone}` : '')
              }
              style={{ top: minimapTop(row.anchorLine, totalLines) }}
              title={`跳转到第 ${row.anchorLine} 行`}
              aria-label={`跳转到第 ${row.anchorLine} 行`}
              onClick={() => scrollToLine(row.anchorLine)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function MarkdownFilePreview({ file, cwd, previewFile }: { file: LocalFilePreview; cwd?: string; previewFile: typeof previewLocalFile }) {
  const { zoom, setZoom } = usePreviewZoom(file.path);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [image, setImage] = useState<{ src: string; alt: string } | null>(null);
  useCtrlWheelZoom(scrollRef, zoom, setZoom);
  useEffect(() => { setImage(null); }, [file.path]);
  useEffect(() => {
    if (!image) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopImmediatePropagation(); setImage(null); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [image]);
  return <div className="relative flex min-h-0 flex-1 flex-col bg-bg">
    <div className="flex shrink-0 items-center gap-2 border-b border-border-soft px-3 py-1.5 font-mono text-[10px] text-fg-faint">
      <FileText size={12} />{file.mime ?? 'text/markdown'} · {formatBytes(file.sizeBytes)}
      <div className="ml-auto"><PreviewZoomControls zoom={zoom} onZoom={setZoom} /></div>
    </div>
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto p-4">
      <div style={{ zoom }} onClickCapture={(event) => {
        const target = event.target;
        if (!(target instanceof HTMLImageElement) || !(target.currentSrc || target.src)) return;
        event.preventDefault(); event.stopPropagation();
        setImage({ src: target.currentSrc || target.src, alt: target.alt || '图片预览' });
      }}>
        <Markdown text={file.text ?? ''} cwd={file.path ? parentDirectoryPath(file.path) : cwd}
          onOpenFile={(ref) => { void previewFile(ref.path, { cwd: file.path ? parentDirectoryPath(file.path) : cwd }); }} />
      </div>
    </div>
    {image && <div role="dialog" aria-label="图片查看" className="absolute inset-0 z-10 flex flex-col bg-bg">
      <div className="flex justify-end border-b border-border-soft px-3 py-1.5"><button type="button" onClick={() => setImage(null)} className="rounded px-2 py-1 text-xs text-fg-dim hover:bg-panel-2">关闭</button></div>
      <ImagePreviewPane src={image.src} alt={image.alt} />
    </div>}
  </div>;
}

export default function FilePreviewDrawer({
  refData,
  customContent = null,
  cwd,
  previewFile = previewLocalFile,
  diffEnabled = false,
  canOpenExternally = true,
  variant = 'overlay',
  overlayContainerRef,
  active = true,
  onClose,
}: {
  refData: FileRef | null;
  customContent?: FilePreviewCustomContent | null;
  cwd?: string;
  previewFile?: typeof previewLocalFile;
  diffEnabled?: boolean;
  canOpenExternally?: boolean;
  variant?: FilePreviewDrawerVariant;
  overlayContainerRef?: RefObject<HTMLElement>;
  active?: boolean;
  onClose: () => void;
}) {
  const drawerId = useId();
  const embedded = variant !== 'overlay';
  const main = variant === 'main';
  const workspace = useStore((state) => state.composer.workspace);
  const openMainPreview = useFilePreviewTabs((state) => state.open);
  const [state, setState] = useState<PreviewState>({ status: 'idle' });
  const [diffState, setDiffState] = useState<DiffState>({ status: 'idle' });
  const [isExpanded, setIsExpanded] = useState(false);
  const asideRef = useRef<HTMLElement | null>(null);
  const embeddedPanelRef = useRef<HTMLDivElement | null>(null);
  const { width, onResizeStart } = useResizableWidth({
    storageKey: 'ultragamestudio.filePreviewWidth.v1',
    defaultWidth: filePreviewDefaultWidth(),
    min: FILE_PREVIEW_MIN_WIDTH,
    max: filePreviewMaxWidth(),
    edge: 'left',
  });
  const open = Boolean(refData || customContent);
  const directImageSource = directImagePreviewSource(refData);

  useEffect(() => {
    if (!refData || customContent || directImageSource || !active) return;
    return registerVisibleSource(fileSource(refData, cwd));
  }, [refData, cwd, customContent, directImageSource, active]);

  useEffect(() => {
    if (embedded || overlayContainerRef) return;
    publishFilePreviewDrawerLayout({
      id: drawerId,
      open,
      width: open
        ? Math.round(isExpanded ? window.innerWidth : width)
        : 0,
      expanded: open && isExpanded,
    });
  }, [drawerId, embedded, isExpanded, open, overlayContainerRef, width]);

  useEffect(
    () => () => {
      if (embedded || overlayContainerRef) return;
      publishFilePreviewDrawerLayout({
        id: drawerId,
        open: false,
        width: 0,
        expanded: false,
      });
    },
    [drawerId, embedded, overlayContainerRef],
  );

  useEffect(() => {
    if (embedded && isExpanded) setIsExpanded(false);
  }, [embedded, isExpanded]);

  useEffect(() => {
    if (!refData || customContent || directImageSource) {
      setState({ status: 'idle' });
      setIsExpanded(false);
      return;
    }

    let disposed = false;
    setState({ status: 'loading' });
    void previewFile(refData.path, { cwd })
      .then((file) => {
        if (!disposed) setState({ status: 'ready', file });
      })
      .catch((err) => {
        if (!disposed) setState({ status: 'error', message: errorMessage(err) });
      });
    return () => {
      disposed = true;
    };
  }, [customContent, cwd, directImageSource, previewFile, refData]);

  useEffect(() => {
    if (!refData || !cwd || customContent || directImageSource || !diffEnabled) {
      setDiffState({ status: 'idle' });
      return;
    }

    let disposed = false;
    setDiffState({ status: 'loading' });
    void readWorkspaceFileDiffOnDemand({ rootPath: cwd, path: refData.path })
      .then((diff) => {
        if (!disposed) setDiffState({ status: 'ready', diff });
      })
      .catch((err) => {
        if (!disposed) setDiffState({ status: 'error', message: errorMessage(err) });
      });
    return () => {
      disposed = true;
    };
  }, [customContent, cwd, diffEnabled, directImageSource, refData]);

  useEffect(() => {
    if (!open || !active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (!embedded && isExpanded) {
        setIsExpanded(false);
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, embedded, isExpanded, onClose, open]);

  useEffect(() => {
    if (!open || main) return;
    const onPointerDown = (event: PointerEvent) => {
      if (shouldIgnoreOutsidePointer(event.target)) return;
      const target = event.target as Node | null;
      if (!target) return;
      const panel = embedded ? embeddedPanelRef.current : asideRef.current;
      if (panel && panel.contains(target)) return;
      onClose();
    };
    // Defer registration so the click that opened the preview doesn't immediately close it.
    const timer = window.setTimeout(() => {
      document.addEventListener('pointerdown', onPointerDown, true);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [embedded, main, onClose, open]);

  const file = state.status === 'ready' ? state.file : null;
  const { zoom: textZoom, setZoom: setTextZoom } = usePreviewZoom(file?.path ?? '');
  const imageUrl = useBase64ObjectUrl(
    file?.kind === 'image' ? file.base64 : null,
    file?.kind === 'image' ? file.mime : null,
  );
  const label = customContent?.label ?? file?.fileName ?? refData?.basename ?? '文件预览';
  const path =
    customContent?.path ??
    file?.path ??
    directImageSource ??
    (refData ? displayFileRefPath(refData, cwd) : '');
  // System actions belong to the file reference, not the preview decoder.
  const externalPath = !customContent && !directImageSource && refData
    ? file?.path ?? displayFileRefPath(refData, cwd)
    : null;
  const lineSuffix = refData?.startLine
    ? `:${refData.startLine}${refData.endLine ? `-${refData.endLine}` : ''}`
    : '';
  const textPreviewMode =
    file?.kind === 'text' ? textPreviewModeFromPath(file.path, file.mime) : 'code';
  const vcsDiff = diffState.status === 'ready' ? diffState.diff : null;

  if (!open) return null;

  const panelContent = (
    <>
        {!embedded && !isExpanded && (
          <div
            onMouseDown={onResizeStart}
            title="拖动调整预览宽度"
            aria-label="拖动调整预览宽度"
            className="group absolute -left-1 bottom-0 top-0 z-20 flex w-2 cursor-col-resize items-center justify-center"
          >
            <div className="h-full w-0.5 bg-transparent transition-colors group-hover:bg-accent/50" />
          </div>
        )}
        <header className="flex min-h-0 shrink-0 items-start gap-2 border-b border-border-soft px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-medium text-fg" title={path}>
                {label}
                {lineSuffix && <span className="text-fg-faint">{lineSuffix}</span>}
              </span>
            </div>
            <div
              className="mt-0.5 truncate font-mono text-[10px] text-fg-faint"
              title={path || customContent?.meta}
            >
              {path || customContent?.meta}
            </div>
          </div>
          {refData && !customContent && !directImageSource && active && (
            <button type="button" title="针对当前文件随手聊" aria-label="针对当前文件随手聊"
              onClick={() => requestTemporaryChat(fileSource(refData, cwd))}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-panel-2 text-fg-dim transition-colors hover:border-accent hover:text-fg">
              <MessageSquarePlus size={14} />
            </button>
          )}
          {!main && !overlayContainerRef && refData && !customContent && (
            <button
              type="button"
              onClick={() => {
                openMainPreview({
                  scope: filePreviewScope(workspace),
                  ref: refData, cwd, previewFile, diffEnabled, canOpenExternally,
                });
                onClose();
              }}
              title="在主区域预览"
              aria-label="在主区域预览"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-panel-2 text-fg-dim transition-colors hover:border-accent hover:text-fg"
            >
              <Maximize2 size={14} />
            </button>
          )}
          {!embedded && (
            <button
              type="button"
              onClick={() => setIsExpanded((value) => !value)}
              title={isExpanded ? '还原预览宽度' : overlayContainerRef ? '占满区域' : '占满窗口'}
              aria-label={isExpanded ? '还原预览宽度' : overlayContainerRef ? '占满区域' : '占满窗口'}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-panel-2 text-fg-dim transition-colors hover:border-accent hover:text-fg"
            >
              {isExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          )}
          {externalPath && canOpenExternally && (
            <button
              type="button"
              onClick={() => {
                // Jump straight to the folder that holds this file. The header
                // path is otherwise only copyable text, so a deep asset or a
                // generated artifact buried under .ultragamestudio/ could not be
                // located on disk from inside the preview.
                void openLocalPath(externalPath, { reveal: true }).then((opened) => {
                  if (!opened && typeof window !== 'undefined') {
                    window.alert(`无法在文件管理器中定位该文件：\n${externalPath}`);
                  }
                });
              }}
              title="在文件夹中显示"
              aria-label="在文件夹中显示"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-panel-2 text-fg-dim transition-colors hover:border-accent hover:text-fg"
            >
              <FolderOpen size={14} />
            </button>
          )}
          {externalPath && canOpenExternally && (
            <button
              type="button"
              onClick={() => {
                void openLocalPath(externalPath).then((opened) => {
                  if (!opened && typeof window !== 'undefined') {
                    window.alert(`无法用系统默认程序打开该文件：\n${externalPath}`);
                  }
                });
              }}
              title="用系统默认程序打开"
              aria-label="用系统默认程序打开"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-panel-2 text-fg-dim transition-colors hover:border-accent hover:text-fg"
            >
              <ExternalLink size={14} />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            title="关闭"
            aria-label="关闭"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-border-soft hover:text-fg"
          >
            <X size={15} />
          </button>
        </header>

        {customContent && (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-bg">
            {customContent.meta && (
              <div className="flex shrink-0 items-center gap-2 border-b border-border-soft px-3 py-1.5 font-mono text-[10px] text-fg-faint">
                <FileText size={12} />
                {customContent.meta}
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-hidden">{customContent.children}</div>
          </div>
        )}

        {!customContent && state.status === 'loading' && (
          <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-fg-dim">
            <Loader2 size={16} className="animate-spin text-accent" />
            读取中
          </div>
        )}

        {!customContent && directImageSource && (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b border-border-soft px-3 py-1.5 font-mono text-[10px] text-fg-faint">
              <ImageIcon size={12} />
              {directImageSource.startsWith('data:') ? '嵌入图片' : '远程图片'}
            </div>
            <ImagePreviewPane src={directImageSource} alt={refData?.basename ?? '图片预览'} />
          </div>
        )}

        {!customContent && state.status === 'error' && (
          <div className="flex min-h-0 flex-1 items-center justify-center p-6">
            <div className="max-w-md rounded-md border border-status-error/40 bg-status-error/10 p-4 text-sm leading-relaxed text-fg-dim">
              <div className="mb-2 flex items-center gap-2 font-medium text-status-error">
                <FileWarning size={16} />
                无法预览
              </div>
              <div className="mb-3">{state.message}</div>
              {refData && (
                <CopyButton
                  value={displayFileRefPath(refData, cwd)}
                  title="复制路径"
                  label="复制路径"
                  className="text-xs"
                />
              )}
            </div>
          </div>
        )}

        {!customContent && file?.truncated && (
          <div className="shrink-0 border-b border-accent-3/30 bg-accent-3/10 px-3 py-1.5 text-xs text-accent-3">
            文件较大，已截断显示。原始大小 {formatBytes(file.sizeBytes)}。
          </div>
        )}

        {file?.kind === 'image' && file.mime && (file.streamPath || imageUrl) && (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b border-border-soft px-3 py-1.5 font-mono text-[10px] text-fg-faint">
              <ImageIcon size={12} />
              {file.mime} · {formatBytes(file.sizeBytes)}
            </div>
            <ImagePreviewPane
              src={file.streamPath ? convertFileSrc(file.streamPath) : (imageUrl ?? '')}
              alt={file.fileName}
            />
          </div>
        )}

        {file?.kind === 'video' && file.mime && (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b border-border-soft px-3 py-1.5 font-mono text-[10px] text-fg-faint">
              <Video size={12} />
              {file.mime} · {formatBytes(file.sizeBytes)}
            </div>
            <div className="flex min-h-0 flex-1 items-center justify-center bg-black p-4">
              <video
                src={convertFileSrc(file.streamPath ?? file.path)}
                controls
                preload="metadata"
                className="max-h-full max-w-full rounded border border-border bg-black"
              />
            </div>
          </div>
        )}

        {file?.kind === 'text' && textPreviewMode === 'html' && (
          <div className="flex min-h-0 flex-1 flex-col bg-bg">
            <div className="flex shrink-0 items-center gap-2 border-b border-border-soft bg-panel px-3 py-1.5 font-mono text-[10px] text-fg-faint">
              <Globe2 size={12} />
              {file.mime ?? 'text/html'} · {formatBytes(file.sizeBytes)}
            </div>
            <HtmlPreviewPane file={file} />
          </div>
        )}

        {file?.kind === 'text' && textPreviewMode === 'markdown' && (
          <MarkdownFilePreview file={file} cwd={cwd} previewFile={previewFile} />
        )}

        {file?.kind === 'text' && textPreviewMode === 'code' && (
          <div className="ai-file-preview-code min-h-0 flex-1 overflow-hidden bg-bg">
            <div className="flex shrink-0 items-center gap-2 border-b border-border-soft px-3 py-1.5 font-mono text-[10px] text-fg-faint">
              <Code2 size={12} />
              {file.mime ?? 'text/plain'} · {formatBytes(file.sizeBytes)}
              {diffEnabled && diffState.status === 'loading' && (
                <span className="flex items-center gap-1"><Loader2 size={10} className="animate-spin" />读取差异中</span>
              )}
              {diffEnabled && diffState.status === 'ready' && vcsDiff && (
                <span className="text-fg-dim">相对版本库 · +{vcsDiff.lines.filter((line) => isAddedDiffKind(line.kind)).length} / -{vcsDiff.lines.filter((line) => isDeletedDiffKind(line.kind)).length}</span>
              )}
              <div className="ml-auto"><PreviewZoomControls zoom={textZoom} onZoom={setTextZoom} /></div>
            </div>
            {diffEnabled && diffState.status === 'error' && (
              <div role="status" className="shrink-0 border-b border-status-error/30 bg-status-error/10 px-3 py-1.5 text-xs text-status-error">
                差异读取失败：{diffState.message}
              </div>
            )}
            <DiffCodePreview
              text={file.text ?? ''}
              diff={vcsDiff}
              language={languageFromPath(file.path)}
              zoom={textZoom}
              onZoom={setTextZoom}
            />
          </div>
        )}

        {file?.kind === 'document' && file.mime && (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b border-border-soft px-3 py-1.5 font-mono text-[10px] text-fg-faint">
              <FileText size={12} />
              {file.mime} · {formatBytes(file.sizeBytes)}
              {file.pageCount ? ` · ${file.pageCount} 页` : ''}
            </div>
            {file.streamPath ? (
              <PdfPreview url={convertFileSrc(file.streamPath)} />
            ) : (
              <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm text-fg-dim">
                无法获取 PDF 的流式路径。
              </div>
            )}
          </div>
        )}

        {file?.kind === 'office' && file.mime && (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b border-border-soft px-3 py-1.5 font-mono text-[10px] text-fg-faint">
              <FileText size={12} />
              {file.mime} · {formatBytes(file.sizeBytes)}
              {file.pageCount ? ` · ${file.pageCount} 页` : ''}
            </div>
            <OfficePreviewPane
              path={file.path}
              streamPath={file.streamPath}
              mime={file.mime}
              fileName={file.fileName}
            />
          </div>
        )}

        {file?.kind === 'binary' && (
          <div className="flex min-h-0 flex-1 items-center justify-center p-6">
            <div className="max-w-md rounded-md border border-border bg-panel-2 p-4 text-sm leading-relaxed text-fg-dim">
              <div className="mb-2 flex items-center gap-2 font-medium text-fg">
                <FileWarning size={16} />
                二进制文件
              </div>
              系统未提供此文件的缩略图。可用右上角按钮打开默认程序。大小 {formatBytes(file.sizeBytes)}。
            </div>
          </div>
        )}
    </>
  );

  if (embedded) {
    return (
      <div ref={embeddedPanelRef} className="flex min-h-0 min-w-0 flex-1 flex-col bg-panel">
        {panelContent}
      </div>
    );
  }

  const overlay = (
    <div className={cn(overlayContainerRef ? 'absolute' : 'fixed', 'inset-0 z-50 pointer-events-none')}>
      <aside
        ref={asideRef}
        className={cn(
          'pointer-events-auto absolute bottom-0 right-0 top-0 flex flex-col bg-panel shadow-2xl',
          isExpanded ? 'left-0' : 'border-l border-border',
        )}
        style={isExpanded ? undefined : { width, maxWidth: overlayContainerRef ? '100%' : undefined }}
      >
        {panelContent}
      </aside>
    </div>
  );
  if (overlayContainerRef) {
    return overlayContainerRef.current ? createPortal(overlay, overlayContainerRef.current) : null;
  }
  return overlay;
}
