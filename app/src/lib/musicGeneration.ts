export type MusicProviderId =
  | 'elevenlabs-music'
  | 'google-lyria'
  | 'minimax-music'
  | 'stability-stable-audio'
  | 'beatoven-maestro'
  | 'mureka-song'
  | 'mureka-instrumental'
  | 'tempolor-song'
  | 'tempolor-instrumental'
  | 'mubert'
  | 'sunoapi-music'
  | 'sonauto-song'
  | 'sonauto-instrumental'
  | 'fal-ace-step'
  | 'fal-stable-audio'
  | 'minimax-music-free'
  | 'minimax-302-music'
  | 'huggingface-musicgen'
  | 'huggingface-audioldm2'
  | 'huggingface-tango2'
  | 'huggingface-stable-audio'
  | 'local-ace-step'
  | 'local-diffrhythm'
  | 'local-yue'
  | 'local-stable-audio'
  | 'local-musicgen'
  | 'local-riffusion'
  | 'local-audioldm2'
  | 'local-tango2'
  | 'local-music-server';

export type MusicProviderCategory = 'commercial' | 'free';

type MusicProviderApiKind =
  | 'elevenlabs-music'
  | 'google-lyria'
  | 'minimax-music'
  | 'stability-stable-audio'
  | 'beatoven-maestro'
  | 'mureka-music'
  | 'tempolor-music'
  | 'mubert'
  | 'sunoapi-music'
  | 'sonauto-music'
  | 'fal-music'
  | 'huggingface-inference'
  | 'generic-local-music';

export interface MusicProviderDefinition {
  id: MusicProviderId;
  label: string;
  category: MusicProviderCategory;
  apiKind: MusicProviderApiKind;
  defaultModel: string;
  models: string[];
  needsKey: boolean;
  local: boolean;
  defaultBaseUrl: string;
  supportsBaseUrl: boolean;
  endpointPlaceholder: string;
  keyProviderId?: MusicProviderId;
  credentialUrl?: string;
  keyLabel?: string;
  keyPlaceholder?: string;
  note: string;
}

export interface MusicGenerationSettings {
  enabled: boolean;
  preferredProviderId: MusicProviderId;
  providerKeys: Partial<Record<MusicProviderId, string>>;
  providerBaseUrls: Partial<Record<MusicProviderId, string>>;
  providerModels: Partial<Record<MusicProviderId, string>>;
}

export interface MusicGenerationResult {
  providerId: MusicProviderId;
  providerLabel: string;
  model: string;
  prompt: string;
  audios: string[];
}

export interface MusicGenerationRequest {
  prompt: string;
  providerId?: MusicProviderId;
  model?: string;
  targetDurationSeconds?: number;
  signal?: AbortSignal;
}

const STORAGE_KEY = 'freeultracode.musicGeneration.v1';
const DEFAULT_DURATION_SECONDS = 30;
const MIN_DURATION_SECONDS = 0.5;
const MAX_DURATION_SECONDS = 600;
const AUDIO_TRIM_TOLERANCE_SECONDS = 0.25;
const AUDIO_ENVELOPE_BLOCK_SECONDS = 0.02;
const AUDIO_EDGE_FADE_SECONDS = 0.006;

