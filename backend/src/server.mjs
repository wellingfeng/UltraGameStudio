#!/usr/bin/env node
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeAuthorizer } from './auth.mjs';
import { hashPassword, verifyPassword } from './password.mjs';
import {
  authenticateJwtHeader,
  issueSession,
  makeJwtSecret,
  refreshSession,
  revokeSession,
} from './session.mjs';
import {
  createUser,
  findUserByEmail,
  publicUser,
  setEmailVerified,
  updatePassword,
} from './users.mjs';
import {
  VERIFICATION_PURPOSE_EMAIL,
  VERIFICATION_PURPOSE_PASSWORD_RESET,
  issueVerification,
  verifyCode,
} from './verification.mjs';
import { makeMailer } from './mailer.mjs';
import { JsonStore } from './store.mjs';
import { JobRunner } from './runner.mjs';
import * as git from './git.mjs';
import {
  detectEnvironment,
  ensureGitReadyForSync,
  installEnvironment,
} from './environment.mjs';
import { supportedAdapters } from './models.mjs';
import { AccountRegistry, loadAccountsFromEnv, normalizeAccount } from './accounts.mjs';
import { summarizeJobs, summarizeLedger } from './usage.mjs';
import {
  listWorkspaceDirectory,
  previewWorkspaceFile,
  saveWorkspaceUpload,
} from './workspace-files.mjs';
import { createWorkspaceSkillService, assertSafeSkillPath } from './workspace-skill-service.mjs';
import { createSkillCandidateService } from './skill-candidate-service.mjs';
import { listWorkspaceSkills } from './workspace-skills.mjs';
import {
  readUserSettingJson,
  removeUserSetting,
  userSettingsRoot,
  writeUserSettingJson,
} from './user-settings.mjs';
import {
  assertWorkspaceBoundary,
  projectWorkspaceDir as managedProjectWorkspaceDir,
} from './workspace-boundary.mjs';
import {
  REMOTE_RUNNER_API_PATHS,
  REMOTE_RUNNER_SERVICE,
  REMOTE_SKILL_HOST_ID,
  REMOTE_RUNNER_SSE_EVENTS,
  isRemoteJobTerminalStatus,
  matchRemoteRunnerAccountPath,
  matchRemoteRunnerJobArtifactsPath,
  matchRemoteRunnerJobCancelPath,
  matchRemoteRunnerJobPath,
  matchRemoteRunnerJobStreamPath,
  matchRemoteRunnerProjectFilesPath,
  matchRemoteRunnerProjectSkillsPath,
  matchRemoteRunnerProjectSkillServicePath,
  matchRemoteRunnerProjectSkillConfigPath,
  matchRemoteRunnerProjectEnvironmentPath,
  matchRemoteRunnerProjectEnvironmentInstallPath,
  matchRemoteRunnerProjectPath,
} from '../../packages/protocol/index.js';

/** Minimal, dependency-free `.env` loader. Existing env vars take precedence. */
function loadDotEnv(file = resolve(process.cwd(), '.env')) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return; // No .env file — rely on the real environment.
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

const cfg = {
  host: process.env.UGS_RUNNER_HOST || process.env.FUC_RUNNER_HOST || '0.0.0.0',
  port: Number(process.env.UGS_RUNNER_PORT || process.env.FUC_RUNNER_PORT || 8787),
  token: process.env.UGS_RUNNER_TOKEN || process.env.FUC_RUNNER_TOKEN || '',
  authMode:
    (process.env.UGS_RUNNER_AUTH_MODE || 'token').trim().toLowerCase() === 'multiuser'
      ? 'multiuser'
      : 'token',
  jwtSecret: makeJwtSecret(process.env.UGS_RUNNER_JWT_SECRET),
  workdir: resolve(process.env.UGS_RUNNER_WORKDIR || process.env.FUC_RUNNER_WORKDIR || './workspaces'),
  datadir: resolve(process.env.UGS_RUNNER_DATADIR || process.env.FUC_RUNNER_DATADIR || './data'),
  tenantId: process.env.UGS_RUNNER_TENANT_ID || 'self-hosted',
  serverId: process.env.UGS_RUNNER_SERVER_ID || createHash('sha256').update(resolve(process.env.UGS_RUNNER_DATADIR || process.env.FUC_RUNNER_DATADIR || './data')).digest('hex'),
  maxConcurrency: Number(process.env.UGS_RUNNER_MAX_CONCURRENCY || process.env.FUC_RUNNER_MAX_CONCURRENCY || 2),
  jobTimeoutMs: Number(process.env.UGS_RUNNER_JOB_TIMEOUT || process.env.FUC_RUNNER_JOB_TIMEOUT || 1800) * 1000,
  execAllowlist: (process.env.UGS_RUNNER_EXEC_ALLOWLIST || process.env.FUC_RUNNER_EXEC_ALLOWLIST || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  fileUploadLimitBytes:
    Number(process.env.UGS_RUNNER_FILE_UPLOAD_LIMIT_MB || 128) * 1024 * 1024,
};

const BODY_TOO_LARGE = Symbol('BODY_TOO_LARGE');

const auth = makeAuthorizer(cfg.token);
const store = await new JsonStore(cfg.datadir).load();
const mailer = makeMailer(process.env, console);
const accounts = new AccountRegistry(loadAccountsFromEnv(), process.env, store);
const runner = new JobRunner({
  store,
  workdir: cfg.workdir,
  maxConcurrency: cfg.maxConcurrency,
  jobTimeoutMs: cfg.jobTimeoutMs,
  execAllowlist: cfg.execAllowlist,
  accounts,
});

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/plain' : 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type, x-ugs-skill-control, x-ugs-skill-user-input',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    ...headers,
  });
  res.end(payload);
}

function readJson(req, opts = {}) {
  const maxBytes = opts.maxBytes ?? 2_000_000;
  return new Promise((resolveBody) => {
    let data = '';
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolveBody(value);
    };
    req.on('data', (c) => {
      if (done) return;
      data += c;
      if (data.length > maxBytes) {
        finish(BODY_TOO_LARGE);
        req.resume();
      }
    });
    req.on('end', () => {
      try {
        finish(data ? JSON.parse(data) : {});
      } catch {
        finish(null);
      }
    });
    req.on('error', () => finish(null));
  });
}

/** Public job view: never leak secrets. */
function publicJob(job) {
  if (!job) return null;
  const { _apiKey, _baseUrl, _gitToken, ...rest } = job;
  delete rest._accountApiKey;
  delete rest._accountBaseUrl;
  return rest;
}

