import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_APPEARANCE_SETTINGS,
  DEFAULT_FONT_FAMILY_ID,
  DEFAULT_FONT_SIZE_PX,
} from './appearance';

const disk = new Map<string, string>();
const invoke = vi.fn(async (cmd: string, args: Record<string, unknown>) => {
  if (cmd === 'history_read_json') {
    return disk.get(args.relPath as string) ?? null;
  }
  if (cmd === 'history_write_json') {
    disk.set(args.relPath as string, args.json as string);
    return undefined;
  }
  return null;
});

vi.mock('@/lib/tauri', () => ({
  isTauri: () => true,
  tauriAvailable: () => true,
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

async function flushWrites(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('appearanceStorage', () => {
  beforeEach(async () => {
    window.localStorage.clear();
    disk.clear();
    invoke.mockClear();
    const store = await import('@/lib/generationSettingsStore');
    store.resetGenerationSettingsStoreForTests();
    await store.initializeGenerationSettingsStore();
  });

  afterEach(async () => {
    window.localStorage.clear();
    disk.clear();
    const store = await import('@/lib/generationSettingsStore');
    store.resetGenerationSettingsStoreForTests();
  });

  it('defaults to black style when no stored appearance exists', async () => {
    const { loadAppearance } = await import('./appearanceStorage');
    expect(loadAppearance()).toEqual(DEFAULT_APPEARANCE_SETTINGS);
    expect(loadAppearance().stylePresetId).toBe('hermes-dark');
  });

  it.each(['cherry-dark', 'cherry-light', 'hermes-dark'] as const)('persists %s to the disk-backed global settings file', async (stylePresetId) => {
    const { loadAppearance, saveAppearance, APPEARANCE_STORAGE_KEY } =
      await import('./appearanceStorage');

    saveAppearance({
      stylePresetId,
      streamSchemeId: 'current',
      fontFamilyId: 'cjk',
      fontSizePx: 18,
    });
    await flushWrites();

    expect(JSON.parse(disk.get('settings/appearance.v1.json') ?? '{}')).toEqual({
      stylePresetId,
      streamSchemeId: 'current',
      fontFamilyId: 'cjk',
      fontSizePx: 18,
    });
    expect(window.localStorage.getItem(APPEARANCE_STORAGE_KEY)).toContain(
      stylePresetId,
    );

    window.localStorage.clear();
    const store = await import('@/lib/generationSettingsStore');
    store.resetGenerationSettingsStoreForTests();
    await store.initializeGenerationSettingsStore();

    expect(loadAppearance().stylePresetId).toBe(stylePresetId);
    expect(window.localStorage.getItem(APPEARANCE_STORAGE_KEY)).toContain(
      stylePresetId,
    );
  });

  it('migrates the pre-rebrand appearance key into the global settings file', async () => {
    const { loadAppearance, APPEARANCE_STORAGE_KEY } =
      await import('./appearanceStorage');

    window.localStorage.setItem(
      'freeultracode.appearance.v1',
      JSON.stringify({
        stylePresetId: 'daylight',
        streamSchemeId: 'current',
        fontFamilyId: 'system',
        fontSizePx: 17,
      }),
    );

    expect(loadAppearance()).toEqual({
      stylePresetId: 'daylight',
      streamSchemeId: 'current',
      fontFamilyId: 'system',
      fontSizePx: 17,
    });
    await flushWrites();

    expect(window.localStorage.getItem(APPEARANCE_STORAGE_KEY)).toContain(
      'daylight',
    );
    expect(disk.get('settings/appearance.v1.json')).toContain('daylight');
  });

  it('falls back to the normalized default for malformed data', async () => {
    const { loadAppearance } = await import('./appearanceStorage');

    window.localStorage.setItem('ultragamestudio.appearance.v1', '{bad json');

    expect(loadAppearance()).toEqual({
      stylePresetId: 'hermes-dark',
      streamSchemeId: 'current',
      fontFamilyId: DEFAULT_FONT_FAMILY_ID,
      fontSizePx: DEFAULT_FONT_SIZE_PX,
    });
  });
});
