/**
 * CONTRACT: client-side model + SDK for "remote workspaces" (Route B).
 *
 * A remote workspace points UltraGameStudio at a project owned by a self-hosted
 * Runner backend (see `backend/` at the repo root). The client stores project metadata,
 * while the server owns the real workspace path/container for that project.
 *
 * Persistence split:
 *   - Non-secret config (id, label, server URL, project/repo/branch/model)
 *     lives in localStorage under {@link REMOTE_WORKSPACE_STORAGE_KEY}.
 *   - Secrets (the Runner access token, optional model API key, optional git
 *     token for project sync) live in the OS keychain via secureStorage, keyed
 *     by workspace id.
 *
 * The remote workspace is surfaced in the existing workspace switcher; its
 * synthetic path is `remote://<id>` so the rest of the app can keep treating
 * "workspace" as a string path while still distinguishing remote ones.
 */

import {
  listProviders,
  upsertProviders,
  type Provider,
  type ProviderKind,
} from '@/lib/apiConfig';
import {
  addCachedModels,
  providerModelCacheKey,
} from '@/lib/modelLists';
import {
  REMOTE_RUNNER_CONNECTION_SECRET,
  REMOTE_WORKSPACE_SECRET,
  readSecureRecord,
  setSecureRecordValue,
  writeSecureRecord,
} from '@/lib/secureStorage';
import {
  RunnerClient as ProtocolRunnerClient,
  normalizeRemoteServerUrl,
} from '@ugs/protocol';
import type {
  RemoteAdapter,
  RemoteRunnerFileUpload,
  RemoteRunnerFileUploadInput,
  RemoteRunnerFilePreview,
  RemoteRunnerAccount,
  RemoteRunnerProject,
  WorkspaceDirectoryListing,
  WorkspaceTreeEntry,
} from '@ugs/protocol';

export type {
  CreateRemoteJobInput,
  RemoteAdapter,
  RemoteJob,
  RemoteJobArtifacts,
  RemoteJobLogLine,
  RemoteJobMessage,
  RemoteJobStatus,
  RemoteRunnerAccount,
  RemoteRunnerAccountInput,
  RemoteRunnerFileUpload,
  RemoteRunnerFileUploadInput,
  RemoteRunnerFileUploadNamespace,
  RemoteRunnerFilePreview,
  RemoteRunnerLedger,
  RemoteRunnerProject,
  RemoteRunnerProjectInput,
  RemoteRunnerUsage,
  RemoteRunnerUsageTotals,
  RunnerHealth,
  WorkspaceDirectoryListing,
  WorkspaceTreeEntry,
} from '@ugs/protocol';

export const REMOTE_WORKSPACE_STORAGE_KEY = 'ultragamestudio.remoteWorkspaces.v1';
export const REMOTE_RUNNER_CONNECTION_STORAGE_KEY =
  'ultragamestudio.remoteRunnerConnection.v1';
/**
 * 内置默认云端连接：指向官方测试 Runner（腾讯云固定 IP，HTTP）。
 * 未在本地保存过连接时，「添加云端项目」对话框会预填这两个值，用户仍可覆盖。
 * 注意：这是测试用共享 Token，随客户端分发，仅供联调；生产环境应改用每用户独立 Token + HTTPS。
 */
export const DEFAULT_REMOTE_RUNNER_SERVER_URL = 'http://150.158.47.232:8787';
export const DEFAULT_REMOTE_RUNNER_TOKEN =
  'f5a7eed92786d0a06ef59b3ae0100011ad7ee3db78b441b7';
/** Secret buckets (keychain) holding per-workspace tokens/keys. */
export { REMOTE_RUNNER_CONNECTION_SECRET, REMOTE_WORKSPACE_SECRET } from '@/lib/secureStorage';
/** Synthetic path scheme so remote workspaces flow through path-typed APIs. */
export const REMOTE_WORKSPACE_PREFIX = 'remote://';
export const REMOTE_PROVIDER_PREFIX = 'remote-runner:';
export const REMOTE_WORKSPACE_FILES_UPDATED_EVENT =
  'ultragamestudio:remote-workspace-files-updated';

