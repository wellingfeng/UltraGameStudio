import {
  gameExpertNameAliases,
  gameGroupAliases,
  localizedGameExpertName,
  localizedGameGroupLabel,
} from "./gameExpertI18n";
import {
  availabilityFromGameAssetChannels,
  defaultCapabilityIdsForRole,
  formatReadyCapabilityGuidance,
  type GameAssetCapabilityId,
} from "./gameAssetCapabilities";
import type { Locale } from "./i18n";

export type GameExpertEngine =
  | "auto"
  | "unity"
  | "unreal"
  | "godot"
  | "web"
  | "custom";

export type GameExpertMode = "light" | "standard" | "council";

export const GAME_EXPERT_CATALOG_VERSION = 3;

export interface GameExpertSettings {
  catalogVersion: number;
  enabled: boolean;
  engine: GameExpertEngine;
  mode: GameExpertMode;
  maxExperts: number;
  enabledExpertIds: string[];
  customExperts: GameExpertDefinition[];
  deletedExpertIds: string[];
}

export interface GameExpertDefinition {
  id: string;
  name: string;
  group: string;
  summary: string;
  role: string;
  triggers: string[];
  guidance: string[];
  boundaries: string[];
  engineAffinity?: Exclude<GameExpertEngine, "auto" | "custom">[];
  defaultRank: number;
}

export const GAME_EXPERT_LIMITS = {
  maxExperts: { min: 1, max: 6 },
} as const;

export const GAME_EXPERT_ENGINE_IDS: GameExpertEngine[] = [
  "auto",
  "unity",
  "unreal",
  "godot",
  "web",
  "custom",
];

export const GAME_EXPERT_MODE_IDS: GameExpertMode[] = [
  "light",
  "standard",
  "council",
];

