---
name: model-agnostic-deep-research
description: Run a portable, source-grounded deep research workflow for complex questions. Use when the user asks for deep research, competitive research, literature-style review, vendor/product comparison, policy/legal/technical landscape analysis, or any answer that needs many sources, citations, uncertainty tracking, cross-validation, and a reproducible evidence ledger. Do not use for quick factual lookups or pure brainstorming without verification requirements.
---

# Model-Agnostic Deep Research

Use this protocol as an evidence-first research workflow across model and tool environments. It is not a copy of any private Anthropic, OpenAI, Google, Perplexity, or other vendor implementation. Never claim access to hidden prompts, private rankings, workflow scripts, agent traces, or evaluation logs unless the user supplied verifiable evidence.

## 触发条件

Use this protocol when the task needs one or more of:

- Multi-source synthesis, comparison, or landscape mapping.
- Current, contested, regulated, technical, financial, legal, medical, security, or other high-impact facts.
- Competitive/product research, vendor capability mapping, public evidence review, or repository/documentation review.
- Literature-style review of papers, standards, repositories, laws, policies, or technical documentation.
- Explicit citations, source scoring, claim audit, uncertainty tracking, or evidence-gap reporting.
- A reproducible report separating verified facts from inference, vendor claims, community claims, and unverified hypotheses.

Do not use it when:

- A single stable fact or short explanation is enough.
- The user asks only for opinion, ideation, drafting, or brainstorming with no verification need.
- The user forbids external research and provides no source corpus. In that case, answer only from provided context and state that external verification was not performed.

## 输入澄清策略

Extract these fields before researching:

- Research question.
- Decision or audience the research should support.
- Time window, geography, language, and jurisdiction.
- Source boundaries: public web, user files, fixed corpus, academic sources, repositories, private sources, or excluded sources.
- Output format, depth, citation style, deadline, token budget, and artifact path if any.
- Risk level: low, medium, or high.

Ask at most three clarifying questions only when missing information would materially change source selection, safety handling, or interpretation. If details are useful but not blocking, proceed with explicit assumptions.

For high-risk work, require the decision boundary. If the user asks for legal, medical, financial, security, or compliance conclusions, frame the result as research support, not professional advice.

Detect the runtime before making evidence claims:

- Full-tool environment: web/search/browser tools plus local file inspection are available.
- Limited-tool environment: only local files, uploaded documents, MCP resources, user-provided URLs, or fixed corpora are available.
- No-tool environment: no external browsing, file inspection, or source fetching is available.

State the environment and source boundary in the final report. Never imply live verification when the runtime did not allow it. If search is available but the user forbids browsing, obey the user and mark public web verification as intentionally skipped.

## 检索循环

Repeat this loop until the evidence threshold is met, the budget is reached, or further search has diminishing returns:

1. Plan facets: split the question into subquestions, comparison dimensions, entities, date ranges, jurisdictions, and expected source categories.
2. Generate queries: include official names, synonyms, acronyms, exact phrases, historical names, negative queries, and contradiction-focused queries.
3. Search primary sources first: official docs, standards, laws, filings, papers, repositories, release notes, changelogs, API docs, product help centers, and direct datasets.
4. Search secondary sources next: reputable reporting, expert analysis, benchmarks, audits, and independent reviews.
5. Search community sources last: forums, GitHub examples, Reddit, personal blogs, wrappers, and marketplace pages. Use them for observed patterns, not official claims.
6. Read beyond snippets: open sources, inspect relevant sections, and record enough context to support or reject claims.
7. Expand from citations: follow references, footnotes, citation trails, linked docs, repository issues, release notes, and commits when they materially affect the answer.
8. Stop deliberately: record the stop condition, such as sufficient corroboration, no new independent sources, tool failure, budget limit, user-imposed scope, or unavailable primary evidence.

In limited-tool environments, run the same loop over the available corpus. In no-tool environments, use only conversation-provided text and stable background knowledge; label externally checkable claims as unverified.

## 来源评分

Create a source ledger before synthesis. Score every source used or rejected:

- Source type: official, primary, standards/spec, repository, academic, reputable news, vendor blog, community, social/forum, unknown.
- Confidence: high, medium, low.
- Independence group: same vendor, same author/repository, same article family, or independent.
- Recency: publication date, update date, access date, or unknown.
- Relevance: core evidence, supporting context, design pattern, contradiction, or excluded.
- Known limits: paywall, login wall, stale docs, vendor marketing, unverifiable claim, inaccessible page, machine translation, or partial corpus.

