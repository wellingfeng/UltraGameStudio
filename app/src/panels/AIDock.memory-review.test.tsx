import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { simpleBlueprint } from '@/core/defaultBlueprint';
import { defaultComposer, samplePromptGroups } from '@/store/sampleSessions';
import { useStore } from '@/store/useStore';
import * as storeApi from '@/store/useStore';
import { DEFAULT_SKILL_LEARNING_CONFIG } from '@/lib/skillLearningConfig';
import type { SkillReviewState } from '@/runtime/skills/types';
import { loadMemoryReviewJournal, saveMemoryReviewJournal, saveMemoryConfig, DEFAULT_MEMORY_CONFIG } from '@/lib/memoryConfig';
import { beginMemoryReviewTurn } from '@/lib/memoryReviewDesktop';
import { getMemoryReviewStates, publishMemoryReview } from '@/lib/memoryReviewEvents';
import { resetGenerationSettingsStoreForTests } from '@/lib/generationSettingsStore';
import AIDock from './AIDock';
const model = vi.hoisted(() => ({ review: vi.fn() }));
vi.mock('@/lib/memoryRefresh', () => ({ makeReviewInvoker: () => async () => '' }));
vi.mock('@/lib/memoryConsolidate', () => ({ runConsolidatingReview: model.review }));
vi.mock('@/lib/memoryStore', async original => ({ ...await original<typeof import('@/lib/memoryStore')>(),
  readMemoryBase: async (target: string, workspaceId?: string) => ({ target, workspaceId, raw: null, entries: [] }) }));

const source = { hostId: 'local', namespaceId: 'local', workspaceId: 'chat-workspace', sessionId: 'chat-session',
  turnId: 'u1', sourceMessageId: 'u1', runId: 'real-run' };
let root: Root | undefined;
let container: HTMLDivElement;
beforeEach(() => {
  source.sessionId = `chat-session-${crypto.randomUUID()}`;
  localStorage.clear(); resetGenerationSettingsStoreForTests();
  saveMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, reviewEnabled: true, reviewMinMessages: 2, reviewMinIntervalMinutes: 0 });
  model.review.mockReset().mockResolvedValue({ appliedOps: 1, queuedOps: 0, lastErrors: [] });
  useStore.setState({ ...useStore.getInitialState(), mode: 'design', workflow: simpleBlueprint('Memory chat fixture'),
    selectedNodeId: null, composer: { ...defaultComposer }, composerDraft: '', composerDrafts: {}, locale: 'zh-CN',
    promptGroups: samplePromptGroups, queuedChatMessageIds: [], activeWorkspaceId: source.workspaceId,
    activeSessionId: source.sessionId, workspaceHistory: [], aiStreaming: false, aiEditingSessions: [], chattingSessions: [],
    messages: [{ id: 'u1', role: 'user', text: '第一轮真实输入', createdAt: 1 },
      { id: 'a1', role: 'assistant', text: '第一轮原始回答', createdAt: 2 },
      { id: 'u2', role: 'user', text: '第二轮输入', createdAt: 3 },
      { id: 'a2', role: 'assistant', text: '第二轮回答', createdAt: 4 }],
  });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; container.remove(); vi.restoreAllMocks(); });

it('mounts the fresh persisted cancellation at its original assistant, not the latest turn', async () => {
  const journal = await loadMemoryReviewJournal();
  await saveMemoryReviewJournal(journal.raw, { ...journal.value, jobs: [{ id: 'real-journal-job', source,
    phase: 'cancelled', appliedOps: 0, queuedOps: 0, error: 'AbortError: Memory review cancelled', updatedAt: 12 }] });
  const before = useStore.getState().messages;
  await act(async () => root!.render(<AIDock layout="chat" />));
  const card = container.querySelector('[data-ugs-memory-review]');
  expect(card).not.toBeNull();
  expect(card?.textContent).toContain('记忆复盘已取消');
  expect(card?.getAttribute('data-tone')).toBe('interrupted');
  expect(card?.closest('[data-ugs-message-row]')?.textContent).toContain('第一轮原始回答');
  expect(card?.closest('[data-ugs-message-row]')?.textContent).not.toContain('第二轮回答');
  expect(useStore.getState().messages).toBe(before);
});

it('forwards real producer reading and applied events to the mounted original answer without writing chat', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  model.review.mockImplementation(async () => { await gate; return { appliedOps: 1, queuedOps: 0, lastErrors: [] }; });
  await act(async () => root!.render(<AIDock layout="chat" />));
  const before = useStore.getState().messages;
  const turn = beginMemoryReviewTurn({ source: { ...source, runId: 'live-reading' },
    config: { reviewEnabled: true, writeEnabled: true, reviewMinMessages: 2, reviewMinIntervalMinutes: 0 },
    messages: before.slice(0, 2), ready: Promise.resolve() });
  let pending!: ReturnType<typeof turn.finish>;
  try {
    await act(async () => { pending = turn.finish('completed'); await vi.waitFor(() => expect(model.review).toHaveBeenCalled()); });
    expect(container.querySelector('[data-ugs-memory-review] [role="status"]')?.textContent).toBe('正在复盘记忆');
    expect(container.querySelector('[data-ugs-memory-review]')?.getAttribute('data-active')).toBe('true');
    await act(async () => { release(); await pending; });
    expect(container.querySelector('[data-ugs-memory-review] [role="status"]')?.textContent).toBe('记忆已保存');
    expect(container.querySelector('[data-ugs-memory-review]')?.closest('[data-ugs-message-row]')?.textContent).toContain('第一轮原始回答');
    expect(useStore.getState().messages).toBe(before);
    expect(model.review).toHaveBeenCalledTimes(1);
  } finally { release(); await pending; }
});

