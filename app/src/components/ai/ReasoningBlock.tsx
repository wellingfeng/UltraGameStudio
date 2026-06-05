import { useEffect, useRef, useState } from 'react';
import { Brain, ChevronRight } from 'lucide-react';
import Markdown from './Markdown';

/**
 * Collapsible "reasoning / thinking" block. Starts open while streaming, then
 * auto-collapses ONCE on the `done` rising edge (a settled receipt). A user
 * toggle afterwards wins — we stop auto-collapsing once they've interacted.
 *
 * The collapse uses the `grid-template-rows: 0fr → 1fr` trick rather than
 * animating `height`, so it stays smooth even as reasoning text streams in.
 */
export default function ReasoningBlock({
  text,
  done,
  streaming,
}: {
  text: string;
  done: boolean;
  streaming: boolean;
}) {
  const [open, setOpen] = useState(true);
  const userToggled = useRef(false);
  const collapsedOnce = useRef(false);
  const startRef = useRef<number | null>(null);
  const [seconds, setSeconds] = useState(0);

  // Honest "已思考 Ns" timer: start the clock as soon as reasoning begins
  // (the open tag may arrive before any inner text), tick while streaming,
  // freeze on done.
  useEffect(() => {
    if (startRef.current == null && (streaming || text)) {
      startRef.current = Date.now();
    }
  }, [streaming, text]);
  useEffect(() => {
    if (done || !streaming) return;
    const id = window.setInterval(() => {
      if (startRef.current != null) {
        setSeconds(Math.round((Date.now() - startRef.current) / 1000));
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [done, streaming]);
  useEffect(() => {
    if (done && startRef.current != null) {
      setSeconds(Math.round((Date.now() - startRef.current) / 1000));
    }
  }, [done]);

  // Auto-collapse once when reasoning finishes (unless the user already toggled).
  useEffect(() => {
    if (done && !collapsedOnce.current && !userToggled.current) {
      collapsedOnce.current = true;
      setOpen(false);
    }
  }, [done]);

  const toggle = () => {
    userToggled.current = true;
    setOpen((o) => !o);
  };

  const header = done
    ? seconds > 0
      ? `已思考 ${seconds}s`
      : '思考过程'
    : '思考中…';

  return (
    <div className="ai-reasoning my-2 overflow-hidden rounded-lg border border-border-soft">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="ai-reasoning__toggle flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors"
      >
        <ChevronRight
          size={13}
          className={'shrink-0 transition-transform ' + (open ? 'rotate-90' : '')}
        />
        <Brain size={13} className="ai-reasoning__icon shrink-0" />
        <span className={!done ? 'ai-reasoning__live' : ''}>{header}</span>
      </button>
      <div
        className="ai-reasoning__body grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="ai-reasoning__inner break-words border-t border-border-soft px-3 py-2 text-[12px] leading-relaxed">
            {text ? (
              <Markdown text={text} streaming={streaming} />
            ) : streaming ? (
              '…'
            ) : (
              ''
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
