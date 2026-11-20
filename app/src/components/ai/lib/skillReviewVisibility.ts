import type { SkillReviewState } from '@/runtime/skills/types';

/** Chat shows confirmed saved lessons only; history retains every diagnostic state. */
export function isSkillReviewVisible(state: SkillReviewState | undefined, surface: 'chat' | 'history' = 'chat'): boolean {
  if (!state) return false;
  if (surface === 'history') return true;
  const result = state.result;
  return state.status === 'applied' && result?.status === 'applied' && result.operationsApplied > 0
    && state.action !== 'rollback' && !state.error && !result.error
    && (['hostId', 'workspaceId', 'sessionId', 'turnId', 'runId', 'cwd'] as const)
      .every(key => state.origin[key] === result.origin[key]);
}
