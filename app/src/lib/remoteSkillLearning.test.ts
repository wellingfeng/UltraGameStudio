import { afterEach, expect, it, vi } from 'vitest';
import { RunnerClient, REMOTE_SKILL_HOST_ID } from '@ugs/protocol';
import type { SkillEntry, SkillOrigin, SkillReadResult } from '@/runtime/skills/types';
import { DEFAULT_SKILL_LEARNING_CONFIG } from './skillLearningConfig';

const modulePath = './remoteSkillLearning';
const load = (): Promise<typeof import('./remoteSkillLearning') | null> => import(/* @vite-ignore */ modulePath).catch(() => null);
const origin: SkillOrigin = { hostId: REMOTE_SKILL_HOST_ID, workspaceId: 'remote-project', sessionId: 'source-session', turnId: 'source-turn', runId: 'preload-run' };
const entry: SkillEntry = { skillId: 'skill:remote-read', rootId: 'project:remote', name: 'remote-read', description: 'Use when reading a remote project.', scope: 'project', source: 'ugs-managed', relativePath: 'remote-read', revision: 'remote-revision', hash: 'remote-hash', readOnly: false, autoEditable: true, contentLocked: false, pinned: false, state: 'active', files: ['SKILL.md'] };
const read: SkillReadResult = { entry, relativePath: 'SKILL.md', content: '---\nname: remote-read\ndescription: Use when reading a remote project.\n---\nRead the authoritative remote disk, not a local copy.\n', revision: entry.revision, hash: entry.hash, fullRead: true, readReceiptId: 'remote-receipt', files: entry.files };
afterEach(() => { window.localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('preloads fresh remote content with the bound project origin and no owner authority', async () => {
  const remote = await load();
  expect(typeof remote?.requestRemoteContext).toBe('function');
  const calls: Array<{ path: string; body: Record<string, unknown> | undefined; headers: Headers }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ path, body, headers: new Headers(init?.headers) });
    const result = body?.action === 'list' ? { revision: 'catalog-remote', entries: [entry] } : body?.action === 'view' ? read : entry;
    return new Response(JSON.stringify(path.endsWith('/config') ? { ok: true, config: DEFAULT_SKILL_LEARNING_CONFIG } : { ok: true, result }), { status: 200 });
  }));
  const prompt = 'Read this project.';
  const historical = { system: 'unchanged source system', messages: [{ role: 'assistant', content: 'unchanged previous response' }] };
  const before = JSON.stringify(historical);
  const result = await remote!.requestRemoteContext({ client: new RunnerClient('https://runner.test', 'fixture-auth'), projectId: origin.workspaceId, origin, prompt, explicitSkillIds: [entry.skillId] });
  const block = result.prompt.split('<UGS_SKILL_CONTEXT>\n')[1]?.split('\n</UGS_SKILL_CONTEXT>')[0];
  expect(JSON.parse(block)[0].content).toBe(read.content);
  expect(result.prompt.startsWith(prompt)).toBe(true);
  expect(result.loadedSkills).toEqual([{ skillId: entry.skillId, revision: entry.revision, hash: entry.hash, files: ['SKILL.md'] }]);
  expect(JSON.stringify(historical)).toBe(before);
  for (const call of calls.filter((item) => item.body)) {
    expect(call.path).toBe('/projects/remote-project/skill-service');
    expect(call.body!.origin).toEqual(origin);
    expect(call.body).not.toHaveProperty('cwd');
    expect(call.headers.get('x-ugs-skill-control')).toBeNull();
    expect(call.headers.get('x-ugs-skill-user-input')).toBeNull();
  }
  expect(calls.find((call) => call.body?.action === 'usage')?.body).toMatchObject({ kind: 'delivered', skillId: entry.skillId });
});

