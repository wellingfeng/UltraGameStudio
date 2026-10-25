/**
 * 思考深度（thinking / reasoning level）能力解析。
 *
 * 设计目标：**与渠道无关、与机器无关，只与「本次请求走哪条协议 + 当前模型是
 * 哪个族」有关**。因此这里不写任何 host / 厂商白名单：
 *
 * 1. `ThinkingWireChannel`：由「传输方式 + adapter」推出请求最终走的协议通道，
 *    决定档位能通过什么字段过线（CLI flag / dsh 覆盖层 / OpenAI 兼容体 /
 *    Anthropic messages 体）。
 * 2. `FAMILIES`：由**模型 id** 推出模型族，决定该模型真实支持哪几档、每档在
 *    wire 上的拼写（`wire`）、以及 pi-ai 需要的 `compat.thinkingFormat`。族表只
 *    登记有公开 API 依据的等级集合；未识别的模型给一套保守的通用档位
 *    （`GENERIC_LEVELS`），因为档位**只在用户主动选择后才过线**，默认档
 *    「不指定」不会给任何端点带去未知字段。
 * 3. 用户显式声明（渠道级 `declaredLevels` / `declaredWire` / `declaredFormat`）
 *    优先级最高，用于覆盖族表判错的网关。
 *
 * 依据（公开接口文档）：
 * - OpenAI `reasoning_effort`：minimal / low / medium / high（o 系列、gpt-5+）
 * - DeepSeek `reasoning_effort`：low / high / max；关闭思考是 `thinking.type=disabled`
 * - Anthropic adaptive thinking effort：low / medium / high
 * - Gemini `thinkingLevel`：low / high（2.5 走 thinkingBudget）
 * - xAI `reasoning_effort`：low / high
 * - Qwen `enable_thinking` / `thinking_budget`、Z.ai `thinking.type`
 * - pi-ai 的档位词汇表（`ModelThinkingLevel`）：off / minimal / low / medium /
 *   high / xhigh / max（`dsh-llm-pi-ai` 的 `reasoningEfforts` 键必须落在其中）
 */
import type { TranslationKey } from '@/lib/i18n';

export interface ThinkingLevelOption {
  /** 展示与选择用的档位 id（原生拼写）。 */
  id: string;
  /** 该档真正过线的拼写；`null` 表示「关闭思考，不发/发 disabled」。 */
  wire: string | null;
  /** 展示文案的 i18n key。 */
  labelKey: TranslationKey;
  /** 该等级的一句话说明 i18n key。 */
  hintKey: TranslationKey;
}

/** 请求最终走的思考参数通道。 */
export type ThinkingWireChannel =
  | 'cli-claude-effort'
  | 'cli-codex-effort'
  | 'dsh-deepseek-native'
  | 'dsh-pi-ai'
  | 'http-openai'
  | 'http-anthropic';

export interface ThinkingLevelSource {
  adapter: string;
  /** 渠道当前生效的模型 id；为空表示用渠道自身默认模型。 */
  model?: string;
  /** 渠道 base URL；仅用于区分 DeepSeek 官方 native 路由与通用兼容路由。 */
  baseUrl?: string;
  /** 传输方式（GatewayTransport）；缺省按 `'cli'` 处理。 */
  transport?: string;
  /** 用户显式声明的档位列表（覆盖模型族判定）。 */
  declaredLevels?: readonly string[];
  /** 用户显式声明的档位 → wire 拼写。 */
  declaredWire?: Readonly<Record<string, string | null>>;
  /** 用户显式声明的 pi-ai thinkingFormat。 */
  declaredFormat?: string;
}

/**
 * 一次请求的完整思考计划：给 CLI / dsh 用的是 `wire`，给直连 HTTP 用的是
 * `openaiBody` / `anthropicThinking`，给 pi-ai 路由声明用的是 `efforts` +
 * `thinkingFormat`。
 */
export interface ThinkingPlan {
  channel: ThinkingWireChannel;
  /** 选中档位 id。 */
  level: string;
  /** 过线拼写；`null` = 关闭/不发。 */
  wire: string | null;
  /** pi-ai `reasoningEfforts`：选择器提供的全部档位及其 wire 拼写。 */
  efforts: Record<string, string | null>;
  /** pi-ai `compat.thinkingFormat`；null = 不写，交由 pi-ai 自行判定。 */
  thinkingFormat: string | null;
  /** OpenAI 兼容请求体要合并的字段；null = 不合并。 */
  openaiBody: Record<string, unknown> | null;
  /** Anthropic messages 请求体的 `thinking` 字段；null = 不写。 */
  anthropicThinking:
    | { type: 'enabled'; budget_tokens: number }
    | { type: 'disabled' }
    | null;
}

