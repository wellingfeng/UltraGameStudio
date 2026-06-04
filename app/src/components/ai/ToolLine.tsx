import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { scanFileRefs } from './lib/fileScan';
import ToolIcon from './ToolIcon';
import CopyButton from './CopyButton';
import FileChip, { type OpenFileFn } from './FileChip';
import { compactToolSubject, toolSubjectAllowsFileRefs } from './lib/toolDisplay';

/**
 * Renders a runtime tool-call progress line (e.g. `🔧 command_execution: rg …`)
 * as a compact card row: a per-tool icon + tool name + a one-line detail, with a
 * chevron to expand the full detail and a hover copy button. File references in
 * the detail are clickable chips.
 *
 * This is the text-only (wave-1) renderer — there is no status/duration/args yet
 * (the runtime emits a flat text line). The richer ToolCard (wave-2) takes over
 * once structured tool events are available.
 */
export default function ToolLine({
  name,
  detail,
  onOpenFile,
}: {
  name: string;
  detail: string;
  onOpenFile?: OpenFileFn;
}) {
  const [open, setOpen] = useState(false);
  const collapsedDetail = compactToolSubject(name, detail);
  const rawOneLine = detail.replace(/[\r\n]+/g, ' ').trim();
  const expandable =
    detail.length > 88 || detail.includes('\n') || collapsedDetail !== rawOneLine;
  const linkFileRefs = toolSubjectAllowsFileRefs(name);

  const renderDetail = (text: string) => {
    if (!linkFileRefs) return text;
    const parts = scanFileRefs(text);
    return parts.map((p, i) =>
      typeof p === 'string' ? (
        <span key={i}>{p}</span>
      ) : (
        <FileChip key={i} refData={p} onOpenFile={onOpenFile} />
      ),
    );
  };

  return (
    <div
      className="ai-tool-card group/tool my-0.5 rounded-[4px]"
      data-open={open ? 'true' : 'false'}
      data-status="idle"
    >
      <div className="flex items-center gap-1.5 px-2 py-1 font-mono text-[11px] leading-snug">
        {expandable ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-label={open ? '收起' : '展开'}
            className="-ml-0.5 flex shrink-0 items-center text-fg-faint transition-colors hover:text-fg"
          >
            <ChevronRight
              size={12}
              className={'transition-transform ' + (open ? 'rotate-90' : '')}
            />
          </button>
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <ToolIcon name={name} size={12} className="shrink-0 text-fg-faint" />
        <span className="shrink-0 font-medium text-fg-dim">{name}</span>
        {detail && (
          <span
            className={
              'min-w-0 flex-1 text-fg-faint ' +
              (open ? 'whitespace-pre-wrap break-words' : 'truncate')
            }
          >
            {open ? renderDetail(detail) : renderDetail(collapsedDetail)}
          </span>
        )}
        <CopyButton
          value={detail ? `${name}: ${detail}` : name}
          className="shrink-0 px-1 opacity-0 transition-opacity group-hover/tool:opacity-100"
        />
      </div>
    </div>
  );
}
