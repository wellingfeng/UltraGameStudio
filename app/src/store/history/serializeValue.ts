import { estimateHistoryBytes, historyJsonEnvelopeBytes, HISTORY_PAYLOAD_BYTES, HISTORY_PAYLOAD_DEPTH, HISTORY_PAYLOAD_NODES } from './payloadBudget';

export function stringifyHistory(value: unknown): string {
  estimateHistoryBytes(value);
  return stringifyInert(value);
}

function stringifyInert(value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  if (typeof json !== 'string') throw new Error('HISTORY_PAYLOAD_UNSUPPORTED');
  historyJsonEnvelopeBytes(json);
  return json.replace(
    /\\\\|\\u(d[89ab][0-9a-f]{2})(\\ud[c-f][0-9a-f]{2})?|\\ud[c-f][0-9a-f]{2}/gi,
    (match, _high, lowPair) => match === '\\\\' || lowPair ? match : '\\ufffd',
  );
}

/** Decode clone-domain own DATA only; never consult receiver prototypes. */
export function stringifyCanonicalHistory(value: unknown): string {
  let bytes = 0, nodes = 0;
  const ancestors = new Set<object>();
  const add = (cost: number) => { bytes += cost; if (bytes > HISTORY_PAYLOAD_BYTES) throw new Error('HISTORY_PAYLOAD_TOO_LARGE'); };
  const decode = (item: unknown, depth: number): unknown => {
    if (++nodes > HISTORY_PAYLOAD_NODES || depth > HISTORY_PAYLOAD_DEPTH) throw new Error('HISTORY_PAYLOAD_COMPLEXITY');
    if (typeof item === 'string') { add(16 + 16 * item.length); return item; }
    if (item === null || typeof item === 'number' || typeof item === 'boolean') { add(32); return item; }
    if (!item || typeof item !== 'object') throw new Error('HISTORY_PAYLOAD_UNSUPPORTED');
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) throw new Error('HISTORY_PAYLOAD_UNSUPPORTED');
    if (ancestors.has(item)) throw new Error('HISTORY_PAYLOAD_CYCLE');
    ancestors.add(item); add(128);
    const array = Array.isArray(item);
    const result = array ? Object.setPrototypeOf([], null) : Object.create(null);
    if (array) {
      const length = Object.getOwnPropertyDescriptor(item, 'length');
      if (!length || !('value' in length) || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > HISTORY_PAYLOAD_NODES - nodes) throw new Error('HISTORY_PAYLOAD_COMPLEXITY');
      const keys = Reflect.ownKeys(item);
      if (keys.length !== length.value + 1) throw new Error('HISTORY_PAYLOAD_UNSUPPORTED');
      for (let i = 0; i < length.value; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new Error('HISTORY_PAYLOAD_UNSUPPORTED');
        add(64 + 8 * depth);
        Object.defineProperty(result, String(i), { value: decode(descriptor.value, depth + 1), enumerable: true, configurable: true, writable: true });
      }
    } else {
      for (const key of Reflect.ownKeys(item)) {
        if (typeof key !== 'string') throw new Error('HISTORY_PAYLOAD_UNSUPPORTED');
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new Error('HISTORY_PAYLOAD_UNSUPPORTED');
        add(64 + key.length * 16 + 8 * depth);
        Object.defineProperty(result, key, { value: decode(descriptor.value, depth + 1), enumerable: true, configurable: true, writable: true });
      }
    }
    ancestors.delete(item); return result;
  };
  return stringifyInert(decode(value, 0));
}

export interface SerializationRequest { id: number; value: unknown; canonicalVersion?: number }
export interface SerializationResponse { id: number; json?: string; error?: string }
export function handleSerialization(request: SerializationRequest): SerializationResponse {
  try {
    const version = Object.getOwnPropertyDescriptor(request, 'canonicalVersion');
    if (version) {
      if (!('value' in version) || version.value !== 1) throw new Error('HISTORY_SERIALIZATION_INVALID');
      const keys = Reflect.ownKeys(request);
      const id = Object.getOwnPropertyDescriptor(request, 'id');
      const value = Object.getOwnPropertyDescriptor(request, 'value');
      if (keys.length !== 3 || !id || !('value' in id) || !Number.isSafeInteger(id.value) || !value || !('value' in value)) throw new Error('HISTORY_SERIALIZATION_INVALID');
      return { id: id.value, json: stringifyCanonicalHistory(value.value) };
    }
    return { id: request.id, json: stringifyHistory(request.value) };
  }
  catch (error) {
    const id = Object.getOwnPropertyDescriptor(request, 'id');
    return { id: id && 'value' in id && Number.isSafeInteger(id.value) ? id.value : 0, error: error instanceof Error ? error.message : String(error) };
  }
}
