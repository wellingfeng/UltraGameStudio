import { useEffect, useMemo, useState } from 'react';
import {
  Code2,
  ExternalLink,
  FileText,
  FileWarning,
  Globe2,
  Image as ImageIcon,
  Loader2,
  X,
} from 'lucide-react';
import {
  openLocalPath,
  previewLocalFile,
  type LocalFilePreview,
} from '@/lib/tauri';
import { useResizableWidth } from '@/lib/useResizableWidth';
import type { FileRef } from './lib/filePath';
import Markdown from './Markdown';

type PreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; file: LocalFilePreview }
  | { status: 'error'; message: string };

const EXT_TO_LANG: Record<string, string> = {
  ts: 'ts',
  tsx: 'tsx',
  mts: 'ts',
  cts: 'ts',
  js: 'js',
  jsx: 'jsx',
  mjs: 'js',
  cjs: 'js',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  map: 'json',
  webmanifest: 'json',
  ipynb: 'json',
  ndjson: 'json',
  jsonl: 'json',
  geojson: 'json',
  topojson: 'json',
  har: 'json',
  css: 'css',
  scss: 'css',
  sass: 'css',
  less: 'css',
  pcss: 'css',
  postcss: 'css',
  styl: 'css',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  shtml: 'html',
  xht: 'html',
  hta: 'html',
  mjml: 'html',
  vue: 'vue',
  svelte: 'html',
  astro: 'html',
  svg: 'svg',
  xml: 'xml',
  xsd: 'xml',
  xsl: 'xml',
  xslt: 'xml',
  dtd: 'xml',
  rss: 'xml',
  atom: 'xml',
  wsdl: 'xml',
  csproj: 'xml',
  fsproj: 'xml',
  vbproj: 'xml',
  vcxproj: 'xml',
  md: 'md',
  mdx: 'md',
  markdown: 'md',
  mkd: 'md',
  mkdn: 'md',
  mdown: 'md',
  mdwn: 'md',
  mdtxt: 'md',
  mdtext: 'md',
  rmd: 'md',
  qmd: 'md',
  yml: 'yaml',
  yaml: 'yaml',
  toml: '',
  py: 'py',
  pyw: 'py',
  pyi: 'py',
  rs: 'rs',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  ksh: 'bash',
  ps1: '',
  psm1: '',
  psd1: '',
  bat: '',
  cmd: '',
  sql: '',
  gql: '',
  graphql: '',
  proto: '',
  hcl: '',
  tf: '',
  tfvars: '',
  nix: '',
  go: '',
  java: '',
  kt: '',
  kts: '',
  c: '',
  h: '',
  cc: '',
  cpp: '',
  cxx: '',
  hpp: '',
  cs: '',
  php: '',
  swift: '',
  scala: '',
  dart: '',
  lua: '',
  diff: 'diff',
  patch: 'diff',
  rej: 'diff',
  mmd: 'md',
  mermaid: '',
  puml: '',
  plantuml: '',
  dot: '',
  gv: '',
  drawio: 'xml',
};

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

const FILE_PREVIEW_DEFAULT_WIDTH = 760;
const FILE_PREVIEW_MIN_WIDTH = 360;
const FILE_PREVIEW_MAX_WIDTH = 1280;

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

