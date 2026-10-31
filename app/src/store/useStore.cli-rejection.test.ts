import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { simpleBlueprint } from '@/core/defaultBlueprint';
import { createMemoryIpcFixture } from '@/test/nativePersistenceFixture';
import { resetSnapshotCache } from '@/lib/memorySnapshots';
import { renderFrozenMemorySnapshot } from '@/lib/memoryStore';
import { compareExchangeMemoryJson, readMemoryJson } from '@/lib/memoryTransactions';
import type { ResolvedGatewayRoute } from '@/lib/modelGateway/types';
import Sidebar from '@/panels/Sidebar';
import {
  __resetSimpleChatRuntimeForTests,
  removeAiEditChannel,
  sessionFromRecord,
  sessionLiveStatus,
  useStore,
} from './useStore';
import {
  activeAiEditChannels,
  aiEditRegistered,
  aiEditSnapshots,
  getAiEditChannelsForSession,
} from './channelRegistry';
import { historyStore } from './history/store';
import type { SessionRecord } from './history/types';

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
const gateway = vi.hoisted(() => ({
  completeGatewayText: vi.fn(),
  resolveDirectGatewayRoute: vi.fn(),
  resolveCliGatewayRoute: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: ipc.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: ipc.listen }));
vi.mock('@/lib/modelGateway/modelGateway', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/modelGateway/modelGateway')>(),
  ...gateway,
}));
// Skill review is outside this regression. Do not replace sendPrompt, the CLI
// wrapper, channel registry, history methods, or the Sidebar status selector.
vi.mock('@/lib/skillLearningDesktop', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/skillLearningDesktop')>(),
  beginSkillLearningTurn: vi.fn(() => undefined),
}));
vi.mock('@/panels/SettingsModal', () => ({ default: () => null }));

const HISTORY_PREFIX = 'ultragamestudio.history.v1:';
const CLI_ROUTE: ResolvedGatewayRoute = {
  selection: { adapter: 'codex', modelClass: 'default' },
  adapter: 'codex',
  modelClass: 'default',
  model: 'fixture-cli-model',
  transport: 'cli',
  mode: 'cli',
  label: 'Fixture Codex',
  source: 'fallback',
  cliCommand: 'C:/fixture/KuroCodeX.exe',
};
const STDOUT_FAILURE = 'CLI "KuroCodeX" stdout 读取线程已退出，未收到完成事件，已终止。';
const IDLE_FAILURE = 'CLI "KuroCodeX" 空转超过 7200s 未产生输出，已终止。';
const CLI_FAILURE_CASES = [
  { reason: 'stdout closure', failure: STDOUT_FAILURE },
  { reason: 'hard timeout', failure: 'CLI "KuroCodeX" 超时（7200s）已终止。' },
  { reason: 'idle timeout', failure: IDLE_FAILURE },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  let pending = true;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = (value) => { pending = false; resolvePromise(value); };
    reject = (reason) => { pending = false; rejectPromise(reason); };
  });
  return { promise, resolve, reject, get pending() { return pending; } };
}

type Listener = {
  name: string;
  callback: (event: { payload: unknown }) => void;
  unlisten: ReturnType<typeof vi.fn>;
  runId?: string;
};
type CliInvocation = {
  runId: string;
  payload: Record<string, unknown>;
  result: ReturnType<typeof deferred<string>>;
  listeners: Listener[];
};

const listeners = new Set<Listener>();
const invocations: CliInvocation[] = [];
const unexpectedCommands: string[] = [];
let memoryIpc = createMemoryIpcFixture();
let sidebarRoot: Root | undefined;
let sidebarContainer: HTMLDivElement | undefined;

function emit(name: string, payload: unknown): void {
  for (const listener of listeners) {
    if (listener.name === name) listener.callback({ payload });
  }
}

function localHistoryChildren(relPath: string): string[] {
  const prefix = `${HISTORY_PREFIX}${relPath ? `${relPath}/` : ''}`;
  const children = new Set<string>();
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key?.startsWith(prefix)) children.add(key.slice(prefix.length).split('/')[0]);
  }
  return [...children].sort();
}

