import type { SkillReviewState } from '@/runtime/skills/types';

/** No-lesson outcomes stay auditable in history without cluttering the chat. */
export function isSkillReviewVisible(state: SkillReviewState | undefined, surface: 'chat' | 'history' = 'chat'): boolean {
  return state !== undefined && (surface === 'history' || state.status !== 'noop');
}
