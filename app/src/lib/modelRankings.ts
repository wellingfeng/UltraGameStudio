import { tauriFetch } from '@/lib/tauri';

export const INTELLIGENCE_SOURCE = 'https://artificialanalysis.ai/leaderboards/models';
export const RANKING_REFRESH_MS = 2 * 60 * 60 * 1000;
const CACHE_KEY = 'ugs.modelRankings.v1';

export interface IntelligenceEntry {
  name: string;
  creator: string;
  score: number;
  pricing: { inputUsd: number | null; outputUsd: number | null } | null;
}

export interface RankingSource<T> {
  entries: T[];
  fetchedAt: number | null;
  loading: boolean;
  error: boolean;
}

export interface ModelRankingsState {
  intelligence: RankingSource<IntelligenceEntry>;
}

const emptySource = <T>(): RankingSource<T> => ({ entries: [], fetchedAt: null, loading: false, error: false });

type ModelPricing = NonNullable<IntelligenceEntry['pricing']>;
const modelKey = (name: string, creator: string) => `${name.trim().toLocaleLowerCase()}\0${creator.trim().toLocaleLowerCase()}`;

/** Read the leaderboard's embedded model data without executing its scripts. */
function parseLeaderboardPrices(html: string): Map<string, ModelPricing> {
  const prices = new Map<string, ModelPricing>();
  const ambiguous = new Set<string>();
  const addModels = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (!item || typeof item !== 'object') continue;
      const model = item as { shortName?: unknown; modelCreatorName?: unknown; price1mInputTokens?: unknown; price1mOutputTokens?: unknown };
      if (typeof model.shortName !== 'string' || typeof model.modelCreatorName !== 'string') continue;
      const amount = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
      const pricing = { inputUsd: amount(model.price1mInputTokens), outputUsd: amount(model.price1mOutputTokens) };
      if (pricing.inputUsd === null && pricing.outputUsd === null) continue;
      const key = modelKey(model.shortName, model.modelCreatorName);
      const existing = prices.get(key);
      if (existing && (existing.inputUsd !== pricing.inputUsd || existing.outputUsd !== pricing.outputUsd)) {
        prices.delete(key);
        ambiguous.add(key);
      } else if (!ambiguous.has(key)) {
        prices.set(key, pricing);
      }
    }
  };
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'initialModels') addModels(child);
      else visit(child);
    }
  };
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    if (!script[1].includes('price1mInputTokens') && !script[1].includes('price1mOutputTokens')) continue;
    const payload = script[1].match(/^\s*self\.__next_f\.push\(([\s\S]*)\)\s*;?\s*$/);
    if (!payload) continue;
    try {
      const chunk = JSON.parse(payload[1]) as unknown;
      if (!Array.isArray(chunk) || typeof chunk[1] !== 'string') continue;
      for (const line of chunk[1].split('\n')) {
        const record = line.match(/^[0-9a-f]+:([\s\S]+)$/i);
        if (!record) continue;
        try { visit(JSON.parse(record[1]) as unknown); } catch { /* Ignore unrelated or incomplete records. */ }
      }
    } catch { /* Ignore malformed or unrelated scripts. */ }
  }
  return prices;
}

/** Parse the published leaderboard table, never the similarly named cost-per-task column. */
export function parseIntelligenceLeaderboard(html: string): IntelligenceEntry[] {
  const prices = parseLeaderboardPrices(html);
  const tableMarkup = html.match(/<table\b[\s\S]*?<\/table\s*>/gi) ?? [];
  for (const markup of tableMarkup) {
    // The detached document must not trigger requests for the site's image assets.
    const safeMarkup = markup.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '').replace(/<(?:img|iframe|source)\b[^>]*>/gi, '');
    const document = new DOMParser().parseFromString(safeMarkup, 'text/html');
    const table = document.querySelector('table');
    const headerRows = Array.from(table?.querySelectorAll('thead tr') ?? []);
    const headers = Array.from(headerRows[headerRows.length - 1]?.querySelectorAll('th') ?? []).map((cell) => cell.textContent?.trim() ?? '');
    const modelIndex = headers.indexOf('Model');
    const creatorIndex = headers.indexOf('Creator');
    const scoreIndex = headers.indexOf('Artificial Analysis Intelligence Index');
    if (modelIndex < 0 || creatorIndex < 0 || scoreIndex < 0) continue;
    const entries: IntelligenceEntry[] = [];
    for (const row of Array.from(table?.querySelectorAll('tbody tr') ?? [])) {
      const cells = row.querySelectorAll('td');
      const name = cells[modelIndex]?.textContent?.trim() ?? '';
      const creator = cells[creatorIndex]?.textContent?.trim() ?? '';
      const scoreText = cells[scoreIndex]?.textContent?.trim() ?? '';
      if (!name || !creator || !/^\d+(?:\.\d+)?$/.test(scoreText)) continue;
      entries.push({ name, creator, score: Number(scoreText), pricing: prices.get(modelKey(name, creator)) ?? null });
    }
    if (entries.length > 0) return entries.sort((a, b) => b.score - a.score);
  }
  throw new Error('Intelligence leaderboard format changed or contains no scores');
}

