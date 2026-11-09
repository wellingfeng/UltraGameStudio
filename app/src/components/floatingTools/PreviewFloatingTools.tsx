import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { MessageCircleMore } from 'lucide-react';
import { requestTemporaryChat } from '@/components/temporaryChat/TemporaryChatWindows';
import type { ContextSource } from '@/components/temporaryChat/context';
import './floatingTools.css';

type Position = { x: number; y: number };
type Drag = { pointerId: number; start: Position; origin: Position; previous: Position | null; moved: boolean; last: Position };
const POSITION_KEY = 'ultragamestudio.previewFloatingTools.position.v1';
const POSITION_EVENT = 'ugs:preview-floating-tools-position';
const DRAG_THRESHOLD = 4;

function parsePosition(value: string | null): Position | null {
  try {
    const position = value ? JSON.parse(value) : null;
    return position && Number.isFinite(position.x) && Number.isFinite(position.y)
      ? { x: position.x, y: position.y } : null;
  } catch { return null; }
}

function readPosition(): Position | null {
  try { return parsePosition(window.localStorage.getItem(POSITION_KEY)); } catch { return null; }
}

function savePosition(position: Position) {
  try { window.localStorage.setItem(POSITION_KEY, JSON.stringify(position)); } catch { /* Continue in memory. */ }
  window.dispatchEvent(new CustomEvent<Position>(POSITION_EVENT, { detail: position }));
}

// Coordinates are shared by all previews, but remain visible inside the current preview.
function localPosition(element: HTMLElement, position: Position): { local: Position; global: Position } | null {
  const parent = element.parentElement;
  if (!parent) return null;
  const bounds = parent.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  if (!bounds.width || !bounds.height || !rect.width || !rect.height) return null;
  // A native browser webview is above the main webview. Keep the control in its gutter.
  const nativeViewport = parent.classList.contains('ugs-browser-body-gutter')
    ? parent.querySelector<HTMLElement>('.ugs-browser-viewport')?.getBoundingClientRect() : null;
  const left = Math.max(bounds.left, nativeViewport?.right ?? bounds.left, 0);
  const top = Math.max(bounds.top, 0);
  const right = Math.min(bounds.right, window.innerWidth);
  const bottom = Math.min(bounds.bottom, window.innerHeight);
  const global = {
    x: Math.max(left, Math.min(position.x, right - rect.width)),
    y: Math.max(top, Math.min(position.y, bottom - rect.height)),
  };
  return { global, local: { x: global.x - bounds.left - parent.clientLeft, y: global.y - bounds.top - parent.clientTop } };
}

export default function PreviewFloatingTools({ label, source, disabled = false, className, onOpen }: {
  label: string; source: () => ContextSource; disabled?: boolean; className?: string; onOpen?: () => void;
}) {
  const rail = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  const [position, setPosition] = useState<Position | null>(readPosition);
  const [local, setLocal] = useState<Position | null>(null);

  useLayoutEffect(() => {
    const update = () => {
      const next = position && rail.current ? localPosition(rail.current, position)?.local : null;
      setLocal(current => current?.x === next?.x && current?.y === next?.y ? current : next ?? null);
    };
    update();
    const parent = rail.current?.parentElement;
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    if (parent) observer?.observe(parent);
    window.addEventListener('resize', update);
    window.addEventListener('ugs:floating-browser-layout', update);
    window.addEventListener('ugs:file-preview-drawer-layout', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('ugs:floating-browser-layout', update);
      window.removeEventListener('ugs:file-preview-drawer-layout', update);
    };
  }, [position]);

  useLayoutEffect(() => {
    const receive = (event: Event) => {
      if (!drag.current) setPosition((event as CustomEvent<Position>).detail);
    };
    const receiveStorage = (event: StorageEvent) => {
      if (event.key === POSITION_KEY && !drag.current) setPosition(parsePosition(event.newValue));
    };
    window.addEventListener(POSITION_EVENT, receive);
    window.addEventListener('storage', receiveStorage);
    return () => { window.removeEventListener(POSITION_EVENT, receive); window.removeEventListener('storage', receiveStorage); };
  }, []);

  const startDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !rail.current) return;
    const rect = rail.current.getBoundingClientRect();
    const origin = { x: rect.left, y: rect.top };
    drag.current = { pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, origin, previous: position, moved: false, last: origin };
    suppressClick.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId || !rail.current) return;
    const dx = event.clientX - current.start.x;
    const dy = event.clientY - current.start.y;
    if (!current.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    current.moved = true;
    const next = localPosition(rail.current, { x: current.origin.x + dx, y: current.origin.y + dy });
    if (next) { current.last = next.global; setPosition(next.global); }
  };
  const endDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    moveDrag(event);
    const current = drag.current;
    drag.current = null;
    if (current?.moved) { suppressClick.current = true; savePosition(current.last); }
  };
  const cancelDrag = () => {
    if (!drag.current) return;
    setPosition(drag.current.previous);
    drag.current = null;
    suppressClick.current = false;
  };
  const moveWithKeys = (event: KeyboardEvent<HTMLButtonElement>) => {
    const direction = { ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] }[event.key];
    if (!direction || !rail.current) return;
    const rect = rail.current.getBoundingClientRect();
    const next = localPosition(rail.current, { x: rect.left + direction[0], y: rect.top + direction[1] });
    if (!next) return;
    event.preventDefault();
    setPosition(next.global);
    savePosition(next.global);
  };

  return <div ref={rail} className={`ugs-floating-tools ugs-preview-floating-tools${className ? ` ${className}` : ''}`}
    role="toolbar" aria-label="预览快捷工具" data-file-preview-ignore-outside-pointer="true"
    style={local ? { left: local.x, top: local.y, right: 'auto' } : undefined}>
    <button type="button" title={`${label}（可拖动调整位置）`} aria-label={label} disabled={disabled}
      onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag}
      onKeyDown={moveWithKeys} onClick={(event) => {
        if (suppressClick.current && event.detail !== 0) { suppressClick.current = false; return; }
        suppressClick.current = false;
        if (onOpen) onOpen(); else requestTemporaryChat(source());
      }}><MessageCircleMore size={15} /></button>
  </div>;
}
