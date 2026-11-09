import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { simpleBlueprint } from '@/core/defaultBlueprint';
import { defaultComposer, samplePromptGroups } from '@/store/sampleSessions';
import { useStore } from '@/store/useStore';
import AIDock from './AIDock';

const calls = vi.hoisted(() => ({ bodies: [] as string[], actions: [] as string[] }));
vi.mock('@/components/ai/lib/messageText', async (load) => {
  const real = await load<typeof import('@/components/ai/lib/messageText')>();
  return { ...real,
    renderMessageText: (text: string) => { calls.bodies.push(text); return real.renderMessageText(text); },
    answerActionText: (text: string) => { calls.actions.push(text); return real.answerActionText(text); },
  };
});

it('does not rebuild timeline summaries for an assistant-only text revision', async () => {
  const text = 'unchanged-timeline-user';
  useStore.setState({ mode: 'design', workflow: simpleBlueprint('Stable timeline'), selectedNodeId: null,
    composer: defaultComposer, composerDraft: '', composerDrafts: {}, locale: 'zh-CN',
    promptGroups: samplePromptGroups, queuedChatMessageIds: [], activeWorkspaceId: null,
    activeSessionId: 'stable-timeline-test', workspaceHistory: [], aiStreaming: false,
    aiEditingSessions: [], chattingSessions: [], blockedSendTip: null,
    messages: [{ id: 'timeline-user', role: 'user', text, createdAt: 1 }, { id: 'timeline-tail', role: 'assistant', text: 'tail', createdAt: 2 }] });
  const container = document.createElement('div'); const root = createRoot(container);
  const original = String.prototype.replace;
  let summaryScans = 0;
  try {
    await act(async () => root.render(<AIDock layout="chat" />));
    const replace = vi.spyOn(String.prototype, 'replace').mockImplementation(function(this: string, ...args: unknown[]) {
      const [pattern, replacement] = args;
      if (String(this) === text && pattern instanceof RegExp && pattern.source === '\\s+' && replacement === ' ') summaryScans++;
      return Reflect.apply(original, this, args) as string;
    });
    try {
      await act(async () => useStore.setState((s) => ({ messages: s.messages.map((m) => m.id === 'timeline-tail' ? { ...m, text: 'tail revised' } : m) })));
      expect(container.querySelector('[data-ugs-timeline-marker]')?.getAttribute('aria-label')).toContain(text);
      expect(summaryScans).toBe(0);
    } finally { replace.mockRestore(); }
  } finally { await act(async () => root.unmount()); }
});

it('does not perform one full-history indexOf scan per timeline entry', async () => {
  const messages = Array.from({ length: 180 }, (_, i) => ({ id: `timeline-${i}`, role: i % 2 ? 'assistant' as const : 'user' as const,
    text: `entry ${i}`, createdAt: i + 1 }));
  const scan = vi.fn(Array.prototype.indexOf);
  Object.defineProperty(messages, 'indexOf', { value: scan });
  useStore.setState({ mode: 'design', workflow: simpleBlueprint('Linear timeline'), selectedNodeId: null,
    composer: defaultComposer, composerDraft: '', composerDrafts: {}, locale: 'zh-CN',
    promptGroups: samplePromptGroups, queuedChatMessageIds: [], activeWorkspaceId: null,
    activeSessionId: 'linear-timeline-test', workspaceHistory: [], aiStreaming: false,
    aiEditingSessions: [], chattingSessions: [], blockedSendTip: null, messages });
  const container = document.createElement('div'); const root = createRoot(container);
  try {
    await act(async () => root.render(<AIDock layout="chat" />));
    expect(container.querySelectorAll('[data-ugs-timeline-marker]')).toHaveLength(90);
    expect(scan).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
});

it('does not derive sealed answer-action payloads again on unrelated tail deltas', async () => {
  useStore.setState({ mode: 'design', workflow: simpleBlueprint('Memo actions'), selectedNodeId: null,
    composer: defaultComposer, composerDraft: '', composerDrafts: {}, locale: 'zh-CN',
    promptGroups: samplePromptGroups, queuedChatMessageIds: [], activeWorkspaceId: null,
    activeSessionId: 'memo-action-test', workspaceHistory: [], aiStreaming: false,
    aiEditingSessions: [], chattingSessions: [], blockedSendTip: null,
    messages: [ { id: 'u', role: 'user', text: 'question', createdAt: 1 },
      { id: 'sealed', role: 'assistant', text: '<think>plan</think>sealed-action', createdAt: 2 },
      { id: 'live', role: 'assistant', text: 'tail', createdAt: 3 } ],
  });
  const container = document.createElement('div'); const root = createRoot(container);
  try {
    await act(async () => root.render(<AIDock layout="chat" />));
    calls.actions = [];
    await act(async () => useStore.setState((s) => ({ messages: s.messages.map((m) => m.id === 'live' ? { ...m, text: 'tail delta' } : m) })));
    expect(container.querySelectorAll('[title="复制 AI 回答"]').length).toBeGreaterThan(0);
    expect(calls.actions).not.toContain('<think>plan</think>sealed-action');
  } finally { await act(async () => root.unmount()); }
});

it('keeps sealed body derivation behind the memoized message boundary on tail deltas', async () => {
  useStore.setState({ mode: 'design', workflow: simpleBlueprint('Memo rendering'), selectedNodeId: null,
    composer: defaultComposer, composerDraft: '', composerDrafts: {}, locale: 'zh-CN',
    promptGroups: samplePromptGroups, queuedChatMessageIds: [], activeWorkspaceId: null,
    activeSessionId: 'memo-row-test', workspaceHistory: [], aiStreaming: false,
    aiEditingSessions: [], chattingSessions: [], blockedSendTip: null,
    messages: [ { id: 'u', role: 'user', text: 'question', createdAt: 1 },
      { id: 'sealed', role: 'assistant', text: '<think>plan</think>sealed-answer', createdAt: 2 },
      { id: 'live', role: 'assistant', text: 'tail', createdAt: 3 } ],
  });
  const container = document.createElement('div'); const root = createRoot(container);
  try {
    await act(async () => root.render(<AIDock layout="chat" />));
    calls.bodies = [];
    await act(async () => useStore.setState((s) => ({ messages: s.messages.map((m) => m.id === 'live' ? { ...m, text: 'tail delta' } : m) })));
    expect(container.textContent).toContain('sealed-answer');
    expect(container.textContent).toContain('tail delta');
    expect(calls.bodies).not.toContain('<think>plan</think>sealed-answer');
  } finally { await act(async () => root.unmount()); }
});
