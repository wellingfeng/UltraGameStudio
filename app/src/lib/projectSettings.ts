import type {
  ProjectEngineKind,
  ProjectEnvironmentScan,
  ProjectLspProbeResult,
  ProjectMcpProbeResult,
  ProjectMcpServerSuggestion,
} from '@/lib/tauri';
import type { HistoryMetadata, WorkspaceSummary } from '@/store/history/types';
import { uniqueWorkspaceHistory } from '@/lib/workspaceHistory';

export const PREFERRED_UNREAL_MCP_SERVER_ID = 'ue-mcp-for-all-versions';

/**
 * Normalize a list of workspace-folder paths: trim, drop empties, and dedupe by
 * platform-aware path key while preserving order.
 */
export function dedupeFolders(paths: readonly unknown[]): string[] {
  return uniqueWorkspaceHistory(paths);
}

export const PROJECT_SETTINGS_METADATA_KEY = 'projectSettings';
export const PROJECT_SETTINGS_SCHEMA_VERSION = 1;

export type ProjectMcpTransport = 'stdio' | 'streamable-http' | string;
export type ProjectMcpServerSource = 'suggested' | 'custom';

export interface ProjectMcpServerConfig {
  id: string;
  label: string;
  description?: string;
  source: ProjectMcpServerSource;
  enabled: boolean;
  transport: ProjectMcpTransport;
  command?: string;
  args: string[];
  env: Record<string, string>;
  url?: string;
  requiresUserApproval?: boolean;
  lastProbe?: ProjectMcpProbeResult;
  /** Server binary/release version (e.g. Unreal MCP "0.2.0"). */
  serverVersion?: string;
  /**
   * Engine version this server was configured against, when applicable
   * (e.g. the UE `EngineAssociation` "5.3" detected during one-click setup).
   */
  engineAssociation?: string;
}

export interface ProjectSkillSettings {
  enabledRootIds: string[];
  disabledSkillNames: string[];
  recommendedSkillIds: string[];
}

export type ProjectLspServerSource = 'catalog' | 'custom';

export interface ProjectLspServerConfig {
  id: string;
  enabled: boolean;
  source: ProjectLspServerSource;
  command?: string;
  args: string[];
  lastProbe?: ProjectLspProbeResult;
}

export interface ProjectLspSettings {
  enabled: boolean;
  servers: ProjectLspServerConfig[];
}

export type ProjectGameExpertEngine = 'auto' | 'unity' | 'unreal' | 'godot';

export interface ProjectGameFeatureSettings {
  meshGeneration: boolean;
  rigging: boolean;
  gameExperts: boolean;
  gameExpertEngine: ProjectGameExpertEngine;
}

export interface ProjectAutomationSettings {
  autoDetect: boolean;
  autoConfigureRecommendedMcp: boolean;
  autoStartMcp: boolean;
  allowThirdPartyInstall: boolean;
}

export interface ProjectSettings {
  schemaVersion: 1;
  engine: ProjectEngineKind | 'auto';
  /**
   * Additional workspace folders attached to this project, beyond the
   * workspace's own primary path. New chat sessions inherit these folders as
   * their composer workspace folders (the primary path is the first cwd, these
   * become extra allowed directories passed to the CLI adapters).
   */
  folders: string[];
  mcp: {
    enabled: boolean;
    servers: ProjectMcpServerConfig[];
  };
  skills: ProjectSkillSettings;
  lsp: ProjectLspSettings;
  gameFeatures: ProjectGameFeatureSettings;
  automation: ProjectAutomationSettings;
  updatedAt?: string;
}

export type ProjectHealthTone =
  | 'none'
  | 'detected'
  | 'configured'
  | 'connected'
  | 'failed';

