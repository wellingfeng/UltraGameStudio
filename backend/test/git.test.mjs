import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  authEnvForUrl,
  authenticatedUrl,
  gitRetryCount,
  httpRobustnessConfig,
  isGithubUrl,
  isNetworkFailure,
  mirrorList,
  normalizeRepoUrl,
  preferMirrorFirst,
  proxyList,
  proxyUrl,
  redact,
  run,
  runGitNet,
} from '../src/git.mjs';

/** Pull the GIT_CONFIG_KEY_n and GIT_CONFIG_VALUE_n pairs out of an env object. */
function configEntries(env) {
  const count = Number(env.GIT_CONFIG_COUNT ?? 0);
  const entries = [];
  for (let i = 0; i < count; i++) {
    entries.push([env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);
  }
  return entries;
}

test('run kills and resolves a command that produces no output for timeoutMs', async () => {
  const start = Date.now();
  const res = await run(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 30000)'],
    { timeoutMs: 200 },
  );
  assert.equal(res.code, -1);
  assert.match(res.stderr, /stalled \(no output for 200ms\)/);
  assert.ok(Date.now() - start < 5_000, 'should not wait for the full sleep');
});

test('run does not kill a slow command that keeps emitting output', async () => {
  // Emits a line every 100ms for ~600ms, then exits. The idle timeout (250ms)
  // must reset on each line so the command runs to completion instead of dying.
  const script =
    "let n=0;const t=setInterval(()=>{process.stdout.write('tick '+(++n)+'\\n');if(n>=6){clearInterval(t);process.exit(0);}},100);";
  const res = await run(process.execPath, ['-e', script], { timeoutMs: 250 });
  assert.equal(res.code, 0);
  assert.match(res.stdout, /tick 6/);
  assert.doesNotMatch(res.stderr, /stalled/);
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
  const entries = configEntries(env);
  const header = entries.find(([k]) => k === 'http.https://github.com/.extraheader');
  assert.ok(header, 'auth header entry present');
  assert.match(header[1], /^AUTHORIZATION: basic /);
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
  assert.equal(JSON.stringify(env).includes('http.proxy'), false);
  const keys = configEntries(env).map(([k]) => k);
  assert.ok(keys.some((k) => k.endsWith('.extraheader')));
});

test('authEnvForUrl can inject a proxy with no token', () => {
  const env = authEnvForUrl(
    'https://github.com/me/repo.git',
    '',
    'http://127.0.0.1:7890',
  );
  const keys = configEntries(env).map(([k]) => k);
  assert.ok(keys.includes('http.proxy'));
  assert.ok(keys.includes('https.proxy'));
  assert.ok(!keys.some((k) => k.endsWith('.extraheader')));
});

test('httpRobustnessConfig pins HTTP/1.1 and a large postBuffer by default', () => {
  const saved = process.env.UGS_RUNNER_GIT_HTTP1;
  try {
    delete process.env.UGS_RUNNER_GIT_HTTP1;
    const cfg = Object.fromEntries(httpRobustnessConfig());
    assert.equal(cfg['http.version'], 'HTTP/1.1');
    assert.ok(Number(cfg['http.postBuffer']) >= 100_000_000);
    // The robustness config rides along on every authEnvForUrl invocation.
    const env = authEnvForUrl('https://github.com/me/repo.git', 'tok');
    const keys = configEntries(env).map(([k]) => k);
    assert.ok(keys.includes('http.version'));
    assert.ok(keys.includes('http.postBuffer'));
  } finally {
    if (saved === undefined) delete process.env.UGS_RUNNER_GIT_HTTP1;
    else process.env.UGS_RUNNER_GIT_HTTP1 = saved;
  }
});

