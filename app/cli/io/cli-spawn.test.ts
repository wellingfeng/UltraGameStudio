/**
 * Spawn a real process (a platform shim that re-execs Node on a JS fixture) as a
 * fake `claude` CLI emitting fixed stream-json, then assert spawnCliAgent's argv
 * assembly, stdin handling, JSONL parsing (text accumulation + result extraction
 * + tool_use breadcrumbs), timeout and cancellation behaviour.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnCliAgent } from './cli-spawn';

const IS_WINDOWS = process.platform === 'win32';
let dir: string;

/**
 * Write a JS fixture + a platform shim that execs `node <fixture>` forwarding
 * argv + stdin. Returns the shim path to pass as `cliCommand`, so spawnCliAgent
 * appends claude's flags AFTER it (visible to the fixture's process.argv).
 */
function makeFakeCli(name: string, fixtureBody: string): string {
  const fixturePath = join(dir, `${name}.cjs`);
  writeFileSync(fixturePath, fixtureBody, 'utf8');
  if (IS_WINDOWS) {
    const shim = join(dir, `${name}.cmd`);
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${fixturePath}" %*\r\n`, 'utf8');
    return shim;
  }
  const shim = join(dir, name);
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fixturePath}" "$@"\n`, 'utf8');
  chmodSync(shim, 0o755);
  return shim;
}

// Fake claude: dump argv to a file, read the full prompt from stdin, then emit
// stream-json (tool_use breadcrumb, two assistant text chunks, terminal result).
function fakeClaudeBody(argvOut: string): string {
  return `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(argvOut)}, JSON.stringify(process.argv.slice(2)));
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  const w = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  w({ type: 'assistant', message: { content: [
    { type: 'tool_use', name: 'Read', input: { file_path: 'src/ir.ts' } },
  ] } });
  w({ type: 'assistant', message: { content: [{ type: 'text', text: 'PROMPT[' + input + ']' }] } });
  w({ type: 'assistant', message: { content: [{ type: 'text', text: ' more' }] } });
  w({ type: 'result', result: 'FINAL_RESULT' });
  process.exit(0);
});
`;
}

// Fake that emits only assistant text and NO result event — exercises the
// "return accumulated text when result is empty" branch + a non-zero exit.
function fakeNoResultBody(): string {
  return `
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ACC_ONLY' }] } }) + '\\n');
  process.exit(0);
});
`;
}

// Fake that hangs forever (no output) — exercises idle/hard timeout + kill.
function fakeHangBody(): string {
  return `process.stdin.resume(); setInterval(() => {}, 1000);`;
}

