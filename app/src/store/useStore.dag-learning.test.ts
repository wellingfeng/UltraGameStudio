import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IRGraph } from '@/core/ir';
import type { SkillEntry, SkillLearningJob, SkillReadResult } from '@/runtime/skills/types';
import type { SkillServiceRequest } from '@/lib/skills';
import { defaultComposer } from './sampleSessions';
import type { RunChannel } from './channelTypes';
const native = vi.hoisted(() => ({ invoke: vi.fn(), complete: vi.fn(), resolve: vi.fn(), begin: vi.fn(), snapshots: [] as SkillLearningJob[], finishes: [] as ReturnType<typeof vi.fn>[] }));
vi.mock('@/lib/tauri', async (original) => ({ ...await original<typeof import('@/lib/tauri')>(), tauriAvailable: () => true, isTauri: () => false }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@/lib/modelGateway/modelGateway', async (original) => ({ ...await original<typeof import('@/lib/modelGateway/modelGateway')>(), completeGatewayText: native.complete, resolveDirectGatewayRoute: native.resolve }));
vi.mock('@/lib/skillLearningDesktop', async (original) => {
  const actual = await original<typeof import('@/lib/skillLearningDesktop')>();
  return { ...actual, beginSkillLearningTurn: (...args: Parameters<typeof actual.beginSkillLearningTurn>) => {
    native.begin(...args); const turn = actual.beginSkillLearningTurn(...args);
    const finish = vi.fn((result: Parameters<typeof turn.finish>[0]) => { native.snapshots.push(turn.getSnapshot()); return turn.finish(result); }); native.finishes.push(finish); return { ...turn, finish };
  } };
});
import { useStore, executeViaCliInterpreter, cancelGuiSkillRun, __resetSimpleChatRuntimeForTests } from './useStore';
import { historyStore } from './history/store';
import { activeRuns, activeAiEdits, aiEditSnapshots } from './channelRegistry';
import { runKey } from './sessionKey';
import { cancelSkillLearning } from '@/lib/skillLearningDesktop';
const entry: SkillEntry = { skillId: 'skill:dag-check', rootId: 'project:dag', name: 'dag-checks', description: 'Use when checking graphs.', scope: 'project', source: 'ugs-managed', relativePath: 'dag-checks', revision: 'r2', hash: 'h2', readOnly: false, autoEditable: true, contentLocked: false, pinned: false, state: 'active', files: ['SKILL.md'] };
const read: SkillReadResult = { entry, relativePath: 'SKILL.md', content: '---\nname: dag-checks\ndescription: Use when checking graphs.\n---\nRead the actual graph artifact.\n', revision: 'r2', hash: 'h2', fullRead: true, readReceiptId: 'dag-receipt', files: ['SKILL.md'] };
const prefix = 'ultragamestudio.history.v1:';
const workflow: IRGraph = { version: 1, meta: { name: 'DAG producer', adapter: 'codex' }, nodes: [
  { id: 'a', type: 'agent', params: { prompt: 'Use dag-checks.' } },
  { id: 'b', type: 'agent', params: { prompt: 'Use dag-checks.' } },
], edges: [], layout: {} };
let ch: RunChannel;
beforeEach(async () => {
  localStorage.clear(); __resetSimpleChatRuntimeForTests(); activeRuns.clear(); activeAiEdits.clear(); aiEditSnapshots.clear();
  native.begin.mockClear(); native.finishes.length = 0; native.snapshots.length = 0;
  native.invoke.mockReset().mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    if (command === 'history_read_json') return localStorage.getItem(prefix + args.relPath);
    if (command === 'history_write_json') { localStorage.setItem(prefix + args.relPath, String(args.json)); return; }
    if (command === 'history_list_dir') return [...new Set(Object.keys(localStorage).filter((key) => key.startsWith(prefix + (args.relPath ? args.relPath + '/' : ''))).map((key) => key.slice((prefix + (args.relPath ? args.relPath + '/' : '')).length).split('/')[0]))];
    if (command === 'history_root') return 'memory://dag-fixture';
    if (command === 'skills_bind_run' || command === 'skills_revoke_run') return;
    if (command === 'skills_request') {
      const request = args.request as SkillServiceRequest;
      return request.action === 'list' ? { revision: 'cat2', entries: [entry] } : request.action === 'view' ? read : entry;
    }
    throw new Error(`Unexpected fixture IPC: ${command}`);
  });
  native.resolve.mockReset().mockReturnValue({ adapter: 'codex', modelClass: 'default', model: 'fixture', mode: 'direct', transport: 'openai-compatible', label: 'Fixture', source: 'global' });
  native.complete.mockReset().mockImplementation(async (request) => {
    const event = { runId: request.runId ?? 'dag-node-native', toolCallId: 'check-1', toolName: 'command_execution', phase: 'end', provenance: 'native-tool', status: 'success', exitCode: 0, args: { command: 'node --test' }, result: '# tests 1\n# pass 1\n# fail 0\n' };
    request.onToolEvent?.({ ...event, phase: 'start' }); request.onToolEvent?.({ ...event, provenance: 'ui-synthetic' });
    request.onToolEvent?.(event); request.onToolEvent?.(event);
    return 'Graph checked.';
  });
  const source = { id: 'user-dag-source', role: 'user' as const, text: 'Use dag-checks on both nodes.', createdAt: 1 };
  const session = await historyStore.createSession({ workspaceId: '__default__', id: `dag-${crypto.randomUUID()}`, isWorkflow: true, workflow, messages: [source] });
  ch = { key: runKey(session.workspaceId, session.id), workspaceId: session.workspaceId, sessionId: session.id, cancelled: false, workflow: structuredClone(workflow), config: { permission: 'full', model: 'default', gatewaySelection: { adapter: 'codex', modelClass: 'default' } }, cliRunIds: new Set(), messages: [source], runState: {}, runOutputs: {}, failedNodeId: null, error: null };
  activeRuns.set(ch.key, ch);
  useStore.setState({ ...useStore.getInitialState(), workflow: ch.workflow, composer: { ...defaultComposer }, historyReady: true, activeWorkspaceId: ch.workspaceId, activeSessionId: ch.sessionId, mode: 'running', messages: [...ch.messages], personalInstructions: '', workspaces: [], sessions: [], sessionTree: {} });
});
afterEach(() => { cancelSkillLearning(); __resetSimpleChatRuntimeForTests(); activeRuns.clear(); activeAiEdits.clear(); aiEditSnapshots.clear(); vi.restoreAllMocks(); });
describe('GUI DAG host producer (retired orchestration switch unchanged)', () => {
  it('does not dispatch node models when native context write acknowledgement lacks disk readback', async () => {
    const invoke = native.invoke.getMockImplementation()!;
    native.invoke.mockImplementation(async (command, args = {}) => {
      if (command === 'history_write_json' && String(args.json).includes('"skillContext"')) return;
      return invoke(command, args);
    });
    await executeViaCliInterpreter(ch, ch.workflow, 'codex', Date.now());
    expect(native.complete).not.toHaveBeenCalled();
    expect(native.finishes[0].mock.calls[0][0].terminal).toBe('failed');
    expect(native.snapshots[0].origin.turnId).toBe('user-dag-source');
  });

  it('stops scheduling nodes when its source run is cancelled during context persistence', async () => {
    const write = historyStore.upsertMessage.bind(historyStore);
    vi.spyOn(historyStore, 'upsertMessage').mockImplementation(async (...args) => {
      await write(...args);
      if (args[2].skillContext) cancelGuiSkillRun(ch);
    });
    await executeViaCliInterpreter(ch, ch.workflow, 'codex', Date.now());
    expect(native.complete).not.toHaveBeenCalled();
    expect(native.finishes[0].mock.calls[0][0].terminal).toBe('cancelled');
  });

  it('retains only real native completions and deduplicates parallel delivery before terminal review', async () => {
    await executeViaCliInterpreter(ch, ch.workflow, 'codex', Date.now());
    expect(native.snapshots).toHaveLength(1);
    const evidence = native.snapshots[0].evidence;
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ provenance: 'native-tool', toolCallId: 'check-1', status: 'success',
      origin: { workspaceId: ch.workspaceId, sessionId: ch.sessionId, turnId: 'user-dag-source' } });
  });

  it('derives its persisted source and supplies fresh context to the actual outgoing node payload', async () => {
    await executeViaCliInterpreter(ch, ch.workflow, 'codex', Date.now());
    expect(native.begin).toHaveBeenCalledTimes(1);
    expect(native.begin.mock.calls[0][0].origin).toMatchObject({ hostId: 'local', workspaceId: ch.workspaceId, sessionId: ch.sessionId, turnId: 'user-dag-source' });
    expect(native.complete).toHaveBeenCalledTimes(2);
    expect(native.complete.mock.calls.every(([request]) => request.userContent.includes('Read the actual graph artifact.'))).toBe(true);
    const record = await historyStore.getSession(ch.workspaceId!, ch.sessionId!);
    expect(record?.messages.find((message) => message.id === 'user-dag-source')?.skillContext?.loadedSkills).toEqual([{ skillId: entry.skillId, revision: read.revision, hash: read.hash, files: read.files }]);
    expect(native.finishes[0]).toHaveBeenCalledTimes(1);
    expect(native.finishes[0].mock.calls[0][0]).toMatchObject({ terminal: 'completed' });
  });
});
