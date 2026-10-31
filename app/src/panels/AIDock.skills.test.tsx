import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { simpleBlueprint } from '@/core/defaultBlueprint';
import { defaultComposer, samplePromptGroups } from '@/store/sampleSessions';
import { useStore, type StoreState } from '@/store/useStore';
import type { SkillMutationResult, SkillReviewState } from '@/runtime/skills/types';
import AIDock from './AIDock';

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/tauri')>(),
  tauriAvailable: () => false,
  slashCatalog: async () => ({ scannedAtMs: 1, ready: true, entries: [] }),
  onSlashCatalogUpdated: async () => () => {},
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
let learnSkills: ReturnType<typeof vi.fn<StoreState['learnSkills']>>;
let sendPrompt: ReturnType<typeof vi.fn<StoreState['sendPrompt']>>;
const originalActions = {
  sendPrompt: useStore.getState().sendPrompt,
  learnSkills: useStore.getState().learnSkills,
  reviewSkillLearningAction: useStore.getState().reviewSkillLearningAction,
  updateSkillLearningState: useStore.getState().updateSkillLearningState,
} satisfies Partial<StoreState>;

beforeEach(() => {
  window.localStorage.clear();
  learnSkills = vi.fn<StoreState['learnSkills']>(() => true);
  sendPrompt = vi.fn<StoreState['sendPrompt']>(() => true);
  useStore.setState({
    mode: 'design', workflow: simpleBlueprint('Learning commands'), selectedNodeId: null,
    composer: { ...defaultComposer, workspace: '' }, composerDraft: '', composerDrafts: {},
    locale: 'zh-CN', promptGroups: samplePromptGroups, messages: [], activeWorkspaceId: null,
    activeSessionId: null, sessions: [], workspaces: [], workspaceHistory: [],
    aiStreaming: false, aiEditingSessions: [], chattingSessions: [], runningSessionProgress: {},
    blockedSendTip: null, ...originalActions, sendPrompt, learnSkills,
  } satisfies Partial<StoreState>);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useStore.setState(originalActions);
  vi.restoreAllMocks();
});
async function renderDock() {
  await act(async () => { root.render(<AIDock layout="chat" />); });
}
async function submit(text: string) {
  const input = container.querySelector<HTMLTextAreaElement>('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
    input.setSelectionRange(text.length, text.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  });
}