export const MUSIC_PROVIDERS: MusicProviderDefinition[] = [
  {
    id: 'elevenlabs-music',
    label: 'ElevenLabs Music',
    category: 'commercial',
    apiKind: 'elevenlabs-music',
    defaultModel: 'music_v1',
    models: ['music_v1'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.elevenlabs.io/v1',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.elevenlabs.io/v1',
    credentialUrl: 'https://elevenlabs.io/app/settings/api-keys',
    keyLabel: 'ElevenLabs API Key',
    keyPlaceholder: 'xi-...',
    note: '官方 Music API。适合完整歌曲、有人声/无人声生成；按 ElevenLabs credits 计费。',
  },
  {
    id: 'google-lyria',
    label: 'Google Lyria',
    category: 'commercial',
    apiKind: 'google-lyria',
    defaultModel: 'lyria-3-clip-preview',
    models: ['lyria-3-clip-preview', 'lyria-3-pro-preview', 'lyria-002'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://generativelanguage.googleapis.com/v1beta',
    credentialUrl: 'https://aistudio.google.com/apikey',
    keyLabel: 'Google API Key',
    keyPlaceholder: 'AIza...',
    note: 'Google Gemini/Lyria 官方音乐生成接口。适合 Google 生态和企业云路线。',
  },
  {
    id: 'minimax-music',
    label: 'MiniMax Music 2.6',
    category: 'commercial',
    apiKind: 'minimax-music',
    defaultModel: 'music-2.6',
    models: ['music-2.6', 'music-cover'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.minimaxi.com/v1',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.minimaxi.com/v1',
    keyProviderId: 'minimax-music-free',
    credentialUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    keyLabel: 'MiniMax API Key',
    keyPlaceholder: 'sk-...',
    note: 'MiniMax 国内开放平台音乐接口。默认走中国区 api.minimaxi.com；海外 Key 可把 Base URL 改成 https://api.minimax.io/v1。',
  },
  {
    id: 'stability-stable-audio',
    label: 'Stability AI Stable Audio',
    category: 'commercial',
    apiKind: 'stability-stable-audio',
    defaultModel: 'stable-audio-2.5',
    models: ['stable-audio-2.5', 'stable-audio-2'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.stability.ai/v2beta',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.stability.ai/v2beta',
    credentialUrl: 'https://platform.stability.ai/account/keys',
    keyLabel: 'Stability API Key',
    keyPlaceholder: 'sk-...',
    note: 'Stable Audio 官方 API。适合音乐、BGM、音效短片段，返回音频文件或音频资源。',
  },
  {
    id: 'beatoven-maestro',
    label: 'Beatoven Maestro',
    category: 'commercial',
    apiKind: 'beatoven-maestro',
    defaultModel: 'maestro',
    models: ['maestro', 'maestro-loop'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://public-api.beatoven.ai',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://public-api.beatoven.ai',
    credentialUrl: 'https://www.beatoven.ai/api',
    keyLabel: 'Beatoven API Token',
    keyPlaceholder: 'Bearer token',
    note: 'Beatoven 官方 Track Composition API。适合视频、播客、商业 BGM；异步任务完成后返回 track_url。',
  },
  {
    id: 'mureka-song',
    label: 'Mureka Song',
    category: 'commercial',
    apiKind: 'mureka-music',
    defaultModel: 'mureka-8',
    models: ['mureka-8', 'mureka-7', 'mureka-6'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.mureka.ai',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.mureka.ai',
    credentialUrl: 'https://platform.mureka.cn/',
    keyLabel: 'Mureka API Key',
    keyPlaceholder: 'Bearer token',
    note: '昆仑 Mureka 官方歌曲生成 API。适合歌词配曲、人声歌曲；也可把 Base URL 改成 Mureka 中国区 API 域名。',
  },
  {
    id: 'mureka-instrumental',
    label: 'Mureka Instrumental',
    category: 'commercial',
    apiKind: 'mureka-music',
    defaultModel: 'mureka-8',
    models: ['mureka-8', 'mureka-7', 'mureka-6'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.mureka.ai',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.mureka.ai',
    keyProviderId: 'mureka-song',
    credentialUrl: 'https://platform.mureka.cn/',
    keyLabel: 'Mureka API Key',
    keyPlaceholder: 'Bearer token',
    note: '昆仑 Mureka 官方纯音乐生成 API。适合 BGM、配乐、无歌词音乐；与 Mureka Song 共用 Key。',
  },
  {
    id: 'tempolor-song',
    label: 'TemPolor Song',
    category: 'commercial',
    apiKind: 'tempolor-music',
    defaultModel: 'TemPolor v4.6',
    models: ['TemPolor v4.6', 'TemPolor v4.5', 'TemPolor v3'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.tempolor.com',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.tempolor.com',
    credentialUrl: 'https://platform.tempolor.com/home',
    keyLabel: 'TemPolor API Key',
    keyPlaceholder: 'Tempo-...',
    note: '天谱乐/TemPolor 官方歌曲生成 API。适合 royalty-free 歌曲、歌词配曲和指定音色生成；查询接口返回 audio_url。',
  },
  {
    id: 'tempolor-instrumental',
    label: 'TemPolor Instrumental',
    category: 'commercial',
    apiKind: 'tempolor-music',
    defaultModel: 'TemPolor i3.5',
    models: ['TemPolor i3.5', 'TemPolor i3', 'TemPolor v4.6'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.tempolor.com',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.tempolor.com',
    keyProviderId: 'tempolor-song',
    credentialUrl: 'https://platform.tempolor.com/home',
    keyLabel: 'TemPolor API Key',
    keyPlaceholder: 'Tempo-...',
    note: '天谱乐/TemPolor 官方纯音乐接口。适合商用 BGM、视频配乐和无歌词音乐；与 TemPolor Song 共用 Key。',
  },
  {
    id: 'mubert',
    label: 'Mubert API',
    category: 'commercial',
    apiKind: 'mubert',
    defaultModel: 'track',
    models: ['track', 'loop', 'jingle', 'mix'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api-b2b.mubert.com/v2',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api-b2b.mubert.com/v2',
    credentialUrl: 'https://mubert.com/api',
    keyLabel: 'Mubert PAT',
    keyPlaceholder: 'Personal access token',
    note: 'Mubert 官方 B2B API。更适合版权安全 BGM；提示词会作为 tags 发送，逗号分隔标签效果更稳。',
  },
  {
    id: 'sunoapi-music',
    label: 'SunoAPI.org',
    category: 'commercial',
    apiKind: 'sunoapi-music',
    defaultModel: 'V5',
    models: ['V5', 'V5_5', 'V4_5PLUS', 'V4_5', 'V4'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.sunoapi.org',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.sunoapi.org',
    credentialUrl: 'https://docs.sunoapi.org/suno-api/quickstart',
    keyLabel: 'SunoAPI.org API Key',
    keyPlaceholder: 'Bearer token',
    note: '第三方 Suno API 服务。适合需要 Suno 模型链路的用户；非 Suno 官方，商用前需单独核授权和地区可用性。',
  },
  {
    id: 'sonauto-song',
    label: 'Sonauto Song',
    category: 'commercial',
    apiKind: 'sonauto-music',
    defaultModel: 'v2.1',
    models: ['v2.1', 'v2'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.sonauto.ai',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.sonauto.ai',
    credentialUrl: 'https://sonauto.ai/developers',
    keyLabel: 'Sonauto API Key',
    keyPlaceholder: 'Bearer token',
    note: 'Sonauto（现 Treblo）官方音乐 API。异步任务，提交后轮询 status 获取音频；适合带歌词的完整歌曲。海外 Key 可把 Base URL 改成 https://api.treblo.com。',
  },
  {
    id: 'sonauto-instrumental',
    label: 'Sonauto Instrumental',
    category: 'commercial',
    apiKind: 'sonauto-music',
    defaultModel: 'v2.1',
    models: ['v2.1', 'v2'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.sonauto.ai',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.sonauto.ai',
    keyProviderId: 'sonauto-song',
    credentialUrl: 'https://sonauto.ai/developers',
    keyLabel: 'Sonauto API Key',
    keyPlaceholder: 'Bearer token',
    note: 'Sonauto（现 Treblo）官方纯音乐 API。BGM、配乐、无歌词；与 Sonauto Song 共用 Key。',
  },
  {
    id: 'fal-ace-step',
    label: 'fal.ai ACE-Step',
    category: 'commercial',
    apiKind: 'fal-music',
    defaultModel: 'fal-ai/ace-step',
    models: ['fal-ai/ace-step'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://queue.fal.run',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://queue.fal.run',
    credentialUrl: 'https://fal.ai/models/fal-ai/ace-step/api',
    keyLabel: 'fal API Key',
    keyPlaceholder: 'key_id:key_secret',
    note: 'fal 托管 ACE-Step。适合不用本地显卡直接跑开源音乐模型；按 fal 队列任务计费。',
  },
  {
    id: 'fal-stable-audio',
    label: 'fal.ai Stable Audio',
    category: 'commercial',
    apiKind: 'fal-music',
    defaultModel: 'fal-ai/stable-audio-25/text-to-audio',
    models: ['fal-ai/stable-audio-25/text-to-audio', 'fal-ai/stable-audio'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://queue.fal.run',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://queue.fal.run',
    keyProviderId: 'fal-ace-step',
    credentialUrl: 'https://fal.ai/models',
    keyLabel: 'fal API Key',
    keyPlaceholder: 'key_id:key_secret',
    note: 'fal 托管 Stable Audio。适合短音乐、loop 和 SFX；与 fal ACE-Step 共用 Key。',
  },
  {
    id: 'minimax-music-free',
    label: 'MiniMax Music Free',
    category: 'free',
    apiKind: 'minimax-music',
    defaultModel: 'music-2.6-free',
    models: ['music-2.6-free', 'music-cover-free'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.minimaxi.com/v1',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.minimaxi.com/v1',
    credentialUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    keyLabel: 'MiniMax API Key',
    keyPlaceholder: 'sk-...',
    note: 'MiniMax 免费音乐模型入口。适合中国区 Key 试用；如果是海外 Key，把 Base URL 改成 https://api.minimax.io/v1。',
  },
  {
    id: 'minimax-302-music',
    label: '302.AI MiniMax Music',
    category: 'commercial',
    apiKind: 'minimax-music',
    defaultModel: 'music-2.5+',
    models: ['music-2.5+', 'music-2.5', 'music-2.0', 'music-1.5'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.302.ai/minimaxi/v1',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.302.ai/minimaxi/v1',
    credentialUrl: 'https://doc.302.ai/241754017e0',
    keyLabel: '302.AI API Key',
    keyPlaceholder: 'sk-...',
    note: '302.AI MiniMax 兼容聚合渠道。适合国内网络环境和低频试用；非 MiniMax 官方直连。',
  },
  {
    id: 'huggingface-musicgen',
    label: 'Hugging Face MusicGen',
    category: 'free',
    apiKind: 'huggingface-inference',
    defaultModel: 'facebook/musicgen-small',
    models: [
      'facebook/musicgen-small',
      'facebook/musicgen-medium',
      'facebook/musicgen-large',
      'facebook/musicgen-melody',
    ],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api-inference.huggingface.co/models',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api-inference.huggingface.co/models',
    credentialUrl: 'https://huggingface.co/settings/tokens',
    keyLabel: 'Hugging Face Token',
    keyPlaceholder: 'hf_...',
    note: 'Hugging Face 官方 Inference API。适合免费额度/实验接入；MusicGen 权重通常非商用，生产前需另核许可。',
  },
  {
    id: 'huggingface-audioldm2',
    label: 'Hugging Face AudioLDM 2',
    category: 'free',
    apiKind: 'huggingface-inference',
    defaultModel: 'cvssp/audioldm2-music',
    models: ['cvssp/audioldm2-music', 'cvssp/audioldm2'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api-inference.huggingface.co/models',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api-inference.huggingface.co/models',
    keyProviderId: 'huggingface-musicgen',
    credentialUrl: 'https://huggingface.co/settings/tokens',
    keyLabel: 'Hugging Face Token',
    keyPlaceholder: 'hf_...',
    note: 'Hugging Face 官方 Inference API。AudioLDM 2 偏 text-to-music / text-to-audio；与其它 Hugging Face 音乐渠道共用同一个 Token。',
  },
  {
    id: 'huggingface-tango2',
    label: 'Hugging Face Tango 2',
    category: 'free',
    apiKind: 'huggingface-inference',
    defaultModel: 'declare-lab/tango2',
    models: ['declare-lab/tango2', 'declare-lab/tango2-full'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api-inference.huggingface.co/models',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api-inference.huggingface.co/models',
    keyProviderId: 'huggingface-musicgen',
    credentialUrl: 'https://huggingface.co/settings/tokens',
    keyLabel: 'Hugging Face Token',
    keyPlaceholder: 'hf_...',
    note: 'Hugging Face 官方 Inference API。Tango 2 偏 text-to-audio / SFX / 氛围音；与其它 Hugging Face 音乐渠道共用同一个 Token。',
  },
  {
    id: 'huggingface-stable-audio',
    label: 'Hugging Face Stable Audio',
    category: 'free',
    apiKind: 'huggingface-inference',
    defaultModel: 'stabilityai/stable-audio-3-small-music',
    models: [
      'stabilityai/stable-audio-3-small-music',
      'stabilityai/stable-audio-3-small-sfx',
      'stabilityai/stable-audio-3-medium',
      'stabilityai/stable-audio-open-1.0',
    ],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api-inference.huggingface.co/models',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api-inference.huggingface.co/models',
    keyProviderId: 'huggingface-musicgen',
    credentialUrl: 'https://huggingface.co/settings/tokens',
    keyLabel: 'Hugging Face Token',
    keyPlaceholder: 'hf_...',
    note: 'Hugging Face 官方 Inference API。Stable Audio 适合音乐和音效实验；部分模型可能需先在 Hugging Face 接受许可或部署 Endpoint。',
  },
  {
    id: 'local-ace-step',
    label: 'Local ACE-Step',
    category: 'free',
    apiKind: 'generic-local-music',
    defaultModel: 'ACE-Step-1.5',
    models: ['ACE-Step-1.5', 'ACE-Step-v1-3.5B'],
    needsKey: false,
    local: true,
    defaultBaseUrl: 'http://127.0.0.1:7865/generate',
    supportsBaseUrl: true,
    endpointPlaceholder: 'http://127.0.0.1:7865/generate',
    credentialUrl: 'https://github.com/ace-step/ACE-Step-1.5',
    note: '本地 ACE-Step 入口。适合歌曲/人声/编曲实验；把本地服务暴露成 POST JSON，返回 audio_url、base64 或原始 audio。',
  },
  {
    id: 'local-diffrhythm',
    label: 'Local DiffRhythm',
    category: 'free',
    apiKind: 'generic-local-music',
    defaultModel: 'DiffRhythm2',
    models: ['DiffRhythm2', 'DiffRhythm-base'],
    needsKey: false,
    local: true,
    defaultBaseUrl: 'http://127.0.0.1:7866/generate',
    supportsBaseUrl: true,
    endpointPlaceholder: 'http://127.0.0.1:7866/generate',
    credentialUrl: 'https://github.com/ASLP-lab/DiffRhythm',
    note: '本地 DiffRhythm 入口。适合 lyrics-to-song / 长歌实验；服务需兼容 POST JSON 输出音频。',
  },
  {
    id: 'local-yue',
    label: 'Local YuE',
    category: 'free',
    apiKind: 'generic-local-music',
    defaultModel: 'YuE',
    models: ['YuE', 'YuE-s1-7B-anneal-en-cot', 'YuE-s2-1B-general'],
    needsKey: false,
    local: true,
    defaultBaseUrl: 'http://127.0.0.1:7867/generate',
    supportsBaseUrl: true,
    endpointPlaceholder: 'http://127.0.0.1:7867/generate',
    credentialUrl: 'https://github.com/multimodal-art-projection/YuE',
    note: '本地 YuE 入口。适合歌词到完整歌曲；显存和推理链路更重，建议先用本地服务包装。',
  },
  {
    id: 'local-stable-audio',
    label: 'Local Stable Audio',
    category: 'free',
    apiKind: 'generic-local-music',
    defaultModel: 'stable-audio-open-1.0',
    models: [
      'stable-audio-open-1.0',
      'stable-audio-3-small-music',
      'stable-audio-3-small-sfx',
      'stable-audio-3-medium',
    ],
    needsKey: false,
    local: true,
    defaultBaseUrl: 'http://127.0.0.1:7868/generate',
    supportsBaseUrl: true,
    endpointPlaceholder: 'http://127.0.0.1:7868/generate',
    credentialUrl: 'https://huggingface.co/stabilityai/stable-audio-open-1.0',
    note: '本地 Stable Audio 入口。适合短音乐、loop、SFX；部分权重可能需在 Hugging Face 接受许可。',
  },
  {
    id: 'local-musicgen',
    label: 'Local AudioCraft MusicGen',
    category: 'free',
    apiKind: 'generic-local-music',
    defaultModel: 'facebook/musicgen-small',
    models: [
      'facebook/musicgen-small',
      'facebook/musicgen-medium',
      'facebook/musicgen-large',
      'facebook/musicgen-melody',
    ],
    needsKey: false,
    local: true,
    defaultBaseUrl: 'http://127.0.0.1:7869/generate',
    supportsBaseUrl: true,
    endpointPlaceholder: 'http://127.0.0.1:7869/generate',
    credentialUrl: 'https://github.com/facebookresearch/audiocraft',
    note: '本地 AudioCraft MusicGen 入口。适合短音乐和旋律条件实验；模型权重多为非商用许可。',
  },
  {
    id: 'local-riffusion',
    label: 'Local Riffusion',
    category: 'free',
    apiKind: 'generic-local-music',
    defaultModel: 'riffusion-model-v1',
    models: ['riffusion-model-v1'],
    needsKey: false,
    local: true,
    defaultBaseUrl: 'http://127.0.0.1:7870/generate',
    supportsBaseUrl: true,
    endpointPlaceholder: 'http://127.0.0.1:7870/generate',
    credentialUrl: 'https://github.com/riffusion/riffusion-hobby',
    note: '本地 Riffusion 入口。适合短 loop / 实时音乐实验；服务需把谱图结果转回 audio 输出。',
  },
  {
    id: 'local-audioldm2',
    label: 'Local AudioLDM 2',
    category: 'free',
    apiKind: 'generic-local-music',
    defaultModel: 'audioldm2-music',
    models: ['audioldm2-music', 'audioldm2-full', 'audioldm2'],
    needsKey: false,
    local: true,
    defaultBaseUrl: 'http://127.0.0.1:7871/generate',
    supportsBaseUrl: true,
    endpointPlaceholder: 'http://127.0.0.1:7871/generate',
    credentialUrl: 'https://github.com/haoheliu/AudioLDM2',
    note: '本地 AudioLDM 2 入口。适合 text-to-music、环境音和 SFX；服务需兼容 POST JSON 输出音频。',
  },
  {
    id: 'local-tango2',
    label: 'Local Tango 2',
    category: 'free',
    apiKind: 'generic-local-music',
    defaultModel: 'declare-lab/tango2',
    models: ['declare-lab/tango2', 'declare-lab/tango2-full'],
    needsKey: false,
    local: true,
    defaultBaseUrl: 'http://127.0.0.1:7872/generate',
    supportsBaseUrl: true,
    endpointPlaceholder: 'http://127.0.0.1:7872/generate',
    credentialUrl: 'https://github.com/declare-lab/tango',
    note: '本地 Tango 2 入口。偏 text-to-audio / SFX / 氛围声，也可做短音乐实验。',
  },
  {
    id: 'local-music-server',
    label: 'Local Music HTTP',
    category: 'free',
    apiKind: 'generic-local-music',
    defaultModel: 'custom-music-model',
    models: ['custom-music-model', 'ACE-Step', 'DiffRhythm', 'MusicGen', 'YuE', 'Stable Audio Open'],
    needsKey: false,
    local: true,
    defaultBaseUrl: 'http://127.0.0.1:7860/generate',
    supportsBaseUrl: true,
    endpointPlaceholder: 'http://127.0.0.1:7860/generate',
    credentialUrl: 'https://github.com/ace-step/ACE-Step-1.5',
    note: '通用本地模型入口。任何自托管音乐服务只要支持 POST JSON 并返回 audio_url、base64 或原始 audio，都可接入。',
  },
];

const MUSIC_PROVIDER_BY_ID = new Map<MusicProviderId, MusicProviderDefinition>(
  MUSIC_PROVIDERS.map((provider) => [provider.id, provider]),
);

export const DEFAULT_MUSIC_GENERATION_SETTINGS: MusicGenerationSettings = {
  enabled: true,
  preferredProviderId: 'elevenlabs-music',
  providerKeys: {},
  providerBaseUrls: {},
  providerModels: {},
};

function hasStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage;
}

function isMusicProviderId(value: unknown): value is MusicProviderId {
  return typeof value === 'string' && MUSIC_PROVIDER_BY_ID.has(value as MusicProviderId);
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

export function normalizeMusicGenerationSettings(
  value: unknown,
): MusicGenerationSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return DEFAULT_MUSIC_GENERATION_SETTINGS;
  }
  const source = value as Partial<MusicGenerationSettings>;
  const preferredProviderId = isMusicProviderId(source.preferredProviderId)
    ? source.preferredProviderId
    : DEFAULT_MUSIC_GENERATION_SETTINGS.preferredProviderId;
  return {
    enabled:
      typeof source.enabled === 'boolean'
        ? source.enabled
        : DEFAULT_MUSIC_GENERATION_SETTINGS.enabled,
    preferredProviderId,
    providerKeys: cleanRecord(source.providerKeys, isMusicProviderId),
    providerBaseUrls: cleanRecord(source.providerBaseUrls, isMusicProviderId),
    providerModels: cleanRecord(source.providerModels, isMusicProviderId),
  };
}

export function loadMusicGenerationSettings(): MusicGenerationSettings {
  if (!hasStorage()) return DEFAULT_MUSIC_GENERATION_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return normalizeMusicGenerationSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return DEFAULT_MUSIC_GENERATION_SETTINGS;
  }
}

export function saveMusicGenerationSettings(settings: MusicGenerationSettings): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(normalizeMusicGenerationSettings(settings)),
    );
    window.dispatchEvent(new Event('fuc:music-generation-settings-changed'));
  } catch {
    /* non-fatal */
  }
}

export function musicProviderById(id: MusicProviderId): MusicProviderDefinition {
  return MUSIC_PROVIDER_BY_ID.get(id) ?? MUSIC_PROVIDERS[0];
}

export function musicProviderModel(
  providerId: MusicProviderId,
  settings = loadMusicGenerationSettings(),
): string {
  const provider = musicProviderById(providerId);
  return settings.providerModels[providerId]?.trim() || provider.defaultModel;
}

export function musicProviderBaseUrl(
  providerId: MusicProviderId,
  settings = loadMusicGenerationSettings(),
): string {
  const custom = settings.providerBaseUrls[providerId]?.trim();
  if (custom) return custom.replace(/\/+$/, '');
  return musicProviderById(providerId).defaultBaseUrl.replace(/\/+$/, '');
}

function musicProviderKey(
  providerId: MusicProviderId,
  settings = loadMusicGenerationSettings(),
): string {
  const provider = musicProviderById(providerId);
  const keyProviderId = provider.keyProviderId ?? providerId;
  return settings.providerKeys[keyProviderId]?.trim() || settings.providerKeys[providerId]?.trim() || '';
}

export function musicProviderReady(
  providerId: MusicProviderId,
  settings = loadMusicGenerationSettings(),
): boolean {
  const provider = musicProviderById(providerId);
  if (provider.needsKey && !musicProviderKey(providerId, settings)) return false;
  if (provider.local && !settings.providerBaseUrls[providerId]?.trim()) return false;
  return !!musicProviderBaseUrl(providerId, settings);
}

export function configuredMusicProviderIds(
  settings = loadMusicGenerationSettings(),
): MusicProviderId[] {
  return MUSIC_PROVIDERS.filter((provider) => musicProviderReady(provider.id, settings)).map(
    (provider) => provider.id,
  );
}

export function preferredReadyMusicProviderId(
  settings = loadMusicGenerationSettings(),
): MusicProviderId | null {
  if (musicProviderReady(settings.preferredProviderId, settings)) {
    return settings.preferredProviderId;
  }
  return configuredMusicProviderIds(settings)[0] ?? null;
}

export function looksLikeMusicGenerationRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  if (/^\/(?:music|song|audio|compose|作曲|音乐|生成音乐)(?:\s|$)/iu.test(normalized)) {
    return true;
  }
  const zhIntent =
    /(生成|创作|写|做|制作|谱)[\s\S]{0,18}(音乐|歌曲|配乐|bgm|音频|旋律|伴奏)/iu.test(text) ||
    /(音乐|歌曲|配乐|bgm|音频|旋律|伴奏)[\s\S]{0,18}(生成|创作|写|做|制作|谱)/iu.test(text);
  if (zhIntent) return true;
  return /\b(generate|create|compose|make|write)\b[\s\S]{0,48}\b(music|song|track|audio|soundtrack|bgm|melody)\b/i.test(
    normalized,
  );
}

export function stripMusicCommand(text: string): string {
  return text
    .trim()
    .replace(/^\/(?:music|song|audio|compose|作曲|音乐|生成音乐)\s+/iu, '')
    .replace(/^请?(?:帮我)?(?:生成|创作|写|做|制作|谱)(?:一首|一段|一个|一些)?(?:音乐|歌曲|配乐|bgm|音频|旋律|伴奏)?/iu, '')
    .trim();
}

export function musicDurationSecondsFromPrompt(prompt: string): number | null {
  const normalized = prompt.replace(/[，。；、]/gu, ' ');
  const clock = normalized.match(/\b(\d{1,2}):([0-5]\d)\b/u);
  if (clock) {
    return clampMusicDuration(Number(clock[1]) * 60 + Number(clock[2]));
  }
  const minuteSecond = normalized.match(
    /(\d+(?:\.\d+)?)\s*(?:分钟|分|minutes?|mins?)\s*(\d+(?:\.\d+)?)?\s*(?:秒钟|秒|s|sec(?:ond)?s?)?/iu,
  );
  if (minuteSecond) {
    const minutes = Number(minuteSecond[1]);
    const seconds = minuteSecond[2] ? Number(minuteSecond[2]) : 0;
    return clampMusicDuration(minutes * 60 + seconds);
  }
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
      const contextScore = /(?:总长|时长|长度|duration|length|clip|片段|音效|音乐|配乐|bgm)/iu.test(
        context,
      )
        ? 2
        : 0;
      const segmentPenalty = /(?:破风|爆发|衰减|尾音|intro|verse|chorus|bridge|outro)/iu.test(
        context,
      )
        ? -1
        : 0;
      const valueScore = value >= 1 ? 1 : -1;
      return { value, score: contextScore + segmentPenalty + valueScore - index * 0.01 };
    })
    .sort((a, b) => b.score - a.score);
  return clampMusicDuration(scored[0].value);
}

export async function generateMusic(
  request: MusicGenerationRequest,
  settings = loadMusicGenerationSettings(),
): Promise<MusicGenerationResult> {
  if (!settings.enabled) throw new Error('MUSIC_GENERATION_DISABLED');
  const providerId = request.providerId ?? preferredReadyMusicProviderId(settings);
  if (!providerId) throw new Error('NO_READY_MUSIC_PROVIDER');
  if (!musicProviderReady(providerId, settings)) {
    throw new Error(`MUSIC_PROVIDER_NOT_READY:${providerId}`);
  }
  const provider = musicProviderById(providerId);
  const prompt = stripMusicCommand(request.prompt);
  const model = request.model?.trim() || musicProviderModel(providerId, settings);
  const requestedDurationSeconds =
    request.targetDurationSeconds ?? musicDurationSecondsFromPrompt(prompt);
  const targetDurationSeconds =
    clampMusicDuration(requestedDurationSeconds ?? DEFAULT_DURATION_SECONDS) ??
    DEFAULT_DURATION_SECONDS;
  const audios = await generateWithProvider(
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
    audios: await postProcessMusicAudios(audios, targetDurationSeconds, request.signal),
  };
}

async function generateWithProvider(
  providerId: MusicProviderId,
  prompt: string,
  model: string,
  settings: MusicGenerationSettings,
  targetDurationSeconds: number,
  signal?: AbortSignal,
): Promise<string[]> {
  switch (musicProviderById(providerId).apiKind) {
    case 'elevenlabs-music':
      return generateElevenLabsMusic(prompt, model, settings, targetDurationSeconds, signal);
    case 'google-lyria':
      return generateGoogleLyria(prompt, model, settings, signal);
    case 'minimax-music':
      return generateMiniMaxMusic(providerId, prompt, model, settings, signal);
    case 'stability-stable-audio':
      return generateStabilityStableAudio(prompt, model, settings, targetDurationSeconds, signal);
    case 'beatoven-maestro':
      return generateBeatovenMaestro(prompt, model, settings, targetDurationSeconds, signal);
    case 'mureka-music':
      return generateMurekaMusic(providerId, prompt, model, settings, signal);
    case 'tempolor-music':
      return generateTemPolorMusic(providerId, prompt, model, settings, signal);
    case 'mubert':
      return generateMubert(prompt, model, settings, targetDurationSeconds, signal);
    case 'sunoapi-music':
      return generateSunoApiMusic(prompt, model, settings, signal);
    case 'sonauto-music':
      return generateSonautoMusic(providerId, prompt, model, settings, signal);
    case 'fal-music':
      return generateFalMusic(providerId, prompt, model, settings, targetDurationSeconds, signal);
    case 'huggingface-inference':
      return generateHuggingFaceMusic(providerId, prompt, model, settings, targetDurationSeconds, signal);
    case 'generic-local-music':
      return generateGenericLocalMusic(providerId, prompt, model, settings, targetDurationSeconds, signal);
  }
}

async function generateElevenLabsMusic(
  prompt: string,
  model: string,
  settings: MusicGenerationSettings,
  targetDurationSeconds: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = settings.providerKeys['elevenlabs-music']?.trim();
  if (!apiKey) throw new Error('ElevenLabs API key is missing.');
  const response = await fetch(`${musicProviderBaseUrl('elevenlabs-music', settings)}/music`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      Accept: 'audio/mpeg, audio/*, application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt,
      model_id: model,
      music_length_ms: Math.round(targetDurationSeconds * 1000),
    }),
    signal,
  });
  return audiosFromResponse(response);
}

async function generateGoogleLyria(
  prompt: string,
  model: string,
  settings: MusicGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = settings.providerKeys['google-lyria']?.trim();
  if (!apiKey) throw new Error('Google API key is missing.');
  const baseUrl = musicProviderBaseUrl('google-lyria', settings);
  const response = await fetch(
    `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: prompt }],
          },
        ],
      }),
      signal,
    },
  );
  return audiosFromResponse(response);
}

async function generateMiniMaxMusic(
  providerId: MusicProviderId,
  prompt: string,
  model: string,
  settings: MusicGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = musicProviderKey(providerId, settings);
  if (!apiKey) throw new Error('MiniMax API key is missing.');
  const lyrics = looksLikeLyrics(prompt) ? prompt : '';
  const body: Record<string, unknown> = {
    model,
    prompt,
    lyrics_optimizer: !lyrics,
    is_instrumental: !lyrics,
    output_format: 'url',
    audio_setting: {
      sample_rate: 44100,
      bitrate: 256000,
      format: 'mp3',
    },
  };
  if (lyrics) body.lyrics = lyrics;
  const response = await fetch(`${musicProviderBaseUrl(providerId, settings)}/music_generation`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'audio/mpeg, audio/*, application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });
  const json = await readJsonResponse(response);
  assertProviderJsonOk(json, 'MiniMax');
  const audios = audiosFromJson(json);
  if (audios.length > 0) return audios;
  throw new Error('MiniMax returned no audio.');
}

async function generateStabilityStableAudio(
  prompt: string,
  model: string,
  settings: MusicGenerationSettings,
  targetDurationSeconds: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = settings.providerKeys['stability-stable-audio']?.trim();
  if (!apiKey) throw new Error('Stability AI API key is missing.');
  const form = new FormData();
  form.set('prompt', prompt);
  form.set('duration', String(targetDurationSeconds));
  form.set('output_format', 'mp3');
  const endpoint = model.includes('2')
    ? '/audio/stable-audio-2/text-to-audio'
    : '/audio/stable-audio/text-to-audio';
  const response = await fetch(`${musicProviderBaseUrl('stability-stable-audio', settings)}${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'audio/mpeg, audio/*, application/json',
    },
    body: form,
    signal,
  });
  return audiosFromResponse(response);
}

async function generateBeatovenMaestro(
  prompt: string,
  model: string,
  settings: MusicGenerationSettings,
  targetDurationSeconds: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = settings.providerKeys['beatoven-maestro']?.trim();
  if (!apiKey) throw new Error('Beatoven API token is missing.');
  const baseUrl = musicProviderBaseUrl('beatoven-maestro', settings);
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const response = await fetch(`${baseUrl}/api/v1/tracks/compose`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      prompt: { text: ensurePromptDuration(prompt, targetDurationSeconds) },
      format: 'mp3',
      looping: model.includes('loop'),
    }),
    signal,
  });
  const started = await readJsonResponse(response);
  const immediate = audiosFromJson(started);
  if (immediate.length > 0) return immediate;
  const taskId = stringValue(started.task_id) || stringValue(started.taskId);
  if (!taskId) throw new Error('Beatoven did not return a task id.');
  for (let i = 0; i < 90; i += 1) {
    await delay(2000, signal);
    const statusResponse = await fetch(`${baseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}`, {
      headers,
      signal,
    });
    const status = await readJsonResponse(statusResponse);
    const state = stringValue(status.status).toLowerCase();
    if (state === 'failed' || state === 'error') {
      throw new Error(stringValue(status.error) || 'Beatoven composition failed.');
    }
    const audios = audiosFromJson(status);
    if (audios.length > 0 && (state === 'composed' || isTerminalSuccess(status))) return audios;
  }
  throw new Error('Beatoven job timed out before audio was ready.');
}

async function generateMurekaMusic(
  providerId: MusicProviderId,
  prompt: string,
  model: string,
  settings: MusicGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = musicProviderKey(providerId, settings);
  if (!apiKey) throw new Error('Mureka API key is missing.');
  const songMode = providerId === 'mureka-song';
  const lyrics = looksLikeLyrics(prompt) ? prompt : defaultLyricsForPrompt(prompt);
  const payload: Record<string, unknown> = songMode
    ? { model, prompt, lyrics, n: 1 }
    : { model, prompt, n: 1 };
  const baseUrl = musicProviderBaseUrl(providerId, settings);
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const response = await fetch(
    `${baseUrl}${songMode ? '/v1/song/generate' : '/v1/instrumental/generate'}`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal,
    },
  );
  const started = await readJsonResponse(response);
  const immediate = audiosFromJson(started);
  if (immediate.length > 0) return immediate;
  const taskId = taskIdFromJson(started);
  if (!taskId) throw new Error('Mureka did not return a task id.');
  const queryPath = songMode ? '/v1/song/query' : '/v1/instrumental/query';
  for (let i = 0; i < 120; i += 1) {
    await delay(5000, signal);
    const statusResponse = await fetch(
      `${baseUrl}${queryPath}/${encodeURIComponent(taskId)}`,
      { headers, signal },
    );
    const status = await readJsonResponse(statusResponse);
    const state = jsonState(status);
    if (isFailedState(state)) {
      throw new Error(providerErrorMessage(status) || 'Mureka generation failed.');
    }
    const audios = audiosFromJson(status);
    if (audios.length > 0 && isSuccessState(state, status)) return audios;
  }
  throw new Error('Mureka job timed out before audio was ready.');
}

async function generateTemPolorMusic(
  providerId: MusicProviderId,
  prompt: string,
  model: string,
  settings: MusicGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = musicProviderKey(providerId, settings);
  if (!apiKey) throw new Error('TemPolor API key is missing.');
  const songMode = providerId === 'tempolor-song';
  const lyrics = looksLikeLyrics(prompt) ? prompt : defaultLyricsForPrompt(prompt);
  const payload: Record<string, unknown> = songMode
    ? { prompt, model, lyrics }
    : { prompt, model };
  const baseUrl = musicProviderBaseUrl(providerId, settings);
  const headers = {
    Authorization: apiKey,
    'Content-Type': 'application/json; charset=utf-8',
  };
  const response = await fetch(
    `${baseUrl}${songMode ? '/open-apis/v1/song/generate' : '/open-apis/v1/instrumental/generate'}`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal,
    },
  );
  const started = await readJsonResponse(response);
  assertProviderJsonOk(started, 'TemPolor');
  const immediate = audiosFromJson(started);
  if (immediate.length > 0) return immediate;
  const taskIds = taskIdsFromJson(started);
  if (taskIds.length === 0) throw new Error('TemPolor did not return item_ids.');
  for (let i = 0; i < 120; i += 1) {
    await delay(5000, signal);
    const statusResponse = await fetch(`${baseUrl}/open-apis/v1/song/query`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ item_ids: taskIds }),
      signal,
    });
    const status = await readJsonResponse(statusResponse);
    assertProviderJsonOk(status, 'TemPolor');
    const state = jsonState(status);
    if (isFailedState(state)) {
      throw new Error(providerErrorMessage(status) || 'TemPolor generation failed.');
    }
    const audios = audiosFromJson(status);
    if (audios.length > 0 && isSuccessState(state, status)) return audios;
  }
  throw new Error('TemPolor job timed out before audio was ready.');
}

