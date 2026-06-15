import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultBlueprint } from '@/core/defaultBlueprint';
import { EXEC, type IRGraph } from '@/core/ir';
import {
  isWorkflowReadOnly,
  sessionChangesBaselineAtForSession,
  sessionChangesRootPathForSession,
  sessionLiveStatus,
  useStore,
  workflowDeleteProtectionReason,
  workflowReadOnlyReason,
  type WorkflowSessionKey,
} from './useStore';
import { workflowDefaultGatewaySelection } from '@/lib/modelGateway/resolver';
import { ACTIVE_GATEWAY_SELECTION_STORAGE } from '@/lib/gatewayConfig';
import {
  ACTIVE_PROVIDER_BY_KIND_STORAGE,
  PROVIDERS_STORAGE,
  getActiveProviderId,
  type Provider,
} from '@/lib/apiConfig';
import { historyStore } from './history/store';
import type { SessionRecord, WorkspaceSummary } from './history/types';
import type { Session } from './types';

const ACTIVE_SESSION_KEY: WorkflowSessionKey = {
  workspaceId: null,
  sessionId: 's_test',
};

function cloneGraph(graph: IRGraph): IRGraph {
  return JSON.parse(JSON.stringify(graph)) as IRGraph;
}

function resetStore(
  mode: 'design' | 'running',
  aiEditing: boolean,
): IRGraph {
  const workflow = defaultBlueprint('Locked workflow');
  useStore.setState({
    workflow: cloneGraph(workflow),
    selectedNodeId: 'n_step1',
    mode,
    aiStreaming: false,
    aiEditingSessions: aiEditing ? [ACTIVE_SESSION_KEY] : [],
    dirty: false,
    currentFilePath: null,
    runState: {},
    runOutputs: {},
    lastRunFailedNodeId: null,
    runningSessions: [],
    runningSessionProgress: {},
    composerDraft: '',
    composerDrafts: {},
    activeSessionId: ACTIVE_SESSION_KEY.sessionId,
    activeWorkspaceId: ACTIVE_SESSION_KEY.workspaceId,
    historyReady: false,
  });
  return workflow;
}

function readOnlyState(
  mode: 'design' | 'running',
  aiEditingSessions: WorkflowSessionKey[] = [],
) {
  return {
    mode,
    activeWorkspaceId: ACTIVE_SESSION_KEY.workspaceId,
    activeSessionId: ACTIVE_SESSION_KEY.sessionId,
    aiEditingSessions,
  };
}

