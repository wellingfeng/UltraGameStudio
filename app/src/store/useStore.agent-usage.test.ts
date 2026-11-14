import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryIpcFixture, historyFixtureIpc } from '@/test/nativePersistenceFixture';
import { resetSnapshotCache } from '@/lib/memorySnapshots';
import { defaultBlueprint, simpleBlueprint } from '@/core/defaultBlueprint';
import type { IRGraph } from '@/core/ir';
import { resetSecureStorageForTests } from '@/lib/secureStorage';
import { refreshCliRuntime } from '@/lib/cliConfig';
import { DEFAULT_GAME_EXPERT_SETTINGS } from '@/lib/gameExperts';
import { defaultComposer } from './sampleSessions';

const nativeIpc = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: nativeIpc.invoke }));
let memoryIpc = createMemoryIpcFixture();
beforeEach(() => {
  resetSnapshotCache();
  memoryIpc = createMemoryIpcFixture();
  nativeIpc.invoke.mockReset().mockImplementation(async (command: string, payload: Record<string, unknown> = {}) => {
    if (command.startsWith('history_')) return historyFixtureIpc(command, payload);
    if (command === 'memory_read_json' || command === 'memory_compare_exchange_json') return memoryIpc.invoke(command, payload);
    throw new Error(`Unexpected simple-chat fixture IPC: ${command}`);
  });
  Object.defineProperty(globalThis, '__TAURI_INTERNALS__', { configurable: true, value: { invoke: nativeIpc.invoke } });
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke: nativeIpc.invoke } });
});

const gatewayMocks = vi.hoisted(() => ({
  completeGatewayText: vi.fn(),
  resolveDirectGatewayRoute: vi.fn(),
  resolveCliGatewayRoute: vi.fn(),
}));

const handoffSelectionMocks = vi.hoisted(() => ({
  resolve: vi.fn(async (selection: import('@/core/ir').GatewaySelection) => ({ ...selection, modelOverride: 'gpt-future-frontier', thinkingLevel: 'ultra' })),
}));
vi.mock('@/lib/sessionHandoffModel', () => ({ resolveHandoffSelection: handoffSelectionMocks.resolve }));

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
  saveSessionHandoffSnapshot: vi.fn(),
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
    saveSessionHandoffSnapshot: tauriMocks.saveSessionHandoffSnapshot,
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
import { __resetSimpleChatRuntimeForTests } from './useStore';
import { historyStore } from './history/store';
import type { Session } from './types';
import { readActiveAgentUsage, readAgentUsageHistory } from '@/lib/agentUsageHistory';

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
    jobSessions: [],
    waitingInputSessions: [],
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
  tauriMocks.saveSessionHandoffSnapshot.mockReset();
  notificationMocks.dismissSessionWaitingInputNotification.mockReset();
  notificationMocks.notifySessionComplete.mockReset();
  tauriMocks.freeProxyEnsure.mockResolvedValue({ port: 8766, token: 'test-token' });
  tauriMocks.aiCliSteerSupported.mockImplementation(
    async (adapter: string) => adapter === 'codex' || adapter === 'claude-code',
  );
  tauriMocks.isTauri.mockReturnValue(false);
  tauriMocks.tauriAvailable.mockReturnValue(false);
  Reflect.deleteProperty(globalThis, '__TAURI_INTERNALS__');
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  resetStore(defaultBlueprint('Current workflow'));
  window.localStorage.clear();
  resetSecureStorageForTests();
  await refreshCliRuntime();
});

