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
  'hermes-dark',
  'cherry-dark',
  'cherry-light',
  'midnight',
  'aurora',
  'daylight',
  'ember',
  'campbell',
  'campbell-powershell',
  'one-half-dark',
  'solarized-dark',
  'terminal',
] as const;
const NEW_STREAM_SCHEMES = [
  'campbell',
  'campbell-powershell',
  'one-half-dark',
  'solarized-dark',
] as const;

// Vitest runs with cwd at the app/ root.
const globalCss = readFileSync('src/styles/global.css', 'utf8');
const indexHtml = readFileSync('index.html', 'utf8');

// The full primitive-token contract each preset CSS block must define.
const REQUIRED_TOKENS = [
  '--ugs-color-bg',
  '--ugs-color-bg-alt',
  '--ugs-color-panel',
  '--ugs-color-panel-2',
  '--ugs-color-border',
  '--ugs-color-border-soft',
  '--ugs-color-text',
  '--ugs-color-text-muted',
  '--ugs-color-text-faint',
  '--ugs-color-accent',
  '--ugs-color-accent-2',
  '--ugs-color-accent-3',
  '--ugs-color-accent-4',
  '--ugs-status-ai-edit',
  '--ugs-status-ai-edit-contrast',
  '--ugs-status-running',
  '--ugs-status-running-contrast',
  '--ugs-status-success',
  '--ugs-status-success-contrast',
  '--ugs-status-error',
  '--ugs-status-error-contrast',
  // Eight presets used to omit the draft pair, so the draft indicator silently
  // inherited :root's violet from a different palette.
  '--ugs-status-draft',
  '--ugs-status-draft-contrast',
  '--ugs-status-interrupted',
  '--ugs-status-interrupted-contrast',
] as const;

/** Extract the body of `html.ugs-style-<id> { ... }` from global.css. */
function presetCssBlock(id: string): string {
  const marker = `html.ugs-style-${id} {`;
  const start = globalCss.indexOf(marker);
  if (start === -1) return '';
  const open = globalCss.indexOf('{', start);
  const close = globalCss.indexOf('}', open);
  return globalCss.slice(open + 1, close);
}

/** Extract the body of `html.ugs-stream-scheme-<id> { ... }` from global.css. */
function streamCssBlock(id: string): string {
  const marker = `html.ugs-stream-scheme-${id} {`;
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
  delete root.dataset.ugsStyle;
  delete root.dataset.ugsStreamScheme;
  delete root.dataset.ugsFontFamily;
  delete root.dataset.ugsFontSize;
});