function currentUserId(req) {
  if (cfg.authMode === 'multiuser' && req.auth?.type === 'user') {
    return req.auth.user.id;
  }
  return 'default';
}

function authorizeRequest(req) {
  if (auth.check(req.headers.authorization)) {
    return { ok: true, type: 'service' };
  }
  if (cfg.authMode === 'multiuser') {
    const jwt = authenticateJwtHeader(store, req.headers.authorization, cfg.jwtSecret);
    if (jwt) return { ok: true, type: 'user', user: jwt.user };
  }
  return { ok: false };
}

function requireJwtSecret(res) {
  if (cfg.authMode !== 'multiuser') return true;
  if (cfg.jwtSecret) return true;
  send(res, 500, { ok: false, error: 'UGS_RUNNER_JWT_SECRET is not configured' });
  return false;
}

function requestUserJobs(req) {
  const jobs = store.listJobs();
  if (cfg.authMode === 'multiuser' && req.auth?.type === 'user') {
    return jobs.filter((job) => job.userId === req.auth.user.id);
  }
  return jobs;
}

function requestLedgerEntries(req) {
  const entries = store.listLedgerEntries?.() ?? [];
  if (cfg.authMode === 'multiuser' && req.auth?.type === 'user') {
    return entries.filter((entry) => entry.userId === req.auth.user.id);
  }
  return entries;
}

function requestJob(req, id) {
  const job = store.getJob(id);
  if (!job) return null;
  if (cfg.authMode === 'multiuser' && req.auth?.type === 'user') {
    return job.userId === req.auth.user.id ? job : null;
  }
  return job;
}

function publicProject(project) {
  if (!project) return null;
  const { gitToken: _gitToken, workspacePath: _workspacePath, ...rest } = project;
  return {
    ...rest,
    hasGitToken: Boolean(project.gitToken),
  };
}

function projectInput(body, userId, existing = null) {
  if (!body || typeof body !== 'object') return null;
  const label =
    typeof body.label === 'string'
      ? body.label.trim()
      : typeof body.name === 'string'
        ? body.name.trim()
        : existing?.label ?? '';
  const repoUrl =
    typeof body.repoUrl === 'string'
      ? body.repoUrl.trim()
      : existing?.repoUrl ?? '';
  if (!label || !repoUrl) return null;
  const now = Date.now();
  const requestedId = String(body.id ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 80);
  const id = existing?.id ?? (requestedId || `proj_${randomUUID().slice(0, 8)}`);
  return {
    ...(existing ?? {}),
    id,
    userId,
    label,
    repoUrl,
    branch:
      typeof body.branch === 'string'
        ? body.branch.trim() || null
        : existing?.branch ?? null,
    pushBranch:
      typeof body.pushBranch === 'string'
        ? body.pushBranch.trim() || null
        : existing?.pushBranch ?? null,
    adapter:
      typeof body.adapter === 'string'
        ? body.adapter.trim() || existing?.adapter || 'claude'
        : existing?.adapter ?? 'claude',
    isolationLevel:
      typeof body.isolationLevel === 'string'
        ? body.isolationLevel.trim() || existing?.isolationLevel || undefined
        : existing?.isolationLevel ?? undefined,
    model:
      typeof body.model === 'string'
        ? body.model.trim() || null
        : existing?.model ?? null,
    gitToken:
      Object.prototype.hasOwnProperty.call(body, 'gitToken')
        ? String(body.gitToken ?? '').trim() || null
        : existing?.gitToken ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function usageView(req) {
  const jobs = requestUserJobs(req);
  const ledger = requestLedgerEntries(req);
  return {
    ok: true,
    totals: ledger.length ? summarizeLedger(ledger) : summarizeJobs(jobs),
    accounts: accounts.listPublic(jobs),
    recentJobs: jobs.slice(0, 20).map(publicJob),
  };
}

function ledgerView(req) {
  const entries = requestLedgerEntries(req);
  return {
    ok: true,
    totals: summarizeLedger(entries),
    entries,
  };
}

function artifactView(job) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt ?? null,
    finishedAt: job.finishedAt ?? null,
    runtimeMs: job.runtimeMs ?? 0,
    adapter: job.adapter,
    model: job.model,
    accountId: job.accountId ?? null,
    projectId: job.projectId ?? null,
    repoUrl: job.repoUrl ?? null,
    branch: job.branch ?? null,
    pushBranch: job.pushBranch ?? null,
    error: job.error ?? null,
    logs: job.logs ?? [],
    usage: job.usage ?? job.result?.usage ?? null,
    patch: job.result?.patch ?? '',
    pushed: Boolean(job.result?.pushed),
    result: job.result ?? null,
  };
}

function publicAccountById(id) {
  const account = accounts.list().find((item) => item.id === id);
  return account ? accounts.publicAccount(account, store.listJobs()) : null;
}

function authSessionResponse(user, session) {
  return {
    ok: true,
    session: {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      user: publicUser(user),
    },
  };
}

async function sendVerificationForUser(user, purpose, opts = {}) {
  const issued = issueVerification(
    store,
    { userId: user.id, email: user.email, purpose },
    { secret: cfg.jwtSecret, ...opts },
  );
  if (purpose === VERIFICATION_PURPOSE_PASSWORD_RESET) {
    await mailer.sendPasswordResetCode(user.email, issued.code);
  } else {
    await mailer.sendVerificationCode(user.email, issued.code);
  }
  return issued;
}

function accountInput(body, existing = null) {
  if (!body || typeof body !== 'object') return null;
  const merged = {
    ...(existing ?? {}),
    ...body,
    apiKey:
      Object.prototype.hasOwnProperty.call(body, 'apiKey')
        ? String(body.apiKey ?? '').trim() || null
        : existing?.apiKey ?? null,
    baseUrl:
      Object.prototype.hasOwnProperty.call(body, 'baseUrl')
        ? String(body.baseUrl ?? '').trim() || null
        : existing?.baseUrl ?? null,
  };
  return normalizeAccount(merged);
}

function queryParam(req, name) {
  try {
    const url = new URL(req.url, 'http://localhost');
    return url.searchParams.get(name);
  } catch {
    return null;
  }
}

function projectWorkspaceDir(project) {
  return managedProjectWorkspaceDir(cfg.workdir, project);
}

