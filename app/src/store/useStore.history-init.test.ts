import { afterEach, describe, expect, it, vi } from 'vitest';

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('history initialization', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.doUnmock('./history/store');
    window.localStorage.clear();
  });

  it('clears sample sessions and exposes the error when disk history fails', async () => {
    const failure = new Error('IPC unavailable');
    const historyStore = {
      ready: vi.fn().mockRejectedValue(failure),
      rootPath: vi.fn(),
      getConfig: vi.fn(),
      patchConfig: vi.fn(),
      listWorkspaces: vi.fn(),
      getWorkspace: vi.fn(),
      resolveWorkspaceByPath: vi.fn(),
      renameWorkspace: vi.fn(),
      deleteWorkspace: vi.fn(),
      listSessions: vi.fn(),
      getSession: vi.fn(),
      createSession: vi.fn(),
      updateSession: vi.fn(),
      deleteSession: vi.fn(),
      appendMessage: vi.fn(),
      setSessionWorkflow: vi.fn(),
    };

    vi.doMock('./history/store', async () => {
      const actual =
        await vi.importActual<typeof import('./history/store')>(
          './history/store',
        );
      return { ...actual, historyStore };
    });
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    const { useStore } = await import('./useStore');

    expect(useStore.getState().sessions.map((session) => session.title)).toEqual([
      'Coding chat',
      'Release notes help',
      'Bug triage chat',
      'Docs sync chat',
    ]);

    useStore.getState().initHistory();

    await waitFor(
      () => useStore.getState().historyReady,
      'history init failure state',
    );

    expect(historyStore.ready).toHaveBeenCalledOnce();
    expect(useStore.getState().historyError).toBe('IPC unavailable');
    expect(useStore.getState().sessions).toEqual([]);
    expect(useStore.getState().sessionTree).toEqual({});
    expect(useStore.getState().activeSessionId).toBeNull();
    expect(useStore.getState().activeWorkspaceId).toBeNull();
    expect(consoleError).toHaveBeenCalledWith(
      '[history-init] failed to load history',
      failure,
    );
  });
});
