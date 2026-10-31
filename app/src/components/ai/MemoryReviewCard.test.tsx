import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import MemoryReviewCard from './MemoryReviewCard';
import type { MemoryReviewChatState } from '@/lib/memoryReviewEvents';
const source = { hostId: 'local', namespaceId: 'local', workspaceId: 'workspace', sessionId: 'session', turnId: 'user', sourceMessageId: 'user', runId: 'run' };
async function view(state: Partial<MemoryReviewChatState>, onOpenSettings = vi.fn()) {
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<MemoryReviewCard state={{ id: 'job', source, phase: 'noop', appliedOps: 0, queuedOps: 0, updatedAt: 1, ...state }} onOpenSettings={onOpenSettings} />));
  return { container, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}
it.each([
  ['queued', '记忆复盘排队中', 'info', false, 0, 0],
  ['admitting', '记忆复盘准入中', 'info', false, 0, 0],
  ['reading', '正在复盘记忆', 'running', true, 0, 0],
  ['disabled', '记忆复盘已关闭', 'neutral', false, 0, 0],
  ['skipped', '本轮未复盘记忆', 'neutral', false, 0, 0],
  ['failed', '记忆复盘失败', 'error', false, 0, 0],
  ['cancelled', '记忆复盘已取消', 'interrupted', false, 0, 0],
  ['noop', '无需更新记忆', 'neutral', false, 0, 0],
  ['awaiting_approval', '记忆提案待审批', 'warning', false, 0, 2],
  ['applied', '记忆已保存', 'success', false, 1, 0],
] as const)('presents real %s state with text and semantic activity', async (phase, label, tone, active, appliedOps, queuedOps) => {
  const v = await view({ phase, appliedOps, queuedOps });
  try {
    const article = v.container.querySelector('article')!;
    expect(v.container.querySelector('[role="status"]')?.textContent).toBe(label);
    expect(article.dataset.tone).toBe(tone);
    expect(article.dataset.active).toBe(String(active));
    expect(v.container.textContent).not.toMatch(/已学会|已经采用|能力提升/);
  } finally { await v.cleanup(); }
});
it('does not turn an applied phase without applied operations into saved memory', async () => {
  const v = await view({ phase: 'applied', appliedOps: 0 });
  try {
    expect(v.container.querySelector('[role="status"]')?.textContent).toBe('记忆保存未确认');
    expect(v.container.querySelector('article')?.dataset.tone).toBe('warning');
  } finally { await v.cleanup(); }
});
it('guides pending approval to settings without approving or claiming it was saved', async () => {
  const open = vi.fn();
  const v = await view({ phase: 'awaiting_approval', queuedOps: 2 }, open);
  try {
    expect(v.container.textContent).toContain('待审批 2 项');
    expect(v.container.textContent).toContain('设置 → 记忆 → 待审批');
    const button = v.container.querySelector<HTMLButtonElement>('button');
    expect(button?.textContent).toContain('打开设置');
    await act(async () => button!.click());
    expect(open).toHaveBeenCalledTimes(1);
    expect(v.container.textContent).not.toContain('记忆已保存');
  } finally { await v.cleanup(); }
});
it('keeps partial commits and unknown usage truthful in collapsed diagnostics', async () => {
  const v = await view({ phase: 'applied', appliedOps: 1, queuedOps: 2, error: 'Other library CAS conflict',
    recordingError: 'Terminal journal readback mismatch', usage: { calls: 1, inputTokens: 19, estimated: true } });
  try {
    expect(v.container.textContent).toContain('已保存 1 项');
    expect(v.container.textContent).toContain('待审批 2 项');
    expect(v.container.textContent).toContain('结果记录未确认');
    expect(v.container.querySelector('details')?.open).toBe(false);
    expect(v.container.querySelector('details')?.textContent).toContain('Other library CAS conflict');
    expect(v.container.querySelector('details')?.textContent).toContain('输出未知');
    expect(v.container.querySelector('details')?.textContent).toContain('估算');
  } finally { await v.cleanup(); }
});