export interface ProjectHealth {
  tone: ProjectHealthTone;
  label: string;
  detail: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function isProjectGameExpertEngine(value: unknown): value is ProjectGameExpertEngine {
  return value === 'unity' || value === 'unreal' || value === 'godot' || value === 'auto';
}

export function isGameProjectEngine(
  engine: ProjectEngineKind | 'auto',
): engine is Extract<ProjectEngineKind, 'unreal' | 'unity' | 'godot'> {
  return engine === 'unreal' || engine === 'unity' || engine === 'godot';
}

export function gameFeatureDefaultsForEngine(
  engine: ProjectEngineKind | 'auto',
): ProjectGameFeatureSettings {
  const enabled = isGameProjectEngine(engine);
  return {
    meshGeneration: enabled,
    rigging: enabled,
    gameExperts: enabled,
    gameExpertEngine: enabled ? engine : 'auto',
  };
}

function normalizeServer(value: unknown): ProjectMcpServerConfig | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  if (!id) return null;
  return {
    id,
    label:
      typeof value.label === 'string' && value.label.trim()
        ? value.label.trim()
        : id,
    description:
      typeof value.description === 'string' ? value.description : undefined,
    source: value.source === 'custom' ? 'custom' : 'suggested',
    enabled: value.enabled === true,
    transport:
      typeof value.transport === 'string' && value.transport.trim()
        ? value.transport.trim()
        : 'stdio',
    command: typeof value.command === 'string' ? value.command : undefined,
    args: stringArray(value.args),
    env: stringMap(value.env),
    url: typeof value.url === 'string' ? value.url : undefined,
    requiresUserApproval: value.requiresUserApproval === true,
    lastProbe: isRecord(value.lastProbe)
      ? (value.lastProbe as unknown as ProjectMcpProbeResult)
      : undefined,
    serverVersion:
      typeof value.serverVersion === 'string' && value.serverVersion.trim()
        ? value.serverVersion.trim()
        : undefined,
    engineAssociation:
      typeof value.engineAssociation === 'string' && value.engineAssociation.trim()
        ? value.engineAssociation.trim()
        : undefined,
  };
}

function normalizeLspServer(value: unknown): ProjectLspServerConfig | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  if (!id) return null;
  return {
    id,
    enabled: value.enabled === true,
    source: value.source === 'custom' ? 'custom' : 'catalog',
    command: typeof value.command === 'string' ? value.command : undefined,
    args: stringArray(value.args),
    lastProbe: isRecord(value.lastProbe)
      ? (value.lastProbe as unknown as ProjectLspProbeResult)
      : undefined,
  };
}

export function emptyProjectSettings(): ProjectSettings {
  return {
    schemaVersion: PROJECT_SETTINGS_SCHEMA_VERSION,
    engine: 'auto',
    folders: [],
    mcp: {
      enabled: false,
      servers: [],
    },
    skills: {
      enabledRootIds: ['codex', 'agents', 'claude'],
      disabledSkillNames: [],
      recommendedSkillIds: [],
    },
    lsp: {
      enabled: false,
      servers: [],
    },
    gameFeatures: gameFeatureDefaultsForEngine('unknown'),
    automation: {
      autoDetect: true,
      autoConfigureRecommendedMcp: false,
      autoStartMcp: false,
      allowThirdPartyInstall: false,
    },
  };
}

