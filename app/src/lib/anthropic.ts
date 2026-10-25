/**
 * CONTRACT: browser-direct, streaming client for the Anthropic Messages API.
 *
 * The previous AI path only worked inside the Tauri desktop shell (via the Rust
 * `ai_edit_graph` command) and was non-streaming. This module lets the plain
 * web/dev build call the model directly from the browser using the user's
 * locally-stored API key, streaming the response token-by-token so the "AI 返回"
 * panel shows live feedback.
 *
 *   streamAnthropic({ apiKey, system, userContent, model?, signal?, onDelta })
 *       -> Promise<string>   (the full concatenated text)
 *       throws Error('NO_API_KEY') when no key is supplied
 *       throws Error('HTTP <status>: <body>') on a non-2xx response
 *
 * Two system prompts are exported:
 *   - ADVISOR_SYSTEM: a workflow design consultant that returns Chinese prose
 *     analysis / suggestions (NO JSON).
 *   - EDITOR_SYSTEM: returns ONLY an IRGraph JSON object (mirrors the Rust
 *     prompt) — used by the "apply advice to graph" step.
 */

import {
  mergeUsageReports,
  usageReportFromAnthropic,
  type ModelUsageReport,
} from '@/lib/usageMeter';
import { INTERACTION_PROTOCOL } from '@/core/interaction';
import { canUseProviderDirectTransport } from '@/lib/apiConfig';

/** Default Anthropic model id (kept in sync with the Rust backend). */
export const DEFAULT_MODEL = 'claude-sonnet-4-6';

const API_URL = 'https://api.anthropic.com/v1/messages';

export interface StreamArgs {
  apiKey?: string;
  /** Optional custom Anthropic base URL (e.g. a proxy). Empty -> default. */
  baseUrl?: string;
  system: string;
  /** The user turn content. */
  userContent: string;
  /**
   * Optional images attached to the user turn for vision prompts. Each entry is
   * a `data:` URL (preferred; sent as a base64 image block) or an http(s) URL
   * (sent as a url image block). Non-data, non-http strings are ignored.
   */
  userImages?: string[];
  model?: string;
  maxTokens?: number;
  /**
   * Anthropic 原生思考控制（`thinking` 请求字段）。由
   * `thinkingLevels.resolveThinkingPlan` 按档位给出：`enabled` + 预算 token，
   * 或 `disabled` 关闭思考。缺省时不写该字段，保持端点自身默认。
   */
  thinking?:
    | { type: 'enabled'; budget_tokens: number }
    | { type: 'disabled' };
  /** Abort signal so a caller can cancel an in-flight stream. */
  signal?: AbortSignal;
  /** Invoked with each incremental text chunk as it streams in. */
  onDelta?: (chunk: string) => void;
  /** Best-effort parsed provider token usage. Called once when stream ends. */
  onUsage?: (usage: ModelUsageReport) => void;
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source:
        | { type: 'base64'; media_type: string; data: string }
        | { type: 'url'; url: string };
    };

/**
 * Build the Anthropic user message content. With no images this stays a plain
 * string (back-compat); with images it becomes a content-block array carrying
 * the text plus one image block per supported source.
 */
function anthropicUserContent(
  text: string,
  images?: string[],
): string | AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];
  for (const src of images ?? []) {
    const trimmed = src?.trim();
    if (!trimmed) continue;
    const dataMatch = /^data:([^;,]*);base64,(.*)$/s.exec(trimmed);
    if (dataMatch) {
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: dataMatch[1] || 'image/png',
          data: dataMatch[2] ?? '',
        },
      });
    } else if (/^https?:\/\//i.test(trimmed)) {
      blocks.push({ type: 'image', source: { type: 'url', url: trimmed } });
    }
  }
  if (blocks.length === 0) return text;
  return [...blocks, { type: 'text', text }];
}

/**
 * Stream a single-turn completion from the Anthropic Messages API. Resolves with
 * the full text once the stream ends; calls `onDelta` for each text delta.
 */
