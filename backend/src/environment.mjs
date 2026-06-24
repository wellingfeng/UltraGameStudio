import { spawn } from 'node:child_process';
import { platform as osPlatform } from 'node:os';

/**
 * Remote environment provisioning.
 *
 * The remote backend host ships no developer tooling preinstalled, so a project
 * sync (git clone/pull) can fail before it starts simply because `git` is not on
 * the host. This module detects the required runtime tools (git, node, python)
 * and can install the missing ones server-side, using whatever package manager
 * the host OS provides. The client triggers this from the project settings
 * "remote environment" tab; the install runs here, on the backend.
 *
 * Installs are gated: a project sync must not run until git is present, so
 * {@link ensureGitReadyForSync} is called ahead of any clone/pull.
 */

const REQUIRED_TOOLS = [
  { id: 'git', label: 'Git', command: 'git', versionArgs: ['--version'] },
  {
    id: 'git-lfs',
    label: 'Git LFS',
    // Game repos keep large binary assets in Git LFS; a plain clone misses them.
    command: 'git-lfs',
    versionArgs: ['version'],
  },
  { id: 'node', label: 'Node.js', command: 'node', versionArgs: ['--version'] },
  {
    id: 'python',
    label: 'Python',
    // Most modern distros expose `python3`; fall back to `python`.
    command: 'python3',
    fallbackCommand: 'python',
    versionArgs: ['--version'],
  },
  {
    id: 'ffmpeg',
    label: 'FFmpeg',
    // Audio/video and sprite-sequence asset processing.
    command: 'ffmpeg',
    versionArgs: ['-version'],
  },
  {
    id: 'curl',
    label: 'cURL',
    // Downloading models/installers and network probing.
    command: 'curl',
    versionArgs: ['--version'],
  },
  {
    id: 'unzip',
    label: 'Unzip',
    // Extracting model and asset archives.
    command: 'unzip',
    versionArgs: ['-v'],
  },
];

const INSTALL_TIMEOUT_MS = (() => {
  const raw = Number(process.env.UGS_RUNNER_ENV_INSTALL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 600_000;
})();

const PROBE_TIMEOUT_MS = 15_000;

/** Run a command capturing combined output. Never throws on non-zero exit. */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env ?? {}) },
        windowsHide: true,
      });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish({
        code: -1,
        stdout,
        stderr: stderr + '\n[env] command timed out after ' + timeoutMs + 'ms',
      });
    }, timeoutMs);
    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      finish({ code: -1, stdout, stderr: stderr + String(err) });
    });
    child.on('close', (code) => finish({ code: code ?? -1, stdout, stderr }));
  });
}

/** Probe a single command's `--version`. Returns `{ installed, version }`. */
async function probeCommand(command, versionArgs) {
  const res = await run(command, versionArgs, { timeoutMs: PROBE_TIMEOUT_MS });
  if (res.code !== 0) return { installed: false, version: null };
  const line = (res.stdout || res.stderr).split(/\r?\n/)[0]?.trim() ?? '';
  return { installed: true, version: line || null };
}

/** Probe one tool, honoring a fallback command (e.g. python3 -> python). */
async function probeTool(tool) {
  let result = await probeCommand(tool.command, tool.versionArgs);
  if (!result.installed && tool.fallbackCommand) {
    result = await probeCommand(tool.fallbackCommand, tool.versionArgs);
  }
  return result;
}

/**
 * Detect the host package manager used for auto-install. Returns null when no
 * known manager is found (install is then not offered — only detection). The
 * result is cached for the process lifetime; pass `force` to re-probe.
 */
