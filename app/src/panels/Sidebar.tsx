import { useState, useCallback, useEffect } from 'react';
import StatusIndicator, { type StatusTone } from '@/components/StatusIndicator';
import {
  sessionLiveStatus,
  useStore,
  workflowSessionKeyId,
} from '@/store/useStore';
import type { Session } from '@/store/types';
import type { Locale } from '@/lib/i18n';
import { useResizableWidth } from '@/lib/useResizableWidth';
import { t } from '@/lib/i18n';
import SettingsModal from './SettingsModal';

/**
 * CONTRACT: default export, no props. Left session rail.
 *
 * Top  : primary action — "+ New Workflow".
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

const PAGE_SIZE = 20;

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
  session: Pick<Session, 'isWorkflow' | 'runStatus'>,
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
  return session.isWorkflow ? 'unrun' : null;
}

export default function Sidebar() {
  const locale = useStore((s) => s.locale);
  const sessions = useStore((s) => s.sessions);
  const workspaces = useStore((s) => s.workspaces);
  const sessionTree = useStore((s) => s.sessionTree);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const runningSessions = useStore((s) => s.runningSessions);
  const runningSessionProgress = useStore((s) => s.runningSessionProgress);
  const aiEditingSessions = useStore((s) => s.aiEditingSessions);
  const newWorkflow = useStore((s) => s.newWorkflow);
  const selectSession = useStore((s) => s.selectSession);
  const deleteSession = useStore((s) => s.deleteSession);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workspaceLimits, setWorkspaceLimits] = useState<Record<string, number>>({});
  const [flatLimit, setFlatLimit] = useState(PAGE_SIZE);

  // ── Context menu for session deletion ────────────────────────────────────
  type MenuState =
    | null
    | {
        x: number;
        y: number;
        sessionId: string;
        workspaceId: string | null;
        title: string;
      };

  const [menu, setMenu] = useState<MenuState>(null);

  const onSessionContextMenu = useCallback(
    (
      event: React.MouseEvent,
      sessionId: string,
      workspaceId: string | null,
      title: string,
    ) => {
      event.preventDefault();
      const aside = event.currentTarget.closest('aside');
      if (!aside) return;
      const rect = aside.getBoundingClientRect();
      setMenu({
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        sessionId,
        workspaceId,
        title,
      });
    },
    [],
  );

  const handleDelete = useCallback(() => {
    if (!menu) return;
    const confirmed = window.confirm(
      t(locale, 'sidebar.deleteConfirm').replace('{title}', menu.title),
    );
    if (confirmed) {
      deleteSession(menu.sessionId, menu.workspaceId ?? undefined);
    }
    setMenu(null);
  }, [menu, locale, deleteSession]);

  /** Close the context menu on Escape. */
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu]);

  const loadMoreWorkspace = useCallback((workspaceId: string) => {
    setWorkspaceLimits((prev) => ({
      ...prev,
      [workspaceId]: (prev[workspaceId] ?? PAGE_SIZE) + PAGE_SIZE,
    }));
  }, []);

  const loadMoreFlat = useCallback(() => {
    setFlatLimit((prev) => prev + PAGE_SIZE);
  }, []);

  const { width, onResizeStart } = useResizableWidth({
    storageKey: 'openworkflow.sidebarWidth.v1',
    defaultWidth: 240,
    min: 180,
    max: 480,
    edge: 'right',
  });

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
          OpenWorkflows
        </span>
      </div>

      {/* Primary actions */}
      <div className="px-3 pt-3 pb-2.5">
        <button
          type="button"
          onClick={newWorkflow}
          className="flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <span className="text-base leading-none">＋</span>
          {t(locale, 'sidebar.newWorkflow')}
        </button>
      </div>

      {/* Session history */}
      <div className="flex min-h-0 flex-1 flex-col px-2 pb-3">
        <div className="px-2 pb-1.5 pt-0 text-[11px] font-medium uppercase tracking-wider text-fg-faint">
          {t(locale, 'sidebar.history')}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {workspaces.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {workspaces.map((workspace) => {
                const list = sessionTree[workspace.id] ?? [];
                return (
                  <li key={workspace.id} className="flex flex-col gap-1">
                    <div className="px-2 py-1">
                      <div className="flex items-center gap-1.5 text-[11px] font-medium text-fg">
                        <span className="text-accent-2">▾</span>
                        <span className="min-w-0 flex-1 truncate" title={workspace.path}>
                          {workspace.name}
                        </span>
                        <span className="font-mono text-[10px] text-fg-faint">
                          {workspace.sessionCount}
                        </span>
                      </div>
                      {workspace.path && (
                        <div className="truncate pl-4 font-mono text-[9px] text-fg-faint">
                          {workspace.path}
                        </div>
                      )}
                    </div>
                    {list.length === 0 ? (
                      <div className="px-6 py-1 text-xs text-fg-faint">
                        {t(locale, 'sidebar.emptySessions')}
                      </div>
                    ) : (
                      <ul className="flex flex-col gap-0.5">
                        {list.slice(0, workspaceLimits[workspace.id] ?? PAGE_SIZE).map((session) => {
                          const active =
                            session.id === activeSessionId &&
                            workspace.id === activeWorkspaceId;
                          const sessionKey = {
                            workspaceId: workspace.id,
                            sessionId: session.id,
                          };
                          const liveStatus = sessionLiveStatus(
                            sessionKey,
                            { runningSessions, aiEditingSessions },
                          );
                          const status = historyStatusTone(session, liveStatus);
                          const runProgress =
                            runningSessionProgress[workflowSessionKeyId(sessionKey)];
                          const statusLabel = historyStatusLabel(
                            locale,
                            status,
                            runProgress?.percent,
                          );
                          return (
                            <li key={session.id}>
                              <button
                                type="button"
                                onClick={() => selectSession(session.id, workspace.id)}
                                onContextMenu={(e) =>
                                  onSessionContextMenu(
                                    e,
                                    session.id,
                                    workspace.id,
                                    session.title,
                                  )
                                }
                                className={
                                  'group flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors ' +
                                  (active
                                    ? 'bg-panel-2 text-fg'
                                    : 'text-fg-dim hover:bg-border-soft hover:text-fg') +
                                  ' disabled:cursor-not-allowed disabled:opacity-50'
                                }
                              >
                                <span className="grid w-full grid-cols-[auto_minmax(0,1fr)_var(--owf-status-slot-size)] items-center gap-1.5">
                                  <span
                                    className={
                                      'rounded border px-1 font-mono text-[9px] leading-4 ' +
                                      (session.isWorkflow
                                        ? 'border-accent-2/50 text-accent-2'
                                        : 'border-border text-fg-faint')
                                    }
                                  >
                                    {session.isWorkflow ? 'WF' : 'CHAT'}
                                  </span>
                                  <span className="min-w-0 flex-1 truncate text-sm">
                                    {session.title}
                                  </span>
                                  <StatusIndicator
                                    label={statusLabel}
                                    tone={status}
                                  />
                                </span>
                                <span className="flex w-full items-center gap-1 pl-10 font-mono text-[10px] text-fg-faint">
                                  <span>{formatTime(session.updatedAt ?? session.createdAt)}</span>
                                  {session.preview && (
                                    <span className="min-w-0 flex-1 truncate">
                                      {session.preview}
                                    </span>
                                  )}
                                </span>
                              </button>
                            </li>
                          );
                        })}
                        {list.length > (workspaceLimits[workspace.id] ?? PAGE_SIZE) && (
                          <li className="px-2 py-1">
                            <button
                              type="button"
                              onClick={() => loadMoreWorkspace(workspace.id)}
                              className="w-full rounded-md px-2 py-1.5 text-left text-sm text-fg-dim transition-colors hover:bg-border-soft hover:text-fg"
                            >
                              {t(locale, 'sidebar.loadMore')}
                            </button>
                          </li>
                        )}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : sessions.length === 0 ? (
            <div className="px-2 py-3 text-xs text-fg-faint">
              {t(locale, 'sidebar.emptySessions')}
            </div>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {sessions.slice(0, flatLimit).map((session) => {
                const active = session.id === activeSessionId;
                const sessionKey = { workspaceId: null, sessionId: session.id };
                const liveStatus = sessionLiveStatus(
                  sessionKey,
                  { runningSessions, aiEditingSessions },
                );
                const status = historyStatusTone(session, liveStatus);
                const runProgress =
                  runningSessionProgress[workflowSessionKeyId(sessionKey)];
                const statusLabel = historyStatusLabel(
                  locale,
                  status,
                  runProgress?.percent,
                );
                return (
                  <li key={session.id}>
                    <button
                      type="button"
                      onClick={() => selectSession(session.id)}
                      onContextMenu={(e) =>
                        onSessionContextMenu(
                          e,
                          session.id,
                          null,
                          session.title,
                        )
                      }
                      className={
                        'group flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors ' +
                        (active
                          ? 'bg-panel-2 text-fg'
                          : 'text-fg-dim hover:bg-border-soft hover:text-fg') +
                        ' disabled:cursor-not-allowed disabled:opacity-50'
                      }
                    >
                      <span className="grid w-full grid-cols-[auto_minmax(0,1fr)_var(--owf-status-slot-size)] items-center gap-1.5">
                        <span
                          className={
                            'text-[10px] leading-none ' +
                            (active ? 'text-accent-2' : 'text-fg-faint')
                          }
                        >
                          ●
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm">
                          {session.title}
                        </span>
                        <StatusIndicator label={statusLabel} tone={status} />
                      </span>
                      <span className="pl-3.5 font-mono text-[10px] text-fg-faint">
                        {formatTime(session.createdAt)}
                      </span>
                    </button>
                  </li>
                );
              })}
              {sessions.length > flatLimit && (
                <li className="px-2 py-1">
                  <button
                    type="button"
                    onClick={loadMoreFlat}
                    className="w-full rounded-md px-2 py-1.5 text-left text-sm text-fg-dim transition-colors hover:bg-border-soft hover:text-fg"
                  >
                    {t(locale, 'sidebar.loadMore')}
                  </button>
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

      {menu && (
        <SessionContextMenu
          x={menu.x}
          y={menu.y}
          locale={locale}
          onDelete={handleDelete}
          onClose={() => setMenu(null)}
        />
      )}
    </aside>
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
  onDelete,
  onClose,
}: {
  x: number;
  y: number;
  locale: Locale;
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
        <button
          type="button"
          onClick={onDelete}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-fg-dim transition-colors hover:bg-panel-2 hover:text-fg"
        >
          <span className="text-fg-faint">🗑</span>
          <span>{t(locale, 'sidebar.deleteSession')}</span>
        </button>
      </div>
    </>
  );
}
