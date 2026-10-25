import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  saveRemoteRunnerConnection,
  saveRemoteWorkspace,
  remoteWorkspacePath,
} from '@/lib/remoteWorkspace';
import { resetSecureStorageForTests } from '@/lib/secureStorage';
import { checkRemoteWorkspaceConnection } from '@/lib/remoteWorkspaceStatus';
import { CLOUD_PROJECTS_ENABLED } from '@/lib/cloudProjects';

beforeEach(() => {
  window.localStorage.clear();
  resetSecureStorageForTests();
});

afterEach(() => {
  window.localStorage.clear();
  resetSecureStorageForTests();
  vi.restoreAllMocks();
});

describe.runIf(CLOUD_PROJECTS_ENABLED)('checkRemoteWorkspaceConnection', () => {
  it('marks a remote project connected after health and project checks pass', async () => {
    saveRemoteRunnerConnection(
      { serverUrl: 'https://runner.test' },
      { token: 'runner-token' },
    );
    const workspace = saveRemoteWorkspace({
      id: 'rw_ok',
      label: '远程项目',
      serverUrl: 'https://runner.test',
      adapter: 'codex',
      projectId: 'proj_ok',
      repoUrl: 'https://github.com/me/game.git',
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://runner.test/health') {
        return new Response(JSON.stringify({ ok: true, version: '0.1.0' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          ok: true,
          project: {
            id: 'proj_ok',
            label: '远程项目',
            repoUrl: 'https://github.com/me/game.git',
            createdAt: 1,
            updatedAt: 2,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkRemoteWorkspaceConnection(
      remoteWorkspacePath(workspace.id),
    );

    expect(result.status).toBe('connected');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://runner.test/projects/proj_ok',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer runner-token' }),
      }),
    );
  });

  it('marks a remote project failed when the runner is unreachable', async () => {
    saveRemoteRunnerConnection(
      { serverUrl: 'https://runner.test' },
      { token: 'runner-token' },
    );
    const workspace = saveRemoteWorkspace({
      id: 'rw_down',
      label: '远程项目',
      serverUrl: 'https://runner.test',
      adapter: 'codex',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    const result = await checkRemoteWorkspaceConnection(
      remoteWorkspacePath(workspace.id),
    );

    expect(result.status).toBe('failed');
    expect(result.detail).toContain('不可达');
  });
});
