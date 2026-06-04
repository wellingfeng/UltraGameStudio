/**
 * Sample data for development and first paint.
 *
 * This module is the single source of seed data for the store's session-domain
 * state: a small set of sessions (with history), the AI message stream for the
 * active session, and the prompt-suggestion groups shown in the PromptPanel.
 *
 * Types are imported from the store domain (./types). No IR types leak in here —
 * the IR seed lives in core/sample.ts.
 *
 * CONTRACT: useStore.ts consumes these named exports to initialize its state.
 * The values are plain data (no ids generated at import time depend on runtime
 * randomness) so dev renders are deterministic.
 */

import type {
  ComposerSettings,
  Message,
  PromptGroup,
  SelectOption,
  Session,
} from './types';
import { DEFAULT_LOCALE, type Locale } from '@/lib/i18n';
import { PROMPT_TRANSLATIONS } from './promptTranslations';

/**
 * Sample session history. The first entry is treated as the active session.
 * Ordered most-recent-first to match the Sidebar's rendering.
 */
export const sampleSessions: Session[] = [
  {
    id: 's_coding_chat',
    title: 'Coding chat',
    createdAt: Date.parse('2026-05-29T09:12:00Z'),
    isWorkflow: false,
  },
  {
    id: 's_release_notes',
    title: 'Release notes help',
    createdAt: Date.parse('2026-05-28T16:40:00Z'),
    isWorkflow: false,
  },
  {
    id: 's_bug_triage',
    title: 'Bug triage chat',
    createdAt: Date.parse('2026-05-27T11:05:00Z'),
    isWorkflow: false,
  },
  {
    id: 's_docs_sync',
    title: 'Docs sync chat',
    createdAt: Date.parse('2026-05-26T14:22:00Z'),
    isWorkflow: false,
  },
];

/** The session shown on first paint. */
export const initialActiveSessionId = sampleSessions[0].id;

/**
 * Sample AI message stream for the active ("Review changes") session.
 * Demonstrates the user / assistant / system roles the AIDock renders.
 */
export const sampleMessages: Message[] = [
  {
    id: 'm_seed_system',
    role: 'system',
    text: '已创建普通聊天会话。',
    createdAt: Date.parse('2026-05-29T09:12:01Z'),
  },
  {
    id: 'm_seed_user_1',
    role: 'user',
    text: '帮我检查最近的代码改动。',
    createdAt: Date.parse('2026-05-29T09:13:30Z'),
  },
  {
    id: 'm_seed_assistant_1',
    role: 'assistant',
    text: '可以。我会先查看变更范围，再按风险和可验证性整理结果。',
    createdAt: Date.parse('2026-05-29T09:13:34Z'),
  },
  {
    id: 'm_seed_user_2',
    role: 'user',
    text: '重点关注 UI 回归和遗漏的测试。',
    createdAt: Date.parse('2026-05-29T09:15:10Z'),
  },
  {
    id: 'm_seed_assistant_2',
    role: 'assistant',
    text: '收到。我会优先检查交互路径、响应式布局、状态更新和相关验证命令。',
    createdAt: Date.parse('2026-05-29T09:15:18Z'),
  },
];

/**
 * Prompt-suggestion groups (the default prompt library).
 *
 * Categories: 互动澄清 / 清晰度 / 完整性 / 成本 / 结构 / 可靠性 / 性能与并行 /
 * 验证与测试 / 可观测性 / 安全与权限 / 界面与体验 / 版本控制. Every item is phrased as a concrete,
 * imperative instruction to MODIFY the blueprint — clicking it appends
 * `item.text` to the AI input box for review before sending.
 *
 * Each item carries a ready-to-send prompt (`text`) and a short display label.
 * Users can edit / add / remove items and groups in the PromptPanel's edit
 * mode; their changes persist to localStorage and override these defaults
 * until "恢复默认" resets them back to this list.
 *
 * PROMPT_DEFAULTS_VERSION is bumped whenever NEW default groups or migrated
 * default items are added here.
 * On load, the store merges any default group whose `id` is missing from the
 * user's persisted library (one-time per version bump), so newly-shipped
 * default groups appear automatically without discarding the user's edits.
 * Bump history: v1 = 9 groups (clarity…security); v2 = +界面与体验 (ui-ux);
 * v4 = +互动澄清 (interactive: grill-me + clarify); v5 = +版本控制
 * (version-control); v6 = +生产级可靠性 prompt.
 */
export const PROMPT_DEFAULTS_VERSION = 7;

export const PROMPT_DEFAULT_ITEM_MIGRATIONS = [
  { groupId: 'reliability', itemId: 'reliability-production-grade' },
] as const;

