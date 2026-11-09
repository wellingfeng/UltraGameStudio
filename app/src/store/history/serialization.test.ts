import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { handleSerialization, stringifyHistory } from './serializeValue';
import { HistoryByteBudget, estimateHistoryBytes, historySerializationPeakBytes, historyJsonEnvelopeBytes, prepareHistoryTransport } from './payloadBudget';
beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('actual fallback rejects inherited array getter before executable work, not just after output reservation', async () => {
  vi.stubGlobal('Worker', undefined);
  const { serializeHistory } = await import('./serialization');
  let calls = 0;
  let result!: Promise<string>;
  const previous = Object.getOwnPropertyDescriptor(Array.prototype, '17');
  Object.defineProperty(Array.prototype, '17', {
    configurable: true, enumerable: false,
    get() { calls++; return 'x'.repeat(10000); },
  });
  try { result = serializeHistory(Array(18), { budget: new HistoryByteBudget(5000) }).catch((error: Error) => error.message); }
  finally {
    if (previous) Object.defineProperty(Array.prototype, '17', previous);
    else Reflect.deleteProperty(Array.prototype, '17');
  }
  const outcome = await result;
  expect({ outcome, calls }).toEqual({ outcome: 'HISTORY_PAYLOAD_UNSUPPORTED', calls: 0 });
});

it.each(['fallback', 'worker'] as const)(
  'rejects extended builtin chain on the real %s admission path before transport or IO', async (mode) => {
    let constructed = 0, posted = 0, writes = 0;
    class ResponsiveWorker {
      onmessage: ((event: { data: unknown }) => void) | null = null;
      constructor() { constructed++; }
      postMessage(request: any) { posted++; this.onmessage?.({ data: handleSerialization(request) }); }
      terminate() {}
    }
    vi.stubGlobal('Worker', mode === 'fallback' ? undefined : ResponsiveWorker);
    const { serializeHistory } = await import('./serialization');
    const budget = new HistoryByteBudget(8 * 1024 * 1024);
    const original = Object.getPrototypeOf(Array.prototype);
    let chain = original;
    for (let i = 0; i < 2048; i++) chain = Object.create(chain);
    for (const value of [[], Array(19000).fill(null), Array(19000)]) {
      let result!: Promise<string>, synchronousMs = 0;
      try {
        Object.setPrototypeOf(Array.prototype, chain);
        const start = performance.now();
        result = serializeHistory(value, { budget, onSerialized: async () => { writes++; } });
        synchronousMs = performance.now() - start;
      } finally { Object.setPrototypeOf(Array.prototype, original); }
      await expect(result).rejects.toThrow('HISTORY_PAYLOAD_UNSUPPORTED');
      expect(synchronousMs).toBeLessThan(100);
      expect({ constructed, posted, writes }).toEqual({ constructed: 0, posted: 0, writes: 0 });
      // Admission failure cannot consume either input or output reservations.
      budget.reserve(budget.limit)();
    }
    expect(await serializeHistory('recovered', { budget })).toBe('"recovered"');
    budget.reserve(budget.limit)();
  },
);

it('rejects payload-byte overflow before the real postMessage boundary', async () => {
  const sent: any[] = []; let worker!: TestWorker;
  class TestWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    constructor() { worker = this; }
    postMessage(request: any) { sent.push(request); }
    terminate() {}
  }
  vi.stubGlobal('Worker', TestWorker);
  const { serializeHistory } = await import('./serialization');
  // Peak and result overlap must both fit for the first admitted write.
  const budget = new HistoryByteBudget(historySerializationPeakBytes(estimateHistoryBytes('x'.repeat(100))) + historyJsonEnvelopeBytes(JSON.stringify('x'.repeat(100))));
  const first = serializeHistory('x'.repeat(100), { budget });
  const overflow = serializeHistory('y'.repeat(100), { budget }).then(() => 'accepted', (e: Error) => e.message);
  // On broken admission there are two posts. Complete both, then assert outside
  // callbacks so a best-effort catch cannot hide the rejected assertion.
  const count = sent.length;
  for (const request of sent) worker.onmessage?.({ data: handleSerialization(request) });
  await first;
  expect(await overflow).toBe('HISTORY_SERIALIZATION_BYTES_FULL');
  expect(count).toBe(1);
});

