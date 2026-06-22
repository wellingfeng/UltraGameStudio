import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_REMOTE_RUNNER_SERVER_URL,
  DEFAULT_REMOTE_RUNNER_TOKEN,
  REMOTE_WORKSPACE_PREFIX,
  RunnerClient,
  deleteRemoteWorkspace,
  getRemoteWorkspace,
  isRemoteWorkspacePath,
  loadRemoteWorkspaces,
  parseRemoteProviderId,
  readRemoteRunnerConnection,
  readRemoteRunnerConnectionSecrets,
  readRemoteSecrets,
  refreshRemoteWorkspaceAccounts,
  remoteProviderId,
  remoteWorkspaceIdFromPath,
  remoteWorkspacePath,
  resolveRemoteRunnerConnection,
  saveRemoteRunnerConnection,
  saveRemoteWorkspace,
  syncRemoteWorkspaceAccounts,
  uploadRemoteWorkspaceFile,
} from './remoteWorkspace';
import { listProviders } from './apiConfig';
import { providerModelCacheKey, getCachedModels } from './modelLists';
import { resetSecureStorageForTests } from './secureStorage';

beforeEach(() => {
  window.localStorage.clear();
  resetSecureStorageForTests();
});

afterEach(() => {
  window.localStorage.clear();
  resetSecureStorageForTests();
  vi.restoreAllMocks();
});

describe('remote workspace path helpers', () => {
  it('round-trips an id through the synthetic path', () => {
    const path = remoteWorkspacePath('rw_abc');
    expect(path).toBe(`${REMOTE_WORKSPACE_PREFIX}rw_abc`);
    expect(isRemoteWorkspacePath(path)).toBe(true);
    expect(remoteWorkspaceIdFromPath(path)).toBe('rw_abc');
  });

  it('treats normal paths as non-remote', () => {
    expect(isRemoteWorkspacePath('C:/code/app')).toBe(false);
    expect(isRemoteWorkspacePath(null)).toBe(false);
    expect(remoteWorkspaceIdFromPath('/home/me')).toBe('');
  });

  it('round-trips a remote provider id', () => {
    const id = remoteProviderId('rw_abc', 'codex/main');
    expect(parseRemoteProviderId(id)).toEqual({
      workspaceId: 'rw_abc',
      accountId: 'codex/main',
    });
    expect(parseRemoteProviderId('p_local')).toBeNull();
  });
});

