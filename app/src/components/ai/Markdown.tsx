import {
  memo,
  isValidElement,
  cloneElement,
  type ReactElement,
  type ReactNode,
} from 'react';
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
} from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import 'katex/dist/katex.min.css';
import { HL_LANGUAGES, HL_ALIASES } from './lib/highlight';
import { repairMarkdown } from './lib/repairMarkdown';
import { normalizeMath } from './lib/normalizeMath';
import { protectWindowsPaths } from './lib/protectWindowsPaths';
import { scanFileRefs } from './lib/fileScan';
import { parseToolLine } from './lib/toolLine';
import CodeBlock from './CodeBlock';
import InlineCode from './InlineCode';
import SmartLink from './SmartLink';
import ToolLine from './ToolLine';
import Callout from './Callout';
import { detectCallout, stripCalloutMarker } from './lib/callout';
import FileChip, { type OpenFileFn } from './FileChip';

function markdownUrlTransform(url: string, key: string): string | null | undefined {
  if (
    key === 'src' &&
    /^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(url)
  ) {
    return url;
  }
  return defaultUrlTransform(url);
}

/**
 * Renders one answer chunk of markdown with GFM (tables, strikethrough, task
 * lists), single-newline line breaks (remark-breaks), and syntax-highlighted
 * fenced code. Component overrides:
 *   - `pre`   -> CodeBlock chrome (language label, copy, wrap toggle)
 *   - `code`  -> inline spans become InlineCode / FileChip; block bodies pass
 *               through highlighted (react-markdown v9 wraps block code in <pre>)
 *   - `a`     -> SmartLink (external new-tab vs local file chip)
 *   - `p`     -> tool-call lines get a compact ToolLine; otherwise prose with
 *               bare file references linkified into FileChips
 *   - `li`/`td`/`th` -> bare file references linkified
 *
 * While `streaming`, the text is repaired (dangling fences/ticks closed on a
 * copy) so a half-typed token doesn't flip the whole subtree to a code block.
 * Memoized on (text, streaming) so backlog bubbles never re-parse.
 */
function MarkdownImpl({
  text,
  streaming = false,
  onOpenFile,
  cwd,
}: {
  text: string;
  streaming?: boolean;
  onOpenFile?: OpenFileFn;
  cwd?: string;
}) {
  const normalized = protectWindowsPaths(normalizeMath(text));
  const src = streaming ? repairMarkdown(normalized) : normalized;

  // Recursively walk rendered children, replacing bare file references inside
  // plain-text leaves with clickable chips. Elements (e.g. <strong>, <code>,
  // chips) pass through untouched so we never double-linkify code or links.
  const linkify = (children: ReactNode): ReactNode => {
    if (typeof children === 'string') {
      const parts = scanFileRefs(children);
      if (parts.length === 1 && typeof parts[0] === 'string') return children;
      return parts.map((p, i) =>
        typeof p === 'string' ? (
          <span key={i}>{p}</span>
        ) : (
          <FileChip key={i} refData={p} onOpenFile={onOpenFile} cwd={cwd} />
        ),
      );
    }
    if (Array.isArray(children)) return children.map((c, i) => linkifyKeyed(c, i));
    return children;
  };
  const linkifyKeyed = (child: ReactNode, key: number): ReactNode => {
    if (typeof child === 'string') {
      const parts = scanFileRefs(child);
      if (parts.length === 1 && typeof parts[0] === 'string') return child;
      return (
        <span key={key}>
          {parts.map((p, i) =>
            typeof p === 'string' ? (
              <span key={i}>{p}</span>
            ) : (
              <FileChip key={i} refData={p} onOpenFile={onOpenFile} cwd={cwd} />
            ),
          )}
        </span>
      );
    }
    return child;
  };

  // Extract the plain-text content of a paragraph's children to test whether the
  // whole line is a tool-call progress line.
  const plainText = (children: ReactNode): string => {
    if (typeof children === 'string') return children;
    if (typeof children === 'number') return String(children);
    if (Array.isArray(children)) return children.map(plainText).join('');
    if (isValidElement(children)) {
      return plainText((children.props as { children?: ReactNode }).children);
    }
    return '';
  };

  // Remove the leading `[!KIND]` marker from the first text leaf of a callout's
  // children, leaving the rest of the tree intact. Stops after the first strip.
  const stripCalloutFromTree = (children: ReactNode): ReactNode => {
    const state = { done: false };
    const walk = (node: ReactNode): ReactNode => {
      if (state.done) return node;
      if (typeof node === 'string') {
        const stripped = stripCalloutMarker(node);
        if (stripped !== node) state.done = true;
        return stripped;
      }
      if (Array.isArray(node)) {
        return node.map((c, i) => {
          const out = walk(c);
          return isValidElement(out) ? out : <span key={i}>{out}</span>;
        });
      }
      if (isValidElement(node)) {
        const el = node as ReactElement<{ children?: ReactNode }>;
        return cloneElement(el, undefined, walk(el.props.children));
      }
      return node;
    };
    return walk(children);
  };

  const components: Components = {
    pre: ({ node, children }) => (
      <CodeBlock node={node as never}>{children}</CodeBlock>
    ),
    code: ({ className, children, ...props }) => {
      // Block code lives inside a <pre> (handled above). rehype-highlight tags
      // it with `language-*`/`hljs`; an indented or info-less fence has neither,
      // so also treat multi-line content as a block to avoid inline pills.
      const cls = typeof className === 'string' ? className : '';
      const text = plainText(children);
      const isBlock =
        cls.includes('language-') || cls.includes('hljs') || text.includes('\n');
      if (isBlock) {
        return (
          <code className={className} {...props}>
            {children}
          </code>
        );
      }
      return (
        <InlineCode onOpenFile={onOpenFile} cwd={cwd}>
          {children}
        </InlineCode>
      );
    },
    a: ({ href, children }) => (
      <SmartLink href={href} onOpenFile={onOpenFile} cwd={cwd}>
        {children as ReactNode}
      </SmartLink>
    ),
    p: ({ children }) => {
      const tool = parseToolLine(plainText(children));
      if (tool) {
        return (
          <ToolLine
            name={tool.name}
            detail={tool.detail}
            onOpenFile={onOpenFile}
            cwd={cwd}
          />
        );
      }
      return <p>{linkify(children)}</p>;
    },
    li: ({ children }) => <li>{linkify(children)}</li>,
    td: ({ children }) => <td>{linkify(children)}</td>,
    th: ({ children }) => <th>{linkify(children)}</th>,
    table: ({ children }) => (
      <div className="ai-table-wrap my-2 overflow-x-auto rounded-lg border border-border">
        <table className="ai-table w-full border-collapse text-[13px]">{children}</table>
      </div>
    ),
    blockquote: ({ children }) => {
      const kind = detectCallout(plainText(children));
      if (kind) {
        return <Callout kind={kind}>{stripCalloutFromTree(children)}</Callout>;
      }
      return <blockquote>{children}</blockquote>;
    },
    img: ({ src, alt }) => (
      <img
        src={src}
        alt={alt ?? ''}
        loading="lazy"
        className="ai-generated-image"
      />
    ),
  };

  return (
    <div className="ai-markdown ai-stream-markdown text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks, remarkMath]}
        rehypePlugins={[
          [
            rehypeHighlight,
            { detect: true, languages: HL_LANGUAGES, aliases: HL_ALIASES },
          ],
          rehypeKatex,
        ]}
        components={components}
        urlTransform={markdownUrlTransform}
      >
        {src}
      </ReactMarkdown>
    </div>
  );
}

const Markdown = memo(MarkdownImpl);
export default Markdown;
