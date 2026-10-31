import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillMutationResult, SkillReviewState } from '@/runtime/skills/types';
import { runSkillReview } from '@/runtime/skills/review';
import Card from './SkillLearningCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const origin = { hostId: 'local', workspaceId: 'ws-a', sessionId: 'session-a', turnId: 'turn-a', runId: 'run-a' };
function result(status: SkillMutationResult['status'] = 'awaiting_approval'): SkillMutationResult {
  return {
    status, batchId: 'batch-a', origin, lesson: '验证工具退出码后再报告成功', operationsApplied: 0,
    changes: [{ skillId: 'skill-a', name: 'verify-tools', filePath: 'SKILL.md',
      before: '旧规则', after: '新规则', beforeHash: 'before-hash', afterHash: 'after-hash' }],
    riskReasons: ['导入技能尚未授权自动编辑'],
  };
}

describe('SkillLearningCard', () => {
  it.each(['zh-CN', 'en-US'] as const)('hides completed no-lesson and nonadmitted reviews only in chat (%s)', async locale => {
    const noop: SkillReviewState = { status: 'noop', origin, result: { ...result('noop'), lesson: 'No reusable lesson.', usage: { calls: 1, estimated: false } } };
    const skipped: SkillReviewState = { status: 'noop', origin, admission: { status: 'not-admitted', reason: 'insufficient-evidence', completedActivities: 3, activityThreshold: 10 } };
    for (const state of [noop, skipped]) {
      const before = JSON.stringify(state);
      await act(async () => { root.render(<Card locale={locale} state={state} />); });
      expect(container.childElementCount).toBe(0);
      await act(async () => { root.render(<Card surface="history" locale={locale} state={JSON.parse(before)} />); });
      expect(container.querySelector('article')).not.toBeNull();
      expect(container.querySelector('[role="status"]')?.textContent).toBe(locale === 'zh-CN'
        ? (state.admission ? '未触发技能复盘' : '无新经验')
        : (state.admission ? 'Skill review not started' : 'No new lesson'));
      if (!state.admission) expect(container.textContent).toContain(locale === 'zh-CN' ? '1 次模型调用' : '1 model calls');
      expect(JSON.stringify(state)).toBe(before);
    }
  });

  it('distinguishes threshold admission from an actual review with no new lesson', async () => {
    const skipped = { ...result('noop'), lesson: 'No reusable lesson.' };
    const state: SkillReviewState = { status: 'noop', origin, result: skipped, detail: '独立宿主诊断仍可见',
      admission: { status: 'not-admitted', reason: 'insufficient-evidence', completedActivities: 1, activityThreshold: 10 },
    };
    await act(async () => { root.render(<Card surface="history" state={state} />); });
    expect(container.querySelector('[role="status"]')?.textContent).toContain('未触发技能复盘');
    expect(container.textContent).toContain('本轮未调用回顾模型');
    expect(container.textContent).toContain('已完成工具活动：1 / 10');
    expect(container.textContent).toContain('独立宿主诊断仍可见');
    expect(container.textContent).toContain('No reusable lesson.');
    expect(container.textContent).not.toContain('无新经验');
    expect(container.textContent).not.toContain('经验已保存');
  });
  it.each(['insufficient-evidence', 'scheduler-capacity', 'disabled-or-not-terminal'])(
    'does not claim a called model was skipped when its actual noop reason is %s', async (reason) => {
      const states: SkillReviewState[] = [];
      const complete = vi.fn(async () => ({ text: JSON.stringify({ version: 1, kind: 'noop', reason }) }));
      const noop = await runSkillReview({ origin, userText: '用户明确纠正', finalAnswer: '', loadedSkills: [],
        evidence: [{ evidenceId: 'user-correction', origin, occurredAt: 1, kind: 'correction', provenance: 'user-input', status: 'success', summary: '用户要求先验证再报告' }],
        config: { enabled: true, mode: 'approve-all', activityThreshold: 10, cooldownMs: 60000, maxRounds: 6, maxInputTokens: 48000, maxOutputTokens: 6000, timeoutMs: 600000, autoArchive: false, staleAfterDays: 30, archiveAfterDays: 90 },
      }, { host: { list: async () => ({ revision: 'empty-catalog', entries: [] }),
        view: async () => { throw new Error('No reads expected for noop'); },
        manage: async () => { throw new Error('No mutations expected for noop'); },
      }, model: { capability: 'completion-only', complete }, onState: state => { states.push(state); } });
      expect(complete).toHaveBeenCalledOnce();
      expect(noop).toMatchObject({ status: 'noop', lesson: reason, operationsApplied: 0, usage: { calls: 1 } });
      const state = states.at(-1)!;
      expect(state.result).toBe(noop);
      expect(state).not.toHaveProperty('admission');
      const original = JSON.stringify(state);
      for (const locale of ['zh-CN', 'en-US'] as const) {
        await act(async () => { root.render(<Card surface="history" locale={locale} state={state} />); });
        expect(container.querySelector('[role="status"]')?.textContent).toBe(locale === 'zh-CN' ? '无新经验' : 'No new lesson');
        expect(container.textContent).toContain(locale === 'zh-CN' ? '1 次模型调用' : '1 model calls');
        expect(container.textContent).not.toMatch(/未触发技能复盘|本轮未调用回顾模型|Skill review not started|review model was not called/);
        if (locale === 'en-US') expect(container.textContent).toContain(reason);
        expect(JSON.stringify(state)).toBe(original);
      }
    },
  );
  it.each(['insufficient-evidence', 'scheduler-capacity', 'disabled-or-not-terminal', 'unknown-host-reason'])(
    'renders resultless host nonadmission %s with structured counts and preserved diagnostics', async (reason) => {
      const state: SkillReviewState = { status: 'noop', origin, detail: 'Independent host diagnostic', error: 'Independent host warning',
        admission: { status: 'not-admitted', reason, completedActivities: 7, activityThreshold: 13 },
      };
      const original = JSON.stringify(state);
      for (const surface of ['chat', 'history'] as const) {
        for (const locale of ['zh-CN', 'en-US'] as const) {
          await act(async () => { root.render(<Card surface={surface} locale={locale} state={state} />); });
          if (surface === 'chat') {
            expect(container.childElementCount).toBe(0);
            expect(JSON.stringify(state)).toBe(original);
            continue;
          }
          expect(container.querySelector('[role="status"]')?.textContent).toBe(locale === 'zh-CN' ? '未触发技能复盘' : 'Skill review not started');
          expect(container.textContent).toContain(locale === 'zh-CN' ? '本轮未调用回顾模型' : 'The review model was not called for this turn.');
          expect(container.textContent).toContain(locale === 'zh-CN' ? '已完成工具活动：7 / 13' : 'Completed tool activities: 7 / 13');
          expect(container.textContent).toContain('Independent host diagnostic');
          expect(container.querySelector('[role="alert"]')?.textContent).toBe('Independent host warning');
          expect(container.textContent).not.toMatch(/经验已保存|无新经验|Lesson saved|No new lesson|Review usage|复盘用量/);
          expect(container.querySelector('button')).toBeNull();
          if (locale === 'en-US' || reason === 'unknown-host-reason') expect(container.textContent).toContain(reason);
          expect(JSON.stringify(state)).toBe(original);
        }
      }
    },
  );
  it('does not display a stale nonadmission explanation over a current resultless failure', async () => {
    await act(async () => { root.render(<Card state={{ status: 'failed', origin, error: 'HTTP unavailable',
      admission: { status: 'not-admitted', reason: 'scheduler-capacity', completedActivities: 7, activityThreshold: 13 },
    }} />); });
    expect(container.querySelector('[role="status"]')?.textContent).toBe('学习失败');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('HTTP unavailable');
    expect(container.textContent).not.toContain('本轮未调用回顾模型');
  });
  it('retries a resultless failure only through the original saved state and never invents success', async () => {
    const saved: SkillReviewState = { status: 'failed', origin, error: 'SKILL_REVIEW_INTERRUPTED', resume: {
      job: { origin, userText: 'real saved source', finalAnswer: 'saved answer', evidence: [], loadedSkills: [], config: { enabled: true, mode: 'approve-all', activityThreshold: 10, cooldownMs: 60000, maxRounds: 6, maxInputTokens: 48000, maxOutputTokens: 6000, timeoutMs: 600000, autoArchive: false, staleAfterDays: 30, archiveAfterDays: 90 } },
      selection: { adapter: 'codex', modelClass: 'review' },
    } };
    let finish!: () => void;
    const retry = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    await act(async () => { root.render(<Card surface="history" state={saved} onRetryState={retry} />); });
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="重新复盘"]');
    expect(button).not.toBeNull();
    await act(async () => { button!.click(); button!.click(); });
    expect(retry).toHaveBeenCalledExactlyOnceWith(saved);
    expect(button!.disabled).toBe(true);
    await act(async () => { finish(); });
    expect(container.textContent).not.toContain('经验已保存');
  });
  it('does not render exact revisions and usage as low-contrast faint text', async () => {
    const pending = { ...result(), revision: 'exact-revision', usage: { estimated: true, calls: 1 } };
    await act(async () => { root.render(<Card surface="history" state={{ status: pending.status, origin, result: pending }} />); });
    expect(container.querySelector('.text-fg-faint')).toBeNull();
  });
  it('does not invent a resumable failure action for legacy history without a trusted resume snapshot', async () => {
    await act(async () => { root.render(<Card surface="history" state={{ status: 'failed', origin, result: result('failed'), error: 'SKILL_REVIEW_INTERRUPTED' }} onRetry={vi.fn()} />); });
    expect(container.querySelector('button[aria-label="重新复盘"]')).toBeNull();
    expect(container.textContent).toContain('缺少可恢复的证据快照');
  });
  it('uses semantic colored labels but never a green success label for an unconfirmed applied count', async () => {
    for (const operationsApplied of [0, 1]) {
      await act(async () => { root.render(<Card surface="history" state={{ status: 'applied', origin, result: { ...result('applied'), operationsApplied } }} />); });
      const label = container.querySelector('[role="status"]')!;
      expect(label.className).toContain('ugs-review-label');
      expect(container.querySelector('article')?.getAttribute('data-tone')).toBe(operationsApplied ? 'success' : 'warning');
      expect(label.textContent).toContain(operationsApplied ? '经验已保存' : '未确认应用');
    }
  });
  it('shows every diagnostic phase in history without requiring changes or a host result', async () => {
    for (const status of ['queued', 'reading', 'proposing', 'applying', 'noop', 'failed', 'cancelled', 'needs_recovery'] as const) {
      await act(async () => { root.render(<Card surface="history" state={{ status, origin, error: status === 'failed' ? 'HTTP unavailable' : undefined }} />); });
      expect(container.querySelector('article'), status).not.toBeNull();
      expect(container.querySelector('[role="status"]')?.textContent, status).toBeTruthy();
      expect(container.textContent).toContain('session-a');
      if (status === 'failed') expect(container.querySelector('[role="alert"]')?.textContent).toContain('HTTP unavailable');
    }
  });
  it('keeps failed and cancelled reviews visible in chat without claiming a successful write', async () => {
    const cancelled = { ...result('cancelled'), error: 'Error: SKILL_REVIEW_BUDGET_TOKENS' };
    for (const status of ['cancelled', 'failed'] as const) {
      await act(async () => { root.render(<Card state={{ status, origin, result: { ...cancelled, status } }} onRetry={vi.fn()} />); });
      expect(container.querySelector('article')).not.toBeNull();
      expect(container.querySelector('[role="status"]')?.textContent).toBeTruthy();
      expect(container.textContent).not.toContain('经验已保存');
    }
  });
  it('hides a locally resolved retry noop without losing its history diagnostics', async () => {
    const failed = result('failed');
    const noop = { ...result('noop'), changes: [], riskReasons: [], lesson: '已有经验覆盖本次操作。' };
    const retry = vi.fn(async () => noop);
    await act(async () => { root.render(<Card state={{ status: 'failed', origin, result: failed }} onRetry={retry} />); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="重新复盘"]')!.click(); });
    expect(retry).toHaveBeenCalledExactlyOnceWith(failed.batchId);
    expect(container.childElementCount).toBe(0);
    await act(async () => { root.render(<Card surface="history" state={{ status: 'noop', origin, result: noop }} />); });
    expect(container.textContent).toContain('无新经验');
    expect(container.textContent).toContain(noop.lesson);
  });

  it('retains actual noop diagnostics in history in either language', async () => {
    for (const locale of ['zh-CN', 'en-US'] as const) {
      await act(async () => { root.render(<Card surface="history" locale={locale} state={{ status: 'noop', origin, result: result('noop') }} />); });
      expect(container.querySelector('[role="status"]')?.textContent).toContain(locale === 'zh-CN' ? '无新经验' : 'No new lesson');
      expect(container.textContent).not.toContain('经验已保存');
    }
  });

  it('localizes persisted host reasons without rewriting the proposal or diff', async () => {
    const pending = result();
    pending.riskReasons = ['description first 57 characters do not declare a clear trigger',
      'lesson has no trusted verification or explicit user correction', 'unknown-host-reason'];
    const original = JSON.stringify(pending);
    await act(async () => { root.render(<Card state={{ status: pending.status, origin, result: pending }} />); });
    expect(container.textContent).toContain('描述的前 57 个字符未明确说明触发条件');
    expect(container.textContent).toContain('该经验缺少可信验证或用户明确纠正');
    expect(container.textContent).toContain('unknown-host-reason');
    expect(container.textContent).not.toContain(pending.riskReasons[0]);
    expect(JSON.stringify(pending)).toBe(original);
    await act(async () => { root.render(<Card locale="en-US" state={{ status: pending.status, origin, result: pending }} />); });
    expect(container.textContent).toContain(pending.riskReasons[0]);
  });

  it('shows a frozen pending change without claiming saved or learned', async () => {
    const pending = result();
    await act(async () => { root.render(<Card state={{ status: pending.status, origin, result: pending }} />); });
    expect(container.textContent).toContain('待批准');
    expect(container.textContent).toContain('验证工具退出码后再报告成功');
    expect(container.textContent).toContain('ws-a');
    expect(container.textContent).toContain('导入技能尚未授权自动编辑');
    expect(container.textContent).not.toContain('经验已保存');
    expect(container.textContent).not.toContain('已保存');
  });

  it.each([
    'queued', 'reading', 'proposing', 'applying', 'failed', 'conflicted', 'needs_recovery', 'cancelled', 'rejected',
  ] as const)('shows the real %s phase without inventing mutation controls before a result exists', async (status) => {
    const state: SkillReviewState = { status, origin, error: status === 'needs_recovery' ? '恢复快照仍保留' : undefined };
    await act(async () => { root.render(<Card state={state} />); });
    expect(container.querySelector('article')).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBeTruthy();
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).not.toContain('经验已保存');
  });

  it('requires an applied host result and positive applied operations before reporting learned', async () => {
    await act(async () => { root.render(<Card state={{ status: 'applied', origin }} />); });
    expect(container.textContent).not.toContain('经验已保存');
    const applied = { ...result('applied'), operationsApplied: 1, revision: 'revision-new' };
    await act(async () => { root.render(<Card state={{ status: 'applied', origin, result: applied }} />); });
    expect(container.querySelector('[role="status"]')?.textContent).toContain('经验已保存');
    expect(container.textContent).toContain('revision-new');
    await act(async () => { root.render(<Card state={{ status: 'applied', origin, result: { ...applied, operationsApplied: 0 } }} />); });
    expect(container.textContent).not.toContain('经验已保存');
  });

  it('exposes exact before/after text and hashes in a keyboard-focusable horizontally scrolling diff', async () => {
    const longAfter = `<script>untrusted()</script>${'long-content-'.repeat(100)}`;
    const pending = result();
    pending.changes[0].after = longAfter;
    await act(async () => { root.render(<Card state={{ status: pending.status, origin, result: pending }} />); });
    const details = container.querySelector('details[data-ugs-review-diff]');
    expect(details).not.toBeNull();
    expect(details!.querySelector('summary')?.textContent).toContain('查看 diff');
    const viewport = details!.querySelector<HTMLElement>('[role="region"][aria-label="verify-tools / SKILL.md diff"]');
    expect(viewport).not.toBeNull();
    expect(viewport!.className).toContain('overflow-x-auto');
    expect(viewport!.className).toContain('min-w-0');
    expect(viewport!.tabIndex).toBe(0);
    expect(viewport!.textContent).toContain('旧规则');
    expect(viewport!.textContent).toContain(longAfter);
    expect(details!.textContent).toContain('before-hash');
    expect(details!.textContent).toContain('after-hash');
    expect(details!.querySelector('script')).toBeNull();
    expect(details!.querySelector('.ugs-review-diff-remove')?.textContent).toContain('− 旧规则');
    expect(details!.querySelector('.ugs-review-diff-add')?.textContent).toContain('+ ' + longAfter);
  });

  it('awaits approval for the original batch before updating to the host result', async () => {
    let resolve!: (value: SkillMutationResult) => void;
    const onApprove = vi.fn(() => new Promise<SkillMutationResult>((done) => { resolve = done; }));
    const pending = result();
    await act(async () => { root.render(<Card state={{ status: pending.status, origin, result: pending }} onApprove={onApprove} />); });
    const approve = container.querySelector<HTMLButtonElement>('button[aria-label="批准修改"]');
    expect(approve).not.toBeNull();
    approve!.focus();
    expect(document.activeElement).toBe(approve);
    await act(async () => { approve!.click(); approve!.click(); });
    expect(onApprove).toHaveBeenCalledExactlyOnceWith('batch-a');
    expect(approve!.disabled).toBe(true);
    expect(container.textContent).toContain('正在应用修改');
    expect(container.textContent).not.toContain('经验已保存');
    await act(async () => { resolve({ ...pending, status: 'applied', operationsApplied: 1, revision: 'v2', rollbackId: 'rollback-a' }); });
    expect(container.textContent).toContain('经验已保存');
    expect(container.textContent).toContain('v2');
  });

  it('returns rejected approval promises to the same pending card with a usable retry', async () => {
    const onApprove = vi.fn()
      .mockRejectedValueOnce(new Error('原项目已卸载'))
      .mockResolvedValueOnce({ ...result('applied'), operationsApplied: 1 });
    const pending = result();
    await act(async () => { root.render(<Card state={{ status: pending.status, origin, result: pending }} onApprove={onApprove} />); });
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="批准修改"]')!.click(); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('原项目已卸载');
    expect(container.textContent).toContain('待批准');
    expect(container.textContent).not.toContain('经验已保存');
    expect(container.textContent).toContain('旧规则');
    const retry = container.querySelector<HTMLButtonElement>('button[aria-label="批准修改"]');
    expect(retry?.disabled).toBe(false);
    await act(async () => { retry!.click(); });
    expect(onApprove).toHaveBeenNthCalledWith(2, 'batch-a');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain('经验已保存');
  });

  it('rejects the frozen batch only after the rejection result resolves', async () => {
    const pending = result();
    const onReject = vi.fn(async () => ({ ...pending, status: 'rejected' as const, operationsApplied: 0 }));
    await act(async () => { root.render(<Card state={{ status: pending.status, origin, result: pending }} onReject={onReject} />); });
    const reject = container.querySelector<HTMLButtonElement>('button[aria-label="拒绝修改"]');
    expect(reject).not.toBeNull();
    await act(async () => { reject!.click(); });
    expect(onReject).toHaveBeenCalledExactlyOnceWith('batch-a');
    expect(container.textContent).toContain('已拒绝');
    expect(container.textContent).not.toContain('经验已保存');
    expect(container.querySelector('button[aria-label="拒绝修改"]')).toBeNull();
  });

  it('waits for the rollback transaction before reporting reverted, not learned', async () => {
    let complete!: (value: SkillMutationResult) => void;
    const applied = { ...result('applied'), operationsApplied: 1, rollbackId: 'rollback-origin' };
    const onRollback = vi.fn(() => new Promise<SkillMutationResult>((resolve) => { complete = resolve; }));
    await act(async () => { root.render(<Card state={{ status: 'applied', origin, result: applied }} onRollback={onRollback} />); });
    const rollback = container.querySelector<HTMLButtonElement>('button[aria-label="撤销修改"]');
    expect(rollback).not.toBeNull();
    await act(async () => { rollback!.click(); });
    expect(onRollback).toHaveBeenCalledExactlyOnceWith('rollback-origin');
    expect(container.textContent).toContain('正在撤销修改');
    expect(container.textContent).not.toContain('已撤销');
    await act(async () => { complete({ ...applied, batchId: 'rollback-batch', rollbackId: undefined, revision: 'restored-v1' }); });
    expect(container.querySelector('[role="status"]')?.textContent).toContain('已撤销');
    expect(container.textContent).not.toContain('经验已保存');
    expect(container.textContent).toContain('restored-v1');
    expect(container.querySelector('button[aria-label="撤销修改"]')).toBeNull();
  });

  it('preserves an explicit rollback action after the state is rehydrated', async () => {
    const reverted = { ...result('applied'), operationsApplied: 1, rollbackId: undefined };
    const rehydrated = JSON.parse(JSON.stringify({ status: 'applied', origin, result: reverted, action: 'rollback' })) as SkillReviewState;
    await act(async () => { root.render(<Card state={rehydrated} />); });
    expect(container.querySelector('[role="status"]')?.textContent).toContain('已撤销');
    expect(container.textContent).not.toContain('经验已保存');
  });

  it('reconciles newer host state rather than keeping a stale locally resolved success', async () => {
    const pending = result();
    const onApprove = vi.fn(async () => ({ ...pending, status: 'applied' as const, operationsApplied: 1 }));
    await act(async () => { root.render(<Card state={{ status: pending.status, origin, result: pending }} onApprove={onApprove} />); });
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="批准修改"]')!.click(); });
    expect(container.textContent).toContain('经验已保存');
    const authoritative = { ...pending, status: 'needs_recovery' as const, error: '宿主读回校验失败' };
    await act(async () => { root.render(<Card state={{ status: authoritative.status, origin, result: authoritative }} onApprove={onApprove} />); });
    expect(container.textContent).toContain('需要恢复');
    expect(container.textContent).not.toContain('经验已保存');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('宿主读回校验失败');
  });

  it('shows an authoritative host recovery state while an older approval promise is still pending', async () => {
    const pending = result();
    let complete!: (value: SkillMutationResult) => void;
    const onApprove = vi.fn(() => new Promise<SkillMutationResult>((resolve) => { complete = resolve; }));
    await act(async () => { root.render(<Card state={{ status: pending.status, origin, result: pending }} onApprove={onApprove} />); });
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="批准修改"]')!.click(); });
    const recovery = { ...pending, status: 'needs_recovery' as const, error: '宿主已进入恢复', rollbackId: 'recover-new' };
    await act(async () => { root.render(<Card state={{ status: recovery.status, origin, result: recovery }} onApprove={onApprove} />); });
    expect(container.querySelector('[role="status"]')?.textContent).toContain('需要恢复');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('宿主已进入恢复');
    await act(async () => { complete({ ...pending, status: 'applied', operationsApplied: 1 }); });
    expect(container.querySelector('[role="status"]')?.textContent).toContain('需要恢复');
    expect(container.textContent).not.toContain('经验已保存');
  });

  it('ignores a late action completion after the component moves to another origin', async () => {
    let complete!: (value: SkillMutationResult) => void;
    const pending = result();
    const onApprove = vi.fn(() => new Promise<SkillMutationResult>((resolve) => { complete = resolve; }));
    await act(async () => { root.render(<Card state={{ status: pending.status, origin, result: pending }} onApprove={onApprove} />); });
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="批准修改"]')!.click(); });
    const next = { ...pending, batchId: 'batch-b', origin: { ...origin, workspaceId: 'ws-b', runId: 'run-b' }, lesson: '其他项目经验' };
    await act(async () => { root.render(<Card state={{ status: next.status, origin: next.origin, result: next }} onApprove={onApprove} />); });
    await act(async () => { complete({ ...pending, status: 'applied', operationsApplied: 1 }); });
    expect(container.textContent).toContain('其他项目经验');
    expect(container.textContent).toContain('ws-b');
    expect(container.textContent).not.toContain('经验已保存');
    expect(container.textContent).not.toContain('验证工具退出码后再报告成功');
  });

  it('offers recovery without claiming learning while the host is recovering', async () => {
    const recovery = { ...result('needs_recovery'), error: '恢复失败：保留原始快照', rollbackId: 'recovery-a' };
    const onRollback = vi.fn(async () => ({ ...recovery, status: 'failed' as const, error: '文件仍被占用' }));
    await act(async () => { root.render(<Card state={{ status: recovery.status, origin, result: recovery }} onRollback={onRollback} />); });
    const recover = container.querySelector<HTMLButtonElement>('button[aria-label="恢复原版本"]');
    expect(recover).not.toBeNull();
    await act(async () => { recover!.click(); });
    expect(onRollback).toHaveBeenCalledExactlyOnceWith('recovery-a');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('文件仍被占用');
    expect(container.textContent).not.toContain('经验已保存');
    expect(container.textContent).not.toContain('已撤销');
  });

  it('keeps recovery available after a hydrated rollback enters needs_recovery', async () => {
    const recovery = { ...result('needs_recovery'), error: '撤销未能恢复全部文件', rollbackId: 'recover-rollback' };
    const onRollback = vi.fn(async () => ({ ...recovery, status: 'applied' as const, operationsApplied: 1, revision: 'restored', rollbackId: undefined }));
    await act(async () => { root.render(<Card state={{ status: 'needs_recovery', origin, action: 'rollback', result: recovery }} onRollback={onRollback} />); });
    const recover = container.querySelector<HTMLButtonElement>('button[aria-label="恢复原版本"]');
    expect(recover).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain('需要恢复');
    await act(async () => { recover!.click(); });
    expect(onRollback).toHaveBeenCalledExactlyOnceWith('recover-rollback');
    expect(container.querySelector('[role="status"]')?.textContent).toContain('已撤销');
    expect(container.textContent).not.toContain('经验已保存');
  });

  it('keeps unknown review usage distinct from estimated measured values', async () => {
    const pending = { ...result(), usage: { inputTokens: 100, estimated: true, calls: 2 } };
    await act(async () => { root.render(<Card state={{ status: pending.status, origin, result: pending }} />); });
    expect(container.textContent).toContain('估算');
    expect(container.textContent).toContain('输入 100');
    expect(container.textContent).toContain('输出未知');
    expect(container.textContent).toContain('2 次模型调用');
    expect(container.textContent).not.toContain('输出 0');
  });

  it('supports approval under React StrictMode effect replay', async () => {
    const pending = result();
    const onApprove = vi.fn(async () => ({ ...pending, status: 'applied' as const, operationsApplied: 1 }));
    await act(async () => { root.render(<StrictMode><Card state={{ status: pending.status, origin, result: pending }} onApprove={onApprove} /></StrictMode>); });
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="批准修改"]')!.click(); });
    expect(container.textContent).toContain('经验已保存');
  });

  it('rejects an action result belonging to a different frozen origin', async () => {
    const pending = result();
    const onApprove = vi.fn(async () => ({ ...pending, status: 'applied' as const, operationsApplied: 1, origin: { ...origin, workspaceId: 'wrong-project' } }));
    await act(async () => { root.render(<Card state={{ status: pending.status, origin, result: pending }} onApprove={onApprove} />); });
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="批准修改"]')!.click(); });
    expect(container.textContent).not.toContain('经验已保存');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('结果来源不匹配');
    expect(container.textContent).not.toContain('wrong-project');
  });

  it('refuses to claim persistence or offer actions for an initial result from another origin', async () => {
    const foreign = { ...result('applied'), operationsApplied: 1, origin: { ...origin, workspaceId: 'foreign-project' }, rollbackId: 'foreign-rollback' };
    await act(async () => { root.render(<Card state={{ status: 'applied', origin, result: foreign }} onRollback={vi.fn()} />); });
    expect(container.textContent).not.toContain('经验已保存');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('结果来源不匹配');
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).not.toContain('验证工具退出码后再报告成功');
  });

  it('refuses an initial result with a different frozen cwd even when every execution id matches', async () => {
    const source = { ...origin, cwd: 'E:/Source' };
    const foreign = { ...result('applied'), operationsApplied: 1, origin: { ...source, cwd: 'E:/Another' }, rollbackId: 'foreign-cwd-rollback' };
    await act(async () => { root.render(<Card state={{ status: 'applied', origin: source, result: foreign }} onRollback={vi.fn()} />); });
    expect(container.textContent).not.toContain('经验已保存');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('结果来源不匹配');
    expect(container.querySelector('button')).toBeNull();
  });

  it('shows the applying phase even when the previous pending diff is retained', async () => {
    const pending = result();
    await act(async () => { root.render(<Card state={{ status: 'applying', origin, result: pending }} onApprove={vi.fn()} />); });
    expect(container.querySelector('[role="status"]')?.textContent).toContain('正在应用修改');
    expect(container.querySelector('button[aria-label="批准修改"]')?.hasAttribute('disabled')).toBe(true);
    expect(container.textContent).not.toContain('经验已保存');
  });

  it('does not report a hydrated rollback action complete while its host phase is still applying', async () => {
    const applied = { ...result('applied'), operationsApplied: 1, rollbackId: 'rollback-a' };
    await act(async () => { root.render(<Card state={{ status: 'applying', origin, result: applied, action: 'rollback' }} onRollback={vi.fn()} />); });
    expect(container.querySelector('[role="status"]')?.textContent).toContain('正在应用修改');
    expect(container.textContent).not.toContain('已撤销');
  });

  it('honors a terminal host failure even when the frozen diff retains an earlier applied result', async () => {
    const applied = { ...result('applied'), operationsApplied: 1, rollbackId: 'rollback-a' };
    await act(async () => { root.render(<Card state={{ status: 'needs_recovery', origin, result: applied, error: '最新恢复错误' }} />); });
    expect(container.querySelector('[role="status"]')?.textContent).toContain('需要恢复');
    expect(container.textContent).not.toContain('经验已保存');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('最新恢复错误');
  });

  it('never offers approval of a retained pending batch after the host reports a conflict', async () => {
    const pending = result();
    await act(async () => { root.render(<Card state={{ status: 'conflicted', origin, result: pending, error: '内容已变化' }} onApprove={vi.fn()} onReject={vi.fn()} onRetry={vi.fn()} />); });
    expect(container.querySelector('[role="status"]')?.textContent).toContain('版本冲突');
    expect(container.querySelector('button[aria-label="批准修改"]')).toBeNull();
    expect(container.querySelector('button[aria-label="拒绝修改"]')).toBeNull();
    expect(container.querySelector('button[aria-label="重新复盘"]')).not.toBeNull();
    expect(container.textContent).toContain('旧规则');
  });

  it('offers a fresh review retry for conflicts rather than re-approving stale content', async () => {
    const conflict = { ...result('conflicted'), error: '内容已被用户修改' };
    const onRetry = vi.fn(async () => ({ ...conflict, status: 'awaiting_approval' as const, error: undefined }));
    await act(async () => { root.render(<Card state={{ status: conflict.status, origin, result: conflict }} onRetry={onRetry} onApprove={vi.fn()} />); });
    expect(container.querySelector('button[aria-label="批准修改"]')).toBeNull();
    const retry = container.querySelector<HTMLButtonElement>('button[aria-label="重新复盘"]');
    expect(retry).not.toBeNull();
    await act(async () => { retry!.click(); });
    expect(onRetry).toHaveBeenCalledExactlyOnceWith('batch-a');
    expect(container.textContent).toContain('待批准');
    expect(container.textContent).not.toContain('经验已保存');
  });
});
