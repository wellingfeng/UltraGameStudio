// Moon Begin: window controls and a narrowly scoped text-chat bridge.
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronUp, Minus, X } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { emitTo, listen, type UnlistenFn } from '@tauri-apps/api/event';
import { tauriAvailable } from '@/lib/tauri';
import { temporaryChatDocument, TEMPORARY_CHAT_PERMISSIONS, TEMPORARY_CHAT_SANDBOX } from './document';
import './temporaryChat.css';
import { TemporaryChat, handleChatAction } from './chat';
import { currentSource, type ContextSource } from './context';

type ChatWindow = { id: number; x: number; y: number; minimized: boolean; layer: number; source?: ContextSource };
type NativeAction = { id: string; action: unknown };

export const OPEN_TEMPORARY_CHAT_EVENT = 'ugs:temporary-chat-open';

export function requestTemporaryChat(source?: ContextSource): void {
  window.dispatchEvent(new CustomEvent(OPEN_TEMPORARY_CHAT_EVENT, { detail: source }));
}

function clampPosition(x: number, y: number, width: number, height: number) {
  const browser = document.querySelector<HTMLElement>('[data-ugs-browser-panel]');
  const rightEdge = browser ? browser.getBoundingClientRect().left : window.innerWidth;
  return {
    x: Math.max(8, Math.min(x, rightEdge - width - 8)),
    y: Math.max(8, Math.min(y, window.innerHeight - height - 36)),
  };
}

function ChatPanel({ chat, update, close, focus }: {
  chat: ChatWindow;
  update: (patch: Partial<ChatWindow>) => void;
  close: () => void;
  focus: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [document] = useState(temporaryChatDocument);

  useEffect(() => {
    const controller = new TemporaryChat(state => frame.current?.contentWindow?.postMessage({ scope: 'ugs-temporary-chat', type: 'state', state }, '*'), undefined, chat.source);
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      handleChatAction(controller, event.data);
    };
    window.addEventListener('message', receive);
    void controller.refresh();
    return () => { window.removeEventListener('message', receive); controller.dispose(); };
  }, []);

  useEffect(() => {
    const keepVisible = () => {
      const rect = panel.current?.getBoundingClientRect();
      if (rect) update(clampPosition(rect.x, rect.y, rect.width, rect.height));
    };
    window.addEventListener('resize', keepVisible);
    window.addEventListener('ugs:floating-browser-layout', keepVisible);
    return () => {
      window.removeEventListener('resize', keepVisible);
      window.removeEventListener('ugs:floating-browser-layout', keepVisible);
    };
  }, [update]);

  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    drag.current = { x: event.clientX, y: event.clientY, left: chat.x, top: chat.y };
    event.currentTarget.setPointerCapture(event.pointerId);
    focus();
  };
  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    const rect = panel.current?.getBoundingClientRect();
    if (!current || !rect) return;
    update(clampPosition(current.left + event.clientX - current.x, current.top + event.clientY - current.y, rect.width, rect.height));
  };
  const moveWithKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const direction = { ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] }[event.key];
    const rect = panel.current?.getBoundingClientRect();
    if (!direction || !rect) return;
    event.preventDefault();
    update(clampPosition(chat.x + direction[0], chat.y + direction[1], rect.width, rect.height));
  };

  return <section
    ref={panel}
    role="dialog"
    aria-label={`临时聊天 ${chat.id}`}
    className={`temporary-chat-window${chat.minimized ? ' is-minimized' : ''}`}
    style={{ left: chat.x, top: chat.y, zIndex: 1000 + chat.layer }}
    onPointerDownCapture={focus}
    onFocusCapture={focus}
  >
    <div className="temporary-chat-title" tabIndex={0} aria-label={`移动临时聊天 ${chat.id}`}
      onPointerDown={startDrag} onPointerMove={moveDrag} onKeyDown={moveWithKeys}
      onPointerUp={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
      <span className="temporary-chat-mark" aria-hidden="true">✦</span>
      <span className="temporary-chat-name">随手聊 <small>{chat.id}</small></span>
      <button type="button" aria-label={`${chat.minimized ? '恢复' : '收起'}临时聊天 ${chat.id}`}
        onClick={() => update({ minimized: !chat.minimized })}>
        {chat.minimized ? <ChevronUp size={15} /> : <Minus size={15} />}
      </button>
      <button type="button" aria-label={`关闭临时聊天 ${chat.id}`} onClick={close}><X size={15} /></button>
    </div>
    <iframe ref={frame} title={`临时聊天 ${chat.id} 内容`} srcDoc={document}
      sandbox={TEMPORARY_CHAT_SANDBOX} allow={TEMPORARY_CHAT_PERMISSIONS} referrerPolicy="no-referrer"
      hidden={chat.minimized} />
  </section>;
}

