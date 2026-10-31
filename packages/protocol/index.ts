import type { SkillOrigin, SkillLearningMode, SkillEvidence, SkillProposal, SkillCatalog, SkillReadResult, SkillMutationResult, SkillLearningConfig, SkillEntry } from '../../app/src/runtime/skills/types';
export type { SkillOrigin, SkillLearningMode, SkillEvidence, SkillProposal, SkillCatalog, SkillReadResult, SkillMutationResult, SkillLearningConfig, SkillEntry } from '../../app/src/runtime/skills/types';

/** Same camelCase request as the local Rust skills_request host. No root/cwd authority. */
export interface RemoteSkillServiceRequest {
  action: 'list' | 'view' | 'manage' | 'approve' | 'reject' | 'rollback' | 'history' | 'set_policy' | 'usage' | 'archive' | 'restore' | 'import';
  origin: SkillOrigin;
  mode: SkillLearningMode;
  evidence?: SkillEvidence[];
  proposal?: SkillProposal;
  skillId?: string;
  filePath?: string;
  batchId?: string;
  rollbackId?: string;
  kind?: 'viewed' | 'delivered' | 'used-with-evidence';
  evidenceIds?: string[];
  policy?: { autoEditable?: boolean; contentLocked?: boolean; pinned?: boolean };
  sourceSkillId?: string;
}
export interface RemoteSkillRequestOptions {
  signal?: AbortSignal;
  /** Only the authenticated owner UI supplies this; never infer from a model proposal. */
  ownerControl?: boolean;
  /** Explicit user correction captured by trusted UI, not model provenance. */
  userInputEvidence?: boolean;
}
export type RemoteSkillServiceResult = SkillCatalog | SkillReadResult | SkillMutationResult | SkillEntry | { results: SkillMutationResult[] };
export interface RemoteRunnerSkillServiceResponse { ok: true; result: RemoteSkillServiceResult }

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

export const REMOTE_SKILL_HOST_ID = 'ugs-remote-runner';
export const REMOTE_RUNNER_SERVICE = 'ugs-remote-runner';

