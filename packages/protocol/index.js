export const REMOTE_JOB_STATUSES = Object.freeze([
  'queued',
  'cloning',
  'running',
  'diffing',
  'pushing',
  'done',
  'error',
  'canceled',
]);

export const REMOTE_JOB_TERMINAL_STATUSES = Object.freeze([
  'done',
  'error',
  'canceled',
]);

export const REMOTE_JOB_CANCELABLE_STATUSES = Object.freeze([
  'queued',
  'cloning',
  'running',
  'diffing',
  'pushing',
]);

export const REMOTE_RUNNER_SERVICE = 'ugs-remote-runner';

export const REMOTE_RUNNER_API_PATHS = Object.freeze({
  health: '/health',
  jobs: '/jobs',
  projects: '/projects',
  usage: '/usage',
  usageLedger: '/usage/ledger',
  accounts: '/accounts',
  userSettings: '/user-settings',
  job: (id) => `/jobs/${encodeURIComponent(id)}`,
  jobArtifacts: (id) => `/jobs/${encodeURIComponent(id)}/artifacts`,
  jobCancel: (id) => `/jobs/${encodeURIComponent(id)}/cancel`,
  jobStream: (id) => `/jobs/${encodeURIComponent(id)}/stream`,
  project: (id) => `/projects/${encodeURIComponent(id)}`,
  projectFiles: (id) => `/projects/${encodeURIComponent(id)}/files`,
  projectEnvironment: (id) => `/projects/${encodeURIComponent(id)}/environment`,
  projectEnvironmentInstall: (id) =>
    `/projects/${encodeURIComponent(id)}/environment/install`,
  account: (id) => `/accounts/${encodeURIComponent(id)}`,
});

export const REMOTE_RUNNER_SSE_EVENTS = Object.freeze({
  log: 'log',
  message: 'message',
  status: 'status',
  result: 'result',
});

function decodeRemoteRunnerPathId(raw) {
  try {
    const decoded = decodeURIComponent(raw);
    if (!decoded || decoded.includes('/') || decoded.includes('\\')) return null;
    return decoded;
  } catch {
    return null;
  }
}

function matchRemoteRunnerSingleIdPath(path, collectionPath) {
  const prefix = `${collectionPath}/`;
  if (!path.startsWith(prefix)) return null;
  const raw = path.slice(prefix.length);
  if (!raw || raw.includes('/')) return null;
  return decodeRemoteRunnerPathId(raw);
}

function matchRemoteRunnerNestedIdPath(path, collectionPath, suffix) {
  const prefix = `${collectionPath}/`;
  const suffixPath = `/${suffix}`;
  if (!path.startsWith(prefix) || !path.endsWith(suffixPath)) return null;
  const raw = path.slice(prefix.length, -suffixPath.length);
  if (!raw || raw.includes('/')) return null;
  return decodeRemoteRunnerPathId(raw);
}

export function matchRemoteRunnerProjectPath(path) {
  return matchRemoteRunnerSingleIdPath(path, REMOTE_RUNNER_API_PATHS.projects);
}

export function matchRemoteRunnerProjectFilesPath(path) {
  return matchRemoteRunnerNestedIdPath(path, REMOTE_RUNNER_API_PATHS.projects, 'files');
}

export function matchRemoteRunnerProjectEnvironmentPath(path) {
  return matchRemoteRunnerNestedIdPath(
    path,
    REMOTE_RUNNER_API_PATHS.projects,
    'environment',
  );
}

export function matchRemoteRunnerProjectEnvironmentInstallPath(path) {
  return matchRemoteRunnerNestedIdPath(
    path,
    REMOTE_RUNNER_API_PATHS.projects,
    'environment/install',
  );
}

/**
 * Error mapper for the remote-environment endpoints. An out-of-date cloud
 * backend predates these routes and answers them with the generic 404 fallback
 * ("not found"), even though project binding and file listing keep working. A
 * bare "not found" looks like a broken button, so translate the 404 into an
 * actionable hint: the backend host must be redeployed with the newer build.
 */
function remoteEnvironmentEndpointError(data, status) {
  if (status === 404) {
    return '云端后端不支持「远程环境」接口（/environment 返回 404）。该功能需要较新版本的后端，请在云端主机上更新并重启 runner 后再试。';
  }
  return data?.error ?? `runner returned ${status}`;
}

