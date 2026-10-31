import { useEffect, useRef, useState } from 'react';
import type { Locale } from '@/lib/i18n';
import type { SkillMutationResult, SkillOrigin, SkillReviewState } from '@/runtime/skills/types';
import { localizeSkillReviewText } from './lib/skillReviewText';
import { isSkillReviewVisible } from './lib/skillReviewVisibility';
import { presentSkillReview, skillReviewDiffLines } from './lib/reviewPresentation';
import ReviewStrip from './ReviewStrip';
import './SkillLearningCard.css';

export interface SkillLearningCardProps {
  state: SkillReviewState;
  /** Both surfaces show real progress and terminal diagnostics, not only writes. */
  surface?: 'chat' | 'history';
  locale?: Locale;
  onApprove?: (batchId: string) => Promise<SkillMutationResult>;
  onReject?: (batchId: string) => Promise<SkillMutationResult>;
  onRollback?: (rollbackId: string) => Promise<SkillMutationResult>;
  /** Re-read and propose again; never approve a stale/conflicted batch directly. */
  onRetry?: (batchId: string) => Promise<SkillMutationResult | void>;
  /** Restart only a captured source state; no result/batch is needed for a saved queued job. */
  onRetryState?: (state: SkillReviewState) => Promise<SkillMutationResult | void>;
}


const actionClass = 'min-h-11 rounded-md border border-border bg-panel px-3 py-1.5 text-xs text-fg-dim outline-none transition-colors hover:border-accent hover:text-fg focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50';

function sameOrigin(left: SkillOrigin, right: SkillOrigin): boolean {
  return (['hostId', 'workspaceId', 'sessionId', 'turnId', 'runId', 'cwd'] as const).every((key) => left[key] === right[key]);
}

export default function SkillLearningCard(props: SkillLearningCardProps) {
  if (!isSkillReviewVisible(props.state, props.surface)) return null;
  const origin = props.state.origin;
  const identity = JSON.stringify([origin.hostId, origin.workspaceId, origin.sessionId, origin.turnId, origin.runId, origin.cwd, props.state.result?.batchId]);
  return <SkillLearningCardContent key={identity} {...props} />;
}

