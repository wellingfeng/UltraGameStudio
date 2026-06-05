import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { FileCode, FolderOpen } from 'lucide-react';
import type { FileRef } from './lib/filePath';

export interface OpenFileIntent {
  reveal?: boolean;
}

export interface OpenFileFn {
  (ref: FileRef, intent?: OpenFileIntent): void | Promise<void>;
}

interface ContextMenuPosition {
  x: number;
  y: number;
}

const MENU_WIDTH = 168;
const MENU_HEIGHT = 36;
const MENU_MARGIN = 8;

function contextMenuPosition(event: ReactMouseEvent): ContextMenuPosition {
  if (typeof window === 'undefined') {
    return { x: event.clientX, y: event.clientY };
  }
  return {
    x: Math.max(
      MENU_MARGIN,
      Math.min(event.clientX, window.innerWidth - MENU_WIDTH - MENU_MARGIN),
    ),
    y: Math.max(
      MENU_MARGIN,
      Math.min(event.clientY, window.innerHeight - MENU_HEIGHT - MENU_MARGIN),
    ),
  };
}

/**
 * A clickable chip for a local file reference (e.g. `src/store/useStore.ts:42`).
 * Shows the basename + optional `:line` suffix; the full path is in the tooltip.
 * Clicking calls `onOpenFile`; right-clicking opens a small reveal-in-folder
 * menu. When no handler is wired the chip is styled inert but still serves as a
 * visual signal that this token is a file path.
 */
export default function FileChip({
  refData,
  onOpenFile,
}: {
  refData: FileRef;
  onOpenFile?: OpenFileFn;
}) {
  const [menu, setMenu] = useState<ContextMenuPosition | null>(null);
  const lineSuffix = refData.startLine
    ? `:${refData.startLine}${refData.endLine ? `-${refData.endLine}` : ''}`
    : '';
  const interactive = typeof onOpenFile === 'function';

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [menu]);

  const openFile = () => {
    setMenu(null);
    if (interactive) void onOpenFile(refData);
  };

  const revealFile = () => {
    setMenu(null);
    if (interactive) void onOpenFile(refData, { reveal: true });
  };

  const openContextMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (!interactive) return;
    event.preventDefault();
    event.stopPropagation();
    setMenu(contextMenuPosition(event));
  };

  return (
    <span className="relative inline-flex max-w-full align-baseline">
      <button
        type="button"
        disabled={!interactive}
        onClick={interactive ? openFile : undefined}
        onContextMenu={openContextMenu}
        title={
          interactive
            ? `${refData.path}${lineSuffix}\n右键：在文件夹中显示`
            : refData.path + lineSuffix
        }
        className={
          'ai-file-chip inline-flex max-w-full items-center gap-1 rounded border border-border bg-panel-2 px-1.5 py-px align-baseline font-mono text-[12px] leading-snug ' +
          (interactive
            ? 'ai-file-chip--interactive cursor-pointer'
            : 'cursor-default text-fg-dim')
        }
      >
        <FileCode size={11} className="shrink-0 opacity-70" />
        <span className="ai-file-chip__label truncate">
          {refData.basename}
          {lineSuffix && (
            <span className={interactive ? 'opacity-75' : 'text-fg-faint'}>
              {lineSuffix}
            </span>
          )}
        </span>
      </button>
      {menu && (
        <div
          role="menu"
          className="ai-file-chip-menu fixed z-[70] min-w-[168px] rounded-md border border-border bg-panel py-1 text-xs text-fg shadow-xl"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={revealFile}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-border-soft"
          >
            <FolderOpen size={13} className="shrink-0 text-fg-faint" />
            <span className="truncate">在文件夹中显示</span>
          </button>
        </div>
      )}
    </span>
  );
}
