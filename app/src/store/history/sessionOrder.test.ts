import { afterEach, expect, it, vi } from 'vitest';
import { deriveWorkspaceId } from './paths';
import { __resetHistorySessionCacheForTests, historyStore } from './store';
import { summaryFromRecord } from '../useStore';
import type { SessionRecord } from './types';

afterEach(() => {
  __resetHistorySessionCacheForTests();
  vi.useRealTimers();
  window.localStorage.clear();
});

it('recovers the latest user message time from a legacy index', async () => {
  const path = 'E:\\SessionOrderMigration';
  const workspaceId = await deriveWorkspaceId(path);
  const first: SessionRecord = {
    id: 'first', workspaceId, title: 'first', isWorkflow: false, createdAt: 10, updatedAt: 900,
    messages: [{ id: 'u1', role: 'user', text: 'first', createdAt: 100 },
      { id: 'a1', role: 'assistant', text: 'done', createdAt: 101, completedAt: 900 }],
  };
  const second: SessionRecord = {
    id: 'second', workspaceId, title: 'second', isWorkflow: false, createdAt: 20, updatedAt: 500,
    messages: [{ id: 'u2', role: 'user', text: 'second', createdAt: 200 }],
  };
  const prefix = 'ultragamestudio.history.v1:';
  const put = (name: string, value: unknown) => localStorage.setItem(prefix + name, JSON.stringify(value));
  put(`workspaces/${workspaceId}/sessions/index.json`, [first, second].map(({ messages, ...record }) => ({ ...record, activityVersion: 3, messageCount: messages.length })));
  put(`workspaces/${workspaceId}/sessions/first.json`, first);
  put(`workspaces/${workspaceId}/sessions/second.json`, second);
  const summaries = await historyStore.listSessions(workspaceId);
  expect(summaries.find((s) => s.id === 'first')?.lastUserMessageAt).toBe(100);
  expect(summaries.find((s) => s.id === 'second')?.lastUserMessageAt).toBe(200);
});

it('migrates indexed default-workspace sessions without importing unrelated files', async () => {
  const workspaceId = '__default__';
  const prefix = 'ultragamestudio.history.v1:';
  const put = (name: string, value: unknown) => localStorage.setItem(prefix + name, JSON.stringify(value));
  const record: SessionRecord = { id: 'indexed', workspaceId, title: 'indexed', isWorkflow: false,
    createdAt: 10, updatedAt: 900, messages: [{ id: 'u', role: 'user', text: 'hello', createdAt: 100 }] };
  put(`workspaces/${workspaceId}/meta.json`, { id: workspaceId, path: 'E:/default-workspace', name: 'default', createdAt: 1, updatedAt: 1, sessionCount: 1 });
  put(`workspaces/${workspaceId}/sessions/index.json`, [{ ...record, messages: undefined, activityVersion: 3, messageCount: 1 }]);
  put(`workspaces/${workspaceId}/sessions/indexed.json`, record);
  put(`workspaces/${workspaceId}/sessions/unindexed.json`, { ...record, id: 'unindexed' });
  const sessions = await historyStore.listSessions(workspaceId);
  expect(sessions.map((s) => s.id)).toEqual(['indexed']);
  expect(sessions[0].lastUserMessageAt).toBe(100);
});

it('persists the last send time across replies, message deletion and cache reload', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const workspaceId = '__default__';
  const user = { id: 'u', role: 'user' as const, text: 'hello', createdAt: 100 };
  const reply = { id: 'a', role: 'assistant' as const, text: 'done', createdAt: 110, completedAt: 500 };
  await historyStore.createSession({ workspaceId, id: 'test-order', isWorkflow: false, messages: [user] });
  await historyStore.updateSession(workspaceId, 'test-order', { messages: [user, reply] });
  await historyStore.updateSession(workspaceId, 'test-order', { messages: [reply] });
  __resetHistorySessionCacheForTests();
  expect((await historyStore.getSession(workspaceId, 'test-order'))?.lastUserMessageAt).toBe(100);
  expect((await historyStore.listSessions(workspaceId)).find((s) => s.id === 'test-order')?.lastUserMessageAt).toBe(100);
});

it('does not treat an active assistant clock as a completion time', () => {
  const start = new Date(2026, 10, 16, 12, 7).getTime();
  const record: SessionRecord = {
    id: 'stream', workspaceId: 'ws', title: 'stream', isWorkflow: false, createdAt: start, updatedAt: start,
    messages: [{ id: 'a', role: 'assistant', createdAt: start,
      text: '⏱ 12:07:00 → 12:09:00 · 耗时 2m\n⚙ 路由：测试\n⟳ 生成中…' }],
  };
  expect(summaryFromRecord(record).updatedAt).toBe(start);
});

it('recognizes an unfinished streamed reply and retains real completion timestamps', () => {
  const start = new Date(2026, 10, 16, 12, 7).getTime();
  const reply = { id: 'a', role: 'assistant' as const, createdAt: start, streamUpdatedAt: start + 1000,
    text: '⏱ 12:07:00 → 12:09:00 · 耗时 2m\n部分回复' };
  const record: SessionRecord = { id: 'stream', workspaceId: 'ws', title: 'stream', isWorkflow: false,
    createdAt: start, updatedAt: start, messages: [reply] };
  expect(summaryFromRecord(record).updatedAt).toBe(start);
  expect(summaryFromRecord({ ...record, messages: [{ ...reply, completedAt: start + 5000 }] }).updatedAt).toBe(start + 5000);
});
