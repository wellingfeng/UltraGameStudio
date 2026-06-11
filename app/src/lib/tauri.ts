import type { IRGraph } from '@/core/ir';
import { runShellPayload } from '@/lib/shellConfig';

/**
 * CONTRACT: thin, browser-safe bridge to the Tauri Rust backend.
 *
 * Every export degrades gracefully when running outside the desktop shell
 * (plain Vite dev / browser): IPC modules are dynamically imported so the web
 * build never resolves them at load time, and the no-backend / no-key paths
 * throw well-known error codes the caller can branch on.
 *
 *   tauriAvailable() -> boolean
 *   isTauri()        -> boolean (alias)
 *   aiEditGraph(currentIr, instruction, apiKey?) -> Promise<IRGraph>
 *       throws Error('NO_BACKEND')  when not in Tauri
 *       throws Error('NO_API_KEY')  when in Tauri but no key was supplied
 *   runWorkflow(script, adapter) -> Promise<string>   (stdout/stderr summary)
 *   cancelAiCli(runId) -> Promise<void>               best-effort process kill
 *   onWorkflowLog(cb)  -> Promise<UnlistenFn>          ('workflow-log' lines)
 *   onWorkflowNode(cb) -> Promise<UnlistenFn>          ('workflow-node' updates)
 */

/** Per-node runtime status pushed from the backend over 'workflow-node'. */
export type WorkflowNodeState = 'idle' | 'running' | 'success' | 'error';

/** Payload of a 'workflow-node' event. */
export interface WorkflowNodeEvent {
  nodeId: string;
  state: WorkflowNodeState;
}

export type CliPlatform = 'windows' | 'macos' | 'linux';

export interface ModelCliCandidate {
  adapter: string;
  command: string;
  path?: string | null;
  source: string;
  available: boolean;
  status: string;
  hint?: string | null;
  error?: string | null;
  platform: CliPlatform;
}

export interface ModelCliScanResult {
  scannedAtMs: number;
  platform: CliPlatform;
  candidates: ModelCliCandidate[];
  error?: string | null;
}

export type SlashCatalogEntryKind = 'command' | 'skill';

export interface SlashCatalogText {
  'zh-CN'?: string;
  'en-US'?: string;
  [locale: string]: string | undefined;
}

export interface SlashCatalogEntry {
  id: string;
  kind: SlashCatalogEntryKind;
  name: string;
  label: SlashCatalogText;
  detail: SlashCatalogText;
  insertText: SlashCatalogText;
  source?: string | null;
  sourceAdapter?: string | null;
}

export interface SlashCatalogSnapshot {
  scannedAtMs: number;
  ready: boolean;
  entries: SlashCatalogEntry[];
  error?: string | null;
}

export interface SkillInstallTarget {
  id: string;
  label: string;
  path: string;
  exists: boolean;
  skillCount: number;
  skills: string[];
  isDefault: boolean;
  /** "project" for the active workspace's skill dirs, "global" otherwise. */
  scope: 'project' | 'global';
}

export interface InstalledSkill {
  name: string;
  slug: string;
  targetId: string;
  path: string;
  skillFile: string;
  sourceUrl?: string | null;
  overwritten: boolean;
}

export interface UltracodeRunOptions {
  cwd?: string;
  extraWorkspacePaths?: string[];
  adapter?: string;
  model?: string;
  provider?: string;
  concurrency?: number;
  maxRetries?: number;
  maxAgentCalls?: number;
  maxRounds?: number;
  verifyCommand?: string;
  timeoutSeconds?: number;
  runId?: string;
  resume?: boolean;
  plannerOnly?: boolean;
  fromHarness?: string;
  trace?: boolean;
  interactive?: boolean;
  onProgress?: (text: string) => void;
}

export interface UltracodeRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  runId: string;
  runDir?: string | null;
  resultJson?: unknown;
}

export interface CliPathValidation {
  path: string;
  normalizedPath: string;
  platform: CliPlatform;
  fileName: string;
}

export interface LocalModelHardware {
  ramGb?: number | null;
  cpuThreads?: number | null;
  gpuVramGb?: number | null;
}

export interface LocalFilePreview {
  path: string;
  fileName: string;
  kind: 'text' | 'image' | 'binary';
  mime?: string | null;
  sizeBytes: number;
  truncated: boolean;
  text?: string | null;
  base64?: string | null;
}