/** 选择器里「不指定」的哨兵值：不注入任何参数，保持运行时自身默认。 */
export const THINKING_LEVEL_DEFAULT_ID = 'default';

function level(
  id: string,
  labelKey: TranslationKey,
  hintKey: TranslationKey,
  wire: string | null = id,
): ThinkingLevelOption {
  return { id, wire, labelKey, hintKey };
}

/** i18n key 表：档位 id → 文案 key 后缀。文案缺失时退回 id 本身。 */
const LABEL_KEYS: Record<string, TranslationKey> = {
  off: 'dock.thinkingLevel.off',
  none: 'dock.thinkingLevel.none',
  minimal: 'dock.thinkingLevel.minimal',
  low: 'dock.thinkingLevel.low',
  medium: 'dock.thinkingLevel.medium',
  high: 'dock.thinkingLevel.high',
  xhigh: 'dock.thinkingLevel.xhigh',
  max: 'dock.thinkingLevel.max',
};

/** Localized label for a recorded level; custom levels retain their native spelling. */
export function thinkingLevelLabelKey(id: string): TranslationKey | null {
  if (id === THINKING_LEVEL_DEFAULT_ID) return 'dock.thinkingDefault';
  return LABEL_KEYS[id] ?? null;
}

const HINT_KEYS: Record<string, TranslationKey> = {
  off: 'dock.thinkingHint.off',
  none: 'dock.thinkingHint.none',
  minimal: 'dock.thinkingHint.minimal',
  low: 'dock.thinkingHint.low',
  medium: 'dock.thinkingHint.medium',
  high: 'dock.thinkingHint.high',
  xhigh: 'dock.thinkingHint.xhigh',
  max: 'dock.thinkingHint.max',
};

function makeOption(id: string, wire: string | null): ThinkingLevelOption {
  return level(
    id,
    LABEL_KEYS[id] ?? 'dock.thinkingLevel.medium',
    HINT_KEYS[id] ?? 'dock.thinkingHint.medium',
    wire,
  );
}

/**
 * 一个模型族的思考能力。`match` 只用于模型 id（已去掉 `provider/` 前缀并小写），
 * 不做任何网络/端点判定。
 */
interface ThinkingFamily {
  id: string;
  match: RegExp;
  /** 真实支持的档位（选择器顺序）。空数组 = 该族不推理。 */
  levels: readonly string[];
  /** 档位 → wire 拼写；缺省与档位 id 相同，`null` 表示不发。 */
  wire?: Readonly<Record<string, string | null>>;
  /** pi-ai `compat.thinkingFormat`。 */
  format?: string;
  /** Anthropic messages 的思考预算（token）。 */
  budgets?: Readonly<Record<string, number>>;
  /** 关闭思考时 OpenAI 兼容体要带的字段（如 DeepSeek 的 `thinking`）。 */
  offBody?: Readonly<Record<string, unknown>>;
}

/** 明确不推理的模型：嵌入、重排、审核、语音、图像、以及有据可查的非推理语言模型。 */
const NON_REASONING =
  /(embed|rerank|moderation|whisper|tts|dall-e|gpt-image|stable-diffusion|sdxl|flux-|sora|(^|[/-])gpt-4o|(^|[/-])gpt-4(\.\d)?$|(^|[/-])gpt-3\.5|claude-3(-|\.)|claude-instant|claude-haiku|(^|[/-])haiku|(^|[/-])o1-mini)/;

