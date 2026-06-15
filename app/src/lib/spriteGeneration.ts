import {
  generateImage,
  imageProviderReady,
  loadImageGenerationSettings,
  type ImageGenerationSettings,
  type ImageProviderId,
} from './imageGeneration';

export type SpriteProviderId = 'ludo-sprite' | 'local-comfyui-sprite';

export type SpriteProviderCategory = 'commercial' | 'local-open';

type SpriteProviderApiKind = 'ludo-compatible' | 'generic-local-sprite';

export interface SpriteProviderDefinition {
  id: SpriteProviderId;
  label: string;
  category: SpriteProviderCategory;
  apiKind: SpriteProviderApiKind;
  defaultModel: string;
  models: string[];
  needsKey: boolean;
  local: boolean;
  defaultBaseUrl: string;
  supportsBaseUrl: boolean;
  endpointPlaceholder: string;
  credentialUrl?: string;
  keyLabel?: string;
  keyPlaceholder?: string;
  note: string;
}

export type SpriteGenerationMode = 'text-to-sprite' | 'image-to-animation' | 'motion-transfer';
export type SpriteSheetPreset = 'auto' | '2x2' | '2x3' | '4x4' | 'custom';
export type SpriteFrameAnchor = 'center' | 'bottom' | 'feet';
export type SpriteComponentMode = 'largest' | 'all';

export interface SpriteGenerationSettings {
  enabled: boolean;
  preferredProviderId: SpriteProviderId;
  providerKeys: Partial<Record<SpriteProviderId, string>>;
  providerBaseUrls: Partial<Record<SpriteProviderId, string>>;
  providerModels: Partial<Record<SpriteProviderId, string>>;
  defaultFrameCount: number;
  defaultFrameSize: number;
  removeBackground: boolean;
  autoTrim: boolean;
  alignFrames: boolean;
  packSpritesheet: boolean;
  sheetPreset: SpriteSheetPreset;
  sheetRows: number;
  sheetColumns: number;
  chromaKey: string;
  frameAnchor: SpriteFrameAnchor;
  componentMode: SpriteComponentMode;
  rejectEdgeTouch: boolean;
  fitScale: number;
}

export interface SpriteGenerationRequest {
  prompt: string;
  providerId?: ImageProviderId;
  model?: string;
  mode?: SpriteGenerationMode;
  frameCount?: number;
  frameSize?: number;
  removeBackground?: boolean;
  autoTrim?: boolean;
  alignFrames?: boolean;
  packSpritesheet?: boolean;
  signal?: AbortSignal;
}

export interface SpriteGenerationResult {
  providerId: ImageProviderId;
  providerLabel: string;
  model: string;
  prompt: string;
  mode: SpriteGenerationMode;
  frameCount: number;
  frameSize: number;
  spritesheets: string[];
  frames: string[];
  gifs: string[];
  videos: string[];
  metadata: string[];
}

const STORAGE_KEY = 'freeultracode.spriteGeneration.v1';
const MIN_FRAME_COUNT = 1;
const MAX_FRAME_COUNT = 64;
const MIN_FRAME_SIZE = 16;
const MAX_FRAME_SIZE = 512;
const MIN_SHEET_DIMENSION = 1;
const MAX_SHEET_DIMENSION = 8;
const MIN_FIT_SCALE = 0.5;
const MAX_FIT_SCALE = 1;
const DEFAULT_CHROMA_KEY = '#FF00FF';

const SPRITE_SHEET_PRESET_DIMENSIONS: Partial<
  Record<SpriteSheetPreset, { rows: number; columns: number }>
> = {
  '2x2': { rows: 2, columns: 2 },
  '2x3': { rows: 2, columns: 3 },
  '4x4': { rows: 4, columns: 4 },
};

