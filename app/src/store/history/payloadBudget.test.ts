import { expect, it } from 'vitest';
import { estimateHistoryBytes, HistoryByteBudget, historyJsonEnvelopeBytes } from './payloadBudget';
import { stringifyHistory } from './serializeValue';

// Restore global prototypes before asserting: Vitest also uses arrays/JSON.
function withPrototypeProperty(owner: object, key: string, descriptor: PropertyDescriptor, run: () => void): void {
  const previous = Object.getOwnPropertyDescriptor(owner, key);
  Object.defineProperty(owner, key, { configurable: true, enumerable: false, ...descriptor });
  try { run(); }
  finally {
    if (previous) Object.defineProperty(owner, key, previous);
    else Reflect.deleteProperty(owner, key);
  }
}

it.each([['Array.prototype', Array.prototype], ['Object.prototype', Object.prototype]] as const)(
  'rejects missing own array index inherited getter on %s before serialization', (_name, owner) => {
    let calls = 0;
    let admissionError: unknown, serializationError: unknown;
    withPrototypeProperty(owner, '17', { get() { calls++; return 'unmetered'; } }, () => {
      const value = Array(18);
      try { estimateHistoryBytes(value); } catch (error) { admissionError = error; }
      try { stringifyHistory(value); } catch (error) { serializationError = error; }
    });
    expect(String(admissionError)).toContain('HISTORY_PAYLOAD_UNSUPPORTED');
    expect(String(serializationError)).toContain('HISTORY_PAYLOAD_UNSUPPORTED');
    expect(calls).toBe(0);
  },
);

it.each([['Array.prototype', Array.prototype], ['Object.prototype', Object.prototype]] as const)(
  'rejects missing own array index inherited nonenumerable data on %s instead of undercounting', (_name, owner) => {
    let admissionError: unknown, serializationError: unknown;
    withPrototypeProperty(owner, '17', { value: 'x'.repeat(10000), writable: true }, () => {
      const value = Array(18);
      try { estimateHistoryBytes(value, 5000); } catch (error) { admissionError = error; }
      try { stringifyHistory(value); } catch (error) { serializationError = error; }
    });
    expect(String(admissionError)).toContain('HISTORY_PAYLOAD_UNSUPPORTED');
    expect(String(serializationError)).toContain('HISTORY_PAYLOAD_UNSUPPORTED');
  },
);

it.each(['getter', 'function'] as const)(
  'rejects array Object.prototype toJSON %s before executable hook runs', (kind) => {
    let calls = 0;
    let admissionError: unknown, serializationError: unknown;
    const hook = () => { calls++; return 'unmetered'; };
    const descriptor = kind === 'getter'
      ? { get() { calls++; return hook; } }
      : { value: hook, writable: true };
    withPrototypeProperty(Object.prototype, 'toJSON', descriptor, () => {
      const value: unknown[] = [];
      try { estimateHistoryBytes(value); } catch (error) { admissionError = error; }
      try { stringifyHistory(value); } catch (error) { serializationError = error; }
    });
    expect(String(admissionError)).toContain('HISTORY_PAYLOAD_UNSUPPORTED');
    expect(String(serializationError)).toContain('HISTORY_PAYLOAD_UNSUPPORTED');
    expect(calls).toBe(0);
  },
);

it.each(['empty', 'dense', 'holey'] as const)(
  'rejects noncanonical builtin chain for %s arrays before unbounded reflection', (kind) => {
    const value = kind === 'empty' ? [] : kind === 'dense' ? Array(18).fill(null) : Array(18);
    const getPrototype = Object.getPrototypeOf;
    const getDescriptor = Object.getOwnPropertyDescriptor;
    const original = getPrototype(Array.prototype);
    let chain = original;
    for (let i = 0; i < 2048; i++) chain = Object.create(chain);
    let prototypeReads = 0, descriptorReads = 0, error: unknown;
    try {
      Object.setPrototypeOf(Array.prototype, chain);
      Object.getPrototypeOf = (item) => { prototypeReads++; return getPrototype(item); };
      Object.getOwnPropertyDescriptor = (item, key) => { descriptorReads++; return getDescriptor(item, key); };
      try { estimateHistoryBytes(value); } catch (caught) { error = caught; }
    } finally {
      Object.getPrototypeOf = getPrototype;
      Object.getOwnPropertyDescriptor = getDescriptor;
      Object.setPrototypeOf(Array.prototype, original);
    }
    expect(String(error)).toContain('HISTORY_PAYLOAD_UNSUPPORTED');
    expect(prototypeReads).toBeLessThanOrEqual(3);
    expect(descriptorReads).toBe(0);
  },
);

it.each(['empty', 'dense', 'holey'] as const)(
  'still checks the complete canonical toJSON chain for %s arrays without getters', (kind) => {
    const value = kind === 'empty' ? [] : kind === 'dense' ? [null, 'own'] : Array(18);
    let calls = 0, error: unknown;
    withPrototypeProperty(Object.prototype, 'toJSON', { get() { calls++; return () => 'unsafe'; } }, () => {
      try { estimateHistoryBytes(value); } catch (caught) { error = caught; }
    });
    expect(String(error)).toContain('HISTORY_PAYLOAD_UNSUPPORTED');
    expect(calls).toBe(0);
  },
);