const basePromptGroups: PromptGroup[] = [
  {
    id: 'interactive',
    label: '互动澄清 / Interactive',
    items: [
      {
        id: 'interactive-grill',
        label: '拷问我 (grill-me)',
        // The exact keyword `grill-me` flips sendPrompt into interrogation mode:
        // the AI asks, one at a time, about gaps in the blueprint via the
        // interaction protocol (rendered as widgets in the AI-return panel).
        text: 'grill-me',
      },
      {
        id: 'interactive-clarify',
        label: '澄清需求',
        text: '在动手改图前，先用交互（select / input）向我确认蓝图中最关键的一个含糊或缺失决策；我回答后，必须立刻把回答写入 workflow 蓝图并输出更新后的 IRGraph。',
      },
    ],
  },
  {
    id: 'clarity',
    label: '清晰度 / Clarity',
    items: [
      {
        id: 'clarity-goal',
        label: '明确目标',
        text: '明确这个工作流的最终目标和成功标准，并用一句话概括每个节点的职责。',
      },
      {
        id: 'clarity-naming',
        label: '统一命名',
        text: '检查节点标签和参数命名是否一致清晰，重命名含糊的节点。',
      },
      {
        id: 'clarity-simplify',
        label: '简化结构',
        text: '识别可以合并或删除的冗余步骤，让主执行链更直观。',
      },
    ],
  },
  {
    id: 'completeness',
    label: '完整性 / Completeness',
    items: [
      {
        id: 'completeness-edges',
        label: '补全边界条件',
        text: '列出未处理的边界条件，并为缺失的分支补全 branch 节点。',
      },
      {
        id: 'completeness-errors',
        label: '错误处理',
        text: '为每个 agent 节点添加失败处理路径，确保异常不会中断整个工作流。',
      },
      {
        id: 'completeness-data',
        label: '数据连线',
        text: '检查三路并行审查的结论是否都连线进 verify 步骤，补全缺失的 data 边。',
      },
    ],
  },
  {
    id: 'cost',
    label: '成本 / Cost',
    items: [
      {
        id: 'cost-model',
        label: '模型降级',
        text: '为低复杂度节点改用更便宜的模型（如 haiku），并估算节省的成本。',
      },
      {
        id: 'cost-parallel',
        label: '并行优化',
        text: '识别可并行执行的步骤，重组为 parallel 节点以缩短总时长。',
      },
      {
        id: 'cost-cache',
        label: '复用与缓存',
        text: '找出可以缓存或复用的中间产物，避免重复调用 agent。',
      },
    ],
  },
  {
    id: 'structure',
    label: '结构 / Structure',
    items: [
      {
        id: 'structure-split',
        label: '单一职责拆分',
        text: '审查每个 agent 节点的职责，把承担多个任务的臃肿 agent 拆分为多个单一职责的 agent 节点，并用 exec 边按依赖顺序重新串接，降低单点失败面。',
      },
      {
        id: 'structure-parallelize',
        label: '并行重组',
        text: '找出 exec 主轴上彼此无数据依赖的串行 agent 节点，把它们重组进一个 parallel 块并行执行；对存在依赖的节点保留 pipeline 串接，缩短关键路径。',
      },
      {
        id: 'structure-phase',
        label: '阶段分组',
        text: '用 phase 节点把工作流划分为清晰的逻辑阶段（如收集→分析→执行→汇总），将相关 agent 归入对应 phase，使蓝图层级和数据流向一目了然。',
      },
      {
        id: 'structure-converge',
        label: '收敛汇总',
        text: '在 parallel 块后面增加一个汇总/合并 agent 节点，用 data 边把各并行分支的输出连入该节点，避免多路结果悬空，确保下游有单一收敛入口。',
      },
      {
        id: 'structure-explicit-data',
        label: '显式数据边',
        text: '检查节点间隐含的上下文传递，为真正存在数据依赖的连接补上明确的 data 边（标注 from 来源节点），并删除多余或重复的数据连线，让数据流可追溯。',
      },
    ],
  },
  {
    id: 'reliability',
    label: '可靠性 / Reliability',
    items: [
      {
        id: 'reliability-retry',
        label: '重试退避',
        text: '为调用外部工具或易出现瞬时失败的 agent 节点添加重试配置（约 3 次、指数退避并加抖动），并在节点说明里标注重试必须保持幂等。',
      },
      {
        id: 'reliability-fallback',
        label: '降级回退',
        text: '为关键 agent 增加 branch 分支作为回退层级：主 agent 失败时依次降级到更简单的规则型节点、更便宜的模型、最后转人工队列，保证流程不中断。',
      },
      {
        id: 'reliability-boundary',
        label: '错误边界',
        text: '用 branch 节点为每个高风险 agent 设置错误边界，把失败路径单独引出到处理/告警分支，防止单个节点的失败沿 exec 主轴级联放大。',
      },
      {
        id: 'reliability-idempotent',
        label: '幂等与超时',
        text: '审查所有产生副作用的 agent 节点，标注幂等键以避免重试导致重复操作，并为每次 LLM 调用设置超时，超时即触发回退分支。',
      },
      {
        id: 'reliability-loop-fuse',
        label: '循环熔断',
        text: '检查 loop 节点是否设置了明确的最大迭代次数和退出条件，补充熔断逻辑，避免无限循环或反复重试同一失败动作拖垮整个工作流。',
      },
      {
        id: 'reliability-production-grade',
        label: '生产级可靠性',
        text: '这是用于生产环境的代码，需要具备企业级可靠性，不要使用MVP(最小可行产品)；',
      },
    ],
  },
  {
    id: 'performance',
    label: '性能与并行 / Performance',
    items: [
      {
        id: 'performance-critical-path',
        label: '关键路径',
        text: '分析 exec 主轴上的最长依赖链，识别可前移或并行化的 agent 节点，把不必要的串行依赖改为 parallel 执行以压缩端到端关键路径耗时。',
      },
      {
        id: 'performance-model-tier',
        label: '模型分级',
        text: '审查各 agent 节点的模型配置，把简单分类/抽取类任务降配到更轻量的模型（如 haiku），把复杂推理保留给强模型，在保证质量前提下提升吞吐。',
      },
      {
        id: 'performance-dedupe',
        label: '去重合并',
        text: '找出重复执行相似工作的 agent 节点，合并为单个可复用节点并用 data 边分发其输出，消除冗余 LLM 调用，减少 token 浪费与延迟。',
      },
      {
        id: 'performance-fanout',
        label: '扇出控制',
        text: '检查 parallel 块的扇出宽度，对过多并行分支设置合理上限或分批，避免一次性触发过量并发 agent 调用引发限流和资源争用。',
      },
    ],
  },
  {
    id: 'verification',
    label: '验证与测试 / Verification',
    items: [
      {
        id: 'verification-verifier',
        label: '验证节点',
        text: '在关键产出 agent 之后插入一个 verifier agent 节点，用 data 边接收上游输出，依据明确的成功标准和评分表检查结果，不达标则回流修正。',
      },
      {
        id: 'verification-adversarial',
        label: '对抗检查',
        text: '为面向用户输入或高风险决策的 agent 增加一个对抗/红队检查 agent 节点，模拟越权与注入场景，在结果进入下游前提前拦截异常行为。',
      },
      {
        id: 'verification-selfcheck',
        label: '自检回环',
        text: '为输出型 agent 增加自检回环：用 loop 或 branch 让节点先核对输出是否满足格式与约束，发现问题先自我修正一次再放行，把错误捕获在级联之前。',
      },
      {
        id: 'verification-criteria',
        label: '成功标准',
        text: '为每个 agent 节点补充可测试的成功标准与输出契约（格式、长度、必含字段），把模糊的完成定义改写为明确验收条件，便于下游验证节点判定。',
      },
    ],
  },
  {
    id: 'observability',
    label: '可观测性 / Observability',
    items: [
      {
        id: 'observability-logs',
        label: '关键日志',
        text: '在每个 phase 边界和关键 agent 输出处插入 log 节点，记录步骤标识、输入摘要与结果状态，让整条 exec 主轴的执行轨迹可追踪、便于事后诊断。',
      },
      {
        id: 'observability-branch',
        label: '分支可见',
        text: '为每个回退/错误 branch 的失败路径补上 log 节点，捕获失败上下文（输入、所在步骤、状态），把神秘的中断变成可诊断的问题。',
      },
      {
        id: 'observability-parallel',
        label: '并行追踪',
        text: '为 parallel 块内各分支加入带统一关联标识的 log 节点，记录各 agent 的耗时与产出，便于在并行执行中定位慢分支和异常分支。',
      },
      {
        id: 'observability-audit',
        label: '审计留痕',
        text: '为涉及高权限操作或外部副作用的 agent 增加 log 节点，记录决策依据与关键元数据，形成可审计的执行留痕以满足合规与回溯需求。',
      },
    ],
  },
  {
    id: 'security',
    label: '安全与权限 / Security',
    items: [
      {
        id: 'security-approval',
        label: '人工审批',
        text: '为不可逆或高影响的 agent 操作（删除、付款、对外发送）前插入一个人工审批 branch 节点，未获确认则阻断 exec 主轴继续向下执行。',
      },
      {
        id: 'security-scope',
        label: '权限边界',
        text: '审查访问外部系统或敏感数据的 agent 节点，在其前后用 branch/log 节点收紧权限边界与作用域，最小化每个节点可触及的能力面。',
      },
      {
        id: 'security-redact',
        label: '敏感脱敏',
        text: '在数据流经 log 节点或跨 agent 传递敏感字段处增加脱敏/最小化处理节点，仅传递必要上下文，避免在 data 边上泄露隐私信息。',
      },
      {
        id: 'security-escalate',
        label: '异常升级',
        text: '为可靠性回退链的末端补上人工兜底分支：当自动重试与降级全部失败时，用 branch 把任务升级到人工处理队列，作为最后一道安全网。',
      },
    ],
  },
  {
    id: 'ui-ux',
    label: '界面与体验 / UI & UX',
    items: [
      {
        id: 'ui-visual-review',
        label: '美观评审',
        text: '在生成界面/前端产物的 agent 之后插入一个 UI 设计评审 agent 节点，依据布局对齐、间距留白、配色对比、字体层级与视觉一致性逐项检查，用 data 边接收界面产物并输出可执行的美化改进清单。',
      },
      {
        id: 'ui-theme-switch',
        label: '多风格切换',
        text: '增加支持多套主题/风格切换的步骤：抽出配色、字号、圆角等设计 token 为 variable 节点，新增一个 agent 生成亮色/暗色及若干品牌风格变体，并加 verifier 节点确认各主题下对比度与可读性达标。',
      },
      {
        id: 'ui-responsive',
        label: '响应式适配',
        text: '增加一个 parallel 块，针对桌面/平板/移动等多个断点并行检查界面布局，识别错位、溢出或拥挤问题，并让下游 agent 按各尺寸给出响应式调整方案。',
      },
      {
        id: 'ui-accessibility',
        label: '无障碍可达',
        text: '增加无障碍审查 agent 节点，对照 WCAG 检查色彩对比度、键盘可达性、焦点顺序、ARIA 标签与屏幕阅读器兼容性，对不达标项输出整改建议并回流修正。',
      },
      {
        id: 'ui-states',
        label: '交互状态',
        text: '为界面流程补全加载中 / 空数据 / 错误 / 成功等状态的处理节点，确保每个关键交互都有明确反馈，并用 branch 覆盖异常态，避免出现无响应或空白页面。',
      },
      {
        id: 'ui-design-system',
        label: '设计系统',
        text: '增加一个设计系统对齐 agent，统一组件样式、间距、圆角、阴影与配色 token，识别并消除一次性 inline 样式，让整套界面在视觉与交互上保持一致。',
      },
      {
        id: 'ui-motion',
        label: '动效过渡',
        text: '增加微交互与过渡动效的设计步骤，为状态切换、加载与反馈补充恰当的动画，提升操作流畅感，同时加约束避免过度动画影响性能与可用性。',
      },
      {
        id: 'ui-usability',
        label: '可用性走查',
        text: '增加一个模拟真实用户的可用性走查 agent 节点，沿关键操作路径发现体验阻塞点（步骤冗长、提示缺失、易误操作），输出按优先级排序的优化建议。',
      },
    ],
  },
  {
    id: 'version-control',
    label: '版本控制 / VCS Safety',
    items: [
      {
        id: 'vcs-isolated-workspace',
        label: '隔离运行',
        text: '在执行会修改文件或版本库状态的步骤前，先要求使用独立工作副本隔离运行（例如 Git worktree、P4 workspace-client、SVN checkout），避免影响用户当前工作区。',
      },
      {
        id: 'vcs-status-check',
        label: '状态检查',
        text: '先识别当前项目使用的版本控制系统（Git、Perforce/P4、SVN 或其他），只读检查未提交改动、冲突、未跟踪项和待提交文件，并在继续前汇总风险。',
      },
      {
        id: 'vcs-protect-changes',
        label: '保护改动',
        text: '保护用户已有的未提交改动；不得覆盖、回滚、重置、删除或替换未确认属于本次任务的文件内容，遇到冲突时先报告并等待确认。',
      },
      {
        id: 'vcs-no-auto-submit',
        label: '禁止自动提交',
        text: '不得自动提交、签入、submit 或 push，也不得自动写入远端或共享版本库；任何进入版本库的动作都必须先等待用户明确确认。',
      },
      {
        id: 'vcs-pre-submit-confirm',
        label: '提交前确认',
        text: '在提交、签入或 submit 前，先汇总本次变更、影响文件、已运行验证、潜在风险和回退方式，等待用户确认后再执行版本库写入动作。',
      },
      {
        id: 'vcs-high-risk-confirm',
        label: '高风险确认',
        text: '执行删除、覆盖、回滚、同步、更新、切换分支/工作副本、大批量重命名等高风险版本控制或文件操作前，必须先说明影响范围并等待用户确认。',
      },
      {
        id: 'vcs-unknown-conservative',
        label: '未知 VCS 保守处理',
        text: '如果无法确认当前项目的版本控制系统或工作区状态，只进行只读分析和建议；不得执行会修改文件、工作副本或版本库状态的动作。',
      },
    ],
  },
];

