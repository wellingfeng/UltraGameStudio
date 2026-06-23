// ARCHITECTURAL CONSTRAINT — do not break the import cycle.
// This module is NOT a Zustand slice (no createXxxSlice(set, get) factory). It is
// a call-time *actions* module: it imports `useStore` from './useStore' while
// './useStore' imports the action functions from here, forming a deliberate
// import cycle. The cycle is only safe because every reference below is used
// EXCLUSIVELY inside function bodies (evaluated after the store is fully built),
// never at module-eval time.
//
// RULES (enforced by convention — ESLint cannot detect module-eval-time usage):
//   1. NEVER reference any './useStore' import at module top-level (no
//      `const x = useStore.getState()`, no calling an imported helper outside a
//      function body). A single such line silently yields `undefined` at startup.
//   2. This file must only be imported by './useStore' (enforced via
//      no-restricted-imports in .eslintrc.cjs) so the cycle stays a single edge.
//   3. If you need slice-style state ownership, convert this to a real
//      createXxxSlice(set, get) in a *Slice.ts file instead of extending the cycle.
// Extracted verbatim from useStore.ts (the contiguous module-level generation block).

// --- store internals (the cycle edge; all used only inside function bodies) ---
import {
  useStore,
  activeWorkflowSessionKey,
  projectMcpGuidanceForState,
  sessionChangesRootPathForSession,
  isWorkflowReadOnly,
  imageResultMarkdown,
  friendlyImageGenerationError,
  musicResultMarkdown,
  videoResultMarkdown,
  speechResultMarkdown,
  spriteResultMarkdown,
  threeDResultMarkdown,
  worldModelResultMarkdown,
  friendlyWorldModelGenerationError,
  downloadThreeDAssets,
  meshSearchResultMarkdown,
  downloadMeshSearchAssets,
  registerPendingGeneratedAsset,
  linkMessageManagedAssets,
  threeDFailureHint,
  sessionForKey,
  syncAndPersistSessionRunStatus,
  applyPromptTitle,
  runKey,
  chatTurnKey,
  aiEditRegistered,
  aiEditViewActive,
  addAiEditChannel,
  removeAiEditChannel,
  updateAiEditSessionSummary,
  aiEditCommitMessages,
  commitAiChannelBlueprint,
  gatewayRouteLine,
  gatewayRouteHeader,
  makeCliRunId,
  freeProxyOptionsForSelection,
} from './useStore';
import type { AiEditChannel } from './useStore';
import type { StoreState } from './storeState';

// --- types ---
import type { ComposerSettings, Message } from './types';

// --- same-dir helpers ---
import { historyStore } from './history/store';

// --- core/runtime ---
import { appendStartUserInputs } from '@/core/startInputs';
import type { GatewaySelection } from '@/core/ir';
import { formatClock, formatDuration } from '@/runtime';

// --- lib leaf imports (gateway / channels / assets / i18n / id / translation) ---
import { captureGeneratedAssets } from '@/lib/assetCapture';
import { verifyAsset, canVerifyAsset } from '@/lib/assetVerify';
import { markAssetDone, markAssetFailed } from '@/lib/downloadRegistry';
import { ensureFreeProxy, isFreeChannelSelection } from '@/lib/freeChannels';
import { shortId } from '@/lib/id';
import { translatePublicText } from '@/lib/publicTranslation';
import { aiEditViaCli, isTauri } from '@/lib/tauri';
import { completeGatewayText, resolveCliGatewayRoute, resolveDirectGatewayRoute } from '@/lib/modelGateway/modelGateway';
import { workflowDefaultGatewaySelection } from '@/lib/modelGateway/resolver';

// --- generation libs ---
import { generateImage, imageProviderById, imageProviderModel, imageProviderReady, imageProviders, loadImageGenerationSettings, preferredReadyImageProviderId, stripImageCommand, type ImageProviderId, type ImageGenerationSettings } from '@/lib/imageGeneration';
import { generateMusic, loadMusicGenerationSettings, musicDurationSecondsFromPrompt, musicProviderById, musicProviderModel, musicProviderReady, musicProviders, preferredReadyMusicProviderId, stripMusicCommand, type MusicProviderId, type MusicGenerationSettings } from '@/lib/musicGeneration';
import { assessThreeDRigging, generateThreeD, loadThreeDGenerationSettings, preferredReadyThreeDProviderId, stripThreeDCommand, threeDProviderById, threeDProviderModel, threeDProviderReady, threeDProviders, threeDRiggingPromptGuidance, type ThreeDProviderId, type ThreeDGenerationSettings } from '@/lib/threeDGeneration';
import { generateVideo, loadVideoGenerationSettings, preferredReadyVideoProviderId, stripVideoCommand, videoDurationSecondsFromPrompt, videoProviderById, videoProviderModel, videoProviderReady, videoProviders, type VideoProviderId, type VideoGenerationSettings } from '@/lib/videoGeneration';
import { generateSpeech, loadSpeechGenerationSettings, preferredReadySpeechProviderId, speechProviderById, speechProviderModel, speechProviderReady, speechProviderVoice, speechProviders, stripSpeechCommand, type SpeechProviderId, type SpeechGenerationSettings } from '@/lib/speechGeneration';
import { generateSprite, loadSpriteGenerationSettings, spriteSheetGridForSettings, stripSpriteCommand } from '@/lib/spriteGeneration';
import { generateWorldModel, loadWorldModelGenerationSettings, preferredReadyWorldModelProviderId, serializeWorldModelSpec, stripWorldModelCommand, worldModelProviderById, worldModelProviderModel, worldModelProviderReady, worldModelProviders, type WorldModelGenerationSettings, type WorldModelProviderId } from '@/lib/worldModel';
import { loadMeshLibrarySettings, meshLibraryById, meshSearchQueryNeedsEnglish, resolveMeshSearchQuery, searchMeshLibraries, stripMeshSearchCommand } from '@/lib/meshLibrary';
import { loadUiDesignChannelSettings, uiDesignChannelById, uiDesignChannelExportFormat } from '@/lib/uiDesignChannels';
import {
  isRemoteSettingsProfile,
  settingsProfileIdForWorkspacePath,
  type SettingsProfileOptions,
} from '@/lib/generationSettingsStore';

function generationWorkspacePathForState(state: StoreState): string {
  const composerWorkspace = state.composer.workspace.trim();
  if (composerWorkspace) return composerWorkspace;
  if (!state.activeWorkspaceId) return '';
  return (
    state.workspaces
      .find((workspace) => workspace.id === state.activeWorkspaceId)
      ?.path?.trim() ?? ''
  );
}

function generationSettingsProfileForState(state: StoreState): SettingsProfileOptions {
  return {
    profileId: settingsProfileIdForWorkspacePath(
      generationWorkspacePathForState(state),
    ),
  };
}

function preferredReadyImageProviderIdForProfile(
  settings: ImageGenerationSettings,
  profile: SettingsProfileOptions,
): ImageProviderId | null {
  if (!isRemoteSettingsProfile(profile.profileId)) {
    return preferredReadyImageProviderId(settings);
  }
  if (
    imageProviderReady(settings.preferredProviderId, settings) &&
    !imageProviderById(settings.preferredProviderId, settings).local
  ) {
    return settings.preferredProviderId;
  }
  return (
    imageProviders(settings).find(
      (provider) => !provider.local && imageProviderReady(provider.id, settings),
    )?.id ?? null
  );
}

function preferredReadyMusicProviderIdForProfile(
  settings: MusicGenerationSettings,
  profile: SettingsProfileOptions,
): MusicProviderId | null {
  if (!isRemoteSettingsProfile(profile.profileId)) {
    return preferredReadyMusicProviderId(settings);
  }
  if (
    musicProviderReady(settings.preferredProviderId, settings) &&
    !musicProviderById(settings.preferredProviderId, settings).local
  ) {
    return settings.preferredProviderId;
  }
  return (
    musicProviders(settings).find(
      (provider) => !provider.local && musicProviderReady(provider.id, settings),
    )?.id ?? null
  );
}

function preferredReadyThreeDProviderIdForProfile(
  settings: ThreeDGenerationSettings,
  profile: SettingsProfileOptions,
): ThreeDProviderId | null {
  if (!isRemoteSettingsProfile(profile.profileId)) {
    return preferredReadyThreeDProviderId(settings);
  }
  if (
    threeDProviderReady(settings.preferredProviderId, settings) &&
    !threeDProviderById(settings.preferredProviderId, settings).local
  ) {
    return settings.preferredProviderId;
  }
  return (
    threeDProviders(settings).find(
      (provider) => !provider.local && threeDProviderReady(provider.id, settings),
    )?.id ?? null
  );
}

function preferredReadyVideoProviderIdForProfile(
  settings: VideoGenerationSettings,
  profile: SettingsProfileOptions,
): VideoProviderId | null {
  if (!isRemoteSettingsProfile(profile.profileId)) {
    return preferredReadyVideoProviderId(settings);
  }
  if (
    videoProviderReady(settings.preferredProviderId, settings) &&
    !videoProviderById(settings.preferredProviderId, settings).local
  ) {
    return settings.preferredProviderId;
  }
  return (
    videoProviders(settings).find(
      (provider) => !provider.local && videoProviderReady(provider.id, settings),
    )?.id ?? null
  );
}

function preferredReadySpeechProviderIdForProfile(
  settings: SpeechGenerationSettings,
  profile: SettingsProfileOptions,
): SpeechProviderId | null {
  if (!isRemoteSettingsProfile(profile.profileId)) {
    return preferredReadySpeechProviderId(settings);
  }
  if (
    speechProviderReady(settings.preferredProviderId, settings) &&
    !speechProviderById(settings.preferredProviderId, settings).local
  ) {
    return settings.preferredProviderId;
  }
  return (
    speechProviders(settings).find(
      (provider) => !provider.local && speechProviderReady(provider.id, settings),
    )?.id ?? null
  );
}

function preferredReadyWorldModelProviderIdForProfile(
  settings: WorldModelGenerationSettings,
  profile: SettingsProfileOptions,
): WorldModelProviderId | null {
  if (!isRemoteSettingsProfile(profile.profileId)) {
    return preferredReadyWorldModelProviderId(settings);
  }
  if (
    worldModelProviderReady(settings.preferredProviderId, settings) &&
    !worldModelProviderById(settings.preferredProviderId, settings).local
  ) {
    return settings.preferredProviderId;
  }
  return (
    worldModelProviders(settings).find(
      (provider) =>
        !provider.local && worldModelProviderReady(provider.id, settings),
    )?.id ?? null
  );
}

const IMAGE_PROMPT_SYSTEM = `你是专业的"生图提示词工程师"。用户会给出一句关于想要生成的图片的描述或想法，你要把它扩写成一段高质量、可直接喂给文生图模型的提示词。
要求：
- 直接输出最终提示词正文，不要任何解释、前后缀、标题、引号或代码块。
- 补全画面主体、风格、构图、光线、色调、镜头/视角、画质等关键要素，使画面具体而协调。
- 保留用户明确指定的内容；用户没提到的细节由你做合理且不喧宾夺主的补充。
- 与用户输入语言保持一致（中文需求输出中文提示词，英文需求输出英文提示词）。
- 只描述要画什么，不要写"请生成/帮我画"之类的指令性措辞。`;

const MUSIC_PROMPT_SYSTEM = `你是专业的"音乐生成提示词工程师"。用户会给出一句关于想要生成的音乐、歌曲、BGM 或音频的描述，你要把它扩写成一段高质量、可直接喂给音乐生成模型的提示词。
要求：
- 直接输出最终提示词正文，不要任何解释、前后缀、标题、引号或代码块。
- 补全音乐类型、情绪、速度、乐器、编曲层次、段落结构、混音质感、是否有人声/歌词等关键要素。
- 保留用户明确指定的内容；用户没提到的细节由你做合理且不喧宾夺主的补充。
- 与用户输入语言保持一致（中文需求输出中文提示词，英文需求输出英文提示词）。
- 不要要求模仿现役艺人、受版权歌曲或具体受保护歌词；用可授权的风格描述替代。
- 只描述要生成什么音乐，不要写"请生成/帮我写"之类的指令性措辞。`;

const THREE_D_PROMPT_SYSTEM = `你是专业的"3D模型生成提示词工程师"。用户会给出一句关于想要生成的 3D 模型、游戏资产、道具、角色或产品模型的描述，你要把它扩写成一段高质量、可直接喂给文生 3D 模型的提示词。
要求：
- 直接输出最终提示词正文，不要任何解释、前后缀、标题、引号或代码块。
- 补全主体形体、比例、轮廓、结构细节、材质、PBR 贴图、拓扑/面数倾向、可用视角和导出目标等关键要素。
- 让模型聚焦单个可用 3D 资产；避免复杂背景、场景叙事、摄影机语言和纯 2D 画面描述。
- 骨骼/动画只用于能自然绑定的角色、生物、可动机器人或机械臂；石头、家具、武器、建筑、产品等静态资产不要写骨骼或动画。
- 保留用户明确指定的内容；用户没提到的细节由你做合理且不喧宾夺主的补充。
- 与用户输入语言保持一致（中文需求输出中文提示词，英文需求输出英文提示词）。
- 只描述要生成什么 3D 模型，不要写"请生成/帮我建模"之类的指令性措辞。`;

const VIDEO_PROMPT_SYSTEM = `你是专业的"视频生成提示词工程师"。用户会给出一句关于想要生成的视频、短片、镜头或动画的描述，你要把它扩写成一段高质量、可直接喂给文生视频模型的提示词。
要求：
- 直接输出最终提示词正文，不要任何解释、前后缀、标题、引号或代码块。
- 补全画面主体、动作、镜头运动（推拉摇移）、景别、构图、光线、色调、风格、节奏和时长意图等关键要素，让镜头连贯可拍。
- 让模型聚焦一个连贯的镜头或短片；避免一次塞入互相冲突的多个场景。
- 保留用户明确指定的内容；用户没提到的细节由你做合理且不喧宾夺主的补充。
- 不要要求模仿在世真人、受版权角色或受保护影片；用可授权的风格描述替代。
- 与用户输入语言保持一致（中文需求输出中文提示词，英文需求输出英文提示词）。
- 只描述要生成什么视频，不要写"请生成/帮我拍"之类的指令性措辞。`;

