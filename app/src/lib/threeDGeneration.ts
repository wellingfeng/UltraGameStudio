export type ThreeDProviderId =
  | 'meshy'
  | 'tripo'
  | 'hyper3d-rodin'
  | 'sloyd'
  | 'csm-cube'
  | 'kaedim'
  | 'scenario-3d'
  | '3d-ai-studio-hunyuan'
  | '3d-ai-studio-tripo'
  | 'fal-tripo-h31'
  | 'fal-hyper3d-rodin'
  | 'fal-meshy-v6'
  | 'replicate-hyper3d-rodin'
  | 'huggingface-hunyuan3d'
  | 'huggingface-trellis'
  | 'huggingface-stable-fast-3d'
  | 'local-comfyui-3d'
  | 'local-hunyuan3d'
  | 'local-trellis'
  | 'local-trellis2'
  | 'local-stable-fast-3d'
  | 'local-shap-e'
  | 'local-openlrm'
  | 'local-3d-server'
  | 'roblox-cube';

export type ThreeDProviderCategory = 'commercial' | 'free';
export type ThreeDRiggingTarget = 'riggable' | 'static';
export type ThreeDRiggingProviderId =
  | 'fal-meshy-rigging'
  | 'meshy-rigging-api'
  | 'anything-world'
  | 'autorig-online'
  | 'local-rigging-server'
  | 'blender-rigify'
  | 'blender-auto-rig-pro'
  | 'accurig'
  | 'mixamo-manual-import';
export type ThreeDRiggingProviderCategory = 'online' | 'local' | 'manual';

type ThreeDProviderApiKind =
  | 'meshy'
  | 'tripo'
  | '3d-ai-studio'
  | 'fal-3d'
  | 'replicate'
  | 'huggingface-inference'
  | 'generic-3d-api'
  | 'generic-local-3d';

type ThreeDRiggingProviderApiKind =
  | 'fal-meshy-rigging'
  | 'meshy-rigging-api'
  | 'generic-rigging-api'
  | 'generic-local-rigging'
  | 'external-tool'
  | 'manual-import';

export interface ThreeDProviderDefinition {
  id: ThreeDProviderId;
  label: string;
  category: ThreeDProviderCategory;
  apiKind: ThreeDProviderApiKind;
  defaultModel: string;
  models: string[];
  needsKey: boolean;
  local: boolean;
  defaultBaseUrl: string;
  supportsBaseUrl: boolean;
  endpointPlaceholder: string;
  keyProviderId?: ThreeDProviderId;
  credentialUrl?: string;
  keyLabel?: string;
  keyPlaceholder?: string;
  note: string;
}

export interface ThreeDGenerationSettings {
  enabled: boolean;
  preferredProviderId: ThreeDProviderId;
  providerKeys: Partial<Record<ThreeDProviderId, string>>;
  providerBaseUrls: Partial<Record<ThreeDProviderId, string>>;
  providerModels: Partial<Record<ThreeDProviderId, string>>;
  rigging: ThreeDAutoRiggingSettings;
}

export interface ThreeDGenerationResult {
  providerId: ThreeDProviderId;
  providerLabel: string;
  model: string;
  prompt: string;
  rigging: ThreeDRiggingAssessment;
  sourceAssets: string[];
  autoRigging: ThreeDAutoRiggingResult | null;
  assets: string[];
}

export interface ThreeDGenerationRequest {
  prompt: string;
  providerId?: ThreeDProviderId;
  model?: string;
  signal?: AbortSignal;
}

export interface ThreeDRiggingAssessment {
  target: ThreeDRiggingTarget;
  enabled: boolean;
  reason: string;
  defaultAnimations: string[];
  requestedAnimations: string[];
  needsAnimationSearch: boolean;
}

export interface ThreeDAutoRiggingResult {
  providerId: ThreeDRiggingProviderId;
  providerLabel: string;
  status: 'succeeded' | 'skipped' | 'failed';
  sourceAsset?: string;
  assets: string[];
  reason?: string;
  error?: string;
}

export interface ThreeDAutoRiggingSettings {
  enabled: boolean;
  preferredProviderId: ThreeDRiggingProviderId;
  fallbackProviderIds: ThreeDRiggingProviderId[];
  providerKeys: Partial<Record<ThreeDRiggingProviderId, string>>;
  providerBaseUrls: Partial<Record<ThreeDRiggingProviderId, string>>;
  providerCommands: Partial<Record<ThreeDRiggingProviderId, string>>;
  providerModels: Partial<Record<ThreeDRiggingProviderId, string>>;
}

const STORAGE_KEY = 'freeultracode.threeDGeneration.v1';

export type ThreeDCommonAnimationId =
  | 'idle'
  | 'walk'
  | 'run'
  | 'jump'
  | 'wave'
  | 'attack'
  | 'punch'
  | 'kick'
  | 'dance'
  | 'sit'
  | 'fall'
  | 'death';

export interface ThreeDCommonAnimation {
  id: ThreeDCommonAnimationId;
  label: string;
  aliases: string[];
  defaultPreview: boolean;
}

export interface ThreeDAnimationLibraryLink {
  id: string;
  label: string;
  url: string;
  use: 'default-local' | 'online-api' | 'manual-import' | 'commercial-library';
  targets: string[];
}

export interface ThreeDRiggingLibraryLink {
  id: string;
  label: string;
  url: string;
  use: 'online-api' | 'manual-import' | 'desktop-tool' | 'blender-addon';
  targets: string[];
}

export interface ThreeDRiggingProviderDefinition {
  id: ThreeDRiggingProviderId;
  label: string;
  category: ThreeDRiggingProviderCategory;
  apiKind: ThreeDRiggingProviderApiKind;
  needsKey: boolean;
  local: boolean;
  supportsBaseUrl: boolean;
  supportsCommand: boolean;
  defaultBaseUrl: string;
  endpointPlaceholder: string;
  commandPlaceholder: string;
  defaultModel: string;
  models: string[];
  supportedFormats: string[];
  targets: string[];
  credentialUrl?: string;
  keyLabel?: string;
  keyPlaceholder?: string;
  fallbackThreeDKeyProviderId?: ThreeDProviderId;
  note: string;
}

export const DEFAULT_THREE_D_PREVIEW_ANIMATIONS = ['Idle', 'Walk', 'Run'] as const;

export const COMMON_THREE_D_ANIMATIONS: ThreeDCommonAnimation[] = [
  {
    id: 'idle',
    label: 'Idle',
    aliases: ['idle', 'stand', 'standing', 'breathing', '待机', '站立', '呼吸'],
    defaultPreview: true,
  },
  {
    id: 'walk',
    label: 'Walk',
    aliases: ['walk', 'walking', 'stroll', '走路', '行走', '步行', '走'],
    defaultPreview: true,
  },
  {
    id: 'run',
    label: 'Run',
    aliases: ['run', 'running', 'sprint', 'jog', '跑步', '奔跑', '冲刺', '跑'],
    defaultPreview: true,
  },
  {
    id: 'jump',
    label: 'Jump',
    aliases: ['jump', 'jumping', 'leap', '跳跃', '跳起'],
    defaultPreview: false,
  },
  {
    id: 'wave',
    label: 'Wave',
    aliases: ['wave', 'waving', 'hello', '挥手', '招手', '打招呼'],
    defaultPreview: false,
  },
  {
    id: 'attack',
    label: 'Attack',
    aliases: ['attack', 'slash', 'strike', '攻击', '挥剑', '劈砍'],
    defaultPreview: false,
  },
  {
    id: 'punch',
    label: 'Punch',
    aliases: ['punch', 'boxing', 'jab', '挥拳', '出拳', '拳击'],
    defaultPreview: false,
  },
  {
    id: 'kick',
    label: 'Kick',
    aliases: ['kick', 'kicking', '踢腿', '踢击', '踢'],
    defaultPreview: false,
  },
  {
    id: 'dance',
    label: 'Dance',
    aliases: ['dance', 'dancing', '跳舞', '舞蹈'],
    defaultPreview: false,
  },
  {
    id: 'sit',
    label: 'Sit',
    aliases: ['sit', 'sitting', '坐下', '坐姿', '坐'],
    defaultPreview: false,
  },
  {
    id: 'fall',
    label: 'Fall',
    aliases: ['fall', 'falling', 'trip', '摔倒', '跌倒', '倒下'],
    defaultPreview: false,
  },
  {
    id: 'death',
    label: 'Death',
    aliases: ['death', 'dead', 'die', 'dying', '死亡', '阵亡', '倒地'],
    defaultPreview: false,
  },
];

export const THREE_D_ANIMATION_LIBRARY_LINKS: ThreeDAnimationLibraryLink[] = [
  {
    id: 'quaternius-universal-animation-library',
    label: 'Quaternius Universal Animation Library',
    url: 'https://quaternius.itch.io/universal-animation-library',
    use: 'default-local',
    targets: ['humanoid', 'mixamo-compatible'],
  },
  {
    id: 'mesh2motion',
    label: 'Mesh2Motion',
    url: 'https://mesh2motion.org/',
    use: 'default-local',
    targets: ['humanoid', 'quadruped', 'bird', 'dragon', 'monster'],
  },
  {
    id: 'meshy-animation-api',
    label: 'Meshy Animation API',
    url: 'https://docs.meshy.ai/en/api/animation',
    use: 'online-api',
    targets: ['rigged-humanoid'],
  },
  {
    id: 'meshy-animation-library',
    label: 'Meshy Animation Library Reference',
    url: 'https://docs.meshy.ai/api/animation-library',
    use: 'online-api',
    targets: ['rigged-humanoid'],
  },
  {
    id: 'fal-meshy-rigging',
    label: 'fal.ai Meshy Rigging',
    url: 'https://fal.ai/models/fal-ai/meshy/rigging/api',
    use: 'online-api',
    targets: ['humanoid'],
  },
  {
    id: 'mixamo',
    label: 'Mixamo',
    url: 'https://www.mixamo.com/',
    use: 'manual-import',
    targets: ['humanoid'],
  },
  {
    id: 'actorcore',
    label: 'ActorCore',
    url: 'https://actorcore.reallusion.com/3d-motion',
    use: 'commercial-library',
    targets: ['humanoid'],
  },
  {
    id: 'rokoko-motion-library',
    label: 'Rokoko Motion Library',
    url: 'https://www.rokoko.com/products/motion-library',
    use: 'commercial-library',
    targets: ['humanoid'],
  },
  {
    id: 'mocap-online',
    label: 'MoCap Online',
    url: 'https://mocaponline.com/',
    use: 'commercial-library',
    targets: ['humanoid'],
  },
];

