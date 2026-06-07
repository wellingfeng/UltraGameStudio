---
name: deep-research
description: Run an OpenWorkflow deep-research task through the /ultracode dynamic workflow harness. Use when the user asks for deep research, repeated web/source investigation, competitive research, vendor/product comparison, technical landscape research, literature-style review, policy/legal/financial/security research support, or any answer requiring many sources, source ledgers, citations, cross-validation, claim audits, uncertainty tracking, and reproducible gaps. This is a built-in FreeUltraCode workflow, not a user-local skill install.
---

# Deep Research

Use this built-in workflow as the OpenWorkflow `/deep-research` entrypoint. Route execution through `/ultracode` when the host supports it; otherwise follow `protocol/model-agnostic-deep-research.md` directly.

This is a portable evidence-first workflow, not a copy of Claude Code, OpenAI, Google, Perplexity, or any other private vendor implementation. Do not claim access to hidden prompts, private rankings, internal workflow scripts, or execution logs unless the user supplies verifiable evidence.

Packaging note: in the FreeUltraCode desktop app, this workflow ships with the application under the Tauri resource `workflows/deep-research/` directory. It is not installed in, loaded from, or dependent on a user's machine-level `skills/` directory. Runtime code should prefer `FUC_BUILTIN_DEEP_RESEARCH_WORKFLOW_DIR` when it is present.

## OpenWorkflow Route

When the user invokes `/deep-research <question>` in OpenWorkflow:

1. Treat `<question>` as the research objective.
2. Use `/ultracode` dynamic harness execution for multi-agent planning, source investigation, adversarial verification, acceptance gating, and final reporting.
3. Load or follow `protocol/model-agnostic-deep-research.md` from `FUC_BUILTIN_DEEP_RESEARCH_WORKFLOW_DIR` when available; otherwise use this document's protocol summary as the governing research protocol.
4. Prefer a plan shape with:
   - scope freeze and assumptions,
   - parallel source research by facet or source family,
   - source-ledger and claim-map synthesis,
   - adversarial verification,
   - final decision brief/report with citations, gaps, and reproducibility notes.
   These stages are ordered: synthesis must depend on source research, adversarial verification must depend on synthesis, and the final brief/report must depend on verification.
5. Preserve run artifacts in the normal `/ultracode` run ledger when available.

Recommended `/ultracode` objective:

```text
Use the built-in protocol/model-agnostic-deep-research.md evidence protocol. Research: <question>. Produce a source ledger, claim audit, cited findings, comparison matrix if useful, conflicts, gaps, stop condition, and reproducibility notes. Separate verified facts, vendor-stated claims, community-reported claims, design inferences, unverified hypotheses, and excluded claims. Do not claim access to private vendor internals.
Default to a concise decision brief when the question supports a product, engineering, vendor, or strategy decision: top opportunities, recommendation priority, MVP/prototype path, what not to do yet, risks, validation signals, and a short evidence appendix. Only produce a full dossier when explicitly requested or when risk requires it.
```

## Evidence Rules

For every deep-research run:

- State source boundaries, runtime environment, time window, geography/jurisdiction if relevant, and assumptions.
- Prefer official docs, primary sources, public repositories, papers, standards, laws, filings, and direct datasets before secondary or community sources.
- Keep a source ledger with title/path, URL or file reference, source type, publication/update date or unknown, access date when web-based, confidence, use, and limits.
- Keep a claim audit with status: verified, inferred, vendor-stated, community-reported, unverified, excluded, or conflicting.
- Cite key claims near the claim, not only in a bibliography.
- For high-impact claims, require strong primary evidence or two independent sources; otherwise downgrade confidence.
- For negative claims, say what was searched and use "not found in the checked public sources", never absolute proof of absence.
- Record tool failures and inaccessible sources as gaps.

## Output Contract

Return a concise decision brief unless the user asks for a full dossier or the risk level requires one. Evidence tables support the decision; they are not the main product. Include:

- Executive summary with confidence.
- Recommendation priority: what to do first, later, and not yet.
- Top opportunities or options, each with user value, implementation cost/complexity, risk, prerequisites, and validation signal.
- MVP/prototype path when the research supports a build decision.
- Scope, assumptions, and source boundary.
- Method and stop condition.
- Findings with citations.
- Comparison matrix when comparing entities or options.
- Conflicts, uncertainties, and gaps.
- Evidence appendix: compact source ledger and claim audit.
- Reproducibility notes.

For audit-style, legal/security/compliance, medical/financial, contested vendor capability, or explicitly requested "full dossier" work, expand the evidence appendix into full source ledger and claim audit sections in the main report.

For no-tool or limited-tool environments, do not pretend public verification was performed. Ask for sources only when evidence is required and no usable corpus is available; otherwise return a research plan and source request list.

## Safety

- Do not expose secrets or paste private corpus content into public search tools.
- Do not execute untrusted code from research sources.
- Do not treat vendor marketing, benchmarks, community README claims, or model memory as independently verified.
- Do not provide professional legal, medical, financial, or security advice; provide cited research support and recommend qualified review where appropriate.
