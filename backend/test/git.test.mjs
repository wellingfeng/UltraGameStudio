import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  authEnvForUrl,
  authenticatedUrl,
  isNetworkFailure,
  normalizeRepoUrl,
  proxyList,
  proxyUrl,
  redact,
  run,
  runGitNet,
} from '../src/git.mjs';

test('run kills and resolves a hung command once timeoutMs elapses', async () => {
  const start = Date.now();
  const res = await run(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 30000)'],
    { timeoutMs: 200 },
  );
  assert.equal(res.code, -1);
  assert.match(res.stderr, /timed out after 200ms/);
  assert.ok(Date.now() - start < 5_000, 'should not wait for the full sleep');
});

test('authenticatedUrl injects token for https', () => {
  const url = authenticatedUrl('https://github.com/me/repo.git', 'tok');
  assert.equal(url, 'https://x-access-token:tok@github.com/me/repo.git');
});

test('authenticatedUrl rewrites scp-form ssh to https when a token is supplied', () => {
  assert.equal(
    authenticatedUrl('git@github.com:me/repo.git', 'tok'),
    'https://x-access-token:tok@github.com/me/repo.git',
  );
});

test('normalizeRepoUrl leaves ssh urls alone without a token', () => {
  assert.equal(
    normalizeRepoUrl('git@github.com:me/repo.git', ''),
    'git@github.com:me/repo.git',
  );
});

test('normalizeRepoUrl rewrites ssh:// urls to https with a token', () => {
  assert.equal(
    normalizeRepoUrl('ssh://git@github.com/me/repo.git', 'tok'),
    'https://github.com/me/repo.git',
  );
});

test('redact strips embedded credentials', () => {
  assert.equal(
    redact('cloning https://x-access-token:secret@github.com/me/repo'),
    'cloning https://***@github.com/me/repo',
  );
});

test('authEnvForUrl injects auth through env-backed git config', () => {
  const env = authEnvForUrl('https://github.com/me/repo.git', 'tok');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GIT_CONFIG_COUNT, '1');
  assert.equal(env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
  assert.match(env.GIT_CONFIG_VALUE_0, /^AUTHORIZATION: basic /);
  assert.equal(JSON.stringify(env).includes('tok'), false);
});

test('redact strips auth headers', () => {
  assert.equal(
    redact('AUTHORIZATION: basic abc123\nok'),
    'AUTHORIZATION: ***\nok',
  );
});

test('proxyList parses a single proxy and a comma-separated list', () => {
  const saved = {
    UGS_RUNNER_GIT_PROXY: process.env.UGS_RUNNER_GIT_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    https_proxy: process.env.https_proxy,
    HTTP_PROXY: process.env.HTTP_PROXY,
    http_proxy: process.env.http_proxy,
  };
  try {
    for (const k of Object.keys(saved)) delete process.env[k];
    assert.deepEqual(proxyList(), []);
    assert.equal(proxyUrl(), null);
    process.env.HTTPS_PROXY = 'http://10.0.0.1:7890';
    assert.deepEqual(proxyList(), ['http://10.0.0.1:7890']);
    process.env.UGS_RUNNER_GIT_PROXY =
      ' http://10.0.0.2:7890 , http://10.0.0.3:7890 ';
    assert.deepEqual(proxyList(), [
      'http://10.0.0.2:7890',
      'http://10.0.0.3:7890',
    ]);
    assert.equal(proxyUrl(), 'http://10.0.0.2:7890');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('authEnvForUrl injects an explicit proxy alongside the token header', () => {
  const env = authEnvForUrl(
    'https://github.com/me/repo.git',
    'tok',
    'http://127.0.0.1:7890',
  );
  const count = Number(env.GIT_CONFIG_COUNT);
  const keys = [];
  const values = [];
  for (let i = 0; i < count; i++) {
    keys.push(env[`GIT_CONFIG_KEY_${i}`]);
    values.push(env[`GIT_CONFIG_VALUE_${i}`]);
  }
  assert.ok(keys.includes('http.proxy'));
  assert.ok(keys.includes('https.proxy'));
  assert.ok(values.includes('http://127.0.0.1:7890'));
  assert.ok(keys.some((k) => k.endsWith('.extraheader')));
  assert.equal(JSON.stringify(env).includes('tok'), false);
});

test('authEnvForUrl omits proxy config when none is passed', () => {
  const env = authEnvForUrl('https://github.com/me/repo.git', 'tok');
  assert.equal(env.GIT_CONFIG_COUNT, '1');
  assert.equal(JSON.stringify(env).includes('http.proxy'), false);
});

test('authEnvForUrl can inject a proxy with no token', () => {
  const env = authEnvForUrl(
    'https://github.com/me/repo.git',
    '',
    'http://127.0.0.1:7890',
  );
  assert.equal(env.GIT_CONFIG_COUNT, '2');
  assert.equal(env.GIT_CONFIG_KEY_0, 'http.proxy');
  assert.equal(env.GIT_CONFIG_KEY_1, 'https.proxy');
});

test('isNetworkFailure recognizes timeouts and disconnects but not auth/branch errors', () => {
  assert.equal(isNetworkFailure({ code: 0 }), false);
  assert.equal(
    isNetworkFailure({
      code: 128,
      stderr: 'fatal: unable to access ...: Failed to connect to github.com port 443',
    }),
    true,
  );
  assert.equal(
    isNetworkFailure({
      code: 128,
      stderr: 'fetch-pack: unexpected disconnect while reading sideband packet',
    }),
    true,
  );
  assert.equal(
    isNetworkFailure({ code: -1, stderr: 'command timed out after 180000ms' }),
    true,
  );
  // Auth and missing-branch failures must NOT be treated as network errors.
  assert.equal(
    isNetworkFailure({ code: 128, stderr: 'remote: Invalid username or password' }),
    false,
  );
  assert.equal(
    isNetworkFailure({
      code: 1,
      stderr: "fatal: couldn't find remote ref nonexistent-branch",
    }),
    false,
  );
});

test('runGitNet succeeds directly without touching proxies', async () => {
  const saved = process.env.UGS_RUNNER_GIT_PROXY;
  try {
    process.env.UGS_RUNNER_GIT_PROXY = 'http://10.255.255.1:7890';
    // `git --version` is a local, network-free command that always exits 0.
    const res = await runGitNet(['--version'], {});
    assert.equal(res.code, 0);
    assert.equal(res.proxyUsed, null);
  } finally {
    if (saved === undefined) delete process.env.UGS_RUNNER_GIT_PROXY;
    else process.env.UGS_RUNNER_GIT_PROXY = saved;
  }
});
