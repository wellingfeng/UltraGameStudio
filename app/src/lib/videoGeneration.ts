export type VideoProviderId =
  | 'google-veo'
  | 'runway'
  | 'luma-ray'
  | 'kling-ai'
  | 'minimax-hailuo'
  | 'dashscope-wan'
  | 'pika'
  | 'pixverse'
  | 'vidu'
  | 'stability-video'
  | 'openai-sora'
  | 'bytedance-seedance'
  | 'lightricks-ltx'
  | 'stepfun-video'
  | 'replicate-video'
  | 'fal-video'
  | 'huggingface-video'
  | 'local-comfyui-video'
  | 'local-wan-video'
  | 'local-hunyuan-video'
  | 'local-video-server';

export type VideoProviderCategory = 'commercial' | 'free';

type VideoProviderApiKind =
  | 'google-veo'
  | 'runway'
  | 'luma-ray'
  | 'kling-ai'
  | 'minimax-hailuo'
  | 'dashscope-wan'
  | 'pika'
  | 'pixverse'
  | 'vidu'
  | 'stability-video'
  | 'openai-sora'
  | 'bytedance-seedance'
  | 'generic-online-video'
  | 'replicate'
  | 'fal-ai'
  | 'huggingface-inference'
  | 'generic-local-video';

export interface VideoProviderDefinition {
  id: VideoProviderId;
  label: string;
  category: VideoProviderCategory;
  apiKind: VideoProviderApiKind;
  defaultModel: string;
  models: string[];
  needsKey: boolean;
  local: boolean;
  defaultBaseUrl: string;
  supportsBaseUrl: boolean;
  endpointPlaceholder: string;
  keyProviderId?: VideoProviderId;
  credentialUrl?: string;
  keyLabel?: string;
  keyPlaceholder?: string;
  note: string;
}

export interface VideoGenerationSettings {
  enabled: boolean;
  preferredProviderId: VideoProviderId;
  providerKeys: Partial<Record<VideoProviderId, string>>;
  providerBaseUrls: Partial<Record<VideoProviderId, string>>;
  providerModels: Partial<Record<VideoProviderId, string>>;
}

export interface VideoGenerationResult {
  providerId: VideoProviderId;
  providerLabel: string;
  model: string;
  prompt: string;
  videos: string[];
}

export interface VideoGenerationRequest {
  prompt: string;
  providerId?: VideoProviderId;
  model?: string;
  targetDurationSeconds?: number;
  signal?: AbortSignal;
}

const STORAGE_KEY = 'freeultracode.videoGeneration.v1';
const DEFAULT_DURATION_SECONDS = 5;
const MIN_DURATION_SECONDS = 1;
const MAX_DURATION_SECONDS = 30;