export async function streamAnthropic(args: StreamArgs): Promise<string> {
  const {
    apiKey,
    baseUrl,
    system,
    userContent,
    userImages,
    model,
    maxTokens,
    thinking,
    signal,
    onDelta,
    onUsage,
  } = args;
  const trimmedApiKey = apiKey?.trim() ?? '';
  if (!canUseProviderDirectTransport(trimmedApiKey, baseUrl)) {
    throw new Error('NO_API_KEY');
  }
  // Anthropic 要求 `max_tokens > thinking.budget_tokens`；预算高于上限时直接
  // 400。这里把预算夹到合法区间，并把 max_tokens 抬到预算之上，避免「选了档位
  // 就报错」这种最差体验。
  const requestedMaxTokens = maxTokens ?? 4096;
  const thinkingField =
    thinking?.type === 'enabled'
      ? {
          type: 'enabled' as const,
          budget_tokens: Math.max(
            1024,
            Math.min(thinking.budget_tokens, Math.max(1024, requestedMaxTokens - 1024)),
          ),
        }
      : thinking;
  const effectiveMaxTokens =
    thinkingField?.type === 'enabled'
      ? Math.max(requestedMaxTokens, thinkingField.budget_tokens + 1024)
      : requestedMaxTokens;

  const userMessageContent = anthropicUserContent(userContent, userImages);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    // Required for direct browser (CORS) access to the Anthropic API.
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  if (trimmedApiKey) headers['x-api-key'] = trimmedApiKey;

  const res = await fetch(resolveEndpoint(baseUrl), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: model ?? DEFAULT_MODEL,
      max_tokens: effectiveMaxTokens,
      stream: true,
      ...(thinkingField ? { thinking: thinkingField } : {}),
      system,
      messages: [{ role: 'user', content: userMessageContent }],
    }),
    signal,
  });

  if (!res.ok || !res.body) {
    const detail = await safeText(res);
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let usage: ModelUsageReport | null = null;
  let stopReason: string | null = null;

  // Parse the Server-Sent Events stream. Each event is a block of lines; we
  // only care about `data:` lines carrying `content_block_delta` text deltas.
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const evt = JSON.parse(data) as {
          type?: string;
          message?: { usage?: unknown; stop_reason?: string };
          usage?: unknown;
          delta?: { type?: string; text?: string; stop_reason?: string };
          error?: { message?: string };
        };
        if (evt.type === 'error') {
          throw new Error(evt.error?.message ?? 'stream error');
        }
        if (evt.type === 'message_start') {
          usage = mergeUsageReports(
            usage,
            usageReportFromAnthropic(evt.message?.usage),
          );
        } else if (evt.type === 'message_delta') {
          usage = mergeUsageReports(usage, usageReportFromAnthropic(evt.usage));
          if (evt.delta?.stop_reason) {
            stopReason = evt.delta.stop_reason;
          }
        } else if (evt.type === 'message_stop') {
          if (evt.message?.stop_reason) {
            stopReason = evt.message.stop_reason;
          }
        }
        if (
          evt.type === 'content_block_delta' &&
          evt.delta?.type === 'text_delta' &&
          typeof evt.delta.text === 'string'
        ) {
          full += evt.delta.text;
          onDelta?.(evt.delta.text);
        }
      } catch {
        /* ignore malformed keep-alive / ping lines */
      }
    }
  }
  if (usage) onUsage?.(usage);
  if (!full.trim() && stopReason === 'content_filter') {
    throw new Error('模型返回空内容：响应被内容安全过滤器拦截。');
  }
  if (!full.trim()) {
    // Distinguish "the SSE stream carried zero events" (protocol / model
    // mismatch — e.g. a Gemini model routed through an Anthropic /v1/messages
    // endpoint that 200s but emits nothing) from "events arrived but no text"
    // (auth failure, model unavailable, request intercepted).
    if (stopReason == null && usage == null) {
      throw new Error(
        '模型返回空内容：SSE 流无任何事件（协议或模型不匹配——请检查渠道 transport 是否与模型协议一致）。',
      );
    }
    throw new Error('模型返回空内容：未收到任何文本 token（可能原因：上游鉴权失败、模型不可用或请求被拦截）。');
  }
  return full;
}

/**
 * Resolve the messages endpoint from an optional custom base URL. An empty
 * base falls back to the default Anthropic endpoint. Otherwise the trailing
 * slash is stripped and the correct `/v1/messages` suffix is appended:
 *   - already ends with `/messages` -> used as-is
 *   - ends with `/v1`               -> append `/messages`
 *   - anything else                 -> append `/v1/messages`
 */
function resolveEndpoint(baseUrl?: string): string {
  const raw = baseUrl?.trim();
  if (!raw) return API_URL;
  const base = raw.replace(/\/+$/, '');
  if (base.endsWith('/messages')) return base;
  if (base.endsWith('/v1')) return `${base}/messages`;
  return `${base}/v1/messages`;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '<no body>';
  }
}

/** Strip a ```json fence (if any) and return the inner JSON payload. */
export function extractJsonObject(text: string): string {
  const t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  // Otherwise take the outermost {...} span.
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start !== -1 && end > start) return t.slice(start, end + 1);
  return t;
}

/**
 * Captain-loop structural guidance, injected into UNIFIED_SYSTEM. The single
 * biggest accuracy lever for COMPLEX, decomposable, high-stakes long tasks: the
 * research (docs/workflow-captain-research.html) found the gap isn't "more
 * agents" but a visible "队长(manager) + 任务账本 + 验收门 + 已验收锚点 + 汇总"
 * structure. This teaches the model when to reach for that shape and gives it a
 * concrete few-shot skeleton to copy — without it the model free-forms complex
 * graphs and routinely omits acceptance/rework. Exported separately so it can be
 * asserted in tests and reused by the headless CLI.
 *
 * Deliberately scoped: simple / single-step / low-risk requests must NOT use it.
 */
