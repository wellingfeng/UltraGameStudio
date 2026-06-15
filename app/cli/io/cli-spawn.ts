/**
 * Node `child_process.spawn` port of the Tauri `ai_cli` command
 * (`src-tauri/src/lib.rs`). It reproduces the exact argv, stdin handling,
 * stream-json parsing, timeout / idle-timeout, and cancellation behaviour so a
 * headless CLI run is observably identical to a desktop run.
 *
 * argv (claude):  -p --output-format stream-json --verbose
 *                 [--bare                 (API-key relay/free channel only, when supported)]
 *                 [--strict-mcp-config]
 *                 [--resume <sid> | --session-id <sid>]
 *                 [--model <m>            (filtered by shouldPassModel)]
 *                 [--permission-mode plan | --dangerously-skip-permissions]
 *                 [--add-dir <cwd>]
 * argv (codex):   [-a never|on-request] exec [-c project MCP overrides...] --json --skip-git-repo-check
 *                 [--sandbox read-only|workspace-write | --dangerously-bypass-...]
 *                 [--model <m>] [-C <cwd>] [-o <outfile>] -
 *
 * The prompt is fed via stdin (then closed) so large prompts can't hit the OS
 * command-line length limit. `DISABLE_AUTOUPDATER=1` is layered onto the claude
 * env. On Windows the child is launched with `windowsHide: true` and killed via
 * `taskkill /PID <pid> /T /F`; elsewhere via `kill -TERM`.
 *
 * Pure Node: no react / zustand / tauri. Imports only `which-cli` (sibling) +
 * `node:*`.
 */
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import {
  adapterProtocol,
  repairClaudeBunInstall,
  shouldPassModel,
  whichCli,
} from './which-cli';
import {
  codexCompletedItem,
  codexProgressLine,
  codexStatusSuccess,
  codexTurnCompletionStatus,
  codexTurnUsage,
  encodeToolPatch,
  toolSubject,
} from './stream';

const IS_WINDOWS = process.platform === 'win32';

/** Cap a tool result body so a huge file read doesn't bloat the message text. */
const TOOL_RESULT_CLAMP = 4000;

/**
 * Flatten a Claude `tool_result.content` value (string, or an array of
 * `{type:'text', text}` blocks) into a plain string for the structured event.
 */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string') {
          return (b as { text: string }).text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** Keep structured Codex item metadata useful for file tracking, without huge outputs. */