export const THREE_D_RIGGING_LIBRARY_LINKS: ThreeDRiggingLibraryLink[] = [
  {
    id: 'meshy-rigging-api',
    label: 'Meshy Rigging API',
    url: 'https://docs.meshy.ai/en/api/rigging',
    use: 'online-api',
    targets: ['humanoid'],
  },
  {
    id: 'fal-meshy-rigging',
    label: 'fal.ai Meshy Rigging',
    url: 'https://fal.ai/models/fal-ai/meshy/rigging/api',
    use: 'online-api',
    targets: ['humanoid'],
  },
  {
    id: 'mixamo',
    label: 'Mixamo',
    url: 'https://www.mixamo.com/',
    use: 'manual-import',
    targets: ['humanoid'],
  },
  {
    id: 'anything-world',
    label: 'Anything World API',
    url: 'https://everythinguniver.se/anything-world-apis',
    use: 'online-api',
    targets: ['humanoid', 'animal', 'creature'],
  },
  {
    id: 'autorig-online',
    label: 'AutoRig.online',
    url: 'https://autorig.online/',
    use: 'online-api',
    targets: ['humanoid', 'animal', 'non-humanoid'],
  },
  {
    id: 'accurig',
    label: 'AccuRIG',
    url: 'https://www.reallusion.com/accurig/',
    use: 'desktop-tool',
    targets: ['humanoid'],
  },
  {
    id: 'blender-rigify',
    label: 'Blender Rigify',
    url: 'https://docs.blender.org/manual/en/latest/addons/rigging/rigify.html',
    use: 'blender-addon',
    targets: ['humanoid', 'creature-with-template'],
  },
  {
    id: 'auto-rig-pro',
    label: 'Auto-Rig Pro',
    url: 'https://www.lucky3d.fr/auto-rig-pro/',
    use: 'blender-addon',
    targets: ['humanoid', 'quadruped'],
  },
];

export const THREE_D_RIGGING_PROVIDERS: ThreeDRiggingProviderDefinition[] = [
  {
    id: 'fal-meshy-rigging',
    label: 'fal.ai Meshy Rigging',
    category: 'online',
    apiKind: 'fal-meshy-rigging',
    needsKey: true,
    local: false,
    supportsBaseUrl: true,
    supportsCommand: false,
    defaultBaseUrl: 'https://queue.fal.run',
    endpointPlaceholder: 'https://queue.fal.run',
    commandPlaceholder: '',
    defaultModel: 'fal-ai/meshy/rigging',
    models: ['fal-ai/meshy/rigging'],
    supportedFormats: ['glb'],
    targets: ['humanoid'],
    credentialUrl: 'https://fal.ai/models/fal-ai/meshy/rigging/api',
    keyLabel: 'fal API Key',
    keyPlaceholder: 'fal-...',
    fallbackThreeDKeyProviderId: 'fal-meshy-v6',
    note: '在线自动绑骨。输入公开 GLB URL，适合标准人形；成功后返回 rigged GLB/FBX 和基础动画。',
  },
  {
    id: 'meshy-rigging-api',
    label: 'Meshy Rigging API',
    category: 'online',
    apiKind: 'meshy-rigging-api',
    needsKey: true,
    local: false,
    supportsBaseUrl: true,
    supportsCommand: false,
    defaultBaseUrl: 'https://api.meshy.ai',
    endpointPlaceholder: 'https://api.meshy.ai',
    commandPlaceholder: '',
    defaultModel: 'meshy-rigging',
    models: ['meshy-rigging'],
    supportedFormats: ['glb', 'fbx'],
    targets: ['humanoid'],
    credentialUrl: 'https://docs.meshy.ai/en/api/rigging',
    keyLabel: 'Meshy API Key',
    keyPlaceholder: 'msy-...',
    fallbackThreeDKeyProviderId: 'meshy',
    note: 'Meshy 官方 Rigging API。适合标准双足人形；作为 fal 后备或直接接 Meshy 账号。',
  },
  {
    id: 'anything-world',
    label: 'Anything World API',
    category: 'online',
    apiKind: 'generic-rigging-api',
    needsKey: true,
    local: false,
    supportsBaseUrl: true,
    supportsCommand: false,
    defaultBaseUrl: '',
    endpointPlaceholder: '粘贴 Anything World rig/animate API endpoint',
    commandPlaceholder: '',
    defaultModel: 'auto',
    models: ['auto', 'humanoid', 'animal', 'creature'],
    supportedFormats: ['glb', 'gltf', 'fbx', 'obj'],
    targets: ['humanoid', 'animal', 'creature'],
    credentialUrl: 'https://everythinguniver.se/anything-world-apis',
    keyLabel: 'Anything World API Key',
    keyPlaceholder: '粘贴 API Key',
    note: '在线 rig/animate 候选。覆盖动物和 creature 更好；endpoint 需按账号文档填写。',
  },
  {
    id: 'autorig-online',
    label: 'AutoRig.online API',
    category: 'online',
    apiKind: 'generic-rigging-api',
    needsKey: true,
    local: false,
    supportsBaseUrl: true,
    supportsCommand: false,
    defaultBaseUrl: '',
    endpointPlaceholder: '粘贴 AutoRig.online API endpoint',
    commandPlaceholder: '',
    defaultModel: 'auto',
    models: ['auto', 'humanoid', 'animal', 'non-humanoid'],
    supportedFormats: ['glb', 'gltf', 'fbx', 'obj'],
    targets: ['humanoid', 'animal', 'non-humanoid'],
    credentialUrl: 'https://autorig.online/',
    keyLabel: 'AutoRig.online API Key',
    keyPlaceholder: '粘贴 API Key',
    note: '在线自动绑骨候选。适合评估非标准模型；需要自行配置官方提供的 API endpoint。',
  },
  {
    id: 'local-rigging-server',
    label: '本地 Rigging Server',
    category: 'local',
    apiKind: 'generic-local-rigging',
    needsKey: false,
    local: true,
    supportsBaseUrl: true,
    supportsCommand: false,
    defaultBaseUrl: '',
    endpointPlaceholder: 'http://127.0.0.1:8091/rig',
    commandPlaceholder: '',
    defaultModel: 'auto',
    models: ['auto', 'rigify', 'auto-rig-pro', 'custom'],
    supportedFormats: ['glb', 'gltf', 'fbx', 'obj'],
    targets: ['humanoid', 'animal', 'creature', 'custom'],
    note: '本地 HTTP 服务入口。你自行安装 Blender/脚本/研究模型；应用只 POST 模型地址和动画需求。',
  },
  {
    id: 'blender-rigify',
    label: 'Blender Rigify',
    category: 'local',
    apiKind: 'external-tool',
    needsKey: false,
    local: true,
    supportsBaseUrl: false,
    supportsCommand: true,
    defaultBaseUrl: '',
    endpointPlaceholder: '',
    commandPlaceholder: 'blender --background --python rigify_pipeline.py',
    defaultModel: 'rigify',
    models: ['rigify'],
    supportedFormats: ['blend', 'fbx', 'glb'],
    targets: ['humanoid', 'template-creature'],
    credentialUrl: 'https://docs.blender.org/manual/en/latest/addons/rigging/rigify.html',
    note: 'Blender 内置插件。只记录外部命令；不随应用打包 Blender 或模板脚本。',
  },
  {
    id: 'blender-auto-rig-pro',
    label: 'Blender Auto-Rig Pro',
    category: 'local',
    apiKind: 'external-tool',
    needsKey: false,
    local: true,
    supportsBaseUrl: false,
    supportsCommand: true,
    defaultBaseUrl: '',
    endpointPlaceholder: '',
    commandPlaceholder: 'blender --background --python auto_rig_pro_pipeline.py',
    defaultModel: 'auto-rig-pro',
    models: ['auto-rig-pro'],
    supportedFormats: ['blend', 'fbx', 'glb'],
    targets: ['humanoid', 'quadruped'],
    credentialUrl: 'https://www.lucky3d.fr/auto-rig-pro/',
    note: '第三方 Blender 插件。只存命令/路径；用户自行安装授权和脚本。',
  },
  {
    id: 'accurig',
    label: 'AccuRIG',
    category: 'local',
    apiKind: 'manual-import',
    needsKey: false,
    local: true,
    supportsBaseUrl: false,
    supportsCommand: true,
    defaultBaseUrl: '',
    endpointPlaceholder: '',
    commandPlaceholder: 'AccuRIG 可执行文件路径或说明',
    defaultModel: 'accurig',
    models: ['accurig'],
    supportedFormats: ['fbx', 'glb'],
    targets: ['humanoid'],
    credentialUrl: 'https://www.reallusion.com/auto-rig/accurig/',
    note: '桌面工具。适合人工校正/离线导入；应用不自动打包或调用。',
  },
  {
    id: 'mixamo-manual-import',
    label: 'Mixamo 手动导入',
    category: 'manual',
    apiKind: 'manual-import',
    needsKey: false,
    local: false,
    supportsBaseUrl: false,
    supportsCommand: false,
    defaultBaseUrl: '',
    endpointPlaceholder: '',
    commandPlaceholder: '',
    defaultModel: 'mixamo',
    models: ['mixamo'],
    supportedFormats: ['fbx'],
    targets: ['humanoid'],
    credentialUrl: 'https://www.mixamo.com/',
    note: '无稳定公开 API。只作为手动上传、下载、导入缓存路线。',
  },
];

const THREE_D_RIGGING_PROVIDER_BY_ID = new Map<
  ThreeDRiggingProviderId,
  ThreeDRiggingProviderDefinition
>(THREE_D_RIGGING_PROVIDERS.map((provider) => [provider.id, provider]));

export const DEFAULT_THREE_D_AUTO_RIGGING_SETTINGS: ThreeDAutoRiggingSettings = {
  enabled: false,
  preferredProviderId: 'fal-meshy-rigging',
  fallbackProviderIds: ['meshy-rigging-api', 'local-rigging-server'],
  providerKeys: {},
  providerBaseUrls: {},
  providerCommands: {},
  providerModels: {},
};

const DEFAULT_RIGGING_ANIMATIONS: string[] = [...DEFAULT_THREE_D_PREVIEW_ANIMATIONS];
const FAL_MESHY_RIGGING_MODEL = 'fal-ai/meshy/rigging';

const EXPLICIT_NO_RIGGING_RE =
  /\b(?:no|without|disable|skip|unrigged)\s+(?:rig|rigging|skeleton|bones?|armature|animation|animations?)\b|(?:不要|无需|不用|跳过|禁用)(?:骨骼|绑骨|绑定|蒙皮|动画)|(?:无|没有)(?:骨骼|动画)/iu;

const EXPLICIT_RIGGING_RE =
  /\b(?:rigged|rigging|skeleton|bones?|armature|skinned|skin weights?|animation clips?|animated|idle|walk|run)\b|骨骼|绑骨|绑定|蒙皮|动画|待机|走路|行走|跑步|奔跑/iu;

const RIGGABLE_TARGET_RE =
  /\b(?:character|humanoid|human|person|man|woman|boy|girl|avatar|npc|creature|monster|animal|quadruped|biped|doll|puppet|robot|android|mech|alien|dragon|dinosaur|zombie|golem|orc|elf|knight|warrior|soldier|mechanical arm)\b|人形|角色|人物|人类|男人|女人|小孩|化身|生物|怪物|动物|四足|双足|娃娃|玩偶|机器人|安卓|机甲|机械臂|机械手|外星人|龙|恐龙|僵尸|魔像|石头人|石像鬼|兽人|精灵|骑士|战士|士兵/iu;

