import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Tiny JSON-file job/workspace store. No external DB so the runner stays a
 * single `npm start` away from running on any box. Writes are serialized
 * through an in-memory queue to avoid interleaved file writes.
 */
export class JsonStore {
  /** @param {string} dataDir */
  constructor(dataDir) {
    this.file = join(dataDir, 'runner-state.json');
    this.state = { jobs: {}, workspaces: {} };
    this._writeChain = Promise.resolve();
    this._loaded = false;
  }

  async load() {
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.state = {
        jobs: parsed.jobs ?? {},
        workspaces: parsed.workspaces ?? {},
      };
    } catch (err) {
      if (err && err.code !== 'ENOENT') throw err;
      // First boot: nothing persisted yet.
    }
    this._loaded = true;
    return this;
  }

  async _persist() {
    const snapshot = JSON.stringify(this.state, null, 2);
    this._writeChain = this._writeChain.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(this.file, snapshot, 'utf8');
    });
    return this._writeChain;
  }

  upsertJob(job) {
    this.state.jobs[job.id] = job;
    void this._persist();
    return job;
  }

  getJob(id) {
    return this.state.jobs[id] ?? null;
  }

  listJobs() {
    return Object.values(this.state.jobs).sort(
      (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
    );
  }

  upsertWorkspace(ws) {
    this.state.workspaces[ws.id] = ws;
    void this._persist();
    return ws;
  }

  getWorkspace(id) {
    return this.state.workspaces[id] ?? null;
  }

  listWorkspaces() {
    return Object.values(this.state.workspaces);
  }
}
