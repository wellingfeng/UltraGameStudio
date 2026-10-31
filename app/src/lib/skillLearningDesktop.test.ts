import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCandidateIpcFixture, historyFixtureIpc, seedSkillSourceFixture } from '@/test/nativePersistenceFixture';
import type { SkillCandidateTransport } from './skillCandidateStore';
import { beginSkillLearningTurn, cancelSkillLearning, performSkillReviewAction, requestExplicitSkillLearning, runExplicitSkillLearning } from './skillLearningDesktop';
import type { SkillEntry, SkillEvidence, SkillHostPort, SkillMutationResult, SkillOrigin, SkillReadResult, SkillReviewModelPort, SkillReviewState } from '@/runtime/skills/types';
import type { SkillRunBindingRequest, SkillServiceRequest } from './skills';
import { DEFAULT_SKILL_LEARNING_CONFIG, saveSkillLearningConfig } from './skillLearningConfig';
import { acquireReviewBackground, beginReviewForeground } from '@/runtime/memory/review';

const nativeIpc = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: nativeIpc.invoke }));
let candidates: Awaited<ReturnType<typeof createCandidateIpcFixture>>;
beforeEach(async () => {
  candidates = await createCandidateIpcFixture();
  const invoke = vi.fn(async (command: string, args: Record<string, unknown>) => {
    if (command === 'skill_candidates_request') return candidates.request((args as unknown as { request: Parameters<SkillCandidateTransport>[0] }).request);
    if (command === 'history_read_json') return historyFixtureIpc(command, args);
    throw new Error(`Unexpected desktop fixture IPC: ${command}`);
  });
  Object.defineProperty(globalThis, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
  nativeIpc.invoke.mockReset().mockImplementation(invoke);
});

afterEach(async () => {
  cancelSkillLearning();
  await candidates.close();
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.doUnmock('@/lib/tauri');

  Reflect.deleteProperty(globalThis, '__TAURI_INTERNALS__');
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  vi.useRealTimers();
});

const origin: SkillOrigin = {
  hostId: 'local', workspaceId: 'workspace-a', sessionId: 'session-a',
  turnId: 'turn-a', runId: 'turn-a', cwd: 'E:/project-a',
};
const entry: SkillEntry = {
  skillId: 'manifest-id', rootId: 'project-root', name: 'manifest-first',
  description: 'Use when choosing project dependencies.', scope: 'project', source: 'ugs',
  relativePath: 'manifest-first/SKILL.md', revision: 'revision-a', hash: 'hash-a',
  readOnly: false, autoEditable: true, contentLocked: false, pinned: false,
  state: 'active', files: ['SKILL.md'],
};
const read: SkillReadResult = {
  entry, relativePath: 'SKILL.md', content: '---\nname: manifest-first\ndescription: Use when choosing project dependencies.\n---\nRead package.json before selecting dependencies.',
  revision: 'revision-a', hash: 'hash-a', fullRead: true, readReceiptId: 'receipt-a', files: ['SKILL.md'],
};

it('publishes a source-bound explanation when ordinary work does not reach the automatic review threshold', async () => {
  const owner = { ...origin, sessionId: 'visible-below-threshold' };
  const states: SkillReviewState[] = [];
  const host: SkillHostPort = { list: vi.fn(), view: vi.fn(), manage: vi.fn() };
  const model: SkillReviewModelPort = { capability: 'completion-only', complete: vi.fn() };
  const turn = beginSkillLearningTurn({ origin: owner, prompt: 'Inspect the repository.',
    selection: { adapter: 'codex', modelClass: 'default' }, host, model,
    config: { ...DEFAULT_SKILL_LEARNING_CONFIG, activityThreshold: 10 },
    onState: state => states.push(state) });
  turn.onTool({ runId: owner.runId, toolCallId: 'one-real-read', toolName: 'read_file',
    phase: 'end', provenance: 'native-tool', status: 'success', exitCode: 0, args: { path: 'package.json' } });
  await expect(turn.finish({ finalAnswer: 'Inspected.', terminal: 'completed' })).resolves.toMatchObject({ status: 'noop', operationsApplied: 0 });
  expect(states).toEqual([expect.objectContaining({ origin: owner, status: 'noop',
    admission: { status: 'not-admitted', reason: 'insufficient-evidence', completedActivities: 1, activityThreshold: 10 },
    detail: 'Completed activities: 1 / 10', result: expect.objectContaining({ lesson: 'insufficient-evidence', operationsApplied: 0 }) })]);
  expect(host.list).not.toHaveBeenCalled();
  expect(host.manage).not.toHaveBeenCalled();
  expect(model.complete).not.toHaveBeenCalled();
});

it.each([false, true])('keeps the public finish promise and source answer when a synchronous observer re-enters (admitted: %s)', async (admitted) => {
  const owner = { ...origin, sessionId: `finish-observer-reentry-${admitted}` };
  const states: SkillReviewState[] = [];
  const observerPromises: Promise<SkillMutationResult>[] = [];
  let releaseUsage!: () => void;
  const usageGate = new Promise<void>((resolve) => { releaseUsage = resolve; });
  const recordUsage = vi.fn(async () => { await usageGate; });
  const host: SkillHostPort = { list: vi.fn(async () => ({ revision: 'current', entries: [entry] })),
    view: vi.fn(async () => read), manage: vi.fn(), recordUsage };
  let reviewedAnswer: string | undefined;
  const model: SkillReviewModelPort = { capability: 'completion-only', complete: vi.fn(async (request) => {
    reviewedAnswer = JSON.parse(request.userContent).task.modelOutput;
    return { text: JSON.stringify({ version: 1, kind: 'noop', reason: 'insufficient-evidence' }) };
  }) };
  let reentered = false;
  const turn = beginSkillLearningTurn({ origin: owner, prompt: admitted ? '以后必须先检查。' : 'Inspect the repository.',
    selection: { adapter: 'codex', modelClass: 'default' }, host, model,
    config: { ...DEFAULT_SKILL_LEARNING_CONFIG, activityThreshold: 10, cooldownMs: 0 },
    onState: (state) => {
      states.push(state);
      if (!reentered) {
        reentered = true;
        turn.onTool({ runId: owner.runId, toolCallId: 'observer-injected-tool', toolName: 'read_file',
          phase: 'end', provenance: 'native-tool', status: 'success', exitCode: 0, args: { path: 'late.json' } });
        turn.onHostEvidence([{ evidenceId: 'observer-injected-evidence', origin: owner, occurredAt: 2,
          kind: 'verification', provenance: 'host-check', status: 'success', summary: 'Too late for the completed turn.' }]);
        observerPromises.push(turn.finish({ finalAnswer: 'Observer replacement, not the task result.', terminal: 'completed' }));
      }
    } });
  turn.onLoaded({ loadedSkills: [{ skillId: entry.skillId, revision: read.revision, hash: read.hash, files: ['SKILL.md'] }],
    catalogRevision: 'delivered' });
  turn.onHostEvidence([{ evidenceId: 'real-adoption', origin: owner, occurredAt: 1, kind: 'skill-use',
    provenance: 'host-check', status: 'success', exitCode: 0, toolCallId: 'real-adoption-check',
    skillId: entry.skillId, revision: read.revision, summary: 'Real source adoption.' }]);
  const finished = turn.finish({ finalAnswer: 'Actual foreground final answer.', terminal: 'completed' });
  const settled = vi.fn();
  void finished.then(settled);
  try {
    expect(observerPromises).toHaveLength(1);
    expect(observerPromises[0]).toBe(finished);
    expect(turn.finish({ finalAnswer: 'Another duplicate.', terminal: 'failed' })).toBe(finished);
    expect(turn.getSnapshot().finalAnswer).toBe('Actual foreground final answer.');
    expect(turn.getSnapshot().evidence.some((item) => /observer-injected/.test(item.evidenceId))).toBe(false);
    expect(recordUsage).toHaveBeenCalledOnce();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
  } finally { releaseUsage(); await Promise.all([finished, ...observerPromises]); }
  if (admitted) {
    expect(states[0].status).toBe('queued');
    expect(states[0].resume?.job.finalAnswer).toBe('Actual foreground final answer.');
    expect(reviewedAnswer).toBe('Actual foreground final answer.');
    expect(model.complete).toHaveBeenCalledOnce();
    expect(states.at(-1)?.result?.lesson).toBe('insufficient-evidence');
    expect(states.every((state) => !Object.hasOwn(state, 'admission'))).toBe(true);
  } else {
    expect(states).toHaveLength(1);
    expect(states[0].status).toBe('noop');
    expect(host.list).not.toHaveBeenCalled();
    expect(model.complete).not.toHaveBeenCalled();
  }
  expect(host.manage).not.toHaveBeenCalled();
});

it('publishes scheduler admission counts across completed source turns without dispatching a reviewer', async () => {
  const owner = { ...origin, sessionId: 'structured-admission-cumulative' };
  const states: SkillReviewState[] = [];
  const host: SkillHostPort = { list: vi.fn(), view: vi.fn(), manage: vi.fn() };
  const model: SkillReviewModelPort = { capability: 'completion-only', complete: vi.fn() };
  const start = (turnId: string) => beginSkillLearningTurn({ origin: { ...owner, turnId, runId: turnId },
    prompt: 'Inspect repository files.', selection: { adapter: 'codex', modelClass: 'default' }, host, model,
    config: { ...DEFAULT_SKILL_LEARNING_CONFIG, activityThreshold: 10 }, onState: (state) => states.push(state) });
  const empty = start('no-activities');
  await empty.finish({ finalAnswer: 'No native activity.', terminal: 'completed' });
  for (const turnId of ['first-read', 'second-read']) {
    const turn = start(turnId);
    turn.onTool({ runId: turnId, toolCallId: 'read', toolName: 'read_file', phase: 'end',
      provenance: 'native-tool', status: 'success', exitCode: 0, args: { path: 'package.json' } });
    await turn.finish({ finalAnswer: 'Read completed.', terminal: 'completed' });
  }
  expect(states).toEqual([0, 1, 2].map((completedActivities) => expect.objectContaining({ status: 'noop',
    origin: expect.objectContaining({ workspaceId: owner.workspaceId, sessionId: owner.sessionId, cwd: owner.cwd }),
    admission: { status: 'not-admitted', reason: 'insufficient-evidence', completedActivities, activityThreshold: 10 } })));
  expect(host.list).not.toHaveBeenCalled();
  expect(host.view).not.toHaveBeenCalled();
  expect(host.manage).not.toHaveBeenCalled();
  expect(model.complete).not.toHaveBeenCalled();
});

it.each([
  { label: 'disabled', terminal: 'completed' as const, enabled: false, mode: 'auto-safe' as const },
  { label: 'off', terminal: 'completed' as const, enabled: true, mode: 'off' as const },
  { label: 'failed', terminal: 'failed' as const, enabled: true, mode: 'auto-safe' as const },
  { label: 'cancelled', terminal: 'cancelled' as const, enabled: true, mode: 'auto-safe' as const },
])('does not publish automatic non-admission for a $label foreground turn', async ({ label, terminal, enabled, mode }) => {
  const owner = { ...origin, sessionId: `structured-admission-gate-${label}` };
  const states: SkillReviewState[] = [];
  const host: SkillHostPort = { list: vi.fn(), view: vi.fn(), manage: vi.fn() };
  const model: SkillReviewModelPort = { capability: 'completion-only', complete: vi.fn() };
  const turn = beginSkillLearningTurn({ origin: owner, prompt: 'Inspect repository files.', host, model,
    selection: { adapter: 'codex', modelClass: 'default' },
    config: { ...DEFAULT_SKILL_LEARNING_CONFIG, enabled, mode }, onState: (state) => states.push(state) });
  await expect(turn.finish({ finalAnswer: 'Real foreground outcome.', terminal })).resolves.toMatchObject({ status: 'noop' });
  expect(states).toEqual([]);
  expect(host.list).not.toHaveBeenCalled();
  expect(model.complete).not.toHaveBeenCalled();
});

it('delivers the complete explicitly selected skill only in the new request, not the historical system prefix', async () => {
  const view = vi.fn(async () => read);
  const usage = vi.fn(async () => {});
  const host: SkillHostPort = {
    list: async () => ({ revision: 'catalog-a', entries: [entry] }), view,
    manage: vi.fn(), recordUsage: usage,
  };
  const turn = beginSkillLearningTurn({
    origin, prompt: 'Choose project dependencies.', selection: { adapter: 'codex', modelClass: 'default' },
    config: { ...DEFAULT_SKILL_LEARNING_CONFIG, enabled: false },
    explicitSkillIds: [entry.skillId], host,
  });
  const context = await turn.loadContext();
  const delivered = JSON.parse(context.prompt.split('<UGS_SKILL_CONTEXT>\n')[1].split('\n</UGS_SKILL_CONTEXT>')[0]);
  expect(delivered[0].content).toBe(read.content);
  expect(context.loadedSkills).toEqual([{ skillId: entry.skillId, revision: 'revision-a', hash: 'hash-a', files: ['SKILL.md'] }]);
  expect(view).toHaveBeenCalledWith({ skillId: entry.skillId });
  expect(usage).toHaveBeenCalledWith(entry.skillId, 'delivered');
  expect(origin.runId).toBe('turn-a');
  turn.finish({ finalAnswer: 'Dependencies selected.', terminal: 'completed' });
});

it('records host-verified adoption of the delivered exact revision before revoking the foreground grant', async () => {
  const owner = { ...origin, sessionId: 'verified-adoption' };
  seedSkillSourceFixture(owner, "Use manifest-first for this task.");
  const adoption: SkillEvidence = { evidenceId: 'manifest-adoption', origin: owner, occurredAt: 10,
    kind: 'skill-use', provenance: 'host-check', status: 'success', exitCode: 0,
    toolCallId: 'manifest-rule-check', toolName: 'saved-byte-check', skillId: entry.skillId, revision: read.revision,
    summary: 'The host checked adoption of the delivered manifest rule.' };
  const bindings: SkillRunBindingRequest[] = [];
  const usage: SkillServiceRequest[] = [];
  const events: string[] = [];
  const invoke = vi.fn(async (command: string, args: { request?: SkillServiceRequest & SkillRunBindingRequest; origin?: SkillOrigin }) => {
    if (command === 'skill_candidates_request') return candidates.request((args as unknown as { request: Parameters<SkillCandidateTransport>[0] }).request);
    if (command === 'history_read_json') return historyFixtureIpc(command, args);
    if (command === 'skills_bind_run') { bindings.push(structuredClone(args.request!)); events.push('bind'); return; }
    if (command === 'skills_revoke_run') { events.push('revoke'); return; }
    const request = args.request!;
    if (request.action === 'list') return { revision: 'adoption-catalog', entries: [entry] };
    if (request.action === 'view') return read;
    if (request.action === 'usage') {
      usage.push(structuredClone(request)); events.push(request.kind!); return entry;
    }
    throw new Error('unexpected adoption host command');
  });
  Object.defineProperty(globalThis, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
  nativeIpc.invoke.mockReset().mockImplementation(invoke);
  const turn = beginSkillLearningTurn({ origin: owner, prompt: 'Use manifest-first for this task.',
    selection: { adapter: 'codex', modelClass: 'default' }, config: { ...DEFAULT_SKILL_LEARNING_CONFIG, enabled: false } });
  await turn.loadContext();
  expect(usage.map((request) => request.kind)).toEqual(['delivered']);
  turn.onHostEvidence([adoption]);
  await expect(turn.finish({ finalAnswer: 'The adoption check completed.', terminal: 'completed' })).resolves.toMatchObject({ status: 'noop' });
  expect(usage.filter((request) => request.kind === 'used-with-evidence')).toEqual([{
    action: 'usage', origin: owner, mode: 'auto-safe', skillId: entry.skillId,
    kind: 'used-with-evidence', evidenceIds: [adoption.evidenceId], evidence: [adoption],
  }]);
  expect(bindings.map((binding) => ({ origin: binding.origin, actor: binding.actor }))).toEqual([
    { origin: owner, actor: 'background' }, { origin: owner, actor: 'background' },
  ]);
  expect(events.slice(-3)).toEqual(['bind', 'used-with-evidence', 'revoke']);
  expect(bindings.at(-1)?.evidence).toEqual([adoption]);
});

it('revokes foreground authority promptly when aborted during optional adoption telemetry', async () => {
  const owner = { ...origin, sessionId: 'abort-pending-adoption' };
  seedSkillSourceFixture(owner, "Use manifest-first.");
  const controller = new AbortController();
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const revoked: SkillOrigin[] = [];
  const invoke = vi.fn(async (command: string, args: { request?: SkillServiceRequest; origin?: SkillOrigin }) => {
    if (command === 'skill_candidates_request') return candidates.request((args as unknown as { request: Parameters<SkillCandidateTransport>[0] }).request);
    if (command === 'history_read_json') return historyFixtureIpc(command, args);
    if (command === 'skills_bind_run') return;
    if (command === 'skills_revoke_run') { revoked.push(structuredClone(args.origin!)); return; }
    if (args.request?.action === 'list') return { revision: 'catalog', entries: [entry] };
    if (args.request?.action === 'view') return read;
    if (args.request?.action === 'usage') {
      if (args.request.kind === 'used-with-evidence') { enter(); await gate; }
      return entry;
    }
    throw new Error('unexpected telemetry lifecycle command');
  });
  Object.defineProperty(globalThis, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
  nativeIpc.invoke.mockReset().mockImplementation(invoke);
  const turn = beginSkillLearningTurn({ origin: owner, prompt: 'Use manifest-first.', signal: controller.signal,
    selection: { adapter: 'codex', modelClass: 'default' }, config: { ...DEFAULT_SKILL_LEARNING_CONFIG, enabled: false } });
  expect(await turn.loadContext()).toMatchObject({ loadedSkills: [{ skillId: entry.skillId }] });
  turn.onHostEvidence([{ evidenceId: 'adoption', origin: owner, occurredAt: 1, kind: 'skill-use', provenance: 'host-check',
    status: 'success', exitCode: 0, toolCallId: 'check', skillId: entry.skillId, revision: read.revision, summary: 'Real adoption check.' }]);
  const result = turn.finish({ finalAnswer: 'Task completed.', terminal: 'completed' });
  await entered;
  controller.abort();
  try {
    await vi.waitFor(() => expect(revoked).toEqual([owner]), { timeout: 100, interval: 5 });
    await expect(turn.host.list()).rejects.toThrow('SKILL_REVIEW_CANCELLED');
  } finally { release(); await result; }
});

it.each([
  ['verification only', { kind: 'verification' }],
  ['assistant claim', { provenance: 'model-output' }],
  ['synthetic tool closure', { provenance: 'ui-synthetic' }],
  ['unknown completion', { status: 'unknown' }],
  ['failed check', { exitCode: 1 }],
  ['missing native completion id', { toolCallId: undefined }],
  ['different skill', { skillId: 'foreign-skill' }],
  ['different revision', { revision: 'stale-revision' }],
] as Array<[string, Partial<SkillEvidence>]>)('does not upgrade %s to verified skill usage', async (_label, overrides) => {
  const owner = { ...origin, sessionId: `unverified-usage-${_label}` };
  const recordUsage = vi.fn(async () => {});
  const host: SkillHostPort = { list: async () => ({ revision: 'catalog', entries: [entry] }), view: async () => read, manage: vi.fn(), recordUsage };
  const turn = beginSkillLearningTurn({ origin: owner, prompt: 'Use manifest-first.', host,
    selection: { adapter: 'codex', modelClass: 'default' }, config: { ...DEFAULT_SKILL_LEARNING_CONFIG, enabled: false } });
  await turn.loadContext();
  turn.onHostEvidence([{ evidenceId: 'not-adoption', origin: owner, occurredAt: 1, kind: 'skill-use', provenance: 'host-check',
    status: 'success', exitCode: 0, toolCallId: 'check', skillId: entry.skillId, revision: read.revision, summary: 'Unverified usage candidate.', ...overrides }]);
  await turn.finish({ finalAnswer: 'I claim I used the skill.', terminal: 'completed' });
  expect(recordUsage.mock.calls).toEqual([[entry.skillId, 'delivered']]);
});

it('does not count adoption from another source turn even within the same session', async () => {
  const owner = { ...origin, sessionId: 'different-turn-adoption' };
  const recordUsage = vi.fn(async () => {});
  const host: SkillHostPort = { list: async () => ({ revision: 'catalog', entries: [entry] }), view: async () => read, manage: vi.fn(), recordUsage };
  const turn = beginSkillLearningTurn({ origin: owner, prompt: 'Use manifest-first.', host,
    selection: { adapter: 'codex', modelClass: 'default' }, config: { ...DEFAULT_SKILL_LEARNING_CONFIG, enabled: false } });
  await turn.loadContext();
  turn.onHostEvidence([{ evidenceId: 'other-turn-adoption', origin: { ...owner, turnId: 'other-turn', runId: 'other-run' },
    occurredAt: 1, kind: 'skill-use', provenance: 'host-check', status: 'success', exitCode: 0,
    toolCallId: 'check', skillId: entry.skillId, revision: read.revision, summary: 'Another task verified its own adoption.' }]);
  await turn.finish({ finalAnswer: 'This task did not verify adoption.', terminal: 'completed' });
  expect(recordUsage.mock.calls).toEqual([[entry.skillId, 'delivered']]);
});

it('retains the foreground task result when optional verified-usage telemetry fails', async () => {
  const owner = { ...origin, sessionId: 'usage-telemetry-failure' };
  const revoke = vi.fn(async () => {});
  const recordUsage = vi.fn<NonNullable<SkillHostPort['recordUsage']>>(async (_skillId, kind) => {
    if (kind === 'used-with-evidence') throw new Error('optional usage ledger unavailable');
  });
  const host: SkillHostPort & { revoke(): Promise<void> } = { list: async () => ({ revision: 'catalog', entries: [entry] }),
    view: async () => read, manage: vi.fn(), recordUsage, revoke };
  const turn = beginSkillLearningTurn({ origin: owner, prompt: 'Use manifest-first.', host,
    selection: { adapter: 'codex', modelClass: 'default' }, config: { ...DEFAULT_SKILL_LEARNING_CONFIG, enabled: false } });
  await turn.loadContext();
  turn.onHostEvidence([{ evidenceId: 'verified-adoption', origin: owner, occurredAt: 1, kind: 'skill-use', provenance: 'host-check',
    status: 'success', exitCode: 0, toolCallId: 'check', skillId: entry.skillId, revision: read.revision, summary: 'Actual host adoption check.' }]);
  const finished = turn.finish({ finalAnswer: 'Task completed despite optional telemetry.', terminal: 'completed' });
  await expect(finished).resolves.toMatchObject({ status: 'noop' });
  expect(recordUsage).toHaveBeenCalledWith(entry.skillId, 'used-with-evidence', ['verified-adoption']);
  expect(turn.finish({ finalAnswer: 'duplicate finish', terminal: 'completed' })).toBe(finished);
  expect(revoke).not.toHaveBeenCalled();
});

it('waits for persisted-session readiness before exposing the frozen foreground host context', async () => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  const owner = { ...origin, sessionId: 'ready-load' };
  const list = vi.fn(async () => ({ revision: 'catalog-ready', entries: [] }));
  const host: SkillHostPort = { list, view: vi.fn(), manage: vi.fn() };
  const model: SkillReviewModelPort = { capability: 'completion-only', complete: vi.fn() };
  const turn = beginSkillLearningTurn({ origin: owner, prompt: 'new task', selection: { adapter: 'codex', modelClass: 'default' },
    ready, host, model, config: { ...DEFAULT_SKILL_LEARNING_CONFIG, enabled: false } });
  owner.workspaceId = 'wrong-active-workspace';
  const context = turn.loadContext();
  await Promise.resolve();
  expect(list).not.toHaveBeenCalled();
  release();
  await expect(context).resolves.toMatchObject({ prompt: 'new task', catalogRevision: 'catalog-ready' });
  expect(turn.origin.workspaceId).toBe(origin.workspaceId);
  expect(turn.host).toBe(host);
  expect(turn.model).toBe(model);
  expect(Object.isFrozen(turn.origin)).toBe(true);
  await turn.finish({ finalAnswer: '', terminal: 'completed' });
});

it('fresh-reads the complete latest named skill for a new related task without explicit selection', async () => {
  let latest = read;
  const host: SkillHostPort = { list: async () => ({ revision: 'current-catalog', entries: [latest.entry] }),
    view: vi.fn(async () => latest), manage: vi.fn() };
  const start = () => beginSkillLearningTurn({ origin: { ...origin, sessionId: 'fresh-reuse' },
    prompt: 'Use manifest-first for these dependencies.', selection: { adapter: 'codex', modelClass: 'default' },
    host, config: { ...DEFAULT_SKILL_LEARNING_CONFIG, enabled: false } });
  const first = start();
  const before = await first.loadContext();
  expect(before.loadedSkills).toHaveLength(1);
  await first.finish({ finalAnswer: '', terminal: 'completed' });
  latest = { ...read, entry: { ...entry, revision: 'revision-b', hash: 'hash-b' }, revision: 'revision-b', hash: 'hash-b',
    readReceiptId: 'receipt-b', content: read.content + '\nKeep the lockfile intact.\n' };
  const second = start();
  const after = await second.loadContext();
  expect(after.prompt).toContain('Keep the lockfile intact.');
  expect(after.loadedSkills[0]).toMatchObject({ revision: 'revision-b', hash: 'hash-b' });
  expect(host.view).toHaveBeenCalledTimes(2);
  await second.finish({ finalAnswer: '', terminal: 'completed' });
});

it('uses an optional completion-only selector for unrelated naming and never falls back to the coding gateway', async () => {
  const model: SkillReviewModelPort = { capability: 'completion-only', complete: vi.fn(async () => ({ text: JSON.stringify({ skillIds: [entry.skillId] }) })) };
  const host: SkillHostPort = { list: async () => ({ revision: 'selector-catalog', entries: [entry] }), view: vi.fn(async () => read), manage: vi.fn() };
  const turn = beginSkillLearningTurn({ origin: { ...origin, sessionId: 'selector' }, prompt: 'Choose safe dependency versions.',
    selection: { adapter: 'codex', modelClass: 'default' }, host, model, config: { ...DEFAULT_SKILL_LEARNING_CONFIG, enabled: false } });
  const context = await turn.loadContext();
  expect(context.loadedSkills[0]?.skillId).toBe(entry.skillId);
  expect(model.complete).toHaveBeenCalledOnce();
  expect(turn.model).toBe(model);
  await turn.finish({ finalAnswer: '', terminal: 'completed' });
});

it('explicit learn sends the actual user lesson as correction evidence and returns the independent review result', async () => {
  const owner = { ...origin, sessionId: 'explicit-learn' };
  const states: SkillReviewState[] = [];
  let payload: { evidence: Array<{ kind: string; provenance: string; summary: string }>; task: { userText: string } } | undefined;
  const host: SkillHostPort = { list: async () => ({ revision: 'empty', entries: [] }), view: vi.fn(), manage: vi.fn() };
  const model: SkillReviewModelPort = { capability: 'completion-only', complete: vi.fn(async (request) => {
    payload = JSON.parse(request.userContent);
    return { text: JSON.stringify({ version: 1, kind: 'noop', reason: 'This lesson is already documented.' }) };
  }) };
  const text = 'Read package manifests before choosing dependencies.';
  const result = await requestExplicitSkillLearning({ origin: owner, kind: 'learn', text,
    selection: { adapter: 'codex', modelClass: 'default' }, host, model,
    config: { ...DEFAULT_SKILL_LEARNING_CONFIG, activityThreshold: 1000, cooldownMs: 60000 }, onState: (state) => { states.push(state); } });
  expect(result.status).toBe('noop');
  expect(result.lesson).toBe('This lesson is already documented.');
  expect(payload?.task.userText).toBe(text);
  expect(payload?.evidence).toEqual([expect.objectContaining({ kind: 'correction', provenance: 'user-input', summary: text })]);
  expect(states.at(-1)?.result).toEqual(result);
});

it('retains delivered loaded versions and authentic child-run evidence for source-session refine', async () => {
  const host: SkillHostPort = { list: async () => ({ revision: 'snapshot-catalog', entries: [entry] }), view: vi.fn(async () => read), manage: vi.fn() };
  const turn = beginSkillLearningTurn({ origin: { ...origin, sessionId: 'snapshot-refine' }, prompt: 'Choose dependencies.',
    selection: { adapter: 'codex', modelClass: 'default' }, host, config: { ...DEFAULT_SKILL_LEARNING_CONFIG, enabled: false } });
  turn.onLoaded({ loadedSkills: [{ skillId: entry.skillId, revision: read.revision, hash: read.hash, files: ['SKILL.md'] }], catalogRevision: 'delivered' });
  turn.onTool({ runId: 'native-child', toolCallId: 'native-check', toolName: 'terminal', phase: 'end', provenance: 'native-tool',
    status: 'success', exitCode: 0, occurredAt: 10, args: { command: 'npm test' }, result: 'actual result' });
  turn.onTool({ runId: 'fake-child', toolCallId: 'fake-check', toolName: 'terminal', phase: 'end', provenance: 'ui-synthetic', status: 'success', exitCode: 0 });
  const snapshot = turn.getSnapshot();
  expect(snapshot.origin).toMatchObject({ sessionId: 'snapshot-refine', turnId: origin.turnId });
  expect(snapshot.loadedSkills).toHaveLength(1);
  expect(snapshot.evidence).toEqual([expect.objectContaining({ origin: { ...origin, sessionId: 'snapshot-refine', runId: 'native-child' }, kind: 'verification' })]);
  snapshot.loadedSkills[0].files.push('fake.md');
  snapshot.evidence[0].summary = 'tampered';
  expect(turn.getSnapshot().loadedSkills[0].files).toEqual(['SKILL.md']);
  expect(turn.getSnapshot().evidence[0].summary).toContain('npm test');
  await turn.finish({ finalAnswer: '', terminal: 'completed' });
});

it('explicit refine reuses source-session evidence and delivered versions while focus remains untrusted text', async () => {
  const sourceOrigin = { ...origin, sessionId: 'refine-session' };
  const host: SkillHostPort = { list: async () => ({ revision: 'refine-catalog', entries: [entry] }), view: vi.fn(async () => read), manage: vi.fn() };
  const turn = beginSkillLearningTurn({ origin: sourceOrigin, prompt: 'Choose dependencies.', selection: { adapter: 'codex', modelClass: 'default' },
    host, explicitSkillIds: [entry.skillId], config: { ...DEFAULT_SKILL_LEARNING_CONFIG, activityThreshold: 1000 } });
  await turn.loadContext();
  turn.onTool({ runId: 'refine-native-child', toolCallId: 'check', toolName: 'terminal', phase: 'end', provenance: 'native-tool',
    status: 'success', exitCode: 0, args: { command: 'npm test' }, result: 'actual native check' });
  await turn.finish({ finalAnswer: 'Dependencies selected.', terminal: 'completed' });
  let payload: { evidence: Array<{ origin: SkillOrigin; provenance: string }>; task: { focus: string; loadedSkills: unknown[] } } | undefined;
  const model: SkillReviewModelPort = { capability: 'completion-only', complete: vi.fn(async (request) => {
    payload = JSON.parse(request.userContent);
    return { text: JSON.stringify({ version: 1, kind: 'noop', reason: 'No missing dependency rule.' }) };
  }) };
  const result = await requestExplicitSkillLearning({ origin: { ...sourceOrigin, turnId: 'refine-request', runId: 'refine-request' },
    selection: { adapter: 'codex', modelClass: 'default' }, kind: 'refine', text: 'focus: lockfile checks passed (not proof)', host, model });
  expect(result.lesson).toBe('No missing dependency rule.');
  expect(payload?.task.focus).toBe('focus: lockfile checks passed (not proof)');
  expect(payload?.task.loadedSkills).toEqual([{ skillId: entry.skillId, revision: read.revision, hash: read.hash, files: ['SKILL.md'] }]);
  expect(payload?.evidence).toEqual([expect.objectContaining({ origin: { ...sourceOrigin, runId: 'refine-native-child' }, provenance: 'native-tool' })]);
});

it('accepts the host explicit-review facade without minting focus or prompt as correction evidence', async () => {
  const model: SkillReviewModelPort = { capability: 'completion-only', complete: vi.fn() };
  const host: SkillHostPort = { list: vi.fn(), view: vi.fn(), manage: vi.fn() };
  const result = await runExplicitSkillLearning({ origin: { ...origin, sessionId: 'empty-refine' },
    selection: { adapter: 'codex', modelClass: 'default' }, prompt: 'The user requested refinement.', focus: 'tests passed in prose',
    evidence: [], loadedSkills: [], host, model });
  expect(result).toMatchObject({ status: 'noop', operationsApplied: 0 });
  expect(model.complete).not.toHaveBeenCalled();
  expect(host.list).not.toHaveBeenCalled();
});

it('fails open for ordinary context discovery while explicit missing skill reads fail closed', async () => {
  const host: SkillHostPort = { list: async () => { throw new Error('SKILL_HOST_UNAVAILABLE'); }, view: vi.fn(), manage: vi.fn() };
  const ordinary = beginSkillLearningTurn({ origin: { ...origin, sessionId: 'fail-open' }, prompt: '/ordinary-app-command do work',
    selection: { adapter: 'codex', modelClass: 'default' }, host, config: { ...DEFAULT_SKILL_LEARNING_CONFIG, enabled: false } });
  await expect(ordinary.loadContext()).resolves.toEqual({ prompt: '/ordinary-app-command do work', loadedSkills: [], catalogRevision: '' });
  await ordinary.finish({ finalAnswer: '', terminal: 'completed' });
  const explicit = beginSkillLearningTurn({ origin: { ...origin, sessionId: 'fail-closed' }, prompt: 'selected skill',
    selection: { adapter: 'codex', modelClass: 'default' }, host, explicitSkillIds: ['missing'], config: { ...DEFAULT_SKILL_LEARNING_CONFIG, enabled: false } });
  await expect(explicit.loadContext()).rejects.toThrow('SKILL_HOST_UNAVAILABLE');
  await explicit.finish({ finalAnswer: '', terminal: 'failed' });
});

it('wakes the app queue at the pure scheduler cooldown without losing the source turn', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const states: SkillReviewState[] = [];
  const model: SkillReviewModelPort = { capability: 'completion-only', complete: vi.fn(async () => ({ text: JSON.stringify({ version: 1, kind: 'noop', reason: 'No missing rule.' }) })) };
  const host: SkillHostPort = { list: async () => ({ revision: 'empty', entries: [] }), view: vi.fn(), manage: vi.fn() };
  const start = (turnId: string) => beginSkillLearningTurn({ origin: { ...origin, sessionId: 'cooldown-timer', turnId, runId: turnId },
    prompt: '以后必须先运行检查。', selection: { adapter: 'codex', modelClass: 'default' }, host, model,
    config: { ...DEFAULT_SKILL_LEARNING_CONFIG, cooldownMs: 100 }, onState: (state) => { states.push(state); } });
  await start('first').finish({ finalAnswer: '', terminal: 'completed' });
  const second = start('second').finish({ finalAnswer: '', terminal: 'completed' });
  await vi.advanceTimersByTimeAsync(99);
  expect(model.complete).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(model.complete).toHaveBeenCalledTimes(2);
  await expect(second).resolves.toMatchObject({ status: 'noop' });
  expect(states.at(-1)?.origin.turnId).toBe('second');
});

it('settles superseded cooldown work while the latest source keeps the merged evidence', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const model: SkillReviewModelPort = { capability: 'completion-only', complete: vi.fn(async () => ({ text: JSON.stringify({ version: 1, kind: 'noop', reason: 'No missing rule.' }) })) };
  const host: SkillHostPort = { list: async () => ({ revision: 'empty', entries: [] }), view: vi.fn(), manage: vi.fn() };
  const start = (id: string) => beginSkillLearningTurn({ origin: { ...origin, sessionId: 'replace-cooldown', turnId: id, runId: id },
    prompt: '以后必须先检查。', selection: { adapter: 'codex', modelClass: 'default' }, host, model,
    config: { ...DEFAULT_SKILL_LEARNING_CONFIG, cooldownMs: 100 } });
  await start('first').finish({ finalAnswer: '', terminal: 'completed' });
  const old = start('old').finish({ finalAnswer: '', terminal: 'completed' });
  const oldOutcome = vi.fn();
  void old.then(oldOutcome);
  const next = start('latest').finish({ finalAnswer: '', terminal: 'completed' });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(oldOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled' }));
  await vi.advanceTimersByTimeAsync(100);
  await expect(next).resolves.toMatchObject({ status: 'noop' });
  expect(model.complete).toHaveBeenCalledTimes(2);
});

it('releases an aborted foreground turn even when its caller never reaches finish', async () => {
  const controller = new AbortController();
  const host: SkillHostPort = { list: async () => ({ revision: 'empty', entries: [] }), view: vi.fn(), manage: vi.fn() };
  const complete = vi.fn<SkillReviewModelPort['complete']>(async () => ({ text: '{"version":1,"kind":"noop","reason":"Independent review ran."}' }));
  const turn = beginSkillLearningTurn({ origin: { ...origin, sessionId: 'abort-without-finish' }, prompt: 'ordinary foreground work',
    selection: { adapter: 'codex', modelClass: 'default' }, signal: controller.signal, host,
    config: { ...DEFAULT_SKILL_LEARNING_CONFIG, enabled: false } });
  const pending = requestExplicitSkillLearning({ origin: { ...origin, sessionId: 'waiting-behind-abort' }, kind: 'learn', text: 'Read complete manifests before selecting dependencies.',
    selection: { adapter: 'codex', modelClass: 'default' }, host, model: { capability: 'completion-only', complete },
    config: { ...DEFAULT_SKILL_LEARNING_CONFIG, cooldownMs: 0 } });
  await Promise.resolve();
  expect(complete).not.toHaveBeenCalled();
  controller.abort();
  try {
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce(), { timeout: 200, interval: 5 });
    await expect(pending).resolves.toMatchObject({ status: 'noop', lesson: 'Independent review ran.' });
  } finally {
    await turn.finish({ finalAnswer: '', terminal: 'cancelled' });
    await pending;
  }
});

