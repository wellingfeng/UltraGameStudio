import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AIDock from './AIDock';
import PromptPanel from './PromptPanel';
import { defaultBlueprint, simpleBlueprint } from '@/core/defaultBlueprint';
import {
  ACTIVE_PROVIDER_BY_KIND_STORAGE,
  PROVIDERS_STORAGE,
  type Provider,
} from '@/lib/apiConfig';
import { isFreeChannelSelection } from '@/lib/freeChannels';
import { workflowDefaultGatewaySelection } from '@/lib/modelGateway/resolver';
import { defaultComposer, samplePromptGroups } from '@/store/sampleSessions';
import type { Message } from '@/store/types';
import { useStore } from '@/store/useStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function resetStoreForPromptLock(
  mode: 'design' | 'running',
  composerDraft = '',
  composerFocusVersion = 0,
): void {
  useStore.setState({
    mode,
    workflow: defaultBlueprint('Prompt lock workflow'),
    selectedNodeId: null,
    aiStreaming: false,
    aiEditingSessions: [],
    chattingSessions: [],
    locale: 'zh-CN',
    promptAutoTranslate: false,
    promptGroups: samplePromptGroups,
    composer: defaultComposer,
    composerDraft,
    composerDrafts: {},
    composerFocusVersion,
    messages: [],
    activeWorkspaceId: null,
    activeSessionId: 's_prompt',
    workspaceHistory: [],
    runningSessionProgress: {},
  });
}

async function renderPanels(): Promise<{
  container: HTMLDivElement;
  cleanup: () => Promise<void>;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(
      <>
        <AIDock />
        <PromptPanel />
      </>,
    );
  });

  return {
    container,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function renderChatDock(): Promise<{
  container: HTMLDivElement;
  cleanup: () => Promise<void>;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(<AIDock layout="chat" />);
  });

  return {
    container,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((item) =>
    item.textContent?.includes(text),
  );
  if (!button) throw new Error(`Missing button containing text: ${text}`);
  return button;
}

function aiInput(container: HTMLElement): HTMLTextAreaElement {
  const input = container.querySelector('textarea');
  if (!input) throw new Error('Missing AI input textarea');
  return input;
}

function optionalSearchInput(container: HTMLElement): HTMLInputElement | null {
  return container.querySelector('input[aria-label="搜索 AI 返回内容"]');
}

function searchInput(container: HTMLElement): HTMLInputElement {
  const input = optionalSearchInput(container);
  if (!input) throw new Error('Missing AI return search input');
  return input;
}

function buttonByAriaLabel(
  container: HTMLElement,
  ariaLabel: string,
): HTMLButtonElement {
  const button = container.querySelector(`button[aria-label="${ariaLabel}"]`);
  if (!button) throw new Error(`Missing button with aria-label: ${ariaLabel}`);
  return button as HTMLButtonElement;
}

function sendButton(container: HTMLElement): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((item) =>
    ['↑', '…'].includes(item.textContent?.trim() ?? ''),
  );
  if (!button) throw new Error('Missing AI send button');
  return button;
}

function modelStrategyButton(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector(
    'button[title="模型策略 · AI 自动为每个节点选模型"]',
  );
}

function channelButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector('button[title="渠道"]');
  if (!button) throw new Error('Missing channel selector');
  return button as HTMLButtonElement;
}