export const GAME_EXPERTS: GameExpertDefinition[] = [
  {
    id: "technical-director",
    name: "Technical Director",
    group: "Leadership",
    summary: "架构、风险、跨系统取舍",
    role: "把玩法目标拆成稳定架构，守住复杂度、性能和交付风险。",
    triggers: [
      "architecture",
      "system design",
      "framework",
      "refactor",
      "pipeline",
      "架构",
      "系统设计",
      "重构",
      "技术方案",
      "模块",
    ],
    guidance: [
      "先界定核心循环和系统边界",
      "偏向低耦合、可测试、可迭代结构",
      "标出会影响存档、联网、性能的决策",
    ],
    boundaries: ["不为了抽象而抽象", "避免过早引入大型框架"],
    defaultRank: 1,
  },
  {
    id: "game-designer",
    name: "Game Designer",
    group: "Design",
    summary: "玩法循环、规则、数值体验",
    role: "把需求转成可玩规则、反馈循环、胜负条件和调参面。",
    triggers: [
      "gameplay",
      "mechanic",
      "combat",
      "quest",
      "level",
      "balance",
      "progression",
      "玩法",
      "机制",
      "战斗",
      "关卡",
      "任务",
      "数值",
      "成长",
    ],
    guidance: [
      "明确玩家动词、资源、风险和奖励",
      "给出可调参数而非硬编码体验",
      "优先验证最小可玩闭环",
    ],
    boundaries: ["不把美术表现当玩法验证", "避免只写概念不落规则"],
    defaultRank: 2,
  },
  {
    id: "gameplay-programmer",
    name: "Gameplay Programmer",
    group: "Programming",
    summary: "角色、技能、交互、状态机",
    role: "把玩法规则落成清晰组件、状态机、事件和数据结构。",
    triggers: [
      "player",
      "enemy",
      "ability",
      "damage",
      "hitbox",
      "interaction",
      "state machine",
      "controller",
      "玩家",
      "敌人",
      "怪物",
      "技能",
      "伤害",
      "碰撞盒",
      "状态机",
      "交互",
      "控制器",
    ],
    guidance: [
      "区分输入、模拟、表现三层",
      "用事件/数据驱动减少脚本互相引用",
      "给边界条件和失败状态",
    ],
    boundaries: ["不把 UI、音效、存档逻辑混进核心玩法类"],
    defaultRank: 3,
  },
  {
    id: "unity-specialist",
    name: "Unity Specialist",
    group: "Engine",
    summary: "Unity、C#、Prefab、Scene",
    role: "按 Unity 生命周期和工程习惯落地实现。",
    triggers: [
      "unity",
      "c#",
      "monobehaviour",
      "scriptableobject",
      "prefab",
      "scene",
      "animator",
      "cinemachine",
      "addressables",
    ],
    guidance: [
      "尊重 Update/FixedUpdate/Coroutine 生命周期",
      "Prefab 配置和运行时代码分离",
      "避免 Find 和隐式全局引用",
    ],
    boundaries: ["不建议把所有逻辑塞进 MonoBehaviour"],
    engineAffinity: ["unity"],
    defaultRank: 4,
  },
  {
    id: "unreal-specialist",
    name: "Unreal Specialist",
    group: "Engine",
    summary: "Unreal、C++、Blueprint、GAS",
    role: "按 Unreal Gameplay Framework、反射和复制模型落地。",
    triggers: [
      "unreal",
      "ue5",
      "blueprint",
      "gas",
      "actor",
      "pawn",
      "replication",
      "uobject",
      "uproperty",
      "虚幻",
      "蓝图",
    ],
    guidance: [
      "明确 Actor/Component/Subsystem 归属",
      "联网逻辑区分 authority、client、replication",
      "Blueprint 暴露只保留设计师需要的面",
    ],
    boundaries: ["不把每个行为都做成 Tick", "不忽略服务器权威"],
    engineAffinity: ["unreal"],
    defaultRank: 5,
  },
  {
    id: "godot-specialist",
    name: "Godot Specialist",
    group: "Engine",
    summary: "Godot、GDScript、Node、Signal",
    role: "按 Godot 场景树、节点和信号模式落地。",
    triggers: [
      "godot",
      "gdscript",
      "node",
      "signal",
      "scene tree",
      "resource",
      "戈多",
      "信号",
      "节点",
    ],
    guidance: [
      "用节点职责和信号边界组织交互",
      "Resource 承载可调数据",
      "避免硬编码深层节点路径",
    ],
    boundaries: ["不把场景树当全局服务容器"],
    engineAffinity: ["godot"],
    defaultRank: 6,
  },
  {
    id: "ui-programmer",
    name: "UI Programmer",
    group: "UI",
    summary: "HUD、菜单、背包、控件状态",
    role: "把界面状态、输入和游戏数据连接成稳定 UI。",
    triggers: [
      "hud",
      "menu",
      "inventory",
      "dialog",
      "tooltip",
      "widget",
      "ui",
      "界面",
      "菜单",
      "背包",
      "对话框",
      "提示框",
      "血条",
    ],
    guidance: [
      "数据源、展示状态、输入处理分离",
      "考虑手柄/键鼠/触屏焦点",
      "给空态、禁用态、加载态",
    ],
    boundaries: ["不让 UI 直接修改核心模拟状态"],
    defaultRank: 7,
  },
  {
    id: "ux-designer",
    name: "UX Designer",
    group: "UI",
    summary: "玩家路径、反馈、可理解性",
    role: "保证交互路径清楚、反馈及时、玩家不迷路。",
    triggers: [
      "onboarding",
      "tutorial",
      "feedback",
      "flow",
      "accessibility",
      "ux",
      "引导",
      "教程",
      "反馈",
      "流程",
      "可访问性",
    ],
    guidance: [
      "每个操作有即时反馈",
      "失败原因可见且可恢复",
      "减少记忆负担，强化空间/状态线索",
    ],
    boundaries: ["不靠说明文字掩盖交互不清"],
    defaultRank: 8,
  },
  {
    id: "ai-programmer",
    name: "AI Programmer",
    group: "Programming",
    summary: "NPC、行为树、寻路、感知",
    role: "设计可调试、可扩展的 NPC 决策和移动。",
    triggers: [
      "npc",
      "ai",
      "behavior tree",
      "pathfinding",
      "navmesh",
      "steering",
      "perception",
      "寻路",
      "行为树",
      "感知",
      "巡逻",
      "仇恨",
    ],
    guidance: [
      "感知、决策、动作执行分层",
      "状态可视化，便于调试",
      "给卡住、丢目标、路径失败回退",
    ],
    boundaries: ["不把 AI 决策写成不可调的长 if 链"],
    defaultRank: 9,
  },
  {
    id: "network-programmer",
    name: "Network Programmer",
    group: "Programming",
    summary: "联机、同步、预测、回滚",
    role: "处理多人游戏同步、一致性、延迟和作弊面。",
    triggers: [
      "multiplayer",
      "netcode",
      "replication",
      "sync",
      "prediction",
      "rollback",
      "lag",
      "server authoritative",
      "多人",
      "联机",
      "同步",
      "预测",
      "回滚",
      "延迟",
    ],
    guidance: [
      "先定权威端和同步粒度",
      "区分确定性状态和表现插值",
      "考虑断线重连、作弊和带宽",
    ],
    boundaries: ["不把本地单机状态直接照搬到网络状态"],
    defaultRank: 10,
  },
  {
    id: "performance-analyst",
    name: "Performance Analyst",
    group: "Quality",
    summary: "FPS、内存、加载、GC",
    role: "定位性能瓶颈，给可验证优化路径。",
    triggers: [
      "fps",
      "frame",
      "performance",
      "memory",
      "gc",
      "loading",
      "stutter",
      "profile",
      "优化",
      "性能",
      "帧率",
      "卡顿",
      "内存",
      "加载",
    ],
    guidance: [
      "先量测再优化",
      "区分 CPU/GPU/IO/GC 瓶颈",
      "给预算、指标和回归测试",
    ],
    boundaries: ["不做无数据的微优化"],
    defaultRank: 11,
  },
  {
    id: "qa-tester",
    name: "QA Tester",
    group: "Quality",
    summary: "边界、回归、可复现步骤",
    role: "把功能拆成可验证场景，找破坏体验的边界。",
    triggers: [
      "test",
      "bug",
      "regression",
      "edge case",
      "acceptance",
      "crash",
      "测试",
      "验收",
      "缺陷",
      "崩溃",
      "边界",
      "回归",
    ],
    guidance: [
      "覆盖正常、失败、边界和重复操作",
      "给最小复现和验收清单",
      "保留自动化回归入口",
    ],
    boundaries: ["不只验证 happy path"],
    defaultRank: 12,
  },
  {
    id: "tools-programmer",
    name: "Tools Programmer",
    group: "Production",
    summary: "编辑器工具、导入管线、内容生产",
    role: "让设计、美术和关卡内容能稳定、快速生产。",
    triggers: [
      "editor tool",
      "importer",
      "pipeline",
      "level editor",
      "content tool",
      "工具",
      "编辑器",
      "导入",
      "管线",
      "配置表",
    ],
    guidance: [
      "内容格式可校验、可版本化",
      "错误提示贴近制作者",
      "批处理和回滚路径明确",
    ],
    boundaries: ["不让一次性脚本变成隐形生产依赖"],
    defaultRank: 13,
  },
  {
    id: "audio-designer",
    name: "Audio Designer",
    group: "Audio",
    summary: "音效、音乐、混音、反馈节奏",
    role: "用声音强化反馈、节奏和状态感知。",
    triggers: [
      "audio",
      "sound",
      "sfx",
      "music",
      "mix",
      "wwise",
      "fmod",
      "音效",
      "音乐",
      "混音",
      "声音",
    ],
    guidance: [
      "重要状态变化有声音反馈",
      "避免频繁触发导致听觉疲劳",
      "保留音量分组和静音策略",
    ],
    boundaries: ["不把音频触发散落到所有系统里"],
    defaultRank: 14,
  },
  {
    id: "visual-effects-artist",
    name: "VFX Artist",
    group: "Art",
    summary: "特效、Shader、命中反馈",
    role: "让关键交互有清晰、可控、性能友好的视觉反馈。",
    triggers: [
      "vfx",
      "shader",
      "particle",
      "hit flash",
      "screen shake",
      "特效",
      "粒子",
      "着色器",
      "命中特效",
      "屏幕震动",
    ],
    guidance: [
      "特效服务玩法阅读性",
      "区分近景冲击和远景可读性",
      "给性能预算和开关",
    ],
    boundaries: ["不让特效遮挡核心信息"],
    defaultRank: 15,
  },
  {
    id: "save-systems-engineer",
    name: "Save Systems Engineer",
    group: "Systems",
    summary: "存档、进度、兼容迁移",
    role: "设计可迁移、可恢复、能覆盖版本升级的存档系统。",
    triggers: [
      "save",
      "load",
      "checkpoint",
      "profile",
      "serialization",
      "migration",
      "存档",
      "读档",
      "检查点",
      "序列化",
      "迁移",
      "进度",
    ],
    guidance: [
      "区分运行态、配置态和持久态",
      "给版本号、迁移、损坏恢复",
      "避免保存瞬时表现状态",
    ],
    boundaries: ["不把对象引用直接当持久格式"],
    defaultRank: 16,
  },
  {
    id: "accessibility-specialist",
    name: "Accessibility Specialist",
    group: "UI",
    summary: "可访问性、重映射、字幕、色盲模式",
    role: "保证游戏被尽可能多的玩家稳定使用，包括输入、视觉、听觉和认知负担。",
    triggers: [
      "accessibility",
      "a11y",
      "remap",
      "subtitle",
      "colorblind",
      "screen reader",
      "text scaling",
      "可访问性",
      "无障碍",
      "按键映射",
      "字幕",
      "色盲",
      "字号",
    ],
    guidance: [
      "输入、文本、颜色、音频反馈都给替代路径",
      "避免只靠颜色、声音或快速反应传递关键信息",
      "关键设置要可测试、可保存、可默认启用",
    ],
    boundaries: ["不把可访问性当发布前补丁"],
    defaultRank: 17,
  },
  {
    id: "analytics-engineer",
    name: "Analytics Engineer",
    group: "Production",
    summary: "埋点、遥测、A/B、玩家行为分析",
    role: "设计可解释、低侵入的游戏数据采集和分析方案。",
    triggers: [
      "analytics",
      "telemetry",
      "event tracking",
      "dashboard",
      "ab test",
      "retention",
      "funnel",
      "cohort",
      "埋点",
      "遥测",
      "数据分析",
      "留存",
      "漏斗",
      "看板",
    ],
    guidance: [
      "事件命名、属性、触发时机先定规范",
      "区分诊断指标、设计指标和商业指标",
      "避免采集个人敏感数据，保留采样和开关",
    ],
    boundaries: ["不为指标牺牲玩家信任和隐私"],
    defaultRank: 18,
  },
  {
    id: "art-director",
    name: "Art Director",
    group: "Art",
    summary: "视觉风格、资产规范、Art Bible",
    role: "统一游戏视觉身份、资产标准和美术生产方向。",
    triggers: [
      "art direction",
      "visual style",
      "art bible",
      "asset spec",
      "palette",
      "silhouette",
      "concept art",
      "美术风格",
      "视觉风格",
      "资产规范",
      "色板",
      "剪影",
      "概念图",
    ],
    guidance: [
      "先定风格支柱、形状语言和材质边界",
      "资产规格要服务镜头距离、可读性和生产成本",
      "给出一致性检查点和交付格式",
    ],
    boundaries: ["不让单个资产偏离整体视觉身份"],
    defaultRank: 19,
  },
  {
    id: "audio-director",
    name: "Audio Director",
    group: "Audio",
    summary: "声音身份、音乐方向、混音策略",
    role: "定义游戏声音语言、音乐 cue、混音层级和实现策略。",
    triggers: [
      "audio direction",
      "music direction",
      "sound palette",
      "mix balance",
      "adaptive music",
      "audio system",
      "声音方向",
      "音乐方向",
      "音频系统",
      "动态音乐",
      "混音",
    ],
    guidance: [
      "先定声音支柱和反馈优先级",
      "音乐、环境、UI、战斗音效要有混音层级",
      "事件触发和状态切换要可调试",
    ],
    boundaries: ["不把声音只当最后装饰"],
    defaultRank: 20,
  },
  {
    id: "community-manager",
    name: "Community Manager",
    group: "Live",
    summary: "玩家沟通、反馈收集、补丁说明",
    role: "把开发信息翻译成玩家能理解、能反馈、能建立信任的沟通。",
    triggers: [
      "community",
      "patch notes",
      "player feedback",
      "social media",
      "bug report triage",
      "crisis communication",
      "社区",
      "玩家反馈",
      "公告",
      "补丁说明",
      "舆情",
    ],
    guidance: [
      "区分事实、计划、已知问题和临时规避",
      "玩家反馈要归类到可行动问题",
      "公开承诺要和实际排期一致",
    ],
    boundaries: ["不许用含糊话术掩盖风险"],
    defaultRank: 21,
  },
  {
    id: "creative-director",
    name: "Creative Director",
    group: "Leadership",
    summary: "创意愿景、基调、跨部门取舍",
    role: "守住游戏核心身份，解决设计、美术、叙事、音频之间的创意冲突。",
    triggers: [
      "creative direction",
      "vision",
      "tone",
      "pillars",
      "identity",
      "aesthetic",
      "创意方向",
      "愿景",
      "基调",
      "支柱",
      "游戏定位",
    ],
    guidance: [
      "先回到核心体验和目标玩家",
      "冲突取舍必须服务游戏身份",
      "给可执行的创意边界，不只给口号",
    ],
    boundaries: ["不让功能堆叠稀释核心体验"],
    defaultRank: 22,
  },
  {
    id: "devops-engineer",
    name: "DevOps Engineer",
    group: "Production",
    summary: "CI/CD、构建、分支、自动化测试",
    role: "维护游戏项目构建流水线、版本控制工作流和部署基础设施。",
    triggers: [
      "ci",
      "cd",
      "pipeline",
      "build script",
      "branching",
      "deployment",
      "automation",
      "github actions",
      "构建",
      "流水线",
      "分支",
      "自动化测试",
      "部署",
    ],
    guidance: [
      "构建产物、缓存、平台差异要可复现",
      "失败日志要能定位到责任阶段",
      "发布和回滚路径要自动化",
    ],
    boundaries: ["不把手工步骤留在关键发布链路"],
    defaultRank: 23,
  },
  {
    id: "economy-designer",
    name: "Economy Designer",
    group: "Design",
    summary: "资源、掉落、成长曲线、市场",
    role: "设计游戏资源流动、奖励节奏、消耗口和长期平衡。",
    triggers: [
      "economy",
      "loot",
      "currency",
      "sink",
      "faucet",
      "progression curve",
      "market",
      "reward",
      "经济",
      "掉落",
      "货币",
      "资源",
      "消耗",
      "奖励",
      "成长曲线",
    ],
    guidance: [
      "明确资源来源、消耗、上限和通胀风险",
      "掉落和成长曲线要可模拟",
      "短期奖励和长期目标分层设计",
    ],
    boundaries: ["不做不可验证的数值直觉"],
    defaultRank: 24,
  },
  {
    id: "engine-programmer",
    name: "Engine Programmer",
    group: "Programming",
    summary: "渲染、物理、内存、加载、核心框架",
    role: "处理引擎级系统、性能关键路径和底层框架修改。",
    triggers: [
      "engine",
      "rendering",
      "physics",
      "memory management",
      "resource loading",
      "scene management",
      "core framework",
      "引擎",
      "渲染",
      "物理",
      "内存管理",
      "资源加载",
      "场景管理",
    ],
    guidance: [
      "先量化性能预算和平台约束",
      "底层接口要稳定、可回退、可压测",
      "避免让玩法代码依赖引擎实现细节",
    ],
    boundaries: ["不为单个功能破坏核心框架边界"],
    defaultRank: 25,
  },
  {
    id: "godot-csharp-specialist",
    name: "Godot C# Specialist",
    group: "Engine",
    summary: "Godot C#、partial、Export、Signal",
    role: "保证 Godot 4 C# 代码符合 .NET 和 Godot 源生成器约束。",
    triggers: [
      "godot c#",
      "godot .net",
      "partial class",
      "[export]",
      "[signal]",
      "nullable",
      "csproj",
      "godot csharp",
      "godot c#",
    ],
    guidance: [
      "Node 脚本必须 partial class",
      "导出属性、信号和空引用按 Godot 4 C# 约定写",
      "明确 C# 与 GDScript 边界",
    ],
    boundaries: ["不忽略 Godot 源生成器要求"],
    engineAffinity: ["godot"],
    defaultRank: 26,
  },
  {
    id: "godot-gdextension-specialist",
    name: "Godot GDExtension Specialist",
    group: "Engine",
    summary: "GDExtension、C++/Rust、原生节点",
    role: "处理 Godot 原生扩展、绑定、性能热点和脚本/原生边界。",
    triggers: [
      "gdextension",
      "godot-cpp",
      "godot-rust",
      "native code",
      "cpp binding",
      "rust binding",
      "custom node",
      "原生扩展",
      "原生节点",
      "绑定",
    ],
    guidance: [
      "只把真实性能热点或平台能力下沉到原生层",
      "脚本 API 要稳定、窄、易测试",
      "管理内存所有权和生命周期边界",
    ],
    boundaries: ["不为普通玩法逻辑引入原生复杂度"],
    engineAffinity: ["godot"],
    defaultRank: 27,
  },
  {
    id: "godot-gdscript-specialist",
    name: "Godot GDScript Specialist",
    group: "Engine",
    summary: "GDScript、静态类型、Signal、协程",
    role: "保证 Godot GDScript 清晰、类型化、可维护、性能可控。",
    triggers: [
      "gdscript",
      "signal",
      "await",
      "typed gdscript",
      "autoload",
      "resource",
      "scene tree",
      "静态类型",
      "信号",
      "自动加载",
    ],
    guidance: [
      "优先静态类型和清晰信号边界",
      "节点路径、Autoload、Resource 使用要可维护",
      "协程和场景切换要处理生命周期",
    ],
    boundaries: ["不写无类型全局脚本堆"],
    engineAffinity: ["godot"],
    defaultRank: 28,
  },
  {
    id: "godot-shader-specialist",
    name: "Godot Shader Specialist",
    group: "Engine",
    summary: "Godot Shader、Material、后处理、粒子",
    role: "在 Godot 渲染管线内实现视觉效果并控制性能成本。",
    triggers: [
      "godot shader",
      "canvas_item",
      "spatial shader",
      "visual shader",
      "material",
      "post-processing",
      "particle shader",
      "godot 着色器",
      "材质",
      "后处理",
    ],
    guidance: [
      "材质参数暴露给内容侧调节",
      "移动端和低端机保留降级路径",
      "特效要服务可读性和帧预算",
    ],
    boundaries: ["不让 shader 破坏核心信息可读性"],
    engineAffinity: ["godot"],
    defaultRank: 29,
  },
  {
    id: "lead-programmer",
    name: "Lead Programmer",
    group: "Leadership",
    summary: "代码架构、标准、评审、实现边界",
    role: "把设计需求转成代码结构、接口边界和可评审的工程建议。",
    triggers: [
      "code review",
      "api design",
      "coding standard",
      "refactoring strategy",
      "architecture",
      "lead programmer",
      "代码评审",
      "接口设计",
      "编码规范",
      "重构策略",
    ],
    guidance: [
      "先给模块边界和数据流",
      "高风险改动拆成可回滚步骤",
      "标准服务可维护性和交付质量，不做形式主义",
    ],
    boundaries: ["不把所有问题都上升成架构重写"],
    defaultRank: 30,
  },
  {
    id: "level-designer",
    name: "Level Designer",
    group: "Design",
    summary: "空间布局、遭遇、节奏、环境叙事",
    role: "设计关卡空间、挑战节奏、遭遇布局和玩家路径。",
    triggers: [
      "level design",
      "encounter",
      "pacing",
      "layout",
      "map",
      "spawn point",
      "environmental storytelling",
      "puzzle",
      "关卡设计",
      "遭遇",
      "节奏",
      "地图",
      "刷怪点",
      "空间",
    ],
    guidance: [
      "明确玩家目标、路径、视线和风险节奏",
      "遭遇配置要能快速迭代",
      "用空间引导减少说明文本",
    ],
    boundaries: ["不把关卡做成只靠 UI 指路"],
    defaultRank: 31,
  },
  {
    id: "live-ops-designer",
    name: "Live Ops Designer",
    group: "Live",
    summary: "赛季、活动、Battle Pass、留存",
    role: "设计上线后的内容节奏、活动机制和留存策略。",
    triggers: [
      "live ops",
      "season",
      "battle pass",
      "event",
      "content cadence",
      "retention",
      "engagement",
      "赛季",
      "活动",
      "通行证",
      "留存",
      "运营",
    ],
    guidance: [
      "活动目标、周期、奖励、复盘指标要闭环",
      "避免疲劳和强迫式每日负担",
      "内容节奏必须匹配生产能力",
    ],
    boundaries: ["不做掠夺式留存设计"],
    defaultRank: 32,
  },
  {
    id: "localization-lead",
    name: "Localization Lead",
    group: "Production",
    summary: "i18n、字符串、翻译流程、地区测试",
    role: "设计国际化架构、字符串管理和本地化质量流程。",
    triggers: [
      "localization",
      "i18n",
      "l10n",
      "translation",
      "string table",
      "locale",
      "rtl",
      "本地化",
      "国际化",
      "翻译",
      "多语言",
      "字符串",
    ],
    guidance: [
      "所有玩家文本进入字符串表和上下文说明",
      "处理复数、性别、长度、RTL 和字体回退",
      "本地化测试纳入发布流程",
    ],
    boundaries: ["不把文本硬编码进玩法或 UI 逻辑"],
    defaultRank: 33,
  },
  {
    id: "narrative-director",
    name: "Narrative Director",
    group: "Narrative",
    summary: "故事结构、角色、世界规则、叙事系统",
    role: "负责故事架构、角色弧线、世界规则和叙事策略。",
    triggers: [
      "narrative",
      "story arc",
      "character arc",
      "dialogue system",
      "lore",
      "quest narrative",
      "剧情",
      "故事",
      "角色弧线",
      "世界观",
      "叙事",
      "对白系统",
    ],
    guidance: [
      "先定主题、冲突和玩家视角",
      "剧情节点要和玩法目标互相支持",
      "世界规则保持一致，避免随剧情临时改",
    ],
    boundaries: ["不写孤立于玩法的长篇设定"],
    defaultRank: 34,
  },
  {
    id: "producer",
    name: "Producer",
    group: "Leadership",
    summary: "里程碑、排期、风险、跨职能约束",
    role: "提供范围、优先级、风险和跨职能约束视角。",
    triggers: [
      "milestone",
      "sprint",
      "scope",
      "roadmap",
      "risk",
      "planning",
      "priority",
      "排期",
      "里程碑",
      "范围",
      "优先级",
      "风险",
      "计划",
    ],
    guidance: [
      "拆成可交付切片和验收标准",
      "暴露依赖、风险和延期成本",
      "用范围控制保护核心体验",
    ],
    boundaries: ["不把未知工作伪装成确定排期"],
    defaultRank: 35,
  },
  {
    id: "prototyper",
    name: "Prototyper",
    group: "Production",
    summary: "快速原型、垂直切片、可玩验证",
    role: "快速验证玩法是否有趣，不把原型当生产架构。",
    triggers: [
      "prototype",
      "vertical slice",
      "proof of concept",
      "poc",
      "throwaway",
      "rapid iteration",
      "原型",
      "垂直切片",
      "快速验证",
      "可玩验证",
    ],
    guidance: [
      "只验证一个核心假设",
      "明确哪些代码会丢弃",
      "先跑通手感和反馈，再谈生产化",
    ],
    boundaries: ["不把原型代码直接扩成正式系统"],
    defaultRank: 36,
  },
  {
    id: "qa-lead",
    name: "QA Lead",
    group: "Quality",
    summary: "测试策略、缺陷分级、质量门禁",
    role: "制定测试计划、回归策略、缺陷优先级和发布质量门槛。",
    triggers: [
      "test plan",
      "qa strategy",
      "bug triage",
      "severity",
      "quality gate",
      "release readiness",
      "测试计划",
      "质量门禁",
      "缺陷分级",
      "发布准入",
    ],
    guidance: [
      "按风险和玩家影响排序测试范围",
      "明确阻塞、严重、普通缺陷标准",
      "发布前给清晰 go/no-go 条件",
    ],
    boundaries: ["不靠临时手测替代质量策略"],
    defaultRank: 37,
  },
  {
    id: "release-manager",
    name: "Release Manager",
    group: "Release",
    summary: "平台认证、商店提交、版本、发布日",
    role: "管理版本号、平台要求、商店提交流程和发布当天协调。",
    triggers: [
      "release",
      "certification",
      "store submission",
      "versioning",
      "steam",
      "console",
      "playstation",
      "xbox",
      "nintendo",
      "发布",
      "认证",
      "商店提交",
      "版本号",
    ],
    guidance: [
      "平台清单、版本冻结、回滚方案提前准备",
      "商店素材和合规要求纳入排期",
      "发布当天监控、沟通、热修流程明确",
    ],
    boundaries: ["不在发布窗口引入未经验证的大改"],
    defaultRank: 38,
  },
  {
    id: "security-engineer",
    name: "Security Engineer",
    group: "Quality",
    summary: "反作弊、漏洞、存档安全、隐私",
    role: "减少作弊、漏洞、数据泄露和玩家隐私风险。",
    triggers: [
      "security",
      "anti-cheat",
      "exploit",
      "vulnerability",
      "secure save",
      "privacy",
      "gdpr",
      "cheat",
      "安全",
      "反作弊",
      "漏洞",
      "隐私",
      "作弊",
      "存档加密",
    ],
    guidance: [
      "权威逻辑放服务端或可信边界",
      "输入、存档、网络包都要验证",
      "隐私数据最小化并可删除",
    ],
    boundaries: ["不把客户端校验当安全边界"],
    defaultRank: 39,
  },
  {
    id: "sound-designer",
    name: "Sound Designer",
    group: "Audio",
    summary: "SFX 规格、音频事件、混音参数",
    role: "把具体音效需求写成可实现、可调试、可混音的事件规格。",
    triggers: [
      "sfx",
      "audio event",
      "foley",
      "mixing parameter",
      "sound category",
      "wwise event",
      "fmod event",
      "音效规格",
      "音频事件",
      "脚步声",
      "打击音",
    ],
    guidance: [
      "每个音效给触发条件、变体、优先级和冷却",
      "按类别设计音量和 ducking",
      "避免高频重复音造成疲劳",
    ],
    boundaries: ["不把音效触发散落成不可追踪副作用"],
    defaultRank: 40,
  },
  {
    id: "systems-designer",
    name: "Systems Designer",
    group: "Design",
    summary: "公式、状态、配方、交互矩阵",
    role: "把子系统规则写成可实现、可测试、可调参的详细规格。",
    triggers: [
      "formula",
      "status effect",
      "crafting",
      "interaction matrix",
      "rule spec",
      "combat formula",
      "progression",
      "公式",
      "状态效果",
      "配方",
      "交互矩阵",
      "规则",
    ],
    guidance: [
      "明确输入、输出、公式、上限和例外",
      "复杂交互做矩阵和冲突优先级",
      "所有参数进入数据表或配置",
    ],
    boundaries: ["不让隐含规则只存在于代码里"],
    defaultRank: 41,
  },
  {
    id: "technical-artist",
    name: "Technical Artist",
    group: "Art",
    summary: "Shader、VFX、渲染优化、美术管线",
    role: "连接美术和工程，处理视觉系统实现、优化和资产管线。",
    triggers: [
      "technical art",
      "shader",
      "vfx",
      "rendering optimization",
      "art pipeline",
      "material",
      "particle",
      "特效",
      "着色器",
      "美术管线",
      "材质",
      "粒子",
    ],
    guidance: [
      "视觉效果要有性能预算和降级方案",
      "资产规则要能被工具校验",
      "材质、特效、动画状态服务游戏可读性",
    ],
    boundaries: ["不为画面效果牺牲核心玩法识别"],
    defaultRank: 42,
  },
  {
    id: "ue-blueprint-specialist",
    name: "UE Blueprint Specialist",
    group: "Engine",
    summary: "Blueprint 架构、C++ 边界、BP 优化",
    role: "保持 Unreal Blueprint 图清晰、可维护、性能可控。",
    triggers: [
      "blueprint",
      "bp graph",
      "blueprint interface",
      "event graph",
      "construction script",
      "蓝图",
      "蓝图接口",
      "事件图",
    ],
    guidance: [
      "把复杂逻辑拆到函数、组件或 C++",
      "Blueprint 只暴露设计师需要的控制面",
      "避免 Tick、循环和隐式硬引用滥用",
    ],
    boundaries: ["不制造 Blueprint spaghetti"],
    engineAffinity: ["unreal"],
    defaultRank: 43,
  },
  {
    id: "ue-gas-specialist",
    name: "UE GAS Specialist",
    group: "Engine",
    summary: "GAS、Ability、Effect、Attribute、Tag",
    role: "设计和实现 Unreal Gameplay Ability System 架构。",
    triggers: [
      "gas",
      "gameplay ability",
      "gameplay effect",
      "attribute set",
      "gameplay tag",
      "ability task",
      "prediction key",
      "技能系统",
      "能力系统",
      "属性集",
    ],
    guidance: [
      "Ability、Effect、Attribute、Tag 职责分开",
      "预测、冷却、消耗和取消路径要一致",
      "数据资产和 C++/Blueprint 边界明确",
    ],
    boundaries: ["不绕开 GAS 做平行技能系统"],
    engineAffinity: ["unreal"],
    defaultRank: 44,
  },
  {
    id: "ue-replication-specialist",
    name: "UE Replication Specialist",
    group: "Engine",
    summary: "UE 复制、RPC、预测、相关性、带宽",
    role: "保证 Unreal 多人复制架构权威、响应快、带宽可控。",
    triggers: [
      "ue replication",
      "replicated",
      "rpc",
      "net relevancy",
      "net serialization",
      "client prediction",
      "server authoritative",
      "unreal multiplayer",
      "复制",
      "服务器权威",
      "客户端预测",
    ],
    guidance: [
      "状态复制、RPC、预测和校正边界清楚",
      "相关性、频率、序列化控制带宽",
      "所有关键玩法由服务器裁决",
    ],
    boundaries: ["不让客户端拥有权威玩法结果"],
    engineAffinity: ["unreal"],
    defaultRank: 45,
  },
  {
    id: "ue-umg-specialist",
    name: "UE UMG Specialist",
    group: "Engine",
    summary: "UMG、CommonUI、输入路由、Widget",
    role: "按 Unreal UI 最佳实践实现可维护、可适配的界面。",
    triggers: [
      "umg",
      "commonui",
      "widget blueprint",
      "slate",
      "enhanced input ui",
      "data binding",
      "unreal ui",
      "虚幻 UI",
      "控件蓝图",
    ],
    guidance: [
      "Widget 层级、数据源、输入焦点分离",
      "CommonUI 路由适配手柄、键鼠和平台差异",
      "避免高频绑定和不可控 Tick",
    ],
    boundaries: ["不让 UI 直接驱动核心玩法状态"],
    engineAffinity: ["unreal"],
    defaultRank: 46,
  },
  {
    id: "unity-addressables-specialist",
    name: "Unity Addressables Specialist",
    group: "Engine",
    summary: "Addressables、AssetBundle、远程内容、内存",
    role: "管理 Unity 资产加载、卸载、目录、远程内容和内存预算。",
    triggers: [
      "addressables",
      "assetbundle",
      "remote content",
      "content catalog",
      "asset loading",
      "asset unloading",
      "unity memory",
      "资源加载",
      "资源卸载",
      "远程资源",
    ],
    guidance: [
      "加载、释放、引用计数和失败回退必须成对设计",
      "分组和 label 服务内容更新和内存预算",
      "远程目录和版本兼容纳入发布流程",
    ],
    boundaries: ["不混用隐式 Resources 和 Addressables 管理同类资产"],
    engineAffinity: ["unity"],
    defaultRank: 47,
  },
  {
    id: "unity-dots-specialist",
    name: "Unity DOTS Specialist",
    group: "Engine",
    summary: "DOTS、ECS、Jobs、Burst、Hybrid Renderer",
    role: "用 Unity 数据导向技术实现大规模或性能关键系统。",
    triggers: [
      "dots",
      "ecs",
      "entities",
      "jobs system",
      "burst",
      "hybrid renderer",
      "data oriented",
      "unity ecs",
      "实体组件",
      "数据导向",
    ],
    guidance: [
      "只在规模或性能需求明确时引入 DOTS",
      "Component 数据、System 调度、主线程边界清楚",
      "保留 MonoBehaviour 混合和调试路径",
    ],
    boundaries: ["不为普通小系统强上 ECS 复杂度"],
    engineAffinity: ["unity"],
    defaultRank: 48,
  },
  {
    id: "unity-shader-specialist",
    name: "Unity Shader Specialist",
    group: "Engine",
    summary: "Shader Graph、HLSL、VFX Graph、URP/HDRP",
    role: "在 Unity 渲染管线内实现 shader、VFX 和后处理。",
    triggers: [
      "shader graph",
      "hlsl",
      "vfx graph",
      "urp",
      "hdrp",
      "render pipeline",
      "post processing",
      "unity shader",
      "unity vfx",
      "着色器图",
    ],
    guidance: [
      "按 URP/HDRP/内置管线选择实现方式",
      "材质参数暴露给内容制作",
      "移动端、透明排序、批处理成本提前评估",
    ],
    boundaries: ["不写和目标渲染管线冲突的效果"],
    engineAffinity: ["unity"],
    defaultRank: 49,
  },
  {
    id: "unity-ui-specialist",
    name: "Unity UI Specialist",
    group: "Engine",
    summary: "UI Toolkit、UGUI、Canvas、输入、适配",
    role: "按 Unity UI 系统实现响应式、性能友好、可访问的界面。",
    triggers: [
      "ui toolkit",
      "ugui",
      "canvas",
      "uxml",
      "uss",
      "eventsystem",
      "unity ui",
      "input system ui",
      "canvas rebuild",
      "unity 界面",
    ],
    guidance: [
      "选清 UI Toolkit、UGUI 或混合边界",
      "Canvas 分层、重建成本和输入焦点要可控",
      "多分辨率、手柄和触屏适配一起做",
    ],
    boundaries: ["不把所有 UI 塞进单个 Canvas"],
    engineAffinity: ["unity"],
    defaultRank: 50,
  },
  {
    id: "world-builder",
    name: "World Builder",
    group: "Narrative",
    summary: "阵营、文化、历史、地理、生态",
    role: "设计世界设定细节和一致性规则，让内容扩展不互相矛盾。",
    triggers: [
      "worldbuilding",
      "faction",
      "culture",
      "history",
      "geography",
      "ecology",
      "timeline",
      "lore consistency",
      "世界构建",
      "阵营",
      "文化",
      "历史",
      "地理",
      "生态",
    ],
    guidance: [
      "世界规则要解释玩法和叙事限制",
      "阵营、资源、地理和历史互相支撑",
      "设定保持可查、可扩展、可冲突检测",
    ],
    boundaries: ["不堆砌不会影响玩家体验的设定"],
    defaultRank: 51,
  },
  {
    id: "writer",
    name: "Writer",
    group: "Narrative",
    summary: "对白、物品描述、日志、玩家文本",
    role: "写玩家可见文本，保持语气、节奏、信息和世界观一致。",
    triggers: [
      "dialogue",
      "item description",
      "lore entry",
      "environmental text",
      "quest text",
      "barks",
      "对白",
      "物品描述",
      "日志",
      "任务文本",
      "台词",
    ],
    guidance: [
      "文本要符合角色声音和上下文",
      "短文本优先清楚、可本地化、可复用",
      "玩家必须从文本获得行动信息或世界理解",
    ],
    boundaries: ["不写和玩法状态脱节的文本"],
    defaultRank: 52,
  },
];

