import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Cloud, FolderPlus, Layers } from 'lucide-react';
import RemoteWorkspaceStatusBadge from '@/components/RemoteWorkspaceStatusBadge';
import { cn } from '@/lib/cn';
import { isSupportedWorkspacePath } from '@/lib/cloudProjects';
import { t } from '@/lib/i18n';
import type { Locale } from '@/lib/i18n';
import { isRemoteWorkspacePath } from '@/lib/remoteWorkspace';
import type { RemoteWorkspaceConnectionState } from '@/lib/remoteWorkspaceStatus';
import { workspacePathKey } from '@/lib/workspaceHistory';
import type { WorkspaceSummary } from '@/store/history/types';

/**
 * Top-left workspace switcher.
 *
 * Lists every known workspace and lets the user jump to one (which activates
 * that workspace's first session). A "浏览本地…" action opens the native folder
 * picker to add a new workspace; selecting an already-known folder just
 * switches to it via {@link onBrowseLocal}. Cloud projects are retired.
 */
export interface WorkspaceListSelectProps {
  workspaces: WorkspaceSummary[];
  activeWorkspaceId: string | null;
  locale: Locale;
  /** Switch to an existing workspace by its path. */
  onSelect: (path: string) => void;
  /** Open the folder picker to add (or re-select) a workspace. */
  onBrowseLocal: () => void;
  /** Open the cloud-project dialog (create, or edit an existing one). */
  onAddRemote?: (existingPath?: string) => void;
  remoteConnectionStates?: Record<string, RemoteWorkspaceConnectionState>;
  disabled?: boolean;
}

export default function WorkspaceListSelect({
  workspaces,
  activeWorkspaceId,
  locale,
  onSelect,
  onBrowseLocal,
  // onAddRemote, // 云端项目已退役。
  remoteConnectionStates = {},
  disabled = false,
}: WorkspaceListSelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (disabled) {
      setOpen(false);
      return;
    }
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [disabled, open]);

  const supportedWorkspaces = workspaces.filter((w) => isSupportedWorkspacePath(w.path));
  const active = supportedWorkspaces.find((w) => w.id === activeWorkspaceId) ?? null;
  const label = active?.name ?? t(locale, 'workspaceList.title');
  const activeKey = active?.path ? workspacePathKey(active.path) : '';
  const activeIsRemote = isRemoteWorkspacePath(active?.path ?? '');

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={t(locale, 'workspaceList.open')}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors',
          open
            ? 'border-accent bg-panel-2 text-fg'
            : 'border-border-soft bg-panel text-fg-dim hover:border-border hover:bg-panel-2/60 hover:text-fg',
          'disabled:cursor-not-allowed disabled:opacity-40',
        )}
      >
        <Layers size={13} className="shrink-0 text-fg-faint" />
        <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
        {active && activeIsRemote && (
          <RemoteWorkspaceStatusBadge
            state={remoteConnectionStates[active.id]}
            locale={locale}
            className="max-w-[5.75rem]"
          />
        )}
        <ChevronDown size={12} className="shrink-0 text-fg-faint" />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-40 mt-1 overflow-hidden rounded-md border border-border bg-panel py-1 shadow-2xl">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onBrowseLocal();
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-fg transition-colors hover:bg-border-soft"
          >
            <FolderPlus size={13} className="shrink-0 text-accent" />
            <span>{t(locale, 'workspaceList.browseLocal')}</span>
          </button>
          {/* 云端项目已退役：保留原入口代码，不再挂载。
          {onAddRemote && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onAddRemote();
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-fg transition-colors hover:bg-border-soft"
            >
              <Cloud size={13} className="shrink-0 text-accent-2" />
              <span>{t(locale, 'workspaceList.addRemote')}</span>
            </button>
          )}
          */}

          <div className="my-1 border-t border-border-soft" />
          <div className="px-3 pb-0.5 text-[10px] uppercase tracking-wider text-fg-faint">
            {t(locale, 'workspaceList.title')}
          </div>

          {supportedWorkspaces.length === 0 ? (
            <div className="px-3 py-1.5 text-xs text-fg-faint">
              {t(locale, 'workspaceList.empty')}
            </div>
          ) : (
            <ul role="listbox" className="max-h-[18rem] overflow-y-auto">
              {supportedWorkspaces.map((workspace) => {
                const isActive =
                  workspace.id === activeWorkspaceId ||
                  (activeKey !== '' &&
                    workspace.path !== '' &&
                    workspacePathKey(workspace.path) === activeKey);
                const isRemote = isRemoteWorkspacePath(workspace.path);
                return (
                  <li key={workspace.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      title={workspace.path || workspace.name}
                      onClick={() => {
                        setOpen(false);
                        if (workspace.path) onSelect(workspace.path);
                      }}
                      className={cn(
                        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors',
                        isActive
                          ? 'bg-border-soft text-fg'
                          : 'text-fg-dim hover:bg-border-soft hover:text-fg',
                      )}
                    >
                      {isRemote ? (
                        <Cloud
                          size={12}
                          className={cn(
                            'shrink-0',
                            isActive ? 'text-accent-2' : 'text-fg-faint',
                          )}
                        />
                      ) : (
                        <Check
                          size={12}
                          className={cn(
                            'shrink-0',
                            isActive ? 'text-accent' : 'text-transparent',
                          )}
                        />
                      )}
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-medium">
                          {workspace.name}
                        </span>
                        {workspace.path && !isRemote && (
                          <span className="truncate font-mono text-[9px] text-fg-faint">
                            {workspace.path}
                          </span>
                        )}
                      </span>
                      {isRemote && (
                        <RemoteWorkspaceStatusBadge
                          state={remoteConnectionStates[workspace.id]}
                          locale={locale}
                        />
                      )}
                      {isActive && (
                        <span className="shrink-0 rounded border border-border-soft px-1 py-0.5 text-[9px] leading-none text-fg-faint">
                          {t(locale, 'workspaceList.current')}
                        </span>
                      )}
                      {/* 云端项目已退役：保留原入口代码，不再挂载。
                      {isRemote && onAddRemote && (
                        <span
                          role="button"
                          tabIndex={0}
                          title={t(locale, 'remoteWorkspace.title')}
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpen(false);
                            onAddRemote(workspace.path);
                          }}
                          className="shrink-0 rounded p-0.5 text-fg-faint hover:bg-border hover:text-fg"
                        >
                          ⚙
                        </span>
                      )}
                      */}
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
