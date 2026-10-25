import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultBlueprint, simpleBlueprint } from '@/core/defaultBlueprint';
import type { IRGraph } from '@/core/ir';
import { personalInstructionsKey } from '@/core/personalInstructions';
import {
  encodeToolPatch,
  extractToolSentinels,
  mergeToolPatches,
} from '@/components/ai/lib/toolEvent';
import { extractSessionFiles } from '@/lib/sessionFiles';
import { resetSecureStorageForTests } from '@/lib/secureStorage';
import { refreshCliRuntime } from '@/lib/cliConfig';
import {
  systemDefaultGatewaySelection,
  workflowDefaultGatewaySelection,
} from '@/lib/modelGateway/resolver';
import { DEFAULT_GAME_EXPERT_SETTINGS } from '@/lib/gameExperts';
import { defaultComposer } from './sampleSessions';
import {
  remoteProviderId,
  remoteWorkspacePath,
  saveRemoteWorkspace,
} from '@/lib/remoteWorkspace';
import { upsertProviders } from '@/lib/apiConfig';
import { CLOUD_PROJECTS_ENABLED } from '@/lib/cloudProjects';

const gatewayMocks = vi.hoisted(() => ({
  completeGatewayText: vi.fn(),
  resolveDirectGatewayRoute: vi.fn(),
  resolveCliGatewayRoute: vi.fn(),
}));

const skillLearningMocks = vi.hoisted(() => ({
  beginSkillLearningTurn: vi.fn(),
}));

vi.mock('@/lib/skillLearningDesktop', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/skillLearningDesktop')>(),
  beginSkillLearningTurn: skillLearningMocks.beginSkillLearningTurn,
}));

const tauriMocks = vi.hoisted(() => ({
  aiEditViaCli: vi.fn(),
  aiCliSteerSupported: vi.fn(
    async (adapter: string) => adapter === 'codex' || adapter === 'claude-code',
  ),
  cancelAiCli: vi.fn(),
  steerAiCli: vi.fn(),
  freeProxyEnsure: vi.fn(),
  isTauri: vi.fn(() => false),
  previewLocalFile: vi.fn(),
  tauriAvailable: vi.fn(() => false),
  ensureWorkspaceChangesBaseline: vi.fn(async () => ({ rootPath: 'E:/project', generatedAtMs: 1, fileCount: 1, truncated: false })),
  listWorkspaceChanges: vi.fn(async () => ({ rootPath: 'E:/project', generatedAtMs: 2, files: [], truncated: false })),
}));

const notificationMocks = vi.hoisted(() => ({
  dismissSessionWaitingInputNotification: vi.fn(),
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
    aiCliSteerSupported: tauriMocks.aiCliSteerSupported,
    cancelAiCli: tauriMocks.cancelAiCli,
    steerAiCli: tauriMocks.steerAiCli,
    freeProxyEnsure: tauriMocks.freeProxyEnsure,
    isTauri: tauriMocks.isTauri,
    previewLocalFile: tauriMocks.previewLocalFile,
    tauriAvailable: tauriMocks.tauriAvailable,
    ensureWorkspaceChangesBaseline: tauriMocks.ensureWorkspaceChangesBaseline,
    listWorkspaceChanges: tauriMocks.listWorkspaceChanges,
  };
});

vi.mock('@/lib/sessionNotification', async () => {
  const actual = await vi.importActual<typeof import('@/lib/sessionNotification')>(
    '@/lib/sessionNotification',
  );
  return {
    ...actual,
    dismissSessionWaitingInputNotification:
      notificationMocks.dismissSessionWaitingInputNotification,
    notifySessionComplete: notificationMocks.notifySessionComplete,
  };
});

import { useStore } from './useStore';
import {
  addAiEditChannel,
  aiEditCommitMessages,
  aiEditViewActive,
  gatewayRouteHeader,
  gatewayRouteLine,
  isActiveAiEditingSession,
  isWorkflowReadOnly,
  removeAiEditChannel,
  __resetSimpleChatRuntimeForTests,
} from './useStore';
import type { AiEditChannel } from './useStore';
import { historyStore } from './history/store';
import type { Message, Session } from './types';
import { activeAiEdits } from './channelRegistry';
import { orderDisplayMessages } from '@/components/ai/lib/orderDisplayMessages';

function cloneGraph(graph: IRGraph): IRGraph {
  return JSON.parse(JSON.stringify(graph)) as IRGraph;
}