export interface WorkspaceTreeEntry {
  name: string;
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

export type ProjectEngineKind = 'unreal' | 'unity' | 'godot' | 'unknown';

export interface ProjectEngineDetection {
  engine: ProjectEngineKind;
  label: string;
  confidence: number;
  projectFile?: string | null;
  version?: string | null;
  markers: string[];
}

export interface ProjectSkillRootSnapshot {
  id: string;
  label: string;
  path: string;
  exists: boolean;
  skillCount: number;
  skills: string[];
}

export interface ProjectMcpServerSuggestion {
  id: string;
  label: string;
  description: string;
  transport: 'stdio' | string;
  command: string;
  args: string[];
  env: Record<string, string>;
  available: boolean;
  availabilityNote: string;
  requiresUserApproval: boolean;
}

export interface ProjectEnvironmentScan {
  rootPath: string;
  scannedAtMs: number;
  engine: ProjectEngineDetection;
  skillRoots: ProjectSkillRootSnapshot[];
  suggestedMcpServers: ProjectMcpServerSuggestion[];
}

export interface ProjectMcpProbeServerConfig {
  id: string;
  transport: 'stdio' | 'streamable-http' | string;
  command?: string | null;
  args?: string[] | null;
  env?: Record<string, string> | null;
  url?: string | null;
}

export interface ProjectMcpProbeResult {
  serverId: string;
  ok: boolean;
  status: string;
  message: string;
  toolsCount?: number | null;
  checkedAtMs: number;
}

export interface ProjectLspProbeServerConfig {
  id: string;
  command?: string | null;
  args?: string[] | null;
}

export interface ProjectLspProbeResult {
  serverId: string;
  ok: boolean;
  status: string;
  message: string;
  resolvedCommand?: string | null;
  checkedAtMs: number;
}

export interface ProjectLspInstallCommand {
  label: string;
  command: string;
  args: string[];
  platforms?: CliPlatform[] | null;
}

export interface ProjectLspInstallRequest {
  serverId: string;
  commands: ProjectLspInstallCommand[];
  cwd?: string | null;
}

export interface ProjectLspInstallResult {
  serverId: string;
  ok: boolean;
  status: string;
  message: string;
  commandLine?: string | null;
  stdout: string;
  stderr: string;
  exitCode?: number | null;
  timedOut: boolean;
  platform: CliPlatform;
  checkedAtMs: number;
}

/** Stable server id shared by one-click install + the recommended UE suggestion. */
export const UE_MCP_SERVER_ID = 'ue-mcp-for-all-versions';

/** Result of ensuring the pinned UE MCP binary is downloaded + sha256-verified. */
export interface UeMcpBinaryStatus {
  serverId: string;
  version: string;
  path: string;
  available: boolean;
  downloaded: boolean;
  sha256: string;
  source: string;
  supportedPlatform: boolean;
  message: string;
}

export interface UeMcpSetupRequest {
  rootPath: string;
  serverCommand?: string;
  enablePython?: boolean;
  writeMcpConfig?: boolean;
  dryRun?: boolean;
}

/** Machine-readable report from `ue-mcp-for-all-versions --setup-project`. */
export interface UeMcpSetupResult {
  ok: boolean;
  changed: boolean;
  dryRun: boolean;
  uprojectPath?: string | null;
  projectDir?: string | null;
  engineAssociation?: string | null;
  configuredPlugins: string[];
  changedFiles: string[];
  notes: string[];
  warnings: string[];
  unrealEditorRunning?: boolean;
  restartRequired?: boolean;
  error?: string | null;
  binaryPath: string;
  serverCommand: string;
  rawReport: unknown;
}

export type WorkspaceChangeLineKind =
  | 'added'
  | 'deleted'
  | 'replacedAdded'
  | 'replacedDeleted';

export interface WorkspaceChangeLine {
  kind: WorkspaceChangeLineKind;
  oldLine?: number | null;
  newLine?: number | null;
  content: string;
}

export type WorkspaceChangeFileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface WorkspaceChangeFile {
  path: string;
  oldPath?: string | null;
  status: WorkspaceChangeFileStatus;
  binary: boolean;
  truncated: boolean;
  lines: WorkspaceChangeLine[];
}

export interface WorkspaceChanges {
  rootPath: string;
  generatedAtMs: number;
  source?: string;
  files: WorkspaceChangeFile[];
  truncated: boolean;
  scanScope?: 'root' | 'full' | string;
}

export interface WorkspaceChangeSnapshotFile {
  path: string;
  sizeBytes: number;
  modifiedAtMs?: number | null;
  binary: boolean;
  truncated: boolean;
  content?: string | null;
}

export interface WorkspaceChangeBaseline {
  rootPath: string;
  generatedAtMs: number;
  fileCount: number;
  truncated: boolean;
}

export interface ModelAssetDownload {
  path: string;
  mime: string;
  sizeBytes: number;
}

export interface ClipboardImageSaveRequest {
  bytesBase64: string;
  mime: string;
  fileName?: string | null;
  cwd?: string | null;
}

export interface SessionCaptureSaveRequest {
  bytesBase64: string;
  mime: string;
  fileName?: string | null;
  cwd?: string | null;
}

export type LocalModelRuntimeState =
  | 'missing_model'
  | 'service_unavailable'
  | 'service_error'
  | 'model_missing'
  | 'ready'
  | 'unsupported'
  | 'desktop_unavailable';

export interface LocalModelRuntimeStatus {
  channelId: string;
  configuredModel: string;
  reachable: boolean;
  ready: boolean;
  state: LocalModelRuntimeState;
  models: string[];
  message?: string | null;
}

export interface RemoteModelListRequest {
  urls: string[];
  apiKey?: string;
  transport: 'anthropic' | 'openai';
}

export interface RemoteModelListResult {
  models: string[];
  url: string;
}

const REMOTE_MODEL_FETCH_TIMEOUT_MS = 6000;

/** Disposer returned by the event listeners. */
export type UnlistenFn = () => void;

export interface SessionNotificationClickPayload {
  workspaceId: string | null;
  sessionId: string | null;
}

export interface DesktopSessionNotificationInput extends SessionNotificationClickPayload {
  title: string;
  body: string;
}

/**
 * True when running inside the Tauri desktop shell. Wraps the SDK's own
 * detection and never throws (older/edge runtimes may lack the global).
 */
export function tauriAvailable(): boolean {
  try {
    if (typeof globalThis === 'undefined') return false;
    const runtime = globalThis as typeof globalThis & {
      isTauri?: unknown;
      __TAURI__?: unknown;
      __TAURI_INTERNALS__?: unknown;
    };
    return (
      runtime.isTauri === true ||
      typeof runtime.__TAURI_INTERNALS__ !== 'undefined' ||
      typeof runtime.__TAURI__ !== 'undefined'
    );
  } catch {
    return false;
  }
}

/** Alias for {@link tauriAvailable}. */
export function isTauri(): boolean {
  return tauriAvailable();
}

/** Dynamically load the `invoke` IPC entrypoint (Tauri-only). */
async function getInvoke() {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke;
}

/** Dynamically load the `listen` event API (Tauri-only). */
async function getListen() {
  const { listen } = await import('@tauri-apps/api/event');
  return listen;
}

/** Bring the main desktop window to the foreground. No-op outside Tauri. */
export async function focusMainWindow(): Promise<void> {
  if (!tauriAvailable()) return;
  const invoke = await getInvoke();
  await invoke('focus_main_window');
}

/** Send a native desktop session notification that can emit a click event. */
export async function notifySessionCompleteDesktop(
  input: DesktopSessionNotificationInput,
): Promise<boolean> {
  if (!tauriAvailable()) return false;
  const invoke = await getInvoke();
  return invoke<boolean>('notify_session_complete', {
    title: input.title,
    body: input.body,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
  });
}

/** Listen for native notification clicks from the desktop backend. */
export async function onSessionNotificationClicked(
  cb: (payload: SessionNotificationClickPayload) => void,
): Promise<UnlistenFn> {
  if (!tauriAvailable()) return () => {};
  const listen = await getListen();
  return listen<SessionNotificationClickPayload>(
    'session-notification-clicked',
    (event) => cb(event.payload),
  );
}

/**
 * Ask the backend to rewrite the current graph from a natural-language
 * instruction. Returns the new IRGraph. The Rust side calls the Anthropic
 * Messages API when `apiKey` is present; otherwise it returns an error and the
 * caller should fall back to the local intent engine.
 */
export async function aiEditGraph(
  currentIr: IRGraph,
  instruction: string,
  apiKey?: string,
): Promise<IRGraph> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  if (!apiKey) {
    throw new Error('NO_API_KEY');
  }
  const invoke = await getInvoke();
  const resultJson = await invoke<string>('ai_edit_graph', {
    currentIrJson: JSON.stringify(currentIr),
    instruction,
    apiKey,
  });
  return JSON.parse(resultJson) as IRGraph;
}

