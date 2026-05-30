import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import type { IRAgentSpec } from '@/core/ir';
import type { FlowNodeData } from '@/canvas/irToFlow';
import { DataIn, DataOut, ExecIn, ExecOut } from './handles';
import { BADGE_BASE_STYLE, runStateVisual } from './runStateStyles';

/**
 * Pipeline node — a `pipeline(items, stage1, stage2, …)` run.
 *
 * Shows the input expression and one row per stage callback.
 * Accent token: `--accent-2`.
 */
function PipelineNodeImpl({ data, selected }: NodeProps) {
  const d = data as FlowNodeData;
  const params = d.params ?? {};
  const items = typeof params.items === 'string' ? params.items : 'args';
  const stages: IRAgentSpec[] = Array.isArray(params.stages)
    ? (params.stages as IRAgentSpec[])
    : [];

  const run = runStateVisual(d.runState);
  const borderColor =
    run?.borderColor ?? (selected ? 'var(--accent-2)' : 'var(--border)');
  const boxShadow =
    run?.boxShadow ?? (selected ? '0 0 0 1px var(--accent-2)' : undefined);

  return (
    <div
      className="relative min-w-[200px] rounded-md border bg-panel font-sans shadow-md"
      style={{ borderColor, boxShadow }}
    >
      <div
        className="flex items-center gap-2 rounded-t-md px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide"
        style={{ background: 'var(--panel-2)', color: 'var(--accent-2)' }}
      >
        <span aria-hidden>⛓</span>
        <span>Pipeline</span>
      </div>

      <div className="px-3 py-2">
        <div className="text-sm font-medium text-fg">{d.label}</div>
        <div className="mt-1 font-mono text-[10px] text-fg-faint">over {items}</div>
        {stages.length > 0 ? (
          <div className="mt-1.5 flex flex-col gap-1">
            {stages.map((s, i) => (
              <div
                key={i}
                className="rounded border px-2 py-0.5 font-mono text-[10px] text-fg-dim"
                style={{ borderColor: 'var(--border-soft)', background: 'var(--bg-alt)' }}
              >
                {i + 1}. {(s.label ?? s.prompt ?? 'stage').slice(0, 28)}
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-1 font-mono text-[10px] text-fg-faint">no stages</div>
        )}
      </div>

      <ExecIn id="exec_in" top={26} />
      <ExecOut id="exec_out" top={26} />
      <DataIn id="data_in" top={62} />
      <DataOut id="data_out" top={62} />

      {run && (
        <div aria-label={`run-state-${d.runState}`} style={{ ...BADGE_BASE_STYLE, ...run.badgeStyle }}>
          {run.badge}
        </div>
      )}
    </div>
  );
}

export default memo(PipelineNodeImpl);