Default authority order:

1. Official docs, standards, regulations, primary papers, public repositories from project owners, and first-party release artifacts.
2. Academic papers, reputable technical reports, public filings, and independent audits.
3. Vendor blogs, product pages, and help-center articles.
4. Reputable news or expert analysis.
5. Community repositories, forums, Reddit, social media, personal blogs, and marketplace pages.

Community sources can prove that a community implementation or claim exists. They do not prove that a vendor officially supports the capability.

## 交叉验证

Audit important claims before including them as findings:

- Ordinary factual claim: require one high-confidence source or clearly label the source as medium/low confidence.
- High-impact claim: require two independent sources, or downgrade it to tentative/unverified.
- Vendor capability claim: prefer official docs or observable product behavior; otherwise label it vendor-stated, community-reported, or unverified.
- Negative claim: avoid absolute wording. Use “not found in the public sources checked” and list the search/source scope.
- Conflicting claim: report the conflict, identify the stronger authority, and explain why.
- Inference: label it `设计推断` or `design inference` and cite the evidence patterns that support it.

Use a claim map for complex reports:

```markdown
| Claim | Status | Supporting sources | Contradictions | Confidence | Notes |
| --- | --- | --- | --- | --- | --- |
| ... | verified / inferred / unverified / excluded | [S1], [S2] | [S3] | high / medium / low | ... |
```

Write from the source ledger and claim map, not from memory. Separate verified facts, design inferences, vendor-stated claims, community claims, unverified hypotheses, and excluded claims.

## 引用规范

Use source identifiers consistently, such as `[S1]`, `[PAPER3]`, or file path references.

Each source ledger entry must include:

- Identifier.
- Title or filename.
- URL, repository path, document path, or stable local reference.
- Publisher/author when available.
- Publication/update date when available, otherwise `未标明` or `unknown`.
- Access date for web sources when available.
- Source type and confidence.
- One-line reason it was used.
- Limits or caveats.

Citation requirements:

- Cite all key factual claims.
- Cite at claim level for high-impact, contested, or vendor-capability claims.
- Do not cite search snippets as evidence for technical, legal, medical, financial, or security conclusions.
- Do not cite inaccessible pages as if inspected; mark them unavailable.
- Do not overquote. Prefer concise paraphrase and quote only short exact wording when necessary.
- For local files, cite stable paths, section headings, page numbers, or line numbers when available.

## 输出模板

Use this default structure unless the user requested another format. For product, engineering, vendor, roadmap, or strategy questions, default to this decision-brief structure and keep the evidence tables compact:

```markdown
# Research Decision Brief: <topic>

## Executive Summary
<direct answer, confidence, and most important caveats>

## Recommendation Priority
- Do first:
- Do later:
- Do not do yet:

## Top Opportunities / Options
| Option | Why it matters | Evidence | Cost / Complexity | Risks | Prerequisites | Validation signal |
| --- | --- | --- | --- | --- | --- | --- |
| ... | ... | [S1], [C1] | low / medium / high | ... | ... | ... |

## MVP / Prototype Path
<smallest useful next build, experiment, or decision checkpoint>

## Scope And Assumptions
- Question:
- Audience/decision:
- Time window:
- Source boundaries:
- Runtime environment:
- Assumptions:

## Method
- Searches or corpus inspected:
- Inclusion/exclusion rules:
- Evidence threshold:
- Stop condition:

## Source Ledger
| ID | Source | Type | Date / Accessed | Confidence | Use | Limits |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | <title + URL/path> | official / academic / repo / ... | <date> | high / medium / low | core / support / excluded | <limits> |

## Findings
### Finding 1: <claim>
<claim-level synthesis with citations>

## Comparison Matrix
| Dimension | Entity A | Entity B | Evidence |
| --- | --- | --- | --- |
| ... | ... | ... | [S1], [S2] |

## Conflicts And Uncertainties
<contradictions, weak evidence, stale sources, missing tests>

## Gaps
<what could not be verified and exact next evidence needed>

## Evidence Appendix
### Source Ledger
| ID | Source | Type | Date / Accessed | Confidence | Use | Limits |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | <title + URL/path> | official / academic / repo / ... | <date> | high / medium / low | core / support / excluded | <limits> |

### Claim Audit
| Claim | Status | Sources | Confidence | Notes |
| --- | --- | --- | --- | --- |
| ... | verified / inferred / unverified / excluded | [S1] | high / medium / low | ... |

## Reproducibility Notes
<queries, files, dates, tools unavailable, or reason external search was skipped>
```