describe('AIDock explicit skill learning', () => {
  it.each([
    ['', 'zh-CN'],
    ['  \n ', 'en-US'],
    ['⏱ 17:50:58 → 17:51:02 · 耗时 4s\n⚙ 路由：Codex · 模型：review\n', 'zh-CN'],
  ] as const)('renders a standalone review as only the colored strip, without assistant/time chrome (%j, %s)', async (text, locale) => {
    const origin = { hostId: 'local', workspaceId: 'ws-strip', sessionId: 'session-strip', turnId: 'turn-strip', runId: 'run-strip' };
    const message = { id: 'review-strip', role: 'assistant' as const, text, localOnly: true,
      createdAt: new Date(2026, 9, 29, 17, 50, 58).getTime(), completedAt: new Date(2026, 9, 29, 17, 51, 2).getTime(),
      skillLearning: { status: 'proposing' as const, origin } };
    useStore.setState({ locale, messages: [message] });
    await renderDock();
    const assertStripOnly = () => {
      const row = container.querySelector('[data-ugs-message-row]')!;
      expect(row.textContent).not.toMatch(/⟳|assistant|17:50:58|17:51:02|耗时|Duration/i);
      expect(row.querySelector('.ai-stream-text')).toBeNull();
      expect(row.querySelector('summary [data-ugs-review-glyph]')).not.toBeNull();
      expect(row.querySelector('summary [role="status"]')?.textContent).toBe(locale === 'zh-CN' ? '正在提炼经验' : 'Extracting lessons');
      expect(row.querySelector<HTMLDetailsElement>('details[data-ugs-review-diagnostics]')?.open).toBe(false);
    };
    assertStripOnly();
    expect(useStore.getState().messages[0]).toBe(message);
    await act(async () => { useStore.setState({ messages: JSON.parse(JSON.stringify([message])) }); });
    assertStripOnly();
    expect(useStore.getState().messages[0]).toEqual(message);
    expect(learnSkills).not.toHaveBeenCalled();
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it('preserves the ordinary answer header, clock and body when a review is attached', async () => {
    const origin = { hostId: 'local', workspaceId: 'ws-answer', sessionId: 'session-answer', turnId: 'turn-answer', runId: 'run-answer' };
    useStore.setState({ messages: [{ id: 'answer-with-review', role: 'assistant', text: '正常回答仍然保留。',
      createdAt: new Date(2026, 9, 29, 17, 50, 58).getTime(), completedAt: new Date(2026, 9, 29, 17, 51, 2).getTime(),
      skillLearning: { status: 'reading', origin } }] });
    await renderDock();
    const row = container.querySelector('[data-ugs-message-row]')!;
    expect(row.querySelector('[title="⟳ assistant"]')).not.toBeNull();
    expect(row.textContent).toContain('17:50:58');
    expect(row.textContent).toContain('耗时 4s');
    expect(row.textContent).toContain('正常回答仍然保留。');
    expect(row.querySelector('summary [data-ugs-review-glyph]')).not.toBeNull();
  });

  it('hides completed noop rows after live updates and history reload without rewriting stored records or normal answers', async () => {
    const origin = { hostId: 'local', workspaceId: 'ws-noop', sessionId: 'session-noop', turnId: 'turn-noop', runId: 'run-noop' };
    const message = { id: 'learning-noop', role: 'assistant' as const, text: '', localOnly: true, createdAt: 1,
      skillLearning: { status: 'proposing' as const, origin } };
    useStore.setState({ messages: [message] });
    await renderDock();
    expect(container.textContent).toContain('正在提炼经验');
    expect(container.querySelector('[data-ugs-message-row]')).not.toBeNull();
    const completed = { ...message, skillLearning: { status: 'noop' as const, origin,
      result: { status: 'noop' as const, batchId: 'batch-noop', origin, lesson: '已有规则覆盖本次操作。', operationsApplied: 0, changes: [], riskReasons: [],
        usage: { inputTokens: 13103, outputTokens: 198, calls: 1, estimated: false } } } };
    const assertHidden = () => {
      expect(container.textContent).not.toContain('无新经验');
      expect(container.textContent).not.toContain('已有规则覆盖');
      expect(container.textContent).not.toContain('复盘用量');
      expect(container.textContent).not.toContain('本轮未调用回顾模型');
      expect(container.querySelector('article.ugs-skill-review')).toBeNull();
    };
    await act(async () => { useStore.setState({ messages: [completed] }); });
    assertHidden();
    expect(container.querySelector('[data-ugs-message-row]')).toBeNull();
    expect(useStore.getState().messages[0]).toBe(completed);
    await act(async () => { useStore.setState({ messages: [] }); });
    await act(async () => { useStore.setState({ messages: JSON.parse(JSON.stringify([completed])) }); });
    assertHidden();
    expect(container.querySelector('[data-ugs-message-row]')).toBeNull();
    expect(useStore.getState().messages[0]).toEqual(completed);
    await act(async () => { useStore.setState({ messages: [{ ...completed, text: '正常回答仍然保留。' }] }); });
    expect(container.textContent).toContain('正常回答仍然保留。');
    assertHidden();
    expect(container.querySelector('[data-ugs-message-row]')).not.toBeNull();
  });

  it.each(['', '⏱ 17:50:58 → 17:51:02 · 耗时 4s\n⚙ 路由：Codex · 模型：review\n'])(
    'omits resultless nonadmission including metadata-only text without leaving an assistant row (%j)', async text => {
      const origin = { hostId: 'local', workspaceId: 'ws-skip', sessionId: 'session-skip', turnId: 'turn-skip', runId: 'run-skip' };
      const message = { id: 'skipped-review', role: 'assistant' as const, text, localOnly: true, createdAt: 1,
        skillLearning: { status: 'noop' as const, origin, admission: { status: 'not-admitted' as const, reason: 'insufficient-evidence', completedActivities: 3, activityThreshold: 10 } } };
      useStore.setState({ messages: [message] });
      await renderDock();
      expect(container.querySelector('[data-ugs-message-row]')).toBeNull();
      expect(container.textContent).not.toMatch(/未触发技能复盘|⟳|assistant/i);
      expect(useStore.getState().messages[0]).toBe(message);
    });

  it('renders a textless source-frozen history card and persists its action result to that message after navigation', async () => {
    const origin = { hostId: 'local', workspaceId: 'ws-source', sessionId: 'session-source', turnId: 'turn-source', runId: 'run-source', cwd: 'E:/Source' };
    const pending: SkillMutationResult = { status: 'awaiting_approval', batchId: 'batch-source', origin, lesson: 'Source-bound review.', operationsApplied: 0, changes: [], riskReasons: [] };
    const state: SkillReviewState = { status: pending.status, origin, result: pending };
    let complete!: (value: SkillMutationResult) => void;
    const reviewSkillLearningAction = vi.fn<StoreState['reviewSkillLearningAction']>(() => new Promise<SkillMutationResult>((resolve) => { complete = resolve; }));
    const updateSkillLearningState = vi.fn<StoreState['updateSkillLearningState']>(async () => {});
    useStore.setState({ messages: [{ id: 'learning-message', role: 'assistant', text: '', localOnly: true, createdAt: 1, skillLearning: state }], reviewSkillLearningAction, updateSkillLearningState } satisfies Partial<StoreState>);
    await renderDock();
    const approve = container.querySelector<HTMLButtonElement>('button[aria-label="批准修改"]');
    expect(approve).not.toBeNull();
    await act(async () => { approve!.click(); });
    expect(reviewSkillLearningAction).toHaveBeenCalledExactlyOnceWith(state, 'approve', 'batch-source');
    await act(async () => { useStore.setState({ activeWorkspaceId: 'ws-other', activeSessionId: 'session-other', messages: [] }); });
    const result = { ...pending, status: 'applied' as const, operationsApplied: 1, rollbackId: 'rollback-source' };
    await act(async () => { complete(result); });
    expect(updateSkillLearningState).toHaveBeenCalledExactlyOnceWith('learning-message', { ...state, status: 'applied', action: 'approve', result, error: undefined });
  });

  it('does not save or claim an approval result whose cwd differs from the frozen message source', async () => {
    const origin = { hostId: 'local', workspaceId: 'ws-cwd', sessionId: 'session-cwd', turnId: 'turn-cwd', runId: 'run-cwd', cwd: 'E:/Source' };
    const pending: SkillMutationResult = { status: 'awaiting_approval', batchId: 'batch-cwd', origin, lesson: 'Frozen cwd.', operationsApplied: 0, changes: [], riskReasons: [] };
    const state: SkillReviewState = { status: pending.status, origin, result: pending };
    const reviewSkillLearningAction = vi.fn<StoreState['reviewSkillLearningAction']>(async () => ({ ...pending, status: 'applied' as const, operationsApplied: 1, origin: { ...origin, cwd: 'E:/Another' } }));
    const updateSkillLearningState = vi.fn<StoreState['updateSkillLearningState']>(async () => {});
    useStore.setState({ messages: [{ id: 'learning-cwd', role: 'assistant', text: '', localOnly: true, createdAt: 1, skillLearning: state }], reviewSkillLearningAction, updateSkillLearningState } satisfies Partial<StoreState>);
    await renderDock();
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="批准修改"]')!.click(); });
    expect(updateSkillLearningState).not.toHaveBeenCalled();
    expect(container.querySelector('article [role="alert"]')?.textContent).toContain('SKILL_RESULT_ORIGIN_MISMATCH');
    expect(container.querySelector('article [role="status"]')?.textContent).toContain('待批准');
  });

  it('preserves an empty /learn draft and explains that lesson text is required', async () => {
    await renderDock();
    await submit('/learn');
    expect(learnSkills).not.toHaveBeenCalled();
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(container.textContent).toContain('/learn 需要填写');
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('/learn');
  });

  it('preserves the review draft when the store refuses the request', async () => {
    learnSkills.mockReturnValue(false);
    await renderDock();
    await submit('/refine 检查验证');
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('/refine 检查验证');
  });

  it('does not route a similar ordinary word through the native command', async () => {
    await renderDock();
    await submit('/learner explain');
    expect(learnSkills).not.toHaveBeenCalled();
    expect(sendPrompt).toHaveBeenCalled();
  });

  it.each([
    ['/learn 验证后再报告成功', 'learn', '验证后再报告成功'],
    ['/ReFiNe 检查超时\n保留退出码', 'refine', '检查超时\n保留退出码'],
    ['/refine', 'refine', ''],
  ])('routes %s to the native review action without sending a normal prompt', async (text, kind, lesson) => {
    await renderDock();
    await submit(text);
    expect(learnSkills).toHaveBeenCalledExactlyOnceWith(kind, lesson);
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('');
  });
});