function fakeEnvBody(envOut: string): string {
  return `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(envOut)}, JSON.stringify({
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL || '',
}));
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'result', result: 'OK' }) + '\\n');
});
`;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fuc-spawn-test-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('spawnCliAgent (claude stream-json)', () => {
  it('assembles claude argv, feeds prompt via stdin, prefers result over accumulated text', async () => {
    const argvOut = join(dir, 'argv-claude.json');
    const bin = makeFakeCli('fake-claude', fakeClaudeBody(argvOut));
    const progress: string[] = [];
    const out = await spawnCliAgent('hello-prompt', {
      adapter: 'claude-code',
      cliCommand: bin,
      model: 'sonnet',
      permission: 'full',
      cwd: dir,
      onProgress: (t) => progress.push(t),
    });

    expect(out).toBe('FINAL_RESULT');

    const argv: string[] = JSON.parse(readFileSync(argvOut, 'utf8'));
    // Faithful to lib.rs claude argv assembly.
    expect(argv).toContain('-p');
    expect(argv).toContain('--output-format');
    expect(argv).toContain('stream-json');
    expect(argv).toContain('--verbose');
    expect(argv).toContain('--strict-mcp-config');
    expect(argv).toContain('--dangerously-skip-permissions');
    expect(argv).toContain('--add-dir');
    // sonnet is a valid claude tier → forwarded.
    expect(argv).toContain('--model');
    expect(argv[argv.indexOf('--model') + 1]).toBe('sonnet');

    // tool_use surfaced as a structured tool sentinel; assistant text streamed.
    const joined = progress.join('');
    expect(joined).toContain('<<FUC_TOOL>>');
    expect(joined).toContain('"name":"Read"');
    expect(joined).toContain('"subject":"src/ir.ts"');
    expect(joined).toContain('PROMPT[hello-prompt]');
    expect(joined).toContain(' more');
  });

  it('drops non-claude model labels and readonly maps to plan mode', async () => {
    const argvOut = join(dir, 'argv-claude2.json');
    const bin = makeFakeCli('fake-claude2', fakeClaudeBody(argvOut));
    await spawnCliAgent('p', {
      adapter: 'claude-code',
      cliCommand: bin,
      model: 'kimi-for-coding', // relay label — must NOT be passed as --model
      permission: 'readonly',
      cwd: dir,
    });
    const argv: string[] = JSON.parse(readFileSync(argvOut, 'utf8'));
    expect(argv).not.toContain('--model');
    expect(argv).toContain('--permission-mode');
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('plan');
    expect(argv).not.toContain('--dangerously-skip-permissions');
  });

  it('uses bare mode for Anthropic-compatible relay env so user hooks do not run', async () => {
    const argvOut = join(dir, 'argv-claude-relay.json');
    const bin = makeFakeCli('fake-claude-relay', fakeClaudeBody(argvOut));
    await spawnCliAgent('p', {
      adapter: 'claude-code',
      cliCommand: bin,
      permission: 'full',
      env: {
        ANTHROPIC_API_KEY: 'freecc',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:8766/ch/open_router',
        ANTHROPIC_MODEL: 'z-ai/glm-4.6',
      },
    });
    const argv: string[] = JSON.parse(readFileSync(argvOut, 'utf8'));
    expect(argv).toContain('--bare');
  });

  it('normalizes known provider model env before spawning claude', async () => {
    const envOut = join(dir, 'env-claude-provider.json');
    const bin = makeFakeCli('fake-claude-env', fakeEnvBody(envOut));
    await spawnCliAgent('p', {
      adapter: 'claude-code',
      cliCommand: bin,
      permission: 'full',
      env: {
        ANTHROPIC_API_KEY: 'freecc',
        ANTHROPIC_BASE_URL: 'https://integrate.api.nvidia.com/v1',
        ANTHROPIC_MODEL: 'nemotron-3-super-120b-a12b',
      },
    });
    const env = JSON.parse(readFileSync(envOut, 'utf8'));
    expect(env.ANTHROPIC_MODEL).toBe('nvidia/nemotron-3-super-120b-a12b');
  });

  it('returns accumulated text when no result event is emitted', async () => {
    const bin = makeFakeCli('fake-noresult', fakeNoResultBody());
    const out = await spawnCliAgent('x', {
      adapter: 'claude-code',
      cliCommand: bin,
      cwd: dir,
    });
    expect(out).toBe('ACC_ONLY');
  });

  it('kills the process when the abort signal fires (cancellation)', async () => {
    const bin = makeFakeCli('fake-hang2', fakeHangBody());
    const ctrl = new AbortController();
    const p = spawnCliAgent('x', {
      adapter: 'claude-code',
      cliCommand: bin,
      cwd: dir,
      signal: ctrl.signal,
    });
    setTimeout(() => ctrl.abort(), 200);
    await expect(p).rejects.toThrow(/已由用户中断/);
  }, 5000);
});

describe('spawnCliAgent (codex argv)', () => {
  // Fake codex: dump argv, read stdin, write the final message to the -o sidecar
  // file, then exit. Exercises the codex exec argv + sidecar result path.
  function fakeCodexBody(argvOut: string): string {
    return `
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argvOut)}, JSON.stringify(argv));
const oi = argv.indexOf('-o');
const outPath = oi >= 0 ? argv[oi + 1] : null;
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'codex-progress' } }) + '\\n');
  if (outPath) fs.writeFileSync(outPath, 'CODEX_FINAL');
  process.stdout.write(JSON.stringify({ type: 'turn.completed', status: 'completed' }) + '\\n');
});
`;
  }

  it('assembles codex exec argv and returns the sidecar final message', async () => {
    const argvOut = join(dir, 'argv-codex.json');
    const bin = makeFakeCli('fake-codex', fakeCodexBody(argvOut));
    const out = await spawnCliAgent('codex-prompt', {
      adapter: 'codex',
      cliCommand: bin,
      permission: 'full',
      cwd: dir,
    });
    expect(out).toBe('CODEX_FINAL');
    const argv: string[] = JSON.parse(readFileSync(argvOut, 'utf8'));
    expect(argv).toContain('exec');
    expect(argv).toContain('--json');
    expect(argv).toContain('--skip-git-repo-check');
    expect(argv).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(argv).toContain('-C');
    expect(argv).toContain('-o');
    expect(argv[argv.length - 1]).toBe('-');
  });
});
