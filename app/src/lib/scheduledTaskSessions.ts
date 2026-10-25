import type { ScheduledTaskConfig, Session } from '@/store/types';

export interface ScheduledSession {
  session: Session;
  workspaceId: string | null;
  scheduledTask: ScheduledTaskConfig;
}

/** Include independent tasks and legacy favorite schedules; deduplicate the active workspace. */
export function collectScheduledSessions(sessions: Session[], sessionTree: Record<string, Session[]>, activeWorkspaceId: string | null): ScheduledSession[] {
  const result = new Map<string, ScheduledSession>();
  for (const [workspaceId, list] of Object.entries(sessionTree)) {
    for (const session of list) {
      if (session.scheduledTask) result.set(`${workspaceId}/${session.id}`, { session, workspaceId, scheduledTask: session.scheduledTask });
    }
  }
  for (const session of sessions) {
    const workspaceId = session.workspaceId ?? activeWorkspaceId;
    if (session.scheduledTask) result.set(`${workspaceId ?? ''}/${session.id}`, { session, workspaceId, scheduledTask: session.scheduledTask });
  }
  return [...result.values()];
}
