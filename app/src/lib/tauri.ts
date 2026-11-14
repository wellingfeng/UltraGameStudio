import type { IRGraph } from '@/core/ir';
import type { SkillLearningConfig, SkillNativeToolEvent, SkillOrigin } from '@/runtime/skills/types';
import type {
  WorkspaceDirectoryListing,
} from '@ugs/protocol';
import { runShellPayload } from '@/lib/shellConfig';
import {
  markAssetDone,
  markDownloadDone,
  markDownloadFailed,
  registerAsset,
  startDownload,
  type AssetKind,
  type AssetOrigin,
  type AssetSource,
} from '@/lib/downloadRegistry';

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

/** Version-check status for one of the supported model CLIs (claude/codex/gemini). */
export interface CliVersionStatus {
  adapter: string;
  label: string;
  executablePath?: string | null;
  installedVersion?: string | null;
  latestVersion?: string | null;
  updateAvailable: boolean;
  checkedAtMs: number;
  error?: string | null;
  /** True when the CLI is missing but can be one-click installed via npm. */
  installable?: boolean;
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

export interface SkillUninstallResult {
  targetId: string;
  slug: string;
  path: string;
  removed: boolean;
}

export interface CapabilityTranslateTargetResult {
  agent: string;
  label: string;
  ok: boolean;
  path?: string | null;
  message: string;
}

export interface CapabilityTranslateResult {
  kind: string;
  results: CapabilityTranslateTargetResult[];
}

export interface CapabilityTranslateRequest {
  kind: 'skill' | 'mcp' | 'lsp';
  projectRoot?: string | null;
  targets: string[];
  overwrite?: boolean;
  name?: string | null;
  slug?: string | null;
  text?: string | null;
  sourcePath?: string | null;
  servers?: unknown[];
}

export interface StudioRunOptions {
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

export interface StudioRunResult {
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
  kind: 'text' | 'image' | 'video' | 'binary' | 'document' | 'office';
  mime?: string | null;
  sizeBytes: number;
  truncated: boolean;
  text?: string | null;
  base64?: string | null;
  /** Absolute path to hand to `convertFileSrc` when the preview streams the
   *  file itself instead of inlining bytes (image / video / PDF / Office / HTML).
   *  Absent only for small inline payloads such as SVG. */
  streamPath?: string | null;
  /** Slide (PPTX) or sheet (XLSX) count for paged formats. */
  pageCount?: number | null;
}

export interface OfficePreviewPage {
  index: number;
  html: string;
}

export interface OfficePreview {
  kind: string;
  pageCount: number;
  pages: OfficePreviewPage[];
  truncated: boolean;
}

export interface ImageThumbnail {
  base64: string;
  mime: string;
  width: number;
  height: number;
}

export interface KnowledgeBaseScanSource {
  path: string;
  kind?: 'file' | 'folder' | null;
  enabled?: boolean | null;
}

export interface KnowledgeBaseScannedFile {
  path: string;
  sizeBytes: number;
  modifiedAtMs?: number | null;
  text: string;
  truncated: boolean;
}

export interface KnowledgeBaseScanResult {
  files: KnowledgeBaseScannedFile[];
  skippedFiles: number;
  skippedDirs: number;
  totalBytes: number;
  truncated: boolean;
  errors: string[];
}

export type {
  WorkspaceDirectoryListing,
  WorkspaceTreeEntry,
} from '@ugs/protocol';

/**
 * Result of preparing an isolated working directory for a "worktree"-mode
 * session. `kind` is 'worktree' for git repos (a fresh branch under .worktree/)
 * or 'copy' for non-git folders (a lean recursive copy under the global tmp).
 */
export interface IsolatedWorkspace {
  path: string;
  kind: 'worktree' | 'copy';
  branch?: string | null;
}

export type ProjectEngineKind = 'unreal' | 'unity' | 'godot' | 'cocos' | 'unknown';

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
  url?: string | null;
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
  headers?: Record<string, string>;
}

export interface ProjectMcpProbeResult {
  serverId: string;
  ok: boolean;
  status: string;
  message: string;
  toolsCount?: number | null;
  checkedAtMs: number;
  tools?: import('./tools/types').McpToolDefinition[];
  catalogCoverage?: 'full' | 'unknown';
  protocolVersion?: string | null;
  serverInfo?: Record<string, unknown> | null;
  capabilities?: Record<string, unknown> | null;
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
export const UNITY_MCP_SERVER_ID = 'unity-mcp';
export const GODOT_MCP_SERVER_ID = 'godot-mcp';
export const COCOS_MCP_SERVER_ID = 'cocos-mcp-server';

export interface UnityMcpSetupRequest {
  rootPath: string;
  writeManifest?: boolean;
  writeMcpConfig?: boolean;
  dryRun?: boolean;
}

export interface UnityMcpSetupResult {
  ok: boolean;
  changed: boolean;
  dryRun: boolean;
  packageId: string;
  packageUrl: string;
  configuredFiles: string[];
  changedFiles: string[];
  notes: string[];
  warnings: string[];
  error?: string | null;
  serverCommand: string;
  serverArgs: string[];
}

export interface GenericProjectMcpSetupRequest {
  rootPath: string;
  dryRun?: boolean;
}

export interface GenericProjectMcpSetupResult {
  ok: boolean;
  changed: boolean;
  dryRun: boolean;
  serverId: string;
  label: string;
  description: string;
  transport: 'stdio' | 'streamable-http' | string;
  serverCommand?: string | null;
  serverArgs: string[];
  serverUrl?: string | null;
  configuredFiles: string[];
  changedFiles: string[];
  notes: string[];
  warnings: string[];
  error?: string | null;
}

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

export interface P4PendingListCollectResult {
  rootPath: string;
  requestedCount: number;
  openedCount: number;
  stdout: string;
  stderr: string;
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

/** Result of persisting a model-generated asset into the workspace cache. */
export interface GeneratedAssetSave {
  path: string;
  sizeBytes: number;
  fileName: string;
}

export interface CachedAssetFile {
  kind: AssetKind;
  source: AssetSource;
  origin: AssetOrigin;
  title: string;
  localPath: string;
  sizeBytes: number;
  createdAtMs?: number | null;
  modifiedAtMs?: number | null;
}

export interface ClipboardImageSaveRequest {
  bytesBase64: string;
  mime: string;
  fileName?: string | null;
  cwd?: string | null;
}

export interface LocalFileUploadPayload {
  bytesBase64: string;
  fileName: string;
  mime?: string | null;
  sizeBytes: number;
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

export interface CodexCatalogModel {
  id: string;
  description: string;
  reasoningEfforts: string[];
  reasoningEffortDescriptions?: Record<string, string>;
  providerId?: string;
}

export async function listZcodeModels(cwd: string, cliCommand?: string): Promise<CodexCatalogModel[]> {
  if (!tauriAvailable()) throw new Error('NO_BACKEND');
  const invoke = await getInvoke();
  return invoke<CodexCatalogModel[]>('list_zcode_models', { cwd, cliCommand: cliCommand ?? null });
}

export async function listCodexModels(cliCommand?: string): Promise<CodexCatalogModel[]> {
  if (!tauriAvailable()) throw new Error('NO_BACKEND');
  const invoke = await getInvoke();
  return invoke<CodexCatalogModel[]>('list_codex_models', {
    cliCommand: cliCommand ?? null,
    shell: runShellPayload(),
  });
}

export interface CloudflareImageRequest {
  accountId: string;
  apiKey: string;
  model: string;
  prompt: string;
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
  kind?: 'success' | 'error' | 'waitingInput';
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

/** Save the full session snapshot for a fresh CLI to review. */
export async function saveSessionHandoffSnapshot(cwd: string, snapshot: string): Promise<{ snapshotPath: string; summaryPath: string }> {
  if (!tauriAvailable()) throw new Error('NO_BACKEND');
  const invoke = await getInvoke();
  return invoke('save_session_handoff_snapshot', { cwd, snapshot });
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
    kind: input.kind ?? 'success',
  });
}

/** Dismiss the native desktop notification for a session waiting on input. */
export async function dismissSessionWaitingInputNotificationDesktop(
  input: SessionNotificationClickPayload,
): Promise<boolean> {
  if (!tauriAvailable()) return false;
  const invoke = await getInvoke();
  return invoke<boolean>('dismiss_session_waiting_input_notification', {
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
export interface NativeCliSkillToolsOptions {
  /** Frozen persisted source message, distinct from this CLI child run. */
  source: SkillOrigin;
  config: Pick<SkillLearningConfig, 'enabled' | 'mode'>;
  /** Failed persistence never grants native filesystem authority. */
  ready?: Promise<void>;
}

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
  /** Per-call no-progress timeout override, in seconds. 0 disables the idle watchdog. */
  idleTimeoutSeconds?: number;
  /** Stable id used to stream progress and cancel the process from the UI. */
  runId?: string;
  /** Live progress callback — receives streamed text/tool-use chunks. */
  onProgress?: (text: string) => void;
  /** Raw model usage payload emitted by supported CLI adapters. */
  onUsage?: (usage: unknown) => void;
  /** Independent, bounded native-tool evidence; never parsed from UI text. */
  onTool?: (event: SkillNativeToolEvent) => void;
  /** Foreground-only scoped Rust skill tools; never a review capsule. */
  skillTools?: NativeCliSkillToolsOptions;
  signal?: AbortSignal;
  /**
   * Claude session id for context continuity (claude adapter only). With
   * `resume: false` the call creates this session; with `resume: true` it
   * continues it, inheriting the earlier call's warm context.
   */
  sessionId?: string;
  /** Continue `sessionId` instead of creating it. */
  resume?: boolean;
  /**
   * Short language-enforcement directive (see `languageDirectiveReminder` in
   * `lib/i18n.ts`). For the claude adapter the backend injects this via
   * `--append-system-prompt` (real system-role authority, resent every
   * turn); codex/gemini have no such flag, so it is appended at the very end
   * of the stdin prompt instead, right after the user's question.
   */
  languageDirective?: string;
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
  const skillTools = opts.skillTools ? {
    source: { ...opts.skillTools.source }, enabled: opts.skillTools.config.enabled,
    mode: opts.skillTools.config.mode,
  } : null;
  const skillReady = opts.skillTools?.ready;

  /** Raw native identity stays distinct from the frontend invocation correlation. */
  type NativeCliEnvelope = SkillNativeToolEvent & {
    requestRunId?: string;
    sourceOrigin?: SkillOrigin;
  };
  const matchesNativeEvent = (event: NativeCliEnvelope): boolean => {
    if (event.requestRunId !== undefined) {
      if (!skillTools || event.requestRunId !== runId || !event.sourceOrigin) return false;
      return (['hostId', 'workspaceId', 'sessionId', 'turnId', 'runId', 'cwd'] as const)
        .every((key) => event.sourceOrigin![key] === skillTools.source[key]);
    }
    return event.runId === runId;
  };

  // Subscribe to per-run progress events (best-effort; the final result is
  // returned regardless of whether any progress chunks arrive).
  const unlisteners: UnlistenFn[] = [];
  const progressBatcher = opts.onProgress
    ? createProgressBatcher(opts.onProgress)
    : null;
  let cancelDispatched: (() => void) | undefined;
  let nativeDispatched = false;
  let cancelledNative = false;
  try {
    if (opts.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    if (skillTools) await waitForHttpBudget(() => Promise.resolve(skillReady), opts.signal, undefined);
    if (opts.onProgress || opts.onUsage || opts.onTool) {
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
                opts.onUsage!(event.payload.usage);
              }
            },
          ),
        );
      }
      if (opts.onTool) {
        unlisteners.push(
          await listen<NativeCliEnvelope>('ugs-cli-tool', (event) => {
            if (event.payload && matchesNativeEvent(event.payload)) opts.onTool!(event.payload);
          }),
        );
      }
    }

