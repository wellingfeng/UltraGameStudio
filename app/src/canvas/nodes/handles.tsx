import { Handle, Position } from '@xyflow/react';
import type { CSSProperties } from 'react';

/**
 * Shared handle primitives for the blueprint nodes.
 *
 * Two pin kinds, matching the IR / design doc:
 *   - exec (▶): execution flow — rendered as a triangle.
 *   - data (●): data flow — rendered as a circle.
 *
 * Handle ids follow the IR port convention (`exec_in`, `exec_out`,
 * `data_in`, `data_out`) so edges from {@link irToFlow} attach correctly.
 */

const EXEC_COLOR = 'var(--fg)';
const DATA_COLOR = 'var(--accent-2)';

/** Triangle (exec) styling — a right-pointing ▶ drawn with a CSS border trick. */
const execStyle: CSSProperties = {
  width: 0,
  height: 0,
  background: 'transparent',
  border: 'none',
  borderTop: '6px solid transparent',
  borderBottom: '6px solid transparent',
  borderLeft: `9px solid ${EXEC_COLOR}`,
  borderRadius: 0,
};

/** Circle (data) styling — a filled dot. */
const dataStyle: CSSProperties = {
  width: 10,
  height: 10,
  minWidth: 10,
  minHeight: 10,
  background: DATA_COLOR,
  border: 'none',
  borderRadius: '50%',
};

export interface PinProps {
  /** React Flow handle id; must match the IR port id. */
  id: string;
  /** Vertical offset (px) from the top of the node for stacked pins. */
  top?: number;
}

/** Execution input pin (left edge, triangle). */
export function ExecIn({ id, top }: PinProps) {
  return (
    <Handle
      type="target"
      position={Position.Left}
      id={id}
      style={{ ...execStyle, top, left: -5 }}
    />
  );
}

/** Execution output pin (right edge, triangle). */
export function ExecOut({ id, top }: PinProps) {
  return (
    <Handle
      type="source"
      position={Position.Right}
      id={id}
      style={{ ...execStyle, top, right: -5 }}
    />
  );
}

/** Data input pin (left edge, circle). */
export function DataIn({ id, top }: PinProps) {
  return (
    <Handle
      type="target"
      position={Position.Left}
      id={id}
      style={{ ...dataStyle, top, left: -5 }}
    />
  );
}

/** Data output pin (right edge, circle). */
export function DataOut({ id, top }: PinProps) {
  return (
    <Handle
      type="source"
      position={Position.Right}
      id={id}
      style={{ ...dataStyle, top, right: -5 }}
    />
  );
}