let _packageManagerCache;
export async function detectPackageManager({ force = false } = {}) {
  if (!force && _packageManagerCache !== undefined) return _packageManagerCache;
  let found = null;
  if (osPlatform() === 'win32') {
    for (const pm of ['winget', 'choco']) {
      const res = await run(pm, ['--version'], { timeoutMs: PROBE_TIMEOUT_MS });
      if (res.code === 0) {
        found = pm;
        break;
      }
    }
  } else if (osPlatform() === 'darwin') {
    const res = await run('brew', ['--version'], { timeoutMs: PROBE_TIMEOUT_MS });
    found = res.code === 0 ? 'brew' : null;
  } else {
    for (const pm of ['apt-get', 'dnf', 'yum', 'apk', 'pacman', 'zypper']) {
      const res = await run('which', [pm], { timeoutMs: PROBE_TIMEOUT_MS });
      if (res.code === 0 && res.stdout.trim()) {
        found = pm;
        break;
      }
    }
  }
  _packageManagerCache = found;
  return found;
}

/** Reset cached probes — used by tests to avoid cross-test leakage. */
export function _resetEnvironmentCaches() {
  _packageManagerCache = undefined;
}

/** Map a tool id to package name(s) for a given package manager. */
function packageNamesFor(toolId, pm) {
  const table = {
    git: {
      'apt-get': ['git'],
      dnf: ['git'],
      yum: ['git'],
      apk: ['git'],
      pacman: ['git'],
      zypper: ['git'],
      brew: ['git'],
      winget: ['Git.Git'],
      choco: ['git'],
    },
    'git-lfs': {
      'apt-get': ['git-lfs'],
      dnf: ['git-lfs'],
      yum: ['git-lfs'],
      apk: ['git-lfs'],
      pacman: ['git-lfs'],
      zypper: ['git-lfs'],
      brew: ['git-lfs'],
      winget: ['GitHub.GitLFS'],
      choco: ['git-lfs'],
    },
    node: {
      'apt-get': ['nodejs', 'npm'],
      dnf: ['nodejs', 'npm'],
      yum: ['nodejs', 'npm'],
      apk: ['nodejs', 'npm'],
      pacman: ['nodejs', 'npm'],
      zypper: ['nodejs', 'npm'],
      brew: ['node'],
      winget: ['OpenJS.NodeJS.LTS'],
      choco: ['nodejs-lts'],
    },
    python: {
      'apt-get': ['python3', 'python3-pip'],
      dnf: ['python3', 'python3-pip'],
      yum: ['python3', 'python3-pip'],
      apk: ['python3', 'py3-pip'],
      pacman: ['python', 'python-pip'],
      zypper: ['python3', 'python3-pip'],
      brew: ['python'],
      winget: ['Python.Python.3.12'],
      choco: ['python'],
    },
    ffmpeg: {
      'apt-get': ['ffmpeg'],
      dnf: ['ffmpeg'],
      yum: ['ffmpeg'],
      apk: ['ffmpeg'],
      pacman: ['ffmpeg'],
      zypper: ['ffmpeg'],
      brew: ['ffmpeg'],
      winget: ['Gyan.FFmpeg'],
      choco: ['ffmpeg'],
    },
    curl: {
      'apt-get': ['curl'],
      dnf: ['curl'],
      yum: ['curl'],
      apk: ['curl'],
      pacman: ['curl'],
      zypper: ['curl'],
      brew: ['curl'],
      winget: ['cURL.cURL'],
      choco: ['curl'],
    },
    unzip: {
      'apt-get': ['unzip'],
      dnf: ['unzip'],
      yum: ['unzip'],
      apk: ['unzip'],
      pacman: ['unzip'],
      zypper: ['unzip'],
      brew: ['unzip'],
      // Windows ships tar/Expand-Archive; unzip.exe via choco only.
      choco: ['unzip'],
    },
  };
  return table[toolId]?.[pm] ?? null;
}

/**
 * Some package managers serve from a package index that may be empty or stale on
 * a freshly provisioned host. Installing without refreshing it first fails with a
 * "unable to locate package" error (apt-get returns exit code 100). Return the
 * refresh invocation for those managers, or null when none is needed.
 */
