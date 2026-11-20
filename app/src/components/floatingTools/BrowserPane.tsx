import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type FormEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { ArrowLeft, ArrowRight, ExternalLink, FileUp, Globe2, Maximize2, Minimize2, RotateCw, X } from 'lucide-react';
import FilePreviewDrawer from '@/components/ai/FilePreviewDrawer';
import ModelViewer from '@/components/ai/ModelViewer';
import { canPreviewModelUrl } from '@/components/ai/lib/modelLink';
import TemporaryChatFrame from '@/components/temporaryChat/TemporaryChatFrame';
import { PreviewChatResizeHandle, usePreviewChatWidth } from '@/components/temporaryChat/PreviewChatResize';
import { useFilePreviewTabs, type BrowserPreviewTab } from '@/store/filePreviewTabs';
import '@/components/ai/FilePreviewTabs.css';
import { browserSource, fileSource, registerVisibleSource } from '@/components/temporaryChat/context';
import { clearProjectFileDragData, hasProjectFileDragData, projectFilePathsFromDataTransfer, setProjectFileDragAccepted } from '@/lib/projectFileDrag';
import { openExternal, openLocalPath, tauriAvailable } from '@/lib/tauri';
import { useResizableWidth } from '@/lib/useResizableWidth';
import PreviewFloatingTools from './PreviewFloatingTools';

let browserQueue: Promise<void> = Promise.resolve();
const ABSOLUTE_PATH = /^(?:[a-z]:[\\/]|\\\\|\/)/i;

export function browserAddress(input: string): string {
  const value = input.trim();
  if (!value) return '';
  if (ABSOLUTE_PATH.test(value)) return value;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value) || /^(?:file|data|javascript|about):/i.test(value)) return value;
  if (/\s/.test(value) || !/[.:]/.test(value)) return `https://www.bing.com/search?q=${encodeURIComponent(value)}`;
  return `${/^(localhost|127(?:\.\d+){3}|\[::1\])(?::|\/|$)/i.test(value) ? 'http' : 'https'}://${value}`;
}