    const invoke = await getInvoke();
    cancelDispatched = () => {
      if (!nativeDispatched || cancelledNative) return;
      cancelledNative = true;
      // Rust revokes the scoped dispatcher before killing its child. The IPC
      // call can reject during shutdown; cancellation must still settle JS.
      try { void invoke('cancel_ai_cli', { runId }).catch(() => {}); } catch { /* best effort */ }
    };
    opts.signal?.addEventListener('abort', cancelDispatched, { once: true });
    const result = await waitForHttpBudget(() => {
      nativeDispatched = true;
      return invoke<string | AiCliResult>('ai_cli', {
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
      skillTools,
      sessionId: opts.sessionId ?? null,
      resume: opts.resume ?? null,
      languageDirective: opts.languageDirective ?? null,
      shell: runShellPayload(),
      });
    }, opts.signal, undefined);
    if (isAiCliResult(result)) {
      if (result.usage != null) {
        opts.onUsage?.(result.usage);
      }
      return result.text;
    }
    return result;
  } finally {
    if (cancelDispatched) opts.signal?.removeEventListener('abort', cancelDispatched);
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
  if (Array.isArray(record.result)) record.result.forEach(visitModel);
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

/** Generate a Cloudflare Workers AI image through the desktop backend to avoid WebView CORS. */
export async function generateCloudflareImage(
  request: CloudflareImageRequest,
): Promise<string> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<string>('generate_cloudflare_image', {
    accountId: request.accountId,
    apiKey: request.apiKey,
    model: request.model,
    prompt: request.prompt,
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

/** Known ComfyUI one-click model profiles (must match the installer script + Rust validator). */
export type ComfyUiSetupModel = 'sd1.5' | 'sdxl-turbo' | 'flux-schnell';

/**
 * Kick off the one-click ComfyUI install: downloads the official Windows
 * portable runtime, extracts it, optionally pulls a default checkpoint, and
 * launches the server on 127.0.0.1:8188. Windows desktop only.
 */
export async function setupComfyui(
  model?: ComfyUiSetupModel,
  skipModel = false,
): Promise<void> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  await invoke('setup_comfyui', { model: model ?? null, skipModel });
  // The installer runs fire-and-forget in a terminal and launches the server on
  // 127.0.0.1:8188, so there is no on-disk path to track. Surface it in the
  // Asset Hub as an installed local tool with its server endpoint as "source".
  registerAsset({
    kind: 'plugin',
    source: 'installed',
    origin: 'local',
    title: model ? `ComfyUI · ${model}` : 'ComfyUI',
    status: 'success',
    remoteUrl: 'http://127.0.0.1:8188',
    provider: 'ComfyUI',
    meta: { model: model ?? null, skipModel },
  });
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
export const DEFAULT_WORKSPACE_DIR_NAME = 'UltraGameStudio';

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
 * - Windows: `C:\UltraGameStudio`
 * - macOS / Linux: `<home>/UltraGameStudio`
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

/**
 * Prepare an isolated working directory for a session started in "worktree"
 * mode. Git repos get a real `git worktree` on a fresh branch; other folders
 * get a lean recursive copy. Returns the path the CLI should use as its cwd.
 * Throws NO_BACKEND on web so callers can fall back to the original workspace.
 */
export async function prepareIsolatedWorkspace(
  rootPath: string,
  sessionId: string,
): Promise<IsolatedWorkspace> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<IsolatedWorkspace>('prepare_isolated_workspace', {
    rootPath,
    sessionId,
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
  requestId?: string,
): Promise<ProjectMcpProbeResult> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<ProjectMcpProbeResult>('project_mcp_probe', { rootPath, server, requestId });
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
  const result = await invoke<ProjectLspInstallResult>('project_lsp_install', {
    request,
  });
  // Record successful LSP installs in the Asset Hub as installed plugins.
  if (result.ok) {
    registerAsset({
      kind: 'plugin',
      source: 'installed',
      origin: 'local',
      title: `LSP · ${result.serverId}`,
      status: 'success',
      provider: result.serverId,
      meta: {
        status: result.status,
        commandLine: result.commandLine ?? undefined,
        platform: result.platform,
      },
    });
  }
  return result;
}

/**
 * Configure a Unity project for wellingfeng/unity-mcp: add the Unity package
 * Git dependency, merge project `.mcp.json`, and return the stdio server config
 * the project settings UI should register.
 */
export async function unityMcpSetupProject(
  request: UnityMcpSetupRequest,
): Promise<UnityMcpSetupResult> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<UnityMcpSetupResult>('unity_mcp_setup_project', { request });
}

export interface BlueprintModeInstallRequest {
  rootPath: string;
  targetDir?: string | null;
  overwrite?: boolean;
}

export interface BlueprintModeTargetRequest {
  rootPath: string;
  targetDir?: string | null;
}

export interface BlueprintModeStatusResult {
  ok: boolean;
  sourceUrl: string;
  targetDir: string;
  exists: boolean;
  installed: boolean;
  upluginPath: string | null;
  versionName: string | null;
  notes: string[];
  warnings: string[];
  error: string | null;
}

export interface BlueprintModeInstallResult {
  ok: boolean;
  sourceUrl: string;
  targetDir: string;
  filesCopied: number;
  replacedExisting: boolean;
  notes: string[];
  warnings: string[];
  error: string | null;
}

export interface BlueprintModeUninstallResult {
  ok: boolean;
  targetDir: string;
  removed: boolean;
  notes: string[];
  warnings: string[];
  error: string | null;
}

export async function blueprintModeStatus(
  request: BlueprintModeTargetRequest,
): Promise<BlueprintModeStatusResult> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<BlueprintModeStatusResult>('blueprint_mode_status', { request });
}

/**
 * Install the Blueprint Mode UE editor plugin into the detected Unreal project
 * by downloading it from GitHub into `<project>/Plugins/`.
 */
export async function blueprintModeInstall(
  request: BlueprintModeInstallRequest,
): Promise<BlueprintModeInstallResult> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<BlueprintModeInstallResult>('blueprint_mode_install', { request });
}

export async function blueprintModeUninstall(
  request: BlueprintModeTargetRequest,
): Promise<BlueprintModeUninstallResult> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<BlueprintModeUninstallResult>('blueprint_mode_uninstall', { request });
}

export async function godotMcpSetupProject(
  request: GenericProjectMcpSetupRequest,
): Promise<GenericProjectMcpSetupResult> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<GenericProjectMcpSetupResult>('godot_mcp_setup_project', { request });
}