export const VIDEO_PROVIDERS: VideoProviderDefinition[] = [
  {
    id: 'google-veo',
    label: 'Google Veo',
    category: 'commercial',
    apiKind: 'google-veo',
    defaultModel: 'veo-3.1-generate-preview',
    models: [
      'veo-3.1-generate-preview',
      'veo-3.1-fast-generate-preview',
      'veo-3.0-generate-preview',
      'veo-2.0-generate-001',
    ],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://generativelanguage.googleapis.com/v1beta',
    credentialUrl: 'https://aistudio.google.com/apikey',
    keyLabel: 'Google API Key',
    keyPlaceholder: 'AIza...',
    note: 'Gemini API 官方 Veo 视频生成。适合高质量文生视频；返回长任务 operation，完成后解析 video bytes 或 URI。',
  },
  {
    id: 'runway',
    label: 'Runway Gen-4 / Gen-3',
    category: 'commercial',
    apiKind: 'runway',
    defaultModel: 'gen4_turbo',
    models: ['gen4_turbo', 'gen3a_turbo'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.dev.runwayml.com/v1',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.dev.runwayml.com/v1',
    credentialUrl: 'https://dev.runwayml.com',
    keyLabel: 'Runway API Key',
    keyPlaceholder: 'key_...',
    note: 'Runway 官方 API。文本提示词直连 text_to_video，轮询 task 输出；如账号只开通图生视频，可把 Base URL 指向兼容代理。',
  },
  {
    id: 'luma-ray',
    label: 'Luma Dream Machine / Ray',
    category: 'commercial',
    apiKind: 'luma-ray',
    defaultModel: 'ray-2',
    models: ['ray-2', 'ray-2-flash', 'ray-1-6', 'ray-flash-2'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.lumalabs.ai/dream-machine/v1',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.lumalabs.ai/dream-machine/v1',
    credentialUrl: 'https://lumalabs.ai/api/keys',
    keyLabel: 'Luma API Key',
    keyPlaceholder: 'luma_...',
    note: 'Luma 官方 Dream Machine/Ray API。适合电影感短片和物理一致性镜头，创建 generation 后轮询 assets.video。',
  },
  {
    id: 'kling-ai',
    label: 'Kling AI 可灵',
    category: 'commercial',
    apiKind: 'kling-ai',
    defaultModel: 'kling-v2-5-turbo',
    models: [
      'kling-v2-5-turbo',
      'kling-v2-1',
      'kling-v2-1-master',
      'kling-v2-0',
      'kling-v1-6',
      'kling-v1-5',
    ],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.klingai.com/v1',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.klingai.com/v1',
    credentialUrl: 'https://app.klingai.com/global/dev/document-api',
    keyLabel: 'Kling API Token',
    keyPlaceholder: 'Bearer token',
    note: '可灵官方/兼容 API。适合中文提示词、人物动作和图生视频生态；默认按 text2video task 轮询。',
  },
  {
    id: 'minimax-hailuo',
    label: 'MiniMax 海螺视频',
    category: 'commercial',
    apiKind: 'minimax-hailuo',
    defaultModel: 'T2V-01-Director',
    models: ['T2V-01-Director', 'T2V-01', 'T2V-01-live', 'I2V-01-Director', 'S2V-01'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.minimax.io/v1',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.minimax.io/v1',
    credentialUrl: 'https://platform.minimax.io/user-center/basic-information',
    keyLabel: 'MiniMax API Key',
    keyPlaceholder: 'sk-...',
    note: 'MiniMax/Hailuo 官方视频生成。默认调用 /video_generation 并轮询任务；中国区可把 Base URL 改成 api.minimaxi.com/v1。',
  },
  {
    id: 'dashscope-wan',
    label: '阿里百炼 Wan 视频',
    category: 'commercial',
    apiKind: 'dashscope-wan',
    defaultModel: 'wan2.5-t2v-preview',
    models: [
      'wan2.5-t2v-preview',
      'wan2.2-t2v-a14b',
      'wan2.1-t2v-turbo',
      'wanx2.1-t2v-turbo',
      'wanx2.1-t2v-plus',
    ],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://dashscope.aliyuncs.com/api/v1',
    credentialUrl: 'https://bailian.console.aliyun.com/?apiKey=1#/api-key-center',
    keyLabel: 'DashScope API Key',
    keyPlaceholder: 'sk-...',
    note: '阿里通义万相/Wan 视频 API。中文生态友好，异步任务返回 task_id，再查 /tasks/{task_id} 获取 video_url。',
  },
  {
    id: 'pika',
    label: 'Pika',
    category: 'commercial',
    apiKind: 'pika',
    defaultModel: 'pika-2.2',
    models: ['pika-2.2', 'pika-2.1', 'pika-2.0', 'pika-1.5'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.pika.art/v1',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.pika.art/v1',
    credentialUrl: 'https://pika.art',
    keyLabel: 'Pika API Key',
    keyPlaceholder: 'pk-...',
    note: 'Pika 视频生成渠道。适合快速短片、风格化和社媒素材；默认走通用 text-to-video 任务接口，兼容代理可直接接入。',
  },
  {
    id: 'pixverse',
    label: 'PixVerse',
    category: 'commercial',
    apiKind: 'pixverse',
    defaultModel: 'v4.5',
    models: ['v4.5', 'v4', 'v3.5', 'v3'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://app-api.pixverse.ai/openapi/v2',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://app-api.pixverse.ai/openapi/v2',
    credentialUrl: 'https://app.pixverse.ai',
    keyLabel: 'PixVerse API Key',
    keyPlaceholder: 'pxv-...',
    note: 'PixVerse 开放/兼容 API。适合中文视频生成、角色动态和社媒短片；默认使用通用异步任务解析。',
  },
  {
    id: 'vidu',
    label: 'Vidu',
    category: 'commercial',
    apiKind: 'vidu',
    defaultModel: 'vidu2.0',
    models: ['vidu2.0', 'vidu1.5', 'vidu-q1'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.vidu.com/ent/v2',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.vidu.com/ent/v2',
    credentialUrl: 'https://platform.vidu.com',
    keyLabel: 'Vidu API Key',
    keyPlaceholder: 'vidu-...',
    note: 'Vidu 商业视频生成渠道。适合长镜头和中文提示词；默认走 create/poll 通用任务协议。',
  },
  {
    id: 'stability-video',
    label: 'Stability AI Video',
    category: 'commercial',
    apiKind: 'stability-video',
    defaultModel: 'stable-video-diffusion',
    models: ['stable-video-diffusion', 'stable-video-3d'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.stability.ai/v2beta',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.stability.ai/v2beta',
    credentialUrl: 'https://platform.stability.ai/account/keys',
    keyLabel: 'Stability API Key',
    keyPlaceholder: 'sk-...',
    note: 'Stability 视频渠道。部分官方能力偏图生视频；文本场景建议接兼容代理或切换 Replicate/fal 上的 Stable Video/Wan 模型。',
  },
  {
    id: 'openai-sora',
    label: 'OpenAI Sora / Video',
    category: 'commercial',
    apiKind: 'openai-sora',
    defaultModel: 'sora-2',
    models: ['sora-2', 'sora-2-pro', 'sora-1'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.openai.com/v1',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.openai.com/v1',
    credentialUrl: 'https://platform.openai.com/api-keys',
    keyLabel: 'OpenAI API Key',
    keyPlaceholder: 'sk-...',
    note: 'OpenAI 视频生成占位兼容渠道。若账号/代理开放 /videos 或 /video/generations，可直接填 Key 和 Base URL 使用。',
  },
  {
    id: 'bytedance-seedance',
    label: '字节豆包 Seedance（火山方舟）',
    category: 'commercial',
    apiKind: 'bytedance-seedance',
    defaultModel: 'doubao-seedance-1-0-pro-250528',
    models: [
      'doubao-seedance-1-0-pro-250528',
      'doubao-seedance-1-0-lite-t2v-250428',
      'doubao-seedance-1-0-lite-i2v-250428',
      'wan2-1-14b-t2v-250225',
    ],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://ark.cn-beijing.volces.com/api/v3',
    credentialUrl: 'https://console.volcengine.com/ark',
    keyLabel: '火山方舟 API Key',
    keyPlaceholder: 'ark_...',
    note: '字节跳动 Seedance（豆包视频）官方接口，托管在火山方舟 ArkRuntime。当前榜单文生/图生视频领先模型；异步创建 /contents/generations/tasks 后轮询任务获取 video_url。',
  },
  {
    id: 'lightricks-ltx',
    label: 'Lightricks LTX-2',
    category: 'commercial',
    apiKind: 'generic-online-video',
    defaultModel: 'ltx-2-pro',
    models: ['ltx-2-pro', 'ltx-2-fast', 'ltx-2.3-pro', 'ltx-2.3-fast'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.ltx.video/v1/video/generations',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.ltx.video/v1/video/generations',
    credentialUrl: 'https://www.ltx.video/api',
    keyLabel: 'Lightricks API Key',
    keyPlaceholder: 'ltx_...',
    note: 'Lightricks LTX-2 官方 API。开源权重榜单领先，支持带音轨视频；默认走通用文生视频任务接口，如官方路径不同可在 Base URL 填完整 endpoint。',
  },
  {
    id: 'stepfun-video',
    label: '阶跃星辰 Step-Video',
    category: 'commercial',
    apiKind: 'generic-online-video',
    defaultModel: 'step-video-t2v',
    models: ['step-video-t2v', 'step-video-ti2v', 'step-1x-medium'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.stepfun.com/v1/video/generations',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.stepfun.com/v1/video/generations',
    credentialUrl: 'https://platform.stepfun.com',
    keyLabel: 'StepFun API Key',
    keyPlaceholder: 'sk-...',
    note: '阶跃星辰 Step-Video 官方 API，OpenAI 风格鉴权。适合中文文生/图生视频；默认走通用异步任务解析，返回 video_url 或任务状态。',
  },
  {
    id: 'replicate-video',
    label: 'Replicate 视频模型',
    category: 'free',
    apiKind: 'replicate',
    defaultModel: 'wavespeedai/wan-2.2-i2v-fast',
    models: [
      'wavespeedai/wan-2.2-i2v-fast',
      'wan-video/wan-2.2-t2v',
      'kwaivgi/kling-v2.1',
      'minimax/video-01',
      'tencent/hunyuan-video',
      'lucataco/mochi-1-preview',
      'lucataco/ltx-video',
    ],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.replicate.com/v1',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.replicate.com/v1',
    credentialUrl: 'https://replicate.com/account/api-tokens',
    keyLabel: 'Replicate API Token',
    keyPlaceholder: 'r8_...',
    note: 'Replicate 聚合视频模型。通常注册送额度，覆盖 Wan、Kling、HunyuanVideo、Mochi、LTX Video 等模型；模型字段可填 owner/model 或 owner/model:version。',
  },
  {
    id: 'fal-video',
    label: 'fal.ai 视频模型',
    category: 'free',
    apiKind: 'fal-ai',
    defaultModel: 'fal-ai/wan/v2.2-a14b/text-to-video',
    models: [
      'fal-ai/wan/v2.2-a14b/text-to-video',
      'fal-ai/kling-video/v2.1/master/text-to-video',
      'fal-ai/minimax/video-01',
      'fal-ai/luma-dream-machine/ray-2',
      'fal-ai/veo3',
      'fal-ai/pixverse/v4.5/text-to-video',
      'fal-ai/hunyuan-video',
      'fal-ai/ltx-video',
    ],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://queue.fal.run',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://queue.fal.run',
    credentialUrl: 'https://fal.ai/dashboard/keys',
    keyLabel: 'fal API Key',
    keyPlaceholder: 'fal key',
    note: 'fal.ai 聚合视频队列。常有试用额度，适合快速接入 Wan/Kling/MiniMax/Luma/Veo/PixVerse 等模型。',
  },
  {
    id: 'huggingface-video',
    label: 'Hugging Face 视频模型',
    category: 'free',
    apiKind: 'huggingface-inference',
    defaultModel: 'Wan-AI/Wan2.2-T2V-A14B-Diffusers',
    models: [
      'Wan-AI/Wan2.2-T2V-A14B-Diffusers',
      'tencent/HunyuanVideo',
      'THUDM/CogVideoX-5b',
      'genmo/mochi-1-preview',
      'Lightricks/LTX-Video',
    ],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api-inference.huggingface.co/models',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api-inference.huggingface.co/models',
    credentialUrl: 'https://huggingface.co/settings/tokens',
    keyLabel: 'Hugging Face Token',
    keyPlaceholder: 'hf_...',
    note: 'Hugging Face Inference/Endpoint 渠道。适合免费额度和自托管 Endpoint；部分模型需先接受许可或使用专属 Endpoint。',
  },
  {
    id: 'local-comfyui-video',
    label: 'ComfyUI 视频工作流',
    category: 'free',
    apiKind: 'generic-local-video',
    defaultModel: 'Wan2.2',
    models: ['Wan2.2', 'Wan2.1', 'HunyuanVideo', 'LTX-Video', 'Mochi-1', 'CogVideoX', 'AnimateDiff'],
    needsKey: false,
    local: true,
    defaultBaseUrl: 'http://127.0.0.1:8189/generate-video',
    supportsBaseUrl: true,
    endpointPlaceholder: 'http://127.0.0.1:8189/generate-video',
    credentialUrl: 'https://github.com/comfyanonymous/ComfyUI',
    note: '本地 ComfyUI 视频包装入口。推荐用简单 HTTP 包装器接 Wan/HunyuanVideo/LTX/Mochi 工作流，POST JSON 返回 video_url 或 base64。',
  },
  {
    id: 'local-wan-video',
    label: '本地 Wan Video',
    category: 'free',
    apiKind: 'generic-local-video',
    defaultModel: 'Wan2.2-T2V-A14B',
    models: ['Wan2.2-T2V-A14B', 'Wan2.2-I2V-A14B', 'Wan2.1-T2V-14B', 'Wan2.1-T2V-1.3B'],
    needsKey: false,
    local: true,
    defaultBaseUrl: 'http://127.0.0.1:7861/generate',
    supportsBaseUrl: true,
    endpointPlaceholder: 'http://127.0.0.1:7861/generate',
    credentialUrl: 'https://github.com/Wan-Video/Wan2.1',
    note: '本地 Wan 视频模型入口。适合有 GPU 的免费自托管；服务只需兼容 POST JSON 并返回视频 URL、base64 或任务状态。',
  },
  {
    id: 'local-hunyuan-video',
    label: '本地 HunyuanVideo',
    category: 'free',
    apiKind: 'generic-local-video',
    defaultModel: 'HunyuanVideo',
    models: ['HunyuanVideo', 'HunyuanVideo-I2V', 'HunyuanVideo-Fast'],
    needsKey: false,
    local: true,
    defaultBaseUrl: 'http://127.0.0.1:7862/generate',
    supportsBaseUrl: true,
    endpointPlaceholder: 'http://127.0.0.1:7862/generate',
    credentialUrl: 'https://github.com/Tencent-Hunyuan/HunyuanVideo',
    note: '本地腾讯 HunyuanVideo 包装入口。适合免费自托管长宽比和镜头控制实验。',
  },
  {
    id: 'local-video-server',
    label: '本地/自定义视频 HTTP',
    category: 'free',
    apiKind: 'generic-local-video',
    defaultModel: 'custom-video-model',
    models: ['custom-video-model', 'Wan2.2', 'Kling', 'HunyuanVideo', 'CogVideoX', 'Mochi', 'LTX-Video', 'AnimateDiff'],
    needsKey: false,
    local: true,
    defaultBaseUrl: 'http://127.0.0.1:8088/generate-video',
    supportsBaseUrl: true,
    endpointPlaceholder: 'http://127.0.0.1:8088/generate-video',
    credentialUrl: 'https://github.com/Wan-Video/Wan2.1',
    note: '通用自托管视频入口。任何本地/内网服务支持 POST JSON，返回 video_url、videos、base64、status_url 或 task_id 即可接入。',
  },
];

const VIDEO_PROVIDER_BY_ID = new Map<VideoProviderId, VideoProviderDefinition>(
  VIDEO_PROVIDERS.map((provider) => [provider.id, provider]),
);

export const DEFAULT_VIDEO_GENERATION_SETTINGS: VideoGenerationSettings = {
  enabled: true,
  preferredProviderId: 'fal-video',
  providerKeys: {},
  providerBaseUrls: {},
  providerModels: {},
};

function hasStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage;
}

function isVideoProviderId(value: unknown): value is VideoProviderId {
  return typeof value === 'string' && VIDEO_PROVIDER_BY_ID.has(value as VideoProviderId);
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

export function normalizeVideoGenerationSettings(value: unknown): VideoGenerationSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return DEFAULT_VIDEO_GENERATION_SETTINGS;
  }
  const source = value as Partial<VideoGenerationSettings>;
  const preferredProviderId = isVideoProviderId(source.preferredProviderId)
    ? source.preferredProviderId
    : DEFAULT_VIDEO_GENERATION_SETTINGS.preferredProviderId;
  return {
    enabled:
      typeof source.enabled === 'boolean'
        ? source.enabled
        : DEFAULT_VIDEO_GENERATION_SETTINGS.enabled,
    preferredProviderId,
    providerKeys: cleanRecord(source.providerKeys, isVideoProviderId),
    providerBaseUrls: cleanRecord(source.providerBaseUrls, isVideoProviderId),
    providerModels: cleanRecord(source.providerModels, isVideoProviderId),
  };
}

export function loadVideoGenerationSettings(): VideoGenerationSettings {
  if (!hasStorage()) return DEFAULT_VIDEO_GENERATION_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return normalizeVideoGenerationSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return DEFAULT_VIDEO_GENERATION_SETTINGS;
  }
}

export function saveVideoGenerationSettings(settings: VideoGenerationSettings): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(normalizeVideoGenerationSettings(settings)),
    );
    window.dispatchEvent(new Event('fuc:video-generation-settings-changed'));
  } catch {
    /* non-fatal */
  }
}

export function videoProviderById(id: VideoProviderId): VideoProviderDefinition {
  return VIDEO_PROVIDER_BY_ID.get(id) ?? VIDEO_PROVIDERS[0];
}

export function videoProviderModel(
  providerId: VideoProviderId,
  settings = loadVideoGenerationSettings(),
): string {
  const provider = videoProviderById(providerId);
  return settings.providerModels[providerId]?.trim() || provider.defaultModel;
}

export function videoProviderBaseUrl(
  providerId: VideoProviderId,
  settings = loadVideoGenerationSettings(),
): string {
  const custom = settings.providerBaseUrls[providerId]?.trim();
  if (custom) return custom.replace(/\/+$/, '');
  return videoProviderById(providerId).defaultBaseUrl.replace(/\/+$/, '');
}

function videoProviderKey(
  providerId: VideoProviderId,
  settings = loadVideoGenerationSettings(),
): string {
  const provider = videoProviderById(providerId);
  const keyProviderId = provider.keyProviderId ?? providerId;
  return settings.providerKeys[keyProviderId]?.trim() || settings.providerKeys[providerId]?.trim() || '';
}

export function videoProviderReady(
  providerId: VideoProviderId,
  settings = loadVideoGenerationSettings(),
): boolean {
  const provider = videoProviderById(providerId);
  if (provider.needsKey && !videoProviderKey(providerId, settings)) return false;
  if (provider.local && !settings.providerBaseUrls[providerId]?.trim()) return false;
  return !!videoProviderBaseUrl(providerId, settings);
}

export function configuredVideoProviderIds(
  settings = loadVideoGenerationSettings(),
): VideoProviderId[] {
  return VIDEO_PROVIDERS.filter((provider) => videoProviderReady(provider.id, settings)).map(
    (provider) => provider.id,
  );
}

export function preferredReadyVideoProviderId(
  settings = loadVideoGenerationSettings(),
): VideoProviderId | null {
  if (videoProviderReady(settings.preferredProviderId, settings)) {
    return settings.preferredProviderId;
  }
  return configuredVideoProviderIds(settings)[0] ?? null;
}

export function looksLikeVideoGenerationRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  if (/^\/(?:video|movie|film|clip|生成视频|视频)(?:\s|$)/iu.test(normalized)) return true;
  const zhIntent =
    /(生成|创作|做|制作|拍|产出)[\s\S]{0,18}(视频|短片|影片|镜头|动画|片段|mv)/iu.test(text) ||
    /(视频|短片|影片|镜头|动画|片段|mv)[\s\S]{0,18}(生成|创作|做|制作|拍|产出)/iu.test(text);
  if (zhIntent) return true;
  return /\b(generate|create|make|produce|render)\b[\s\S]{0,48}\b(video|movie|film|clip|shot|animation)\b/i.test(
    normalized,
  );
}

export function stripVideoCommand(text: string): string {
  return text
    .trim()
    .replace(/^\/(?:video|movie|film|clip|生成视频|视频)\s+/iu, '')
    .replace(/^请?(?:帮我)?(?:生成|创作|做|制作|拍|产出)(?:一段|一个|一些)?(?:视频|短片|影片|镜头|动画|片段|mv)?/iu, '')
    .trim();
}

export function videoDurationSecondsFromPrompt(prompt: string): number | null {
  const normalized = prompt.replace(/[，。；、]/gu, ' ');
  const matches = Array.from(
    normalized.matchAll(/(\d+(?:\.\d+)?)\s*(秒钟|秒|s|secs?|seconds?)/giu),
  );
  if (matches.length === 0) return null;
  const scored = matches
    .map((match, index) => {
      const value = Number(match[1]);
      const before = normalized.slice(Math.max(0, match.index - 10), match.index);
      const after = normalized.slice(match.index + match[0].length, match.index + match[0].length + 10);
      const context = `${before}${after}`;
      const contextScore = /(?:总长|时长|长度|duration|length|clip|shot|视频|短片|镜头)/iu.test(
        context,
      )
        ? 2
        : 0;
      return { value, score: contextScore + (value >= 1 ? 1 : -1) - index * 0.01 };
    })
    .sort((a, b) => b.score - a.score);
  return clampVideoDuration(scored[0].value);
}

export async function generateVideo(
  request: VideoGenerationRequest,
  settings = loadVideoGenerationSettings(),
): Promise<VideoGenerationResult> {
  if (!settings.enabled) throw new Error('VIDEO_GENERATION_DISABLED');
  const providerId = request.providerId ?? preferredReadyVideoProviderId(settings);
  if (!providerId) throw new Error('NO_READY_VIDEO_PROVIDER');
  if (!videoProviderReady(providerId, settings)) {
    throw new Error(`VIDEO_PROVIDER_NOT_READY:${providerId}`);
  }
  const provider = videoProviderById(providerId);
  const prompt = stripVideoCommand(request.prompt);
  const model = request.model?.trim() || videoProviderModel(providerId, settings);
  const targetDurationSeconds =
    clampVideoDuration(
      request.targetDurationSeconds ??
        videoDurationSecondsFromPrompt(prompt) ??
        DEFAULT_DURATION_SECONDS,
    ) ?? DEFAULT_DURATION_SECONDS;
  const videos = await generateWithProvider(
    providerId,
    prompt,
    model,
    settings,
    targetDurationSeconds,
    request.signal,
  );
  return {
    providerId,
    providerLabel: provider.label,
    model,
    prompt,
    videos,
  };
}

async function generateWithProvider(
  providerId: VideoProviderId,
  prompt: string,
  model: string,
  settings: VideoGenerationSettings,
  targetDurationSeconds: number,
  signal?: AbortSignal,
): Promise<string[]> {
  switch (videoProviderById(providerId).apiKind) {
    case 'google-veo':
      return generateGoogleVeo(prompt, model, settings, targetDurationSeconds, signal);
    case 'runway':
      return generateRunway(prompt, model, settings, targetDurationSeconds, signal);
    case 'luma-ray':
      return generateLumaRay(prompt, model, settings, targetDurationSeconds, signal);
    case 'kling-ai':
      return generateKling(prompt, model, settings, targetDurationSeconds, signal);
    case 'minimax-hailuo':
      return generateMiniMaxVideo(prompt, model, settings, signal);
    case 'dashscope-wan':
      return generateDashScopeWan(prompt, model, settings, targetDurationSeconds, signal);
    case 'pika':
    case 'pixverse':
    case 'vidu':
    case 'stability-video':
    case 'openai-sora':
    case 'generic-online-video':
      return generateGenericOnlineVideo(providerId, prompt, model, settings, targetDurationSeconds, signal);
    case 'bytedance-seedance':
      return generateSeedanceVideo(prompt, model, settings, targetDurationSeconds, signal);
    case 'replicate':
      return generateReplicateVideo(prompt, model, settings, targetDurationSeconds, signal);
    case 'fal-ai':
      return generateFalVideo(prompt, model, settings, targetDurationSeconds, signal);
    case 'huggingface-inference':
      return generateHuggingFaceVideo(providerId, prompt, model, settings, targetDurationSeconds, signal);
    case 'generic-local-video':
      return generateGenericLocalVideo(providerId, prompt, model, settings, targetDurationSeconds, signal);
  }
}

async function generateGoogleVeo(
  prompt: string,
  model: string,
  settings: VideoGenerationSettings,
  targetDurationSeconds: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = videoProviderKey('google-veo', settings);
  if (!apiKey) throw new Error('Google API key is missing.');
  const baseUrl = videoProviderBaseUrl('google-veo', settings);
  const response = await fetch(
    `${baseUrl}/models/${encodeURIComponent(model)}:predictLongRunning`,
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: {
          durationSeconds: Math.round(targetDurationSeconds),
          aspectRatio: '16:9',
          sampleCount: 1,
        },
      }),
      signal,
    },
  );
  const started = await readJsonResponse(response);
  const immediate = videosFromJson(started);
  if (immediate.length > 0 && isTerminalSuccess(started)) return immediate;
  const operationName = stringValue(started.name);
  if (!operationName) throw new Error('Google Veo did not return an operation name.');
  for (let i = 0; i < 160; i += 1) {
    await delay(3000, signal);
    const statusResponse = await fetch(
      `${baseUrl}/${operationName.replace(/^\/+/, '')}`,
      { headers: { 'x-goog-api-key': apiKey }, signal },
    );
    const status = await readJsonResponse(statusResponse);
    const error = objectValue(status.error);
    if (error) throw new Error(stringValue(error.message) || 'Google Veo generation failed.');
    const videos = videosFromJson(status);
    if (videos.length > 0 && (status.done === true || isTerminalSuccess(status))) return videos;
  }
  throw new Error('Google Veo job timed out before video was ready.');
}

