/**
 * CLI-side executable discovery + model-flag gating. A faithful Node port of
 * `src-tauri/src/cli_runtime.rs` (`adapter_binary`, `should_pass_model`, the
 * PATH / PATHEXT scan) and `lib/modelGateway/resolver.ts`
 * (`looksLikeClaudeModelId`). No tauri / react / zustand: pure `node:fs` +
 * `node:path` + `process.env`.
 *
 * Resolution order for a CLI binary (highest priority first):
 *   1. explicit override (`cliCommand` arg — an absolute path or a bare name)
 *   2. `FUC_<ADAPTER>_PATH` env var (e.g. FUC_CLAUDE_PATH / FUC_CODEX_PATH)
 *   3. config-file `adapters.<adapter>.path` (passed in by the caller)
 *   4. PATH scan for the adapter's default binary name (+ PATHEXT on Windows)
 */
import { chmodSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

const IS_WINDOWS = process.platform === 'win32';

/** Map an adapter id to its default executable name (mirrors adapter_binary). */
export function adapterBinary(adapter: string): string {
  switch (adapter) {
    case 'claude-code':
    case 'claude':
      return 'claude';
    case 'codex':
      return 'codex';
    case 'gemini':
      return 'gemini';
    default:
      return adapter;
  }
}

/** Map an adapter id to its wire protocol (mirrors adapter_protocol). */
export function adapterProtocol(adapter: string): 'claude' | 'codex' | 'gemini' | string {
  switch (adapter) {
    case 'claude-code':
    case 'claude':
      return 'claude';
    case 'codex':
      return 'codex';
    case 'gemini':
      return 'gemini';
    default:
      return adapter;
  }
}

/**
 * Whether a model id/label is safe to forward as the CLI's `--model` flag.
 * Mirrors `should_pass_model` in cli_runtime.rs exactly:
 *   - codex/gemini: reject Claude tiers + `claude-*` ids, pass real upstream ids.
 *   - claude-code: only genuine `claude*` ids or the bare tier aliases.
 */
export function shouldPassModel(adapter: string, model: string | undefined): boolean {
  const m = (model ?? '').trim();
  if (!m) return false;
  const lower = m.toLowerCase();
  const protocol = adapterProtocol(adapter);
  if (protocol === 'codex' || protocol === 'gemini') {
    return (
      lower !== 'haiku' &&
      lower !== 'sonnet' &&
      lower !== 'opus' &&
      !lower.startsWith('claude-')
    );
  }
  // claude-code: forward real Claude ids or the bare tier aliases the CLI maps.
  return (
    lower === 'haiku' || lower === 'sonnet' || lower === 'opus' || lower.startsWith('claude')
  );
}

function looksLikePath(raw: string): boolean {
  return raw.includes('/') || raw.includes('\\') || isAbsolute(raw);
}

function isExecutableFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function userHomeDir(): string {
  return process.env.USERPROFILE?.trim() || process.env.HOME?.trim() || homedir();
}

/**
 * Best-effort self-heal for Bun-installed Claude Code after an interrupted
 * auto-update leaves the package bin missing and only `claude(.exe).old.*`
 * remains. The PATH shim still exists, but Bun exits before Claude starts.
 */
export function repairClaudeBunInstall(homeDir: string = userHomeDir()): boolean {
  const home = homeDir.trim();
  if (!home) return false;

  const binDir = join(
    home,
    '.bun',
    'install',
    'global',
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'bin',
  );

  for (const targetName of ['claude.exe', 'claude']) {
    const target = join(binDir, targetName);
    if (isExecutableFile(target)) return false;

    const prefix = `${targetName}.old.`;
    let newest: { path: string; mtimeMs: number } | null = null;
    try {
      for (const name of readdirSync(binDir)) {
        if (!name.startsWith(prefix)) continue;
        const path = join(binDir, name);
        const stat = statSync(path);
        if (!stat.isFile()) continue;
        if (!newest || stat.mtimeMs > newest.mtimeMs) {
          newest = { path, mtimeMs: stat.mtimeMs };
        }
      }
    } catch {
      return false;
    }

    if (newest) {
      try {
        copyFileSync(newest.path, target);
        chmodSync(target, statSync(newest.path).mode);
        return true;
      } catch {
        return false;
      }
    }
  }

  return false;
}

/** Windows PATHEXT variants for a bare command (e.g. claude -> claude.CMD …). */
function pathextVariants(command: string): string[] {
  const pathext =
    process.env.PATHEXT && process.env.PATHEXT.trim()
      ? process.env.PATHEXT
      : '.COM;.EXE;.BAT;.CMD';
  const exts = pathext
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean);
  return exts.map((ext) => `${command}${ext}`);
}

/** Scan PATH (and PATHEXT on Windows) for `command`. Returns the full path or null. */
function searchPath(command: string): string | null {
  const pathVar = process.env.PATH ?? process.env.Path ?? '';
  if (!pathVar) return null;
  const variants =
    IS_WINDOWS && !/\.[a-z0-9]+$/i.test(command)
      ? [command, ...pathextVariants(command)]
      : [command];
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    for (const variant of variants) {
      const candidate = join(dir, variant);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

/** Resolve a bare command or path to an executable file path, or null. */
export function resolveCommand(command: string): string | null {
  if (looksLikePath(command)) {
    return isExecutableFile(command) ? command : null;
  }
  return searchPath(command);
}

export interface WhichCliOptions {
  /** Explicit per-call override (path or bare name) — wins over everything. */
  cliCommand?: string;
  /** Config-file `adapters.<adapter>.path`. */
  configPath?: string;
}

/**
 * Locate the executable for an adapter. Returns the command string to spawn
 * (an absolute path when discoverable, otherwise the bare binary name so spawn
 * can still resolve it). Honors override > FUC_<ADAPTER>_PATH > config > PATH.
 */
export function whichCli(adapter: string, opts: WhichCliOptions = {}): string {
  const override = opts.cliCommand?.trim();
  if (override) {
    return resolveCommand(override) ?? override;
  }

  const envKey = `FUC_${adapterEnvName(adapter)}_PATH`;
  const envPath = process.env[envKey]?.trim();
  if (envPath) {
    return resolveCommand(envPath) ?? envPath;
  }

  const configPath = opts.configPath?.trim();
  if (configPath) {
    return resolveCommand(configPath) ?? configPath;
  }

  const binary = adapterBinary(adapter);
  return resolveCommand(binary) ?? binary;
}

/** Whether an adapter's CLI can be located on this machine right now. */
export function isCliAvailable(adapter: string, opts: WhichCliOptions = {}): boolean {
  const resolved = whichCli(adapter, opts);
  // A bare name that didn't resolve to a path is "maybe": probe PATH.
  if (looksLikePath(resolved)) return isExecutableFile(resolved);
  return resolveCommand(resolved) != null;
}

function adapterEnvName(adapter: string): string {
  return adapterBinary(adapter).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}
