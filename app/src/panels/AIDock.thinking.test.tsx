import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { simpleBlueprint } from '@/core/defaultBlueprint';
import { defaultComposer, samplePromptGroups } from '@/store/sampleSessions';
import { useStore } from '@/store/useStore';
import AIDock from './AIDock';

it('shows recorded thinking levels beside routes without applying current settings to history', async () => {
  const workflow = simpleBlueprint('Simple chat');
  workflow.meta.gateway = { defaults: { adapter: 'claude-code', modelClass: 'sonnet', thinkingLevel: 'low' } };
  useStore.setState({
    mode: 'design', workflow, selectedNodeId: null,
    composer: defaultComposer, composerDraft: '', composerDrafts: {}, locale: 'zh-CN',
    promptGroups: samplePromptGroups,
    messages: [
      { id: 'high', role: 'assistant', routeLabel: 'KuroCC · claude-opus-5.5', thinkingLevel: 'high', text: '高档回答', createdAt: 100 },
      { id: 'default', role: 'assistant', routeLabel: 'Codex · gpt-6', thinkingLevel: 'default', text: '默认回答', createdAt: 200 },
      { id: 'custom', role: 'assistant', routeLabel: '自定义 · model', thinkingLevel: 'ultra', text: '自定义档回答', createdAt: 300 },
      { id: 'old', role: 'assistant', routeLabel: 'KuroCC · claude-opus-5.5', text: '旧记录', createdAt: 400 },
    ],
    queuedChatMessageIds: [], activeWorkspaceId: null, activeSessionId: null, workspaceHistory: [],
    aiStreaming: false, aiEditingSessions: [], chattingSessions: [], blockedSendTip: null,
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const headers = () => [...container.querySelectorAll('[data-ugs-message-row]')].map(row => row.querySelector('span[title]')?.textContent);
  try {
    await act(async () => { root.render(<AIDock layout="chat" />); });
    expect(headers()).toEqual([
      '⟳ KuroCC · claude-opus-5.5 · 思考深度：高',
      '⟳ Codex · gpt-6 · 思考深度：默认（不指定）',
      '⟳ 自定义 · model · 思考深度：ultra',
      '⟳ KuroCC · claude-opus-5.5',
    ]);
    await act(async () => { useStore.getState().setSessionRunSelection({ adapter: 'claude-code', modelClass: 'sonnet', thinkingLevel: 'xhigh' }); });
    expect(headers()[0]).toContain('思考深度：高');
    expect(headers()[3]).not.toContain('思考深度');
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    useStore.setState({ messages: [], queuedChatMessageIds: [] });
  }
});