export async function cocosMcpSetupProject(
  request: GenericProjectMcpSetupRequest,
): Promise<GenericProjectMcpSetupResult> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<GenericProjectMcpSetupResult>('cocos_mcp_setup_project', { request });
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
  const status = await invoke<UeMcpBinaryStatus>('ue_mcp_ensure_binary');
  // Surface freshly downloaded MCP binaries in the Asset Hub. Already-cached
  // binaries (downloaded === false) are not re-registered to avoid duplicates.
  if (status.available && status.downloaded) {
    registerAsset({
      kind: 'mcp',
      source: 'installed',
      origin: 'local',
      title: `${status.serverId} ${status.version}`.trim(),
      status: 'success',
      localPath: status.path,
      provider: status.serverId,
      remoteUrl: status.source || undefined,
      meta: { sha256: status.sha256, version: status.version },
    });
  }
  return status;
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

/** Read VCS line-level diff for one file. Returns null when no VCS diff exists. */
export async function workspaceFileDiff(
  rootPath: string,
  path: string,
): Promise<WorkspaceChangeFile | null> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<WorkspaceChangeFile | null>('workspace_file_diff', {
    rootPath,
    path,
  });
}

export async function collectWorkspacePathsToP4PendingList(
  rootPath: string,
  paths: string[],
): Promise<P4PendingListCollectResult> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<P4PendingListCollectResult>('p4_collect_to_pending_list', {
    rootPath,
    paths,
  });
}

