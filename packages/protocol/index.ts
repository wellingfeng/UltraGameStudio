export const REMOTE_JOB_STATUSES = [
  'queued',
  'cloning',
  'running',
  'diffing',
  'pushing',
  'done',
  'error',
  'canceled',
] as const;

export type RemoteJobStatus = (typeof REMOTE_JOB_STATUSES)[number];

export const REMOTE_JOB_TERMINAL_STATUSES = [
  'done',
  'error',
  'canceled',
] as const satisfies readonly RemoteJobStatus[];

export const REMOTE_JOB_CANCELABLE_STATUSES = [
  'queued',
  'cloning',
  'running',
  'diffing',
  'pushing',
] as const satisfies readonly RemoteJobStatus[];

export const REMOTE_RUNNER_SERVICE = 'ugs-remote-runner';

export const REMOTE_RUNNER_API_PATHS = {
  health: '/health',
  jobs: '/jobs',
  projects: '/projects',
  usage: '/usage',
  usageLedger: '/usage/ledger',
  accounts: '/accounts',
  userSettings: '/user-settings',
  job: (id: string) => `/jobs/${encodeURIComponent(id)}`,
  jobArtifacts: (id: string) => `/jobs/${encodeURIComponent(id)}/artifacts`,
  jobCancel: (id: string) => `/jobs/${encodeURIComponent(id)}/cancel`,
  jobStream: (id: string) => `/jobs/${encodeURIComponent(id)}/stream`,
  project: (id: string) => `/projects/${encodeURIComponent(id)}`,
  projectFiles: (id: string) => `/projects/${encodeURIComponent(id)}/files`,
  projectEnvironment: (id: string) =>
    `/projects/${encodeURIComponent(id)}/environment`,
  projectEnvironmentInstall: (id: string) =>
    `/projects/${encodeURIComponent(id)}/environment/install`,
  account: (id: string) => `/accounts/${encodeURIComponent(id)}`,
} as const;

export const REMOTE_RUNNER_SSE_EVENTS = {
  log: 'log',
  message: 'message',
  status: 'status',
  result: 'result',
} as const;

export type RemoteRunnerSseEvent =
  (typeof REMOTE_RUNNER_SSE_EVENTS)[keyof typeof REMOTE_RUNNER_SSE_EVENTS];

function decodeRemoteRunnerPathId(raw: string): string | null {
  try {
    const decoded = decodeURIComponent(raw);
    if (!decoded || decoded.includes('/') || decoded.includes('\\')) return null;
    return decoded;
  } catch {
    return null;
  }
}

function matchRemoteRunnerSingleIdPath(path: string, collectionPath: string): string | null {
  const prefix = `${collectionPath}/`;
  if (!path.startsWith(prefix)) return null;
  const raw = path.slice(prefix.length);
  if (!raw || raw.includes('/')) return null;
  return decodeRemoteRunnerPathId(raw);
}

function matchRemoteRunnerNestedIdPath(
  path: string,
  collectionPath: string,
  suffix: string,
): string | null {
  const prefix = `${collectionPath}/`;
  const suffixPath = `/${suffix}`;
  if (!path.startsWith(prefix) || !path.endsWith(suffixPath)) return null;
  const raw = path.slice(prefix.length, -suffixPath.length);
  if (!raw || raw.includes('/')) return null;
  return decodeRemoteRunnerPathId(raw);
}

export function matchRemoteRunnerProjectPath(path: string): string | null {
  return matchRemoteRunnerSingleIdPath(path, REMOTE_RUNNER_API_PATHS.projects);
}

export function matchRemoteRunnerProjectFilesPath(path: string): string | null {
  return matchRemoteRunnerNestedIdPath(path, REMOTE_RUNNER_API_PATHS.projects, 'files');
}

export function matchRemoteRunnerProjectEnvironmentPath(path: string): string | null {
  return matchRemoteRunnerNestedIdPath(
    path,
    REMOTE_RUNNER_API_PATHS.projects,
    'environment',
  );
}

