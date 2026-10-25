import type { SkillLearningConfig } from '@/runtime/skills/types';

export type { SkillLearningConfig } from '@/runtime/skills/types';

export const DEFAULT_SKILL_LEARNING_CONFIG: SkillLearningConfig = {
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
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function normalizeReviewSelection(value: unknown): SkillLearningConfig['reviewSelection'] {
  if (!isRecord(value)) return undefined;
  if (typeof value.adapter !== 'string' || !value.adapter.trim()
    || typeof value.modelClass !== 'string' || !value.modelClass.trim()) return undefined;
  return {
    adapter: value.adapter,
    modelClass: value.modelClass,
    ...(typeof value.providerId === 'string' && value.providerId.trim()
      ? { providerId: value.providerId } : {}),
    ...(typeof value.channelId === 'string' && value.channelId.trim()
      ? { channelId: value.channelId } : {}),
    ...(typeof value.model === 'string' && value.model.trim()
      ? { model: value.model } : {}),
  };
}

/** Whitelist configuration fields; credentials and arbitrary provider settings never persist here. */
export function normalizeSkillLearningConfig(
  value: unknown,
  base: SkillLearningConfig = DEFAULT_SKILL_LEARNING_CONFIG,
): SkillLearningConfig {
  const raw = isRecord(value) ? value : {};
  const staleAfterDays = boundedInteger(raw.staleAfterDays, base.staleAfterDays, 1, 3650);
  const reviewSelection = normalizeReviewSelection(
    Object.prototype.hasOwnProperty.call(raw, 'reviewSelection') ? raw.reviewSelection : base.reviewSelection,
  );
  const transport = Object.prototype.hasOwnProperty.call(raw, 'reviewTransport') ? raw.reviewTransport : base.reviewTransport;
  const reviewTransport = transport === 'anthropic' || transport === 'openai-compatible' ? transport : undefined;
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : base.enabled,
    mode: raw.mode === 'auto-safe' || raw.mode === 'approve-all' || raw.mode === 'off'
      ? raw.mode
      : base.mode,
    activityThreshold: boundedInteger(raw.activityThreshold, base.activityThreshold, 1, 1000),
    cooldownMs: boundedInteger(raw.cooldownMs, base.cooldownMs, 0, 86400000),
    maxRounds: boundedInteger(raw.maxRounds, base.maxRounds, 1, 16),
    maxInputTokens: boundedInteger(raw.maxInputTokens, base.maxInputTokens, 1000, 1000000),
    maxOutputTokens: boundedInteger(raw.maxOutputTokens, base.maxOutputTokens, 100, 100000),
    timeoutMs: boundedInteger(raw.timeoutMs === 90000 ? 600000 : raw.timeoutMs, base.timeoutMs, 1000, 600000),
    autoArchive: typeof raw.autoArchive === 'boolean' ? raw.autoArchive : base.autoArchive,
    staleAfterDays,
    archiveAfterDays: Math.max(
      staleAfterDays,
      boundedInteger(raw.archiveAfterDays, base.archiveAfterDays, 1, 3650),
    ),
    ...(reviewTransport ? { reviewTransport } : {}),
    ...(reviewSelection ? { reviewSelection } : {}),
  };
}

const STORAGE_KEY = 'ultragamestudio.skillLearningConfig.v1';

function readConfig(key: string): unknown {
  try {
    if (typeof window === 'undefined') return undefined;
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) as unknown : undefined;
  } catch {
    return undefined;
  }
}

/** Project keys retain the exact workspace identity, including delimiters. */
function storageKey(workspaceId?: string): string {
  return workspaceId ? `${STORAGE_KEY}.workspace.${encodeURIComponent(workspaceId)}` : STORAGE_KEY;
}

/** Missing project fields inherit global values; a project save does not change the global config. */
export function loadSkillLearningConfig(workspaceId?: string): SkillLearningConfig {
  const global = normalizeSkillLearningConfig(readConfig(STORAGE_KEY));
  return workspaceId ? normalizeSkillLearningConfig(readConfig(storageKey(workspaceId)), global) : global;
}

/** Returns only persisted, normalized data. Storage failures propagate to the settings owner. */
export function saveSkillLearningConfig(config: SkillLearningConfig, workspaceId?: string): SkillLearningConfig {
  const next = normalizeSkillLearningConfig(config);
  // JSON omits undefined fields; null distinguishes source-session selection
  // from an absent legacy override that should inherit the global choice.
  const stored = workspaceId ? { ...next,
    ...(next.reviewSelection === undefined ? { reviewSelection: null } : {}),
    ...(next.reviewTransport === undefined ? { reviewTransport: null } : {}),
  } : next;
  window.localStorage.setItem(storageKey(workspaceId), JSON.stringify(stored));
  window.dispatchEvent(new CustomEvent(SKILL_LEARNING_CONFIG_CHANGED_EVENT, {
    detail: { workspaceId: workspaceId || undefined },
  }));
  return next;
}

export const SKILL_LEARNING_CONFIG_CHANGED_EVENT = 'ugs:skill-learning-config-changed';

/** Subscribe to effective values for a single scope. Global changes also invalidate project inheritance. */
export function onSkillLearningConfigChanged(
  callback: (config: SkillLearningConfig, workspaceId?: string) => void,
  workspaceId?: string,
): () => void {
  const listener = (event: Event) => {
    const changedWorkspaceId = (event as CustomEvent<{ workspaceId?: string }>).detail?.workspaceId;
    if (changedWorkspaceId && changedWorkspaceId !== workspaceId) return;
    callback(loadSkillLearningConfig(workspaceId), workspaceId);
  };
  const storageListener = (event: StorageEvent) => {
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    if (event.key !== null && event.key !== STORAGE_KEY && event.key !== storageKey(workspaceId)) return;
    callback(loadSkillLearningConfig(workspaceId), workspaceId);
  };
  window.addEventListener(SKILL_LEARNING_CONFIG_CHANGED_EVENT, listener);
  window.addEventListener('storage', storageListener);
  return () => {
    window.removeEventListener(SKILL_LEARNING_CONFIG_CHANGED_EVENT, listener);
    window.removeEventListener('storage', storageListener);
  };
}