const projectSkillServices = new Map();
async function projectSkillDirectory(project) {
  const dir = projectWorkspaceDir(project);
  // Do not clone/pull for a skill mutation: the authenticated checkout must
  // already exist, and no request can select an alternate root or host global.
  await assertSafeSkillPath(cfg.workdir, { allowMissing: true });
  await assertSafeSkillPath(dir, { allowMissing: true });
  const bound = await assertWorkspaceBoundary(cfg.workdir, dir, { create: true });
  return bound.target;
}
async function projectSkillService(project) {
  const dir = await projectSkillDirectory(project);
  const key = `${project.userId ?? 'default'}:${project.id}`;
  if (!projectSkillServices.has(key)) projectSkillServices.set(key, createWorkspaceSkillService({ dir, hostId: REMOTE_SKILL_HOST_ID, workspaceId: project.id,
    candidateService: projectCandidateService(project, dir) }));
  return projectSkillServices.get(key);
}
function projectCandidateService(project, dir) {
  return createSkillCandidateService({ dir, namespace: {
    tenantId: cfg.tenantId, serverId: cfg.serverId, accountId: project.userId ?? 'default', workspaceId: project.id,
  } });
}

async function requirePersistedCandidateSource(project, userId, origin) {
  const fields = ['hostId', 'workspaceId', 'sessionId', 'turnId', 'runId'];
  const source = structuredClone(store.getJob(origin.runId));
  const matches = (job) => job && job.id === origin.runId && job.projectId === project.id &&
    job.userId === userId && job.status === 'done' && typeof job.prompt === 'string' && job.prompt.trim() &&
    job.skillOrigin && Object.keys(job.skillOrigin).length === fields.length &&
    fields.every((key) => job.skillOrigin[key] === origin[key]);
  if (!matches(source)) throw new Error('SKILL_CANDIDATE_SOURCE_UNAVAILABLE');
  // A completed optimistic record or an acknowledged no-op write is not a
  // persisted source. Fence all queued writes, then read the backing file.
  let written; let disk;
  do {
    written = store._writeChain;
    await written;
    disk = JSON.parse(await readFile(store.file, 'utf8'));
  } while (store._writeChain !== written);
  if (disk.projects?.[project.id]?.userId !== userId || !matches(disk.jobs?.[origin.runId]) ||
    disk.jobs[origin.runId].prompt !== source.prompt) throw new Error('SKILL_CANDIDATE_SOURCE_NOT_PERSISTED');
}

function nativeSkillEvidenceKind(message, exitCode) {
  // Classify only a server-retained native check, never client kind/summary or
  // a job's process exit. Unrecognised successful activity remains ordinary tool evidence.
  const command = message.args?.command;
  const output = message.result;
  if (exitCode !== 0 || typeof command !== 'string' || typeof output !== 'string') return 'tool';
  const nodeTest = /^node(?:\.exe)?\s+--test(?:\s+(?:--[a-z0-9-]+(?:=[A-Za-z0-9,._-]+)?|[A-Za-z0-9_./\\-]+))*\s*$/i.test(command.trim());
  const tests = /^# tests ([1-9][0-9]*)\s*$/m.exec(output);
  const passed = /^# pass ([1-9][0-9]*)\s*$/m.exec(output);
  const zeroFailures = /^# fail 0\s*$/m.test(output);
  return nodeTest && tests && passed && tests[1] === passed[1] && zeroFailures ? 'verification' : 'tool';
}

function serverSkillEvidence(req, project, origin, evidence = []) {
  if (!Array.isArray(evidence) || evidence.length > 256) throw new Error('skill evidence must be a bounded array');
  const jobs = store.listJobs().filter((job) => job.projectId === project.id && (job.userId ?? 'default') === currentUserId(req));
  const originFields = ['hostId', 'workspaceId', 'sessionId', 'turnId', 'runId'];
  const boundJob = (job, source) => job.status === 'done' && job.skillOrigin &&
    Object.keys(job.skillOrigin).length === originFields.length &&
    originFields.every((key) => job.skillOrigin[key] === source[key]) &&
    job.skillOrigin.runId === job.id && job.skillOrigin.hostId === REMOTE_SKILL_HOST_ID &&
    job.skillOrigin.workspaceId === project.id;
  const reviewJob = jobs.find((job) => job.id === origin.runId && boundJob(job, origin));
  return evidence.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.evidenceId !== 'string' || !item.evidenceId || !item.origin || Object.keys(item.origin).some((key) => !originFields.includes(key)) || ['hostId', 'workspaceId', 'sessionId'].some((key) => item.origin[key] !== origin[key]) || ['turnId', 'runId'].some((key) => typeof item.origin[key] !== 'string' || !item.origin[key] || item.origin[key].length > 200)) throw new Error('skill evidence origin does not match this session');
    if (item.provenance === 'native-tool' || item.provenance === 'host-check') {
      const native = reviewJob ? jobs.filter((job) => job.id === item.origin.runId && boundJob(job, item.origin)).flatMap((job) => (job.messages ?? []).filter((message) => message.provenance === 'native-tool' && message.phase === 'end' && message.runId === job.id && typeof message.toolName === 'string' && message.toolName && Number.isFinite(message.at) && (message.toolCallId ?? message.toolId) === item.toolCallId)) : [];
      const message = native.find((entry) => JSON.stringify([item.origin.runId, entry.toolCallId ?? entry.toolId]) === item.evidenceId);
      if (message) {
        const exitCode = Object.prototype.hasOwnProperty.call(message, 'toolExitCode') ? message.toolExitCode : message.exitCode;
        return { evidenceId: item.evidenceId, origin: { ...item.origin }, kind: nativeSkillEvidenceKind(message, exitCode), provenance: 'native-tool', toolCallId: message.toolCallId ?? message.toolId, toolName: message.toolName, parentId: message.parentId, occurredAt: message.at, status: typeof exitCode === 'number' ? (exitCode === 0 ? 'success' : 'error') : ['success', 'error'].includes(message.status) ? message.status : 'unknown', exitCode, result: message.result, summary: message.text ?? '' };
      }
      return { ...item, provenance: 'model-output', status: 'unknown' };
    }
    // This separate authenticated UI assertion is not a field a review model can mint.
    if (req.headers['x-ugs-skill-user-input'] === 'correction' && item.provenance === 'user-input' && item.kind === 'correction' && originFields.every((key) => item.origin[key] === origin[key])) return { ...item, status: 'success' };
    return { ...item, provenance: 'model-output', status: 'unknown' };
  });
}

function currentUserSettingsRoot(req) {
  return userSettingsRoot(cfg.workdir, currentUserId(req));
}