async function generateRunway(
  prompt: string,
  model: string,
  settings: VideoGenerationSettings,
  targetDurationSeconds: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = videoProviderKey('runway', settings);
  if (!apiKey) throw new Error('Runway API key is missing.');
  const baseUrl = videoProviderBaseUrl('runway', settings);
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'X-Runway-Version': '2024-11-06',
  };
  const response = await fetch(`${baseUrl}/text_to_video`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      promptText: prompt,
      ratio: '1280:720',
      duration: Math.round(targetDurationSeconds),
    }),
    signal,
  });
  const started = await readJsonResponse(response);
  const immediate = videosFromJson(started);
  if (immediate.length > 0 && isTerminalSuccess(started)) return immediate;
  const taskId = taskIdFromJson(started);
  if (!taskId) throw new Error('Runway did not return a task id.');
  return pollVideos(
    () => fetch(`${baseUrl}/tasks/${encodeURIComponent(taskId)}`, { headers, signal }),
    'Runway',
    signal,
  );
}

async function generateLumaRay(
  prompt: string,
  model: string,
  settings: VideoGenerationSettings,
  targetDurationSeconds: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = videoProviderKey('luma-ray', settings);
  if (!apiKey) throw new Error('Luma API key is missing.');
  const baseUrl = videoProviderBaseUrl('luma-ray', settings);
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const response = await fetch(`${baseUrl}/generations`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      prompt,
      model,
      aspect_ratio: '16:9',
      duration: `${Math.round(targetDurationSeconds)}s`,
    }),
    signal,
  });
  const started = await readJsonResponse(response);
  const immediate = videosFromJson(started);
  if (immediate.length > 0 && isTerminalSuccess(started)) return immediate;
  const id = taskIdFromJson(started);
  if (!id) throw new Error('Luma did not return a generation id.');
  return pollVideos(
    () => fetch(`${baseUrl}/generations/${encodeURIComponent(id)}`, { headers, signal }),
    'Luma',
    signal,
  );
}

