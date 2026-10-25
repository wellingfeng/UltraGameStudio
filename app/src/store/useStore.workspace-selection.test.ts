import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultBlueprint } from '@/core/defaultBlueprint';
import {
  useStore,
  workflowSessionKeyId,
} from './useStore';
import { historyStore } from './history/store';
import type { Session } from './types';
import { upsertProviders } from '@/lib/apiConfig';
import {
  remoteProviderId,
  remoteWorkspacePath,
  saveRemoteWorkspace,
} from '@/lib/remoteWorkspace';
import { defaultComposer } from './sampleSessions';
import { workflowDefaultGatewaySelection } from '@/lib/modelGateway/resolver';
import { CLOUD_PROJECTS_ENABLED } from '@/lib/cloudProjects';

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

function summaryFor(workspaceId: string, id: string, title: string): Session {
  const now = Date.now();
  return {
    id,
    workspaceId,
    title,
    createdAt: now,
    updatedAt: now,
    isWorkflow: false,
    messageCount: 0,
  };
}

describe('top workspace switcher selection (selectedWorkspaceId)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('does not follow a session click into another workspace', async () => {
    await historyStore.ready();
    const wsA = await historyStore.resolveWorkspaceByPath('E:\\test_project_ue53');
    const wsB = await historyStore.resolveWorkspaceByPath('E:\\UltraGameStudio');

    const sessionB = await historyStore.createSession({
      workspaceId: wsB.id,
      isWorkflow: false,
      messages: [],
      title: 'UltraGameStudio chat',
    });

    useStore.setState({
      historyReady: true,
      activeWorkspaceId: wsA.id,
      selectedWorkspaceId: wsA.id,
      activeSessionId: null,
      workspaces: [wsA, wsB],
      sessions: [],
      sessionTree: {
        [wsA.id]: [],
        [wsB.id]: [summaryFor(wsB.id, sessionB.id, sessionB.title)],
      },
      workflow: defaultBlueprint('Current workflow'),
      locale: 'zh-CN',
    });

    // Click a session that lives in workspace B while A is the pinned workspace.
    useStore.getState().selectSession(sessionB.id, wsB.id);

    await waitFor(
      () => useStore.getState().activeSessionId === sessionB.id,
      'session B activation',
    );

    const state = useStore.getState();
    // The active view follows the clicked session...
    expect(state.activeWorkspaceId).toBe(wsB.id);
    expect(state.activeSessionId).toBe(sessionB.id);
    // ...but the top switcher's pinned workspace stays put.
    expect(state.selectedWorkspaceId).toBe(wsA.id);
  });

  it('updates the pinned workspace only when switched explicitly', async () => {
    await historyStore.ready();
    const wsA = await historyStore.resolveWorkspaceByPath('E:\\test_project_ue53');
    const wsB = await historyStore.resolveWorkspaceByPath('E:\\UltraGameStudio');
    const sessionB = await historyStore.createSession({
      workspaceId: wsB.id,
      isWorkflow: false,
      messages: [],
      title: 'UltraGameStudio chat',
    });

    useStore.setState({
      historyReady: true,
      activeWorkspaceId: wsA.id,
      selectedWorkspaceId: wsA.id,
      activeSessionId: null,
      workspaces: [wsA, wsB],
      sessions: [],
      sessionTree: {
        [wsA.id]: [],
        [wsB.id]: [summaryFor(wsB.id, sessionB.id, sessionB.title)],
      },
      workflow: defaultBlueprint('Current workflow'),
      locale: 'zh-CN',
    });

    useStore.getState().setWorkspace(wsB.path);

    await waitFor(
      () => useStore.getState().selectedWorkspaceId === wsB.id,
      'explicit workspace selection',
    );

    const state = useStore.getState();
    expect(state.activeWorkspaceId).toBe(wsB.id);
    expect(state.selectedWorkspaceId).toBe(wsB.id);
  });

  it('switches top workspace tabs from cached sessions without reloading indexes', async () => {
    await historyStore.ready();
    const wsA = await historyStore.resolveWorkspaceByPath('E:\\test_project_ue53');
    const wsB = await historyStore.resolveWorkspaceByPath('E:\\UltraGameStudio');
    const wsC = await historyStore.resolveWorkspaceByPath('E:\\MoonEngine');
    const sessionA = await historyStore.createSession({
      workspaceId: wsA.id,
      isWorkflow: false,
      messages: [],
      title: 'Game chat',
    });
    const sessionB = await historyStore.createSession({
      workspaceId: wsB.id,
      isWorkflow: false,
      messages: [],
      title: 'UltraGameStudio chat',
    });
    const sessionC = await historyStore.createSession({
      workspaceId: wsC.id,
      isWorkflow: false,
      messages: [],
      title: 'MoonEngine chat',
    });
    const cachedA = summaryFor(wsA.id, sessionA.id, sessionA.title);
    const cachedB = summaryFor(wsB.id, sessionB.id, sessionB.title);
    const cachedC = summaryFor(wsC.id, sessionC.id, sessionC.title);

    useStore.setState({
      historyReady: true,
      activeWorkspaceId: wsA.id,
      selectedWorkspaceId: wsA.id,
      activeSessionId: sessionA.id,
      workspaces: [wsA, wsB, wsC],
      sessions: [cachedA],
      sessionTree: {
        [wsA.id]: [cachedA],
        [wsB.id]: [cachedB],
        [wsC.id]: [cachedC],
      },
      workflow: defaultBlueprint('Current workflow'),
      locale: 'zh-CN',
    });
    const listSessions = vi.spyOn(historyStore, 'listSessions');

    useStore.getState().setWorkspace(wsB.path);

    await waitFor(
      () => useStore.getState().selectedWorkspaceId === wsB.id,
      'cached workspace selection',
    );

    const state = useStore.getState();
    expect(listSessions).not.toHaveBeenCalled();
    expect(state.activeWorkspaceId).toBe(wsB.id);
    expect(state.sessions.map((session) => session.id)).toEqual([sessionB.id]);
    expect(state.sessionTree[wsC.id]?.map((session) => session.id)).toEqual([
      sessionC.id,
    ]);
  });

  it('does not move the pinned workspace when a new session is created', async () => {
    await historyStore.ready();
    const wsA = await historyStore.resolveWorkspaceByPath('E:\\test_project_ue53');
    const wsB = await historyStore.resolveWorkspaceByPath('E:\\UltraGameStudio');

    // Game (wsA) is pinned at the top, but the active view lives in wsB after
    // the user opened an UltraGameStudio (wsB) session earlier.
    useStore.setState({
      historyReady: true,
      activeWorkspaceId: wsB.id,
      selectedWorkspaceId: wsA.id,
      activeSessionId: null,
      workspaces: [wsA, wsB],
      sessions: [],
      sessionTree: {
        [wsA.id]: [],
        [wsB.id]: [],
      },
      workflow: defaultBlueprint('Current workflow'),
      locale: 'zh-CN',
    });

    useStore.getState().newSession();

    await waitFor(
      () => useStore.getState().activeSessionId !== null,
      'new session creation',
    );

    const state = useStore.getState();
    // The new session lands in the active workspace...
    expect(state.activeWorkspaceId).toBe(wsB.id);
    // ...but the top switcher's pinned workspace stays on Game.
    expect(state.selectedWorkspaceId).toBe(wsA.id);
  });

  it.runIf(CLOUD_PROJECTS_ENABLED)('uses the remote project provider and model when a remote session is selected', async () => {
    await historyStore.ready();
    const remotePath = remoteWorkspacePath('rw_switch');
    const providerId = remoteProviderId('rw_switch', 'codex-main');
    saveRemoteWorkspace({
      id: 'rw_switch',
      label: '远程项目',
      serverUrl: 'https://runner.test',
      projectId: 'proj_switch',
      repoUrl: 'https://example.test/repo.git',
      adapter: 'codex',
      model: 'gpt-remote',
      useOwnModelKey: false,
    });
    upsertProviders([
      {
        id: providerId,
        kind: 'codex',
        name: '远程项目 · Codex',
        apiKey: 'remote-runner',
        baseUrl: 'https://runner.test',
        transport: 'cli',
        model: 'gpt-remote',
      },
    ]);
    const ws = await historyStore.resolveWorkspaceByPath(remotePath);
    const record = await historyStore.createSession({
      workspaceId: ws.id,
      isWorkflow: false,
      messages: [],
      title: '远程会话',
    });

    useStore.setState({
      historyReady: true,
      activeWorkspaceId: null,
      selectedWorkspaceId: null,
      activeSessionId: null,
      workspaces: [ws],
      sessions: [],
      sessionTree: {
        [ws.id]: [summaryFor(ws.id, record.id, record.title)],
      },
      workflow: defaultBlueprint('Local workflow'),
      composer: { ...defaultComposer, workspace: '' },
      composerBySession: {
        [workflowSessionKeyId({ workspaceId: ws.id, sessionId: record.id })]: {
          composer: { ...defaultComposer, workspace: remotePath },
          gatewaySelection: {
            adapter: 'claude-code',
            modelClass: 'local-model',
          },
        },
      },
      locale: 'zh-CN',
    });

    useStore.getState().selectSession(record.id, ws.id);

    await waitFor(
      () => useStore.getState().activeSessionId === record.id,
      'remote session activation',
    );

    const selection = workflowDefaultGatewaySelection(useStore.getState().workflow);
    expect(selection.adapter).toBe('codex');
    expect(selection.providerId).toBe(providerId);
    expect(selection.modelClass).toBe('gpt-remote');
    expect(selection.modelOverride).toBe('gpt-remote');
  });

  it.runIf(CLOUD_PROJECTS_ENABLED)('overrides a stale model on an already remote session selection', async () => {
    await historyStore.ready();
    const remotePath = remoteWorkspacePath('rw_stale_model');
    const providerId = remoteProviderId('rw_stale_model', 'codex-main');
    saveRemoteWorkspace({
      id: 'rw_stale_model',
      label: '远程项目',
      serverUrl: 'https://runner.test',
      projectId: 'proj_stale_model',
      repoUrl: 'https://example.test/repo.git',
      adapter: 'codex',
      model: 'gpt-remote',
      useOwnModelKey: false,
    });
    upsertProviders([
      {
        id: providerId,
        kind: 'codex',
        name: '远程项目 · Codex',
        apiKey: 'remote-runner',
        baseUrl: 'https://runner.test',
        transport: 'cli',
        model: 'old-local-model',
      },
    ]);
    const ws = await historyStore.resolveWorkspaceByPath(remotePath);
    const record = await historyStore.createSession({
      workspaceId: ws.id,
      isWorkflow: false,
      messages: [],
      title: '远程会话',
    });

    useStore.setState({
      historyReady: true,
      activeWorkspaceId: null,
      selectedWorkspaceId: null,
      activeSessionId: null,
      workspaces: [ws],
      sessions: [],
      sessionTree: {
        [ws.id]: [summaryFor(ws.id, record.id, record.title)],
      },
      workflow: defaultBlueprint('Local workflow'),
      composer: { ...defaultComposer, workspace: '' },
      composerBySession: {
        [workflowSessionKeyId({ workspaceId: ws.id, sessionId: record.id })]: {
          composer: { ...defaultComposer, workspace: remotePath },
          gatewaySelection: {
            adapter: 'codex',
            modelClass: 'old-local-model',
            modelOverride: 'old-local-model',
            providerId,
            channelId: 'default',
          },
        },
      },
      locale: 'zh-CN',
    });

    useStore.getState().selectSession(record.id, ws.id);

    await waitFor(
      () => useStore.getState().activeSessionId === record.id,
      'remote session activation',
    );

    const selection = workflowDefaultGatewaySelection(useStore.getState().workflow);
    expect(selection.adapter).toBe('codex');
    expect(selection.providerId).toBe(providerId);
    expect(selection.modelClass).toBe('gpt-remote');
    expect(selection.modelOverride).toBe('gpt-remote');
  });

  it.runIf(CLOUD_PROJECTS_ENABLED)('ignores Claude tier aliases for non-Claude remote project models', async () => {
    await historyStore.ready();
    const remotePath = remoteWorkspacePath('rw_codex_sonnet_alias');
    const providerId = remoteProviderId('rw_codex_sonnet_alias', 'codex-main');
    saveRemoteWorkspace({
      id: 'rw_codex_sonnet_alias',
      label: '远程项目',
      serverUrl: 'https://runner.test',
      projectId: 'proj_codex_sonnet_alias',
      repoUrl: 'https://example.test/repo.git',
      adapter: 'codex',
      model: 'sonnet',
      useOwnModelKey: false,
    });
    upsertProviders([
      {
        id: providerId,
        kind: 'codex',
        name: '远程项目 · Codex',
        apiKey: 'remote-runner',
        baseUrl: 'https://runner.test',
        transport: 'cli',
        model: 'gpt-5.5',
      },
    ]);
    const ws = await historyStore.resolveWorkspaceByPath(remotePath);
    const record = await historyStore.createSession({
      workspaceId: ws.id,
      isWorkflow: false,
      messages: [],
      title: '远程会话',
    });

    useStore.setState({
      historyReady: true,
      activeWorkspaceId: null,
      selectedWorkspaceId: null,
      activeSessionId: null,
      workspaces: [ws],
      sessions: [],
      sessionTree: {
        [ws.id]: [summaryFor(ws.id, record.id, record.title)],
      },
      workflow: defaultBlueprint('Local workflow'),
      composer: { ...defaultComposer, workspace: '' },
      composerBySession: {
        [workflowSessionKeyId({ workspaceId: ws.id, sessionId: record.id })]: {
          composer: { ...defaultComposer, workspace: remotePath },
          gatewaySelection: {
            adapter: 'codex',
            modelClass: 'sonnet',
            modelOverride: 'sonnet',
            providerId,
            channelId: 'default',
          },
        },
      },
      locale: 'zh-CN',
    });

    useStore.getState().selectSession(record.id, ws.id);

    await waitFor(
      () => useStore.getState().activeSessionId === record.id,
      'remote session activation',
    );

    const selection = workflowDefaultGatewaySelection(useStore.getState().workflow);
    expect(selection.adapter).toBe('codex');
    expect(selection.providerId).toBe(providerId);
    expect(selection.modelClass).toBe('gpt-5.5');
    expect(selection.modelOverride).toBeUndefined();
  });

  it.runIf(CLOUD_PROJECTS_ENABLED)('does not bind to a mismatched account when the project agent has none', async () => {
    await historyStore.ready();
    const remotePath = remoteWorkspacePath('rw_claude_no_account');
    // Runner only exposes a Codex account, but the project is configured for
    // the Claude agent with a Claude-family default model.
    const codexProviderId = remoteProviderId('rw_claude_no_account', 'codex-main');
    saveRemoteWorkspace({
      id: 'rw_claude_no_account',
      label: '远程项目',
      serverUrl: 'https://runner.test',
      projectId: 'proj_claude_no_account',
      repoUrl: 'https://example.test/repo.git',
      adapter: 'claude',
      model: 'claude-opus-4-8',
      useOwnModelKey: false,
    });
    upsertProviders([
      {
        id: codexProviderId,
        kind: 'codex',
        name: '远程项目 · Codex',
        apiKey: 'remote-runner',
        baseUrl: 'https://runner.test',
        transport: 'cli',
        model: 'gpt-5.5',
      },
    ]);
    const ws = await historyStore.resolveWorkspaceByPath(remotePath);
    const record = await historyStore.createSession({
      workspaceId: ws.id,
      isWorkflow: false,
      messages: [],
      title: '远程会话',
    });

    useStore.setState({
      historyReady: true,
      activeWorkspaceId: null,
      selectedWorkspaceId: null,
      activeSessionId: null,
      workspaces: [ws],
      sessions: [],
      sessionTree: {
        [ws.id]: [summaryFor(ws.id, record.id, record.title)],
      },
      workflow: defaultBlueprint('Local workflow'),
      composer: { ...defaultComposer, workspace: '' },
      composerBySession: {
        [workflowSessionKeyId({ workspaceId: ws.id, sessionId: record.id })]: {
          composer: { ...defaultComposer, workspace: remotePath },
          gatewaySelection: {
            adapter: 'claude-code',
            modelClass: 'local-model',
          },
        },
      },
      locale: 'zh-CN',
    });

    useStore.getState().selectSession(record.id, ws.id);

    await waitFor(
      () => useStore.getState().activeSessionId === record.id,
      'remote session activation',
    );

    const selection = workflowDefaultGatewaySelection(useStore.getState().workflow);
    // Must stay on the Claude agent's system default, NOT hijack to Codex.
    expect(selection.adapter).toBe('claude-code');
    expect(selection.providerId).toBeUndefined();
    expect(selection.systemDefault).toBe(true);
    // The Claude-family default model is preserved for the Claude adapter.
    expect(selection.modelClass).toBe('claude-opus-4-8');
  });
});