function codexToolArgs(item: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (key === 'output' || key === 'text') continue;
    if (value !== undefined) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Default hard timeout (s) before the child is killed (mirrors lib.rs). */
const DEFAULT_TIMEOUT_SECS = 1800;
/** Default "no observable progress" timeout (s) (mirrors lib.rs). */
const DEFAULT_IDLE_TIMEOUT_SECS = 300;

/** Options for {@link spawnCliAgent}. */
export interface SpawnCliAgentOpts {
  /** Adapter id (claude-code / codex / gemini / custom). */
  adapter: string;
  model?: string;
  /** Explicit CLI path / bare name override. */
  cliCommand?: string;
  cwd?: string;
  /** AIDock permission mode: 'full' | 'readonly' | 'ask'. */
  permission?: string;
  /** Per-call env overlay (gateway credentials etc.). */
  env?: Record<string, string>;
  timeoutSeconds?: number;
  idleTimeoutSeconds?: number;
  /** Live progress callback (assistant text + tool breadcrumbs). */
  onProgress?: (text: string) => void;
  /** Raw model usage payload emitted by supported CLI adapters. */
  onUsage?: (usage: unknown) => void;
  /** Claude session continuity. */
  sessionId?: string;
  resume?: boolean;
  /** Cancellation: when it aborts, the child process tree is killed. */
  signal?: AbortSignal;
}

/** Clamp + env-override the hard timeout (mirrors ai_cli_timeout_secs). */
function resolveTimeoutSecs(override?: number): number {
  const configuredRaw = Number(process.env.FREEULTRACODE_AI_CLI_TIMEOUT_SECS);
  const configured =
    Number.isFinite(configuredRaw) && configuredRaw >= 60
      ? Math.floor(configuredRaw)
      : DEFAULT_TIMEOUT_SECS;
  const dynamic =
    typeof override === 'number' && override >= 60 ? Math.floor(override) : configured;
  return Math.max(configured, dynamic);
}

/** Clamp + env-override the idle timeout (mirrors ai_cli_idle_timeout_secs). 0 disables. */
function resolveIdleTimeoutSecs(override?: number): number {
  const raw = process.env.FREEULTRACODE_AI_CLI_IDLE_TIMEOUT_SECS;
  let configured = DEFAULT_IDLE_TIMEOUT_SECS;
  if (raw != null && raw.trim() !== '') {
    const n = Number(raw.trim());
    if (Number.isFinite(n) && (n === 0 || n >= 30)) configured = Math.floor(n);
  }
  if (configured === 0) return 0;
  if (typeof override === 'number' && (override === 0 || override >= 30)) {
    if (override === 0) return 0;
    return Math.max(configured, Math.floor(override));
  }
  return configured;
}

function flagEnabled(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function hasEnvValue(env: Record<string, string> | undefined, key: string): boolean {
  return !!env?.[key]?.trim();
}

function shouldRunClaudeBare(env: Record<string, string> | undefined): boolean {
  if (flagEnabled(process.env.FREEULTRACODE_DISABLE_CLAUDE_BARE)) return false;
  const hasApiKey = hasEnvValue(env, 'ANTHROPIC_API_KEY');
  const hasGatewayRoute =
    hasEnvValue(env, 'ANTHROPIC_BASE_URL') || hasEnvValue(env, 'ANTHROPIC_MODEL');
  return hasApiKey && hasGatewayRoute;
}

function knownProviderModelVariant(baseUrl: string | undefined, model: string | undefined): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;
  const base = (baseUrl ?? '').trim().toLowerCase();
  const lower = trimmed.toLowerCase();

  if (base.includes('openrouter.ai') || base.includes('/ch/open_router')) {
    if (/^glm-\d/i.test(trimmed)) return `z-ai/${lower}`;
    if (lower.startsWith('z-ai/glm-')) return lower;
  }
  if (base.includes('integrate.api.nvidia.com') || base.includes('/ch/nvidia_nim')) {
    if (!trimmed.includes('/') && lower.includes('nemotron')) {
      return `nvidia/${lower}`;
    }
  }
  if (base.includes('fireworks.ai') || base.includes('/ch/fireworks')) {
    if (!trimmed.includes('/') && lower.startsWith('llama-')) {
      return `accounts/fireworks/models/${lower}`;
    }
  }
  if (
    base.includes('opencode.ai') ||
    base.includes('z.ai') ||
    base.includes('bigmodel.cn') ||
    base.includes('/ch/opencode') ||
    base.includes('/ch/opencode_go') ||
    base.includes('/ch/zai')
  ) {
    if (/^glm-\d/i.test(trimmed)) return lower;
  }
  return trimmed;
}

function normalizeSpawnEnv(env: NodeJS.ProcessEnv): void {
  const anthropicModel = knownProviderModelVariant(
    env.ANTHROPIC_BASE_URL,
    env.ANTHROPIC_MODEL,
  );
  if (anthropicModel && env.ANTHROPIC_MODEL?.trim() !== anthropicModel) {
    env.ANTHROPIC_MODEL = anthropicModel;
  }

  const openaiModel = knownProviderModelVariant(env.OPENAI_BASE_URL, env.OPENAI_MODEL);
  if (openaiModel && env.OPENAI_MODEL?.trim() !== openaiModel) {
    env.OPENAI_MODEL = openaiModel;
  }
}

function mcpEnabled(): boolean {
  const v = (process.env.FREEULTRACODE_ENABLE_MCP ?? '').trim().toLowerCase();
  // Default on: only an explicit disable value turns MCP off.
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

function projectHistoryPathKey(path: string | undefined): string | null {
  const trimmed = path?.trim();
  if (!trimmed) return null;
  const normalized = resolve(trimmed).replace(/\\/g, '/');
  return IS_WINDOWS ? normalized.toLowerCase() : normalized;
}

function freeUltraCodeRoot(): string {
  const configured = process.env.FUC_HOME?.trim();
  return configured || join(homedir(), '.freeultracode');
}

function projectSettingsForCwd(cwd: string | undefined): Record<string, unknown> | null {
  const cwdKey = projectHistoryPathKey(cwd);
  if (!cwdKey) return null;
  try {
    const indexPath = join(freeUltraCodeRoot(), 'workspaces', 'index.json');
    const workspaces = JSON.parse(readFileSync(indexPath, 'utf8')) as unknown;
    if (!Array.isArray(workspaces)) return null;
    const workspace = workspaces.find((item) => {
      if (!item || typeof item !== 'object') return false;
      const path = (item as Record<string, unknown>).path;
      return typeof path === 'string' && projectHistoryPathKey(path) === cwdKey;
    });
    const metadata =
      workspace && typeof workspace === 'object'
        ? (workspace as Record<string, unknown>).metadata
        : null;
    const settings =
      metadata && typeof metadata === 'object'
        ? (metadata as Record<string, unknown>).projectSettings
        : null;
    return settings && typeof settings === 'object'
      ? (settings as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function projectExpandPathText(value: string): string {
  const userProfile = process.env.USERPROFILE || '';
  const home = process.env.HOME || userProfile;
  return value
    .replace(/%USERPROFILE%/gi, userProfile)
    .replace(/%HOME%/gi, home)
    .replace(/^~(?=[/\\]|$)/, home);
}

function projectMcpSettingsJson(cwd: string | undefined): Record<string, unknown> | null {
  const settings = projectSettingsForCwd(cwd);
  const mcp = settings?.mcp;
  if (!mcp || typeof mcp !== 'object') return null;
  const mcpRecord = mcp as Record<string, unknown>;
  if (mcpRecord.enabled === false) return null;
  const servers = Array.isArray(mcpRecord.servers) ? mcpRecord.servers : [];
  const workspace = cwd?.trim() ?? '';
  const used = new Set<string>();
  const mcpServers: Record<string, unknown> = {};

  for (const raw of servers) {
    if (!raw || typeof raw !== 'object') continue;
    const server = raw as Record<string, unknown>;
    if (server.enabled !== true) continue;
    if (server.transport !== 'stdio') continue;
    const command = typeof server.command === 'string' ? server.command.trim() : '';
    if (!command) continue;
    const id = typeof server.id === 'string' ? server.id : 'project-mcp';
    let key = id.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '') || 'project-mcp';
    const base = key;
    let suffix = 2;
    while (used.has(key)) {
      key = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(key);

    const entry: Record<string, unknown> = {
      command: projectExpandPathText(command),
    };
    if (Array.isArray(server.args)) {
      entry.args = server.args
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.replaceAll('{workspace}', workspace));
    }
    if (server.env && typeof server.env === 'object') {
      const env = Object.fromEntries(
        Object.entries(server.env as Record<string, unknown>)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
          .map(([key, value]) => [key, value.replaceAll('{workspace}', workspace)]),
      );
      if (Object.keys(env).length > 0) entry.env = env;
    }
    mcpServers[key] = entry;
  }
  return Object.keys(mcpServers).length > 0 ? { mcpServers } : null;
}

function writeProjectMcpSettings(cwd: string | undefined): { path: string; dir: string } | null {
  const settings = projectMcpSettingsJson(cwd);
  if (!settings) return null;
  const dir = mkdtempSync(join(tmpdir(), 'freeultracode-project-mcp-'));
  const path = join(dir, 'settings.json');
  writeFileSync(path, JSON.stringify(settings), 'utf8');
  return { path, dir };
}

function tomlLiteralString(value: string): string {
  return JSON.stringify(value);
}

function tomlLiteralStringArray(values: string[]): string {
  return JSON.stringify(values);
}

function codexConfigKeySegment(value: string): string {
  return value && /^[A-Za-z0-9_-]+$/.test(value)
    ? value
    : tomlLiteralString(value);
}

function appendCodexProjectMcpConfigArgsFromSettings(
  args: string[],
  settings: Record<string, unknown> | null,
): void {
  const servers = settings?.mcpServers;
  if (!servers || typeof servers !== 'object') return;
  for (const [id, raw] of Object.entries(servers as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const server = raw as Record<string, unknown>;
    const command = typeof server.command === 'string' ? server.command.trim() : '';
    if (!command) continue;
    const serverKey = codexConfigKeySegment(id);
    args.push('-c', `mcp_servers.${serverKey}.command=${tomlLiteralString(command)}`);
    const serverArgs = Array.isArray(server.args)
      ? server.args.filter((item): item is string => typeof item === 'string')
      : [];
    args.push('-c', `mcp_servers.${serverKey}.args=${tomlLiteralStringArray(serverArgs)}`);
    if (server.env && typeof server.env === 'object') {
      for (const [key, value] of Object.entries(server.env as Record<string, unknown>)) {
        if (typeof value !== 'string') continue;
        args.push(
          '-c',
          `mcp_servers.${serverKey}.env.${codexConfigKeySegment(key)}=${tomlLiteralString(value)}`,
        );
      }
    }
  }
}

function appendCodexProjectMcpConfigArgs(args: string[], cwd: string | undefined): void {
  if (!mcpEnabled()) return;
  appendCodexProjectMcpConfigArgsFromSettings(args, projectMcpSettingsJson(cwd));
}

/** Kill a process tree: Windows `taskkill /PID <pid> /T /F`, *nix `kill -TERM`. */
export function terminateProcessTree(pid: number): void {
  try {
    if (IS_WINDOWS) {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        spawnSync('kill', ['-TERM', String(pid)], { stdio: 'ignore' });
      }
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Decide how to actually launch a binary. On Windows a batch launcher
 * (`.cmd`/`.bat`) cannot be spawned directly (Node raises EINVAL since the
 * CVE-2024-27980 fix), so it is run through `cmd.exe /d /s /c` with a single
 * verbatim command line — mirroring how the Rust `Command` invocation resolves
 * batch shims on Windows. Native executables (and all *nix binaries) spawn
 * directly with the tokenised argv.
 */
function resolveLaunch(
  binary: string,
  args: string[],
): { command: string; args: string[]; verbatim: boolean } {
  if (IS_WINDOWS && /\.(cmd|bat)$/i.test(binary)) {
    const quote = (s: string) => (/[\s"&|<>^()]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const line = [binary, ...args].map(quote).join(' ');
    const comspec = process.env.ComSpec || 'cmd.exe';
    return { command: comspec, args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
  }
  return { command: binary, args, verbatim: false };
}

const claudeBareSupportCache = new Map<string, boolean>();

function claudeHelpSupportsBare(text: string): boolean {
  return text.includes('--bare');
}

function claudeCliSupportsBare(binary: string): boolean {
  const cached = claudeBareSupportCache.get(binary);
  if (cached != null) return cached;

  const launch = resolveLaunch(binary, ['--help']);
  const result = spawnSync(launch.command, launch.args, {
    encoding: 'utf8',
    env: { ...process.env, DISABLE_AUTOUPDATER: '1' },
    input: '',
    timeout: 5000,
    windowsHide: true,
    windowsVerbatimArguments: launch.verbatim,
  });
  const helpText = `${String(result.stdout ?? '')}\n${String(result.stderr ?? '')}`;
  const supported = claudeHelpSupportsBare(helpText);
  claudeBareSupportCache.set(binary, supported);
  return supported;
}

/** Build the claude / codex argv (mirrors the Rust `args` assembly). */
function buildArgs(
  opts: SpawnCliAgentOpts,
  protocol: string,
  codexOutPath: string | undefined,
  binary: string,
): { args: string[]; workdir?: string; disableAutoupdater: boolean; tempDirs: string[] } {
  const args: string[] = [];
  let workdir: string | undefined;
  let disableAutoupdater = false;
  const tempDirs: string[] = [];
  const permission = opts.permission ?? 'full';
  const cwd = opts.cwd?.trim();

  if (protocol === 'codex') {
    if (permission === 'readonly') {
      args.push('-a', 'never');
    } else if (permission === 'ask') {
      args.push('-a', 'on-request');
    }
    args.push('exec', '--json', '--skip-git-repo-check');
    if (permission === 'readonly') {
      args.push('--sandbox', 'read-only');
    } else if (permission === 'ask') {
      args.push('--sandbox', 'workspace-write');
    } else {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    }
    appendCodexProjectMcpConfigArgs(args, cwd);
    if (opts.model && shouldPassModel(opts.adapter, opts.model)) {
      args.push('--model', opts.model);
    }
    if (cwd) {
      workdir = cwd;
      args.push('-C', cwd);
    }
    if (codexOutPath) {
      args.push('-o', codexOutPath);
    }
    args.push('-');
  } else {
    // claude (and any non-codex protocol falls through to the claude shape).
    args.push('-p', '--output-format', 'stream-json', '--verbose');
    if (shouldRunClaudeBare(opts.env) && claudeCliSupportsBare(binary)) {
      args.push('--bare');
    }
    disableAutoupdater = true;
    if (mcpEnabled()) {
      const projectMcp = writeProjectMcpSettings(cwd);
      if (projectMcp) {
        args.push('--mcp-config', projectMcp.path);
        tempDirs.push(projectMcp.dir);
      }
    } else {
      args.push('--strict-mcp-config');
    }
    const sid = opts.sessionId?.trim();
    if (sid) {
      if (opts.resume) {
        args.push('--resume', sid);
      } else {
        args.push('--session-id', sid);
      }
    }
    if (opts.model && shouldPassModel(opts.adapter, opts.model)) {
      args.push('--model', opts.model);
    }
    if (permission === 'readonly') {
      args.push('--permission-mode', 'plan');
    } else if (permission === 'ask') {
      /* default: may print a permission question */
    } else {
      args.push('--dangerously-skip-permissions');
    }
    if (cwd) {
      workdir = cwd;
      args.push('--add-dir', cwd);
    }
  }
  return { args, workdir, disableAutoupdater, tempDirs };
}

/**
 * Spawn a one-shot CLI agent and resolve with its final text. Streams assistant
 * text + tool breadcrumbs through `onProgress`. Rejects with a message that
 * `runtime/failure.ts#parseRunFailure` can classify (same wording as lib.rs):
 * timeout / idle_timeout / interrupted / exit / spawn.
 */
export function spawnCliAgent(prompt: string, opts: SpawnCliAgentOpts): Promise<string> {
  const protocol = adapterProtocol(opts.adapter);
  if (protocol === 'claude') {
    repairClaudeBunInstall();
  }
  const isCodex = protocol === 'codex';
  const binary = whichCli(opts.adapter, { cliCommand: opts.cliCommand });

  let codexDir: string | undefined;
  let codexOutPath: string | undefined;
  if (isCodex) {
    codexDir = mkdtempSync(join(tmpdir(), 'freeultracode-codex-'));
    codexOutPath = join(codexDir, 'last-message.txt');
  }
  let tempDirs: string[] = [];
  const cleanupTempDirs = () => {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    if (codexDir) {
      try {
        rmSync(codexDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  };

  const built = buildArgs(
    opts,
    protocol,
    codexOutPath,
    binary,
  );
  const { args, workdir, disableAutoupdater } = built;
  tempDirs = built.tempDirs;

  return new Promise<string>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (opts.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        if (k.trim()) env[k] = v;
      }
    }
    normalizeSpawnEnv(env);
    if (disableAutoupdater) env.DISABLE_AUTOUPDATER = '1';

    let child;
    try {
      const launch = resolveLaunch(binary, args);
      child = spawn(launch.command, launch.args, {
        cwd: workdir,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: launch.verbatim,
      });
    } catch (err) {
      cleanupTempDirs();
      reject(
        new Error(
          `无法启动 CLI "${binary}"：请确认它已安装并在 PATH 中。(${(err as Error).message})`,
        ),
      );
      return;
    }

    const timeoutSecs = resolveTimeoutSecs(opts.timeoutSeconds);
    const idleSecs = resolveIdleTimeoutSecs(opts.idleTimeoutSeconds);

    let acc = ''; // accumulated assistant text
    let result = ''; // terminal `result` value (claude)
    let codexTurnStatus: string | undefined;
    let stderrBuf = '';
    let lastActivity = Date.now();
    const touch = () => {
      lastActivity = Date.now();
    };

    let settled = false;
    let timedOutMessage: string | null = null;
    let cancelled = false;
    // Per-call timing for structured tool events: tool_use_id → start epoch ms.
    const toolStartedAt = new Map<string, number>();

    const finishReject = (msg: string) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      cleanupTempDirs();
      reject(new Error(appendErrorContext(msg, result || acc, stderrBuf)));
    };
    const finishResolve = (out: string) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      cleanupTempDirs();
      resolve(out);
    };
    const currentOutput = () => {
      let output = result.trim() ? result : acc;
      if (isCodex && codexOutPath) {
        try {
          const final = readFileSync(codexOutPath, 'utf8');
          if (final.trim()) output = final;
        } catch {
          /* none */
        }
      }
      return output;
    };

    // --- spawn errors (ENOENT etc.) ---
    child.on('error', (err) => {
      finishReject(
        `无法启动 CLI "${binary}"：请确认它已安装并在 PATH 中。(${err.message})`,
      );
    });

    // --- stdin: write prompt then close (EOF) ---
    if (child.stdin) {
      child.stdin.on('error', () => {
        /* ignore EPIPE if the child exits before reading the full prompt */
      });
      child.stdin.write(prompt);
      child.stdin.end();
    }

    // --- stdout: line-buffered JSONL parse ---
    const rl = child.stdout
      ? createInterface({ input: child.stdout, crlfDelay: Infinity })
      : null;
    rl?.on('line', (line) => {
      touch();
      const trimmed = line.trim();
      if (!trimmed) return;
      let v: Record<string, unknown>;
      try {
        v = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        return;
      }
      if (isCodex) {
        const usage = codexTurnUsage(v);
        if (usage) opts.onUsage?.(usage);
        const status = codexTurnCompletionStatus(v);
        if (status != null) {
          codexTurnStatus = status;
          const output = currentOutput();
          terminateProcessTree(child.pid!);
          if (codexStatusSuccess(status)) finishResolve(output);
          else {
            const detail = stderrBuf.trim() || output.trim();
            finishReject(`CLI "${binary}" turn status ${status}: ${detail}`);
          }
          return;
        }
        const item = codexCompletedItem(v);
        if (item) {
          const itemType = typeof item.type === 'string' ? item.type : '';
          if (itemType === 'agent_message') {
            // Plain assistant prose — keep as text.
            const ln = codexProgressLine(item);
            if (ln) {
              acc += ln;
              opts.onProgress?.(ln);
            }
          } else if (itemType) {
            // A completed tool/command item → one structured (done) event.
            // codex items arrive already-complete with no start event, so we
            // can't report a duration. We still register the id (used as a
            // uniqueness counter for the fallback id below).
            const id =
              typeof item.id === 'string' ? item.id : `cx${toolStartedAt.size}`;
            toolStartedAt.set(id, Date.now());
            const subject = toolSubject(item);
            const resultText =
              typeof item.output === 'string'
                ? item.output
                : typeof item.text === 'string'
                  ? item.text
                  : '';
            const isError =
              typeof item.status === 'string' &&
              /error|fail/i.test(item.status);
            opts.onProgress?.(
              encodeToolPatch({
                id,
                name: itemType,
                subject,
                args: codexToolArgs(item),
                status: isError ? 'error' : 'done',
                result: resultText.slice(0, TOOL_RESULT_CLAMP),
                truncated: resultText.length >= TOOL_RESULT_CLAMP,
              }),
            );
          }
        }
        return;
      }
      // claude stream-json
      const type = v.type;
      if (type === 'assistant') {
        const message = v.message as Record<string, unknown> | undefined;
        const content = message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block !== 'object' || block === null) continue;
            const b = block as Record<string, unknown>;
            if (b.type === 'text' && typeof b.text === 'string') {
              acc += b.text;
              opts.onProgress?.(b.text);
            } else if (b.type === 'tool_use') {
              const name = typeof b.name === 'string' ? b.name : 'tool';
              const id = typeof b.id === 'string' ? b.id : `t${toolStartedAt.size}`;
              toolStartedAt.set(id, Date.now());
              // Structured sentinel (rich card) + legacy text line (fallback /
              // raw transports). The render layer strips the sentinel.
              const sentinel = encodeToolPatch({
                id,
                name,
                subject: toolSubject(b.input),
                args: b.input,
                status: 'running',
              });
              opts.onProgress?.(sentinel);
            }
          }
        }
      } else if (type === 'user') {
        // tool_result blocks arrive on a `user` message, correlated by id.
        const message = v.message as Record<string, unknown> | undefined;
        const content = message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block !== 'object' || block === null) continue;
            const b = block as Record<string, unknown>;
            if (b.type !== 'tool_result') continue;
            const id = typeof b.tool_use_id === 'string' ? b.tool_use_id : '';
            if (!id) continue;
            const startedAt = toolStartedAt.get(id);
            const durationMs = startedAt != null ? Date.now() - startedAt : undefined;
            const isError = b.is_error === true;
            const resultText = toolResultText(b.content);
            const truncated = resultText.length >= TOOL_RESULT_CLAMP;
            opts.onProgress?.(
              encodeToolPatch({
                id,
                status: isError ? 'error' : 'done',
                durationMs,
                result: resultText.slice(0, TOOL_RESULT_CLAMP),
                truncated,
              }),
            );
          }
        }
      } else if (type === 'result') {
        if (typeof v.result === 'string') result = v.result;
      }
    });

    // --- stderr: capture for error context ---
    child.stderr?.on('data', (chunk: Buffer) => {
      touch();
      stderrBuf += chunk.toString('utf8');
      if (stderrBuf.length > 64_000) stderrBuf = stderrBuf.slice(-64_000);
    });

    // --- timers: hard timeout + idle timeout + codex sidecar readiness ---
    const startedAt = Date.now();
    const poll = setInterval(() => {
      if (settled) return;
      if (Date.now() - startedAt >= timeoutSecs * 1000) {
        timedOutMessage = `CLI "${binary}" 超时（${timeoutSecs}s）已终止。`;
        terminateProcessTree(child.pid!);
        return;
      }
      if (idleSecs > 0 && Date.now() - lastActivity >= idleSecs * 1000) {
        timedOutMessage = `CLI "${binary}" 空转超过 ${idleSecs}s 未产生输出，已终止。`;
        terminateProcessTree(child.pid!);
        return;
      }
      if (isCodex && codexOutPath) {
        // Sidecar file presence/growth counts as activity.
        const ready = codexLastMessageReady(codexOutPath);
        if (ready) {
          terminateProcessTree(child.pid!);
        }
      }
    }, 100);

    const onAbort = () => {
      cancelled = true;
      if (child.pid != null) terminateProcessTree(child.pid);
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    function cleanupTimers() {
      clearInterval(poll);
      rl?.close();
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    }

    // --- exit: decide success/failure (mirrors the Rust match) ---
    child.on('close', (code, signal) => {
      // Read codex sidecar final message if present.
      const output = currentOutput();

      if (cancelled) {
        finishReject(`CLI "${binary}" 已由用户中断。`);
        return;
      }
      if (timedOutMessage) {
        finishReject(timedOutMessage);
        return;
      }
      if (isCodex && codexTurnStatus != null) {
        if (codexStatusSuccess(codexTurnStatus)) finishResolve(output);
        else {
          const detail = stderrBuf.trim() || output.trim();
          finishReject(`CLI "${binary}" turn status ${codexTurnStatus}: ${detail}`);
        }
        return;
      }
      // codex sidecar-ready (terminated by us) without a turn event → success.
      if (isCodex && (code === null || signal != null) && output.trim()) {
        finishResolve(output);
        return;
      }
      if (code === 0) {
        finishResolve(output);
        return;
      }
      const c = code == null ? -1 : code;
      const detail = stderrBuf.trim() || output.trim();
      finishReject(`CLI "${binary}" 退出码 ${c}: ${detail}`);
    });
  });
}

/** Codex sidecar readiness: non-empty + unmodified for ≥1s (mirrors codex_last_message_ready). */
function codexLastMessageReady(path: string): boolean {
  try {
    const st = statSync(path);
    if (st.size === 0) return false;
    return Date.now() - st.mtimeMs >= 1000;
  } catch {
    return false;
  }
}

const ERROR_CONTEXT_LIMIT = 1200;

/** Append a trimmed tail of recent output/stderr to an error (mirrors append_cli_error_context). */
function appendErrorContext(err: string, output: string, stderr: string): string {
  const context = stderr.trim() ? stderr : output;
  const trimmed = context.trim();
  if (!trimmed) return err;
  let tail = trimmed;
  if (tail.length > ERROR_CONTEXT_LIMIT) {
    tail = `...\n${tail.slice(tail.length - ERROR_CONTEXT_LIMIT)}`;
  }
  return `${err}\n最近输出:\n${tail}`;
}
