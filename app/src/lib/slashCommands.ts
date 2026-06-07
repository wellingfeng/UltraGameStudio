// Shared slash command / skill catalog model.
//
// CONTRACT: This module owns the *data* layer for slash commands and skills so
// that the inline `/` suggestion menu (AIDock) and the read-only Commands list
// (SettingsModal) never drift. Interaction concerns (trigger detection, adapter
// scoping, top-N filtering) deliberately stay in AIDock; everything here is a
// pure transform over the backend slash catalog plus the app-only static
// entries the catalog does not enumerate.
import type { Locale } from '@/lib/i18n';
import type { SlashCatalogEntry } from '@/lib/tauri';
import type { RuntimeAdapterId } from '@/lib/adapters';

export type SlashSuggestionKind = 'command' | 'skill';
export type SlashSourceAdapter = RuntimeAdapterId | 'app' | 'agent';

export interface StaticSlashEntry {
  id: string;
  kind: SlashSuggestionKind;
  name: string;
  label: Partial<Record<Locale, string>>;
  detail: Partial<Record<Locale, string>>;
  insertText: Partial<Record<Locale, string>>;
  source?: string | null;
  sourceAdapter?: SlashSourceAdapter | null;
}

export interface SlashSuggestion {
  id: string;
  kind: SlashSuggestionKind;
  name: string;
  label: string;
  detail: string;
  insertText: string;
  source?: string | null;
  sourceAdapter?: SlashSourceAdapter | null;
  searchText: string;
}

