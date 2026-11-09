import { useId, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import ReasoningBlock from './ReasoningBlock';
import ToolCard from './ToolCard';
import type { ToolEvent } from './lib/toolEvent';
import type { ExecutionSegment } from './executionSegments';
import type { OpenFileFn } from './FileChip';
import type { SearchHighlightState } from './lib/searchHighlight';
import { useStore } from '@/store/useStore';
import { skillActivity } from './lib/skillActivity';

/** Group tool events into parents + their `parentId` children (one level). */
function nestTools(events: ToolEvent[]): Array<{ event: ToolEvent; children: ToolEvent[] }> {
  const childrenByParent = new Map<string, ToolEvent[]>();
  const ids = new Set(events.map((event) => event.id));
  for (const event of events) {
    if (event.parentId) {
      const children = childrenByParent.get(event.parentId) ?? [];
      children.push(event);
      childrenByParent.set(event.parentId, children);
    }
  }
  return events
    .filter((event) => !event.parentId || !ids.has(event.parentId))
    .map((event) => ({ event, children: childrenByParent.get(event.id) ?? [] }));
}

/** A quiet disclosure for one consecutive run of reasoning and tool events. */
export default function ExecutionProcess({
  segments,
  streaming,
  onOpenFile,
  cwd,
  searchState = null,
}: {
  segments: ExecutionSegment[];
  streaming: boolean;
  onOpenFile?: OpenFileFn;
  cwd?: string;
  searchState?: SearchHighlightState | null;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const locale = useStore((state) => state.locale);
  const query = searchState?.query.toLowerCase() ?? '';
  const hasSearchMatch = !!query && segments.some((segment) =>
    segment.type === 'reasoning' && segment.text.toLowerCase().includes(query));
  // Search temporarily exposes matches without overwriting the user's choice.
  const expanded = open || hasSearchMatch;
  const events = segments.flatMap((segment) => segment.type === 'tools' ? segment.events : []);
  const reasoning = segments.filter((segment) => segment.type === 'reasoning');
  const running = events.filter((event) => event.status === 'running').length
    + reasoning.filter((segment) => !segment.done).length;
  const failed = events.filter((event) => event.status === 'error').length;
  const count = events.length + reasoning.length;
  const status = failed ? 'error' : running ? 'running' : 'done';
  const summary = locale === 'zh-CN'
    ? [`${count} 步`, running ? `${running} 进行中` : '', failed ? `${failed} 失败` : ''].filter(Boolean).join(' · ')
    : [`${count} ${count === 1 ? 'step' : 'steps'}`, running ? `${running} running` : '', failed ? `${failed} failed` : ''].filter(Boolean).join(' · ');
  const tools = nestTools(events);
  const childrenById = new Map(tools.map(({ event, children }) => [event.id, children]));
  const activities = [...new Map(events.flatMap((event) => {
    const activity = skillActivity(event);
    return activity ? [[`${activity.kind}:${activity.name}`, activity] as const] : [];
  })).values()];

  return (
    <div className="ai-execution-process" data-open={expanded ? 'true' : 'false'} data-status={status}>
      <button
        type="button"
        className="ai-execution-process__toggle inline-flex w-fit max-w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-fg-dim transition-colors hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight size={13} className={expanded ? 'rotate-90' : ''} aria-hidden />
        <span className="ai-execution-process__label">
          {locale === 'zh-CN' ? '执行过程' : 'Execution process'}
        </span>
        <span className="ai-execution-process__summary text-fg-faint">{summary}</span>
      </button>
      {activities.map((activity) => (
        <div key={`${activity.kind}:${activity.name}`} data-ugs-skill-activity="true" className="px-2 py-0.5 text-xs text-fg-dim">
          {locale === 'zh-CN'
            ? `${activity.kind === 'used' ? '使用技能' : '读取技能'}：${activity.name}`
            : `${activity.kind === 'used' ? 'Skill used' : 'Skill read'}: ${activity.name}`}
        </div>
      ))}
      <div id={bodyId} className="ai-execution-process__body">
        {segments.map((segment, index) => segment.type === 'reasoning' ? (
          <div key={`reasoning-${index}`} className="ai-execution-process__step" hidden={!expanded && segment.done}>
            <ReasoningBlock
              text={segment.text}
              done={segment.done}
              streaming={streaming && !segment.done}
              searchState={searchState}
              expanded
              onOpenFile={onOpenFile}
              cwd={cwd}
            />
          </div>
        ) : (
          <div key={`tools-${index}`} className="ai-tools-group flex flex-col">
            {segment.events.filter((event) => childrenById.has(event.id)).map((event, toolIndex) => {
              const children = childrenById.get(event.id) ?? [];
              return (
              <div
                key={`tool-${toolIndex}`}
                className="ai-execution-process__step"
                hidden={!expanded && event.status === 'done' && children.every((child) => child.status === 'done')}
              >
                <ToolCard event={event} childrenEvents={children} onOpenFile={onOpenFile} cwd={cwd} keepActiveChildrenVisible />
              </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
