export type ImageProviderId =
  | 'siliconflow'
  | 'cloudflare'
  | 'pollinations'
  | 'ai-horde'
  | 'local-comfyui'
  | 'zhipu-cogview'
  | 'dashscope-wanx'
  | 'minimax'
  | 'volcengine-seedream';

export type ImageProviderCategory = 'commercial' | 'free-credit';

type ImageProviderApiKind =
  | 'cloudflare'
  | 'pollinations'
  | 'ai-horde'
  | 'comfyui'
  | 'siliconflow'
  | 'zhipu-openai'
  | 'dashscope-wanx'
  | 'minimax'
  | 'volcengine-openai';

export interface ImageProviderDefinition {
  id: ImageProviderId;
  label: string;
  category: ImageProviderCategory;
  apiKind: ImageProviderApiKind;
  defaultModel: string;
  models: string[];
  needsKey: boolean;
  needsAccountId?: boolean;
  local: boolean;
  defaultBaseUrl?: string;
  supportsBaseUrl?: boolean;
  endpointPlaceholder: string;
  credentialUrl?: string;
  note: string;
}

export interface ImageGenerationSettings {
  enabled: boolean;
  showComposerModelSelect: boolean;
  preferredProviderId: ImageProviderId;
  providerKeys: Partial<Record<ImageProviderId, string>>;
  providerAccountIds: Partial<Record<ImageProviderId, string>>;
  providerBaseUrls: Partial<Record<ImageProviderId, string>>;
  providerModels: Partial<Record<ImageProviderId, string>>;
}

export interface ImageGenerationResult {
  providerId: ImageProviderId;
  providerLabel: string;
  model: string;
  prompt: string;
  images: string[];
}

export interface ImageGenerationRequest {
  prompt: string;
  providerId?: ImageProviderId;
  model?: string;
  signal?: AbortSignal;
}

const STORAGE_KEY = 'freeultracode.imageGeneration.v1';

