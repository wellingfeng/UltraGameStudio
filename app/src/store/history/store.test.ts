import { afterEach, describe, expect, it } from 'vitest';
import { deriveWorkspaceId } from './paths';
import { historyStore } from './store';
import type {
  HistoryConfig,
  SessionRecord,
  SessionSummary,
  WorkspaceRecord,
  WorkspaceSummary,
} from './types';

const FALLBACK_PREFIX = 'freeultracode.history.v1:';

function writeHistoryJson(relPath: string, value: unknown): void {
  window.localStorage.setItem(FALLBACK_PREFIX + relPath, JSON.stringify(value));
}

function sessionRecord(
  workspaceId: string,
  sessionId: string,
  title: string,
  updatedAt: number,
): SessionRecord {
  return {
    id: sessionId,
    workspaceId,
    title,
    isWorkflow: false,
    createdAt: updatedAt - 1,
    updatedAt,
    messages: [
      {
        id: `m_${sessionId}`,
        role: 'user',
        text: title,
        createdAt: updatedAt,
      },
    ],
  };
}

function sessionSummary(record: SessionRecord): SessionSummary {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    title: record.title,
    isWorkflow: record.isWorkflow,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    preview: record.messages[0]?.text,
    messageCount: record.messages.length,
  };
}

function workspaceSummary(record: WorkspaceRecord): WorkspaceSummary {
  return {
    id: record.id,
    path: record.path,
    name: record.name,
    updatedAt: record.updatedAt,
    sessionCount: record.sessionCount,
    lastActiveSessionId: record.lastActiveSessionId,
  };
}

afterEach(() => {
  window.localStorage.clear();
});

describe('historyStore lone surrogate sanitization', () => {
  it('replaces unpaired UTF-16 surrogates before persisting a session', async () => {
    const workspaceId = await deriveWorkspaceId('E:\\OpenWorkflow');
    const workspace: WorkspaceRecord = {
      id: workspaceId,
      path: 'E:\\OpenWorkflow',
      name: 'OpenWorkflow',
      createdAt: 1,
      updatedAt: 1,
      sessionCount: 0,
    };
    writeHistoryJson('workspaces/index.json', [workspaceSummary(workspace)]);
    writeHistoryJson(`workspaces/${workspaceId}/meta.json`, workspace);

    // A truncated emoji leaves a lone high surrogate (\ud83d) in the text.
    const loneHigh = '\ud83d';
    const created = await historyStore.createSession({
      workspaceId,
      isWorkflow: false,
      messages: [
        {
          id: 'm1',
          role: 'user',
          text: `truncated emoji${loneHigh} tail`,
          createdAt: 2,
        },
      ],
    });

    const raw = window.localStorage.getItem(
      `${FALLBACK_PREFIX}workspaces/${workspaceId}/sessions/${created.id}.json`,
    );
    expect(raw).toBeTruthy();
    // The serialized form must contain no lone surrogate escape (the backend's
    // serde validator rejects \udXXX with "unexpected end of hex escape").
    expect(/\\ud[0-9a-f]{3}/i.test(raw ?? '')).toBe(false);
    // It must still be valid JSON that round-trips.
    expect(() => JSON.parse(raw ?? '')).not.toThrow();
  });

  it('preserves valid surrogate pairs (intact emoji) when sanitizing', async () => {
    const workspaceId = await deriveWorkspaceId('E:\\OpenWorkflow');
    const workspace: WorkspaceRecord = {
      id: workspaceId,
      path: 'E:\\OpenWorkflow',
      name: 'OpenWorkflow',
      createdAt: 1,
      updatedAt: 1,
      sessionCount: 0,
    };
    writeHistoryJson('workspaces/index.json', [workspaceSummary(workspace)]);
    writeHistoryJson(`workspaces/${workspaceId}/meta.json`, workspace);

    const created = await historyStore.createSession({
      workspaceId,
      isWorkflow: false,
      messages: [
        { id: 'm1', role: 'user', text: 'rocket 🚀 ok', createdAt: 2 },
      ],
    });

    const stored = await historyStore.getSession(workspaceId, created.id);
    expect(stored?.messages[0]?.text).toBe('rocket 🚀 ok');
  });
});

