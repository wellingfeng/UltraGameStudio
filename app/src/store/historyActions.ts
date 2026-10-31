import { CLOUD_PROJECTS_ENABLED, isSupportedWorkspacePath } from '@/lib/cloudProjects';
import { SCHEDULED_TASK_SCOPE } from '@/lib/scheduledTaskScope';
// ARCHITECTURAL CONSTRAINT — do not break the import cycle.
// This module is NOT a Zustand slice (no createXxxSlice(set, get) factory). It is
// a call-time *actions* module: it imports `useStore` from './useStore' while
// './useStore' imports the action functions from here, forming a deliberate
// import cycle. The cycle is only safe because every reference below is used
// EXCLUSIVELY inside function bodies (evaluated after the store is fully built),
// never at module-eval time.
//
// RULES (enforced by convention — ESLint cannot detect module-eval-time usage):
//   1. NEVER reference any './useStore' import at module top-level (no
//      `const x = useStore.getState()`, no calling an imported helper outside a
//      function body). A single such line silently yields `undefined` at startup.
//   2. This file must only be imported by './useStore' (enforced via
//      no-restricted-imports in .eslintrc.cjs) so the cycle stays a single edge.
//   3. If you need slice-style state ownership, convert this to a real
//      createXxxSlice(set, get) in a *Slice.ts file instead of extending the cycle.
// Extracted verbatim from useStore.ts (the history-bootstrap, favorite/scheduled
// persistence, and workspace-folder domain).

// --- store internals (the cycle edge; used only inside function bodies) ---
import {
  useStore,
  isActiveAiEditingSession,
  activeWorkflowSessionKey,
  sessionMatchesTarget,
  sessionFromRecord,
  sessionFromSummary,
  summaryFromRecord,
  normalizeScheduledTask,
  pruneScheduledTaskHistory,
  sessionLiveStatus,
  visibleChatSessionSummaries,
  loadSessionTree,
  beginHistoryNavigation,
  isLatestHistoryNavigation,
  restoreWorkflowRunSnapshot,
  runProgressFromSnapshot,
  emptyRunProgress,
  canvasViewportForSession,
  historicalGatewaySelectionFromMessages,
  composerPatchForSession,
  composerDraftPatchForSessionFromRecord,
  defaultSessionComposer,
  workspaceFoldersFromMetadata,
  saveComposerSoon,
  WORKSPACE_HISTORY_LIMIT,
  normalizeComposerSettings,
  workspaceHistoryWithRecentPaths,
  composerWorkspacePaths,
  normalizeWorkspaceFolderList,
  rememberSessionComposer,
  composerCliWorkspaceOptions,
} from './useStore';

// --- types ---
import type { Session, ScheduledTaskConfig, SessionComposerSettings } from './types';

// --- same-dir helpers ---
import { historyStore } from './history/store';
import { HISTORY_SCHEMA_VERSION } from './history/types';
import { workflowSessionKeyId } from './sessionKey';

// --- lib leaf imports ---
import {
  normalizeWorkspacePath,
  workspaceHistoryWithRecent,
  workspacePathKey,
} from '@/lib/workspaceHistory';
import {
  workflowDefaultGatewaySelection,
  withoutWorkflowGatewayDefaults,
} from '@/lib/modelGateway/resolver';
import { simpleBlueprint } from '@/core/defaultBlueprint';
import { scheduleText } from '@/lib/scheduledTaskI18n';
import { loadComposer } from '@/lib/composerStorage';
import { maybeRunCcSwitchAutoImportOnFirstRun } from '@/lib/ccSwitchAutoImport';
import { isTauri, prepareIsolatedWorkspace } from '@/lib/tauri';
import {
  getRemoteWorkspace,
  isRemoteWorkspacePath,
  purgeDefaultRemoteWorkspaces,
  remoteWorkspaceIdFromPath,
  remoteWorkspacePath,
} from '@/lib/remoteWorkspace';

