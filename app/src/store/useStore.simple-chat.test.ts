import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultBlueprint, simpleBlueprint } from '@/core/defaultBlueprint';
import type { IRGraph } from '@/core/ir';
import { refreshCliRuntime } from '@/lib/cliConfig';
import { workflowDefaultGatewaySelection } from '@/lib/modelGateway/resolver';

const gatewayMocks = vi.hoisted(() => ({
  completeGatewayText: vi.fn(),
  resolveDirectGatewayRoute: vi.fn(),
  resolveCliGatewayRoute: vi.fn(),
}));

const tauriMocks = vi.hoisted(() => ({
  aiEditViaCli: vi.fn(),
  cancelAiCli: vi.fn(),
  freeProxyEnsure: vi.fn(),
  isTauri: vi.fn(() => false),
  tauriAvailable: vi.fn(() => false),
}));

vi.mock('@/lib/modelGateway/modelGateway', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/modelGateway/modelGateway')
  >('@/lib/modelGateway/modelGateway');
  return {
    ...actual,
    completeGatewayText: gatewayMocks.completeGatewayText,
    resolveDirectGatewayRoute: gatewayMocks.resolveDirectGatewayRoute,
    resolveCliGatewayRoute: gatewayMocks.resolveCliGatewayRoute,
  };
});

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>(
    '@/lib/tauri',
  );
  return {
    ...actual,
    aiEditViaCli: tauriMocks.aiEditViaCli,
    cancelAiCli: tauriMocks.cancelAiCli,
    freeProxyEnsure: tauriMocks.freeProxyEnsure,
    isTauri: tauriMocks.isTauri,
    tauriAvailable: tauriMocks.tauriAvailable,
  };
});

import { useStore } from './useStore';
import { isActiveAiEditingSession, isWorkflowReadOnly } from './useStore';
import { historyStore } from './history/store';

function cloneGraph(graph: IRGraph): IRGraph {
  return JSON.parse(JSON.stringify(graph)) as IRGraph;
}

function resetStore(workflow: IRGraph): void {
  window.localStorage.setItem('fuc_research_angles_max', '1');
  window.localStorage.setItem('fuc_nodegen_candidates_max', '1');
  useStore.setState({
    workflow: cloneGraph(workflow),
    selectedNodeId: null,
    mode: 'design',
    aiStreaming: false,
    aiEditingSessions: [],
    chattingSessions: [],
    dirty: false,
    currentFilePath: null,
    messages: [],
    composerDraft: '',
    composerDrafts: {},
    activeSessionId: null,
    activeWorkspaceId: null,
    historyReady: false,
    sessions: [],
    sessionTree: {},
    runState: {},
    runOutputs: {},
    lastRunFailedNodeId: null,
  });
}

function mockDirectRoute(): void {
  gatewayMocks.resolveDirectGatewayRoute.mockReturnValue({
    selection: { adapter: 'claude-code', modelClass: 'sonnet' },
    adapter: 'claude-code',
    apiKey: 'test-key',
    model: 'sonnet',
    transport: 'anthropic',
  });
}

