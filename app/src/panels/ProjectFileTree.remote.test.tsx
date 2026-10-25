import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REMOTE_WORKSPACE_FILES_UPDATED_EVENT,
  remoteWorkspacePath,
  saveRemoteRunnerConnection,
  saveRemoteWorkspace,
} from '@/lib/remoteWorkspace';
import { resetSecureStorageForTests } from '@/lib/secureStorage';
import { defaultComposer } from '@/store/sampleSessions';
import { useStore } from '@/store/useStore';
import ProjectFileTree from './ProjectFileTree';
import { requestProjectRightPanelToggle } from './projectRightPanelEvents';
import { CLOUD_PROJECTS_ENABLED } from '@/lib/cloudProjects';

const tauriMocks = vi.hoisted(() => ({
  listWorkspaceDirectory: vi.fn(async (rootPath: string, relativePath: string) => ({
    rootPath,
    relativePath,
    entries: [],
    truncated: false,
    totalEntries: 0,
  })),
  previewLocalFile: vi.fn(async () => ({ kind: 'unsupported' })),
}));

vi.mock('@/lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tauri')>();
  return {
    ...actual,
    listWorkspaceDirectory: tauriMocks.listWorkspaceDirectory,
    previewLocalFile: tauriMocks.previewLocalFile,
  };
});

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

(globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver =
  ResizeObserverStub as typeof ResizeObserver;

async function renderProjectFileTree(): Promise<{
  container: HTMLDivElement;
  cleanup: () => Promise<void>;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(<ProjectFileTree />);
  });
  await act(async () => requestProjectRightPanelToggle());

  return {
    container,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

beforeEach(() => {
  window.localStorage.clear();
  resetSecureStorageForTests();
});

afterEach(() => {
  window.localStorage.clear();
  resetSecureStorageForTests();
  document.body.innerHTML = '';
  tauriMocks.listWorkspaceDirectory.mockClear();
  tauriMocks.previewLocalFile.mockClear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function waitForExpect(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < 20; i += 1) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 10));
      });
    }
  }
  throw lastError;
}