export const REMOTE_ENVIRONMENT_TOOL_IDS = Object.freeze([
  'git',
  'git-lfs',
  'node',
  'python',
  'ffmpeg',
  'curl',
  'unzip',
]);

export function matchRemoteRunnerJobPath(path) {
  return matchRemoteRunnerSingleIdPath(path, REMOTE_RUNNER_API_PATHS.jobs);
}

export function matchRemoteRunnerJobArtifactsPath(path) {
  return matchRemoteRunnerNestedIdPath(path, REMOTE_RUNNER_API_PATHS.jobs, 'artifacts');
}

export function matchRemoteRunnerJobCancelPath(path) {
  return matchRemoteRunnerNestedIdPath(path, REMOTE_RUNNER_API_PATHS.jobs, 'cancel');
}

export function matchRemoteRunnerJobStreamPath(path) {
  return matchRemoteRunnerNestedIdPath(path, REMOTE_RUNNER_API_PATHS.jobs, 'stream');
}

export function matchRemoteRunnerAccountPath(path) {
  return matchRemoteRunnerSingleIdPath(path, REMOTE_RUNNER_API_PATHS.accounts);
}

export function isRemoteJobStatus(value) {
  return REMOTE_JOB_STATUSES.includes(value);
}

export function isRemoteJobTerminalStatus(value) {
  return REMOTE_JOB_TERMINAL_STATUSES.includes(value);
}

export function isRemoteJobCancelableStatus(value) {
  return REMOTE_JOB_CANCELABLE_STATUSES.includes(value);
}

export function normalizeRemoteServerUrl(raw) {
  return String(raw ?? '').trim().replace(/\/+$/, '');
}

export function remoteRunnerApiUrl(serverUrl, path) {
  return `${normalizeRemoteServerUrl(serverUrl)}${path}`;
}

export class RunnerClient {
  constructor(serverUrl, token) {
    this.serverUrl = normalizeRemoteServerUrl(serverUrl);
    this.token = token;
  }

  headers(json = false) {
    const h = {};
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    if (json) h['content-type'] = 'application/json';
    return h;
  }

  url(path) {
    return remoteRunnerApiUrl(this.serverUrl, path);
  }

  async health(signal) {
    try {
      const res = await fetch(this.url(REMOTE_RUNNER_API_PATHS.health), {
        headers: this.headers(),
        signal,
      });
      if (!res.ok) return { ok: false };
      return await res.json();
    } catch {
      return { ok: false };
    }
  }

  async createJob(input) {
    const res = await fetch(this.url(REMOTE_RUNNER_API_PATHS.jobs), {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify(input),
    });
    const data = await res.json();
    if (!res.ok || !data.ok || !data.job) {
      throw new Error(data.error ?? `runner returned ${res.status}`);
    }
    return data.job;
  }

  async jobs() {
    const res = await fetch(this.url(REMOTE_RUNNER_API_PATHS.jobs), {
      headers: this.headers(),
    });
    const data = await res.json();
    if (!res.ok || !data.ok || !Array.isArray(data.jobs)) {
      throw new Error(data.error ?? `runner returned ${res.status}`);
    }
    return data.jobs;
  }

  async projects() {
    const res = await fetch(this.url(REMOTE_RUNNER_API_PATHS.projects), {
      headers: this.headers(),
    });
    const data = await res.json();
    if (!res.ok || !data.ok || !Array.isArray(data.projects)) {
      throw new Error(data.error ?? `runner returned ${res.status}`);
    }
    return data.projects;
  }

  async getProject(id) {
    const res = await fetch(this.url(REMOTE_RUNNER_API_PATHS.project(id)), {
      headers: this.headers(),
    });
    const data = await res.json();
    if (!res.ok || !data.ok || !data.project) {
      throw new Error(data.error ?? `runner returned ${res.status}`);
    }
    return data.project;
  }

