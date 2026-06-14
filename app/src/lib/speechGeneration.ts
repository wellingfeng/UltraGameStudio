export type SpeechProviderId =
  | 'elevenlabs'
  | 'openai-tts'
  | 'google-gemini-tts'
  | 'azure-tts'
  | 'cartesia'
  | 'deepgram-aura'
  | 'hume-octave'
  | 'rime-tts'
  | 'playht'
  | 'lmnt'
  | 'resemble'
  | 'speechify'
  | 'minimax-tts'
  | 'dashscope-tts'
  | 'volcengine-tts'
  | 'siliconflow-tts'
  | 'replicate-tts'
  | 'fal-tts'
  | 'huggingface-tts'
  | 'local-kokoro'
  | 'local-gpt-sovits'
  | 'local-fish-speech'
  | 'local-cosyvoice'
  | 'local-index-tts'
  | 'local-chatterbox'
  | 'local-f5-tts'
  | 'local-piper'
  | 'local-openai-speech'
  | 'local-speech-server';

export type SpeechProviderCategory = 'commercial' | 'free';

type SpeechProviderApiKind =
  | 'elevenlabs'
  | 'openai-speech'
  | 'google-gemini-tts'
  | 'azure-tts'
  | 'cartesia'
  | 'deepgram-aura'
  | 'minimax-tts'
  | 'dashscope-tts'
  | 'generic-online-speech'
  | 'replicate'
  | 'fal-ai'
  | 'huggingface-inference'
  | 'generic-local-speech';
export interface SpeechProviderDefinition {
  id: SpeechProviderId;
  label: string;
  category: SpeechProviderCategory;
  apiKind: SpeechProviderApiKind;
  defaultModel: string;
  models: string[];
  defaultVoice: string;
  voices: string[];
  needsKey: boolean;
  needsAccountId?: boolean;
  local: boolean;
  defaultBaseUrl: string;
  supportsBaseUrl: boolean;
  endpointPlaceholder: string;
  keyProviderId?: SpeechProviderId;
  credentialUrl?: string;
  keyLabel?: string;
  keyPlaceholder?: string;
  accountIdLabel?: string;
  accountIdPlaceholder?: string;
  note: string;
}

export interface SpeechGenerationSettings {
  enabled: boolean;
  preferredProviderId: SpeechProviderId;
  providerKeys: Partial<Record<SpeechProviderId, string>>;
  providerAccountIds: Partial<Record<SpeechProviderId, string>>;
  providerBaseUrls: Partial<Record<SpeechProviderId, string>>;
  providerModels: Partial<Record<SpeechProviderId, string>>;
  providerVoices: Partial<Record<SpeechProviderId, string>>;
}

export interface SpeechGenerationResult {
  providerId: SpeechProviderId;
  providerLabel: string;
  model: string;
  voice: string;
  prompt: string;
  audios: string[];
}

export interface SpeechGenerationRequest {
  prompt: string;
  providerId?: SpeechProviderId;
  model?: string;
  voice?: string;
  signal?: AbortSignal;
}

