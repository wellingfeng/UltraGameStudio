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

import { CLOUD_PROJECTS_ENABLED, assertCloudProjectsEnabled } from '@/lib/cloudProjects';

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
  REMOTE_RUNNER_API_PATHS,
  normalizeRemoteServerUrl,
  remoteRunnerApiUrl,
} from '@ugs/protocol';
import type { SkillCandidateList } from '@/runtime/skills/preReview';
import type { SkillOrigin } from '@/runtime/skills/types';
import type {
  RemoteAdapter,
  RemoteEnvironmentInstallInput,
  RemoteEnvironmentInstallResult,
  RemoteEnvironmentReport,
  RemoteRunnerAuthSession,
  RemoteRunnerAuthUser,
  RemoteRunnerFileUpload,
  RemoteRunnerFileUploadInput,
  RemoteRunnerFilePreview,
  RemoteRunnerAccount,
  RemoteRunnerProject,
  RemoteSkillCatalogEntry,
  RemoteSkillCatalogSnapshot,
  WorkspaceDirectoryListing,
  WorkspaceTreeEntry,
} from '@ugs/protocol';

export type {
  CreateRemoteJobInput,
  RemoteAdapter,
  RemoteEnvironmentInstallInput,
  RemoteEnvironmentInstallResult,
  RemoteEnvironmentInstallStep,
  RemoteEnvironmentReport,
  RemoteEnvironmentTool,
  RemoteEnvironmentToolId,
  RemoteJob,
  RemoteJobArtifacts,
  RemoteJobLogLine,
  RemoteJobMessage,
  RemoteJobStatus,
  RemoteRunnerAccount,
  RemoteRunnerAccountInput,
  RemoteRunnerAuthSession,
  RemoteRunnerAuthUser,
  RemoteRunnerFileUpload,
  RemoteRunnerFileUploadInput,
  RemoteRunnerFileUploadNamespace,
  RemoteRunnerFilePreview,
  RemoteRunnerLedger,
  RemoteRunnerProject,
  RemoteRunnerProjectInput,
  RemoteRunnerUsage,
  RemoteRunnerUsageTotals,
  RemoteSkillCatalogEntry,
  RemoteSkillCatalogSnapshot,
  RunnerHealth,
  WorkspaceDirectoryListing,
  WorkspaceTreeEntry,
} from '@ugs/protocol';

export const REMOTE_WORKSPACE_STORAGE_KEY = 'ultragamestudio.remoteWorkspaces.v1';
export const REMOTE_WORKSPACE_SKILLS_STORAGE_KEY =
  'ultragamestudio.remoteWorkspaceSkills.v1';
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
  /**
   * True only when the user explicitly created/saved this workspace via the
   * "添加云端项目" dialog. Auto-binding (ensureRemoteWorkspaceProject) must NOT
   * set this — it only fills projectId/repoUrl on whatever workspace is in use,
   * including ghost prefills. Startup purge relies on this provenance flag (not
   * on the presence of projectId/repoUrl) to decide what is a genuine project.
   */
  userCreated?: boolean;
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
  refreshToken?: string;
  userEmail?: string;
}

export interface ResolvedRemoteRunnerConnection {
  serverUrl: string;
  token: string;
  userEmail?: string;
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

/** Bare Claude tier aliases the runner only accepts on the Claude adapter. */
const CLAUDE_TIER_ALIASES = new Set(['haiku', 'sonnet', 'opus']);

/**
 * True when `model` is a Claude-family model id — bare tier aliases
 * (`haiku`/`sonnet`/`opus`) or any `claude*` id (e.g. `claude-opus-4-8`).
 * Used to keep Claude-family models from leaking onto Codex/Gemini accounts.
 */
export function isClaudeFamilyModel(model: string | null | undefined): boolean {
  const trimmed = model?.trim().toLowerCase();
  if (!trimmed) return false;
  return trimmed.startsWith('claude') || CLAUDE_TIER_ALIASES.has(trimmed);
}

/**
 * Normalize a model id for a remote adapter: a non-Claude adapter (Codex/Gemini)
 * must never receive a Claude-family model. Returns `undefined` so callers fall
 * back to the account's own default model instead of forwarding a model the
 * adapter can't run.
 */
export function remoteModelForAdapter(
  isClaudeAdapter: boolean,
  model: string | null | undefined,
): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;
  if (!isClaudeAdapter && isClaudeFamilyModel(trimmed)) return undefined;
  return trimmed;
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
  // 云端项目已退役：不再读取旧配置，磁盘/localStorage 数据保留。
  if (!CLOUD_PROJECTS_ENABLED) return [];
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
  assertCloudProjectsEnabled();
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
    // Provenance: stays true once the user created it; auto-binding leaves
    // `input.userCreated` undefined and must never demote an existing flag.
    userCreated: input.userCreated ?? existing?.userCreated ?? false,
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
  clearCachedRemoteWorkspaceSkills(id);
}