describe('historyStore workspace reconciliation', () => {
  it('merges legacy duplicate Windows workspace buckets by path identity', async () => {
    const canonicalId = await deriveWorkspaceId('E:\\OpenWorkflow');
    const legacyId = 'legacy_openworkflow';
    const canonicalWorkspace: WorkspaceRecord = {
      id: canonicalId,
      path: 'e:\\OpenWorkflow',
      name: 'OpenWorkflow',
      createdAt: 10,
      updatedAt: 20,
      sessionCount: 1,
      lastActiveSessionId: 's_lower',
    };
    const legacyWorkspace: WorkspaceRecord = {
      id: legacyId,
      path: 'E:\\OpenWorkflow',
      name: 'OpenWorkflow',
      createdAt: 1,
      updatedAt: 30,
      sessionCount: 1,
      lastActiveSessionId: 's_upper',
    };
    const canonicalSession = sessionRecord(
      canonicalId,
      's_lower',
      'lower drive chat',
      20,
    );
    const legacySession = sessionRecord(
      legacyId,
      's_upper',
      'upper drive chat',
      30,
    );
    const config: HistoryConfig = {
      schemaVersion: 1,
      migratedFromLocalStorage: true,
      lastActiveWorkspaceId: legacyId,
      lastActiveSessionId: legacySession.id,
    };

    writeHistoryJson('config.json', config);
    writeHistoryJson('workspaces/index.json', [
      workspaceSummary(canonicalWorkspace),
      workspaceSummary(legacyWorkspace),
    ]);
    writeHistoryJson(
      `workspaces/${canonicalId}/meta.json`,
      canonicalWorkspace,
    );
    writeHistoryJson(`workspaces/${legacyId}/meta.json`, legacyWorkspace);
    writeHistoryJson(`workspaces/${canonicalId}/sessions/index.json`, [
      sessionSummary(canonicalSession),
    ]);
    writeHistoryJson(`workspaces/${legacyId}/sessions/index.json`, [
      sessionSummary(legacySession),
    ]);
    writeHistoryJson(
      `workspaces/${canonicalId}/sessions/${canonicalSession.id}.json`,
      canonicalSession,
    );
    writeHistoryJson(
      `workspaces/${legacyId}/sessions/${legacySession.id}.json`,
      legacySession,
    );

    await historyStore.ready();

    const workspaces = await historyStore.listWorkspaces();
    const sessions = await historyStore.listSessions(canonicalId);
    const movedLegacySession = await historyStore.getSession(
      canonicalId,
      legacySession.id,
    );
    const removedLegacyWorkspace = await historyStore.getWorkspace(legacyId);
    const nextConfig = await historyStore.getConfig();

    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]).toMatchObject({
      id: canonicalId,
      path: 'E:\\OpenWorkflow',
      name: 'OpenWorkflow',
      sessionCount: 2,
    });
    expect(sessions.map((session) => session.id)).toEqual([
      legacySession.id,
      canonicalSession.id,
    ]);
    expect(movedLegacySession?.workspaceId).toBe(canonicalId);
    expect(removedLegacyWorkspace).toBeNull();
    expect(nextConfig.lastActiveWorkspaceId).toBe(canonicalId);
    expect(nextConfig.lastActiveSessionId).toBe(legacySession.id);
  });

  it('rebuilds duplicate workspace session indexes before merging buckets', async () => {
    const canonicalId = await deriveWorkspaceId('E:\\OpenWorkflow');
    const legacyId = 'legacy_openworkflow';
    const canonicalWorkspace: WorkspaceRecord = {
      id: canonicalId,
      path: 'e:\\OpenWorkflow',
      name: 'OpenWorkflow',
      createdAt: 10,
      updatedAt: 20,
      sessionCount: 1,
      lastActiveSessionId: 's_lower',
    };
    const legacyWorkspace: WorkspaceRecord = {
      id: legacyId,
      path: 'E:\\OpenWorkflow',
      name: 'OpenWorkflow',
      createdAt: 1,
      updatedAt: 40,
      sessionCount: 1,
      lastActiveSessionId: 's_indexed',
    };
    const canonicalSession = sessionRecord(
      canonicalId,
      's_lower',
      'lower drive chat',
      20,
    );
    const indexedLegacySession = sessionRecord(
      legacyId,
      's_indexed',
      'indexed upper drive chat',
      30,
    );
    const missingLegacySession = sessionRecord(
      legacyId,
      's_missing',
      'missing upper drive chat',
      40,
    );

    writeHistoryJson('config.json', {
      schemaVersion: 1,
      migratedFromLocalStorage: true,
      lastActiveWorkspaceId: legacyId,
      lastActiveSessionId: missingLegacySession.id,
    } satisfies HistoryConfig);
    writeHistoryJson('workspaces/index.json', [
      workspaceSummary(canonicalWorkspace),
      workspaceSummary(legacyWorkspace),
    ]);
    writeHistoryJson(
      `workspaces/${canonicalId}/meta.json`,
      canonicalWorkspace,
    );
    writeHistoryJson(`workspaces/${legacyId}/meta.json`, legacyWorkspace);
    writeHistoryJson(`workspaces/${canonicalId}/sessions/index.json`, [
      sessionSummary(canonicalSession),
    ]);
    writeHistoryJson(`workspaces/${legacyId}/sessions/index.json`, [
      sessionSummary(indexedLegacySession),
    ]);
    writeHistoryJson(
      `workspaces/${canonicalId}/sessions/${canonicalSession.id}.json`,
      canonicalSession,
    );
    writeHistoryJson(
      `workspaces/${legacyId}/sessions/${indexedLegacySession.id}.json`,
      indexedLegacySession,
    );
    writeHistoryJson(
      `workspaces/${legacyId}/sessions/${missingLegacySession.id}.json`,
      missingLegacySession,
    );

    await historyStore.ready();

    const workspaces = await historyStore.listWorkspaces();
    const sessions = await historyStore.listSessions(canonicalId);
    const restoredMissingSession = await historyStore.getSession(
      canonicalId,
      missingLegacySession.id,
    );
    const nextConfig = await historyStore.getConfig();

    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]).toMatchObject({
      id: canonicalId,
      sessionCount: 3,
    });
    expect(sessions.map((session) => session.id)).toEqual([
      missingLegacySession.id,
      indexedLegacySession.id,
      canonicalSession.id,
    ]);
    expect(restoredMissingSession?.workspaceId).toBe(canonicalId);
    expect(nextConfig.lastActiveWorkspaceId).toBe(canonicalId);
    expect(nextConfig.lastActiveSessionId).toBe(missingLegacySession.id);
  });

  it('recovers workspace directories missing from the root index before merging', async () => {
    const canonicalId = await deriveWorkspaceId('E:\\OpenWorkflow');
    const legacyId = '2f973eac8ae19fe3';
    const ccTabId = await deriveWorkspaceId('E:\\cc-tab');
    const defaultWorkspace: WorkspaceRecord = {
      id: '__default__',
      path: 'E:\\cc-tab',
      name: 'cc-tab',
      createdAt: 1,
      updatedAt: 15,
      sessionCount: 1,
      lastActiveSessionId: 's_cc',
    };
    const canonicalWorkspace: WorkspaceRecord = {
      id: canonicalId,
      path: 'E:\\OpenWorkflow',
      name: 'OpenWorkflow',
      createdAt: 10,
      updatedAt: 20,
      sessionCount: 1,
      lastActiveSessionId: 's_new',
    };
    const legacyWorkspace: WorkspaceRecord = {
      id: legacyId,
      path: 'e:\\OpenWorkflow',
      name: 'OpenWorkflow',
      createdAt: 2,
      updatedAt: 40,
      sessionCount: 1,
      lastActiveSessionId: 's_old',
    };
    const defaultSession = sessionRecord(
      '__default__',
      's_cc',
      'cc tab chat',
      15,
    );
    const pollutedDefaultSession = sessionRecord(
      '__default__',
      's_polluted',
      'polluted OpenWorkflow chat',
      35,
    );
    const canonicalSession = sessionRecord(
      canonicalId,
      's_new',
      'canonical OpenWorkflow chat',
      20,
    );
    const legacySession = sessionRecord(
      legacyId,
      's_old',
      'legacy OpenWorkflow chat',
      40,
    );

    writeHistoryJson('config.json', {
      schemaVersion: 1,
      migratedFromLocalStorage: true,
      lastActiveWorkspaceId: legacyId,
      lastActiveSessionId: legacySession.id,
    } satisfies HistoryConfig);
    writeHistoryJson('workspaces/index.json', [
      workspaceSummary(defaultWorkspace),
    ]);
    writeHistoryJson('workspaces/__default__/meta.json', defaultWorkspace);
    writeHistoryJson(`workspaces/${canonicalId}/meta.json`, canonicalWorkspace);
    writeHistoryJson(`workspaces/${legacyId}/meta.json`, legacyWorkspace);
    writeHistoryJson('workspaces/__default__/sessions/index.json', [
      sessionSummary(defaultSession),
    ]);
    writeHistoryJson(`workspaces/${canonicalId}/sessions/index.json`, [
      sessionSummary(canonicalSession),
    ]);
    writeHistoryJson(`workspaces/${legacyId}/sessions/index.json`, [
      sessionSummary(legacySession),
    ]);
    writeHistoryJson(
      'workspaces/__default__/sessions/s_cc.json',
      defaultSession,
    );
    writeHistoryJson(
      'workspaces/__default__/sessions/s_polluted.json',
      pollutedDefaultSession,
    );
    writeHistoryJson(
      `workspaces/${canonicalId}/sessions/${canonicalSession.id}.json`,
      canonicalSession,
    );
    writeHistoryJson(
      `workspaces/${legacyId}/sessions/${legacySession.id}.json`,
      legacySession,
    );

    await historyStore.ready();

    const workspaces = await historyStore.listWorkspaces();
    const openWorkflowSessions = await historyStore.listSessions(canonicalId);
    const defaultSessions = await historyStore.listSessions('__default__');
    const ccTabSessions = await historyStore.listSessions(ccTabId);
    const movedLegacySession = await historyStore.getSession(
      canonicalId,
      legacySession.id,
    );
    const pollutedSession = await historyStore.getSession(
      canonicalId,
      pollutedDefaultSession.id,
    );
    const nextConfig = await historyStore.getConfig();

    expect(workspaces.map((workspace) => workspace.id).sort()).toEqual([
      ccTabId,
      canonicalId,
    ].sort());
    expect(openWorkflowSessions.map((session) => session.id)).toEqual([
      legacySession.id,
      canonicalSession.id,
    ]);
    expect(defaultSessions).toEqual([]);
    expect(ccTabSessions.map((session) => session.id)).toEqual([
      defaultSession.id,
    ]);
    expect(movedLegacySession?.workspaceId).toBe(canonicalId);
    expect(pollutedSession).toBeNull();
    expect(nextConfig.lastActiveWorkspaceId).toBe(canonicalId);
    expect(nextConfig.lastActiveSessionId).toBe(legacySession.id);
  });

  it('rebuilds a stale session index from session json files', async () => {
    const workspaceId = await deriveWorkspaceId('E:\\OpenWorkflow');
    const workspace: WorkspaceRecord = {
      id: workspaceId,
      path: 'E:\\OpenWorkflow',
      name: 'OpenWorkflow',
      createdAt: 1,
      updatedAt: 20,
      sessionCount: 1,
      lastActiveSessionId: 's_indexed',
    };
    const indexedSession = sessionRecord(
      workspaceId,
      's_indexed',
      'indexed chat',
      20,
    );
    const missingSession = sessionRecord(
      workspaceId,
      's_missing',
      'missing from index chat',
      30,
    );

    writeHistoryJson('config.json', {
      schemaVersion: 1,
      migratedFromLocalStorage: true,
      lastActiveWorkspaceId: workspaceId,
      lastActiveSessionId: indexedSession.id,
    } satisfies HistoryConfig);
    writeHistoryJson('workspaces/index.json', [workspaceSummary(workspace)]);
    writeHistoryJson(`workspaces/${workspaceId}/meta.json`, workspace);
    writeHistoryJson(`workspaces/${workspaceId}/sessions/index.json`, [
      sessionSummary(indexedSession),
    ]);
    writeHistoryJson(
      `workspaces/${workspaceId}/sessions/${indexedSession.id}.json`,
      indexedSession,
    );
    writeHistoryJson(
      `workspaces/${workspaceId}/sessions/${missingSession.id}.json`,
      missingSession,
    );

    const sessions = await historyStore.listSessions(workspaceId);
    const updatedWorkspace = await historyStore.getWorkspace(workspaceId);

    expect(sessions.map((session) => session.id)).toEqual([
      missingSession.id,
      indexedSession.id,
    ]);
    expect(updatedWorkspace?.sessionCount).toBe(2);
  });
});