export const CAPTAIN_LOOP_GUIDANCE = `**队长闭环（复杂、可拆、高风险的长任务才用）**：当任务复杂、能拆成 ≥3 个相互独立的子任务、风险较高、或"做完还要验收/返工"时，用「队长闭环」结构，而不是堆更多平铺 agent。它的价值是把"拆、派、验"做成可见结构：队长只拆解/调度/汇总/验收、不亲自产出核心产物；worker 各自只做被分配的子任务；验收门看证据而非"已完成"声明；汇总只基于已验收内容。判断"该用"的免费信号：用户描述里出现"先…再…然后"、多个交付物、提到验收/质量/烂尾/返工/端到端/全面。判断"不该用"：简单、单步、低风险需求——仍用最小充分结构，绝不为了显得周全而硬套队长（那会徒增成本与认知负担）。
- 结构（5–7 节点）：目标冻结 agent → 队长拆单 agent(\`agentType:'workflow-manager'\`, \`schema:'TASK_LEDGER'\`) → \`parallel\`(N 个 worker，各执行账本中一个独立子任务) → \`consensus\`(\`strategy:'adversarial'\`, \`schema:'VERDICT'\`，voters = 正向验收者 + 反面复核者) → 汇总 agent(只读已验收产物与未解决 gaps，不拼接全部 worker 输出)。
- 约束：worker 的输出只是候选，唯有验收门通过才算 accepted；汇总不得把所有 worker 输出直接拼起来；\`meta.schemaDefs\` 必须包含 TASK_LEDGER 与 VERDICT 两个 schema 定义。
- 数据流：队长账本用 data 边喂给 \`parallel\`；worker 输出用 data 边喂给 \`consensus\` 验收门；验收门结论(+账本)用 data 边喂给汇总 agent。
- 精简骨架（节点与边的最小形态，可据此扩展）：
  meta.schemaDefs: { TASK_LEDGER: "{ tasks: [{ id:'', title:'', owner:'', acceptance:'', evidenceRequired:'', status:'pending', gaps:[] }] }", VERDICT: "{ pass:false, acceptedArtifact:'', evidence:[], gaps:[{ taskId:'', severity:'P0', reason:'', nextAction:'' }] }" }
  nodes: [ {id:'n_start',type:'start'}, {id:'n_goal',type:'agent',params:{prompt:'冻结目标/非目标/成功标准'}}, {id:'n_captain',type:'agent',params:{prompt:'拆成可验收任务账本',agentType:'workflow-manager',schema:'TASK_LEDGER'}}, {id:'n_workers',type:'parallel',params:{branches:[{prompt:'Worker A…'},{prompt:'Worker B…'}]}}, {id:'n_gate',type:'consensus',params:{voters:[{prompt:'验收：核验证据',schema:'VERDICT'},{prompt:'反面复核：找遗漏',schema:'VERDICT'}],strategy:'adversarial',schema:'VERDICT'}}, {id:'n_summary',type:'agent',params:{prompt:'只读已验收产物与未解决 gaps 汇总'}}, {id:'n_end',type:'end'} ]
  edges: [ exec: n_start→n_goal→n_captain→n_workers→n_gate→n_summary→n_end；data: n_captain→n_workers、n_workers→n_gate、n_gate→n_summary ]`;

/**
 * Unified system prompt: the assistant both explains (Chinese prose) AND emits
 * the full updated IRGraph in a fenced ```json block for normal AI-input turns.
 * The caller streams the explanation to the user, hides the JSON, parses it,
 * and applies it to the blueprint. Pure conceptual questions may omit JSON, but
 * sendPrompt wraps ordinary input as a create/edit request, so those turns should
 * produce a blueprint rather than a markdown plan.
 */
