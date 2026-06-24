import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';

/**
 * Minimal git helpers used to sync a workspace before/after an AI job.
 * Credentials are injected per-call through Git's env-backed config, never by
 * rewriting the remote URL. That keeps tokens out of `.git/config`.
 */

/**
 * Default per-call git timeout. This is an *idle* timeout, not a total
 * wall-clock cap: the timer resets every time the child emits output. A healthy
 * `git clone` of a large repo keeps printing "Receiving objects: x%" via
 * `--progress`, so it is never killed just for taking a long time. Only a truly
 * stalled command (no output at all for this long, e.g. a backend that cannot
 * reach github.com) gets killed, so the job can fail fast instead of hanging in
 * `cloning` forever. Override per-call via `opts.timeoutMs`, or globally via
 * `UGS_RUNNER_GIT_TIMEOUT_MS`.
 */
const DEFAULT_GIT_TIMEOUT_MS = (() => {
  const raw = Number(process.env.UGS_RUNNER_GIT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 180_000;
})();

/** Run a command, capturing stdout/stderr. Never throws on non-zero exit. */
export function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timeoutMs =
      typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0
        ? opts.timeoutMs
        : DEFAULT_GIT_TIMEOUT_MS;
    let timer;
    const onTimeout = () => {
      const note = `\n[git] command stalled (no output for ${timeoutMs}ms); killing process`;
      opts.onLog?.({ stream: 'stderr', text: note });
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish({ code: -1, stdout, stderr: stderr + note });
    };
    // Idle timeout: reset the clock whenever the child makes progress. Only a
    // command that produces no output at all for `timeoutMs` is considered hung.
    const armTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(onTimeout, timeoutMs);
    };
    armTimer();
    child.stdout?.on('data', (d) => {
      armTimer();
      stdout += d.toString();
      opts.onLog?.({ stream: 'stdout', text: d.toString() });
    });
    child.stderr?.on('data', (d) => {
      armTimer();
      stderr += d.toString();
      opts.onLog?.({ stream: 'stderr', text: d.toString() });
    });
    child.on('error', (err) => {
      finish({ code: -1, stdout, stderr: stderr + String(err) });
    });
    child.on('close', (code) => finish({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * Normalize a repo URL so token auth can apply. Token-based auth is HTTPS-only,
 * but users routinely paste the SSH "scp" form (`git@github.com:owner/repo.git`)
 * that GitHub shows by default. When a token is available we rewrite that to the
 * equivalent HTTPS URL so the token actually takes effect; without a token we
 * leave SSH alone (it may rely on server-side SSH keys).
 */
export function normalizeRepoUrl(repoUrl, token) {
  if (typeof repoUrl !== 'string') return repoUrl;
  const trimmed = repoUrl.trim();
  if (!trimmed) return trimmed;
  if (!token) return trimmed;
  // scp-like syntax: [ssh://]git@host:owner/repo(.git). No double slash after host.
  const scp = /^(?:ssh:\/\/)?[^@\s]+@([^:/\s]+):(.+)$/.exec(trimmed);
  if (scp) {
    return `https://${scp[1]}/${scp[2].replace(/^\/+/, '')}`;
  }
  // ssh://git@host/owner/repo(.git) form.
  const sshProto = /^ssh:\/\/(?:[^@/\s]+@)?([^/\s]+)\/(.+)$/.exec(trimmed);
  if (sshProto) {
    return `https://${sshProto[1]}/${sshProto[2]}`;
  }
  return trimmed;
}

/** Build an authenticated clone URL without logging the token. */
export function authenticatedUrl(repoUrl, token) {
  if (!token) return repoUrl;
  try {
    const u = new URL(normalizeRepoUrl(repoUrl, token));
    if (u.protocol !== 'https:') return repoUrl;
    // GitHub/GitLab both accept token-in-username for HTTPS.
    u.username = 'x-access-token';
    u.password = token;
    return u.toString();
  } catch {
    return repoUrl;
  }
}

/**
 * Resolve the ordered list of outbound HTTP(S) proxies for git network ops.
 * Backends that cannot reach github.com directly (e.g. a Tencent Cloud host) can
 * route clone/pull/push through one or more proxies. Configure via
 * `UGS_RUNNER_GIT_PROXY` (preferred) as a single URL or a comma-separated list,
 * e.g. `http://10.0.0.2:7890,http://10.0.0.3:7890`. Standard
 * `HTTPS_PROXY`/`HTTP_PROXY` are honored as a fallback. Proxies must be
 * reachable *from the backend host* — a Clash instance on the operator's own
 * laptop (127.0.0.1) is not, unless the backend runs on that same machine.
 *
 * Order matters: callers try a direct connection first, then each proxy in turn
 * (mirroring MonkeyCode's direct-first, proxy-fallback strategy).
 */
export function proxyList() {
  const raw =
    process.env.UGS_RUNNER_GIT_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** First configured proxy, or null. Kept for callers that want a single value. */
export function proxyUrl() {
  return proxyList()[0] ?? null;
}

/**
 * Built-in GitHub acceleration mirrors for CN-hosted backends. Unlike an HTTP
 * proxy (which needs a real reachable proxy server you operate), these are
 * public URL-rewrite accelerators: git connects to the mirror host instead of
 * github.com via `url.<mirror>.insteadOf=https://github.com/`. They only help
 * for *public* github.com repos (a private-repo token is scoped to the
 * github.com origin and will not travel to the mirror host). Mirror uptime in
 * the wild is volatile, so this is an ordered fallback list, tried only after a
 * direct connection (and any real proxy) fails. Override the whole list with
 * `UGS_RUNNER_GIT_MIRROR` (comma-separated prefixes), or disable with
 * `UGS_RUNNER_GIT_MIRROR=off`.
 *
 * Each entry is the replacement prefix for `https://github.com/`, so it must end
 * with a trailing slash and, when the mirror wraps the full URL, embed the
 * original `https://github.com/` (e.g. `https://ghfast.top/https://github.com/`).
 */
const DEFAULT_GITHUB_MIRRORS = [
  'https://ghfast.top/https://github.com/',
  'https://gh-proxy.com/https://github.com/',
  'https://ghproxy.net/https://github.com/',
  'https://gh.llkk.cc/https://github.com/',
  'https://gitclone.com/github.com/',
];

/**
 * Whether to try GitHub accelerator mirrors *before* a direct connection for
 * public github.com repos. CN-hosted backends (e.g. Tencent Cloud) reliably
 * fail to reach github.com directly — every direct attempt burns its retry
 * budget on a GnuTLS/HTTP2 error (10s–90s) before the chain ever reaches a
 * working mirror. Putting mirrors first makes a public-repo sync succeed on the
 * first endpoint instead of after several doomed direct attempts. This is the
 * real "proxy on by default for CN" path, since a mirror needs no operator-run
 * proxy server. Disabled automatically when a token is present (a private-repo
 * token is scoped to github.com and won't authenticate against a mirror host).
 * Opt out with `UGS_RUNNER_GIT_PREFER_MIRROR=off`.
 */
export function preferMirrorFirst() {
  const raw = process.env.UGS_RUNNER_GIT_PREFER_MIRROR;
  if (raw === undefined) return true;
  return !/^(0|false|off|no|none)$/i.test(raw.trim());
}

export function mirrorList() {
  const raw = process.env.UGS_RUNNER_GIT_MIRROR;
  if (raw === undefined) return [...DEFAULT_GITHUB_MIRRORS];
  if (/^(off|0|false|no|none)$/i.test(raw.trim())) return [];
  const custom = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.endsWith('/') ? s : `${s}/`));
  return custom.length ? custom : [...DEFAULT_GITHUB_MIRRORS];
}

/** True when a repo URL points at github.com (the only host mirrors rewrite). */
export function isGithubUrl(repoUrl) {
  if (typeof repoUrl !== 'string') return false;
  try {
    return new URL(normalizeRepoUrl(repoUrl, 'x')).hostname === 'github.com';
  } catch {
    return false;
  }
}

/**
 * HTTP robustness config applied to every network git op. Tencent Cloud (and
 * other CN-hosted backends) routinely fail to reach github.com over HTTP/2:
 * the connection dies mid-transfer with "RPC failed; curl 16 Error in the HTTP2
 * framing layer" or a GnuTLS "TLS connection was non-properly terminated"
 * (-110). Pinning HTTP/1.1 sidesteps the brittle HTTP/2 multiplexing, and a
 * large postBuffer avoids chunked-transfer hiccups on big pushes. Opt out with
 * `UGS_RUNNER_GIT_HTTP1=0` if a host actually prefers HTTP/2.
 */
export function httpRobustnessConfig() {
  if (/^(0|false|off|no)$/i.test(String(process.env.UGS_RUNNER_GIT_HTTP1 ?? ''))) {
    return [];
  }
  return [
    ['http.version', 'HTTP/1.1'],
    ['http.postBuffer', '524288000'],
  ];
}

/** Number of extra retries per endpoint for transient network failures. */
export function gitRetryCount() {
  const raw = Number(process.env.UGS_RUNNER_GIT_RETRIES);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 2;
}

/**
 * Git env config for one HTTPS host. Token never enters command args/remotes.
 * Pass an explicit `proxy` (string) to route this invocation through it; pass
 * `null`/omit for a direct connection. Pass a `mirror` prefix to rewrite
 * github.com to a CN accelerator via git `insteadOf`. The token auth header is
 * always included (when applicable) regardless of proxy/mirror choice.
 */
export function authEnvForUrl(repoUrl, token, proxy = null, mirror = null) {
  const env = { GIT_TERMINAL_PROMPT: '0' };
  const entries = [...httpRobustnessConfig()];
  if (token) {
    try {
      const u = new URL(normalizeRepoUrl(repoUrl, token));
      if (u.protocol === 'https:') {
        const encoded = Buffer.from(`x-access-token:${token}`, 'utf8').toString(
          'base64',
        );
        entries.push([
          `http.${u.origin}/.extraheader`,
          `AUTHORIZATION: basic ${encoded}`,
        ]);
      }
    } catch {
      /* leave token out if the URL cannot be parsed */
    }
  }
  if (proxy) {
    entries.push(['http.proxy', proxy]);
    entries.push(['https.proxy', proxy]);
  }
  if (mirror) {
    // Transparently rewrite github.com to the accelerator at connection time,
    // without touching command args or the stored remote URL.
    entries.push([`url.${mirror}.insteadOf`, 'https://github.com/']);
  }
  if (entries.length === 0) return env;
  env.GIT_CONFIG_COUNT = String(entries.length);
  entries.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/**
 * Heuristically decide whether a failed git result is a *network* failure worth
 * retrying through a proxy. Auth errors (403/401), missing repos/branches, and
 * non-fast-forward rejections are NOT network problems, so we don't waste time
 * cycling proxies for them. Matches the symptoms seen in the wild: connection
 * timeouts, DNS failures, refused connections, and mid-transfer disconnects.
 */
export function isNetworkFailure(res) {
  if (!res || res.code === 0) return false;
  const text = `${res.stderr ?? ''}\n${res.stdout ?? ''}`;
  return /Connection timed out|Could ?n[o']?t connect|Failed to connect|Couldn't connect to server|Could not resolve host|unable to access|unexpected disconnect|RPC failed|early EOF|Recv failure|Send failure|timed out after \d+ms|stalled \(no output for \d+ms\)|TLS connect|SSL_ERROR|GnuTLS|HTTP2 framing|expected flush after ref listing|Operation timed out|Connection reset/i.test(
    text,
  );
}

/**
 * Run a network-touching git command with a layered fallback chain plus a few
 * transient retries per endpoint. Endpoint order depends on the repo:
 *   - Public github.com repo (no token), mirror-first enabled (the CN default):
 *       each accelerator mirror -> direct -> each configured HTTP proxy.
 *   - Otherwise (private repo / token present / non-github host):
 *       direct -> each configured HTTP proxy -> each github mirror.
 * Mirrors are skipped for a token'd (private) repo since the token cannot
 * authenticate against a mirror host. Each endpoint gets up to `gitRetryCount()`
 * extra attempts on a network error. Auth/branch/other non-network failures
 * short-circuit immediately. Returns the last attempt's result plus
 * `proxyUsed`/`mirrorUsed`.
 */
export async function runGitNet(args, { cwd, repoUrl, token, onLog } = {}) {
  const direct = { proxy: null, mirror: null, label: 'direct' };
  const proxies = proxyList().map((proxy) => ({
    proxy,
    mirror: null,
    label: `proxy ${proxy}`,
  }));
  // Mirrors only apply to public github.com repos: a private-repo token is
  // scoped to the github.com origin and will not travel to the mirror host.
  const mirrors =
    isGithubUrl(repoUrl) && !token
      ? mirrorList().map((mirror) => ({ proxy: null, mirror, label: `mirror ${mirror}` }))
      : [];

  // CN default: for a public github.com repo, try accelerator mirrors first so a
  // sync succeeds immediately instead of after several doomed direct attempts.
  const endpoints =
    mirrors.length && preferMirrorFirst()
      ? [...mirrors, direct, ...proxies]
      : [direct, ...proxies, ...mirrors];

  const maxTries = gitRetryCount() + 1;
  let last = null;
  for (let i = 0; i < endpoints.length; i++) {
    const { proxy, mirror, label } = endpoints[i];
    if (i > 0) {
      onLog?.({
        phase: 'git',
        stream: 'stderr',
        text: redact(`[git] previous endpoint failed; retrying via ${label}`),
      });
    }
    for (let attempt = 1; attempt <= maxTries; attempt++) {
      const res = await run('git', args, {
        cwd,
        env: authEnvForUrl(repoUrl, token, proxy, mirror),
        onLog: (l) => onLog?.({ ...l, text: redact(l.text) }),
      });
      last = res;
      if (res.code === 0) return { ...res, proxyUsed: proxy, mirrorUsed: mirror };
      // Non-network failures (auth, missing branch, etc.) never recover by
      // retrying: bail out of both the attempt loop and the endpoint loop.
      if (!isNetworkFailure(res)) {
        return { ...last, proxyUsed: null, mirrorUsed: null };
      }
      if (attempt < maxTries) {
        onLog?.({
          phase: 'git',
          stream: 'stderr',
          text: redact(
            `[git] transient network error; retry ${attempt}/${maxTries - 1} via ${label}`,
          ),
        });
      }
    }
  }
  return { ...last, proxyUsed: null, mirrorUsed: null };
}

/** Redact any embedded credentials from a string before it leaves the server. */
export function redact(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/(https?:\/\/)[^@\s/]+@/gi, '$1***@')
    .replace(/(AUTHORIZATION:\s*)(?:basic|bearer)\s+[^\r\n]+/gi, '$1***');
}

export async function ensureClone({ repoUrl, branch, dir, token, onLog }) {
  const cloneUrl = normalizeRepoUrl(repoUrl, token);
  // `--progress` forces git to emit "Receiving objects: x%" lines even when
  // stderr is a pipe (not a TTY). Without it, a long clone stays silent until it
  // finishes or fails, so the client sees no live stream during the slowest
  // phase. The progress lines flow through onLog -> SSE just like other output.
  const args = ['clone', '--progress', '--depth', '1'];
  if (branch) args.push('--branch', branch);
  args.push(cloneUrl, dir);
  const res = await runGitNet(args, { repoUrl: cloneUrl, token, onLog });
  if (res.code === 0) {
    await run('git', ['remote', 'set-url', 'origin', cloneUrl], { cwd: dir });
  }
  return {
    ok: res.code === 0,
    ...res,
    stdout: redact(res.stdout),
    stderr: redact(res.stderr),
  };
}

export async function isGitWorkspace(dir) {
  const res = await run('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: dir,
  });
  return res.code === 0 && res.stdout.trim() === 'true';
}

/**
 * Make the existing checkout's `origin` match the project's configured repo.
 * Without this, changing the repo URL in project settings has no effect — pulls
 * keep hitting whatever remote the dir was first cloned from. Compares against
 * the normalized HTTPS form so SSH<->HTTPS edits of the same repo don't churn.
 */
async function reconcileOrigin({ dir, repoUrl, token, onLog }) {
  if (!repoUrl) return;
  const desired = normalizeRepoUrl(repoUrl, token);
  const current = await run('git', ['remote', 'get-url', 'origin'], { cwd: dir });
  const currentUrl = current.stdout.trim();
  const currentNorm = normalizeRepoUrl(currentUrl, token);
  if (currentNorm === desired) return;
  const action = current.code === 0 ? 'set-url' : 'add';
  await run('git', ['remote', action, 'origin', desired], { cwd: dir });
  onLog?.({
    phase: 'git',
    stream: 'stdout',
    text: redact(`[git] origin updated to ${desired}`),
  });
}

export async function ensureWorkspace({ repoUrl, branch, dir, token, onLog }) {
  if (!(await isGitWorkspace(dir))) {
    return ensureClone({ repoUrl, branch, dir, token, onLog });
  }

  await reconcileOrigin({ dir, repoUrl, token, onLog });

  if (branch) {
    const checkout = await run('git', ['checkout', branch], {
      cwd: dir,
      onLog: (l) => onLog?.({ ...l, text: redact(l.text) }),
    });
    if (checkout.code !== 0) {
      return {
        ok: false,
        ...checkout,
        stdout: redact(checkout.stdout),
        stderr: redact(checkout.stderr),
      };
    }
  }

  return pull({ dir, branch, token, onLog });
}

export async function pull({ dir, branch, token, onLog }) {
  const remote = await run('git', ['remote', 'get-url', 'origin'], { cwd: dir });
  const repoUrl = remote.stdout.trim();
  const args = ['pull', '--progress', '--ff-only'];
  if (branch) args.push('origin', branch);
  const res = await runGitNet(args, { cwd: dir, repoUrl, token, onLog });
  return { ok: res.code === 0, ...res, stderr: redact(res.stderr) };
}

/** Produce a unified diff of the working tree against HEAD. */
export async function diff({ dir }) {
  const res = await run('git', ['add', '-A'], { cwd: dir });
  if (res.code !== 0) return { ok: false, patch: '', stderr: res.stderr };
  const staged = await run('git', ['diff', '--cached'], { cwd: dir });
  return { ok: staged.code === 0, patch: staged.stdout, stderr: staged.stderr };
}

/** Commit + push the current changes to a (new) branch. */
export async function commitAndPush({ dir, branch, message, token, onLog }) {
  const remote = await run('git', ['remote', 'get-url', 'origin'], { cwd: dir });
  const repoUrl = remote.stdout.trim();
  const steps = [
    ['checkout', '-B', branch],
    ['add', '-A'],
    ['commit', '-m', message || 'UltraGameStudio remote job'],
  ];
  for (const args of steps) {
    const res = await run('git', args, {
      cwd: dir,
      onLog: (l) => onLog?.({ ...l, text: redact(l.text) }),
    });
    // `commit` exits non-zero when there is nothing to commit; treat as soft.
    if (res.code !== 0 && args[0] !== 'commit') {
      return { ok: false, stderr: redact(res.stderr) };
    }
  }
  const push = await runGitNet(
    ['push', '-u', 'origin', branch, '--force-with-lease'],
    { cwd: dir, repoUrl, token, onLog },
  );
  return { ok: push.code === 0, stderr: redact(push.stderr), branch };
}
