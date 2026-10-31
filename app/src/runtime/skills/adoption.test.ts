import { describe, expect, it } from 'vitest';
import * as adoption from './adoption';
import type { SkillOrigin } from './types';
const origin: SkillOrigin = { hostId: 'local', workspaceId: 'w', sessionId: 's', turnId: 't', runId: 'r' };
const loaded = [{ skillId: 'skill', revision: 'rev', hash: 'hash', files: ['SKILL.md'] }];
const rule = { skillId: 'skill', revision: 'rev', kind: 'artifact-in-directory' as const, directory: 'exports' };

describe('bounded deterministic adoption', () => {
  it.each([
    { artifacts: [{ path: 'exports/a', origin: { ...origin, turnId: 'other' } }], loadedSkills: loaded },
    { artifacts: [{ path: 'exports/a', origin }], loadedSkills: [{ ...loaded[0], revision: 'other' }] },
    { artifacts: [], loadedSkills: loaded },
  ])('rejects generic success, wrong turn or undelivered revision: %j', async (input) => {
    const facts = await adoption.checkSkillAdoption({ origin, rules: [rule], ...input,
      host: { inspectArtifact: async () => ({ relativePath: 'exports/a', path: '/workspace/exports/a', isFile: true, hash: 'hash' }) } });
    expect(facts).toEqual([]);
  });
  it('rejects late host checks after cancellation', async () => {
    const controller = new AbortController();
    await expect(adoption.checkSkillAdoption({ origin, loadedSkills: loaded, rules: [rule], artifacts: [{ path: 'exports/a', origin }],
      signal: controller.signal, host: { inspectArtifact: async () => { controller.abort(); return { relativePath: 'exports/a', path: '/workspace/exports/a', isFile: true, hash: 'hash' }; } },
    })).rejects.toThrow('SKILL_ADOPTION_CANCELLED');
  });
  it('returns a stable revision-specific check identity for host replay deduplication', async () => {
    const input = { origin, loadedSkills: loaded, rules: [rule], artifacts: [{ path: 'exports/a', origin }],
      host: { inspectArtifact: async () => ({ relativePath: 'exports/a', path: '/workspace/exports/a', isFile: true, hash: 'hash' }) } };
    const one = await adoption.checkSkillAdoption(input); const replay = await adoption.checkSkillAdoption(input);
    expect(one[0].evidenceId).toBe(replay[0].evidenceId);
    const next = await adoption.checkSkillAdoption({ ...input, loadedSkills: [{ ...loaded[0], revision: 'rev2' }], rules: [{ ...rule, revision: 'rev2' }] });
    expect(next[0].evidenceId).not.toBe(one[0].evidenceId);
  });
  it('extracts only an explicit bounded non-executable declaration from full skill content', () => {
    expect(adoption.readSkillAdoptionRule).toBeTypeOf('function');
    expect(adoption.readSkillAdoptionRule('skill', 'rev', 'Put exports in the workspace.')).toBeUndefined();
    expect(adoption.readSkillAdoptionRule('skill', 'rev', '<!-- UGS_ADOPTION {"kind":"artifact-in-directory","directory":"exports"} -->')).toEqual(rule);
    expect(adoption.readSkillAdoptionRule('skill', 'rev', '<!-- UGS_ADOPTION {"kind":"shell","directory":"exports","command":"sh x"} -->')).toBeUndefined();
  });
  it('requires a real in-directory host file check for the delivered exact revision', async () => {
    expect(adoption.checkSkillAdoption).toBeTypeOf('function');
    const facts = await adoption.checkSkillAdoption({ origin, loadedSkills: loaded, rules: [rule],
      artifacts: [{ path: 'exports/result.txt', origin }],
      host: { inspectArtifact: async () => ({ relativePath: 'exports/result.txt', path: '/workspace/exports/result.txt', isFile: true, hash: 'filehash' }) } });
    expect(facts).toMatchObject([{ kind: 'skill-use', provenance: 'host-check', status: 'success', exitCode: 0,
      origin, skillId: 'skill', revision: 'rev', toolName: 'artifact-in-directory' }]);
  });
});
