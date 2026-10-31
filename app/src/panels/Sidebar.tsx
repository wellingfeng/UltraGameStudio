import {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type CSSProperties,
} from 'react';
import {
  AlarmClock,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Layers,
  Download,
  FolderOpen,
  MoreHorizontal,
  MessageCircle,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings as SettingsGlyph,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import StatusIndicator, { type StatusTone } from '@/components/StatusIndicator';
import SessionTitle from '@/components/SessionTitle';
import WorkspaceListSelect from '@/components/WorkspaceListSelect';
// import RemoteWorkspaceDialog from '@/components/RemoteWorkspaceDialog';
import RemoteWorkspaceStatusBadge, {
  remoteWorkspaceConnectionDotClassName,
  remoteWorkspaceConnectionLabel,
} from '@/components/RemoteWorkspaceStatusBadge';
import { cn } from '@/lib/cn';
import {
  getCliUpdateSnapshot,
  subscribeCliUpdateStatus,
} from '@/lib/cliUpdateStatus';
import { pickFolder } from '@/lib/folderPicker';
import {
  isRemoteWorkspacePath,
} from '@/lib/remoteWorkspace';
import {
  REMOTE_WORKSPACE_STATUS_CHECK_INTERVAL_MS,
  checkRemoteWorkspaceConnection,
  type RemoteWorkspaceConnectionState,
} from '@/lib/remoteWorkspaceStatus';
import {
  uniqueWorkspaceHistory,
  workspacePathKey,
} from '@/lib/workspaceHistory';
import { historyStore } from '@/store/history/store';
import { searchSessionIdsIndexed } from '@/lib/sessionIndex';
import type { SessionReader } from '@/lib/sessionSearch';
import {
  sessionLiveStatus,
  useStore,
  workflowDeleteProtectionReason,
  workflowSessionKeyId,
  type WorkflowDeleteProtectionReason,
  type WorkflowSessionKey,
} from '@/store/useStore';
import type { ScheduledTaskConfig, Session } from '@/store/types';
import {
  DEFAULT_WORKSPACE_ID,
  HISTORY_ROOT_DIR,
  type WorkspaceSummary,
} from '@/store/history/types';
import type { Locale } from '@/lib/i18n';
import {
  projectHealth,
  projectSettingsFromMetadata,
  type ProjectHealthTone,
} from '@/lib/projectSettings';
import {
  openWorkspaceDirectory,
  scanProjectEnvironment,
  listCachedAssets,
  tauriAvailable,
  type ProjectEnvironmentScan,
} from '@/lib/tauri';
import { useResizableWidth } from '@/lib/useResizableWidth';
import { useAutoHideScroll } from '@/hooks/useAutoHideScroll';
import { t } from '@/lib/i18n';
import {
  assetMatchesWorkspace,
  isOutputAsset,
  getAssets,
  subscribeAssets,
  mergeCachedAssetsFromDisk,
} from '@/lib/downloadRegistry';
import SettingsModal from './SettingsModal';
import ProjectSettingsModal from './ProjectSettingsModal';
import ScheduledTaskDialog from './ScheduledTaskDialog';
import { useMainSurface } from '@/components/MainSurface';
import { scheduleText } from '@/lib/scheduledTaskI18n';

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

const WORKFLOW_HISTORY_PAGE_SIZE = 10;
const WORKSPACE_HEADER_VISIBLE_PATHS = 2;
const MAX_SESSION_RENAME_LENGTH = 80;
type SidebarLiveState = {
  runningSessions: WorkflowSessionKey[];
  aiEditingSessions: WorkflowSessionKey[];
  chattingSessions: WorkflowSessionKey[];
  waitingInputSessions: WorkflowSessionKey[];
};
type ProjectScanCacheEntry = {
  path: string;
  scan: ProjectEnvironmentScan | null;
};

function workspaceHeaderPaths(workspace: WorkspaceSummary): string[] {
  return uniqueWorkspaceHistory([
    workspace.path,
    ...projectSettingsFromMetadata(workspace.metadata).folders,
  ]);
}

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
  if (liveStatus === 'waiting') return 0;
  if (liveStatus === 'aiEditing') return 0;
  // A completed-but-not-yet-viewed session needs attention, so it floats above
  // plain idle sessions but stays below anything still actively live.
  if (session.runStatus === 'success' && session.unreadCompletion === true) {
    return 1;
  }
  return 2;
}

/**
 * 0 when the session's composer still holds unsent text, 1 otherwise. Applied
 * as a secondary sort key after live status so a drafted-but-idle session never
 * jumps above a running one, but does float above idle sessions with no draft.
 */
function sessionDraftRank(
  session: Session,
  workspaceId: string | null,
  draftKeys: ReadonlySet<string>,
): number {
  const key = workflowSessionKeyId({ workspaceId, sessionId: session.id });
  return draftKeys.has(key) ? 0 : 1;
}