export const CCGS_GAME_EXPERT_IDS = [
  "accessibility-specialist",
  "ai-programmer",
  "analytics-engineer",
  "art-director",
  "audio-director",
  "community-manager",
  "creative-director",
  "devops-engineer",
  "economy-designer",
  "engine-programmer",
  "game-designer",
  "gameplay-programmer",
  "godot-csharp-specialist",
  "godot-gdextension-specialist",
  "godot-gdscript-specialist",
  "godot-shader-specialist",
  "godot-specialist",
  "lead-programmer",
  "level-designer",
  "live-ops-designer",
  "localization-lead",
  "narrative-director",
  "network-programmer",
  "performance-analyst",
  "producer",
  "prototyper",
  "qa-lead",
  "qa-tester",
  "release-manager",
  "security-engineer",
  "sound-designer",
  "systems-designer",
  "technical-artist",
  "technical-director",
  "tools-programmer",
  "ue-blueprint-specialist",
  "ue-gas-specialist",
  "ue-replication-specialist",
  "ue-umg-specialist",
  "ui-programmer",
  "unity-addressables-specialist",
  "unity-dots-specialist",
  "unity-shader-specialist",
  "unity-specialist",
  "unity-ui-specialist",
  "unreal-specialist",
  "ux-designer",
  "world-builder",
  "writer",
] as const;