export default function TemporaryChatWindows() {
  const [windows, setWindows] = useState<ChatWindow[]>([]);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const layer = useRef(0);
  const controllers = useRef(new Map<string, TemporaryChat>());
  const listenersReady = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(false);
  const open = (source?: ContextSource) => {
    const id = ++sequence.current;
    if (tauriAvailable()) {
      const nativeId = crypto.randomUUID();
      const selectedSource = source ?? currentSource();
      void (async () => {
        let controller: TemporaryChat | undefined;
        try {
          await listenersReady.current;
          if (!mounted.current) return;
          controller = new TemporaryChat(state => {
            void emitTo(`temporary-chat-${nativeId}`, 'ugs:temporary-chat-state', state).catch(() => {});
          }, undefined, selectedSource);
          controllers.current.set(nativeId, controller);
          await invoke('temporary_chat_window_open', { id: nativeId, number: id });
          if (!mounted.current) {
            controller.dispose();
            controllers.current.delete(nativeId);
            await invoke('temporary_chat_window_close', { id: nativeId });
          }
        } catch (reason) {
          controller?.dispose();
          controllers.current.delete(nativeId);
          if (mounted.current) setError(`无法打开随手聊：${String(reason)}`);
        }
      })();
      return;
    }
    const width = Math.min(360, window.innerWidth - 16);
    const height = Math.min(420, window.innerHeight - 52);
    const offset = ((id - 1) % 8) * 26;
    const browser = document.querySelector<HTMLElement>('[data-ugs-browser-panel]');
    const rightEdge = browser ? browser.getBoundingClientRect().left : window.innerWidth;
    const position = clampPosition(rightEdge - width - 18 - offset, window.innerHeight - height - 42 - offset, width, height);
    setWindows((current) => [...current, { id, ...position, minimized: false, layer: ++layer.current, source: source ?? currentSource() }]);
  };
  const update = (id: number, patch: Partial<ChatWindow>) => setWindows((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    if (tauriAvailable()) {
      listenersReady.current = (async () => {
        const stops: UnlistenFn[] = [];
        try {
          stops.push(await listen<NativeAction>('ugs:temporary-chat-action', ({ payload }) => {
            const controller = controllers.current.get(payload?.id);
            if (controller) handleChatAction(controller, payload.action);
          }));
          stops.push(await listen<string>('ugs:temporary-chat-closed', ({ payload }) => {
            controllers.current.get(payload)?.dispose();
            controllers.current.delete(payload);
          }));
          if (disposed) stops.forEach(stop => stop());
          else unlisteners.push(...stops);
        } catch (reason) {
          stops.forEach(stop => stop());
          throw reason;
        }
      })();
      void listenersReady.current.catch(reason => {
        if (!disposed) setError(`无法连接随手聊：${String(reason)}`);
      });
    }
    const onOpen = (event: Event) => open((event as CustomEvent<ContextSource>).detail);
    window.addEventListener(OPEN_TEMPORARY_CHAT_EVENT, onOpen);
    return () => {
      disposed = true;
      mounted.current = false;
      window.removeEventListener(OPEN_TEMPORARY_CHAT_EVENT, onOpen);
      unlisteners.forEach(stop => stop());
      controllers.current.forEach((controller, id) => {
        controller.dispose();
        void invoke('temporary_chat_window_close', { id }).catch(() => {});
      });
      controllers.current.clear();
    };
  }, []);

  return <>
    {error && <span className="temporary-chat-error" role="alert" onClick={() => setError('')}>{error}</span>}
    {createPortal(windows.map((chat) => <ChatPanel key={chat.id} chat={chat}
      update={(patch) => update(chat.id, patch)}
      focus={() => update(chat.id, { layer: ++layer.current })}
      close={() => setWindows((current) => current.filter((item) => item.id !== chat.id))}
    />), document.body)}
  </>;
}
// Moon End
