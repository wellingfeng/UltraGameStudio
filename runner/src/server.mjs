#!/usr/bin/env node
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeAuthorizer } from './auth.mjs';
import { JsonStore } from './store.mjs';
import { JobRunner } from './runner.mjs';
import { supportedAdapters } from './models.mjs';

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
  host: process.env.FUC_RUNNER_HOST || '0.0.0.0',
  port: Number(process.env.FUC_RUNNER_PORT || 8787),
  token: process.env.FUC_RUNNER_TOKEN || '',
  workdir: resolve(process.env.FUC_RUNNER_WORKDIR || './workspaces'),
  datadir: resolve(process.env.FUC_RUNNER_DATADIR || './data'),
  maxConcurrency: Number(process.env.FUC_RUNNER_MAX_CONCURRENCY || 2),
  jobTimeoutMs: Number(process.env.FUC_RUNNER_JOB_TIMEOUT || 1800) * 1000,
  execAllowlist: (process.env.FUC_RUNNER_EXEC_ALLOWLIST || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

const auth = makeAuthorizer(cfg.token);
const store = await new JsonStore(cfg.datadir).load();
const runner = new JobRunner({
  store,
  workdir: cfg.workdir,
  maxConcurrency: cfg.maxConcurrency,
  jobTimeoutMs: cfg.jobTimeoutMs,
  execAllowlist: cfg.execAllowlist,
});

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/plain' : 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    ...headers,
  });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolveBody) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 2_000_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolveBody(data ? JSON.parse(data) : {});
      } catch {
        resolveBody(null);
      }
    });
    req.on('error', () => resolveBody(null));
  });
}

/** Public job view: never leak secrets. */
function publicJob(job) {
  if (!job) return null;
  const { _apiKey, _baseUrl, _gitToken, ...rest } = job;
  return rest;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') return send(res, 204, '');

  // Health check is unauthenticated so clients can probe reachability + read
  // the server's auth requirement before sending a token.
  if (path === '/health' && req.method === 'GET') {
    return send(res, 200, {
      ok: true,
      service: 'fuc-remote-runner',
      version: '0.1.0',
      authRequired: auth.configured,
      adapters: supportedAdapters(),
      maxConcurrency: cfg.maxConcurrency,
    });
  }

  // Everything below requires a valid bearer token.
  if (!auth.check(req.headers.authorization)) {
    return send(res, 401, { ok: false, error: 'unauthorized' });
  }

  // POST /jobs — create a remote job.
  if (path === '/jobs' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body || typeof body.prompt !== 'string' || !body.prompt.trim()) {
      return send(res, 400, { ok: false, error: 'prompt is required' });
    }
    const job = runner.enqueue({
      repoUrl: body.repoUrl,
      branch: body.branch,
      adapter: body.adapter,
      model: body.model,
      prompt: body.prompt,
      pushBranch: body.pushBranch,
    });
    // Attach secrets out-of-band so they never land in the persisted record's
    // public fields (they are deleted again once the job finishes).
    const stored = store.getJob(job.id);
    if (body.apiKey) stored._apiKey = String(body.apiKey);
    if (body.baseUrl) stored._baseUrl = String(body.baseUrl);
    if (body.gitToken) stored._gitToken = String(body.gitToken);
    return send(res, 201, { ok: true, job: publicJob(job) });
  }

  // GET /jobs — list jobs.
  if (path === '/jobs' && req.method === 'GET') {
    return send(res, 200, { ok: true, jobs: store.listJobs().map(publicJob) });
  }

  // GET /jobs/:id — single job (includes accumulated logs + result).
  const jobMatch = /^\/jobs\/([^/]+)$/.exec(path);
  if (jobMatch && req.method === 'GET') {
    const job = store.getJob(jobMatch[1]);
    if (!job) return send(res, 404, { ok: false, error: 'not found' });
    return send(res, 200, { ok: true, job: publicJob(job) });
  }

  // POST /jobs/:id/cancel
  const cancelMatch = /^\/jobs\/([^/]+)\/cancel$/.exec(path);
  if (cancelMatch && req.method === 'POST') {
    const ok = runner.cancel(cancelMatch[1]);
    return send(res, ok ? 200 : 404, { ok });
  }

  // GET /jobs/:id/stream — SSE live logs + status.
  const streamMatch = /^\/jobs\/([^/]+)\/stream$/.exec(path);
  if (streamMatch && req.method === 'GET') {
    const id = streamMatch[1];
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
    for (const line of job.logs) write('log', line);
    write('status', job.status);

    const onLog = (line) => write('log', line);
    const onStatus = (status) => {
      write('status', status);
      if (status === 'done' || status === 'error') {
        write('result', publicJob(store.getJob(id)));
        cleanup();
        res.end();
      }
    };
    const cleanup = () => {
      runner.off(`log:${id}`, onLog);
      runner.off(`status:${id}`, onStatus);
    };
    runner.on(`log:${id}`, onLog);
    runner.on(`status:${id}`, onStatus);
    req.on('close', cleanup);

    // If the job already finished, close after replay.
    if (job.status === 'done' || job.status === 'error') {
      write('result', publicJob(job));
      cleanup();
      res.end();
    }
    return undefined;
  }

  return send(res, 404, { ok: false, error: 'not found' });
});

server.listen(cfg.port, cfg.host, () => {
  const where = `${cfg.host}:${cfg.port}`;
  console.log(`[fuc-runner] listening on http://${where}`);
  if (!auth.configured) {
    console.warn(
      '[fuc-runner] WARNING: FUC_RUNNER_TOKEN is not set. All authenticated ' +
        'endpoints will reject every request (fail-closed). Set a token before use.',
    );
  }
  console.log(`[fuc-runner] workdir=${cfg.workdir} datadir=${cfg.datadir}`);
});

export { server, runner, store };