export const UNIFIED_SYSTEM = `你是 UltraGameStudio 的工作流编辑助手。UltraGameStudio 把可视化蓝图编译成可运行的 Claude Code workflow 脚本（注入全局 agent/parallel/pipeline/phase/log/workflow，支持 branch/loop 嵌套）。

用户会给你当前蓝图的 IRGraph(JSON) 和一段意见/问题。请按以下格式回复：
1) 先用**简体中文**简要说明你将如何调整蓝图（2-5 句，面向用户，不要贴 JSON）。
2) 只要用户意见被表述为新建、修改、优化、规划、支持某功能、把需求落地到 workflow、或任何可转成步骤的任务，就必须在说明之后输出**修改后的完整 IRGraph**，包在一个 \`\`\`json 代码块里；如果用户只是问概念且完全不要求改图，才省略代码块。

默认把 AI 输入框里的内容视为“请把需求写入 workflow 蓝图”的编辑任务：
- 不要只输出 Markdown 计划、需求文档、TODO 列表、文件名或等待确认的话。
- 不要创建/修改本地文件，不要探索代码库；即使用户说“规划代码修改/支持这个功能”，也要把它转译成 workflow 蓝图中的 agent、branch、log、verify 等节点。
- 默认直接输出与任务复杂度匹配的蓝图。简单需求用最小充分结构，复杂需求再展开成多步流程；信息不足时先做保守假设，只有会影响正确性或结构的关键缺口，才写成澄清/验证节点。
- 蓝图的周全程度要和任务复杂度、风险、依赖关系匹配：简单问题不要为了“考虑周全”把图做大，复杂问题才增加并行、分支、回退和验收。
- 唯一例外：只有当需求在“最小改动”与“完整蓝图”之间真的存在结构性歧义，且这个选择会明显影响图的形态时，才可按下方交互协议发**一个**两选项 select（“直接改图（最小改动）” / “生成完整多步工作流蓝图”）让用户选择，然后立刻结束本回合；除此之外的一切情况都必须直接出蓝图，绝不只输出说明、计划或 TODO。
- 编辑时尽量保留已有 node id；新增节点和边用稳定、语义化 id，避免破坏现有结构。

IRGraph 结构（编译为真实可运行的 workflow，请严格遵守）：
- 外壳：{version, meta, nodes, edges, layout?}
- meta: {name, description?, adapter?, gateway?:{defaults?:{adapter, modelClass, providerId?, channelId?}}, schemaDefs?}（schemaDefs 把 schema 标识符名映射到其 JS 对象源码）
- node: {id, type, parent?, label?, binding?, params}；type ∈ start|end|agent|parallel|pipeline|phase|branch|loop|workflow|log|variable|codeblock|consensus|composite；parent 为所在 branch/loop/composite 节点 id（顶层省略）
- start.params.userInputs 记录用户的需求、补充说明和澄清回答；Start 节点在画布上只展示摘要。你只读此字段作为上下文，不要新增或改写条目——客户端会自动合并新输入。
- 输出新蓝图时原样保留已有 userInputs 数组（不要增删改），系统侧会自动追加以保证完整。
- agent.params: {prompt, label?, agentType?, model?, gateway?, schema?, isolation?, phase?}（用 agentType 而非 agent；schema 是裸标识符名，须是 meta.schemaDefs 的键；model ∈ haiku|sonnet|opus；默认继承 meta.gateway.defaults，不要给新节点写 model:'sonnet'）
- parallel.params: {branches:[{prompt, agentType?, model?, schema?, label?}]}
- pipeline.params: {items, stages:[{prompt, agentType?, schema?}]}（items 是输入数组表达式名）
- consensus.params: {voters:[{prompt, agentType?, model?, schema?, label?}], strategy, samples?, quorum?, schema?}；strategy ∈ adversarial|multi-lens|tournament|self-consistency；voters 同 parallel.branches，各自带完整 prompt；编译为自包含的 consensus() 辅助函数（多角度扇出→交叉验证→投票），导出脚本可直接在真实 Claude Code 运行
- branch.params/loop.params: {condition}；子节点是独立 node 且 parent 指向该 branch/loop id
- composite.params: {inputs:[{id,kind,label?}], outputs:[{id,kind,label?}], label?}；把一段"本身就是完整子工作流"的复杂步骤封装成可展开的子图——子节点是独立 node 且 parent 指向该 composite 节点 id（与 branch/loop 同理，平铺在同一张图里），编译为自包含的本地 async 函数（可无限嵌套，composite 里还能再放 composite）。端口/绑定约定（务必精确，否则数据流不通）：
  · 输入端口：每个 inputs[].id（如 'in_topic'）。外层喂入：data 边 from:{node:上游,port:'data_out'} → to:{node:该composite,port:'in_topic'}（**to.port 必须等于某 inputs[].id**）；内部读取：data 边 from:{node:该composite,port:'in_topic'} → to:{node:内部节点,port:'data_in'}
  · 输出端口：每个 outputs[].id（如 'out_summary'）。内部写出：data 边 from:{node:内部节点,port:'data_out'} → to:{node:该composite,port:'out_summary'}（**to.port 必须等于某 outputs[].id**）；下游读取：data 边 from:{node:该composite,port:'out_summary'} → to:{node:下游,port:'data_in'}
  · exec：外层 …→composite→后继；体入口用一条 exec 边 from:{node:该composite,port:'exec_out'} → to:{node:首个子节点,port:'exec_in'}（同 branch/loop 体入口约定），子节点间 child→child
  · kind ∈ data|exec，id 用短稳定串
- variable.params:{name,value,raw?} log.params:{message} workflow.params:{name} codeblock.params:{code}
- edges: {id, from:{node,port}, to:{node,port}, kind}，kind ∈ exec|data。start→…→end 用 exec 边连成执行流；branch/loop 用一条 exec 边连到首个子节点，子节点间 child→child；数据流用 data 边（不要在 prompt 里写 \${}）。编辑时尽量保留已有 node id。

**并发优化（重要）**：运行时按依赖图调度——一个节点只要它的所有上游（exec/data 边）都完成就会启动，因此**互相独立的步骤会并行执行**，能显著缩短整体耗时。所以：
- 若多个步骤彼此不依赖（不需要对方的输出），不要排成一条直线，而是从同一个上游各拉一条 exec 边形成**分叉**（如 start 同时连到 A、B、C 并行）；之后若需汇总，再用 data/exec 边把它们都连到下游的汇总节点。
- 只有当 B 确实需要 A 的产出时，才 A→B 串联（并加一条 A→B 的 data 边传递结果）。
- 一组同质并行子任务优先用 parallel 节点；有明确先后依赖的步骤用 pipeline 节点；其余独立步骤用分叉的 exec 拓扑。
- 别为了"看起来整齐"把本可并行的步骤强行串成一条线——那会让运行明显变慢。

**共识/投票（复杂任务才用）**：对**复杂或高风险**的关键步骤（安全审计、架构决策、需要交叉验证、不容出错的结论、需要从多源/多角度核验），用 consensus 节点而非单个 agent——它"多角度探索→对抗式交叉验证→投票"，质量来自对抗而非堆量。判断"复杂"的免费信号：prompt 很长、含多个子目标、汇聚多路上游、命中 审计/安全/架构/重构/验证 等关键词。简单步骤仍用普通 agent，避免无谓的 N 倍成本。策略选择：默认 multi-lens（多视角投票）；安全/强对抗场景用 adversarial（先出结论再专门反驳）；多方案择优用 tournament（打分选胜并嫁接亮点）；同质自检用 self-consistency（同提示跑 N 次取多数）。voters 写成差异化的角度提示，并尽量配 schema（如 VERDICT）让投票可靠。

${CAPTAIN_LOOP_GUIDANCE}

**复合/嵌套（任务非常复杂才用）**：当某一步**本身就是一整个子工作流**——多目标、多阶段、可独立验收、需要自己的内部并行/分支、或单个 agent 的 prompt 已经塞不下——用 composite 节点把它**嵌套成子图**，而不是在主图里继续平铺一长串节点。判断"非常复杂"的免费信号：用户描述里反复出现"先…再…然后…"、可拆出的子任务 ≥ 4、该步需要自己的内部并行/分支结构、与主流程语义上属于不同抽象层。简单或中等复杂度仍用 agent / parallel / pipeline，**不要为了显得有层次而无谓嵌套**（嵌套有认知开销）。composite 的子节点必须 parent=该 composite 节点 id；输入/输出**只能**通过上面的端口约定与外部连接（边的 port 必须精确等于声明的 inputs[].id / outputs[].id），不要让子节点直接拉一条裸 data 边跨出 composite 边界。最小示例（composite c1：1 输入 in_x、1 输出 out_y，内含 a1→a2）：
  nodes: [..., {id:'c1',type:'composite',params:{inputs:[{id:'in_x',kind:'data',label:'输入'}],outputs:[{id:'out_y',kind:'data',label:'结果'}]}}, {id:'a1',type:'agent',parent:'c1',params:{prompt:'…'}}, {id:'a2',type:'agent',parent:'c1',params:{prompt:'…'}}, ...]
  edges: [..., {from:{node:'上游',port:'data_out'},to:{node:'c1',port:'in_x'},kind:'data'}, {from:{node:'c1',port:'in_x'},to:{node:'a1',port:'data_in'},kind:'data'}, {from:{node:'a2',port:'data_out'},to:{node:'c1',port:'out_y'},kind:'data'}, {from:{node:'c1',port:'out_y'},to:{node:'下游',port:'data_in'},kind:'data'}, {from:{node:'c1',port:'exec_out'},to:{node:'a1',port:'exec_in'},kind:'exec'}, {from:{node:'a1',port:'exec_out'},to:{node:'a2',port:'exec_in'},kind:'exec'}, ...]

代码块里必须是**单个合法 JSON 对象**，不含多余文字或注释。`;

