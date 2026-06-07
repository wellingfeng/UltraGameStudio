# Model-Agnostic Deep Research Adapter README

This directory contains the portable protocol for FreeUltraCode's built-in
`/deep-research` workflow. The core procedure is in
`model-agnostic-deep-research.md`; this README explains how to adapt that
procedure across model and tool environments without depending on any private
vendor implementation.

The protocol is designed for source-grounded research tasks: competitive
analysis, technical landscape reviews, literature-style summaries, policy or
regulatory reviews, and other work that needs citations, source scoring,
uncertainty tracking, and reproducible evidence.

## Files

- `model-agnostic-deep-research.md`: model-independent research protocol and
  output template.
- `README.md`: runtime adapter guidance for using the protocol in different
  agent environments.

## Shared Contract

Every runtime should preserve the same contract, even when tools differ:

- State the runtime environment and source boundary before making evidence
  claims.
- Use a source ledger for all cited, rejected, or constrained evidence.
- Cross-check important claims and label them as verified, inferred,
  vendor-stated, community-reported, unverified, or excluded.
- Keep citations close to the claims they support.
- Record gaps and reproducibility notes instead of filling missing evidence with
  confident guesses.
- Do not claim access to private Claude Code, Anthropic, OpenAI, Google,
  Perplexity, or other vendor prompts, rankings, execution logs, or agent
  internals unless the user supplied verifiable evidence.

## Adapter 1: Claude Code / Codex-Style Local Agents

Use this adapter for local coding agents that can inspect a repository, read
local files, run shell commands, and optionally browse the web or use MCP
resources. Examples include Claude Code, Codex-style CLI/IDE agents, and
repo-local automation agents.

适配类别: Claude Code/Codex 类本地 agent。

### Available Capabilities

- Read `model-agnostic-deep-research.md`, repo files, local documents, logs,
  exported pages, and user-provided corpora.
- Use shell tools such as `rg`, `git`, test commands, or local scripts to find
  evidence and validate artifacts.
- Use web, browser, or MCP tools when available and permitted by the user.
- Persist intermediate artifacts such as source ledgers, claim audits, extracted
  tables, or report drafts in the workspace.
- Cite local evidence with stable file paths, headings, line numbers, or
  document identifiers.

### Degradation Strategy

- If live web access is unavailable or forbidden, limit findings to local files,
  uploaded sources, and user-provided URLs or excerpts.
- If shell execution is unavailable, inspect files through the available file
  reader and manually maintain the source ledger.
- If browser rendering is unavailable, do not claim visual or interactive
  behavior was observed; cite source text or mark the behavior unverified.
- If a repository command fails, record the command, failure, and exact next
  validation step in `Gaps`.
- Never execute untrusted code from research sources; use scripts only for safe
  parsing, tabulation, deduplication, or formatting.

需要人工补充的信息: 若任务缺少研究问题、来源边界、时间范围、风险等级或是否允许联网，本地 agent 应先按协议的澄清策略询问；若无法访问付费产品或私有资料，需要用户提供导出页面、日志、截图、文件或可公开核验 URL。

### Inputs

- Research question and intended decision.
- Allowed source boundary: public web, repository paths, local folders, MCP
  resources, uploaded files, or excluded sources.
- Time window, geography, language, jurisdiction, and risk level.
- Desired output format, citation style, and whether to write artifacts to disk.

### Outputs

- Markdown research report or requested structured format.
- Source ledger with URLs or local paths.
- Claim audit with verification status and confidence.
- Gaps, conflicts, stop condition, and reproducibility notes.
- Optional workspace artifacts, such as `research/source-ledger.md` or
  `research/claim-audit.csv`, when requested by the task.

### Example Call

```text
Use protocol/model-agnostic-deep-research.md to research whether this
repository's parser and emitter preserve round-trip behavior. Inspect app/src
and docs only. Produce a cited report with file-path evidence, a claim audit,
and gaps. Do not browse the public web.
```

## Adapter 1B: OpenWorkflow / Ultracode Dynamic Harness

Use this adapter inside OpenWorkflow when the user invokes `/deep-research` or
when a normal `/ultracode` task explicitly asks for deep research. This path is
closest to Claude Code's public dynamic-workflow pattern, but it is an
OpenWorkflow implementation: the portable protocol defines the evidence contract,
and `/ultracode` supplies planning, parallel workers, adversarial verification,
acceptance gates, run ledgers, and resumability.

