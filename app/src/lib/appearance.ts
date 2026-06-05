import type { TranslationKey } from '@/lib/i18n';

export const DEFAULT_STYLE_PRESET_ID = 'pencil' as const;
export const BUILTIN_STYLE_PRESETS = [
  DEFAULT_STYLE_PRESET_ID,
  'midnight',
  'aurora',
  'daylight',
  'ember',
  'campbell',
  'campbell-powershell',
  'one-half-dark',
  'solarized-dark',
] as const;
export const DEFAULT_STREAM_SCHEME_ID = 'current' as const;
export const BUILTIN_STREAM_SCHEMES = [
  DEFAULT_STREAM_SCHEME_ID,
  'campbell',
  'campbell-powershell',
  'one-half-dark',
  'solarized-dark',
] as const;
export const TERMINAL_STYLE_PRESET_IDS = [
  'campbell',
  'campbell-powershell',
  'one-half-dark',
  'solarized-dark',
] as const;
export const DEFAULT_FONT_FAMILY_ID = 'inter' as const;
export const BUILTIN_FONT_FAMILIES = [
  DEFAULT_FONT_FAMILY_ID,
  'system',
  'cjk',
  'serif',
  'mono',
] as const;
export const DEFAULT_FONT_SIZE_PX = 16;
export const FONT_SIZE_LIMITS = {
  min: 12,
  max: 20,
} as const;

export type BuiltinStylePresetId = (typeof BUILTIN_STYLE_PRESETS)[number];
export type BuiltinStreamSchemeId = (typeof BUILTIN_STREAM_SCHEMES)[number];
export type StylePresetId =
  | BuiltinStylePresetId
  | (string & { readonly __stylePresetIdBrand?: never });
export type StreamSchemeId =
  | BuiltinStreamSchemeId
  | (string & { readonly __streamSchemeIdBrand?: never });
export type BuiltinFontFamilyId = (typeof BUILTIN_FONT_FAMILIES)[number];
export type FontFamilyId =
  | BuiltinFontFamilyId
  | (string & { readonly __fontFamilyIdBrand?: never });

export interface AppearanceSettings {
  stylePresetId: StylePresetId;
  streamSchemeId: StreamSchemeId;
  fontFamilyId: FontFamilyId;
  fontSizePx: number;
}

export interface StylePresetDefinition {
  id: BuiltinStylePresetId;
  labelKey: TranslationKey;
  descriptionKey: TranslationKey;
  colorScheme: 'dark' | 'light';
  swatches: readonly [string, string, string, string, string];
}

export interface StreamSchemeDefinition {
  id: BuiltinStreamSchemeId;
  labelKey: TranslationKey;
  descriptionKey: TranslationKey;
  tone: 'adaptive' | 'dark';
  swatches: readonly [string, string, string, string, string];
}

export interface FontFamilyDefinition {
  id: BuiltinFontFamilyId;
  labelKey: TranslationKey;
  descriptionKey: TranslationKey;
  cssFamily: string;
}

