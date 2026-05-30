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

/** Default Anthropic model id (kept in sync with the Rust backend). */
export const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

const API_URL = 'https://api.anthropic.com/v1/messages';

export interface StreamArgs {
  apiKey?: string;
  system: string;
  /** The user turn content. */
  userContent: string;
  model?: string;
  maxTokens?: number;
  /** Abort signal so a caller can cancel an in-flight stream. */
  signal?: AbortSignal;
  /** Invoked with each incremental text chunk as it streams in. */
  onDelta?: (chunk: string) => void;
}

/**
 * Stream a single-turn completion from the Anthropic Messages API. Resolves with
 * the full text once the stream ends; calls `onDelta` for each text delta.
 */
export async function streamAnthropic(args: StreamArgs): Promise<string> {
  const { apiKey, system, userContent, model, maxTokens, signal, onDelta } = args;
  if (!apiKey || !apiKey.trim()) throw new Error('NO_API_KEY');

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey.trim(),
      'anthropic-version': '2023-06-01',
      // Required for direct browser (CORS) access to the Anthropic API.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: model ?? DEFAULT_MODEL,
      max_tokens: maxTokens ?? 4096,
      stream: true,
      system,
      messages: [{ role: 'user', content: userContent }],
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
          delta?: { type?: string; text?: string };
          error?: { message?: string };
        };
        if (evt.type === 'error') {
          throw new Error(evt.error?.message ?? 'stream error');
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
  return full;
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
 * Unified system prompt: the assistant both explains (Chinese prose) AND, when
 * the user's intent is to change the workflow, emits the full updated IRGraph in
 * a fenced ```json block. The caller streams the explanation to the user, hides
 * the JSON, parses it, and applies it to the blueprint. Pure questions get prose
 * only (no fence → no graph change).
 */
export const UNIFIED_SYSTEM = `你是 OpenWorkflow 的工作流编辑助手。OpenWorkflow 把可视化蓝图编译成可运行的 Claude Code workflow 脚本（注入全局 agent/parallel/pipeline/phase/log/workflow，支持 branch/loop 嵌套）。

用户会给你当前蓝图的 IRGraph(JSON) 和一段意见/问题。请按以下格式回复：
1) 先用**简体中文**简要说明你将如何调整蓝图（2-5 句，面向用户，不要贴 JSON）。
2) 如果用户意图是修改/优化工作流，则在说明之后输出**修改后的完整 IRGraph**，包在一个 \`\`\`json 代码块里；如果用户只是提问/分析、不需要改图，则省略代码块。

IRGraph 结构（编译为真实可运行的 workflow，请严格遵守）：
- 外壳：{version, meta, nodes, edges, layout?}
- meta: {name, description?, adapter?, schemaDefs?}（schemaDefs 把 schema 标识符名映射到其 JS 对象源码）
- node: {id, type, parent?, label?, binding?, params}；type ∈ start|end|agent|parallel|pipeline|phase|branch|loop|workflow|log|variable|codeblock；parent 为所在 branch/loop 节点 id（顶层省略）
- agent.params: {prompt, label?, agentType?, model?, schema?, isolation?, phase?}（用 agentType 而非 agent；schema 是裸标识符名，须是 meta.schemaDefs 的键；model ∈ haiku|sonnet|opus）
- parallel.params: {branches:[{prompt, agentType?, model?, schema?, label?}]}
- pipeline.params: {items, stages:[{prompt, agentType?, schema?}]}（items 是输入数组表达式名）
- branch.params/loop.params: {condition}；子节点是独立 node 且 parent 指向该 branch/loop id
- variable.params:{name,value,raw?} log.params:{message} workflow.params:{name} codeblock.params:{code}
- edges: {id, from:{node,port}, to:{node,port}, kind}，kind ∈ exec|data。顶层 start→…→end 串联；branch/loop 用一条 exec 边连到首个子节点，子节点间 child→child；数据流用 data 边（不要在 prompt 里写 \${}）。编辑时尽量保留已有 node id。

代码块里必须是**单个合法 JSON 对象**，不含多余文字或注释。`;