适配类别: OpenWorkflow `/ultracode` 动态 workflow。

### Available Capabilities

- Convert `/deep-research <question>` into a `/ultracode` objective that loads
  this protocol.
- Let the dynamic harness planner choose worker groups for source families,
  facets, vendors, jurisdictions, hypotheses, or counter-claims.
- Run parallel worker groups and synthesize them before an adversarial
  acceptance gate.
- Persist `harness.json`, `workflow.fuc.json`, `events.jsonl`, `result.json`,
  `objective-checks.json`, and final summaries under `.fuc-run/<run-id>/`.
- Resume incomplete work with `/ultracode --resume --run-id <id>` when budget,
  tool failure, or evidence gaps prevent acceptance.

### Degradation Strategy

- If the selected model or route has no live web/search tools, limit the run to
  local files, user-provided URLs/excerpts, or available MCP resources, and mark
  public-web verification as unavailable.
- If source accessibility cannot be objectively checked, record it as a gap and
  require manual URL verification before publication.
- If the dynamic planner overpromises source coverage, the acceptance gate must
  fail or mark the affected claims unverified.
- If the run exhausts agent-call budget, use the preserved run ledger to resume
  rather than treating partial worker output as accepted research.

需要人工补充的信息: 用户应提供研究问题、是否允许联网、来源边界、时间范围、风险等级、输出路径和预算。若涉及账号内资料、付费数据库或私有文档，用户需要提供导出文件、截图、URL、MCP 资源或明确的本地目录。

### Inputs

- `/deep-research <question>` from simple Workflow chat, or
  `/ultracode <deep-research objective>`.
- Optional source scope: public web, repo docs, local folders, URLs, fixed
  corpus, excluded domains, language, geography, jurisdiction, and date range.
- Optional execution controls: `--max-agent-calls`, `--max-rounds`,
  `--concurrency`, `--timeout`, `--verify-command`, and `--resume`.

### Outputs

- `/ultracode` run summary and acceptance verdict.
- Source ledger, claim audit, findings, conflicts, gaps, and reproducibility
  notes inside the final report.
- Run artifacts under `.fuc-run/<run-id>/` for audit and resume.

### Example Calls

```text
/deep-research 调研 Claude Code /deep-research 的公开证据，并设计一个面向 OpenWorkflow、Codex、OpenAI API 和无工具模型的通用协议。要求来源表、claim audit、比较矩阵和 gaps。
```

```text
/ultracode --max-agent-calls 24 执行 deep-research：使用内置 workflows/deep-research/protocol/model-agnostic-deep-research.md。研究主流 AI deep research 产品的可迁移设计，输出 docs/research/deep-research-landscape.md，并用 objective checks 确认报告包含 Source Ledger、Claim Audit、Gaps。
```

## Adapter 2: OpenAI Responses/API-Style Agents

Use this adapter for programmatic agents built on the OpenAI Responses API or a
similar hosted model API where tools are explicitly wired by the application.
The model may have hosted web search, file search, code execution, function
calling, structured outputs, or no tools depending on the caller's setup.

适配类别: OpenAI Responses/API 类 agent。

### Available Capabilities

- Use hosted or application-provided search tools when enabled.
- Use uploaded files, vector stores, file-search tools, or retrieval functions
  when the application supplies a corpus.
- Use function calls for source fetching, deduplication, extraction, scoring, and
  report serialization when those functions are provided.
- Emit structured JSON, Markdown, or both for downstream systems.
- Track tool calls, source IDs, timestamps, and retrieval status in
  reproducibility notes.

### Degradation Strategy

- If the API call has no search or retrieval tool, ask for URLs, files, excerpts,
  or a fixed corpus before making verification-heavy claims.
- Treat hosted deep-research or search output as one research artifact, not as
  automatically verified truth; audit its citations through this protocol's source
  scoring.
- If tool results lack dates, authors, or accessible URLs, lower confidence and
  list the missing metadata.
- If tool budgets, rate limits, context limits, or timeouts truncate retrieval,
  report the stop condition and unresolved claims.
- If structured output is required but evidence is incomplete, return explicit
  `unverified` and `gaps` fields rather than omitting weak claims.

需要人工补充的信息: 调用方必须提供启用的工具清单、允许的数据源、文件/vector store/MCP 标识、最大工具调用或时间预算、输出 schema 和引用要求；没有检索工具时，需要用户提供 URL、文件、摘录或固定语料。

### Inputs

