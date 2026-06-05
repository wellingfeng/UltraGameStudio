/**
 * CONTRACT: tool-name → display metadata (icon name + normalised category).
 *
 *   toolIconName(name) -> a lucide icon component key for the tool
 *   toolCategory(name) -> 'write' | 'read' | 'exec' | 'search' | 'web' | 'task' | 'other'
 *
 * Used by both the text-only ToolLine (wave 1) and the structured ToolCard
 * (wave 2). Names are matched case-insensitively against common Claude/Codex
 * tool ids and their snake_case variants.
 */

export type ToolCategory =
  | 'write'
  | 'read'
  | 'exec'
  | 'search'
  | 'web'
  | 'task'
  | 'list'
  | 'other';

/** lucide-react component name (resolved by the renderer's icon map). */
export type ToolIconName =
  | 'FilePen'
  | 'FileText'
  | 'SquareTerminal'
  | 'FolderOpen'
  | 'Search'
  | 'Globe'
  | 'ListTree'
  | 'Wrench';

const CATEGORY: Array<[RegExp, ToolCategory]> = [
  [/^(edit|write|multi_?edit|str_?replace|create|apply_?patch|patch|file_?change)/i, 'write'],
  [/^(read|file_?read|view|cat|open|get_?file)/i, 'read'],
  [/^(bash|shell|command_?execution|exec|run|terminal|powershell)/i, 'exec'],
  [/^(grep|search|search_?content|ripgrep|find_?text)/i, 'search'],
  [/^(glob|find|ls|list_?dir|directory)/i, 'list'],
  [/^(free_?proxy|model_?route|llm_?route|provider_?route)/i, 'web'],
  [/^(web_?fetch|web_?search|fetch|browse|http|url)/i, 'web'],
  [/^(task|agent|subagent|dispatch)/i, 'task'],
];

export function toolCategory(name: string): ToolCategory {
  const n = name.trim();
  for (const [re, cat] of CATEGORY) {
    if (re.test(n)) return cat;
  }
  return 'other';
}

const ICON_BY_CATEGORY: Record<ToolCategory, ToolIconName> = {
  write: 'FilePen',
  read: 'FileText',
  exec: 'SquareTerminal',
  search: 'Search',
  list: 'FolderOpen',
  web: 'Globe',
  task: 'ListTree',
  other: 'Wrench',
};

export function toolIconName(name: string): ToolIconName {
  return ICON_BY_CATEGORY[toolCategory(name)];
}