function resetStore(workflow: IRGraph): void {
  window.localStorage.setItem('ugs_research_angles_max', '1');
  window.localStorage.setItem('ugs_nodegen_candidates_max', '1');
  useStore.setState({
    workflow: cloneGraph(workflow),
    selectedNodeId: null,
    mode: 'design',
    aiStreaming: false,
    aiEditingSessions: [],
    chattingSessions: [],
    queuedChatMessageIds: [],
    steerableQueuedChatMessageIds: [],
    editingQueuedChatMessageId: null,
    blockedSendTip: null,
    dirty: false,
    currentFilePath: null,
    messages: [],
    composer: defaultComposer,
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
    modelClass: 'sonnet',
    apiKey: 'test-key',
    model: 'sonnet',
    transport: 'anthropic',
    mode: 'direct',
    label: 'sonnet',
    source: 'global',
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
  skillLearningMocks.beginSkillLearningTurn.mockReset();
  gatewayMocks.completeGatewayText.mockReset();
  gatewayMocks.resolveDirectGatewayRoute.mockReset();
  gatewayMocks.resolveCliGatewayRoute.mockReset();
  tauriMocks.aiEditViaCli.mockReset();
  tauriMocks.aiCliSteerSupported.mockReset();
  tauriMocks.cancelAiCli.mockReset();
  tauriMocks.steerAiCli.mockReset();
  tauriMocks.freeProxyEnsure.mockReset();
  tauriMocks.isTauri.mockReset();
  tauriMocks.previewLocalFile.mockReset();
  tauriMocks.tauriAvailable.mockReset();
  notificationMocks.dismissSessionWaitingInputNotification.mockReset();
  notificationMocks.notifySessionComplete.mockReset();
  tauriMocks.freeProxyEnsure.mockResolvedValue({ port: 8766, token: 'test-token' });
  tauriMocks.aiCliSteerSupported.mockImplementation(
    async (adapter: string) => adapter === 'codex' || adapter === 'claude-code',
  );
  tauriMocks.isTauri.mockReturnValue(false);
  tauriMocks.tauriAvailable.mockReturnValue(false);
  resetStore(defaultBlueprint('Current workflow'));
  window.localStorage.clear();
  resetSecureStorageForTests();
  await refreshCliRuntime();
});

describe('simple-workflow chat mode', () => {
  it('captures native reference evidence on CLI and gateway routes before tool logs are clipped', async () => {
    for (const route of ['cli', 'gateway'] as const) {
      __resetSimpleChatRuntimeForTests();
      resetStore(simpleBlueprint('Reference capture'));
      tauriMocks.tauriAvailable.mockReturnValue(true);
      if (route === 'cli') {
        tauriMocks.isTauri.mockReturnValue(true);
        gatewayMocks.resolveDirectGatewayRoute.mockReturnValue(null);
        gatewayMocks.resolveCliGatewayRoute.mockResolvedValue({
          selection: { adapter: 'codex', modelClass: 'default' }, adapter: 'codex', modelClass: 'default',
          model: 'test-model', mode: 'cli', transport: 'cli', label: 'Test CLI', source: 'global', cliCommand: 'codex',
        });
      } else { mockDirectRoute(); }
      const answer = '结论 [1](https://example.com/docs)。';
      const emit = (request: { runId: string; onTool?: (event: unknown) => void; onToolEvent?: (event: unknown) => void }) => {
        const event = { runId: request.runId, toolCallId: 'search', toolName: 'web_search', phase: 'end',
          provenance: 'native-tool', status: 'success', result: JSON.stringify({ results: [
            { title: '真实来源', url: 'https://example.com/docs' }, { title: '未引用', url: 'https://example.com/unused' },
          ] }) };
        (request.onTool ?? request.onToolEvent)?.(event);
        return answer;
      };
      tauriMocks.aiEditViaCli.mockImplementation(async (_prompt, _adapter, options) => emit(options));
      gatewayMocks.completeGatewayText.mockImplementation(async (request) => request.runId ? emit(request) : '参考资料');
      expect(useStore.getState().sendPrompt('查询资料。')).toBe(true);
      await waitFor(() => useStore.getState().chattingSessions.length === 0 && useStore.getState().messages.some((message) => message.role === 'assistant' && message.text.includes(answer)), `${route} references`);
      const reply = useStore.getState().messages.find((message) => message.role === 'assistant');
      expect(reply?.referenceSources, route).toHaveLength(2);
      expect(reply?.references, route).toEqual([{ url: 'https://example.com/docs', title: '真实来源', toolCallId: 'search', number: 1 }]);
    }
  });
  it('persists learning states only to the frozen source session after navigation', async () => {
    resetStore(simpleBlueprint('Learning source'));
    mockDirectRoute();
    const source = await historyStore.createSession({
      workspaceId: '__default__', id: 'learning-source', isWorkflow: false, messages: [],
    });
    const other = await historyStore.createSession({
      workspaceId: '__default__', id: 'learning-other', isWorkflow: false,
      messages: [{ id: 'other-user', role: 'user', text: 'Other session.', createdAt: 1 }],
    });
    useStore.setState({ historyReady: true, activeWorkspaceId: source.workspaceId, activeSessionId: source.id });
    tauriMocks.tauriAvailable.mockReturnValue(true);
    let callback: ((state: import('@/runtime/skills/types').SkillReviewState) => void) | undefined;
    let reviewOrigin: import('@/runtime/skills/types').SkillOrigin | undefined;
    const finish = vi.fn(async () => {
      callback?.({ status: 'queued', origin: reviewOrigin! });
      const result = { origin: reviewOrigin!, status: 'applied' as const, batchId: 'source-batch',
        lesson: 'Read the manifest before selecting packages.', operationsApplied: 1,
        changes: [], riskReasons: [], rollbackId: 'source-rollback' };
      callback?.({ status: result.status, origin: result.origin, result });
      return result;
    });
    skillLearningMocks.beginSkillLearningTurn.mockImplementation((options) => {
      // Only the unavailable skill transport is mocked; history uses real localStorage.
      tauriMocks.tauriAvailable.mockReturnValue(false);
      callback = options.onState;
      reviewOrigin = { ...options.origin, runId: 'independent-source-review' };
      return { origin: options.origin, loadContext: async () => ({
        prompt: options.prompt, loadedSkills: [], catalogRevision: 'source-catalog',
      }), onTool: vi.fn(), finish };
    });
    gatewayMocks.completeGatewayText.mockImplementation(async () => {
      useStore.setState({ activeSessionId: other.id, messages: other.messages });
      await historyStore.appendMessage(source.workspaceId, source.id, {
        id: 'source-next', role: 'user', text: 'A later source message.', createdAt: 2,
      });
      return 'Task verified.';
    });
    expect(useStore.getState().sendPrompt('Check dependencies.')).toBe(true);
    await waitFor(() => finish.mock.calls.length === 1, 'learning finish');
    expect(callback).toBeTypeOf('function');
    await waitFor(async () => !!(await historyStore.getSession(source.workspaceId, source.id))?.messages
      .find((message) => message.skillLearning?.status === 'applied'), 'persisted source learning state');
    const persisted = await historyStore.getSession(source.workspaceId, source.id);
    const cards = persisted!.messages.filter((message) => message.skillLearning);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ role: 'assistant', localOnly: true,
      skillLearning: { origin: reviewOrigin, status: 'applied', result: { batchId: 'source-batch' } } });
    expect(persisted?.messages.some((message) => message.id === 'source-next')).toBe(true);
    expect(persisted?.messages.find((message) => message.role === 'user' && message.text === 'Check dependencies.'))
      .toMatchObject({ skillContext: {
        origin: skillLearningMocks.beginSkillLearningTurn.mock.calls[0][0].origin,
        loadedSkills: [], catalogRevision: 'source-catalog',
      } });
    expect(useStore.getState().messages).toEqual(other.messages);
    expect((await historyStore.getSession(other.workspaceId, other.id))?.messages).toEqual(other.messages);
  });

  it('enqueues the new session record before an immediate first message', async () => {
    resetStore(simpleBlueprint('Immediate session send'));
    mockDirectRoute();
    const order: string[] = [];
    const workspace = { id: 'workspace-immediate-source', path: '', name: 'Unbound', updatedAt: 1, sessionCount: 0 };
    useStore.setState({ historyReady: true, activeWorkspaceId: workspace.id, workspaces: [workspace], sessions: [], sessionTree: { [workspace.id]: [] } });
    const create = vi.spyOn(historyStore, 'createSession').mockImplementation(async (input) => {
      order.push('create');
      return { id: input.id!, workspaceId: input.workspaceId, title: input.title ?? 'Unbound', isWorkflow: false, createdAt: 1, updatedAt: 1, messages: [] };
    });
    const append = vi.spyOn(historyStore, 'appendMessage').mockImplementation(async () => { order.push('append'); });
    const patchConfig = vi.spyOn(historyStore, 'patchConfig').mockResolvedValue({} as never);
    gatewayMocks.completeGatewayText.mockResolvedValue('Complete.');
    try {
      useStore.getState().newSession();
      useStore.getState().sendPrompt('First message.');
      await waitFor(() => !useStore.getState().aiStreaming, 'immediate first turn');
      expect(order.slice(0, 2)).toEqual(['create', 'append']);
    } finally {
      create.mockRestore(); append.mockRestore(); patchConfig.mockRestore();
    }
  });

  it('waits for the optimistic session to persist before binding the skill host', async () => {
    resetStore(simpleBlueprint('Persistent skill source'));
    mockDirectRoute();
    const workspace = { id: 'workspace-skill-source', path: 'E:/skill-source', name: 'Skill source', updatedAt: 1, sessionCount: 0 };
    useStore.setState({ historyReady: true, activeWorkspaceId: workspace.id, workspaces: [workspace], sessions: [], sessionTree: { [workspace.id]: [] } });
    let persistSession!: () => void;
    const persisted = new Promise<void>((resolve) => { persistSession = resolve; });
    let createdSessionId = '';
    const create = vi.spyOn(historyStore, 'createSession').mockImplementation(async (input) => {
      createdSessionId = input.id!;
      await persisted;
      return { id: input.id!, workspaceId: input.workspaceId, title: input.title ?? 'Skill source', isWorkflow: false, createdAt: 1, updatedAt: 1, messages: [] };
    });
    const getSession = vi.spyOn(historyStore, 'getSession').mockImplementation(async (workspaceId, sessionId) => {
      expect(workspaceId).toBe(workspace.id);
      expect(sessionId).toBe(createdSessionId);
      await persisted;
      return { id: sessionId, workspaceId, title: 'Skill source', isWorkflow: false, createdAt: 1, updatedAt: 1, messages: [] };
    });
    const patchConfig = vi.spyOn(historyStore, 'patchConfig').mockResolvedValue({} as never);
    const finish = vi.fn();
    let hostBound = false;
    skillLearningMocks.beginSkillLearningTurn.mockImplementation((options) => ({
      loadContext: async () => {
        if (!options.ready) throw new Error('missing persisted skill-source barrier');
        await options.ready;
        hostBound = true;
        return { prompt: options.prompt, loadedSkills: [], catalogRevision: 'catalog-source' };
      }, onTool: vi.fn(), finish,
    }));
    gatewayMocks.completeGatewayText.mockResolvedValue('Complete.');
    try {
      useStore.getState().newSession();
      tauriMocks.tauriAvailable.mockReturnValue(true);
      expect(useStore.getState().sendPrompt('Read the source.', { skillIds: ['source-skill'] })).toBe(true);
      await waitFor(() => skillLearningMocks.beginSkillLearningTurn.mock.calls.length === 1, 'skill source construction');
      expect(hostBound).toBe(false);
      expect(gatewayMocks.completeGatewayText).not.toHaveBeenCalled();
      persistSession();
      await waitFor(() => finish.mock.calls.length === 1, 'source-bound turn completion');
      expect(hostBound).toBe(true);
      expect(skillLearningMocks.beginSkillLearningTurn.mock.calls[0][0].origin).toMatchObject({ hostId: 'local', workspaceId: workspace.id, sessionId: createdSessionId, cwd: workspace.path });
    } finally {
      persistSession();
      create.mockRestore(); getSession.mockRestore(); patchConfig.mockRestore();
    }
  });

  it('persists confirmed context compression and updates the live session marker', async () => {
    resetStore(simpleBlueprint('Compression status'));
    const session = { id: 'compressed-live', workspaceId: '__default__', title: '压缩状态', createdAt: 1, isWorkflow: false };
    useStore.setState({ activeSessionId: session.id, activeWorkspaceId: session.workspaceId, sessions: [session], sessionTree: { [session.workspaceId]: [session] } });
    tauriMocks.isTauri.mockReturnValue(true);
    tauriMocks.tauriAvailable.mockReturnValue(true);
    gatewayMocks.resolveDirectGatewayRoute.mockReturnValue(null);
    gatewayMocks.resolveCliGatewayRoute.mockResolvedValue({
      selection: { adapter: 'codex', modelClass: 'default' }, adapter: 'codex', modelClass: 'default',
      model: 'test-model', mode: 'cli', transport: 'cli', label: 'Test CLI', source: 'global', cliCommand: 'codex',
    });
    let markerSeen = false;
    tauriMocks.aiEditViaCli.mockImplementation(async (_prompt, _adapter, options) => {
      options.onProgress?.('\n<<UGS_TOOL>>{"id":"compact","name":"ugs_context_compaction","status":"done","ephemeral":true}<<UGS_TOOL_END>>\n');
      markerSeen = useStore.getState().sessions.some((session) => session.contextCompressed === true);
      return '压缩后的回答';
    });
    expect(useStore.getState().sendPrompt('继续任务')).toBe(true);
    await waitFor(() => tauriMocks.aiEditViaCli.mock.calls.length > 0 && useStore.getState().chattingSessions.length === 0, 'compressed turn completion');
    const state = useStore.getState();
    expect(markerSeen).toBe(true);
    expect(state.messages.find((message) => message.role === 'assistant')?.contextCompressed).toBe(true);
    expect(state.messages.find((message) => message.role === 'assistant')?.text).not.toContain('ugs_context_compaction');
    expect(state.sessions.find((session) => session.id === state.activeSessionId)?.contextCompressed).toBe(true);
  });

  it('forwards native CLI tool completions to learning without deriving evidence from progress text', async () => {
    resetStore(simpleBlueprint('Native skill evidence'));
    tauriMocks.isTauri.mockReturnValue(true);
    tauriMocks.tauriAvailable.mockReturnValue(true);
    gatewayMocks.resolveDirectGatewayRoute.mockReturnValue(null);
    gatewayMocks.resolveCliGatewayRoute.mockResolvedValue({
      selection: { adapter: 'codex', modelClass: 'default' }, adapter: 'codex', modelClass: 'default',
      model: 'test-model', mode: 'cli', transport: 'cli', label: 'Test CLI', source: 'global', cliCommand: 'codex',
    });
    const onTool = vi.fn();
    const finish = vi.fn();
    skillLearningMocks.beginSkillLearningTurn.mockReturnValue({
      loadContext: async () => ({ prompt: 'Verify the change.', loadedSkills: [], catalogRevision: 'catalog-native' }),
      onTool, finish,
    });
    let native: Record<string, unknown> | undefined;
    tauriMocks.aiEditViaCli.mockImplementation(async (_prompt, _adapter, options) => {
      native = { runId: options.runId, toolCallId: 'test-call', toolName: 'command_execution', phase: 'end', provenance: 'native-tool', status: 'success', exitCode: 0, args: { command: 'npm test' }, result: 'Tests passed.' };
      options.onProgress?.('<<UGS_TOOL>>{"name":"command_execution","status":"success"}<</UGS_TOOL>>');
      options.onTool?.(native);
      return 'Verified.';
    });
    expect(useStore.getState().sendPrompt('Verify the change.')).toBe(true);
    await waitFor(() => finish.mock.calls.length === 1, 'native evidence turn');
    expect(onTool).toHaveBeenCalledExactlyOnceWith(native);
    expect(native?.runId).not.toBe(skillLearningMocks.beginSkillLearningTurn.mock.calls[0][0].origin.runId);
    expect(finish).toHaveBeenCalledWith({ finalAnswer: 'Verified.', terminal: 'completed' });
  });

  it('binds native skill tools to the persisted original source across CLI and gateway calls', async () => {
    for (const route of ['cli', 'gateway'] as const) {
      __resetSimpleChatRuntimeForTests();
      resetStore(simpleBlueprint('Scoped skill tools'));
      tauriMocks.tauriAvailable.mockReturnValue(false);
      const source = await historyStore.createSession({
        workspaceId: '__default__', id: `scoped-tools-${route}`, isWorkflow: false, messages: [],
      });
      useStore.setState({ historyReady: true, activeWorkspaceId: source.workspaceId, activeSessionId: source.id });
      tauriMocks.tauriAvailable.mockReturnValue(true);
      tauriMocks.isTauri.mockReturnValue(route === 'cli');
      if (route === 'cli') {
        gatewayMocks.resolveDirectGatewayRoute.mockReturnValue(null);
        gatewayMocks.resolveCliGatewayRoute.mockResolvedValue({
          selection: { adapter: 'claude-code', modelClass: 'sonnet' }, adapter: 'claude-code', modelClass: 'sonnet',
          model: 'sonnet', mode: 'cli', transport: 'cli', label: 'Test CLI', source: 'global', cliCommand: 'claude',
        });
      } else {
        mockDirectRoute();
      }
      const finish = vi.fn();
      let passedTools: unknown;
      skillLearningMocks.beginSkillLearningTurn.mockImplementation(() => {
        // Only unavailable native transport is mocked; history persists in the
        // real browser fallback, while isTauri still chooses the CLI branch.
        tauriMocks.tauriAvailable.mockReturnValue(false);
        return {
          loadContext: async () => ({ prompt: 'Read the manifest.', loadedSkills: [], catalogRevision: 'scoped-catalog' }),
          onTool: vi.fn(), finish,
        };
      });
      const verifyRequest = async (request: { skillTools?: { source: Record<string, unknown>; config: Record<string, unknown>; ready?: Promise<void> }; runId: string }) => {
        passedTools = request.skillTools;
        expect(request.skillTools, route).toBeDefined();
        await request.skillTools!.ready;
        const frozen = skillLearningMocks.beginSkillLearningTurn.mock.calls.at(-1)![0].origin;
        expect(request.skillTools!.source).toEqual(frozen);
        expect(request.skillTools!.source.runId).not.toBe(request.runId);
        expect(request.skillTools!.config).toMatchObject({ enabled: true, mode: 'auto-safe' });
        expect((await historyStore.getSession(source.workspaceId, source.id))?.messages
          .find((message) => message.id === frozen.turnId)?.skillContext?.origin).toEqual(frozen);
        return 'Read.';
      };
      tauriMocks.aiEditViaCli.mockImplementation(async (_prompt, _adapter, options) => verifyRequest(options));
      gatewayMocks.completeGatewayText.mockImplementation((request) =>
        // Title naming is a separate completion with no execution run.
        request.runId ? verifyRequest(request) : Promise.resolve('Manifest check'));
      expect(useStore.getState().sendPrompt('Read the manifest.')).toBe(true);
      await waitFor(() => finish.mock.calls.length === 1, `${route} scoped skill tools`);
      expect(passedTools, route).toBeDefined();
      expect(finish).toHaveBeenCalledWith({ finalAnswer: 'Read.', terminal: 'completed' });
    }
  });

  it('forwards ordinary gateway fallback evidence to the same frozen learning turn', async () => {
    resetStore(simpleBlueprint('Gateway skill evidence'));
    mockDirectRoute();
    tauriMocks.tauriAvailable.mockReturnValue(true);
    const onTool = vi.fn(); const finish = vi.fn();
    skillLearningMocks.beginSkillLearningTurn.mockReturnValue({
      loadContext: async () => ({ prompt: 'Check the output.', loadedSkills: [], catalogRevision: 'catalog-fallback' }), onTool, finish,
    });
    let event: Record<string, unknown> | undefined;
    gatewayMocks.completeGatewayText.mockImplementation(async (request) => {
      event = { runId: request.runId, toolCallId: 'fallback-check', toolName: 'Bash', phase: 'end', provenance: 'native-tool', exitCode: 0, status: 'success', result: 'Actual check completed.' };
      request.onToolEvent?.(event);
      return 'Checked.';
    });
    useStore.getState().sendPrompt('Check the output.');
    await waitFor(() => finish.mock.calls.length === 1, 'fallback evidence');
    expect(onTool).toHaveBeenCalledExactlyOnceWith(event);
  });

  it('loads selected skill content at turn execution and only adds it to this user request', async () => {
    resetStore(simpleBlueprint('Skill chat'));
    mockDirectRoute();
    const source = await historyStore.createSession({
      workspaceId: '__default__', id: 'skill-context-source', isWorkflow: false, messages: [],
    });
    useStore.setState({ historyReady: true, activeWorkspaceId: source.workspaceId, activeSessionId: source.id });
    tauriMocks.tauriAvailable.mockReturnValue(true);
    const finish = vi.fn();
    skillLearningMocks.beginSkillLearningTurn.mockImplementation(() => {
      tauriMocks.tauriAvailable.mockReturnValue(false);
      return {
      loadContext: async () => ({
        prompt: 'Choose dependencies.\n\nRead package.json first: complete SKILL.md body.',
        loadedSkills: [{ skillId: 'manifest-a', revision: 'revision-a', hash: 'hash-a', files: ['SKILL.md'] }],
        catalogRevision: 'catalog-a',
      }), onTool: vi.fn(), finish,
      };
    });
    gatewayMocks.completeGatewayText.mockResolvedValue('Dependencies selected.');
    expect(useStore.getState().sendPrompt('Choose dependencies.', { skillIds: ['manifest-a'] })).toBe(true);
    await waitFor(() => !useStore.getState().aiStreaming, 'skill-context turn');
    const request = gatewayMocks.completeGatewayText.mock.calls.find(([request]) =>
      request.userContent?.includes('complete SKILL.md body.'))?.[0];
    expect(request).toBeDefined();
    expect(request.system).not.toContain('complete SKILL.md body.');
    expect(skillLearningMocks.beginSkillLearningTurn).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'Choose dependencies.', explicitSkillIds: ['manifest-a'],
      origin: expect.objectContaining({ hostId: 'local' }),
    }));
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ terminal: 'completed' }));
    expect(useStore.getState().messages.find((m) => m.role === 'user')?.text).toBe('Choose dependencies.');
    expect((await historyStore.getSession(source.workspaceId, source.id))?.messages.find((message) => message.role === 'user')?.skillContext)
      .toMatchObject({ loadedSkills: [{ skillId: 'manifest-a', revision: 'revision-a', hash: 'hash-a', files: ['SKILL.md'] }], catalogRevision: 'catalog-a' });
  });

  it('does not treat a background AI-edit channel as the active view', () => {
    // A UGS_GEN generation driven from inside the chat loop is marked
    // `background: true`; its two-message shadow view must never flash over the
    // driving chat bubble, so aiEditViewActive reports false for it.
    resetStore(simpleBlueprint('Simple chat'));
    useStore.setState({ activeWorkspaceId: 'ws1', activeSessionId: 's1' });
    const base: AiEditChannel = {
      key: 'bg',
      sessionKey: 'ws1:s1',
      workspaceId: 'ws1',
      sessionId: 's1',
      workflow: simpleBlueprint('Simple chat'),
      messages: [{ id: 'm1', role: 'user', text: 'hi', createdAt: 1 }],
      cliRunIds: new Set(),
      abortController: new AbortController(),
      workflowSession: false,
      chat: true,
      background: true,
      ownedMessageIds: new Set(['m1']),
    };
    expect(aiEditViewActive(base)).toBe(false);

    const foreground = { ...base, key: 'fg', background: false };
    expect(aiEditViewActive(foreground)).toBe(true);
  });

  it('stamps assistant completion time when persisting an AI edit message', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    const updateSpy = vi.spyOn(historyStore, 'updateSession').mockResolvedValue({
      id: 's1',
      workspaceId: 'ws1',
      title: 'Chat',
      isWorkflow: false,
      createdAt: 1,
      updatedAt: 5_000,
      messages: [],
    } as never);
    const workflow = simpleBlueprint('Simple chat');
    resetStore(workflow);
    useStore.setState({
      historyReady: true,
      activeWorkspaceId: 'ws1',
      activeSessionId: 's1',
      sessions: [
        {
          id: 's1',
          workspaceId: 'ws1',
          title: 'Chat',
          createdAt: 1,
          updatedAt: 1,
          isWorkflow: false,
        },
      ],
      sessionTree: {
        ws1: [
          {
            id: 's1',
            workspaceId: 'ws1',
            title: 'Chat',
            createdAt: 1,
            updatedAt: 1,
            isWorkflow: false,
          },
        ],
      },
    });
    const ch: AiEditChannel = {
      key: 'ws1::s1::m_user',
      sessionKey: 'ws1::s1',
      workspaceId: 'ws1',
      sessionId: 's1',
      workspaceRootPath: null,
      workflow,
      messages: [
        { id: 'm_user', role: 'user', text: 'start', createdAt: 1_000 },
        {
          id: 'm_assistant',
          role: 'assistant',
          text: 'done',
          createdAt: 1_001,
        },
      ],
      cliRunIds: new Set(),
      abortController: new AbortController(),
      workflowSession: false,
      chat: true,
      ownedMessageIds: new Set(['m_user', 'm_assistant']),
    };

    try {
      addAiEditChannel(ch);
      aiEditCommitMessages(ch, true);
      await vi.advanceTimersByTimeAsync(800);

      expect(
        ch.messages.find((message) => message.id === 'm_assistant')?.completedAt,
      ).toBe(5_000);
      expect(updateSpy).toHaveBeenCalledWith(
        'ws1',
        's1',
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              id: 'm_assistant',
              completedAt: 5_000,
            }),
          ]),
        }),
      );
    } finally {
      removeAiEditChannel(ch);
      updateSpy.mockRestore();
      vi.useRealTimers();
    }
  });

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
      () => useStore.getState().sessions[0]?.title === '新会话',
      'plain chat session history title',
    );

    const session = useStore.getState().sessions[0];
    const record = await historyStore.getSession(workspace.id, session.id);

    expect(session.isWorkflow).toBe(false);
    expect(session.title).toBe('新会话');
    expect(useStore.getState().workflow.meta.simple).toBe(true);
    expect(useStore.getState().workflow.nodes).toHaveLength(1);
    expect(record?.title).toBe('新会话');
    expect(record?.isWorkflow).toBe(false);
    expect(record?.workflow).toBeUndefined();
  });

  it('inherits the Settings default thinking level when creating a new chat session', async () => {
    window.localStorage.clear();
    await historyStore.ready();
    const workspace = await historyStore.resolveWorkspaceByPath('');
    resetStore(simpleBlueprint('Existing chat'));
    useStore.setState({
      historyReady: true,
      activeWorkspaceId: workspace.id,
      activeSessionId: 'existing-thinking-session',
      workspaces: [workspace],
      composerBySession: {},
      sessions: [],
      sessionTree: { [workspace.id]: [] },
      locale: 'zh-CN',
    });
    useStore.getState().setSessionRunSelection({
      adapter: 'codex',
      modelClass: 'gpt-6',
      systemDefault: true,
      thinkingLevel: 'low',
    });
    // Settings edits the default for future sessions, while the current
    // conversation retains its own explicit thinking level.
    useStore.getState().setDefaultRunSelection({
      adapter: 'codex',
      modelClass: 'gpt-6',
      systemDefault: true,
      thinkingLevel: 'xhigh',
    });
    expect(workflowDefaultGatewaySelection(useStore.getState().workflow).thinkingLevel)
      .toBe('low');

    useStore.getState().newSession();

    await waitFor(
      () => useStore.getState().activeSessionId !== 'existing-thinking-session',
      'new chat with the Settings default thinking level',
    );
    const state = useStore.getState();
    expect(workflowDefaultGatewaySelection(state.workflow)).toMatchObject({
      adapter: 'codex',
      modelClass: 'gpt-6',
      systemDefault: true,
      thinkingLevel: 'xhigh',
    });
    expect(state.composerBySession[`${workspace.id}::${state.activeSessionId}`]
      .gatewaySelection.thinkingLevel).toBe('xhigh');
    await waitFor(
      async () => !!(await historyStore.getSession(workspace.id, state.activeSessionId!)),
      'new chat persisted',
    );
  });

  it('keeps visible chat messages while history activation is waiting for disk init', async () => {
    window.localStorage.clear();
    await historyStore.ready();
    const workspace = await historyStore.resolveWorkspaceByPath('');
    const existingMessages: Message[] = [
      { id: 'm_user_pending', role: 'user', text: '之前的问题', createdAt: 1 },
      {
        id: 'm_ai_pending',
        role: 'assistant',
        text: '之前的回答',
        createdAt: 2,
      },
    ];
    const session: Session = {
      id: 's_pending_history',
      workspaceId: workspace.id,
      title: '历史会话',
      createdAt: 1,
      updatedAt: 2,
      isWorkflow: false,
      messageCount: existingMessages.length,
      preview: existingMessages.at(-1)?.text,
    };
    resetStore(defaultBlueprint('Current workflow'));
    useStore.setState({
      historyReady: false,
      activeWorkspaceId: workspace.id,
      activeSessionId: 's_current',
      workspaces: [workspace],
      sessions: [session],
      sessionTree: { [workspace.id]: [session] },
      messages: existingMessages,
      workflow: simpleBlueprint('当前聊天'),
      locale: 'zh-CN',
    });

    useStore.getState().selectSession(session.id, workspace.id);

    expect(useStore.getState().activeSessionId).toBe(session.id);
    expect(useStore.getState().messages).toEqual(existingMessages);
    expect(useStore.getState().workflow.meta.simple).toBe(true);
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
      () => useStore.getState().sessions[0]?.title === '新会话',
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
      await historyStore.resolveWorkspaceByPath('E:\\UltraGameStudio');
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
      title: 'UltraGameStudio chat',
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
      const system = String(request.system);
      const userContent = String(request.userContent);
      requests.push({ system, userContent });
      return system.includes('对话命名模型') ? '普通问候' : '普通回答。';
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

    const chatRequest = requests.find((request) =>
      request.system.includes('简单 Workflow'),
    );
    expect(chatRequest?.system).not.toContain('IRGraph 结构');
    expect(chatRequest?.userContent).not.toContain('IRGraph');
    expect(state.workflow.meta.simple).toBe(true);
    expect(session?.isWorkflow).toBe(false);
    expect(session?.runStatus).toBe('success');
    expect(record?.isWorkflow).toBe(false);
    expect(record?.workflow).toBeUndefined();
    expect(record?.meta?.runStatus).toBe('success');
  });

  it('does not inject asset generation routing for asset-center product rules', async () => {
    resetStore(simpleBlueprint('Simple chat'));
    mockDirectRoute();
    const systems: string[] = [];
    gatewayMocks.completeGatewayText.mockImplementation(async (request) => {
      systems.push(String(request.system));
      return '已定位资产中心规则。';
    });

    useStore
      .getState()
      .sendPrompt(
        '资产中心的内容不需要将用户发送的内容也展示出来，只展示AI生成、下载、修改后的资产',
      );

    await waitFor(
      () =>
        !useStore.getState().aiStreaming &&
        useStore.getState().messages.some((m) => m.role === 'assistant'),
      'asset-center simple chat reply',
    );

    expect(systems[0]).toContain('先判断用户当前真正意图');
    expect(systems[0]).not.toContain('【本应用内置生成渠道');
    expect(systems[0]).not.toContain('/image');
  });

  it.runIf(CLOUD_PROJECTS_ENABLED)('runs simple chat through a selected remote workspace runner', async () => {
    window.localStorage.clear();
    await historyStore.ready();
    const remotePath = remoteWorkspacePath('rw_test');
    const workspace = await historyStore.resolveWorkspaceByPath(remotePath);
    saveRemoteWorkspace(
      {
        id: 'rw_test',
        label: '测试 Runner',
        serverUrl: 'https://runner.test',
        projectId: 'proj_game',
        repoUrl: 'https://github.com/me/game.git',
        branch: 'main',
        adapter: 'codex',
        model: 'gpt-test',
        pushBranch: 'ugs/remote-job',
        useOwnModelKey: true,
      },
      {
        token: 'runner-token',
        apiKey: 'model-key',
        gitToken: 'git-token',
      },
    );
    const workflow = simpleBlueprint('远程会话');
    workflow.meta.gateway = {
      defaults: {
        adapter: 'codex',
        modelClass: 'gpt-5.1',
        modelOverride: 'gpt-5.1',
        providerId: remoteProviderId('rw_test', 'codex-main'),
        channelId: 'default',
      },
    };
    resetStore(workflow);
    useStore.setState({
      historyReady: true,
      activeWorkspaceId: workspace.id,
      workspaces: [workspace],
      sessions: [],
      sessionTree: { [workspace.id]: [] },
      activeSessionId: 's_remote',
      composer: {
        ...useStore.getState().composer,
        workspace: remotePath,
      },
      locale: 'zh-CN',
    });

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://runner.test/projects/proj_game') {
        return new Response(
          JSON.stringify({
            ok: true,
            project: {
              id: 'proj_game',
              label: '测试 Runner',
              repoUrl: 'https://github.com/me/game.git',
              branch: 'main',
              pushBranch: 'ugs/remote-job',
              adapter: 'codex',
              model: 'gpt-test',
              createdAt: 1,
              updatedAt: 2,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === 'https://runner.test/jobs') {
        expect(init?.method).toBe('POST');
        expect(init?.headers).toMatchObject({
          Authorization: 'Bearer runner-token',
          'content-type': 'application/json',
        });
        const body = JSON.parse(String(init?.body));
        expect(body.projectId).toBe('proj_game');
        expect(body.repoUrl).toBeUndefined();
        expect(body.adapter).toBe('codex');
        expect(body.model).toBe('gpt-5.1');
        expect(body.accountId).toBe('codex-main');
        expect(body.apiKey).toBe('model-key');
        expect(body.gitToken).toBeUndefined();
        expect(body.prompt).toContain('用户：修复远程 bug');
        return new Response(
          JSON.stringify({
            ok: true,
            job: {
              id: 'job_1',
              status: 'running',
              createdAt: 1,
              updatedAt: 1,
              projectId: body.projectId,
              repoUrl: 'https://github.com/me/game.git',
              branch: body.branch,
              adapter: body.adapter,
              model: body.model,
              prompt: body.prompt,
              pushBranch: body.pushBranch,
              logs: [],
              result: null,
              error: null,
            },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === 'https://runner.test/jobs/job_1/stream') {
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  [
                    'event: log',
                    'data: {"at":1,"phase":"model","stream":"stdout","text":"done"}',
                    '',
                    'event: status',
                    'data: "done"',
                    '',
                    'event: result',
                    'data: {"id":"job_1","status":"done","createdAt":1,"updatedAt":2,"repoUrl":"https://github.com/me/game.git","branch":"main","adapter":"codex","model":"gpt-test","prompt":"x","pushBranch":"ugs/remote-job","logs":[],"result":{"exitCode":0,"patch":"diff --git a/a b/a\\n+ok","usage":{"inputTokens":10,"outputTokens":5,"cachedInputTokens":2,"totalTokens":15,"calls":1}},"error":null}',
                    '',
                    '',
                  ].join('\n'),
                ),
              );
              controller.close();
            },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(useStore.getState().sendPrompt('修复远程 bug')).toBe(true);

    await waitFor(
      () =>
        !useStore.getState().aiStreaming &&
        useStore
          .getState()
          .messages.some((message) => message.text.includes('远程任务完成')),
      'remote runner completion',
    );

    const assistant = useStore
      .getState()
      .messages.find((message) => message.role === 'assistant');
    expect(assistant?.text).toContain('```diff');
    expect(assistant?.usage?.totalTokens).toBe(15);
    expect(gatewayMocks.completeGatewayText).not.toHaveBeenCalled();
    expect(tauriMocks.aiEditViaCli).not.toHaveBeenCalled();
  });

  it.runIf(CLOUD_PROJECTS_ENABLED)('uses the remote project model when the selected remote account has no model metadata', async () => {
    window.localStorage.clear();
    await historyStore.ready();
    const remotePath = remoteWorkspacePath('rw_no_model_metadata');
    const workspace = await historyStore.resolveWorkspaceByPath(remotePath);
    const providerId = remoteProviderId('rw_no_model_metadata', 'codex-server');
    saveRemoteWorkspace(
      {
        id: 'rw_no_model_metadata',
        label: '无模型元数据 Runner',
        serverUrl: 'https://runner.test',
        projectId: 'proj_game',
        repoUrl: 'https://github.com/me/game.git',
        adapter: 'codex',
        model: 'gpt-test',
        useOwnModelKey: false,
      },
      { token: 'runner-token' },
    );
    upsertProviders(
      [
        {
          id: providerId,
          kind: 'codex',
          name: '无模型元数据 Runner · Codex server key',
          apiKey: 'remote-runner',
          baseUrl: 'https://runner.test',
          transport: 'cli',
        },
      ],
      { makeActiveId: providerId },
    );
    const workflow = simpleBlueprint('远程模型兜底');
    workflow.meta.gateway = {
      defaults: {
        adapter: 'codex',
        modelClass: 'sonnet',
        modelOverride: 'sonnet',
        providerId,
        channelId: 'default',
      },
    };
    resetStore(workflow);
    useStore.setState({
      historyReady: true,
      activeWorkspaceId: workspace.id,
      workspaces: [workspace],
      sessions: [],
      sessionTree: { [workspace.id]: [] },
      activeSessionId: 's_remote_no_model_metadata',
      composer: {
        ...useStore.getState().composer,
        workspace: remotePath,
      },
      locale: 'zh-CN',
    });

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://runner.test/projects/proj_game') {
        return new Response(
          JSON.stringify({
            ok: true,
            project: {
              id: 'proj_game',
              label: '无模型元数据 Runner',
              repoUrl: 'https://github.com/me/game.git',
              branch: null,
              pushBranch: null,
              adapter: 'codex',
              model: 'gpt-test',
              createdAt: 1,
              updatedAt: 2,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === 'https://runner.test/jobs') {
        const body = JSON.parse(String(init?.body));
        expect(body.adapter).toBe('codex');
        expect(body.accountId).toBe('codex-server');
        expect(body.model).toBe('gpt-test');
        return new Response(
          JSON.stringify({
            ok: true,
            job: {
              id: 'job_project_model',
              status: 'running',
              createdAt: 1,
              updatedAt: 1,
              projectId: body.projectId,
              repoUrl: 'https://github.com/me/game.git',
              branch: body.branch,
              adapter: body.adapter,
              model: body.model,
              prompt: body.prompt,
              pushBranch: body.pushBranch,
              logs: [],
              result: null,
              error: null,
            },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === 'https://runner.test/jobs/job_project_model/stream') {
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  [
                    'event: status',
                    'data: "done"',
                    '',
                    'event: result',
                    'data: {"id":"job_project_model","status":"done","createdAt":1,"updatedAt":2,"repoUrl":"https://github.com/me/game.git","branch":null,"adapter":"codex","model":"gpt-test","prompt":"x","pushBranch":null,"logs":[],"result":{"exitCode":0},"error":null}',
                    '',
                    '',
                  ].join('\n'),
                ),
              );
              controller.close();
            },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(useStore.getState().sendPrompt('测试远程模型')).toBe(true);
    await waitFor(
      () =>
        !useStore.getState().aiStreaming &&
        useStore
          .getState()
          .messages.some((message) => message.text.includes('远程任务完成')),
      'remote runner project model fallback',
    );
  });

  it.runIf(CLOUD_PROJECTS_ENABLED)('does not send Claude tier aliases to a non-Claude remote runner account', async () => {
    window.localStorage.clear();
    await historyStore.ready();
    const remotePath = remoteWorkspacePath('rw_codex_sonnet_alias');
    const workspace = await historyStore.resolveWorkspaceByPath(remotePath);
    const providerId = remoteProviderId('rw_codex_sonnet_alias', 'codex-server');
    saveRemoteWorkspace(
      {
        id: 'rw_codex_sonnet_alias',
        label: 'Codex Runner',
        serverUrl: 'https://runner.test',
        projectId: 'proj_codex_sonnet_alias',
        repoUrl: 'https://github.com/me/game.git',
        adapter: 'codex',
        model: 'sonnet',
        useOwnModelKey: false,
      },
      { token: 'runner-token' },
    );
    upsertProviders(
      [
        {
          id: providerId,
          kind: 'codex',
          name: 'Codex Runner · RelayAI',
          apiKey: 'remote-runner',
          baseUrl: 'https://runner.test',
          transport: 'cli',
          model: 'gpt-5.5',
          models: ['gpt-5.5'],
        },
      ],
      { makeActiveId: providerId },
    );
    const workflow = simpleBlueprint('远程 Codex');
    workflow.meta.gateway = {
      defaults: {
        adapter: 'codex',
        modelClass: 'sonnet',
        modelOverride: 'sonnet',
        providerId,
        channelId: 'default',
      },
    };
    resetStore(workflow);
    useStore.setState({
      historyReady: true,
      activeWorkspaceId: workspace.id,
      workspaces: [workspace],
      sessions: [],
      sessionTree: { [workspace.id]: [] },
      activeSessionId: 's_remote_codex_sonnet_alias',
      composer: {
        ...useStore.getState().composer,
        workspace: remotePath,
      },
      locale: 'zh-CN',
    });

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://runner.test/projects/proj_codex_sonnet_alias') {
        return new Response(
          JSON.stringify({
            ok: true,
            project: {
              id: 'proj_codex_sonnet_alias',
              label: 'Codex Runner',
              repoUrl: 'https://github.com/me/game.git',
              branch: null,
              pushBranch: null,
              adapter: 'codex',
              model: 'sonnet',
              createdAt: 1,
              updatedAt: 2,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === 'https://runner.test/jobs') {
        const body = JSON.parse(String(init?.body));
        expect(body.adapter).toBe('codex');
        expect(body.accountId).toBe('codex-server');
        expect(body.model).toBe('gpt-5.5');
        return new Response(
          JSON.stringify({
            ok: true,
            job: {
              id: 'job_codex_model',
              status: 'running',
              createdAt: 1,
              updatedAt: 1,
              projectId: body.projectId,
              repoUrl: 'https://github.com/me/game.git',
              branch: body.branch,
              adapter: body.adapter,
              model: body.model,
              prompt: body.prompt,
              pushBranch: body.pushBranch,
              logs: [],
              result: null,
              error: null,
            },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === 'https://runner.test/jobs/job_codex_model/stream') {
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  [
                    'event: status',
                    'data: "done"',
                    '',
                    'event: result',
                    'data: {"id":"job_codex_model","status":"done","createdAt":1,"updatedAt":2,"repoUrl":"https://github.com/me/game.git","branch":null,"adapter":"codex","model":"gpt-5.5","prompt":"x","pushBranch":null,"logs":[],"result":{"exitCode":0},"error":null}',
                    '',
                    '',
                  ].join('\n'),
                ),
              );
              controller.close();
            },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(useStore.getState().sendPrompt('测试 RelayAI 远程模型')).toBe(true);
    await waitFor(
      () =>
        !useStore.getState().aiStreaming &&
        useStore
          .getState()
          .messages.some((message) => message.text.includes('远程任务完成')),
      'remote runner codex model alias fallback',
    );
  });

  it.runIf(CLOUD_PROJECTS_ENABLED)('does not send a claude-family model id to a codex remote runner account', async () => {
    window.localStorage.clear();
    await historyStore.ready();
    const remotePath = remoteWorkspacePath('rw_codex_claude_full');
    const workspace = await historyStore.resolveWorkspaceByPath(remotePath);
    const providerId = remoteProviderId('rw_codex_claude_full', 'codex-server');
    // 复现截图报错：云端项目默认模型是 claude-opus-4-8（Claude 家族全名），
    // 但选中的是 codex 账号。提交 job 时绝不能把该模型发给 codex 分组，
    // 否则后端报“分组 codex 下模型 claude-opus-4-8 无可用渠道”。
    saveRemoteWorkspace(
      {
        id: 'rw_codex_claude_full',
        label: 'Codex Runner',
        serverUrl: 'https://runner.test',
        projectId: 'proj_codex_claude_full',
        repoUrl: 'https://github.com/me/game.git',
        adapter: 'codex',
        model: 'claude-opus-4-8',
        useOwnModelKey: false,
      },
      { token: 'runner-token' },
    );
    upsertProviders(
      [
        {
          id: providerId,
          kind: 'codex',
          name: 'Codex Runner · server key',
          apiKey: 'remote-runner',
          baseUrl: 'https://runner.test',
          transport: 'cli',
          model: 'gpt-5.5',
          models: ['gpt-5.5'],
        },
      ],
      { makeActiveId: providerId },
    );
    const workflow = simpleBlueprint('远程 Codex 全名');
    workflow.meta.gateway = {
      defaults: {
        adapter: 'codex',
        modelClass: 'claude-opus-4-8',
        modelOverride: 'claude-opus-4-8',
        providerId,
        channelId: 'default',
      },
    };
    resetStore(workflow);
    useStore.setState({
      historyReady: true,
      activeWorkspaceId: workspace.id,
      workspaces: [workspace],
      sessions: [],
      sessionTree: { [workspace.id]: [] },
      activeSessionId: 's_remote_codex_claude_full',
      composer: {
        ...useStore.getState().composer,
        workspace: remotePath,
      },
      locale: 'zh-CN',
    });

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://runner.test/projects/proj_codex_claude_full') {
        return new Response(
          JSON.stringify({
            ok: true,
            project: {
              id: 'proj_codex_claude_full',
              label: 'Codex Runner',
              repoUrl: 'https://github.com/me/game.git',
              branch: null,
              pushBranch: null,
              adapter: 'codex',
              model: 'claude-opus-4-8',
              createdAt: 1,
              updatedAt: 2,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === 'https://runner.test/jobs') {
        const body = JSON.parse(String(init?.body));
        expect(body.adapter).toBe('codex');
        expect(body.accountId).toBe('codex-server');
        // 关键断言：codex 账号绝不能收到 claude 家族模型，应回落到账号模型。
        expect(body.model).toBe('gpt-5.5');
        expect(body.model).not.toBe('claude-opus-4-8');
        return new Response(
          JSON.stringify({
            ok: true,
            job: {
              id: 'job_codex_claude_full',
              status: 'running',
              createdAt: 1,
              updatedAt: 1,
              projectId: body.projectId,
              repoUrl: 'https://github.com/me/game.git',
              branch: body.branch,
              adapter: body.adapter,
              model: body.model,
              prompt: body.prompt,
              pushBranch: body.pushBranch,
              logs: [],
              result: null,
              error: null,
            },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === 'https://runner.test/jobs/job_codex_claude_full/stream') {
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  [
                    'event: status',
                    'data: "done"',
                    '',
                    'event: result',
                    'data: {"id":"job_codex_claude_full","status":"done","createdAt":1,"updatedAt":2,"repoUrl":"https://github.com/me/game.git","branch":null,"adapter":"codex","model":"gpt-5.5","prompt":"x","pushBranch":null,"logs":[],"result":{"exitCode":0},"error":null}',
                    '',
                    '',
                  ].join('\n'),
                ),
              );
              controller.close();
            },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(useStore.getState().sendPrompt('仓库更新到最新版')).toBe(true);
    await waitFor(
      () =>
        !useStore.getState().aiStreaming &&
        useStore
          .getState()
          .messages.some((message) => message.text.includes('远程任务完成')),
      'remote runner codex claude-family model fallback',
    );
  });

  it.runIf(CLOUD_PROJECTS_ENABLED)('keeps the remote runner assistant answer when no patch is produced', async () => {
    window.localStorage.clear();
    await historyStore.ready();
    const remotePath = remoteWorkspacePath('rw_answer');
    const workspace = await historyStore.resolveWorkspaceByPath(remotePath);
    saveRemoteWorkspace(
      {
        id: 'rw_answer',
        label: '回答 Runner',
        serverUrl: 'https://runner.test',
        adapter: 'codex',
        model: 'gpt-test',
        useOwnModelKey: false,
      },
      { token: 'runner-token' },
    );
    resetStore(simpleBlueprint('远程回答'));
    useStore.setState({
      historyReady: true,
      activeWorkspaceId: workspace.id,
      workspaces: [workspace],
      sessions: [],
      sessionTree: { [workspace.id]: [] },
      activeSessionId: 's_remote_answer',
      composer: {
        ...useStore.getState().composer,
        workspace: remotePath,
      },
      locale: 'zh-CN',
    });

    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://runner.test/jobs') {
        return new Response(
          JSON.stringify({
            ok: true,
            job: {
              id: 'job_answer',
              status: 'running',
              createdAt: 1,
              updatedAt: 1,
              repoUrl: null,
              branch: null,
              adapter: 'codex',
              model: 'gpt-test',
              prompt: 'x',
              pushBranch: null,
              logs: [],
              result: null,
              error: null,
            },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === 'https://runner.test/jobs/job_answer/stream') {
        const encoder = new TextEncoder();
        const answerEvent = JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: '我是 GPT-5。具体版本取决于当前模型配置。',
          },
        });
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  [
                    'event: log',
                    `data: {"at":1,"phase":"model","stream":"stdout","text":${JSON.stringify(answerEvent + '\n')}}`,
                    '',
                    'event: status',
                    'data: "done"',
                    '',
                    'event: result',
                    'data: {"id":"job_answer","status":"done","createdAt":1,"updatedAt":2,"repoUrl":null,"branch":null,"adapter":"codex","model":"gpt-test","prompt":"x","pushBranch":null,"logs":[],"result":{"exitCode":0},"error":null}',
                    '',
                    '',
                  ].join('\n'),
                ),
              );
              controller.close();
            },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(useStore.getState().sendPrompt('你是什么大模型')).toBe(true);

    await waitFor(
      () =>
        !useStore.getState().aiStreaming &&
        useStore
          .getState()
          .messages.some((message) => message.text.includes('我是 GPT-5')),
      'remote runner answer',
    );

    const assistant = useStore
      .getState()
      .messages.find((message) => message.role === 'assistant');
    expect(assistant?.text).toContain('远程任务完成');
    expect(assistant?.text).toContain('我是 GPT-5');
    expect(assistant?.text).not.toContain('```diff');
    expect(gatewayMocks.completeGatewayText).not.toHaveBeenCalled();
    expect(tauriMocks.aiEditViaCli).not.toHaveBeenCalled();
  });

  it.runIf(CLOUD_PROJECTS_ENABLED)('renders remote runner message events without parsing raw CLI logs', async () => {
    window.localStorage.clear();
    await historyStore.ready();
    const remotePath = remoteWorkspacePath('rw_message_event');
    const workspace = await historyStore.resolveWorkspaceByPath(remotePath);
    saveRemoteWorkspace(
      {
        id: 'rw_message_event',
        label: '消息 Runner',
        serverUrl: 'https://runner.test',
        adapter: 'codex',
        model: 'gpt-test',
        useOwnModelKey: false,
      },
      { token: 'runner-token' },
    );
    resetStore(simpleBlueprint('远程消息事件'));
    useStore.setState({
      historyReady: true,
      activeWorkspaceId: workspace.id,
      workspaces: [workspace],
      sessions: [],
      sessionTree: { [workspace.id]: [] },
      activeSessionId: 's_remote_message_event',
      composer: {
        ...useStore.getState().composer,
        workspace: remotePath,
      },
      locale: 'zh-CN',
    });

    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://runner.test/jobs') {
        return new Response(
          JSON.stringify({
            ok: true,
            job: {
              id: 'job_message_event',
              status: 'running',
              createdAt: 1,
              updatedAt: 1,
              repoUrl: null,
              branch: null,
              adapter: 'codex',
              model: 'gpt-test',
              prompt: 'x',
              pushBranch: null,
              logs: [],
              messages: [],
              result: null,
              error: null,
            },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === 'https://runner.test/jobs/job_message_event/stream') {
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  [
                    'event: message',
                    `data: ${JSON.stringify({
                      at: 1,
                      role: 'assistant',
                      kind: 'delta',
                      text:
                        encodeToolPatch({
                          id: 'remote-live-tool',
                          name: 'command_execution',
                          subject: 'cargo check',
                          status: 'running',
                        }) + '远程结构化回答',
                    })}`,
                    '',
                    'event: log',
                    'data: {"at":2,"phase":"git","stream":"stdout","text":"diff ready\\n"}',
                    '',
                    'event: status',
                    'data: "done"',
                    '',
                    'event: result',
                    'data: {"id":"job_message_event","status":"done","createdAt":1,"updatedAt":2,"repoUrl":null,"branch":null,"adapter":"codex","model":"gpt-test","prompt":"x","pushBranch":null,"logs":[],"messages":[],"result":{"exitCode":0},"error":null}',
                    '',
                    '',
                  ].join('\n'),
                ),
              );
              controller.close();
            },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(useStore.getState().sendPrompt('测试远程结构化消息')).toBe(true);

    await waitFor(
      () =>
        !useStore.getState().aiStreaming &&
        useStore
          .getState()
          .messages.some((message) => message.text.includes('远程结构化回答')),
      'remote runner message event answer',
    );

    const assistant = useStore
      .getState()
      .messages.find((message) => message.role === 'assistant');
    expect(assistant?.text).toContain('远程任务完成');
    expect(assistant?.text).toContain('远程结构化回答');
    expect(assistant?.text).not.toContain('diff ready');
    const tools = mergeToolPatches(
      extractToolSentinels(assistant?.text ?? '').patches,
    );
    expect(tools.find((tool) => tool.id === 'remote-live-tool')?.status).toBe(
      'done',
    );
    expect(gatewayMocks.completeGatewayText).not.toHaveBeenCalled();
    expect(tauriMocks.aiEditViaCli).not.toHaveBeenCalled();
  });

  it.runIf(CLOUD_PROJECTS_ENABLED)('hides remote runner protocol logs from the chat stream', async () => {
    window.localStorage.clear();
    await historyStore.ready();
    const remotePath = remoteWorkspacePath('rw_protocol');
    const workspace = await historyStore.resolveWorkspaceByPath(remotePath);
    saveRemoteWorkspace(
      {
        id: 'rw_protocol',
        label: '协议 Runner',
        serverUrl: 'https://runner.test',
        adapter: 'codex',
        model: 'gpt-test',
        useOwnModelKey: false,
      },
      { token: 'runner-token' },
    );
    resetStore(simpleBlueprint('远程协议'));
    useStore.setState({
      historyReady: true,
      activeWorkspaceId: workspace.id,
      workspaces: [workspace],
      sessions: [],
      sessionTree: { [workspace.id]: [] },
      activeSessionId: 's_remote_protocol',
      composer: {
        ...useStore.getState().composer,
        workspace: remotePath,
      },
      locale: 'zh-CN',
    });

    const streamRef: {
      controller: ReadableStreamDefaultController<Uint8Array> | null;
    } = { controller: null };
    const encoder = new TextEncoder();
    const send = (lines: string[]) => {
      streamRef.controller?.enqueue(encoder.encode(`${lines.join('\n')}\n\n`));
    };
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://runner.test/jobs') {
        return new Response(
          JSON.stringify({
            ok: true,
            job: {
              id: 'job_protocol',
              status: 'running',
              createdAt: 1,
              updatedAt: 1,
              repoUrl: null,
              branch: null,
              adapter: 'codex',
              model: 'gpt-test',
              prompt: 'x',
              pushBranch: null,
              logs: [],
              result: null,
              error: null,
            },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === 'https://runner.test/jobs/job_protocol/stream') {
        return new Response(
          new ReadableStream({
            start(controller) {
              streamRef.controller = controller;
            },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(useStore.getState().sendPrompt('你的路径在哪里')).toBe(true);
    await waitFor(
      () => fetchMock.mock.calls.some(([url]) => url === 'https://runner.test/jobs/job_protocol/stream'),
      'remote protocol stream connection',
    );

    const hookJson = JSON.stringify({
      type: 'system',
      subtype: 'hook_response',
      hook_name: 'SessionStart:startup',
      stdout: '(node:45364) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities',
    });
    send([
      'event: log',
      `data: ${JSON.stringify({
        at: 1,
        phase: 'model',
        stream: 'stdout',
        text: `${hookJson}\n`,
      })}`,
    ]);
    send([
      'event: log',
      `data: ${JSON.stringify({
        at: 2,
        phase: 'model',
        stream: 'stderr',
        text: '(node:45364) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities\n',
      })}`,
    ]);
    send([
      'event: log',
      `data: ${JSON.stringify({
        at: 3,
        phase: 'git',
        stream: 'stdout',
        text: 'workspace ready\n',
      })}`,
    ]);

    await waitFor(
      () =>
        useStore
          .getState()
          .messages.some((message) => message.text.includes('workspace ready')),
      'remote non-model log visible',
    );

    const liveAssistant = useStore
      .getState()
      .messages.find((message) => message.role === 'assistant');
    expect(liveAssistant?.text).toContain('workspace ready');
    expect(liveAssistant?.text).not.toContain('hook_response');
    expect(liveAssistant?.text).not.toContain('DeprecationWarning');

    const answerEvent = JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'agent_message',
        text: '路径在远程项目工作区。请看项目设置中的云端项目。',
      },
    });
    send([
      'event: log',
      `data: ${JSON.stringify({
        at: 4,
        phase: 'model',
        stream: 'stdout',
        text: `${answerEvent}\n`,
      })}`,
    ]);
    send(['event: status', 'data: "done"']);
    send([
      'event: result',
      'data: {"id":"job_protocol","status":"done","createdAt":1,"updatedAt":2,"repoUrl":null,"branch":null,"adapter":"codex","model":"gpt-test","prompt":"x","pushBranch":null,"logs":[],"result":{"exitCode":0},"error":null}',
    ]);
    streamRef.controller?.close();

    await waitFor(
      () =>
        !useStore.getState().aiStreaming &&
        useStore
          .getState()
          .messages.some((message) => message.text.includes('路径在远程项目工作区')),
      'remote protocol final answer',
    );

    const finalAssistant = useStore
      .getState()
      .messages.find((message) => message.role === 'assistant');
    expect(finalAssistant?.text).toContain('路径在远程项目工作区');
    expect(finalAssistant?.text).not.toContain('hook_response');
    expect(finalAssistant?.text).not.toContain('DeprecationWarning');
  });

  it.runIf(CLOUD_PROJECTS_ENABLED)('does not render remote protocol/template noise as a failed answer', async () => {
    window.localStorage.clear();
    await historyStore.ready();
    const remotePath = remoteWorkspacePath('rw_fail_noise');
    const workspace = await historyStore.resolveWorkspaceByPath(remotePath);
    saveRemoteWorkspace(
      {
        id: 'rw_fail_noise',
        label: '失败 Runner',
        serverUrl: 'https://runner.test',
        adapter: 'codex',
        model: 'gpt-test',
        useOwnModelKey: false,
      },
      { token: 'runner-token' },
    );
    resetStore(simpleBlueprint('远程失败'));
    useStore.setState({
      historyReady: true,
      activeWorkspaceId: workspace.id,
      workspaces: [workspace],
      sessions: [],
      sessionTree: { [workspace.id]: [] },
      activeSessionId: 's_remote_fail_noise',
      composer: {
        ...useStore.getState().composer,
        workspace: remotePath,
      },
      locale: 'zh-CN',
    });

    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://runner.test/jobs') {
        return new Response(
          JSON.stringify({
            ok: true,
            job: {
              id: 'job_fail_noise',
              status: 'running',
              createdAt: 1,
              updatedAt: 1,
              repoUrl: null,
              branch: null,
              adapter: 'codex',
              model: 'gpt-test',
              prompt: 'x',
              pushBranch: null,
              logs: [],
              result: null,
              error: null,
            },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === 'https://runner.test/jobs/job_fail_noise/stream') {
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  [
                    'event: log',
                    `data: ${JSON.stringify({
                      at: 1,
                      phase: 'model',
                      stream: 'stdout',
                      text:
                        '```markdown\\n' +
                        "remote://rw_fae76217/[s/S]*?: '.'}: ${phase}${stream}${text}\\n" +
                        '```\\n',
                    })}`,
                    '',
                    'event: status',
                    'data: "error"',
                    '',
                    'event: result',
                    'data: {"id":"job_fail_noise","status":"error","createdAt":1,"updatedAt":2,"repoUrl":null,"branch":null,"adapter":"codex","model":"gpt-test","prompt":"x","pushBranch":null,"logs":[],"result":{"exitCode":1},"error":"agent exited with code 1"}',
                    '',
                    '',
                  ].join('\n'),
                ),
              );
              controller.close();
            },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(useStore.getState().sendPrompt('失败输出不要乱')).toBe(true);

    await waitFor(
      () =>
        !useStore.getState().aiStreaming &&
        useStore
          .getState()
          .messages.some((message) => message.text.includes('远程任务失败')),
      'remote failure with noisy protocol output',
    );

    const assistant = useStore
      .getState()
      .messages.find((message) => message.role === 'assistant');
    expect(assistant?.text).toContain('错误：agent exited with code 1');
    expect(assistant?.text).not.toContain('remote://rw_fae76217');
    expect(assistant?.text).not.toContain('${phase}');
    expect(assistant?.text).not.toContain('```markdown');
  });

  it('injects asset generation routing for concrete asset creation requests', async () => {
    resetStore(simpleBlueprint('Simple chat'));
    mockDirectRoute();
    const systems: string[] = [];
    gatewayMocks.completeGatewayText.mockImplementation(async (request) => {
      systems.push(String(request.system));
      return '可使用 /image。';
    });

    useStore.getState().sendPrompt('帮我生成一张赛博朋克头像');

    await waitFor(
      () =>
        !useStore.getState().aiStreaming &&
        useStore.getState().messages.some((m) => m.role === 'assistant'),
      'image generation simple chat reply',
    );

    expect(systems[0]).toContain('【本应用内置生成渠道');
    expect(systems[0]).toContain('/image');
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

  it('refreshes simple-chat elapsed time while the model emits no events', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T06:00:00.000Z'));
    try {
      resetStore(simpleBlueprint('Simple chat'));
      mockDirectRoute();
      let resolveReply!: (value: string) => void;
      gatewayMocks.completeGatewayText.mockReturnValue(
        new Promise<string>((resolve) => {
          resolveReply = resolve;
        }),
      );

      expect(useStore.getState().sendPrompt('等待首个事件')).toBe(true);
      await vi.advanceTimersByTimeAsync(0);

      const runningText = () =>
        useStore
          .getState()
          .messages.find((message) => message.role === 'assistant')?.text ?? '';
      expect(runningText()).toContain('耗时 0s');

      await vi.advanceTimersByTimeAsync(2_100);
      expect(runningText()).toContain('耗时 2s');

      resolveReply('完成');
      await vi.advanceTimersByTimeAsync(0);
      expect(runningText()).toContain('完成');
    } finally {
      vi.useRealTimers();
    }
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
      () => useStore.getState().sessions[0]?.title === '新会话',
      'simple session history title',
    );

    const state = useStore.getState();
    const session = state.sessions[0];
    const record = await historyStore.getSession(workspace.id, session.id);

    expect(state.workflow.meta.simple).toBe(true);
    expect(state.workflow.meta.name).toBe('新会话');
    expect(session.title).toBe('新会话');
    expect(record?.title).toBe('新会话');
    expect(record?.workflow?.meta.name).toBe('新会话');
  });

  it('localizes the untitled session placeholder', () => {
    expect(simpleBlueprint(undefined, 'en-US').meta.name).toBe('New Session');
    expect(simpleBlueprint(undefined, 'ja-JP').meta.name).toBe('新規セッション');
    expect(simpleBlueprint(undefined, 'ko-KR').meta.name).toBe('새 세션');
  });

  it('auto-renames a new simple chat from the first user intent before the assistant reply finishes', async () => {
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
    const mainGate: { resolve?: (answer: string) => void } = {};
    gatewayMocks.completeGatewayText.mockImplementation((request) => {
      const system = String(request.system);
      const userContent = String(request.userContent);
      requests.push({ system, userContent });
      if (system.includes('对话命名模型')) {
        return Promise.resolve(
          userContent.includes('用户输入：') ? '早期意图标题' : '首轮总结标题',
        );
      }
      return new Promise<string>((resolve) => {
        mainGate.resolve = resolve;
      });
    });

    useStore.getState().sendPrompt('分析 Cherry Studio 话题标题怎么自动生成');

    await waitFor(
      () =>
        useStore.getState().sessions[0]?.title === '早期意图标题' &&
        useStore
          .getState()
          .messages.some((message) => message.text.includes('生成中')),
      'early generated session title',
    );

    const intentRequest = requests.find(
      (request) =>
        request.system.includes('对话命名模型') &&
        request.userContent.includes('用户输入：'),
    );
    expect(intentRequest?.userContent).toContain('分析 Cherry Studio');

    mainGate.resolve?.('Cherry 的做法是首轮后总结标题。');
    await waitFor(
      () => useStore.getState().sessions[0]?.title === '首轮总结标题',
      'summary generated session title',
    );

    const record = sessionId
      ? await historyStore.getSession(workspace.id, sessionId)
      : null;
    expect(record?.title).toBe('首轮总结标题');
  });

  it('starts early title naming on CLI-only simple chats via CLI route fallback', async () => {
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
    await waitFor(
      async () => {
        const sessionId = useStore.getState().activeSessionId;
        return !!(
          sessionId && (await historyStore.getSession(workspace.id, sessionId))
        );
      },
      'plain chat session persisted',
    );

    tauriMocks.isTauri.mockReturnValue(true);
    gatewayMocks.resolveDirectGatewayRoute.mockReturnValue(null);
    gatewayMocks.resolveCliGatewayRoute.mockResolvedValue({
      selection: { adapter: 'claude-code', modelClass: 'sonnet' },
      adapter: 'claude-code',
      modelClass: 'sonnet',
      model: 'glm-5.2',
      providerName: 'ExampleGLM5.2',
      channelName: 'glm-5.2',
      transport: 'cli',
      mode: 'cli',
      label: 'ExampleGLM5.2',
      source: 'global',
      cliCommand: 'claude',
    });
    const mainGate: { resolve?: (answer: string) => void } = {};
    tauriMocks.aiEditViaCli.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          mainGate.resolve = resolve;
        }),
    );
    gatewayMocks.completeGatewayText.mockResolvedValue('GLM总结标题');

    useStore.getState().sendPrompt('分析 ScreenLeak 全屏彩光是否开启');

    // Intent-phase title naming fires immediately (before the main CLI reply).
    await waitFor(
      () => gatewayMocks.completeGatewayText.mock.calls.length >= 1,
      'intent-phase title naming call',
    );
    await waitFor(
      () => tauriMocks.aiEditViaCli.mock.calls.length === 1,
      'main CLI chat call',
    );

    mainGate.resolve?.('ScreenLeak 没有开启，需要改 DefaultEngine.ini。');
    await waitFor(
      () => useStore.getState().sessions[0]?.title === 'GLM总结标题',
      'summary title after CLI reply',
    );
    // Wait for the summary-phase title naming call to land.
    await waitFor(
      () => gatewayMocks.completeGatewayText.mock.calls.length >= 2,
      'summary-phase title naming call',
    );

    // Both intent and summary phases called completeGatewayText.
    expect(gatewayMocks.completeGatewayText).toHaveBeenCalledTimes(2);
  });

  it('auto-renames a new simple chat after the first assistant reply', async () => {
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
      const system = String(request.system);
      const userContent = String(request.userContent);
      requests.push({ system, userContent });
      if (system.includes('对话命名模型')) {
        return userContent.includes('首轮助手回复')
          ? '自动话题命名'
          : '早期话题命名';
      }
      return 'Cherry 的做法是首轮后总结标题。';
    });

    useStore.getState().sendPrompt('分析 Cherry Studio 话题标题怎么自动生成');

    await waitFor(
      () =>
        requests.length >= 2 &&
        useStore.getState().sessions[0]?.title === '自动话题命名',
      'generated session title',
    );

    const record = sessionId
      ? await historyStore.getSession(workspace.id, sessionId)
      : null;
    const summaryRequest = requests.find(
      (request) =>
        request.system.includes('对话命名模型') &&
        request.userContent.includes('首轮助手回复'),
    );
    expect(summaryRequest?.userContent).toContain('首轮用户消息');
    expect(summaryRequest?.userContent).toContain('首轮助手回复');
    expect(record?.title).toBe('自动话题命名');
  });

  it('sends DeepSeek Harness a compact system prefix so the argv task survives', async () => {
    // dsh reads its task ONLY from an argv positional arg (no stdin) and, on
    // Windows, launches via `cmd /C dsh.cmd`, whose command line is capped at
    // ~8191 chars. The full chatSystem overflows that and truncates the TAIL —
    // the user's real request — so dsh must get a compact prefix, not the heavy
    // memory/game-expert/MCP blocks. Assert the real task is present and the
    // dsh-redundant heavy blocks are dropped.
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

    tauriMocks.isTauri.mockReturnValue(true);
    gatewayMocks.resolveDirectGatewayRoute.mockReturnValue(null);
    gatewayMocks.resolveCliGatewayRoute.mockResolvedValue({
      selection: { adapter: 'deepseek-harness', modelClass: 'default' },
      adapter: 'deepseek-harness',
      modelClass: 'default',
      model: 'deepseek-v4-pro',
      providerName: 'DeepSeek Harness',
      channelName: 'deepseek-v4-pro',
      transport: 'cli',
      mode: 'cli',
      label: 'DeepSeek Harness',
      source: 'global',
      cliCommand: 'dsh',
    });
    gatewayMocks.completeGatewayText.mockResolvedValue('标题');
    tauriMocks.aiEditViaCli.mockResolvedValue('已完成翻译。');

    const task = '请把这篇 PDF 翻译成中文并生成 md 文件';
    useStore.getState().sendPrompt(task);

    await waitFor(
      () => tauriMocks.aiEditViaCli.mock.calls.length >= 1,
      'dsh CLI chat call',
    );

    const [prompt, adapter] = tauriMocks.aiEditViaCli.mock.calls[0];
    expect(adapter).toBe('deepseek-harness');
    // The user's real request must be inside the argv payload.
    expect(String(prompt)).toContain(task);
    // Compact prefix keeps the core system + interaction protocol …
    expect(String(prompt)).toContain('简单 Workflow');
    // … but drops the dsh-redundant heavy blocks that would overflow argv.
    expect(String(prompt)).not.toContain('后台长任务');
  });

  it('injects the UGS_GEN auto-generation protocol into DeepSeek Harness prompts on asset turns', async () => {
    // dsh 用精简系统前缀；此前该前缀把「素材自动生成协议」也砍掉了，导致模型
    // 只会推荐 /image 让用户自己点，从不自动发生成块。用户本轮明确敲了素材
    // 命令（/image）时，协议必须随精简前缀一起到达 dsh。
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

    tauriMocks.isTauri.mockReturnValue(true);
    gatewayMocks.resolveDirectGatewayRoute.mockReturnValue(null);
    gatewayMocks.resolveCliGatewayRoute.mockResolvedValue({
      selection: { adapter: 'deepseek-harness', modelClass: 'default' },
      adapter: 'deepseek-harness',
      modelClass: 'default',
      model: 'deepseek-v4-pro',
      providerName: 'DeepSeek Harness',
      channelName: 'deepseek-v4-pro',
      transport: 'cli',
      mode: 'cli',
      label: 'DeepSeek Harness',
      source: 'global',
      cliCommand: 'dsh',
    });
    gatewayMocks.completeGatewayText.mockResolvedValue('标题');
    tauriMocks.aiEditViaCli.mockResolvedValue('已完成配图。');

    const task = '帮我配图，用 /image 出五张封面';
    useStore.getState().sendPrompt(task);

    await waitFor(
      () => tauriMocks.aiEditViaCli.mock.calls.length >= 1,
      'dsh CLI chat call',
    );

    const [prompt, adapter] = tauriMocks.aiEditViaCli.mock.calls[0];
    expect(adapter).toBe('deepseek-harness');
    // 用户敲了 /image → 本轮授权 image 渠道，协议必须出现在 dsh 系统提示里，
    // 模型才知道可以发 UGS_GEN 块由系统自动执行生成。
    expect(String(prompt)).toContain('素材自动生成协议');
    expect(String(prompt)).toContain('UGS_GEN');
  });

  it('keeps pasted image paths out of pending simple chat titles', async () => {
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
    const titleGate: { resolve?: (title: string) => void } = {};
    gatewayMocks.completeGatewayText.mockImplementation((request) => {
      const system = String(request.system);
      const userContent = String(request.userContent);
      if (
        system.includes('对话命名模型') &&
        userContent.includes('用户输入：')
      ) {
        return new Promise<string>((resolve) => {
          titleGate.resolve = resolve;
        });
      }
      if (system.includes('对话命名模型')) {
        return Promise.resolve('UE启动着色器崩溃');
      }
      return Promise.resolve('主回复完成。');
    });

    useStore
      .getState()
      .sendPrompt(
        '`E:\\UltraGameStudio\\.ultragamestudio\\clipboard-images\\pasted-1783578658027-52db4c04aa12e57d-0.png`，这里的失败是因为什么，好像我不应该失败才对，是因为超时吗，还是什么原因',
      );

    await waitFor(
      () => useStore.getState().sessions[0]?.title?.startsWith('这里的失败'),
      'sanitized pending session title',
    );

    const pendingTitle = useStore.getState().sessions[0]?.title ?? '';
    expect(pendingTitle).not.toContain('clipboard-images');
    expect(pendingTitle).not.toContain('UltraGameStudio');

    await waitFor(() => !!titleGate.resolve, 'title naming request');
    titleGate.resolve?.('UE启动着色器崩溃');

    await waitFor(
      () => useStore.getState().sessions[0]?.title === 'UE启动着色器崩溃',
      'generated session title',
    );

    const record = sessionId
      ? await historyStore.getSession(workspace.id, sessionId)
      : null;
    expect(record?.title).toBe('UE启动着色器崩溃');
  });

  it('auto-renames image-only first turns from image context and reply', async () => {
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
    tauriMocks.isTauri.mockReturnValue(true);
    tauriMocks.previewLocalFile.mockResolvedValue({
      path: 'E:\\UltraGameStudio\\.ultragamestudio\\clipboard-images\\pasted-1.png',
      fileName: 'pasted-1.png',
      kind: 'image',
      mime: 'image/png',
      sizeBytes: 3,
      truncated: false,
      text: null,
      base64: 'AQID',
    });

    const requests: Array<{
      system: string;
      userContent: string;
      userImages?: string[];
    }> = [];
    gatewayMocks.completeGatewayText.mockImplementation(async (request) => {
      const system = String(request.system);
      const userContent = String(request.userContent);
      requests.push({
        system,
        userContent,
        userImages: request.userImages,
      });
      if (system.includes('对话命名模型')) {
        return userContent.includes('首轮助手回复')
          ? '启动崩溃截图'
          : '截图问题分析';
      }
      return '截图里是 UE 启动时 ShaderCompileWorker 崩溃。';
    });

    useStore
      .getState()
      .sendPrompt(
        '`E:\\UltraGameStudio\\.ultragamestudio\\clipboard-images\\pasted-1.png`',
      );

    await waitFor(
      () => useStore.getState().sessions[0]?.title === '启动崩溃截图',
      'image-only generated session title',
    );

    const titleRequests = requests.filter((request) =>
      request.system.includes('对话命名模型'),
    );
    const intentRequest = titleRequests.find((request) =>
      request.userContent.includes('用户输入：'),
    );
    expect(intentRequest?.userContent).toContain('用户只上传了图片或截图');
    expect(intentRequest?.userContent).toContain('用户附加图片：1 张图片或截图');
    expect(intentRequest?.userContent).not.toContain('pasted-1.png');
    expect(intentRequest?.userContent).not.toContain('clipboard-images');
    expect(intentRequest?.userImages).toEqual(['data:image/png;base64,AQID']);

    const record = sessionId
      ? await historyStore.getSession(workspace.id, sessionId)
      : null;
    expect(record?.title).toBe('启动崩溃截图');
  });

  it('does not overwrite a manual rename while title naming is in flight', async () => {
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
    const titleResolvers: Array<(title: string) => void> = [];
    gatewayMocks.completeGatewayText.mockImplementation((request) => {
      if (String(request.system).includes('对话命名模型')) {
        return new Promise<string>((resolve) => {
          titleResolvers.push(resolve);
        });
      }
      return Promise.resolve('首轮回答已经完成。');
    });

    useStore.getState().sendPrompt('给这个新会话起个更短标题');

    await waitFor(
      () => titleResolvers.length >= 2,
      'title naming request',
    );
    await useStore
      .getState()
      .renameWorkflowSession(sessionId ?? '', workspace.id, '手动标题');

    for (const resolveTitle of titleResolvers) {
      resolveTitle('模型标题');
    }
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const record = sessionId
      ? await historyStore.getSession(workspace.id, sessionId)
      : null;
    expect(useStore.getState().sessions[0]?.title).toBe('手动标题');
    expect(record?.title).toBe('手动标题');
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

  it('stamps direct simple-chat usage from the gateway usage callback', async () => {
    resetStore(simpleBlueprint('Simple chat'));
    mockDirectRoute();
    gatewayMocks.completeGatewayText.mockImplementation(async (request) => {
      request.onUsage?.({
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        cacheReadInputTokens: 40,
      });
      return '带 usage 的回答。';
    });

    useStore.getState().sendPrompt('测试 direct usage 回填');

    await waitFor(
      () =>
        !useStore.getState().aiStreaming &&
        useStore.getState().messages.some((m) => m.role === 'assistant'),
      'direct usage simple chat reply',
    );

    const assistant = useStore
      .getState()
      .messages.find((m) => m.role === 'assistant');
    expect(assistant?.usage?.inputTokens).toBe(100);
    expect(assistant?.usage?.outputTokens).toBe(20);
    expect(assistant?.usage?.totalTokens).toBe(120);
    expect(assistant?.usage?.cachedInputTokens).toBe(40);
    expect(assistant?.usage?.cachePercent).toBe(40);
    expect(assistant?.usage?.estimated).toBe(false);
  });

  it('stamps estimated direct simple-chat usage when the gateway has no usage callback data', async () => {
    resetStore(simpleBlueprint('Simple chat'));
    mockDirectRoute();
    gatewayMocks.completeGatewayText.mockResolvedValue('没有 usage 回调的回答。');

    useStore.getState().sendPrompt('测试 direct usage 估算回填');

    await waitFor(
      () =>
        !useStore.getState().aiStreaming &&
        useStore.getState().messages.some((m) => m.role === 'assistant'),
      'estimated direct usage simple chat reply',
    );

    const assistant = useStore
      .getState()
      .messages.find((m) => m.role === 'assistant');
    expect(assistant?.usage?.totalTokens).toBeGreaterThan(0);
    expect(assistant?.usage?.cachedInputTokens).toBe(0);
    expect(assistant?.usage?.cachePercent).toBe(0);
    expect(assistant?.usage?.estimated).toBe(true);
  });

  it('stamps CLI simple-chat usage even when the session usage meter cannot persist', async () => {
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
    const originalSetItem = window.localStorage.setItem.bind(window.localStorage);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key, value) => {
      if (key === 'ugs_usage_meter_by_session_v1') {
        throw new Error('quota exceeded');
      }
      return originalSetItem(key, value);
    });
    tauriMocks.aiEditViaCli.mockImplementation(async (_prompt, _adapter, opts) => {
      opts.onUsage?.({
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 40,
      });
      return '带 CLI usage 的回答。';
    });

    useStore.getState().sendPrompt('测试 CLI usage 回填');

    await waitFor(
      () =>
        !useStore.getState().aiStreaming &&
        useStore
          .getState()
          .messages.some((m) => m.role === 'assistant' && m.text.includes('CLI usage')),
      'CLI usage simple chat reply',
    );

    const assistant = useStore
      .getState()
      .messages.find((m) => m.role === 'assistant' && m.text.includes('CLI usage'));
    expect(assistant?.usage?.inputTokens).toBe(140);
    expect(assistant?.usage?.outputTokens).toBe(20);
    expect(assistant?.usage?.totalTokens).toBe(160);
    expect(assistant?.usage?.cachedInputTokens).toBe(40);
    expect(assistant?.usage?.cachePercent).toBeCloseTo(28.57, 2);
    expect(assistant?.usage?.estimated).toBe(false);
  });

  it('keeps simple-chat interaction widgets visible while waiting for input', async () => {
    resetStore(simpleBlueprint('Simple chat'));
    mockDirectRoute();
    const requests: Array<{ system: string; userContent: string }> = [];
    gatewayMocks.completeGatewayText.mockImplementation(async (request) => {
      requests.push({
        system: String(request.system),
        userContent: String(request.userContent),
      });
      if (requests.length === 1) {
        return [
          '<<UGS_ASK>>',
          JSON.stringify({
            type: 'select',
            prompt: '要继续连接远程服务器吗？',
            options: ['继续连接', '先停止'],
            multi: false,
          }),
          '<<UGS_ASK_END>>',
        ].join('\n');
      }
      return '已按你的选择继续处理。';
    });

    useStore.getState().sendPrompt('帮我配置远程服务器');

    await waitFor(
      () =>
        useStore
          .getState()
          .messages.some(
            (message) =>
              message.interaction?.prompt === '要继续连接远程服务器吗？' &&
              message.interactionStatus === 'pending',
          ),
      'simple chat interaction widget',
    );

    expect(useStore.getState().waitingInputSessions).toHaveLength(1);
    const waitingSessionKey = useStore.getState().waitingInputSessions[0]!;
    const interactionMessage = useStore
      .getState()
      .messages.find((message) => message.interaction);
    expect(interactionMessage?.text).toBe('要继续连接远程服务器吗？');
    await waitFor(
      () =>
        notificationMocks.notifySessionComplete.mock.calls.some(
          ([input]) => input.status === 'waitingInput',
        ),
      'waiting-input notification',
    );
    expect(notificationMocks.notifySessionComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'waitingInput',
        sessionTitle: 'Simple chat',
        detail: '要继续连接远程服务器吗？',
      }),
    );

    useStore.getState().answerInteraction(interactionMessage!.id, {
      kind: 'select',
      values: ['继续连接'],
    });

    await waitFor(
      () =>
        !useStore.getState().aiStreaming &&
        useStore
          .getState()
          .messages.some((message) =>
            message.text.includes('已按你的选择继续处理。'),
          ),
      'simple chat final answer after interaction',
    );

    expect(gatewayMocks.completeGatewayText).toHaveBeenCalledTimes(2);
    expect(requests[1].userContent).toContain('用户的回答：继续连接');
    expect(useStore.getState().waitingInputSessions).toHaveLength(0);
    expect(
      notificationMocks.dismissSessionWaitingInputNotification,
    ).toHaveBeenCalledWith({
      workspaceId: waitingSessionKey.workspaceId ?? null,
      sessionId: waitingSessionKey.sessionId ?? null,
    });
  });

  it('keeps a queued task below interaction continuation until the task starts', async () => {
    resetStore(simpleBlueprint('Simple chat'));
    mockDirectRoute();
    let askQuestion!: (value: string) => void;
    let finishContinuation!: (value: string) => void;
    gatewayMocks.completeGatewayText.mockImplementation(async () => {
      const call = gatewayMocks.completeGatewayText.mock.calls.length;
      if (call === 1) return await new Promise<string>((resolve) => { askQuestion = resolve; });
      if (call === 2) return await new Promise<string>((resolve) => { finishContinuation = resolve; });
      return '排队任务已完成';
    });
    useStore.getState().sendPrompt('先执行需要选择的任务');
    await waitFor(() => gatewayMocks.completeGatewayText.mock.calls.length === 1, 'first task');
    useStore.getState().sendPrompt('后续排队任务');
    await waitFor(() => {
      const state = useStore.getState();
      return state.queuedChatMessageIds.length === 1 && state.messages.some((m) =>
        m.id === state.queuedChatMessageIds[0] && m.text === '后续排队任务');
    }, 'queued task');
    const queuedId = useStore.getState().queuedChatMessageIds[0];
    askQuestion('<<UGS_ASK>>\n{"type":"select","prompt":"选择处理方式","options":["继续"],"multi":false}\n<<UGS_ASK_END>>');
    await waitFor(() => useStore.getState().messages.some((m) => m.interactionStatus === 'pending'), 'interaction');
    const question = useStore.getState().messages.find((m) => m.interactionStatus === 'pending')!;
    useStore.getState().answerInteraction(question.id, { kind: 'select', values: ['继续'] });
    await waitFor(() => gatewayMocks.completeGatewayText.mock.calls.length === 2, 'continuation');
    const state = useStore.getState();
    expect(state.queuedChatMessageIds).toEqual([queuedId]);
    const visible = orderDisplayMessages(state.messages, state.queuedChatMessageIds);
    expect(visible.at(-1)?.id).toBe(queuedId);
    expect(visible.at(-2)?.role).toBe('assistant');
    expect(visible.find((m) => m.id === question.id)?.interactionStatus).toBe('answered');
    finishContinuation('选择后的续答已完成');
    await waitFor(() => !useStore.getState().aiStreaming && useStore.getState().messages.some((m) => m.text.includes('排队任务已完成')), 'FIFO completion');
    expect(useStore.getState().queuedChatMessageIds).toEqual([]);
    expect(gatewayMocks.completeGatewayText).toHaveBeenCalledTimes(3);
  });

  it('does not pause simple chat on an unterminated interaction block', async () => {
    resetStore(simpleBlueprint('Simple chat'));
    mockDirectRoute();
    gatewayMocks.completeGatewayText.mockResolvedValue(
      [
        '我需要确认一件事：',
        '<<UGS_ASK>>',
        JSON.stringify({
          type: 'confirm',
          prompt: '要不要我直接动手改那三处代码？',
          confirmLabel: '直接改',
          cancelLabel: '先别改',
        }),
      ].join('\n'),
    );

    useStore.getState().sendPrompt('分析会话为什么突然停了');

    await waitFor(
      () =>
        !useStore.getState().aiStreaming &&
        useStore
          .getState()
          .messages.some((message) =>
            message.text.includes('要不要我直接动手改那三处代码？'),
          ),
      'unterminated interaction reply to finalize as text',
    );

    expect(
      useStore.getState().messages.some((message) => message.interaction),
    ).toBe(false);
    expect(useStore.getState().waitingInputSessions).toHaveLength(0);
    expect(notificationMocks.notifySessionComplete).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'waitingInput' }),
    );
    expect(gatewayMocks.completeGatewayText).toHaveBeenCalledTimes(1);
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

  it('downgrades a Kimi base URL to text mode when the session references a document', async () => {
    // Kimi 等非 Anthropic 原生上游不认识 Claude 的 `document` block：claude CLI
    // `--resume` 重放历史（含 PDF/Office 附件产生的 document 块）会直接 400。
    // 因此当会话确实引用了文档文件时，指向非 api.anthropic.com 的 claude-code
    // CLI 渠道必须降级为每轮纯文本全量模式（不传 sessionId/resume）。
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
      model: 'kimi-for-coding',
      transport: 'cli',
      mode: 'cli',
      label: 'Claude Code · Kimi',
      source: 'global',
      cliCommand: 'claude',
      env: {
        ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding/',
        ANTHROPIC_MODEL: 'kimi-for-coding',
      },
    }));
    const calls: Array<{
      prompt: string;
      opts: { sessionId?: string; resume?: boolean };
    }> = [];
    tauriMocks.aiEditViaCli.mockImplementation(async (prompt, _adapter, opts) => {
      calls.push({ prompt, opts });
      return calls.length === 1 ? 'Kimi 回答一。' : 'Kimi 回答二。';
    });

    useStore.getState().sendPrompt('请看这个 E:\\docs\\report.pdf 第一问');
    await waitFor(
      () => !useStore.getState().aiStreaming && calls.length === 1,
      'first Kimi CLI chat call',
    );

    useStore.getState().sendPrompt('第二问');
    await waitFor(
      () => !useStore.getState().aiStreaming && calls.length === 2,
      'second Kimi CLI chat call',
    );

    expect(calls[0].opts.sessionId).toBeUndefined();
    expect(calls[0].opts.resume).toBeUndefined();
    expect(calls[1].opts.sessionId).toBeUndefined();
    expect(calls[1].opts.resume).toBeUndefined();
    // 第二轮携带完整文本历史（全量模式）而非增量。
    expect(calls[1].prompt).toContain('之前的对话');
    expect(calls[1].prompt).toContain('第一问');
    expect(calls[1].prompt).toContain('Kimi 回答一。');
  });

  it('keeps native Claude session resume for a Kimi base URL when the session has only images/text', async () => {
    // 图片是 Anthropic `image` block、非 `document` block，第三方上游不会 400。
    // 因此纯图片/纯文本会话即使跑在 Kimi 网关上也应保留 --resume 续接，享受
    // 增量续接（第二轮 resume=true），而不是被一刀切降级。回归 Bug 1。
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
      model: 'kimi-for-coding',
      transport: 'cli',
      mode: 'cli',
      label: 'Claude Code · Kimi',
      source: 'global',
      cliCommand: 'claude',
      env: {
        ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding/',
        ANTHROPIC_MODEL: 'kimi-for-coding',
      },
    }));
    const calls: Array<{
      prompt: string;
      opts: { sessionId?: string; resume?: boolean };
    }> = [];
    tauriMocks.aiEditViaCli.mockImplementation(async (prompt, _adapter, opts) => {
      calls.push({ prompt, opts });
      return calls.length === 1 ? 'Kimi 回答一。' : 'Kimi 回答二。';
    });

    useStore.getState().sendPrompt('请看这张图 E:\\shots\\frame.jpg 第一问');
    await waitFor(
      () => !useStore.getState().aiStreaming && calls.length === 1,
      'first Kimi image CLI chat call',
    );

    useStore.getState().sendPrompt('第二问');
    await waitFor(
      () => !useStore.getState().aiStreaming && calls.length === 2,
      'second Kimi image CLI chat call',
    );

    // 首轮冷起 native session，续轮走 --resume 增量续接。
    expect(calls[0].opts.sessionId).toBeTruthy();
    expect(calls[0].opts.resume).toBe(false);
    expect(calls[1].opts.sessionId).toBe(calls[0].opts.sessionId);
    expect(calls[1].opts.resume).toBe(true);
  });

  it('re-sends full history on a CLI continuation round when native session is disabled', async () => {
    // 会话含文档 → Kimi 网关禁用 native session（sessionId/resume 皆无）。此时
    // 模型无状态，续答轮（回答一个 <<UGS_ASK>> select）必须自带完整历史，否则
    // 只发「问题+回答」两行会让模型忘掉上文、重复提问。回归 Bug 2。
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
      model: 'kimi-for-coding',
      transport: 'cli',
      mode: 'cli',
      label: 'Claude Code · Kimi',
      source: 'global',
      cliCommand: 'claude',
      env: {
        ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding/',
        ANTHROPIC_MODEL: 'kimi-for-coding',
      },
    }));
    const calls: Array<{
      prompt: string;
      opts: { sessionId?: string; resume?: boolean };
    }> = [];
    tauriMocks.aiEditViaCli.mockImplementation(async (prompt, _adapter, opts) => {
      calls.push({ prompt, opts });
      if (calls.length === 1) {
        return [
          '<<UGS_ASK>>',
          JSON.stringify({
            type: 'select',
            prompt: '这是哪种包围盒？',
            options: ['Local Light Shadow Cache', '其它'],
            multi: false,
          }),
          '<<UGS_ASK_END>>',
        ].join('\n');
      }
      return '明白了，就按 Local Light Shadow Cache 处理。';
    });

    useStore.getState().sendPrompt('看这个附件 E:\\docs\\spec.pdf 里的包围盒');
    await waitFor(
      () =>
        useStore
          .getState()
          .messages.some(
            (message) =>
              message.interaction?.prompt === '这是哪种包围盒？' &&
              message.interactionStatus === 'pending',
          ),
      'CLI interaction widget',
    );

    const interactionMessage = useStore
      .getState()
      .messages.find((message) => message.interaction);
    useStore.getState().answerInteraction(interactionMessage!.id, {
      kind: 'select',
      values: ['Local Light Shadow Cache'],
    });

    await waitFor(
      () => !useStore.getState().aiStreaming && calls.length === 2,
      'CLI continuation call after interaction',
    );

    // native session 被禁用：两轮都不带 sessionId/resume。
    expect(calls[0].opts.sessionId).toBeUndefined();
    expect(calls[1].opts.sessionId).toBeUndefined();
    // 续答轮既带用户的选择，又带完整原始历史（Bug 2 的核心断言）。
    expect(calls[1].prompt).toContain('Local Light Shadow Cache');
    expect(calls[1].prompt).toContain('包围盒');
    expect(calls[1].prompt).toContain('这是哪种包围盒？');
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

  it('mints a fresh native session when claude exits 0 without any reply', async () => {
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
          'CLI "claude" 未产生任何回复就退出（退出码 0）：CLI 退出但未返回任何内容',
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
      'empty-exit fallback CLI chat call',
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

  it('retries once when a stateless CLI call exits 0 without any reply', async () => {
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
      model: 'kimi-for-coding',
      transport: 'cli',
      mode: 'cli',
      label: 'Claude Code · Kimi',
      source: 'global',
      cliCommand: 'claude',
      env: {
        ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding/',
        ANTHROPIC_MODEL: 'kimi-for-coding',
      },
    }));
    const calls: Array<{
      prompt: string;
      opts: { sessionId?: string; resume?: boolean };
    }> = [];
    tauriMocks.aiEditViaCli.mockImplementation(async (prompt, _adapter, opts) => {
      calls.push({ prompt, opts });
      if (calls.length === 1) {
        throw new Error(
          'CLI "claude" 未产生任何回复就退出（退出码 0）：CLI 退出但未返回任何内容',
        );
      }
      return '重试后的回答。';
    });

    useStore.getState().sendPrompt('看这个附件 E:\\docs\\spec.pdf 第一问');
    await waitFor(
      () => !useStore.getState().aiStreaming && calls.length === 2,
      'stateless empty-exit CLI retry call',
    );

    // 会话含文档 → 非 Anthropic 原生上游不会走 native session：两轮都是无会话全量调用。
    expect(calls[0].opts.sessionId).toBeUndefined();
    expect(calls[0].opts.resume).toBeUndefined();
    expect(calls[1].opts.sessionId).toBeUndefined();
    expect(calls[1].opts.resume).toBeUndefined();
    expect(calls[1].prompt).toBe(calls[0].prompt);
    expect(
      useStore
        .getState()
        .messages.some(
          (m) => m.role === 'assistant' && m.text.includes('重试后的回答。'),
        ),
    ).toBe(true);
  });

  it('mints a fresh native session when claude rejects the id as already in use', async () => {
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
      // The very first create collides with a stale, still-locked id that a
      // prior (unclean) turn registered on disk.
      if (calls.length === 1) {
        throw new Error(
          `CLI "claude" 退出码 1: Error: Session ID ${opts.sessionId} is already in use.`,
        );
      }
      return '换了新会话后的回答。';
    });

    useStore.getState().sendPrompt('第一轮问题');
    await waitFor(
      () => !useStore.getState().aiStreaming && calls.length === 2,
      'already-in-use fallback CLI chat call',
    );

    // First attempt creates (resume=false); the collision triggers a fresh id,
    // also created cold rather than resumed.
    expect(calls[0].opts.resume).toBe(false);
    expect(calls[0].opts.sessionId).toEqual(expect.any(String));
    expect(calls[1].opts.resume).toBe(false);
    expect(calls[1].opts.sessionId).toEqual(expect.any(String));
    expect(calls[1].opts.sessionId).not.toBe(calls[0].opts.sessionId);
    expect(calls[1].prompt).toContain('第一轮问题');
    expect(
      useStore
        .getState()
        .messages.some(
          (m) =>
            m.role === 'assistant' && m.text.includes('换了新会话后的回答。'),
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

    await waitFor(() => typeof resolveReply === 'function', 'gateway call to start');
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

  it('resumes the same native Claude session after an interrupted turn', async () => {
    window.localStorage.clear();
    await historyStore.ready();
    const workspace = await historyStore.resolveWorkspaceByPath('');
    const record = await historyStore.createSession({
      workspaceId: workspace.id,
      isWorkflow: false,
      messages: [],
      title: 'Chat',
    });
    resetStore(simpleBlueprint('Simple chat'));
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
      opts: {
        sessionId?: string;
        resume?: boolean;
        onProgress?: (chunk: string) => void;
      };
    }> = [];
    let rejectFirst!: (reason: unknown) => void;
    tauriMocks.aiEditViaCli.mockImplementation((prompt, _adapter, opts) => {
      calls.push({ prompt, opts });
      if (calls.length === 1) {
        opts.onProgress?.('正在编译引擎。');
        return new Promise<string>((_resolve, reject) => {
          rejectFirst = reject;
        });
      }
      return Promise.resolve('已按新约束继续编译。');
    });
    tauriMocks.cancelAiCli.mockImplementation(async () => {
      rejectFirst(new DOMException('Aborted', 'AbortError'));
    });

    useStore.getState().sendPrompt('用 Rider MCP + UBA 编译引擎直到成功');
    await waitFor(() => calls.length === 1, 'first Claude turn');
    useStore.getState().stopChat();
    await waitFor(
      () => tauriMocks.cancelAiCli.mock.calls.length === 1,
      'Claude turn cancellation',
    );

    useStore.getState().sendPrompt('不要改代码');
    await waitFor(
      () => !useStore.getState().aiStreaming && calls.length === 2,
      'interrupted Claude continuation',
    );

    expect(calls[1].opts.sessionId).toBe(calls[0].opts.sessionId);
    expect(calls[1].opts.resume).toBe(true);
    expect(calls[1].prompt).toContain('上一轮任务被用户中断且尚未完成');
    expect(calls[1].prompt).toContain('不要改代码');
    expect(calls[1].prompt).not.toContain('会话已中断');
    expect(
      useStore.getState().messages.some((message) =>
        message.text.includes('调用失败'),
      ),
    ).toBe(false);
  });

  it('replays the unfinished goal after interrupting a stateless direct turn', async () => {
    resetStore(simpleBlueprint('Simple chat'));
    mockDirectRoute();
    const userContents: string[] = [];
    gatewayMocks.completeGatewayText.mockImplementation(
      async (request) => {
        userContents.push(String(request.userContent));
        if (userContents.length > 1) return '已在新约束下继续原任务。';
        request.onDelta?.('正在编译引擎。');
        return await new Promise<string>((_resolve, reject) => {
          request.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      },
    );

    useStore.getState().sendPrompt('用 Rider MCP + UBA 编译引擎直到成功');
    await waitFor(() => userContents.length === 1, 'first direct turn');
    useStore.getState().stopChat();
    useStore.getState().sendPrompt('不要改代码');
    await waitFor(
      () => !useStore.getState().aiStreaming && userContents.length === 2,
      'interrupted direct continuation',
    );

    expect(userContents[1]).toContain('上一轮任务被用户中断且尚未完成');
    expect(userContents[1]).toContain('用 Rider MCP + UBA 编译引擎直到成功');
    expect(userContents[1]).toContain('不要改代码');
    expect(userContents[1]).not.toContain('会话已中断');
    expect(
      useStore.getState().messages.some((message) =>
        message.text.includes('调用失败'),
      ),
    ).toBe(false);
  });

  it('keeps a Codex follow-up queued until the lightning action steers it into the active turn', async () => {
    resetStore(simpleBlueprint('Simple chat'));
    useStore.setState({ messages: [{
      id: 'old-skill-card', role: 'assistant', text: '', createdAt: 1, localOnly: true,
    }] });
    tauriMocks.isTauri.mockReturnValue(true);
    tauriMocks.tauriAvailable.mockReturnValue(true);
    gatewayMocks.resolveDirectGatewayRoute.mockReturnValue(null);
    gatewayMocks.resolveCliGatewayRoute.mockResolvedValue({
      selection: { adapter: 'codex', modelClass: 'codex' },
      adapter: 'codex',
      modelClass: 'codex',
      model: 'gpt-5.4',
      transport: 'cli',
      mode: 'cli',
      label: 'Codex',
      source: 'fallback',
      cliCommand: 'codex',
    });
    let resolveTurn!: (value: string) => void;
    tauriMocks.aiEditViaCli.mockImplementation(
      async () =>
        await new Promise<string>((resolve) => {
          resolveTurn = resolve;
        }),
    );
    let resolveSteer!: (value: boolean) => void;
    tauriMocks.steerAiCli.mockImplementation(
      async () =>
        await new Promise<boolean>((resolve) => {
          resolveSteer = resolve;
        }),
    );

    useStore.getState().sendPrompt('先检查项目');
    await waitFor(
      () => tauriMocks.aiEditViaCli.mock.calls.length === 1,
      'Codex turn to start',
    );
    const runId = tauriMocks.aiEditViaCli.mock.calls[0]?.[2]?.runId;

    // Reproduce real history: persistence has stamped completedAt while the
    // native CLI is still running, and an old local card has no completedAt.
    const channel = [...activeAiEdits.values()].find((ch) => ch.activeAssistantMessageId);
    expect(channel).toBeDefined();
    aiEditCommitMessages(channel!, true);
    const replyId = channel!.activeAssistantMessageId!;
    expect(useStore.getState().messages.find((m) => m.id === replyId)?.completedAt).toBeDefined();

    useStore.getState().sendPrompt('补充：也检查测试');
    await waitFor(
      () => useStore.getState().queuedChatMessageIds.length === 1,
      'Codex follow-up to enter the queue',
    );
    expect(tauriMocks.steerAiCli).not.toHaveBeenCalled();

    const queuedId = useStore.getState().queuedChatMessageIds[0];
    expect(useStore.getState().steerableQueuedChatMessageIds).toEqual([queuedId]);
    expect(useStore.getState().steerQueuedChatMessage(queuedId)).toBe(true);
    expect(useStore.getState().steerQueuedChatMessage(queuedId)).toBe(false);
    await waitFor(
      () => tauriMocks.steerAiCli.mock.calls.length === 1,
      'lightning action to steer the active Codex turn',
    );

    expect(tauriMocks.steerAiCli).toHaveBeenCalledWith(
      runId,
      '补充：也检查测试',
    );
    expect(tauriMocks.cancelAiCli).not.toHaveBeenCalled();
    expect(tauriMocks.aiEditViaCli).toHaveBeenCalledTimes(1);
    expect(useStore.getState().steerableQueuedChatMessageIds).toEqual([]);
    resolveSteer(true);
    await waitFor(
      () => useStore.getState().queuedChatMessageIds.length === 0,
      'steered follow-up to leave the queue',
    );
    expect(useStore.getState().queuedChatMessageIds).toEqual([]);

    const assertInterjectionOrder = () => {
      const messages = useStore.getState().messages;
      const interjection = messages.find((m) => m.id === queuedId)!;
      expect(interjection.interjectedReplyId).toBe(replyId);
      expect(messages.findIndex((m) => m.id === queuedId)).toBe(
        messages.findIndex((m) => m.id === replyId) - 1,
      );
      const visible = orderDisplayMessages(messages);
      expect(visible.findIndex((m) => m.id === queuedId)).toBe(
        visible.findIndex((m) => m.id === replyId) - 1,
      );
    };
    assertInterjectionOrder();

    resolveTurn('已同时检查项目和测试。');
    await waitFor(
      () => !useStore.getState().aiStreaming,
      'steered Codex turn to finish',
    );
    expect(tauriMocks.aiEditViaCli).toHaveBeenCalledTimes(1);
    expect(useStore.getState().workflow.nodes[0].params.userInputs).toEqual([
      '先检查项目',
      '补充：也检查测试',
    ]);
    assertInterjectionOrder();
  });

  it('keeps a Claude follow-up queued until the lightning action steers it into the active turn', async () => {
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
    let resolveTurn!: (value: string) => void;
    tauriMocks.aiEditViaCli.mockImplementation(
      async () =>
        await new Promise<string>((resolve) => {
          resolveTurn = resolve;
        }),
    );
    tauriMocks.steerAiCli.mockResolvedValue(true);

    useStore.getState().sendPrompt('先分析项目');
    await waitFor(
      () => tauriMocks.aiEditViaCli.mock.calls.length === 1,
      'Claude turn to start',
    );
    const runId = tauriMocks.aiEditViaCli.mock.calls[0]?.[2]?.runId;

    useStore.getState().sendPrompt('补充：也分析测试');
    await waitFor(
      () => useStore.getState().queuedChatMessageIds.length === 1,
      'Claude follow-up to enter the queue',
    );
    expect(tauriMocks.steerAiCli).not.toHaveBeenCalled();

    const queuedId = useStore.getState().queuedChatMessageIds[0];
    expect(useStore.getState().steerableQueuedChatMessageIds).toEqual([queuedId]);
    expect(useStore.getState().steerQueuedChatMessage(queuedId)).toBe(true);
    await waitFor(
      () => tauriMocks.steerAiCli.mock.calls.length === 1,
      'lightning action to steer the active Claude turn',
    );
    expect(tauriMocks.steerAiCli).toHaveBeenCalledWith(
      runId,
      '补充：也分析测试',
    );
    expect(tauriMocks.cancelAiCli).not.toHaveBeenCalled();
    expect(tauriMocks.aiEditViaCli).toHaveBeenCalledTimes(1);

    resolveTurn('已同时分析项目和测试。');
    await waitFor(
      () => !useStore.getState().aiStreaming,
      'steered Claude turn to finish',
    );
    expect(tauriMocks.aiEditViaCli).toHaveBeenCalledTimes(1);
    // The interjection belongs to the turn it was steered into, so the stream
    // shows it above that turn's reply instead of stranded at the tail.
    const steeredMessages = useStore.getState().messages;
    const interjectionIndex = steeredMessages.findIndex((message) =>
      message.text.includes('补充：也分析测试'),
    );
    const replyIndex = steeredMessages.findIndex(
      (message) => message.role === 'assistant',
    );
    expect(interjectionIndex).toBeGreaterThanOrEqual(0);
    expect(steeredMessages[interjectionIndex]?.interjected).toBe(true);
    expect(interjectionIndex).toBeLessThan(replyIndex);
  });

  it('keeps a Codex follow-up queued when its lightning steer is rejected', async () => {
    resetStore(simpleBlueprint('Simple chat'));
    tauriMocks.isTauri.mockReturnValue(true);
    tauriMocks.tauriAvailable.mockReturnValue(true);
    gatewayMocks.resolveDirectGatewayRoute.mockReturnValue(null);
    gatewayMocks.resolveCliGatewayRoute.mockResolvedValue({
      selection: { adapter: 'codex', modelClass: 'codex' },
      adapter: 'codex',
      modelClass: 'codex',
      model: 'gpt-5.4',
      transport: 'cli',
      mode: 'cli',
      label: 'Codex',
      source: 'fallback',
      cliCommand: 'codex',
    });
    const resolvers: Array<(value: string) => void> = [];
    tauriMocks.aiEditViaCli.mockImplementation(
      async () =>
        await new Promise<string>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    tauriMocks.steerAiCli.mockResolvedValue(false);

    useStore.getState().sendPrompt('第一问');
    await waitFor(() => resolvers.length === 1, 'first Codex turn');
    useStore.getState().sendPrompt('第二问');
    await waitFor(
      () => useStore.getState().queuedChatMessageIds.length === 1,
      'Codex follow-up to enter the queue',
    );
    expect(tauriMocks.steerAiCli).not.toHaveBeenCalled();

    const queuedId = useStore.getState().queuedChatMessageIds[0];
    expect(useStore.getState().steerableQueuedChatMessageIds).toEqual([queuedId]);
    expect(useStore.getState().steerQueuedChatMessage(queuedId)).toBe(true);
    await waitFor(
      () => tauriMocks.steerAiCli.mock.calls.length === 1,
      'Codex lightning steer rejection',
    );
    expect(useStore.getState().queuedChatMessageIds).toHaveLength(1);
    expect(tauriMocks.aiEditViaCli).toHaveBeenCalledTimes(1);

    resolvers[0]('第一答');
    await waitFor(() => resolvers.length === 2, 'queued Codex follow-up');
    expect(tauriMocks.cancelAiCli).not.toHaveBeenCalled();
    resolvers[1]('第二答');
    await waitFor(() => !useStore.getState().aiStreaming, 'Codex queue to finish');
  });

  it('does not expose or emulate lightning steering for an unsupported adapter', async () => {
    resetStore(simpleBlueprint('Simple chat'));
    mockDirectRoute();
    const resolvers: Array<(value: string) => void> = [];
    const signals: AbortSignal[] = [];
    gatewayMocks.completeGatewayText.mockImplementation(
      async (request) =>
        await new Promise<string>((resolve) => {
          signals.push(request.signal as AbortSignal);
          resolvers.push(resolve);
        }),
    );

    useStore.getState().sendPrompt('第一问');
    await waitFor(() => resolvers.length === 1, 'first direct turn');
    useStore.getState().sendPrompt('第二问');
    await waitFor(
      () => useStore.getState().queuedChatMessageIds.length === 1,
      'direct follow-up to enter the queue',
    );

    const queuedId = useStore.getState().queuedChatMessageIds[0];
    expect(useStore.getState().steerableQueuedChatMessageIds).toEqual([]);
    expect(useStore.getState().steerQueuedChatMessage(queuedId)).toBe(false);
    expect(signals[0].aborted).toBe(false);
    expect(tauriMocks.steerAiCli).not.toHaveBeenCalled();

    resolvers[0]('第一答');
    await waitFor(() => resolvers.length === 2, 'queued direct follow-up');
    resolvers[1]('第二答');
    await waitFor(() => !useStore.getState().aiStreaming, 'direct queue to finish');
  });

  it('confirms a queued follow-up on a non-native CLI adapter without a real steer call', async () => {
    resetStore(simpleBlueprint('Simple chat'));
    tauriMocks.isTauri.mockReturnValue(true);
    tauriMocks.tauriAvailable.mockReturnValue(true);
    gatewayMocks.resolveDirectGatewayRoute.mockReturnValue(null);
    // gemini has no in-turn steer channel: aiCliSteerSupported resolves false,
    // so liveSteer.native is false and the lightning action takes the
    // queue-steer path — confirm the message (drop the pending badge) but
    // leave it in the FIFO to fire after the current turn drains.
    gatewayMocks.resolveCliGatewayRoute.mockResolvedValue({
      selection: { adapter: 'gemini', modelClass: 'gemini' },
      adapter: 'gemini',
      modelClass: 'gemini',
      model: 'gemini-2.5-pro',
      transport: 'cli',
      mode: 'cli',
      label: 'Gemini',
      source: 'fallback',
      cliCommand: 'gemini',
    });
    const resolvers: Array<(value: string) => void> = [];
    tauriMocks.aiEditViaCli.mockImplementation(
      async () =>
        await new Promise<string>((resolve) => {
          resolvers.push(resolve);
        }),
    );

    useStore.getState().sendPrompt('第一问');
    await waitFor(
      () => tauriMocks.aiEditViaCli.mock.calls.length === 1,
      'gemini turn to start',
    );

    useStore.getState().sendPrompt('第二问');
    await waitFor(
      () => useStore.getState().queuedChatMessageIds.length === 1,
      'gemini follow-up to enter the queue',
    );

    const queuedId = useStore.getState().queuedChatMessageIds[0];
    // The lightning action is hidden for non-native adapters (no in-turn
    // steer channel) — the user would otherwise see a button that only
    // confirms the message without merging it into the running turn, which
    // reads as "clicked and nothing happened".
    expect(useStore.getState().steerableQueuedChatMessageIds).toEqual([]);
    // The confirm-only code path is still reachable programmatically (e.g.
    // legacy callers); exercising it directly guarantees FIFO fallback keeps
    // working even though the UI no longer surfaces the action.
    expect(useStore.getState().steerQueuedChatMessage(queuedId)).toBe(true);

    // Confirming drops the pending badge immediately and never calls the CLI
    // steer channel. The entry stays queued internally, but is no longer
    // surfaced as "排队中" — and it cannot be steered a second time.
    expect(tauriMocks.steerAiCli).not.toHaveBeenCalled();
    await waitFor(
      () => useStore.getState().queuedChatMessageIds.length === 0,
      'confirmed gemini follow-up to leave the pending badge',
    );
    expect(useStore.getState().queuedChatMessageIds).toEqual([]);
    expect(useStore.getState().steerableQueuedChatMessageIds).toEqual([]);
    expect(useStore.getState().steerQueuedChatMessage(queuedId)).toBe(false);

    // The follow-up still fires after the current turn drains, via the FIFO.
    resolvers[0]('第一答');
    await waitFor(() => resolvers.length === 2, 'confirmed gemini follow-up runs');
    resolvers[1]('第二答');
    await waitFor(() => !useStore.getState().aiStreaming, 'gemini queue to finish');
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

    expect(useStore.getState().sendPrompt('问题一')).toBe(true);
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

  it('edits a queued interjection before it starts', async () => {
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
    useStore.getState().sendPrompt('问题二');
    await waitFor(
      () => useStore.getState().queuedChatMessageIds.length === 1,
      'queued message id',
    );
    const queuedId = useStore.getState().queuedChatMessageIds[0];

    expect(
      useStore.getState().updateQueuedChatMessage(queuedId, '改后的问题二'),
    ).toBe(true);
    expect(
      useStore
        .getState()
        .messages.filter((message) => message.role === 'user')
        .map((message) => message.text),
    ).toEqual(['问题一', '改后的问题二']);

    resolvers[0]('答一');
    await waitFor(() => resolvers.length === 2, 'edited queued turn runs');
    expect(userContents[1]).toContain('改后的问题二');
    expect(userContents[1]).not.toContain('用户：问题二');

    resolvers[1]('答二');
    await waitFor(
      () => !useStore.getState().aiStreaming,
      'edited queued chat to finish',
    );
    expect(useStore.getState().workflow.nodes[0].params.userInputs).toEqual([
      '问题一',
      '改后的问题二',
    ]);
  });

  it('pauses a queued turn while the user is editing it, then runs the edited text', async () => {
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
    useStore.getState().sendPrompt('问题二');
    await waitFor(
      () => useStore.getState().queuedChatMessageIds.length === 1,
      'queued message id',
    );
    const queuedId = useStore.getState().queuedChatMessageIds[0];

    useStore.getState().beginQueuedChatMessageEdit(queuedId);
    expect(useStore.getState().editingQueuedChatMessageId).toBe(queuedId);

    // Finish the first turn while the queued message is still being edited.
    resolvers[0]('答一');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resolvers).toHaveLength(1);
    expect(useStore.getState().queuedChatMessageIds).toEqual([queuedId]);
    expect(useStore.getState().editingQueuedChatMessageId).toBe(queuedId);

    // Commit the edit; only then does the queued turn start with the new text.
    expect(
      useStore.getState().updateQueuedChatMessage(queuedId, '改后的问题二'),
    ).toBe(true);
    expect(useStore.getState().editingQueuedChatMessageId).toBeNull();
    await waitFor(() => resolvers.length === 2, 'edited queued turn runs');
    expect(userContents[1]).toContain('改后的问题二');
    expect(userContents[1]).not.toContain('用户：问题二');

    resolvers[1]('答二');
    await waitFor(
      () => !useStore.getState().aiStreaming,
      'edited queued chat to finish',
    );
    expect(useStore.getState().workflow.nodes[0].params.userInputs).toEqual([
      '问题一',
      '改后的问题二',
    ]);
  });

  it('resumes a paused queued turn with the original text when the edit is cancelled', async () => {
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
    useStore.getState().sendPrompt('问题二');
    await waitFor(
      () => useStore.getState().queuedChatMessageIds.length === 1,
      'queued message id',
    );
    const queuedId = useStore.getState().queuedChatMessageIds[0];

    useStore.getState().beginQueuedChatMessageEdit(queuedId);
    useStore.getState().cancelQueuedChatMessageEdit();
    expect(useStore.getState().editingQueuedChatMessageId).toBeNull();

    resolvers[0]('答一');
    await waitFor(() => resolvers.length === 2, 'queued turn runs after cancel');
    expect(userContents[1]).toContain('问题二');

    resolvers[1]('答二');
    await waitFor(
      () => !useStore.getState().aiStreaming,
      'cancelled-edit queued chat to finish',
    );
  });

  it('deleting a queued message while editing it does not hang the queue', async () => {
    resetStore(simpleBlueprint('Simple chat'));
    mockDirectRoute();
    const resolvers: Array<(value: string) => void> = [];
    gatewayMocks.completeGatewayText.mockImplementation(
      async () => new Promise<string>((resolve) => resolvers.push(resolve)),
    );

    useStore.getState().sendPrompt('问题一');
    await waitFor(() => resolvers.length === 1, 'first chat call');
    useStore.getState().sendPrompt('问题二');
    await waitFor(
      () => useStore.getState().queuedChatMessageIds.length === 1,
      'queued message id',
    );
    const queuedId = useStore.getState().queuedChatMessageIds[0];

    useStore.getState().beginQueuedChatMessageEdit(queuedId);
    expect(useStore.getState().deleteQueuedChatMessage(queuedId)).toBe(true);
    expect(useStore.getState().editingQueuedChatMessageId).toBeNull();
    expect(useStore.getState().queuedChatMessageIds).toEqual([]);

    resolvers[0]('答一');
    await waitFor(
      () => !useStore.getState().aiStreaming,
      'remaining chat turn to finish',
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(gatewayMocks.completeGatewayText).toHaveBeenCalledTimes(1);
  });

  it('deletes a queued interjection before it starts', async () => {
    resetStore(simpleBlueprint('Simple chat'));
    mockDirectRoute();
    const resolvers: Array<(value: string) => void> = [];
    gatewayMocks.completeGatewayText.mockImplementation(
      async () => new Promise<string>((resolve) => resolvers.push(resolve)),
    );

    useStore.getState().sendPrompt('问题一');
    await waitFor(() => resolvers.length === 1, 'first chat call');
    useStore.getState().sendPrompt('问题二');
    await waitFor(
      () => useStore.getState().queuedChatMessageIds.length === 1,
      'queued message id',
    );
    const queuedId = useStore.getState().queuedChatMessageIds[0];

    expect(useStore.getState().deleteQueuedChatMessage(queuedId)).toBe(true);
    expect(useStore.getState().queuedChatMessageIds).toEqual([]);
    expect(
      useStore
        .getState()
        .messages.filter((message) => message.role === 'user')
        .map((message) => message.text),
    ).toEqual(['问题一']);

    resolvers[0]('答一');
    await waitFor(
      () => !useStore.getState().aiStreaming,
      'remaining chat turn to finish',
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(gatewayMocks.completeGatewayText).toHaveBeenCalledTimes(1);
    expect(useStore.getState().workflow.nodes[0].params.userInputs).toEqual([
      '问题一',
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

  it('queues a different-model follow-up while the current model is still answering', async () => {
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
    expect(useStore.getState().sendPrompt('问题二')).toBe(true);

    expect(gatewayMocks.completeGatewayText).toHaveBeenCalledTimes(1);
    expect(
      useStore
        .getState()
        .messages.filter((message) => message.role === 'user')
        .map((message) => message.text),
    ).toEqual(['问题一', '问题二']);
    expect(useStore.getState().queuedChatMessageIds).toHaveLength(1);
    expect(useStore.getState().blockedSendTip).toBeNull();

    resolvers[0]('答一');
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
    useStore.getState().setSessionRunSelection({ adapter: 'claude-code', modelClass: 'sonnet', thinkingLevel: 'high' });
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
    expect(live?.thinkingLevel).toBe('high');
    useStore.getState().setSessionRunSelection({ adapter: 'claude-code', modelClass: 'sonnet', thinkingLevel: 'low' });
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
    const final = useStore.getState().messages.find((m) => m.id === live?.id);
    expect(final?.thinkingLevel).toBe('high');
    expect(JSON.parse(JSON.stringify(final)).thinkingLevel).toBe('high');
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

  it('injects the configured project engine into simple chat prompts', async () => {
    resetStore(simpleBlueprint('Simple chat'));
    mockDirectRoute();
    useStore.setState({
      activeWorkspaceId: 'ws-unreal',
      workspaces: [
        {
          id: 'ws-unreal',
          path: 'E:\\uug_mcp\\ue-mcp-for-all-versions\\test_project_ue57\\Unity\\Unreal',
          name: 'Unreal',
          updatedAt: Date.now(),
          sessionCount: 0,
          metadata: {
            projectSettings: {
              schemaVersion: 1,
              engine: 'unreal',
            },
          },
        },
      ],
    });
    const systems: string[] = [];
    gatewayMocks.completeGatewayText.mockImplementation(async (request) => {
      systems.push(String(request.system));
      return '按 Unreal 项目拆解。';
    });

    useStore.getState().sendPrompt('对游戏图片进行游戏技术设计分析');

    await waitFor(
      () =>
        !useStore.getState().aiStreaming &&
        useStore.getState().messages.some((m) => m.role === 'assistant'),
      'project engine simple chat answer',
    );

    expect(systems[0]).toContain('【项目引擎】');
    expect(systems[0]).toContain('当前项目引擎：Unreal Engine');
    expect(systems[0]).toContain('优先按 Unreal Engine 项目实现');
    expect(systems[0]).toContain('不要改用 Godot');
    expect(systems[0]).not.toContain('默认以 Godot');
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
    expect(firstAssistant?.routeLabel).toBe('OpenRouter · z-ai/glm-4.6');
    expect(firstAssistant?.text).toContain('⚙ 路由：OpenRouter · 模型：z-ai/glm-4.6');

    useStore.getState().sendPrompt('第二问');
    await waitFor(
      () => gatewayMocks.completeGatewayText.mock.calls.length === 2,
      'second routed request',
    );
    const secondUserContent =
      gatewayMocks.completeGatewayText.mock.calls[1]?.[0]?.userContent ?? '';
    expect(secondUserContent).toContain('助手：第一轮回答');
    expect(secondUserContent).not.toContain('⚙ 路由');
    expect(secondUserContent).not.toContain('<<UGS_TOOL>>');
    expect(secondUserContent).not.toContain('free_proxy');
    expect(secondUserContent).not.toContain('⏱');
  });

  it('omits legacy channel names from visible route labels', () => {
    const route = {
      adapter: 'claude-code' as const,
      modelClass: 'opus' as const,
      model: 'claude-opus-4.8',
      providerName: 'Acme',
      channelName: 'claude-sonnet-5',
      label: 'Claude Code · Acme · claude-sonnet-5 · opus',
    };

    expect(gatewayRouteHeader(route)).toBe('Acme · claude-opus-4.8');
    expect(gatewayRouteLine(route)).toBe('⚙ 路由：Acme · 模型：claude-opus-4.8');
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

  it('keeps streamed tool sentinels on the final CLI chat message across turns', async () => {
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
    let turn = 0;
    tauriMocks.aiEditViaCli.mockImplementation(async (_prompt, _adapter, opts) => {
      turn += 1;
      // The CLI streams a tool-use sentinel (a file edit) followed by prose, but
      // the resolved value is the clean prose only — mirroring the real runtime.
      const editedPath = turn === 1 ? 'src/first.ts' : 'src/second.ts';
      opts.onProgress?.(
        encodeToolPatch({
          id: `tool_${turn}`,
          name: 'Edit',
          subject: editedPath,
          args: { file_path: editedPath },
          status: 'done',
        }),
      );
      return turn === 1 ? '改好了第一个文件。' : '改好了第二个文件。';
    });

    useStore.getState().sendPrompt('改一下第一个文件');
    await waitFor(
      () =>
        !useStore.getState().aiStreaming &&
        useStore
          .getState()
          .messages.some(
            (m) => m.role === 'assistant' && m.text.includes('改好了第一个文件'),
          ),
      'first CLI chat turn finalized',
    );

    // After the first turn the sentinel must survive on the final message.
    const afterFirst = useStore.getState().messages.filter((m) => m.role === 'assistant');
    expect(afterFirst.some((m) => m.text.includes('src/first.ts'))).toBe(true);

    useStore.getState().sendPrompt('再改第二个文件');
    await waitFor(
      () =>
        !useStore.getState().aiStreaming &&
        useStore
          .getState()
          .messages.some(
            (m) => m.role === 'assistant' && m.text.includes('改好了第二个文件'),
          ),
      'second CLI chat turn finalized',
    );

    // Both turns' edited files remain visible (merged across the session).
    const finalMessages = useStore.getState().messages;
    const allText = finalMessages.map((m) => m.text).join('\n');
    expect(allText).toContain('src/first.ts');
    expect(allText).toContain('src/second.ts');

    const files = extractSessionFiles(finalMessages);
    const editedPaths = files
      .filter((f) => f.action === 'edited')
      .map((f) => f.path);
    expect(editedPaths).toContain('src/first.ts');
    expect(editedPaths).toContain('src/second.ts');
  });

  it('keeps streamed tool cards before the final CLI prose when the tool ran first', async () => {
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
    tauriMocks.aiEditViaCli.mockImplementation(async (_prompt, _adapter, opts) => {
      opts.onProgress?.(
        encodeToolPatch({
          id: 'tool_first',
          name: 'Read',
          subject: 'src/context.ts',
          args: { file_path: 'src/context.ts' },
          status: 'done',
        }),
      );
      opts.onProgress?.('结论：已经检查完。');
      return '结论：已经检查完。';
    });

    useStore.getState().sendPrompt('先查文件再回答');
    await waitFor(
      () =>
        !useStore.getState().aiStreaming &&
        useStore
          .getState()
          .messages.some((m) => m.role === 'assistant' && m.text.includes('已经检查完')),
      'CLI final message with ordered tools',
    );

    const assistant = useStore
      .getState()
      .messages.find((m) => m.role === 'assistant' && m.text.includes('已经检查完'));
    expect(assistant?.text.indexOf('<<UGS_TOOL>>')).toBeLessThan(
      assistant?.text.indexOf('结论：已经检查完。') ?? -1,
    );
  });

  it('drops transient runtime heartbeat cards from the finalized CLI chat message', async () => {
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
    tauriMocks.aiEditViaCli.mockImplementation(async (_prompt, _adapter, opts) => {
      opts.onProgress?.(
        encodeToolPatch({
          id: 'runtime-status-run1',
          name: '运行状态',
          subject: '仍在运行…（已 12s）',
          status: 'running',
          ephemeral: true,
        }),
      );
      opts.onProgress?.(
        encodeToolPatch({
          id: 'runtime-status-run1',
          name: '运行状态',
          subject: '仍在运行…（已 24s）',
          status: 'running',
          ephemeral: true,
        }),
      );
      opts.onProgress?.('结论：处理完成。');
      return '结论：处理完成。';
    });

    useStore.getState().sendPrompt('跑一个较慢任务');
    await waitFor(
      () =>
        !useStore.getState().aiStreaming &&
        useStore
          .getState()
          .messages.some((m) => m.role === 'assistant' && m.text.includes('处理完成')),
      'CLI final message without runtime heartbeat',
    );

    const assistant = useStore
      .getState()
      .messages.find((m) => m.role === 'assistant' && m.text.includes('处理完成'));
    expect(assistant?.text).not.toContain('仍在运行');
    expect(assistant?.text).not.toContain('runtime-status-run1');
  });

  it('places streamed tool cards before final CLI prose when live text lacks the final answer', async () => {
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
    tauriMocks.aiEditViaCli.mockImplementation(async (_prompt, _adapter, opts) => {
      opts.onProgress?.(
        encodeToolPatch({
          id: 'tool_only_live',
          name: 'command_execution',
          subject: 'git status --short',
          args: { command: 'git status --short' },
          status: 'done',
        }),
      );
      return '结论：仓库状态已经检查完。';
    });

    useStore.getState().sendPrompt('检查状态后告诉我结论');
    await waitFor(
      () =>
        !useStore.getState().aiStreaming &&
        useStore
          .getState()
          .messages.some((m) => m.role === 'assistant' && m.text.includes('仓库状态')),
      'CLI final message with live-only tools',
    );

    const assistant = useStore
      .getState()
      .messages.find((m) => m.role === 'assistant' && m.text.includes('仓库状态'));
    expect(assistant?.text.indexOf('<<UGS_TOOL>>')).toBeLessThan(
      assistant?.text.indexOf('结论：仓库状态已经检查完。') ?? -1,
    );
  });

  it('converts streamed Claude XML invoke blocks into persisted tool sentinels', async () => {
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
    const editedPath = 'E:\\project\\Moon\\ShadowProjectionPixelShader.usf';
    tauriMocks.aiEditViaCli.mockImplementation(async (_prompt, _adapter, opts) => {
      opts.onProgress?.(
        [
          '先撤销实验。',
          'count',
          '<invoke name="Edit">',
          `<parameter name="file_path">${editedPath}</parameter>`,
          '<parameter name="new_string">OutColor = 1;</parameter>',
          '<parameter name="old_string">OutColor = 0;</parameter>',
          '<parameter name="replace_all">false</parameter>',
          '</invoke>',
        ].join('\n'),
      );
      opts.onProgress?.('\n结论：已恢复正式修复。');
      return '结论：已恢复正式修复。';
    });

    useStore.getState().sendPrompt('恢复 shader 修复');
    await waitFor(
      () =>
        !useStore.getState().aiStreaming &&
        useStore
          .getState()
          .messages.some((m) => m.role === 'assistant' && m.text.includes('正式修复')),
      'CLI final message with converted XML tool',
    );

    const assistant = useStore
      .getState()
      .messages.find((m) => m.role === 'assistant' && m.text.includes('正式修复'));
    expect(assistant?.text).toContain('<<UGS_TOOL>>');
    expect(assistant?.text).not.toContain('<invoke');
    expect(assistant?.text).not.toContain('<parameter');
    expect(assistant?.fileChanges?.source).toBe('agent');
    expect(assistant?.fileChanges?.files[0].path).toBe(editedPath);
    expect(assistant?.text).not.toMatch(/^\s*count\s*$/m);
    const files = extractSessionFiles(useStore.getState().messages);
    expect(files.some((file) => file.path === editedPath && file.action === 'edited')).toBe(
      true,
    );
  });

  it('captures a fallback snapshot only after a queued runtime starts and persists the summary', async () => {
    resetStore(simpleBlueprint('Simple chat'));
    useStore.setState({ composer: { ...defaultComposer, workspace: 'E:/project' } });
    tauriMocks.isTauri.mockReturnValue(true);
    tauriMocks.tauriAvailable.mockReturnValue(true);
    gatewayMocks.resolveDirectGatewayRoute.mockReturnValue(null);
    gatewayMocks.resolveCliGatewayRoute.mockResolvedValue({
      selection: { adapter: 'grok', modelClass: 'grok' }, adapter: 'grok', modelClass: 'grok',
      model: 'grok', transport: 'cli', mode: 'cli', label: 'Grok', source: 'fallback', cliCommand: 'grok',
    });
    // The launch selection determines which runtimes need a disk baseline.
    useStore.setState({ workflow: { ...useStore.getState().workflow, meta: {
      ...useStore.getState().workflow.meta, gateway: { defaults: { adapter: 'grok', modelClass: 'grok' } },
    } } });
    tauriMocks.listWorkspaceChanges.mockResolvedValueOnce({ rootPath: 'E:/project', generatedAtMs: 2,
      files: [{ path: 'src/new.ts', status: 'added', binary: false, truncated: false,
        lines: [{ kind: 'added', content: 'new' }] }], truncated: false } as never);
    tauriMocks.aiEditViaCli.mockResolvedValue('已完成');
    useStore.getState().sendPrompt('创建文件');
    await waitFor(() => !useStore.getState().aiStreaming, 'fallback file summary');
    const answer = useStore.getState().messages.find((m) => m.role === 'assistant' && m.text.includes('已完成'));
    expect(answer?.fileChanges?.source).toBe('snapshot');
    expect(answer?.fileChanges?.files[0]).toMatchObject({ path: 'src/new.ts', status: 'added', added: 1 });
  });

  it('does not splice tool cards through final prose streamed around tools', async () => {
    resetStore(simpleBlueprint('Simple chat'));
    tauriMocks.isTauri.mockReturnValue(true);
    tauriMocks.tauriAvailable.mockReturnValue(true);
    gatewayMocks.resolveDirectGatewayRoute.mockReturnValue(null);
    gatewayMocks.resolveCliGatewayRoute.mockResolvedValue({
      selection: { adapter: 'codex-cli', modelClass: 'gpt-5' },
      adapter: 'codex-cli',
      modelClass: 'gpt-5',
      model: 'gpt-5',
      transport: 'cli',
      mode: 'cli',
      label: 'Codex',
      source: 'fallback',
      cliCommand: 'codex',
    });
    const finalAnswer =
      'HTTP 健康检查。只验证页面能加载；桌面文件预览仍以组件测试覆盖。✅ 已优化。';
    tauriMocks.aiEditViaCli.mockImplementation(async (_prompt, _adapter, opts) => {
      opts.onProgress?.('HT');
      opts.onProgress?.(
        encodeToolPatch({
          id: 'tool_http',
          name: 'command_execution',
          subject: 'npm test -- --run src/components/ai/FilePreviewDrawer.test.tsx',
          args: {
            command:
              'npm test -- --run src/components/ai/FilePreviewDrawer.test.tsx',
          },
          status: 'done',
        }),
      );
      opts.onProgress?.('TP 健');
      opts.onProgress?.(
        encodeToolPatch({
          id: 'tool_typecheck',
          name: 'command_execution',
          subject: 'npm run typecheck',
          args: { command: 'npm run typecheck' },
          status: 'done',
        }),
      );
      opts.onProgress?.(
        '康检查。只验证页面能加载；桌面文件预览仍以组件测试覆盖。✅ 已优化。',
      );
      return finalAnswer;
    });

    useStore.getState().sendPrompt('跑检查后告诉我结论');
    await waitFor(
      () =>
        !useStore.getState().aiStreaming &&
        useStore
          .getState()
          .messages.some((m) => m.role === 'assistant' && m.text.includes(finalAnswer)),
      'CLI final prose stays contiguous',
    );

    const assistant = useStore
      .getState()
      .messages.find((m) => m.role === 'assistant' && m.text.includes(finalAnswer));
    const firstToolIdx = assistant?.text.indexOf('<<UGS_TOOL>>') ?? -1;
    const proseIdx = assistant?.text.indexOf(finalAnswer) ?? -1;
    expect(firstToolIdx).toBeGreaterThanOrEqual(0);
    expect(proseIdx).toBeGreaterThanOrEqual(0);
    expect(firstToolIdx).toBeLessThan(proseIdx);
  });

  it('places an earlier interaction round tool card before the final conclusion', async () => {
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
    let round = 0;
    tauriMocks.aiEditViaCli.mockImplementation(async (_prompt, _adapter, opts) => {
      round += 1;
      if (round === 1) {
        // First round: run a tool, then ask the user to choose. The tool's
        // sentinel streams here but the round resolves to an interaction block,
        // so it is captured in `streamedToolSentinels` rather than the final
        // round's live stream.
        opts.onProgress?.(
          encodeToolPatch({
            id: 'tool_round1',
            name: 'Read',
            subject: 'src/diagnose.ts',
            args: { file_path: 'src/diagnose.ts' },
            status: 'done',
          }),
        );
        return [
          '<<UGS_ASK>>',
          JSON.stringify({
            type: 'select',
            prompt: '用哪种修复方式？',
            options: ['方案A', '方案B'],
            multi: false,
          }),
          '<<UGS_ASK_END>>',
        ].join('\n');
      }
      // Second round (after the user picks): stream this round's own tool, then
      // the conclusion. The round-1 tool is now a "missing" sentinel that must
      // still land ABOVE the conclusion, not after it.
      opts.onProgress?.(
        encodeToolPatch({
          id: 'tool_round2',
          name: 'Edit',
          subject: 'src/fix.ts',
          args: { file_path: 'src/fix.ts' },
          status: 'done',
        }),
      );
      opts.onProgress?.('结论：已按方案B修复完成。');
      return '结论：已按方案B修复完成。';
    });

    useStore.getState().sendPrompt('诊断并修复');
    await waitFor(
      () =>
        useStore
          .getState()
          .messages.some(
            (m) => m.interaction?.prompt === '用哪种修复方式？',
          ),
      'first round interaction widget',
    );

    const interactionMessage = useStore
      .getState()
      .messages.find((m) => m.interaction);
    useStore.getState().answerInteraction(interactionMessage!.id, {
      kind: 'select',
      values: ['方案B'],
    });

    await waitFor(
      () =>
        !useStore.getState().aiStreaming &&
        useStore
          .getState()
          .messages.some(
            (m) => m.role === 'assistant' && m.text.includes('已按方案B修复完成'),
          ),
      'final conclusion after interaction',
    );

    const assistant = useStore
      .getState()
      .messages.find(
        (m) => m.role === 'assistant' && m.text.includes('已按方案B修复完成'),
      );
    // The round-1 tool ran chronologically before the conclusion the model
    // emitted last, so its card must render ABOVE the final prose.
    const round1Idx = assistant?.text.indexOf('src/diagnose.ts') ?? -1;
    const round2Idx = assistant?.text.indexOf('src/fix.ts') ?? -1;
    const proseIdx = assistant?.text.indexOf('结论：已按方案B修复完成。') ?? -1;
    expect(round1Idx).toBeGreaterThanOrEqual(0);
    expect(round2Idx).toBeGreaterThanOrEqual(0);
    expect(proseIdx).toBeGreaterThanOrEqual(0);
    expect(round1Idx).toBeLessThan(proseIdx);
    expect(round2Idx).toBeLessThan(proseIdx);
  });
});