async function selectKnownCli(
  adapter: 'claude-code' | 'codex' | 'gemini',
): Promise<void> {
  await historyStore.patchConfig({
    cli: {
      schemaVersion: 1,
      selected: {
        kind: 'known',
        adapter,
        command: adapter === 'claude-code' ? 'claude' : adapter,
        selectedAt: '2026-06-04T00:00:00.000Z',
      },
      customPaths: [],
    },
  });
  await refreshCliRuntime();
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for ${description}\n` +
          `gatewayCalls=${gatewayMocks.completeGatewayText.mock.calls.length}\n` +
          `messages=${JSON.stringify(useStore.getState().messages, null, 2)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

afterEach(async () => {
  gatewayMocks.completeGatewayText.mockReset();
  gatewayMocks.resolveDirectGatewayRoute.mockReset();
  gatewayMocks.resolveCliGatewayRoute.mockReset();
  tauriMocks.aiEditViaCli.mockReset();
  tauriMocks.cancelAiCli.mockReset();
  tauriMocks.freeProxyEnsure.mockReset();
  tauriMocks.isTauri.mockReset();
  tauriMocks.tauriAvailable.mockReset();
  tauriMocks.freeProxyEnsure.mockResolvedValue({ port: 8765, token: 'test-token' });
  tauriMocks.isTauri.mockReturnValue(false);
  tauriMocks.tauriAvailable.mockReturnValue(false);
  resetStore(defaultBlueprint('Current workflow'));
  window.localStorage.clear();
  await refreshCliRuntime();
});

describe('simple-workflow chat mode', () => {
  it('creates plain chat history entries with an untitled session placeholder', async () => {
    window.localStorage.clear();
    await historyStore.ready();
    const workspace = await historyStore.resolveWorkspaceByPath('');
    resetStore(defaultBlueprint('Current workflow'));
    useStore.setState({
      historyReady: true,
      activeWorkspaceId: workspace.id,
      workspaces: [workspace],
      sessions: [],
      sessionTree: { [workspace.id]: [] },
      locale: 'zh-CN',
    });

    useStore.getState().newSession();

    await waitFor(
      () => useStore.getState().sessions[0]?.title === '未命名会话',
      'plain chat session history title',
    );

    const session = useStore.getState().sessions[0];
    const record = await historyStore.getSession(workspace.id, session.id);

    expect(session.isWorkflow).toBe(false);
    expect(session.title).toBe('未命名会话');
    expect(useStore.getState().workflow.meta.simple).toBe(true);
    expect(useStore.getState().workflow.nodes).toHaveLength(1);
    expect(record?.title).toBe('未命名会话');
    expect(record?.isWorkflow).toBe(false);
    expect(record?.workflow).toBeUndefined();
  });

  it('uses the General CLI selection as the default gateway for new simple sessions', async () => {
    window.localStorage.clear();
    await historyStore.ready();
    await selectKnownCli('codex');
    const workspace = await historyStore.resolveWorkspaceByPath('');
    resetStore(defaultBlueprint('Current workflow'));
    useStore.setState({
      historyReady: true,
      activeWorkspaceId: workspace.id,
      workspaces: [workspace],
      sessions: [],
      sessionTree: { [workspace.id]: [] },
      locale: 'zh-CN',
    });

    useStore.getState().newSession();

    await waitFor(
      () => useStore.getState().workflow.meta.simple === true,
      'plain chat mode activation',
    );
    expect(workflowDefaultGatewaySelection(useStore.getState().workflow)).toEqual({
      adapter: 'codex',
      modelClass: 'default',
      systemDefault: true,
    });

    const chatSessionId = useStore.getState().activeSessionId;
    useStore.getState().newSimpleWorkflow();

    await waitFor(
      async () => {
        const state = useStore.getState();
        if (!state.activeSessionId || state.activeSessionId === chatSessionId) {
          return false;
        }
        const record = await historyStore.getSession(
          workspace.id,
          state.activeSessionId,
        );
        return record?.workflow?.meta.simple === true;
      },
      'simple workflow session creation',
    );
    const simpleSessionId = useStore.getState().activeSessionId;
    const record = simpleSessionId
      ? await historyStore.getSession(workspace.id, simpleSessionId)
      : null;

    expect(workflowDefaultGatewaySelection(useStore.getState().workflow)).toEqual({
      adapter: 'codex',
      modelClass: 'default',
      systemDefault: true,
    });
    expect(record?.workflow?.meta.gateway?.defaults).toEqual({
      adapter: 'codex',
      modelClass: 'default',
      systemDefault: true,
    });
  });

  it('switches the active history workspace when the composer workspace changes after a new session', async () => {
    window.localStorage.clear();
    await historyStore.ready();
    const sourceWorkspace =
      await historyStore.resolveWorkspaceByPath('E:\\project_moon_ues\\MoonEngine');
    const targetWorkspace =
      await historyStore.resolveWorkspaceByPath('E:\\project_moon_ues\\MoonGame\\Client\\Game');
    const targetSession = await historyStore.createSession({
      workspaceId: targetWorkspace.id,
      isWorkflow: false,
      messages: [],
      title: 'Game chat',
    });
    resetStore(defaultBlueprint('Current workflow'));
    useStore.setState({
      historyReady: true,
      activeWorkspaceId: sourceWorkspace.id,
      workspaces: [sourceWorkspace, targetWorkspace],
      sessions: [],
      sessionTree: {
        [sourceWorkspace.id]: [],
        [targetWorkspace.id]: [
          {
            id: targetSession.id,
            workspaceId: targetWorkspace.id,
            title: targetSession.title,
            createdAt: targetSession.createdAt,
            updatedAt: targetSession.updatedAt,
            isWorkflow: false,
            messageCount: 0,
          },
        ],
      },
      locale: 'zh-CN',
    });

    useStore.getState().newSession();
    await waitFor(
      () => useStore.getState().sessions[0]?.title === '未命名会话',
      'new source workspace session',
    );

    useStore.getState().setWorkspace(targetWorkspace.path);
    await waitFor(
      () => useStore.getState().activeWorkspaceId === targetWorkspace.id,
      'target workspace activation',
    );

    const state = useStore.getState();
    expect(state.composer.workspace).toBe(targetWorkspace.path);
    expect(state.activeWorkspaceId).toBe(targetWorkspace.id);
    expect(state.sessions.map((session) => session.id)).toEqual([
      targetSession.id,
    ]);
    expect(state.activeSessionId).toBe(targetSession.id);
  });

  it('keeps the target history workspace when a stale new-session write finishes late', async () => {
    window.localStorage.clear();
    await historyStore.ready();
    const sourceWorkspace =
      await historyStore.resolveWorkspaceByPath('E:\\project_moon_ues\\MoonEngine');
    const targetWorkspace =
      await historyStore.resolveWorkspaceByPath('E:\\project_moon_ues\\MoonGame\\Client\\Game');
    const targetSession = await historyStore.createSession({
      workspaceId: targetWorkspace.id,
      isWorkflow: false,
      messages: [],
      title: 'Game chat',
    });
    resetStore(defaultBlueprint('Current workflow'));
    useStore.setState({
      historyReady: true,
      activeWorkspaceId: sourceWorkspace.id,
      workspaces: [sourceWorkspace, targetWorkspace],
      sessions: [],
      sessionTree: {
        [sourceWorkspace.id]: [],
        [targetWorkspace.id]: [
          {
            id: targetSession.id,
            workspaceId: targetWorkspace.id,
            title: targetSession.title,
            createdAt: targetSession.createdAt,
            updatedAt: targetSession.updatedAt,
            isWorkflow: false,
            messageCount: 0,
          },
        ],
      },
      locale: 'zh-CN',
    });

    const createSession = historyStore.createSession.bind(historyStore);
    let releaseSourceCreate!: () => void;
    const sourceCreateGate = new Promise<void>((resolve) => {
      releaseSourceCreate = resolve;
    });
    const createSpy = vi
      .spyOn(historyStore, 'createSession')
      .mockImplementation(async (input) => {
        if (input.workspaceId === sourceWorkspace.id) {
          await sourceCreateGate;
        }
        return createSession(input);
      });

    try {
      useStore.getState().newSession();
      await waitFor(
        () =>
          createSpy.mock.calls.some(
            ([input]) => input.workspaceId === sourceWorkspace.id,
          ),
        'source workspace session creation to start',
      );

      useStore.getState().setWorkspace(targetWorkspace.path);
      await waitFor(
        () =>
          useStore.getState().activeWorkspaceId === targetWorkspace.id &&
          useStore.getState().activeSessionId === targetSession.id,
        'target workspace activation before stale create finishes',
      );

      releaseSourceCreate();
      await waitFor(async () => {
        const sessions = await historyStore.listSessions(sourceWorkspace.id);
        return sessions.length > 0;
      }, 'late source workspace session persistence');
      await Promise.resolve();

      const state = useStore.getState();
      expect(state.composer.workspace).toBe(targetWorkspace.path);
      expect(state.activeWorkspaceId).toBe(targetWorkspace.id);
      expect(state.sessions.map((session) => session.id)).toEqual([
        targetSession.id,
      ]);
      expect(state.activeSessionId).toBe(targetSession.id);
    } finally {
      createSpy.mockRestore();
    }
  });

  it('keeps a plain chat session non-workflow after a direct model reply', async () => {
    window.localStorage.clear();
    await historyStore.ready();
    const workspace = await historyStore.resolveWorkspaceByPath('');
    resetStore(defaultBlueprint('Current workflow'));
    useStore.setState({
      historyReady: true,
      activeWorkspaceId: workspace.id,
      workspaces: [workspace],
      sessions: [],
      sessionTree: { [workspace.id]: [] },
      locale: 'zh-CN',
    });

    useStore.getState().newSession();

    await waitFor(
      () => useStore.getState().workflow.meta.simple === true,
      'plain chat mode activation',
    );

    const sessionId = useStore.getState().activeSessionId;
    expect(sessionId).toBeTruthy();
    mockDirectRoute();
    const requests: Array<{ system: string; userContent: string }> = [];
    gatewayMocks.completeGatewayText.mockImplementation(async (request) => {
      requests.push({
        system: String(request.system),
        userContent: String(request.userContent),
      });
      return '普通回答。';
    });

    useStore.getState().sendPrompt('你好，介绍一下你自己。');

    await waitFor(
      () =>
        !useStore.getState().aiStreaming &&
        useStore.getState().messages.some((m) => m.role === 'assistant'),
      'plain chat assistant reply',
    );
    await waitFor(async () => {
      if (!sessionId) return false;
      const record = await historyStore.getSession(workspace.id, sessionId);
      return (record?.messages.length ?? 0) >= 2;
    }, 'plain chat history persistence');

    const state = useStore.getState();
    const session = state.sessions.find((item) => item.id === sessionId);
    const record = sessionId
      ? await historyStore.getSession(workspace.id, sessionId)
      : null;

    expect(requests[0].system).toContain('简单 Workflow');
    expect(requests[0].system).not.toContain('IRGraph 结构');
    expect(requests[0].userContent).not.toContain('IRGraph');
    expect(state.workflow.meta.simple).toBe(true);
    expect(session?.isWorkflow).toBe(false);
    expect(session?.runStatus).toBe('success');
    expect(record?.isWorkflow).toBe(false);
    expect(record?.workflow).toBeUndefined();
    expect(record?.meta?.runStatus).toBe('success');
  });

  it('marks a plain chat history entry failed when the model call fails', async () => {
    window.localStorage.clear();
    await historyStore.ready();
    const workspace = await historyStore.resolveWorkspaceByPath('');
    resetStore(defaultBlueprint('Current workflow'));
    useStore.setState({
      historyReady: true,
      activeWorkspaceId: workspace.id,
      workspaces: [workspace],
      sessions: [],
      sessionTree: { [workspace.id]: [] },
      locale: 'zh-CN',
    });

    useStore.getState().newSession();
    await waitFor(
      () => useStore.getState().workflow.meta.simple === true,
      'plain chat mode activation',
    );

    const sessionId = useStore.getState().activeSessionId;
    expect(sessionId).toBeTruthy();
    mockDirectRoute();
    gatewayMocks.completeGatewayText.mockRejectedValue(new Error('boom'));

    useStore.getState().sendPrompt('这次会失败吗？');

    await waitFor(
      () =>
        !useStore.getState().aiStreaming &&
        useStore
          .getState()
          .messages.some((m) => m.role === 'assistant' && m.text.includes('调用失败')),
      'plain chat failure',
    );
    await waitFor(async () => {
      if (!sessionId) return false;
      const record = await historyStore.getSession(workspace.id, sessionId);
      return record?.meta?.runStatus === 'error';
    }, 'plain chat failed status persistence');

    const session = useStore
      .getState()
      .sessions.find((item) => item.id === sessionId);
    const record = sessionId
      ? await historyStore.getSession(workspace.id, sessionId)
      : null;

    expect(session?.isWorkflow).toBe(false);
    expect(session?.runStatus).toBe('error');
    expect(record?.isWorkflow).toBe(false);
    expect(record?.workflow).toBeUndefined();
    expect(record?.meta?.runStatus).toBe('error');
  });

  it('creates history entries with an untitled session placeholder', async () => {
    window.localStorage.clear();
    await historyStore.ready();
    const workspace = await historyStore.resolveWorkspaceByPath('');
    resetStore(defaultBlueprint('Current workflow'));
    useStore.setState({
      historyReady: true,
      activeWorkspaceId: workspace.id,
      workspaces: [workspace],
      sessions: [],
      sessionTree: { [workspace.id]: [] },
      locale: 'zh-CN',
    });

    useStore.getState().newSimpleWorkflow();

    await waitFor(
      () => useStore.getState().sessions[0]?.title === '未命名会话',
      'simple session history title',
    );

    const state = useStore.getState();
    const session = state.sessions[0];
    const record = await historyStore.getSession(workspace.id, session.id);

    expect(state.workflow.meta.simple).toBe(true);
    expect(state.workflow.meta.name).toBe('未命名会话');
    expect(session.title).toBe('未命名会话');
    expect(record?.title).toBe('未命名会话');
    expect(record?.workflow?.meta.name).toBe('未命名会话');
  });

  it('localizes the untitled session placeholder', () => {
    expect(simpleBlueprint(undefined, 'en-US').meta.name).toBe('Untitled Session');
    expect(simpleBlueprint(undefined, 'ja-JP').meta.name).toBe('無題のセッション');
    expect(simpleBlueprint(undefined, 'ko-KR').meta.name).toBe('제목 없는 세션');
  });

  it('answers directly without generating an IRGraph and keeps a single node', async () => {
    resetStore(simpleBlueprint('Simple chat'));
    mockDirectRoute();
    const requests: Array<{ system: string; userContent: string }> = [];
    gatewayMocks.completeGatewayText.mockImplementation(async (request) => {
      requests.push({
        system: String(request.system),
        userContent: String(request.userContent),
      });
      return '这是直接的回答。';
    });

    useStore.getState().sendPrompt('帮我算一下 2 加 2 等于几？');

    await waitFor(
      () =>
        !useStore.getState().aiStreaming &&
        useStore.getState().messages.some((m) => m.role === 'assistant'),
      'the assistant answer',
    );

    // Exactly one model call, no blueprint generation.
    expect(gatewayMocks.completeGatewayText).toHaveBeenCalledTimes(1);
    // Uses the plain-chat system prompt, NOT the blueprint editor prompt.
    expect(requests[0].system).toContain('简单 Workflow');
    expect(requests[0].system).not.toContain('IRGraph 结构');
    // The model was NOT asked to produce a graph and none was applied.
    expect(requests[0].userContent).not.toContain('IRGraph');
    const graph = useStore.getState().workflow;
    expect(graph.meta.simple).toBe(true);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].type).toBe('start');
    expect(graph.edges).toHaveLength(0);
    // The user input is recorded on the lone node; the answer stays in messages.
    expect(graph.nodes[0].params.userInputs).toContain('帮我算一下 2 加 2 等于几？');
    const assistant = useStore
      .getState()
      .messages.find((m) => m.role === 'assistant');
    expect(assistant?.text).toContain('这是直接的回答。');
  });

  it('folds prior turns into the prompt for multi-turn context', async () => {
    resetStore(simpleBlueprint('Simple chat'));
    mockDirectRoute();
    const userContents: string[] = [];
    gatewayMocks.completeGatewayText.mockImplementation(async (request) => {
      userContents.push(String(request.userContent));
      return userContents.length === 1 ? '北京是中国的首都。' : '它大约有 2000 多万人口。';
    });

    useStore.getState().sendPrompt('中国的首都是哪里？');
    await waitFor(
      () => !useStore.getState().aiStreaming && userContents.length === 1,
      'the first answer',
    );

    useStore.getState().sendPrompt('那它有多少人口？');
    await waitFor(
      () => !useStore.getState().aiStreaming && userContents.length === 2,
      'the second answer',
    );

    // First turn: just the question, no transcript.
    expect(userContents[0]).toContain('中国的首都是哪里？');
    expect(userContents[0]).not.toContain('助手：');
    // Second turn: prior conversation is folded in as context.
    expect(userContents[1]).toContain('之前的对话');
    expect(userContents[1]).toContain('中国的首都是哪里？');
    expect(userContents[1]).toContain('北京是中国的首都。');
    expect(userContents[1]).toContain('那它有多少人口？');

    // Both inputs accumulate on the single node.
    const node = useStore.getState().workflow.nodes[0];
    expect(node.params.userInputs).toEqual([
      '中国的首都是哪里？',
      '那它有多少人口？',
    ]);
  });

  it('reuses a native Claude CLI chat session for the same model and replays history after switching models', async () => {
    window.localStorage.clear();
    await historyStore.ready();
    const workspace = await historyStore.resolveWorkspaceByPath('');
    const record = await historyStore.createSession({
      workspaceId: workspace.id,
      isWorkflow: false,
      messages: [],
      title: 'Chat',
    });
    resetStore(simpleBlueprint('Chat'));
    const session = {
      id: record.id,
      workspaceId: workspace.id,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      isWorkflow: false,
      messageCount: 0,
    };
    useStore.setState({
      historyReady: true,
      activeWorkspaceId: workspace.id,
      activeSessionId: record.id,
      workspaces: [workspace],
      sessions: [session],
      sessionTree: { [workspace.id]: [session] },
      locale: 'zh-CN',
    });
    tauriMocks.isTauri.mockReturnValue(true);
    tauriMocks.tauriAvailable.mockReturnValue(true);
    gatewayMocks.resolveDirectGatewayRoute.mockReturnValue(null);
    gatewayMocks.resolveCliGatewayRoute.mockImplementation(async (selection) => ({
      selection,
      adapter: 'claude-code',
      modelClass: selection.modelClass,
      model: selection.modelClass,
      transport: 'cli',
      mode: 'cli',
      label: 'Claude Code',
      source: 'global',
      cliCommand: 'claude',
    }));
    const calls: Array<{ prompt: string; opts: { sessionId?: string; resume?: boolean; model?: string } }> = [];
    tauriMocks.aiEditViaCli.mockImplementation(async (prompt, _adapter, opts) => {
      calls.push({ prompt, opts });
      if (calls.length === 1) return '北京是中国的首都。';
      if (calls.length === 2) return '它大约有 2000 多万人口。';
      if (calls.length === 3) return '切换模型后的回答。';
      return '切回原模型后的回答。';
    });

    useStore.getState().sendPrompt('中国的首都是哪里？');
    await waitFor(
      () => !useStore.getState().aiStreaming && calls.length === 1,
      'first CLI chat call',
    );

    useStore.getState().sendPrompt('那它有多少人口？');
    await waitFor(
      () => !useStore.getState().aiStreaming && calls.length === 2,
      'second CLI chat call',
    );

    useStore.getState().setGlobalRunSelection({
      adapter: 'claude-code',
      modelClass: 'opus',
    });
    useStore.getState().sendPrompt('换个模型后还能接上文吗？');
    await waitFor(
      () => !useStore.getState().aiStreaming && calls.length === 3,
      'model-switched CLI chat call',
    );

    expect(calls[0].opts.sessionId).toEqual(expect.any(String));
    expect(calls[0].opts.resume).toBe(false);
    expect(calls[1].opts.sessionId).toBe(calls[0].opts.sessionId);
    expect(calls[1].opts.resume).toBe(true);
    expect(calls[1].prompt).not.toContain('之前的对话');
    expect(calls[1].prompt).toContain('那它有多少人口？');

    expect(calls[2].opts.model).toBe('opus');
    expect(calls[2].opts.sessionId).toEqual(expect.any(String));
    expect(calls[2].opts.sessionId).not.toBe(calls[0].opts.sessionId);
    expect(calls[2].opts.resume).toBe(false);
    expect(calls[2].prompt).toContain('之前的对话');
    expect(calls[2].prompt).toContain('中国的首都是哪里？');
    expect(calls[2].prompt).toContain('北京是中国的首都。');
    expect(calls[2].prompt).toContain('换个模型后还能接上文吗？');

    useStore.getState().setGlobalRunSelection({
      adapter: 'claude-code',
      modelClass: 'sonnet',
    });
    useStore.getState().sendPrompt('再切回原模型呢？');
    await waitFor(
      () => !useStore.getState().aiStreaming && calls.length === 4,
      'switched-back CLI chat call',
    );

    expect(calls[3].opts.model).toBe('sonnet');
    expect(calls[3].opts.sessionId).toBe(calls[0].opts.sessionId);
    expect(calls[3].opts.resume).toBe(true);
    expect(calls[3].prompt).toContain('尚未看到的中间对话');
    expect(calls[3].prompt).toContain('换个模型后还能接上文吗？');
    expect(calls[3].prompt).toContain('切换模型后的回答。');
    expect(calls[3].prompt).toContain('再切回原模型呢？');
  });

  it('does NOT enter chat mode for a normal workflow (blueprint generation path)', async () => {
    resetStore(defaultBlueprint('Normal workflow'));
    mockDirectRoute();
    const requests: Array<{ system: string }> = [];
    gatewayMocks.completeGatewayText.mockImplementation(async (request) => {
      requests.push({ system: String(request.system) });
      // Return prose (no graph) so the turn finalizes quickly.
      return '这是一个说明。';
    });

    useStore.getState().sendPrompt('随便说点什么。');
    await waitFor(
      () => !useStore.getState().aiStreaming && requests.length >= 1,
      'the normal workflow call',
    );

    // Normal mode uses the blueprint editor system prompt, not the chat one.
    expect(requests[0].system).toContain('IRGraph 结构');
    expect(requests[0].system).not.toContain('简单 Workflow');
  });

  it('surfaces as chatting (not blueprint editing) and never locks the workflow read-only', async () => {
    resetStore(simpleBlueprint('Simple chat'));
    mockDirectRoute();
    let resolveReply!: (value: string) => void;
    gatewayMocks.completeGatewayText.mockImplementation(
      async () => new Promise<string>((resolve) => (resolveReply = resolve)),
    );

    useStore.getState().sendPrompt('第一个问题');
    await waitFor(() => useStore.getState().aiStreaming, 'chat to start');

    // In flight: a chat turn is busy but NOT a blueprint edit, and the workflow
    // is NOT read-only (so the user can keep chatting).
    const state = useStore.getState();
    expect(state.chattingSessions.length).toBe(1);
    expect(state.aiEditingSessions.length).toBe(0);
    expect(isWorkflowReadOnly(state)).toBe(false);
    expect(isActiveAiEditingSession(state)).toBe(false);

    resolveReply('回答一');
    await waitFor(
      () => !useStore.getState().aiStreaming,
      'chat to finish',
    );
    expect(useStore.getState().chattingSessions.length).toBe(0);
  });

  it('stops an active direct simple chat and clears the live chatting state', async () => {
    resetStore(simpleBlueprint('Simple chat'));
    mockDirectRoute();
    let request: { signal?: AbortSignal } | null = null;
    gatewayMocks.completeGatewayText.mockImplementation(
      async (req) =>
        await new Promise<string>(() => {
          request = req as { signal?: AbortSignal };
        }),
    );

    useStore.getState().sendPrompt('停得住吗？');
    await waitFor(
      () => useStore.getState().chattingSessions.length === 1 && !!request,
      'chat to start',
    );

    useStore.getState().stopChat();

    expect((request as { signal?: AbortSignal } | null)?.signal?.aborted).toBe(
      true,
    );
    expect(useStore.getState().chattingSessions.length).toBe(0);
    expect(useStore.getState().aiStreaming).toBe(false);
    expect(
      useStore
        .getState()
        .messages.some((m) => m.role === 'assistant' && m.text.includes('会话已中断')),
    ).toBe(true);
  });

  it('stops an active CLI simple chat by cancelling its run id', async () => {
    resetStore(simpleBlueprint('Simple chat'));
    tauriMocks.isTauri.mockReturnValue(true);
    tauriMocks.tauriAvailable.mockReturnValue(true);
    gatewayMocks.resolveDirectGatewayRoute.mockReturnValue(null);
    gatewayMocks.resolveCliGatewayRoute.mockResolvedValue({
      selection: { adapter: 'claude-code', modelClass: 'sonnet' },
      adapter: 'claude-code',
      modelClass: 'sonnet',
      model: 'sonnet',
      transport: 'cli',
      mode: 'cli',
      label: 'Claude Code',
      source: 'fallback',
      cliCommand: 'claude',
    });
    tauriMocks.aiEditViaCli.mockImplementation(
      async () => await new Promise<string>(() => {}),
    );

    useStore.getState().sendPrompt('查一下项目');
    await waitFor(
      () => tauriMocks.aiEditViaCli.mock.calls.length === 1,
      'CLI chat to start',
    );
    const runId = tauriMocks.aiEditViaCli.mock.calls[0]?.[2]?.runId;

    useStore.getState().stopChat();
    await waitFor(
      () => tauriMocks.cancelAiCli.mock.calls.length === 1,
      'CLI cancel to be requested',
    );

    expect(runId).toEqual(expect.any(String));
    expect(tauriMocks.cancelAiCli).toHaveBeenCalledWith(runId);
    expect(useStore.getState().chattingSessions.length).toBe(0);
  });

  it('keeps both replies when a second chat message finishes before the first', async () => {
    resetStore(simpleBlueprint('Simple chat'));
    mockDirectRoute();
    const resolvers: Array<(value: string) => void> = [];
    gatewayMocks.completeGatewayText.mockImplementation(
      async () => new Promise<string>((resolve) => resolvers.push(resolve)),
    );

    useStore.getState().sendPrompt('问题一');
    await waitFor(() => resolvers.length === 1, 'first chat call');

    // Second send must NOT be rejected by the read-only gate.
    useStore.getState().sendPrompt('问题二');
    await waitFor(() => resolvers.length === 2, 'second chat call (not blocked)');

    expect(gatewayMocks.completeGatewayText).toHaveBeenCalledTimes(2);

    resolvers[1]('答二');
    await waitFor(
      () =>
        useStore
          .getState()
          .messages.some((m) => m.role === 'assistant' && m.text.includes('答二')),
      'second chat reply',
    );
    expect(useStore.getState().aiStreaming).toBe(true);

    resolvers[0]('答一');
    await waitFor(
      () =>
        !useStore.getState().aiStreaming &&
        useStore
          .getState()
          .messages.some((m) => m.role === 'assistant' && m.text.includes('答一')),
      'all chat turns to finish',
    );

    const assistantText = useStore
      .getState()
      .messages.filter((m) => m.role === 'assistant')
      .map((m) => m.text)
      .join('\n');
    expect(assistantText).toContain('答一');
    expect(assistantText).toContain('答二');
    expect(useStore.getState().workflow.nodes[0].params.userInputs).toEqual([
      '问题一',
      '问题二',
    ]);
  });

  it('streams CLI progress into the plain chat bubble before the final reply', async () => {
    resetStore(simpleBlueprint('Simple chat'));
    tauriMocks.isTauri.mockReturnValue(true);
    tauriMocks.tauriAvailable.mockReturnValue(true);
    gatewayMocks.resolveDirectGatewayRoute.mockReturnValue(null);
    gatewayMocks.resolveCliGatewayRoute.mockResolvedValue({
      selection: { adapter: 'claude-code', modelClass: 'sonnet' },
      adapter: 'claude-code',
      modelClass: 'sonnet',
      model: 'sonnet',
      transport: 'cli',
      mode: 'cli',
      label: 'Claude Code',
      source: 'fallback',
      cliCommand: 'claude',
    });
    let finish!: (value: string) => void;
    tauriMocks.aiEditViaCli.mockImplementation(async (_prompt, _adapter, opts) => {
      opts.onProgress?.('⚙ 会话已启动\n');
      await Promise.resolve();
      opts.onProgress?.('🔎 正在读取上下文\n');
      return await new Promise<string>((resolve) => {
        finish = resolve;
      });
    });

    useStore.getState().sendPrompt('这个问题要查项目上下文');

    await waitFor(
      () =>
        useStore
          .getState()
          .messages.some((m) => m.role === 'assistant' && m.text.includes('正在读取上下文')),
      'CLI progress to appear in chat',
    );
    const live = useStore
      .getState()
      .messages.find((m) => m.role === 'assistant');
    expect(live?.text).toContain('⚙ 会话已启动');
    expect(live?.text).toContain('🔎 正在读取上下文');
    expect(tauriMocks.aiEditViaCli.mock.calls[0]?.[2]?.onProgress).toEqual(
      expect.any(Function),
    );

    finish('最终回答。');
    await waitFor(
      () =>
        !useStore.getState().aiStreaming &&
        useStore
          .getState()
          .messages.some((m) => m.role === 'assistant' && m.text.includes('最终回答。')),
      'CLI final reply',
    );
  });

  it('starts the free proxy before resolving a free-channel CLI chat route', async () => {
    const workflow = simpleBlueprint('Simple chat');
    workflow.meta.gateway = {
      defaults: {
        adapter: 'claude-code',
        modelClass: 'sonnet',
        providerId: 'freecc:kilo',
        channelId: 'default',
      },
    };
    resetStore(workflow);
    tauriMocks.isTauri.mockReturnValue(true);
    tauriMocks.tauriAvailable.mockReturnValue(true);
    gatewayMocks.resolveDirectGatewayRoute.mockReturnValue(null);
    const order: string[] = [];
    tauriMocks.freeProxyEnsure.mockImplementation(async () => {
      order.push('ensure');
      return { port: 8765, token: 'test-token' };
    });
    gatewayMocks.resolveCliGatewayRoute.mockImplementation(async () => {
      order.push('resolve');
      return {
        selection: {
          adapter: 'claude-code',
          modelClass: 'sonnet',
          providerId: 'freecc:kilo',
          channelId: 'default',
        },
        adapter: 'claude-code',
        modelClass: 'sonnet',
        model: 'poolside/laguna-xs.2:free',
        transport: 'cli',
        mode: 'cli',
        label: 'Free · Kilo Gateway',
        source: 'global',
        cliCommand: 'claude',
        env: {
          ANTHROPIC_API_KEY: 'test-token',
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:8765/ch/kilo',
          ANTHROPIC_MODEL: 'poolside/laguna-xs.2:free',
        },
      };
    });
    tauriMocks.aiEditViaCli.mockResolvedValue('Kilo answer');

    useStore.getState().sendPrompt('测试免费渠道');

    await waitFor(
      () => tauriMocks.aiEditViaCli.mock.calls.length === 1,
      'free-channel chat call',
    );
    expect(order).toEqual(['ensure', 'resolve']);
    expect(tauriMocks.freeProxyEnsure).toHaveBeenCalled();
    expect(tauriMocks.aiEditViaCli.mock.calls[0]?.[2]?.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8765/ch/kilo',
      ANTHROPIC_MODEL: 'poolside/laguna-xs.2:free',
    });
  });

  it('surfaces free proxy startup failures before invoking the CLI', async () => {
    const workflow = simpleBlueprint('Simple chat');
    workflow.meta.gateway = {
      defaults: {
        adapter: 'claude-code',
        modelClass: 'sonnet',
        providerId: 'freecc:kilo',
        channelId: 'default',
      },
    };
    resetStore(workflow);
    tauriMocks.isTauri.mockReturnValue(true);
    tauriMocks.tauriAvailable.mockReturnValue(true);
    gatewayMocks.resolveDirectGatewayRoute.mockReturnValue(null);
    tauriMocks.freeProxyEnsure.mockRejectedValue(new Error('bind failed'));

    useStore.getState().sendPrompt('测试免费渠道失败');

    await waitFor(
      () =>
        useStore
          .getState()
          .messages.some(
            (m) =>
              m.role === 'assistant' &&
              m.text.includes('free proxy failed to start: bind failed'),
          ),
      'free proxy startup error',
    );
    expect(gatewayMocks.resolveCliGatewayRoute).not.toHaveBeenCalled();
    expect(tauriMocks.aiEditViaCli).not.toHaveBeenCalled();
  });

  it('restores the live assistant bubble when switching back to a session mid-stream', async () => {
    window.localStorage.clear();
    await historyStore.ready();
    const workspace = await historyStore.resolveWorkspaceByPath('');
    resetStore(simpleBlueprint('Simple chat'));
    // Create two simple-workflow sessions in history so we can flip between
    // them while a stream is in flight on the first one.
    const sessionA = await historyStore.createSession({
      workspaceId: workspace.id,
      isWorkflow: true,
      workflow: simpleBlueprint('Chat A'),
      title: 'Chat A',
    });
    const sessionB = await historyStore.createSession({
      workspaceId: workspace.id,
      isWorkflow: true,
      workflow: simpleBlueprint('Chat B'),
      title: 'Chat B',
    });
    const sessionTree = {
      [workspace.id]: [
        {
          id: sessionA.id,
          workspaceId: workspace.id,
          title: sessionA.title,
          createdAt: sessionA.createdAt,
          updatedAt: sessionA.updatedAt,
          isWorkflow: true,
          messageCount: 0,
          simple: true,
        },
        {
          id: sessionB.id,
          workspaceId: workspace.id,
          title: sessionB.title,
          createdAt: sessionB.createdAt,
          updatedAt: sessionB.updatedAt,
          isWorkflow: true,
          messageCount: 0,
          simple: true,
        },
      ],
    };
    useStore.setState({
      historyReady: true,
      activeWorkspaceId: workspace.id,
      activeSessionId: sessionA.id,
      workspaces: [workspace],
      sessions: sessionTree[workspace.id],
      sessionTree,
      workflow: simpleBlueprint('Chat A'),
      locale: 'zh-CN',
    });

    mockDirectRoute();
    let finish!: (value: string) => void;
    let progressEmit!: (chunk: string) => void;
    gatewayMocks.completeGatewayText.mockImplementation(async (request) => {
      progressEmit = (chunk: string) => request.onDelta?.(chunk);
      return await new Promise<string>((resolve) => {
        finish = resolve;
      });
    });

    useStore.getState().sendPrompt('一个很长的问题');
    await waitFor(
      () => typeof progressEmit === 'function',
      'stream to start',
    );

    // Emit some streaming chunks while the user is viewing sessionA.
    progressEmit('partial-one. ');
    await waitFor(
      () =>
        useStore
          .getState()
          .messages.some(
            (m) => m.role === 'assistant' && m.text.includes('partial-one'),
          ),
      'first chunk to land in the view',
    );

    // Now switch AWAY to sessionB, simulating the user clicking another chat.
    useStore.getState().selectSession(sessionB.id, workspace.id);
    await waitFor(
      () => useStore.getState().activeSessionId === sessionB.id,
      'session B to become active',
    );

    // The stream continues in the background and produces more text the user
    // is not currently seeing.
    progressEmit('partial-two-while-away. ');
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Switch BACK to sessionA. This is the bug surface: the assistant bubble
    // should still be visible with the streamed text, not blank.
    useStore.getState().selectSession(sessionA.id, workspace.id);
    await waitFor(
      () => useStore.getState().activeSessionId === sessionA.id,
      'session A to become active again',
    );

    const assistant = useStore
      .getState()
      .messages.find((m) => m.role === 'assistant');
    expect(assistant?.text ?? '').toContain('partial-one');
    expect(assistant?.text ?? '').toContain('partial-two-while-away');

    // Finish cleanly so the test doesn't leak the pending stream.
    finish('done.');
    await waitFor(
      () => !useStore.getState().aiStreaming,
      'stream to settle',
    );
  });
});
