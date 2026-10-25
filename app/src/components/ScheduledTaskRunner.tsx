import { useEffect, useMemo, useRef } from 'react';
import { sessionLiveStatus, useStore } from '@/store/useStore';
import { scheduledTaskOccurrence } from '@/lib/scheduledTasks';
import { collectScheduledSessions } from '@/lib/scheduledTaskSessions';

// Serialize activation + dispatch so simultaneous schedules cannot send to the wrong conversation.
let scheduleQueue = Promise.resolve();
const pendingKeys = new Set<string>();

export default function ScheduledTaskRunner() {
  const sessions = useStore((s) => s.sessions);
  const sessionTree = useStore((s) => s.sessionTree);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const lastCheck = useRef(Date.now() - 60000);
  const scheduledSessions = useMemo(() => collectScheduledSessions(sessions, sessionTree, activeWorkspaceId), [sessions, sessionTree, activeWorkspaceId]);

  useEffect(() => {
    const check = () => {
      const now = new Date();
      const since = lastCheck.current;
      lastCheck.current = now.getTime();
      for (const { session, workspaceId, scheduledTask } of scheduledSessions) {
        const target = { sessionId: session.id, workspaceId };
        if (sessionLiveStatus(target, useStore.getState())) continue;
        let occurrence: number | null;
        try { occurrence = scheduledTaskOccurrence(scheduledTask, now, since); }
        catch (error) { console.error('[scheduled-task] Invalid schedule', session.id, error); continue; }
        if (occurrence === null) continue;
        const key = `${workspaceId ?? ''}/${session.id}/${occurrence}`;
        if (pendingKeys.has(key)) continue;
        pendingKeys.add(key);
        scheduleQueue = scheduleQueue.then(async () => {
          const state = useStore.getState();
          const currentTask = () => {
            const current = useStore.getState();
            return collectScheduledSessions(current.sessions, current.sessionTree, current.activeWorkspaceId).find((entry) => entry.session.id === session.id && entry.workspaceId === workspaceId)?.scheduledTask;
          };
          const latest = currentTask();
          if (!latest?.enabled || latest.updatedAt !== scheduledTask.updatedAt || (latest.lastRunAt ?? 0) >= occurrence || sessionLiveStatus(target, state)) return;
          try {
            await state.runScheduledTaskSession(session.id, workspaceId, latest);
            // A user may pause, edit or delete while activation is awaiting disk IO.
            if (currentTask()?.updatedAt !== latest.updatedAt) return;
            await useStore.getState().setWorkflowScheduledTaskSession(session.id, workspaceId, { ...latest, enabled: latest.repeat && latest.onceAt === undefined, lastRunAt: Date.now(), lastError: undefined, updatedAt: Date.now() });
          } catch (error) {
            console.error('[scheduled-task] Run failed', session.id, error);
            if (currentTask()?.updatedAt !== latest.updatedAt) return;
            await useStore.getState().setWorkflowScheduledTaskSession(session.id, workspaceId, { ...latest, lastError: String(error), updatedAt: Date.now() });
          }
        }).catch((error) => console.error('[scheduled-task] Could not save run state', error)).finally(() => pendingKeys.delete(key));
      }
    };
    check();
    const timer = window.setInterval(check, 1000);
    return () => window.clearInterval(timer);
  }, [scheduledSessions]);
  return null;
}
