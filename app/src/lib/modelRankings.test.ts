import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => vi.fn());
vi.mock('@/lib/tauri', () => ({ tauriFetch: http }));
import { createModelRankingsStore, parseIntelligenceLeaderboard, RANKING_REFRESH_MS } from './modelRankings';

const html = `<table><thead><tr><th>Features</th></tr><tr><th>Model</th><th>Context Window</th><th>Creator</th><th>Artificial Analysis Intelligence Index</th><th>Cost per Task USD</th></tr></thead><tbody>
  <tr><td>Model A</td><td>1M</td><td>Creator A</td><td>58</td><td>$10.04</td></tr>
  <tr><td>Model B</td><td>1M</td><td>Creator B</td><td>59</td><td>$7.76</td></tr>
  <tr><td>Unevaluated</td><td>1M</td><td>Creator B</td><td>--</td><td>$1.00</td></tr>
</tbody></table>`;
const withPrices = (models: unknown[]) => `${html}<script>self.__next_f.push(${JSON.stringify([1, `22:${JSON.stringify(['$', 'div', null, { initialModels: models }])}\n`] )})</script>`;
const modelPrices = [
  { shortName: 'Model A', modelCreatorName: 'Creator A', price1mInputTokens: 2.5, price1mOutputTokens: 10 },
  { shortName: 'Model B', modelCreatorName: 'Creator B', price1mInputTokens: 0, price1mOutputTokens: 4 },
  { shortName: 'Model B', modelCreatorName: 'Another Creator', price1mInputTokens: 100, price1mOutputTokens: 100 },
];

describe('model rankings data', () => {
  beforeEach(() => { localStorage.clear(); http.mockReset(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-02T10:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('joins the exact model and creator to the published input and output prices, not cost per task', () => {
    expect(parseIntelligenceLeaderboard(withPrices(modelPrices))).toEqual([
      { name: 'Model B', creator: 'Creator B', score: 59, pricing: { inputUsd: 0, outputUsd: 4 } },
      { name: 'Model A', creator: 'Creator A', score: 58, pricing: { inputUsd: 2.5, outputUsd: 10 } },
    ]);
    expect(() => parseIntelligenceLeaderboard('<table><tr><td>invalid</td></tr></table>')).toThrow();
  });

  it('keeps missing, invalid and conflicting prices distinct from free prices', () => {
    expect(parseIntelligenceLeaderboard(withPrices([
      { shortName: 'Model A', modelCreatorName: 'Creator A', price1mInputTokens: 0, price1mOutputTokens: null },
      { shortName: 'Model B', modelCreatorName: 'Creator B', price1mInputTokens: 2, price1mOutputTokens: 3 },
      { shortName: 'Model B', modelCreatorName: 'Creator B', price1mInputTokens: 5, price1mOutputTokens: 6 },
    ]))).toEqual([
      { name: 'Model B', creator: 'Creator B', score: 59, pricing: null },
      { name: 'Model A', creator: 'Creator A', score: 58, pricing: { inputUsd: 0, outputUsd: null } },
    ]);
    expect(parseIntelligenceLeaderboard(html).every((entry) => entry.pricing === null)).toBe(true);
  });

  it('refreshes the leaderboard every two hours, and manual refresh bypasses the schedule', async () => {
    http.mockImplementation(async () => new Response(withPrices(modelPrices)));
    const store = createModelRankingsStore();
    store.start();
    await vi.waitFor(() => expect(store.getState().intelligence.entries).toHaveLength(2));
    expect(http).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RANKING_REFRESH_MS - 60_000);
    expect(http).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(http).toHaveBeenCalledTimes(2));
    await store.refresh();
    expect(http).toHaveBeenCalledTimes(3);
    store.stop();
  });

  it('retains prices and the cached timestamp when a refresh fails', async () => {
    http.mockImplementation(async () => new Response(withPrices(modelPrices)));
    const store = createModelRankingsStore();
    await store.refresh();
    const original = store.getState().intelligence;
    vi.advanceTimersByTime(60_000);
    http.mockImplementation(async () => new Response('blocked', { status: 403 }));
    await store.refresh();
    expect(store.getState().intelligence).toMatchObject({ entries: original.entries, fetchedAt: original.fetchedAt, loading: false, error: true });
    const restored = createModelRankingsStore().getState();
    expect(restored.intelligence.entries).toEqual(original.entries);
    expect(restored.intelligence.fetchedAt).toBe(original.fetchedAt);
    expect(restored.intelligence.error).toBe(true);
  });

  it('shows the old cached scores while refreshing them with prices', async () => {
    localStorage.setItem('ugs.modelRankings.v1', JSON.stringify({ intelligence: { entries: [{ name: 'Old', creator: 'A', score: 42 }], fetchedAt: Date.now() } }));
    http.mockImplementation(async () => new Response(withPrices(modelPrices)));
    const store = createModelRankingsStore();
    expect(store.getState().intelligence.entries).toEqual([{ name: 'Old', creator: 'A', score: 42, pricing: null }]);
    store.start();
    expect(http).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(store.getState().intelligence.entries[0].pricing?.inputUsd).toBe(0));
    store.stop();
  });
});