export const SLASH_COMMANDS = [
  {
    name: '/ultracode',
    label: { 'zh-CN': 'Ultracode 动态编排', 'en-US': 'Ultracode' },
    detail: {
      'zh-CN': '生成动态多智能体 harness 并执行复杂任务（多轮规划、并行 agent、验收门）',
      'en-US': 'Generate a dynamic multi-agent harness and run complex tasks (multi-round planning, parallel agents, acceptance gates)',
    },
    text: {
      'zh-CN': '',
      'en-US': '',
    },
  },
  {
    name: '/image-mode-start',
    label: { 'zh-CN': '开始生图模式', 'en-US': 'Start Image Mode' },
    detail: {
      'zh-CN': '进入生图模式：之后每条消息都用设置 > 生图的默认 Provider 生成图片',
      'en-US': 'Enter image mode: every message generates with the default image provider',
    },
    text: {
      'zh-CN': '',
      'en-US': '',
    },
  },
  {
    name: '/image-mode-end',
    label: { 'zh-CN': '结束生图模式', 'en-US': 'End Image Mode' },
    detail: {
      'zh-CN': '退出生图模式，回到 AI 编程',
      'en-US': 'Leave image mode and return to AI coding',
    },
    text: {
      'zh-CN': '',
      'en-US': '',
    },
  },
  {
    name: '/deep-research',
    label: { 'zh-CN': '深度调研', 'en-US': 'Deep Research' },
    detail: {
      'zh-CN': '用 /ultracode 跑多源核验研究',
      'en-US': 'Run source-grounded research through /ultracode',
    },
    text: {
      'zh-CN':
        '执行 deep-research：使用随 FreeUltraCode 一起发布的内置 workflow 协议 workflows/deep-research/WORKFLOW.md 和 protocol/model-agnostic-deep-research.md。必须先界定研究问题、来源边界、时间范围和风险等级；优先官方/一手来源；维护 source ledger 和 claim audit；区分已核验事实、供应商声明、社区观点、设计推断、未核验假设和 gaps；输出带引用的调研报告、比较矩阵、冲突/不确定性和可复查记录。不要声称访问任何供应商私有实现。',
      'en-US':
        'Run deep research using the built-in FreeUltraCode workflow protocol workflows/deep-research/WORKFLOW.md and protocol/model-agnostic-deep-research.md. Define the question, source boundary, time window, and risk level; prioritize official/primary sources; maintain a source ledger and claim audit; separate verified facts, vendor-stated claims, community reports, design inferences, unverified hypotheses, and gaps; return a cited research report with comparison matrix, conflicts/uncertainties, and reproducibility notes. Do not claim access to private vendor internals.',
    },
  },
  {
    name: '/help',
    label: { 'zh-CN': '帮助', 'en-US': 'Help' },
    detail: {
      'zh-CN': '列出当前可用 command / skill',
      'en-US': 'List available commands and skills',
    },
    text: {
      'zh-CN': '列出当前可用的 slash command 和 Skill，按用途分组，并给出每个条目的触发词和适用场景。',
      'en-US': 'List the available slash commands and skills, grouped by use case, with each trigger and when to use it.',
    },
  },
  {
    name: '/plan',
    label: { 'zh-CN': '计划', 'en-US': 'Plan' },
    detail: {
      'zh-CN': '先拆步骤，再执行',
      'en-US': 'Break down steps before acting',
    },
    text: {
      'zh-CN': '先给出简短执行计划，再按计划完成任务；只保留必要步骤和风险点。',
      'en-US': 'Start with a short execution plan, then complete the task; keep only necessary steps and risks.',
    },
  },
  {
    name: '/diagnose',
    label: { 'zh-CN': '诊断', 'en-US': 'Diagnose' },
    detail: {
      'zh-CN': '复现 -> 根因 -> 修复 -> 验证',
      'en-US': 'Reproduce -> root cause -> fix -> verify',
    },
    text: {
      'zh-CN': '诊断这个问题：先复现或定位触发条件，再找根因，最后给出修复和验证结果。',
      'en-US': 'Diagnose this: reproduce or identify the trigger, find the root cause, then provide the fix and verification.',
    },
  },
  {
    name: '/review',
    label: { 'zh-CN': '审查', 'en-US': 'Review' },
    detail: {
      'zh-CN': '按代码审查视角找风险',
      'en-US': 'Review for bugs and risks',
    },
    text: {
      'zh-CN': '按代码审查视角检查：优先列出 bug、回归风险和缺失测试，给出文件/位置和修复建议。',
      'en-US': 'Review this as code: list bugs, regression risks, and missing tests first, with file/location references and fixes.',
    },
  },
  {
    name: '/explain',
    label: { 'zh-CN': '解释', 'en-US': 'Explain' },
    detail: {
      'zh-CN': '解释执行路径和关键依赖',
      'en-US': 'Explain flow and dependencies',
    },
    text: {
      'zh-CN': '解释这段内容的执行路径、关键依赖和容易误解的点，结论先行。',
      'en-US': 'Explain the execution flow, key dependencies, and easy-to-misread parts. Start with the conclusion.',
    },
  },
  {
    name: '/test',
    label: { 'zh-CN': '测试', 'en-US': 'Test' },
    detail: {
      'zh-CN': '补充或运行相关测试',
      'en-US': 'Add or run relevant tests',
    },
    text: {
      'zh-CN': '为当前任务补充或运行最相关的测试；若失败，说明失败点、可能根因和下一步。',
      'en-US': 'Add or run the most relevant tests for this task; if they fail, report the failure, likely cause, and next step.',
    },
  },
  {
    name: '/screenshot',
    label: { 'zh-CN': '会话长截图', 'en-US': 'Session Screenshot' },
    detail: {
      'zh-CN': '把当前会话整段保存为长图（过长自动分页拼接）',
      'en-US': 'Save the whole conversation as a long image (auto-paged when very long)',
    },
    text: {
      'zh-CN': '',
      'en-US': '',
    },
  },
  {
    name: '/screenshot-gif',
    label: { 'zh-CN': '会话滚动 GIF', 'en-US': 'Session Scroll GIF' },
    detail: {
      'zh-CN': '把当前会话录成从上滚到下的回放 GIF',
      'en-US': 'Record the conversation as a top-to-bottom scrolling GIF',
    },
    text: {
      'zh-CN': '',
      'en-US': '',
    },
  },
] as const;

export const STATIC_SLASH_ENTRIES: StaticSlashEntry[] = SLASH_COMMANDS.map(
  (command) => ({
    id: `command:${command.name}`,
    kind: 'command',
    name: command.name,
    label: command.label,
    detail: command.detail,
    insertText: command.text,
    source: 'app',
    sourceAdapter: 'app',
  }),
);

// FreeUltraCode-specific commands surfaced in the Settings > Commands tab.
//
// CONTRACT: This is a curated allowlist, NOT everything in SLASH_COMMANDS. The
// inline `/` menu intentionally also offers generic prompt shortcuts (/plan,
// /review, /diagnose, ...) and whatever the backend slash catalog discovers
// (CLI commands, user skills), but the Commands tab is a reference for the
// features that ship with and are unique to this app. Keep this list in sync
// when adding a new first-class app command.
export const PROJECT_COMMAND_NAMES = [
  '/ultracode',
  '/deep-research',
  '/image-mode-start',
  '/image-mode-end',
  '/screenshot',
  '/screenshot-gif',
] as const;