it('retains serialized envelope bytes while the actual write remains blocked', async () => {
  vi.stubGlobal('Worker', undefined);
  const { serializeHistory } = await import('./serialization');
  const budget = new HistoryByteBudget(historySerializationPeakBytes(estimateHistoryBytes('x'.repeat(40))) + historyJsonEnvelopeBytes(JSON.stringify('x'.repeat(40))));
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const entered = new Promise<void>((r) => { started = r; });
  const first = serializeHistory('x'.repeat(40), { budget, onSerialized: async () => { started(); await gate; } });
  // Flush microtasks: a broken implementation never calls the callback.
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  let enteredCallback = false; void entered.then(() => { enteredCallback = true; });
  await Promise.resolve();
  const overflow = await serializeHistory('y'.repeat(40), { budget }).then(() => 'accepted', (e: Error) => e.message);
  release(); await first;
  expect(enteredCallback).toBe(true);
  expect(overflow).toBe('HISTORY_SERIALIZATION_BYTES_FULL');
  await serializeHistory('again', { budget });
});

it('worker serialization rejects getters before invoking application code', () => {
  let reads = 0;
  const value = { get text() { reads += 1; return 'unbounded'; } };
  expect(handleSerialization({ id: 1, value }).error).toBe('HISTORY_PAYLOAD_UNSUPPORTED');
  expect(reads).toBe(0);
});

it('versioned receiver refuses an accessor request id without executing it even on error', () => {
  let calls = 0;
  const request = { get id() { calls++; return 7; }, value: null, canonicalVersion: 1 };
  const result = handleSerialization(request);
  expect(result.error).toBe('HISTORY_SERIALIZATION_INVALID');
  expect(calls).toBe(0);
});

it('worker serialization rejects excessive structural work before stringify', () => {
  expect(handleSerialization({ id: 2, value: Array(20_001).fill(0) }).error).toBe('HISTORY_PAYLOAD_COMPLEXITY');
});

it('keeps clone permits reserved inside terminate and only then admits recovery', async () => {
  vi.useFakeTimers();
  const budget = new HistoryByteBudget(historySerializationPeakBytes(estimateHistoryBytes('x'.repeat(100)))); let reservedAtTermination = false;
  class WorkerFixture {
    postMessage() {}
    terminate() {
      try { budget.reserve(1000)(); } catch { reservedAtTermination = true; }
    }
  }
  vi.stubGlobal('Worker', WorkerFixture);
  const { serializeHistory } = await import('./serialization');
  const held = serializeHistory('x'.repeat(100), { budget }).catch((e: Error) => e.message);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await held).toBe('HISTORY_SERIALIZATION_TIMEOUT');
  expect(reservedAtTermination).toBe(true);
  vi.stubGlobal('Worker', undefined);
  await serializeHistory('recovered', { budget });
});

it('rejects unsupported getter payloads without reaching postMessage', async () => {
  let posted = 0, invoked = 0;
  class WorkerFixture { postMessage() { posted++; } terminate() {} }
  vi.stubGlobal('Worker', WorkerFixture);
  const { serializeHistory } = await import('./serialization');
  await expect(serializeHistory({ get text() { invoked++; return 'unsafe'; } })).rejects.toThrow('HISTORY_PAYLOAD_UNSUPPORTED');
  expect(posted).toBe(0); expect(invoked).toBe(0);
});

it('cleans real lone surrogates without changing literal escaped text', () => {
  const value = { text: String.raw`\ud83d`, actual: '\ud83d', pair: '🚀', key: { [String.raw`\udc00`]: 'preserved' } };
  expect(JSON.parse(stringifyHistory(value))).toEqual({ ...value, actual: '�' });
});

it('sends serialization to a single worker instead of stringifying on the caller', async () => {
  const sent: unknown[] = []; let workers = 0;
  class TestWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    constructor() { workers += 1; }
    postMessage(request: any) {
      sent.push(request.value);
      queueMicrotask(() => this.onmessage?.({ data: { id: request.id, json: '"worker-result"' } }));
    }
    terminate() {}
  }
  vi.stubGlobal('Worker', TestWorker);
  const { serializeHistory } = await import('./serialization');
  const value = { text: 'payload' };
  expect(await serializeHistory(value)).toBe('"worker-result"');
  expect(await serializeHistory(value)).toBe('"worker-result"');
  expect(sent).toEqual([value, value]); expect(workers).toBe(1);
});

