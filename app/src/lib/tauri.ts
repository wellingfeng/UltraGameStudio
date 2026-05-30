import type { IRGraph } from '@/core/ir';

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

/** Disposer returned by the event listeners. */
export type UnlistenFn = () => void;

/**
 * True when running inside the Tauri desktop shell. Wraps the SDK's own
 * detection and never throws (older/edge runtimes may lack the global).
 */
export function tauriAvailable(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      typeof (window as { __TAURI__?: unknown; __TAURI_INTERNALS__?: unknown })
        .__TAURI_INTERNALS__ !== 'undefined'
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
  /** Working directory for the agent (the run's workspace). */
  cwd?: string;
  /** Permission mode: 'full' | 'readonly' | 'ask' (from the AIDock dropdown). */
  permission?: string;
  /** Live progress callback — receives streamed text/tool-use chunks. */
  onProgress?: (text: string) => void;
}

let __cliSeq = 0;

export async function aiEditViaCli(
  prompt: string,
  adapter: string,
  opts: CliOpts = {},
): Promise<string> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  __cliSeq += 1;
  const runId = `cli_${Date.now()}_${__cliSeq}`;

  // Subscribe to per-run progress events (best-effort; the final result is
  // returned regardless of whether any progress chunks arrive).
  let unlisten: UnlistenFn | undefined;
  if (opts.onProgress) {
    const listen = await getListen();
    unlisten = await listen<{ runId: string; text: string }>(
      'ai-cli-progress',
      (event) => {
        if (event.payload?.runId === runId) opts.onProgress!(event.payload.text);
      },
    );
  }

  try {
    const invoke = await getInvoke();
    return await invoke<string>('ai_cli', {
      prompt,
      adapter,
      model: opts.model ?? null,
      cwd: opts.cwd ?? null,
      permission: opts.permission ?? null,
      runId,
    });
  } finally {
    unlisten?.();
  }
}

/**
 * Run an emitted script through the given CLI adapter (claude-code/codex/
 * gemini). Returns a combined stdout/stderr summary string. Throws
 * Error('NO_BACKEND') outside the desktop shell.
 */
export async function runWorkflow(
  script: string,
  adapter: string,
): Promise<string> {
  if (!tauriAvailable()) {
    throw new Error('NO_BACKEND');
  }
  const invoke = await getInvoke();
  return invoke<string>('run_workflow', { script, adapter });
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
