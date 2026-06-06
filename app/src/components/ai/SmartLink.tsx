import { isValidElement, type MouseEvent, type ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { openExternal } from '@/lib/tauri';
import { parseFileRef } from './lib/filePath';
import FileChip, { type OpenFileFn } from './FileChip';

/**
 * Anchor renderer for markdown links. External URLs (http/https/mailto) open in
 * a new tab with safe rel; anything that parses as a local file reference is
 * rendered as a clickable {@link FileChip} (a real <a target="_blank"> silently
 * fails for local paths inside a webview).
 */
export default function SmartLink({
  href,
  children,
  onOpenFile,
  cwd,
}: {
  href?: string;
  children?: ReactNode;
  onOpenFile?: OpenFileFn;
  cwd?: string;
}) {
  const url = href ?? '';
  const isWebUrl = /^https?:/i.test(url);
  const isExternal = /^(https?:|mailto:)/i.test(url);
  const ref = parseFileRef(url, { allowSpaces: true });
  if (ref) return <FileChip refData={ref} onOpenFile={onOpenFile} cwd={cwd} />;

  if (!isExternal) {
    const childRef = parseFileRef(childrenToText(children), { allowSpaces: true });
    if (childRef) {
      return <FileChip refData={childRef} onOpenFile={onOpenFile} cwd={cwd} />;
    }
  }

  if (isExternal) {
    const openWebUrl = (event: MouseEvent<HTMLAnchorElement>) => {
      if (!isWebUrl) return;
      event.preventDefault();
      void openExternal(url);
    };

    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={openWebUrl}
        className="inline-flex items-center gap-0.5 text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
      >
        {children}
        <ExternalLink size={11} className="opacity-60" />
      </a>
    );
  }

  // Unknown scheme / relative anchor — render as plain styled text.
  return <span className="text-accent underline underline-offset-2">{children}</span>;
}

function childrenToText(children: ReactNode): string {
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(childrenToText).join('');
  if (isValidElement(children)) {
    return childrenToText((children.props as { children?: ReactNode }).children);
  }
  return '';
}
