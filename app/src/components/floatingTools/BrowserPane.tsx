import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { ArrowLeft, ArrowRight, ExternalLink, FileUp, Globe2, Maximize2, Minimize2, RotateCw, X } from 'lucide-react';
import TemporaryChatFrame from '@/components/temporaryChat/TemporaryChatFrame';
import { useFilePreviewTabs } from '@/store/filePreviewTabs';
import '@/components/ai/FilePreviewTabs.css';
import { browserSource, registerVisibleSource } from '@/components/temporaryChat/context';
import { openExternal, tauriAvailable } from '@/lib/tauri';
import { useResizableWidth } from '@/lib/useResizableWidth';
import PreviewFloatingTools from './PreviewFloatingTools';

let browserQueue: Promise<void> = Promise.resolve();

export function browserAddress(input: string): string {
  const value = input.trim();
  if (!value) return '';
  if (/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(value)) return value;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value) || /^(?:file|data|javascript|about):/i.test(value)) return value;
  if (/\s/.test(value) || !/[.:]/.test(value)) return `https://www.bing.com/search?q=${encodeURIComponent(value)}`;
  return `${/^(localhost|127(?:\.\d+){3}|\[::1\])(?::|\/|$)/i.test(value) ? 'http' : 'https'}://${value}`;
}

export default function BrowserPane({ browserId, onClose, expanded, visible = true, onExpandedChange, scope = '' }: {
  browserId: string; onClose: () => void; expanded: boolean; visible?: boolean; onExpandedChange: (expanded: boolean) => void; scope?: string;
}) {
  const desktop = tauriAvailable();
  const { width, onResizeStart } = useResizableWidth({ storageKey: 'floatingBrowserWidth', defaultWidth: 600, min: 320, max: 1200, edge: 'left' });
  const viewport = useRef<HTMLDivElement>(null);
  const disposed = useRef(false);
  const editing = useRef(false);
  const [address, setAddress] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const chatOpen = useFilePreviewTabs((state) => !!state.chatOpenByScope[scope]);
  const setChatOpen = useFilePreviewTabs((state) => state.setPreviewChatOpen);
  const [chatStarted, setChatStarted] = useState(false);
  useEffect(() => { if (expanded && visible && chatOpen && url) setChatStarted(true); }, [expanded, visible, chatOpen, url]);

  useEffect(() => url && visible ? registerVisibleSource(browserSource(url, browserId)) : undefined, [browserId, url, visible]);

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
      await invoke('floating_browser_open', { browserId, url: next, bounds: area });
      const latest = bounds();
      if (latest && !disposed.current) await invoke('floating_browser_bounds', { browserId, bounds: latest });
    });
  }, [bounds, browserId, desktop, enqueue]);

  useEffect(() => {
    disposed.current = false;
    let cancelled = false;
    let unlistenLocation: (() => void) | undefined;
    let unlistenOpen: (() => void) | undefined;
    if (desktop) {
      void listen<{ browserId: string; url: string }>('ugs:browser-location', ({ payload }) => {
        if (payload.browserId !== browserId) return;
        if (!editing.current) setAddress(payload.url);
        setUrl(payload.url);
      }).then((stop) => { if (cancelled) stop(); else unlistenLocation = stop; });
      void listen<{ browserId: string; url: string }>('ugs:browser-open-url', ({ payload }) => {
        if (payload.browserId === browserId) navigate(payload.url);
      })
        .then((stop) => { if (cancelled) stop(); else unlistenOpen = stop; });
    }
    const syncBounds = () => {
      window.dispatchEvent(new Event('ugs:floating-browser-layout'));
      const area = bounds();
      if (desktop && area) enqueue(() => invoke('floating_browser_bounds', { browserId, bounds: area }));
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
      if (desktop) enqueue(() => invoke('floating_browser_close', { browserId }));
    };
  }, [bounds, browserId, desktop, enqueue, navigate]);

  useEffect(() => {
    window.dispatchEvent(new Event('ugs:floating-browser-layout'));
    if (!desktop) return;
    enqueue(async () => {
      if (visible) {
        const area = bounds();
        if (!area) return;
        await invoke('floating_browser_bounds', { browserId, bounds: area });
      }
      await invoke('floating_browser_visibility', { browserId, visible });
    });
  }, [bounds, browserId, desktop, enqueue, expanded, visible]);

  const action = (name: 'back' | 'forward' | 'reload') => {
    if (desktop && url) enqueue(() => invoke('floating_browser_action', { browserId, action: name }));
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
      const currentUrl = desktop ? await invoke<string>('floating_browser_current_url', { browserId }) : url;
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

  return <aside id={`ugs-floating-browser-${browserId}`} className={`ugs-browser-pane${expanded ? ' ugs-browser-pane-expanded' : ''}`} data-ugs-browser-panel data-expanded={expanded} hidden={!visible}
    style={expanded ? undefined : { width: `min(${width}px, 58%)` }}>
    {!expanded && <div className="ugs-browser-resize" title="拖动调整宽度" onMouseDown={onResizeStart} />}
    <div className="ugs-browser-heading"><Globe2 size={14} /><span>浏览器</span>
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
    {/* The native webview covers the viewport, so desktop keeps the floating rail in a gutter beside it. */}
    <div className="ugs-browser-body">
      <div className={`ugs-browser-page${desktop ? ' ugs-browser-body-gutter' : ''}`}>
      <div className="ugs-browser-viewport" ref={viewport}>
        {!url && <div className="ugs-browser-empty"><Globe2 size={28} /><strong>浏览器</strong><span>输入网址，或打开本地 HTML 文件</span></div>}
        {!desktop && url && <iframe title="浏览器页面" src={url} sandbox="allow-scripts allow-forms allow-popups" />}
      </div>
      <PreviewFloatingTools label="针对当前网页随手聊" source={() => browserSource(url, browserId)} disabled={!url}
        onOpen={expanded ? () => setChatOpen(scope, true) : undefined} />
      </div>
      {chatStarted && <section className="ugs-preview-chat" hidden={!expanded || !visible || !chatOpen} aria-label="网页随手聊">
        <div className="ugs-preview-chat-heading">
          <span className="ugs-preview-chat-mark" aria-hidden="true">✦</span><span>随手聊</span>
          <button type="button" aria-label="关闭网页随手聊" title="关闭随手聊" onClick={() => setChatOpen(scope, false)}><X size={15} /></button>
        </div>
        <TemporaryChatFrame source={browserSource(url, browserId)} title="网页随手聊" fileTab updateSource />
      </section>}
    </div>
  </aside>;
}
