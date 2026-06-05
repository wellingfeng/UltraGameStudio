import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_FONT_FAMILIES,
  BUILTIN_STREAM_SCHEMES,
  BUILTIN_STYLE_PRESETS,
  DEFAULT_APPEARANCE_SETTINGS,
  DEFAULT_FONT_FAMILY_ID,
  DEFAULT_FONT_SIZE_PX,
  DEFAULT_STREAM_SCHEME_ID,
  DEFAULT_STYLE_PRESET_ID,
  FONT_FAMILY_LIST,
  FONT_SIZE_LIMITS,
  STREAM_SCHEME_LIST,
  STYLE_PRESET_LIST,
  TERMINAL_STYLE_PRESET_IDS,
  applyAppearance,
  isUnsupportedStreamScheme,
  isUnsupportedStylePreset,
  normalizeAppearanceSettings,
  resolveFontFamilyId,
  resolveFontSizePx,
  resolveStreamSchemeId,
  resolveStylePresetId,
  streamSchemeForStylePresetId,
} from './appearance';
import { SUPPORTED_LOCALES, t } from './i18n';

const NEW_PRESETS = [
  'midnight',
  'aurora',
  'daylight',
  'ember',
  'campbell',
  'campbell-powershell',
  'one-half-dark',
  'solarized-dark',
] as const;
const NEW_STREAM_SCHEMES = [
  'campbell',
  'campbell-powershell',
  'one-half-dark',
  'solarized-dark',
] as const;

// Vitest runs with cwd at the app/ root.
const globalCss = readFileSync('src/styles/global.css', 'utf8');

// The full primitive-token contract each preset CSS block must define.
const REQUIRED_TOKENS = [
  '--fuc-color-bg',
  '--fuc-color-bg-alt',
  '--fuc-color-panel',
  '--fuc-color-panel-2',
  '--fuc-color-border',
  '--fuc-color-border-soft',
  '--fuc-color-text',
  '--fuc-color-text-muted',
  '--fuc-color-text-faint',
  '--fuc-color-accent',
  '--fuc-color-accent-2',
  '--fuc-color-accent-3',
  '--fuc-color-accent-4',
  '--fuc-status-ai-edit',
  '--fuc-status-ai-edit-contrast',
  '--fuc-status-running',
  '--fuc-status-running-contrast',
  '--fuc-status-success',
  '--fuc-status-success-contrast',
  '--fuc-status-error',
  '--fuc-status-error-contrast',
  '--fuc-status-interrupted',
  '--fuc-status-interrupted-contrast',
] as const;

/** Extract the body of `html.fuc-style-<id> { ... }` from global.css. */
function presetCssBlock(id: string): string {
  const marker = `html.fuc-style-${id} {`;
  const start = globalCss.indexOf(marker);
  if (start === -1) return '';
  const open = globalCss.indexOf('{', start);
  const close = globalCss.indexOf('}', open);
  return globalCss.slice(open + 1, close);
}

/** Extract the body of `html.fuc-stream-scheme-<id> { ... }` from global.css. */
function streamCssBlock(id: string): string {
  const marker = `html.fuc-stream-scheme-${id} {`;
  const start = globalCss.indexOf(marker);
  if (start === -1) return '';
  const open = globalCss.indexOf('{', start);
  const close = globalCss.indexOf('}', open);
  return globalCss.slice(open + 1, close);
}

afterEach(() => {
  const root = document.documentElement;
  root.className = '';
  root.removeAttribute('style');
  delete root.dataset.fucStyle;
  delete root.dataset.fucStreamScheme;
  delete root.dataset.fucFontFamily;
  delete root.dataset.fucFontSize;
});