export const IMAGE_PROVIDERS: ImageProviderDefinition[] = [
  {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    category: 'free-credit',
    apiKind: 'siliconflow',
    defaultModel: 'Kwai-Kolors/Kolors',
    models: [
      'Kwai-Kolors/Kolors',
      'Qwen/Qwen-Image',
      'black-forest-labs/FLUX.1-schnell',
    ],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.siliconflow.cn/v1',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.siliconflow.cn/v1',
    credentialUrl: 'https://cloud.siliconflow.cn/account/ak',
    note: '中文服务优先。使用 /images/generations 文生图接口，支持 Qwen-Image、Kolors、FLUX 等模型；注册送额度或部分免费模型以控制台为准。',
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare Workers AI',
    category: 'free-credit',
    apiKind: 'cloudflare',
    defaultModel: '@cf/bytedance/stable-diffusion-xl-lightning',
    models: [
      '@cf/bytedance/stable-diffusion-xl-lightning',
      '@cf/black-forest-labs/flux-1-schnell',
    ],
    needsKey: true,
    needsAccountId: true,
    local: false,
    endpointPlaceholder: 'https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/run',
    credentialUrl: 'https://dash.cloudflare.com/?to=%2F%3Aaccount%2Fai%2Fworkers-ai',
    note: 'Free daily Workers AI quota. Open Workers AI, choose Use REST API, then copy the Account ID and API token.',
  },
  {
    id: 'pollinations',
    label: 'Pollinations',
    category: 'free-credit',
    apiKind: 'pollinations',
    defaultModel: 'flux',
    models: ['flux', 'zimage', 'qwen-image', 'seedream', 'gptimage'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://gen.pollinations.ai',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://gen.pollinations.ai',
    credentialUrl: 'https://enter.pollinations.ai',
    note: '新版统一 API。所有生成请求都需要 API Key；Secret Key 无速率限制，Publishable Key 有更严格额度。',
  },
  {
    id: 'ai-horde',
    label: 'AI Horde',
    category: 'free-credit',
    apiKind: 'ai-horde',
    defaultModel: 'stable_diffusion',
    models: ['stable_diffusion', 'flux_1_schnell', 'SDXL 1.0'],
    needsKey: false,
    local: false,
    defaultBaseUrl: 'https://stablehorde.net/api/v2',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://stablehorde.net/api/v2',
    credentialUrl: 'https://stablehorde.net/register',
    note: 'Community compute pool. Register for a recoverable API key; anonymous usage works but queues can be slow.',
  },
  {
    id: 'local-comfyui',
    label: 'ComfyUI (local)',
    category: 'free-credit',
    apiKind: 'comfyui',
    defaultModel: 'default',
    models: ['default', 'flux-schnell', 'sdxl-lightning', 'z-image-turbo', 'qwen-image'],
    needsKey: false,
    local: true,
    defaultBaseUrl: 'http://127.0.0.1:8188',
    supportsBaseUrl: true,
    endpointPlaceholder: 'http://127.0.0.1:8188',
    credentialUrl: 'https://github.com/comfyanonymous/ComfyUI',
    note: 'Uses a local ComfyUI HTTP server. The first version calls a simple custom /prompt-text-to-image style endpoint when present.',
  },
  {
    id: 'zhipu-cogview',
    label: '智谱 CogView',
    category: 'commercial',
    apiKind: 'zhipu-openai',
    defaultModel: 'cogview-4-250304',
    models: ['cogview-4-250304', 'cogview-4'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://open.bigmodel.cn/api/paas/v4',
    credentialUrl: 'https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys',
    note: '中文商业服务。CogView-4 支持中英双语提示词和中文文字生成；按次计费，Key 在智谱开放平台创建。',
  },
  {
    id: 'dashscope-wanx',
    label: '阿里百炼 通义万相',
    category: 'commercial',
    apiKind: 'dashscope-wanx',
    defaultModel: 'wan2.6-t2i',
    models: [
      'wan2.6-t2i',
      'wan2.5-t2i-preview',
      'wan2.2-t2i-flash',
      'qwen-image-plus',
      'qwen-image',
    ],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://dashscope.aliyuncs.com/api/v1',
    credentialUrl: 'https://bailian.console.aliyun.com/?apiKey=1#/api-key-center',
    note: '中文商业服务。默认使用百炼北京地域 DashScope API；wan2.6 走同步文生图接口，旧版 Wan/Qwen Image 走任务轮询。',
  },
  {
    id: 'minimax',
    label: 'MiniMax 海螺',
    category: 'commercial',
    apiKind: 'minimax',
    defaultModel: 'image-01',
    models: ['image-01', 'image-01-live'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.minimax.io/v1',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.minimax.io/v1',
    credentialUrl: 'https://platform.minimax.io/user-center/basic-information',
    note: '中文友好的多模态商业服务。图片接口使用 /image_generation，支持文生图和参考图能力。',
  },
  {
    id: 'volcengine-seedream',
    label: '火山方舟 Seedream',
    category: 'commercial',
    apiKind: 'volcengine-openai',
    defaultModel: 'doubao-seedream-5-0-260128',
    models: [
      'doubao-seedream-5-0-260128',
      'doubao-seedream-5-0-lite-260128',
      'doubao-seedream-4-5-251128',
      'doubao-seedream-4-0-250828',
    ],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://ark.cn-beijing.volces.com/api/v3',
    credentialUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apikey',
    note: '中文商业服务。方舟图片生成 API 兼容 OpenAI images/generations 路径，Seedream 支持高分辨率和组图能力。',
  },
];

const IMAGE_PROVIDER_BY_ID = new Map(IMAGE_PROVIDERS.map((provider) => [provider.id, provider]));

function encodeModelPath(model: string): string {
  return model.split('/').map((part) => encodeURIComponent(part)).join('/');
}

export const DEFAULT_IMAGE_GENERATION_SETTINGS: ImageGenerationSettings = {
  enabled: true,
  showComposerModelSelect: false,
  preferredProviderId: 'siliconflow',
  providerKeys: {},
  providerAccountIds: {},
  providerBaseUrls: {},
  providerModels: {},
};

function hasStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage;
}

function isImageProviderId(value: unknown): value is ImageProviderId {
  return typeof value === 'string' && IMAGE_PROVIDER_BY_ID.has(value as ImageProviderId);
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

export function normalizeImageGenerationSettings(
  value: unknown,
): ImageGenerationSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return DEFAULT_IMAGE_GENERATION_SETTINGS;
  }
  const source = value as Partial<ImageGenerationSettings>;
  const preferredProviderId = isImageProviderId(source.preferredProviderId)
    ? source.preferredProviderId
    : DEFAULT_IMAGE_GENERATION_SETTINGS.preferredProviderId;
  return {
    enabled:
      typeof source.enabled === 'boolean'
        ? source.enabled
        : DEFAULT_IMAGE_GENERATION_SETTINGS.enabled,
    showComposerModelSelect:
      typeof source.showComposerModelSelect === 'boolean'
        ? source.showComposerModelSelect
        : DEFAULT_IMAGE_GENERATION_SETTINGS.showComposerModelSelect,
    preferredProviderId,
    providerKeys: cleanRecord(source.providerKeys, isImageProviderId),
    providerAccountIds: cleanRecord(source.providerAccountIds, isImageProviderId),
    providerBaseUrls: cleanRecord(source.providerBaseUrls, isImageProviderId),
    providerModels: cleanRecord(source.providerModels, isImageProviderId),
  };
}

export function loadImageGenerationSettings(): ImageGenerationSettings {
  if (!hasStorage()) return DEFAULT_IMAGE_GENERATION_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return normalizeImageGenerationSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return DEFAULT_IMAGE_GENERATION_SETTINGS;
  }
}