it('reviews only a freshly fetched terminal native snapshot and forwards no owner control', async () => {
  const remote = await load();
  expect(typeof remote?.finishRemoteLearning).toBe('function');
  const runOrigin = { ...origin, sessionId: 'snapshot-session', runId: 'job-authentic' };
  const nativeId = JSON.stringify([runOrigin.runId, 'native-check']);
  const messages = [
    { at: 10, role: 'tool', kind: 'tool', runId: runOrigin.runId, toolCallId: 'native-check', toolName: 'command_execution', phase: 'end', provenance: 'native-tool', status: 'success', exitCode: 0, toolExitCode: 0, args: { command: 'node --test' }, result: '# tests 1\n# pass 1\n# fail 0\n' },
    { at: 11, role: 'tool', kind: 'tool', runId: runOrigin.runId, toolCallId: 'unfinished', toolName: 'command_execution', phase: 'start', provenance: 'native-tool', status: 'unknown' },
    { at: 12, role: 'tool', kind: 'tool', runId: runOrigin.runId, toolCallId: 'synthetic', toolName: 'command_execution', phase: 'end', provenance: 'ui-synthetic', status: 'success', exitCode: 0 },
  ];
  const calls: Array<{ path: string; body?: Record<string, unknown>; headers: Headers }> = [];
  const applied = { status: 'applied', batchId: 'batch-real', origin: runOrigin, lesson: 'Verify the host.', operationsApplied: 1, changes: [], riskReasons: [], rollbackId: 'rollback-real' };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ path, body, headers: new Headers(init?.headers) });
    const result = body?.action === 'manage' ? applied : { revision: 'remote-empty', entries: [] };
    return new Response(JSON.stringify(path.startsWith('/jobs/') ? { ok: true, job: { id: runOrigin.runId, projectId: runOrigin.workspaceId, skillOrigin: runOrigin, status: 'done', messages, result: { exitCode: 0 }, logs: [] } } : path.endsWith('/config') ? { ok: true, config: { ...DEFAULT_SKILL_LEARNING_CONFIG, activityThreshold: 1, cooldownMs: 0 } } : { ok: true, result }), { status: 200 });
  }));
  const complete = vi.fn(async (request: { userContent: string }) => {
    void request;
    return { text: JSON.stringify({ version: 1, kind: 'propose', lesson: applied.lesson, evidenceIds: [nativeId], operations: [{ action: 'create', name: 'server-check', content: '---\nname: server-check\ndescription: Use when checking the server.\n---\nVerify it.\n' }] }), usage: { inputTokens: 10, outputTokens: 20 } };
  });
  const onResult = vi.fn();
  const result = await remote!.finishRemoteLearning({ client: new RunnerClient('https://runner.test', 'fixture-auth'), projectId: runOrigin.workspaceId, origin: runOrigin, userText: 'Check a server.', finalAnswer: 'Verified.', loadedSkills: [], model: { capability: 'completion-only', complete }, onResult });
  expect(calls[0].path).toBe(`/jobs/${runOrigin.runId}`);
  expect(complete).toHaveBeenCalledTimes(1);
  const modelEvidence = JSON.parse(complete.mock.calls[0][0].userContent).evidence;
  expect(modelEvidence.map((item: { evidenceId: string }) => item.evidenceId)).toEqual([nativeId]);
  const manage = calls.find((call) => call.body?.action === 'manage');
  expect(manage).toBeUndefined();
  expect(result).toMatchObject({ status: 'noop', operationsApplied: 0 });
  expect(onResult).toHaveBeenCalledWith(result);
});

it('an explicit UI correction can trigger review but a zero-tool job exit cannot mint verification', async () => {
  const remote = await load();
  const runOrigin = { ...origin, sessionId: 'correction-session', runId: 'job-correction' };
  const manages: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    if (body?.action === 'manage') manages.push({ body, headers: new Headers(init?.headers) });
    return new Response(JSON.stringify(path.startsWith('/jobs/') ? { ok: true, job: { id: runOrigin.runId, projectId: runOrigin.workspaceId, skillOrigin: runOrigin, status: 'done', messages: [], result: { exitCode: 0 }, logs: [] } } : path.endsWith('/config') ? { ok: true, config: DEFAULT_SKILL_LEARNING_CONFIG } : { ok: true, result: body?.action === 'manage' ? { status: 'awaiting_approval', batchId: 'batch-correction', origin: runOrigin, lesson: 'Use the correction.', operationsApplied: 0, changes: [], riskReasons: ['owner policy'] } : { revision: 'empty', entries: [] } }), { status: 200 });
  }));
  const complete = vi.fn(async (request: { userContent: string }) => {
    const data = JSON.parse(request.userContent);
    return { text: JSON.stringify({ version: 1, kind: 'propose', lesson: 'Use the correction.', evidenceIds: data.evidence.map((item: { evidenceId: string }) => item.evidenceId), operations: [{ action: 'create', name: 'correction-check', content: '---\nname: correction-check\ndescription: Use when following user corrections.\n---\nDo not ignore corrections.\n' }] }), usage: { inputTokens: 20, outputTokens: 20 } };
  });
  const client = new RunnerClient('https://runner.test', 'fixture-auth');
  const base = { client, projectId: runOrigin.workspaceId, origin: runOrigin, userText: 'Ordinary text.', finalAnswer: 'The job process exited zero.', model: { capability: 'completion-only' as const, complete } };
  expect(await remote!.finishRemoteLearning(base)).toBeUndefined();
  expect(complete).not.toHaveBeenCalled();
  const result = await remote!.finishRemoteLearning({ ...base, userCorrections: [{ text: 'Correction: read the disk before changing it.', occurredAt: 20 }] });
  expect(result?.status).toBe('noop');
  expect(complete).toHaveBeenCalledTimes(1);
  const evidence = JSON.parse(complete.mock.calls[0][0].userContent).evidence;
  expect(evidence).toHaveLength(1);
  expect(evidence[0]).toMatchObject({ kind: 'correction', provenance: 'user-input', status: 'success', origin: runOrigin });
  expect(evidence[0]).not.toHaveProperty('exitCode');
  expect(manages).toHaveLength(0);
});

