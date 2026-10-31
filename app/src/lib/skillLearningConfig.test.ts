import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SkillLearningConfig } from '@/runtime/skills/types';
import * as learningConfig from './skillLearningConfig';

const configModule = learningConfig;

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('skill learning configuration', () => {
  it('keeps every background write approval-gated regardless of explicit-command preference', () => {
    for (const mode of ['auto-safe', 'approve-all', 'off'] as const) {
      expect(learningConfig.getBackgroundSkillWriteMode({ ...learningConfig.DEFAULT_SKILL_LEARNING_CONFIG, mode })).toBe('approve-all');
    }
  });
  it('migrates the legacy timeout while preserving custom limits', () => {
    expect(configModule.normalizeSkillLearningConfig({ timeoutMs: 90000 }).timeoutMs).toBe(600000);
    expect(configModule.normalizeSkillLearningConfig({ timeoutMs: 120000 }).timeoutMs).toBe(120000);
  });

  it('defaults to enabled auto-safe learning with bounded review and opt-in archiving', () => {
    expect(configModule?.DEFAULT_SKILL_LEARNING_CONFIG).toEqual({
      enabled: true,
      mode: 'auto-safe',
      activityThreshold: 10,
      cooldownMs: 60000,
      maxRounds: 6,
      maxInputTokens: 48000,
      maxOutputTokens: 6000,
      timeoutMs: 600000,
      autoArchive: false,
      staleAfterDays: 30,
      archiveAfterDays: 90,
    });
  });

  it('normalizes malformed persisted values without enabling opt-in policies', () => {
    const normalized = configModule?.normalizeSkillLearningConfig?.({
      enabled: 'false',
      mode: 'unsafe',
      activityThreshold: -5,
      cooldownMs: NaN,
      maxRounds: 10000,
      maxInputTokens: Infinity,
      maxOutputTokens: '6000',
      timeoutMs: 0,
      autoArchive: 'true',
      staleAfterDays: 0,
      archiveAfterDays: -1,
      apiKey: 'not-a-real-secret',
    });
    expect(normalized).toEqual({
      enabled: true,
      mode: 'auto-safe',
      activityThreshold: 1,
      cooldownMs: 60000,
      maxRounds: 16,
      maxInputTokens: 48000,
      maxOutputTokens: 6000,
      timeoutMs: 1000,
      autoArchive: false,
      staleAfterDays: 1,
      archiveAfterDays: 1,
    });
  });

  it('preserves the three write modes without losing enabled preference', () => {
    for (const mode of ['auto-safe', 'approve-all', 'off'] as const) {
      expect(configModule?.normalizeSkillLearningConfig?.({ enabled: false, mode }))
        .toMatchObject({ enabled: false, mode });
    }
  });

  it('keeps an independent model selection while stripping credentials and unknown fields', () => {
    expect(configModule?.normalizeSkillLearningConfig?.({
      reviewSelection: {
        adapter: 'codex', modelClass: 'default', providerId: 'provider-a',
        channelId: 'channel-b', model: 'review-model-v1',
        apiKey: 'fixture-secret', baseUrl: 'http://fixture.invalid', permission: 'full',
      },
    })?.reviewSelection).toEqual({
      adapter: 'codex', modelClass: 'default', providerId: 'provider-a',
      channelId: 'channel-b', model: 'review-model-v1',
    });
  });

  it('persists an explicit reviewer HTTP protocol independently of the source execution transport', () => {
    const configured = { ...configModule.DEFAULT_SKILL_LEARNING_CONFIG, reviewTransport: 'openai-compatible' as const };
    expect(configModule.saveSkillLearningConfig(configured)).toEqual(configured);
    expect(configModule.loadSkillLearningConfig().reviewTransport).toBe('openai-compatible');
    expect(configModule.loadSkillLearningConfig('inherited-project').reviewTransport).toBe('openai-compatible');
    configModule.saveSkillLearningConfig({ ...configModule.DEFAULT_SKILL_LEARNING_CONFIG }, 'channel-http-project');
    expect(configModule.loadSkillLearningConfig('channel-http-project').reviewTransport).toBeUndefined();
    expect(configModule.normalizeSkillLearningConfig({ reviewTransport: 'cli' }).reviewTransport).toBeUndefined();
    expect(configModule.normalizeSkillLearningConfig({ reviewTransport: 'simulator' }).reviewTransport).toBeUndefined();
  });

  it('roundtrips global settings in its own localStorage key', () => {
    const expected = { ...configModule!.DEFAULT_SKILL_LEARNING_CONFIG!, mode: 'approve-all' as const };
    const saved = configModule?.saveSkillLearningConfig?.(expected);
    expect(saved).toEqual(expected);
    expect(configModule?.loadSkillLearningConfig?.()).toEqual(expected);
    expect(JSON.parse(window.localStorage.getItem('ultragamestudio.skillLearningConfig.v1')!))
      .toEqual(expected);
  });

  it('scopes project overrides without modifying global or other project settings', () => {
    const defaults = configModule!.DEFAULT_SKILL_LEARNING_CONFIG!;
    configModule?.saveSkillLearningConfig?.({ ...defaults, activityThreshold: 15 });
    configModule?.saveSkillLearningConfig?.({ ...defaults, mode: 'off' }, 'ws-a');
    expect(configModule?.loadSkillLearningConfig?.('ws-a')).toMatchObject({ mode: 'off' });
    expect(configModule?.loadSkillLearningConfig?.('ws-b')).toMatchObject({
      mode: 'auto-safe', activityThreshold: 15,
    });
    expect(configModule?.loadSkillLearningConfig?.()).toMatchObject({
      mode: 'auto-safe', activityThreshold: 15,
    });
  });

  it('keeps an explicit project source-session model instead of reviving the global independent selection', () => {
    const defaults = configModule.DEFAULT_SKILL_LEARNING_CONFIG;
    const reviewSelection = { adapter: 'codex', modelClass: 'default', providerId: 'global-provider', model: 'global-review' };
    configModule.saveSkillLearningConfig({ ...defaults, reviewSelection });
    configModule.saveSkillLearningConfig({ ...defaults }, 'ws-source-model');
    expect(configModule.loadSkillLearningConfig('ws-source-model').reviewSelection).toBeUndefined();
    expect(configModule.loadSkillLearningConfig('ws-other').reviewSelection).toEqual(reviewSelection);
    expect(configModule.loadSkillLearningConfig().reviewSelection).toEqual(reviewSelection);
  });

  it('notifies only the affected scope after persistence and unsubscribes', () => {
    const seen: Array<{ config: SkillLearningConfig; workspaceId?: string }> = [];
    const unsubscribe = configModule?.onSkillLearningConfigChanged?.((config, workspaceId) => {
      seen.push({ config, workspaceId });
    }, 'ws-a');
    const config = { ...configModule!.DEFAULT_SKILL_LEARNING_CONFIG!, mode: 'off' as const };
    configModule?.saveSkillLearningConfig?.(config, 'ws-b');
    expect(seen).toEqual([]);
    configModule?.saveSkillLearningConfig?.(config, 'ws-a');
    expect(seen).toEqual([{ config, workspaceId: 'ws-a' }]);
    unsubscribe?.();
    configModule?.saveSkillLearningConfig?.({ ...config, mode: 'auto-safe' }, 'ws-a');
    expect(seen).toHaveLength(1);
  });

  it('reloads project inheritance on a cross-window storage change', () => {
    const received: SkillLearningConfig[] = [];
    const unsubscribe = configModule?.onSkillLearningConfigChanged?.((config) => received.push(config), 'ws-a');
    window.localStorage.setItem('ultragamestudio.skillLearningConfig.v1', JSON.stringify({ activityThreshold: 22 }));
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'ultragamestudio.skillLearningConfig.v1', storageArea: window.localStorage,
    }));
    expect(received).toEqual([{
      ...configModule!.DEFAULT_SKILL_LEARNING_CONFIG!, activityThreshold: 22,
    }]);
    unsubscribe?.();
  });

  it('falls back to defaults for corrupted global storage', () => {
    window.localStorage.setItem('ultragamestudio.skillLearningConfig.v1', '{');
    expect(configModule?.loadSkillLearningConfig?.()).toEqual(configModule!.DEFAULT_SKILL_LEARNING_CONFIG);
  });

  it('inherits missing fields in a legacy partial project override', () => {
    configModule?.saveSkillLearningConfig?.({ ...configModule!.DEFAULT_SKILL_LEARNING_CONFIG!, activityThreshold: 25 });
    window.localStorage.setItem('ultragamestudio.skillLearningConfig.v1.workspace.ws-a', JSON.stringify({ mode: 'approve-all' }));
    expect(configModule?.loadSkillLearningConfig?.('ws-a')).toMatchObject({ mode: 'approve-all', activityThreshold: 25 });
  });

  it('does not announce a change when a storage write fails', () => {
    const seen = vi.fn();
    const unsubscribe = configModule?.onSkillLearningConfigChanged?.(seen);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage full'); });
    expect(() => configModule?.saveSkillLearningConfig?.(configModule!.DEFAULT_SKILL_LEARNING_CONFIG!))
      .toThrow('storage full');
    expect(seen).not.toHaveBeenCalled();
    unsubscribe?.();
  });
});
