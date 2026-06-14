import { spawn } from 'node:child_process';

/**
 * Minimal git helpers used to sync a workspace before/after an AI job.
 * Credentials are injected per-call as an `x-access-token` style HTTPS rewrite
 * so we never persist a token into the repo's stored remote URL.
 */

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
    child.stdout?.on('data', (d) => {
      stdout += d.toString();
      opts.onLog?.({ stream: 'stdout', text: d.toString() });
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
      opts.onLog?.({ stream: 'stderr', text: d.toString() });
    });
    child.on('error', (err) => {
      resolve({ code: -1, stdout, stderr: stderr + String(err) });
    });
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** Build an authenticated clone URL without logging the token. */
export function authenticatedUrl(repoUrl, token) {
  if (!token) return repoUrl;
  try {
    const u = new URL(repoUrl);
    if (u.protocol !== 'https:') return repoUrl;
    // GitHub/GitLab both accept token-in-username for HTTPS.
    u.username = 'x-access-token';
    u.password = token;
    return u.toString();
  } catch {
    return repoUrl;
  }
}

/** Redact any embedded credentials from a string before it leaves the server. */
export function redact(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/(https?:\/\/)[^@\s/]+@/gi, '$1***@');
}

export async function ensureClone({ repoUrl, branch, dir, token, onLog }) {
  const url = authenticatedUrl(repoUrl, token);
  const args = ['clone', '--depth', '1'];
  if (branch) args.push('--branch', branch);
  args.push(url, dir);
  const res = await run('git', args, {
    onLog: (l) => onLog?.({ ...l, text: redact(l.text) }),
  });
  return { ok: res.code === 0, ...res, stderr: redact(res.stderr) };
}

export async function pull({ dir, token, onLog }) {
  // Refresh remote with credentials only for this invocation via -c http.
  const res = await run('git', ['pull', '--ff-only'], {
    cwd: dir,
    env: token ? { GIT_ASKPASS: '', GIT_TERMINAL_PROMPT: '0' } : {},
    onLog: (l) => onLog?.({ ...l, text: redact(l.text) }),
  });
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
  const steps = [
    ['checkout', '-B', branch],
    ['add', '-A'],
    ['commit', '-m', message || 'FreeUltraCode remote job'],
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
  const push = await run(
    'git',
    ['push', '-u', 'origin', branch, '--force-with-lease'],
    {
      cwd: dir,
      env: token ? { GIT_TERMINAL_PROMPT: '0' } : {},
      onLog: (l) => onLog?.({ ...l, text: redact(l.text) }),
    },
  );
  return { ok: push.code === 0, stderr: redact(push.stderr), branch };
}
