/**
 * Objective-check runner for `/ultracode` — turns the planner's
 * {@link DynamicObjectiveCheck}s into ground-truth signals that do NOT depend on
 * the model's self-verdict.
 *
 * Safety model (mirrors the CLI's verify-command policy):
 *  - `file-exists` / `file-contains` are READ-ONLY filesystem assertions and run
 *    unconditionally. They double as deterministic evidence verification: a
 *    worker that claims it produced `path` is checked against the real tree.
 *  - `command` executes MODEL-GENERATED shell, so it is gated behind
 *    `allowCommands` (the CLI's `--auto-verify`). When not allowed it is skipped
 *    with status `'skipped'` and surfaced as a suggested manual check, never run
 *    silently.
 *
 * Path traversal is contained: every `path` is resolved under `cwd` and a check
 * that escapes the working directory is reported as failed, not executed. The
 * resolver accepts host-native paths plus Windows extended-length paths on
 * Windows, and normalizes backslashes in relative paths so planner output stays
 * portable between Windows and macOS/Linux.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { isAbsolute as isWinAbsolute } from 'node:path/win32';
import type { DynamicObjectiveCheck } from '../../src/runtime/dynamicHarness';
import { errMsg } from '../utils/fs';

export interface ObjectiveCheckResult {
  kind: DynamicObjectiveCheck['kind'];
  target: string;
  description?: string;
  status: 'pass' | 'fail' | 'skipped';
  detail: string;
}

export interface ObjectiveChecksReport {
  results: ObjectiveCheckResult[];
  /** Checks that actually ran (skipped command checks excluded). */
  ranCount: number;
  skippedCount: number;
  failedCount: number;
  hasSkippedCommands: boolean;
  /**
   * Combined ground-truth signal from the checks that ran:
   *  - `true`  → at least one check ran and all that ran passed.
   *  - `false` → at least one check ran and at least one failed.
   *  - `null`  → nothing ran (no checks, or all were command checks while
   *    commands were disallowed) → no objective signal to contribute.
   */
  passed: boolean | null;
}

const MAX_FILE_BYTES = 2_000_000;

export async function runObjectiveChecks(
  checks: DynamicObjectiveCheck[] | undefined,
  cwd: string,
  options: { allowCommands: boolean },
): Promise<ObjectiveChecksReport> {
  const results: ObjectiveCheckResult[] = [];
  for (const check of checks ?? []) {
    results.push(await runOne(check, cwd, options.allowCommands));
  }
  const ran = results.filter((r) => r.status !== 'skipped');
  const skipped = results.filter((r) => r.status === 'skipped');
  const failedCount = ran.filter((r) => r.status === 'fail').length;
  return {
    results,
    ranCount: ran.length,
    skippedCount: skipped.length,
    failedCount,
    hasSkippedCommands: skipped.some((r) => r.kind === 'command'),
    passed: ran.length === 0 ? null : failedCount === 0,
  };
}

async function runOne(
  check: DynamicObjectiveCheck,
  cwd: string,
  allowCommands: boolean,
): Promise<ObjectiveCheckResult> {
  const base = { kind: check.kind, description: check.description } as const;
  if (check.kind === 'command') {
    const command = (check.command ?? '').trim();
    if (!allowCommands) {
      return {
        ...base,
        target: command,
        status: 'skipped',
        detail: '命令类检查默认不自动执行（加 --auto-verify 才运行）。',
      };
    }
    return runCommandCheck(command, cwd, base);
  }

  const rawPath = (check.path ?? '').trim();
  const resolved = resolveWithin(cwd, rawPath);
  if (!resolved) {
    return { ...base, target: rawPath, status: 'fail', detail: '路径超出工作目录或为空，已拒绝检查。' };
  }
  if (!existsSync(resolved)) {
    return { ...base, target: rawPath, status: 'fail', detail: '路径不存在。' };
  }
  if (check.kind === 'file-exists') {
    return { ...base, target: rawPath, status: 'pass', detail: '路径存在。' };
  }
  // file-contains
  const needle = check.contains ?? '';
  try {
    const stat = statSync(resolved);
    if (!stat.isFile()) {
      return { ...base, target: rawPath, status: 'fail', detail: '目标不是文件，无法做内容匹配。' };
    }
    if (stat.size > MAX_FILE_BYTES) {
      return { ...base, target: rawPath, status: 'fail', detail: `文件过大（>${MAX_FILE_BYTES} 字节），跳过内容匹配。` };
    }
    const content = readFileSync(resolved, 'utf8');
    return content.includes(needle)
      ? { ...base, target: `${rawPath} ∋ "${clip(needle)}"`, status: 'pass', detail: '文件包含目标字符串。' }
      : { ...base, target: `${rawPath} ∋ "${clip(needle)}"`, status: 'fail', detail: '文件不包含目标字符串。' };
  } catch (err) {
    return { ...base, target: rawPath, status: 'fail', detail: `读取失败：${errMsg(err)}` };
  }
}

function runCommandCheck(
  command: string,
  cwd: string,
  base: { kind: DynamicObjectiveCheck['kind']; description?: string },
): Promise<ObjectiveCheckResult> {
  if (!command) {
    return Promise.resolve({ ...base, target: '', status: 'fail', detail: '命令为空。' });
  }
  return new Promise((resolveResult) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => {
      resolveResult({ ...base, target: command, status: 'fail', detail: `spawn 失败：${errMsg(err)}` });
    });
    child.on('close', (code) => {
      resolveResult(
        code === 0
          ? { ...base, target: command, status: 'pass', detail: 'exitCode=0' }
          : { ...base, target: command, status: 'fail', detail: `exitCode=${code ?? 'unknown'}${stderr.trim() ? ` ${clip(stderr, 160)}` : ''}` },
      );
    });
  });
}

/** Resolve `p` under `cwd`; return null if it escapes the working directory. */
function resolveWithin(cwd: string, p: string): string | null {
  if (!p) return null;
  const normalizedPath = normalizeObjectivePath(p);
  if (!normalizedPath) return null;
  const normalizedCwd = normalizeObjectivePath(cwd);
  if (!normalizedCwd) return null;
  const base = resolve(normalizedCwd);
  const target = isAbsolute(normalizedPath) ? resolve(normalizedPath) : resolve(base, normalizedPath);
  const rel = relative(base, target);
  if (rel === '') return target; // cwd itself
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return target;
}

function normalizeObjectivePath(p: string): string | null {
  const trimmed = p.trim();
  if (!trimmed) return null;
  if (process.platform === 'win32') {
    return normalizeWindowsExtendedPath(trimmed);
  }
  if (isWinAbsolute(trimmed)) return null;
  return isAbsolute(trimmed) ? trimmed : trimmed.replace(/\\/g, '/');
}

function normalizeWindowsExtendedPath(p: string): string {
  if (p.startsWith('\\\\?\\UNC\\')) return `\\\\${p.slice('\\\\?\\UNC\\'.length)}`;
  if (p.startsWith('\\\\?\\')) return p.slice('\\\\?\\'.length);
  return p;
}

function clip(value: string, max = 60): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