beforeEach(async () => {
  window.localStorage.clear();
  resetSnapshotCache();
  memoryIpc = createMemoryIpcFixture();
  __resetSimpleChatRuntimeForTests();
  aiEditSnapshots.clear();
  listeners.clear();
  invocations.length = 0;
  unexpectedCommands.length = 0;
  ipc.invoke.mockReset();
  ipc.listen.mockReset();
  gateway.completeGatewayText.mockReset();
  gateway.resolveDirectGatewayRoute.mockReset().mockReturnValue(null);
  gateway.resolveCliGatewayRoute.mockReset().mockResolvedValue(CLI_ROUTE);
  ipc.listen.mockImplementation(async (name: string, callback: Listener['callback']) => {
    const listener: Listener = {
      name, callback, unlisten: vi.fn(() => { listeners.delete(listener); }),
    };
    listeners.add(listener);
    return listener.unlisten;
  });
  // Only native IPC is unavailable in jsdom. Real historyStore serialization
  // and FIFO writes round-trip through this isolated browser storage, never the
  // user's desktop history, filesystem, credentials, or a real CLI process.
  ipc.invoke.mockImplementation(async (command: string, payload: Record<string, unknown> = {}) => {
    switch (command) {
      case 'memory_read_json':
      case 'memory_compare_exchange_json':
        return memoryIpc.invoke(command, payload);
      case 'history_read_json':
        return window.localStorage.getItem(HISTORY_PREFIX + String(payload.relPath));
      case 'history_write_json':
        window.localStorage.setItem(HISTORY_PREFIX + String(payload.relPath), String(payload.json));
        return;
      case 'history_list_dir':
        return localHistoryChildren(String(payload.relPath ?? ''));
      case 'history_root':
        return 'memory://cli-rejection-fixture';
      case 'ai_cli': {
        const runId = String(payload.runId);
        const ownedListeners = [...listeners].filter((listener) => !listener.runId);
        ownedListeners.forEach((listener) => { listener.runId = runId; });
        const result = deferred<string>();
        invocations.push({ runId, payload, result, listeners: ownedListeners });
        return result.promise;
      }
      case 'ai_cli_steer_supported':
        return true;
      case 'ugs_job_wrapper_path':
      case 'workspace_changes_cached':
        return null;
      case 'workspace_changes_baseline':
        return { rootPath: payload.rootPath, generatedAtMs: Date.now(), fileCount: 0, truncated: false };
      case 'workspace_changes':
        return { rootPath: payload.rootPath, generatedAtMs: Date.now(), files: [], truncated: false };
      case 'project_environment_scan':
        throw new Error('Fixture project scanner is unavailable');
      case 'notify_session_complete':
      case 'dismiss_session_waiting_input_notification':
        return true;
      default:
        unexpectedCommands.push(command);
        throw new Error(`Unexpected fixture IPC command: ${command}`);
    }
  });
  vi.stubGlobal('isTauri', true);
  // Concurrent dynamic imports can reach the SDK's real entry point too.
  // Both routes dispatch to the exact same isolated persistence fixture.
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke: ipc.invoke });
  useStore.setState({
    ...useStore.getInitialState(),
    workflow: simpleBlueprint('CLI failure fixture'),
    mode: 'design',
    locale: 'zh-CN',
    aiStreaming: false,
    aiEditingSessions: [],
    chattingSessions: [],
    runningSessions: [],
    waitingInputSessions: [],
    jobSessions: [],
    queuedChatMessageIds: [],
    steerableQueuedChatMessageIds: [],
    messages: [],
    activeSessionId: null,
    activeWorkspaceId: null,
    workspaces: [],
    sessions: [],
    sessionTree: {},
    composerDraft: '',
    composerDrafts: {},
    composerBySession: {},
  });
  await historyStore.ready();
});