async function generateKling(
  prompt: string,
  model: string,
  settings: VideoGenerationSettings,
  targetDurationSeconds: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = videoProviderKey('kling-ai', settings);
  if (!apiKey) throw new Error('Kling API token is missing.');
  const baseUrl = videoProviderBaseUrl('kling-ai', settings);
  const headers = {
    Authorization: apiKey.toLowerCase().startsWith('bearer ') ? apiKey : `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const response = await fetch(`${baseUrl}/videos/text2video`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model_name: model,
      prompt,
      duration: String(Math.round(targetDurationSeconds)),
      aspect_ratio: '16:9',
    }),
    signal,
  });
  const started = await readJsonResponse(response);
  const immediate = videosFromJson(started);
  if (immediate.length > 0 && isTerminalSuccess(started)) return immediate;
  const taskId = taskIdFromJson(started);
  if (!taskId) throw new Error('Kling did not return a task id.');
  return pollVideos(
    () => fetch(`${baseUrl}/videos/text2video/${encodeURIComponent(taskId)}`, { headers, signal }),
    'Kling',
    signal,
  );
}

async function generateMiniMaxVideo(
  prompt: string,
  model: string,
  settings: VideoGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = videoProviderKey('minimax-hailuo', settings);
  if (!apiKey) throw new Error('MiniMax API key is missing.');
  const baseUrl = videoProviderBaseUrl('minimax-hailuo', settings);
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const response = await fetch(`${baseUrl}/video_generation`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      prompt,
      prompt_optimizer: true,
    }),
    signal,
  });
  const started = await readJsonResponse(response);
  assertProviderJsonOk(started, 'MiniMax');
  const immediate = videosFromJson(started);
  if (immediate.length > 0 && isTerminalSuccess(started)) return immediate;
  const taskId = taskIdFromJson(started);
  if (!taskId) throw new Error('MiniMax did not return a task id.');
  const done = await pollJson(
    () => fetch(`${baseUrl}/query/video_generation?task_id=${encodeURIComponent(taskId)}`, { headers, signal }),
    'MiniMax',
    signal,
  );
  const directVideos = videosFromJson(done);
  if (directVideos.length > 0) return directVideos;
  const fileId = stringValue(done.file_id) || stringValue(objectValue(done.output)?.file_id);
  if (fileId) {
    const fileResponse = await fetch(`${baseUrl}/files/retrieve?file_id=${encodeURIComponent(fileId)}`, {
      headers,
      signal,
    });
    const fileJson = await readJsonResponse(fileResponse);
    const videos = videosFromJson(fileJson);
    if (videos.length > 0) return videos;
  }
  throw new Error('MiniMax returned no video.');
}

async function generateDashScopeWan(
  prompt: string,
  model: string,
  settings: VideoGenerationSettings,
  targetDurationSeconds: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = videoProviderKey('dashscope-wan', settings);
  if (!apiKey) throw new Error('DashScope API key is missing.');
  const baseUrl = videoProviderBaseUrl('dashscope-wan', settings);
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'X-DashScope-Async': 'enable',
  };
  const response = await fetch(`${baseUrl}/services/aigc/video-generation/video-synthesis`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      input: { prompt },
      parameters: {
        size: '1280*720',
        duration: Math.round(targetDurationSeconds),
        prompt_extend: true,
        watermark: false,
      },
    }),
    signal,
  });
  const started = await readJsonResponse(response);
  const taskId = taskIdFromJson(started);
  if (!taskId) throw new Error('DashScope did not return a task id.');
  return pollVideos(
    () => fetch(`${baseUrl}/tasks/${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    }),
    'DashScope',
    signal,
  );
}

