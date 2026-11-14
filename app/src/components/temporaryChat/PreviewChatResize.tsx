import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { loadPaneWidth, savePaneWidth } from '@/lib/composerStorage';

const PREVIEW_CHAT_WIDTH_EVENT = 'ugs:preview-chat-width';

export function usePreviewChatWidth() {
  const [width, setWidth] = useState(() => loadPaneWidth(PREVIEW_CHAT_WIDTH_KEY));
  useEffect(() => {
    const onWidth = (event: Event) => setWidth((event as CustomEvent<number>).detail);
    window.addEventListener(PREVIEW_CHAT_WIDTH_EVENT, onWidth);
    return () => window.removeEventListener(PREVIEW_CHAT_WIDTH_EVENT, onWidth);
  }, []);
  const resize = (next: number) => {
    setWidth(next);
    window.dispatchEvent(new CustomEvent(PREVIEW_CHAT_WIDTH_EVENT, { detail: next }));
  };
  return { width, resize };
}

const PREVIEW_CHAT_WIDTH_KEY = 'ultragamestudio.previewChatWidth.v1';

export function PreviewChatResizeHandle({ onResize }: { onResize: (width: number) => void }) {
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number; width: number; moved: boolean } | null>(null);

  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    if (drag.current.moved) savePaneWidth(PREVIEW_CHAT_WIDTH_KEY, drag.current.width);
    drag.current = null;
  };

  return <div className="ugs-preview-chat-resize" role="separator" aria-orientation="vertical"
    aria-label="拖动调整随手聊宽度" title="拖动调整随手聊宽度"
    onPointerDown={(event) => {
      if (event.button !== 0 || event.isPrimary === false) return;
      const width = event.currentTarget.parentElement?.getBoundingClientRect().width ?? 0;
      if (!width) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width, width, moved: false };
    }}
    onPointerMove={(event) => {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId || (!current.moved && event.clientX === current.startX)) return;
      const containerWidth = event.currentTarget.parentElement?.parentElement?.getBoundingClientRect().width ?? 0;
      if (!containerWidth) return;
      const max = containerWidth - Math.min(200, containerWidth / 2);
      const min = Math.min(240, containerWidth * 0.42, max);
      current.width = Math.min(max, Math.max(min, current.startWidth + current.startX - event.clientX));
      current.moved = true;
      onResize(current.width);
    }}
    onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish} />;
}
