import { afterEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { simpleBlueprint } from '@/core/defaultBlueprint';
import { activeAiEdits, aiEditSnapshots, activeRuns } from './channelRegistry';
import type { AiEditChannel, RunChannel } from './channelTypes';
import { __resetHistorySessionCacheForTests, historyStore } from './history/store';
import { addAiEditChannel, flushChatPersistenceForQuit, removeAiEditChannel, useStore } from './useStore';

vi.mock('@/lib/tauri', async (original) => ({ ...(await original()), tauriAvailable: () => !!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ }));

interface NativeArgs { relPath?: string; relPaths?: string[]; json?: string }
type NativeWindow = Window & { __TAURI_INTERNALS__?: { invoke: (name: string, args?: NativeArgs) => Promise<unknown> } };
interface BackingMessage { id: string; text: unknown }
interface BackingRecord { messages: BackingMessage[]; [key: string]: unknown }
interface JournalPayload {
  __ugsJournal?: number;
  fields?: Record<string, unknown>;
  deleted?: string[];
  messages: { upserts: BackingMessage[]; order?: string[] };
}

const channels: AiEditChannel[] = [];
let root: string | undefined;
afterEach(async () => {
  for (const channel of channels.splice(0)) removeAiEditChannel(channel);
  await flushChatPersistenceForQuit().catch(() => {});
  await historyStore.flush().catch(() => {});
  activeAiEdits.clear();
  aiEditSnapshots.clear();
  activeRuns.clear();
  __resetHistorySessionCacheForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (window as NativeWindow).__TAURI_INTERNALS__;
  if (root) { rmSync(root, { recursive: true, force: true }); root = undefined; }
});

it.each([[false, false, false], [true, false, false], [false, true, false], [true, true, false], [false, false, true], [false, true, true]])('quit durably saves multiple large replies without overflowing the bounded byte queue (retired: %s, overlapping: %s, workflow: %s)', async (retired, overlapping, workflowFinal) => {
  root = mkdtempSync(join(tmpdir(), 'ugs-quit-byte-pressure-'));
  vi.stubGlobal('crypto', webcrypto);
  let blockWrites = false;
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const nativeInvoke = async (name: string, args: NativeArgs = {}) => {
    const path = join(root!, args.relPath ?? '');
    if (name === 'history_read_json') return existsSync(path) ? readFileSync(path, 'utf8') : null;
    if (name === 'history_read_chunks') return args.relPaths!.map((rel) => {
      const chunk = join(root!, rel);
      return existsSync(chunk) ? readFileSync(chunk, 'utf8') : null;
    });
    if (name === 'history_list_dir') return existsSync(path) ? readdirSync(path) : [];
    if (name === 'history_write_json') {
      // Retiring a fixture can already persist earlier sessions while the next
      // session is created; hold the first remaining real write in that case.
      if (blockWrites && args.relPath?.includes(retired ? 'quit-byte-pressure-' : 'quit-byte-pressure-0')) {
        blockWrites = false;
        entered();
        await held;
      }
      const payload = JSON.parse(args.json!) as JournalPayload;
      if (payload.__ugsJournal === 1) {
        const saved = JSON.parse(readFileSync(path, 'utf8')) as BackingRecord;
        Object.assign(saved, payload.fields);
        for (const key of payload.deleted ?? []) delete saved[key];
        const byId = new Map(saved.messages.map((message) => [message.id, message]));
        for (const message of payload.messages.upserts) byId.set(message.id, message);
        saved.messages = (payload.messages.order ?? saved.messages.map((message) => message.id)).map((id) => byId.get(id)!);
        writeFileSync(path, JSON.stringify(saved));
      } else {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, args.json!);
      }
      return;
    }
    throw new Error(`Unexpected native boundary: ${name}`);
  };
  (window as NativeWindow).__TAURI_INTERNALS__ = { invoke: nativeInvoke };
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  useStore.setState({ activeWorkspaceId: 'other', activeSessionId: 'other', messages: [] });
  for (let index = 0; index < 4; index++) {
    const id = `quit-byte-pressure-${index}`;
    const workflow = simpleBlueprint('Byte pressure');
    await historyStore.createSession({ workspaceId: '__default__', id, isWorkflow: workflowFinal, ...(workflowFinal ? { workflow } : {}), messages: [], meta: { runStatus: retired ? 'success' : 'running' } });
    if (workflowFinal) {
      const channel: RunChannel = {
        key: `__default__::${id}`, workspaceId: '__default__', sessionId: id, workflow, cancelled: false,
        config: {}, cliRunIds: new Set(), messages: [{ id: 'final', role: 'assistant', text: `${index}:` + 'x'.repeat(1_200_000), createdAt: 1 }],
        runState: { node: 'running' }, runOutputs: { node: `output-${index}` }, failedNodeId: null, error: null,
      };
      activeRuns.set(channel.key, channel);
      continue;
    }
    const channel: AiEditChannel = {
      key: `__default__::${id}::turn`, sessionKey: `__default__::${id}`, workspaceId: '__default__', sessionId: id,
      workflow: simpleBlueprint('Byte pressure'), chat: true, workflowSession: false,
      ownedMessageIds: new Set(['final']), activeAssistantMessageId: 'final',
      messages: [{ id: 'final', role: 'assistant', text: `${index}:` + 'x'.repeat(1_200_000), createdAt: 1 }],
      cliRunIds: new Set(), abortController: new AbortController(),
    };
    channels.push(channel);
    addAiEditChannel(channel);
    if (retired) removeAiEditChannel(channel);
  }
  blockWrites = overlapping;
  const quits = Array.from({ length: overlapping ? 4 : 1 }, () => flushChatPersistenceForQuit().then(() => null, (error: unknown) => error));
  let results: unknown[];
  try {
    if (overlapping) { await started; await new Promise((resolve) => setTimeout(resolve, 20)); }
  } finally {
    release();
    results = await Promise.all(quits);
  }
  await historyStore.flush().catch(() => {});
  for (const result of results) expect(result).toBeNull();
  expect(warning).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ message: 'HISTORY_QUEUE_BYTES_FULL' }));
  // A new process hydrates only actual backing files, not store/registry caches.
  const reader = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { readFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { createHash } from 'node:crypto';
    const root = process.argv[1];
    const results = [];
    for (let index = 0; index < 4; index++) {
      const rel = 'workspaces/__default__/sessions/quit-byte-pressure-' + index + '.json';
      const saved = JSON.parse(readFileSync(join(root, rel), 'utf8'));
      const value = saved.messages.find(message => message.id === 'final').text;
      const text = typeof value === 'string' ? value : value.chunks.map(hash => {
        const chunk = JSON.parse(readFileSync(join(root, rel + '.chunks/' + hash + '.json'), 'utf8')).text;
        if (createHash('sha256').update(chunk).digest('hex') !== hash) throw new Error('invalid chunk hash');
        return chunk;
      }).join('') + (value.tail ?? '');
      results.push({ exact: text === index + ':' + 'x'.repeat(1_200_000), status: saved.meta?.runStatus,
        ...(process.argv[2] === 'true' ? { snapshot: saved.workflow.meta.run.status, output: saved.meta.runOutputs.node } : {}) });
    }
    console.log(JSON.stringify(results));
  `, root, String(workflowFinal)], { encoding: 'utf8', timeout: 10_000 });
  expect(reader.error).toBeUndefined();
  expect(reader.status, reader.stderr).toBe(0);
  expect(JSON.parse(reader.stdout)).toEqual(Array.from({ length: 4 }, (_, index) => ({ exact: true, status: retired ? 'success' : 'interrupted',
    ...(workflowFinal ? { snapshot: 'interrupted', output: `output-${index}` } : {}) })));
});

it.each([false, true])('overlapping quit callers preserve the same failed final without an implicit retry (workflow: %s)', async (workflowFinal) => {
  const id = `quit-shared-failure-${workflowFinal}`;
  const workflow = simpleBlueprint('Shared failure');
  await historyStore.createSession({ workspaceId: '__default__', id, isWorkflow: workflowFinal,
    ...(workflowFinal ? { workflow } : {}), messages: [], meta: { runStatus: 'running' } });
  useStore.setState({ activeWorkspaceId: 'other', activeSessionId: 'other', messages: [] });
  const messages = [{ id: 'final', role: 'assistant' as const, text: 'exact undurable final', createdAt: 1 }];
  if (workflowFinal) {
    activeRuns.set(id, { key: id, workspaceId: '__default__', sessionId: id, workflow, cancelled: false,
      config: {}, cliRunIds: new Set(), messages, runState: {}, runOutputs: { node: 'exact output' }, failedNodeId: null, error: null });
  } else {
    const channel: AiEditChannel = { key: `__default__::${id}::turn`, sessionKey: `__default__::${id}`,
      workspaceId: '__default__', sessionId: id, workflow, chat: true, workflowSession: false,
      ownedMessageIds: new Set(['final']), activeAssistantMessageId: 'final', messages,
      cliRunIds: new Set(), abortController: new AbortController() };
    channels.push(channel); addAiEditChannel(channel);
  }
  const failure = new Error('exact shared backing failure');
  const storageKey = `ultragamestudio.history.v1:workspaces/__default__/sessions/${id}.json`;
  const setItem = Storage.prototype.setItem;
  let writes = 0;
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const writer = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (key === storageKey && (JSON.parse(value) as BackingRecord).messages.some((message) => message.id === 'final')) { writes++; throw failure; }
    setItem.call(this, key, value);
  });
  const quits = Array.from({ length: 4 }, () => flushChatPersistenceForQuit().then(() => null, (error: unknown) => error));
  const results = await Promise.all(quits);
  expect(results).toEqual([failure, failure, failure, failure]);
  expect(writes).toBe(1);
  expect(JSON.parse(localStorage.getItem(storageKey)!).messages).toEqual([]);
  writer.mockRestore();
  await flushChatPersistenceForQuit();
  __resetHistorySessionCacheForTests();
  expect(JSON.parse(localStorage.getItem(storageKey)!).messages.find((message: BackingMessage) => message.id === 'final').text).toBe('exact undurable final');
  warning.mockRestore();
});