describe('agent usage model switch', () => {
  it('tracks live CLI usage with the actual model across a session model switch', async () => {
    tauriMocks.tauriAvailable.mockReturnValue(false);
    await historyStore.ready();
    const workspace = await historyStore.resolveWorkspaceByPath('E:/usage-fixture');
    const session = await historyStore.createSession({ workspaceId: workspace.id, isWorkflow: false, messages: [], title: 'Usage' });
    resetStore(simpleBlueprint('Simple chat'));
    useStore.setState({ historyReady: true, activeWorkspaceId: workspace.id, activeSessionId: session.id,
      workspaces: [workspace], sessions: [{ ...session, workspaceId: workspace.id } as Session],
      composer: { ...defaultComposer, workspace: workspace.path } });
    tauriMocks.isTauri.mockReturnValue(true);
    gatewayMocks.resolveDirectGatewayRoute.mockReturnValue(null);
    gatewayMocks.resolveCliGatewayRoute.mockImplementation(async (selection) => ({
      selection, adapter: 'codex', modelClass: selection.modelClass,
      model: selection.modelOverride, providerName: 'KuroCodeX', transport: 'cli', mode: 'cli',
      label: 'Codex', source: 'global', cliCommand: 'codex',
    }));
    let finish!: (text: string) => void;
    let sendUsage!: (value: unknown) => void;
    tauriMocks.aiEditViaCli.mockImplementation(async (_prompt, _adapter, opts) => {
      sendUsage = opts.onUsage;
      return await new Promise<string>((resolve) => { finish = resolve; });
    });
    const selectModel = (model: string) => useStore.getState().setSessionRunSelection({
      adapter: 'codex', modelClass: model, modelOverride: model,
    });
    selectModel('gpt-6.1-terra');
    let firstTerminal!: (status: 'completed' | 'cancelled' | 'failed') => void;
    const firstDone = new Promise((resolve) => { firstTerminal = resolve; });
    useStore.getState().sendPrompt('第一轮', { onChatTerminal: firstTerminal });
    await waitFor(() => tauriMocks.aiEditViaCli.mock.calls.length === 1, 'Terra call');
    expect(tauriMocks.aiEditViaCli.mock.calls[0][2].model).toBe('gpt-6.1-terra');
    sendUsage({ input_tokens: 30, output_tokens: 5 });
    finish('Terra 完成');
    expect(await firstDone).toBe('completed');
    selectModel('gpt-6-astra');
    let secondTerminal!: (status: 'completed' | 'cancelled' | 'failed') => void;
    const secondDone = new Promise((resolve) => { secondTerminal = resolve; });
    useStore.getState().sendPrompt('第二轮', { onChatTerminal: secondTerminal });
    await waitFor(() => tauriMocks.aiEditViaCli.mock.calls.length === 2, 'Astra call');
    expect(tauriMocks.aiEditViaCli.mock.calls[1][2].model).toBe('gpt-6-astra');
    expect(readActiveAgentUsage()).toEqual([expect.objectContaining({ model: 'gpt-6-astra', hasUsage: false })]);
    selectModel('gpt-6.1-terra');
    sendUsage({ input_tokens: 100, output_tokens: 10, cached_input_tokens: 25 });
    sendUsage({ input_tokens: 200, output_tokens: 20, cached_input_tokens: 50 });
    expect(readActiveAgentUsage()).toEqual([expect.objectContaining({
      model: 'gpt-6-astra', hasUsage: true, inputTokens: 200, outputTokens: 20, cachedInputTokens: 50,
    })]);
    finish('Astra 完成');
    expect(await secondDone).toBe('completed');
    expect(readActiveAgentUsage()).toEqual([]);
    const rows = readAgentUsageHistory();
    expect(rows.map((row) => row.model).sort()).toEqual(['gpt-6-astra', 'gpt-6.1-terra'].sort());
    expect(rows.find((row) => row.model === 'gpt-6-astra')).toMatchObject({ inputTokens: 200, outputTokens: 20, cachedInputTokens: 50 });
  });


  it('shows Claude progress and cumulative usage before the turn ends', async () => {
    await historyStore.ready();
    const workspace = await historyStore.resolveWorkspaceByPath('E:/claude-usage-fixture');
    const session = await historyStore.createSession({ workspaceId: workspace.id, isWorkflow: false, messages: [], title: 'Claude usage' });
    resetStore(simpleBlueprint('Simple chat'));
    useStore.setState({ historyReady: true, activeWorkspaceId: workspace.id, activeSessionId: session.id,
      workspaces: [workspace], sessions: [{ ...session, workspaceId: workspace.id } as Session],
      composer: { ...defaultComposer, workspace: workspace.path } });
    tauriMocks.isTauri.mockReturnValue(true);
    gatewayMocks.resolveDirectGatewayRoute.mockReturnValue(null);
    gatewayMocks.resolveCliGatewayRoute.mockImplementation(async (selection) => ({
      selection, adapter: 'claude-code', modelClass: selection.modelClass,
      model: selection.modelOverride, providerName: 'KuroCC', transport: 'cli', mode: 'cli',
      label: 'Claude Code', source: 'global', cliCommand: 'claude',
    }));
    let finish!: (text: string) => void;
    let sendProgress!: (value: string) => void;
    let sendUsage!: (value: unknown) => void;
    tauriMocks.aiEditViaCli.mockImplementation(async (_prompt, _adapter, opts) => {
      sendProgress = opts.onProgress;
      sendUsage = opts.onUsage;
      return await new Promise<string>((resolve) => { finish = resolve; });
    });
    useStore.getState().setSessionRunSelection({ adapter: 'claude-code', modelClass: 'opus', modelOverride: 'claude-opus-5.5' });
    let terminal!: (status: 'completed' | 'cancelled' | 'failed') => void;
    const done = new Promise((resolve) => { terminal = resolve; });
    useStore.getState().sendPrompt('测试', { onChatTerminal: terminal });
    await waitFor(() => tauriMocks.aiEditViaCli.mock.calls.length === 1, 'Claude call');
    sendProgress('模型开始响应');
    expect(readActiveAgentUsage()).toEqual([expect.objectContaining({
      application: 'claude-code', hasUsage: false, firstResponseMs: expect.any(Number),
    })]);
    sendUsage({ input_tokens: 13, output_tokens: 27, cache_read_input_tokens: 170, cache_creation_input_tokens: 7 });
    expect(readActiveAgentUsage()).toEqual([expect.objectContaining({
      hasUsage: true, inputTokens: 190, outputTokens: 27, cachedInputTokens: 170,
    })]);
    sendUsage({ input_tokens: 14, output_tokens: 29, cache_read_input_tokens: 175, cache_creation_input_tokens: 8, total_cost_usd: 0.045 });
    finish('完成');
    expect(await done).toBe('completed');
    expect(readAgentUsageHistory()).toEqual([expect.objectContaining({
      application: 'claude-code', inputTokens: 197, outputTokens: 29, cachedInputTokens: 175, costUsd: 0.045,
    })]);
  });

});
