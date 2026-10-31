import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';
import type { SelectOption } from '@/store/types';

/**
 * Compact dropdown used by the AI-input composer (workspace / permission /
 * model). The trigger shows the current option's label (+ optional hint
 * badge); the menu pops *upward* because the composer sits at the bottom of
 * the screen. Clicking outside closes it.
 *
 * 弹层按触发器的**视口坐标**决定往哪边展开、最宽/最高能到多少：贴着窗口右
 * 侧的选择器（渠道/模型/思考深度）会改为右对齐向左展开，不会再被右侧面板
 * 截断，也不会伸出窗口被裁掉。
 *
 * When open, an auto-focused search input at the top of the menu lets the user
 * filter options by typing — no search button needed.
 */
export interface SelectProps {
  options: SelectOption[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  variant?: 'default' | 'ghost';
  showSelectedHint?: boolean;
  /** Optional leading glyph, e.g. a folder icon for the workspace selector. */
  icon?: string;
  /** Accessible label for the trigger. */
  title?: string;
  className?: string;
  /** 可折叠的分组头：点击组头切换展开/收起。折叠态按 collapsedGroupsKey 持久化。 */
  collapsibleGroups?: boolean;
  /** localStorage key，用于持久化已折叠的分组集合。 */
  collapsedGroupsKey?: string;
  /** 是否在每条选项右侧渲染置顶按钮（不关闭菜单、不切换选中）。 */
  pinnable?: boolean;
  /** 当前已置顶的 option id 列表，用于显示置顶图标状态。 */
  pinnedIds?: string[];
  /** 点击置顶按钮回调。 */
  onTogglePin?: (id: string) => void;
  getSubOptions?: (id: string) => SelectOption[];
  subValue?: string;
  subTitle?: string;
  onSubChange?: (id: string, subId: string) => void;
  triggerSuffix?: string;
}

/** 弹层与视口边缘之间保留的安全间距（px）。 */
const MENU_VIEWPORT_MARGIN = 8;
/** 弹层最少保留的可视高度；低于它就不再缩，允许轻微溢出（px）。 */
const MENU_MIN_HEIGHT = 120;
/** 弹层高度上限，与旧的列表 max-h-80 对齐（px）。 */
const MENU_MAX_HEIGHT = 320;
/** 弹层宽度上限，避免长说明把菜单撑成一条（px）。 */
const MENU_MAX_WIDTH = 520;
/** 搜索行的估算高度，用于反推列表可用高度（px）。 */
const MENU_SEARCH_HEIGHT = 34;

/**
 * 弹层相对触发器的摆放方式。
 *
 * 单一固定的 `bottom-full left-0` 有两个坑：绝对定位盒按包含块（输入卡片）
 * 做 shrink-to-fit，内容比卡片剩余宽度长时会被 `overflow-hidden` 硬裁；
 * 而输入卡片带 `backdrop-filter`，自成层叠上下文，里面的 z-index 压不过
 * 后面的兄弟面板。改成按视口选边 + 夹宽，就可以同时躲开裁切和遮挡。
 */
interface MenuPlacement {
  horizontal: 'left' | 'right';
  vertical: 'up' | 'down';
  minWidth: number;
  maxWidth: number;
  maxHeight: number;
  maxListHeight: number;
}

const INITIAL_PLACEMENT: MenuPlacement = {
  horizontal: 'left',
  vertical: 'up',
  minWidth: 0,
  maxWidth: MENU_MAX_WIDTH,
  maxHeight: MENU_MAX_HEIGHT,
  maxListHeight: MENU_MAX_HEIGHT - MENU_SEARCH_HEIGHT,
};

const isZh = typeof navigator !== 'undefined' && navigator.language?.startsWith('zh');

export default function Select({
  options,
  value,
  onChange,
  disabled = false,
  variant = 'default',
  showSelectedHint = true,
  icon,
  title,
  className,
  collapsibleGroups = false,
  collapsedGroupsKey,
  pinnable = false,
  pinnedIds,
  onTogglePin,
  getSubOptions,
  subValue,
  subTitle,
  onSubChange,
  triggerSuffix,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const [submenu, setSubmenu] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const [submenuPosition, setSubmenuPosition] = useState({ left: 0, top: 0, maxHeight: MENU_MAX_HEIGHT });
  const [menuPlacement, setMenuPlacement] =
    useState<MenuPlacement>(INITIAL_PLACEMENT);

  // 按触发器的视口坐标算弹层摆放：优先往空间更大的一侧展开，宽度夹在该侧
  // 可用空间内，高度按上下剩余空间收紧。
  const computeMenuPlacement = useCallback((): MenuPlacement | null => {
    const el = rootRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const spaceRight = viewportWidth - rect.left - MENU_VIEWPORT_MARGIN;
    const spaceLeft = rect.right - MENU_VIEWPORT_MARGIN;
    const spaceAbove = rect.top - MENU_VIEWPORT_MARGIN;
    const spaceBelow = viewportHeight - rect.bottom - MENU_VIEWPORT_MARGIN;
    // 横向：右侧更宽裕则左对齐向右展开，否则贴右边缘向左展开。
    const horizontal: MenuPlacement['horizontal'] =
      spaceRight >= spaceLeft ? 'left' : 'right';
    // 纵向：输入框贴屏幕底部，默认向上弹；上方放不下才翻到下方。
    const vertical: MenuPlacement['vertical'] =
      spaceAbove >= spaceBelow ? 'up' : 'down';
    const sideSpace = horizontal === 'left' ? spaceRight : spaceLeft;
    const verticalSpace = vertical === 'up' ? spaceAbove : spaceBelow;
    const maxHeight = Math.max(
      MENU_MIN_HEIGHT,
      Math.min(MENU_MAX_HEIGHT, verticalSpace),
    );
    return {
      horizontal,
      vertical,
      // 下限用触发器的实测宽度（不用 min-w-full：百分比会按包含块即整条
      // 工具栏算，菜单会被撑成整个输入框宽）。
      minWidth: rect.width,
      maxWidth: Math.max(
        rect.width,
        Math.min(MENU_MAX_WIDTH, Math.max(sideSpace, rect.width)),
      ),
      maxHeight,
      maxListHeight: Math.max(64, maxHeight - MENU_SEARCH_HEIGHT),
    };
  }, []);

  // 打开时以及在窗口缩放/滚动过程中重算，保证弹层始终贴着触发器且不出屏。
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const next = computeMenuPlacement();
      if (next) setMenuPlacement(next);
    };
    update();
    window.addEventListener('resize', update);
    // 捕获阶段监听滚动：输入卡片内部滚动时触发器位置同样会变。
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, computeMenuPlacement]);

  // 折叠的分组集合（按 group 字符串）。传入 collapsedGroupsKey 时持久化到
  // localStorage；切语言后 group 名会变，折叠态随之重置，属可接受行为。
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    if (!collapsibleGroups || !collapsedGroupsKey) return new Set();
    try {
      const raw = localStorage.getItem(collapsedGroupsKey);
      if (raw) return new Set(JSON.parse(raw) as string[]);
    } catch {
      /* ignore */
    }
    return new Set();
  });
  useEffect(() => {
    if (!collapsibleGroups || !collapsedGroupsKey) return;
    try {
      localStorage.setItem(
        collapsedGroupsKey,
        JSON.stringify([...collapsed]),
      );
    } catch {
      /* ignore */
    }
  }, [collapsed, collapsibleGroups, collapsedGroupsKey]);

  const pinnedSet = useMemo(
    () => new Set(pinnedIds ?? []),
    [pinnedIds],
  );

  // If value doesn't match any option (e.g. model override persisted but
  // options list was rebuilt), show the value itself instead of falling back
  // to options[0] — which would display a wrong label.
  const selected =
    options.find((o) => o.id === value) ??
    (value ? { id: value, label: value } : options[0]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node) &&
          !submenuRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Reset query and focus search input when the dropdown opens.
  useEffect(() => {
    if (!open) {
      setQuery('');
      setSubmenu(null);
      return;
    }
    setQuery('');
    const id = requestAnimationFrame(() => {
      searchRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !submenu) return;
    const update = () => {
      const rect = submenu.anchor.getBoundingClientRect();
      const width = Math.min(260, window.innerWidth - MENU_VIEWPORT_MARGIN * 2);
      const maxHeight = Math.min(MENU_MAX_HEIGHT, window.innerHeight - MENU_VIEWPORT_MARGIN * 2);
      const height = Math.min(submenuRef.current?.offsetHeight || maxHeight, maxHeight);
      const left = rect.left >= width + MENU_VIEWPORT_MARGIN
        ? rect.left - width
        : Math.min(rect.right, window.innerWidth - width - MENU_VIEWPORT_MARGIN);
      setSubmenuPosition({
        left: Math.max(MENU_VIEWPORT_MARGIN, left),
        top: Math.max(MENU_VIEWPORT_MARGIN, Math.min(rect.bottom - height, window.innerHeight - height - MENU_VIEWPORT_MARGIN)),
        maxHeight,
      });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, submenu]);

  // Filter options by label / hint / group (case-insensitive).
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((opt) => {
      return (
        opt.label.toLowerCase().includes(q) ||
        (opt.hint?.toLowerCase().includes(q) ?? false) ||
        (opt.group?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [options, query]);

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
          variant === 'ghost'
            ? open
              ? 'border-transparent bg-border-soft/70 text-fg'
              : 'border-transparent bg-transparent text-fg-dim hover:bg-border-soft/55 hover:text-fg'
            : open
              ? 'border-accent bg-border-soft text-fg'
              : 'border-border bg-panel-2 text-fg-dim hover:border-accent hover:text-fg',
          disabled && 'cursor-not-allowed opacity-50 hover:border-border hover:text-fg-dim',
        )}
      >
        {icon && <span className="shrink-0 text-fg-faint">{icon}</span>}
        <span className="min-w-0 flex-1 truncate">{selected?.label}</span>
        {showSelectedHint && selected?.hint && (
          <span className="shrink-0 rounded bg-border-soft px-1 py-0.5 text-[10px] text-fg-faint">
            {selected.hint}
          </span>
        )}
        {triggerSuffix && (
          <span className="shrink-0 rounded bg-border-soft px-1 py-0.5 text-[10px] text-fg-faint">
            {triggerSuffix}
          </span>
        )}
        <span className="shrink-0 text-[9px] text-fg-faint">▾</span>
      </button>

      {open && !disabled && (
        <div
          className={cn(
            'absolute z-50 overflow-hidden rounded-md border border-border bg-panel shadow-lg',
            menuPlacement.vertical === 'up' ? 'bottom-full mb-1' : 'top-full mt-1',
            menuPlacement.horizontal === 'left' ? 'left-0' : 'right-0',
          )}
          // `width: max-content` 让菜单按内容定宽而不是被包含块（输入卡片）
          // 卡住，再由 maxWidth 夹到视口内；两者配合才能既显示完整说明、
          // 又不越出窗口。窄于触发器时用实测宽度兜底，避免菜单抖动。
          style={{
            width: 'max-content',
            minWidth: menuPlacement.minWidth,
            maxWidth: menuPlacement.maxWidth,
            maxHeight: menuPlacement.maxHeight,
          }}
          role="presentation"
        >
          {/* Search input — auto-focused when the menu opens. */}
          <div className="border-b border-border-soft px-2.5 py-1.5">
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const first = filtered[0];
                  if (first) {
                    const anchor = rootRef.current?.querySelector<HTMLElement>('[role="option"]');
                    if (anchor && getSubOptions?.(first.id).length && onSubChange) {
                      setSubmenu({ id: first.id, anchor });
                    } else {
                      onChange(first.id);
                      setOpen(false);
                    }
                  }
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setOpen(false);
                }
              }}
              placeholder={isZh ? '输入以筛选…' : 'Type to filter…'}
              autoComplete="off"
              spellCheck={false}
              className="w-full bg-transparent text-xs text-fg outline-none placeholder:text-fg-faint"
            />
          </div>
          {/* Options list */}
          <ul
            className="overflow-y-auto py-1"
            style={{ maxHeight: menuPlacement.maxListHeight }}
            role="listbox"
          >
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-xs text-fg-faint">
                {isZh ? '无匹配结果' : 'No matches'}
              </li>
            ) : (
              filtered.map((opt, index) => {
                const active = opt.id === selected?.id;
                const showGroupHeader =
                  !opt.action &&
                  !!opt.group &&
                  opt.group !== filtered[index - 1]?.group;
                const hasQuery = !!query.trim();
                const groupCollapsed =
                  collapsibleGroups &&
                  !hasQuery &&
                  !!opt.group &&
                  collapsed.has(opt.group);
                // 折叠组内非首项：不渲染（组头只渲染一次，点击组头展开）。
                if (groupCollapsed && !showGroupHeader) return null;
                const isPinned = pinnedSet.has(opt.id);
                const hasSubmenu = !!onSubChange && !!getSubOptions?.(opt.id).length;
                return (
                  <Fragment key={opt.id}>
                    {showGroupHeader &&
                      (collapsibleGroups ? (
                        <li role="presentation">
                          <button
                            type="button"
                            onClick={() =>
                              setCollapsed((prev) => {
                                const next = new Set(prev);
                                if (opt.group && next.has(opt.group))
                                  next.delete(opt.group);
                                else if (opt.group) next.add(opt.group);
                                return next;
                              })
                            }
                            className={cn(
                              'flex w-full items-center gap-1.5 px-3 pb-1 pt-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-fg-faint hover:text-fg-dim',
                              index > 0 && 'border-t border-border-soft',
                            )}
                          >
                            <span className="shrink-0 text-[11px] leading-none">
                              {groupCollapsed ? '▸' : '▾'}
                            </span>
                            <span className="flex-1 truncate">{opt.group}</span>
                            {groupCollapsed && (
                              <span className="shrink-0 text-[11px] text-fg-faint/70">
                                {
                                  filtered.filter(
                                    (o) => o.group === opt.group && !o.action,
                                  ).length
                                }
                              </span>
                            )}
                          </button>
                        </li>
                      ) : (
                        <li
                          role="presentation"
                          className={cn(
                            'px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-faint',
                            index > 0 && 'mt-1 border-t border-border-soft',
                          )}
                        >
                          {opt.group}
                        </li>
                      ))}
                    {groupCollapsed ? null : (
                      <li>
                        <button
                          type="button"
                          role="option"
                          aria-selected={active}
                          aria-haspopup={hasSubmenu ? 'menu' : undefined}
                          aria-expanded={hasSubmenu ? submenu?.id === opt.id : undefined}
                          onMouseEnter={(event) => {
                            if (hasSubmenu) setSubmenu({ id: opt.id, anchor: event.currentTarget });
                            else setSubmenu(null);
                          }}
                          onClick={(event) => {
                            if (hasSubmenu) setSubmenu({ id: opt.id, anchor: event.currentTarget });
                            else {
                              onChange(opt.id);
                              setOpen(false);
                            }
                          }}
                          onKeyDown={(event) => {
                            if (hasSubmenu && event.key === 'ArrowRight') {
                              event.preventDefault();
                              setSubmenu({ id: opt.id, anchor: event.currentTarget });
                              requestAnimationFrame(() => submenuRef.current?.querySelector<HTMLButtonElement>('button')?.focus());
                            }
                          }}
                          className={cn(
                            'flex w-full items-center gap-2 whitespace-nowrap px-3 py-1.5 text-left text-xs transition-colors',
                            opt.action
                              ? 'border-b border-border-soft text-accent hover:bg-accent/10 hover:text-accent'
                              : active
                                ? 'bg-border-soft text-fg'
                                : 'text-fg-dim hover:bg-border-soft hover:text-fg',
                          )}
                        >
                          <span
                            className={cn(
                              'text-[10px] leading-none',
                              opt.action
                                ? 'text-accent'
                                : active
                                  ? 'text-accent'
                                  : 'text-transparent',
                            )}
                          >
                            {opt.action ? '+' : '●'}
                          </span>
                          <span className="min-w-0 flex-1 truncate">{opt.label}</span>
                          {opt.hint && (
                            <span className="max-w-[60%] shrink-0 truncate text-[10px] text-fg-faint">
                              {opt.hint}
                            </span>
                          )}
                          {hasSubmenu && active && triggerSuffix && (
                            <span className="shrink-0 rounded bg-border-soft px-1 text-[10px] text-fg-faint">
                              {triggerSuffix}
                            </span>
                          )}
                          {hasSubmenu && <span className="shrink-0 text-fg-faint">›</span>}
                          {pinnable && onTogglePin && (
                            <span
                              role="button"
                              tabIndex={-1}
                              aria-label={
                                isPinned
                                  ? isZh
                                    ? '取消置顶'
                                    : 'Unpin'
                                  : isZh
                                    ? '置顶到组首'
                                    : 'Pin to top'
                              }
                              title={
                                isPinned
                                  ? isZh
                                    ? '取消置顶'
                                    : 'Unpin'
                                  : isZh
                                    ? '置顶到组首'
                                    : 'Pin to top'
                              }
                              onClick={(e) => {
                                e.stopPropagation();
                                e.preventDefault();
                                onTogglePin(opt.id);
                              }}
                              className={cn(
                                'shrink-0 text-[11px] leading-none',
                                isPinned
                                  ? 'text-accent'
                                  : 'text-fg-faint hover:text-fg',
                              )}
                            >
                              {isPinned ? '📌' : '◯'}
                            </span>
                          )}
                        </button>
                      </li>
                    )}
                  </Fragment>
                );
              })
            )}
          </ul>
        </div>
      )}
      {open && !disabled && submenu && getSubOptions && onSubChange && createPortal(
        <div
          ref={submenuRef}
          role="menu"
          aria-label={subTitle}
          className="fixed z-[1000] overflow-y-auto rounded-md border border-border bg-panel py-1 shadow-lg"
          style={{ ...submenuPosition, width: Math.min(260, window.innerWidth - MENU_VIEWPORT_MARGIN * 2) }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' || event.key === 'ArrowLeft') {
              event.preventDefault();
              submenu.anchor.focus();
              setSubmenu(null);
            }
          }}
        >
          {subTitle && <div className="px-3 pb-1 pt-1 text-[11px] text-fg-faint">{subTitle}</div>}
          {getSubOptions(submenu.id).map((option) => (
            <button
              key={option.id}
              type="button"
              role="menuitemradio"
              aria-checked={submenu.id === value && option.id === subValue}
              onClick={() => {
                onSubChange(submenu.id, option.id);
                setOpen(false);
              }}
              className="flex w-full items-start gap-2 px-3 py-1.5 text-left text-xs text-fg-dim hover:bg-border-soft hover:text-fg"
            >
              <span className="min-w-0 flex-1">
                <span className="block">{option.label}</span>
                {option.hint && <span className="mt-0.5 block whitespace-normal text-[10px] text-fg-faint">{option.hint}</span>}
              </span>
              {submenu.id === value && option.id === subValue && <span className="text-accent">✓</span>}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
