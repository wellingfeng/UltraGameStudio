import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { simpleBlueprint } from '@/core/defaultBlueprint';
import { defaultComposer } from './sampleSessions';
import type { RemoteJob } from '@ugs/protocol';
import type { SkillOrigin, SkillReadResult } from '@/runtime/skills/types';
const remote = vi.hoisted(() => ({
  workspace: { id: 'producer-remote', label: 'Fixture server project', projectId: 'fixture-server-project',
    serverUrl: 'https://producer.remote.fixture', adapter: 'codex' as const, createdAt: 1, updatedAt: 1 },
  create: vi.fn(), request: vi.fn(), stream: vi.fn(), complete: vi.fn(), resolve: vi.fn(),
}));
vi.mock('@/lib/cloudProjects', () => ({ CLOUD_PROJECTS_ENABLED: true, assertCloudProjectsEnabled: () => {},
  isSupportedWorkspacePath: () => true, isSupportedProviderId: () => true }));
vi.mock('@/lib/tauri', async (original) => ({ ...await original<typeof import('@/lib/tauri')>(),
  tauriAvailable: () => false, isTauri: () => false,
}));
vi.mock('@/lib/remoteWorkspace', async (original) => ({ ...await original<typeof import('@/lib/remoteWorkspace')>(),
  getRemoteWorkspace: () => ({ ...remote.workspace }), readRemoteSecrets: () => ({}),
  ensureRemoteWorkspaceProject: async (config: unknown) => config,
  resolveRemoteRunnerConnectionAsync: async () => ({ serverUrl: remote.workspace.serverUrl, token: 'fixture-transport-only' }),
}));
vi.mock('@/lib/modelGateway/modelGateway', async (original) => ({ ...await original<typeof import('@/lib/modelGateway/modelGateway')>(),
  completeGatewayText: remote.complete, resolveDirectGatewayRoute: remote.resolve,
}));
import { useStore, __resetSimpleChatRuntimeForTests } from './useStore';
import { historyStore } from './history/store';
import { RunnerClient } from '@/lib/remoteWorkspace';
import { activeAiEdits, aiEditSnapshots } from './channelRegistry';
const learned: SkillReadResult = { entry: { skillId: 'skill:remote-producer', rootId: 'project:remote', name: 'remote-checks',
  description: 'Use when running remote checks.', scope: 'project', source: 'ugs-managed', relativePath: 'remote-checks',
  revision: 'server-r2', hash: 'server-h2', readOnly: false, autoEditable: true, contentLocked: false,
  pinned: false, state: 'active', files: ['SKILL.md'] }, relativePath: 'SKILL.md',
  content: '---\nname: remote-checks\ndescription: Use when running remote checks.\n---\nRead the original server artifact.\n',
  revision: 'server-r2', hash: 'server-h2', fullRead: true, readReceiptId: 'server-receipt', files: ['SKILL.md'] };