async function generateSeedanceVideo(
  prompt: string,
  model: string,
  settings: VideoGenerationSettings,
  targetDurationSeconds: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = videoProviderKey('bytedance-seedance', settings);
  if (!apiKey) throw new Error('火山方舟 API Key is missing.');
  const baseUrl = videoProviderBaseUrl('bytedance-seedance', settings);
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  // Volcano Ark Seedance encodes generation params as text directives appended
  // to the prompt (e.g. --rs 720p --dur 5 --rt 16:9 --wm false).
  const promptWithParams = `${prompt} --rs 720p --dur ${Math.round(
    targetDurationSeconds,
  )} --rt 16:9 --wm false`;
  const response = await fetch(`${baseUrl}/contents/generations/tasks`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      content: [{ type: 'text', text: promptWithParams }],
    }),
    signal,
  });
  const started = await readJsonResponse(response);
  const immediate = videosFromJson(started);
  if (immediate.length > 0 && isTerminalSuccess(started)) return immediate;
  const taskId = taskIdFromJson(started);
  if (!taskId) throw new Error('Seedance did not return a task id.');
  return pollVideos(
    () =>
      fetch(`${baseUrl}/contents/generations/tasks/${encodeURIComponent(taskId)}`, {
        headers,
        signal,
      }),
    'Seedance',
    signal,
  );
}

