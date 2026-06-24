import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import * as git from './git.mjs';
import { ensureGitReadyForSync } from './environment.mjs';
import { resolveInvocation } from './models.mjs';
import {
  addUsage,
  emptyUsage,
  usageFromText,
  usageLedgerEntriesForJob,
} from './usage.mjs';
import {
  REMOTE_JOB_CANCELABLE_STATUSES,
} from '../../packages/protocol/index.js';
import { userSettingsRoot } from './user-settings.mjs';
import {
  assertWorkspaceBoundary,
  jobWorkspaceDir,
  projectWorkspaceDir,
} from './workspace-boundary.mjs';

export { toolSubject };


function objectValue(value) {
  return typeof value === 'object' && value !== null ? value : null;
}

function stringValue(value) {
  return typeof value === 'string' ? value : '';
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const obj = objectValue(block);
      if (!obj) return '';
      if (obj.type === 'text') return stringValue(obj.text);
      return '';
    })
    .join('');
}

function textFromMessage(value) {
  const message = objectValue(value);
  if (!message) return '';
  return (
    textFromContent(message.content) ||
    stringValue(message.text) ||
    stringValue(message.result) ||
    stringValue(message.output_text)
  );
}

function eventKind(event) {
  return stringValue(event.method) || stringValue(event.type);
}

function completedItem(event) {
  const kind = eventKind(event);
  if (kind !== 'item.completed' && kind !== 'item/completed') return null;
  return objectValue(event.item) || objectValue(objectValue(event.params)?.item);
}

function toolSubject(item) {
  // Only surface a short identifying subject (command / file path / query) for a
  // tool line. Deliberately exclude free-form `text` and content bodies so the
  // agent's edited/printed source never leaks into the live chat stream.
  for (const key of ['command', 'name', 'path', 'file_path', 'query', 'status']) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim().replace(/[\r\n]/g, ' ').slice(0, 200);
    }
  }
  return '';
}

const TOOL_ARG_LEAF_KEYS = new Set([
  'command',
  'name',
  'path',
  'file_path',
  'relative_path',
  'target_file',
  'target_path',
  'old_path',
  'new_path',
  'query',
  'status',
]);

const TOOL_ARG_CONTAINER_KEYS = new Set([
  'files',
  'paths',
  'changes',
  'modified_files',
  'changed_files',
]);

