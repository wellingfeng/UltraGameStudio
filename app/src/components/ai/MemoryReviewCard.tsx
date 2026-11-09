import type { Locale } from '@/lib/i18n';
import type { MemoryReviewChatState } from '@/lib/memoryReviewEvents';
import ReviewStrip from './ReviewStrip';
import './SkillLearningCard.css';

export interface MemoryReviewCardProps {
  state: MemoryReviewChatState;
  locale?: Locale;
  onOpenSettings?: () => void;
}
const phases: Record<MemoryReviewChatState['phase'], [string, string, string]> = {
  queued: ['记忆复盘排队中', 'Memory review queued', 'info'],
  admitting: ['记忆复盘准入中', 'Memory review admission', 'info'],
  reading: ['正在复盘记忆', 'Reviewing memory', 'running'],
  unconfirmed: ['上次记忆复盘未确认结束', 'Previous memory review outcome unconfirmed', 'interrupted'],
  disabled: ['记忆复盘已关闭', 'Memory review disabled', 'neutral'],
  skipped: ['本轮未复盘记忆', 'Memory review skipped', 'neutral'],
  failed: ['记忆复盘失败', 'Memory review failed', 'error'],
  cancelled: ['记忆复盘已取消', 'Memory review cancelled', 'interrupted'],
  noop: ['无需更新记忆', 'No memory update needed', 'neutral'],
  awaiting_approval: ['记忆提案待审批', 'Memory proposal awaiting approval', 'warning'],
  applied: ['记忆已保存', 'Memory saved', 'success'],
};
const gateDetails: Record<string, [string, string]> = {
  review_or_write_disabled: ['后台复盘或记忆写入已关闭；未调用复盘模型。', 'Background review or memory writes disabled; no review model called.'],
  below_threshold: ['消息数量未达到复盘门槛；未调用复盘模型。', 'Message threshold not reached; no review model called.'],
  background_busy: ['前台或其他后台任务占用复盘通道；空闲后再准入，尚未调用复盘模型。', 'Review channel busy; waiting for admission, no review model called yet.'],
  not_admitted: ['持久化准入未通过（忙碌、冷却或来源已尝试）；未重复派发。', 'Durable admission denied (busy, cooldown or attempted source); not dispatched again.'],
  foreground_cancelled: ['前台任务已取消；未启动后台复盘。', 'Foreground cancelled; background review not started.'],
  foreground_failed: ['前台任务未成功完成；未启动后台复盘。', 'Foreground did not complete successfully; background review not started.'],
};
export default function MemoryReviewCard({ state, locale = 'zh-CN', onOpenSettings }: MemoryReviewCardProps) {
  // Background work and resultless reviews remain available in diagnostics, not chat.
  if (['queued', 'admitting', 'reading', 'unconfirmed', 'disabled', 'skipped'].includes(state.phase)
      || (state.appliedOps <= 0 && state.queuedOps <= 0)) return null;
  const zh = locale === 'zh-CN';
  const unconfirmed = state.phase === 'applied' && state.appliedOps <= 0;
  const [labelZh, labelEn, tone] = phases[state.phase];
  const detail = state.detail && (gateDetails[state.detail]?.[zh ? 0 : 1] ?? state.detail);
  const label = unconfirmed ? (zh ? '记忆保存未确认' : 'Memory save unconfirmed') : zh ? labelZh : labelEn;
  const counts = [
    state.appliedOps > 0 ? (state.phase === 'applied'
      ? (zh ? `${state.appliedOps} 项` : `${state.appliedOps} items`)
      : (zh ? `已保存 ${state.appliedOps} 项` : `Saved ${state.appliedOps}`)) : '',
    state.queuedOps > 0 ? (state.phase === 'awaiting_approval'
      ? (zh ? `${state.queuedOps} 项` : `${state.queuedOps} items`)
      : (zh ? `待审批 ${state.queuedOps} 项` : `Pending approval ${state.queuedOps}`)) : '',
    state.recordingError ? (zh ? '结果记录未确认' : 'Outcome recording unconfirmed') : '',
  ].filter(Boolean).join(' · ');
  return <article data-ugs-memory-review={state.id} data-tone={unconfirmed ? 'warning' : tone} data-active={state.phase === 'reading' ? 'true' : 'false'}
    className="ugs-skill-review ugs-review-strip min-w-0 text-xs text-fg">
    <ReviewStrip label={label} meta={counts || undefined} diagnosticsLabel={zh ? '复盘诊断' : 'Review diagnostics'}>
      {(state.appliedOps > 0 || state.queuedOps > 0) && <p className="tabular-nums">
        {zh ? `已保存 ${state.appliedOps} 项 · 待审批 ${state.queuedOps} 项` : `Saved ${state.appliedOps} · Queued for approval ${state.queuedOps}`}
      </p>}
      {state.recordingError && <p>{zh ? '结果记录未确认；以已返回的实际保存数量为准。' : 'Outcome recording unconfirmed; actual returned save counts are retained.'}</p>}
      {state.queuedOps > 0 &&
      <p className="text-fg-dim">{zh ? '设置 → 记忆 → 待审批；当前审批状态以设置中的真实队列为准。' : 'Settings → Memory → Pending approval; current approval status comes from the real queue.'}</p>
      }
        {detail && <p className="break-words">{detail}</p>}
        <p className="break-all">{state.source.hostId} · {state.source.namespaceId} · {state.source.workspaceId} · {state.source.sessionId} · {state.source.turnId} · {state.source.runId}</p>
        {state.usage && <p className="break-words tabular-nums">
          {zh ? '复盘用量' : 'Review usage'} · {state.usage.estimated ? (zh ? '估算' : 'Estimated') : (zh ? '供应商实测' : 'Provider reported')}
          {' · '}{zh ? '输入' : 'Input'} {state.usage.inputTokens}
          {' · '}{state.usage.outputTokens === undefined ? (zh ? '输出未知' : 'Output unknown') : `${zh ? '输出' : 'Output'} ${state.usage.outputTokens}`}
          {' · '}{state.usage.calls} {zh ? '次模型调用' : 'model calls'}
        </p>}
        {state.error && <p className="ugs-review-error whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{state.error}</p>}
        {state.recordingError && <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{state.recordingError}</p>}
    </ReviewStrip>
    {state.queuedOps > 0 && onOpenSettings && <div className="ugs-review-actions">
      <button type="button" onClick={onOpenSettings} className="ugs-review-action">
        {zh ? '打开设置' : 'Open settings'}
      </button>
    </div>}
  </article>;
}
