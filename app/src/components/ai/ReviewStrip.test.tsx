import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import MemoryReviewCard from './MemoryReviewCard';
import SkillLearningCard from './SkillLearningCard';
import type { MemoryReviewChatState } from '@/lib/memoryReviewEvents';
import type { SkillReviewState } from '@/runtime/skills/types';

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
});
const origin = { hostId: 'local', workspaceId: 'workspace', sessionId: 'session', turnId: 'turn', runId: 'run' };
const memory: MemoryReviewChatState = { id: 'job', phase: 'reading', source: { ...origin, namespaceId: 'local', sourceMessageId: 'turn' }, appliedOps: 0, queuedOps: 0, updatedAt: 1, detail: 'Exact host diagnostic' };
const skill: SkillReviewState = { status: 'noop', origin, detail: 'Exact host diagnostic',
  admission: { status: 'not-admitted', reason: 'insufficient-evidence', completedActivities: 1, activityThreshold: 10 },
};

it('renders memory as a single disclosure strip rather than a diagnostic card', async () => {
  const failed: MemoryReviewChatState = { ...memory, phase: 'failed', appliedOps: 1 };
  await act(async () => { root.render(<MemoryReviewCard state={failed} />); });
  const article = container.querySelector('article')!;
  expect(article.classList.contains('ugs-review-strip')).toBe(true);
  expect(article.className).not.toMatch(/\bbg-panel\b|\bborder\b|\bp-3\b|\bpx-3\b/);
  const disclosure = article.querySelector<HTMLDetailsElement>('details[data-ugs-review-diagnostics]')!;
  expect(disclosure.open).toBe(false);
  expect(disclosure.querySelector('summary [role="status"]')?.textContent).toBe('记忆复盘失败');
  expect(disclosure.querySelector('summary [data-ugs-review-glyph]')).not.toBeNull();
  expect(disclosure.querySelector('summary')?.textContent).not.toContain('复盘诊断');
  expect(disclosure.querySelector('[data-ugs-review-body]')?.textContent).toContain(memory.detail);
});

it('keeps a real saved lesson concise in the strip and its full evidence collapsed', async () => {
  const saved: SkillReviewState = { status: 'applied', origin, detail: skill.detail,
    result: { status: 'applied', origin, batchId: 'saved-batch', operationsApplied: 1, changes: [], riskReasons: [], lesson: '验证后再报告成功' } };
  await act(async () => { root.render(<SkillLearningCard state={saved} />); });
  const article = container.querySelector('article')!;
  expect(article.classList.contains('ugs-review-strip')).toBe(true);
  expect(article.className).not.toMatch(/\bbg-panel\b|\bborder\b|\bp-3\b/);
  const disclosure = article.querySelector<HTMLDetailsElement>('details[data-ugs-review-diagnostics]')!;
  expect(disclosure.open).toBe(false);
  const summary = disclosure.querySelector('summary')!;
  expect(summary.querySelector('[role="status"]')?.textContent).toBe('经验已保存');
  expect(summary.querySelector('[data-ugs-review-glyph]')).not.toBeNull();
  expect(summary.textContent).toContain(saved.result!.lesson);
  expect(summary.textContent).not.toContain(skill.detail);
  expect(disclosure.querySelector('[data-ugs-review-body]')?.textContent).toContain(skill.detail);
});

it('retains expanded history without styling it as a chat strip', async () => {
  await act(async () => { root.render(<SkillLearningCard surface="history" state={skill} />); });
  const article = container.querySelector('article')!;
  expect(article.classList.contains('ugs-review-strip')).toBe(false);
  expect(article.querySelector('details[data-ugs-review-diagnostics]')).toBeNull();
  expect(article.textContent).toContain('Exact host diagnostic');
});

it('keeps pending memory settings reachable without expanding diagnostics', async () => {
  const openSettings = vi.fn();
  await act(async () => { root.render(<MemoryReviewCard state={{ ...memory, phase: 'awaiting_approval', queuedOps: 2 }} onOpenSettings={openSettings} />); });
  const button = container.querySelector<HTMLButtonElement>('button')!;
  expect(button.closest('details')).toBeNull();
  await act(async () => { button.click(); });
  expect(openSettings).toHaveBeenCalledOnce();
  expect(container.querySelector('summary [role="status"]')?.textContent).toBe('记忆提案待审批');
  expect(container.querySelector('summary .ugs-review-meta')?.textContent).toBe('2 项');
  expect(container.querySelector('[role="status"]')?.textContent).not.toContain('已保存');
});

it('shows the saved count once in the concise summary while keeping exact counts in diagnostics', async () => {
  await act(async () => { root.render(<MemoryReviewCard state={{ ...memory, phase: 'applied', appliedOps: 1, detail: undefined }} />); });
  const summary = container.querySelector('summary')!;
  expect(summary.querySelector('[role="status"]')?.textContent).toBe('记忆已保存');
  expect(summary.querySelector('.ugs-review-meta')?.textContent).toBe('1 项');
  expect(container.querySelector('[data-ugs-review-body]')?.textContent).toContain('已保存 1 项');
});
