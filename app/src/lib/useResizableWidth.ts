import { useCallback, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { loadPaneWidth, savePaneWidth } from './composerStorage';

/**
 * Drag-to-resize width for a side panel, mirroring AIDock's vertical resize.
 *
 *   edge: 'right' → handle on the element's RIGHT edge (left Sidebar): dragging
 *                   right grows it.
 *   edge: 'left'  → handle on the LEFT edge (right PromptPanel): dragging left
 *                   grows it.
 *
 * Width is clamped to [min, max], restored from / persisted to localStorage.
 */
export interface ResizableWidth {
  width: number;
  onResizeStart: (e: ReactMouseEvent) => void;
}

export function useResizableWidth(opts: {
  storageKey: string;
  defaultWidth: number;
  min: number;
  max: number;
  edge: 'left' | 'right';
}): ResizableWidth {
  const { storageKey, defaultWidth, min, max, edge } = opts;
  const [width, setWidth] = useState<number>(
    () => loadPaneWidth(storageKey) ?? defaultWidth,
  );

  const onResizeStart = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = width;
      const prevUserSelect = document.body.style.userSelect;
      const prevCursor = document.body.style.cursor;
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';

      const clamp = (w: number) => Math.min(Math.max(w, min), max);
      const onMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startX;
        setWidth(clamp(edge === 'right' ? startWidth + delta : startWidth - delta));
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.style.userSelect = prevUserSelect;
        document.body.style.cursor = prevCursor;
        setWidth((w) => {
          savePaneWidth(storageKey, w);
          return w;
        });
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [width, edge, min, max, storageKey],
  );

  return { width, onResizeStart };
}
