import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import type { IRAgentSpec } from '@/core/ir';
import type { FlowNodeData } from '@/canvas/irToFlow';
import { DataIn, DataOut, ExecIn, ExecOut } from './handles';
import { BADGE_BASE_STYLE, runStateVisual } from './runStateStyles';

/**
 * Parallel node — a `parallel(items.map(...))` fan-out / fan-in.
 *
 * Pins: exec in/out (▶), data in (over[] ●), data out (results[] ●).
 *
 * Accent token: `--accent-2` (parallel).
 *
 * Run state: see {@link runStateVisual} for the status palette.
 */
function ParallelNodeImpl({ data, selected }: NodeProps) {
  const d = data as FlowNodeData;
  const params = d.params ?? {};
  // Branches are structured specs; tolerate the legacy `string[]` form too.
  const branches: string[] = Array.isArray(params.branches)
    ? (params.branches as (string | IRAgentSpec)[]).map((b) =>
        typeof b === 'string' ? b : b.label || b.agentType || b.prompt || 'branch',
      )
    : [];

  const run = runStateVisual(d.runState);
  const borderColor =
    run?.borderColor ?? (selected ? 'var(--accent-2)' : 'var(--border)');
  const boxShadow =
    run?.boxShadow ?? (selected ? '0 0 0 1px var(--accent-2)' : undefined);

  return (
    <div
      className="relative min-w-[180px] rounded-md border bg-panel font-sans shadow-md"
      style={{ borderColor, boxShadow }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2 rounded-t-md px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide"
        style={{ background: 'var(--panel-2)', color: 'var(--accent-2)' }}
      >
        <span aria-hidden>⇶</span>
        <span>Parallel</span>
      </div>

      {/* Body */}
      <div className="px-3 py-2">
        <div className="text-sm font-medium text-fg">{d.label}</div>
        {branches.length > 0 ? (
          <div className="mt-1.5 flex flex-col gap-1">
            {branches.map((b, i) => (
              <div
                key={i}
                className="rounded border px-2 py-0.5 font-mono text-[10px] text-fg-dim"
                style={{ borderColor: 'var(--border-soft)', background: 'var(--bg-alt)' }}
              >
                {b}
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-1 font-mono text-[10px] text-fg-faint">over[] → results[]</div>
        )}
      </div>

      {/* Pins */}
      <ExecIn id="exec_in" top={26} />
      <ExecOut id="exec_out" top={26} />
      <DataIn id="data_in" top={62} />
      <DataOut id="data_out" top={62} />

      {/* Run-state corner badge */}
      {run && (
        <div
          aria-label={`run-state-${d.runState}`}
          style={{ ...BADGE_BASE_STYLE, ...run.badgeStyle }}
        >
          {run.badge}
        </div>
      )}
    </div>
  );
}

export default memo(ParallelNodeImpl);
