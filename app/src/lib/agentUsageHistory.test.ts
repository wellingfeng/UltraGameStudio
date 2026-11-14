import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendAgentUsage, localDayKey, migrateAgentUsageHistory, readAgentUsageHistory, recentDayKeys, subscribeAgentUsageHistory } from './agentUsageHistory';
import { recordModelUsageForRoute, usageReportFromCliUsage } from './usageMeter';

const key = 'ugs_agent_usage_history_v1';
const now = new Date(2026, 10, 10, 12).getTime();
const row = (time: number) => ({ recordedAt: time, application: 'codex', provider: '测试渠道', model: 'test-model', inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, estimated: false });

beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => vi.useRealTimers());

describe('Agent usage history', () => {
  it('persists real usage and reported cost, and notifies subscribers', () => {
    const listener = vi.fn();
    const stop = subscribeAgentUsageHistory(listener);
    const report = usageReportFromCliUsage({ usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 40 }, total_cost_usd: 0.045 })!;
    recordModelUsageForRoute({ selection: { adapter: 'codex', modelClass: 'sonnet' }, providerName: '测试渠道', model: 'test-model' }, report, { estimated: false, elapsedMs: 5000, firstResponseMs: 1000 });
    expect(readAgentUsageHistory()).toEqual([expect.objectContaining({ ...row(now), costUsd: 0.045, elapsedMs: 5000, firstResponseMs: 1000 })]);
    expect(listener).toHaveBeenCalled();
    stop();
  });

  it('deletes records outside the current seven local calendar days', () => {
    appendAgentUsage(row(new Date(2026, 10, 4, 0, 0).getTime()));
    appendAgentUsage(row(now));
    expect(readAgentUsageHistory().map((item) => localDayKey(item.recordedAt))).toEqual(['2026-11-10', '2026-11-04']);
    vi.setSystemTime(new Date(2026, 10, 11, 0, 1));
    expect(readAgentUsageHistory()).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(key)!)).toHaveLength(1);
    expect(recentDayKeys()[6]).toBe('2026-11-05');
  });

  it('recovers one last call per existing session only once without changing session totals', () => {
    const snapshot = { 'work:session': { totals: { calls: 9 }, lastCall: { updatedAt: now, providerLabel: '旧渠道', modelLabel: '旧模型', inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, estimated: false } } };
    localStorage.setItem('ugs_usage_meter_by_session_v1', JSON.stringify(snapshot));
    migrateAgentUsageHistory();
    migrateAgentUsageHistory();
    expect(readAgentUsageHistory()).toEqual([expect.objectContaining({ provider: '旧渠道', model: '旧模型', inputTokens: 100 })]);
    expect(JSON.parse(localStorage.getItem('ugs_usage_meter_by_session_v1')!)).toEqual(snapshot);
  });
});