export type LegacyBrandMigrationPhase =
  | 'checking'
  | 'scanning'
  | 'copying'
  | 'archiving'
  | 'done'
  | 'skipped'
  | 'error'
  | string;

export interface LegacyBrandMigrationProgress {
  phase: LegacyBrandMigrationPhase;
  rootsTotal: number;
  rootsDone: number;
  filesTotal: number;
  filesDone: number;
  dirsTotal: number;
  dirsDone: number;
  copiedFiles: number;
  skippedFiles: number;
  archivedRoots: number;
  currentPath?: string | null;
  message?: string | null;
}

/** Run the one-time FreeUltraCode -> UltraGameStudio storage migration. */
export async function migrateLegacyBrandStorage(
  onProgress?: (progress: LegacyBrandMigrationProgress) => void,
): Promise<LegacyBrandMigrationProgress> {
  const fallback: LegacyBrandMigrationProgress = {
    phase: 'skipped',
    rootsTotal: 0,
    rootsDone: 0,
    filesTotal: 0,
    filesDone: 0,
    dirsTotal: 0,
    dirsDone: 0,
    copiedFiles: 0,
    skippedFiles: 0,
    archivedRoots: 0,
    message: '非桌面环境，跳过旧版配置迁移',
  };
  if (!tauriAvailable()) return fallback;

  const listen = await getListen();
  const unlisten = await listen<LegacyBrandMigrationProgress>(
    'legacy-brand-migration-progress',
    (event) => onProgress?.(event.payload),
  );

  try {
    const invoke = await getInvoke();
    const result = await invoke<LegacyBrandMigrationProgress>(
      'migrate_legacy_brand_storage',
    );
    onProgress?.(result);
    return result;
  } finally {
    unlisten();
  }
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

/**
 * 把本地文件所在目录加入 Tauri asset protocol scope，使 `convertFileSrc`
 * 生成的 URL 能加载（否则 403）。聊天 / md 预览里内嵌的本地图片显示前先调。
 * Desktop-only；纯浏览器环境抛 `NO_BACKEND`。
 */
export async function ensureLocalAssetScope(path: string): Promise<void> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  await invoke<void>('ensure_local_asset_scope', { path });
}

/** Paged read of a PPTX/XLSX. Only the leading `maxPages` slides/sheets are
 *  parsed, so preview cost stays flat regardless of document length. */
export async function previewOfficeDocument(
  path: string,
  opts?: { cwd?: string; maxPages?: number },
): Promise<OfficePreview> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<OfficePreview>('preview_office_document', {
    path,
    cwd: opts?.cwd ?? null,
    maxPages: opts?.maxPages ?? null,
  });
}

/** Downscaled JPEG for chat thumbnails. Decoding stops at `maxEdge` pixels, so
 *  a multi-megabyte screenshot never reaches the renderer at full size. */
export async function readImageThumbnail(
  path: string,
  opts?: { cwd?: string; maxEdge?: number },
): Promise<ImageThumbnail> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<ImageThumbnail>('read_image_thumbnail', {
    path,
    cwd: opts?.cwd ?? null,
    maxEdge: opts?.maxEdge ?? null,
  });
}

/** Check whether a local file exists. Desktop-only; mirrors preview_local_file
 *  path resolution (including cwd fallbacks) but is lightweight because it
 *  only stats the file. Uses the Rust backend so it is not restricted by the
 *  Tauri frontend fs plugin scope. */