For audit-style, legal/security/compliance, medical/financial, contested vendor capability, or explicitly requested full-dossier tasks, expand `Source Ledger` and `Claim Audit` into first-class main sections and keep the decision sections short or omit them when not relevant.

For concise tasks, compress the sections but keep recommendation priority, cited findings, compact source ledger, claim audit, and gaps.

## 失败处理

If search, browsing, file reading, MCP, or API retrieval fails:

- Continue with available sources only.
- Add a gap naming the failed tool, URL, file, or source category.
- State the exact next validation step.
- Do not fill missing evidence with confident generalities.

If sources are insufficient:

- State which claims could not be verified.
- Provide exact next searches, source owners, datasets, logs, product runs, or human reviews needed.
- Return a research plan plus source request list when no-tool or limited-tool constraints block verification.

If sources conflict:

- Preserve the disagreement.
- Prefer primary and official sources for capability/status claims.
- Prefer independent empirical evidence for performance or quality claims.
- Downgrade conclusions when conflict cannot be resolved.

If the task involves private data:

- Keep public web search separate from private-source analysis.
- Do not paste secrets, credentials, private customer data, or proprietary source text into public tools.
- Prefer local, approved file, or approved MCP tools for private sources.

## 模型适配

For strong reasoning models:

- Use a compact but complete source ledger.
- Run an adversarial audit pass before finalizing.
- Explicitly downgrade claims that rely on one source family.

For small or local models:

- Split work into retrieval, extraction, verification, and synthesis phases.
- Keep excerpts short and structured.
- Use the claim map and output template literally.
- Persist intermediate tables instead of relying on long implicit reasoning.

For Claude Code / Codex-style local agents:

- Use repository search, local files, shell commands, browser/search, MCP, and tests according to source boundaries.
- Save intermediate ledgers when long-running or resumable.
- Cite local evidence with stable paths and line numbers when available.

For OpenWorkflow `/deep-research` and `/ultracode`:

- Treat `/deep-research <question>` as a short command that routes into `/ultracode` with this protocol as the governing evidence contract.
- Ask the dynamic harness planner to create phases for scope freeze, parallel source research, ledger/claim-map synthesis, adversarial verification, and final cited report.
- Use `fan-out-and-synthesize` when the question has multiple facets, vendors, source families, jurisdictions, or competing hypotheses.
- Use `adversarial-verification` for contested, high-impact, vendor-capability, or negative-evidence claims.
- Include objective checks when the expected artifact is written to disk, such as required report files containing `Source Ledger`, `Claim Audit`, `Gaps`, and `Reproducibility Notes`.
- Let `/ultracode` preserve run evidence under `.fuc-run/<run-id>/`; mention the run ID and ledger path in the final summary when available.
- Keep source ledger IDs local to each artifact unless a global source registry is explicitly created. Do not reuse IDs across documents for different URLs.
- For public-web research, record URL, final access state when available, title or fallback label, access date, source type, confidence, and limits. If a URL cannot be opened, mark it unavailable instead of citing it as inspected.

For OpenAI Responses/API-style agents:

- Wire available tools explicitly: web search, file search, remote MCP, code interpreter, or functions.
- Treat hosted deep-research output as one artifact, not automatically verified truth.
- Preserve tool calls, source IDs, timestamps, and retrieval status.

For plain no-tool chat models:

- Ask the user for URLs, files, excerpts, or a fixed corpus when verification matters.
- Mark live/public verification as unavailable.
- Produce a smaller report focused on supported claims, assumptions, and next evidence needed.

For vendor-specific deep research APIs:

- Audit their citations through this protocol's source scoring and cross-verification rules.
- Preserve provider/tool names in reproducibility notes without depending on them in the core workflow.

## 安全边界

- Do not claim access to private vendor implementations, hidden prompts, internal rankings, execution logs, or proprietary workflows.
- Do not request or expose API keys, credentials, cookies, private tokens, or private account data.
- Do not execute code from untrusted repositories or pages as part of research.
- Do not treat vendor marketing, benchmark claims, community README claims, or model memory as independently verified.
- Do not hide uncertainty to make the report look complete.
- Do not provide professional legal, medical, financial, or security instructions beyond research support and clearly sourced context.
- Do not bypass paywalls, access controls, robots restrictions, or license terms.
- Do not mix private corpus contents into public searches or external tools.
