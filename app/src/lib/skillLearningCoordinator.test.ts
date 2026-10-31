import { afterEach, expect, it, vi } from 'vitest';
import { RunnerClient, REMOTE_SKILL_HOST_ID } from '@ugs/protocol';
import { acquireReviewBackground, beginReviewForeground, cancelMemoryReviews } from '@/runtime/memory/review';
import { beginSkillLearningTurn, cancelSkillLearning, requestExplicitSkillLearning } from './skillLearningDesktop';
import { beginRemoteSkillForeground, finishRemoteLearning } from './remoteSkillLearning';
import { DEFAULT_SKILL_LEARNING_CONFIG } from './skillLearningConfig';
import type { SkillHostPort, SkillOrigin, SkillReviewModelPort } from '@/runtime/skills/types';

const origin: SkillOrigin = { hostId: 'local', workspaceId: 'coordinator-workspace', sessionId: 'coordinator-source', turnId: 'source-turn', runId: 'source-run' };
const selection = { adapter: 'codex', modelClass: 'default' };
const config = { ...DEFAULT_SKILL_LEARNING_CONFIG, cooldownMs: 0 };
function host(): SkillHostPort { return { list: vi.fn(async () => ({ revision: 'empty', entries: [] })), view: vi.fn(), manage: vi.fn() }; }
function noopModel(): SkillReviewModelPort { return { capability: 'completion-only', complete: vi.fn(async () => ({ text: '{"version":1,"kind":"noop","reason":"No missing rule."}' })) }; }
function explicit(sessionId: string, model = noopModel(), sourceHost = host()) {
  return requestExplicitSkillLearning({ origin: { ...origin, sessionId }, kind: 'learn', text: 'Read complete source files before changing them.', selection, config, host: sourceHost, model });
}
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
function remoteOptions(sessionId: string, model = noopModel()) {
  const remoteOrigin = { hostId: REMOTE_SKILL_HOST_ID, workspaceId: 'remote-coordinator', sessionId, turnId: 'remote-turn', runId: sessionId };
  const client = new RunnerClient('https://coordinator-runner.test', 'fixture-auth');
  vi.spyOn(client, 'getJob').mockResolvedValue({ id: remoteOrigin.runId, projectId: remoteOrigin.workspaceId, skillOrigin: remoteOrigin, status: 'done', messages: [], logs: [] } as never);
  vi.spyOn(client, 'getProjectSkillConfig').mockResolvedValue(config);
  vi.spyOn(client, 'skillRequest').mockResolvedValue({ revision: 'remote-empty', entries: [] } as never);
  return { client, projectId: remoteOrigin.workspaceId, origin: remoteOrigin, userText: 'Source task.', finalAnswer: 'Completed.', userCorrections: [{ text: 'Read complete files.', occurredAt: 1 }], model };
}
afterEach(async () => { cancelSkillLearning(); await flush(); vi.restoreAllMocks(); });

it.each(['local', 'remote'] as const)('%s foreground registers globally even when skill learning is disabled', async (kind) => {
  const memory = acquireReviewBackground('memory')!;
  const release = kind === 'remote' ? beginRemoteSkillForeground() : (() => {
    const turn = beginSkillLearningTurn({ origin: { ...origin, sessionId: 'disabled-foreground' }, prompt: 'Ordinary foreground task.', selection,
      host: host(), config: { ...config, enabled: false } });
    return () => { void turn.finish({ terminal: 'completed', finalAnswer: 'Done.' }); };
  })();
  try {
    expect(memory.signal.aborted).toBe(true);
    memory.release();
    expect(acquireReviewBackground('probe')).toBeUndefined();
    release(); release();
    await flush();
    const next = acquireReviewBackground('probe');
    expect(next).toBeDefined();
    next?.release();
  } finally { memory.release(); release(); await flush(); }
});

it('queued local state explains renderer-wide foreground priority without promising session isolation', async () => {
  const states: string[] = [];
  const pending = requestExplicitSkillLearning({ origin: { ...origin, sessionId: 'queued-copy' }, kind: 'learn',
    text: 'Read the complete file.', selection, config, host: host(), model: noopModel(),
    onState: (state) => { if (state.status === 'queued') states.push(state.detail ?? ''); } });
  await pending;
  expect(states).toHaveLength(1);
  expect(states[0]).not.toContain('其他会话不影响');
  expect(states[0]).toContain('共享后台');
});

