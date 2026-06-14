import { useMemo, type ReactNode } from 'react';
import RawCodeBlock from './RawCodeBlock';
import MermaidBlock from './MermaidBlock';
import ComfyGraphBlock from './ComfyGraphBlock';

/**
 * Recursively collect the plain text of a hast node (rehype-highlight wraps the
 * source in nested <span> elements, so the original code lives in leaf text
 * nodes). Used to recover the raw code for the copy button.
 */
interface HastNode {
  type?: string;
  value?: string;
  tagName?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
}

function nodeText(node: HastNode | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(nodeText).join('');
}

function languageOf(preNode: HastNode | undefined): string | null {
  const code = preNode?.children?.find((c) => c.tagName === 'code');
  const cls = code?.properties?.className;
  const classes = Array.isArray(cls) ? cls : typeof cls === 'string' ? cls.split(' ') : [];
  for (const c of classes) {
    if (typeof c === 'string' && c.startsWith('language-')) {
      return c.slice('language-'.length);
    }
  }
  return null;
}

/**
 * Fenced code block chrome: a header bar with the language label, word-wrap and
 * (for tall blocks) expand toggles, plus a copy button, wrapping the
 * rehype-highlighted <pre><code>. Rendered as the `pre` override in
 * {@link Markdown}; the highlighted children pass straight through.
 *
 * A ` ```diff ` fence gets per-line +/- tinting via the `.ai-code--diff` class
 * (highlight.js marks added/removed lines with `.hljs-addition`/`.hljs-deletion`).
 */
export default function CodeBlock({
  children,
  node,
}: {
  children?: ReactNode;
  node?: HastNode;
}) {
  const raw = useMemo(() => nodeText(node).replace(/\n$/, ''), [node]);
  const lang = languageOf(node);
  const normalizedLang = lang?.toLowerCase();

  // Defensive: react-markdown normally supplies `node`, but if a future plugin
  // strips it we still render the (highlighted) children without chrome.
  if (!node) return <pre className="ai-code__scroll">{children}</pre>;

  if (normalizedLang === 'mermaid' || normalizedLang === 'mmd') {
    return <MermaidBlock code={raw} />;
  }

  if (normalizedLang === 'comfyui' || normalizedLang === 'comfy') {
    return <ComfyGraphBlock code={raw} />;
  }

  return <RawCodeBlock raw={raw} language={lang}>{children}</RawCodeBlock>;
}