export function projectSettingsFromMetadata(
  metadata?: HistoryMetadata,
): ProjectSettings {
  const defaults = emptyProjectSettings();
  const raw = metadata?.[PROJECT_SETTINGS_METADATA_KEY];
  if (!isRecord(raw)) return defaults;
  const mcp = isRecord(raw.mcp) ? raw.mcp : {};
  const skills = isRecord(raw.skills) ? raw.skills : {};
  const lsp = isRecord(raw.lsp) ? raw.lsp : {};
  const gameFeatures = isRecord(raw.gameFeatures) ? raw.gameFeatures : {};
  const automation = isRecord(raw.automation) ? raw.automation : {};
  const mcpServers = Array.isArray(mcp.servers)
    ? mcp.servers
        .map(normalizeServer)
        .filter((server): server is ProjectMcpServerConfig => server != null)
    : [];
  const lspServers = Array.isArray(lsp.servers)
    ? lsp.servers
        .map(normalizeLspServer)
        .filter((server): server is ProjectLspServerConfig => server != null)
    : [];
  return {
    schemaVersion: PROJECT_SETTINGS_SCHEMA_VERSION,
    engine:
      raw.engine === 'unreal' ||
      raw.engine === 'unity' ||
      raw.engine === 'godot' ||
      raw.engine === 'unknown'
        ? raw.engine
        : 'auto',
    folders: dedupeFolders(stringArray(raw.folders)),
    mcp: {
      enabled:
        typeof mcp.enabled === 'boolean' ? mcp.enabled : mcpServers.length > 0,
      servers: mcpServers,
    },
    skills: {
      enabledRootIds: stringArray(skills.enabledRootIds).length
        ? stringArray(skills.enabledRootIds)
        : defaults.skills.enabledRootIds,
      disabledSkillNames: stringArray(skills.disabledSkillNames),
      recommendedSkillIds: stringArray(skills.recommendedSkillIds),
    },
    lsp: {
      enabled:
        typeof lsp.enabled === 'boolean' ? lsp.enabled : lspServers.length > 0,
      servers: lspServers,
    },
    gameFeatures: {
      meshGeneration: gameFeatures.meshGeneration === true,
      rigging: gameFeatures.rigging === true,
      gameExperts: gameFeatures.gameExperts === true,
      gameExpertEngine: isProjectGameExpertEngine(gameFeatures.gameExpertEngine)
        ? gameFeatures.gameExpertEngine
        : defaults.gameFeatures.gameExpertEngine,
    },
    automation: {
      autoDetect: automation.autoDetect !== false,
      autoConfigureRecommendedMcp:
        automation.autoConfigureRecommendedMcp === true,
      autoStartMcp: automation.autoStartMcp === true,
      allowThirdPartyInstall: automation.allowThirdPartyInstall === true,
    },
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined,
  };
}

export function projectSettingsPatch(
  settings: ProjectSettings,
): HistoryMetadata {
  return {
    [PROJECT_SETTINGS_METADATA_KEY]: {
      ...settings,
      updatedAt: new Date().toISOString(),
    },
  };
}

export function serverFromSuggestion(
  suggestion: ProjectMcpServerSuggestion,
): ProjectMcpServerConfig {
  return {
    id: suggestion.id,
    label: suggestion.label,
    description: suggestion.description,
    source: 'suggested',
    enabled: true,
    transport: suggestion.transport,
    command: suggestion.command,
    args: suggestion.args,
    env: suggestion.env,
    requiresUserApproval: suggestion.requiresUserApproval,
  };
}

function compactId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function mcpServerSearchText(server: ProjectMcpServerConfig): string {
  return [
    server.id,
    server.label,
    server.description ?? '',
    server.command ?? '',
    server.args.join(' '),
    Object.entries(server.env)
      .map(([key, value]) => `${key}=${value}`)
      .join(' '),
  ]
    .join(' ')
    .toLowerCase();
}

export function isConflictingUnrealMcpServer(
  server: ProjectMcpServerConfig,
): boolean {
  if (server.id === PREFERRED_UNREAL_MCP_SERVER_ID) return false;

  const id = compactId(server.id);
  if (
    new Set([
      'ue',
      'uemcp',
      'unreal',
      'unrealmcp',
      'unrealengine',
      'unrealenginemcp',
      'ue5mcp',
      'ue4mcp',
    ]).has(id)
  ) {
    return true;
  }

  const text = mcpServerSearchText(server);
  const looksLikeUnrealMcp =
    (text.includes('unreal') && text.includes('mcp')) ||
    /\bue[-_\s]?mcp\b/.test(text);
  const controlsEditor =
    text.includes('remotecontrol') ||
    text.includes('editor') ||
    text.includes('python') ||
    text.includes('blueprint') ||
    text.includes('uproject') ||
    text.includes('unrealengine');

  return looksLikeUnrealMcp && controlsEditor;
}

