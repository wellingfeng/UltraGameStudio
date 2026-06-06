import type { ReactNode } from 'react';
import { parseFileRef } from './lib/filePath';
import FileChip, { type OpenFileFn } from './FileChip';

/**
 * Inline `code` renderer. When the span's text parses as a local file reference
 * (e.g. `src/store/useStore.ts:42`) it becomes a clickable {@link FileChip};
 * otherwise it renders a normal styled inline-code chip. Inline code is the
 * highest-signal, lowest-false-positive surface for file detection — the author
 * already wrapped it in backticks — so we relax the existence bar here.
 */
export default function InlineCode({
  children,
  onOpenFile,
  cwd,
}: {
  children?: ReactNode;
  onOpenFile?: OpenFileFn;
  cwd?: string;
}) {
  const text = childrenToText(children);
  const ref = text ? parseFileRef(text) : null;
  if (ref) return <FileChip refData={ref} onOpenFile={onOpenFile} cwd={cwd} />;

  return (
    <code className="ai-inline-code rounded border border-border bg-panel-2 px-1 py-px font-mono text-[12.5px] text-accent-2">
      {children}
    </code>
  );
}

function childrenToText(children: ReactNode): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(childrenToText).join('');
  if (typeof children === 'number') return String(children);
  return '';
}