async function ensureProjectWorkspaceReady(project, opts = {}) {
  const dir = projectWorkspaceDir(project);
  await assertWorkspaceBoundary(cfg.workdir, dir, { create: true });
  const alreadyCloned = await git.isGitWorkspace(dir);
  // Clone on first touch; otherwise only re-sync (reconcile origin + checkout +
  // ff-only pull) when the caller explicitly asks for it. Without `sync`, an
  // existing checkout is left untouched — so a plain file-tree open stays cheap
  // and offline-friendly. The `sync` path is what lets the client's "refresh"
  // actually pull the repo's latest commits instead of showing the stale
  // snapshot captured at first clone (the reason remote projects appeared
  // unable to fetch the latest version).
  if (!alreadyCloned || opts.sync) {
    if (project.repoUrl) {
      // The remote host ships nothing preinstalled. A clone/pull without git on
      // PATH fails with a confusing low-level error, so gate sync on git first
      // and point the user at the remote-environment install when it is missing.
      await ensureGitReadyForSync();
      const synced = await git.ensureWorkspace({
        repoUrl: project.repoUrl,
        branch: project.branch,
        dir,
        token: project.gitToken,
      });
      if (!synced.ok) {
        throw new Error(`git sync failed: ${synced.stderr || synced.stdout || 'unknown error'}`);
      }
    }
  }
  return dir;
}

/**
 * Clone/sync a project's workspace eagerly, in the background, right after it is
 * created or its repo settings change. Without this the checkout only appears
 * lazily on the first job or file-tree open, so a freshly configured repo looks
 * "empty" until then. Failures are logged but never block the API response —
 * the lazy {@link ensureProjectWorkspaceReady} path still recovers on demand and
 * surfaces the real error to the user.
 *
 * In-flight prepares are tracked in {@link pendingWorkspacePrepares} so tests and
 * graceful shutdown can wait for the background git process to settle.
 */
const pendingWorkspacePrepares = new Set();

function prepareProjectWorkspace(project) {
  if (!project?.repoUrl) return;
  const task = ensureProjectWorkspaceReady(project)
    .catch((err) => {
      console.warn(
        `[ugs-runner] workspace prepare failed for ${project.id}: ${git.redact(String(err?.message ?? err))}`,
      );
    })
    .finally(() => {
      pendingWorkspacePrepares.delete(task);
    });
  pendingWorkspacePrepares.add(task);
}

/** Resolve once every in-flight background workspace prepare has settled. */
function settleWorkspacePrepares() {
  return Promise.allSettled([...pendingWorkspacePrepares]);
}