const EN_LOCALE: Locale = 'en-US';

type EnglishPromptGroup = {
  label: string;
  items: Record<string, { label: string; text: string }>;
};

const englishPromptTranslations: Record<string, EnglishPromptGroup> = {
  interactive: {
    label: 'Interactive',
    items: {
      'interactive-grill': { label: 'Grill me (grill-me)', text: 'grill-me' },
      'interactive-clarify': {
        label: 'Clarify needs',
        text: 'Before editing the blueprint, use an interaction (select / input) to confirm the most important ambiguous or missing decision. After I answer, immediately fold the answer into the workflow blueprint and output the updated IRGraph.',
      },
    },
  },
  clarity: {
    label: 'Clarity',
    items: {
      'clarity-goal': {
        label: 'Clarify goal',
        text: 'Clarify the workflow goal and success criteria, then summarize each node responsibility in one sentence.',
      },
      'clarity-naming': {
        label: 'Normalize names',
        text: 'Check whether node labels and parameter names are consistent and clear. Rename vague nodes.',
      },
      'clarity-simplify': {
        label: 'Simplify structure',
        text: 'Identify redundant steps that can be merged or removed so the main execution chain is easier to read.',
      },
    },
  },
  completeness: {
    label: 'Completeness',
    items: {
      'completeness-edges': {
        label: 'Cover edge cases',
        text: 'List unhandled edge cases and add branch nodes for missing paths.',
      },
      'completeness-errors': {
        label: 'Error handling',
        text: 'Add failure-handling paths for each agent node so exceptions do not interrupt the whole workflow.',
      },
      'completeness-data': {
        label: 'Data wiring',
        text: 'Check whether all three parallel review results flow into verify, and add any missing data edges.',
      },
    },
  },
  cost: {
    label: 'Cost',
    items: {
      'cost-model': {
        label: 'Downgrade models',
        text: 'Move low-complexity nodes to cheaper models such as haiku, and estimate the cost savings.',
      },
      'cost-parallel': {
        label: 'Parallelize work',
        text: 'Identify steps that can run in parallel and restructure them into a parallel node to reduce total duration.',
      },
      'cost-cache': {
        label: 'Reuse and cache',
        text: 'Find intermediate outputs that can be cached or reused to avoid repeated agent calls.',
      },
    },
  },
  structure: {
    label: 'Structure',
    items: {
      'structure-split': {
        label: 'Split responsibilities',
        text: 'Review each agent node responsibility. Split overloaded agents into single-purpose agent nodes and reconnect them with exec edges in dependency order to reduce single points of failure.',
      },
      'structure-parallelize': {
        label: 'Parallel refactor',
        text: 'Find serial agent nodes on the exec spine that have no data dependency on each other. Move them into a parallel block, while keeping dependent nodes in a pipeline to shorten the critical path.',
      },
      'structure-phase': {
        label: 'Group by phase',
        text: 'Use phase nodes to divide the workflow into logical stages such as collect, analyze, execute, and summarize. Move related agents into the right phase so hierarchy and flow are obvious.',
      },
      'structure-converge': {
        label: 'Converge results',
        text: 'Add an aggregation agent after each parallel block. Connect every parallel branch output into it with data edges so downstream nodes receive one clear convergence point.',
      },
      'structure-explicit-data': {
        label: 'Explicit data edges',
        text: 'Review implicit context passing between nodes. Add explicit data edges for real dependencies and remove redundant or duplicate wiring so data flow is traceable.',
      },
    },
  },
  reliability: {
    label: 'Reliability',
    items: {
      'reliability-retry': {
        label: 'Retry backoff',
        text: 'Add retry settings to agent nodes that call external tools or may fail transiently, about 3 attempts with exponential backoff and jitter. Note that retries must be idempotent.',
      },
      'reliability-fallback': {
        label: 'Fallback path',
        text: 'Add branch-based fallback layers for critical agents: on failure, fall back to a simpler rule node, then a cheaper model, then a human queue so the workflow can continue.',
      },
      'reliability-boundary': {
        label: 'Error boundary',
        text: 'Use branch nodes to create error boundaries for high-risk agents. Route failure paths to handling or alerting branches to prevent cascading failure on the exec spine.',
      },
      'reliability-idempotent': {
        label: 'Idempotency and timeout',
        text: 'Review agents with side effects. Add idempotency keys to avoid duplicate actions during retries, and set timeouts for LLM calls that trigger fallback paths.',
      },
      'reliability-loop-fuse': {
        label: 'Loop fuse',
        text: 'Check that loop nodes have a clear maximum iteration count and exit condition. Add circuit-breaker logic to prevent infinite loops or repeated retries of the same failed action.',
      },
      'reliability-production-grade': {
        label: 'Production reliability',
        text: 'This code is for production. It must have enterprise-grade reliability; do not use an MVP (minimum viable product) approach.',
      },
    },
  },
  performance: {
    label: 'Performance',
    items: {
      'performance-critical-path': {
        label: 'Critical path',
        text: 'Analyze the longest dependency chain on the exec spine. Move or parallelize unnecessary serial agents to compress end-to-end latency.',
      },
      'performance-model-tier': {
        label: 'Model tiers',
        text: 'Review model settings. Use lighter models such as haiku for simple classification or extraction, and reserve stronger models for complex reasoning to improve throughput without losing quality.',
      },
      'performance-dedupe': {
        label: 'Deduplicate work',
        text: 'Find agents that repeat similar work. Merge them into one reusable node and distribute its output with data edges to reduce token waste and latency.',
      },
      'performance-fanout': {
        label: 'Fan-out control',
        text: 'Check parallel block fan-out width. Add sensible concurrency limits or batching when too many branches would cause rate limits or resource contention.',
      },
    },
  },
  verification: {
    label: 'Verification',
    items: {
      'verification-verifier': {
        label: 'Verifier node',
        text: 'Insert a verifier agent after critical output agents. Feed upstream output through data edges and validate it against explicit success criteria and a scoring rubric, looping back for correction when it fails.',
      },
      'verification-adversarial': {
        label: 'Adversarial check',
        text: 'Add an adversarial or red-team agent for user-input or high-risk decision steps. Simulate privilege escalation and injection scenarios before results proceed downstream.',
      },
      'verification-selfcheck': {
        label: 'Self-check loop',
        text: 'Add a self-check loop to output-producing agents. Use a loop or branch so the node verifies format and constraints, fixes issues once, then releases the result.',
      },
      'verification-criteria': {
        label: 'Success criteria',
        text: 'Add testable success criteria and output contracts to each agent node, including format, length, and required fields. Replace vague done states with clear acceptance criteria.',
      },
    },
  },
  observability: {
    label: 'Observability',
    items: {
      'observability-logs': {
        label: 'Key logs',
        text: 'Insert log nodes at every phase boundary and critical agent output. Record step id, input summary, and result status so the exec spine is traceable and diagnosable.',
      },
      'observability-branch': {
        label: 'Visible branches',
        text: 'Add log nodes to failure paths in each fallback or error branch. Capture input, step, and status so interruptions become diagnosable.',
      },
      'observability-parallel': {
        label: 'Parallel tracing',
        text: 'Add log nodes with a shared correlation id inside each parallel branch. Record each agent duration and output to locate slow or failing branches.',
      },
      'observability-audit': {
        label: 'Audit trail',
        text: 'Add log nodes around high-permission or externally visible side-effect agents. Record decision evidence and key metadata to create an auditable execution trail.',
      },
    },
  },
  security: {
    label: 'Security & Permissions',
    items: {
      'security-approval': {
        label: 'Human approval',
        text: 'Insert a human-approval branch before irreversible or high-impact agent actions such as deletion, payment, or external sending. Block the exec spine until approval is granted.',
      },
      'security-scope': {
        label: 'Permission boundary',
        text: 'Review agents that access external systems or sensitive data. Use branch or log nodes before and after them to narrow permission scope and minimize capability exposure.',
      },
      'security-redact': {
        label: 'Sensitive redaction',
        text: 'Add redaction or data-minimization nodes where sensitive fields pass through logs or across agents. Send only the necessary context to avoid leaking private data on data edges.',
      },
      'security-escalate': {
        label: 'Escalate exceptions',
        text: 'Add a human fallback branch at the end of the reliability fallback chain. When retries and downgrades fail, route the task to a human handling queue as the final safety layer.',
      },
    },
  },
  'ui-ux': {
    label: 'UI & UX',
    items: {
      'ui-visual-review': {
        label: 'Visual review',
        text: 'Insert a UI design review agent after agents that generate interface or frontend output. Check layout alignment, spacing, color contrast, type hierarchy, and visual consistency, then output actionable polish tasks through data edges.',
      },
      'ui-theme-switch': {
        label: 'Style variants',
        text: 'Add support for multiple themes or style variants. Extract colors, font sizes, and radius values into variable nodes, add an agent to generate light, dark, and brand variants, and add a verifier to check contrast and readability.',
      },
      'ui-responsive': {
        label: 'Responsive checks',
        text: 'Add a parallel block that checks desktop, tablet, and mobile breakpoints in parallel. Identify layout shifts, overflow, and cramped areas, then have a downstream agent propose responsive adjustments for each size.',
      },
      'ui-accessibility': {
        label: 'Accessibility',
        text: 'Add an accessibility review agent. Check WCAG color contrast, keyboard access, focus order, ARIA labels, and screen-reader compatibility, then loop remediation items back for fixes.',
      },
      'ui-states': {
        label: 'Interaction states',
        text: 'Add nodes to cover loading, empty, error, and success states for interface flows. Ensure every key interaction has clear feedback and use branches to cover exceptional states.',
      },
      'ui-design-system': {
        label: 'Design system',
        text: 'Add a design-system alignment agent to normalize component styles, spacing, radius, shadows, and color tokens. Identify and remove one-off inline styles so the interface remains visually and behaviorally consistent.',
      },
      'ui-motion': {
        label: 'Motion',
        text: 'Add a microinteraction and transition design step. Add appropriate animation for state changes, loading, and feedback while constraining motion so it does not hurt performance or usability.',
      },
      'ui-usability': {
        label: 'Usability walk-through',
        text: 'Add a usability walk-through agent that simulates a real user on key paths. Find blockers such as too many steps, missing hints, or risky actions, then output prioritized improvements.',
      },
    },
  },
  'version-control': {
    label: 'VCS Safety',
    items: {
      'vcs-isolated-workspace': {
        label: 'Isolated workspace',
        text: 'Before steps that modify files or VCS state, require an isolated workspace / working copy such as a Git worktree, P4 workspace-client, or SVN checkout so the user\'s current workspace is not affected.',
      },
      'vcs-status-check': {
        label: 'Status check',
        text: 'First identify the version control system in use (Git, Perforce/P4, SVN, or another system). Perform only read-only checks for uncommitted changes, conflicts, untracked items, and pending files, then summarize risks before continuing.',
      },
      'vcs-protect-changes': {
        label: 'Protect changes',
        text: 'Protect the user\'s existing uncommitted changes. Do not automatically overwrite, revert, restore, reset, delete, or replace file contents unless they are confirmed to belong to this task; report conflicts and wait for confirmation.',
      },
      'vcs-no-auto-submit': {
        label: 'No auto-submit',
        text: 'Do not automatically commit, check in, submit, or push, and do not automatically write to a remote or shared repository. Any action that records changes in version control must wait for explicit user confirmation.',
      },
      'vcs-pre-submit-confirm': {
        label: 'Confirm before submit',
        text: 'Before any commit, check in, or submit, summarize the changes, affected files, verification performed, potential risks, and rollback method. Wait for user confirmation before any VCS write action.',
      },
      'vcs-high-risk-confirm': {
        label: 'High-risk confirmation',
        text: 'Before delete, overwrite, revert, restore, sync, update, switch, checkout, or bulk rename operations, explain the impact scope and wait for user confirmation. Do not automatically run these high-risk VCS or file operations.',
      },
      'vcs-unknown-conservative': {
        label: 'Unknown VCS fallback',
        text: 'If the version control system or working copy state cannot be confirmed, perform only read-only analysis and recommendations. Do not run actions that modify files, the workspace / working copy, or version control state.',
      },
    },
  },
};