const STORAGE_KEY = 'freeultracode.speechGeneration.v1';
export const SPEECH_PROVIDERS: SpeechProviderDefinition[] = [
  {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    category: 'commercial',
    apiKind: 'elevenlabs',
    defaultModel: 'eleven_v3',
    models: [
      'eleven_v3',
      'eleven_multilingual_v2',
      'eleven_turbo_v2_5',
      'eleven_flash_v2_5',
    ],
    defaultVoice: 'JBFqnCBsd6RMkjVDRZzb',
    voices: ['JBFqnCBsd6RMkjVDRZzb', 'EXAVITQu4vr4xnSDxMaL', 'pNInz6obpgDQGcFmaJgB'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.elevenlabs.io/v1',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.elevenlabs.io/v1',
    credentialUrl: 'https://elevenlabs.io/app/settings/api-keys',
    keyLabel: 'ElevenLabs API Key',
    keyPlaceholder: 'xi-...',
    note: '榜单领先的拟真语音渠道。POST /text-to-speech/{voice_id}，支持多语种、情感和 v3 表现力。Voice 填 voice_id，可在 ElevenLabs 语音库复制。',
  },
  {
    id: 'openai-tts',
    label: 'OpenAI TTS',
    category: 'commercial',
    apiKind: 'openai-speech',
    defaultModel: 'gpt-4o-mini-tts',
    models: ['gpt-4o-mini-tts', 'tts-1-hd', 'tts-1'],
    defaultVoice: 'alloy',
    voices: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.openai.com/v1',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.openai.com/v1',
    credentialUrl: 'https://platform.openai.com/api-keys',
    keyLabel: 'OpenAI API Key',
    keyPlaceholder: 'sk-...',
    note: 'OpenAI /audio/speech 接口，OpenAI 兼容。gpt-4o-mini-tts 支持 instructions 控制语气；可改 Base URL 指向兼容代理。',
  },
  {
    id: 'google-gemini-tts',
    label: 'Google Gemini TTS',
    category: 'commercial',
    apiKind: 'google-gemini-tts',
    defaultModel: 'gemini-2.5-flash-preview-tts',
    models: ['gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts'],
    defaultVoice: 'Kore',
    voices: ['Kore', 'Puck', 'Charon', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://generativelanguage.googleapis.com/v1beta',
    credentialUrl: 'https://aistudio.google.com/apikey',
    keyLabel: 'Google API Key',
    keyPlaceholder: 'AIza...',
    note: 'Gemini 原生 TTS。generateContent 走 AUDIO modality，返回 PCM base64，自动封装为 WAV；支持多语种和可控语气，Voice 填预置音色名。',
  },
  {
    id: 'azure-tts',
    label: 'Azure 语音服务',
    category: 'commercial',
    apiKind: 'azure-tts',
    defaultModel: 'neural',
    models: ['neural', 'hd'],
    defaultVoice: 'zh-CN-XiaoxiaoNeural',
    voices: ['zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural', 'en-US-AvaNeural', 'en-US-AndrewNeural'],
    needsKey: true,
    needsAccountId: true,
    local: false,
    defaultBaseUrl: 'https://eastus.tts.speech.microsoft.com',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://{region}.tts.speech.microsoft.com',
    credentialUrl: 'https://portal.azure.com',
    keyLabel: '订阅密钥',
    keyPlaceholder: 'Azure Speech key',
    accountIdLabel: '区域 Region',
    accountIdPlaceholder: 'eastus',
    note: '微软 Azure 神经网络语音，SSML 合成 /cognitiveservices/v1。区域填 Region（如 eastus），Base URL 需与区域一致；中文音色丰富。',
  },
  {
    id: 'cartesia',
    label: 'Cartesia Sonic',
    category: 'commercial',
    apiKind: 'cartesia',
    defaultModel: 'sonic-2',
    models: ['sonic-2', 'sonic-turbo', 'sonic'],
    defaultVoice: 'bf0a246a-8642-498a-9950-80c35e9276b5',
    voices: ['bf0a246a-8642-498a-9950-80c35e9276b5'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.cartesia.ai',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.cartesia.ai',
    credentialUrl: 'https://play.cartesia.ai/console',
    keyLabel: 'Cartesia API Key',
    keyPlaceholder: 'sk_car_...',
    note: '超低延迟实时语音 /tts/bytes。Sonic 系列适合对话/智能体场景，Voice 填 voice id；默认输出 mp3。',
  },
  {
    id: 'deepgram-aura',
    label: 'Deepgram Aura',
    category: 'commercial',
    apiKind: 'deepgram-aura',
    defaultModel: 'aura-2-thalia-en',
    models: ['aura-2-thalia-en', 'aura-2-andromeda-en', 'aura-asteria-en', 'aura-luna-en'],
    defaultVoice: 'aura-2-thalia-en',
    voices: ['aura-2-thalia-en', 'aura-2-andromeda-en', 'aura-asteria-en'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.deepgram.com/v1',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.deepgram.com/v1',
    credentialUrl: 'https://console.deepgram.com',
    keyLabel: 'Deepgram API Key',
    keyPlaceholder: 'Token ...',
    note: 'Deepgram Aura 低延迟语音 /speak。音色由 model 决定（aura-2-*），Voice 可留空与 model 一致；适合实时英文播报。',
  },
  {
    id: 'hume-octave',
    label: 'Hume Octave',
    category: 'commercial',
    apiKind: 'generic-online-speech',
    defaultModel: 'octave',
    models: ['octave', 'octave-2'],
    defaultVoice: 'ito',
    voices: ['ito', 'kora', 'dacher'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.hume.ai/v0/tts',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.hume.ai/v0/tts',
    credentialUrl: 'https://platform.hume.ai',
    keyLabel: 'Hume API Key',
    keyPlaceholder: 'hume_...',
    note: 'Hume Octave 情感语音大模型。可按描述生成可控情绪音色；默认走通用 JSON 接口解析返回的音频字段或 base64。',
  },
  {
    id: 'rime-tts',
    label: 'Rime',
    category: 'commercial',
    apiKind: 'generic-online-speech',
    defaultModel: 'mistv2',
    models: ['mistv2', 'mist', 'arcana'],
    defaultVoice: 'cove',
    voices: ['cove', 'marsh', 'lagoon'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://users.rime.ai/v1/rime-tts',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://users.rime.ai/v1/rime-tts',
    credentialUrl: 'https://rime.ai/dashboard/tokens',
    keyLabel: 'Rime API Key',
    keyPlaceholder: 'rime_...',
    note: 'Rime 拟真口语语音，适合客服/IVR 场景。默认走通用 JSON 接口，返回 base64 音频；Voice 填 speaker 名。',
  },
  {
    id: 'playht',
    label: 'PlayAI / Play.ht',
    category: 'commercial',
    apiKind: 'generic-online-speech',
    defaultModel: 'PlayDialog',
    models: ['PlayDialog', 'Play3.0-mini', 'PlayHT2.0-turbo'],
    defaultVoice: 'Celeste-PlayAI',
    voices: ['Celeste-PlayAI', 'Angelo-PlayAI'],
    needsKey: true,
    needsAccountId: true,
    local: false,
    defaultBaseUrl: 'https://api.play.ht/api/v2',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.play.ht/api/v2',
    credentialUrl: 'https://play.ht/app/api-access',
    keyLabel: 'Play.ht API Key',
    keyPlaceholder: 'Secret Key',
    accountIdLabel: 'User ID',
    accountIdPlaceholder: 'X-User-Id',
    note: 'PlayAI/Play.ht 语音渠道。需要 API Key 与 User ID（X-User-Id）；默认走通用 JSON 解析，Voice 填官方音色 id。',
  },
  {
    id: 'lmnt',
    label: 'LMNT',
    category: 'commercial',
    apiKind: 'generic-online-speech',
    defaultModel: 'blizzard',
    models: ['blizzard', 'aurora'],
    defaultVoice: 'leah',
    voices: ['leah', 'lily', 'daniel'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.lmnt.com/v1/ai/speech/bytes',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.lmnt.com/v1/ai/speech/bytes',
    credentialUrl: 'https://app.lmnt.com/account',
    keyLabel: 'LMNT API Key',
    keyPlaceholder: 'lmnt_...',
    note: 'LMNT 实时低延迟语音。默认走通用接口，返回音频字节或 base64；适合对话和流式播报，Voice 填官方音色。',
  },
  {
    id: 'resemble',
    label: 'Resemble AI',
    category: 'commercial',
    apiKind: 'generic-online-speech',
    defaultModel: 'chatterbox',
    models: ['chatterbox', 'resemble-enhance'],
    defaultVoice: '',
    voices: [],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://f.cluster.resemble.ai/synthesize',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://f.cluster.resemble.ai/synthesize',
    credentialUrl: 'https://app.resemble.ai/account/api',
    keyLabel: 'Resemble API Token',
    keyPlaceholder: 'Bearer token',
    note: 'Resemble AI 语音克隆/合成。默认走通用 JSON 接口，返回 audio_content 或 URL；Voice 填项目内 voice uuid。',
  },
  {
    id: 'speechify',
    label: 'Speechify',
    category: 'commercial',
    apiKind: 'generic-online-speech',
    defaultModel: 'simba-english',
    models: ['simba-english', 'simba-multilingual', 'simba-turbo'],
    defaultVoice: 'henry',
    voices: ['henry', 'jack', 'lisa'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.sws.speechify.com/v1/audio/speech',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.sws.speechify.com/v1/audio/speech',
    credentialUrl: 'https://console.sws.speechify.com',
    keyLabel: 'Speechify API Key',
    keyPlaceholder: 'Bearer token',
    note: 'Speechify 语音 API。默认走通用接口解析 base64 audio_data；适合长文朗读和多语种，Voice 填官方 voice id。',
  },
  {
    id: 'minimax-tts',
    label: 'MiniMax 语音',
    category: 'commercial',
    apiKind: 'minimax-tts',
    defaultModel: 'speech-2.5-hd-preview',
    models: ['speech-2.5-hd-preview', 'speech-2.5-turbo-preview', 'speech-02-hd', 'speech-01-turbo'],
    defaultVoice: 'male-qn-qingse',
    voices: ['male-qn-qingse', 'female-shaonv', 'audiobook_male_1', 'presenter_female'],
    needsKey: true,
    needsAccountId: true,
    local: false,
    defaultBaseUrl: 'https://api.minimax.io/v1',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.minimax.io/v1',
    credentialUrl: 'https://platform.minimax.io/user-center/basic-information',
    keyLabel: 'MiniMax API Key',
    keyPlaceholder: 'sk-...',
    accountIdLabel: 'GroupId',
    accountIdPlaceholder: 'group_id',
    note: 'MiniMax/海螺 T2A v2 语音 /t2a_v2，中文领先。需要 API Key 与 GroupId；返回 hex 音频自动解码，中国区可改 api.minimaxi.com。',
  },
  {
    id: 'dashscope-tts',
    label: '阿里百炼 CosyVoice',
    category: 'commercial',
    apiKind: 'dashscope-tts',
    defaultModel: 'cosyvoice-v2',
    models: ['cosyvoice-v2', 'cosyvoice-v1', 'sambert-zhichu-v1'],
    defaultVoice: 'longxiaochun',
    voices: ['longxiaochun', 'longwan', 'longcheng', 'longhua'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://dashscope.aliyuncs.com/api/v1',
    credentialUrl: 'https://bailian.console.aliyun.com/?apiKey=1#/api-key-center',
    keyLabel: 'DashScope API Key',
    keyPlaceholder: 'sk-...',
    note: '阿里通义 CosyVoice 语音合成。中文生态友好，走多模态生成接口返回音频 URL；Voice 填官方音色（如 longxiaochun）。',
  },
  {
    id: 'volcengine-tts',
    label: '火山引擎语音',
    category: 'commercial',
    apiKind: 'generic-online-speech',
    defaultModel: 'volcano_tts',
    models: ['volcano_tts', 'volcano_icl'],
    defaultVoice: 'zh_female_cancan_mars_bigtts',
    voices: ['zh_female_cancan_mars_bigtts', 'zh_male_M392_conversation_wvae_bigtts'],
    needsKey: true,
    needsAccountId: true,
    local: false,
    defaultBaseUrl: 'https://openspeech.bytedance.com/api/v1/tts',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://openspeech.bytedance.com/api/v1/tts',
    credentialUrl: 'https://console.volcengine.com/speech',
    keyLabel: 'Access Token',
    keyPlaceholder: 'Bearer;Token',
    accountIdLabel: 'AppId',
    accountIdPlaceholder: 'app_id',
    note: '字节火山引擎（豆包）语音合成。需要 Access Token 与 AppId；默认走通用接口解析 base64 data，中文音色丰富。',
  },
  {
    id: 'siliconflow-tts',
    label: '硅基流动 SiliconFlow',
    category: 'commercial',
    apiKind: 'openai-speech',
    defaultModel: 'FunAudioLLM/CosyVoice2-0.5B',
    models: ['FunAudioLLM/CosyVoice2-0.5B', 'fishaudio/fish-speech-1.5', 'RVC-Boss/GPT-SoVITS'],
    defaultVoice: 'FunAudioLLM/CosyVoice2-0.5B:alex',
    voices: ['FunAudioLLM/CosyVoice2-0.5B:alex', 'FunAudioLLM/CosyVoice2-0.5B:anna'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.siliconflow.cn/v1',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.siliconflow.cn/v1',
    credentialUrl: 'https://cloud.siliconflow.cn/account/ak',
    keyLabel: 'SiliconFlow API Key',
    keyPlaceholder: 'sk-...',
    note: '硅基流动 /audio/speech，OpenAI 兼容。托管 CosyVoice2、Fish-Speech、GPT-SoVITS 等开源语音模型；Voice 填官方音色或自定义音色。',
  },
  // __FREE__
  {
    id: 'replicate-tts',
    label: 'Replicate 语音模型',
    category: 'free',
    apiKind: 'replicate',
    defaultModel: 'jaaari/kokoro-82m',
    models: [
      'jaaari/kokoro-82m',
      'lucataco/xtts-v2',
      'minimax/speech-02-hd',
      'resemble-ai/chatterbox',
      'x-lance/f5-tts',
    ],
    defaultVoice: 'af_bella',
    voices: ['af_bella', 'af_sarah', 'am_adam', 'bf_emma'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.replicate.com/v1',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.replicate.com/v1',
    credentialUrl: 'https://replicate.com/account/api-tokens',
    keyLabel: 'Replicate API Token',
    keyPlaceholder: 'r8_...',
    note: 'Replicate 聚合语音模型，通常注册送额度。覆盖 Kokoro、XTTS-v2、Chatterbox、F5-TTS、MiniMax 等；模型字段可填 owner/model 或 owner/model:version。',
  },
  {
    id: 'fal-tts',
    label: 'fal.ai 语音模型',
    category: 'free',
    apiKind: 'fal-ai',
    defaultModel: 'fal-ai/kokoro',
    models: [
      'fal-ai/kokoro',
      'fal-ai/chatterbox/text-to-speech',
      'fal-ai/f5-tts',
      'fal-ai/minimax/speech-02-hd',
      'fal-ai/elevenlabs/tts/multilingual-v2',
    ],
    defaultVoice: 'af_heart',
    voices: ['af_heart', 'af_bella', 'am_adam'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://queue.fal.run',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://queue.fal.run',
    credentialUrl: 'https://fal.ai/dashboard/keys',
    keyLabel: 'fal API Key',
    keyPlaceholder: 'fal key',
    note: 'fal.ai 聚合语音队列，常有试用额度。适合快速接入 Kokoro、Chatterbox、F5-TTS、MiniMax、ElevenLabs 等模型。',
  },
  {
    id: 'huggingface-tts',
    label: 'Hugging Face 语音模型',
    category: 'free',
    apiKind: 'huggingface-inference',
    defaultModel: 'hexgrad/Kokoro-82M',
    models: [
      'hexgrad/Kokoro-82M',
      'fishaudio/fish-speech-1.5',
      'coqui/XTTS-v2',
      'SWivid/F5-TTS',
      'microsoft/speecht5_tts',
    ],
    defaultVoice: '',
    voices: [],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api-inference.huggingface.co/models',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api-inference.huggingface.co/models',
    credentialUrl: 'https://huggingface.co/settings/tokens',
    keyLabel: 'Hugging Face Token',
    keyPlaceholder: 'hf_...',
    note: 'Hugging Face Inference 渠道。适合免费额度和自托管 Endpoint；部分模型需先接受许可或使用专属 Endpoint，返回音频字节。',
  },
  {
    id: 'local-kokoro',
    label: '本地 Kokoro TTS',
    category: 'free',
    apiKind: 'openai-speech',
    defaultModel: 'kokoro',
    models: ['kokoro'],
    defaultVoice: 'af_bella',
    voices: ['af_bella', 'af_sarah', 'am_adam', 'bf_emma', 'zf_xiaoxiao'],
    needsKey: false,
    local: true,
    defaultBaseUrl: 'http://127.0.0.1:8880/v1',
    supportsBaseUrl: true,
    endpointPlaceholder: 'http://127.0.0.1:8880/v1',
    credentialUrl: 'https://github.com/remsky/Kokoro-FastAPI',
    note: '本地 Kokoro-FastAPI（OpenAI 兼容 /audio/speech）。轻量高质量开源语音，支持中英日等多语种，无需 Key。',
  },
  {
    id: 'local-gpt-sovits',
    label: '本地 GPT-SoVITS',
    category: 'free',
    apiKind: 'generic-local-speech',
    defaultModel: 'gpt-sovits-v2',
    models: ['gpt-sovits-v2', 'gpt-sovits-v3', 'gpt-sovits-v4'],
    defaultVoice: 'default',
    voices: ['default'],
    needsKey: false,
    local: true,
    defaultBaseUrl: 'http://127.0.0.1:9880/tts',
    supportsBaseUrl: true,
    endpointPlaceholder: 'http://127.0.0.1:9880/tts',
    credentialUrl: 'https://github.com/RVC-Boss/GPT-SoVITS',
    note: '本地 GPT-SoVITS 少样本语音克隆。中文社区流行，几秒参考音频即可克隆音色；服务支持 POST JSON 返回音频字节或 URL。',
  },
  {
    id: 'local-fish-speech',
    label: '本地 Fish Speech',
    category: 'free',
    apiKind: 'generic-local-speech',
    defaultModel: 'fish-speech-1.5',
    models: ['fish-speech-1.5', 'openaudio-s1-mini'],
    defaultVoice: 'default',
    voices: ['default'],
    needsKey: false,
    local: true,
    defaultBaseUrl: 'http://127.0.0.1:8080/v1/tts',
    supportsBaseUrl: true,
    endpointPlaceholder: 'http://127.0.0.1:8080/v1/tts',
    credentialUrl: 'https://github.com/fishaudio/fish-speech',
    note: '本地 Fish Speech / OpenAudio。多语种零样本语音克隆，自带 HTTP API；POST JSON 返回音频字节或 base64。',
  },
  {
    id: 'local-cosyvoice',
    label: '本地 CosyVoice',
    category: 'free',
    apiKind: 'generic-local-speech',
    defaultModel: 'CosyVoice2-0.5B',
    models: ['CosyVoice2-0.5B', 'CosyVoice-300M'],
    defaultVoice: '中文女',
    voices: ['中文女', '中文男', '英文女', '英文男'],
    needsKey: false,
    local: true,
    defaultBaseUrl: 'http://127.0.0.1:50000/tts',
    supportsBaseUrl: true,
    endpointPlaceholder: 'http://127.0.0.1:50000/tts',
    credentialUrl: 'https://github.com/FunAudioLLM/CosyVoice',
    note: '本地阿里 CosyVoice。流式、零样本和跨语言克隆，中文表现强；用简单 HTTP 包装器 POST JSON 返回音频。',
  },
  {
    id: 'local-index-tts',
    label: '本地 IndexTTS',
    category: 'free',
    apiKind: 'generic-local-speech',
    defaultModel: 'IndexTTS-2',
    models: ['IndexTTS-2', 'IndexTTS-1.5'],
    defaultVoice: 'default',
    voices: ['default'],
    needsKey: false,
    local: true,
    defaultBaseUrl: 'http://127.0.0.1:7860/tts',
    supportsBaseUrl: true,
    endpointPlaceholder: 'http://127.0.0.1:7860/tts',
    credentialUrl: 'https://github.com/index-tts/index-tts',
    note: '本地 B 站 IndexTTS。工业级零样本语音克隆，情感和时长可控，中英文俱佳；POST JSON 返回音频字节或 URL。',
  },
  {
    id: 'local-chatterbox',
    label: '本地 Chatterbox',
    category: 'free',
    apiKind: 'generic-local-speech',
    defaultModel: 'chatterbox',
    models: ['chatterbox', 'chatterbox-multilingual'],
    defaultVoice: 'default',
    voices: ['default'],
    needsKey: false,
    local: true,
    defaultBaseUrl: 'http://127.0.0.1:5000/tts',
    supportsBaseUrl: true,
    endpointPlaceholder: 'http://127.0.0.1:5000/tts',
    credentialUrl: 'https://github.com/resemble-ai/chatterbox',
    note: '本地 Resemble Chatterbox 开源语音。支持情感夸张度控制和多语种零样本克隆；POST JSON 返回音频字节或 base64。',
  },
  {
    id: 'local-f5-tts',
    label: '本地 F5-TTS',
    category: 'free',
    apiKind: 'generic-local-speech',
    defaultModel: 'F5-TTS',
    models: ['F5-TTS', 'E2-TTS'],
    defaultVoice: 'default',
    voices: ['default'],
    needsKey: false,
    local: true,
    defaultBaseUrl: 'http://127.0.0.1:7861/tts',
    supportsBaseUrl: true,
    endpointPlaceholder: 'http://127.0.0.1:7861/tts',
    credentialUrl: 'https://github.com/SWivid/F5-TTS',
    note: '本地 F5-TTS 流匹配语音克隆。参考音频即可零样本克隆，中英文支持好；POST JSON 返回音频字节或 URL。',
  },
  {
    id: 'local-piper',
    label: '本地 Piper',
    category: 'free',
    apiKind: 'generic-local-speech',
    defaultModel: 'piper',
    models: ['piper'],
    defaultVoice: 'zh_CN-huayan-medium',
    voices: ['zh_CN-huayan-medium', 'en_US-amy-medium', 'en_US-lessac-high'],
    needsKey: false,
    local: true,
    defaultBaseUrl: 'http://127.0.0.1:5500/api/tts',
    supportsBaseUrl: true,
    endpointPlaceholder: 'http://127.0.0.1:5500/api/tts',
    credentialUrl: 'https://github.com/rhasspy/piper',
    note: '本地 Piper 轻量神经语音，CPU 即可运行、延迟极低。适合离线和嵌入式播报；POST JSON 或表单返回 wav 字节。',
  },
  {
    id: 'local-openai-speech',
    label: '本地 OpenAI Speech / vLLM',
    category: 'free',
    apiKind: 'openai-speech',
    defaultModel: 'tts-1',
    models: ['tts-1', 'kokoro', 'CosyVoice2-0.5B', 'fish-speech-1.5'],
    defaultVoice: 'alloy',
    voices: ['alloy', 'echo', 'nova', 'shimmer'],
    needsKey: false,
    local: true,
    defaultBaseUrl: 'http://127.0.0.1:8000/v1',
    supportsBaseUrl: true,
    endpointPlaceholder: 'http://127.0.0.1:8000/v1',
    credentialUrl: 'https://docs.vllm.ai',
    note: '自托管 OpenAI 兼容语音 /v1/audio/speech。适合用 vLLM、Speaches、openedai-speech 等暴露本地语音模型，无需 Key。',
  },
  {
    id: 'local-speech-server',
    label: '本地/自定义语音 HTTP',
    category: 'free',
    apiKind: 'generic-local-speech',
    defaultModel: 'custom-tts-model',
    models: ['custom-tts-model', 'kokoro', 'gpt-sovits', 'cosyvoice', 'fish-speech', 'piper'],
    defaultVoice: 'default',
    voices: ['default'],
    needsKey: false,
    local: true,
    defaultBaseUrl: 'http://127.0.0.1:8088/tts',
    supportsBaseUrl: true,
    endpointPlaceholder: 'http://127.0.0.1:8088/tts',
    credentialUrl: 'https://github.com/remsky/Kokoro-FastAPI',
    note: '通用自托管语音入口。任何本地/内网服务支持 POST JSON，返回音频字节、audio_url、base64 或 status_url/task_id 即可接入。',
  },
];

const SPEECH_PROVIDER_BY_ID = new Map<SpeechProviderId, SpeechProviderDefinition>(
  SPEECH_PROVIDERS.map((provider) => [provider.id, provider]),
);

export const DEFAULT_SPEECH_GENERATION_SETTINGS: SpeechGenerationSettings = {
  enabled: true,
  preferredProviderId: 'openai-tts',
  providerKeys: {},
  providerAccountIds: {},
  providerBaseUrls: {},
  providerModels: {},
  providerVoices: {},
};

function hasStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage;
}

function isSpeechProviderId(value: unknown): value is SpeechProviderId {
  return typeof value === 'string' && SPEECH_PROVIDER_BY_ID.has(value as SpeechProviderId);
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

export function normalizeSpeechGenerationSettings(value: unknown): SpeechGenerationSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return DEFAULT_SPEECH_GENERATION_SETTINGS;
  }
  const source = value as Partial<SpeechGenerationSettings>;
  const preferredProviderId = isSpeechProviderId(source.preferredProviderId)
    ? source.preferredProviderId
    : DEFAULT_SPEECH_GENERATION_SETTINGS.preferredProviderId;
  return {
    enabled:
      typeof source.enabled === 'boolean'
        ? source.enabled
        : DEFAULT_SPEECH_GENERATION_SETTINGS.enabled,
    preferredProviderId,
    providerKeys: cleanRecord(source.providerKeys, isSpeechProviderId),
    providerAccountIds: cleanRecord(source.providerAccountIds, isSpeechProviderId),
    providerBaseUrls: cleanRecord(source.providerBaseUrls, isSpeechProviderId),
    providerModels: cleanRecord(source.providerModels, isSpeechProviderId),
    providerVoices: cleanRecord(source.providerVoices, isSpeechProviderId),
  };
}

export function loadSpeechGenerationSettings(): SpeechGenerationSettings {
  if (!hasStorage()) return DEFAULT_SPEECH_GENERATION_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return normalizeSpeechGenerationSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return DEFAULT_SPEECH_GENERATION_SETTINGS;
  }
}

export function saveSpeechGenerationSettings(settings: SpeechGenerationSettings): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(normalizeSpeechGenerationSettings(settings)),
    );
    window.dispatchEvent(new Event('fuc:speech-generation-settings-changed'));
  } catch {
    /* non-fatal */
  }
}

export function speechProviderById(id: SpeechProviderId): SpeechProviderDefinition {
  return SPEECH_PROVIDER_BY_ID.get(id) ?? SPEECH_PROVIDERS[0];
}

export function speechProviderModel(
  providerId: SpeechProviderId,
  settings = loadSpeechGenerationSettings(),
): string {
  const provider = speechProviderById(providerId);
  return settings.providerModels[providerId]?.trim() || provider.defaultModel;
}

export function speechProviderVoice(
  providerId: SpeechProviderId,
  settings = loadSpeechGenerationSettings(),
): string {
  const provider = speechProviderById(providerId);
  return settings.providerVoices[providerId]?.trim() || provider.defaultVoice;
}

export function speechProviderBaseUrl(
  providerId: SpeechProviderId,
  settings = loadSpeechGenerationSettings(),
): string {
  const custom = settings.providerBaseUrls[providerId]?.trim();
  if (custom) return custom.replace(/\/+$/, '');
  return speechProviderById(providerId).defaultBaseUrl.replace(/\/+$/, '');
}

function speechProviderKey(
  providerId: SpeechProviderId,
  settings = loadSpeechGenerationSettings(),
): string {
  const provider = speechProviderById(providerId);
  const keyProviderId = provider.keyProviderId ?? providerId;
  return (
    settings.providerKeys[keyProviderId]?.trim() ||
    settings.providerKeys[providerId]?.trim() ||
    ''
  );
}

export function speechProviderReady(
  providerId: SpeechProviderId,
  settings = loadSpeechGenerationSettings(),
): boolean {
  const provider = speechProviderById(providerId);
  if (provider.needsKey && !speechProviderKey(providerId, settings)) return false;
  if (provider.needsAccountId && !settings.providerAccountIds[providerId]?.trim()) {
    return false;
  }
  if (provider.local && !settings.providerBaseUrls[providerId]?.trim()) return false;
  return !!speechProviderBaseUrl(providerId, settings);
}

export function configuredSpeechProviderIds(
  settings = loadSpeechGenerationSettings(),
): SpeechProviderId[] {
  return SPEECH_PROVIDERS.filter((provider) => speechProviderReady(provider.id, settings)).map(
    (provider) => provider.id,
  );
}

export function preferredReadySpeechProviderId(
  settings = loadSpeechGenerationSettings(),
): SpeechProviderId | null {
  if (speechProviderReady(settings.preferredProviderId, settings)) {
    return settings.preferredProviderId;
  }
  return configuredSpeechProviderIds(settings)[0] ?? null;
}

export function looksLikeSpeechGenerationRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  if (/^\/(?:tts|speak|speech|say|voice|配音|朗读|语音|念)(?:\s|$)/iu.test(normalized)) return true;
  const zhIntent =
    /(朗读|念|读出|播报|配音|生成|合成|转成?|做成?|说出)[\s\S]{0,18}(语音|配音|音频|声音|旁白|播报|tts)/iu.test(text) ||
    /(语音|配音|音频|声音|旁白|播报|tts)[\s\S]{0,18}(朗读|念|读出|播报|配音|生成|合成|转换)/iu.test(text);
  if (zhIntent) return true;
  return /\b(read|speak|say|narrate|voice|convert|turn|synthesize|generate)\b[\s\S]{0,48}\b(speech|voice|audio|narration|voiceover|tts)\b/i.test(
    normalized,
  );
}

export function stripSpeechCommand(text: string): string {
  return text
    .trim()
    .replace(/^\/(?:tts|speak|speech|say|voice|配音|朗读|语音|念)\s+/iu, '')
    .replace(
      /^请?(?:帮我)?(?:把以下文字|把这段话|把这段文字)?(?:朗读|念|读出|播报|配音|生成|合成|转换成?|转成?|做成?|说出)(?:一段|一个)?(?:语音|配音|音频|声音|旁白|播报)?[:：]?/iu,
      '',
    )
    .trim();
}
// __ENGINE__
export async function generateSpeech(
  request: SpeechGenerationRequest,
  settings = loadSpeechGenerationSettings(),
): Promise<SpeechGenerationResult> {
  if (!settings.enabled) throw new Error('SPEECH_GENERATION_DISABLED');
  const providerId = request.providerId ?? preferredReadySpeechProviderId(settings);
  if (!providerId) throw new Error('NO_READY_SPEECH_PROVIDER');
  if (!speechProviderReady(providerId, settings)) {
    throw new Error(`SPEECH_PROVIDER_NOT_READY:${providerId}`);
  }
  const provider = speechProviderById(providerId);
  const prompt = stripSpeechCommand(request.prompt);
  if (!prompt) throw new Error('EMPTY_SPEECH_PROMPT');
  const model = request.model?.trim() || speechProviderModel(providerId, settings);
  const voice = request.voice?.trim() || speechProviderVoice(providerId, settings);
  const audios = await generateWithProvider(
    providerId,
    prompt,
    model,
    voice,
    settings,
    request.signal,
  );
  return {
    providerId,
    providerLabel: provider.label,
    model,
    voice,
    prompt,
    audios,
  };
}

async function generateWithProvider(
  providerId: SpeechProviderId,
  prompt: string,
  model: string,
  voice: string,
  settings: SpeechGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  switch (speechProviderById(providerId).apiKind) {
    case 'elevenlabs':
      return generateElevenLabs(providerId, prompt, model, voice, settings, signal);
    case 'openai-speech':
      return generateOpenAiSpeech(providerId, prompt, model, voice, settings, signal);
    case 'google-gemini-tts':
      return generateGeminiTts(providerId, prompt, model, voice, settings, signal);
    case 'azure-tts':
      return generateAzureTts(providerId, prompt, voice, settings, signal);
    case 'cartesia':
      return generateCartesia(providerId, prompt, model, voice, settings, signal);
    case 'deepgram-aura':
      return generateDeepgram(providerId, prompt, model, voice, settings, signal);
    case 'minimax-tts':
      return generateMiniMaxTts(providerId, prompt, model, voice, settings, signal);
    case 'dashscope-tts':
      return generateDashScopeTts(providerId, prompt, model, voice, settings, signal);
    case 'replicate':
      return generateReplicateSpeech(providerId, prompt, model, voice, settings, signal);
    case 'fal-ai':
      return generateFalSpeech(providerId, prompt, model, voice, settings, signal);
    case 'huggingface-inference':
      return generateHuggingFaceSpeech(providerId, prompt, model, settings, signal);
    case 'generic-online-speech':
      return generateGenericOnlineSpeech(providerId, prompt, model, voice, settings, signal);
    case 'generic-local-speech':
      return generateGenericLocalSpeech(providerId, prompt, model, voice, settings, signal);
  }
}

async function generateElevenLabs(
  providerId: SpeechProviderId,
  prompt: string,
  model: string,
  voice: string,
  settings: SpeechGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = speechProviderKey(providerId, settings);
  if (!apiKey) throw new Error('ElevenLabs API key is missing.');
  const baseUrl = speechProviderBaseUrl(providerId, settings);
  const response = await fetch(
    `${baseUrl}/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({ text: prompt, model_id: model }),
      signal,
    },
  );
  return audiosFromResponse(response, 'audio/mpeg');
}

async function generateOpenAiSpeech(
  providerId: SpeechProviderId,
  prompt: string,
  model: string,
  voice: string,
  settings: SpeechGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const provider = speechProviderById(providerId);
  const apiKey = speechProviderKey(providerId, settings);
  if (provider.needsKey && !apiKey) throw new Error(`${provider.label} API key is missing.`);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'audio/mpeg, application/json',
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetch(`${speechProviderBaseUrl(providerId, settings)}/audio/speech`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      input: prompt,
      voice,
      response_format: 'mp3',
    }),
    signal,
  });
  return audiosFromResponse(response, 'audio/mpeg');
}

async function generateGeminiTts(
  providerId: SpeechProviderId,
  prompt: string,
  model: string,
  voice: string,
  settings: SpeechGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = speechProviderKey(providerId, settings);
  if (!apiKey) throw new Error('Google API key is missing.');
  const response = await fetch(
    `${speechProviderBaseUrl(providerId, settings)}/models/${encodeURIComponent(
      model,
    )}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
          },
        },
      }),
      signal,
    },
  );
  const json = await readJsonResponse(response);
  const audios = audiosFromJson(json);
  if (audios.length > 0) return audios;
  throw new Error('Gemini returned no audio.');
}
// __ENGINE2__
async function generateAzureTts(
  providerId: SpeechProviderId,
  prompt: string,
  voice: string,
  settings: SpeechGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = speechProviderKey(providerId, settings);
  if (!apiKey) throw new Error('Azure Speech key is missing.');
  const locale = voice.split('-').slice(0, 2).join('-') || 'en-US';
  const ssml =
    `<speak version="1.0" xml:lang="${escapeXml(locale)}">` +
    `<voice name="${escapeXml(voice)}">${escapeXml(prompt)}</voice></speak>`;
  const response = await fetch(
    `${speechProviderBaseUrl(providerId, settings)}/cognitiveservices/v1`,
    {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': apiKey,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-96kbitrate-mono-mp3',
      },
      body: ssml,
      signal,
    },
  );
  return audiosFromResponse(response, 'audio/mpeg');
}