function readCache(): { state: ModelRankingsState; hasPriceData: boolean } {
  const state: ModelRankingsState = { intelligence: emptySource() };
  let hasPriceData = false;
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}') as Partial<ModelRankingsState> & { pricingLoaded?: boolean };
    const intelligence = cached.intelligence;
    if (intelligence && Array.isArray(intelligence.entries) && intelligence.entries.length &&
        typeof intelligence.fetchedAt === 'number' && Number.isFinite(intelligence.fetchedAt) &&
        intelligence.entries.every((entry) => typeof entry?.name === 'string' && typeof entry.creator === 'string' && typeof entry.score === 'number' && Number.isFinite(entry.score))) {
      const validAmount = (value: unknown) => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
      hasPriceData = cached.pricingLoaded === true && intelligence.entries.every((entry) => Object.prototype.hasOwnProperty.call(entry, 'pricing') &&
        (entry.pricing === null || (entry.pricing && validAmount(entry.pricing.inputUsd) && validAmount(entry.pricing.outputUsd))));
      const entries = intelligence.entries.map((entry) => ({ ...entry, pricing: hasPriceData ? entry.pricing : null }));
      Object.assign(state.intelligence, { entries, fetchedAt: intelligence.fetchedAt, error: intelligence.error === true });
    }
  } catch { /* localStorage can be unavailable or contain invalid data. */ }
  return { state, hasPriceData };
}

export function createModelRankingsStore() {
  const cached = readCache();
  let state = cached.state;
  let hasPriceData = cached.hasPriceData;
  let inflight: Promise<void> | null = null;
  let interval: ReturnType<typeof setInterval> | undefined;
  let lastAttempt = 0;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const persist = () => {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ...state, pricingLoaded: hasPriceData })); } catch { /* Keep the in-memory results. */ }
  };
  const update = (value: RankingSource<IntelligenceEntry>) => {
    state = { intelligence: value };
    notify();
  };
  const refresh = (): Promise<void> => {
    if (inflight) return inflight;
    lastAttempt = Date.now();
    state = { intelligence: { ...state.intelligence, loading: true, error: false } };
    notify();
    const load = async () => {
      try {
        const response = await tauriFetch(`${INTELLIGENCE_SOURCE}?_=${Date.now()}`, { cache: 'no-store' }, { timeoutMs: 30_000, maxResponseBytes: 8_000_000 });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const entries = parseIntelligenceLeaderboard(await response.text());
        hasPriceData = true;
        update({ entries, fetchedAt: Date.now(), loading: false, error: false });
        persist();
      } catch {
        update({ ...state.intelligence, loading: false, error: true });
        persist();
      }
    };
    inflight = load().finally(() => { inflight = null; });
    return inflight;
  };
  const refreshIfDue = () => {
    const now = Date.now();
    if (now - lastAttempt < RANKING_REFRESH_MS && lastAttempt !== 0) return;
    if (!lastAttempt && hasPriceData && state.intelligence.fetchedAt &&
        state.intelligence.fetchedAt <= now && now - state.intelligence.fetchedAt < RANKING_REFRESH_MS) {
      lastAttempt = state.intelligence.fetchedAt;
      return;
    }
    void refresh();
  };
  return {
    getState: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh,
    start() {
      refreshIfDue();
      if (!interval) interval = setInterval(refreshIfDue, 60_000);
      document.addEventListener('visibilitychange', refreshIfDue);
    },
    stop() {
      if (interval) clearInterval(interval);
      interval = undefined;
      document.removeEventListener('visibilitychange', refreshIfDue);
    },
  };
}

export const modelRankings = createModelRankingsStore();