it('remote foreground owners pause queued learning until the last idempotent release', async () => {
  const remote = await load();
  expect(typeof remote?.beginRemoteSkillForeground).toBe('function');
  const runOrigin = { ...origin, sessionId: 'foreground-session', runId: 'job-foreground' };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    return new Response(JSON.stringify(path.startsWith('/jobs/') ? { ok: true, job: { id: runOrigin.runId, projectId: runOrigin.workspaceId, skillOrigin: runOrigin, status: 'done', messages: [], result: { exitCode: 0 }, logs: [] } } : path.endsWith('/config') ? { ok: true, config: { ...DEFAULT_SKILL_LEARNING_CONFIG, cooldownMs: 0 } } : { ok: true, result: body?.action === 'list' ? { revision: 'empty', entries: [] } : entry }), { status: 200 });
  }));
  const complete = vi.fn(async () => ({ text: '{"version":1,"kind":"noop","reason":"No new rule."}', usage: { inputTokens: 1, outputTokens: 1 } }));
  const firstRelease = remote!.beginRemoteSkillForeground();
  const secondRelease = remote!.beginRemoteSkillForeground();
  let settled = false;
  const pending = remote!.finishRemoteLearning({ client: new RunnerClient('https://foreground-runner.test', 'fixture-auth'), projectId: runOrigin.workspaceId, origin: runOrigin, userText: 'Correction.', finalAnswer: 'Done.', userCorrections: [{ text: 'A real correction.', occurredAt: 1 }], model: { capability: 'completion-only', complete } }).then((result: unknown) => { settled = true; return result; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(complete).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    firstRelease();
    firstRelease();
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(complete).not.toHaveBeenCalled();
    secondRelease();
    expect(await pending).toMatchObject({ status: 'noop', origin: runOrigin });
    expect(complete).toHaveBeenCalledTimes(1);
  } finally { firstRelease(); secondRelease(); }
});

it('publishes the frozen queued origin before dispatch and honors cancellation from that observer', async () => {
  const remote = await load();
  const runOrigin = { ...origin, sessionId: 'queued-state-session', runId: 'job-queued-state' };
  const controller = new AbortController();
  const complete = vi.fn(async () => ({ text: '{"version":1,"kind":"noop","reason":"No rule."}' }));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(new URL(url).pathname.startsWith('/jobs/')
    ? { ok: true, job: { id: runOrigin.runId, projectId: runOrigin.workspaceId, skillOrigin: runOrigin, status: 'done', messages: [], result: { exitCode: 0 }, logs: [] } }
    : new URL(url).pathname.endsWith('/config') ? { ok: true, config: { ...DEFAULT_SKILL_LEARNING_CONFIG, cooldownMs: 0 } }
      : { ok: true, result: { revision: 'empty', entries: [] } }), { status: 200 })));
  const onState = vi.fn((state: { status: string; origin: SkillOrigin }) => { if (state.status === 'queued') controller.abort(); });
  expect(await remote!.finishRemoteLearning({ client: new RunnerClient('https://queued-state-runner.test', 'fixture-auth'),
    projectId: runOrigin.workspaceId, origin: runOrigin, userText: 'Correction.', finalAnswer: 'Done.',
    userCorrections: [{ text: 'Read before editing.', occurredAt: 1 }], signal: controller.signal,
    model: { capability: 'completion-only', complete }, onState })).toBeUndefined();
  expect(onState).toHaveBeenCalledWith({ status: 'queued', origin: runOrigin, mode: 'auto-safe' });
  expect(complete).not.toHaveBeenCalled();
});

