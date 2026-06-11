import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AIDock from './AIDock';
import { simpleBlueprint } from '@/core/defaultBlueprint';
import { defaultComposer, samplePromptGroups } from '@/store/sampleSessions';
import type { Message } from '@/store/types';
import { useStore } from '@/store/useStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];

  constructor(private readonly callback: ResizeObserverCallback) {
    ResizeObserverStub.instances.push(this);
  }

  observe = vi.fn();
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
  const el = container.querySelector('.fuc-ai-return-stream');
  if (!(el instanceof HTMLElement)) throw new Error('Missing AI return stream');
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

describe('AIDock stream scroll state', () => {
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
});