export async function fileExists(
  path: string,
  opts?: { cwd?: string },
): Promise<boolean> {
  if (!tauriAvailable()) {
    return false;
  }
  const invoke = await getInvoke();
  return invoke<boolean>('file_exists', {
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

/** Read a user-selected local file so it can be uploaded to a remote workspace. */
export async function readLocalFileForUpload(
  path: string,
): Promise<LocalFileUploadPayload> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<LocalFileUploadPayload>('read_local_file_for_upload', { path });
}

/** Scan configured local files/folders and return decoded text for KB indexing. */
export async function scanKnowledgeBaseFiles(
  sources: KnowledgeBaseScanSource[],
): Promise<KnowledgeBaseScanResult> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<KnowledgeBaseScanResult>('knowledge_base_scan_files', { sources });
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
  opts?: {
    cwd?: string;
    fileName?: string;
    sessionId?: string;
    workspaceId?: string | null;
    messageId?: string;
    trackAssetId?: string;
  },
): Promise<ModelAssetDownload> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  // Surface the transfer in the Downloads panel. Tracking is best-effort and
  // must never change the function's success/failure contract.
  const trackId =
    opts?.trackAssetId ??
    startDownload({
      url,
      fileName: opts?.fileName,
      kind: 'model',
      sessionId: opts?.sessionId,
      workspaceId: opts?.workspaceId,
      messageId: opts?.messageId,
    });
  try {
    const result = await invoke<ModelAssetDownload>('download_model_asset', {
      url,
      cwd: opts?.cwd ?? null,
      fileName: opts?.fileName ?? null,
    });
    if (opts?.trackAssetId) {
      markAssetDone(trackId, {
        localPath: result.path,
        remoteUrl: url,
        sizeBytes: result.sizeBytes,
        title: opts.fileName,
      });
    } else {
      markDownloadDone(trackId, {
        path: result.path,
        sizeBytes: result.sizeBytes,
      });
    }
    return result;
  } catch (err) {
    markDownloadFailed(
      trackId,
      err instanceof Error ? err.message : String(err),
    );
    throw err;
  }
}

/**
 * Persist a model-generated asset (base64 bytes) into the workspace asset
 * cache and return its local path. Asset-Hub callers use this so generated
 * media (image/video/audio/sprite/mesh) survives a reload instead of living
 * only as an in-memory data URL.
 */
export async function saveGeneratedAsset(params: {
  bytesBase64: string;
  mime: string;
  kind: string;
  fileName?: string;
  cwd?: string;
}): Promise<GeneratedAssetSave> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<GeneratedAssetSave>('save_generated_asset', {
    bytesBase64: params.bytesBase64,
    mime: params.mime,
    kind: params.kind,
    fileName: params.fileName ?? null,
    cwd: params.cwd ?? null,
  });
}

/** List durable files in the workspace `.ultragamestudio` asset cache. */
export async function listCachedAssets(cwd?: string | null): Promise<CachedAssetFile[]> {
  if (!tauriAvailable()) return [];
  const invoke = await getInvoke();
  return invoke<CachedAssetFile[]>('list_cached_assets', {
    cwd: cwd ?? null,
  });
}

/**
 * One background job's manifest text + filesystem probe, as gathered by the
 * Rust `list_background_jobs` command. The pure `resolveJobStatus` in
 * `lib/backgroundJobs.ts` turns this into a running/success/failed decision.
 */
export interface BackgroundJobProbeRaw {
  fileStem: string;
  workspaceCwd: string | null;
  manifestJson: string;
  artifactExists: boolean;
  doneMarkerExists: boolean;
  failMarkerExists: boolean;
  pidAlive: boolean | null;
  progressTail: string | null;
  probedAtMs: number;
}

/** Probe every background-job manifest under a workspace's `jobs/` dir. */
export async function listBackgroundJobs(
  cwd?: string | null,
): Promise<BackgroundJobProbeRaw[]> {
  if (!tauriAvailable()) return [];
  const invoke = await getInvoke();
  return invoke<BackgroundJobProbeRaw[]>('list_background_jobs', {
    cwd: cwd ?? null,
  });
}

/** Delete a terminal job's manifest so it stops being re-probed. */
export async function removeBackgroundJob(
  cwd: string | null,
  fileStem: string,
): Promise<void> {
  if (!tauriAvailable()) return;
  const invoke = await getInvoke();
  await invoke('remove_background_job', { cwd: cwd ?? null, fileStem });
}

export interface ManualCacheCleanupResult {
  filesRemoved: number;
  bytesFreed: number;
}

/**
 * Run a manual cache-retention sweep with an explicit retention window (days),
 * deleting stale cache files and unfavorited sessions older than that. Returns
 * null outside the desktop shell.
 */
export async function runManualCacheCleanup(
  retentionDays: number,
): Promise<ManualCacheCleanupResult | null> {
  if (!tauriAvailable()) return null;
  const invoke = await getInvoke();
  return invoke<ManualCacheCleanupResult>('manual_cache_cleanup', {
    retentionDays,
  });
}

export interface AutosaveRunResult {
  scannedWorkspaces: number;
  snapshottedWorkspaces: number;
  filesBackedUp: number;
  bytesWritten: number;
  errors: string[];
}

/**
 * Run a manual AutoSave pass immediately, snapshotting committed-but-changed
 * VCS files of every known workspace into `.ultragamestudio/autosave/`.
 * Returns null outside the desktop shell.
 */
export async function runAutosaveNow(): Promise<AutosaveRunResult | null> {
  if (!tauriAvailable()) return null;
  const invoke = await getInvoke();
  return invoke<AutosaveRunResult>('autosave_now');
}

/**
 * Absolute path to the bundled `ugs-job.mjs` background-job wrapper, or null
 * when it can't be located (or outside the desktop shell). The chat system
 * prompt uses this to tell the model exactly which script to wrap long-running
 * commands in.
 */
export async function ugsJobWrapperPath(): Promise<string | null> {
  if (!tauriAvailable()) return null;
  const invoke = await getInvoke();
  return invoke<string | null>('ugs_job_wrapper_path');
}

/** Best-effort cancellation for an in-flight local agent CLI invocation. */
export async function cancelAiCli(runId: string): Promise<void> {
  if (!tauriAvailable()) return;
  const invoke = await getInvoke();
  await invoke('cancel_ai_cli', { runId });
}