it('every remote review state carries its frozen server mode instead of current UI policy', async () => {
  const remote = await load();
  const runOrigin = { ...origin, sessionId: 'frozen-mode-session', runId: 'job-frozen-mode' };
  const onState = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    return Response.json(path.startsWith('/jobs/')
      ? { ok: true, job: { id: runOrigin.runId, projectId: runOrigin.workspaceId, skillOrigin: runOrigin,
        status: 'done', messages: [], result: { exitCode: 0 }, logs: [] } }
      : path.endsWith('/config') ? { ok: true, config: { ...DEFAULT_SKILL_LEARNING_CONFIG,
        mode: 'approve-all', cooldownMs: 0 } }
        : { ok: true, result: { revision: 'empty', entries: [] } });
  }));
  const result = await remote!.finishRemoteLearning({ client: new RunnerClient('https://frozen-mode-runner.test', 'fixture-auth'),
    projectId: runOrigin.workspaceId, origin: runOrigin, userText: 'Correction.', finalAnswer: 'Done.',
    userCorrections: [{ text: 'Read before editing.', occurredAt: 1 }],
    model: { capability: 'completion-only', complete: async () => ({ text: '{"version":1,"kind":"noop","reason":"No new rule."}' }) },
    onState });
  expect(result).toMatchObject({ status: 'noop', origin: runOrigin });
  expect(onState.mock.calls.map(([state]) => state.status)).toEqual(['queued', 'reading', 'proposing', 'noop']);
  expect(onState.mock.calls.map(([state]) => state.mode)).toEqual(['approve-all', 'approve-all', 'approve-all', 'approve-all']);
});

it('an aborted remote review settles while another foreground owner still holds the queue', async () => {
  const remote = await load();
  const runOrigin = { ...origin, sessionId: 'queued-abort-session', runId: 'job-queued-abort' };
  const client = new RunnerClient('https://queued-abort-runner.test', 'fixture-auth');
  const complete = vi.fn(async () => ({ text: '{"version":1,"kind":"noop","reason":"No rule."}' }));
  const controller = new AbortController();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(new URL(url).pathname.startsWith('/jobs/')
    ? { ok: true, job: { id: runOrigin.runId, projectId: runOrigin.workspaceId, skillOrigin: runOrigin, status: 'done', messages: [], result: { exitCode: 0 }, logs: [] } }
    : { ok: true, config: { ...DEFAULT_SKILL_LEARNING_CONFIG, cooldownMs: 0 } }), { status: 200 })));
  const release = remote!.beginRemoteSkillForeground();
  const pending = remote!.finishRemoteLearning({ client, projectId: runOrigin.workspaceId, origin: runOrigin,
    userText: 'Correction.', finalAnswer: 'Done.', userCorrections: [{ text: 'Read before editing.', occurredAt: 1 }],
    signal: controller.signal, model: { capability: 'completion-only', complete } });
  try {
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    expect(await Promise.race([pending.then((result) => ({ settled: true, result })),
      new Promise((resolve) => setTimeout(() => resolve({ settled: false }), 50))])).toEqual({ settled: true, result: undefined });
    expect(complete).not.toHaveBeenCalled();
  } finally { release(); await pending; }
});

it('pending remote review runs when cooldown expires without requiring another user turn', async () => {
  const remote = await load();
  const runOrigin = { ...origin, sessionId: 'cooldown-session', runId: 'job-cooldown-first' };
  let latest = runOrigin;
  const client = new RunnerClient('https://cooldown-runner.test', 'fixture-auth');
  const complete = vi.fn(async (request: { userContent: string }) => {
    void request;
    return { text: '{"version":1,"kind":"noop","reason":"Reviewed."}', usage: { inputTokens: 1, outputTokens: 1 } };
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    return new Response(JSON.stringify(path.startsWith('/jobs/') ? { ok: true, job: { id: latest.runId, projectId: latest.workspaceId, skillOrigin: latest, status: 'done', messages: [{ at: 10, role: 'tool', kind: 'tool', runId: latest.runId, toolCallId: 'check', toolName: 'command_execution', phase: 'end', provenance: 'native-tool', status: 'success', toolExitCode: 0, args: { command: 'node --test' }, result: '# tests 1\n# pass 1\n# fail 0\n' }], result: { exitCode: 0 }, logs: [] } } : path.endsWith('/config') ? { ok: true, config: { ...DEFAULT_SKILL_LEARNING_CONFIG, activityThreshold: 1, cooldownMs: 40 } } : { ok: true, result: { revision: 'empty', entries: [] } }), { status: 200 });
  }));
  const options = { client, projectId: runOrigin.workspaceId, userText: 'Check.', finalAnswer: 'Done.', model: { capability: 'completion-only' as const, complete } };
  expect((await remote!.finishRemoteLearning({ ...options, origin: runOrigin }))?.status).toBe('noop');
  latest = { ...runOrigin, runId: 'job-cooldown-next', turnId: 'next-turn' };
  const pending = remote!.finishRemoteLearning({ ...options, origin: latest });
  await new Promise((resolve) => setTimeout(resolve, 65));
  expect(complete).toHaveBeenCalledTimes(2);
  expect(await pending).toMatchObject({ status: 'noop', origin: latest });
});

