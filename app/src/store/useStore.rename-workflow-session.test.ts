import { afterEach, describe, expect, it } from 'vitest';
import { defaultBlueprint } from '@/core/defaultBlueprint';
import type { IRGraph } from '@/core/ir';
import { historyStore } from './history/store';
import type { Session } from './types';
import { useStore } from './useStore';

function cloneGraph(graph: IRGraph): IRGraph {
  return JSON.parse(JSON.stringify(graph)) as IRGraph;
}

function resetStore(): void {
  useStore.setState({
    workflow: cloneGraph(defaultBlueprint('Current workflow')),
    selectedNodeId: null,
    mode: 'design',
    aiStreaming: false,
    aiEditingSessions: [],
    dirty: false,
    currentFilePath: null,
    messages: [],
    composerDraft: '',
    composerDrafts: {},
    activeSessionId: null,
    activeWorkspaceId: null,
    historyReady: false,
    workspaces: [],
    sessions: [],
    sessionTree: {},
    runState: {},
    runOutputs: {},
    lastRunFailedNodeId: null,
  });
}

afterEach(() => {
  resetStore();
  window.localStorage.clear();
});

describe('renameWorkflowSession', () => {
  it('persists the workflow title and workflow meta name for history reloads', async () => {
    window.localStorage.clear();
    await historyStore.ready();
    const workspace = await historyStore.resolveWorkspaceByPath('');
    const workflow = defaultBlueprint('Original workflow');
    const record = await historyStore.createSession({
      workspaceId: workspace.id,
      isWorkflow: true,
      title: workflow.meta.name,
      workflow,
    });
    const session: Session = {
      id: record.id,
      workspaceId: workspace.id,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      isWorkflow: true,
      messageCount: 0,
    };

    useStore.setState({
      historyReady: true,
      workspaces: [workspace],
      sessions: [session],
      sessionTree: { [workspace.id]: [session] },
      activeWorkspaceId: workspace.id,
      activeSessionId: record.id,
      workflow: cloneGraph(workflow),
      currentFilePath: null,
    });

    await useStore
      .getState()
      .renameWorkflowSession(record.id, workspace.id, 'Renamed workflow');

    const updatedRecord = await historyStore.getSession(workspace.id, record.id);
    const updatedIndex = await historyStore.listSessions(workspace.id);
    const state = useStore.getState();

    expect(updatedRecord?.title).toBe('Renamed workflow');
    expect(updatedRecord?.workflow?.meta.name).toBe('Renamed workflow');
    expect(updatedIndex.find((item) => item.id === record.id)?.title).toBe(
      'Renamed workflow',
    );
    expect(state.workflow.meta.name).toBe('Renamed workflow');
    expect(state.sessions.find((item) => item.id === record.id)?.title).toBe(
      'Renamed workflow',
    );
    expect(
      state.sessionTree[workspace.id]?.find((item) => item.id === record.id)
        ?.title,
    ).toBe('Renamed workflow');
  });

  it('renames chat sessions without converting them to workflow sessions', async () => {
    window.localStorage.clear();
    await historyStore.ready();
    const workspace = await historyStore.resolveWorkspaceByPath('');
    const record = await historyStore.createSession({
      workspaceId: workspace.id,
      isWorkflow: false,
      title: 'Original chat',
      messages: [],
    });
    const session: Session = {
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
      workspaces: [workspace],
      sessions: [session],
      sessionTree: { [workspace.id]: [session] },
      activeWorkspaceId: workspace.id,
      activeSessionId: record.id,
      workflow: cloneGraph(defaultBlueprint('Current workflow')),
      currentFilePath: null,
    });

    await useStore
      .getState()
      .renameWorkflowSession(record.id, workspace.id, 'Renamed chat');

    const updatedRecord = await historyStore.getSession(workspace.id, record.id);
    const updatedIndex = await historyStore.listSessions(workspace.id);
    const state = useStore.getState();

    expect(updatedRecord?.title).toBe('Renamed chat');
    expect(updatedRecord?.isWorkflow).toBe(false);
    expect(updatedRecord?.workflow).toBeUndefined();
    expect(updatedIndex.find((item) => item.id === record.id)?.title).toBe(
      'Renamed chat',
    );
    expect(updatedIndex.find((item) => item.id === record.id)?.isWorkflow).toBe(
      false,
    );
    expect(state.sessions.find((item) => item.id === record.id)?.title).toBe(
      'Renamed chat',
    );
    expect(
      state.sessionTree[workspace.id]?.find((item) => item.id === record.id)
        ?.isWorkflow,
    ).toBe(false);
  });

  it('persists workflow favorite state in history summaries', async () => {
    window.localStorage.clear();
    await historyStore.ready();
    const workspace = await historyStore.resolveWorkspaceByPath('');
    const workflow = defaultBlueprint('Favorite workflow');
    const record = await historyStore.createSession({
      workspaceId: workspace.id,
      isWorkflow: true,
      title: workflow.meta.name,
      workflow,
    });
    const session: Session = {
      id: record.id,
      workspaceId: workspace.id,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      isWorkflow: true,
      messageCount: 0,
    };

    useStore.setState({
      historyReady: true,
      workspaces: [workspace],
      sessions: [session],
      sessionTree: { [workspace.id]: [session] },
      activeWorkspaceId: workspace.id,
      activeSessionId: record.id,
      workflow: cloneGraph(workflow),
      currentFilePath: null,
    });

    await useStore
      .getState()
      .setWorkflowFavoriteSession(record.id, workspace.id, true);

    const updatedRecord = await historyStore.getSession(workspace.id, record.id);
    const updatedIndex = await historyStore.listSessions(workspace.id);
    const state = useStore.getState();

    expect(updatedRecord?.meta?.favorite).toBe(true);
    expect(updatedIndex.find((item) => item.id === record.id)?.favorite).toBe(
      true,
    );
    expect(state.sessions.find((item) => item.id === record.id)?.favorite).toBe(
      true,
    );
    expect(
      state.sessionTree[workspace.id]?.find((item) => item.id === record.id)
        ?.favorite,
    ).toBe(true);
  });

  it('persists chat favorite state in history summaries', async () => {
    window.localStorage.clear();
    await historyStore.ready();
    const workspace = await historyStore.resolveWorkspaceByPath('');
    const record = await historyStore.createSession({
      workspaceId: workspace.id,
      isWorkflow: false,
      title: 'Favorite chat',
      messages: [],
    });
    const session: Session = {
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
      workspaces: [workspace],
      sessions: [session],
      sessionTree: { [workspace.id]: [session] },
      activeWorkspaceId: workspace.id,
      activeSessionId: record.id,
      workflow: cloneGraph(defaultBlueprint('Current workflow')),
      currentFilePath: null,
    });

    await useStore
      .getState()
      .setWorkflowFavoriteSession(record.id, workspace.id, true);

    const updatedRecord = await historyStore.getSession(workspace.id, record.id);
    const updatedIndex = await historyStore.listSessions(workspace.id);
    const state = useStore.getState();

    expect(updatedRecord?.isWorkflow).toBe(false);
    expect(updatedRecord?.meta?.favorite).toBe(true);
    expect(updatedIndex.find((item) => item.id === record.id)?.favorite).toBe(
      true,
    );
    expect(state.sessions.find((item) => item.id === record.id)?.favorite).toBe(
      true,
    );
    expect(
      state.sessionTree[workspace.id]?.find((item) => item.id === record.id)
        ?.favorite,
    ).toBe(true);
  });
});