async function generateCartesia(
  providerId: SpeechProviderId,
  prompt: string,
  model: string,
  voice: string,
  settings: SpeechGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = speechProviderKey(providerId, settings);
  if (!apiKey) throw new Error('Cartesia API key is missing.');
  const response = await fetch(`${speechProviderBaseUrl(providerId, settings)}/tts/bytes`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Cartesia-Version': '2024-11-13',
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg, application/json',
    },
    body: JSON.stringify({
      model_id: model,
      transcript: prompt,
      voice: { mode: 'id', id: voice },
      output_format: { container: 'mp3', sample_rate: 44100, bit_rate: 128000 },
      language: 'en',
    }),
    signal,
  });
  return audiosFromResponse(response, 'audio/mpeg');
}

async function generateDeepgram(
  providerId: SpeechProviderId,
  prompt: string,
  model: string,
  voice: string,
  settings: SpeechGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = speechProviderKey(providerId, settings);
  if (!apiKey) throw new Error('Deepgram API key is missing.');
  const url = new URL(`${speechProviderBaseUrl(providerId, settings)}/speak`);
  url.searchParams.set('model', voice.trim() || model);
  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg, application/json',
    },
    body: JSON.stringify({ text: prompt }),
    signal,
  });
  return audiosFromResponse(response, 'audio/mpeg');
}