async function waitForStore(
  predicate: () => boolean,
  label: string,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function testSession(
  workspaceId: string,
  id: string,
  title: string,
): Session {
  return {
    id,
    workspaceId,
    title,
    createdAt: 1,
    updatedAt: 1,
    isWorkflow: true,
    messageCount: 0,
  };
}

function testRecord(
  workspaceId: string,
  id: string,
  title: string,
): SessionRecord {
  return {
    id,
    workspaceId,
    title,
    isWorkflow: true,
    createdAt: 1,
    updatedAt: 2,
    messages: [
      {
        id: `m_${id}`,
        role: 'assistant',
        text: `${title} message`,
        createdAt: 2,
      },
    ],
    workflow: cloneGraph(defaultBlueprint(title)),
    meta: {
      canvasViewport: { x: 12, y: 24, zoom: 1.25 },
    },
  };
}

function testWorkspace(
  id: string,
  sessionCount: number,
): WorkspaceSummary {
  return {
    id,
    path: `E:\\${id}`,
    name: id,
    updatedAt: 2,
    sessionCount,
    lastActiveSessionId: undefined,
  };
}

function workflowSnapshot(): string {
  return JSON.stringify(useStore.getState().workflow);
}

function seedDefaultChannelProviders(): void {
  const providers: Provider[] = [
    {
      id: 'p_packy',
      kind: 'anthropic',
      name: 'PackyCode',
      apiKey: 'sk-packy',
      baseUrl: 'https://packy.example/v1',
      transport: 'cli',
      model: 'packy-code',
    },
    {
      id: 'p_sss',
      kind: 'anthropic',
      name: 'SSSAiCode',
      apiKey: 'sk-sss',
      baseUrl: 'https://sss.example/v1',
      transport: 'cli',
      model: 'claude-opus-4-8',
    },
  ];
  window.localStorage.setItem(PROVIDERS_STORAGE, JSON.stringify(providers));
  window.localStorage.setItem(
    ACTIVE_PROVIDER_BY_KIND_STORAGE,
    JSON.stringify({ anthropic: 'p_packy' }),
  );
}

function tryEveryPublicWorkflowWrite(): void {
  const store = useStore.getState();
  const replacement = defaultBlueprint('Replacement workflow');

  expect(store.addNode('log')).toBe('');
  store.updateNodeLabel('n_step1', 'Changed label');
  store.updateNodeParams('n_step1', { prompt: 'Changed prompt' });
  store.convertNodeToConsensus('n_step1', 'multi-lens');
  store.removeNode('n_step1');
  expect(
    store.addEdge(
      { node: 'n_start', port: 'exec_out' },
      { node: 'n_end', port: 'exec_in' },
      EXEC,
    ),
  ).toBe('');
  store.removeEdge('e_start_step1');
  store.setNodePosition('n_step1', 999, 999);
  store.setAdapter('gemini');
  store.applyGraphEdit(replacement);
  store.setWorkflow(replacement);
  store.runWorkflow();
}

afterEach(() => {
  vi.restoreAllMocks();
  resetStore('design', false);
  window.localStorage.clear();
});

describe('session changes root path', () => {
  it('uses the active session composer cwd before the workspace bucket path', () => {
    const state = useStore.getState();
    const workspace = testWorkspace('ws_open', 1);
    expect(
      sessionChangesRootPathForSession(
        {
          activeWorkspaceId: workspace.id,
          activeSessionId: 's1',
          composer: {
            ...state.composer,
            workspace: 'E:\\MoonEngine',
          },
          composerBySession: {},
          workspaces: [workspace],
        },
        { workspaceId: workspace.id, sessionId: 's1' },
      ),
    ).toBe('E:\\MoonEngine');
  });

  it('uses stored per-session composer cwd for a background session', () => {
    const state = useStore.getState();
    const workspace = testWorkspace('ws_open', 1);
    expect(
      sessionChangesRootPathForSession(
        {
          activeWorkspaceId: workspace.id,
          activeSessionId: 's_visible',
          composer: {
            ...state.composer,
            workspace: workspace.path,
          },
          composerBySession: {
            [`${workspace.id}::s_background`]: {
              composer: {
                ...state.composer,
                workspace: 'E:\\MoonEngine',
              },
              gatewaySelection: workflowDefaultGatewaySelection(
                defaultBlueprint('Background'),
                state.composer.model,
              ),
            },
          },
          workspaces: [workspace],
        },
        { workspaceId: workspace.id, sessionId: 's_background' },
      ),
    ).toBe('E:\\MoonEngine');
  });

  it('uses the session creation time as the change cutoff', () => {
    const workspace = testWorkspace('ws_open', 1);
    const session: Session = {
      id: 's1',
      workspaceId: workspace.id,
      title: 'Moon task',
      createdAt: 1234,
      isWorkflow: false,
      simple: true,
    };
    expect(
      sessionChangesBaselineAtForSession(
        {
          activeWorkspaceId: workspace.id,
          activeSessionId: session.id,
          composer: useStore.getState().composer,
          composerBySession: {},
          workspaces: [workspace],
          sessions: [session],
          sessionTree: { [workspace.id]: [session] },
        },
        { workspaceId: workspace.id, sessionId: session.id },
      ),
    ).toBe(1234);
  });
});

describe('workflow read-only guard', () => {
  it('reports running before AI editing when both flags are present', () => {
    expect(workflowReadOnlyReason(readOnlyState('design'))).toBeNull();
    expect(
      workflowReadOnlyReason(readOnlyState('design', [ACTIVE_SESSION_KEY])),
    ).toBe('aiEditing');
    expect(
      workflowReadOnlyReason(
        readOnlyState('design', [{ workspaceId: null, sessionId: 's_other' }]),
      ),
    ).toBeNull();
    expect(workflowReadOnlyReason(readOnlyState('running'))).toBe('running');
    expect(
      workflowReadOnlyReason(readOnlyState('running', [ACTIVE_SESSION_KEY])),
    ).toBe('running');
  });

  it('derives history live status with running priority', () => {
    expect(
      sessionLiveStatus(ACTIVE_SESSION_KEY, {
        runningSessions: [],
        aiEditingSessions: [],
      }),
    ).toBeNull();
    expect(
      sessionLiveStatus(ACTIVE_SESSION_KEY, {
        runningSessions: [],
        aiEditingSessions: [ACTIVE_SESSION_KEY],
      }),
    ).toBe('aiEditing');
    expect(
      sessionLiveStatus(ACTIVE_SESSION_KEY, {
        runningSessions: [],
        aiEditingSessions: [],
        chattingSessions: [ACTIVE_SESSION_KEY],
      }),
    ).toBe('running');
    expect(
      sessionLiveStatus(ACTIVE_SESSION_KEY, {
        runningSessions: [ACTIVE_SESSION_KEY],
        aiEditingSessions: [ACTIVE_SESSION_KEY],
        chattingSessions: [ACTIVE_SESSION_KEY],
      }),
    ).toBe('running');
  });

  it('reports waiting status when a live turn is parked on an interaction', () => {
    // A parked turn still appears in chatting/running, but waiting wins so the
    // sidebar shows a static "waiting" badge instead of the running spinner.
    expect(
      sessionLiveStatus(ACTIVE_SESSION_KEY, {
        runningSessions: [],
        aiEditingSessions: [],
        chattingSessions: [ACTIVE_SESSION_KEY],
        waitingInputSessions: [ACTIVE_SESSION_KEY],
      }),
    ).toBe('waiting');
    expect(
      sessionLiveStatus(ACTIVE_SESSION_KEY, {
        runningSessions: [ACTIVE_SESSION_KEY],
        aiEditingSessions: [ACTIVE_SESSION_KEY],
        chattingSessions: [ACTIVE_SESSION_KEY],
        waitingInputSessions: [ACTIVE_SESSION_KEY],
      }),
    ).toBe('waiting');
    // A different session parked does not affect this one.
    expect(
      sessionLiveStatus(ACTIVE_SESSION_KEY, {
        runningSessions: [],
        aiEditingSessions: [],
        chattingSessions: [ACTIVE_SESSION_KEY],
        waitingInputSessions: [{ workspaceId: null, sessionId: 's_other' }],
      }),
    ).toBe('running');
  });

  it('converts an agent to consensus in place', () => {
    resetStore('design', false);
    const before = cloneGraph(useStore.getState().workflow);

    useStore.getState().convertNodeToConsensus('n_step1', 'multi-lens');

    const after = useStore.getState().workflow;
    const converted = after.nodes.find((node) => node.id === 'n_step1');
    expect(converted?.type).toBe('consensus');
    expect(Array.isArray(converted?.params.voters)).toBe(true);
    expect((converted?.params.voters as unknown[]).length).toBeGreaterThan(0);
    expect(after.nodes.map((node) => node.id)).toEqual(
      before.nodes.map((node) => node.id),
    );
    expect(after.edges).toEqual(before.edges);
    expect(after.layout).toEqual(before.layout);
    expect(useStore.getState().selectedNodeId).toBe('n_step1');
    expect(useStore.getState().dirty).toBe(true);
  });

  it('protects only live workflow history sessions from deletion', () => {
    const workflowSession = { id: 's_test', isWorkflow: true };

    expect(
      workflowDeleteProtectionReason(workflowSession, null, {
        runningSessions: [ACTIVE_SESSION_KEY],
        aiEditingSessions: [],
      }),
    ).toBe('running');
    expect(
      workflowDeleteProtectionReason(workflowSession, null, {
        runningSessions: [],
        aiEditingSessions: [ACTIVE_SESSION_KEY],
      }),
    ).toBe('aiEditing');
    expect(
      workflowDeleteProtectionReason(
        { id: 's_test', isWorkflow: false },
        null,
        {
          runningSessions: [ACTIVE_SESSION_KEY],
          aiEditingSessions: [ACTIVE_SESSION_KEY],
        },
      ),
    ).toBeNull();
    expect(
      workflowDeleteProtectionReason(
        { id: 's_done', isWorkflow: true },
        null,
        {
          runningSessions: [],
          aiEditingSessions: [],
        },
      ),
    ).toBeNull();
  });

  it.each(['running', 'aiEditing'] as const)(
    'does not call history deletion for %s workflow sessions',
    async (reason) => {
      const workspaceId = 'ws_test';
      const protectedSession = {
        id: 's_protected',
        title: 'Protected workflow',
        createdAt: 1,
        isWorkflow: true,
      };
      const sessionKey = { workspaceId, sessionId: protectedSession.id };
      const deleteSpy = vi
        .spyOn(historyStore, 'deleteSession')
        .mockResolvedValue(undefined);

      try {
        resetStore('design', false);
        useStore.setState({
          activeWorkspaceId: workspaceId,
          activeSessionId: protectedSession.id,
          sessions: [protectedSession],
          sessionTree: { [workspaceId]: [protectedSession] },
          runningSessions: reason === 'running' ? [sessionKey] : [],
          aiEditingSessions: reason === 'aiEditing' ? [sessionKey] : [],
        });

        useStore.getState().deleteSession(protectedSession.id, workspaceId);
        await Promise.resolve();

        expect(deleteSpy).not.toHaveBeenCalled();
      } finally {
        deleteSpy.mockRestore();
      }
    },
  );

  it.each([
    ['completed', 'success' as const],
    ['failed', 'error' as const],
    ['interrupted', 'interrupted' as const],
    ['draft', undefined],
  ])(
    'keeps deleting unprotected %s workflow history sessions',
    async (_label, runStatus) => {
      const workspaceId = 'ws_test';
      const deletableSession = {
        id: `s_${_label}`,
        title: 'Finished workflow',
        createdAt: 1,
        isWorkflow: true,
        ...(runStatus ? { runStatus } : {}),
      };
      const deleteSpy = vi
        .spyOn(historyStore, 'deleteSession')
        .mockResolvedValue(undefined);
      const listSpy = vi
        .spyOn(historyStore, 'listWorkspaces')
        .mockResolvedValue([]);

      try {
        resetStore('design', false);
        useStore.setState({
          activeWorkspaceId: workspaceId,
          activeSessionId: 's_other',
          sessions: [deletableSession],
          sessionTree: { [workspaceId]: [deletableSession] },
          runningSessions: [],
          aiEditingSessions: [],
        });

        useStore.getState().deleteSession(deletableSession.id, workspaceId);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(deleteSpy).toHaveBeenCalledWith(
          workspaceId,
          deletableSession.id,
        );
        expect(useStore.getState().sessionTree[workspaceId]).toEqual([]);
      } finally {
        deleteSpy.mockRestore();
        listSpy.mockRestore();
      }
    },
  );

  it('keeps deleting non-workflow history sessions even when they are live', async () => {
    const workspaceId = 'ws_test';
    const deletableSession = {
      id: 's_live_chat',
      title: 'Live chat',
      createdAt: 1,
      isWorkflow: false,
    };
    const sessionKey = { workspaceId, sessionId: deletableSession.id };
    const deleteSpy = vi
      .spyOn(historyStore, 'deleteSession')
      .mockResolvedValue(undefined);
    const listSpy = vi
      .spyOn(historyStore, 'listWorkspaces')
      .mockResolvedValue([]);

    try {
      resetStore('design', false);
      useStore.setState({
        activeWorkspaceId: workspaceId,
        activeSessionId: 's_other',
        sessions: [deletableSession],
        sessionTree: { [workspaceId]: [deletableSession] },
        runningSessions: [sessionKey],
        aiEditingSessions: [sessionKey],
      });

      useStore.getState().deleteSession(deletableSession.id, workspaceId);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(deleteSpy).toHaveBeenCalledWith(workspaceId, deletableSession.id);
      expect(useStore.getState().sessionTree[workspaceId]).toEqual([]);
    } finally {
      deleteSpy.mockRestore();
      listSpy.mockRestore();
    }
  });

  it('removes the deleted active session before activating the next history session', async () => {
    const workspaceId = 'ws_delete_active';
    const sessionA = testSession(workspaceId, 's_a', 'Workflow A');
    const sessionB = testSession(workspaceId, 's_b', 'Workflow B');
    const sessionC = testSession(workspaceId, 's_c', 'Workflow C');
    vi.spyOn(historyStore, 'deleteSession').mockResolvedValue(undefined);
    vi.spyOn(historyStore, 'listWorkspaces').mockResolvedValue([
      testWorkspace(workspaceId, 2),
    ]);
    vi.spyOn(historyStore, 'getSession').mockResolvedValue(
      testRecord(workspaceId, sessionB.id, sessionB.title),
    );
    vi.spyOn(historyStore, 'patchConfig').mockResolvedValue({
      schemaVersion: 1,
    });

    resetStore('design', false);
    useStore.setState({
      historyReady: true,
      workspaces: [testWorkspace(workspaceId, 3)],
      activeWorkspaceId: workspaceId,
      activeSessionId: sessionA.id,
      sessions: [sessionA, sessionB, sessionC],
      sessionTree: { [workspaceId]: [sessionA, sessionB, sessionC] },
      messages: [{ id: 'm_a', role: 'assistant', text: 'A', createdAt: 1 }],
      canvasViewport: { x: 1, y: 2, zoom: 1 },
      selectedNodeId: 'n_step1',
    });

    useStore.getState().deleteSession(sessionA.id, workspaceId);

    await waitForStore(
      () => useStore.getState().activeSessionId === sessionB.id,
      'next session activation after deleting active session',
    );

    const state = useStore.getState();
    expect(historyStore.deleteSession).toHaveBeenCalledWith(
      workspaceId,
      sessionA.id,
    );
    expect(state.activeSessionId).toBe(sessionB.id);
    expect(state.sessions.map((session) => session.id)).toEqual([
      sessionB.id,
      sessionC.id,
    ]);
    expect(
      state.sessionTree[workspaceId]?.map((session) => session.id),
    ).toEqual([sessionB.id, sessionC.id]);
    expect(state.selectedNodeId).toBeNull();
    expect(state.messages[0]?.text).toBe('Workflow B message');
    expect(state.workflow.meta.name).toBe('Workflow B');
    expect(state.canvasViewport).toEqual({ x: 12, y: 24, zoom: 1.25 });
  });

  it('updates flat sessions only when the deleted session belongs to the active workspace', async () => {
    const activeWorkspaceId = 'ws_active';
    const otherWorkspaceId = 'ws_other';
    const activeSession = testSession(
      activeWorkspaceId,
      's_active',
      'Active workflow',
    );
    const otherSession = testSession(
      otherWorkspaceId,
      's_other',
      'Other workflow',
    );
    vi.spyOn(historyStore, 'deleteSession').mockResolvedValue(undefined);
    vi.spyOn(historyStore, 'listWorkspaces').mockResolvedValue([
      testWorkspace(activeWorkspaceId, 1),
      testWorkspace(otherWorkspaceId, 0),
    ]);

    resetStore('design', false);
    useStore.setState({
      historyReady: true,
      workspaces: [
        testWorkspace(activeWorkspaceId, 1),
        testWorkspace(otherWorkspaceId, 1),
      ],
      activeWorkspaceId,
      activeSessionId: activeSession.id,
      sessions: [activeSession],
      sessionTree: {
        [activeWorkspaceId]: [activeSession],
        [otherWorkspaceId]: [otherSession],
      },
    });

    useStore.getState().deleteSession(otherSession.id, otherWorkspaceId);

    await waitForStore(
      () => useStore.getState().sessionTree[otherWorkspaceId]?.length === 0,
      'non-active workspace deletion',
    );

    const state = useStore.getState();
    expect(state.sessions.map((session) => session.id)).toEqual([
      activeSession.id,
    ]);
    expect(
      state.sessionTree[activeWorkspaceId]?.map((session) => session.id),
    ).toEqual([activeSession.id]);
    expect(state.sessionTree[otherWorkspaceId]).toEqual([]);
    expect(state.activeSessionId).toBe(activeSession.id);
  });

  it('clears editor and run state when deleting the only active history session', async () => {
    const workspaceId = 'ws_delete_only';
    const session = testSession(workspaceId, 's_only', 'Only workflow');
    vi.spyOn(historyStore, 'deleteSession').mockResolvedValue(undefined);
    vi.spyOn(historyStore, 'listWorkspaces').mockResolvedValue([
      testWorkspace(workspaceId, 0),
    ]);
    vi.spyOn(historyStore, 'patchConfig').mockResolvedValue({
      schemaVersion: 1,
    });

    resetStore('running', false);
    useStore.setState({
      historyReady: true,
      workspaces: [testWorkspace(workspaceId, 1)],
      activeWorkspaceId: workspaceId,
      activeSessionId: session.id,
      sessions: [session],
      sessionTree: { [workspaceId]: [session] },
      messages: [{ id: 'm_only', role: 'assistant', text: 'Only', createdAt: 1 }],
      selectedNodeId: 'n_step1',
      dirty: true,
      runState: { n_step1: 'running' },
      runOutputs: { n_step1: 'output' },
      lastRunFailedNodeId: 'n_step1',
      canvasViewport: { x: 1, y: 2, zoom: 1 },
    });

    useStore.getState().deleteSession(session.id, workspaceId);

    await waitForStore(
      () => useStore.getState().activeSessionId === null,
      'active session clearing after deleting the only session',
    );

    const state = useStore.getState();
    expect(state.sessions).toEqual([]);
    expect(state.sessionTree[workspaceId]).toEqual([]);
    expect(state.messages).toEqual([]);
    expect(state.selectedNodeId).toBeNull();
    expect(state.dirty).toBe(false);
    expect(state.runState).toEqual({});
    expect(state.runOutputs).toEqual({});
    expect(state.lastRunFailedNodeId).toBeNull();
    expect(state.canvasViewport).toBeNull();
    expect(state.mode).toBe('design');
  });

  it('does not steal focus back to the next session when deletion finishes after a user switch', async () => {
    const workspaceId = 'ws_delete_race';
    const sessionA = testSession(workspaceId, 's_a', 'Workflow A');
    const sessionB = testSession(workspaceId, 's_b', 'Workflow B');
    const sessionC = testSession(workspaceId, 's_c', 'Workflow C');
    let resolveDelete!: () => void;
    vi.spyOn(historyStore, 'deleteSession').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve;
        }),
    );
    vi.spyOn(historyStore, 'listWorkspaces').mockResolvedValue([
      testWorkspace(workspaceId, 2),
    ]);
    vi.spyOn(historyStore, 'getSession').mockImplementation(
      async (_workspaceId, sessionId) => {
        if (sessionId === sessionB.id) {
          return testRecord(workspaceId, sessionB.id, sessionB.title);
        }
        return null;
      },
    );
    vi.spyOn(historyStore, 'patchConfig').mockResolvedValue({
      schemaVersion: 1,
    });

    resetStore('design', false);
    useStore.setState({
      historyReady: true,
      workspaces: [testWorkspace(workspaceId, 3)],
      activeWorkspaceId: workspaceId,
      activeSessionId: sessionA.id,
      sessions: [sessionA, sessionB, sessionC],
      sessionTree: { [workspaceId]: [sessionA, sessionB, sessionC] },
      selectedNodeId: 'n_step1',
    });

    useStore.getState().deleteSession(sessionA.id, workspaceId);
    useStore.setState({
      activeSessionId: sessionC.id,
      selectedNodeId: null,
    });

    resolveDelete();

    await waitForStore(
      () =>
        !useStore
          .getState()
          .sessionTree[workspaceId]?.some((item) => item.id === sessionA.id),
      'pending deletion cleanup',
    );

    const state = useStore.getState();
    expect(state.activeSessionId).toBe(sessionC.id);
    expect(state.sessions.map((session) => session.id)).toEqual([
      sessionB.id,
      sessionC.id,
    ]);
    expect(
      state.sessionTree[workspaceId]?.map((session) => session.id),
    ).toEqual([sessionB.id, sessionC.id]);
    expect(historyStore.getSession).not.toHaveBeenCalledWith(
      workspaceId,
      sessionB.id,
    );
  });

  it('keeps composer drafts scoped to each workflow session', () => {
    resetStore('design', false);
    useStore.setState({
      activeWorkspaceId: null,
      activeSessionId: 's_a',
      composerDraft: '',
      composerDrafts: {},
    });

    useStore.getState().setComposerDraft('draft for A');
    useStore.getState().selectSession('s_b');

    expect(useStore.getState().composerDraft).toBe('');

    useStore.getState().setComposerDraft('draft for B');
    useStore.getState().selectSession('s_a');

    expect(useStore.getState().composerDraft).toBe('draft for A');

    useStore.getState().selectSession('s_b');

    expect(useStore.getState().composerDraft).toBe('draft for B');
  });

  it('keeps composer controls scoped to each session', () => {
    resetStore('design', false);
    useStore.setState({
      activeWorkspaceId: null,
      activeSessionId: 's_a',
      composerDraft: '',
      composerDrafts: {},
      composerBySession: {},
      composer: {
        permission: 'full',
        model: 'claude-sonnet-4',
        cacheTtlMinutes: 5,
        startupMode: 'local',
        workspace: '',
        workspaceFolders: [],
        modelStrategy: 'inherit',
        imageMode: false,
        musicMode: false,
        threeDMode: false,
        videoMode: false,
        speechMode: false,
        spriteMode: false,
        comfyMode: false,
        uiMode: false,
      },
    });

    useStore.getState().setComposer({
      permission: 'plan',
      workspace: 'E:\\ProjectA',
      modelStrategy: 'prefer-better',
    });
    useStore
      .getState()
      .setGlobalRunSelection({ adapter: 'codex', modelClass: 'opus' });
    useStore.getState().selectSession('s_b');

    expect(useStore.getState().composer.permission).toBe('full');
    expect(useStore.getState().composer.workspace).toBe('');
    expect(useStore.getState().composer.modelStrategy).toBe('inherit');

    useStore.getState().setComposer({
      permission: 'read-only',
      workspace: 'E:\\ProjectB',
      modelStrategy: 'prefer-cheaper',
    });
    useStore
      .getState()
      .setGlobalRunSelection({ adapter: 'gemini', modelClass: 'haiku' });

    useStore.getState().selectSession('s_a');

    expect(useStore.getState().composer).toMatchObject({
      permission: 'plan',
      workspace: 'E:\\ProjectA',
      modelStrategy: 'prefer-better',
    });
    expect(workflowDefaultGatewaySelection(useStore.getState().workflow)).toEqual({
      adapter: 'codex',
      modelClass: 'opus',
    });

    useStore.getState().selectSession('s_b');

    expect(useStore.getState().composer).toMatchObject({
      permission: 'read-only',
      workspace: 'E:\\ProjectB',
      modelStrategy: 'prefer-cheaper',
    });
    expect(workflowDefaultGatewaySelection(useStore.getState().workflow)).toEqual({
      adapter: 'gemini',
      modelClass: 'haiku',
    });
  });

  it('keeps input-box run selection scoped to the active session', () => {
    resetStore('design', false);
    window.localStorage.setItem(
      ACTIVE_GATEWAY_SELECTION_STORAGE,
      JSON.stringify({ adapter: 'claude-code', modelClass: 'sonnet' }),
    );

    useStore.getState().setSessionRunSelection({
      adapter: 'codex',
      modelClass: 'gpt-5.5',
      modelOverride: 'gpt-5.5',
    });

    expect(workflowDefaultGatewaySelection(useStore.getState().workflow)).toEqual({
      adapter: 'codex',
      modelClass: 'gpt-5.5',
      modelOverride: 'gpt-5.5',
    });
    expect(
      JSON.parse(window.localStorage.getItem(ACTIVE_GATEWAY_SELECTION_STORAGE)!),
    ).toEqual({ adapter: 'claude-code', modelClass: 'sonnet' });
  });

  it('persists Settings default channel changes while the current workflow is read-only', () => {
    seedDefaultChannelProviders();
    resetStore('running', false);
    const before = workflowSnapshot();

    useStore.getState().setGlobalRunSelection({
      adapter: 'claude-code',
      modelClass: 'claude-opus-4-8',
      providerId: 'p_sss',
      channelId: 'default',
    });

    expect(getActiveProviderId('anthropic')).toBe('p_sss');
    expect(
      JSON.parse(window.localStorage.getItem(ACTIVE_GATEWAY_SELECTION_STORAGE)!),
    ).toEqual({
      adapter: 'claude-code',
      modelClass: 'claude-opus-4-8',
      providerId: 'p_sss',
      channelId: 'default',
    });
    expect(workflowSnapshot()).toBe(before);
    expect(workflowDefaultGatewaySelection(useStore.getState().workflow)).toEqual({
      adapter: 'claude-code',
      modelClass: 'sonnet',
    });
  });

  it.each([
    ['running workflow', 'running', false],
    ['AI blueprint edit', 'design', true],
  ] as const)(
    'blocks public workflow writes during %s',
    (_label, mode, aiEditing) => {
      resetStore(mode, aiEditing);
      const before = workflowSnapshot();

      expect(isWorkflowReadOnly(useStore.getState())).toBe(true);
      tryEveryPublicWorkflowWrite();

      expect(workflowSnapshot()).toBe(before);
      expect(useStore.getState().dirty).toBe(false);
    },
  );

  // [dynamic-only refactor] newWorkflow 蓝图创建已停用（改为 no-op）；下面两个用例
  // 断言的是已移除的可视化蓝图创建行为，故 skip（源码保留，便于日后恢复）。
  it.skip('allows creating a new workflow while the current workflow is running', () => {
    resetStore('running', false);

    useStore.getState().newWorkflow();

    const state = useStore.getState();
    const expectedName =
      state.locale === 'en-US' ? 'Untitled Workflow' : '未命名工作流';
    expect(state.mode).toBe('design');
    expect(state.workflow.meta.name).toBe(expectedName);
    expect(state.activeSessionId).not.toBe(ACTIVE_SESSION_KEY.sessionId);
    expect(state.sessions[0]?.id).toBe(state.activeSessionId);
    expect(state.sessions[0]?.title).toBe(expectedName);
    expect(state.selectedNodeId).toBeNull();
    expect(state.runState).toEqual({});
    expect(state.runOutputs).toEqual({});
    expect(state.lastRunFailedNodeId).toBeNull();
    expect(state.dirty).toBe(false);
  });

  it.skip('allows creating a new workflow during an active AI blueprint edit', () => {
    resetStore('design', true);

    useStore.getState().newWorkflow();

    const state = useStore.getState();
    const expectedName =
      state.locale === 'en-US' ? 'Untitled Workflow' : '未命名工作流';
    expect(state.workflow.meta.name).toBe(expectedName);
    expect(state.activeSessionId).not.toBe(ACTIVE_SESSION_KEY.sessionId);
    expect(isWorkflowReadOnly(state)).toBe(false);
    expect(state.sessions[0]?.id).toBe(state.activeSessionId);
    expect(state.sessions[0]?.title).toBe(expectedName);
    expect(state.dirty).toBe(false);
    expect(
      sessionLiveStatus(ACTIVE_SESSION_KEY, {
        runningSessions: [],
        aiEditingSessions: state.aiEditingSessions,
      }),
    ).toBe('aiEditing');
  });

  it('allows creating a new chat session while another session is streaming', () => {
    resetStore('design', false);
    useStore.setState({
      aiStreaming: true,
      chattingSessions: [ACTIVE_SESSION_KEY],
    });

    useStore.getState().newSession();

    const state = useStore.getState();
    const expectedName =
      state.locale === 'en-US' ? 'Untitled Session' : '未命名会话';
    expect(state.workflow.meta.simple).toBe(true);
    expect(state.workflow.meta.name).toBe(expectedName);
    expect(state.activeSessionId).not.toBe(ACTIVE_SESSION_KEY.sessionId);
    expect(state.sessions[0]?.id).toBe(state.activeSessionId);
    expect(state.sessions[0]?.title).toBe(expectedName);
    expect(state.messages).toEqual([]);
    expect(state.selectedNodeId).toBeNull();
    expect(state.runState).toEqual({});
    expect(state.runOutputs).toEqual({});
    expect(state.lastRunFailedNodeId).toBeNull();
    expect(state.dirty).toBe(false);
  });
});
