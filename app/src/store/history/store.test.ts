import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveWorkspaceId } from './paths';
import {
  __resetHistorySessionCacheForTests,
  historyStore,
  titleFromText,
} from './store';
import type {
  HistoryConfig,
  SessionRecord,
  SessionSummary,
  WorkspaceRecord,
  WorkspaceSummary,
} from './types';

describe('compression history persistence', () => {
  it('retains compression in the index across later messages and cache reload', async () => {
    const record = await historyStore.createSession({
      workspaceId: '__default__', id: 'compressed-history', isWorkflow: false,
      messages: [{ id: 'a', role: 'assistant', text: '回答', createdAt: 1, contextCompressed: true }],
    });
    await historyStore.appendMessage(record.workspaceId, record.id, {
      id: 'u', role: 'user', text: '继续', createdAt: 2,
    });
    __resetHistorySessionCacheForTests();
    const summaries = await historyStore.listSessions(record.workspaceId);
    expect(summaries.find((item) => item.id === record.id)?.contextCompressed).toBe(true);
    expect((await historyStore.getSession(record.workspaceId, record.id))?.messages[0]?.contextCompressed).toBe(true);
  });
});

const FALLBACK_PREFIX = 'ultragamestudio.history.v1:';

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
  __resetHistorySessionCacheForTests();
  vi.useRealTimers();
  window.localStorage.clear();
});

describe('historyStore session title derivation', () => {
  it('propagates browser fallback quota errors from final saves and flush', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota exceeded'); });
    try {
      await expect(historyStore.createSession({ workspaceId: '__default__', id: 'quota', isWorkflow: false })).rejects.toThrow('quota exceeded');
      await expect(historyStore.flush()).rejects.toThrow('quota exceeded');
    } finally { storage.mockRestore(); await historyStore.flush().catch(() => {}); }
  });
  it('keeps a newer stream checkpoint when an older queued snapshot arrives', async () => {
    const workspaceId = '__default__';
    const id = `checkpoint-${Date.now()}`;
    const original = { id: 'answer', role: 'assistant' as const, text: '占位', createdAt: 1, streamUpdatedAt: 2 };
    await historyStore.createSession({ workspaceId, id, isWorkflow: false, messages: [original] });
    await historyStore.updateSession(workspaceId, id, {
      mergeMessages: true, streamCheckpoint: true,
      messages: [{ ...original, text: '已执行两步', streamUpdatedAt: 4 }],
    });
    await historyStore.updateSession(workspaceId, id, {
      mergeMessages: true, messages: [{ ...original, text: '旧步骤', streamUpdatedAt: 3 }],
    });
    const saved = await historyStore.getSession(workspaceId, id);
    expect(saved?.messages[0].text).toBe('已执行两步');
  });

  it('merges a stale chat snapshot without dropping later messages or downgrading learning state', async () => {
    const origin = { hostId: 'local', workspaceId: '__default__', sessionId: 'merge-source', turnId: 'initial', runId: 'review-a' };
    const initial = { id: 'initial', role: 'user' as const, text: 'Original task.', createdAt: 1 };
    const queuedCard = { id: 'skill-card', role: 'assistant' as const, text: '', createdAt: 3, localOnly: true,
      skillLearning: { origin, status: 'queued' as const } };
    const source = await historyStore.createSession({
      workspaceId: origin.workspaceId, id: origin.sessionId, isWorkflow: false, messages: [initial, queuedCard],
    });
    await historyStore.appendMessage(source.workspaceId, source.id, {
      id: 'later', role: 'user', text: 'Later task.', createdAt: 4,
    });
    await historyStore.upsertMessage(source.workspaceId, source.id, {
      ...queuedCard, skillLearning: { origin, status: 'applied' },
    }, true);
    const updated = await historyStore.updateSession(source.workspaceId, source.id, {
      messages: [initial, { id: 'reply', role: 'assistant', text: 'Original reply.', createdAt: 2 }, queuedCard],
      mergeMessages: true,
    });
    expect(updated.messages.map((message) => message.id)).toEqual(['initial', 'reply', 'skill-card', 'later']);
    expect(updated.messages.find((message) => message.id === queuedCard.id)?.skillLearning?.status).toBe('applied');
  });

  it('merges a background result into the fresh source record without losing queued messages', async () => {
    const source = await historyStore.createSession({
      workspaceId: '__default__', id: 'skill-source', isWorkflow: false,
      messages: [{ id: 'initial', role: 'user', text: 'Original task.', createdAt: 1 }],
    });
    const queued = historyStore.appendMessage(source.workspaceId, source.id, {
      id: 'next-turn', role: 'user', text: 'A newer task.', createdAt: 2,
    });
    const result = historyStore.upsertMessage(source.workspaceId, source.id, {
      id: 'skill-card', role: 'assistant', localOnly: true, text: 'Background result.', createdAt: 3,
    }, true);
    await Promise.all([queued, result]);
    const record = await historyStore.getSession(source.workspaceId, source.id);
    expect(record?.messages.map((message) => message.id)).toEqual(['initial', 'next-turn', 'skill-card']);
    await historyStore.upsertMessage(source.workspaceId, source.id, {
      id: 'skill-card', role: 'assistant', localOnly: true, text: 'Updated result.', createdAt: 4,
    }, true);
    const updated = await historyStore.getSession(source.workspaceId, source.id);
    expect(updated?.messages.filter((message) => message.id === 'skill-card')).toEqual([{
      id: 'skill-card', role: 'assistant', localOnly: true, text: 'Updated result.', createdAt: 3,
    }]);
    expect(updated?.updatedAt).toBe(record?.updatedAt);
  });

  it('drops leading pasted image paths from prompt-derived titles', () => {
    const title = titleFromText(
      '`E:\\UltraGameStudio\\.ultragamestudio\\clipboard-images\\pasted-1783578658027-52db4c04aa12e57d-0.png`，这里的失败是因为什么，好像我不应该失败才对，是因为超时吗，还是什么原因',
    );

    expect(title).toContain('这里的失败是因为什么');
    expect(title).not.toContain('clipboard-images');
    expect(title).not.toContain('UltraGameStudio');
  });

  it('falls back when the prompt only contains a local path', () => {
    expect(titleFromText('E:\\UltraGameStudio\\shot.png', '新会话')).toBe(
      '新会话',
    );
  });
});