afterEach(async () => {
  if (sidebarRoot) await act(async () => { sidebarRoot?.unmount(); });
  sidebarRoot = undefined;
  sidebarContainer?.remove();
  sidebarContainer = undefined;
  // Failed assertions must not leave pending native promises/intervals behind.
  for (const channel of activeAiEditChannels()) {
    channel.abortController.abort();
    removeAiEditChannel(channel);
  }
  for (const invocation of invocations) invocation.result.resolve('Fixture cleanup complete.');
  await vi.waitFor(() => expect(listeners.size).toBe(0));
  __resetSimpleChatRuntimeForTests();
  await historyStore.patchConfig({});
  vi.unstubAllGlobals();
  expect(unexpectedCommands).toEqual([]);
});

async function prepareSessions(titles: string[]) {
  const workspace = await historyStore.resolveWorkspaceByPath('E:/fixture-cli-rejection');
  const records: SessionRecord[] = [];
  for (const title of titles) {
    records.push(await historyStore.createSession({
      workspaceId: workspace.id, title, isWorkflow: false, messages: [],
    }));
  }
  const sessions = records.map(sessionFromRecord);
  const workflow = simpleBlueprint(titles[0]);
  workflow.meta.gateway = { defaults: { ...CLI_ROUTE.selection } };
  useStore.setState({
    historyReady: true,
    activeWorkspaceId: workspace.id,
    activeSessionId: records[0].id,
    workspaces: [workspace],
    sessions,
    sessionTree: { [workspace.id]: sessions },
    workflow,
    composer: { ...useStore.getState().composer, workspace: workspace.path },
  });
  return { workspace, records };
}

async function renderSidebar(): Promise<HTMLDivElement> {
  sidebarContainer = document.createElement('div');
  document.body.appendChild(sidebarContainer);
  sidebarRoot = createRoot(sidebarContainer);
  await act(async () => { sidebarRoot?.render(createElement(Sidebar)); });
  return sidebarContainer;
}

function sessionRow(container: HTMLElement, title: string): HTMLButtonElement {
  const row = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes(title));
  expect(row).toBeInstanceOf(HTMLButtonElement);
  return row!;
}

async function readPersistedSession(workspaceId: string, sessionId: string): Promise<SessionRecord> {
  // A queued write is a historyStore barrier. Check serialized IPC output too:
  // getSession alone can return its in-memory record cache before a write lands.
  await historyStore.patchConfig({});
  const serialized = window.localStorage.getItem(
    `${HISTORY_PREFIX}workspaces/${workspaceId}/sessions/${sessionId}.json`,
  );
  expect(serialized).not.toBeNull();
  return JSON.parse(serialized!) as SessionRecord;
}