const LEGACY_DEFAULT_GAME_EXPERT_IDS = [
  "technical-director",
  "game-designer",
  "gameplay-programmer",
  "unity-specialist",
  "unreal-specialist",
  "godot-specialist",
  "ui-programmer",
  "ux-designer",
  "ai-programmer",
  "network-programmer",
  "performance-analyst",
  "qa-tester",
  "tools-programmer",
  "audio-designer",
  "visual-effects-artist",
  "save-systems-engineer",
] as const;

export const GAME_EXPERT_IDS = GAME_EXPERTS.map((expert) => expert.id);

export const DEFAULT_GAME_EXPERT_SETTINGS: GameExpertSettings = {
  catalogVersion: GAME_EXPERT_CATALOG_VERSION,
  enabled: false,
  engine: "auto",
  mode: "standard",
  maxExperts: 3,
  enabledExpertIds: [...GAME_EXPERT_IDS],
  customExperts: [],
  deletedExpertIds: [],
};

const GAME_TASK_TRIGGERS = [
  "game",
  "gameplay",
  "player",
  "enemy",
  "npc",
  "level",
  "quest",
  "combat",
  "damage",
  "ability",
  "inventory",
  "save",
  "hud",
  "controller",
  "camera",
  "animation",
  "physics",
  "shader",
  "multiplayer",
  "netcode",
  "prototype",
  "vertical slice",
  "release",
  "steam",
  "analytics",
  "telemetry",
  "localization",
  "dialogue",
  "narrative",
  "economy",
  "loot",
  "vfx",
  "sfx",
  "addressables",
  "blueprint",
  "gas",
  "gdscript",
  "unity",
  "unreal",
  "godot",
  "游戏",
  "玩法",
  "玩家",
  "敌人",
  "怪物",
  "关卡",
  "任务",
  "战斗",
  "伤害",
  "技能",
  "背包",
  "存档",
  "界面",
  "手柄",
  "镜头",
  "动画",
  "物理",
  "特效",
  "多人",
  "联机",
  "原型",
  "垂直切片",
  "发布",
  "本地化",
  "对白",
  "剧情",
  "经济",
  "掉落",
  "音效",
  "蓝图",
];