export function matchRemoteRunnerProjectEnvironmentInstallPath(
  path: string,
): string | null {
  return matchRemoteRunnerNestedIdPath(
    path,
    REMOTE_RUNNER_API_PATHS.projects,
    'environment/install',
  );
}

export function matchRemoteRunnerJobPath(path: string): string | null {
  return matchRemoteRunnerSingleIdPath(path, REMOTE_RUNNER_API_PATHS.jobs);
}

export function matchRemoteRunnerJobArtifactsPath(path: string): string | null {
  return matchRemoteRunnerNestedIdPath(path, REMOTE_RUNNER_API_PATHS.jobs, 'artifacts');
}

export function matchRemoteRunnerJobCancelPath(path: string): string | null {
  return matchRemoteRunnerNestedIdPath(path, REMOTE_RUNNER_API_PATHS.jobs, 'cancel');
}

export function matchRemoteRunnerJobStreamPath(path: string): string | null {
  return matchRemoteRunnerNestedIdPath(path, REMOTE_RUNNER_API_PATHS.jobs, 'stream');
}

export function matchRemoteRunnerAccountPath(path: string): string | null {
  return matchRemoteRunnerSingleIdPath(path, REMOTE_RUNNER_API_PATHS.accounts);
}

export type RemoteAdapter = 'claude' | 'codex' | 'gemini';

export interface RunnerHealth {
  ok: boolean;
  service?: string;
  version?: string;
  authRequired?: boolean;
  adapters?: string[];
  maxConcurrency?: number;
  accountCount?: number;
  accounts?: RemoteRunnerAccount[];
  usage?: RemoteRunnerUsageTotals;
}

export interface RemoteRunnerProject {
  id: string;
  userId?: string;
  label: string;
  repoUrl: string;
  branch?: string | null;
  pushBranch?: string | null;
  adapter?: RemoteAdapter | string;
  model?: string | null;
  createdAt: number;
  updatedAt: number;
  hasGitToken?: boolean;
}

export interface RemoteRunnerProjectInput {
  id?: string;
  label: string;
  repoUrl: string;
  branch?: string;
  pushBranch?: string;
  adapter?: RemoteAdapter;
  model?: string;
  gitToken?: string;
}

export interface RemoteRunnerUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  calls: number;
  lastUsedAt?: number | null;
}

export interface RemoteRunnerAccount {
  id: string;
  projectId?: string | null;
  label: string;
  adapter: RemoteAdapter | string;
  model?: string | null;
  models?: string[] | null;
  enabled: boolean;
  dailyTokenLimit?: number;
  monthlyTokenLimit?: number;
  hasApiKey: boolean;
  hasBaseUrl?: boolean;
  usage?: RemoteRunnerUsageTotals;
}

export interface RemoteRunnerAccountInput {
  id: string;
  projectId?: string | null;
  label: string;
  adapter: RemoteAdapter;
  model?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  baseUrlEnv?: string;
  dailyTokenLimit?: number;
  monthlyTokenLimit?: number;
  enabled?: boolean;
}

export interface RemoteRunnerUsage {
  ok: boolean;
  totals: RemoteRunnerUsageTotals;
  accounts: RemoteRunnerAccount[];
  recentJobs: RemoteJob[];
}

export interface RemoteRunnerLedgerEntry {
  id: string;
  type: 'model_tokens' | 'runtime';
  at: number;
  jobId: string;
  userId?: string | null;
  projectId?: string | null;
  accountId?: string | null;
  adapter?: string | null;
  model?: string | null;
  status?: RemoteJobStatus | null;
  usage?: RemoteRunnerUsageTotals;
  runtimeMs?: number;
}

export interface RemoteRunnerLedger {
  ok: boolean;
  totals: RemoteRunnerUsageTotals & {
    runtimeMs: number;
    runtimeMinutes: number;
    jobs: number;
  };
  entries: RemoteRunnerLedgerEntry[];
}