/**
 * System prompt for "simple workflow" mode. Here the AI dock acts like a plain
 * CLI/chat: the user's input goes straight to the model and the answer is
 * streamed back. No blueprint generation, no IRGraph — just a direct answer.
 */
export const SIMPLE_CHAT_SYSTEM = `你正在「简单 Workflow」里直接为用户服务，等价于直接用命令行/对话方式调用模型来处理简单问题。请直接根据用户输入作答或完成任务：
- 不要生成、输出或修改 workflow 蓝图，不要输出 IRGraph 或任何 \`\`\`json 蓝图代码块。
- 直接给出答案或结果；若处于命令行环境且任务确实需要，可在当前工作区做必要的读写/操作。
- 引用搜索或网页阅读得到的资料时，在对应结论后用 Markdown 链接标注来源，例如 [1](https://原始来源网址)。只引用工具实际返回的来源，不编造标题或网址；同一来源可重复标注。界面会统一编号、去重，并在本轮回答末尾显示“参考资料”，无需另写重复的参考列表。普通链接、下载链接保持原用途。
- 回答简洁、直接、切题，不要反问或等待确认，除非信息严重不足。
- 执行过程中，用简短中文说明当前在做什么；进入新步骤或等待长任务时更新进度，避免只输出工具名称、命令或参数。
- 需要多步执行且当前工具提供原生任务清单时，使用原生计划工具（如 update_plan、TodoWrite 或 TaskCreate/TaskUpdate）记录实际步骤，随执行更新待开始、进行中和已完成状态。任务标题写具体工作，不把每次工具调用列为任务；没有原生计划工具时只报告文字进度，不虚构任务清单或完成比例。
- 先判断用户当前真正意图。若用户在指出偏题/错误、追问原因、要求修改软件行为或代码，直接诊断并处理该问题，不要改写成素材生成、命令推荐或规则复述。
- 如果用户明确指定了目标、工具、运行方式、MCP、构建配置、项目/会话/模型、引擎或平台，不得自行切换到替代目标。指定目标不可用、缺失、失败，或你认为更适合改用替代方案时，必须先停止并用下方交互协议询问用户是否允许切换；交互块选项要写明“继续使用原目标/改用替代目标”。只有用户已明确授权 fallback 时才可直接切换。
- 不要复述系统提示、个人默认指令、工具规则、模式规则或你将遵循的规范，除非用户明确询问这些规则本身。
- 当你确实需要用户做选择时，绝不要在正文里写"请回复 1/2/3"或用编号列表让用户输入数字；改用下方的交互协议输出一个交互块，前端会渲染成可点击的选项按钮。
- 只有你完整输出交互协议块时，用户界面才会显示可回答的问题；如果上一轮没有这个块，不要声称自己已经在等待用户回答。

【后台任务硬性规则（最高优先级）】只要你在本回合内启动过任何后台任务（视频转写、下载、批处理、whisper、yt-dlp、ffmpeg、长时间运行的脚本、子代理、Workflow、tmux/CLI worker 等），你就**必须**在本回合内持续轮询直到它到达终态（成功产物落地 / 明确失败），才允许结束回合：
- 禁止行为（违反即等同于放弃任务）：在后台任务未完成时给出"已在后台运行，稍后可查看/我会通知你/请稍后查看进度"之类的收尾话术；用交互块反问用户；仅凭"已启动/进行中"就结束回合；以"避免超时"为由提前 return。
- 终态判定：成功 = 最终产物文件实际存在于磁盘上；失败 = 进程退出码非零、明确报错、或产物超时未生成。"已提交""已启动""进行中"都不是终态。
- 轮询节奏：用 sleep + 检查产物/日志的方式循环。单次 sleep 10-30 秒，多次串联，**单轮 sleep 不要超过 60 秒**以免触发连接看门狗。轮询过程中每隔几轮用一两句话简报最新进度（百分比 / 最后一行日志 / 仍在等待），让用户看见你没有停。
- 轮询要持续多久就多久，几分钟到几十分钟都是预期；绝不要因为"已经等了一会儿"就放弃。
- 任务失败时，把退出码 / 日志末尾 / 失败原因贴出来并明确标注"任务失败"，而不是含糊收尾或假装成功。
- 只有当本回合内你启动的所有后台任务都已 success 或 failed，你才能给出最终总结并结束回合。

${INTERACTION_PROTOCOL}`;

