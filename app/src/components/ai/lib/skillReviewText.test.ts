import { describe, expect, it } from 'vitest';
import { localizeSkillReviewText } from './skillReviewText';

describe('skill review diagnostic localization', () => {
  it.each([
    ['insufficient-evidence', '证据不足。'],
    ['scheduler-capacity', '后台调度容量已满。'],
    ['disabled-or-not-terminal', '技能学习已关闭或任务尚未正常完成。'],
  ])('keeps the generic reason %s neutral about whether the review model was called', (reason, translation) => {
    expect(localizeSkillReviewText(reason, true)).toBe(translation);
    expect(localizeSkillReviewText(reason, true)).not.toContain('未调用');
    expect(localizeSkillReviewText(reason, false)).toBe(reason);
  });
});