/**
 * 一次性清理「内置默认云端 Runner 自动预填」遗留的幽灵云端工作区。
 * 同时清掉 localStorage 配置（remoteWorkspace 内部处理）和历史工作区索引里
 * 对应的 `remote://` 记录，避免本地项目继续被显示成云端。
 */
async function purgeGhostRemoteWorkspaces(): Promise<void> {
  // 功能退役后不再清理或改写用户已有云端数据。
  if (!CLOUD_PROJECTS_ENABLED) return;
  let removedIds: string[] = [];
  try {
    removedIds = purgeDefaultRemoteWorkspaces();
  } catch {
    return;
  }
  if (removedIds.length === 0) return;
  const removedPaths = new Set(removedIds.map((id) => remoteWorkspacePath(id)));
  try {
    const workspaces = await historyStore.listWorkspaces();
    for (const workspace of workspaces) {
      if (workspace.path && removedPaths.has(workspace.path)) {
        await historyStore.deleteWorkspace(workspace.id, false);
      }
    }
  } catch {
    /* non-fatal: localStorage config already cleared */
  }
}

export async function setWorkflowFavoriteHistorySession(
  sessionId: string,
  workspaceId: string | null,
  favorite: boolean,
): Promise<void> {
  const state = useStore.getState();
  if (!workspaceId || !state.historyReady) {
    const localSessions = workspaceId
      ? state.sessionTree[workspaceId] ?? state.sessions
      : state.sessions;
    const target = localSessions.find((session) =>
      sessionMatchesTarget(session, sessionId, workspaceId),
    );
    if (!target) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    useStore.setState((s) => {
      const update = (session: Session): Session =>
        sessionMatchesTarget(session, sessionId, workspaceId)
          ? { ...session, favorite }
          : session;
      return {
        sessions: s.sessions.map(update),
        sessionTree: workspaceId
          ? {
              ...s.sessionTree,
              [workspaceId]: (s.sessionTree[workspaceId] ?? s.sessions).map(
                update,
              ),
            }
          : s.sessionTree,
      };
    });
    return;
  }

  const record = await historyStore.getSession(workspaceId, sessionId);
  if (!record) {
    throw new Error(`Session not found: ${workspaceId}/${sessionId}`);
  }

  const updated = await historyStore.updateSession(workspaceId, sessionId, {
    meta: { favorite },
    preserveUpdatedAt: true,
  });
  const updatedSession = sessionFromRecord(updated);

  useStore.setState((s) => {
    const update = (session: Session): Session =>
      sessionMatchesTarget(session, sessionId, workspaceId)
        ? updatedSession
        : session;
    return {
      sessions: s.sessions.map(update),
      sessionTree: s.sessionTree[workspaceId]
        ? {
            ...s.sessionTree,
            [workspaceId]: s.sessionTree[workspaceId].map(update),
          }
        : s.sessionTree,
    };
  });
}

export async function setHistorySessionPinned(
  sessionId: string,
  workspaceId: string | null,
  pinned: boolean,
): Promise<void> {
  const state = useStore.getState();
  if (!workspaceId || !state.historyReady) {
    const localSessions = workspaceId
      ? state.sessionTree[workspaceId] ?? state.sessions
      : state.sessions;
    const target = localSessions.find((session) =>
      sessionMatchesTarget(session, sessionId, workspaceId),
    );
    if (!target) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    useStore.setState((s) => {
      const update = (session: Session): Session =>
        sessionMatchesTarget(session, sessionId, workspaceId)
          ? { ...session, pinned }
          : session;
      return {
        sessions: s.sessions.map(update),
        sessionTree: workspaceId
          ? {
              ...s.sessionTree,
              [workspaceId]: (s.sessionTree[workspaceId] ?? s.sessions).map(
                update,
              ),
            }
          : s.sessionTree,
      };
    });
    return;
  }

  const record = await historyStore.getSession(workspaceId, sessionId);
  if (!record) {
    throw new Error(`Session not found: ${workspaceId}/${sessionId}`);
  }

  await historyStore.updateSession(workspaceId, sessionId, {
    meta: { pinned },
    preserveUpdatedAt: true,
  });

  useStore.setState((s) => {
    const update = (session: Session): Session =>
      sessionMatchesTarget(session, sessionId, workspaceId)
        ? { ...session, pinned }
        : session;
    return {
      sessions: s.sessions.map(update),
      sessionTree: s.sessionTree[workspaceId]
        ? {
            ...s.sessionTree,
            [workspaceId]: s.sessionTree[workspaceId].map(update),
          }
        : s.sessionTree,
    };
  });
}