function seedDefaultChannels(): void {
  const providers: Provider[] = [
    {
      id: 'p_sss',
      kind: 'anthropic',
      name: 'SSSAiCode',
      apiKey: 'sk-sss',
      baseUrl: 'https://sss.example/v1',
      transport: 'cli',
      model: 'claude-opus-4-8',
    },
    {
      id: 'p_deepseek',
      kind: 'anthropic',
      name: 'DeepSeek',
      apiKey: 'sk-deepseek',
      baseUrl: 'https://deepseek.example/v1',
      transport: 'cli',
      model: 'deepseek-v4-pro',
    },
    {
      id: 'p_kimi',
      kind: 'anthropic',
      name: 'Kimi For Coding',
      apiKey: 'sk-kimi',
      baseUrl: 'https://kimi.example/v1',
      transport: 'cli',
      model: 'kimi-for-coding',
    },
    {
      id: 'p_packy',
      kind: 'anthropic',
      name: 'PackyCode',
      apiKey: 'sk-packy',
      baseUrl: 'https://packy.example/v1',
      transport: 'cli',
      model: 'packy-code',
    },
    {
      id: 'p_opencode',
      kind: 'anthropic',
      name: 'OpenCode Zen',
      apiKey: 'sk-opencode',
      baseUrl: 'https://opencode.example/v1',
      transport: 'cli',
      model: 'opencode-zen',
    },
    {
      id: 'p_codex',
      kind: 'codex',
      name: 'Codex Relay',
      apiKey: 'sk-codex',
      baseUrl: 'https://codex.example/v1',
      transport: 'cli',
      model: 'gpt-5.1',
    },
    {
      id: 'p_gemini',
      kind: 'gemini',
      name: 'Gemini Relay',
      apiKey: 'sk-gemini',
      baseUrl: 'https://gemini.example/v1',
      transport: 'cli',
      model: 'gemini-3-pro',
    },
  ];
  window.localStorage.setItem(PROVIDERS_STORAGE, JSON.stringify(providers));
  window.localStorage.setItem(
    ACTIVE_PROVIDER_BY_KIND_STORAGE,
    JSON.stringify({
      anthropic: 'p_sss',
      codex: 'p_codex',
      gemini: 'p_gemini',
    }),
  );
}

function typeIntoInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

afterEach(() => {
  window.localStorage.clear();
  document.body.innerHTML = '';
});