const STATIC_TARGET_RE =
  /\b(?:rock|stone|boulder|crystal|sword|weapon|chair|table|furniture|building|house|room|car|vehicle|prop|product|crate|chest|barrel|tree|plant|food|tool|helmet|armor|statue)\b|石头|岩石|巨石|水晶|剑|武器|椅子|桌子|家具|建筑|房子|车辆|汽车|道具|产品|箱子|宝箱|桶|树|植物|食物|工具|头盔|盔甲|雕像/iu;

export const THREE_D_PROVIDERS: ThreeDProviderDefinition[] = [
  {
    id: 'meshy',
    label: 'Meshy',
    category: 'commercial',
    apiKind: 'meshy',
    defaultModel: 'meshy-6',
    models: ['meshy-6', 'meshy-5', 'meshy-4', 'meshy-3-turbo'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.meshy.ai',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.meshy.ai',
    credentialUrl: 'https://www.meshy.ai/api',
    keyLabel: 'Meshy API Key',
    keyPlaceholder: 'msy-...',
    note: '官方 Text to 3D API。适合生产级文生 3D、贴图和 GLB/FBX/OBJ 导出；按 Meshy credits 计费。',
  },
  {
    id: 'tripo',
    label: 'Tripo AI',
    category: 'commercial',
    apiKind: 'tripo',
    defaultModel: 'tripo-v3.1',
    models: [
      'tripo-v3.1',
      'tripo-v3.0',
      'tripo-p-v2.0',
      'tripo-p1',
      'tripo-turbo-v1.0',
      'tripo-v1.0-anim',
      'tripo-v1.0',
      'tripo-generate-image',
      'tripo-generate-multiview-image',
      'tripo-edit-multiview-image',
      'tripo-text-to-image',
      'tripo-v2.5',
    ],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.tripo3d.ai',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.tripo3d.ai',
    credentialUrl: 'https://platform.tripo3d.ai/api-keys',
    keyLabel: 'Tripo API Key',
    keyPlaceholder: 'tsk-...',
    note: '官方 Tripo OpenAPI。适合快速 text-to-model / image-to-model；异步 task 完成后返回模型文件。',
  },
  {
    id: 'hyper3d-rodin',
    label: 'Hyper3D Rodin',
    category: 'commercial',
    apiKind: 'generic-3d-api',
    defaultModel: 'Rodin Gen-2',
    models: ['Rodin Gen-2', 'Rodin 2.5', 'Rodin 2.0'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.hyper3d.ai/api/v2/rodin',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.hyper3d.ai/api/v2/rodin',
    credentialUrl: 'https://hyper3d.ai/',
    keyLabel: 'Hyper3D API Key',
    keyPlaceholder: 'Bearer token',
    note: 'Rodin 官方/企业 API 入口。不同账号端点可能不同；如控制台给出专用 endpoint，请直接填完整 Base URL。',
  },
  {
    id: 'sloyd',
    label: 'Sloyd',
    category: 'commercial',
    apiKind: 'generic-3d-api',
    defaultModel: 'sloyd-text-to-3d',
    models: ['sloyd-text-to-3d', 'sloyd-styleable-assets'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.sloyd.ai/v1/text-to-3d',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.sloyd.ai/v1/text-to-3d',
    credentialUrl: 'https://www.sloyd.ai/api',
    keyLabel: 'Sloyd API Key',
    keyPlaceholder: 'sk-...',
    note: '偏游戏资产和可控 3D prop 生成。API schema 以 Sloyd 控制台为准；本接入按通用 POST JSON 解析返回资源。',
  },
  {
    id: 'csm-cube',
    label: 'CSM Cube',
    category: 'commercial',
    apiKind: 'generic-3d-api',
    defaultModel: 'cube-3d',
    models: ['cube-3d', 'cube-pbr', 'cube-game-asset'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.csm.ai/v1/generations',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.csm.ai/v1/generations',
    credentialUrl: 'https://www.csm.ai/',
    keyLabel: 'CSM API Key',
    keyPlaceholder: 'csm-...',
    note: 'Common Sense Machines 3D 生成渠道。适合 image/text-to-3D 实验和创意资产；返回结构按通用资源解析。',
  },
  {
    id: 'kaedim',
    label: 'Kaedim',
    category: 'commercial',
    apiKind: 'generic-3d-api',
    defaultModel: 'kaedim-model-generation',
    models: ['kaedim-model-generation', 'kaedim-game-ready'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.kaedim3d.com/v1/generate',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.kaedim3d.com/v1/generate',
    credentialUrl: 'https://www.kaedim3d.com/api',
    keyLabel: 'Kaedim API Key',
    keyPlaceholder: 'kd-...',
    note: '偏生产级游戏/电商 3D 资产。部分计划需要企业开通；如端点不同请覆盖 Base URL。',
  },
  {
    id: 'scenario-3d',
    label: 'Scenario 3D',
    category: 'commercial',
    apiKind: 'generic-3d-api',
    defaultModel: 'model_meshy-text-to-3d',
    models: [
      'model_meshy-text-to-3d',
      'model_tripo-v3-1',
      'model_hunyuan-3d-v2-1',
      'model_trellis2',
    ],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.cloud.scenario.com/v1/generate/custom',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.cloud.scenario.com/v1/generate/custom',
    credentialUrl: 'https://app.scenario.com/',
    keyLabel: 'Scenario API Key',
    keyPlaceholder: 'sc-...',
    note: 'Scenario 聚合多种 3D 模型。适合统一管理游戏资产管线；具体模型 id 和 endpoint 以 Scenario 控制台为准。',
  },
  {
    id: '3d-ai-studio-hunyuan',
    label: '3D AI Studio · Hunyuan3D',
    category: 'commercial',
    apiKind: '3d-ai-studio',
    defaultModel: 'tencent/generate/rapid',
    models: [
      'Hunyuan3D-3.1',
      'Hunyuan3D-3.0',
      'Hunyuan3D-Rapid',
      'tencent/generate/rapid',
      'tencent/generate/precise',
      'hunyuan3d-v2.1',
    ],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.3daistudio.com',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.3daistudio.com',
    credentialUrl: 'https://www.3daistudio.com/docs/api',
    keyLabel: '3D AI Studio API Key',
    keyPlaceholder: '3das-...',
    note: '3D AI Studio 的 Hunyuan3D API 包装。适合不用自建 GPU 就调用开源 3D 模型；按任务计费。',
  },
  {
    id: '3d-ai-studio-tripo',
    label: '3D AI Studio · Tripo',
    category: 'commercial',
    apiKind: '3d-ai-studio',
    defaultModel: 'tripo/text-to-3d/3.1',
    models: [
      'tripo/text-to-3d/3.1',
      'tripo/text-to-3d/3.0',
      'tripo/text-to-3d/turbo-v1.0',
      'tripo/text-to-image',
      'tripo/generate-multiview-image',
      'tripo/edit-multiview-image',
      'meshy/text-to-3d',
    ],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.3daistudio.com',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.3daistudio.com',
    keyProviderId: '3d-ai-studio-hunyuan',
    credentialUrl: 'https://www.3daistudio.com/docs/api',
    keyLabel: '3D AI Studio API Key',
    keyPlaceholder: '3das-...',
    note: '3D AI Studio 的 Tripo/Meshy 包装。可和 Hunyuan3D 共用 Key；模型 id 可按控制台改。',
  },
  {
    id: 'fal-tripo-h31',
    label: 'fal.ai Tripo H3.1',
    category: 'commercial',
    apiKind: 'fal-3d',
    defaultModel: 'fal-ai/triposr/tripo-v3.1/text-to-3d',
    models: [
      'fal-ai/triposr/tripo-v3.1/text-to-3d',
      'fal-ai/tripo3d',
      'tripo-turbo-v1.0',
      'tripo-v1.0-anim',
      'tripo-p-v2.0',
    ],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://queue.fal.run',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://queue.fal.run',
    credentialUrl: 'https://fal.ai/models?categories=3d',
    keyLabel: 'fal API Key',
    keyPlaceholder: 'key_id:key_secret',
    note: 'fal 托管 Tripo/H3.1 类 3D 模型。适合快速接入和队列化任务；与其它 fal 3D 渠道共用 Key。',
  },
  {
    id: 'fal-hyper3d-rodin',
    label: 'fal.ai Hyper3D Rodin',
    category: 'commercial',
    apiKind: 'fal-3d',
    defaultModel: 'fal-ai/hyper3d/rodin',
    models: ['fal-ai/hyper3d/rodin', 'fal-ai/hyper3d/rodin-v2'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://queue.fal.run',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://queue.fal.run',
    keyProviderId: 'fal-tripo-h31',
    credentialUrl: 'https://fal.ai/models?categories=3d',
    keyLabel: 'fal API Key',
    keyPlaceholder: 'key_id:key_secret',
    note: 'fal 托管 Rodin 路线。适合文本到 PBR 模型、角色/物体资产实验；与 fal Tripo 共用 Key。',
  },
  {
    id: 'fal-meshy-v6',
    label: 'fal.ai Meshy',
    category: 'commercial',
    apiKind: 'fal-3d',
    defaultModel: 'fal-ai/meshy/text-to-3d',
    models: ['fal-ai/meshy/text-to-3d', 'fal-ai/meshy/v6'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://queue.fal.run',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://queue.fal.run',
    keyProviderId: 'fal-tripo-h31',
    credentialUrl: 'https://fal.ai/models?categories=3d',
    keyLabel: 'fal API Key',
    keyPlaceholder: 'key_id:key_secret',
    note: 'fal 上的 Meshy 3D 队列入口。适合不直接维护 Meshy 调用细节时接入；与其它 fal 3D 共用 Key。',
  },
  {
    id: 'replicate-hyper3d-rodin',
    label: 'Replicate · Rodin/3D',
    category: 'commercial',
    apiKind: 'replicate',
    defaultModel: 'hyper3d/rodin',
    models: ['hyper3d/rodin', 'camenduru/trellis', 'cjwbw/shap-e'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api.replicate.com/v1',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api.replicate.com/v1',
    credentialUrl: 'https://replicate.com/account/api-tokens',
    keyLabel: 'Replicate API Token',
    keyPlaceholder: 'r8_...',
    note: 'Replicate 托管 3D 模型。version/model id 变化频繁；把模型 slug 或版本 hash 填到模型字段。',
  },
  {
    id: 'huggingface-hunyuan3d',
    label: 'Hugging Face Hunyuan3D',
    category: 'free',
    apiKind: 'huggingface-inference',
    defaultModel: 'tencent/Hunyuan3D-2.1',
    models: [
      'tencent/Hunyuan3D-3.1',
      'tencent/Hunyuan3D-3.0',
      'tencent/Hunyuan3D-2.5',
      'tencent/Hunyuan3D-2.1',
      'tencent/Hunyuan3D-2mini',
    ],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api-inference.huggingface.co/models',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api-inference.huggingface.co/models',
    credentialUrl: 'https://huggingface.co/settings/tokens',
    keyLabel: 'Hugging Face Token',
    keyPlaceholder: 'hf_...',
    note: 'Hugging Face Inference / Endpoint 路线。适合免费额度或自建 Endpoint；生产前核 Hunyuan3D 许可。',
  },
  {
    id: 'huggingface-trellis',
    label: 'Hugging Face TRELLIS',
    category: 'free',
    apiKind: 'huggingface-inference',
    defaultModel: 'microsoft/TRELLIS-image-large',
    models: ['microsoft/TRELLIS-image-large', 'JeffreyXiang/TRELLIS', 'firtoz/TRELLIS'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api-inference.huggingface.co/models',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api-inference.huggingface.co/models',
    keyProviderId: 'huggingface-hunyuan3d',
    credentialUrl: 'https://huggingface.co/settings/tokens',
    keyLabel: 'Hugging Face Token',
    keyPlaceholder: 'hf_...',
    note: 'TRELLIS 开源权重/空间路线。通常更适合 image-to-3D；text-to-3D 可先用文本模型出参考图再送入本地/Endpoint。',
  },
  {
    id: 'huggingface-stable-fast-3d',
    label: 'Hugging Face Stable Fast 3D',
    category: 'free',
    apiKind: 'huggingface-inference',
    defaultModel: 'stabilityai/stable-fast-3d',
    models: ['stabilityai/stable-fast-3d', 'stabilityai/TripoSR'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://api-inference.huggingface.co/models',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://api-inference.huggingface.co/models',
    keyProviderId: 'huggingface-hunyuan3d',
    credentialUrl: 'https://huggingface.co/settings/tokens',
    keyLabel: 'Hugging Face Token',
    keyPlaceholder: 'hf_...',
    note: 'Stability AI 的快速 3D 重建路线。偏 image-to-3D；text-to-3D 可配合参考图生成。',
  },
  {
    id: 'local-comfyui-3d',
    label: 'ComfyUI 3D (local)',
    category: 'free',
    apiKind: 'generic-local-3d',
    defaultModel: 'hunyuan3d-comfyui',
    models: ['hunyuan3d-comfyui', 'trellis-comfyui', 'stable-fast-3d-comfyui'],
    needsKey: false,
    local: true,
    defaultBaseUrl: 'http://127.0.0.1:8188/3d/generate',
    supportsBaseUrl: true,
    endpointPlaceholder: 'http://127.0.0.1:8188/3d/generate',
    credentialUrl: 'https://github.com/comfyanonymous/ComfyUI',
    note: '本地 ComfyUI 3D 工作流包装入口。需安装 Hunyuan3D/TRELLIS/SF3D 节点，并暴露 POST JSON -> 3D 资源。',
  },
  {
    id: 'local-hunyuan3d',
    label: 'Local Hunyuan3D',
    category: 'free',
    apiKind: 'generic-local-3d',
    defaultModel: 'Hunyuan3D-2.1',
    models: ['Hunyuan3D-3.1', 'Hunyuan3D-3.0', 'Hunyuan3D-Rapid', 'Hunyuan3D-2.5', 'Hunyuan3D-2.1', 'Hunyuan3D-2mini'],
    needsKey: false,
    local: true,
    defaultBaseUrl: 'http://127.0.0.1:8083/generate',
    supportsBaseUrl: true,
    endpointPlaceholder: 'http://127.0.0.1:8083/generate',
    credentialUrl: 'https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1',
    note: '本地 Hunyuan3D 服务。推荐把官方 Gradio/自写 FastAPI 包成 POST JSON，返回 glb_url/model_urls/base64。',
  },
  {
    id: 'local-trellis',
    label: 'Local TRELLIS',
    category: 'free',
    apiKind: 'generic-local-3d',
    defaultModel: 'TRELLIS-image-large',
    models: ['TRELLIS-image-large', 'TRELLIS-text-wrapper'],
    needsKey: false,
    local: true,
    defaultBaseUrl: 'http://127.0.0.1:8084/generate',
    supportsBaseUrl: true,
    endpointPlaceholder: 'http://127.0.0.1:8084/generate',
    credentialUrl: 'https://github.com/microsoft/TRELLIS',
    note: '本地 Microsoft TRELLIS。偏 image-to-3D；text wrapper 可先生成参考图再调用 TRELLIS。',
  },
  {
    id: 'local-trellis2',
    label: 'Local TRELLIS 2',
    category: 'free',
    apiKind: 'generic-local-3d',
    defaultModel: 'TRELLIS-2',
    models: ['TRELLIS-2', 'TRELLIS-2-large'],
    needsKey: false,
    local: true,
    defaultBaseUrl: 'http://127.0.0.1:8085/generate',
    supportsBaseUrl: true,
    endpointPlaceholder: 'http://127.0.0.1:8085/generate',
    credentialUrl: 'https://github.com/microsoft/TRELLIS',
    note: '预留 TRELLIS 2 / 后续本地服务入口。只要求服务兼容通用 POST JSON 和资源解析。',
  },
  {
    id: 'local-stable-fast-3d',
    label: 'Local Stable Fast 3D',
    category: 'free',
    apiKind: 'generic-local-3d',
    defaultModel: 'stable-fast-3d',
    models: ['stable-fast-3d', 'TripoSR'],
    needsKey: false,
    local: true,
    defaultBaseUrl: 'http://127.0.0.1:8086/generate',
    supportsBaseUrl: true,
    endpointPlaceholder: 'http://127.0.0.1:8086/generate',
    credentialUrl: 'https://github.com/Stability-AI/stable-fast-3d',
    note: '本地 Stability AI Stable Fast 3D / TripoSR。通常需参考图输入；text-to-3D 时可让本地包装器先生成图。',
  },
  {
    id: 'local-shap-e',
    label: 'Local Shap-E',
    category: 'free',
    apiKind: 'generic-local-3d',
    defaultModel: 'shap-e',
    models: ['shap-e', 'shap-e-text-to-3d'],
    needsKey: false,
    local: true,
    defaultBaseUrl: 'http://127.0.0.1:8087/generate',
    supportsBaseUrl: true,
    endpointPlaceholder: 'http://127.0.0.1:8087/generate',
    credentialUrl: 'https://github.com/openai/shap-e',
    note: 'OpenAI Shap-E 本地老模型入口。质量落后新模型，但轻量、可离线验证 text-to-3D 管线。',
  },
  {
    id: 'local-openlrm',
    label: 'Local OpenLRM',
    category: 'free',
    apiKind: 'generic-local-3d',
    defaultModel: 'OpenLRM',
    models: ['OpenLRM', 'OpenLRM-Mix', 'InstantMesh'],
    needsKey: false,
    local: true,
    defaultBaseUrl: 'http://127.0.0.1:8088/generate',
    supportsBaseUrl: true,
    endpointPlaceholder: 'http://127.0.0.1:8088/generate',
    credentialUrl: 'https://github.com/3DTopia/OpenLRM',
    note: '本地 LRM/InstantMesh 路线。偏 image-to-3D；适合自托管资产重建实验。',
  },
  {
    id: 'local-3d-server',
    label: 'Local 3D HTTP',
    category: 'free',
    apiKind: 'generic-local-3d',
    defaultModel: 'custom-3d-model',
    models: ['custom-3d-model', 'Hunyuan3D', 'TRELLIS', 'Stable Fast 3D', 'Shap-E', 'OpenLRM'],
    needsKey: false,
    local: true,
    defaultBaseUrl: 'http://127.0.0.1:8080/generate',
    supportsBaseUrl: true,
    endpointPlaceholder: 'http://127.0.0.1:8080/generate',
    credentialUrl: 'https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1',
    note: '通用本地 3D 生成入口。任何自托管服务只要支持 POST JSON 并返回 glb_url/model_urls/base64 或原始模型文件即可。',
  },
  {
    id: 'roblox-cube',
    label: 'Roblox Cube 3D',
    category: 'free',
    apiKind: 'generic-3d-api',
    defaultModel: 'cube-3d',
    models: ['cube-3d', 'cube-mesh-generation'],
    needsKey: true,
    local: false,
    defaultBaseUrl: 'https://apis.roblox.com/mesh-generation/v1',
    supportsBaseUrl: true,
    endpointPlaceholder: 'https://apis.roblox.com/mesh-generation/v1',
    credentialUrl: 'https://create.roblox.com/docs',
    keyLabel: 'Roblox Open Cloud Key',
    keyPlaceholder: 'rbx-...',
    note: 'Roblox Cube / Mesh Generation 路线。更像平台内生成服务；需要 Roblox Open Cloud/Studio 权限，endpoint 可能需按官方控制台调整。',
  },
];

const THREE_D_PROVIDER_BY_ID = new Map<ThreeDProviderId, ThreeDProviderDefinition>(
  THREE_D_PROVIDERS.map((provider) => [provider.id, provider]),
);

export const DEFAULT_THREE_D_GENERATION_SETTINGS: ThreeDGenerationSettings = {
  enabled: false,
  preferredProviderId: 'meshy',
  providerKeys: {},
  providerBaseUrls: {},
  providerModels: {},
  rigging: DEFAULT_THREE_D_AUTO_RIGGING_SETTINGS,
};

function hasStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage;
}

function isThreeDProviderId(value: unknown): value is ThreeDProviderId {
  return typeof value === 'string' && THREE_D_PROVIDER_BY_ID.has(value as ThreeDProviderId);
}

function isThreeDRiggingProviderId(value: unknown): value is ThreeDRiggingProviderId {
  return (
    typeof value === 'string' &&
    THREE_D_RIGGING_PROVIDER_BY_ID.has(value as ThreeDRiggingProviderId)
  );
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

export function normalizeThreeDGenerationSettings(
  value: unknown,
): ThreeDGenerationSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return DEFAULT_THREE_D_GENERATION_SETTINGS;
  }
  const source = value as Partial<ThreeDGenerationSettings>;
  const preferredProviderId = isThreeDProviderId(source.preferredProviderId)
    ? source.preferredProviderId
    : DEFAULT_THREE_D_GENERATION_SETTINGS.preferredProviderId;
  return {
    enabled:
      typeof source.enabled === 'boolean'
        ? source.enabled
        : DEFAULT_THREE_D_GENERATION_SETTINGS.enabled,
    preferredProviderId,
    providerKeys: cleanRecord(source.providerKeys, isThreeDProviderId),
    providerBaseUrls: cleanRecord(source.providerBaseUrls, isThreeDProviderId),
    providerModels: cleanRecord(source.providerModels, isThreeDProviderId),
    rigging: normalizeThreeDAutoRiggingSettings(source.rigging),
  };
}

export function normalizeThreeDAutoRiggingSettings(
  value: unknown,
): ThreeDAutoRiggingSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return DEFAULT_THREE_D_AUTO_RIGGING_SETTINGS;
  }
  const source = value as Partial<ThreeDAutoRiggingSettings>;
  const preferredProviderId = isThreeDRiggingProviderId(source.preferredProviderId)
    ? source.preferredProviderId
    : DEFAULT_THREE_D_AUTO_RIGGING_SETTINGS.preferredProviderId;
  const fallbackProviderIds = Array.isArray(source.fallbackProviderIds)
    ? source.fallbackProviderIds.filter(isThreeDRiggingProviderId)
    : DEFAULT_THREE_D_AUTO_RIGGING_SETTINGS.fallbackProviderIds;
  return {
    enabled:
      typeof source.enabled === 'boolean'
        ? source.enabled
        : DEFAULT_THREE_D_AUTO_RIGGING_SETTINGS.enabled,
    preferredProviderId,
    fallbackProviderIds: uniqueRiggingProviderIds(fallbackProviderIds),
    providerKeys: cleanRecord(source.providerKeys, isThreeDRiggingProviderId),
    providerBaseUrls: cleanRecord(source.providerBaseUrls, isThreeDRiggingProviderId),
    providerCommands: cleanRecord(source.providerCommands, isThreeDRiggingProviderId),
    providerModels: cleanRecord(source.providerModels, isThreeDRiggingProviderId),
  };
}

export function loadThreeDGenerationSettings(): ThreeDGenerationSettings {
  if (!hasStorage()) return DEFAULT_THREE_D_GENERATION_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return normalizeThreeDGenerationSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return DEFAULT_THREE_D_GENERATION_SETTINGS;
  }
}

export function saveThreeDGenerationSettings(settings: ThreeDGenerationSettings): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(normalizeThreeDGenerationSettings(settings)),
    );
    window.dispatchEvent(new Event('fuc:three-d-generation-settings-changed'));
  } catch {
    /* non-fatal */
  }
}

export function threeDProviderById(id: ThreeDProviderId): ThreeDProviderDefinition {
  return THREE_D_PROVIDER_BY_ID.get(id) ?? THREE_D_PROVIDERS[0];
}

export function threeDProviderModel(
  providerId: ThreeDProviderId,
  settings = loadThreeDGenerationSettings(),
): string {
  const provider = threeDProviderById(providerId);
  return settings.providerModels[providerId]?.trim() || provider.defaultModel;
}

export function threeDProviderBaseUrl(
  providerId: ThreeDProviderId,
  settings = loadThreeDGenerationSettings(),
): string {
  const custom = settings.providerBaseUrls[providerId]?.trim();
  if (custom) return custom.replace(/\/+$/, '');
  return threeDProviderById(providerId).defaultBaseUrl.replace(/\/+$/, '');
}

function threeDProviderKey(
  providerId: ThreeDProviderId,
  settings = loadThreeDGenerationSettings(),
): string {
  const provider = threeDProviderById(providerId);
  const keyProviderId = provider.keyProviderId ?? providerId;
  return settings.providerKeys[keyProviderId]?.trim() || settings.providerKeys[providerId]?.trim() || '';
}

export function threeDProviderReady(
  providerId: ThreeDProviderId,
  settings = loadThreeDGenerationSettings(),
): boolean {
  const provider = threeDProviderById(providerId);
  if (provider.needsKey && !threeDProviderKey(providerId, settings)) return false;
  if (provider.local && !settings.providerBaseUrls[providerId]?.trim()) return false;
  return !!threeDProviderBaseUrl(providerId, settings);
}

export function threeDRiggingProviderById(
  id: ThreeDRiggingProviderId,
): ThreeDRiggingProviderDefinition {
  return THREE_D_RIGGING_PROVIDER_BY_ID.get(id) ?? THREE_D_RIGGING_PROVIDERS[0];
}

export function threeDRiggingProviderModel(
  providerId: ThreeDRiggingProviderId,
  settings = loadThreeDGenerationSettings(),
): string {
  const provider = threeDRiggingProviderById(providerId);
  return settings.rigging.providerModels[providerId]?.trim() || provider.defaultModel;
}

export function threeDRiggingProviderBaseUrl(
  providerId: ThreeDRiggingProviderId,
  settings = loadThreeDGenerationSettings(),
): string {
  const custom = settings.rigging.providerBaseUrls[providerId]?.trim();
  if (custom) return custom.replace(/\/+$/, '');
  return threeDRiggingProviderById(providerId).defaultBaseUrl.replace(/\/+$/, '');
}

function threeDRiggingProviderKey(
  providerId: ThreeDRiggingProviderId,
  settings = loadThreeDGenerationSettings(),
): string {
  const provider = threeDRiggingProviderById(providerId);
  return (
    settings.rigging.providerKeys[providerId]?.trim() ||
    (provider.fallbackThreeDKeyProviderId
      ? threeDProviderKey(provider.fallbackThreeDKeyProviderId, settings)
      : '') ||
    ''
  );
}

/**
 * Returns the API key inherited from the Mesh channel (3D generation) for a
 * rigging provider, only when the rigging provider has no key of its own. This
 * lets the UI show "已继承 Mesh 渠道的 Key" instead of forcing a re-entry —
 * configuring meshy / fal once in the Mesh channel is enough for the matching
 * rigging provider.
 */
export function threeDRiggingInheritedKey(
  providerId: ThreeDRiggingProviderId,
  settings = loadThreeDGenerationSettings(),
): { key: string; sourceProviderId: ThreeDProviderId } | null {
  const provider = threeDRiggingProviderById(providerId);
  if (settings.rigging.providerKeys[providerId]?.trim()) return null;
  if (!provider.fallbackThreeDKeyProviderId) return null;
  const key = threeDProviderKey(provider.fallbackThreeDKeyProviderId, settings);
  if (!key) return null;
  return { key, sourceProviderId: provider.fallbackThreeDKeyProviderId };
}

export function threeDRiggingProviderCommand(
  providerId: ThreeDRiggingProviderId,
  settings = loadThreeDGenerationSettings(),
): string {
  return settings.rigging.providerCommands[providerId]?.trim() || '';
}

export function threeDRiggingProviderReady(
  providerId: ThreeDRiggingProviderId,
  settings = loadThreeDGenerationSettings(),
): boolean {
  const provider = threeDRiggingProviderById(providerId);
  if (provider.apiKind === 'manual-import') return false;
  if (provider.apiKind === 'external-tool') return !!threeDRiggingProviderCommand(providerId, settings);
  if (provider.needsKey && !threeDRiggingProviderKey(providerId, settings)) return false;
  if (provider.supportsBaseUrl && !threeDRiggingProviderBaseUrl(providerId, settings)) return false;
  return true;
}

export function configuredThreeDRiggingProviderIds(
  settings = loadThreeDGenerationSettings(),
): ThreeDRiggingProviderId[] {
  return THREE_D_RIGGING_PROVIDERS.filter((provider) =>
    threeDRiggingProviderReady(provider.id, settings),
  ).map((provider) => provider.id);
}

export function configuredThreeDProviderIds(
  settings = loadThreeDGenerationSettings(),
): ThreeDProviderId[] {
  return THREE_D_PROVIDERS.filter((provider) => threeDProviderReady(provider.id, settings)).map(
    (provider) => provider.id,
  );
}

export function preferredReadyThreeDProviderId(
  settings = loadThreeDGenerationSettings(),
): ThreeDProviderId | null {
  if (threeDProviderReady(settings.preferredProviderId, settings)) {
    return settings.preferredProviderId;
  }
  return configuredThreeDProviderIds(settings)[0] ?? null;
}

export function looksLikeThreeDGenerationRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  if (/^\/(?:3d|3d-model|model3d|three-d|三维|3d模型|生成3d)(?:\s|$)/iu.test(normalized)) {
    return true;
  }
  const zhIntent =
    /(生成|创建|做|制作|建模)[\s\S]{0,20}(3d|三维|立体|模型|资产|mesh|glb|gltf)/iu.test(text) ||
    /(3d|三维|立体|模型|资产|mesh|glb|gltf)[\s\S]{0,20}(生成|创建|做|制作|建模)/iu.test(text);
  if (zhIntent) return true;
  return /\b(generate|create|make|model)\b[\s\S]{0,60}\b(3d|three[- ]d|mesh|glb|gltf|model|asset)\b/i.test(
    normalized,
  );
}

export function stripThreeDCommand(text: string): string {
  return text
    .trim()
    .replace(/^\/(?:3d|3d-model|model3d|three-d|三维|3d模型|生成3d)\s+/iu, '')
    .replace(/^请?(?:帮我)?(?:生成|创建|做|制作|建模)(?:一个|一件|一些)?(?:3d|三维|立体)?(?:模型|资产|mesh|glb|gltf)?/iu, '')
    .trim();
}

export function matchThreeDCommonAnimations(text: string): ThreeDCommonAnimation[] {
  const normalized = stripThreeDCommand(text).toLowerCase();
  if (!normalized) return [];
  return COMMON_THREE_D_ANIMATIONS.filter((animation) =>
    [animation.label, ...animation.aliases].some((alias) =>
      animationAliasMatches(normalized, alias),
    ),
  );
}

export function matchThreeDCommonAnimation(
  text: string,
): ThreeDCommonAnimation | null {
  return matchThreeDCommonAnimations(text)[0] ?? null;
}

function animationAliasMatches(text: string, alias: string): boolean {
  const normalizedAlias = alias.trim().toLowerCase();
  if (!normalizedAlias) return false;
  if (/^[a-z0-9\s-]+$/i.test(normalizedAlias)) {
    const pattern = normalizedAlias.split(/\s+/).map(escapeRegExp).join('\\s+');
    return new RegExp(`\\b${pattern}\\b`, 'iu').test(text);
  }
  return text.includes(normalizedAlias);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function assessThreeDRigging(prompt: string): ThreeDRiggingAssessment {
  const text = stripThreeDCommand(prompt);
  if (EXPLICIT_NO_RIGGING_RE.test(text)) {
    return staticRiggingAssessment('用户明确不要骨骼或动画。');
  }
  const requestedAnimations = matchThreeDCommonAnimations(text).map(
    (animation) => animation.label,
  );
  const needsAnimationSearch = requestedAnimations.some(
    (animation) => !DEFAULT_RIGGING_ANIMATIONS.includes(animation),
  );
  const explicitlyRequested =
    EXPLICIT_RIGGING_RE.test(text) || requestedAnimations.length > 0;
  const riggableTarget = RIGGABLE_TARGET_RE.test(text);
  if (STATIC_TARGET_RE.test(text) && !riggableTarget) {
    return staticRiggingAssessment('主体是静态道具或场景资产。');
  }
  if (explicitlyRequested || riggableTarget) {
    return {
      target: 'riggable',
      enabled: true,
      reason: explicitlyRequested
        ? '用户需求包含骨骼、蒙皮或动画。'
        : '主体像角色、生物或可动机械，适合骨骼绑定。',
      defaultAnimations: [...DEFAULT_RIGGING_ANIMATIONS],
      requestedAnimations,
      needsAnimationSearch,
    };
  }
  return staticRiggingAssessment('未识别为适合绑骨的角色或生物。');
}

export function threeDRiggingPromptGuidance(prompt: string): string {
  const assessment = assessThreeDRigging(prompt);
  if (assessment.enabled) {
    const extraAnimations = assessment.requestedAnimations.filter(
      (animation) => !DEFAULT_RIGGING_ANIMATIONS.includes(animation),
    );
    const animationLine = extraAnimations.length
      ? `用户额外动作：${extraAnimations.join('/')}。默认库不强塞，后续从动画库匹配或搜索。`
      : '默认只要求 Idle、Walk、Run 三个可预览 animation clips。';
    return [
      '骨骼策略：主体适合绑骨。',
      '最终提示词必须要求 rigged armature/skeleton、skinned mesh、clean skin weights、A-pose 或 T-pose。',
      animationLine,
    ].join(' ');
  }
  return [
    '骨骼策略：主体不适合或不需要绑骨。',
    '最终提示词不要加入 skeleton、rigging、skinning、bones、animation clips。',
    '保持静态 mesh/PBR 资产。',
  ].join(' ');
}

export async function generateThreeD(
  request: ThreeDGenerationRequest,
  settings = loadThreeDGenerationSettings(),
): Promise<ThreeDGenerationResult> {
  if (!settings.enabled) throw new Error('THREE_D_GENERATION_DISABLED');
  const providerId = request.providerId ?? preferredReadyThreeDProviderId(settings);
  if (!providerId) throw new Error('NO_READY_THREE_D_PROVIDER');
  if (!threeDProviderReady(providerId, settings)) {
    throw new Error(`THREE_D_PROVIDER_NOT_READY:${providerId}`);
  }
  const provider = threeDProviderById(providerId);
  const prompt = stripThreeDCommand(request.prompt);
  const model = request.model?.trim() || threeDProviderModel(providerId, settings);
  const rigging = assessThreeDRigging(prompt);
  const sourceAssets = await generateWithProvider(
    providerId,
    prompt,
    model,
    settings,
    rigging,
    request.signal,
  );
  const autoRigging = await maybeAutoRigThreeDAssets(
    sourceAssets,
    settings,
    rigging,
    request.signal,
  );
  const assets =
    autoRigging?.status === 'succeeded' && autoRigging.assets.length > 0
      ? autoRigging.assets
      : sourceAssets;
  return {
    providerId,
    providerLabel: provider.label,
    model,
    prompt,
    rigging,
    sourceAssets,
    autoRigging,
    assets,
  };
}

async function generateWithProvider(
  providerId: ThreeDProviderId,
  prompt: string,
  model: string,
  settings: ThreeDGenerationSettings,
  rigging: ThreeDRiggingAssessment,
  signal?: AbortSignal,
): Promise<string[]> {
  switch (threeDProviderById(providerId).apiKind) {
    case 'meshy':
      return generateMeshy(prompt, model, settings, signal);
    case 'tripo':
      return generateTripo(prompt, model, settings, signal);
    case '3d-ai-studio':
      return generate3DAiStudio(providerId, prompt, model, settings, signal);
    case 'fal-3d':
      return generateFal3D(providerId, prompt, model, settings, signal);
    case 'replicate':
      return generateReplicate3D(providerId, prompt, model, settings, signal);
    case 'huggingface-inference':
      return generateHuggingFace3D(providerId, prompt, model, settings, signal);
    case 'generic-local-3d':
      return generateGeneric3D(providerId, prompt, model, settings, rigging, signal);
    case 'generic-3d-api':
      return generateGeneric3D(providerId, prompt, model, settings, rigging, signal);
  }
}

async function maybeAutoRigThreeDAssets(
  assets: string[],
  settings: ThreeDGenerationSettings,
  rigging: ThreeDRiggingAssessment,
  signal?: AbortSignal,
): Promise<ThreeDAutoRiggingResult | null> {
  if (!rigging.enabled) return null;
  if (!settings.rigging.enabled) {
    return {
      providerId: settings.rigging.preferredProviderId,
      providerLabel: threeDRiggingProviderById(settings.rigging.preferredProviderId).label,
      status: 'skipped',
      assets: [],
      reason: '自动绑骨设置已关闭。',
    };
  }
  const providerIds = uniqueRiggingProviderIds([
    settings.rigging.preferredProviderId,
    ...settings.rigging.fallbackProviderIds,
  ]);
  let lastSkipped: ThreeDAutoRiggingResult | null = null;
  let lastFailed: ThreeDAutoRiggingResult | null = null;
  for (const providerId of providerIds) {
    const provider = threeDRiggingProviderById(providerId);
    const sourceAsset = firstRiggingSourceAsset(assets, provider);
    if (!sourceAsset) {
      lastSkipped = {
        providerId,
        providerLabel: provider.label,
        status: 'skipped',
        assets: [],
        reason: riggingSourceRequirement(provider),
      };
      continue;
    }
    if (!threeDRiggingProviderReady(providerId, settings)) {
      lastSkipped = {
        providerId,
        providerLabel: provider.label,
        status: 'skipped',
        sourceAsset,
        assets: [],
        reason: riggingProviderMissingConfig(provider, settings),
      };
      continue;
    }
    if (!riggingProviderCanRunAutomatically(provider)) {
      lastSkipped = {
        providerId,
        providerLabel: provider.label,
        status: 'skipped',
        sourceAsset,
        assets: [],
        reason: '该骨骼绑定方案需要外部安装或手动导入，当前不会自动打包或自动执行。',
      };
      continue;
    }
    try {
      const riggedAssets = await generateRiggedAssets(providerId, sourceAsset, settings, rigging, signal);
      return {
        providerId,
        providerLabel: provider.label,
        status: 'succeeded',
        sourceAsset,
        assets: riggedAssets,
      };
    } catch (err) {
      lastFailed = {
        providerId,
        providerLabel: provider.label,
        status: 'failed',
        sourceAsset,
        assets: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return lastFailed ?? lastSkipped;
}

function riggingProviderCanRunAutomatically(provider: ThreeDRiggingProviderDefinition): boolean {
  return (
    provider.apiKind === 'fal-meshy-rigging' ||
    provider.apiKind === 'meshy-rigging-api' ||
    provider.apiKind === 'generic-rigging-api' ||
    provider.apiKind === 'generic-local-rigging'
  );
}

function firstRiggingSourceAsset(
  assets: string[],
  provider: ThreeDRiggingProviderDefinition,
): string {
  return (
    assets.find((asset) => {
      if (!riggingAssetFormatSupported(asset, provider.supportedFormats)) return false;
      if (provider.apiKind === 'generic-local-rigging') return isModelAssetReference(asset);
      return isPublicModelAsset(asset);
    }) ?? ''
  );
}

function riggingAssetFormatSupported(asset: string, formats: string[]): boolean {
  if (/^data:/iu.test(asset)) return formats.includes('glb') || formats.includes('gltf');
  const clean = asset.trim().split(/[?#]/, 1)[0] ?? '';
  const ext = /\.([a-z0-9]+)$/iu.exec(clean)?.[1]?.toLowerCase() ?? '';
  return !!ext && formats.includes(ext);
}

function isModelAssetReference(asset: string): boolean {
  return /^data:/iu.test(asset) || MODEL_EXT_RE.test(asset);
}

function isPublicModelAsset(asset: string): boolean {
  if (!/^https?:\/\/.+/iu.test(asset) || !MODEL_EXT_RE.test(asset)) return false;
  try {
    const { hostname } = new URL(asset);
    if (
      /^(?:localhost|127\.|0\.0\.0\.0$|\[?::1\]?$)/iu.test(hostname) ||
      /^10\./u.test(hostname) ||
      /^192\.168\./u.test(hostname) ||
      /^172\.(?:1[6-9]|2\d|3[01])\./u.test(hostname)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function riggingSourceRequirement(provider: ThreeDRiggingProviderDefinition): string {
  const formats = provider.supportedFormats.map((format) => format.toUpperCase()).join('/');
  return provider.apiKind === 'generic-local-rigging'
    ? `自动绑骨需要可传给本地服务的 ${formats} 模型资源。`
    : `自动绑骨需要公开可访问的 ${formats} 模型 URL。`;
}

function riggingProviderMissingConfig(
  provider: ThreeDRiggingProviderDefinition,
  settings: ThreeDGenerationSettings,
): string {
  if (provider.apiKind === 'external-tool') return '未配置外部工具命令或脚本路径。';
  if (provider.needsKey && !threeDRiggingProviderKey(provider.id, settings)) {
    return `未配置 ${provider.label} API Key。`;
  }
  if (provider.supportsBaseUrl && !threeDRiggingProviderBaseUrl(provider.id, settings)) {
    return `未配置 ${provider.label} API endpoint。`;
  }
  return `${provider.label} 未就绪。`;
}

async function generateRiggedAssets(
  providerId: ThreeDRiggingProviderId,
  sourceAsset: string,
  settings: ThreeDGenerationSettings,
  rigging: ThreeDRiggingAssessment,
  signal?: AbortSignal,
): Promise<string[]> {
  const provider = threeDRiggingProviderById(providerId);
  switch (provider.apiKind) {
    case 'fal-meshy-rigging':
      return generateFalMeshyRigging(sourceAsset, settings, signal);
    case 'meshy-rigging-api':
      return generateMeshyRigging(sourceAsset, settings, signal);
    case 'generic-rigging-api':
    case 'generic-local-rigging':
      return generateGenericRigging(providerId, sourceAsset, settings, rigging, signal);
    case 'external-tool':
    case 'manual-import':
      throw new Error('该骨骼绑定方案需要外部安装或手动导入，当前不会自动执行。');
  }
}

function staticRiggingAssessment(reason: string): ThreeDRiggingAssessment {
  return {
    target: 'static',
    enabled: false,
    reason,
    defaultAnimations: [],
    requestedAnimations: [],
    needsAnimationSearch: false,
  };
}

async function generateMeshy(
  prompt: string,
  model: string,
  settings: ThreeDGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = threeDProviderKey('meshy', settings);
  if (!apiKey) throw new Error('Meshy API key is missing.');
  const baseUrl = threeDProviderBaseUrl('meshy', settings);
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const previewResponse = await fetch(`${baseUrl}/openapi/v2/text-to-3d`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      mode: 'preview',
      prompt,
      ai_model: model,
      art_style: 'realistic',
      topology: 'triangle',
      target_polycount: 50000,
      should_remesh: true,
    }),
    signal,
  });
  const previewStarted = await readJsonResponse(previewResponse);
  const immediate = assetsFromJson(previewStarted);
  if (immediate.length > 0 && isTerminalSuccess(previewStarted)) return immediate;
  const previewTaskId = taskIdFromJson(previewStarted);
  if (!previewTaskId) throw new Error('Meshy did not return a task id.');
  const preview = await pollJson(
    () => fetch(`${baseUrl}/openapi/v2/text-to-3d/${encodeURIComponent(previewTaskId)}`, { headers, signal }),
    'Meshy',
    signal,
  );
  const previewAssets = assetsFromJson(preview);

  try {
    const refineResponse = await fetch(`${baseUrl}/openapi/v2/text-to-3d`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        mode: 'refine',
        preview_task_id: previewTaskId,
        texture_prompt: prompt,
        ai_model: model,
      }),
      signal,
    });
    const refineStarted = await readJsonResponse(refineResponse);
    const refineImmediate = assetsFromJson(refineStarted);
    if (refineImmediate.length > 0 && isTerminalSuccess(refineStarted)) return refineImmediate;
    const refineTaskId = taskIdFromJson(refineStarted);
    if (refineTaskId) {
      const refined = await pollJson(
        () => fetch(`${baseUrl}/openapi/v2/text-to-3d/${encodeURIComponent(refineTaskId)}`, { headers, signal }),
        'Meshy refine',
        signal,
      );
      const refinedAssets = assetsFromJson(refined);
      if (refinedAssets.length > 0) return refinedAssets;
    }
  } catch {
    if (previewAssets.length > 0) return previewAssets;
    throw new Error('Meshy refine failed and preview returned no model.');
  }

  if (previewAssets.length > 0) return previewAssets;
  throw new Error('Meshy returned no 3D assets.');
}

async function generateTripo(
  prompt: string,
  model: string,
  settings: ThreeDGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = threeDProviderKey('tripo', settings);
  if (!apiKey) throw new Error('Tripo API key is missing.');
  const baseUrl = threeDProviderBaseUrl('tripo', settings);
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const response = await fetch(`${baseUrl}/v2/openapi/task`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      type: 'text_to_model',
      prompt,
      model_version: model,
    }),
    signal,
  });
  const started = await readJsonResponse(response);
  const immediate = assetsFromJson(started);
  if (immediate.length > 0 && isTerminalSuccess(started)) return immediate;
  const taskId = taskIdFromJson(started);
  if (!taskId) throw new Error('Tripo did not return a task id.');
  const done = await pollJson(
    () => fetch(`${baseUrl}/v2/openapi/task/${encodeURIComponent(taskId)}`, { headers, signal }),
    'Tripo',
    signal,
  );
  const assets = assetsFromJson(done);
  if (assets.length > 0) return assets;
  throw new Error('Tripo returned no 3D assets.');
}

async function generate3DAiStudio(
  providerId: ThreeDProviderId,
  prompt: string,
  model: string,
  settings: ThreeDGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = threeDProviderKey(providerId, settings);
  if (!apiKey) throw new Error('3D AI Studio API key is missing.');
  const baseUrl = threeDProviderBaseUrl(providerId, settings);
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const modelPath = model.replace(/^\/+/, '');
  const response = await fetch(`${baseUrl}/v1/3d-models/${modelPath}/`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      prompt,
      output_format: 'glb',
      enable_pbr: true,
    }),
    signal,
  });
  const started = await readJsonResponse(response);
  const immediate = assetsFromJson(started);
  if (immediate.length > 0 && isTerminalSuccess(started)) return immediate;
  const taskId = taskIdFromJson(started);
  if (!taskId) throw new Error('3D AI Studio did not return a generation request id.');
  const done = await pollJson(
    () =>
      fetch(`${baseUrl}/v1/generation-request/${encodeURIComponent(taskId)}/status/`, {
        headers,
        signal,
      }),
    '3D AI Studio',
    signal,
  );
  const assets = assetsFromJson(done);
  if (assets.length > 0) return assets;
  throw new Error('3D AI Studio returned no 3D assets.');
}