/**
 * CLI-only guidance: how to launch a long-running external command so the app
 * can track its REAL progress. Injected into the chat system prompt only when
 * the turn runs through a local CLI (the model can spawn processes there). The
 * problem it prevents: a process detached with `nohup ... &` outlives the CLI
 * turn, so the session's Sidebar dot goes green while the work is still running.
 * Wrapping the command in `ugs-job` writes a manifest the app polls, keeping the
 * session "running" until the artifact lands. See lib/backgroundJobs.ts.
 */
export const BACKGROUND_JOB_INSTRUCTION = `
【后台长任务（重要）】当你要启动一个会持续很久、且需要脱离本轮对话继续跑的外部命令（例如 yt-dlp 下载、whisper 转写、ffmpeg 合成、批处理脚本），不要直接用 \`nohup 命令 &\` 甩到后台——那样进程会脱离应用的进度跟踪，会话左侧的状态点会在本轮回复结束时立刻变成“已完成”的绿色，用户就看不到真实进度了。
- 正确做法：用 \`ugs-job\` 包装器启动，它会登记一份任务清单，应用会轮询并把真实进度显示在该会话的状态点上，直到产物落地或失败：
  \`node <UGS_JOB_PATH> --label "简短中文标签" --artifact "<最终产物绝对路径>" --progress "<进度日志绝对路径>" -- <你的命令> [参数...]\`
- 其中 \`--artifact\` 是任务成功的判定依据（该文件出现即成功）；\`--progress\` 指向一个会持续写入的日志文件，应用会从中提取百分比（默认识别形如 \`63.5%\` 的进度）。会话与工作区身份已通过环境变量自动注入，无需手填。
- 若确实需要 detach，仍要把命令放在 \`ugs-job\` 后面，由它负责登记与善后（自动写 done/fail 标记）。

【禁止提前结束（硬规则，最高优先级）】只要本回合内存在任何已启动但尚未达到终态（success/failed）的后台任务，你就**绝对不能**结束本回合、不能输出"任务已在后台运行，稍后可查看"这类收尾话术、不能用 \`UGS_ASK\` 反问、不能仅凭"已启动"就给出最终答复。违反此条等同于提前放弃任务。
- 终态判定：以 \`--artifact\` 文件实际出现在磁盘上为 success；以 fail 标记或进程失败退出为 failed。"已启动""进行中""已提交"都不是终态。
- 轮询要求：你必须在当前回合内反复执行 sleep + 检查，直到产物落地或失败。节奏：每轮 \`sleep 15\` 后用 \`ls\` / \`Test-Path\` / \`tail\` 等检查 artifact / 进度日志，并向用户简报当前百分比或最新一行日志。
- 单轮 sleep 不要超过 60 秒，避免连接超时；多次短 sleep 串联即可，持续数分钟甚至更长都是预期行为。
- 任务真的失败时，把失败原因与日志末尾贴出来，并明确说明"任务失败"，而不是含糊收尾。
- 只有当所有后台任务都已 success 或 failed，你才能给出最终总结并结束回合。`;

/**
 * Remote-runner flavour of the background-task hard rule. The remote side is a
 * plain Claude Code CLI without access to the local `ugs-job` wrapper, so we
 * drop the wrapper-specific instructions but keep the "never end the turn while
 * a background task is still running" constraint. Used by remoteChatTurn.
 */
export const REMOTE_BACKGROUND_JOB_INSTRUCTION = `
【后台任务硬规则（最高优先级）】本回合内只要你启动过任何后台任务（p4 sync / p4 submit 之外的 p4 长操作、视频转写、whisper、ffmpeg、批处理脚本、长编译、长测试、子代理等），你就**绝对不能**在它到达终态（success 产物落地 / failed 明确报错）之前结束本回合。
- 禁止行为（违反即等同于放弃任务）：在后台任务未完成时给出"已在后台运行，稍后可查看 / 我会通知你 / 请稍后查看进度 / 可以继续干别的"之类的收尾话术；用交互块反问用户；仅凭"已启动 / 进行中 / 已提交"就给出最终答复。
- 终态判定：success = 最终产物文件实际存在于磁盘、或 p4 sync 输出真正显示同步完成；failed = 进程退出码非零、明确报错、或日志末尾出现失败标记。"已启动 / 排队中 / 正在拉取"都不是终态。
- 轮询节奏：用 sleep + 检查产物 / 日志的方式循环。单次 sleep 10-30 秒，多次串联；单轮 sleep 不要超过 60 秒，避免触发连接看门狗。轮询过程中每隔几轮用一两句话向用户简报最新进度（百分比 / 最后一行日志 / 仍在等待）。
- 轮询要持续多久就多久，几分钟到几十分钟都是预期；绝不要因为"已经等了一会儿"就放弃。
- 任务失败时，把退出码 / 日志末尾 / 失败原因贴出来并明确标注"任务失败"，而不是含糊收尾或假装成功。
- 只有当本回合内你启动的所有后台任务都已 success 或 failed，你才能给出最终总结并结束回合。`;