it('does not schedule a completed finish after its foreground signal has already aborted', async () => {
  const controller = new AbortController();
  const complete = vi.fn<SkillReviewModelPort['complete']>(async () => ({ text: '{"version":1,"kind":"noop","reason":"Must not run."}' }));
  const host: SkillHostPort = { list: vi.fn(async () => ({ revision: 'empty', entries: [] })), view: vi.fn(), manage: vi.fn() };
  const states: SkillReviewState[] = [];
  const turn = beginSkillLearningTurn({ origin: { ...origin, sessionId: 'aborted-before-finish' }, prompt: '以后必须先验证。',
    signal: controller.signal, selection: { adapter: 'codex', modelClass: 'default' }, host, model: { capability: 'completion-only', complete },
    config: { ...DEFAULT_SKILL_LEARNING_CONFIG, cooldownMs: 0 }, onState: (state) => { states.push(state); } });
  controller.abort();
  await expect(turn.finish({ finalAnswer: 'Late completed result.', terminal: 'completed' })).resolves.toMatchObject({ status: 'noop', operationsApplied: 0 });
  expect(host.list).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
  expect(states).toEqual([]);
});

it('cancels active review without consuming evidence so a later explicit refine can retry', async () => {
  const owner = { ...origin, sessionId: 'cancel-retry' };
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const firstModel: SkillReviewModelPort = { capability: 'completion-only', complete: vi.fn(async (request) => {
    started();
    await new Promise<never>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('cancelled transport')), { once: true }));
    return { text: '' };
  }) };
  const host: SkillHostPort = { list: async () => ({ revision: 'empty', entries: [] }), view: vi.fn(), manage: vi.fn() };
  const turn = beginSkillLearningTurn({ origin: owner, prompt: '以后必须先读项目清单。', selection: { adapter: 'codex', modelClass: 'default' },
    config: { ...DEFAULT_SKILL_LEARNING_CONFIG, cooldownMs: 0 }, host, model: firstModel });
  const cancelled = turn.finish({ finalAnswer: '', terminal: 'completed' });
  await entered;
  cancelSkillLearning(owner);
  await expect(cancelled).resolves.toMatchObject({ status: 'cancelled' });
  const model: SkillReviewModelPort = { capability: 'completion-only', complete: vi.fn(async (request) => {
    expect(JSON.parse(request.userContent).evidence).toHaveLength(1);
    return { text: JSON.stringify({ version: 1, kind: 'noop', reason: 'Already retained.' }) };
  }) };
  await expect(requestExplicitSkillLearning({ origin: { ...owner, runId: 'retry', turnId: 'retry' }, kind: 'refine', text: '',
    selection: { adapter: 'codex', modelClass: 'default' }, host, model })).resolves.toMatchObject({ status: 'noop', lesson: 'Already retained.' });
  expect(host.manage).not.toHaveBeenCalled();
});

