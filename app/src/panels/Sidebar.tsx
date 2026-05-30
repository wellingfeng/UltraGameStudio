import { useStore } from '@/store/useStore';
import { openWorkflow } from '@/lib/persist';
import { useResizableWidth } from '@/lib/useResizableWidth';

/**
 * CONTRACT: default export, no props. Left session rail.
 *
 * Top  : primary actions — "+ New Workflow" / "+ New Session".
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

export default function Sidebar() {
  const sessions = useStore((s) => s.sessions);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const newWorkflow = useStore((s) => s.newWorkflow);
  const newSession = useStore((s) => s.newSession);
  const setWorkflow = useStore((s) => s.setWorkflow);
  const markSaved = useStore((s) => s.markSaved);

  const { width, onResizeStart } = useResizableWidth({
    storageKey: 'openworkflow.sidebarWidth.v1',
    defaultWidth: 240,
    min: 180,
    max: 480,
    edge: 'right',
  });

  // Open a .owf.json from disk (Tauri) or localStorage (browser fallback).
  // On success we replace the in-memory IR and mark the editor clean so the
  // toolbar reads "已保存" immediately after load.
  const handleOpen = async () => {
    try {
      const loaded = await openWorkflow();
      if (!loaded) return; // user cancelled or nothing to load
      setWorkflow(loaded.ir);
      markSaved(loaded.path ?? undefined);
    } catch {
      /* ignore — open errors stay quiet; user can retry */
    }
  };

  return (
    <aside
      className="relative flex h-full shrink-0 flex-col border-r border-border bg-panel"
      style={{ width }}
    >
      {/* Resize handle — right edge, drag horizontally. */}
      <div
        onMouseDown={onResizeStart}
        title="拖动调整宽度"
        className="group absolute -right-1 top-0 bottom-0 z-20 flex w-2 cursor-col-resize items-center justify-center"
      >
        <div className="h-full w-0.5 bg-transparent transition-colors group-hover:bg-accent/40" />
      </div>

      {/* Brand */}
      <div className="flex items-center gap-2 border-b border-border-soft px-4 py-3.5">
        <span className="text-accent-2">◆</span>
        <span className="text-sm font-semibold tracking-tight text-fg">
          OpenWorkflow
        </span>
      </div>

      {/* Primary actions */}
      <div className="flex flex-col gap-2 p-3">
        <button
          type="button"
          onClick={newWorkflow}
          className="flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-bg transition-opacity hover:opacity-90"
        >
          <span className="text-base leading-none">＋</span>
          新建 Workflow
        </button>
        <button
          type="button"
          onClick={() => void handleOpen()}
          className="flex items-center gap-2 rounded-md border border-border bg-panel-2 px-3 py-2 text-sm text-fg transition-colors hover:border-accent hover:bg-border-soft"
        >
          <span className="text-base leading-none">⤓</span>
          打开
        </button>
        <button
          type="button"
          onClick={newSession}
          className="flex items-center gap-2 rounded-md border border-border bg-panel-2 px-3 py-2 text-sm text-fg transition-colors hover:border-accent hover:bg-border-soft"
        >
          <span className="text-base leading-none">＋</span>
          新建会话
        </button>
      </div>

      {/* Session history */}
      <div className="flex min-h-0 flex-1 flex-col px-2 pb-3">
        <div className="px-2 pb-1.5 pt-1 text-[11px] font-medium uppercase tracking-wider text-fg-faint">
          历史记录
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {sessions.length === 0 ? (
            <div className="px-2 py-3 text-xs text-fg-faint">暂无会话</div>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {sessions.map((session) => {
                const active = session.id === activeSessionId;
                return (
                  <li key={session.id}>
                    <button
                      type="button"
                      className={
                        'group flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors ' +
                        (active
                          ? 'bg-panel-2 text-fg'
                          : 'text-fg-dim hover:bg-border-soft hover:text-fg')
                      }
                    >
                      <span className="flex w-full items-center gap-1.5">
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
                      </span>
                      <span className="pl-3.5 font-mono text-[10px] text-fg-faint">
                        {formatTime(session.createdAt)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </aside>
  );
}