/** Whether this installed CLI and permission mode expose native steering. */
export async function aiCliSteerSupported(
  adapter: string,
  cliCommand: string | undefined,
  permission: string,
): Promise<boolean> {
  if (!tauriAvailable()) return false;
  const invoke = await getInvoke();
  return invoke<boolean>('ai_cli_steer_supported', {
    adapter,
    cliCommand: cliCommand ?? null,
    permission,
    shell: runShellPayload(),
  });
}

/** Append text to an in-flight CLI turn when its adapter exposes native steering. */
export async function steerAiCli(runId: string, text: string): Promise<boolean> {
  if (!tauriAvailable() || !text.trim()) return false;
  const invoke = await getInvoke();
  return invoke<boolean>('steer_ai_cli', { runId, text });
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

/** Execute `/studio <task>` through the bundled CLI dynamic harness. */
export async function runStudio(
  task: string,
  opts: StudioRunOptions = {},
): Promise<StudioRunResult> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  __cliSeq += 1;
  const runId = opts.runId ?? `studio_${Date.now()}_${__cliSeq}`;

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
    return await invoke<StudioRunResult>('run_studio', {
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
  const installed = await invoke<InstalledSkill>('install_skill_from_url', {
    url: params.url,
    name: params.name,
    slug: params.slug,
    targetId: params.targetId,
    overwrite: params.overwrite ?? false,
    sourceUrl: params.sourceUrl ?? null,
    projectRoot: params.projectRoot ?? null,
  });
  registerAsset({
    kind: 'skill',
    source: 'installed',
    origin: 'local',
    title: installed.name || installed.slug,
    status: 'success',
    localPath: installed.skillFile || installed.path,
    remoteUrl: installed.sourceUrl ?? params.sourceUrl ?? params.url,
    meta: { targetId: installed.targetId, slug: installed.slug },
  });
  return installed;
}

/** Download and extract a ZIP skill package into a local skill root. */
export async function installSkillFromZipUrl(params: {
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
  const installed = await invoke<InstalledSkill>('install_skill_from_zip_url', {
    url: params.url,
    name: params.name,
    slug: params.slug,
    targetId: params.targetId,
    overwrite: params.overwrite ?? false,
    sourceUrl: params.sourceUrl ?? null,
    projectRoot: params.projectRoot ?? null,
  });
  registerAsset({
    kind: 'skill',
    source: 'installed',
    origin: 'local',
    title: installed.name || installed.slug,
    status: 'success',
    localPath: installed.skillFile || installed.path,
    remoteUrl: installed.sourceUrl ?? params.sourceUrl ?? params.url,
    meta: { targetId: installed.targetId, slug: installed.slug },
  });
  return installed;
}

/** Write an app-curated SKILL.md into a local skill root and refresh the slash catalog. */
export async function installSkillFromText(params: {
  text: string;
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
  const installed = await invoke<InstalledSkill>('install_skill_from_text', {
    text: params.text,
    name: params.name,
    slug: params.slug,
    targetId: params.targetId,
    overwrite: params.overwrite ?? false,
    sourceUrl: params.sourceUrl ?? null,
    projectRoot: params.projectRoot ?? null,
  });
  registerAsset({
    kind: 'skill',
    source: 'installed',
    origin: 'local',
    title: installed.name || installed.slug,
    status: 'success',
    localPath: installed.skillFile || installed.path,
    remoteUrl: installed.sourceUrl ?? params.sourceUrl ?? undefined,
    meta: { targetId: installed.targetId, slug: installed.slug },
  });
  return installed;
}

/** Remove a locally installed skill folder from a supported install target. */
export async function uninstallSkill(params: {
  targetId: string;
  slug: string;
  projectRoot?: string | null;
}): Promise<SkillUninstallResult> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<SkillUninstallResult>('uninstall_skill', {
    targetId: params.targetId,
    slug: params.slug,
    projectRoot: params.projectRoot ?? null,
  });
}

/**
 * Translate a UGS capability (skill / MCP / LSP) into each target agent's native
 * format and write it offline. Desktop-only. Returns a per-agent result report.
 */
export async function translateCapability(
  request: CapabilityTranslateRequest,
): Promise<CapabilityTranslateResult> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<CapabilityTranslateResult>('translate_capability', {
    kind: request.kind,
    projectRoot: request.projectRoot ?? null,
    targets: request.targets,
    overwrite: request.overwrite ?? false,
    name: request.name ?? null,
    slug: request.slug ?? null,
    text: request.text ?? null,
    sourcePath: request.sourcePath ?? null,
    servers: request.servers ?? null,
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
 * Check installed vs. latest npm-registry version for claude/codex/gemini.
 * Latest-version lookups are cached ~12h on the Rust side. Desktop-only.
 */
export async function checkCliUpdates(): Promise<CliVersionStatus[]> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<CliVersionStatus[]>('check_cli_updates');
}

/**
 * Trigger a one-click update for a given adapter (`claude-code` | `codex` |
 * `gemini`): `claude update` / `codex update` natively, or
 * `npm install -g @google/gemini-cli@latest` for gemini (no native updater).
 * Resolves with the combined stdout/stderr log on success. Desktop-only.
 */
export async function updateCli(adapter: string, onStarted?: () => void): Promise<string> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const { invoke, Channel } = await import('@tauri-apps/api/core');
  const channel = new Channel<null>();
  channel.onmessage = () => onStarted?.();
  return invoke<string>('update_cli', { adapter, onStarted: channel });
}

/** Result of a manual "clean up now" cache sweep. */
export interface CacheCleanupReport {
  filesRemoved: number;
  bytesFreed: number;
}

/**
 * Run the retention sweep immediately (设置 > 通用 > 立即清理). Unlike the
 * startup pass it always runs, even when the startup toggle is off; the
 * optional `retentionDays` (the UI stepper value) sets the cutoff age.
 * Desktop-only; throws `NO_BACKEND` in the browser.
 */
export async function runCacheCleanupNow(
  retentionDays?: number,
): Promise<CacheCleanupReport> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<CacheCleanupReport>('run_cache_cleanup_now', {
    retentionDays: retentionDays ?? null,
  });
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

export interface EngineRevealResult {
  ok: boolean;
  /** unreal | unity | godot | cocos | unknown */
  engine: string;
  /** jumped | not_asset | engine_unreachable | unsupported | error */
  status: string;
  message: string;
}

/**
 * Try to reveal a file inside its running game editor. Today only Unreal is
 * wired to a real local channel (RemoteControl HTTP); Unity/Godot/Cocos return
 * an `unsupported` status the UI surfaces as a hint. Resolves with a clear
 * result object (never throws) so the caller can show an inline message.
 */
export async function engineRevealAsset(
  rootPath: string,
  filePath: string,
): Promise<EngineRevealResult> {
  if (!tauriAvailable()) {
    return {
      ok: false,
      engine: 'unknown',
      status: 'error',
      message: '当前浏览器模式不能在引擎中定位文件。请使用桌面端。',
    };
  }
  try {
    const invoke = await getInvoke();
    return (await invoke('engine_reveal_asset', {
      rootPath,
      filePath,
    })) as EngineRevealResult;
  } catch (err) {
    return {
      ok: false,
      engine: 'unknown',
      status: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * CORS-free `fetch` replacement.
 *
 * The Tauri WebView runs `fetch()` in a browser context, so cross-origin
 * upstreams that don't send `Access-Control-Allow-Origin` (many model / image
 * gateways) fail with an opaque `Failed to fetch`. In the desktop shell we
 * forward the request through Rust (`proxy_http`), which is not a browser
 * context and is not subject to CORS. Outside Tauri (plain browser / Vite dev)
 * we fall back to the native `fetch` unchanged.
 *
 * The wrapper accepts the subset of `fetch` we actually use across the asset
 * generators (method, headers, body, signal) and returns a standard `Response`,
 * so call sites can keep using `response.ok`, `.status`, `.text()`, `.json()`,
 * `.blob()`, `.arrayBuffer()`, and `.headers.get()` unchanged.
 */
interface ProxyHttpHeader {
  name: string;
  value: string;
}

interface ProxyHttpResponsePayload {
  status: number;
  statusText: string;
  headers: ProxyHttpHeader[];
  bodyBase64: string;
  url: string;
}

function normalizeHeaders(input?: HeadersInit): ProxyHttpHeader[] {
  const out: ProxyHttpHeader[] = [];
  if (!input) return out;
  if (input instanceof Headers) {
    input.forEach((value, name) => out.push({ name, value }));
  } else if (Array.isArray(input)) {
    for (const [name, value] of input) out.push({ name, value });
  } else {
    for (const [name, value] of Object.entries(input)) {
      out.push({ name, value: String(value) });
    }
  }
  return out;
}

async function bodyInitToBase64(body: BodyInit | null | undefined): Promise<string | null> {
  if (body == null) return null;
  let bytes: Uint8Array;
  if (typeof body === 'string') {
    bytes = new TextEncoder().encode(body);
  } else if (body instanceof ArrayBuffer) {
    bytes = new Uint8Array(body);
  } else if (ArrayBuffer.isView(body)) {
    bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  } else if (body instanceof Blob) {
    bytes = new Uint8Array(await body.arrayBuffer());
  } else if (body instanceof URLSearchParams) {
    bytes = new TextEncoder().encode(body.toString());
  } else {
    // FormData / ReadableStream are not used by the proxied call sites; encode
    // its string form as a last resort so we never silently drop a body.
    bytes = new TextEncoder().encode(String(body));
  }
  if (bytes.byteLength === 0) return null;
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  if (!base64) return new Uint8Array(0);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Optional hard limits; omitted options retain ordinary fetch semantics. */
export interface TauriFetchOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
}

async function nativeFetchWithBudget(
  input: string | URL | Request,
  init: RequestInit | undefined,
  timeoutMs: number | undefined,
  maxResponseBytes: number | undefined,
  startedAt: number,
): Promise<Response> {
  const deadline = timeoutMs !== undefined ? startedAt + timeoutMs : undefined;
  const preparedInit = { ...init };
  const sourceSignal = preparedInit.signal ?? (input instanceof Request ? input.signal : undefined);
  if (sourceSignal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
  if (deadline !== undefined && performance.now() >= deadline) {
    throw new DOMException('HTTP_TIMEOUT: hard budget exhausted', 'TimeoutError');
  }
  const controller = new AbortController();
  let rejectCancelled!: (reason: unknown) => void;
  const cancelled = new Promise<never>((_, reject) => { rejectCancelled = reject; });
  const abort = (reason: DOMException) => {
    controller.abort(reason);
    rejectCancelled(reason);
  };
  const onAbort = () => abort(new DOMException('The operation was aborted.', 'AbortError'));
  sourceSignal?.addEventListener('abort', onAbort, { once: true });
  const timer = deadline !== undefined
    ? setTimeout(() => abort(new DOMException('HTTP_TIMEOUT: hard budget exhausted', 'TimeoutError')),
      Math.max(0, deadline - performance.now()))
    : undefined;
  try {
    const response = await Promise.race([cancelled, (async () => {
      const upstream = await fetch(input as RequestInfo, { ...preparedInit, signal: controller.signal });
      const chunks: Uint8Array[] = [];
      let length = 0;
      const reader = upstream.body?.getReader();
      if (reader) {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (maxResponseBytes !== undefined && length > maxResponseBytes) {
              controller.abort();
              void reader.cancel().catch(() => {});
              throw new Error(`HTTP_RESPONSE_TOO_LARGE: response exceeds ${maxResponseBytes} bytes`);
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const noBody = !upstream.body || upstream.status === 204 || upstream.status === 205 || upstream.status === 304;
      const buffered = new Response(noBody ? null : bytes, {
        status: upstream.status, statusText: upstream.statusText, headers: upstream.headers,
      });
      Object.defineProperty(buffered, 'url', { value: upstream.url });
      return buffered;
    })()]);
    if (sourceSignal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    if (deadline !== undefined && performance.now() >= deadline) {
      throw new DOMException('HTTP_TIMEOUT: hard budget exhausted', 'TimeoutError');
    }
    return response;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    sourceSignal?.removeEventListener('abort', onAbort);
  }
}

async function waitForHttpBudget<T>(
  run: () => Promise<T>,
  signal: AbortSignal | undefined,
  deadline: number | undefined,
): Promise<T> {
  const assertActive = () => {
    if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    if (deadline !== undefined && performance.now() >= deadline) {
      throw new DOMException('HTTP_TIMEOUT: hard budget exhausted', 'TimeoutError');
    }
  };
  assertActive();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (deadline !== undefined) {
      timer = setTimeout(() => reject(new DOMException('HTTP_TIMEOUT: hard budget exhausted', 'TimeoutError')),
        Math.max(0, deadline - performance.now()));
    }
  });
  try {
    const result = await Promise.race([cancelled, run()]);
    assertActive();
    return result;
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** `fetch`-compatible request that bypasses WebView CORS when in the desktop shell. */
export async function tauriFetch(
  input: string | URL | Request,
  init?: RequestInit,
  options?: TauriFetchOptions,
): Promise<Response> {
  const startedAt = performance.now();
  if ((options?.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 1800000)) ||
    (options?.maxResponseBytes !== undefined && (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes < 0))) {
    throw new Error('HTTP_INVALID_BUDGET: invalid timeout or response byte limit');
  }
  if (!tauriAvailable()) {
    return options?.timeoutMs !== undefined || options?.maxResponseBytes !== undefined
      ? nativeFetchWithBudget(input, init, options.timeoutMs, options.maxResponseBytes, startedAt)
      : fetch(input as RequestInfo, init);
  }

  // Only Request/string/URL inputs are used by our call sites.
  // own fields with the explicit init (init wins, matching fetch()).
  const reqObj = input instanceof Request ? input : null;
  const url = reqObj ? reqObj.url : input instanceof URL ? input.toString() : String(input);

  // Only remote http(s) requests can hit CORS. data:/blob:/relative URLs are
  // local or same-origin and must go through the native fetch (the Rust proxy
  // only understands http/https). This keeps the wrapper a safe drop-in.
  if (!/^https?:\/\//i.test(url)) {
    return options?.timeoutMs !== undefined || options?.maxResponseBytes !== undefined
      ? nativeFetchWithBudget(input, init, options.timeoutMs, options.maxResponseBytes, startedAt)
      : fetch(input as RequestInfo, init);
  }
  const method = (init?.method ?? reqObj?.method ?? 'GET').toUpperCase();
  const signal = init?.signal ?? reqObj?.signal ?? undefined;

  if (signal?.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError');
  }

  const headers = normalizeHeaders(init?.headers ?? reqObj?.headers ?? undefined);
  const deadline = options?.timeoutMs !== undefined ? startedAt + options.timeoutMs : undefined;
  const bodyBase64 = await waitForHttpBudget(() => bodyInitToBase64(init?.body ?? undefined), signal, deadline);
  const invoke = await waitForHttpBudget(getInvoke, signal, deadline);
  if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
  if (options?.timeoutMs !== undefined && performance.now() - startedAt >= options.timeoutMs) {
    throw new DOMException('HTTP_TIMEOUT: hard budget exhausted', 'TimeoutError');
  }
  // Cancellation stops JS waiting, not Rust I/O; the remaining per-call timeout bounds that I/O.
  // Install the abort listener before dispatch to avoid losing an abort during invoke().
  const payload = await waitForHttpBudget(() => {
    const timeoutMs = deadline !== undefined ? Math.floor(deadline - performance.now()) : undefined;
    if (timeoutMs !== undefined && timeoutMs < 1) {
      throw new DOMException('HTTP_TIMEOUT: hard budget exhausted', 'TimeoutError');
    }
    return invoke<ProxyHttpResponsePayload>('proxy_http', {
      request: {
        method, url, headers, bodyBase64,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(options?.maxResponseBytes !== undefined ? { maxResponseBytes: options.maxResponseBytes } : {}),
      },
    });
  }, signal, deadline);

  const responseHeaders = new Headers();
  for (const { name, value } of payload.headers) {
    try {
      responseHeaders.append(name, value);
    } catch {
      // Skip forbidden/invalid header names rather than failing the response.
    }
  }
  if (options?.maxResponseBytes !== undefined) {
    // Rust emits canonical padded base64. Reject an oversized IPC payload before atob allocates it.
    const encoded = payload.bodyBase64;
    const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
    const decodedLength = Math.floor(encoded.length * 3 / 4) - padding;
    if (decodedLength > options.maxResponseBytes) {
      throw new Error(`HTTP_RESPONSE_TOO_LARGE: response exceeds ${options.maxResponseBytes} bytes`);
    }
  }
  const bodyBytes = base64ToBytes(payload.bodyBase64);
  if (options?.maxResponseBytes !== undefined && bodyBytes.byteLength > options.maxResponseBytes) {
    throw new Error(`HTTP_RESPONSE_TOO_LARGE: response exceeds ${options.maxResponseBytes} bytes`);
  }
  // 204/205/304 must not carry a body per the Response constructor contract.
  const nullBody = payload.status === 204 || payload.status === 205 || payload.status === 304;
  const responseBody: BodyInit | null = nullBody
    ? null
    : new Blob([bodyBytes.buffer as ArrayBuffer]);
  const response = new Response(responseBody, {
    status: payload.status,
    statusText: payload.statusText,
    headers: responseHeaders,
  });
  // `url` is read-only on Response; expose the final URL for callers that read it.
  try {
    Object.defineProperty(response, 'url', { value: payload.url || url });
  } catch {
    // Non-fatal: some engines lock the property. Callers rarely need it.
  }
  if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
  if (deadline !== undefined && performance.now() >= deadline) {
    throw new DOMException('HTTP_TIMEOUT: hard budget exhausted', 'TimeoutError');
  }
  return response;
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
