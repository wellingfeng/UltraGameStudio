import { afterEach, describe, expect, it } from 'vitest';
import { aiEditSnapshots } from '@/store/channelRegistry';
import { collectPlatformNotifications } from './MessagePlatformRunner';
afterEach(() => aiEditSnapshots.clear());
describe('群通知只收集新完成回复', () => {
  it('过滤旧回复、未完成回复、本地卡片，并合并同一消息快照', () => {
    const channel: Parameters<typeof aiEditSnapshots.set>[1] = {
      key: 'a', sessionKey: 'project/session', workspaceId: 'project', sessionId: 'session',
      workflow: { version: 1, meta: {}, nodes: [], edges: [] }, cliRunIds: new Set(),
      abortController: new AbortController(), workflowSession: true, messages: [
        { id: 'old', role: 'assistant', text: '旧内容', createdAt: 90, completedAt: 99 },
        { id: 'running', role: 'assistant', text: '正在生成', createdAt: 100 },
        { id: 'card', role: 'assistant', text: '技能卡', localOnly: true, createdAt: 100, completedAt: 110 },
        { id: 'user', role: 'user', text: '输入', createdAt: 100, completedAt: 110 },
        { id: 'new', role: 'assistant', text: '完成结果', createdAt: 100, completedAt: 110 },
      ],
    };
    aiEditSnapshots.set('a', channel); aiEditSnapshots.set('b', channel);
    expect([...collectPlatformNotifications(100).values()]).toEqual([{ workspaceId: 'project', sessionId: 'session', text: '完成结果' }]);
  });
});
