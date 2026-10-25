import type { SkillReviewState } from '@/runtime/skills/types';

/** Keep queue/progress and reviews with no usable outcome out of the chat. */
export function isSkillReviewVisible(state: SkillReviewState | undefined): boolean {
  if (!state) return false;
  if (['queued', 'reading', 'proposing', 'applying', 'noop', 'failed', 'cancelled'].includes(state.status)) return false;
  return state.result !== undefined;
}
