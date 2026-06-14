/**
 * CONTRACT: client-side model + SDK for "remote workspaces" (Route B).
 *
 * A remote workspace points FreeUltraCode at a self-hosted Runner
 * (see `runner/` at the repo root) so the user types instructions locally but
 * the actual development job runs on their own cloud server.
 *
 * Persistence split:
 *   - Non-secret config (id, label, server URL, repo/branch/adapter/model)
 *     lives in localStorage under {@link REMOTE_WORKSPACE_STORAGE_KEY}.
 *   - Secrets (the Runner access token, optional model API key, optional git
 *     token) live in the OS keychain via secureStorage, keyed by workspace id.
 *
 * The remote workspace is surfaced in the existing workspace switcher; its
 * synthetic path is `remote://<id>` so the rest of the app can keep treating
 * "workspace" as a string path while still distinguishing remote ones.
 */

import {
  readSecureRecord,
  setSecureRecordValue,
  writeSecureRecord,
} from '@/lib/secureStorage';

export const REMOTE_WORKSPACE_STORAGE_KEY = 'freeultracode.remoteWorkspaces.v1';
/** Secret bucket (keychain) holding per-workspace tokens/keys. */
export const REMOTE_WORKSPACE_SECRET = 'remoteWorkspaces.secrets.v1';
/** Synthetic path scheme so remote workspaces flow through path-typed APIs. */
export const REMOTE_WORKSPACE_PREFIX = 'remote://';

export type RemoteAdapter = 'claude' | 'codex' | 'gemini';

/** Non-secret, persisted remote-workspace configuration. */
export interface RemoteWorkspaceConfig {
  id: string;
  label: string;
  /** Base URL of the Runner, e.g. https://my-server:8787 (no trailing slash). */
  serverUrl: string;
  /** Optional default repository to clone for jobs. */
  repoUrl?: string;
  /** Optional default branch. */
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
  /** Runner bearer token (required to talk to the server). */
  token: string;
  /** Optional model API key sent per job when useOwnModelKey is true. */
  apiKey?: string;
  /** Optional model base URL. */
  baseUrl?: string;
  /** Optional git token for clone/push of private repos. */
  gitToken?: string;
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
  return raw.trim().replace(/\/+$/, '');
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

export interface RunnerHealth {
  ok: boolean;
  service?: string;
  version?: string;
  authRequired?: boolean;
  adapters?: string[];
  maxConcurrency?: number;
}

export type RemoteJobStatus =
  | 'queued'
  | 'cloning'
  | 'running'
  | 'diffing'
  | 'pushing'
  | 'done'
  | 'error';

export interface RemoteJobLogLine {
  at: number;
  phase?: string;
  stream?: 'stdout' | 'stderr';
  text?: string;
}

export interface RemoteJobResult {
  exitCode: number;
  patch?: string;
  pushed?: boolean;
  pushBranch?: string;
}

export interface RemoteJob {
  id: string;
  status: RemoteJobStatus;
  createdAt: number;
  updatedAt: number;
  repoUrl: string | null;
  branch: string | null;
  adapter: string;
  model: string | null;
  prompt: string;
  pushBranch: string | null;
  logs: RemoteJobLogLine[];
  result: RemoteJobResult | null;
  error: string | null;
}

export interface CreateRemoteJobInput {
  prompt: string;
  repoUrl?: string;
  branch?: string;
  adapter?: RemoteAdapter;
  model?: string;
  pushBranch?: string;
  apiKey?: string;
  baseUrl?: string;
  gitToken?: string;
}

/** Thin client bound to one remote workspace's server + token. */
export class RunnerClient {
  readonly serverUrl: string;
  private readonly token: string;

  constructor(serverUrl: string, token: string) {
    this.serverUrl = normalizeServerUrl(serverUrl);
    this.token = token;
  }

  /** Build a client straight from a saved workspace id. */
  static fromWorkspace(id: string): RunnerClient | null {
    const config = getRemoteWorkspace(id);
    if (!config) return null;
    const secrets = readRemoteSecrets(id);
    return new RunnerClient(config.serverUrl, secrets.token);
  }

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    if (json) h['content-type'] = 'application/json';
    return h;
  }

  /** Probe `/health`. Unauthenticated, so this also validates reachability. */
  async health(signal?: AbortSignal): Promise<RunnerHealth> {
    try {
      const res = await fetch(`${this.serverUrl}/health`, {
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
    const res = await fetch(`${this.serverUrl}/jobs`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify(input),
    });
    const data = (await res.json()) as { ok: boolean; job?: RemoteJob; error?: string };
    if (!res.ok || !data.ok || !data.job) {
      throw new Error(data.error ?? `runner returned ${res.status}`);
    }
    return data.job;
  }

  async getJob(id: string): Promise<RemoteJob> {
    const res = await fetch(`${this.serverUrl}/jobs/${encodeURIComponent(id)}`, {
      headers: this.headers(),
    });
    const data = (await res.json()) as { ok: boolean; job?: RemoteJob; error?: string };
    if (!res.ok || !data.ok || !data.job) {
      throw new Error(data.error ?? `runner returned ${res.status}`);
    }
    return data.job;
  }

  async cancelJob(id: string): Promise<boolean> {
    const res = await fetch(
      `${this.serverUrl}/jobs/${encodeURIComponent(id)}/cancel`,
      { method: 'POST', headers: this.headers() },
    );
    return res.ok;
  }

  /**
   * Subscribe to a job's live log/status/result stream (SSE). Returns an
   * unsubscribe function. Uses fetch + ReadableStream so the Authorization
   * header can be sent (native EventSource cannot set headers).
   */
  streamJob(
    id: string,
    handlers: {
      onLog?: (line: RemoteJobLogLine) => void;
      onStatus?: (status: RemoteJobStatus) => void;
      onResult?: (job: RemoteJob) => void;
      onError?: (err: Error) => void;
    },
  ): () => void {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(
          `${this.serverUrl}/jobs/${encodeURIComponent(id)}/stream`,
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
          for (const chunk of events) dispatchSse(chunk, handlers);
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

function dispatchSse(
  chunk: string,
  handlers: {
    onLog?: (line: RemoteJobLogLine) => void;
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
  if (event === 'log') handlers.onLog?.(payload as RemoteJobLogLine);
  else if (event === 'status') handlers.onStatus?.(payload as RemoteJobStatus);
  else if (event === 'result') handlers.onResult?.(payload as RemoteJob);
}