async function generateGenericOnlineVideo(
  providerId: VideoProviderId,
  prompt: string,
  model: string,
  settings: VideoGenerationSettings,
  targetDurationSeconds: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const provider = videoProviderById(providerId);
  const apiKey = videoProviderKey(providerId, settings);
  if (provider.needsKey && !apiKey) throw new Error(`${provider.label} API key is missing.`);
  const headers: Record<string, string> = {
    Accept: 'video/mp4, video/*, application/json',
    'Content-Type': 'application/json',
  };
  if (apiKey) headers.Authorization = apiKey.toLowerCase().startsWith('bearer ') ? apiKey : `Bearer ${apiKey}`;
  const response = await fetch(videoProviderBaseUrl(providerId, settings), {
    method: 'POST',
    headers,
    body: JSON.stringify(videoRequestBody(prompt, model, targetDurationSeconds)),
    signal,
  });
  const started = await readResponseJsonOrVideos(response, provider.label);
  const immediate = videosFromJson(started);
  if (immediate.length > 0 && isTerminalSuccess(started)) return immediate;
  const statusUrl = statusUrlFromUnknown(started);
  const taskId = taskIdFromJson(started);
  if (!statusUrl && !taskId) {
    if (immediate.length > 0) return immediate;
    throw new Error(`${provider.label} returned no video.`);
  }
  const done = await pollJson(
    () =>
      fetch(
        statusUrl ||
          `${videoProviderBaseUrl(providerId, settings).replace(/\/+$/, '')}/${encodeURIComponent(
            taskId ?? '',
          )}`,
        { headers, signal },
      ),
    provider.label,
    signal,
  );
  const videos = videosFromJson(done);
  if (videos.length > 0) return videos;
  throw new Error(`${provider.label} returned no video.`);
}

async function generateReplicateVideo(
  prompt: string,
  model: string,
  settings: VideoGenerationSettings,
  targetDurationSeconds: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = videoProviderKey('replicate-video', settings);
  if (!apiKey) throw new Error('Replicate API token is missing.');
  const baseUrl = videoProviderBaseUrl('replicate-video', settings);
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Prefer: 'wait=60',
  };
  const versionMatch = /^([^:]+):(.+)$/.exec(model);
  const modelPath = versionMatch?.[1] ?? model;
  const version = versionMatch?.[2];
  const endpoint = version
    ? `${baseUrl}/predictions`
    : `${baseUrl}/models/${encodeModelPath(modelPath)}/predictions`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...(version ? { version } : {}),
      input: videoRequestBody(prompt, model, targetDurationSeconds),
    }),
    signal,
  });
  const started = await readJsonResponse(response);
  const immediate = videosFromJson(started);
  if (immediate.length > 0 && isTerminalSuccess(started)) return immediate;
  const statusUrl =
    stringValue(objectValue(started.urls)?.get) ||
    (stringValue(started.id) ? `${baseUrl}/predictions/${encodeURIComponent(stringValue(started.id))}` : '');
  if (!statusUrl) throw new Error('Replicate did not return a prediction URL.');
  return pollVideos(() => fetch(statusUrl, { headers, signal }), 'Replicate', signal);
}