async function generateFal3D(
  providerId: ThreeDProviderId,
  prompt: string,
  model: string,
  settings: ThreeDGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  return runFalQueueModel({
    providerId,
    modelPath: model.replace(/^\/+/, ''),
    input: {
      prompt,
      output_format: 'glb',
    },
    providerLabel: 'fal',
    settings,
    signal,
  });
}

async function generateFalMeshyRigging(
  modelUrl: string,
  settings: ThreeDGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  return runFalQueueModel({
    providerId: 'fal-meshy-v6',
    modelPath: FAL_MESHY_RIGGING_MODEL,
    input: { model_url: modelUrl },
    providerLabel: 'fal.ai Meshy Rigging',
    settings,
    apiKeyOverride: threeDRiggingProviderKey('fal-meshy-rigging', settings),
    baseUrlOverride:
      settings.rigging.providerBaseUrls['fal-meshy-rigging']?.trim() ||
      threeDProviderBaseUrl('fal-meshy-v6', settings),
    signal,
  });
}

async function generateMeshyRigging(
  modelUrl: string,
  settings: ThreeDGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = threeDRiggingProviderKey('meshy-rigging-api', settings);
  if (!apiKey) throw new Error('Meshy Rigging API key is missing.');
  const baseUrl = threeDRiggingProviderBaseUrl('meshy-rigging-api', settings);
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const response = await fetch(`${baseUrl}/openapi/v1/rigging`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model_url: modelUrl,
      enable_basic_animation: true,
    }),
    signal,
  });
  const started = await readJsonResponse(response);
  const immediate = assetsFromJson(started);
  if (immediate.length > 0 && isTerminalSuccess(started)) return immediate;
  const taskId = taskIdFromJson(started);
  if (!taskId) throw new Error('Meshy Rigging did not return a task id.');
  const done = await pollJson(
    () => fetch(`${baseUrl}/openapi/v1/rigging/${encodeURIComponent(taskId)}`, { headers, signal }),
    'Meshy Rigging',
    signal,
  );
  const assets = assetsFromJson(done);
  if (assets.length > 0) return assets;
  throw new Error('Meshy Rigging returned no 3D assets.');
}