export const STYLE_PRESETS: Record<BuiltinStylePresetId, StylePresetDefinition> =
  {
    pencil: {
      id: 'pencil',
      labelKey: 'settings.appearancePresetPencil',
      descriptionKey: 'settings.appearancePresetPencilDescription',
      colorScheme: 'dark',
      swatches: [
        '#0d1117',
        '#161b22',
        '#1c2128',
        '#7c8cff',
        '#37c2a8',
      ],
    },
    midnight: {
      id: 'midnight',
      labelKey: 'settings.appearancePresetMidnight',
      descriptionKey: 'settings.appearancePresetMidnightDescription',
      colorScheme: 'dark',
      swatches: [
        '#0b0e1a',
        '#11152a',
        '#171c38',
        '#7c6cff',
        '#2dd4d4',
      ],
    },
    aurora: {
      id: 'aurora',
      labelKey: 'settings.appearancePresetAurora',
      descriptionKey: 'settings.appearancePresetAuroraDescription',
      colorScheme: 'dark',
      swatches: [
        '#2e3440',
        '#3b4252',
        '#434c5e',
        '#88c0d0',
        '#a3be8c',
      ],
    },
    daylight: {
      id: 'daylight',
      labelKey: 'settings.appearancePresetDaylight',
      descriptionKey: 'settings.appearancePresetDaylightDescription',
      colorScheme: 'light',
      swatches: [
        '#f6f7f9',
        '#eceef2',
        '#ffffff',
        '#2f6fed',
        '#13a07a',
      ],
    },
    ember: {
      id: 'ember',
      labelKey: 'settings.appearancePresetEmber',
      descriptionKey: 'settings.appearancePresetEmberDescription',
      colorScheme: 'dark',
      swatches: [
        '#1a1411',
        '#221a15',
        '#2b211a',
        '#ff8c42',
        '#3fb8a8',
      ],
    },
    campbell: {
      id: 'campbell',
      labelKey: 'settings.appearancePresetCampbell',
      descriptionKey: 'settings.appearancePresetCampbellDescription',
      colorScheme: 'dark',
      swatches: [
        '#0c0c0c',
        '#1a1a1a',
        '#242424',
        '#3b78ff',
        '#16c60c',
      ],
    },
    'campbell-powershell': {
      id: 'campbell-powershell',
      labelKey: 'settings.appearancePresetCampbellPowershell',
      descriptionKey: 'settings.appearancePresetCampbellPowershellDescription',
      colorScheme: 'dark',
      swatches: [
        '#012456',
        '#082448',
        '#0b2f61',
        '#79c0ff',
        '#61d6d6',
      ],
    },
    'one-half-dark': {
      id: 'one-half-dark',
      labelKey: 'settings.appearancePresetOneHalfDark',
      descriptionKey: 'settings.appearancePresetOneHalfDarkDescription',
      colorScheme: 'dark',
      swatches: [
        '#282c34',
        '#23272f',
        '#2d323c',
        '#61afef',
        '#98c379',
      ],
    },
    'solarized-dark': {
      id: 'solarized-dark',
      labelKey: 'settings.appearancePresetSolarizedDark',
      descriptionKey: 'settings.appearancePresetSolarizedDarkDescription',
      colorScheme: 'dark',
      swatches: [
        '#002b36',
        '#073642',
        '#0d404d',
        '#268bd2',
        '#2aa198',
      ],
    },
  };

export const STYLE_PRESET_LIST = BUILTIN_STYLE_PRESETS.map(
  (id) => STYLE_PRESETS[id],
);
export const STREAM_SCHEMES: Record<
  BuiltinStreamSchemeId,
  StreamSchemeDefinition
> = {
  current: {
    id: 'current',
    labelKey: 'settings.streamSchemeCurrent',
    descriptionKey: 'settings.streamSchemeCurrentDescription',
    tone: 'adaptive',
    swatches: [
      '#161b22',
      '#7c8cff',
      '#37c2a8',
      '#e3a008',
      '#f778ba',
    ],
  },
  campbell: {
    id: 'campbell',
    labelKey: 'settings.streamSchemeCampbell',
    descriptionKey: 'settings.streamSchemeCampbellDescription',
    tone: 'dark',
    swatches: [
      '#0c0c0c',
      '#0037da',
      '#13a10e',
      '#c19c00',
      '#c50f1f',
    ],
  },
  'campbell-powershell': {
    id: 'campbell-powershell',
    labelKey: 'settings.streamSchemeCampbellPowershell',
    descriptionKey: 'settings.streamSchemeCampbellPowershellDescription',
    tone: 'dark',
    swatches: [
      '#012456',
      '#0037da',
      '#13a10e',
      '#c19c00',
      '#c50f1f',
    ],
  },
  'one-half-dark': {
    id: 'one-half-dark',
    labelKey: 'settings.streamSchemeOneHalfDark',
    descriptionKey: 'settings.streamSchemeOneHalfDarkDescription',
    tone: 'dark',
    swatches: [
      '#282c34',
      '#61afef',
      '#98c379',
      '#e5c07b',
      '#e06c75',
    ],
  },
  'solarized-dark': {
    id: 'solarized-dark',
    labelKey: 'settings.streamSchemeSolarizedDark',
    descriptionKey: 'settings.streamSchemeSolarizedDarkDescription',
    tone: 'dark',
    swatches: [
      '#002b36',
      '#268bd2',
      '#859900',
      '#b58900',
      '#dc322f',
    ],
  },
};

