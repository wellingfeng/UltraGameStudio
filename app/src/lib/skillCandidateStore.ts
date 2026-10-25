import { emptySkillCandidates, type SkillCandidateList, type SkillCandidateStore } from '@/runtime/skills/preReview';
import type { SkillOrigin } from '@/runtime/skills/types';

/** Persistent background list, isolated by host/workspace; never a chat message. */
export function createSkillCandidateStore(origin: SkillOrigin): SkillCandidateStore {
  const key = `ultragamestudio.skillPreReview.v1.${encodeURIComponent(JSON.stringify([origin.hostId, origin.workspaceId, origin.cwd]))}`;
  return {
    async load() {
      const raw = window.localStorage.getItem(key);
      if (!raw) return emptySkillCandidates();
      const list = JSON.parse(raw) as SkillCandidateList;
      if (list.version !== 1 || !Array.isArray(list.candidates)) throw new Error('SKILL_PRE_REVIEW_INVALID_STORAGE');
      return list;
    },
    async save(list) { window.localStorage.setItem(key, JSON.stringify(list)); },
  };
}
