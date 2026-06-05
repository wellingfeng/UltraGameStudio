import type {
  ComposerSettings,
  PromptGroup,
  SessionComposerSettings,
} from '@/store/types';
import {
  defaultPersonalInstructionsByModel,
  ensureRequiredPersonalInstructions,
  personalInstructionsKey,
  type PersonalInstructionsByModel,
} from '@/core/personalInstructions';
import type { GatewaySelection } from '@/core/ir';
import { isLocale, systemLocale, type Locale } from '@/lib/i18n';
import { uniqueWorkspaceHistory } from '@/lib/workspaceHistory';

/**
 * localStorage persistence for AI-input composer state, the AIDock height, and
 * the user-editable prompt library. All access is guarded so it is safe in
 * non-browser contexts and never throws.
 */

const COMPOSER_KEY = 'freeultracode.composer.v1';
const DOCK_HEIGHT_KEY = 'freeultracode.dockHeight.v1';
const PROMPT_GROUPS_KEY = 'freeultracode.promptGroups.v1';
const LOCALE_KEY = 'freeultracode.locale.v1';
const PROMPT_AUTO_TRANSLATE_KEY = 'freeultracode.promptAutoTranslate.v1';
const PERSONAL_INSTRUCTIONS_KEY = 'freeultracode.personalInstructions.v1';
const PERSONAL_INSTRUCTIONS_BY_MODEL_KEY =
  'freeultracode.personalInstructionsByModel.v1';
/** Tracks which PROMPT_DEFAULTS_VERSION the persisted library was migrated to. */
const PROMPT_GROUPS_VERSION_KEY = 'freeultracode.promptGroups.version.v1';

export interface PersistedComposer {
  composer: ComposerSettings;
  composerBySession?: Record<string, SessionComposerSettings>;
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
      composerBySession:
        parsed.composerBySession &&
        typeof parsed.composerBySession === 'object' &&
        !Array.isArray(parsed.composerBySession)
          ? (parsed.composerBySession as Record<string, SessionComposerSettings>)
          : {},
      workspaceHistory: Array.isArray(parsed.workspaceHistory)
        ? uniqueWorkspaceHistory(parsed.workspaceHistory)
        : [],
    };
  } catch {
    return null;
  }
}

export function saveComposer(state: PersistedComposer): void {
  if (!hasStorage()) return;
  try {
    const previous = loadComposer();
    window.localStorage.setItem(
      COMPOSER_KEY,
      JSON.stringify({
        ...state,
        workspaceHistory: uniqueWorkspaceHistory(state.workspaceHistory),
        composerBySession:
          state.composerBySession ?? previous?.composerBySession ?? {},
      }),
    );
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

export function loadLocale(): Locale {
  if (!hasStorage()) return systemLocale();
  try {
    const raw = window.localStorage.getItem(LOCALE_KEY);
    return isLocale(raw) ? raw : systemLocale();
  } catch {
    return systemLocale();
  }
}

export function saveLocale(locale: Locale): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.setItem(LOCALE_KEY, locale);
  } catch {
    // non-fatal
  }
}

export function loadPromptAutoTranslate(): boolean {
  if (!hasStorage()) return true;
  try {
    const raw = window.localStorage.getItem(PROMPT_AUTO_TRANSLATE_KEY);
    if (raw == null) return true;
    return raw === 'true';
  } catch {
    return true;
  }
}

export function savePromptAutoTranslate(enabled: boolean): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.setItem(PROMPT_AUTO_TRANSLATE_KEY, String(enabled));
  } catch {
    // non-fatal
  }
}

export function loadPersonalInstructions(): string {
  if (!hasStorage()) return '';
  try {
    return window.localStorage.getItem(PERSONAL_INSTRUCTIONS_KEY) ?? '';
  } catch {
    return '';
  }
}

export function savePersonalInstructions(instructions: string): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.setItem(PERSONAL_INSTRUCTIONS_KEY, instructions);
  } catch {
    // non-fatal
  }
}

function normalizePersonalInstructionsByModel(
  value: unknown,
): PersonalInstructionsByModel | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const out: PersonalInstructionsByModel = {};
  for (const [key, instructions] of Object.entries(value)) {
    if (typeof key !== 'string' || !key) continue;
    if (typeof instructions !== 'string') continue;
    out[key] = ensureRequiredPersonalInstructions(instructions);
  }
  return out;
}

export function loadPersonalInstructionsByModel(
  legacySelection?: Partial<GatewaySelection> | null,
  defaultSelections: ReadonlyArray<Partial<GatewaySelection> | null | undefined> = [],
): PersonalInstructionsByModel {
  if (!hasStorage()) return {};
  try {
    const raw = window.localStorage.getItem(PERSONAL_INSTRUCTIONS_BY_MODEL_KEY);
    if (raw !== null) {
      const parsed = normalizePersonalInstructionsByModel(JSON.parse(raw));
      if (parsed) return parsed;
    }
  } catch {
    // Fall through to the legacy single-value migration.
  }

  const defaults = defaultPersonalInstructionsByModel([
    legacySelection,
    ...defaultSelections,
  ]);
  const legacy = loadPersonalInstructions();
  const seeded = legacy
    ? {
        ...defaults,
        [personalInstructionsKey(legacySelection)]:
          ensureRequiredPersonalInstructions(legacy),
      }
    : defaults;
  if (Object.keys(seeded).length > 0) savePersonalInstructionsByModel(seeded);
  return seeded;
}

export function savePersonalInstructionsByModel(
  byModel: PersonalInstructionsByModel,
): void {
  if (!hasStorage()) return;
  try {
    const normalized = normalizePersonalInstructionsByModel(byModel) ?? {};
    window.localStorage.setItem(
      PERSONAL_INSTRUCTIONS_BY_MODEL_KEY,
      JSON.stringify(normalized),
    );
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
