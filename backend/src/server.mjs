#!/usr/bin/env node
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeAuthorizer } from './auth.mjs';
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
  REMOTE_RUNNER_SSE_EVENTS,
  isRemoteJobTerminalStatus,
  matchRemoteRunnerAccountPath,
  matchRemoteRunnerJobArtifactsPath,
  matchRemoteRunnerJobCancelPath,
  matchRemoteRunnerJobPath,
  matchRemoteRunnerJobStreamPath,
  matchRemoteRunnerProjectFilesPath,
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
  workdir: resolve(process.env.UGS_RUNNER_WORKDIR || process.env.FUC_RUNNER_WORKDIR || './workspaces'),
  datadir: resolve(process.env.UGS_RUNNER_DATADIR || process.env.FUC_RUNNER_DATADIR || './data'),
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
    'access-control-allow-headers': 'authorization, content-type',
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

function currentUserId(_req) {
  return 'default';
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

function usageView() {
  const jobs = store.listJobs();
  const ledger = store.listLedgerEntries?.() ?? [];
  return {
    ok: true,
    totals: ledger.length ? summarizeLedger(ledger) : summarizeJobs(jobs),
    accounts: accounts.listPublic(jobs),
    recentJobs: jobs.slice(0, 20).map(publicJob),
  };
}

function ledgerView() {
  const entries = store.listLedgerEntries?.() ?? [];
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
      authRequired: auth.configured,
      adapters: supportedAdapters(),
      maxConcurrency: cfg.maxConcurrency,
      accountCount: accounts.accounts.length,
    });
  }

  // Everything below requires a valid bearer token.
  if (!auth.check(req.headers.authorization)) {
    return send(res, 401, { ok: false, error: 'unauthorized' });
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
        accountId: body.accountId,
        prompt: body.prompt,
        pushBranch: body.pushBranch,
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
    return send(res, 200, { ok: true, jobs: store.listJobs().map(publicJob) });
  }

  // GET /usage — account + token usage summary.
  if (path === REMOTE_RUNNER_API_PATHS.usage && req.method === 'GET') {
    return send(res, 200, usageView());
  }

  // GET /usage/ledger — immutable-ish usage/runtime billing events.
  if (path === REMOTE_RUNNER_API_PATHS.usageLedger && req.method === 'GET') {
    return send(res, 200, ledgerView());
  }

  // GET /accounts — list server-side model accounts (redacted).
  if (path === REMOTE_RUNNER_API_PATHS.accounts && req.method === 'GET') {
    return send(res, 200, {
      ok: true,
      accounts: accounts.listPublic(store.listJobs(), queryParam(req, 'projectId')),
    });
  }

  // POST /accounts — create/update a stored account.
  if (path === REMOTE_RUNNER_API_PATHS.accounts && req.method === 'POST') {
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
    if (accounts.isEnvManaged(accountId)) {
      return send(res, 409, { ok: false, error: 'env-managed account cannot be deleted' });
    }
    return send(res, store.deleteAccount(accountId) ? 200 : 404, { ok: true });
  }

  // GET /jobs/:id — single job (includes accumulated logs + result).
  const jobId = matchRemoteRunnerJobPath(path);
  if (jobId && req.method === 'GET') {
    const job = store.getJob(jobId);
    if (!job) return send(res, 404, { ok: false, error: 'not found' });
    return send(res, 200, { ok: true, job: publicJob(job) });
  }

  // POST /jobs/:id/cancel
  const cancelJobId = matchRemoteRunnerJobCancelPath(path);
  if (cancelJobId && req.method === 'POST') {
    const ok = runner.cancel(cancelJobId);
    return send(res, ok ? 200 : 404, { ok });
  }

  // GET /jobs/:id/artifacts — review bundle for UI/backend sync.
  const artifactJobId = matchRemoteRunnerJobArtifactsPath(path);
  if (artifactJobId && req.method === 'GET') {
    const job = store.getJob(artifactJobId);
    if (!job) return send(res, 404, { ok: false, error: 'not found' });
    return send(res, 200, { ok: true, artifacts: artifactView(job) });
  }

  // GET /jobs/:id/stream — SSE live logs + status.
  const streamJobId = matchRemoteRunnerJobStreamPath(path);
  if (streamJobId && req.method === 'GET') {
    const id = streamJobId;
    const job = store.getJob(id);
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
