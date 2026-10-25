import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { simpleBlueprint } from '@/core/defaultBlueprint';
import { defaultComposer } from './sampleSessions';
import type { SkillMutationResult, SkillOrigin, SkillReviewState } from '@/runtime/skills/types';

const mocks = vi.hoisted(() => ({
  nativeAvailable: false,
  requestExplicitSkillLearning: vi.fn(),
  performSkillReviewAction: vi.fn(),
  completeGatewayText: vi.fn(),
}));
vi.mock('@/lib/tauri', async (original) => ({
  ...await original<typeof import('@/lib/tauri')>(),
  tauriAvailable: () => mocks.nativeAvailable,
  isTauri: () => false,
}));
vi.mock('@/lib/skillLearningDesktop', async (original) => ({
  ...await original<typeof import('@/lib/skillLearningDesktop')>(),
  requestExplicitSkillLearning: mocks.requestExplicitSkillLearning,
  performSkillReviewAction: mocks.performSkillReviewAction,
}));
vi.mock('@/lib/modelGateway/modelGateway', async (original) => ({
  ...await original<typeof import('@/lib/modelGateway/modelGateway')>(),
  completeGatewayText: mocks.completeGatewayText,
}));

import { useStore, __resetSimpleChatRuntimeForTests } from './useStore';
import { historyStore } from './history/store';
import { remoteWorkspacePath, RunnerClient, saveRemoteWorkspace } from '@/lib/remoteWorkspace';
import { CLOUD_PROJECTS_ENABLED } from '@/lib/cloudProjects';

const origin: SkillOrigin = {
  hostId: 'local', workspaceId: '__default__', sessionId: 'skills-source',
  turnId: 'real-user', runId: 'original-execution',
};
const applied = (source: SkillOrigin): SkillMutationResult => ({
  origin: source, status: 'applied', batchId: 'explicit-batch',
  lesson: 'Read the manifest before selecting dependencies.', operationsApplied: 1,
  changes: [], riskReasons: [], rollbackId: 'explicit-rollback',
});
async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for persisted skill state');
}
type LearningActions = {
  learnSkills(kind: 'learn' | 'refine', text: string): boolean;
  reviewSkillLearningAction(state: SkillReviewState, action: 'approve' | 'reject' | 'rollback', id: string): Promise<SkillMutationResult>;
  updateSkillLearningState(messageId: string, state: SkillReviewState): Promise<void>;
};
const actions = () => useStore.getState() as ReturnType<typeof useStore.getState> & LearningActions;

beforeEach(async () => {
  mocks.nativeAvailable = false;
  mocks.requestExplicitSkillLearning.mockReset();
  mocks.performSkillReviewAction.mockReset();
  mocks.completeGatewayText.mockReset();
  __resetSimpleChatRuntimeForTests();
  window.localStorage.clear();
  await historyStore.createSession({
    workspaceId: origin.workspaceId, id: origin.sessionId, isWorkflow: false,
    messages: [{ id: origin.turnId, role: 'user', text: 'Check dependencies.', createdAt: 1,
      skillContext: { origin, loadedSkills: [], catalogRevision: 'source-revision' } }],
  });
  const source = (await historyStore.getSession(origin.workspaceId, origin.sessionId))!;
  useStore.setState({
    workflow: simpleBlueprint('Skill source'), composer: { ...defaultComposer },
    historyReady: true, activeWorkspaceId: source.workspaceId, activeSessionId: source.id,
    messages: source.messages, sessions: [], sessionTree: {}, workspaces: [],
    mode: 'design', aiStreaming: false, aiEditingSessions: [], chattingSessions: [],
    runningSessions: [], waitingInputSessions: [], blockedSendTip: null,
  });
});
afterEach(() => {
  mocks.nativeAvailable = false;
  __resetSimpleChatRuntimeForTests();
  vi.restoreAllMocks();
});