  async saveProject(input) {
    const hasId = Boolean(input.id?.trim());
    const res = await fetch(
      hasId
        ? this.url(REMOTE_RUNNER_API_PATHS.project(input.id.trim()))
        : this.url(REMOTE_RUNNER_API_PATHS.projects),
      {
        method: hasId ? 'PUT' : 'POST',
        headers: this.headers(true),
        body: JSON.stringify(input),
      },
    );
    const data = await res.json();
    if (!res.ok || !data.ok || !data.project) {
      throw new Error(data.error ?? `runner returned ${res.status}`);
    }
    return data.project;
  }

  async deleteProject(id) {
    const res = await fetch(this.url(REMOTE_RUNNER_API_PATHS.project(id)), {
      method: 'DELETE',
      headers: this.headers(),
    });
    return res.ok;
  }

  async usage() {
    const res = await fetch(this.url(REMOTE_RUNNER_API_PATHS.usage), {
      headers: this.headers(),
    });
    const data = await res.json();
    if (!res.ok || !data.ok || !('totals' in data)) {
      throw new Error('error' in data ? data.error : `runner returned ${res.status}`);
    }
    return data;
  }

  async usageLedger() {
    const res = await fetch(this.url(REMOTE_RUNNER_API_PATHS.usageLedger), {
      headers: this.headers(),
    });
    const data = await res.json();
    if (!res.ok || !data.ok || !('entries' in data)) {
      throw new Error('error' in data ? data.error : `runner returned ${res.status}`);
    }
    return data;
  }

  async accounts(projectId) {
    const query = projectId?.trim() ? `?projectId=${encodeURIComponent(projectId.trim())}` : '';
    const res = await fetch(this.url(`${REMOTE_RUNNER_API_PATHS.accounts}${query}`), {
      headers: this.headers(),
    });
    const data = await res.json();
    if (Array.isArray(data)) return data;
    if (!res.ok || !data.ok || !Array.isArray(data.accounts)) {
      throw new Error('error' in data ? data.error : `runner returned ${res.status}`);
    }
    return data.accounts;
  }

  async readUserSetting(relPath) {
    const params = new URLSearchParams();
    params.set('path', relPath);
    const res = await fetch(
      this.url(`${REMOTE_RUNNER_API_PATHS.userSettings}?${params}`),
      { headers: this.headers() },
    );
    const data = await res.json();
    if (!res.ok || !data.ok || !Object.prototype.hasOwnProperty.call(data, 'text')) {
      throw new Error(data.error ?? `runner returned ${res.status}`);
    }
    return typeof data.text === 'string' ? data.text : null;
  }

