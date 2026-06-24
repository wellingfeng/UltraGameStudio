import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { RunnerClient } from '../../packages/protocol/index.js';

test('server accounts API creates and returns redacted accounts', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ugs-runner-server-data-'));
  const workDir = await mkdtemp(join(tmpdir(), 'ugs-runner-server-work-'));
  process.env.UGS_RUNNER_TOKEN = 'server-test-token';
  process.env.UGS_RUNNER_HOST = '127.0.0.1';
  process.env.UGS_RUNNER_PORT = '0';
  process.env.UGS_RUNNER_DATADIR = dataDir;
  process.env.UGS_RUNNER_WORKDIR = workDir;
  process.env.UGS_RUNNER_ACCOUNTS = '[]';
  const savedKeys = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GOOGLE_GEMINI_BASE_URL: process.env.GOOGLE_GEMINI_BASE_URL,
  };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_GEMINI_BASE_URL;
  const mod = await import(`../src/server.mjs?test=${Date.now()}`);
  await new Promise((resolve) => mod.server.once('listening', resolve));
  const { port } = mod.server.address();
  const base = `http://127.0.0.1:${port}`;
  const client = new RunnerClient(base, 'server-test-token');

  try {
    const account = await client.saveAccount({
      id: 'codex-main',
      label: 'Codex Main',
      adapter: 'codex',
      apiKey: 'sk-test',
    });
    assert.equal(account.id, 'codex-main');
    assert.equal(account.hasApiKey, true);
    assert.equal(JSON.stringify(account).includes('sk-test'), false);

    const usageBody = await client.usage();
    assert.ok(usageBody.accounts.some((account) => account.id === 'codex-main'));

    const project = await client.saveProject({
      label: 'Game Project',
      repoUrl: 'https://example.test/repo.git',
      branch: 'main',
      adapter: 'codex',
      gitToken: 'git-secret',
    });
    assert.match(project.id, /^proj_/);
    assert.equal(project.userId, 'default');
    assert.equal(project.hasGitToken, true);
    assert.equal(JSON.stringify(project).includes('git-secret'), false);
    assert.equal(Object.hasOwn(project, 'workspacePath'), false);

    const projects = await client.projects();
    assert.equal(projects.length, 1);

    mod.runner._execute = async (job) => {
      job.result = { exitCode: 0 };
      mod.runner._finalizeLedger(job, 'done');
      mod.runner._setStatus(job, 'done');
    };
    const job = await client.createJob({
      projectId: project.id,
      prompt: 'fix bug',
      adapter: 'codex',
    });
    assert.equal(job.projectId, project.id);
    assert.equal(job.repoUrl, 'https://example.test/repo.git');
    assert.equal(JSON.stringify(job).includes('git-secret'), false);

    mod.store.upsertJob({
      id: 'job_artifact',
      status: 'done',
      createdAt: 1000,
      updatedAt: 2000,
      startedAt: 1100,
      finishedAt: 1900,
      runtimeMs: 800,
      repoUrl: 'https://example.test/repo.git',
      branch: 'main',
      adapter: 'codex',
      model: 'gpt-test',
      accountId: 'codex-main',
      prompt: 'secret prompt',
      pushBranch: null,
      logs: [{ at: 1200, phase: 'model', stream: 'stdout', text: 'ok' }],
      usage: {
        inputTokens: 4,
        outputTokens: 2,
        cachedInputTokens: 0,
        totalTokens: 6,
        calls: 1,
      },
      result: {
        exitCode: 0,
        patch: 'diff --git a/a b/a\n',
        usage: {
          inputTokens: 4,
          outputTokens: 2,
          cachedInputTokens: 0,
          totalTokens: 6,
          calls: 1,
        },
      },
      error: null,
      _apiKey: 'must-not-leak',
    });
    mod.store.upsertLedgerEntries([
      {
        id: 'ledger_job_artifact_runtime',
        type: 'runtime',
        at: 1900,
        jobId: 'job_artifact',
        accountId: 'codex-main',
        adapter: 'codex',
        model: 'gpt-test',
        status: 'done',
        runtimeMs: 800,
      },
      {
        id: 'ledger_job_artifact_model_tokens',
        type: 'model_tokens',
        at: 1900,
        jobId: 'job_artifact',
        accountId: 'codex-main',
        adapter: 'codex',
        model: 'gpt-test',
        status: 'done',
        usage: {
          inputTokens: 4,
          outputTokens: 2,
          cachedInputTokens: 0,
          totalTokens: 6,
          calls: 1,
        },
      },
    ]);
    const artifacts = await client.getJobArtifacts('job_artifact');
    assert.equal(artifacts.patch, 'diff --git a/a b/a\n');
    assert.equal(artifacts.usage.totalTokens, 6);
    assert.equal(JSON.stringify(artifacts).includes('must-not-leak'), false);

    const ledgerBody = await client.usageLedger();
    assert.equal(ledgerBody.totals.totalTokens, 6);
    assert.ok(
      ledgerBody.entries.some(
        (entry) => entry.id === 'ledger_job_artifact_runtime',
      ),
    );
    assert.ok(
      ledgerBody.entries.some(
        (entry) => entry.id === 'ledger_job_artifact_model_tokens',
      ),
    );
  } finally {
    await new Promise((resolve) => mod.server.close(resolve));
    await mod.store._writeChain;
    await mod.settleWorkspacePrepares();
    await rm(dataDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
    delete process.env.UGS_RUNNER_TOKEN;
    delete process.env.UGS_RUNNER_HOST;
    delete process.env.UGS_RUNNER_PORT;
    delete process.env.UGS_RUNNER_DATADIR;
    delete process.env.UGS_RUNNER_WORKDIR;
    delete process.env.UGS_RUNNER_ACCOUNTS;
    for (const [key, value] of Object.entries(savedKeys)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

function gitInit(dir, args) {
  const res = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  return res.status === 0;
}

test('saving a project eagerly clones its repo into the workspace', async (t) => {
  if (spawnSync('git', ['--version']).status !== 0) {
    t.skip('git is not available');
    return;
  }

  const dataDir = await mkdtemp(join(tmpdir(), 'ugs-runner-clone-data-'));
  const workDir = await mkdtemp(join(tmpdir(), 'ugs-runner-clone-work-'));
  const originDir = await mkdtemp(join(tmpdir(), 'ugs-runner-clone-origin-'));

  // Build a tiny local origin repo so the eager clone has something to fetch
  // without touching the network.
  gitInit(originDir, ['init', '-q', '-b', 'main']);
  gitInit(originDir, ['config', 'user.email', 'test@example.com']);
  gitInit(originDir, ['config', 'user.name', 'Test']);
  await writeFile(join(originDir, 'README.md'), '# eager-clone\n');
  gitInit(originDir, ['add', '-A']);
  gitInit(originDir, ['commit', '-q', '-m', 'init']);

  process.env.UGS_RUNNER_TOKEN = 'clone-test-token';
  process.env.UGS_RUNNER_HOST = '127.0.0.1';
  process.env.UGS_RUNNER_PORT = '0';
  process.env.UGS_RUNNER_DATADIR = dataDir;
  process.env.UGS_RUNNER_WORKDIR = workDir;
  process.env.UGS_RUNNER_ACCOUNTS = '[]';
  const mod = await import(`../src/server.mjs?test=${Date.now()}`);
  await new Promise((resolve) => mod.server.once('listening', resolve));
  const { port } = mod.server.address();
  const client = new RunnerClient(`http://127.0.0.1:${port}`, 'clone-test-token');

  try {
    const project = await client.saveProject({
      label: 'Eager Clone',
      repoUrl: originDir,
      branch: 'main',
      adapter: 'claude',
    });
    // The clone runs in the background; wait for it before asserting.
    await mod.settleWorkspacePrepares();

    const checkoutDir = join(workDir, project.userId, project.id);
    const entries = await readdir(checkoutDir);
    assert.ok(entries.includes('README.md'), 'expected README.md in eager checkout');
    assert.ok(entries.includes('.git'), 'expected a git checkout');
  } finally {
    await new Promise((resolve) => mod.server.close(resolve));
    await mod.store._writeChain;
    await mod.settleWorkspacePrepares();
    await rm(dataDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
    await rm(originDir, { recursive: true, force: true });
    delete process.env.UGS_RUNNER_TOKEN;
    delete process.env.UGS_RUNNER_HOST;
    delete process.env.UGS_RUNNER_PORT;
    delete process.env.UGS_RUNNER_DATADIR;
    delete process.env.UGS_RUNNER_WORKDIR;
    delete process.env.UGS_RUNNER_ACCOUNTS;
  }
});

test('listing project files with sync=1 pulls the latest commits', async (t) => {
  if (spawnSync('git', ['--version']).status !== 0) {
    t.skip('git is not available');
    return;
  }

  const dataDir = await mkdtemp(join(tmpdir(), 'ugs-runner-sync-data-'));
  const workDir = await mkdtemp(join(tmpdir(), 'ugs-runner-sync-work-'));
  const originDir = await mkdtemp(join(tmpdir(), 'ugs-runner-sync-origin-'));

  gitInit(originDir, ['init', '-q', '-b', 'main']);
  gitInit(originDir, ['config', 'user.email', 'test@example.com']);
  gitInit(originDir, ['config', 'user.name', 'Test']);
  await writeFile(join(originDir, 'README.md'), '# sync\n');
  gitInit(originDir, ['add', '-A']);
  gitInit(originDir, ['commit', '-q', '-m', 'init']);

  process.env.UGS_RUNNER_TOKEN = 'sync-test-token';
  process.env.UGS_RUNNER_HOST = '127.0.0.1';
  process.env.UGS_RUNNER_PORT = '0';
  process.env.UGS_RUNNER_DATADIR = dataDir;
  process.env.UGS_RUNNER_WORKDIR = workDir;
  process.env.UGS_RUNNER_ACCOUNTS = '[]';
  const mod = await import(`../src/server.mjs?test=${Date.now()}`);
  await new Promise((resolve) => mod.server.once('listening', resolve));
  const { port } = mod.server.address();
  const client = new RunnerClient(`http://127.0.0.1:${port}`, 'sync-test-token');

  try {
    const project = await client.saveProject({
      label: 'Sync Pull',
      repoUrl: originDir,
      branch: 'main',
      adapter: 'claude',
    });
    // First clone happens eagerly in the background.
    await mod.settleWorkspacePrepares();

    // A new commit lands upstream AFTER the initial clone.
    await writeFile(join(originDir, 'LATEST.md'), '# latest\n');
    gitInit(originDir, ['add', '-A']);
    gitInit(originDir, ['commit', '-q', '-m', 'add latest']);

    // A plain listing (no sync) keeps the stale first-clone snapshot.
    const stale = await client.listProjectDirectory(project.id, '');
    assert.ok(
      !stale.entries.some((e) => e.name === 'LATEST.md'),
      'expected the un-synced listing to omit the new upstream file',
    );

    // sync=1 pulls the new commit, so the file now shows up.
    const synced = await client.listProjectDirectory(project.id, '', {
      sync: true,
    });
    assert.ok(
      synced.entries.some((e) => e.name === 'LATEST.md'),
      'expected sync=1 to pull the latest upstream commit',
    );
  } finally {
    await new Promise((resolve) => mod.server.close(resolve));
    await mod.store._writeChain;
    await mod.settleWorkspacePrepares();
    await rm(dataDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
    await rm(originDir, { recursive: true, force: true });
    delete process.env.UGS_RUNNER_TOKEN;
    delete process.env.UGS_RUNNER_HOST;
    delete process.env.UGS_RUNNER_PORT;
    delete process.env.UGS_RUNNER_DATADIR;
    delete process.env.UGS_RUNNER_WORKDIR;
    delete process.env.UGS_RUNNER_ACCOUNTS;
  }
});