/** True when a serverUrl is the built-in default test runner. */
function isDefaultRunnerServerUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return (
    normalizeServerUrl(raw) ===
    normalizeServerUrl(DEFAULT_REMOTE_RUNNER_SERVER_URL)
  );
}

/** Remove the saved global runner connection (localStorage + keychain). */
function clearRemoteRunnerConnection(): void {
  if (hasStorage()) {
    try {
      window.localStorage.removeItem(REMOTE_RUNNER_CONNECTION_STORAGE_KEY);
    } catch {
      /* non-fatal */
    }
  }
  writeSecureRecord(REMOTE_RUNNER_CONNECTION_SECRET, { token: '' });
}

/**
 * 清理「内置默认云端 Runner 自动预填」遗留下来的幽灵云端工作区。
 *
 * 历史问题：早期「添加云端项目」对话框会预填官方测试 Runner（默认 serverUrl +
 * 默认共享 Token）。用户即便只是点开看看再保存，也会落下一条指向默认服务器的
 * 云端工作区，导致本地项目意外显示成云端。
 *
 * 旧实现用「是否绑定了 projectId/repoUrl」当作真实项目的判据，但这是错的：
 * 幽灵空壳一旦被使用，`ensureRemoteWorkspaceProject` 会自动给它补上 projectId，
 * 于是它永远满足「有内容」而免于清理 → 本地项目反复被顶成云端。
 *
 * 现以「显式来源」判定。判定为「纯预填产物」需同时满足：
 *   - 工作区 serverUrl 指向内置默认（或本机回环）；
 *   - 工作区不是用户通过对话框显式创建的（userCreated 非 true）；
 *   - 该工作区没有自己保存过的非默认 per-workspace Token；
 *   - 全局连接要么没保存过，要么本身就是默认共享 Token（即用户从未改过）。
 *
 * 满足时删除该工作区配置/密钥/provider，并返回被删的 id 列表，便于上层
 * 同步清理历史工作区索引中对应的 `remote://` 记录。用户真正配置过的默认
 * Runner 项目（userCreated 或改过 Token）不会被误删。
 *
 * @returns 被删除的工作区 id 列表（用于同步清理历史索引）。
 */
export function purgeDefaultRemoteWorkspaces(): string[] {
  const storedToken = readSecureRecord(REMOTE_RUNNER_CONNECTION_SECRET).token ?? '';
  const storedServerUrl = readStoredRunnerServerUrl();
  const connectionIsPureDefault =
    (!storedServerUrl.trim() || isDefaultRunnerServerUrl(storedServerUrl)) &&
    (!storedToken.trim() || storedToken === DEFAULT_REMOTE_RUNNER_TOKEN);
  if (!connectionIsPureDefault) return [];

  const removed: string[] = [];
  let keptRealDefaultProject = false;
  for (const workspace of loadRemoteWorkspaces()) {
    const pointsAtDefault =
      isDefaultRunnerServerUrl(workspace.serverUrl) ||
      isLoopbackServerUrl(workspace.serverUrl);
    if (!pointsAtDefault) continue;
    // 用户通过对话框显式创建的，是有意保存的真实云端项目，保留——
    // 即便它用的是内置默认 Token、且 projectId 是后来自动绑定的。
    if (workspace.userCreated) {
      keptRealDefaultProject = true;
      continue;
    }
    const ownToken = readRemoteSecrets(workspace.id).token.trim();
    if (ownToken && ownToken !== DEFAULT_REMOTE_RUNNER_TOKEN) {
      keptRealDefaultProject = true;
      continue;
    }
    deleteRemoteWorkspace(workspace.id);
    removed.push(workspace.id);
  }

  // 连同纯默认的全局连接一起清掉，避免下次又被解析/预填。
  // 但若保留了指向默认服务器的真实项目，则保留全局连接供其继续使用。
  if (!keptRealDefaultProject && (storedServerUrl.trim() || storedToken.trim())) {
    clearRemoteRunnerConnection();
  }
  return removed;
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
  const storedServerUrl = readStoredRunnerServerUrl();
  const storedIsStale =
    allowDefault && storedServerUrl.trim() && isLoopbackServerUrl(storedServerUrl);
  const storedToken = storedIsStale ? '' : record.token;
  const token = storedToken || (allowDefault ? DEFAULT_REMOTE_RUNNER_TOKEN : '');
  return {
    token,
    refreshToken: storedIsStale ? '' : record.refreshToken,
    userEmail: storedIsStale ? '' : record.userEmail,
  };
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
    refreshToken: secrets.refreshToken ?? '',
    userEmail: secrets.userEmail ?? '',
  });
  return connection;
}

