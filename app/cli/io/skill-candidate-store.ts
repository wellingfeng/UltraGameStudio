import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emptySkillCandidates, type SkillCandidateList, type SkillCandidateStore } from '../../src/runtime/skills/preReview';

/** CLI candidate drafts live with other private runtime data, never in skill files. */
export function createNodeSkillCandidateStore(cwd: string): SkillCandidateStore {
  const directory = join(cwd, '.ultragamestudio', 'skill-learning');
  const path = join(directory, 'pre-review.v1.json');
  return {
    async load() {
      let raw: string;
      try { raw = await readFile(path, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptySkillCandidates(); throw error; }
      const list = JSON.parse(raw) as SkillCandidateList;
      if (list.version !== 1 || !Array.isArray(list.candidates)) throw new Error('SKILL_PRE_REVIEW_INVALID_STORAGE');
      return list;
    },
    async save(list) {
      await mkdir(directory, { recursive: true });
      const temp = `${path}.${crypto.randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(list), 'utf8');
      await rename(temp, path);
    },
  };
}