/**
 * Run a prompt through the locally-installed agent CLI (e.g. `claude -p`) using
 * the machine's own env/credentials — no API key required. Returns the CLI's
 * stdout (the assistant reply). Throws Error('NO_BACKEND') outside the desktop
 * shell (the browser cannot spawn processes).
 */
export interface CliOpts {
  /** Model tier for the CLI (`--model`), e.g. 'haiku' | 'sonnet' | 'opus'. */
  model?: string;
  /** Resolved CLI executable/path selected in Settings. Omit for adapter default. */
  cliCommand?: string;
  /** Working directory for the agent (the run's workspace). */
  cwd?: string;
  /** Additional workspace directories exposed to the agent for this call. */
  extraWorkspacePaths?: string[];
  /** Permission mode: 'full' | 'readonly' | 'ask' (from the AIDock dropdown). */
  permission?: string;
  /** Per-call environment overrides used by the model gateway route. */
  env?: Record<string, string>;
  /** Per-call hard timeout override, in seconds. Backend keeps the larger of env/default and this value. */
  timeoutSeconds?: number;
  /** Per-call no-progress timeout override, in seconds. Backend keeps the larger of env/default and this value. */
  idleTimeoutSeconds?: number;
  /** Stable id used to stream progress and cancel the process from the UI. */
  runId?: string;
  /** Live progress callback — receives streamed text/tool-use chunks. */
  onProgress?: (text: string) => void;
  /** Raw model usage payload emitted by supported CLI adapters. */
  onUsage?: (usage: unknown) => void;
  /**
   * Claude session id for context continuity (claude adapter only). With
   * `resume: false` the call creates this session; with `resume: true` it
   * continues it, inheriting the earlier call's warm context.
   */
  sessionId?: string;
  /** Continue `sessionId` instead of creating it. */
  resume?: boolean;
}

let __cliSeq = 0;

const STREAM_PROGRESS_FLUSH_MS = 80;

interface ProgressBatcher {
  push(text: string): void;
  flush(): void;
}

function createProgressBatcher(
  onProgress: (text: string) => void,
  delayMs = STREAM_PROGRESS_FLUSH_MS,
): ProgressBatcher {
  let pending = '';
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };

  const flush = () => {
    clearTimer();
    if (!pending) return;
    const text = pending;
    pending = '';
    onProgress(text);
  };

  return {
    push(text) {
      if (!text) return;
      pending += text;
      if (timer === undefined) {
        timer = setTimeout(flush, delayMs);
        (timer as { unref?: () => void }).unref?.();
      }
    },
    flush,
  };
}

interface AiCliResult {
  text: string;
  usage?: unknown;
}

function isAiCliResult(value: unknown): value is AiCliResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { text?: unknown }).text === 'string'
  );
}

