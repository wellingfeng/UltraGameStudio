import type { SkillReviewState } from '@/runtime/skills/types';
export type ReviewTone = 'info' | 'running' | 'warning' | 'success' | 'error' | 'interrupted' | 'neutral';
export interface ReviewDiffLine { kind: 'context' | 'remove' | 'add'; text: string }
/** Linear, contiguous replacement diff. Not necessarily minimal; no source normalization. */
export function skillReviewDiffLines(before: string | null, after: string | null): ReviewDiffLine[] {
  const left = before === null ? [] : before.split('\n');
  const right = after === null ? [] : after.split('\n');
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1;
  let end = 0;
  while (end < left.length - start && end < right.length - start && left[left.length - 1 - end] === right[right.length - 1 - end]) end += 1;
  return [
    ...left.slice(0, start).map(text => ({ kind: 'context' as const, text })),
    ...left.slice(start, left.length - end).map(text => ({ kind: 'remove' as const, text })),
    ...right.slice(start, right.length - end).map(text => ({ kind: 'add' as const, text })),
    ...left.slice(left.length - end).map(text => ({ kind: 'context' as const, text })),
  ];
}
const phases: Record<SkillReviewState['status'], [string, string, ReviewTone, boolean]> = {
  queued: ['排队等待复盘', 'Queued for review', 'info', false],
  reading: ['正在读取技能', 'Reading skills', 'running', true],
  proposing: ['正在提炼经验', 'Extracting lessons', 'running', true],
  applying: ['正在应用修改', 'Applying changes', 'running', true],
  applied: ['经验已保存', 'Lesson saved', 'success', false],
  awaiting_approval: ['待批准', 'Awaiting approval', 'warning', false],
  noop: ['无新经验', 'No new lesson', 'neutral', false],
  conflicted: ['版本冲突', 'Version conflict', 'warning', false],
  failed: ['学习失败', 'Learning failed', 'error', false],
  needs_recovery: ['需要恢复', 'Recovery required', 'error', false],
  cancelled: ['已取消', 'Cancelled', 'interrupted', false],
  rejected: ['已拒绝', 'Rejected', 'interrupted', false],
};
export function presentSkillReview(state: SkillReviewState, chinese = true) {
  const result = state.result;
  const provedApplied = state.status === 'applied' && result?.status === 'applied' && result.operationsApplied > 0
    && (['hostId', 'workspaceId', 'sessionId', 'turnId', 'runId', 'cwd'] as const).every(key => state.origin[key] === result.origin[key]);
  const [zh, en, tone, active] = phases[state.status];
  if (state.status === 'noop' && state.admission?.status === 'not-admitted') {
    return { label: chinese ? '未触发技能复盘' : 'Skill review not started', tone: 'neutral' as ReviewTone, active: false };
  }
  if (state.status === 'applied' && !provedApplied) return { label: chinese ? '未确认应用' : 'Application unconfirmed', tone: 'warning' as ReviewTone, active: false };
  return { label: provedApplied && state.action === 'rollback' ? chinese ? '已撤销' : 'Reverted' : chinese ? zh : en, tone, active };
}