export const STREAM_SCHEME_LIST = BUILTIN_STREAM_SCHEMES.map(
  (id) => STREAM_SCHEMES[id],
);

export const FONT_FAMILIES: Record<BuiltinFontFamilyId, FontFamilyDefinition> =
  {
    inter: {
      id: 'inter',
      labelKey: 'settings.fontFamilyInter',
      descriptionKey: 'settings.fontFamilyInterDescription',
      cssFamily: "'Inter', system-ui, -apple-system, sans-serif",
    },
    system: {
      id: 'system',
      labelKey: 'settings.fontFamilySystem',
      descriptionKey: 'settings.fontFamilySystemDescription',
      cssFamily:
        "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    },
    cjk: {
      id: 'cjk',
      labelKey: 'settings.fontFamilyCjk',
      descriptionKey: 'settings.fontFamilyCjkDescription',
      cssFamily:
        "'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', system-ui, sans-serif",
    },
    serif: {
      id: 'serif',
      labelKey: 'settings.fontFamilySerif',
      descriptionKey: 'settings.fontFamilySerifDescription',
      cssFamily: "Georgia, 'Times New Roman', serif",
    },
    mono: {
      id: 'mono',
      labelKey: 'settings.fontFamilyMono',
      descriptionKey: 'settings.fontFamilyMonoDescription',
      cssFamily:
        "'JetBrains Mono', 'Cascadia Code', ui-monospace, SFMono-Regular, monospace",
    },
  };

export const FONT_FAMILY_LIST = BUILTIN_FONT_FAMILIES.map(
  (id) => FONT_FAMILIES[id],
);

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  stylePresetId: DEFAULT_STYLE_PRESET_ID,
  streamSchemeId: DEFAULT_STREAM_SCHEME_ID,
  fontFamilyId: DEFAULT_FONT_FAMILY_ID,
  fontSizePx: DEFAULT_FONT_SIZE_PX,
};

export function isBuiltinStylePresetId(
  value: string | null | undefined,
): value is BuiltinStylePresetId {
  return !!value && BUILTIN_STYLE_PRESETS.includes(value as BuiltinStylePresetId);
}

export function resolveStylePresetId(
  value: StylePresetId | string | null | undefined,
): BuiltinStylePresetId {
  return isBuiltinStylePresetId(value) ? value : DEFAULT_STYLE_PRESET_ID;
}

export function streamSchemeForStylePresetId(
  value: StylePresetId | string | null | undefined,
): BuiltinStreamSchemeId {
  const stylePresetId = resolveStylePresetId(value);
  return isBuiltinStreamSchemeId(stylePresetId)
    ? stylePresetId
    : DEFAULT_STREAM_SCHEME_ID;
}

function legacyStylePresetFromStreamSchemeId(
  value: StreamSchemeId | string | null | undefined,
): BuiltinStylePresetId | null {
  if (value === DEFAULT_STREAM_SCHEME_ID) return null;
  return isBuiltinStylePresetId(value) ? value : null;
}

export function isBuiltinStreamSchemeId(
  value: string | null | undefined,
): value is BuiltinStreamSchemeId {
  return (
    !!value && BUILTIN_STREAM_SCHEMES.includes(value as BuiltinStreamSchemeId)
  );
}

export function resolveStreamSchemeId(
  value: StreamSchemeId | string | null | undefined,
): BuiltinStreamSchemeId {
  return isBuiltinStreamSchemeId(value) ? value : DEFAULT_STREAM_SCHEME_ID;
}