export const SPRITE_PROVIDERS: SpriteProviderDefinition[] = [
  {
    id: 'ludo-sprite',
    label: 'Ludo.ai Sprite Generator',
    category: 'commercial',
    apiKind: 'ludo-compatible',
    defaultModel: 'sprite-generator',
    models: ['sprite-generator', 'sprite-animation', 'motion-transfer'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.ludo.ai',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.ludo.ai',
    credentialUrl: 'https://ludo.ai/docs/sprite-generator',
    keyLabel: 'Ludo API Key',
    keyPlaceholder: 'ludo_...',
    note: '商用品质优先路线。兼容 Ludo Sprite Generator / MCP 包装服务，支持文本生成 sprite、首帧动画和动作迁移，输出 spritesheet、逐帧图、GIF、视频与 JSON 元数据。',
  },
  {
    id: 'local-comfyui-sprite',
    label: '本地 ComfyUI Sprite',
    category: 'local-open',
    apiKind: 'generic-local-sprite',
    defaultModel: 'AnimateDiff',
    models: ['AnimateDiff', 'Stable Video Diffusion', 'Wan I2V', 'custom-sprite-workflow'],
    needsKey: false,
    local: true,
    defaultBaseUrl: 'http://127.0.0.1:8190/generate-sprite',
    supportsBaseUrl: true,
    endpointPlaceholder: 'http://127.0.0.1:8190/generate-sprite',
    credentialUrl: 'https://github.com/comfyanonymous/ComfyUI',
    note: '本地开源路线入口。建议用 ComfyUI + AnimateDiff / Stable Video Diffusion 包装服务；服务负责生成短动画、ffmpeg 抽帧、背景移除、对齐、裁切和 spritesheet 打包。',
  },
];

const SPRITE_PROVIDER_BY_ID = new Map<SpriteProviderId, SpriteProviderDefinition>(
  SPRITE_PROVIDERS.map((provider) => [provider.id, provider]),
);

export const DEFAULT_SPRITE_GENERATION_SETTINGS: SpriteGenerationSettings = {
  enabled: true,
  preferredProviderId: 'ludo-sprite',
  providerKeys: {},
  providerBaseUrls: {},
  providerModels: {},
  defaultFrameCount: 16,
  defaultFrameSize: 128,
  removeBackground: true,
  autoTrim: true,
  alignFrames: true,
  packSpritesheet: true,
  sheetPreset: '4x4',
  sheetRows: 4,
  sheetColumns: 4,
  chromaKey: DEFAULT_CHROMA_KEY,
  frameAnchor: 'feet',
  componentMode: 'largest',
  rejectEdgeTouch: true,
  fitScale: 0.92,
};

function hasStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage;
}

export function isSpriteProviderId(value: unknown): value is SpriteProviderId {
  return typeof value === 'string' && SPRITE_PROVIDER_BY_ID.has(value as SpriteProviderId);
}

function isSpriteSheetPreset(value: unknown): value is SpriteSheetPreset {
  return value === 'auto' || value === '2x2' || value === '2x3' || value === '4x4' || value === 'custom';
}

function isSpriteFrameAnchor(value: unknown): value is SpriteFrameAnchor {
  return value === 'center' || value === 'bottom' || value === 'feet';
}

function isSpriteComponentMode(value: unknown): value is SpriteComponentMode {
  return value === 'largest' || value === 'all';
}