export async function aiEditViaCli(
  prompt: string,
  adapter: string,
  opts: CliOpts = {},
): Promise<string> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  __cliSeq += 1;
  const runId = opts.runId ?? `cli_${Date.now()}_${__cliSeq}`;

  // Subscribe to per-run progress events (best-effort; the final result is
  // returned regardless of whether any progress chunks arrive).
  const unlisteners: UnlistenFn[] = [];
  let usageSeen = false;
  const progressBatcher = opts.onProgress
    ? createProgressBatcher(opts.onProgress)
    : null;
  if (opts.onProgress || opts.onUsage) {
    const listen = await getListen();
    if (progressBatcher) {
      unlisteners.push(
        await listen<{ runId: string; text: string }>(
          'ai-cli-progress',
          (event) => {
            if (event.payload?.runId === runId) {
              progressBatcher.push(event.payload.text);
            }
          },
        ),
      );
    }
    if (opts.onUsage) {
      unlisteners.push(
        await listen<{ runId: string; usage: unknown }>(
          'ai-cli-usage',
          (event) => {
            if (event.payload?.runId === runId) {
              usageSeen = true;
              opts.onUsage!(event.payload.usage);
            }
          },
        ),
      );
    }
  }

  try {
    const invoke = await getInvoke();
    const result = await invoke<string | AiCliResult>('ai_cli', {
      prompt,
      adapter,
      cliCommand: opts.cliCommand ?? null,
      model: opts.model ?? null,
      cwd: opts.cwd ?? null,
      extraWorkspacePaths: opts.extraWorkspacePaths ?? [],
      permission: opts.permission ?? null,
      envVars: opts.env ?? null,
      timeoutSeconds: opts.timeoutSeconds ?? null,
      idleTimeoutSeconds: opts.idleTimeoutSeconds ?? null,
      runId,
      sessionId: opts.sessionId ?? null,
      resume: opts.resume ?? null,
      shell: runShellPayload(),
    });
    if (isAiCliResult(result)) {
      if (result.usage != null && !usageSeen) {
        usageSeen = true;
        opts.onUsage?.(result.usage);
      }
      return result.text;
    }
    return result;
  } finally {
    try {
      progressBatcher?.flush();
    } finally {
      for (const unlisten of unlisteners) unlisten();
    }
  }
}

/**
 * Start (or update) the built-in local free-channel proxy. Sends every ready
 * channel's upstream config; the Rust side binds 127.0.0.1 on a stable port and
 * returns it. Idempotent. Desktop-only — callers should guard with isTauri().
 */
export async function freeProxyEnsure(
  channels: Array<{
    id: string;
    label?: string;
    transport: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    fallbackModels?: string[];
  }>,
): Promise<{ port: number; token: string }> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<{ port: number; token: string }>('free_proxy_ensure', { channels });
}

/** Stop the built-in local free-channel proxy. No-op outside the desktop shell. */
export async function freeProxyStop(): Promise<void> {
  if (!tauriAvailable()) return;
  const invoke = await getInvoke();
  await invoke('free_proxy_stop');
}

/** Read whitelisted free-channel API keys from local private config + env. */
export async function freeChannelAutoKeys(): Promise<Record<string, string>> {
  if (!tauriAvailable()) return {};
  const invoke = await getInvoke();
  return invoke<Record<string, string>>('free_channel_auto_keys');
}

/** Read multiple named secrets from the desktop OS keychain. */
export async function secureSecretGetMany(
  keys: string[],
): Promise<Record<string, string>> {
  if (!tauriAvailable()) return {};
  const invoke = await getInvoke();
  return invoke<Record<string, string>>('secure_secret_get_many', { keys });
}

/** Write one named secret to the desktop OS keychain. */
export async function secureSecretSet(key: string, value: string): Promise<void> {
  if (!tauriAvailable()) return;
  const invoke = await getInvoke();
  await invoke('secure_secret_set', { key, value });
}

/** Delete one named secret from the desktop OS keychain. */
export async function secureSecretDelete(key: string): Promise<void> {
  if (!tauriAvailable()) return;
  const invoke = await getInvoke();
  await invoke('secure_secret_delete', { key });
}

/** Read rough local hardware for choosing an Ollama model. */
export async function localModelHardware(): Promise<LocalModelHardware> {
  if (!tauriAvailable()) {
    const nav = typeof navigator !== 'undefined' ? navigator : undefined;
    const memory =
      nav && typeof (nav as Navigator & { deviceMemory?: unknown }).deviceMemory === 'number'
        ? (nav as Navigator & { deviceMemory: number }).deviceMemory
        : null;
    return {
      ramGb: memory,
      cpuThreads: nav?.hardwareConcurrency ?? null,
      gpuVramGb: null,
    };
  }
  const invoke = await getInvoke();
  return invoke<LocalModelHardware>('local_model_hardware');
}

/** Probe whether a local-model runtime is reachable and exposes the selected model. */
export async function localModelStatus(
  channelId: string,
  model: string,
): Promise<LocalModelRuntimeStatus> {
  const configuredModel = model.trim();
  if (!configuredModel) {
    return {
      channelId,
      configuredModel: '',
      reachable: false,
      ready: false,
      state: 'missing_model',
      models: [],
      message: 'missing model',
    };
  }
  if (!tauriAvailable()) {
    return {
      channelId,
      configuredModel,
      reachable: false,
      ready: false,
      state: 'desktop_unavailable',
      models: [],
      message: 'desktop backend unavailable',
    };
  }
  const invoke = await getInvoke();
  return invoke<LocalModelRuntimeStatus>('local_model_status', {
    channelId,
    model: configuredModel,
  });
}

/** List locally served models for Ollama / LM Studio / llama.cpp. */
export async function listLocalModels(channelId: string): Promise<string[]> {
  if (!tauriAvailable()) return [];
  const invoke = await getInvoke();
  return invoke<string[]>('local_model_list', { channelId });
}

function extractRemoteModelIds(value: unknown): string[] {
  const out: string[] = [];
  const push = (candidate: unknown) => {
    if (typeof candidate !== 'string') return;
    const model = candidate.trim();
    if (!model) return;
    if (out.some((existing) => existing.toLowerCase() === model.toLowerCase())) {
      return;
    }
    out.push(model);
  };
  const visitModel = (item: unknown) => {
    if (typeof item === 'string') {
      push(item);
      return;
    }
    if (typeof item !== 'object' || item === null) return;
    const record = item as Record<string, unknown>;
    push(record.id);
    push(record.name);
    push(record.model);
  };

  if (Array.isArray(value)) {
    value.forEach(visitModel);
    return out;
  }
  if (typeof value !== 'object' || value === null) return out;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.data)) record.data.forEach(visitModel);
  if (Array.isArray(record.models)) record.models.forEach(visitModel);
  visitModel(record);
  return out;
}

