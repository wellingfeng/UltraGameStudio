import { describe, expect, it, vi, afterEach } from 'vitest';
import { runSkillReview } from './review';
import type {
  SkillEntry, SkillHostPort, SkillLearningJob, SkillMutationResult,
  SkillProposal, SkillReadResult, SkillReviewModelPort, SkillReviewState,
} from './types';

const origin = { hostId: 'local', workspaceId: 'p', sessionId: 's', turnId: 't', runId: 'r' };
const config = {
  enabled: true, mode: 'auto-safe' as const, activityThreshold: 10, cooldownMs: 60000,
  maxRounds: 6, maxInputTokens: 48000, maxOutputTokens: 6000, timeoutMs: 90000,
  autoArchive: false, staleAfterDays: 30, archiveAfterDays: 90,
};
const job = (overrides: Partial<SkillLearningJob> = {}): SkillLearningJob => ({
  origin, userText: '纠正：先运行测试再修改', finalAnswer: 'done', loadedSkills: [], config, explicit: true,
  evidence: [{ evidenceId: 'e', origin, occurredAt: 1, kind: 'correction', provenance: 'user-input', status: 'success', summary: '先运行测试再修改' }],
  ...overrides,
});
const result = (status: SkillMutationResult['status']): SkillMutationResult => ({
  status, batchId: 'actual-host-batch', origin, lesson: 'Rule', operationsApplied: status === 'applied' ? 1 : 0,
  changes: [], riskReasons: [], revision: status === 'applied' ? 'new-revision' : undefined,
});
const proposal: SkillProposal = { version: 1, kind: 'propose', lesson: 'Run actual tests before editing.', evidenceIds: ['e'],
  operations: [{ action: 'create', name: 'testing-workflows', content: 'skill content' }] };
const host = (overrides: Partial<SkillHostPort> = {}): SkillHostPort => ({
  list: async () => ({ revision: 'catalog-1', entries: [] }),
  view: async () => { throw new Error('unexpected read'); },
  manage: async () => result('applied'), ...overrides,
});
const model = (texts: string[]): SkillReviewModelPort => ({ capability: 'completion-only',
  complete: async () => ({ text: texts.shift() ?? JSON.stringify({ version: 1, kind: 'noop', reason: 'nothing new' }) }),
});

const entry: SkillEntry = {
  skillId: 'skill-a', rootId: 'project', name: 'testing-workflows', description: 'Use when running tests.',
  scope: 'project', source: 'background', relativePath: 'testing-workflows', revision: 'current-r', hash: 'current-h',
  readOnly: false, autoEditable: true, contentLocked: false, pinned: false, state: 'active', files: ['SKILL.md', 'references/tests.md'],
};
const readResult = (filePath = 'SKILL.md'): SkillReadResult => ({
  entry, relativePath: filePath, content: filePath === 'SKILL.md' ? 'old rule; full content' : 'reference content',
  revision: 'current-r', hash: 'current-h', fullRead: true, readReceiptId: `receipt:${filePath}`, files: entry.files,
});

const patchProposal: SkillProposal = { ...proposal, operations: [{ action: 'patch', skillId: entry.skillId,
  oldString: 'old rule', newString: 'new rule', expectedHash: 'current-h', readReceiptId: 'receipt:SKILL.md' }] };