/**
 * CONTRACT: which built-in asset-generation channels are configured + ready.
 *
 * UltraGameStudio ships dedicated generation channels (image / music / 3D mesh /
 * video / animation / speech / sprite, plus a ComfyUI node-graph mode). Each is driven by a
 * slash command and a user-configured provider; the model cannot run them
 * itself. A `true` flag means at least one provider for that channel is
 * configured and ready, so the model should route asset needs there instead of
 * fabricating the asset with PIL / ffmpeg / hand-written code.
 */
export interface AssetChannelAvailability {
  image: boolean;
  music: boolean;
  threeD: boolean;
  video: boolean;
  animation: boolean;
  speech: boolean;
  sprite: boolean;
}

const ASSET_CHANNEL_LINES: Array<{
  key: keyof AssetChannelAvailability;
  line: string;
}> = [
  {
    key: 'image',
    line: '· 生图：需要图片、插画、海报、头像、图标、贴图、UI 草图、概念图等 2D 视觉素材时，用 /image（或 /生图、/image-mode-start 进入生图模式）；要可编辑的节点图工作流则用 /comfyui-mode-start。给出可直接使用的图片提示词。',
  },
  {
    key: 'sprite',
    line: '· 精灵图：需要游戏精灵、序列帧、spritesheet 等素材时，用 /sprite（或 /sprite-mode-start 进入精灵模式）。给出可直接使用的精灵提示词。',
  },
  {
    key: 'threeD',
    line: '· 建模：需要 3D 道具、角色、场景网格、blockout 等资产时，用 /mesh-mode-start 进入建模模式。给出可直接使用的建模提示词。',
  },
  {
    key: 'music',
    line: '· 音乐：需要 BGM、配乐、音乐片段时，用 /music（或 /music-mode-start 进入音乐模式）。给出风格、时长、情绪等可直接使用的音乐提示词。',
  },
  {
    key: 'speech',
    line: '· 语音：需要文本转语音、配音、旁白朗读时，用 /speech（或 /speech-mode-start 进入语音模式）。',
  },
  {
    key: 'video',
    line: '· 视频：需要短视频、动态片段时，用 /video（或 /video-mode-start 进入视频模式）。给出可直接使用的视频提示词。',
  },
  {
    key: 'animation',
    line: '· 动画：需要骨骼动作、角色动作剪辑、动捕、BVH/FBX/GLB 动画、Mixamo/KIMODO 类动作搜索或生成时，用 /anim（或 /anim-mode-start 进入动画模式）。给出动作名称、目标骨架、导出格式和可直接使用的动画提示词。',
  },
];

/**
 * Build a capability-awareness block telling the model about UltraGameStudio's
 * built-in generation channels. Injected into blueprint prompts, and into
 * simple-chat prompts only when the current turn is a concrete asset request,
 * so the model never tries to hand-roll an image with PIL, an audio clip with
 * ffmpeg, etc. when a real channel exists.
 *
 * - Lists only channels that are configured + ready (so we never advertise a
 *   command the user can't actually run).
 * - Always emits the prefer-the-channel rule: when an asset is requested, route
 *   it to the built-in channel first, and only fall back to hand-written code
 *   (PIL / ffmpeg / etc.) when the channel fails, is refused, or can't cover the
 *   need.
 * - Returns '' when no channel is ready (nothing useful to say, and we don't
 *   want to imply a capability the user hasn't set up).
 */
export function buildAssetCapabilityBlock(channels: AssetChannelAvailability): string {
  const ready = ASSET_CHANNEL_LINES.filter(({ key }) => channels[key]);
  if (ready.length === 0) return '';
  return (
    '\n\n【本应用内置生成渠道（重要）】UltraGameStudio 自带由 slash 命令触发的资产生成渠道，' +
    '后台调用用户已配置的真实 Provider。你无法自己执行这些命令，但当用户的需求会产生下列素材时，' +
    '仅在本轮用户明确要求生成、制作、编辑、转换或查找图片/音频/视频/动画/3D/精灵图等具体素材时启用本段；' +
    '若用户是在讨论资产中心、资产列表、展示规则、产品需求、bug、偏题原因或代码修改，忽略本段并直接处理用户问题。' +
    '请优先推荐对应命令并附上一段可直接使用的提示词，让用户一键调用，' +
    '而不是一上来就用 PIL、Pillow、matplotlib、ffmpeg、canvas、SVG 等手写代码去“画”或“合成”，' +
    '也不要假装已经生成。\n' +
    '注意：若本轮系统提示中另有「素材自动生成协议」（用户已进入对应素材模式），则以那段为准——' +
    '此时你可以直接发出生成块由系统实际执行，而不必只是推荐命令让用户手动触发。\n' +
    '只有在以下情况才回退到手写代码：内置渠道生成失败、用户明确拒绝使用内置渠道，' +
    '或该需求超出内置渠道的能力范围（例如需要精确数据驱动的图表、特定文件格式或程序化拼接）。' +
    '回退时要说明原因。可用渠道如下：\n' +
    ready.map(({ line }) => line).join('\n')
  );
}

