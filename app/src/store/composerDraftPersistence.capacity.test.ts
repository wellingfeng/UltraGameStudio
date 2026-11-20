import { afterEach, expect, it, vi } from 'vitest';
import { historyStore, __resetHistorySessionCacheForTests } from './history/store';
import * as serialization from './history/serialization';
import { flushComposerDraftPersist, resetComposerDraftPersistForTests, scheduleComposerDraftPersist } from './composerDraftPersistence';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as tauri from '@/lib/tauri';

type NativeWindow = Window & { __TAURI_INTERNALS__?: { invoke: (name: string, args?: unknown) => Promise<unknown> } };

const ws = 'composer-cold-capacity-fixture';
const path = (id: string) => `workspaces/${ws}/sessions/${id}.json`;
const key = (id: string) => `ultragamestudio.history.v1:${path(id)}`;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { resolve, promise };
};

async function createColdSessions(ids: string[]): Promise<void> {
  await historyStore.ready();
  for (const id of ids) await historyStore.createSession({ workspaceId: ws, id, isWorkflow: false });
  // Exercise actual LRU eviction, not injected queue refusals or UI reads.
  for (let i = 0; i < 8; i++) await historyStore.createSession({ workspaceId: ws, id: `evict-${i}`, isWorkflow: false });
}

function holdWrite(id: string) {
  const entered = deferred(), release = deferred();
  const serialize = serialization.serializeHistory;
  let held = false;
  vi.spyOn(serialization, 'serializeHistory').mockImplementation(async (value, options) => {
    if (!held && options?.relPath === path(id)) {
      held = true;
      entered.resolve();
      await release.promise;
    }
    return serialize(value, options);
  });
  return { entered, release };
}

let root: string | undefined;
function nativeBacking() {
  root = mkdtempSync(join(tmpdir(), 'ugs-composer-cold-capacity-'));
  const reads = deferred();
  const blocked = new Set<string>();
  const seen: string[] = [];
  let active = 0, peak = 0;
  let preparationReads: Map<string, string | null> | undefined;
  // Only collapse repeated index-rebuild reads during owned session creation.
  // Writes still reach disk first; pressure, origin/CAS and final bytes stay live.
  const prepare = async (create: () => Promise<void>) => {
    preparationReads = new Map();
    try { await create(); } finally { preparationReads.clear(); preparationReads = undefined; }
  };
  vi.spyOn(tauri, 'tauriAvailable').mockReturnValue(true);
  (window as NativeWindow).__TAURI_INTERNALS__ = { invoke: async (name, args) => {
    const request = args as { relPath: string; json?: string };
    const file = join(root!, request.relPath);
    if (name === 'history_read_json') {
      if (blocked.has(request.relPath)) {
        seen.push(request.relPath);
        active++;
        peak = Math.max(peak, active);
        try { await reads.promise; } finally { active--; }
      }
      if (preparationReads?.has(request.relPath)) return preparationReads.get(request.relPath) as never;
      const json = existsSync(file) ? readFileSync(file, 'utf8') : null;
      preparationReads?.set(request.relPath, json);
      return json as never;
    }
    if (name === 'history_write_json') {
      preparationReads?.delete(request.relPath);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, request.json!);
      preparationReads?.set(request.relPath, request.json!);
      return undefined as never;
    }
    if (name === 'history_list_dir') return (existsSync(file) ? readdirSync(file) : []) as never;
    if (name === 'history_remove') {
      rmSync(file, { recursive: true, force: true });
      for (const relPath of preparationReads?.keys() ?? []) {
        if (relPath === request.relPath || relPath.startsWith(`${request.relPath}/`)) preparationReads!.delete(relPath);
      }
      return undefined as never;
    }
    throw new Error(`Unexpected native command: ${name}`);
  } };
  return { prepare, reads, blocked, seen, peak: () => peak, bytes: (id: string) => readFileSync(join(root!, path(id)), 'utf8') };
}

afterEach(async () => {
  vi.restoreAllMocks();
  resetComposerDraftPersistForTests();
  await historyStore.flush().catch(() => {});
  __resetHistorySessionCacheForTests();
  delete (window as NativeWindow).__TAURI_INTERNALS__;
  if (root) { rmSync(root, { recursive: true, force: true }); root = undefined; }
});

