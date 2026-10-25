import { useEffect, useMemo, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Code2, FileWarning, Globe2, Loader2, RotateCw } from 'lucide-react';
import type { LocalFilePreview } from '@/lib/tauri';
import { embedLocalHtmlResources, resolveHtmlAssetUrl, rewriteLocalAssetsInHtml } from './lib/localHtmlAssets';
import { themePreviewHtml, usePreviewTheme } from './lib/previewTheme';

type HtmlState = { html: string; source: string } | { error: string } | null;

export default function HtmlPreviewPane({ file }: { file: LocalFilePreview }) {
  const theme = usePreviewTheme();
  const [state, setState] = useState<HtmlState>(null);
  const [mode, setMode] = useState<'preview' | 'source'>('preview');
  const [revision, setRevision] = useState(0);
  useEffect(() => setMode('preview'), [file.path]);
  useEffect(() => {
    const controller = new AbortController();
    setState(null);
    const load = async () => {
      // Fetch the complete streamed document, rather than its capped IPC excerpt.
      let html = file.text ?? '';
      if (file.streamPath) {
        const response = await fetch(convertFileSrc(file.streamPath), { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = await response.arrayBuffer();
        const prefix = new TextDecoder().decode(bytes.slice(0, 2048));
        const bom = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength));
        const charset = bom[0] === 0xff && bom[1] === 0xfe ? 'utf-16le'
          : bom[0] === 0xfe && bom[1] === 0xff ? 'utf-16be'
          : /charset\s*=\s*["']?([\w-]+)/i.exec(prefix)?.[1] ?? 'utf-8';
        html = new TextDecoder(charset).decode(bytes);
      }
      const source = html;
      const baseDir = file.path.replace(/[\\/][^\\/]*$/, '');
      html = rewriteLocalAssetsInHtml(html, baseDir);
      const doc = new DOMParser().parseFromString(html, 'text/html');
      // Inline linked CSS so neutral colors in local stylesheets also follow UGS.
      await Promise.all(Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"]')).map(async link => {
        try {
          const response = await fetch(link.href, { signal: controller.signal, cache: 'no-store' });
          if (!response.ok) return; // Keep the original link if CSS cannot be read.
          const style = doc.createElement('style');
          if (link.media) style.media = link.media;
          style.textContent = (await response.text()).replace(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/gi, (match, _quote, url: string) => {
            if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(url)) return match;
            return `url("${resolveHtmlAssetUrl(url, link.href)}")`;
          });
          link.replaceWith(style);
        } catch (error) {
          if (controller.signal.aborted) throw error;
        }
      }));
      await embedLocalHtmlResources(doc, controller.signal);
      if (!controller.signal.aborted) setState({ html: `<!doctype html>${doc.documentElement.outerHTML}`, source });
    };
    void load().catch((err: unknown) => {
      if (!controller.signal.aborted) setState({ error: err instanceof Error ? err.message : String(err) });
    });
    return () => controller.abort();
  }, [file.path, file.streamPath, file.text, revision]);
  const srcDoc = useMemo(() => state && 'html' in state ? themePreviewHtml(state.html, theme) : '', [state, theme]);
  return <div className="flex min-h-0 flex-1 flex-col">
    <div role="toolbar" aria-label="HTML 预览工具" className="flex shrink-0 items-center gap-1 border-b border-border-soft bg-panel px-3 py-1.5">
      <button type="button" aria-label="显示 HTML 预览" aria-pressed={mode === 'preview'}
        onClick={() => setMode('preview')}
        className={`flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-panel-2 ${mode === 'preview' ? 'bg-panel-2 text-fg' : 'text-fg-dim'}`}>
        <Globe2 size={13} />预览
      </button>
      <button type="button" aria-label="查看 HTML 源码" aria-pressed={mode === 'source'}
        onClick={() => setMode('source')}
        className={`flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-panel-2 ${mode === 'source' ? 'bg-panel-2 text-fg' : 'text-fg-dim'}`}>
        <Code2 size={13} />源码
      </button>
      <button type="button" aria-label="刷新 HTML 预览" title="重新读取文件" disabled={!state}
        onClick={() => setRevision(value => value + 1)}
        className="ml-auto flex h-6 w-6 items-center justify-center rounded text-fg-dim hover:bg-panel-2 hover:text-fg disabled:opacity-40">
        <RotateCw size={13} />
      </button>
    </div>
    {!state ? <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-fg-dim"><Loader2 size={16} className="animate-spin" />读取中</div>
      : 'error' in state ? <div className="flex min-h-0 flex-1 items-center justify-center gap-2 p-6 text-sm text-status-error"><FileWarning size={16} />无法预览：{state.error}</div>
      : <>
        {/* Scripts support interactive artifacts; the opaque origin keeps app/IPC access blocked.
            Keep the iframe mounted when viewing source so its scroll and interaction state survive. */}
        <iframe title={file.fileName} sandbox="allow-scripts" srcDoc={srcDoc} hidden={mode !== 'preview'}
          className="min-h-0 flex-1 border-0 bg-bg" />
        {mode === 'source' && <pre aria-label="HTML 源码" className="m-0 min-h-0 flex-1 overflow-auto bg-bg p-4 font-mono text-xs leading-5 text-fg"><code>{state.source}</code></pre>}
      </>}
  </div>;
}
