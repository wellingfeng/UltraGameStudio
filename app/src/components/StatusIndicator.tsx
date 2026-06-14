import type { CSSProperties } from 'react';
import { cn } from '@/lib/cn';

export type StatusTone =
  | 'thinking'
  | 'unrun'
  | 'running'
  | 'waiting'
  | 'success'
  | 'failed';

interface StatusIndicatorProps {
  tone?: StatusTone | null;
  label?: string;
  className?: string;
}

function statusColorStyle(color: string): CSSProperties {
  return { '--fuc-status-color': color } as CSSProperties;
}

const TONE_STYLE: Record<StatusTone, CSSProperties> = {
  thinking: statusColorStyle('var(--status-ai-edit)'),
  unrun: statusColorStyle('var(--status-ai-edit)'),
  running: statusColorStyle('var(--status-success)'),
  waiting: statusColorStyle('var(--status-running)'),
  success: statusColorStyle('var(--status-success)'),
  failed: statusColorStyle('var(--status-error)'),
};

function isSpinningTone(tone: StatusTone): boolean {
  return tone === 'thinking' || tone === 'running';
}

export default function StatusIndicator({
  tone = null,
  label,
  className,
}: StatusIndicatorProps) {
  const active = tone != null;

  return (
    <span
      aria-hidden={!active}
      aria-label={active ? label : undefined}
      className={cn('fuc-status-slot', className)}
      data-status={tone ?? 'none'}
      role={active ? 'img' : undefined}
      title={active ? label : undefined}
    >
      {tone ? (
        <span
          aria-hidden="true"
          className={cn(
            'fuc-status-indicator',
            isSpinningTone(tone) && 'fuc-status-spinner',
          )}
          style={TONE_STYLE[tone]}
        />
      ) : null}
    </span>
  );
}