const FAMILIES: readonly ThinkingFamily[] = [
  {
    // DeepSeek 官方 `reasoning_effort`：low / high / max；关闭走 thinking.type。
    id: 'deepseek',
    match: /(^|[/-])deepseek|deepseek-(chat|reasoner|coder|v\d|r\d)/,
    levels: ['off', 'low', 'high', 'max'],
    wire: { off: null, low: 'low', high: 'high', max: 'max' },
    format: 'deepseek',
    offBody: { thinking: { type: 'disabled' } },
  },
  {
    // OpenAI 推理模型：minimal / low / medium / high。
    id: 'openai-reasoning',
    match: /(^|\/)(o[1-9](-|$)|gpt-5|gpt-6|codex-mini|codex-max)/,
    levels: ['minimal', 'low', 'medium', 'high'],
    format: 'openai',
  },
  {
    // Anthropic adaptive thinking effort：low / medium / high。
    id: 'anthropic',
    match: /claude|(^|[/-])(opus|sonnet|haiku)(-|$)/,
    levels: ['low', 'medium', 'high'],
    budgets: { low: 2048, medium: 8192, high: 16384 },
  },
  {
    // Gemini `thinkingLevel`：low / high。
    id: 'gemini',
    match: /gemini/,
    levels: ['low', 'high'],
    budgets: { low: 2048, high: 16384 },
  },
  {
    // xAI `reasoning_effort`：low / high。
    id: 'grok',
    match: /(^|[/-])grok/,
    levels: ['low', 'high'],
    format: 'openai',
  },
  {
    // Qwen3 `enable_thinking` + `thinking_budget`。
    id: 'qwen',
    match: /(^|[/-])(qwen|qwq)/,
    levels: ['off', 'low', 'medium', 'high'],
    wire: { off: null, low: 'low', medium: 'medium', high: 'high' },
    format: 'qwen',
  },
  {
    // 智谱 GLM `thinking.type`。
    id: 'glm',
    match: /(^|[/-])(glm|zai|zhipu|chatglm)/,
    levels: ['off', 'low', 'medium', 'high'],
    wire: { off: null, low: 'low', medium: 'medium', high: 'high' },
    format: 'zai',
  },
];

/**
 * 未识别模型的通用档位：OpenAI 兼容的标准 `reasoning_effort` 三档。
 * 只在用户主动选档时才过线，默认「不指定」不产生任何额外字段。
 */
const GENERIC_LEVELS: readonly string[] = ['low', 'medium', 'high'];

