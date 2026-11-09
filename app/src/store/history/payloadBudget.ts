// Conservative accounting units, not an engine-specific heap measurement.
// 16 bytes / UTF-16 unit covers retained text + worst-case JSON escaping;
// structural overhead includes pretty-print indentation. Strings use length
// only (no stringify/character scan). Traversal stops at 20k occurrences/64
// levels; shared references are counted EACH time to bound JSON expansion.
// Only inert JSON records/arrays are supported: no getters, toJSON, cycles,
// class instances or executable values. Producers must not mutate admitted
// payloads; proxies cannot be safely introspected and are not supported.
export const HISTORY_PAYLOAD_BYTES = 32 * 1024 * 1024;
export const HISTORY_PENDING_BYTES = 64 * 1024 * 1024;
export const HISTORY_PAYLOAD_NODES = 20_000;
export const HISTORY_PAYLOAD_DEPTH = 64;

export function estimateHistoryBytes(value: unknown, limit = HISTORY_PAYLOAD_BYTES): number {
  return walkHistory(value, limit, false).bytes;
}

/** Retained queue references are not cloned until the bounded chunks are sent. */
export function estimateRetainedHistoryBytes(value: unknown, limit = HISTORY_PAYLOAD_BYTES): number {
  return walkHistory(value, limit, false, 2).bytes;
}

/** Same descriptor rules as admission; only allocate after peak reservation. */
export function prepareHistoryTransport(value: unknown): unknown {
  return walkHistory(value, HISTORY_PAYLOAD_BYTES, true).value;
}

/** Source + private projection + transport clone + receiver reconstruction. */
export function historySerializationPeakBytes(logicalBytes: number): number {
  return 128 + 4 * logicalBytes;
}

function walkHistory(value: unknown, limit: number, project: boolean, stringUnitBytes = 16): { bytes: number; value: unknown } {
  let bytes = 0, nodes = 0;
  const ancestors = new Set<object>();
  const add = (cost: number) => {
    bytes += cost;
    if (!Number.isSafeInteger(bytes) || bytes > limit) throw new Error('HISTORY_PAYLOAD_TOO_LARGE');
  };
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > HISTORY_PAYLOAD_NODES || depth > HISTORY_PAYLOAD_DEPTH) throw new Error('HISTORY_PAYLOAD_COMPLEXITY');
    if (typeof item === 'string') { add(16 + item.length * stringUnitBytes); return item; }
    if (item === null || item === undefined || typeof item === 'boolean' || typeof item === 'number') { add(32); return item; }
    if (typeof item !== 'object') throw new Error('HISTORY_PAYLOAD_UNSUPPORTED');
    const proto = Object.getPrototypeOf(item);
    if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) throw new Error('HISTORY_PAYLOAD_UNSUPPORTED');
    // Reject altered builtin ancestry BEFORE toJSON lookup, for-in or hole
    // inspection. Recheck on every visit (no cross-call prototype cache):
    // supported lookup chains then contain at most two inherited owners.
    if ((proto === Array.prototype && Object.getPrototypeOf(proto) !== Object.prototype)
      || (proto !== null && Object.getPrototypeOf(Object.prototype) !== null)) {
      throw new Error('HISTORY_PAYLOAD_UNSUPPORTED');
    }
    for (let owner: object | null = item; owner; owner = Object.getPrototypeOf(owner)) {
      const hook = Object.getOwnPropertyDescriptor(owner, 'toJSON');
      if (hook && (!('value' in hook) || typeof hook.value === 'function')) throw new Error('HISTORY_PAYLOAD_UNSUPPORTED');
    }
    if (ancestors.has(item)) throw new Error('HISTORY_PAYLOAD_CYCLE');
    ancestors.add(item); add(128);
    const output: Record<string, unknown> | unknown[] | undefined = project
      ? (Array.isArray(item) ? Object.setPrototypeOf([], null) : Object.create(null)) : undefined;
    if (Array.isArray(item)) {
      if (item.length > HISTORY_PAYLOAD_NODES - nodes) throw new Error('HISTORY_PAYLOAD_COMPLEXITY');
      for (const key in item) {
        if (key.length > 16 || !Object.prototype.hasOwnProperty.call(item, key) || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length) {
          throw new Error('HISTORY_PAYLOAD_UNSUPPORTED');
        }
      }
      // Holes still serialize as null and incur JSON/output cost.
      for (let i = 0; i < item.length; i += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
        if (!descriptor) {
          // JSON reads missing indices through the entire prototype chain.
          for (let owner = proto; owner; owner = Object.getPrototypeOf(owner)) {
            const inherited = Object.getOwnPropertyDescriptor(owner, String(i));
            // Inherited data is not part of the metered own-value snapshot.
            if (inherited) throw new Error('HISTORY_PAYLOAD_UNSUPPORTED');
          }
        }
        if (descriptor && !('value' in descriptor)) throw new Error('HISTORY_PAYLOAD_UNSUPPORTED');
        add(64 + 8 * depth);
        const child = visit(descriptor?.value, depth + 1);
        if (output) Object.defineProperty(output, String(i), { value: child === undefined ? null : child, enumerable: true, configurable: true, writable: true });
      }
    } else {
      for (const key in item) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor) continue;
        if (!('value' in descriptor)) throw new Error('HISTORY_PAYLOAD_UNSUPPORTED');
        add(64 + key.length * 16 + 8 * depth);
        const child = visit(descriptor.value, depth + 1);
        if (output && child !== undefined) Object.defineProperty(output, key, { value: child, enumerable: true, configurable: true, writable: true });
      }
    }
    ancestors.delete(item);
    return output;
  };
  const projected = visit(value, 0);
  return { bytes, value: projected };
}

/** Shared reservation stays held through the REAL native/local write. */
export class HistoryByteBudget {
  private used = 0;
  constructor(readonly limit = HISTORY_PENDING_BYTES) {}
  reserve(bytes: number, error = 'HISTORY_SERIALIZATION_BYTES_FULL'): () => void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.limit - this.used) throw new Error(error);
    this.used += bytes;
    let released = false;
    return () => { if (!released) { released = true; this.used -= bytes; } };
  }
}

// Output strings are scanned only by length: 12 bytes/unit covers both the
// UTF-16 result and the worst-case escaped IPC JSON envelope, plus its fields.
export function historyJsonEnvelopeBytes(json: string, relPath = ''): number {
  const bytes = 512 + 12 * json.length + 16 * relPath.length;
  if (bytes > HISTORY_PAYLOAD_BYTES) throw new Error('HISTORY_JSON_TOO_LARGE');
  return bytes;
}