export interface RemoteJobLogLine {
  at: number;
  phase?: string;
  stream?: 'stdout' | 'stderr';
  text?: string;
}

export interface RemoteJobMessage {
  at: number;
  role: 'assistant' | 'system' | 'tool' | 'error';
  kind: 'delta' | 'final' | 'status' | 'tool' | 'error';
  text?: string;
  source?: string;
  toolName?: string;
  status?: string;
  args?: unknown;
}

export interface RemoteJobResult {
  exitCode: number;
  patch?: string;
  pushed?: boolean;
  pushBranch?: string;
  usage?: RemoteRunnerUsageTotals;
}

export interface RemoteJob {
  id: string;
  status: RemoteJobStatus;
  createdAt: number;
  updatedAt: number;
  projectId?: string | null;
  repoUrl: string | null;
  branch: string | null;
  adapter: string;
  model: string | null;
  prompt: string;
  pushBranch: string | null;
  logs: RemoteJobLogLine[];
  messages?: RemoteJobMessage[];
  result: RemoteJobResult | null;
  error: string | null;
}

export interface RemoteJobArtifacts {
  id: string;
  status: RemoteJobStatus;
  createdAt: number;
  updatedAt: number;
  startedAt?: number | null;
  finishedAt?: number | null;
  runtimeMs: number;
  adapter: string;
  model: string | null;
  accountId?: string | null;
  projectId?: string | null;
  repoUrl: string | null;
  branch: string | null;
  pushBranch: string | null;
  error: string | null;
  logs: RemoteJobLogLine[];
  usage: RemoteRunnerUsageTotals | null;
  patch: string;
  pushed: boolean;
  result: RemoteJobResult | null;
}

/**
 * Required runtime environment for a remote project. The remote backend has no
 * software pre-installed, so a clone/sync needs git (and usually node/python)
 * present first. The client renders these in a "remote environment" tab and can
 * trigger a server-side install before any git sync runs.
 */
export const REMOTE_ENVIRONMENT_TOOL_IDS = [
  'git',
  'git-lfs',
  'node',
  'python',
  'ffmpeg',
  'curl',
  'unzip',
] as const;

export type RemoteEnvironmentToolId =
  (typeof REMOTE_ENVIRONMENT_TOOL_IDS)[number];

/** A single tool's detection result on the remote host. */
export interface RemoteEnvironmentTool {
  id: RemoteEnvironmentToolId;
  /** Display name, e.g. "Git", "Node.js", "Python". */
  label: string;
  /** Whether the command is resolvable on the remote host. */
  installed: boolean;
  /** Reported version string when installed (raw `--version` first line). */
  version?: string | null;
  /** Whether the backend knows how to auto-install this tool on its OS. */
  installable: boolean;
  /** The command the backend would run to install (for transparency). */
  installHint?: string | null;
}

export interface RemoteEnvironmentReport {
  /** Detected remote OS platform, e.g. "linux", "darwin", "win32". */
  platform: string;
  /** Detected package manager used for auto-install, e.g. "apt", "brew". */
  packageManager?: string | null;
  tools: RemoteEnvironmentTool[];
  /** True when every required tool is installed. */
  ready: boolean;
  /** True when git specifically is present (the gate for project sync). */
  gitReady: boolean;
  checkedAt: number;
}

export interface RemoteEnvironmentInstallInput {
  /** Tool ids to install. Omit/empty to install every missing required tool. */
  tools?: RemoteEnvironmentToolId[];
}

export interface RemoteEnvironmentInstallStep {
  id: RemoteEnvironmentToolId;
  ok: boolean;
  /** Combined stdout/stderr tail from the install command (redacted). */
  log?: string;
  error?: string | null;
}

export interface RemoteEnvironmentInstallResult {
  ok: boolean;
  platform: string;
  packageManager?: string | null;
  steps: RemoteEnvironmentInstallStep[];
  /** The environment report captured after the install attempt. */
  report: RemoteEnvironmentReport;
}

