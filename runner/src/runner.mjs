import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import * as git from './git.mjs';
import { resolveInvocation } from './models.mjs';

/**
 * Owns the lifecycle of remote jobs. Each job runs in its own working dir under
 * the configured workdir. Logs are streamed via an EventEmitter so the HTTP
 * layer can relay them over SSE.
 *
 * Job phases: queued -> cloning -> running -> diffing -> (pushing) -> done|error.
 */
export class JobRunner extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('./store.mjs').JsonStore} opts.store
   * @param {string} opts.workdir
   * @param {number} opts.maxConcurrency
   * @param {number} opts.jobTimeoutMs
   * @param {string[]} opts.execAllowlist
   */
  constructor(opts) {
    super();
    this.store = opts.store;
    this.workdir = opts.workdir;
    this.maxConcurrency = Math.max(1, opts.maxConcurrency || 2);
    this.jobTimeoutMs = Math.max(60_000, opts.jobTimeoutMs || 1_800_000);
    this.execAllowlist = opts.execAllowlist ?? [];
    this.active = new Set();
    this.queue = [];
    /** @type {Map<string, import('node:child_process').ChildProcess>} */
    this.procs = new Map();
  }

  /** Create + enqueue a job. Returns the persisted job record. */
  enqueue(input) {
    const id = `job_${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const job = {
      id,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      repoUrl: input.repoUrl ?? null,
      branch: input.branch ?? null,
      adapter: input.adapter ?? 'claude',
      model: input.model ?? null,
      prompt: input.prompt ?? '',
      pushBranch: input.pushBranch ?? null,
      logs: [],
      result: null,
      error: null,
    };
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

  _setStatus(job, status) {
    job.status = status;
    job.updatedAt = Date.now();
    this.store.upsertJob(job);
    this.emit(`status:${job.id}`, status);
  }

  _drain() {
    while (this.active.size < this.maxConcurrency && this.queue.length > 0) {
      const id = this.queue.shift();
      const job = this.store.getJob(id);
      if (!job || job.status !== 'queued') continue;
      this.active.add(id);
      this._execute(job)
        .catch((err) => {
          job.error = String(err?.message ?? err);
          this._setStatus(job, 'error');
        })
        .finally(() => {
          this.active.delete(id);
          this.procs.delete(id);
          this._drain();
        });
    }
  }

  async _execute(job) {
    const dir = join(this.workdir, job.id);
    await mkdir(dir, { recursive: true });

    // 1. Sync code.
    if (job.repoUrl) {
      this._setStatus(job, 'cloning');
      const clone = await git.ensureClone({
        repoUrl: job.repoUrl,
        branch: job.branch,
        dir,
        token: job._gitToken,
        onLog: (l) => this._log(job, { phase: 'git', ...l }),
      });
      if (!clone.ok) {
        job.error = `git clone failed: ${clone.stderr}`;
        this._setStatus(job, 'error');
        return;
      }
    }

    // 2. Run the agent CLI.
    this._setStatus(job, 'running');
    const invocation = resolveInvocation({
      adapter: job.adapter,
      model: job.model,
      prompt: job.prompt,
      apiKey: job._apiKey,
      baseUrl: job._baseUrl,
    });
    if (invocation.missingKey) {
      this._log(job, {
        phase: 'model',
        stream: 'stderr',
        text:
          'No API key resolved for this adapter (neither client-supplied nor server env). The CLI may prompt or fail.',
      });
    }

    const exit = await this._spawn(job, invocation.command, invocation.args, {
      cwd: dir,
      env: invocation.env,
    });

    // 3. Diff working tree.
    if (job.repoUrl) {
      this._setStatus(job, 'diffing');
      const d = await git.diff({ dir });
      job.result = { exitCode: exit.code, patch: d.patch };

      // 4. Optional push to a branch.
      if (job.pushBranch && d.patch.trim()) {
        this._setStatus(job, 'pushing');
        const push = await git.commitAndPush({
          dir,
          branch: job.pushBranch,
          message: `FreeUltraCode: ${job.prompt.slice(0, 64)}`,
          token: job._gitToken,
          onLog: (l) => this._log(job, { phase: 'git', ...l }),
        });
        job.result.pushed = push.ok;
        job.result.pushBranch = push.branch;
        if (!push.ok) {
          this._log(job, { phase: 'git', stream: 'stderr', text: push.stderr });
        }
      }
    } else {
      job.result = { exitCode: exit.code };
    }

    // Strip secrets before they can be read back via the API.
    delete job._apiKey;
    delete job._baseUrl;
    delete job._gitToken;

    this._setStatus(job, exit.code === 0 ? 'done' : 'error');
    if (exit.code !== 0 && !job.error) {
      job.error = `agent exited with code ${exit.code}`;
      this.store.upsertJob(job);
    }
  }

  _spawn(job, command, args, opts) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(command, args, {
          cwd: opts.cwd,
          env: { ...process.env, ...(opts.env ?? {}) },
          windowsHide: true,
        });
      } catch (err) {
        this._log(job, {
          phase: 'model',
          stream: 'stderr',
          text: `failed to spawn ${command}: ${String(err)}`,
        });
        resolve({ code: -1 });
        return;
      }
      this.procs.set(job.id, child);

      const timer = setTimeout(() => {
        this._log(job, {
          phase: 'model',
          stream: 'stderr',
          text: `job timed out after ${this.jobTimeoutMs}ms; killing process`,
        });
        child.kill('SIGKILL');
      }, this.jobTimeoutMs);

      child.stdout?.on('data', (d) =>
        this._log(job, { phase: 'model', stream: 'stdout', text: d.toString() }),
      );
      child.stderr?.on('data', (d) =>
        this._log(job, { phase: 'model', stream: 'stderr', text: d.toString() }),
      );
      child.on('error', (err) => {
        clearTimeout(timer);
        this._log(job, {
          phase: 'model',
          stream: 'stderr',
          text: `process error: ${String(err)}`,
        });
        resolve({ code: -1 });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1 });
      });
    });
  }

  /** Best-effort cancel. */
  cancel(id) {
    const child = this.procs.get(id);
    if (child) child.kill('SIGKILL');
    const job = this.store.getJob(id);
    if (job && (job.status === 'queued' || job.status === 'running')) {
      job.error = 'cancelled';
      this._setStatus(job, 'error');
    }
    return Boolean(job);
  }
}