it('fresh evidence observed during an active remote review runs afterward without a third turn', async () => {
  const remote = await load();
  const first = { ...origin, sessionId: 'active-pending-session', runId: 'job-active-first' };
  const second = { ...first, turnId: 'active-second-turn', runId: 'job-active-second' };
  const client = new RunnerClient('https://active-pending-runner.test', 'fixture-auth');
  let releaseFirst!: () => void;
  const firstReply = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let started!: () => void;
  const modelStarted = new Promise<void>((resolve) => { started = resolve; });
  const complete = vi.fn(async () => {
    if (complete.mock.calls.length === 1) { started(); await firstReply; }
    return { text: '{"version":1,"kind":"noop","reason":"Reviewed the captured turn."}', usage: { inputTokens: 1, outputTokens: 1 } };
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    const source = path.endsWith(first.runId) ? first : second;
    return new Response(JSON.stringify(path.startsWith('/jobs/') ? { ok: true, job: { id: source.runId, projectId: source.workspaceId, skillOrigin: source, status: 'done', messages: [{ at: 10, role: 'tool', kind: 'tool', runId: source.runId, toolCallId: 'check', toolName: 'command_execution', phase: 'end', provenance: 'native-tool', status: 'success', toolExitCode: 0, args: { command: 'node --test' }, result: '# tests 1\n# pass 1\n# fail 0\n' }], result: { exitCode: 0 }, logs: [] } } : path.endsWith('/config') ? { ok: true, config: { ...DEFAULT_SKILL_LEARNING_CONFIG, activityThreshold: 1, cooldownMs: 0 } } : { ok: true, result: { revision: 'empty', entries: [] } }), { status: 200 });
  }));
  const common = { client, projectId: first.workspaceId, userText: 'Check.', finalAnswer: 'Done.', model: { capability: 'completion-only' as const, complete } };
  const firstPending = remote!.finishRemoteLearning({ ...common, origin: first });
  await modelStarted;
  const onResult = vi.fn();
  const secondPending = remote!.finishRemoteLearning({ ...common, origin: second, onResult });
  try {
    await new Promise((resolve) => setTimeout(resolve, 15));
    releaseFirst();
    expect(await firstPending).toMatchObject({ status: 'noop', origin: first });
    expect(await secondPending).toMatchObject({ status: 'noop', origin: second });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ origin: second }));
  } finally { releaseFirst(); await firstPending; await secondPending; }
});

it('a remote review queued behind an active review still observes the remaining cooldown', async () => {
  const remote = await load();
  const first = { ...origin, sessionId: 'active-cooldown-session', runId: 'job-active-cooldown-first' };
  const second = { ...first, turnId: 'second-turn', runId: 'job-active-cooldown-second' };
  const client = new RunnerClient('https://active-cooldown-runner.test', 'fixture-auth');
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => { started = resolve; });
  const complete = vi.fn(async () => {
    if (complete.mock.calls.length === 1) { started(); await barrier; }
    return { text: '{"version":1,"kind":"noop","reason":"Reviewed."}', usage: { inputTokens: 1, outputTokens: 1 } };
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    const source = path.endsWith(first.runId) ? first : second;
    return new Response(JSON.stringify(path.startsWith('/jobs/') ? { ok: true, job: { id: source.runId, projectId: source.workspaceId, skillOrigin: source, status: 'done', messages: [], result: { exitCode: 0 }, logs: [] } } : path.endsWith('/config') ? { ok: true, config: { ...DEFAULT_SKILL_LEARNING_CONFIG, cooldownMs: 60 } } : { ok: true, result: { revision: 'empty', entries: [] } }), { status: 200 });
  }));
  const common = { client, projectId: first.workspaceId, userText: 'Correction.', finalAnswer: 'Done.', userCorrections: [{ text: 'Read before editing.', occurredAt: 1 }], model: { capability: 'completion-only' as const, complete } };
  const firstPending = remote!.finishRemoteLearning({ ...common, origin: first });
  await firstStarted;
  const secondPending = remote!.finishRemoteLearning({ ...common, origin: second });
  try {
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await firstPending;
    expect(await secondPending).toMatchObject({ status: 'noop', origin: second });
    expect(complete).toHaveBeenCalledTimes(2);
  } finally { release(); await firstPending; await secondPending; }
});

