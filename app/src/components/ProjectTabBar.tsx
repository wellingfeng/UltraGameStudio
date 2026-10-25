import { useCallback, useMemo, useState } from 'react';
import {
  Cloud,
  Folder,
  FolderPlus,
  // Plus, // 云端项目入口已退役。
  Settings as SettingsIcon,
} from 'lucide-react';
// import RemoteWorkspaceDialog from '@/components/RemoteWorkspaceDialog';
import { isSupportedWorkspacePath } from '@/lib/cloudProjects';
import { cn } from '@/lib/cn';
import { pickFolder } from '@/lib/folderPicker';
import { t } from '@/lib/i18n';
// import type { Locale } from '@/lib/i18n';
import {
  isRemoteWorkspacePath,
} from '@/lib/remoteWorkspace';
import { workspacePathKey } from '@/lib/workspaceHistory';
import ProjectSettingsModal from '@/panels/ProjectSettingsModal';
// import { historyStore } from '@/store/history/store';
import type { WorkspaceSummary } from '@/store/history/types';
import { useStore } from '@/store/useStore';

export default function ProjectTabBar() {
  const locale = useStore((s) => s.locale);
  const workspaces = useStore((s) => s.workspaces);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const selectedWorkspaceId = useStore((s) => s.selectedWorkspaceId);
  const setWorkspace = useStore((s) => s.setWorkspace);
  const [projectSettingsWorkspace, setProjectSettingsWorkspace] =
    useState<WorkspaceSummary | null>(null);
  // 云端项目已退役：保留原代码，不再执行。
  //   const [remoteDialog, setRemoteDialog] = useState<{
  //     existing: RemoteWorkspaceConfig | null;
  //   } | null>(null);

  const supportedWorkspaces = useMemo(
    () => workspaces.filter((workspace) => isSupportedWorkspacePath(workspace.path)),
    [workspaces],
  );
  const currentWorkspaceId = selectedWorkspaceId ?? activeWorkspaceId;
  const currentWorkspace = useMemo(
    () =>
      currentWorkspaceId
        ? supportedWorkspaces.find((workspace) => workspace.id === currentWorkspaceId) ??
          null
        : null,
    [currentWorkspaceId, supportedWorkspaces],
  );

  const handleBrowseLocalWorkspace = useCallback(async () => {
    const path = await pickFolder(t(locale, 'workspace.chooseFolder'));
    if (!path) return;
    const key = workspacePathKey(path);
    const existing = useStore
      .getState()
      .workspaces.find(
        (workspace) =>
          workspace.path && workspacePathKey(workspace.path) === key,
      );
    if (existing) {
      window.alert(
        t(locale, 'workspaceList.alreadyExists').replace(
          '{name}',
          existing.name,
        ),
      );
    }
    setWorkspace(path);
  }, [locale, setWorkspace]);

  // 云端项目已退役：保留原代码，不再执行。
  //   const handleOpenRemoteDialog = useCallback((existingPath?: string) => {
  //     const id = existingPath ? remoteWorkspaceIdFromPath(existingPath) : '';
  //     setRemoteDialog({ existing: id ? getRemoteWorkspace(id) : null });
  //   }, []);
  //
  //   const handleRemoteSaved = useCallback(
  //     (remotePath: string, config: RemoteWorkspaceConfig) => {
  //       setWorkspace(remotePath);
  //       void historyStore
  //         .resolveWorkspaceByPath(remotePath)
  //         .then((ws) => historyStore.renameWorkspace(ws.id, config.label))
  //         .catch(() => {
  //           /* naming is best-effort */
  //         });
  //     },
  //     [setWorkspace],
  //   );

  const handleProjectWorkspaceUpdated = useCallback(
    (updated: WorkspaceSummary) => {
      setProjectSettingsWorkspace((current) =>
        current?.id === updated.id ? updated : current,
      );
    },
    [],
  );

  return (
    <div className="flex h-10 shrink-0 items-center border-b border-border bg-panel text-xs">
      <div
        role="tablist"
        aria-label={t(locale, 'projectTabs.ariaLabel')}
        className="flex min-w-0 flex-1 overflow-x-auto overflow-y-hidden"
      >
        {supportedWorkspaces.length === 0 ? (
          <div className="flex h-10 items-center px-3 text-fg-faint">
            {t(locale, 'projectTabs.empty')}
          </div>
        ) : (
          supportedWorkspaces.map((workspace) => {
            const active = workspace.id === currentWorkspaceId;
            const remote = isRemoteWorkspacePath(workspace.path);
            return (
              <button
                key={workspace.id}
                type="button"
                role="tab"
                aria-selected={active}
                title={workspace.path || workspace.name}
                disabled={!workspace.path}
                onClick={() => {
                  if (workspace.path) setWorkspace(workspace.path);
                }}
                className={cn(
                  'flex h-10 max-w-[220px] shrink-0 items-center gap-2 border-r border-border-soft px-3 text-left transition-colors',
                  active
                    ? 'bg-bg text-fg shadow-[inset_0_-2px_0_var(--accent)]'
                    : 'text-fg-dim hover:bg-panel-2/60 hover:text-fg',
                  'disabled:cursor-not-allowed disabled:opacity-45',
                )}
              >
                {remote ? (
                  <Cloud
                    size={13}
                    className={active ? 'text-accent-2' : 'text-fg-faint'}
                    aria-hidden="true"
                  />
                ) : (
                  <Folder
                    size={13}
                    className={active ? 'text-accent' : 'text-fg-faint'}
                    aria-hidden="true"
                  />
                )}
                <span className="min-w-0 flex-1 truncate font-medium">
                  {workspace.name}
                </span>
              </button>
            );
          })
        )}
      </div>

      <div className="flex h-full shrink-0 items-center border-l border-border-soft bg-panel">
        <button
          type="button"
          onClick={() => {
            void handleBrowseLocalWorkspace();
          }}
          title={t(locale, 'projectTabs.addLocal')}
          aria-label={t(locale, 'projectTabs.addLocal')}
          className="flex h-10 w-10 items-center justify-center text-fg-faint transition-colors hover:bg-panel-2 hover:text-fg"
        >
          <FolderPlus size={15} aria-hidden="true" />
        </button>
        {/* 云端项目已退役：保留原入口代码，不再挂载。
        <button
          type="button"
          onClick={() => handleOpenRemoteDialog()}
          title={t(locale, 'projectTabs.addRemote')}
          aria-label={t(locale, 'projectTabs.addRemote')}
          className="flex h-10 w-10 items-center justify-center text-fg-faint transition-colors hover:bg-panel-2 hover:text-fg"
        >
          <Plus size={15} aria-hidden="true" />
        </button>
        */}
        <button
          type="button"
          disabled={!currentWorkspace}
          onClick={() => {
            if (currentWorkspace) setProjectSettingsWorkspace(currentWorkspace);
          }}
          title={t(locale, 'projectTabs.projectSettings')}
          aria-label={t(locale, 'projectTabs.projectSettings')}
          className="flex h-10 w-10 items-center justify-center text-fg-faint transition-colors hover:bg-panel-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-35"
        >
          <SettingsIcon size={15} aria-hidden="true" />
        </button>
      </div>

      {projectSettingsWorkspace && (
        <ProjectSettingsModal
          workspace={projectSettingsWorkspace}
          onWorkspaceUpdated={handleProjectWorkspaceUpdated}
          onClose={() => setProjectSettingsWorkspace(null)}
        />
      )}

      {/* 云端项目已退役：保留原入口代码，不再挂载。
      {remoteDialog && (
        <RemoteWorkspaceDialog
          locale={locale as Locale}
          existing={remoteDialog.existing}
          onClose={() => setRemoteDialog(null)}
          onSaved={handleRemoteSaved}
        />
      )}
      */}
    </div>
  );
}