/** Repo settings whose change means the existing checkout must be re-synced. */
function projectRepoChanged(before, after) {
  if (!before) return true;
  return (
    before.repoUrl !== after.repoUrl ||
    before.branch !== after.branch ||
    before.gitToken !== after.gitToken
  );
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADMIN_PAGE_PATH = resolve(__dirname, 'admin.html');
let _adminPageCache = null;
/** Read (and cache) the static admin panel HTML shipped next to this server. */
function readAdminPage() {
  if (_adminPageCache === null) {
    _adminPageCache = readFileSync(ADMIN_PAGE_PATH, 'utf8');
  }
  return _adminPageCache;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') return send(res, 204, '');

  // GET /admin — minimal, dependency-free web admin panel. Served unauthenticated
  // (it ships no secrets); the page itself prompts for the bearer token and calls
  // the authenticated read-only endpoints (/jobs, /usage, /accounts, /projects)
  // from the browser. Useful for quickly inspecting jobs, token usage and
  // artifacts without the desktop app, à la MonkeyCode's /manager console.
  if ((path === '/admin' || path === '/admin/') && req.method === 'GET') {
    try {
      return send(res, 200, readAdminPage(), { 'content-type': 'text/html; charset=utf-8' });
    } catch (err) {
      return send(res, 500, { ok: false, error: String(err?.message ?? err) });
    }
  }

  // Health check is unauthenticated so clients can probe reachability + read
  // the server's auth requirement before sending a token.
  if (path === REMOTE_RUNNER_API_PATHS.health && req.method === 'GET') {
    return send(res, 200, {
      ok: true,
      service: REMOTE_RUNNER_SERVICE,
      version: '0.1.0',
      authRequired: cfg.authMode === 'multiuser' || auth.configured,
      authMode: cfg.authMode,
      adapters: supportedAdapters(),
      maxConcurrency: cfg.maxConcurrency,
      accountCount: accounts.accounts.length,
    });
  }

  if (cfg.authMode === 'multiuser' && path === REMOTE_RUNNER_API_PATHS.authRegister && req.method === 'POST') {
    if (!requireJwtSecret(res)) return undefined;
    const body = await readJson(req);
    const email = body?.email;
    const password = body?.password;
    if (typeof email !== 'string' || typeof password !== 'string') {
      return send(res, 400, { ok: false, error: 'email and password are required' });
    }
    const existing = findUserByEmail(store, email);
    if (existing) {
      if (!existing.emailVerified) {
        await sendVerificationForUser(existing, VERIFICATION_PURPOSE_EMAIL).catch(() => null);
      }
      return send(res, 200, { ok: true });
    }
    try {
      const passwordHash = await hashPassword(password);
      const user = await createUser(store, {
        email,
        passwordHash,
        displayName: body?.displayName,
      });
      await sendVerificationForUser(user, VERIFICATION_PURPOSE_EMAIL);
      return send(res, 200, { ok: true });
    } catch (err) {
      return send(res, 400, { ok: false, error: String(err?.message ?? err) });
    }
  }

  if (cfg.authMode === 'multiuser' && path === REMOTE_RUNNER_API_PATHS.authVerifyEmail && req.method === 'POST') {
    if (!requireJwtSecret(res)) return undefined;
    const body = await readJson(req);
    const user = findUserByEmail(store, body?.email);
    if (!user) return send(res, 400, { ok: false, error: 'invalid code' });
    const verified = verifyCode(
      store,
      { email: user.email, code: body?.code, purpose: VERIFICATION_PURPOSE_EMAIL },
      { secret: cfg.jwtSecret },
    );
    if (!verified.ok) return send(res, 400, { ok: false, error: verified.error });
    const updated = setEmailVerified(store, user.id, true) ?? user;
    const session = issueSession(store, updated, {
      jwtSecret: cfg.jwtSecret,
      device: req.headers['user-agent'] ?? '',
    });
    return send(res, 200, authSessionResponse(updated, session));
  }

  if (cfg.authMode === 'multiuser' && path === REMOTE_RUNNER_API_PATHS.authResendCode && req.method === 'POST') {
    if (!requireJwtSecret(res)) return undefined;
    const body = await readJson(req);
    const user = findUserByEmail(store, body?.email);
    if (!user || user.emailVerified) return send(res, 200, { ok: true });
    try {
      await sendVerificationForUser(user, VERIFICATION_PURPOSE_EMAIL);
      return send(res, 200, { ok: true });
    } catch (err) {
      const status = err?.code === 'rate_limited' ? 429 : 400;
      return send(res, status, {
        ok: false,
        error: String(err?.message ?? err),
        retryAfterMs: err?.retryAfterMs,
      });
    }
  }

  if (cfg.authMode === 'multiuser' && path === REMOTE_RUNNER_API_PATHS.authLogin && req.method === 'POST') {
    if (!requireJwtSecret(res)) return undefined;
    const body = await readJson(req);
    const user = findUserByEmail(store, body?.email);
    if (!user || !(await verifyPassword(user.passwordHash, body?.password))) {
      return send(res, 401, { ok: false, error: 'invalid email or password' });
    }
    if (!user.emailVerified) {
      return send(res, 403, { ok: false, error: 'email is not verified' });
    }
    const session = issueSession(store, user, {
      jwtSecret: cfg.jwtSecret,
      device:
        typeof body?.device === 'string' ? body.device : req.headers['user-agent'] ?? '',
    });
    return send(res, 200, authSessionResponse(user, session));
  }

  if (cfg.authMode === 'multiuser' && path === REMOTE_RUNNER_API_PATHS.authRefresh && req.method === 'POST') {
    if (!requireJwtSecret(res)) return undefined;
    const body = await readJson(req);
    const session = refreshSession(store, body?.refreshToken, { jwtSecret: cfg.jwtSecret });
    if (!session) return send(res, 401, { ok: false, error: 'invalid refresh token' });
    return send(res, 200, authSessionResponse(session.user, session));
  }

  if (cfg.authMode === 'multiuser' && path === REMOTE_RUNNER_API_PATHS.authLogout && req.method === 'POST') {
    const body = await readJson(req);
    if (body?.refreshToken) revokeSession(store, body.refreshToken);
    return send(res, 200, { ok: true });
  }

  if (cfg.authMode === 'multiuser' && path === REMOTE_RUNNER_API_PATHS.authForgotPassword && req.method === 'POST') {
    if (!requireJwtSecret(res)) return undefined;
    const body = await readJson(req);
    const user = findUserByEmail(store, body?.email);
    if (user) {
      await sendVerificationForUser(user, VERIFICATION_PURPOSE_PASSWORD_RESET).catch(() => null);
    }
    return send(res, 200, { ok: true });
  }

  if (cfg.authMode === 'multiuser' && path === REMOTE_RUNNER_API_PATHS.authResetPassword && req.method === 'POST') {
    if (!requireJwtSecret(res)) return undefined;
    const body = await readJson(req);
    const user = findUserByEmail(store, body?.email);
    if (!user) return send(res, 400, { ok: false, error: 'invalid code' });
    const verified = verifyCode(
      store,
      { email: user.email, code: body?.code, purpose: VERIFICATION_PURPOSE_PASSWORD_RESET },
      { secret: cfg.jwtSecret },
    );
    if (!verified.ok) return send(res, 400, { ok: false, error: verified.error });
    try {
      const updated = updatePassword(store, user.id, await hashPassword(body?.password)) ?? user;
      updated.emailVerified = true;
      store.upsertUser(updated);
      const session = issueSession(store, updated, {
        jwtSecret: cfg.jwtSecret,
        device: req.headers['user-agent'] ?? '',
      });
      return send(res, 200, authSessionResponse(updated, session));
    } catch (err) {
      return send(res, 400, { ok: false, error: String(err?.message ?? err) });
    }
  }

  const authorized = authorizeRequest(req);
  if (!authorized.ok) {
    return send(res, 401, { ok: false, error: 'unauthorized' });
  }
  req.auth = authorized;

  if (cfg.authMode === 'multiuser' && path === REMOTE_RUNNER_API_PATHS.authMe && req.method === 'GET') {
    if (req.auth.type !== 'user') return send(res, 401, { ok: false, error: 'unauthorized' });
    return send(res, 200, { ok: true, user: publicUser(req.auth.user) });
  }

  // User settings live under <workdir>/<user>/.ultragamestudio. This is the
  // remote counterpart of the desktop user's ~/.ultragamestudio root.
  if (path === REMOTE_RUNNER_API_PATHS.userSettings && req.method === 'GET') {
    try {
      const text = await readUserSettingJson({
        root: currentUserSettingsRoot(req),
        relPath: url.searchParams.get('path') ?? '',
      });
      return send(res, 200, { ok: true, text });
    } catch (err) {
      return send(res, 400, { ok: false, error: String(err?.message ?? err) });
    }
  }

  if (path === REMOTE_RUNNER_API_PATHS.userSettings && req.method === 'PUT') {
    const body = await readJson(req);
    if (!body || typeof body !== 'object') {
      return send(res, 400, { ok: false, error: 'invalid body' });
    }
    try {
      await writeUserSettingJson({
        root: currentUserSettingsRoot(req),
        relPath: body.path,
        json: String(body.json ?? ''),
      });
      return send(res, 200, { ok: true });
    } catch (err) {
      return send(res, 400, { ok: false, error: String(err?.message ?? err) });
    }
  }

  if (path === REMOTE_RUNNER_API_PATHS.userSettings && req.method === 'DELETE') {
    try {
      await removeUserSetting({
        root: currentUserSettingsRoot(req),
        relPath: url.searchParams.get('path') ?? '',
      });
      return send(res, 200, { ok: true });
    } catch (err) {
      return send(res, 400, { ok: false, error: String(err?.message ?? err) });
    }
  }

  // POST /jobs — create a remote job.
  if (path === REMOTE_RUNNER_API_PATHS.jobs && req.method === 'POST') {
    const body = await readJson(req);
    if (!body || typeof body.prompt !== 'string' || !body.prompt.trim()) {
      return send(res, 400, { ok: false, error: 'prompt is required' });
    }
    let job;
    try {
      job = runner.enqueue({
        userId: currentUserId(req),
        projectId: body.projectId,
        repoUrl: body.repoUrl,
        branch: body.branch,
        adapter: body.adapter,
        model: body.model,
        isolationLevel: body.isolationLevel,
        accountId: body.accountId,
        prompt: body.prompt,
        pushBranch: body.pushBranch,
        skillSource: body.skillSource,
      });
    } catch (err) {
      return send(res, 404, { ok: false, error: String(err?.message ?? err) });
    }
    // Attach secrets out-of-band so they never land in the persisted record's
    // public fields (they are deleted again once the job finishes).
    const stored = store.getJob(job.id);
    if (body.apiKey) stored._apiKey = String(body.apiKey);
    if (body.baseUrl) stored._baseUrl = String(body.baseUrl);
    if (!body.projectId && body.gitToken) stored._gitToken = String(body.gitToken);
    if (job.skillOrigin) {
      try { await (runner.skillSourceWrites.get(job.id) ?? store._writeChain); }
      catch { return send(res, 500, { ok: false, error: 'skill source persistence failed' }); }
    }
    return send(res, 201, { ok: true, job: publicJob(job) });
  }

  // GET /projects — list projects owned by current user.
  if (path === REMOTE_RUNNER_API_PATHS.projects && req.method === 'GET') {
    return send(res, 200, {
      ok: true,
      projects: store.listProjects(currentUserId(req)).map(publicProject),
    });
  }

  // POST /projects — create a project and let the server own its workspace path.
  if (path === REMOTE_RUNNER_API_PATHS.projects && req.method === 'POST') {
    const body = await readJson(req);
    const project = projectInput(body, currentUserId(req));
    if (!project) return send(res, 400, { ok: false, error: 'label and repoUrl are required' });
    store.upsertProject(project);
    prepareProjectWorkspace(project);
    return send(res, 201, { ok: true, project: publicProject(project) });
  }

  const projectId = matchRemoteRunnerProjectPath(path);
  if (projectId && req.method === 'GET') {
    const project = store.getProject(projectId, currentUserId(req));
    if (!project) return send(res, 404, { ok: false, error: 'not found' });
    return send(res, 200, { ok: true, project: publicProject(project) });
  }

  if (projectId && req.method === 'PUT') {
    const existing = store.getProject(projectId, currentUserId(req));
    if (!existing) return send(res, 404, { ok: false, error: 'not found' });
    const body = await readJson(req);
    const project = projectInput({ ...(body ?? {}), id: existing.id }, currentUserId(req), existing);
    if (!project) return send(res, 400, { ok: false, error: 'label and repoUrl are required' });
    store.upsertProject(project);
    if (projectRepoChanged(existing, project)) prepareProjectWorkspace(project);
    return send(res, 200, { ok: true, project: publicProject(project) });
  }

  if (projectId && req.method === 'DELETE') {
    const ok = store.deleteProject(projectId, currentUserId(req));
    return send(res, ok ? 200 : 404, { ok });
  }

  const projectFilesId = matchRemoteRunnerProjectFilesPath(path);
  if (projectFilesId && req.method === 'GET') {
    const project = store.getProject(projectFilesId, currentUserId(req));
    if (!project) return send(res, 404, { ok: false, error: 'not found' });
    try {
      const wantSync = url.searchParams.get('sync') === '1';
      const dir = await ensureProjectWorkspaceReady(project, { sync: wantSync });
      if (url.searchParams.get('preview') === '1') {
        const file = await previewWorkspaceFile({
          dir,
          rootPath: `remote-project://${project.id}`,
          relativePath: url.searchParams.get('path') ?? '',
        });
        return send(res, 200, { ok: true, file });
      }
      const listing = await listWorkspaceDirectory({
        dir,
        rootPath: `remote-project://${project.id}`,
        relativePath: url.searchParams.get('path') ?? '',
      });
      return send(res, 200, { ok: true, listing });
    } catch (err) {
      return send(res, 400, {
        ok: false,
        error: String(err?.message ?? err),
      });
    }
  }

  if (projectFilesId && req.method === 'POST') {
    const project = store.getProject(projectFilesId, currentUserId(req));
    if (!project) return send(res, 404, { ok: false, error: 'not found' });
    const body = await readJson(req, {
      maxBytes: Math.ceil(cfg.fileUploadLimitBytes * 1.4) + 100_000,
    });
    if (body === BODY_TOO_LARGE) {
      return send(res, 413, { ok: false, error: 'upload is too large' });
    }
    if (!body || typeof body !== 'object' || typeof body.bytesBase64 !== 'string') {
      return send(res, 400, { ok: false, error: 'bytesBase64 is required' });
    }
    try {
      const dir = await ensureProjectWorkspaceReady(project);
      const file = await saveWorkspaceUpload({
        dir,
        rootPath: `remote-project://${project.id}`,
        bytesBase64: body.bytesBase64,
        mime: body.mime,
        fileName: body.fileName,
        namespace: body.namespace,
      });
      return send(res, 201, { ok: true, file });
    } catch (err) {
      return send(res, 400, {
        ok: false,
        error: String(err?.message ?? err),
      });
    }
  }

  // GET /projects/:id/skills — scan the project's checked-out workspace for the
  // slash commands / skills the remote agent can run, scoped to the project (its
  // skills/ + per-agent .claude|.codex|.gemini|.agents dirs) — never the host's
  // global config. The client caches this per project and folds it into the `/`
  // suggestion menu so remote projects show real remote skills instead of the
  // user's local machine skills. `sync=1` git-pulls latest before scanning.
  const projectSkillsId = matchRemoteRunnerProjectSkillsPath(path);
  if (projectSkillsId && req.method === 'GET') {
    const project = store.getProject(projectSkillsId, currentUserId(req));
    if (!project) return send(res, 404, { ok: false, error: 'not found' });
    try {
      const wantSync = url.searchParams.get('sync') === '1';
      const dir = await ensureProjectWorkspaceReady(project, { sync: wantSync });
      const skills = await listWorkspaceSkills({ dir, hostId: REMOTE_SKILL_HOST_ID, workspaceId: project.id });
      return send(res, 200, { ok: true, skills });
    } catch (err) {
      return send(res, 400, {
        ok: false,
        error: String(err?.message ?? err),
      });
    }
  }

  const skillConfigProjectId = matchRemoteRunnerProjectSkillConfigPath(path);
  if (skillConfigProjectId && ['GET', 'PUT'].includes(req.method)) {
    const project = store.getProject(skillConfigProjectId, currentUserId(req));
    if (!project) return send(res, 404, { ok: false, error: 'not found' });
    if (req.method === 'PUT' && req.headers['x-ugs-skill-control'] !== 'owner') return send(res, 403, { ok: false, error: 'explicit owner control authority is required' });
    const body = req.method === 'PUT' ? await readJson(req) : null;
    if (body === BODY_TOO_LARGE) return send(res, 413, { ok: false, error: 'skill config is too large' });
    try {
      const service = await projectSkillService(project);
      const config = req.method === 'PUT' ? await service.setConfig(body) : await service.getConfig();
      return send(res, 200, { ok: true, config });
    } catch (error) { return send(res, error.code === 'SKILL_BUSY' ? 409 : 400, { ok: false, error: String(error?.message ?? error) }); }
  }

  const candidateProjectId = path.endsWith('/skill-service/candidates')
    ? matchRemoteRunnerProjectSkillServicePath(path.slice(0, -'/candidates'.length)) : null;
  if (candidateProjectId && req.method === 'POST') {
    const userId = currentUserId(req);
    const project = store.getProject(candidateProjectId, userId);
    if (!project) return send(res, 404, { ok: false, error: 'not found' });
    const body = await readJson(req);
    if (body === BODY_TOO_LARGE) return send(res, 413, { ok: false, error: 'skill candidate request is too large' });
    const fields = ['action', 'origin', 'list', 'expectedRevision'];
    const originFields = ['hostId', 'workspaceId', 'sessionId', 'turnId', 'runId'];
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !fields.includes(key)) ||
      !['load', 'compare_and_swap'].includes(body.action) || !body.origin || typeof body.origin !== 'object' || Array.isArray(body.origin) ||
      Object.keys(body.origin).length !== originFields.length || Object.keys(body.origin).some((key) => !originFields.includes(key)) ||
      body.origin.hostId !== REMOTE_SKILL_HOST_ID || body.origin.workspaceId !== project.id ||
      ['sessionId', 'turnId', 'runId'].some((key) => typeof body.origin[key] !== 'string' || !body.origin[key] || body.origin[key].length > 200) ||
      (body.action === 'load' && (body.list !== undefined || body.expectedRevision !== undefined))) {
      return send(res, 400, { ok: false, error: 'invalid skill candidate request; client namespace/root/authority overrides are forbidden' });
    }
    const origin = Object.freeze({ ...body.origin });
    try {
      await requirePersistedCandidateSource(project, userId, origin);
      const dir = await projectSkillDirectory(project);
      const service = projectCandidateService(project, dir);
      const result = body.action === 'load' ? await service.load() : await service.compareAndSwap(body.expectedRevision, body.list);
      return send(res, 200, { ok: true, result });
    } catch (error) {
      const conflict = ['SKILL_CANDIDATE_CONFLICT', 'SKILL_CANDIDATE_LOCKED_NEEDS_RECOVERY'].includes(error.message);
      return send(res, conflict ? 409 : 400, { ok: false, error: String(error?.message ?? error) });
    }
  }

  // Unified camelCase wire contract shared with Rust skills_request. The route
  // and authenticated store lookup, never request fields, choose the workspace.
  const skillServiceProjectId = matchRemoteRunnerProjectSkillServicePath(path);
  if (skillServiceProjectId && req.method === 'POST') {
    const project = store.getProject(skillServiceProjectId, currentUserId(req));
    if (!project) return send(res, 404, { ok: false, error: 'not found' });
    const body = await readJson(req);
    if (body === BODY_TOO_LARGE) return send(res, 413, { ok: false, error: 'skill request is too large' });
    if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { ok: false, error: 'invalid skill request' });
    const fields = ['action', 'origin', 'mode', 'evidence', 'proposal', 'skillId', 'filePath', 'batchId', 'rollbackId', 'kind', 'evidenceIds', 'policy', 'sourceSkillId'];
    if (Object.keys(body).some((key) => !fields.includes(key)) || !body.origin || typeof body.origin !== 'object' || Array.isArray(body.origin) || Object.keys(body.origin).some((key) => !['hostId', 'workspaceId', 'sessionId', 'turnId', 'runId'].includes(key))) return send(res, 400, { ok: false, error: 'client root/cwd/authority overrides or unknown origin fields are forbidden' });
    if (body.mode !== undefined && !['auto-safe', 'approve-all', 'off'].includes(body.mode)) return send(res, 400, { ok: false, error: 'invalid skill learning mode' });
    if (body.origin?.hostId !== REMOTE_SKILL_HOST_ID || body.origin?.workspaceId !== project.id) return send(res, 400, { ok: false, error: 'skill origin does not match authenticated workspace' });
    const ownerActions = new Set(['approve', 'reject', 'rollback', 'set_policy', 'archive', 'restore', 'import']);
    if (ownerActions.has(body.action) && req.headers['x-ugs-skill-control'] !== 'owner') return send(res, 403, { ok: false, error: 'explicit owner control authority is required' });
    try {
      const service = await projectSkillService(project);
      // The model references identities only; authorize against a written host snapshot.
      if (Array.isArray(body.evidence) && body.evidence.some((item) => item?.provenance === 'native-tool' || item?.provenance === 'host-check')) {
        let written;
        do { written = store._writeChain; await written; } while (store._writeChain !== written);
      }
      const result = await service.request({ ...body, evidence: serverSkillEvidence(req, project, body.origin, body.evidence) });
      return send(res, 200, { ok: true, result });
    } catch (error) { return send(res, error.code === 'SKILL_BUSY' ? 409 : 400, { ok: false, error: String(error?.message ?? error) }); }
  }

  // GET /projects/:id/environment — probe the remote host for required runtime
  // tools (git, node, python). The remote backend has nothing preinstalled, so
  // the client uses this to decide whether a sync can run.
  const projectEnvId = matchRemoteRunnerProjectEnvironmentPath(path);
  if (projectEnvId && req.method === 'GET') {
    const project = store.getProject(projectEnvId, currentUserId(req));
    if (!project) return send(res, 404, { ok: false, error: 'not found' });
    try {
      const environment = await detectEnvironment();
      return send(res, 200, { ok: true, environment });
    } catch (err) {
      return send(res, 500, { ok: false, error: String(err?.message ?? err) });
    }
  }

  // POST /projects/:id/environment/install — install missing required tools on
  // the remote host. Triggered locally; runs server-side. Runs ahead of (and
  // independent from) project sync, so a fresh host can be provisioned first.
  const projectEnvInstallId = matchRemoteRunnerProjectEnvironmentInstallPath(path);
  if (projectEnvInstallId && req.method === 'POST') {
    const project = store.getProject(projectEnvInstallId, currentUserId(req));
    if (!project) return send(res, 404, { ok: false, error: 'not found' });
    const body = await readJson(req);
    const tools = Array.isArray(body?.tools) ? body.tools : undefined;
    try {
      const install = await installEnvironment({ tools });
      return send(res, 200, { ok: true, install });
    } catch (err) {
      return send(res, 500, { ok: false, error: String(err?.message ?? err) });
    }
  }

  // GET /jobs — list jobs.
  if (path === REMOTE_RUNNER_API_PATHS.jobs && req.method === 'GET') {
    return send(res, 200, { ok: true, jobs: requestUserJobs(req).map(publicJob) });
  }

  // GET /usage — account + token usage summary.
  if (path === REMOTE_RUNNER_API_PATHS.usage && req.method === 'GET') {
    return send(res, 200, usageView(req));
  }

  // GET /usage/ledger — immutable-ish usage/runtime billing events.
  if (path === REMOTE_RUNNER_API_PATHS.usageLedger && req.method === 'GET') {
    return send(res, 200, ledgerView(req));
  }

  // GET /accounts — list server-side model accounts (redacted).
  if (path === REMOTE_RUNNER_API_PATHS.accounts && req.method === 'GET') {
    return send(res, 200, {
      ok: true,
      accounts: accounts.listPublic(requestUserJobs(req), queryParam(req, 'projectId')),
    });
  }

  // POST /accounts — create/update a stored account.
  if (path === REMOTE_RUNNER_API_PATHS.accounts && req.method === 'POST') {
    if (cfg.authMode === 'multiuser' && req.auth.type !== 'service') {
      return send(res, 403, { ok: false, error: 'service token required' });
    }
    const body = await readJson(req);
    const account = accountInput(body);
    if (!account) return send(res, 400, { ok: false, error: 'invalid account' });
    if (accounts.isEnvManaged(account.id)) {
      return send(res, 409, { ok: false, error: 'env-managed account cannot be edited' });
    }
    store.upsertAccount(account);
    return send(res, 201, { ok: true, account: publicAccountById(account.id) });
  }

  const accountId = matchRemoteRunnerAccountPath(path);
  if (accountId && req.method === 'PUT') {
    if (cfg.authMode === 'multiuser' && req.auth.type !== 'service') {
      return send(res, 403, { ok: false, error: 'service token required' });
    }
    if (accounts.isEnvManaged(accountId)) {
      return send(res, 409, { ok: false, error: 'env-managed account cannot be edited' });
    }
    const existing = store.getAccount(accountId);
    if (!existing) return send(res, 404, { ok: false, error: 'not found' });
    const body = await readJson(req);
    const account = accountInput({ ...(body ?? {}), id: accountId }, existing);
    if (!account) return send(res, 400, { ok: false, error: 'invalid account' });
    store.upsertAccount(account);
    return send(res, 200, { ok: true, account: publicAccountById(account.id) });
  }

  if (accountId && req.method === 'DELETE') {
    if (cfg.authMode === 'multiuser' && req.auth.type !== 'service') {
      return send(res, 403, { ok: false, error: 'service token required' });
    }
    if (accounts.isEnvManaged(accountId)) {
      return send(res, 409, { ok: false, error: 'env-managed account cannot be deleted' });
    }
    return send(res, store.deleteAccount(accountId) ? 200 : 404, { ok: true });
  }

  // GET /jobs/:id — single job (includes accumulated logs + result).
  const jobId = matchRemoteRunnerJobPath(path);
  if (jobId && req.method === 'GET') {
    const job = requestJob(req, jobId);
    if (!job) return send(res, 404, { ok: false, error: 'not found' });
    return send(res, 200, { ok: true, job: publicJob(job) });
  }

  // POST /jobs/:id/cancel
  const cancelJobId = matchRemoteRunnerJobCancelPath(path);
  if (cancelJobId && req.method === 'POST') {
    const job = requestJob(req, cancelJobId);
    if (!job) return send(res, 404, { ok: false, error: 'not found' });
    const ok = runner.cancel(cancelJobId);
    return send(res, ok ? 200 : 404, { ok });
  }

  // GET /jobs/:id/artifacts — review bundle for UI/backend sync.
  const artifactJobId = matchRemoteRunnerJobArtifactsPath(path);
  if (artifactJobId && req.method === 'GET') {
    const job = requestJob(req, artifactJobId);
    if (!job) return send(res, 404, { ok: false, error: 'not found' });
    return send(res, 200, { ok: true, artifacts: artifactView(job) });
  }

  // GET /jobs/:id/stream — SSE live logs + status.
  const streamJobId = matchRemoteRunnerJobStreamPath(path);
  if (streamJobId && req.method === 'GET') {
    const id = streamJobId;
    const job = requestJob(req, id);
    if (!job) return send(res, 404, { ok: false, error: 'not found' });

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    const write = (event, data) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    // Replay backlog, then stream live.
    for (const line of job.logs) write(REMOTE_RUNNER_SSE_EVENTS.log, line);
    for (const message of job.messages ?? []) write(REMOTE_RUNNER_SSE_EVENTS.message, message);
    write(REMOTE_RUNNER_SSE_EVENTS.status, job.status);

    const onLog = (line) => write(REMOTE_RUNNER_SSE_EVENTS.log, line);
    const onMessage = (message) => write(REMOTE_RUNNER_SSE_EVENTS.message, message);
    const onStatus = (status) => {
      write(REMOTE_RUNNER_SSE_EVENTS.status, status);
      if (isRemoteJobTerminalStatus(status)) {
        write(REMOTE_RUNNER_SSE_EVENTS.result, publicJob(store.getJob(id)));
        cleanup();
        res.end();
      }
    };
    const cleanup = () => {
      runner.off(`log:${id}`, onLog);
      runner.off(`message:${id}`, onMessage);
      runner.off(`status:${id}`, onStatus);
    };
    runner.on(`log:${id}`, onLog);
    runner.on(`message:${id}`, onMessage);
    runner.on(`status:${id}`, onStatus);
    req.on('close', cleanup);

    // If the job already finished, close after replay.
    if (isRemoteJobTerminalStatus(job.status)) {
      write(REMOTE_RUNNER_SSE_EVENTS.result, publicJob(job));
      cleanup();
      res.end();
    }
    return undefined;
  }

  return send(res, 404, { ok: false, error: 'not found' });
});

server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    console.error(`[ugs-runner] ERROR: ${cfg.host}:${cfg.port} is already in use.`);
    console.error('[ugs-runner] Stop the existing backend process, or set UGS_RUNNER_PORT to another port.');
    process.exit(1);
  }
  throw error;
});

server.listen(cfg.port, cfg.host, () => {
  const where = `${cfg.host}:${cfg.port}`;
  console.log(`[ugs-runner] listening on http://${where}`);
  if (!auth.configured) {
    console.warn(
      '[ugs-runner] WARNING: UGS_RUNNER_TOKEN is not set. All authenticated ' +
        'endpoints will reject every request (fail-closed). Set a token before use.',
    );
  }
  console.log(`[ugs-runner] workdir=${cfg.workdir} datadir=${cfg.datadir}`);
  console.log(`[ugs-runner] accounts=${accounts.accounts.length}`);
});

export { server, runner, store, settleWorkspacePrepares };