async function fetchRemoteModels(
  request: RemoteModelListRequest,
): Promise<RemoteModelListResult> {
  const errors: string[] = [];
  const headers: Record<string, string> = { accept: 'application/json' };
  const apiKey = request.apiKey?.trim();
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
    if (request.transport === 'anthropic') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    }
  }

  for (const url of request.urls) {
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(),
      REMOTE_MODEL_FETCH_TIMEOUT_MS,
    );
    try {
      const response = await fetch(url, { headers, signal: controller.signal });
      if (!response.ok) {
        errors.push(`${url}: HTTP ${response.status}`);
        continue;
      }
      const models = extractRemoteModelIds(await response.json());
      if (models.length > 0) return { models, url };
      errors.push(`${url}: empty model list`);
    } catch (err) {
      errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      window.clearTimeout(timeout);
    }
  }
  throw new Error(errors.join('; ') || 'No model list endpoint available');
}

/** List remote provider models. Tauri backend is preferred to avoid CORS. */
export async function listRemoteModels(
  request: RemoteModelListRequest,
): Promise<RemoteModelListResult> {
  if (!tauriAvailable()) return fetchRemoteModels(request);
  const invoke = await getInvoke();
  return invoke<RemoteModelListResult>('list_remote_models', {
    urls: request.urls,
    apiKey: request.apiKey ?? '',
    transport: request.transport,
  });
}

/** Launch the bundled Windows Ollama setup script in a visible terminal. */
export async function setupLocalModel(model: string): Promise<void> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  await invoke('setup_local_model', { model });
}

/** Open an external URL via the OS default browser (web: new tab). */
export async function openExternal(url: string): Promise<void> {
  if (!tauriAvailable()) {
    if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener');
    return;
  }
  const invoke = await getInvoke();
  await invoke('open_external', { url });
}

/** Default workspace folder name created when no workspace is selected. */
export const DEFAULT_WORKSPACE_DIR_NAME = 'FreeUltraCode';

/** Detect the current platform from the browser/runtime (best-effort). */
function currentPlatform(): CliPlatform {
  const platform =
    typeof navigator === 'undefined' ? '' : navigator.platform.toLowerCase();
  if (platform.includes('win')) return 'windows';
  if (platform.includes('mac')) return 'macos';
  return 'linux';
}

/**
 * Resolve a sensible default workspace path for the host OS and create the
 * directory on disk (Tauri only). Used when the user starts a new session
 * without having selected any workspace folder.
 *
 * - Windows: `C:\FreeUltraCode`
 * - macOS / Linux: `<home>/FreeUltraCode`
 *
 * Returns the absolute path, or null when running outside the desktop shell
 * or when the directory could not be created.
 */
export async function ensureDefaultWorkspaceDir(): Promise<string | null> {
  if (!tauriAvailable()) return null;
  try {
    let target: string;
    if (currentPlatform() === 'windows') {
      target = `C:\\${DEFAULT_WORKSPACE_DIR_NAME}`;
    } else {
      const { homeDir, join } = await import('@tauri-apps/api/path');
      const home = await homeDir();
      target = await join(home, DEFAULT_WORKSPACE_DIR_NAME);
    }
    const { exists, mkdir } = await import('@tauri-apps/plugin-fs');
    if (!(await exists(target))) {
      await mkdir(target, { recursive: true });
    }
    return target;
  } catch {
    return null;
  }
}

/** Open a local directory in the OS file browser. Desktop-only. */
export async function openWorkspaceDirectory(path: string): Promise<boolean> {
  if (!tauriAvailable()) return false;
  try {
    const invoke = await getInvoke();
    await invoke('open_workspace_directory', { path });
    return true;
  } catch {
    return false;
  }
}

/** List one workspace directory for the right-side project tree. Desktop-only. */
export async function listWorkspaceDirectory(
  rootPath: string,
  relativePath = '',
): Promise<WorkspaceDirectoryListing> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<WorkspaceDirectoryListing>('list_workspace_dir', {
    rootPath,
    relativePath,
  });
}

/** Detect game-engine project metadata and project-local skill roots. */
export async function scanProjectEnvironment(
  rootPath: string,
): Promise<ProjectEnvironmentScan> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<ProjectEnvironmentScan>('project_environment_scan', { rootPath });
}

/** Probe one project MCP server with initialize + tools/list. */
export async function probeProjectMcpServer(
  rootPath: string,
  server: ProjectMcpProbeServerConfig,
): Promise<ProjectMcpProbeResult> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<ProjectMcpProbeResult>('project_mcp_probe', {
    rootPath,
    server,
  });
}

/** Probe whether an LSP server command is available locally. */
export async function probeProjectLspServer(
  server: ProjectLspProbeServerConfig,
): Promise<ProjectLspProbeResult> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<ProjectLspProbeResult>('project_lsp_probe', { server });
}

/** Install one catalog-backed LSP server by running a structured installer command. */
export async function installProjectLspServer(
  request: ProjectLspInstallRequest,
): Promise<ProjectLspInstallResult> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<ProjectLspInstallResult>('project_lsp_install', { request });
}

/**
 * Ensure the pinned Unreal MCP binary (ue-mcp-for-all-versions) is downloaded
 * into the global tools cache and sha256-verified. Idempotent: returns the
 * cached binary when it is already present and valid. Desktop + Windows only.
 */
export async function ueMcpEnsureBinary(): Promise<UeMcpBinaryStatus> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<UeMcpBinaryStatus>('ue_mcp_ensure_binary');
}