export function saveImageGenerationSettings(settings: ImageGenerationSettings): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(normalizeImageGenerationSettings(settings)),
    );
    window.dispatchEvent(new Event('fuc:image-generation-settings-changed'));
  } catch {
    /* non-fatal */
  }
}

export function imageProviderById(
  id: ImageProviderId,
): ImageProviderDefinition {
  return IMAGE_PROVIDER_BY_ID.get(id) ?? IMAGE_PROVIDERS[0];
}

export function imageProviderModel(
  providerId: ImageProviderId,
  settings = loadImageGenerationSettings(),
): string {
  const provider = imageProviderById(providerId);
  return settings.providerModels[providerId]?.trim() || provider.defaultModel;
}

export function imageProviderBaseUrl(
  providerId: ImageProviderId,
  settings = loadImageGenerationSettings(),
): string {
  const custom = settings.providerBaseUrls[providerId]?.trim();
  if (custom) return custom.replace(/\/+$/, '');
  return (imageProviderById(providerId).defaultBaseUrl ?? '').replace(/\/+$/, '');
}

export function configuredImageProviderIds(
  settings = loadImageGenerationSettings(),
): ImageProviderId[] {
  return IMAGE_PROVIDERS.filter((provider) => imageProviderReady(provider.id, settings)).map(
    (provider) => provider.id,
  );
}

export function imageProviderReady(
  providerId: ImageProviderId,
  settings = loadImageGenerationSettings(),
): boolean {
  const provider = imageProviderById(providerId);
  if (provider.needsKey && !settings.providerKeys[providerId]?.trim()) return false;
  if (
    provider.needsAccountId &&
    !settings.providerAccountIds[providerId]?.trim()
  ) {
    return false;
  }
  if (provider.local && !imageProviderBaseUrl(providerId, settings)) return false;
  return true;
}

export function preferredReadyImageProviderId(
  settings = loadImageGenerationSettings(),
): ImageProviderId | null {
  if (imageProviderReady(settings.preferredProviderId, settings)) {
    return settings.preferredProviderId;
  }
  return configuredImageProviderIds(settings)[0] ?? null;
}

export function looksLikeImageGenerationRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  if (/^\/(?:image|img|draw|生图|画图)(?:\s|$)/iu.test(normalized)) return true;
  const zhIntent =
    /(生成|画|绘制|做|制作|设计|出|来)[\s\S]{0,18}(图|图片|插画|海报|头像|壁纸|封面|logo|图标|照片|视觉|配图)/u.test(
      text,
    ) ||
    /(图|图片|插画|海报|头像|壁纸|封面|logo|图标|照片|视觉|配图)[\s\S]{0,18}(生成|画|绘制|做|制作|设计)/u.test(
      text,
    );
  if (zhIntent) return true;
  return /\b(generate|create|draw|paint|render|make|design)\b[\s\S]{0,48}\b(image|picture|illustration|poster|avatar|wallpaper|cover|logo|icon|photo)\b/i.test(
    normalized,
  );
}

export function stripImageCommand(text: string): string {
  return text
    .trim()
    .replace(/^\/(?:image|img|draw|生图|画图)\s+/iu, '')
    .replace(/^请?(?:帮我)?(?:生成|画|绘制|做|制作|设计)(?:一张|一个|一些)?/u, '')
    .trim();
}

