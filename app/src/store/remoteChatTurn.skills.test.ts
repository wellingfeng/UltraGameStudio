import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_SKILL_HOST_ID } from '@ugs/protocol';
import type { CreateRemoteJobInput, RemoteJob } from '@ugs/protocol';
import type { SkillEntry, SkillOrigin, SkillReadResult, SkillReviewState } from '@/runtime/skills/types';
import type { AiEditChannel } from './channelTypes';
import { startRemoteChatTurn } from './remoteChatTurn';
import type { StartRemoteChatTurnOptions } from './remoteChatTurn';
import { DEFAULT_SKILL_LEARNING_CONFIG } from '@/lib/skillLearningConfig';
import { createRemoteSkillCandidateStore, type RemoteSkillCandidateClient } from '@/lib/remoteSkillLearning';
import { RunnerClient } from '@ugs/protocol';
import type { SkillCandidateList } from '@/runtime/skills/preReview';
import { acquireReviewBackground } from '@/runtime/memory/review';

// All network, connection and credential values in this file are fixtures.
// The real chat entry point, RunnerClient and remote skill runtime are exercised.
const remoteFixture = vi.hoisted(() => ({
  workspace: { id: 'fixture-cloud-workspace', label: 'Fixture cloud', projectId: 'fixture-project',
    serverUrl: 'https://remote-chat.fixture', adapter: 'claude' as const, useOwnModelKey: false,
    createdAt: 0, updatedAt: 0 },
  filesUpdated: vi.fn(),
}));
vi.mock('@/lib/remoteWorkspace', async () => {
  const protocol = await import('@ugs/protocol');
  return { ...protocol,
    getRemoteWorkspace: () => ({ ...remoteFixture.workspace }),
    ensureRemoteWorkspaceProject: async (config: unknown) => config,
    resolveRemoteRunnerConnectionAsync: async () => ({ serverUrl: 'https://remote-chat.fixture', token: 'fixture-auth' }),
    readRemoteSecrets: () => ({}),
    remoteWorkspaceIdFromPath: () => remoteFixture.workspace.id,
    parseRemoteProviderId: () => null,
    isRemoteRunnerProvider: () => false,
    isClaudeFamilyModel: () => false,
    notifyRemoteWorkspaceFilesUpdated: remoteFixture.filesUpdated,
  };
});
vi.mock('@/lib/apiConfig', () => ({ listProviders: () => [], canUseProviderDirectTransport: () => true }));
vi.mock('@/lib/gatewayConfig', () => ({ listGatewayProviders: () => [{ id: 'fixture-review-provider', name: 'Fixture HTTP',
  adapter: 'codex', channels: [{ id: 'fixture-http', name: 'Fixture HTTP channel', baseUrl: 'https://review.fixture',
    apiKey: 'fixture-review-auth', route: { transport: 'openai-compatible', model: 'fixture-review-model', baseUrl: 'https://review.fixture' } }] }] }));
vi.mock('@/lib/tauri', () => ({ tauriFetch: (url: string, init?: RequestInit) => fetch(url, init) }));
vi.mock('@/lib/anthropic', () => ({ SIMPLE_CHAT_SYSTEM: 'Fixture system.',
  REMOTE_BACKGROUND_JOB_INSTRUCTION: 'Fixture foreground rule.', buildAssetCapabilityBlock: () => '' }));
vi.mock('@/runtime', () => ({ WORKSPACE_LAYOUT_DIRECTIVE: 'Fixture layout.' }));
vi.mock('@/lib/knowledgeBase', () => ({ renderKnowledgeBaseContextForPrompt: async () => '' }));
vi.mock('@/lib/imageGeneration', () => ({ preferredReadyImageProviderId: () => null }));
vi.mock('@/lib/musicGeneration', () => ({ preferredReadyMusicProviderId: () => null }));
vi.mock('@/lib/speechGeneration', () => ({ preferredReadySpeechProviderId: () => null }));
vi.mock('@/lib/spriteGeneration', () => ({ preferredReadySpriteProviderId: () => null }));
vi.mock('@/lib/threeDGeneration', () => ({ preferredReadyThreeDProviderId: () => null }));
vi.mock('@/lib/videoGeneration', () => ({ preferredReadyVideoProviderId: () => null }));
vi.mock('@/lib/animationGeneration', () => ({ preferredReadyAnimationProviderId: () => null }));

const sourceOrigin: SkillOrigin = { hostId: REMOTE_SKILL_HOST_ID, workspaceId: 'fixture-project',
  sessionId: 'fixture-source-session', turnId: 'fixture-source-message', runId: 'fixture-job' };
