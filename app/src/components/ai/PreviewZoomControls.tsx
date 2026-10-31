import { Minus, Plus, RotateCcw } from 'lucide-react';
import { MAX_PREVIEW_ZOOM, MIN_PREVIEW_ZOOM } from './lib/previewZoom';

export default function PreviewZoomControls({ zoom, onZoom }: { zoom: number; onZoom: (value: number) => void }) {
  const button = 'flex h-6 w-6 items-center justify-center rounded text-fg-dim hover:bg-panel-2 hover:text-fg disabled:opacity-40';
  return <div className="flex shrink-0 items-center gap-1 text-xs text-fg-dim" title="按住 Ctrl 并滚动鼠标滚轮缩放">
    <button type="button" className={button} aria-label="缩小预览" disabled={zoom <= MIN_PREVIEW_ZOOM} onClick={() => onZoom(zoom / 1.2)}><Minus size={13} /></button>
    <output aria-label="预览缩放比例" className="w-10 text-center tabular-nums">{Math.round(zoom * 100)}%</output>
    <button type="button" className={button} aria-label="放大预览" disabled={zoom >= MAX_PREVIEW_ZOOM} onClick={() => onZoom(zoom * 1.2)}><Plus size={13} /></button>
    <button type="button" className={button} aria-label="重置预览缩放" onClick={() => onZoom(1)}><RotateCcw size={12} /></button>
  </div>;
}