describe('skill learning store actions', () => {
  it.runIf(CLOUD_PROJECTS_ENABLED)('approves a remote frozen batch in its original local history bucket after navigation', async () => {
    const workspace = await historyStore.resolveWorkspaceByPath(remoteWorkspacePath('remote-control-fixture'));
    saveRemoteWorkspace({ id: 'remote-control-fixture', label: 'Remote control fixture',
      serverUrl: 'https://remote-fixture.test', projectId: 'server-project', adapter: 'codex' });
    const remoteOrigin: SkillOrigin = { hostId: 'ugs-remote-runner', workspaceId: 'server-project',
      sessionId: 'remote-source', turnId: 'remote-user', runId: 'saved-remote-job' };
    const sourceSession = { workspaceId: workspace.id, sessionId: remoteOrigin.sessionId,
      serverUrl: 'https://remote-fixture.test' };
    const pending: SkillReviewState = {
      origin: remoteOrigin, sourceSession, mode: 'approve-all', status: 'awaiting_approval',
      result: { ...applied(remoteOrigin), status: 'awaiting_approval', operationsApplied: 0 },
    };
    const card = { id: 'saved-remote-card', role: 'assistant' as const, text: '', createdAt: 2,
      localOnly: true, skillLearning: pending };
    await historyStore.createSession({ workspaceId: workspace.id, id: remoteOrigin.sessionId, isWorkflow: false,
      messages: [{ id: remoteOrigin.turnId, role: 'user', text: 'Remote task.', createdAt: 1,
        skillContext: { origin: remoteOrigin, loadedSkills: [], catalogRevision: 'remote-catalog' } }, card] });
    const currentMessages = useStore.getState().messages;
    const client = new RunnerClient(sourceSession.serverUrl, 'fixture-only-token');
    vi.spyOn(RunnerClient, 'fromWorkspaceAsync').mockResolvedValue(client);
    vi.spyOn(RunnerClient.prototype, 'getProject').mockResolvedValue({
      id: remoteOrigin.workspaceId, label: 'Remote control fixture', repoUrl: '', createdAt: 1, updatedAt: 1,
    });
    const confirmed = applied(remoteOrigin);
    const transport = vi.spyOn(RunnerClient.prototype, 'skillRequest').mockImplementation(async (projectId, request, options) => {
      expect(projectId).toBe('server-project');
      expect(request.origin).toEqual(remoteOrigin);
      expect(request.mode).toBe('approve-all');
      expect(options).toEqual({ ownerControl: true });
      expect(request).not.toHaveProperty('sourceSession');
      if (request.action === 'approve') {
        expect(request.batchId).toBe(pending.result!.batchId);
        return confirmed;
      }
      if (request.action === 'history') return { results: [confirmed] };
      throw new Error(`Unexpected fixture action: ${request.action}`);
    });
    const result = await actions().reviewSkillLearningAction(pending, 'approve', pending.result!.batchId);
    await actions().updateSkillLearningState(card.id, { ...pending, status: result.status, action: 'approve', result });
    const saved = await historyStore.getSession(workspace.id, remoteOrigin.sessionId);
    expect(saved?.messages.find((message) => message.id === card.id)?.skillLearning)
      .toEqual({ ...pending, status: 'applied', action: 'approve', result });
    expect(saved?.messages.filter((message) => message.skillLearning)).toHaveLength(1);
    expect(useStore.getState().messages).toEqual(currentMessages);
    expect(await historyStore.getSession('server-project', remoteOrigin.sessionId)).toBeNull();
    expect(transport.mock.calls.map(([, request]) => request.action)).toEqual(['approve', 'history']);
    expect(mocks.performSkillReviewAction).not.toHaveBeenCalled();
  });

  it('rejects a changed frozen mode instead of rewriting the saved review card', async () => {
    const reviewOrigin = { ...origin, runId: 'mode-review' };
    const saved: SkillReviewState = { origin: reviewOrigin, mode: 'approve-all', status: 'awaiting_approval',
      result: { ...applied(reviewOrigin), status: 'awaiting_approval', operationsApplied: 0 } };
    const card = { id: 'mode-review-card', role: 'assistant' as const, text: '', createdAt: 2,
      localOnly: true, skillLearning: saved };
    await historyStore.upsertMessage(origin.workspaceId, origin.sessionId, card);
    await expect(actions().updateSkillLearningState(card.id, { ...saved, mode: 'auto-safe' }))
      .rejects.toThrow('SKILL_REVIEW_MODE_MISMATCH');
    expect((await historyStore.getSession(origin.workspaceId, origin.sessionId))?.messages
      .find((message) => message.id === card.id)?.skillLearning).toEqual(saved);
  });

  it('approves the persisted frozen batch and updates its exact source card after navigation', async () => {
    const reviewOrigin = { ...origin, runId: 'saved-auxiliary-review' };
    const pending: SkillReviewState = { origin: reviewOrigin, mode: 'auto-safe', status: 'awaiting_approval',
      result: { ...applied(reviewOrigin), status: 'awaiting_approval', operationsApplied: 0 } };
    const card = { id: 'saved-review-card', role: 'assistant' as const, text: '', createdAt: 2,
      localOnly: true, skillLearning: pending };
    await historyStore.upsertMessage(origin.workspaceId, origin.sessionId, card);
    const other = await historyStore.createSession({
      workspaceId: origin.workspaceId, id: 'approval-other', isWorkflow: false,
      messages: [{ id: 'other-user', role: 'user', text: 'Unrelated work.', createdAt: 3 }],
    });
    useStore.setState({ messages: (await historyStore.getSession(origin.workspaceId, origin.sessionId))!.messages });
    mocks.performSkillReviewAction.mockImplementation(async (state, action) => {
      expect(state).toEqual(pending);
      expect(action).toBe('approve');
      useStore.setState({ activeSessionId: other.id, messages: other.messages });
      return applied(reviewOrigin);
    });
    const result = await actions().reviewSkillLearningAction(pending, 'approve', pending.result!.batchId);
    await actions().updateSkillLearningState(card.id, { ...pending, status: result.status, action: 'approve', result });
    const saved = (await historyStore.getSession(origin.workspaceId, origin.sessionId))!;
    expect(saved.messages.find((message) => message.id === card.id)?.skillLearning)
      .toEqual({ ...pending, status: 'applied', action: 'approve', result });
    expect(saved.messages.filter((message) => message.skillLearning)).toHaveLength(1);
    expect(useStore.getState().messages).toEqual(other.messages);
    expect((await historyStore.getSession(other.workspaceId, other.id))?.messages).toEqual(other.messages);
    expect(mocks.completeGatewayText).not.toHaveBeenCalled();
  });

  it('routes explicit learning through the bounded reviewer and preserves its source after navigation', async () => {
    const other = await historyStore.createSession({
      workspaceId: origin.workspaceId, id: 'other-session', isWorkflow: false,
      messages: [{ id: 'other-user', role: 'user', text: 'Other work.', createdAt: 2 }],
    });
    mocks.requestExplicitSkillLearning.mockImplementation(async (options) => {
      const record = await historyStore.getSession(origin.workspaceId, origin.sessionId);
      expect(record?.messages.find((message) => message.id === options.origin.turnId))
        .toMatchObject({ role: 'user', text: '/learn Read the manifest before selecting dependencies.', localOnly: true,
          skillContext: { origin: options.origin } });
      expect(options.kind).toBe('learn');
      expect(options.text).toBe('Read the manifest before selecting dependencies.');
      const reviewOrigin = { ...options.origin, runId: 'explicit-auxiliary-review' };
      options.onState?.({ origin: reviewOrigin, status: 'queued', mode: 'auto-safe' });
      useStore.setState({ activeSessionId: other.id, messages: other.messages });
      const result = applied(reviewOrigin);
      options.onState?.({ origin: reviewOrigin, status: 'applied', mode: 'auto-safe', result });
      return result;
    });
    mocks.nativeAvailable = true;
    expect(actions().learnSkills('learn', 'Read the manifest before selecting dependencies.')).toBe(true);
    mocks.nativeAvailable = false;
    await waitFor(async () => !!(await historyStore.getSession(origin.workspaceId, origin.sessionId))?.messages
      .find((message) => message.skillLearning?.status === 'applied'));
    const source = (await historyStore.getSession(origin.workspaceId, origin.sessionId))!;
    expect(source.messages.filter((message) => message.skillLearning)).toHaveLength(1);
    expect(source.messages.find((message) => message.skillLearning)?.skillLearning?.origin.runId).toBe('explicit-auxiliary-review');
    expect(useStore.getState().messages).toEqual(other.messages);
    expect((await historyStore.getSession(other.workspaceId, other.id))?.messages).toEqual(other.messages);
    expect(mocks.completeGatewayText).not.toHaveBeenCalled();
  });
});
