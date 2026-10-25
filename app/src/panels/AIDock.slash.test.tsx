import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import AIDock from "./AIDock";
import { defaultBlueprint } from "@/core/defaultBlueprint";
import { defaultComposer, samplePromptGroups } from "@/store/sampleSessions";
import { useStore } from "@/store/useStore";
import { blueprintModeInstall, blueprintModeStatus } from "@/lib/tauri";
import {
  DEFAULT_IMAGE_GENERATION_SETTINGS,
  saveImageGenerationSettings,
} from "@/lib/imageGeneration";
import {
  DEFAULT_MUSIC_GENERATION_SETTINGS,
  saveMusicGenerationSettings,
} from "@/lib/musicGeneration";
import {
  DEFAULT_THREE_D_GENERATION_SETTINGS,
  saveThreeDGenerationSettings,
} from "@/lib/threeDGeneration";
import {
  DEFAULT_UI_DESIGN_CHANNEL_SETTINGS,
  saveUiDesignChannelSettings,
} from "@/lib/uiDesignChannels";
import {
  REMOTE_WORKSPACE_SKILLS_STORAGE_KEY,
  remoteWorkspacePath,
  saveRemoteWorkspace,
} from "@/lib/remoteWorkspace";
import { upsertProviders } from "@/lib/apiConfig";
import { CLOUD_PROJECTS_ENABLED } from "@/lib/cloudProjects";

const slashCatalogMock = vi.hoisted(() => ({
  entries: [
    {
      id: "command:app:/review",
      kind: "command",
      name: "/review",
      label: { "zh-CN": "审查", "en-US": "Review" },
      detail: {
        "zh-CN": "按代码审查视角找风险",
        "en-US": "Review for bugs and risks",
      },
      insertText: {
        "zh-CN":
          "按代码审查视角检查：优先列出 bug、回归风险和缺失测试，给出文件/位置和修复建议。",
        "en-US":
          "Review this as code: list bugs, regression risks, and missing tests first, with file/location references and fixes.",
      },
      source: "app",
      sourceAdapter: "app",
    },
    {
      id: "command:claude-code:/status",
      kind: "command",
      name: "/status",
      label: { "zh-CN": "Claude 状态", "en-US": "Claude Status" },
      detail: { "zh-CN": "Claude Code 状态", "en-US": "Claude Code status" },
      insertText: {
        "zh-CN":
          "按 Claude Code CLI 的 `/status` slash command 语义处理当前请求。",
        "en-US":
          "Use the `/status` slash-command semantics from Claude Code CLI for this request.",
      },
      source: "claude-code",
      sourceAdapter: "claude-code",
    },
    {
      id: "command:codex:/status",
      kind: "command",
      name: "/status",
      label: { "zh-CN": "Codex 状态", "en-US": "Codex Status" },
      detail: { "zh-CN": "Codex 状态", "en-US": "Codex status" },
      insertText: {
        "zh-CN": "按 Codex CLI 的 `/status` slash command 语义处理当前请求。",
        "en-US":
          "Use the `/status` slash-command semantics from Codex CLI for this request.",
      },
      source: "codex",
      sourceAdapter: "codex",
    },
    {
      id: "command:gemini:/status",
      kind: "command",
      name: "/status",
      label: { "zh-CN": "Gemini 状态", "en-US": "Gemini Status" },
      detail: { "zh-CN": "Gemini 状态", "en-US": "Gemini status" },
      insertText: {
        "zh-CN": "按 Gemini CLI 的 `/status` slash command 语义处理当前请求。",
        "en-US":
          "Use the `/status` slash-command semantics from Gemini CLI for this request.",
      },
      source: "gemini",
      sourceAdapter: "gemini",
    },
    {
      id: "skill:studio",
      kind: "skill",
      name: "/studio",
      label: { "zh-CN": "Studio", "en-US": "Studio" },
      detail: {
        "zh-CN": "动态 harness 入口",
        "en-US": "Dynamic harness entrypoint",
      },
      insertText: {
        "zh-CN":
          "请按 /studio skill 的工作流处理当前请求。Skill 摘要：Dynamic workflow entrypoint",
        "en-US":
          "Use the /studio skill workflow for this request. Skill summary: Dynamic workflow entrypoint",
      },
      source: ".claude/skills/studio/SKILL.md",
      sourceAdapter: "claude-code",
    },
    {
      id: "skill:deep-research",
      kind: "skill",
      name: "/deep-research",
      label: { "zh-CN": "Deep Research", "en-US": "Deep Research" },
      detail: {
        "zh-CN": "旧内置研究 Skill",
        "en-US": "Old built-in research Skill",
      },
      insertText: {
        "zh-CN": "请按 /deep-research skill 处理当前请求。",
        "en-US": "Use the /deep-research skill for this request.",
      },
      source: ".claude/skills/deep-research/SKILL.md",
      sourceAdapter: "claude-code",
    },
  ],
}));

const blueprintModeStatusMock = vi.hoisted(() => vi.fn());
const blueprintModeInstallMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    tauriAvailable: () => true,
    slashCatalog: async () => ({
      scannedAtMs: 1,
      ready: true,
      entries: slashCatalogMock.entries,
    }),
    blueprintModeStatus: blueprintModeStatusMock,
    blueprintModeInstall: blueprintModeInstallMock,
    onSlashCatalogUpdated: async () => () => {},
  };
});

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function resetStore(
  adapter: "claude-code" | "codex" | "gemini" = "claude-code",
): void {
  saveImageGenerationSettings({
    ...DEFAULT_IMAGE_GENERATION_SETTINGS,
    preferredProviderId: "siliconflow",
    providerKeys: { siliconflow: "sk-test" },
  });
  saveMusicGenerationSettings({
    ...DEFAULT_MUSIC_GENERATION_SETTINGS,
    preferredProviderId: "elevenlabs-music",
    providerKeys: { "elevenlabs-music": "sk-test" },
  });
  saveThreeDGenerationSettings({
    ...DEFAULT_THREE_D_GENERATION_SETTINGS,
    enabled: true,
    preferredProviderId: "meshy",
    providerKeys: { meshy: "sk-test" },
  });
  saveUiDesignChannelSettings({
    ...DEFAULT_UI_DESIGN_CHANNEL_SETTINGS,
    enabled: true,
    preferredChannelId: "pencil",
  });
  vi.mocked(blueprintModeStatus).mockResolvedValue({
    ok: true,
    sourceUrl: "https://example.test/BlueprintMode.zip",
    targetDir: "E:\\Game\\Demo\\Plugins\\BlueprintMode",
    exists: true,
    installed: true,
    upluginPath:
      "E:\\Game\\Demo\\Plugins\\BlueprintMode\\BlueprintMode.uplugin",
    versionName: "test",
    notes: ["已检测到 BlueprintMode 插件。"],
    warnings: [],
    error: null,
  });
  vi.mocked(blueprintModeInstall).mockResolvedValue({
    ok: true,
    sourceUrl: "https://example.test/BlueprintMode.zip",
    targetDir: "E:\\Game\\Demo\\Plugins\\BlueprintMode",
    filesCopied: 3,
    replacedExisting: false,
    notes: ["已安装 BlueprintMode 插件。"],
    warnings: [],
    error: null,
  });
  const workflow = defaultBlueprint("Slash suggestions");
  useStore.setState({
    mode: "design",
    workflow: {
      ...workflow,
      meta: {
        ...workflow.meta,
        adapter,
        gateway: {
          ...(workflow.meta.gateway ?? {}),
          defaults: {
            adapter,
            modelClass: "default",
            systemDefault: true,
          },
        },
      },
    },
    selectedNodeId: null,
    aiStreaming: false,
    aiEditingSessions: [],
    chattingSessions: [],
    locale: "zh-CN",
    // 该用例比较 `/命令` 与 `@提及` 的先后顺序，需要把默认隐藏的三个进阶
    // 入口按钮打开（见 useStore.composerToolButtonsVisible）。
    composerToolButtonsVisible: true,
    composerHintRowVisible: true,
    promptGroups: samplePromptGroups,
    composer: defaultComposer,
    composerDraft: "",
    composerDrafts: {},
    composerFocusVersion: 0,
    messages: [],
    activeWorkspaceId: null,
    activeSessionId: "s_slash",
    workspaceHistory: [],
    runningSessionProgress: {},
  });
}