function withDefaultTranslations(groups: PromptGroup[]): PromptGroup[] {
  return groups.map((group) => {
    const english = englishPromptTranslations[group.id];
    // Aggregate group labels from ALL locale translation maps
    const groupTranslations: Partial<Record<Locale, { label: string }>> = {
      [DEFAULT_LOCALE]: { label: group.label },
      ...(english ? { [EN_LOCALE]: { label: english.label } } : {}),
    };
    for (const [locale, map] of Object.entries(PROMPT_TRANSLATIONS)) {
      const t = map[group.id];
      if (t) {
        groupTranslations[locale as Locale] = { label: t.label };
      }
    }
    return {
      ...group,
      translations: groupTranslations,
      items: group.items.map((item) => {
        const itemEnglish = english?.items[item.id];
        const itemTranslations: Partial<
          Record<Locale, { label: string; text: string }>
        > = {
          [DEFAULT_LOCALE]: { label: item.label, text: item.text },
          ...(itemEnglish ? { [EN_LOCALE]: itemEnglish } : {}),
        };
        for (const [locale, map] of Object.entries(PROMPT_TRANSLATIONS)) {
          const t = map[group.id]?.items[item.id];
          if (t) {
            itemTranslations[locale as Locale] = t;
          }
        }
        return {
          ...item,
          translations: itemTranslations,
        };
      }),
    };
  });
}

