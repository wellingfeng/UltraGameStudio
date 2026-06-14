import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REMOTE_WORKSPACE_PREFIX,
  RunnerClient,
  deleteRemoteWorkspace,
  getRemoteWorkspace,
  isRemoteWorkspacePath,
  loadRemoteWorkspaces,
  readRemoteSecrets,
  remoteWorkspaceIdFromPath,
  remoteWorkspacePath,
  saveRemoteWorkspace,
} from './remoteWorkspace';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
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
});

describe('remote workspace persistence', () => {
  it('creates, reads, updates and deletes a workspace', () => {
    const created = saveRemoteWorkspace({
      label: '我的云服务器',
      serverUrl: 'https://server.test:8787/',
      adapter: 'codex',
      repoUrl: 'https://github.com/me/repo.git',
    });
    expect(created.id).toMatch(/^rw_/);
    // Trailing slash normalized away.
    expect(created.serverUrl).toBe('https://server.test:8787');

    const list = loadRemoteWorkspaces();
    expect(list).toHaveLength(1);
    expect(getRemoteWorkspace(created.id)?.label).toBe('我的云服务器');

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
      'freeultracode.remoteWorkspaces.v1',
    );
    expect(raw).not.toContain('super-secret-token');
    expect(raw).not.toContain('sk-123');

    // Secrets are readable via the dedicated accessor (in-memory keychain).
    const secrets = readRemoteSecrets(ws.id);
    expect(secrets.token).toBe('super-secret-token');
    expect(secrets.apiKey).toBe('sk-123');
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

  it('builds a client from a saved workspace id', () => {
    const ws = saveRemoteWorkspace(
      { label: 'srv', serverUrl: 'https://s.test:8787' },
      { token: 'tok' },
    );
    const client = RunnerClient.fromWorkspace(ws.id);
    expect(client).not.toBeNull();
    expect(client?.serverUrl).toBe('https://s.test:8787');
  });
});