function cleanRecord<T extends string>(
  value: unknown,
  validKey: (key: unknown) => key is T,
): Partial<Record<T, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Partial<Record<T, string>> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!validKey(key) || typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed) out[key] = trimmed;
  }
  return out;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeChromaKey(value: unknown): string {
  const source = typeof value === 'string' ? value.trim() : '';
  if (/^#[0-9a-f]{6}$/iu.test(source)) return source.toUpperCase();
  return DEFAULT_CHROMA_KEY;
}

export function spriteSheetGridForSettings(
  settings: Pick<SpriteGenerationSettings, 'sheetPreset' | 'sheetRows' | 'sheetColumns' | 'defaultFrameCount'>,
): { rows: number; columns: number; cells: number; label: string } {
  const preset = settings.sheetPreset;
  const fixed = SPRITE_SHEET_PRESET_DIMENSIONS[preset];
  if (fixed) {
    return {
      ...fixed,
      cells: fixed.rows * fixed.columns,
      label: `${fixed.rows}x${fixed.columns}`,
    };
  }
  if (preset === 'custom') {
    const rows = clampInteger(
      settings.sheetRows,
      MIN_SHEET_DIMENSION,
      MAX_SHEET_DIMENSION,
      DEFAULT_SPRITE_GENERATION_SETTINGS.sheetRows,
    );
    const columns = clampInteger(
      settings.sheetColumns,
      MIN_SHEET_DIMENSION,
      MAX_SHEET_DIMENSION,
      DEFAULT_SPRITE_GENERATION_SETTINGS.sheetColumns,
    );
    return { rows, columns, cells: rows * columns, label: `${rows}x${columns}` };
  }
  const cells = clampInteger(
    settings.defaultFrameCount,
    MIN_FRAME_COUNT,
    MAX_FRAME_COUNT,
    DEFAULT_SPRITE_GENERATION_SETTINGS.defaultFrameCount,
  );
  const columns = Math.ceil(Math.sqrt(cells));
  const rows = Math.ceil(cells / columns);
  return { rows, columns, cells, label: `${rows}x${columns}` };
}

export function normalizeSpriteGenerationSettings(
  value: unknown,
): SpriteGenerationSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return DEFAULT_SPRITE_GENERATION_SETTINGS;
  }
  const source = value as Partial<SpriteGenerationSettings>;
  const preferredProviderId = isSpriteProviderId(source.preferredProviderId)
    ? source.preferredProviderId
    : DEFAULT_SPRITE_GENERATION_SETTINGS.preferredProviderId;
  const sheetPreset = isSpriteSheetPreset(source.sheetPreset)
    ? source.sheetPreset
    : DEFAULT_SPRITE_GENERATION_SETTINGS.sheetPreset;
  return {
    enabled:
      typeof source.enabled === 'boolean'
        ? source.enabled
        : DEFAULT_SPRITE_GENERATION_SETTINGS.enabled,
    preferredProviderId,
    providerKeys: cleanRecord(source.providerKeys, isSpriteProviderId),
    providerBaseUrls: cleanRecord(source.providerBaseUrls, isSpriteProviderId),
    providerModels: cleanRecord(source.providerModels, isSpriteProviderId),
    defaultFrameCount: clampInteger(
      source.defaultFrameCount,
      MIN_FRAME_COUNT,
      MAX_FRAME_COUNT,
      DEFAULT_SPRITE_GENERATION_SETTINGS.defaultFrameCount,
    ),
    defaultFrameSize: clampInteger(
      source.defaultFrameSize,
      MIN_FRAME_SIZE,
      MAX_FRAME_SIZE,
      DEFAULT_SPRITE_GENERATION_SETTINGS.defaultFrameSize,
    ),
    removeBackground:
      typeof source.removeBackground === 'boolean'
        ? source.removeBackground
        : DEFAULT_SPRITE_GENERATION_SETTINGS.removeBackground,
    autoTrim:
      typeof source.autoTrim === 'boolean'
        ? source.autoTrim
        : DEFAULT_SPRITE_GENERATION_SETTINGS.autoTrim,
    alignFrames:
      typeof source.alignFrames === 'boolean'
        ? source.alignFrames
        : DEFAULT_SPRITE_GENERATION_SETTINGS.alignFrames,
    packSpritesheet:
      typeof source.packSpritesheet === 'boolean'
        ? source.packSpritesheet
        : DEFAULT_SPRITE_GENERATION_SETTINGS.packSpritesheet,
    sheetPreset,
    sheetRows: clampInteger(
      source.sheetRows,
      MIN_SHEET_DIMENSION,
      MAX_SHEET_DIMENSION,
      DEFAULT_SPRITE_GENERATION_SETTINGS.sheetRows,
    ),
    sheetColumns: clampInteger(
      source.sheetColumns,
      MIN_SHEET_DIMENSION,
      MAX_SHEET_DIMENSION,
      DEFAULT_SPRITE_GENERATION_SETTINGS.sheetColumns,
    ),
    chromaKey: normalizeChromaKey(source.chromaKey),
    frameAnchor: isSpriteFrameAnchor(source.frameAnchor)
      ? source.frameAnchor
      : DEFAULT_SPRITE_GENERATION_SETTINGS.frameAnchor,
    componentMode: isSpriteComponentMode(source.componentMode)
      ? source.componentMode
      : DEFAULT_SPRITE_GENERATION_SETTINGS.componentMode,
    rejectEdgeTouch:
      typeof source.rejectEdgeTouch === 'boolean'
        ? source.rejectEdgeTouch
        : DEFAULT_SPRITE_GENERATION_SETTINGS.rejectEdgeTouch,
    fitScale: clampNumber(
      source.fitScale,
      MIN_FIT_SCALE,
      MAX_FIT_SCALE,
      DEFAULT_SPRITE_GENERATION_SETTINGS.fitScale,
    ),
  };
}