beforeEach(async () => {
  localStorage.clear(); __resetSimpleChatRuntimeForTests(); activeAiEdits.clear(); aiEditSnapshots.clear();
  remote.resolve.mockReset().mockReturnValue(null); remote.complete.mockReset(); remote.stream.mockReset();
  remote.request.mockReset().mockImplementation(async (_project, payload) => payload.action === 'list'
    ? { revision: 'server-catalog', entries: [learned.entry] } : payload.action === 'view' ? learned : learned.entry);
  vi.spyOn(RunnerClient.prototype, 'skillRequest').mockImplementation(remote.request);
  vi.spyOn(RunnerClient.prototype, 'createJob').mockImplementation(remote.create.mockReset().mockImplementation(async (input) => ({
    id: 'server-producer-job', status: 'running', projectId: input.projectId,
    skillOrigin: input.skillSource ? { hostId: 'ugs-remote-runner', workspaceId: input.projectId,
      ...input.skillSource, runId: 'server-producer-job' } : undefined,
    createdAt: 1, updatedAt: 1, adapter: 'codex', model: null, prompt: input.prompt,
    repoUrl: null, branch: null, pushBranch: null, logs: [], messages: [], result: null, error: null,
  } as RemoteJob)));
  vi.spyOn(RunnerClient.prototype, 'streamJob').mockImplementation(remote.stream.mockReturnValue(() => {}));
  vi.spyOn(RunnerClient.prototype, 'cancelJob').mockResolvedValue({ ok: true } as never);
  const source = await historyStore.createSession({ workspaceId: '__default__', id: `remote-producer-${crypto.randomUUID()}`,
    isWorkflow: false, messages: [] });
  useStore.setState({ ...useStore.getInitialState(), workflow: simpleBlueprint('Remote producer'),
    composer: { ...defaultComposer, workspace: `remote://${remote.workspace.id}` }, historyReady: true,
    activeWorkspaceId: source.workspaceId, activeSessionId: source.id, mode: 'design',
    messages: [], workspaces: [{ id: source.workspaceId, path: `remote://${remote.workspace.id}`, name: 'Fixture remote',
      updatedAt: 1, sessionCount: 1 }], sessions: [], sessionTree: {}, personalInstructions: '' });
});
afterEach(() => {
  for (const ch of activeAiEdits.values()) ch.abortController.abort();
  __resetSimpleChatRuntimeForTests(); activeAiEdits.clear(); aiEditSnapshots.clear(); vi.restoreAllMocks();
});