const skillEntry: SkillEntry = { skillId: 'skill:fixture-remote', rootId: 'project:fixture', name: 'remote-checks',
  description: 'Use when running remote checks.', scope: 'project', source: 'ugs-managed', relativePath: 'remote-checks',
  revision: 'fixture-r1', hash: 'fixture-h1', readOnly: false, autoEditable: true, contentLocked: false,
  pinned: false, state: 'active', files: ['SKILL.md'] };
const skillRead: SkillReadResult = { entry: skillEntry, relativePath: 'SKILL.md',
  content: '---\nname: remote-checks\ndescription: Use when running remote checks.\n---\nRead the remote disk before applying changes.\n',
  revision: skillEntry.revision, hash: skillEntry.hash, fullRead: true, readReceiptId: 'fixture-prelaunch-receipt', files: ['SKILL.md'] };
const createdJob: RemoteJob = { id: sourceOrigin.runId, status: 'running', createdAt: 0, updatedAt: 0,
  projectId: sourceOrigin.workspaceId, skillOrigin: sourceOrigin, repoUrl: null, branch: null, adapter: 'claude',
  model: null, prompt: 'fixture', pushBranch: null, logs: [], messages: [], result: null, error: null };

type SkillCallbacks = {
  sourceMessageId: string;
  explicitSkillIds?: string[];
  onSkillContext?: (context: NonNullable<import('./types').Message['skillContext']>) => Promise<void>;
  onSkillReviewState?: (state: SkillReviewState) => void;
};
function createTurn(overrides: Partial<SkillCallbacks> = {}) {
  const ch: AiEditChannel = { key: 'fixture-channel', sessionKey: 'fixture-local-bucket:fixture-source-session',
    workspaceId: 'fixture-local-bucket', sessionId: sourceOrigin.sessionId,
    workflow: { version: 1, meta: { name: 'fixture-remote-chat' }, nodes: [], edges: [] }, messages: [
      { id: 'fixture-history', role: 'assistant', text: 'Untouched history.', createdAt: 0 },
      { id: sourceOrigin.turnId, role: 'user', text: 'Use remote-checks for this task.', createdAt: 1 },
    ], cliRunIds: new Set(), abortController: new AbortController(), workflowSession: false, chat: true,
    gatewaySelection: { adapter: 'claude-code', modelClass: 'default', providerId: 'fixture-foreground-cli' },
    ownedMessageIds: new Set() };
  const onSkillContext = vi.fn(async () => {});
  const onSkillReviewState = vi.fn();
  const options: StartRemoteChatTurnOptions & SkillCallbacks = {
    ch, prompt: ch.messages[1].text, workspacePath: 'remote://fixture-cloud-workspace', locale: 'zh-CN',
    sourceMessageId: sourceOrigin.turnId, ready: Promise.resolve(), onSkillContext, onSkillReviewState,
    projectEngineGuidance: '', personalBlock: '', gameExpertBlock: '', knowledgeBaseMode: false,
    aiEditCommitMessages: vi.fn(), commitAiChannelBlueprint: vi.fn(() => true),
    appendStartUserInputs: vi.fn((graph) => graph), syncAndPersistSessionRunStatus: vi.fn(),
    formatClock: () => 'fixture-clock', formatDuration: () => 'fixture-duration', removeAiEditChannel: vi.fn(),
    ...overrides,
  };
  return { ch, options, onSkillContext, onSkillReviewState };
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function reviewSlotFree() {
  const holder = acquireReviewBackground('eof-inspection');
  holder?.release();
  return !!holder;
}
function installServer() {
  const calls: Array<{ path: string; body?: Record<string, unknown>; headers: Headers }> = [];
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let job = structuredClone(createdJob);
  let snapshot: RemoteJob = { ...structuredClone(createdJob), status: 'done', result: { exitCode: 0 } };
  let contextError = false;
  let candidates: SkillCandidateList = { version: 1, revision: 0, candidates: [] };
  Object.assign(RunnerClient.prototype, { skillCandidateRequest: async (projectId: string, request: Parameters<RemoteSkillCandidateClient['skillCandidateRequest']>[1]) => {
    calls.push({ path: `/projects/${projectId}/skill-service/candidates`, body: structuredClone(request) as unknown as Record<string, unknown>, headers: new Headers() });
    if (request.action === 'compare_and_swap') {
      if (request.expectedRevision !== candidates.revision) throw new Error('SKILL_CANDIDATE_CONFLICT');
      candidates = { ...structuredClone(request.list!), revision: request.expectedRevision! + 1 };
    }
    return structuredClone(candidates);
  } });
  const config = { ...DEFAULT_SKILL_LEARNING_CONFIG, activityThreshold: 1, cooldownMs: 0,
    reviewSelection: { adapter: 'codex', modelClass: 'fast', providerId: 'fixture-review-provider',
      channelId: 'fixture-http', model: 'fixture-selected-review-model' } };
  const applied = { status: 'applied' as const, batchId: 'fixture-host-batch', origin: structuredClone(sourceOrigin),
    lesson: 'Keep fresh remote receipts.', operationsApplied: 1, changes: [], riskReasons: [], rollbackId: 'fixture-rollback' };
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ path, body, headers: new Headers(init?.headers) });
    if (path === '/v1/chat/completions') {
      const messages = body?.messages as Array<{ content: string }>;
      if (messages[0].content.includes('语义比对器')) {
        const comparison = JSON.parse(messages[1].content) as { candidates: Array<{ id: string }> };
        return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
          candidateId: comparison.candidates[0].id, similarity: 0.99,
        }) } }], usage: { prompt_tokens: 5, completion_tokens: 5 } });
      }
      const review = JSON.parse(messages[1].content) as { reads: Array<{ readReceiptId: string; hash: string }>;
        evidence: Array<{ evidenceId: string }> };
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ version: 1,
        kind: 'propose', lesson: applied.lesson, evidenceIds: review.evidence.map((item) => item.evidenceId),
        operations: [{ action: 'patch', skillId: skillEntry.skillId, oldString: 'Read the remote disk', newString: 'Fresh-read the remote disk',
          expectedHash: review.reads[0].hash, readReceiptId: review.reads[0].readReceiptId }] }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 20 } });
    }
    if (path.endsWith('/stream')) {
      const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
      return new Response(body, { status: 200 });
    }
    if (path === '/jobs' && init?.method === 'POST') return Response.json({ ok: true, job });
    if (path === `/jobs/${createdJob.id}/cancel`) return Response.json({ ok: true });
    if (path === `/jobs/${createdJob.id}`) return Response.json({ ok: true, job: snapshot });
    if (path.endsWith('/config')) return Response.json({ ok: true, config });
    if (path.endsWith('/skill-service')) {
      if (contextError) return Response.json({ ok: false, error: 'fixture context unavailable' }, { status: 503 });
      const result = body?.action === 'list' ? { revision: 'fixture-catalog', entries: [skillEntry] }
        : body?.action === 'view' ? { ...skillRead, readReceiptId: (body.origin as SkillOrigin).runId === sourceOrigin.runId
          ? 'fixture-review-fresh-receipt' : skillRead.readReceiptId }
          : body?.action === 'manage' ? applied : skillEntry;
      return Response.json({ ok: true, result });
    }
    throw new Error(`Unexpected fixture request: ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, config, fetchMock, setJob(value: RemoteJob) { job = value; },
    async primeRepeatedCandidate() {
      await createRemoteSkillCandidateStore({ client: new RunnerClient(remoteFixture.workspace.serverUrl, 'fixture-auth'),
        projectId: sourceOrigin.workspaceId, origin: sourceOrigin }).save({ version: 1, revision: 0, lastId: 'fixture-candidate', candidates: [{
        id: 'fixture-candidate', lesson: applied.lesson, context: 'Earlier verified remote task.',
        sources: [JSON.stringify(['fixture-prior-session', 'fixture-prior-turn'])], consecutive: 1, submitted: false,
      }] });
    },
    setSnapshot(value: RemoteJob) { snapshot = value; }, setContextError() { contextError = true; },
    emit(event: string, value: unknown) {
      if (!stream) throw new Error('Fixture stream not subscribed');
      stream.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`));
    },
    close() { try { stream?.close(); } catch { /* Already cancelled fixture reader. */ } },
  };
}

