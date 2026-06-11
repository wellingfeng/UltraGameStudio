import {
  useState,
  useCallback,
  useEffect,
  useMemo,
} from 'react';
import {
  AlarmClock,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  MoreHorizontal,
  Pencil,
  Search,
  Settings as SettingsGlyph,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import StatusIndicator, { type StatusTone } from '@/components/StatusIndicator';
import WorkspaceListSelect from '@/components/WorkspaceListSelect';
import { cn } from '@/lib/cn';
import { pickFolder } from '@/lib/folderPicker';
import { workspacePathKey } from '@/lib/workspaceHistory';
import {
  sessionLiveStatus,
  useStore,
  workflowDeleteProtectionReason,
  workflowSessionKeyId,
  type WorkflowDeleteProtectionReason,
  type WorkflowSessionKey,
} from '@/store/useStore';
import type { ScheduledTaskConfig, Session } from '@/store/types';
import type { WorkspaceSummary } from '@/store/history/types';
import type { Locale } from '@/lib/i18n';
import { projectHealth, type ProjectHealthTone } from '@/lib/projectSettings';
import {
  openWorkspaceDirectory,
  scanProjectEnvironment,
  type ProjectEnvironmentScan,
} from '@/lib/tauri';
import { useResizableWidth } from '@/lib/useResizableWidth';
import { t } from '@/lib/i18n';
import SettingsModal from './SettingsModal';
import ProjectSettingsModal from './ProjectSettingsModal';
import ScheduledTaskDialog from './ScheduledTaskDialog';

/**
 * CONTRACT: default export, no props. Left session rail.
 *
 * Top  : primary action — "+ New Session".
 * Bottom: session history list, sourced from the store; clicking switches the
 *         active session context.
 *
 * Mirrors design.html §06 "Left · 会话栏".
 */

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes(),
  ).padStart(2, '0')}`;
  if (sameDay) return hhmm;
  return `${d.getMonth() + 1}/${d.getDate()} ${hhmm}`;
}

const WORKFLOW_HISTORY_PAGE_SIZE = 5;
const MAX_SESSION_RENAME_LENGTH = 80;
type SidebarTab = 'history' | 'favorites';
type SidebarLiveState = {
  runningSessions: WorkflowSessionKey[];
  aiEditingSessions: WorkflowSessionKey[];
  chattingSessions: WorkflowSessionKey[];
};
type ProjectScanCacheEntry = {
  path: string;
  scan: ProjectEnvironmentScan | null;
};

function sessionSortTimestamp(session: Session): number {
  return session.updatedAt ?? session.createdAt;
}

function sessionLiveRank(
  session: Session,
  workspaceId: string | null,
  liveState: SidebarLiveState,
): number {
  const liveStatus = sessionLiveStatus(
    { workspaceId, sessionId: session.id },
    liveState,
  );
  if (liveStatus === 'running') return 0;
  if (liveStatus === 'aiEditing') return 1;
  return 2;
}

function sortHistorySessions(
  sessions: Session[],
  workspaceId: string | null,
  liveState: SidebarLiveState,
): Session[] {
  return [...sessions].sort((a, b) => {
    const liveDiff =
      sessionLiveRank(a, workspaceId, liveState) -
      sessionLiveRank(b, workspaceId, liveState);
    if (liveDiff !== 0) return liveDiff;
    return sessionSortTimestamp(b) - sessionSortTimestamp(a);
  });
}

function workspaceLiveRank(
  sessions: Session[],
  workspaceId: string,
  liveState: SidebarLiveState,
): number {
  return sessions.reduce(
    (best, session) =>
      Math.min(best, sessionLiveRank(session, workspaceId, liveState)),
    2,
  );
}

function clampPercent(percent: number | null | undefined): number | null {
  if (percent == null || !Number.isFinite(percent)) return null;
  return Math.min(100, Math.max(0, Math.round(percent)));
}

function runningProgressLabel(
  locale: Locale,
  percent: number | null | undefined,
): string {
  const clamped = clampPercent(percent);
  if (clamped == null) {
    return locale === 'en-US'
      ? 'Running, progress unknown'
      : '正在运行，进度未知';
  }
  return locale === 'en-US'
    ? `Running, progress ${clamped}%`
    : `正在运行，进度 ${clamped}%`;
}

function historyStatusLabel(
  locale: Locale,
  status: StatusTone | null,
  percent: number | null | undefined,
): string | undefined {
  if (!status) return undefined;
  if (status === 'running') return runningProgressLabel(locale, percent);
  if (status === 'thinking') return t(locale, 'sidebar.thinking');
  if (status === 'unrun') return t(locale, 'sidebar.unrun');
  if (status === 'success') return t(locale, 'sidebar.completed');
  return t(locale, 'sidebar.failed');
}

function historyStatusTone(
  session: Pick<Session, 'isWorkflow' | 'simple' | 'runStatus'>,
  liveStatus: ReturnType<typeof sessionLiveStatus>,
): StatusTone | null {
  if (liveStatus === 'running') return 'running';
  if (liveStatus === 'aiEditing') return 'thinking';
  if (session.runStatus === 'success') return 'success';
  if (
    session.runStatus === 'error' ||
    session.runStatus === 'interrupted'
  ) {
    return 'failed';
  }
  return session.isWorkflow && !session.simple ? 'unrun' : null;
}

function projectStatusClassName(tone: ProjectHealthTone): string {
  if (tone === 'connected') return 'bg-emerald-400 shadow-[0_0_0_2px_rgba(52,211,153,0.16)]';
  if (tone === 'failed') return 'bg-red-400 shadow-[0_0_0_2px_rgba(248,113,113,0.16)]';
  if (tone === 'configured') return 'bg-amber-400 shadow-[0_0_0_2px_rgba(251,191,36,0.16)]';
  if (tone === 'detected') return 'bg-sky-400 shadow-[0_0_0_2px_rgba(56,189,248,0.16)]';
  return 'bg-fg-faint/40';
}

function deleteProtectionLabel(
  locale: Locale,
  reason: WorkflowDeleteProtectionReason,
): string | null {
  if (reason === 'running') return t(locale, 'sidebar.deleteBlockedRunning');
  if (reason === 'aiEditing') return t(locale, 'sidebar.deleteBlockedAiEditing');
  return null;
}

function historySessionForProtection(
  sessionId: string,
  workspaceId: string | null,
  sessions: Session[],
  sessionTree: Record<string, Session[]>,
  fallbackIsWorkflow: boolean,
): Pick<Session, 'id' | 'isWorkflow'> {
  const source = workspaceId ? sessionTree[workspaceId] ?? sessions : sessions;
  return (
    source.find((session) => session.id === sessionId) ?? {
      id: sessionId,
      isWorkflow: fallbackIsWorkflow,
    }
  );
}

function sessionMatchesSearch(
  session: Session,
  workspace: Pick<WorkspaceSummary, 'name' | 'path'> | undefined,
  query: string,
): boolean {
  if (!query) return true;

  return [session.title, session.preview, workspace?.name, workspace?.path].some(
    (value) => value?.toLowerCase().includes(query) ?? false,
  );
}

function sessionVisibleInTab(session: Session, tab: SidebarTab): boolean {
  return tab === 'history' || session.favorite === true;
}

function historySessionRowClassName(active: boolean): string {
  return (
    'group flex w-full flex-col items-start gap-0.5 rounded-md border px-2 py-1.5 text-left transition-colors ' +
    (active
      ? 'border-border bg-panel-2 text-fg shadow-[inset_2px_0_0_var(--accent)]'
      : 'border-transparent bg-transparent text-fg-dim hover:border-border-soft hover:bg-panel-2/45 hover:text-fg') +
    ' disabled:cursor-not-allowed disabled:opacity-50'
  );
}

function historySessionEditRowClassName(active: boolean): string {
  return (
    'group flex w-full flex-col items-start gap-1 rounded-md border px-2 py-1.5 text-left transition-colors ' +
    (active
      ? 'border-border bg-panel-2 text-fg shadow-[inset_2px_0_0_var(--accent)]'
      : 'border-transparent bg-transparent text-fg-dim hover:border-border-soft hover:bg-panel-2/45 hover:text-fg')
  );
}

function FavoriteMarker({
  favorite,
  locale,
}: {
  favorite: boolean;
  locale: Locale;
}) {
  if (!favorite) return null;
  return (
    <Star
      size={12}
      aria-label={t(locale, 'sidebar.favoriteBadge')}
      className="shrink-0 fill-accent text-accent"
    />
  );
}

function ScheduledTaskMarker({
  scheduledTask,
  locale,
}: {
  scheduledTask?: ScheduledTaskConfig;
  locale: Locale;
}) {
  if (!scheduledTask?.enabled) return null;
  return (
    <AlarmClock
      size={12}
      aria-label={t(locale, 'sidebar.scheduleBadge')}
      className="shrink-0 text-accent-2"
    />
  );
}

export default function Sidebar() {
  const locale = useStore((s) => s.locale);
  const sessions = useStore((s) => s.sessions);
  const historyReady = useStore((s) => s.historyReady);
  const historyError = useStore((s) => s.historyError);
  const workspaces = useStore((s) => s.workspaces);
  const sessionTree = useStore((s) => s.sessionTree);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const selectedWorkspaceIdRaw = useStore((s) => s.selectedWorkspaceId);
  // The top switcher and workspace ordering follow an explicit, navigation-only
  // selection that does NOT change when the user opens a session in another
  // workspace. Fall back to the active workspace before history init populates it.
  const selectedWorkspaceId = selectedWorkspaceIdRaw ?? activeWorkspaceId;
  const activeSessionId = useStore((s) => s.activeSessionId);
  const runningSessions = useStore((s) => s.runningSessions);
  const runningSessionProgress = useStore((s) => s.runningSessionProgress);
  const aiEditingSessions = useStore((s) => s.aiEditingSessions);
  const chattingSessions = useStore((s) => s.chattingSessions);
  const newSession = useStore((s) => s.newSession);
  const setWorkspace = useStore((s) => s.setWorkspace);
  const selectSession = useStore((s) => s.selectSession);
  const deleteSession = useStore((s) => s.deleteSession);
  const deleteWorkspaceHistory = useStore((s) => s.deleteWorkspaceHistory);
  const renameWorkflowSession = useStore((s) => s.renameWorkflowSession);
  const setWorkflowFavoriteSession = useStore(
    (s) => s.setWorkflowFavoriteSession,
  );
  const setWorkflowScheduledTaskSession = useStore(
    (s) => s.setWorkflowScheduledTaskSession,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projectSettingsWorkspace, setProjectSettingsWorkspace] =
    useState<WorkspaceSummary | null>(null);
  const [projectScanCache, setProjectScanCache] = useState<
    Record<string, ProjectScanCacheEntry>
  >({});
  const [workspaceLimits, setWorkspaceLimits] = useState<Record<string, number>>({});
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<
    Record<string, boolean>
  >({});
  const [flatLimit, setFlatLimit] = useState(WORKFLOW_HISTORY_PAGE_SIZE);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<SidebarTab>('history');

  // ── Context menu for session actions ─────────────────────────────────────
  type MenuState =
    | null
    | {
        x: number;
        y: number;
        sessionId: string;
        workspaceId: string | null;
        title: string;
        isWorkflow: boolean;
        simple: boolean;
        favorite: boolean;
        scheduledTask?: ScheduledTaskConfig;
      };
  const [menu, setMenu] = useState<MenuState>(null);
  const [scheduleDialog, setScheduleDialog] = useState<{
    sessionId: string;
    workspaceId: string | null;
    title: string;
    scheduledTask?: ScheduledTaskConfig;
  } | null>(null);
  const [renaming, setRenaming] = useState<{
    sessionId: string;
    workspaceId: string | null;
    originalTitle: string;
  } | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameSaving, setRenameSaving] = useState(false);
  const [workspaceMenu, setWorkspaceMenu] = useState<{
    x: number;
    y: number;
    workspace: WorkspaceSummary;
  } | null>(null);
  const [workspaceRemoveConfirm, setWorkspaceRemoveConfirm] =
    useState<WorkspaceSummary | null>(null);

  const menuDeleteProtectionReason = useMemo(() => {
    if (!menu) return null;
    const targetWorkspaceId = menu.workspaceId ?? activeWorkspaceId ?? null;
    const session = historySessionForProtection(
      menu.sessionId,
      targetWorkspaceId,
      sessions,
      sessionTree,
      menu.isWorkflow,
    );
    return workflowDeleteProtectionReason(session, targetWorkspaceId, {
      runningSessions,
      aiEditingSessions,
      chattingSessions,
    });
  }, [
    activeWorkspaceId,
    aiEditingSessions,
    chattingSessions,
    menu,
    runningSessions,
    sessions,
    sessionTree,
  ]);

  const workspaceMenuDeleteDisabledReason = useMemo(() => {
    if (!workspaceMenu) return null;
    const hasLiveSession = [
      ...runningSessions,
      ...aiEditingSessions,
      ...chattingSessions,
    ].some((sessionKey) => sessionKey.workspaceId === workspaceMenu.workspace.id);
    return hasLiveSession
      ? t(locale, 'sidebar.removeWorkspaceHistoryBlocked')
      : null;
  }, [
    aiEditingSessions,
    chattingSessions,
    locale,
    runningSessions,
    workspaceMenu,
  ]);

  const onSessionContextMenu = useCallback(
    (
      event: React.MouseEvent,
      sessionId: string,
      workspaceId: string | null,
      title: string,
      isWorkflow: boolean,
      simple: boolean,
      favorite: boolean,
      scheduledTask?: ScheduledTaskConfig,
    ) => {
      event.preventDefault();
      event.stopPropagation();
      const aside = event.currentTarget.closest('aside');
      if (!aside) return;
      const rect = aside.getBoundingClientRect();
      setWorkspaceMenu(null);
      setMenu({
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        sessionId,
        workspaceId,
        title,
        isWorkflow,
        simple,
        favorite,
        scheduledTask,
      });
    },
    [],
  );

  const openWorkspaceMenu = useCallback(
    (event: React.MouseEvent, workspace: WorkspaceSummary) => {
      const aside = event.currentTarget.closest('aside');
      if (!aside) return;
      const rect = aside.getBoundingClientRect();
      setMenu(null);
      setWorkspaceMenu({
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        workspace,
      });
    },
    [],
  );

  const onWorkspaceContextMenu = useCallback(
    (event: React.MouseEvent, workspace: WorkspaceSummary) => {
      event.preventDefault();
      event.stopPropagation();
      openWorkspaceMenu(event, workspace);
    },
    [openWorkspaceMenu],
  );

  const onWorkspaceMoreClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>, workspace: WorkspaceSummary) => {
      event.preventDefault();
      event.stopPropagation();
      openWorkspaceMenu(event, workspace);
    },
    [openWorkspaceMenu],
  );

  const handleOpenWorkspaceDirectory = useCallback(() => {
    if (!workspaceMenu) return;
    const path = workspaceMenu.workspace.path.trim();
    if (!path) {
      setWorkspaceMenu(null);
      return;
    }
    setWorkspaceMenu(null);
    void openWorkspaceDirectory(path).then((opened) => {
      if (!opened && typeof window !== 'undefined') {
        window.alert('当前环境不能打开系统文件浏览器。请使用桌面端。');
      }
    });
  }, [workspaceMenu]);

  const handleOpenWorkspaceSettings = useCallback(() => {
    if (!workspaceMenu) return;
    setProjectSettingsWorkspace(workspaceMenu.workspace);
    setWorkspaceMenu(null);
  }, [workspaceMenu]);

  const handleRemoveWorkspaceHistory = useCallback(() => {
    if (!workspaceMenu) return;
    if (workspaceMenuDeleteDisabledReason) {
      window.alert(workspaceMenuDeleteDisabledReason);
      setWorkspaceMenu(null);
      return;
    }
    const { workspace } = workspaceMenu;
    setWorkspaceMenu(null);
    setWorkspaceRemoveConfirm(workspace);
  }, [workspaceMenu, workspaceMenuDeleteDisabledReason]);

  const handleCancelRemoveWorkspaceHistory = useCallback(() => {
    setWorkspaceRemoveConfirm(null);
  }, []);

  const handleConfirmRemoveWorkspaceHistory = useCallback(() => {
    if (!workspaceRemoveConfirm) return;
    const state = useStore.getState();
    const hasLiveSession = [
      ...state.runningSessions,
      ...state.aiEditingSessions,
      ...state.chattingSessions,
    ].some((sessionKey) => sessionKey.workspaceId === workspaceRemoveConfirm.id);
    if (hasLiveSession) {
      window.alert(t(locale, 'sidebar.removeWorkspaceHistoryBlocked'));
      setWorkspaceRemoveConfirm(null);
      return;
    }
    deleteWorkspaceHistory(workspaceRemoveConfirm.id);
    setWorkspaceRemoveConfirm(null);
  }, [deleteWorkspaceHistory, locale, workspaceRemoveConfirm]);

  const handleDelete = useCallback(() => {
    if (!menu) return;
    const targetSessionId = menu.sessionId;
    const targetWorkspaceMenuId = menu.workspaceId;
    const targetTitle = menu.title;
    const targetIsWorkflow = menu.isWorkflow;
    const state = useStore.getState();
    const targetWorkspaceId =
      targetWorkspaceMenuId ?? state.activeWorkspaceId ?? null;
    const session = historySessionForProtection(
      targetSessionId,
      targetWorkspaceId,
      state.sessions,
      state.sessionTree,
      targetIsWorkflow,
    );
    const protectionReason = workflowDeleteProtectionReason(
      session,
      targetWorkspaceId,
      state,
    );
    const protectionMessage = deleteProtectionLabel(locale, protectionReason);
    if (protectionMessage) {
      window.alert(protectionMessage);
      setMenu(null);
      return;
    }

    const confirmed = window.confirm(
      t(locale, 'sidebar.deleteConfirm').replace('{title}', targetTitle),
    );
    if (confirmed) {
      deleteSession(targetSessionId, targetWorkspaceMenuId ?? undefined);
      if (
        renaming?.sessionId === targetSessionId &&
        renaming.workspaceId === targetWorkspaceMenuId
      ) {
        setRenaming(null);
        setRenameDraft('');
        setRenameError(null);
        setRenameSaving(false);
      }
    }
    setMenu(null);
  }, [menu, locale, deleteSession, renaming]);

  const handleToggleFavorite = useCallback(() => {
    if (!menu) return;
    void setWorkflowFavoriteSession(
      menu.sessionId,
      menu.workspaceId,
      !menu.favorite,
    );
    setMenu(null);
  }, [menu, setWorkflowFavoriteSession]);

  const handleOpenSchedule = useCallback(() => {
    if (!menu?.favorite) return;
    setScheduleDialog({
      sessionId: menu.sessionId,
      workspaceId: menu.workspaceId,
      title: menu.title,
      scheduledTask: menu.scheduledTask,
    });
    setMenu(null);
  }, [menu]);

  const handleSaveSchedule = useCallback(
    async (scheduledTask: ScheduledTaskConfig) => {
      if (!scheduleDialog) return;
      await setWorkflowScheduledTaskSession(
        scheduleDialog.sessionId,
        scheduleDialog.workspaceId,
        scheduledTask,
      );
      setScheduleDialog((current) =>
        current
          ? {
              ...current,
              scheduledTask,
            }
          : current,
      );
    },
    [scheduleDialog, setWorkflowScheduledTaskSession],
  );

  const handleDeleteSchedule = useCallback(async () => {
    if (!scheduleDialog) return;
    await setWorkflowScheduledTaskSession(
      scheduleDialog.sessionId,
      scheduleDialog.workspaceId,
      null,
    );
    setScheduleDialog((current) =>
      current ? { ...current, scheduledTask: undefined } : current,
    );
  }, [scheduleDialog, setWorkflowScheduledTaskSession]);

  const handleStartRename = useCallback(() => {
    if (!menu) return;
    setRenaming({
      sessionId: menu.sessionId,
      workspaceId: menu.workspaceId,
      originalTitle: menu.title,
    });
    setRenameDraft(menu.title);
    setRenameError(null);
    setRenameSaving(false);
    setMenu(null);
  }, [menu]);

  const cancelRename = useCallback(() => {
    if (renameSaving) return;
    setRenaming(null);
    setRenameDraft('');
    setRenameError(null);
  }, [renameSaving]);

  const saveRename = useCallback(
    async (
      session: Session,
      workspaceId: string | null,
      siblingSessions: Session[],
    ) => {
      if (
        !renaming ||
        renameSaving ||
        renaming.sessionId !== session.id ||
        renaming.workspaceId !== workspaceId
      ) {
        return;
      }

      const trimmed = renameDraft.trim();
      if (!trimmed) {
        setRenameError(t(locale, 'sidebar.renameErrorEmpty'));
        return;
      }
      if (trimmed.length > MAX_SESSION_RENAME_LENGTH) {
        setRenameError(t(locale, 'sidebar.renameErrorTooLong'));
        return;
      }
      if (trimmed === renaming.originalTitle.trim()) {
        cancelRename();
        return;
      }
      const duplicate = siblingSessions.some(
        (item) =>
          item.id !== session.id &&
          item.title.trim() === trimmed,
      );
      if (duplicate) {
        setRenameError(t(locale, 'sidebar.renameErrorDuplicate'));
        return;
      }

      setRenameSaving(true);
      setRenameError(null);
      try {
        await renameWorkflowSession(session.id, workspaceId, trimmed);
        setRenaming(null);
        setRenameDraft('');
      } catch {
        setRenameError(t(locale, 'sidebar.renameErrorSave'));
      } finally {
        setRenameSaving(false);
      }
    },
    [
      cancelRename,
      locale,
      renameDraft,
      renameSaving,
      renameWorkflowSession,
      renaming,
    ],
  );

  /** Close the context menu on Escape. */
  useEffect(() => {
    if (!menu && !workspaceMenu && !workspaceRemoveConfirm) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenu(null);
        setWorkspaceMenu(null);
        setWorkspaceRemoveConfirm(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu, workspaceMenu, workspaceRemoveConfirm]);

  useEffect(() => {
    const targets = workspaces.filter((workspace) => {
      const path = workspace.path?.trim();
      if (!path) return false;
      return projectScanCache[workspace.id]?.path !== path;
    });
    if (targets.length === 0) return;

    let cancelled = false;
    setProjectScanCache((prev) => {
      const next = { ...prev };
      for (const workspace of targets) {
        next[workspace.id] = { path: workspace.path.trim(), scan: null };
      }
      return next;
    });
    for (const workspace of targets) {
      const path = workspace.path.trim();
      void scanProjectEnvironment(path)
        .then((scan) => {
          if (cancelled) return;
          setProjectScanCache((prev) => ({
            ...prev,
            [workspace.id]: { path, scan },
          }));
        })
        .catch(() => {
          if (cancelled) return;
          setProjectScanCache((prev) => ({
            ...prev,
            [workspace.id]: { path, scan: null },
          }));
        });
    }

    return () => {
      cancelled = true;
    };
  }, [projectScanCache, workspaces]);

  const handleProjectWorkspaceUpdated = useCallback(
    (updated: WorkspaceSummary) => {
      setProjectSettingsWorkspace((current) =>
        current?.id === updated.id ? updated : current,
      );
    },
    [],
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

  const loadMoreWorkspace = useCallback((workspaceId: string) => {
    setWorkspaceLimits((prev) => ({
      ...prev,
      [workspaceId]:
        (prev[workspaceId] ?? WORKFLOW_HISTORY_PAGE_SIZE) +
        WORKFLOW_HISTORY_PAGE_SIZE,
    }));
  }, []);

  const collapseWorkspace = useCallback((workspaceId: string) => {
    setWorkspaceLimits((prev) => ({
      ...prev,
      [workspaceId]: Math.max(
        WORKFLOW_HISTORY_PAGE_SIZE,
        (prev[workspaceId] ?? WORKFLOW_HISTORY_PAGE_SIZE) -
          WORKFLOW_HISTORY_PAGE_SIZE,
      ),
    }));
  }, []);

  const toggleWorkspaceCollapsed = useCallback((workspaceId: string) => {
    setCollapsedWorkspaces((prev) => ({
      ...prev,
      [workspaceId]: !prev[workspaceId],
    }));
  }, []);

  const loadMoreFlat = useCallback(() => {
    setFlatLimit((prev) => prev + WORKFLOW_HISTORY_PAGE_SIZE);
  }, []);

  const collapseFlat = useCallback(() => {
    setFlatLimit((prev) =>
      Math.max(WORKFLOW_HISTORY_PAGE_SIZE, prev - WORKFLOW_HISTORY_PAGE_SIZE),
    );
  }, []);

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const isSearching = normalizedQuery.length > 0;
  const sidebarLiveState = useMemo(
    () => ({ runningSessions, aiEditingSessions, chattingSessions }),
    [aiEditingSessions, chattingSessions, runningSessions],
  );

  const totalTreeSessions = useMemo(
    () =>
      workspaces.reduce(
        (count, workspace) =>
          count + (sessionTree[workspace.id]?.length ?? 0),
        0,
      ),
    [sessionTree, workspaces],
  );

  const totalFavoriteTreeSessions = useMemo(
    () =>
      workspaces.reduce(
        (count, workspace) =>
          count +
          (sessionTree[workspace.id]?.filter((session) =>
            sessionVisibleInTab(session, 'favorites'),
          ).length ?? 0),
        0,
      ),
    [sessionTree, workspaces],
  );

  const tabFlatSessions = useMemo(
    () =>
      sortHistorySessions(
        sessions.filter((session) => sessionVisibleInTab(session, activeTab)),
        null,
        sidebarLiveState,
      ),
    [activeTab, sessions, sidebarLiveState],
  );

  const hasHistory =
    workspaces.length > 0 ? totalTreeSessions > 0 : sessions.length > 0;
  const hasFavorites =
    workspaces.length > 0
      ? totalFavoriteTreeSessions > 0
      : sessions.some((session) => sessionVisibleInTab(session, 'favorites'));
  const hasActiveTabSessions =
    activeTab === 'favorites' ? hasFavorites : hasHistory;
  const showHistorySearch =
    !historyReady || hasActiveTabSessions || isSearching;
  const isHistoryEmpty = historyReady && !hasHistory;
  const isFavoritesEmpty =
    historyReady && activeTab === 'favorites' && !hasFavorites;
  const isActiveTabEmpty =
    activeTab === 'favorites' ? isFavoritesEmpty : isHistoryEmpty;

  useEffect(() => {
    if (isHistoryEmpty && searchQuery.length > 0) {
      setSearchQuery('');
    }
  }, [isHistoryEmpty, searchQuery.length]);

  const filteredWorkspaces = useMemo(
    () =>
      workspaces
        .map((workspace) => {
          const tabSessions = sortHistorySessions(
            (sessionTree[workspace.id] ?? []).filter((session) =>
              sessionVisibleInTab(session, activeTab),
            ),
            workspace.id,
            sidebarLiveState,
          );
          return {
            workspace,
            tabSessions,
            sessions: normalizedQuery
              ? tabSessions.filter((session) =>
                  sessionMatchesSearch(session, workspace, normalizedQuery),
                )
              : tabSessions,
          };
        })
        .filter((group) => {
          if (normalizedQuery) return group.sessions.length > 0;
          if (activeTab === 'favorites') return group.tabSessions.length > 0;
          return group.tabSessions.length > 0;
        })
        .sort((a, b) => {
          const activeDiff =
            (a.workspace.id === selectedWorkspaceId ? 0 : 1) -
            (b.workspace.id === selectedWorkspaceId ? 0 : 1);
          if (activeDiff !== 0) return activeDiff;
          const liveDiff =
            workspaceLiveRank(a.sessions, a.workspace.id, sidebarLiveState) -
            workspaceLiveRank(b.sessions, b.workspace.id, sidebarLiveState);
          if (liveDiff !== 0) return liveDiff;
          return b.workspace.updatedAt - a.workspace.updatedAt;
        }),
    [
      activeTab,
      selectedWorkspaceId,
      normalizedQuery,
      sessionTree,
      sidebarLiveState,
      workspaces,
    ],
  );

  const filteredFlatSessions = useMemo(
    () =>
      normalizedQuery
        ? tabFlatSessions.filter((session) =>
            sessionMatchesSearch(session, undefined, normalizedQuery),
          )
        : tabFlatSessions,
    [normalizedQuery, tabFlatSessions],
  );

  const totalMatchedSessions =
    workspaces.length > 0
      ? filteredWorkspaces.reduce(
          (count, group) => count + group.sessions.length,
          0,
        )
      : filteredFlatSessions.length;

  const firstSearchMatch = useMemo(() => {
    if (!isSearching) return null;
    if (workspaces.length > 0) {
      const firstGroup = filteredWorkspaces.find(
        (group) => group.sessions.length > 0,
      );
      const firstSession = firstGroup?.sessions[0];
      return firstGroup && firstSession
        ? { sessionId: firstSession.id, workspaceId: firstGroup.workspace.id }
        : null;
    }

    const firstSession = filteredFlatSessions[0];
    return firstSession
      ? { sessionId: firstSession.id, workspaceId: undefined }
      : null;
  }, [filteredFlatSessions, filteredWorkspaces, isSearching, workspaces.length]);

  const handleSearchKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (searchQuery.length > 0) {
          setSearchQuery('');
        } else {
          event.currentTarget.blur();
        }
        return;
      }

      if (event.key === 'Enter' && firstSearchMatch) {
        event.preventDefault();
        selectSession(firstSearchMatch.sessionId, firstSearchMatch.workspaceId);
      }
    },
    [firstSearchMatch, searchQuery.length, selectSession],
  );

  const { width, onResizeStart } = useResizableWidth({
    storageKey: 'freeultracode.sidebarWidth.v1',
    defaultWidth: 240,
    min: 180,
    max: 480,
    edge: 'right',
  });
  const showFlatCollapse =
    !isSearching &&
    flatLimit > WORKFLOW_HISTORY_PAGE_SIZE &&
    Math.min(flatLimit, filteredFlatSessions.length) >
      WORKFLOW_HISTORY_PAGE_SIZE;
  const showFlatLoadMore =
    !isSearching && filteredFlatSessions.length > flatLimit;

  return (
    <aside
      className="relative flex h-full shrink-0 flex-col border-r border-border bg-panel"
      style={{ width }}
    >
      {/* Resize handle — right edge, drag horizontally. */}
      <div
        onMouseDown={onResizeStart}
        title={t(locale, 'common.resizeWidth')}
        className="group absolute -right-1 top-0 bottom-0 z-20 flex w-2 cursor-col-resize items-center justify-center"
      >
        <div className="h-full w-0.5 bg-transparent transition-colors group-hover:bg-accent/40" />
      </div>

      {/* Brand */}
      <div className="flex items-center gap-2 border-b border-border-soft px-4 py-3.5">
        <span className="text-accent-2">◆</span>
        <span className="text-sm font-semibold tracking-tight text-fg">
          FreeUltraCode
        </span>
      </div>

      {/* Workspace switcher */}
      <div className="border-b border-border-soft px-3 py-2.5">
        <WorkspaceListSelect
          workspaces={workspaces}
          activeWorkspaceId={selectedWorkspaceId}
          locale={locale}
          onSelect={setWorkspace}
          onBrowseLocal={() => {
            void handleBrowseLocalWorkspace();
          }}
        />
      </div>

      {/* Primary actions */}
      <div className="flex flex-col gap-2 px-3 pt-3 pb-2.5">
        <button
          type="button"
          onClick={newSession}
          className="flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <span className="text-base leading-none">＋</span>
          {t(locale, 'sidebar.newSession')}
        </button>
      </div>

      {/* Session history */}
      <div className="flex min-h-0 flex-1 flex-col px-2 pb-3">
        <div className="px-2 pb-2 pt-0">
          <div
            role="tablist"
            aria-label={t(locale, 'sidebar.historyTabs')}
            className="grid grid-cols-2 rounded-md border border-border-soft bg-bg p-0.5"
          >
            {(['history', 'favorites'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={activeTab === tab}
                onClick={() => setActiveTab(tab)}
                className={
                  'min-w-0 rounded px-2 py-1.5 text-xs font-medium transition-colors ' +
                  (activeTab === tab
                    ? 'bg-panel-2 text-fg shadow-sm'
                    : 'text-fg-faint hover:bg-border-soft hover:text-fg-dim')
                }
              >
                <span className="block truncate">
                  {t(
                    locale,
                    tab === 'history'
                      ? 'sidebar.history'
                      : 'sidebar.favorites',
                  )}
                </span>
              </button>
            ))}
          </div>
        </div>
        {showHistorySearch && (
          <div className="px-2 pb-2">
            <div className="relative">
              <Search
                size={13}
                className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg-faint"
              />
              <input
                type="search"
                aria-label={t(locale, 'sidebar.searchPlaceholder')}
                value={searchQuery}
                disabled={!historyReady}
                placeholder={
                  historyReady
                    ? t(locale, 'sidebar.searchPlaceholder')
                    : t(locale, 'sidebar.searchLoading')
                }
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={handleSearchKeyDown}
                spellCheck={false}
                className="h-8 w-full min-w-0 appearance-none rounded-md border border-border-soft bg-bg pl-7 pr-7 text-xs text-fg outline-none transition-colors placeholder:text-fg-faint focus:border-accent disabled:cursor-wait disabled:opacity-60"
              />
              {searchQuery.length > 0 && (
                <button
                  type="button"
                  aria-label={t(locale, 'sidebar.searchClear')}
                  title={t(locale, 'sidebar.searchClear')}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setSearchQuery('')}
                  className="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-fg-faint transition-colors hover:bg-border-soft hover:text-fg"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {!historyReady ? (
            <div
              role="status"
              aria-live="polite"
              className="px-2 py-3 text-xs text-fg-faint"
            >
              <div className="flex items-center gap-2 text-fg-dim">
                <span
                  aria-hidden="true"
                  className="h-3 w-3 animate-spin rounded-full border border-border border-t-accent"
                />
                <span>{t(locale, 'sidebar.searchLoading')}</span>
              </div>
            </div>
          ) : historyError ? (
            <div
              role="alert"
              aria-live="polite"
              className="px-2 py-3 text-xs text-fg-faint"
            >
              <div className="text-fg-dim">
                {t(locale, 'sidebar.historyLoadFailed')}
              </div>
              <div className="mt-1 break-words">{historyError}</div>
            </div>
          ) : isActiveTabEmpty ? (
            <div
              role="status"
              aria-live="polite"
              className="px-2 py-3 text-xs text-fg-faint"
            >
              {activeTab === 'favorites'
                ? t(locale, 'sidebar.emptyFavorites')
                : t(locale, 'sidebar.emptySessions')}
            </div>
          ) : isSearching && totalMatchedSessions === 0 ? (
            <div
              role="status"
              aria-live="polite"
              className="px-2 py-3 text-xs text-fg-faint"
            >
              <div className="text-fg-dim">
                {t(locale, 'sidebar.searchNoResults')}
              </div>
              <div className="mt-1">
                {t(locale, 'sidebar.searchNoResultsHint')}
              </div>
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="mt-2 rounded-md border border-border px-2 py-1 text-xs text-fg-dim transition-colors hover:border-accent hover:text-accent"
              >
                {t(locale, 'sidebar.searchClear')}
              </button>
            </div>
          ) : workspaces.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {filteredWorkspaces.map(({ workspace, sessions: list, tabSessions }) => {
                const fullList = tabSessions;
                const currentLimit =
                  workspaceLimits[workspace.id] ?? WORKFLOW_HISTORY_PAGE_SIZE;
                const workspaceCollapsed =
                  !isSearching && collapsedWorkspaces[workspace.id] === true;
                const visibleList = isSearching
                  ? list
                  : list.slice(0, currentLimit);
                const showWorkspaceCollapse =
                  !isSearching &&
                  currentLimit > WORKFLOW_HISTORY_PAGE_SIZE &&
                  Math.min(currentLimit, list.length) >
                    WORKFLOW_HISTORY_PAGE_SIZE;
                const showWorkspaceLoadMore =
                  !isSearching && fullList.length > currentLimit;
                const workspaceActive = workspace.id === activeWorkspaceId;
                const projectScan = projectScanCache[workspace.id]?.scan;
                const projectState = projectHealth(workspace, projectScan);
                return (
                  <li key={workspace.id} className="flex flex-col gap-1.5">
                    <div
                      onContextMenu={(e) => onWorkspaceContextMenu(e, workspace)}
                      className={
                        'grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1.5 rounded-md border px-2.5 py-1.5 transition-colors ' +
                        (workspaceActive
                          ? 'border-border bg-panel-2'
                          : 'border-border-soft bg-panel hover:border-border hover:bg-panel-2/60')
                      }
                    >
                      <button
                        type="button"
                        aria-expanded={!workspaceCollapsed}
                        aria-label={workspaceCollapsed ? '展开工作区会话' : '收起工作区会话'}
                        title={workspaceCollapsed ? '展开工作区会话' : '收起工作区会话'}
                        onClick={() => toggleWorkspaceCollapsed(workspace.id)}
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-border-soft bg-bg-alt text-fg-faint transition-colors hover:border-accent hover:text-fg"
                      >
                        {workspaceCollapsed ? (
                          <ChevronRight size={12} aria-hidden="true" />
                        ) : (
                          <ChevronDown size={12} aria-hidden="true" />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => setWorkspace(workspace.path)}
                        className="min-w-0 text-left"
                      >
                        <div className="flex min-w-0 items-center gap-2 text-[11px] font-semibold leading-4 text-fg">
                          <span
                            className={cn(
                              'h-2 w-2 shrink-0 rounded-full',
                              projectStatusClassName(projectState.tone),
                            )}
                            title={`${projectState.label}：${projectState.detail}`}
                            aria-label={projectState.label}
                          />
                          <span className="min-w-0 flex-1 truncate" title={workspace.path}>
                            {workspace.name}
                          </span>
                        </div>
                        {workspace.path && (
                          <div className="truncate pl-8 font-mono text-[9px] text-fg-faint">
                            {workspace.path}
                          </div>
                        )}
                      </button>
                      <div className="flex h-6 shrink-0 items-center gap-1 self-center">
                        <span className="inline-flex h-5 min-w-6 items-center justify-center rounded border border-border-soft bg-bg-alt px-1.5 font-mono text-[10px] font-semibold leading-none tabular-nums text-fg-dim">
                          {fullList.length}
                        </span>
                        <button
                          type="button"
                          title={t(locale, 'sidebar.moreWorkspaceActions')}
                          aria-label={t(locale, 'sidebar.moreWorkspaceActions')}
                          onClick={(e) => onWorkspaceMoreClick(e, workspace)}
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-border-soft bg-bg-alt text-fg-faint transition-colors hover:border-accent hover:text-fg"
                        >
                          <MoreHorizontal size={14} aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                    {workspaceCollapsed ? null : list.length === 0 ? (
                      <div className="px-6 py-1 text-xs text-fg-faint">
                        {t(locale, 'sidebar.emptySessions')}
                      </div>
                    ) : (
                      <ul className="flex flex-col gap-0.5">
                        {visibleList.map((session) => {
                          const active =
                            session.id === activeSessionId &&
                            workspace.id === activeWorkspaceId;
                          const sessionKey = {
                            workspaceId: workspace.id,
                            sessionId: session.id,
                          };
                          const liveStatus = sessionLiveStatus(
                            sessionKey,
                            { runningSessions, aiEditingSessions, chattingSessions },
                          );
                          const status = historyStatusTone(session, liveStatus);
                          const runProgress =
                            runningSessionProgress[workflowSessionKeyId(sessionKey)];
                          const statusLabel = historyStatusLabel(
                            locale,
                            status,
                            runProgress?.percent,
                          );
                          const isRenaming =
                            renaming?.sessionId === session.id &&
                            renaming.workspaceId === workspace.id;
                          return (
                            <li key={`${workspace.id}:${session.id}`}>
                              {isRenaming ? (
                                <div
                                  onContextMenu={(e) =>
                                    onSessionContextMenu(
                                      e,
                                      session.id,
                                      workspace.id,
                                      session.title,
                                      session.isWorkflow,
                                      session.simple === true,
                                      session.favorite === true,
                                      session.scheduledTask,
                                    )
                                  }
                                  className={historySessionEditRowClassName(
                                    active,
                                  )}
                                >
                                  <span className="grid w-full grid-cols-[minmax(0,1fr)_var(--fuc-status-slot-size)] items-center gap-1.5">
                                    <input
                                      autoFocus
                                      aria-label={t(locale, 'sidebar.renameSession')}
                                      value={renameDraft}
                                      disabled={renameSaving}
                                      onFocus={(e) => e.currentTarget.select()}
                                      onChange={(e) => {
                                        setRenameDraft(e.target.value);
                                        setRenameError(null);
                                      }}
                                      onClick={(e) => e.stopPropagation()}
                                      onKeyDown={(e) => {
                                        e.stopPropagation();
                                        if (e.key === 'Enter') {
                                          e.preventDefault();
                                          void saveRename(
                                            session,
                                            workspace.id,
                                            fullList,
                                          );
                                        }
                                        if (e.key === 'Escape') {
                                          e.preventDefault();
                                          cancelRename();
                                        }
                                      }}
                                      className="min-w-0 rounded border border-border bg-bg px-1.5 py-0.5 text-sm text-fg outline-none transition-colors focus:border-accent disabled:cursor-wait disabled:opacity-60"
                                    />
                                    <StatusIndicator
                                      label={statusLabel}
                                      tone={status}
                                    />
                                  </span>
                                  <span className="flex w-full items-center gap-1">
                                    <button
                                      type="button"
                                      disabled={renameSaving}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        void saveRename(
                                          session,
                                          workspace.id,
                                          fullList,
                                        );
                                      }}
                                      className="rounded border border-accent/40 bg-accent/15 px-2 py-0.5 text-[11px] text-accent transition-colors hover:bg-accent/25 disabled:cursor-wait disabled:opacity-60"
                                    >
                                      {t(locale, 'sidebar.renameSave')}
                                    </button>
                                    <button
                                      type="button"
                                      disabled={renameSaving}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        cancelRename();
                                      }}
                                      className="rounded border border-border px-2 py-0.5 text-[11px] text-fg-faint transition-colors hover:border-accent hover:text-accent disabled:cursor-wait disabled:opacity-60"
                                    >
                                      {t(locale, 'sidebar.renameCancel')}
                                    </button>
                                  </span>
                                  {renameError && (
                                    <span className="text-[11px] leading-snug text-rose-300">
                                      {renameError}
                                    </span>
                                  )}
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => selectSession(session.id, workspace.id)}
                                  onContextMenu={(e) =>
                                    onSessionContextMenu(
                                      e,
                                      session.id,
                                      workspace.id,
                                      session.title,
                                      session.isWorkflow,
                                      session.simple === true,
                                      session.favorite === true,
                                      session.scheduledTask,
                                    )
                                  }
                                  className={historySessionRowClassName(active)}
                                >
                                  <span className="grid w-full grid-cols-[minmax(0,1fr)_var(--fuc-status-slot-size)] items-center gap-1.5">
                                    <span className="flex min-w-0 flex-1 items-center gap-1">
                                      <FavoriteMarker
                                        favorite={session.favorite === true}
                                        locale={locale}
                                      />
                                      <ScheduledTaskMarker
                                        scheduledTask={session.scheduledTask}
                                        locale={locale}
                                      />
                                      <span className="min-w-0 flex-1 truncate text-sm">
                                        {session.title}
                                      </span>
                                    </span>
                                    <StatusIndicator
                                      label={statusLabel}
                                      tone={status}
                                    />
                                  </span>
                                  <span className="flex w-full items-center gap-1 font-mono text-[10px] text-fg-faint">
                                    <span>{formatTime(session.updatedAt ?? session.createdAt)}</span>
                                    {session.preview && (
                                      <span className="min-w-0 flex-1 truncate">
                                        {session.preview}
                                      </span>
                                    )}
                                  </span>
                                </button>
                              )}
                            </li>
                          );
                        })}
                        {(showWorkspaceCollapse ||
                          showWorkspaceLoadMore) && (
                            <li className="flex gap-1 px-2 py-1">
                              {showWorkspaceCollapse && (
                                <button
                                  type="button"
                                  onClick={() => collapseWorkspace(workspace.id)}
                                  className="flex-1 rounded-md px-2 py-1.5 text-center text-sm text-fg-dim transition-colors hover:bg-border-soft hover:text-fg"
                                >
                                  {t(locale, 'sidebar.collapse')}
                                </button>
                              )}
                              {showWorkspaceLoadMore && (
                                <button
                                  type="button"
                                  onClick={() => loadMoreWorkspace(workspace.id)}
                                  className="flex-1 rounded-md px-2 py-1.5 text-center text-sm text-fg-dim transition-colors hover:bg-border-soft hover:text-fg"
                                >
                                  {t(locale, 'sidebar.loadMore')}
                                </button>
                              )}
                            </li>
                          )}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {filteredFlatSessions
                .slice(0, isSearching ? filteredFlatSessions.length : flatLimit)
                .map((session) => {
                  const active = session.id === activeSessionId;
                  const sessionKey = { workspaceId: null, sessionId: session.id };
                  const liveStatus = sessionLiveStatus(
                    sessionKey,
                    { runningSessions, aiEditingSessions, chattingSessions },
                  );
                  const status = historyStatusTone(session, liveStatus);
                  const runProgress =
                    runningSessionProgress[workflowSessionKeyId(sessionKey)];
                  const statusLabel = historyStatusLabel(
                    locale,
                    status,
                    runProgress?.percent,
                  );
                  const isRenaming =
                    renaming?.sessionId === session.id &&
                    renaming.workspaceId === null;
                  return (
                    <li key={`flat:${session.id}`}>
                    {isRenaming ? (
                      <div
                        onContextMenu={(e) =>
                          onSessionContextMenu(
                            e,
                            session.id,
                            null,
                            session.title,
                            session.isWorkflow,
                            session.simple === true,
                            session.favorite === true,
                            session.scheduledTask,
                          )
                        }
                        className={historySessionEditRowClassName(active)}
                      >
                        <span className="grid w-full grid-cols-[minmax(0,1fr)_var(--fuc-status-slot-size)] items-center gap-1.5">
                          <input
                            autoFocus
                            aria-label={t(locale, 'sidebar.renameSession')}
                            value={renameDraft}
                            disabled={renameSaving}
                            onFocus={(e) => e.currentTarget.select()}
                            onChange={(e) => {
                              setRenameDraft(e.target.value);
                              setRenameError(null);
                            }}
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => {
                              e.stopPropagation();
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                void saveRename(session, null, sessions);
                              }
                              if (e.key === 'Escape') {
                                e.preventDefault();
                                cancelRename();
                              }
                            }}
                            className="min-w-0 rounded border border-border bg-bg px-1.5 py-0.5 text-sm text-fg outline-none transition-colors focus:border-accent disabled:cursor-wait disabled:opacity-60"
                          />
                          <StatusIndicator label={statusLabel} tone={status} />
                        </span>
                        <span className="flex w-full items-center gap-1">
                          <button
                            type="button"
                            disabled={renameSaving}
                            onClick={(e) => {
                              e.stopPropagation();
                              void saveRename(session, null, sessions);
                            }}
                            className="rounded border border-accent/40 bg-accent/15 px-2 py-0.5 text-[11px] text-accent transition-colors hover:bg-accent/25 disabled:cursor-wait disabled:opacity-60"
                          >
                            {t(locale, 'sidebar.renameSave')}
                          </button>
                          <button
                            type="button"
                            disabled={renameSaving}
                            onClick={(e) => {
                              e.stopPropagation();
                              cancelRename();
                            }}
                            className="rounded border border-border px-2 py-0.5 text-[11px] text-fg-faint transition-colors hover:border-accent hover:text-accent disabled:cursor-wait disabled:opacity-60"
                          >
                            {t(locale, 'sidebar.renameCancel')}
                          </button>
                        </span>
                        {renameError && (
                          <span className="text-[11px] leading-snug text-rose-300">
                            {renameError}
                          </span>
                        )}
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => selectSession(session.id)}
                        onContextMenu={(e) =>
                          onSessionContextMenu(
                            e,
                            session.id,
                            null,
                            session.title,
                            session.isWorkflow,
                            session.simple === true,
                            session.favorite === true,
                            session.scheduledTask,
                          )
                        }
                        className={historySessionRowClassName(active)}
                      >
                        <span className="grid w-full grid-cols-[minmax(0,1fr)_var(--fuc-status-slot-size)] items-center gap-1.5">
                          <span className="flex min-w-0 flex-1 items-center gap-1">
                            <FavoriteMarker
                              favorite={session.favorite === true}
                              locale={locale}
                            />
                            <ScheduledTaskMarker
                              scheduledTask={session.scheduledTask}
                              locale={locale}
                            />
                            <span className="min-w-0 flex-1 truncate text-sm">
                              {session.title}
                            </span>
                          </span>
                          <StatusIndicator label={statusLabel} tone={status} />
                        </span>
                        <span className="font-mono text-[10px] text-fg-faint">
                          {formatTime(session.updatedAt ?? session.createdAt)}
                        </span>
                      </button>
                    )}
                    </li>
                  );
                })}
              {(showFlatCollapse || showFlatLoadMore) && (
                <li className="flex gap-1 px-2 py-1">
                  {showFlatCollapse && (
                    <button
                      type="button"
                      onClick={collapseFlat}
                      className="flex-1 rounded-md px-2 py-1.5 text-center text-sm text-fg-dim transition-colors hover:bg-border-soft hover:text-fg"
                    >
                      {t(locale, 'sidebar.collapse')}
                    </button>
                  )}
                  {showFlatLoadMore && (
                    <button
                      type="button"
                      onClick={loadMoreFlat}
                      className="flex-1 rounded-md px-2 py-1.5 text-center text-sm text-fg-dim transition-colors hover:bg-border-soft hover:text-fg"
                    >
                      {t(locale, 'sidebar.loadMore')}
                    </button>
                  )}
                </li>
              )}
            </ul>
          )}
        </div>
      </div>

      <div className="border-t border-border-soft p-3">
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          title={t(locale, 'settings.openHint')}
          className="flex w-full items-center gap-2 rounded-md border border-border bg-panel-2 px-3 py-2 text-sm text-fg-dim transition-colors hover:border-accent hover:bg-border-soft hover:text-fg"
        >
          <span className="text-base leading-none text-accent">⚙</span>
          <span>{t(locale, 'settings.open')}</span>
        </button>
      </div>

      {settingsOpen && (
        <SettingsModal onClose={() => setSettingsOpen(false)} />
      )}

      {projectSettingsWorkspace && (
        <ProjectSettingsModal
          workspace={projectSettingsWorkspace}
          onWorkspaceUpdated={handleProjectWorkspaceUpdated}
          onClose={() => setProjectSettingsWorkspace(null)}
        />
      )}

      {menu && (
        <SessionContextMenu
          x={menu.x}
          y={menu.y}
          locale={locale}
          canFavorite={true}
          isFavorite={menu.favorite}
          canSchedule={menu.favorite}
          canRename={true}
          deleteDisabledReason={deleteProtectionLabel(
            locale,
            menuDeleteProtectionReason,
          )}
          onToggleFavorite={handleToggleFavorite}
          onSchedule={handleOpenSchedule}
          onRename={handleStartRename}
          onDelete={handleDelete}
          onClose={() => setMenu(null)}
        />
      )}
      {workspaceMenu && (
        <WorkspaceContextMenu
          x={workspaceMenu.x}
          y={workspaceMenu.y}
          locale={locale}
          onOpenDirectory={handleOpenWorkspaceDirectory}
          openDirectoryDisabled={!workspaceMenu.workspace.path?.trim()}
          onOpenSettings={handleOpenWorkspaceSettings}
          onRemoveHistory={handleRemoveWorkspaceHistory}
          removeDisabledReason={workspaceMenuDeleteDisabledReason}
          onClose={() => setWorkspaceMenu(null)}
        />
      )}
      {workspaceRemoveConfirm && (
        <WorkspaceRemoveHistoryDialog
          workspace={workspaceRemoveConfirm}
          locale={locale}
          onCancel={handleCancelRemoveWorkspaceHistory}
          onConfirm={handleConfirmRemoveWorkspaceHistory}
        />
      )}
      {scheduleDialog && (
        <ScheduledTaskDialog
          locale={locale}
          title={scheduleDialog.title}
          initialTask={scheduleDialog.scheduledTask}
          onSave={handleSaveSchedule}
          onDelete={handleDeleteSchedule}
          onClose={() => setScheduleDialog(null)}
        />
      )}
    </aside>
  );
}

function WorkspaceRemoveHistoryDialog({
  workspace,
  locale,
  onCancel,
  onConfirm,
}: {
  workspace: WorkspaceSummary;
  locale: Locale;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const messageLines = t(locale, 'sidebar.removeWorkspaceHistoryConfirm')
    .replace('{name}', workspace.name)
    .replace('{path}', workspace.path)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const [title, ...descriptionLines] = messageLines;
  const hasWorkspacePath = workspace.path.trim().length > 0;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-remove-history-title"
        aria-describedby="workspace-remove-history-description"
        className="w-[min(420px,calc(100vw-2rem))] overflow-hidden rounded-lg border border-border bg-panel shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="border-b border-border-soft bg-bg-alt px-5 py-4">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-rose-500/15 text-rose-300">
              <Trash2 size={18} strokeWidth={2.2} />
            </span>
            <div className="min-w-0 flex-1">
              <h2
                id="workspace-remove-history-title"
                className="text-base font-semibold text-fg"
              >
                {title}
              </h2>
            </div>
            <button
              type="button"
              onClick={onCancel}
              title={t(locale, 'common.close')}
              aria-label={t(locale, 'common.close')}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-panel-2 text-fg-faint transition-colors hover:border-accent hover:text-fg"
            >
              <X size={15} strokeWidth={2.2} />
            </button>
          </div>
        </header>
        <div
          id="workspace-remove-history-description"
          className="space-y-2 px-5 py-4 text-sm leading-relaxed text-fg-dim"
        >
          {descriptionLines.map((line) => (
            <p
              key={line}
              className={
                hasWorkspacePath && line.includes(workspace.path)
                  ? 'break-all font-mono text-xs text-fg-faint'
                  : undefined
              }
            >
              {line}
            </p>
          ))}
        </div>
        <footer className="flex justify-end gap-2 border-t border-border-soft bg-bg-alt px-5 py-3">
          <button
            type="button"
            autoFocus
            onClick={onCancel}
            className="rounded-md border border-border bg-panel-2 px-3 py-1.5 text-sm text-fg-dim transition-colors hover:border-accent hover:text-fg"
          >
            {t(locale, 'common.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-md border border-rose-400/50 bg-rose-500/15 px-3 py-1.5 text-sm font-semibold text-rose-200 transition-colors hover:bg-rose-500/25"
          >
            {t(locale, 'sidebar.removeWorkspaceHistoryConfirmAction')}
          </button>
        </footer>
      </div>
    </div>
  );
}

function WorkspaceContextMenu({
  x,
  y,
  locale,
  onOpenDirectory,
  openDirectoryDisabled,
  onOpenSettings,
  onRemoveHistory,
  removeDisabledReason,
  onClose,
}: {
  x: number;
  y: number;
  locale: Locale;
  onOpenDirectory: () => void;
  openDirectoryDisabled: boolean;
  onOpenSettings: () => void;
  onRemoveHistory: () => void;
  removeDisabledReason: string | null;
  onClose: () => void;
}) {
  return (
    <>
      <div
        className="fixed inset-0 z-30"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        className="absolute z-40 min-w-[156px] overflow-hidden rounded-md border border-border bg-panel shadow-2xl"
        style={{ left: x, top: y }}
      >
        <button
          type="button"
          disabled={openDirectoryDisabled}
          onClick={onOpenDirectory}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-fg-dim transition-colors hover:bg-panel-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-fg-dim"
        >
          <FolderOpen size={13} className="text-fg-faint" />
          <span>{t(locale, 'sidebar.openWorkspaceDirectory')}</span>
        </button>
        <button
          type="button"
          onClick={onOpenSettings}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-fg-dim transition-colors hover:bg-panel-2 hover:text-fg"
        >
          <SettingsGlyph size={13} className="text-fg-faint" />
          <span>{t(locale, 'sidebar.projectSettings')}</span>
        </button>
        <button
          type="button"
          disabled={removeDisabledReason != null}
          title={removeDisabledReason ?? undefined}
          onClick={onRemoveHistory}
          className="flex w-full items-center gap-2 border-t border-border-soft px-3 py-2 text-left text-sm text-rose-300 transition-colors hover:bg-panel-2 hover:text-rose-200 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-rose-300"
        >
          <Trash2 size={13} className="text-rose-300/80" />
          <span>{t(locale, 'sidebar.removeWorkspaceHistory')}</span>
        </button>
      </div>
    </>
  );
}

/**
 * Right-click context menu for a session entry.
 * Positioned relative to the Sidebar so it stays inside the rail.
 */
function SessionContextMenu({
  x,
  y,
  locale,
  canFavorite,
  isFavorite,
  canSchedule,
  canRename,
  deleteDisabledReason,
  onToggleFavorite,
  onSchedule,
  onRename,
  onDelete,
  onClose,
}: {
  x: number;
  y: number;
  locale: Locale;
  canFavorite: boolean;
  isFavorite: boolean;
  canSchedule: boolean;
  canRename: boolean;
  deleteDisabledReason: string | null;
  onToggleFavorite: () => void;
  onSchedule: () => void;
  onRename: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  return (
    <>
      {/* Backdrop catches the next click anywhere and dismisses the menu. */}
      <div
        className="fixed inset-0 z-30"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        className="absolute z-40 min-w-[140px] overflow-hidden rounded-md border border-border bg-panel shadow-2xl"
        style={{ left: x, top: y }}
      >
        {canFavorite && (
          <button
            type="button"
            onClick={onToggleFavorite}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-fg-dim transition-colors hover:bg-panel-2 hover:text-fg"
          >
            <Star
              size={13}
              className={
                isFavorite
                  ? 'fill-accent text-accent'
                  : 'text-fg-faint'
              }
            />
            <span>
              {t(
                locale,
                isFavorite
                  ? 'sidebar.unfavoriteSession'
                  : 'sidebar.favoriteSession',
              )}
            </span>
          </button>
        )}
        {canSchedule && (
          <button
            type="button"
            onClick={onSchedule}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-fg-dim transition-colors hover:bg-panel-2 hover:text-fg"
          >
            <AlarmClock
              size={13}
              className="text-fg-faint"
            />
            <span>{t(locale, 'sidebar.scheduleTask')}</span>
          </button>
        )}
        {canRename && (
          <button
            type="button"
            onClick={onRename}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-fg-dim transition-colors hover:bg-panel-2 hover:text-fg"
          >
            <Pencil size={13} className="text-fg-faint" />
            <span>{t(locale, 'sidebar.renameSession')}</span>
          </button>
        )}
        <button
          type="button"
          disabled={deleteDisabledReason != null}
          title={deleteDisabledReason ?? undefined}
          onClick={onDelete}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-fg-dim transition-colors hover:bg-panel-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-fg-dim"
        >
          <Trash2 size={13} className="text-fg-faint" />
          <span>{t(locale, 'sidebar.deleteSession')}</span>
        </button>
      </div>
    </>
  );
}