it('a newer remote turn supersedes a cooling review without inheriting its callbacks', async () => {
  const remote = await load();
  const first = { ...origin, sessionId: 'cooldown-replacement-session', runId: 'job-cooldown-replacement-first' };
  const second = { ...first, turnId: 'second-turn', runId: 'job-cooldown-replacement-second' };
  const third = { ...first, turnId: 'third-turn', runId: 'job-cooldown-replacement-third' };
  const client = new RunnerClient('https://cooldown-replacement-runner.test', 'fixture-auth');
  const complete = vi.fn(async () => ({ text: '{"version":1,"kind":"noop","reason":"Reviewed."}', usage: { inputTokens: 1, outputTokens: 1 } }));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    const source = [first, second, third].find((item) => path.endsWith(item.runId)) ?? first;
    return new Response(JSON.stringify(path.startsWith('/jobs/') ? { ok: true, job: { id: source.runId, projectId: source.workspaceId, skillOrigin: source, status: 'done', messages: [], result: { exitCode: 0 }, logs: [] } } : path.endsWith('/config') ? { ok: true, config: { ...DEFAULT_SKILL_LEARNING_CONFIG, cooldownMs: 60 } } : { ok: true, result: { revision: 'empty', entries: [] } }), { status: 200 });
  }));
  const common = { client, projectId: first.workspaceId, userText: 'Correction.', finalAnswer: 'Done.', userCorrections: [{ text: 'Read before editing.', occurredAt: 1 }], model: { capability: 'completion-only' as const, complete } };
  await remote!.finishRemoteLearning({ ...common, origin: first });
  const secondResult = vi.fn();
  const secondPending = remote!.finishRemoteLearning({ ...common, origin: second, onResult: secondResult });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const thirdResult = vi.fn();
  const thirdPending = remote!.finishRemoteLearning({ ...common, origin: third, onResult: thirdResult });
  expect(await secondPending).toBeUndefined();
  expect(await thirdPending).toMatchObject({ status: 'noop', origin: third });
  expect(secondResult).not.toHaveBeenCalled();
  expect(thirdResult).toHaveBeenCalledWith(expect.objectContaining({ origin: third }));
  expect(complete).toHaveBeenCalledTimes(2);
});

it('remote native evidence retains an explicit null primary tool exit instead of falling back to zero', async () => {
  const remote = await load();
  const runOrigin = { ...origin, sessionId: 'primary-null-session', runId: 'job-null-primary' };
  const complete = vi.fn(async (request: { userContent: string }) => {
    void request;
    return { text: '{"version":1,"kind":"noop","reason":"No automatic verification."}', usage: { inputTokens: 1, outputTokens: 1 } };
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    return new Response(JSON.stringify(path.startsWith('/jobs/') ? { ok: true, job: { id: runOrigin.runId, projectId: runOrigin.workspaceId, skillOrigin: runOrigin, status: 'done', messages: [{ at: 10, role: 'tool', kind: 'tool', runId: runOrigin.runId, toolCallId: 'check', toolName: 'command_execution', phase: 'end', provenance: 'native-tool', status: 'success', toolExitCode: null, exitCode: 0, args: { command: 'node --test' }, result: '# tests 1\n# pass 1\n# fail 0\n' }], result: { exitCode: 0 }, logs: [] } } : path.endsWith('/config') ? { ok: true, config: { ...DEFAULT_SKILL_LEARNING_CONFIG, activityThreshold: 1 } } : { ok: true, result: { revision: 'empty', entries: [] } }), { status: 200 });
  }));
  await remote!.finishRemoteLearning({ client: new RunnerClient('https://runner.test', 'fixture-auth'), projectId: runOrigin.workspaceId, origin: runOrigin, userText: 'Check.', finalAnswer: 'Done.', model: { capability: 'completion-only', complete } });
  const evidence = JSON.parse(complete.mock.calls[0][0].userContent).evidence;
  expect(evidence).toHaveLength(1);
  expect(evidence[0].exitCode).toBeNull();
  expect(evidence[0].kind).toBe('tool');
});

