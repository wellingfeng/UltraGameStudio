import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '@/store/useStore';
import type { SkillMutationResult, SkillReviewState } from '@/runtime/skills/types';
import MessageContent from './MessageContent';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const origin = { hostId: 'local', workspaceId: 'ws-a', sessionId: 'session-a', turnId: 'turn-a', runId: 'run-a' };
const result: SkillMutationResult = { status: 'awaiting_approval', batchId: 'batch-a', origin, lesson: 'Only report observed verification.', operationsApplied: 0, changes: [], riskReasons: [] };
const state: SkillReviewState = { status: result.status, origin, result };
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  useStore.setState({ locale: 'en-US' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('MessageContent learning surface', () => {
  it.each(['queued', 'reading', 'proposing', 'applying', 'noop', 'failed', 'cancelled'] as const)(
    'renders no empty message wrapper for %s', async (status) => {
      await act(async () => { root.render(<MessageContent text="" skillLearning={{ ...state, status }} />); });
      expect(container.innerHTML).toBe('');
      await act(async () => { root.render(<MessageContent text="正常回答保留" skillLearning={{ ...state, status }} />); });
      expect(container.textContent).toContain('正常回答保留');
      expect(container.querySelector('article')).toBeNull();
    });
  it('renders a structured learning card even for a textless history message and forwards its exact action', async () => {
    const onSkillApprove = vi.fn(async () => ({ ...result, status: 'applied' as const, operationsApplied: 1 }));
    await act(async () => {
      root.render(<MessageContent text="" skillLearning={state} onSkillApprove={onSkillApprove} />);
    });
    expect(container.textContent).toContain('Awaiting approval');
    expect(container.textContent).toContain(result.lesson);
    const approve = container.querySelector<HTMLButtonElement>('button[aria-label="Approve changes"]');
    expect(approve).not.toBeNull();
    await act(async () => { approve!.click(); });
    expect(onSkillApprove).toHaveBeenCalledExactlyOnceWith('batch-a');
    expect(container.textContent).toContain('Learned');
  });
});