export function loadSpriteGenerationSettings(): SpriteGenerationSettings {
  if (!hasStorage()) return DEFAULT_SPRITE_GENERATION_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return normalizeSpriteGenerationSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return DEFAULT_SPRITE_GENERATION_SETTINGS;
  }
}

export function saveSpriteGenerationSettings(settings: SpriteGenerationSettings): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(normalizeSpriteGenerationSettings(settings)),
    );
    window.dispatchEvent(new Event('fuc:sprite-generation-settings-changed'));
  } catch {
    /* non-fatal */
  }
}

export function spriteProviderById(id: SpriteProviderId): SpriteProviderDefinition {
  return SPRITE_PROVIDER_BY_ID.get(id) ?? SPRITE_PROVIDERS[0];
}

export function spriteProviderModel(
  providerId: SpriteProviderId,
  settings = loadSpriteGenerationSettings(),
): string {
  const provider = spriteProviderById(providerId);
  return settings.providerModels[providerId]?.trim() || provider.defaultModel;
}

export function spriteProviderBaseUrl(
  providerId: SpriteProviderId,
  settings = loadSpriteGenerationSettings(),
): string {
  const custom = settings.providerBaseUrls[providerId]?.trim();
  if (custom) return custom.replace(/\/+$/, '');
  return spriteProviderById(providerId).defaultBaseUrl.replace(/\/+$/, '');
}

function spriteProviderKey(
  providerId: SpriteProviderId,
  settings = loadSpriteGenerationSettings(),
): string {
  return settings.providerKeys[providerId]?.trim() ?? '';
}

export function spriteProviderReady(
  providerId: SpriteProviderId,
  settings = loadSpriteGenerationSettings(),
): boolean {
  const provider = spriteProviderById(providerId);
  if (provider.needsKey && !spriteProviderKey(providerId, settings)) return false;
  return !!spriteProviderBaseUrl(providerId, settings);
}

export function configuredSpriteProviderIds(
  settings = loadSpriteGenerationSettings(),
): SpriteProviderId[] {
  return SPRITE_PROVIDERS.filter((provider) => spriteProviderReady(provider.id, settings)).map(
    (provider) => provider.id,
  );
}

export function preferredReadySpriteProviderId(
  imageSettings = loadImageGenerationSettings(),
): ImageProviderId | null {
  return imageProviderReady(imageSettings.preferredProviderId, imageSettings)
    ? imageSettings.preferredProviderId
    : null;
}

export function looksLikeSpriteGenerationRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  if (/^\/(?:spritesheet|sprite|sprite-mode-start|精灵|精灵图|序列帧)(?:\s|$)/iu.test(normalized)) {
    return true;
  }
  const zhIntent =
    /(生成|创建|制作|做|导出|打包)[\s\S]{0,24}(sprite|spritesheet|精灵图|序列帧|帧动画|动作帧|像素动画)/iu.test(text) ||
    /(sprite|spritesheet|精灵图|序列帧|帧动画|动作帧|像素动画)[\s\S]{0,24}(生成|创建|制作|做|导出|打包)/iu.test(text);
  if (zhIntent) return true;
  return /\b(generate|create|make|produce|animate|pack|export)\b[\s\S]{0,64}\b(sprite|spritesheet|sprite sheet|frame animation|pixel animation)\b/i.test(
    normalized,
  );
}

export function stripSpriteCommand(text: string): string {
  return text
    .trim()
    .replace(/^\/(?:spritesheet|sprite|sprite-mode-start|精灵|精灵图|序列帧)\s*/iu, '')
    .replace(
      /^请?(?:帮我)?(?:生成|创建|制作|做|导出|打包)(?:一个|一套|一些)?(?:sprite|spritesheet|精灵图|序列帧|帧动画|动作帧|像素动画)?/iu,
      '',
    )
    .trim();
}

export function inferSpriteMode(prompt: string): SpriteGenerationMode {
  const text = stripSpriteCommand(prompt).toLowerCase();
  if (/motion\s*transfer|动作迁移|参考视频|视频迁移|套动作/iu.test(text)) {
    return 'motion-transfer';
  }
  if (/首帧|first\s*frame|image\s*to|图生|上传图片|参考图|animate/iu.test(text)) {
    return 'image-to-animation';
  }
  return 'text-to-sprite';
}