async function generateGenericRigging(
  providerId: ThreeDRiggingProviderId,
  modelUrl: string,
  settings: ThreeDGenerationSettings,
  rigging: ThreeDRiggingAssessment,
  signal?: AbortSignal,
): Promise<string[]> {
  const provider = threeDRiggingProviderById(providerId);
  const apiKey = threeDRiggingProviderKey(providerId, settings);
  if (provider.needsKey && !apiKey) throw new Error(`${provider.label} API key is missing.`);
  const baseUrl = threeDRiggingProviderBaseUrl(providerId, settings);
  if (!baseUrl) throw new Error(`${provider.label} API endpoint is missing.`);
  const headers: Record<string, string> = {
    Accept: 'model/gltf-binary, model/gltf+json, application/json, application/octet-stream',
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
    headers['X-API-Key'] = apiKey;
  }
  const model = threeDRiggingProviderModel(providerId, settings);
  const body = {
    model_url: modelUrl,
    source_asset: modelUrl,
    model,
    input: {
      model_url: modelUrl,
      source_asset: modelUrl,
      model,
      target: rigging.target,
      default_animations: rigging.defaultAnimations,
      requested_animations: rigging.requestedAnimations,
      search_animation_libraries: rigging.needsAnimationSearch,
    },
    output_format: 'glb',
    formats: ['glb', 'fbx'],
    default_animations: rigging.defaultAnimations,
    requested_animations: rigging.requestedAnimations,
  };
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
  const started = await readResponseJsonOrAssets(response, provider.label);
  const immediate = assetsFromJson(started);
  if (immediate.length > 0 && isTerminalSuccess(started)) return immediate;
  const taskId = taskIdFromJson(started);
  const statusUrl = statusUrlFromUnknown(started);
  if (!taskId && !statusUrl) {
    if (immediate.length > 0) return immediate;
    throw new Error(`${provider.label} returned no rigged assets.`);
  }
  const done = await pollJson(
    () =>
      fetch(
        statusUrl || `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(taskId ?? '')}`,
        { headers, signal },
      ),
    provider.label,
    signal,
  );
  const assets = assetsFromJson(done);
  if (assets.length > 0) return assets;
  throw new Error(`${provider.label} returned no rigged assets.`);
}

