import type { ComposerSettings, PromptGroup } from '@/store/types';

/**
 * localStorage persistence for AI-input composer state, the AIDock height, and
 * the user-editable prompt library. All access is guarded so it is safe in
 * non-browser contexts and never throws.
 */

const COMPOSER_KEY = 'openworkflow.composer.v1';
const DOCK_HEIGHT_KEY = 'openworkflow.dockHeight.v1';
const PROMPT_GROUPS_KEY = 'openworkflow.promptGroups.v1';
/** Tracks which PROMPT_DEFAULTS_VERSION the persisted library was migrated to. */
const PROMPT_GROUPS_VERSION_KEY = 'openworkflow.promptGroups.version.v1';

export interface PersistedComposer {
  composer: ComposerSettings;
  workspaceHistory: string[];
}

function hasStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage;
}

export function loadComposer(): PersistedComposer | null {
  if (!hasStorage()) return null;
  try {
    const raw = window.localStorage.getItem(COMPOSER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedComposer>;
    if (!parsed.composer) return null;
    return {
      composer: parsed.composer,
      workspaceHistory: Array.isArray(parsed.workspaceHistory)
        ? parsed.workspaceHistory
        : [],
    };
  } catch {
    return null;
  }
}

export function saveComposer(state: PersistedComposer): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.setItem(COMPOSER_KEY, JSON.stringify(state));
  } catch {
    // Quota / serialization errors are non-fatal.
  }
}

export function loadDockHeight(): number | null {
  if (!hasStorage()) return null;
  try {
    const raw = window.localStorage.getItem(DOCK_HEIGHT_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function saveDockHeight(height: number): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.setItem(DOCK_HEIGHT_KEY, String(Math.round(height)));
  } catch {
    // non-fatal
  }
}

/**
 * Load the user-edited prompt library. Returns null on any failure (missing,
 * unparseable, or structurally invalid) so callers can fall back to defaults.
 * A valid payload is an array of `{ id, label, items: PromptItem[] }`.
 */
export function loadPromptGroups(): PromptGroup[] | null {
  if (!hasStorage()) return null;
  try {
    const raw = window.localStorage.getItem(PROMPT_GROUPS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const valid = parsed.every(
      (g) =>
        g != null &&
        typeof (g as PromptGroup).id === 'string' &&
        typeof (g as PromptGroup).label === 'string' &&
        Array.isArray((g as PromptGroup).items) &&
        (g as PromptGroup).items.every(
          (it) =>
            it != null &&
            typeof it.id === 'string' &&
            typeof it.label === 'string' &&
            typeof it.text === 'string',
        ),
    );
    return valid ? (parsed as PromptGroup[]) : null;
  } catch {
    return null;
  }
}

/** Persist the prompt library. Errors are non-fatal. */
export function savePromptGroups(groups: PromptGroup[]): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.setItem(PROMPT_GROUPS_KEY, JSON.stringify(groups));
  } catch {
    // Quota / serialization errors are non-fatal.
  }
}

/**
 * The defaults version the persisted library was last migrated to (0 if never).
 * Used to merge newly-shipped default groups exactly once per version bump.
 */
export function loadPromptGroupsVersion(): number {
  if (!hasStorage()) return 0;
  try {
    const raw = window.localStorage.getItem(PROMPT_GROUPS_VERSION_KEY);
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/** Record the defaults version the persisted library has been migrated to. */
export function savePromptGroupsVersion(version: number): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.setItem(PROMPT_GROUPS_VERSION_KEY, String(version));
  } catch {
    // non-fatal
  }
}

/** Read a persisted pane width (px) for an arbitrary key; null when unset. */
export function loadPaneWidth(key: string): number | null {
  if (!hasStorage()) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Persist a pane width (px) under an arbitrary key. */
export function savePaneWidth(key: string, width: number): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.setItem(key, String(Math.round(width)));
  } catch {
    // non-fatal
  }
}