export const samplePromptGroups: PromptGroup[] =
  withDefaultTranslations(basePromptGroups);

/**
 * Composer dropdown options (workspace / permission / model).
 *
 * Mock data only: the app is a browser SPA with a stub AI, so these cannot
 * read the real filesystem or git. They drive the AI-input composer UI and
 * are carried along with each prompt. The first entry of each list is the
 * default (see `defaultComposer`).
 */
export const permissionOptions: SelectOption[] = [
  {
    id: 'full',
    label: '完全访问权限',
    hint: '读写',
    translations: {
      'zh-CN': { label: '完全访问权限', hint: '读写' },
      'en-US': { label: 'Full access', hint: 'Read/write' },
      'fr-FR': { label: 'Accès complet', hint: 'Lecture/écriture' },
      'ru-RU': { label: 'Полный доступ', hint: 'Чтение/запись' },
      'es-ES': { label: 'Acceso completo', hint: 'Lectura/escritura' },
      'hi-IN': { label: 'पूर्ण पहुंच', hint: 'पढ़ना/लिखना' },
      'ar-SA': { label: 'وصول كامل', hint: 'قراءة/كتابة' },
      'pt-BR': { label: 'Acesso total', hint: 'Leitura/escrita' },
      'ja-JP': { label: '完全アクセス', hint: '読み書き' },
      'de-DE': { label: 'Voller Zugriff', hint: 'Lesen/Schreiben' },
      'ko-KR': { label: '전체 액세스', hint: '읽기/쓰기' },
    },
  },
  {
    id: 'readonly',
    label: '只读',
    hint: '不修改',
    translations: {
      'zh-CN': { label: '只读', hint: '不修改' },
      'en-US': { label: 'Read only', hint: 'No changes' },
      'fr-FR': { label: 'Lecture seule', hint: 'Aucune modification' },
      'ru-RU': { label: 'Только чтение', hint: 'Без изменений' },
      'es-ES': { label: 'Solo lectura', hint: 'Sin cambios' },
      'hi-IN': { label: 'केवल पढ़ने योग्य', hint: 'कोई परिवर्तन नहीं' },
      'ar-SA': { label: 'للقراءة فقط', hint: 'لا تعديلات' },
      'pt-BR': { label: 'Somente leitura', hint: 'Sem alterações' },
      'ja-JP': { label: '読み取り専用', hint: '変更なし' },
      'de-DE': { label: 'Nur Lesen', hint: 'Keine Änderungen' },
      'ko-KR': { label: '읽기 전용', hint: '변경 없음' },
    },
  },
  {
    id: 'ask',
    label: '每次询问',
    hint: '逐步确认',
    translations: {
      'zh-CN': { label: '每次询问', hint: '逐步确认' },
      'en-US': { label: 'Ask each time', hint: 'Confirm step by step' },
      'fr-FR': { label: 'Demander à chaque fois', hint: 'Confirmer étape par étape' },
      'ru-RU': { label: 'Спрашивать каждый раз', hint: 'Подтверждать пошагово' },
      'es-ES': { label: 'Preguntar cada vez', hint: 'Confirmar paso a paso' },
      'hi-IN': { label: 'हर बार पूछें', hint: 'चरण दर चरण पुष्टि करें' },
      'ar-SA': { label: 'السؤال في كل مرة', hint: 'تأكيد خطوة بخطوة' },
      'pt-BR': { label: 'Perguntar sempre', hint: 'Confirmar passo a passo' },
      'ja-JP': { label: '毎回確認', hint: '段階的に確認' },
      'de-DE': { label: 'Jedes Mal fragen', hint: 'Schritt für Schritt bestätigen' },
      'ko-KR': { label: '매번 묻기', hint: '단계별로 확인' },
    },
  },
];