async function renderDock(): Promise<{
  container: HTMLDivElement;
  cleanup: () => Promise<void>;
}> {
  const container = document.createElement("div");
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
  const input = container.querySelector("textarea");
  if (!input) throw new Error("Missing AI input textarea");
  return input;
}

function typeTextarea(input: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
  input.setSelectionRange(value.length, value.length);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function flushAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

async function flushAsyncWork(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  window.localStorage.clear();
  document.body.innerHTML = "";
});

describe("AIDock slash suggestions", () => {
  it("opens slash suggestions from the command button before mention", async () => {
    resetStore();
    const view = await renderDock();

    try {
      const input = textarea(view.container);
      const buttons = Array.from(
        view.container.querySelectorAll<HTMLButtonElement>("button"),
      );
      const commandButton = buttons.find(
        (button) => button.textContent?.trim() === "/命令",
      );
      const mentionButton = buttons.find(
        (button) => button.textContent?.trim() === "@提及",
      );

      expect(commandButton).toBeInstanceOf(HTMLButtonElement);
      expect(mentionButton).toBeInstanceOf(HTMLButtonElement);
      expect(
        commandButton!.compareDocumentPosition(mentionButton!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();

      await act(async () => {
        commandButton!.dispatchEvent(
          new MouseEvent("click", { bubbles: true }),
        );
        await flushAnimationFrame();
      });

      expect(input.value).toBe("/");
      expect(
        view.container.querySelector("#ugs-slash-suggestions"),
      ).toBeInstanceOf(HTMLElement);
      expect(view.container.textContent).not.toContain("/deep-research");
    } finally {
      await view.cleanup();
    }
  });

  it("keeps app-only commands like /image-mode-start in the # game-skill menu", async () => {
    resetStore();
    const view = await renderDock();

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(input, "#image-mode");
      });

      const image = Array.from(
        view.container.querySelectorAll('[role="option"]'),
      ).find((option) => option.textContent?.includes("/image-mode-start"));
      expect(image).toBeInstanceOf(HTMLElement);

      await act(async () => {
        image?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(input.value).toBe("/image-mode-start ");

      await act(async () => {
        typeTextarea(input, "#blueprint-mode");
      });

      const blueprint = Array.from(
        view.container.querySelectorAll('[role="option"]'),
      ).find((option) => option.textContent?.includes("/blueprint-mode-start"));
      expect(blueprint).toBeInstanceOf(HTMLElement);
    } finally {
      await view.cleanup();
    }
  });

  it("shows the image-to-game command in the # game-skill menu", async () => {
    resetStore();
    const view = await renderDock();

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(input, "#image-to");
      });

      const imageToGame = Array.from(
        view.container.querySelectorAll('[role="option"]'),
      ).find((option) => option.textContent?.includes("/image-to-game"));
      expect(imageToGame).toBeInstanceOf(HTMLElement);
    } finally {
      await view.cleanup();
    }
  });

  it("keeps the game-skill menu independent of a long adapter catalog", async () => {
    const originalEntries = slashCatalogMock.entries;
    slashCatalogMock.entries = Array.from({ length: 14 }, (_, index) => ({
      id: `command:codex:/codex-${index}`,
      kind: "command",
      name: `/codex-${index}`,
      label: {
        "zh-CN": `Codex 命令 ${index}`,
        "en-US": `Codex Command ${index}`,
      },
      detail: {
        "zh-CN": "Codex CLI 命令",
        "en-US": "Codex CLI command",
      },
      insertText: {
        "zh-CN": `/codex-${index}`,
        "en-US": `/codex-${index}`,
      },
      source: "codex",
      sourceAdapter: "codex",
    }));
    resetStore("codex");
    const view = await renderDock();

    try {
      const input = textarea(view.container);

      // The `/` menu is the global surface: CLI catalog plus app GameSkills.
      await act(async () => {
        typeTextarea(input, "/");
      });
      const slashMenu = view.container.querySelector("#ugs-slash-suggestions");
      const slashText = slashMenu?.textContent ?? "";
      expect(slashText).toContain("/codex-13");
      expect(slashText).toContain("/image-mode-start");

      // The `#` menu remains a narrower GameSkill-only fast path regardless of
      // the adapter catalog.
      await act(async () => {
        typeTextarea(input, "#image-mode");
      });
      const gameMenu = view.container.querySelector(
        "#ugs-game-skill-suggestions",
      );
      expect(gameMenu?.textContent ?? "").toContain("/image-mode-start");
    } finally {
      slashCatalogMock.entries = originalEntries;
      await view.cleanup();
    }
  });

  it("also exposes game skills from the slash menu", async () => {
    resetStore();
    const view = await renderDock();

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(input, "/image-mode");
      });

      const imageModeStart = Array.from(
        view.container.querySelectorAll('[role="option"]'),
      ).find((option) => option.textContent?.includes("/image-mode-start"));
      expect(imageModeStart).toBeInstanceOf(HTMLElement);

      await act(async () => {
        imageModeStart?.dispatchEvent(
          new MouseEvent("click", { bubbles: true }),
        );
      });

      expect(input.value).toBe("/image-mode-start ");
    } finally {
      await view.cleanup();
    }
  });

  it("renders the flat segmented permission control in the input card", async () => {
    resetStore();
    useStore.setState({
      messages: [
        {
          id: "m_user_context",
          role: "user",
          text: "帮我检查这个登录流程",
          createdAt: 1,
        },
        {
          id: "m_assistant_context",
          role: "assistant",
          text: "⚙ 模型：sonnet\n可以，先看鉴权入口。",
          createdAt: 2,
        },
      ],
      composerDraft: "继续分析",
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
      const checked = group?.querySelector(
        '[role="radio"][aria-checked="true"]',
      );
      expect(checked).toBeInstanceOf(HTMLElement);
    } finally {
      await view.cleanup();
    }
  });

  it("toggles sticky image mode via /image-mode-start and /image-mode-end", async () => {
    resetStore();
    const generateImagePrompt = vi.fn();
    const sendPrompt = vi.fn(() => true);
    useStore.setState({ generateImagePrompt, sendPrompt });
    const view = await renderDock();

    const submitEnter = (input: HTMLTextAreaElement) =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          ctrlKey: true,
          bubbles: true,
        }),
      );

    try {
      const input = textarea(view.container);

      // Enter image mode — no message is sent, the composer flag flips.
      await act(async () => {
        typeTextarea(input, "/image-mode-start");
        submitEnter(input);
      });
      expect(useStore.getState().composer.imageMode).toBe(true);
      expect(useStore.getState().composer.imageModeStartedAt).toBeGreaterThan(
        0,
      );
      expect(generateImagePrompt).not.toHaveBeenCalled();
      expect(sendPrompt).not.toHaveBeenCalled();
      // A system note announcing image mode lands in the message stream.
      expect(
        useStore
          .getState()
          .messages.some(
            (m) => m.role === "system" && m.text.includes("已进入生图模式"),
          ),
      ).toBe(true);

      // Bare text in image mode routes to image generation, not AI editing.
      await act(async () => {
        typeTextarea(input, "一只柴犬");
        submitEnter(input);
      });
      expect(generateImagePrompt).toHaveBeenCalledWith("一只柴犬");
      expect(sendPrompt).not.toHaveBeenCalled();

      // Explicit slash commands still win inside image mode.
      await act(async () => {
        typeTextarea(input, "/review 看看这段代码");
        submitEnter(input);
      });
      expect(sendPrompt).toHaveBeenCalledTimes(1);

      // Leaving image mode restores AI-editing routing for bare text.
      await act(async () => {
        typeTextarea(input, "/image-mode-end");
        submitEnter(input);
      });
      expect(useStore.getState().composer.imageMode).toBe(false);
      expect(useStore.getState().composer.imageModeStartedAt).toBeNull();
      // Exiting image mode is announced in the stream too.
      expect(
        useStore
          .getState()
          .messages.some(
            (m) => m.role === "system" && m.text.includes("已退出生图模式"),
          ),
      ).toBe(true);

      await act(async () => {
        typeTextarea(input, "加一个登录节点");
        submitEnter(input);
      });
      expect(sendPrompt).toHaveBeenCalledWith(
        expect.stringContaining("加一个登录节点"),
      );
      expect(generateImagePrompt).toHaveBeenCalledTimes(1);
    } finally {
      await view.cleanup();
    }
  });

  it("enters image mode and generates when text follows /image-mode-start", async () => {
    resetStore();
    const generateImagePrompt = vi.fn();
    const sendPrompt = vi.fn(() => true);
    useStore.setState({ generateImagePrompt, sendPrompt });
    const view = await renderDock();

    try {
      const input = textarea(view.container);

      // Picking the command from the menu and typing a prompt right after it
      // must still enter image mode AND generate — not fall through to AI editing.
      await act(async () => {
        typeTextarea(input, "/image-mode-start 一张赛博朋克海报");
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            ctrlKey: true,
            bubbles: true,
          }),
        );
      });

      expect(useStore.getState().composer.imageMode).toBe(true);
      expect(useStore.getState().composer.imageModeStartedAt).toBeGreaterThan(
        0,
      );
      expect(generateImagePrompt).toHaveBeenCalledWith("一张赛博朋克海报");
      expect(sendPrompt).not.toHaveBeenCalled();
      expect(input.value).toBe("");
    } finally {
      await view.cleanup();
    }
  });

  it("warns and blocks image commands when the selected image provider is not ready", async () => {
    resetStore();
    saveImageGenerationSettings({
      ...DEFAULT_IMAGE_GENERATION_SETTINGS,
      preferredProviderId: "openai-image",
      providerKeys: {},
    });
    const generateImagePrompt = vi.fn();
    const sendPrompt = vi.fn(() => true);
    useStore.setState({ generateImagePrompt, sendPrompt });
    const view = await renderDock();

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(input, "/image 画一张猫");
      });

      const tip = view.container.querySelector(
        '[data-testid="blocked-send-tip"]',
      );
      expect(tip?.textContent).toContain("设置 > 生图");
      expect(tip?.textContent).toContain("OpenAI Images");

      await act(async () => {
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            ctrlKey: true,
            bubbles: true,
          }),
        );
      });

      expect(generateImagePrompt).not.toHaveBeenCalled();
      expect(sendPrompt).not.toHaveBeenCalled();
      expect(input.value).toBe("/image 画一张猫");
    } finally {
      await view.cleanup();
    }
  });

  it("toggles sticky music mode via /music-mode-start and /music-mode-end", async () => {
    resetStore();
    const generateMusicPrompt = vi.fn();
    const sendPrompt = vi.fn(() => true);
    useStore.setState({ generateMusicPrompt, sendPrompt });
    const view = await renderDock();

    const submitEnter = (input: HTMLTextAreaElement) =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          ctrlKey: true,
          bubbles: true,
        }),
      );

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(input, "/music-mode-start");
        submitEnter(input);
      });
      expect(useStore.getState().composer.musicMode).toBe(true);
      expect(useStore.getState().composer.musicModeStartedAt).toBeGreaterThan(
        0,
      );
      expect(useStore.getState().composer.imageMode).toBe(false);
      expect(generateMusicPrompt).not.toHaveBeenCalled();
      expect(sendPrompt).not.toHaveBeenCalled();
      expect(
        useStore
          .getState()
          .messages.some(
            (m) => m.role === "system" && m.text.includes("已进入音乐模式"),
          ),
      ).toBe(true);

      await act(async () => {
        typeTextarea(input, "一段冷静的产品演示 BGM");
        submitEnter(input);
      });
      expect(generateMusicPrompt).toHaveBeenCalledWith(
        "一段冷静的产品演示 BGM",
      );
      expect(sendPrompt).not.toHaveBeenCalled();

      await act(async () => {
        typeTextarea(input, "/review 看看这段代码");
        submitEnter(input);
      });
      expect(sendPrompt).toHaveBeenCalledTimes(1);

      await act(async () => {
        typeTextarea(input, "/music-mode-end");
        submitEnter(input);
      });
      expect(useStore.getState().composer.musicMode).toBe(false);
      expect(useStore.getState().composer.musicModeStartedAt).toBeNull();
      expect(
        useStore
          .getState()
          .messages.some(
            (m) => m.role === "system" && m.text.includes("已退出音乐模式"),
          ),
      ).toBe(true);

      await act(async () => {
        typeTextarea(input, "加一个登录节点");
        submitEnter(input);
      });
      expect(sendPrompt).toHaveBeenCalledWith(
        expect.stringContaining("加一个登录节点"),
      );
      expect(generateMusicPrompt).toHaveBeenCalledTimes(1);
    } finally {
      await view.cleanup();
    }
  });

  it("enters music mode and generates when text follows /music-mode-start", async () => {
    resetStore();
    const generateMusicPrompt = vi.fn();
    const sendPrompt = vi.fn(() => true);
    useStore.setState({ generateMusicPrompt, sendPrompt });
    const view = await renderDock();

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(input, "/music-mode-start 一段赛博朋克片头曲");
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            ctrlKey: true,
            bubbles: true,
          }),
        );
      });

      expect(useStore.getState().composer.musicMode).toBe(true);
      expect(useStore.getState().composer.musicModeStartedAt).toBeGreaterThan(
        0,
      );
      expect(useStore.getState().composer.imageMode).toBe(false);
      expect(generateMusicPrompt).toHaveBeenCalledWith("一段赛博朋克片头曲");
      expect(sendPrompt).not.toHaveBeenCalled();
      expect(input.value).toBe("");
    } finally {
      await view.cleanup();
    }
  });

  it("toggles sticky 3D mode via /mesh-mode-start and /mesh-mode-end", async () => {
    resetStore();
    const generateThreeDPrompt = vi.fn();
    const sendPrompt = vi.fn(() => true);
    useStore.setState({ generateThreeDPrompt, sendPrompt });
    const view = await renderDock();

    const submitEnter = (input: HTMLTextAreaElement) =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          ctrlKey: true,
          bubbles: true,
        }),
      );

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(input, "/mesh-mode-start");
        submitEnter(input);
      });
      expect(useStore.getState().composer.threeDMode).toBe(true);
      expect(useStore.getState().composer.threeDModeStartedAt).toBeGreaterThan(
        0,
      );
      expect(useStore.getState().composer.imageMode).toBe(false);
      expect(useStore.getState().composer.musicMode).toBe(false);
      expect(generateThreeDPrompt).not.toHaveBeenCalled();
      expect(sendPrompt).not.toHaveBeenCalled();
      expect(
        useStore
          .getState()
          .messages.some(
            (m) => m.role === "system" && m.text.includes("已进入 Mesh 模式"),
          ),
      ).toBe(true);

      await act(async () => {
        typeTextarea(input, "一个低多边形宝箱");
        submitEnter(input);
      });
      expect(generateThreeDPrompt).toHaveBeenCalledWith("一个低多边形宝箱");
      expect(sendPrompt).not.toHaveBeenCalled();

      await act(async () => {
        typeTextarea(input, "/review 看看这段代码");
        submitEnter(input);
      });
      expect(sendPrompt).toHaveBeenCalledTimes(1);

      await act(async () => {
        typeTextarea(input, "/mesh-mode-end");
        submitEnter(input);
      });
      expect(useStore.getState().composer.threeDMode).toBe(false);
      expect(useStore.getState().composer.threeDModeStartedAt).toBeNull();
      expect(
        useStore
          .getState()
          .messages.some(
            (m) => m.role === "system" && m.text.includes("已退出 Mesh 模式"),
          ),
      ).toBe(true);

      await act(async () => {
        typeTextarea(input, "加一个登录节点");
        submitEnter(input);
      });
      expect(sendPrompt).toHaveBeenCalledWith(
        expect.stringContaining("加一个登录节点"),
      );
      expect(generateThreeDPrompt).toHaveBeenCalledTimes(1);
    } finally {
      await view.cleanup();
    }
  });

  it("enters 3D mode and generates when text follows /mesh-mode-start", async () => {
    resetStore();
    const generateThreeDPrompt = vi.fn();
    const sendPrompt = vi.fn(() => true);
    useStore.setState({ generateThreeDPrompt, sendPrompt });
    const view = await renderDock();

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(input, "/mesh-mode-start 一个赛博朋克机械臂");
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            ctrlKey: true,
            bubbles: true,
          }),
        );
      });

      expect(useStore.getState().composer.threeDMode).toBe(true);
      expect(useStore.getState().composer.threeDModeStartedAt).toBeGreaterThan(
        0,
      );
      expect(useStore.getState().composer.imageMode).toBe(false);
      expect(useStore.getState().composer.musicMode).toBe(false);
      expect(generateThreeDPrompt).toHaveBeenCalledWith("一个赛博朋克机械臂");
      expect(sendPrompt).not.toHaveBeenCalled();
      expect(input.value).toBe("");
    } finally {
      await view.cleanup();
    }
  });

  it("toggles sticky UI mode via /ui-mode-start and /ui-mode-end", async () => {
    resetStore();
    const generateUiPrompt = vi.fn();
    const sendPrompt = vi.fn(() => true);
    useStore.setState({ generateUiPrompt, sendPrompt });
    const view = await renderDock();

    const submitEnter = (input: HTMLTextAreaElement) =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          ctrlKey: true,
          bubbles: true,
        }),
      );

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(input, "/ui-mode-start");
        submitEnter(input);
      });
      expect(useStore.getState().composer.uiMode).toBe(true);
      expect(useStore.getState().composer.uiModeStartedAt).toBeGreaterThan(0);
      expect(useStore.getState().composer.threeDMode).toBe(false);
      expect(useStore.getState().composer.comfyMode).toBe(false);
      expect(generateUiPrompt).not.toHaveBeenCalled();
      expect(sendPrompt).not.toHaveBeenCalled();
      expect(
        useStore
          .getState()
          .messages.some(
            (m) => m.role === "system" && m.text.includes("已进入 UI 模式"),
          ),
      ).toBe(true);

      await act(async () => {
        typeTextarea(input, "设计一个暂停菜单");
        submitEnter(input);
      });
      expect(generateUiPrompt).toHaveBeenCalledWith("设计一个暂停菜单");
      expect(sendPrompt).not.toHaveBeenCalled();

      await act(async () => {
        typeTextarea(input, "/ui-mode-end");
        submitEnter(input);
      });
      expect(useStore.getState().composer.uiMode).toBe(false);
      expect(useStore.getState().composer.uiModeStartedAt).toBeNull();
      expect(
        useStore
          .getState()
          .messages.some(
            (m) => m.role === "system" && m.text.includes("已退出 UI 模式"),
          ),
      ).toBe(true);

      await act(async () => {
        typeTextarea(input, "加一个登录节点");
        submitEnter(input);
      });
      expect(sendPrompt).toHaveBeenCalledWith(
        expect.stringContaining("加一个登录节点"),
      );
      expect(generateUiPrompt).toHaveBeenCalledTimes(1);
    } finally {
      await view.cleanup();
    }
  });

  it("enters UI mode and generates when text follows /ui-mode-start", async () => {
    resetStore();
    const generateUiPrompt = vi.fn();
    const sendPrompt = vi.fn(() => true);
    useStore.setState({ generateUiPrompt, sendPrompt });
    const view = await renderDock();

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(input, "/ui-mode-start 设计一个赛博朋克 HUD");
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            ctrlKey: true,
            bubbles: true,
          }),
        );
      });

      expect(useStore.getState().composer.uiMode).toBe(true);
      expect(useStore.getState().composer.uiModeStartedAt).toBeGreaterThan(0);
      expect(generateUiPrompt).toHaveBeenCalledWith("设计一个赛博朋克 HUD");
      expect(sendPrompt).not.toHaveBeenCalled();
      expect(input.value).toBe("");
    } finally {
      await view.cleanup();
    }
  });

  it("toggles sticky GDD mode via /gdd-mode-start and /gdd-mode-end", async () => {
    resetStore();
    const generateGddPrompt = vi.fn();
    const sendPrompt = vi.fn(() => true);
    useStore.setState({ generateGddPrompt, sendPrompt });
    const view = await renderDock();

    const submitEnter = (input: HTMLTextAreaElement) =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          ctrlKey: true,
          bubbles: true,
        }),
      );

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(input, "/gdd-mode-start");
        submitEnter(input);
      });
      expect(useStore.getState().composer.gddMode).toBe(true);
      expect(useStore.getState().composer.gddModeStartedAt).toBeGreaterThan(0);
      expect(useStore.getState().composer.imageMode).toBe(false);
      expect(useStore.getState().composer.uiMode).toBe(false);
      expect(generateGddPrompt).not.toHaveBeenCalled();
      expect(sendPrompt).not.toHaveBeenCalled();
      expect(
        useStore
          .getState()
          .messages.some(
            (m) => m.role === "system" && m.text.includes("已进入 GDD 模式"),
          ),
      ).toBe(true);

      await act(async () => {
        typeTextarea(input, "把核心循环改成探索-收集-建造");
        submitEnter(input);
      });
      expect(generateGddPrompt).toHaveBeenCalledWith(
        "把核心循环改成探索-收集-建造",
      );
      expect(sendPrompt).not.toHaveBeenCalled();

      await act(async () => {
        typeTextarea(input, "/review 检查 GDD 风险");
        submitEnter(input);
      });
      expect(sendPrompt).toHaveBeenCalledTimes(1);

      await act(async () => {
        typeTextarea(input, "/gdd-mode-end");
        submitEnter(input);
      });
      expect(useStore.getState().composer.gddMode).toBe(false);
      expect(useStore.getState().composer.gddModeStartedAt).toBeNull();
      expect(generateGddPrompt).toHaveBeenLastCalledWith("", {
        finalize: true,
      });
      expect(
        useStore
          .getState()
          .messages.some(
            (m) => m.role === "system" && m.text.includes("已退出 GDD 模式"),
          ),
      ).toBe(true);

      await act(async () => {
        typeTextarea(input, "加一个登录节点");
        submitEnter(input);
      });
      expect(sendPrompt).toHaveBeenCalledWith(
        expect.stringContaining("加一个登录节点"),
      );
    } finally {
      await view.cleanup();
    }
  });

  it("enters GDD mode and drafts when text follows /gdd-mode-start", async () => {
    resetStore();
    const generateGddPrompt = vi.fn();
    const sendPrompt = vi.fn(() => true);
    useStore.setState({ generateGddPrompt, sendPrompt });
    const view = await renderDock();

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(input, "/gdd-mode-start 做一个双摇杆肉鸽塔防");
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            ctrlKey: true,
            bubbles: true,
          }),
        );
      });

      expect(useStore.getState().composer.gddMode).toBe(true);
      expect(useStore.getState().composer.gddModeStartedAt).toBeGreaterThan(0);
      expect(generateGddPrompt).toHaveBeenCalledWith("做一个双摇杆肉鸽塔防");
      expect(sendPrompt).not.toHaveBeenCalled();
      expect(input.value).toBe("");
    } finally {
      await view.cleanup();
    }
  });

  it("toggles sticky UE Blueprint mode via /blueprint-mode-start and /blueprint-mode-end", async () => {
    resetStore();
    const generateBlueprintPrompt = vi.fn();
    const sendPrompt = vi.fn(() => true);
    useStore.setState({
      composer: { ...defaultComposer, workspace: "E:\\Game\\Demo" },
      generateBlueprintPrompt,
      sendPrompt,
    });
    const view = await renderDock();

    const submitEnter = (input: HTMLTextAreaElement) =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          ctrlKey: true,
          bubbles: true,
        }),
      );

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(
          input,
          "/blueprint-mode-start --target BP_Player --context full",
        );
        submitEnter(input);
      });
      await flushAsyncWork();
      expect(useStore.getState().composer.blueprintMode).toBe(true);
      expect(
        useStore.getState().composer.blueprintModeStartedAt,
      ).toBeGreaterThan(0);
      expect(useStore.getState().composer.blueprintModeArgs).toBe(
        "--target BP_Player --context full",
      );
      expect(useStore.getState().composer.uiMode).toBe(false);
      expect(useStore.getState().composer.comfyMode).toBe(false);
      expect(generateBlueprintPrompt).not.toHaveBeenCalled();
      expect(sendPrompt).not.toHaveBeenCalled();
      expect(
        useStore
          .getState()
          .messages.some(
            (m) => m.role === "system" && m.text.includes("已进入 UE 蓝图模式"),
          ),
      ).toBe(true);

      await act(async () => {
        typeTextarea(input, "给角色加一个开门交互事件");
        submitEnter(input);
      });
      expect(generateBlueprintPrompt).toHaveBeenCalledWith(
        "给角色加一个开门交互事件",
      );
      expect(sendPrompt).not.toHaveBeenCalled();

      await act(async () => {
        typeTextarea(input, "/review 看看这段代码");
        submitEnter(input);
      });
      expect(sendPrompt).toHaveBeenCalledTimes(1);

      await act(async () => {
        typeTextarea(input, "/blueprint-mode-end");
        submitEnter(input);
      });
      expect(useStore.getState().composer.blueprintMode).toBe(false);
      expect(useStore.getState().composer.blueprintModeStartedAt).toBeNull();
      expect(useStore.getState().composer.blueprintModeArgs).toBeNull();
      expect(
        useStore
          .getState()
          .messages.some(
            (m) => m.role === "system" && m.text.includes("已退出 UE 蓝图模式"),
          ),
      ).toBe(true);
    } finally {
      await view.cleanup();
    }
  });

  it("enters UE Blueprint mode and runs the first prompt after parsed flags", async () => {
    resetStore();
    const generateBlueprintPrompt = vi.fn();
    const sendPrompt = vi.fn(() => true);
    useStore.setState({
      composer: { ...defaultComposer, workspace: "E:\\Game\\Demo" },
      generateBlueprintPrompt,
      sendPrompt,
    });
    const view = await renderDock();

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(
          input,
          "/blueprint-mode-start --target BP_Door --dry-run 添加按 E 开门逻辑",
        );
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            ctrlKey: true,
            bubbles: true,
          }),
        );
      });
      await flushAsyncWork();

      expect(useStore.getState().composer.blueprintMode).toBe(true);
      expect(useStore.getState().composer.blueprintModeArgs).toBe(
        "--target BP_Door --dry-run",
      );
      expect(generateBlueprintPrompt).toHaveBeenCalledWith("添加按 E 开门逻辑");
      expect(sendPrompt).not.toHaveBeenCalled();
      expect(input.value).toBe("");
    } finally {
      await view.cleanup();
    }
  });

  it("toggles sticky MetaHuman MVP mode via /metahuman-mode-start and /metahuman-mode-end", async () => {
    resetStore();
    const generateMetaHumanPrompt = vi.fn();
    const sendPrompt = vi.fn(() => true);
    useStore.setState({ generateMetaHumanPrompt, sendPrompt });
    const view = await renderDock();

    const submitEnter = (input: HTMLTextAreaElement) =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          ctrlKey: true,
          bubbles: true,
        }),
      );

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(
          input,
          "/metahuman-mode-start 80% 亚洲硬朗脸，20% 成熟港风",
        );
        submitEnter(input);
      });

      expect(useStore.getState().composer.metahumanMode).toBe(true);
      expect(
        useStore.getState().composer.metahumanModeStartedAt,
      ).toBeGreaterThan(0);
      expect(useStore.getState().composer.uiMode).toBe(false);
      expect(useStore.getState().composer.blueprintMode).toBe(false);
      expect(generateMetaHumanPrompt).toHaveBeenCalledWith(
        "80% 亚洲硬朗脸，20% 成熟港风",
      );
      expect(sendPrompt).not.toHaveBeenCalled();
      expect(
        useStore
          .getState()
          .messages.some(
            (m) =>
              m.role === "system" &&
              m.text.includes("已进入 MetaHuman MVP 模式"),
          ),
      ).toBe(true);

      await act(async () => {
        typeTextarea(input, "先给我三版参考图 brief");
        submitEnter(input);
      });
      expect(generateMetaHumanPrompt).toHaveBeenLastCalledWith(
        "先给我三版参考图 brief",
      );
      expect(sendPrompt).not.toHaveBeenCalled();

      await act(async () => {
        typeTextarea(input, "/metahuman-mode-end");
        submitEnter(input);
      });
      expect(useStore.getState().composer.metahumanMode).toBe(false);
      expect(useStore.getState().composer.metahumanModeStartedAt).toBeNull();
      expect(
        useStore
          .getState()
          .messages.some(
            (m) =>
              m.role === "system" &&
              m.text.includes("已退出 MetaHuman MVP 模式"),
          ),
      ).toBe(true);
    } finally {
      await view.cleanup();
    }
  });

  it("asks to install BlueprintMode before entering UE Blueprint mode", async () => {
    resetStore();
    vi.mocked(blueprintModeStatus).mockResolvedValue({
      ok: true,
      sourceUrl: "https://example.test/BlueprintMode.zip",
      targetDir: "E:\\Game\\Demo\\Plugins\\BlueprintMode",
      exists: false,
      installed: false,
      upluginPath: null,
      versionName: null,
      notes: ["尚未安装 BlueprintMode 插件。"],
      warnings: [],
      error: null,
    });
    useStore.setState({
      composer: {
        ...defaultComposer,
        workspace: "E:\\Game\\Demo",
      },
    });
    const generateBlueprintPrompt = vi.fn();
    const sendPrompt = vi.fn(() => true);
    useStore.setState({ generateBlueprintPrompt, sendPrompt });
    const view = await renderDock();

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(
          input,
          "/blueprint-mode-start --target BP_Door 添加按 E 开门逻辑",
        );
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            ctrlKey: true,
            bubbles: true,
          }),
        );
      });
      await flushAsyncWork();

      expect(useStore.getState().composer.blueprintMode).toBe(false);
      expect(view.container.textContent).toContain(
        "当前 UE 项目未安装 BlueprintMode 插件",
      );
      const installButton = Array.from(
        view.container.querySelectorAll<HTMLButtonElement>("button"),
      ).find(
        (button) => button.textContent?.trim() === "安装 BlueprintMode 插件",
      );
      expect(installButton).toBeTruthy();

      await act(async () => {
        installButton?.click();
      });
      await flushAsyncWork();

      expect(blueprintModeInstall).toHaveBeenCalledWith({
        rootPath: "E:\\Game\\Demo",
        targetDir: null,
        overwrite: false,
      });
      expect(useStore.getState().composer.blueprintMode).toBe(true);
      expect(useStore.getState().composer.blueprintModeArgs).toBe(
        "--target BP_Door",
      );
      expect(generateBlueprintPrompt).toHaveBeenCalledWith("添加按 E 开门逻辑");
    } finally {
      await view.cleanup();
    }
  });

  it("toggles sticky sprite mode via /sprite-mode-start and /sprite-mode-end", async () => {
    resetStore();
    const generateSpritePrompt = vi.fn();
    const sendPrompt = vi.fn(() => true);
    useStore.setState({ generateSpritePrompt, sendPrompt });
    const view = await renderDock();

    const submitEnter = (input: HTMLTextAreaElement) =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          ctrlKey: true,
          bubbles: true,
        }),
      );

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(input, "/sprite-mode-start");
        submitEnter(input);
      });
      expect(useStore.getState().composer.spriteMode).toBe(true);
      expect(useStore.getState().composer.spriteModeStartedAt).toBeGreaterThan(
        0,
      );
      expect(useStore.getState().composer.imageMode).toBe(false);
      expect(useStore.getState().composer.musicMode).toBe(false);
      expect(useStore.getState().composer.threeDMode).toBe(false);
      expect(useStore.getState().composer.videoMode).toBe(false);
      expect(generateSpritePrompt).not.toHaveBeenCalled();
      expect(sendPrompt).not.toHaveBeenCalled();
      expect(
        useStore
          .getState()
          .messages.some(
            (m) => m.role === "system" && m.text.includes("已进入 Sprite 模式"),
          ),
      ).toBe(true);

      await act(async () => {
        typeTextarea(input, "一个 16 帧 idle 像素机器人");
        submitEnter(input);
      });
      expect(generateSpritePrompt).toHaveBeenCalledWith(
        "一个 16 帧 idle 像素机器人",
      );
      expect(sendPrompt).not.toHaveBeenCalled();

      await act(async () => {
        typeTextarea(input, "/review 看看这段代码");
        submitEnter(input);
      });
      expect(sendPrompt).toHaveBeenCalledTimes(1);

      await act(async () => {
        typeTextarea(input, "/sprite-mode-end");
        submitEnter(input);
      });
      expect(useStore.getState().composer.spriteMode).toBe(false);
      expect(useStore.getState().composer.spriteModeStartedAt).toBeNull();
      expect(
        useStore
          .getState()
          .messages.some(
            (m) => m.role === "system" && m.text.includes("已退出 Sprite 模式"),
          ),
      ).toBe(true);

      await act(async () => {
        typeTextarea(input, "加一个登录节点");
        submitEnter(input);
      });
      expect(sendPrompt).toHaveBeenCalledWith(
        expect.stringContaining("加一个登录节点"),
      );
      expect(generateSpritePrompt).toHaveBeenCalledTimes(1);
    } finally {
      await view.cleanup();
    }
  });

  it("enters sprite mode and generates when text follows /sprite-mode-start", async () => {
    resetStore();
    const generateSpritePrompt = vi.fn();
    const sendPrompt = vi.fn(() => true);
    useStore.setState({ generateSpritePrompt, sendPrompt });
    const view = await renderDock();

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(input, "/sprite-mode-start 一套横版角色 walk spritesheet");
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            ctrlKey: true,
            bubbles: true,
          }),
        );
      });

      expect(useStore.getState().composer.spriteMode).toBe(true);
      expect(useStore.getState().composer.spriteModeStartedAt).toBeGreaterThan(
        0,
      );
      expect(generateSpritePrompt).toHaveBeenCalledWith(
        "一套横版角色 walk spritesheet",
      );
      expect(sendPrompt).not.toHaveBeenCalled();
      expect(input.value).toBe("");
    } finally {
      await view.cleanup();
    }
  });

  it("enters animation mode and generates when text follows /anim-mode-start", async () => {
    resetStore();
    const generateAnimationPrompt = vi.fn();
    const sendPrompt = vi.fn(() => true);
    useStore.setState({ generateAnimationPrompt, sendPrompt });
    const view = await renderDock();

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(input, "/anim-mode-start 搜索 walk cycle FBX");
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            ctrlKey: true,
            bubbles: true,
          }),
        );
      });

      expect(useStore.getState().composer.animationMode).toBe(true);
      expect(
        useStore.getState().composer.animationModeStartedAt,
      ).toBeGreaterThan(0);
      expect(generateAnimationPrompt).toHaveBeenCalledWith(
        "搜索 walk cycle FBX",
      );
      expect(sendPrompt).not.toHaveBeenCalled();
      expect(input.value).toBe("");
    } finally {
      await view.cleanup();
    }
  });

  it("switches the bottom channel/model selectors to image providers in image mode", async () => {
    resetStore();
    useStore.setState({ composer: { ...defaultComposer, imageMode: true } });
    const view = await renderDock();

    try {
      // The channel selector trigger should show an image provider, not a
      // coding adapter/free channel.
      const channelTrigger = Array.from(
        view.container.querySelectorAll<HTMLButtonElement>("button[title]"),
      ).find((btn) => btn.getAttribute("title") === "渠道");
      expect(channelTrigger).toBeInstanceOf(HTMLButtonElement);

      await act(async () => {
        channelTrigger?.dispatchEvent(
          new MouseEvent("click", { bubbles: true }),
        );
      });

      // Image provider labels (e.g. 硅基流动) appear; coding channels do not.
      const menuText =
        channelTrigger?.parentElement?.querySelector('[role="listbox"]')
          ?.textContent ?? "";
      expect(menuText).toContain("硅基流动");

      // Selecting an image provider writes the image settings store, leaving the
      // coding runSelection untouched.
      const volcengine = Array.from(
        view.container.querySelectorAll<HTMLElement>('[role="option"]'),
      ).find((opt) => opt.textContent?.includes("火山方舟"));
      expect(volcengine).toBeInstanceOf(HTMLElement);
      await act(async () => {
        volcengine?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      const saved = JSON.parse(
        window.localStorage.getItem("ultragamestudio.imageGeneration.v1") ?? "{}",
      );
      expect(saved.preferredProviderId).toBe("volcengine-seedream");
    } finally {
      await view.cleanup();
    }
  });

  it("shows manually added image provider models in the image-mode model selector", async () => {
    resetStore();
    saveImageGenerationSettings({
      ...DEFAULT_IMAGE_GENERATION_SETTINGS,
      preferredProviderId: "cloudflare",
      providerKeys: { cloudflare: "cfut-test" },
      providerAccountIds: { cloudflare: "account-id" },
      providerModels: {
        cloudflare: "@cf/black-forest-labs/flux-1-schnell",
      },
      providerModelLists: {
        cloudflare: ["@cf/black-forest-labs/flux-1-schnell"],
      },
    });
    useStore.setState({ composer: { ...defaultComposer, imageMode: true } });
    const view = await renderDock();

    try {
      const modelTrigger = Array.from(
        view.container.querySelectorAll<HTMLButtonElement>("button[title]"),
      ).find((btn) => btn.getAttribute("title") === "生图模型");
      expect(modelTrigger).toBeInstanceOf(HTMLButtonElement);

      await act(async () => {
        modelTrigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      const menuText =
        modelTrigger?.parentElement?.querySelector('[role="listbox"]')
          ?.textContent ?? "";
      expect(menuText).toContain("@cf/black-forest-labs/flux-1-schnell");
    } finally {
      await view.cleanup();
    }
  });

  it("shows the session run model instead of the provider default model", async () => {
    resetStore("codex");
    upsertProviders(
      [
        {
          id: "p_relay_codex",
          kind: "codex",
          name: "RelayAI",
          apiKey: "sk-test",
          baseUrl: "https://relay.example",
          transport: "cli",
          model: "gpt-5.6-sol",
          models: ["gpt-5.5"],
        },
      ],
      { makeActiveId: "p_relay_codex" },
    );
    const workflow = defaultBlueprint("Pinned model");
    useStore.setState({
      workflow: {
        ...workflow,
        meta: {
          ...workflow.meta,
          adapter: "codex",
          gateway: {
            defaults: {
              adapter: "codex",
              modelClass: "gpt-5.5",
              providerId: "p_relay_codex",
              channelId: "default",
            },
          },
        },
      },
    });
    const view = await renderDock();

    try {
      const modelTrigger = Array.from(
        view.container.querySelectorAll<HTMLButtonElement>("button"),
      ).find((btn) => btn.textContent?.includes("gpt-5.5"));
      expect(modelTrigger).toBeInstanceOf(HTMLButtonElement);
      expect(modelTrigger?.textContent).toContain("gpt-5.5");
      expect(modelTrigger?.textContent).not.toContain("gpt-5.6-sol");
    } finally {
      await view.cleanup();
    }
  });

  it("switches the bottom channel/model selectors to music providers in music mode", async () => {
    resetStore();
    useStore.setState({ composer: { ...defaultComposer, musicMode: true } });
    const view = await renderDock();

    try {
      const channelTrigger = Array.from(
        view.container.querySelectorAll<HTMLButtonElement>("button[title]"),
      ).find((btn) => btn.getAttribute("title") === "渠道");
      expect(channelTrigger).toBeInstanceOf(HTMLButtonElement);

      await act(async () => {
        channelTrigger?.dispatchEvent(
          new MouseEvent("click", { bubbles: true }),
        );
      });

      const menuText =
        channelTrigger?.parentElement?.querySelector('[role="listbox"]')
          ?.textContent ?? "";
      expect(menuText).toContain("ElevenLabs Music");
      expect(menuText).toContain("Hugging Face MusicGen");

      const huggingFace = Array.from(
        view.container.querySelectorAll<HTMLElement>('[role="option"]'),
      ).find((opt) => opt.textContent?.includes("Hugging Face MusicGen"));
      expect(huggingFace).toBeInstanceOf(HTMLElement);
      await act(async () => {
        huggingFace?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      const saved = JSON.parse(
        window.localStorage.getItem("ultragamestudio.musicGeneration.v1") ?? "{}",
      );
      expect(saved.preferredProviderId).toBe("huggingface-musicgen");
    } finally {
      await view.cleanup();
    }
  });

  it("switches the bottom channel/model selectors to 3D providers in 3D mode", async () => {
    resetStore();
    useStore.setState({ composer: { ...defaultComposer, threeDMode: true } });
    const view = await renderDock();

    try {
      const channelTrigger = Array.from(
        view.container.querySelectorAll<HTMLButtonElement>("button[title]"),
      ).find((btn) => btn.getAttribute("title") === "渠道");
      expect(channelTrigger).toBeInstanceOf(HTMLButtonElement);

      await act(async () => {
        channelTrigger?.dispatchEvent(
          new MouseEvent("click", { bubbles: true }),
        );
      });

      const menuText =
        channelTrigger?.parentElement?.querySelector('[role="listbox"]')
          ?.textContent ?? "";
      expect(menuText).toContain("Meshy");
      expect(menuText).toContain("Local Hunyuan3D");

      const localHunyuan = Array.from(
        view.container.querySelectorAll<HTMLElement>('[role="option"]'),
      ).find((opt) => opt.textContent?.includes("Local Hunyuan3D"));
      expect(localHunyuan).toBeInstanceOf(HTMLElement);
      await act(async () => {
        localHunyuan?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      const saved = JSON.parse(
        window.localStorage.getItem("ultragamestudio.threeDGeneration.v1") ??
          "{}",
      );
      expect(saved.preferredProviderId).toBe("local-hunyuan3d");
    } finally {
      await view.cleanup();
    }
  });

  it("reuses image channel/model selectors in sprite mode", async () => {
    resetStore();
    useStore.setState({ composer: { ...defaultComposer, spriteMode: true } });
    const view = await renderDock();

    try {
      const channelTrigger = Array.from(
        view.container.querySelectorAll<HTMLButtonElement>("button[title]"),
      ).find((btn) => btn.getAttribute("title") === "渠道");
      expect(channelTrigger).toBeInstanceOf(HTMLButtonElement);

      await act(async () => {
        channelTrigger?.dispatchEvent(
          new MouseEvent("click", { bubbles: true }),
        );
      });

      const menuText =
        channelTrigger?.parentElement?.querySelector('[role="listbox"]')
          ?.textContent ?? "";
      expect(menuText).toContain("硅基流动");
      expect(menuText).not.toContain("Ludo.ai Sprite Generator");
      expect(menuText).not.toContain("本地 ComfyUI Sprite");

      const volcengine = Array.from(
        view.container.querySelectorAll<HTMLElement>('[role="option"]'),
      ).find((opt) => opt.textContent?.includes("火山方舟"));
      expect(volcengine).toBeInstanceOf(HTMLElement);
      await act(async () => {
        volcengine?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      const saved = JSON.parse(
        window.localStorage.getItem("ultragamestudio.imageGeneration.v1") ?? "{}",
      );
      expect(saved.preferredProviderId).toBe("volcengine-seedream");
      expect(
        window.localStorage.getItem("ultragamestudio.spriteGeneration.v1"),
      ).toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  it("shows command suggestions after slash and inserts only the slash token", async () => {
    resetStore();
    const view = await renderDock();

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(input, "/rev");
      });

      const review = Array.from(
        view.container.querySelectorAll('[role="option"]'),
      ).find((option) => option.textContent?.includes("/review"));
      expect(review).toBeInstanceOf(HTMLElement);
      expect(
        view.container
          .querySelector('[role="listbox"]')
          ?.closest(".ugs-ai-input-card"),
      ).toBeNull();

      await act(async () => {
        review?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(input.value).toBe("/review ");
      expect(input.value).not.toBe("/rev");
      expect(input.value).not.toContain("按代码审查视角检查");
    } finally {
      await view.cleanup();
    }
  });

  it("expands ordinary slash commands only when submitting", async () => {
    resetStore();
    const sendPrompt = vi.fn(() => true);
    const runStudioPrompt = vi.fn();
    useStore.setState({ sendPrompt, runStudioPrompt });
    const view = await renderDock();

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(input, "/review 检查 README");
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            ctrlKey: true,
            bubbles: true,
          }),
        );
      });

      expect(sendPrompt).toHaveBeenCalledWith(
        expect.stringContaining("按代码审查视角检查"),
      );
      expect(sendPrompt).toHaveBeenCalledWith(
        expect.stringContaining("请求：\n检查 README"),
      );
      expect(runStudioPrompt).not.toHaveBeenCalled();
      expect(input.value).toBe("");
    } finally {
      await view.cleanup();
    }
  });

  it("expands /image-to-game into the image-driven game analysis prompt", async () => {
    resetStore();
    const sendPrompt = vi.fn(() => true);
    const runStudioPrompt = vi.fn();
    useStore.setState({ sendPrompt, runStudioPrompt });
    const view = await renderDock();

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(input, "/image-to-game 这张横版像素场景截图");
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            ctrlKey: true,
            bubbles: true,
          }),
        );
      });

      expect(sendPrompt).toHaveBeenCalledWith(
        expect.stringContaining("执行图像驱动游戏开发分析"),
      );
      expect(sendPrompt).toHaveBeenCalledWith(
        expect.stringContaining("优先按当前工作区检测/配置的项目引擎拆解"),
      );
      expect(sendPrompt).toHaveBeenCalledWith(
        expect.stringContaining("不要默认使用 Godot"),
      );
      expect(sendPrompt).toHaveBeenCalledWith(
        expect.stringContaining("请求：\n这张横版像素场景截图"),
      );
      expect(runStudioPrompt).not.toHaveBeenCalled();
      expect(input.value).toBe("");
    } finally {
      await view.cleanup();
    }
  });

  it("scopes CLI slash commands to the selected adapter", async () => {
    resetStore("codex");
    const view = await renderDock();

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(input, "/sta");
      });

      const menuText =
        view.container.querySelector('[role="listbox"]')?.textContent ?? "";
      expect(menuText).toContain("Codex 状态");
      expect(menuText).not.toContain("Claude 状态");
      expect(menuText).not.toContain("Gemini 状态");
    } finally {
      await view.cleanup();
    }
  });

  it.runIf(CLOUD_PROJECTS_ENABLED)("scopes CLI slash commands to the remote project adapter", async () => {
    resetStore("claude-code");
    const remotePath = remoteWorkspacePath("rw_slash_codex");
    saveRemoteWorkspace({
      id: "rw_slash_codex",
      label: "远程项目",
      serverUrl: "https://runner.test",
      projectId: "proj_slash_codex",
      repoUrl: "https://example.test/repo.git",
      adapter: "codex",
      model: "gpt-remote",
      useOwnModelKey: false,
    });
    // Remote projects surface the *remote* project's synced skill catalog from
    // the per-project cache, not the local machine scan. Seed the cache so the
    // `/` menu has the remote CLI status commands to scope by adapter.
    window.localStorage.setItem(
      REMOTE_WORKSPACE_SKILLS_STORAGE_KEY,
      JSON.stringify({
        rw_slash_codex: {
          scannedAtMs: Date.now(),
          entries: slashCatalogMock.entries.filter((entry) =>
            entry.name === "/status",
          ),
        },
      }),
    );
    useStore.setState((state) => ({
      composer: {
        ...state.composer,
        workspace: remotePath,
      },
    }));
    const view = await renderDock();

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(input, "/sta");
        await flushAsyncWork();
      });

      const menuText =
        view.container.querySelector('[role="listbox"]')?.textContent ?? "";
      expect(menuText).toContain("Codex 状态");
      expect(menuText).not.toContain("Claude 状态");
      expect(menuText).not.toContain("Gemini 状态");
    } finally {
      await view.cleanup();
    }
  });

  it("uses high-contrast styling for the active slash suggestion", async () => {
    resetStore();
    const view = await renderDock();

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(input, "/");
      });

      const options = () =>
        Array.from(
          view.container.querySelectorAll<HTMLElement>('[role="option"]'),
        );
      const activeOption = () =>
        options().find(
          (option) => option.getAttribute("aria-selected") === "true",
        );

      expect(options().length).toBeGreaterThan(1);
      expect(activeOption()?.className).toContain("border-l-accent");
      expect(activeOption()?.className).toContain("bg-accent/20");
      expect(activeOption()?.className).toContain("ring-accent/40");
      expect(activeOption()?.querySelector("span")?.className).toContain(
        "bg-accent",
      );

      await act(async () => {
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
        );
      });

      expect(options()[0]?.className).toContain("border-l-transparent");
      expect(activeOption()).toBe(options()[1]);
      expect(activeOption()?.className).toContain("border-l-accent");
    } finally {
      await view.cleanup();
    }
  });

  it("hides disabled /studio and removed /deep-research entries from slash suggestions", async () => {
    resetStore();
    const view = await renderDock();

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(input, "/ult");
      });

      const studio = Array.from(
        view.container.querySelectorAll('[role="option"]'),
      ).find(
        (option) => option.querySelector("span")?.textContent === "/studio",
      );
      expect(studio).toBeUndefined();

      await act(async () => {
        typeTextarea(input, "/deep");
      });

      const deepResearch = Array.from(
        view.container.querySelectorAll('[role="option"]'),
      ).find(
        (option) =>
          option.querySelector("span")?.textContent === "/deep-research",
      );
      expect(deepResearch).toBeUndefined();
    } finally {
      await view.cleanup();
    }
  });

  it("blocks submitted /studio commands with a local notice", async () => {
    resetStore();
    const sendPrompt = vi.fn(() => true);
    const runStudioPrompt = vi.fn();
    useStore.setState({ sendPrompt, runStudioPrompt });
    const view = await renderDock();

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(input, "/studio 完成 100 题");
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            ctrlKey: true,
            bubbles: true,
          }),
        );
      });

      expect(runStudioPrompt).not.toHaveBeenCalled();
      expect(sendPrompt).not.toHaveBeenCalled();
      expect(
        useStore
          .getState()
          .messages.some(
            (m) => m.role === "system" && m.text.includes("已关闭 /studio"),
          ),
      ).toBe(true);
      expect(input.value).toBe("");
    } finally {
      await view.cleanup();
    }
  });

  it("blocks submitted /deep-research commands after removing the built-in Skill", async () => {
    resetStore();
    const sendPrompt = vi.fn(() => true);
    const runStudioPrompt = vi.fn();
    useStore.setState({ sendPrompt, runStudioPrompt });
    const view = await renderDock();

    try {
      const input = textarea(view.container);

      await act(async () => {
        typeTextarea(input, "/deep-research 调研 Claude Code deep research");
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            ctrlKey: true,
            bubbles: true,
          }),
        );
      });

      expect(sendPrompt).not.toHaveBeenCalled();
      expect(runStudioPrompt).not.toHaveBeenCalled();
      expect(
        useStore
          .getState()
          .messages.some(
            (m) =>
              m.role === "system" &&
              m.text.includes("已移除 UltraGameStudio 内置 /deep-research Skill"),
          ),
      ).toBe(true);
      expect(input.value).toBe("");
    } finally {
      await view.cleanup();
    }
  });
});