test('httpRobustnessConfig can be disabled via UGS_RUNNER_GIT_HTTP1=0', () => {
  const saved = process.env.UGS_RUNNER_GIT_HTTP1;
  try {
    process.env.UGS_RUNNER_GIT_HTTP1 = '0';
    assert.deepEqual(httpRobustnessConfig(), []);
  } finally {
    if (saved === undefined) delete process.env.UGS_RUNNER_GIT_HTTP1;
    else process.env.UGS_RUNNER_GIT_HTTP1 = saved;
  }
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
    isNetworkFailure({
      code: -1,
      stderr: 'fatal: unable to access ...: command timed out after 180000ms',
    }),
    true,
  );
  // The two symptoms seen against github.com from Tencent Cloud.
  assert.equal(
    isNetworkFailure({
      code: 128,
      stderr:
        "fatal: unable to access 'https://github.com/me/repo.git/': GnuTLS recv error (-110): The TLS connection was non-properly terminated.",
    }),
    true,
  );
  assert.equal(
    isNetworkFailure({
      code: 128,
      stderr:
        'error: RPC failed; curl 16 Error in the HTTP2 framing layer\nfatal: expected flush after ref listing',
    }),
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

test('gitRetryCount defaults to 2 and honors UGS_RUNNER_GIT_RETRIES', () => {
  const saved = process.env.UGS_RUNNER_GIT_RETRIES;
  try {
    delete process.env.UGS_RUNNER_GIT_RETRIES;
    assert.equal(gitRetryCount(), 2);
    process.env.UGS_RUNNER_GIT_RETRIES = '0';
    assert.equal(gitRetryCount(), 0);
    process.env.UGS_RUNNER_GIT_RETRIES = '5';
    assert.equal(gitRetryCount(), 5);
    process.env.UGS_RUNNER_GIT_RETRIES = 'nonsense';
    assert.equal(gitRetryCount(), 2);
  } finally {
    if (saved === undefined) delete process.env.UGS_RUNNER_GIT_RETRIES;
    else process.env.UGS_RUNNER_GIT_RETRIES = saved;
  }
});

test('mirrorList ships CN GitHub accelerators by default', () => {
  const saved = process.env.UGS_RUNNER_GIT_MIRROR;
  try {
    delete process.env.UGS_RUNNER_GIT_MIRROR;
    const list = mirrorList();
    assert.ok(list.length >= 3, 'has a few built-in mirrors');
    assert.ok(
      list.every((m) => m.startsWith('https://') && m.endsWith('/')),
      'each mirror is an https prefix ending in /',
    );
  } finally {
    if (saved === undefined) delete process.env.UGS_RUNNER_GIT_MIRROR;
    else process.env.UGS_RUNNER_GIT_MIRROR = saved;
  }
});

test('mirrorList honors a custom list and can be disabled', () => {
  const saved = process.env.UGS_RUNNER_GIT_MIRROR;
  try {
    process.env.UGS_RUNNER_GIT_MIRROR = 'https://m1.example/ , https://m2.example';
    assert.deepEqual(mirrorList(), [
      'https://m1.example/',
      'https://m2.example/',
    ]);
    process.env.UGS_RUNNER_GIT_MIRROR = 'off';
    assert.deepEqual(mirrorList(), []);
  } finally {
    if (saved === undefined) delete process.env.UGS_RUNNER_GIT_MIRROR;
    else process.env.UGS_RUNNER_GIT_MIRROR = saved;
  }
});

test('preferMirrorFirst defaults on and can be disabled', () => {
  const saved = process.env.UGS_RUNNER_GIT_PREFER_MIRROR;
  try {
    delete process.env.UGS_RUNNER_GIT_PREFER_MIRROR;
    assert.equal(preferMirrorFirst(), true);
    process.env.UGS_RUNNER_GIT_PREFER_MIRROR = 'off';
    assert.equal(preferMirrorFirst(), false);
    process.env.UGS_RUNNER_GIT_PREFER_MIRROR = '0';
    assert.equal(preferMirrorFirst(), false);
    process.env.UGS_RUNNER_GIT_PREFER_MIRROR = 'on';
    assert.equal(preferMirrorFirst(), true);
  } finally {
    if (saved === undefined) delete process.env.UGS_RUNNER_GIT_PREFER_MIRROR;
    else process.env.UGS_RUNNER_GIT_PREFER_MIRROR = saved;
  }
});

test('isGithubUrl matches github.com over https and scp ssh', () => {
  assert.equal(isGithubUrl('https://github.com/me/repo.git'), true);
  assert.equal(isGithubUrl('git@github.com:me/repo.git'), true);
  assert.equal(isGithubUrl('https://gitlab.com/me/repo.git'), false);
  assert.equal(isGithubUrl(''), false);
});

test('authEnvForUrl injects a mirror insteadOf rewrite when given', () => {
  const env = authEnvForUrl(
    'https://github.com/me/repo.git',
    'tok',
    null,
    'https://ghfast.top/https://github.com/',
  );
  const entries = configEntries(env);
  const rewrite = entries.find(([k]) =>
    k === 'url.https://ghfast.top/https://github.com/.insteadOf',
  );
  assert.ok(rewrite, 'insteadOf rewrite present');
  assert.equal(rewrite[1], 'https://github.com/');
});