it('mounts resultless skill retry with the existing persisted-state controller', async () => {
  const origin = { hostId: 'local', workspaceId: source.workspaceId, sessionId: source.sessionId, turnId: 'u1', runId: 'resultless-retry' };
  const state: SkillReviewState = { status: 'failed', origin, error: 'SKILL_REVIEW_INTERRUPTED', resume: {
    job: { origin, userText: 'saved source fixture', finalAnswer: 'saved answer', evidence: [], loadedSkills: [], config: DEFAULT_SKILL_LEARNING_CONFIG },
    selection: { adapter: 'codex', modelClass: 'review' },
  } };
  const retry = vi.spyOn(storeApi, 'retryPersistedSkillLearning').mockResolvedValue(undefined);
  useStore.setState({ messages: useStore.getState().messages.map(message => message.id === 'a1' ? { ...message, skillLearning: state } : message) });
  await act(async () => root!.render(<AIDock layout="chat" />));
  const button = container.querySelector<HTMLButtonElement>('[aria-label="重新复盘"]');
  expect(button).not.toBeNull();
  await act(async () => button!.click());
  expect(retry).toHaveBeenCalledExactlyOnceWith(state);
  expect(button?.closest('[data-ugs-message-row]')?.textContent).not.toContain('经验已保存');
});

it('keeps the exact producer assistant binding when a queued user input precedes its reply', async () => {
  const original = useStore.getState().messages;
  const reordered = [original[0], original[2], original[1]];
  useStore.setState({ messages: reordered, queuedChatMessageIds: ['u2'] });
  await act(async () => root!.render(<AIDock layout="chat" />));
  const turn = beginMemoryReviewTurn({ source: { ...source, runId: 'queued-binding' },
    config: { reviewEnabled: true, writeEnabled: true, reviewMinMessages: 2, reviewMinIntervalMinutes: 0 },
    messages: reordered, ready: Promise.resolve() });
  await act(async () => { await turn.finish('completed'); });
  const card = container.querySelector('[data-ugs-memory-review]');
  expect(card).not.toBeNull();
  expect(card?.closest('[data-ugs-message-row]')?.textContent).toContain('第一轮原始回答');
});

it('restores the fresh producer journal binding after reload with a queued user between source and answer', async () => {
  const original = useStore.getState().messages;
  const reordered = [original[0], original[2], original[1]];
  useStore.setState({ messages: reordered, queuedChatMessageIds: ['u2'] });
  await act(async () => root!.render(<AIDock layout="chat" />));
  const turn = beginMemoryReviewTurn({ source: { ...source, runId: 'queued-journal-reload' },
    config: { reviewEnabled: true, writeEnabled: true, reviewMinMessages: 2, reviewMinIntervalMinutes: 0 },
    messages: reordered, ready: Promise.resolve() });
  await act(async () => { await turn.finish('completed'); });
  const liveCard = container.querySelector('[data-ugs-memory-review]');
  expect(liveCard?.closest('[data-ugs-message-row]')?.textContent).toContain('第一轮原始回答');
  const saved = await loadMemoryReviewJournal();
  expect(saved.value.jobs).toHaveLength(1);
  expect(saved.value.jobs[0]).toMatchObject({ assistantMessageId: 'a1', source: { ...source, runId: 'queued-journal-reload' }, phase: 'applied' });
  await act(async () => root!.unmount());
  // Evict this scope from the actual live event cache: only saved bytes may restore it.
  for (let index = 0; index < 100; index++) publishMemoryReview({ id: `reload-eviction-${index}`,
    source: { ...source, hostId: 'isolated-reload-fixture', runId: String(index) },
    phase: 'noop', appliedOps: 0, queuedOps: 0, updatedAt: 1 });
  expect(getMemoryReviewStates().some(state => state.source.hostId === 'local' && state.source.sessionId === source.sessionId)).toBe(false);
  root = createRoot(container);
  await act(async () => root!.render(<AIDock layout="chat" />));
  const savedCard = container.querySelector('[data-ugs-memory-review]');
  expect(savedCard).not.toBeNull();
  expect(savedCard?.closest('[data-ugs-message-row]')?.textContent).toContain('第一轮原始回答');
  expect(savedCard?.getAttribute('data-active')).toBe('false');
  expect(savedCard?.textContent).toContain('记忆已保存');
  expect(model.review).toHaveBeenCalledTimes(1);
  expect(useStore.getState().messages).toBe(reordered);
  expect((await loadMemoryReviewJournal()).raw).toBe(saved.raw);
});

