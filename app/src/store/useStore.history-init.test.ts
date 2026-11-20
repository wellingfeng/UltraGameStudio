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

  it('restores the last-used model from session messages on startup', async () => {
    const { useStore } = await import('./useStore');
    const { historyStore } = await import('./history/store');
    const { setActiveGatewaySelection } = await import('@/lib/gatewayConfig');
    const { workflowDefaultGatewaySelection } = await import(
      '@/lib/modelGateway/resolver'
    );

    // 全局编程模型固定为 opus，与历史会话模型（sonnet）不同，模拟重启前的
    // 全局选择。修复后启动恢复必须沿用历史模型，而不是全局默认。
    setActiveGatewaySelection({ adapter: 'claude-code', modelClass: 'opus' });

    await historyStore.ready();
    const workspace = await historyStore.resolveWorkspaceByPath('');
    const record = await historyStore.createSession({
      workspaceId: workspace.id,
      isWorkflow: false,
      messages: [
        { id: 'u1', role: 'user', text: '你好', createdAt: 1 },
        {
          id: 'a1',
          role: 'assistant',
          text: '⚙ 路由：Claude Code · 模型：sonnet\n你好。',
          routeLabel: 'Claude Code · sonnet',
          createdAt: 2,
        },
      ],
      title: '聊天',
    });
    await historyStore.patchConfig({
      lastActiveWorkspaceId: workspace.id,
      lastActiveSessionId: record.id,
    });

    useStore.getState().initHistory();
    await waitFor(() => useStore.getState().historyReady, 'history init ready');

    const selection = workflowDefaultGatewaySelection(
      useStore.getState().workflow,
    );
    expect(selection.modelClass).toBe('sonnet');
  });

  it('rehydrates in-memory composerDrafts for non-active sessions with a persisted draft', async () => {
    const { useStore } = await import('./useStore');
    const { historyStore } = await import('./history/store');
    const { workflowSessionKeyId } = await import('./sessionKey');

    await historyStore.ready();
    const workspace = await historyStore.resolveWorkspaceByPath('');

    // Active session: no draft.
    const active = await historyStore.createSession({
      workspaceId: workspace.id,
      isWorkflow: false,
      messages: [{ id: 'u1', role: 'user', text: '当前', createdAt: 1 }],
      title: '当前会话',
    });
    // Background session: persisted draft from a previous run that the user
    // never sent. After a restart the sidebar draft badge / draft-first
    // ordering must still see it without the user re-opening the session.
    const withDraft = await historyStore.createSession({
      workspaceId: workspace.id,
      isWorkflow: false,
      messages: [{ id: 'u2', role: 'user', text: '带草稿', createdAt: 2 }],
      title: '带草稿会话',
    });
    await historyStore.updateSession(workspace.id, withDraft.id, {
      meta: { composerDraft: '还没发送的内容' },
      preserveUpdatedAt: true,
    });
    // Background session without a draft must stay absent from composerDrafts.
    const noDraft = await historyStore.createSession({
      workspaceId: workspace.id,
      isWorkflow: false,
      messages: [{ id: 'u3', role: 'user', text: '没草稿', createdAt: 3 }],
      title: '没草稿会话',
    });

    await historyStore.patchConfig({
      lastActiveWorkspaceId: workspace.id,
      lastActiveSessionId: active.id,
    });

    useStore.getState().initHistory();
    await waitFor(() => useStore.getState().historyReady, 'history init ready');

    const state = useStore.getState();
    const draftKey = workflowSessionKeyId({
      workspaceId: workspace.id,
      sessionId: withDraft.id,
    });
    const noDraftKey = workflowSessionKeyId({
      workspaceId: workspace.id,
      sessionId: noDraft.id,
    });
    expect(state.composerDrafts[draftKey]).toBe('还没发送的内容');
    expect(state.composerDrafts[noDraftKey]).toBeUndefined();
    // Active session has no draft; switching target stays empty.
    expect(state.composerDraft).toBe('');
  });

  it('loads more sessions than the bounded history queue without rejecting draft reads', async () => {
    const { useStore } = await import('./useStore');
    const { historyStore } = await import('./history/store');
    const { workflowSessionKeyId } = await import('./sessionKey');
    await historyStore.ready();
    const workspace = await historyStore.resolveWorkspaceByPath('');
    for (let i = 0; i < 132; i += 1) {
      await historyStore.createSession({ workspaceId: workspace.id, id: `queue-init-${i}`,
        isWorkflow: false, messages: [], title: `Session ${i}` });
    }
    await historyStore.updateSession(workspace.id, 'queue-init-3', {
      meta: { composerDraft: 'draft from another session' }, preserveUpdatedAt: true,
    });
    await historyStore.patchConfig({ lastActiveWorkspaceId: workspace.id, lastActiveSessionId: 'queue-init-0' });
    useStore.getState().initHistory();
    await vi.waitFor(() => expect(useStore.getState().historyReady).toBe(true), { timeout: 10_000 });
    const state = useStore.getState();
    expect(state.historyError).toBeNull();
    expect(state.sessions).toHaveLength(132);
    expect(state.composerDrafts[workflowSessionKeyId({ workspaceId: workspace.id, sessionId: 'queue-init-3' })])
      .toBe('draft from another session');
    await expect(historyStore.flush()).resolves.toBeUndefined();
  }, 20_000);
});