describe('setSessionPinned', () => {
  it.each([false, true])('persists pin without changing activity time or live summaries (workflow=%s)', async (isWorkflow) => {
    window.localStorage.clear();
    await historyStore.ready();
    const workspace = await historyStore.resolveWorkspaceByPath('');
    const record = await historyStore.createSession({
      workspaceId: workspace.id, isWorkflow, title: '置顶持久化',
      ...(isWorkflow ? { workflow: defaultBlueprint('置顶持久化') } : {}),
    });
    const session: Session = {
      id: record.id, workspaceId: workspace.id, title: record.title,
      createdAt: record.createdAt, updatedAt: record.updatedAt,
      isWorkflow, messageCount: 7, preview: '正在生成的新内容',
    };
    useStore.setState({ historyReady: true, sessions: [session], sessionTree: { [workspace.id]: [session] } });
    await useStore.getState().setSessionPinned(record.id, workspace.id, true);
    expect((await historyStore.getSession(workspace.id, record.id))?.meta?.pinned).toBe(true);
    expect((await historyStore.listSessions(workspace.id))[0]?.pinned).toBe(true);
    expect(useStore.getState().sessions[0]).toEqual({ ...session, pinned: true });
    expect(useStore.getState().sessionTree[workspace.id][0].pinned).toBe(true);
    await useStore.getState().setSessionPinned(record.id, workspace.id, false);
    const restored = await historyStore.getSession(workspace.id, record.id);
    expect(restored?.meta?.pinned).toBe(false);
    expect(restored?.updatedAt).toBe(record.updatedAt);
    expect((await historyStore.listSessions(workspace.id))[0]?.pinned).toBeUndefined();
    expect(useStore.getState().sessions[0].pinned).toBe(false);
  });
});
