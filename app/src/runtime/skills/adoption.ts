import type { SkillEvidence, SkillLearningJob, SkillOrigin } from './types';

export interface SkillAdoptionRule {
  skillId: string;
  revision: string;
  kind: 'artifact-in-directory';
  directory: string;
}
export interface SkillAdoptionHost {
  /** Read-only filesystem check; reject symlink/junctions and escapes in the host. */
  inspectArtifact(path: string): Promise<{ relativePath: string; path: string; isFile: boolean; hash: string } | null>;
}
export interface SkillAdoptionOptions {
  origin: SkillOrigin;
  loadedSkills: SkillLearningJob['loadedSkills'];
  rules: readonly SkillAdoptionRule[];
  artifacts: readonly { path: string; origin: SkillOrigin }[];
  host: SkillAdoptionHost;
  signal?: AbortSignal;
}
const safeRelative = (path: string) => !!path && path.length <= 256 && path.split('/').every((part) =>
  !!part && part !== '.' && part !== '..' && !/[\\:\x00-\x1f<>"|?*]/.test(part) && !/[. ]$/.test(part));
const sameTurn = (a: SkillOrigin, b: SkillOrigin) => a.hostId === b.hostId && a.workspaceId === b.workspaceId &&
  a.sessionId === b.sessionId && a.turnId === b.turnId && a.cwd === b.cwd &&
  (b.runId === a.runId || b.runId.startsWith(`${a.runId}/cli/`));

/** An opt-in check declaration, not model-generated executable policy. */
export function readSkillAdoptionRule(skillId: string, revision: string, content: string): SkillAdoptionRule | undefined {
  const declarations = [...content.matchAll(/<!-- UGS_ADOPTION ([^\r\n]*?) -->/g)];
  if (declarations.length !== 1 || declarations[0][1].length > 512) return;
  try {
    const value = JSON.parse(declarations[0][1]);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'directory,kind' ||
      value.kind !== 'artifact-in-directory' || typeof value.directory !== 'string' || !safeRelative(value.directory)) return;
    return { skillId, revision, kind: value.kind, directory: value.directory };
  } catch { return; }
}

/** Only the supported explicit rule is evidence of adoption, never generic success. */
export async function checkSkillAdoption(options: SkillAdoptionOptions): Promise<SkillEvidence[]> {
  const facts: SkillEvidence[] = [];
  const check = () => { if (options.signal?.aborted) throw new Error('SKILL_ADOPTION_CANCELLED'); };
  for (const rule of options.rules.slice(0, 16)) {
    check();
    if (rule.kind !== 'artifact-in-directory' || !safeRelative(rule.directory) || !options.loadedSkills.some((skill) =>
      skill.skillId === rule.skillId && skill.revision === rule.revision && skill.files.includes('SKILL.md'))) continue;
    for (const artifact of options.artifacts.slice(-64)) {
      if (!sameTurn(options.origin, artifact.origin)) continue;
      const inspected = await options.host.inspectArtifact(artifact.path);
      check();
      if (!inspected?.isFile || !inspected.hash || !safeRelative(inspected.relativePath) ||
        !inspected.relativePath.startsWith(`${rule.directory}/`)) continue;
      const identity = JSON.stringify([options.origin, rule.skillId, rule.revision, rule.kind, rule.directory]);
      facts.push({ evidenceId: `adoption:${identity}`, toolCallId: `adoption:${identity}`, origin: { ...options.origin },
        occurredAt: Date.now(), kind: 'skill-use', provenance: 'host-check', status: 'success', exitCode: 0,
        toolName: rule.kind, skillId: rule.skillId, revision: rule.revision, path: inspected.path,
        summary: `宿主已检查本任务产物位于 ${rule.directory}/；仅验证该目录规则。`, result: inspected.hash });
      break;
    }
  }
  return facts.filter((fact, index) => facts.findIndex((item) => item.evidenceId === fact.evidenceId) === index);
}