/** Non-secret, persisted remote-workspace configuration. */
export interface RemoteWorkspaceConfig {
  id: string;
  label: string;
  /** Legacy/fallback Runner URL. New project UI uses the global cloud service connection. */
  serverUrl: string;
  /** Server-side project id. Jobs send this id instead of a server path. */
  projectId?: string;
  /** Repository bound to the server-side project. */
  repoUrl?: string;
  /** Default project branch. */
  branch?: string;
  /** Default agent adapter. */
  adapter: RemoteAdapter;
  /** Optional default model id passed to the adapter CLI. */
  model?: string;
  /** Optional branch to push results to. */
  pushBranch?: string;
  /** Whether to send the client's own model key (vs. using the server's). */
  useOwnModelKey: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Secrets are stored separately and never serialized into localStorage. */
export interface RemoteWorkspaceSecrets {
  /** Legacy per-project Runner token. New flows use the global cloud service token. */
  token: string;
  /** Optional model API key sent per job when useOwnModelKey is true. */
  apiKey?: string;
  /** Optional model base URL. */
  baseUrl?: string;
  /** Optional git token for clone/push of private repos. */
  gitToken?: string;
}

export interface RemoteRunnerConnection {
  serverUrl: string;
  updatedAt: number;
}

export interface RemoteRunnerConnectionSecrets {
  token: string;
}

export interface ResolvedRemoteRunnerConnection {
  serverUrl: string;
  token: string;
  source: 'global' | 'workspace';
}

export interface RemoteWorkspaceFilesUpdatedDetail {
  workspaceId: string;
  workspacePath: string;
  projectId?: string | null;
  jobId?: string;
}

const SECRET_FIELDS = ['token', 'apiKey', 'baseUrl', 'gitToken'] as const;

/** True when a workspace path refers to a remote workspace. */
export function isRemoteWorkspacePath(path: string | null | undefined): boolean {
  return typeof path === 'string' && path.startsWith(REMOTE_WORKSPACE_PREFIX);
}

/** Build the synthetic path for a remote workspace id. */
export function remoteWorkspacePath(id: string): string {
  return `${REMOTE_WORKSPACE_PREFIX}${id}`;
}

/** Extract the workspace id from a synthetic remote path ('' if not remote). */
export function remoteWorkspaceIdFromPath(path: string): string {
  return isRemoteWorkspacePath(path)
    ? path.slice(REMOTE_WORKSPACE_PREFIX.length)
    : '';
}

export function notifyRemoteWorkspaceFilesUpdated(
  detail: RemoteWorkspaceFilesUpdatedDetail,
): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent(REMOTE_WORKSPACE_FILES_UPDATED_EVENT, { detail }),
  );
}

function remoteWorkspaceEntryPath(rootPath: string, relativePath: string): string {
  const root = rootPath.replace(/[\\/]+$/g, '');
  const rel = relativePath.replace(/^\/+|\/+$/g, '');
  return rel ? `${root}/${rel}` : root;
}

function remoteWorkspaceRelativePath(rootPath: string, path: string): string {
  const root = rootPath.replace(/[\\/]+$/g, '').replace(/\\/g, '/');
  const normalized = path.trim().replace(/\\/g, '/');
  if (normalized === root) return '';
  if (root && normalized.startsWith(`${root}/`)) {
    return normalized.slice(root.length + 1).replace(/^\/+|\/+$/g, '');
  }
  return normalized.replace(/^\/+|\/+$/g, '');
}

export interface RemoteProviderRef {
  workspaceId: string;
  accountId: string;
}

function encodeProviderPart(value: string): string {
  return encodeURIComponent(value);
}

function decodeProviderPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return '';
  }
}

export function remoteProviderId(
  workspaceId: string,
  accountId: string,
): string {
  return `${REMOTE_PROVIDER_PREFIX}${encodeProviderPart(workspaceId)}:${encodeProviderPart(accountId)}`;
}

export function parseRemoteProviderId(
  providerId: string | null | undefined,
): RemoteProviderRef | null {
  if (!providerId?.startsWith(REMOTE_PROVIDER_PREFIX)) return null;
  const rest = providerId.slice(REMOTE_PROVIDER_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep === -1) return null;
  const workspaceId = decodeProviderPart(rest.slice(0, sep));
  const accountId = decodeProviderPart(rest.slice(sep + 1));
  if (!workspaceId || !accountId) return null;
  return { workspaceId, accountId };
}

