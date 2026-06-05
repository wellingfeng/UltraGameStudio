import {
  memo,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import MessageContent from './MessageContent';
import type { OpenFileFn } from './FileChip';

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
 * `eager` forces the rich renderer from the first paint — used for the tail of
 * the list (what's visible at the bottom on switch) and the live streaming
 * bubble, so the initial view is correct and scroll-to-bottom lands precisely.
 *
 * `scrollRootRef` is the scroll container; passing it makes the observer measure
 * intersection relative to the message stream rather than the whole window, and
 * a generous rootMargin pre-upgrades just-off-screen messages to hide pop-in.
 */
function LazyMessageContentImpl({
  text,
  fallback,
  streaming = false,
  showActions = false,
  onOpenFile,
  eager = false,
  scrollRootRef,
}: {
  text: string;
  /** Plain-text stand-in shown until the rich renderer is mounted. */
  fallback: string;
  streaming?: boolean;
  showActions?: boolean;
  onOpenFile?: OpenFileFn;
  eager?: boolean;
  scrollRootRef?: RefObject<HTMLElement | null>;
}) {
  const [rich, setRich] = useState(eager);
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

  if (rich) {
    return (
      <MessageContent
        text={text}
        streaming={streaming}
        showActions={showActions}
        onOpenFile={onOpenFile}
      />
    );
  }

  return (
    <div
      ref={holderRef}
      className="ai-stream-text whitespace-pre-wrap break-words text-sm leading-relaxed"
    >
      {fallback}
    </div>
  );
}

const LazyMessageContent = memo(LazyMessageContentImpl);
export default LazyMessageContent;