/**
 * Run the UE MCP binary's one-click `--setup-project`: enables RemoteControl /
 * Python plugins, writes the engine-version-correct RemoteControl config, and
 * (unless disabled) merges the project `.mcp.json`. Returns the parsed report.
 */
export async function ueMcpSetupProject(
  request: UeMcpSetupRequest,
): Promise<UeMcpSetupResult> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<UeMcpSetupResult>('ue_mcp_setup_project', { request });
}

/** Ensure this session has a filesystem baseline. No VCS dependency. */
export async function ensureWorkspaceChangesBaseline(
  rootPath: string,
  cacheKey: string,
  baselineAtMs?: number | null,
): Promise<WorkspaceChangeBaseline> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<WorkspaceChangeBaseline>('workspace_changes_baseline', {
    rootPath,
    cacheKey,
    baselineAtMs,
  });
}

/** Read changed lines since this session's filesystem baseline. */
export async function listWorkspaceChanges(
  rootPath: string,
  cacheKey: string,
  baselineAtMs?: number | null,
): Promise<WorkspaceChanges> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<WorkspaceChanges>('workspace_changes', {
    rootPath,
    cacheKey,
    baselineAtMs,
  });
}

/** Read lightweight VCS status for project-tree icon overlays. No diff hunks. */
export async function listWorkspaceVcsStatus(
  rootPath: string,
): Promise<WorkspaceChanges> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<WorkspaceChanges>('workspace_vcs_status', {
    rootPath,
  });
}

/** Read root-level VCS status first so project-tree overlays can update incrementally. */
export async function listWorkspaceVcsStatusShallow(
  rootPath: string,
): Promise<WorkspaceChanges> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<WorkspaceChanges>('workspace_vcs_status_shallow', {
    rootPath,
  });
}

/** Read the last persisted session-change snapshot without rescanning files. */
export async function readWorkspaceChangesCache(
  rootPath: string,
  cacheKey: string,
): Promise<WorkspaceChanges | null> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<WorkspaceChanges | null>('workspace_changes_cached', {
    rootPath,
    cacheKey,
  });
}

/** Read the last cached full VCS status snapshot so icons render instantly. */
export async function readWorkspaceVcsStatusCache(
  rootPath: string,
  cacheKey: string,
): Promise<WorkspaceChanges | null> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<WorkspaceChanges | null>('workspace_vcs_status_cached', {
    rootPath,
    cacheKey,
  });
}

/** Queue a background full VCS scan; progress arrives via onWorkspaceVcsScanProgress. */
export async function startWorkspaceVcsStatusScan(
  rootPath: string,
  cacheKey: string,
): Promise<void> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  await invoke('workspace_vcs_status_scan', { rootPath, cacheKey });
}

export interface WorkspaceVcsScanProgress {
  rootPath: string;
  phase: 'scanning' | 'done' | 'error' | string;
  scannedSpecs: number;
  foundItems: number;
  truncated: boolean;
  message?: string | null;
}

/** Subscribe to background VCS scan progress events. */
export async function onWorkspaceVcsScanProgress(
  cb: (progress: WorkspaceVcsScanProgress) => void,
): Promise<UnlistenFn> {
  if (!tauriAvailable()) return () => {};
  const listen = await getListen();
  return listen<WorkspaceVcsScanProgress>(
    'workspace-vcs-scan-progress',
    (event) => cb(event.payload),
  );
}

/** Read a local file for the in-app right-side preview drawer. Desktop-only. */
export async function previewLocalFile(
  path: string,
  opts?: { cwd?: string },
): Promise<LocalFilePreview> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<LocalFilePreview>('preview_local_file', {
    path,
    cwd: opts?.cwd ?? null,
  });
}

/** Persist a pasted clipboard image and return the local path inserted in composer. */
export async function saveClipboardImage(
  request: ClipboardImageSaveRequest,
): Promise<string> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<string>('save_clipboard_image', {
    bytesBase64: request.bytesBase64,
    mime: request.mime,
    fileName: request.fileName ?? null,
    cwd: request.cwd ?? null,
  });
}

/** Persist a generated session screenshot/GIF and return its local preview path. */
export async function saveSessionCapture(
  request: SessionCaptureSaveRequest,
): Promise<string> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<string>('save_session_capture', {
    bytesBase64: request.bytesBase64,
    mime: request.mime,
    fileName: request.fileName ?? null,
    cwd: request.cwd ?? null,
  });
}

/** Fetch a remote chat image through the desktop backend and return a data URL. */
export async function fetchCaptureImageDataUrl(url: string): Promise<string> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<string>('fetch_capture_image_data_url', { url });
}

/** Fetch a remote 3D model through the desktop backend and return a data URL. */
export async function fetchModelAssetDataUrl(url: string): Promise<string> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<string>('fetch_model_asset_data_url', { url });
}

/** Read a local 3D model through the desktop backend and return a data URL. */
export async function readModelAssetDataUrl(
  path: string,
  opts?: { cwd?: string },
): Promise<string> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<string>('read_model_asset_data_url', {
    path,
    cwd: opts?.cwd ?? null,
  });
}

/** Download a remote 3D model into the workspace cache. */
export async function downloadModelAsset(
  url: string,
  opts?: { cwd?: string; fileName?: string },
): Promise<ModelAssetDownload> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<ModelAssetDownload>('download_model_asset', {
    url,
    cwd: opts?.cwd ?? null,
    fileName: opts?.fileName ?? null,
  });
}

/** Best-effort cancellation for an in-flight local agent CLI invocation. */
export async function cancelAiCli(runId: string): Promise<void> {
  if (!tauriAvailable()) return;
  const invoke = await getInvoke();
  await invoke('cancel_ai_cli', { runId });
}