function SkillLearningCardContent({ state, surface = 'chat', locale = 'zh-CN', onApprove, onReject, onRollback, onRetry, onRetryState }: SkillLearningCardProps) {
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
  const admission = status === 'noop' && state.admission?.status === 'not-admitted' ? state.admission : undefined;
  const disabled = busy !== null || (!resolved && phase);
  const pendingVisible = status === 'awaiting_approval' || busy === 'approve' || busy === 'reject' || (!resolved && phase);
  const provedApplied = status === 'applied' && result?.status === 'applied' && result.operationsApplied > 0;
  const presentation = presentSkillReview({ ...state, status, result, action: rolledBack ? 'rollback' : state.action }, zh);
  const label = busy === 'rollback' ? (zh ? '正在撤销修改' : 'Rolling back changes')
    : busy === 'retry' ? (zh ? '正在重新复盘' : 'Reviewing again')
    : rolledBack && provedApplied ? (zh ? '已撤销' : 'Reverted')
    : busy === 'reject' ? (zh ? '正在拒绝修改' : 'Rejecting changes')
    : presentation.label;
  const error = originMismatch ? (zh ? '结果来源不匹配，未更新此卡片' : 'Result origin mismatch; this card was not updated')
    : actionError || result?.error || state.error;
  const budgetFailure = (status === 'cancelled' || status === 'failed') && /SKILL_REVIEW_BUDGET_(?:TOKENS|TIME|ROUNDS)/.test(error ?? '');
  const legacyInterrupted = surface === 'history' && !state.resume && /SKILL_REVIEW_INTERRUPTED/.test(error ?? '');
  const runAction = async (action: 'approve' | 'reject' | 'rollback' | 'retry') => {
    const stateRetry = action === 'retry' && onRetryState !== undefined && state.resume !== undefined;
    const handler = action === 'approve' ? onApprove : action === 'reject' ? onReject : action === 'retry' ? onRetry : onRollback;
    if ((!stateRetry && (!handler || !result)) || inFlight.current) return;
    const id = action === 'rollback' ? result?.rollbackId : result?.batchId;
    if (!stateRetry && !id) return;
    inFlight.current = true;
    setBusy(action);
    setActionError('');
    const startedGeneration = generation.current;
    try {
      const next = stateRetry ? await onRetryState!(state) : await handler!(id!);
      if (!mounted.current || generation.current !== startedGeneration) return;
      if (!next && action === 'retry') return;
      if (!next) throw new Error('SKILL_MUTATION_UNCONFIRMED');
      if (!sameOrigin(next.origin, state.origin)
        || ((action === 'approve' || action === 'reject') && next.batchId !== result?.batchId)) {
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
  const displayLabel = budgetFailure ? (zh ? '复盘失败' : 'Review failed') : label;
  const meta = admission
    ? (zh ? `工具活动 ${admission.completedActivities}/${admission.activityThreshold} · 未调用模型` : `Tool activities ${admission.completedActivities}/${admission.activityThreshold} · Model not called`)
    : result ? localizeSkillReviewText(result.lesson, zh)
    : phase && state.queuedAt !== undefined
      ? (zh ? `已等待 ${Math.max(0, Math.floor((now - state.queuedAt) / 1000))} 秒` : `Elapsed ${Math.max(0, Math.floor((now - state.queuedAt) / 1000))} s`)
      : undefined;
  const actionStyle = surface === 'chat' ? 'ugs-review-action' : actionClass;
  if (!isSkillReviewVisible({ ...state, status }, surface)) return null;
  const body = <>
      {state.detail && <p className="text-fg-dim">{localizeSkillReviewText(state.detail, zh)}</p>}
      {admission && <>
        <p className="text-fg-dim">{localizeSkillReviewText(admission.reason, zh)}{' '}{zh ? '本轮未调用回顾模型。' : 'The review model was not called for this turn.'}</p>
        <p className="text-fg-dim tabular-nums">{zh ? '已完成工具活动：' : 'Completed tool activities: '}{admission.completedActivities} / {admission.activityThreshold}</p>
      </>}
      {phase && state.queuedAt !== undefined && <p className="text-fg-dim tabular-nums">
        {zh ? '已等待' : 'Elapsed'} {Math.max(0, Math.floor((now - state.queuedAt) / 1000))} {zh ? '秒' : 's'}
      </p>}
      {result && <p className="whitespace-pre-wrap break-words leading-relaxed">{localizeSkillReviewText(result.lesson, zh)}</p>}
      <p className="break-all text-fg-dim">{state.origin.workspaceId}</p>
      {surface === 'history' && <p className="break-words text-fg-dim [overflow-wrap:anywhere]">{state.origin.hostId} · {state.origin.sessionId} · {state.origin.turnId} · {state.origin.runId}</p>}
      {result?.revision && <p className="break-all font-mono text-[11px] text-fg-dim">{result.revision}</p>}
      {result?.usage && (
        <p className="break-words text-[11px] tabular-nums text-fg-dim">
          {zh ? '复盘用量' : 'Review usage'} · {result.usage.estimated ? (zh ? '估算' : 'Estimated') : (zh ? '实测' : 'Measured')}
          {' · '}{result.usage.inputTokens === undefined ? (zh ? '输入未知' : 'Input unknown') : `${zh ? '输入' : 'Input'} ${result.usage.inputTokens}`}
          {' · '}{result.usage.outputTokens === undefined ? (zh ? '输出未知' : 'Output unknown') : `${zh ? '输出' : 'Output'} ${result.usage.outputTokens}`}
          {' · '}{result.usage.calls} {zh ? '次模型调用' : 'model calls'}
        </p>
      )}
      {error && <p role="alert" className="ugs-review-error whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{localizeSkillReviewText(error, zh)}</p>}
      {legacyInterrupted && <p className="text-fg-dim">{zh ? '缺少可恢复的证据快照，未自动重跑；请从原会话发起新的复盘。' : 'No recoverable evidence snapshot; not rerun automatically. Start a new review from the source conversation.'}</p>}
      {result && result.riskReasons.length > 0 && (
        <ul className="space-y-1 text-fg-dim">
          {result.riskReasons.map((reason, index) => <li key={index} className="break-words">{localizeSkillReviewText(reason, zh)}</li>)}
        </ul>
      )}
      {result && result.changes.length > 0 && (
        <details data-ugs-review-diff className="min-w-0 rounded-md border border-border">
          <summary className="min-h-11 cursor-pointer rounded-md px-2 py-3 text-fg-dim outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent">
            {zh ? '查看 diff' : 'View diff'} · {result.changes.length}
          </summary>
          <div className="min-w-0 space-y-3 border-t border-border p-2">
            {result.changes.map((change, index) => (
              <section key={`${change.skillId}:${change.filePath}:${index}`} className="min-w-0 space-y-1.5">
                <h4 className="break-all font-mono text-[11px] text-fg">{change.name} / {change.filePath}</h4>
                <p className="break-all font-mono text-[10px] text-fg-dim">
                  {change.beforeHash ?? '∅'} → {change.afterHash ?? '∅'}
                </p>
                <div role="region" aria-label={`${change.name} / ${change.filePath} diff`} tabIndex={0}
                  className="min-w-0 max-w-full overflow-x-auto rounded border border-border bg-bg outline-none focus-visible:ring-2 focus-visible:ring-accent">
                  <div className="w-max min-w-full p-2">
                    <pre aria-label={zh ? '差异行（+ 新增 / − 移除）' : 'Diff lines (+ added / − removed)'} className="mb-3 whitespace-pre font-mono text-[11px] leading-relaxed text-fg-dim">
                      {skillReviewDiffLines(change.before, change.after).map((line, lineIndex) => <span key={lineIndex} className={`block ${line.kind === 'add' ? 'ugs-review-diff-add' : line.kind === 'remove' ? 'ugs-review-diff-remove' : ''}`}>{line.kind === 'add' ? '+ ' : line.kind === 'remove' ? '− ' : '  '}{line.text}</span>)}
                    </pre>
                    <p className="mb-1 text-[10px] text-fg-dim">{zh ? '修改前' : 'Before'}</p>
                    <pre className="whitespace-pre font-mono text-[11px] leading-relaxed text-fg-dim">{change.before ?? (zh ? '（文件不存在）' : '(File absent)')}</pre>
                    <p className="mb-1 mt-3 text-[10px] text-fg-dim">{zh ? '修改后' : 'After'}</p>
                    <pre className="whitespace-pre font-mono text-[11px] leading-relaxed text-fg">{change.after ?? (zh ? '（移除文件）' : '(File removed)')}</pre>
                  </div>
                </div>
              </section>
            ))}
          </div>
        </details>
      )}
  </>;
  const actions = <div className="ugs-review-actions">
      {pendingVisible && result?.status === 'awaiting_approval' && onApprove && (
        <button type="button" aria-label={zh ? '批准修改' : 'Approve changes'} disabled={disabled}
          className={actionStyle} onClick={() => void runAction('approve')}>
          {zh ? '批准修改' : 'Approve changes'}
        </button>
      )}
      {pendingVisible && result?.status === 'awaiting_approval' && onReject && (
        <button type="button" aria-label={zh ? '拒绝修改' : 'Reject changes'} disabled={disabled}
          className={actionStyle} onClick={() => void runAction('reject')}>
          {zh ? '拒绝修改' : 'Reject changes'}
        </button>
      )}
      {((provedApplied && !rolledBack) || status === 'needs_recovery') && result?.rollbackId && onRollback && (
        <button type="button" aria-label={status === 'needs_recovery' ? (zh ? '恢复原版本' : 'Recover original version') : (zh ? '撤销修改' : 'Roll back changes')} disabled={disabled}
          className={actionStyle} onClick={() => void runAction('rollback')}>
          {status === 'needs_recovery' ? (zh ? '恢复原版本' : 'Recover original version') : (zh ? '撤销修改' : 'Roll back changes')}
        </button>
      )}
      {!legacyInterrupted && (status === 'conflicted' || status === 'failed' || status === 'cancelled' || busy === 'retry') && ((result && onRetry) || (state.resume && onRetryState)) && (
        <button type="button" aria-label={zh ? '重新复盘' : 'Retry review'} disabled={disabled}
          className={actionStyle} onClick={() => void runAction('retry')}>
          {zh ? '重新复盘' : 'Retry review'}
        </button>
      )}
  </div>;
  return <article data-tone={presentation.tone} data-active={presentation.active && busy !== 'retry' && busy !== 'reject' ? 'true' : 'false'}
    className={surface === 'chat' ? 'ugs-skill-review ugs-review-strip min-w-0 text-xs text-fg' : 'ugs-skill-review min-w-0 space-y-2 rounded-lg border border-border bg-panel p-3 text-xs text-fg'}>
    {surface === 'chat'
      ? <ReviewStrip label={displayLabel} meta={meta} diagnosticsLabel={zh ? '复盘诊断' : 'Review diagnostics'}>{body}</ReviewStrip>
      : <><p role="status" className="ugs-review-label font-semibold">{displayLabel}</p>{body}</>}
    {actions}
  </article>;
}
