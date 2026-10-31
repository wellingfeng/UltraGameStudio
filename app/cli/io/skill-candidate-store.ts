import { resolve } from 'node:path';
import type { SkillCandidateStore } from '../../src/runtime/skills/preReview';
// @ts-expect-error Node-only host module is bundled into the installed CLI.
import { createSkillCandidateService } from '../../../backend/src/skill-candidate-service.mjs';

/** Shared private workspace authority, not a load/model/unconditional-save cache. */
export function createNodeSkillCandidateStore(cwd: string): SkillCandidateStore {
  const service = createSkillCandidateService({ dir: resolve(cwd) });
  return {
    load: () => service.load(),
    save: async (list) => { await service.compareAndSwap(list.revision ?? 0, list); },
  };
}