/**
 * Run an emitted script through the given CLI adapter (claude-code/codex/
 * gemini). Returns a combined stdout/stderr summary string. Throws
 * Error('NO_BACKEND') outside the desktop shell.
 */
export async function runWorkflow(
  script: string,
  adapter: string,
  cliCommand?: string,
): Promise<string> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<string>('run_workflow', {
    script,
    adapter,
    cliCommand: cliCommand ?? null,
    shell: runShellPayload(),
  });
}

/** Execute `/ultracode <task>` through the bundled CLI dynamic harness. */
export async function runUltracode(
  task: string,
  opts: UltracodeRunOptions = {},
): Promise<UltracodeRunResult> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  __cliSeq += 1;
  const runId = opts.runId ?? `ultracode_${Date.now()}_${__cliSeq}`;

  let unlisten: UnlistenFn | undefined;
  const progressBatcher = opts.onProgress
    ? createProgressBatcher(opts.onProgress)
    : null;
  if (opts.onProgress) {
    const listen = await getListen();
    unlisten = await listen<{ runId: string; text: string }>(
      'ai-cli-progress',
      (event) => {
        if (event.payload?.runId === runId) {
          progressBatcher?.push(event.payload.text);
        }
      },
    );
  }

  try {
    const invoke = await getInvoke();
    return await invoke<UltracodeRunResult>('run_ultracode', {
      task,
      cwd: opts.cwd ?? null,
      extraWorkspacePaths: opts.extraWorkspacePaths ?? [],
      adapter: opts.adapter ?? null,
      model: opts.model ?? null,
      provider: opts.provider ?? null,
      concurrency: opts.concurrency ?? null,
      maxRetries: opts.maxRetries ?? null,
      maxAgentCalls: opts.maxAgentCalls ?? null,
      maxRounds: opts.maxRounds ?? null,
      verifyCommand: opts.verifyCommand ?? null,
      timeoutSeconds: opts.timeoutSeconds ?? null,
      runId,
      resume: opts.resume ?? null,
      plannerOnly: opts.plannerOnly ?? null,
      fromHarness: opts.fromHarness ?? null,
      trace: opts.trace ?? null,
      interactive: opts.interactive ?? null,
    });
  } finally {
    try {
      progressBatcher?.flush();
    } finally {
      unlisten?.();
    }
  }
}

/** Read cached slash command / skill catalog. Scan runs in backend startup thread. */
export async function slashCatalog(): Promise<SlashCatalogSnapshot> {
  if (!tauriAvailable()) {
    return { scannedAtMs: 0, ready: true, entries: [] };
  }
  const invoke = await getInvoke();
  return invoke<SlashCatalogSnapshot>('slash_catalog');
}

/** Force a desktop backend slash command / skill rescan. */
export async function refreshSlashCatalog(): Promise<SlashCatalogSnapshot> {
  if (!tauriAvailable()) {
    return { scannedAtMs: Date.now(), ready: true, entries: [] };
  }
  const invoke = await getInvoke();
  return invoke<SlashCatalogSnapshot>('refresh_slash_catalog');
}

/** List supported skill installation targets. Desktop-only. */
export async function skillInstallTargets(
  projectRoot?: string | null,
): Promise<SkillInstallTarget[]> {
  if (!tauriAvailable()) {
    return [];
  }
  const invoke = await getInvoke();
  return invoke<SkillInstallTarget[]>('skill_install_targets', {
    projectRoot: projectRoot ?? null,
  });
}

/** Download a SKILL.md into a local skill root and refresh the slash catalog. */
export async function installSkillFromUrl(params: {
  url: string;
  name: string;
  slug: string;
  targetId: string;
  overwrite?: boolean;
  sourceUrl?: string | null;
  projectRoot?: string | null;
}): Promise<InstalledSkill> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<InstalledSkill>('install_skill_from_url', {
    url: params.url,
    name: params.name,
    slug: params.slug,
    targetId: params.targetId,
    overwrite: params.overwrite ?? false,
    sourceUrl: params.sourceUrl ?? null,
    projectRoot: params.projectRoot ?? null,
  });
}

/** Scan PATH for supported local model CLIs. Desktop-only. */
export async function scanModelClis(): Promise<ModelCliScanResult> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<ModelCliScanResult>('scan_model_clis');
}

/** Validate a user-selected CLI executable path. Desktop-only. */
export async function validateCliPath(path: string): Promise<CliPathValidation> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<CliPathValidation>('validate_cli_path', { path });
}

/**
 * Validate a user-selected *launch shell* executable path. Unlike
 * {@link validateCliPath} this intentionally ALLOWS shells (cmd/powershell/
 * sh/zsh/...), which the model-CLI validator rejects. Returns the normalized
 * absolute path. Desktop-only.
 */
export async function validateShellPath(path: string): Promise<string> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<string>('validate_shell_path', { path });
}

/** Provider runtime family recovered from cc-switch (maps to ProviderKind). */
export type ImportedProviderKind = 'anthropic' | 'codex' | 'gemini';

/** One provider recovered from the local cc-switch database. */
export interface ImportedProvider {
  /** Runtime family: claude rows → 'anthropic', plus 'codex' / 'gemini'. */
  kind: ImportedProviderKind;
  name: string;
  apiKey: string;
  baseUrl: string;
  model?: string;
  /** The cc-switch row id (used to match the active one). */
  ccId: string;
}

/** Currently-active cc-switch provider id per runtime family. */
export interface CcSwitchActivePointers {
  anthropic?: string;
  codex?: string;
  gemini?: string;
}

/** Result of importing providers from cc-switch. */
export interface CcSwitchImportResult {
  providers: ImportedProvider[];
  /** cc-switch row ids that are currently active there, per family. */
  active?: CcSwitchActivePointers;
}