it('rechecks current builtin ancestry between admissions without caching acceptance', () => {
  const value = Array(18);
  const expected = estimateHistoryBytes(value);
  const original = Object.getPrototypeOf(Array.prototype);
  let error: unknown, recordBytes = 0;
  try {
    Object.setPrototypeOf(Array.prototype, Object.create(original));
    try { estimateHistoryBytes(value); } catch (caught) { error = caught; }
    // Null-prototype payloads have no inherited lookup path to inspect.
    const record = Object.assign(Object.create(null), { text: 'safe' });
    recordBytes = estimateHistoryBytes(record);
  } finally { Object.setPrototypeOf(Array.prototype, original); }
  expect(recordBytes).toBeGreaterThan(0);
  expect(String(error)).toContain('HISTORY_PAYLOAD_UNSUPPORTED');
  expect(estimateHistoryBytes(value)).toBe(expected);
});

// Characterization guards: these supported/shadowed paths were already valid.
it('preserves ordinary dense arrays, true holes and null-prototype JSON records', () => {
  const dense = [null, undefined, true, 7, 'text'];
  const holey = Array(18);
  const record = Object.assign(Object.create(null), { text: 'safe', count: 2 });
  for (const value of [dense, holey, record]) {
    const expected = JSON.stringify(value, null, 2);
    expect(stringifyHistory(value)).toBe(expected);
    expect(estimateHistoryBytes(value)).toBeGreaterThan(expected.length * 2);
  }
});

it.each([
  ['Array.prototype', 'getter', Array.prototype],
  ['Object.prototype', 'getter', Object.prototype],
  ['Array.prototype', 'data', Array.prototype],
  ['Object.prototype', 'data', Object.prototype],
] as const)('preserves own array index shadowing %s inherited %s', (_name, kind, owner) => {
  let calls = 0;
  const value = Array(18);
  Object.defineProperty(value, '17', { configurable: true, enumerable: false, value: 'own', writable: true });
  const expected = JSON.stringify(value, null, 2);
  const expectedBytes = estimateHistoryBytes(value);
  let actual: string | undefined, bytes: number | undefined;
  const descriptor = kind === 'getter'
    ? { get() { calls++; return 'unmetered'; } }
    : { value: 'x'.repeat(10000), writable: true };
  withPrototypeProperty(owner, '17', descriptor, () => {
    bytes = estimateHistoryBytes(value);
    actual = stringifyHistory(value);
  });
  expect(actual).toBe(expected);
  expect(bytes).toBe(expectedBytes);
  expect(calls).toBe(0);
});

it.each(['getter', 'function'] as const)('still rejects direct Array.prototype toJSON %s without execution', (kind) => {
  let calls = 0;
  let admissionError: unknown;
  const hook = () => { calls++; return 'unsafe'; };
  const descriptor = kind === 'getter' ? { get() { calls++; return hook; } } : { value: hook, writable: true };
  withPrototypeProperty(Array.prototype, 'toJSON', descriptor, () => {
    try { estimateHistoryBytes([]); } catch (error) { admissionError = error; }
  });
  expect(String(admissionError)).toContain('HISTORY_PAYLOAD_UNSUPPORTED');
  expect(calls).toBe(0);
});

it('accounts nested JSON shape, keys, indentation and UTF-16 without stringify', () => {
  const value = { messages: [{ text: '\u0000\\"🚀\ud83d', metadata: { nested: [null, undefined, true, 7] } }] };
  const json = JSON.stringify(value, null, 2);
  expect(estimateHistoryBytes(value)).toBeGreaterThan(new TextEncoder().encode(json).byteLength);
  expect(historyJsonEnvelopeBytes(json, 'a.json')).toBeGreaterThan(json.length * 2);
  expect(() => estimateHistoryBytes({ metadata: { nested: 'x'.repeat(50) } }, 500)).toThrow('HISTORY_PAYLOAD_TOO_LARGE');
});

it('charges shared references repeatedly and rejects cycles instead of undercounting expansion', () => {
  const shared = { text: 'x'.repeat(10) };
  expect(estimateHistoryBytes([shared, shared])).toBeGreaterThan(estimateHistoryBytes([shared]));
  const cycle: any = {}; cycle.self = cycle;
  expect(() => estimateHistoryBytes(cycle)).toThrow('HISTORY_PAYLOAD_CYCLE');
  let deep: unknown = null;
  for (let i = 0; i < 66; i += 1) deep = { deep };
  expect(() => estimateHistoryBytes(deep)).toThrow('HISTORY_PAYLOAD_COMPLEXITY');
});

it('does not invoke getters or toJSON and rejects executable and non-record values', () => {
  let called = 0;
  for (const value of [{ get text() { called++; return 'bad'; } }, { toJSON() { called++; return 'bad'; } }, { fn: () => {} }, { n: 1n }, new Date(), new Map()]) {
    expect(() => estimateHistoryBytes(value)).toThrow('HISTORY_PAYLOAD_UNSUPPORTED');
  }
  expect(called).toBe(0);
});

it('rejects array side properties that structured clone would otherwise copy unmetered', () => {
  const value: unknown[] & { extra?: string } = [];
  value.extra = 'x'.repeat(1000);
  expect(() => estimateHistoryBytes(value, 500)).toThrow('HISTORY_PAYLOAD_UNSUPPORTED');
});

it('holds byte reservations until explicit completion and releases idempotently', () => {
  const budget = new HistoryByteBudget(100);
  const release = budget.reserve(80);
  expect(() => budget.reserve(21)).toThrow('HISTORY_SERIALIZATION_BYTES_FULL');
  release(); release();
  budget.reserve(100)();
});

it('rejects JSON/IPC envelopes beyond the default output cap before dispatch', () => {
  expect(() => historyJsonEnvelopeBytes('x'.repeat(3_000_000))).toThrow('HISTORY_JSON_TOO_LARGE');
});
