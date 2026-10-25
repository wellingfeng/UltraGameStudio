import { useEffect, useRef, useState } from 'react';
import type { Locale } from '@/lib/i18n';
import type { SkillMutationResult, SkillOrigin, SkillReviewState } from '@/runtime/skills/types';
import { localizeSkillReviewText } from './lib/skillReviewText';
import { isSkillReviewVisible } from './lib/skillReviewVisibility';

export interface SkillLearningCardProps {
  state: SkillReviewState;
  locale?: Locale;
  onApprove?: (batchId: string) => Promise<SkillMutationResult>;
  onReject?: (batchId: string) => Promise<SkillMutationResult>;
  onRollback?: (rollbackId: string) => Promise<SkillMutationResult>;
  /** Re-read and propose again; never approve a stale/conflicted batch directly. */
  onRetry?: (batchId: string) => Promise<SkillMutationResult | void>;
}

const labels: Record<SkillReviewState['status'], [string, string]> = {
  queued: ['排队等待复盘', 'Queued for review'],
  reading: ['正在读取技能', 'Reading skills'],
  proposing: ['正在提炼经验', 'Extracting lessons'],
  applying: ['正在应用修改', 'Applying changes'],
  applied: ['已学会', 'Learned'],
  awaiting_approval: ['待批准', 'Awaiting approval'],
  noop: ['无新经验', 'No new lesson'],
  conflicted: ['版本冲突', 'Version conflict'],
  failed: ['学习失败', 'Learning failed'],
  needs_recovery: ['需要恢复', 'Recovery required'],
  cancelled: ['已取消', 'Cancelled'],
  rejected: ['已拒绝', 'Rejected'],
};

const actionClass = 'min-h-11 rounded-md border border-border bg-panel px-3 py-1.5 text-xs text-fg-dim outline-none transition-colors hover:border-accent hover:text-fg focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50';

function sameOrigin(left: SkillOrigin, right: SkillOrigin): boolean {
  return (['hostId', 'workspaceId', 'sessionId', 'turnId', 'runId', 'cwd'] as const).every((key) => left[key] === right[key]);
}

export default function SkillLearningCard(props: SkillLearningCardProps) {
  if (!isSkillReviewVisible(props.state)) return null;
  const origin = props.state.origin;
  const identity = JSON.stringify([origin.hostId, origin.workspaceId, origin.sessionId, origin.turnId, origin.runId, origin.cwd, props.state.result?.batchId]);
  return <SkillLearningCardContent key={identity} {...props} />;
}