describe('remote workspace persistence', () => {
  it('creates, reads, updates and deletes a workspace', () => {
    const created = saveRemoteWorkspace({
      label: '我的云服务器',
      serverUrl: 'https://server.test:8787/',
      adapter: 'codex',
      projectId: 'proj_repo',
      repoUrl: 'https://github.com/me/repo.git',
    });
    expect(created.id).toMatch(/^rw_/);
    // Trailing slash normalized away.
    expect(created.serverUrl).toBe('https://server.test:8787');

    const list = loadRemoteWorkspaces();
    expect(list).toHaveLength(1);
    expect(getRemoteWorkspace(created.id)?.label).toBe('我的云服务器');
    expect(getRemoteWorkspace(created.id)?.projectId).toBe('proj_repo');

    const updated = saveRemoteWorkspace({
      id: created.id,
      label: '改名了',
      serverUrl: 'https://server.test:8787',
    });
    expect(updated.id).toBe(created.id);
    expect(loadRemoteWorkspaces()).toHaveLength(1);
    expect(getRemoteWorkspace(created.id)?.label).toBe('改名了');

    deleteRemoteWorkspace(created.id);
    expect(loadRemoteWorkspaces()).toHaveLength(0);
  });

  it('keeps secrets out of localStorage', () => {
    const ws = saveRemoteWorkspace(
      { label: 'srv', serverUrl: 'https://s.test' },
      { token: 'super-secret-token', apiKey: 'sk-123' },
    );
    const raw = window.localStorage.getItem(
      'ultragamestudio.remoteWorkspaces.v1',
    );
    expect(raw).not.toContain('super-secret-token');
    expect(raw).not.toContain('sk-123');

    // Secrets are readable via the dedicated accessor (in-memory keychain).
    const secrets = readRemoteSecrets(ws.id);
    expect(secrets.token).toBe('super-secret-token');
    expect(secrets.apiKey).toBe('sk-123');
  });

  it('stores the cloud service connection separately from projects', () => {
    const connection = saveRemoteRunnerConnection(
      { serverUrl: 'https://runner.test:8787/' },
      { token: 'runner-token' },
    );
    const ws = saveRemoteWorkspace({
      label: '游戏项目',
      serverUrl: connection.serverUrl,
      adapter: 'codex',
      projectId: 'proj_game',
      repoUrl: 'https://github.com/me/game.git',
    });

    expect(readRemoteRunnerConnection()?.serverUrl).toBe(
      'https://runner.test:8787',
    );
    expect(readRemoteRunnerConnectionSecrets().token).toBe('runner-token');
    expect(resolveRemoteRunnerConnection(ws)).toMatchObject({
      serverUrl: 'https://runner.test:8787',
      token: 'runner-token',
      source: 'global',
    });
    const rawProjects = window.localStorage.getItem(
      'ultragamestudio.remoteWorkspaces.v1',
    );
    expect(rawProjects).not.toContain('runner-token');
  });

  it('falls back to the built-in default when nothing is saved', () => {
    expect(readRemoteRunnerConnection()?.serverUrl).toBe(
      DEFAULT_REMOTE_RUNNER_SERVER_URL,
    );
    expect(readRemoteRunnerConnectionSecrets().token).toBe(
      DEFAULT_REMOTE_RUNNER_TOKEN,
    );
  });

  it('treats a stale loopback connection as default (ignores old local testing values)', () => {
    // 模拟早期本地联调把 127.0.0.1 连接 + 本地 Token 存进了 localStorage。
    saveRemoteRunnerConnection(
      { serverUrl: 'http://127.0.0.1:8787' },
      { token: 'old-local-token' },
    );
    // 预填应回退到内置的官方测试默认值，而不是过期的回环值。
    expect(readRemoteRunnerConnection()?.serverUrl).toBe(
      DEFAULT_REMOTE_RUNNER_SERVER_URL,
    );
    expect(readRemoteRunnerConnectionSecrets().token).toBe(
      DEFAULT_REMOTE_RUNNER_TOKEN,
    );
    // 但显式禁用默认时仍能读到原始保存值（供真实连接解析使用）。
    expect(
      readRemoteRunnerConnection({ allowDefault: false })?.serverUrl,
    ).toBe('http://127.0.0.1:8787');
    expect(
      readRemoteRunnerConnectionSecrets({ allowDefault: false }).token,
    ).toBe('old-local-token');
  });
});

