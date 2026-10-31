import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { emitTo, listen } from '@tauri-apps/api/event';
import { LogicalSize, PhysicalSize } from '@tauri-apps/api/dpi';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ChevronUp, Minus, X } from 'lucide-react';
import { temporaryChatDocument, TEMPORARY_CHAT_PERMISSIONS, TEMPORARY_CHAT_SANDBOX } from './document';
import './nativeTemporaryChat.css';

const directions = ['North', 'NorthEast', 'East', 'SouthEast', 'South', 'SouthWest', 'West', 'NorthWest'] as const;
type Direction = typeof directions[number];

export default function NativeTemporaryChat({ id, number }: { id: string; number: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const savedSize = useRef<PhysicalSize>();
  const [document] = useState(temporaryChatDocument);
  const [minimized, setMinimized] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const ready = listen('ugs:temporary-chat-state', ({ payload }) => {
      frame.current?.contentWindow?.postMessage({ scope: 'ugs-temporary-chat', type: 'state', state: payload }, '*');
    }).then(stop => { if (disposed) stop(); else unlisten = stop; });
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.scope !== 'ugs-temporary-chat') return;
      void ready.then(() => emitTo('main', 'ugs:temporary-chat-action', { id, action: event.data }))
        .catch(reason => setError(`聊天连接失败：${String(reason)}`));
    };
    window.addEventListener('message', receive);
    return () => { disposed = true; unlisten?.(); window.removeEventListener('message', receive); };
  }, [id]);

  const perform = (action: () => Promise<unknown>) => {
    void action().catch(reason => setError(`窗口操作失败：${String(reason)}`));
  };
  const startDrag = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    event.preventDefault();
    perform(() => getCurrentWindow().startDragging());
  };
  const startResize = (event: MouseEvent<HTMLDivElement>, direction: Direction) => {
    if (event.button !== 0 || minimized) return;
    event.preventDefault();
    event.stopPropagation();
    perform(() => getCurrentWindow().startResizeDragging(direction));
  };
  const toggleMinimized = () => perform(async () => {
    const current = getCurrentWindow();
    if (!minimized) {
      const size = await current.innerSize();
      const scale = await current.scaleFactor();
      savedSize.current = size;
      await current.setMinSize(new LogicalSize(300, 40));
      await current.setSize(new LogicalSize(size.width / scale, 40));
      setMinimized(true);
    } else {
      await current.setSize(savedSize.current ?? new LogicalSize(360, 420));
      await current.setMinSize(new LogicalSize(300, 240));
      setMinimized(false);
    }
  });

  return <section className={`native-temporary-chat${minimized ? ' is-minimized' : ''}`} role="dialog" aria-label={`临时聊天 ${number}`}>
    {!minimized && directions.map(direction => <div key={direction} className={`native-chat-resize resize-${direction.toLowerCase()}`}
      data-resize-direction={direction} onMouseDown={event => startResize(event, direction)} />)}
    <div className="native-chat-title" onMouseDown={startDrag}>
      <span className="native-chat-mark" aria-hidden="true">✦</span>
      <span className="native-chat-name">随手聊 <small>{number}</small></span>
      <button type="button" aria-label={`${minimized ? '恢复' : '收起'}临时聊天 ${number}`} onClick={toggleMinimized}>
        {minimized ? <ChevronUp size={15} /> : <Minus size={15} />}
      </button>
      <button type="button" aria-label={`关闭临时聊天 ${number}`} onClick={() => perform(() => getCurrentWindow().close())}><X size={15} /></button>
    </div>
    {error && <div className="native-chat-error" role="alert">{error}</div>}
    <iframe ref={frame} title={`临时聊天 ${number} 内容`} srcDoc={document}
      sandbox={TEMPORARY_CHAT_SANDBOX} allow={TEMPORARY_CHAT_PERMISSIONS} referrerPolicy="no-referrer" hidden={minimized} />
  </section>;
}
