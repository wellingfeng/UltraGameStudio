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
it.each(['queued', 'admitting', 'reading', 'unconfirmed', 'disabled', 'skipped', 'failed', 'cancelled', 'noop', 'awaiting_approval', 'applied'] as const)(
  'hides %s when it has no review information', async phase => {
    const v = await view({ phase, appliedOps: 0, queuedOps: 0 });
    try { expect(v.container.querySelector('article')).toBeNull(); }
    finally { await v.cleanup(); }
  });
it.each(['queued', 'admitting', 'reading', 'unconfirmed', 'disabled', 'skipped', 'failed', 'cancelled', 'noop', 'awaiting_approval'] as const)(
  'keeps %s in the background even if it carries counts', async phase => {
    const v = await view({ phase, appliedOps: 1 });
    try { expect(v.container.querySelector('article')).toBeNull(); }
    finally { await v.cleanup(); }
  });
it('hides pending approval without invoking settings or claiming it was saved', async () => {
  const open = vi.fn();
  const v = await view({ phase: 'awaiting_approval', queuedOps: 2 }, open);
  try {
    expect(v.container.childElementCount).toBe(0);
    expect(open).not.toHaveBeenCalled();
  } finally { await v.cleanup(); }
});
it('does not display partial or unconfirmed commits as successful reviews', async () => {
  const v = await view({ phase: 'applied', appliedOps: 1, queuedOps: 2, error: 'Other library CAS conflict',
    recordingError: 'Terminal journal readback mismatch', usage: { calls: 1, inputTokens: 19, estimated: true } });
  try {
    expect(v.container.childElementCount).toBe(0);
  } finally { await v.cleanup(); }
});