async function runFalQueueModel({
  providerId,
  modelPath,
  input,
  providerLabel,
  settings,
  apiKeyOverride,
  baseUrlOverride,
  signal,
}: {
  providerId: ThreeDProviderId;
  modelPath: string;
  input: Record<string, unknown>;
  providerLabel: string;
  settings: ThreeDGenerationSettings;
  apiKeyOverride?: string;
  baseUrlOverride?: string;
  signal?: AbortSignal;
}): Promise<string[]> {
  const apiKey = apiKeyOverride?.trim() || threeDProviderKey(providerId, settings);
  if (!apiKey) throw new Error('fal API key is missing.');
  const baseUrl = (baseUrlOverride?.trim() || threeDProviderBaseUrl(providerId, settings)).replace(
    /\/+$/,
    '',
  );
  const headers = {
    Authorization: `Key ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const response = await fetch(`${baseUrl}/${modelPath}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ input }),
    signal,
  });
  const started = await readJsonResponse(response);
  const immediate = assetsFromJson(started);
  if (immediate.length > 0 && isTerminalSuccess(started)) return immediate;
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
    const statusAssets = assetsFromJson(status);
    if (statusAssets.length > 0 && isTerminalSuccess(status)) return statusAssets;
    const state = jsonState(status);
    if (isFailedState(state)) {
      throw new Error(providerErrorMessage(status) || `${providerLabel} generation failed.`);
    }
    if (isSuccessState(state, status)) {
      const finalResponse = await fetch(responseUrl, { headers, signal });
      const finalJson = await readJsonResponse(finalResponse);
      const assets = assetsFromJson(finalJson);
      if (assets.length > 0) return assets;
      throw new Error(`${providerLabel} returned no 3D assets.`);
    }
  }
  throw new Error(`${providerLabel} job timed out before assets were ready.`);
}

