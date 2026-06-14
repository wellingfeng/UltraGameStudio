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
}

export interface SpriteGenerationRequest {
  prompt: string;
  providerId?: SpriteProviderId;
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
  providerId: SpriteProviderId;
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
};

function hasStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage;
}

export function isSpriteProviderId(value: unknown): value is SpriteProviderId {
  return typeof value === 'string' && SPRITE_PROVIDER_BY_ID.has(value as SpriteProviderId);
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
  settings = loadSpriteGenerationSettings(),
): SpriteProviderId | null {
  if (spriteProviderReady(settings.preferredProviderId, settings)) {
    return settings.preferredProviderId;
  }
  return configuredSpriteProviderIds(settings)[0] ?? null;
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
): Promise<SpriteGenerationResult> {
  if (!settings.enabled) throw new Error('SPRITE_GENERATION_DISABLED');
  const providerId = request.providerId ?? preferredReadySpriteProviderId(settings);
  if (!providerId) throw new Error('NO_READY_SPRITE_PROVIDER');
  if (!spriteProviderReady(providerId, settings)) {
    throw new Error(`SPRITE_PROVIDER_NOT_READY:${providerId}`);
  }
  const provider = spriteProviderById(providerId);
  const prompt = stripSpriteCommand(request.prompt);
  const model = request.model?.trim() || spriteProviderModel(providerId, settings);
  const frameCount = clampInteger(
    request.frameCount,
    MIN_FRAME_COUNT,
    MAX_FRAME_COUNT,
    settings.defaultFrameCount,
  );
  const frameSize = clampInteger(
    request.frameSize,
    MIN_FRAME_SIZE,
    MAX_FRAME_SIZE,
    settings.defaultFrameSize,
  );
  const mode = request.mode ?? inferSpriteMode(prompt);
  const assets = await generateWithProvider(
    providerId,
    {
      prompt,
      model,
      mode,
      frameCount,
      frameSize,
      removeBackground: request.removeBackground ?? settings.removeBackground,
      autoTrim: request.autoTrim ?? settings.autoTrim,
      alignFrames: request.alignFrames ?? settings.alignFrames,
      packSpritesheet: request.packSpritesheet ?? settings.packSpritesheet,
    },
    settings,
    request.signal,
  );
  return {
    providerId,
    providerLabel: provider.label,
    model,
    prompt,
    mode,
    frameCount,
    frameSize,
    ...assets,
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
}

interface SpriteAssets {
  spritesheets: string[];
  frames: string[];
  gifs: string[];
  videos: string[];
  metadata: string[];
}

async function generateWithProvider(
  providerId: SpriteProviderId,
  payload: SpriteProviderPayload,
  settings: SpriteGenerationSettings,
  signal?: AbortSignal,
): Promise<SpriteAssets> {
  switch (spriteProviderById(providerId).apiKind) {
    case 'ludo-compatible':
      return generateLudoSprite(payload, settings, signal);
    case 'generic-local-sprite':
      return generateGenericLocalSprite(providerId, payload, settings, signal);
    default:
      throw new Error(`Unsupported sprite provider: ${providerId}`);
  }
}

function spriteRequestBody(payload: SpriteProviderPayload): Record<string, unknown> {
  return {
    prompt: payload.prompt,
    model: payload.model,
    mode: payload.mode,
    generation_mode: payload.mode,
    action: spriteActionForMode(payload.mode),
    frame_count: payload.frameCount,
    frames: payload.frameCount,
    frame_size: payload.frameSize,
    width: payload.frameSize,
    height: payload.frameSize,
    transparent_background: payload.removeBackground,
    remove_background: payload.removeBackground,
    auto_trim: payload.autoTrim,
    trim: payload.autoTrim,
    align_frames: payload.alignFrames,
    align: payload.alignFrames,
    pack_spritesheet: payload.packSpritesheet,
    spritesheet: payload.packSpritesheet,
    output_formats: ['spritesheet', 'frames', 'gif', 'mp4', 'json'],
    postprocess: {
      ffmpeg_extract_frames: true,
      remove_background: payload.removeBackground,
      align_frames: payload.alignFrames,
      auto_trim: payload.autoTrim,
      pack_spritesheet: payload.packSpritesheet,
    },
  };
}

function spriteActionForMode(mode: SpriteGenerationMode): string {
  if (mode === 'motion-transfer') return 'transferMotion';
  if (mode === 'image-to-animation') return 'animateSprite';
  return 'createImage';
}

async function generateLudoSprite(
  payload: SpriteProviderPayload,
  settings: SpriteGenerationSettings,
  signal?: AbortSignal,
): Promise<SpriteAssets> {
  const apiKey = spriteProviderKey('ludo-sprite', settings);
  if (!apiKey) throw new Error('Ludo API key is missing.');
  const baseUrl = spriteProviderBaseUrl('ludo-sprite', settings);
  const response = await fetch(`${baseUrl}/sprite/generations`, {
    method: 'POST',
    headers: {
      Authorization: apiKey.toLowerCase().startsWith('bearer ') ? apiKey : `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(spriteRequestBody(payload)),
    signal,
  });
  return waitForSpriteAssets(response, 'Ludo.ai Sprite Generator', settings, 'ludo-sprite', signal);
}

async function generateGenericLocalSprite(
  providerId: SpriteProviderId,
  payload: SpriteProviderPayload,
  settings: SpriteGenerationSettings,
  signal?: AbortSignal,
): Promise<SpriteAssets> {
  const baseUrl = spriteProviderBaseUrl(providerId, settings);
  const apiKey = spriteProviderKey(providerId, settings);
  const headers: Record<string, string> = {
    Accept: 'image/*, video/*, application/json, application/zip',
    'Content-Type': 'application/json',
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(spriteRequestBody(payload)),
    signal,
  });
  return waitForSpriteAssets(response, spriteProviderById(providerId).label, settings, providerId, signal);
}

async function waitForSpriteAssets(
  response: Response,
  providerLabel: string,
  settings: SpriteGenerationSettings,
  providerId: SpriteProviderId,
  signal?: AbortSignal,
): Promise<SpriteAssets> {
  const started = await readResponseJsonOrSpriteAssets(response, providerLabel);
  const immediate = spriteAssetsFromJson(started);
  if (spriteAssetsReady(immediate) && isTerminalSuccess(started)) return immediate;
  const statusUrl = statusUrlFromUnknown(started);
  const taskId = taskIdFromJson(started);
  if (!statusUrl && !taskId) {
    if (spriteAssetsReady(immediate)) return immediate;
    throw new Error(`${providerLabel} returned no sprite assets.`);
  }
  const baseUrl = spriteProviderBaseUrl(providerId, settings);
  for (let i = 0; i < 180; i += 1) {
    await delay(2000, signal);
    const pollUrl =
      statusUrl || `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(taskId ?? '')}`;
    const pollResponse = await fetch(pollUrl, {
      headers: authHeadersForProvider(providerId, settings),
      signal,
    });
    const status = await readResponseJsonOrSpriteAssets(pollResponse, providerLabel);
    const state = jsonState(status);
    if (isFailedState(state)) {
      throw new Error(providerErrorMessage(status) || `${providerLabel} generation failed.`);
    }
    const assets = spriteAssetsFromJson(status);
    if (spriteAssetsReady(assets) && (isSuccessState(state, status) || state === '')) return assets;
  }
  throw new Error(`${providerLabel} job timed out before sprite assets were ready.`);
}

function authHeadersForProvider(
  providerId: SpriteProviderId,
  settings: SpriteGenerationSettings,
): Record<string, string> {
  const apiKey = spriteProviderKey(providerId, settings);
  if (!apiKey) return {};
  return {
    Authorization: apiKey.toLowerCase().startsWith('bearer ') ? apiKey : `Bearer ${apiKey}`,
  };
}

async function readResponseJsonOrSpriteAssets(
  response: Response,
  providerLabel: string,
): Promise<Record<string, unknown>> {
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`${providerLabel} ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 240)}` : ''}`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.startsWith('image/')) {
    const blob = await response.blob();
    const src = await blobToDataUrl(blob);
    return contentType.includes('gif')
      ? { gif_url: src, status: 'succeeded' }
      : { spritesheet_url: src, status: 'succeeded' };
  }
  if (contentType.startsWith('video/')) {
    const bytes = arrayBufferToBase64(await response.arrayBuffer());
    return { video_url: `data:${contentType.split(';')[0]};base64,${bytes}`, status: 'succeeded' };
  }
  const json = await response.json().catch(() => null);
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error(`${providerLabel} returned a non-JSON response.`);
  }
  return json as Record<string, unknown>;
}