async function generateMiniMaxTts(
  providerId: SpeechProviderId,
  prompt: string,
  model: string,
  voice: string,
  settings: SpeechGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = speechProviderKey(providerId, settings);
  if (!apiKey) throw new Error('MiniMax API key is missing.');
  const groupId = settings.providerAccountIds[providerId]?.trim();
  if (!groupId) throw new Error('MiniMax GroupId is missing.');
  const url = new URL(`${speechProviderBaseUrl(providerId, settings)}/t2a_v2`);
  url.searchParams.set('GroupId', groupId);
  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      text: prompt,
      stream: false,
      voice_setting: { voice_id: voice, speed: 1, vol: 1, pitch: 0 },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3' },
    }),
    signal,
  });
  const json = await readJsonResponse(response);
  assertMiniMaxOk(json);
  const data = objectValue(json.data);
  const hexAudio = stringValue(data?.audio);
  if (hexAudio) return [hexAudioToDataUrl(hexAudio, 'audio/mpeg')];
  const audios = audiosFromJson(json);
  if (audios.length > 0) return audios;
  throw new Error('MiniMax returned no audio.');
}

async function generateDashScopeTts(
  providerId: SpeechProviderId,
  prompt: string,
  model: string,
  voice: string,
  settings: SpeechGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = speechProviderKey(providerId, settings);
  if (!apiKey) throw new Error('DashScope API key is missing.');
  const response = await fetch(
    `${speechProviderBaseUrl(providerId, settings)}/services/aigc/multimodal-generation/generation`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: { text: prompt, voice },
        parameters: { text_type: 'PlainText' },
      }),
      signal,
    },
  );
  const json = await readJsonResponse(response);
  const audios = audiosFromJson(json);
  if (audios.length > 0) return audios;
  throw new Error('DashScope returned no audio.');
}
// __ENGINE3__
async function generateReplicateSpeech(
  providerId: SpeechProviderId,
  prompt: string,
  model: string,
  voice: string,
  settings: SpeechGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = speechProviderKey(providerId, settings);
  if (!apiKey) throw new Error('Replicate API token is missing.');
  const baseUrl = speechProviderBaseUrl(providerId, settings);
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
      input: speechRequestBody(prompt, voice),
    }),
    signal,
  });
  const started = await readJsonResponse(response);
  const immediate = audiosFromJson(started);
  if (immediate.length > 0 && isTerminalSuccess(started)) return immediate;
  const statusUrl =
    stringValue(objectValue(started.urls)?.get) ||
    (stringValue(started.id)
      ? `${baseUrl}/predictions/${encodeURIComponent(stringValue(started.id))}`
      : '');
  if (!statusUrl) {
    if (immediate.length > 0) return immediate;
    throw new Error('Replicate did not return a prediction URL.');
  }
  return pollAudios(() => fetch(statusUrl, { headers, signal }), 'Replicate', signal);
}