function localBrowserPath(address: string): string | null {
  if (ABSOLUTE_PATH.test(address)) return address.replace(/^\/([a-z]:[\\/])/i, '$1');
  if (!/^file:\/\//i.test(address)) return null;
  try {
    const url = new URL(address);
    const path = decodeURIComponent(url.pathname);
    return url.hostname ? `//${url.hostname}${path}` : path.replace(/^\/([a-z]:\/)/i, '$1');
  } catch {
    return null;
  }
}

export default function BrowserPane({ browserId, onClose, expanded, visible = true, onExpandedChange, scope = '', file, projectDragging = false }: {
  browserId: string; onClose: () => void; expanded: boolean; visible?: boolean; onExpandedChange: (expanded: boolean) => void; scope?: string;
  file?: BrowserPreviewTab['file']; projectDragging?: boolean;
}) {
  const desktop = tauriAvailable();
  const { width, onResizeStart } = useResizableWidth({ storageKey: 'floatingBrowserWidth', defaultWidth: 600, min: 320, max: 1200, edge: 'left' });
  const viewport = useRef<HTMLDivElement>(null);
  const disposed = useRef(false);
  const editing = useRef(false);
  const showingFile = useRef(false);
  const [address, setAddress] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [fileVersion, setFileVersion] = useState(0);
  const pageUrl = file ? '' : url;
  const modelFile = file && canPreviewModelUrl(file.path);
  const showNative = visible && !file && !projectDragging;
  const hasContent = !!(file || pageUrl);
  const source = () => file ? fileSource(file) : browserSource(pageUrl, browserId);
  const chatOpen = useFilePreviewTabs((state) => !!state.chatOpenByScope[scope]);
  const setChatOpen = useFilePreviewTabs((state) => state.setPreviewChatOpen);
  const [chatStarted, setChatStarted] = useState(false);
  const { width: chatWidth, resize: resizeChat } = usePreviewChatWidth();
  useEffect(() => { if (expanded && visible && chatOpen && hasContent) setChatStarted(true); }, [expanded, visible, chatOpen, hasContent]);

  useLayoutEffect(() => {
    showingFile.current = !!file;
    if (!file) return;
    setAddress(file.path);
    setUrl('');
    setError('');
  }, [file]);

  useEffect(() => {
    if (!visible) return;
    if (file) return registerVisibleSource(fileSource(file));
    if (pageUrl) return registerVisibleSource(browserSource(pageUrl, browserId));
  }, [browserId, file, pageUrl, visible]);

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
    const localPath = desktop ? localBrowserPath(next) : null;
    if (localPath && !/\.(?:html?|xhtml?|shtml|hta)$/i.test(localPath)) {
      useFilePreviewTabs.getState().openBrowserFiles(browserId, [localPath], false);
      return;
    }
    showingFile.current = false;
    setAddress(next);
    setUrl(next);
    useFilePreviewTabs.getState().setBrowserLocation(browserId, next, true);
    setError('');
    if (desktop) enqueue(async () => {
      const area = bounds();
      if (!area || disposed.current || showingFile.current) return;
      await invoke('floating_browser_open', { browserId, url: next, bounds: area });
      const latest = bounds();
      if (latest && !disposed.current) await invoke('floating_browser_bounds', { browserId, bounds: latest });
    });
  }, [bounds, browserId, desktop, enqueue]);

  useEffect(() => {
    disposed.current = false;
    let cancelled = false;
    let unlistenLocation: (() => void) | undefined;
    let unlistenTitle: (() => void) | undefined;
    let unlistenOpen: (() => void) | undefined;
    if (desktop) {
      void listen<{ browserId: string; url: string }>('ugs:browser-location', ({ payload }) => {
        if (payload.browserId !== browserId || showingFile.current) return;
        if (!editing.current) setAddress(payload.url);
        setUrl(payload.url);
        useFilePreviewTabs.getState().setBrowserLocation(browserId, payload.url);
      }).then((stop) => { if (cancelled) stop(); else unlistenLocation = stop; });
      void listen<{ browserId: string; title: string }>('ugs:browser-title', ({ payload }) => {
        if (payload.browserId === browserId && !showingFile.current) useFilePreviewTabs.getState().setBrowserTitle(browserId, payload.title);
      }).then((stop) => { if (cancelled) stop(); else unlistenTitle = stop; });
      void listen<{ browserId: string; url: string }>('ugs:browser-open-url', ({ payload }) => {
        if (payload.browserId === browserId && !showingFile.current) navigate(payload.url);
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
      unlistenTitle?.();
      unlistenOpen?.();
      if (desktop) enqueue(() => invoke('floating_browser_close', { browserId }));
    };
  }, [bounds, browserId, desktop, enqueue, navigate]);

  useEffect(() => {
    window.dispatchEvent(new Event('ugs:floating-browser-layout'));
    if (!desktop) return;
    enqueue(async () => {
      if (showNative) {
        const area = bounds();
        if (!area) return;
        await invoke('floating_browser_bounds', { browserId, bounds: area });
      }
      await invoke('floating_browser_visibility', { browserId, visible: showNative });
    });
  }, [bounds, browserId, desktop, enqueue, expanded, showNative]);

  const action = (name: 'back' | 'forward' | 'reload') => {
    if (file && name === 'reload') setFileVersion((version) => version + 1);
    else if (desktop && pageUrl) enqueue(() => invoke('floating_browser_action', { browserId, action: name }));
  };
  const chooseFile = async () => {
    try {
      const path = await open({ multiple: false, directory: false, title: '打开本地文件' });
      if (typeof path === 'string') navigate(path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const submit = (event: FormEvent) => { event.preventDefault(); navigate(address); };
  const openInSystem = async () => {
    try {
      if (file) {
        if (!(await openLocalPath(file.path))) throw new Error('无法用系统默认程序打开该文件');
        setError('');
        return;
      }
      const currentUrl = desktop ? await invoke<string>('floating_browser_current_url', { browserId }) : pageUrl;
      const local = /^file:/i.test(currentUrl) || ABSOLUTE_PATH.test(currentUrl);
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

  const acceptProjectDrag = (event: DragEvent<HTMLElement>) => {
    if (!hasProjectFileDragData(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setProjectFileDragAccepted(true);
  };
  const dropProjectFiles = (event: DragEvent<HTMLElement>) => {
    if (!hasProjectFileDragData(event.dataTransfer)) return;
    event.preventDefault();
    const paths = projectFilePathsFromDataTransfer(event.dataTransfer);
    clearProjectFileDragData();
    useFilePreviewTabs.getState().openBrowserFiles(browserId, paths);
  };

  const floatingTools = <PreviewFloatingTools label={file ? '针对当前文件随手聊' : '针对当前网页随手聊'} source={source} disabled={!hasContent}
    onOpen={expanded ? () => setChatOpen(scope, true) : undefined} />;

  return <aside id={`ugs-floating-browser-${browserId}`} className={`ugs-browser-pane${expanded ? ' ugs-browser-pane-expanded' : ''}`} data-ugs-browser-panel={browserId} data-expanded={expanded} hidden={!visible}
    onDragOver={acceptProjectDrag} onDrop={dropProjectFiles}
    style={expanded ? undefined : { width: `min(${width}px, 58%)` }}>
    {!expanded && <div className="ugs-browser-resize" title="拖动调整宽度" onMouseDown={onResizeStart} />}
    <div className="ugs-browser-heading"><Globe2 size={14} /><span>浏览器</span>
      {desktop && <div className="ugs-browser-floating-tools-slot">{floatingTools}</div>}
      <button type="button" title={expanded ? '还原到侧栏' : '在信息流区域打开'} aria-label={expanded ? '还原到侧栏' : '在信息流区域打开'}
        onClick={() => onExpandedChange(!expanded)}>{expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>
      <button type="button" title={file ? '用系统默认程序打开' : '用系统浏览器打开'} aria-label={file ? '用系统默认程序打开' : '用系统浏览器打开'} disabled={!hasContent}
        onClick={() => { void openInSystem(); }}><ExternalLink size={14} /></button>
      <button type="button" title="关闭浏览器" aria-label="关闭浏览器" onClick={onClose}><X size={15} /></button>
    </div>
    <form className="ugs-browser-navigation" onSubmit={submit}>
      <button type="button" title="后退" aria-label="后退" disabled={!pageUrl} onClick={() => action('back')}><ArrowLeft size={14} /></button>
      <button type="button" title="前进" aria-label="前进" disabled={!pageUrl} onClick={() => action('forward')}><ArrowRight size={14} /></button>
      <button type="button" title="刷新" aria-label="刷新" disabled={!hasContent} onClick={() => action('reload')}><RotateCw size={13} /></button>
      <input aria-label="浏览器地址" placeholder="输入网址、搜索内容或本地文件路径" value={address}
        onFocus={() => { editing.current = true; }} onBlur={() => { editing.current = false; }}
        onChange={(event) => setAddress(event.target.value)} />
      {desktop && <button type="button" title="打开本地文件" aria-label="打开本地文件" onClick={() => { void chooseFile(); }}><FileUp size={14} /></button>}
    </form>
    {error && <div className="ugs-browser-error" role="alert">{error}</div>}
    <div className="ugs-browser-body">
      <div className="ugs-browser-page">
      <div className="ugs-browser-viewport" ref={viewport}>
        {!hasContent && <div className="ugs-browser-empty"><Globe2 size={28} /><span>输入网址，或拖入文件预览</span></div>}
        {file && (modelFile
          ? <ModelViewer key={`${file.path}:${fileVersion}`} src={file.path} label={file.basename} />
          : <FilePreviewDrawer key={`${file.path}:${fileVersion}`} refData={file} variant="browser" active={visible} onClose={onClose} />)}
        {!desktop && pageUrl && <iframe title="浏览器页面" src={pageUrl} sandbox="allow-scripts allow-forms allow-popups" />}
        {visible && projectDragging && <div className="ugs-browser-drop-target"><span>{hasContent ? '松开后在新标签页预览' : '松开后预览文件'}</span></div>}
      </div>
      {!desktop && floatingTools}
      </div>
      {chatStarted && <section className="ugs-preview-chat" hidden={!expanded || !visible || !chatOpen}
        data-resized={chatWidth !== null}
        style={chatWidth === null ? undefined : { '--ugs-preview-chat-width': `${Math.max(0, chatWidth)}px` } as CSSProperties}
        aria-label={file ? '文件随手聊' : '网页随手聊'}>
        <PreviewChatResizeHandle onResize={resizeChat} />
        <div className="ugs-preview-chat-heading">
          <span className="ugs-preview-chat-mark" aria-hidden="true">✦</span><span>随手聊</span>
          <button type="button" aria-label={file ? '关闭文件随手聊' : '关闭网页随手聊'} title="关闭随手聊" onClick={() => setChatOpen(scope, false)}><X size={15} /></button>
        </div>
        <TemporaryChatFrame source={source()} title={file ? '文件随手聊' : '网页随手聊'} fileTab updateSource />
      </section>}
    </div>
  </aside>;
}
