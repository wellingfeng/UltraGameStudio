import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

const parser = unified().use(remarkParse).use(remarkGfm);
export interface MarkdownChunk { key: number; text: string; live: boolean }

/** Component-owned append state, discarded on unmount. Keep two trailing AST
 * blocks unsealed: a following line can still extend a list, table or fence.
 * Document-wide constructs conservatively use the original unified renderer.
 * Completion and non-append revisions always return the whole source. */
export function createMarkdownChunks() {
  let previous = '';
  let sealedEnd = 0;
  let sealed: MarkdownChunk[] = [];
  let unsafe = false;
  let nextParseLength = 2048;
  return (text: string, streaming: boolean): MarkdownChunk[] => {
    if (!streaming || !text.startsWith(previous)) {
      sealedEnd = 0;
      sealed = [];
      unsafe = false;
      previous = '';
      nextParseLength = 2048;
    }
    const delta = text.slice(previous.length);
    // Brackets include reference definitions/footnotes; HTML, math and section
    // rewrites can reach across blank lines. Look behind the delta boundary too.
    unsafe ||= /[\[<$]|\\[([]|^[ \t]{0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/m.test(text.slice(Math.max(0, previous.length - 32))) ||
      /骨骼/.test(delta) || /^[ \t]{0,3}(?:`{3,}|~{3,})[ \t]*(?:markdown|md)\b/im.test(text.slice(Math.max(0, previous.length - 32)));
    previous = text;
    if (!streaming || unsafe || text.length < 4096) {
      // Completion/document-wide fallback supersedes all sealed blocks. Keep
      // only the source revision, not a second retained chunk representation.
      sealed = []; sealedEnd = 0;
      return [{ key: 0, text, live: streaming }];
    }
    const tail = text.slice(sealedEnd);
    if (tail.length >= nextParseLength) {
      const tree = parser.parse(tail);
      const blocks = tree.children;
      const boundary = blocks.length > 2 ? blocks[blocks.length - 2].position?.start.offset ?? 0 : 0;
      if (boundary > 0) {
        sealed = [...sealed, { key: sealedEnd, text: tail.slice(0, boundary), live: false }];
        sealedEnd += boundary;
        nextParseLength = 2048;
      } else {
        // No stable AST prefix (long paragraph/open fence). Retry only after
        // doubling the mutable tail: failed discovery is amortized linear,
        // not a full-tail parse for every token. Delayed sealing never changes
        // the Markdown document; the live renderer still receives every byte.
        nextParseLength = tail.length * 2;
      }
    }
    return [...sealed, { key: sealedEnd, text: text.slice(sealedEnd), live: true }];
  };
}
