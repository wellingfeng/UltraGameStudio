import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultBlueprint, simpleBlueprint } from '@/core/defaultBlueprint';
import type { IRGraph } from '@/core/ir';
import { personalInstructionsKey } from '@/core/personalInstructions';
import { encodeToolPatch } from '@/components/ai/lib/toolEvent';
import { refreshCliRuntime } from '@/lib/cliConfig';
import {
  systemDefaultGatewaySelection,
  workflowDefaultGatewaySelection,
} from '@/lib/modelGateway/resolver';
import { DEFAULT_GAME_EXPERT_SETTINGS } from '@/lib/gameExperts';

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

const notificationMocks = vi.hoisted(() => ({
  notifySessionComplete: vi.fn(),
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

vi.mock('@/lib/sessionNotification', async () => {
  const actual = await vi.importActual<typeof import('@/lib/sessionNotification')>(
    '@/lib/sessionNotification',
  );
  return {
    ...actual,
    notifySessionComplete: notificationMocks.notifySessionComplete,
  };
});

import { useStore } from './useStore';
import {
  isActiveAiEditingSession,
  isWorkflowReadOnly,
  __resetSimpleChatRuntimeForTests,
} from './useStore';
import { historyStore } from './history/store';
import type { Message, Session } from './types';

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
    blockedSendTip: null,
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
    personalInstructions: '',
    personalInstructionsByModel: {},
    gameExpertSettings: {
      ...DEFAULT_GAME_EXPERT_SETTINGS,
      enabledExpertIds: [...DEFAULT_GAME_EXPERT_SETTINGS.enabledExpertIds],
      customExperts: [...DEFAULT_GAME_EXPERT_SETTINGS.customExperts],
      deletedExpertIds: [...DEFAULT_GAME_EXPERT_SETTINGS.deletedExpertIds],
    },
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
  __resetSimpleChatRuntimeForTests();
  gatewayMocks.completeGatewayText.mockReset();
  gatewayMocks.resolveDirectGatewayRoute.mockReset();
  gatewayMocks.resolveCliGatewayRoute.mockReset();
  tauriMocks.aiEditViaCli.mockReset();
  tauriMocks.cancelAiCli.mockReset();
  tauriMocks.freeProxyEnsure.mockReset();
  tauriMocks.isTauri.mockReset();
  tauriMocks.tauriAvailable.mockReset();
  notificationMocks.notifySessionComplete.mockReset();
  tauriMocks.freeProxyEnsure.mockResolvedValue({ port: 8766, token: 'test-token' });
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

  it('branches a chat session from a selected assistant reply', async () => {
    window.localStorage.clear();
    await historyStore.ready();
    const workspace = await historyStore.resolveWorkspaceByPath('');
    const sourceMessages: Message[] = [
      { id: 'm_user_1', role: 'user', text: '第一个问题', createdAt: 1 },
      { id: 'm_ai_1', role: 'assistant', text: '第一个回答', createdAt: 2 },
      { id: 'm_user_2', role: 'user', text: '第二个问题', createdAt: 3 },
      { id: 'm_ai_2', role: 'assistant', text: '第二个回答', createdAt: 4 },
      { id: 'm_user_3', role: 'user', text: '第三个问题', createdAt: 5 },
      { id: 'm_ai_3', role: 'assistant', text: '第三个回答', createdAt: 6 },
    ];
    const sourceRecord = await historyStore.createSession({
      workspaceId: workspace.id,
      isWorkflow: false,
      title: '原始会话',
      messages: sourceMessages,
    });
    const sourceSession: Session = {
      id: sourceRecord.id,
      workspaceId: workspace.id,
      title: sourceRecord.title,
      createdAt: sourceRecord.createdAt,
      updatedAt: sourceRecord.updatedAt,
      isWorkflow: false,
      preview: sourceMessages.at(-1)?.text,
      messageCount: sourceMessages.length,
    };
    resetStore(defaultBlueprint('Current workflow'));
    useStore.setState({
      historyReady: true,
      activeWorkspaceId: workspace.id,
      workspaces: [workspace],
      sessions: [sourceSession],
      sessionTree: { [workspace.id]: [sourceSession] },
      activeSessionId: sourceRecord.id,
      messages: sourceMessages,
      workflow: simpleBlueprint('原始会话'),
      locale: 'zh-CN',
    });

    useStore.getState().branchSessionFromMessage('m_ai_2');

    await waitFor(
      () =>
        useStore.getState().activeSessionId !== sourceRecord.id &&
        useStore.getState().messages.length === 4,
      'branched chat session activation',
    );

    const state = useStore.getState();
    const branchSessionId = state.activeSessionId;
    const branchRecord = branchSessionId
      ? await historyStore.getSession(workspace.id, branchSessionId)
      : null;

    expect(state.sessions[0]?.title).toBe('分支：原始会话');
    expect(state.messages.map((message) => message.id)).toEqual([
      'm_user_1',
      'm_ai_1',
      'm_user_2',
      'm_ai_2',
    ]);
    expect(branchRecord?.messages.map((message) => message.id)).toEqual([
      'm_user_1',
      'm_ai_1',
      'm_user_2',
      'm_ai_2',
    ]);
    expect(branchRecord?.isWorkflow).toBe(false);
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

  it('keeps the target history workspace when a stale session activation finishes late', async () => {
    window.localStorage.clear();
    await historyStore.ready();
    const sourceWorkspace =
      await historyStore.resolveWorkspaceByPath('E:\\project_moon_ues\\MoonEngine');
    const targetWorkspace =
      await historyStore.resolveWorkspaceByPath('E:\\OpenWorkflows');
    const sourceRecord = await historyStore.createSession({
      workspaceId: sourceWorkspace.id,
      isWorkflow: false,
      messages: [],
      title: 'Moon chat',
    });
    const targetRecord = await historyStore.createSession({
      workspaceId: targetWorkspace.id,
      isWorkflow: false,
      messages: [],
      title: 'OpenWorkflows chat',
    });
    const sourceSession = {
      id: sourceRecord.id,
      workspaceId: sourceWorkspace.id,
      title: sourceRecord.title,
      createdAt: sourceRecord.createdAt,
      updatedAt: sourceRecord.updatedAt,
      isWorkflow: false,
      messageCount: 0,
    };
    const targetSession = {
      id: targetRecord.id,
      workspaceId: targetWorkspace.id,
      title: targetRecord.title,
      createdAt: targetRecord.createdAt,
      updatedAt: targetRecord.updatedAt,
      isWorkflow: false,
      messageCount: 0,
    };
    resetStore(defaultBlueprint('Current workflow'));
    useStore.setState({
      historyReady: true,
      activeWorkspaceId: sourceWorkspace.id,
      activeSessionId: sourceRecord.id,
      composer: {
        ...useStore.getState().composer,
        workspace: sourceWorkspace.path,
      },
      workspaces: [sourceWorkspace, targetWorkspace],
      sessions: [sourceSession],
      sessionTree: {
        [sourceWorkspace.id]: [sourceSession],
        [targetWorkspace.id]: [targetSession],
      },
      locale: 'zh-CN',
    });

    const getSession = historyStore.getSession.bind(historyStore);
    let releaseSourceGet!: () => void;
    const sourceGetGate = new Promise<void>((resolve) => {
      releaseSourceGet = resolve;
    });
    const getSpy = vi
      .spyOn(historyStore, 'getSession')
      .mockImplementation(async (workspaceId, sessionId) => {
        if (
          workspaceId === sourceWorkspace.id &&
          sessionId === sourceRecord.id
        ) {
          await sourceGetGate;
        }
        return getSession(workspaceId, sessionId);
      });

    try {
      useStore.getState().selectSession(sourceRecord.id, sourceWorkspace.id);
      await waitFor(
        () =>
          getSpy.mock.calls.some(
            ([workspaceId, sessionId]) =>
              workspaceId === sourceWorkspace.id &&
              sessionId === sourceRecord.id,
          ),
        'source session activation to start',
      );

      useStore.getState().setWorkspace(targetWorkspace.path);
      await waitFor(
        () =>
          useStore.getState().activeWorkspaceId === targetWorkspace.id &&
          useStore.getState().activeSessionId === targetRecord.id,
        'target workspace activation before stale session activation finishes',
      );

      releaseSourceGet();
      await Promise.all(
        getSpy.mock.results.map((result) =>
          result.type === 'return'
            ? result.value.catch(() => undefined)
            : undefined,
        ),
      );
      await Promise.resolve();
      await Promise.resolve();

      const state = useStore.getState();
      expect(state.composer.workspace).toBe(targetWorkspace.path);
      expect(state.activeWorkspaceId).toBe(targetWorkspace.id);
      expect(state.sessions.map((session) => session.id)).toEqual([
        targetRecord.id,
      ]);
      expect(state.activeSessionId).toBe(targetRecord.id);
    } finally {
      getSpy.mockRestore();
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

  it('injects app personal instructions for Codex simple chat prompts', async () => {
    const workflow = simpleBlueprint('Simple chat');
    workflow.meta.gateway = {
      defaults: { adapter: 'codex', modelClass: 'default' },
    };
    resetStore(workflow);
    const codexSelection = { adapter: 'codex', modelClass: 'default' };
    useStore.setState({
      personalInstructionsByModel: {
        [personalInstructionsKey(codexSelection)]:
          '# Personal Defaults\n\n- 默认使用中文',
      },
      personalInstructions: '# Personal Defaults\n\n- 默认使用中文',
    });
    gatewayMocks.resolveDirectGatewayRoute.mockReturnValue({
      selection: { adapter: 'codex', modelClass: 'default' },
      adapter: 'codex',
      apiKey: 'test-key',
      model: 'gpt-5-codex',
      transport: 'openai-compatible',
    });
    const systems: string[] = [];
    gatewayMocks.completeGatewayText.mockImplementation(async (request) => {
      systems.push(String(request.system));
      return 'Codex answer.';
    });

    useStore.getState().sendPrompt('测试 Codex 个性化是否重复');

    await waitFor(
      () =>
        !useStore.getState().aiStreaming &&
        useStore.getState().messages.some((m) => m.role === 'assistant'),
      'codex simple chat answer',
    );

    expect(systems[0]).toContain('简单 Workflow');
    expect(systems[0]).toContain('【用户个人默认指令（低优先级）】');
    expect(systems[0]).toContain('- 默认使用中文');
  });

  it('injects game experts into simple chat only when explicitly forced', async () => {
    resetStore(simpleBlueprint('Simple chat'));
    mockDirectRoute();
    useStore.setState({
      gameExpertSettings: {
        ...DEFAULT_GAME_EXPERT_SETTINGS,
        enabled: true,
        maxExperts: 4,
      },
    });
    const systems: string[] = [];
    gatewayMocks.completeGatewayText.mockImplementation(async (request) => {
      systems.push(String(request.system));
      return 'Use a parry state and damage window.';
    });

    useStore
      .getState()
      .sendPrompt('Unity 里做一个近战格挡和伤害判定系统', {
        forceGameExperts: true,
      });

    await waitFor(
      () =>
        !useStore.getState().aiStreaming &&
        useStore.getState().messages.some((m) => m.role === 'assistant'),
      'game expert simple chat answer',
    );

    expect(systems[0]).toContain('【游戏专家系统】');
    expect(systems[0]).toContain('Unity Specialist');
    expect(systems[0]).toContain('Gameplay Programmer');
  });

  it('never auto-injects game experts from chat text', async () => {
    resetStore(simpleBlueprint('Simple chat'));
    mockDirectRoute();
    useStore.setState({
      gameExpertSettings: {
        ...DEFAULT_GAME_EXPERT_SETTINGS,
        enabled: true,
        maxExperts: 4,
      },
    });
    const systems: string[] = [];
    gatewayMocks.completeGatewayText.mockImplementation(async (request) => {
      systems.push(String(request.system));
      return 'Use a parry state and damage window.';
    });

    // No forceGameExperts flag: even with experts enabled and obvious game
    // keywords, the prompt must stay clean (explicit-only routing).
    useStore.getState().sendPrompt('Unity 里做一个近战格挡和伤害判定系统');

    await waitFor(
      () =>
        !useStore.getState().aiStreaming &&
        useStore.getState().messages.some((m) => m.role === 'assistant'),
      'plain simple chat answer',
    );

    expect(systems[0]).not.toContain('【游戏专家系统】');
    expect(systems[0]).not.toContain('【游戏制作人总控】');
  });

  it('switches simple chat personal instructions with the active model', async () => {
    const workflow = simpleBlueprint('Simple chat');
    workflow.meta.gateway = {
      defaults: { adapter: 'claude-code', modelClass: 'sonnet' },
    };
    resetStore(workflow);
    const claudeSelection = { adapter: 'claude-code', modelClass: 'sonnet' };
    const geminiSelection = systemDefaultGatewaySelection('gemini');
    useStore.setState({
      personalInstructionsByModel: {
        [personalInstructionsKey(claudeSelection)]: 'Claude-only defaults',
        [personalInstructionsKey(geminiSelection)]: 'Gemini-only defaults',
      },
      personalInstructions: 'Claude-only defaults',
    });
    const systems: string[] = [];
    gatewayMocks.completeGatewayText.mockImplementation(async (request) => {
      systems.push(String(request.system));
      return `Answer ${systems.length}`;
    });
    gatewayMocks.resolveDirectGatewayRoute.mockReturnValue({
      selection: claudeSelection,
      adapter: 'claude-code',
      apiKey: 'test-key',
      model: 'sonnet',
      transport: 'anthropic',
    });

    useStore.getState().sendPrompt('第一轮');
    await waitFor(
      () => systems.length === 1 && !useStore.getState().aiStreaming,
      'first model answer',
    );

    useStore.getState().setSessionRunSelection(geminiSelection);
    gatewayMocks.resolveDirectGatewayRoute.mockReturnValue({
      selection: geminiSelection,
      adapter: 'gemini',
      apiKey: 'test-key',
      model: 'gemini-pro',
      transport: 'openai-compatible',
    });

    useStore.getState().sendPrompt('第二轮');
    await waitFor(
      () => systems.length === 2 && !useStore.getState().aiStreaming,
      'second model answer',
    );

    expect(systems[0]).toContain('Claude-only defaults');
    expect(systems[0]).not.toContain('Gemini-only defaults');
    expect(systems[1]).toContain('Gemini-only defaults');
    expect(systems[1]).not.toContain('Claude-only defaults');
    expect(useStore.getState().personalInstructions).toBe('Gemini-only defaults');
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

  it('keeps a localOnly translation note out of the next turn transcript', async () => {
    resetStore(simpleBlueprint('Simple chat'));
    mockDirectRoute();
    const userContents: string[] = [];
    gatewayMocks.completeGatewayText.mockImplementation(async (request) => {
      userContents.push(String(request.userContent));
      return userContents.length === 1
        ? 'Run <invoke name="Bash"></invoke> now.'
        : '已完成。';
    });

    useStore.getState().sendPrompt('帮我跑一下脚本');
    await waitFor(
      () => !useStore.getState().aiStreaming && userContents.length === 1,
      'the first answer',
    );

    // Simulate the "🌐 翻译为 简体中文" on-demand translation, whose translated
    // text mangles the tool-call markup. Marked localOnly so it must not leak
    // into the model transcript on the next turn.
    useStore
      .getState()
      .appendChatNote('🌐 翻译为 简体中文\n\n运行 <调用名称="Bash"></调用> 吧。', 'assistant', {
        localOnly: true,
      });

    useStore.getState().sendPrompt('继续');
    await waitFor(
      () => !useStore.getState().aiStreaming && userContents.length === 2,
      'the second answer',
    );

    // The real assistant answer is folded in; the translation note is not.
    expect(userContents[1]).toContain('之前的对话');
    expect(userContents[1]).toContain('Run <invoke name="Bash"></invoke> now.');
    expect(userContents[1]).not.toContain('翻译为 简体中文');
    expect(userContents[1]).not.toContain('调用名称');
  });

  it('reruns a favorited simple chat with a fresh direct context', async () => {
    resetStore(simpleBlueprint('Reusable chat'));
    useStore.setState({
      activeSessionId: 's_reusable_direct',
      sessions: [
        {
          id: 's_reusable_direct',
          title: 'Reusable chat',
          createdAt: 1,
          updatedAt: 4,
          isWorkflow: true,
          simple: true,
          favorite: true,
        },
      ],
      messages: [
        { id: 'm_user_1', role: 'user', text: 'repeat this task', createdAt: 1 },
        { id: 'm_ai_1', role: 'assistant', text: 'old answer', createdAt: 2 },
        { id: 'm_user_2', role: 'user', text: 'old follow-up', createdAt: 3 },
      ],
    });
    mockDirectRoute();
    const userContents: string[] = [];
    gatewayMocks.completeGatewayText.mockImplementation(async (request) => {
      userContents.push(String(request.userContent));
      return 'fresh answer';
    });

    useStore.getState().sendPrompt('repeat this task');

    await waitFor(
      () => !useStore.getState().aiStreaming && userContents.length === 1,
      'favorite direct rerun',
    );

    expect(userContents[0]).toBe('repeat this task');
    expect(userContents[0]).not.toContain('之前的对话');
    expect(userContents[0]).not.toContain('old answer');
    expect(useStore.getState().messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ]);
    expect(
      useStore
        .getState()
        .messages.filter((message) => message.role === 'user')
        .map((message) => message.text),
    ).toEqual(['repeat this task']);
    expect(useStore.getState().workflow.nodes[0].params.userInputs).toEqual([
      'repeat this task',
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

  it('starts a fresh native Claude CLI session when the resume target is missing', async () => {
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
    const calls: Array<{
      prompt: string;
      opts: { sessionId?: string; resume?: boolean };
    }> = [];
    tauriMocks.aiEditViaCli.mockImplementation(async (prompt, _adapter, opts) => {
      calls.push({ prompt, opts });
      if (calls.length === 1) return '第一轮回答。';
      if (calls.length === 2) {
        throw new Error(
          `CLI "claude" 退出码 1: No conversation found with session ID: ${opts.sessionId}`,
        );
      }
      return '恢复后的回答。';
    });

    useStore.getState().sendPrompt('第一轮问题');
    await waitFor(
      () => !useStore.getState().aiStreaming && calls.length === 1,
      'first successful CLI chat call',
    );

    useStore.getState().sendPrompt('第二轮问题');
    await waitFor(
      () => !useStore.getState().aiStreaming && calls.length === 3,
      'missing-session fallback CLI chat call',
    );

    expect(calls[1].opts.sessionId).toBe(calls[0].opts.sessionId);
    expect(calls[1].opts.resume).toBe(true);
    expect(calls[2].opts.sessionId).toEqual(expect.any(String));
    expect(calls[2].opts.sessionId).not.toBe(calls[0].opts.sessionId);
    expect(calls[2].opts.resume).toBe(false);
    expect(calls[2].prompt).toContain('之前的对话');
    expect(calls[2].prompt).toContain('第一轮问题');
    expect(calls[2].prompt).toContain('第一轮回答。');
    expect(calls[2].prompt).toContain('第二轮问题');
    expect(
      useStore
        .getState()
        .messages.some(
          (m) => m.role === 'assistant' && m.text.includes('恢复后的回答。'),
        ),
    ).toBe(true);
  });

  it('mints a fresh native session id when a failed CLI chat is retried', async () => {
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
    const calls: Array<{ opts: { sessionId?: string; resume?: boolean } }> = [];
    tauriMocks.aiEditViaCli.mockImplementation(async (_prompt, _adapter, opts) => {
      calls.push({ opts });
      // First attempt fails the way a relay outage does (connection refused),
      // after claude has already registered the session id on disk.
      if (calls.length === 1) {
        throw new Error('API Error: Unable to connect to API (ConnectionRefused)');
      }
      return '重试成功的回答。';
    });

    useStore.getState().sendPrompt('第一次会失败');
    await waitFor(
      () => !useStore.getState().aiStreaming && calls.length === 1,
      'first (failing) CLI chat call',
    );

    // Retry the same turn (the "继续"/resend affordance).
    useStore.getState().sendPrompt('再试一次');
    await waitFor(
      () => !useStore.getState().aiStreaming && calls.length === 2,
      'retry CLI chat call',
    );

    // The retry must NOT reuse the first attempt's session id (claude would
    // reject it with "Session ID … is already in use"), and must create rather
    // than resume — the failed attempt never established any warm context.
    expect(calls[0].opts.sessionId).toEqual(expect.any(String));
    expect(calls[0].opts.resume).toBe(false);
    expect(calls[1].opts.sessionId).toEqual(expect.any(String));
    expect(calls[1].opts.sessionId).not.toBe(calls[0].opts.sessionId);
    expect(calls[1].opts.resume).toBe(false);
  });

  it('does not resume a native Claude CLI session for favorited simple chat reruns', async () => {
    resetStore(simpleBlueprint('Reusable CLI chat'));
    useStore.setState({
      activeSessionId: 's_reusable_cli',
      sessions: [
        {
          id: 's_reusable_cli',
          title: 'Reusable CLI chat',
          createdAt: 1,
          updatedAt: 4,
          isWorkflow: true,
          simple: true,
          favorite: true,
        },
      ],
      messages: [
        { id: 'm_user_1', role: 'user', text: 'repeat this task', createdAt: 1 },
        { id: 'm_ai_1', role: 'assistant', text: 'old answer', createdAt: 2 },
      ],
    });
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
    const calls: Array<{
      prompt: string;
      opts: { sessionId?: string; resume?: boolean };
    }> = [];
    tauriMocks.aiEditViaCli.mockImplementation(async (prompt, _adapter, opts) => {
      calls.push({ prompt, opts });
      return 'fresh CLI answer';
    });

    useStore.getState().sendPrompt('repeat this task');

    await waitFor(
      () => !useStore.getState().aiStreaming && calls.length === 1,
      'favorite CLI rerun',
    );

    expect(calls[0].opts.sessionId).toBeUndefined();
    expect(calls[0].opts.resume).toBeUndefined();
    expect(calls[0].prompt).toContain('repeat this task');
    expect(calls[0].prompt).not.toContain('之前的对话');
    expect(calls[0].prompt).not.toContain('old answer');
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

  it('queues an interjection behind the in-flight turn and merges it into the running chat', async () => {
    resetStore(simpleBlueprint('Simple chat'));
    mockDirectRoute();
    const resolvers: Array<(value: string) => void> = [];
    const userContents: string[] = [];
    gatewayMocks.completeGatewayText.mockImplementation(
      async (request) =>
        new Promise<string>((resolve) => {
          userContents.push(String(request.userContent));
          resolvers.push(resolve);
        }),
    );

    useStore.getState().sendPrompt('问题一');
    await waitFor(() => resolvers.length === 1, 'first chat call');

    // Interjection: a follow-up sent mid-stream is accepted immediately (not
    // blocked by the read-only gate) but must NOT fire a second concurrent
    // model call — it queues behind the in-flight turn.
    useStore.getState().sendPrompt('问题二');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(gatewayMocks.completeGatewayText).toHaveBeenCalledTimes(1);
    // Both user messages are already in the transcript while the queue drains.
    expect(
      useStore
        .getState()
        .messages.filter((m) => m.role === 'user')
        .map((m) => m.text),
    ).toEqual(['问题一', '问题二']);

    // Finish the first turn; only then does the queued interjection run.
    resolvers[0]('答一');
    await waitFor(() => resolvers.length === 2, 'queued interjection runs after first');
    expect(gatewayMocks.completeGatewayText).toHaveBeenCalledTimes(2);

    resolvers[1]('答二');
    await waitFor(
      () =>
        !useStore.getState().aiStreaming &&
        useStore
          .getState()
          .messages.some((m) => m.role === 'assistant' && m.text.includes('答二')),
      'all chat turns to finish',
    );

    const assistantText = useStore
      .getState()
      .messages.filter((m) => m.role === 'assistant')
      .map((m) => m.text)
      .join('\n');
    expect(assistantText).toContain('答一');
    expect(assistantText).toContain('答二');
    // The interjection saw the FIRST turn's real answer folded into context —
    // not the "⟳ 生成中…" placeholder that was live when it was typed.
    expect(userContents[1]).toContain('之前的对话');
    expect(userContents[1]).toContain('问题一');
    expect(userContents[1]).toContain('答一');
    expect(userContents[1]).not.toContain('⟳');
    expect(useStore.getState().workflow.nodes[0].params.userInputs).toEqual([
      '问题一',
      '问题二',
    ]);
  });

  it('does not notify completion while another chat turn in the same session is still running', async () => {
    resetStore(simpleBlueprint('Simple chat'));
    mockDirectRoute();
    const resolvers: Array<(value: string) => void> = [];
    gatewayMocks.completeGatewayText.mockImplementation(
      async () => new Promise<string>((resolve) => resolvers.push(resolve)),
    );

    useStore.getState().sendPrompt('问题一');
    await waitFor(() => resolvers.length === 1, 'first chat call');
    // Interjection queues behind the first turn; it only fires once the first
    // turn finishes, so the queue is never empty in between.
    useStore.getState().sendPrompt('问题二');

    // Finishing the first turn must NOT notify completion — the queued
    // interjection is still pending for the same session.
    resolvers[0]('答一');
    await waitFor(() => resolvers.length === 2, 'queued interjection runs');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notificationMocks.notifySessionComplete).not.toHaveBeenCalled();

    resolvers[1]('答二');
    await waitFor(
      () => !useStore.getState().aiStreaming,
      'all chat turns to finish',
    );
    await waitFor(
      () => notificationMocks.notifySessionComplete.mock.calls.length === 1,
      'session completion notification',
    );
    expect(notificationMocks.notifySessionComplete).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'success' }),
    );
  });

  it('blocks sending to a different model while the current model is still answering', async () => {
    resetStore(simpleBlueprint('Simple chat'));
    mockDirectRoute();
    const resolvers: Array<(value: string) => void> = [];
    gatewayMocks.completeGatewayText.mockImplementation(
      async () => new Promise<string>((resolve) => resolvers.push(resolve)),
    );

    useStore.getState().sendPrompt('问题一');
    await waitFor(() => resolvers.length === 1, 'first chat call');

    useStore.getState().setSessionRunSelection({
      adapter: 'claude-code',
      modelClass: 'opus',
    });
    useStore.getState().sendPrompt('问题二');

    expect(gatewayMocks.completeGatewayText).toHaveBeenCalledTimes(1);
    expect(
      useStore.getState().messages.filter((message) => message.role === 'user'),
    ).toHaveLength(1);
    expect(useStore.getState().blockedSendTip).toBe('model-switched-while-chatting');

    resolvers[0]('答一');
    await waitFor(
      () => !useStore.getState().aiStreaming,
      'first chat to finish',
    );

    useStore.getState().sendPrompt('问题二');
    await waitFor(() => resolvers.length === 2, 'second chat after finish');
    expect(gatewayMocks.completeGatewayText).toHaveBeenCalledTimes(2);
    expect(useStore.getState().blockedSendTip).toBeNull();

    resolvers[1]('答二');
    await waitFor(
      () => !useStore.getState().aiStreaming,
      'second chat to finish',
    );
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
    expect(live?.routeLabel).toBe('Claude Code · sonnet');
    expect(live?.text).toContain('⚙ 路由：Claude Code · 模型：sonnet');
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
      return { port: 8766, token: 'test-token' };
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
        label: 'Kilo Gateway',
        source: 'global',
        cliCommand: 'claude',
        env: {
          ANTHROPIC_API_KEY: 'test-token',
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:8766/ch/kilo',
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
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8766/ch/kilo',
      ANTHROPIC_MODEL: 'poolside/laguna-xs.2:free',
    });
    await waitFor(
      () =>
        useStore
          .getState()
          .messages.some((m) => m.role === 'assistant' && m.text.includes('Kilo answer')),
      'free-channel final answer',
    );
    expect(
      useStore
        .getState()
        .messages.find((m) => m.role === 'assistant')
        ?.routeLabel,
    ).toBe('Kilo Gateway · poolside/laguna-xs.2:free');
    expect(
      useStore
        .getState()
        .messages.find((m) => m.role === 'assistant')
        ?.text,
    ).toContain('⚙ 路由：Kilo Gateway · 模型：poolside/laguna-xs.2:free');
  });

  it('uses CLI and injects global MCP guidance for any active model when the workspace has MCP', async () => {
    resetStore(simpleBlueprint('Simple chat'));
    tauriMocks.isTauri.mockReturnValue(true);
    tauriMocks.tauriAvailable.mockReturnValue(true);
    useStore.setState({
      activeWorkspaceId: 'ws-game',
      workspaces: [
        {
          id: 'ws-game',
          path: 'E:\\project\\Game',
          name: 'Game',
          updatedAt: Date.now(),
          sessionCount: 0,
          metadata: {
            projectSettings: {
              schemaVersion: 1,
              mcp: {
                enabled: true,
                servers: [
                  {
                    id: 'ue-mcp-for-all-versions',
                    label: 'Unreal MCP (全版本)',
                    source: 'suggested',
                    enabled: true,
                    transport: 'stdio',
                    command: 'C:\\tools\\ue-mcp.exe',
                    args: [],
                    env: {},
                    lastProbe: {
                      serverId: 'ue-mcp-for-all-versions',
                      ok: true,
                      status: 'connected',
                      message: 'MCP 已连接，发现 48 个工具。',
                      toolsCount: 48,
                      checkedAtMs: Date.now(),
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    });
    gatewayMocks.resolveDirectGatewayRoute.mockReturnValue({
      selection: { adapter: 'gemini', modelClass: 'gemini-2.5-pro' },
      adapter: 'gemini',
      modelClass: 'default',
      model: 'gemini-2.5-pro',
      providerName: 'Google',
      channelName: 'Gemini Pro',
      transport: 'openai-compatible',
      mode: 'direct',
      apiKey: 'test-key',
      label: 'Google Gemini',
      source: 'global',
    });
    gatewayMocks.resolveCliGatewayRoute.mockResolvedValue({
      selection: { adapter: 'gemini', modelClass: 'gemini-2.5-pro' },
      adapter: 'gemini',
      modelClass: 'default',
      model: 'gemini-2.5-pro',
      providerName: 'Google',
      channelName: 'Gemini Pro',
      transport: 'openai-compatible',
      mode: 'direct',
      label: 'Google Gemini',
      source: 'global',
      cliCommand: 'gemini',
      env: {
        GEMINI_API_KEY: 'test-key',
        GOOGLE_GEMINI_BASE_URL: 'https://generativelanguage.googleapis.com',
      },
    });
    tauriMocks.aiEditViaCli.mockResolvedValue('已读取 UE 状态。');

    useStore.getState().sendPrompt('当前 UE 编辑器里水体渲染状态帮我看一下');

    await waitFor(
      () => tauriMocks.aiEditViaCli.mock.calls.length === 1,
      'project MCP CLI chat call',
    );
    expect(gatewayMocks.completeGatewayText).not.toHaveBeenCalled();
    expect(tauriMocks.aiEditViaCli.mock.calls[0]?.[1]).toBe('gemini');
    const prompt = String(tauriMocks.aiEditViaCli.mock.calls[0]?.[0] ?? '');
    expect(prompt).toContain('【全局 MCP】');
    expect(prompt).toContain('所有模型请求都应优先使用这些实时工具');
    expect(prompt).toContain('ue-mcp-for-all-versions');
    expect(prompt).toContain('优先使用 Unreal MCP 工具读取编辑器实时状态');
  });

  it('shows the route and strips route/tool logs from the next transcript', async () => {
    resetStore(simpleBlueprint('Simple chat'));
    gatewayMocks.resolveDirectGatewayRoute.mockReturnValue({
      selection: { adapter: 'claude-code', modelClass: 'sonnet' },
      adapter: 'claude-code',
      modelClass: 'sonnet',
      model: 'z-ai/glm-4.6',
      providerName: 'OpenRouter',
      channelName: 'Default',
      transport: 'anthropic',
      mode: 'direct',
      apiKey: 'test-key',
      label: 'Claude Code · OpenRouter · Default · sonnet',
      source: 'global',
    });
    const routeLog = encodeToolPatch({
      id: 'route-1',
      name: 'free_proxy',
      status: 'done',
      subject: '已切到 OpenRouter · z-ai/glm-4.6',
    });
    gatewayMocks.completeGatewayText
      .mockResolvedValueOnce(`${routeLog}第一轮回答`)
      .mockResolvedValueOnce('第二轮回答');

    useStore.getState().sendPrompt('第一问');
    await waitFor(
      () =>
        !useStore.getState().aiStreaming &&
        useStore
          .getState()
          .messages.some((m) => m.role === 'assistant' && m.text.includes('第一轮回答')),
      'first routed answer',
    );
    const firstAssistant = useStore
      .getState()
      .messages.find((m) => m.role === 'assistant');
    expect(firstAssistant?.routeLabel).toBe('OpenRouter · Default · z-ai/glm-4.6');
    expect(firstAssistant?.text).toContain('⚙ 路由：OpenRouter · Default · 模型：z-ai/glm-4.6');

    useStore.getState().sendPrompt('第二问');
    await waitFor(
      () => gatewayMocks.completeGatewayText.mock.calls.length === 2,
      'second routed request',
    );
    const secondUserContent =
      gatewayMocks.completeGatewayText.mock.calls[1]?.[0]?.userContent ?? '';
    expect(secondUserContent).toContain('助手：第一轮回答');
    expect(secondUserContent).not.toContain('⚙ 路由');
    expect(secondUserContent).not.toContain('<<FUC_TOOL>>');
    expect(secondUserContent).not.toContain('free_proxy');
    expect(secondUserContent).not.toContain('⏱');
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

  it('keeps appended translation notes after switching away and back', async () => {
    window.localStorage.clear();
    await historyStore.ready();
    const workspace = await historyStore.resolveWorkspaceByPath('');
    resetStore(simpleBlueprint('Simple chat'));
    const workflowA = simpleBlueprint('Chat A');
    const sessionA = await historyStore.createSession({
      workspaceId: workspace.id,
      isWorkflow: true,
      workflow: workflowA,
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
      workflow: workflowA,
      locale: 'zh-CN',
    });
    mockDirectRoute();
    gatewayMocks.completeGatewayText.mockResolvedValue('Original answer.');

    useStore.getState().sendPrompt('Translate this later');
    await waitFor(
      () =>
        !useStore.getState().aiStreaming &&
        useStore
          .getState()
          .messages.some((m) => m.role === 'assistant' && m.text.includes('Original answer')),
      'simple chat answer',
    );

    useStore
      .getState()
      .appendChatNote('🌐 翻译为 简体中文\n\n原始回答。');
    await waitFor(async () => {
      const record = await historyStore.getSession(workspace.id, sessionA.id);
      return record?.messages.some((message) =>
        message.text.includes('翻译为 简体中文'),
      ) === true;
    }, 'translation note persistence');

    useStore.getState().selectSession(sessionB.id, workspace.id);
    await waitFor(
      () => useStore.getState().activeSessionId === sessionB.id,
      'session B activation',
    );
    useStore.getState().selectSession(sessionA.id, workspace.id);
    await waitFor(
      () => useStore.getState().activeSessionId === sessionA.id,
      'session A reactivation',
    );

    expect(
      useStore.getState().messages.some((message) =>
        message.text.includes('翻译为 简体中文'),
      ),
    ).toBe(true);
  });

  it('keeps a deleted simple chat turn deleted after switching sessions', async () => {
    window.localStorage.clear();
    await historyStore.ready();
    const workspace = await historyStore.resolveWorkspaceByPath('');
    resetStore(simpleBlueprint('Simple chat'));
    const workflowA = simpleBlueprint('Chat A');
    const sessionA = await historyStore.createSession({
      workspaceId: workspace.id,
      isWorkflow: true,
      workflow: workflowA,
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
      workflow: workflowA,
      locale: 'zh-CN',
    });
    mockDirectRoute();
    gatewayMocks.completeGatewayText.mockResolvedValue('临时回答。');

    useStore.getState().sendPrompt('临时问题');
    await waitFor(
      () =>
        !useStore.getState().aiStreaming &&
        useStore
          .getState()
          .messages.some((m) => m.role === 'assistant' && m.text.includes('临时回答')),
      'simple chat answer',
    );

    const assistantId = useStore
      .getState()
      .messages.find((message) => message.role === 'assistant')?.id;
    expect(assistantId).toBeTruthy();
    useStore.getState().deleteMessage(assistantId!);

    await waitFor(async () => {
      const record = await historyStore.getSession(workspace.id, sessionA.id);
      return record?.messages.length === 0;
    }, 'deleted turn persistence');

    useStore.getState().selectSession(sessionB.id, workspace.id);
    await waitFor(
      () => useStore.getState().activeSessionId === sessionB.id,
      'session B activation',
    );
    useStore.getState().selectSession(sessionA.id, workspace.id);
    await waitFor(
      () => useStore.getState().activeSessionId === sessionA.id,
      'session A reactivation',
    );

    const record = await historyStore.getSession(workspace.id, sessionA.id);
    expect(useStore.getState().messages).toEqual([]);
    expect(record?.messages).toEqual([]);
    expect(record?.workflow?.nodes[0]?.params.userInputs).toEqual([]);
  });
});
