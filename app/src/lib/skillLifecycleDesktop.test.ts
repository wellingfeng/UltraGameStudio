import { afterEach, describe, expect, it, vi } from 'vitest';
import { startSkillLifecycleAdvisory } from './skillLifecycleDesktop';
import { DEFAULT_SKILL_LEARNING_CONFIG } from './skillLearningConfig';
import type { SkillEntry } from '@/runtime/skills/types';
const day = 86400000;
const entry: SkillEntry = { skillId: 'a', rootId: 'r', name: 'rule', description: 'Use when checking.', scope: 'project', source: 'ugs-project', relativePath: 'rule', revision: 'v1', hash: 'h', readOnly: false, autoEditable: true, contentLocked: false, pinned: false, state: 'active', files: ['SKILL.md'], usage: { viewed: 5, delivered: 1, usedWithEvidence: 0 } };
afterEach(() => { vi.useRealTimers(); localStorage.clear(); });
describe('idle lifecycle advisory', () => {
  it('defers while foreground work is busy and stops timers and activity subscriptions on teardown', () => {
    vi.useFakeTimers();
    let busy = true;
    const onResult = vi.fn();
    const stop = startSkillLifecycleAdvisory({ scopeKey: 'busy', getEntries: () => [entry], getConfig: () => DEFAULT_SKILL_LEARNING_CONFIG, onResult, isForegroundBusy: () => busy, idleMs: 1000 });
    vi.advanceTimersByTime(2000); expect(onResult).not.toHaveBeenCalled();
    busy = false; vi.advanceTimersByTime(1000); expect(onResult).toHaveBeenCalledTimes(1);
    stop(); vi.advanceTimersByTime(3600000); expect(onResult).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('protects unknown, pinned and cron ownership and never replaces unreadable observation data', () => {
    vi.useFakeTimers(); vi.setSystemTime(200 * day);
    const storage = { getItem: vi.fn(() => JSON.stringify({firstObserved:{'["r","a"]':0}})), setItem: vi.fn() };
    const onResult = vi.fn();
    const stop = startSkillLifecycleAdvisory({ scopeKey: 'protected', getEntries: () => [entry], getConfig: () => ({...DEFAULT_SKILL_LEARNING_CONFIG,autoArchive:true}), getProtection: () => ({backgroundCreated:true,cronReferenced:true}), storage, onResult, idleMs:1000 });
    vi.advanceTimersByTime(1000); expect(onResult.mock.calls[0][0][0]).toMatchObject({shouldArchive:false,usedWithEvidence:false}); stop();
    storage.getItem.mockReturnValue('{bad'); storage.setItem.mockClear();
    const onError = vi.fn();
    const stopBad = startSkillLifecycleAdvisory({scopeKey:'bad',getEntries:()=>[entry],getConfig:()=>DEFAULT_SKILL_LEARNING_CONFIG,storage,onResult,onError,idleMs:1000});
    vi.advanceTimersByTime(1000); expect(onError).toHaveBeenCalledTimes(1); expect(storage.setItem).not.toHaveBeenCalled(); stopBad();
  });
  it('waits for real UI idle, persists first observation, then emits only advice from the supplied catalog', () => {
    vi.useFakeTimers(); vi.setSystemTime(100 * day);
    const onResult = vi.fn();
    const stop = startSkillLifecycleAdvisory({ scopeKey: 'ws-a', getEntries: () => [entry], getConfig: () => ({ ...DEFAULT_SKILL_LEARNING_CONFIG, autoArchive: true }), onResult, idleMs: 2000, intervalMs: 60000 });
    vi.advanceTimersByTime(1500); document.dispatchEvent(new Event('keydown'));
    vi.advanceTimersByTime(1500); expect(onResult).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000); expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult.mock.calls[0][0][0]).toMatchObject({ firstObservedAt: 100 * day + 3500, shouldArchive: false, state: 'active', usedWithEvidence: false });
    stop();
    vi.setSystemTime(200 * day);
    const second = vi.fn();
    const stopAgain = startSkillLifecycleAdvisory({ scopeKey: 'ws-a', getEntries: () => [entry], getConfig: () => ({ ...DEFAULT_SKILL_LEARNING_CONFIG, autoArchive: true }), onResult: second, idleMs: 2000 });
    vi.advanceTimersByTime(2000);
    expect(second.mock.calls[0][0][0]).toMatchObject({ state: 'stale', shouldArchive: false, firstObservedAt: 100 * day + 3500 });
    expect(second.mock.calls[0][0][0].entry.revision).toBe('v1');
    stopAgain();
  });
});