describe('historyStore session activity timestamps', () => {
  it('uses assistant completion time when replacing session messages', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const workspaceId = await deriveWorkspaceId('E:\\UltraGameStudio');
    const workspace: WorkspaceRecord = {
      id: workspaceId,
      path: 'E:\\UltraGameStudio',
      name: 'UltraGameStudio',
      createdAt: 1,
      updatedAt: 1,
      sessionCount: 0,
    };
    writeHistoryJson('workspaces/index.json', [workspaceSummary(workspace)]);
    writeHistoryJson(`workspaces/${workspaceId}/meta.json`, workspace);

    const userMessage = {
      id: 'm_user',
      role: 'user' as const,
      text: 'start',
      createdAt: 1_000,
    };
    const created = await historyStore.createSession({
      workspaceId,
      isWorkflow: false,
      messages: [userMessage],
    });

    const updated = await historyStore.updateSession(workspaceId, created.id, {
      messages: [
        userMessage,
        {
          id: 'm_assistant',
          role: 'assistant',
          text: 'done',
          createdAt: 1_001,
          completedAt: 5_000,
        },
      ],
    });
    const sessions = await historyStore.listSessions(workspaceId);

    expect(updated.updatedAt).toBe(5_000);
    expect(sessions[0]?.updatedAt).toBe(5_000);
  });

  it('rebuilds legacy indexes using assistant elapsed end time', async () => {
    const workspaceId = await deriveWorkspaceId('E:\\UltraGameStudio');
    const workspace: WorkspaceRecord = {
      id: workspaceId,
      path: 'E:\\UltraGameStudio',
      name: 'UltraGameStudio',
      createdAt: 1,
      updatedAt: 1,
      sessionCount: 2,
    };
    const longStart = new Date(2026, 0, 1, 14, 18, 53).getTime();
    const longEnd = new Date(2026, 0, 1, 15, 3, 25).getTime();
    const shortStart = new Date(2026, 0, 1, 14, 21, 0).getTime();
    const longSession: SessionRecord = {
      id: 's_long',
      workspaceId,
      title: 'long first turn',
      isWorkflow: false,
      createdAt: longStart,
      updatedAt: longStart,
      messages: [
        {
          id: 'm_long',
          role: 'assistant',
          text: '⏱ 14:18:53 → 15:03:25 · 耗时 44m 32s\n完成。',
          createdAt: longStart,
        },
      ],
    };
    const shortSession = sessionRecord(
      workspaceId,
      's_short',
      'short later start',
      shortStart,
    );

    writeHistoryJson('workspaces/index.json', [workspaceSummary(workspace)]);
    writeHistoryJson(`workspaces/${workspaceId}/meta.json`, workspace);
    writeHistoryJson(`workspaces/${workspaceId}/sessions/index.json`, [
      sessionSummary(shortSession),
      sessionSummary(longSession),
    ]);
    writeHistoryJson(
      `workspaces/${workspaceId}/sessions/${longSession.id}.json`,
      longSession,
    );
    writeHistoryJson(
      `workspaces/${workspaceId}/sessions/${shortSession.id}.json`,
      shortSession,
    );

    const sessions = await historyStore.listSessions(workspaceId);

    expect(sessions.map((session) => session.id)).toEqual([
      longSession.id,
      shortSession.id,
    ]);
    expect(sessions[0]?.updatedAt).toBe(longEnd);
    expect(sessions[0]?.activityVersion).toBe(3);
  });
});