describe('sendPrompt conditional remote producer (cloud feature remains retired)', () => {
  it('persists the real terminal review state to the originating bucket after navigation', async () => {
    const { activeWorkspaceId: workspaceId, activeSessionId: sessionId } = useStore.getState();
    const completed = vi.fn(async () => ({ text: '{"version":1,"kind":"noop","reason":"No reusable rule."}' }));
    vi.spyOn(await import('@/lib/modelGateway/skillReviewGateway'), 'createSkillReviewModelPort')
      .mockReturnValue({ capability: 'completion-only', complete: completed });
    vi.spyOn(RunnerClient.prototype, 'getProjectSkillConfig').mockResolvedValue({
      ...(await import('@/lib/skillLearningConfig')).DEFAULT_SKILL_LEARNING_CONFIG, activityThreshold: 1, cooldownMs: 0 });
    const getJob = vi.spyOn(RunnerClient.prototype, 'getJob').mockImplementation(async () => {
      const channelSource = (await historyStore.getSession(workspaceId!, sessionId!))!.messages.find((message) => message.role === 'user')!;
      return { ...await remote.create.mock.results[0].value, status: 'done', messages: [{ at: 1, role: 'tool',
        kind: 'tool', phase: 'end', provenance: 'native-tool', status: 'success', runId: 'server-producer-job',
        toolCallId: 'verified-check', toolName: 'command_execution', args: { command: 'node --test' },
        result: '# tests 1\n# pass 1\n# fail 0\n', toolExitCode: 0 }],
        skillOrigin: { hostId: 'ugs-remote-runner', workspaceId: remote.workspace.projectId, sessionId,
          turnId: channelSource.id, runId: 'server-producer-job' } } as RemoteJob;
    });
    expect(useStore.getState().sendPrompt('Check the remote project.')).toBe(true);
    await vi.waitFor(() => expect(remote.stream).toHaveBeenCalledTimes(1));
    const other = await historyStore.createSession({ workspaceId: '__default__', id: `other-${crypto.randomUUID()}`, isWorkflow: false,
      messages: [{ id: 'other-input', role: 'user', text: 'Different task.', createdAt: 2 }] });
    useStore.setState({ activeSessionId: other.id, messages: other.messages });
    remote.stream.mock.calls[0][1].onResult({ ...await remote.create.mock.results[0].value, status: 'done' });
    await vi.waitFor(async () => {
      const record = await historyStore.getSession(workspaceId!, sessionId!);
      expect(record?.messages.find((message) => message.skillLearning?.status === 'noop')?.skillLearning)
        .toMatchObject({ origin: { workspaceId: remote.workspace.projectId, sessionId, runId: 'server-producer-job' },
          sourceSession: { workspaceId, sessionId, serverUrl: remote.workspace.serverUrl } });
    });
    expect(getJob).toHaveBeenCalledWith('server-producer-job');
    expect(completed).toHaveBeenCalledTimes(1);
    expect(useStore.getState().messages).toEqual(other.messages);
    expect(remote.complete).not.toHaveBeenCalled();
  });

  it('rejects a failed source append before any remote read or outgoing job', async () => {
    vi.spyOn(historyStore, 'appendMessage').mockRejectedValue(new Error('REMOTE_SOURCE_WRITE_FAILED'));
    expect(useStore.getState().sendPrompt('Check the remote project.')).toBe(true);
    await vi.waitFor(() => expect(useStore.getState().chattingSessions).toHaveLength(0));
    expect(remote.request).not.toHaveBeenCalled(); expect(remote.create).not.toHaveBeenCalled();
    expect(useStore.getState().messages.some((message) => message.text.includes('REMOTE_SOURCE_WRITE_FAILED'))).toBe(true);
  });

  it('routes repeated candidates to the authenticated server rather than a local store', async () => {
    const { createRemoteSkillCandidateStore } = await import('@/lib/remoteSkillLearning');
    const requests: unknown[] = [];
    const client = new RunnerClient('https://candidate.fixture', 'fixture-only');
    let durable = { version: 1 as const, revision: 0, candidates: [] };
    Object.assign(client, { skillCandidateRequest: vi.fn(async (projectId, request) => {
      requests.push({ projectId, request: structuredClone(request) });
      if (request.action === 'compare_and_swap') durable = { ...structuredClone(request.list), revision: request.expectedRevision + 1 };
      return structuredClone(durable);
    }) });
    const store = createRemoteSkillCandidateStore({ client, projectId: remote.workspace.projectId,
      origin: { hostId: 'ugs-remote-runner', workspaceId: remote.workspace.projectId, sessionId: 'server-source', turnId: 'server-turn', runId: 'server-job' } });
    expect(await store.load()).toEqual(durable);
    await store.save({ ...durable, seenSources: ['exact-source'] });
    expect((await store.load()).seenSources).toEqual(['exact-source']);
    expect(requests).toHaveLength(3);
    expect(localStorage.getItem('ultragamestudio.skill-learning.pre-review.v1')).toBeNull();
  });

  it('forwards the real source and selected skills into the outgoing server job', async () => {
    const { activeWorkspaceId: workspaceId, activeSessionId: sessionId } = useStore.getState();
    expect(useStore.getState().sendPrompt('Use remote-checks.', { skillIds: [learned.entry.skillId] })).toBe(true);
    await vi.waitFor(() => expect(remote.create, JSON.stringify(useStore.getState().messages)).toHaveBeenCalledTimes(1));
    const source = useStore.getState().messages.find((message) => message.role === 'user')!;
    const input = remote.create.mock.calls[0][0];
    expect(input.skillSource).toEqual({ sessionId, turnId: source.id });
    expect(input.prompt).toContain(learned.content.replace(/\n/g, '\\n'));
    await vi.waitFor(() => expect(remote.stream).toHaveBeenCalledTimes(1));
    const record = await historyStore.getSession(workspaceId!, sessionId!);
    expect(record?.messages.find((message) => message.id === source.id)?.skillContext).toMatchObject({
      origin: { hostId: 'ugs-remote-runner', workspaceId: remote.workspace.projectId, sessionId: sessionId!,
        turnId: source.id, runId: 'server-producer-job' } satisfies SkillOrigin,
      sourceSession: { workspaceId, sessionId, serverUrl: remote.workspace.serverUrl },
      loadedSkills: [{ skillId: learned.entry.skillId, revision: learned.revision }],
    });
    expect(remote.complete).not.toHaveBeenCalled();
  });
});
