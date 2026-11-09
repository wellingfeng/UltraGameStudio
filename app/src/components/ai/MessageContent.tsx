import { memo, useMemo } from 'react';
import { segmentMessage } from './lib/segmenter';
import { TOOL_CLOSE } from './lib/toolEvent';
import Markdown from './Markdown';
import ExecutionProcess from './ExecutionProcess';
import { groupExecutionSegments } from './executionSegments';
import CopyButton from './CopyButton';
import { FileChipBudgetProvider, type OpenFileFn } from './FileChip';
import { answerActionText } from './lib/messageText';
import { type SearchHighlightState } from './lib/searchHighlight';
import { useStore } from '@/store/useStore';
import { t } from '@/lib/i18n';
import SkillLearningCard, { type SkillLearningCardProps } from './SkillLearningCard';
import type { SkillReviewState } from '@/runtime/skills/types';
import { isSkillReviewVisible } from './lib/skillReviewVisibility';
import MessageReferences from './MessageReferences';
import { sourcesFromMessageTools, type ReferenceSource } from '@/lib/messageReferences';
import { admitAndMergeSources } from './lib/referenceAdmission';
import { useMessageReferences } from './lib/useMessageReferences';


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
  searchState = null,
  skillLearning,
  onSkillApprove,
  onSkillReject,
  onSkillRollback,
  referenceSources,
  collectReferences = true,
}: {
  text: string;
  streaming?: boolean;
  showActions?: boolean;
  onOpenFile?: OpenFileFn;
  cwd?: string;
  searchState?: SearchHighlightState | null;
  skillLearning?: SkillReviewState;
  onSkillApprove?: SkillLearningCardProps['onApprove'];
  onSkillReject?: SkillLearningCardProps['onReject'];
  onSkillRollback?: SkillLearningCardProps['onRollback'];
  referenceSources?: ReferenceSource[];
  collectReferences?: boolean;
}) {
  const locale = useStore((s) => s.locale);
  const segments = segmentMessage(text, streaming);
  const copyText = useMemo(() => showActions ? answerActionText(text) : '', [text, showActions]);
  const sourceEnd = text.lastIndexOf(TOOL_CLOSE);
  const sourcePrefix = sourceEnd < 0 ? '' : text.slice(0, sourceEnd + TOOL_CLOSE.length);
  // Unclosed patches cannot establish successful web evidence. The completed
  // source prefix stays unchanged while prose/partial tool tails stream.
  const toolSources = useMemo(() => sourcesFromMessageTools(sourcePrefix), [sourcePrefix]);
  const admittedSources = admitAndMergeSources(referenceSources ?? [], toolSources);
  const references = useMessageReferences(text, admittedSources, streaming, collectReferences);

  if (segments.length === 0 && !isSkillReviewVisible(skillLearning)) {
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



  return (
    <FileChipBudgetProvider>
      <div className="ai-message group/msg relative flex flex-col gap-2" data-reference-admission={admittedSources === null ? 'rejected' : undefined}>
        <MessageReferences references={references}>
        {showActions && copyText && (
          <div className="absolute -top-1 right-0 z-10 opacity-0 transition-opacity group-hover/msg:opacity-100">
            <CopyButton
              value={copyText}
              label={t(locale, 'chat.copy')}
              className="rounded border border-border-soft bg-panel-2/80 px-1.5 py-0.5 text-[11px] backdrop-blur"
            />
          </div>
        )}
        {groupExecutionSegments(segments).map((seg) => {
          const i = seg.index;
          if (seg.type === 'execution') {
            return (
              <ExecutionProcess
                key={`e${i}`}
                segments={seg.segments}
                streaming={streaming}
                onOpenFile={onOpenFile}
                cwd={cwd}
                searchState={searchState}
              />
            );
          }
          return (
            <div key={`a${i}`} className="ai-answer-sep relative">
              <Markdown
                citations
                text={seg.text}
                streaming={streaming && i === lastAnswerIdx}
                onOpenFile={onOpenFile}
                cwd={cwd}
                searchState={searchState}
              />
              {streaming && i === lastIdx && (
                <span className="ai-caret ai-caret--trailing" aria-hidden />
              )}
            </div>
          );
        })}
        </MessageReferences>
        {skillLearning && <SkillLearningCard state={skillLearning} locale={locale}
          onApprove={onSkillApprove} onReject={onSkillReject} onRollback={onSkillRollback} />}
      </div>
    </FileChipBudgetProvider>
  );
}

const MessageContent = memo(MessageContentImpl);
export default MessageContent;