async function generateFalVideo(
  prompt: string,
  model: string,
  settings: VideoGenerationSettings,
  targetDurationSeconds: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = videoProviderKey('fal-video', settings);
  if (!apiKey) throw new Error('fal API key is missing.');
  const modelPath = model.replace(/^\/+/, '');
  const baseUrl = videoProviderBaseUrl('fal-video', settings);
  const headers = {
    Authorization: `Key ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const response = await fetch(`${baseUrl}/${modelPath}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ input: videoRequestBody(prompt, model, targetDurationSeconds) }),
    signal,
  });
  const started = await readJsonResponse(response);
  const immediate = videosFromJson(started);
  if (immediate.length > 0) return immediate;
  const requestId = taskIdFromJson(started);
  if (!requestId) throw new Error('fal did not return a request id.');
  const statusUrl =
    stringValue(started.status_url) ||
    `${baseUrl}/${modelPath}/requests/${encodeURIComponent(requestId)}/status`;
  const responseUrl =
    stringValue(started.response_url) ||
    `${baseUrl}/${modelPath}/requests/${encodeURIComponent(requestId)}`;
  for (let i = 0; i < 160; i += 1) {
    await delay(3000, signal);
    const statusResponse = await fetch(statusUrl, { headers, signal });
    const status = await readJsonResponse(statusResponse);
    const statusVideos = videosFromJson(status);
    if (statusVideos.length > 0 && isTerminalSuccess(status)) return statusVideos;
    const state = jsonState(status);
    if (isFailedState(state)) {
      throw new Error(providerErrorMessage(status) || 'fal generation failed.');
    }
    if (isSuccessState(state, status)) {
      const resultResponse = await fetch(responseUrl, { headers, signal });
      const result = await readJsonResponse(resultResponse);
      const videos = videosFromJson(result);
      if (videos.length > 0) return videos;
      throw new Error('fal returned no video.');
    }
  }
  throw new Error('fal job timed out before video was ready.');
}

async function generateHuggingFaceVideo(
  providerId: VideoProviderId,
  prompt: string,
  model: string,
  settings: VideoGenerationSettings,
  targetDurationSeconds: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = videoProviderKey(providerId, settings);
  if (!apiKey) throw new Error('Hugging Face token is missing.');
  const modelPath = encodeModelPath(model);
  const response = await fetch(`${videoProviderBaseUrl(providerId, settings)}/${modelPath}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'video/mp4, video/*, application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      inputs: prompt,
      parameters: {
        duration: targetDurationSeconds,
        num_frames: Math.round(targetDurationSeconds * 16),
      },
      options: {
        wait_for_model: true,
      },
    }),
    signal,
  });
  return videosFromResponse(response);
}

async function generateGenericLocalVideo(
  providerId: VideoProviderId,
  prompt: string,
  model: string,
  settings: VideoGenerationSettings,
  targetDurationSeconds: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const response = await fetch(videoProviderBaseUrl(providerId, settings), {
    method: 'POST',
    headers: {
      Accept: 'video/mp4, video/*, application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(videoRequestBody(prompt, model, targetDurationSeconds)),
    signal,
  });
  const started = await readResponseJsonOrVideos(response, videoProviderById(providerId).label);
  const immediate = videosFromJson(started);
  if (immediate.length > 0 && isTerminalSuccess(started)) return immediate;
  const statusUrl = statusUrlFromUnknown(started);
  const taskId = taskIdFromJson(started);
  if (!statusUrl && !taskId) {
    if (immediate.length > 0) return immediate;
    throw new Error(`${videoProviderById(providerId).label} returned no video.`);
  }
  const done = await pollJson(
    () =>
      fetch(
        statusUrl ||
          `${videoProviderBaseUrl(providerId, settings).replace(/\/+$/, '')}/${encodeURIComponent(
            taskId ?? '',
          )}`,
        { signal },
      ),
    videoProviderById(providerId).label,
    signal,
  );
  const videos = videosFromJson(done);
  if (videos.length > 0) return videos;
  throw new Error(`${videoProviderById(providerId).label} returned no video.`);
}

function videoRequestBody(
  prompt: string,
  model: string,
  targetDurationSeconds: number,
): Record<string, unknown> {
  return {
    prompt,
    model,
    duration: Math.round(targetDurationSeconds),
    duration_seconds: Math.round(targetDurationSeconds),
    seconds: Math.round(targetDurationSeconds),
    aspect_ratio: '16:9',
    ratio: '16:9',
    size: '1280x720',
    resolution: '720p',
    fps: 24,
    output_format: 'mp4',
    prompt_optimizer: true,
  };
}

async function videosFromResponse(response: Response): Promise<string[]> {
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`${response.status} ${response.statusText}${body ? `: ${body.slice(0, 240)}` : ''}`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (isVideoMime(contentType)) {
    const bytes = arrayBufferToBase64(await response.arrayBuffer());
    return [videoDataUrl(bytes, contentType.split(';')[0] || 'video/mp4')];
  }
  const json = await response.json().catch(() => null);
  if (!json || typeof json !== 'object') {
    throw new Error('Provider returned a non-JSON response without a video payload.');
  }
  const videos = videosFromJson(json as Record<string, unknown>);
  if (videos.length > 0) return videos;
  throw new Error(providerErrorMessage(json as Record<string, unknown>) || 'Provider returned no video.');
}

async function readResponseJsonOrVideos(
  response: Response,
  providerLabel: string,
): Promise<Record<string, unknown>> {
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`${providerLabel} ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 240)}` : ''}`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (isVideoMime(contentType)) {
    const bytes = arrayBufferToBase64(await response.arrayBuffer());
    return { video_url: videoDataUrl(bytes, contentType.split(';')[0] || 'video/mp4'), status: 'succeeded' };
  }
  const json = await response.json().catch(() => null);
  if (!json || typeof json !== 'object') {
    throw new Error(`${providerLabel} returned a non-JSON response.`);
  }
  return json as Record<string, unknown>;
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`${response.status} ${response.statusText}${body ? `: ${body.slice(0, 240)}` : ''}`);
  }
  const json = await response.json().catch(() => null);
  if (!json || typeof json !== 'object') throw new Error('Provider returned a non-JSON response.');
  return json as Record<string, unknown>;
}

async function pollVideos(
  request: () => Promise<Response>,
  providerLabel: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const done = await pollJson(request, providerLabel, signal);
  const videos = videosFromJson(done);
  if (videos.length > 0) return videos;
  throw new Error(`${providerLabel} returned no video.`);
}

