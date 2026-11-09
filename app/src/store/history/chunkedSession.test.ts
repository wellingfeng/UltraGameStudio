import { webcrypto } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { hydrateSessionPayload, splitSessionPayload } from './chunkedSession';

afterEach(() => vi.unstubAllGlobals());

it('round-trips exact text across Unicode chunk boundaries and rejects corrupt chunks', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const files = new Map<string, unknown>();
  const read = async (path: string) => files.get(path) ?? null;
  const write = async (path: string, value: unknown) => { files.set(path, value); };
  const text = `${'a'.repeat(131_071)}🌍${'中文'.repeat(140_000)}\ud800`;
  const record = { id: 'session', messages: [{ id: 'old', text }, { id: 'source', text: 'user' }] };
  const saved = await splitSessionPayload(record, 'session.json', read, write);
  const recovered = await hydrateSessionPayload(saved, 'session.json', read) as typeof record;
  expect(recovered.messages[0].text).toBe(text.slice(0, -1) + '\uFFFD');
  expect(recovered.messages[1].text).toBe('user');
  const first = files.keys().next().value!;
  files.set(first, { text: 'tampered' });
  const sourceOnly = await hydrateSessionPayload(saved, 'session.json', read, 'source') as typeof record;
  expect(sourceOnly.messages[1].text).toBe('user');
  await expect(hydrateSessionPayload(saved, 'session.json', read)).rejects.toThrow('HISTORY_CHUNK_CORRUPT');
});

it('does not create a new trailing chunk for every streaming checkpoint', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const files = new Map<string, unknown>();
  const read = async (path: string) => files.get(path) ?? null;
  const write = async (path: string, value: unknown) => { files.set(path, value); };
  const make = (text: string) => ({ __ugsJournal: 1, fields: {}, deleted: [], messages: { upserts: [{ id: 'm', text }] } });
  const first = await splitSessionPayload(make('a'.repeat(131_072) + 'x'), 'session.json', read, write, true);
  const count = files.size;
  await splitSessionPayload(make('a'.repeat(131_072) + 'xy'), 'session.json', read, write, true);
  expect(files.size).toBe(count);
  const saved = first as any;
  const record = { __ugsHistoryChunkVersion: 1, messages: saved.messages.upserts };
  const hydrated = await hydrateSessionPayload(record, 'session.json', read) as any;
  expect(hydrated.messages[0].text).toBe('a'.repeat(131_072) + 'x');
});

it('preserves special object keys through chunking', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const files = new Map<string, unknown>();
  const read = async (path: string) => files.get(path) ?? null;
  const write = async (path: string, value: unknown) => { files.set(path, value); };
  const value = JSON.parse(`{"id":"s","messages":[],"metadata":{"__proto__":{"text":"${'x'.repeat(300)}"},"__ugsHistoryChunkVersion":"original"}}`);
  const saved = await splitSessionPayload(value, 'session.json', read, write);
  const restored = await hydrateSessionPayload(saved, 'session.json', read);
  expect(JSON.stringify(restored)).toBe(JSON.stringify(value));
  expect(({} as { text?: string }).text).toBeUndefined();
});

it('hydrates independent chunks concurrently with a bounded number of reads', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const files = new Map<string, unknown>();
  const read = async (path: string) => files.get(path) ?? null;
  const saved = await splitSessionPayload({ messages: Array.from({ length: 20 }, (_, index) => ({ text: `${index}:` + 'x'.repeat(300) })) },
    'session.json', read, async (path, value) => { files.set(path, value); });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let active = 0, peak = 0;
  const pending = hydrateSessionPayload(saved, 'session.json', async (path) => {
    active++; peak = Math.max(peak, active);
    try { await gate; return read(path); } finally { active--; }
  });
  try {
    await vi.waitFor(() => expect(peak).toBeGreaterThan(1), { timeout: 300, interval: 10 });
    expect(peak).toBeLessThanOrEqual(8);
  } finally {
    release();
    await pending;
  }
});

it('reads repeated chunk references only once per hydration', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const files = new Map<string, unknown>();
  const read = async (path: string) => files.get(path) ?? null;
  const text = '重复内容'.repeat(100);
  const saved = await splitSessionPayload({ messages: [{ text }, { text }] }, 'session.json', read,
    async (path, value) => { files.set(path, value); });
  const counted = vi.fn(read);
  expect(await hydrateSessionPayload(saved, 'session.json', counted)).toEqual({ messages: [{ text }, { text }] });
  expect(counted).toHaveBeenCalledTimes(1);
});

it('uses bounded batch reads while preserving order and corruption checks', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const files = new Map<string, unknown>();
  const read = vi.fn(async (path: string) => files.get(path) ?? null);
  const messages = Array.from({ length: 40 }, (_, index) => ({ text: `${index}:` + 'x'.repeat(300) }));
  const saved = await splitSessionPayload({ messages }, 'session.json', read,
    async (path, value) => { files.set(path, value); });
  read.mockClear();
  const readBatch = vi.fn(async (paths: string[]) => paths.map((path) => files.get(path) ?? null));
  expect(await hydrateSessionPayload(saved, 'session.json', read, undefined, readBatch)).toEqual({ messages });
  expect(read).not.toHaveBeenCalled();
  expect(readBatch).toHaveBeenCalledTimes(3);
  expect(readBatch.mock.calls.every(([paths]) => paths.length <= 16)).toBe(true);
  const first = files.keys().next().value!;
  files.set(first, { text: 'tampered' });
  await expect(hydrateSessionPayload(saved, 'session.json', read, undefined, readBatch)).rejects.toThrow('HISTORY_CHUNK_CORRUPT');
});

it('waits for in-flight reads to settle before reporting a corrupt chunk', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const files = new Map<string, unknown>();
  const read = async (path: string) => files.get(path) ?? null;
  const saved = await splitSessionPayload({ messages: [{ text: 'a'.repeat(300) }, { text: 'b'.repeat(300) }] },
    'session.json', read, async (path, value) => { files.set(path, value); });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0, settled = false;
  const result = hydrateSessionPayload(saved, 'session.json', async (path) => {
    if (++calls === 1) return null;
    await gate;
    return read(path);
  }).then(() => 'success', (error: Error) => error.message).then((value) => { settled = true; return value; });
  try {
    await vi.waitFor(() => expect(calls).toBe(2), { timeout: 300, interval: 10 });
    await Promise.resolve();
    expect(settled).toBe(false);
  } finally { release(); }
  expect(await result).toBe('HISTORY_CHUNK_CORRUPT');
});