async function generateFalSpeech(
  providerId: SpeechProviderId,
  prompt: string,
  model: string,
  voice: string,
  settings: SpeechGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = speechProviderKey(providerId, settings);
  if (!apiKey) throw new Error('fal API key is missing.');
  const modelPath = model.replace(/^\/+/, '');
  const baseUrl = speechProviderBaseUrl(providerId, settings);
  const headers = {
    Authorization: `Key ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const response = await fetch(`${baseUrl}/${modelPath}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(speechRequestBody(prompt, voice)),
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
    await delay(2000, signal);
    const statusResponse = await fetch(statusUrl, { headers, signal });
    const status = await readJsonResponse(statusResponse);
    const statusAudios = audiosFromJson(status);
    if (statusAudios.length > 0 && isTerminalSuccess(status)) return statusAudios;
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

async function generateHuggingFaceSpeech(
  providerId: SpeechProviderId,
  prompt: string,
  model: string,
  settings: SpeechGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = speechProviderKey(providerId, settings);
  if (!apiKey) throw new Error('Hugging Face token is missing.');
  const modelPath = encodeModelPath(model);
  const response = await fetch(`${speechProviderBaseUrl(providerId, settings)}/${modelPath}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'audio/mpeg, audio/wav, audio/*, application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      inputs: prompt,
      options: { wait_for_model: true },
    }),
    signal,
  });
  return audiosFromResponse(response, 'audio/mpeg');
}

async function generateGenericOnlineSpeech(
  providerId: SpeechProviderId,
  prompt: string,
  model: string,
  voice: string,
  settings: SpeechGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const provider = speechProviderById(providerId);
  const apiKey = speechProviderKey(providerId, settings);
  if (provider.needsKey && !apiKey) throw new Error(`${provider.label} API key is missing.`);
  const headers: Record<string, string> = {
    Accept: 'audio/mpeg, audio/wav, audio/*, application/json',
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers.Authorization = apiKey.toLowerCase().startsWith('bearer ') ? apiKey : `Bearer ${apiKey}`;
  }
  const accountId = settings.providerAccountIds[providerId]?.trim();
  if (accountId) {
    headers['X-User-Id'] = accountId;
    headers['X-App-Id'] = accountId;
  }
  const started = await readResponseJsonOrAudios(
    await fetch(speechProviderBaseUrl(providerId, settings), {
      method: 'POST',
      headers,
      body: JSON.stringify(speechRequestBody(prompt, voice, model)),
      signal,
    }),
    provider.label,
  );
  const immediate = audiosFromJson(started);
  if (immediate.length > 0 && isTerminalSuccess(started)) return immediate;
  const statusUrl = statusUrlFromUnknown(started);
  const taskId = taskIdFromJson(started);
  if (!statusUrl && !taskId) {
    if (immediate.length > 0) return immediate;
    throw new Error(`${provider.label} returned no audio.`);
  }
  const done = await pollJson(
    () =>
      fetch(
        statusUrl ||
          `${speechProviderBaseUrl(providerId, settings)}/${encodeURIComponent(taskId ?? '')}`,
        { headers, signal },
      ),
    provider.label,
    signal,
  );
  const audios = audiosFromJson(done);
  if (audios.length > 0) return audios;
  throw new Error(`${provider.label} returned no audio.`);
}

async function generateGenericLocalSpeech(
  providerId: SpeechProviderId,
  prompt: string,
  model: string,
  voice: string,
  settings: SpeechGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const provider = speechProviderById(providerId);
  const started = await readResponseJsonOrAudios(
    await fetch(speechProviderBaseUrl(providerId, settings), {
      method: 'POST',
      headers: {
        Accept: 'audio/mpeg, audio/wav, audio/*, application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(speechRequestBody(prompt, voice, model)),
      signal,
    }),
    provider.label,
  );
  const immediate = audiosFromJson(started);
  if (immediate.length > 0 && isTerminalSuccess(started)) return immediate;
  const statusUrl = statusUrlFromUnknown(started);
  const taskId = taskIdFromJson(started);
  if (!statusUrl && !taskId) {
    if (immediate.length > 0) return immediate;
    throw new Error(`${provider.label} returned no audio.`);
  }
  const done = await pollJson(
    () =>
      fetch(
        statusUrl ||
          `${speechProviderBaseUrl(providerId, settings)}/${encodeURIComponent(taskId ?? '')}`,
        { signal },
      ),
    provider.label,
    signal,
  );
  const audios = audiosFromJson(done);
  if (audios.length > 0) return audios;
  throw new Error(`${provider.label} returned no audio.`);
}
// __HELPERS__
function speechRequestBody(
  prompt: string,
  voice: string,
  model?: string,
): Record<string, unknown> {
  return {
    text: prompt,
    input: prompt,
    transcript: prompt,
    prompt,
    voice,
    voice_id: voice,
    speaker: voice,
    ...(model ? { model, model_id: model } : {}),
    output_format: 'mp3',
    response_format: 'mp3',
    format: 'mp3',
  };
}

async function audiosFromResponse(
  response: Response,
  fallbackMime: string,
): Promise<string[]> {
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `${response.status} ${response.statusText}${body ? `: ${body.slice(0, 240)}` : ''}`,
    );
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (isAudioMime(contentType)) {
    const bytes = arrayBufferToBase64(await response.arrayBuffer());
    return [audioDataUrl(bytes, contentType.split(';')[0] || fallbackMime)];
  }
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (json && typeof json === 'object') {
    const audios = audiosFromJson(json as Record<string, unknown>);
    if (audios.length > 0) return audios;
    throw new Error(
      providerErrorMessage(json as Record<string, unknown>) || 'Provider returned no audio.',
    );
  }
  throw new Error('Provider returned a non-audio response without an audio payload.');
}

async function readResponseJsonOrAudios(
  response: Response,
  providerLabel: string,
): Promise<Record<string, unknown>> {
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `${providerLabel} ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 240)}` : ''}`,
    );
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (isAudioMime(contentType)) {
    const bytes = arrayBufferToBase64(await response.arrayBuffer());
    return {
      audio_url: audioDataUrl(bytes, contentType.split(';')[0] || 'audio/mpeg'),
      status: 'succeeded',
    };
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
    throw new Error(
      `${response.status} ${response.statusText}${body ? `: ${body.slice(0, 240)}` : ''}`,
    );
  }
  const json = await response.json().catch(() => null);
  if (!json || typeof json !== 'object') throw new Error('Provider returned a non-JSON response.');
  return json as Record<string, unknown>;
}