it('closes the turn-owned foreground host after finish without granting another review', async () => {
  const owner = { ...origin, sessionId: 'finished-foreground-grant' };
  seedSkillSourceFixture(owner, "ordinary task");
  const invoke = vi.fn(async (command: string, args: { request?: { action?: string }; origin?: SkillOrigin }) => {
    if (command === 'skill_candidates_request') return candidates.request((args as unknown as { request: Parameters<SkillCandidateTransport>[0] }).request);
    if (command === 'history_read_json') return historyFixtureIpc(command, args);
    if (command === 'skills_bind_run' || command === 'skills_revoke_run') return;
    if (args.request?.action === 'list') return { revision: 'empty', entries: [] };
    throw new Error('unexpected foreground host command');
  });
  Object.defineProperty(globalThis, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
  nativeIpc.invoke.mockReset().mockImplementation(invoke);
  const model: SkillReviewModelPort = { capability: 'completion-only', complete: vi.fn() };
  const turn = beginSkillLearningTurn({ origin: owner, prompt: 'ordinary task', model,
    selection: { adapter: 'codex', modelClass: 'default' }, config: { ...DEFAULT_SKILL_LEARNING_CONFIG, enabled: false } });
  await turn.loadContext();
  await turn.finish({ finalAnswer: 'Task finished.', terminal: 'completed' });
  await expect(turn.host.list()).rejects.toThrow('SKILL_REVIEW_CANCELLED');
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('skills_revoke_run', { origin: owner }), { timeout: 200, interval: 5 });
  expect(model.complete).not.toHaveBeenCalled();
});