const ENGINE_CONTEXT_TRIGGERS = [
  "character",
  "movement",
  "jump",
  "attack",
  "ability",
  "hit",
  "spawn",
  "角色",
  "移动",
  "跳跃",
  "攻击",
  "技能",
  "命中",
  "生成敌人",
];

function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function uniqueKnownExpertIds(
  value: unknown,
  knownIds: ReadonlySet<string>,
): string[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string" || !knownIds.has(raw) || seen.has(raw))
      continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

function hasSameIds(value: string[], expected: readonly string[]): boolean {
  if (value.length !== expected.length) return false;
  const actual = new Set(value);
  return expected.every((id) => actual.has(id));
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizeEngineAffinity(
  value: unknown,
): Exclude<GameExpertEngine, "auto" | "custom">[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const allowed = new Set(["unity", "unreal", "godot", "web"]);
  const out = normalizeStringList(value).filter((item) =>
    allowed.has(item),
  ) as Exclude<GameExpertEngine, "auto" | "custom">[];
  return out.length > 0 ? out : undefined;
}

export function normalizeGameExpertDefinition(
  value: unknown,
  fallbackRank = GAME_EXPERTS.length + 1,
): GameExpertDefinition | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const source = value as Partial<GameExpertDefinition>;
  const id = typeof source.id === "string" ? source.id.trim() : "";
  const name = typeof source.name === "string" ? source.name.trim() : "";
  if (!id || !name) return null;

  const triggers = normalizeStringList(source.triggers);
  const guidance = normalizeStringList(source.guidance);
  const boundaries = normalizeStringList(source.boundaries);

  return {
    id,
    name,
    group:
      typeof source.group === "string" && source.group.trim()
        ? source.group.trim()
        : "Custom",
    summary:
      typeof source.summary === "string" && source.summary.trim()
        ? source.summary.trim()
        : name,
    role:
      typeof source.role === "string" && source.role.trim()
        ? source.role.trim()
        : `作为 ${name} 提供游戏开发建议。`,
    triggers: triggers.length > 0 ? triggers : [name.toLowerCase()],
    guidance: guidance.length > 0 ? guidance : ["给出可执行、可验证的建议"],
    boundaries:
      boundaries.length > 0 ? boundaries : ["避免脱离项目目标和实现约束"],
    engineAffinity: normalizeEngineAffinity(source.engineAffinity),
    defaultRank: clampInt(
      source.defaultRank,
      1,
      999,
      Math.min(Math.max(1, fallbackRank), 999),
    ),
  };
}

function normalizeCustomExperts(value: unknown): GameExpertDefinition[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: GameExpertDefinition[] = [];
  for (const item of value) {
    const expert = normalizeGameExpertDefinition(
      item,
      GAME_EXPERTS.length + out.length + 1,
    );
    if (!expert || seen.has(expert.id)) continue;
    seen.add(expert.id);
    out.push(expert);
  }
  return out;
}

function mergeGameExpertCatalog(
  customExperts: readonly GameExpertDefinition[],
  deletedExpertIds: readonly string[],
): GameExpertDefinition[] {
  const deleted = new Set(deletedExpertIds);
  const byId = new Map<string, GameExpertDefinition>();
  for (const expert of GAME_EXPERTS) {
    if (!deleted.has(expert.id)) byId.set(expert.id, expert);
  }
  for (const expert of customExperts) {
    if (!deleted.has(expert.id)) byId.set(expert.id, expert);
  }
  return [...byId.values()].sort(
    (a, b) => a.defaultRank - b.defaultRank || a.name.localeCompare(b.name),
  );
}

export function getGameExpertCatalog(
  settings?: Pick<GameExpertSettings, "customExperts" | "deletedExpertIds">,
): GameExpertDefinition[] {
  return mergeGameExpertCatalog(
    normalizeCustomExperts(settings?.customExperts),
    normalizeStringList(settings?.deletedExpertIds),
  );
}

/**
 * CONTRACT: hierarchical slash resolution for the game-expert system.
 *
 * Accepts the path portion of a slash command (everything after `/`, with `/`
 * as the level separator) and resolves it to a concrete set of experts so the
 * user can drill down by level — e.g. `游戏专家/编程/引擎程序` (root → group →
 * expert) — or jump straight to a leaf — e.g. `引擎程序`. Matching is
 * locale-agnostic: each segment is compared against an expert's id and every
 * localized name (and a group's id and every localized label), so the same
 * path works in any UI language.
 *
 * Resolution rules (deepest wins):
 *   - the leading segment is dropped if it is a known root alias (game/游戏专家…)
 *   - an expert match returns just that expert (`kind: 'expert'`)
 *   - a group match returns every available expert in that group (`kind: 'group'`)
 *   - segments that resolve to nothing are ignored, but an expert/group found
 *     deeper in the path always overrides a shallower group
 *   - a bare root (or empty path) returns `null` → caller routes the whole team
 *
 * Returns `null` when no expert/group segment resolves, signalling the caller
 * to fall back to broad lens routing (producer lens / expert blend).
 */
export type GameExpertPathResolution =
  | { kind: "expert"; expertIds: string[]; label: string }
  | { kind: "group"; group: string; expertIds: string[]; label: string };

const GAME_EXPERT_ROOT_ALIASES = new Set<string>(
  [
    "game",
    "games",
    "gamedev",
    "game-dev",
    "game-team",
    "gameteam",
    "gameexpert",
    "game-expert",
    "gameexperts",
    "game-experts",
    "游戏",
    "游戏专家",
    "游戏开发",
    "游戏团队",
    "制作人",
    "ゲーム",
    "ゲーム開発",
    "게임",
    "게임개발",
    "juego",
    "jeu",
    "spiel",
    "игра",
    "لعبة",
    "खेल",
    "jogo",
  ].map((alias) => normalizeSlug(alias)),
);

function normalizeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_/-]+/g, "");
}

