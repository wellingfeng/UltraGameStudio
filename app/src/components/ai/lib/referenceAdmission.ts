import { mergeReferenceSources, referenceKey, type MessageReference, type ReferenceSource } from '@/lib/messageReferences';
import { MAX_REFERENCE_ANALYSIS_CHARS, MAX_REFERENCE_ANALYSIS_SOURCES, MAX_REFERENCE_URL_BYTES, MAX_REFERENCE_TITLE_BYTES, MAX_REFERENCE_TOOL_ID_BYTES, MAX_REFERENCE_SOURCE_BYTES, MAX_REFERENCE_REQUEST_BYTES, MAX_REFERENCE_RESPONSE_BYTES } from './referenceProtocol';

/** Exact JSON UTF-8 string cost, early exit, no object serialization. */
export function jsonStringBytes(value: string, limit: number): number | null {
  if (value.length > limit) return null;
  let bytes = 2;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) bytes += 2;
    else if (code < 32) bytes += 6;
    else if (code < 128) bytes++;
    else if (code < 2048) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else if (code >= 0xd800 && code <= 0xdfff) bytes += 6;
    else bytes += 3;
    if (bytes > limit) return null;
  }
  return bytes <= limit ? bytes : null;
}
function sourceBytes(sources: ReferenceSource[]): number {
  // Fixed reserve exceeds schema names, punctuation and safe-integer bytes.
  return 2 + sources.reduce((sum, source) => sum + 128 +
    jsonStringBytes(source.url, MAX_REFERENCE_URL_BYTES + 2)! +
    jsonStringBytes(source.title, MAX_REFERENCE_TITLE_BYTES + 2)! +
    jsonStringBytes(source.toolCallId, MAX_REFERENCE_TOOL_ID_BYTES + 2)!, 0);
}

/** Own data only. Reflection cannot make arbitrary Proxy traps inert; callers
 * must provide non-Proxy snapshots. Canonical copies prevent later mutation of
 * admitted inputs from changing requests. No getter/toJSON/coercion is invoked.
 */
export function ownData(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  try { const descriptor = Object.getOwnPropertyDescriptor(value, key); return descriptor && 'value' in descriptor ? descriptor.value : undefined; }
  catch { return undefined; }
}
// Native MessageEvent.data is a platform accessor, not an input-owned getter.
const nativeEventData = typeof MessageEvent === 'undefined' ? undefined : Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data')?.get;
export function referenceEventData(event: unknown): unknown {
  try {
    if (nativeEventData && event instanceof MessageEvent) return nativeEventData.call(event);
    return ownData(event, 'data');
  } catch { return undefined; }
}
export function inertReplyEnvelope(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  try {
    const keys = Reflect.ownKeys(value);
    return keys.length <= 3 && keys.every(key => typeof key === 'string' && ['id', 'references', 'error'].includes(key) && 'value' in Object.getOwnPropertyDescriptor(value, key)!);
  } catch { return false; }
}
export function admitSources(input: unknown, numbered = false): ReferenceSource[] | null {
  try {
    if (!Array.isArray(input)) return null;
    const length = ownData(input, 'length');
    if (typeof length !== 'number' || length > MAX_REFERENCE_ANALYSIS_SOURCES) return null;
    const output: ReferenceSource[] = [];
    let bytes = 2;
    for (let i = 0; i < length; i++) {
      const value = ownData(input, String(i));
      if (!value || typeof value !== 'object') return null;
      const keys = Reflect.ownKeys(value);
      if (keys.length > 4 || keys.some(key => typeof key !== 'string' || !['url', 'title', 'toolCallId', 'number'].includes(key))) return null;
      const url = ownData(value, 'url'), title = ownData(value, 'title'), toolCallId = ownData(value, 'toolCallId');
      const number = ownData(value, 'number');
      if (typeof url !== 'string' || typeof title !== 'string' || typeof toolCallId !== 'string') return null;
      const urlBytes = jsonStringBytes(url, MAX_REFERENCE_URL_BYTES + 2), titleBytes = jsonStringBytes(title, MAX_REFERENCE_TITLE_BYTES + 2), toolBytes = jsonStringBytes(toolCallId, MAX_REFERENCE_TOOL_ID_BYTES + 2);
      if (urlBytes === null || titleBytes === null || toolBytes === null) return null;
      bytes += 128 + urlBytes + titleBytes + toolBytes;
      if (bytes > (numbered ? MAX_REFERENCE_RESPONSE_BYTES - 128 : MAX_REFERENCE_SOURCE_BYTES) || !referenceKey(url)) return null;
      if ((numbered || keys.includes('number')) && (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0)) return null;
      const canonical = Object.assign(Object.create(null), { url, title, toolCallId });
      if (numbered) canonical.number = number;
      output.push(canonical);
    }
    return output;
  } catch { return null; }
}
export function admitReferences(input: unknown): MessageReference[] | null {
  return admitSources(input, true) as MessageReference[] | null;
}
/** Unknown extras are rejected, not walked/serialized. Optional historical
 * MessageReference.number is validated then removed from source evidence. */
export function admitAndMergeSources(...groups: unknown[]): ReferenceSource[] | null {
  if (groups.length > 4) return null;
  const canonical: ReferenceSource[][] = [];
  let count = 0, bytes = 0;
  for (const group of groups) {
    const admitted = admitSources(group);
    if (!admitted || (count += admitted.length) > MAX_REFERENCE_ANALYSIS_SOURCES || (bytes += sourceBytes(admitted)) > MAX_REFERENCE_SOURCE_BYTES) return null;
    canonical.push(admitted);
  }
  return mergeReferenceSources(...canonical);
}
export function sourceRevisionKey(sources: ReferenceSource[]): string {
  // Encode only admitted primitives: never consult object/array toJSON.
  return '[' + sources.map(source => '[' + [source.url, source.title, source.toolCallId].map(value => JSON.stringify(value)).join(',') + ']').join(',') + ']';
}
export function admitAnalysisInput(text: unknown, input: unknown): { text: string; sources: ReferenceSource[] } | null {
  if (typeof text !== 'string' || text.length > MAX_REFERENCE_ANALYSIS_CHARS) return null;
  const sources = admitSources(input);
  if (!sources || jsonStringBytes(text, MAX_REFERENCE_REQUEST_BYTES - sourceBytes(sources) - 128) === null) return null;
  return { text, sources };
}
