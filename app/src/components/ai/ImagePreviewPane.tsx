import { useEffect, useRef, useState } from 'react';

const INITIAL_VIEW = { scale: 1, x: 0, y: 0 };

export default function ImagePreviewPane({ src, alt }: { src: string; alt: string }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: number; x: number; y: number } | null>(null);
  const [view, setView] = useState(INITIAL_VIEW);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    setView(INITIAL_VIEW);
    dragRef.current = null;
    setDragging(false);
  }, [src]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = viewport.getBoundingClientRect();
      const x = event.clientX - bounds.left - bounds.width / 2;
      const y = event.clientY - bounds.top - bounds.height / 2;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1);
      setView((previous) => {
        const scale = Math.min(16, Math.max(0.1, previous.scale * Math.exp(-delta * 0.002)));
        const ratio = scale / previous.scale;
        return { scale, x: x - (x - previous.x) * ratio, y: y - (y - previous.y) * ratio };
      });
    };
    // React delegates wheel events passively; a native listener can prevent page scrolling.
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg">
      <div className="flex shrink-0 items-center gap-3 border-b border-border-soft px-3 py-1.5 text-[11px] text-fg-faint">
        <span>滚轮缩放 · 按住左键拖动</span>
        <output aria-label="图片缩放比例" className="ml-auto tabular-nums">{Math.round(view.scale * 100)}%</output>
        <button
          type="button"
          className="rounded px-2 py-1 hover:bg-border-soft hover:text-fg"
          onClick={() => setView(INITIAL_VIEW)}
          title="恢复初始大小和位置"
        >复位</button>
      </div>
      <div
        ref={viewportRef}
        className="ai-image-preview-viewport relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
        style={{ cursor: dragging ? 'grabbing' : 'grab', touchAction: 'none', userSelect: 'none' }}
        onContextMenu={(event) => event.preventDefault()}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.id !== event.pointerId) return;
          const dx = event.clientX - drag.x;
          const dy = event.clientY - drag.y;
          dragRef.current = { id: drag.id, x: event.clientX, y: event.clientY };
          setView((previous) => ({ ...previous, x: previous.x + dx, y: previous.y + dy }));
        }}
        onPointerUp={(event) => {
          if (dragRef.current?.id !== event.pointerId) return;
          dragRef.current = null;
          setDragging(false);
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onPointerCancel={() => { dragRef.current = null; setDragging(false); }}
        onLostPointerCapture={() => { dragRef.current = null; setDragging(false); }}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          className="ai-file-preview-image block shrink-0 object-contain"
          style={{
            maxWidth: 'calc(100% - 32px)',
            maxHeight: 'calc(100% - 32px)',
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            transformOrigin: 'center',
          }}
        />
      </div>
    </div>
  );
}