const SPEECH_PROMPT_SYSTEM = `你是专业的"配音文案撰稿人"。你的输出会被原样交给文字转语音(TTS)模型逐字朗读，所以你写出的就是要被念出来的最终台词本身，而不是对它的描述或指令。
请先判断用户输入属于哪一类：
- 「内容创作需求」：用户描述想要的内容（例如"讲一个催眠故事""来一段产品介绍""写一句欢迎语""读一首关于秋天的诗"），此时你要真正创作出可朗读的正文，而不是复述这句需求。
- 「逐字朗读需求」：用户直接给出了要朗读的文字（例如"朗读以下文字：……"或贴了一整段文案），此时基本保留原文，只做必要的清理（去掉"请朗读""帮我读一下"这类指令性措辞和多余引号），不要改写或扩写其内容。
通用要求：
- 只输出要被朗读的正文，不要任何解释、前后缀、标题、引号、括注、代码块或"（停顿）""旁白："之类的舞台提示。
- 文案要自然口语、适合朗读，标点节奏得当；不要出现 URL、表情符号、Markdown 符号或难以发音的特殊字符。
- 与用户输入语言保持一致（中文需求输出中文文案，英文需求输出英文文案）。
- 若用户提到时长（如"15秒""一分钟"），按中文每分钟约 220-260 字、英文每分钟约 130-150 词的语速，控制正文长度大致匹配该时长。
- 保留用户明确指定的措辞、称呼、品牌名和数字；用户没提到的细节由你做合理且贴合语气的补充。
- 不要写"请生成/帮我读/以下是"之类的指令性或交代性措辞，直接给出正文。`;

const SPRITE_PROMPT_SYSTEM = `你是专业的"Sprite 动画提示词工程师"。用户会给出一句关于想要生成的 sprite、spritesheet、像素角色、技能特效或动作帧的描述，你要把它扩写成一段高质量、可直接喂给 sprite 动画生成模型的提示词。
要求：
- 直接输出最终提示词正文，不要任何解释、前后缀、标题、引号或代码块。
- 补全主体、视角、动作、风格、帧数意图、循环方式、raw spritesheet 背景、裁切、安全边距、角色一致性、导出用途和验收标准。
- 优先生成单个主体；除非用户明确要求，不要多角色、复杂背景、文字、UI 或相机移动。
- 动画需求要说明动作阶段，例如 idle/walk/run/attack/jump/hit/death 或 VFX loop，并强调主体大小、朝向和中心位置稳定。
- Sprite sheet 要强调 exact grid、solid chroma key background、clean silhouette、consistent proportions、even frame spacing、game-ready sprite sheet。
- 如果目标是可抠底 Sprite，优先使用纯 #FF00FF raw 背景；不要要求模型直接画透明背景、格线、边框、文字或标签。
- 同一张 sheet 只包含一个动作；walk/run/attack/death 等不同动作要拆成不同 sheet。
- 强调所有帧主体尺度一致、根锚稳定、留安全边距、不贴边，方便后处理切帧、对齐、规范化和质检。
- 明确要求真实动画姿态变化，例如四肢、躯干、武器或特效形态随帧推进；不要用整体平移、缩放、旋转或重复姿势假装运动。
- 把输出定位为 raw sheet：原图要保留，并能用于后续生成 normalized sheet、frames、GIF preview、manifest metadata 和 QC report；不要让模型把这些说明画进图片里。
- 保留用户明确指定的内容；用户没提到的细节由你做合理且不喧宾夺主的补充。
- 不要要求模仿在世真人、受版权角色或受保护 IP；用可授权的风格描述替代。
- 与用户输入语言保持一致（中文需求输出中文提示词，英文需求输出英文提示词）。`;

function spritePromptSystem(settingsProfile: SettingsProfileOptions = {}): string {
  const settings = loadSpriteGenerationSettings(settingsProfile);
  const grid = spriteSheetGridForSettings(settings);
  return `${SPRITE_PROMPT_SYSTEM}

当前 Sprite Forge 兼容约束：
- 默认 sheet 网格：${grid.rows} 行 x ${grid.columns} 列，共 ${grid.cells} 帧。
- 默认单帧尺寸：${settings.defaultFrameSize}px；主体 fit scale：${settings.fitScale}。
- raw sheet 背景：${settings.removeBackground ? settings.chromaKey : 'transparent-or-clean'}；后处理应能按该背景抠底，并保留 raw 与 normalized 两类资产。
- 帧锚点：${settings.frameAnchor}；主体保留模式：${settings.componentMode}；${settings.rejectEdgeTouch ? '拒绝贴边帧' : '允许贴边帧'}。
- 交付目标：raw sheet 能被确定性流程切帧、对齐、打包、生成 manifest 和验收报告。`;
}

// ComfyUI authoring instruction. Unlike the image/music/3D prompt refiners
// (which produce a plain prompt string), this asks the coding model to emit a
// full ComfyUI prompt-graph as a ```comfyui fenced block, which the chat stream
// renders as an embedded, expandable node graph (ComfyGraphBlock).
export const COMFY_PROMPT_SYSTEM = `你是 ComfyUI 工作流工程师。用户会描述想要生成的图片或想要的工作流，你要输出一个可直接提交给本地 ComfyUI 服务器(POST /prompt)的 prompt graph。
严格要求：
- 只输出一个 \`\`\`comfyui 代码块，块内是合法 JSON；代码块之外不要写任何解释、标题或多余文字。
- JSON 结构为 ComfyUI 的 prompt 格式：顶层是 {"<节点id>": {"class_type": "<节点类型>", "inputs": {...}}} 的扁平映射。
- 节点之间的连线用 inputs 里的 ["<来源节点id>", <输出序号>] 表示;字面量(数字/字符串/布尔)直接写值。
- 只使用 ComfyUI 标准节点(如 CheckpointLoaderSimple、CLIPTextEncode、KSampler、EmptyLatentImage、VAEDecode、SaveImage 等),不要编造不存在的节点类型。
- 至少包含一条到 SaveImage(或等价输出节点)的完整通路,保证能真正出图。
- 可选地为每个节点加 "_meta": {"title": "..."} 以便阅读。
- JSON 内的文本提示词与用户输入语言保持一致。`;

/** Strip the /ui-mode-start|/ui-mode-end command prefix from a chat line. */
export function stripUiModeCommand(text: string): string {
  return text
    .trim()
    .replace(/^\/ui(?:-mode-(?:start|end))?\s*/iu, '')
    .trim();
}

// Game-UI design instruction for /ui-mode. Front-loaded before the coding-model
// turn so the model produces interface design specs and deliverables tailored to
// the globally configured default UI channel (Settings > UI 渠道),
// instead of editing the workflow blueprint.
export function uiDesignPromptSystem(
  settingsProfile: SettingsProfileOptions = {},
): string {
  const settings = loadUiDesignChannelSettings(settingsProfile);
  const channel = uiDesignChannelById(settings.preferredChannelId);
  const exportFormat = uiDesignChannelExportFormat(channel.id, settings);
  return `你是资深游戏 UI/UX 设计师。用户会描述想要的游戏界面，你要围绕当前项目选定的默认 UI 渠道「${channel.label}」产出可交付的界面设计方案。
要求：
- 紧扣「${channel.label}」这个设计工具/协作平台的能力来组织产物，默认导出格式为 ${exportFormat}。
- 给出清晰的界面结构：布局与分区、控件清单与状态、信息层级、交互流程、配色与字体规范、栅格与间距。
- 按游戏 UI 习惯覆盖 HUD、菜单、弹窗、按钮状态、图标规范等必要部分；说明可复用组件与设计系统约定。
- 如需资产，给出文件命名、切图尺寸/分辨率与导出清单；适配多分辨率时说明缩放策略。
- 与用户输入语言保持一致；只产出界面设计内容，不要修改工作流蓝图。`;
}

/** Strip the /blueprint-mode-start|/blueprint-mode-end command prefix from a chat line. */
export function stripBlueprintModeCommand(text: string): string {
  return text
    .trim()
    .replace(/^\/blueprint-mode-(?:start|end)\s*/iu, '')
    .trim();
}

export function blueprintModePromptSystem(modeArgs: string | null | undefined): string {
  const args = modeArgs?.trim();
  const argsLine = args
    ? `\n当前 /blueprint-mode-start 参数：${args}`
    : '';
  return `你现在处于 UE 蓝图模式。目标是帮助用户创建、修改、验证 Unreal Engine Blueprint 资产，不是 UltraGameStudio workflow 蓝图。
要求：
- 优先检查当前工作区是否是 UE 项目、BlueprintMode 插件是否已安装；如未安装，按项目设置里的安装逻辑从 GitHub 下载插件，或给出最短可执行步骤。
- 如果可通过 UE 编辑器插件、MCP、Remote Control、Python 或本地命令实际完成，就直接完成；只在确实缺少目标蓝图名、父类、创建确认等关键信息时使用交互协议询问。
- 蓝图不存在时，先提示用户确认是否创建；确认后默认按 Actor 蓝图创建，除非用户指定 Character、Pawn、GameMode、Widget、Function Library 等父类。
- 输出或执行内容围绕 BlueprintMode 操作：target、context、checkpoint、BlueprintOp 计划、spawn node、connect pin、set property、compile、verify、commit/discard。
- 不要生成 UltraGameStudio IRGraph，不要输出 workflow 蓝图 JSON，不要把需求改写成普通素材生成任务。
- 回答使用简体中文，结论先行。${argsLine}`;
}

/** Strip the /metahuman-mode-start|/metahuman-mode-end command prefix from a chat line. */
export function stripMetaHumanModeCommand(text: string): string {
  return text
    .trim()
    .replace(/^\/metahuman-mode-(?:start|end)\s*/iu, '')
    .trim();
}

export function metaHumanModePromptSystem(): string {
  return `你现在处于 MetaHuman MVP 模式。目标是把用户描述逐步推进为可在本地 Unreal Engine 中执行的 MetaHuman 角色生成/拟合流程。
核心流程：
1. 需求澄清与合规改写：把用户想要的脸型、气质、年龄、发型、肤色、体型、服装、相似度参考等转成可执行角色 brief。涉及真实名人时，避免承诺生成可识别复制品，转成面部特征和风格参考。
2. 参考图方案：生成正脸、3/4 侧脸、侧脸、多角度一致性提示词和负面提示词；图片只是参考，不要声称 MetaHuman 可直接吃普通单图。
3. 3D 人脸 mesh/参数拟合方案：选择单图/多图重建、FLAME/3DMM/landmark 拟合、或 3D 生成模型输出 OBJ/FBX；明确中性表情、睁眼、五官清晰、尺度和拓扑/贴图质量要求。
4. 本地 UE MetaHuman 步骤：导入 mesh，创建 MetaHuman Identity，Neutral Pose tracking，Identity Solve，必要时提交 Epic backend conform，Conform from Identity，生成 MetaHuman Character，配置材质、发型、体型、服装和 LOD。
5. 预览与验收：输出截图/短视频/低清预览，记录待修正项，再进入下一轮调整。
交互规则：
- 每轮只推进一个阶段或一个明确子步骤；不要一次性跳完整条管线。
- 每个阶段结束时必须让用户确认、选择或输入调整意见，才能进入下一阶段。
- 需要用户选择时，只输出完整的 <<UGS_ASK>> 交互协议块并立即结束本回合；不要在正文里写“请回复 1/2/3”。
- 需要用户自由修改时，用 input 类型交互块；需要在几个阶段动作间选择时，用 select；需要确认进入下一步时，用 confirm。
- 如果本轮已经收到用户的选择或调整内容，就直接据此更新方案并给出下一步交互块。
- 不要生成 UltraGameStudio IRGraph，不要输出 workflow 蓝图 JSON，不要把需求改写成普通素材生成任务。
- 回答使用简体中文，结论先行。`;
}

type GenerationPromptMode =
  | 'image'
  | 'music'
  | 'threeD'
  | 'video'
  | 'sprite'
  | 'speech'
  | 'world';