describe('PromptPanel running lock', () => {
  it('ignores direct append requests while the workflow is running', () => {
    resetStoreForPromptLock('running', 'existing draft', 7);

    useStore.getState().appendComposerDraft('grill-me');

    expect(useStore.getState().composerDraft).toBe('existing draft');
    expect(useStore.getState().composerFocusVersion).toBe(7);
  });

  it('disables prompt entries while keeping other panel controls usable', async () => {
    resetStoreForPromptLock('running', 'existing draft', 7);
    const view = await renderPanels();

    try {
      const editButton = buttonByText(view.container, '编辑');
      const groupToggle = buttonByText(view.container, '互动澄清');
      const promptEntry = buttonByText(view.container, '拷问我');

      expect(editButton.disabled).toBe(false);
      expect(groupToggle.disabled).toBe(false);
      expect(promptEntry.disabled).toBe(true);

      editButton.focus();
      expect(document.activeElement).toBe(editButton);

      await act(async () => {
        promptEntry.click();
      });

      expect(useStore.getState().composerDraft).toBe('existing draft');
      expect(useStore.getState().composerFocusVersion).toBe(7);
      expect(document.activeElement).toBe(editButton);
    } finally {
      await view.cleanup();
    }
  });

  it('keeps design-mode prompt insertion and input focus working', async () => {
    resetStoreForPromptLock('design', 'existing draft', 7);
    const view = await renderPanels();

    try {
      const promptEntry = buttonByText(view.container, '拷问我');
      const input = aiInput(view.container);

      expect(promptEntry.disabled).toBe(false);
      expect(input.disabled).toBe(false);

      await act(async () => {
        promptEntry.click();
      });

      expect(useStore.getState().composerDraft).toBe(
        'existing draft\ngrill-me',
      );
      expect(useStore.getState().composerFocusVersion).toBe(8);
      expect(input.value).toBe('existing draft\ngrill-me');
      expect(document.activeElement).toBe(input);
    } finally {
      await view.cleanup();
    }
  });

  it('shows the model strategy selector for workflow mode', async () => {
    resetStoreForPromptLock('design');
    const view = await renderPanels();

    try {
      expect(modelStrategyButton(view.container)).toBeInstanceOf(
        HTMLButtonElement,
      );
    } finally {
      await view.cleanup();
    }
  });

  it('hides the model strategy selector for simple chat mode', async () => {
    resetStoreForPromptLock('design');
    useStore.setState({
      workflow: simpleBlueprint('Simple chat'),
    });
    const view = await renderPanels();

    try {
      expect(modelStrategyButton(view.container)).toBeNull();
      expect(view.container.textContent).not.toContain('尽量用更好的大模型');
    } finally {
      await view.cleanup();
    }
  });

  it('groups default and free channels in the bottom selector', async () => {
    seedDefaultChannels();
    resetStoreForPromptLock('design');
    const view = await renderChatDock();

    try {
      const selector = channelButton(view.container);

      expect(selector.textContent).toContain('SSSAiCode');
      expect(selector.textContent).toContain('Claude Code · 默认渠道');

      await act(async () => {
        selector.click();
      });

      const groupHeaders = Array.from(
        view.container.querySelectorAll('li[role="presentation"]'),
      ).map((item) => item.textContent?.trim());
      expect(groupHeaders).toEqual([
        'Claude Code',
        'Codex',
        'Gemini',
        '免费渠道',
      ]);
      expect(view.container.textContent).toContain('Claude Code · 默认渠道');
      expect(view.container.textContent).toContain('Codex · 默认渠道');
      expect(view.container.textContent).toContain('Gemini · 默认渠道');
      expect(view.container.textContent).toContain('免费渠道');
      expect(view.container.textContent).toContain('DeepSeek');
      expect(view.container.textContent).toContain('Kimi For Coding');
      expect(view.container.textContent).toContain('Codex Relay');
      expect(view.container.textContent).toContain('Gemini Relay');
      expect(view.container.textContent).toContain('Free · LLM7');
    } finally {
      await view.cleanup();
    }
  });

  it('switches configured default channels and a free channel from the same selector', async () => {
    seedDefaultChannels();
    resetStoreForPromptLock('design');
    const view = await renderChatDock();

    try {
      await act(async () => {
        channelButton(view.container).click();
      });
      await act(async () => {
        buttonByText(view.container, 'Codex Relay').click();
      });

      expect(workflowDefaultGatewaySelection(useStore.getState().workflow)).toEqual({
        adapter: 'codex',
        modelClass: 'gpt-5.1',
        providerId: 'p_codex',
        channelId: 'default',
      });

      await act(async () => {
        channelButton(view.container).click();
      });
      await act(async () => {
        buttonByText(view.container, 'LLM7').click();
        await Promise.resolve();
      });

      const selection = workflowDefaultGatewaySelection(
        useStore.getState().workflow,
      );
      expect(isFreeChannelSelection(selection)).toBe('llm7');
      expect(selection).toMatchObject({
        adapter: 'claude-code',
        channelId: 'default',
      });
    } finally {
      await view.cleanup();
    }
  });

  it('uses the chat-specific empty state copy in simple chat mode', async () => {
    resetStoreForPromptLock('design');
    useStore.setState({
      workflow: simpleBlueprint('Simple chat'),
      messages: [],
    });
    const view = await renderChatDock();

    try {
      expect(view.container.textContent).toContain('今天想做些什么呢？');
      expect(view.container.textContent).not.toContain(
        '在右侧描述你的意图，AI 将据此操作画布并在此回显。',
      );
    } finally {
      await view.cleanup();
    }
  });

  it('updates the chat header when the active session is renamed', async () => {
    resetStoreForPromptLock('design');
    const originalSession = {
      id: 's_chat',
      workspaceId: 'ws_chat',
      title: 'Original chat',
      createdAt: 1,
      updatedAt: 1,
      isWorkflow: false,
    };
    useStore.setState({
      workflow: simpleBlueprint('Stale workflow title'),
      activeWorkspaceId: 'ws_chat',
      activeSessionId: originalSession.id,
      sessions: [originalSession],
      sessionTree: { ws_chat: [originalSession] },
    });
    const view = await renderChatDock();

    try {
      expect(
        view.container.querySelector(
          'header [data-testid="chat-title-display"][title="Original chat"]',
        ),
      ).toBeInstanceOf(HTMLElement);

      const renamedSession = {
        ...originalSession,
        title: 'Renamed chat',
        updatedAt: 2,
      };
      await act(async () => {
        useStore.setState({
          sessions: [renamedSession],
          sessionTree: { ws_chat: [renamedSession] },
        });
      });

      expect(
        view.container.querySelector(
          'header [data-testid="chat-title-display"][title="Renamed chat"]',
        ),
      ).toBeInstanceOf(HTMLElement);
      expect(
        view.container.querySelector(
          'header [data-testid="chat-title-display"][title="Stale workflow title"]',
        ),
      ).toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  it('renames the active chat from the header title editor', async () => {
    resetStoreForPromptLock('design');
    const originalRenameWorkflowSession =
      useStore.getState().renameWorkflowSession;
    const renameWorkflowSession = vi.fn().mockResolvedValue(undefined);
    const originalSession = {
      id: 's_chat',
      workspaceId: 'ws_chat',
      title: 'Original chat',
      createdAt: 1,
      updatedAt: 1,
      isWorkflow: false,
    };
    useStore.setState({
      workflow: simpleBlueprint('Stale workflow title'),
      activeWorkspaceId: 'ws_chat',
      activeSessionId: originalSession.id,
      sessions: [originalSession],
      sessionTree: { ws_chat: [originalSession] },
      renameWorkflowSession,
    });
    const view = await renderChatDock();

    try {
      const titleButton = view.container.querySelector(
        'button[data-testid="chat-title-display"]',
      ) as HTMLButtonElement | null;
      expect(titleButton).toBeInstanceOf(HTMLButtonElement);

      await act(async () => {
        titleButton?.click();
      });

      const titleInput = view.container.querySelector(
        'input[data-testid="chat-title-input"]',
      ) as HTMLInputElement | null;
      expect(titleInput).toBeInstanceOf(HTMLInputElement);
      expect(titleInput?.value).toBe('Original chat');
      expect(titleInput?.selectionStart).toBe(0);
      expect(titleInput?.selectionEnd).toBe('Original chat'.length);

      await act(async () => {
        if (!titleInput) return;
        typeIntoInput(titleInput, 'Renamed from top');
        titleInput.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        );
        await Promise.resolve();
      });

      expect(renameWorkflowSession).toHaveBeenCalledWith(
        's_chat',
        'ws_chat',
        'Renamed from top',
      );
    } finally {
      await view.cleanup();
      useStore.setState({
        renameWorkflowSession: originalRenameWorkflowSession,
      });
    }
  });

  it('shows the chat run button in simple chat mode', async () => {
    resetStoreForPromptLock('design', 'hello');
    useStore.setState({
      workflow: simpleBlueprint('Simple chat'),
    });
    const view = await renderChatDock();

    try {
      const runButton = buttonByAriaLabel(view.container, '运行当前会话输入');

      expect(runButton.disabled).toBe(false);
      expect(runButton.textContent).toContain('运行');
    } finally {
      await view.cleanup();
    }
  });

  it('reruns a favorited chat from its first user message', async () => {
    resetStoreForPromptLock('design');
    const originalSendPrompt = useStore.getState().sendPrompt;
    const sendPrompt = vi.fn();
    useStore.setState({
      workflow: simpleBlueprint('Reusable chat'),
      composerDraft: '',
      sendPrompt,
      sessions: [
        {
          id: 's_prompt',
          title: 'Reusable chat',
          createdAt: 1,
          updatedAt: 1,
          isWorkflow: false,
          favorite: true,
        },
      ],
      messages: [
        { id: 'm_user', role: 'user', text: 'repeat this task', createdAt: 1 },
        { id: 'm_ai', role: 'assistant', text: 'done', createdAt: 2 },
      ],
    });
    const view = await renderChatDock();

    try {
      const runButton = buttonByAriaLabel(view.container, '运行当前会话输入');

      expect(runButton.disabled).toBe(false);

      await act(async () => {
        runButton.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(sendPrompt).toHaveBeenCalledWith('repeat this task');
      expect(useStore.getState().composerDraft).toBe('');
    } finally {
      await view.cleanup();
      useStore.setState({ sendPrompt: originalSendPrompt });
    }
  });

  it('keeps empty unfavorited chat runs disabled', async () => {
    resetStoreForPromptLock('design');
    useStore.setState({
      workflow: simpleBlueprint('Plain chat'),
      composerDraft: '',
      sessions: [
        {
          id: 's_prompt',
          title: 'Plain chat',
          createdAt: 1,
          updatedAt: 1,
          isWorkflow: false,
        },
      ],
      messages: [
        { id: 'm_user', role: 'user', text: 'repeat this task', createdAt: 1 },
      ],
    });
    const view = await renderChatDock();

    try {
      const runButton = buttonByAriaLabel(view.container, '运行当前会话输入');

      expect(runButton.disabled).toBe(true);
    } finally {
      await view.cleanup();
    }
  });

  it('flips the simple chat top action to stop while chatting', async () => {
    resetStoreForPromptLock('design', 'hello');
    useStore.setState({
      workflow: simpleBlueprint('Simple chat'),
      chattingSessions: [{ workspaceId: null, sessionId: 's_prompt' }],
    });
    const view = await renderChatDock();

    try {
      const stopButton = buttonByAriaLabel(view.container, '停止当前会话生成');

      expect(stopButton.disabled).toBe(false);
      expect(stopButton.textContent).toContain('停止');
    } finally {
      await view.cleanup();
    }
  });

  it('hides the model strategy selector for non-workflow sessions', async () => {
    resetStoreForPromptLock('design');
    useStore.setState({
      activeSessionId: 's_chat',
      sessions: [
        {
          id: 's_chat',
          title: '未命名会话',
          createdAt: 1,
          updatedAt: 1,
          isWorkflow: false,
        },
      ],
    });
    const view = await renderPanels();

    try {
      expect(modelStrategyButton(view.container)).toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  it('keeps the send action enabled while another workflow is AI editing', async () => {
    resetStoreForPromptLock('design', 'optimize this workflow');
    useStore.setState({
      aiStreaming: true,
      aiEditingSessions: [{ workspaceId: null, sessionId: 's_other' }],
    });
    const view = await renderPanels();

    try {
      const button = sendButton(view.container);

      expect(button.disabled).toBe(false);
      expect(button.textContent?.trim()).toBe('↑');
    } finally {
      await view.cleanup();
    }
  });

  it('searches and locates AI output matches in real time', async () => {
    resetStoreForPromptLock('design');
    useStore.setState({
      messages: [
        {
          id: 'm_a',
          role: 'assistant',
          text: 'alpha beta\nalpha',
          createdAt: 1,
        },
        {
          id: 'm_b',
          role: 'system',
          text: 'gamma alpha',
          createdAt: 2,
        },
      ] as Message[],
    });

    const view = await renderPanels();

    try {
      expect(optionalSearchInput(view.container)).toBeNull();

      await act(async () => {
        buttonByAriaLabel(view.container, '搜索 AI 返回内容').click();
      });

      const input = searchInput(view.container);

      await act(async () => {
        input.focus();
        typeIntoInput(input, 'alpha');
      });

      expect(view.container.textContent).toContain('1/3');
      expect(view.container.querySelectorAll('mark[data-search-match-id]')).toHaveLength(3);

      const nextButton = buttonByAriaLabel(view.container, '下一个匹配');
      await act(async () => {
        nextButton.click();
      });

      expect(view.container.textContent).toContain('2/3');

      const clearButton = buttonByAriaLabel(view.container, '清空搜索');
      await act(async () => {
        clearButton.click();
      });

      expect(searchInput(view.container).value).toBe('');
      expect(view.container.querySelectorAll('mark[data-search-match-id]')).toHaveLength(0);
      expect(document.activeElement).toBe(searchInput(view.container));
    } finally {
      await view.cleanup();
    }
  });

  it('opens chat search with Ctrl+F and closes it with Escape', async () => {
    resetStoreForPromptLock('design');
    useStore.setState({
      workflow: simpleBlueprint('Plain chat'),
      messages: [
        { id: 'm_user', role: 'user', text: 'find needle', createdAt: 1 },
        { id: 'm_ai', role: 'assistant', text: 'needle response', createdAt: 2 },
      ] as Message[],
    });
    const view = await renderChatDock();

    try {
      expect(optionalSearchInput(view.container)).toBeNull();

      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'f',
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      });

      const input = searchInput(view.container);

      await act(async () => {
        typeIntoInput(input, 'needle');
      });

      expect(view.container.textContent).toContain('1/2');
      expect(view.container.querySelectorAll('mark[data-search-match-id]')).toHaveLength(2);

      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
          }),
        );
      });

      expect(optionalSearchInput(view.container)).toBeNull();
      expect(view.container.querySelectorAll('mark[data-search-match-id]')).toHaveLength(0);
      expect(view.container.textContent).not.toContain('1/2');
    } finally {
      await view.cleanup();
    }
  });
});
