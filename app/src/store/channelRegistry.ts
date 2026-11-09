// Channel registry — owns the run/AI-edit channel Maps and the PURE read-only
// accessors over them.
//
// Extracted from useStore.ts as the core step of the streaming-logic
// decomposition (architect M3). This module imports only channel types and the
// pure session-key helpers — NOT useStore — so it cannot join the store import
// cycle. The Maps are exported so the side-effecting mutators that remain in
// useStore (addAiEditChannel/removeAiEditChannel/rememberAiEditSnapshot, run
// start/teardown) can write them; everything that only READS the Maps lives here.
//
// Split of responsibility:
//   - channelRegistry.ts (here): channel state + pure reads.
//   - useStore.ts: mutations, store-sync (setState), and persistence callbacks.
import type { AiEditChannel, RunChannel } from './channelTypes';
import { channelMatchesSession, runKey } from './sessionKey';

export const activeRuns = new Map<string, RunChannel>();
export const activeAiEdits = new Map<string, AiEditChannel>();
export const aiEditSnapshots = new Map<string, AiEditChannel>();

export const AI_EDIT_COMPLETED_SNAPSHOT_LIMIT = 32;

/** Live channels and not-yet-durable finals are never evicted. */
export function pruneAiEditSnapshots(isDurable: (snapshot: AiEditChannel) => boolean): void {
  const completed = [...aiEditSnapshots.values()].filter((snapshot) => !activeAiEdits.has(snapshot.key));
  let excess = completed.length - AI_EDIT_COMPLETED_SNAPSHOT_LIMIT;
  for (const snapshot of completed) {
    if (excess <= 0) break;
    if (!isDurable(snapshot)) continue;
    aiEditSnapshots.delete(snapshot.key);
    excess -= 1;
  }
}

export function getRunChannel(
  workspaceId: string | null,
  sessionId: string | null,
): RunChannel | null {
  return activeRuns.get(runKey(workspaceId, sessionId)) ?? null;
}

export function getRunChannelByKey(key: string): RunChannel | null {
  return activeRuns.get(key) ?? null;
}

export function getAiEditChannelByKey(key: string): AiEditChannel | null {
  return activeAiEdits.get(key) ?? null;
}

export function getAiEditChannel(
  workspaceId: string | null,
  sessionId: string | null,
): AiEditChannel | null {
  const key = runKey(workspaceId, sessionId);
  return (
    activeAiEdits.get(key) ??
    getAiEditChannelsForSession(workspaceId, sessionId).find((ch) => !ch.chat) ??
    null
  );
}

export function getAiEditSnapshot(
  workspaceId: string | null,
  sessionId: string | null,
): AiEditChannel | null {
  const key = runKey(workspaceId, sessionId);
  const exact = aiEditSnapshots.get(key);
  if (exact) return exact;
  const snapshots = getAiEditSnapshotsForSession(workspaceId, sessionId);
  return snapshots[snapshots.length - 1] ?? null;
}

/**
 * Best message-source for restoring the AI-return view when switching back into
 * a session. Prefers the LIVE channel (so we get the freshest in-flight text —
 * snapshots can lag a single chunk behind), then any chat channel for the
 * session (chat channels are deliberately excluded from getAiEditChannel because
 * they don't lock the workflow), and finally the snapshot map. Returning the
 * snapshot last means a session whose stream finished a while ago (channel
 * removed but snapshot retained) still restores its final messages.
 */
export function getAiEditViewSource(
  workspaceId: string | null,
  sessionId: string | null,
): AiEditChannel | null {
  const channels = getAiEditChannelsForSession(workspaceId, sessionId);
  if (channels.length > 0) {
    // Prefer blueprint-edit (non-chat); fall back to the most recently added chat
    // channel, which carries the live streaming bubble for a simple-workflow turn.
    return (
      channels.find((ch) => !ch.chat) ??
      channels[channels.length - 1]
    );
  }
  return getAiEditSnapshot(workspaceId, sessionId);
}

export function getAiEditChannelsForSession(
  workspaceId: string | null,
  sessionId: string | null,
): AiEditChannel[] {
  return [...activeAiEdits.values()].filter((ch) =>
    channelMatchesSession(ch, workspaceId, sessionId),
  );
}

export function getAiEditChatChannels(
  workspaceId: string | null,
  sessionId: string | null,
): AiEditChannel[] {
  return getAiEditChannelsForSession(workspaceId, sessionId).filter(
    (ch) => ch.chat,
  );
}

export function getAiEditSnapshotsForSession(
  workspaceId: string | null,
  sessionId: string | null,
): AiEditChannel[] {
  return [...aiEditSnapshots.values()].filter((ch) =>
    channelMatchesSession(ch, workspaceId, sessionId),
  );
}

export function activeRunChannels(): RunChannel[] {
  return [...activeRuns.values()].filter((ch) => !ch.cancelled);
}

export function activeAiEditChannels(): AiEditChannel[] {
  return [...activeAiEdits.values()];
}

export function aiEditRegistered(
  ch: AiEditChannel | null,
): ch is AiEditChannel {
  return !!ch && activeAiEdits.get(ch.key) === ch;
}

/**
 * Force-teardown every still-active run channel. Used as a safety net when a
 * run's executor promise threw without reaching its normal cleanup path
 * (uncaught exception inside executeViaCliInterpreter / executeViaSimulator),
 * or when the host is tearing down (HMR, beforeunload, session wipe).
 *
 * The registry itself only flips `cancelled` and drops the channel from the
 * Map; the side-effecting teardown (commit interrupted snapshot, flip UI back
 * to design mode, cancel child CLI processes) is delegated to the caller via
 * `teardown` so this module stays free of useStore imports.
 *
 * Returns the channels that were aborted (useful for logging).
 */
export function abortAllPendingRuns(
  teardown: (ch: RunChannel) => void,
): RunChannel[] {
  const aborted: RunChannel[] = [];
  for (const ch of [...activeRuns.values()]) {
    if (ch.cancelled) continue;
    ch.cancelled = true;
    aborted.push(ch);
    try {
      teardown(ch);
    } catch {
      /* never let a teardown error abort the loop — keep clearing the map */
    }
    activeRuns.delete(ch.key);
  }
  return aborted;
}

