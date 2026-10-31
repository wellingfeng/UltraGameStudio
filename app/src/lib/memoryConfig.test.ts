import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_MEMORY_CONFIG,
  getLastReviewAt,
  loadMemoryConfig,
  saveMemoryConfig,
  setLastReviewAt,
  loadMemoryReviewJournal,
  saveMemoryReviewJournal,
  type MemoryReviewJournal,
} from './memoryConfig';
import { getMemoryLimits, getMemoryNudgeThresholdPct } from './memoryStore';
import { resetGenerationSettingsStoreForTests } from './generationSettingsStore';

beforeEach(() => {
  window.localStorage.clear();
  resetGenerationSettingsStoreForTests();
});

describe('memoryConfig', () => {
  const journalKey = 'ultragamestudio.memory.v1:memories/review-jobs.v1.json';
  const savedJournal = (): MemoryReviewJournal => ({ version: 1,
    scheduler: { consumed: [], attempted: [], lastCompleted: [] }, jobs: [{ id: 'job',
      source: { hostId: 'local', namespaceId: 'local', workspaceId: 'workspace', sessionId: 'session',
        turnId: 'turn', sourceMessageId: 'turn', runId: 'run' },
      phase: 'applied', appliedOps: 1, queuedOps: 0, updatedAt: 12 }] });

  it.each([undefined, 'a1', '  exact assistant ID  '])('preserves the exact optional assistant ID %s and legacy bytes', async assistantMessageId => {
    const value = savedJournal();
    if (assistantMessageId !== undefined) Object.assign(value.jobs[0], { assistantMessageId });
    const raw = `  ${JSON.stringify(value)}\n`;
    localStorage.setItem(journalKey, raw);
    expect(await loadMemoryReviewJournal()).toEqual({ raw, value });
    expect(localStorage.getItem(journalKey)).toBe(raw);
    await saveMemoryReviewJournal(raw, value);
    expect((await loadMemoryReviewJournal()).value).toEqual(value);
  });

  it.each([
    ['empty assistant ID', 'job', 'assistantMessageId', ''],
    ['null assistant ID', 'job', 'assistantMessageId', null],
    ['numeric assistant ID', 'job', 'assistantMessageId', 12],
    ['boolean assistant ID', 'job', 'assistantMessageId', false],
    ['array assistant ID', 'job', 'assistantMessageId', ['a1']],
    ['object assistant ID', 'job', 'assistantMessageId', { id: 'a1' }],
    ['unknown journal field', 'root', 'futureField', true],
    ['unknown scheduler field', 'scheduler', 'futureField', true],
    ['unknown job field', 'job', 'futureField', true],
    ['unknown source field', 'source', 'futureField', true],
    ['unknown usage field', 'usage', 'futureField', true],
  ])('rejects %s on read and write without repairing persisted bytes', async (_name, target, field, bad) => {
    const value = savedJournal();
    value.jobs[0].usage = { calls: 1, inputTokens: 2, estimated: true };
    const record = target === 'root' ? value : target === 'scheduler' ? value.scheduler :
      target === 'job' ? value.jobs[0] : target === 'source' ? value.jobs[0].source : value.jobs[0].usage;
    Object.assign(record, { [field as string]: bad });
    const raw = `  ${JSON.stringify(value)}\n`;
    localStorage.setItem(journalKey, raw);
    await expect(loadMemoryReviewJournal()).rejects.toThrow('MEMORY_REVIEW_JOURNAL_INVALID');
    await expect(saveMemoryReviewJournal(raw, savedJournal())).rejects.toThrow('MEMORY_REVIEW_JOURNAL_INVALID');
    expect(localStorage.getItem(journalKey)).toBe(raw);
    const validRaw = JSON.stringify(savedJournal());
    localStorage.setItem(journalKey, validRaw);
    await expect(saveMemoryReviewJournal(validRaw, value)).rejects.toThrow('MEMORY_REVIEW_JOURNAL_INVALID');
    expect(localStorage.getItem(journalKey)).toBe(validRaw);
  });

  it.each([
    ['consumed tuple', { scheduler: { consumed: [null], attempted: [], lastCompleted: [] } }],
    ['consumed IDs', { scheduler: { consumed: [['session', [null]]], attempted: [], lastCompleted: [] } }],
    ['attempted ID', { scheduler: { consumed: [], attempted: [42], lastCompleted: [] } }],
    ['duplicate attempted ID', { scheduler: { consumed: [], attempted: ['id', 'id'], lastCompleted: [] } }],
    ['completion timestamp', { scheduler: { consumed: [], attempted: [], lastCompleted: [['scope', -1]] } }],
    ['duplicate scope', { scheduler: { consumed: [], attempted: [], lastCompleted: [['scope', 0], ['scope', 1]] } }],
    ['oversized attempted IDs', { scheduler: { consumed: [], attempted: Array.from({ length: 257 }, (_, i) => String(i)), lastCompleted: [] } }],
    ['null job', { jobs: [null] }],
    ['empty job ID', { jobs: [{ id: '', source: { hostId: 'local', namespaceId: 'local', workspaceId: 'workspace', sessionId: 'session', turnId: 'turn', sourceMessageId: 'message', runId: 'run' }, phase: 'noop', appliedOps: 0, queuedOps: 0, updatedAt: 0 }] }],
    ['missing source', { jobs: [{ id: 'job', phase: 'noop', appliedOps: 0, queuedOps: 0, updatedAt: 0 }] }],
    ['malformed source', { jobs: [{ id: 'job', source: { hostId: 42 }, phase: 'noop', appliedOps: 0, queuedOps: 0, updatedAt: 0 }] }],
    ['unknown phase', { jobs: [{ id: 'job', source: { hostId: 'local', namespaceId: 'local', workspaceId: 'workspace', sessionId: 'session', turnId: 'turn', sourceMessageId: 'message', runId: 'run' }, phase: 'ready', appliedOps: 0, queuedOps: 0, updatedAt: 0 }] }],
    ['negative applied count', { jobs: [{ id: 'job', source: { hostId: 'local', namespaceId: 'local', workspaceId: 'workspace', sessionId: 'session', turnId: 'turn', sourceMessageId: 'message', runId: 'run' }, phase: 'applied', appliedOps: -1, queuedOps: 0, updatedAt: 0 }] }],
    ['malformed usage', { jobs: [{ id: 'job', source: { hostId: 'local', namespaceId: 'local', workspaceId: 'workspace', sessionId: 'session', turnId: 'turn', sourceMessageId: 'message', runId: 'run' }, phase: 'noop', appliedOps: 0, queuedOps: 0, updatedAt: 0, usage: { calls: 1, inputTokens: 1, outputTokens: -1, estimated: 'yes' } }] }],
  ])('rejects malformed journal %s without replacing its bytes', async (_name, changes) => {
    const key = 'ultragamestudio.memory.v1:memories/review-jobs.v1.json';
    const raw = JSON.stringify({ version: 1, scheduler: { consumed: [], attempted: [], lastCompleted: [] }, jobs: [], ...changes });
    localStorage.setItem(key, raw);
    await expect(loadMemoryReviewJournal()).rejects.toThrow('MEMORY_REVIEW_JOURNAL_INVALID');
    expect(localStorage.getItem(key)).toBe(raw);
  });
  it('rejects a truncated replay fence rather than reopening previously consumed evidence', async () => {
    localStorage.setItem('ultragamestudio.memory.v1:memories/review-jobs.v1.json', JSON.stringify({
      version: 1, scheduler: { consumed: [], attempted: [], lastCompleted: [], consumedFence: [0], attemptedFence: [0] }, jobs: [],
    }));
    await expect(loadMemoryReviewJournal()).rejects.toThrow('MEMORY_REVIEW_JOURNAL_INVALID');
  });
  it('returns defaults when nothing is stored', () => {
    expect(loadMemoryConfig()).toEqual(DEFAULT_MEMORY_CONFIG);
  });

  it('round-trips a saved config', () => {
    saveMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, reviewEnabled: true, memoryCharLimit: 3000 });
    const loaded = loadMemoryConfig();
    expect(loaded.reviewEnabled).toBe(true);
    expect(loaded.memoryCharLimit).toBe(3000);
  });

  it('clamps out-of-range values', () => {
    saveMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, memoryCharLimit: 5, reviewMinMessages: 9999 });
    const loaded = loadMemoryConfig();
    expect(loaded.memoryCharLimit).toBe(200);
    expect(loaded.reviewMinMessages).toBe(100);
  });

  it('syncs char limits into memoryStore on load', () => {
    saveMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, memoryCharLimit: 1500, userCharLimit: 900 });
    loadMemoryConfig();
    expect(getMemoryLimits()).toEqual({ memory: 1500, user: 900 });
  });

  it('round-trips eviction + nudge settings', () => {
    saveMemoryConfig({
      ...DEFAULT_MEMORY_CONFIG,
      evictOnOverflow: true,
      nudgeThresholdPct: 70,
      compactSnapshotCharLimit: 1000,
    });
    const loaded = loadMemoryConfig();
    expect(loaded.evictOnOverflow).toBe(true);
    expect(loaded.nudgeThresholdPct).toBe(70);
    expect(loaded.compactSnapshotCharLimit).toBe(1000);
  });

  it('clamps nudge threshold and compact snapshot limit', () => {
    saveMemoryConfig({
      ...DEFAULT_MEMORY_CONFIG,
      nudgeThresholdPct: 5, // below 50
      compactSnapshotCharLimit: 50, // below 200
    });
    const loaded = loadMemoryConfig();
    expect(loaded.nudgeThresholdPct).toBe(50);
    expect(loaded.compactSnapshotCharLimit).toBe(200);
  });

  it('syncs nudge threshold into memoryStore', () => {
    saveMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, nudgeThresholdPct: 60 });
    loadMemoryConfig();
    expect(getMemoryNudgeThresholdPct()).toBe(60);
  });
});

describe('review timestamp', () => {
  it('defaults to 0 and records per workspace', () => {
    expect(getLastReviewAt('ws-a')).toBe(0);
    setLastReviewAt('ws-a', 12345);
    expect(getLastReviewAt('ws-a')).toBe(12345);
    expect(getLastReviewAt('ws-b')).toBe(0);
  });
});