describe.runIf(CLOUD_PROJECTS_ENABLED)('ProjectFileTree remote workspaces', () => {
  it('lists remote project files through the Runner API, not local Tauri', async () => {
    const connection = saveRemoteRunnerConnection(
      { serverUrl: 'https://runner.test' },
      { token: 'runner-token' },
    );
    const remote = saveRemoteWorkspace({
      id: 'rw_test',
      label: '测试 Runner',
      serverUrl: connection.serverUrl,
      adapter: 'codex',
      projectId: 'proj_test',
      repoUrl: 'https://example.test/repo.git',
    });
    const remotePath = remoteWorkspacePath(remote.id);
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://runner.test/projects/proj_test/files?path=README.md&preview=1') {
        return new Response(
          JSON.stringify({
            ok: true,
            file: {
              path: 'remote-project://proj_test/README.md',
              fileName: 'README.md',
              kind: 'text',
              mime: 'text/markdown',
              sizeBytes: 14,
              truncated: false,
              text: '# remote read\n',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === 'https://runner.test/projects/proj_test/files') {
        return new Response(
          JSON.stringify({
            ok: true,
            listing: {
              rootPath: 'remote-project://proj_test',
              relativePath: '',
              entries: [
                {
                  name: 'src',
                  path: 'remote-project://proj_test/src',
                  relativePath: 'src',
                  kind: 'directory',
                  hidden: false,
                },
                {
                  name: 'README.md',
                  path: 'remote-project://proj_test/README.md',
                  relativePath: 'README.md',
                  kind: 'file',
                  hidden: false,
                },
              ],
              truncated: false,
              totalEntries: 2,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ ok: false, error: 'unexpected' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    useStore.setState({
      locale: 'zh-CN',
      workspaces: [
        {
          id: 'ws_remote',
          path: remotePath,
          name: '测试 Runner',
          updatedAt: 1,
          sessionCount: 1,
          lastActiveSessionId: 's_remote',
        },
      ],
      activeWorkspaceId: 'ws_remote',
      activeSessionId: 's_remote',
      composer: { ...defaultComposer, workspace: remotePath },
      composerDraft: '',
      composerDrafts: {},
      messages: [],
    });

    const view = await renderProjectFileTree();

    try {
      expect(tauriMocks.listWorkspaceDirectory).not.toHaveBeenCalled();
      expect(tauriMocks.previewLocalFile).not.toHaveBeenCalled();
      await waitForExpect(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          'https://runner.test/projects/proj_test/files',
          expect.objectContaining({
            headers: expect.objectContaining({
              Authorization: 'Bearer runner-token',
            }),
          }),
        );
        expect(view.container.textContent).toContain('src');
        expect(view.container.textContent).toContain('README.md');
      });
      const readmeButton = Array.from(
        view.container.querySelectorAll<HTMLButtonElement>('button'),
      ).find((button) => button.textContent?.includes('README.md'));
      expect(readmeButton).toBeTruthy();
      await act(async () => {
        readmeButton?.click();
      });
      await waitForExpect(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          'https://runner.test/projects/proj_test/files?path=README.md&preview=1',
          expect.objectContaining({
            headers: expect.objectContaining({
              Authorization: 'Bearer runner-token',
            }),
          }),
        );
        expect(tauriMocks.previewLocalFile).not.toHaveBeenCalled();
        expect(view.container.textContent).toContain('remote read');
      });
    } finally {
      await view.cleanup();
    }
  });

  it('refreshes remote project files after the remote workspace update event', async () => {
    saveRemoteRunnerConnection(
      { serverUrl: 'https://runner.test' },
      { token: 'runner-token' },
    );
    const remote = saveRemoteWorkspace({
      id: 'rw_refresh',
      label: '测试 Runner',
      serverUrl: 'https://runner.test',
      adapter: 'codex',
      projectId: 'proj_refresh',
      repoUrl: 'https://example.test/repo.git',
    });
    const remotePath = remoteWorkspacePath(remote.id);
    let fileCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://runner.test/projects/proj_refresh/files') {
        fileCalls += 1;
        return new Response(
          JSON.stringify({
            ok: true,
            listing: {
              rootPath: 'remote-project://proj_refresh',
              relativePath: '',
              entries:
                fileCalls === 1
                  ? []
                  : [
                      {
                        name: 'README.md',
                        path: 'remote-project://proj_refresh/README.md',
                        relativePath: 'README.md',
                        kind: 'file',
                        hidden: false,
                      },
                    ],
              truncated: false,
              totalEntries: fileCalls === 1 ? 0 : 1,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ ok: false, error: 'unexpected' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    useStore.setState({
      locale: 'zh-CN',
      workspaces: [
        {
          id: 'ws_remote',
          path: remotePath,
          name: '测试 Runner',
          updatedAt: 1,
          sessionCount: 1,
          lastActiveSessionId: 's_remote',
        },
      ],
      activeWorkspaceId: 'ws_remote',
      activeSessionId: 's_remote',
      composer: { ...defaultComposer, workspace: remotePath },
      composerDraft: '',
      composerDrafts: {},
      messages: [],
    });

    const view = await renderProjectFileTree();

    try {
      await waitForExpect(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      await act(async () => {
        window.dispatchEvent(
          new CustomEvent(REMOTE_WORKSPACE_FILES_UPDATED_EVENT, {
            detail: { workspaceId: remote.id, workspacePath: remotePath },
          }),
        );
      });

      await waitForExpect(() => {
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(view.container.textContent).toContain('README.md');
      });
    } finally {
      await view.cleanup();
    }
  });

  it('repairs a stale saved projectId before listing files', async () => {
    const connection = saveRemoteRunnerConnection(
      { serverUrl: 'https://runner.test' },
      { token: 'runner-token' },
    );
    const remote = saveRemoteWorkspace({
      id: 'rw_stale',
      label: '测试 Runner',
      serverUrl: connection.serverUrl,
      adapter: 'codex',
      projectId: 'rw_stale',
      repoUrl: 'https://example.test/repo.git',
    });
    const remotePath = remoteWorkspacePath(remote.id);
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://runner.test/projects/rw_stale/files') {
        return new Response(JSON.stringify({ ok: false, error: 'not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === 'https://runner.test/projects/rw_stale') {
        return new Response(JSON.stringify({ ok: false, error: 'not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === 'https://runner.test/projects') {
        return new Response(
          JSON.stringify({
            ok: true,
            projects: [
              {
                id: 'proj_actual',
                label: '测试 Runner',
                repoUrl: 'https://example.test/repo.git',
                branch: null,
                pushBranch: null,
                adapter: 'codex',
                model: null,
                createdAt: 1,
                updatedAt: 2,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === 'https://runner.test/projects/proj_actual/files') {
        return new Response(
          JSON.stringify({
            ok: true,
            listing: {
              rootPath: 'remote-project://proj_actual',
              relativePath: '',
              entries: [
                {
                  name: 'README.md',
                  path: 'remote-project://proj_actual/README.md',
                  relativePath: 'README.md',
                  kind: 'file',
                  hidden: false,
                },
              ],
              truncated: false,
              totalEntries: 1,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ ok: false, error: 'unexpected' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    useStore.setState({
      locale: 'zh-CN',
      workspaces: [
        {
          id: 'ws_remote',
          path: remotePath,
          name: '测试 Runner',
          updatedAt: 1,
          sessionCount: 1,
          lastActiveSessionId: 's_remote',
        },
      ],
      activeWorkspaceId: 'ws_remote',
      activeSessionId: 's_remote',
      composer: { ...defaultComposer, workspace: remotePath },
      composerDraft: '',
      composerDrafts: {},
      messages: [],
    });

    const view = await renderProjectFileTree();

    try {
      await waitForExpect(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          'https://runner.test/projects/proj_actual/files',
          expect.any(Object),
        );
        expect(view.container.textContent).toContain('README.md');
      });
    } finally {
      await view.cleanup();
    }
  });
});