function refreshInvocation(pm) {
  switch (pm) {
    case 'apt-get':
      return { command: 'apt-get', args: ['update'] };
    case 'apk':
      return { command: 'apk', args: ['update'] };
    case 'pacman':
      return { command: 'pacman', args: ['-Sy', '--noconfirm'] };
    case 'zypper':
      return { command: 'zypper', args: ['refresh'] };
    default:
      // dnf/yum refresh as part of install; brew/winget/choco manage their own index.
      return null;
  }
}

/** Build the install command + args for a package manager and package list. */
function installInvocation(pm, packages) {
  switch (pm) {
    case 'apt-get':
      return {
        command: 'apt-get',
        args: [
          'install',
          '-y',
          // Keep existing config files without prompting; a maintainer-script
          // prompt would otherwise block a headless server install until timeout.
          '-o',
          'Dpkg::Options::=--force-confdef',
          '-o',
          'Dpkg::Options::=--force-confold',
          ...packages,
        ],
      };
    case 'dnf':
      return { command: 'dnf', args: ['install', '-y', ...packages] };
    case 'yum':
      return { command: 'yum', args: ['install', '-y', ...packages] };
    case 'apk':
      return { command: 'apk', args: ['add', '--no-cache', ...packages] };
    case 'pacman':
      return { command: 'pacman', args: ['-Sy', '--noconfirm', ...packages] };
    case 'zypper':
      return { command: 'zypper', args: ['install', '-y', ...packages] };
    case 'brew':
      return { command: 'brew', args: ['install', ...packages] };
    case 'winget':
      return {
        command: 'winget',
        args: [
          'install',
          '-e',
          '--silent',
          '--accept-package-agreements',
          '--accept-source-agreements',
          ...packages.flatMap((p) => ['--id', p]),
        ],
      };
    case 'choco':
      return { command: 'choco', args: ['install', '-y', ...packages] };
    default:
      return null;
  }
}

/**
 * Some package managers need privilege escalation on server hosts. We prepend
 * `sudo -n` (non-interactive) when not already root, so a misconfigured host
 * fails fast with a clear error instead of hanging on a password prompt.
 */
function withPrivilege(pm, invocation) {
  const needsRoot = ['apt-get', 'dnf', 'yum', 'apk', 'pacman', 'zypper'].includes(pm);
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (!needsRoot || isRoot) return invocation;
  return {
    command: 'sudo',
    args: ['-n', invocation.command, ...invocation.args],
  };
}

/**
 * Non-interactive env for package managers. Headless Linux servers must never
 * stop at a prompt (tzdata config, debconf questions, pager) or the install
 * hangs until our timeout. apt reads DEBIAN_FRONTEND; we also force a dumb,
 * pager-less terminal so no manager opens an interactive UI.
 */
function nonInteractiveEnv(pm) {
  const env = {
    DEBIAN_FRONTEND: 'noninteractive',
    DEBCONF_NONINTERACTIVE_SEEN: 'true',
    NEEDRESTART_MODE: 'a',
    TERM: 'dumb',
    PAGER: 'cat',
    GIT_LFS_SKIP_SMUDGE: '1',
  };
  if (pm === 'brew') env.HOMEBREW_NO_AUTO_UPDATE = '1';
  return env;
}

/** Human-readable install hint shown to the client (transparency, no secrets). */
function installHintFor(toolId, pm) {
  const packages = packageNamesFor(toolId, pm);
  if (!pm || !packages) return null;
  const base = installInvocation(pm, packages);
  if (!base) return null;
  return `${base.command} ${base.args.join(' ')}`;
}