async function generateReplicate3D(
  providerId: ThreeDProviderId,
  prompt: string,
  model: string,
  settings: ThreeDGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = threeDProviderKey(providerId, settings);
  if (!apiKey) throw new Error('Replicate API token is missing.');
  const baseUrl = threeDProviderBaseUrl(providerId, settings);
  const headers = {
    Authorization: `Token ${apiKey}`,
    'Content-Type': 'application/json',
    Prefer: 'wait',
  };
  const body = model.includes(':')
    ? { version: model, input: { prompt, output_format: 'glb' } }
    : { model, input: { prompt, output_format: 'glb' } };
  const response = await fetch(`${baseUrl}/predictions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
  const started = await readJsonResponse(response);
  const immediate = assetsFromJson(started);
  if (immediate.length > 0 && isTerminalSuccess(started)) return immediate;
  const getUrl = stringValue(objectValue(started.urls)?.get);
  if (!getUrl) throw new Error('Replicate did not return a prediction get URL.');
  const done = await pollJson(
    () => fetch(getUrl, { headers, signal }),
    'Replicate',
    signal,
  );
  const assets = assetsFromJson(done);
  if (assets.length > 0) return assets;
  throw new Error('Replicate returned no 3D assets.');
}

async function generateHuggingFace3D(
  providerId: ThreeDProviderId,
  prompt: string,
  model: string,
  settings: ThreeDGenerationSettings,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = threeDProviderKey(providerId, settings);
  if (!apiKey) throw new Error('Hugging Face token is missing.');
  const baseUrl = threeDProviderBaseUrl(providerId, settings);
  const response = await fetch(`${baseUrl}/${model}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'model/gltf-binary, model/gltf+json, application/json, application/octet-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      inputs: prompt,
      parameters: {
        output_format: 'glb',
      },
    }),
    signal,
  });
  return assetsFromResponse(response, 'Hugging Face');
}

