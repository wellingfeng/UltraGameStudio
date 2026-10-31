import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { SkillCandidateTransport } from '@/lib/skillCandidateStore';
import type { SkillCandidateList } from '@/runtime/skills/preReview';
import type { SkillOrigin } from '@/runtime/skills/types';
// @ts-expect-error Node filesystem candidate host has no TS declaration.
import { createSkillCandidateService } from '../../../backend/src/skill-candidate-service.mjs';

export const HISTORY_FIXTURE_PREFIX = 'ultragamestudio.history.v1:';
type IpcPayload = Record<string, unknown>;

/** Serialized backing bytes, independent of renderer record/snapshot caches. */
export function createMemoryIpcFixture() {
  const bytes = new Map<string, string>();
  return {
    bytes,
    invoke(command: string, payload: IpcPayload): string | null {
      const path = String(payload.relPath);
      if (command === 'memory_read_json') return bytes.get(path) ?? null;
      if (command !== 'memory_compare_exchange_json') throw new Error(`Unexpected memory fixture IPC: ${command}`);
      if ((bytes.get(path) ?? null) !== payload.expectedJson) throw new Error('Memory CAS conflict: exact base changed');
      if (typeof payload.json !== 'string') throw new Error('Invalid memory fixture bytes');
      JSON.parse(payload.json);
      bytes.set(path, payload.json);
      return bytes.get(path)!;
    },
  };
}

/** Both browser fallback and injected native reads see the same durable bytes. */
export function historyFixtureIpc(command: string, payload: IpcPayload): string | string[] | null | undefined {
  const path = String(payload.relPath ?? '');
  const storage = window.localStorage;
  if (command === 'history_read_json') return storage.getItem(HISTORY_FIXTURE_PREFIX + path);
  if (command === 'history_write_json') {
    if (typeof payload.json !== 'string') throw new Error('Invalid history fixture bytes');
    JSON.parse(payload.json);
    storage.setItem(HISTORY_FIXTURE_PREFIX + path, payload.json);
    return;
  }
  if (command === 'history_root') return 'memory://serialized-history-fixture';
  const prefix = HISTORY_FIXTURE_PREFIX + path;
  if (command === 'history_remove') {
    for (const key of Object.keys(storage)) if (key === prefix || key.startsWith(prefix + '/')) storage.removeItem(key);
    return;
  }
  if (command === 'history_list_dir') {
    const directory = prefix + (path ? '/' : '');
    return [...new Set(Object.keys(storage).filter((key) => key.startsWith(directory)).map((key) => key.slice(directory.length).split('/')[0]))].sort();
  }
  throw new Error(`Unexpected history fixture IPC: ${command}`);
}

/** Seed an actual source message, never infer one from an incoming bind. */
export function seedSkillSourceFixture(origin: SkillOrigin, text: string): void {
  window.localStorage.setItem(`${HISTORY_FIXTURE_PREFIX}workspaces/${origin.workspaceId}/sessions/${origin.sessionId}.json`, JSON.stringify({
    id: origin.sessionId, workspaceId: origin.workspaceId, title: 'Persisted source fixture',
    isWorkflow: false, createdAt: 1, updatedAt: 1,
    messages: [{ id: origin.turnId, role: 'user', text, createdAt: 1 }],
  }));
}

/** Real host lock/CAS/fsync/readback; only the native IPC dispatch is doubled. */
export async function createCandidateIpcFixture(dir?: string) {
  const configuredScratch = process.env.TMPDIR;
  const nativeAbsolute = configuredScratch && isAbsolute(configuredScratch)
    && (process.platform !== 'win32' || /^(?:[A-Za-z]:[\\/]|\\\\)/.test(configuredScratch));
  // Windows bash may expose /tmp: never let native Node resolve it to a root
  // directory or fall back to the system temp. Use Hermes' own scratch instead.
  const scratch = nativeAbsolute ? configuredScratch
    : process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'hermes', 'cache', 'scratch') : undefined;
  if (!dir && (!scratch || !isAbsolute(scratch))) throw new Error('Candidate fixture requires an absolute scratch TMPDIR');
  if (!dir) await mkdir(scratch!, { recursive: true });
  const root = dir ?? await mkdtemp(join(scratch!, 'ugs-candidate-fixture-'));
  const service: { load(): Promise<SkillCandidateList>; compareAndSwap(revision: number, list: SkillCandidateList): Promise<SkillCandidateList> } = createSkillCandidateService({ dir: root });
  const request: SkillCandidateTransport = async (payload) => {
    if (payload.action === 'load') return service.load();
    if (payload.action === 'compare_and_swap' && payload.list && payload.expectedRevision !== undefined) {
      return service.compareAndSwap(payload.expectedRevision, payload.list);
    }
    throw new Error('Unexpected candidate fixture request');
  };
  return { root, service, request, close: () => dir ? Promise.resolve() : rm(root, { recursive: true, force: true }) };
}