export async function generateImage(
  request: ImageGenerationRequest,
  settings = loadImageGenerationSettings(),
): Promise<ImageGenerationResult> {
  if (!settings.enabled) throw new Error('IMAGE_GENERATION_DISABLED');
  const providerId = request.providerId ?? preferredReadyImageProviderId(settings);
  if (!providerId) throw new Error('NO_READY_IMAGE_PROVIDER');
  if (!imageProviderReady(providerId, settings)) {
    throw new Error(`IMAGE_PROVIDER_NOT_READY:${providerId}`);
  }
  const provider = imageProviderById(providerId);
  const prompt = stripImageCommand(request.prompt);
  const model = request.model?.trim() || imageProviderModel(providerId, settings);
  const images = await generateWithProvider(providerId, prompt, model, settings, request.signal);
  return {
    providerId,
    providerLabel: provider.label,
    model,
    prompt,
    images,
  };
}

async function generateWithProvider(
  providerId: ImageProviderId,
  prompt: string,
  model: string,
  settings: ImageGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  switch (imageProviderById(providerId).apiKind) {
    case 'cloudflare':
      return generateCloudflare(prompt, model, settings, signal);
    case 'pollinations':
      return generatePollinations(prompt, model, settings, signal);
    case 'ai-horde':
      return generateAiHorde(prompt, model, settings, signal);
    case 'siliconflow':
      return generateSiliconFlow(prompt, model, settings, signal);
    case 'zhipu-openai':
      return generateOpenAiImages(providerId, prompt, model, settings, signal);
    case 'dashscope-wanx':
      return generateDashScopeWanx(prompt, model, settings, signal);
    case 'minimax':
      return generateMiniMax(prompt, model, settings, signal);
    case 'volcengine-openai':
      return generateVolcengineSeedream(prompt, model, settings, signal);
    case 'comfyui':
      return generateComfyUi(prompt, model, settings, signal);
  }
}

async function generateCloudflare(
  prompt: string,
  model: string,
  settings: ImageGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const accountId = settings.providerAccountIds.cloudflare?.trim();
  const apiKey = settings.providerKeys.cloudflare?.trim();
  if (!accountId || !apiKey) throw new Error('Cloudflare Account ID or API token is missing.');
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
      accountId,
    )}/ai/run/${encodeModelPath(model)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prompt }),
      signal,
    },
  );
  return imagesFromResponse(response);
}

async function generatePollinations(
  prompt: string,
  model: string,
  settings: ImageGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = settings.providerKeys.pollinations?.trim();
  const headers: Record<string, string> = {
    Accept: 'image/*',
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const url = new URL(
    `${imageProviderBaseUrl('pollinations', settings)}/image/${encodeURIComponent(prompt)}`,
  );
  url.searchParams.set('model', model);
  url.searchParams.set('width', '1024');
  url.searchParams.set('height', '1024');
  url.searchParams.set('enhance', 'true');
  if (apiKey) url.searchParams.set('key', apiKey);
  const response = await fetch(url.toString(), {
    method: 'GET',
    headers,
    signal,
  });
  return imagesFromResponse(response);
}

async function generateSiliconFlow(
  prompt: string,
  model: string,
  settings: ImageGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = settings.providerKeys.siliconflow?.trim();
  if (!apiKey) throw new Error('SiliconFlow API key is missing.');
  const isQwenImage = model.startsWith('Qwen/Qwen-Image');
  const response = await fetch(`${imageProviderBaseUrl('siliconflow', settings)}/images/generations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      prompt,
      image_size: isQwenImage ? '1328x1328' : '1024x1024',
      batch_size: 1,
      num_inference_steps: isQwenImage ? 50 : 20,
      ...(isQwenImage ? { cfg: 4 } : { guidance_scale: 7.5 }),
    }),
    signal,
  });
  return imagesFromResponse(response);
}

async function generateOpenAiImages(
  providerId: ImageProviderId,
  prompt: string,
  model: string,
  settings: ImageGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const provider = imageProviderById(providerId);
  const apiKey = settings.providerKeys[providerId]?.trim();
  if (!apiKey) throw new Error(`${provider.label} API key is missing.`);
  const response = await fetch(`${imageProviderBaseUrl(providerId, settings)}/images/generations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      prompt,
      n: 1,
      size: '1024x1024',
      response_format: 'url',
    }),
    signal,
  });
  return imagesFromResponse(response);
}

