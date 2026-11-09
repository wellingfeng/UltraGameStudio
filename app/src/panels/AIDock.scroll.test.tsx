import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AIDock from './AIDock';
import { simpleBlueprint } from '@/core/defaultBlueprint';
import { defaultComposer, samplePromptGroups } from '@/store/sampleSessions';
import type { Message } from '@/store/types';
import { useStore } from '@/store/useStore';
import { FILE_PREVIEW_DRAWER_LAYOUT_EVENT } from '@/components/ai/FilePreviewDrawer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];

  constructor(private readonly callback: ResizeObserverCallback) {
    ResizeObserverStub.instances.push(this);
  }

  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();

  trigger(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

const originalResizeObserver = globalThis.ResizeObserver;

beforeEach(() => {
  ResizeObserverStub.instances = [];
  (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver =
    ResizeObserverStub as unknown as typeof ResizeObserver;
});

afterEach(() => {
  (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver =
    originalResizeObserver;
});

function chatMessages(prefix: string): Message[] {
  return Array.from({ length: 8 }, (_, index) => ({
    id: `${prefix}_${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `${prefix} message ${index}`,
    createdAt: index + 1,
  })) as Message[];
}

function longChatMessages(prefix: string, count: number): Message[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}_${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `${prefix} message ${index}`,
    createdAt: index + 1,
  })) as Message[];
}

function resetChatSession(sessionId: string, messages: Message[]): void {
  useStore.setState({
    mode: 'design',
    workflow: simpleBlueprint('Plain chat'),
    selectedNodeId: null,
    aiStreaming: false,
    aiEditingSessions: [],
    chattingSessions: [],
    blockedSendTip: null,
    locale: 'zh-CN',
    promptAutoTranslate: false,
    // 这些用例直接操作「$组织架构」入口，所以显式打开三个进阶入口按钮
    // （默认是隐藏的，见 useStore.composerToolButtonsVisible）。
    composerToolButtonsVisible: true,
    promptGroups: samplePromptGroups,
    composer: defaultComposer,
    composerDraft: '',
    composerDrafts: {},
    composerFocusVersion: 0,
    messages,
    activeWorkspaceId: null,
    activeSessionId: sessionId,
    workspaceHistory: [],
    runningSessionProgress: {},
  });
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

function streamElement(container: HTMLElement): HTMLElement {
  const el = container.querySelector('.ugs-ai-return-stream');
  if (!(el instanceof HTMLElement)) throw new Error('Missing AI return stream');
  return el;
}

function composerTextarea(container: HTMLElement): HTMLTextAreaElement {
  const el = container.querySelector('textarea');
  if (!(el instanceof HTMLTextAreaElement)) {
    throw new Error('Missing composer textarea');
  }
  return el;
}

function setScrollMetrics(
  el: HTMLElement,
  metrics: { scrollHeight: number; clientHeight: number },
): void {
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    value: metrics.scrollHeight,
  });
  Object.defineProperty(el, 'clientHeight', {
    configurable: true,
    value: metrics.clientHeight,
  });
}

async function userScrollTo(el: HTMLElement, top: number): Promise<void> {
  await act(async () => {
    el.scrollTop = top;
    el.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
}

async function switchSession(sessionId: string, messages: Message[]): Promise<void> {
  await act(async () => {
    useStore.setState({ activeSessionId: sessionId, messages });
  });
}

async function triggerResizeObservers(): Promise<void> {
  await act(async () => {
    for (const instance of ResizeObserverStub.instances) instance.trigger();
  });
}

async function appendMessage(message: Message): Promise<void> {
  await act(async () => {
    useStore.setState((state) => ({ messages: [...state.messages, message] }));
  });
}

async function setDraft(text: string): Promise<void> {
  await act(async () => {
    useStore.setState({ composerDraft: text });
  });
}

async function pressCtrlEnter(el: HTMLTextAreaElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('AIDock stream scroll state', () => {
  it('hides the composer tool buttons until the setting turns them on', async () => {
    resetChatSession('s_tool_buttons', []);
    await act(async () => {
      useStore.setState({ composerToolButtonsVisible: false });
    });
    const view = await renderChatDock();

    try {
      expect(
        view.container.querySelector('button[data-org-panel-trigger]'),
      ).toBeNull();
      expect(
        view.container.querySelector('button[title="提及文件"]'),
      ).toBeNull();

      await act(async () => {
        useStore.setState({ composerToolButtonsVisible: true });
      });

      expect(
        view.container.querySelector('button[data-org-panel-trigger]'),
      ).toBeInstanceOf(HTMLButtonElement);
      expect(
        view.container.querySelector('button[title="提及文件"]'),
      ).toBeInstanceOf(HTMLButtonElement);
    } finally {
      await view.cleanup();
    }
  });

  it('lists only the thinking levels the current channel supports', async () => {
    resetChatSession('s_thinking_levels', []);
    const view = await renderChatDock();

    try {
      // 输入卡片带 backdrop-filter，自成层叠上下文：没有正 z-index 时，
      // 卡片内的下拉菜单会被右栏「会话文件」面板盖住。
      const card = view.container.querySelector('.ugs-ai-input-card');
      expect(card?.className).toContain('z-30');

      // 系统默认 claude-code CLI 走 `--effort`，级别是它自己的 5 档。
      const trigger = view.container.querySelector<HTMLButtonElement>(
        'button[title="模型版本"]',
      );
      expect(trigger).toBeInstanceOf(HTMLButtonElement);
      expect(trigger?.textContent).toContain('默认');
      expect(view.container.querySelector('button[title="思考深度"]')).toBeNull();

      await act(async () => {
        trigger?.click();
      });

      const selectedModel = view.container.querySelector<HTMLButtonElement>(
        '[role="listbox"] button[role="option"][aria-selected="true"]',
      );
      expect(selectedModel).toBeInstanceOf(HTMLButtonElement);
      await act(async () => {
        selectedModel?.click();
      });

      const labels = Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          '[role="menu"] button[role="menuitemradio"]',
        ),
      ).map((option) => option.textContent ?? '');
      expect(labels.some((label) => label.includes('低'))).toBe(true);
      expect(labels.some((label) => label.includes('极高'))).toBe(true);
      // codex 的 `minimal` 不在 claude-code 的档位集合里。
      expect(labels.some((label) => label.includes('极简'))).toBe(false);

      // 「默认（不指定）」不能只写「用渠道默认」：要么给出实际默认档，
      // 要么把「谁决定」写明白，用户不用猜。
      const defaultLabel = labels.find((label) => label.includes('默认（不指定）'));
      expect(defaultLabel).toBeTruthy();
      expect(defaultLabel).toMatch(/实际默认|由 CLI 自身默认档决定|不传档位参数/);

      const maxOption = Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          '[role="menu"] button[role="menuitemradio"]',
        ),
      ).find((option) => option.textContent?.includes('最高'));
      await act(async () => {
        maxOption?.click();
      });
      expect(
        useStore.getState().workflow.meta.gateway?.defaults?.thinkingLevel,
      ).toBe('max');
      expect(trigger?.textContent).toContain('最高');
      expect(document.querySelector('[role="menu"]')).toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  it('switches model and applies that model’s own thinking levels together', async () => {
    resetChatSession('s_model_thinking_levels', []);
    const previousOverrides = useStore.getState().thinkingLevelOverrides;
    useStore.setState({ thinkingLevelOverrides: 'sonnet=low\nopus=high', thinkingLevelsEnabled: true });
    const view = await renderChatDock();

    try {
      const trigger = view.container.querySelector<HTMLButtonElement>('button[title="模型版本"]');
      await act(async () => { trigger?.click(); });
      const opus = Array.from(view.container.querySelectorAll<HTMLButtonElement>('[role="option"]'))
        .find((option) => option.textContent?.toLowerCase().includes('opus'));
      expect(opus).toBeInstanceOf(HTMLButtonElement);
      await act(async () => { opus?.click(); });
      const levels = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
      expect(levels.some((option) => option.textContent?.startsWith('低'))).toBe(false);
      const high = levels.find((option) => option.textContent?.startsWith('高'));
      expect(high).toBeInstanceOf(HTMLButtonElement);
      await act(async () => { high?.click(); });
      const selection = useStore.getState().workflow.meta.gateway?.defaults;
      expect(selection?.modelClass?.toLowerCase()).toContain('opus');
      expect(selection?.thinkingLevel).toBe('high');
      expect(trigger?.textContent).toContain('高');
    } finally {
      await view.cleanup();
      useStore.setState({ thinkingLevelOverrides: previousOverrides });
    }
  });

  it('keeps model selection usable when thinking levels are disabled', async () => {
    resetChatSession('s_model_without_thinking', []);
    const previousEnabled = useStore.getState().thinkingLevelsEnabled;
    useStore.setState({ thinkingLevelsEnabled: false });
    const view = await renderChatDock();
    try {
      const trigger = view.container.querySelector<HTMLButtonElement>('button[title="模型版本"]');
      expect(trigger?.textContent).not.toContain('默认（不指定）');
      await act(async () => { trigger?.click(); });
      const opus = Array.from(view.container.querySelectorAll<HTMLButtonElement>('[role="option"]'))
        .find((option) => option.textContent?.toLowerCase().includes('opus'));
      expect(opus).toBeInstanceOf(HTMLButtonElement);
      await act(async () => { opus?.click(); });
      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(useStore.getState().workflow.meta.gateway?.defaults?.modelClass?.toLowerCase()).toContain('opus');
    } finally {
      await view.cleanup();
      useStore.setState({ thinkingLevelsEnabled: previousEnabled });
    }
  });

  it('opens the organization chart from the $组织架构 popup trigger', async () => {
    resetChatSession('s_org_tabs', chatMessages('org'));
    const view = await renderChatDock();

    try {
      // The org chart is no longer a top tab; it lives behind a `$组织架构`
      // trigger at the input bottom that pops up a blueprint panel.
      const trigger = Array.from(
        view.container.querySelectorAll<HTMLButtonElement>(
          'button[data-org-panel-trigger]',
        ),
      ).find((button) => button.textContent?.includes('组织架构'));
      expect(trigger).toBeInstanceOf(HTMLButtonElement);

      // Closed by default — the chart content is not mounted yet.
      expect(view.container.textContent).not.toContain('制作人');

      await act(async () => {
        trigger?.click();
      });

      expect(view.container.textContent).toContain('制作人');
      expect(view.container.textContent).toContain('技术总监');
    } finally {
      await view.cleanup();
    }
  });

  it('moves the new-session composer to the bottom while the organization chart is open', async () => {
    resetChatSession('s_org_empty', []);
    const view = await renderChatDock();

    try {
      const inputSection = view.container.querySelector(
        '[aria-label^="AI 输入"]',
      );
      expect(inputSection).toBeInstanceOf(HTMLElement);
      expect(inputSection?.className).toContain('max-w-6xl');

      const trigger = Array.from(
        view.container.querySelectorAll<HTMLButtonElement>(
          'button[data-org-panel-trigger]',
        ),
      ).find((button) => button.textContent?.includes('组织架构'));
      expect(trigger).toBeInstanceOf(HTMLButtonElement);

      await act(async () => {
        trigger?.click();
      });

      const panel = view.container.querySelector('.ugs-ai-input--blueprint');
      expect(panel).toBeInstanceOf(HTMLElement);
      expect((panel as HTMLElement).style.bottom).toBe('312px');
      expect(inputSection?.className).not.toContain('max-w-6xl');
    } finally {
      await view.cleanup();
    }
  });

  it('keeps the new-session composer inside the visible chat area while a file preview drawer is open', async () => {
    resetChatSession('s_preview_empty', []);
    const view = await renderChatDock();
    const originalInnerWidth = window.innerWidth;

    try {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: 1600,
      });
      const dock = view.container.firstElementChild;
      expect(dock).toBeInstanceOf(HTMLElement);
      Object.defineProperty(dock, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
          x: 300,
          y: 0,
          left: 300,
          top: 0,
          right: 1200,
          bottom: 900,
          width: 900,
          height: 900,
          toJSON: () => ({}),
        }),
      });

      await act(async () => {
        window.dispatchEvent(
          new CustomEvent(FILE_PREVIEW_DRAWER_LAYOUT_EVENT, {
            detail: {
              id: 'preview',
              open: true,
              width: 760,
              expanded: false,
            },
          }),
        );
      });

      expect((dock as HTMLElement).style.getPropertyValue(
        '--ugs-chat-visible-right-inset',
      )).toBe('360px');

      const inputSection = view.container.querySelector<HTMLElement>(
        '[aria-label^="AI 输入"]',
      );
      expect(inputSection?.style.maxWidth).toBe(
        'min(72rem, calc(100% - var(--ugs-chat-visible-right-inset)))',
      );
      expect(inputSection?.style.transform).toBe(
        'translateX(calc(var(--ugs-chat-visible-right-inset) / -2))',
      );
    } finally {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: originalInnerWidth,
      });
      await view.cleanup();
    }
  });

  it('opens the inline organization tree menu when typing $ (not the popup)', async () => {
    resetChatSession('s_org_dollar', chatMessages('org'));
    const view = await renderChatDock();

    try {
      const input = composerTextarea(view.container);
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )?.set;

      await act(async () => {
        if (setter) setter.call(input, '$');
        else input.value = '$';
        input.setSelectionRange(1, 1);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });

      // The inline tree menu is mounted; the full blueprint popup is not.
      const menu = view.container.querySelector('#ugs-org-mention-suggestions');
      expect(menu).toBeInstanceOf(HTMLElement);
      expect(menu?.textContent).toContain('制作人');
      // The `$` token stays in the draft as the active trigger.
      expect(input.value).toBe('$');
    } finally {
      await view.cleanup();
    }
  });

  it('also exposes organization roles through the slash menu', async () => {
    resetChatSession('s_org_slash', chatMessages('org'));
    const view = await renderChatDock();

    try {
      const input = composerTextarea(view.container);
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )?.set;

      await act(async () => {
        if (setter) setter.call(input, '/技术总监');
        else input.value = '/技术总监';
        input.setSelectionRange('/技术总监'.length, '/技术总监'.length);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });

      const menu = view.container.querySelector('#ugs-slash-suggestions');
      expect(menu).toBeInstanceOf(HTMLElement);
      expect(menu?.textContent).toContain('技术总监');

      const option = Array.from(
        view.container.querySelectorAll('[role="option"]'),
      ).find((item) => item.textContent?.includes('技术总监'));
      expect(option).toBeInstanceOf(HTMLElement);

      await act(async () => {
        option?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(input.value).toContain('/technical-director ');
    } finally {
      await view.cleanup();
    }
  });

  it('restores each session scroll instead of carrying the previous session position', async () => {
    resetChatSession('s1', chatMessages('s1'));
    const view = await renderChatDock();

    try {
      const stream = streamElement(view.container);
      setScrollMetrics(stream, { scrollHeight: 1000, clientHeight: 200 });

      await userScrollTo(stream, 320);
      await switchSession('s2', chatMessages('s2'));
      await userScrollTo(stream, 700);
      await switchSession('s1', chatMessages('s1'));

      expect(stream.scrollTop).toBe(320);
    } finally {
      await view.cleanup();
    }
  });

  it('keeps a bottom-pinned session following new content after switching back', async () => {
    resetChatSession('s1', chatMessages('s1'));
    const view = await renderChatDock();

    try {
      const stream = streamElement(view.container);
      setScrollMetrics(stream, { scrollHeight: 1000, clientHeight: 200 });

      await userScrollTo(stream, 800);
      await switchSession('s2', chatMessages('s2'));
      await userScrollTo(stream, 260);
      await switchSession('s1', chatMessages('s1'));

      expect(stream.scrollTop).toBe(1000);

      setScrollMetrics(stream, { scrollHeight: 1400, clientHeight: 200 });
      await triggerResizeObservers();

      expect(stream.scrollTop).toBe(1400);
    } finally {
      await view.cleanup();
    }
  });

  it('observes the inner list so appended content can drive auto-scroll', async () => {
    resetChatSession('s1', chatMessages('s1'));
    const view = await renderChatDock();

    try {
      const stream = streamElement(view.container);
      const list = stream.querySelector('ul');
      expect(list).not.toBeNull();
      // Both the scroll container and its inner list must be observed: the
      // container has a fixed height, so only the list grows when a message is
      // appended. Observing only the container would never fire on new content.
      const observed = ResizeObserverStub.instances.flatMap((instance) =>
        instance.observe.mock.calls.map((call) => call[0]),
      );
      expect(observed).toContain(stream);
      expect(observed).toContain(list);
    } finally {
      await view.cleanup();
    }
  });

  it('mounts only the latest message window when opening a long history', async () => {
    // Background idle growth (80ms timers) expands the window past the
    // initial 5 rows; freeze timers so the open-time assertions stay
    // deterministic. The progressive fill itself is covered by the
    // "fills the initial message window in background batches" test below.
    vi.useFakeTimers();
    resetChatSession('s_long', longChatMessages('long', 220));
    const view = await renderChatDock();

    try {
      const stream = streamElement(view.container);
      const rows = stream.querySelectorAll('[data-ugs-message-row="true"]');

      expect(rows.length).toBe(5);
      expect(stream.textContent).toContain('long message 219');
      expect(stream.textContent).not.toContain('long message 0');
      expect(
        stream.querySelector('[data-ugs-load-earlier-messages="true"]'),
      ).toBeInstanceOf(HTMLButtonElement);

      await act(async () => {
        stream
          .querySelector<HTMLButtonElement>(
            '[data-ugs-load-earlier-messages="true"]',
          )
          ?.click();
      });
      expect(
        stream.querySelectorAll('[data-ugs-message-row="true"]').length,
      ).toBe(85);

      await switchSession('s_other_long', longChatMessages('other', 220));
      expect(
        stream.querySelectorAll('[data-ugs-message-row="true"]').length,
      ).toBe(5);
      expect(stream.textContent).toContain('other message 219');
      expect(stream.textContent).not.toContain('other message 0');
    } finally {
      await view.cleanup();
      vi.useRealTimers();
    }
  });

  it('fills the initial message window in background batches', async () => {
    vi.useFakeTimers();
    resetChatSession('s_background_long', longChatMessages('background', 220));
    const view = await renderChatDock();

    try {
      const stream = streamElement(view.container);

      expect(
        stream.querySelectorAll('[data-ugs-message-row="true"]').length,
      ).toBe(5);

      for (const expected of [20, 35, 50, 65, 80]) {
        await act(async () => {
          vi.advanceTimersByTime(80);
        });
        expect(
          stream.querySelectorAll('[data-ugs-message-row="true"]').length,
        ).toBe(expected);
      }
    } finally {
      await view.cleanup();
      vi.useRealTimers();
    }
  });

  it('renders one timeline marker per user turn', async () => {
    resetChatSession('s_timeline', chatMessages('timeline'));
    const view = await renderChatDock();

    try {
      const markers = view.container.querySelectorAll<HTMLButtonElement>(
        '[data-ugs-timeline-marker="true"]',
      );

      expect(markers.length).toBe(4);
      expect(markers[0].getAttribute('aria-label')).toContain(
        '跳转到段落 1：timeline message 0',
      );
      expect(markers[3].getAttribute('aria-label')).toContain(
        '跳转到段落 4：timeline message 6',
      );
    } finally {
      await view.cleanup();
    }
  });

  it('loads hidden history before jumping from a timeline marker', async () => {
    resetChatSession('s_timeline_long', longChatMessages('timeline-long', 220));
    const view = await renderChatDock();
    const originalRaf = window.requestAnimationFrame;
    const originalScrollIntoView = window.HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();

    try {
      window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
        callback(0);
        return 0;
      }) as typeof window.requestAnimationFrame;
      window.HTMLElement.prototype.scrollIntoView = scrollIntoView;

      const stream = streamElement(view.container);
      expect(
        stream.querySelectorAll('[data-ugs-message-row="true"]').length,
      ).toBe(5);

      const firstMarker = view.container.querySelector<HTMLButtonElement>(
        '[data-ugs-timeline-marker="true"]',
      );
      expect(firstMarker).toBeInstanceOf(HTMLButtonElement);
      expect(firstMarker?.dataset.hidden).toBe('true');

      await act(async () => {
        firstMarker?.click();
      });

      expect(
        stream.querySelectorAll('[data-ugs-message-row="true"]').length,
      ).toBe(220);
      expect(scrollIntoView).toHaveBeenCalled();
    } finally {
      window.requestAnimationFrame = originalRaf;
      window.HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
      await view.cleanup();
    }
  });

  it('follows an appended message to the bottom while pinned', async () => {
    resetChatSession('s1', chatMessages('s1'));
    const view = await renderChatDock();

    try {
      const stream = streamElement(view.container);
      setScrollMetrics(stream, { scrollHeight: 1000, clientHeight: 200 });

      // User sits at the bottom, then a new message arrives and grows content.
      await userScrollTo(stream, 800);
      setScrollMetrics(stream, { scrollHeight: 1400, clientHeight: 200 });
      await appendMessage({
        id: 's1_new',
        role: 'assistant',
        text: 'fresh reply',
        createdAt: 99,
      } as Message);
      await triggerResizeObservers();

      expect(stream.scrollTop).toBe(1400);
    } finally {
      await view.cleanup();
    }
  });

  it('scrolls to a Ctrl+Enter user message even before resize observers fire', async () => {
    resetChatSession('s1', chatMessages('s1'));
    const originalSendPrompt = useStore.getState().sendPrompt;
    const view = await renderChatDock();

    try {
      const stream = streamElement(view.container);
      setScrollMetrics(stream, { scrollHeight: 1000, clientHeight: 200 });

      await userScrollTo(stream, 320);
      await act(async () => {
        useStore.setState({
          sendPrompt: vi.fn((text: string) => {
            setScrollMetrics(stream, { scrollHeight: 1400, clientHeight: 200 });
            useStore.setState((state) => ({
              messages: [
                ...state.messages,
                {
                  id: 's1_new_user',
                  role: 'user',
                  text,
                  createdAt: 99,
                } as Message,
              ],
            }));
            return true;
          }),
        });
      });
      await setDraft('fresh question');

      await pressCtrlEnter(composerTextarea(view.container));

      expect(useStore.getState().messages.at(-1)?.text).toBe('fresh question');
      expect(stream.scrollTop).toBe(1400);
    } finally {
      await act(async () => {
        useStore.setState({ sendPrompt: originalSendPrompt });
      });
      await view.cleanup();
    }
  });
});