afterEach(() => vi.useRealTimers());
describe('bounded independent skill review', () => {
  it('keeps Chinese output instructions through reads and protocol correction', async () => {
    const requests: string[] = [];
    const replies = ['invalid JSON', JSON.stringify({ version: 1, kind: 'read', requests: [{ skillId: entry.skillId }] }),
      JSON.stringify({ version: 1, kind: 'noop', reason: '现有规则已覆盖，无需新增。' })];
    const review = await runSkillReview(job(), { host: host({ list: async () => ({ revision: 'r', entries: [entry] }), view: async () => readResult() }),
      model: { capability: 'completion-only', complete: async ({ system }) => {
        requests.push(system);
        return { text: replies.shift()! };
      } } });
    expect(review.status).toBe('noop');
    expect(requests).toHaveLength(3);
    for (const system of requests) {
      expect(system).toContain('简体中文');
      expect(system).toContain('oldString');
      expect(system).toContain('lesson');
      expect(system).toContain('reason');
    }
  });

  it('uses Chinese for a host-generated no-evidence result', async () => {
    const review = await runSkillReview(job({ evidence: [] }), { host: host(), model: model([]) });
    expect(review.lesson).toBe('没有可信的可复用证据，或技能学习已关闭。');
  });

  it('reviews a long tool session within the token budget across fresh-read rounds', async () => {
    const evidence = Array.from({ length: 28 }, (_, i) => ({
      ...job().evidence[0], evidenceId: `tool-${i}`, kind: 'tool' as const,
      provenance: 'native-tool' as const, toolCallId: `call-${i}`, toolName: 'exec_command',
      status: i === 0 ? 'error' as const : 'success' as const, exitCode: i === 0 ? 1 : 0,
      summary: '读取源码，执行验证。'.repeat(40), result: 'source line and diagnostic output\n'.repeat(120),
    }));
    const complete = vi.fn<SkillReviewModelPort['complete']>(async (request) => {
      const payload = JSON.parse(request.userContent);
      expect(payload.evidence.map((e: { evidenceId: string }) => e.evidenceId)).toContain('tool-0');
      expect(payload.evidence.map((e: { evidenceId: string }) => e.evidenceId)).toContain('tool-27');
      if (complete.mock.calls.length === 1) return {
        text: JSON.stringify({ version: 1, kind: 'read', requests: [{ skillId: entry.skillId }] }),
        usage: { inputTokens: 12000, outputTokens: 100 },
      };
      expect(payload.reads[0].content).toBe(readResult().content);
      expect(payload.reads[0].readReceiptId).toBe(readResult().readReceiptId);
      return { text: JSON.stringify({ ...patchProposal, evidenceIds: ['tool-0', 'tool-27'] }),
        usage: { inputTokens: 12000, outputTokens: 300 } };
    });
    const reviewed = await runSkillReview(job({ evidence }), {
      host: host({ list: async () => ({ revision: 'c', entries: [entry] }), view: async () => readResult() }),
      model: { capability: 'completion-only', complete },
    });
    expect(reviewed.status, reviewed.error).toBe('applied');
    expect(complete).toHaveBeenCalledTimes(2);
    expect(reviewed.usage).toMatchObject({ inputTokens: 24000, outputTokens: 400, estimated: false });
  });

  it('does not mistake a Chinese response byte length for output tokens without reported usage', async () => {
    const reason = '暂无新的可复用规则。'.repeat(220);
    const reviewed = await runSkillReview(job(), { host: host(),
      model: model([JSON.stringify({ version: 1, kind: 'noop', reason })]) });
    expect(reviewed.status, reviewed.error).toBe('noop');
    expect(reviewed.usage?.estimated).toBe(true);
    expect(reviewed.usage?.outputTokens).toBeLessThan(6000);
  });

  it('fits a final proposal after two measured read calls consumed 39992 input tokens', async () => {
    const evidence = Array.from({ length: 127 }, (_, i) => ({ ...job().evidence[0],
      evidenceId: `tool-${i}`, kind: 'tool' as const, provenance: 'native-tool' as const,
      toolCallId: `call-${i}`, toolName: 'exec_command',
      status: i < 16 ? 'error' as const : 'success' as const, exitCode: i < 16 ? 1 : 0,
      summary: '诊断信息。'.repeat(170), result: '诊断源码和实际验证输出。'.repeat(300),
    }));
    const complete = vi.fn<SkillReviewModelPort['complete']>(async (request) => {
      const payload = JSON.parse(request.userContent);
      if (complete.mock.calls.length <= 2) return {
        text: JSON.stringify({ version: 1, kind: 'read', requests: [{ skillId: entry.skillId }] }),
        usage: { inputTokens: 19996, outputTokens: 95 },
      };
      expect(payload.reads[0].content).toBe('old rule;'.repeat(550));
      expect(payload.evidence.some((e: { status: string }) => e.status === 'error')).toBe(true);
      expect(payload.evidence.at(-1).evidenceId).toBe('tool-126');
      return { text: JSON.stringify({ version: 1, kind: 'noop', reason: '已有规则覆盖。' }),
        usage: { inputTokens: 7000, outputTokens: 100 } };
    });
    const reviewed = await runSkillReview(job({ evidence, finalAnswer: '执行结果。'.repeat(400) }), {
      host: host({ list: async () => ({ revision: 'c', entries: [entry] }),
        view: async () => ({ ...readResult(), content: 'old rule;'.repeat(550) }) }),
      model: { capability: 'completion-only', complete },
    });
    expect(reviewed.status, reviewed.error).toBe('noop');
    expect(complete).toHaveBeenCalledTimes(3);
    expect(reviewed.usage).toMatchObject({ inputTokens: 46992, outputTokens: 290, calls: 3, estimated: false });
  });

  it('honors configured input/output budgets above the defaults', async () => {
    const reviewed = await runSkillReview(job({ config: { ...config, maxInputTokens: 96000, maxOutputTokens: 12000 } }), {
      host: host(), model: { capability: 'completion-only', complete: async (request) => {
        expect(request.maxOutputTokens).toBe(12000);
        return { text: JSON.stringify(proposal), usage: { inputTokens: 50000, outputTokens: 7000 } };
      } },
    });
    expect(reviewed.status, reviewed.error).toBe('applied');
    expect(reviewed.usage).toMatchObject({ inputTokens: 50000, outputTokens: 7000, estimated: false });
  });

  it('never truncates fresh skill contents to force an oversized read under budget', async () => {
    const complete = vi.fn<SkillReviewModelPort['complete']>();
    const reviewed = await runSkillReview(job({ loadedSkills: [{ skillId: entry.skillId, revision: 'r', hash: 'h', files: [] }] }), {
      host: host({ list: async () => ({ revision: 'c', entries: [entry] }),
        view: async () => ({ ...readResult(), content: '中'.repeat(50000) }) }),
      model: { capability: 'completion-only', complete },
    });
    expect(reviewed.error).toContain('BUDGET_TOKENS');
    expect(complete).not.toHaveBeenCalled();
  });

  it('redirects protected skill mutations to a writable companion before host dispatch', async () => {
    for (const protection of [{ scope: 'external' as const }, { readOnly: true }, { contentLocked: true }]) {
      const protectedEntry = { ...entry, ...protection };
      const companion = { ...proposal, operations: [{ action: 'create', name: 'local-testing-workflows', content: 'local reusable rules' }] };
      const manage = vi.fn(async () => result('applied'));
      const requests: string[] = [];
      const reviewer = model([JSON.stringify(patchProposal), JSON.stringify(companion)]);
      const complete = reviewer.complete;
      reviewer.complete = async (request) => { requests.push(request.userContent); return complete(request); };
      const reviewed = await runSkillReview(job({ loadedSkills: [{ skillId: entry.skillId, revision: 'r', hash: 'h', files: [] }] }), {
        host: host({ list: async () => ({ revision: 'c', entries: [protectedEntry] }),
          view: async () => ({ ...readResult(), entry: protectedEntry }), manage }), model: reviewer,
      });
      expect(reviewed.status).toBe('applied');
      expect(manage).toHaveBeenCalledExactlyOnceWith(companion);
      expect(requests[1]).toContain('Target is read-only or contentLocked');
      expect(JSON.parse(requests[0]).index[0]).toMatchObject({
        readOnly: protectedEntry.readOnly || protectedEntry.scope === 'external', contentLocked: protectedEntry.contentLocked,
      });
    }
  });

  it('allows slow completions past the legacy deadline, including historical retries', async () => {
    vi.useFakeTimers();
    for (const timeoutMs of [90000, 300000, 600000]) {
      const manage = vi.fn(async () => result('applied'));
      const pending = runSkillReview(job({ config: { ...config, timeoutMs } }), {
        host: host({ manage }), model: { capability: 'completion-only', complete: async (request) => {
          expect(request.timeoutMs).toBeGreaterThan(90000);
          await new Promise((resolve) => setTimeout(resolve, 120000));
          expect(request.signal.aborted).toBe(false);
          return { text: JSON.stringify(proposal) };
        } },
      });
      await vi.advanceTimersByTimeAsync(120000);
      expect((await pending).status).toBe('applied');
      expect(manage).toHaveBeenCalledTimes(1);
    }
  });

  it('fresh-reads loaded skills and requested references before accepting a patch', async () => {
    const seen: Array<{ system: string; userContent: string }> = [];
    const m = model([JSON.stringify({ version: 1, kind: 'read', requests: [{ skillId: entry.skillId, filePath: 'references/tests.md' }] }), JSON.stringify(patchProposal)]);
    const complete = m.complete;
    m.complete = async (request) => { seen.push(request); return complete(request); };
    const view = vi.fn(async ({ filePath }: { skillId: string; filePath?: string }) => readResult(filePath));
    const manage = vi.fn(async () => result('applied'));
    const reviewed = await runSkillReview(job({ loadedSkills: [{ skillId: entry.skillId, revision: 'old-r', hash: 'old-h', files: ['SKILL.md'] }] }), {
      host: host({ list: async () => ({ revision: 'catalog-new', entries: [entry] }), view, manage }), model: m,
    });
    expect(view).toHaveBeenCalledWith({ skillId: entry.skillId });
    expect(view).toHaveBeenCalledWith({ skillId: entry.skillId, filePath: 'references/tests.md' });
    expect(seen[0].userContent).toContain('old rule; full content');
    expect(seen[1].userContent).toContain('reference content');
    expect(seen[0].system).toMatch(/loaded.*patch/i);
    expect(reviewed.status).toBe('applied');
    expect(manage).toHaveBeenCalledWith(patchProposal);
  });

  it('cancels a late proposal before manage but preserves an already committed result', async () => {
    const controller = new AbortController();
    let deliver!: (value: { text: string }) => void;
    let started!: () => void;
    const called = new Promise<void>((resolve) => { started = resolve; });
    const manage = vi.fn(async () => result('applied'));
    const pending = runSkillReview(job(), { host: host({ manage }), signal: controller.signal,
      model: { capability: 'completion-only', complete: async () => { started(); return new Promise((resolve) => { deliver = resolve; }); } },
    });
    await called;
    controller.abort();
    deliver({ text: JSON.stringify(proposal) });
    expect((await pending).status).toBe('cancelled');
    expect(manage).not.toHaveBeenCalled();

    const committedAbort = new AbortController();
    const applied = await runSkillReview(job(), { host: host({ manage: async () => {
      committedAbort.abort(); return result('applied');
    } }), model: model([JSON.stringify(proposal)]), signal: committedAbort.signal });
    expect(applied.status).toBe('applied');
    expect(applied.operationsApplied).toBe(1);
  });

  it('refuses untrusted evidence and non-completion capability before calling a model', async () => {
    const complete = vi.fn(async () => ({ text: JSON.stringify(proposal) }));
    const manage = vi.fn(async () => result('applied'));
    for (const provenance of ['fixture', 'model-output', 'ui-synthetic'] as const) {
      const j = job(); j.evidence[0].provenance = provenance;
      expect((await runSkillReview(j, { host: host({ manage }), model: { capability: 'completion-only', complete } })).status).toBe('noop');
    }
    const wrong = { capability: 'full-tools', complete } as unknown as SkillReviewModelPort;
    expect((await runSkillReview(job(), { host: host({ manage }), model: wrong })).status).toBe('failed');
    expect(complete).not.toHaveBeenCalled();
    expect(manage).not.toHaveBeenCalled();
  });

  it('does not allow forged receipts, unknown evidence ids or multiple new skills', async () => {
    const manage = vi.fn(async () => result('applied'));
    const forged: SkillProposal = { ...patchProposal, operations: [{ ...patchProposal.operations[0], readReceiptId: 'invented' } as SkillProposal['operations'][number]] };
    for (const p of [forged, { ...proposal, evidenceIds: ['invented'] }, { ...proposal, operations: [...proposal.operations, ...proposal.operations] }]) {
      const reviewed = await runSkillReview(job(), { host: host({ manage, list: async () => ({ revision: 'c', entries: [entry] }) }), model: model([JSON.stringify(p), JSON.stringify(p)]) });
      expect(reviewed.status).toBe('failed');
    }
    expect(manage).not.toHaveBeenCalled();
  });

  it('allows only one deterministic protocol correction before a valid proposal', async () => {
    const m = model(['{"version":1,"kind":"exec","root":"C:/"}', JSON.stringify(proposal)]);
    const calls: string[] = [];
    const complete = m.complete;
    m.complete = async (request) => { calls.push(request.userContent); return complete(request); };
    const manage = vi.fn(async () => result('applied'));
    expect((await runSkillReview(job(), { host: host({ manage }), model: m })).status).toBe('applied');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('validationError');
    expect(manage).toHaveBeenCalledTimes(1);
    const invalid = model(['not json', 'still not json', JSON.stringify(proposal)]);
    invalid.complete = vi.fn(invalid.complete);
    expect((await runSkillReview(job(), { host: host({ manage }), model: invalid })).status).toBe('failed');
    expect(invalid.complete).toHaveBeenCalledTimes(2);
  });

  it('reports aggregate token exhaustion as failure and reports real per-call usage', async () => {
    const manage = vi.fn(async () => result('applied'));
    const tooMuch: SkillReviewModelPort = { capability: 'completion-only', complete: async () => ({
      text: JSON.stringify(proposal), usage: { inputTokens: 48001, outputTokens: 100 },
    }) };
    const exhausted = await runSkillReview(job(), { host: host({ manage }), model: tooMuch });
    expect(exhausted.status).toBe('failed');
    expect(exhausted.error).toContain('BUDGET');
    expect(manage).not.toHaveBeenCalled();
    const measured: SkillReviewModelPort = { capability: 'completion-only', complete: async () => ({
      text: JSON.stringify(proposal), usage: { inputTokens: 1200, outputTokens: 100, totalTokens: 1300 },
    }) };
    const applied = await runSkillReview(job(), { host: host({ manage }), model: measured });
    expect(applied.usage).toEqual({ inputTokens: 1200, outputTokens: 100, totalTokens: 1300, estimated: false, calls: 1 });
  });

  it('enforces a total deadline against a model that ignores cancellation', async () => {
    vi.useFakeTimers();
    let deliver!: (value: { text: string }) => void;
    let started!: () => void;
    const called = new Promise<void>((resolve) => { started = resolve; });
    let modelSignal!: AbortSignal;
    const manage = vi.fn(async () => result('applied'));
    const pending = runSkillReview(job({ config: { ...config, timeoutMs: 100 } }), {
      host: host({ manage }), model: { capability: 'completion-only', complete: async (request) => {
        modelSignal = request.signal; started(); return new Promise((resolve) => { deliver = resolve; });
      } },
    });
    await called;
    await vi.advanceTimersByTimeAsync(100);
    expect(modelSignal.aborted).toBe(true);
    expect((await pending).status).toBe('failed');
    deliver({ text: JSON.stringify(proposal) });
    await Promise.resolve();
    expect(manage).not.toHaveBeenCalled();
  });

  it('fails at the hard six-round aggregate limit rather than reporting noop', async () => {
    const complete = vi.fn<SkillReviewModelPort['complete']>(async () => ({ text: JSON.stringify({ version: 1, kind: 'read', requests: [{ skillId: entry.skillId }] }), usage: { inputTokens: 1, outputTokens: 1 } }));
    const manage = vi.fn(async () => result('applied'));
    const reviewed = await runSkillReview(job({ config: { ...config, maxRounds: 99 } }), {
      host: host({ list: async () => ({ revision: 'c', entries: [entry] }), view: async () => readResult(), manage }),
      model: { capability: 'completion-only', complete },
    });
    expect(complete).toHaveBeenCalledTimes(6);
    expect(reviewed.status).toBe('failed');
    expect(reviewed.error).toContain('BUDGET_ROUNDS');
    expect(manage).not.toHaveBeenCalled();
  });

  it('refuses malformed full-read receipts before the model receives skill content', async () => {
    const complete = vi.fn<SkillReviewModelPort['complete']>(async () => ({ text: JSON.stringify(patchProposal) }));
    for (const read of [
      { ...readResult(), fullRead: false }, { ...readResult(), entry: { ...entry, skillId: 'foreign' } },
      { ...readResult(), relativePath: 'references/not-main.md' }, { ...readResult(), content: 'x'.repeat(100001) },
    ]) {
      const reviewed = await runSkillReview(job({ loadedSkills: [{ skillId: entry.skillId, revision: 'r', hash: 'h', files: [] }] }), {
        host: host({ list: async () => ({ revision: 'c', entries: [entry] }), view: async () => read as SkillReadResult }),
        model: { capability: 'completion-only', complete },
      });
      expect(reviewed.status).toBe('failed');
    }
    expect(complete).not.toHaveBeenCalled();
  });

  it('treats an already present rule as noop without invoking manage', async () => {
    const manage = vi.fn(async () => result('applied'));
    const reviewed = await runSkillReview(job({ loadedSkills: [{ skillId: entry.skillId, revision: 'r', hash: 'h', files: [] }] }), {
      host: host({ list: async () => ({ revision: 'c', entries: [entry] }), view: async () => ({ ...readResult(), content: 'new rule; full content' }), manage }),
      model: model([JSON.stringify(patchProposal)]),
    });
    expect(reviewed.status).toBe('noop');
    expect(manage).not.toHaveBeenCalled();
  });

  it('accumulates input/output budget across read rounds rather than resetting each call', async () => {
    let calls = 0;
    const manage = vi.fn(async () => result('applied'));
    const m: SkillReviewModelPort = { capability: 'completion-only', complete: async () => {
      calls++;
      return { text: calls === 1 ? JSON.stringify({ version: 1, kind: 'read', requests: [{ skillId: entry.skillId }] }) : JSON.stringify(patchProposal),
        usage: { inputTokens: 100, outputTokens: 3100 } };
    } };
    const reviewed = await runSkillReview(job(), { host: host({ list: async () => ({ revision: 'c', entries: [entry] }), view: async () => readResult(), manage }), model: m });
    expect(reviewed).toMatchObject({ status: 'failed', usage: { inputTokens: 200, outputTokens: 6200, calls: 2, estimated: false } });
    expect(manage).not.toHaveBeenCalled();
  });

  it('gives the model the actual strict action schema and a small index without host policies', async () => {
    let seen = { system: '', userContent: '' };
    const m: SkillReviewModelPort = { capability: 'completion-only', complete: async (request) => {
      seen = request; return { text: '{"version":1,"kind":"noop","reason":"no lesson"}' };
    } };
    await runSkillReview(job(), { host: host({ list: async () => ({ revision: 'c', entries: [entry] }) }), model: m });
    expect(seen.system).toContain('readReceiptId');
    expect(seen.system).toContain('expectedHash');
    expect(seen.system).toContain('absent');
    expect(seen.system).toContain('oldString');
    expect(seen.system).toContain('model-output');
    expect(seen.userContent).not.toContain('autoEditable');
    expect(seen.userContent).not.toContain('rootId');
    expect(seen.userContent).toContain('catalogRevision');
  });

  it('rejects invalid budget values before invoking the completion port', async () => {
    const complete = vi.fn<SkillReviewModelPort['complete']>(async () => ({ text: JSON.stringify(proposal) }));
    const reviewed = await runSkillReview(job({ config: { ...config, maxInputTokens: Number.NaN } }), {
      host: host(), model: { capability: 'completion-only', complete },
    });
    expect(reviewed.status).toBe('failed');
    expect(reviewed.error).toContain('INVALID_BUDGET');
    expect(complete).not.toHaveBeenCalled();
  });

  it('marks interrupted completion usage as estimated and keeps unknown output cost unknown', async () => {
    const reviewed = await runSkillReview(job(), { host: host(), model: { capability: 'completion-only',
      complete: async () => { throw new Error('connection reset after dispatch'); },
    } });
    expect(reviewed.status).toBe('failed');
    expect(reviewed.usage).toMatchObject({ calls: 1, estimated: true });
    expect(reviewed.usage?.outputTokens).toBeUndefined();
    expect(reviewed.usage?.totalTokens).toBeUndefined();
  });

  it('permits one host validation correction but never retries a conflict or recovery result', async () => {
    const manage = vi.fn<SkillHostPort['manage']>().mockResolvedValueOnce({ ...result('failed'), error: 'Invalid YAML frontmatter' }).mockResolvedValueOnce(result('applied'));
    const reviewed = await runSkillReview(job(), { host: host({ manage }), model: model([JSON.stringify(proposal), JSON.stringify(proposal)]) });
    expect(reviewed.status).toBe('applied'); expect(manage).toHaveBeenCalledTimes(2);
    for (const status of ['conflicted', 'needs_recovery'] as const) {
      const unsafe = vi.fn(async () => ({ ...result(status), error: 'CAS conflict' }));
      expect((await runSkillReview(job(), { host: host({ manage: unsafe }), model: model([JSON.stringify(proposal)]) })).status).toBe(status);
      expect(unsafe).toHaveBeenCalledTimes(1);
    }
  });

  it('redirects duplicate class creation to a fresh read and existing-skill patch', async () => {
    const m = model([JSON.stringify(proposal), JSON.stringify({ version: 1, kind: 'read', requests: [{ skillId: entry.skillId }] }), JSON.stringify(patchProposal)]);
    const manage = vi.fn(async () => result('applied'));
    const reviewed = await runSkillReview(job(), { host: host({ list: async () => ({ revision: 'c', entries: [entry] }),
      view: async () => readResult(), manage }), model: m });
    expect(reviewed.status).toBe('applied');
    expect(manage).toHaveBeenCalledTimes(1);
    expect(manage).toHaveBeenCalledWith(patchProposal);
  });

  it('does not dispatch a completion after a state observer cancels the review', async () => {
    const controller = new AbortController();
    const complete = vi.fn<SkillReviewModelPort['complete']>(async () => ({ text: JSON.stringify(proposal) }));
    const manage = vi.fn(async () => result('applied'));
    const reviewed = await runSkillReview(job(), { host: host({ manage }), signal: controller.signal,
      model: { capability: 'completion-only', complete }, onState(state) { if (state.status === 'proposing') controller.abort(); } });
    expect(reviewed.status).toBe('cancelled');
    expect(complete).not.toHaveBeenCalled();
    expect(manage).not.toHaveBeenCalled();
  });

  it('rejects internally inconsistent host full-read receipts before model dispatch', async () => {
    const complete = vi.fn<SkillReviewModelPort['complete']>(async () => ({ text: JSON.stringify(patchProposal) }));
    for (const malformed of [
      { ...readResult(), revision: 'different-r' }, { ...readResult(), hash: 'different-h' },
    ]) {
      const reviewed = await runSkillReview(job({ loadedSkills: [{ skillId: entry.skillId, revision: 'r', hash: 'h', files: ['SKILL.md'] }] }), {
        host: host({ list: async () => ({ revision: 'c', entries: [entry] }), view: async () => malformed }),
        model: { capability: 'completion-only', complete },
      });
      expect(reviewed.status).toBe('failed');
      expect(reviewed.error).toContain('INVALID_FULL_READ');
    }
    expect(complete).not.toHaveBeenCalled();
  });

  it('isolates state observer failures during an explicit fresh-read round', async () => {
    const reviewed = await runSkillReview(job(), { host: host({ list: async () => ({ revision: 'c', entries: [entry] }), view: async () => readResult() }),
      model: model([JSON.stringify({ version: 1, kind: 'read', requests: [{ skillId: entry.skillId }] }), JSON.stringify(patchProposal)]),
      onState(state) { if (state.status === 'reading') throw new Error('UI observer failed'); } });
    expect(reviewed.status).toBe('applied');
  });

  it('redacts explicit focus before constructing a model snapshot', async () => {
    let input = '';
    await runSkillReview(job({ focus: 'password=focus-example; retain the general rule' }), { host: host(),
      model: { capability: 'completion-only', complete: async (request) => {
        input = request.userContent; return { text: '{"version":1,"kind":"noop","reason":"no reusable change"}' };
      } } });
    expect(input).not.toContain('focus-example');
    expect(input).toContain('[REDACTED]');
  });

  it('returns only actual host state, not a model claim of saved content', async () => {
    const states: SkillReviewState[] = [];
    const manage = vi.fn(async () => result('awaiting_approval'));
    const reviewed = await runSkillReview(job(), { host: host({ manage }), model: model([JSON.stringify(proposal)]), onState: (state) => states.push(state) });
    expect(manage).toHaveBeenCalledWith(proposal);
    expect(reviewed).toMatchObject({ status: 'awaiting_approval', operationsApplied: 0, batchId: 'actual-host-batch' });
    expect(states.at(-1)).toMatchObject({ status: 'awaiting_approval', origin, result: reviewed });
  });
});