/** Build the full environment report for the remote host. */
export async function detectEnvironment() {
  const pm = await detectPackageManager();
  const tools = [];
  for (const tool of REQUIRED_TOOLS) {
    const probe = await probeTool(tool);
    const installable = Boolean(pm && packageNamesFor(tool.id, pm));
    tools.push({
      id: tool.id,
      label: tool.label,
      installed: probe.installed,
      version: probe.version,
      installable,
      installHint: installable ? installHintFor(tool.id, pm) : null,
    });
  }
  const gitTool = tools.find((t) => t.id === 'git');
  return {
    platform: osPlatform(),
    packageManager: pm,
    tools,
    ready: tools.every((t) => t.installed),
    gitReady: Boolean(gitTool?.installed),
    checkedAt: Date.now(),
  };
}

/** Trim install output so the client gets a readable tail, never a flood. */
function logTail(text, max = 4000) {
  const s = String(text ?? '').trim();
  return s.length > max ? `…${s.slice(-max)}` : s;
}

/**
 * Install the requested (or all missing required) tools on the remote host.
 * Returns per-tool step results plus a fresh environment report.
 */
export async function installEnvironment(input = {}) {
  const pm = await detectPackageManager();
  const before = await detectEnvironment();
  const requested =
    Array.isArray(input.tools) && input.tools.length
      ? input.tools.filter((id) => REQUIRED_TOOLS.some((t) => t.id === id))
      : before.tools.filter((t) => !t.installed).map((t) => t.id);

  const steps = [];
  if (!pm) {
    for (const id of requested) {
      steps.push({
        id,
        ok: false,
        error:
          'no supported package manager found on the remote host; install git/node/python manually',
      });
    }
    return {
      ok: false,
      platform: before.platform,
      packageManager: null,
      steps,
      report: before,
    };
  }

  const installEnv = nonInteractiveEnv(pm);

  // Refresh the package index once before installing. On freshly provisioned
  // hosts (e.g. Tencent Cloud) the apt index is empty/stale, so a bare
  // `apt-get install` fails with exit code 100 ("unable to locate package").
  const refresh = refreshInvocation(pm);
  if (refresh) {
    const refreshCmd = withPrivilege(pm, refresh);
    const refreshRes = await run(refreshCmd.command, refreshCmd.args, {
      timeoutMs: INSTALL_TIMEOUT_MS,
      env: installEnv,
    });
    steps.push({
      id: '_refresh',
      ok: refreshRes.code === 0,
      log: logTail(`${refreshRes.stdout}\n${refreshRes.stderr}`),
      error:
        refreshRes.code === 0
          ? null
          : `index refresh failed (exit code ${refreshRes.code})`,
    });
  }

  for (const id of requested) {
    const packages = packageNamesFor(id, pm);
    if (!packages) {
      steps.push({ id, ok: false, error: `no install mapping for ${id} on ${pm}` });
      continue;
    }
    const base = installInvocation(pm, packages);
    if (!base) {
      steps.push({ id, ok: false, error: `cannot build install command for ${pm}` });
      continue;
    }
    const invocation = withPrivilege(pm, base);
    const res = await run(invocation.command, invocation.args, {
      timeoutMs: INSTALL_TIMEOUT_MS,
      env: installEnv,
    });
    steps.push({
      id,
      ok: res.code === 0,
      log: logTail(`${res.stdout}\n${res.stderr}`),
      error: res.code === 0 ? null : `exit code ${res.code}`,
    });
  }

  const report = await detectEnvironment();
  return {
    ok: steps.every((s) => s.ok) && report.ready,
    platform: report.platform,
    packageManager: pm,
    steps,
    report,
  };
}

/**
 * Gate a project sync on git availability. The remote host has nothing
 * preinstalled, so attempting a clone/pull without git produces a confusing
 * low-level error. Surface an actionable message that points the user at the
 * remote-environment install instead.
 */
export async function ensureGitReadyForSync() {
  const probe = await probeTool(REQUIRED_TOOLS[0]);
  if (probe.installed) return;
  throw new Error(
    'git 未安装在远程环境，无法同步项目。请先在「项目设置 → 远程环境」中安装 git 等必需环境后再同步。',
  );
}