beforeEach(() => { remoteFixture.filesUpdated.mockClear(); });
afterEach(() => { delete (RunnerClient.prototype as RunnerClient & Partial<RemoteSkillCandidateClient>).skillCandidateRequest; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('remote chat skill wiring (fixture HTTP)', () => {
  it('reconciles a closed event stream against the exact terminal job and releases foreground without redispatch', async () => {
    const server = installServer();
    const { ch, options } = createTurn();
    startRemoteChatTurn(options);
    try {
      await vi.waitFor(() => expect(server.calls.some((call) => call.path.endsWith('/stream'))).toBe(true));
      expect(reviewSlotFree()).toBe(false);
      server.close();
      await vi.waitFor(() => expect(options.removeAiEditChannel).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(reviewSlotFree()).toBe(true));
      expect(ch.messages.at(-1)?.text).toContain('远程任务完成');
      expect(options.syncAndPersistSessionRunStatus).toHaveBeenCalledWith(
        { workspaceId: 'fixture-local-bucket', sessionId: sourceOrigin.sessionId }, 'success');
      expect(server.calls.filter(call => call.path === '/jobs')).toHaveLength(1);
      expect(server.calls.filter(call => call.path.endsWith('/cancel'))).toHaveLength(0);
    } finally { ch.abortController.abort(); server.close(); }
  });

  it('ends a closed stream with no terminal server result without retaining foreground or starting a review', async () => {
    const server = installServer();
    server.setSnapshot(structuredClone(createdJob));
    const { ch, options, onSkillReviewState } = createTurn();
    startRemoteChatTurn(options);
    try {
      await vi.waitFor(() => expect(server.calls.some((call) => call.path.endsWith('/stream'))).toBe(true));
      server.close();
      await vi.waitFor(() => expect(options.removeAiEditChannel).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(reviewSlotFree()).toBe(true));
      expect(options.syncAndPersistSessionRunStatus).toHaveBeenCalledWith(
        { workspaceId: 'fixture-local-bucket', sessionId: sourceOrigin.sessionId }, 'error');
      expect(onSkillReviewState).not.toHaveBeenCalled();
      expect(server.calls.filter(call => call.path === '/jobs')).toHaveLength(1);
      expect(server.calls.filter(call => call.path.endsWith('/cancel'))).toHaveLength(1);
      expect(server.calls.some(call => call.path === '/v1/chat/completions' || call.body?.action === 'manage')).toBe(false);
    } finally { ch.abortController.abort(); server.close(); }
  });

  it('does not read remote skills before exact source persistence resolves', async () => {
    const server = installServer();
    const ready = deferred<void>();
    const { ch, options } = createTurn();
    startRemoteChatTurn({ ...options, ready: ready.promise });
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(server.calls.filter((call) => call.path.endsWith('/skill-service'))).toEqual([]);
      ready.resolve();
      await vi.waitFor(() => expect(server.calls.some((call) => call.path === '/jobs')).toBe(true));
    } finally { ready.resolve(); ch.abortController.abort(); server.close(); }
  });

  it('bounds closed-stream read-only reconciliation and ignores a late terminal snapshot', async () => {
    const server = installServer();
    const saved = deferred<RemoteJob>();
    let lookupSignal: AbortSignal | undefined;
    const lookup = vi.spyOn(RunnerClient.prototype, 'getJob').mockImplementation((_id, request) => {
      lookupSignal = request?.signal;
      return saved.promise;
    });
    const { ch, options } = createTurn();
    startRemoteChatTurn(options);
    try {
      await vi.waitFor(() => expect(server.calls.some((call) => call.path.endsWith('/stream'))).toBe(true));
      vi.useFakeTimers();
      server.close();
      for (let i = 0; i < 100; i++) await Promise.resolve();
      expect(lookup).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10_001);
      expect(lookupSignal?.aborted).toBe(true);
      expect(options.removeAiEditChannel).toHaveBeenCalledTimes(1);
      expect(reviewSlotFree()).toBe(true);
      const terminalText = ch.messages.at(-1)?.text;
      expect(terminalText).toContain('读取任务终态超时');
      saved.resolve({ ...structuredClone(createdJob), status: 'done', result: { exitCode: 0 } });
      for (let i = 0; i < 100; i++) await Promise.resolve();
      expect(ch.messages.at(-1)?.text).toBe(terminalText);
      expect(options.removeAiEditChannel).toHaveBeenCalledTimes(1);
      expect(server.calls.filter(call => call.path === '/jobs')).toHaveLength(1);
    } finally { vi.useRealTimers(); ch.abortController.abort(); server.close(); }
  });

  it('preloads only the new request and awaits persistence of the exact server origin before streaming', async () => {
    const server = installServer();
    const persisted = deferred<void>();
    const onSkillContext = vi.fn(() => persisted.promise);
    const { ch, options } = createTurn({ onSkillContext });
    startRemoteChatTurn(options);
    try {
      await vi.waitFor(() => expect(server.calls.some((call) => call.path === '/jobs')).toBe(true));
      const submission = server.calls.find((call) => call.path === '/jobs')!.body as unknown as CreateRemoteJobInput;
      expect(submission.skillSource).toEqual({ sessionId: sourceOrigin.sessionId, turnId: sourceOrigin.turnId });
      expect(submission).not.toHaveProperty('skillOrigin');
      const contextStart = submission.prompt.indexOf('<UGS_SKILL_CONTEXT>');
      expect(contextStart).toBeGreaterThan(submission.prompt.indexOf('用户：Use remote-checks for this task.'));
      const block = submission.prompt.split('<UGS_SKILL_CONTEXT>\n')[1]?.split('\n</UGS_SKILL_CONTEXT>')[0];
      expect(JSON.parse(block)[0].content).toBe(skillRead.content);
      expect(ch.messages[0].text).toBe('Untouched history.');
      const reads = server.calls.filter((call) => call.path.endsWith('/skill-service'));
      expect(reads.map((call) => call.body!.action)).toEqual(['list', 'view', 'usage']);
      for (const call of reads) {
        expect(call.body!.origin).toMatchObject({ ...sourceOrigin, runId: expect.any(String) });
        expect((call.body!.origin as SkillOrigin).runId).not.toBe(sourceOrigin.runId);
        expect(call.body!.origin).not.toHaveProperty('cwd');
        expect(call.headers.get('x-ugs-skill-control')).toBeNull();
      }
      expect(onSkillContext).toHaveBeenCalledWith({ origin: sourceOrigin,
        sourceSession: { workspaceId: 'fixture-local-bucket', sessionId: sourceOrigin.sessionId, serverUrl: 'https://remote-chat.fixture' },
        loadedSkills: [{ skillId: skillEntry.skillId, revision: skillEntry.revision, hash: skillEntry.hash, files: ['SKILL.md'] }],
        catalogRevision: 'fixture-catalog' });
      expect(server.calls.some((call) => call.path.endsWith('/stream'))).toBe(false);
      persisted.resolve();
      await vi.waitFor(() => expect(server.calls.some((call) => call.path.endsWith('/stream'))).toBe(true));
    } finally { persisted.resolve(); ch.abortController.abort(); server.close(); }
  });

  it('automatically reviews the original terminal native snapshot once and uses fresh review receipts', async () => {
    const server = installServer();
    await server.primeRepeatedCandidate();
    server.setSnapshot({ ...structuredClone(createdJob), status: 'done', result: { exitCode: 0 },
      messages: [{ at: 10, role: 'tool', kind: 'tool', runId: sourceOrigin.runId,
        toolCallId: 'fixture-native-check', toolName: 'command_execution', phase: 'end', provenance: 'native-tool',
        status: 'success', toolExitCode: 0, args: { command: 'node --test' }, result: '# tests 1\n# pass 1\n# fail 0\n' }] });
    const { ch, options, onSkillReviewState } = createTurn();
    ch.gatewaySelection = { adapter: 'codex', modelClass: 'fast', providerId: 'fixture-review-provider', channelId: 'fixture-http' };
    startRemoteChatTurn(options);
    try {
      await vi.waitFor(() => expect(server.calls.some((call) => call.path.endsWith('/stream'))).toBe(true));
      ch.workspaceId = 'fixture-navigated-bucket';
      ch.sessionId = 'fixture-navigated-session';
      options.sourceMessageId = 'fixture-navigated-turn';
      const terminal = { ...structuredClone(createdJob), status: 'done' as const,
        result: { exitCode: 0 }, messages: [{ at: 20, role: 'assistant' as const, kind: 'final' as const, text: 'Fixture task answer.' }] };
      server.emit('result', terminal);
      server.emit('result', terminal);
      await vi.waitFor(() => expect(onSkillReviewState).toHaveBeenCalledWith(expect.objectContaining({ status: 'applied' })), { timeout: 4000 });
      expect(server.calls.filter((call) => call.path === `/jobs/${sourceOrigin.runId}`)).toHaveLength(1);
      expect(server.calls.filter((call) => call.path === '/v1/chat/completions')).toHaveLength(2);
      const manage = server.calls.find((call) => call.body?.action === 'manage')!;
      expect(manage.body!.origin).toEqual(sourceOrigin);
      expect(manage.headers.get('x-ugs-skill-control')).toBeNull();
      expect(manage.body!.proposal).toMatchObject({ operations: [{ readReceiptId: 'fixture-review-fresh-receipt' }] });
      const reviewBody = server.calls.filter((call) => call.path === '/v1/chat/completions')[0]!.body!;
      const reviewInput = JSON.parse((reviewBody.messages as Array<{ content: string }>)[1].content);
      expect(reviewInput.evidence).toEqual([expect.objectContaining({ provenance: 'native-tool', origin: sourceOrigin,
        evidenceId: JSON.stringify([sourceOrigin.runId, 'fixture-native-check']) })]);
      expect(reviewInput.reads[0].readReceiptId).toBe('fixture-review-fresh-receipt');
      expect(reviewInput.reads[0].readReceiptId).not.toBe(skillRead.readReceiptId);
      expect(reviewInput.task.userText).toBe('Use remote-checks for this task.');
      expect(reviewInput.task.modelOutput).toBe('Fixture task answer.');
      expect(options.removeAiEditChannel).toHaveBeenCalledTimes(1);
      expect(options.syncAndPersistSessionRunStatus).toHaveBeenCalledWith(
        { workspaceId: 'fixture-local-bucket', sessionId: sourceOrigin.sessionId }, 'success');
    } finally { ch.abortController.abort(); server.close(); }
  });

  it('uses the server HTTP review selection even when the foreground channel is CLI-only', async () => {
    const server = installServer();
    await server.primeRepeatedCandidate();
    server.setSnapshot({ ...structuredClone(createdJob), status: 'done', result: { exitCode: 0 },
      messages: [{ at: 30, role: 'tool', kind: 'tool', runId: sourceOrigin.runId,
        toolCallId: 'fixture-config-review-check', toolName: 'command_execution', phase: 'end', provenance: 'native-tool',
        status: 'success', toolExitCode: 0, args: { command: 'node --test' }, result: '# tests 1\n# pass 1\n# fail 0\n' }] });
    const { ch, options, onSkillReviewState } = createTurn();
    startRemoteChatTurn(options);
    try {
      await vi.waitFor(() => expect(server.calls.some((call) => call.path.endsWith('/stream'))).toBe(true));
      server.emit('result', { ...structuredClone(createdJob), status: 'done', result: { exitCode: 0 } });
      await vi.waitFor(() => expect(onSkillReviewState).toHaveBeenCalledWith(expect.objectContaining({ status: 'applied' })), { timeout: 4000 });
      const requests = server.calls.filter((call) => call.path === '/v1/chat/completions').map((call) => call.body!);
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.model).toBe('fixture-selected-review-model');
        expect(request.stream).toBe(false);
        expect(request).not.toHaveProperty('tools');
      }
    } finally { ch.abortController.abort(); server.close(); }
  });

  it('does not grant learning authority when exact source metadata has no persistence callback', async () => {
    const server = installServer();
    server.setSnapshot({ ...structuredClone(createdJob), status: 'done', result: { exitCode: 0 },
      messages: [{ at: 31, role: 'tool', kind: 'tool', runId: sourceOrigin.runId,
        toolCallId: 'fixture-unpersisted-check', toolName: 'command_execution', phase: 'end', provenance: 'native-tool',
        status: 'success', toolExitCode: 0, args: { command: 'node --test' }, result: '# tests 1\n# pass 1\n# fail 0\n' }] });
    const { ch, options, onSkillReviewState } = createTurn({ onSkillContext: undefined });
    startRemoteChatTurn(options);
    try {
      await vi.waitFor(() => expect(server.calls.some((call) => call.path.endsWith('/stream'))).toBe(true));
      server.emit('result', { ...structuredClone(createdJob), status: 'done', result: { exitCode: 0 } });
      await vi.waitFor(() => expect(options.removeAiEditChannel).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(onSkillReviewState).not.toHaveBeenCalled();
      expect(server.calls.filter((call) => call.path === `/jobs/${sourceOrigin.runId}`)).toHaveLength(0);
      expect(server.calls.some((call) => call.body?.action === 'manage')).toBe(false);
    } finally { ch.abortController.abort(); server.close(); }
  });

  it('cancels a submitted job while source persistence is pending and never subscribes after cancellation', async () => {
    const server = installServer();
    const persisted = deferred<void>();
    const onSkillContext = vi.fn(() => persisted.promise);
    const { ch, options } = createTurn({ onSkillContext });
    startRemoteChatTurn(options);
    try {
      await vi.waitFor(() => expect(onSkillContext).toHaveBeenCalledTimes(1));
      ch.abortController.abort();
      await vi.waitFor(() => expect(server.calls.filter((call) => call.path === `/jobs/${sourceOrigin.runId}/cancel`)).toHaveLength(1));
      persisted.resolve();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(server.calls.some((call) => call.path.endsWith('/stream'))).toBe(false);
      expect(server.calls.some((call) => call.path === `/jobs/${sourceOrigin.runId}`)).toBe(false);
    } finally { persisted.resolve(); ch.abortController.abort(); server.close(); }
  });

  it('waits for the exact source session and user message write before submitting the remote job', async () => {
    const server = installServer();
    const sourceWrite = deferred<void>();
    const { ch, options } = createTurn();
    const ready = { ready: sourceWrite.promise };
    startRemoteChatTurn({ ...options, ...ready });
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(server.calls.some((call) => call.path.endsWith('/skill-service'))).toBe(false);
      expect(server.calls.some((call) => call.path === '/jobs')).toBe(false);
      sourceWrite.resolve();
      await vi.waitFor(() => expect(server.calls.some((call) => call.path.endsWith('/stream'))).toBe(true));
      expect(server.calls.find((call) => call.path === '/jobs')!.body!.skillSource)
        .toEqual({ sessionId: sourceOrigin.sessionId, turnId: sourceOrigin.turnId });
    } finally { sourceWrite.resolve(); ch.abortController.abort(); server.close(); }
  });

  it('does not invent a persisted source when the submission barrier is absent', async () => {
    const server = installServer();
    const { ch, options, onSkillContext, onSkillReviewState } = createTurn();
    const missingReady = { ready: undefined };
    startRemoteChatTurn({ ...options, ...missingReady });
    try {
      await vi.waitFor(() => expect(server.calls.some((call) => call.path.endsWith('/stream'))).toBe(true));
      expect(server.calls.find((call) => call.path === '/jobs')!.body).not.toHaveProperty('skillSource');
      expect(onSkillContext).not.toHaveBeenCalled();
      server.emit('result', { ...structuredClone(createdJob), status: 'done', result: { exitCode: 0 } });
      await vi.waitFor(() => expect(options.removeAiEditChannel).toHaveBeenCalledTimes(1));
      expect(onSkillReviewState).not.toHaveBeenCalled();
    } finally { ch.abortController.abort(); server.close(); }
  });

  it('reports an unavailable safe review route back to the source without a general gateway fallback', async () => {
    const server = installServer();
    delete (server.config as { reviewSelection?: unknown }).reviewSelection;
    server.setSnapshot({ ...structuredClone(createdJob), status: 'done', result: { exitCode: 0 },
      messages: [{ at: 32, role: 'tool', kind: 'tool', runId: sourceOrigin.runId,
        toolCallId: 'fixture-unavailable-review-check', toolName: 'command_execution', phase: 'end', provenance: 'native-tool',
        status: 'success', toolExitCode: 0, args: { command: 'node --test' }, result: '# tests 1\n# pass 1\n# fail 0\n' }] });
    const { ch, options, onSkillReviewState } = createTurn();
    startRemoteChatTurn(options);
    try {
      await vi.waitFor(() => expect(server.calls.some((call) => call.path.endsWith('/stream'))).toBe(true));
      server.emit('result', { ...structuredClone(createdJob), status: 'done', result: { exitCode: 0 } });
      await vi.waitFor(() => expect(onSkillReviewState).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed',
        origin: sourceOrigin, mode: 'approve-all', result: expect.objectContaining({ status: 'failed',
          origin: sourceOrigin, operationsApplied: 0, error: expect.stringContaining('SKILL_REVIEW_UNAVAILABLE') }) })));
      expect(server.calls.some((call) => call.path === '/v1/chat/completions' || call.body?.action === 'manage')).toBe(false);
      expect(ch.messages.at(-1)?.text).toContain('远程任务完成');
    } finally { ch.abortController.abort(); server.close(); }
  });

  it('freezes the exact source user message before asynchronous connection setup and UI navigation', async () => {
    const server = installServer();
    const { ch, options, onSkillContext } = createTurn();
    startRemoteChatTurn(options);
    ch.messages = [{ id: 'fixture-other-current-message', role: 'user', text: 'Navigated task.', createdAt: 2 }];
    ch.workspaceId = 'fixture-other-local-bucket';
    ch.sessionId = 'fixture-other-current-session';
    options.sourceMessageId = 'fixture-other-current-message';
    try {
      await vi.waitFor(() => expect(server.calls.some((call) => call.path.endsWith('/stream'))).toBe(true));
      expect(server.calls.find((call) => call.path === '/jobs')!.body!.skillSource)
        .toEqual({ sessionId: sourceOrigin.sessionId, turnId: sourceOrigin.turnId });
      expect(onSkillContext).toHaveBeenCalledWith(expect.objectContaining({ origin: sourceOrigin }));
    } finally { ch.abortController.abort(); server.close(); }
  });

  it.each(['missing session', 'missing message', 'unknown message', 'missing project'])(
    'fails explicit skill selection closed with %s before submitting any job', async (missing) => {
      const server = installServer();
      const { ch, options, onSkillContext } = createTurn({ explicitSkillIds: [skillEntry.skillId] });
      if (missing === 'missing session') ch.sessionId = null;
      if (missing === 'missing message') options.sourceMessageId = '';
      if (missing === 'unknown message') options.sourceMessageId = 'fixture-nonexistent-message';
      const projectId = remoteFixture.workspace.projectId;
      if (missing === 'missing project') remoteFixture.workspace.projectId = '';
      startRemoteChatTurn(options);
      try {
        await vi.waitFor(() => expect(options.removeAiEditChannel).toHaveBeenCalledTimes(1));
        expect(server.calls.some((call) => call.path === '/jobs')).toBe(false);
        expect(onSkillContext).not.toHaveBeenCalled();
        expect(ch.messages.at(-1)?.text).toContain('REMOTE_SKILL_SOURCE_UNAVAILABLE');
      } finally { remoteFixture.workspace.projectId = projectId; ch.abortController.abort(); server.close(); }
    });

  it('keeps failed automatic preload advisory without passing partial skill metadata', async () => {
    const server = installServer();
    server.setContextError();
    const { ch, options, onSkillContext } = createTurn();
    startRemoteChatTurn(options);
    try {
      await vi.waitFor(() => expect(server.calls.some((call) => call.path.endsWith('/stream'))).toBe(true));
      const submission = server.calls.find((call) => call.path === '/jobs')!.body!;
      expect(submission.prompt).not.toContain('<UGS_SKILL_CONTEXT>');
      expect(submission.skillSource).toEqual({ sessionId: sourceOrigin.sessionId, turnId: sourceOrigin.turnId });
      expect(onSkillContext).toHaveBeenCalledWith({ origin: sourceOrigin, loadedSkills: [], catalogRevision: '',
        sourceSession: { workspaceId: 'fixture-local-bucket', sessionId: sourceOrigin.sessionId, serverUrl: 'https://remote-chat.fixture' } });
    } finally { ch.abortController.abort(); server.close(); }
  });

  it('does not submit when an explicitly selected skill cannot be read', async () => {
    const server = installServer();
    server.setContextError();
    const { ch, options } = createTurn({ explicitSkillIds: [skillEntry.skillId] });
    startRemoteChatTurn(options);
    try {
      await vi.waitFor(() => expect(options.removeAiEditChannel).toHaveBeenCalledTimes(1));
      expect(server.calls.some((call) => call.path === '/jobs')).toBe(false);
      expect(ch.messages.at(-1)?.text).toContain('fixture context unavailable');
    } finally { ch.abortController.abort(); server.close(); }
  });

  it.each([
    ['missing origin', undefined],
    ['foreign host', { ...sourceOrigin, hostId: 'local' }],
    ['local bucket', { ...sourceOrigin, workspaceId: 'fixture-local-bucket' }],
    ['foreign session', { ...sourceOrigin, sessionId: 'fixture-other-session' }],
    ['foreign turn', { ...sourceOrigin, turnId: 'fixture-other-turn' }],
    ['foreign run', { ...sourceOrigin, runId: 'fixture-other-run' }],
    ['client cwd', { ...sourceOrigin, cwd: 'fixture/path' }],
  ])('rejects a submitted job with %s before persisting authority or subscribing', async (_label, skillOrigin) => {
    const server = installServer();
    server.setJob({ ...structuredClone(createdJob), skillOrigin });
    const { ch, options, onSkillContext } = createTurn();
    startRemoteChatTurn(options);
    try {
      await vi.waitFor(() => expect(server.calls.some((call) => call.path === '/jobs')).toBe(true));
      await vi.waitFor(() => expect(options.removeAiEditChannel).toHaveBeenCalledTimes(1));
      expect(onSkillContext).not.toHaveBeenCalled();
      expect(server.calls.some((call) => call.path.endsWith('/stream'))).toBe(false);
      expect(options.syncAndPersistSessionRunStatus).toHaveBeenCalledWith(
        { workspaceId: 'fixture-local-bucket', sessionId: sourceOrigin.sessionId }, 'error');
      expect(ch.messages.at(-1)?.text).toContain('REMOTE_SKILL_JOB_ORIGIN_MISMATCH');
    } finally { ch.abortController.abort(); server.close(); }
  });
});
