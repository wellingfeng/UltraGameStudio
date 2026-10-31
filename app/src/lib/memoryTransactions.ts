/** Memory-only durability boundary. Never falls back from native CAS to history writes. */
import { tauriAvailable } from './tauri';

const PREFIX = 'ultragamestudio.memory.v1:';
const locks = new Map<string, Promise<unknown>>();

function storage(): Storage {
  if (typeof window === 'undefined' || !window.localStorage) throw new Error('Memory persistence unavailable');
  return window.localStorage;
}

export async function readMemoryJson(relPath: string): Promise<string | null> {
  if (tauriAvailable()) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string | null>('memory_read_json', { relPath });
  }
  return storage().getItem(PREFIX + relPath);
}

export function checkMemoryCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Memory write cancelled', 'AbortError');
}

export async function compareExchangeMemoryJson(relPath: string, expectedJson: string | null, json: string, signal?: AbortSignal,
  beforeDispatch?: () => void): Promise<void> {
  JSON.parse(json); // never publish malformed data
  if (tauriAvailable()) {
    const { invoke } = await import('@tauri-apps/api/core');
    // No await between this host-owned guard, the final signal check and dispatch.
    beforeDispatch?.();
    checkMemoryCancelled(signal);
    const committed = await invoke<string>('memory_compare_exchange_json', { relPath, expectedJson, json });
    if (committed !== json) throw new Error('Memory readback mismatch; persistence not confirmed');
    // Read the exact target again; a command receipt alone is not evidence.
    if (await readMemoryJson(relPath) !== json) throw new Error('Memory readback mismatch; target changed after commit');
    return;
  }
  const store = storage();
  if (store.getItem(PREFIX + relPath) !== expectedJson) throw new Error('Memory CAS conflict: exact base changed');
  beforeDispatch?.();
  checkMemoryCancelled(signal);
  store.setItem(PREFIX + relPath, json);
  if (store.getItem(PREFIX + relPath) !== json) throw new Error('Memory readback mismatch; persistence not confirmed');
}

/** Serialize each exact target; Web Locks also exclude other browser tabs. */
export async function withMemoryLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const previous = locks.get(path) ?? Promise.resolve();
  const work = previous.catch(() => undefined).then(async () => {
    const manager = typeof navigator === 'undefined' ? undefined : navigator.locks;
    return manager ? manager.request(`ugs-memory:${path}`, action) : action();
  });
  locks.set(path, work);
  try { return await work; }
  finally { if (locks.get(path) === work) locks.delete(path); }
}