describe('historyStore lone surrogate sanitization', () => {
  it('replaces unpaired UTF-16 surrogates before persisting a session', async () => {
    const workspaceId = await deriveWorkspaceId('E:\\UltraGameStudio');
    const workspace: WorkspaceRecord = {
      id: workspaceId,
      path: 'E:\\UltraGameStudio',
      name: 'UltraGameStudio',
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
    const workspaceId = await deriveWorkspaceId('E:\\UltraGameStudio');
    const workspace: WorkspaceRecord = {
      id: workspaceId,
      path: 'E:\\UltraGameStudio',
      name: 'UltraGameStudio',
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

describe('historyStore session record memory cache', () => {
  it('prewarms the five newest sessions per workspace after listing sessions', async () => {
    vi.useFakeTimers();
    const workspaceId = await deriveWorkspaceId('E:\\UltraGameStudio');
    const records = Array.from({ length: 6 }, (_, index) =>
      sessionRecord(
        workspaceId,
        `s_${index + 1}`,
        `session ${index + 1}`,
        index + 1,
      ),
    );
    writeHistoryJson(
      `workspaces/${workspaceId}/sessions/index.json`,
      records.map(sessionSummary),
    );
    for (const record of records) {
      writeHistoryJson(
        `workspaces/${workspaceId}/sessions/${record.id}.json`,
        record,
      );
    }

    await historyStore.listSessions(workspaceId);
    await vi.runOnlyPendingTimersAsync();

    const newest = records[5];
    const oldest = records[0];
    writeHistoryJson(`workspaces/${workspaceId}/sessions/${newest.id}.json`, {
      ...newest,
      title: 'changed newest',
    });
    writeHistoryJson(`workspaces/${workspaceId}/sessions/${oldest.id}.json`, {
      ...oldest,
      title: 'changed oldest',
    });

    await expect(
      historyStore.getSession(workspaceId, newest.id),
    ).resolves.toMatchObject({ title: newest.title });
    await expect(
      historyStore.getSession(workspaceId, oldest.id),
    ).resolves.toMatchObject({ title: 'changed oldest' });
  });

  it('keeps only the five most recently used session records', async () => {
    const workspaceId = await deriveWorkspaceId('E:\\MoonGame\\Client\\Game');
    const records = Array.from({ length: 6 }, (_, index) =>
      sessionRecord(
        workspaceId,
        `lru_${index + 1}`,
        `lru ${index + 1}`,
        index + 1,
      ),
    );
    for (const record of records) {
      writeHistoryJson(
        `workspaces/${workspaceId}/sessions/${record.id}.json`,
        record,
      );
      await historyStore.getSession(workspaceId, record.id);
    }

    const evicted = records[0];
    const cached = records[5];
    writeHistoryJson(`workspaces/${workspaceId}/sessions/${evicted.id}.json`, {
      ...evicted,
      title: 'changed evicted',
    });
    writeHistoryJson(`workspaces/${workspaceId}/sessions/${cached.id}.json`, {
      ...cached,
      title: 'changed cached',
    });

    await expect(
      historyStore.getSession(workspaceId, evicted.id),
    ).resolves.toMatchObject({ title: 'changed evicted' });
    await expect(
      historyStore.getSession(workspaceId, cached.id),
    ).resolves.toMatchObject({ title: cached.title });
  });

  it('forgets deleted sessions even when they were cached', async () => {
    const workspaceId = await deriveWorkspaceId('E:\\DeleteCache');
    const workspace: WorkspaceRecord = {
      id: workspaceId,
      path: 'E:\\DeleteCache',
      name: 'DeleteCache',
      createdAt: 1,
      updatedAt: 1,
      sessionCount: 1,
      lastActiveSessionId: 's_delete',
    };
    const record = sessionRecord(workspaceId, 's_delete', 'delete me', 2);
    writeHistoryJson('workspaces/index.json', [workspaceSummary(workspace)]);
    writeHistoryJson(`workspaces/${workspaceId}/meta.json`, workspace);
    writeHistoryJson(`workspaces/${workspaceId}/sessions/index.json`, [
      sessionSummary(record),
    ]);
    writeHistoryJson(
      `workspaces/${workspaceId}/sessions/${record.id}.json`,
      record,
    );

    await expect(
      historyStore.getSession(workspaceId, record.id),
    ).resolves.toMatchObject({ title: record.title });

    await historyStore.deleteSession(workspaceId, record.id);

    await expect(historyStore.getSession(workspaceId, record.id)).resolves.toBe(
      null,
    );
  });
});

describe('historyStore workspace reconciliation', () => {
  it('merges legacy duplicate Windows workspace buckets by path identity', async () => {
    const canonicalId = await deriveWorkspaceId('E:\\UltraGameStudio');
    const legacyId = 'legacy_ultragamestudio';
    const canonicalWorkspace: WorkspaceRecord = {
      id: canonicalId,
      path: 'e:\\UltraGameStudio',
      name: 'UltraGameStudio',
      createdAt: 10,
      updatedAt: 20,
      sessionCount: 1,
      lastActiveSessionId: 's_lower',
    };
    const legacyWorkspace: WorkspaceRecord = {
      id: legacyId,
      path: 'E:\\UltraGameStudio',
      name: 'UltraGameStudio',
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
      path: 'E:\\UltraGameStudio',
      name: 'UltraGameStudio',
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
    const canonicalId = await deriveWorkspaceId('E:\\UltraGameStudio');
    const legacyId = 'legacy_ultragamestudio';
    const canonicalWorkspace: WorkspaceRecord = {
      id: canonicalId,
      path: 'e:\\UltraGameStudio',
      name: 'UltraGameStudio',
      createdAt: 10,
      updatedAt: 20,
      sessionCount: 1,
      lastActiveSessionId: 's_lower',
    };
    const legacyWorkspace: WorkspaceRecord = {
      id: legacyId,
      path: 'E:\\UltraGameStudio',
      name: 'UltraGameStudio',
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
    const canonicalId = await deriveWorkspaceId('E:\\UltraGameStudio');
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
      path: 'E:\\UltraGameStudio',
      name: 'UltraGameStudio',
      createdAt: 10,
      updatedAt: 20,
      sessionCount: 1,
      lastActiveSessionId: 's_new',
    };
    const legacyWorkspace: WorkspaceRecord = {
      id: legacyId,
      path: 'e:\\UltraGameStudio',
      name: 'UltraGameStudio',
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
      'polluted UltraGameStudio chat',
      35,
    );
    const canonicalSession = sessionRecord(
      canonicalId,
      's_new',
      'canonical UltraGameStudio chat',
      20,
    );
    const legacySession = sessionRecord(
      legacyId,
      's_old',
      'legacy UltraGameStudio chat',
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
    const workspaceId = await deriveWorkspaceId('E:\\UltraGameStudio');
    const workspace: WorkspaceRecord = {
      id: workspaceId,
      path: 'E:\\UltraGameStudio',
      name: 'UltraGameStudio',
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
