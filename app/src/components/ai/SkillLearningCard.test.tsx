import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillMutationResult, SkillReviewState } from '@/runtime/skills/types';
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
  it('keeps failed and cancelled reviews out of the chat even with retained diagnostics', async () => {
    const cancelled = { ...result('cancelled'), error: 'Error: SKILL_REVIEW_BUDGET_TOKENS' };
    for (const status of ['cancelled', 'failed'] as const) {
      await act(async () => { root.render(<Card state={{ status, origin, result: { ...cancelled, status } }} onRetry={vi.fn()} />); });
      expect(container.innerHTML).toBe('');
    }
  });
  it('renders nothing for a noop result in either language', async () => {
    for (const locale of ['zh-CN', 'en-US'] as const) {
      await act(async () => { root.render(<Card locale={locale} state={{ status: 'noop', origin, result: result('noop') }} />); });
      expect(container.innerHTML).toBe('');
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
    expect(container.textContent).not.toContain('已学会');
    expect(container.textContent).not.toContain('已保存');
  });

  it.each([
    'queued', 'reading', 'proposing', 'applying', 'failed', 'conflicted', 'needs_recovery', 'cancelled', 'rejected',
  ] as const)('hides %s when no generated result exists', async (status) => {
    const state: SkillReviewState = { status, origin, error: status === 'needs_recovery' ? '恢复快照仍保留' : undefined };
    await act(async () => { root.render(<Card state={state} />); });
    expect(container.innerHTML).toBe('');
  });

  it('requires an applied host result and positive applied operations before reporting learned', async () => {
    await act(async () => { root.render(<Card state={{ status: 'applied', origin }} />); });
    expect(container.textContent).not.toContain('已学会');
    const applied = { ...result('applied'), operationsApplied: 1, revision: 'revision-new' };
    await act(async () => { root.render(<Card state={{ status: 'applied', origin, result: applied }} />); });
    expect(container.querySelector('[role="status"]')?.textContent).toContain('已学会');
    expect(container.textContent).toContain('revision-new');
    await act(async () => { root.render(<Card state={{ status: 'applied', origin, result: { ...applied, operationsApplied: 0 } }} />); });
    expect(container.textContent).not.toContain('已学会');
  });

  it('exposes exact before/after text and hashes in a keyboard-focusable horizontally scrolling diff', async () => {
    const longAfter = `<script>untrusted()</script>${'long-content-'.repeat(100)}`;
    const pending = result();
    pending.changes[0].after = longAfter;
    await act(async () => { root.render(<Card state={{ status: pending.status, origin, result: pending }} />); });
    const details = container.querySelector('details');
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
    expect(container.textContent).not.toContain('已学会');
    await act(async () => { resolve({ ...pending, status: 'applied', operationsApplied: 1, revision: 'v2', rollbackId: 'rollback-a' }); });
    expect(container.textContent).toContain('已学会');
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
    expect(container.textContent).not.toContain('已学会');
    expect(container.textContent).toContain('旧规则');
    const retry = container.querySelector<HTMLButtonElement>('button[aria-label="批准修改"]');
    expect(retry?.disabled).toBe(false);
    await act(async () => { retry!.click(); });
    expect(onApprove).toHaveBeenNthCalledWith(2, 'batch-a');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain('已学会');
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
    expect(container.textContent).not.toContain('已学会');
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
    expect(container.textContent).not.toContain('已学会');
    expect(container.textContent).toContain('restored-v1');
    expect(container.querySelector('button[aria-label="撤销修改"]')).toBeNull();
  });

  it('preserves an explicit rollback action after the state is rehydrated', async () => {
    const reverted = { ...result('applied'), operationsApplied: 1, rollbackId: undefined };
    const rehydrated = JSON.parse(JSON.stringify({ status: 'applied', origin, result: reverted, action: 'rollback' })) as SkillReviewState;
    await act(async () => { root.render(<Card state={rehydrated} />); });
    expect(container.querySelector('[role="status"]')?.textContent).toContain('已撤销');
    expect(container.textContent).not.toContain('已学会');
  });

  it('reconciles newer host state rather than keeping a stale locally resolved success', async () => {
    const pending = result();
    const onApprove = vi.fn(async () => ({ ...pending, status: 'applied' as const, operationsApplied: 1 }));
    await act(async () => { root.render(<Card state={{ status: pending.status, origin, result: pending }} onApprove={onApprove} />); });
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="批准修改"]')!.click(); });
    expect(container.textContent).toContain('已学会');
    const authoritative = { ...pending, status: 'needs_recovery' as const, error: '宿主读回校验失败' };
    await act(async () => { root.render(<Card state={{ status: authoritative.status, origin, result: authoritative }} onApprove={onApprove} />); });
    expect(container.textContent).toContain('需要恢复');
    expect(container.textContent).not.toContain('已学会');
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
    expect(container.textContent).not.toContain('已学会');
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
    expect(container.textContent).not.toContain('已学会');
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
    expect(container.textContent).not.toContain('已学会');
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
    expect(container.textContent).not.toContain('已学会');
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
    expect(container.textContent).toContain('已学会');
  });

  it('rejects an action result belonging to a different frozen origin', async () => {
    const pending = result();
    const onApprove = vi.fn(async () => ({ ...pending, status: 'applied' as const, operationsApplied: 1, origin: { ...origin, workspaceId: 'wrong-project' } }));
    await act(async () => { root.render(<Card state={{ status: pending.status, origin, result: pending }} onApprove={onApprove} />); });
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="批准修改"]')!.click(); });
    expect(container.textContent).not.toContain('已学会');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('结果来源不匹配');
    expect(container.textContent).not.toContain('wrong-project');
  });

  it('refuses to claim persistence or offer actions for an initial result from another origin', async () => {
    const foreign = { ...result('applied'), operationsApplied: 1, origin: { ...origin, workspaceId: 'foreign-project' }, rollbackId: 'foreign-rollback' };
    await act(async () => { root.render(<Card state={{ status: 'applied', origin, result: foreign }} onRollback={vi.fn()} />); });
    expect(container.textContent).not.toContain('已学会');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('结果来源不匹配');
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).not.toContain('验证工具退出码后再报告成功');
  });

  it('refuses an initial result with a different frozen cwd even when every execution id matches', async () => {
    const source = { ...origin, cwd: 'E:/Source' };
    const foreign = { ...result('applied'), operationsApplied: 1, origin: { ...source, cwd: 'E:/Another' }, rollbackId: 'foreign-cwd-rollback' };
    await act(async () => { root.render(<Card state={{ status: 'applied', origin: source, result: foreign }} onRollback={vi.fn()} />); });
    expect(container.textContent).not.toContain('已学会');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('结果来源不匹配');
    expect(container.querySelector('button')).toBeNull();
  });

  it('hides an applying phase even when the previous pending diff is retained', async () => {
    const pending = result();
    await act(async () => { root.render(<Card state={{ status: 'applying', origin, result: pending }} onApprove={vi.fn()} />); });
    expect(container.innerHTML).toBe('');
  });

  it('does not report a hydrated rollback action complete while its host phase is still applying', async () => {
    const applied = { ...result('applied'), operationsApplied: 1, rollbackId: 'rollback-a' };
    await act(async () => { root.render(<Card state={{ status: 'applying', origin, result: applied, action: 'rollback' }} onRollback={vi.fn()} />); });
    expect(container.innerHTML).toBe('');
  });

  it('honors a terminal host failure even when the frozen diff retains an earlier applied result', async () => {
    const applied = { ...result('applied'), operationsApplied: 1, rollbackId: 'rollback-a' };
    await act(async () => { root.render(<Card state={{ status: 'needs_recovery', origin, result: applied, error: '最新恢复错误' }} />); });
    expect(container.querySelector('[role="status"]')?.textContent).toContain('需要恢复');
    expect(container.textContent).not.toContain('已学会');
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
    expect(container.textContent).not.toContain('已学会');
  });
});
