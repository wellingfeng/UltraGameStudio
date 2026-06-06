import { memo } from 'react';
import { segmentMessage } from './lib/segmenter';
import Markdown from './Markdown';
import ReasoningBlock from './ReasoningBlock';
import CopyButton from './CopyButton';
import ToolCard from './ToolCard';
import type { ToolEvent } from './lib/toolEvent';
import type { OpenFileFn } from './FileChip';

/** Group tool events into parents + their `parentId` children (one level). */
function nestTools(events: ToolEvent[]): Array<{ event: ToolEvent; children: ToolEvent[] }> {
  const childrenByParent = new Map<string, ToolEvent[]>();
  for (const e of events) {
    if (e.parentId) {
      const list = childrenByParent.get(e.parentId) ?? [];
      list.push(e);
      childrenByParent.set(e.parentId, list);
    }
  }
  return events
    .filter((e) => !e.parentId)
    .map((event) => ({ event, children: childrenByParent.get(event.id) ?? [] }));
}

/**
 * Top-level renderer for one assistant/user/system message's text. Segments the
 * text into ordered reasoning (`<think>…`) and answer chunks, then renders
 * reasoning as collapsible blocks and answers as full markdown (GFM tables,
 * highlighted code, file chips, smart links, KaTeX math, callouts).
 *
 * `streaming` should be true only for the live (last) bubble so an unclosed
 * `<think>` shows as in-progress, partial markdown is repaired, and a trailing
 * typewriter caret follows the last answer. `showActions` adds a hover toolbar
 * with a copy-whole-message button. Memoized on (text, streaming, showActions).
 */
function MessageContentImpl({
  text,
  streaming = false,
  showActions = false,
  onOpenFile,
  cwd,
}: {
  text: string;
  streaming?: boolean;
  showActions?: boolean;
  onOpenFile?: OpenFileFn;
  cwd?: string;
}) {
  const segments = segmentMessage(text, streaming);

  if (segments.length === 0) {
    return streaming ? <span className="ai-caret" aria-hidden /> : null;
  }

  // Only the final answer segment is "live"; earlier answers are already sealed
  // by a following reasoning block, so they must not be repaired (which could
  // append a stray backtick to text that legitimately ends in one).
  let lastAnswerIdx = -1;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].type === 'answer') {
      lastAnswerIdx = i;
      break;
    }
  }
  // The very last segment overall — a trailing caret goes after it while live.
  const lastIdx = segments.length - 1;

  // Plain-text copy payload: the answer text without reasoning/tool segments.
  const copyText = segments
    .map((s) => (s.type === 'answer' ? s.text : ''))
    .join('')
    .trim();

  return (
    <div className="ai-message group/msg relative flex flex-col">
      {showActions && copyText && (
        <div className="absolute -top-1 right-0 z-10 opacity-0 transition-opacity group-hover/msg:opacity-100">
          <CopyButton
            value={copyText}
            label="复制"
            className="rounded border border-border-soft bg-panel-2/80 px-1.5 py-0.5 text-[11px] backdrop-blur"
          />
        </div>
      )}
      {segments.map((seg, i) => {
        if (seg.type === 'reasoning') {
          return (
            <ReasoningBlock
              key={`r${i}`}
              text={seg.text}
              done={seg.done}
              streaming={streaming && !seg.done}
            />
          );
        }
        if (seg.type === 'tools') {
          return (
            <div key={`t${i}`} className="ai-tools-group flex flex-col">
              {nestTools(seg.events).map(({ event, children }) => (
                <ToolCard
                  key={event.id}
                  event={event}
                  childrenEvents={children}
                  onOpenFile={onOpenFile}
                  cwd={cwd}
                />
              ))}
            </div>
          );
        }
        return (
          <div key={`a${i}`} className="relative">
            <Markdown
              text={seg.text}
              streaming={streaming && i === lastAnswerIdx}
              onOpenFile={onOpenFile}
              cwd={cwd}
            />
            {streaming && i === lastIdx && (
              <span className="ai-caret ai-caret--trailing" aria-hidden />
            )}
          </div>
        );
      })}
    </div>
  );
}

const MessageContent = memo(MessageContentImpl);
export default MessageContent;