function spriteAssetsFromJson(json: Record<string, unknown>): SpriteAssets {
  const out: SpriteAssets = {
    spritesheets: [],
    frames: [],
    gifs: [],
    videos: [],
    metadata: [],
  };
  for (const src of spriteSourcesFromUnknown(json)) {
    pushSpriteSource(out, src);
  }
  return out;
}

interface SpriteSource {
  url: string;
  kind: 'spritesheet' | 'frame' | 'gif' | 'video' | 'metadata';
}

function pushSpriteSource(out: SpriteAssets, source: SpriteSource): void {
  const list =
    source.kind === 'spritesheet'
      ? out.spritesheets
      : source.kind === 'frame'
        ? out.frames
        : source.kind === 'gif'
          ? out.gifs
          : source.kind === 'video'
            ? out.videos
            : out.metadata;
  if (source.url && !list.includes(source.url)) list.push(source.url);
}

function spriteSourcesFromUnknown(value: unknown, keyHint = ''): SpriteSource[] {
  if (!value) return [];
  if (typeof value === 'string') {
    const source = spriteSourceFromString(value, keyHint);
    return source ? [source] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => spriteSourcesFromUnknown(item, keyHint));
  }
  if (typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const sources: SpriteSource[] = [];
  const push = (items: SpriteSource[]) => {
    for (const item of items) {
      if (!item.url) continue;
      if (sources.some((existing) => existing.url === item.url && existing.kind === item.kind)) {
        continue;
      }
      sources.push(item);
    }
  };
  const inlineData = objectValue(record.inlineData) ?? objectValue(record.inline_data);
  if (inlineData) {
    const data = stringValue(inlineData.data);
    const mimeType = stringValue(inlineData.mimeType) || stringValue(inlineData.mime_type);
    if (data) {
      push([{
        url: dataUrlFromMime(data, mimeType || 'image/png'),
        kind: sourceKindFromMime(mimeType || 'image/png', keyHint),
      }]);
    }
  }
  const bytesBase64 =
    stringValue(record.bytesBase64Encoded) ||
    stringValue(record.bytes_base64_encoded) ||
    stringValue(record.base64) ||
    stringValue(record.b64);
  if (bytesBase64) {
    const mimeType = stringValue(record.mimeType) || stringValue(record.mime_type) || mimeFromKeyHint(keyHint);
    push([{
      url: dataUrlFromMime(bytesBase64, mimeType || 'image/png'),
      kind: sourceKindFromMime(mimeType || 'image/png', keyHint),
    }]);
  }
  for (const key of [
    'spritesheet',
    'spritesheet_url',
    'spritesheetUrl',
    'sprite_sheet',
    'spriteSheet',
    'sheet',
    'sheet_url',
    'sheetUrl',
    'frames',
    'frame_urls',
    'frameUrls',
    'images',
    'image_urls',
    'imageUrls',
    'gif',
    'gif_url',
    'gifUrl',
    'animation',
    'animation_url',
    'animationUrl',
    'video',
    'video_url',
    'videoUrl',
    'mp4',
    'mp4_url',
    'metadata',
    'metadata_url',
    'metadataUrl',
    'json',
    'json_url',
    'jsonUrl',
    'assets',
    'asset',
    'outputs',
    'output',
    'result',
    'results',
    'data',
    'files',
    'file',
    'url',
    'uri',
  ]) {
    push(spriteSourcesFromUnknown(record[key], key));
  }
  for (const [key, child] of Object.entries(record)) {
    if (key in record && keyHint === key) continue;
    push(spriteSourcesFromUnknown(child, key));
  }
  return sources;
}