it.each(['local', 'remote'] as const)('%s background model is preempted by another module foreground without automatic rebilling', async (kind) => {
  let entered!: (signal: AbortSignal) => void;
  let reply!: (value: { text: string }) => void;
  const started = new Promise<AbortSignal>((resolve) => { entered = resolve; });
  const response = new Promise<{ text: string }>((resolve) => { reply = resolve; });
  const model: SkillReviewModelPort = { capability: 'completion-only', complete: vi.fn(async (request) => { entered(request.signal); return response; }) };
  const pending = kind === 'local' ? explicit('local-cross-cancel', model) : finishRemoteLearning(remoteOptions('remote-cross-cancel', model));
  const signal = await started;
  // Memory OFF and local-skills cancellation must not cancel remote skills.
  cancelMemoryReviews();
  if (kind === 'remote') cancelSkillLearning();
  expect(signal.aborted).toBe(false);
  const release = kind === 'local' ? beginRemoteSkillForeground() : (() => {
    const turn = beginSkillLearningTurn({ origin: { ...origin, sessionId: 'other-local-foreground' }, prompt: 'Foreground.', selection,
      host: host(), config: { ...config, enabled: false } });
    return () => { void turn.finish({ terminal: 'completed', finalAnswer: 'Done.' }); };
  })();
  try {
    expect(signal.aborted).toBe(true);
    await expect(pending).resolves.toMatchObject({ status: 'cancelled' });
    release();
    await flush();
    expect(model.complete).toHaveBeenCalledOnce();
  } finally { reply({ text: '{"version":1,"kind":"noop","reason":"Late reply."}' }); release(); await pending; }
});

it.each(['local', 'remote'] as const)('%s review holds the one shared slot while the other skill caller waits', async (firstKind) => {
  let entered!: () => void;
  let reply!: (value: { text: string }) => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const response = new Promise<{ text: string }>((resolve) => { reply = resolve; });
  const firstModel: SkillReviewModelPort = { capability: 'completion-only', complete: vi.fn(async () => { entered(); return response; }) };
  const secondModel = noopModel();
  const first = firstKind === 'local' ? explicit('local-serial-first', firstModel) : finishRemoteLearning(remoteOptions('remote-serial-first', firstModel));
  await started;
  const second = firstKind === 'local' ? finishRemoteLearning(remoteOptions('remote-serial-second', secondModel)) : explicit('local-serial-second', secondModel);
  try {
    await flush();
    expect(secondModel.complete).not.toHaveBeenCalled();
    expect(acquireReviewBackground('memory')).toBeUndefined();
    reply({ text: '{"version":1,"kind":"noop","reason":"First review completed."}' });
    await expect(first).resolves.toMatchObject({ status: 'noop' });
    await expect(second).resolves.toMatchObject({ status: 'noop' });
    expect(secondModel.complete).toHaveBeenCalledOnce();
  } finally { reply({ text: '{"version":1,"kind":"noop","reason":"First review completed."}' }); await first; await second; }
});

it('remote shared cancellation reaches the actual host read transport', async () => {
  const options = remoteOptions('remote-cancel-host-read');
  let entered!: () => void;
  let releaseRead!: (value: unknown) => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const read = new Promise((resolve) => { releaseRead = resolve; });
  let transportSignal: AbortSignal | undefined;
  vi.mocked(options.client.skillRequest).mockImplementation(async (_project, _request, transport) => {
    transportSignal = transport?.signal;
    entered();
    return await read as never;
  });
  const pending = finishRemoteLearning(options);
  await started;
  const releaseForeground = beginReviewForeground('memory-foreground');
  try {
    expect(transportSignal).toBeInstanceOf(AbortSignal);
    expect(transportSignal?.aborted).toBe(true);
    await expect(pending).resolves.toMatchObject({ status: 'cancelled' });
    expect(options.model.complete).not.toHaveBeenCalled();
  } finally { releaseRead({ revision: 'empty', entries: [] }); releaseForeground(); await pending; }
});

it('the real remote caller waits behind memory without losing its scheduler evidence', async () => {
  const memory = acquireReviewBackground('memory')!;
  const options = remoteOptions('remote-behind-memory');
  const pending = finishRemoteLearning(options);
  try {
    await flush();
    expect(options.model.complete).not.toHaveBeenCalled();
    expect(options.client.skillRequest).not.toHaveBeenCalled();
    memory.release();
    await expect(pending).resolves.toMatchObject({ status: 'noop', origin: options.origin });
    expect(options.model.complete).toHaveBeenCalledOnce();
  } finally { memory.release(); await pending; }
});

it('the real local caller retains its reservation behind memory until the shared release event', async () => {
  const memory = acquireReviewBackground('memory')!;
  const model = noopModel();
  const pending = explicit('local-behind-memory', model);
  try {
    await flush();
    expect(model.complete).not.toHaveBeenCalled();
    memory.release();
    await expect(pending).resolves.toMatchObject({ status: 'noop' });
    expect(model.complete).toHaveBeenCalledOnce();
  } finally { memory.release(); cancelSkillLearning(); await pending; }
});
