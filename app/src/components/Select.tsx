import { Fragment, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import type { SelectOption } from '@/store/types';

/**
 * Compact dropdown used by the AI-input composer (workspace / permission /
 * model). The trigger shows the current option's label (+ optional hint
 * badge); the menu pops *upward* because the composer sits at the bottom of
 * the screen. Clicking outside closes it.
 */
export interface SelectProps {
  options: SelectOption[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  /** Optional leading glyph, e.g. a folder icon for the workspace selector. */
  icon?: string;
  /** Accessible label for the trigger. */
  title?: string;
  className?: string;
}

export default function Select({
  options,
  value,
  onChange,
  disabled = false,
  icon,
  title,
  className,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.id === value) ?? options[0];

  // Close on outside click.
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

  return (
    <div
      ref={rootRef}
      className={cn('relative min-w-0', open && 'z-50', className)}
    >
      <button
        type="button"
        title={title}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors',
          open
            ? 'border-accent bg-border-soft text-fg'
            : 'border-border bg-panel-2 text-fg-dim hover:border-accent hover:text-fg',
          disabled && 'cursor-not-allowed opacity-50 hover:border-border hover:text-fg-dim',
        )}
      >
        {icon && <span className="shrink-0 text-fg-faint">{icon}</span>}
        <span className="min-w-0 flex-1 truncate">{selected?.label}</span>
        {selected?.hint && (
          <span className="shrink-0 rounded bg-border-soft px-1 py-0.5 text-[10px] text-fg-faint">
            {selected.hint}
          </span>
        )}
        <span className="shrink-0 text-[9px] text-fg-faint">▾</span>
      </button>

      {open && !disabled && (
        <ul
          className="absolute bottom-full left-0 z-50 mb-1 max-h-96 min-w-full overflow-y-auto rounded-md border border-border bg-panel py-1 shadow-lg"
          role="listbox"
        >
          {options.map((opt, index) => {
            const active = opt.id === selected?.id;
            const showGroupHeader =
              !!opt.group && opt.group !== options[index - 1]?.group;
            return (
              <Fragment key={opt.id}>
                {showGroupHeader && (
                  <li
                    role="presentation"
                    className={cn(
                      'px-3 pb-1 pt-1.5 font-mono text-[9px] uppercase tracking-wider text-fg-faint',
                      index > 0 && 'mt-1 border-t border-border-soft',
                    )}
                  >
                    {opt.group}
                  </li>
                )}
                <li>
                  <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    onChange(opt.id);
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
                  <span className="flex-1">{opt.label}</span>
                  {opt.hint && (
                    <span className="text-[10px] text-fg-faint">{opt.hint}</span>
                  )}
                  </button>
                </li>
              </Fragment>
            );
          })}
        </ul>
      )}
    </div>
  );
}
