import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

/** Scroll only titles clipped by the current session row width. */
export default function SessionTitle({ title }: { title: string }) {
  const viewportRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const text = textRef.current;
    if (!viewport || !text) return;
    let disposed = false;
    const measure = () => {
      if (!disposed) setOverflow(Math.max(0, text.scrollWidth - viewport.clientWidth));
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(viewport);
    observer?.observe(text);
    window.addEventListener('resize', measure);
    void document.fonts?.ready.then(measure);
    return () => {
      disposed = true;
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [title]);

  return (
    <span
      ref={viewportRef}
      title={title}
      className="ugs-session-title min-w-0 flex-1 text-[13px] leading-5 text-inherit"
      data-overflow={overflow > 0 ? 'true' : 'false'}
      style={{
        '--ugs-title-scroll-distance': `${-overflow}px`,
        '--ugs-title-scroll-duration': '2s',
      } as CSSProperties}
    >
      <span ref={textRef} className="ugs-session-title-text">{title}</span>
    </span>
  );
}
