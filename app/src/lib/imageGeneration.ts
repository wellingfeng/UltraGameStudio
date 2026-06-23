import {
  readSettingsRaw,
  type SettingsProfileOptions,
  writeSettingsRaw,
} from '@/lib/generationSettingsStore';
import { generateCloudflareImage, tauriAvailable } from '@/lib/tauri';
import { APP_VERSION } from '@/lib/updateCheck';

export type BuiltInImageProviderId =
  | 'agnes-image'
  | 'siliconflow'
  | 'cloudflare'
  | 'pollinations'
  | 'ai-horde'
  | 'local-comfyui'
  | 'local-vllm-image'
  | 'openai-image'
  | 'openai-compatible-image-router'
  | 'google-gemini-image'
  | 'google-imagen'
  | 'bfl-flux'
  | 'ideogram'
  | 'recraft'
  | 'stability-ai'
  | 'adobe-firefly'
  | 'luma-photon'
  | 'xai-grok-imagine'
  | 'zhipu-cogview'
  | 'dashscope-wanx'
  | 'minimax'
  | 'volcengine-seedream'
  | 'byteplus-seedream'
  | 'replicate'
  | 'fal-ai'
  | 'runware';

export type CustomImageProviderId = `custom:${string}`;
export type ImageProviderId = BuiltInImageProviderId | CustomImageProviderId;

export type ImageProviderCategory = 'commercial' | 'free-credit';

type ImageProviderApiKind =
  | 'cloudflare'
  | 'pollinations'
  | 'ai-horde'
  | 'comfyui'
  | 'siliconflow'
  | 'openai-images'
  | 'google-gemini-image'
  | 'google-imagen'
  | 'bfl-flux'
  | 'ideogram-v4'
  | 'stability-ai'
  | 'adobe-firefly'
  | 'luma-photon'
  | 'xai-images'
  | 'replicate'
  | 'fal-ai'
  | 'runware'
  | 'zhipu-openai'
  | 'dashscope-wanx'
  | 'minimax'
  | 'volcengine-openai';

export type CustomImageProviderApiKind = 'openai-images';

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
  keyLabel?: string;
  keyPlaceholder?: string;
  accountIdLabel?: string;
  accountIdPlaceholder?: string;
  note: string;
  custom?: boolean;
}

export interface CustomImageProviderDefinition {
  id: CustomImageProviderId;
  label: string;
  category: ImageProviderCategory;
  apiKind: CustomImageProviderApiKind;
  defaultModel: string;
  models: string[];
  needsKey: boolean;
  local: boolean;
  defaultBaseUrl: string;
  supportsBaseUrl: true;
  endpointPlaceholder: string;
  credentialUrl?: string;
  keyLabel?: string;
  keyPlaceholder?: string;
  note: string;
}

/**
 * Whether a channel can execute a native ComfyUI node-graph (POST /prompt).
 * Only channels that *are* a ComfyUI deployment qualify — the embedded
 * node-graph editor (/comfyui-mode-start) routes through these. Every other
 * online provider only accepts a text prompt, not a raw ComfyUI graph.
 */
export function imageProviderSupportsComfyUiGraph(id: ImageProviderId): boolean {
  return imageProviderById(id).apiKind === 'comfyui';
}