export function saveRemoteRunnerAuthSession(
  input: { serverUrl: string },
  session: RemoteRunnerAuthSession,
): RemoteRunnerConnection {
  return saveRemoteRunnerConnection(input, {
    token: session.accessToken,
    refreshToken: session.refreshToken,
    userEmail: session.user.email,
  });
}

export async function refreshRemoteRunnerAuthSession(
  serverUrl: string,
): Promise<RemoteRunnerAuthSession | null> {
  const secrets = readRemoteRunnerConnectionSecrets({ allowDefault: false });
  if (!secrets.refreshToken) return null;
  try {
    const client = new RunnerClient(serverUrl, secrets.token);
    const session = await client.refresh({ refreshToken: secrets.refreshToken });
    saveRemoteRunnerAuthSession({ serverUrl }, session);
    return session;
  } catch {
    return null;
  }
}

export async function getRemoteRunnerAuthUser(
  serverUrl: string,
  token: string,
): Promise<RemoteRunnerAuthUser | null> {
  try {
    return await new RunnerClient(serverUrl, token).me();
  } catch {
    return null;
  }
}

export function resolveRemoteRunnerConnection(
  workspace?: RemoteWorkspaceConfig | null,
): ResolvedRemoteRunnerConnection | null {
  // 仅认用户显式保存的连接（不含内置默认），避免纯本地用户被误导向默认服务器发请求。
  const global = readRemoteRunnerConnection({ allowDefault: false });
  const globalSecrets = readRemoteRunnerConnectionSecrets({ allowDefault: false });
  const globalToken = globalSecrets.token;
  if (global?.serverUrl && globalToken) {
    return {
      serverUrl: global.serverUrl,
      token: globalToken,
      userEmail: globalSecrets.userEmail,
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

export async function resolveRemoteRunnerConnectionAsync(
  workspace?: RemoteWorkspaceConfig | null,
): Promise<ResolvedRemoteRunnerConnection | null> {
  const resolved = resolveRemoteRunnerConnection(workspace);
  if (!resolved || resolved.source !== 'global') return resolved;
  const secrets = readRemoteRunnerConnectionSecrets({ allowDefault: false });
  if (!secrets.refreshToken) return resolved;
  const session = await refreshRemoteRunnerAuthSession(resolved.serverUrl);
  if (!session) return resolved;
  return {
    serverUrl: resolved.serverUrl,
    token: session.accessToken,
    userEmail: session.user.email,
    source: 'global',
  };
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
  // The protocol SDK's header builder is private. Keep this ordinary bearer
  // transport private too; no namespace, owner-control grant, or local store.
  readonly #candidateHeaders: Record<string, string>;
  // 云端项目已退役：阻断所有旧调用路径，禁止向 Runner 发起请求。
  constructor(serverUrl: string, token: string) {
    assertCloudProjectsEnabled();
    super(serverUrl, token);
    this.#candidateHeaders = { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  }
  async skillCandidateRequest(
    projectId: string,
    request: { action: 'load' | 'compare_and_swap'; origin: SkillOrigin; list?: SkillCandidateList; expectedRevision?: number },
    opts: { signal?: AbortSignal } = {},
  ): Promise<SkillCandidateList> {
    const res = await fetch(remoteRunnerApiUrl(this.serverUrl, `${REMOTE_RUNNER_API_PATHS.projectSkillService(projectId)}/candidates`), {
      method: 'POST', headers: { ...this.#candidateHeaders }, body: JSON.stringify(request), signal: opts.signal,
    });
    const data = await res.json() as { ok?: boolean; result?: SkillCandidateList; error?: string };
    if (!res.ok || data.ok !== true || !data.result) throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${res.status}`);
    if (data.result.version !== 1 || !Number.isSafeInteger(data.result.revision) || data.result.revision! < 0 || !Array.isArray(data.result.candidates)) {
      throw new Error('SKILL_CANDIDATE_INVALID_RESPONSE');
    }
    return data.result;
  }
  /** Build a client straight from a saved workspace id. */
  static fromWorkspace(id: string): RunnerClient | null {
    const config = getRemoteWorkspace(id);
    if (!config) return null;
    const connection = resolveRemoteRunnerConnection(config);
    if (!connection) return null;
    return new RunnerClient(connection.serverUrl, connection.token);
  }

  static async fromWorkspaceAsync(id: string): Promise<RunnerClient | null> {
    const config = getRemoteWorkspace(id);
    if (!config) return null;
    const connection = await resolveRemoteRunnerConnectionAsync(config);
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
    // Preserve provenance: auto-binding never promotes a ghost to user-created.
    userCreated: config.userCreated,
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
  opts: { sync?: boolean } = {},
): Promise<WorkspaceDirectoryListing> {
  const workspaceId = remoteWorkspaceIdFromPath(rootPath);
  let config = getRemoteWorkspace(workspaceId);
  if (!config) throw new Error('云端项目不存在。');
  const connection = await resolveRemoteRunnerConnectionAsync(config);
  if (!connection) throw new Error('云端服务未配置。请先配置服务器地址和访问 Token。');
  const client = new RunnerClient(connection.serverUrl, connection.token);
  let listing: WorkspaceDirectoryListing;

  if (config.projectId) {
    try {
      listing = await client.listProjectDirectory(config.projectId, relativePath, opts);
    } catch (err) {
      if (!isRemoteProjectNotFoundError(err)) throw err;
      config = await ensureRemoteWorkspaceProject(config, client);
      if (!config.projectId) {
        throw new Error('云端项目在后端不存在或已被删除。请在云端项目设置中重新保存。');
      }
      listing = await client.listProjectDirectory(config.projectId, relativePath, opts);
    }
  } else {
    config = await ensureRemoteWorkspaceProject(config, client);
    if (!config.projectId) throw new Error('云端项目未绑定后端 projectId。请在云端项目设置中重新保存。');
    listing = await client.listProjectDirectory(config.projectId, relativePath, opts);
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
  const connection = await resolveRemoteRunnerConnectionAsync(config);
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
  const connection = await resolveRemoteRunnerConnectionAsync(config);
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

/**
 * Resolve a bound RunnerClient + projectId for a remote workspace path. Shared by
 * the remote-environment helpers below so they can target the server-side project
 * the same way file listing/preview do (creating/binding the project if needed).
 */
async function resolveRemoteProjectClient(
  rootPath: string,
): Promise<{ client: RunnerClient; projectId: string }> {
  const workspaceId = remoteWorkspaceIdFromPath(rootPath);
  let config = getRemoteWorkspace(workspaceId);
  if (!config) throw new Error('云端项目不存在。');
  const connection = await resolveRemoteRunnerConnectionAsync(config);
  if (!connection) throw new Error('云端服务未配置。请先配置服务器地址和访问 Token。');
  const client = new RunnerClient(connection.serverUrl, connection.token);
  if (!config.projectId) {
    config = await ensureRemoteWorkspaceProject(config, client);
  }
  if (!config.projectId) {
    throw new Error('云端项目未绑定后端 projectId。请在云端项目设置中重新保存。');
  }
  return { client, projectId: config.projectId };
}

/**
 * Probe the remote host for the runtime environment a project needs (git, node,
 * python). Used by the project settings "remote environment" tab to show what is
 * installed and whether a sync can run.
 */
export async function getRemoteWorkspaceEnvironment(
  rootPath: string,
): Promise<RemoteEnvironmentReport> {
  const { client, projectId } = await resolveRemoteProjectClient(rootPath);
  return client.getProjectEnvironment(projectId);
}

/**
 * Trigger a server-side install of the missing required tools. The click happens
 * locally in project settings; the install runs remotely on the backend host.
 */
export async function installRemoteWorkspaceEnvironment(
  rootPath: string,
  input: RemoteEnvironmentInstallInput = {},
): Promise<RemoteEnvironmentInstallResult> {
  const { client, projectId } = await resolveRemoteProjectClient(rootPath);
  return client.installProjectEnvironment(projectId, input);
}

function remoteAdapterToProviderKind(adapter: string): ProviderKind {  if (adapter === 'codex') return 'codex';
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
    : await resolveRemoteRunnerConnectionAsync(workspace);
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

// ---------- Remote skill / slash command catalog (per-project cache) ----------

/**
 * Per-project cache of the remote workspace's slash command / skill catalog.
 * Like model lists and account info, the catalog is fetched once on connect and
 * then served from this cache; the `/` menu reads the cache so it stays cheap
 * and offline-friendly. Keyed by workspace id.
 */
type RemoteWorkspaceSkillsCache = Record<
  string,
  { scannedAtMs: number; entries: RemoteSkillCatalogEntry[] }
>;

/** Fired after a remote workspace's skill cache is refreshed. */
export const REMOTE_WORKSPACE_SKILLS_UPDATED_EVENT =
  'ultragamestudio:remote-workspace-skills-updated';

function readRemoteSkillsCache(): RemoteWorkspaceSkillsCache {
  if (!hasStorage()) return {};
  try {
    const raw = window.localStorage.getItem(REMOTE_WORKSPACE_SKILLS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as RemoteWorkspaceSkillsCache;
  } catch {
    return {};
  }
}

function writeRemoteSkillsCache(cache: RemoteWorkspaceSkillsCache): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.setItem(
      REMOTE_WORKSPACE_SKILLS_STORAGE_KEY,
      JSON.stringify(cache),
    );
  } catch {
    /* non-fatal */
  }
}

/** Read the cached remote skill/command entries for a workspace ('' → none). */
export function getCachedRemoteWorkspaceSkills(
  workspaceId: string,
): RemoteSkillCatalogEntry[] {
  if (!workspaceId) return [];
  return readRemoteSkillsCache()[workspaceId]?.entries ?? [];
}

function storeRemoteWorkspaceSkills(
  workspaceId: string,
  snapshot: RemoteSkillCatalogSnapshot,
): void {
  const cache = readRemoteSkillsCache();
  cache[workspaceId] = {
    scannedAtMs: snapshot.scannedAtMs || Date.now(),
    entries: snapshot.entries ?? [],
  };
  writeRemoteSkillsCache(cache);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent(REMOTE_WORKSPACE_SKILLS_UPDATED_EVENT, {
        detail: { workspaceId },
      }),
    );
  }
}

/** Drop the cached remote skill catalog for a workspace. */
export function clearCachedRemoteWorkspaceSkills(workspaceId: string): void {
  const cache = readRemoteSkillsCache();
  if (!(workspaceId in cache)) return;
  delete cache[workspaceId];
  writeRemoteSkillsCache(cache);
}

/**
 * Fetch the remote project's slash command / skill catalog and cache it. Called
 * once per workspace on connect (and on demand); subsequent `/` menu reads come
 * from {@link getCachedRemoteWorkspaceSkills}. Returns the entries (empty on any
 * failure, leaving any prior cache untouched).
 */
export async function refreshRemoteWorkspaceSkills(
  workspace: RemoteWorkspaceConfig,
  opts: { sync?: boolean } = {},
): Promise<RemoteSkillCatalogEntry[]> {
  const connection = await resolveRemoteRunnerConnectionAsync(workspace);
  if (!connection?.token) return [];
  const client = new RunnerClient(connection.serverUrl, connection.token);
  let config = workspace;
  if (!config.projectId) {
    config = await ensureRemoteWorkspaceProject(config, client).catch(() => config);
  }
  if (!config.projectId) return [];
  try {
    const snapshot = await client.listProjectSkills(config.projectId, opts);
    storeRemoteWorkspaceSkills(workspace.id, snapshot);
    return snapshot.entries ?? [];
  } catch {
    return [];
  }
}
