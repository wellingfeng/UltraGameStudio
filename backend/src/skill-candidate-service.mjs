import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';

/** Candidate-only host CAS. Model calls must finish before entering this host. */
export function createSkillCandidateService({ dir, namespace } = {}) {
  if (typeof dir !== 'string' || !isAbsolute(dir)) throw new Error('SKILL_CANDIDATE_INVALID_ROOT');
  if (namespace && ['tenantId', 'serverId', 'accountId', 'workspaceId'].some((key) => typeof namespace[key] !== 'string' || !namespace[key])) {
    throw new Error('SKILL_CANDIDATE_INVALID_NAMESPACE');
  }
  const scope = namespace ? ['tenantId', 'serverId', 'accountId', 'workspaceId'].map((key) => namespace[key]) : null;
  const directory = join(resolve(dir), '.ultragamestudio', 'skill-learning');
  const name = scope ? `pre-review.${createHash('sha256').update(JSON.stringify(scope)).digest('hex')}.json` : 'pre-review.v1.json';
  const path = join(directory, name);
  const lock = `${path}.lock`;
  async function safe(target) {
    let current = parse(target).root;
    for (const segment of relative(current, target).split(/[\\/]/).filter(Boolean)) {
      current = join(current, segment);
      try { if ((await lstat(current)).isSymbolicLink()) throw new Error('SKILL_CANDIDATE_UNSAFE_PATH'); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
    }
  }
  function validate(list) {
    if (!list || list.version !== 1 || !Array.isArray(list.candidates) ||
      !Number.isSafeInteger(list.revision ?? 0) || (list.revision ?? 0) < 0 || list.candidates.length > 64) {
      throw new Error('SKILL_PRE_REVIEW_INVALID_STORAGE');
    }
    const ids = new Set();
    for (const item of list.candidates) {
      if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id) || typeof item.lesson !== 'string' ||
        item.lesson.length > 1024 || typeof item.context !== 'string' || item.context.length > 8192 ||
        !Array.isArray(item.sources) || item.sources.length > 4096 || item.sources.some((source) => typeof source !== 'string' || source.length > 2048) ||
        !Number.isSafeInteger(item.consecutive) || item.consecutive < 0 || typeof item.submitted !== 'boolean') throw new Error('SKILL_PRE_REVIEW_INVALID_STORAGE');
      ids.add(item.id);
    }
    if (list.seenSources !== undefined && (!Array.isArray(list.seenSources) || list.seenSources.length > 4096 ||
      list.seenSources.some((source) => typeof source !== 'string' || source.length > 2048) || new Set(list.seenSources).size !== list.seenSources.length)) {
      throw new Error('SKILL_PRE_REVIEW_INVALID_STORAGE');
    }
    return list;
  }
  async function load() {
    await safe(path);
    try {
      const list = validate(JSON.parse(await readFile(path, 'utf8')));
      return { ...list, revision: list.revision ?? 0 };
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, revision: 0, candidates: [] };
      throw error;
    }
  }
  async function compareAndSwap(expectedRevision, value) {
    const list = structuredClone(validate(value));
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) throw new Error('SKILL_CANDIDATE_INVALID_REVISION');
    await safe(path);
    await mkdir(directory, { recursive: true });
    const deadline = Date.now() + 5000;
    for (;;) {
      try { await mkdir(lock); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) throw new Error('SKILL_CANDIDATE_LOCKED_NEEDS_RECOVERY');
        await new Promise((done) => setTimeout(done, 10));
      }
    }
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      const current = await load();
      if (current.revision !== expectedRevision) throw new Error('SKILL_CANDIDATE_CONFLICT');
      const previousSources = current.seenSources ?? current.candidates.flatMap((item) => item.sources);
      const nextSources = list.seenSources ?? list.candidates.flatMap((item) => item.sources);
      if (previousSources.some((source) => !nextSources.includes(source))) throw new Error('SKILL_CANDIDATE_REPLAY_ERASURE');
      const next = { ...list, revision: expectedRevision + 1 };
      const data = JSON.stringify(next);
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(data, 'utf8'); await file.sync(); } finally { await file.close(); }
      await rename(temp, path);
      if (await readFile(path, 'utf8') !== data) throw new Error('SKILL_CANDIDATE_READBACK_FAILED');
      return next;
    } finally { await rm(temp, { force: true }); await rm(lock, { recursive: true }); }
  }
  return { load, compareAndSwap };
}