it('terminates an idle worker and recreates it on demand', async () => {
  vi.useFakeTimers(); let terminated = 0, created = 0;
  class TestWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    constructor() { created += 1; }
    postMessage(request: any) { this.onmessage?.({ data: handleSerialization(request) }); }
    terminate() { terminated += 1; }
  }
  vi.stubGlobal('Worker', TestWorker);
  const { serializeHistory } = await import('./serialization');
  expect(JSON.parse(await serializeHistory({ text: '\ud83d 🚀' }))).toEqual({ text: '� 🚀' });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(terminated).toBe(1);
  await serializeHistory('again'); expect(created).toBe(2);
  await vi.advanceTimersByTimeAsync(5_000);
});

it('bounds pending serialization requests before structured clone', async () => {
  let worker!: TestWorker;
  const requests: any[] = [];
  class TestWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    constructor() { worker = this; }
    postMessage(request: any) { requests.push(request); }
    terminate() {}
  }
  vi.stubGlobal('Worker', TestWorker);
  const { serializeHistory } = await import('./serialization');
  const pending = Array.from({ length: 64 }, () => serializeHistory('held'));
  const overflow = serializeHistory('overflow').then(() => 'accepted', (e: Error) => e.message);
  for (const request of requests) worker.onmessage?.({ data: handleSerialization(request) });
  await Promise.all(pending);
  expect(await overflow).toBe('HISTORY_SERIALIZATION_FULL');
  expect(requests).toHaveLength(64);
});

it('terminates an idle worker after a structured-clone failure', async () => {
  vi.useFakeTimers(); let terminated = 0;
  class CloneFailureWorker {
    postMessage() { throw new Error('DataCloneError'); }
    terminate() { terminated += 1; }
  }
  vi.stubGlobal('Worker', CloneFailureWorker);
  const { serializeHistory } = await import('./serialization');
  await expect(serializeHistory({ text: 'valid payload with injected clone failure' })).rejects.toThrow('DataCloneError');
  await vi.advanceTimersByTimeAsync(5_000);
  expect(terminated).toBe(1);
});

it('recovers after timeout and ignores late errors from the terminated worker', async () => {
  vi.useFakeTimers();
  const workers: TestWorker[] = [];
  class TestWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    request: any;
    constructor() { workers.push(this); }
    postMessage(request: any) { this.request = request; }
    terminate() {}
  }
  vi.stubGlobal('Worker', TestWorker);
  const { serializeHistory } = await import('./serialization');
  const first = serializeHistory('hung').catch((error: Error) => error.message);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await first).toBe('HISTORY_SERIALIZATION_TIMEOUT');
  const next = serializeHistory('recovered').catch((error: Error) => error.message);
  workers[0].onerror?.();
  workers[1].onmessage?.({ data: handleSerialization(workers[1].request) });
  expect(await next).toBe('"recovered"');
  await vi.advanceTimersByTimeAsync(5_000);
});

it('rejects all requests when a worker stops responding, then can recover', async () => {
  vi.useFakeTimers(); let terminated = 0;
  class HungWorker { postMessage() {} terminate() { terminated += 1; } }
  vi.stubGlobal('Worker', HungWorker);
  const { serializeHistory } = await import('./serialization');
  const first = serializeHistory('one').then(() => 'accepted', (e: Error) => e.message);
  const second = serializeHistory('two').then(() => 'accepted', (e: Error) => e.message);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await Promise.race([first, Promise.resolve('still pending')])).toBe('HISTORY_SERIALIZATION_TIMEOUT');
  expect(await second).toBe('HISTORY_SERIALIZATION_TIMEOUT'); expect(terminated).toBe(1);
});

// Characterization of the new common projection/peak contract, not extra RED cycles.
it('rejects one unit below exact peak before projection allocation or worker construction', async () => {
  let created = 0, allocated = 0;
  class WorkerFixture { constructor() { created++; } postMessage() {} terminate() {} }
  vi.stubGlobal('Worker', WorkerFixture);
  const { serializeHistory } = await import('./serialization');
  const value = { text: 'peak' };
  const peak = historySerializationPeakBytes(estimateHistoryBytes(value));
  const budget = new HistoryByteBudget(peak - 1);
  const create = Object.create;
  const spy = vi.spyOn(Object, 'create').mockImplementation((...args: Parameters<typeof Object.create>) => { allocated++; return create(...args); });
  let pending: Promise<string>;
  try { pending = serializeHistory(value, { budget }); } finally { spy.mockRestore(); }
  await expect(pending!).rejects.toThrow('HISTORY_SERIALIZATION_BYTES_FULL');
  expect({ created, allocated }).toEqual({ created: 0, allocated: 0 });
  budget.reserve(budget.limit)();
});