- System or developer instruction that loads the contents of this protocol.
- User research question and scope fields.
- Tool configuration: enabled search, retrieval, file IDs, vector store IDs,
  function names, maximum tool calls, and output schema.
- Citation requirements and whether sources must be public, local, or both.

### Outputs

- Structured research object or Markdown report.
- `source_ledger` array with source ID, title, URL/path, type, date/access date,
  confidence, use, and limits.
- `claim_audit` array with claim, status, sources, confidence, and notes.
- `gaps` array and `reproducibility_notes` array.
- Optional final prose summary generated from the structured evidence.

### Example Call

```json
{
  "instructions": "Use the model-agnostic-deep-research protocol. Build a source ledger, verify key claims, cite sources, and list gaps.",
  "input": "Research public evidence for model-agnostic deep-research workflows across coding agents, hosted API agents, and no-tool chat models. Focus on reusable design patterns.",
  "tools": [
    { "type": "web_search" },
    { "type": "file_search", "vector_store_ids": ["vs_research_corpus"] }
  ],
  "output_format": {
    "type": "json_schema",
    "name": "deep_research_report"
  }
}
```

## Adapter 3: Plain No-Tool Chat Models

Use this adapter for ordinary chat sessions where the model cannot browse, read
files, call tools, or inspect uploaded documents beyond text pasted into the
conversation.

适配类别: 普通无工具聊天模型。

### Available Capabilities

- Reason over the user's question and pasted source excerpts.
- Organize a research plan, source request list, source ledger template, and
  claim audit template.
- Synthesize only the evidence present in the conversation.
- Separate background knowledge from user-provided evidence.
- Draft a report with explicit assumptions and unverified claims.

### Degradation Strategy

- Do not claim live browsing, file inspection, private source review, or current
  verification.
- Ask the user for source text, URLs, excerpts, or a fixed corpus when evidence
  matters.
- Mark externally checkable facts as `unverified` unless they are directly
  supported by pasted evidence.
- Prefer a research plan plus evidence request when the prompt lacks enough
  source material.
- Use conservative language for dates, vendor capabilities, legal, medical,
  financial, security, or other high-impact topics.

需要人工补充的信息: 用户必须粘贴来源摘录、URL 列表、文件内容摘要或允许模型仅输出研究计划；没有可读来源时，模型不得声称完成外部核验。

### Inputs

- Research question and intended decision.
- Pasted source excerpts or user-provided facts.
- Known constraints such as time window, geography, language, and risk level.
- Desired report format and citation style.

### Outputs

- Research plan and source request list when evidence is missing.
- Source ledger using conversation-local identifiers such as `[U1]`, `[U2]`.
- Claim audit distinguishing supported, inferred, and unverified claims.
- Draft report limited to the supplied evidence.
- Gaps with exact sources or searches the user should provide next.

### Example Call

```text
You do not have browsing or file tools. Use the model-agnostic-deep-research
protocol only on the excerpts below. Produce a source ledger, claim audit, and
gaps. Any fact not supported by the excerpts must be marked unverified.

[U1] <paste excerpt>
[U2] <paste excerpt>
Question: What reusable design patterns can be extracted from these sources for
a portable deep-research protocol?
```

## Optional External Adapter Examples

FreeUltraCode does not need any machine-level skill installation for
`/deep-research`; it ships this workflow under the application's bundled
resources. The examples below are only for reusing the same protocol in other
agent environments.

Claude Code project-local:

```bash
mkdir -p .claude/skills/model-agnostic-deep-research
cp model-agnostic-deep-research.md .claude/skills/model-agnostic-deep-research/SKILL.md
```

Codex repo-local:

```bash
mkdir -p .agents/skills/model-agnostic-deep-research
cp model-agnostic-deep-research.md .agents/skills/model-agnostic-deep-research/SKILL.md
```

Generic application agent:

```text
Load model-agnostic-deep-research.md as the task procedure when the request asks for deep research,
multi-source synthesis, source audit, competitive analysis, or literature-style
review. Expose search, file retrieval, and function tools when available; when
they are not available, require the agent to disclose the limitation.
```

## Minimal Validation Checklist

- Covers Claude Code / Codex-style local agents.
- Covers OpenAI Responses/API-style hosted agents.
- Covers plain no-tool chat models.
- Each adapter states available capabilities, degradation strategy, inputs,
  outputs, and an example call.
- The README preserves the protocol rule that unverified private vendor
  internals must not be claimed as fact.