describe('appearance presets', () => {
  it('registers Pencil plus the built-in unified style presets', () => {
    expect(BUILTIN_STYLE_PRESETS).toEqual([
      'pencil',
      'midnight',
      'aurora',
      'daylight',
      'ember',
      'campbell',
      'campbell-powershell',
      'one-half-dark',
      'solarized-dark',
    ]);
    expect(STYLE_PRESET_LIST).toHaveLength(9);
  });

  it('keeps the legacy stream scheme registry for migration', () => {
    expect(BUILTIN_STREAM_SCHEMES).toEqual([
      'current',
      'campbell',
      'campbell-powershell',
      'one-half-dark',
      'solarized-dark',
    ]);
    expect(STREAM_SCHEME_LIST).toHaveLength(5);
    expect(TERMINAL_STYLE_PRESET_IDS).toEqual([
      'campbell',
      'campbell-powershell',
      'one-half-dark',
      'solarized-dark',
    ]);
  });

  it('registers the built-in interface font families', () => {
    expect(BUILTIN_FONT_FAMILIES).toEqual([
      'inter',
      'system',
      'cjk',
      'serif',
      'mono',
    ]);
    expect(FONT_FAMILY_LIST).toHaveLength(5);
  });

  it('each preset has five hex swatches and matching id', () => {
    for (const preset of STYLE_PRESET_LIST) {
      expect(preset.swatches).toHaveLength(5);
      for (const swatch of preset.swatches) {
        expect(swatch).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
      expect(preset.id).toBe(preset.id);
    }
  });

  it('each stream scheme has five hex swatches and matching id', () => {
    for (const scheme of STREAM_SCHEME_LIST) {
      expect(scheme.swatches).toHaveLength(5);
      for (const swatch of scheme.swatches) {
        expect(swatch).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
      expect(scheme.id).toBe(scheme.id);
    }
  });

  it('each font family has a concrete CSS family stack', () => {
    for (const font of FONT_FAMILY_LIST) {
      expect(font.cssFamily.length).toBeGreaterThan(0);
      expect(font.cssFamily).toMatch(/serif|system-ui|monospace|Inter|Microsoft/u);
    }
  });

  it('daylight is the light scheme; the rest are dark', () => {
    const byId = Object.fromEntries(
      STYLE_PRESET_LIST.map((p) => [p.id, p.colorScheme]),
    );
    expect(byId.daylight).toBe('light');
    for (const preset of STYLE_PRESET_LIST) {
      if (preset.id === 'daylight') continue;
      expect(byId[preset.id]).toBe('dark');
    }
  });

  it('the current stream scheme is adaptive; imported terminal schemes are dark', () => {
    const byId = Object.fromEntries(
      STREAM_SCHEME_LIST.map((scheme) => [scheme.id, scheme.tone]),
    );
    expect(byId.current).toBe('adaptive');
    expect(byId.campbell).toBe('dark');
    expect(byId['campbell-powershell']).toBe('dark');
    expect(byId['one-half-dark']).toBe('dark');
    expect(byId['solarized-dark']).toBe('dark');
  });

  it.each(NEW_PRESETS)(
    'global.css defines the full token contract for "%s"',
    (id) => {
      const block = presetCssBlock(id);
      expect(block, `missing CSS block for ${id}`).not.toBe('');
      for (const token of REQUIRED_TOKENS) {
        expect(block, `${id} missing ${token}`).toContain(`${token}:`);
      }
    },
  );

  it('daylight opts into the light color-scheme', () => {
    expect(presetCssBlock('daylight')).toContain('color-scheme: light');
  });

  it.each(NEW_STREAM_SCHEMES)(
    'global.css defines the stream token contract for "%s"',
    (id) => {
      const block = streamCssBlock(id);
      expect(block, `missing CSS block for ${id}`).not.toBe('');
      for (const token of [
        '--hl-comment',
        '--code-bg',
        '--stream-surface-bg',
        '--stream-fg',
        '--stream-link',
        '--stream-tool-card-bg',
      ]) {
        expect(block, `${id} missing ${token}`).toContain(`${token}:`);
      }
    },
  );

  it.each([
    ['campbell', '#0c0c0c'],
    ['campbell-powershell', '#012456'],
    ['one-half-dark', '#282c34'],
    ['solarized-dark', '#002b36'],
  ] as const)('stream scheme "%s" owns its message surface background', (id, bg) => {
    expect(streamCssBlock(id)).toContain(`--stream-surface-bg: ${bg};`);
  });

  it.each(NEW_PRESETS)(
    'both locales provide label + description for "%s"',
    (id) => {
      const preset = STYLE_PRESET_LIST.find((p) => p.id === id);
      expect(preset).toBeDefined();
      for (const locale of SUPPORTED_LOCALES) {
        const label = t(locale, preset!.labelKey);
        const desc = t(locale, preset!.descriptionKey);
        expect(label.length).toBeGreaterThan(0);
        expect(label).not.toBe(preset!.labelKey);
        expect(desc.length).toBeGreaterThan(0);
        expect(desc).not.toBe(preset!.descriptionKey);
      }
    },
  );

  it.each([...BUILTIN_STREAM_SCHEMES])(
    'both locales provide label + description for stream scheme "%s"',
    (id) => {
      const scheme = STREAM_SCHEME_LIST.find((item) => item.id === id);
      expect(scheme).toBeDefined();
      for (const locale of SUPPORTED_LOCALES) {
        const label = t(locale, scheme!.labelKey);
        const desc = t(locale, scheme!.descriptionKey);
        expect(label.length).toBeGreaterThan(0);
        expect(label).not.toBe(scheme!.labelKey);
        expect(desc.length).toBeGreaterThan(0);
        expect(desc).not.toBe(scheme!.descriptionKey);
      }
    },
  );

  it.each([...BUILTIN_FONT_FAMILIES])(
    'locales provide label + description for font family "%s"',
    (id) => {
      const font = FONT_FAMILY_LIST.find((item) => item.id === id);
      expect(font).toBeDefined();
      for (const locale of SUPPORTED_LOCALES) {
        const label = t(locale, font!.labelKey);
        const desc = t(locale, font!.descriptionKey);
        expect(label.length).toBeGreaterThan(0);
        expect(label).not.toBe(font!.labelKey);
        expect(desc.length).toBeGreaterThan(0);
        expect(desc).not.toBe(font!.descriptionKey);
      }
    },
  );

  it.each([...BUILTIN_STYLE_PRESETS])(
    'applyAppearance wires unified style + stream data for "%s"',
    (id) => {
      const expectedStreamSchemeId = streamSchemeForStylePresetId(id);
      applyAppearance({
        ...DEFAULT_APPEARANCE_SETTINGS,
        stylePresetId: id,
        streamSchemeId: DEFAULT_STREAM_SCHEME_ID,
      });
      const root = document.documentElement;
      expect(root.dataset.fucStyle).toBe(id);
      expect(root.dataset.fucStreamScheme).toBe(expectedStreamSchemeId);
      expect(root.classList.contains(`fuc-style-${id}`)).toBe(true);
      expect(
        root.classList.contains(`fuc-stream-scheme-${expectedStreamSchemeId}`),
      ).toBe(true);
      // Only the active preset class is present.
      for (const other of BUILTIN_STYLE_PRESETS) {
        if (other === id) continue;
        expect(root.classList.contains(`fuc-style-${other}`)).toBe(false);
      }
      for (const other of BUILTIN_STREAM_SCHEMES) {
        if (other === expectedStreamSchemeId) continue;
        expect(root.classList.contains(`fuc-stream-scheme-${other}`)).toBe(false);
      }
    },
  );

  it.each([...BUILTIN_STREAM_SCHEMES])(
    'applyAppearance migrates legacy stream scheme "%s" into the unified style',
    (id) => {
      const expectedStylePresetId =
        id === DEFAULT_STREAM_SCHEME_ID ? DEFAULT_STYLE_PRESET_ID : id;
      applyAppearance({
        ...DEFAULT_APPEARANCE_SETTINGS,
        stylePresetId: DEFAULT_STYLE_PRESET_ID,
        streamSchemeId: id,
      });
      const root = document.documentElement;
      expect(root.dataset.fucStyle).toBe(expectedStylePresetId);
      expect(root.dataset.fucStreamScheme).toBe(id);
      expect(root.classList.contains(`fuc-style-${expectedStylePresetId}`)).toBe(
        true,
      );
      expect(root.classList.contains(`fuc-stream-scheme-${id}`)).toBe(true);
      for (const other of BUILTIN_STYLE_PRESETS) {
        if (other === expectedStylePresetId) continue;
        expect(root.classList.contains(`fuc-style-${other}`)).toBe(false);
      }
      for (const other of BUILTIN_STREAM_SCHEMES) {
        if (other === id) continue;
        expect(root.classList.contains(`fuc-stream-scheme-${other}`)).toBe(false);
      }
    },
  );

  it('treats the new presets as supported and falls back otherwise', () => {
    for (const id of NEW_PRESETS) {
      expect(isUnsupportedStylePreset(id)).toBe(false);
      expect(resolveStylePresetId(id)).toBe(id);
    }
    expect(isUnsupportedStylePreset('not-a-theme')).toBe(true);
    expect(resolveStylePresetId('not-a-theme')).toBe(DEFAULT_STYLE_PRESET_ID);
  });

  it('treats the stream schemes as supported and falls back otherwise', () => {
    for (const id of BUILTIN_STREAM_SCHEMES) {
      expect(isUnsupportedStreamScheme(id)).toBe(false);
      expect(resolveStreamSchemeId(id)).toBe(id);
    }
    expect(isUnsupportedStreamScheme('not-a-stream')).toBe(true);
    expect(resolveStreamSchemeId('not-a-stream')).toBe(
      DEFAULT_STREAM_SCHEME_ID,
    );
  });

  it('normalizes legacy stream settings into unified style settings', () => {
    expect(
      normalizeAppearanceSettings({
        stylePresetId: 'midnight',
        streamSchemeId: 'campbell',
      }),
    ).toEqual({
      stylePresetId: 'campbell',
      streamSchemeId: 'campbell',
      fontFamilyId: DEFAULT_FONT_FAMILY_ID,
      fontSizePx: DEFAULT_FONT_SIZE_PX,
    });
    expect(
      normalizeAppearanceSettings({
        stylePresetId: 'campbell-powershell',
      }).streamSchemeId,
    ).toBe('campbell-powershell');
  });

  it('resolves font family and clamps font size', () => {
    expect(resolveFontFamilyId('cjk')).toBe('cjk');
    expect(resolveFontFamilyId('not-a-font')).toBe(DEFAULT_FONT_FAMILY_ID);
    expect(resolveFontSizePx(FONT_SIZE_LIMITS.min - 10)).toBe(
      FONT_SIZE_LIMITS.min,
    );
    expect(resolveFontSizePx(FONT_SIZE_LIMITS.max + 10)).toBe(
      FONT_SIZE_LIMITS.max,
    );
    expect(resolveFontSizePx('18px')).toBe(18);
    expect(resolveFontSizePx('bad')).toBe(DEFAULT_FONT_SIZE_PX);
  });

  it('applyAppearance writes font CSS variables', () => {
    applyAppearance({
      ...DEFAULT_APPEARANCE_SETTINGS,
      fontFamilyId: 'cjk',
      fontSizePx: 18,
    });
    const root = document.documentElement;
    expect(root.dataset.fucFontFamily).toBe('cjk');
    expect(root.dataset.fucFontSize).toBe('18');
    expect(root.style.getPropertyValue('--fuc-font-family')).toContain(
      'Microsoft YaHei',
    );
    expect(root.style.getPropertyValue('--fuc-font-size')).toBe('18px');
  });
});
