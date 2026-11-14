export interface AgentUsageRecord {
  id: string;
  recordedAt: number;
  application: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  estimated: boolean;
  costUsd?: number;
  elapsedMs?: number;
  firstResponseMs?: number;
}

export interface ActiveAgentUsage extends AgentUsageRecord {
  hasUsage: boolean;
}

const HISTORY_KEY = 'ugs_agent_usage_history_v1';
const MIGRATED_KEY = 'ugs_agent_usage_history_migrated_v1';
const SESSION_KEY = 'ugs_usage_meter_by_session_v1';
const CHANGE_EVENT = 'ugs:agent-usage-history-changed';
const activeCalls = new Map<string, ActiveAgentUsage>();

export function readActiveAgentUsage(): ActiveAgentUsage[] {
  return Array.from(activeCalls.values()).sort((a, b) => b.recordedAt - a.recordedAt);
}

export function startActiveAgentUsage(record: Pick<AgentUsageRecord, 'recordedAt' | 'application' | 'provider' | 'model'>): string {
  const id = `active:${record.recordedAt}:${Math.random().toString(36).slice(2)}`;
  activeCalls.set(id, { ...record, id, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, estimated: false, hasUsage: false });
  notify();
  return id;
}

export function updateActiveAgentUsage(id: string, update: Partial<Pick<ActiveAgentUsage, 'inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'hasUsage' | 'costUsd' | 'elapsedMs' | 'firstResponseMs'>>): void {
  const current = activeCalls.get(id);
  if (!current) return;
  activeCalls.set(id, { ...current, ...update });
  notify();
}

export function finishActiveAgentUsage(id: string): void {
  if (activeCalls.delete(id)) notify();
}

function storage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

export function localDayKey(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function recentDayKeys(now = Date.now()): string[] {
  const today = new Date(now);
  return Array.from({ length: 7 }, (_, offset) => localDayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset).getTime()));
}

function validRecord(value: unknown): value is AgentUsageRecord {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<AgentUsageRecord>;
  return typeof row.id === 'string' && typeof row.recordedAt === 'number' && Number.isFinite(row.recordedAt)
    && typeof row.application === 'string' && typeof row.provider === 'string' && typeof row.model === 'string'
    && [row.inputTokens, row.outputTokens, row.cachedInputTokens].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)
    && [row.costUsd, row.elapsedMs, row.firstResponseMs].every((n) => n === undefined || (typeof n === 'number' && Number.isFinite(n) && n >= 0))
    && typeof row.estimated === 'boolean';
}

function notify(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Keep only the current local day and the six preceding local days. */
export function readAgentUsageHistory(now = Date.now()): AgentUsageRecord[] {
  const store = storage();
  if (!store) return [];
  try {
    const raw = store.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    const days = new Set(recentDayKeys(now));
    const rows = (Array.isArray(parsed) ? parsed : []).filter(validRecord).filter((row) => days.has(localDayKey(row.recordedAt)));
    if (!Array.isArray(parsed) || rows.length !== parsed.length) {
      store.setItem(HISTORY_KEY, JSON.stringify(rows));
    }
    return rows.sort((a, b) => b.recordedAt - a.recordedAt);
  } catch { return []; }
}

/** Recover only the last known call per old session; older calls were not retained. */
export function migrateAgentUsageHistory(now = Date.now()): void {
  const store = storage();
  if (!store) return;
  try {
    if (store.getItem(MIGRATED_KEY)) return;
    const raw = JSON.parse(store.getItem(SESSION_KEY) ?? '{}') as Record<string, { lastCall?: Record<string, unknown> }>;
    const rows = readAgentUsageHistory(now);
    const days = new Set(recentDayKeys(now));
    for (const [session, snapshot] of Object.entries(raw ?? {})) {
      const call = snapshot?.lastCall;
      if (!call || typeof call.updatedAt !== 'number' || !days.has(localDayKey(call.updatedAt))) continue;
      const id = `legacy:${session}:${call.updatedAt}`;
      if (rows.some((row) => row.id === id)) continue;
      const numeric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
      rows.push({ id, recordedAt: call.updatedAt, application: '', provider: typeof call.providerLabel === 'string' ? call.providerLabel : '', model: typeof call.modelLabel === 'string' ? call.modelLabel : '', inputTokens: numeric(call.inputTokens), outputTokens: numeric(call.outputTokens), cachedInputTokens: numeric(call.cachedInputTokens), estimated: call.estimated !== false });
    }
    store.setItem(HISTORY_KEY, JSON.stringify(rows));
    store.setItem(MIGRATED_KEY, '1');
    notify();
  } catch { /* Keep the existing session meter intact if migration fails. */ }
}

export function appendAgentUsage(record: Omit<AgentUsageRecord, 'id'>): void {
  const store = storage();
  if (!store) return;
  try {
    migrateAgentUsageHistory(record.recordedAt);
    const rows = readAgentUsageHistory(record.recordedAt);
    rows.push({ ...record, id: `${record.recordedAt}:${Math.random().toString(36).slice(2)}` });
    store.setItem(HISTORY_KEY, JSON.stringify(rows));
    notify();
  } catch { /* Usage tracking must not interrupt the model call. */ }
}

export function subscribeAgentUsageHistory(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const onStorage = (event: StorageEvent) => { if (event.key === HISTORY_KEY) listener(); };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener('storage', onStorage);
  return () => { window.removeEventListener(CHANGE_EVENT, listener); window.removeEventListener('storage', onStorage); };
}