export async function setWorkflowScheduledTaskHistorySession(
  sessionId: string,
  workspaceId: string | null,
  scheduledTask: ScheduledTaskConfig | null,
): Promise<void> {
  const normalizedTask = scheduledTask
    ? normalizeScheduledTask(scheduledTask)
    : undefined;
  if (scheduledTask && !normalizedTask) {
    throw new Error('Invalid scheduled task config');
  }

  const state = useStore.getState();
  if (workspaceId === SCHEDULED_TASK_SCOPE && scheduledTask === null) {
    if (sessionLiveStatus({ workspaceId, sessionId }, state)) throw new Error(scheduleText(state.locale, 'busy'));
    if (state.historyReady) await historyStore.deleteSession(workspaceId, sessionId, true);
    useStore.setState((s) => ({
      sessions: s.sessions.filter((session) => !sessionMatchesTarget(session, sessionId, workspaceId)),
      sessionTree: { ...s.sessionTree, [workspaceId]: (s.sessionTree[workspaceId] ?? []).filter((session) => session.id !== sessionId) },
    }));
    return;
  }
  if (!workspaceId || !state.historyReady) {
    const localSessions = workspaceId
      ? state.sessionTree[workspaceId] ?? state.sessions
      : state.sessions;
    const target = localSessions.find((session) =>
      sessionMatchesTarget(session, sessionId, workspaceId),
    );
    if (!target) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    useStore.setState((s) => {
      const update = (session: Session): Session => {
        if (!sessionMatchesTarget(session, sessionId, workspaceId)) {
          return session;
        }
        return normalizedTask
          ? { ...session, scheduledTask: normalizedTask }
          : { ...session, scheduledTask: undefined };
      };
      return {
        sessions: s.sessions.map(update),
        sessionTree: workspaceId
          ? {
              ...s.sessionTree,
              [workspaceId]: (s.sessionTree[workspaceId] ?? s.sessions).map(
                update,
              ),
            }
          : s.sessionTree,
      };
    });
    return;
  }

  const record = await historyStore.getSession(workspaceId, sessionId);
  if (!record) {
    throw new Error(`Session not found: ${workspaceId}/${sessionId}`);
  }

  const updated = await historyStore.updateSession(workspaceId, sessionId, {
    meta: { scheduledTask: normalizedTask ?? null },
    preserveUpdatedAt: true,
  });
  const updatedSession = sessionFromRecord(updated);

  useStore.setState((s) => {
    const update = (session: Session): Session =>
      sessionMatchesTarget(session, sessionId, workspaceId)
        ? updatedSession
        : session;
    return {
      sessions: s.sessions.map(update),
      sessionTree: s.sessionTree[workspaceId]
        ? {
            ...s.sessionTree,
            [workspaceId]: s.sessionTree[workspaceId].map(update),
          }
        : s.sessionTree,
    };
  });
  if (normalizedTask?.maxHistoryRuns !== undefined && !sessionLiveStatus({ workspaceId, sessionId }, useStore.getState())) {
    await pruneScheduledTaskHistory(workspaceId, sessionId);
  }
}