async function generateMubert(
  prompt: string,
  model: string,
  settings: MusicGenerationSettings,
  targetDurationSeconds: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const pat = settings.providerKeys.mubert?.trim();
  if (!pat) throw new Error('Mubert personal access token is missing.');
  const response = await fetch(`${musicProviderBaseUrl('mubert', settings)}/RecordTrackTTM`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      method: 'RecordTrackTTM',
      params: {
        pat,
        duration: targetDurationSeconds,
        tags: splitMubertTags(prompt),
        mode: model || 'track',
      },
    }),
    signal,
  });
  return audiosFromResponse(response);
}

async function generateSunoApiMusic(
  prompt: string,
  model: string,
  settings: MusicGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = settings.providerKeys['sunoapi-music']?.trim();
  if (!apiKey) throw new Error('SunoAPI.org API key is missing.');
  const baseUrl = musicProviderBaseUrl('sunoapi-music', settings);
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const response = await fetch(`${baseUrl}/api/v1/generate`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      prompt,
      customMode: false,
      instrumental: false,
      model,
    }),
    signal,
  });
  const started = await readJsonResponse(response);
  assertProviderJsonOk(started, 'SunoAPI.org');
  const immediate = audiosFromJson(started);
  if (immediate.length > 0) return immediate;
  const taskId = taskIdFromJson(started);
  if (!taskId) throw new Error('SunoAPI.org did not return a task id.');
  for (let i = 0; i < 120; i += 1) {
    await delay(3000, signal);
    const statusResponse = await fetch(
      `${baseUrl}/api/v1/generate/record-info?taskId=${encodeURIComponent(taskId)}`,
      { headers, signal },
    );
    const status = await readJsonResponse(statusResponse);
    assertProviderJsonOk(status, 'SunoAPI.org');
    const state = jsonState(status);
    if (isFailedState(state)) {
      throw new Error(providerErrorMessage(status) || 'SunoAPI.org generation failed.');
    }
    const audios = audiosFromJson(status);
    if (audios.length > 0 && isSuccessState(state, status)) return audios;
  }
  throw new Error('SunoAPI.org job timed out before audio was ready.');
}