describe('RunnerClient', () => {
  it('normalizes the server url and sends the bearer token', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, authRequired: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new RunnerClient('https://s.test:8787/', 'tok');
    const health = await client.health();
    expect(health.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://s.test:8787/health',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
      }),
    );
  });

  it('health returns ok:false when the server is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    const client = new RunnerClient('https://s.test', 'tok');
    expect((await client.health()).ok).toBe(false);
  });

  it('createJob throws on a runner error payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: false, error: 'prompt is required' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const client = new RunnerClient('https://s.test', 'tok');
    await expect(client.createJob({ prompt: '' })).rejects.toThrow(
      'prompt is required',
    );
  });

  it('streams canceled status as a terminal runner status', async () => {
    const encoder = new TextEncoder();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  [
                    'event: status',
                    'data: "canceled"',
                    '',
                    'event: result',
                    'data: {"id":"job_1","status":"canceled"}',
                    '',
                    '',
                  ].join('\n'),
                ),
              );
              controller.close();
            },
          }),
          { status: 200 },
        ),
      ),
    );
    const statuses: string[] = [];
    let resultStatus = '';
    const client = new RunnerClient('https://s.test', 'tok');
    client.streamJob('job_1', {
      onStatus: (status) => statuses.push(status),
      onResult: (job) => {
        resultStatus = job.status;
      },
    });
    await vi.waitFor(() => expect(resultStatus).toBe('canceled'));
    expect(statuses).toEqual(['canceled']);
  });

  it('reads usage/account summary from the runner', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            ok: true,
            totals: {
              inputTokens: 10,
              outputTokens: 5,
              cachedInputTokens: 2,
              totalTokens: 15,
              calls: 1,
            },
            accounts: [
              {
                id: 'claude-main',
                label: 'Claude 主号',
                adapter: 'claude',
                enabled: true,
                hasApiKey: true,
                usage: {
                  inputTokens: 10,
                  outputTokens: 5,
                  cachedInputTokens: 2,
                  totalTokens: 15,
                  calls: 1,
                },
              },
            ],
            recentJobs: [],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      ),
    );
    const client = new RunnerClient('https://s.test', 'tok');
    const usage = await client.usage();
    expect(usage.totals.totalTokens).toBe(15);
    expect(usage.accounts[0].label).toBe('Claude 主号');
  });

  it('reads runner accounts', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          accounts: [
            {
              id: 'codex-main',
              label: 'Codex 主号',
              adapter: 'codex',
              model: 'gpt-5.1',
              enabled: true,
              hasApiKey: true,
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new RunnerClient('https://s.test', 'tok');
    const accounts = await client.accounts();
    expect(accounts[0]).toMatchObject({ id: 'codex-main', model: 'gpt-5.1' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://s.test/accounts',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
      }),
    );
  });

  it('reads usage ledger from the runner', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            ok: true,
            totals: {
              inputTokens: 10,
              outputTokens: 5,
              cachedInputTokens: 2,
              totalTokens: 15,
              calls: 1,
              runtimeMs: 61_000,
              runtimeMinutes: 2,
              jobs: 1,
            },
            entries: [
              {
                id: 'ledger_job_1_model_tokens',
                type: 'model_tokens',
                at: 1000,
                jobId: 'job_1',
                status: 'done',
                usage: {
                  inputTokens: 10,
                  outputTokens: 5,
                  cachedInputTokens: 2,
                  totalTokens: 15,
                  calls: 1,
                },
              },
            ],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      ),
    );
    const client = new RunnerClient('https://s.test', 'tok');
    const ledger = await client.usageLedger();
    expect(ledger.totals.runtimeMinutes).toBe(2);
    expect(ledger.entries[0].jobId).toBe('job_1');
  });

  it('reads job artifacts from the runner', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          artifacts: {
            id: 'job_1',
            status: 'done',
            createdAt: 1,
            updatedAt: 2,
            runtimeMs: 1000,
            adapter: 'codex',
            model: null,
            repoUrl: 'https://repo.test/x.git',
            branch: 'main',
            pushBranch: null,
            error: null,
            logs: [],
            usage: null,
            patch: 'diff --git a/a b/a\n',
            pushed: false,
            result: { exitCode: 0, patch: 'diff --git a/a b/a\n' },
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new RunnerClient('https://s.test', 'tok');
    const artifacts = await client.getJobArtifacts('job_1');
    expect(artifacts.patch).toContain('diff --git');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://s.test/jobs/job_1/artifacts',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
      }),
    );
  });

  it('creates a runner account', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          account: {
            id: 'codex-main',
            label: 'Codex 主号',
            adapter: 'codex',
            enabled: true,
            hasApiKey: true,
          },
        }),
        {
          status: 201,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new RunnerClient('https://s.test', 'tok');
    const account = await client.saveAccount({
      id: 'codex-main',
      label: 'Codex 主号',
      adapter: 'codex',
      apiKey: 'sk-test',
    });
    expect(account.id).toBe('codex-main');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://s.test/accounts',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer tok',
          'content-type': 'application/json',
        }),
      }),
    );
  });

  it('creates a runner project without exposing a workspace path', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          project: {
            id: 'proj_game',
            userId: 'default',
            label: '游戏项目',
            repoUrl: 'https://github.com/me/game.git',
            branch: 'main',
            pushBranch: null,
            adapter: 'codex',
            model: 'gpt-test',
            createdAt: 1,
            updatedAt: 2,
            hasGitToken: true,
          },
        }),
        {
          status: 201,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new RunnerClient('https://s.test', 'tok');
    const project = await client.saveProject({
      label: '游戏项目',
      repoUrl: 'https://github.com/me/game.git',
      branch: 'main',
      adapter: 'codex',
      model: 'gpt-test',
      gitToken: 'git-token',
    });
    expect(project.id).toBe('proj_game');
    expect('workspacePath' in project).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://s.test/projects',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer tok',
          'content-type': 'application/json',
        }),
      }),
    );
  });

  it('builds a client from a saved workspace id', () => {
    const ws = saveRemoteWorkspace(
      { label: 'srv', serverUrl: 'https://s.test:8787' },
      { token: 'tok' },
    );
    const client = RunnerClient.fromWorkspace(ws.id);
    expect(client).not.toBeNull();
    expect(client?.serverUrl).toBe('https://s.test:8787');
  });

  it('uploads local bytes to the bound remote project and returns a synthetic path', async () => {
    saveRemoteRunnerConnection(
      { serverUrl: 'https://runner.test' },
      { token: 'runner-token' },
    );
    const ws = saveRemoteWorkspace({
      id: 'rw_upload',
      label: '上传项目',
      serverUrl: 'https://runner.test',
      adapter: 'codex',
      projectId: 'proj_upload',
      repoUrl: 'https://github.com/me/game.git',
    });
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          file: {
            path: 'remote-project://proj_upload/.ultragamestudio/uploads/shot.png',
            relativePath: '.ultragamestudio/uploads/shot.png',
            fileName: 'shot.png',
            mime: 'image/png',
            sizeBytes: 3,
          },
        }),
        {
          status: 201,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const uploaded = await uploadRemoteWorkspaceFile(remoteWorkspacePath(ws.id), {
      bytesBase64: 'AQID',
      fileName: 'shot.png',
      mime: 'image/png',
      namespace: 'uploads',
    });

    expect(uploaded.path).toBe(
      'remote://rw_upload/.ultragamestudio/uploads/shot.png',
    );
    expect(uploaded.relativePath).toBe('.ultragamestudio/uploads/shot.png');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://runner.test/projects/proj_upload/files',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer runner-token',
          'content-type': 'application/json',
        }),
      }),
    );
  });
});