export const REMOTE_RUNNER_API_PATHS = {
  health: '/health',
  jobs: '/jobs',
  projects: '/projects',
  usage: '/usage',
  usageLedger: '/usage/ledger',
  accounts: '/accounts',
  userSettings: '/user-settings',
  authRegister: '/auth/register',
  authVerifyEmail: '/auth/verify-email',
  authResendCode: '/auth/resend-code',
  authLogin: '/auth/login',
  authRefresh: '/auth/refresh',
  authLogout: '/auth/logout',
  authMe: '/auth/me',
  authForgotPassword: '/auth/forgot-password',
  authResetPassword: '/auth/reset-password',
  job: (id: string) => `/jobs/${encodeURIComponent(id)}`,
  jobArtifacts: (id: string) => `/jobs/${encodeURIComponent(id)}/artifacts`,
  jobCancel: (id: string) => `/jobs/${encodeURIComponent(id)}/cancel`,
  jobStream: (id: string) => `/jobs/${encodeURIComponent(id)}/stream`,
  project: (id: string) => `/projects/${encodeURIComponent(id)}`,
  projectFiles: (id: string) => `/projects/${encodeURIComponent(id)}/files`,
  projectSkills: (id: string) => `/projects/${encodeURIComponent(id)}/skills`,
  projectSkillService: (id: string) => `/projects/${encodeURIComponent(id)}/skill-service`,
  projectSkillConfig: (id: string) => `/projects/${encodeURIComponent(id)}/skill-service/config`,
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

export function matchRemoteRunnerProjectSkillsPath(path: string): string | null {
  return matchRemoteRunnerNestedIdPath(path, REMOTE_RUNNER_API_PATHS.projects, 'skills');
}

export function matchRemoteRunnerProjectSkillConfigPath(path: string): string | null {
  return matchRemoteRunnerNestedIdPath(path, REMOTE_RUNNER_API_PATHS.projects, 'skill-service/config');
}

export function matchRemoteRunnerProjectSkillServicePath(path: string): string | null {
  return matchRemoteRunnerNestedIdPath(path, REMOTE_RUNNER_API_PATHS.projects, 'skill-service');
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

/**
 * How a remote job's agent process is isolated when it runs.
 *   "process"   — bare child process (cwd + tenant-scoped env). Self-host.
 *   "container" — per-job container with mounts/egress limits (multi-tenant).
 */
export type RemoteIsolationLevel = 'process' | 'container';

export const REMOTE_ISOLATION_LEVELS: readonly RemoteIsolationLevel[] = [
  'process',
  'container',
];

export interface RunnerHealth {
  ok: boolean;
  service?: string;
  version?: string;
  authRequired?: boolean;
  authMode?: 'token' | 'multiuser';
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
  /** Default isolation level for jobs created in this project. */
  isolationLevel?: RemoteIsolationLevel;
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
  isolationLevel?: RemoteIsolationLevel;
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
  /** Additive native evidence fields; old runners/clients may omit all of them. */
  runId?: string;
  toolCallId?: string;
  toolId?: string;
  nativeToolId?: string;
  parentId?: string;
  result?: string;
  exitCode?: number | null;
  toolExitCode?: number | null;
  phase?: 'start' | 'end';
  provenance?: 'native-tool' | 'host-check' | 'user-input' | 'model-output' | 'ui-synthetic' | 'fixture';
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
  /** Generated and persisted by the host from skillSource; runId is this job.id. */
  skillOrigin?: SkillOrigin;
  repoUrl: string | null;
  branch: string | null;
  adapter: string;
  model: string | null;
  /** How the agent process is isolated when it runs. */
  isolationLevel?: RemoteIsolationLevel;
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
  // AI agent CLIs (installed globally via npm; Node.js must be present first).
  // These let remote jobs run the claude/codex/gemini console binaries.
  'claude',
  'codex',
  'gemini',
] as const;

export type RemoteEnvironmentToolId =
  (typeof REMOTE_ENVIRONMENT_TOOL_IDS)[number];

/**
 * Tool ids that are AI agent CLIs. They install globally through npm rather than
 * the host OS package manager, and they are optional (not required for project
 * sync), so the client groups and gates them separately from git/node/python.
 */
export const REMOTE_ENVIRONMENT_AGENT_TOOL_IDS = [
  'claude',
  'codex',
  'gemini',
] as const;

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
  /**
   * True for tools required before a project sync can run (git/node/python…).
   * AI agent CLIs are optional, so this is false for them.
   */
  required?: boolean;
  /** Install channel: OS package manager, or npm global for agent CLIs. */
  channel?: 'package-manager' | 'npm' | null;
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
  /**
   * The tool id, or a synthetic step id like "_refresh" for the package-index
   * refresh that runs before installs (apt-get update etc.).
   */
  id: RemoteEnvironmentToolId | string;
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

/** Localized text bag for a remote skill/command catalog entry. */
export interface RemoteSkillText {
  'zh-CN'?: string;
  'en-US'?: string;
  [locale: string]: string | undefined;
}

/**
 * A slash command / skill discovered in a remote project's checked-out
 * workspace. Shaped to match the client's SlashCatalogEntry so the remote
 * catalog folds straight into the `/` suggestion menu.
 */
export interface RemoteSkillCatalogEntry {
  id: string;
  kind: 'command' | 'skill';
  name: string;
  label: RemoteSkillText;
  detail: RemoteSkillText;
  insertText: RemoteSkillText;
  source?: string | null;
  skillId?: string;
  revision?: string;
  hash?: string;
  sourceAdapter?: string | null;
}

export interface RemoteSkillCatalogSnapshot {
  revision?: string;
  scannedAtMs: number;
  ready: boolean;
  entries: RemoteSkillCatalogEntry[];
  error?: string | null;
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
  /** Captured UI source only. Host/workspace/run are generated by the remote server. */
  skillSource?: { sessionId: string; turnId: string };
  repoUrl?: string;
  branch?: string;
  adapter?: RemoteAdapter;
  model?: string;
  isolationLevel?: RemoteIsolationLevel;
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

export interface RemoteRunnerSkillCatalogResponse {
  ok: true;
  skills: RemoteSkillCatalogSnapshot;
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

export interface RemoteRunnerAuthUser {
  id: string;
  email: string;
  displayName?: string;
  emailVerified: boolean;
  status: string;
  createdAt: number;
  updatedAt?: number;
}

export interface RemoteRunnerAuthSession {
  accessToken: string;
  refreshToken: string;
  user: RemoteRunnerAuthUser;
}

export interface RemoteRunnerAuthSessionResponse {
  ok: true;
  session: RemoteRunnerAuthSession;
}

export interface RemoteRunnerAuthMeResponse {
  ok: true;
  user: RemoteRunnerAuthUser;
}

export interface RemoteRunnerAuthRegisterInput {
  email: string;
  password: string;
  displayName?: string;
}

export interface RemoteRunnerAuthVerifyEmailInput {
  email: string;
  code: string;
}

export interface RemoteRunnerAuthResendCodeInput {
  email: string;
}

export interface RemoteRunnerAuthLoginInput {
  email: string;
  password: string;
  device?: string;
}

export interface RemoteRunnerAuthRefreshInput {
  refreshToken: string;
}

export interface RemoteRunnerAuthLogoutInput {
  refreshToken: string;
}

export interface RemoteRunnerAuthForgotPasswordInput {
  email: string;
}

export interface RemoteRunnerAuthResetPasswordInput {
  email: string;
  code: string;
  password: string;
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

  async register(
    input: RemoteRunnerAuthRegisterInput,
  ): Promise<RemoteRunnerOkResponse> {
    const res = await fetch(this.url(REMOTE_RUNNER_API_PATHS.authRegister), {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify(input),
    });
    const data = (await res.json()) as RemoteRunnerOkResponse | RemoteRunnerErrorResponse;
    if (!res.ok || !data.ok) {
      throw new Error(remoteRunnerResponseError(data, res.status));
    }
    return data;
  }

  async verifyEmail(
    input: RemoteRunnerAuthVerifyEmailInput,
  ): Promise<RemoteRunnerAuthSession> {
    const res = await fetch(this.url(REMOTE_RUNNER_API_PATHS.authVerifyEmail), {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify(input),
    });
    const data = (await res.json()) as
      | RemoteRunnerAuthSessionResponse
      | RemoteRunnerErrorResponse;
    if (!res.ok || !data.ok || !('session' in data)) {
      throw new Error(remoteRunnerResponseError(data, res.status));
    }
    return data.session;
  }

  async resendCode(
    input: RemoteRunnerAuthResendCodeInput,
  ): Promise<RemoteRunnerOkResponse> {
    const res = await fetch(this.url(REMOTE_RUNNER_API_PATHS.authResendCode), {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify(input),
    });
    const data = (await res.json()) as RemoteRunnerOkResponse | RemoteRunnerErrorResponse;
    if (!res.ok || !data.ok) {
      throw new Error(remoteRunnerResponseError(data, res.status));
    }
    return data;
  }

  async login(
    input: RemoteRunnerAuthLoginInput,
  ): Promise<RemoteRunnerAuthSession> {
    const res = await fetch(this.url(REMOTE_RUNNER_API_PATHS.authLogin), {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify(input),
    });
    const data = (await res.json()) as
      | RemoteRunnerAuthSessionResponse
      | RemoteRunnerErrorResponse;
    if (!res.ok || !data.ok || !('session' in data)) {
      throw new Error(remoteRunnerResponseError(data, res.status));
    }
    return data.session;
  }

  async refresh(
    input: RemoteRunnerAuthRefreshInput,
  ): Promise<RemoteRunnerAuthSession> {
    const res = await fetch(this.url(REMOTE_RUNNER_API_PATHS.authRefresh), {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify(input),
    });
    const data = (await res.json()) as
      | RemoteRunnerAuthSessionResponse
      | RemoteRunnerErrorResponse;
    if (!res.ok || !data.ok || !('session' in data)) {
      throw new Error(remoteRunnerResponseError(data, res.status));
    }
    return data.session;
  }

  async logout(
    input: RemoteRunnerAuthLogoutInput,
  ): Promise<RemoteRunnerOkResponse> {
    const res = await fetch(this.url(REMOTE_RUNNER_API_PATHS.authLogout), {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify(input),
    });
    const data = (await res.json()) as RemoteRunnerOkResponse | RemoteRunnerErrorResponse;
    if (!res.ok || !data.ok) {
      throw new Error(remoteRunnerResponseError(data, res.status));
    }
    return data;
  }

  async me(): Promise<RemoteRunnerAuthUser> {
    const res = await fetch(this.url(REMOTE_RUNNER_API_PATHS.authMe), {
      headers: this.headers(),
    });
    const data = (await res.json()) as
      | RemoteRunnerAuthMeResponse
      | RemoteRunnerErrorResponse;
    if (!res.ok || !data.ok || !('user' in data)) {
      throw new Error(remoteRunnerResponseError(data, res.status));
    }
    return data.user;
  }

  async forgotPassword(
    input: RemoteRunnerAuthForgotPasswordInput,
  ): Promise<RemoteRunnerOkResponse> {
    const res = await fetch(this.url(REMOTE_RUNNER_API_PATHS.authForgotPassword), {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify(input),
    });
    const data = (await res.json()) as RemoteRunnerOkResponse | RemoteRunnerErrorResponse;
    if (!res.ok || !data.ok) {
      throw new Error(remoteRunnerResponseError(data, res.status));
    }
    return data;
  }

  async resetPassword(
    input: RemoteRunnerAuthResetPasswordInput,
  ): Promise<RemoteRunnerAuthSession> {
    const res = await fetch(this.url(REMOTE_RUNNER_API_PATHS.authResetPassword), {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify(input),
    });
    const data = (await res.json()) as
      | RemoteRunnerAuthSessionResponse
      | RemoteRunnerErrorResponse;
    if (!res.ok || !data.ok || !('session' in data)) {
      throw new Error(remoteRunnerResponseError(data, res.status));
    }
    return data.session;
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

  async getJob(id: string, options?: { signal?: AbortSignal }): Promise<RemoteJob> {
    const res = await fetch(this.url(REMOTE_RUNNER_API_PATHS.job(id)), {
      headers: this.headers(),
      signal: options?.signal,
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
   * Same camelCase body as Rust skills_request; success is { ok: true, result }.
   * Use REMOTE_SKILL_HOST_ID and the authenticated remote project.id as origin
   * workspaceId. Never forward the local workspaceId, cwd, root, or actor.
   * UI authority lives in opts and is not available to the review model.
   */
  async skillRequest<T extends RemoteSkillServiceResult = RemoteSkillServiceResult>(
    projectId: string, request: RemoteSkillServiceRequest, opts: RemoteSkillRequestOptions = {},
  ): Promise<T> {
    const headers: Record<string, string> = this.headers(true);
    if (opts.ownerControl === true) headers['x-ugs-skill-control'] = 'owner';
    if (opts.userInputEvidence === true) headers['x-ugs-skill-user-input'] = 'correction';
    const res = await fetch(this.url(REMOTE_RUNNER_API_PATHS.projectSkillService(projectId)), {
      method: 'POST', headers, body: JSON.stringify(request), signal: opts.signal,
    });
    const data = (await res.json()) as RemoteRunnerSkillServiceResponse | RemoteRunnerErrorResponse;
    if (!res.ok || !data.ok || !('result' in data)) throw new Error(remoteRunnerResponseError(data, res.status));
    return data.result as T;
  }

  async getProjectSkillConfig(projectId: string): Promise<SkillLearningConfig> {
    const res = await fetch(this.url(REMOTE_RUNNER_API_PATHS.projectSkillConfig(projectId)), { headers: this.headers() });
    const data = (await res.json()) as { ok: true; config: SkillLearningConfig } | RemoteRunnerErrorResponse;
    if (!res.ok || !data.ok || !('config' in data)) throw new Error(remoteRunnerResponseError(data, res.status));
    return data.config;
  }

  /** Explicit remote-owner configuration; never call from a model port. */
  async saveProjectSkillConfig(projectId: string, config: Partial<SkillLearningConfig>): Promise<SkillLearningConfig> {
    const headers = { ...this.headers(true), 'x-ugs-skill-control': 'owner' };
    const res = await fetch(this.url(REMOTE_RUNNER_API_PATHS.projectSkillConfig(projectId)), { method: 'PUT', headers, body: JSON.stringify(config) });
    const data = (await res.json()) as { ok: true; config: SkillLearningConfig } | RemoteRunnerErrorResponse;
    if (!res.ok || !data.ok || !('config' in data)) throw new Error(remoteRunnerResponseError(data, res.status));
    return data.config;
  }

  async listProjectSkills(
    projectId: string,
    opts: { sync?: boolean } = {},
  ): Promise<RemoteSkillCatalogSnapshot> {
    const params = new URLSearchParams();
    if (opts.sync) params.set('sync', '1');
    const suffix = params.toString() ? `?${params}` : '';
    const res = await fetch(
      this.url(`${REMOTE_RUNNER_API_PATHS.projectSkills(projectId)}${suffix}`),
      { headers: this.headers() },
    );
    const data = (await res.json()) as
      | RemoteRunnerSkillCatalogResponse
      | RemoteRunnerErrorResponse;
    if (!res.ok || !data.ok || !('skills' in data)) {
      throw new Error(remoteRunnerResponseError(data, res.status));
    }
    return data.skills;
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
      onClose?: () => void;
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
        if (!controller.signal.aborted) handlers.onClose?.();
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