export function resolveGameExpertPath(
  path: string,
  settings: GameExpertSettings,
): GameExpertPathResolution | null {
  const normalized = normalizeGameExpertSettings(settings);
  const catalog = getGameExpertCatalog(normalized);
  // Explicit slash resolution is an opt-in; route across the full catalog so a
  // direct `/引擎程序` still works even if the expert is toggled off in settings.
  const available = catalog;

  const expertBySlug = new Map<string, GameExpertDefinition>();
  const groupSlugToName = new Map<string, string>();
  const groupMembers = new Map<string, GameExpertDefinition[]>();
  for (const expert of available) {
    for (const alias of [expert.id, ...gameExpertNameAliases(expert)]) {
      const slug = normalizeSlug(alias);
      if (slug && !expertBySlug.has(slug)) expertBySlug.set(slug, expert);
    }
    for (const alias of [expert.group, ...gameGroupAliases(expert.group)]) {
      const slug = normalizeSlug(alias);
      if (slug && !groupSlugToName.has(slug)) {
        groupSlugToName.set(slug, expert.group);
      }
    }
    const bucket = groupMembers.get(expert.group);
    if (bucket) bucket.push(expert);
    else groupMembers.set(expert.group, [expert]);
  }

  const segments = path
    .split("/")
    .map((segment) => normalizeSlug(segment))
    .filter((segment) => segment.length > 0);

  let resolved: GameExpertPathResolution | null = null;
  for (const segment of segments) {
    if (GAME_EXPERT_ROOT_ALIASES.has(segment)) continue;
    const expert = expertBySlug.get(segment);
    if (expert) {
      // Leaf match: deepest precedence, overrides any group found earlier.
      resolved = { kind: "expert", expertIds: [expert.id], label: expert.name };
      continue;
    }
    const groupName = groupSlugToName.get(segment);
    if (groupName) {
      const members = (groupMembers.get(groupName) ?? []).map((e) => e.id);
      resolved = {
        kind: "group",
        group: groupName,
        expertIds: members,
        label: groupName,
      };
    }
  }

  if (!resolved) return null;
  // Drop members the project deleted from the catalog entirely; keep settings-
  // disabled experts (explicit pick wins) but ensure ids still exist.
  const valid = new Set(available.map((e) => e.id));
  const expertIds = resolved.expertIds.filter((id) => valid.has(id));
  if (expertIds.length === 0) return null;
  return { ...resolved, expertIds };
}

/**
 * CONTRACT: parse a slash command into a game-expert invocation.
 *
 * Given the full composer text, decides whether it is a game-expert command and
 * how to route it. Recognizes any command whose leading path segment is a known
 * root alias (`/game`, `/游戏专家`, …) AND any command whose path resolves to a
 * concrete expert/group even without the root (`/引擎程序`, `/programming`). The
 * level separator is `/`, so `/游戏专家/编程/引擎程序` drills root → group → leaf.
 *
 * Returns:
 *   - `null` when the text is not a game-expert command (caller handles it
 *     elsewhere / sends as a normal prompt)
 *   - `{ task, expertIds }` where `expertIds` is empty for a bare root (whole
 *     broad producer-lens routing) or the resolved ids for a drilled-in path
 *
 * `task` is everything after the first whitespace-separated token (the command
 * path). A bare command with no task returns `task: ''` so the caller can no-op.
 */
export interface GameExpertCommand {
  task: string;
  expertIds: string[];
}