it.each(['fallback', 'constructor-failure', 'worker'] as const)('holds output until blocked failed IO settles and fully reuses peak budget on %s', async (mode) => {
  class WorkerFixture {
    onmessage: ((event: MessageEvent) => void) | null = null;
    constructor() { if (mode === 'constructor-failure') throw new Error('unavailable'); }
    postMessage(request: any) { queueMicrotask(() => this.onmessage?.(new MessageEvent('message', { data: handleSerialization(request) }))); }
    terminate() {}
  }
  vi.stubGlobal('Worker', mode === 'fallback' ? undefined : WorkerFixture);
  const { serializeHistory } = await import('./serialization');
  const value = 'x'.repeat(40), expected = JSON.stringify(value);
  const peak = historySerializationPeakBytes(estimateHistoryBytes(value)), output = historyJsonEnvelopeBytes(expected);
  const budget = new HistoryByteBudget(peak + output);
  let release!: () => void, enter!: () => void, written: string | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { enter = resolve; });
  const pending = serializeHistory(value, { budget, onSerialized: async json => { written = json; enter(); await gate; throw new Error('IO_FAILED'); } }).catch((e: Error) => e.message);
  await started;
  expect(written).toBe(expected);
  expect(() => budget.reserve(peak + 1)).toThrow('HISTORY_SERIALIZATION_BYTES_FULL');
  release(); expect(await pending).toBe('IO_FAILED');
  budget.reserve(budget.limit)();
  expect(await serializeHistory(value, { budget })).toBe(expected);
  budget.reserve(budget.limit)();
});

it('constructor fallback uses the already private projection instead of rereading original source', async () => {
  const value = { text: 'before' };
  class WorkerFixture { constructor() { value.text = 'after'; throw new Error('unavailable'); } }
  vi.stubGlobal('Worker', WorkerFixture);
  const { serializeHistory } = await import('./serialization');
  expect(await serializeHistory(value)).toBe('{\n  "text": "before"\n}');
});

it('generic projection preserves nonenum indices, nullproto records, key order and __proto__ without alias undercounting', () => {
  const shared = Object.assign(Object.create(null), { text: 'shared' });
  const array = Array(5); Object.defineProperty(array, '3', { value: shared, enumerable: false });
  const value = Object.create(null);
  for (const [key, child] of [['z', array], ['__proto__', shared], ['2', undefined], ['1', [undefined, NaN, Infinity, -0]]] as const) Object.defineProperty(value, key, { value: child, enumerable: true });
  const before = Object.getOwnPropertyDescriptors(array);
  const projection = prepareHistoryTransport(value) as any;
  expect(handleSerialization({ id: 1, value: structuredClone(projection), canonicalVersion: 1 }).json).toBe(JSON.stringify(value, null, 2));
  expect(Object.getPrototypeOf(projection)).toBe(null);
  expect(projection.z[3]).not.toBe(projection.__proto__);
  expect(Object.getOwnPropertyDescriptors(array)).toEqual(before);
  expect(estimateHistoryBytes([shared, shared])).toBeGreaterThan(estimateHistoryBytes([shared]));
});

it('unknown versions and malformed canonical slots fail closed without executing getters', () => {
  let calls = 0;
  expect(handleSerialization({ id: 1, value: null, canonicalVersion: 2 }).error).toBe('HISTORY_SERIALIZATION_INVALID');
  const array = Array(1); Object.defineProperty(array, '0', { enumerable: true, get() { calls++; return 'unsafe'; } });
  expect(handleSerialization({ id: 1, value: array, canonicalVersion: 1 }).error).toBe('HISTORY_PAYLOAD_UNSUPPORTED');
  expect(handleSerialization({ id: 1, value: Array(1), canonicalVersion: 1 }).error).toBe('HISTORY_PAYLOAD_UNSUPPORTED');
  expect(calls).toBe(0);
});

it('versioned receiver rejects cloned non-record builtins instead of silently projecting empty objects', () => {
  expect(handleSerialization({ id: 1, value: new Date(0), canonicalVersion: 1 }).error).toBe('HISTORY_PAYLOAD_UNSUPPORTED');
});