async function generateSonautoMusic(
  providerId: MusicProviderId,
  prompt: string,
  model: string,
  settings: MusicGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = musicProviderKey(providerId, settings);
  if (!apiKey) throw new Error('Sonauto API key is missing.');
  const baseUrl = musicProviderBaseUrl(providerId, settings);
  const instrumental = providerId === 'sonauto-instrumental';
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const body: Record<string, unknown> = {
    prompt,
    instrumental,
    num_songs: 1,
    output_format: 'mp3',
  };
  if (model && model !== 'v2.1') body.model = model;
  if (!instrumental) {
    const lyrics = looksLikeLyrics(prompt) ? prompt : '';
    // Empty string tells Sonauto to auto-write lyrics from the prompt.
    body.lyrics = lyrics;
  }
  const response = await fetch(`${baseUrl}/v1/generations`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
  const started = await readJsonResponse(response);
  assertProviderJsonOk(started, 'Sonauto');
  const immediate = audiosFromJson(started);
  if (immediate.length > 0) return immediate;
  const taskId = taskIdFromJson(started);
  if (!taskId) throw new Error('Sonauto did not return a task id.');
  for (let i = 0; i < 120; i += 1) {
    await delay(3000, signal);
    const statusResponse = await fetch(
      `${baseUrl}/v1/generations/status/${encodeURIComponent(taskId)}`,
      { headers, signal },
    );
    const status = await readJsonResponse(statusResponse);
    const state = jsonState(status);
    if (isFailedState(state)) {
      throw new Error(providerErrorMessage(status) || 'Sonauto generation failed.');
    }
    if (isSuccessState(state, status)) {
      const resultResponse = await fetch(
        `${baseUrl}/v1/generations/${encodeURIComponent(taskId)}`,
        { headers, signal },
      );
      const result = await readJsonResponse(resultResponse);
      const audios = audiosFromJson(result);
      if (audios.length > 0) return audios;
      throw new Error('Sonauto returned no audio.');
    }
  }
  throw new Error('Sonauto job timed out before audio was ready.');
}

async function generateFalMusic(
  providerId: MusicProviderId,
  prompt: string,
  model: string,
  settings: MusicGenerationSettings,
  targetDurationSeconds: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = musicProviderKey(providerId, settings);
  if (!apiKey) throw new Error('fal API key is missing.');
  const modelPath = model.replace(/^\/+/, '');
  const baseUrl = musicProviderBaseUrl(providerId, settings);
  const headers = {
    Authorization: `Key ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const response = await fetch(`${baseUrl}/${modelPath}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ input: falInput(providerId, prompt, targetDurationSeconds) }),
    signal,
  });
  const started = await readJsonResponse(response);
  const immediate = audiosFromJson(started);
  if (immediate.length > 0) return immediate;
  const requestId = taskIdFromJson(started);
  if (!requestId) throw new Error('fal did not return a request id.');
  const statusUrl =
    stringValue(started.status_url) ||
    `${baseUrl}/${modelPath}/requests/${encodeURIComponent(requestId)}/status`;
  const responseUrl =
    stringValue(started.response_url) ||
    `${baseUrl}/${modelPath}/requests/${encodeURIComponent(requestId)}`;
  for (let i = 0; i < 120; i += 1) {
    await delay(3000, signal);
    const statusResponse = await fetch(statusUrl, { headers, signal });
    const status = await readJsonResponse(statusResponse);
    const state = jsonState(status);
    if (isFailedState(state)) {
      throw new Error(providerErrorMessage(status) || 'fal generation failed.');
    }
    if (isSuccessState(state, status)) {
      const resultResponse = await fetch(responseUrl, { headers, signal });
      const result = await readJsonResponse(resultResponse);
      const audios = audiosFromJson(result);
      if (audios.length > 0) return audios;
      throw new Error('fal returned no audio.');
    }
  }
  throw new Error('fal job timed out before audio was ready.');
}