function sanitizeToolArgValue(value, depth = 0) {
  if (depth > 5) return undefined;
  if (
    value == null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const items = value
      .map((item) => sanitizeToolArgValue(item, depth + 1))
      .filter((item) => item !== undefined);
    return items.length > 0 ? items : undefined;
  }
  const obj = objectValue(value);
  if (!obj) return undefined;
  const out = {};
  for (const [key, child] of Object.entries(obj)) {
    if (!TOOL_ARG_LEAF_KEYS.has(key) && !TOOL_ARG_CONTAINER_KEYS.has(key)) {
      continue;
    }
    const safe = sanitizeToolArgValue(child, depth + 1);
    if (safe !== undefined) out[key] = safe;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function toolArgs(item) {
  const out = {};
  for (const key of [...TOOL_ARG_LEAF_KEYS, ...TOOL_ARG_CONTAINER_KEYS]) {
    if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
    const safe = sanitizeToolArgValue(item[key]);
    if (safe !== undefined) out[key] = safe;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function remoteMessagesFromJsonEvent(event) {
  const messages = [];
  const item = completedItem(event);
  if (item) {
    const itemType = stringValue(item.type);
    if (itemType === 'agent_message') {
      const text = stringValue(item.text);
      if (text) messages.push({ role: 'assistant', kind: 'delta', text, source: 'codex' });
    } else if (itemType) {
      const subject = toolSubject(item);
      messages.push({
        role: 'tool',
        kind: 'tool',
        source: 'codex',
        toolName: itemType,
        status: stringValue(item.status) || 'done',
        text: subject ? `${itemType}: ${subject}` : itemType,
        args: toolArgs(item),
      });
    }
    return messages;
  }

  const type = stringValue(event.type);
  if (type === 'assistant') {
    const text = textFromMessage(event.message) || textFromContent(event.content);
    if (text) messages.push({ role: 'assistant', kind: 'delta', text, source: 'claude' });
  } else if (
    type === 'message' &&
    (stringValue(event.role) === 'assistant' ||
      stringValue(objectValue(event.message)?.role) === 'assistant')
  ) {
    const text = textFromMessage(event.message) || textFromContent(event.content);
    if (text) messages.push({ role: 'assistant', kind: 'delta', text, source: 'generic' });
  } else if (type === 'message_delta' || type === 'content_block_delta') {
    const text =
      stringValue(objectValue(event.delta)?.text) ||
      stringValue(objectValue(event.delta)?.content);
    if (text) messages.push({ role: 'assistant', kind: 'delta', text, source: 'generic' });
  } else if (type === 'response.output_text.delta') {
    const text = stringValue(event.delta);
    if (text) messages.push({ role: 'assistant', kind: 'delta', text, source: 'openai' });
  } else if (type === 'response.completed') {
    const response = objectValue(event.response);
    const text =
      stringValue(response?.output_text) ||
      textFromContent(response?.output);
    if (text) messages.push({ role: 'assistant', kind: 'final', text, source: 'openai' });
  } else if (type === 'result') {
    const text = stringValue(event.result);
    if (text) messages.push({ role: 'assistant', kind: 'final', text, source: 'generic' });
  } else if (type === 'error') {
    const text = stringValue(event.message) || stringValue(objectValue(event.error)?.message);
    if (text) messages.push({ role: 'error', kind: 'error', text, source: 'generic' });
  }

  return messages;
}

function remoteMessagesFromChunk(state, chunk, flush = false) {
  const out = [];
  state.jsonBuffer += chunk;
  const lines = state.jsonBuffer.split(/\r?\n/);
  const tail = lines.pop() ?? '';
  state.jsonBuffer = flush ? '' : tail;
  if (flush && tail) lines.push(tail);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    out.push(...remoteMessagesFromJsonEvent(event));
  }
  return out;
}

/**
 * Owns the lifecycle of remote jobs. Each job runs in its own working dir under
 * the configured workdir. Logs are streamed via an EventEmitter so the HTTP
 * layer can relay them over SSE.
 *
 * Job phases: queued -> cloning -> running -> diffing -> (pushing) -> done|error|canceled.
 */
export class JobRunner extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('./store.mjs').JsonStore} opts.store
   * @param {string} opts.workdir
   * @param {number} opts.maxConcurrency
   * @param {number} opts.jobTimeoutMs
   * @param {string[]} opts.execAllowlist
   * @param {import('./accounts.mjs').AccountRegistry} [opts.accounts]
   */
  constructor(opts) {
    super();
    this.store = opts.store;
    this.workdir = opts.workdir;
    this.maxConcurrency = Math.max(1, opts.maxConcurrency || 2);
    this.jobTimeoutMs = Math.max(60_000, opts.jobTimeoutMs || 1_800_000);
    this.execAllowlist = opts.execAllowlist ?? [];
    this.accounts = opts.accounts ?? null;
    this.active = new Set();
    this.queue = [];
    this.cancelled = new Set();
    /** @type {Map<string, import('node:child_process').ChildProcess>} */
    this.procs = new Map();
    this._recoverInterruptedJobs();
  }

  _recoverInterruptedJobs() {
    const now = Date.now();
    for (const job of this.store.listJobs?.() ?? []) {
      if (!REMOTE_JOB_CANCELABLE_STATUSES.includes(job.status)) continue;
      job.error = 'runner restarted before this job finished';
      job.finishedAt ??= now;
      job.runtimeMs = job.startedAt
        ? Math.max(0, job.finishedAt - job.startedAt)
        : 0;
      job.logs ??= [];
      job.logs.push({
        at: now,
        phase: 'runner',
        stream: 'stderr',
        text: job.error,
      });
      this._scrubSecrets(job);
      job.status = 'error';
      job.updatedAt = now;
      this.store.upsertJob(job);
    }
  }

  _projectDir(project) {
    return projectWorkspaceDir(this.workdir, project);
  }

  _jobDir(jobId) {
    return jobWorkspaceDir(this.workdir, jobId);
  }

  _userSettingsRoot(userId = 'default') {
    return userSettingsRoot(this.workdir, userId);
  }

  _projectForJob(input) {
    const projectId = String(input.projectId ?? '').trim();
    if (!projectId) return null;
    const userId = String(input.userId ?? 'default').trim() || 'default';
    return this.store.getProject?.(projectId, userId) ?? null;
  }

  /** Create + enqueue a job. Returns the persisted job record. */
  enqueue(input) {
    const id = `job_${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const project = this._projectForJob(input);
    if (input.projectId && !project) {
      throw new Error('project not found');
    }
    const userId =
      project?.userId ?? (String(input.userId ?? 'default').trim() || 'default');
    const repoUrl = project?.repoUrl ?? input.repoUrl ?? null;
    const branch = input.branch ?? project?.branch ?? null;
    const pushBranch = input.pushBranch ?? project?.pushBranch ?? null;
    const job = {
      id,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      userId,
      projectId: project?.id ?? input.projectId ?? null,
      repoUrl,
      branch,
      adapter: input.adapter ?? project?.adapter ?? 'claude',
      model: input.model ?? project?.model ?? null,
      accountId: input.accountId ?? null,
      prompt: input.prompt ?? '',
      pushBranch,
      logs: [],
      messages: [],
      result: null,
      error: null,
    };
    if (project?.gitToken) job._gitToken = project.gitToken;
    this.store.upsertJob(job);
    this.queue.push(id);
    queueMicrotask(() => this._drain());
    return job;
  }

  _log(job, entry) {
    const line = { at: Date.now(), ...entry };
    job.logs.push(line);
    if (job.logs.length > 5000) job.logs.splice(0, job.logs.length - 5000);
    job.updatedAt = line.at;
    this.store.upsertJob(job);
    this.emit(`log:${job.id}`, line);
  }

  _message(job, entry) {
    const message = { at: Date.now(), ...entry };
    job.messages ??= [];
    job.messages.push(message);
    if (job.messages.length > 5000) job.messages.splice(0, job.messages.length - 5000);
    job.updatedAt = message.at;
    this.store.upsertJob(job);
    this.emit(`message:${job.id}`, message);
  }

  _setStatus(job, status) {
    job.status = status;
    job.updatedAt = Date.now();
    this.store.upsertJob(job);
    this.emit(`status:${job.id}`, status);
  }

  _scrubSecrets(job) {
    delete job._apiKey;
    delete job._baseUrl;
    delete job._gitToken;
    delete job._accountApiKey;
    delete job._accountBaseUrl;
  }

  _isCancelled(job) {
    return this.cancelled.has(job.id) || job.status === 'canceled';
  }

  _failCanceled(job) {
    job.error = 'canceled';
    this._scrubSecrets(job);
    this._finalizeLedger(job, 'canceled');
    this._setStatus(job, 'canceled');
  }

  _finalizeLedger(job, status = job.status) {
    const now = Date.now();
    job.finishedAt ??= now;
    job.runtimeMs = Math.max(
      0,
      job.finishedAt - (job.startedAt ?? job.createdAt ?? now),
    );
    this.store.upsertLedgerEntries?.(usageLedgerEntriesForJob({ ...job, status }));
  }

  _commandAllowed(command) {
    if (!this.execAllowlist.length) return true;
    const normalized = String(command ?? '').trim().toLowerCase();
    return this.execAllowlist.some((allowed) => {
      const item = String(allowed ?? '').trim().toLowerCase();
      return item && (normalized === item || normalized.endsWith(`/${item}`) || normalized.endsWith(`\\${item}`));
    });
  }

  _drain() {
    while (this.active.size < this.maxConcurrency && this.queue.length > 0) {
      const id = this.queue.shift();
      const job = this.store.getJob(id);
      if (!job || job.status !== 'queued') continue;
      this.active.add(id);
      this._execute(job)
        .catch((err) => {
          if (!this._isCancelled(job)) {
            job.error = String(err?.message ?? err);
            this._scrubSecrets(job);
            this._finalizeLedger(job, 'error');
            this._setStatus(job, 'error');
          }
        })
        .finally(() => {
          this.active.delete(id);
          this.procs.delete(id);
          this.cancelled.delete(id);
          this._drain();
        });
    }
  }

  async _execute(job) {
    const project = job.projectId
      ? this.store.getProject?.(job.projectId, job.userId ?? 'default')
      : null;
    const dir = project ? this._projectDir(project) : this._jobDir(job.id);
    const settingsRoot = this._userSettingsRoot(job.userId ?? 'default');
    job.startedAt = Date.now();
    this.store.upsertJob(job);
    await assertWorkspaceBoundary(this.workdir, dir, { create: true });
    await mkdir(settingsRoot, { recursive: true });
    if (this._isCancelled(job)) {
      this._failCanceled(job);
      return;
    }

    // 1. Sync code — clone only on first touch.
    // A project workspace is cloned once; after that every job reuses the
    // existing checkout instead of re-running the clone/pull on each task.
    // This drops the "fixed" sync step users saw before every run. To pull
    // the repo's latest commits, use the project file-tree refresh/sync path
    // (server.mjs ensureProjectWorkspaceReady with sync=true), not the runner.
    // Temporary (non-project) jobs get a fresh dir each time, so they still
    // clone here.
    if (job.repoUrl) {
      const alreadyCloned = project ? await git.isGitWorkspace(dir) : false;
      if (!alreadyCloned) {
        this._setStatus(job, 'cloning');
        // Gate sync on git availability — the remote host ships nothing
        // preinstalled, so fail with an actionable message before the clone.
        try {
          await ensureGitReadyForSync();
        } catch (err) {
          job.error = String(err?.message ?? err);
          this._log(job, { phase: 'git', stream: 'stderr', text: job.error });
          this._scrubSecrets(job);
          this._finalizeLedger(job, 'error');
          this._setStatus(job, 'error');
          return;
        }
        const clone = project
          ? await git.ensureWorkspace({
              repoUrl: job.repoUrl,
              branch: job.branch,
              dir,
              token: job._gitToken,
              onLog: (l) => this._log(job, { phase: 'git', ...l }),
            })
          : await git.ensureClone({
          repoUrl: job.repoUrl,
          branch: job.branch,
          dir,
          token: job._gitToken,
          onLog: (l) => this._log(job, { phase: 'git', ...l }),
            });
        if (this._isCancelled(job)) {
          this._failCanceled(job);
          return;
        }
        if (!clone.ok) {
          job.error = `git sync failed: ${clone.stderr}`;
          this._scrubSecrets(job);
          this._finalizeLedger(job, 'error');
          this._setStatus(job, 'error');
          return;
        }
      }
    }
    if (this._isCancelled(job)) {
      this._failCanceled(job);
      return;
    }

    // 2. Run the agent CLI.
    this._setStatus(job, 'running');
    const account = this.accounts?.resolveForJob(job, this.store.listJobs()) ?? null;
    if (account) {
      const creds = this.accounts.credentials(account);
      job.accountId = account.id;
      if (!job.model && account.model) job.model = account.model;
      if (!job._apiKey && creds.apiKey) job._accountApiKey = creds.apiKey;
      if (!job._baseUrl && creds.baseUrl) job._accountBaseUrl = creds.baseUrl;
      this.store.upsertJob(job);
      this._log(job, {
        phase: 'account',
        stream: 'stdout',
        text: 'account selected',
      });
    } else if (this.accounts?.accounts?.length) {
      this._log(job, {
        phase: 'account',
        stream: 'stderr',
        text: 'no enabled account matched this adapter/model; falling back to server env or client-supplied key',
      });
    }
    const invocation = resolveInvocation({
      adapter: job.adapter,
      model: job.model,
      prompt: job.prompt,
      apiKey: job._apiKey,
      baseUrl: job._baseUrl,
      accountApiKey: job._accountApiKey,
      accountBaseUrl: job._accountBaseUrl,
    });
    if (invocation.missingKey) {
      this._log(job, {
        phase: 'model',
        stream: 'stderr',
        text:
          'No API key resolved for this adapter (neither client-supplied nor server env). The CLI may prompt or fail.',
      });
    }

    if (!this._commandAllowed(invocation.command)) {
      job.error = `command not allowed: ${invocation.command}`;
      this._log(job, {
        phase: 'model',
        stream: 'stderr',
        text: `command not allowed by UGS_RUNNER_EXEC_ALLOWLIST: ${invocation.command}`,
      });
      this._scrubSecrets(job);
      this._finalizeLedger(job, 'error');
      this._setStatus(job, 'error');
      return;
    }

    if ((job.projectId || job.repoUrl) && !invocation.enforcesWorkspaceBoundary) {
      job.error = `adapter does not enforce workspace boundary: ${job.adapter}`;
      this._log(job, {
        phase: 'model',
        stream: 'stderr',
        text: job.error,
      });
      this._scrubSecrets(job);
      this._finalizeLedger(job, 'error');
      this._setStatus(job, 'error');
      return;
    }

    const exit = await this._spawn(job, invocation.command, invocation.args, {
      cwd: dir,
      env: { ...(invocation.env ?? {}), UGS_HOME: settingsRoot },
      input: invocation.input ?? job.prompt,
    });
    if (this._isCancelled(job)) {
      this._failCanceled(job);
      return;
    }
    job.usage = exit.usage;

    // 3. Diff working tree.
    if (job.repoUrl) {
      this._setStatus(job, 'diffing');
      const d = await git.diff({ dir });
      job.result = { exitCode: exit.code, patch: d.patch, usage: exit.usage };
      if (this._isCancelled(job)) {
        this._failCanceled(job);
        return;
      }

      // 4. Optional push to a branch.
      if (job.pushBranch && d.patch.trim()) {
        this._setStatus(job, 'pushing');
        const push = await git.commitAndPush({
          dir,
          branch: job.pushBranch,
          message: `UltraGameStudio: ${job.prompt.slice(0, 64)}`,
          token: job._gitToken,
          onLog: (l) => this._log(job, { phase: 'git', ...l }),
        });
        job.result.pushed = push.ok;
        job.result.pushBranch = push.branch;
        if (!push.ok) {
          this._log(job, { phase: 'git', stream: 'stderr', text: push.stderr });
        }
        if (this._isCancelled(job)) {
          this._failCanceled(job);
          return;
        }
      }
    } else {
      job.result = { exitCode: exit.code, usage: exit.usage };
    }

    // Strip secrets before they can be read back via the API.
    this._scrubSecrets(job);
    const finalStatus = exit.code === 0 ? 'done' : 'error';
    if (exit.code !== 0 && !job.error) {
      job.error = `agent exited with code ${exit.code}`;
    }
    this._finalizeLedger(job, finalStatus);
    this._setStatus(job, finalStatus);
  }

  async _spawn(job, command, args, opts) {
    let cwd = opts.cwd;
    try {
      cwd = (await assertWorkspaceBoundary(this.workdir, opts.cwd)).target;
    } catch (err) {
      this._log(job, {
        phase: 'model',
        stream: 'stderr',
        text: `refusing to spawn outside runner workdir: ${String(err?.message ?? err)}`,
      });
      return { code: -1, usage: emptyUsage() };
    }

    return new Promise((resolve) => {
      let child;
      let usage = emptyUsage();
      const modelStreamState = { jsonBuffer: '' };
      const absorbUsage = (chunk) => {
        const parsed = usageFromText(chunk);
        if (parsed) usage = addUsage(usage, parsed);
      };
      try {
        child = spawn(command, args, {
          cwd,
          env: { ...process.env, ...(opts.env ?? {}) },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (err) {
        this._log(job, {
          phase: 'model',
          stream: 'stderr',
          text: `failed to spawn ${command}: ${String(err)}`,
        });
        resolve({ code: -1, usage });
        return;
      }
      this.procs.set(job.id, child);
      child.stdin?.on('error', () => {
        // Ignore EPIPE when the child exits before reading the whole prompt.
      });
      if (child.stdin) {
        child.stdin.write(opts.input ?? '');
        child.stdin.end();
      }

      const timer = setTimeout(() => {
        this._log(job, {
          phase: 'model',
          stream: 'stderr',
          text: `job timed out after ${this.jobTimeoutMs}ms; killing process`,
        });
        child.kill('SIGKILL');
      }, this.jobTimeoutMs);

      child.stdout?.on('data', (d) => {
        const text = d.toString();
        absorbUsage(text);
        this._log(job, { phase: 'model', stream: 'stdout', text });
        for (const message of remoteMessagesFromChunk(modelStreamState, text)) {
          this._message(job, message);
        }
      });
      child.stderr?.on('data', (d) => {
        const text = d.toString();
        absorbUsage(text);
        this._log(job, { phase: 'model', stream: 'stderr', text });
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        this._log(job, {
          phase: 'model',
          stream: 'stderr',
          text: `process error: ${String(err)}`,
        });
        resolve({ code: -1, usage });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        for (const message of remoteMessagesFromChunk(modelStreamState, '', true)) {
          this._message(job, message);
        }
        resolve({ code: this._isCancelled(job) ? -2 : code ?? -1, usage });
      });
    });
  }

  /** Best-effort cancel. */
  cancel(id) {
    const job = this.store.getJob(id);
    if (!job) return false;
    const cancelable = REMOTE_JOB_CANCELABLE_STATUSES.includes(job.status);
    if (!cancelable) return true;
    this.cancelled.add(id);
    this.queue = this.queue.filter((queuedId) => queuedId !== id);
    const child = this.procs.get(id);
    if (child) child.kill('SIGKILL');
    this._failCanceled(job);
    return true;
  }
}
