import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, link, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { hostname } from 'node:os';
import { isMap, parseDocument } from 'yaml';
import { createSkillCandidateService } from './skill-candidate-service.mjs';

const MAX_MAIN_CHARS = 100_000;
const MAX_SUPPORT_CHARS = 1_000_000;
const SUPPORT_ROOTS = new Set(['references', 'templates', 'scripts', 'assets']);
const EXTERNAL_ROOTS = ['skills', '.claude/skills', '.codex/skills', '.agents/skills', '.gemini/skills'];
const sha = (value) => createHash('sha256').update(value).digest('hex');
const inside = (root, path) => { const rel = relative(root, path); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };

/** Real YAML parsing, shared by the legacy slash catalog and the write host. */
export function parseSkillFrontmatter(text, fallbackName = '', { strict = false } = {}) {
  if (typeof text !== 'string' || text.includes('\0')) throw new Error('skill content must be text');
  const normalized = text.replace(/^\uFEFF/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(normalized);
  if (!match) {
    if (strict) throw new Error('SKILL.md requires closed YAML frontmatter');
    return { name: fallbackName, description: '', metadata: {}, body: normalized };
  }
  const doc = parseDocument(match[1], { uniqueKeys: true });
  if (doc.errors.length || !isMap(doc.contents)) throw new Error('invalid YAML mapping in SKILL.md');
  const metadata = doc.toJS({ maxAliasCount: 32 });
  const name = typeof metadata.name === 'string' ? metadata.name : fallbackName;
  const description = typeof metadata.description === 'string' ? metadata.description.trim() : '';
  if (strict) {
    validateSkillName(name);
    if (typeof metadata.description !== 'string' || !description || description.length > 1024) throw new Error('skill description is required and limited to 1024 characters');
    if (!match[2].trim()) throw new Error('SKILL.md requires a nonempty body');
    if (text.length > MAX_MAIN_CHARS) throw new Error('SKILL.md exceeds full-read limit');
  }
  return { name, description, metadata, body: match[2] };
}

function realLearningEvidence(item) {
  if (item.status !== 'success') return false;
  if (item.provenance === 'user-input') return item.kind === 'correction' && typeof item.summary === 'string' && item.summary.trim().length > 0;
  return ['native-tool', 'host-check'].includes(item.provenance) && item.kind === 'verification' && item.exitCode === 0 && typeof item.toolCallId === 'string' && item.toolCallId.length > 0 && typeof item.toolName === 'string' && item.toolName.length > 0;
}

function skillContentRisks(text) {
  const lower = text.toLowerCase();
  return ['ignore previous instructions', 'disable permission', 'skip validation', 'bypass permission', 'rm -rf', 'remove-item -recurse', 'powershell -enc', '| bash', '| sh', 'invoke-expression', 'curl ', 'wget ', '忽略先前指令', '跳过验证', '禁用权限'].some((pattern) => lower.includes(pattern))
    ? ['content safety heuristic flagged execution or instruction/permission override'] : [];
}

function validatePackageLinks(snapshot) {
  for (const [filePath, content] of snapshot) {
    if (!filePath.endsWith('.md')) continue;
    let rest = content;
    while (rest.includes('](')) {
      rest = rest.slice(rest.indexOf('](') + 2);
      const end = rest.indexOf(')');
      if (end < 0) throw new Error('unterminated markdown support link');
      const destination = rest.slice(0, end).split(/\s/)[0].replace(/^<|>$/g, '');
      rest = rest.slice(end + 1);
      if (destination.startsWith('#') || destination.includes('://') || destination.startsWith('mailto:')) continue;
      const path = destination.split('#')[0];
      if (!path) continue;
      if (/[\\%:]/.test(path) || path.startsWith('/')) throw new Error('unsafe support link destination');
      const combined = filePath === 'SKILL.md' ? path : `${filePath.slice(0, filePath.lastIndexOf('/'))}/${path}`;
      skillFilePath(combined);
      if (!snapshot.has(combined)) throw new Error(`support link target missing: ${combined}`);
    }
  }
}

function validateSkillName(name) {
  if (typeof name !== 'string' || name.length > 64 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) throw new Error('skill name must be lowercase-kebab, at most 64 characters');
  validateSegment(name);
}
function validateSegment(segment) {
  if (!segment || segment === '.' || segment === '..' || /[\\/:\x00-\x1f<>"|?*]/.test(segment) || /[. ]$/.test(segment) || /^(con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment)) throw new Error('unsafe skill path segment');
}
function skillFilePath(path = 'SKILL.md') {
  if (typeof path !== 'string' || path.startsWith('/') || path.includes('\\')) throw new Error('unsafe skill file path');
  const segments = path.split('/');
  segments.forEach(validateSegment);
  if (path !== 'SKILL.md' && (segments.length < 2 || !SUPPORT_ROOTS.has(segments[0]))) throw new Error('supporting files must stay in references/templates/scripts/assets');
  return path;
}

/** Fail closed for symlinks/junctions on EVERY existing ancestor, not just leaf. */
export async function assertSafeSkillPath(path, { allowMissing = false } = {}) {
  const target = resolve(path);
  const base = parse(target).root;
  let current = base;
  for (const segment of relative(base, target).split(sep).filter(Boolean)) {
    current = join(current, segment);
    let info;
      try {
        const siblings = await readdir(dirname(current));
        if (siblings.some((name) => name.toLowerCase() === segment.toLowerCase() && name !== segment)) throw new Error('case-insensitive skill path alias rejected');
        info = await lstat(current);
      } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return target;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error('skill path contains a symlink or junction');
    const resolved = await realpath(current).catch((error) => { if (allowMissing && error.code === 'ENOENT') return null; throw error; });
    if (resolved === null) return target;
    if (resolve(resolved).toLowerCase() !== resolve(current).toLowerCase()) throw new Error('skill path contains a redirected ancestor');
  }
  return target;
}

async function readText(path, main = false) {
  await assertSafeSkillPath(path);
  const info = await lstat(path);
  if (!info.isFile() || info.size > (main ? MAX_MAIN_CHARS * 4 : MAX_SUPPORT_CHARS * 4)) throw new Error('skill file exceeds full-read limit or is not a regular file');
  const bytes = await readFile(path);
  const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (content.length > (main ? MAX_MAIN_CHARS : MAX_SUPPORT_CHARS) || content.includes('\0')) throw new Error('skill file exceeds full-read limit or is binary');
  return { content, hash: sha(bytes) };
}
async function packageFiles(dir) {
  const files = [];
  async function walk(path, prefix, depth) {
    if (depth > 12 || files.length > 400) throw new Error('skill package exceeds limits');
    await assertSafeSkillPath(path);
    const children = await readdir(path, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const rel = prefix ? `${prefix}/${child.name}` : child.name;
      if (!prefix && rel !== 'SKILL.md' && !SUPPORT_ROOTS.has(rel)) continue;
      validateSegment(child.name);
      if (child.isSymbolicLink()) throw new Error('skill package contains a symlink or junction');
      if (child.isDirectory()) await walk(join(path, child.name), rel, depth + 1);
      else if (child.isFile()) { skillFilePath(rel); files.push(rel); }
    }
  }
  await walk(dir, '', 0);
  return files.sort();
}

async function fullPackageSnapshot(dir) {
  const files = [];
  const directories = [];
  async function walk(path, prefix, depth) {
    if (depth > 12 || files.length > 400) throw new Error('skill package exceeds archive limits');
    await assertSafeSkillPath(path);
    for (const child of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      validateSegment(child.name);
      const filePath = prefix ? `${prefix}/${child.name}` : child.name;
      const target = join(path, child.name);
      await assertSafeSkillPath(target);
      if (child.isDirectory()) { directories.push(filePath); await walk(target, filePath, depth + 1); }
      else if (child.isFile()) {
        if ((await lstat(target)).size > MAX_SUPPORT_CHARS * 4) throw new Error('skill package file exceeds archive limits');
        files.push({ filePath, hash: sha(await readFile(target)) });
      } else throw new Error('non-regular archive file rejected');
    }
  }
  await walk(dir, '', 0);
  return { files, directories };
}

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`unknown ${label} field: ${key}`);
}
const OPERATION_FIELDS = {
  create: ['action', 'name', 'content'],
  patch: ['action', 'skillId', 'filePath', 'oldString', 'newString', 'expectedHash', 'readReceiptId'],
  write_file: ['action', 'skillId', 'filePath', 'content', 'expectedHash', 'readReceiptId', 'absent'],
  remove_file: ['action', 'skillId', 'filePath', 'expectedHash', 'readReceiptId'],
};

const DEFAULT_REMOTE_SKILL_CONFIG = Object.freeze({
  enabled: true, mode: 'auto-safe', activityThreshold: 10, cooldownMs: 60000,
  maxRounds: 6, maxInputTokens: 48000, maxOutputTokens: 6000, timeoutMs: 90000,
  autoArchive: false, staleAfterDays: 30, archiveAfterDays: 90,
});
const CONFIG_LIMITS = {
  activityThreshold: [1, 1000], cooldownMs: [0, 86400000], maxRounds: [1, 16],
  maxInputTokens: [1000, 1000000], maxOutputTokens: [100, 100000], timeoutMs: [1000, 600000],
  staleAfterDays: [1, 3650], archiveAfterDays: [1, 3650],
};
function remoteSkillConfig(value, prior = DEFAULT_REMOTE_SKILL_CONFIG) {
  exactKeys(value, [...Object.keys(DEFAULT_REMOTE_SKILL_CONFIG), 'reviewSelection', 'reviewTransport'], 'remote skill config');
  const next = { ...prior };
  for (const [key, item] of Object.entries(value)) {
    if (['enabled', 'autoArchive'].includes(key)) {
      if (typeof item !== 'boolean') throw new Error(`invalid remote skill config ${key}`);
    } else if (key === 'mode') {
      if (!['auto-safe', 'approve-all', 'off'].includes(item)) throw new Error('invalid remote skill config mode');
    } else if (CONFIG_LIMITS[key]) {
      const [min, max] = CONFIG_LIMITS[key];
      if (!Number.isSafeInteger(item) || item < min || item > max) throw new Error(`invalid remote skill config ${key}`);
    } else if (key === 'reviewTransport') {
      if (item === null) { delete next.reviewTransport; continue; }
      if (!['anthropic', 'openai-compatible'].includes(item)) throw new Error('invalid remote skill config reviewTransport');
    } else if (key === 'reviewSelection') {
      if (item === null) { delete next.reviewSelection; continue; }
      exactKeys(item, ['adapter', 'modelClass', 'providerId', 'channelId', 'model'], 'review selection');
      for (const required of ['adapter', 'modelClass']) if (typeof item[required] !== 'string' || !item[required].trim()) throw new Error('review selection requires adapter and modelClass');
      for (const text of Object.values(item)) if (typeof text !== 'string' || !text.trim() || text.length > 200 || text.includes('\0')) throw new Error('invalid review selection');
    }
    next[key] = item;
  }
  if (next.archiveAfterDays < next.staleAfterDays) throw new Error('archiveAfterDays must not precede staleAfterDays');
  return next;
}

async function durableJson(path, value) {
  await assertSafeSkillPath(path, { allowMissing: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, path);
}

async function installRecoveryCopy(source, target, main) {
  // A writable restored target must not share an inode with its only backup.
  // Link a detached fsynced copy exclusively; a concurrent target wins EEXIST.
  const snapshot = await readText(source, main);
  const copy = join(dirname(source), `restore-${randomUUID()}`);
  const handle = await open(copy, 'wx', 0o600);
  try { await handle.writeFile(snapshot.content); await handle.sync(); } finally { await handle.close(); }
  try { await link(copy, target); } finally { await unlink(copy).catch(() => {}); }
}

function knownDeadOwner(owner) {
  if (owner?.hostname !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
  try { process.kill(owner.pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
}
async function claimDeadLockReaper(stateDir, existing, candidate, owner) {
  // Immutable per-owner claims serialize compare-and-unlink. A crashed reaper
  // is superseded by another immutable claim, never by deleting its live guard.
  // Keep the small claims as tombstones: removing one could revive a delayed
  // old reclaimer and let it unlink a replacement owner's lock.
  let token = existing.token;
  const seen = new Set();
  for (let depth = 0; depth < 64; depth += 1) {
    if (typeof token !== 'string' || !/^[a-f0-9-]{36}$/.test(token) || seen.has(token)) return false;
    seen.add(token);
    const claim = join(stateDir, `reap-${token}.json`);
    await assertSafeSkillPath(claim, { allowMissing: true });
    try { await link(candidate, claim); return true; } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const reaper = await readFile(claim, 'utf8').then(JSON.parse).catch(() => null);
    if (reaper?.token === owner.token) return true;
    if (!knownDeadOwner(reaper)) return false;
    token = reaper.token;
  }
  return false;
}

async function acquireRootLock(stateDir, timeoutMs) {
  const lock = join(stateDir, 'root.lock');
  const token = randomUUID();
  const owner = { version: 1, pid: process.pid, hostname: hostname(), token, acquiredAt: Date.now() };
  const deadline = Date.now() + timeoutMs;
  // Linking a fully fsynced owner file makes ownership atomic; no empty-owner
  // window and no timeout-based theft of a live process's lock.
  const candidate = join(stateDir, `owner-${token}.json`);
  const handle = await open(candidate, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(owner)); await handle.sync(); } finally { await handle.close(); }
  try {
    for (;;) {
      await assertSafeSkillPath(lock, { allowMissing: true });
      try { await link(candidate, lock); break; } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const existing = await readFile(lock, 'utf8').then(JSON.parse).catch((error) => { if (error.code === 'ENOENT') return null; return {}; });
      if (!existing) continue;
      if (knownDeadOwner(existing) && await claimDeadLockReaper(stateDir, existing, candidate, owner)) {
        const current = await readFile(lock, 'utf8').then(JSON.parse).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
        if (current?.token === existing.token && knownDeadOwner(current)) await unlink(lock).catch((error) => { if (error.code !== 'ENOENT') throw error; });
        continue;
      }
      if (Date.now() >= deadline) { const error = new Error('skill root is busy; active or unidentifiable lock owner'); error.code = 'SKILL_BUSY'; throw error; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally { await unlink(candidate).catch(() => {}); }
  return async () => {
    const current = await readFile(lock, 'utf8').then(JSON.parse);
    if (current.token !== token) throw new Error('skill root lock ownership changed');
    await unlink(lock);
  };
}

export function createWorkspaceSkillService({ dir, hostId, workspaceId, faultInjector, lockTimeoutMs = 5000, candidateService }) {
  if (!dir || !hostId || !workspaceId) throw new Error('trusted dir/hostId/workspaceId are required');
  const workspace = resolve(dir);
  // Node CLI shares the local authoritative file. Remote hosts inject a
  // server-derived namespaced service, never a namespace supplied in a request.
  const candidates = candidateService ?? createSkillCandidateService({ dir: workspace });
  const root = join(workspace, '.ultragamestudio', 'skills');
  const stateDir = join(root, '.state');
  const rootId = `project:${sha(`${hostId}\0${workspaceId}`).slice(0, 24)}`;
  let chain = Promise.resolve();
  function bindOrigin(origin) {
    if (!origin || origin.hostId !== hostId || origin.workspaceId !== workspaceId) throw new Error('skill origin does not match the authenticated workspace');
    for (const key of ['sessionId', 'turnId', 'runId']) if (typeof origin[key] !== 'string' || !origin[key] || origin[key].length > 200) throw new Error(`skill origin requires ${key}`);
    return { hostId, workspaceId, sessionId: origin.sessionId, turnId: origin.turnId, runId: origin.runId };
  }
  function sameEvidenceSession(evidenceOrigin, origin) {
    const bound = bindOrigin(evidenceOrigin);
    return bound.sessionId === origin.sessionId;
  }
  async function loadState() {
    await assertSafeSkillPath(workspace);
    await assertSafeSkillPath(stateDir, { allowMissing: true });
    await mkdir(stateDir, { recursive: true });
    await assertSafeSkillPath(stateDir);
    const path = join(stateDir, 'state.json');
    await assertSafeSkillPath(path, { allowMissing: true });
    try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { version: 1, policies: {}, receipts: {}, history: [], usage: {} };
    }
  }
  async function saveState(state) {
    await durableJson(join(stateDir, 'state.json'), state);
  }
  async function catalog(state) {
    const entries = [];
    async function scan(sourceRoot, id, scope, source, readOnly) {
      await assertSafeSkillPath(sourceRoot, { allowMissing: true });
      let names;
      try { names = await readdir(sourceRoot, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      names.sort((a, b) => a.name.localeCompare(b.name));
      for (const name of names) {
        if (name.name.startsWith('.')) continue;
        if (name.isSymbolicLink()) throw new Error('skill root contains a symlink or junction');
        if (!name.isDirectory()) continue;
        validateSegment(name.name);
        const skillDir = join(sourceRoot, name.name);
        let main;
        try { main = await readText(join(skillDir, 'SKILL.md'), true); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        const parsed = parseSkillFrontmatter(main.content, name.name);
        const files = await packageFiles(skillDir);
        const hashes = [];
        for (const file of files) hashes.push([file, (await readText(join(skillDir, file), file === 'SKILL.md')).hash]);
        const skillId = `skill:${sha(`${hostId}\0${workspaceId}\0${id}\0${name.name}`)}`;
        const policy = state.policies[skillId] ?? {};
        entries.push({ skillId, rootId: id, name: parsed.name, description: parsed.description, scope, source, relativePath: name.name, revision: sha(JSON.stringify(hashes)), hash: main.hash, readOnly, autoEditable: !readOnly && policy.autoEditable === true, contentLocked: policy.contentLocked === true, pinned: policy.pinned === true, state: 'active', files, ...(state.usage[skillId] ? { usage: state.usage[skillId] } : {}) });
      }
    }
    await scan(root, rootId, 'project', 'ugs-managed', false);
    for (const source of EXTERNAL_ROOTS) await scan(join(workspace, source), `external:${source}`, 'external', source, true);
    for (const [skillId, archived] of Object.entries(state.archives ?? {})) {
      if (entries.some((entry) => entry.skillId === skillId)) throw new Error('archived skill has an external active duplicate; manual recovery required');
      const dir = join(root, archived.storage);
      await assertSafeSkillPath(dir);
      const files = await packageFiles(dir);
      const main = await readText(join(dir, 'SKILL.md'), true);
      const meta = parseSkillFrontmatter(main.content, archived.entry.name);
      const hashes = [];
      for (const file of files) hashes.push([file, (await readText(join(dir, file), file === 'SKILL.md')).hash]);
      entries.push({ ...archived.entry, name: meta.name, description: meta.description, state: 'archived', hash: main.hash, revision: sha(JSON.stringify(hashes)), files, ...(state.usage[skillId] ? { usage: state.usage[skillId] } : {}) });
    }
    return { revision: sha(JSON.stringify(entries)), entries };
  }
  function addUsage(state, entry, origin, kind, evidenceIds = [], evidence = []) {
    if (!['viewed', 'delivered', 'used-with-evidence'].includes(kind)) throw new Error('invalid skill usage kind');
    const used = kind === 'used-with-evidence';
    if (used && !Object.values(state.receipts ?? {}).some((receipt) => receipt.skillId === entry.skillId && receipt.relativePath === 'SKILL.md' && receipt.fullRead === true && receipt.revision === entry.revision && receipt.hash === entry.hash && JSON.stringify(receipt.origin) === JSON.stringify(origin))) throw new Error('skill adoption needs an actual complete main-file read in this origin and revision');
    if (used && (!Array.isArray(evidenceIds) || !evidenceIds.length || !Array.isArray(evidence) || evidenceIds.some((id) => typeof id !== 'string' || !id || !evidence.some((item) => item.evidenceId === id && JSON.stringify(bindOrigin(item.origin)) === JSON.stringify(origin) && item.kind === 'skill-use' && item.provenance === 'host-check' && item.status === 'success' && item.exitCode === 0 && item.skillId === entry.skillId && item.revision === entry.revision && typeof item.toolCallId === 'string' && item.toolCallId.trim().length > 0 && typeof item.toolName === 'string' && item.toolName.trim().length > 0)))) throw new Error('skill adoption evidence requires an explicit successful host check for this origin and exact skill revision');
    state.usageSeen ??= {};
    const key = JSON.stringify([origin, entry.skillId, kind, ...(used ? [entry.revision, ...[...new Set(evidenceIds)].sort()] : [])]);
    const usage = state.usage[entry.skillId] ?? { viewed: 0, delivered: 0, usedWithEvidence: 0 };
    if (!state.usageSeen[key]) {
      usage[used ? 'usedWithEvidence' : kind] += 1;
      usage.lastActivityAt = Date.now();
      state.usageSeen[key] = true;
    }
    state.usage[entry.skillId] = usage;
    entry.usage = { ...usage };
  }
  function entryDir(entry) {
    const base = entry.readOnly ? join(workspace, entry.source) : root;
    const path = join(base, entry.relativePath);
    if (!inside(base, path)) throw new Error('skill path escapes its root');
    return path;
  }
  const skillIdentity = (id, rel) => `skill:${sha(`${hostId}\0${workspaceId}\0${id}\0${rel}`)}`;
  function mutation(origin, lesson = '') {
    return { status: 'failed', batchId: `batch_${randomUUID()}`, origin, lesson, operationsApplied: 0, changes: [], riskReasons: [], createdAt: Date.now() };
  }
  async function prepare(input, origin, state, result) {
    const proposed = input.proposal;
    if (!proposed || proposed.version !== 1 || proposed.kind !== 'propose' || typeof proposed.lesson !== 'string' || !proposed.lesson.trim() || !Array.isArray(proposed.evidenceIds) || !Array.isArray(proposed.operations) || !proposed.operations.length || proposed.operations.length > 32) throw new Error('invalid skill proposal');
    exactKeys(proposed, ['version', 'kind', 'lesson', 'evidenceIds', 'operations'], 'proposal');
    if (proposed.operations.filter((operation) => operation?.action === 'create').length > 1) throw new Error('at most one new class-level skill create is allowed per batch');
    const listed = await catalog(state);
    const changes = [];
    const targets = new Set();
    for (const operation of proposed.operations) {
      if (!OPERATION_FIELDS[operation?.action]) throw new Error('unsupported skill operation');
      exactKeys(operation, OPERATION_FIELDS[operation.action], 'operation');
      let entry;
      let filePath = 'SKILL.md';
      let before = null;
      let after;
      let skillId;
      let name;
      let createPackage = false;
      if (operation.action === 'create') {
        validateSkillName(operation.name);
        const parsed = parseSkillFrontmatter(operation.content, '', { strict: true });
        if (parsed.name !== operation.name) throw new Error('skill name does not match its directory');
        name = operation.name;
        skillId = skillIdentity(rootId, name);
        const names = await readdir(root);
        if (names.some((item) => item.toLowerCase() === name.toLowerCase())) throw new Error('CAS conflict: skill already exists');
        after = operation.content;
        createPackage = true;
      } else {
        entry = listed.entries.find((item) => item.skillId === operation.skillId);
        if (!entry) throw new Error('skill not found in this workspace');
        if (entry.readOnly || entry.rootId !== rootId) throw new Error('external skill roots are read-only; import explicitly');
        name = entry.relativePath;
        skillId = entry.skillId;
        filePath = skillFilePath(operation.filePath);
        if (operation.action === 'write_file' && filePath === 'SKILL.md') throw new Error('write_file only supports supporting files; use a unique main patch');
        const target = join(root, name, filePath);
        try { before = (await readText(target, filePath === 'SKILL.md')).content; } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (before === null) {
          if (operation.action !== 'write_file' || operation.absent !== true) throw new Error('CAS conflict: target does not exist');
          if (operation.expectedHash !== undefined || operation.readReceiptId !== undefined) throw new Error('new file requires absent:true without existing-file preconditions');
        } else {
          if (operation.absent === true) throw new Error('CAS conflict: absent target already exists');
          const receipt = state.receipts[operation.readReceiptId];
          if (!receipt || JSON.stringify(receipt.origin) !== JSON.stringify(origin) || receipt.skillId !== skillId || receipt.relativePath !== filePath || receipt.fullRead !== true) throw new Error('fresh full-read receipt is required for this run and file');
          if (receipt.hash !== operation.expectedHash || receipt.revision !== entry.revision || operation.expectedHash !== sha(before)) throw new Error('CAS conflict: stale hash or read revision');
        }
        if (operation.action === 'patch') {
          if (typeof operation.oldString !== 'string' || !operation.oldString) throw new Error('patch requires a nonempty oldString');
          const index = before.indexOf(operation.oldString);
          if (index < 0 || before.indexOf(operation.oldString, index + 1) >= 0) throw new Error('patch oldString must match exactly once');
          if (typeof operation.newString !== 'string') throw new Error('patch newString must be text');
          if (!operation.newString.includes(operation.oldString)) result.riskReasons.push('patch removes/replaces an existing rule; explicit review required');
          after = before.slice(0, index) + operation.newString + before.slice(index + operation.oldString.length);
        } else if (operation.action === 'write_file') after = operation.content;
        else if (operation.action === 'remove_file') {
          if (filePath === 'SKILL.md') throw new Error('main skill file cannot be removed; archive the package');
          after = null;
          result.riskReasons.push('file removal requires approval');
        } else throw new Error('unsupported skill operation');
        if (!entry.autoEditable) result.riskReasons.push('target has not been authorized for automatic editing');
        if (entry.contentLocked) result.riskReasons.push('target content is locked');
        if (filePath !== 'SKILL.md' && !(filePath.startsWith('references/') && filePath.endsWith('.md'))) result.riskReasons.push('scripts/templates/assets and non-markdown references require approval');
        if (operation.action === 'write_file' && before !== null) result.riskReasons.push('whole-file rewriting requires approval');
      }
      if (after !== null && (typeof after !== 'string' || after.includes('\0') || after.length > (filePath === 'SKILL.md' ? MAX_MAIN_CHARS : MAX_SUPPORT_CHARS))) throw new Error('skill content exceeds limit or is not text');
      if (filePath === 'SKILL.md') {
        const parsed = parseSkillFrontmatter(after, '', { strict: true });
        if (parsed.name !== name) throw new Error('skill name does not match its directory');
        if (before !== null) {
          const prior = parseSkillFrontmatter(before, name);
          if (prior.name !== parsed.name || prior.description !== parsed.description) result.riskReasons.push('trigger scope/frontmatter change requires approval');
        }
      }
      if (before !== after && after !== null) result.riskReasons.push(...skillContentRisks(after));
      const target = `${name}/${filePath}`;
      if (targets.has(target.toLowerCase())) throw new Error('duplicate target in one skill batch');
      targets.add(target.toLowerCase());
      if (before !== after) changes.push({ skillId, name, filePath, before, after, beforeHash: before === null ? null : sha(before), afterHash: after === null ? null : sha(after), target, createPackage, phase: 'staged' });
    }
    for (const name of new Set(changes.map((change) => change.name))) {
      const snapshot = new Map();
      const entry = listed.entries.find((item) => item.relativePath === name && item.rootId === rootId);
      if (entry) for (const filePath of entry.files) snapshot.set(filePath, (await readText(join(entryDir(entry), filePath), filePath === 'SKILL.md')).content);
      for (const change of changes.filter((change) => change.name === name)) {
        if (change.after === null) snapshot.delete(change.filePath); else snapshot.set(change.filePath, change.after);
      }
      validatePackageLinks(snapshot);
    }
    return changes;
  }
  function validateIntent(intent, batchId) {
    if (intent?.version !== 1 || intent.batchId !== batchId || !/^batch_[a-f0-9-]{36}$/.test(batchId) || !Array.isArray(intent.operations) || intent.operations.length > 400 || !intent.result || intent.result.batchId !== batchId) throw new Error('invalid durable skill intent');
    const origin = bindOrigin(intent.origin);
    if (JSON.stringify(bindOrigin(intent.result.origin)) !== JSON.stringify(origin)) throw new Error('invalid durable intent origin');
    const targets = new Set();
    for (const operation of intent.operations) {
      validateSegment(operation.name);
      if (operation.name.startsWith('.') || operation.skillId !== skillIdentity(rootId, operation.name) || operation.target !== `${operation.name}/${skillFilePath(operation.filePath)}` || !inside(root, join(root, operation.target))) throw new Error('invalid durable intent target');
      if (targets.has(operation.target.toLowerCase())) throw new Error('invalid duplicate durable intent target');
      targets.add(operation.target.toLowerCase());
      for (const key of ['before', 'after']) if (operation[key] !== null && typeof operation[key] !== 'string') throw new Error('invalid durable intent text');
      if (operation.beforeHash !== (operation.before === null ? null : sha(operation.before)) || operation.afterHash !== (operation.after === null ? null : sha(operation.after))) throw new Error('invalid durable intent hash');
      if (operation.undoPath !== undefined && !/^undo-[0-9]+-[a-f0-9-]{36}$/.test(operation.undoPath)) throw new Error('invalid recovery reservation path');
      if (!['staged', 'reserving', 'reserved', 'installed', 'applied', 'recovering', 'recovered'].includes(operation.phase)) throw new Error('invalid durable intent phase');
    }
    if (intent.move) {
      const move = intent.move;
      validateSegment(move.entry?.relativePath);
      if (move.entry.skillId !== skillIdentity(rootId, move.entry.relativePath) || !move.storage?.startsWith('.state/archives/') || move.storage.split('/').length !== 4 || !/^batch_[a-f0-9-]{36}$/.test(move.storage.split('/')[2]) || move.storage.split('/')[3] !== move.entry.relativePath) throw new Error('invalid durable package intent');
      const from = move.restoring ? move.storage : move.entry.relativePath;
      const to = move.restoring ? move.entry.relativePath : move.storage;
      if (move.from !== from || move.to !== to || !Array.isArray(move.snapshot?.files) || !Array.isArray(move.snapshot?.directories)) throw new Error('invalid durable package intent target');
      for (const path of [...move.snapshot.directories, ...move.snapshot.files.map((file) => file.filePath)]) {
        if (typeof path !== 'string') throw new Error('invalid durable package snapshot path');
        path.split('/').forEach(validateSegment);
        if (!inside(root, join(root, path))) throw new Error('invalid durable package snapshot target');
      }
    }
  }

  async function applyIntent(intent, transactionDir, state) {
    validateIntent(intent, basename(transactionDir));
    for (let index = 0; index < intent.operations.length; index += 1) {
      const operation = intent.operations[index];
      await faultInjector?.({ point: 'before_operation', index, batchId: intent.batchId });
      const target = join(root, operation.target);
      await assertSafeSkillPath(target, { allowMissing: true });
      operation.phase = 'reserving';
      await durableJson(join(transactionDir, 'intent.json'), intent);
      if (operation.createPackage) {
        try { await mkdir(dirname(target)); } catch (error) { if (error.code === 'EEXIST') throw new Error('CAS conflict: skill appeared during commit'); throw error; }
        operation.createdPackage = true;
      } else {
        await mkdir(dirname(target), { recursive: true });
        if (operation.beforeHash !== null) {
          await rename(target, join(transactionDir, `reserved-${index}`));
          operation.reserved = true;
          const reserved = await readText(join(transactionDir, `reserved-${index}`), operation.filePath === 'SKILL.md');
          if (reserved.hash !== operation.beforeHash) throw new Error('CAS conflict: target changed during commit');
        }
      }
      operation.phase = 'reserved';
      await durableJson(join(transactionDir, 'intent.json'), intent);
      try {
        if (operation.afterHash !== null) await link(join(transactionDir, `stage-${index}`), target);
      } catch (error) { if (error.code === 'EEXIST') throw new Error('CAS conflict: target appeared during commit'); throw error; }
      operation.phase = 'installed';
      await durableJson(join(transactionDir, 'intent.json'), intent);
      const readback = await readText(target, operation.filePath === 'SKILL.md').catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
      if ((readback?.hash ?? null) !== operation.afterHash) throw new Error('skill readback hash mismatch');
      operation.phase = 'applied';
      await durableJson(join(transactionDir, 'intent.json'), intent);
    }
    for (const operation of intent.operations) if (operation.createPackage) state.policies[operation.skillId] = { autoEditable: intent.kind !== 'import', contentLocked: false, pinned: false };
  }
  async function recoverIntent(intent, transactionDir) {
    validateIntent(intent, basename(transactionDir));
    for (let index = intent.operations.length - 1; index >= 0; index -= 1) {
      const operation = intent.operations[index];
      if (operation.phase === 'staged' || operation.phase === 'recovered') continue;
      await faultInjector?.({ point: 'before_recovery', index, batchId: intent.batchId });
      const target = join(root, operation.target);
      await assertSafeSkillPath(target, { allowMissing: true });
      const reservedPath = join(transactionDir, `reserved-${index}`);
      const reservedInfo = await lstat(reservedPath).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
      const current = await readText(target, operation.filePath === 'SKILL.md').catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
      let undo = operation.undoPath ? await readText(join(transactionDir, operation.undoPath), operation.filePath === 'SKILL.md').catch((error) => { if (error.code === 'ENOENT') return null; throw error; }) : null;
      operation.phaseBeforeRecovery ??= operation.phase;
      operation.phase = 'recovering';
      await durableJson(join(transactionDir, 'intent.json'), intent);
      if (undo && undo.hash !== operation.afterHash) {
        if (!current) {
          try { await installRecoveryCopy(join(transactionDir, operation.undoPath), target, operation.filePath === 'SKILL.md'); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        }
        throw new Error('recovery conflict: external file changed during reservation; backups retained');
      }
      if (current && current.hash !== operation.afterHash && current.hash !== operation.beforeHash) throw new Error('recovery conflict: external file change; backups retained');
      if (current && current.hash === operation.afterHash) {
        if (undo) throw new Error('recovery conflict: target reappeared after reservation; backups retained');
        operation.undoPath ??= `undo-${index}-${randomUUID()}`;
        await durableJson(join(transactionDir, 'intent.json'), intent);
        const undoPath = join(transactionDir, operation.undoPath);
        await rename(target, undoPath);
        undo = await readText(undoPath, operation.filePath === 'SKILL.md');
        if (undo.hash !== operation.afterHash) {
          try { await installRecoveryCopy(undoPath, target, operation.filePath === 'SKILL.md'); } catch (error) { if (error.code !== 'EEXIST') throw error; }
          throw new Error('recovery conflict: external file changed during reservation; backups retained');
        }
      }
      if (reservedInfo) {
        if (current?.hash !== operation.beforeHash) {
          try { await installRecoveryCopy(reservedPath, target, operation.filePath === 'SKILL.md'); } catch (error) { if (error.code !== 'EEXIST') throw error; throw new Error('recovery conflict: target appeared; backup retained'); }
        }
      } else if (operation.beforeHash !== null && current?.hash !== operation.beforeHash) throw new Error('recovery backup missing');
      const restored = await readText(target, operation.filePath === 'SKILL.md').catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
      if ((restored?.hash ?? null) !== operation.beforeHash) throw new Error('recovery readback hash mismatch');
      if (operation.createdPackage) await rm(dirname(target), { recursive: false }).catch(() => {});
      operation.phase = 'recovered';
      await durableJson(join(transactionDir, 'intent.json'), intent);
    }
  }
  async function manage(input, origin, state) {
    const result = mutation(origin, input.proposal?.lesson);
    let intent;
    let transactionDir;
    try {
      if (input.mode === 'off') { result.status = 'cancelled'; result.error = 'skill learning is off'; }
      else {
        const operations = await prepare(input, origin, state, result);
        result.changes = operations.map(({ target, createPackage, phase, ...change }) => change);
        if (!operations.length) result.status = 'noop';
        else {
          transactionDir = join(stateDir, 'transactions', result.batchId);
          await mkdir(transactionDir, { recursive: true });
          intent = { version: 1, batchId: result.batchId, origin, status: 'prepared', operations, result };
          for (let index = 0; index < operations.length; index += 1) {
            if (operations[index].after === null) continue;
            const handle = await open(join(transactionDir, `stage-${index}`), 'wx', 0o600);
            try { await handle.writeFile(operations[index].after); await handle.sync(); } finally { await handle.close(); }
          }
          const selected = new Set(input.proposal.evidenceIds);
          const verified = (input.evidence ?? []).some((item) => selected.has(item.evidenceId) && sameEvidenceSession(item.origin, origin) && realLearningEvidence(item));
          if (!verified) result.riskReasons.push('insufficient verified evidence');
          if (input.mode === 'approve-all') result.riskReasons.push('all changes require approval');
          result.riskReasons = [...new Set(result.riskReasons)];
          if (result.riskReasons.length) { result.status = 'awaiting_approval'; intent.status = 'awaiting_approval'; }
          await durableJson(join(transactionDir, 'intent.json'), intent);
          if (!result.riskReasons.length) {
            await applyIntent(intent, transactionDir, state);
            result.status = 'applied';
            result.operationsApplied = operations.length;
            result.rollbackId = `rollback_${result.batchId}`;
            result.revision = (await catalog(state)).revision;
            intent.status = 'applied';
            await durableJson(join(transactionDir, 'intent.json'), intent);
          }
        }
      }
    } catch (error) {
      result.error = error.message;
      result.status = error.message.startsWith('CAS conflict') ? 'conflicted' : 'failed';
      result.operationsApplied = 0;
      if (intent) {
        try { await recoverIntent(intent, transactionDir); }
        catch (recoveryError) { result.status = 'needs_recovery'; result.error += `; ${recoveryError.message}`; }
        intent.status = result.status;
        await durableJson(join(transactionDir, 'intent.json'), intent);
      }
    }
    state.history.push(result);
    await saveState(state);
    return result;
  }
  async function approve(input, state) {
    if (typeof input.batchId !== 'string' || !/^batch_[a-f0-9-]{36}$/.test(input.batchId)) throw new Error('invalid approval batchId');
    const transactionDir = join(stateDir, 'transactions', input.batchId);
    await assertSafeSkillPath(join(transactionDir, 'intent.json'));
    const intent = JSON.parse(await readFile(join(transactionDir, 'intent.json'), 'utf8'));
    bindOrigin(intent.origin);
    const result = intent.result;
    if (intent.status !== 'awaiting_approval') return result;
    try {
      validateIntent(intent, input.batchId);
      // Legacy intents predate the proposal budget. Count actual absent-before
      // main packages, not a stored proposal or its createPackage flags. Keep
      // this approval-only: recovery must still undo already-dispatched bytes.
      const newPackages = new Set(intent.operations.filter((operation) =>
        operation.filePath === 'SKILL.md' && operation.beforeHash === null && operation.afterHash !== null
      ).map((operation) => operation.name.toLowerCase()));
      if (newPackages.size > 1) throw new Error('at most one new class-level skill create is allowed per batch');
      const listed = await catalog(state);
      for (const operation of intent.operations) {
        const entry = listed.entries.find((item) => item.skillId === operation.skillId);
        if (!operation.createPackage && (!entry || entry.readOnly || entry.rootId !== rootId)) throw new Error('skill root is no longer writable');
        if (entry?.contentLocked) throw new Error('skill content is locked');
        const current = await readText(join(root, operation.target), operation.filePath === 'SKILL.md').catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
        if ((current?.hash ?? null) !== operation.beforeHash) throw new Error('CAS conflict: pending approval target changed');
      }
      intent.status = 'prepared';
      await durableJson(join(transactionDir, 'intent.json'), intent);
      await applyIntent(intent, transactionDir, state);
      result.status = 'applied';
      result.operationsApplied = intent.operations.length;
      result.rollbackId = `rollback_${result.batchId}`;
      result.revision = (await catalog(state)).revision;
    } catch (error) {
      result.status = error.message.startsWith('CAS conflict') ? 'conflicted' : 'failed';
      result.error = error.message;
      result.operationsApplied = 0;
      try { await recoverIntent(intent, transactionDir); } catch (recoveryError) { result.status = 'needs_recovery'; result.error += `; ${recoveryError.message}`; }
    }
    intent.status = result.status;
    await durableJson(join(transactionDir, 'intent.json'), intent);
    state.history = state.history.filter((item) => item.batchId !== result.batchId);
    state.history.push(result);
    await saveState(state);
    return result;
  }
  async function reject(input, state) {
    if (typeof input.batchId !== 'string' || !/^batch_[a-f0-9-]{36}$/.test(input.batchId)) throw new Error('invalid rejection batchId');
    const transactionDir = join(stateDir, 'transactions', input.batchId);
    const intentPath = join(transactionDir, 'intent.json');
    await assertSafeSkillPath(intentPath);
    const intent = JSON.parse(await readFile(intentPath, 'utf8'));
    bindOrigin(intent.origin);
    if (intent.status !== 'awaiting_approval') return intent.result;
    intent.status = 'rejected';
    intent.result.status = 'rejected';
    intent.result.operationsApplied = 0;
    await durableJson(intentPath, intent);
    state.history = state.history.filter((item) => item.batchId !== input.batchId);
    state.history.push(intent.result);
    await saveState(state);
    return intent.result;
  }
  async function rollback(input, origin, state) {
    if (typeof input.rollbackId !== 'string' || !/^rollback_batch_[a-f0-9-]{36}$/.test(input.rollbackId)) throw new Error('invalid rollbackId');
    const originalDir = join(stateDir, 'transactions', input.rollbackId.slice('rollback_'.length));
    await assertSafeSkillPath(join(originalDir, 'intent.json'));
    const original = JSON.parse(await readFile(join(originalDir, 'intent.json'), 'utf8'));
    bindOrigin(original.origin);
    const result = mutation(origin, `Rollback: ${original.result.lesson}`);
    let intent;
    let transactionDir;
    try {
      if (original.status !== 'applied') throw new Error('only an applied batch can be rolled back');
      const operations = [];
      for (const operation of original.operations.slice().reverse()) {
        const current = await readText(join(root, operation.target), operation.filePath === 'SKILL.md').catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
        if ((current?.hash ?? null) !== operation.afterHash) throw new Error('CAS conflict: rollback target changed');
        operations.push({ ...operation, before: operation.after, after: operation.before, beforeHash: operation.afterHash, afterHash: operation.beforeHash, createPackage: false, createdPackage: false, reserved: false, phase: 'staged' });
      }
      result.changes = operations.map(({ skillId, name, filePath, before, after, beforeHash, afterHash }) => ({ skillId, name, filePath, before, after, beforeHash, afterHash }));
      transactionDir = join(stateDir, 'transactions', result.batchId);
      await mkdir(transactionDir, { recursive: true });
      intent = { version: 1, batchId: result.batchId, origin, status: 'prepared', operations, result };
      for (let index = 0; index < operations.length; index += 1) if (operations[index].after !== null) {
        const handle = await open(join(transactionDir, `stage-${index}`), 'wx', 0o600);
        try { await handle.writeFile(operations[index].after); await handle.sync(); } finally { await handle.close(); }
      }
      await durableJson(join(transactionDir, 'intent.json'), intent);
      await applyIntent(intent, transactionDir, state);
      result.status = 'applied';
      result.operationsApplied = operations.length;
      result.rollbackId = `rollback_${result.batchId}`;
      result.revision = (await catalog(state)).revision;
      intent.status = 'applied';
      await durableJson(join(transactionDir, 'intent.json'), intent);
    } catch (error) {
      result.error = error.message;
      result.status = error.message.startsWith('CAS conflict') ? 'conflicted' : 'failed';
      if (intent) { try { await recoverIntent(intent, transactionDir); } catch (recoveryError) { result.status = 'needs_recovery'; result.error += `; ${recoveryError.message}`; } intent.status = result.status; await durableJson(join(transactionDir, 'intent.json'), intent); }
    }
    state.history.push(result);
    await saveState(state);
    return result;
  }
  async function importSkill(input, origin, state, listed) {
    const source = listed.entries.find((entry) => entry.skillId === input.sourceSkillId);
    if (!source || !source.readOnly || source.scope !== 'external') throw new Error('import source must be a discovered read-only project package');
    const name = source.relativePath;
    validateSegment(name);
    const skillId = skillIdentity(rootId, name);
    if ((await readdir(root)).some((item) => item.toLowerCase() === name.toLowerCase())) throw new Error('CAS conflict: imported skill already exists');
    const result = mutation(origin, `Import ${source.name} from ${source.source}.`);
    const transactionDir = join(stateDir, 'transactions', result.batchId);
    await assertSafeSkillPath(transactionDir, { allowMissing: true });
    await mkdir(transactionDir, { recursive: true });
    const operations = [];
    for (const filePath of source.files) {
      const after = (await readText(join(entryDir(source), filePath), filePath === 'SKILL.md')).content;
      operations.push({ skillId, name, filePath, before: null, after, beforeHash: null, afterHash: sha(after), target: `${name}/${filePath}`, createPackage: filePath === 'SKILL.md', phase: 'staged' });
    }
    operations.sort((a, b) => (a.filePath === 'SKILL.md' ? -1 : b.filePath === 'SKILL.md' ? 1 : a.filePath.localeCompare(b.filePath)));
    const intent = { version: 1, kind: 'import', batchId: result.batchId, origin, status: 'prepared', operations, result, sourceSkillId: source.skillId, sourceRevision: source.revision };
    result.changes = operations.map(({ skillId, name, filePath, before, after, beforeHash, afterHash }) => ({ skillId, name, filePath, before, after, beforeHash, afterHash }));
    for (let index = 0; index < operations.length; index += 1) {
      const handle = await open(join(transactionDir, `stage-${index}`), 'wx', 0o600);
      try { await handle.writeFile(operations[index].after); await handle.sync(); } finally { await handle.close(); }
    }
    await durableJson(join(transactionDir, 'intent.json'), intent);
    try {
      if ((await catalog(state)).entries.find((entry) => entry.skillId === source.skillId)?.revision !== source.revision) throw new Error('CAS conflict: import source changed');
      await applyIntent(intent, transactionDir, state);
      result.status = 'applied';
      result.operationsApplied = operations.length;
      result.rollbackId = `rollback_${result.batchId}`;
      result.revision = (await catalog(state)).revision;
      intent.status = 'applied';
      await durableJson(join(transactionDir, 'intent.json'), intent);
      state.history.push(result);
      await saveState(state);
      return (await catalog(state)).entries.find((entry) => entry.skillId === skillId);
    } catch (error) {
      result.status = error.message.startsWith('CAS conflict') ? 'conflicted' : 'failed';
      result.error = error.message;
      result.operationsApplied = 0;
      try { await recoverIntent(intent, transactionDir); } catch (recoveryError) { result.status = 'needs_recovery'; result.error += `; ${recoveryError.message}`; }
      intent.status = result.status;
      await durableJson(join(transactionDir, 'intent.json'), intent);
      state.history.push(result);
      await saveState(state);
      throw error;
    }
  }
  async function archiveOrRestore(input, origin, state, listed) {
    const restoring = input.action === 'restore';
    state.archives ??= {};
    const stored = state.archives[input.skillId];
    const entry = restoring ? stored?.entry : listed.entries.find((item) => item.skillId === input.skillId);
    if (!entry || entry.readOnly) throw new Error('archive target is not a managed skill in this workspace');
    if (!restoring && (entry.pinned || entry.contentLocked)) throw new Error('pinned or content-locked skill cannot be archived');
    const result = mutation(origin, restoring ? 'Restore archived skill package.' : 'Archive managed skill package.');
    const transactionDir = join(stateDir, 'transactions', result.batchId);
    await assertSafeSkillPath(transactionDir, { allowMissing: true });
    await mkdir(transactionDir, { recursive: true });
    const from = restoring ? join(root, stored.storage) : entryDir(entry);
    const storage = `.state/archives/${result.batchId}/${entry.relativePath}`;
    const to = restoring ? join(root, entry.relativePath) : join(root, storage);
    await assertSafeSkillPath(from);
    await assertSafeSkillPath(to, { allowMissing: true });
    if (await lstat(to).catch((error) => { if (error.code === 'ENOENT') return null; throw error; })) throw new Error('CAS conflict: archive/restore destination exists');
    const snapshot = await fullPackageSnapshot(from);
    const move = { from: relative(root, from).split(sep).join('/'), to: relative(root, to).split(sep).join('/'), snapshot, entry, restoring, storage: restoring ? stored.storage : storage, phase: 'prepared' };
    const intent = { version: 1, batchId: result.batchId, origin, status: 'prepared', operations: [], move, result };
    await durableJson(join(transactionDir, 'intent.json'), intent);
    try {
      await mkdir(dirname(to), { recursive: true });
      if (restoring) {
        // Exclusive directory creation + exclusive hard links cannot clobber a
        // concurrent external destination. Keep the source until full readback.
        await mkdir(to);
        move.phase = 'installing';
        await durableJson(join(transactionDir, 'intent.json'), intent);
        for (const dir of snapshot.directories) await mkdir(join(to, dir), { recursive: true });
        for (const file of snapshot.files) { await assertSafeSkillPath(join(to, file.filePath), { allowMissing: true }); await link(join(from, file.filePath), join(to, file.filePath)); }
      } else {
        await rename(from, to); // destination is a private unique transaction slot
        move.phase = 'moved';
        await durableJson(join(transactionDir, 'intent.json'), intent);
      }
      await faultInjector?.({ point: 'after_package_move', batchId: result.batchId, restoring });
      if (JSON.stringify(await fullPackageSnapshot(to)) !== JSON.stringify(snapshot)) throw new Error('archive/restore readback mismatch');
      if (restoring) delete state.archives[entry.skillId];
      else state.archives[entry.skillId] = { storage, entry: { ...entry, state: 'archived' } };
      result.status = 'applied';
      intent.status = 'applied';
      move.phase = 'applied';
      await durableJson(join(transactionDir, 'intent.json'), intent);
      state.history.push(result);
      await saveState(state);
      return { ...entry, state: restoring ? 'active' : 'archived' };
    } catch (error) {
      result.status = 'failed';
      result.error = error.message;
      try { await recoverPackageMove(intent, transactionDir, state); }
      catch (recoveryError) { result.status = 'needs_recovery'; result.error += `; ${recoveryError.message}`; }
      intent.status = result.status;
      await durableJson(join(transactionDir, 'intent.json'), intent);
      state.history.push(result);
      await saveState(state);
      throw error;
    }
  }
  async function recoverPackageMove(intent, transactionDir, state) {
    validateIntent(intent, basename(transactionDir));
    const move = intent.move;
    const from = join(root, move.from);
    const to = join(root, move.to);
    if (!inside(root, from) || !inside(root, to)) throw new Error('invalid package recovery target');
    await assertSafeSkillPath(from, { allowMissing: true });
    await assertSafeSkillPath(to, { allowMissing: true });
    const sourceExists = await lstat(from).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    const targetExists = await lstat(to).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (move.restoring) {
      if (!sourceExists || JSON.stringify(await fullPackageSnapshot(from)) !== JSON.stringify(move.snapshot)) throw new Error('restore source changed; backups retained');
      if (targetExists) {
        const current = await fullPackageSnapshot(to);
        const expected = new Map(move.snapshot.files.map((item) => [item.filePath, item.hash]));
        if (current.files.some((item) => expected.get(item.filePath) !== item.hash) || current.directories.some((dir) => !move.snapshot.directories.includes(dir))) throw new Error('restore destination changed; backups retained');
        await rename(to, join(transactionDir, `recovered-package-${randomUUID()}`));
      }
    } else if (!sourceExists && targetExists) {
      if (JSON.stringify(await fullPackageSnapshot(to)) !== JSON.stringify(move.snapshot)) throw new Error('archive source changed; backups retained');
      await mkdir(from); // do not overwrite a concurrently recreated package
      for (const dir of move.snapshot.directories) await mkdir(join(from, dir), { recursive: true });
      for (const file of move.snapshot.files) await link(join(to, file.filePath), join(from, file.filePath));
      if (JSON.stringify(await fullPackageSnapshot(from)) !== JSON.stringify(move.snapshot)) throw new Error('archive recovery readback mismatch');
    } else if (!sourceExists || JSON.stringify(await fullPackageSnapshot(from)) !== JSON.stringify(move.snapshot)) throw new Error('archive recovery conflict; backups retained');
    if (move.restoring) state.archives[move.entry.skillId] = { storage: move.storage, entry: { ...move.entry, state: 'archived' } };
    else delete state.archives[move.entry.skillId];
    move.phase = 'recovered';
    await durableJson(join(transactionDir, 'intent.json'), intent);
  }
  async function recoverPending(state) {
    const transactions = join(stateDir, 'transactions');
    await assertSafeSkillPath(transactions, { allowMissing: true });
    const names = await readdir(transactions, { withFileTypes: true }).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
    const blocked = [];
    const pendingNames = [];
    for (const name of names) {
      const path = join(transactions, name.name, 'intent.json');
      await assertSafeSkillPath(path, { allowMissing: true });
      const value = await readFile(path, 'utf8').then(JSON.parse).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
      pendingNames.push({ name, createdAt: value?.result?.createdAt ?? 0 });
    }
    for (const { name } of pendingNames.sort((a, b) => a.createdAt - b.createdAt || a.name.name.localeCompare(b.name.name))) {
      if (!name.isDirectory() || !/^batch_[a-f0-9-]{36}$/.test(name.name)) throw new Error('invalid transaction directory; manual recovery required');
      const transactionDir = join(transactions, name.name);
      const intentPath = join(transactionDir, 'intent.json');
      await assertSafeSkillPath(intentPath, { allowMissing: true });
      const intent = await readFile(intentPath, 'utf8').then(JSON.parse).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
      if (!intent) continue; // staging-only orphan never touched a target
      validateIntent(intent, name.name);
      if (['prepared', 'needs_recovery'].includes(intent.status)) {
        try {
          if (intent.move) { state.archives ??= {}; await recoverPackageMove(intent, transactionDir, state); }
          else await recoverIntent(intent, transactionDir);
          intent.status = 'failed';
          intent.result.status = 'failed';
          intent.result.error = 'interrupted skill transaction was recovered';
        } catch (error) {
          intent.status = 'needs_recovery';
          intent.result.status = 'needs_recovery';
          intent.result.error = `skill transaction needs recovery: ${error.message}`;
          blocked.push(intent.batchId);
        }
        intent.result.operationsApplied = 0;
        await durableJson(intentPath, intent);
      }
      if (intent.status === 'applied' && intent.move && !state.history.some((item) => item.batchId === intent.batchId && item.status === 'applied')) {
        state.archives ??= {};
        if (intent.move.restoring) delete state.archives[intent.move.entry.skillId];
        else state.archives[intent.move.entry.skillId] = { storage: intent.move.storage, entry: { ...intent.move.entry, state: 'archived' } };
      }
      if (intent.status === 'applied') for (const operation of intent.operations) if (operation.createPackage && !state.policies[operation.skillId]) state.policies[operation.skillId] = { autoEditable: intent.kind !== 'import', contentLocked: false, pinned: false };
      if (!state.history.some((item) => item.batchId === intent.batchId && JSON.stringify(item) === JSON.stringify(intent.result))) {
        state.history = state.history.filter((item) => item.batchId !== intent.batchId);
        state.history.push(intent.result);
      }
    }
    if (names.length) await saveState(state);
    return blocked;
  }
  async function syncCandidateControl(input, result, state) {
    if (!['applied', 'rejected', 'conflicted'].includes(result.status)) return result;
    try {
      const before = await candidates.load();
      const originalBatch = input.action === 'rollback' ? input.rollbackId.slice('rollback_'.length) : input.batchId;
      const matches = before.candidates.filter((candidate) => candidate.submission?.batchId === originalBatch &&
        (input.action !== 'rollback' || candidate.submission.rollbackId === input.rollbackId));
      if (!matches.length) return result; // Explicit controls may have no candidate.
      if (matches.length !== 1 || (input.action !== 'rollback' && result.batchId !== originalBatch)) throw new Error('SKILL_CANDIDATE_CONTROL_TARGET_MISMATCH');
      const candidate = matches[0];
      const submission = candidate.submission;
      const nextState = input.action === 'rollback' && result.status === 'applied' ? 'rolled_back'
        : result.status === 'applied' ? 'applied' : result.status === 'rejected' ? 'rejected' : 'conflicted';
      if (submission.state === nextState) return result; // Idempotent observation.
      const allowed = submission.state === 'staged' ? ['applied', 'rejected', 'conflicted']
        : submission.state === 'applied' ? ['rolled_back', 'conflicted'] : [];
      const targetRevision = result.revision || submission.targetRevision;
      if (!allowed.includes(nextState) || typeof targetRevision !== 'string' || !targetRevision) throw new Error('SKILL_CANDIDATE_INVALID_TRANSITION');
      candidate.submitted = true;
      candidate.submission = { ...submission, state: nextState, targetRevision,
        ...(result.rollbackId ? { rollbackId: result.rollbackId } : {}) };
      // Exact-revision CAS; no retries, automatic reopen or source erasure.
      await candidates.compareAndSwap(before.revision ?? 0, before);
      const saved = await candidates.load();
      const actual = saved.candidates.find((item) => item.id === candidate.id);
      if ((saved.revision ?? 0) <= (before.revision ?? 0) || actual?.submitted !== true ||
        JSON.stringify(actual.sources) !== JSON.stringify(candidate.sources) ||
        JSON.stringify(actual.submission) !== JSON.stringify(candidate.submission)) throw new Error('SKILL_CANDIDATE_CONTROL_UNCONFIRMED');
    } catch (error) {
      // Auxiliary state never replaces a host-confirmed commit/undo with failure.
      result.riskReasons = [...new Set([...result.riskReasons, `candidate submission sync failed: ${error.message}`])];
      // recoverPending rebuilds history from durable intents on every request;
      // keep this auxiliary diagnostic with that receipt, not only state.json.
      try {
        const intentPath = join(stateDir, 'transactions', result.batchId, 'intent.json');
        await assertSafeSkillPath(intentPath);
        const persisted = JSON.parse(await readFile(intentPath, 'utf8'));
        validateIntent(persisted, result.batchId);
        if (persisted.result.status === result.status) {
          persisted.result.riskReasons = result.riskReasons;
          await durableJson(intentPath, persisted);
        }
      } catch { /* Diagnostic persistence cannot invalidate a confirmed commit. */ }
      state.history = state.history.filter((item) => item.batchId !== result.batchId);
      state.history.push(result);
      await saveState(state).catch(() => {}); // Best-effort diagnostic only.
    }
    return result;
  }
  async function request(input) {
    const origin = bindOrigin(input?.origin);
    const run = chain.then(async () => {
      await assertSafeSkillPath(workspace);
      await assertSafeSkillPath(stateDir, { allowMissing: true });
      await mkdir(stateDir, { recursive: true });
      await assertSafeSkillPath(stateDir);
      const release = await acquireRootLock(stateDir, lockTimeoutMs);
      try {
      const state = await loadState();
      const blocked = await recoverPending(state);
      if (input.action === 'history') return { results: state.history };
      if (blocked.length) { const error = new Error(`skill root needs_recovery; retained backups: ${blocked.join(', ')}`); error.code = 'SKILL_NEEDS_RECOVERY'; throw error; }
      if (input.action === 'manage') {
        const config = remoteSkillConfig(state.config ?? {});
        const mode = !config.enabled || config.mode === 'off' || input.mode === 'off' ? 'off'
          : config.mode === 'approve-all' || input.mode === 'approve-all' ? 'approve-all' : 'auto-safe';
        return await manage({ ...input, mode }, origin, state);
      }
      if (input.action === 'approve') return await syncCandidateControl(input, await approve(input, state), state);
      if (input.action === 'reject') return await syncCandidateControl(input, await reject(input, state), state);
      if (input.action === 'rollback') return await syncCandidateControl(input, await rollback(input, origin, state), state);
      const listed = await catalog(state);
      if (input.action === 'import') return await importSkill(input, origin, state, listed);
      if (input.action === 'archive' || input.action === 'restore') return await archiveOrRestore(input, origin, state, listed);
      if (input.action === 'list') return listed;
      if (input.action === 'set_policy') {
        const entry = listed.entries.find((item) => item.skillId === input.skillId);
        if (!entry || entry.readOnly) throw new Error('policy target is not a managed skill in this workspace');
        exactKeys(input.policy, ['autoEditable', 'contentLocked', 'pinned'], 'skill policy');
        for (const value of Object.values(input.policy)) if (typeof value !== 'boolean') throw new Error('skill policy values must be boolean');
        const prior = state.policies[entry.skillId] ?? {};
        state.policies[entry.skillId] = { ...prior, ...input.policy };
        const result = mutation(origin, 'Update skill owner policy.');
        result.status = JSON.stringify(state.policies[entry.skillId]) === JSON.stringify(prior) ? 'noop' : 'applied';
        result.revision = (await catalog(state)).revision;
        state.history.push(result);
        await saveState(state);
        return (await catalog(state)).entries.find((item) => item.skillId === entry.skillId);
      }
      if (input.action === 'usage') {
        const entry = listed.entries.find((item) => item.skillId === input.skillId);
        if (!entry) throw new Error('usage target is not a skill in this workspace');
        addUsage(state, entry, origin, input.kind, input.evidenceIds, input.evidence);
        await saveState(state);
        return entry;
      }
      if (input.action !== 'view') throw new Error(`unsupported skill action: ${input.action}`);
      const entry = listed.entries.find((item) => item.skillId === input.skillId);
      if (!entry) throw new Error('skill not found in this workspace');
      const filePath = skillFilePath(input.filePath);
      const archive = entry.state === 'archived' ? state.archives[entry.skillId] : null;
      const text = await readText(join(archive ? join(root, archive.storage) : entryDir(entry), filePath), filePath === 'SKILL.md');
      const readReceiptId = `read_${randomUUID()}`;
      if (filePath === 'SKILL.md') addUsage(state, entry, origin, 'viewed');
      state.receipts[readReceiptId] = { origin, skillId: entry.skillId, relativePath: filePath, revision: entry.revision, hash: text.hash, fullRead: true };
      await saveState(state);
      return { entry, relativePath: filePath, content: text.content, revision: entry.revision, hash: text.hash, fullRead: true, readReceiptId, files: entry.files };
      } finally { await release(); }
    });
    chain = run.catch(() => {});
    return run;
  }
  async function configRequest(value) {
    const run = chain.then(async () => {
      await assertSafeSkillPath(stateDir, { allowMissing: true });
      await mkdir(stateDir, { recursive: true });
      await assertSafeSkillPath(stateDir);
      const release = await acquireRootLock(stateDir, lockTimeoutMs);
      try {
        const state = await loadState();
        const config = remoteSkillConfig(value ?? {}, remoteSkillConfig(state.config ?? {}));
        if (value !== undefined) { state.config = config; await saveState(state); }
        return structuredClone(config);
      } finally { await release(); }
    });
    chain = run.catch(() => {});
    return run;
  }
  return { request, getConfig: () => configRequest(), setConfig: (value) => configRequest(value) };
}
