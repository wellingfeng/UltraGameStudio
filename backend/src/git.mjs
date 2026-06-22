import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';

/**
 * Minimal git helpers used to sync a workspace before/after an AI job.
 * Credentials are injected per-call through Git's env-backed config, never by
 * rewriting the remote URL. That keeps tokens out of `.git/config`.
 */

/**
 * Default per-call git timeout. A network-stalled `git clone` (e.g. a backend
 * that cannot reach github.com) would otherwise hang forever, leaving the job
 * stuck in `cloning` with no logs and the client waiting indefinitely. Override
 * per-call via `opts.timeoutMs`, or globally via `UGS_RUNNER_GIT_TIMEOUT_MS`.
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
    const timer = setTimeout(() => {
      const note = `\n[git] command timed out after ${timeoutMs}ms; killing process`;
      opts.onLog?.({ stream: 'stderr', text: note });
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish({ code: -1, stdout, stderr: stderr + note });
    }, timeoutMs);
    child.stdout?.on('data', (d) => {
      stdout += d.toString();
      opts.onLog?.({ stream: 'stdout', text: d.toString() });
    });
    child.stderr?.on('data', (d) => {
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
 * Git env config for one HTTPS host. Token never enters command args/remotes.
 * Pass an explicit `proxy` (string) to route this invocation through it; pass
 * `null`/omit for a direct connection. The token auth header is always included
 * (when applicable) regardless of proxy choice.
 */
export function authEnvForUrl(repoUrl, token, proxy = null) {
  const env = { GIT_TERMINAL_PROMPT: '0' };
  const entries = [];
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
  return /Connection timed out|Could ?n[o']?t connect|Failed to connect|Couldn't connect to server|Could not resolve host|unable to access|unexpected disconnect|RPC failed|early EOF|Recv failure|Send failure|timed out after \d+ms|TLS connect|SSL_ERROR|Operation timed out|Connection reset/i.test(
    text,
  );
}

/**
 * Run a network-touching git command with direct-first, proxy-fallback retry.
 * Tries a direct connection, and only if it fails with a network error does it
 * retry through each configured proxy in order. Auth/branch/other errors short
 * -circuit immediately. Returns the last attempt's result plus `attempts`.
 */
export async function runGitNet(args, { cwd, repoUrl, token, onLog } = {}) {
  const attempts = [null, ...proxyList()];
  let last = null;
  for (let i = 0; i < attempts.length; i++) {
    const proxy = attempts[i];
    if (proxy) {
      onLog?.({
        phase: 'git',
        stream: 'stderr',
        text: redact(`[git] direct connection failed; retrying via proxy ${proxy}`),
      });
    }
    const res = await run('git', args, {
      cwd,
      env: authEnvForUrl(repoUrl, token, proxy),
      onLog: (l) => onLog?.({ ...l, text: redact(l.text) }),
    });
    last = res;
    if (res.code === 0) return { ...res, proxyUsed: proxy };
    // Stop retrying on non-network failures (auth, missing branch, etc.).
    if (!isNetworkFailure(res)) break;
  }
  return { ...last, proxyUsed: null };
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
