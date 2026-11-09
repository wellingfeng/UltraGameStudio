import { estimateRetainedHistoryBytes } from './payloadBudget';

const CHUNK_UNITS = 128 * 1024;
const CHUNK_READ_CONCURRENCY = 8;
const CHUNK_BATCH_SIZE = 16;
const CHUNK_BATCH_CONCURRENCY = 2;
const EXTERNAL_STRING_UNITS = 256;
const VERSION = '__ugsHistoryChunkVersion';
const TEXT = '__ugsHistoryText';

type ReadChunk = (path: string) => Promise<unknown>;
type ReadChunkBatch = (paths: string[]) => Promise<unknown[]>;
type WriteChunk = (path: string, value: unknown) => Promise<void>;
type ChunkReference = { __ugsHistoryText: 1; chunks: string[]; units: number; tail?: string };

function chunkPath(sessionPath: string, hash: string): string {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('HISTORY_CHUNK_REFERENCE_INVALID');
  return `${sessionPath}.chunks/${hash}.json`;
}

async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function reference(value: unknown): value is ChunkReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (Object.keys(obj).length === 3 || Object.keys(obj).length === 4 && typeof obj.tail === 'string') && obj[TEXT] === 1 && Array.isArray(obj.chunks)
    && obj.chunks.every((hash) => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash))
    && Number.isSafeInteger(obj.units) && (obj.units as number) >= 0;
}

/** Chunk first; the caller atomically publishes the resulting session last. */
export async function splitSessionPayload(value: unknown, sessionPath: string, read: ReadChunk, write: WriteChunk, streamCheckpoint = false): Promise<unknown> {
  // Validate the entire inert graph before any await or disk write, even when
  // the normal serializer stopped early at the original size limit.
  estimateRetainedHistoryBytes(value, Number.MAX_SAFE_INTEGER);
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, VERSION)) throw new Error('HISTORY_CHUNK_RESERVED_VALUE');
  let externalized = false;
  let inlineUnits = 0;
  const visit = async (item: unknown): Promise<unknown> => {
    if (typeof item === 'string' && item.length >= EXTERNAL_STRING_UNITS) {
      const chunks: string[] = [];
      let tail = '';
      for (let start = 0; start < item.length;) {
        let end = Math.min(start + CHUNK_UNITS, item.length);
        if (end < item.length && /[\uD800-\uDBFF]/.test(item[end - 1]) && /[\uDC00-\uDFFF]/.test(item[end])) end--;
        const text = item.slice(start, end).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
        if (streamCheckpoint && end === item.length && text.length < CHUNK_UNITS - 1 && inlineUnits + text.length < CHUNK_UNITS) {
          tail = text;
          inlineUnits += text.length;
          start = end;
          break;
        }
        const hash = await digest(text);
        const path = chunkPath(sessionPath, hash);
        const existing = await read(path);
        if (existing == null) await write(path, { text });
        else if (typeof existing !== 'object' || (existing as { text?: unknown }).text !== text) throw new Error('HISTORY_CHUNK_CONFLICT');
        chunks.push(hash);
        start = end;
      }
      externalized = true;
      return { [TEXT]: 1, chunks, units: item.length, ...(tail ? { tail } : {}) };
    }
    if (item === null || typeof item !== 'object') return item;
    if (!Array.isArray(item) && (item as Record<string, unknown>)[TEXT] === 1) throw new Error('HISTORY_CHUNK_RESERVED_VALUE');
    if (Array.isArray(item)) {
      const result: unknown[] = [];
      for (let index = 0; index < item.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (descriptor && !('value' in descriptor)) throw new Error('HISTORY_PAYLOAD_UNSUPPORTED');
        result.push(await visit(descriptor?.value));
      }
      return result;
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const key in item) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor) continue;
      if (!('value' in descriptor)) throw new Error('HISTORY_PAYLOAD_UNSUPPORTED');
      result[key] = await visit(descriptor.value);
    }
    return result;
  };
  const transformed = await visit(value) as Record<string, unknown>;
  if (!externalized) throw new Error('HISTORY_PAYLOAD_TOO_LARGE');
  if (transformed.__ugsJournal === 1) {
    (transformed.fields as Record<string, unknown>)[VERSION] = 1;
  } else transformed[VERSION] = 1;
  return transformed;
}