async function generateHuggingFaceMusic(
  providerId: MusicProviderId,
  prompt: string,
  model: string,
  settings: MusicGenerationSettings,
  targetDurationSeconds: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = musicProviderKey(providerId, settings);
  if (!apiKey) throw new Error('Hugging Face token is missing.');
  const modelPath = model
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  const response = await fetch(
    `${musicProviderBaseUrl(providerId, settings)}/${modelPath}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'audio/mpeg, audio/*, application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        inputs: prompt,
        parameters: {
          duration: targetDurationSeconds,
        },
        options: {
          wait_for_model: true,
        },
      }),
      signal,
    },
  );
  return audiosFromResponse(response);
}

async function generateGenericLocalMusic(
  providerId: MusicProviderId,
  prompt: string,
  model: string,
  settings: MusicGenerationSettings,
  targetDurationSeconds: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const response = await fetch(musicProviderBaseUrl(providerId, settings), {
    method: 'POST',
    headers: {
      Accept: 'audio/mpeg, audio/*, application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt,
      model,
      duration: targetDurationSeconds,
      output_format: 'mp3',
    }),
    signal,
  });
  return audiosFromResponse(response);
}

function ensurePromptDuration(prompt: string, targetDurationSeconds: number): string {
  if (/\b\d+\s*(?:s|sec|secs|second|seconds|秒|分钟|minute|minutes|min)\b/iu.test(prompt)) {
    return prompt;
  }
  return `${targetDurationSeconds} seconds ${prompt}`;
}

function splitMubertTags(prompt: string): string[] {
  const tags = prompt
    .split(/[,，;；\n]/u)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 8);
  return tags.length > 0 ? tags : [prompt.trim()].filter(Boolean);
}

function looksLikeLyrics(prompt: string): boolean {
  const lines = prompt
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    /\[(?:intro|verse|chorus|bridge|outro|hook|pre-chorus|主歌|副歌|前奏|间奏|尾奏|桥段)\]/iu.test(
      prompt,
    ) || lines.length >= 3
  );
}

function defaultLyricsForPrompt(prompt: string): string {
  return `[Verse]\n${prompt}\n\n[Chorus]\n${prompt}`;
}

function falInput(
  providerId: MusicProviderId,
  prompt: string,
  targetDurationSeconds: number,
): Record<string, unknown> {
  if (providerId === 'fal-ace-step') {
    return {
      prompt,
      lyrics: looksLikeLyrics(prompt) ? prompt : '[Instrumental]',
      duration: targetDurationSeconds,
      output_format: 'mp3',
    };
  }
  return {
    prompt,
    duration: targetDurationSeconds,
    seconds_total: targetDurationSeconds,
    output_format: 'mp3',
  };
}

async function postProcessMusicAudios(
  audios: string[],
  targetDurationSeconds: number,
  signal?: AbortSignal,
): Promise<string[]> {
  if (audios.length === 0 || !audioContextConstructor()) return audios;
  const processed: string[] = [];
  for (const src of audios) {
    try {
      processed.push(await trimAudioToDuration(src, targetDurationSeconds, signal));
    } catch (err) {
      if (isAbortError(err)) throw err;
      processed.push(src);
    }
  }
  return processed;
}

async function trimAudioToDuration(
  src: string,
  targetDurationSeconds: number,
  signal?: AbortSignal,
): Promise<string> {
  const AudioContextCtor = audioContextConstructor();
  if (!AudioContextCtor || !isFetchableAudioSource(src)) return src;
  const audioContext = new AudioContextCtor();
  try {
    const blob = await audioBlobFromSource(src, signal);
    const arrayBuffer = await blobToArrayBuffer(blob);
    const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    if (decoded.duration <= targetDurationSeconds + AUDIO_TRIM_TOLERANCE_SECONDS) return src;
    const targetFrames = Math.max(1, Math.round(targetDurationSeconds * decoded.sampleRate));
    const startFrame = bestAudioTrimStartFrame(decoded, targetFrames);
    return wavDataUrlFromAudioBuffer(decoded, startFrame, targetFrames);
  } finally {
    const closing = audioContext.close?.();
    if (closing) void closing.catch(() => {});
  }
}

async function audioBlobFromSource(src: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(src, { signal });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`${response.status} ${response.statusText}${text ? `: ${text}` : ''}`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType && !contentType.startsWith('audio/') && contentType !== 'application/octet-stream') {
    throw new Error(`Expected audio response, got ${contentType}.`);
  }
  return response.blob();
}

function bestAudioTrimStartFrame(buffer: AudioBuffer, targetFrames: number): number {
  const maxStartFrame = Math.max(0, buffer.length - targetFrames);
  if (maxStartFrame === 0) return 0;
  const blockFrames = Math.max(1, Math.round(buffer.sampleRate * AUDIO_ENVELOPE_BLOCK_SECONDS));
  const blockCount = Math.ceil(buffer.length / blockFrames);
  const envelope = new Float32Array(blockCount);
  let maxEnvelope = 0;

  for (let block = 0; block < blockCount; block += 1) {
    const start = block * blockFrames;
    const end = Math.min(buffer.length, start + blockFrames);
    let sumSquares = 0;
    let sampleCount = 0;
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const samples = buffer.getChannelData(channel);
      for (let frame = start; frame < end; frame += 1) {
        const sample = samples[frame] ?? 0;
        sumSquares += sample * sample;
        sampleCount += 1;
      }
    }
    const rms = sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0;
    envelope[block] = rms * rms;
    maxEnvelope = Math.max(maxEnvelope, rms);
  }

  if (maxEnvelope <= 0.000001) return 0;

  const prefix = new Float64Array(blockCount + 1);
  for (let i = 0; i < blockCount; i += 1) {
    prefix[i + 1] = prefix[i] + envelope[i];
  }

  const windowBlocks = Math.max(1, Math.ceil(targetFrames / blockFrames));
  const maxStartBlock = Math.max(0, Math.floor(maxStartFrame / blockFrames));
  let bestStartBlock = 0;
  let bestScore = -Infinity;
  for (let startBlock = 0; startBlock <= maxStartBlock; startBlock += 1) {
    const endBlock = Math.min(blockCount, startBlock + windowBlocks);
    const energy = prefix[endBlock] - prefix[startBlock];
    const startFrame = Math.min(maxStartFrame, startBlock * blockFrames);
    const earlyBias = 1 - Math.min(0.12, (startFrame / buffer.length) * 0.12);
    const score = energy * earlyBias;
    if (score > bestScore) {
      bestScore = score;
      bestStartBlock = startBlock;
    }
  }
  return Math.min(maxStartFrame, bestStartBlock * blockFrames);
}

function wavDataUrlFromAudioBuffer(
  buffer: AudioBuffer,
  startFrame: number,
  requestedFrames: number,
): string {
  const channels = Math.max(1, Math.min(buffer.numberOfChannels, 2));
  const frameCount = Math.min(requestedFrames, buffer.length - startFrame);
  const sampleRate = buffer.sampleRate;
  const bytesPerSample = 2;
  const dataLength = frameCount * channels * bytesPerSample;
  const wav = new ArrayBuffer(44 + dataLength);
  const view = new DataView(wav);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataLength, true);

  const fadeFrames = Math.min(
    Math.round(sampleRate * AUDIO_EDGE_FADE_SECONDS),
    Math.floor(frameCount / 2),
  );
  let offset = 44;
  for (let frame = 0; frame < frameCount; frame += 1) {
    const fade = audioEdgeFade(frame, frameCount, fadeFrames);
    for (let channel = 0; channel < channels; channel += 1) {
      const samples = buffer.getChannelData(channel);
      const sample = clampPcmSample((samples[startFrame + frame] ?? 0) * fade);
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += bytesPerSample;
    }
  }

  return `data:audio/wav;base64,${bytesToBase64(new Uint8Array(wav))}`;
}

function audioEdgeFade(frame: number, frameCount: number, fadeFrames: number): number {
  if (fadeFrames <= 0) return 1;
  if (frame < fadeFrames) return frame / fadeFrames;
  if (frame >= frameCount - fadeFrames) return (frameCount - frame - 1) / fadeFrames;
  return 1;
}

function clampPcmSample(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return globalThis.btoa(binary);
}

function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
      } else {
        reject(new Error('Failed to read audio blob as ArrayBuffer.'));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read audio blob.'));
    reader.readAsArrayBuffer(blob);
  });
}

type AudioContextConstructor = new () => AudioContext;

function audioContextConstructor(): AudioContextConstructor | null {
  const value = globalThis as typeof globalThis & {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  return value.AudioContext ?? value.webkitAudioContext ?? null;
}

function isFetchableAudioSource(src: string): boolean {
  return /^data:audio\//i.test(src) || /^https?:\/\//i.test(src);
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function clampMusicDuration(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.min(MAX_DURATION_SECONDS, Math.max(MIN_DURATION_SECONDS, Math.round(value * 1000) / 1000));
}

async function audiosFromResponse(response: Response): Promise<string[]> {
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`${response.status} ${response.statusText}${text ? `: ${text}` : ''}`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.startsWith('audio/') || contentType === 'application/octet-stream') {
    const blob = await response.blob();
    const audioBlob =
      contentType === 'application/octet-stream'
        ? new Blob([blob], { type: 'audio/mpeg' })
        : blob;
    return [await blobToDataUrl(audioBlob)];
  }
  const json = (await response.json()) as Record<string, unknown>;
  const audios = audiosFromJson(json);
  if (audios.length > 0) return audios;
  throw new Error('Provider returned no audio.');
}

function audiosFromJson(json: Record<string, unknown>): string[] {
  const audios: string[] = [];
  const push = (src: string) => {
    if (!src || audios.includes(src)) return;
    audios.push(src);
  };
  for (const key of [
    'audio',
    'audios',
    'audio_url',
    'audioUrl',
    'audio_urls',
    'audioUrls',
    'audio_file',
    'audioFile',
    'audio_hi_url',
    'audioHiUrl',
    'track_url',
    'trackUrl',
    'streamAudioUrl',
    'stream_audio_url',
    'download_link',
    'downloadLink',
    'download_url',
    'downloadUrl',
    'url',
    'uri',
    'data',
    'result',
    'results',
    'output',
    'outputs',
    'assets',
    'asset',
    'file',
    'files',
    'response',
    'predictions',
    'choices',
    'candidates',
    'content',
    'song',
    'songs',
    'samples',
    'tasks',
    'meta',
  ]) {
    for (const src of audiosFromUnknown(json[key], key)) push(src);
  }
  return audios;
}

function audiosFromUnknown(value: unknown, keyHint = ''): string[] {
  if (!value) return [];
  if (typeof value === 'string') {
    const src = audioString(value, keyHint);
    return src ? [src] : [];
  }
  if (Array.isArray(value)) return value.flatMap((item) => audiosFromUnknown(item, keyHint));
  if (typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const audios: string[] = [];
  const push = (src: string) => {
    if (!src || audios.includes(src)) return;
    audios.push(src);
  };
  const inlineData = objectValue(record.inlineData) ?? objectValue(record.inline_data);
  if (inlineData) {
    const data = stringValue(inlineData.data);
    const mimeType = stringValue(inlineData.mimeType) || stringValue(inlineData.mime_type);
    if (data && isAudioMime(mimeType)) push(audioDataUrl(data, mimeType || 'audio/mpeg'));
  }
  const bytesBase64 =
    stringValue(record.bytesBase64Encoded) ||
    stringValue(record.bytes_base64_encoded) ||
    stringValue(record.audioBytes) ||
    stringValue(record.audio_bytes);
  if (bytesBase64) {
    const mimeType = stringValue(record.mimeType) || stringValue(record.mime_type);
    push(audioDataUrl(bytesBase64, isAudioMime(mimeType) ? mimeType : 'audio/mpeg'));
  }
  for (const key of [
    'audio',
    'audios',
    'audio_url',
    'audioUrl',
    'audio_urls',
    'audioUrls',
    'audio_file',
    'audioFile',
    'audio_hi_url',
    'audioHiUrl',
    'track_url',
    'trackUrl',
    'streamAudioUrl',
    'stream_audio_url',
    'download_link',
    'downloadLink',
    'download_url',
    'downloadUrl',
    'url',
    'uri',
    'data',
    'result',
    'results',
    'output',
    'outputs',
    'assets',
    'asset',
    'file',
    'files',
    'response',
    'predictions',
    'choices',
    'candidates',
    'content',
    'song',
    'songs',
    'samples',
    'tasks',
    'meta',
    'parts',
  ]) {
    for (const src of audiosFromUnknown(record[key], key)) push(src);
  }
  return audios;
}

function audioString(value: string, keyHint: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^data:audio\//i.test(trimmed)) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (
    /audio|bytes/i.test(keyHint) &&
    trimmed.length > 256 &&
    trimmed.length % 2 === 0 &&
    /^[0-9a-f]+$/i.test(trimmed)
  ) {
    return audioDataUrl(hexToBase64(trimmed));
  }
  if (/base64|b64|audio|bytes/i.test(keyHint) && /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    return audioDataUrl(trimmed);
  }
  return null;
}

function audioDataUrl(data: string, mimeType = 'audio/mpeg'): string {
  const trimmed = data.trim();
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('data:')) return trimmed;
  return `data:${mimeType};base64,${trimmed}`;
}

function isAudioMime(value: string): boolean {
  return !value || /^audio\//i.test(value);
}

function isTerminalSuccess(value: Record<string, unknown>): boolean {
  const state = (
    stringValue(value.status) ||
    stringValue(value.state) ||
    stringValue(value.task_status)
  ).toLowerCase();
  return ['succeeded', 'success', 'completed', 'ready', 'done', 'composed'].includes(state);
}

function isSuccessState(state: string, value: Record<string, unknown>): boolean {
  const normalized = state.toLowerCase();
  return (
    [
      'succeeded',
      'success',
      'successful',
      'completed',
      'complete',
      'ready',
      'done',
      'composed',
      'finished',
      'generated',
    ].includes(normalized) || isTerminalSuccess(value)
  );
}

function isFailedState(state: string): boolean {
  return [
    'failed',
    'failure',
    'error',
    'errored',
    'cancelled',
    'canceled',
    'timeout',
    'timeouted',
    'rejected',
  ].includes(state.toLowerCase());
}

function jsonState(value: unknown): string {
  const record = objectValue(value);
  if (!record) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const state = jsonState(item);
        if (state) return state;
      }
    }
    return '';
  }
  const direct =
    scalarString(record.status) ||
    scalarString(record.state) ||
    scalarString(record.task_status) ||
    scalarString(record.taskStatus) ||
    scalarString(record.audio_hi_status) ||
    scalarString(record.audioHiStatus);
  if (direct && !/^\d+$/u.test(direct)) return direct.toLowerCase();
  for (const key of [
    'data',
    'response',
    'result',
    'results',
    'output',
    'outputs',
    'song',
    'songs',
    'tasks',
    'items',
    'records',
  ]) {
    const state = jsonState(record[key]);
    if (state) return state;
  }
  return direct.toLowerCase();
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function scalarString(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function providerErrorMessage(value: unknown): string {
  const record = objectValue(value);
  if (!record) return '';
  const direct =
    scalarString(record.message) ||
    scalarString(record.msg) ||
    scalarString(record.error) ||
    scalarString(record.error_message) ||
    scalarString(record.errorMessage) ||
    scalarString(record.failed_reason) ||
    scalarString(record.reason) ||
    scalarString(record.detail);
  if (direct) return direct;
  const baseResp = objectValue(record.base_resp) ?? objectValue(record.baseResp);
  if (baseResp) {
    return scalarString(baseResp.status_msg) || scalarString(baseResp.statusMsg);
  }
  for (const key of ['data', 'response', 'result', 'error']) {
    const nested = providerErrorMessage(record[key]);
    if (nested) return nested;
  }
  return '';
}

function assertProviderJsonOk(value: Record<string, unknown>, providerLabel: string): void {
  const baseResp = objectValue(value.base_resp) ?? objectValue(value.baseResp);
  if (baseResp) {
    const code = scalarString(baseResp.status_code) || scalarString(baseResp.statusCode);
    if (code && !['0', '200', '200000'].includes(code)) {
      throw new Error(providerErrorMessage(value) || `${providerLabel} returned status ${code}.`);
    }
  }
  const code = scalarString(value.code) || scalarString(value.status_code) || scalarString(value.statusCode);
  if (code && !['0', '200', '200000'].includes(code)) {
    throw new Error(providerErrorMessage(value) || `${providerLabel} returned status ${code}.`);
  }
  const status = scalarString(value.status);
  if (/^\d+$/u.test(status) && !['0', '200', '200000'].includes(status)) {
    throw new Error(providerErrorMessage(value) || `${providerLabel} returned status ${status}.`);
  }
}

function taskIdFromJson(value: Record<string, unknown>): string {
  return (
    scalarString(value.id) ||
    scalarString(value.task_id) ||
    scalarString(value.taskId) ||
    scalarString(value.request_id) ||
    scalarString(value.requestId) ||
    scalarString(value.request_id) ||
    scalarString(value.requestId) ||
    firstScalarFrom(value, ['data', 'response', 'result'], [
      'id',
      'task_id',
      'taskId',
      'request_id',
      'requestId',
    ])
  );
}

function taskIdsFromJson(value: Record<string, unknown>): string[] {
  const ids = idsFromUnknown(value.item_ids).concat(idsFromUnknown(value.itemIds));
  const data = objectValue(value.data);
  if (data) ids.push(...idsFromUnknown(data.item_ids), ...idsFromUnknown(data.itemIds));
  const single = taskIdFromJson(value);
  if (single) ids.push(single);
  return Array.from(new Set(ids.filter(Boolean)));
}

function idsFromUnknown(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(scalarString).filter(Boolean);
  const single = scalarString(value);
  return single ? [single] : [];
}

function firstScalarFrom(
  value: Record<string, unknown>,
  containers: string[],
  keys: string[],
): string {
  for (const containerKey of containers) {
    const container = objectValue(value[containerKey]);
    if (!container) continue;
    for (const key of keys) {
      const found = scalarString(container[key]);
      if (found) return found;
    }
  }
  return '';
}

function hexToBase64(hex: string): string {
  let binary = '';
  for (let i = 0; i < hex.length; i += 2) {
    binary += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16));
  }
  return globalThis.btoa(binary);
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
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read audio blob.'));
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
