import { useStore } from '@/store/useStore';
import { t, type Locale } from '@/lib/i18n';
import type { TaskLedger, TaskLedgerEntry } from '@/core/ir';

/**
 * CONTRACT: default export, no props. Read-only captain-loop task ledger view.
 *
 * Surfaces `store.workflow.meta.run.taskLedger` — the structured, recoverable
 * record of subtasks, their acceptance status, evidence and gaps that a
 * captain-loop run produces. Renders one card per task plus a header showing the
 * rework round and the current accepted anchor. Pure display, no interaction.
 *
 * PromptPanel mounts this as its third state (after NodeInspector and the prompt
 * library) and only when a ledger exists, so this component assumes a ledger is
 * present — callers must guard.
 */

/** Tailwind classes per acceptance status (accepted green / rejected red / …). */
const STATUS_STYLE: Record<TaskLedgerEntry['status'], string> = {
  accepted: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  rejected: 'bg-red-500/15 text-red-400 border-red-500/30',
  blocked: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  running: 'bg-accent/15 text-accent border-accent/30',
  pending: 'bg-border-soft text-fg-faint border-border',
};

function StatusBadge({ status }: { status: TaskLedgerEntry['status'] }) {
  return (
    <span
      className={`inline-block shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_STYLE[status]}`}
    >
      {status}
    </span>
  );
}

function Field({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="mt-1.5 text-[11px] leading-relaxed">
      <span className="text-fg-faint">{label}：</span>
      <span className="text-fg-dim">{value}</span>
    </div>
  );
}

function TaskCard({ task, locale }: { task: TaskLedgerEntry; locale: Locale }) {
  return (
    <div className="rounded-md border border-border bg-panel-2 p-2.5">
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-medium text-fg">{task.title}</span>
        <StatusBadge status={task.status} />
      </div>
      <Field label={t(locale, 'taskLedger.owner')} value={task.owner} />
      <Field label={t(locale, 'taskLedger.acceptance')} value={task.acceptance} />
      <Field label={t(locale, 'taskLedger.evidence')} value={task.evidence} />
      <Field label={t(locale, 'taskLedger.artifact')} value={task.artifact} />
      {task.gaps && task.gaps.length > 0 && (
        <div className="mt-1.5">
          <span className="text-[11px] text-fg-faint">
            {t(locale, 'taskLedger.gaps')}：
          </span>
          <ul className="mt-0.5 list-disc pl-4 text-[11px] leading-relaxed text-red-400">
            {task.gaps.map((g, i) => (
              <li key={i}>{g}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function TaskLedgerPanel({ ledger }: { ledger: TaskLedger }) {
  const locale = useStore((s) => s.locale);
  const accepted = ledger.tasks.filter((x) => x.status === 'accepted').length;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="rounded-md border border-border-soft bg-panel-2 px-2.5 py-2 text-[11px] text-fg-dim">
        <div className="flex items-center justify-between">
          <span>
            {t(locale, 'taskLedger.round')} {ledger.round ?? 1}
          </span>
          <span>
            {accepted}/{ledger.tasks.length} {t(locale, 'taskLedger.accepted')}
          </span>
        </div>
        {ledger.anchor && (
          <div className="mt-1 truncate text-fg-faint" title={ledger.anchor}>
            {t(locale, 'taskLedger.anchor')}：{ledger.anchor}
          </div>
        )}
      </div>
      {ledger.tasks.length === 0 ? (
        <div className="px-2 py-6 text-center text-xs text-fg-faint">
          {t(locale, 'taskLedger.empty')}
        </div>
      ) : (
        ledger.tasks.map((task) => (
          <TaskCard key={task.id} task={task} locale={locale} />
        ))
      )}
    </div>
  );
}
