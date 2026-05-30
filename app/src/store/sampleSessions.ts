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

/**
 * Sample session history. The first entry is treated as the active session.
 * Ordered most-recent-first to match the Sidebar's rendering.
 */
export const sampleSessions: Session[] = [
  {
    id: 's_review_changes',
    title: 'Review changes workflow',
    createdAt: Date.parse('2026-05-29T09:12:00Z'),
    isWorkflow: true,
  },
  {
    id: 's_release_pipeline',
    title: 'Release pipeline draft',
    createdAt: Date.parse('2026-05-28T16:40:00Z'),
    isWorkflow: true,
  },
  {
    id: 's_bug_triage',
    title: 'Bug triage loop',
    createdAt: Date.parse('2026-05-27T11:05:00Z'),
    isWorkflow: true,
  },
  {
    id: 's_docs_sync',
    title: 'Docs sync automation',
    createdAt: Date.parse('2026-05-26T14:22:00Z'),
    isWorkflow: true,
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
    text: '已加载工作流「review-changes」。Workflow loaded — 5 nodes, 5 edges.',
    createdAt: Date.parse('2026-05-29T09:12:01Z'),
  },
  {
    id: 'm_seed_user_1',
    role: 'user',
    text: '帮我把扫描和审查之间加一个变更分类步骤。',
    createdAt: Date.parse('2026-05-29T09:13:30Z'),
  },
  {
    id: 'm_seed_assistant_1',
    role: 'assistant',
    text: '建议在 scan → review 之间插入一个 agent(classify) 节点：用 haiku 模型对改动按风险分级，输出经 data 边传给并行审查。要我直接修改图吗？',
    createdAt: Date.parse('2026-05-29T09:13:34Z'),
  },
  {
    id: 'm_seed_user_2',
    role: 'user',
    text: '先确认 verify 步骤是否覆盖了所有审查产物。',
    createdAt: Date.parse('2026-05-29T09:15:10Z'),
  },
  {
    id: 'm_seed_assistant_2',
    role: 'assistant',
    text: 'verify 当前只接收 scan 的 data_out。三路并行审查（quality / security / code）的结论尚未连线进 verify。建议补三条 data 边。',
    createdAt: Date.parse('2026-05-29T09:15:18Z'),
  },
];

/**
 * Prompt-suggestion groups (the default prompt library).
 *
 * Categories: 清晰度 / 完整性 / 成本 / 结构 / 可靠性 / 性能与并行 /
 * 验证与测试 / 可观测性 / 安全与权限 / 界面与体验. Every item is phrased as a concrete,
 * imperative instruction to MODIFY the blueprint — clicking it dispatches
 * `sendPrompt(item.text)`, which the AI uses to rewrite the IRGraph.
 *
 * Each item carries a ready-to-send prompt (`text`) and a short display label.
 * Users can edit / add / remove items and groups in the PromptPanel's edit
 * mode; their changes persist to localStorage and override these defaults
 * until "恢复默认" resets them back to this list.
 *
 * PROMPT_DEFAULTS_VERSION is bumped whenever NEW default groups are added here.
 * On load, the store merges any default group whose `id` is missing from the
 * user's persisted library (one-time per version bump), so newly-shipped
 * default groups appear automatically without discarding the user's edits.
 * Bump history: v1 = 9 groups (clarity…security); v2 = +界面与体验 (ui-ux).
 */
export const PROMPT_DEFAULTS_VERSION = 2;

export const samplePromptGroups: PromptGroup[] = [
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
];

/**
 * Composer dropdown options (workspace / permission / model).
 *
 * Mock data only: the app is a browser SPA with a stub AI, so these cannot
 * read the real filesystem or git. They drive the AI-input composer UI and
 * are carried along with each prompt. The first entry of each list is the
 * default (see `defaultComposer`).
 */
export const permissionOptions: SelectOption[] = [
  { id: 'full', label: '完全访问权限', hint: '读写' },
  { id: 'readonly', label: '只读', hint: '不修改' },
  { id: 'ask', label: '每次询问', hint: '逐步确认' },
];

/**
 * Real Anthropic model ids — the `id` is sent verbatim as the API `model`.
 * The selected id flows through composer.model → streamAnthropic. If a model id
 * is wrong/retired the API returns an HTTP error that surfaces in "AI 返回".
 */
export const modelOptions: SelectOption[] = [
  { id: 'claude-sonnet-4-20250514', label: 'claude-sonnet-4', hint: '标准' },
  { id: 'claude-opus-4-20250514', label: 'claude-opus-4', hint: '深度' },
  { id: 'claude-3-5-haiku-latest', label: 'claude-haiku-3.5', hint: '轻量' },
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
};