export interface RemoteRunnerEnvironmentResponse {
  ok: true;
  environment: RemoteEnvironmentReport;
}

export interface RemoteRunnerEnvironmentInstallResponse {
  ok: true;
  install: RemoteEnvironmentInstallResult;
}

export interface WorkspaceTreeEntry {  name: string;
  path: string;
  relativePath: string;
  kind: 'directory' | 'file';
  hidden: boolean;
  sizeBytes?: number | null;
  modifiedAtMs?: number | null;
}

export interface WorkspaceDirectoryListing {
  rootPath: string;
  relativePath: string;
  entries: WorkspaceTreeEntry[];
  truncated: boolean;
  totalEntries: number;
}

export type RemoteRunnerFileUploadNamespace =
  | 'uploads'
  | 'clipboard-images'
  | 'session-captures';

export interface RemoteRunnerFileUploadInput {
  bytesBase64: string;
  fileName?: string | null;
  mime?: string | null;
  namespace?: RemoteRunnerFileUploadNamespace;
}

export interface RemoteRunnerFileUpload {
  path: string;
  relativePath: string;
  fileName: string;
  mime?: string | null;
  sizeBytes: number;
}

export interface RemoteRunnerFilePreview {
  path: string;
  fileName: string;
  kind: 'text' | 'image' | 'binary' | 'document';
  mime?: string | null;
  sizeBytes: number;
  truncated: boolean;
  text?: string | null;
  base64?: string | null;
}

export interface CreateRemoteJobInput {
  prompt: string;
  projectId?: string;
  repoUrl?: string;
  branch?: string;
  adapter?: RemoteAdapter;
  model?: string;
  pushBranch?: string;
  accountId?: string;
  apiKey?: string;
  baseUrl?: string;
  gitToken?: string;
}

export interface RemoteRunnerErrorResponse {
  ok: false;
  error: string;
}

export interface RemoteRunnerJobResponse {
  ok: true;
  job: RemoteJob;
}

export interface RemoteRunnerJobsResponse {
  ok: true;
  jobs: RemoteJob[];
}

export interface RemoteRunnerProjectResponse {
  ok: true;
  project: RemoteRunnerProject;
}

export interface RemoteRunnerProjectsResponse {
  ok: true;
  projects: RemoteRunnerProject[];
}

export interface RemoteRunnerAccountResponse {
  ok: true;
  account: RemoteRunnerAccount;
}

export interface RemoteRunnerAccountsResponse {
  ok: true;
  accounts: RemoteRunnerAccount[];
}

export interface RemoteRunnerArtifactsResponse {
  ok: true;
  artifacts: RemoteJobArtifacts;
}

export interface RemoteRunnerDirectoryListingResponse {
  ok: true;
  listing: WorkspaceDirectoryListing;
}

export interface RemoteRunnerFileUploadResponse {
  ok: true;
  file: RemoteRunnerFileUpload;
}

export interface RemoteRunnerFilePreviewResponse {
  ok: true;
  file: RemoteRunnerFilePreview;
}

export interface RemoteRunnerUserSettingResponse {
  ok: true;
  text: string | null;
}

export interface RemoteRunnerOkResponse {
  ok: true;
}

export function normalizeRemoteServerUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

export function remoteRunnerApiUrl(serverUrl: string, path: string): string {
  return `${normalizeRemoteServerUrl(serverUrl)}${path}`;
}

function remoteRunnerResponseError(data: unknown, status: number): string {
  if (typeof data === 'object' && data !== null && 'error' in data) {
    const error = (data as { error?: unknown }).error;
    if (typeof error === 'string' && error) return error;
  }
  return `runner returned ${status}`;
}

/**
 * Error mapper for the remote-environment endpoints. These routes were added
 * after the first cloud-runner release, so an out-of-date backend returns the
 * generic 404 fallback ("not found") for them while the rest of the API (project
 * binding, file listing) keeps working. A bare "not found" reads like the button
 * is broken, so translate that case into an actionable hint: the backend host
 * needs to be redeployed with the newer build that exposes /environment.
 */
