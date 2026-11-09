import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import MessageContent from './MessageContent';
import { cleanMessageText, renderMessageText } from './lib/messageText';
import type { OpenFileFn } from './FileChip';
import {
  highlightSearchMarks,
  type SearchHighlightState,
} from './lib/searchHighlight';

/**
 * Performance wrapper around {@link MessageContent}.
 *
 * Rendering a message through the full markdown pipeline (react-markdown +
 * remark-gfm/math + rehype-highlight + rehype-katex) is expensive. When a
 * session with a long history is opened, rendering *every* message that way in
 * one synchronous commit blocks the main thread for seconds before anything
 * paints.
 *
 * To avoid that, off-screen messages render as cheap plain text first (instant,
 * roughly the right height) and only upgrade to the rich markdown renderer once
 * they scroll near the viewport (IntersectionObserver). Once upgraded a message
 * stays upgraded, so scrolling back never re-pays the cost or flickers.
 *
 * `eager` renders visible tail messages richly in the first commit, including
 * historical messages, so session switches never paint a placeholder first.
 *
 * `scrollRootRef` is the scroll container; passing it makes the observer measure
 * intersection relative to the message stream rather than the whole window, and
 * a generous rootMargin pre-upgrades just-off-screen messages to hide pop-in.
 *
 * `searchState` enables inline search-match highlighting in both the plain-text
 * fallback and the rich renderer. The hit counter is reset at the start of each
 * render so the fallback and the eventual rich upgrade assign identical match
 * IDs (`${messageId}:text:${hitIndex}`).
 */
function LazyMessageContentImpl({
  text,
  fallback,
  rawText = false,
  streaming = false,
  showActions = false,
  onOpenFile,
  cwd,
  eager = false,
  scrollRootRef,
  searchState = null,
  referenceSources,
  collectReferences = true,
}: {
  text: string;
  /** Plain-text stand-in shown until the rich renderer is mounted. */
  fallback?: string;
  /** Strip route/timing and protocol fallback inside this memo boundary. */
  rawText?: boolean;
  streaming?: boolean;
  showActions?: boolean;
  onOpenFile?: OpenFileFn;
  cwd?: string;
  eager?: boolean;
  scrollRootRef?: RefObject<HTMLElement | null>;
  searchState?: SearchHighlightState | null;
  referenceSources?: import('@/lib/messageReferences').ReferenceSource[];
  collectReferences?: boolean;
}) {
  // Reset the per-message hit counter before each render so the fallback and
  // the rich renderer (which may render at different times due to lazy
  // upgrading) always start from index 0 and produce identical match IDs.
  if (searchState) searchState.hitCounter.current = 0;

  const [rich, setRich] = useState(eager);
  const body = useMemo(() => rawText ? renderMessageText(text) : text, [rawText, text]);
  const plain = useMemo(() => fallback ?? (rawText ? cleanMessageText(text) : text), [fallback, rawText, text]);
  const holderRef = useRef<HTMLDivElement>(null);

  // Promote to the rich renderer if this message becomes eager later (e.g. it
  // grows into the tail window or starts streaming).
  useEffect(() => {
    if (eager) setRich(true);
  }, [eager]);

  // Upgrade lazily when the plain-text placeholder approaches the viewport.
  useEffect(() => {
    if (rich) return;
    const el = holderRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setRich(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setRich(true);
          io.disconnect();
        }
      },
      { root: scrollRootRef?.current ?? null, rootMargin: '600px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [rich, scrollRootRef]);

  if (rich || eager) {
    return (
      <MessageContent
        text={body}
        streaming={streaming}
        showActions={showActions}
        onOpenFile={onOpenFile}
        cwd={cwd}
        searchState={searchState}
        referenceSources={referenceSources}
        collectReferences={collectReferences}
      />
    );
  }

  return (
    <div
      ref={holderRef}
      className="ai-stream-text whitespace-pre-wrap break-words text-sm leading-relaxed"
    >
      {searchState
        ? highlightSearchMarks(plain, searchState, "fb")
        : plain}
    </div>
  );
}

const LazyMessageContent = memo(LazyMessageContentImpl);
export default LazyMessageContent;