async function activateWorkspacePath(path: string): Promise<void> {
  const trimmed = normalizeWorkspacePath(path);
  if (!trimmed || !isSupportedWorkspacePath(trimmed)) return;
  const navigationVersion = beginHistoryNavigation();
  const state = useStore.getState();
  if (!state.historyReady) return;

  const workspace = await historyStore.resolveWorkspaceByPath(trimmed);
  if (!isLatestHistoryNavigation(navigationVersion)) return;
  let sessions =
    state.sessionTree[workspace.id] ??
    (state.activeWorkspaceId === workspace.id ? state.sessions : undefined);
  if (!sessions) {
    sessions = visibleChatSessionSummaries(
      await historyStore.listSessions(workspace.id),
    ).map((item) => sessionFromSummary(item));
    if (!isLatestHistoryNavigation(navigationVersion)) return;
  }
  let active = sessions[0];
  if (!active) {
    const record = await historyStore.createSession({
      workspaceId: workspace.id,
      isWorkflow: false,
      messages: [],
    });
    if (!isLatestHistoryNavigation(navigationVersion)) return;
    active = sessionFromRecord(record);
    sessions = [active, ...sessions];
  }

  const workspaces = await historyStore.listWorkspaces();
  if (!isLatestHistoryNavigation(navigationVersion)) return;
  const activeRecord = active
    ? await historyStore.getSession(workspace.id, active.id)
    : null;
  if (!isLatestHistoryNavigation(navigationVersion)) return;
  const recordWorkflow = activeRecord?.workflow
    ? restoreWorkflowRunSnapshot(activeRecord.workflow, activeRecord.meta)
    : null;
  const historicalGatewaySelection = historicalGatewaySelectionFromMessages(
    activeRecord?.messages ?? [],
  );
  const workflow = recordWorkflow
    ? recordWorkflow
    : withoutWorkflowGatewayDefaults(
        simpleBlueprint(activeRecord?.title, state.locale),
      );
  const runProgress = recordWorkflow
    ? runProgressFromSnapshot(workflow, workflow.meta.run ?? null)
    : emptyRunProgress();
  const canvasViewport = canvasViewportForSession(
    workspace.id,
    active?.id ?? '',
    activeRecord?.meta,
  );
  useStore.setState((s) => {
    if (!isLatestHistoryNavigation(navigationVersion)) return s;
    const sessionKey = {
      workspaceId: workspace.id,
      sessionId: active?.id ?? null,
    };
    const composerPatch = composerPatchForSession(
      s,
      sessionKey,
      workflow,
      defaultSessionComposer(
        trimmed,
        workspaceFoldersFromMetadata(workspace.metadata),
      ),
      historicalGatewaySelection,
    );
    const workspaceHistory = workspaceHistoryWithRecent(
      trimmed,
      s.workspaceHistory,
      WORKSPACE_HISTORY_LIMIT,
    );
    saveComposerSoon({
      composer: composerPatch.composer,
      composerBySession: composerPatch.composerBySession,
      workspaceHistory,
    });
    return {
      workspaces,
      activeWorkspaceId: workspace.id,
      selectedWorkspaceId: workspace.id,
      sessions,
      sessionTree: {
        ...s.sessionTree,
        [workspace.id]: sessions,
      },
      activeSessionId: active?.id ?? null,
      messages: activeRecord?.messages ?? [],
      workflow: composerPatch.workflow,
      composer: composerPatch.composer,
      composerBySession: composerPatch.composerBySession,
      workspaceHistory,
      ...runProgress,
      canvasViewport: recordWorkflow ? canvasViewport : null,
      mode: 'design',
      ...composerDraftPatchForSessionFromRecord(s, sessionKey, activeRecord?.meta),
    };
  });
  if (!isLatestHistoryNavigation(navigationVersion)) return;
  const current = useStore.getState();
  if (
    current.activeWorkspaceId !== workspace.id ||
    current.activeSessionId !== (active?.id ?? null)
  ) {
    return;
  }
  await historyStore.patchConfig({
    lastActiveWorkspaceId: workspace.id,
    lastActiveSessionId: active?.id,
  });
}

