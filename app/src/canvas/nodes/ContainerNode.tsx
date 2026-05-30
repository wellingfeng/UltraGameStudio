import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import type { FlowNodeData } from '@/canvas/irToFlow';
import { ExecIn, ExecOut } from './handles';
import { runStateVisual } from './runStateStyles';

/**
 * Container node — a `branch` (`if`) or `loop` (`while`) that wraps child nodes.
 *
 * Rendered as a titled frame sized by {@link irToFlow}; child nodes are
 * separate React Flow nodes parented into this box, so the body is intentionally
 * transparent. Exec in/out pins sit on the header row.
 *
 * Accent token: `--accent-3` (control flow).
 */
function ContainerNodeImpl({ data, selected }: NodeProps) {
  const d = data as FlowNodeData;
  const params = d.params ?? {};
  const isLoop = d.irType === 'loop';
  const keyword = isLoop ? 'while' : 'if';
  const condition = String(params.condition ?? (isLoop ? 'false' : 'true'));

  const run = runStateVisual(d.runState);
  const borderColor =
    run?.borderColor ?? (selected ? 'var(--accent-3)' : 'var(--border)');
  const boxShadow =
    run?.boxShadow ?? (selected ? '0 0 0 1px var(--accent-3)' : undefined);

  return (
    <div
      className="relative h-full w-full rounded-md border bg-panel/40 font-sans"
      style={{ borderColor, boxShadow, borderStyle: 'dashed' }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2 rounded-t-md px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide"
        style={{ background: 'var(--panel-2)', color: 'var(--accent-3)' }}
      >
        <span aria-hidden>{isLoop ? '↻' : '⋔'}</span>
        <span>{d.label || (isLoop ? 'Loop' : 'Branch')}</span>
        <span className="ml-auto truncate font-mono text-[10px] normal-case text-fg-faint">
          {keyword} ({condition})
        </span>
      </div>

      {/* Pins on the header row. */}
      <ExecIn id="exec_in" top={18} />
      <ExecOut id="exec_out" top={18} />
    </div>
  );
}

export default memo(ContainerNodeImpl);
