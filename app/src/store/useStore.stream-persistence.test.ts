import { afterEach, describe, expect, it, vi } from 'vitest';
import { simpleBlueprint } from '@/core/defaultBlueprint';
import { encodeToolPatch } from '@/components/ai/lib/toolEvent';
import { historyStore, __resetHistorySessionCacheForTests } from './history/store';
import { addAiEditChannel, aiEditCommitMessages, getSessionConversationMessages, newerMessage, removeAiEditChannel, useStore } from './useStore';
import type { AiEditChannel } from './channelTypes';
import { activeAiEdits, aiEditSnapshots, getAiEditSnapshotsForSession } from './channelRegistry';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('流式回复持久化', () => {
  it('实时状态仍在界面，持久化只保存正文和非临时工具事件', async () => {
    await historyStore.ready();
    const id = `stream-ephemeral-${Date.now()}`;
    await historyStore.createSession({ workspaceId: '__default__', id, isWorkflow: false, messages: [] });
    vi.useFakeTimers();
    const temporary = encodeToolPatch({ id: 'heartbeat', name: '运行状态', ephemeral: true });
    const durable = encodeToolPatch({ id: 'tool', name: 'read', status: 'done', result: '完整结果' });
    const ch: AiEditChannel = {
      key: `__default__::${id}::turn`, sessionKey: `__default__::${id}`,
      workspaceId: '__default__', sessionId: id, workflow: simpleBlueprint('状态过滤'), chat: true,
      workflowSession: false, activeAssistantMessageId: 'a', ownedMessageIds: new Set(['a']),
      messages: [{ id: 'a', role: 'assistant', text: `正文${temporary}${durable}`, createdAt: 2 }],
      cliRunIds: new Set(), abortController: new AbortController(),
    };
    addAiEditChannel(ch);
    ch.messages = ch.messages.map((message) => ({ ...message }));
    aiEditCommitMessages(ch, false);
    await vi.advanceTimersByTimeAsync(2_100);
    await historyStore.getSession('__default__', id);
    const saved = await historyStore.getSessionForGeneration('__default__', id);
    expect(ch.messages[0].text).toContain(temporary);
    expect(saved?.messages[0].text).not.toContain('heartbeat');
    expect(saved?.messages[0].text).toContain(durable);
    removeAiEditChannel(ch);
  });

  it('同会话兄弟回合成功不能使另一个失败 final 被淘汰', async () => {
    aiEditSnapshots.clear();
    useStore.setState({ activeWorkspaceId: 'other', activeSessionId: 'other', messages: [] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const records = new Map<string, Array<{ id: string; text: string }>>();
    vi.spyOn(historyStore, 'updateSession').mockImplementation(async (_ws, session, patch) => {
      if (session === 'siblings' && patch.messages?.some((message) => message.id === 'failed')) throw new Error('sibling final failed');
      records.set(session, [...records.get(session) ?? [], ...structuredClone(patch.messages ?? [])]);
      return {} as never;
    });
    vi.spyOn(historyStore, 'getSession').mockImplementation(async (_ws, session) => ({ id: session, messages: records.get(session) ?? [] } as never));
    const make = (session: string, id: string): AiEditChannel => ({
      key: `sibling-ws::${session}::${id}`, sessionKey: `sibling-ws::${session}`, workspaceId: 'sibling-ws', sessionId: session,
      workflow: simpleBlueprint('Siblings'), chat: true, workflowSession: false, ownedMessageIds: new Set([id]),
      messages: [{ id, role: 'assistant', text: id === 'failed' ? '不可丢的兄弟 final' : id, createdAt: 1 }],
      cliRunIds: new Set(), abortController: new AbortController(),
    });
    for (const id of ['failed', 'success']) {
      const ch = make('siblings', id);
      addAiEditChannel(ch);
      aiEditCommitMessages(ch, true);
      removeAiEditChannel(ch);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    for (let index = 0; index < 40; index += 1) {
      const ch = make(`extra-${index}`, `extra-${index}`);
      addAiEditChannel(ch);
      aiEditCommitMessages(ch, true);
      removeAiEditChannel(ch);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(records.get('siblings')?.some((message) => message.id === 'failed')).toBe(false);
    const restored = await getSessionConversationMessages('sibling-ws', 'siblings');
    expect(restored.find((message) => message.id === 'failed')?.text).toBe('不可丢的兄弟 final');
    expect(restored.find((message) => message.id === 'success')?.text).toBe('success');
    expect(warn).toHaveBeenCalled();
    aiEditSnapshots.clear();
  });

  it('真实序列化最终记录在淘汰内存快照并清空 history cache 后恢复', async () => {
    await historyStore.ready();
    aiEditSnapshots.clear();
    useStore.setState({ activeWorkspaceId: 'other', activeSessionId: 'other', messages: [] });
    const prefix = `durable-capacity-${Date.now()}`;
    for (let index = 0; index < 35; index += 1) {
      const id = `${prefix}-${index}`;
      await historyStore.createSession({ workspaceId: '__default__', id, isWorkflow: false, messages: [], title: 'Durable capacity' });
      const ch: AiEditChannel = {
        key: `__default__::${id}::turn`, sessionKey: `__default__::${id}`, workspaceId: '__default__', sessionId: id,
        workflow: simpleBlueprint('Durable capacity'), chat: true, workflowSession: false, ownedMessageIds: new Set([id]),
        messages: [{ id, role: 'assistant', text: `真实最终${index}`, createdAt: 1 }],
        cliRunIds: new Set(), abortController: new AbortController(),
      };
      addAiEditChannel(ch);
      aiEditCommitMessages(ch, true);
      removeAiEditChannel(ch);
      await historyStore.getSession('__default__', id);
    }
    const first = `${prefix}-0`;
    const bytes = window.localStorage.getItem(`ultragamestudio.history.v1:workspaces/__default__/sessions/${first}.json`);
    expect(bytes).toContain('真实最终0');
    expect(JSON.parse(bytes!).messages[0].completedAt).toBeTypeOf('number');
    expect(aiEditSnapshots.size).toBeLessThanOrEqual(32);
    expect(aiEditSnapshots.has(`__default__::${first}::turn`)).toBe(false);
    __resetHistorySessionCacheForTests();
    const restored = await getSessionConversationMessages('__default__', first);
    expect(restored[0].text).toBe('真实最终0');
    expect(restored[0].completedAt).toBeTypeOf('number');
    aiEditSnapshots.clear();
  });

  it('durable 写入未完成时同时恢复完成回合与另一个活动回合', async () => {
    aiEditSnapshots.clear();
    useStore.setState({ activeWorkspaceId: 'other', activeSessionId: 'other', messages: [] });
    const old = [{ id: 'a1', role: 'assistant' as const, text: '过期一', createdAt: 1 },
      { id: 'a2', role: 'assistant' as const, text: '过期二', createdAt: 2 }];
    vi.spyOn(historyStore, 'getSession').mockResolvedValue({ id: 'concurrent', messages: old } as never);
    const writes: Array<() => void> = [];
    vi.spyOn(historyStore, 'updateSession').mockImplementation(() => new Promise((resolve) => {
      writes.push(() => resolve({} as never));
    }));
    const make = (id: string): AiEditChannel => ({
      key: `restore::concurrent::${id}`, sessionKey: 'restore::concurrent', workspaceId: 'restore', sessionId: 'concurrent',
      workflow: simpleBlueprint('Concurrent restore'), chat: true, workflowSession: false, activeAssistantMessageId: id,
      ownedMessageIds: new Set([id]), messages: old,
      cliRunIds: new Set(), abortController: new AbortController(),
    });
    const first = make('a1');
    const second = make('a2');
    addAiEditChannel(first);
    addAiEditChannel(second);
    first.messages = [{ ...old[0], text: '最终一', streamUpdatedAt: 5, completedAt: 5 }, old[1]];
    first.activeAssistantMessageId = undefined;
    aiEditCommitMessages(first, true);
    removeAiEditChannel(first);
    second.messages = [old[0], { ...old[1], text: '活动二', streamUpdatedAt: 6 }];
    aiEditCommitMessages(second, false);
    try {
      const result = await getSessionConversationMessages('restore', 'concurrent');
      expect(result.map((message) => message.text)).toEqual(['最终一', '活动二']);
      expect(result[1].completedAt).toBeUndefined();
    } finally {
      removeAiEditChannel(second);
      for (const finish of writes) finish();
      await Promise.resolve();
      aiEditSnapshots.clear();
    }
  });

  it('旧 checkpoint 成功不能把更新但失败的最终快照标为可淘汰', async () => {
    vi.useFakeTimers();
    aiEditSnapshots.clear();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let oldDone!: () => void;
    let targetWrites = 0;
    vi.spyOn(historyStore, 'updateSession').mockImplementation(async (_ws, session) => {
      if (session !== 'failed-final') return {} as never;
      targetWrites += 1;
      if (targetWrites === 1) await new Promise<void>((resolve) => { oldDone = resolve; });
      else throw new Error('durable final failed');
      return {} as never;
    });
    const make = (session: string): AiEditChannel => ({
      key: `failure::${session}::turn`, sessionKey: `failure::${session}`, workspaceId: 'failure', sessionId: session,
      workflow: simpleBlueprint('Failure'), chat: true, workflowSession: false, activeAssistantMessageId: session,
      ownedMessageIds: new Set([session]), messages: [{ id: session, role: 'assistant', text: '过程', createdAt: 1 }],
      cliRunIds: new Set(), abortController: new AbortController(),
    });
    const target = make('failed-final');
    addAiEditChannel(target);
    target.messages = [{ ...target.messages[0], text: '旧 checkpoint 文本' }];
    aiEditCommitMessages(target, false);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(oldDone).toBeTypeOf('function');
    target.messages = [{ ...target.messages[0], text: '不可丢失最终状态' }];
    target.activeAssistantMessageId = undefined;
    aiEditCommitMessages(target, true);
    removeAiEditChannel(target);
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 0; index < 40; index += 1) {
      const ch = make(`ok-${index}`);
      addAiEditChannel(ch);
      aiEditCommitMessages(ch, true);
      removeAiEditChannel(ch);
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(aiEditSnapshots.has(target.key)).toBe(true);
    oldDone();
    await vi.advanceTimersByTimeAsync(0);
    const extra = make('ok-extra');
    addAiEditChannel(extra);
    aiEditCommitMessages(extra, true);
    removeAiEditChannel(extra);
    await vi.advanceTimersByTimeAsync(0);
    expect(aiEditSnapshots.get(target.key)?.messages[0].text).toBe('不可丢失最终状态');
    expect(warn).toHaveBeenCalled();
    aiEditSnapshots.clear();
  });

  it('完成快照全局有界，淘汰后从 durable 历史恢复且活动通道保留', async () => {
    aiEditSnapshots.clear();
    const records = new Map<string, Array<{ id: string; role: 'assistant'; text: string; createdAt: number; completedAt?: number }>>();
    vi.spyOn(historyStore, 'updateSession').mockImplementation(async (_ws, session, patch) => {
      records.set(session, structuredClone(patch.messages ?? []) as never);
      return {} as never;
    });
    vi.spyOn(historyStore, 'getSession').mockImplementation(async (_ws, session) => records.has(session)
      ? { id: session, messages: records.get(session), isWorkflow: false } as never : null);
    const make = (session: string): AiEditChannel => ({
      key: `capacity::${session}::turn`, sessionKey: `capacity::${session}`, workspaceId: 'capacity', sessionId: session,
      workflow: simpleBlueprint('Capacity'), chat: true, workflowSession: false, ownedMessageIds: new Set([session]),
      messages: [{ id: session, role: 'assistant', text: `最终${session}`, createdAt: 1 }],
      cliRunIds: new Set(), abortController: new AbortController(),
    });
    const active = make('active');
    addAiEditChannel(active);
    try {
      for (let index = 0; index < 40; index += 1) {
        const ch = make(`s${index}`);
        addAiEditChannel(ch);
        aiEditCommitMessages(ch, true);
        removeAiEditChannel(ch);
        await Promise.resolve();
      }
      expect(aiEditSnapshots.size).toBeLessThanOrEqual(33);
      expect(aiEditSnapshots.has(active.key)).toBe(true);
      expect(activeAiEdits.get(active.key)).toBe(active);
      expect(aiEditSnapshots.has('capacity::s0::turn')).toBe(false);
      useStore.setState({ activeWorkspaceId: 'other', activeSessionId: 'other', messages: [] });
      expect((await getSessionConversationMessages('capacity', 's0'))[0].text).toBe('最终s0');
      expect(records.get('s0')?.[0].completedAt).toBeTypeOf('number');
    } finally { removeAiEditChannel(active); aiEditSnapshots.clear(); }
  });

  it('完成快照按会话去重并合并后台并发回合', () => {
    aiEditSnapshots.clear();
    const make = (turn: string): AiEditChannel => ({
      key: `bounded::session::${turn}`, sessionKey: 'bounded::session', workspaceId: 'bounded', sessionId: 'session',
      workflow: simpleBlueprint('Concurrent'), chat: true, workflowSession: false,
      ownedMessageIds: new Set([turn]), messages: [{ id: turn, role: 'assistant', text: `完成${turn}`, createdAt: 1, completedAt: 2 }],
      cliRunIds: new Set(), abortController: new AbortController(),
    });
    const first = make('first');
    const second = make('second');
    addAiEditChannel(first);
    addAiEditChannel(second);
    removeAiEditChannel(first);
    expect(activeAiEdits.get(second.key)).toBe(second);
    removeAiEditChannel(second);
    const snapshots = getAiEditSnapshotsForSession('bounded', 'session');
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].messages.map((message) => message.id).sort()).toEqual(['first', 'second']);
    aiEditSnapshots.clear();
  });

  it('活跃回合快照共享不可变历史数组', () => {
    aiEditSnapshots.clear();
    const messages = [{ id: 'a', role: 'assistant' as const, text: '完成', createdAt: 1, completedAt: 2 }];
    const channel = (turn: number): AiEditChannel => ({
      key: `bounded::session::${turn}`, sessionKey: 'bounded::session', workspaceId: 'bounded', sessionId: 'session',
      workflow: simpleBlueprint('Bounded'), chat: true, workflowSession: false,
      activeAssistantMessageId: 'a', ownedMessageIds: new Set(['a']), messages,
      cliRunIds: new Set(), abortController: new AbortController(),
    });
    for (let turn = 0; turn < 10; turn += 1) {
      const ch = channel(turn);
      addAiEditChannel(ch);
      expect(aiEditSnapshots.get(ch.key)?.messages).toBe(ch.messages);
      removeAiEditChannel(ch);
    }
    aiEditSnapshots.clear();
  });

  it('持续输出时定期保存最新内容，不提前标记完成', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    const writes: Array<{ messages?: Array<{ id: string; text: string; completedAt?: number }> }> = [];
    vi.spyOn(historyStore, 'updateSession').mockImplementation(async (_ws, _session, patch) => {
      writes.push(structuredClone(patch));
      return {} as never;
    });
    const ch: AiEditChannel = {
      key: 'stream-ws::session::turn', sessionKey: 'stream-ws::session', workspaceId: 'stream-ws',
      sessionId: 'session', workflow: simpleBlueprint('Chat'), chat: true, workflowSession: false,
      activeAssistantMessageId: 'a', ownedMessageIds: new Set(['u', 'a']),
      messages: [{ id: 'u', role: 'user', text: '执行', createdAt: 1 },
        { id: 'a', role: 'assistant', text: '⟳ 生成中…', createdAt: 2 }],
      cliRunIds: new Set(), abortController: new AbortController(),
    };
    useStore.setState({ activeWorkspaceId: 'stream-ws', activeSessionId: 'session', messages: ch.messages });
    try {
      addAiEditChannel(ch);
      aiEditCommitMessages(ch, true);
      for (let i = 0; i < 24; i += 1) {
        ch.messages = ch.messages.map((m) => m.id === 'a' ? { ...m, text: `步骤 ${i}` } : m);
        aiEditCommitMessages(ch, false);
        await vi.advanceTimersByTimeAsync(250);
      }
      expect(writes.length).toBeGreaterThanOrEqual(2);
      await vi.advanceTimersByTimeAsync(2_000);
      const saved = writes.at(-1)?.messages?.find((m) => m.id === 'a');
      expect(saved?.text).toBe('步骤 23');
      expect(saved?.completedAt).toBeUndefined();
    } finally { removeAiEditChannel(ch); }
  });

  it('同一完成时间的消息使用流式修订时间区分新旧', () => {
    const old = { id: 'a', role: 'assistant' as const, text: '占位', createdAt: 1, completedAt: 5, streamUpdatedAt: 6 };
    const fresh = { ...old, text: '工具执行过程', streamUpdatedAt: 7 };
    expect(newerMessage(old, fresh)).toBe(fresh);
    expect(newerMessage(fresh, old)).toBe(fresh);
  });

  it('兼容旧版同时间戳的占位符与实际执行内容', () => {
    const old = { id: 'a', role: 'assistant' as const, text: '⏱ 09:00 → 09:00 · 耗时 0s\n⟳ 生成中…', createdAt: 1, completedAt: 5 };
    const fresh = { ...old, text: '已执行工具并准备文档' };
    expect(newerMessage(old, fresh)).toBe(fresh);
    expect(newerMessage(fresh, old)).toBe(fresh);
  });

  it('内存通道意外消失后仍可从历史中读取已保存的工具过程', async () => {
    await historyStore.ready();
    const id = `stream-restart-${Date.now()}`;
    await historyStore.createSession({ workspaceId: '__default__', id, isWorkflow: false, messages: [], title: '恢复验证' });
    vi.useFakeTimers();
    const ch: AiEditChannel = {
      key: `__default__::${id}::turn`, sessionKey: `__default__::${id}`,
      workspaceId: '__default__', sessionId: id, workflow: simpleBlueprint('恢复验证'), chat: true,
      workflowSession: false, activeAssistantMessageId: 'a', ownedMessageIds: new Set(['u', 'a']),
      messages: [{ id: 'u', role: 'user', text: '检查项目', createdAt: 1 },
        { id: 'a', role: 'assistant', text: '⟳ 生成中…', createdAt: 2 }],
      cliRunIds: new Set(), abortController: new AbortController(),
    };
    useStore.setState({ activeWorkspaceId: ch.workspaceId, activeSessionId: id, messages: ch.messages });
    addAiEditChannel(ch);
    ch.messages = ch.messages.map((message) => message.id === 'a' ? { ...message, text: '已读取项目并执行工具' } : message);
    aiEditCommitMessages(ch, false);
    await vi.advanceTimersByTimeAsync(2_100);
    await historyStore.getSession('__default__', id);
    const stored = window.localStorage.getItem(`ultragamestudio.history.v1:workspaces/__default__/sessions/${id}.json`);
    expect(stored).toContain('已读取项目并执行工具');
    activeAiEdits.delete(ch.key);
    aiEditSnapshots.delete(ch.key);
    useStore.setState({ activeWorkspaceId: 'other', activeSessionId: 'other', messages: [] });
    const restored = await getSessionConversationMessages('__default__', id);
    expect(restored.find((message) => message.id === 'a')?.text).toBe('已读取项目并执行工具');
    expect(restored.find((message) => message.id === 'a')?.completedAt).toBeUndefined();
  });
});