it.each(['host', 'namespace', 'workspace', 'session', 'turn', 'source', 'assistant', 'before-source', 'local-only', 'duplicate-assistant'] as const)(
  'rejects a saved exact assistant binding with a %s mismatch without choosing the latest answer', async mismatch => {
    const wrong = { ...source, runId: `saved-mismatch-${mismatch}` };
    let assistantMessageId = 'a1';
    if (mismatch === 'host') wrong.hostId = 'remote';
    if (mismatch === 'namespace') wrong.namespaceId = 'remote';
    if (mismatch === 'workspace') wrong.workspaceId = 'elsewhere';
    if (mismatch === 'session') wrong.sessionId = 'elsewhere';
    if (mismatch === 'turn') wrong.turnId = 'missing-turn';
    if (mismatch === 'source') wrong.sourceMessageId = 'missing-user';
    if (mismatch === 'assistant') assistantMessageId = 'missing-assistant';
    if (mismatch === 'before-source') {
      const messages = useStore.getState().messages;
      useStore.setState({ messages: [messages[1], messages[0], ...messages.slice(2)] });
    }
    if (mismatch === 'local-only') useStore.setState({ messages: useStore.getState().messages.map(message =>
      message.id === 'a1' ? { ...message, localOnly: true } : message) });
    if (mismatch === 'duplicate-assistant') {
      const messages = useStore.getState().messages;
      useStore.setState({ messages: [...messages, { ...messages[1], text: '无关的重复ID回答' }] });
    }
    const journal = await loadMemoryReviewJournal();
    await saveMemoryReviewJournal(journal.raw, { ...journal.value, jobs: [{ id: 'saved-mismatch', source: wrong,
      assistantMessageId, phase: 'applied', appliedOps: 1, queuedOps: 0, updatedAt: 12 }] });
    const saved = await loadMemoryReviewJournal();
    const before = useStore.getState().messages;
    await act(async () => root!.render(<AIDock layout="chat" />));
    expect(container.querySelector('[data-ugs-memory-review]')).toBeNull();
    expect(model.review).not.toHaveBeenCalled();
    expect(useStore.getState().messages).toBe(before);
    expect((await loadMemoryReviewJournal()).raw).toBe(saved.raw);
  });

it('does not animate a saved in-flight phase without a live producer after remount', async () => {
  const journal = await loadMemoryReviewJournal();
  await saveMemoryReviewJournal(journal.raw, { ...journal.value, jobs: [{ id: 'interrupted', source,
    phase: 'reading', appliedOps: 0, queuedOps: 0, updatedAt: 12 }] });
  await act(async () => root!.render(<AIDock layout="chat" />));
  const card = container.querySelector('[data-ugs-memory-review="interrupted"]');
  expect(card?.getAttribute('data-active')).toBe('false');
  expect(card?.textContent).toContain('上次记忆复盘未确认结束');
  expect(model.review).not.toHaveBeenCalled();
});

it('opens the actual settings dialog from a queued result and can reach Memory approvals', async () => {
  const journal = await loadMemoryReviewJournal();
  await saveMemoryReviewJournal(journal.raw, { ...journal.value, jobs: [{ id: 'approval', source: { ...source, runId: 'approval' },
    phase: 'awaiting_approval', appliedOps: 0, queuedOps: 1, updatedAt: 12 }] });
  await act(async () => root!.render(<AIDock layout="chat" />));
  const open = container.querySelector<HTMLButtonElement>('[data-ugs-memory-review="approval"] button');
  expect(open).not.toBeNull();
  await act(async () => open!.click());
  await act(async () => { await import('./SettingsModal'); });
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  const tab = document.querySelector<HTMLButtonElement>('#settings-tab-memory');
  expect(tab).not.toBeNull();
  await act(async () => tab!.click());
  expect(document.querySelector('#settings-panel-memory')).not.toBeNull();
  expect(model.review).not.toHaveBeenCalled();
});

it.each(['workspace', 'session', 'turn', 'source'] as const)('never attaches a %s mismatch to the latest answer', async mismatch => {
  await act(async () => root!.render(<AIDock layout="chat" />));
  const wrong = { ...source, runId: `mismatch-${mismatch}` };
  if (mismatch === 'workspace') wrong.workspaceId = 'elsewhere';
  if (mismatch === 'session') wrong.sessionId = 'elsewhere';
  if (mismatch === 'turn') wrong.turnId = 'missing-turn';
  if (mismatch === 'source') wrong.sourceMessageId = 'missing-user';
  await act(async () => publishMemoryReview({ id: 'mismatch', source: wrong, phase: 'applied', appliedOps: 1, queuedOps: 0, updatedAt: 3 }));
  expect(container.querySelector('[data-ugs-memory-review="mismatch"]')).toBeNull();
});