function remoteEnvironmentEndpointError(data: unknown, status: number): string {
  if (status === 404) {
    return '云端后端不支持「远程环境」接口（/environment 返回 404）。该功能需要较新版本的后端，请在云端主机上更新并重启 runner 后再试。';
  }
  return remoteRunnerResponseError(data, status);
}

export class RunnerClient {
  readonly serverUrl: string;
  private readonly token: string;

  constructor(serverUrl: string, token: string) {
    this.serverUrl = normalizeRemoteServerUrl(serverUrl);
    this.token = token;
  }

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    if (json) h['content-type'] = 'application/json';
    return h;
  }

  private url(path: string): string {
    return remoteRunnerApiUrl(this.serverUrl, path);
  }

  async health(signal?: AbortSignal): Promise<RunnerHealth> {
    try {
      const res = await fetch(this.url(REMOTE_RUNNER_API_PATHS.health), {
        headers: this.headers(),
        signal,
      });
      if (!res.ok) return { ok: false };
      return (await res.json()) as RunnerHealth;
    } catch {
      return { ok: false };
    }
  }

  async createJob(input: CreateRemoteJobInput): Promise<RemoteJob> {
    const res = await fetch(this.url(REMOTE_RUNNER_API_PATHS.jobs), {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify(input),
    });
    const data = (await res.json()) as RemoteRunnerJobResponse | RemoteRunnerErrorResponse;
    if (!res.ok || !data.ok || !('job' in data)) {
      throw new Error(remoteRunnerResponseError(data, res.status));
    }
    return data.job;
  }

  async jobs(): Promise<RemoteJob[]> {
    const res = await fetch(this.url(REMOTE_RUNNER_API_PATHS.jobs), {
      headers: this.headers(),
    });
    const data = (await res.json()) as RemoteRunnerJobsResponse | RemoteRunnerErrorResponse;
    if (!res.ok || !data.ok || !('jobs' in data) || !Array.isArray(data.jobs)) {
      throw new Error(remoteRunnerResponseError(data, res.status));
    }
    return data.jobs;
  }

  async projects(): Promise<RemoteRunnerProject[]> {
    const res = await fetch(this.url(REMOTE_RUNNER_API_PATHS.projects), {
      headers: this.headers(),
    });
    const data = (await res.json()) as
      | RemoteRunnerProjectsResponse
      | RemoteRunnerErrorResponse;
    if (
      !res.ok ||
      !data.ok ||
      !('projects' in data) ||
      !Array.isArray(data.projects)
    ) {
      throw new Error(remoteRunnerResponseError(data, res.status));
    }
    return data.projects;
  }

  async getProject(id: string): Promise<RemoteRunnerProject> {
    const res = await fetch(this.url(REMOTE_RUNNER_API_PATHS.project(id)), {
      headers: this.headers(),
    });
    const data = (await res.json()) as
      | RemoteRunnerProjectResponse
      | RemoteRunnerErrorResponse;
    if (!res.ok || !data.ok || !('project' in data)) {
      throw new Error(remoteRunnerResponseError(data, res.status));
    }
    return data.project;
  }

  async saveProject(input: RemoteRunnerProjectInput): Promise<RemoteRunnerProject> {
    const hasId = Boolean(input.id?.trim());
    const res = await fetch(
      hasId
        ? this.url(REMOTE_RUNNER_API_PATHS.project(input.id!.trim()))
        : this.url(REMOTE_RUNNER_API_PATHS.projects),
      {
        method: hasId ? 'PUT' : 'POST',
        headers: this.headers(true),
        body: JSON.stringify(input),
      },
    );
    const data = (await res.json()) as
      | RemoteRunnerProjectResponse
      | RemoteRunnerErrorResponse;
    if (!res.ok || !data.ok || !('project' in data)) {
      throw new Error(remoteRunnerResponseError(data, res.status));
    }
    return data.project;
  }

  async deleteProject(id: string): Promise<boolean> {
    const res = await fetch(this.url(REMOTE_RUNNER_API_PATHS.project(id)), {
      method: 'DELETE',
      headers: this.headers(),
    });
    return res.ok;
  }

  async usage(): Promise<RemoteRunnerUsage> {
    const res = await fetch(this.url(REMOTE_RUNNER_API_PATHS.usage), {
      headers: this.headers(),
    });
    const data = (await res.json()) as RemoteRunnerUsage | { ok: boolean; error?: string };
    if (!res.ok || !data.ok || !('totals' in data)) {
      throw new Error('error' in data ? data.error : `runner returned ${res.status}`);
    }
    return data;
  }

  async usageLedger(): Promise<RemoteRunnerLedger> {
    const res = await fetch(this.url(REMOTE_RUNNER_API_PATHS.usageLedger), {
      headers: this.headers(),
    });
    const data = (await res.json()) as RemoteRunnerLedger | { ok: boolean; error?: string };
    if (!res.ok || !data.ok || !('entries' in data)) {
      throw new Error('error' in data ? data.error : `runner returned ${res.status}`);
    }
    return data;
  }

  async accounts(projectId?: string | null): Promise<RemoteRunnerAccount[]> {
    const query = projectId?.trim()
      ? `?projectId=${encodeURIComponent(projectId.trim())}`
      : '';
    const res = await fetch(this.url(`${REMOTE_RUNNER_API_PATHS.accounts}${query}`), {
      headers: this.headers(),
    });
    const data = (await res.json()) as
      | { ok: boolean; accounts?: RemoteRunnerAccount[]; error?: string }
      | RemoteRunnerAccount[];
    if (Array.isArray(data)) return data;
    if (!res.ok || !data.ok || !Array.isArray(data.accounts)) {
      throw new Error('error' in data ? data.error : `runner returned ${res.status}`);
    }
    return data.accounts;
  }

  async readUserSetting(relPath: string): Promise<string | null> {
    const params = new URLSearchParams();
    params.set('path', relPath);
    const res = await fetch(
      this.url(`${REMOTE_RUNNER_API_PATHS.userSettings}?${params}`),
      { headers: this.headers() },
    );
    const data = (await res.json()) as
      | RemoteRunnerUserSettingResponse
      | RemoteRunnerErrorResponse;
    if (!res.ok || !data.ok || !('text' in data)) {
      throw new Error(remoteRunnerResponseError(data, res.status));
    }
    return typeof data.text === 'string' ? data.text : null;
  }

  async writeUserSetting(relPath: string, json: string): Promise<void> {
    const res = await fetch(this.url(REMOTE_RUNNER_API_PATHS.userSettings), {
      method: 'PUT',
      headers: this.headers(true),
      body: JSON.stringify({ path: relPath, json }),
    });
    const data = (await res.json()) as
      | RemoteRunnerOkResponse
      | RemoteRunnerErrorResponse;
    if (!res.ok || !data.ok) {
      throw new Error(remoteRunnerResponseError(data, res.status));
    }
  }

  async deleteUserSetting(relPath: string): Promise<boolean> {
    const params = new URLSearchParams();
    params.set('path', relPath);
    const res = await fetch(
      this.url(`${REMOTE_RUNNER_API_PATHS.userSettings}?${params}`),
      { method: 'DELETE', headers: this.headers() },
    );
    return res.ok;
  }

  async saveAccount(input: RemoteRunnerAccountInput): Promise<RemoteRunnerAccount> {
    const res = await fetch(this.url(REMOTE_RUNNER_API_PATHS.accounts), {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify(input),
    });
    const data = (await res.json()) as
      | RemoteRunnerAccountResponse
      | RemoteRunnerErrorResponse;
    if (!res.ok || !data.ok || !('account' in data)) {
      throw new Error(remoteRunnerResponseError(data, res.status));
    }
    return data.account;
  }

  async updateAccount(
    id: string,
    input: RemoteRunnerAccountInput,
  ): Promise<RemoteRunnerAccount> {
    const res = await fetch(this.url(REMOTE_RUNNER_API_PATHS.account(id)), {
      method: 'PUT',
      headers: this.headers(true),
      body: JSON.stringify({ ...input, id }),
    });
    const data = (await res.json()) as
      | RemoteRunnerAccountResponse
      | RemoteRunnerErrorResponse;
    if (!res.ok || !data.ok || !('account' in data)) {
      throw new Error(remoteRunnerResponseError(data, res.status));
    }
    return data.account;
  }

  async deleteAccount(id: string): Promise<boolean> {
    const res = await fetch(this.url(REMOTE_RUNNER_API_PATHS.account(id)), {
      method: 'DELETE',
      headers: this.headers(),
    });
    return res.ok;
  }

  async getJob(id: string): Promise<RemoteJob> {
    const res = await fetch(this.url(REMOTE_RUNNER_API_PATHS.job(id)), {
      headers: this.headers(),
    });
    const data = (await res.json()) as RemoteRunnerJobResponse | RemoteRunnerErrorResponse;
    if (!res.ok || !data.ok || !('job' in data)) {
      throw new Error(remoteRunnerResponseError(data, res.status));
    }
    return data.job;
  }

  async getJobArtifacts(id: string): Promise<RemoteJobArtifacts> {
    const res = await fetch(
      this.url(REMOTE_RUNNER_API_PATHS.jobArtifacts(id)),
      { headers: this.headers() },
    );
    const data = (await res.json()) as
      | RemoteRunnerArtifactsResponse
      | RemoteRunnerErrorResponse;
    if (!res.ok || !data.ok || !('artifacts' in data)) {
      throw new Error(remoteRunnerResponseError(data, res.status));
    }
    return data.artifacts;
  }

  async listProjectDirectory(
    projectId: string,
    relativePath = '',
    opts: { sync?: boolean } = {},
  ): Promise<WorkspaceDirectoryListing> {
    const params = new URLSearchParams();
    if (relativePath) params.set('path', relativePath);
    // `sync=1` asks the server to git-pull the latest commits before listing,
    // so a client "refresh" reflects the repo's newest state instead of the
    // snapshot captured at first clone.
    if (opts.sync) params.set('sync', '1');
    const suffix = params.toString() ? `?${params}` : '';
    const res = await fetch(
      this.url(`${REMOTE_RUNNER_API_PATHS.projectFiles(projectId)}${suffix}`),
      { headers: this.headers() },
    );
    const data = (await res.json()) as
      | RemoteRunnerDirectoryListingResponse
      | RemoteRunnerErrorResponse;
    if (!res.ok || !data.ok || !('listing' in data)) {
      throw new Error(remoteRunnerResponseError(data, res.status));
    }
    return data.listing;
  }

  /**
   * Probe the remote host for the runtime environment a project needs (git,
   * node, python). The remote backend ships no software preinstalled, so this
   * is how the client knows whether a sync can even run.
   */
  async getProjectEnvironment(
    projectId: string,
  ): Promise<RemoteEnvironmentReport> {
    const res = await fetch(
      this.url(REMOTE_RUNNER_API_PATHS.projectEnvironment(projectId)),
      { headers: this.headers() },
    );
    const data = (await res.json()) as
      | RemoteRunnerEnvironmentResponse
      | RemoteRunnerErrorResponse;
    if (!res.ok || !data.ok || !('environment' in data)) {
      throw new Error(remoteEnvironmentEndpointError(data, res.status));
    }
    return data.environment;
  }

  /**
   * Trigger a server-side install of the missing required tools, then return the
   * post-install environment report. The click happens locally; the install runs
   * remotely on the backend host.
   */
  async installProjectEnvironment(
    projectId: string,
    input: RemoteEnvironmentInstallInput = {},
  ): Promise<RemoteEnvironmentInstallResult> {
    const res = await fetch(
      this.url(REMOTE_RUNNER_API_PATHS.projectEnvironmentInstall(projectId)),
      {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify(input),
      },
    );
    const data = (await res.json()) as
      | RemoteRunnerEnvironmentInstallResponse
      | RemoteRunnerErrorResponse;
    if (!res.ok || !data.ok || !('install' in data)) {
      throw new Error(remoteEnvironmentEndpointError(data, res.status));
    }
    return data.install;
  }

  async uploadProjectFile(
    projectId: string,
    input: RemoteRunnerFileUploadInput,
  ): Promise<RemoteRunnerFileUpload> {    const res = await fetch(
      this.url(REMOTE_RUNNER_API_PATHS.projectFiles(projectId)),
      {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify(input),
      },
    );
    const data = (await res.json()) as
      | RemoteRunnerFileUploadResponse
      | RemoteRunnerErrorResponse;
    if (!res.ok || !data.ok || !('file' in data)) {
      throw new Error(remoteRunnerResponseError(data, res.status));
    }
    return data.file;
  }

  async previewProjectFile(
    projectId: string,
    relativePath: string,
  ): Promise<RemoteRunnerFilePreview> {
    const params = new URLSearchParams();
    params.set('path', relativePath);
    params.set('preview', '1');
    const res = await fetch(
      this.url(`${REMOTE_RUNNER_API_PATHS.projectFiles(projectId)}?${params}`),
      { headers: this.headers() },
    );
    const data = (await res.json()) as
      | RemoteRunnerFilePreviewResponse
      | RemoteRunnerErrorResponse;
    if (!res.ok || !data.ok || !('file' in data)) {
      throw new Error(remoteRunnerResponseError(data, res.status));
    }
    return data.file;
  }

  async cancelJob(id: string): Promise<boolean> {
    const res = await fetch(
      this.url(REMOTE_RUNNER_API_PATHS.jobCancel(id)),
      { method: 'POST', headers: this.headers() },
    );
    return res.ok;
  }

  streamJob(
    id: string,
    handlers: {
      onLog?: (line: RemoteJobLogLine) => void;
      onMessage?: (message: RemoteJobMessage) => void;
      onStatus?: (status: RemoteJobStatus) => void;
      onResult?: (job: RemoteJob) => void;
      onError?: (err: Error) => void;
    },
  ): () => void {
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

function dispatchRemoteRunnerSse(
  chunk: string,
  handlers: {
    onLog?: (line: RemoteJobLogLine) => void;
    onMessage?: (message: RemoteJobMessage) => void;
    onStatus?: (status: RemoteJobStatus) => void;
    onResult?: (job: RemoteJob) => void;
  },
): void {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of chunk.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return;
  let payload: unknown;
  try {
    payload = JSON.parse(dataLines.join('\n'));
  } catch {
    return;
  }
  if (event === REMOTE_RUNNER_SSE_EVENTS.log) handlers.onLog?.(payload as RemoteJobLogLine);
  else if (event === REMOTE_RUNNER_SSE_EVENTS.message) handlers.onMessage?.(payload as RemoteJobMessage);
  else if (event === REMOTE_RUNNER_SSE_EVENTS.status) handlers.onStatus?.(payload as RemoteJobStatus);
  else if (event === REMOTE_RUNNER_SSE_EVENTS.result) handlers.onResult?.(payload as RemoteJob);
}

export function isRemoteJobStatus(value: unknown): value is RemoteJobStatus {
  return REMOTE_JOB_STATUSES.includes(value as RemoteJobStatus);
}

export function isRemoteJobTerminalStatus(value: unknown): value is RemoteJobStatus {
  return (REMOTE_JOB_TERMINAL_STATUSES as readonly string[]).includes(String(value));
}

export function isRemoteJobCancelableStatus(value: unknown): value is RemoteJobStatus {
  return (REMOTE_JOB_CANCELABLE_STATUSES as readonly string[]).includes(String(value));
}