it('finish rejects a real job snapshot that was relabelled to another captured source', async () => {
  const remote = await load();
  const runOrigin = { ...origin, sessionId: 'bound-source-session', runId: 'job-bound-source' };
  const complete = vi.fn(async () => ({ text: '{"version":1,"kind":"noop","reason":"No new rule."}' }));
  const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(new URL(url).pathname.startsWith('/jobs/') ? { ok: true, job: { id: runOrigin.runId, projectId: runOrigin.workspaceId, skillOrigin: { ...runOrigin, turnId: 'server-original-turn' }, status: 'done', messages: [], result: { exitCode: 0 }, logs: [] } } : new URL(url).pathname.endsWith('/config') ? { ok: true, config: DEFAULT_SKILL_LEARNING_CONFIG } : { ok: true, result: { revision: 'empty', entries: [] } }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  await expect(remote!.finishRemoteLearning({ client: new RunnerClient('https://runner.test', 'fixture-auth'), projectId: runOrigin.workspaceId, origin: runOrigin, userText: 'Correction.', finalAnswer: 'Done.', userCorrections: [{ text: 'A real correction.', occurredAt: 1 }], model: { capability: 'completion-only', complete } })).rejects.toThrow('REMOTE_SKILL_JOB_ORIGIN_MISMATCH');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(complete).not.toHaveBeenCalled();
});

it('a captured remote source survives UI navigation and a late abort cannot hide an applied host commit', async () => {
  vi.spyOn(await import('@/runtime/skills/preReview'), 'observeSkillCandidate').mockResolvedValue({ eligible: true, consecutive: 2 });
  const remote = await load();
  const savedOrigin = { ...origin, sessionId: 'late-commit-session', runId: 'job-late-commit' };
  const mutableOrigin = { ...savedOrigin };
  const client = new RunnerClient('https://late-commit-runner.test', 'fixture-auth');
  const controller = new AbortController();
  const nativeId = JSON.stringify([savedOrigin.runId, 'native-check']);
  const bodies: Array<Record<string, unknown>> = [];
  const committed = { status: 'applied', batchId: 'late-batch', origin: savedOrigin, lesson: 'Verify before learning.', operationsApplied: 1, changes: [], riskReasons: [] };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    if (body) bodies.push(body);
    if (path.startsWith('/jobs/')) { mutableOrigin.workspaceId = 'navigated-project'; mutableOrigin.sessionId = 'navigated-session'; }
    if (body?.action === 'manage') { controller.abort(); expect(init?.signal).toBeUndefined(); }
    return new Response(JSON.stringify(path.startsWith('/jobs/') ? { ok: true, job: { id: savedOrigin.runId, projectId: savedOrigin.workspaceId, skillOrigin: savedOrigin, status: 'done', messages: [{ at: 10, role: 'tool', kind: 'tool', runId: savedOrigin.runId, toolCallId: 'native-check', toolName: 'command_execution', phase: 'end', provenance: 'native-tool', status: 'success', toolExitCode: 0, args: { command: 'node --test' }, result: '# tests 1\n# pass 1\n# fail 0\n' }], result: { exitCode: 0 }, logs: [] } } : path.endsWith('/config') ? { ok: true, config: { ...DEFAULT_SKILL_LEARNING_CONFIG, activityThreshold: 1, cooldownMs: 0 } } : { ok: true, result: body?.action === 'manage' ? committed : { revision: 'empty', entries: [] } }), { status: 200 });
  }));
  const complete = vi.fn(async () => ({ text: JSON.stringify({ version: 1, kind: 'propose', lesson: committed.lesson, evidenceIds: [nativeId], operations: [{ action: 'create', name: 'late-rule', content: '---\nname: late-rule\ndescription: Use when verifying a late commit.\n---\nKeep the actual result.' }] }), usage: { inputTokens: 1, outputTokens: 1 } }));
  const onState = vi.fn();
  const onResult = vi.fn(() => { throw new Error('fixture observer failure'); });
  expect(await remote!.finishRemoteLearning({ client, projectId: savedOrigin.workspaceId, origin: mutableOrigin,
    userText: 'Verify.', finalAnswer: 'Done.', model: { capability: 'completion-only', complete }, signal: controller.signal, onState, onResult })).toMatchObject(committed);
  expect(bodies.every((body) => JSON.stringify(body.origin) === JSON.stringify(savedOrigin))).toBe(true);
  expect(onState.mock.calls.map(([state]) => state.status)).toEqual(['queued', 'reading', 'proposing', 'applying', 'applied']);
  expect(onResult).toHaveBeenCalledWith(expect.objectContaining(committed));
});

it('a throwing or mutating remote result observer cannot rewrite the host outcome', async () => {
  const remote = await load();
  const runOrigin = { ...origin, sessionId: 'observer-isolation-session', runId: 'job-observer-isolation' };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    return new Response(JSON.stringify(path.startsWith('/jobs/') ? { ok: true, job: { id: runOrigin.runId, projectId: runOrigin.workspaceId, skillOrigin: runOrigin, status: 'done', messages: [], result: { exitCode: 0 }, logs: [] } } : path.endsWith('/config') ? { ok: true, config: { ...DEFAULT_SKILL_LEARNING_CONFIG, cooldownMs: 0 } } : { ok: true, result: { revision: 'empty', entries: [] } }), { status: 200 });
  }));
  const result = await remote!.finishRemoteLearning({ client: new RunnerClient('https://observer-isolation-runner.test', 'fixture-auth'), projectId: runOrigin.workspaceId, origin: runOrigin,
    userText: 'Correction.', finalAnswer: 'Done.', userCorrections: [{ text: 'Read first.', occurredAt: 1 }],
    model: { capability: 'completion-only', complete: async () => ({ text: '{"version":1,"kind":"noop","reason":"No new lesson."}', usage: { inputTokens: 1, outputTokens: 1 } }) },
    onState: (state) => { if (state.result) { state.result.status = 'applied'; state.result.origin.workspaceId = 'foreign-observer-project'; } },
    onResult: (outcome) => { outcome.status = 'failed'; outcome.origin.sessionId = 'foreign-observer-session'; throw new Error('fixture observer failure'); },
  });
  expect(result).toMatchObject({ status: 'noop', origin: runOrigin, operationsApplied: 0 });
});