/**
 * Real Anthropic model ids — the `id` is sent verbatim as the API `model`.
 * The selected id flows through composer.model → streamAnthropic. If a model id
 * is wrong/retired the API returns an HTTP error that surfaces in "AI 返回".
 */
export const modelOptions: SelectOption[] = [
  {
    id: 'claude-sonnet-4-20250514',
    label: 'claude-sonnet-4',
    hint: '标准',
    translations: {
      'zh-CN': { label: 'claude-sonnet-4', hint: '标准' },
      'en-US': { label: 'claude-sonnet-4', hint: 'Standard' },
    },
  },
  {
    id: 'claude-opus-4-20250514',
    label: 'claude-opus-4',
    hint: '深度',
    translations: {
      'zh-CN': { label: 'claude-opus-4', hint: '深度' },
      'en-US': { label: 'claude-opus-4', hint: 'Deep' },
    },
  },
  {
    id: 'claude-3-5-haiku-latest',
    label: 'claude-haiku-3.5',
    hint: '轻量',
    translations: {
      'zh-CN': { label: 'claude-haiku-3.5', hint: '轻量' },
      'en-US': { label: 'claude-haiku-3.5', hint: 'Lightweight' },
    },
  },
];

/**
 * Default composer settings. Permission/model default to the first option;
 * workspace starts empty — it is chosen via the native folder picker and the
 * dropdown shows the user's previously-selected folders (see workspaceHistory).
 */
export const defaultComposer: ComposerSettings = {
  permission: permissionOptions[0].id,
  model: modelOptions[0].id,
  workspace: '',
  modelStrategy: 'inherit',
};