export async function generateSprite(
  request: SpriteGenerationRequest,
  settings = loadSpriteGenerationSettings(),
  imageSettings: ImageGenerationSettings = loadImageGenerationSettings(),
): Promise<SpriteGenerationResult> {
  if (!settings.enabled) throw new Error('SPRITE_GENERATION_DISABLED');
  const prompt = stripSpriteCommand(request.prompt);
  const settingsGrid = spriteSheetGridForSettings(settings);
  const frameCount =
    settings.sheetPreset === 'auto'
      ? clampInteger(
          request.frameCount,
          MIN_FRAME_COUNT,
          MAX_FRAME_COUNT,
          settings.defaultFrameCount,
        )
      : settingsGrid.cells;
  const frameSize = clampInteger(
    request.frameSize,
    MIN_FRAME_SIZE,
    MAX_FRAME_SIZE,
    settings.defaultFrameSize,
  );
  const mode = request.mode ?? inferSpriteMode(prompt);
  const imageResult = await generateImage(
    {
      prompt: spritePromptWithContract({
        prompt,
        model: request.model?.trim() || '',
        mode,
        frameCount,
        frameSize,
        removeBackground: request.removeBackground ?? settings.removeBackground,
        autoTrim: request.autoTrim ?? settings.autoTrim,
        alignFrames: request.alignFrames ?? settings.alignFrames,
        packSpritesheet: request.packSpritesheet ?? settings.packSpritesheet,
        sheetPreset: settings.sheetPreset,
        sheetRows: settingsGrid.rows,
        sheetColumns: settingsGrid.columns,
        chromaKey: settings.chromaKey,
        frameAnchor: settings.frameAnchor,
        componentMode: settings.componentMode,
        rejectEdgeTouch: settings.rejectEdgeTouch,
        fitScale: settings.fitScale,
      }),
      providerId: request.providerId ?? imageSettings.preferredProviderId,
      model: request.model,
      signal: request.signal,
    },
    imageSettings,
  );
  return {
    providerId: imageResult.providerId,
    providerLabel: imageResult.providerLabel,
    model: imageResult.model,
    prompt,
    mode,
    frameCount,
    frameSize,
    spritesheets: imageResult.images,
    frames: [],
    gifs: [],
    videos: [],
    metadata: [],
  };
}

interface SpriteProviderPayload {
  prompt: string;
  model: string;
  mode: SpriteGenerationMode;
  frameCount: number;
  frameSize: number;
  removeBackground: boolean;
  autoTrim: boolean;
  alignFrames: boolean;
  packSpritesheet: boolean;
  sheetPreset: SpriteSheetPreset;
  sheetRows: number;
  sheetColumns: number;
  chromaKey: string;
  frameAnchor: SpriteFrameAnchor;
  componentMode: SpriteComponentMode;
  rejectEdgeTouch: boolean;
  fitScale: number;
}

function spriteGridForPayload(
  payload: Pick<SpriteProviderPayload, 'sheetPreset' | 'sheetRows' | 'sheetColumns' | 'frameCount'>,
): { rows: number; columns: number; cells: number; label: string } {
  return spriteSheetGridForSettings({
    sheetPreset: payload.sheetPreset,
    sheetRows: payload.sheetRows,
    sheetColumns: payload.sheetColumns,
    defaultFrameCount: payload.frameCount,
  });
}

function spritePromptWithContract(payload: SpriteProviderPayload): string {
  const grid = spriteGridForPayload(payload);
  const backgroundLine = payload.removeBackground
    ? `raw sheet background must be solid ${payload.chromaKey} chroma key, perfectly flat, no transparency before postprocess`
    : 'clean transparent or flat plain background';
  return [
    payload.prompt.trim(),
    '',
    'Sprite Forge compatible raw spritesheet constraints:',
    `- exact layout: ${grid.rows} rows x ${grid.columns} columns, ${payload.frameCount} frames, each frame ${payload.frameSize}x${payload.frameSize}px`,
    `- ${backgroundLine}`,
    '- one subject and one action only, consistent identity, proportions, facing direction, lighting, and silhouette across all frames',
    `- stable ${payload.frameAnchor} anchor, centered subject, even spacing, safe margins, no frame touches canvas edge`,
    '- no text, labels, UI, watermark, border, grid line, scenery, shadow-only artifacts, duplicate poses, or mixed actions',
    '- output a single game-ready spritesheet suitable for deterministic chroma-key cleanup, frame extraction, alignment, and QC',
  ].join('\n');
}
