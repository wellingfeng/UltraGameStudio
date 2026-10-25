import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { expect, it } from 'vitest';
import { createNodeSkillCandidateStore } from './skill-candidate-store';
import { emptySkillCandidates } from '../../src/runtime/skills/preReview';

it('persists CLI candidates atomically and reloads them in a new host instance', async () => {
  const root = resolve('../.ultragamestudio/tests/skill-candidate-storage');
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, 'run-'));
  if (!resolve(dir).startsWith(`${root}\\`) && !resolve(dir).startsWith(`${root}/`)) throw new Error('Unexpected test cleanup path');
  try {
    const list = emptySkillCandidates();
    list.candidates.push({ id: 'a', lesson: '先复现再修复', context: '测试失败', sources: ['source-a'], consecutive: 1, submitted: false });
    await createNodeSkillCandidateStore(dir).save(list);
    expect(await createNodeSkillCandidateStore(dir).load()).toEqual(list);
    expect(JSON.parse(await readFile(join(dir, '.ultragamestudio/skill-learning/pre-review.v1.json'), 'utf8'))).toEqual(list);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
