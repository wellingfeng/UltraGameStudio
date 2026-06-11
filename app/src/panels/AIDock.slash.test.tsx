import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AIDock from './AIDock';
import { defaultBlueprint } from '@/core/defaultBlueprint';
import { defaultComposer, samplePromptGroups } from '@/store/sampleSessions';
import { useStore } from '@/store/useStore';

const slashCatalogMock = vi.hoisted(() => ({
  entries: [
    {
      id: 'command:app:/deep-research',
      kind: 'command',
      name: '/deep-research',
      label: { 'zh-CN': '深度调研', 'en-US': 'Deep Research' },
      detail: {
        'zh-CN': '用 /ultracode 跑多源核验研究',
        'en-US': 'Run source-grounded research through /ultracode',
      },
      insertText: {
        'zh-CN':
          '执行 deep-research：使用随 FreeUltraCode 一起发布的内置 workflow 协议 workflows/deep-research/WORKFLOW.md 和 protocol/model-agnostic-deep-research.md。',
        'en-US':
          'Run deep research using the built-in FreeUltraCode workflow protocol workflows/deep-research/WORKFLOW.md and protocol/model-agnostic-deep-research.md.',
      },
      source: 'app',
      sourceAdapter: 'app',
    },
    {
      id: 'command:app:/review',
      kind: 'command',
      name: '/review',
      label: { 'zh-CN': '审查', 'en-US': 'Review' },
      detail: {
        'zh-CN': '按代码审查视角找风险',
        'en-US': 'Review for bugs and risks',
      },
      insertText: {
        'zh-CN':
          '按代码审查视角检查：优先列出 bug、回归风险和缺失测试，给出文件/位置和修复建议。',
        'en-US':
          'Review this as code: list bugs, regression risks, and missing tests first, with file/location references and fixes.',
      },
      source: 'app',
      sourceAdapter: 'app',
    },
    {
      id: 'command:claude-code:/status',
      kind: 'command',
      name: '/status',
      label: { 'zh-CN': 'Claude 状态', 'en-US': 'Claude Status' },
      detail: { 'zh-CN': 'Claude Code 状态', 'en-US': 'Claude Code status' },
      insertText: {
        'zh-CN': '按 Claude Code CLI 的 `/status` slash command 语义处理当前请求。',
        'en-US':
          'Use the `/status` slash-command semantics from Claude Code CLI for this request.',
      },
      source: 'claude-code',
      sourceAdapter: 'claude-code',
    },
    {
      id: 'command:codex:/status',
      kind: 'command',
      name: '/status',
      label: { 'zh-CN': 'Codex 状态', 'en-US': 'Codex Status' },
      detail: { 'zh-CN': 'Codex 状态', 'en-US': 'Codex status' },
      insertText: {
        'zh-CN': '按 Codex CLI 的 `/status` slash command 语义处理当前请求。',
        'en-US':
          'Use the `/status` slash-command semantics from Codex CLI for this request.',
      },
      source: 'codex',
      sourceAdapter: 'codex',
    },
    {
      id: 'command:gemini:/status',
      kind: 'command',
      name: '/status',
      label: { 'zh-CN': 'Gemini 状态', 'en-US': 'Gemini Status' },
      detail: { 'zh-CN': 'Gemini 状态', 'en-US': 'Gemini status' },
      insertText: {
        'zh-CN': '按 Gemini CLI 的 `/status` slash command 语义处理当前请求。',
        'en-US':
          'Use the `/status` slash-command semantics from Gemini CLI for this request.',
      },
      source: 'gemini',
      sourceAdapter: 'gemini',
    },
    {
      id: 'skill:ultracode',
      kind: 'skill',
      name: '/ultracode',
      label: { 'zh-CN': 'Ultracode', 'en-US': 'Ultracode' },
      detail: {
        'zh-CN': '动态 harness 入口',
        'en-US': 'Dynamic harness entrypoint',
      },
      insertText: {
        'zh-CN':
          '请按 /ultracode skill 的工作流处理当前请求。Skill 摘要：Dynamic workflow entrypoint',
        'en-US':
          'Use the /ultracode skill workflow for this request. Skill summary: Dynamic workflow entrypoint',
      },
      source: '.claude/skills/ultracode/SKILL.md',
      sourceAdapter: 'claude-code',
    },
  ],
}));

