/**
 * Spawn a real process (a platform shim that re-execs Node on a JS fixture) as a
 * fake `claude` CLI emitting fixed stream-json, then assert spawnCliAgent's argv
 * assembly, stdin handling, JSONL parsing (text accumulation + result extraction
 * + tool_use breadcrumbs), timeout and cancellation behaviour.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SkillNativeToolEvent } from '../../src/runtime/skills/types';
import {
  CODEX_CHANNEL_KEY_ENV,
  codexConfigSelectsNamedModelProvider,
  codexProviderForCredentialOverride,
  spawnCliAgent,
} from './cli-spawn';

const IS_WINDOWS = process.platform === 'win32';
let dir: string;
const ambientCatalogEnv: Record<string, string | undefined> = {};

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

describe('native compression stream', () => {
  it('forwards confirmed compression without leaking it into the final answer', async () => {
    const cli = makeFakeCli('compression-fixture', `
process.stdin.resume();
process.stdin.on('end', () => {
  const w = o => process.stdout.write(JSON.stringify(o) + '\\n');
  w({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto' } });
  w({ type: 'result', result: '回答' });
});`);
    const chunks: string[] = [];
    const answer = await spawnCliAgent('继续', { adapter: 'claude-code',
      cliCommand: cli, onProgress: (text) => chunks.push(text), timeoutSeconds: 10,
    });
    expect(answer).toBe('回答');
    expect(chunks.join('')).toContain('ugs_context_compaction');
  });
});

// Fake claude: answers `--help`, dumps argv to a file, reads the full prompt
// from stdin, then emits stream-json (tool_use breadcrumb, two assistant text
// chunks, terminal result).
function fakeClaudeBody(argvOut: string, helpText = 'Options:\n  --bare\n'): string {
  return `
const fs = require('node:fs');
if (process.argv.slice(2).includes('--help')) {
  process.stdout.write(${JSON.stringify(helpText)});
  process.exit(0);
}
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
  for (const key of ['UGS_TOOL_CATALOG_SCOPE', 'UGS_TOOLS_CLI', 'UGS_SESSION_ID', 'UGS_WORKSPACE_ID']) {
    ambientCatalogEnv[key] = process.env[key];
    delete process.env[key];
  }
  dir = mkdtempSync(join(tmpdir(), 'ugs-spawn-test-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(ambientCatalogEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('spawnCliAgent (claude stream-json)', () => {
  it('passes automatic catalogue guidance and session identity to the spawned agent', async () => {
    const output = join(dir, 'catalog-agent-access.json');
    const scope = { workspaceId: 'w', sessionId: 's', agentId: 'claude-code', providerId: 'p', channelId: 'c', model: 'sonnet' };
    const bin = makeFakeCli('catalog-agent-access', `
const fs = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({ prompt: input, script: process.env.UGS_TOOLS_CLI, scope: process.env.UGS_TOOL_CATALOG_SCOPE }));
  process.stdout.write(JSON.stringify({ type: 'result', result: 'OK' }) + '\\n');
});`);
    const result = await spawnCliAgent('查找编译工具', { adapter: 'claude-code', cliCommand: bin, cwd: dir,
      env: { UGS_HOME: join(dir, 'catalog-agent-home'), UGS_TOOL_CATALOG_SCOPE: JSON.stringify(scope) } });
    expect(result).toBe('OK');
    const observed = JSON.parse(readFileSync(output, 'utf8'));
    expect(observed.prompt).toContain('tools search');
    expect(observed.prompt).toContain('无需用户打开面板');
    expect(observed.prompt.endsWith('查找编译工具')).toBe(true);
    expect(observed.script).toMatch(/ugs\.mjs$/);
    expect(JSON.parse(observed.scope)).toEqual(scope);
  });
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
    // MCP is on by default now: no --strict-mcp-config unless explicitly disabled.
    expect(argv).not.toContain('--strict-mcp-config');
    expect(argv).toContain('--dangerously-skip-permissions');
    expect(argv).toContain('--add-dir');
    // sonnet is a valid claude tier → forwarded.
    expect(argv).toContain('--model');
    expect(argv[argv.indexOf('--model') + 1]).toBe('sonnet');

    // tool_use surfaced as a structured tool sentinel; assistant text streamed.
    const joined = progress.join('');
    expect(joined).toContain('<<UGS_TOOL>>');
    expect(joined).toContain('"name":"Read"');
    expect(joined).toContain('"subject":"src/ir.ts"');
    expect(joined).toContain('PROMPT[hello-prompt]');
    expect(joined).toContain(' more');
  });

  it('injects project MCP servers into claude mcp-config', async () => {
    const projectDir = join(dir, 'claude-mcp-project');
    const ugsHome = join(dir, 'ugs-home-claude');
    mkdirSync(projectDir, { recursive: true });
    const workspacesDir = join(ugsHome, 'workspaces');
    mkdirSync(workspacesDir, { recursive: true });
    writeFileSync(
      join(workspacesDir, 'index.json'),
      JSON.stringify([
        {
          id: 'ws1',
          path: projectDir,
          metadata: {
            projectSettings: {
              mcp: {
                enabled: true,
                servers: [
                  {
                    id: 'ue-mcp-for-all-versions',
                    enabled: true,
                    transport: 'stdio',
                    command: 'C:\\tools\\ue-mcp.exe',
                  },
                ],
              },
            },
          },
        },
      ]),
      'utf8',
    );
    const previousUgsHome = process.env.UGS_HOME;
    process.env.UGS_HOME = ugsHome;
    try {
      const argvOut = join(dir, 'argv-claude-mcp.json');
      const bin = makeFakeCli('fake-claude-mcp', fakeClaudeBody(argvOut));
      await spawnCliAgent('p', {
        adapter: 'claude-code',
        cliCommand: bin,
        permission: 'full',
        cwd: projectDir,
      });
      const argv: string[] = JSON.parse(readFileSync(argvOut, 'utf8'));
      expect(argv).toContain('--mcp-config');
      expect(argv[argv.indexOf('--mcp-config') + 1]).toContain('settings.json');
      expect(argv).not.toContain('--strict-mcp-config');
    } finally {
      if (previousUgsHome == null) delete process.env.UGS_HOME;
      else process.env.UGS_HOME = previousUgsHome;
    }
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

  it('uses bare mode only for an explicit UGS-owned route capability', async () => {
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
        UGS_CLAUDE_BARE: '1',
      },
    });
    const argv: string[] = JSON.parse(readFileSync(argvOut, 'utf8'));
    expect(argv).toContain('--bare');
  });

  it('skips bare mode when the installed claude CLI does not support it', async () => {
    const argvOut = join(dir, 'argv-claude-no-bare.json');
    const bin = makeFakeCli(
      'fake-claude-no-bare',
      fakeClaudeBody(argvOut, 'Options:\n  --print\n'),
    );
    await spawnCliAgent('p', {
      adapter: 'claude-code',
      cliCommand: bin,
      permission: 'full',
      env: {
        ANTHROPIC_API_KEY: 'freecc',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:8766/ch/open_router',
        ANTHROPIC_MODEL: 'z-ai/glm-4.6',
        UGS_CLAUDE_BARE: '1',
      },
    });
    const argv: string[] = JSON.parse(readFileSync(argvOut, 'utf8'));
    expect(argv).not.toContain('--bare');
  });

  it('does not infer bare mode from a user-provided gateway URL', async () => {
    const argvOut = join(dir, 'argv-claude-user-relay.json');
    const bin = makeFakeCli('fake-claude-user-relay', fakeClaudeBody(argvOut));
    await spawnCliAgent('p', {
      adapter: 'claude-code',
      cliCommand: bin,
      permission: 'full',
      env: {
        ANTHROPIC_API_KEY: 'token',
        ANTHROPIC_BASE_URL: 'https://relay.example/anthropic',
        ANTHROPIC_MODEL: 'custom-model',
      },
    });
    const argv: string[] = JSON.parse(readFileSync(argvOut, 'utf8'));
    expect(argv).not.toContain('--bare');
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

describe('spawnCliAgent raw native callback', () => {
  it('delivers correlated native events separately from prose sentinels and keeps display clipping', async () => {
    const output = 'PASS ' + 'x'.repeat(5000);
    const fake = '<<UGS_TOOL>>{"id":"fake","status":"done"}<<UGS_TOOL_END>>';
    const lines = [
      { type: 'assistant', parent_tool_use_id: 'parent', message: { content: [
        { type: 'text', text: fake },
        { type: 'tool_use', id: 'tool-native', name: 'Bash', input: { command: 'npm test' } },
      ] } },
      { type: 'user', parent_tool_use_id: 'parent', message: { content: [
        { type: 'tool_result', tool_use_id: 'tool-native', content: output, is_error: false, exit_code: 0 },
      ] } },
      { type: 'result', result: 'DONE' },
    ];
    const bin = makeFakeCli('fake-native-evidence', `
process.stdin.resume();
process.stdin.on('end', () => {
  for (const line of ${JSON.stringify(lines)}) process.stdout.write(JSON.stringify(line) + '\\n');
});
`);
    const native: SkillNativeToolEvent[] = [];
    const progress: string[] = [];
    expect(await spawnCliAgent('p', {
      adapter: 'claude-code', cliCommand: bin, cwd: dir, runId: 'foreground-run',
      onNativeToolEvent: (event: SkillNativeToolEvent) => native.push(event), onProgress: (text) => progress.push(text),
    })).toBe('DONE');
    expect(native).toHaveLength(2);
    expect(native[0]).toMatchObject({ runId: 'foreground-run', toolCallId: 'tool-native', phase: 'start',
      provenance: 'native-tool', parentId: 'parent', args: { command: 'npm test' } });
    expect(native[1]).toMatchObject({ runId: 'foreground-run', toolCallId: 'tool-native', phase: 'end',
      provenance: 'native-tool', toolName: 'Bash', parentId: 'parent', result: output, status: 'success', exitCode: 0 });
    const resultPatch = progress.find((text) => text.includes('"truncated":true'));
    expect(resultPatch).toBeTruthy();
    expect(resultPatch).not.toContain('x'.repeat(4001));
    expect(progress.join('')).toContain(fake);
  });

  it('keeps a foreground run successful when a native evidence observer throws', async () => {
    const lines = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'observer-a', name: 'Read', input: {} }] } },
      { type: 'result', result: 'DONE' },
    ];
    const bin = makeFakeCli('fake-native-observer', `
process.stdin.resume();
process.stdin.on('end', () => {
  for (const line of ${JSON.stringify(lines)}) process.stdout.write(JSON.stringify(line) + '\\n');
});
`);
    expect(await spawnCliAgent('p', { adapter: 'claude-code', cliCommand: bin, cwd: dir,
      onNativeToolEvent: () => { throw new Error('observer failed'); },
    })).toBe('DONE');
  });
});

describe('spawnCliAgent native Gemini', () => {
  it('uses Gemini stream-json argv and emits native tool events independently of messages', async () => {
    const argvOut = join(dir, 'argv-gemini-native.json');
    const lines = [
      { type: 'tool_use', tool_id: 'gem-native', tool_name: 'run_shell_command', parameters: { command: 'npm test' } },
      { type: 'tool_result', tool_id: 'gem-native', status: 'success', output: 'PASS', exit_code: 0 },
      { type: 'message', role: 'assistant', content: 'GEMINI_FINAL' },
      { type: 'result', status: 'success' },
    ];
    const bin = makeFakeCli('fake-gemini-native', `
require('node:fs').writeFileSync(${JSON.stringify(argvOut)}, JSON.stringify(process.argv.slice(2)));
process.stdin.resume();
process.stdin.on('end', () => {
  for (const line of ${JSON.stringify(lines)}) process.stdout.write(JSON.stringify(line) + '\\n');
});
`);
    const events: SkillNativeToolEvent[] = [];
    expect(await spawnCliAgent('request', { adapter: 'gemini', cliCommand: bin, cwd: dir, permission: 'full',
      runId: 'gem-run', onNativeToolEvent: (event) => events.push(event) })).toBe('GEMINI_FINAL');
    const argv: string[] = JSON.parse(readFileSync(argvOut, 'utf8'));
    expect(argv).toContain('--output-format');
    expect(argv).toContain('stream-json');
    expect(argv).toContain('--approval-mode');
    expect(argv[argv.indexOf('--approval-mode') + 1]).toBe('yolo');
    expect(argv).not.toContain('--dangerously-skip-permissions');
    expect(argv).not.toContain('--add-dir');
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ runId: 'gem-run', toolCallId: 'gem-native', phase: 'end', provenance: 'native-tool', exitCode: 0 });
  });
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
  process.stdout.write(JSON.stringify({ type: 'turn.completed', status: 'completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 5 } }) + '\\n');
});
`;
  }

  it('assembles codex exec argv and returns the sidecar final message', async () => {
    const argvOut = join(dir, 'argv-codex.json');
    const bin = makeFakeCli('fake-codex', fakeCodexBody(argvOut));
    const usage: unknown[] = [];
    const out = await spawnCliAgent('codex-prompt', {
      adapter: 'codex',
      cliCommand: bin,
      permission: 'full',
      cwd: dir,
      onUsage: (payload) => usage.push(payload),
    });
    expect(out).toBe('CODEX_FINAL');
    expect(usage).toEqual([
      { input_tokens: 100, cached_input_tokens: 40, output_tokens: 5 },
    ]);
    const argv: string[] = JSON.parse(readFileSync(argvOut, 'utf8'));
    expect(argv).toContain('exec');
    expect(argv).toContain('--json');
    expect(argv).toContain('--skip-git-repo-check');
    expect(argv).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(argv).toContain('-C');
    expect(argv).toContain('-o');
    expect(argv[argv.length - 1]).toBe('-');
  });

  it('streams codex file_change items as structured tool events with paths', async () => {
    const argvOut = join(dir, 'argv-codex-file-change.json');
    const bin = makeFakeCli(
      'fake-codex-file-change',
      `
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argvOut)}, JSON.stringify(argv));
const oi = argv.indexOf('-o');
const outPath = oi >= 0 ? argv[oi + 1] : null;
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'fc1',
      type: 'file_change',
      status: 'completed',
      changes: [{ path: 'app/src/lib/sessionFiles.ts', status: 'modified' }],
      output: '*** Update File: app/src/lib/sessionFiles.ts'
    }
  }) + '\\n');
  if (outPath) fs.writeFileSync(outPath, 'DONE');
  process.stdout.write(JSON.stringify({ type: 'turn.completed', status: 'completed' }) + '\\n');
});
`,
    );
    const progress: string[] = [];

    await spawnCliAgent('codex-prompt', {
      adapter: 'codex',
      cliCommand: bin,
      permission: 'full',
      cwd: dir,
      onProgress: (t) => progress.push(t),
    });

    const joined = progress.join('');
    expect(joined).toContain('<<UGS_TOOL>>');
    expect(joined).toContain('"name":"file_change"');
    expect(joined).toContain('"path":"app/src/lib/sessionFiles.ts"');
  });

  it('injects project MCP servers into codex exec config overrides', async () => {
    const projectDir = join(dir, 'codex-mcp-project');
    const ugsHome = join(dir, 'ugs-home');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, '.keep'), '', 'utf8');
    const workspacesDir = join(ugsHome, 'workspaces');
    mkdirSync(workspacesDir, { recursive: true });
    writeFileSync(
      join(workspacesDir, 'index.json'),
      JSON.stringify([
        {
          id: 'ws1',
          path: projectDir,
          name: 'Project',
          updatedAt: 1,
          sessionCount: 0,
          metadata: {
            projectSettings: {
              schemaVersion: 1,
              mcp: {
                enabled: true,
                servers: [
                  {
                    id: 'ue-mcp-for-all-versions',
                    enabled: true,
                    transport: 'stdio',
                    command: 'C:\\tools\\ue-mcp.exe',
                    args: ['--host', '{workspace}'],
                    env: { UE_PROJECT: '{workspace}' },
                  },
                ],
              },
            },
          },
        },
      ]),
      'utf8',
    );
    const previousUgsHome = process.env.UGS_HOME;
    process.env.UGS_HOME = ugsHome;
    try {
      const argvOut = join(dir, 'argv-codex-mcp.json');
      const bin = makeFakeCli('fake-codex-mcp', fakeCodexBody(argvOut));
      await spawnCliAgent('codex-prompt', {
        adapter: 'codex',
        cliCommand: bin,
        permission: 'full',
        cwd: projectDir,
      });
      const argv: string[] = JSON.parse(readFileSync(argvOut, 'utf8'));
      expect(argv).toContain('mcp_servers.ue-mcp-for-all-versions.command="C:\\\\tools\\\\ue-mcp.exe"');
      expect(argv).toContain(
        `mcp_servers.ue-mcp-for-all-versions.args=["--host","${projectDir.replace(/\\/g, '\\\\')}"]`,
      );
      expect(argv).toContain(
        `mcp_servers.ue-mcp-for-all-versions.env.UE_PROJECT="${projectDir.replace(/\\/g, '\\\\')}"`,
      );
    } finally {
      if (previousUgsHome == null) delete process.env.UGS_HOME;
      else process.env.UGS_HOME = previousUgsHome;
    }
  });
  it('overrides only a named provider the config actually declares', () => {
    const relay = [
      'model_provider = "relay"',
      'model = "gpt-6-astra"',
      '[mcp_servers.ue]',
      'command = "ue-mcp.exe"',
      '[model_providers.relay]',
      'name = "packycode"',
      'base_url = "https://api.packycode.com/v1"',
      'wire_api = "responses"',
      'requires_openai_auth = true',
      '',
    ].join('\n');
    expect(codexProviderForCredentialOverride(relay)).toBe('relay');

    // The provider table must exist: `-c model_providers.<p>.env_key=…` aimed at
    // a provider codex cannot resolve would break the turn outright.
    expect(codexProviderForCredentialOverride('model_provider = "ghost"\n')).toBeNull();
    // Default routing takes the plain OPENAI_API_KEY overlay instead.
    expect(codexProviderForCredentialOverride('model_provider = "openai"\n')).toBeNull();
    expect(codexProviderForCredentialOverride('model = "gpt-5.1"\n')).toBeNull();
  });

  it('routes the channel key through a stable UGS-owned env var', () => {
    // The `-c` override and the exported variable must agree, and the name must
    // be UGS-owned so it can never collide with a user's own key variable.
    expect(CODEX_CHANNEL_KEY_ENV).toBe('UGS_CODEX_CHANNEL_KEY');
    expect(`model_providers.relay.env_key="${CODEX_CHANNEL_KEY_ENV}"`).toBe(
      'model_providers.relay.env_key="UGS_CODEX_CHANNEL_KEY"',
    );
  });
});

describe('spawnCliAgent (grok argv)', () => {
  // Fake grok: dump argv, read the prompt from --prompt-file, then emit a
  // claude-shaped terminal result (streaming-messages-json reuses that parser).
  function fakeGrokBody(argvOut: string): string {
    return `
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argvOut)}, JSON.stringify(argv));
const pi = argv.indexOf('--prompt-file');
const prompt = pi >= 0 ? fs.readFileSync(argv[pi + 1], 'utf8') : '';
process.stdout.write(JSON.stringify({ type: 'result', result: 'GROK_RESULT:' + prompt }) + '\\n');
process.exit(0);
`;
  }

  it('assembles grok argv, passes prompt via --prompt-file, parses result', async () => {
    const argvOut = join(dir, 'argv-grok.json');
    const bin = makeFakeCli('fake-grok', fakeGrokBody(argvOut));
    const out = await spawnCliAgent('grok-prompt', {
      adapter: 'grok',
      cliCommand: bin,
      model: 'grok-4.6',
      permission: 'full',
      cwd: dir,
    });

    expect(out).toBe('GROK_RESULT:grok-prompt');

    const argv: string[] = JSON.parse(readFileSync(argvOut, 'utf8'));
    // grok ≥ v1.0.13 requires `-p` to take an inline value; we use --prompt-file
    // instead, so `-p` must NOT appear in argv.
    expect(argv).not.toContain('-p');
    expect(argv).toContain('--output-format');
    expect(argv[argv.indexOf('--output-format') + 1]).toBe('streaming-messages-json');
    expect(argv).toContain('--model');
    expect(argv[argv.indexOf('--model') + 1]).toBe('grok-4.6');
    expect(argv).toContain('--permission-mode');
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
    expect(argv).toContain('--cwd');
    expect(argv).toContain('--prompt-file');
    // Note: --prompt-file points at a temp dir that spawnCliAgent cleans up on
    // settle, so the file is already gone by the time we get here. The fake
    // grok body already echoed the prompt back into `out` above, which proves
    // the file existed and carried 'grok-prompt'.
    const promptPath = argv[argv.indexOf('--prompt-file') + 1];
    expect(promptPath).toMatch(/ultragamestudio-grok-.*prompt\.txt$/);
  });

  it('maps readonly to plan mode and omits permission-mode for ask', async () => {
    const argvOut1 = join(dir, 'argv-grok-ro.json');
    const bin1 = makeFakeCli('fake-grok-ro', fakeGrokBody(argvOut1));
    await spawnCliAgent('p', {
      adapter: 'grok',
      cliCommand: bin1,
      permission: 'readonly',
      cwd: dir,
    });
    const argv1: string[] = JSON.parse(readFileSync(argvOut1, 'utf8'));
    expect(argv1[argv1.indexOf('--permission-mode') + 1]).toBe('plan');

    const argvOut2 = join(dir, 'argv-grok-ask.json');
    const bin2 = makeFakeCli('fake-grok-ask', fakeGrokBody(argvOut2));
    await spawnCliAgent('p', {
      adapter: 'grok',
      cliCommand: bin2,
      permission: 'ask',
      cwd: dir,
    });
    const argv2: string[] = JSON.parse(readFileSync(argvOut2, 'utf8'));
    expect(argv2).not.toContain('--permission-mode');
  });

  it('drops Claude tier model labels for grok', async () => {
    const argvOut = join(dir, 'argv-grok-model.json');
    const bin = makeFakeCli('fake-grok-model', fakeGrokBody(argvOut));
    await spawnCliAgent('p', {
      adapter: 'grok',
      cliCommand: bin,
      model: 'opus', // Claude tier — must NOT be passed as --model
      cwd: dir,
    });
    const argv: string[] = JSON.parse(readFileSync(argvOut, 'utf8'));
    expect(argv).not.toContain('--model');
  });
});

describe('codexConfigSelectsNamedModelProvider', () => {
  it('detects a custom relay model_provider (packyapi layout)', () => {
    expect(
      codexConfigSelectsNamedModelProvider(
        'model_provider = "sss"\nmodel = "gpt-5.6-sol"\n' +
          '[model_providers.sss]\nbase_url = "https://www.packyapi.com/v1"\n' +
          'wire_api = "responses"\n',
      ),
    ).toBe(true);
  });

  it('returns false for no/dropped/openai model_provider', () => {
    expect(codexConfigSelectsNamedModelProvider('model = "gpt-5.6-sol"\n')).toBe(false);
    expect(codexConfigSelectsNamedModelProvider('model_provider = "openai"\n')).toBe(false);
    expect(codexConfigSelectsNamedModelProvider('model_provider = ""\n')).toBe(false);
    expect(codexConfigSelectsNamedModelProvider('not valid toml [')).toBe(false);
  });
});