export function isBuiltinFontFamilyId(
  value: string | null | undefined,
): value is BuiltinFontFamilyId {
  return !!value && BUILTIN_FONT_FAMILIES.includes(value as BuiltinFontFamilyId);
}

export function resolveFontFamilyId(
  value: FontFamilyId | string | null | undefined,
): BuiltinFontFamilyId {
  return isBuiltinFontFamilyId(value) ? value : DEFAULT_FONT_FAMILY_ID;
}

export function resolveFontSizePx(value: unknown): number {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(numeric)) return DEFAULT_FONT_SIZE_PX;
  return Math.min(
    FONT_SIZE_LIMITS.max,
    Math.max(FONT_SIZE_LIMITS.min, Math.round(numeric)),
  );
}

export function normalizeAppearanceSettings(
  value: unknown,
): AppearanceSettings {
  if (!value || typeof value !== 'object') {
    return DEFAULT_APPEARANCE_SETTINGS;
  }
  const stylePresetId = (value as { stylePresetId?: unknown }).stylePresetId;
  const streamSchemeId = (value as { streamSchemeId?: unknown }).streamSchemeId;
  const fontFamilyId = (value as { fontFamilyId?: unknown }).fontFamilyId;
  const fontSizePx = (value as { fontSizePx?: unknown }).fontSizePx;
  const rawStylePresetId =
    typeof stylePresetId === 'string' && stylePresetId.trim()
      ? (stylePresetId as StylePresetId)
      : DEFAULT_STYLE_PRESET_ID;
  const rawStreamSchemeId =
    typeof streamSchemeId === 'string' && streamSchemeId.trim()
      ? (streamSchemeId as StreamSchemeId)
      : DEFAULT_STREAM_SCHEME_ID;
  const migratedStylePresetId =
    legacyStylePresetFromStreamSchemeId(rawStreamSchemeId) ?? rawStylePresetId;
  return {
    stylePresetId: migratedStylePresetId,
    streamSchemeId: streamSchemeForStylePresetId(migratedStylePresetId),
    fontFamilyId:
      typeof fontFamilyId === 'string' && fontFamilyId.trim()
        ? resolveFontFamilyId(fontFamilyId)
        : DEFAULT_FONT_FAMILY_ID,
    fontSizePx: resolveFontSizePx(fontSizePx),
  };
}

export function isUnsupportedStylePreset(
  value: string | null | undefined,
): boolean {
  return !isBuiltinStylePresetId(value);
}

export function isUnsupportedStreamScheme(
  value: string | null | undefined,
): boolean {
  return !isBuiltinStreamSchemeId(value);
}

export function applyAppearance(settings: AppearanceSettings): void {
  if (typeof document === 'undefined') return;

  const normalized = normalizeAppearanceSettings(settings);
  const stylePresetId = resolveStylePresetId(normalized.stylePresetId);
  const streamSchemeId = streamSchemeForStylePresetId(stylePresetId);
  const fontFamilyId = resolveFontFamilyId(normalized.fontFamilyId);
  const fontSizePx = resolveFontSizePx(normalized.fontSizePx);
  const fontFamily = FONT_FAMILIES[fontFamilyId];
  const root = document.documentElement;

  root.dataset.fucStyle = stylePresetId;
  root.dataset.fucStreamScheme = streamSchemeId;
  root.dataset.fucFontFamily = fontFamilyId;
  root.dataset.fucFontSize = String(fontSizePx);
  root.style.setProperty('--fuc-font-family', fontFamily.cssFamily);
  root.style.setProperty('--fuc-font-size', `${fontSizePx}px`);
  for (const presetId of BUILTIN_STYLE_PRESETS) {
    root.classList.toggle(`fuc-style-${presetId}`, presetId === stylePresetId);
  }
  for (const schemeId of BUILTIN_STREAM_SCHEMES) {
    root.classList.toggle(
      `fuc-stream-scheme-${schemeId}`,
      schemeId === streamSchemeId,
    );
  }
}
