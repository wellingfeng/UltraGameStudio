import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkMath from 'remark-math';
import remarkRehype from 'remark-rehype';
import rehypeKatex from 'rehype-katex';
import type { Root } from 'hast';
import { repairMarkdown, repairFences } from './repairMarkdown';
import { normalizeMath } from './normalizeMath';
import { protectWindowsPaths } from './protectWindowsPaths';
import { promoteStructureBreaks } from './promoteStructureBreaks';
import { convertInlineHtml } from './htmlInline';
import { convertDetailsHtml } from './htmlDetails';

/** Shared with the synchronous renderer; ordering is part of its contract. */
export function rendererMarkdownSource(text: string, streaming: boolean): string {
  const normalized = protectWindowsPaths(promoteStructureBreaks(
    convertDetailsHtml(convertInlineHtml(normalizeMath(text))),
  ));
  return streaming ? repairMarkdown(normalized) : repairFences(normalized);
}

export function rehypeRendererSections() {
  return (tree: Root) => {
    if (!tree.children.some((node) => node.type === 'element' && node.tagName === 'hr')) return;
    const groups: Root['children'] = [];
    let current: Root['children'] = [];
    const flush = () => {
      if (!current.length) return;
      groups.push({ type: 'element', tagName: 'section', properties: { className: ['ai-para-group'] }, children: current as never });
      current = [];
    };
    for (const node of tree.children) {
      if (node.type === 'element' && node.tagName === 'hr') flush();
      else current.push(node);
    }
    flush();
    tree.children = groups;
  };
}

export interface RendererMarkdownResult { source: string; tree: Root }
/** Actual ReactMarkdown v9 equivalent pipeline; URLs/components still run there. */
export function deriveRendererMarkdown(text: string, streaming: boolean): RendererMarkdownResult {
  const source = rendererMarkdownSource(text, streaming);
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkBreaks)
    .use(remarkMath).use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRendererSections).use(rehypeKatex);
  return { source, tree: processor.runSync(processor.parse(source)) as Root };
}