async function pollAudios(
  request: () => Promise<Response>,
  providerLabel: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const done = await pollJson(request, providerLabel, signal);
  const audios = audiosFromJson(done);
  if (audios.length > 0) return audios;
  throw new Error(`${providerLabel} returned no audio.`);
}

async function pollJson(
  request: () => Promise<Response>,
  providerLabel: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  for (let i = 0; i < 90; i += 1) {
    await delay(2000, signal);
    const response = await request();
    const json = await readJsonResponse(response);
    const state = jsonState(json);
    if (isFailedState(state)) {
      throw new Error(providerErrorMessage(json) || `${providerLabel} generation failed.`);
    }
    const audios = audiosFromJson(json);
    if (audios.length > 0 && isSuccessState(state, json)) return json;
    if (audios.length > 0 && state === '') return json;
  }
  throw new Error(`${providerLabel} job timed out before audio was ready.`);
}
// __HELPERS2__
function audiosFromJson(json: Record<string, unknown>): string[] {
  const audios: string[] = [];
  const push = (src: string) => {
    if (!src || audios.includes(src)) return;
    audios.push(src);
  };
  for (const src of audiosFromUnknown(json)) push(src);
  return audios;
}

function audiosFromUnknown(value: unknown, keyHint = ''): string[] {
  if (!value) return [];
  if (typeof value === 'string') {
    const normalized = normalizeAudioSource(value);
    if (normalized) return [normalized];
    if (looksLikeBase64Audio(value) || audioishKey(keyHint)) {
      return [audioDataUrl(value, 'audio/mpeg')];
    }
    return [];
  }
  if (Array.isArray(value)) return value.flatMap((item) => audiosFromUnknown(item, keyHint));
  if (typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const audios: string[] = [];
  const push = (src: string) => {
    if (!src || audios.includes(src)) return;
    audios.push(src);
  };
  for (const key of [
    'audio',
    'audio_url',
    'audioUrl',
    'url',
    'uri',
    'audio_file',
    'audioFile',
    'file_url',
    'fileUrl',
    'media_url',
    'mediaUrl',
    'output_url',
    'outputUrl',
    'result_url',
    'resultUrl',
    'download_url',
    'downloadUrl',
    'speech_url',
    'speechUrl',
  ]) {
    const str = stringValue(record[key]);
    if (str) push(normalizeAudioSource(str) || (audioishKey(key) ? audioDataUrl(str, 'audio/mpeg') : ''));
  }
  for (const key of [
    'audio_base64',
    'audioBase64',
    'audio_content',
    'audioContent',
    'audio_data',
    'audioData',
    'base64',
    'b64',
    'b64_json',
    'data',
    'content',
    'bytesBase64Encoded',
  ]) {
    const str = stringValue(record[key]);
    if (str && (looksLikeBase64Audio(str) || audioishKey(key))) {
      push(audioDataUrl(str, mimeFromJson(record) || 'audio/mpeg'));
    }
  }
  const inlineData = objectValue(record.inlineData) ?? objectValue(record.inline_data);
  if (inlineData) {
    const data = stringValue(inlineData.data);
    const mimeType = stringValue(inlineData.mimeType) || stringValue(inlineData.mime_type);
    if (data) push(audioDataUrl(data, isAudioMime(mimeType) ? mimeType : 'audio/mpeg'));
  }
  for (const key of [
    'audio',
    'audios',
    'output',
    'outputs',
    'result',
    'results',
    'data',
    'assets',
    'artifacts',
    'generations',
    'predictions',
    'response',
    'audio_files',
    'audioFiles',
    'choices',
    'candidates',
    'parts',
  ]) {
    for (const src of audiosFromUnknown(record[key], key)) push(src);
  }
  const message = objectValue(record.content);
  if (message) {
    for (const src of audiosFromUnknown(message.parts, 'parts')) push(src);
  }
  return audios;
}

function normalizeAudioSource(value: string): string {
  const src = value.trim();
  if (!src) return '';
  if (/^data:audio\//i.test(src)) return src;
  if (/^https?:\/\//i.test(src) || /^file:\/\//i.test(src)) return src;
  if (/\.(?:mp3|wav|ogg|opus|flac|m4a|aac|webm|pcm)(?:[?#].*)?$/i.test(src)) return src;
  return '';
}

function isAudioMime(value: string): boolean {
  return /^audio\//i.test(value.split(';')[0]?.trim() ?? '');
}

function mimeFromJson(json: Record<string, unknown>): string {
  const mime =
    stringValue(json.mime_type) ||
    stringValue(json.mimeType) ||
    stringValue(json.content_type) ||
    stringValue(json.contentType);
  return isAudioMime(mime) ? mime : '';
}

function audioDataUrl(base64: string, mimeType: string): string {
  const clean = base64.trim().replace(/^data:audio\/[^;]+;base64,/i, '');
  return `data:${isAudioMime(mimeType) ? mimeType : 'audio/mpeg'};base64,${clean}`;
}

function looksLikeBase64Audio(value: string): boolean {
  const trimmed = value.trim();
  if (/^data:audio\//i.test(trimmed)) return true;
  return /^[A-Za-z0-9+/]+={0,2}$/u.test(trimmed) && trimmed.length > 80;
}

function audioishKey(key: string): boolean {
  return /audio|speech|voice|mp3|wav|ogg|opus|flac|pcm|bytes|base64/i.test(key);
}

function hexAudioToDataUrl(hex: string, mimeType: string): string {
  const clean = hex.trim().replace(/[^0-9a-fA-F]/g, '');
  let binary = '';
  for (let i = 0; i + 1 < clean.length; i += 2) {
    binary += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function taskIdFromJson(json: Record<string, unknown>): string {
  return (
    stringValue(json.id) ||
    stringValue(json.task_id) ||
    stringValue(json.taskId) ||
    stringValue(json.request_id) ||
    stringValue(json.requestId) ||
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
  return ['failed', 'failure', 'error', 'errored', 'canceled', 'cancelled', 'rejected', 'blocked'].includes(
    state.toLowerCase(),
  );
}

function isSuccessState(state: string, json: Record<string, unknown>): boolean {
  const normalized = state.toLowerCase();
  return (
    json.done === true ||
    json.completed === true ||
    ['succeeded', 'success', 'completed', 'complete', 'done', 'ready', 'finished'].includes(
      normalized,
    )
  );
}

function isTerminalSuccess(json: Record<string, unknown>): boolean {
  return isSuccessState(jsonState(json), json);
}

function assertMiniMaxOk(json: Record<string, unknown>): void {
  const base = objectValue(json.base_resp);
  const code = base ? base.status_code : json.code;
  if (typeof code === 'number' && code !== 0 && code !== 200) {
    throw new Error(providerErrorMessage(json) || 'MiniMax generation failed.');
  }
}

function providerErrorMessage(json: Record<string, unknown>): string {
  return (
    stringValue(json.error) ||
    stringValue(json.message) ||
    stringValue(json.msg) ||
    stringValue(json.detail) ||
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

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
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