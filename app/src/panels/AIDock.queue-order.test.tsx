import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { simpleBlueprint } from '@/core/defaultBlueprint';
import { defaultComposer, samplePromptGroups } from '@/store/sampleSessions';
import { useStore } from '@/store/useStore';
import AIDock from './AIDock';

it('rerenders the queued tail when only queue state changes', async () => {
  const messages = [
    { id: 'u1', role: 'user' as const, text: '原任务', createdAt: 100 },
    { id: 'question', role: 'assistant' as const, text: '已选择继续', createdAt: 200 },
    { id: 'queued', role: 'user' as const, text: '排队任务', createdAt: 300 },
    { id: 'continuation', role: 'assistant' as const, text: '选择后的续答', createdAt: 400 },
  ];
  useStore.setState({
    mode: 'design', workflow: simpleBlueprint('Simple chat'), selectedNodeId: null,
    composer: defaultComposer, composerDraft: '', composerDrafts: {}, locale: 'zh-CN',
    promptGroups: samplePromptGroups, messages, queuedChatMessageIds: ['queued'],
    activeWorkspaceId: null, activeSessionId: null, workspaceHistory: [],
    aiStreaming: false, aiEditingSessions: [], chattingSessions: [], blockedSendTip: null,
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const rows = () => [...container.querySelectorAll('[data-ugs-message-row]')].map((row) => row.textContent);
  try {
    await act(async () => { root.render(<AIDock layout="chat" />); });
    expect(rows().at(-1)).toContain('排队任务');
    expect(rows().at(-1)).toContain('排队中');
    expect(rows().at(-2)).toContain('选择后的续答');
    await act(async () => { useStore.setState({ queuedChatMessageIds: [] }); });
    expect(rows().at(-1)).toContain('选择后的续答');
    expect(rows().at(-2)).toContain('排队任务');
    expect(container.textContent).not.toContain('排队中');
    expect(useStore.getState().messages).toBe(messages);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    useStore.setState({ messages: [], queuedChatMessageIds: [] });
  }
});
