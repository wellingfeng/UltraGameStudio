import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Loader2, Check, X, Square } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatDuration } from '@/runtime';
import {
  progressCounts,
  type UltracodeNodeStatus,
  type UltracodeRunProgress,
} from '@/runtime/ultracodeProgress';
import { t, type Locale } from '@/lib/i18n';

/**
 * Live run-progress card for a `/ultracode` run, modeled on Claude Code's
 * `/workflows` card: a collapsed summary row (objective title, "Workflow ·
 * N Agents · elapsed", a thin progress bar) that expands on click into a
 * per-node detail list. Purely presentational — it reads the
 * {@link UltracodeRunProgress} snapshot the store folds from the CLI's progress
 * sentinels, and renders ABOVE the run's human-readable log text (the log is
 * still shown by the caller).
 */
export default function UltracodeRunCard({
  progress,
  locale,
  active,
  onStop,
}: {
  progress: UltracodeRunProgress;
  locale: Locale;
  /** True while the run is in flight (drives the live timer + Stop button). */
  active: boolean;
  onStop?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const counts = useMemo(() => progressCounts(progress), [progress]);

  // Live elapsed clock: tick every second while running; freeze once ended.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);

  const elapsedMs = progress.startedAt
    ? (progress.endedAt ?? (active ? now : progress.startedAt)) - progress.startedAt
    : 0;

  const isError = progress.phase === 'error' || counts.failed > 0;
  const isPlanning = progress.phase === 'planning';
  const title =
    progress.objective.trim() ||
    t(locale, isPlanning ? 'runCard.planning' : 'runCard.title');

  const barColor = isError
    ? 'bg-accent-3'
    : progress.phase === 'complete'
      ? 'bg-accent-2'
      : 'bg-accent';

  return (
    <div className="w-full max-w-[min(760px,100%)] overflow-hidden rounded-lg border border-border bg-panel/95 shadow-sm">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="group flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-panel-2"
        aria-expanded={expanded}
      >
        <span className="shrink-0">
          {active ? (
            <Loader2 size={15} className="animate-spin text-accent" />
          ) : isError ? (
            <X size={15} className="text-accent-3" />
          ) : (
            <Check size={15} className="text-accent-2" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-fg">{title}</span>
          <span className="mt-0.5 flex items-center gap-1.5 font-mono text-[10px] text-fg-faint">
            <span>{t(locale, 'runCard.workflow')}</span>
            <span aria-hidden>·</span>
            <span>
              {progress.agentCalls}
              {progress.maxAgentCalls > 0 ? `/${progress.maxAgentCalls}` : ''}{' '}
              {t(locale, 'runCard.agents')}
            </span>
            <span aria-hidden>·</span>
            <span>{formatDuration(Math.max(0, elapsedMs))}</span>
            {counts.total > 0 && (
              <>
                <span aria-hidden>·</span>
                <span>
                  {counts.completed}/{counts.total}
                </span>
              </>
            )}
          </span>
        </span>
        <ChevronRight
          size={15}
          className={cn(
            'shrink-0 text-fg-faint transition-transform',
            expanded && 'rotate-90',
          )}
        />
      </button>

      {/* Progress bar */}
      <div className="h-1 w-full bg-panel-2">
        <div
          className={cn('h-full transition-all duration-500', barColor)}
          style={{ width: `${Math.min(100, Math.max(active ? 4 : 0, counts.percent))}%` }}
        />
      </div>

      {expanded && (
        <div className="flex flex-col gap-1 border-t border-border bg-bg/40 px-3 py-2">
          {progress.nodes.length === 0 ? (
            <span className="py-1 text-xs text-fg-faint">
              {t(locale, 'runCard.noNodes')}
            </span>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {progress.nodes.map((node) => (
                <li
                  key={node.id}
                  className="flex items-center gap-2 rounded px-1 py-0.5 text-xs text-fg-dim"
                >
                  <NodeStatusIcon status={node.status} />
                  <span className="min-w-0 flex-1 truncate" title={node.label}>
                    {node.label}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {active && onStop && (
            <div className="mt-1.5 flex justify-end border-t border-border pt-1.5">
              <button
                type="button"
                onClick={onStop}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-panel-2 px-2.5 py-1 text-xs text-fg-dim transition-colors hover:border-accent-3/60 hover:text-accent-3"
              >
                <Square size={11} strokeWidth={2.4} />
                {t(locale, 'runCard.stop')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function NodeStatusIcon({ status }: { status: UltracodeNodeStatus }) {
  if (status === 'success') return <Check size={13} className="shrink-0 text-accent-2" />;
  if (status === 'error') return <X size={13} className="shrink-0 text-accent-3" />;
  if (status === 'interrupted')
    return <Square size={11} className="shrink-0 text-fg-faint" strokeWidth={2.4} />;
  return <Loader2 size={13} className="shrink-0 animate-spin text-accent" />;
}
