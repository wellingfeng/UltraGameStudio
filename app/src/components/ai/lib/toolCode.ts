import type { ToolEvent } from './toolEvent';
import { toolCategory } from './toolMeta';

export type ToolCodePanel = 'details' | 'request' | 'response';

const PATH_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  vue: 'xml',
  md: 'markdown',
  mdx: 'markdown',
  markdown: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  py: 'python',
  pyw: 'python',
  rs: 'rust',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  ps1: 'powershell',
  psm1: 'powershell',
  psd1: 'powershell',
  bat: 'dos',
  cmd: 'dos',
  diff: 'diff',
  patch: 'diff',
};

export function inferToolCodeLanguage(
  event: Pick<ToolEvent, 'name' | 'subject' | 'status'>,
  panel: ToolCodePanel,
  body: string,
  bodyFromJson = false,
): string {
  if (bodyFromJson) return 'json';

  const byContent = inferBodyLanguage(body);
  if (byContent) return byContent;

  const category = toolCategory(event.name);
  if (panel === 'response') {
    const byPath = languageFromPath(event.subject ?? '');
    if (category === 'read' && byPath) return byPath;
    if (event.status === 'error') return 'log';
    if (category === 'exec') return 'text';
  }

  if (panel === 'details' || panel === 'request') {
    const shell = inferCommandLanguage(body);
    if (shell) return shell;
  }

  return 'text';
}

function inferBodyLanguage(body: string): string | null {
  const text = body.trim();
  if (!text) return null;
  if (looksLikeJson(text)) return 'json';
  if (looksLikeDiff(text)) return 'diff';
  if (looksLikePowerShellSession(text)) return 'powershell';
  if (looksLikeShellSession(text)) return 'shellsession';
  if (looksLikeStackOrCompilerLog(text)) return 'log';
  return null;
}

function inferCommandLanguage(command: string): string | null {
  const text = command.trim();
  if (!text) return null;
  if (/\b(?:pwsh|powershell)(?:\.exe)?\b/i.test(text)) return 'powershell';
  if (/\bcmd(?:\.exe)?\b|\.(?:bat|cmd)(?:\s|$)/i.test(text)) return 'dos';
  if (/\b(?:bash|zsh|fish|sh)(?:\.exe)?\b/i.test(text)) return 'bash';
  if (/^(?:Get|Set|New|Remove|Test|Select|Where|Start|Stop)-[A-Za-z]+/.test(text)) {
    return 'powershell';
  }
  if (/^\$env:[A-Za-z_][\w]*\s*=/.test(text)) return 'powershell';
  if (/^(?:npm|npx|pnpm|yarn|node|git|rg|grep|find|python|python3|pip|cargo)\b/.test(text)) {
    return 'bash';
  }
  return null;
}

function languageFromPath(path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed) return null;
  const noLine = trimmed.replace(/(?::\d+(?::\d+)?)$/, '');
  const match = noLine.match(/\.([A-Za-z0-9]+)(?:["')\]}.,;]*)$/);
  if (!match) return null;
  return PATH_LANG[match[1].toLowerCase()] ?? null;
}

function looksLikeJson(text: string): boolean {
  if (!/^[{[]/.test(text)) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function looksLikeDiff(text: string): boolean {
  return (
    /^diff --git /m.test(text) ||
    /^\*\*\* Begin Patch/m.test(text) ||
    /^@@ -\d+(?:,\d+)? \+\d+/m.test(text) ||
    (/^\+\+\+ /m.test(text) && /^--- /m.test(text))
  );
}

function looksLikePowerShellSession(text: string): boolean {
  return /^PS [^\n>]+>\s+/m.test(text);
}

function looksLikeShellSession(text: string): boolean {
  return /^(?:[$#>]\s+)[^\n]+/m.test(text);
}

function looksLikeStackOrCompilerLog(text: string): boolean {
  return (
    /\b(?:error|warning)\s+(?:TS|CS|E[A-Z]*\d+|\w+:)/i.test(text) ||
    /\b(?:TypeError|ReferenceError|SyntaxError|Error):\s+/m.test(text) ||
    /^\s+at\s+[\w.<anonymous>]/m.test(text) ||
    /^\s*at\s+.+:\d+:\d+\)?$/m.test(text) ||
    /^\s*\d+\s*\|\s+.+$/m.test(text)
  );
}