it('remote review refuses a host mutation result whose origin belongs to another source', async () => {
  vi.spyOn(await import('@/runtime/skills/preReview'), 'observeSkillCandidate').mockResolvedValue({ eligible: true, consecutive: 2 });
  const remote = await load();
  const runOrigin = { ...origin, sessionId: 'mutation-result-source', runId: 'job-mutation-result-source' };
  const onState = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    return Response.json(path.startsWith('/jobs/')
      ? { ok: true, job: { id: runOrigin.runId, projectId: runOrigin.workspaceId, skillOrigin: runOrigin,
        status: 'done', messages: [], result: { exitCode: 0 }, logs: [] } }
      : path.endsWith('/config') ? { ok: true, config: { ...DEFAULT_SKILL_LEARNING_CONFIG, cooldownMs: 0 } }
        : { ok: true, result: body?.action === 'manage'
          ? { status: 'applied', batchId: 'foreign-host-batch', origin: { ...runOrigin, sessionId: 'foreign-session' },
            lesson: 'Foreign result.', operationsApplied: 1, changes: [], riskReasons: [] }
          : { revision: 'empty', entries: [] } });
  }));
  const result = await remote!.finishRemoteLearning({ client: new RunnerClient('https://mutation-result-runner.test', 'fixture-auth'),
    projectId: runOrigin.workspaceId, origin: runOrigin, userText: 'Correction.', finalAnswer: 'Done.',
    userCorrections: [{ text: 'Read before editing.', occurredAt: 1 }], onState,
    model: { capability: 'completion-only', complete: async (request) => ({ text: JSON.stringify({ version: 1,
      kind: 'propose', lesson: 'Check the original source.', evidenceIds: JSON.parse(request.userContent).evidence
        .map((item: { evidenceId: string }) => item.evidenceId), operations: [{ action: 'create', name: 'source-check',
          content: '---\nname: source-check\ndescription: Use when checking the original source.\n---\nVerify the source.' }] }) }) } });
  expect(result).toMatchObject({ status: 'failed', origin: runOrigin, operationsApplied: 0,
    error: expect.stringContaining('REMOTE_SKILL_MUTATION_ORIGIN_MISMATCH') });
  expect(onState.mock.calls.some(([state]) => state.status === 'applied')).toBe(false);
});

it('the control host alone supplies owner authority and retains the captured project origin', async () => {
  const remote = await load();
  expect(typeof remote?.createRemoteSkillControlHost).toBe('function');
  const original = { ...origin, sessionId: 'owner-session', runId: 'owner-ui' };
  const source = { ...original };
  const calls: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ body, headers: new Headers(init?.headers) });
    return new Response(JSON.stringify({ ok: true, result: body.action === 'history' ? { results: [] } : body.action === 'set_policy' ? entry : { status: 'rejected', batchId: 'batch-pending', origin: original, lesson: 'Frozen.', operationsApplied: 0, changes: [], riskReasons: [] } }), { status: 200 });
  }));
  const host = remote!.createRemoteSkillControlHost({ client: new RunnerClient('https://runner.test', 'fixture-auth'), projectId: source.workspaceId, origin: source, mode: 'off' });
  source.workspaceId = 'switched-project';
  source.sessionId = 'switched-session';
  await host.reject('batch-pending');
  await host.setPolicy(entry.skillId, { pinned: true });
  await host.history();
  for (const call of calls) {
    expect(call.body.origin).toEqual(original);
    expect(call.body.mode).toBe('off');
    expect(call.headers.get('x-ugs-skill-control')).toBe('owner');
    expect(call.headers.get('x-ugs-skill-user-input')).toBeNull();
  }
  expect(calls[0].body).toMatchObject({ action: 'reject', batchId: 'batch-pending' });
  expect(calls[1].body).toMatchObject({ action: 'set_policy', policy: { pinned: true } });
  await expect(host.manage({ version: 1, kind: 'propose', lesson: 'No owner autoapprove.', evidenceIds: [], operations: [{ action: 'create', name: 'owner-bypass', content: 'invalid' }] })).rejects.toThrow('REMOTE_SKILL_CONTROL_REVIEW_FORBIDDEN');
  await host.revoke();
  await host.revoke();
  await expect(host.history()).rejects.toThrow('REMOTE_SKILL_CONTROL_REVOKED');
  expect(calls).toHaveLength(3);
});