it('waits for the turn-owned native revocation before its finish promise settles', async () => {
  const owner = { ...origin, sessionId: 'finish-awaits-native-revoke' };
  seedSkillSourceFixture(owner, "ordinary task");
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const revocations: SkillOrigin[] = [];
  const invoke = vi.fn(async (command: string, args: { request?: { action?: string }; origin?: SkillOrigin }) => {
    if (command === 'skill_candidates_request') return candidates.request((args as unknown as { request: Parameters<SkillCandidateTransport>[0] }).request);
    if (command === 'history_read_json') return historyFixtureIpc(command, args);
    if (command === 'skills_bind_run') return;
    if (command === 'skills_revoke_run') { enter(); await gate; revocations.push(structuredClone(args.origin!)); return; }
    if (args.request?.action === 'list') return { revision: 'empty', entries: [] };
    throw new Error('unexpected native lifecycle command');
  });
  Object.defineProperty(globalThis, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
  nativeIpc.invoke.mockReset().mockImplementation(invoke);
  let observerPromise: Promise<SkillMutationResult> | undefined;
  const turn = beginSkillLearningTurn({ origin: owner, prompt: 'ordinary task',
    selection: { adapter: 'codex', modelClass: 'default' }, config: { ...DEFAULT_SKILL_LEARNING_CONFIG, activityThreshold: 10 },
    onState: () => {
      if (!observerPromise) observerPromise = turn.finish({ finalAnswer: 'Observer replacement.', terminal: 'completed' });
    } });
  await turn.loadContext();
  const result = turn.finish({ finalAnswer: 'Done.', terminal: 'completed' });
  const settled = vi.fn();
  void result.then(settled);
  const observerSettled = vi.fn();
  void observerPromise?.then(observerSettled);
  await entered;
  try {
    expect(observerPromise).toBe(result);
    expect(settled).not.toHaveBeenCalled();
    expect(observerSettled).not.toHaveBeenCalled();
    expect(turn.getSnapshot().finalAnswer).toBe('Done.');
    await expect(turn.host.list()).rejects.toThrow('SKILL_REVIEW_CANCELLED');
  } finally { release(); }
  await expect(result).resolves.toMatchObject({ status: 'noop' });
  expect(revocations).toEqual([owner]);
  expect(turn.finish({ finalAnswer: 'duplicate', terminal: 'failed' })).toBe(result);
});

it.each(['failed', 'cancelled'] as const)('closes a turn-owned foreground grant on %s finish without dispatching review', async (terminal) => {
  const owner = { ...origin, sessionId: `foreground-terminal-${terminal}` };
  seedSkillSourceFixture(owner, '以后必须先验证。');
  const bindings: SkillOrigin[] = [];
  const revocations: SkillOrigin[] = [];
  const invoke = vi.fn(async (command: string, args: { request?: { action?: string; origin: SkillOrigin }; origin?: SkillOrigin }) => {
    if (command === 'skill_candidates_request') return candidates.request((args as unknown as { request: Parameters<SkillCandidateTransport>[0] }).request);
    if (command === 'history_read_json') return historyFixtureIpc(command, args);
    if (command === 'skills_bind_run') { bindings.push(structuredClone(args.request!.origin)); return; }
    if (command === 'skills_revoke_run') { revocations.push(structuredClone(args.origin!)); return; }
    if (args.request?.action === 'list') return { revision: 'empty', entries: [] };
    throw new Error('unexpected foreground lifecycle command');
  });
  Object.defineProperty(globalThis, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
  nativeIpc.invoke.mockReset().mockImplementation(invoke);
  const complete = vi.fn<SkillReviewModelPort['complete']>();
  const states: SkillReviewState[] = [];
  const turn = beginSkillLearningTurn({ origin: owner, prompt: '以后必须先验证。', model: { capability: 'completion-only', complete },
    selection: { adapter: 'codex', modelClass: 'default' }, config: { ...DEFAULT_SKILL_LEARNING_CONFIG, cooldownMs: 0 },
    onState: (state) => { states.push(state); } });
  await turn.loadContext();
  await expect(turn.finish({ finalAnswer: 'Foreground did not complete.', terminal })).resolves.toMatchObject({ status: 'noop', operationsApplied: 0 });
  await expect(turn.host.list()).rejects.toThrow('SKILL_REVIEW_CANCELLED');
  await vi.waitFor(() => expect(revocations).toEqual([owner]), { timeout: 200, interval: 5 });
  expect(bindings).toEqual([owner]);
  expect(complete).not.toHaveBeenCalled();
  expect(states).toEqual([]);
});

it('closes a failed review-owned auxiliary host while retaining the actual failure and its review origin', async () => {
  const owner = { ...origin, sessionId: 'failed-review-grant' };
  seedSkillSourceFixture(owner, "Read the complete manifest.");
  const bindings: SkillOrigin[] = [];
  const revocations: SkillOrigin[] = [];
  const invoke = vi.fn(async (command: string, args: { request?: { action?: string; origin: SkillOrigin }; origin?: SkillOrigin }) => {
    if (command === 'skill_candidates_request') return candidates.request((args as unknown as { request: Parameters<SkillCandidateTransport>[0] }).request);
    if (command === 'history_read_json') return historyFixtureIpc(command, args);
    if (command === 'skills_bind_run') { bindings.push(structuredClone(args.request!.origin)); return; }
    if (command === 'skills_revoke_run') { revocations.push(structuredClone(args.origin!)); return; }
    if (args.request?.action === 'list') return { revision: 'empty', entries: [] };
    throw new Error('unexpected failed review command');
  });
  Object.defineProperty(globalThis, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
  nativeIpc.invoke.mockReset().mockImplementation(invoke);
  const states: SkillReviewState[] = [];
  const result = await requestExplicitSkillLearning({ origin: owner, kind: 'learn', text: 'Read the complete manifest.',
    selection: { adapter: 'codex', modelClass: 'default' }, config: { ...DEFAULT_SKILL_LEARNING_CONFIG, cooldownMs: 0 },
    model: { capability: 'completion-only', complete: async () => { throw new Error('deterministic completion failure'); } },
    onState: (state) => { states.push(state); } });
  expect(result).toMatchObject({ status: 'failed', operationsApplied: 0, error: 'Error: deterministic completion failure' });
  expect(nativeIpc.invoke).toHaveBeenCalledWith('history_read_json', { relPath: `workspaces/${owner.workspaceId}/sessions/${owner.sessionId}.json` });
  expect(bindings).toHaveLength(1);
  expect(bindings[0].runId).not.toBe(owner.runId);
  expect(result.origin).toEqual(bindings[0]);
  expect(revocations).toEqual([result.origin]);
  expect(states.at(-1)?.result).toEqual(result);
});

it('preserves an actual source read failure before granting auxiliary authority or dispatching the model', async () => {
  const owner = { ...origin, sessionId: 'source-read-failure' };
  const complete = vi.fn<SkillReviewModelPort['complete']>();
  const states: SkillReviewState[] = [];
  nativeIpc.invoke.mockImplementation(async (command: string) => {
    if (command === 'history_read_json') throw new Error('deterministic history read failure');
    throw new Error(`Unexpected failed-source fixture IPC: ${command}`);
  });
  const result = await requestExplicitSkillLearning({ origin: owner, kind: 'learn', text: 'Read the complete manifest.',
    selection: { adapter: 'codex', modelClass: 'default' }, config: { ...DEFAULT_SKILL_LEARNING_CONFIG, cooldownMs: 0 },
    model: { capability: 'completion-only', complete }, onState: (state) => { states.push(state); } });
  expect(result).toMatchObject({ status: 'failed', operationsApplied: 0, error: 'Error: deterministic history read failure' });
  expect(nativeIpc.invoke.mock.calls).toEqual([['history_read_json', { relPath: `workspaces/${owner.workspaceId}/sessions/${owner.sessionId}.json` }]]);
  expect(complete).not.toHaveBeenCalled();
  expect(states.at(-1)?.result).toEqual(result);
});

it.each(['corrupt-load', 'concurrent-cas'] as const)('reports the real filesystem candidate %s failure without managing or browser fallback', async (stage) => {
  const owner = { ...origin, sessionId: `candidate-failure-${stage}` };
  const directory = join(candidates.root, '.ultragamestudio', 'skill-learning');
  const path = join(directory, 'pre-review.v1.json');
  const corrupt = '{"version":1,"revision":"corrupt","candidates":[]}';
  if (stage === 'corrupt-load') { await mkdir(directory, { recursive: true }); await writeFile(path, corrupt); }
  else {
    const delegate = nativeIpc.invoke.getMockImplementation()!;
    nativeIpc.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      const request = args.request as Parameters<SkillCandidateTransport>[0];
      if (command === 'skill_candidates_request' && request.action === 'compare_and_swap') {
        await candidates.service.compareAndSwap(0, { version: 1, revision: 0, candidates: [] });
      }
      return delegate(command, args);
    });
  }
  const host: SkillHostPort = { list: async () => ({ revision: 'empty', entries: [] }), view: vi.fn(), manage: vi.fn() };
  const complete = vi.fn<SkillReviewModelPort['complete']>(async (request) => ({ text: JSON.stringify({ version: 1, kind: 'propose',
    lesson: 'Read complete manifests.', evidenceIds: [JSON.parse(request.userContent).evidence[0].evidenceId],
    operations: [{ action: 'create', name: 'manifest-first', content: read.content }] }) }));
  const states: SkillReviewState[] = [];
  const turn = beginSkillLearningTurn({ origin: owner, prompt: '以后必须先读完整清单。', host, model: { capability: 'completion-only', complete },
    selection: { adapter: 'codex', modelClass: 'default' }, config: { ...DEFAULT_SKILL_LEARNING_CONFIG, cooldownMs: 0 },
    onState: (state) => { states.push(state); } });
  const result = await turn.finish({ finalAnswer: 'The foreground task completed.', terminal: 'completed' });
  expect(result).toMatchObject({ status: stage === 'corrupt-load' ? 'failed' : 'conflicted', operationsApplied: 0,
    error: stage === 'corrupt-load' ? 'Error: SKILL_PRE_REVIEW_INVALID_STORAGE' : 'Error: SKILL_CANDIDATE_CONFLICT', usage: { calls: 1 } });
  expect(complete).toHaveBeenCalledOnce();
  expect(host.manage).not.toHaveBeenCalled();
  expect(states.at(-1)?.result).toEqual(result);
  if (stage === 'corrupt-load') expect(await readFile(path, 'utf8')).toBe(corrupt);
  else expect(await (await createCandidateIpcFixture(candidates.root)).service.load()).toEqual({ version: 1, revision: 1, candidates: [] });
  expect(Object.keys(window.localStorage).some((key) => /pre-review|candidate/i.test(key))).toBe(false);
});

it('does not revoke injected caller-owned hosts after either lifecycle completes', async () => {
  const owner = { ...origin, sessionId: 'shared-injected-host' };
  const revoke = vi.fn(async () => {});
  const host: SkillHostPort & { revoke(): Promise<void> } = {
    list: async () => ({ revision: 'empty', entries: [] }), view: vi.fn(), manage: vi.fn(), revoke,
  };
  const model: SkillReviewModelPort = { capability: 'completion-only', complete: async () => ({ text: '{"version":1,"kind":"noop","reason":"Shared host stays caller-owned."}' }) };
  const turn = beginSkillLearningTurn({ origin: owner, prompt: '以后必须先验证。', host, model,
    selection: { adapter: 'codex', modelClass: 'default' }, config: { ...DEFAULT_SKILL_LEARNING_CONFIG, cooldownMs: 0 } });
  await turn.loadContext();
  await expect(turn.finish({ finalAnswer: 'Done.', terminal: 'completed' })).resolves.toMatchObject({ status: 'noop', lesson: 'Shared host stays caller-owned.' });
  expect(revoke).not.toHaveBeenCalled();
});

it('holds the shared slot through a cancelled dispatched commit and awaited native revocation', async () => {
  const owner = { ...origin, sessionId: 'shared-slot-awaits-commit-revoke' };
  seedSkillSourceFixture(owner, 'Read complete manifests.');
  let manageEntered!: () => void, releaseManage!: () => void;
  let revokeEntered!: () => void, releaseRevoke!: () => void;
  const managing = new Promise<void>((resolve) => { manageEntered = resolve; });
  const manageGate = new Promise<void>((resolve) => { releaseManage = resolve; });
  const revoking = new Promise<void>((resolve) => { revokeEntered = resolve; });
  const revokeGate = new Promise<void>((resolve) => { releaseRevoke = resolve; });
  const invoke = vi.fn(async (command: string, args: { request?: SkillServiceRequest }) => {
    if (command === 'history_read_json') return historyFixtureIpc(command, args);
    if (command === 'skills_bind_run') return;
    if (command === 'skills_revoke_run') { revokeEntered(); await revokeGate; return; }
    if (args.request?.action === 'list') return { revision: 'empty', entries: [] };
    if (args.request?.action === 'manage') {
      manageEntered(); await manageGate;
      return { status: 'applied', origin: args.request.origin, batchId: 'confirmed-shared-commit', lesson: 'Read manifests.', operationsApplied: 1, changes: [], riskReasons: [] };
    }
    throw new Error(`Unexpected shared-slot fixture IPC: ${command}`);
  });
  Object.defineProperty(globalThis, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
  nativeIpc.invoke.mockReset().mockImplementation(invoke);
  const model: SkillReviewModelPort = { capability: 'completion-only', complete: async (request) => ({ text: JSON.stringify({ version: 1, kind: 'propose',
    lesson: 'Read complete manifests.', evidenceIds: [JSON.parse(request.userContent).evidence[0].evidenceId],
    operations: [{ action: 'create', name: 'manifest-first', content: read.content }] }) }) };
  const states: SkillReviewState[] = [];
  const result = requestExplicitSkillLearning({ origin: owner, kind: 'learn', text: 'Read complete manifests.', model,
    selection: { adapter: 'codex', modelClass: 'default' }, config: { ...DEFAULT_SKILL_LEARNING_CONFIG, cooldownMs: 0 }, onState: (state) => { states.push(state); } });
  const settled = vi.fn(); void result.then(settled);
  await managing;
  const endForeground = beginReviewForeground('other-module-foreground');
  endForeground();
  try {
    expect(acquireReviewBackground('memory')).toBeUndefined();
    expect(settled).not.toHaveBeenCalled();
    releaseManage();
    await revoking;
    expect(states.at(-1)?.result).toMatchObject({ status: 'applied', operationsApplied: 1 });
    expect(acquireReviewBackground('memory')).toBeUndefined();
    expect(settled).not.toHaveBeenCalled();
    releaseRevoke();
    await expect(result).resolves.toMatchObject({ status: 'applied', batchId: 'confirmed-shared-commit', operationsApplied: 1 });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const next = acquireReviewBackground('memory');
    expect(next).toBeDefined(); next?.release();
  } finally { releaseManage(); releaseRevoke(); endForeground(); await result; }
});

it('revokes a completed review-owned auxiliary host without changing its committed result', async () => {
  const owner = { ...origin, sessionId: 'completed-review-grant' };
  seedSkillSourceFixture(owner, "Read complete manifests.");
  const bindings: Array<{ origin: SkillOrigin; actor: string }> = [];
  const revocations: SkillOrigin[] = [];
  let actual: SkillMutationResult | undefined;
  const invoke = vi.fn(async (command: string, args: { request?: { action?: string; origin: SkillOrigin; actor: string }; origin?: SkillOrigin }) => {
    if (command === 'skill_candidates_request') return candidates.request((args as unknown as { request: Parameters<SkillCandidateTransport>[0] }).request);
    if (command === 'history_read_json') return historyFixtureIpc(command, args);
    if (command === 'skills_bind_run') { bindings.push(structuredClone(args.request!)); return; }
    if (command === 'skills_revoke_run') { revocations.push(args.origin!); return; }
    if (args.request?.action === 'list') return { revision: 'empty', entries: [] };
    if (args.request?.action === 'history') return { results: [actual] };
    if (args.request?.action === 'manage') {
      actual = { status: 'applied', origin: { ...args.request.origin }, batchId: 'committed-auxiliary-batch', lesson: 'Read complete manifests.', operationsApplied: 1, changes: [], riskReasons: [] };
      return actual;
    }
    throw new Error('unexpected review host command');
  });
  Object.defineProperty(globalThis, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
  nativeIpc.invoke.mockReset().mockImplementation(invoke);
  const model: SkillReviewModelPort = { capability: 'completion-only', complete: async (request) => ({ text: JSON.stringify({ version: 1, kind: 'propose',
    lesson: 'Read complete manifests.', evidenceIds: [JSON.parse(request.userContent).evidence[0].evidenceId], operations: [{ action: 'create', name: 'manifest-first', content: read.content }] }) }) };
  const states: SkillReviewState[] = [];
  const result = await requestExplicitSkillLearning({ origin: owner, kind: 'learn', text: 'Read complete manifests.', model,
    selection: { adapter: 'codex', modelClass: 'default' }, config: { ...DEFAULT_SKILL_LEARNING_CONFIG, cooldownMs: 0 }, onState: (state) => { states.push(state); } });
  expect(result).toMatchObject({ status: 'applied', batchId: 'committed-auxiliary-batch', operationsApplied: 1 });
  expect(bindings).toHaveLength(1);
  expect(bindings[0].origin.runId).not.toBe(owner.runId);
  await vi.waitFor(() => expect(revocations).toEqual([bindings[0].origin]), { timeout: 200, interval: 5 });
  expect(states.at(-1)?.result).toEqual(result);
});

it('uses separate run bindings and closes each owned host at its lifecycle boundary', async () => {
  const owner = { ...origin, sessionId: 'auxiliary-review' };
  seedSkillSourceFixture(owner, "以后必须先验证。");
  const bindings: unknown[] = [];
  const revocations: SkillOrigin[] = [];
  const invoke = vi.fn(async (command: string, args: { request?: Record<string, unknown>; origin?: SkillOrigin }) => {
    if (command === 'skill_candidates_request') return candidates.request((args as unknown as { request: Parameters<SkillCandidateTransport>[0] }).request);
    if (command === 'history_read_json') return historyFixtureIpc(command, args);
    if (command === 'skills_bind_run') { bindings.push(structuredClone(args.request)); return; }
    if (command === 'skills_revoke_run') { revocations.push(args.origin!); return; }
    if (args.request?.action === 'list') return { revision: 'empty', entries: [] };
    throw new Error('unexpected skill command');
  });
  nativeIpc.invoke.mockReset().mockImplementation(invoke);
  const desktop = await import('./skillLearningDesktop');
  Object.defineProperty(globalThis, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const model: SkillReviewModelPort = { capability: 'completion-only', complete: async (request) => {
    entered();
    await new Promise<never>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    return { text: '' };
  } };
  const turn = desktop.beginSkillLearningTurn({ origin: owner, prompt: '以后必须先验证。', model,
    selection: { adapter: 'codex', modelClass: 'default' }, config: { ...DEFAULT_SKILL_LEARNING_CONFIG, cooldownMs: 0 } });
  await turn.loadContext();
  const result = turn.finish({ finalAnswer: '', terminal: 'completed' });
  await started;
  desktop.cancelSkillLearning(owner);
  await expect(result).resolves.toMatchObject({ status: 'cancelled' });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(bindings).toHaveLength(2);
  const reviewBinding = bindings[1] as { origin: SkillOrigin; evidence: Array<{ origin: SkillOrigin }> };
  expect(reviewBinding.origin.runId).not.toBe(owner.runId);
  expect(reviewBinding.origin).toMatchObject({ workspaceId: owner.workspaceId, sessionId: owner.sessionId, turnId: owner.turnId, cwd: owner.cwd });
  expect(reviewBinding.evidence[0].origin).toEqual(owner);
  expect(revocations).toEqual([owner, reviewBinding.origin]);
  await expect(turn.host.list()).rejects.toThrow('SKILL_REVIEW_CANCELLED');
});

it('performs exact-source user controls with frozen policy and verifies the durable target result', async () => {
  const owner = { ...origin, sessionId: 'user-control', runId: 'saved-review-run' };
  const pending: SkillMutationResult = { status: 'awaiting_approval', batchId: 'saved-batch', origin: owner,
    lesson: 'Retain source.', operationsApplied: 0, changes: [], riskReasons: ['approval'] };
  const applied: SkillMutationResult = { ...pending, origin: { ...owner }, status: 'applied', operationsApplied: 1, rollbackId: 'saved-rollback' };
  const bindings: unknown[] = [];
  const requests: Array<Record<string, unknown>> = [];
  const invoke = vi.fn(async (command: string, args: { request: Record<string, unknown> }) => {
    if (command === 'skill_candidates_request') return candidates.request((args as unknown as { request: Parameters<SkillCandidateTransport>[0] }).request);
    if (command === 'history_read_json') return historyFixtureIpc(command, args);
    if (command === 'skills_bind_run') { bindings.push(args.request); return; }
    requests.push(args.request);
    if (args.request.action === 'approve') return applied;
    if (args.request.action === 'history') return { results: [applied] };
    throw new Error('unexpected user control');
  });
  Object.defineProperty(globalThis, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
  nativeIpc.invoke.mockReset().mockImplementation(invoke);
  const state: SkillReviewState & { mode?: 'auto-safe' } = { status: 'awaiting_approval', origin: owner, result: pending, mode: 'auto-safe' };
  const actual = performSkillReviewAction(state, 'approve');
  owner.workspaceId = 'new-active-workspace';
  const result = await actual;
  expect(result).toEqual({ ...applied, origin: { ...origin, sessionId: 'user-control', runId: 'saved-review-run' } });
  expect(bindings).toEqual([{ origin: result.origin, mode: 'auto-safe', actor: 'user', evidence: [] }]);
  expect(requests.map((request) => request.action)).toEqual(['approve', 'history']);
  expect(requests[0]).toEqual({ action: 'approve', origin: result.origin, mode: 'auto-safe', batchId: 'saved-batch' });
});

it('refuses a host control result for a different saved batch even when it is present in history', async () => {
  const owner = { ...origin, sessionId: 'different-control-target', runId: 'saved-review-run' };
  const pending: SkillMutationResult = { status: 'awaiting_approval', batchId: 'selected-batch', origin: owner,
    lesson: 'Read manifests.', operationsApplied: 0, changes: [], riskReasons: ['approval'] };
  const foreignResult: SkillMutationResult = { ...pending, batchId: 'other-saved-batch', status: 'applied', operationsApplied: 1 };
  const invoke = vi.fn(async (command: string, args: { request: { action?: string } }) => {
    if (command === 'skill_candidates_request') return candidates.request((args as unknown as { request: Parameters<SkillCandidateTransport>[0] }).request);
    if (command === 'history_read_json') return historyFixtureIpc(command, args);
    if (command === 'skills_bind_run') return;
    if (args.request.action === 'approve') return foreignResult;
    if (args.request.action === 'history') return { results: [foreignResult] };
    throw new Error('unexpected control request');
  });
  Object.defineProperty(globalThis, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
  nativeIpc.invoke.mockReset().mockImplementation(invoke);
  await expect(performSkillReviewAction({ status: 'awaiting_approval', origin: owner, result: pending }, 'approve')).rejects.toThrow('SKILL_CONTROL_TARGET_MISMATCH');
});

it('rejects a historical control card with a mismatched frozen result source before granting user authority', async () => {
  const owner = { ...origin, sessionId: 'mismatched-control-source' };
  const result: SkillMutationResult = { status: 'awaiting_approval', batchId: 'foreign-source-batch',
    origin: { ...owner, cwd: 'E:/foreign-project' }, lesson: 'Wrong source.', operationsApplied: 0, changes: [], riskReasons: ['approval'] };
  const invoke = vi.fn();
  Object.defineProperty(globalThis, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
  nativeIpc.invoke.mockReset().mockImplementation(invoke);
  await expect(performSkillReviewAction({ status: 'awaiting_approval', origin: owner, result }, 'approve'))
    .rejects.toThrow('SKILL_CONTROL_SOURCE_MISMATCH');
  expect(invoke).not.toHaveBeenCalled();
});

it('settles a review waiting for persistence immediately on cancellation and never binds after late readiness', async () => {
  const owner = { ...origin, sessionId: 'cancel-readiness' };
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  const list = vi.fn(async () => ({ revision: 'empty', entries: [] }));
  const host: SkillHostPort = { list, view: vi.fn(), manage: vi.fn() };
  const model: SkillReviewModelPort = { capability: 'completion-only', complete: vi.fn() };
  const turn = beginSkillLearningTurn({ origin: owner, prompt: '以后必须先读清单。', ready, host, model,
    selection: { adapter: 'codex', modelClass: 'default' }, config: { ...DEFAULT_SKILL_LEARNING_CONFIG, cooldownMs: 0 } });
  const result = turn.finish({ finalAnswer: '', terminal: 'completed' });
  const settled = vi.fn();
  void result.then(settled);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  cancelSkillLearning(owner);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  try { expect(settled).toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled' })); }
  finally { release(); }
  await result;
  expect(list).not.toHaveBeenCalled();
  expect(model.complete).not.toHaveBeenCalled();
});

it('freezes turn input and learning policy before UI edits can redirect later review', async () => {
  const owner = { ...origin, sessionId: 'frozen-turn-policy' };
  const config = { ...DEFAULT_SKILL_LEARNING_CONFIG, mode: 'approve-all' as const, cooldownMs: 0 };
  const host: SkillHostPort = { list: async () => ({ revision: 'empty', entries: [] }), view: vi.fn(), manage: vi.fn() };
  let payload: { task: { userText: string } } | undefined;
  const model: SkillReviewModelPort = { capability: 'completion-only', complete: async (request) => {
    payload = JSON.parse(request.userContent);
    return { text: JSON.stringify({ version: 1, kind: 'noop', reason: 'Policy preserved.' }) };
  } };
  const options = { origin: owner, prompt: '以后必须先验证。', config, host, model, selection: { adapter: 'codex', modelClass: 'default' } };
  const turn = beginSkillLearningTurn(options);
  options.prompt = 'UI edited this after the task started';
  Object.assign(config, { enabled: false, mode: 'off' });
  await expect(turn.finish({ finalAnswer: '', terminal: 'completed' })).resolves.toMatchObject({ status: 'noop', lesson: 'Policy preserved.' });
  expect(payload?.task.userText).toBe('以后必须先验证。');
  expect(turn.getSnapshot().config).toMatchObject({ enabled: true, mode: 'approve-all' });
});

it('keeps off effective when it changes before a qualifying foreground turn finishes', async () => {
  const owner = { ...origin, sessionId: 'off-before-finish', workspaceId: 'off-before-finish-workspace' };
  const host: SkillHostPort = { list: vi.fn(async () => ({ revision: 'empty', entries: [] })), view: vi.fn(), manage: vi.fn() };
  const complete = vi.fn<SkillReviewModelPort['complete']>(async () => ({ text: '{"version":1,"kind":"noop","reason":"Must not review after off."}' }));
  const states: SkillReviewState[] = [];
  const turn = beginSkillLearningTurn({ origin: owner, prompt: '以后必须先验证。', host, model: { capability: 'completion-only', complete },
    selection: { adapter: 'codex', modelClass: 'default' }, config: { ...DEFAULT_SKILL_LEARNING_CONFIG, cooldownMs: 0 },
    onState: (state) => { states.push(state); } });
  saveSkillLearningConfig({ ...DEFAULT_SKILL_LEARNING_CONFIG, enabled: false, mode: 'off' }, owner.workspaceId);
  await expect(turn.finish({ finalAnswer: 'Ordinary foreground task completed.', terminal: 'completed' })).resolves.toMatchObject({ status: 'noop', operationsApplied: 0 });
  expect(turn.getSnapshot().evidence).toHaveLength(1);
  expect(host.list).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
  expect(states).toEqual([]);
});

it('turns learning off by cancelling uncommitted background work without deleting source evidence', async () => {
  const owner = { ...origin, sessionId: 'config-off', workspaceId: 'config-off-workspace' };
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const model: SkillReviewModelPort = { capability: 'completion-only', complete: async (request) => {
    entered();
    await new Promise<never>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('off')), { once: true }));
    return { text: '' };
  } };
  const host: SkillHostPort = { list: async () => ({ revision: 'empty', entries: [] }), view: vi.fn(), manage: vi.fn() };
  const turn = beginSkillLearningTurn({ origin: owner, prompt: '以后必须先验证。', model, host,
    selection: { adapter: 'codex', modelClass: 'default' }, config: { ...DEFAULT_SKILL_LEARNING_CONFIG, cooldownMs: 0 } });
  const result = turn.finish({ finalAnswer: '', terminal: 'completed' });
  await started;
  const settled = vi.fn();
  void result.then(settled);
  saveSkillLearningConfig({ ...DEFAULT_SKILL_LEARNING_CONFIG, enabled: false, mode: 'off' }, owner.workspaceId);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  try { expect(settled).toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled' })); }
  finally { cancelSkillLearning(owner); }
  await result;
  expect(turn.getSnapshot().evidence).toHaveLength(1);
  expect(host.manage).not.toHaveBeenCalled();
});

it('records the frozen learning mode on every review state for later source-bound controls', async () => {
  const states: Array<SkillReviewState & { mode?: string }> = [];
  const host: SkillHostPort = { list: async () => ({ revision: 'empty', entries: [] }), view: vi.fn(), manage: vi.fn() };
  const model: SkillReviewModelPort = { capability: 'completion-only', complete: async () => ({ text: JSON.stringify({ version: 1, kind: 'noop', reason: 'No change.' }) }) };
  const turn = beginSkillLearningTurn({ origin: { ...origin, sessionId: 'state-mode' }, prompt: '以后必须先验证。', host, model,
    selection: { adapter: 'codex', modelClass: 'default' }, config: { ...DEFAULT_SKILL_LEARNING_CONFIG, mode: 'approve-all' },
    onState: (state) => { states.push(state); } });
  await turn.finish({ finalAnswer: '', terminal: 'completed' });
  expect(states.length).toBeGreaterThan(0);
  expect(states.every((state) => state.mode === 'approve-all')).toBe(true);
});

it('settles older cooldown work when the latest source turn is cancelled instead of leaving it pending forever', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const model: SkillReviewModelPort = { capability: 'completion-only', complete: vi.fn(async () => ({ text: JSON.stringify({ version: 1, kind: 'noop', reason: 'No change.' }) })) };
  const host: SkillHostPort = { list: async () => ({ revision: 'empty', entries: [] }), view: vi.fn(), manage: vi.fn() };
  const start = (id: string) => beginSkillLearningTurn({ origin: { ...origin, sessionId: 'pending-terminal-cancel', turnId: id, runId: id },
    prompt: '以后必须先验证。', host, model, selection: { adapter: 'codex', modelClass: 'default' },
    config: { ...DEFAULT_SKILL_LEARNING_CONFIG, cooldownMs: 100 } });
  await start('first').finish({ finalAnswer: '', terminal: 'completed' });
  const settled = vi.fn();
  void start('pending').finish({ finalAnswer: '', terminal: 'completed' }).then(settled);
  await start('cancelled-source').finish({ finalAnswer: '', terminal: 'cancelled' });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(settled).toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled' }));
  await vi.advanceTimersByTimeAsync(1000);
  expect(model.complete).toHaveBeenCalledOnce();
});

it('settles a newer turn when an older dispatched commit consumed all shared evidence', async () => {
  const owner = { ...origin, sessionId: 'concurrent-commit' };
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const result: SkillMutationResult = { status: 'applied', origin: owner, batchId: 'committed-before-followup', lesson: 'Preserve commits.', operationsApplied: 1, changes: [], riskReasons: [] };
  const manage = vi.fn(async () => { enter(); await gate; return result; });
  const host: SkillHostPort = { list: async () => ({ revision: 'empty', entries: [] }), view: vi.fn(), manage };
  const model: SkillReviewModelPort = { capability: 'completion-only', complete: vi.fn(async (request) => {
    const payload = JSON.parse(request.userContent);
    if (request.system.includes('语义比对器')) return { text: JSON.stringify({ candidateId: payload.candidates[0].id, similarity: 0.98 }) };
    return { text: JSON.stringify({ version: 1, kind: 'propose', lesson: 'Preserve commits.', evidenceIds: [payload.evidence[0].evidenceId], operations: [{ action: 'create', name: 'manifest-first', content: read.content }] }) };
  }) };
  const start = (id: string, prompt: string) => beginSkillLearningTurn({ origin: { ...owner, runId: id, turnId: id }, prompt, host, model,
    selection: { adapter: 'codex', modelClass: 'default' }, config: { ...DEFAULT_SKILL_LEARNING_CONFIG, cooldownMs: 0 } });
  // Establish the required first observation through the real host CAS, not a
  // mocked eligible verdict. The next source is the genuine repeated task.
  await expect(start('prior', '以后必须先验证。').finish({ finalAnswer: '', terminal: 'completed' })).resolves.toMatchObject({ status: 'noop' });
  const committed = start('first', '以后必须先验证。').finish({ finalAnswer: '', terminal: 'completed' });
  await entered;
  expect(model.complete).toHaveBeenCalledTimes(3); // first observation, repeat, similarity
  expect(manage).toHaveBeenCalledOnce();
  const settled = vi.fn();
  const followup = start('followup', 'Nothing new happened.').finish({ finalAnswer: '', terminal: 'completed' });
  void followup.then(settled);
  release();
  await expect(committed).resolves.toMatchObject({ status: 'applied', batchId: 'committed-before-followup' });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(settled).toHaveBeenCalledWith(expect.objectContaining({ status: 'noop' }));
  expect(model.complete).toHaveBeenCalledTimes(3);
  expect(manage).toHaveBeenCalledOnce();
});

it('never upgrades the first native completion using a conflicting replay of the same tool identity', async () => {
  const turn = beginSkillLearningTurn({ origin: { ...origin, sessionId: 'conflicting-replay' }, prompt: 'ordinary task',
    selection: { adapter: 'codex', modelClass: 'default' }, config: { ...DEFAULT_SKILL_LEARNING_CONFIG, enabled: false },
    host: { list: vi.fn(), view: vi.fn(), manage: vi.fn() } });
  const completed = { runId: 'actual-child', toolCallId: 'same-call', toolName: 'terminal', phase: 'end' as const,
    provenance: 'native-tool' as const, status: 'success' as const, exitCode: 0, args: { command: 'pwd' } };
  turn.onTool(completed);
  turn.onTool({ ...completed, args: { command: 'npm test' } });
  expect(turn.getSnapshot().evidence).toEqual([expect.objectContaining({ kind: 'tool', summary: '{"command":"pwd"}' })]);
  await turn.finish({ finalAnswer: '', terminal: 'completed' });
});

it('cancels from the queued observer before any host or model dispatch', async () => {
  const owner = { ...origin, sessionId: 'queued-observer-cancel' };
  const host: SkillHostPort = { list: vi.fn(), view: vi.fn(), manage: vi.fn() };
  const model: SkillReviewModelPort = { capability: 'completion-only', complete: vi.fn() };
  const turn = beginSkillLearningTurn({ origin: owner, prompt: '以后必须先验证。', host, model,
    selection: { adapter: 'codex', modelClass: 'default' }, config: { ...DEFAULT_SKILL_LEARNING_CONFIG, cooldownMs: 0 },
    onState: (state) => { if (state.status === 'queued') cancelSkillLearning(owner); } });
  await expect(turn.finish({ finalAnswer: '', terminal: 'completed' })).resolves.toMatchObject({ status: 'cancelled' });
  expect(host.list).not.toHaveBeenCalled();
  expect(model.complete).not.toHaveBeenCalled();
});

it('holds a single correction and submits only a second highly similar source task', async () => {
  const owner = { ...origin, sessionId: 'automatic-finish' };
  const states: SkillReviewState[] = [];
  const result: SkillMutationResult = { status: 'awaiting_approval', batchId: 'real-batch', origin: owner,
    lesson: 'Read manifests before dependencies.', operationsApplied: 0, changes: [], riskReasons: ['approval policy'] };
  const manage = vi.fn(async () => result);
  const host: SkillHostPort = { list: async () => ({ revision: 'empty', entries: [] }), view: vi.fn(), manage };
  const model: SkillReviewModelPort = { capability: 'completion-only', complete: vi.fn(async (request) => {
    const payload = JSON.parse(request.userContent);
    if (request.system.includes('语义比对器')) return { text: JSON.stringify({ candidateId: payload.candidates[0].id, similarity: 0.98 }),
      usage: { inputTokens: 10, outputTokens: 10 } };
    return { text: JSON.stringify({ version: 1, kind: 'propose', lesson: result.lesson,
      evidenceIds: [payload.evidence[0].evidenceId], operations: [{ action: 'create', name: 'manifest-first', content: read.content }] }),
      usage: { inputTokens: 51, outputTokens: 21, totalTokens: 72 } };
  }) };
  const turn = beginSkillLearningTurn({ origin: owner, prompt: '以后必须先读 manifest 再选依赖。',
    selection: { adapter: 'codex', modelClass: 'default' }, config: { ...DEFAULT_SKILL_LEARNING_CONFIG, cooldownMs: 0 },
    host, model, onState: (state) => { states.push(state); } });
  const finished = turn.finish({ finalAnswer: 'I claim I saved a skill.', terminal: 'completed' });
  await expect(finished).resolves.toMatchObject({ status: 'noop',
    usage: { calls: 1, inputTokens: 51, outputTokens: 21, totalTokens: 72, estimated: false } });
  expect(manage).not.toHaveBeenCalled();
  expect(states[0].resume?.job.evidence[0]).toMatchObject({ provenance: 'user-input', kind: 'correction' });
  expect(states[0].resume?.selection).toEqual({ adapter: 'codex', modelClass: 'default' });
  expect(states.map((state) => state.status)).toEqual(['queued', 'reading', 'reading', 'proposing', 'noop']);
  expect(states.at(-1)?.result?.operationsApplied).toBe(0);
  expect(states.at(-1)?.origin.sessionId).toBe('automatic-finish');
  expect(turn.finish({ finalAnswer: 'duplicate finish', terminal: 'completed' })).toBe(finished);
  const second = beginSkillLearningTurn({ origin: { ...owner, turnId: 'second-turn', runId: 'second-run' },
    prompt: '以后选择依赖前必须读取 manifest。', selection: { adapter: 'codex', modelClass: 'default' },
    config: { ...DEFAULT_SKILL_LEARNING_CONFIG, cooldownMs: 0 }, host, model });
  await expect(second.finish({ finalAnswer: '已读 manifest', terminal: 'completed' })).resolves.toMatchObject({ status: 'awaiting_approval',
    batchId: 'real-batch', usage: { calls: 2, inputTokens: 61, outputTokens: 31, totalTokens: 92 } });
  expect(manage).toHaveBeenCalledOnce();
});
