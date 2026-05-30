import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import type { FlowNodeData } from '@/canvas/irToFlow';
import { DataIn, DataOut, ExecIn, ExecOut } from './handles';
import { BADGE_BASE_STYLE, runStateVisual } from './runStateStyles';

/**
 * Agent node — an `agent(prompt, opts)` invocation.
 *
 * Pins (matching the IR sample / design doc):
 *   exec in/out (▶), data in (prompt/model/schema ●), data out (result ●).
 *
 * Accent token: `--accent` (agent).
 *
 * Run state: when `data.runState` is present and non-`idle`, the wrapper
 * border + corner badge reflect the live status (running / success / error).
 */
function AgentNodeImpl({ data, selected }: NodeProps) {
  const d = data as FlowNodeData;
  const params = d.params ?? {};
  // Prefer the real `agentType` option; fall back to the legacy `agent` key.
  const agent =
    typeof params.agentType === 'string'
      ? params.agentType
      : typeof params.agent === 'string'
        ? params.agent
        : undefined;
  const model = typeof params.model === 'string' ? params.model : undefined;

  const run = runStateVisual(d.runState);
  // Run state border wins over selection accent so users can see status while
  // a node is still focused.
  const borderColor =
    run?.borderColor ?? (selected ? 'var(--accent)' : 'var(--border)');
  const boxShadow =
    run?.boxShadow ?? (selected ? '0 0 0 1px var(--accent)' : undefined);

  return (
    <div
      className="relative min-w-[170px] rounded-md border bg-panel font-sans shadow-md"
      style={{ borderColor, boxShadow }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2 rounded-t-md px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide"
        style={{ background: 'var(--panel-2)', color: 'var(--accent)' }}
      >
        <span aria-hidden>▶</span>
        <span>Agent</span>
      </div>

      {/* Body */}
      <div className="px-3 py-2">
        <div className="text-sm font-medium text-fg">{d.label}</div>
        {(agent || model) && (
          <div className="mt-1 font-mono text-[10px] text-fg-dim">
            {agent}
            {agent && model ? ' · ' : ''}
            {model}
          </div>
        )}
        <div className="mt-2 flex flex-col gap-1 text-[10px] text-fg-faint">
          <span>● prompt / model / schema</span>
          <span>● result</span>
        </div>
      </div>

      {/* Pins */}
      <ExecIn id="exec_in" top={26} />
      <ExecOut id="exec_out" top={26} />
      <DataIn id="data_in" top={74} />
      <DataOut id="data_out" top={92} />

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

export default memo(AgentNodeImpl);
