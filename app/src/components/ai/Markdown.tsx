import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  isValidElement,
  cloneElement,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
} from 'react-markdown';
import type { PluggableList } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { deriveRendererMarkdown, rendererMarkdownSource, rehypeRendererSections } from './lib/rendererMarkdown';
import { useRendererMarkdown } from './lib/useRendererMarkdown';
import { detectDetails, detectDetailsTitle } from './lib/htmlDetails';
import { scanFileRefs } from './lib/fileScan';
import { displayFileRefPath, parseFileRef } from './lib/filePath';
import { parseToolLine } from './lib/toolLine';
import CodeBlock from './CodeBlock';
import DetailsBlock from './DetailsBlock';
import InlineCode from './InlineCode';
import SmartLink from './SmartLink';
import { useMessageReferences } from './MessageReferences';
import { isReferenceCitationLink } from '@/lib/messageReferences';
import ToolLine from './ToolLine';
import Callout from './Callout';
import { detectCallout, stripCalloutMarker } from './lib/callout';
import {
  FileChipLimitNotice,
  FoldedFileChip,
  VisibleFileChip,
  type OpenFileFn,
} from './FileChip';
import type { FileActionItem } from './FileActionsMenu';
import { useFileActionsMenu } from './useFileActionsMenu';
import { claimFileChipSlot, useFileChipBudget, type FileChipSlot } from './lib/fileChipBudget';
import { isModelUrl } from './lib/modelLink';
import { createImagePreviewRef } from './lib/imagePreview';
import {
  highlightSearchMarks,
  type SearchHighlightState,
} from './lib/searchHighlight';
import { Eye, FolderOpen, FolderTree } from 'lucide-react';
import { useStore } from '@/store/useStore';
import { t } from '@/lib/i18n';
import { convertFileSrc } from '@tauri-apps/api/core';
import { ensureLocalAssetScope } from '@/lib/tauri';
import { createMarkdownChunks } from './lib/markdownChunks';

const imageMenuIconClass = 'shrink-0 text-fg-faint';

/**
 * A markdown image is a clickable file reference too: `![](E:\…\shot.png)` is
 * exactly how pasted and generated images reach the transcript. Right-clicking
 * it offers the same "open containing folder" / "reveal in folder" actions as a
 * file chip, so the image can be located on disk without opening the preview
 * drawer first. Remote and data: sources have no folder to jump to, so they
 * keep only the preview action.
 */
function MarkdownImage({
  source,
  alt,
  onOpenFile,
  cwd,
}: {
  source: string;
  alt: string;
  onOpenFile?: OpenFileFn;
  cwd?: string;
}) {
  const locale = useStore((s) => s.locale);
  const { open, element } = useFileActionsMenu();
  const [displaySrc, setDisplaySrc] = useState(source);
  const directSource = /^(?:https?|data|blob|asset|tauri):/i.test(source);
  const fileRef = directSource ? null : parseFileRef(source, { allowSpaces: true });
  const resolvedSource = fileRef ? displayFileRefPath(fileRef, cwd) : source;

  // 本地图片先按文档目录解析成绝对路径，再开 asset scope 并转换 URL；
  // 否则相对路径会错误地按应用进程目录加载。无 Tauri IPC 时保留原 src。
  useEffect(() => {
    if (!source || directSource) {
      setDisplaySrc(source);
      return;
    }
    let disposed = false;
    void (async () => {
      try {
        await ensureLocalAssetScope(resolvedSource);
        if (!disposed) setDisplaySrc(convertFileSrc(resolvedSource));
      } catch {
        // jsdom/无 Tauri 环境：keep the raw source.
      }
    })();
    return () => {
      disposed = true;
    };
  }, [directSource, resolvedSource, source]);

  const image = (
    <img
      src={displaySrc}
      alt={alt}
      loading="lazy"
      className="ai-generated-image"
    />
  );
  if (!source || !onOpenFile) return image;

  const previewRef = createImagePreviewRef(resolvedSource, alt || undefined);
  const localFile = !directSource;

  const openContextMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const items: FileActionItem[] = [
      {
        key: 'preview-in-app',
        label: t(locale, 'chat.previewInApp'),
        icon: <Eye size={13} className={imageMenuIconClass} />,
        onSelect: () => void onOpenFile(previewRef),
      },
    ];
    if (localFile) {
      items.push(
        {
          key: 'open-containing-folder',
          label: t(locale, 'chat.openContainingFolder'),
          icon: <FolderTree size={13} className={imageMenuIconClass} />,
          onSelect: () =>
            void onOpenFile(previewRef, { openContainingFolder: true }),
        },
        {
          key: 'reveal-in-folder',
          label: t(locale, 'chat.reveal'),
          icon: <FolderOpen size={13} className={imageMenuIconClass} />,
          onSelect: () => void onOpenFile(previewRef, { reveal: true }),
        },
      );
    }
    open(event, items);
  };

  return (
    <span className="relative inline-flex max-w-full align-baseline">
      <button
        type="button"
        className="ai-generated-image-trigger"
        data-file-preview-trigger="true"
        title={`在右侧预览\n${t(locale, 'chat.revealHint')}`}
        onClick={() => void onOpenFile(previewRef)}
        onContextMenu={openContextMenu}
      >
        {image}
      </button>
      {element}
    </span>
  );
}