async function pollJson(
  request: () => Promise<Response>,
  providerLabel: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  for (let i = 0; i < 160; i += 1) {
    await delay(3000, signal);
    const response = await request();
    const json = await readJsonResponse(response);
    const state = jsonState(json);
    if (isFailedState(state)) {
      throw new Error(providerErrorMessage(json) || `${providerLabel} generation failed.`);
    }
    const videos = videosFromJson(json);
    if (videos.length > 0 && isSuccessState(state, json)) return json;
    if (videos.length > 0 && state === '') return json;
  }
  throw new Error(`${providerLabel} job timed out before video was ready.`);
}

function videosFromJson(json: Record<string, unknown>): string[] {
  const videos: string[] = [];
  const push = (src: string) => {
    const value = normalizeVideoSource(src);
    if (!value || videos.includes(value)) return;
    videos.push(value);
  };
  for (const key of [
    'video',
    'video_url',
    'videoUrl',
    'url',
    'uri',
    'download_url',
    'downloadUrl',
    'file_url',
    'fileUrl',
    'media_url',
    'mediaUrl',
    'output_url',
    'outputUrl',
    'result_url',
    'resultUrl',
  ]) {
    const value = stringValue(json[key]);
    if (value) push(value);
  }
  for (const key of ['video_base64', 'videoBase64', 'base64', 'data', 'bytesBase64Encoded']) {
    const value = stringValue(json[key]);
    if (value && looksLikeBase64Video(value)) push(videoDataUrl(value, mimeFromJson(json) || 'video/mp4'));
  }
  for (const key of [
    'videos',
    'outputs',
    'output',
    'result',
    'results',
    'data',
    'assets',
    'artifacts',
    'generations',
    'predictions',
    'response',
    'video',
    'content',
  ]) {
    for (const src of videosFromUnknown(json[key], key)) push(src);
  }
  const response = objectValue(json.response);
  if (response) {
    for (const src of videosFromUnknown(response.generateVideoResponse, 'generateVideoResponse')) push(src);
    for (const src of videosFromUnknown(response.videos, 'videos')) push(src);
  }
  return videos;
}

function videosFromUnknown(value: unknown, keyHint = ''): string[] {
  if (!value) return [];
  if (typeof value === 'string') {
    const normalized = normalizeVideoSource(value);
    if (normalized) return [normalized];
    if (looksLikeBase64Video(value) || videoishKey(keyHint)) return [videoDataUrl(value, 'video/mp4')];
    return [];
  }
  if (Array.isArray(value)) return value.flatMap((item) => videosFromUnknown(item, keyHint));
  if (typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const videos: string[] = [];
  const push = (src: string) => {
    const normalized = normalizeVideoSource(src);
    if (!normalized || videos.includes(normalized)) return;
    videos.push(normalized);
  };
  for (const key of [
    'video',
    'video_url',
    'videoUrl',
    'url',
    'uri',
    'download_url',
    'downloadUrl',
    'file_url',
    'fileUrl',
    'media_url',
    'mediaUrl',
    'output_url',
    'outputUrl',
    'result_url',
    'resultUrl',
  ]) {
    const value = stringValue(record[key]);
    if (value) push(value);
  }
  for (const key of ['video_base64', 'videoBase64', 'base64', 'data', 'bytesBase64Encoded']) {
    const value = stringValue(record[key]);
    if (value && (looksLikeBase64Video(value) || videoishKey(key))) {
      push(videoDataUrl(value, mimeFromJson(record) || 'video/mp4'));
    }
  }
  for (const key of ['video', 'videos', 'output', 'outputs', 'result', 'results', 'assets', 'artifacts', 'data']) {
    for (const src of videosFromUnknown(record[key], key)) push(src);
  }
  const candidate = stringValue(record.content);
  if (candidate && (looksLikeBase64Video(candidate) || videoishKey(keyHint))) {
    push(videoDataUrl(candidate, mimeFromJson(record) || 'video/mp4'));
  }
  return videos;
}

function normalizeVideoSource(value: string): string {
  const src = value.trim();
  if (!src) return '';
  if (/^data:video\//i.test(src)) return src;
  if (/^https?:\/\//i.test(src) || /^file:\/\//i.test(src)) return src;
  if (/\.(?:mp4|webm|mov|m4v|avi|mkv)(?:[?#].*)?$/i.test(src)) return src;
  return '';
}

function isVideoMime(value: string): boolean {
  return /^video\//i.test(value.split(';')[0]?.trim() ?? '');
}

function mimeFromJson(json: Record<string, unknown>): string {
  const mime =
    stringValue(json.mime_type) ||
    stringValue(json.mimeType) ||
    stringValue(json.content_type) ||
    stringValue(json.contentType);
  return isVideoMime(mime) ? mime : '';
}

function videoDataUrl(base64: string, mimeType: string): string {
  const clean = base64.trim().replace(/^data:video\/[^;]+;base64,/i, '');
  return `data:${isVideoMime(mimeType) ? mimeType : 'video/mp4'};base64,${clean}`;
}

function looksLikeBase64Video(value: string): boolean {
  const trimmed = value.trim();
  if (/^data:video\//i.test(trimmed)) return true;
  return /^[A-Za-z0-9+/]+={0,2}$/u.test(trimmed) && trimmed.length > 80;
}

function videoishKey(key: string): boolean {
  return /video|mp4|movie|clip|media|bytes|base64/i.test(key);
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
      'successed',
    ].includes(normalized)
  );
}

function isTerminalSuccess(json: Record<string, unknown>): boolean {
  return isSuccessState(jsonState(json), json);
}

function assertProviderJsonOk(json: Record<string, unknown>, providerLabel: string): void {
  const code = json.base_resp ? objectValue(json.base_resp)?.status_code : json.code;
  if (typeof code === 'number' && code !== 0 && code !== 200) {
    throw new Error(providerErrorMessage(json) || `${providerLabel} generation failed.`);
  }
}

function providerErrorMessage(json: Record<string, unknown>): string {
  return (
    stringValue(json.error) ||
    stringValue(json.message) ||
    stringValue(json.msg) ||
    stringValue(json.failure_reason) ||
    stringValue(json.failureReason) ||
    stringValue(objectValue(json.error)?.message) ||
    stringValue(objectValue(json.base_resp)?.status_msg) ||
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

function encodeModelPath(model: string): string {
  return model.split('/').map((part) => encodeURIComponent(part)).join('/');
}

function clampVideoDuration(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.max(MIN_DURATION_SECONDS, Math.min(MAX_DURATION_SECONDS, value));
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

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