export function isRemoteRunnerProvider(
  provider: Pick<Provider, 'id' | 'apiKey'>,
): boolean {
  return (
    !!parseRemoteProviderId(provider.id) ||
    provider.apiKey.trim() === 'remote-runner'
  );
}

export function remoteRunnerProviderMatchesWorkspace(
  provider: Pick<Provider, 'id'>,
  remoteWorkspaceId: string,
): boolean {
  const remote = parseRemoteProviderId(provider.id);
  return !!remote && remote.workspaceId === remoteWorkspaceId;
}

function hasStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage;
}

function genId(): string {
  try {
    const c = globalThis.crypto;
    if (typeof c?.randomUUID === 'function') {
      return `rw_${c.randomUUID().slice(0, 8)}`;
    }
  } catch {
    /* ignore */
  }
  return `rw_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function normalizeServerUrl(raw: string): string {
  return normalizeRemoteServerUrl(raw);
}

/**
 * 判断 URL 是否指向本机回环地址（127.0.0.1 / localhost / ::1）。
 * 早期本地联调阶段可能把回环地址存进了 localStorage；这类值视为过期，
 * 应回退到内置的官方测试 Runner 默认值，而不是覆盖它。
 */
function isLoopbackServerUrl(raw: string | null | undefined): boolean {
  if (!raw) return true;
  const value = raw.trim().toLowerCase();
  if (!value) return true;
  return (
    /(^|\/\/)(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]|::1)(:|\/|$)/.test(value)
  );
}

/** 读取本地保存的连接 serverUrl 原始值（不含内置默认，不做回环过滤）。 */
function readStoredRunnerServerUrl(): string {
  if (!hasStorage()) return '';
  try {
    const raw = window.localStorage.getItem(REMOTE_RUNNER_CONNECTION_STORAGE_KEY);
    if (!raw) return '';
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return '';
    const v = parsed as Record<string, unknown>;
    return typeof v.serverUrl === 'string' ? v.serverUrl : '';
  } catch {
    return '';
  }
}

/** Read all configured remote workspaces (non-secret data only). */
export function loadRemoteWorkspaces(): RemoteWorkspaceConfig[] {
  if (!hasStorage()) return [];
  try {
    const raw = window.localStorage.getItem(REMOTE_WORKSPACE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidConfig);
  } catch {
    return [];
  }
}

function isValidConfig(value: unknown): value is RemoteWorkspaceConfig {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.serverUrl === 'string' &&
    typeof v.label === 'string'
  );
}

function persistAll(list: RemoteWorkspaceConfig[]): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.setItem(
      REMOTE_WORKSPACE_STORAGE_KEY,
      JSON.stringify(list),
    );
  } catch {
    /* non-fatal */
  }
}

export function getRemoteWorkspace(id: string): RemoteWorkspaceConfig | null {
  return loadRemoteWorkspaces().find((w) => w.id === id) ?? null;
}

/**
 * Create or update a remote workspace. Secrets, when provided, are written to
 * the keychain; non-secret fields go to localStorage.
 */
export function saveRemoteWorkspace(
  input: Partial<RemoteWorkspaceConfig> & {
    label: string;
    serverUrl: string;
    adapter?: RemoteAdapter;
  },
  secrets?: Partial<RemoteWorkspaceSecrets>,
): RemoteWorkspaceConfig {
  const list = loadRemoteWorkspaces();
  const now = Date.now();
  const existing = input.id ? list.find((w) => w.id === input.id) : undefined;

  const config: RemoteWorkspaceConfig = {
    id: existing?.id ?? input.id ?? genId(),
    label: input.label.trim() || 'Remote',
    serverUrl: normalizeServerUrl(input.serverUrl),
    projectId: input.projectId?.trim() || existing?.projectId,
    repoUrl: input.repoUrl?.trim() || undefined,
    branch: input.branch?.trim() || undefined,
    adapter: input.adapter ?? existing?.adapter ?? 'claude',
    model: input.model?.trim() || undefined,
    pushBranch: input.pushBranch?.trim() || undefined,
    useOwnModelKey: input.useOwnModelKey ?? existing?.useOwnModelKey ?? false,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  const next = existing
    ? list.map((w) => (w.id === config.id ? config : w))
    : [...list, config];
  persistAll(next);

  if (secrets) writeRemoteSecrets(config.id, secrets);
  return config;
}

export function deleteRemoteWorkspace(id: string): void {
  persistAll(loadRemoteWorkspaces().filter((w) => w.id !== id));
  clearRemoteSecrets(id);
  removeRemoteWorkspaceProviders(id);
}

// ---------- Secrets (keychain) ----------

function secretKey(id: string, field: (typeof SECRET_FIELDS)[number]): string {
  return `${id}:${field}`;
}

export function readRemoteSecrets(id: string): RemoteWorkspaceSecrets {
  const record = readSecureRecord(REMOTE_WORKSPACE_SECRET);
  return {
    token: record[secretKey(id, 'token')] ?? '',
    apiKey: record[secretKey(id, 'apiKey')] || undefined,
    baseUrl: record[secretKey(id, 'baseUrl')] || undefined,
    gitToken: record[secretKey(id, 'gitToken')] || undefined,
  };
}

export function writeRemoteSecrets(
  id: string,
  secrets: Partial<RemoteWorkspaceSecrets>,
): void {
  for (const field of SECRET_FIELDS) {
    if (field in secrets) {
      setSecureRecordValue(
        REMOTE_WORKSPACE_SECRET,
        secretKey(id, field),
        secrets[field] ?? '',
      );
    }
  }
}

export function readRemoteRunnerConnection(
  opts: { allowDefault?: boolean } = {},
): RemoteRunnerConnection | null {
  const allowDefault = opts.allowDefault !== false;
  const fallback: RemoteRunnerConnection | null = allowDefault
    ? {
        serverUrl: normalizeServerUrl(DEFAULT_REMOTE_RUNNER_SERVER_URL),
        updatedAt: 0,
      }
    : null;
  if (!hasStorage()) return fallback;
  try {
    const raw = window.localStorage.getItem(REMOTE_RUNNER_CONNECTION_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return fallback;
    const v = parsed as Record<string, unknown>;
    if (typeof v.serverUrl !== 'string' || !v.serverUrl.trim()) return fallback;
    // 早期本地联调可能把回环地址存进了 localStorage；视为过期，回退到内置默认。
    if (allowDefault && isLoopbackServerUrl(v.serverUrl)) return fallback;
    return {
      serverUrl: normalizeServerUrl(v.serverUrl),
      updatedAt:
        typeof v.updatedAt === 'number' && Number.isFinite(v.updatedAt)
          ? v.updatedAt
          : 0,
    };
  } catch {
    return fallback;
  }
}

export function readRemoteRunnerConnectionSecrets(
  opts: { allowDefault?: boolean } = {},
): RemoteRunnerConnectionSecrets {
  const allowDefault = opts.allowDefault !== false;
  const record = readSecureRecord(REMOTE_RUNNER_CONNECTION_SECRET);
  // 若保存的连接指向回环地址，则连同其 Token 一起视为过期，回退到内置默认 Token。
  const storedIsStale = allowDefault && isLoopbackServerUrl(readStoredRunnerServerUrl());
  const storedToken = storedIsStale ? '' : record.token;
  const token = storedToken || (allowDefault ? DEFAULT_REMOTE_RUNNER_TOKEN : '');
  return { token };
}

export function saveRemoteRunnerConnection(
  input: { serverUrl: string },
  secrets: RemoteRunnerConnectionSecrets,
): RemoteRunnerConnection {
  const connection: RemoteRunnerConnection = {
    serverUrl: normalizeServerUrl(input.serverUrl),
    updatedAt: Date.now(),
  };
  if (hasStorage()) {
    try {
      window.localStorage.setItem(
        REMOTE_RUNNER_CONNECTION_STORAGE_KEY,
        JSON.stringify(connection),
      );
    } catch {
      /* non-fatal */
    }
  }
  writeSecureRecord(REMOTE_RUNNER_CONNECTION_SECRET, {
    token: secrets.token ?? '',
  });
  return connection;
}

export function resolveRemoteRunnerConnection(
  workspace?: RemoteWorkspaceConfig | null,
): ResolvedRemoteRunnerConnection | null {
  // 仅认用户显式保存的连接（不含内置默认），避免纯本地用户被误导向默认服务器发请求。
  const global = readRemoteRunnerConnection({ allowDefault: false });
  const globalToken = readRemoteRunnerConnectionSecrets({ allowDefault: false }).token;
  if (global?.serverUrl && globalToken) {
    return {
      serverUrl: global.serverUrl,
      token: globalToken,
      source: 'global',
    };
  }
  if (workspace?.serverUrl) {
    const legacyToken = readRemoteSecrets(workspace.id).token;
    if (legacyToken) {
      return {
        serverUrl: workspace.serverUrl,
        token: legacyToken,
        source: 'workspace',
      };
    }
  }
  return null;
}

function clearRemoteSecrets(id: string): void {
  const record = readSecureRecord(REMOTE_WORKSPACE_SECRET);
  let changed = false;
  for (const field of SECRET_FIELDS) {
    const key = secretKey(id, field);
    if (key in record) {
      delete record[key];
      changed = true;
    }
  }
  if (changed) writeSecureRecord(REMOTE_WORKSPACE_SECRET, record);
}

// ---------- Runner client SDK ----------

export class RunnerClient extends ProtocolRunnerClient {
  /** Build a client straight from a saved workspace id. */
  static fromWorkspace(id: string): RunnerClient | null {
    const config = getRemoteWorkspace(id);
    if (!config) return null;
    const connection = resolveRemoteRunnerConnection(config);
    if (!connection) return null;
    return new RunnerClient(connection.serverUrl, connection.token);
  }
}

function normalizedRemoteRepoUrl(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\/+$/g, '');
}

function remoteRunnerErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRemoteProjectNotFoundError(err: unknown): boolean {
  const msg = remoteRunnerErrorMessage(err).trim().toLowerCase();
  return msg === 'not found' || msg === 'project not found';
}

function findRemoteWorkspaceProject(
  projects: RemoteRunnerProject[],
  config: RemoteWorkspaceConfig,
): RemoteRunnerProject | null {
  const projectId = config.projectId?.trim();
  if (projectId) {
    const byId = projects.find((project) => project.id === projectId);
    if (byId) return byId;
  }

  const repoUrl = normalizedRemoteRepoUrl(config.repoUrl);
  if (repoUrl) {
    const byRepo = projects.find(
      (project) => normalizedRemoteRepoUrl(project.repoUrl) === repoUrl,
    );
    if (byRepo) return byRepo;
  }

  const label = config.label.trim();
  if (label) {
    const byLabel = projects.filter((project) => project.label.trim() === label);
    if (byLabel.length === 1) return byLabel[0] ?? null;
  }

  return null;
}

function bindRemoteWorkspaceProject(
  config: RemoteWorkspaceConfig,
  project: RemoteRunnerProject,
): RemoteWorkspaceConfig {
  const next = {
    id: config.id,
    label: config.label || project.label,
    serverUrl: config.serverUrl,
    projectId: project.id,
    repoUrl: project.repoUrl,
    branch: project.branch ?? config.branch,
    pushBranch: project.pushBranch ?? config.pushBranch,
    adapter: (project.adapter as RemoteAdapter | undefined) ?? config.adapter,
    model: project.model ?? config.model,
    useOwnModelKey: config.useOwnModelKey,
  };
  if (
    config.projectId === next.projectId &&
    config.repoUrl === next.repoUrl &&
    config.branch === next.branch &&
    config.pushBranch === next.pushBranch &&
    config.adapter === next.adapter &&
    config.model === next.model
  ) {
    return config;
  }
  return saveRemoteWorkspace(next);
}

export async function ensureRemoteWorkspaceProject(
  config: RemoteWorkspaceConfig,
  client: RunnerClient,
): Promise<RemoteWorkspaceConfig> {
  if (config.projectId) {
    try {
      const project = await client.getProject(config.projectId);
      return bindRemoteWorkspaceProject(config, project);
    } catch (err) {
      if (!isRemoteProjectNotFoundError(err)) throw err;
    }
  }

  const projects = await client.projects().catch(() => []);
  const matched = findRemoteWorkspaceProject(projects, config);
  if (matched) return bindRemoteWorkspaceProject(config, matched);

  if (config.repoUrl?.trim()) {
    const secrets = readRemoteSecrets(config.id);
    const project = await client.saveProject({
      label: config.label,
      repoUrl: config.repoUrl,
      branch: config.branch,
      pushBranch: config.pushBranch,
      adapter: config.adapter,
      model: config.model,
      gitToken: secrets.gitToken,
    });
    return bindRemoteWorkspaceProject(config, project);
  }

  throw new Error('云端项目未绑定后端 projectId。请在云端项目设置中重新保存。');
}

export async function listRemoteWorkspaceDirectory(
  rootPath: string,
  relativePath = '',
): Promise<WorkspaceDirectoryListing> {
  const workspaceId = remoteWorkspaceIdFromPath(rootPath);
  let config = getRemoteWorkspace(workspaceId);
  if (!config) throw new Error('云端项目不存在。');
  const connection = resolveRemoteRunnerConnection(config);
  if (!connection) throw new Error('云端服务未配置。请先配置服务器地址和访问 Token。');
  const client = new RunnerClient(connection.serverUrl, connection.token);
  let listing: WorkspaceDirectoryListing;

  if (config.projectId) {
    try {
      listing = await client.listProjectDirectory(config.projectId, relativePath);
    } catch (err) {
      if (!isRemoteProjectNotFoundError(err)) throw err;
      config = await ensureRemoteWorkspaceProject(config, client);
      if (!config.projectId) {
        throw new Error('云端项目在后端不存在或已被删除。请在云端项目设置中重新保存。');
      }
      listing = await client.listProjectDirectory(config.projectId, relativePath);
    }
  } else {
    config = await ensureRemoteWorkspaceProject(config, client);
    if (!config.projectId) throw new Error('云端项目未绑定后端 projectId。请在云端项目设置中重新保存。');
    listing = await client.listProjectDirectory(config.projectId, relativePath);
  }

  return {
    ...listing,
    rootPath,
    entries: listing.entries.map(
      (entry): WorkspaceTreeEntry => ({
        ...entry,
        path: remoteWorkspaceEntryPath(rootPath, entry.relativePath),
      }),
    ),
  };
}

export async function uploadRemoteWorkspaceFile(
  rootPath: string,
  input: RemoteRunnerFileUploadInput,
): Promise<RemoteRunnerFileUpload> {
  const workspaceId = remoteWorkspaceIdFromPath(rootPath);
  let config = getRemoteWorkspace(workspaceId);
  if (!config) throw new Error('云端项目不存在。');
  const connection = resolveRemoteRunnerConnection(config);
  if (!connection) throw new Error('云端服务未配置。请先配置服务器地址和访问 Token。');
  const client = new RunnerClient(connection.serverUrl, connection.token);

  if (!config.projectId) {
    config = await ensureRemoteWorkspaceProject(config, client);
  }
  if (!config.projectId) throw new Error('云端项目未绑定后端 projectId。请在云端项目设置中重新保存。');

  let uploaded: RemoteRunnerFileUpload;
  try {
    uploaded = await client.uploadProjectFile(config.projectId, input);
  } catch (err) {
    if (!isRemoteProjectNotFoundError(err)) throw err;
    config = await ensureRemoteWorkspaceProject(config, client);
    if (!config.projectId) {
      throw new Error('云端项目在后端不存在或已被删除。请在云端项目设置中重新保存。');
    }
    uploaded = await client.uploadProjectFile(config.projectId, input);
  }
  return {
    ...uploaded,
    path: remoteWorkspaceEntryPath(rootPath, uploaded.relativePath),
  };
}

export async function previewRemoteWorkspaceFile(
  rootPath: string,
  path: string,
): Promise<RemoteRunnerFilePreview> {
  const workspaceId = remoteWorkspaceIdFromPath(rootPath);
  let config = getRemoteWorkspace(workspaceId);
  if (!config) throw new Error('云端项目不存在。');
  const connection = resolveRemoteRunnerConnection(config);
  if (!connection) throw new Error('云端服务未配置。请先配置服务器地址和访问 Token。');
  const client = new RunnerClient(connection.serverUrl, connection.token);

  if (!config.projectId) {
    config = await ensureRemoteWorkspaceProject(config, client);
  }
  if (!config.projectId) throw new Error('云端项目未绑定后端 projectId。请在云端项目设置中重新保存。');

  const relativePath = remoteWorkspaceRelativePath(rootPath, path);
  let file: RemoteRunnerFilePreview;
  try {
    file = await client.previewProjectFile(config.projectId, relativePath);
  } catch (err) {
    if (!isRemoteProjectNotFoundError(err)) throw err;
    config = await ensureRemoteWorkspaceProject(config, client);
    if (!config.projectId) {
      throw new Error('云端项目在后端不存在或已被删除。请在云端项目设置中重新保存。');
    }
    file = await client.previewProjectFile(config.projectId, relativePath);
  }
  return {
    ...file,
    path: remoteWorkspaceEntryPath(rootPath, relativePath),
  };
}

function remoteAdapterToProviderKind(adapter: string): ProviderKind {
  if (adapter === 'codex') return 'codex';
  if (adapter === 'gemini') return 'gemini';
  return 'anthropic';
}

function remoteAccountModels(account: RemoteRunnerAccount): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [account.model, ...(account.models ?? [])]) {
    const model = raw?.trim();
    if (!model) continue;
    const key = model.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(model);
  }
  return out;
}

function remoteWorkspaceProviderPrefix(workspaceId: string): string {
  return `${REMOTE_PROVIDER_PREFIX}${encodeProviderPart(workspaceId)}:`;
}

function remoteAccountProvider(
  workspace: RemoteWorkspaceConfig,
  account: RemoteRunnerAccount,
): Provider {
  const models = remoteAccountModels(account);
  return {
    id: remoteProviderId(workspace.id, account.id),
    kind: remoteAdapterToProviderKind(account.adapter),
    name: `${workspace.label} · ${account.label}`,
    apiKey: 'remote-runner',
    baseUrl: workspace.serverUrl,
    transport: 'cli',
    model: models[0],
    models: models.length > 0 ? models : undefined,
  };
}

function removeRemoteWorkspaceProviders(workspaceId: string): void {
  const prefix = remoteWorkspaceProviderPrefix(workspaceId);
  const removeIds = listProviders()
    .map((provider) => provider.id)
    .filter((id) => id.startsWith(prefix));
  if (removeIds.length > 0) upsertProviders([], { removeIds });
}

export function syncRemoteWorkspaceAccounts(
  workspace: RemoteWorkspaceConfig,
  accounts: RemoteRunnerAccount[],
  opts: { makeActiveAccountId?: string } = {},
): Provider[] {
  const enabled = accounts.filter((account) => {
    if (account.enabled === false) return false;
    const accountProjectId = account.projectId?.trim();
    if (!accountProjectId) return true;
    return !!workspace.projectId && accountProjectId === workspace.projectId;
  });
  const providers = enabled.map((account) => remoteAccountProvider(workspace, account));
  const activeProviderId = opts.makeActiveAccountId
    ? remoteProviderId(workspace.id, opts.makeActiveAccountId)
    : undefined;
  const nextIds = new Set(providers.map((provider) => provider.id));
  const prefix = remoteWorkspaceProviderPrefix(workspace.id);
  const removeIds = listProviders()
    .map((provider) => provider.id)
    .filter((id) => id.startsWith(prefix) && !nextIds.has(id));

  upsertProviders(providers, {
    removeIds,
    makeActiveId: activeProviderId,
  });
  for (const provider of providers) {
    addCachedModels(providerModelCacheKey(provider), provider.models ?? []);
  }
  return providers;
}

export async function refreshRemoteWorkspaceAccounts(
  workspace: RemoteWorkspaceConfig,
  token?: string,
  opts: { makeActiveAccountId?: string } = {},
): Promise<Provider[]> {
  const connection = token
    ? { serverUrl: workspace.serverUrl, token }
    : resolveRemoteRunnerConnection(workspace);
  if (!connection?.token) return [];
  const client = new RunnerClient(connection.serverUrl, connection.token);
  let accounts: RemoteRunnerAccount[];
  try {
    accounts = await client.accounts(workspace.projectId);
  } catch {
    const usage = await client.usage();
    accounts = usage.accounts.filter((account) => {
      const accountProjectId = account.projectId?.trim();
      return !accountProjectId || accountProjectId === workspace.projectId;
    });
  }
  return syncRemoteWorkspaceAccounts(workspace, accounts, opts);
}
