import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SkillReviewState } from '@/runtime/skills/types';
import SkillLearningCard from './SkillLearningCard';
import MemoryReviewCard from './MemoryReviewCard';
import type { MemoryReviewChatState } from '@/lib/memoryReviewEvents';
import { isSkillReviewVisible } from './lib/skillReviewVisibility';

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
const origin = { hostId: 'local', workspaceId: 'workspace', sessionId: 'session', turnId: 'turn', runId: 'run', cwd: 'E:/Source' };
const saved: SkillReviewState = {
  status: 'applied', origin,
  result: { status: 'applied', origin, batchId: 'saved', operationsApplied: 1, changes: [], riskReasons: [], lesson: '先验证实际结果，再报告成功。' },
};

it.each(['zh-CN', 'en-US'] as const)('keeps every unfinished or unsuccessful skill review out of chat (%s)', async locale => {
  for (const status of ['queued', 'reading', 'proposing', 'applying', 'awaiting_approval', 'noop', 'conflicted', 'failed', 'needs_recovery', 'cancelled', 'rejected'] as const) {
    // Even a retained successful result cannot override the current host phase.
    const state: SkillReviewState = { ...saved, status, queuedAt: Date.now() - 339000 };
    const original = JSON.stringify(state);
    expect(isSkillReviewVisible(state), status).toBe(false);
    await act(async () => root.render(<SkillLearningCard state={state} locale={locale} />));
    expect(container.childElementCount, status).toBe(0);
    await act(async () => root.render(<SkillLearningCard state={state} surface="history" locale={locale} />));
    expect(container.querySelector('article'), status).not.toBeNull();
    expect(JSON.stringify(state)).toBe(original);
  }
});

it.each(['missing result', 'zero writes', 'result still pending', 'foreign origin', 'foreign cwd', 'rollback', 'host error', 'result error'])(
  'hides unconfirmed skill success: %s', async kind => {
    const state = structuredClone(saved);
    if (kind === 'missing result') delete state.result;
    if (kind === 'zero writes') state.result!.operationsApplied = 0;
    if (kind === 'result still pending') state.result!.status = 'awaiting_approval';
    if (kind === 'foreign origin') state.result = { ...state.result!, origin: { ...origin, runId: 'other-run' } };
    if (kind === 'foreign cwd') state.result = { ...state.result!, origin: { ...origin, cwd: 'E:/Other' } };
    if (kind === 'rollback') state.action = 'rollback';
    if (kind === 'host error') state.error = 'Host readback failed';
    if (kind === 'result error') state.result!.error = 'Mutation failed';
    expect(isSkillReviewVisible(state)).toBe(false);
    await act(async () => root.render(<SkillLearningCard state={state} />));
    expect(container.childElementCount).toBe(0);
    expect(isSkillReviewVisible(state, 'history')).toBe(true);
  },
);

it('shows skill review only after confirmed saving and removes it on a newer failure', async () => {
  await act(async () => root.render(<SkillLearningCard state={{ ...saved, status: 'queued' }} />));
  expect(container.childElementCount).toBe(0);
  await act(async () => root.render(<SkillLearningCard state={saved} />));
  expect(container.querySelector('summary [role="status"]')?.textContent).toBe('经验已保存');
  expect(container.querySelector('summary')?.textContent).toContain(saved.result!.lesson);
  await act(async () => root.render(<SkillLearningCard state={{ ...saved, status: 'failed', error: 'Latest failure' }} />));
  expect(container.childElementCount).toBe(0);
  expect(isSkillReviewVisible(undefined)).toBe(false);
});

it('hides a completed local rollback rather than treating it as successful learning', async () => {
  const state = { ...saved, result: { ...saved.result!, rollbackId: 'rollback' } };
  const rollback = vi.fn(async () => ({ ...state.result, batchId: 'rollback-batch', rollbackId: undefined }));
  await act(async () => root.render(<SkillLearningCard state={state} onRollback={rollback} />));
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="撤销修改"]')!.click());
  expect(rollback).toHaveBeenCalledExactlyOnceWith('rollback');
  expect(container.childElementCount).toBe(0);
});

it.each(['zh-CN', 'en-US'] as const)('shows only confirmed successful memory reviews (%s)', async locale => {
  const state: MemoryReviewChatState = { id: 'memory-job', source: { ...origin, namespaceId: 'local', sourceMessageId: 'turn' },
    phase: 'applied', appliedOps: 1, queuedOps: 0, updatedAt: 1 };
  for (const phase of ['queued', 'admitting', 'reading', 'unconfirmed', 'disabled', 'skipped', 'failed', 'cancelled', 'noop', 'awaiting_approval'] as const) {
    const current = { ...state, phase, queuedOps: 2 };
    const original = JSON.stringify(current);
    await act(async () => root.render(<MemoryReviewCard state={current} locale={locale} />));
    expect(container.childElementCount, phase).toBe(0);
    expect(JSON.stringify(current)).toBe(original);
  }
  for (const current of [{ ...state, appliedOps: 0 }, { ...state, error: 'Partial mutation failed' }, { ...state, recordingError: 'Result recording unconfirmed' }]) {
    await act(async () => root.render(<MemoryReviewCard state={current} locale={locale} />));
    expect(container.childElementCount).toBe(0);
  }
  await act(async () => root.render(<MemoryReviewCard state={state} locale={locale} />));
  expect(container.querySelector('summary [role="status"]')?.textContent).toBe(locale === 'zh-CN' ? '记忆已保存' : 'Memory saved');
  expect(container.querySelector('summary .ugs-review-meta')?.textContent).toBe(locale === 'zh-CN' ? '1 项' : '1 items');
});
