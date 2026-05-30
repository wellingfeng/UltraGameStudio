import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { basename, pickFolder } from '@/lib/folderPicker';

/**
 * Workspace selector for the AI-input composer.
 *
 * Unlike the generic Select, this has no default option list: the menu offers a
 * "选择文件夹…" action that opens the native folder dialog (Tauri) or the
 * browser fallback, and lists the user's previously-selected folders. Pops
 * upward (the composer sits at the bottom of the screen) and closes on an
 * outside click.
 */
export interface WorkspaceSelectProps {
  /** Current workspace path ('' = none chosen). */
  value: string;
  /** Previously-selected folders, most-recent-first. */
  history: string[];
  /** Commit a chosen path (sets current + records in history). */
  onSelect: (path: string) => void;
  className?: string;
}

export default function WorkspaceSelect({
  value,
  history,
  onSelect,
  className,
}: WorkspaceSelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const browse = async () => {
    const path = await pickFolder();
    setOpen(false);
    if (path) onSelect(path);
  };

  const label = value ? basename(value) : '选择工作区';

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        type="button"
        title={value || '选择工作区文件夹'}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors',
          open
            ? 'border-accent bg-border-soft text-fg'
            : 'border-border bg-panel-2 text-fg-dim hover:border-accent hover:text-fg',
        )}
      >
        <span className="text-fg-faint">🗂</span>
        <span className="max-w-[10rem] truncate">{label}</span>
        <span className="text-[9px] text-fg-faint">▾</span>
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-10 mb-1 min-w-[14rem] overflow-hidden rounded-md border border-border bg-panel py-1 shadow-lg">
          <button
            type="button"
            onClick={browse}
            className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-1.5 text-left text-xs text-fg transition-colors hover:bg-border-soft"
          >
            <span className="text-[11px]">📁</span>
            <span>选择文件夹…</span>
          </button>

          <div className="my-1 border-t border-border-soft" />

          <div className="px-3 pb-0.5 text-[10px] uppercase tracking-wider text-fg-faint">
            历史记录
          </div>
          {history.length === 0 ? (
            <div className="px-3 py-1.5 text-xs text-fg-faint">暂无历史记录</div>
          ) : (
            <ul role="listbox">
              {history.map((path) => {
                const active = path === value;
                return (
                  <li key={path}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={active}
                      title={path}
                      onClick={() => {
                        onSelect(path);
                        setOpen(false);
                      }}
                      className={cn(
                        'flex w-full items-center gap-2 whitespace-nowrap px-3 py-1.5 text-left text-xs transition-colors',
                        active
                          ? 'bg-border-soft text-fg'
                          : 'text-fg-dim hover:bg-border-soft hover:text-fg',
                      )}
                    >
                      <span
                        className={cn(
                          'text-[10px] leading-none',
                          active ? 'text-accent' : 'text-transparent',
                        )}
                      >
                        ●
                      </span>
                      <span className="max-w-[16rem] truncate">
                        {basename(path)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