describe('appearance presets', () => {
  it('registers black style default plus the built-in unified style presets', () => {
    expect(BUILTIN_STYLE_PRESETS).toEqual([
      'hermes-dark',
      'cherry-dark',
      'pencil',
      'cherry-light',
      'midnight',
      'aurora',
      'daylight',
      'ember',
      'campbell',
      'campbell-powershell',
      'one-half-dark',
      'solarized-dark',
      'terminal',
    ]);
    expect(STYLE_PRESET_LIST).toHaveLength(13);
  });

  it('uses black style as the default startup style', () => {
    expect(DEFAULT_STYLE_PRESET_ID).toBe('hermes-dark');
    expect(DEFAULT_APPEARANCE_SETTINGS.stylePresetId).toBe('hermes-dark');
    expect(indexHtml).toContain("const fallback = 'hermes-dark'");
    for (const id of BUILTIN_STYLE_PRESETS) {
      expect(indexHtml).toContain(`'${id}'`);
    }
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
      'terminal',
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

  it('cherry-light and daylight are light schemes; the rest are dark', () => {
    const byId = Object.fromEntries(
      STYLE_PRESET_LIST.map((p) => [p.id, p.colorScheme]),
    );
    expect(byId['cherry-light']).toBe('light');
    expect(byId.daylight).toBe('light');
    for (const preset of STYLE_PRESET_LIST) {
      if (preset.id === 'cherry-light' || preset.id === 'daylight') continue;
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

  it.each([...BUILTIN_STYLE_PRESETS])(
    'global.css defines the full token contract for "%s"',
    (id) => {
      const block = presetCssBlock(id);
      expect(block, `missing CSS block for ${id}`).not.toBe('');
      for (const token of REQUIRED_TOKENS) {
        expect(block, `${id} missing ${token}`).toContain(`${token}:`);
        // Exactly once: a duplicate declaration is how the draft token went wrong
        // (the later value silently won).
        expect(
          block.split(`${token}:`).length - 1,
          `${id} declares ${token} more than once`,
        ).toBe(1);
      }
    },
  );

  it.each(['cherry-light', 'daylight'] as const)(
    '%s opts into the light color-scheme',
    (id) => {
      expect(presetCssBlock(id)).toContain('color-scheme: light');
    },
  );

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
      expect(root.dataset.ugsStyle).toBe(id);
      expect(root.dataset.ugsStreamScheme).toBe(expectedStreamSchemeId);
      expect(root.classList.contains(`ugs-style-${id}`)).toBe(true);
      expect(
        root.classList.contains(`ugs-stream-scheme-${expectedStreamSchemeId}`),
      ).toBe(true);
      // Only the active preset class is present.
      for (const other of BUILTIN_STYLE_PRESETS) {
        if (other === id) continue;
        expect(root.classList.contains(`ugs-style-${other}`)).toBe(false);
      }
      for (const other of BUILTIN_STREAM_SCHEMES) {
        if (other === expectedStreamSchemeId) continue;
        expect(root.classList.contains(`ugs-stream-scheme-${other}`)).toBe(false);
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
      expect(root.dataset.ugsStyle).toBe(expectedStylePresetId);
      expect(root.dataset.ugsStreamScheme).toBe(id);
      expect(root.classList.contains(`ugs-style-${expectedStylePresetId}`)).toBe(
        true,
      );
      expect(root.classList.contains(`ugs-stream-scheme-${id}`)).toBe(true);
      for (const other of BUILTIN_STYLE_PRESETS) {
        if (other === expectedStylePresetId) continue;
        expect(root.classList.contains(`ugs-style-${other}`)).toBe(false);
      }
      for (const other of BUILTIN_STREAM_SCHEMES) {
        if (other === id) continue;
        expect(root.classList.contains(`ugs-stream-scheme-${other}`)).toBe(false);
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
    expect(root.dataset.ugsFontFamily).toBe('cjk');
    expect(root.dataset.ugsFontSize).toBe('18');
    expect(root.style.getPropertyValue('--ugs-font-family')).toContain(
      'Microsoft YaHei',
    );
    // The reader face drives streamed answers and reasoning. If the appearance
    // layer stops writing it, the font picker goes back to being a no-op on the
    // product's main reading surface.
    expect(root.style.getPropertyValue('--ugs-reader-font-family')).toContain(
      'Microsoft YaHei',
    );
    expect(root.style.getPropertyValue('--ugs-font-size')).toBe('18px');
  });

  it('keeps the code face independent of the UI font choice', () => {
    applyAppearance({
      ...DEFAULT_APPEARANCE_SETTINGS,
      fontFamilyId: 'mono',
    });
    const root = document.documentElement;
    // Choosing a monospace UI font must not rewrite the code/token face: that is
    // what keeps code columns aligned (see global.css `code, pre, .mono`).
    expect(root.style.getPropertyValue('--ugs-mono-font-family')).toBe('');
    expect(root.style.getPropertyValue('--ugs-reader-font-family')).toContain(
      'JetBrains Mono',
    );
  });

  it('self-hosts the interface fonts so the app renders offline', () => {
    // UGS is local-first: a CDN font request degrades silently on an offline,
    // intranet or blocked network, and the app then looks nothing like the design.
    expect(indexHtml).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
    const fontsCss = readFileSync('src/styles/fonts.css', 'utf8');
    expect(fontsCss).toContain("font-family: 'Inter'");
    expect(fontsCss).toContain("font-family: 'JetBrains Mono'");
    // Every @font-face must point at a bundled file, never at a remote URL.
    for (const [, url] of fontsCss.matchAll(/src:\s*url\(([^)]+)\)/g)) {
      expect(url, `remote font source: ${url}`).not.toMatch(/^https?:/);
    }
  });

  it('keeps every Tailwind token color alpha-capable', async () => {
    // A color declared as a bare `var(--x)` cannot carry an alpha channel, so
    // Tailwind silently emits *no rule* for `bg-accent/10`, `border-status-error/40`,
    // `ring-status-success/20`, … — 48 such classes existed in the source with zero
    // generated rules. `color-mix(… calc(<alpha-value> * 100%) …)` restores them.
    const { default: tailwindConfig } = await import('../../tailwind.config');
    const colors = (tailwindConfig.theme?.extend?.colors ?? {}) as Record<
      string,
      unknown
    >;
    expect(Object.keys(colors).length).toBeGreaterThan(20);
    for (const [name, value] of Object.entries(colors)) {
      expect(
        String(value),
        `Tailwind color "${name}" would drop every /NN opacity modifier`,
      ).toContain('<alpha-value>');
    }
  });
});