/** Hydrate only one message for an authoritative skill-source check. */
export async function hydrateSessionPayload<T>(value: T, sessionPath: string, read: ReadChunk, messageId?: string, readBatch?: ReadChunkBatch): Promise<T> {
  if (!value || typeof value !== 'object' || (value as Record<string, unknown>)[VERSION] !== 1) return value;
  type TextSlot = { reference: ChunkReference; parts: string[]; assign: (text: string) => void };
  const slots: TextSlot[] = [];
  const hashes = new Map<string, Array<{ slot: TextSlot; index: number }>>();
  const visit = (item: unknown, assign: (value: unknown) => void, root = false): void => {
    if (reference(item)) {
      if (item.tail !== undefined && (item.tail.length >= CHUNK_UNITS || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(item.tail))) throw new Error('HISTORY_CHUNK_CORRUPT');
      const slot: TextSlot = { reference: item, parts: new Array(item.chunks.length), assign };
      slots.push(slot);
      item.chunks.forEach((hash, index) => {
        const consumers = hashes.get(hash) ?? [];
        consumers.push({ slot, index });
        hashes.set(hash, consumers);
      });
      return;
    }
    if (item === null || typeof item !== 'object') { assign(item); return; }
    if (!Array.isArray(item) && (item as Record<string, unknown>)[TEXT] === 1) throw new Error('HISTORY_CHUNK_REFERENCE_INVALID');
    if (Array.isArray(item)) {
      const result: unknown[] = new Array(item.length);
      assign(result);
      for (let index = 0; index < item.length; index++) visit(item[index], (hydrated) => { result[index] = hydrated; });
      return;
    }
    const result: Record<string, unknown> = {};
    assign(result);
    for (const [key, child] of Object.entries(item)) {
      if (root && key === VERSION) continue;
      const set = (hydrated: unknown) => Object.defineProperty(result, key, { value: hydrated, enumerable: true, writable: true, configurable: true });
      set(undefined);
      if (key === 'messages' && Array.isArray(child) && messageId !== undefined) {
        const messages = [...child];
        set(messages);
        child.forEach((message, index) => {
          if (message && typeof message === 'object' && message.id === messageId) visit(message, (hydrated) => { messages[index] = hydrated; });
        });
      } else visit(child, set);
    }
  };
  let result: unknown;
  visit(value, (hydrated) => { result = hydrated; }, true);
  // A chunk can be referenced more than once. Read and verify it once, with a
  // fixed concurrency bound across the entire record rather than per message.
  const jobs = [...hashes];
  let cursor = 0, failed = false, failure: unknown;
  const worker = async () => {
    while (!failed && cursor < jobs.length) {
      const batch = jobs.slice(cursor, cursor + (readBatch ? CHUNK_BATCH_SIZE : 1));
      cursor += batch.length;
      try {
        const paths = batch.map(([hash]) => chunkPath(sessionPath, hash));
        const payloads = readBatch ? await readBatch(paths) : [await read(paths[0])];
        if (!Array.isArray(payloads) || payloads.length !== batch.length) throw new Error('HISTORY_CHUNK_CORRUPT');
        await Promise.all(batch.map(async ([hash, consumers], i) => {
          const payload = payloads[i];
          const text = payload && typeof payload === 'object' ? (payload as { text?: unknown }).text : undefined;
          if (typeof text !== 'string' || text.length > CHUNK_UNITS || await digest(text) !== hash) throw new Error('HISTORY_CHUNK_CORRUPT');
          for (const { slot, index } of consumers) slot.parts[index] = text;
        }));
      } catch (error) { if (!failed) { failed = true; failure = error; } }
    }
  };
  const concurrency = readBatch ? CHUNK_BATCH_CONCURRENCY : CHUNK_READ_CONCURRENCY;
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  if (failed) throw failure;
  for (const slot of slots) {
    if (slot.reference.tail !== undefined) slot.parts.push(slot.reference.tail);
    if (slot.parts.reduce((units, text) => units + text.length, 0) !== slot.reference.units) throw new Error('HISTORY_CHUNK_CORRUPT');
    slot.assign(slot.parts.join(''));
  }
  return result as T;
}