const EXPLICIT_ASSET_COMMAND_RE =
  /\/(?:image|生图|image-mode-start|comfyui-mode-start|sprite|sprite-mode-start|music|music-mode-start|mesh-mode-start|video|video-mode-start|anim|animation|motion|mocap|anim-mode-start|speech|speech-mode-start|tts)(?:\s|$)/iu;

const ASSET_ADMIN_CONTEXT_RE =
  /(?:资产中心|资产列表|资产库|资产管理|素材中心|下载中心|展示规则|显示规则|列表规则|主列表|原始(?:发送|上传)|上传内容|产品需求|偏题|跑题|无关内容|无关的内容|修改代码|代码修改|以后不要)/iu;

const ASSET_ACTION_RE =
  /(?:生成|制作|做|创建|创作|画|绘制|设计|合成|转换|转成|转为|改成|变成|编辑|修改|去背|抠图|扩图|高清化|修复|建模|渲染|配音|朗读|查找|搜索|compose|create|design|draw|edit|generate|make|model|render|search|voice)/iu;

const CONCRETE_ASSET_RE =
  /(?:图片|图像|插画|海报|头像|图标|贴图|UI\s*草图|概念图|照片|配图|精灵图|序列帧|spritesheet|sprite|音乐|BGM|配乐|音效|歌曲|语音|配音|旁白|朗读|视频|短片|动画|动作|动捕|mocap|motion|bvh|fbx|3D|三维|模型|mesh|glb|gltf|素材|资产|asset)/iu;

/**
 * Simple chat should not carry the slash-channel routing block unless the
 * current user turn is actually asking for concrete media/asset generation.
 * Otherwise product/support requests containing words like "资产中心" can be
 * misread as a request to recommend /image, /sprite, etc.
 */
export function shouldUseAssetCapabilityBlockForPrompt(prompt: string): boolean {
  const text = prompt.trim();
  if (!text) return false;
  if (EXPLICIT_ASSET_COMMAND_RE.test(text)) return true;
  if (ASSET_ADMIN_CONTEXT_RE.test(text)) return false;
  return ASSET_ACTION_RE.test(text) && CONCRETE_ASSET_RE.test(text);
}

/**
 * AI 改图时为每个节点自动选模型的策略。与 store 的 ComposerSettings.modelStrategy
 * 同义，单独在此导出以便 UNIFIED_SYSTEM 注入逻辑独立于 store 类型。
 */
export type ModelStrategy = 'inherit' | 'smart' | 'prefer-better' | 'prefer-cheaper';

/**
 * Build the extra system-prompt block injected after UNIFIED_SYSTEM, instructing
 * the model how to auto-assign per-node `model` tiers (haiku|sonnet|opus) for the
 * current turn.
 *
 * - 'inherit' returns '' (no extra instruction; preserves existing behavior).
 * - the other three return a Chinese instruction block beginning with "\n\n" so it
 *   can be concatenated directly onto UNIFIED_SYSTEM.
 */
export function modelStrategyGuidance(strategy: ModelStrategy): string {
  if (strategy === 'inherit') return '';

  const header =
    `\n\n【本回合启用「模型策略」】请覆盖上文 UNIFIED_SYSTEM 中“默认继承、不要给新节点写 model”的建议，` +
    `主动为每个 agent 节点、以及 parallel.params.branches[] 和 pipeline.params.stages[] 的每个子项设置 model 字段（值 ∈ haiku|sonnet|opus）。\n` +
    `模型档位（能力/成本由高到低）：\n` +
    `- opus：最强最贵，适合架构设计、复杂推理、安全审查、高风险决策。\n` +
    `- sonnet：均衡，适合常规实现、调试、代码审查。\n` +
    `- haiku：最快最便宜，适合简单、机械、确定性任务（格式化、抽取、汇总、日志、简单校验）。\n`;

  let rule = '';
  if (strategy === 'smart') {
    rule =
      `策略=智能匹配大模型：逐节点按难度匹配——简单任务→haiku，常规任务→sonnet，复杂或关键任务→opus。` +
      `根据每个节点的实际复杂度/难度做权衡，不要一刀切。\n`;
  } else if (strategy === 'prefer-better') {
    rule =
      `策略=尽量用更好的大模型：整体上调档位——非琐碎任务一律 opus，常规任务至少 sonnet，仅极简单任务才用 haiku。` +
      `优先保证质量与正确性。\n`;
  } else {
    // prefer-cheaper
    rule =
      `策略=尽量用更便宜的大模型：整体下调档位——默认用 haiku，仅当任务确实需要更强推理或关键正确性时才升到 sonnet，` +
      `极少数最关键的节点才用 opus。优先节省成本。\n`;
  }

  const footer =
    `请在中文说明里简要交代为哪些关键节点选择了更贵或更便宜的模型及其成本权衡，便于用户理解。\n` +
    `注意：模型档位仅对 Claude（claude-code 适配器）有效；若用户全局选择的是 Codex 或 Gemini 渠道，则忽略档位、不要写 model 字段。`;

  return header + rule + footer;
}
