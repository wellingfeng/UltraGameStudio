// @vitest-environment node
/**
 * Codex channel-credential wiring: when the user's own `config.toml` selects a
 * named `model_provider`, UGS must feed the key from 设置 → 模型 into *that
 * provider's* credential slot (`-c model_providers.<provider>.env_key=…` plus
 * the matching env var) instead of letting codex fall back to the user's global
 * `<CODEX_HOME|~/.codex>/auth.json` — the stale file that made every key edit a
 * no-op (the relay kept answering with the old key's error).
 *
 * The user's CODEX_HOME is deliberately left in place: replacing it would hide
 * `$CODEX_HOME/skills`, `sessions` and `history` from the CLI.
 *
 * The child process is stubbed at the `child_process.spawn` boundary so the
 * assertions also run inside sandboxes that forbid real process creation.
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

import { spawnCliAgent } from './cli-spawn';

const spawnMock = vi.mocked(spawn);

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ugs-codex-cred-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Stub the next spawn: capture its env/argv and settle it like a real CLI. */
function stubSpawn(): { env: NodeJS.ProcessEnv; argv: string[] } {
  const captured = { env: {} as NodeJS.ProcessEnv, argv: [] as string[] };
  spawnMock.mockImplementationOnce(((
    _command: string,
    argv: readonly string[],
    options: { env?: NodeJS.ProcessEnv },
  ) => {
    captured.argv = [...argv];
    captured.env = options.env ?? {};
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    child.stdout = Readable.from([]);
    child.stderr = Readable.from([]);
    child.stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    child.kill = () => true;
    setImmediate(() => {
      child.emit('exit', 0, null);
      child.emit('close', 0, null);
    });
    return child;
  }) as never);
  return captured;
}

/** A user codex home: named provider routing + a stale global credential. */
function writeUserCodexHome(name: string): string {
  const home = join(dir, name);
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, 'config.toml'),
    [
      'model_provider = "kuro"',
      'model = "gpt-6-astra"',
      '[model_providers.kuro]',
      'base_url = "https://ai-gateway.kurogames.com/v1"',
      'wire_api = "responses"',
      'requires_openai_auth = true',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(home, 'auth.json'),
    JSON.stringify({
      tokens: { access_token: 'global-stale' },
      OPENAI_API_KEY: 'kuro-old-key',
    }),
    'utf8',
  );
  return home;
}

/** Run the spawn with a controlled env, then restore the process env. */
async function withEnv(
  overlay: Record<string, string>,
  vars: { codexHome: string; ugsHome: string },
  run: (captured: { env: NodeJS.ProcessEnv; argv: string[] }) => void,
): Promise<void> {
  const previous = {
    CODEX_HOME: process.env.CODEX_HOME,
    UGS_HOME: process.env.UGS_HOME,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    UGS_CODEX_CHANNEL_KEY: process.env.UGS_CODEX_CHANNEL_KEY,
  };
  process.env.CODEX_HOME = vars.codexHome;
  process.env.UGS_HOME = vars.ugsHome;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.UGS_CODEX_CHANNEL_KEY;
  try {
    const captured = stubSpawn();
    await spawnCliAgent('codex-prompt', {
      adapter: 'codex',
      // Any existing file works: whichCli only resolves the path, the stub
      // never launches it.
      cliCommand: process.execPath,
      permission: 'full',
      cwd: dir,
      env: overlay,
    }).catch(() => {
      /* the stub emits no result event, so the run may settle as a failure */
    });
    run(captured);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('spawnCliAgent codex credential wiring', () => {
  it('points the selected provider at the channel key, never at the global auth.json', async () => {
    const userCodexHome = writeUserCodexHome('user-codex-home');
    const ugsHome = join(dir, 'ugs-home');

    await withEnv(
      { OPENAI_API_KEY: 'kuro-new-key', OPENAI_BASE_URL: 'https://ai-gateway.kurogames.com/v1' },
      { codexHome: userCodexHome, ugsHome },
      (captured) => {
        // codex reads its credential from the variable UGS just exported…
        expect(captured.env.UGS_CODEX_CHANNEL_KEY).toBe('kuro-new-key');
        // …because the provider's env_key was repointed at it.
        const override = captured.argv.find((arg) =>
          arg.startsWith('model_providers.kuro.env_key='),
        );
        expect(override).toBe('model_providers.kuro.env_key="UGS_CODEX_CHANNEL_KEY"');
        expect(captured.argv).toContain('-c');

        // The plain OPENAI_* overlay stays dropped: injecting it would make codex
        // resolve a different provider/wire than the configured relay.
        expect(captured.env.OPENAI_API_KEY).toBeUndefined();
        expect(captured.env.OPENAI_BASE_URL).toBeUndefined();

        // The user's own home (skills/sessions/history) is untouched, and their
        // stale global credential is neither used nor rewritten.
        expect(captured.env.CODEX_HOME).toBe(userCodexHome);
        expect(readFileSync(join(userCodexHome, 'auth.json'), 'utf8')).toContain('kuro-old-key');
        expect(existsSync(join(ugsHome, 'codex-home'))).toBe(false);
      },
    );
  });

  it('leaves codex entirely alone when the channel carries no key', async () => {
    const userCodexHome = writeUserCodexHome('user-codex-home-nokey');
    const ugsHome = join(dir, 'ugs-home-nokey');

    await withEnv({}, { codexHome: userCodexHome, ugsHome }, (captured) => {
      expect(captured.env.UGS_CODEX_CHANNEL_KEY).toBeUndefined();
      expect(captured.argv.some((arg) => arg.includes('env_key='))).toBe(false);
      expect(captured.env.CODEX_HOME).toBe(userCodexHome);
      expect(existsSync(join(ugsHome, 'codex-home'))).toBe(false);
    });
  });

  it('does not override a provider the config never declares', async () => {
    const home = join(dir, 'user-codex-home-ghost');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.toml'), 'model_provider = "ghost"\n', 'utf8');
    const ugsHome = join(dir, 'ugs-home-ghost');

    await withEnv(
      { OPENAI_API_KEY: 'kuro-new-key' },
      { codexHome: home, ugsHome },
      (captured) => {
        // Writing `env_key` into an undeclared provider would break the turn, so
        // the override is skipped and codex keeps its own resolution.
        expect(captured.argv.some((arg) => arg.includes('env_key='))).toBe(false);
        expect(captured.env.CODEX_HOME).toBe(home);
        expect(existsSync(join(ugsHome, 'codex-home'))).toBe(false);
      },
    );
  });
});