describe('native CLI rejection through the real chat store', () => {
  it('round-trips native memory bytes and rejects a stale exact CAS without changing its winner', async () => {
    const path = 'memories/fixture-cas.json';
    const first = JSON.stringify({ version: 1, entries: ['first'] });
    const winner = JSON.stringify({ version: 1, entries: ['concurrent winner'] });
    await compareExchangeMemoryJson(path, null, first);
    expect(await readMemoryJson(path)).toBe(first);
    expect(memoryIpc.bytes.get(path)).toBe(first);
    memoryIpc.bytes.set(path, winner);
    await expect(compareExchangeMemoryJson(path, first, JSON.stringify({ version: 1, entries: ['stale writer'] })))
      .rejects.toThrow('Memory CAS conflict: exact base changed');
    expect(await readMemoryJson(path)).toBe(winner);
    expect(ipc.invoke.mock.calls.some(([command, payload]) => command === 'history_write_json' && String(payload?.relPath).startsWith('memories/'))).toBe(false);
  });

  it.each(['read', 'cas', 'acknowledged-but-unwritten'] as const)('propagates the actual native memory %s boundary failure without history fallback', async (stage) => {
    const path = `memories/fixture-failure-${stage}.json`;
    const failure = new Error(`deterministic memory ${stage} failure`);
    const delegate = ipc.invoke.getMockImplementation()!;
    ipc.invoke.mockImplementation(async (command: string, payload: Record<string, unknown> = {}) => {
      if (payload.relPath === path && command === (stage === 'read' ? 'memory_read_json' : 'memory_compare_exchange_json')) {
        if (stage === 'acknowledged-but-unwritten') return payload.json;
        throw failure;
      }
      return delegate(command, payload);
    });
    const result = stage === 'read' ? readMemoryJson(path) : compareExchangeMemoryJson(path, null, '{"version":1}');
    if (stage === 'acknowledged-but-unwritten') await expect(result).rejects.toThrow('Memory readback mismatch; target changed after commit');
    else await expect(result).rejects.toBe(failure);
    expect(memoryIpc.bytes.has(path)).toBe(false);
    expect(ipc.invoke.mock.calls.some(([command, payload]) => command === 'history_write_json' && String(payload?.relPath).startsWith('memories/'))).toBe(false);
  });

  it.each(CLI_FAILURE_CASES)('cleans up a pending CLI turn rejected by $reason', async ({ failure }) => {
    const { workspace, records: [source] } = await prepareSessions(['CLI failure fixture']);
    const key = { workspaceId: workspace.id, sessionId: source.id };
    expect(useStore.getState().sendPrompt('Trigger CLI transport failure.')).toBe(true);
    await vi.waitFor(() => expect(invocations).toHaveLength(1));
    const invocation = invocations[0];
    const snapshots = [...memoryIpc.bytes].filter(([path]) => path.startsWith('memories/snapshots/'));
    expect(snapshots).toHaveLength(1);
    expect(JSON.parse(snapshots[0][1])).toMatchObject({ version: 1, workspaceId: workspace.id, freezeKey: source.id });
    await expect(renderFrozenMemorySnapshot(workspace.id, source.id)).resolves.toEqual(expect.any(String));
    const [channel] = getAiEditChannelsForSession(workspace.id, source.id);
    expect(channel.cliRunIds).toEqual(new Set([invocation.runId]));
    expect(channel.liveSteer).toMatchObject({ runId: invocation.runId, accepting: true });
    expect(invocation.payload).toMatchObject({ adapter: 'codex', cliCommand: CLI_ROUTE.cliCommand });
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'ai_cli')).toHaveLength(1);
    expect(invocation.result.pending).toBe(true);
    expect(invocation.listeners.map((listener) => listener.name)).toEqual([
      'ai-cli-progress', 'ai-cli-usage', 'ugs-cli-tool',
    ]);
    expect(sessionLiveStatus(key, useStore.getState())).toBe('running');
    expect(useStore.getState().aiStreaming).toBe(true);
    const container = await renderSidebar();
    expect(sessionRow(container, source.title).querySelector('[data-status="running"]')).not.toBeNull();

    // A Rust Result::Err rejects invoke with a string, not a direct-model Error.
    // Keep it pending until the running state and real listeners are observed.
    await act(async () => {
      emit('ai-cli-progress', { runId: invocation.runId, text: 'fixture-turn-started\n' });
      await vi.waitFor(() => expect(channel.messages.some((message) =>
        message.role === 'assistant' && message.text.includes('fixture-turn-started'))).toBe(true));
    });
    expect(invocation.result.pending).toBe(true);
    await act(async () => {
      invocation.result.reject(failure);
      await vi.waitFor(() => expect(aiEditRegistered(channel)).toBe(false));
    });
    const state = useStore.getState();
    expect(channel.cliRunIds.size).toBe(0);
    expect(channel.liveSteer?.accepting).toBe(false);
    expect(getAiEditChannelsForSession(workspace.id, source.id)).toEqual([]);
    expect(state.sessions.find((session) => session.id === source.id)?.runStatus).toBe('error');
    expect(state.sessionTree[workspace.id].find((session) => session.id === source.id)?.runStatus).toBe('error');
    expect(sessionLiveStatus(key, state)).toBeNull();
    expect(state).toMatchObject({
      mode: 'design', aiStreaming: false, aiEditingSessions: [], chattingSessions: [],
      runningSessions: [], waitingInputSessions: [], queuedChatMessageIds: [],
      steerableQueuedChatMessageIds: [],
    });
    expect(activeAiEditChannels()).toEqual([]);
    expect(aiEditSnapshots.get(channel.key)?.cliRunIds.size).toBe(0);
    expect(aiEditSnapshots.get(channel.key)?.liveSteer?.accepting).toBe(false);
    expect(sessionRow(container, source.title).classList.contains('ugs-sidebar-session--live')).toBe(false);
    expect(sessionRow(container, source.title).querySelector('[data-status="running"]')).toBeNull();
    expect(sessionRow(container, source.title).querySelector('[data-status="failed"]')).not.toBeNull();
    expect(listeners.size).toBe(0);
    invocation.listeners.forEach((listener) => expect(listener.unlisten).toHaveBeenCalledOnce());
    expect(gateway.completeGatewayText).not.toHaveBeenCalled();
    expect(invocations).toHaveLength(1);
    expect(ipc.invoke.mock.calls.some(([command]) => command === 'cancel_ai_cli')).toBe(false);
    await vi.waitFor(async () => {
      const saved = await historyStore.getSession(workspace.id, source.id);
      expect(saved?.meta?.runStatus).toBe('error');
      expect(saved?.isWorkflow).toBe(false);
      expect(saved?.workflow).toBeUndefined();
      const answer = saved?.messages.find((message) => message.role === 'assistant');
      expect(answer?.text).toContain(`✗ 调用失败: ${failure}`);
      expect(answer?.text).not.toContain('⟳ 生成中');
      expect(answer?.completedAt).toEqual(expect.any(Number));
    });
    const saved = await readPersistedSession(workspace.id, source.id);
    expect(saved.meta?.runStatus).toBe('error');
    expect(saved.messages.find((message) => message.role === 'assistant')?.text)
      .toContain(`✗ 调用失败: ${failure}`);
  });

  it.each(CLI_FAILURE_CASES)('drains the same-session FIFO after $reason', async ({ failure }) => {
    const { workspace, records: [source] } = await prepareSessions(['Recovering CLI fixture']);
    const prompts = ['First turn fails.', 'Queued recovery one.', 'Queued recovery two.'];
    const answers = ['Recovered answer one.', 'Recovered answer two.'];
    expect(useStore.getState().sendPrompt(prompts[0])).toBe(true);
    await vi.waitFor(() => expect(invocations).toHaveLength(1));
    const rejected = invocations[0];
    const [failedChannel] = getAiEditChannelsForSession(workspace.id, source.id);
    expect(rejected.result.pending).toBe(true);
    expect(rejected.payload).toMatchObject({ adapter: 'codex', cliCommand: CLI_ROUTE.cliCommand });
    expect(failedChannel.cliRunIds).toEqual(new Set([rejected.runId]));
    for (const prompt of prompts.slice(1)) expect(useStore.getState().sendPrompt(prompt)).toBe(true);
    const queuedIds = prompts.slice(1).map((prompt) =>
      useStore.getState().messages.find((message) => message.text === prompt)!.id);
    const queuedChannels = getAiEditChannelsForSession(workspace.id, source.id)
      .filter((channel) => channel !== failedChannel);
    expect(queuedChannels).toHaveLength(2);
    expect(useStore.getState().queuedChatMessageIds).toEqual(queuedIds);
    expect(invocations).toHaveLength(1);

    emit('ai-cli-progress', { runId: rejected.runId, text: 'recovering-fixture-turn-started\n' });
    await vi.waitFor(() => expect(failedChannel.messages.some((message) =>
      message.role === 'assistant' && message.text.includes('recovering-fixture-turn-started'))).toBe(true));
    expect(rejected.result.pending).toBe(true);
    rejected.result.reject(failure);
    await vi.waitFor(() => expect(invocations).toHaveLength(2));
    expect(aiEditRegistered(failedChannel)).toBe(false);
    expect(failedChannel.cliRunIds.size).toBe(0);
    expect(failedChannel.liveSteer?.accepting).toBe(false);
    expect(useStore.getState().queuedChatMessageIds).toEqual(queuedIds.slice(1));
    expect(useStore.getState().aiStreaming).toBe(true);
    queuedChannels.forEach((channel) => expect(channel.abortController.signal.aborted).toBe(false));
    expect((await readPersistedSession(workspace.id, source.id)).meta?.runStatus).toBe('error');

    for (let index = 0; index < answers.length; index += 1) {
      const invocation = invocations[index + 1];
      expect(invocation.result.pending).toBe(true);
      expect(invocation.payload).toMatchObject({
        adapter: 'codex', cliCommand: CLI_ROUTE.cliCommand,
        envVars: { UGS_SESSION_ID: source.id, UGS_WORKSPACE_ID: workspace.id },
      });
      const prompt = String(invocation.payload.prompt);
      expect(prompt.endsWith(prompts[index + 1])).toBe(true);
      expect(prompt).toContain(prompts[0]);
      for (const previous of answers.slice(0, index)) expect(prompt).toContain(previous);
      for (const future of prompts.slice(index + 2)) expect(prompt).not.toContain(future);
      invocation.result.resolve(answers[index]);
      if (index < answers.length - 1) {
        await vi.waitFor(() => expect(invocations).toHaveLength(index + 3));
      } else {
        await vi.waitFor(() => expect(useStore.getState().aiStreaming).toBe(false));
      }
      expect(useStore.getState().queuedChatMessageIds).toEqual(queuedIds.slice(index + 2));
    }
    expect(invocations).toHaveLength(3);
    expect(new Set(invocations.map((invocation) => invocation.runId)).size).toBe(3);
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'ai_cli')).toHaveLength(3);
    expect(gateway.completeGatewayText).not.toHaveBeenCalled();
    expect(ipc.invoke.mock.calls.some(([command]) => command === 'cancel_ai_cli')).toBe(false);
    invocations.flatMap((invocation) => invocation.listeners)
      .forEach((listener) => expect(listener.unlisten).toHaveBeenCalledOnce());
    expect(activeAiEditChannels()).toEqual([]);
    expect(listeners.size).toBe(0);
    expect(useStore.getState().steerableQueuedChatMessageIds).toEqual([]);
    const saved = await readPersistedSession(workspace.id, source.id);
    expect(saved.meta?.runStatus).toBe('success');
    expect(saved.messages.map((message) => message.role))
      .toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(saved.messages.filter((message) => message.role === 'user').map((message) => message.text))
      .toEqual(prompts);
    const savedAnswers = saved.messages.filter((message) => message.role === 'assistant');
    expect(savedAnswers[0].text).toContain(failure);
    savedAnswers.slice(1).forEach((message, index) => expect(message.text).toContain(answers[index]));
    savedAnswers.forEach((message) => expect(message.completedAt).toEqual(expect.any(Number)));
  });

  it.each(CLI_FAILURE_CASES)('preserves another session\'s live CLI and FIFO after $reason', async ({ failure }) => {
    const { workspace, records: [source, other] } = await prepareSessions([
      'Rejected CLI fixture', 'Independent CLI fixture',
    ]);
    const sourceKey = { workspaceId: workspace.id, sessionId: source.id };
    const otherKey = { workspaceId: workspace.id, sessionId: other.id };
    const sourcePrompt = 'Source turn will fail.';
    const otherPrompts = ['Independent initial turn.', 'Independent queued one.', 'Independent queued two.'];
    const otherAnswers = ['Independent answer zero.', 'Independent answer one.', 'Independent answer two.'];

    expect(useStore.getState().sendPrompt(sourcePrompt)).toBe(true);
    await vi.waitFor(() => expect(invocations).toHaveLength(1));
    const rejected = invocations[0];
    const [rejectedChannel] = getAiEditChannelsForSession(workspace.id, source.id);
    expect(rejected.result.pending).toBe(true);
    expect(rejectedChannel.cliRunIds).toEqual(new Set([rejected.runId]));
    expect(rejected.payload).toMatchObject({
      adapter: 'codex', cliCommand: CLI_ROUTE.cliCommand,
      envVars: { UGS_SESSION_ID: source.id, UGS_WORKSPACE_ID: workspace.id },
    });
    useStore.getState().selectSession(other.id, workspace.id);
    await vi.waitFor(() => expect(useStore.getState().activeSessionId).toBe(other.id));
    expect(useStore.getState().sendPrompt(otherPrompts[0])).toBe(true);
    await vi.waitFor(() => expect(invocations).toHaveLength(2));
    const independent = invocations[1];
    const [independentChannel] = getAiEditChannelsForSession(workspace.id, other.id);
    expect(independent.result.pending).toBe(true);
    expect(independentChannel.cliRunIds).toEqual(new Set([independent.runId]));
    expect(independentChannel.liveSteer).toMatchObject({
      runId: independent.runId, accepting: true, native: true,
    });
    for (const prompt of otherPrompts.slice(1)) {
      expect(useStore.getState().sendPrompt(prompt)).toBe(true);
    }
    const queuedIds = otherPrompts.slice(1).map((prompt) => {
      const message = useStore.getState().messages.find((entry) => entry.role === 'user' && entry.text === prompt);
      expect(message).toBeDefined();
      return message!.id;
    });
    const independentChannels = getAiEditChannelsForSession(workspace.id, other.id);
    expect(independentChannels).toHaveLength(3);
    expect(useStore.getState().queuedChatMessageIds).toEqual(queuedIds);
    expect(useStore.getState().steerableQueuedChatMessageIds).toEqual(queuedIds);
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'ai_cli')).toHaveLength(2);
    const container = await renderSidebar();
    expect(sessionRow(container, source.title).querySelector('[data-status="running"]')).not.toBeNull();
    expect(sessionRow(container, other.title).querySelector('[data-status="running"]')).not.toBeNull();

    await act(async () => {
      emit('ai-cli-progress', { runId: rejected.runId, text: 'source-fixture-turn-started\n' });
      await vi.waitFor(() => expect(rejectedChannel.messages.some((message) =>
        message.role === 'assistant' && message.text.includes('source-fixture-turn-started'))).toBe(true));
    });
    expect(rejected.result.pending).toBe(true);
    expect(independent.result.pending).toBe(true);
    await act(async () => {
      rejected.result.reject(failure);
      await vi.waitFor(() => expect(aiEditRegistered(rejectedChannel)).toBe(false));
    });
    expect(rejectedChannel.cliRunIds.size).toBe(0);
    expect(rejectedChannel.liveSteer?.accepting).toBe(false);
    expect(getAiEditChannelsForSession(workspace.id, source.id)).toEqual([]);
    expect(sessionLiveStatus(sourceKey, useStore.getState())).toBeNull();
    expect(useStore.getState().sessions.find((session) => session.id === source.id)?.runStatus).toBe('error');
    expect(sessionRow(container, source.title).querySelector('[data-status="failed"]')).not.toBeNull();
    expect(sessionRow(container, source.title).classList.contains('ugs-sidebar-session--live')).toBe(false);
    expect(sessionRow(container, source.title).querySelector('[data-status="running"]')).toBeNull();
    rejected.listeners.forEach((listener) => expect(listener.unlisten).toHaveBeenCalledOnce());

    // The failed background session must not clear the active session or its
    // pending follow-ups, nor cancel a CLI belonging to the other session.
    expect(useStore.getState()).toMatchObject({
      activeSessionId: other.id, aiStreaming: true, chattingSessions: [otherKey],
      aiEditingSessions: [], runningSessions: [], waitingInputSessions: [],
      queuedChatMessageIds: queuedIds, steerableQueuedChatMessageIds: queuedIds,
    });
    expect(sessionLiveStatus(otherKey, useStore.getState())).toBe('running');
    expect(getAiEditChannelsForSession(workspace.id, other.id)).toEqual(independentChannels);
    independentChannels.forEach((channel) => expect(channel.abortController.signal.aborted).toBe(false));
    expect(independentChannel.cliRunIds).toEqual(new Set([independent.runId]));
    expect(independentChannel.liveSteer?.accepting).toBe(true);
    expect(independent.result.pending).toBe(true);
    expect(invocations).toHaveLength(2);
    expect(listeners.size).toBe(3);
    independent.listeners.forEach((listener) => expect(listener.unlisten).not.toHaveBeenCalled());
    expect(sessionRow(container, other.title).querySelector('[data-status="running"]')).not.toBeNull();

    await act(async () => {
      emit('ai-cli-progress', { runId: rejected.runId, text: 'late-progress-from-closed-run\n' });
      emit('ai-cli-progress', { runId: independent.runId, text: 'independent-fixture-still-running\n' });
      await vi.waitFor(() => expect(useStore.getState().messages.some((message) =>
        message.text.includes('independent-fixture-still-running'))).toBe(true));
    });
    expect(useStore.getState().messages.some((message) =>
      message.text.includes('late-progress-from-closed-run') || message.text.includes(failure) ||
      message.text === sourcePrompt)).toBe(false);
    const failedRecord = await readPersistedSession(workspace.id, source.id);
    expect(failedRecord.meta?.runStatus).toBe('error');
    expect(failedRecord.messages.find((message) => message.role === 'assistant')?.text).toContain(failure);

    // Let the independent turn finish; its two deferred CLI calls must start in
    // FIFO order, once each, with the preceding answer and no source-session text.
    for (let index = 0; index < otherAnswers.length; index += 1) {
      const invocation = invocations[index + 1];
      expect(invocation.result.pending).toBe(true);
      expect(invocation.payload).toMatchObject({
        adapter: 'codex', cliCommand: CLI_ROUTE.cliCommand,
        envVars: { UGS_SESSION_ID: other.id, UGS_WORKSPACE_ID: workspace.id },
      });
      const prompt = String(invocation.payload.prompt);
      expect(prompt.endsWith(otherPrompts[index])).toBe(true);
      expect(prompt).not.toContain(sourcePrompt);
      expect(prompt).not.toContain(failure);
      for (const answer of otherAnswers.slice(0, index)) expect(prompt).toContain(answer);
      for (const future of otherPrompts.slice(index + 1)) expect(prompt).not.toContain(future);
      await act(async () => {
        invocation.result.resolve(otherAnswers[index]);
        if (index < otherAnswers.length - 1) {
          await vi.waitFor(() => expect(invocations).toHaveLength(index + 3));
        } else {
          await vi.waitFor(() => expect(useStore.getState().aiStreaming).toBe(false));
        }
      });
      expect(useStore.getState().queuedChatMessageIds).toEqual(queuedIds.slice(index + 1));
      invocation.listeners.forEach((listener) => expect(listener.unlisten).toHaveBeenCalledOnce());
    }
    expect(invocations).toHaveLength(4);
    expect(new Set(invocations.map((invocation) => invocation.runId)).size).toBe(4);
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'ai_cli')).toHaveLength(4);
    expect(ipc.invoke.mock.calls.some(([command]) => command === 'cancel_ai_cli')).toBe(false);
    expect(gateway.completeGatewayText).not.toHaveBeenCalled();
    expect(activeAiEditChannels()).toEqual([]);
    expect(listeners.size).toBe(0);
    expect(useStore.getState()).toMatchObject({
      aiStreaming: false, chattingSessions: [], queuedChatMessageIds: [], steerableQueuedChatMessageIds: [],
    });
    expect(sessionRow(container, other.title).querySelector('[data-status="running"]')).toBeNull();
    const savedOther = await readPersistedSession(workspace.id, other.id);
    expect(savedOther.meta?.runStatus).toBe('success');
    expect(savedOther.isWorkflow).toBe(false);
    expect(savedOther.workflow).toBeUndefined();
    expect(savedOther.messages.map((message) => message.role))
      .toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(savedOther.messages.filter((message) => message.role === 'user').map((message) => message.text))
      .toEqual(otherPrompts);
    const savedAnswers = savedOther.messages.filter((message) => message.role === 'assistant');
    savedAnswers.forEach((message, index) => {
      expect(message.text).toContain(otherAnswers[index]);
      expect(message.text).not.toContain(failure);
      expect(message.completedAt).toEqual(expect.any(Number));
    });
    expect((await readPersistedSession(workspace.id, source.id)).meta?.runStatus).toBe('error');
  });
});