describe('remote workspace account sync', () => {
  it('syncs enabled runner accounts into default channel providers', () => {
    const ws = saveRemoteWorkspace({
      label: '远程测试',
      serverUrl: 'https://s.test:8787',
      adapter: 'codex',
    });

    const providers = syncRemoteWorkspaceAccounts(ws, [
      {
        id: 'codex-main',
        label: 'Codex 主号',
        adapter: 'codex',
        model: 'gpt-5.1',
        models: ['gpt-5.1', 'gpt-5.2'],
        enabled: true,
        hasApiKey: true,
      },
      {
        id: 'disabled',
        label: '停用',
        adapter: 'claude',
        enabled: false,
        hasApiKey: true,
      },
    ]);

    expect(providers).toHaveLength(1);
    expect(listProviders()[0]).toMatchObject({
      id: remoteProviderId(ws.id, 'codex-main'),
      kind: 'codex',
      name: '远程测试 · Codex 主号',
      baseUrl: 'https://s.test:8787',
      model: 'gpt-5.1',
      models: ['gpt-5.1', 'gpt-5.2'],
    });
    const cacheKey = providerModelCacheKey(listProviders()[0]);
    expect(getCachedModels(cacheKey)?.models).toEqual(['gpt-5.1', 'gpt-5.2']);
  });

  it('removes stale account providers on the next sync', () => {
    const ws = saveRemoteWorkspace({
      label: '远程测试',
      serverUrl: 'https://s.test:8787',
      adapter: 'codex',
    });
    syncRemoteWorkspaceAccounts(ws, [
      {
        id: 'old',
        label: 'Old',
        adapter: 'codex',
        enabled: true,
        hasApiKey: true,
      },
    ]);
    syncRemoteWorkspaceAccounts(ws, [
      {
        id: 'new',
        label: 'New',
        adapter: 'codex',
        enabled: true,
        hasApiKey: true,
      },
    ]);

    expect(listProviders().map((provider) => provider.id)).toEqual([
      remoteProviderId(ws.id, 'new'),
    ]);
  });

  it('refreshes accounts from the runner and syncs providers', async () => {
    const ws = saveRemoteWorkspace(
      {
        label: '远程测试',
        serverUrl: 'https://s.test:8787',
        adapter: 'codex',
      },
      { token: 'tok' },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            ok: true,
            accounts: [
              {
                id: 'codex-main',
                label: 'Codex 主号',
                adapter: 'codex',
                model: 'gpt-5.1',
                enabled: true,
                hasApiKey: true,
              },
            ],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      ),
    );

    await refreshRemoteWorkspaceAccounts(ws);

    expect(listProviders()[0].id).toBe(remoteProviderId(ws.id, 'codex-main'));
  });
});