/**
 * Import all supported providers (Claude / Codex / Gemini) from the local
 * cc-switch SQLite database.
 * Desktop-only: throws Error('NO_BACKEND') outside the Tauri shell.
 */
export async function importCcSwitchClaude(): Promise<CcSwitchImportResult> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  const json = await invoke<string>('import_cc_switch_claude');
  return JSON.parse(json) as CcSwitchImportResult;
}

/**
 * Subscribe to streamed log lines emitted during a run ('workflow-log').
 * No-op disposer when no backend is present.
 */
export async function onWorkflowLog(
  cb: (line: string) => void,
): Promise<UnlistenFn> {
  if (!tauriAvailable()) {
    return () => {};
  }
  const listen = await getListen();
  return listen<string>('workflow-log', (event) => cb(event.payload));
}

/**
 * Subscribe to per-node state updates during a run ('workflow-node').
 * No-op disposer when no backend is present.
 */
export async function onWorkflowNode(
  cb: (event: WorkflowNodeEvent) => void,
): Promise<UnlistenFn> {
  if (!tauriAvailable()) {
    return () => {};
  }
  const listen = await getListen();
  return listen<WorkflowNodeEvent>('workflow-node', (event) =>
    cb(event.payload),
  );
}

/** Subscribe to backend slash catalog refreshes. */
export async function onSlashCatalogUpdated(
  cb: (catalog: SlashCatalogSnapshot) => void,
): Promise<UnlistenFn> {
  if (!tauriAvailable()) {
    return () => {};
  }
  const listen = await getListen();
  return listen<SlashCatalogSnapshot>('slash-catalog-updated', (event) =>
    cb(event.payload),
  );
}

/**
 * Subscribe to the desktop-shell single-instance warning. Fired when the user
 * tries to launch a second app process and the existing one is reused instead.
 */
export async function onSingleInstanceWarning(
  cb: (message: string) => void,
): Promise<UnlistenFn> {
  if (!tauriAvailable()) {
    return () => {};
  }
  const listen = await getListen();
  return listen<string>('single-instance-warning', (event) =>
    cb(event.payload || '只能同时运行一个进程'),
  );
}

/**
 * Open a local file (or reveal it) in the OS default handler via the Tauri
 * opener plugin. Used by AI-message file chips. Resolves silently with `false`
 * outside the desktop shell or on failure, so the UI can degrade gracefully.
 *
 * Relative paths are resolved against `cwd` when provided (typically the run's
 * workspace folder). Line/column hints are accepted but only used when the OS
 * handler understands them (most editors ignore them via `open`).
 *
 * TRUST NOTE: the path here originates from AI output. `openPath` launches the
 * OS default handler, which for executable types (.exe/.bat/.ps1/.lnk/…) means
 * running a program. We therefore require an explicit user confirmation before
 * opening anything with an executable extension; everything else (source,
 * config, docs) opens directly. `reveal` (show in folder) is always safe.
 */
const EXECUTABLE_EXT = new Set([
  'exe', 'bat', 'cmd', 'com', 'ps1', 'psm1', 'vbs', 'js', 'jse', 'wsf', 'wsh',
  'scr', 'msi', 'msp', 'reg', 'lnk', 'url', 'inf', 'cpl', 'jar', 'app',
  'command', 'desktop', 'sh', 'bash', 'zsh', 'fish', 'run', 'bin', 'appimage',
]);

function executableCheckPath(p: string): string {
  const queryOrHash = p.search(/[?#]/);
  let base = (queryOrHash >= 0 ? p.slice(0, queryOrHash) : p).replace(
    /[\\/]+$/,
    '',
  );
  const lineHint = /^(.*?):\d+(?::\d+)?$/.exec(base);
  if (lineHint?.[1] && !/^[A-Za-z]$/.test(lineHint[1])) {
    base = lineHint[1];
  }
  return base;
}

export function executableExtensionOf(p: string): string | null {
  const base = executableCheckPath(p);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  return EXECUTABLE_EXT.has(ext) ? ext : null;
}

export async function openLocalPath(
  path: string,
  opts?: { cwd?: string; reveal?: boolean },
): Promise<boolean> {
  if (!tauriAvailable()) return false;
  try {
    const resolved = await resolveAgainstCwd(path, opts?.cwd);
    const reveal = opts?.reveal === true;

    // Guard one-click execution of AI-supplied executables. Reveal-in-folder is
    // never an execution, so it skips the prompt.
    if (!reveal) {
      const ext = executableExtensionOf(resolved);
      if (ext) {
        const ok =
          typeof window !== 'undefined' &&
          window.confirm(
            `即将用系统默认程序打开一个可执行文件（.${ext}）：\n${resolved}\n\n该路径来自 AI 输出，打开可能会运行程序。确定继续？`,
          );
        if (!ok) return false;
      }
    }

    const { openPath, revealItemInDir } = await import(
      '@tauri-apps/plugin-opener'
    );
    if (reveal) await revealItemInDir(resolved);
    else await openPath(resolved);
    return true;
  } catch {
    return false;
  }
}

/** Join a relative path onto cwd using the Tauri path API; absolute paths pass through. */
async function resolveAgainstCwd(path: string, cwd?: string): Promise<string> {
  // Absolute: drive-letter (C:\), POSIX root (/), UNC (\\server), or a home/env
  // prefix the user clearly means literally (~/, $HOME/…).
  const isAbsolute =
    /^(?:[A-Za-z]:[/\\]|[/\\]|\\\\|~[/\\]|\$\w+[/\\])/.test(path);
  if (isAbsolute || !cwd) return path;
  try {
    const { join } = await import('@tauri-apps/api/path');
    return await join(cwd, path);
  } catch {
    return path;
  }
}