it.each([false, true])('cold draft survives a full healthy queue and subsequent deletion=%s', async (deleted) => {
  const cold = `cold-${deleted}`, hot = `hot-${deleted}`;
  await createColdSessions([cold]);
  await historyStore.createSession({ workspaceId: ws, id: hot, isWorkflow: false });
  await historyStore.getSessionComposerDraft(ws, cold);
  const held = holdWrite(hot);
  const queued: Promise<unknown>[] = [];
  try {
    queued.push(historyStore.updateSession(ws, hot, { meta: { favorite: true } }));
    await held.entered.promise;
    for (let i = 0; i < 127; i++) queued.push(historyStore.updateSession(ws, hot, { meta: { favorite: i % 2 === 0 } }));
    scheduleComposerDraftPersist(ws, cold, 'exact cold draft');
    held.release.resolve();
    await Promise.all(queued);
    await historyStore.flush().catch(() => {});
    if (deleted) await historyStore.deleteSession(ws, cold, false);
    await expect(flushComposerDraftPersist()).resolves.toBeUndefined();
    await expect(flushComposerDraftPersist()).resolves.toBeUndefined();
    await expect(historyStore.flush()).resolves.toBeUndefined();
    if (deleted) expect(localStorage.getItem(key(cold))).toBeNull();
    else expect(JSON.parse(localStorage.getItem(key(cold))!).meta.composerDraft).toBe('exact cold draft');
  } finally {
    held.release.resolve();
    await Promise.allSettled(queued);
  }
});

it('deduplicates concurrent cold identity captures before reserving bounded read slots', async () => {
  const backing = nativeBacking();
  const id = 'duplicate-cold';
  await createColdSessions([id]);
  backing.blocked.add(path(id));
  const captures = Array.from({ length: 130 }, () => historyStore.getSessionForGeneration(ws, id, { captureKnownOrigin: true }));
  const settled = Promise.allSettled(captures);
  let same: boolean, reads: number;
  try {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    same = captures.every((capture) => capture === captures[0]);
    reads = backing.seen.length;
  } finally {
    backing.reads.resolve();
    await settled;
  }
  expect(same).toBe(true);
  expect(reads).toBe(1);
  expect((await settled).every((result) => result.status === 'fulfilled')).toBe(true);
});

it('bounds 128 distinct cold captures and four backing reads even with all write slots occupied', async () => {
  const backing = nativeBacking();
  const ids = Array.from({ length: 128 }, (_, i) => `bounded-${i}`);
  const hot = 'bounded-hot';
  await backing.prepare(() => createColdSessions(ids));
  await historyStore.createSession({ workspaceId: ws, id: hot, isWorkflow: false });
  for (const id of ids) backing.blocked.add(path(id));
  const held = holdWrite(hot);
  const queued: Promise<unknown>[] = [], captures: Promise<unknown>[] = [];
  let outcomes: PromiseSettledResult<unknown>[] = [], started = 0, overflow = '', writeOverflow = '';
  try {
    queued.push(historyStore.updateSession(ws, hot, { meta: { favorite: true } }));
    await held.entered.promise;
    for (let i = 0; i < 127; i++) queued.push(historyStore.updateSession(ws, hot, { meta: { favorite: false } }));
    for (const id of ids) {
      captures.push(historyStore.getSessionForGeneration(ws, id, { captureKnownOrigin: true }));
      scheduleComposerDraftPersist(ws, id, `exact ${id}`);
    }
    const settled = Promise.allSettled(captures);
    overflow = await historyStore.getSessionForGeneration(ws, 'overflow-not-read', { captureKnownOrigin: true }).then(() => 'accepted', (error: Error) => error.message);
    writeOverflow = await historyStore.updateSession(ws, hot, { meta: { favorite: false } }).then(() => 'accepted', (error: Error) => error.message);
    held.release.resolve();
    await Promise.all(queued);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    started = backing.seen.length;
    backing.reads.resolve();
    outcomes = await settled;
  } finally {
    held.release.resolve();
    backing.reads.resolve();
    await Promise.allSettled([...queued, ...captures]);
  }
  expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(128);
  expect(started).toBe(4);
  expect(backing.peak()).toBe(4);
  expect(backing.seen).toHaveLength(128);
  expect(overflow).toBe('HISTORY_ORIGIN_CAPTURE_FULL');
  expect(writeOverflow).toBe('HISTORY_QUEUE_FULL');
  // Ordering-only capture fences must not consume the real queue failure.
  await expect(historyStore.flush()).rejects.toThrow('HISTORY_QUEUE_FULL');
  await flushComposerDraftPersist();
  await historyStore.flush();
  for (const id of ids) expect(JSON.parse(backing.bytes(id)).meta.composerDraft).toBe(`exact ${id}`);
  await expect(historyStore.getSessionForGeneration(ws, 'overflow-not-read', { captureKnownOrigin: true })).resolves.toBeNull();
});