function markdownUrlTransform(url: string, key: string): string | null | undefined {
  if (
    key === 'src' &&
    /^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(url)
  ) {
    return url;
  }
  if (
    key === 'href' &&
    /^data:audio\/(?:mpeg|mp3|wav|x-wav|aac|mp4|ogg|webm|flac);base64,/i.test(url)
  ) {
    return url;
  }
  if (
    key === 'href' &&
    /^data:video\/(?:mp4|mpeg|quicktime|webm|x-matroska|avi);base64,/i.test(url)
  ) {
    return url;
  }
  if (key === 'href' && isModelUrl(url)) return url;
  if (key === 'href' && /^data:text\/plain;base64,/i.test(url)) return url;
  // 本地图片路径（盘符 / UNC / file://）不能掉进 defaultUrlTransform：
  // 它把 `E:` 当非法协议清成空串，`<img src="">` 直接裂图。放行后
  // MarkdownImage 会开 asset scope 并转成 asset URL 显示。
  if (key === 'src' && parseFileRef(url, { allowSpaces: true })) return url;
  // Preserve recognised local destinations (drive paths, /E:/..., file URLs,
  // UNC, percent-encoded paths). SmartLink handles them through the file
  // preview bridge instead of asking the webview to navigate to a file URL.
  if (key === 'href' && parseFileRef(url, { allowSpaces: true })) return url;
  return defaultUrlTransform(url);
}

/**
 * rehypeGroupSections：当 markdown 顶层用 `---`（thematic break）明确分段时，
 * 把每两个 `---` 之间（以及首尾）的顶层块包进一个 `<section class="ai-para-group">`，
 * 并消费掉 `---` 本身。CSS 借此给每个逻辑段落一个浅色块背景，替代细分割线，
 * 让段落边界一眼可辨。没有 `---` 时（单段回答）保持原样，不额外加背景。
 */