function sortHistorySessions(
  sessions: Session[],
  workspaceId: string | null,
  liveState: SidebarLiveState,
  draftKeys: ReadonlySet<string>,
): Session[] {
  return sessions.filter((session) => !session.scheduledTask).sort((a, b) => {
    const pinDiff = Number(b.pinned === true) - Number(a.pinned === true);
    if (pinDiff !== 0) return pinDiff;
    const aLiveRank = sessionLiveRank(a, workspaceId, liveState);
    const bLiveRank = sessionLiveRank(b, workspaceId, liveState);
    const liveDiff = aLiveRank - bLiveRank;
    if (liveDiff !== 0) return liveDiff;
    if (aLiveRank > 1) {
      const draftDiff =
        sessionDraftRank(a, workspaceId, draftKeys) -
        sessionDraftRank(b, workspaceId, draftKeys);
      if (draftDiff !== 0) return draftDiff;
    }
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

/** 0 when any session in the workspace has an unsent composer draft, else 1. */
function workspaceDraftRank(
  sessions: Session[],
  workspaceId: string,
  draftKeys: ReadonlySet<string>,
): number {
  return sessions.some(
    (session) => sessionDraftRank(session, workspaceId, draftKeys) === 0,
  )
    ? 0
    : 1;
}

function workspaceGroupSortTimestamp(
  sessions: Session[],
  workspace: WorkspaceSummary,
): number {
  return sessions[0] ? sessionSortTimestamp(sessions[0]) : workspace.updatedAt;
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
  if (status === 'waiting') return t(locale, 'sidebar.waitingInput');
  if (status === 'thinking') return t(locale, 'sidebar.thinking');
  if (status === 'unrun') return t(locale, 'sidebar.unrun');
  if (status === 'draft') return t(locale, 'sidebar.hasDraft');
  if (status === 'successUnread') return t(locale, 'sidebar.completedUnread');
  if (status === 'success') return t(locale, 'sidebar.completed');
  if (status === 'interrupted') return t(locale, 'sidebar.interrupted');
  return t(locale, 'sidebar.failed');
}

function historyStatusTone(
  session: Pick<Session, 'isWorkflow' | 'simple' | 'runStatus' | 'unreadCompletion'>,
  liveStatus: ReturnType<typeof sessionLiveStatus>,
  hasDraft = false,
): StatusTone | null {
  if (liveStatus === 'running') return 'running';
  if (liveStatus === 'waiting') return 'waiting';
  if (liveStatus === 'aiEditing') return 'thinking';
  // An unsent composer draft outranks the static run-result dot so the user can
  // spot sessions still holding text they have not sent.
  if (hasDraft) return 'draft';
  if (session.runStatus === 'success') {
    return session.unreadCompletion === true ? 'successUnread' : 'success';
  }
  if (session.runStatus === 'error') return 'failed';
  if (session.runStatus === 'interrupted') return 'interrupted';
  return session.isWorkflow && !session.simple ? 'unrun' : null;
}

function projectStatusClassName(tone: ProjectHealthTone): string {
  // Ring instead of a literal rgba() glow: the old shadows were hardcoded samples
  // of Tailwind's palette, so they never matched the themed status colors.
  if (tone === 'connected') return 'bg-status-success ring-2 ring-status-success/20';
  if (tone === 'failed') return 'bg-status-error ring-2 ring-status-error/20';
  if (tone === 'configured') return 'bg-status-warning ring-2 ring-status-warning/20';
  if (tone === 'detected') return 'bg-status-info ring-2 ring-status-info/20';
  return 'bg-fg-faint/40';
}

function deleteProtectionLabel(
  locale: Locale,
  reason: WorkflowDeleteProtectionReason,
): string | null {
  if (reason === 'running') return t(locale, 'sidebar.deleteBlockedRunning');
  if (reason === 'waiting') return t(locale, 'sidebar.deleteBlockedWaiting');
  if (reason === 'aiEditing') return t(locale, 'sidebar.deleteBlockedAiEditing');
  return null;
}

function historySessionForProtection(
  sessionId: string,
  workspaceId: string | null,
  sessions: Session[],
  sessionTree: Record<string, Session[]>,
): Pick<Session, 'id' | 'pinned'> {
  const source = workspaceId ? sessionTree[workspaceId] ?? sessions : sessions;
  return (
    source.find((session) => session.id === sessionId) ?? {
      id: sessionId,
    }
  );
}

function sessionMatchesSearch(
  session: Session,
  workspace: Pick<WorkspaceSummary, 'name' | 'path'> | undefined,
  query: string,
  fullTextMatchIds: Set<string> | null,
): boolean {
  if (!query) return true;

  // Summary fields (title / last-message preview / workspace identity) match
  // instantly without loading message bodies.
  if (
    [session.title, session.preview, workspace?.name, workspace?.path].some(
      (value) => value?.toLowerCase().includes(query) ?? false,
    )
  ) {
    return true;
  }

  // Full-text matches resolve asynchronously; `null` means "still searching".
  return fullTextMatchIds?.has(session.id) ?? false;
}

const sidebarTextButtonClassName =
  'group flex w-full items-center gap-3 rounded-sm px-3 py-2 text-left text-sm text-fg-dim transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-40';

const sidebarPrimaryButtonClassName =
  'group flex min-h-8 w-full items-center gap-2.5 rounded-md bg-transparent px-3 py-1.5 text-left text-sm font-normal text-fg-dim transition-colors hover:bg-panel-2/50 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-40';

function historySessionLightStyle(sessionKeyId: string): CSSProperties {
  // Stable per-session timing: list updates must not re-roll the animation.
  let seed = 2166136261;
  for (let index = 0; index < sessionKeyId.length; index += 1) {
    seed = Math.imul(seed ^ sessionKeyId.charCodeAt(index), 16777619) >>> 0;
  }
  // Spread similar IDs across the full phase range instead of clustering them.
  seed = Math.imul(seed ^ (seed >>> 16), 0x85ebca6b) >>> 0;
  seed = Math.imul(seed ^ (seed >>> 13), 0xc2b2ae35) >>> 0;
  seed = (seed ^ (seed >>> 16)) >>> 0;
  const duration = 2300 + (seed % 1101);
  const phase = ((seed >>> 16) + 0.5) / 65536;
  return {
    '--ugs-session-light-duration': `${duration}ms`,
    '--ugs-session-light-delay': `${-(duration * phase).toFixed(2)}ms`,
  } as CSSProperties;
}

function historySessionRowClassName(active: boolean, status: StatusTone | null): string {
  return cn(
    'ugs-sidebar-session group flex h-[30px] w-full min-w-0 items-center gap-1.5 rounded px-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60',
    active
      ? 'ugs-sidebar-session--selected bg-panel-2 text-fg'
      : 'bg-transparent text-fg-dim hover:bg-panel-2/45 hover:text-fg',
    (status === 'running' || status === 'thinking') && 'ugs-sidebar-session--live',
    'disabled:cursor-not-allowed disabled:opacity-50',
  );
}

function historySessionEditRowClassName(active: boolean, status: StatusTone | null): string {
  return cn(
    'ugs-sidebar-session ugs-sidebar-session--editing group flex w-full flex-col items-start gap-1 rounded-md px-3 py-2 text-left transition-colors',
    active
      ? 'ugs-sidebar-session--selected bg-panel-2 text-fg'
      : 'bg-transparent text-fg-dim hover:bg-panel-2/45 hover:text-fg',
    (status === 'running' || status === 'thinking') && 'ugs-sidebar-session--live',
  );
}

function HistorySessionContent({
  session,
  status,
  label,
  percent,
  locale,
}: {
  session: Session;
  status: StatusTone | null;
  label?: string;
  percent?: number | null;
  locale: Locale;
}) {
  const timestamp = session.updatedAt ?? session.createdAt;
  const time = formatTime(timestamp);
  // Older sessions need only a date in the row; the tooltip keeps the full time.
  const compactTime = time.includes(' ') ? time.split(' ')[0] : time;
  const progress = status === 'running' ? clampPercent(percent) : null;
  const details = [session.title, time, label,
    session.contextCompressed ? '上下文已压缩' : undefined, session.preview,
  ].filter(Boolean).join('\n');

  return (
    <span
      className="ugs-sidebar-meta flex w-full min-w-0 items-center gap-1.5 text-[11px] leading-4 text-inherit"
      data-session-status={status ?? 'none'}
      title={details}
    >
      <StatusIndicator label={label} tone={status} className="shrink-0" />
      {session.contextCompressed === true ? (
        <span role="img" aria-label="上下文已压缩" title="上下文已压缩"
          data-context-compressed="true" className="shrink-0 text-status-info">
          <Layers size={12} strokeWidth={1.8} aria-hidden="true" />
        </span>
      ) : null}
      {session.pinned === true && (
        <Pin size={12} aria-label={t(locale, 'sidebar.pinnedBadge')} className="shrink-0 text-accent" />
      )}
      <FavoriteMarker favorite={session.favorite === true} locale={locale} />
      <ScheduledTaskMarker scheduledTask={session.scheduledTask} locale={locale} />
      <SessionTitle title={session.title} />
      {progress != null ? (
        <span className="ugs-sidebar-session-summary shrink-0 tabular-nums">{progress}%</span>
      ) : null}
      <time dateTime={new Date(timestamp).toISOString()} title={time} className="shrink-0 tabular-nums text-fg-faint">
        {compactTime}
      </time>
    </span>
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

export default function Sidebar({
  projectScoped = false,
}: {
  projectScoped?: boolean;
}) {
  const locale = useStore((s) => s.locale);
  const assetCenterEnabled = useStore((s) => s.assetCenterEnabled);
  const sessions = useStore((s) => s.sessions);
  const historyReady = useStore((s) => s.historyReady);
  const historyError = useStore((s) => s.historyError);
  const historyRootPath = useStore((s) => s.historyRootPath);
  const workspaces = useStore((s) => s.workspaces);
  const sessionTree = useStore((s) => s.sessionTree);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const selectedWorkspaceIdRaw = useStore((s) => s.selectedWorkspaceId);
  // The top switcher follows an explicit, navigation-only selection that does
  // NOT change when the user opens a session in another workspace. Fall back to
  // the active workspace before history init populates it.
  const selectedWorkspaceId = selectedWorkspaceIdRaw ?? activeWorkspaceId;
  const scopedWorkspaceId = projectScoped ? selectedWorkspaceId : null;
  const activeSessionId = useStore((s) => s.activeSessionId);
  const composerDraft = useStore((s) => s.composerDraft);
  const composerDrafts = useStore((s) => s.composerDrafts);
  const runningSessions = useStore((s) => s.runningSessions);
  const runningSessionProgress = useStore((s) => s.runningSessionProgress);
  const aiEditingSessions = useStore((s) => s.aiEditingSessions);
  const chattingSessions = useStore((s) => s.chattingSessions);
  const waitingInputSessions = useStore((s) => s.waitingInputSessions);
  const jobSessions = useStore((s) => s.jobSessions);
  const jobSessionProgress = useStore((s) => s.jobSessionProgress);
  const newSession = useStore((s) => s.newSession);
  const setWorkspace = useStore((s) => s.setWorkspace);
  const selectSession = useStore((s) => s.selectSession);
  const deleteSession = useStore((s) => s.deleteSession);
  const deleteWorkspaceHistory = useStore((s) => s.deleteWorkspaceHistory);
  const assets = useSyncExternalStore(subscribeAssets, getAssets);
  const cliUpdate = useSyncExternalStore(
    subscribeCliUpdateStatus,
    getCliUpdateSnapshot,
  );
  const renameWorkflowSession = useStore((s) => s.renameWorkflowSession);
  const setSessionPinned = useStore((s) => s.setSessionPinned);
  const setWorkflowFavoriteSession = useStore(
    (s) => s.setWorkflowFavoriteSession,
  );
  const setWorkflowScheduledTaskSession = useStore(
    (s) => s.setWorkflowScheduledTaskSession,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { surface, setSurface } = useMainSurface();
  const [projectSettingsWorkspace, setProjectSettingsWorkspace] =
    useState<WorkspaceSummary | null>(null);
  const [projectScanCache, setProjectScanCache] = useState<
    Record<string, ProjectScanCacheEntry>
  >({});
  const [remoteConnectionStates, setRemoteConnectionStates] = useState<
    Record<string, RemoteWorkspaceConnectionState>
  >({});
  const [workspaceLimits, setWorkspaceLimits] = useState<Record<string, number>>({});
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<
    Record<string, boolean>
  >({});
  const [flatLimit, setFlatLimit] = useState(WORKFLOW_HISTORY_PAGE_SIZE);
  const [searchQuery, setSearchQuery] = useState('');
  const [fullTextMatches, setFullTextMatches] = useState<{
    query: string;
    ids: Set<string>;
  } | null>(null);
  const scopedAssets = useMemo(
    () =>
      assets.filter((asset) =>
        isOutputAsset(asset) && assetMatchesWorkspace(asset, activeWorkspaceId),
      ),
    [activeWorkspaceId, assets],
  );
  const assetTotalCount = scopedAssets.length;
  const assetActiveCount = scopedAssets.filter(
    (asset) => asset.status === 'pending',
  ).length;
  const remoteWorkspaceTargets = useMemo(
    () =>
      workspaces
        .filter((workspace) => isRemoteWorkspacePath(workspace.path))
        .map((workspace) => ({
          workspaceId: workspace.id,
          path: workspace.path,
        })),
    [workspaces],
  );

  // Keep the asset-center badge fresh even when its modal is closed. The
  // registry is otherwise only hydrated from disk when the artifacts page mounts,
  // which is why the count used to read 0 until the panel was opened. We poll
  // on a relaxed interval (not real-time, but no longer indefinitely stale).
  const assetBadgeCwd = useMemo(() => {
    const activeWorkspace = activeWorkspaceId
      ? workspaces.find((workspace) => workspace.id === activeWorkspaceId)
      : null;
    return activeWorkspace?.path?.trim() || null;
  }, [activeWorkspaceId, workspaces]);

  useEffect(() => {
    if (!assetCenterEnabled || !tauriAvailable()) return;
    let cancelled = false;
    const refresh = () => {
      void listCachedAssets(assetBadgeCwd)
        .then((files) => {
          if (!cancelled) mergeCachedAssetsFromDisk(files, activeWorkspaceId);
        })
        .catch(() => {});
    };
    refresh();
    const timer = window.setInterval(refresh, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeWorkspaceId, assetBadgeCwd, assetCenterEnabled]);

  useEffect(() => {
    if (!assetCenterEnabled && surface === 'artifacts') setSurface('chat');
  }, [assetCenterEnabled, surface, setSurface]);

  useEffect(() => {
    if (remoteWorkspaceTargets.length === 0) {
      setRemoteConnectionStates({});
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    const targetIds = new Set(
      remoteWorkspaceTargets.map((target) => target.workspaceId),
    );

    setRemoteConnectionStates((prev) => {
      const next: Record<string, RemoteWorkspaceConnectionState> = {};
      for (const target of remoteWorkspaceTargets) {
        next[target.workspaceId] =
          prev[target.workspaceId] ?? {
            status: 'checking',
            checkedAt: Date.now(),
          };
      }
      return next;
    });

    const refresh = () => {
      for (const target of remoteWorkspaceTargets) {
        void checkRemoteWorkspaceConnection(target.path, controller.signal)
          .then((result) => {
            if (cancelled || !targetIds.has(target.workspaceId)) return;
            setRemoteConnectionStates((prev) => ({
              ...prev,
              [target.workspaceId]: result,
            }));
          })
          .catch((err) => {
            if (cancelled || !targetIds.has(target.workspaceId)) return;
            setRemoteConnectionStates((prev) => ({
              ...prev,
              [target.workspaceId]: {
                status: 'failed',
                detail: err instanceof Error ? err.message : String(err),
                checkedAt: Date.now(),
              },
            }));
          });
      }
    };

    refresh();
    const timer = window.setInterval(
      refresh,
      REMOTE_WORKSPACE_STATUS_CHECK_INTERVAL_MS,
    );
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [remoteWorkspaceTargets]);

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
  // 云端项目已退役：保留原代码，不再执行。
  //   const [remoteDialog, setRemoteDialog] = useState<{
  //     existing: RemoteWorkspaceConfig | null;
  //   } | null>(null);

  const menuDeleteProtectionReason = useMemo(() => {
    if (!menu) return null;
    const targetWorkspaceId = menu.workspaceId ?? activeWorkspaceId ?? null;
    const session = historySessionForProtection(
      menu.sessionId,
      targetWorkspaceId,
      sessions,
      sessionTree,
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

  const handleOpenWorkspaceDirectory = useCallback((path: string) => {
    const trimmed = path.trim();
    setWorkspaceMenu(null);
    if (!trimmed || isRemoteWorkspacePath(trimmed)) return;
    void openWorkspaceDirectory(trimmed).then((opened) => {
      if (!opened && typeof window !== 'undefined') {
        window.alert(t(locale, 'sidebar.cannotOpenBrowser'));
      }
    });
  }, [locale]);

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
    const state = useStore.getState();
    const targetWorkspaceId =
      targetWorkspaceMenuId ?? state.activeWorkspaceId ?? null;
    const session = historySessionForProtection(
      targetSessionId,
      targetWorkspaceId,
      state.sessions,
      state.sessionTree,
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

  const menuPinned = menu
    ? historySessionForProtection(
        menu.sessionId,
        menu.workspaceId ?? activeWorkspaceId ?? null,
        sessions,
        sessionTree,
      )?.pinned === true
    : false;

  const handleTogglePinned = useCallback(() => {
    if (!menu) return;
    void setSessionPinned(
      menu.sessionId,
      menu.workspaceId ?? activeWorkspaceId,
      !menuPinned,
    );
    setMenu(null);
  }, [menu, menuPinned, activeWorkspaceId, setSessionPinned]);

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
      if (isRemoteWorkspacePath(path)) return false;
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

  // Open the cloud-project dialog. With a path, edits that existing remote
  // project; without one, creates a new remote project.
  // 云端项目已退役：保留原代码，不再执行。
  //   const handleOpenRemoteDialog = useCallback((existingPath?: string) => {
  //     const id = existingPath ? remoteWorkspaceIdFromPath(existingPath) : '';
  //     setRemoteDialog({ existing: id ? getRemoteWorkspace(id) : null });
  //   }, []);
  //
  //   // After saving a remote project, register/select it like any workspace; its
  //   // synthetic remote://<id> path flows through the normal selection path.
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
    () => ({
      runningSessions,
      aiEditingSessions,
      chattingSessions,
      waitingInputSessions,
      jobSessions,
    }),
    [
      aiEditingSessions,
      chattingSessions,
      jobSessions,
      runningSessions,
      waitingInputSessions,
    ],
  );

  // Session keys whose composer still holds unsent text. The active session's
  // draft lives in `composerDraft` (only flushed into `composerDrafts` on
  // switch), so override its key with the live value to stay current.
  const draftSessionKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const [key, value] of Object.entries(composerDrafts ?? {})) {
      if (typeof value === 'string' && value.trim().length > 0) keys.add(key);
    }
    const activeKey = workflowSessionKeyId({
      workspaceId: activeWorkspaceId ?? null,
      sessionId: activeSessionId ?? null,
    });
    if ((composerDraft ?? '').trim().length > 0) keys.add(activeKey);
    else keys.delete(activeKey);
    return keys;
  }, [composerDraft, composerDrafts, activeWorkspaceId, activeSessionId]);

  const scopedWorkspaces = useMemo(
    () =>
      scopedWorkspaceId
        ? workspaces.filter((workspace) => workspace.id === scopedWorkspaceId)
        : workspaces,
    [scopedWorkspaceId, workspaces],
  );

  // Workspace ids to full-text search against the typed query. A project-scoped
  // sidebar searches only that workspace; otherwise every workspace is searched.
  const searchWorkspaceIds = useMemo(
    () =>
      (scopedWorkspaces.length > 0 ? scopedWorkspaces : workspaces).map(
        (workspace) => workspace.id,
      ),
    [scopedWorkspaces, workspaces],
  );

  // Full-text (title + every message body) results are async. Keep them keyed to
  // the query so a fresh keystroke never flashes the previous query's matches;
  // `null` means "still resolving" for the current query.
  const resolvedFullTextIds =
    fullTextMatches?.query === normalizedQuery ? fullTextMatches.ids : null;
  const searchPending = isSearching && resolvedFullTextIds === null;

  useEffect(() => {
    if (!normalizedQuery) {
      setFullTextMatches(null);
      return;
    }
    if (searchWorkspaceIds.length === 0) {
      // No workspaces to search (legacy flat history): fall back to the
      // summary-only matcher rather than hanging in a pending state.
      setFullTextMatches({ query: normalizedQuery, ids: new Set() });
      return;
    }
    let cancelled = false;
    const reader: SessionReader = {
      listSessions: (workspaceId) =>
        historyStore.listSessions(workspaceId).then((rows) =>
          rows.map((row) => ({
            sessionId: row.sessionId ?? row.id,
            title: row.title,
            updatedAt:
              typeof row.updatedAt === 'number'
                ? row.updatedAt
                : Date.parse(String(row.updatedAt)) || 0,
          })),
        ),
      getSession: (workspaceId, sessionId) =>
        historyStore
          .getSession(workspaceId, sessionId)
          .then((record) => (record ? { messages: record.messages } : null)),
    };
    const timer = window.setTimeout(async () => {
      const ids = new Set<string>();
      for (const workspaceId of searchWorkspaceIds) {
        if (cancelled) return;
        const matches = await searchSessionIdsIndexed(
          reader,
          workspaceId,
          normalizedQuery,
        ).catch(() => new Set<string>());
        if (cancelled) return;
        for (const id of matches) ids.add(id);
      }
      if (!cancelled) setFullTextMatches({ query: normalizedQuery, ids });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [normalizedQuery, searchWorkspaceIds]);

  const totalTreeSessions = useMemo(
    () =>
      scopedWorkspaces.reduce(
        (count, workspace) => count + (sessionTree[workspace.id]?.length ?? 0),
        0,
      ),
    [scopedWorkspaces, sessionTree],
  );

  const historyFlatSessions = useMemo(
    () =>
      sortHistorySessions(
        sessions,
        null,
        sidebarLiveState,
        draftSessionKeys,
      ),
    [
      sessions,
      sidebarLiveState,
      draftSessionKeys,
    ],
  );

  const hasHistory =
    scopedWorkspaces.length > 0 ? totalTreeSessions > 0 : sessions.length > 0;
  const showHistorySearch = !historyReady || hasHistory || isSearching;
  const isHistoryEmpty = historyReady && !hasHistory;

  useEffect(() => {
    if (isHistoryEmpty && searchQuery.length > 0) {
      setSearchQuery('');
    }
  }, [isHistoryEmpty, searchQuery.length]);

  const filteredWorkspaces = useMemo(
    () =>
      scopedWorkspaces
        .map((workspace) => {
          const tabSessions = sortHistorySessions(
            sessionTree[workspace.id] ?? [],
            workspace.id,
            sidebarLiveState,
            draftSessionKeys,
          );
          return {
            workspace,
            tabSessions,
            sessions: normalizedQuery
              ? tabSessions.filter((session) =>
                  sessionMatchesSearch(
                    session,
                    workspace,
                    normalizedQuery,
                    resolvedFullTextIds,
                  ),
                )
              : tabSessions,
          };
        })
        .filter((group) => {
          if (normalizedQuery) return group.sessions.length > 0;
          return group.tabSessions.length > 0;
        })
        .sort((a, b) => {
          const pinDiff =
            Number(b.sessions.some((session) => session.pinned === true)) -
            Number(a.sessions.some((session) => session.pinned === true));
          if (pinDiff !== 0) return pinDiff;
          const selectedDiff =
            (a.workspace.id === selectedWorkspaceId ? 0 : 1) -
            (b.workspace.id === selectedWorkspaceId ? 0 : 1);
          if (selectedDiff !== 0) return selectedDiff;
          const liveDiff =
            workspaceLiveRank(a.sessions, a.workspace.id, sidebarLiveState) -
            workspaceLiveRank(b.sessions, b.workspace.id, sidebarLiveState);
          if (liveDiff !== 0) return liveDiff;
          const draftDiff =
            workspaceDraftRank(a.sessions, a.workspace.id, draftSessionKeys) -
            workspaceDraftRank(b.sessions, b.workspace.id, draftSessionKeys);
          if (draftDiff !== 0) return draftDiff;
          const timeDiff =
            workspaceGroupSortTimestamp(b.sessions, b.workspace) -
            workspaceGroupSortTimestamp(a.sessions, a.workspace);
          if (timeDiff !== 0) return timeDiff;
          return a.workspace.name.localeCompare(b.workspace.name);
        }),
    [
      selectedWorkspaceId,
      normalizedQuery,
      resolvedFullTextIds,
      scopedWorkspaces,
      sessionTree,
      sidebarLiveState,
      draftSessionKeys,
    ],
  );

  const filteredFlatSessions = useMemo(
    () =>
      normalizedQuery
        ? historyFlatSessions.filter((session) =>
            sessionMatchesSearch(
              session,
              undefined,
              normalizedQuery,
              resolvedFullTextIds,
            ),
          )
        : historyFlatSessions,
    [normalizedQuery, resolvedFullTextIds, historyFlatSessions],
  );

  const totalMatchedSessions =
    scopedWorkspaces.length > 0
      ? filteredWorkspaces.reduce(
          (count, group) => count + group.sessions.length,
          0,
        )
      : filteredFlatSessions.length;

  const firstSearchMatch = useMemo(() => {
    if (!isSearching) return null;
    if (scopedWorkspaces.length > 0) {
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
  }, [
    filteredFlatSessions,
    filteredWorkspaces,
    isSearching,
    scopedWorkspaces.length,
  ]);

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
    storageKey: 'ultragamestudio.sidebarWidth.v1',
    defaultWidth: 240,
    min: 180,
    max: 480,
    edge: 'right',
  });
  const historyScrollRef = useAutoHideScroll<HTMLDivElement>();
  const showFlatCollapse =
    !isSearching &&
    flatLimit > WORKFLOW_HISTORY_PAGE_SIZE &&
    Math.min(flatLimit, filteredFlatSessions.length) >
      WORKFLOW_HISTORY_PAGE_SIZE;
  const showFlatLoadMore =
    !isSearching && filteredFlatSessions.length > flatLimit;

  return (
    <aside
      className="ugs-sidebar relative flex h-full shrink-0 flex-col border-r border-border bg-panel"
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
      <div className="ugs-sidebar-brand flex items-center gap-2 px-4 pt-4 pb-1">
        <span className="text-accent-2">◆</span>
        <span className="text-sm font-semibold tracking-tight text-fg">
          UltraGameStudio
        </span>
      </div>

      {!projectScoped && (
        <div className="px-3 pt-1 pb-0.5">
          <WorkspaceListSelect
            workspaces={workspaces}
            activeWorkspaceId={selectedWorkspaceId}
            locale={locale}
            onSelect={setWorkspace}
            onBrowseLocal={() => {
              void handleBrowseLocalWorkspace();
            }}
            // onAddRemote={handleOpenRemoteDialog} // 云端项目已退役。
            remoteConnectionStates={remoteConnectionStates}
          />
        </div>
      )}

      {/* Primary actions */}
      <nav aria-label="常用入口" className="mt-1 flex flex-col gap-0.5 px-2 pb-3 pt-2">
        <button
          type="button"
          onClick={() => { setSurface('chat'); newSession(); }}
          className={sidebarPrimaryButtonClassName}
        >
          <Plus size={16} className="shrink-0 text-fg-faint transition-colors group-hover:text-fg-dim" />
          <span>{t(locale, 'sidebar.newSession')}</span>
        </button>
        <button type="button" onClick={() => setSurface('message-platforms')} aria-current={surface === 'message-platforms' ? 'page' : undefined} className={`${sidebarPrimaryButtonClassName} ${surface === 'message-platforms' ? 'bg-panel-2 text-fg' : ''}`}>
          <MessageCircle size={16} className="shrink-0 text-fg-faint transition-colors group-hover:text-fg-dim" />
          <span>消息平台</span>
        </button>
        <button type="button" onClick={() => setSurface('scheduled-tasks')} aria-current={surface === 'scheduled-tasks' ? 'page' : undefined} className={`${sidebarPrimaryButtonClassName} ${surface === 'scheduled-tasks' ? 'bg-panel-2 text-fg' : ''}`}>
          <AlarmClock size={16} className="shrink-0 text-fg-faint transition-colors group-hover:text-fg-dim" />
          <span>{scheduleText(locale, 'title')}</span>
        </button>
        {assetCenterEnabled && (
          <button
            type="button"
            onClick={() => setSurface('artifacts')}
            aria-current={surface === 'artifacts' ? 'page' : undefined}
            title={t(locale, 'downloads.openHint')}
            className={`${sidebarPrimaryButtonClassName} ${surface === 'artifacts' ? 'bg-panel-2 text-fg' : ''}`}
          >
            <Download size={16} className="shrink-0 text-fg-faint transition-colors group-hover:text-fg-dim" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{t(locale, 'downloads.open')}</span>
            <span className={`ml-auto shrink-0 text-[11px] leading-4 tabular-nums ${assetActiveCount > 0 ? 'text-accent' : 'text-fg-faint'}`}>
              {assetTotalCount} {t(locale, 'downloads.countUnit')} · {assetActiveCount} {t(locale, 'downloads.activeShort')}
            </span>
          </button>
        )}
      </nav>

      {/* Session history */}
      <div className="flex min-h-0 flex-1 flex-col px-2 pb-3">
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
                className="ugs-history-search-input h-8 w-full min-w-0 appearance-none rounded-md border border-transparent bg-panel-2/40 pl-7 pr-7 text-[13px] text-fg outline-none transition-colors placeholder:text-fg-faint focus:border-border-soft focus:bg-panel-2/60 disabled:cursor-wait disabled:opacity-60"
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
        <div ref={historyScrollRef} className="min-h-0 flex-1 overflow-y-auto ugs-autohide-scroll">
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
          ) : isHistoryEmpty ? (
            <div
              role="status"
              aria-live="polite"
              className="px-2 py-3 text-xs text-fg-faint"
            >
              {t(locale, 'sidebar.emptySessions')}
            </div>
          ) : isSearching && totalMatchedSessions === 0 ? (
            searchPending ? (
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
            ) : (
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
            )
          ) : scopedWorkspaces.length > 0 ? (
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
                const isRemoteWorkspace = isRemoteWorkspacePath(workspace.path);
                const remoteConnectionState = isRemoteWorkspace
                  ? remoteConnectionStates[workspace.id]
                  : undefined;
                const remoteConnectionStatus =
                  remoteConnectionState?.status ?? 'checking';
                const remoteConnectionLabel = isRemoteWorkspace
                  ? remoteWorkspaceConnectionLabel(
                      locale,
                      remoteConnectionStatus,
                    )
                  : '';
                const remoteConnectionTitle =
                  remoteConnectionState?.detail && remoteConnectionLabel
                    ? `${remoteConnectionLabel}：${remoteConnectionState.detail}`
                    : remoteConnectionLabel;
                const projectScan = projectScanCache[workspace.id]?.scan;
                const projectState = projectHealth(workspace, projectScan);
                const headerPaths = workspaceHeaderPaths(workspace);
                const visibleHeaderPaths = headerPaths.slice(
                  0,
                  WORKSPACE_HEADER_VISIBLE_PATHS,
                );
                const hiddenHeaderPaths = headerPaths.slice(
                  WORKSPACE_HEADER_VISIBLE_PATHS,
                );
                return (
                  <li key={workspace.id} className="flex flex-col gap-1.5">
                    <div
                      onContextMenu={(e) => onWorkspaceContextMenu(e, workspace)}
                      className={
                        'ugs-sidebar-workspace group/ws grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1.5 rounded-md px-2.5 py-1.5 transition-colors ' +
                        (workspaceActive
                          ? 'bg-panel-2'
                          : 'bg-panel hover:bg-panel-2/60')
                      }
                    >
                      <button
                        type="button"
                        aria-expanded={!workspaceCollapsed}
                        aria-label={workspaceCollapsed ? t(locale, 'sidebar.expandWorkspaceSessions') : t(locale, 'sidebar.collapseWorkspaceSessions')}
                        title={workspaceCollapsed ? t(locale, 'sidebar.expandWorkspaceSessions') : t(locale, 'sidebar.collapseWorkspaceSessions')}
                        onClick={() => toggleWorkspaceCollapsed(workspace.id)}
                        className="ugs-control ugs-control--icon flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-faint transition-colors hover:bg-border-soft hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
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
                        title={
                          headerPaths.length > 0
                            ? headerPaths.join('\n')
                            : workspace.name
                        }
                        className="min-w-0 text-left"
                      >
                        <div className="flex min-w-0 items-center gap-2 text-[13px] font-semibold leading-5 text-fg">
                          <span
                            className={cn(
                              'h-2 w-2 shrink-0 rounded-full',
                              isRemoteWorkspace
                                ? remoteWorkspaceConnectionDotClassName(
                                    remoteConnectionStatus,
                                  )
                                : projectStatusClassName(projectState.tone),
                            )}
                            title={
                              isRemoteWorkspace
                                ? remoteConnectionTitle
                                : `${projectState.label}：${projectState.detail}`
                            }
                            aria-label={
                              isRemoteWorkspace
                                ? remoteConnectionLabel
                                : projectState.label
                            }
                          />
                          <span className="min-w-0 flex-1 truncate" title={workspace.name}>
                            {workspace.name}
                          </span>
                          {isRemoteWorkspace && (
                            <RemoteWorkspaceStatusBadge
                              state={remoteConnectionState}
                              locale={locale}
                              className="max-w-[5.75rem]"
                            />
                          )}
                        </div>
                        {visibleHeaderPaths.length > 0 && (
                          <div className="ugs-sidebar-meta mt-0.5 flex min-w-0 flex-col gap-0.5 pl-4 font-mono text-[11px] leading-4 text-fg-dim">
                            {visibleHeaderPaths.map((path) => (
                              <span
                                key={workspacePathKey(path)}
                                className="truncate"
                                title={path}
                              >
                                {path}
                              </span>
                            ))}
                            {hiddenHeaderPaths.length > 0 && (
                              <span
                                className="truncate"
                                title={hiddenHeaderPaths.join('\n')}
                              >
                                ...
                              </span>
                            )}
                          </div>
                        )}
                      </button>
                      <div className="flex h-6 shrink-0 items-center gap-1 self-center">
                        <span className="inline-flex h-5 min-w-6 items-center justify-center rounded border border-border-soft bg-bg-alt px-1.5 text-[11px] font-medium leading-none tabular-nums text-fg-dim">
                          {fullList.length}
                        </span>
                        <button
                          type="button"
                          title={t(locale, 'sidebar.moreWorkspaceActions')}
                          aria-label={t(locale, 'sidebar.moreWorkspaceActions')}
                          onClick={(e) => onWorkspaceMoreClick(e, workspace)}
                          className="ugs-control ugs-control--icon flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-faint transition-colors hover:bg-border-soft hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
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
                            sidebarLiveState,
                          );
                          const status = historyStatusTone(
                            session,
                            liveStatus,
                            draftSessionKeys.has(
                              workflowSessionKeyId(sessionKey),
                            ),
                          );
                          const sessionKeyId =
                            workflowSessionKeyId(sessionKey);
                          const runProgress =
                            runningSessionProgress[sessionKeyId] ??
                            jobSessionProgress[sessionKeyId];
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
                                    status,
                                  )}
                                  style={historySessionLightStyle(sessionKeyId)}
                                >
                                  <span className="grid w-full grid-cols-[minmax(0,1fr)_var(--ugs-status-slot-size)] items-center gap-1.5">
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
                                      className="min-w-0 rounded border border-border bg-panel px-1.5 py-0.5 text-sm text-fg outline-none transition-colors focus:border-accent disabled:cursor-wait disabled:opacity-60"
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
                                    <span className="text-[11px] leading-snug text-status-error">
                                      {renameError}
                                    </span>
                                  )}
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  aria-current={active ? 'true' : undefined}
                                  onClick={() => { setSurface('chat'); selectSession(session.id, workspace.id); }}
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
                                  className={historySessionRowClassName(active, status)}
                                  style={historySessionLightStyle(sessionKeyId)}
                                >
                                  <HistorySessionContent
                                    session={session}
                                    status={status}
                                    label={statusLabel}
                                    percent={runProgress?.percent}
                                    locale={locale}
                                  />
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
                    sidebarLiveState,
                  );
                  const status = historyStatusTone(
                    session,
                    liveStatus,
                    draftSessionKeys.has(workflowSessionKeyId(sessionKey)),
                  );
                  const sessionKeyId = workflowSessionKeyId(sessionKey);
                  const runProgress =
                    runningSessionProgress[sessionKeyId] ??
                    jobSessionProgress[sessionKeyId];
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
                        className={historySessionEditRowClassName(active, status)}
                        style={historySessionLightStyle(sessionKeyId)}
                      >
                        <span className="grid w-full grid-cols-[minmax(0,1fr)_var(--ugs-status-slot-size)] items-center gap-1.5">
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
                            className="min-w-0 rounded border border-border bg-panel px-1.5 py-0.5 text-sm text-fg outline-none transition-colors focus:border-accent disabled:cursor-wait disabled:opacity-60"
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
                          <span className="text-[11px] leading-snug text-status-error">
                            {renameError}
                          </span>
                        )}
                      </div>
                    ) : (
                      <button
                        type="button"
                        aria-current={active ? 'true' : undefined}
                        onClick={() => { setSurface('chat'); selectSession(session.id); }}
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
                        className={historySessionRowClassName(active, status)}
                        style={historySessionLightStyle(sessionKeyId)}
                      >
                        <HistorySessionContent
                          session={session}
                          status={status}
                          label={statusLabel}
                          percent={runProgress?.percent}
                          locale={locale}
                        />
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

      <div className="flex flex-col gap-1 p-3">
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          title={t(locale, 'settings.openHint')}
          className={cn(sidebarTextButtonClassName, 'relative')}
        >
          <span className="relative shrink-0">
            <SettingsGlyph
              size={17}
              className="text-fg-faint group-hover:text-fg"
              aria-hidden="true"
            />
            {cliUpdate.hasUnseenUpdate && (
              <span
                className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-status-error ring-2 ring-panel"
                aria-hidden="true"
              />
            )}
          </span>
          <span>{t(locale, 'settings.open')}</span>
          {cliUpdate.hasUnseenUpdate && (
            <span className="sr-only">{t(locale, 'settings.cliUpdate.badgeHint')}</span>
          )}
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
          sessionId={menu.sessionId}
          workspaceId={menu.workspaceId ?? activeWorkspaceId}
          historyRootPath={historyRootPath}
          isPinned={menuPinned}
          onTogglePinned={handleTogglePinned}
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
          directoryItems={workspaceHeaderPaths(workspaceMenu.workspace).map(
            (path) => ({
              path,
              disabled: isRemoteWorkspacePath(path),
            }),
          )}
          onOpenDirectory={handleOpenWorkspaceDirectory}
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
      {/* 云端项目已退役：保留原入口代码，不再挂载。
      {remoteDialog && (
        <RemoteWorkspaceDialog
          locale={locale}
          existing={remoteDialog.existing}
          onClose={() => setRemoteDialog(null)}
          onSaved={handleRemoteSaved}
        />
      )}
      */}
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
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-status-error/15 text-status-error">
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
            className="rounded-md border border-status-error/50 bg-status-error/15 px-3 py-1.5 text-sm font-semibold text-status-error transition-colors hover:bg-status-error/25"
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
  directoryItems,
  onOpenDirectory,
  onOpenSettings,
  onRemoveHistory,
  removeDisabledReason,
  onClose,
}: {
  x: number;
  y: number;
  locale: Locale;
  directoryItems: Array<{ path: string; disabled: boolean }>;
  onOpenDirectory: (path: string) => void;
  onOpenSettings: () => void;
  onRemoveHistory: () => void;
  removeDisabledReason: string | null;
  onClose: () => void;
}) {
  const openDirectoryLabel = t(locale, 'sidebar.openWorkspaceDirectory');
  const showDirectoryPath = directoryItems.length > 1;
  const directoryButtonClassName =
    'flex w-full max-w-[360px] items-start gap-2 px-3 py-2 text-left text-sm text-fg-dim transition-colors hover:bg-panel-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-fg-dim';

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
        className="absolute z-40 min-w-[196px] overflow-hidden rounded-md border border-border bg-panel shadow-2xl"
        style={{ left: x, top: y }}
      >
        {directoryItems.length > 0 ? (
          directoryItems.map((item) => (
            <button
              key={item.path}
              type="button"
              disabled={item.disabled}
              title={item.path}
              aria-label={
                showDirectoryPath
                  ? `${openDirectoryLabel}: ${item.path}`
                  : openDirectoryLabel
              }
              onClick={() => onOpenDirectory(item.path)}
              className={directoryButtonClassName}
            >
              <FolderOpen size={13} className="mt-0.5 shrink-0 text-fg-faint" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{openDirectoryLabel}</span>
                {showDirectoryPath && (
                  <span className="mt-0.5 block max-w-[300px] truncate text-xs text-fg-faint">
                    {item.path}
                  </span>
                )}
              </span>
            </button>
          ))
        ) : (
          <button
            type="button"
            disabled
            className={directoryButtonClassName}
          >
            <FolderOpen size={13} className="mt-0.5 shrink-0 text-fg-faint" />
            <span>{openDirectoryLabel}</span>
          </button>
        )}
        <button
          type="button"
          onClick={onOpenSettings}
          className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-sm text-fg-dim transition-colors hover:bg-panel-2 hover:text-fg"
        >
          <SettingsGlyph size={13} className="shrink-0 text-fg-faint" />
          <span>{t(locale, 'sidebar.projectSettings')}</span>
        </button>
        <button
          type="button"
          disabled={removeDisabledReason != null}
          title={removeDisabledReason ?? undefined}
          onClick={onRemoveHistory}
          className="flex w-full items-center gap-2 whitespace-nowrap border-t border-border-soft px-3 py-2 text-left text-sm text-status-error transition-colors hover:bg-panel-2 hover:text-status-error disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-status-error"
        >
          <Trash2 size={13} className="shrink-0 text-status-error/80" />
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
  sessionId,
  workspaceId,
  historyRootPath,
  isPinned,
  onTogglePinned,
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
  sessionId: string;
  workspaceId: string | null;
  historyRootPath: string | null;
  isPinned: boolean;
  onTogglePinned: () => void;
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
  const [copiedSessionId, setCopiedSessionId] = useState(false);

  const copySessionLocation = useCallback(async () => {
    const resolvedWorkspaceId = workspaceId ?? DEFAULT_WORKSPACE_ID;
    const relativePath = `workspaces/${resolvedWorkspaceId}/sessions/${sessionId}.json`;
    const root =
      historyRootPath && !historyRootPath.startsWith('localStorage://')
        ? historyRootPath
        : HISTORY_ROOT_DIR;
    const text = [
      `Session ID: ${sessionId}`,
      `Workspace ID: ${resolvedWorkspaceId}`,
      `File: ${root}/${relativePath}`,
    ].join('\n');
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        try {
          ta.select();
          document.execCommand('copy');
        } finally {
          if (ta.parentNode) ta.parentNode.removeChild(ta);
        }
      }
      setCopiedSessionId(true);
      window.setTimeout(() => {
        setCopiedSessionId(false);
        onClose();
      }, 1200);
    } catch {
      onClose();
    }
  }, [historyRootPath, onClose, sessionId, workspaceId]);

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
        <button
          type="button"
          onClick={onTogglePinned}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-fg-dim transition-colors hover:bg-panel-2 hover:text-fg"
        >
          {isPinned ? <PinOff size={13} className="text-accent" /> : <Pin size={13} className="text-fg-faint" />}
          <span>{t(locale, isPinned ? 'sidebar.unpinSession' : 'sidebar.pinSession')}</span>
        </button>
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
          onClick={() => void copySessionLocation()}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-fg-dim transition-colors hover:bg-panel-2 hover:text-fg"
        >
          {copiedSessionId ? (
            <Check size={13} className="text-accent-2" />
          ) : (
            <Copy size={13} className="text-fg-faint" />
          )}
          <span>
            {copiedSessionId
              ? t(locale, 'chat.copied')
              : t(locale, 'sidebar.copySessionLocation')}
          </span>
        </button>
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
