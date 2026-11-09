import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { simpleBlueprint } from '@/core/defaultBlueprint';
import { defaultComposer, samplePromptGroups } from '@/store/sampleSessions';
import { useStore } from '@/store/useStore';
import AIDock from './AIDock';

it('searches old matches without mounting the whole message history', async () => {
  useStore.setState({
    mode: 'design', workflow: simpleBlueprint('Search isolation'), selectedNodeId: null,
    composer: defaultComposer, composerDraft: '', composerDrafts: {}, locale: 'zh-CN',
    promptGroups: samplePromptGroups, queuedChatMessageIds: [], activeWorkspaceId: null,
    activeSessionId: 'search-window-test', workspaceHistory: [], aiStreaming: false,
    aiEditingSessions: [], chattingSessions: [], blockedSendTip: null,
    messages: Array.from({ length: 220 }, (_, i) => ({ id: `search-${i}`, role: i % 2 ? 'assistant' : 'user',
      text: i === 0 || i === 120 ? 'ancient-needle' : `ordinary ${i}`, createdAt: i + 1 })),
  });
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<AIDock layout="chat" />));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-controls="ai-return-search"]')!.click());
    const input = container.querySelector<HTMLInputElement>('#ai-return-search')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'ancient-needle');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.textContent).toContain('1/2');
    expect(container.querySelector('[data-search-match-id="search-0:text:0"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-ugs-message-row]').length).toBeLessThanOrEqual(80);
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(container.textContent).toContain('2/2');
    expect(container.querySelector('[data-search-match-id="search-120:text:0"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-ugs-message-row]').length).toBeLessThanOrEqual(80);
  } finally { await act(async () => root.unmount()); container.remove(); }
});
