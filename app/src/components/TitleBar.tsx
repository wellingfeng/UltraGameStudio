import { createContext, useContext, useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Layers, Minus, Square, Copy, X } from 'lucide-react';
import { tauriAvailable } from '@/lib/tauri';
import type { Locale } from '@/lib/i18n';
import SidebarToggleButton from './SidebarToggleButton';
import ModelRankings from './ModelRankings';
import './TitleBar.css';
import { useMainSurface } from './MainSurface';

const TitleBarTarget = createContext<HTMLElement | null>(null);

/** Keep the existing chat header and its interactions in one window chrome row. */
export function TitleBarLayout({ children, sidebarOpen, onToggleSidebar, locale }: {
  children: ReactNode;
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
  locale?: Locale;
}) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [focused, setFocused] = useState(true);
  const [error, setError] = useState('');
  const barRef = useRef<HTMLDivElement>(null);
  const desktop = tauriAvailable();
  const nativeMac = desktop && /Mac/i.test(navigator.platform);

  const run = useCallback((action: () => Promise<unknown>) => {
    setError('');
    void action().catch((reason: unknown) => {
      console.error('Window action failed', reason);
      setError('窗口操作失败，请重试');
    });
  }, []);

  useEffect(() => {
    if (!desktop || nativeMac) return;
    const window = getCurrentWindow();
    let disposed = false;
    const unlisten: Array<() => void> = [];
    // Native DOM bubbling includes the portaled chat header. React bubbling follows
    // the portal's original parent instead, and Tauri's bare drag attributes only
    // match direct clicks, leaving nested blank space undraggable.
    const bar = barRef.current;
    const onMouseDown = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || ![1, 2].includes(event.detail)) return;
      const element = event.target instanceof Element ? event.target : null;
      if (!element || element.closest('button, input, select, textarea, a, label, summary, [role="button"], [role="tab"], [role="link"], [role="menuitem"], [contenteditable]:not([contenteditable="false"]), [data-tauri-drag-region="false"]')) return;
      event.preventDefault();
      // Keep the built-in Tauri document listener from invoking a second action.
      event.stopPropagation();
      run(() => event.detail === 2 ? window.toggleMaximize() : window.startDragging());
    };
    bar?.addEventListener('mousedown', onMouseDown);
    unlisten.push(() => bar?.removeEventListener('mousedown', onMouseDown));
    const subscribe = async (promise: Promise<() => void>) => {
      const stop = await promise;
      if (disposed) stop();
      else unlisten.push(stop);
    };
    const refresh = async () => {
      const value = await window.isMaximized();
      if (!disposed) setMaximized(value);
    };
    void Promise.all([
      refresh(),
      window.isFocused().then((value) => { if (!disposed) setFocused(value); }),
      subscribe(window.onResized(() => { void refresh().catch(console.error); })),
      subscribe(window.onFocusChanged(({ payload }) => setFocused(payload))),
    ]).catch(console.error);
    return () => { disposed = true; unlisten.forEach((stop) => stop()); };
  }, [desktop, nativeMac, run]);

  return (
    <TitleBarTarget.Provider value={target}>
      <div
        ref={barRef}
        className="ugs-titlebar"
        data-focused={focused}
        data-tauri-drag-region
      >
        <div className="ugs-titlebar-brand" data-tauri-drag-region>
          {onToggleSidebar && (
            <SidebarToggleButton side="left" open={sidebarOpen ?? true}
              onClick={onToggleSidebar} controls="ugs-left-sidebar" locale={locale} />
          )}
          <Layers size={14} strokeWidth={1.5} aria-hidden="true" />
          <span data-tauri-drag-region>UltraGameStudio</span>
        </div>
        <div ref={setTarget} className="ugs-titlebar-content" data-tauri-drag-region />
        {error && <span className="ugs-titlebar-error" role="alert">{error}</span>}
        <ModelRankings locale={locale} />
        {desktop && !nativeMac && (
          <div className="ugs-titlebar-controls" aria-label="窗口控制">
            <button type="button" aria-label="最小化" title="最小化" onClick={() => run(() => getCurrentWindow().minimize())}>
              <Minus size={14} strokeWidth={1.5} />
            </button>
            <button type="button" aria-label={maximized ? '还原窗口' : '最大化'} title={maximized ? '还原窗口' : '最大化'} onClick={() => run(() => getCurrentWindow().toggleMaximize())}>
              {maximized ? <Copy size={12} strokeWidth={1.5} /> : <Square size={12} strokeWidth={1.5} />}
            </button>
            <button type="button" className="ugs-titlebar-close" aria-label="关闭窗口" title="关闭窗口" onClick={() => run(() => getCurrentWindow().close())}>
              <X size={16} strokeWidth={1.5} />
            </button>
          </div>
        )}
      </div>
      {children}
    </TitleBarTarget.Provider>
  );
}

export function TitleBarContent({ children, enabled }: { children: ReactNode; enabled: boolean }) {
  const target = useContext(TitleBarTarget);
  const { surface } = useMainSurface();
  if (surface !== 'chat') return null;
  return enabled && target ? createPortal(children, target) : children;
}