function SkillLearningCardContent({ state, locale = 'zh-CN', onApprove, onReject, onRollback, onRetry }: SkillLearningCardProps) {
  const zh = locale === 'zh-CN';
  const [resolved, setResolved] = useState<SkillMutationResult>();
  const [busy, setBusy] = useState<'approve' | 'reject' | 'rollback' | 'retry' | null>(null);
  const [rolledBack, setRolledBack] = useState(state.action === 'rollback');
  const [actionError, setActionError] = useState('');
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const generation = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    generation.current += 1;
    setResolved(undefined);
    setBusy(null);
    setRolledBack(state.action === 'rollback');
    setActionError('');
  }, [state.result, state.status, state.action, state.error]);
  const candidate = resolved ?? state.result;
  const originMismatch = candidate !== undefined && !sameOrigin(candidate.origin, state.origin);
  const result = originMismatch ? undefined : candidate;
  const phase = ['queued', 'reading', 'proposing', 'applying'].includes(state.status);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!phase) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [phase]);
  const status = busy ? 'applying' : resolved?.status ?? state.status;
  const disabled = busy !== null || (!resolved && phase);
  const pendingVisible = status === 'awaiting_approval' || busy === 'approve' || busy === 'reject' || (!resolved && phase);
  const provedApplied = status === 'applied' && result?.status === 'applied' && result.operationsApplied > 0;
  const label = busy === 'rollback' ? (zh ? '正在撤销修改' : 'Rolling back changes')
    : busy === 'retry' ? (zh ? '正在重新复盘' : 'Reviewing again')
    : rolledBack && provedApplied ? (zh ? '已撤销' : 'Reverted')
    : busy === 'reject' ? (zh ? '正在拒绝修改' : 'Rejecting changes')
    : status === 'applied' && !provedApplied ? (zh ? '未确认应用' : 'Application unconfirmed') : labels[status][zh ? 0 : 1];
  const error = originMismatch ? (zh ? '结果来源不匹配，未更新此卡片' : 'Result origin mismatch; this card was not updated')
    : actionError || result?.error || state.error;
  const budgetFailure = (status === 'cancelled' || status === 'failed') && /SKILL_REVIEW_BUDGET_(?:TOKENS|TIME|ROUNDS)/.test(error ?? '');
  const runAction = async (action: 'approve' | 'reject' | 'rollback' | 'retry') => {
    const handler = action === 'approve' ? onApprove : action === 'reject' ? onReject : action === 'retry' ? onRetry : onRollback;
    if (!handler || !result || inFlight.current) return;
    const id = action === 'rollback' ? result.rollbackId : result.batchId;
    if (!id) return;
    inFlight.current = true;
    setBusy(action);
    setActionError('');
    const startedGeneration = generation.current;
    try {
      const next = await handler(id);
      if (!mounted.current || generation.current !== startedGeneration) return;
      if (!next && action === 'retry') return;
      if (!next) throw new Error('SKILL_MUTATION_UNCONFIRMED');
      if (!sameOrigin(next.origin, result.origin)
        || ((action === 'approve' || action === 'reject') && next.batchId !== result.batchId)) {
        throw new Error(zh ? '结果来源不匹配，未更新此卡片' : 'Result origin mismatch; this card was not updated');
      }
      setResolved(next);
      setRolledBack(action === 'rollback' && next.status === 'applied' && next.operationsApplied > 0);
    } catch (cause) {
      if (mounted.current && generation.current === startedGeneration) {
        setActionError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(null);
    }
  };
  if (status === 'noop') return null;
  return (
    <article className="min-w-0 space-y-2 rounded-lg border border-border bg-panel p-3 text-xs text-fg">
      <p role="status" className="font-semibold">{budgetFailure ? (zh ? '复盘失败' : 'Review failed') : label}</p>
      {phase && state.detail && <p className="text-fg-dim">{state.detail}</p>}
      {phase && state.queuedAt !== undefined && <p className="text-fg-faint tabular-nums">
        {zh ? '已等待' : 'Elapsed'} {Math.max(0, Math.floor((now - state.queuedAt) / 1000))} {zh ? '秒' : 's'}
      </p>}
      {result && <p className="whitespace-pre-wrap break-words leading-relaxed">{localizeSkillReviewText(result.lesson, zh)}</p>}
      <p className="break-words text-[11px] text-fg-faint">{state.origin.workspaceId}</p>
      {result?.revision && <p className="break-all font-mono text-[11px] text-fg-faint">{result.revision}</p>}
      {result?.usage && (
        <p className="break-words text-[11px] tabular-nums text-fg-faint">
          {zh ? '复盘用量' : 'Review usage'} · {result.usage.estimated ? (zh ? '估算' : 'Estimated') : (zh ? '实测' : 'Measured')}
          {' · '}{result.usage.inputTokens === undefined ? (zh ? '输入未知' : 'Input unknown') : `${zh ? '输入' : 'Input'} ${result.usage.inputTokens}`}
          {' · '}{result.usage.outputTokens === undefined ? (zh ? '输出未知' : 'Output unknown') : `${zh ? '输出' : 'Output'} ${result.usage.outputTokens}`}
          {' · '}{result.usage.calls} {zh ? '次模型调用' : 'model calls'}
        </p>
      )}
      {error && <p role="alert" className="whitespace-pre-wrap break-words text-status-error">{localizeSkillReviewText(error, zh)}</p>}
      {result && result.riskReasons.length > 0 && (
        <ul className="space-y-1 text-fg-dim">
          {result.riskReasons.map((reason, index) => <li key={index} className="break-words">{localizeSkillReviewText(reason, zh)}</li>)}
        </ul>
      )}
      {result && result.changes.length > 0 && (
        <details className="min-w-0 rounded-md border border-border">
          <summary className="cursor-pointer rounded-md px-2 py-2 text-fg-dim outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent">
            {zh ? '查看 diff' : 'View diff'} · {result.changes.length}
          </summary>
          <div className="min-w-0 space-y-3 border-t border-border p-2">
            {result.changes.map((change, index) => (
              <section key={`${change.skillId}:${change.filePath}:${index}`} className="min-w-0 space-y-1.5">
                <h4 className="break-all font-mono text-[11px] text-fg">{change.name} / {change.filePath}</h4>
                <p className="break-all font-mono text-[10px] text-fg-faint">
                  {change.beforeHash ?? '∅'} → {change.afterHash ?? '∅'}
                </p>
                <div role="region" aria-label={`${change.name} / ${change.filePath} diff`} tabIndex={0}
                  className="min-w-0 max-w-full overflow-x-auto rounded border border-border bg-bg outline-none focus-visible:ring-2 focus-visible:ring-accent">
                  <div className="w-max min-w-full p-2">
                    <p className="mb-1 text-[10px] text-fg-faint">{zh ? '修改前' : 'Before'}</p>
                    <pre className="whitespace-pre font-mono text-[11px] leading-relaxed text-fg-dim">{change.before ?? (zh ? '（文件不存在）' : '(File absent)')}</pre>
                    <p className="mb-1 mt-3 text-[10px] text-fg-faint">{zh ? '修改后' : 'After'}</p>
                    <pre className="whitespace-pre font-mono text-[11px] leading-relaxed text-fg">{change.after ?? (zh ? '（移除文件）' : '(File removed)')}</pre>
                  </div>
                </div>
              </section>
            ))}
          </div>
        </details>
      )}
      {pendingVisible && result?.status === 'awaiting_approval' && onApprove && (
        <button type="button" aria-label={zh ? '批准修改' : 'Approve changes'} disabled={disabled}
          className={actionClass} onClick={() => void runAction('approve')}>
          {zh ? '批准修改' : 'Approve changes'}
        </button>
      )}
      {pendingVisible && result?.status === 'awaiting_approval' && onReject && (
        <button type="button" aria-label={zh ? '拒绝修改' : 'Reject changes'} disabled={disabled}
          className={actionClass} onClick={() => void runAction('reject')}>
          {zh ? '拒绝修改' : 'Reject changes'}
        </button>
      )}
      {((provedApplied && !rolledBack) || status === 'needs_recovery') && result?.rollbackId && onRollback && (
        <button type="button" aria-label={status === 'needs_recovery' ? (zh ? '恢复原版本' : 'Recover original version') : (zh ? '撤销修改' : 'Roll back changes')} disabled={disabled}
          className={actionClass} onClick={() => void runAction('rollback')}>
          {status === 'needs_recovery' ? (zh ? '恢复原版本' : 'Recover original version') : (zh ? '撤销修改' : 'Roll back changes')}
        </button>
      )}
      {result && (status === 'conflicted' || status === 'failed' || status === 'cancelled' || busy === 'retry') && onRetry && (
        <button type="button" aria-label={zh ? '重新复盘' : 'Retry review'} disabled={disabled}
          className={actionClass} onClick={() => void runAction('retry')}>
          {zh ? '重新复盘' : 'Retry review'}
        </button>
      )}
    </article>
  );
}
