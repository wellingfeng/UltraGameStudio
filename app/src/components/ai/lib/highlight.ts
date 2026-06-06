/**
 * CONTRACT: language set + aliases for rehype-highlight (lowlight under the hood).
 *
 * `rehype-highlight` accepts a `languages` record (Record<string, LanguageFn>)
 * and builds its own lowlight instance internally; it does NOT take a prebuilt
 * lowlight instance. We register only the languages FreeUltraCode's AI output
 * actually emits (web + workflow scripting) so the highlighter stays ~30-40KB gz
 * instead of pulling highlight.js's full "common" bundle. Unknown languages fall
 * back to auto-detect / plain text — lowlight never throws on partial input.
 *
 *   HL_LANGUAGES -> pass as rehype-highlight `languages`
 *   HL_ALIASES   -> pass as rehype-highlight `aliases`
 */

import type { LanguageFn } from 'highlight.js';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dos from 'highlight.js/lib/languages/dos';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import plaintext from 'highlight.js/lib/languages/plaintext';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import shellSession from 'highlight.js/lib/languages/shell';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

export const HL_LANGUAGES: Record<string, LanguageFn> = {
  bash,
  css,
  diff,
  dos,
  javascript,
  json,
  markdown,
  plaintext,
  powershell,
  python,
  rust,
  shellsession: shellSession,
  typescript,
  xml,
  yaml,
};

/** Common fence-info aliases the model emits → canonical registered ids. */
export const HL_ALIASES: Record<string, string | string[]> = {
  typescript: ['ts', 'tsx'],
  javascript: ['js', 'jsx', 'mjs', 'cjs'],
  bash: ['sh', 'shell', 'zsh'],
  powershell: ['ps1', 'pwsh', 'ps'],
  dos: ['bat', 'cmd'],
  shellsession: ['console'],
  python: ['py'],
  xml: ['html', 'svg', 'vue'],
  markdown: ['md'],
  yaml: ['yml'],
  plaintext: ['text', 'txt'],
};

const HL_REGISTERED = new Set<string>();

function ensureHighlightLanguages(): void {
  for (const [name, lang] of Object.entries(HL_LANGUAGES)) {
    if (HL_REGISTERED.has(name)) continue;
    hljs.registerLanguage(name, lang);
    HL_REGISTERED.add(name);
  }
  for (const [languageName, aliases] of Object.entries(HL_ALIASES)) {
    if (!hljs.getLanguage(languageName)) continue;
    hljs.registerAliases(aliases, { languageName });
  }
}

export function highlightCode(
  code: string,
  language?: string | null,
): { html: string; className: string } {
  ensureHighlightLanguages();
  const lang = language?.trim().toLowerCase();
  if (lang && hljs.getLanguage(lang)) {
    return {
      html: hljs.highlight(code, { language: lang, ignoreIllegals: true }).value,
      className: `hljs language-${lang}`,
    };
  }
  return {
    html: hljs.highlight(code, { language: 'plaintext', ignoreIllegals: true }).value,
    className: 'hljs language-plaintext',
  };
}
