// Composer-draft disk persistence.
//
// `composerDraft` / `composerDrafts` in the Zustand store are pure UI state that
// lives only in memory. This module adds a *trailing-debounced* write of the
// active session's unsent draft into the session record's `meta.composerDraft`
// so a draft survives an app restart.
//
// Debounce (not per-keystroke write) matters: `historyStore.updateSession`
// rewrites the whole session JSON + rebuilds the session index + touches the
// workspace on every call, so a bare per-keystroke write would triple disk
// write amplification. `preserveUpdatedAt: true` keeps "typing a draft" from
// bumping the session to the top of the history list.
//
// The trailing window is the only loss bound: text typed in the final
// ~30s before a hard process kill can still be lost. Two paths close that
// window:
//   - `ugs:before-quit` (tray "退出") flushes via quitFlush.
//   - `beforeunload` (window close / reload / crash) flushes via a
//     `registerQuitFlushTask` hook installed by `installComposerDraftPersistFlush`.
//
// Clearing the composer (empty text) is NOT debounced. Deleting a draft is a
// terminal user action, and a stale non-empty draft left on disk resurrects the
// deleted text on the next launch — "I deleted it, then it came back". Empty
// drafts write through immediately (skipped only when the disk value is
// already known to be empty, so post-send clears don't rewrite big session
// JSON files).

import { historyStore } from './history/store';
import type { SessionOrigin } from './history/types';

interface PendingComposerDraft {
  workspaceId: string;
  sessionId: string;
  text: string;
  origin: Promise<SessionOrigin | null>;
}

export const COMPOSER_DRAFT_PERSIST_DEBOUNCE_MS = 30_000;

const pendingDrafts = new Map<string, PendingComposerDraft>();
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
const inFlightDrafts = new Map<string, Promise<void>>();
const inFlightOrigins = new Map<string, Promise<SessionOrigin | null>>();
// Last text known to be on disk per session ('' = confirmed empty). Lets the
// write-through clear path stay idempotent: the per-send `setComposerDraft('')`
// does not rewrite a multi-MB session JSON on every message.
const persistedTextByKey = new Map<string, { text: string; origin: SessionOrigin }>();

function sameOrigin(a: SessionOrigin, b: SessionOrigin): boolean {
  return a.generation === b.generation && a.createdAt === b.createdAt && a.sourceFingerprint === b.sourceFingerprint;
}

function draftKey(workspaceId: string, sessionId: string): string {
  return `${workspaceId}\u0000${sessionId}`;
}

/** Reset module state for tests. */
export function resetComposerDraftPersistForTests(): void {
  for (const timer of pendingTimers.values()) clearTimeout(timer);
  pendingTimers.clear();
  pendingDrafts.clear();
  inFlightDrafts.clear();
  inFlightOrigins.clear();
  persistedTextByKey.clear();
}

/**
 * Schedule a trailing-debounced persist of `text` as the draft of
 * (workspaceId, sessionId). Null ids are not persistable and are ignored.
 *
 * Empty `text` bypasses the debounce entirely (see the file header): a deleted
 * draft must be durable before the app can exit.
 */
export function scheduleComposerDraftPersist(
  workspaceId: string | null,
  sessionId: string | null,
  text: string,
): void {
  if (!workspaceId || !sessionId) return;
  const key = draftKey(workspaceId, sessionId);
  const timer = pendingTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    pendingTimers.delete(key);
  }
  // Bind the first edit to its persisted incarnation before deletion/recreation
  // can reuse the same id. Later edits and retries keep that exact origin.
  const origin = pendingDrafts.get(key)?.origin ?? inFlightOrigins.get(key)
    ?? historyStore.getSessionForGeneration(workspaceId, sessionId, { captureKnownOrigin: true }).then((record) => record ? {
      generation: record.generation, createdAt: record.createdAt, sourceFingerprint: record.sourceFingerprint,
    } : null);
  // Observe a failed read now; flush must still reject rather than rebind it to
  // a replacement or mistake unavailable/corrupt backing storage for deletion.
  void origin.catch(() => {});
  pendingDrafts.set(key, { workspaceId, sessionId, text, origin });

  if (!text) {
    void flushComposerDraftPersist(key).catch((err) => console.error('[composer-draft] failed to persist draft', err));
    return;
  }

  pendingTimers.set(
    key,
    setTimeout(() => {
      pendingTimers.delete(key);
      void flushComposerDraftPersist(key).catch((err) => console.error('[composer-draft] failed to persist draft', err));
    }, COMPOSER_DRAFT_PERSIST_DEBOUNCE_MS),
  );
}

function flushComposerDraft(
  key: string,
  next: PendingComposerDraft,
): Promise<void> {
  const timer = pendingTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    pendingTimers.delete(key);
  }
  pendingDrafts.delete(key);
  const write = (async () => {
    const origin = await next.origin;
    if (!origin) {
      persistedTextByKey.delete(key);
      return;
    }
    const persisted = persistedTextByKey.get(key);
    if (!next.text && persisted?.text === '' && sameOrigin(origin, persisted.origin)) return;
    // Validate presence/incarnation inside the real write lane, not via a
    // forgiving cached read or an error-string catch after updateSession.
    const result = await historyStore.updateSessionIfGeneration(next.workspaceId, next.sessionId, origin, {
      meta: { composerDraft: next.text },
      preserveUpdatedAt: true,
    });
    if (result) persistedTextByKey.set(key, { text: next.text, origin });
    else persistedTextByKey.delete(key);
  })().catch((err: unknown) => {
    // A newer edit supersedes the failed value; otherwise retain this exact
    // draft so a later explicit quit can retry it.
    if (!pendingDrafts.has(key)) pendingDrafts.set(key, next);
    throw err;
  }).finally(() => {
    if (inFlightDrafts.get(key) === write) {
      inFlightDrafts.delete(key);
      inFlightOrigins.delete(key);
    }
  });
  inFlightDrafts.set(key, write);
  inFlightOrigins.set(key, next.origin);
  return write;
}

/**
 * Immediately write the pending draft(s). With a `key` only that session's
 * draft is written; without one every pending draft is flushed (quit path).
 * Safe to call on quit: the writes are awaited so callers can wait on the
 * returned promise before releasing the process.
 */
export async function flushComposerDraftPersist(key?: string): Promise<void> {
  const flushKey = async (pendingKey: string): Promise<void> => {
    for (;;) {
      const inFlight = inFlightDrafts.get(pendingKey);
      if (inFlight) {
        await inFlight;
        continue;
      }
      const next = pendingDrafts.get(pendingKey);
      if (!next) return;
      await flushComposerDraft(pendingKey, next);
    }
  };
  if (key !== undefined) return flushKey(key);
  // Bound admission even when hundreds of sessions have pending drafts.
  while (pendingDrafts.size || inFlightDrafts.size) {
    const nextKey = inFlightDrafts.keys().next().value ?? pendingDrafts.keys().next().value;
    if (nextKey === undefined) return;
    await flushKey(nextKey);
  }
}

/**
 * Quit-flush hook for composer drafts, registered from `main.tsx` via
 * `registerQuitFlushTask`. Without it a draft change (including a deletion)
 * inside the debounce window is lost when the window closes or the webview
 * reloads instead of going through the tray "退出" handshake — the tray path
 * is already covered by `quitFlush.ts`. The fs write is async, so on the
 * `beforeunload` leg this is best-effort.
 */
export function flushComposerDraftsOnQuit(): void {
  void flushComposerDraftPersist().catch((err) => console.error('[composer-draft] failed to persist draft', err));
}
