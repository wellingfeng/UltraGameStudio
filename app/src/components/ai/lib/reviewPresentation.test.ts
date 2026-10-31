import { describe, expect, it } from 'vitest';
import { presentSkillReview, skillReviewDiffLines } from './reviewPresentation';
import type { SkillReviewState } from '@/runtime/skills/types';
const origin = { hostId: 'local', workspaceId: 'w', sessionId: 's', turnId: 't', runId: 'r' };
describe('review presentation', () => {
  it('marks additions and removals as text without changing literal source lines', () => {
    expect(skillReviewDiffLines('shared\r\nold\r\nend', 'shared\r\n<script>literal</script>\r\nend')).toEqual([
      { kind: 'context', text: 'shared\r' }, { kind: 'remove', text: 'old\r' },
      { kind: 'add', text: '<script>literal</script>\r' }, { kind: 'context', text: 'end' },
    ]);
    expect(skillReviewDiffLines(null, 'new')).toEqual([{ kind: 'add', text: 'new' }]);
    expect(skillReviewDiffLines('old', null)).toEqual([{ kind: 'remove', text: 'old' }]);
  });
  it('pairs every diagnostic status with a semantic color and text, animating only real activity', () => {
    const expected = { queued: ['排队等待复盘', 'info', false], reading: ['正在读取技能', 'running', true], proposing: ['正在提炼经验', 'running', true], applying: ['正在应用修改', 'running', true], awaiting_approval: ['待批准', 'warning', false], conflicted: ['版本冲突', 'warning', false], failed: ['学习失败', 'error', false], needs_recovery: ['需要恢复', 'error', false], cancelled: ['已取消', 'interrupted', false], rejected: ['已拒绝', 'interrupted', false], noop: ['无新经验', 'neutral', false] } as const;
    for (const [status, [label, tone, active]] of Object.entries(expected)) {
      expect(presentSkillReview({ status: status as SkillReviewState['status'], origin })).toMatchObject({ label, tone, active });
    }
  });
  it.each(['insufficient-evidence', 'scheduler-capacity', 'disabled-or-not-terminal'])(
    'does not infer nonadmission from the model-controlled noop reason %s', (lesson) => {
      const state: SkillReviewState = { status: 'noop', origin, result: {
        status: 'noop', origin, batchId: 'model-noop', lesson, operationsApplied: 0, changes: [], riskReasons: [],
        usage: { estimated: false, calls: 1 },
      } };
      expect(presentSkillReview(state)).toEqual({ label: '无新经验', tone: 'neutral', active: false });
      expect(presentSkillReview(state, false)).toEqual({ label: 'No new lesson', tone: 'neutral', active: false });
    },
  );
  it.each([true, false])('uses the explicit host nonadmission marker without requiring a result (Chinese: %s)', (chinese) => {
    const state: SkillReviewState = { status: 'noop', origin,
      admission: { status: 'not-admitted', reason: 'insufficient-evidence', completedActivities: 1, activityThreshold: 10 },
    };
    expect(presentSkillReview(state, chinese)).toEqual({
      label: chinese ? '未触发技能复盘' : 'Skill review not started', tone: 'neutral', active: false,
    });
  });
  it('requires a positive matching host result before using saved-success text or tone', () => {
    const state: SkillReviewState = { status: 'applied', origin };
    expect(presentSkillReview(state)).toMatchObject({ label: '未确认应用', tone: 'warning', active: false });
    state.result = { status: 'applied', origin, batchId: 'b', lesson: 'rule', operationsApplied: 0, changes: [], riskReasons: [] };
    expect(presentSkillReview(state).tone).toBe('warning');
    state.result.operationsApplied = 1;
    expect(presentSkillReview(state)).toMatchObject({ label: '经验已保存', tone: 'success', active: false });
    state.result.origin = { ...origin, workspaceId: 'other' };
    expect(presentSkillReview(state).tone).toBe('warning');
  });
  it.each(['queued', 'reading', 'proposing', 'applying', 'failed', 'cancelled', 'needs_recovery', 'applied'] as const)(
    'preserves the actual %s diagnostic even if a prior nonadmission marker was retained', (status) => {
      const state: SkillReviewState = { status, origin };
      expect(presentSkillReview({ ...state,
        admission: { status: 'not-admitted', reason: 'scheduler-capacity', completedActivities: 7, activityThreshold: 13 },
      })).toEqual(presentSkillReview(state));
    },
  );
});
