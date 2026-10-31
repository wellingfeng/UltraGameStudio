/** Durable session-owned prompt prefixes. Cache release never discards the persisted version. */
import { compareExchangeMemoryJson, readMemoryJson, withMemoryLock } from './memoryTransactions';

interface FrozenSnapshot {
  version: 1;
  workspaceId: string | null;
  freezeKey: string;
  full: string;
  compact: string;
}
const snapshots = new Map<string, Promise<FrozenSnapshot>>();
const identity = (workspaceId: string | undefined, freezeKey: string) => JSON.stringify([workspaceId ?? null, freezeKey]);
const pathFor = (key: string) => `memories/snapshots/${Array.from(new TextEncoder().encode(key), (byte) => byte.toString(16).padStart(2, '0')).join('')}.json`;

function parseSnapshot(raw: string, workspaceId: string | undefined, freezeKey: string): FrozenSnapshot {
  const value = JSON.parse(raw) as FrozenSnapshot;
  if (!value || value.version !== 1 || value.workspaceId !== (workspaceId ?? null) || value.freezeKey !== freezeKey ||
      typeof value.full !== 'string' || typeof value.compact !== 'string' ||
      Object.keys(value).some((key) => !['version', 'workspaceId', 'freezeKey', 'full', 'compact'].includes(key))) {
    throw new Error('Unknown session memory snapshot; refusing live replacement');
  }
  return value;
}

export async function loadFrozenSnapshot(
  workspaceId: string | undefined,
  freezeKey: string,
  create: () => Promise<Pick<FrozenSnapshot, 'full' | 'compact'>>,
): Promise<FrozenSnapshot> {
  if (!freezeKey || freezeKey.length > 256) throw new Error('Invalid session snapshot identity');
  const key = identity(workspaceId, freezeKey);
  const cached = snapshots.get(key);
  if (cached) return cached;
  const path = pathFor(key);
  const work = withMemoryLock(path, async () => {
    const raw = await readMemoryJson(path);
    if (raw !== null) return parseSnapshot(raw, workspaceId, freezeKey);
    const snapshot: FrozenSnapshot = { version: 1, workspaceId: workspaceId ?? null, freezeKey, ...(await create()) };
    try {
      await compareExchangeMemoryJson(path, null, JSON.stringify(snapshot));
    } catch (error) {
      // Another host may have frozen this same session. Adopt only its exact known identity.
      if (!/conflict/i.test(String(error))) throw error;
      const winner = await readMemoryJson(path);
      if (winner === null) throw error;
      return parseSnapshot(winner, workspaceId, freezeKey);
    }
    return snapshot;
  });
  snapshots.set(key, work);
  try { return await work; }
  catch (error) { if (snapshots.get(key) === work) snapshots.delete(key); throw error; }
}

export function releaseFrozenSnapshot(workspaceId: string | undefined, freezeKey: string): void {
  snapshots.delete(identity(workspaceId, freezeKey));
}
export function resetSnapshotCache(): void { snapshots.clear(); }