const rehypeGroupSections = rehypeRendererSections;

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
function MarkdownBlockImpl({
  text,
  citations = false,
  streaming = false,
  onOpenFile,
  cwd,
  searchState = null,
}: {
  text: string;
  citations?: boolean;
  streaming?: boolean;
  onOpenFile?: OpenFileFn;
  cwd?: string;
  searchState?: SearchHighlightState | null;
}) {
  const revision = useRendererMarkdown(text, streaming);
  // Parse the initial/replacement long revision once too: provider/search replay
  // must never make ReactMarkdown reparse that retained source on every delta.
  const derived = useMemo(() => revision.result ??
    (revision.streaming && revision.text.length > 4096 ? deriveRendererMarkdown(revision.text, true) : undefined),
    [revision.result, revision.text, revision.streaming]);
  const src = useMemo(
    () => derived?.source ?? rendererMarkdownSource(revision.text, revision.streaming),
        [revision.text, revision.streaming, derived],
  );
  const defaultModelAnimations = useMemo(
    () => extractDefaultModelAnimations(src),
    [src],
  );
  const rehypePlugins = useMemo<PluggableList>(
    () => derived ? [() => () => derived.tree] : [rehypeGroupSections, rehypeKatex],
    [derived],
  );
  const fileChipBudget = useFileChipBudget();
  // A worker ACK rerenders this block without rerendering the provider. Replay
  // already claimed ordinals rather than charging the same budget a second time.
  const chipClaims = useRef({ budget: fileChipBudget, slots: [] as FileChipSlot[], cursor: 0 });
  if (chipClaims.current.budget !== fileChipBudget)
    chipClaims.current = { budget: fileChipBudget, slots: [], cursor: 0 };
  chipClaims.current.cursor = 0;
  const referenceContext = useMessageReferences();
  const references = citations ? referenceContext : null;

  // Keep the mutable per-render inputs in a ref so the `components` object below
  // can be built once (stable identity) yet always read the latest values.
  // react-markdown uses `components[tag]` as the element *type*; if that type
  // changes identity on every streamed token, React unmounts and remounts the
  // whole subtree each token — which visibly flickers code blocks, image chips,
  // and paragraphs during streaming. Freezing the component map fixes that.
  const ctxRef = useRef({
    references,
    onOpenFile,
    cwd,
    searchState,
    fileChipBudget,
    defaultModelAnimations,
  });
  ctxRef.current = {
    references,
    onOpenFile,
    cwd,
    searchState,
    fileChipBudget,
    defaultModelAnimations,
  };

  const components = useMemo<Components>(() => {
  const isLineBreak = (child: ReactNode): boolean =>
    isValidElement(child) && child.type === 'br';

  const renderFileRef = (refData: ReturnType<typeof scanFileRefs>[number], key: number) => {
    const { onOpenFile, cwd, fileChipBudget } = ctxRef.current;
    if (typeof refData === 'string') return { node: refData, hidden: false };
    const claims = chipClaims.current;
    const ordinal = claims.cursor++;
    const slot = claims.slots[ordinal] ?? claimFileChipSlot(fileChipBudget);
    claims.slots[ordinal] = slot;
    if (slot === 'notice') {
      return { node: <FileChipLimitNotice key={key} />, hidden: false };
    }
    if (slot === 'hidden') {
      // 折叠只该省掉装饰，不该省掉可点击性：AI 交付物（生成的 HTML/MD 报告）
      // 常常正是一条长回复里最靠后的那批引用，落到这里就变成不可点的死文本。
      // 渲染为无装饰但仍可打开的链接，保证「AI 输出的文件路径都能点」。
      return {
        node: (
          <FoldedFileChip
            key={key}
            refData={refData}
            onOpenFile={onOpenFile}
            cwd={cwd}
          />
        ),
        hidden: false,
      };
    }
    return {
      node: (
        <VisibleFileChip
          key={key}
          refData={refData}
          onOpenFile={onOpenFile}
          cwd={cwd}
        />
      ),
      hidden: false,
    };
  };

  const linkifyText = (
    text: string,
    key?: number,
  ): { node: ReactNode; hiddenOnly: boolean } => {
    const { searchState } = ctxRef.current;
    const parts = scanFileRefs(text);
    if (parts.length === 1 && typeof parts[0] === 'string') {
      // No file refs — apply search highlight if active, else return raw string.
      const highlighted = highlightSearchMarks(
        parts[0],
        searchState,
        key == null ? undefined : String(key),
      );
      return { node: highlighted, hiddenOnly: false };
    }

    let hasVisibleText = false;
    let hasVisibleRef = false;
    let hasHiddenRef = false;
    const nodes = parts.map((part, i) => {
      if (typeof part === 'string') {
        if (part.trim()) hasVisibleText = true;
        const highlighted = highlightSearchMarks(part, searchState, `${key}-${i}`);
        return highlighted === part
          ? part
            ? <span key={i}>{part}</span>
            : null
          : <span key={i}>{highlighted}</span>;
      }
      const rendered = renderFileRef(part, i);
      if (rendered.hidden) {
        hasHiddenRef = true;
      } else if (rendered.node) {
        hasVisibleRef = true;
      }
      return rendered.node;
    });

    const hiddenOnly = hasHiddenRef && !hasVisibleText && !hasVisibleRef;
    return {
      node: hiddenOnly ? null : key == null ? nodes : <span key={key}>{nodes}</span>,
      hiddenOnly,
    };
  };

  // Recursively walk rendered children, replacing bare file references inside
  // plain-text leaves with clickable chips. Elements (e.g. <strong>, <code>,
  // chips) pass through untouched so we never double-linkify code or links.
  const linkify = (children: ReactNode): ReactNode => {
    if (typeof children === 'string') {
      return linkifyText(children).node;
    }
    if (Array.isArray(children)) {
      const out: ReactNode[] = [];
      let skipNextBreak = false;
      children.forEach((child, i) => {
        if (skipNextBreak) {
          skipNextBreak = false;
          if (isLineBreak(child)) return;
        }
        const result = linkifyKeyed(child, i);
        if (result.hiddenOnly) {
          const last = out[out.length - 1];
          if (isLineBreak(last)) out.pop();
          skipNextBreak = true;
        }
        out.push(result.node);
      });
      return out;
    }
    return children;
  };
  const linkifyKeyed = (
    child: ReactNode,
    key: number,
  ): { node: ReactNode; hiddenOnly: boolean } => {
    if (typeof child === 'string') {
      return linkifyText(child, key);
    }
    return { node: child, hiddenOnly: false };
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

  // Extract a `> [!details] 标题` blockquote's title (from the first paragraph)
  // and its folded body (the remaining paragraphs). Returns null when the
  // blockquote is not a details container.
  const detailsParts = (
    children: ReactNode,
  ): { title: string; body: ReactNode } | null => {
    const arr = Array.isArray(children) ? children : [children];
    // react-markdown v9 把换行文本节点平铺在元素之间（children 形如
    // ["\n", <p>, "\n", <ul>, "\n"]），arr[0] 常常只是 "\n"。跳过前导空白，
    // 取第一个有内容的节点判定 `[!details]` marker，否则检测永远落空。
    const first = arr.find((c) => plainText(c).trim() !== '');
    if (first === undefined) return null;
    const intro = plainText(first);
    if (!detectDetails(intro)) return null;
    return {
      title: detectDetailsTitle(intro),
      body: arr.length > 1 ? arr.slice(1) : null,
    };
  };

  return {
    pre: ({ node }) => (
      <CodeBlock
        node={node as never}
        onOpenFile={ctxRef.current.onOpenFile}
        cwd={ctxRef.current.cwd}
      />
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
        <InlineCode onOpenFile={ctxRef.current.onOpenFile} cwd={ctxRef.current.cwd}>
          {children}
        </InlineCode>
      );
    },
    a: ({ href, children }) => {
      const reference = href && isReferenceCitationLink(href, plainText(children)) ? ctxRef.current.references?.find(href) : undefined;
      if (reference) {
        const numeric = /^\[?\d+\]?$/.test(plainText(children).trim());
        return <>{!numeric && children}<button type="button" className="ai-citation"
          title={reference.title} aria-label={`查看参考资料 ${reference.number}：${reference.title}`}
          onClick={() => ctxRef.current.references?.locate(reference.number)}>[{reference.number}]</button></>;
      }
      return (
      <SmartLink
        href={href}
        onOpenFile={ctxRef.current.onOpenFile}
        cwd={ctxRef.current.cwd}
        defaultModelAnimations={ctxRef.current.defaultModelAnimations}
      >
        {children as ReactNode}
      </SmartLink>
      );
    },
    p: ({ children }) => {
      const tool = parseToolLine(plainText(children));
      if (tool) {
        return (
          <ToolLine
            name={tool.name}
            detail={tool.detail}
            onOpenFile={ctxRef.current.onOpenFile}
            cwd={ctxRef.current.cwd}
          />
        );
      }
      return <p>{linkify(children)}</p>;
    },
    li: ({ children }) => <li>{linkify(children)}</li>,
    td: ({ children }) => <td>{linkify(children)}</td>,
    th: ({ children }) => <th>{linkify(children)}</th>,
    table: ({ children }) => (
      <div className="ai-table-wrap overflow-x-auto">
        <table className="ai-table border-collapse">{children}</table>
      </div>
    ),
    blockquote: ({ children }) => {
      const details = detailsParts(children);
      if (details) {
        return (
          <DetailsBlock title={details.title}>{details.body}</DetailsBlock>
        );
      }
      const kind = detectCallout(plainText(children));
      if (kind) {
        return <Callout kind={kind}>{stripCalloutFromTree(children)}</Callout>;
      }
      return <blockquote>{children}</blockquote>;
    },
    img: ({ src, alt }) => {
      const source = typeof src === 'string' ? src : '';
      return (
        <MarkdownImage
          source={source}
          alt={alt ?? ''}
          onOpenFile={ctxRef.current.onOpenFile}
          cwd={ctxRef.current.cwd}
        />
      );
    },
  };
  // Empty deps: the map reads all mutable inputs via ctxRef, so it stays a
  // stable identity across streamed tokens and never remounts subtrees.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const budgetSensitive = useMemo(() => scanFileRefs(src).some((part) => typeof part !== 'string'), [src]);
  // Bare file chips claim their slots in paragraph overrides. Those blocks must
  // replay claims when the message budget resets; ordinary prose/code keeps
  // its parsed element without paying for the sealed prefix again.
  const rendered = useMemo(() => (
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks, remarkMath]}
        rehypePlugins={rehypePlugins}
        components={components}
        urlTransform={markdownUrlTransform}
      >
        {derived ? '' : src}
      </ReactMarkdown>
  ), [src, rehypePlugins, components, onOpenFile, cwd, searchState, references,
    budgetSensitive ? fileChipBudget : fileChipBudget?.expanded]);
  return <>{rendered}{revision.delayed && <span role="status" className="ai-markdown-delayed">Markdown 预览暂时停留在上次版本；生成结束或取消时会完整显示。</span>}</>;
}

const MarkdownBlock = memo(MarkdownBlockImpl);

function MarkdownImpl(props: Parameters<typeof MarkdownBlockImpl>[0]) {
  const chunks = useRef<ReturnType<typeof createMarkdownChunks>>();
  if (!chunks.current) chunks.current = createMarkdownChunks();
  // Search uses one traversal/counter; no chunk-local memo may skip its hits.
  const parts = chunks.current(props.text, !!props.streaming && !props.searchState);
  return <div className="ai-markdown ai-stream-markdown">
    {parts.map((part) => <MarkdownBlock key={part.key} {...props} text={part.text}
      streaming={props.searchState ? !!props.streaming : part.live} />)}
  </div>;
}

const Markdown = memo(MarkdownImpl);
export default Markdown;

function extractDefaultModelAnimations(text: string): string[] {
  if (!text.includes('骨骼')) return [];
  const match = /骨骼：[^。\n]*?请求骨骼绑定和\s+(.+?)\s+预览动画/u.exec(text);
  if (!match) return [];
  return match[1]
    .split(/[、,，/]+/u)
    .map((name) => name.trim())
    .filter(Boolean)
    .slice(0, 6);
}