export function preferUnrealMcpServer(
  settings: ProjectSettings,
  preferred: ProjectMcpServerConfig,
): ProjectSettings {
  const preferredServer = {
    ...preferred,
    id: PREFERRED_UNREAL_MCP_SERVER_ID,
    enabled: true,
  };
  let mergedPreferred: ProjectMcpServerConfig | null = null;
  const others: ProjectMcpServerConfig[] = [];

  for (const server of settings.mcp.servers) {
    if (server.id === PREFERRED_UNREAL_MCP_SERVER_ID) {
      mergedPreferred = { ...server, ...preferredServer };
      continue;
    }
    others.push(
      isConflictingUnrealMcpServer(server) ? { ...server, enabled: false } : server,
    );
  }

  return {
    ...settings,
    engine: 'unreal',
    mcp: {
      ...settings.mcp,
      enabled: true,
      servers: [mergedPreferred ?? preferredServer, ...others],
    },
  };
}

export function mergeRecommendedMcpServers(
  settings: ProjectSettings,
  scan: ProjectEnvironmentScan,
): ProjectSettings {
  const preferredUnrealSuggestion = scan.suggestedMcpServers.find(
    (server) => server.id === PREFERRED_UNREAL_MCP_SERVER_ID,
  );
  if (scan.engine.engine === 'unreal' && preferredUnrealSuggestion) {
    return settingsWithDetectedGameFeatures(
      preferUnrealMcpServer(settings, serverFromSuggestion(preferredUnrealSuggestion)),
      scan,
    );
  }

  const existingIds = new Set(settings.mcp.servers.map((server) => server.id));
  const additions = scan.suggestedMcpServers
    .filter((server) => !existingIds.has(server.id))
    .map(serverFromSuggestion);
  const next = {
    ...settings,
    engine: scan.engine.engine,
    mcp: {
      ...settings.mcp,
      enabled: true,
      servers: [...settings.mcp.servers, ...additions],
    },
  };
  return settingsWithDetectedGameFeatures(next, scan);
}

export function settingsWithDetectedGameFeatures(
  settings: ProjectSettings,
  scan: Pick<ProjectEnvironmentScan, 'engine'>,
): ProjectSettings {
  if (!settings.automation.autoDetect) return settings;
  return {
    ...settings,
    engine: scan.engine.engine,
    gameFeatures: gameFeatureDefaultsForEngine(scan.engine.engine),
  };
}

export function projectEngineLabel(engine: ProjectEngineKind | 'auto'): string {
  switch (engine) {
    case 'unreal':
      return 'Unreal Engine';
    case 'unity':
      return 'Unity';
    case 'godot':
      return 'Godot';
    case 'unknown':
      return '未识别';
    default:
      return '自动';
  }
}

export function projectHealth(
  workspace: WorkspaceSummary,
  scan?: ProjectEnvironmentScan | null,
): ProjectHealth {
  const settings = projectSettingsFromMetadata(workspace.metadata);
  const enabledServers = settings.mcp.enabled
    ? settings.mcp.servers.filter((server) => server.enabled)
    : [];
  const connected = enabledServers.find((server) => server.lastProbe?.ok);
  if (connected) {
    return {
      tone: 'connected',
      label: 'MCP 已连接',
      detail: `${connected.label}：${connected.lastProbe?.message ?? ''}`,
    };
  }
  const failed = enabledServers.find((server) => server.lastProbe && !server.lastProbe.ok);
  if (failed) {
    return {
      tone: 'failed',
      label: 'MCP 失败',
      detail: `${failed.label}：${failed.lastProbe?.message ?? ''}`,
    };
  }
  if (enabledServers.length > 0) {
    return {
      tone: 'configured',
      label: 'MCP 已配置',
      detail: `${enabledServers.length} 个项目 MCP server 待探测`,
    };
  }
  if (scan?.engine.engine && scan.engine.engine !== 'unknown') {
    return {
      tone: 'detected',
      label: `检测到 ${scan.engine.label}`,
      detail: '可在项目设置里应用推荐 MCP 配置',
    };
  }
  return {
    tone: 'none',
    label: '无项目 MCP',
    detail: '未识别 UE / Unity / Godot 项目',
  };
}