async function generateGeneric3D(
  providerId: ThreeDProviderId,
  prompt: string,
  model: string,
  settings: ThreeDGenerationSettings,
  rigging: ThreeDRiggingAssessment,
  signal?: AbortSignal,
): Promise<string[]> {
  const apiKey = threeDProviderKey(providerId, settings);
  const provider = threeDProviderById(providerId);
  if (provider.needsKey && !apiKey) throw new Error(`${provider.label} API key is missing.`);
  const baseUrl = threeDProviderBaseUrl(providerId, settings);
  const headers: Record<string, string> = {
    Accept: 'model/gltf-binary, model/gltf+json, application/json, application/octet-stream',
    'Content-Type': 'application/json',
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const input: Record<string, unknown> = { prompt, model };
  const body: Record<string, unknown> = {
    prompt,
    model,
    input,
    output_format: 'glb',
    formats: ['glb', 'gltf', 'obj', 'fbx', 'stl', 'usdz'],
  };
  if (provider.apiKind === 'generic-local-3d') {
    const riggingRequest = {
      enabled: rigging.enabled,
      target: rigging.target,
      skeleton: rigging.enabled,
      skinning: rigging.enabled,
      default_animations: rigging.defaultAnimations,
      requested_animations: rigging.requestedAnimations,
      search_animation_libraries: rigging.needsAnimationSearch,
      reason: rigging.reason,
    };
    input.rigging = riggingRequest;
    body.rigging = riggingRequest;
  }
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
  const started = await readResponseJsonOrAssets(response, provider.label);
  const immediate = assetsFromUnknown(started, '');
  if (immediate.length > 0 && isTerminalSuccess(started)) return immediate;
  const taskId = taskIdFromUnknown(started);
  const statusUrl = statusUrlFromUnknown(started);
  if (!taskId && !statusUrl) {
    if (immediate.length > 0) return immediate;
    throw new Error(`${provider.label} returned no 3D assets.`);
  }
  const done = await pollJson(
    () =>
      fetch(
        statusUrl || `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(taskId ?? '')}`,
        { headers, signal },
      ),
    provider.label,
    signal,
  );
  const assets = assetsFromJson(done);
  if (assets.length > 0) return assets;
  throw new Error(`${provider.label} returned no 3D assets.`);
}

async function assetsFromResponse(response: Response, providerLabel: string): Promise<string[]> {
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`${response.status} ${response.statusText}${text ? `: ${text}` : ''}`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (isModelContentType(contentType) || contentType === 'application/octet-stream') {
    const blob = await response.blob();
    return [await blobToDataUrl(modelBlob(blob, contentType))];
  }
  const json = (await response.json()) as Record<string, unknown>;
  const assets = assetsFromJson(json);
  if (assets.length > 0) return assets;
  throw new Error(`${providerLabel} returned no 3D assets.`);
}

async function readResponseJsonOrAssets(
  response: Response,
  providerLabel: string,
): Promise<Record<string, unknown>> {
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`${response.status} ${response.statusText}${text ? `: ${text}` : ''}`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (isModelContentType(contentType) || contentType === 'application/octet-stream') {
    const blob = await response.blob();
    return { output: await blobToDataUrl(modelBlob(blob, contentType)) };
  }
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    throw new Error(`${providerLabel} returned a non-JSON response.`);
  }
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`${response.status} ${response.statusText}${text ? `: ${text}` : ''}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

async function pollJson(
  request: () => Promise<Response>,
  providerLabel: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  for (let i = 0; i < 180; i += 1) {
    const response = await request();
    const json = await readJsonResponse(response);
    const state = jsonState(json);
    if (isFailedState(state)) {
      throw new Error(providerErrorMessage(json) || `${providerLabel} generation failed.`);
    }
    if (isSuccessState(state, json) || assetsFromJson(json).length > 0) return json;
    await delay(3000, signal);
  }
  throw new Error(`${providerLabel} job timed out before assets were ready.`);
}

function assetsFromJson(json: Record<string, unknown>): string[] {
  return assetsFromUnknown(json, '');
}

function assetsFromUnknown(value: unknown, keyHint = ''): string[] {
  if (!value) return [];
  if (typeof value === 'string') {
    const src = assetString(value, keyHint);
    return src ? [src] : [];
  }
  if (Array.isArray(value)) return uniqueStrings(value.flatMap((item) => assetsFromUnknown(item, keyHint)));
  if (typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const assets: string[] = [];
  const push = (src: string) => {
    if (!src || assets.includes(src)) return;
    assets.push(src);
  };
  const inlineData = objectValue(record.inlineData) ?? objectValue(record.inline_data);
  if (inlineData) {
    const data = stringValue(inlineData.data);
    const mimeType = stringValue(inlineData.mimeType) || stringValue(inlineData.mime_type);
    if (data && (isModelContentType(mimeType) || modelKeyHint(keyHint))) {
      push(modelDataUrl(data, isModelContentType(mimeType) ? mimeType : 'model/gltf-binary'));
    }
  }
  for (const key of [
    'model',
    'models',
    'model_url',
    'modelUrl',
    'model_urls',
    'modelUrls',
    'mesh',
    'mesh_url',
    'meshUrl',
    'glb',
    'glb_url',
    'glbUrl',
    'gltf',
    'gltf_url',
    'gltfUrl',
    'obj',
    'obj_url',
    'objUrl',
    'fbx',
    'fbx_url',
    'fbxUrl',
    'stl',
    'stl_url',
    'stlUrl',
    'usdz',
    'usdz_url',
    'usdzUrl',
    'download',
    'download_url',
    'downloadUrl',
    'download_urls',
    'downloadUrls',
    'asset',
    'assets',
    'file',
    'files',
    'url',
    'uri',
    'data',
    'result',
    'results',
    'output',
    'outputs',
    'response',
    'prediction',
    'predictions',
    'task',
    'tasks',
  ]) {
    for (const src of assetsFromUnknown(record[key], key)) push(src);
  }
  for (const [key, child] of Object.entries(record)) {
    for (const src of assetsFromUnknown(child, key)) push(src);
  }
  const bytesBase64 =
    stringValue(record.bytesBase64Encoded) ||
    stringValue(record.bytes_base64_encoded) ||
    stringValue(record.modelBase64) ||
    stringValue(record.model_base64) ||
    stringValue(record.glbBase64) ||
    stringValue(record.glb_base64);
  if (bytesBase64) {
    const mimeType = stringValue(record.mimeType) || stringValue(record.mime_type);
    push(modelDataUrl(bytesBase64, isModelContentType(mimeType) ? mimeType : 'model/gltf-binary'));
  }
  return assets;
}

function assetString(value: string, keyHint: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^data:(?:model\/|application\/octet-stream|application\/zip)/i.test(trimmed)) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    if (NON_MODEL_EXT_RE.test(trimmed)) return null;
    if (MODEL_EXT_RE.test(trimmed) || modelKeyHint(keyHint)) return trimmed;
    return null;
  }
  if (/^[A-Za-z0-9+/=\s_-]{80,}$/u.test(trimmed) && modelKeyHint(keyHint)) {
    return modelDataUrl(trimmed.replace(/\s+/g, ''), 'model/gltf-binary');
  }
  return null;
}

const MODEL_EXT_RE = /\.(?:glb|gltf|obj|fbx|stl|ply|usdz|blend|zip)(?:[?#]|$)/iu;
const NON_MODEL_EXT_RE =
  /\.(?:png|apng|jpe?g|jpe|jfif|pjpeg|pjp|gif|webp|bmp|svg|avif|ico|mp4|mov|webm|mp3|wav|m4a|aac|ogg|flac)(?:[?#]|$)/iu;

function modelKeyHint(keyHint: string): boolean {
  return /(?:model|mesh|asset|glb|gltf|obj|fbx|stl|ply|usdz|blend|download|file|url|output|result)/iu.test(
    keyHint,
  );
}

function isModelContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  return /^(?:model\/|application\/(?:octet-stream|zip)|application\/x-fbx)/iu.test(contentType);
}

function modelBlob(blob: Blob, contentType: string): Blob {
  if (isModelContentType(contentType) && contentType !== 'application/octet-stream') return blob;
  return new Blob([blob], { type: 'model/gltf-binary' });
}

function modelDataUrl(base64: string, mimeType: string): string {
  return `data:${mimeType || 'model/gltf-binary'};base64,${base64}`;
}

function taskIdFromJson(json: Record<string, unknown>): string {
  return taskIdFromUnknown(json);
}

function taskIdFromUnknown(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const record = value as Record<string, unknown>;
  const direct =
    stringValue(record.id) ||
    stringValue(record.task_id) ||
    stringValue(record.taskId) ||
    stringValue(record.result) ||
    stringValue(record.request_id) ||
    stringValue(record.requestId) ||
    stringValue(record.generation_request_id) ||
    stringValue(record.generationRequestId) ||
    stringValue(record.job_id) ||
    stringValue(record.jobId) ||
    stringValue(record.prediction_id) ||
    stringValue(record.predictionId);
  if (direct) return direct;
  for (const key of ['data', 'result', 'output', 'task', 'request', 'prediction']) {
    const nested = taskIdFromUnknown(record[key]);
    if (nested) return nested;
  }
  return '';
}

function statusUrlFromUnknown(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const record = value as Record<string, unknown>;
  const direct =
    stringValue(record.status_url) ||
    stringValue(record.statusUrl) ||
    stringValue(record.poll_url) ||
    stringValue(record.pollUrl) ||
    stringValue(record.get_url) ||
    stringValue(record.getUrl);
  if (direct) return direct;
  const urls = objectValue(record.urls);
  if (urls) return stringValue(urls.get) || stringValue(urls.status) || '';
  for (const key of ['data', 'result', 'output', 'task', 'request', 'prediction']) {
    const nested = statusUrlFromUnknown(record[key]);
    if (nested) return nested;
  }
  return '';
}

function jsonState(json: Record<string, unknown>): string {
  const candidates = [
    json.status,
    json.state,
    json.task_status,
    json.taskStatus,
    json.phase,
    objectValue(json.data)?.status,
    objectValue(json.result)?.status,
    objectValue(json.output)?.status,
  ];
  for (const item of candidates) {
    const value = stringValue(item).toLowerCase();
    if (value) return value;
  }
  return '';
}

function isSuccessState(state: string, json: Record<string, unknown>): boolean {
  if (/^(?:success|succeeded|completed|complete|done|finished|ready)$/iu.test(state)) return true;
  if (typeof json.success === 'boolean') return json.success;
  return false;
}

function isTerminalSuccess(json: Record<string, unknown>): boolean {
  const state = jsonState(json);
  return !state || isSuccessState(state, json);
}

function isFailedState(state: string): boolean {
  return /^(?:failed|failure|error|errored|canceled|cancelled|timeout|timed_out)$/iu.test(state);
}

function providerErrorMessage(json: Record<string, unknown>): string {
  const direct =
    stringValue(json.error) ||
    stringValue(json.message) ||
    stringValue(json.detail) ||
    stringValue(json.reason);
  if (direct) return direct;
  const taskError = objectValue(json.task_error) ?? objectValue(json.taskError);
  if (taskError) {
    const message =
      stringValue(taskError.message) ||
      stringValue(taskError.error) ||
      stringValue(taskError.detail) ||
      stringValue(taskError.reason);
    if (message) return message;
  }
  const data = objectValue(json.data);
  return data
    ? stringValue(data.error) ||
        stringValue(data.message) ||
        stringValue(data.detail) ||
        stringValue(data.reason)
    : '';
}

function objectValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function uniqueStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function uniqueRiggingProviderIds(
  values: ThreeDRiggingProviderId[],
): ThreeDRiggingProviderId[] {
  const out: ThreeDRiggingProviderId[] = [];
  const seen = new Set<ThreeDRiggingProviderId>();
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = window.setTimeout(resolve, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read 3D model blob.'));
    reader.readAsDataURL(blob);
  });
}