vi.mock('@/lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tauri')>();
  return {
    ...actual,
    tauriAvailable: () => true,
    slashCatalog: async () => ({
      scannedAtMs: 1,
      ready: true,
      entries: slashCatalogMock.entries,
    }),
    onSlashCatalogUpdated: async () => () => {},
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function resetStore(adapter: 'claude-code' | 'codex' | 'gemini' = 'claude-code'): void {
  const workflow = defaultBlueprint('Slash suggestions');
  useStore.setState({
    mode: 'design',
    workflow: {
      ...workflow,
      meta: {
        ...workflow.meta,
        adapter,
        gateway: {
          ...(workflow.meta.gateway ?? {}),
          defaults: {
            adapter,
            modelClass: 'default',
            systemDefault: true,
          },
        },
      },
    },
    selectedNodeId: null,
    aiStreaming: false,
    aiEditingSessions: [],
    chattingSessions: [],
    locale: 'zh-CN',
    promptGroups: samplePromptGroups,
    composer: defaultComposer,
    composerDraft: '',
    composerDrafts: {},
    composerFocusVersion: 0,
    messages: [],
    activeWorkspaceId: null,
    activeSessionId: 's_slash',
    workspaceHistory: [],
    runningSessionProgress: {},
  });
}

async function renderDock(): Promise<{
  container: HTMLDivElement;
  cleanup: () => Promise<void>;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(<AIDock />);
  });
  await act(async () => {
    await Promise.resolve();
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

function textarea(container: HTMLElement): HTMLTextAreaElement {
  const input = container.querySelector('textarea');
  if (!input) throw new Error('Missing AI input textarea');
  return input;
}

function typeTextarea(input: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
  input.setSelectionRange(value.length, value.length);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function flushAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

afterEach(() => {
  window.localStorage.clear();
  document.body.innerHTML = '';
});

describe('AIDock slash suggestions', () => {
  it('opens slash suggestions from the command button before mention', async () => {
    resetStore();
    const view = await renderDock();

    try {
      const input = textarea(view.container);
      const buttons = Array.from(
        view.container.querySelectorAll<HTMLButtonElement>('button'),
      );
      const commandButton = buttons.find(
        (button) => button.textContent?.trim() === '/命令',
      );
      const mentionButton = buttons.find(
        (button) => button.textContent?.trim() === '@提及',
      );

      expect(commandButton).toBeInstanceOf(HTMLButtonElement);
      expect(mentionButton).toBeInstanceOf(HTMLButtonElement);
      expect(
        commandButton!.compareDocumentPosition(mentionButton!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();

      await act(async () => {
        commandButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await flushAnimationFrame();
      });

      expect(input.value).toBe('/');
      expect(
        view.container.querySelector('#fuc-slash-suggestions'),
      ).toBeInstanceOf(HTMLElement);
      expect(view.container.textContent).toContain('/deep-research');
    } finally {
      await view.cleanup();
    }
  });

  it('keeps app-only commands like /image-mode-start when a backend catalog is present', async () => {
    resetStore();
    const view = await renderDock();

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(input, '/image-mode');
      });

      const image = Array.from(
        view.container.querySelectorAll('[role="option"]'),
      ).find((option) => option.textContent?.includes('/image-mode-start'));
      expect(image).toBeInstanceOf(HTMLElement);

      await act(async () => {
        image?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(input.value).toBe('/image-mode-start ');
    } finally {
      await view.cleanup();
    }
  });

  it('renders the flat segmented permission control in the input card', async () => {
    resetStore();
    useStore.setState({
      messages: [
        {
          id: 'm_user_context',
          role: 'user',
          text: '帮我检查这个登录流程',
          createdAt: 1,
        },
        {
          id: 'm_assistant_context',
          role: 'assistant',
          text: '⚙ 模型：sonnet\n可以，先看鉴权入口。',
          createdAt: 2,
        },
      ],
      composerDraft: '继续分析',
    });
    const view = await renderDock();

    try {
      const group = view.container.querySelector<HTMLElement>(
        '[role="radiogroup"]',
      );
      expect(group).toBeInstanceOf(HTMLElement);
      const radios = group?.querySelectorAll('[role="radio"]') ?? [];
      // One flat segment per permission option (full / readonly / ask).
      expect(radios.length).toBe(3);
      const checked = group?.querySelector('[role="radio"][aria-checked="true"]');
      expect(checked).toBeInstanceOf(HTMLElement);
    } finally {
      await view.cleanup();
    }
  });

  it('toggles sticky image mode via /image-mode-start and /image-mode-end', async () => {
    resetStore();
    const generateImagePrompt = vi.fn();
    const sendPrompt = vi.fn();
    useStore.setState({ generateImagePrompt, sendPrompt });
    const view = await renderDock();

    const submitEnter = (input: HTMLTextAreaElement) =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          ctrlKey: true,
          bubbles: true,
        }),
      );

    try {
      const input = textarea(view.container);

      // Enter image mode — no message is sent, the composer flag flips.
      await act(async () => {
        typeTextarea(input, '/image-mode-start');
        submitEnter(input);
      });
      expect(useStore.getState().composer.imageMode).toBe(true);
      expect(useStore.getState().composer.imageModeStartedAt).toBeGreaterThan(0);
      expect(generateImagePrompt).not.toHaveBeenCalled();
      expect(sendPrompt).not.toHaveBeenCalled();
      // A system note announcing image mode lands in the message stream.
      expect(
        useStore
          .getState()
          .messages.some(
            (m) => m.role === 'system' && m.text.includes('已进入生图模式'),
          ),
      ).toBe(true);

      // Bare text in image mode routes to image generation, not AI editing.
      await act(async () => {
        typeTextarea(input, '一只柴犬');
        submitEnter(input);
      });
      expect(generateImagePrompt).toHaveBeenCalledWith('一只柴犬');
      expect(sendPrompt).not.toHaveBeenCalled();

      // Explicit slash commands still win inside image mode.
      await act(async () => {
        typeTextarea(input, '/review 看看这段代码');
        submitEnter(input);
      });
      expect(sendPrompt).toHaveBeenCalledTimes(1);

      // Leaving image mode restores AI-editing routing for bare text.
      await act(async () => {
        typeTextarea(input, '/image-mode-end');
        submitEnter(input);
      });
      expect(useStore.getState().composer.imageMode).toBe(false);
      expect(useStore.getState().composer.imageModeStartedAt).toBeNull();
      // Exiting image mode is announced in the stream too.
      expect(
        useStore
          .getState()
          .messages.some(
            (m) => m.role === 'system' && m.text.includes('已退出生图模式'),
          ),
      ).toBe(true);

      await act(async () => {
        typeTextarea(input, '加一个登录节点');
        submitEnter(input);
      });
      expect(sendPrompt).toHaveBeenCalledWith(expect.stringContaining('加一个登录节点'));
      expect(generateImagePrompt).toHaveBeenCalledTimes(1);
    } finally {
      await view.cleanup();
    }
  });

  it('enters image mode and generates when text follows /image-mode-start', async () => {
    resetStore();
    const generateImagePrompt = vi.fn();
    const sendPrompt = vi.fn();
    useStore.setState({ generateImagePrompt, sendPrompt });
    const view = await renderDock();

    try {
      const input = textarea(view.container);

      // Picking the command from the menu and typing a prompt right after it
      // must still enter image mode AND generate — not fall through to AI editing.
      await act(async () => {
        typeTextarea(input, '/image-mode-start 一张赛博朋克海报');
        input.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            ctrlKey: true,
            bubbles: true,
          }),
        );
      });

      expect(useStore.getState().composer.imageMode).toBe(true);
      expect(useStore.getState().composer.imageModeStartedAt).toBeGreaterThan(0);
      expect(generateImagePrompt).toHaveBeenCalledWith('一张赛博朋克海报');
      expect(sendPrompt).not.toHaveBeenCalled();
      expect(input.value).toBe('');
    } finally {
      await view.cleanup();
    }
  });

  it('toggles sticky music mode via /music-mode-start and /music-mode-end', async () => {
    resetStore();
    const generateMusicPrompt = vi.fn();
    const sendPrompt = vi.fn();
    useStore.setState({ generateMusicPrompt, sendPrompt });
    const view = await renderDock();

    const submitEnter = (input: HTMLTextAreaElement) =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          ctrlKey: true,
          bubbles: true,
        }),
      );

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(input, '/music-mode-start');
        submitEnter(input);
      });
      expect(useStore.getState().composer.musicMode).toBe(true);
      expect(useStore.getState().composer.musicModeStartedAt).toBeGreaterThan(0);
      expect(useStore.getState().composer.imageMode).toBe(false);
      expect(generateMusicPrompt).not.toHaveBeenCalled();
      expect(sendPrompt).not.toHaveBeenCalled();
      expect(
        useStore
          .getState()
          .messages.some(
            (m) => m.role === 'system' && m.text.includes('已进入音乐模式'),
          ),
      ).toBe(true);

      await act(async () => {
        typeTextarea(input, '一段冷静的产品演示 BGM');
        submitEnter(input);
      });
      expect(generateMusicPrompt).toHaveBeenCalledWith('一段冷静的产品演示 BGM');
      expect(sendPrompt).not.toHaveBeenCalled();

      await act(async () => {
        typeTextarea(input, '/review 看看这段代码');
        submitEnter(input);
      });
      expect(sendPrompt).toHaveBeenCalledTimes(1);

      await act(async () => {
        typeTextarea(input, '/music-mode-end');
        submitEnter(input);
      });
      expect(useStore.getState().composer.musicMode).toBe(false);
      expect(useStore.getState().composer.musicModeStartedAt).toBeNull();
      expect(
        useStore
          .getState()
          .messages.some(
            (m) => m.role === 'system' && m.text.includes('已退出音乐模式'),
          ),
      ).toBe(true);

      await act(async () => {
        typeTextarea(input, '加一个登录节点');
        submitEnter(input);
      });
      expect(sendPrompt).toHaveBeenCalledWith(expect.stringContaining('加一个登录节点'));
      expect(generateMusicPrompt).toHaveBeenCalledTimes(1);
    } finally {
      await view.cleanup();
    }
  });

  it('enters music mode and generates when text follows /music-mode-start', async () => {
    resetStore();
    const generateMusicPrompt = vi.fn();
    const sendPrompt = vi.fn();
    useStore.setState({ generateMusicPrompt, sendPrompt });
    const view = await renderDock();

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(input, '/music-mode-start 一段赛博朋克片头曲');
        input.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            ctrlKey: true,
            bubbles: true,
          }),
        );
      });

      expect(useStore.getState().composer.musicMode).toBe(true);
      expect(useStore.getState().composer.musicModeStartedAt).toBeGreaterThan(0);
      expect(useStore.getState().composer.imageMode).toBe(false);
      expect(generateMusicPrompt).toHaveBeenCalledWith('一段赛博朋克片头曲');
      expect(sendPrompt).not.toHaveBeenCalled();
      expect(input.value).toBe('');
    } finally {
      await view.cleanup();
    }
  });

  it('toggles sticky 3D mode via /mesh-mode-start and /mesh-mode-end', async () => {
    resetStore();
    const generateThreeDPrompt = vi.fn();
    const sendPrompt = vi.fn();
    useStore.setState({ generateThreeDPrompt, sendPrompt });
    const view = await renderDock();

    const submitEnter = (input: HTMLTextAreaElement) =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          ctrlKey: true,
          bubbles: true,
        }),
      );

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(input, '/mesh-mode-start');
        submitEnter(input);
      });
      expect(useStore.getState().composer.threeDMode).toBe(true);
      expect(useStore.getState().composer.threeDModeStartedAt).toBeGreaterThan(0);
      expect(useStore.getState().composer.imageMode).toBe(false);
      expect(useStore.getState().composer.musicMode).toBe(false);
      expect(generateThreeDPrompt).not.toHaveBeenCalled();
      expect(sendPrompt).not.toHaveBeenCalled();
      expect(
        useStore
          .getState()
          .messages.some(
            (m) => m.role === 'system' && m.text.includes('已进入 Mesh 模式'),
          ),
      ).toBe(true);

      await act(async () => {
        typeTextarea(input, '一个低多边形宝箱');
        submitEnter(input);
      });
      expect(generateThreeDPrompt).toHaveBeenCalledWith('一个低多边形宝箱');
      expect(sendPrompt).not.toHaveBeenCalled();

      await act(async () => {
        typeTextarea(input, '/review 看看这段代码');
        submitEnter(input);
      });
      expect(sendPrompt).toHaveBeenCalledTimes(1);

      await act(async () => {
        typeTextarea(input, '/mesh-mode-end');
        submitEnter(input);
      });
      expect(useStore.getState().composer.threeDMode).toBe(false);
      expect(useStore.getState().composer.threeDModeStartedAt).toBeNull();
      expect(
        useStore
          .getState()
          .messages.some(
            (m) => m.role === 'system' && m.text.includes('已退出 Mesh 模式'),
          ),
      ).toBe(true);

      await act(async () => {
        typeTextarea(input, '加一个登录节点');
        submitEnter(input);
      });
      expect(sendPrompt).toHaveBeenCalledWith(expect.stringContaining('加一个登录节点'));
      expect(generateThreeDPrompt).toHaveBeenCalledTimes(1);
    } finally {
      await view.cleanup();
    }
  });

  it('enters 3D mode and generates when text follows /mesh-mode-start', async () => {
    resetStore();
    const generateThreeDPrompt = vi.fn();
    const sendPrompt = vi.fn();
    useStore.setState({ generateThreeDPrompt, sendPrompt });
    const view = await renderDock();

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(input, '/mesh-mode-start 一个赛博朋克机械臂');
        input.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            ctrlKey: true,
            bubbles: true,
          }),
        );
      });

      expect(useStore.getState().composer.threeDMode).toBe(true);
      expect(useStore.getState().composer.threeDModeStartedAt).toBeGreaterThan(0);
      expect(useStore.getState().composer.imageMode).toBe(false);
      expect(useStore.getState().composer.musicMode).toBe(false);
      expect(generateThreeDPrompt).toHaveBeenCalledWith('一个赛博朋克机械臂');
      expect(sendPrompt).not.toHaveBeenCalled();
      expect(input.value).toBe('');
    } finally {
      await view.cleanup();
    }
  });

  it('switches the bottom channel/model selectors to image providers in image mode', async () => {
    resetStore();
    useStore.setState({ composer: { ...defaultComposer, imageMode: true } });
    const view = await renderDock();

    try {
      // The channel selector trigger should show an image provider, not a
      // coding adapter/free channel.
      const channelTrigger = Array.from(
        view.container.querySelectorAll<HTMLButtonElement>('button[title]'),
      ).find((btn) => btn.getAttribute('title') === '渠道');
      expect(channelTrigger).toBeInstanceOf(HTMLButtonElement);

      await act(async () => {
        channelTrigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      // Image provider labels (e.g. 硅基流动) appear; coding channels do not.
      const menuText =
        channelTrigger?.parentElement?.querySelector('[role="listbox"]')
          ?.textContent ?? '';
      expect(menuText).toContain('硅基流动');

      // Selecting an image provider writes the image settings store, leaving the
      // coding runSelection untouched.
      const volcengine = Array.from(
        view.container.querySelectorAll<HTMLElement>('[role="option"]'),
      ).find((opt) => opt.textContent?.includes('火山方舟'));
      expect(volcengine).toBeInstanceOf(HTMLElement);
      await act(async () => {
        volcengine?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      const saved = JSON.parse(
        window.localStorage.getItem('freeultracode.imageGeneration.v1') ?? '{}',
      );
      expect(saved.preferredProviderId).toBe('volcengine-seedream');
    } finally {
      await view.cleanup();
    }
  });

  it('switches the bottom channel/model selectors to music providers in music mode', async () => {
    resetStore();
    useStore.setState({ composer: { ...defaultComposer, musicMode: true } });
    const view = await renderDock();

    try {
      const channelTrigger = Array.from(
        view.container.querySelectorAll<HTMLButtonElement>('button[title]'),
      ).find((btn) => btn.getAttribute('title') === '渠道');
      expect(channelTrigger).toBeInstanceOf(HTMLButtonElement);

      await act(async () => {
        channelTrigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      const menuText =
        channelTrigger?.parentElement?.querySelector('[role="listbox"]')
          ?.textContent ?? '';
      expect(menuText).toContain('ElevenLabs Music');
      expect(menuText).toContain('Hugging Face MusicGen');

      const huggingFace = Array.from(
        view.container.querySelectorAll<HTMLElement>('[role="option"]'),
      ).find((opt) => opt.textContent?.includes('Hugging Face MusicGen'));
      expect(huggingFace).toBeInstanceOf(HTMLElement);
      await act(async () => {
        huggingFace?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      const saved = JSON.parse(
        window.localStorage.getItem('freeultracode.musicGeneration.v1') ?? '{}',
      );
      expect(saved.preferredProviderId).toBe('huggingface-musicgen');
    } finally {
      await view.cleanup();
    }
  });

  it('switches the bottom channel/model selectors to 3D providers in 3D mode', async () => {
    resetStore();
    useStore.setState({ composer: { ...defaultComposer, threeDMode: true } });
    const view = await renderDock();

    try {
      const channelTrigger = Array.from(
        view.container.querySelectorAll<HTMLButtonElement>('button[title]'),
      ).find((btn) => btn.getAttribute('title') === '渠道');
      expect(channelTrigger).toBeInstanceOf(HTMLButtonElement);

      await act(async () => {
        channelTrigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      const menuText =
        channelTrigger?.parentElement?.querySelector('[role="listbox"]')
          ?.textContent ?? '';
      expect(menuText).toContain('Meshy');
      expect(menuText).toContain('Local Hunyuan3D');

      const localHunyuan = Array.from(
        view.container.querySelectorAll<HTMLElement>('[role="option"]'),
      ).find((opt) => opt.textContent?.includes('Local Hunyuan3D'));
      expect(localHunyuan).toBeInstanceOf(HTMLElement);
      await act(async () => {
        localHunyuan?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      const saved = JSON.parse(
        window.localStorage.getItem('freeultracode.threeDGeneration.v1') ?? '{}',
      );
      expect(saved.preferredProviderId).toBe('local-hunyuan3d');
    } finally {
      await view.cleanup();
    }
  });

  it('shows command suggestions after slash and inserts only the slash token', async () => {
    resetStore();
    const view = await renderDock();

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(input, '/rev');
      });

      const review = Array.from(
        view.container.querySelectorAll('[role="option"]'),
      ).find((option) => option.textContent?.includes('/review'));
      expect(review).toBeInstanceOf(HTMLElement);
      expect(
        view.container
          .querySelector('[role="listbox"]')
          ?.closest('.fuc-ai-input-card'),
      ).toBeNull();

      await act(async () => {
        review?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(input.value).toBe('/review ');
      expect(input.value).not.toBe('/rev');
      expect(input.value).not.toContain('按代码审查视角检查');
    } finally {
      await view.cleanup();
    }
  });

  it('expands ordinary slash commands only when submitting', async () => {
    resetStore();
    const sendPrompt = vi.fn();
    const runUltracodePrompt = vi.fn();
    useStore.setState({ sendPrompt, runUltracodePrompt });
    const view = await renderDock();

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(input, '/review 检查 README');
        input.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            ctrlKey: true,
            bubbles: true,
          }),
        );
      });

      expect(sendPrompt).toHaveBeenCalledWith(
        expect.stringContaining('按代码审查视角检查'),
      );
      expect(sendPrompt).toHaveBeenCalledWith(
        expect.stringContaining('请求：\n检查 README'),
      );
      expect(runUltracodePrompt).not.toHaveBeenCalled();
      expect(input.value).toBe('');
    } finally {
      await view.cleanup();
    }
  });

  it('scopes CLI slash commands to the selected adapter', async () => {
    resetStore('codex');
    const view = await renderDock();

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(input, '/sta');
      });

      const menuText =
        view.container.querySelector('[role="listbox"]')?.textContent ?? '';
      expect(menuText).toContain('Codex 状态');
      expect(menuText).not.toContain('Claude 状态');
      expect(menuText).not.toContain('Gemini 状态');
    } finally {
      await view.cleanup();
    }
  });

  it('uses high-contrast styling for the active slash suggestion', async () => {
    resetStore();
    const view = await renderDock();

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(input, '/');
      });

      const options = () =>
        Array.from(view.container.querySelectorAll<HTMLElement>('[role="option"]'));
      const activeOption = () =>
        options().find((option) => option.getAttribute('aria-selected') === 'true');

      expect(options().length).toBeGreaterThan(1);
      expect(activeOption()?.className).toContain('border-l-accent');
      expect(activeOption()?.className).toContain('bg-accent/20');
      expect(activeOption()?.className).toContain('ring-accent/40');
      expect(activeOption()?.querySelector('span')?.className).toContain(
        'bg-accent',
      );

      await act(async () => {
        input.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
        );
      });

      expect(options()[0]?.className).toContain('border-l-transparent');
      expect(activeOption()).toBe(options()[1]);
      expect(activeOption()?.className).toContain('border-l-accent');
    } finally {
      await view.cleanup();
    }
  });

  it('keeps /ultracode as a literal command when selected', async () => {
    resetStore();
    const view = await renderDock();

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(input, '/ult');
      });

      const ultracode = Array.from(
        view.container.querySelectorAll('[role="option"]'),
      ).find((option) => option.textContent?.includes('/ultracode'));
      expect(ultracode).toBeInstanceOf(HTMLElement);

      await act(async () => {
        ultracode?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(input.value).toBe('/ultracode ');
      expect(input.value).not.toContain('请按 /ultracode skill');
    } finally {
      await view.cleanup();
    }
  });

  it('routes submitted /ultracode commands to the dynamic entrypoint', async () => {
    resetStore();
    const sendPrompt = vi.fn();
    const runUltracodePrompt = vi.fn();
    useStore.setState({ sendPrompt, runUltracodePrompt });
    const view = await renderDock();

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(input, '/ultracode 完成 100 题');
        input.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            ctrlKey: true,
            bubbles: true,
          }),
        );
      });

      expect(runUltracodePrompt).toHaveBeenCalledWith('完成 100 题');
      expect(sendPrompt).not.toHaveBeenCalled();
      expect(input.value).toBe('');
    } finally {
      await view.cleanup();
    }
  });

  it('routes submitted /deep-research commands through ultracode', async () => {
    resetStore();
    const sendPrompt = vi.fn();
    const runUltracodePrompt = vi.fn();
    useStore.setState({ sendPrompt, runUltracodePrompt });
    const view = await renderDock();

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(input, '/deep-research 调研 Claude Code deep research');
        input.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            ctrlKey: true,
            bubbles: true,
          }),
        );
      });

      expect(runUltracodePrompt).toHaveBeenCalledWith(
        expect.stringContaining('执行 deep-research'),
      );
      expect(runUltracodePrompt).toHaveBeenCalledWith(
        expect.stringContaining('研究问题：\n调研 Claude Code deep research'),
      );
      expect(sendPrompt).not.toHaveBeenCalled();
      expect(input.value).toBe('');
    } finally {
      await view.cleanup();
    }
  });
});
