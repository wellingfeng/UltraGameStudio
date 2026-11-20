import { afterEach, expect, it, vi } from 'vitest';
import { simpleBlueprint } from '@/core/defaultBlueprint';
import { activeAiEdits, aiEditSnapshots } from './channelRegistry';
import type { AiEditChannel } from './channelTypes';
import { historyStore } from './history/store';
import * as serialization from './history/serialization';
import { addAiEditChannel, aiEditCommitMessages, flushChatPersistenceForQuit, removeAiEditChannel, useStore } from './useStore';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

let channel: AiEditChannel | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (channel) { removeAiEditChannel(channel); channel = undefined; }
  await flushChatPersistenceForQuit().catch(() => {});
  await historyStore.flush().catch(() => {});
  activeAiEdits.clear();
  aiEditSnapshots.clear();
});

it('quit waits for an occupied history queue before saving the final reply and status', async () => {
  await historyStore.ready();
  const id = 'quit-queue-pressure';
  await historyStore.createSession({ workspaceId: '__default__', id, isWorkflow: false, messages: [] });
  useStore.setState({ activeWorkspaceId: 'other', activeSessionId: 'other', messages: [] });
  channel = {
    key: `__default__::${id}::turn`, sessionKey: `__default__::${id}`, workspaceId: '__default__', sessionId: id,
    workflow: simpleBlueprint('Queue pressure'), chat: true, workflowSession: false,
    ownedMessageIds: new Set(['final']), activeAssistantMessageId: 'final',
    messages: [{ id: 'final', role: 'assistant', text: 'final reply must survive', createdAt: 1 }],
    cliRunIds: new Set(), abortController: new AbortController(),
  };
  addAiEditChannel(channel);
  aiEditCommitMessages(channel, true);

  const started = deferred(), release = deferred();
  const relPath = `workspaces/__default__/sessions/${id}.json`;
  const serialize = serialization.serializeHistory;
  let held = false;
  vi.spyOn(serialization, 'serializeHistory').mockImplementation(async (value, options) => {
    if (!held && options?.relPath === relPath) {
      held = true;
      started.resolve();
      await release.promise;
    }
    return serialize(value, options);
  });
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const queued: Promise<unknown>[] = [];
  try {
    queued.push(historyStore.updateSession('__default__', id, { meta: { favorite: true } }));
    await started.promise;
    for (let i = 0; i < 127; i += 1) {
      queued.push(historyStore.updateSession('__default__', id, { meta: { favorite: i % 2 === 0 } }));
    }
    const quit = flushChatPersistenceForQuit().then(
      () => ({ error: null as unknown }),
      (error: unknown) => ({ error }),
    );
    let settled = false;
    void quit.then(() => { settled = true; });
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    const settledBeforeRelease = settled;
    release.resolve();
    await Promise.all(queued);
    const result = await quit;
    expect(settledBeforeRelease).toBe(false);
    expect(result.error).toBeNull();
    const bytes = localStorage.getItem(`ultragamestudio.history.v1:${relPath}`);
    const saved = JSON.parse(bytes!);
    expect(saved.messages.find((message: { id: string }) => message.id === 'final')?.text).toBe('final reply must survive');
    expect(saved.meta?.runStatus).toBe('interrupted');
  } finally {
    release.resolve();
    await Promise.allSettled(queued);
    warning.mockRestore();
  }
});