const PROJECT_COMMAND_NAME_SET: ReadonlySet<string> = new Set(
  PROJECT_COMMAND_NAMES.map((name) => name.toLowerCase()),
);

export function isProjectCommandName(name: string): boolean {
  return PROJECT_COMMAND_NAME_SET.has(name.trim().toLowerCase());
}

export function slashText(
  value: Partial<Record<Locale, string>> | Record<string, string | undefined>,
  locale: Locale,
): string {
  return value[locale] ?? value['en-US'] ?? value['zh-CN'] ?? '';
}

function normalizeSlashSourceAdapter(value: unknown): SlashSourceAdapter | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'claude' || normalized === 'anthropic') {
    return 'claude-code';
  }
  if (
    normalized === 'claude-code' ||
    normalized === 'codex' ||
    normalized === 'gemini' ||
    normalized === 'app' ||
    normalized === 'agent'
  ) {
    return normalized;
  }
  return null;
}

function slashSourceAdapterFromPath(value: unknown): SlashSourceAdapter | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const source = value.replace(/\\/g, '/').toLowerCase();
  if (source.includes('/.claude/')) return 'claude-code';
  if (source.includes('/.codex/')) return 'codex';
  if (source.includes('/.gemini/')) return 'gemini';
  if (source.includes('/.agents/')) return 'agent';
  return null;
}

export function slashEntrySourceAdapter(
  entry: StaticSlashEntry | SlashCatalogEntry,
): SlashSourceAdapter | null {
  const direct = normalizeSlashSourceAdapter(
    (entry as { sourceAdapter?: string | null }).sourceAdapter,
  );
  if (direct) return direct;

  const source = entry.source ?? '';
  const fromSource =
    normalizeSlashSourceAdapter(source) ?? slashSourceAdapterFromPath(source);
  if (fromSource) return fromSource;

  const idSource = /^(?:command|skill):([^:]+):/.exec(entry.id)?.[1];
  return (
    normalizeSlashSourceAdapter(idSource) ??
    slashSourceAdapterFromPath(entry.id)
  );
}

// App-implemented commands (e.g. /image-mode-start, /image-mode-end) live
// only in STATIC_SLASH_ENTRIES. The Tauri backend slash catalog is authoritative
// for CLI/skill commands but does not enumerate these app features, so when it
// returns a catalog we must still fold in any app-only static entry it lacks —
// otherwise these commands silently vanish from the suggestion menu and the
// Commands settings list in the desktop build.
export function withAppOnlyStaticEntries(
  catalogEntries: SlashCatalogEntry[],
): (SlashCatalogEntry | StaticSlashEntry)[] {
  const present = new Set(
    catalogEntries.map((entry) => entry.name.trim().toLowerCase()),
  );
  const missing = STATIC_SLASH_ENTRIES.filter(
    (entry) => !present.has(entry.name.trim().toLowerCase()),
  );
  return [...catalogEntries, ...missing];
}

export function buildSlashSuggestions(
  catalogEntries: SlashCatalogEntry[],
  locale: Locale,
): SlashSuggestion[] {
  const seen = new Set<string>();
  const out: SlashSuggestion[] = [];
  const entries: (SlashCatalogEntry | StaticSlashEntry)[] =
    catalogEntries.length > 0
      ? withAppOnlyStaticEntries(catalogEntries)
      : STATIC_SLASH_ENTRIES;

  for (const entry of entries) {
    const label = slashText(entry.label, locale);
    const detail = slashText(entry.detail, locale);
    const insertText = slashText(entry.insertText, locale);
    const source = entry.source ?? '';
    const sourceAdapter = slashEntrySourceAdapter(entry);
    const key = `${entry.kind}:${source || entry.id}:${entry.name}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      label,
      detail,
      insertText,
      source,
      sourceAdapter,
      searchText:
        `${entry.name} ${label} ${detail} ${insertText} ${source} ${
          sourceAdapter ?? ''
        }`.toLowerCase(),
    });
  }

  return out;
}