/** Claude Code CLI：`claude --help` 的 `--effort` 枚举（5 档）。 */
const CLAUDE_CODE_LEVELS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Codex CLI：`model_reasoning_effort` 的枚举（6 档）。 */
const CODEX_LEVELS: readonly string[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

/** 各通道在模型族无法判定时使用的兜底档位。 */
function fallbackLevels(channel: ThinkingWireChannel): readonly string[] {
  switch (channel) {
    case 'cli-claude-effort':
      return CLAUDE_CODE_LEVELS;
    case 'cli-codex-effort':
      return CODEX_LEVELS;
    case 'dsh-deepseek-native':
      return ['off', 'low', 'high', 'max'];
    default:
      return GENERIC_LEVELS;
  }
}

/** 模型 id 归一化：去掉 `provider/` 前缀、版本标签后缀与大小写差异。 */
export function normalizeModelId(model: string | undefined): string {
  const raw = (model ?? '').trim().toLowerCase();
  if (!raw) return '';
  const slash = raw.lastIndexOf('/');
  const tail = slash >= 0 ? raw.slice(slash + 1) : raw;
  return tail.replace(/:free$|:nitro$|:beta$|:latest$/g, '');
}

/** 当前模型落在哪个族；未识别返回 undefined（走通用档位）。 */
export function thinkingFamilyFor(model: string | undefined): ThinkingFamily | undefined {
  const id = normalizeModelId(model);
  if (!id) return undefined;
  if (NON_REASONING.test(id)) return undefined;
  return FAMILIES.find((family) => family.match.test(id));
}

/**
 * 是否明确不推理（用于把「未知」与「确定不支持」区分开：后者整体不渲染选择器）。
 */
export function isNonReasoningModel(model: string | undefined): boolean {
  const id = normalizeModelId(model);
  if (!id) return false;
  return NON_REASONING.test(id);
}

/** 传输方式 + adapter → 真正过线的协议通道。 */
export function resolveThinkingChannel(source: ThinkingLevelSource): ThinkingWireChannel | null {
  const transport = source.transport ?? 'cli';
  if (transport === 'openai-compatible') return 'http-openai';
  if (transport === 'anthropic') return 'http-anthropic';
  if (transport === 'simulator') return null;
  switch (source.adapter) {
    case 'claude-code':
      return 'cli-claude-effort';
    case 'codex':
      return 'cli-codex-effort';
    case 'deepseek-harness':
      // CLI 子进程通道：官方端点走 dsh native 适配器，其余端点走 pi-ai
      // 通用兼容路由（UGS 在 overlap 层按同一判据切换）。
      return isOfficialDeepSeekBaseUrl(source.baseUrl) ? 'dsh-deepseek-native' : 'dsh-pi-ai';
    default:
      return null;
  }
}

/**
 * baseURL 是否指向 DeepSeek 官方端点。镜像 Rust 侧
 * `dsh_log::is_official_deepseek`：只比对 host，忽略协议、端口与路径。
 */
export function isOfficialDeepSeekBaseUrl(baseUrl: string | undefined): boolean {
  const raw = baseUrl?.trim() ?? '';
  if (!raw) return true;
  const afterScheme = raw.includes('://') ? raw.split('://')[1] : raw;
  const host = afterScheme
    .split(/[/:]/)[0]
    .trim()
    .replace(/\.+$/, '')
    .toLowerCase();
  return (
    host === 'api.deepseek.com' ||
    host.endsWith('.deepseek.com') ||
    host === 'deepseek.com'
  );
}

/** 当前渠道 + 模型实际支持的思考等级。空数组 = 该接口没有可用的等级通道。 */
export function thinkingLevelOptions(source: ThinkingLevelSource): ThinkingLevelOption[] {
  const channel = resolveThinkingChannel(source);
  if (!channel) return [];

  if (source.declaredLevels && source.declaredLevels.length > 0) {
    return source.declaredLevels.map((id) =>
      makeOption(id, source.declaredWire?.[id] ?? id),
    );
  }

  // CLI 通道的档位枚举由 CLI 自身决定（`claude --effort` 5 档、
  // `model_reasoning_effort` 6 档），不按模型族收缩：CLI 对不支持的模型会自己
  // 忽略该档，而在这里收缩只会让用户平白少一个可用档位。
  if (channel === 'cli-claude-effort' || channel === 'cli-codex-effort') {
    return fallbackLevels(channel).map((id) => makeOption(id, id));
  }

  // 明确不推理的模型：给档位只会得到 400，整体不渲染。
  if (isNonReasoningModel(source.model)) return [];

  const family = thinkingFamilyFor(source.model);
  const levels = family?.levels ?? fallbackLevels(channel);
  return levels.map((id) => {
    if (family?.wire && id in family.wire) return makeOption(id, family.wire[id]);
    return makeOption(id, id);
  });
}

/**
 * Claude Code 模型目录里的 `default_effort`：CLI 未收到 `--effort` 时该模型
 * 真正生效的档位。依据 = 本机 `claude` CLI 内嵌模型目录实测（2026-09 抓取
 * `default_effort` 字段）：十条具名条目里只有 opus-4-7 / opus-5-5 例外，
 * 其余全是 `high`。
 */
const CLAUDE_CODE_DEFAULT_EFFORT: Readonly<Record<string, string>> = {
  'claude-opus-4-7': 'xhigh',
  'claude-opus-5-5': 'medium',
};

/** 目录里 `default_effort: high` 的那批具名条目（opus / sonnet / fable / mythos）。 */
const CLAUDE_CODE_HIGH_DEFAULT = /^claude-(sonnet|opus|fable|mythos)-\d/;

/** 具名模型 id → CLI 默认档；裸 tier 别名（`opus`/`sonnet`）返回 null —— 它映射到哪个版本由 CLI 决定，不猜。 */
function claudeCodeDefaultEffort(model: string | undefined): string | null {
  const id = normalizeModelId(model);
  if (!id) return null;
  // 模型 id 的 `.` 与目录的 `-` 混用（`claude-opus-4.7` vs `claude-opus-4-7`）。
  const key = id.replace(/\./g, '-');
  if (key in CLAUDE_CODE_DEFAULT_EFFORT) return CLAUDE_CODE_DEFAULT_EFFORT[key];
  if (CLAUDE_CODE_HIGH_DEFAULT.test(key)) return 'high';
  return null;
}

/**
 * 「默认（不指定）」这一项真正等价于什么。`level` 有值 = 能判定到具体档位，
 * 选择器会在对应档位上打「模型默认档」标记；`level` 为 null = 本通道下 UGS
 * 什么都不注入，档位由渠道自己决定，`hintKey` 负责把这件事说清楚（不含糊成
 * 「用渠道默认」）。
 */
export interface ThinkingDefault {
  /** 可判定的具体默认档；null = 由渠道/模型自行决定。 */
  level: string | null;
  /** 「默认（不指定）」项的说明文案 key。 */
  hintKey: TranslationKey;
}

/** 解析当前通道的「默认档」。 */
export function thinkingDefault(source: ThinkingLevelSource): ThinkingDefault {
  switch (resolveThinkingChannel(source)) {
    case 'cli-claude-effort': {
      const level = claudeCodeDefaultEffort(source.model);
      return level
        ? { level, hintKey: 'dock.thinkingDefaultModel' }
        : { level: null, hintKey: 'dock.thinkingDefaultCli' };
    }
    case 'cli-codex-effort':
      return { level: null, hintKey: 'dock.thinkingDefaultCodex' };
    case 'dsh-deepseek-native':
      return { level: null, hintKey: 'dock.thinkingDefaultDeepseek' };
    case 'dsh-pi-ai':
      // pi-ai 的手工声明模型在缺省 `reasoningEfforts` 时**默认不推理**，
      // 所以官方 native 之外的端点选「默认」= 本轮不发任何思考参数。
      return { level: null, hintKey: 'dock.thinkingDefaultGateway' };
    case 'http-openai':
    case 'http-anthropic':
      return { level: null, hintKey: 'dock.thinkingDefaultEndpoint' };
    default:
      return { level: null, hintKey: 'dock.thinkingDefaultCli' };
  }
}

function anthropicThinkingFor(
  levelId: string,
  wire: string | null,
  budgets: Readonly<Record<string, number>> | undefined,
): ThinkingPlan['anthropicThinking'] {
  if (wire === null) return { type: 'disabled' };
  const budget = budgets?.[levelId];
  return { type: 'enabled', budget_tokens: budget ?? 8192 };
}

function openaiBodyFor(
  wire: string | null,
  offBody: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> | null {
  if (wire === null) return offBody ? { ...offBody } : null;
  return { reasoning_effort: wire };
}

/**
 * 解析一次请求的完整思考计划。`levelId` 非法（不在该渠道档位内）时返回 null ——
 * 宁可不发，也不把一个端点不认的档位塞过去。
 */
export function resolveThinkingPlan(
  source: ThinkingLevelSource,
  levelId: string | undefined,
): ThinkingPlan | null {
  const channel = resolveThinkingChannel(source);
  if (!channel) return null;
  const id = levelId?.trim();
  if (!id || id === THINKING_LEVEL_DEFAULT_ID) return null;

  const options = thinkingLevelOptions(source);
  const option = options.find((entry) => entry.id === id);
  if (!option) return null;

  const family = thinkingFamilyFor(source.model);
  const efforts: Record<string, string | null> = {};
  for (const entry of options) {
    efforts[entry.id] = entry.wire;
  }

  return {
    channel,
    level: option.id,
    wire: option.wire,
    efforts,
    thinkingFormat: source.declaredFormat ?? family?.format ?? null,
    openaiBody: openaiBodyFor(option.wire, family?.offBody),
    anthropicThinking: anthropicThinkingFor(option.id, option.wire, family?.budgets),
  };
}

/** 把计划序列化成交给 CLI / dsh 子进程的环境变量。 */
export function thinkingPlanEnv(
  plan: ThinkingPlan | null,
): Record<string, string> {
  if (!plan) return {};
  return {
    UGS_THINKING_LEVEL: plan.level,
    UGS_THINKING_PLAN: JSON.stringify(plan),
  };
}

/** 校验一个已保存的等级在当前渠道下是否仍然合法。 */
export function isSupportedThinkingLevel(
  source: ThinkingLevelSource,
  levelId: string | undefined,
): boolean {
  if (!levelId) return false;
  return thinkingLevelOptions(source).some((option) => option.id === levelId);
}

/** 一条用户覆盖规则：模型 id 包含 `pattern`（`*` = 全部）时用它给的档位集合。 */
export interface ThinkingLevelOverride {
  pattern: string;
  levels: string[];
}

/**
 * 解析用户覆盖文本，每行 `模型匹配=档位1,档位2`；`#` 开头为注释。非法行忽略，
 * 不抛错（设置项里的一份手写文本不该让整轮对话失败）。
 */
export function parseThinkingLevelOverrides(
  raw: string | undefined,
): ThinkingLevelOverride[] {
  const rules: ThinkingLevelOverride[] = [];
  for (const line of (raw ?? '').split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;
    const eq = text.indexOf('=');
    if (eq <= 0) continue;
    const pattern = text.slice(0, eq).trim().toLowerCase();
    const levels = text
      .slice(eq + 1)
      .split(/[,，\s]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (!pattern || levels.length === 0) continue;
    rules.push({ pattern, levels });
  }
  return rules;
}

/** 当前模型命中的第一条覆盖规则的档位集合；没有命中返回 undefined（走自动判定）。 */
export function declaredLevelsFor(
  model: string | undefined,
  rules: readonly ThinkingLevelOverride[],
): string[] | undefined {
  const id = normalizeModelId(model);
  for (const rule of rules) {
    if (rule.pattern === '*') return rule.levels;
    if (id && id.includes(rule.pattern)) return rule.levels;
  }
  return undefined;
}
