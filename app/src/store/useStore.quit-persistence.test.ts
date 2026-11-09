import { afterEach, expect, it, vi } from 'vitest';
import { simpleBlueprint } from '@/core/defaultBlueprint';
import { historyStore } from './history/store';
import { activeAiEdits, aiEditSnapshots } from './channelRegistry';
import { addAiEditChannel, aiEditCommitMessages, flushChatPersistenceForQuit, removeAiEditChannel, syncAndPersistSessionRunStatus, useStore } from './useStore';
import type { AiEditChannel } from './channelTypes';

let channel: AiEditChannel | undefined;
afterEach(async () => {
  if (channel) { removeAiEditChannel(channel); channel = undefined; }
  await historyStore.flush().catch(() => {});
  activeAiEdits.clear();
  aiEditSnapshots.clear();
  vi.restoreAllMocks();
});

it('quit drains unsubmitted producer timers and persists the final reply before the history barrier resolves', async () => {
  await historyStore.ready();
  const id = `quit-producer-${Date.now()}`;
  await historyStore.createSession({ workspaceId: '__default__', id, isWorkflow: false, title: 'Quit fixture', messages: [] });
  useStore.setState({ activeWorkspaceId: 'other', activeSessionId: 'other', messages: [] });
  channel = {
    key: `__default__::${id}::turn`, sessionKey: `__default__::${id}`, workspaceId: '__default__', sessionId: id,
    workflow: simpleBlueprint('Quit fixture'), chat: true, workflowSession: false,
    ownedMessageIds: new Set(['reply']), activeAssistantMessageId: 'reply',
    messages: [{ id: 'reply', role: 'assistant', text: 'must survive quit', createdAt: 1 }],
    cliRunIds: new Set(), abortController: new AbortController(),
  };
  addAiEditChannel(channel);
  aiEditCommitMessages(channel, true);
  await flushChatPersistenceForQuit();
  const bytes = window.localStorage.getItem(`ultragamestudio.history.v1:workspaces/__default__/sessions/${id}.json`);
  expect(JSON.parse(bytes!).messages.find((message: { id: string }) => message.id === 'reply')?.text).toBe('must survive quit');
  expect(channel.abortController.signal.aborted).toBe(true);
  expect(activeAiEdits.has(channel.key)).toBe(false);
});

it('a second quit attempt retries retained failed finals rather than accepting an empty barrier', async () => {
  await historyStore.ready();
  const id = `quit-retry-${Date.now()}`;
  await historyStore.createSession({ workspaceId: '__default__', id, isWorkflow: false, title: 'Retry fixture', messages: [] });
  useStore.setState({ activeWorkspaceId: 'other', activeSessionId: 'other', messages: [] });
  channel = {
    key: `__default__::${id}::turn`, sessionKey: `__default__::${id}`, workspaceId: '__default__', sessionId: id,
    workflow: simpleBlueprint('Retry fixture'), chat: true, workflowSession: false,
    ownedMessageIds: new Set(['retry-reply']), activeAssistantMessageId: 'retry-reply',
    messages: [{ id: 'retry-reply', role: 'assistant', text: 'retry must persist this', createdAt: 1 }],
    cliRunIds: new Set(), abortController: new AbortController(),
  };
  addAiEditChannel(channel);
  aiEditCommitMessages(channel, true);
  const key = `ultragamestudio.history.v1:workspaces/__default__/sessions/${id}.json`;
  const original = Storage.prototype.setItem;
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, name, value) {
    if (name === key) throw new Error('fixture disk unavailable');
    original.call(this, name, value);
  });
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await expect(flushChatPersistenceForQuit()).rejects.toThrow();
  expect(JSON.parse(window.localStorage.getItem(key)!).messages).toEqual([]);
  write.mockRestore();
  await flushChatPersistenceForQuit();
  expect(JSON.parse(window.localStorage.getItem(key)!).messages.find((message: { id: string }) => message.id === 'retry-reply')?.text)
    .toBe('retry must persist this');
  warning.mockRestore();
});

it('quit retries an undurable terminal status before finishing', async () => {
  await historyStore.ready();
  const id = `quit-status-${Date.now()}`;
  await historyStore.createSession({ workspaceId: '__default__', id, isWorkflow: false,
    title: '状态恢复', meta: { runStatus: 'interrupted' } });
  const original = historyStore.updateSession.bind(historyStore);
  const write = vi.spyOn(historyStore, 'updateSession')
    .mockRejectedValueOnce(new Error('状态暂时写入失败'))
    .mockImplementation(original);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    syncAndPersistSessionRunStatus({ workspaceId: '__default__', sessionId: id }, 'success');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushChatPersistenceForQuit();
    expect((await historyStore.getSession('__default__', id))?.meta?.runStatus).toBe('success');
    expect(write).toHaveBeenCalledTimes(2);
  } finally {
    warning.mockRestore();
    write.mockRestore();
  }
});

it('does not accept quit while the latest terminal status still cannot be saved', async () => {
  await historyStore.ready();
  const id = `quit-status-failure-${Date.now()}`;
  await historyStore.createSession({ workspaceId: '__default__', id, isWorkflow: false,
    title: '状态未保存', meta: { runStatus: 'interrupted' } });
  const write = vi.spyOn(historyStore, 'updateSession').mockRejectedValue(new Error('状态持续写入失败'));
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    syncAndPersistSessionRunStatus({ workspaceId: '__default__', sessionId: id }, 'success');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(flushChatPersistenceForQuit()).rejects.toThrow('状态持续写入失败');
    write.mockRestore();
    await flushChatPersistenceForQuit();
    expect((await historyStore.getSession('__default__', id))?.meta?.runStatus).toBe('success');
  } finally {
    warning.mockRestore();
    write.mockRestore();
  }
});
