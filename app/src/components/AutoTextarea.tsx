import { useLayoutEffect, useRef } from 'react';

/**
 * A textarea that grows to fit its content up to `maxHeight`, then scrolls.
 * Resizes on every value change (typing or switching the bound node), so the
 * node-property prompt boxes no longer stay cramped at a fixed height.
 */
export interface AutoTextareaProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  /** Minimum height in px. */
  minHeight?: number;
  /** Maximum height in px before the textarea starts scrolling. */
  maxHeight?: number;
}

export default function AutoTextarea({
  value,
  onChange,
  placeholder,
  className,
  minHeight = 60,
  maxHeight = 260,
}: AutoTextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const resize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const next = Math.min(Math.max(el.scrollHeight, minHeight), maxHeight);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  };

  // Re-fit whenever the content changes (typing) or the bound value swaps
  // (selecting a different node), and once on mount.
  useLayoutEffect(resize, [value, minHeight, maxHeight]);

  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={1}
      style={{ minHeight, maxHeight, resize: 'none' }}
      className={className}
    />
  );
}