let historyInitStarted = false;

async function initHistoryFromDisk(): Promise<void> {
  if (historyInitStarted) return;
  historyInitStarted = true;
  try {
    await historyStore.ready();
    const rootPath = await historyStore.rootPath();
    await purgeGhostRemoteWorkspaces();
    const config = await historyStore.getConfig();
    let workspaces = await historyStore.listWorkspaces();

    const persisted = loadComposer();
    const rawPersistedPath = persisted?.composer.workspace?.trim();
    // After purge, a stale `remote://<purged-id>` persisted path must NOT be
    // resolved — resolveWorkspaceByPath would recreate the deleted ghost entry
    // and the local project would show up as cloud again. Only keep a remote
    // persisted path when its config still exists.
    const persistedPath =
      rawPersistedPath &&
      (!isSupportedWorkspacePath(rawPersistedPath) ||
        (isRemoteWorkspacePath(rawPersistedPath) &&
          !getRemoteWorkspace(remoteWorkspaceIdFromPath(rawPersistedPath))))
        ? undefined
        : rawPersistedPath;
    const configuredCandidate = config.lastActiveWorkspaceId
      ? await historyStore.getWorkspace(config.lastActiveWorkspaceId)
      : null;
    const configuredWorkspace = configuredCandidate && isSupportedWorkspacePath(configuredCandidate.path)
      ? configuredCandidate
      : null;
    // Prefer `config.lastActiveWorkspaceId` — it is the authoritative record of
    // the last workspace the user navigated to (written to disk atomically by
    // activateWorkspacePath/navigate on every switch). The composer's persisted
    // `workspace` path is a secondary, debounced localStorage value that tracks
    // the composer cwd and can lag or desync from the genuinely-last-active
    // workspace, so it is only a fallback when no config record exists.
    let workspace =
      configuredWorkspace ??
      (persistedPath
        ? await historyStore.resolveWorkspaceByPath(persistedPath)
        : null);
    if (!workspace && workspaces[0]) {
      workspace = await historyStore.getWorkspace(workspaces[0].id);
    }
    if (!workspace) {
      workspace = await historyStore.resolveWorkspaceByPath('');
    }

    workspaces = await historyStore.listWorkspaces();
    let sessions = visibleChatSessionSummaries(
      await historyStore.listSessions(workspace.id),
    );
    let active =
      sessions.find((s) => s.id === config.lastActiveSessionId) ??
      sessions.find((s) => s.id === workspace.lastActiveSessionId) ??
      sessions[0];
    if (!active) {
      const created = await historyStore.createSession({
        workspaceId: workspace.id,
        isWorkflow: false,
        messages: [],
      });
      active = summaryFromRecord(created);
      sessions = [summaryFromRecord(created), ...sessions];
      workspaces = await historyStore.listWorkspaces();
    }
    const sessionTree = await loadSessionTree(workspaces);
    const activeRecord = active
      ? await historyStore.getSession(workspace.id, active.id)
      : null;

    // Rehydrate in-memory `composerDrafts` for sessions that still have a
    // persisted `meta.composerDraft` but were not activated this run. Without
    // this the sidebar draft badge / draft-first ordering silently degrades to
    // pure time ordering after a restart, because `draftSessionKeys` only reads
    // the in-memory map and the per-session disk→memory restore only runs on
    // session activation. We scan every session in the active workspace once
    // here: `historyStore.getSession` is cached, so the disk read also prewarms
    // the record cache for later activations.
    const draftByKey: Record<string, string> = {};
    await Promise.all(
      sessions.map(async (summary) => {
        if (active && summary.id === active.id) return;
        const record = await historyStore.getSession(workspace.id, summary.id);
        const text = record?.meta?.composerDraft;
        if (typeof text === 'string' && text.trim().length > 0) {
          draftByKey[
            workflowSessionKeyId({
              workspaceId: workspace.id,
              sessionId: summary.id,
            })
          ] = text;
        }
      }),
    );
    const currentState = useStore.getState();
    const recordWorkflow = activeRecord?.workflow
      ? restoreWorkflowRunSnapshot(activeRecord.workflow, activeRecord.meta)
      : null;
    const historicalGatewaySelection = historicalGatewaySelectionFromMessages(
      activeRecord?.messages ?? [],
    );
    const workflow = recordWorkflow
      ? recordWorkflow
      : withoutWorkflowGatewayDefaults(
          simpleBlueprint(activeRecord?.title, currentState.locale),
        );
    const runProgress = recordWorkflow
      ? runProgressFromSnapshot(workflow, workflow.meta.run ?? null)
      : emptyRunProgress();
    const canvasViewport = canvasViewportForSession(
      workspace.id,
      active?.id ?? '',
      activeRecord?.meta,
    );

    useStore.setState((s) => {
      const sessionKey = {
        workspaceId: workspace.id,
        sessionId: active?.id ?? null,
      };
      const composerPatch = composerPatchForSession(
        s,
        sessionKey,
        workflow,
        {
          ...s.composer,
          workspace: workspace.path || (isSupportedWorkspacePath(s.composer.workspace) ? s.composer.workspace : ''),
          workspaceFolders: workspaceFoldersFromMetadata(workspace.metadata),
        },
        historicalGatewaySelection,
      );
      const draftPatch = composerDraftPatchForSessionFromRecord(
        s,
        sessionKey,
        activeRecord?.meta,
      );
      // Merge bulk-rehydrated drafts for non-active sessions. The active
      // session's entry from `draftPatch` always wins over the bulk map.
      const composerDrafts = { ...draftByKey, ...draftPatch.composerDrafts };
      return {
        historyReady: true,
        historyError: null,
        historyRootPath: rootPath,
        workspaces,
        activeWorkspaceId: workspace.id,
        selectedWorkspaceId: workspace.id,
        sessions: sessions.map((item) => sessionFromSummary(item)),
        sessionTree,
        activeSessionId: active?.id ?? null,
        messages: activeRecord?.messages ?? [],
        workflow: composerPatch.workflow,
        composer: composerPatch.composer,
        composerBySession: composerPatch.composerBySession,
        ...runProgress,
        canvasViewport: recordWorkflow ? canvasViewport : null,
        mode: 'design',
        composerDrafts,
        composerDraft: draftPatch.composerDraft,
      };
    });
    void maybeRunCcSwitchAutoImportOnFirstRun();
    await historyStore.patchConfig({
      schemaVersion: HISTORY_SCHEMA_VERSION,
      lastActiveWorkspaceId: workspace.id,
      lastActiveSessionId: active?.id,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[history-init] failed to load history', err);
    useStore.setState({
      historyReady: true,
      historyError: message || 'Unknown history initialization error',
      historyRootPath: null,
      workspaces: [],
      activeWorkspaceId: null,
      selectedWorkspaceId: null,
      sessions: [],
      sessionTree: {},
      activeSessionId: null,
      messages: [],
    });
  }
}

export function initHistory(): void {
  void initHistoryFromDisk();
}

export async function ensureSessionStartupWorkspace(): Promise<void> {
  const state = useStore.getState();
  // Worktree isolation is a session-open-time action: only meaningful before
  // the conversation starts (no messages) and only in 'worktree' mode. Mirror
  // the cacheTtl lock so an already-started session is never re-pointed.
  if (state.composer.startupMode !== 'worktree') return;
  if (state.messages.length > 0) return;
  if (!isTauri()) return;
  const { cwd } = composerCliWorkspaceOptions(state.composer);
  const root = cwd?.trim();
  if (!root) return;
  // A stable session id keeps the preparation idempotent across retries.
  const sessionKey = activeWorkflowSessionKey(state);
  const sessionId = sessionKey.sessionId ?? state.activeSessionId ?? 'session';
  try {
    const isolated = await prepareIsolatedWorkspace(root, sessionId);
    const isolatedPath = isolated.path?.trim();
    if (!isolatedPath || isolatedPath === root) return;
    // Re-check the lock: a turn may have started while we awaited the backend.
    const latest = useStore.getState();
    if (latest.messages.length > 0) return;
    if (latest.composer.startupMode !== 'worktree') return;
    // Repoint only this session's composer cwd at the isolated directory —
    // never switch the active workspace or add a sidebar entry. Keep the
    // primary folder isolated while preserving any extra workspace folders.
    useStore.getState().setComposer({
      workspace: isolatedPath,
      workspaceFolders: latest.composer.workspaceFolders.filter(
        (folder) => folder !== root,
      ),
    });
  } catch {
    // No backend / git failure: fall back to running in the original
    // workspace rather than blocking the send.
  }
}

// Set the active workspace and record it in the most-recent-first history
// (deduped, capped). Empty paths are ignored.
export function setWorkspace(path: string): void {
  const trimmed = normalizeWorkspacePath(path);
  if (!trimmed || !isSupportedWorkspacePath(trimmed)) return;
  if (isActiveAiEditingSession(useStore.getState())) return;
  useStore.setState((state) => {
    const composer = normalizeComposerSettings({
      ...state.composer,
      workspace: trimmed,
      workspaceFolders: state.composer.workspaceFolders,
    });
    const workspaceHistory = workspaceHistoryWithRecentPaths(
      composerWorkspacePaths(composer),
      state.workspaceHistory,
    );
    const snapshot: SessionComposerSettings = {
      composer,
      gatewaySelection: workflowDefaultGatewaySelection(
        state.workflow,
        composer.model,
      ),
    };
    const composerBySession = rememberSessionComposer(
      { ...state, composer },
      state.composerBySession,
      snapshot,
    );
    saveComposerSoon({ composer, composerBySession, workspaceHistory });
    return { composer, composerBySession, workspaceHistory };
  });
  void activateWorkspacePath(trimmed);
}

// Add a session-only workspace folder. The first folder becomes the primary
// cwd; later folders are passed to CLI adapters as extra allowed directories.
export function addWorkspaceFolder(path: string): void {
  const trimmed = normalizeWorkspacePath(path);
  if (!trimmed || !isSupportedWorkspacePath(trimmed)) return;
  const current = useStore.getState();
  if (isActiveAiEditingSession(current)) return;
  const shouldActivate = !normalizeWorkspacePath(current.composer.workspace);
  useStore.setState((state) => {
    const composer = shouldActivate
      ? normalizeComposerSettings({
          ...state.composer,
          workspace: trimmed,
          workspaceFolders: [],
        })
      : normalizeComposerSettings({
          ...state.composer,
          workspaceFolders: [trimmed, ...state.composer.workspaceFolders],
        });
    const workspaceHistory = workspaceHistoryWithRecentPaths(
      composerWorkspacePaths(composer),
      state.workspaceHistory,
    );
    const snapshot: SessionComposerSettings = {
      composer,
      gatewaySelection: workflowDefaultGatewaySelection(
        state.workflow,
        composer.model,
      ),
    };
    const composerBySession = rememberSessionComposer(
      { ...state, composer },
      state.composerBySession,
      snapshot,
    );
    saveComposerSoon({ composer, composerBySession, workspaceHistory });
    return { composer, composerBySession, workspaceHistory };
  });
  if (shouldActivate) void activateWorkspacePath(trimmed);
}

export function removeWorkspaceFolder(path: string): void {
  const key = workspacePathKey(path);
  if (!key) return;
  if (isActiveAiEditingSession(useStore.getState())) return;
  useStore.setState((state) => {
    const primaryKey = workspacePathKey(state.composer.workspace);
    const currentExtras = normalizeWorkspaceFolderList(
      state.composer.workspaceFolders,
      state.composer.workspace,
    );
    let workspace = state.composer.workspace;
    let workspaceFolders = currentExtras.filter(
      (item) => workspacePathKey(item) !== key,
    );
    if (primaryKey === key) {
      workspace = workspaceFolders[0] ?? '';
      workspaceFolders = workspaceFolders.slice(1);
    }
    const composer = normalizeComposerSettings({
      ...state.composer,
      workspace,
      workspaceFolders,
    });
    const snapshot: SessionComposerSettings = {
      composer,
      gatewaySelection: workflowDefaultGatewaySelection(
        state.workflow,
        composer.model,
      ),
    };
    const composerBySession = rememberSessionComposer(
      { ...state, composer },
      state.composerBySession,
      snapshot,
    );
    saveComposerSoon({
      composer,
      composerBySession,
      workspaceHistory: state.workspaceHistory,
    });
    return { composer, composerBySession };
  });
}

// Remove a folder from the workspace history. If it was the active
// workspace, the active selection is cleared (falls back to "no folder").
export function removeWorkspace(path: string): void {
  const key = workspacePathKey(path);
  if (!key) return;
  if (isActiveAiEditingSession(useStore.getState())) return;
  useStore.setState((state) => {
    const workspaceHistory = state.workspaceHistory.filter(
      (p) => workspacePathKey(p) !== key,
    );
    if (workspaceHistory.length === state.workspaceHistory.length) {
      return state;
    }
    const removingActive = workspacePathKey(state.composer.workspace) === key;
    const currentExtras = normalizeWorkspaceFolderList(
      state.composer.workspaceFolders,
      state.composer.workspace,
    ).filter((item) => workspacePathKey(item) !== key);
    if (!removingActive && currentExtras.length === state.composer.workspaceFolders.length) {
      saveComposerSoon({
        composer: state.composer,
        composerBySession: state.composerBySession,
        workspaceHistory,
      });
      return { workspaceHistory };
    }
    const composer = normalizeComposerSettings({
      ...state.composer,
      workspace: removingActive ? currentExtras[0] ?? '' : state.composer.workspace,
      workspaceFolders: removingActive ? currentExtras.slice(1) : currentExtras,
    });
    const snapshot: SessionComposerSettings = {
      composer,
      gatewaySelection: workflowDefaultGatewaySelection(
        state.workflow,
        composer.model,
      ),
    };
    const composerBySession = rememberSessionComposer(
      { ...state, composer },
      state.composerBySession,
      snapshot,
    );
    saveComposerSoon({ composer, composerBySession, workspaceHistory });
    return { composer, composerBySession, workspaceHistory };
  });
}

export function applyWorkspaceFolders(
  workspaceId: string,
  folders: string[],
): void {
  if (isActiveAiEditingSession(useStore.getState())) return;
  useStore.setState((state) => {
    if (!workspaceId || state.activeWorkspaceId !== workspaceId) return state;
    const workspace = state.workspaces.find((ws) => ws.id === workspaceId);
    const primary = normalizeWorkspacePath(
      state.composer.workspace || workspace?.path || '',
    );
    const composer = normalizeComposerSettings({
      ...state.composer,
      workspace: primary,
      workspaceFolders: folders,
    });
    const snapshot: SessionComposerSettings = {
      composer,
      gatewaySelection: workflowDefaultGatewaySelection(
        state.workflow,
        composer.model,
      ),
    };
    const composerBySession = rememberSessionComposer(
      { ...state, composer },
      state.composerBySession,
      snapshot,
    );
    saveComposerSoon({
      composer,
      composerBySession,
      workspaceHistory: state.workspaceHistory,
    });
    return { composer, composerBySession };
  });
}