function spriteSourceFromString(value: string, keyHint: string): SpriteSource | null {
  const src = value.trim();
  if (!src) return null;
  if (/^data:/i.test(src)) {
    return { url: src, kind: sourceKindFromMime(src.slice(5, src.indexOf(';')), keyHint) };
  }
  if (/^https?:\/\//i.test(src) || /^file:\/\//i.test(src)) {
    return { url: src, kind: sourceKindFromUrl(src, keyHint) };
  }
  if (/^[A-Za-z0-9+/]+={0,2}$/u.test(src) && src.length > 80 && /base64|b64|image|video|gif|sprite|frame|sheet|json/i.test(keyHint)) {
    const mime = mimeFromKeyHint(keyHint);
    return { url: dataUrlFromMime(src, mime), kind: sourceKindFromMime(mime, keyHint) };
  }
  return null;
}

function sourceKindFromUrl(
  src: string,
  keyHint: string,
): SpriteSource['kind'] {
  if (/\.(?:gif)(?:[?#]|$)/i.test(src) || /gif/i.test(keyHint)) return 'gif';
  if (/\.(?:mp4|webm|mov|m4v)(?:[?#]|$)/i.test(src) || /video|mp4|movie|clip/i.test(keyHint)) return 'video';
  if (/\.(?:json)(?:[?#]|$)/i.test(src) || /metadata|json/i.test(keyHint)) return 'metadata';
  if (/frame|frames/i.test(keyHint)) return 'frame';
  return 'spritesheet';
}

function sourceKindFromMime(
  mime: string,
  keyHint: string,
): SpriteSource['kind'] {
  if (/gif/i.test(mime) || /gif/i.test(keyHint)) return 'gif';
  if (/^video\//i.test(mime) || /video|mp4|movie|clip/i.test(keyHint)) return 'video';
  if (/json/i.test(mime) || /metadata|json/i.test(keyHint)) return 'metadata';
  if (/frame|frames/i.test(keyHint)) return 'frame';
  return 'spritesheet';
}

function mimeFromKeyHint(keyHint: string): string {
  if (/gif/i.test(keyHint)) return 'image/gif';
  if (/video|mp4|movie|clip/i.test(keyHint)) return 'video/mp4';
  if (/metadata|json/i.test(keyHint)) return 'application/json';
  return 'image/png';
}

function dataUrlFromMime(base64: string, mimeType: string): string {
  const clean = base64.trim().replace(/^data:[^;]+;base64,/i, '');
  return `data:${mimeType || 'image/png'};base64,${clean}`;
}

function spriteAssetsReady(assets: SpriteAssets): boolean {
  return (
    assets.spritesheets.length > 0 ||
    assets.frames.length > 0 ||
    assets.gifs.length > 0 ||
    assets.videos.length > 0
  );
}

function taskIdFromJson(json: Record<string, unknown>): string {
  return (
    stringValue(json.id) ||
    stringValue(json.task_id) ||
    stringValue(json.taskId) ||
    stringValue(json.request_id) ||
    stringValue(json.requestId) ||
    stringValue(json.generation_id) ||
    stringValue(json.generationId) ||
    stringValue(objectValue(json.output)?.task_id) ||
    stringValue(objectValue(json.data)?.task_id) ||
    stringValue(objectValue(json.data)?.id)
  );
}

function statusUrlFromUnknown(json: Record<string, unknown>): string {
  return (
    stringValue(json.status_url) ||
    stringValue(json.statusUrl) ||
    stringValue(json.polling_url) ||
    stringValue(json.pollingUrl) ||
    stringValue(json.get_url) ||
    stringValue(json.getUrl) ||
    stringValue(objectValue(json.urls)?.get) ||
    stringValue(objectValue(json.urls)?.status)
  );
}

function jsonState(json: Record<string, unknown>): string {
  return (
    stringValue(json.status) ||
    stringValue(json.state) ||
    stringValue(json.task_status) ||
    stringValue(json.taskStatus) ||
    stringValue(json.phase) ||
    stringValue(objectValue(json.output)?.task_status) ||
    stringValue(objectValue(json.data)?.status) ||
    ''
  ).toLowerCase();
}

function isFailedState(state: string): boolean {
  return [
    'failed',
    'failure',
    'error',
    'errored',
    'canceled',
    'cancelled',
    'rejected',
    'blocked',
  ].includes(state.toLowerCase());
}

function isSuccessState(state: string, json: Record<string, unknown>): boolean {
  const normalized = state.toLowerCase();
  return (
    json.done === true ||
    json.completed === true ||
    [
      'succeeded',
      'success',
      'completed',
      'complete',
      'done',
      'ready',
      'finish',
      'finished',
    ].includes(normalized)
  );
}

function isTerminalSuccess(json: Record<string, unknown>): boolean {
  return isSuccessState(jsonState(json), json);
}

function providerErrorMessage(json: Record<string, unknown>): string {
  return (
    stringValue(json.error) ||
    stringValue(json.message) ||
    stringValue(json.msg) ||
    stringValue(json.failure_reason) ||
    stringValue(json.failureReason) ||
    stringValue(objectValue(json.error)?.message) ||
    stringValue(objectValue(json.data)?.error) ||
    ''
  );
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read sprite blob.'));
    reader.readAsDataURL(blob);
  });
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
