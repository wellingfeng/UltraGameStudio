import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import type { FlowNodeData } from '@/canvas/irToFlow';
import { ExecIn, ExecOut } from './handles';
import { BADGE_BASE_STYLE, runStateVisual } from './runStateStyles';

/**
 * Control node — the `start` / `end` flow terminals.
 *
 * Pins:
 *   - start: exec out (▶) only — the script entry point.
 *   - end:   exec in (▶) only — the `return`.
 *
 * Accent tokens: `--accent-3` (start), `--accent-4` (end).
 */
function ControlNodeImpl({ data, selected }: NodeProps) {
  const d = data as FlowNodeData;
  const isStart = d.irType === 'start';
  const accent = isStart ? 'var(--accent-3)' : 'var(--accent-4)';
  const glyph = isStart ? '⏵' : '⏹';

  const run = runStateVisual(d.runState);
  const borderColor =
    run?.borderColor ?? (selected ? accent : 'var(--border)');
  const boxShadow = run?.boxShadow ?? (selected ? `0 0 0 1px ${accent}` : undefined);

  return (
    <div
      className="relative flex min-w-[110px] items-center gap-2 rounded-full border bg-panel px-4 py-2 font-sans shadow-md"
      style={{ borderColor, boxShadow }}
    >
      <span
        className="text-sm font-semibold"
        style={{ color: accent }}
        aria-hidden
      >
        {glyph}
      </span>
      <span className="text-sm font-medium" style={{ color: accent }}>
        {d.label ?? (isStart ? 'Start' : 'End')}
      </span>

      {/* Pins: start exposes exec_out only; end exposes exec_in only. */}
      {isStart ? <ExecOut id="exec_out" /> : <ExecIn id="exec_in" />}

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

export default memo(ControlNodeImpl);