function extensionFromPath(path: string): string {
  const clean = path.split(/[?#]/, 1)[0] ?? path;
  const base = clean.replace(/[\\/]+$/, '');
  const dot = base.lastIndexOf('.');
  if (dot === -1 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

function languageFromPath(path: string): string {
  return EXT_TO_LANG[extensionFromPath(path)] ?? '';
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

function codeFence(text: string, language: string): string {
  const longestFence =
    Math.max(2, ...Array.from(text.matchAll(/`{3,}/g), (m) => m[0].length)) + 1;
  const fence = '`'.repeat(longestFence);
  return `${fence}${language}\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}`;
}

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

export default function FilePreviewDrawer({
  refData,
  cwd,
  onClose,
}: {
  refData: FileRef | null;
  cwd?: string;
  onClose: () => void;
}) {
  const [state, setState] = useState<PreviewState>({ status: 'idle' });
  const { width, onResizeStart } = useResizableWidth({
    storageKey: 'freeultracode.filePreviewWidth.v1',
    defaultWidth: filePreviewDefaultWidth(),
    min: FILE_PREVIEW_MIN_WIDTH,
    max: filePreviewMaxWidth(),
    edge: 'left',
  });

  useEffect(() => {
    if (!refData) {
      setState({ status: 'idle' });
      return;
    }

    let disposed = false;
    setState({ status: 'loading' });
    void previewLocalFile(refData.path, { cwd })
      .then((file) => {
        if (!disposed) setState({ status: 'ready', file });
      })
      .catch((err) => {
        if (!disposed) setState({ status: 'error', message: errorMessage(err) });
      });
    return () => {
      disposed = true;
    };
  }, [cwd, refData]);

  useEffect(() => {
    if (!refData) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, refData]);

  const file = state.status === 'ready' ? state.file : null;
  const label = file?.fileName ?? refData?.basename ?? '文件预览';
  const path = file?.path ?? refData?.path ?? '';
  const lineSuffix = refData?.startLine
    ? `:${refData.startLine}${refData.endLine ? `-${refData.endLine}` : ''}`
    : '';
  const textPreviewMode =
    file?.kind === 'text' ? textPreviewModeFromPath(file.path, file.mime) : 'code';
  const markdown = useMemo(() => {
    if (!file || file.kind !== 'text' || file.text == null) return '';
    if (textPreviewMode === 'markdown') return file.text;
    if (textPreviewMode === 'html') return '';
    return codeFence(file.text, languageFromPath(file.path));
  }, [file, textPreviewMode]);

  if (!refData) return null;

  return (
    <div className="fixed inset-0 z-50 pointer-events-none">
      <button
        type="button"
        aria-label="关闭文件预览"
        onClick={onClose}
        className="pointer-events-auto absolute inset-0 bg-bg/45 backdrop-blur-[1px]"
      />
      <aside
        className="pointer-events-auto absolute bottom-0 right-0 top-0 flex flex-col border-l border-border bg-panel shadow-2xl"
        style={{ width }}
      >
        <div
          onMouseDown={onResizeStart}
          title="拖动调整预览宽度"
          aria-label="拖动调整预览宽度"
          className="group absolute -left-1 bottom-0 top-0 z-20 flex w-2 cursor-col-resize items-center justify-center"
        >
          <div className="h-full w-0.5 bg-transparent transition-colors group-hover:bg-accent/50" />
        </div>
        <header className="flex min-h-0 shrink-0 items-start gap-2 border-b border-border-soft px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-medium text-fg" title={path}>
                {label}
                {lineSuffix && <span className="text-fg-faint">{lineSuffix}</span>}
              </span>
            </div>
            <div className="mt-0.5 truncate font-mono text-[10px] text-fg-faint" title={path}>
              {path}
            </div>
          </div>
          {file && (
            <button
              type="button"
              onClick={() => void openLocalPath(file.path)}
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

        {state.status === 'loading' && (
          <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-fg-dim">
            <Loader2 size={16} className="animate-spin text-accent" />
            读取中
          </div>
        )}

        {state.status === 'error' && (
          <div className="flex min-h-0 flex-1 items-center justify-center p-6">
            <div className="max-w-md rounded-md border border-status-error/40 bg-status-error/10 p-4 text-sm leading-relaxed text-fg-dim">
              <div className="mb-2 flex items-center gap-2 font-medium text-status-error">
                <FileWarning size={16} />
                无法预览
              </div>
              {state.message}
            </div>
          </div>
        )}

        {file?.truncated && (
          <div className="shrink-0 border-b border-accent-3/30 bg-accent-3/10 px-3 py-1.5 text-xs text-accent-3">
            文件较大，已截断显示。原始大小 {formatBytes(file.sizeBytes)}。
          </div>
        )}

        {file?.kind === 'image' && file.base64 && file.mime && (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b border-border-soft px-3 py-1.5 font-mono text-[10px] text-fg-faint">
              <ImageIcon size={12} />
              {file.mime} · {formatBytes(file.sizeBytes)}
            </div>
            <div className="min-h-0 flex-1 overflow-auto bg-bg p-4">
              <img
                src={`data:${file.mime};base64,${file.base64}`}
                alt={file.fileName}
                className="mx-auto max-h-full max-w-full object-contain"
              />
            </div>
          </div>
        )}

        {file?.kind === 'text' && textPreviewMode === 'html' && (
          <div className="flex min-h-0 flex-1 flex-col bg-white">
            <div className="flex shrink-0 items-center gap-2 border-b border-border-soft bg-panel px-3 py-1.5 font-mono text-[10px] text-fg-faint">
              <Globe2 size={12} />
              {file.mime ?? 'text/html'} · {formatBytes(file.sizeBytes)}
            </div>
            <iframe
              title={file.fileName}
              sandbox=""
              srcDoc={file.text ?? ''}
              className="min-h-0 flex-1 border-0 bg-white"
            />
          </div>
        )}

        {file?.kind === 'text' && textPreviewMode === 'markdown' && (
          <div className="min-h-0 flex-1 overflow-auto bg-bg p-4">
            <div className="mb-3 flex items-center gap-2 border-b border-border-soft pb-2 font-mono text-[10px] text-fg-faint">
              <FileText size={12} />
              {file.mime ?? 'text/markdown'} · {formatBytes(file.sizeBytes)}
            </div>
            <Markdown text={markdown} />
          </div>
        )}

        {file?.kind === 'text' && textPreviewMode === 'code' && (
          <div className="ai-file-preview-code min-h-0 flex-1 overflow-hidden bg-bg">
            <div className="flex shrink-0 items-center gap-2 border-b border-border-soft px-3 py-1.5 font-mono text-[10px] text-fg-faint">
              <Code2 size={12} />
              {file.mime ?? 'text/plain'} · {formatBytes(file.sizeBytes)}
            </div>
            <Markdown text={markdown} />
          </div>
        )}

        {file?.kind === 'binary' && (
          <div className="flex min-h-0 flex-1 items-center justify-center p-6">
            <div className="max-w-md rounded-md border border-border bg-panel-2 p-4 text-sm leading-relaxed text-fg-dim">
              <div className="mb-2 flex items-center gap-2 font-medium text-fg">
                <FileWarning size={16} />
                二进制文件
              </div>
              暂不在预览器中显示。大小 {formatBytes(file.sizeBytes)}。
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