export function parseGameExpertCommand(
  text: string,
  settings: GameExpertSettings,
): GameExpertCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/u.exec(trimmed);
  if (!match) return null;
  const rawPath = match[1] ?? "";
  const task = (match[2] ?? "").trim();

  const segments = rawPath.split("/").filter((s) => s.length > 0);
  const firstSlug = normalizeSlug(segments[0] ?? "");
  const isRoot = GAME_EXPERT_ROOT_ALIASES.has(firstSlug);

  const resolution = resolveGameExpertPath(rawPath, settings);

  // A root alias makes it a game command even when nothing drills deeper
  // (whole-team routing). A non-root path only counts if it resolves to a
  // concrete expert/group — otherwise it's some other slash command.
  if (!isRoot && !resolution) return null;

  return { task, expertIds: resolution?.expertIds ?? [] };
}

/**
 * CONTRACT: discoverable `/` menu entries for the game-expert hierarchy.
 *
 * Builds localized slash suggestions so users can find experts by typing rather
 * than memorizing names. Three tiers, all keyed off the localized labels:
 *   - one root entry (`/游戏专家`) for broad lens routing
 *   - one entry per group (`/游戏专家/编程`) for group-lens routing
 *   - one entry per expert (`/游戏专家/编程/引擎程序`) for a direct pick
 *
 * The `insertText` uses the localized path so it round-trips through
 * parseGameExpertCommand. Returned as plain data; the host maps it onto its own
 * suggestion shape. Returns [] when experts are disabled in settings.
 */
export interface GameExpertMenuEntry {
  id: string;
  name: string;
  detail: string;
  insertText: string;
}

/**
 * CONTRACT: the canonical, stable per-expert slash command.
 *
 * Returns a single-token, space-free command (`/<id>`) that always round-trips
 * through parseGameExpertCommand to pin exactly this expert, no matter the UI
 * locale. The expert id is registered as a resolution alias (see
 * resolveGameExpertPath), so the command resolves even when the expert is
 * toggled off in settings — an explicit pick is itself the opt-in. Internal
 * whitespace in custom ids is collapsed to a dash so the command stays a single
 * token; the slug normalizer strips it again on the way back in, so the
 * round-trip still lands on the same expert.
 *
 * This is the command surfaced on each expert card and in the `/` menu, so the
 * UI label and the actual routing key never drift.
 */
export function gameExpertSlashCommand(expert: GameExpertDefinition): string {
  return `/${expert.id.trim().replace(/\s+/g, "-")}`;
}

export function gameExpertMenuEntries(
  settings: GameExpertSettings,
  locale: Locale,
): GameExpertMenuEntry[] {
  const normalized = normalizeGameExpertSettings(settings);
  if (!normalized.enabled) return [];
  const catalog = getGameExpertCatalog(normalized);
  // Root word per primary locale; other locales fall back to `game`, which is
  // also a recognized root alias so the inserted path still resolves.
  const root =
    locale === "zh-CN"
      ? "游戏专家"
      : locale === "ja-JP"
        ? "ゲーム"
        : locale === "ko-KR"
          ? "게임"
          : "game";

  const entries: GameExpertMenuEntry[] = [
    {
      id: "game-expert:root",
      name: `/${root}`,
      detail:
        locale === "zh-CN"
          ? "游戏开发专家视角：单模型融合约束（完整需求给制作人计划）"
          : "Game-dev expert lens: single-model blended constraints (full requests get a producer plan)",
      insertText: `/${root} `,
    },
  ];

  const seenGroups = new Set<string>();
  for (const expert of catalog) {
    if (!seenGroups.has(expert.group)) {
      seenGroups.add(expert.group);
      const groupLabel = localizedGameGroupLabel(expert.group, locale);
      entries.push({
        id: `game-expert:group:${expert.group}`,
        name: `/${root}/${groupLabel}`,
        detail:
          locale === "zh-CN"
            ? `${groupLabel} 分组的全部专家`
            : `All experts in the ${groupLabel} group`,
        insertText: `/${root}/${groupLabel} `,
      });
    }
    const expertLabel = localizedGameExpertName(expert, locale);
    const command = gameExpertSlashCommand(expert);
    entries.push({
      id: `game-expert:expert:${expert.id}`,
      // Use the stable single-token command (`/<id>`) as the inserted text so it
      // always round-trips to this exact expert. Localized names can contain
      // spaces (e.g. `Unity 专家`, `UI 程序`), and the command parser truncates
      // at the first space — a localized path would mis-resolve to the group.
      name: `${command}  ·  ${expertLabel}`,
      detail: expert.summary,
      insertText: `${command} `,
    });
  }
  return entries;
}

export function normalizeGameExpertSettings(
  value: unknown,
): GameExpertSettings {
  const source =
    value != null && typeof value === "object" && !Array.isArray(value)
      ? (value as Partial<GameExpertSettings>)
      : {};
  const engine = GAME_EXPERT_ENGINE_IDS.includes(
    source.engine as GameExpertEngine,
  )
    ? (source.engine as GameExpertEngine)
    : DEFAULT_GAME_EXPERT_SETTINGS.engine;
  const mode = GAME_EXPERT_MODE_IDS.includes(source.mode as GameExpertMode)
    ? (source.mode as GameExpertMode)
    : DEFAULT_GAME_EXPERT_SETTINGS.mode;
  const customExperts = normalizeCustomExperts(source.customExperts);
  const customOrBuiltInIds = new Set([
    ...GAME_EXPERT_IDS,
    ...customExperts.map((expert) => expert.id),
  ]);
  const deletedExpertIds =
    uniqueKnownExpertIds(source.deletedExpertIds, customOrBuiltInIds) ?? [];
  const catalog = mergeGameExpertCatalog(customExperts, deletedExpertIds);
  const catalogIds = catalog.map((expert) => expert.id);
  const storedExpertIds = uniqueKnownExpertIds(
    source.enabledExpertIds,
    new Set(catalogIds),
  );
  const enabledExpertIds =
    storedExpertIds != null &&
    source.catalogVersion !== GAME_EXPERT_CATALOG_VERSION &&
    hasSameIds(storedExpertIds, LEGACY_DEFAULT_GAME_EXPERT_IDS)
      ? catalogIds
      : (storedExpertIds ?? catalogIds);
  return {
    catalogVersion: GAME_EXPERT_CATALOG_VERSION,
    enabled: source.enabled === true,
    engine,
    mode,
    maxExperts: clampInt(
      source.maxExperts,
      GAME_EXPERT_LIMITS.maxExperts.min,
      GAME_EXPERT_LIMITS.maxExperts.max,
      DEFAULT_GAME_EXPERT_SETTINGS.maxExperts,
    ),
    enabledExpertIds: [...enabledExpertIds],
    customExperts,
    deletedExpertIds,
  };
}

function textHasAny(input: string, triggers: readonly string[]): boolean {
  return triggers.some((trigger) => input.includes(trigger.toLowerCase()));
}

function countMatches(input: string, triggers: readonly string[]): number {
  return triggers.reduce(
    (count, trigger) => count + (input.includes(trigger.toLowerCase()) ? 1 : 0),
    0,
  );
}

function inferredEngine(input: string): GameExpertEngine {
  if (
    textHasAny(input, ["unity", "monobehaviour", "scriptableobject", "prefab"])
  ) {
    return "unity";
  }
  if (
    textHasAny(input, ["unreal", "ue5", "blueprint", "gas", "虚幻", "蓝图"])
  ) {
    return "unreal";
  }
  if (textHasAny(input, ["godot", "gdscript", "scene tree", "戈多"])) {
    return "godot";
  }
  if (textHasAny(input, ["webgl", "three.js", "canvas", "phaser", "pixi"])) {
    return "web";
  }
  return "auto";
}

function isPrimaryEngineExpert(id: string, engine: GameExpertEngine): boolean {
  return (
    (engine === "unity" && id === "unity-specialist") ||
    (engine === "unreal" && id === "unreal-specialist") ||
    (engine === "godot" && id === "godot-specialist")
  );
}

function looksLikeGameTask(input: string, engine: GameExpertEngine): boolean {
  if (textHasAny(input, GAME_TASK_TRIGGERS)) return true;
  if (engine !== "auto" && engine !== "custom") {
    return textHasAny(input, ENGINE_CONTEXT_TRIGGERS);
  }
  return false;
}

/**
 * CONTRACT: routing options for the game-expert selector.
 *
 * `force` is set when the user invokes the experts through an explicit slash
 * command (e.g. `/game`). It bypasses both the settings `enabled` gate and the
 * "does this text look like a game task?" keyword gate, because an explicit
 * command is itself the user's opt-in — the system must never silently no-op
 * on a direct request just because the prompt lacks game keywords. Without
 * `force`, selection stays fully off (the experts never auto-fire from chat).
 *
 * `pinnedExpertIds` is set when a hierarchical slash path resolved to specific
 * expert(s) or a group (see resolveGameExpertPath). When present, selection
 * returns exactly those experts (in catalog order, capped by maxExperts),
 * skipping keyword scoring — the user named who they want. Implies `force`.
 */