export interface ImageGenerationSettings {
  enabled: boolean;
  showComposerModelSelect: boolean;
  preferredProviderId: ImageProviderId;
  customProviders: CustomImageProviderDefinition[];
  providerKeys: Partial<Record<ImageProviderId, string>>;
  providerAccountIds: Partial<Record<ImageProviderId, string>>;
  providerBaseUrls: Partial<Record<ImageProviderId, string>>;
  providerModels: Partial<Record<ImageProviderId, string>>;
  providerModelLists: Partial<Record<ImageProviderId, string[]>>;
  /**
   * Visual-QA closed loop. When enabled, a vision model judges each generated
   * image against the prompt; if it scores below `verifyThreshold`, the channel
   * folds the model's defect feedback into the prompt and regenerates, up to
   * `verifyMaxRetries` extra attempts. Requires a direct (anthropic /
   * openai-compatible) coding channel; otherwise verification is skipped.
   */
  verifyEnabled: boolean;
  verifyThreshold: number;
  verifyMaxRetries: number;
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

const STORAGE_KEY = 'ultragamestudio.imageGeneration.v1';
const SETTINGS_REL_PATH = 'settings/imageGeneration.v1.json';

export const IMAGE_PROVIDERS: ImageProviderDefinition[] = [
  {
    id: 'agnes-image',
    label: 'Agnes AI 图片',
    category: 'free-credit',
    apiKind: 'openai-images',
    defaultModel: 'agnes-image-2.1-flash',
    models: ['agnes-image-2.1-flash'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://apihub.agnes-ai.com/v1',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://apihub.agnes-ai.com/v1',
    credentialUrl: 'https://platform.agnes-ai.com',
    note: 'Agnes AI 无限期免费开放的图片模型，OpenAI 兼容 /images/generations 接口。支持多风格文生图与图像编辑，正在灰度新增 4K 与多宽高比。Key 与文本模型通用，在 platform.agnes-ai.com 创建。',
  },
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
    label: 'ComfyUI (本地/远程)',
    category: 'free-credit',
    apiKind: 'comfyui',
    defaultModel: 'default',
    models: [
      'default',
      'flux2',
      'flux-dev',
      'flux-schnell',
      'flux-kontext',
      'z-image-turbo',
      'qwen-image',
      'qwen-image-edit',
      'hunyuan-image-2.1',
      'hidream',
      'hidream-e1.1',
      'sd3.5-large',
      'sd3.5-medium',
      'sdxl',
      'sdxl-turbo',
      'sdxl-lightning',
      'sd1.5',
      'stable-cascade',
      'pixart-sigma',
      'lumina-image-2.0',
      'auraflow',
      'hunyuan-dit',
      'omnigen2',
      'ernie-image',
    ],
    needsKey: false,
    local: true,
    defaultBaseUrl: 'http://127.0.0.1:8188',
    supportsBaseUrl: true,
    endpointPlaceholder: 'http://127.0.0.1:8188',
    credentialUrl: 'https://github.com/comfyanonymous/ComfyUI',
    note: '连接 ComfyUI 服务（本地或远程/云端）。base URL 同时驱动简易生图与聊天流内嵌的 ComfyUI 节点图编辑器（/comfyui-mode-start），支持 ComfyUI 原生节点图 POST /prompt。本地服务通常无需 Key；指向带鉴权的远程端点时填入 API Key。模型清单对齐 ComfyUI 官方支持的本地扩散模型（Flux2、Qwen-Image、HiDream、Z-Image、SD3.5 等）。',
  },
  {
    id: 'local-vllm-image',
    label: '本地 OpenAI Images / vLLM',
    category: 'free-credit',
    apiKind: 'openai-images',
    defaultModel: 'HunyuanImage-3.0',
    models: [
      'HunyuanImage-3.0',
      'FLUX.2',
      'FLUX.1-dev',
      'Qwen-Image',
      'Qwen-Image-Edit',
      'Sana',
      'OmniGen2',
      'HiDream-I1',
      'HiDream-E1',
      'BAGEL',
      'Kolors',
      'SD3.5',
      'PixArt-Sigma',
      'Lumina-Image-2.0',
      'Infinity',
      'Janus-Pro',
    ],
    needsKey: false,
    local: true,
    defaultBaseUrl: 'http://127.0.0.1:8000/v1',
    supportsBaseUrl: true,
    endpointPlaceholder: 'http://127.0.0.1:8000/v1',
    credentialUrl: 'https://docs.vllm.ai',
    note: 'Self-hosted OpenAI-compatible image endpoint. Use it for FLUX.2, Qwen-Image, HunyuanImage-3.0, Sana, OmniGen2, HiDream, BAGEL, Kolors, SD3.5, and lower-priority research models when your local server exposes /v1/images/generations.',
  },
  {
    id: 'openai-image',
    label: 'OpenAI Images',
    category: 'commercial',
    apiKind: 'openai-images',
    defaultModel: 'gpt-image-2',
    models: ['gpt-image-2', 'gpt-image-1.5', 'gpt-image-1'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.openai.com/v1',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.openai.com/v1',
    credentialUrl: 'https://platform.openai.com/api-keys',
    keyPlaceholder: 'sk-...',
    note: 'OpenAI 官方图片生成接口，走 OpenAI-compatible /images/generations；可改 Base URL 指向兼容代理。',
  },
  {
    id: 'openai-compatible-image-router',
    label: 'OpenAI 兼容图片聚合',
    category: 'commercial',
    apiKind: 'openai-images',
    defaultModel: 'gpt-image-2',
    models: [
      'gpt-image-2',
      'gpt-image-1.5',
      'gpt-image-1',
      'Banana-Pro',
      'Banana-2',
      'Banana-1',
      'Midjourney v8.1',
      'Midjourney v8',
      'Midjourney v7',
      'Midjourney v6.1',
      'Midjourney v6',
      'niji-6',
      'niji-5',
      'Jimeng-4.0',
      'Jimeng-3.0pro',
      'Mingmou-1.0',
      'Qwen-0925',
    ],
    needsKey: true,
    local: false,
    defaultBaseUrl: '',
    supportsBaseUrl: true,
    endpointPlaceholder: '粘贴 OpenAI-compatible /v1 Base URL',
    keyPlaceholder: 'API Key',
    note: '通用图片聚合/代理入口。用于 Midjourney、Jimeng、Banana、Qwen 等非官方或聚合商别名；需填写支持 /images/generations 的 Base URL。',
  },
  {
    id: 'google-gemini-image',
    label: 'Google Nano Banana / Gemini Image',
    category: 'commercial',
    apiKind: 'google-gemini-image',
    defaultModel: 'gemini-2.5-flash-image-preview',
    models: [
      'gemini-2.5-flash-image-preview',
      'gemini-3-pro-image-preview',
    ],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://generativelanguage.googleapis.com/v1beta',
    credentialUrl: 'https://aistudio.google.com/apikey',
    note: 'Google Gemini image generation path for Nano Banana-style multi-turn image editing and strong context. Uses generateContent with IMAGE response modality.',
  },
  {
    id: 'google-imagen',
    label: 'Google Imagen 4',
    category: 'commercial',
    apiKind: 'google-imagen',
    defaultModel: 'imagen-4.0-generate-001',
    models: [
      'imagen-4.0-generate-001',
      'imagen-4.0-ultra-generate-001',
      'imagen-4.0-fast-generate-001',
      'imagen-3.0-generate-002',
    ],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://generativelanguage.googleapis.com/v1beta',
    credentialUrl: 'https://aistudio.google.com/apikey',
    note: 'Google Imagen REST path for enterprise/Vertex-aligned quality. Uses models/{model}:predict and parses bytesBase64Encoded results.',
  },
  {
    id: 'bfl-flux',
    label: 'Black Forest Labs FLUX',
    category: 'commercial',
    apiKind: 'bfl-flux',
    defaultModel: 'flux-pro-1.1',
    models: [
      'flux-2-pro',
      'flux-2-flex',
      'flux-kontext-pro',
      'flux-pro-1.1',
      'flux-pro-1.1-ultra',
      'flux-dev',
    ],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.bfl.ai',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.bfl.ai',
    credentialUrl: 'https://api.us1.bfl.ai',
    keyPlaceholder: 'BFL API key',
    note: 'Direct BFL API route for FLUX.2/FLUX.1.1/Kontext/Fill style generation and editing. Polls the BFL result endpoint until an image is ready.',
  },
  {
    id: 'ideogram',
    label: 'Ideogram 4.0',
    category: 'commercial',
    apiKind: 'ideogram-v4',
    defaultModel: 'ideogram-v4',
    models: ['ideogram-v4', 'ideogram-v4-turbo', 'ideogram-v3'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.ideogram.ai',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.ideogram.ai',
    credentialUrl: 'https://developer.ideogram.ai',
    keyPlaceholder: 'Ideogram API key',
    note: 'Poster, brand, logo, and typography-heavy image route. Uses Ideogram v4 generate endpoint with multipart form input.',
  },
  {
    id: 'recraft',
    label: 'Recraft V4.1 / V4',
    category: 'commercial',
    apiKind: 'openai-images',
    defaultModel: 'recraftv4.1',
    models: ['recraftv4.1', 'recraftv4', 'recraft20b'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://external.api.recraft.ai/v1',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://external.api.recraft.ai/v1',
    credentialUrl: 'https://www.recraft.ai/profile/api',
    keyPlaceholder: 'Recraft API key',
    note: 'Design-first commercial visual route with strong brand-color, icon, vector/SVG, and marketing asset workflows. Uses OpenAI-compatible /images/generations.',
  },
  {
    id: 'stability-ai',
    label: 'Stability AI Stable Image',
    category: 'commercial',
    apiKind: 'stability-ai',
    defaultModel: 'stable-image-ultra',
    models: [
      'stable-image-ultra',
      'stable-image-core',
      'sd3.5-large',
      'sd3.5-large-turbo',
      'sd3.5-medium',
      'sdxl',
    ],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.stability.ai/v2beta',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.stability.ai/v2beta',
    credentialUrl: 'https://platform.stability.ai/account/keys',
    keyPlaceholder: 'sk-...',
    note: 'Stable Image / SD3.5 / SDXL route. Supports mature generation/edit/upscale ecosystem; this adapter starts with text-to-image generation.',
  },
  {
    id: 'adobe-firefly',
    label: 'Adobe Firefly Image 4',
    category: 'commercial',
    apiKind: 'adobe-firefly',
    defaultModel: 'image4_standard',
    models: ['image4_standard', 'image4_ultra', 'image3'],
    needsKey: true,
    needsAccountId: true,
    local: false,
    defaultBaseUrl: 'https://firefly-api.adobe.io/v3',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://firefly-api.adobe.io/v3',
    credentialUrl: 'https://developer.adobe.com/firefly-services/docs/firefly-api/getting_started/',
    keyLabel: 'Client Secret',
    keyPlaceholder: 'Adobe client secret',
    accountIdLabel: 'Client ID',
    accountIdPlaceholder: 'Adobe client ID',
    note: 'Enterprise compliance and brand workflow route. Uses Adobe IMS client-credentials token exchange, then Firefly image generation with model version selection.',
  },
  {
    id: 'luma-photon',
    label: 'Luma Photon',
    category: 'commercial',
    apiKind: 'luma-photon',
    defaultModel: 'photon-1',
    models: ['photon-1', 'photon-flash-1'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.lumalabs.ai/dream-machine/v1',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.lumalabs.ai/dream-machine/v1',
    credentialUrl: 'https://lumalabs.ai/api/keys',
    keyPlaceholder: 'luma_...',
    note: 'Fast text-to-image and reference/style workflow route. Starts image generations and polls the Luma generation resource until assets are ready.',
  },
  {
    id: 'xai-grok-imagine',
    label: 'xAI Grok Imagine',
    category: 'commercial',
    apiKind: 'xai-images',
    defaultModel: 'grok-2-image',
    models: ['grok-2-image', 'grok-2-image-1212'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.x.ai/v1',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.x.ai/v1',
    credentialUrl: 'https://console.x.ai',
    keyPlaceholder: 'xai-...',
    note: 'xAI image route for text-to-image with batch/aspect/resolution controls. Uses the OpenAI-style images/generations endpoint.',
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
      'qwen-image-2.0',
      'qwen-image-max',
      'qwen-image-plus',
      'qwen-image',
      'wan2.6-t2i',
      'wan2.5-t2i-preview',
      'wan2.2-t2i-flash',
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
  {
    id: 'byteplus-seedream',
    label: 'BytePlus Seedream',
    category: 'commercial',
    apiKind: 'volcengine-openai',
    defaultModel: 'seedream-4-0',
    models: [
      'seedream-4-0',
      'seedream-3-0-t2i',
      'seedream-3-0-t2i-250415',
    ],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://ark.ap-southeast.bytepluses.com/api/v3',
    credentialUrl: 'https://console.byteplus.com/ark',
    keyPlaceholder: 'BytePlus ModelArk API key',
    note: 'BytePlus/ByteDance Seedream global route. OpenAI-compatible image generation; useful for high consistency, reasoning/knowledge-heavy prompts, and large output workflows.',
  },
  {
    id: 'replicate',
    label: 'Replicate',
    category: 'free-credit',
    apiKind: 'replicate',
    defaultModel: 'black-forest-labs/flux-1.1-pro',
    models: [
      'black-forest-labs/flux-1.1-pro',
      'black-forest-labs/flux-schnell',
      'black-forest-labs/flux-dev',
      'ideogram-ai/ideogram-v2',
      'recraft-ai/recraft-v3',
      'stability-ai/stable-diffusion-3.5-large',
      'qwen/qwen-image',
    ],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.replicate.com/v1',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.replicate.com/v1',
    credentialUrl: 'https://replicate.com/account/api-tokens',
    keyPlaceholder: 'r8_...',
    note: 'Model aggregator route. Best first landing step for quickly expanding the image model pool; choose any Replicate owner/model or owner/model:version string.',
  },
  {
    id: 'fal-ai',
    label: 'fal.ai',
    category: 'free-credit',
    apiKind: 'fal-ai',
    defaultModel: 'fal-ai/flux-pro/v1.1',
    models: [
      'fal-ai/flux-pro/v1.1',
      'fal-ai/flux/dev',
      'fal-ai/flux/schnell',
      'fal-ai/ideogram/v3',
      'fal-ai/recraft-v3',
      'fal-ai/stable-diffusion-v35-large',
      'fal-ai/qwen-image',
    ],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://queue.fal.run',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://queue.fal.run',
    credentialUrl: 'https://fal.ai/dashboard/keys',
    keyPlaceholder: 'fal key',
    note: 'Fast aggregator route with many image/video models. Uses fal queue API and polls returned status/response URLs.',
  },
  {
    id: 'runware',
    label: 'Runware',
    category: 'free-credit',
    apiKind: 'runware',
    defaultModel: 'runware:100@1',
    models: [
      'runware:100@1',
      'runware:101@1',
      'civitai:4384@128713',
      'blackforestlabs:1@1',
    ],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.runware.ai/v1',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.runware.ai/v1',
    credentialUrl: 'https://my.runware.ai/keys',
    keyPlaceholder: 'Runware API key',
    note: 'Aggregator route with low-latency imageInference tasks. Model IDs come from the Runware catalog; override the model field for specific FLUX/Recraft/Ideogram/Qwen routes.',
  },
];

const IMAGE_PROVIDER_BY_ID = new Map<BuiltInImageProviderId, ImageProviderDefinition>(
  IMAGE_PROVIDERS.map((provider) => [provider.id as BuiltInImageProviderId, provider]),
);

function encodeModelPath(model: string): string {
  return model.split('/').map((part) => encodeURIComponent(part)).join('/');
}

function requestHeaders(
  providerId: ImageProviderId,
  settings: ImageGenerationSettings,
  contentType = 'application/json',
): Record<string, string> {
  const provider = imageProviderById(providerId, settings);
  const apiKey = settings.providerKeys[providerId]?.trim();
  if (provider.needsKey && !apiKey) throw new Error(`${provider.label} API key is missing.`);
  const headers: Record<string, string> = {};
  if (contentType) headers['Content-Type'] = contentType;
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

function appendFormValue(
  form: FormData,
  key: string,
  value: string | number | boolean | undefined,
): void {
  if (value === undefined) return;
  form.set(key, String(value));
}

function imageDataUrl(data: string, mimeType = 'image/png'): string {
  const trimmed = data.trim();
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('data:')) return trimmed;
  return `data:${mimeType};base64,${trimmed}`;
}

export const DEFAULT_IMAGE_GENERATION_SETTINGS: ImageGenerationSettings = {
  enabled: true,
  showComposerModelSelect: false,
  preferredProviderId: 'siliconflow',
  customProviders: [],
  providerKeys: {},
  providerAccountIds: {},
  providerBaseUrls: {},
  providerModels: {},
  providerModelLists: {},
  verifyEnabled: false,
  verifyThreshold: 70,
  verifyMaxRetries: 1,
};

function isKnownImageProviderId(
  value: unknown,
  providers: readonly ImageProviderDefinition[],
): value is ImageProviderId {
  return typeof value === 'string' && providers.some((provider) => provider.id === value);
}

function slugifyCustomImageProviderId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  if (normalized) return normalized;
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID().slice(0, 8);
  }
  return Math.random().toString(36).slice(2, 10);
}

export function createCustomImageProviderId(label: string): CustomImageProviderId {
  return `custom:${slugifyCustomImageProviderId(label)}`;
}

function normalizeImageModels(value: unknown, fallback: string): string[] {
  const models = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [fallback, ...models]) {
    const model = raw.trim();
    const key = model.toLowerCase();
    if (!model || seen.has(key)) continue;
    seen.add(key);
    out.push(model);
  }
  return out.length > 0 ? out : ['custom-image-model'];
}

function normalizeCustomImageProvider(
  value: unknown,
  index: number,
  usedIds: Set<string>,
): CustomImageProviderDefinition | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Partial<CustomImageProviderDefinition>;
  const label = typeof source.label === 'string' ? source.label.trim() : '';
  if (!label) return null;
  const rawId = typeof source.id === 'string' ? source.id.trim() : '';
  const baseId = rawId.startsWith('custom:')
    ? rawId
    : `custom:${slugifyCustomImageProviderId(rawId || label || `provider-${index + 1}`)}`;
  let id = baseId as CustomImageProviderId;
  let suffix = 2;
  while (usedIds.has(id) || IMAGE_PROVIDER_BY_ID.has(id as BuiltInImageProviderId)) {
    id = `${baseId}-${suffix}` as CustomImageProviderId;
    suffix += 1;
  }
  usedIds.add(id);
  const defaultModel =
    typeof source.defaultModel === 'string' && source.defaultModel.trim()
      ? source.defaultModel.trim()
      : 'custom-image-model';
  const defaultBaseUrl =
    typeof source.defaultBaseUrl === 'string'
      ? source.defaultBaseUrl.trim().replace(/\/+$/, '')
      : '';
  const endpointPlaceholder =
    typeof source.endpointPlaceholder === 'string' && source.endpointPlaceholder.trim()
      ? source.endpointPlaceholder.trim()
      : 'https://api.example.com/v1';
  return {
    id,
    label,
    category: source.category === 'free-credit' ? 'free-credit' : 'commercial',
    apiKind: 'openai-images',
    defaultModel,
    models: normalizeImageModels(source.models, defaultModel),
    needsKey: source.needsKey !== false,
    local: false,
    defaultBaseUrl,
    supportsBaseUrl: true,
    endpointPlaceholder,
    credentialUrl:
      typeof source.credentialUrl === 'string' && source.credentialUrl.trim()
        ? source.credentialUrl.trim()
        : undefined,
    keyLabel:
      typeof source.keyLabel === 'string' && source.keyLabel.trim()
        ? source.keyLabel.trim()
        : undefined,
    keyPlaceholder:
      typeof source.keyPlaceholder === 'string' && source.keyPlaceholder.trim()
        ? source.keyPlaceholder.trim()
        : undefined,
    note:
      typeof source.note === 'string' && source.note.trim()
        ? source.note.trim()
        : '自定义 OpenAI-compatible 生图渠道。',
  };
}

function normalizeCustomImageProviders(value: unknown): CustomImageProviderDefinition[] {
  if (!Array.isArray(value)) return [];
  const usedIds = new Set<string>();
  return value
    .map((item, index) => normalizeCustomImageProvider(item, index, usedIds))
    .filter((item): item is CustomImageProviderDefinition => !!item);
}

export function imageProviders(
  settings = loadImageGenerationSettings(),
): ImageProviderDefinition[] {
  return [
    ...IMAGE_PROVIDERS,
    ...settings.customProviders.map(
      (provider): ImageProviderDefinition => ({ ...provider, custom: true }),
    ),
  ];
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

function cleanModelListRecord<T extends string>(
  value: unknown,
  validKey: (key: unknown) => key is T,
): Partial<Record<T, string[]>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Partial<Record<T, string[]>> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!validKey(key) || !Array.isArray(raw)) continue;
    const models: string[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
      if (typeof item !== 'string') continue;
      const model = item.trim();
      const dedupeKey = model.toLowerCase();
      if (!model || seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      models.push(model);
    }
    if (models.length > 0) out[key] = models;
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
  const customProviders = normalizeCustomImageProviders(source.customProviders);
  const providers = [
    ...IMAGE_PROVIDERS,
    ...customProviders.map((provider) => ({ ...provider, custom: true })),
  ];
  const preferredProviderId = isKnownImageProviderId(source.preferredProviderId, providers)
    ? source.preferredProviderId
    : DEFAULT_IMAGE_GENERATION_SETTINGS.preferredProviderId;
  const validKey = (key: unknown): key is ImageProviderId =>
    isKnownImageProviderId(key, providers);
  return {
    enabled: true,
    showComposerModelSelect:
      typeof source.showComposerModelSelect === 'boolean'
        ? source.showComposerModelSelect
        : DEFAULT_IMAGE_GENERATION_SETTINGS.showComposerModelSelect,
    preferredProviderId,
    customProviders,
    providerKeys: cleanRecord(source.providerKeys, validKey),
    providerAccountIds: cleanRecord(source.providerAccountIds, validKey),
    providerBaseUrls: cleanRecord(source.providerBaseUrls, validKey),
    providerModels: cleanRecord(source.providerModels, validKey),
    providerModelLists: cleanModelListRecord(source.providerModelLists, validKey),
    verifyEnabled:
      typeof source.verifyEnabled === 'boolean'
        ? source.verifyEnabled
        : DEFAULT_IMAGE_GENERATION_SETTINGS.verifyEnabled,
    verifyThreshold: clampVerifyThreshold(source.verifyThreshold),
    verifyMaxRetries: clampVerifyMaxRetries(source.verifyMaxRetries),
  };
}

function clampVerifyThreshold(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_IMAGE_GENERATION_SETTINGS.verifyThreshold;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function clampVerifyMaxRetries(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_IMAGE_GENERATION_SETTINGS.verifyMaxRetries;
  return Math.max(0, Math.min(3, Math.round(n)));
}

export function loadImageGenerationSettings(
  options: SettingsProfileOptions = {},
): ImageGenerationSettings {
  try {
    const raw = readSettingsRaw(SETTINGS_REL_PATH, STORAGE_KEY, options);
    return normalizeImageGenerationSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return DEFAULT_IMAGE_GENERATION_SETTINGS;
  }
}

export function saveImageGenerationSettings(
  settings: ImageGenerationSettings,
  options: SettingsProfileOptions = {},
): boolean {
  const payload = JSON.stringify(normalizeImageGenerationSettings(settings));
  const ok = writeSettingsRaw(SETTINGS_REL_PATH, STORAGE_KEY, payload, options);
  if (!ok) {
    // Surface the failure instead of silently dropping the write — a swallowed
    // QuotaExceededError here is exactly what makes a freshly-added channel look
    // "saved" in the panel (React state) yet vanish on reload (never hit disk).
    console.error('[imageGeneration] failed to persist settings');
    return false;
  }
  window.dispatchEvent(new Event('ugs:image-generation-settings-changed'));
  return true;
}

export function imageProviderById(
  id: ImageProviderId,
  settings = loadImageGenerationSettings(),
): ImageProviderDefinition {
  return imageProviders(settings).find((provider) => provider.id === id) ?? IMAGE_PROVIDERS[0];
}

export function imageProviderModel(
  providerId: ImageProviderId,
  settings = loadImageGenerationSettings(),
): string {
  const provider = imageProviderById(providerId, settings);
  return settings.providerModels[providerId]?.trim() || provider.defaultModel;
}

export function imageProviderBaseUrl(
  providerId: ImageProviderId,
  settings = loadImageGenerationSettings(),
): string {
  const custom = settings.providerBaseUrls[providerId]?.trim();
  if (custom) return custom.replace(/\/+$/, '');
  return (imageProviderById(providerId, settings).defaultBaseUrl ?? '').replace(/\/+$/, '');
}

export function configuredImageProviderIds(
  settings = loadImageGenerationSettings(),
): ImageProviderId[] {
  return imageProviders(settings).filter((provider) => imageProviderReady(provider.id, settings)).map(
    (provider) => provider.id,
  );
}

export function imageProviderReady(
  providerId: ImageProviderId,
  settings = loadImageGenerationSettings(),
): boolean {
  const provider = imageProviderById(providerId, settings);
  if (provider.needsKey && !settings.providerKeys[providerId]?.trim()) return false;
  if (
    provider.needsAccountId &&
    !settings.providerAccountIds[providerId]?.trim()
  ) {
    return false;
  }
  if (
    provider.supportsBaseUrl &&
    provider.defaultBaseUrl === '' &&
    !imageProviderBaseUrl(providerId, settings)
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
  const providerId = request.providerId ?? preferredReadyImageProviderId(settings);
  if (!providerId) throw new Error('NO_READY_IMAGE_PROVIDER');
  if (!imageProviderReady(providerId, settings)) {
    throw new Error(`IMAGE_PROVIDER_NOT_READY:${providerId}`);
  }
  const provider = imageProviderById(providerId, settings);
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
  switch (imageProviderById(providerId, settings).apiKind) {
    case 'cloudflare':
      return generateCloudflare(prompt, model, settings, signal);
    case 'pollinations':
      return generatePollinations(prompt, model, settings, signal);
    case 'ai-horde':
      return generateAiHorde(prompt, model, settings, signal);
    case 'siliconflow':
      return generateSiliconFlow(prompt, model, settings, signal);
    case 'openai-images':
    case 'zhipu-openai':
      return generateOpenAiImages(providerId, prompt, model, settings, signal);
    case 'google-gemini-image':
      return generateGoogleGeminiImage(prompt, model, settings, signal);
    case 'google-imagen':
      return generateGoogleImagen(prompt, model, settings, signal);
    case 'bfl-flux':
      return generateBflFlux(prompt, model, settings, signal);
    case 'ideogram-v4':
      return generateIdeogram(prompt, model, settings, signal);
    case 'stability-ai':
      return generateStabilityAi(prompt, model, settings, signal);
    case 'adobe-firefly':
      return generateAdobeFirefly(prompt, model, settings, signal);
    case 'luma-photon':
      return generateLumaPhoton(prompt, model, settings, signal);
    case 'xai-images':
      return generateXaiImages(prompt, model, settings, signal);
    case 'replicate':
      return generateReplicate(prompt, model, settings, signal);
    case 'fal-ai':
      return generateFalAi(prompt, model, settings, signal);
    case 'runware':
      return generateRunware(prompt, model, settings, signal);
    case 'dashscope-wanx':
      return generateDashScopeWanx(prompt, model, settings, signal);
    case 'minimax':
      return generateMiniMax(prompt, model, settings, signal);
    case 'volcengine-openai':
      return generateVolcengineSeedream(providerId, prompt, model, settings, signal);
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
  if (tauriAvailable()) {
    return [
      await generateCloudflareImage({
        accountId,
        apiKey,
        model,
        prompt,
      }),
    ];
  }
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
  const provider = imageProviderById(providerId, settings);
  const apiKey = settings.providerKeys[providerId]?.trim();
  if (provider.needsKey && !apiKey) throw new Error(`${provider.label} API key is missing.`);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetch(`${imageProviderBaseUrl(providerId, settings)}/images/generations`, {
    method: 'POST',
    headers,
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

async function generateGoogleGeminiImage(
  prompt: string,
  model: string,
  settings: ImageGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = settings.providerKeys['google-gemini-image']?.trim();
  if (!apiKey) throw new Error('Google API key is missing.');
  const response = await fetch(
    `${imageProviderBaseUrl('google-gemini-image', settings)}/models/${encodeURIComponent(
      model,
    )}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
        },
      }),
      signal,
    },
  );
  return imagesFromResponse(response);
}

async function generateGoogleImagen(
  prompt: string,
  model: string,
  settings: ImageGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = settings.providerKeys['google-imagen']?.trim();
  if (!apiKey) throw new Error('Google API key is missing.');
  const response = await fetch(
    `${imageProviderBaseUrl('google-imagen', settings)}/models/${encodeURIComponent(
      model,
    )}:predict?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: {
          sampleCount: 1,
          aspectRatio: '1:1',
          personGeneration: 'allow_adult',
        },
      }),
      signal,
    },
  );
  return imagesFromResponse(response);
}

async function generateBflFlux(
  prompt: string,
  model: string,
  settings: ImageGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = settings.providerKeys['bfl-flux']?.trim();
  if (!apiKey) throw new Error('BFL API key is missing.');
  const baseUrl = imageProviderBaseUrl('bfl-flux', settings);
  const response = await fetch(`${baseUrl}/v1/${encodeModelPath(model)}`, {
    method: 'POST',
    headers: {
      'x-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt,
      width: 1024,
      height: 1024,
      output_format: 'png',
      safety_tolerance: 2,
    }),
    signal,
  });
  const started = await readJsonResponse(response);
  const immediate = imagesFromJson(started);
  if (immediate.length > 0) return immediate;
  const requestId =
    stringValue(started.id) ||
    stringValue(started.request_id) ||
    stringValue(started.polling_url);
  if (!requestId) throw new Error('BFL did not return a request id.');
  for (let i = 0; i < 120; i += 1) {
    await delay(1000, signal);
    const statusUrl = /^https?:\/\//i.test(requestId)
      ? requestId
      : `${baseUrl}/v1/get_result?id=${encodeURIComponent(requestId)}`;
    const statusResponse = await fetch(statusUrl, {
      headers: { 'x-key': apiKey },
      signal,
    });
    const status = await readJsonResponse(statusResponse);
    const state = stringValue(status.status).toLowerCase();
    if (state === 'error' || state === 'failed') {
      throw new Error(stringValue(status.error) || 'BFL generation failed.');
    }
    const images = imagesFromJson(status);
    if (images.length > 0) return images;
  }
  throw new Error('BFL job timed out before an image was ready.');
}

async function generateIdeogram(
  prompt: string,
  model: string,
  settings: ImageGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = settings.providerKeys.ideogram?.trim();
  if (!apiKey) throw new Error('Ideogram API key is missing.');
  const form = new FormData();
  appendFormValue(form, 'text_prompt', prompt);
  appendFormValue(form, 'rendering_speed', model === 'ideogram-v4-turbo' ? 'TURBO' : 'DEFAULT');
  appendFormValue(form, 'aspect_ratio', '1x1');
  const response = await fetch(`${imageProviderBaseUrl('ideogram', settings)}/v1/ideogram-v4/generate`, {
    method: 'POST',
    headers: { 'Api-Key': apiKey },
    body: form,
    signal,
  });
  return imagesFromResponse(response);
}

async function generateStabilityAi(
  prompt: string,
  model: string,
  settings: ImageGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = settings.providerKeys['stability-ai']?.trim();
  if (!apiKey) throw new Error('Stability AI API key is missing.');
  const form = new FormData();
  appendFormValue(form, 'prompt', prompt);
  appendFormValue(form, 'output_format', 'png');
  const endpoint =
    model === 'stable-image-ultra'
      ? '/stable-image/generate/ultra'
      : model === 'stable-image-core'
        ? '/stable-image/generate/core'
        : model === 'sdxl'
          ? '/stable-image/generate/sdxl'
          : '/stable-image/generate/sd3';
  if (endpoint.endsWith('/sd3')) appendFormValue(form, 'model', model);
  const response = await fetch(`${imageProviderBaseUrl('stability-ai', settings)}${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'image/*',
    },
    body: form,
    signal,
  });
  return imagesFromResponse(response);
}

async function generateAdobeFirefly(
  prompt: string,
  model: string,
  settings: ImageGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const clientId = settings.providerAccountIds['adobe-firefly']?.trim();
  const clientSecret = settings.providerKeys['adobe-firefly']?.trim();
  if (!clientId || !clientSecret) {
    throw new Error('Adobe Firefly Client ID or Client Secret is missing.');
  }
  const tokenBody = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'openid,AdobeID,firefly_api,ff_apis',
  });
  const tokenResponse = await fetch('https://ims-na1.adobelogin.com/ims/token/v3', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenBody,
    signal,
  });
  const tokenJson = await readJsonResponse(tokenResponse);
  const token = stringValue(tokenJson.access_token) || stringValue(tokenJson.accessToken);
  if (!token) throw new Error('Adobe IMS did not return an access token.');
  const response = await fetch(`${imageProviderBaseUrl('adobe-firefly', settings)}/images/generate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-api-key': clientId,
      'x-model-version': model,
    },
    body: JSON.stringify({
      prompt,
      numVariations: 1,
      size: { width: 2048, height: 2048 },
      contentClass: 'photo',
    }),
    signal,
  });
  return imagesFromResponse(response);
}

async function generateLumaPhoton(
  prompt: string,
  model: string,
  settings: ImageGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = settings.providerKeys['luma-photon']?.trim();
  if (!apiKey) throw new Error('Luma API key is missing.');
  const baseUrl = imageProviderBaseUrl('luma-photon', settings);
  const response = await fetch(`${baseUrl}/generations/image`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt,
      model,
      aspect_ratio: '1:1',
    }),
    signal,
  });
  const started = await readJsonResponse(response);
  const immediate = imagesFromJson(started);
  if (immediate.length > 0 && isTerminalSuccess(started)) return immediate;
  const id = stringValue(started.id) || stringValue(started.generation_id);
  if (!id && immediate.length > 0) return immediate;
  if (!id) throw new Error('Luma did not return a generation id.');
  for (let i = 0; i < 120; i += 1) {
    await delay(1500, signal);
    const statusResponse = await fetch(`${baseUrl}/generations/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });
    const status = await readJsonResponse(statusResponse);
    const state = stringValue(status.state).toLowerCase();
    if (state === 'failed' || state === 'error') {
      throw new Error(stringValue(status.failure_reason) || 'Luma generation failed.');
    }
    const images = imagesFromJson(status);
    if (images.length > 0 && (state === 'completed' || state === 'succeeded' || state === 'ready')) {
      return images;
    }
  }
  throw new Error('Luma job timed out before an image was ready.');
}

async function generateXaiImages(
  prompt: string,
  model: string,
  settings: ImageGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const response = await fetch(`${imageProviderBaseUrl('xai-grok-imagine', settings)}/images/generations`, {
    method: 'POST',
    headers: requestHeaders('xai-grok-imagine', settings),
    body: JSON.stringify({
      model,
      prompt,
      n: 1,
      aspect_ratio: '1:1',
      response_format: 'url',
    }),
    signal,
  });
  return imagesFromResponse(response);
}

async function generateReplicate(
  prompt: string,
  model: string,
  settings: ImageGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = settings.providerKeys.replicate?.trim();
  if (!apiKey) throw new Error('Replicate API token is missing.');
  const baseUrl = imageProviderBaseUrl('replicate', settings);
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
      input: {
        prompt,
        aspect_ratio: '1:1',
        output_format: 'png',
        num_outputs: 1,
      },
    }),
    signal,
  });
  const started = await readJsonResponse(response);
  const immediate = imagesFromJson(started);
  if (immediate.length > 0 && isTerminalSuccess(started)) return immediate;
  const statusUrl = stringValue(objectValue(started.urls)?.get) ||
    (stringValue(started.id) ? `${baseUrl}/predictions/${encodeURIComponent(stringValue(started.id))}` : '');
  if (!statusUrl && immediate.length > 0) return immediate;
  if (!statusUrl) throw new Error('Replicate did not return a prediction URL.');
  for (let i = 0; i < 90; i += 1) {
    await delay(1000, signal);
    const statusResponse = await fetch(statusUrl, { headers, signal });
    const status = await readJsonResponse(statusResponse);
    const state = stringValue(status.status).toLowerCase();
    if (state === 'failed' || state === 'canceled') {
      throw new Error(stringValue(status.error) || `Replicate prediction ${state}.`);
    }
    const images = imagesFromJson(status);
    if (images.length > 0 && state === 'succeeded') return images;
  }
  throw new Error('Replicate job timed out before an image was ready.');
}

async function generateFalAi(
  prompt: string,
  model: string,
  settings: ImageGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = settings.providerKeys['fal-ai']?.trim();
  if (!apiKey) throw new Error('fal.ai API key is missing.');
  const baseUrl = imageProviderBaseUrl('fal-ai', settings);
  const headers = {
    Authorization: `Key ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const response = await fetch(`${baseUrl}/${model.replace(/^\/+/, '')}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      prompt,
      image_size: 'square_hd',
      num_images: 1,
      output_format: 'png',
      enable_safety_checker: true,
    }),
    signal,
  });
  const started = await readJsonResponse(response);
  const immediate = imagesFromJson(started);
  if (immediate.length > 0) return immediate;
  const responseUrl = stringValue(started.response_url);
  const statusUrl = stringValue(started.status_url);
  const requestId = stringValue(started.request_id);
  if (!responseUrl && !statusUrl && !requestId) {
    throw new Error('fal.ai did not return a request id.');
  }
  for (let i = 0; i < 120; i += 1) {
    await delay(1000, signal);
    const url =
      statusUrl ||
      `${baseUrl}/${model.replace(/^\/+/, '')}/requests/${encodeURIComponent(requestId)}/status`;
    const statusResponse = await fetch(url, { headers, signal });
    const status = await readJsonResponse(statusResponse);
    const state = stringValue(status.status).toUpperCase();
    if (state === 'FAILED' || state === 'ERROR') {
      throw new Error(stringValue(status.error) || 'fal.ai generation failed.');
    }
    const statusImages = imagesFromJson(status);
    if (statusImages.length > 0) return statusImages;
    if (state === 'COMPLETED' || state === 'SUCCEEDED') {
      const finalUrl =
        responseUrl ||
        `${baseUrl}/${model.replace(/^\/+/, '')}/requests/${encodeURIComponent(requestId)}`;
      const finalResponse = await fetch(finalUrl, { headers, signal });
      const finalJson = await readJsonResponse(finalResponse);
      const images = imagesFromJson(finalJson);
      if (images.length > 0) return images;
      break;
    }
  }
  throw new Error('fal.ai job timed out before an image was ready.');
}

async function generateRunware(
  prompt: string,
  model: string,
  settings: ImageGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const response = await fetch(imageProviderBaseUrl('runware', settings), {
    method: 'POST',
    headers: requestHeaders('runware', settings),
    body: JSON.stringify([
      {
        taskType: 'imageInference',
        taskUUID: crypto.randomUUID(),
        positivePrompt: prompt,
        model,
        width: 1024,
        height: 1024,
        numberResults: 1,
        outputFormat: 'PNG',
      },
    ]),
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
  providerId: ImageProviderId,
  prompt: string,
  model: string,
  settings: ImageGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const provider = imageProviderById(providerId, settings);
  const apiKey = settings.providerKeys[providerId]?.trim();
  if (!apiKey) throw new Error(`${provider.label} API key is missing.`);
  const response = await fetch(
    `${imageProviderBaseUrl(providerId, settings)}/images/generations`,
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
  if (
    model.startsWith('wan2.6') ||
    model.startsWith('qwen-image-2.0') ||
    model.startsWith('qwen-image-max')
  ) {
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
      'Client-Agent': `UltraGameStudio:${APP_VERSION}:github.com/wellingfeng/UltraGameStudio`,
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
  for (const key of [
    'data',
    'images',
    'artifacts',
    'output',
    'outputs',
    'assets',
    'predictions',
    'generated_images',
    'generatedImages',
  ]) {
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
  const inlineData = objectValue(record.inlineData) ?? objectValue(record.inline_data);
  if (inlineData) {
    const data = stringValue(inlineData.data);
    const mimeType = stringValue(inlineData.mimeType) || stringValue(inlineData.mime_type);
    if (data) push(imageDataUrl(data, mimeType || 'image/png'));
  }
  for (const key of [
    'image_urls',
    'imageUrls',
    'image_base64',
    'imageBase64',
    'image_b64',
    'imageB64',
    'images',
    'image',
    'results',
    'artifacts',
    'outputs',
    'assets',
    'predictions',
    'generated_images',
    'generatedImages',
    'candidates',
    'parts',
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
  const bytesBase64 =
    stringValue(record.bytesBase64Encoded) ||
    stringValue(record.bytes_base64_encoded) ||
    stringValue(record.imageBytes) ||
    stringValue(record.image_bytes);
  if (bytesBase64) {
    const mimeType = stringValue(record.mimeType) || stringValue(record.mime_type);
    return imageDataUrl(bytesBase64, mimeType || 'image/png');
  }
  for (const key of [
    'url',
    'uri',
    'image',
    'image_url',
    'imageUrl',
    'imageURL',
    'b64_json',
    'base64',
    'b64',
    'data_url',
    'dataUrl',
    'presignedUrl',
    'signedUrl',
    'output_url',
    'outputUrl',
    'sample',
    'assetUrl',
    'inlineData',
    'inline_data',
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
  return imageDataUrl(value);
}

function isTerminalSuccess(value: Record<string, unknown>): boolean {
  const state = (
    stringValue(value.status) ||
    stringValue(value.state) ||
    stringValue(value.task_status)
  ).toLowerCase();
  return ['succeeded', 'success', 'completed', 'ready', 'done'].includes(state);
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