async function generateMiniMax(
  prompt: string,
  model: string,
  settings: ImageGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = settings.providerKeys.minimax?.trim();
  if (!apiKey) throw new Error('MiniMax API key is missing.');
  const response = await fetch(`${imageProviderBaseUrl('minimax', settings)}/image_generation`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      prompt,
      aspect_ratio: '1:1',
      response_format: 'url',
      n: 1,
      prompt_optimizer: true,
    }),
    signal,
  });
  return imagesFromResponse(response);
}

async function generateVolcengineSeedream(
  prompt: string,
  model: string,
  settings: ImageGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = settings.providerKeys['volcengine-seedream']?.trim();
  if (!apiKey) throw new Error('Volcengine Ark API key is missing.');
  const response = await fetch(
    `${imageProviderBaseUrl('volcengine-seedream', settings)}/images/generations`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        prompt,
        size: '2K',
        response_format: 'url',
        watermark: false,
        sequential_image_generation: 'disabled',
      }),
      signal,
    },
  );
  return imagesFromResponse(response);
}

async function generateDashScopeWanx(
  prompt: string,
  model: string,
  settings: ImageGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = settings.providerKeys['dashscope-wanx']?.trim();
  if (!apiKey) throw new Error('DashScope API key is missing.');
  const baseUrl = imageProviderBaseUrl('dashscope-wanx', settings);
  if (model.startsWith('wan2.6')) {
    const response = await fetch(`${baseUrl}/services/aigc/multimodal-generation/generation`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: {
          messages: [
            {
              role: 'user',
              content: [{ text: prompt }],
            },
          ],
        },
        parameters: {
          prompt_extend: true,
          watermark: false,
          n: 1,
          negative_prompt: '',
          size: '1280*1280',
        },
      }),
      signal,
    });
    return imagesFromResponse(response);
  }

  const startedResponse = await fetch(`${baseUrl}/services/aigc/text2image/image-synthesis`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable',
    },
    body: JSON.stringify({
      model,
      input: { prompt },
      parameters: {
        size: '1024*1024',
        n: 1,
        prompt_extend: true,
        watermark: false,
      },
    }),
    signal,
  });
  const started = await readJsonResponse(startedResponse);
  const output = objectValue(started.output);
  const taskId = stringValue(output?.task_id);
  if (!taskId) throw new Error('DashScope did not return a task id.');
  for (let i = 0; i < 60; i += 1) {
    await delay(5000, signal);
    const statusResponse = await fetch(`${baseUrl}/tasks/${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });
    const status = await readJsonResponse(statusResponse);
    const taskOutput = objectValue(status.output);
    const taskStatus = stringValue(taskOutput?.task_status);
    if (taskStatus === 'FAILED' || taskStatus === 'CANCELED') {
      throw new Error(stringValue(status.message) || `DashScope task ${taskStatus.toLowerCase()}.`);
    }
    const images = imagesFromJson(status);
    if (images.length > 0) return images;
    if (taskStatus === 'SUCCEEDED') break;
  }
  throw new Error('DashScope job timed out before an image was ready.');
}

async function generateAiHorde(
  prompt: string,
  model: string,
  settings: ImageGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = settings.providerKeys['ai-horde']?.trim() || '0000000000';
  const baseUrl = imageProviderBaseUrl('ai-horde', settings);
  const response = await fetch(`${baseUrl}/generate/async`, {
    method: 'POST',
    headers: {
      apikey: apiKey,
      'Content-Type': 'application/json',
      'Client-Agent': 'OpenWorkflow:0.2.7:github.com/wellingfeng/OpenWorkflow',
    },
    body: JSON.stringify({
      prompt,
      models: model === 'stable_diffusion' ? undefined : [model],
      params: {
        n: 1,
        width: 1024,
        height: 1024,
        steps: 20,
      },
      nsfw: false,
      censor_nsfw: true,
      r2: true,
    }),
    signal,
  });
  const started = await readJsonResponse(response);
  const id = typeof started.id === 'string' ? started.id : '';
  if (!id) throw new Error('AI Horde did not return a job id.');
  for (let i = 0; i < 90; i += 1) {
    await delay(2000, signal);
    const statusResponse = await fetch(`${baseUrl}/generate/status/${encodeURIComponent(id)}`, {
      headers: { apikey: apiKey },
      signal,
    });
    const status = await readJsonResponse(statusResponse);
    const done = status.done === true;
    const generations = Array.isArray(status.generations) ? status.generations : [];
    if (!done && generations.length === 0) continue;
    const images = generations
      .map((item) => {
        if (!item || typeof item !== 'object') return '';
        const img = (item as Record<string, unknown>).img;
        if (typeof img !== 'string') return '';
        if (/^https?:\/\//i.test(img) || img.startsWith('data:')) return img;
        return `data:image/webp;base64,${img}`;
      })
      .filter(Boolean);
    if (images.length > 0) return images;
    if (done) break;
  }
  throw new Error('AI Horde job timed out before an image was ready.');
}

async function generateComfyUi(
  prompt: string,
  model: string,
  settings: ImageGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const baseUrl = imageProviderBaseUrl('local-comfyui', settings);
  const response = await fetch(`${baseUrl}/prompt-text-to-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, model }),
    signal,
  });
  const json = await readJsonResponse(response);
  const images = ['url', 'image', 'data']
    .map((key) => json[key])
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((value) =>
      /^https?:\/\//i.test(value) || value.startsWith('data:')
        ? value
        : `data:image/png;base64,${value}`,
    );
  if (images.length === 0) {
    throw new Error(
      'ComfyUI did not return an image. Start a compatible local image endpoint or configure another provider.',
    );
  }
  return images;
}