it('a full-queue cold origin precedes queued same-clock deletion and replacement', async () => {
  const backing = nativeBacking();
  vi.spyOn(Date, 'now').mockReturnValue(2468);
  const cold = 'cold-same-clock', hot = 'same-clock-hot';
  await createColdSessions([cold]);
  const original = JSON.parse(backing.bytes(cold));
  await historyStore.createSession({ workspaceId: ws, id: hot, isWorkflow: false });
  backing.blocked.add(path(cold));
  const held = holdWrite(hot);
  const work: Promise<unknown>[] = [];
  let before = '', replacement: { createdAt: number; generation?: string } | undefined, deletionSettled = false;
  try {
    work.push(historyStore.updateSession(ws, hot, { meta: { favorite: true } }));
    await held.entered.promise;
    for (let i = 0; i < 127; i++) work.push(historyStore.updateSession(ws, hot, { meta: { favorite: false } }));
    scheduleComposerDraftPersist(ws, cold, 'must stay with the old cold incarnation');
    held.release.resolve();
    await Promise.all(work);
    const deletion = historyStore.deleteSession(ws, cold, false);
    void deletion.then(() => { deletionSettled = true; });
    const creation = historyStore.createSession({ workspaceId: ws, id: cold, isWorkflow: false, meta: { composerDraft: 'replacement own draft' } });
    work.push(deletion, creation);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    const premature = deletionSettled;
    backing.reads.resolve();
    await deletion;
    replacement = await creation;
    before = backing.bytes(cold);
    await flushComposerDraftPersist();
    expect(premature).toBe(false);
    expect(backing.bytes(cold)).toBe(before);
  } finally {
    held.release.resolve();
    backing.reads.resolve();
    await Promise.allSettled(work);
  }
  expect(replacement?.createdAt).toBe(original.createdAt);
  expect(replacement?.generation).not.toBe(original.generation);
  await expect(flushComposerDraftPersist()).resolves.toBeUndefined();
  expect(backing.bytes(cold)).toBe(before);
});

it.each(['getItem', 'access', 'invalid'] as const)('real initial cold backing %s failure never rebinds after recovery or same-clock replacement', async (kind) => {
  vi.spyOn(Date, 'now').mockReturnValue(2468);
  const cold = `cold-origin-failure-${kind}`;
  await createColdSessions([cold]);
  const originalBytes = localStorage.getItem(key(cold))!;
  const capture = vi.spyOn(historyStore, 'getSessionForGeneration');
  let restore = () => {};
  try {
    // No identity is cached and no forgiving UI read participates in capture.
    // Install a real backing fault before the first asynchronous capture read.
    if (kind === 'getItem') {
      const get = Storage.prototype.getItem;
      const reader = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, name) {
        if (name === key(cold)) throw new Error('real cold getItem failure');
        return get.call(this, name);
      });
      restore = () => reader.mockRestore();
    } else if (kind === 'access') {
      const reader = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new Error('real cold access failure'); });
      restore = () => reader.mockRestore();
    } else {
      localStorage.setItem(key(cold), '{broken');
      restore = () => localStorage.setItem(key(cold), originalBytes);
    }
    scheduleComposerDraftPersist(ws, cold, 'unknown original draft');
    const failure = await flushComposerDraftPersist().then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    restore();
    restore = () => {};
    const beforeRecovery = localStorage.getItem(key(cold));
    await expect(flushComposerDraftPersist()).rejects.toBe(failure);
    expect(localStorage.getItem(key(cold))).toBe(beforeRecovery);
    await historyStore.deleteSession(ws, cold, false);
    await historyStore.createSession({ workspaceId: ws, id: cold, isWorkflow: false, meta: { composerDraft: 'replacement safe draft' } });
    const before = localStorage.getItem(key(cold));
    scheduleComposerDraftPersist(ws, cold, 'newer text cannot acquire a new origin');
    await expect(flushComposerDraftPersist()).rejects.toBe(failure);
    await expect(flushComposerDraftPersist()).rejects.toBe(failure);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(key(cold))).toBe(before);
  } finally {
    restore();
  }
});