  async writeUserSetting(relPath, json) {
    const res = await fetch(this.url(REMOTE_RUNNER_API_PATHS.userSettings), {
      method: 'PUT',
      headers: this.headers(true),
      body: JSON.stringify({ path: relPath, json }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error ?? `runner returned ${res.status}`);
    }
  }

  async deleteUserSetting(relPath) {
    const params = new URLSearchParams();
    params.set('path', relPath);
    const res = await fetch(
      this.url(`${REMOTE_RUNNER_API_PATHS.userSettings}?${params}`),
      { method: 'DELETE', headers: this.headers() },
    );
    return res.ok;
  }

  async saveAccount(input) {
    const res = await fetch(this.url(REMOTE_RUNNER_API_PATHS.accounts), {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify(input),
    });
    const data = await res.json();
    if (!res.ok || !data.ok || !data.account) {
      throw new Error(data.error ?? `runner returned ${res.status}`);
    }
    return data.account;
  }

  async updateAccount(id, input) {
    const res = await fetch(this.url(REMOTE_RUNNER_API_PATHS.account(id)), {
      method: 'PUT',
      headers: this.headers(true),
      body: JSON.stringify({ ...input, id }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok || !data.account) {
      throw new Error(data.error ?? `runner returned ${res.status}`);
    }
    return data.account;
  }

  async deleteAccount(id) {
    const res = await fetch(this.url(REMOTE_RUNNER_API_PATHS.account(id)), {
      method: 'DELETE',
      headers: this.headers(),
    });
    return res.ok;
  }

  async getJob(id) {
    const res = await fetch(this.url(REMOTE_RUNNER_API_PATHS.job(id)), {
      headers: this.headers(),
    });
    const data = await res.json();
    if (!res.ok || !data.ok || !data.job) {
      throw new Error(data.error ?? `runner returned ${res.status}`);
    }
    return data.job;
  }

  async getJobArtifacts(id) {
    const res = await fetch(
      this.url(REMOTE_RUNNER_API_PATHS.jobArtifacts(id)),
      { headers: this.headers() },
    );
    const data = await res.json();
    if (!res.ok || !data.ok || !data.artifacts) {
      throw new Error(data.error ?? `runner returned ${res.status}`);
    }
    return data.artifacts;
  }

  async listProjectDirectory(projectId, relativePath = '', opts = {}) {
    const params = new URLSearchParams();
    if (relativePath) params.set('path', relativePath);
    if (opts.sync) params.set('sync', '1');
    const suffix = params.toString() ? `?${params}` : '';
    const res = await fetch(
      this.url(`${REMOTE_RUNNER_API_PATHS.projectFiles(projectId)}${suffix}`),
      { headers: this.headers() },
    );
    const data = await res.json();
    if (!res.ok || !data.ok || !data.listing) {
      throw new Error(data.error ?? `runner returned ${res.status}`);
    }
    return data.listing;
  }

  async uploadProjectFile(projectId, input) {
    const res = await fetch(
      this.url(REMOTE_RUNNER_API_PATHS.projectFiles(projectId)),
      {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify(input),
      },
    );
    const data = await res.json();
    if (!res.ok || !data.ok || !data.file) {
      throw new Error(data.error ?? `runner returned ${res.status}`);
    }
    return data.file;
  }

  async getProjectEnvironment(projectId) {
    const res = await fetch(
      this.url(REMOTE_RUNNER_API_PATHS.projectEnvironment(projectId)),
      { headers: this.headers() },
    );
    const data = await res.json();
    if (!res.ok || !data.ok || !data.environment) {
      throw new Error(remoteEnvironmentEndpointError(data, res.status));
    }
    return data.environment;
  }

  async installProjectEnvironment(projectId, input = {}) {
    const res = await fetch(
      this.url(REMOTE_RUNNER_API_PATHS.projectEnvironmentInstall(projectId)),
      {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify(input),
      },
    );
    const data = await res.json();
    if (!res.ok || !data.ok || !data.install) {
      throw new Error(remoteEnvironmentEndpointError(data, res.status));
    }
    return data.install;
  }

  async previewProjectFile(projectId, relativePath) {
    const params = new URLSearchParams();
    params.set('path', relativePath);
    params.set('preview', '1');
    const res = await fetch(
      this.url(`${REMOTE_RUNNER_API_PATHS.projectFiles(projectId)}?${params}`),
      { headers: this.headers() },
    );
    const data = await res.json();
    if (!res.ok || !data.ok || !data.file) {
      throw new Error(data.error ?? `runner returned ${res.status}`);
    }
    return data.file;
  }

  async cancelJob(id) {
    const res = await fetch(
      this.url(REMOTE_RUNNER_API_PATHS.jobCancel(id)),
      { method: 'POST', headers: this.headers() },
    );
    return res.ok;
  }

  streamJob(id, handlers) {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(
          this.url(REMOTE_RUNNER_API_PATHS.jobStream(id)),
          { headers: this.headers(), signal: controller.signal },
        );
        if (!res.ok || !res.body) {
          handlers.onError?.(new Error(`stream returned ${res.status}`));
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split('\n\n');
          buffer = events.pop() ?? '';
          for (const chunk of events) dispatchRemoteRunnerSse(chunk, handlers);
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
        }
      }
    })();
    return () => controller.abort();
  }
}

function dispatchRemoteRunnerSse(chunk, handlers) {
  let event = 'message';
  const dataLines = [];
  for (const line of chunk.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return;
  let payload;
  try {
    payload = JSON.parse(dataLines.join('\n'));
  } catch {
    return;
  }
  if (event === REMOTE_RUNNER_SSE_EVENTS.log) handlers.onLog?.(payload);
  else if (event === REMOTE_RUNNER_SSE_EVENTS.message) handlers.onMessage?.(payload);
  else if (event === REMOTE_RUNNER_SSE_EVENTS.status) handlers.onStatus?.(payload);
  else if (event === REMOTE_RUNNER_SSE_EVENTS.result) handlers.onResult?.(payload);
}
