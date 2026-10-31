import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { ArrowLeft, ArrowRight, ExternalLink, FileUp, Globe2, Maximize2, MessageSquarePlus, Minimize2, RotateCw, X } from 'lucide-react';
import { requestTemporaryChat } from '@/components/temporaryChat/TemporaryChatWindows';
import { browserSource, registerVisibleSource } from '@/components/temporaryChat/context';
import { openExternal, tauriAvailable } from '@/lib/tauri';
import { useResizableWidth } from '@/lib/useResizableWidth';

let browserQueue: Promise<void> = Promise.resolve();

export function browserAddress(input: string): string {
  const value = input.trim();
  if (!value) return '';
  if (/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(value)) return value;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value) || /^(?:file|data|javascript|about):/i.test(value)) return value;
  if (/\s/.test(value) || !/[.:]/.test(value)) return `https://www.bing.com/search?q=${encodeURIComponent(value)}`;
  return `${/^(localhost|127(?:\.\d+){3}|\[::1\])(?::|\/|$)/i.test(value) ? 'http' : 'https'}://${value}`;
}

export default function BrowserPane({ onClose, expanded, onExpandedChange }: {
  onClose: () => void; expanded: boolean; onExpandedChange: (expanded: boolean) => void;
}) {
  const desktop = tauriAvailable();
  const { width, onResizeStart } = useResizableWidth({ storageKey: 'floatingBrowserWidth', defaultWidth: 600, min: 320, max: 1200, edge: 'left' });
  const viewport = useRef<HTMLDivElement>(null);
  const disposed = useRef(false);
  const editing = useRef(false);
  const [address, setAddress] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');

  useEffect(() => url ? registerVisibleSource(browserSource()) : undefined, [url]);

  const bounds = useCallback(() => {
    const rect = viewport.current?.getBoundingClientRect();
    return rect && rect.width > 0 && rect.height > 0
      ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
  }, []);
  const enqueue = useCallback((work: () => Promise<unknown>) => {
    browserQueue = browserQueue.then(async () => { await work(); }).catch((reason: unknown) => {
      if (!disposed.current) setError(reason instanceof Error ? reason.message : String(reason));
    });
  }, []);
  const navigate = useCallback((input: string) => {
    const next = browserAddress(input);
    if (!next) return;
    setAddress(next);
    setUrl(next);
    setError('');
    if (desktop) enqueue(async () => {
      const area = bounds();
      if (!area || disposed.current) return;
      await invoke('floating_browser_open', { url: next, bounds: area });
      const latest = bounds();
      if (latest && !disposed.current) await invoke('floating_browser_bounds', { bounds: latest });
    });
  }, [bounds, desktop, enqueue]);

  useEffect(() => {
    disposed.current = false;
    let cancelled = false;
    let unlistenLocation: (() => void) | undefined;
    let unlistenOpen: (() => void) | undefined;
    if (desktop) {
      void listen<string>('ugs:browser-location', ({ payload }) => {
        if (!editing.current) setAddress(payload);
        setUrl(payload);
      }).then((stop) => { if (cancelled) stop(); else unlistenLocation = stop; });
      void listen<string>('ugs:browser-open-url', ({ payload }) => navigate(payload))
        .then((stop) => { if (cancelled) stop(); else unlistenOpen = stop; });
    }
    const syncBounds = () => {
      window.dispatchEvent(new Event('ugs:floating-browser-layout'));
      const area = bounds();
      if (desktop && area) enqueue(() => invoke('floating_browser_bounds', { bounds: area }));
    };
    const observer = new ResizeObserver(syncBounds);
    if (viewport.current) observer.observe(viewport.current);
    window.addEventListener('resize', syncBounds);
    return () => {
      disposed.current = true;
      cancelled = true;
      observer.disconnect();
      window.removeEventListener('resize', syncBounds);
      unlistenLocation?.();
      unlistenOpen?.();
      if (desktop) enqueue(() => invoke('floating_browser_close'));
    };
  }, [bounds, desktop, enqueue, navigate]);

  const action = (name: 'back' | 'forward' | 'reload') => {
    if (desktop && url) enqueue(() => invoke('floating_browser_action', { action: name }));
  };
  const chooseFile = async () => {
    try {
      const path = await open({ multiple: false, filters: [{ name: '网页', extensions: ['html', 'htm'] }] });
      if (typeof path === 'string') navigate(path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const submit = (event: FormEvent) => { event.preventDefault(); navigate(address); };
  const openInSystem = async () => {
    try {
      const currentUrl = desktop ? await invoke<string>('floating_browser_current_url') : url;
      const local = /^(?:file:|[a-z]:[\\/]|\\\\|\/)/i.test(currentUrl);
      if (local && desktop) {
        await invoke('floating_browser_open_system_file', { url: currentUrl });
      } else {
        await openExternal(currentUrl);
      }
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return <aside id="ugs-floating-browser" className={`ugs-browser-pane${expanded ? ' ugs-browser-pane-expanded' : ''}`} data-ugs-browser-panel
    style={expanded ? undefined : { width: `min(${width}px, 58%)` }}>
    {!expanded && <div className="ugs-browser-resize" title="拖动调整宽度" onMouseDown={onResizeStart} />}
    <div className="ugs-browser-heading"><Globe2 size={14} /><span>浏览器</span>
      <button type="button" title="针对当前网页随手聊" aria-label="针对当前网页随手聊" disabled={!url} onClick={() => requestTemporaryChat(browserSource())}><MessageSquarePlus size={14} /></button>
      <button type="button" title={expanded ? '还原到侧栏' : '在信息流区域打开'} aria-label={expanded ? '还原到侧栏' : '在信息流区域打开'}
        onClick={() => onExpandedChange(!expanded)}>{expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>
      <button type="button" title="用系统浏览器打开" aria-label="用系统浏览器打开" disabled={!url}
        onClick={() => { void openInSystem(); }}><ExternalLink size={14} /></button>
      <button type="button" title="关闭浏览器" aria-label="关闭浏览器" onClick={onClose}><X size={15} /></button>
    </div>
    <form className="ugs-browser-navigation" onSubmit={submit}>
      <button type="button" title="后退" aria-label="后退" disabled={!url} onClick={() => action('back')}><ArrowLeft size={14} /></button>
      <button type="button" title="前进" aria-label="前进" disabled={!url} onClick={() => action('forward')}><ArrowRight size={14} /></button>
      <button type="button" title="刷新" aria-label="刷新" disabled={!url} onClick={() => action('reload')}><RotateCw size={13} /></button>
      <input aria-label="浏览器地址" placeholder="输入网址、搜索内容或本地文件路径" value={address}
        onFocus={() => { editing.current = true; }} onBlur={() => { editing.current = false; }}
        onChange={(event) => setAddress(event.target.value)} />
      {desktop && <button type="button" title="打开本地网页" aria-label="打开本地网页" onClick={() => { void chooseFile(); }}><FileUp size={14} /></button>}
    </form>
    {error && <div className="ugs-browser-error" role="alert">{error}</div>}
    <div className="ugs-browser-viewport" ref={viewport}>
      {!url && <div className="ugs-browser-empty"><Globe2 size={28} /><strong>浏览器</strong><span>输入网址，或打开本地 HTML 文件</span></div>}
      {!desktop && url && <iframe title="浏览器页面" src={url} sandbox="allow-scripts allow-forms allow-popups" />}
    </div>
  </aside>;
}