export interface GameExpertSelectOptions {
  force?: boolean;
  pinnedExpertIds?: string[];
}

export function selectGameExperts(
  input: string,
  settings: GameExpertSettings,
  options: GameExpertSelectOptions = {},
): GameExpertDefinition[] {
  const pinned = (options.pinnedExpertIds ?? []).filter(
    (id) => typeof id === "string" && id.length > 0,
  );
  const force = options.force === true || pinned.length > 0;
  const normalized = normalizeGameExpertSettings(settings);
  if (!force && !normalized.enabled) return [];

  const catalog = getGameExpertCatalog(normalized);

  // Pinned path: a hierarchical slash resolved to explicit expert(s)/a group.
  // Return exactly those (in catalog order), bypassing keyword scoring — the
  // user named who they want. Capped by maxExperts so a broad group still fits.
  if (pinned.length > 0) {
    const wanted = new Set(pinned);
    return catalog
      .filter((expert) => wanted.has(expert.id))
      .slice(0, normalized.maxExperts);
  }

  const text = input.toLowerCase();
  const enabledIds = new Set(normalized.enabledExpertIds);
  if (enabledIds.size === 0) return [];

  const availableExperts = catalog.filter((expert) =>
    enabledIds.has(expert.id),
  );
  const hasExpertTrigger = availableExperts.some((expert) =>
    textHasAny(text, expert.triggers),
  );
  // Keyword gate only applies to (now-removed) implicit routing. An explicit
  // command always proceeds; experts fall back to the leadership/design pair
  // via the score floor below when no trigger matches the prompt.
  if (
    !force &&
    !looksLikeGameTask(text, normalized.engine) &&
    !hasExpertTrigger
  ) {
    return [];
  }

  const engine =
    normalized.engine === "auto" ? inferredEngine(text) : normalized.engine;
  const scored = availableExperts
    .map((expert) => {
      let score = countMatches(text, expert.triggers);
      if (engine !== "auto" && engine !== "custom") {
        if (expert.engineAffinity?.includes(engine)) {
          if (score > 0) score += 3;
          else if (isPrimaryEngineExpert(expert.id, engine)) score += 1.5;
        }
        if (expert.id === "technical-director") score += 1;
      }
      if (score === 0 && expert.id === "technical-director") score = 0.5;
      if (score === 0 && expert.id === "game-designer") score = 0.4;
      return { expert, score };
    })
    .filter((item) => item.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score || a.expert.defaultRank - b.expert.defaultRank,
    );

  return scored.slice(0, normalized.maxExperts).map((item) => item.expert);
}

function engineLabel(engine: GameExpertEngine): string {
  if (engine === "auto") return "Auto";
  if (engine === "unity") return "Unity";
  if (engine === "unreal") return "Unreal";
  if (engine === "godot") return "Godot";
  if (engine === "web") return "Web game";
  return "Custom";
}

function modeInstruction(mode: GameExpertMode): string {
  if (mode === "light") return "轻量模式：只吸收专家约束，不显式展开视角。";
  if (mode === "council") {
    return "深度模式：复杂取舍先综合各专家视角的冲突点，再给单一结论和建议步骤。";
  }
  return "标准模式：由当前编程模型融合专家视角，给直接、可落地的实现建议。";
}

/**
 * CONTRACT: in-app asset generation channel availability.
 *
 * These map to user-triggerable slash commands wired in AIDock:
 *   - image: `/image`, `/生图`, or `/image-mode-start` (image mode)
 *   - music: `/music`, `/音乐`, or `/music-mode-start` (music mode)
 *   - threeD: `/三维` or `/mesh-mode-start` (mesh mode)
 *
 * The model cannot run these itself; it should proactively recommend the right
 * command when an expert's advice produces an image/audio/3D asset need.
 * `true` means at least one provider for that channel is configured + ready.
 */
export interface GameAssetChannels {
  image: boolean;
  sprite?: boolean;
  music: boolean;
  threeD: boolean;
  video?: boolean;
  speech?: boolean;
  ui?: boolean;
}

function buildChannelGuidance(
  experts: readonly GameExpertDefinition[],
  channels: GameAssetChannels,
): string[] {
  const capabilityIds = experts.reduce<GameAssetCapabilityId[]>(
    (out, expert) => {
      for (const id of defaultCapabilityIdsForRole(expert.id, [expert.id])) {
        if (!out.includes(id)) out.push(id);
      }
      return out;
    },
    [],
  );
  return formatReadyCapabilityGuidance(
    capabilityIds,
    availabilityFromGameAssetChannels(channels),
    "zh-CN",
  );
}

export function buildGameExpertPrompt(
  input: string,
  settings: GameExpertSettings,
  channels?: GameAssetChannels,
  options: GameExpertSelectOptions = {},
): string {
  const normalized = normalizeGameExpertSettings(settings);
  const experts = selectGameExperts(input, normalized, options);
  if (experts.length === 0) return "";

  const expertLines = experts.map((expert, index) =>
    [
      `${index + 1}. ${expert.name} (${expert.group})`,
      `   角色：${expert.role}`,
      `   关注：${expert.guidance.join("；")}`,
      `   边界：${expert.boundaries.join("；")}`,
    ].join("\n"),
  );

  const channelLines = channels ? buildChannelGuidance(experts, channels) : [];

  const expertNames = experts.map((expert) => expert.name).join(" / ");
  // 多专家时才需要显式的协作/交接/仲裁规则；单专家场景这层是噪音。
  const collaborationLines =
    experts.length > 1 ? buildCollaborationRules(experts) : [];
  return [
    "",
    "【游戏专家系统】",
    `已开启。当前任务选择这些专家约束：${expertNames}。`,
    `引擎偏好：${engineLabel(normalized.engine)}。${modeInstruction(normalized.mode)}`,
    // 强制输出要求：无论底层是 Claude/Codex/Gemini，回复都必须先亮明启用了哪些
    // 专家视角，否则像 Codex 这类自带强 system prompt 的编码 agent 会忽略本段、
    // 直接动手而不体现专家身份。这是把"可见性"从模型自觉变成硬性格式要求。
    `【必须输出】回复的第一行先写一条简短播报：「游戏专家视角：${expertNames}」，再开始正文。这是强制格式，不可省略。`,
    "把以下专家约束融合成一个回答。可以说明你正在使用这些专家视角；不要谎称后台并行运行了多个独立智能体、多人会议或外部进程。",
    "优先贴合当前代码库和用户要求；若专家建议冲突，选择能最快验证核心玩法且风险最低的方案。",
    "",
    "【一、角色与边界】每位专家只在自己的 role 与 boundaries 内发声；越界的判断要标注「超出本视角」并交给对应专家，不要替别人拍板。",
    ...expertLines,
    ...(channelLines.length > 0
      ? ["", "【二、可用能力（工具规范）】", ...channelLines]
      : []),
    ...(collaborationLines.length > 0 ? ["", ...collaborationLines] : []),
    "",
    "【四、交付格式】回答按此结构产出，缺项写「无」：",
    "  1) 结论：一句话给出落地方案（多视角冲突时这里只留最终选择）。",
    "  2) 依据：按专家视角分点说明关键取舍，标明各点来自哪个视角。",
    "  3) 落地步骤：可执行、可验证的有序步骤；涉及素材生成时点名对应 slash 命令。",
    "  4) 风险与验证：列出主要风险和最小验证方式（如先跑通核心循环 / 加测试）。",
  ].join("\n");
}

/**
 * 协作 / 交接 / 仲裁层（4 层规范里的"调用决策规则"在多专家组织下的展开）。
 * 单专家不调用此函数；多专家时显式约束视角如何交接、冲突时谁优先，
 * 避免各专家各说各话、或互相越权拍板。
 */
function buildCollaborationRules(
  experts: readonly GameExpertDefinition[],
): string[] {
  // 用 defaultRank 作为仲裁优先级线索：rank 越小越靠近最终决策权（如 TD/制作人）。
  const arbiter = experts.reduce((best, cur) =>
    cur.defaultRank < best.defaultRank ? cur : best,
  );
  return [
    "【三、协作与仲裁（调用决策规则）】",
    "  - 交接：上游视角的产物（如设计规则、架构边界）作为下游视角（实现、测试）的输入，下游不得推翻上游已定的硬约束，只能在其内优化。",
    `  - 仲裁：视角冲突且无法兼得时，以「最快验证核心玩法 + 最低风险」为准；仍僵持则以 ${arbiter.name} 的视角为最终裁决，并在结论里写明被舍弃的方案及原因。`,
    "  - 缺信息：若关键参数缺失导致无法决策，先给出基于合理默认值的方案，并标出该默认值，不要停下来反问。",
  ];
}