async function imagesFromResponse(response: Response): Promise<string[]> {
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`${response.status} ${response.statusText}${text ? `: ${text}` : ''}`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.startsWith('image/')) {
    const blob = await response.blob();
    return [await blobToDataUrl(blob)];
  }
  const json = (await response.json()) as Record<string, unknown>;
  const images = imagesFromJson(json);
  if (images.length > 0) return images;
  throw new Error('Provider returned no image.');
}

function imagesFromJson(json: Record<string, unknown>): string[] {
  const images: string[] = [];
  const push = (src: string) => {
    if (!src || images.includes(src)) return;
    images.push(src);
  };
  const result = json.result;
  if (typeof result === 'string') {
    push(toImageSrc(result));
  }
  if (result && typeof result === 'object') {
    for (const src of imagesFromUnknown(result)) push(src);
  }
  for (const key of ['data', 'images', 'artifacts']) {
    for (const src of imagesFromUnknown(json[key])) push(src);
  }
  const output = objectValue(json.output);
  if (output) {
    for (const src of imagesFromUnknown(output)) push(src);
    for (const src of imagesFromUnknown(output.results)) push(src);
    for (const src of imagesFromUnknown(output.choices)) push(src);
  }
  return images;
}

function imagesFromUnknown(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === 'string') return [toImageSrc(value)];
  if (Array.isArray(value)) return value.flatMap(imagesFromUnknown);
  if (typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const images: string[] = [];
  const push = (src: string) => {
    if (!src || images.includes(src)) return;
    images.push(src);
  };
  const direct = imageStringFromRecord(record);
  if (direct) push(direct);
  for (const key of [
    'image_urls',
    'image_base64',
    'image_b64',
    'images',
    'results',
    'artifacts',
    'outputs',
  ]) {
    for (const src of imagesFromUnknown(record[key])) push(src);
  }
  if (images.length > 0) return images;
  const message = objectValue(record.message);
  if (message) return imagesFromUnknown(message.content);
  const content = record.content;
  if (Array.isArray(content)) return content.flatMap(imagesFromUnknown);
  if (content && typeof content === 'object') return imagesFromUnknown(content);
  return [];
}

function imageStringFromRecord(record: Record<string, unknown>): string | null {
  for (const key of [
    'url',
    'image',
    'image_url',
    'b64_json',
    'base64',
    'b64',
    'data_url',
    'output_url',
  ]) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return toImageSrc(value);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = imageStringFromRecord(value as Record<string, unknown>);
      if (nested) return nested;
    }
  }
  return null;
}

function toImageSrc(value: string): string {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('data:')) return trimmed;
  return `data:image/png;base64,${trimmed}`;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}${text ? `: ${text}` : ''}`);
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* handled below */
  }
  throw new Error(text || 'Provider returned an invalid JSON response.');
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image blob.'));
    reader.readAsDataURL(blob);
  });
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
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