function generationModeStartedAt(
  composer: ComposerSettings,
  mode: GenerationPromptMode,
): number | null {
  const value =
    mode === 'image'
      ? composer.imageModeStartedAt
      : mode === 'music'
        ? composer.musicModeStartedAt
        : mode === 'threeD'
          ? composer.threeDModeStartedAt
          : mode === 'video'
            ? composer.videoModeStartedAt
            : mode === 'speech'
              ? composer.speechModeStartedAt
              : mode === 'world'
                ? composer.worldModeStartedAt
                : composer.spriteModeStartedAt;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function generationModeActive(
  composer: ComposerSettings,
  mode: GenerationPromptMode,
): boolean {
  return mode === 'image'
    ? composer.imageMode
    : mode === 'music'
      ? composer.musicMode
      : mode === 'threeD'
        ? composer.threeDMode
        : mode === 'video'
          ? composer.videoMode
        : mode === 'speech'
          ? composer.speechMode
          : mode === 'world'
            ? composer.worldMode
            : composer.spriteMode;
}

function generationModeEnteredText(mode: GenerationPromptMode, text: string): boolean {
  if (mode === 'image') return /已进入生图模式|image mode on/i.test(text);
  if (mode === 'music') return /已进入音乐模式|music mode on/i.test(text);
  if (mode === 'video') return /已进入视频模式|video mode on/i.test(text);
  if (mode === 'speech') return /已进入语音模式|speech mode on/i.test(text);
  if (mode === 'sprite') return /已进入\s*Sprite\s*模式|sprite mode on/i.test(text);
  if (mode === 'world') return /已进入世界模型模式|world-model mode on/i.test(text);
  return /已进入\s*Mesh\s*模式|mesh mode on/i.test(text);
}

function generationModeExitedText(mode: GenerationPromptMode, text: string): boolean {
  if (mode === 'image') return /已退出生图模式|image mode off/i.test(text);
  if (mode === 'music') return /已退出音乐模式|music mode off/i.test(text);
  if (mode === 'video') return /已退出视频模式|video mode off/i.test(text);
  if (mode === 'speech') return /已退出语音模式|speech mode off/i.test(text);
  if (mode === 'sprite') return /已退出\s*Sprite\s*模式|sprite mode off/i.test(text);
  if (mode === 'world') return /已退出世界模型模式|world-model mode off/i.test(text);
  return /已退出\s*Mesh\s*模式|mesh mode off/i.test(text);
}

function inferGenerationModeStartedAt(
  messages: readonly Message[],
  mode: GenerationPromptMode,
): number | null {
  let startedAt: number | null = null;
  for (const message of messages) {
    if (message.role !== 'system') continue;
    if (generationModeEnteredText(mode, message.text)) {
      startedAt = message.createdAt;
    } else if (generationModeExitedText(mode, message.text)) {
      startedAt = null;
    }
  }
  return startedAt;
}

function stripGenerationCommand(
  mode: GenerationPromptMode,
  text: string,
): string {
  if (mode === 'image') return stripImageCommand(text);
  if (mode === 'music') return stripMusicCommand(text);
  if (mode === 'video') return stripVideoCommand(text);
  if (mode === 'speech') return stripSpeechCommand(text);
  if (mode === 'sprite') return stripSpriteCommand(text);
  if (mode === 'world') return stripWorldModelCommand(text);
  return stripThreeDCommand(text);
}

function normalizeGenerationTurn(
  mode: GenerationPromptMode,
  text: string,
): string {
  return stripGenerationCommand(mode, text)
    .replace(/\s+/g, ' ')
    .trim();
}

function modeContextPrompt(
  state: Pick<StoreState, 'composer' | 'messages'>,
  mode: GenerationPromptMode,
  currentPrompt: string,
): string {
  const current = normalizeGenerationTurn(mode, currentPrompt);
  if (!generationModeActive(state.composer, mode)) {
    return current;
  }
  const startedAt =
    generationModeStartedAt(state.composer, mode) ??
    inferGenerationModeStartedAt(state.messages, mode) ??
    0;

  const priorTurns = state.messages
    .filter(
      (message) =>
        message.role === 'user' &&
        message.createdAt >= startedAt &&
        message.text.trim(),
    )
    .map((message) => normalizeGenerationTurn(mode, message.text))
    .filter(Boolean);
  const turns =
    priorTurns[priorTurns.length - 1] === current
      ? priorTurns
      : [...priorTurns, current];
  if (turns.length <= 1) return current;

  return [
    '本次生成模式内的连续需求如下，请合并成当前这一次的最终生成需求。',
    '规则：后面的补充优先；除非最新输入明确换主体，否则保留前文主体和约束。',
    ...turns.map((turn, index) => `${index + 1}. ${turn}`),
  ].join('\n');
}

/** Strip code fences / labels / surrounding quotes the model may wrap around the prompt. */
function cleanGeneratedImagePrompt(raw: string): string {
  let text = raw.trim();
  const fence = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(text);
  if (fence) text = fence[1].trim();
  text = text.replace(/^(?:生图提示词|提示词|prompt)\s*[:：]\s*/iu, '').trim();
  const quoted = /^["'「『]([\s\S]+)["'」』]$/u.exec(text);
  if (quoted) text = quoted[1].trim();
  return text;
}

function cleanGeneratedMusicPrompt(raw: string): string {
  let text = raw.trim();
  const fence = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(text);
  if (fence) text = fence[1].trim();
  text = text
    .replace(/^(?:音乐提示词|作曲提示词|提示词|prompt)\s*[:：]\s*/iu, '')
    .trim();
  const quoted = /^["'「『]([\s\S]+)["'」』]$/u.exec(text);
  if (quoted) text = quoted[1].trim();
  return text;
}

function cleanGeneratedThreeDPrompt(raw: string): string {
  let text = raw.trim();
  const fence = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(text);
  if (fence) text = fence[1].trim();
  text = text
    .replace(/^(?:3d\s*模型提示词|三维模型提示词|建模提示词|提示词|prompt)\s*[:：]\s*/iu, '')
    .trim();
  const quoted = /^["'「『]([\s\S]+)["'」』]$/u.exec(text);
  if (quoted) text = quoted[1].trim();
  return text;
}

function cleanGeneratedVideoPrompt(raw: string): string {
  let text = raw.trim();
  const fence = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(text);
  if (fence) text = fence[1].trim();
  text = text
    .replace(/^(?:视频提示词|分镜提示词|镜头提示词|提示词|prompt)\s*[:：]\s*/iu, '')
    .trim();
  const quoted = /^["'「『]([\s\S]+)["'」』]$/u.exec(text);
  if (quoted) text = quoted[1].trim();
  return text;
}

function cleanGeneratedSpritePrompt(raw: string): string {
  let text = raw.trim();
  const fence = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(text);
  if (fence) text = fence[1].trim();
  text = text
    .replace(/^(?:sprite\s*提示词|精灵图提示词|序列帧提示词|提示词|prompt)\s*[:：]\s*/iu, '')
    .trim();
  const quoted = /^["'「『]([\s\S]+)["'」』]$/u.exec(text);
  if (quoted) text = quoted[1].trim();
  return text;
}

function cleanGeneratedSpeechText(raw: string): string {
  let text = raw.trim();
  const fence = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(text);
  if (fence) text = fence[1].trim();
  text = text
    .replace(/^(?:配音文案|朗读文案|台词|文案|正文|text|script)\s*[:：]\s*/iu, '')
    .trim();
  const quoted = /^["'「『]([\s\S]+)["'」』]$/u.exec(text);
  if (quoted) text = quoted[1].trim();
  return text;
}

/**
 * Step 1 of the fixed two-step image flow: send the user's description to the
 * selected coding/text model and have it author a high-quality image-generation
 * prompt. Returns null when no text-model backend is reachable (e.g. browser
 * without an API key) so the caller can fall back to the raw user text. Honors
 * the channel's abort signal (direct) and cliRunIds (CLI) so 停止 cancels it.
 */
async function refineImagePromptViaModel(
  ch: AiEditChannel,
  userText: string,
  codingSelection: GatewaySelection,
  permission: string,
  onProgress: (live: string) => void,
): Promise<{ prompt: string; routeLine: string; routeHeader: string } | null> {
  const userContent = `请把下面的图片需求改写成一段高质量的生图提示词：\n\n${userText}`;
  const projectMcpGuidance = projectMcpGuidanceForState(useStore.getState(), {
    workspaceId: ch.workspaceId,
    sessionId: ch.sessionId,
  });
  const preferCliForProjectMcp = isTauri() && !!projectMcpGuidance;
  const system = `${IMAGE_PROMPT_SYSTEM}${projectMcpGuidance}`;
  const direct = resolveDirectGatewayRoute(codingSelection);
  if (direct && !preferCliForProjectMcp) {
    let full = '';
    const text = await completeGatewayText({
      route: direct,
      system,
      userContent,
      maxTokens: 1024,
      signal: ch.abortController.signal,
      usageContext: { workspaceId: ch.workspaceId, sessionId: ch.sessionId },
      permission,
      cwd: ch.workspaceRootPath ?? undefined,
      onDelta: (chunk) => {
        full += chunk;
        onProgress(full);
      },
    });
    return {
      prompt: cleanGeneratedImagePrompt(full || text),
      routeLine: gatewayRouteLine(direct),
      routeHeader: gatewayRouteHeader(direct),
    };
  }
  if (isTauri()) {
    if (isFreeChannelSelection(codingSelection)) {
      await ensureFreeProxy(freeProxyOptionsForSelection(codingSelection));
    }
    const cli = await resolveCliGatewayRoute(codingSelection);
    const runId = makeCliRunId();
    ch.cliRunIds.add(runId);
    try {
      let live = '';
      const text = await aiEditViaCli(
        `${system}\n\n${userContent}`,
        cli.adapter,
        {
          permission,
          model: cli.model,
          cliCommand: cli.cliCommand,
          env: cli.env,
          cwd: ch.workspaceRootPath ?? undefined,
          runId,
          onProgress: (chunk) => {
            live += chunk;
            onProgress(live);
          },
        },
      );
      return {
        prompt: cleanGeneratedImagePrompt(text || live),
        routeLine: gatewayRouteLine(cli),
        routeHeader: gatewayRouteHeader(cli),
      };
    } finally {
      ch.cliRunIds.delete(runId);
    }
  }
  return null;
}

async function refineMusicPromptViaModel(
  ch: AiEditChannel,
  userText: string,
  codingSelection: GatewaySelection,
  permission: string,
  onProgress: (live: string) => void,
): Promise<{ prompt: string; routeLine: string; routeHeader: string } | null> {
  const userContent = `请把下面的音乐需求改写成一段高质量的音乐生成提示词：\n\n${userText}`;
  const projectMcpGuidance = projectMcpGuidanceForState(useStore.getState(), {
    workspaceId: ch.workspaceId,
    sessionId: ch.sessionId,
  });
  const preferCliForProjectMcp = isTauri() && !!projectMcpGuidance;
  const system = `${MUSIC_PROMPT_SYSTEM}${projectMcpGuidance}`;
  const direct = resolveDirectGatewayRoute(codingSelection);
  if (direct && !preferCliForProjectMcp) {
    let full = '';
    const text = await completeGatewayText({
      route: direct,
      system,
      userContent,
      maxTokens: 1024,
      signal: ch.abortController.signal,
      usageContext: { workspaceId: ch.workspaceId, sessionId: ch.sessionId },
      permission,
      cwd: ch.workspaceRootPath ?? undefined,
      onDelta: (chunk) => {
        full += chunk;
        onProgress(full);
      },
    });
    return {
      prompt: cleanGeneratedMusicPrompt(full || text),
      routeLine: gatewayRouteLine(direct),
      routeHeader: gatewayRouteHeader(direct),
    };
  }
  if (isTauri()) {
    if (isFreeChannelSelection(codingSelection)) {
      await ensureFreeProxy(freeProxyOptionsForSelection(codingSelection));
    }
    const cli = await resolveCliGatewayRoute(codingSelection);
    const runId = makeCliRunId();
    ch.cliRunIds.add(runId);
    try {
      let live = '';
      const text = await aiEditViaCli(
        `${system}\n\n${userContent}`,
        cli.adapter,
        {
          permission,
          model: cli.model,
          cliCommand: cli.cliCommand,
          env: cli.env,
          cwd: ch.workspaceRootPath ?? undefined,
          runId,
          onProgress: (chunk) => {
            live += chunk;
            onProgress(live);
          },
        },
      );
      return {
        prompt: cleanGeneratedMusicPrompt(text || live),
        routeLine: gatewayRouteLine(cli),
        routeHeader: gatewayRouteHeader(cli),
      };
    } finally {
      ch.cliRunIds.delete(runId);
    }
  }
  return null;
}

async function refineSpeechPromptViaModel(
  ch: AiEditChannel,
  userText: string,
  codingSelection: GatewaySelection,
  permission: string,
  onProgress: (live: string) => void,
): Promise<{ prompt: string; routeLine: string; routeHeader: string } | null> {
  const userContent = `请把下面的语音需求转写成最终要被朗读的配音文案。如果用户是在描述想要的内容（如"讲一个故事""来段介绍"），就真正创作出可朗读的正文；如果用户直接给了要朗读的文字，就基本保留原文只做清理：\n\n${userText}`;
  const projectMcpGuidance = projectMcpGuidanceForState(useStore.getState(), {
    workspaceId: ch.workspaceId,
    sessionId: ch.sessionId,
  });
  const preferCliForProjectMcp = isTauri() && !!projectMcpGuidance;
  const system = `${SPEECH_PROMPT_SYSTEM}${projectMcpGuidance}`;
  const direct = resolveDirectGatewayRoute(codingSelection);
  if (direct && !preferCliForProjectMcp) {
    let full = '';
    const text = await completeGatewayText({
      route: direct,
      system,
      userContent,
      maxTokens: 2048,
      signal: ch.abortController.signal,
      usageContext: { workspaceId: ch.workspaceId, sessionId: ch.sessionId },
      permission,
      cwd: ch.workspaceRootPath ?? undefined,
      onDelta: (chunk) => {
        full += chunk;
        onProgress(full);
      },
    });
    return {
      prompt: cleanGeneratedSpeechText(full || text),
      routeLine: gatewayRouteLine(direct),
      routeHeader: gatewayRouteHeader(direct),
    };
  }
  if (isTauri()) {
    if (isFreeChannelSelection(codingSelection)) {
      await ensureFreeProxy(freeProxyOptionsForSelection(codingSelection));
    }
    const cli = await resolveCliGatewayRoute(codingSelection);
    const runId = makeCliRunId();
    ch.cliRunIds.add(runId);
    try {
      let live = '';
      const text = await aiEditViaCli(
        `${system}\n\n${userContent}`,
        cli.adapter,
        {
          permission,
          model: cli.model,
          cliCommand: cli.cliCommand,
          env: cli.env,
          cwd: ch.workspaceRootPath ?? undefined,
          runId,
          onProgress: (chunk) => {
            live += chunk;
            onProgress(live);
          },
        },
      );
      return {
        prompt: cleanGeneratedSpeechText(text || live),
        routeLine: gatewayRouteLine(cli),
        routeHeader: gatewayRouteHeader(cli),
      };
    } finally {
      ch.cliRunIds.delete(runId);
    }
  }
  return null;
}

async function refineThreeDPromptViaModel(
  ch: AiEditChannel,
  userText: string,
  codingSelection: GatewaySelection,
  permission: string,
  onProgress: (live: string) => void,
): Promise<{ prompt: string; routeLine: string; routeHeader: string } | null> {
  const userContent = `请把下面的 3D 模型需求改写成一段高质量的文生 3D 提示词。
${threeDRiggingPromptGuidance(userText)}

原始需求：
${userText}`;
  const projectMcpGuidance = projectMcpGuidanceForState(useStore.getState(), {
    workspaceId: ch.workspaceId,
    sessionId: ch.sessionId,
  });
  const preferCliForProjectMcp = isTauri() && !!projectMcpGuidance;
  const system = `${THREE_D_PROMPT_SYSTEM}${projectMcpGuidance}`;
  const direct = resolveDirectGatewayRoute(codingSelection);
  if (direct && !preferCliForProjectMcp) {
    let full = '';
    const text = await completeGatewayText({
      route: direct,
      system,
      userContent,
      maxTokens: 1024,
      signal: ch.abortController.signal,
      usageContext: { workspaceId: ch.workspaceId, sessionId: ch.sessionId },
      permission,
      cwd: ch.workspaceRootPath ?? undefined,
      onDelta: (chunk) => {
        full += chunk;
        onProgress(full);
      },
    });
    return {
      prompt: cleanGeneratedThreeDPrompt(full || text),
      routeLine: gatewayRouteLine(direct),
      routeHeader: gatewayRouteHeader(direct),
    };
  }
  if (isTauri()) {
    if (isFreeChannelSelection(codingSelection)) {
      await ensureFreeProxy(freeProxyOptionsForSelection(codingSelection));
    }
    const cli = await resolveCliGatewayRoute(codingSelection);
    const runId = makeCliRunId();
    ch.cliRunIds.add(runId);
    try {
      let live = '';
      const text = await aiEditViaCli(
        `${system}\n\n${userContent}`,
        cli.adapter,
        {
          permission,
          model: cli.model,
          cliCommand: cli.cliCommand,
          env: cli.env,
          cwd: ch.workspaceRootPath ?? undefined,
          runId,
          onProgress: (chunk) => {
            live += chunk;
            onProgress(live);
          },
        },
      );
      return {
        prompt: cleanGeneratedThreeDPrompt(text || live),
        routeLine: gatewayRouteLine(cli),
        routeHeader: gatewayRouteHeader(cli),
      };
    } finally {
      ch.cliRunIds.delete(runId);
    }
  }
  return null;
}

async function refineVideoPromptViaModel(
  ch: AiEditChannel,
  userText: string,
  codingSelection: GatewaySelection,
  permission: string,
  onProgress: (live: string) => void,
): Promise<{ prompt: string; routeLine: string; routeHeader: string } | null> {
  const userContent = `请把下面的视频需求改写成一段高质量的文生视频提示词：\n\n${userText}`;
  const projectMcpGuidance = projectMcpGuidanceForState(useStore.getState(), {
    workspaceId: ch.workspaceId,
    sessionId: ch.sessionId,
  });
  const preferCliForProjectMcp = isTauri() && !!projectMcpGuidance;
  const system = `${VIDEO_PROMPT_SYSTEM}${projectMcpGuidance}`;
  const direct = resolveDirectGatewayRoute(codingSelection);
  if (direct && !preferCliForProjectMcp) {
    let full = '';
    const text = await completeGatewayText({
      route: direct,
      system,
      userContent,
      maxTokens: 1024,
      signal: ch.abortController.signal,
      usageContext: { workspaceId: ch.workspaceId, sessionId: ch.sessionId },
      permission,
      cwd: ch.workspaceRootPath ?? undefined,
      onDelta: (chunk) => {
        full += chunk;
        onProgress(full);
      },
    });
    return {
      prompt: cleanGeneratedVideoPrompt(full || text),
      routeLine: gatewayRouteLine(direct),
      routeHeader: gatewayRouteHeader(direct),
    };
  }
  if (isTauri()) {
    if (isFreeChannelSelection(codingSelection)) {
      await ensureFreeProxy(freeProxyOptionsForSelection(codingSelection));
    }
    const cli = await resolveCliGatewayRoute(codingSelection);
    const runId = makeCliRunId();
    ch.cliRunIds.add(runId);
    try {
      let live = '';
      const text = await aiEditViaCli(
        `${system}\n\n${userContent}`,
        cli.adapter,
        {
          permission,
          model: cli.model,
          cliCommand: cli.cliCommand,
          env: cli.env,
          cwd: ch.workspaceRootPath ?? undefined,
          runId,
          onProgress: (chunk) => {
            live += chunk;
            onProgress(live);
          },
        },
      );
      return {
        prompt: cleanGeneratedVideoPrompt(text || live),
        routeLine: gatewayRouteLine(cli),
        routeHeader: gatewayRouteHeader(cli),
      };
    } finally {
      ch.cliRunIds.delete(runId);
    }
  }
  return null;
}

async function refineSpritePromptViaModel(
  ch: AiEditChannel,
  userText: string,
  codingSelection: GatewaySelection,
  permission: string,
  onProgress: (live: string) => void,
): Promise<{ prompt: string; routeLine: string; routeHeader: string } | null> {
  const userContent = `请把下面的 Sprite / spritesheet 动画需求改写成一段高质量的生成提示词：\n\n${userText}`;
  const projectMcpGuidance = projectMcpGuidanceForState(useStore.getState(), {
    workspaceId: ch.workspaceId,
    sessionId: ch.sessionId,
  });
  const preferCliForProjectMcp = isTauri() && !!projectMcpGuidance;
  const system = `${spritePromptSystem(
    generationSettingsProfileForState(useStore.getState()),
  )}${projectMcpGuidance}`;
  const direct = resolveDirectGatewayRoute(codingSelection);
  if (direct && !preferCliForProjectMcp) {
    let full = '';
    const text = await completeGatewayText({
      route: direct,
      system,
      userContent,
      maxTokens: 1024,
      signal: ch.abortController.signal,
      usageContext: { workspaceId: ch.workspaceId, sessionId: ch.sessionId },
      permission,
      cwd: ch.workspaceRootPath ?? undefined,
      onDelta: (chunk) => {
        full += chunk;
        onProgress(full);
      },
    });
    return {
      prompt: cleanGeneratedSpritePrompt(full || text),
      routeLine: gatewayRouteLine(direct),
      routeHeader: gatewayRouteHeader(direct),
    };
  }
  if (isTauri()) {
    if (isFreeChannelSelection(codingSelection)) {
      await ensureFreeProxy(freeProxyOptionsForSelection(codingSelection));
    }
    const cli = await resolveCliGatewayRoute(codingSelection);
    const runId = makeCliRunId();
    ch.cliRunIds.add(runId);
    try {
      let live = '';
      const text = await aiEditViaCli(
        `${system}\n\n${userContent}`,
        cli.adapter,
        {
          permission,
          model: cli.model,
          cliCommand: cli.cliCommand,
          env: cli.env,
          cwd: ch.workspaceRootPath ?? undefined,
          runId,
          onProgress: (chunk) => {
            live += chunk;
            onProgress(live);
          },
        },
      );
      return {
        prompt: cleanGeneratedSpritePrompt(text || live),
        routeLine: gatewayRouteLine(cli),
        routeHeader: gatewayRouteHeader(cli),
      };
    } finally {
      ch.cliRunIds.delete(runId);
    }
  }
  return null;
}

export function startImageGenerationTurn(
  text: string,
  options: { providerId?: ImageProviderId; model?: string } = {},
): void {
  const prompt = stripImageCommand(text);
  if (!prompt) return;
  const state = useStore.getState();
  if (isWorkflowReadOnly(state)) return;
  const generationPrompt = modeContextPrompt(state, 'image', prompt);
  const sessionKey = activeWorkflowSessionKey(state);
  const settingsProfile = generationSettingsProfileForState(state);
  const settings = loadImageGenerationSettings(settingsProfile);
  const requestedProviderId = options.providerId;
  const providerId =
    requestedProviderId &&
    (!isRemoteSettingsProfile(settingsProfile.profileId) ||
      !imageProviderById(requestedProviderId, settings).local)
      ? requestedProviderId
      : preferredReadyImageProviderIdForProfile(settings, settingsProfile);
  if (!providerId) {
    useStore
      .getState()
      .appendChatNote(
        `✗ ${friendlyImageGenerationError('NO_READY_IMAGE_PROVIDER')}`,
        'system',
      );
    return;
  }
  if (!imageProviderReady(providerId, settings)) {
    useStore
      .getState()
      .appendChatNote(
        `✗ ${friendlyImageGenerationError(`IMAGE_PROVIDER_NOT_READY:${providerId}`)}`,
        'system',
      );
    return;
  }
  // The coding/text model that authors the image prompt (step 1) is the channel
  // the composer currently has selected — image mode only swaps the image
  // provider selectors, not composer.model. Permission mirrors the composer so a
  // CLI run behaves like the rest of the app.
  const codingSelection = workflowDefaultGatewaySelection(
    state.workflow,
    state.composer.model,
  );
  const codingPermission = state.composer.permission || 'full';

  if (state.blockedSendTip) useStore.setState({ blockedSendTip: null });

  const now = Date.now();
  const providerLabel = providerId
    ? imageProviderById(providerId, settings).label
    : 'Image generation';
  const model = providerId
    ? options.model?.trim() ||
      settings.providerModels[providerId]?.trim() ||
      imageProviderById(providerId, settings).defaultModel
    : options.model?.trim() || '';
  const userMsg: Message = {
    id: shortId('m'),
    role: 'user',
    text,
    createdAt: now,
  };
  linkMessageManagedAssets(userMsg, sessionKey);
  const assistantId = shortId('m');
  const assistantMsg: Message = {
    id: assistantId,
    role: 'assistant',
    text: `⚙ 出图：${providerLabel}${model ? ` · 模型：${model}` : ''}\n① 正在让模型撰写生图提示词…`,
    routeLabel: model ? `${providerLabel} · ${model}` : providerLabel,
    createdAt: now + 1,
  };
  const promptUpdate = applyPromptTitle(state, prompt, now);
  const activeSession = sessionForKey(state, sessionKey);
  const simpleMode = promptUpdate.workflow.meta?.simple === true;
  const baseMessages = state.messages;
  const chSessionKey = runKey(sessionKey.workspaceId, sessionKey.sessionId);
  const workspaceRootPath = sessionChangesRootPathForSession(state, sessionKey);
  const ch: AiEditChannel = {
    key: chatTurnKey(chSessionKey, userMsg.id),
    sessionKey: chSessionKey,
    workspaceId: sessionKey.workspaceId,
    sessionId: sessionKey.sessionId,
    workspaceRootPath,
    workflow: promptUpdate.workflow,
    messages: [...baseMessages, userMsg, assistantMsg],
    cliRunIds: new Set<string>(),
    abortController: new AbortController(),
    workflowSession: activeSession?.isWorkflow ?? !simpleMode,
    chat: true,
    ownedMessageIds: new Set<string>([userMsg.id, assistantId]),
  };

  const setAssistant = (textValue: string, persist: boolean) => {
    if (!aiEditRegistered(ch)) return;
    ch.messages = ch.messages.map((message) =>
      message.id === assistantId
        ? {
            ...message,
            text: textValue,
            routeLabel: model ? `${providerLabel} · ${model}` : providerLabel,
          }
        : message,
    );
    aiEditCommitMessages(ch, persist);
  };

  addAiEditChannel(ch);
  if (aiEditViewActive(ch)) {
    useStore.setState({
      messages: ch.messages,
      sessions: promptUpdate.sessions,
      sessionTree: promptUpdate.sessionTree,
      workflow: ch.workflow,
    });
  }
  updateAiEditSessionSummary(ch);
  if (ch.workspaceId && ch.sessionId) {
    void historyStore
      .updateSession(ch.workspaceId, ch.sessionId, {
        messages: ch.messages,
        ...(ch.workflowSession ? { workflow: ch.workflow } : {}),
        meta: { runStatus: 'running' },
      })
      .catch(() => {});
  }
  syncAndPersistSessionRunStatus(sessionKey, 'running');

  void (async () => {
    const startedAt = Date.now();
    const elapsed = () =>
      `⏱ ${formatClock(startedAt)} → ${formatClock(Date.now())} · 耗时 ${formatDuration(
        Date.now() - startedAt,
      )}`;
    let pendingAssetId: string | null = null;
    try {
      // ── Step ① — ask the selected coding/text model to author the image
      // prompt. When no text-model backend is reachable (browser without an API
      // key, tests) refineImagePromptViaModel returns null and we fall back to
      // the raw user text so image generation still works end to end.
      let imagePrompt = generationPrompt;
      let refineHeader = '';
      try {
        const refined = await refineImagePromptViaModel(
          ch,
          generationPrompt,
          codingSelection,
          codingPermission,
          (live) => {
            if (!aiEditRegistered(ch)) return;
            setAssistant(
              `${elapsed()}\n① 撰写生图提示词中…\n\n${live.trim() || '⟳ 生成中…'}`,
              false,
            );
          },
        );
        if (refined && refined.prompt) {
          imagePrompt = refined.prompt;
          refineHeader = refined.routeHeader;
        }
      } catch (err) {
        if (ch.abortController.signal.aborted || !aiEditRegistered(ch)) return;
        // Prompt authoring failed (model error/timeout). Degrade to the raw
        // user text rather than failing the whole turn.
        imagePrompt = generationPrompt;
      }
      if (!aiEditRegistered(ch)) return;

      // ── Step ② — feed the authored prompt to the image model. `text:false`
      // skips stripImageCommand inside generateImage (already a clean prompt).
      const promptModelLine = refineHeader
        ? `✎ 提示词模型：${refineHeader}\n`
        : '';
      pendingAssetId = registerPendingGeneratedAsset({
        kind: 'image',
        origin: imageProviderById(providerId, settings).local ? 'local' : 'remote',
        provider: providerLabel,
        model,
        prompt: imagePrompt,
        sessionId: ch.sessionId,
        workspaceId: ch.workspaceId,
        messageId: assistantId,
        titlePrefix: 'image',
      });
      setAssistant(
        `${elapsed()}\n${promptModelLine}② 已生成提示词，正在出图…\n\n生图提示词：${imagePrompt}`,
        false,
      );
      // ── Step ③ — generate, then run the visual-QA closed loop: a vision model
      // judges the image against the prompt; on a low score we fold its defect
      // feedback into the prompt and regenerate, up to verifyMaxRetries times.
      // Verification only runs when enabled AND the coding channel resolves to a
      // direct (vision-capable) route; otherwise it degrades to a single pass.
      const verifyOn =
        settings.verifyEnabled && canVerifyAsset(codingSelection);
      const maxAttempts = verifyOn ? 1 + Math.max(0, settings.verifyMaxRetries) : 1;
      let attemptPrompt = imagePrompt;
      let result = await generateImage(
        { prompt: attemptPrompt, providerId, model, signal: ch.abortController.signal },
        settings,
      );
      let verifyNote = '';
      for (let attempt = 1; verifyOn && attempt <= maxAttempts; attempt += 1) {
        if (!aiEditRegistered(ch) || ch.abortController.signal.aborted) return;
        setAssistant(
          `${elapsed()}\n${promptModelLine}③ 正在视觉验证第 ${attempt} 版…`,
          false,
        );
        let verdict;
        try {
          verdict = await verifyAsset({
            kind: 'image',
            prompt: attemptPrompt,
            sources: result.images,
            selection: codingSelection,
            threshold: settings.verifyThreshold,
            permission: codingPermission,
            signal: ch.abortController.signal,
            cwd: ch.workspaceRootPath ?? undefined,
            workspaceId: ch.workspaceId,
            sessionId: ch.sessionId,
          });
        } catch {
          // Verification failed (model/network). Keep the current image rather
          // than failing the turn or burning more quota.
          verdict = null;
        }
        if (!verdict) break;
        const defectLine = verdict.defects.length
          ? `；问题：${verdict.defects.join('、')}`
          : '';
        if (verdict.pass || attempt >= maxAttempts || !verdict.promptPatch) {
          verifyNote = verdict.pass
            ? `\n✓ 视觉验证通过（评分 ${verdict.score}，第 ${attempt} 版）`
            : `\n⚠ 已达重生成上限，采用第 ${attempt} 版（评分 ${verdict.score}${defectLine}）`;
          break;
        }
        verifyNote = `\n🔎 第 ${attempt} 版评分 ${verdict.score}${defectLine}，按反馈修正后重生成…`;
        setAssistant(`${elapsed()}\n${promptModelLine}${verifyNote.trim()}`, false);
        attemptPrompt = `${imagePrompt}\n\n【质检修正】${verdict.promptPatch}`;
        result = await generateImage(
          { prompt: attemptPrompt, providerId, model, signal: ch.abortController.signal },
          settings,
        );
      }
      const body = imageResultMarkdown(result);
      setAssistant(`${elapsed()}\n${promptModelLine}${body}${verifyNote}`, true);
      const capturePendingAssetId = pendingAssetId;
      pendingAssetId = null;
      void captureGeneratedAssets({
        kind: 'image',
        sources: result.images,
        origin: imageProviderById(result.providerId, settings).local ? 'local' : 'remote',
        provider: result.providerLabel,
        model: result.model,
        prompt: result.prompt,
        sessionId: ch.sessionId ?? undefined,
        workspaceId: ch.workspaceId,
        messageId: assistantId,
        cwd: ch.workspaceRootPath ?? undefined,
        titlePrefix: 'image',
        pendingAssetId: capturePendingAssetId ?? undefined,
      });
      commitAiChannelBlueprint(ch, appendStartUserInputs(ch.workflow, [text]));
      syncAndPersistSessionRunStatus(sessionKey, 'success');
    } catch (err) {
      if (!aiEditRegistered(ch)) return;
      if (ch.abortController.signal.aborted) return;
      const rawMsg = err instanceof Error ? err.message : String(err);
      const msg = friendlyImageGenerationError(rawMsg);
      if (pendingAssetId) markAssetFailed(pendingAssetId, msg);
      setAssistant(
        `${elapsed()} · 失败\n✗ 图片生成失败: ${msg}\n\n请在设置 > 生图中配置可用的图片 Provider，或切换到本地 ComfyUI。`,
        true,
      );
      syncAndPersistSessionRunStatus(sessionKey, 'error');
    } finally {
      removeAiEditChannel(ch);
    }
  })();
}

export function startMusicGenerationTurn(
  text: string,
  options: { providerId?: MusicProviderId; model?: string } = {},
): void {
  const prompt = stripMusicCommand(text);
  if (!prompt) return;
  const state = useStore.getState();
  if (isWorkflowReadOnly(state)) return;
  const generationPrompt = modeContextPrompt(state, 'music', prompt);
  const sessionKey = activeWorkflowSessionKey(state);
  const settingsProfile = generationSettingsProfileForState(state);
  const settings = loadMusicGenerationSettings(settingsProfile);
  const requestedProviderId = options.providerId;
  const providerId =
    requestedProviderId &&
    (!isRemoteSettingsProfile(settingsProfile.profileId) ||
      !musicProviderById(requestedProviderId, settings).local)
      ? requestedProviderId
      : preferredReadyMusicProviderIdForProfile(settings, settingsProfile);
  if (!providerId) {
    useStore
      .getState()
      .appendChatNote('✗ 当前项目没有可用的音乐生成渠道。请在设置中为当前项目配置在线渠道。', 'system');
    return;
  }
  const codingSelection = workflowDefaultGatewaySelection(
    state.workflow,
    state.composer.model,
  );
  const codingPermission = state.composer.permission || 'full';

  if (state.blockedSendTip) useStore.setState({ blockedSendTip: null });

  const now = Date.now();
  const providerLabel = providerId
    ? musicProviderById(providerId, settings).label
    : 'Music generation';
  const provider = providerId ? musicProviderById(providerId, settings) : null;
  const model = providerId
    ? options.model?.trim() || musicProviderModel(providerId, settings)
    : options.model?.trim() || '';
  const userMsg: Message = {
    id: shortId('m'),
    role: 'user',
    text,
    createdAt: now,
  };
  linkMessageManagedAssets(userMsg, sessionKey);
  const assistantId = shortId('m');
  const assistantMsg: Message = {
    id: assistantId,
    role: 'assistant',
    text: `⚙ 作曲：${providerLabel}${model ? ` · 模型：${model}` : ''}\n① 正在让模型撰写音乐提示词…`,
    routeLabel: model ? `${providerLabel} · ${model}` : providerLabel,
    createdAt: now + 1,
  };
  const promptUpdate = applyPromptTitle(state, prompt, now);
  const activeSession = sessionForKey(state, sessionKey);
  const simpleMode = promptUpdate.workflow.meta?.simple === true;
  const baseMessages = state.messages;
  const chSessionKey = runKey(sessionKey.workspaceId, sessionKey.sessionId);
  const workspaceRootPath = sessionChangesRootPathForSession(state, sessionKey);
  const ch: AiEditChannel = {
    key: chatTurnKey(chSessionKey, userMsg.id),
    sessionKey: chSessionKey,
    workspaceId: sessionKey.workspaceId,
    sessionId: sessionKey.sessionId,
    workspaceRootPath,
    workflow: promptUpdate.workflow,
    messages: [...baseMessages, userMsg, assistantMsg],
    cliRunIds: new Set<string>(),
    abortController: new AbortController(),
    workflowSession: activeSession?.isWorkflow ?? !simpleMode,
    chat: true,
    ownedMessageIds: new Set<string>([userMsg.id, assistantId]),
  };

  const setAssistant = (textValue: string, persist: boolean) => {
    if (!aiEditRegistered(ch)) return;
    ch.messages = ch.messages.map((message) =>
      message.id === assistantId
        ? {
            ...message,
            text: textValue,
            routeLabel: model ? `${providerLabel} · ${model}` : providerLabel,
          }
        : message,
    );
    aiEditCommitMessages(ch, persist);
  };

  addAiEditChannel(ch);
  if (aiEditViewActive(ch)) {
    useStore.setState({
      messages: ch.messages,
      sessions: promptUpdate.sessions,
      sessionTree: promptUpdate.sessionTree,
      workflow: ch.workflow,
    });
  }
  updateAiEditSessionSummary(ch);
  if (ch.workspaceId && ch.sessionId) {
    void historyStore
      .updateSession(ch.workspaceId, ch.sessionId, {
        messages: ch.messages,
        ...(ch.workflowSession ? { workflow: ch.workflow } : {}),
        meta: { runStatus: 'running' },
      })
      .catch(() => {});
  }
  syncAndPersistSessionRunStatus(sessionKey, 'running');

  void (async () => {
    const startedAt = Date.now();
    const elapsed = () =>
      `⏱ ${formatClock(startedAt)} → ${formatClock(Date.now())} · 耗时 ${formatDuration(
        Date.now() - startedAt,
      )}`;
    let pendingAssetId: string | null = null;
    try {
      let musicPrompt = generationPrompt;
      let refineHeader = '';
      try {
        const refined = await refineMusicPromptViaModel(
          ch,
          generationPrompt,
          codingSelection,
          codingPermission,
          (live) => {
            if (!aiEditRegistered(ch)) return;
            setAssistant(
              `${elapsed()}\n① 撰写音乐提示词中…\n\n${live.trim() || '⟳ 生成中…'}`,
              false,
            );
          },
        );
        if (refined && refined.prompt) {
          musicPrompt = refined.prompt;
          refineHeader = refined.routeHeader;
        }
      } catch (err) {
        if (ch.abortController.signal.aborted || !aiEditRegistered(ch)) return;
        musicPrompt = generationPrompt;
      }
      if (!aiEditRegistered(ch)) return;
      const promptModelLine = refineHeader
        ? `✎ 提示词模型：${refineHeader}\n`
        : '';
      pendingAssetId = registerPendingGeneratedAsset({
        kind: 'music',
        origin: provider?.local ? 'local' : 'remote',
        provider: providerLabel,
        model,
        prompt: musicPrompt,
        sessionId: ch.sessionId,
        workspaceId: ch.workspaceId,
        messageId: assistantId,
        titlePrefix: 'music',
      });
      setAssistant(
        `${elapsed()}\n${promptModelLine}② 已生成提示词，正在调用${
          provider?.local ? '本地音乐模型' : '音乐 API'
        }…\n\n音乐提示词：${musicPrompt}`,
        false,
      );
      const result = await generateMusic(
        {
          prompt: musicPrompt,
          providerId,
          model,
          targetDurationSeconds:
            musicDurationSecondsFromPrompt(musicPrompt) ?? undefined,
          signal: ch.abortController.signal,
        },
        settings,
      );
      setAssistant(`${elapsed()}\n${promptModelLine}${musicResultMarkdown(result)}`, true);
      const capturePendingAssetId = pendingAssetId;
      pendingAssetId = null;
      void captureGeneratedAssets({
        kind: 'music',
        sources: result.audios,
        origin: musicProviderById(result.providerId, settings).local ? 'local' : 'remote',
        provider: result.providerLabel,
        model: result.model,
        prompt: result.prompt,
        sessionId: ch.sessionId ?? undefined,
        workspaceId: ch.workspaceId,
        messageId: assistantId,
        cwd: ch.workspaceRootPath ?? undefined,
        titlePrefix: 'music',
        pendingAssetId: capturePendingAssetId ?? undefined,
      });
      commitAiChannelBlueprint(ch, appendStartUserInputs(ch.workflow, [text]));
      syncAndPersistSessionRunStatus(sessionKey, 'success');
    } catch (err) {
      if (!aiEditRegistered(ch)) return;
      const msg = err instanceof Error ? err.message : String(err);
      if (pendingAssetId) markAssetFailed(pendingAssetId, msg);
      setAssistant(
        `${elapsed()} · 失败\n✗ 音乐生成失败: ${msg}\n\n请在设置 > 音乐渠道中配置可用的商用或免费 Provider。`,
        true,
      );
      syncAndPersistSessionRunStatus(sessionKey, 'error');
    } finally {
      removeAiEditChannel(ch);
    }
  })();
}

export function startThreeDGenerationTurn(
  text: string,
  options: { providerId?: ThreeDProviderId; model?: string } = {},
): void {
  const prompt = stripThreeDCommand(text);
  if (!prompt) return;
  const state = useStore.getState();
  if (isWorkflowReadOnly(state)) return;
  const generationPrompt = modeContextPrompt(state, 'threeD', prompt);
  const sessionKey = activeWorkflowSessionKey(state);
  const settingsProfile = generationSettingsProfileForState(state);
  const settings = loadThreeDGenerationSettings(settingsProfile);
  const requestedProviderId = options.providerId;
  const providerId =
    requestedProviderId &&
    (!isRemoteSettingsProfile(settingsProfile.profileId) ||
      !threeDProviderById(requestedProviderId, settings).local)
      ? requestedProviderId
      : preferredReadyThreeDProviderIdForProfile(settings, settingsProfile);
  if (!providerId) {
    useStore
      .getState()
      .appendChatNote('✗ 当前项目没有可用的 3D 生成渠道。请在设置中为当前项目配置在线渠道。', 'system');
    return;
  }
  const codingSelection = workflowDefaultGatewaySelection(
    state.workflow,
    state.composer.model,
  );
  const codingPermission = state.composer.permission || 'full';

  if (state.blockedSendTip) useStore.setState({ blockedSendTip: null });

  const now = Date.now();
  const providerLabel = providerId
    ? threeDProviderById(providerId, settings).label
    : '3D generation';
  const provider = providerId ? threeDProviderById(providerId, settings) : null;
  const model = providerId
    ? options.model?.trim() || threeDProviderModel(providerId, settings)
    : options.model?.trim() || '';
  const rigging = assessThreeDRigging(generationPrompt);
  const userMsg: Message = {
    id: shortId('m'),
    role: 'user',
    text,
    createdAt: now,
  };
  linkMessageManagedAssets(userMsg, sessionKey);
  const assistantId = shortId('m');
  const assistantMsg: Message = {
    id: assistantId,
    role: 'assistant',
    text: `⚙ 3D：${providerLabel}${model ? ` · 模型：${model}` : ''}\n骨骼：${
      rigging.enabled
        ? `可绑骨资产，默认预览 ${rigging.defaultAnimations.join('、')}${
            rigging.requestedAnimations.length
              ? `，额外动作 ${rigging.requestedAnimations.join('、')}${
                  rigging.needsAnimationSearch ? ' 需匹配动画库' : ''
                }`
              : ''
          }`
        : '静态资产，跳过'
    }\n① 正在让模型撰写 3D 提示词…`,
    routeLabel: model ? `${providerLabel} · ${model}` : providerLabel,
    createdAt: now + 1,
  };
  const promptUpdate = applyPromptTitle(state, prompt, now);
  const activeSession = sessionForKey(state, sessionKey);
  const simpleMode = promptUpdate.workflow.meta?.simple === true;
  const baseMessages = state.messages;
  const chSessionKey = runKey(sessionKey.workspaceId, sessionKey.sessionId);
  const workspaceRootPath = sessionChangesRootPathForSession(state, sessionKey);
  const ch: AiEditChannel = {
    key: chatTurnKey(chSessionKey, userMsg.id),
    sessionKey: chSessionKey,
    workspaceId: sessionKey.workspaceId,
    sessionId: sessionKey.sessionId,
    workspaceRootPath,
    workflow: promptUpdate.workflow,
    messages: [...baseMessages, userMsg, assistantMsg],
    cliRunIds: new Set<string>(),
    abortController: new AbortController(),
    workflowSession: activeSession?.isWorkflow ?? !simpleMode,
    chat: true,
    ownedMessageIds: new Set<string>([userMsg.id, assistantId]),
  };

  const setAssistant = (textValue: string, persist: boolean) => {
    if (!aiEditRegistered(ch)) return;
    ch.messages = ch.messages.map((message) =>
      message.id === assistantId
        ? {
            ...message,
            text: textValue,
            routeLabel: model ? `${providerLabel} · ${model}` : providerLabel,
          }
        : message,
    );
    aiEditCommitMessages(ch, persist);
  };

  addAiEditChannel(ch);
  if (aiEditViewActive(ch)) {
    useStore.setState({
      messages: ch.messages,
      sessions: promptUpdate.sessions,
      sessionTree: promptUpdate.sessionTree,
      workflow: ch.workflow,
    });
  }
  updateAiEditSessionSummary(ch);
  if (ch.workspaceId && ch.sessionId) {
    void historyStore
      .updateSession(ch.workspaceId, ch.sessionId, {
        messages: ch.messages,
        ...(ch.workflowSession ? { workflow: ch.workflow } : {}),
        meta: { runStatus: 'running' },
      })
      .catch(() => {});
  }
  syncAndPersistSessionRunStatus(sessionKey, 'running');

  void (async () => {
    const startedAt = Date.now();
    const elapsed = () =>
      `⏱ ${formatClock(startedAt)} → ${formatClock(Date.now())} · 耗时 ${formatDuration(
        Date.now() - startedAt,
      )}`;
    let pendingAssetId: string | null = null;
    try {
      let threeDPrompt = generationPrompt;
      let refineHeader = '';
      try {
        const refined = await refineThreeDPromptViaModel(
          ch,
          generationPrompt,
          codingSelection,
          codingPermission,
          (live) => {
            if (!aiEditRegistered(ch)) return;
            setAssistant(
              `${elapsed()}\n① 撰写 3D 提示词中…\n\n${live.trim() || '⟳ 生成中…'}`,
              false,
            );
          },
        );
        if (refined && refined.prompt) {
          threeDPrompt = refined.prompt;
          refineHeader = refined.routeHeader;
        }
      } catch {
        if (ch.abortController.signal.aborted || !aiEditRegistered(ch)) return;
        threeDPrompt = generationPrompt;
      }
      if (!aiEditRegistered(ch)) return;
      const promptModelLine = refineHeader
        ? `✎ 提示词模型：${refineHeader}\n`
        : '';
      pendingAssetId = registerPendingGeneratedAsset({
        kind: 'mesh',
        origin: provider?.local ? 'local' : 'remote',
        provider: providerLabel,
        model,
        prompt: threeDPrompt,
        sessionId: ch.sessionId,
        workspaceId: ch.workspaceId,
        messageId: assistantId,
        titlePrefix: '3d-model',
        meta: { rigging },
      });
      setAssistant(
        `${elapsed()}\n${promptModelLine}② 已生成提示词，正在调用${
          provider?.local ? '本地 3D 模型' : '3D API'
        }…\n\n3D 提示词：${threeDPrompt}`,
        false,
      );
      const result = await generateThreeD(
        {
          prompt: threeDPrompt,
          providerId,
          model,
          signal: ch.abortController.signal,
        },
        settings,
      );
      setAssistant(
        `${elapsed()}\n${promptModelLine}③ 3D 模型已生成，正在下载到本地缓存…\n\n3D 提示词：${threeDPrompt}`,
        false,
      );
      const downloads = await downloadThreeDAssets(
        result.assets,
        state.composer.workspace || undefined,
        {
          sessionId: ch.sessionId,
          workspaceId: ch.workspaceId,
          messageId: assistantId,
          pendingAssetId,
        },
      );
      if (pendingAssetId) {
        if (downloads.downloadErrors.length > 0 && downloads.downloaded.length === 0) {
          markAssetFailed(pendingAssetId, downloads.downloadErrors[0].error);
        } else if (downloads.downloaded.length === 0) {
          markAssetDone(pendingAssetId, {
            remoteUrl: result.assets[0],
            title: '3d-model.glb',
            meta: { rigging },
          });
        }
        pendingAssetId = null;
      }
      setAssistant(
        `${elapsed()}\n${promptModelLine}${threeDResultMarkdown({
          ...result,
          ...downloads,
        })}`,
        true,
      );
      commitAiChannelBlueprint(ch, appendStartUserInputs(ch.workflow, [text]));
      syncAndPersistSessionRunStatus(sessionKey, 'success');
    } catch (err) {
      if (!aiEditRegistered(ch)) return;
      const msg = err instanceof Error ? err.message : String(err);
      if (pendingAssetId) markAssetFailed(pendingAssetId, msg);
      setAssistant(
        `${elapsed()} · 失败\n✗ 3D 模型生成失败: ${msg}\n\n${threeDFailureHint(msg)}`,
        true,
      );
      syncAndPersistSessionRunStatus(sessionKey, 'error');
    } finally {
      removeAiEditChannel(ch);
    }
  })();
}

export function startWorldModelGenerationTurn(
  text: string,
  options: { providerId?: WorldModelProviderId; model?: string } = {},
): void {
  const prompt = stripWorldModelCommand(text);
  if (!prompt) return;
  const state = useStore.getState();
  if (isWorkflowReadOnly(state)) return;
  const generationPrompt = modeContextPrompt(state, 'world', prompt);
  const sessionKey = activeWorkflowSessionKey(state);
  const settingsProfile = generationSettingsProfileForState(state);
  const settings = loadWorldModelGenerationSettings(settingsProfile);
  const requestedProviderId = options.providerId;
  const providerId =
    requestedProviderId &&
    (!isRemoteSettingsProfile(settingsProfile.profileId) ||
      !worldModelProviderById(requestedProviderId, settings).local)
      ? requestedProviderId
      : preferredReadyWorldModelProviderIdForProfile(settings, settingsProfile);
  if (!providerId) {
    useStore
      .getState()
      .appendChatNote(
        `✗ ${friendlyWorldModelGenerationError('NO_READY_WORLD_MODEL_PROVIDER')}`,
        'system',
      );
    return;
  }
  if (!worldModelProviderReady(providerId, settings)) {
    useStore
      .getState()
      .appendChatNote(
        `✗ ${friendlyWorldModelGenerationError(`WORLD_MODEL_PROVIDER_NOT_READY:${providerId}`)}`,
        'system',
      );
    return;
  }

  if (state.blockedSendTip) useStore.setState({ blockedSendTip: null });

  const now = Date.now();
  const provider = worldModelProviderById(providerId, settings);
  const providerLabel = provider.label;
  const model = options.model?.trim() || worldModelProviderModel(providerId, settings);
  const userMsg: Message = {
    id: shortId('m'),
    role: 'user',
    text,
    createdAt: now,
  };
  linkMessageManagedAssets(userMsg, sessionKey);
  const assistantId = shortId('m');
  const assistantMsg: Message = {
    id: assistantId,
    role: 'assistant',
    text: `⚙ 世界模型：${providerLabel}${model ? ` · 模型：${model}` : ''}\n正在调用世界模型 API…`,
    routeLabel: model ? `${providerLabel} · ${model}` : providerLabel,
    createdAt: now + 1,
  };
  const promptUpdate = applyPromptTitle(state, prompt, now);
  const activeSession = sessionForKey(state, sessionKey);
  const simpleMode = promptUpdate.workflow.meta?.simple === true;
  const baseMessages = state.messages;
  const chSessionKey = runKey(sessionKey.workspaceId, sessionKey.sessionId);
  const workspaceRootPath = sessionChangesRootPathForSession(state, sessionKey);
  const ch: AiEditChannel = {
    key: chatTurnKey(chSessionKey, userMsg.id),
    sessionKey: chSessionKey,
    workspaceId: sessionKey.workspaceId,
    sessionId: sessionKey.sessionId,
    workspaceRootPath,
    workflow: promptUpdate.workflow,
    messages: [...baseMessages, userMsg, assistantMsg],
    cliRunIds: new Set<string>(),
    abortController: new AbortController(),
    workflowSession: activeSession?.isWorkflow ?? !simpleMode,
    chat: true,
    ownedMessageIds: new Set<string>([userMsg.id, assistantId]),
  };

  const setAssistant = (textValue: string, persist: boolean) => {
    if (!aiEditRegistered(ch)) return;
    ch.messages = ch.messages.map((message) =>
      message.id === assistantId
        ? {
            ...message,
            text: textValue,
            routeLabel: model ? `${providerLabel} · ${model}` : providerLabel,
          }
        : message,
    );
    aiEditCommitMessages(ch, persist);
  };

  addAiEditChannel(ch);
  if (aiEditViewActive(ch)) {
    useStore.setState({
      messages: ch.messages,
      sessions: promptUpdate.sessions,
      sessionTree: promptUpdate.sessionTree,
      workflow: ch.workflow,
    });
  }
  updateAiEditSessionSummary(ch);
  if (ch.workspaceId && ch.sessionId) {
    void historyStore
      .updateSession(ch.workspaceId, ch.sessionId, {
        messages: ch.messages,
        ...(ch.workflowSession ? { workflow: ch.workflow } : {}),
        meta: { runStatus: 'running' },
      })
      .catch(() => {});
  }
  syncAndPersistSessionRunStatus(sessionKey, 'running');

  void (async () => {
    const startedAt = Date.now();
    const elapsed = () =>
      `⏱ ${formatClock(startedAt)} → ${formatClock(Date.now())} · 耗时 ${formatDuration(
        Date.now() - startedAt,
      )}`;
    let pendingAssetId: string | null = null;
    try {
      pendingAssetId = registerPendingGeneratedAsset({
        kind: provider.interactivity === 'video-stream' ? 'video' : 'mesh',
        origin: provider.local ? 'local' : 'remote',
        provider: providerLabel,
        model,
        prompt: generationPrompt,
        sessionId: ch.sessionId,
        workspaceId: ch.workspaceId,
        messageId: assistantId,
        titlePrefix: 'world-model',
        meta: { interactivity: provider.interactivity },
      });
      setAssistant(
        `${elapsed()}\n正在调用${
          provider.local ? '本地世界模型服务' : '世界模型 API'
        }…\n\n世界描述：${generationPrompt}`,
        false,
      );
      const result = await generateWorldModel(
        {
          prompt: generationPrompt,
          providerId,
          model,
          signal: ch.abortController.signal,
        },
        settings,
      );
      const firstAsset = result.assets[0];
      if (pendingAssetId) {
        if (firstAsset) {
          markAssetDone(pendingAssetId, {
            remoteUrl: firstAsset,
            title: 'world-model',
            meta: { interactivity: provider.interactivity },
          });
        } else {
          markAssetFailed(pendingAssetId, 'No generated world asset output.');
        }
        pendingAssetId = null;
      }
      setAssistant(
        `${elapsed()}\n${worldModelResultMarkdown({
          providerLabel: result.providerLabel,
          model: result.model,
          prompt: result.prompt,
          specBody: serializeWorldModelSpec(result.spec),
          assets: result.assets,
        })}`,
        true,
      );
      commitAiChannelBlueprint(ch, appendStartUserInputs(ch.workflow, [text]));
      syncAndPersistSessionRunStatus(sessionKey, 'success');
    } catch (err) {
      if (!aiEditRegistered(ch)) return;
      if (ch.abortController.signal.aborted) return;
      const rawMsg = err instanceof Error ? err.message : String(err);
      const msg = friendlyWorldModelGenerationError(rawMsg);
      if (pendingAssetId) markAssetFailed(pendingAssetId, msg);
      setAssistant(
        `${elapsed()} · 失败\n✗ 世界模型生成失败: ${msg}\n\n请在设置 > 世界模型中配置可用 Provider；World Labs Marble 需要 API Key，返回的是 Marble 页面/SPZ 资源，当前不会被普通 GLB 查看器硬预览。`,
        true,
      );
      syncAndPersistSessionRunStatus(sessionKey, 'error');
    } finally {
      removeAiEditChannel(ch);
    }
  })();
}

export function startVideoGenerationTurn(
  text: string,
  options: { providerId?: VideoProviderId; model?: string } = {},
): void {
  const prompt = stripVideoCommand(text);
  if (!prompt) return;
  const state = useStore.getState();
  if (isWorkflowReadOnly(state)) return;
  const generationPrompt = modeContextPrompt(state, 'video', prompt);
  const sessionKey = activeWorkflowSessionKey(state);
  const settingsProfile = generationSettingsProfileForState(state);
  const settings = loadVideoGenerationSettings(settingsProfile);
  const requestedProviderId = options.providerId;
  const providerId =
    requestedProviderId &&
    (!isRemoteSettingsProfile(settingsProfile.profileId) ||
      !videoProviderById(requestedProviderId, settings).local)
      ? requestedProviderId
      : preferredReadyVideoProviderIdForProfile(settings, settingsProfile);
  if (!providerId) {
    useStore
      .getState()
      .appendChatNote('✗ 当前项目没有可用的视频生成渠道。请在设置中为当前项目配置在线渠道。', 'system');
    return;
  }
  const codingSelection = workflowDefaultGatewaySelection(
    state.workflow,
    state.composer.model,
  );
  const codingPermission = state.composer.permission || 'full';

  if (state.blockedSendTip) useStore.setState({ blockedSendTip: null });

  const now = Date.now();
  const providerLabel = providerId
    ? videoProviderById(providerId, settings).label
    : 'Video generation';
  const provider = providerId ? videoProviderById(providerId, settings) : null;
  const model = providerId
    ? options.model?.trim() || videoProviderModel(providerId, settings)
    : options.model?.trim() || '';
  const userMsg: Message = {
    id: shortId('m'),
    role: 'user',
    text,
    createdAt: now,
  };
  linkMessageManagedAssets(userMsg, sessionKey);
  const assistantId = shortId('m');
  const assistantMsg: Message = {
    id: assistantId,
    role: 'assistant',
    text: `⚙ 生视频：${providerLabel}${model ? ` · 模型：${model}` : ''}\n① 正在让模型撰写视频提示词…`,
    routeLabel: model ? `${providerLabel} · ${model}` : providerLabel,
    createdAt: now + 1,
  };
  const promptUpdate = applyPromptTitle(state, prompt, now);
  const activeSession = sessionForKey(state, sessionKey);
  const simpleMode = promptUpdate.workflow.meta?.simple === true;
  const baseMessages = state.messages;
  const chSessionKey = runKey(sessionKey.workspaceId, sessionKey.sessionId);
  const workspaceRootPath = sessionChangesRootPathForSession(state, sessionKey);
  const ch: AiEditChannel = {
    key: chatTurnKey(chSessionKey, userMsg.id),
    sessionKey: chSessionKey,
    workspaceId: sessionKey.workspaceId,
    sessionId: sessionKey.sessionId,
    workspaceRootPath,
    workflow: promptUpdate.workflow,
    messages: [...baseMessages, userMsg, assistantMsg],
    cliRunIds: new Set<string>(),
    abortController: new AbortController(),
    workflowSession: activeSession?.isWorkflow ?? !simpleMode,
    chat: true,
    ownedMessageIds: new Set<string>([userMsg.id, assistantId]),
  };

  const setAssistant = (textValue: string, persist: boolean) => {
    if (!aiEditRegistered(ch)) return;
    ch.messages = ch.messages.map((message) =>
      message.id === assistantId
        ? {
            ...message,
            text: textValue,
            routeLabel: model ? `${providerLabel} · ${model}` : providerLabel,
          }
        : message,
    );
    aiEditCommitMessages(ch, persist);
  };

  addAiEditChannel(ch);
  if (aiEditViewActive(ch)) {
    useStore.setState({
      messages: ch.messages,
      sessions: promptUpdate.sessions,
      sessionTree: promptUpdate.sessionTree,
      workflow: ch.workflow,
    });
  }
  updateAiEditSessionSummary(ch);
  if (ch.workspaceId && ch.sessionId) {
    void historyStore
      .updateSession(ch.workspaceId, ch.sessionId, {
        messages: ch.messages,
        ...(ch.workflowSession ? { workflow: ch.workflow } : {}),
        meta: { runStatus: 'running' },
      })
      .catch(() => {});
  }
  syncAndPersistSessionRunStatus(sessionKey, 'running');

  void (async () => {
    const startedAt = Date.now();
    const elapsed = () =>
      `⏱ ${formatClock(startedAt)} → ${formatClock(Date.now())} · 耗时 ${formatDuration(
        Date.now() - startedAt,
      )}`;
    let pendingAssetId: string | null = null;
    try {
      let videoPrompt = generationPrompt;
      let refineHeader = '';
      try {
        const refined = await refineVideoPromptViaModel(
          ch,
          generationPrompt,
          codingSelection,
          codingPermission,
          (live) => {
            if (!aiEditRegistered(ch)) return;
            setAssistant(
              `${elapsed()}\n① 撰写视频提示词中…\n\n${live.trim() || '⟳ 生成中…'}`,
              false,
            );
          },
        );
        if (refined && refined.prompt) {
          videoPrompt = refined.prompt;
          refineHeader = refined.routeHeader;
        }
      } catch (err) {
        if (ch.abortController.signal.aborted || !aiEditRegistered(ch)) return;
        videoPrompt = generationPrompt;
      }
      if (!aiEditRegistered(ch)) return;
      const promptModelLine = refineHeader
        ? `✎ 提示词模型：${refineHeader}\n`
        : '';
      pendingAssetId = registerPendingGeneratedAsset({
        kind: 'video',
        origin: provider?.local ? 'local' : 'remote',
        provider: providerLabel,
        model,
        prompt: videoPrompt,
        sessionId: ch.sessionId,
        workspaceId: ch.workspaceId,
        messageId: assistantId,
        titlePrefix: 'video',
      });
      setAssistant(
        `${elapsed()}\n${promptModelLine}② 已生成提示词，正在调用${
          provider?.local ? '本地视频模型' : '视频 API'
        }（视频生成耗时较长，请耐心等待）…\n\n视频提示词：${videoPrompt}`,
        false,
      );
      const result = await generateVideo(
        {
          prompt: videoPrompt,
          providerId,
          model,
          targetDurationSeconds:
            videoDurationSecondsFromPrompt(videoPrompt) ?? undefined,
          signal: ch.abortController.signal,
        },
        settings,
      );
      setAssistant(`${elapsed()}\n${promptModelLine}${videoResultMarkdown(result)}`, true);
      const capturePendingAssetId = pendingAssetId;
      pendingAssetId = null;
      void captureGeneratedAssets({
        kind: 'video',
        sources: result.videos,
        origin: videoProviderById(result.providerId, settings).local ? 'local' : 'remote',
        provider: result.providerLabel,
        model: result.model,
        prompt: result.prompt,
        sessionId: ch.sessionId ?? undefined,
        workspaceId: ch.workspaceId,
        messageId: assistantId,
        cwd: ch.workspaceRootPath ?? undefined,
        titlePrefix: 'video',
        pendingAssetId: capturePendingAssetId ?? undefined,
      });
      commitAiChannelBlueprint(ch, appendStartUserInputs(ch.workflow, [text]));
      syncAndPersistSessionRunStatus(sessionKey, 'success');
    } catch (err) {
      if (!aiEditRegistered(ch)) return;
      const msg = err instanceof Error ? err.message : String(err);
      if (pendingAssetId) markAssetFailed(pendingAssetId, msg);
      setAssistant(
        `${elapsed()} · 失败\n✗ 视频生成失败: ${msg}\n\n请在设置 > 视频渠道中配置可用的商用或免费 Provider。`,
        true,
      );
      syncAndPersistSessionRunStatus(sessionKey, 'error');
    } finally {
      removeAiEditChannel(ch);
    }
  })();
}

export function startSpeechGenerationTurn(
  text: string,
  options: { providerId?: SpeechProviderId; model?: string; voice?: string } = {},
): void {
  const prompt = stripSpeechCommand(text);
  if (!prompt) return;
  const state = useStore.getState();
  if (isWorkflowReadOnly(state)) return;
  const generationPrompt = modeContextPrompt(state, 'speech', prompt);
  const sessionKey = activeWorkflowSessionKey(state);
  const settingsProfile = generationSettingsProfileForState(state);
  const settings = loadSpeechGenerationSettings(settingsProfile);
  const requestedProviderId = options.providerId;
  const providerId =
    requestedProviderId &&
    (!isRemoteSettingsProfile(settingsProfile.profileId) ||
      !speechProviderById(requestedProviderId, settings).local)
      ? requestedProviderId
      : preferredReadySpeechProviderIdForProfile(settings, settingsProfile);
  if (!providerId) {
    useStore
      .getState()
      .appendChatNote('✗ 当前项目没有可用的语音生成渠道。请在设置中为当前项目配置在线渠道。', 'system');
    return;
  }
  const codingSelection = workflowDefaultGatewaySelection(
    state.workflow,
    state.composer.model,
  );
  const codingPermission = state.composer.permission || 'full';

  if (state.blockedSendTip) useStore.setState({ blockedSendTip: null });

  const now = Date.now();
  const providerLabel = providerId
    ? speechProviderById(providerId, settings).label
    : 'Speech generation';
  const provider = providerId ? speechProviderById(providerId, settings) : null;
  const model = providerId
    ? options.model?.trim() || speechProviderModel(providerId, settings)
    : options.model?.trim() || '';
  const voice = providerId
    ? options.voice?.trim() || speechProviderVoice(providerId, settings)
    : options.voice?.trim() || '';
  const userMsg: Message = {
    id: shortId('m'),
    role: 'user',
    text,
    createdAt: now,
  };
  linkMessageManagedAssets(userMsg, sessionKey);
  const assistantId = shortId('m');
  const assistantMsg: Message = {
    id: assistantId,
    role: 'assistant',
    text: `⚙ 文本转语音：${providerLabel}${model ? ` · 模型：${model}` : ''}${
      voice ? ` · 音色：${voice}` : ''
    }\n① 正在让模型撰写配音文案…`,
    routeLabel: model ? `${providerLabel} · ${model}` : providerLabel,
    createdAt: now + 1,
  };
  const promptUpdate = applyPromptTitle(state, prompt, now);
  const activeSession = sessionForKey(state, sessionKey);
  const simpleMode = promptUpdate.workflow.meta?.simple === true;
  const baseMessages = state.messages;
  const chSessionKey = runKey(sessionKey.workspaceId, sessionKey.sessionId);
  const workspaceRootPath = sessionChangesRootPathForSession(state, sessionKey);
  const ch: AiEditChannel = {
    key: chatTurnKey(chSessionKey, userMsg.id),
    sessionKey: chSessionKey,
    workspaceId: sessionKey.workspaceId,
    sessionId: sessionKey.sessionId,
    workspaceRootPath,
    workflow: promptUpdate.workflow,
    messages: [...baseMessages, userMsg, assistantMsg],
    cliRunIds: new Set<string>(),
    abortController: new AbortController(),
    workflowSession: activeSession?.isWorkflow ?? !simpleMode,
    chat: true,
    ownedMessageIds: new Set<string>([userMsg.id, assistantId]),
  };

  const setAssistant = (textValue: string, persist: boolean) => {
    if (!aiEditRegistered(ch)) return;
    ch.messages = ch.messages.map((message) =>
      message.id === assistantId
        ? {
            ...message,
            text: textValue,
            routeLabel: model ? `${providerLabel} · ${model}` : providerLabel,
          }
        : message,
    );
    aiEditCommitMessages(ch, persist);
  };

  addAiEditChannel(ch);
  if (aiEditViewActive(ch)) {
    useStore.setState({
      messages: ch.messages,
      sessions: promptUpdate.sessions,
      sessionTree: promptUpdate.sessionTree,
      workflow: ch.workflow,
    });
  }
  updateAiEditSessionSummary(ch);
  if (ch.workspaceId && ch.sessionId) {
    void historyStore
      .updateSession(ch.workspaceId, ch.sessionId, {
        messages: ch.messages,
        ...(ch.workflowSession ? { workflow: ch.workflow } : {}),
        meta: { runStatus: 'running' },
      })
      .catch(() => {});
  }
  syncAndPersistSessionRunStatus(sessionKey, 'running');

  void (async () => {
    const startedAt = Date.now();
    const elapsed = () =>
      `⏱ ${formatClock(startedAt)} → ${formatClock(Date.now())} · 耗时 ${formatDuration(
        Date.now() - startedAt,
      )}`;
    let pendingAssetId: string | null = null;
    try {
      let speechText = generationPrompt;
      let refineHeader = '';
      let refineNote = '';
      try {
        const refined = await refineSpeechPromptViaModel(
          ch,
          generationPrompt,
          codingSelection,
          codingPermission,
          (live) => {
            if (!aiEditRegistered(ch)) return;
            setAssistant(
              `${elapsed()}\n① 撰写配音文案中…\n\n${live.trim() || '⟳ 生成中…'}`,
              false,
            );
          },
        );
        if (refined && refined.prompt) {
          speechText = refined.prompt;
          refineHeader = refined.routeHeader;
        } else {
          // No text-model backend was reachable (no direct API key and no
          // usable CLI). Surface this so the user knows the spoken text is
          // their raw input rather than model-authored copy.
          speechText = generationPrompt;
          refineNote =
            '⚠ 未能调用文本模型撰写配音文案，已直接朗读原始输入。请在设置中为编码/文本渠道配置可用的 API Key 或 CLI。\n';
        }
      } catch (err) {
        if (ch.abortController.signal.aborted || !aiEditRegistered(ch)) return;
        // The refine step failed. Fall back to reading the raw input, but tell
        // the user the copywriting step errored instead of silently pretending
        // it succeeded.
        speechText = generationPrompt;
        const reason = err instanceof Error ? err.message : String(err);
        refineNote = `⚠ 撰写配音文案失败（${reason}），已直接朗读原始输入。\n`;
      }
      if (!aiEditRegistered(ch)) return;
      const promptModelLine =
        refineNote || (refineHeader ? `✎ 文案模型：${refineHeader}\n` : '');
      pendingAssetId = registerPendingGeneratedAsset({
        kind: 'speech',
        origin: provider?.local ? 'local' : 'remote',
        provider: providerLabel,
        model,
        prompt: speechText,
        sessionId: ch.sessionId,
        workspaceId: ch.workspaceId,
        messageId: assistantId,
        titlePrefix: 'speech',
      });
      setAssistant(
        `${elapsed()}\n${promptModelLine}② 已生成配音文案，正在调用${
          provider?.local ? '本地语音模型' : '语音 API'
        }合成…\n\n文本：${speechText}`,
        false,
      );
      const result = await generateSpeech(
        {
          prompt: speechText,
          providerId,
          model,
          voice: options.voice,
          signal: ch.abortController.signal,
        },
        settings,
      );
      setAssistant(`${elapsed()}\n${promptModelLine}${speechResultMarkdown(result)}`, true);
      const capturePendingAssetId = pendingAssetId;
      pendingAssetId = null;
      void captureGeneratedAssets({
        kind: 'speech',
        sources: result.audios,
        origin: speechProviderById(result.providerId, settings).local ? 'local' : 'remote',
        provider: result.providerLabel,
        model: result.model,
        prompt: result.prompt,
        sessionId: ch.sessionId ?? undefined,
        workspaceId: ch.workspaceId,
        messageId: assistantId,
        cwd: ch.workspaceRootPath ?? undefined,
        titlePrefix: 'speech',
        pendingAssetId: capturePendingAssetId ?? undefined,
      });
      commitAiChannelBlueprint(ch, appendStartUserInputs(ch.workflow, [text]));
      syncAndPersistSessionRunStatus(sessionKey, 'success');
    } catch (err) {
      if (!aiEditRegistered(ch)) return;
      const msg = err instanceof Error ? err.message : String(err);
      if (pendingAssetId) markAssetFailed(pendingAssetId, msg);
      setAssistant(
        `${elapsed()} · 失败\n✗ 语音合成失败: ${msg}\n\n请在设置 > 语音渠道中配置可用的商用或免费 Provider。`,
        true,
      );
      syncAndPersistSessionRunStatus(sessionKey, 'error');
    } finally {
      removeAiEditChannel(ch);
    }
  })();
}

export function startSpriteGenerationTurn(
  text: string,
  options: { providerId?: ImageProviderId; model?: string } = {},
): void {
  const prompt = stripSpriteCommand(text);
  if (!prompt) return;
  const state = useStore.getState();
  if (isWorkflowReadOnly(state)) return;
  const generationPrompt = modeContextPrompt(state, 'sprite', prompt);
  const sessionKey = activeWorkflowSessionKey(state);
  const settingsProfile = generationSettingsProfileForState(state);
  const settings = loadSpriteGenerationSettings(settingsProfile);
  const imageSettings = loadImageGenerationSettings(settingsProfile);
  const requestedProviderId = options.providerId;
  const providerId =
    requestedProviderId &&
    (!isRemoteSettingsProfile(settingsProfile.profileId) ||
      !imageProviderById(requestedProviderId, imageSettings).local)
      ? requestedProviderId
      : preferredReadyImageProviderIdForProfile(imageSettings, settingsProfile);
  if (!providerId) {
    useStore
      .getState()
      .appendChatNote('✗ 当前项目没有可用的 Sprite 生图渠道。请在设置中为当前项目配置在线生图渠道。', 'system');
    return;
  }
  if (!imageProviderReady(providerId, imageSettings)) {
    useStore
      .getState()
      .appendChatNote(
        `✗ ${friendlyImageGenerationError(`IMAGE_PROVIDER_NOT_READY:${providerId}`)}`,
        'system',
      );
    return;
  }
  const codingSelection = workflowDefaultGatewaySelection(
    state.workflow,
    state.composer.model,
  );
  const codingPermission = state.composer.permission || 'full';

  if (state.blockedSendTip) useStore.setState({ blockedSendTip: null });

  const now = Date.now();
  const providerLabel = providerId
    ? imageProviderById(providerId, imageSettings).label
    : '图片 Provider';
  const model = providerId
    ? options.model?.trim() || imageProviderModel(providerId, imageSettings)
    : options.model?.trim() || '';
  const userMsg: Message = {
    id: shortId('m'),
    role: 'user',
    text,
    createdAt: now,
  };
  linkMessageManagedAssets(userMsg, sessionKey);
  const assistantId = shortId('m');
  const assistantMsg: Message = {
    id: assistantId,
    role: 'assistant',
    text: `⚙ Sprite 动画：复用生图渠道 ${providerLabel}${model ? ` · 模型：${model}` : ''}\n① 正在让模型撰写 Sprite 提示词…`,
    routeLabel: model ? `${providerLabel} · ${model}` : providerLabel,
    createdAt: now + 1,
  };
  const promptUpdate = applyPromptTitle(state, prompt, now);
  const activeSession = sessionForKey(state, sessionKey);
  const simpleMode = promptUpdate.workflow.meta?.simple === true;
  const baseMessages = state.messages;
  const chSessionKey = runKey(sessionKey.workspaceId, sessionKey.sessionId);
  const workspaceRootPath = sessionChangesRootPathForSession(state, sessionKey);
  const ch: AiEditChannel = {
    key: chatTurnKey(chSessionKey, userMsg.id),
    sessionKey: chSessionKey,
    workspaceId: sessionKey.workspaceId,
    sessionId: sessionKey.sessionId,
    workspaceRootPath,
    workflow: promptUpdate.workflow,
    messages: [...baseMessages, userMsg, assistantMsg],
    cliRunIds: new Set<string>(),
    abortController: new AbortController(),
    workflowSession: activeSession?.isWorkflow ?? !simpleMode,
    chat: true,
    ownedMessageIds: new Set<string>([userMsg.id, assistantId]),
  };

  const setAssistant = (textValue: string, persist: boolean) => {
    if (!aiEditRegistered(ch)) return;
    ch.messages = ch.messages.map((message) =>
      message.id === assistantId
        ? {
            ...message,
            text: textValue,
            routeLabel: model ? `${providerLabel} · ${model}` : providerLabel,
          }
        : message,
    );
    aiEditCommitMessages(ch, persist);
  };

  addAiEditChannel(ch);
  if (aiEditViewActive(ch)) {
    useStore.setState({
      messages: ch.messages,
      sessions: promptUpdate.sessions,
      sessionTree: promptUpdate.sessionTree,
      workflow: ch.workflow,
    });
  }
  updateAiEditSessionSummary(ch);
  if (ch.workspaceId && ch.sessionId) {
    void historyStore
      .updateSession(ch.workspaceId, ch.sessionId, {
        messages: ch.messages,
        ...(ch.workflowSession ? { workflow: ch.workflow } : {}),
        meta: { runStatus: 'running' },
      })
      .catch(() => {});
  }
  syncAndPersistSessionRunStatus(sessionKey, 'running');

  void (async () => {
    const startedAt = Date.now();
    const elapsed = () =>
      `⏱ ${formatClock(startedAt)} → ${formatClock(Date.now())} · 耗时 ${formatDuration(
        Date.now() - startedAt,
      )}`;
    let pendingAssetId: string | null = null;
    try {
      let spritePrompt = generationPrompt;
      let refineHeader = '';
      try {
        const refined = await refineSpritePromptViaModel(
          ch,
          generationPrompt,
          codingSelection,
          codingPermission,
          (live) => {
            if (!aiEditRegistered(ch)) return;
            setAssistant(
              `${elapsed()}\n① 撰写 Sprite 提示词中…\n\n${live.trim() || '⟳ 生成中…'}`,
              false,
            );
          },
        );
        if (refined && refined.prompt) {
          spritePrompt = refined.prompt;
          refineHeader = refined.routeHeader;
        }
      } catch {
        if (ch.abortController.signal.aborted || !aiEditRegistered(ch)) return;
        spritePrompt = generationPrompt;
      }
      if (!aiEditRegistered(ch)) return;
      const promptModelLine = refineHeader
        ? `✎ 提示词模型：${refineHeader}\n`
        : '';
      pendingAssetId = registerPendingGeneratedAsset({
        kind: 'sprite',
        origin:
          providerId && imageProviderById(providerId, imageSettings).local ? 'local' : 'remote',
        provider: providerLabel,
        model,
        prompt: spritePrompt,
        sessionId: ch.sessionId,
        workspaceId: ch.workspaceId,
        messageId: assistantId,
        titlePrefix: 'sprite',
      });
      setAssistant(
        `${elapsed()}\n${promptModelLine}② 已生成提示词，正在调用生图渠道生成 raw spritesheet…\n\nSprite 提示词：${spritePrompt}`,
        false,
      );
      const result = await generateSprite(
        {
          prompt: spritePrompt,
          providerId,
          model,
          signal: ch.abortController.signal,
        },
        settings,
        imageSettings,
      );
      setAssistant(
        `${elapsed()}\n${promptModelLine}${spriteResultMarkdown(result)}`,
        true,
      );
      {
        const spriteOrigin = imageProviderById(result.providerId, imageSettings).local
          ? 'local'
          : 'remote';
        const spriteSources = [
          ...result.spritesheets,
          ...result.gifs,
          ...result.frames,
        ];
        const capturePendingAssetId = pendingAssetId;
        pendingAssetId = null;
        if (spriteSources.length || !result.videos.length) {
          void captureGeneratedAssets({
            kind: 'sprite',
            sources: spriteSources,
            origin: spriteOrigin,
            provider: result.providerLabel,
            model: result.model,
            prompt: result.prompt,
            sessionId: ch.sessionId ?? undefined,
            workspaceId: ch.workspaceId,
            messageId: assistantId,
            cwd: ch.workspaceRootPath ?? undefined,
            titlePrefix: 'sprite',
            pendingAssetId: capturePendingAssetId ?? undefined,
            meta: { mode: result.mode, frameCount: result.frameCount },
          });
        }
        if (result.videos.length) {
          void captureGeneratedAssets({
            kind: 'video',
            sources: result.videos,
            origin: spriteOrigin,
            provider: result.providerLabel,
            model: result.model,
            prompt: result.prompt,
            sessionId: ch.sessionId ?? undefined,
            workspaceId: ch.workspaceId,
            messageId: assistantId,
            cwd: ch.workspaceRootPath ?? undefined,
            titlePrefix: 'sprite-video',
            pendingAssetId: spriteSources.length
              ? undefined
              : (capturePendingAssetId ?? undefined),
          });
        }
      }
      commitAiChannelBlueprint(ch, appendStartUserInputs(ch.workflow, [text]));
      syncAndPersistSessionRunStatus(sessionKey, 'success');
    } catch (err) {
      if (!aiEditRegistered(ch)) return;
      const msg = err instanceof Error ? err.message : String(err);
      const friendlyMsg = friendlyImageGenerationError(msg);
      if (pendingAssetId) markAssetFailed(pendingAssetId, friendlyMsg);
      setAssistant(
        `${elapsed()} · 失败\n✗ Sprite 动画生成失败: ${friendlyMsg}\n\nSprite 复用设置 > 生图 的 Provider，请先配置可用生图渠道。`,
        true,
      );
      syncAndPersistSessionRunStatus(sessionKey, 'error');
    } finally {
      removeAiEditChannel(ch);
    }
  })();
}

export function startMeshSearchTurn(text: string): void {
  const query = stripMeshSearchCommand(text);
  const state = useStore.getState();
  if (isWorkflowReadOnly(state)) return;
  const sessionKey = activeWorkflowSessionKey(state);
  const settingsProfile = generationSettingsProfileForState(state);
  const settings = loadMeshLibrarySettings(settingsProfile);

  if (state.blockedSendTip) useStore.setState({ blockedSendTip: null });

  const now = Date.now();
  const enabledLabels = settings.enabledIds
    .map((id) => meshLibraryById(id, settings)?.label)
    .filter((label): label is string => !!label);
  const userMsg: Message = {
    id: shortId('m'),
    role: 'user',
    text,
    createdAt: now,
  };
  linkMessageManagedAssets(userMsg, sessionKey);
  const assistantId = shortId('m');
  const assistantMsg: Message = {
    id: assistantId,
    role: 'assistant',
    text: query
      ? `🔎 在线模型库搜索：${query}\n库：${
          enabledLabels.length ? enabledLabels.join('、') : '未启用任何模型库'
        }\n① ${meshSearchQueryNeedsEnglish(query) ? '正在准备英文搜索词…' : '正在搜索…'}`
      : '🔎 在线模型库搜索\n请在 /mesh-search 后输入要搜索的关键字。',
    routeLabel: '在线模型库',
    createdAt: now + 1,
  };
  const promptUpdate = applyPromptTitle(state, query || '在线模型库搜索', now);
  const activeSession = sessionForKey(state, sessionKey);
  const simpleMode = promptUpdate.workflow.meta?.simple === true;
  const baseMessages = state.messages;
  const chSessionKey = runKey(sessionKey.workspaceId, sessionKey.sessionId);
  const workspaceRootPath = sessionChangesRootPathForSession(state, sessionKey);
  const ch: AiEditChannel = {
    key: chatTurnKey(chSessionKey, userMsg.id),
    sessionKey: chSessionKey,
    workspaceId: sessionKey.workspaceId,
    sessionId: sessionKey.sessionId,
    workspaceRootPath,
    workflow: promptUpdate.workflow,
    messages: [...baseMessages, userMsg, assistantMsg],
    cliRunIds: new Set<string>(),
    abortController: new AbortController(),
    workflowSession: activeSession?.isWorkflow ?? !simpleMode,
    chat: true,
    ownedMessageIds: new Set<string>([userMsg.id, assistantId]),
  };

  const setAssistant = (textValue: string, persist: boolean) => {
    if (!aiEditRegistered(ch)) return;
    ch.messages = ch.messages.map((message) =>
      message.id === assistantId
        ? { ...message, text: textValue, routeLabel: '在线模型库' }
        : message,
    );
    aiEditCommitMessages(ch, persist);
  };

  addAiEditChannel(ch);
  if (aiEditViewActive(ch)) {
    useStore.setState({
      messages: ch.messages,
      sessions: promptUpdate.sessions,
      sessionTree: promptUpdate.sessionTree,
      workflow: ch.workflow,
    });
  }
  updateAiEditSessionSummary(ch);

  if (!query) {
    setAssistant(
      '🔎 在线模型库搜索\n请在 /mesh-search 后输入要搜索的关键字，例如 `/mesh-search 低多边形宝箱`。',
      true,
    );
    commitAiChannelBlueprint(ch, appendStartUserInputs(ch.workflow, [text]));
    removeAiEditChannel(ch);
    return;
  }

  if (ch.workspaceId && ch.sessionId) {
    void historyStore
      .updateSession(ch.workspaceId, ch.sessionId, {
        messages: ch.messages,
        ...(ch.workflowSession ? { workflow: ch.workflow } : {}),
        meta: { runStatus: 'running' },
      })
      .catch(() => {});
  }
  syncAndPersistSessionRunStatus(sessionKey, 'running');

  void (async () => {
    const startedAt = Date.now();
    const elapsed = () =>
      `⏱ ${formatClock(startedAt)} → ${formatClock(Date.now())} · 耗时 ${formatDuration(
        Date.now() - startedAt,
      )}`;
    try {
      if (meshSearchQueryNeedsEnglish(query)) {
        setAssistant(
          `${elapsed()}\n① 正在整理成更适合模型库搜索的英文词…`,
          false,
        );
      }
      const queryResolution = await resolveMeshSearchQuery(query, (sourceQuery) =>
        translatePublicText(sourceQuery, 'en-US'),
      );
      if (!aiEditRegistered(ch)) return;
      const searchQuery = queryResolution.searchQuery || query;
      if (queryResolution.translated && searchQuery !== query) {
        setAssistant(
          `${elapsed()}\n① 已转成英文搜索词：${searchQuery}\n② 正在搜索…`,
          false,
        );
      } else if (queryResolution.translationError) {
        setAssistant(
          `${elapsed()}\n① 英文化搜索词失败，已改用原词搜索。\n② 正在搜索…`,
          false,
        );
      }
      const result = await searchMeshLibraries(
        searchQuery,
        settings,
        ch.abortController.signal,
      );
      if (!aiEditRegistered(ch)) return;
      const downloadable = result.items.filter(
        (item) => item.downloadUrl && item.libraryId !== 'sketchfab',
      ).length;
      setAssistant(
        `${elapsed()}\n② 找到 ${result.items.length} 个可预览结果${
          downloadable > 0 && settings.autoDownload
            ? `，正在下载 ${downloadable} 个可直接下载的模型…`
            : '…'
        }`,
        false,
      );
      const downloaded = await downloadMeshSearchAssets(
        result,
        settings,
        state.composer.workspace || undefined,
        {
          sessionId: ch.sessionId,
          workspaceId: ch.workspaceId,
          messageId: assistantId,
        },
      );
      if (!aiEditRegistered(ch)) return;
      setAssistant(
        `${elapsed()}\n${meshSearchResultMarkdown(
          result,
          downloaded,
          settings,
          queryResolution,
        )}`,
        true,
      );
      commitAiChannelBlueprint(ch, appendStartUserInputs(ch.workflow, [text]));
      syncAndPersistSessionRunStatus(sessionKey, 'success');
    } catch (err) {
      if (!aiEditRegistered(ch)) return;
      const msg = err instanceof Error ? err.message : String(err);
      setAssistant(
        `${elapsed()} · 失败\n✗ 在线模型库搜索失败: ${msg}\n\n请检查网络，或在设置 > 在线模型库中配置账号 API Key 后重试。`,
        true,
      );
      syncAndPersistSessionRunStatus(sessionKey, 'error');
    } finally {
      removeAiEditChannel(ch);
    }
  })();
}
