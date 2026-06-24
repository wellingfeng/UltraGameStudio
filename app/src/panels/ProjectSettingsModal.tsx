import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';
import {
  Box,
  Boxes,
  Check,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Gamepad2,
  Info,
  Languages,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  Server,
  Settings as SettingsIcon,
  SlidersHorizontal,
  Terminal,
  Trash2,
  TriangleAlert,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import RemoteWorkspaceDialog from '@/components/RemoteWorkspaceDialog';
import { cn } from '@/lib/cn';
import { basename, pickFolder } from '@/lib/folderPicker';
import {
  getRemoteWorkspace,
  getRemoteWorkspaceEnvironment,
  installRemoteWorkspaceEnvironment,
  isRemoteWorkspacePath,
  remoteWorkspaceIdFromPath,
  type RemoteEnvironmentInstallResult,
  type RemoteEnvironmentReport,
  type RemoteEnvironmentToolId,
  type RemoteWorkspaceConfig,
} from '@/lib/remoteWorkspace';
import { uniqueWorkspaceHistory, workspacePathKey } from '@/lib/workspaceHistory';
import {
  dedupeFolders,
  mergeRecommendedMcpServers,
  projectEngineLabel,
  projectHealth,
  projectSettingsFromMetadata,
  projectSettingsPatch,
  preferUnrealMcpServer,
  settingsWithDetectedGameFeatures,
  type ProjectLspServerConfig,
  type ProjectMcpServerConfig,
  type ProjectSettings,
} from '@/lib/projectSettings';
import {
  fallbackLanguageScanForEngine,
  installCommandText,
  lspServerById,
  PROJECT_LANGUAGE_LABELS,
  rankLspServers,
  recommendedLspServerIds,
  shouldSkipLanguageScanDirectory,
  detectProjectLanguagesFromPaths,
  type LspServerDefinition,
  type ProjectLanguageScan,
  type RankedLspServerDefinition,
} from '@/lib/lspCatalog';
import {
  slashText,
} from '@/lib/slashCommands';
import {
  mcpCategoryLabel,
  loadOnlineMcpCatalogServers,
  mcpCommandText,
  rankMcpServers,
  type McpServerDefinition,
  type RankedMcpServerDefinition,
} from '@/lib/mcpCatalog';
import {
  COCOS_MCP_SERVER_ID,
  GODOT_MCP_SERVER_ID,
  blueprintModeInstall,
  blueprintModeStatus,
  blueprintModeUninstall,
  listWorkspaceDirectory,
  cocosMcpSetupProject,
  godotMcpSetupProject,
  installProjectLspServer,
  openExternal,
  openLocalPath,
  probeProjectLspServer,
  probeProjectMcpServer,
  scanProjectEnvironment,
  unityMcpSetupProject,
  ueMcpEnsureBinary,
  ueMcpSetupProject,
  tauriAvailable,
  UNITY_MCP_SERVER_ID,
  UE_MCP_SERVER_ID,
  skillInstallTargets,
  slashCatalog,
  onSlashCatalogUpdated,
  type ProjectEnvironmentScan,
  type ProjectLspInstallResult,
  type ProjectLspProbeResult,
  type ProjectMcpProbeResult,
  type GenericProjectMcpSetupResult,
  type BlueprintModeInstallResult,
  type BlueprintModeStatusResult,
  type BlueprintModeUninstallResult,
  type SkillInstallTarget,
  type SlashCatalogEntry,
  type UnityMcpSetupResult,
  type UeMcpSetupResult,
} from '@/lib/tauri';
import { historyStore } from '@/store/history/store';
import type { WorkspaceRecord, WorkspaceSummary } from '@/store/history/types';
import { useStore } from '@/store/useStore';
import { PluginStorePanel } from '@/panels/PluginStorePanel';
import { type Locale } from '@/lib/i18n';

/**
 * ProjectSettingsModal predates the central i18n table, so its copy lives here
 * as a Chinese→English map. `tr(zh, locale)` returns the Chinese source for the
 * zh-CN locale and the English translation otherwise (mirroring the app-wide
 * convention where zh-CN and en-US are the two complete locales). Strings with
 * runtime interpolation are localized inline with `locale === 'zh-CN' ? … : …`.
 */
const PROJECT_SETTINGS_EN: Record<string, string> = {
  'API Key 搜索': 'API key search',
  'LSP 检测中...': 'Probing LSP…',
  'Mesh 渠道': 'Mesh channel',
  'UE MCP 配置失败。': 'UE MCP setup failed.',
  'Unity MCP 配置失败。': 'Unity MCP setup failed.',
  'UI 渠道': 'UI channel',
  'Unreal MCP (全版本)': 'Unreal MCP (all versions)',
  '安装': 'Install',
  '安装中': 'Installing',
  '安装中...': 'Installing…',
  '绑定渠道': 'Rigging channel',
  '蓝图': 'Blueprint',
  '抓帧/性能': 'Capture / performance',
  '保存': 'Save',
  '保存中...': 'Saving…',
  '本地开源': 'Local / open source',
  '必须重启 Unreal Editor': 'Unreal Editor must be restarted',
  '参数': 'Args',
  '仓库': 'Registry',
  '插件或 RemoteControl / Python 权限配置已写入；如果 Unreal Editor 已经打开，请重启后生效，未打开则下次启动自动生效。':
    'Plugin or RemoteControl / Python permission settings were written. If Unreal Editor is already open, restart it to apply; otherwise it takes effect on next launch.',
  '成功': 'Success',
  '从项目中移除该文件夹': 'Remove this folder from the project',
  '打开官网': 'Open website',
  '打开来源': 'Open source',
  '待配置': 'Needs setup',
  '待配置路径': 'Needs path',
  '待填 Key': 'Needs key',
  '附加': 'Additional',
  '复制地址': 'Copy address',
  '复制命令名': 'Copy command name',
  'LSP 暂不支持自动安装': 'this LSP does not support auto-install yet',
  '该 LSP 暂不支持自动安装': 'This LSP does not support auto-install yet',
  '该文件夹已在项目中': 'That folder is already in the project',
  '概览': 'Overview',
  '远程环境': 'Remote environment',
  '关闭': 'Close',
  '官方': 'Official',
  '获取 Key': 'Get key',
  '检测已启用 LSP': 'Probe enabled LSPs',
  '检测中': 'Probing',
  '检测中...': 'Probing…',
  '精选': 'Curated',
  '开启': 'On',
  '开启后，当前项目的游戏 UI 设计任务会优先使用这里选择的默认渠道。':
    'When enabled, this project’s game UI design tasks prefer the default channel selected here.',
  '开启后，输入 /sprite-mode-start 或 /sprite 会复用当前生图渠道。':
    'When enabled, /sprite-mode-start or /sprite reuses the current image channel.',
  '开启后，输入 /sprite-mode-start 或 /sprite 会按下方参数生成可规范化的 raw sheet，并为后处理与验收准备输入。':
    'When enabled, /sprite-mode-start or /sprite generates a normalizable raw sheet with the parameters below and prepares input for postprocess and acceptance checks.',
  '可用': 'Available',
  '空格分隔；按 LSP stdio 启动参数填写':
    'Space-separated; follow the LSP stdio launch arguments',
  '空格分隔；工作区可用 {workspace}':
    'Space-separated; {workspace} is available',
  '控制当前项目是否启用 3D 模型生成入口。':
    'Controls whether this project enables the 3D model generation entry point.',
  '控制当前项目是否启用游戏专家，并在游戏项目中自动选择对应引擎。':
    'Controls whether this project enables Game Experts and auto-selects the matching engine for game projects.',
  '控制当前项目是否启用抓帧、GPU/CPU Trace 和 Android 性能分析 Skill。':
    'Controls whether this project enables frame capture, GPU/CPU trace, and Android performance analysis Skills.',
  '控制当前项目是否启用自动绑骨流程。':
    'Controls whether this project enables the auto-rigging workflow.',
  '控制当前项目是否允许自动启动/使用已启用的 LSP 配置。':
    'Controls whether this project may auto-start / use the enabled LSP configuration.',
  '没有可检测的 LSP': 'No LSP to probe',
  '没有可探测的 MCP server': 'No MCP server to probe',
  '没有可应用的 LSP 推荐': 'No LSP recommendations to apply',
  '免费 API': 'Free API',
  '免费和开源优先，适合 Pencil 原型、Penpot 自托管协作、GIMP/Inkscape 图形资产。':
    'Free and open-source first — good for Pencil prototypes, self-hosted Penpot collaboration, and GIMP/Inkscape assets.',
  '免费开源渠道': 'Free / open-source channels',
  '命令': 'Commands',
  '命令可用': 'Command available',
  '命令已可用，无需安装': 'Command already available, no install needed',
  '在线模型库': 'Online model library',
  '复用生图渠道': 'Reuse image channel',
  '默认 UI 渠道': 'Default UI channel',
  '配置已同步': 'Settings synced',
  '配置中...': 'Configuring…',
  '启用': 'Enable',
  '启用 Mesh 渠道': 'Enable Mesh channel',
  '启用 Sprite 入口': 'Enable Sprite entry',
  '启用 Sprite 模式': 'Enable Sprite mode',
  '启用 UI 渠道': 'Enable UI channel',
  '启用绑定渠道': 'Enable rigging channel',
  '启用抓帧/性能': 'Enable capture / performance',
  '启用项目 LSP': 'Enable project LSP',
  '启用项目 MCP': 'Enable project MCP',
  '启用游戏专家': 'Enable Game Experts',
  '清空': 'Clear',
  '请重启 Unreal Editor 后再连接。': 'Restart Unreal Editor before connecting.',
  '权限/自动化': 'Permissions / automation',
  '全局': 'Global',
  '如 Unreal Editor 已经打开，请重启后生效。':
    'If Unreal Editor is already open, restart it to apply.',
  '商用': 'Commercial',
  '商用渠道': 'Commercial channels',
  '尚未识别编程语言': 'No programming language detected yet',
  '社区': 'Community',
  '涉及 npm、uvx、插件安装时仍需确认。':
    'Still asks for confirmation for npm, uvx, and plugin installs.',
  '深链搜索页': 'Deep-link search page',
  '生产协作优先，适合 Figma 文件、Photoshop 视觉资产和可交付 UI 规范。':
    'Production collaboration first — good for Figma files, Photoshop visual assets, and deliverable UI specs.',
  '失败': 'Failed',
  '手动设置': 'Manual',
  '搜索 MCP 名称、用途、命令、URL 或分类...':
    'Search MCP name, purpose, command, URL, or category…',
  '搜索命令或用途...': 'Search command or purpose…',
  '搜索在线模型库名称、用途...': 'Search online model library name or purpose…',
  '搜索语言、LSP、命令或安装方式...':
    'Search language, LSP, command, or install method…',
  '探测已启用 MCP': 'Probe enabled MCP',
  '探测中...': 'Probing…',
  '填写环境变量值': 'Enter environment variable value',
  '推荐 MCP 配置已应用': 'Recommended MCP configuration applied',
  '未创建': 'Not created',
  '未识别': 'Unrecognized',
  '未探测': 'Not probed',
  '未找到': 'Not found',
  '未指定': 'Not set',
  '未指定工作区': 'No workspace set',
  '未指定工作区路径。': 'No workspace path specified.',
  '无': 'None',
  '显示 Key': 'Show key',
  '项目': 'Project',
  '卸载': 'Uninstall',
  '需 API Key': 'Needs API key',
  '选择要加入项目的文件夹': 'Choose a folder to add to the project',
  '一键安装': 'One-click install',
  '一键安装并配置': 'One-click install & configure',
  '一键安装并启用': 'One-click install & enable',
  '一键安装需要在桌面应用中运行。':
    'One-click install must run in the desktop app.',
  '已安装': 'Installed',
  '已保存': 'Saved',
  '已复制': 'Copied',
  '已检测到 Unreal Editor 正在运行或启动中；插件或 RemoteControl / Python 权限配置已变更，必须重启 Unreal Editor 后生效。':
    'Unreal Editor is running or starting; plugin or RemoteControl / Python permission settings changed and require an Unreal Editor restart to apply.',
  '已连接': 'Connected',
  '已配置': 'Configured',
  '已配置 Key': 'Key configured',
  '已启用': 'Enabled',
  '已添加项目文件夹': 'Project folder added',
  '已移除项目文件夹': 'Project folder removed',
  '隐藏 Key': 'Hide key',
  '游戏项目自动开启': 'Auto-enabled for game projects',
  '游戏专家': 'Game Experts',
  '游戏专家引擎': 'Game Experts engine',
  '有未保存修改': 'Unsaved changes',
  '允许第三方依赖安装': 'Allow third-party dependency installs',
  '允许自动启动项目 MCP': 'Allow auto-starting project MCP',
  '在文件管理器中显示': 'Reveal in file manager',
  '粘贴 API Key / Token': 'Paste API key / token',
  'Sprite 生成不单独选择渠道；/sprite-mode-start 会复用设置 > 生图渠道中的默认 Provider。':
    'Sprite generation does not choose a separate channel; /sprite-mode-start reuses the default provider from Settings > Images.',
  '这个项目在进行游戏 UI 设计时优先使用的设计工具或协作平台。/ui-mode-start 会使用这里选择的默认渠道；商用与免费开源共用一个默认。':
    'The design tool or collaboration platform this project prefers for game UI design. /ui-mode-start uses the default selected here; commercial and free/open-source share one default.',
  '正在配置工程（启用插件 / 写入 RemoteControl 与 .mcp.json）...':
    'Configuring project (enabling plugins / writing RemoteControl & .mcp.json)…',
  '正在配置 Unity 工程（写入 Packages/manifest.json 与 .mcp.json）...':
    'Configuring Unity project (writing Packages/manifest.json and .mcp.json)…',
  '正在探测 MCP 连接...': 'Probing MCP connection…',
  '正在下载并校验 UE MCP 二进制...': 'Downloading and verifying UE MCP binary…',
  '只写项目配置，不安装第三方依赖。':
    'Only writes project config; does not install third-party dependencies.',
  '重新检测': 'Re-scan',
  '主目录': 'Primary',
  '自定义 MCP': 'Custom MCP',
  '自动检测': 'Auto-detect',
  '自动检测开启时会跟随项目类型；非游戏项目使用自动。':
    'When auto-detect is on it follows the project type; non-game projects use Auto.',
  '自动检测项目类型': 'Auto-detect project type',
  '自动写入推荐 MCP 配置': 'Auto-write recommended MCP config',
};

function tr(zh: string, locale: Locale): string {
  if (locale === 'zh-CN') return zh;
  return PROJECT_SETTINGS_EN[zh] ?? zh;
}
import { GAME_SKILL_RECOMMENDATION_SOURCE_ID } from '@/lib/pluginStore';
import {
  cachedPluginDescriptionTranslation,
  shouldTranslatePluginDescription,
  translatePluginDescriptionCached,
} from '@/lib/pluginStoreTranslation';
type ProjectSettingsTab =
  | 'overview'
  | 'environment'
  | 'blueprint'
  | 'mcp'
  | 'lsp'
  | 'skills'
  | 'automation';

const tabs: { id: ProjectSettingsTab; label: string; Icon: LucideIcon }[] = [
  { id: 'overview', label: '概览', Icon: Info },
  { id: 'environment', label: '远程环境', Icon: Server },
  { id: 'blueprint', label: '蓝图', Icon: FileText },
  { id: 'automation', label: '权限/自动化', Icon: SlidersHorizontal },
];

/**
 * Tabs that can be embedded standalone (without the project-settings modal
 * chrome) inside the global Settings modal. These render the exact same content
 * as the in-modal tabs — only the surrounding modal/nav/footer is dropped.
 */
export type ProjectEmbedTab = 'mcp' | 'lsp' | 'skills';

interface ProjectSettingsModalProps {
  workspace: WorkspaceSummary;
  onClose: () => void;
  onWorkspaceUpdated?: (workspace: WorkspaceSummary) => void;
  /**
   * When set, the component renders only this tab's content inline (no modal
   * dialog, header, nav, or footer). Used by the global Settings modal to host
   * the MCP / LSP / Skills tabs while reusing all the project-scoped state,
   * handlers, and lifecycle defined here.
   */
  embedTab?: ProjectEmbedTab;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function workspaceSummaryFromRecord(record: WorkspaceRecord): WorkspaceSummary {
  return {
    id: record.id,
    path: record.path,
    name: record.name,
    updatedAt: record.updatedAt,
    sessionCount: record.sessionCount,
    lastActiveSessionId: record.lastActiveSessionId,
    metadata: record.metadata,
  };
}

function formatTime(ms: number | null | undefined, locale: Locale): string {
  if (!ms) return tr('未探测', locale);
  return new Date(ms).toLocaleString(locale, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function fieldId(prefix: string, id: string): string {
  return `${prefix}-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

const PROJECT_SETTINGS_SCAN_CACHE_TTL_MS = 5 * 60 * 1000;
const PROJECT_SETTINGS_LANGUAGE_SCAN_BUDGET_MS = 900;

type ProjectSettingsScanCacheEntry<T> = {
  value: T;
  cachedAtMs: number;
};

const projectEnvironmentScanCache = new Map<
  string,
  ProjectSettingsScanCacheEntry<ProjectEnvironmentScan>
>();
const projectLanguageScanCache = new Map<
  string,
  ProjectSettingsScanCacheEntry<ProjectLanguageScan>
>();

function projectSettingsCacheEnabled(): boolean {
  return import.meta.env.MODE !== 'test' && tauriAvailable();
}

function projectSettingsScanCacheKey(rootPath: string): string {
  return workspacePathKey(rootPath.trim());
}

function readProjectSettingsScanCache<T>(
  cache: Map<string, ProjectSettingsScanCacheEntry<T>>,
  key: string,
): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAtMs > PROJECT_SETTINGS_SCAN_CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function writeProjectSettingsScanCache<T>(
  cache: Map<string, ProjectSettingsScanCacheEntry<T>>,
  key: string,
  value: T,
): void {
  cache.set(key, { value, cachedAtMs: Date.now() });
}

async function scanWorkspaceLanguages(
  rootPath: string,
  scan: ProjectEnvironmentScan | null,
): Promise<ProjectLanguageScan> {
  const queue: Array<{ relativePath: string; depth: number }> = [
    { relativePath: '', depth: 0 },
  ];
  const paths: string[] = [];
  let directoriesScanned = 0;
  let truncated = false;
  const maxDirectories = 180;
  const maxFiles = 6000;
  const maxDepth = 7;
  const startedAtMs = Date.now();

  while (queue.length > 0) {
    if (
      directoriesScanned >= maxDirectories ||
      paths.length >= maxFiles ||
      Date.now() - startedAtMs >= PROJECT_SETTINGS_LANGUAGE_SCAN_BUDGET_MS
    ) {
      truncated = true;
      break;
    }
    const current = queue.shift()!;
    directoriesScanned += 1;
    const listing = await listWorkspaceDirectory(rootPath, current.relativePath);
    truncated ||= listing.truncated;
    for (const entry of listing.entries) {
      if (entry.kind === 'file') {
        paths.push(entry.relativePath || entry.name);
        if (paths.length >= maxFiles) {
          truncated = true;
          break;
        }
        continue;
      }
      if (entry.kind !== 'directory' || current.depth >= maxDepth) continue;
      if (shouldSkipLanguageScanDirectory(entry.name)) continue;
      queue.push({
        relativePath: entry.relativePath,
        depth: current.depth + 1,
      });
    }
  }

  return {
    scannedAtMs: Date.now(),
    languages: detectProjectLanguagesFromPaths(paths, scan?.engine.engine),
    filesScanned: paths.length,
    directoriesScanned,
    truncated,
    source: 'workspace',
  };
}

function SettingsRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="text-xs font-semibold text-fg">{label}</span>
      {children}
      {hint ? <span className="text-[11px] text-fg-faint">{hint}</span> : null}
    </label>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-start justify-between gap-4 rounded-md border border-border-soft bg-bg-alt px-3 py-2.5">
      <span className="min-w-0">
        <span className="block text-xs font-semibold text-fg">{label}</span>
        {hint ? <span className="mt-1 block text-[11px] text-fg-faint">{hint}</span> : null}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
      />
    </label>
  );
}

type ProjectSubTabId = 'installed' | 'registry';

function projectSubTabLabel(id: ProjectSubTabId, locale: Locale): string {
  return id === 'installed' ? tr('已安装', locale) : tr('仓库', locale);
}

/** Append a skill folder name to its root path, picking the right separator. */
function joinSkillPath(root: string, skill: string): string {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  const trimmed = root.replace(/[\\/]+$/, '');
  return `${trimmed}${sep}${skill}`;
}

function projectSkillEmptyText(label: string, locale: Locale): string {
  const family = label.replace(/\s*项目\s*Skill\s*$/, '').trim() || label;
  return locale === 'zh-CN'
    ? `项目中 ${family} Skill 数目是 0`
    : `This project has 0 ${family} Skills`;
}

/**
 * Auto-translating description for an installed skill. Mirrors the plugin store
 * card behaviour: cached translation shown immediately, async refresh on view.
 */
function useTranslatedSkillDescription(
  id: string,
  description: string,
  locale: Locale,
): string {
  const shouldTranslate = shouldTranslatePluginDescription(description, locale);
  const [text, setText] = useState(() => {
    if (!shouldTranslate) return description;
    return cachedPluginDescriptionTranslation(id, description, locale) ?? description;
  });

  useEffect(() => {
    if (!shouldTranslate) {
      setText(description);
      return;
    }
    setText(
      cachedPluginDescriptionTranslation(id, description, locale) ?? description,
    );
    let active = true;
    void translatePluginDescriptionCached(id, description, locale).then(
      (translated) => {
        if (active) setText(translated);
      },
    );
    return () => {
      active = false;
    };
  }, [id, description, locale, shouldTranslate]);

  return text;
}

/**
 * Single installed-skill card. Matches the MCP / LSP card layout so the Skills
 * tab reads the same way: slash name, scope badge, translated summary, path.
 */
function InstalledSkillCard({
  name,
  scope,
  enabled,
  description,
  path,
  locale,
}: {
  name: string;
  scope: 'project' | 'global';
  enabled: boolean;
  description: string;
  path: string;
  locale: Locale;
}) {
  const translated = useTranslatedSkillDescription(
    `skill-card:${scope}:${name}`,
    description,
    locale,
  );
  const scopeLabel =
    scope === 'project' ? tr('项目', locale) : tr('全局', locale);
  const scopeClass =
    scope === 'project'
      ? 'border-sky-500/40 bg-sky-500/10 text-sky-300'
      : 'border-violet-500/40 bg-violet-500/10 text-violet-300';

  return (
    <div
      className={cn(
        'flex min-h-[6.5rem] flex-col gap-2 rounded-md border border-border bg-bg-alt p-3',
        !enabled && 'opacity-60',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Zap size={13} className="shrink-0 text-[var(--accent-3)]" />
        <code className="truncate font-mono text-sm font-semibold text-accent">
          /{name}
        </code>
        <span
          className={cn(
            'ml-auto shrink-0 rounded border px-1.5 py-0.5 text-[10px]',
            scopeClass,
          )}
        >
          {scopeLabel}
        </span>
      </div>
      {translated.trim() ? (
        <p className="line-clamp-3 text-xs leading-relaxed text-fg-dim">
          {translated}
        </p>
      ) : null}
      <div
        className="mt-auto truncate font-mono text-[10px] text-fg-faint"
        title={path}
      >
        {path}
      </div>
    </div>
  );
}

/**
 * Shared underline-style sub-tab bar used by the MCP / LSP / Skills panels so
 * every project capability page looks and reads the same way.
 */
function ProjectSubTabBar({
  active,
  onChange,
  installedCount,
  registryCount,
}: {
  active: ProjectSubTabId;
  onChange: (id: ProjectSubTabId) => void;
  installedCount: number;
  registryCount?: number;
}) {
  const locale = useStore((s) => s.locale);
  const items: { id: ProjectSubTabId; count?: number }[] = [
    { id: 'installed', count: installedCount },
    { id: 'registry', count: registryCount },
  ];
  return (
    <div className="flex items-center gap-1 border-b border-border">
      {items.map((item) => {
        const isActive = active === item.id;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onChange(item.id)}
            className={cn(
              'px-4 py-2 text-xs font-medium transition-colors',
              isActive
                ? '-mb-px border-b-2 border-accent text-fg'
                : 'text-fg-faint hover:text-fg',
            )}
          >
            {projectSubTabLabel(item.id, locale)}
            {typeof item.count === 'number' ? (
              <span
                className={cn(
                  'ml-1.5 rounded-full px-1.5 py-0.5 text-[10px]',
                  isActive ? 'bg-accent/20 text-accent' : 'bg-bg-alt text-fg-faint',
                )}
              >
                {item.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function ProbeBadge({ result }: { result?: ProjectMcpProbeResult }) {
  const locale = useStore((s) => s.locale);
  if (!result) {
    return (
      <span className="rounded border border-border-soft bg-bg-alt px-2 py-0.5 text-[11px] text-fg-faint">
        {tr('未探测', locale)}
      </span>
    );
  }
  return (
    <span
      className={cn(
        'rounded border px-2 py-0.5 text-[11px]',
        result.ok
          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
          : 'border-red-500/40 bg-red-500/10 text-red-300',
      )}
      title={result.message}
    >
      {result.ok ? tr('已连接', locale) : tr('失败', locale)}
    </span>
  );
}

function LspProbeBadge({ result }: { result?: ProjectLspProbeResult }) {
  const locale = useStore((s) => s.locale);
  if (!result) {
    return (
      <span className="rounded border border-border-soft bg-bg-alt px-2 py-0.5 text-[11px] text-fg-faint">
        {tr('未检测', locale)}
      </span>
    );
  }
  return (
    <span
      className={cn(
        'rounded border px-2 py-0.5 text-[11px]',
        result.ok
          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
          : 'border-red-500/40 bg-red-500/10 text-red-300',
      )}
      title={result.message}
    >
      {result.ok ? tr('命令可用', locale) : tr('未找到', locale)}
    </span>
  );
}

function McpTrustBadge({ trust }: { trust: McpServerDefinition['trust'] }) {
  const locale = useStore((s) => s.locale);
  return (
    <span className="shrink-0 rounded border border-border-soft bg-bg-alt px-1.5 py-0.5 text-[10px] text-fg-faint">
      {trust === 'official'
        ? tr('官方', locale)
        : trust === 'curated'
          ? tr('精选', locale)
          : trust === 'registry'
            ? 'Registry'
            : tr('社区', locale)}
    </span>
  );
}

function McpRegistryView({
  servers,
  query,
  onQueryChange,
  configuredIds,
  loading,
  error,
  onRefresh,
  onInstall,
  onUninstall,
}: {
  servers: RankedMcpServerDefinition[];
  query: string;
  onQueryChange: (value: string) => void;
  configuredIds: Set<string>;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onInstall: (definition: McpServerDefinition) => void;
  onUninstall: (id: string) => void;
}) {
  const locale = useStore((s) => s.locale);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyConnection = async (server: McpServerDefinition, text: string) => {
    await navigator.clipboard?.writeText(text);
    setCopiedId(server.id);
    window.setTimeout(() => {
      setCopiedId((current) => (current === server.id ? null : current));
    }, 1500);
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[16rem] flex-1">
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-faint"
          />
          <input
            type="text"
            value={query}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
            placeholder={tr('搜索 MCP 名称、用途、命令、URL 或分类...', locale)}
            className="w-full rounded-lg border border-border bg-bg-alt py-2 pl-9 pr-3 text-sm text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none"
          />
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-bg-alt px-3 py-2 text-xs text-fg-dim hover:border-accent hover:text-fg disabled:cursor-wait disabled:opacity-60"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          {locale === 'zh-CN' ? '刷新在线 MCP' : 'Refresh online MCP'}
        </button>
      </div>

      {error ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-100">
          {locale === 'zh-CN'
            ? `在线 MCP 仓库加载失败：${error}`
            : `Failed to load online MCP catalog: ${error}`}
        </div>
      ) : null}

      {loading ? (
        <div className="rounded-lg border border-border-soft bg-bg-alt px-3 py-2 text-[11px] text-fg-faint">
          {locale === 'zh-CN'
            ? '正在加载在线 MCP 仓库...'
            : 'Loading online MCP catalog…'}
        </div>
      ) : null}

      {servers.length === 0 ? (
        <p className="rounded-lg border border-border bg-bg-alt px-4 py-6 text-center text-xs text-fg-faint">
          {locale === 'zh-CN' ? '没有匹配的 MCP。' : 'No matching MCP.'}
        </p>
      ) : (
        <div className="grid gap-2.5 lg:grid-cols-2 2xl:grid-cols-3">
          {servers.map((server) => {
            const installed = configuredIds.has(server.id);
            const installable =
              server.installable !== false &&
              ((server.transport === 'stdio' && server.command.trim().length > 0) ||
                (server.transport !== 'stdio' && (server.url ?? '').trim().length > 0));
            const connectionText = installable
              ? mcpCommandText(server)
              : server.connectionUrl ?? server.url ?? server.sourceUrl;
            const hasRemoteUrl = !installable && Boolean(server.url?.trim());
            const copied = copiedId === server.id;
            return (
              <section
                key={server.id}
                className="flex min-h-[190px] flex-col gap-2.5 rounded-md border border-border bg-panel-2 p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-sm font-semibold text-fg">
                        {server.title}
                      </span>
                      <McpTrustBadge trust={server.trust} />
                    </div>
                    <span className="mt-1 block max-h-12 overflow-hidden text-xs leading-snug text-fg-faint">
                      {server.description}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void openExternal(server.sourceUrl)}
                    title={tr('打开来源', locale)}
                    aria-label={tr('打开来源', locale)}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border-soft bg-bg-alt text-fg-faint hover:border-accent hover:text-fg"
                  >
                    <ExternalLink size={13} />
                  </button>
                </div>

                <div className="flex flex-wrap gap-1">
                  <span className="rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">
                    {mcpCategoryLabel(server.category, locale)}
                  </span>
                  {!installable ? (
                    <span className="rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-300">
                      {hasRemoteUrl
                        ? locale === 'zh-CN'
                          ? `远程 ${server.transport}`
                          : `Remote ${server.transport}`
                        : locale === 'zh-CN'
                          ? '索引条目'
                          : 'Index entry'}
                    </span>
                  ) : null}
                  {server.version ? (
                    <span className="rounded border border-border-soft bg-bg-alt px-1.5 py-0.5 text-[10px] text-fg-faint">
                      v{server.version}
                    </span>
                  ) : null}
                  {requiredEnv(server).map((spec) => (
                    <span
                      key={spec.key}
                      className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300"
                      title={
                        locale === 'zh-CN'
                          ? `需要配置 ${spec.label}`
                          : `Requires ${spec.label}`
                      }
                    >
                      {locale === 'zh-CN' ? `需 ${spec.label}` : `Needs ${spec.label}`}
                    </span>
                  ))}
                </div>

                <div className="mt-auto grid gap-2">
                  <div
                    className="truncate rounded border border-border-soft bg-bg-alt px-2 py-1 font-mono text-[11px] text-fg-dim"
                    title={connectionText}
                  >
                    {connectionText}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {installed ? (
                      <>
                        <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[11px] font-semibold text-emerald-300">
                          <Check size={12} />
                          {tr('已安装', locale)}
                        </span>
                        <button
                          type="button"
                          onClick={() => onUninstall(server.id)}
                          className="inline-flex items-center gap-1 rounded-md border border-border bg-bg-alt px-2 py-1 text-[11px] text-fg-dim hover:border-red-400 hover:text-red-300"
                        >
                          <Trash2 size={12} />
                          {tr('卸载', locale)}
                        </button>
                      </>
                    ) : installable ? (
                      <button
                        type="button"
                        onClick={() => onInstall(server)}
                        className="inline-flex items-center gap-1 rounded-md border border-accent/60 bg-accent/10 px-2 py-1 text-[11px] font-semibold text-fg hover:bg-accent/20"
                      >
                        <Download size={12} />
                        {tr('安装', locale)}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void copyConnection(server, connectionText)}
                        className="inline-flex items-center gap-1 rounded-md border border-accent/60 bg-accent/10 px-2 py-1 text-[11px] font-semibold text-fg hover:bg-accent/20"
                      >
                        {copied ? <Check size={12} /> : <Copy size={12} />}
                        {copied ? tr('已复制', locale) : tr('复制地址', locale)}
                      </button>
                    )}
                  </div>
                  <div className="text-[11px] leading-snug text-fg-faint">{server.install}</div>
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function requiredEnv(server: McpServerDefinition) {
  return server.requiredEnv ?? [];
}

const UNITY_MCP_COMMAND_PREVIEW =
  'uvx --from mcpforunityserver mcp-for-unity --transport stdio';
const UNITY_MCP_SOURCE_URL = 'https://github.com/wellingfeng/unity-mcp';
const UE_MCP_COMMAND_PREVIEW = 'ue-mcp-for-all-versions.exe';
const UE_MCP_SOURCE_URL = 'https://github.com/wellingfeng/ue-mcp-for-all-versions';

function GameMcpCommandSourceInfo({
  command,
  sourceUrl,
}: {
  command: string;
  sourceUrl: string;
}) {
  const locale = useStore((s) => s.locale);
  return (
    <div className="grid gap-2 text-[11px] text-fg-faint sm:grid-cols-2">
      <div className="rounded border border-border-soft bg-bg-alt px-3 py-2">
        <span className="text-fg-dim">{tr('命令', locale)}：</span>
        <code className="font-mono text-fg">{command}</code>
      </div>
      <div className="rounded border border-border-soft bg-bg-alt px-3 py-2">
        <span className="text-fg-dim">{locale === 'zh-CN' ? '来源：' : 'Source: '}</span>
        <button
          type="button"
          onClick={() => void openExternal(sourceUrl)}
          className="font-mono text-accent hover:underline"
        >
          {sourceUrl}
        </button>
      </div>
    </div>
  );
}

function UnrealMcpQuickSetup({
  busy,
  step,
  result,
  error,
  configured,
  current,
  onRun,
  onOpenFile,
}: {
  busy: boolean;
  step: string | null;
  result: UeMcpSetupResult | null;
  error: string | null;
  configured: boolean;
  current?: boolean;
  onRun: () => void;
  onOpenFile: (path: string) => void;
}) {
  const locale = useStore((s) => s.locale);
  const desktop = tauriAvailable();
  const restartNeeded = !!result?.ok && result.restartRequired === true;
  const ueConfigChanged =
    result?.changedFiles.some(
      (file) =>
        file.endsWith('.uproject') ||
        file.endsWith('Config/DefaultEngine.ini') ||
        file.endsWith('Config/DefaultRemoteControl.ini'),
    ) ?? false;
  const restartNotice = !!result?.ok && (restartNeeded || ueConfigChanged);
  const visibleWarnings =
    result?.warnings.filter(
      (warning) =>
        !restartNotice || !warning.includes('必须重启 Unreal Editor'),
    ) ?? [];
  return (
    <section
      className={cn(
        'grid gap-3 rounded-md border p-4',
        current
          ? 'border-accent/50 bg-accent/5'
          : 'border-border bg-panel-2',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-fg">
            <Rocket size={16} className="text-accent" />
            Unreal MCP
            {current ? (
              <span className="rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">
                {locale === 'zh-CN' ? '当前引擎' : 'Current engine'}
              </span>
            ) : null}
            {configured ? (
              <span className="rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-300">
                {tr('已配置', locale)}
              </span>
            ) : null}
          </div>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-fg-faint">
            {locale === 'zh-CN'
              ? '自动下载并校验版本无关的 Unreal MCP 服务（支持 UE 4.25–5.8），在 .uproject 中启用 RemoteControl / EditorScripting / Python 插件，写入 RemoteControl 自启动、远程 Python 执行和控制台命令权限，并合并项目 .mcp.json、登记到本项目的 MCP 列表。全程无需手动操作。'
              : 'Automatically downloads and verifies the version-agnostic Unreal MCP service (supports UE 4.25–5.8), enables the RemoteControl / EditorScripting / Python plugins in the .uproject, writes RemoteControl auto-start, remote Python execution, and console command permissions, then merges the project .mcp.json and registers it in this project’s MCP list. No manual steps required.'}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            type="button"
            onClick={() =>
              void openExternal('https://github.com/wellingfeng/ue-mcp-for-all-versions')
            }
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-bg-alt px-3 py-2 text-xs font-semibold text-fg-dim hover:border-accent hover:text-fg"
          >
            <ExternalLink size={14} />
            {tr('打开来源', locale)}
          </button>
          <button
            type="button"
            onClick={onRun}
            disabled={busy || !desktop}
            className="inline-flex items-center gap-1.5 rounded-md border border-accent bg-accent/20 px-3 py-2 text-xs font-semibold text-fg hover:bg-accent/30 disabled:opacity-50"
          >
            {busy ? (
              <RefreshCw size={14} className="animate-spin" />
            ) : (
              <Download size={14} />
            )}
            {busy ? tr('配置中...', locale) : tr('一键安装并配置', locale)}
          </button>
        </div>
      </div>

      {!desktop ? (
        <div className="rounded border border-border-soft bg-bg-alt px-3 py-2 text-[11px] text-fg-faint">
          {locale === 'zh-CN'
            ? '一键安装需要在桌面应用中运行（浏览器环境无法下载二进制或写入工程配置）。'
            : 'One-click install must run in the desktop app (a browser environment cannot download binaries or write project config).'}
        </div>
      ) : null}

      {busy && step ? (
        <div className="flex items-center gap-2 rounded border border-border-soft bg-bg-alt px-3 py-2 text-[11px] text-fg-dim">
          <RefreshCw size={12} className="animate-spin text-accent" />
          {step}
        </div>
      ) : null}

      {error ? (
        <div className="flex items-start gap-2 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </div>
      ) : null}

      {result?.ok ? (
        <div className="grid gap-2 rounded border border-emerald-500/30 bg-emerald-500/5 px-3 py-2.5 text-[11px] text-fg-dim">
          <div className="flex items-center gap-1.5 text-emerald-300">
            <Check size={13} />
            {locale === 'zh-CN' ? '配置完成' : 'Setup complete'}
            {result.engineAssociation
              ? locale === 'zh-CN'
                ? `（引擎 ${result.engineAssociation}）`
                : ` (engine ${result.engineAssociation})`
              : ''}
          </div>
          {result.configuredPlugins.length > 0 ? (
            <div>
              {locale === 'zh-CN' ? '已启用插件：' : 'Enabled plugins: '}
              <span className="text-fg">{result.configuredPlugins.join('、')}</span>
            </div>
          ) : null}
          {result.changedFiles.length > 0 ? (
            <div className="grid gap-1">
              <span>{locale === 'zh-CN' ? '已写入/更新：' : 'Written / updated:'}</span>
              <ul className="grid gap-0.5">
                {result.changedFiles.map((file) => (
                  <li key={file} className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => onOpenFile(file)}
                      title={tr('在文件管理器中显示', locale)}
                      className="truncate text-left font-mono text-accent hover:underline"
                    >
                      {file}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {restartNotice ? (
            <div className="mt-1 flex items-start gap-2 rounded border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-amber-300">
              <TriangleAlert size={13} className="mt-0.5 shrink-0" />
              <span>
                {restartNeeded
                  ? tr(
                      '已检测到 Unreal Editor 正在运行或启动中；插件或 RemoteControl / Python 权限配置已变更，必须重启 Unreal Editor 后生效。',
                      locale,
                    )
                  : tr(
                      '插件或 RemoteControl / Python 权限配置已写入；如果 Unreal Editor 已经打开，请重启后生效，未打开则下次启动自动生效。',
                      locale,
                    )}
                {locale === 'zh-CN'
                  ? 'MCP 服务支持懒连接，无需手动重启 CLI。'
                  : ' The MCP service supports lazy connection, so no manual CLI restart is needed.'}
              </span>
            </div>
          ) : null}
          {result.notes.length > 0 ? (
            <div className="text-fg-faint">
              {locale === 'zh-CN'
                ? `说明：${result.notes.join('；')}`
                : `Notes: ${result.notes.join('; ')}`}
            </div>
          ) : null}
          {visibleWarnings.length > 0 ? (
            <div className="text-amber-300/90">
              {locale === 'zh-CN'
                ? `提示：${visibleWarnings.join('；')}`
                : `Tips: ${visibleWarnings.join('; ')}`}
            </div>
          ) : null}
        </div>
      ) : null}
      <GameMcpCommandSourceInfo
        command={result?.serverCommand || result?.binaryPath || UE_MCP_COMMAND_PREVIEW}
        sourceUrl={UE_MCP_SOURCE_URL}
      />
    </section>
  );
}

function GenericGameMcpQuickSetup({
  title,
  description,
  command,
  sourceUrl,
  busy,
  step,
  result,
  error,
  configured,
  current,
  desktopRequired = true,
  onRun,
  onOpenFile,
}: {
  title: string;
  description: string;
  command: string;
  sourceUrl: string;
  busy: boolean;
  step: string | null;
  result: GenericProjectMcpSetupResult | null;
  error: string | null;
  configured: boolean;
  current?: boolean;
  desktopRequired?: boolean;
  onRun: () => void;
  onOpenFile: (path: string) => void;
}) {
  const locale = useStore((s) => s.locale);
  const desktop = tauriAvailable();
  return (
    <section
      className={cn(
        'grid gap-3 rounded-md border p-4',
        current
          ? 'border-accent/50 bg-accent/5'
          : 'border-border bg-panel-2',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-fg">
            <Rocket size={16} className="text-accent" />
            {title}
            {current ? (
              <span className="rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">
                {locale === 'zh-CN' ? '当前引擎' : 'Current engine'}
              </span>
            ) : null}
            {configured ? (
              <span className="rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-300">
                {tr('已配置', locale)}
              </span>
            ) : null}
          </div>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-fg-faint">
            {description}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void openExternal(sourceUrl)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-bg-alt px-3 py-2 text-xs font-semibold text-fg-dim hover:border-accent hover:text-fg"
          >
            <ExternalLink size={14} />
            {tr('打开来源', locale)}
          </button>
          <button
            type="button"
            onClick={onRun}
            disabled={busy || (desktopRequired && !desktop)}
            className="inline-flex items-center gap-1.5 rounded-md border border-accent bg-accent/20 px-3 py-2 text-xs font-semibold text-fg hover:bg-accent/30 disabled:opacity-50"
          >
            {busy ? (
              <RefreshCw size={14} className="animate-spin" />
            ) : (
              <Download size={14} />
            )}
            {busy ? tr('配置中...', locale) : tr('一键安装并配置', locale)}
          </button>
        </div>
      </div>
      {desktopRequired && !desktop ? (
        <div className="rounded border border-border-soft bg-bg-alt px-3 py-2 text-[11px] text-fg-faint">
          {locale === 'zh-CN'
            ? '一键安装需要在桌面应用中运行。'
            : 'One-click install must run in the desktop app.'}
        </div>
      ) : null}
      {busy && step ? (
        <div className="flex items-center gap-2 rounded border border-border-soft bg-bg-alt px-3 py-2 text-[11px] text-fg-dim">
          <RefreshCw size={12} className="animate-spin text-accent" />
          {step}
        </div>
      ) : null}
      {error ? (
        <div className="flex items-start gap-2 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </div>
      ) : null}
      {result?.ok ? (
        <div className="grid gap-2 rounded border border-emerald-500/30 bg-emerald-500/5 px-3 py-2.5 text-[11px] text-fg-dim">
          <div className="flex items-center gap-1.5 text-emerald-300">
            <Check size={13} />
            {locale === 'zh-CN' ? '配置完成' : 'Setup complete'}
          </div>
          {result.changedFiles.length > 0 ? (
            <div className="grid gap-1">
              <span>{locale === 'zh-CN' ? '已写入/更新：' : 'Written / updated:'}</span>
              <ul className="grid gap-0.5">
                {result.changedFiles.map((file) => (
                  <li key={file}>
                    <button
                      type="button"
                      onClick={() => onOpenFile(file)}
                      title={tr('在文件管理器中显示', locale)}
                      className="truncate text-left font-mono text-accent hover:underline"
                    >
                      {file}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="text-fg-faint">
              {locale === 'zh-CN'
                ? '项目文件已是最新配置。'
                : 'Project files were already up to date.'}
            </div>
          )}
          {result.notes.length > 0 ? (
            <div className="text-fg-faint">
              {locale === 'zh-CN'
                ? `说明：${result.notes.join('；')}`
                : `Notes: ${result.notes.join('; ')}`}
            </div>
          ) : null}
          {result.warnings.length > 0 ? (
            <div className="text-amber-300/90">
              {locale === 'zh-CN'
                ? `提示：${result.warnings.join('；')}`
                : `Tips: ${result.warnings.join('; ')}`}
            </div>
          ) : null}
        </div>
      ) : null}
      <GameMcpCommandSourceInfo command={command} sourceUrl={sourceUrl} />
    </section>
  );
}

function UnityMcpQuickSetup({
  busy,
  step,
  result,
  error,
  configured,
  current,
  onRun,
  onOpenFile,
}: {
  busy: boolean;
  step: string | null;
  result: UnityMcpSetupResult | null;
  error: string | null;
  configured: boolean;
  current?: boolean;
  onRun: () => void;
  onOpenFile: (path: string) => void;
}) {
  const locale = useStore((s) => s.locale);
  const desktop = tauriAvailable();
  return (
    <section
      className={cn(
        'grid gap-3 rounded-md border p-4',
        current
          ? 'border-accent/50 bg-accent/5'
          : 'border-border bg-panel-2',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-fg">
            <Rocket size={16} className="text-accent" />
            Unity MCP
            {current ? (
              <span className="rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">
                {locale === 'zh-CN' ? '当前引擎' : 'Current engine'}
              </span>
            ) : null}
            {configured ? (
              <span className="rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-300">
                {tr('已配置', locale)}
              </span>
            ) : null}
          </div>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-fg-faint">
            {locale === 'zh-CN'
              ? '为 Unity 工程的 Packages/manifest.json 写入 wellingfeng/unity-mcp 包依赖，合并项目 .mcp.json，并登记到本项目的 MCP 列表。首次使用仍需在 Unity Editor 打开 Window > MCP for Unity，等待包导入并完成授权。'
              : 'Adds the wellingfeng/unity-mcp package dependency to Packages/manifest.json, merges the project .mcp.json, and registers it in this project’s MCP list. First use still requires opening Window > MCP for Unity in Unity Editor, waiting for package import, and authorizing the connection.'}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void openExternal('https://github.com/wellingfeng/unity-mcp')}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-bg-alt px-3 py-2 text-xs font-semibold text-fg-dim hover:border-accent hover:text-fg"
          >
            <ExternalLink size={14} />
            {tr('打开来源', locale)}
          </button>
          <button
            type="button"
            onClick={onRun}
            disabled={busy || !desktop}
            className="inline-flex items-center gap-1.5 rounded-md border border-accent bg-accent/20 px-3 py-2 text-xs font-semibold text-fg hover:bg-accent/30 disabled:opacity-50"
          >
            {busy ? (
              <RefreshCw size={14} className="animate-spin" />
            ) : (
              <Download size={14} />
            )}
            {busy ? tr('配置中...', locale) : tr('一键安装并配置', locale)}
          </button>
        </div>
      </div>

      {!desktop ? (
        <div className="rounded border border-border-soft bg-bg-alt px-3 py-2 text-[11px] text-fg-faint">
          {locale === 'zh-CN'
            ? '一键配置需要在桌面应用中运行（浏览器环境无法写入 Unity 工程配置）。'
            : 'One-click setup must run in the desktop app (a browser environment cannot write Unity project config).'}
        </div>
      ) : null}

      {busy && step ? (
        <div className="flex items-center gap-2 rounded border border-border-soft bg-bg-alt px-3 py-2 text-[11px] text-fg-dim">
          <RefreshCw size={12} className="animate-spin text-accent" />
          {step}
        </div>
      ) : null}

      {error ? (
        <div className="flex items-start gap-2 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </div>
      ) : null}

      {result?.ok ? (
        <div className="grid gap-2 rounded border border-emerald-500/30 bg-emerald-500/5 px-3 py-2.5 text-[11px] text-fg-dim">
          <div className="flex items-center gap-1.5 text-emerald-300">
            <Check size={13} />
            {locale === 'zh-CN' ? '配置完成' : 'Setup complete'}
          </div>
          <div>
            {locale === 'zh-CN' ? 'Unity 包：' : 'Unity package: '}
            <span className="font-mono text-fg">{result.packageId}</span>
          </div>
          {result.changedFiles.length > 0 ? (
            <div className="grid gap-1">
              <span>{locale === 'zh-CN' ? '已写入/更新：' : 'Written / updated:'}</span>
              <ul className="grid gap-0.5">
                {result.changedFiles.map((file) => (
                  <li key={file} className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => onOpenFile(file)}
                      title={tr('在文件管理器中显示', locale)}
                      className="truncate text-left font-mono text-accent hover:underline"
                    >
                      {file}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="text-fg-faint">
              {locale === 'zh-CN'
                ? '项目文件已是最新配置。'
                : 'Project files were already up to date.'}
            </div>
          )}
          {result.notes.length > 0 ? (
            <div className="text-fg-faint">
              {locale === 'zh-CN'
                ? `说明：${result.notes.join('；')}`
                : `Notes: ${result.notes.join('; ')}`}
            </div>
          ) : null}
          {result.warnings.length > 0 ? (
            <div className="text-amber-300/90">
              {locale === 'zh-CN'
                ? `提示：${result.warnings.join('；')}`
                : `Tips: ${result.warnings.join('; ')}`}
            </div>
          ) : null}
        </div>
      ) : null}
      <GameMcpCommandSourceInfo
        command={
          result?.serverCommand
            ? [result.serverCommand, ...result.serverArgs].join(' ')
            : UNITY_MCP_COMMAND_PREVIEW
        }
        sourceUrl={UNITY_MCP_SOURCE_URL}
      />
    </section>
  );
}

export default function ProjectSettingsModal({
  workspace,
  onClose,
  onWorkspaceUpdated,
  embedTab,
}: ProjectSettingsModalProps) {
  const [tab, setTab] = useState<ProjectSettingsTab>(embedTab ?? 'overview');
  const locale = useStore((s) => s.locale);
  const activeTabRef = useRef<ProjectSettingsTab>(embedTab ?? 'overview');
  const embedTabRef = useRef<ProjectEmbedTab | undefined>(embedTab);

  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const dragState = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  const handleHeaderPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      // Ignore drags that start on interactive controls (e.g. the close button).
      if (event.button !== 0) return;
      if ((event.target as HTMLElement).closest('button, a, input, [role="button"]')) {
        return;
      }
      event.preventDefault();
      dragState.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: dragOffset.x,
        originY: dragOffset.y,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [dragOffset.x, dragOffset.y],
  );

  const handleHeaderPointerMove = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const state = dragState.current;
      if (!state || state.pointerId !== event.pointerId) return;
      setDragOffset({
        x: state.originX + (event.clientX - state.startX),
        y: state.originY + (event.clientY - state.startY),
      });
    },
    [],
  );

  const handleHeaderPointerUp = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const state = dragState.current;
      if (!state || state.pointerId !== event.pointerId) return;
      dragState.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [],
  );
  const [record, setRecord] = useState<WorkspaceRecord | null>(null);
  const [scan, setScan] = useState<ProjectEnvironmentScan | null>(null);
  const [settings, setSettings] = useState<ProjectSettings>(() =>
    projectSettingsFromMetadata(workspace.metadata),
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [lspProbing, setLspProbing] = useState(false);
  const [lspInstallingId, setLspInstallingId] = useState<string | null>(null);
  const [lspInstallResults, setLspInstallResults] = useState<
    Record<string, ProjectLspInstallResult>
  >({});
  const [lspAvailabilityProbes, setLspAvailabilityProbes] = useState<
    Record<string, ProjectLspProbeResult>
  >({});
  const [lspAvailabilityProbingIds, setLspAvailabilityProbingIds] = useState<string[]>(
    [],
  );
  const lspAvailabilityProbingRef = useRef<Set<string>>(new Set());
  const languageScanRunIdRef = useRef(0);
  const refreshRunIdRef = useRef(0);
  const forceNextLanguageScanRef = useRef(false);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [lspQuery, setLspQuery] = useState('');
  const [lspSubTab, setLspSubTab] = useState<'installed' | 'registry'>('installed');
  const [skillSubTab, setSkillSubTab] = useState<'installed' | 'registry'>(
    'installed',
  );
  const skillSubTabTouchedRef = useRef(false);
  const [globalSkillTargets, setGlobalSkillTargets] = useState<SkillInstallTarget[]>(
    [],
  );
  const [skillCatalogEntries, setSkillCatalogEntries] = useState<SlashCatalogEntry[]>(
    [],
  );
  const [mcpQuery, setMcpQuery] = useState('');
  const [mcpSubTab, setMcpSubTab] = useState<'installed' | 'registry'>('installed');
  const [onlineMcpServers, setOnlineMcpServers] = useState<McpServerDefinition[]>(
    [],
  );
  const [onlineMcpQuery, setOnlineMcpQuery] = useState('');
  const [onlineMcpLoading, setOnlineMcpLoading] = useState(false);
  const [onlineMcpError, setOnlineMcpError] = useState<string | null>(null);
  const [languageScan, setLanguageScan] = useState<ProjectLanguageScan>(() =>
    fallbackLanguageScanForEngine(projectSettingsFromMetadata(workspace.metadata).engine),
  );
  const [languageScanLoading, setLanguageScanLoading] = useState(false);
  const [unitySetupBusy, setUnitySetupBusy] = useState(false);
  const [unitySetupStep, setUnitySetupStep] = useState<string | null>(null);
  const [unitySetupResult, setUnitySetupResult] =
    useState<UnityMcpSetupResult | null>(null);
  const [unitySetupError, setUnitySetupError] = useState<string | null>(null);
  const [ueSetupBusy, setUeSetupBusy] = useState(false);
  const [ueSetupStep, setUeSetupStep] = useState<string | null>(null);
  const [ueSetupResult, setUeSetupResult] = useState<UeMcpSetupResult | null>(null);
  const [ueSetupError, setUeSetupError] = useState<string | null>(null);
  const [blueprintAction, setBlueprintAction] = useState<
    'install' | 'update' | 'uninstall' | null
  >(null);
  const [blueprintStatusBusy, setBlueprintStatusBusy] = useState(false);
  const [blueprintStatus, setBlueprintStatus] =
    useState<BlueprintModeStatusResult | null>(null);
  const [blueprintInstallResult, setBlueprintInstallResult] =
    useState<BlueprintModeInstallResult | null>(null);
  const [blueprintUninstallResult, setBlueprintUninstallResult] =
    useState<BlueprintModeUninstallResult | null>(null);
  const [blueprintInstallError, setBlueprintInstallError] = useState<string | null>(
    null,
  );
  const [godotSetupBusy, setGodotSetupBusy] = useState(false);
  const [godotSetupStep, setGodotSetupStep] = useState<string | null>(null);
  const [godotSetupResult, setGodotSetupResult] =
    useState<GenericProjectMcpSetupResult | null>(null);
  const [godotSetupError, setGodotSetupError] = useState<string | null>(null);
  const [cocosSetupBusy, setCocosSetupBusy] = useState(false);
  const [cocosSetupStep, setCocosSetupStep] = useState<string | null>(null);
  const [cocosSetupResult, setCocosSetupResult] =
    useState<GenericProjectMcpSetupResult | null>(null);
  const [cocosSetupError, setCocosSetupError] = useState<string | null>(null);
  const [remoteDialogOpen, setRemoteDialogOpen] = useState(false);
  const [envReport, setEnvReport] = useState<RemoteEnvironmentReport | null>(null);
  const [envLoading, setEnvLoading] = useState(false);
  const [envError, setEnvError] = useState<string | null>(null);
  const [envInstalling, setEnvInstalling] = useState(false);
  const [envInstallResult, setEnvInstallResult] =
    useState<RemoteEnvironmentInstallResult | null>(null);

  const workspacePath = record?.path || workspace.path || '';
  const isRemoteWorkspace = isRemoteWorkspacePath(workspacePath);
  const remoteWorkspaceId = isRemoteWorkspace
    ? remoteWorkspaceIdFromPath(workspacePath)
    : '';
  const remoteConfig = isRemoteWorkspace ? getRemoteWorkspace(remoteWorkspaceId) : null;
  const editableRemoteConfig: RemoteWorkspaceConfig | null =
    isRemoteWorkspace && remoteWorkspaceId
      ? remoteConfig ?? {
          id: remoteWorkspaceId,
          label: record?.name ?? workspace.name,
          serverUrl: '',
          adapter: 'claude',
          useOwnModelKey: false,
          createdAt: 0,
          updatedAt: 0,
        }
      : null;
  const health = useMemo(
    () =>
      projectHealth(
        {
          ...workspace,
          metadata: record?.metadata ?? workspace.metadata,
        },
        scan,
      ),
    [record?.metadata, scan, workspace],
  );
  const showGameFeatures = settings.gameFeatures.isGameProject;
  const detectedOrConfiguredEngine = scan?.engine.engine ?? settings.engine;
  const changeSkillSubTab = useCallback((id: ProjectSubTabId) => {
    skillSubTabTouchedRef.current = true;
    setSkillSubTab(id);
  }, []);
  const visibleTabs = useMemo(
    () =>
      tabs.filter((item) => {
        if (item.id === 'environment') {
          // Remote projects need a provisioning surface because the backend host
          // ships nothing preinstalled; local projects use the host's own tools.
          return isRemoteWorkspace;
        }
        if (item.id === 'blueprint') {
          return showGameFeatures && detectedOrConfiguredEngine === 'unreal';
        }
        return true;
      }),
    [detectedOrConfiguredEngine, isRemoteWorkspace, showGameFeatures],
  );
  const rankedLspServers = useMemo(
    () => rankLspServers(languageScan.languages, lspQuery),
    [languageScan.languages, lspQuery],
  );
  const recommendedLspIds = useMemo(
    () => new Set(recommendedLspServerIds(languageScan.languages)),
    [languageScan.languages],
  );
  const configuredLspById = useMemo(
    () => new Map(settings.lsp.servers.map((server) => [server.id, server])),
    [settings.lsp.servers],
  );
  // A configured LSP only counts as "installed" when its command is actually
  // available on this machine (probe ok). Recommended-but-not-found entries stay
  // in the registry tab instead of polluting the installed list.
  const installedLspIds = useMemo(() => {
    const ids = new Set<string>();
    for (const server of settings.lsp.servers) {
      const probe = server.lastProbe ?? lspAvailabilityProbes[server.id];
      if (probe?.ok === true) ids.add(server.id);
    }
    return ids;
  }, [settings.lsp.servers, lspAvailabilityProbes]);
  const rankedMcpServers = useMemo(
    () => rankMcpServers(mcpQuery, onlineMcpServers),
    [mcpQuery, onlineMcpServers],
  );
  const mcpRegistryCount = useMemo(
    () => rankMcpServers('', onlineMcpServers).length,
    [onlineMcpServers],
  );
  const configuredMcpIds = useMemo(
    () => new Set(settings.mcp.servers.map((server) => server.id)),
    [settings.mcp.servers],
  );
  const updateMcp = useCallback(
    (patch: Partial<ProjectSettings['mcp']>) => {
      setSettings((current) => ({
        ...current,
        mcp: { ...current.mcp, ...patch },
      }));
      setDirty(true);
    },
    [],
  );

  const updateAutomation = useCallback(
    (patch: Partial<ProjectSettings['automation']>) => {
      setSettings((current) => {
        const next = {
          ...current,
          automation: { ...current.automation, ...patch },
        };
        return patch.autoDetect === true && scan
          ? settingsWithDetectedGameFeatures(next, scan)
          : next;
      });
      setDirty(true);
    },
    [scan],
  );

  const setGameProjectEnabled = useCallback((checked: boolean) => {
    setSettings((current) => ({
      ...current,
      automation: {
        ...current.automation,
        autoDetect: false,
      },
      gameFeatures: {
        ...current.gameFeatures,
        isGameProject: checked,
        meshGeneration: checked,
        rigging: checked,
        capturePerf: checked,
        gameExperts: checked,
      },
      uiDesign: {
        ...current.uiDesign,
        enabled: checked,
      },
    }));
    setDirty(true);
  }, []);

  const updateSkills = useCallback(
    (patch: Partial<ProjectSettings['skills']>) => {
      setSettings((current) => ({
        ...current,
        skills: { ...current.skills, ...patch },
      }));
      setDirty(true);
    },
    [],
  );

  const updateLsp = useCallback(
    (patch: Partial<ProjectSettings['lsp']>) => {
      setSettings((current) => ({
        ...current,
        lsp: { ...current.lsp, ...patch },
      }));
      setDirty(true);
    },
    [],
  );

  const updateServer = useCallback(
    (serverId: string, patch: Partial<ProjectMcpServerConfig>) => {
      setSettings((current) => ({
        ...current,
        mcp: {
          ...current.mcp,
          servers: current.mcp.servers.map((server) =>
            server.id === serverId ? { ...server, ...patch } : server,
          ),
        },
      }));
      setDirty(true);
    },
    [],
  );

  const setMcpServerEnabled = useCallback((serverId: string, enabled: boolean) => {
    setSettings((current) => ({
      ...current,
      mcp: {
        ...current.mcp,
        enabled: enabled ? true : current.mcp.enabled,
        servers: current.mcp.servers.map((server) =>
          server.id === serverId ? { ...server, enabled } : server,
        ),
      },
    }));
    setDirty(true);
  }, []);

  const runLanguageScan = useCallback(
    async (
      rootPath: string,
      nextScan: ProjectEnvironmentScan,
      options: { force?: boolean } = {},
    ) => {
      if (!rootPath.trim() || isRemoteWorkspacePath(rootPath) || !tauriAvailable()) {
        return;
      }
      const cacheEnabled = projectSettingsCacheEnabled();
      const cacheKey = projectSettingsScanCacheKey(rootPath);
      if (!options.force && cacheEnabled) {
        const cached = readProjectSettingsScanCache(
          projectLanguageScanCache,
          cacheKey,
        );
        if (cached) {
          setLanguageScan(cached);
          return;
        }
      }

      const runId = languageScanRunIdRef.current + 1;
      languageScanRunIdRef.current = runId;
      setLanguageScanLoading(true);
      try {
        const nextLanguageScan = await scanWorkspaceLanguages(rootPath, nextScan);
        if (languageScanRunIdRef.current !== runId) return;
        if (cacheEnabled) {
          writeProjectSettingsScanCache(
            projectLanguageScanCache,
            cacheKey,
            nextLanguageScan,
          );
        }
        setLanguageScan(nextLanguageScan);
      } catch (err) {
        if (languageScanRunIdRef.current !== runId) return;
        setLanguageScan({
          ...fallbackLanguageScanForEngine(nextScan.engine.engine),
          error: describeError(err),
        });
      } finally {
        if (languageScanRunIdRef.current === runId) {
          setLanguageScanLoading(false);
        }
      }
    },
    [],
  );

  const refresh = useCallback(async (options: { force?: boolean } = {}) => {
    const refreshRunId = refreshRunIdRef.current + 1;
    refreshRunIdRef.current = refreshRunId;
    setLoading(true);
    setStatus(null);
    try {
      const latestRecord = await historyStore.getWorkspace(workspace.id);
      if (refreshRunIdRef.current !== refreshRunId) return;
      setRecord(latestRecord);
      const baseSettings = projectSettingsFromMetadata(
        latestRecord?.metadata ?? workspace.metadata,
      );
      const nextWorkspacePath = latestRecord?.path || workspace.path || '';
      let nextScan: ProjectEnvironmentScan | null = null;
      if (isRemoteWorkspacePath(nextWorkspacePath)) {
        setScan(null);
        setLanguageScan(fallbackLanguageScanForEngine(baseSettings.engine));
      } else if (nextWorkspacePath.trim()) {
        const cacheEnabled = projectSettingsCacheEnabled();
        const cacheKey = projectSettingsScanCacheKey(nextWorkspacePath);
        const cachedScan =
          !options.force && cacheEnabled
            ? readProjectSettingsScanCache(projectEnvironmentScanCache, cacheKey)
            : null;
        nextScan = cachedScan ?? (await scanProjectEnvironment(nextWorkspacePath));
        if (refreshRunIdRef.current !== refreshRunId) return;
        if (cacheEnabled && !cachedScan) {
          writeProjectSettingsScanCache(projectEnvironmentScanCache, cacheKey, nextScan);
        }
        setScan(nextScan);
        const cachedLanguageScan =
          !options.force && cacheEnabled
            ? readProjectSettingsScanCache(projectLanguageScanCache, cacheKey)
            : null;
        setLanguageScan(
          cachedLanguageScan ?? fallbackLanguageScanForEngine(nextScan.engine.engine),
        );
        if (
          options.force &&
          activeTabRef.current === 'lsp' &&
          (embedTabRef.current === undefined || embedTabRef.current === 'lsp')
        ) {
          forceNextLanguageScanRef.current = true;
        }
      } else {
        setScan(null);
        setLanguageScan(fallbackLanguageScanForEngine(baseSettings.engine));
      }
      const nextSettings = nextScan
        ? settingsWithDetectedGameFeatures(baseSettings, nextScan)
        : baseSettings;
      setSettings(nextSettings);
      setDirty(false);
    } catch (err) {
      if (refreshRunIdRef.current !== refreshRunId) return;
      setStatus(
        locale === 'zh-CN'
          ? `检测失败：${describeError(err)}`
          : `Scan failed: ${describeError(err)}`,
      );
    } finally {
      if (refreshRunIdRef.current === refreshRunId) {
        setLoading(false);
      }
    }
  }, [
    locale,
    workspace.id,
    workspace.metadata,
    workspace.path,
  ]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleRefreshClick = useCallback(() => {
    void refresh({ force: true });
  }, [refresh]);

  useEffect(() => {
    activeTabRef.current = tab;
  }, [tab]);

  useEffect(() => {
    embedTabRef.current = embedTab;
    if (embedTab) setTab(embedTab);
  }, [embedTab]);

  useEffect(() => {
    if (tab !== 'lsp' || !scan || isRemoteWorkspace || !workspacePath.trim()) {
      return;
    }
    const force = forceNextLanguageScanRef.current;
    forceNextLanguageScanRef.current = false;
    void runLanguageScan(workspacePath, scan, { force });
  }, [isRemoteWorkspace, runLanguageScan, scan, tab, workspacePath]);

  useEffect(() => {
    if (!showGameFeatures || skillSubTabTouchedRef.current) return;
    setSkillSubTab('registry');
  }, [showGameFeatures]);

  const loadGlobalSkillTargets = useCallback(async () => {
    if (!tauriAvailable()) {
      setGlobalSkillTargets([]);
      return;
    }
    try {
      const targets = await skillInstallTargets();
      setGlobalSkillTargets(targets.filter((target) => target.scope === 'global'));
    } catch {
      setGlobalSkillTargets([]);
    }
  }, []);

  useEffect(() => {
    if (tab !== 'skills') return;
    void loadGlobalSkillTargets();
  }, [tab, loadGlobalSkillTargets]);

  const loadOnlineMcpServers = useCallback(async (signal?: AbortSignal, query = '') => {
    setOnlineMcpLoading(true);
    setOnlineMcpError(null);
    try {
      const servers = await loadOnlineMcpCatalogServers(signal, { query });
      if (signal?.aborted) return;
      setOnlineMcpServers(servers);
      setOnlineMcpQuery(query);
    } catch (err) {
      if (signal?.aborted) return;
      setOnlineMcpError(describeError(err));
    } finally {
      if (!signal?.aborted) setOnlineMcpLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab !== 'mcp' || mcpSubTab !== 'registry') return;
    if (onlineMcpServers.length > 0) return;
    const controller = new AbortController();
    void loadOnlineMcpServers(controller.signal, '');
    return () => controller.abort();
  }, [loadOnlineMcpServers, mcpSubTab, onlineMcpServers.length, tab]);

  useEffect(() => {
    if (tab !== 'mcp' || mcpSubTab !== 'registry') return;
    const query = mcpQuery.trim();
    if (query === onlineMcpQuery.trim()) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void loadOnlineMcpServers(controller.signal, query);
    }, query ? 350 : 0);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [loadOnlineMcpServers, mcpQuery, mcpSubTab, onlineMcpQuery, tab]);

  // Skill descriptions come from the backend slash catalog (parsed SKILL.md
  // frontmatter). We index them by skill folder name so installed-skill cards
  // can show the same summaries as the `/` menu, with auto-translation.
  useEffect(() => {
    if (tab !== 'skills' || !tauriAvailable()) return;
    let active = true;
    void slashCatalog().then((snapshot) => {
      if (active) setSkillCatalogEntries(snapshot.entries);
    });
    let unlisten: (() => void) | undefined;
    void onSlashCatalogUpdated((snapshot) => {
      setSkillCatalogEntries(snapshot.entries);
    }).then((fn) => {
      if (active) unlisten = fn;
      else fn();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [tab]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (embedTab) return;
    if (!visibleTabs.some((item) => item.id === tab)) {
      setTab('overview');
    }
  }, [embedTab, tab, visibleTabs]);

  useEffect(() => {
    if (tab !== 'lsp' || !tauriAvailable()) return;

    const queryActive = lspQuery.trim().length > 0;
    const candidates = rankedLspServers
      .filter((server) => {
        const configured = configuredLspById.get(server.id);
        if (
          !queryActive &&
          !recommendedLspIds.has(server.id) &&
          !configured
        ) {
          return false;
        }
        if (configured?.lastProbe) return false;
        if (lspAvailabilityProbes[server.id]) return false;
        if (lspAvailabilityProbingRef.current.has(server.id)) return false;
        return (configured?.command ?? server.command).trim().length > 0;
      })
      .slice(0, queryActive ? 24 : 12);

    if (candidates.length === 0) return;

    let cancelled = false;
    const candidateIds = candidates.map((server) => server.id);
    const probingIds = lspAvailabilityProbingRef.current;
    candidateIds.forEach((id) => probingIds.add(id));
    setLspAvailabilityProbingIds((current) =>
      Array.from(new Set([...current, ...candidateIds])),
    );

    void (async () => {
      const results: Record<string, ProjectLspProbeResult> = {};
      for (const server of candidates) {
        const configured = configuredLspById.get(server.id);
        const result = await probeProjectLspServer({
          id: server.id,
          command: configured?.command ?? server.command,
          args: configured?.args.length ? configured.args : server.args,
        }).catch((err): ProjectLspProbeResult => ({
          serverId: server.id,
          ok: false,
          status: 'probe-error',
          message: describeError(err),
          resolvedCommand: null,
          checkedAtMs: Date.now(),
        }));
        results[server.id] = result;
      }
      if (cancelled) return;
      setLspAvailabilityProbes((current) => ({ ...current, ...results }));
      candidateIds.forEach((id) => probingIds.delete(id));
      setLspAvailabilityProbingIds((current) =>
        current.filter((id) => !candidateIds.includes(id)),
      );
    })();

    return () => {
      cancelled = true;
      candidateIds.forEach((id) => probingIds.delete(id));
      setLspAvailabilityProbingIds((current) =>
        current.filter((id) => !candidateIds.includes(id)),
      );
    };
  }, [
    configuredLspById,
    lspAvailabilityProbes,
    lspQuery,
    rankedLspServers,
    recommendedLspIds,
    tab,
  ]);

  const persistSettings = useCallback(
    async (next: ProjectSettings) => {
      setSaving(true);
      try {
        const nextRecord = await historyStore.patchWorkspaceMetadata(
          workspace.id,
          projectSettingsPatch(next),
        );
        const summary = workspaceSummaryFromRecord(nextRecord);
        setRecord(nextRecord);
        const savedSettings = projectSettingsFromMetadata(nextRecord.metadata);
        setSettings(savedSettings);
        useStore.setState((state) => ({
          workspaces: state.workspaces.map((item) =>
            item.id === summary.id ? summary : item,
          ),
        }));
        onWorkspaceUpdated?.(summary);
        setDirty(false);
        setStatus(tr('已保存', locale));
      } catch (err) {
        setStatus(
          locale === 'zh-CN'
            ? `保存失败：${describeError(err)}`
            : `Save failed: ${describeError(err)}`,
        );
      } finally {
        setSaving(false);
      }
    },
    [onWorkspaceUpdated, workspace.id, locale],
  );

  const applyRecommended = useCallback(async () => {
    if (!scan) return;
    const next = mergeRecommendedMcpServers(settings, scan);
    setSettings(next);
    await persistSettings(next);
    setStatus(tr('推荐 MCP 配置已应用', locale));
  }, [persistSettings, scan, settings, locale]);

  // Persist the project's workspace-folder list and immediately push it onto the
  // active session's composer (if this workspace is the active one), so the
  // change takes effect without waiting for a new session. New sessions inherit
  // these folders from the saved workspace metadata.
  const persistFolders = useCallback(
    async (folders: string[]) => {
      const normalized = dedupeFolders(folders);
      const next = { ...settings, folders: normalized };
      setSettings(next);
      await persistSettings(next);
      useStore.getState().applyWorkspaceFolders(workspace.id, normalized);
    },
    [persistSettings, settings, workspace.id],
  );

  const addFolder = useCallback(async () => {
    const picked = await pickFolder(tr('选择要加入项目的文件夹', locale));
    if (!picked) return;
    const existingKeys = new Set(
      [workspacePath, ...settings.folders].map(workspacePathKey),
    );
    if (existingKeys.has(workspacePathKey(picked))) {
      setStatus(tr('该文件夹已在项目中', locale));
      return;
    }
    await persistFolders([...settings.folders, picked]);
    setStatus(tr('已添加项目文件夹', locale));
  }, [persistFolders, settings.folders, workspacePath, locale]);

  const removeFolder = useCallback(
    async (path: string) => {
      const key = workspacePathKey(path);
      await persistFolders(
        settings.folders.filter((item) => workspacePathKey(item) !== key),
      );
      setStatus(tr('已移除项目文件夹', locale));
    },
    [persistFolders, settings.folders, locale],
  );

  const handleRemoteSaved = useCallback(
    (_remotePath: string, config: RemoteWorkspaceConfig) => {      setRemoteDialogOpen(false);
      void historyStore
        .renameWorkspace(workspace.id, config.label)
        .then((nextRecord) => {
          const summary = workspaceSummaryFromRecord(nextRecord);
          setRecord(nextRecord);
          useStore.setState((state) => ({
            workspaces: state.workspaces.map((item) =>
              item.id === summary.id ? summary : item,
            ),
          }));
          onWorkspaceUpdated?.(summary);
          setStatus(tr('已保存', locale));
        })
        .catch((err) => {
          setStatus(
            locale === 'zh-CN'
              ? `保存失败：${describeError(err)}`
              : `Save failed: ${describeError(err)}`,
          );
        });
    },
    [onWorkspaceUpdated, workspace.id, locale],
  );

  const probeRemoteEnvironment = useCallback(async () => {
    if (!isRemoteWorkspace || !workspacePath.trim()) return;
    setEnvLoading(true);
    setEnvError(null);
    try {
      const report = await getRemoteWorkspaceEnvironment(workspacePath);
      setEnvReport(report);
    } catch (err) {
      setEnvError(describeError(err));
    } finally {
      setEnvLoading(false);
    }
  }, [isRemoteWorkspace, workspacePath]);

  const installRemoteEnvironment = useCallback(
    async (tools?: RemoteEnvironmentToolId[]) => {
      if (!isRemoteWorkspace || !workspacePath.trim()) return;
      setEnvInstalling(true);
      setEnvError(null);
      setEnvInstallResult(null);
      try {
        const result = await installRemoteWorkspaceEnvironment(
          workspacePath,
          tools && tools.length ? { tools } : {},
        );
        setEnvInstallResult(result);
        setEnvReport(result.report);
      } catch (err) {
        setEnvError(describeError(err));
      } finally {
        setEnvInstalling(false);
      }
    },
    [isRemoteWorkspace, workspacePath],
  );

  // Auto-probe the remote host the first time the environment tab is opened, so
  // a fresh cloud project immediately shows what is installed (the host ships
  // nothing preinstalled, so git may well be missing).
  useEffect(() => {
    if (tab !== 'environment' || !isRemoteWorkspace) return;
    if (envReport || envLoading || envError) return;
    void probeRemoteEnvironment();
  }, [tab, isRemoteWorkspace, envReport, envLoading, envError, probeRemoteEnvironment]);

  const addCustomServer = useCallback(() => {
    const id = `custom-${Date.now().toString(36)}`;
    updateMcp({
      enabled: true,
      servers: [
        ...settings.mcp.servers,
        {
          id,
          label: tr('自定义 MCP', locale),
          source: 'custom',
          enabled: true,
          transport: 'stdio',
          command: '',
          args: [],
          env: {},
        },
      ],
    });
  }, [settings.mcp.servers, updateMcp, locale]);

  const removeServer = useCallback(
    (serverId: string) => {
      updateMcp({
        servers: settings.mcp.servers.filter((server) => server.id !== serverId),
      });
    },
    [settings.mcp.servers, updateMcp],
  );

  const installCatalogMcpServer = useCallback(
    (definition: McpServerDefinition) => {
      if (
        definition.installable === false ||
        (definition.transport === 'stdio' && !definition.command.trim()) ||
        (definition.transport !== 'stdio' && !definition.url?.trim())
      ) {
        setStatus(
          locale === 'zh-CN'
            ? `${definition.title} 暂不能直接写入项目配置；已提供地址复制。`
            : `${definition.title} cannot be written directly to project config yet; the address is copyable.`,
        );
        return;
      }
      if (configuredMcpIds.has(definition.id)) {
        setStatus(
          locale === 'zh-CN'
            ? `${definition.title} 已在已安装列表中`
            : `${definition.title} is already in the installed list`,
        );
        setMcpSubTab('installed');
        return;
      }
      const serverConfig: ProjectMcpServerConfig = {
        id: definition.id,
        label: definition.title,
        description: definition.description,
        source: 'suggested',
        enabled: true,
        transport: definition.transport,
        command: definition.command,
        args: [...definition.args],
        env: { ...definition.env },
        url: definition.url,
        requiresUserApproval: definition.requiresUserApproval,
      };
      updateMcp({
        enabled: true,
        servers: [...settings.mcp.servers, serverConfig],
      });
      const needsEnv = (definition.requiredEnv ?? []).length > 0;
      setStatus(
        needsEnv
          ? locale === 'zh-CN'
            ? `${definition.title} 已添加；请在「已安装」中填写所需环境变量后再探测。`
            : `${definition.title} added; fill in the required environment variables under “Installed” before probing.`
          : locale === 'zh-CN'
            ? `${definition.title} 已添加到已安装列表`
            : `${definition.title} added to the installed list`,
      );
      setMcpSubTab('installed');
    },
    [configuredMcpIds, settings.mcp.servers, updateMcp, locale],
  );

  const probeEnabledServers = useCallback(async () => {
    const enabledServers = settings.mcp.enabled
      ? settings.mcp.servers.filter((server) => server.enabled)
      : [];
    if (!workspacePath.trim() || enabledServers.length === 0) {
      setStatus(tr('没有可探测的 MCP server', locale));
      return;
    }
    setProbing(true);
    setStatus(tr('探测中...', locale));
    const results: ProjectMcpProbeResult[] = [];
    for (const server of enabledServers) {
      const result = await probeProjectMcpServer(workspacePath, {
        id: server.id,
        transport: server.transport,
        command: server.command,
        args: server.args,
        env: server.env,
        url: server.url,
      }).catch((err): ProjectMcpProbeResult => ({
        serverId: server.id,
        ok: false,
        status: 'probe-error',
        message: describeError(err),
        toolsCount: null,
        checkedAtMs: Date.now(),
      }));
      results.push(result);
    }
    const resultById = new Map(results.map((result) => [result.serverId, result]));
    const next: ProjectSettings = {
      ...settings,
      mcp: {
        ...settings.mcp,
        servers: settings.mcp.servers.map((server) => {
          const result = resultById.get(server.id);
          return result ? { ...server, lastProbe: result } : server;
        }),
      },
    };
    setSettings(next);
    await persistSettings(next);
    const okCount = results.filter((result) => result.ok).length;
    setStatus(
      locale === 'zh-CN'
        ? `探测完成：${okCount}/${results.length} 已连接`
        : `Probe complete: ${okCount}/${results.length} connected`,
    );
    setProbing(false);
  }, [persistSettings, settings, workspacePath, locale]);

  const lspConfigFromDefinition = useCallback(
    (
      definition: LspServerDefinition,
      existing?: ProjectLspServerConfig,
      enabled = existing?.enabled ?? true,
    ): ProjectLspServerConfig => ({
      id: definition.id,
      enabled,
      source: existing?.source ?? 'catalog',
      command: existing?.command ?? definition.command,
      args: existing?.args.length ? existing.args : definition.args,
      lastProbe: existing?.lastProbe,
    }),
    [],
  );

  const setLspServerEnabled = useCallback(
    (definition: LspServerDefinition, enabled: boolean) => {
      const existing = configuredLspById.get(definition.id);
      const nextServer = lspConfigFromDefinition(definition, existing, enabled);
      const servers = existing
        ? settings.lsp.servers.map((server) =>
            server.id === definition.id ? nextServer : server,
          )
        : [...settings.lsp.servers, nextServer];
      updateLsp({ ...(enabled ? { enabled: true } : {}), servers });
    },
    [configuredLspById, lspConfigFromDefinition, settings.lsp.servers, updateLsp],
  );

  const updateLspServer = useCallback(
    (definition: LspServerDefinition, patch: Partial<ProjectLspServerConfig>) => {
      const existing = configuredLspById.get(definition.id);
      const nextServer = {
        ...lspConfigFromDefinition(definition, existing, existing?.enabled ?? true),
        ...patch,
      };
      const servers = existing
        ? settings.lsp.servers.map((server) =>
            server.id === definition.id ? nextServer : server,
          )
        : [...settings.lsp.servers, nextServer];
      updateLsp({ servers });
    },
    [configuredLspById, lspConfigFromDefinition, settings.lsp.servers, updateLsp],
  );

  const applyRecommendedLsp = useCallback(async () => {
    const recommendedDefinitions = rankLspServers(languageScan.languages).filter((server) =>
      recommendedLspIds.has(server.id),
    );
    if (recommendedDefinitions.length === 0) {
      setStatus(tr('没有可应用的 LSP 推荐', locale));
      return;
    }
    const recommendedSet = new Set(recommendedDefinitions.map((server) => server.id));
    const preserved = settings.lsp.servers.filter(
      (server) => !recommendedSet.has(server.id),
    );
    const additions = recommendedDefinitions.map((definition) =>
      lspConfigFromDefinition(
        definition,
        configuredLspById.get(definition.id),
        true,
      ),
    );
    const next: ProjectSettings = {
      ...settings,
      lsp: {
        ...settings.lsp,
        enabled: true,
        servers: [...preserved, ...additions],
      },
    };
    setSettings(next);
    await persistSettings(next);
    setStatus(
      locale === 'zh-CN'
        ? `已应用 ${additions.length} 个 LSP 推荐`
        : `Applied ${additions.length} LSP recommendation(s)`,
    );
  }, [
    configuredLspById,
    lspConfigFromDefinition,
    languageScan.languages,
    persistSettings,
    recommendedLspIds,
    settings,
    locale,
  ]);

  const probeEnabledLspServers = useCallback(async () => {
    const enabledServers = settings.lsp.enabled
      ? settings.lsp.servers.filter((server) => server.enabled)
      : [];
    if (enabledServers.length === 0) {
      setStatus(tr('没有可检测的 LSP', locale));
      return;
    }
    setLspProbing(true);
    setStatus(tr('LSP 检测中...', locale));
    const results: ProjectLspProbeResult[] = [];
    for (const server of enabledServers) {
      const definition = lspServerById(server.id);
      const command = server.command || definition?.command || '';
      const args = server.args.length ? server.args : definition?.args ?? [];
      const result = await probeProjectLspServer({
        id: server.id,
        command,
        args,
      }).catch((err): ProjectLspProbeResult => ({
        serverId: server.id,
        ok: false,
        status: 'probe-error',
        message: describeError(err),
        resolvedCommand: null,
        checkedAtMs: Date.now(),
      }));
      results.push(result);
    }
    const resultById = new Map(results.map((result) => [result.serverId, result]));
    const next: ProjectSettings = {
      ...settings,
      lsp: {
        ...settings.lsp,
        servers: settings.lsp.servers.map((server) => {
          const result = resultById.get(server.id);
          return result ? { ...server, lastProbe: result } : server;
        }),
      },
    };
    setSettings(next);
    await persistSettings(next);
    const okCount = results.filter((result) => result.ok).length;
    setStatus(
      locale === 'zh-CN'
        ? `LSP 检测完成：${okCount}/${results.length} 命令可用`
        : `LSP probe complete: ${okCount}/${results.length} commands available`,
    );
    setLspProbing(false);
  }, [persistSettings, settings, locale]);

  const installLspServer = useCallback(
    async (definition: RankedLspServerDefinition) => {
      const commands = definition.installCommands ?? [];
      if (commands.length === 0) {
        setStatus(
          locale === 'zh-CN'
            ? `${definition.title} 暂不支持一键安装，请按安装说明手动安装。`
            : `${definition.title} does not support one-click install yet; install it manually per the instructions.`,
        );
        return;
      }
      if (!tauriAvailable()) {
        setStatus(tr('一键安装需要在桌面应用中运行。', locale));
        return;
      }
      const commandPreview = commands.map(installCommandText).join('\n');
      if (
        !settings.automation.allowThirdPartyInstall &&
        typeof window !== 'undefined' &&
        !window.confirm(
          locale === 'zh-CN'
            ? `将安装 ${definition.title}，可能会下载第三方依赖。\n\n将按当前平台选择并执行：\n${commandPreview}\n\n继续？`
            : `This will install ${definition.title} and may download third-party dependencies.\n\nIt will pick and run for the current platform:\n${commandPreview}\n\nContinue?`,
        )
      ) {
        return;
      }

      setLspInstallingId(definition.id);
      setStatus(
        locale === 'zh-CN'
          ? `正在安装 ${definition.title}...`
          : `Installing ${definition.title}…`,
      );
      try {
        const installResult = await installProjectLspServer({
          serverId: definition.id,
          commands,
          cwd: workspacePath.trim() || null,
        });
        setLspInstallResults((current) => ({
          ...current,
          [definition.id]: installResult,
        }));

        if (!installResult.ok) {
          setStatus(
            locale === 'zh-CN'
              ? `${definition.title} 安装失败：${installResult.message}`
              : `${definition.title} install failed: ${installResult.message}`,
          );
          return;
        }

        const existing = configuredLspById.get(definition.id);
        const nextServer = lspConfigFromDefinition(definition, existing, true);
        const probe = await probeProjectLspServer({
          id: definition.id,
          command: nextServer.command || definition.command,
          args: nextServer.args.length ? nextServer.args : definition.args,
        }).catch((err): ProjectLspProbeResult => ({
          serverId: definition.id,
          ok: false,
          status: 'probe-error',
          message: describeError(err),
          resolvedCommand: null,
          checkedAtMs: Date.now(),
        }));
        const installedServer = { ...nextServer, lastProbe: probe };
        const servers = existing
          ? settings.lsp.servers.map((server) =>
              server.id === definition.id ? installedServer : server,
            )
          : [...settings.lsp.servers, installedServer];
        const next: ProjectSettings = {
          ...settings,
          lsp: {
            ...settings.lsp,
            enabled: true,
            servers,
          },
        };
        setSettings(next);
        await persistSettings(next);
        setStatus(
          probe.ok
            ? locale === 'zh-CN'
              ? `${definition.title} 已安装并启用`
              : `${definition.title} installed and enabled`
            : locale === 'zh-CN'
              ? `${definition.title} 已安装；检测未通过：${probe.message}`
              : `${definition.title} installed; probe failed: ${probe.message}`,
        );
      } catch (err) {
        setStatus(
          locale === 'zh-CN'
            ? `${definition.title} 安装失败：${describeError(err)}`
            : `${definition.title} install failed: ${describeError(err)}`,
        );
      } finally {
        setLspInstallingId(null);
      }
    },
    [
      configuredLspById,
      lspConfigFromDefinition,
      persistSettings,
      settings,
      workspacePath,
      locale,
    ],
  );

  const isUnrealProject = detectedOrConfiguredEngine === 'unreal';
  const isUnityProject = detectedOrConfiguredEngine === 'unity';
  const isGodotProject = detectedOrConfiguredEngine === 'godot';
  const isCocosProject = detectedOrConfiguredEngine === 'cocos';
  const installedGameMcpIds = useMemo(
    () =>
      new Set(
        settings.mcp.servers
          .filter((server) =>
            [
              UNITY_MCP_SERVER_ID,
              UE_MCP_SERVER_ID,
              GODOT_MCP_SERVER_ID,
              COCOS_MCP_SERVER_ID,
            ].includes(server.id),
          )
          .map((server) => server.id),
      ),
    [settings.mcp.servers],
  );

  const registerGenericMcpSetupResult = useCallback(
    async (
      result: GenericProjectMcpSetupResult,
      engine: ProjectSettings['engine'],
    ) => {
      const existing = settings.mcp.servers.find(
        (server) => server.id === result.serverId,
      );
      const serverConfig: ProjectMcpServerConfig = {
        id: result.serverId,
        label: result.label,
        description: result.description,
        source: 'suggested',
        enabled: true,
        transport: result.transport,
        command: result.serverCommand ?? '',
        args: result.serverArgs,
        env:
          result.serverId === GODOT_MCP_SERVER_ID
            ? { GODOT_PATH: '', ...(existing?.env ?? {}) }
            : {},
        url: result.serverUrl ?? undefined,
        requiresUserApproval: true,
      };
      const merged: ProjectSettings = {
        ...settings,
        engine,
        mcp: {
          ...settings.mcp,
          enabled: true,
          servers: existing
            ? settings.mcp.servers.map((server) =>
                server.id === serverConfig.id
                  ? { ...server, ...serverConfig, lastProbe: server.lastProbe }
                  : server,
              )
            : [serverConfig, ...settings.mcp.servers],
        },
      };
      setSettings(merged);
      await persistSettings(merged);

      const probe = await probeProjectMcpServer(workspacePath, {
        id: serverConfig.id,
        transport: serverConfig.transport,
        command: serverConfig.command,
        args: serverConfig.args,
        env: serverConfig.env,
        url: serverConfig.url,
      }).catch(
        (err): ProjectMcpProbeResult => ({
          serverId: serverConfig.id,
          ok: false,
          status: 'probe-error',
          message: describeError(err),
          toolsCount: null,
          checkedAtMs: Date.now(),
        }),
      );
      const probed: ProjectSettings = {
        ...merged,
        mcp: {
          ...merged.mcp,
          servers: merged.mcp.servers.map((server) =>
            server.id === serverConfig.id ? { ...server, lastProbe: probe } : server,
          ),
        },
      };
      setSettings(probed);
      await persistSettings(probed);
      return probe;
    },
    [persistSettings, settings, workspacePath],
  );

  const setupUnityMcp = useCallback(async () => {
    if (!tauriAvailable()) {
      setUnitySetupError(tr('一键安装需要在桌面应用中运行。', locale));
      return;
    }
    if (!workspacePath.trim()) {
      setUnitySetupError(tr('未指定工作区路径。', locale));
      return;
    }
    setUnitySetupBusy(true);
    setUnitySetupError(null);
    setUnitySetupResult(null);
    setStatus(null);
    try {
      setUnitySetupStep(
        tr('正在配置 Unity 工程（写入 Packages/manifest.json 与 .mcp.json）...', locale),
      );
      const result = await unityMcpSetupProject({
        rootPath: workspacePath,
        writeManifest: true,
        writeMcpConfig: true,
      });
      setUnitySetupResult(result);
      if (!result.ok) {
        setUnitySetupError(result.error || tr('Unity MCP 配置失败。', locale));
        return;
      }

      const serverConfig: ProjectMcpServerConfig = {
        id: UNITY_MCP_SERVER_ID,
        label: 'Unity MCP',
        description:
          locale === 'zh-CN'
            ? 'wellingfeng/unity-mcp：连接 Unity Editor，管理场景、资产、脚本、组件与控制台；首次连接需在 Unity Editor 中授权。'
            : 'wellingfeng/unity-mcp: connects to Unity Editor to manage scenes, assets, scripts, components, and console logs; first connection must be authorized in Unity Editor.',
        source: 'suggested',
        enabled: true,
        transport: 'stdio',
        command: result.serverCommand,
        args: result.serverArgs,
        env: {},
        requiresUserApproval: true,
      };
      const existing = settings.mcp.servers.find(
        (server) => server.id === serverConfig.id,
      );
      const merged: ProjectSettings = {
        ...settings,
        engine: 'unity',
        mcp: {
          ...settings.mcp,
          enabled: true,
          servers: existing
            ? settings.mcp.servers.map((server) =>
                server.id === serverConfig.id
                  ? { ...server, ...serverConfig, lastProbe: server.lastProbe }
                  : server,
              )
            : [serverConfig, ...settings.mcp.servers],
        },
      };
      setSettings(merged);
      await persistSettings(merged);

      setUnitySetupStep(tr('正在探测 MCP 连接...', locale));
      const probe = await probeProjectMcpServer(workspacePath, {
        id: serverConfig.id,
        transport: serverConfig.transport,
        command: serverConfig.command,
        args: serverConfig.args,
        env: serverConfig.env,
      }).catch(
        (err): ProjectMcpProbeResult => ({
          serverId: serverConfig.id,
          ok: false,
          status: 'probe-error',
          message: describeError(err),
          toolsCount: null,
          checkedAtMs: Date.now(),
        }),
      );
      const probed: ProjectSettings = {
        ...merged,
        mcp: {
          ...merged.mcp,
          servers: merged.mcp.servers.map((server) =>
            server.id === serverConfig.id ? { ...server, lastProbe: probe } : server,
          ),
        },
      };
      setSettings(probed);
      await persistSettings(probed);
      setStatus(
        probe.ok
          ? locale === 'zh-CN'
            ? 'Unity MCP 已配置并连接成功。'
            : 'Unity MCP configured and connected.'
          : locale === 'zh-CN'
            ? 'Unity MCP 已配置；请在 Unity Editor 中打开 Window > MCP for Unity，等待包导入并完成授权后再次探测。'
            : 'Unity MCP configured; open Window > MCP for Unity in Unity Editor, wait for package import and authorization, then probe again.',
      );
    } catch (err) {
      setUnitySetupError(describeError(err));
    } finally {
      setUnitySetupBusy(false);
      setUnitySetupStep(null);
    }
  }, [persistSettings, settings, workspacePath, locale]);

  // True one-click flow: download+verify binary → run --setup-project →
  // register/update the project MCP server → probe → surface a restart hint.
  const setupUnrealMcp = useCallback(async () => {
    if (!tauriAvailable()) {
      setUeSetupError(tr('一键安装需要在桌面应用中运行。', locale));
      return;
    }
    if (!workspacePath.trim()) {
      setUeSetupError(tr('未指定工作区路径。', locale));
      return;
    }
    setUeSetupBusy(true);
    setUeSetupError(null);
    setUeSetupResult(null);
    setStatus(null);
    try {
      setUeSetupStep(tr('正在下载并校验 UE MCP 二进制...', locale));
      const binary = await ueMcpEnsureBinary();

      setUeSetupStep(
        tr('正在配置工程（启用插件 / 写入 RemoteControl 与 .mcp.json）...', locale),
      );
      const result = await ueMcpSetupProject({
        rootPath: workspacePath,
        serverCommand: binary.path,
        enablePython: true,
        writeMcpConfig: true,
      });
      setUeSetupResult(result);
      if (!result.ok) {
        setUeSetupError(result.error || tr('UE MCP 配置失败。', locale));
        return;
      }

      // Register / update the project MCP server so it persists + is probeable.
      const serverConfig: ProjectMcpServerConfig = {
        id: UE_MCP_SERVER_ID,
        label: tr('Unreal MCP (全版本)', locale),
        description:
          locale === 'zh-CN'
            ? `版本无关的 Unreal RemoteControl MCP（${binary.version}），支持 UE 4.25–5.8。`
            : `Version-agnostic Unreal RemoteControl MCP (${binary.version}), supports UE 4.25–5.8.`,
        source: 'suggested',
        enabled: true,
        transport: 'stdio',
        command: result.serverCommand || binary.path,
        args: [],
        env: {},
        requiresUserApproval: true,
        serverVersion: binary.version,
        engineAssociation: result.engineAssociation ?? undefined,
      };
      const merged: ProjectSettings = preferUnrealMcpServer(settings, serverConfig);
      setSettings(merged);
      await persistSettings(merged);

      // Best-effort connectivity probe (the server lazy-connects, so a failure
      // here usually just means the editor isn't running yet).
      setUeSetupStep(tr('正在探测 MCP 连接...', locale));
      const probe = await probeProjectMcpServer(workspacePath, {
        id: serverConfig.id,
        transport: serverConfig.transport,
        command: serverConfig.command,
        args: serverConfig.args,
        env: serverConfig.env,
      }).catch(
        (err): ProjectMcpProbeResult => ({
          serverId: serverConfig.id,
          ok: false,
          status: 'probe-error',
          message: describeError(err),
          toolsCount: null,
          checkedAtMs: Date.now(),
        }),
      );
      const probed: ProjectSettings = {
        ...merged,
        mcp: {
          ...merged.mcp,
          servers: merged.mcp.servers.map((s) =>
            s.id === serverConfig.id ? { ...s, lastProbe: probe } : s,
          ),
        },
      };
      setSettings(probed);
      await persistSettings(probed);
      const ueConfigChanged =
        result.changedFiles.some(
          (file) =>
            file.endsWith('.uproject') ||
            file.endsWith('Config/DefaultEngine.ini') ||
            file.endsWith('Config/DefaultRemoteControl.ini'),
        );
      const restartHint = result.restartRequired
        ? tr('请重启 Unreal Editor 后再连接。', locale)
        : ueConfigChanged
          ? tr('如 Unreal Editor 已经打开，请重启后生效。', locale)
          : '';
      setStatus(
        probe.ok
          ? locale === 'zh-CN'
            ? `Unreal MCP 已配置并连接成功。${restartHint}`
            : `Unreal MCP configured and connected. ${restartHint}`
          : locale === 'zh-CN'
            ? `Unreal MCP 已配置；等待 Unreal Editor 启动后即可连接。${restartHint}`
            : `Unreal MCP configured; it will connect once Unreal Editor starts. ${restartHint}`,
      );
    } catch (err) {
      setUeSetupError(describeError(err));
    } finally {
      setUeSetupBusy(false);
      setUeSetupStep(null);
    }
  }, [persistSettings, settings, workspacePath, locale]);

  const refreshBlueprintModeStatus = useCallback(async () => {
    if (!tauriAvailable() || !workspacePath.trim()) {
      setBlueprintStatus(null);
      return;
    }
    setBlueprintStatusBusy(true);
    setBlueprintInstallError(null);
    try {
      const result = await blueprintModeStatus({
        rootPath: workspacePath,
        targetDir: null,
      });
      setBlueprintStatus(result);
      if (!result.ok && result.error) {
        setBlueprintInstallError(result.error);
      }
    } catch (err) {
      setBlueprintInstallError(describeError(err));
    } finally {
      setBlueprintStatusBusy(false);
    }
  }, [workspacePath]);

  useEffect(() => {
    if (tab !== 'blueprint') return;
    void refreshBlueprintModeStatus();
  }, [refreshBlueprintModeStatus, tab]);

  const installBlueprintModePlugin = useCallback(async (mode: 'install' | 'update') => {
    if (!tauriAvailable()) {
      setBlueprintInstallError(tr('一键安装需要在桌面应用中运行。', locale));
      return;
    }
    if (!workspacePath.trim()) {
      setBlueprintInstallError(tr('未指定工作区路径。', locale));
      return;
    }
    setBlueprintAction(mode);
    setBlueprintInstallError(null);
    setBlueprintInstallResult(null);
    setBlueprintUninstallResult(null);
    setStatus(null);
    try {
      const result = await blueprintModeInstall({
        rootPath: workspacePath,
        targetDir: null,
        overwrite: mode === 'update',
      });
      setBlueprintInstallResult(result);
      if (!result.ok) {
        setBlueprintInstallError(
          result.error ||
            (locale === 'zh-CN'
              ? 'BlueprintMode 插件安装失败。'
              : 'BlueprintMode plugin install failed.'),
        );
        return;
      }
      await refreshBlueprintModeStatus();
      setStatus(
        locale === 'zh-CN'
          ? mode === 'update'
            ? 'BlueprintMode 插件已更新；重启 Unreal Editor 后生效。'
            : 'BlueprintMode 插件已安装；重启 Unreal Editor 后生效。'
          : mode === 'update'
            ? 'BlueprintMode plugin updated; restart Unreal Editor to load it.'
            : 'BlueprintMode plugin installed; restart Unreal Editor to load it.',
      );
    } catch (err) {
      setBlueprintInstallError(describeError(err));
    } finally {
      setBlueprintAction(null);
    }
  }, [
    locale,
    refreshBlueprintModeStatus,
    workspacePath,
  ]);

  const uninstallBlueprintModePlugin = useCallback(async () => {
    if (!tauriAvailable()) {
      setBlueprintInstallError(tr('一键安装需要在桌面应用中运行。', locale));
      return;
    }
    if (!workspacePath.trim()) {
      setBlueprintInstallError(tr('未指定工作区路径。', locale));
      return;
    }
    setBlueprintAction('uninstall');
    setBlueprintInstallError(null);
    setBlueprintInstallResult(null);
    setBlueprintUninstallResult(null);
    setStatus(null);
    try {
      const result = await blueprintModeUninstall({
        rootPath: workspacePath,
        targetDir: null,
      });
      setBlueprintUninstallResult(result);
      if (!result.ok) {
        setBlueprintInstallError(
          result.error ||
            (locale === 'zh-CN'
              ? 'BlueprintMode 插件卸载失败。'
              : 'BlueprintMode plugin uninstall failed.'),
        );
        return;
      }
      await refreshBlueprintModeStatus();
      setStatus(
        result.removed
          ? locale === 'zh-CN'
            ? 'BlueprintMode 插件已卸载。'
            : 'BlueprintMode plugin uninstalled.'
          : locale === 'zh-CN'
            ? 'BlueprintMode 插件未安装。'
            : 'BlueprintMode plugin is not installed.',
      );
    } catch (err) {
      setBlueprintInstallError(describeError(err));
    } finally {
      setBlueprintAction(null);
    }
  }, [locale, refreshBlueprintModeStatus, workspacePath]);

  const setupGodotMcp = useCallback(async () => {
    if (!tauriAvailable()) {
      setGodotSetupError(tr('一键安装需要在桌面应用中运行。', locale));
      return;
    }
    if (!workspacePath.trim()) {
      setGodotSetupError(tr('未指定工作区路径。', locale));
      return;
    }
    setGodotSetupBusy(true);
    setGodotSetupError(null);
    setGodotSetupResult(null);
    setStatus(null);
    try {
      setGodotSetupStep(
        locale === 'zh-CN'
          ? '正在配置 Godot MCP（写入 .mcp.json）...'
          : 'Configuring Godot MCP (writing .mcp.json)…',
      );
      const result = await godotMcpSetupProject({ rootPath: workspacePath });
      setGodotSetupResult(result);
      if (!result.ok) {
        setGodotSetupError(result.error || 'Godot MCP 配置失败。');
        return;
      }
      setGodotSetupStep(tr('正在探测 MCP 连接...', locale));
      const probe = await registerGenericMcpSetupResult(result, 'godot');
      setStatus(
        probe.ok
          ? locale === 'zh-CN'
            ? 'Godot MCP 已配置并连接成功。'
            : 'Godot MCP configured and connected.'
          : locale === 'zh-CN'
            ? `Godot MCP 已配置；请确认 Godot 可执行文件可被自动发现，或在已安装列表填写 GODOT_PATH 后再次探测。${probe.message ? `（${probe.message}）` : ''}`
            : `Godot MCP configured; make sure Godot is discoverable or fill GODOT_PATH under Installed, then probe again. ${probe.message}`,
      );
    } catch (err) {
      setGodotSetupError(describeError(err));
    } finally {
      setGodotSetupBusy(false);
      setGodotSetupStep(null);
    }
  }, [
    registerGenericMcpSetupResult,
    workspacePath,
    locale,
  ]);

  const setupCocosMcp = useCallback(async () => {
    if (!tauriAvailable()) {
      setCocosSetupError(tr('一键安装需要在桌面应用中运行。', locale));
      return;
    }
    if (!workspacePath.trim()) {
      setCocosSetupError(tr('未指定工作区路径。', locale));
      return;
    }
    if (
      !settings.automation.allowThirdPartyInstall &&
      typeof window !== 'undefined' &&
      !window.confirm(
        locale === 'zh-CN'
          ? '将从 GitHub 克隆 wellingfeng/cocos-mcp-server 到项目 extensions/cocos-mcp-server，并执行 npm install 与 npm run build。继续？'
          : 'This will clone wellingfeng/cocos-mcp-server into extensions/cocos-mcp-server and run npm install plus npm run build. Continue?',
      )
    ) {
      return;
    }
    setCocosSetupBusy(true);
    setCocosSetupError(null);
    setCocosSetupResult(null);
    setStatus(null);
    try {
      setCocosSetupStep(
        locale === 'zh-CN'
          ? '正在安装 Cocos MCP 扩展并写入 .mcp.json...'
          : 'Installing Cocos MCP extension and writing .mcp.json…',
      );
      const result = await cocosMcpSetupProject({ rootPath: workspacePath });
      setCocosSetupResult(result);
      if (!result.ok) {
        setCocosSetupError(result.error || 'Cocos MCP 配置失败。');
        return;
      }
      setCocosSetupStep(tr('正在探测 MCP 连接...', locale));
      const probe = await registerGenericMcpSetupResult(result, 'cocos');
      setStatus(
        probe.ok
          ? locale === 'zh-CN'
            ? 'Cocos MCP 已配置并连接成功。'
            : 'Cocos MCP configured and connected.'
          : locale === 'zh-CN'
            ? `Cocos MCP 已配置；请在 Cocos Creator 中启用扩展并等待服务启动后再次探测。${probe.message ? `（${probe.message}）` : ''}`
            : `Cocos MCP configured; enable the extension in Cocos Creator and probe again after the service starts. ${probe.message}`,
      );
    } catch (err) {
      setCocosSetupError(describeError(err));
    } finally {
      setCocosSetupBusy(false);
      setCocosSetupStep(null);
    }
  }, [
    registerGenericMcpSetupResult,
    settings.automation.allowThirdPartyInstall,
    workspacePath,
    locale,
  ]);

  const content = (() => {
    if (tab === 'overview') {
      const detectedEngine = scan?.engine.engine ?? 'unknown';
      const projectTypeLabel = isRemoteWorkspace
        ? locale === 'zh-CN'
          ? '云端项目'
          : 'Cloud project'
        : (scan?.engine.label ?? projectEngineLabel(detectedEngine));
      const folderEntries = uniqueWorkspaceHistory([
        workspacePath,
        ...settings.folders,
      ]);
      return (
        <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
          {isRemoteWorkspace ? (
            <section className="rounded-md border border-border bg-panel-2 p-4 lg:col-span-2">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-semibold text-fg">
                    <Terminal size={16} className="text-accent-2" />
                    {locale === 'zh-CN' ? '云端项目' : 'Cloud project'}
                  </div>
                  <div className="mt-1 text-xs leading-relaxed text-fg-faint">
                    {locale === 'zh-CN'
                      ? '这个项目绑定到当前用户。服务端按项目分配独立工作目录/容器；本地只保存项目 ID、仓库、分支和模型。'
                      : 'This project belongs to the current user. The server assigns an isolated workspace/container per project; the local app stores only project ID, repo, branch and model.'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setRemoteDialogOpen(true)}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-accent/60 bg-accent/10 px-3 py-1.5 text-xs font-semibold text-fg hover:bg-accent/20"
                >
                  <SettingsIcon size={14} />
                  {locale === 'zh-CN' ? '云端项目设置' : 'Cloud project settings'}
                </button>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <div className="rounded border border-border-soft bg-bg-alt p-3">
                  <div className="text-[11px] text-fg-faint">
                    {locale === 'zh-CN' ? '项目 ID' : 'Project ID'}
                  </div>
                  <div className="mt-1 truncate font-mono text-xs text-fg" title={remoteConfig?.projectId ?? ''}>
                    {remoteConfig?.projectId || tr('未指定', locale)}
                  </div>
                </div>
                <div className="rounded border border-border-soft bg-bg-alt p-3">
                  <div className="text-[11px] text-fg-faint">
                    {locale === 'zh-CN' ? '云端服务' : 'Cloud service'}
                  </div>
                  <div className="mt-1 truncate text-xs text-fg">
                    {remoteConfig?.serverUrl
                      ? locale === 'zh-CN'
                        ? '已连接'
                        : 'Connected'
                      : tr('未指定', locale)}
                  </div>
                </div>
                <div className="rounded border border-border-soft bg-bg-alt p-3">
                  <div className="text-[11px] text-fg-faint">
                    {locale === 'zh-CN' ? '项目仓库' : 'Project repo'}
                  </div>
                  <div className="mt-1 truncate text-xs text-fg" title={remoteConfig?.repoUrl ?? ''}>
                    {remoteConfig?.repoUrl || tr('未指定', locale)}
                  </div>
                </div>
                <div className="rounded border border-border-soft bg-bg-alt p-3">
                  <div className="text-[11px] text-fg-faint">
                    {locale === 'zh-CN' ? '项目分支' : 'Project branch'}
                  </div>
                  <div className="mt-1 truncate text-xs text-fg">
                    {remoteConfig?.branch || tr('未指定', locale)}
                  </div>
                </div>
                <div className="rounded border border-border-soft bg-bg-alt p-3">
                  <div className="text-[11px] text-fg-faint">
                    {locale === 'zh-CN' ? '执行模型' : 'Runner model'}
                  </div>
                  <div className="mt-1 truncate text-xs text-fg">
                    {remoteConfig
                      ? `${remoteConfig.adapter}${remoteConfig.model ? ` · ${remoteConfig.model}` : ''}`
                      : tr('未指定', locale)}
                  </div>
                </div>
              </div>
            </section>
          ) : (
            <section className="rounded-md border border-border bg-panel-2 p-4 lg:col-span-2">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-semibold text-fg">
                  <FolderOpen size={16} className="text-accent-2" />
                  {locale === 'zh-CN' ? '工作区文件夹' : 'Workspace folders'}
                </div>
                <div className="mt-1 text-xs leading-relaxed text-fg-faint">
                  {locale === 'zh-CN'
                    ? '这里管理项目包含的文件夹。第一个为主目录，其余作为附加目录一起授权给 AI。之后新建对话会自动继承这些文件夹。'
                    : 'Manage the folders included in this project. The first is the primary directory; the rest are authorized to the AI as additional directories. New conversations inherit these folders automatically.'}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void addFolder()}
                disabled={saving}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-accent/60 bg-accent/10 px-3 py-1.5 text-xs font-semibold text-fg hover:bg-accent/20 disabled:opacity-50"
              >
                <FolderPlus size={14} />
                {locale === 'zh-CN' ? '添加文件夹' : 'Add folder'}
              </button>
            </div>
            <ul className="mt-3 grid gap-2">
              {folderEntries.length === 0 ? (
                <li className="rounded-md border border-dashed border-border-soft bg-bg-alt px-3 py-4 text-center text-xs text-fg-faint">
                  {locale === 'zh-CN'
                    ? '尚未指定文件夹。添加后新建对话会自动使用这些目录。'
                    : 'No folders specified yet. Once added, new conversations use these directories automatically.'}
                </li>
              ) : (
                folderEntries.map((path, index) => {
                  const isPrimary = index === 0;
                  // 主目录是工作区本身，不可在此移除；附加文件夹可移除。
                  const removable = !isPrimary;
                  return (
                    <li
                      key={workspacePathKey(path)}
                      className="flex items-center gap-2 rounded-md border border-border-soft bg-bg-alt px-3 py-2"
                    >
                      {isPrimary ? (
                        <FolderOpen size={14} className="shrink-0 text-accent-2" />
                      ) : (
                        <Folder size={14} className="shrink-0 text-fg-faint" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-medium text-fg" title={path}>
                          {basename(path) || path}
                        </div>
                        <div
                          className="truncate font-mono text-[10px] text-fg-faint"
                          title={path}
                        >
                          {path}
                        </div>
                      </div>
                      <span
                        className={cn(
                          'shrink-0 rounded border px-1.5 py-0.5 text-[10px] leading-none',
                          isPrimary
                            ? 'border-accent/40 bg-accent/10 text-accent'
                            : 'border-border-soft text-fg-faint',
                        )}
                      >
                        {isPrimary
                          ? locale === 'zh-CN'
                            ? '主目录'
                            : 'Primary'
                          : locale === 'zh-CN'
                            ? '附加'
                            : 'Additional'}
                      </span>
                      {removable ? (
                        <button
                          type="button"
                          onClick={() => void removeFolder(path)}
                          disabled={saving}
                          title={tr('从项目中移除该文件夹', locale)}
                          aria-label={tr('从项目中移除该文件夹', locale)}
                          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-fg-faint transition-colors hover:bg-border hover:text-fg disabled:opacity-50"
                        >
                          <Trash2 size={13} />
                        </button>
                      ) : (
                        <span className="h-7 w-7 shrink-0" />
                      )}
                    </li>
                  );
                })
              )}
            </ul>
            </section>
          )}

          <section className="rounded-md border border-border bg-panel-2 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-xs font-semibold text-fg-faint">
                  {locale === 'zh-CN' ? '项目类型' : 'Project type'}
                </div>
                <div className="mt-1 flex items-center gap-2 text-lg font-semibold text-fg">
                  <Gamepad2 size={18} className="text-accent" />
                  {projectTypeLabel}
                </div>
                <div className="mt-1 text-xs text-fg-faint">
                  {scan?.engine.version ?? projectEngineLabel(detectedEngine)}
                </div>
              </div>
              <span
                className={cn(
                  'rounded border px-2 py-1 text-xs',
                  health.tone === 'connected'
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                    : health.tone === 'failed'
                      ? 'border-red-500/40 bg-red-500/10 text-red-300'
                      : health.tone === 'configured'
                        ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
                        : health.tone === 'detected'
                          ? 'border-sky-500/40 bg-sky-500/10 text-sky-300'
                          : 'border-border-soft bg-bg-alt text-fg-faint',
                )}
                title={health.detail}
              >
                {health.label}
              </span>
            </div>
            <div className="mt-4">
              <ToggleRow
                label={locale === 'zh-CN' ? '这是游戏项目' : 'This is a game project'}
                hint={
                  locale === 'zh-CN'
                    ? '标记当前工作区为游戏项目，用于显示 UE 蓝图等项目级工具。命令、Mesh、在线模型库、Sprite、UI、绑骨和抓帧性能已迁移到全局设置。'
                    : 'Marks this workspace as a game project so project-scoped tools such as UE Blueprint are shown. Commands, Mesh, model libraries, Sprite, UI, rigging, and capture/performance live in global Settings.'
                }
                checked={settings.gameFeatures.isGameProject}
                onChange={setGameProjectEnabled}
              />
            </div>
            <div className="mt-4 grid gap-2 text-xs text-fg-dim">
              <div className="truncate" title={workspacePath}>
                {locale === 'zh-CN' ? '工作区：' : 'Workspace: '}
                {workspacePath || tr('未指定', locale)}
              </div>
              <div>
                {locale === 'zh-CN' ? '游戏项目：' : 'Game project: '}
                {settings.gameFeatures.isGameProject
                  ? tr('开启', locale)
                  : locale === 'zh-CN'
                    ? '关闭'
                    : 'Off'}
              </div>
              <div>
                {locale === 'zh-CN' ? '标记：' : 'Markers: '}
                {scan?.engine.markers.join('、') || tr('无', locale)}
              </div>
              <div>
                {locale === 'zh-CN' ? '推荐 MCP：' : 'Recommended MCP: '}
                {scan?.suggestedMcpServers.length ?? 0}
              </div>
              <div>
                {locale === 'zh-CN' ? '检测语言：' : 'Detected languages: '}
                {languageScan.languages.map((item) => item.label).join('、') ||
                  tr('未识别', locale)}
              </div>
              <div>
                {locale === 'zh-CN' ? '推荐 LSP：' : 'Recommended LSP: '}
                {recommendedLspIds.size}
              </div>
            </div>
          </section>

          <section className="grid gap-3 rounded-md border border-border bg-panel-2 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-fg">
                  {locale === 'zh-CN' ? '项目 MCP' : 'Project MCP'}
                </div>
                <div className="mt-1 text-xs text-fg-faint">{health.detail}</div>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="rounded border border-border-soft bg-bg-alt p-3">
                <div className="text-[11px] text-fg-faint">{tr('已配置', locale)}</div>
                <div className="mt-1 text-lg font-semibold text-fg">
                  {settings.mcp.servers.length}
                </div>
              </div>
              <div className="rounded border border-border-soft bg-bg-alt p-3">
                <div className="text-[11px] text-fg-faint">{tr('已启用', locale)}</div>
                <div className="mt-1 text-lg font-semibold text-fg">
                  {settings.mcp.enabled
                    ? settings.mcp.servers.filter((server) => server.enabled).length
                    : 0}
                </div>
              </div>
              <div className="rounded border border-border-soft bg-bg-alt p-3">
                <div className="text-[11px] text-fg-faint">{tr('已连接', locale)}</div>
                <div className="mt-1 text-lg font-semibold text-fg">
                  {settings.mcp.enabled
                    ? settings.mcp.servers.filter(
                        (server) => server.enabled && server.lastProbe?.ok,
                      ).length
                    : 0}
                </div>
              </div>
            </div>
          </section>

          <section className="grid gap-3 rounded-md border border-border bg-panel-2 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-fg">
                  {locale === 'zh-CN' ? '项目 LSP' : 'Project LSP'}
                </div>
                <div className="mt-1 text-xs text-fg-faint">
                  {languageScan.languages.length > 0
                    ? locale === 'zh-CN'
                      ? `基于 ${languageScan.languages.length} 种语言排序推荐`
                      : `Ranked recommendations based on ${languageScan.languages.length} language(s)`
                    : tr('尚未识别编程语言', locale)}
                </div>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="rounded border border-border-soft bg-bg-alt p-3">
                <div className="text-[11px] text-fg-faint">{tr('已配置', locale)}</div>
                <div className="mt-1 text-lg font-semibold text-fg">
                  {settings.lsp.servers.length}
                </div>
              </div>
              <div className="rounded border border-border-soft bg-bg-alt p-3">
                <div className="text-[11px] text-fg-faint">{tr('已启用', locale)}</div>
                <div className="mt-1 text-lg font-semibold text-fg">
                  {settings.lsp.enabled
                    ? settings.lsp.servers.filter((server) => server.enabled).length
                    : 0}
                </div>
              </div>
              <div className="rounded border border-border-soft bg-bg-alt p-3">
                <div className="text-[11px] text-fg-faint">{tr('命令可用', locale)}</div>
                <div className="mt-1 text-lg font-semibold text-fg">
                  {settings.lsp.enabled
                    ? settings.lsp.servers.filter(
                        (server) => server.enabled && server.lastProbe?.ok,
                      ).length
                    : 0}
                </div>
              </div>
            </div>
          </section>
        </div>
      );
    }

    if (tab === 'environment') {
      const tools = envReport?.tools ?? [];
      const missingInstallable = tools.filter(
        (item) => !item.installed && item.installable,
      );
      const stepById = new Map(
        (envInstallResult?.steps ?? []).map((step) => [step.id, step]),
      );
      const noPackageManager =
        envReport != null && !envReport.packageManager;
      return (
        <div className="grid gap-4">
          <section className="rounded-md border border-border bg-panel-2 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-semibold text-fg">
                  <Server size={16} className="text-accent-2" />
                  {locale === 'zh-CN' ? '远程环境' : 'Remote environment'}
                </div>
                <div className="mt-1 max-w-2xl text-xs leading-relaxed text-fg-faint">
                  {locale === 'zh-CN'
                    ? '云端主机默认不预装任何开发环境。项目同步（git clone / pull）依赖 git，通常还需要 Node.js、Python。在这里检测并一键远程安装这些环境——点击在本地，安装在远程执行，且会在项目同步之前完成。缺少 git 时不会触发同步。'
                    : 'The cloud host ships no developer tooling preinstalled. Project sync (git clone / pull) needs git, and usually Node.js and Python too. Detect and one-click install them here — the click is local, the install runs remotely, and it completes before any project sync. Without git, sync will not run.'}
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void probeRemoteEnvironment()}
                  disabled={envLoading || envInstalling}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-bg-alt px-3 py-2 text-xs font-semibold text-fg-dim hover:border-accent hover:text-fg disabled:opacity-50"
                >
                  <RefreshCw size={14} className={envLoading ? 'animate-spin' : ''} />
                  {locale === 'zh-CN' ? '重新检测' : 'Re-check'}
                </button>
                <button
                  type="button"
                  onClick={() => void installRemoteEnvironment()}
                  disabled={
                    envInstalling ||
                    envLoading ||
                    missingInstallable.length === 0
                  }
                  className="inline-flex items-center gap-1.5 rounded-md border border-accent bg-accent/20 px-3 py-2 text-xs font-semibold text-fg hover:bg-accent/30 disabled:opacity-50"
                >
                  {envInstalling ? (
                    <RefreshCw size={14} className="animate-spin" />
                  ) : (
                    <Download size={14} />
                  )}
                  {envInstalling
                    ? locale === 'zh-CN'
                      ? '安装中...'
                      : 'Installing…'
                    : locale === 'zh-CN'
                      ? '一键安装缺失环境'
                      : 'Install missing'}
                </button>
              </div>
            </div>

            {envReport ? (
              <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-fg-faint">
                <span className="rounded border border-border-soft bg-bg-alt px-2 py-0.5">
                  {locale === 'zh-CN' ? '远程系统' : 'Remote OS'}：{envReport.platform}
                </span>
                <span className="rounded border border-border-soft bg-bg-alt px-2 py-0.5">
                  {locale === 'zh-CN' ? '包管理器' : 'Package manager'}：
                  {envReport.packageManager ?? (locale === 'zh-CN' ? '未识别' : 'unknown')}
                </span>
                <span
                  className={cn(
                    'rounded border px-2 py-0.5',
                    envReport.gitReady
                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                      : 'border-red-500/40 bg-red-500/10 text-red-300',
                  )}
                >
                  {envReport.gitReady
                    ? locale === 'zh-CN'
                      ? '可同步（git 就绪）'
                      : 'Sync ready (git present)'
                    : locale === 'zh-CN'
                      ? '无法同步（缺少 git）'
                      : 'Sync blocked (git missing)'}
                </span>
              </div>
            ) : null}

            {envError ? (
              <div className="mt-3 flex items-start gap-2 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">
                <TriangleAlert size={13} className="mt-0.5 shrink-0" />
                <span className="min-w-0 break-words">{envError}</span>
              </div>
            ) : null}

            {noPackageManager ? (
              <div className="mt-3 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
                {locale === 'zh-CN'
                  ? '远程主机上未检测到受支持的包管理器（apt/dnf/yum/apk/pacman/zypper/brew/winget/choco），无法自动安装。请在云端主机手动安装 git、Node.js、Python。'
                  : 'No supported package manager (apt/dnf/yum/apk/pacman/zypper/brew/winget/choco) was found on the remote host, so auto-install is unavailable. Install git, Node.js and Python manually on the cloud host.'}
              </div>
            ) : null}

            {!envReport && envLoading ? (
              <div className="mt-3 flex items-center gap-2 rounded border border-border-soft bg-bg-alt px-3 py-2 text-[11px] text-fg-dim">
                <RefreshCw size={12} className="animate-spin text-accent" />
                {locale === 'zh-CN' ? '正在检测远程环境...' : 'Probing remote environment…'}
              </div>
            ) : null}

            <ul className="mt-3 grid gap-2">
              {tools.map((item) => {
                const step = stepById.get(item.id);
                return (
                  <li
                    key={item.id}
                    className="grid gap-1.5 rounded-md border border-border-soft bg-bg-alt px-3 py-2.5"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-fg">{item.label}</span>
                      <span
                        className={cn(
                          'rounded border px-1.5 py-0.5 text-[10px]',
                          item.installed
                            ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                            : 'border-red-500/40 bg-red-500/10 text-red-300',
                        )}
                      >
                        {item.installed
                          ? locale === 'zh-CN'
                            ? '已安装'
                            : 'Installed'
                          : locale === 'zh-CN'
                            ? '未安装'
                            : 'Missing'}
                      </span>
                      {item.installed && item.version ? (
                        <span className="truncate font-mono text-[10px] text-fg-faint">
                          {item.version}
                        </span>
                      ) : null}
                      {!item.installed && item.installable ? (
                        <button
                          type="button"
                          onClick={() => void installRemoteEnvironment([item.id])}
                          disabled={envInstalling || envLoading}
                          className="ml-auto inline-flex items-center gap-1 rounded border border-accent/60 bg-accent/10 px-2 py-1 text-[11px] font-semibold text-fg hover:bg-accent/20 disabled:opacity-50"
                        >
                          <Download size={12} />
                          {locale === 'zh-CN' ? '安装' : 'Install'}
                        </button>
                      ) : null}
                    </div>
                    {!item.installed && item.installHint ? (
                      <code className="truncate font-mono text-[10px] text-fg-faint" title={item.installHint}>
                        {item.installHint}
                      </code>
                    ) : null}
                    {step ? (
                      <div
                        className={cn(
                          'rounded border px-2 py-1 text-[10px]',
                          step.ok
                            ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-300'
                            : 'border-red-500/30 bg-red-500/5 text-red-300',
                        )}
                      >
                        {step.ok
                          ? locale === 'zh-CN'
                            ? '安装成功'
                            : 'Install succeeded'
                          : `${locale === 'zh-CN' ? '安装失败' : 'Install failed'}${
                              step.error ? `：${step.error}` : ''
                            }`}
                      </div>
                    ) : null}
                  </li>
                );
              })}
              {envReport && tools.length === 0 ? (
                <li className="rounded-md border border-dashed border-border-soft bg-bg-alt px-3 py-4 text-center text-xs text-fg-faint">
                  {locale === 'zh-CN' ? '没有需要检测的环境项。' : 'No environment items to check.'}
                </li>
              ) : null}
            </ul>
          </section>
        </div>
      );
    }

    if (tab === 'blueprint') {
      const desktop = tauriAvailable();
      const ueMcpServer = settings.mcp.servers.find(
        (server) => server.id === UE_MCP_SERVER_ID,
      );
      const ueMcpConnected =
        settings.mcp.enabled && ueMcpServer?.enabled && ueMcpServer.lastProbe?.ok;
      const ueMcpConfigured = Boolean(ueMcpServer);
      const blueprintInstalled =
        blueprintStatus?.installed ?? blueprintInstallResult?.ok ?? false;
      const blueprintTargetExists =
        blueprintStatus?.exists ?? blueprintInstallResult?.ok ?? false;
      const blueprintUninstallBusy = blueprintAction === 'uninstall';
      const blueprintAnyBusy = blueprintStatusBusy || blueprintAction !== null;
      const blueprintStatusText = blueprintStatusBusy
        ? tr('检测中...', locale)
        : blueprintInstalled
          ? tr('已安装', locale)
          : blueprintTargetExists
            ? locale === 'zh-CN'
              ? '目录异常'
              : 'Directory issue'
            : locale === 'zh-CN'
              ? '待安装'
              : 'Needs install';
      const blueprintReportTarget =
        blueprintStatus?.targetDir ||
        blueprintInstallResult?.targetDir ||
        blueprintUninstallResult?.targetDir ||
        '';
      const blueprintReportSource =
        blueprintStatus?.sourceUrl || blueprintInstallResult?.sourceUrl || '';
      const blueprintReportNotes = [
        ...(blueprintStatus?.notes ?? []),
        ...(blueprintInstallResult?.notes ?? []),
        ...(blueprintUninstallResult?.notes ?? []),
      ];
      const blueprintReportWarnings = [
        ...(blueprintStatus?.warnings ?? []),
        ...(blueprintInstallResult?.warnings ?? []),
        ...(blueprintUninstallResult?.warnings ?? []),
      ];

      return (
        <div className="grid gap-4">
          <section className="rounded-md border border-border bg-panel-2 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-fg">
                  {locale === 'zh-CN' ? 'UE 蓝图模式' : 'UE Blueprint mode'}
                </div>
                <div className="mt-1 text-xs leading-relaxed text-fg-faint">
                  {locale === 'zh-CN'
                    ? '仅 Unreal Engine 项目显示。这里安装 BlueprintMode 插件，并通过 /blueprint-mode-start 让对话按蓝图创建、连线、编译和校验来处理。'
                    : 'Shown only for Unreal Engine projects. Install the BlueprintMode plugin here, then use /blueprint-mode-start for Blueprint creation, wiring, compilation, and verification.'}
                </div>
              </div>
              <span className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-300">
                Unreal Engine
              </span>
            </div>
          </section>

          <div className="grid gap-3 rounded-md border border-border bg-panel-2 p-4">
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="rounded border border-border-soft bg-bg-alt p-3">
                <div className="text-[11px] text-fg-faint">
                  {locale === 'zh-CN' ? '项目类型' : 'Project type'}
                </div>
                <div className="mt-1 text-sm font-semibold text-fg">
                  {scan?.engine.label ?? projectEngineLabel(settings.engine)}
                </div>
              </div>
              <div className="rounded border border-border-soft bg-bg-alt p-3">
                <div className="text-[11px] text-fg-faint">Unreal MCP</div>
                <div className="mt-1 text-sm font-semibold text-fg">
                  {ueMcpConnected
                    ? tr('已连接', locale)
                    : ueMcpConfigured
                      ? tr('已配置', locale)
                      : tr('未配置', locale)}
                </div>
              </div>
              <div className="rounded border border-border-soft bg-bg-alt p-3">
                <div className="text-[11px] text-fg-faint">BlueprintMode</div>
                <div className="mt-1 text-sm font-semibold text-fg">
                  {blueprintStatusText}
                </div>
                {blueprintStatus?.versionName ? (
                  <div className="mt-1 truncate text-[11px] text-fg-faint">
                    v{blueprintStatus.versionName}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="text-xs text-fg-faint">
              {locale === 'zh-CN'
                ? '插件会从 GitHub 下载，并安装到项目 Plugins 目录。'
                : 'The plugin is downloaded from GitHub and installed under the project Plugins directory.'}
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void refreshBlueprintModeStatus()}
                disabled={!desktop || blueprintAnyBusy}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-bg-alt px-3 py-1.5 text-xs text-fg-dim hover:border-accent hover:text-fg disabled:opacity-50"
              >
                <RefreshCw
                  size={13}
                  className={blueprintStatusBusy ? 'animate-spin' : undefined}
                />
                {tr('重新检测', locale)}
              </button>
              {blueprintTargetExists ? (
                <>
                  <button
                    type="button"
                    onClick={() => void installBlueprintModePlugin('update')}
                    disabled={!desktop || blueprintAnyBusy}
                    className="inline-flex items-center gap-1.5 rounded-md border border-accent bg-accent/15 px-3 py-1.5 text-xs font-semibold text-fg hover:bg-accent/25 disabled:border-border disabled:bg-bg-alt disabled:text-fg-faint"
                  >
                    {blueprintAction === 'update' ? (
                      <RefreshCw size={13} className="animate-spin" />
                    ) : (
                      <Download size={13} />
                    )}
                    {blueprintAction === 'update'
                      ? locale === 'zh-CN'
                        ? '更新中...'
                        : 'Updating...'
                      : locale === 'zh-CN'
                        ? '更新 BlueprintMode'
                        : 'Update BlueprintMode'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void uninstallBlueprintModePlugin()}
                    disabled={!desktop || blueprintAnyBusy}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-bg-alt px-3 py-1.5 text-xs text-fg-dim hover:border-red-400 hover:text-red-200 disabled:opacity-50"
                  >
                    {blueprintUninstallBusy ? (
                      <RefreshCw size={13} className="animate-spin" />
                    ) : (
                      <Trash2 size={13} />
                    )}
                    {blueprintUninstallBusy
                      ? locale === 'zh-CN'
                        ? '卸载中...'
                        : 'Uninstalling...'
                      : locale === 'zh-CN'
                        ? '卸载 BlueprintMode'
                        : 'Uninstall BlueprintMode'}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => void installBlueprintModePlugin('install')}
                  disabled={!desktop || blueprintAnyBusy}
                  className="inline-flex items-center gap-1.5 rounded-md border border-accent bg-accent/15 px-3 py-1.5 text-xs font-semibold text-fg hover:bg-accent/25 disabled:border-border disabled:bg-bg-alt disabled:text-fg-faint"
                >
                  {blueprintAction === 'install' ? (
                    <RefreshCw size={13} className="animate-spin" />
                  ) : (
                    <Download size={13} />
                  )}
                  {blueprintAction === 'install'
                    ? tr('安装中...', locale)
                    : locale === 'zh-CN'
                      ? '安装 BlueprintMode'
                      : 'Install BlueprintMode'}
                </button>
              )}
            </div>

            {!desktop ? (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                {tr('一键安装需要在桌面应用中运行。', locale)}
              </div>
            ) : null}
            {blueprintInstallError ? (
              <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                {blueprintInstallError}
              </div>
            ) : null}
            {blueprintStatus || blueprintInstallResult || blueprintUninstallResult ? (
              <div className="grid gap-1 rounded-md border border-border-soft bg-bg-alt px-3 py-2 text-[11px] leading-relaxed text-fg-faint">
                <div>
                  {locale === 'zh-CN' ? '来源：' : 'Source: '}
                  {blueprintReportSource || tr('未指定', locale)}
                </div>
                <div>
                  {locale === 'zh-CN' ? '目标：' : 'Target: '}
                  {blueprintReportTarget || tr('未指定', locale)}
                </div>
                {blueprintStatus?.upluginPath ? (
                  <div>
                    {locale === 'zh-CN' ? '插件：' : 'Plugin: '}
                    {blueprintStatus.upluginPath}
                  </div>
                ) : null}
                {blueprintReportNotes.map((note, index) => (
                  <div key={`${index}:${note}`}>{note}</div>
                ))}
                {blueprintReportWarnings.map((warning, index) => (
                  <div key={`${index}:${warning}`} className="text-amber-200">
                    {warning}
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <section className="grid gap-2 rounded-md border border-border bg-panel-2 p-4 text-xs leading-relaxed text-fg-faint">
            <div className="text-sm font-semibold text-fg">
              {locale === 'zh-CN' ? '使用方式' : 'Usage'}
            </div>
            <div>
              {locale === 'zh-CN'
                ? '开始：'
                : 'Start: '}
              <code className="rounded border border-border-soft bg-bg-alt px-1.5 py-0.5 text-accent">
                /blueprint-mode-start --target BP_Player --context full
              </code>
            </div>
            <div>
              {locale === 'zh-CN'
                ? '结束：'
                : 'End: '}
              <code className="rounded border border-border-soft bg-bg-alt px-1.5 py-0.5 text-accent">
                /blueprint-mode-end --compile --verify
              </code>
            </div>
          </section>
        </div>
      );
    }

    if (tab === 'mcp') {
      return (
        <div className="grid gap-4">
          <section className="grid gap-3">
            <div className="rounded-md border border-border bg-panel-2 p-4">
              <div className="text-sm font-semibold text-fg">
                {locale === 'zh-CN' ? '游戏 MCP 候选' : 'Game MCP candidates'}
              </div>
              <div className="mt-1 text-xs leading-relaxed text-fg-faint">
                {locale === 'zh-CN'
                  ? '这里固定显示 Unity、Unreal Engine、Godot、Cocos MCP。自动检测只负责标记当前引擎，是否安装由用户自己决定。'
                  : 'Unity, Unreal Engine, Godot, and Cocos MCP are always shown here. Auto-detect only marks the current engine; installation is up to the user.'}
              </div>
            </div>
            <div className="grid gap-3 xl:grid-cols-2">
              <UnityMcpQuickSetup
                busy={unitySetupBusy}
                step={unitySetupStep}
                result={unitySetupResult}
                error={unitySetupError}
                configured={installedGameMcpIds.has(UNITY_MCP_SERVER_ID)}
                current={isUnityProject}
                onRun={setupUnityMcp}
                onOpenFile={(path) => void openLocalPath(path, { reveal: true })}
              />
              <UnrealMcpQuickSetup
                busy={ueSetupBusy}
                step={ueSetupStep}
                result={ueSetupResult}
                error={ueSetupError}
                configured={installedGameMcpIds.has(UE_MCP_SERVER_ID)}
                current={isUnrealProject}
                onRun={setupUnrealMcp}
                onOpenFile={(path) => void openLocalPath(path, { reveal: true })}
              />
              <GenericGameMcpQuickSetup
                title="Godot MCP"
                description={
                  locale === 'zh-CN'
                    ? '使用 wellingfeng/godot-mcp，通过 npx 启动 Godot Editor、运行项目、读取调试输出并管理场景/脚本。需要本机已安装 Godot；自动发现失败时可在已安装列表填写 GODOT_PATH。'
                    : 'Uses wellingfeng/godot-mcp via npx to launch Godot Editor, run projects, read debug output, and manage scenes/scripts. Godot must be installed locally; fill GODOT_PATH under Installed if auto-detection fails.'
                }
                command="npx -y @coding-solo/godot-mcp"
                sourceUrl="https://github.com/wellingfeng/godot-mcp"
                busy={godotSetupBusy}
                step={godotSetupStep}
                result={godotSetupResult}
                error={godotSetupError}
                configured={installedGameMcpIds.has(GODOT_MCP_SERVER_ID)}
                current={isGodotProject}
                onRun={setupGodotMcp}
                onOpenFile={(path) => void openLocalPath(path, { reveal: true })}
              />
              <GenericGameMcpQuickSetup
                title="Cocos MCP"
                description={
                  locale === 'zh-CN'
                    ? '使用 wellingfeng/cocos-mcp-server，作为 Cocos Creator 扩展安装到 extensions/cocos-mcp-server，执行 npm install / npm run build，并通过 http://localhost:3000/mcp 连接。启用扩展后再探测。'
                    : 'Uses wellingfeng/cocos-mcp-server as a Cocos Creator extension installed under extensions/cocos-mcp-server, runs npm install / npm run build, then connects through http://localhost:3000/mcp. Enable the extension before probing.'
                }
                command="http://localhost:3000/mcp"
                sourceUrl="https://github.com/wellingfeng/cocos-mcp-server"
                busy={cocosSetupBusy}
                step={cocosSetupStep}
                result={cocosSetupResult}
                error={cocosSetupError}
                configured={installedGameMcpIds.has(COCOS_MCP_SERVER_ID)}
                current={isCocosProject}
                onRun={setupCocosMcp}
                onOpenFile={(path) => void openLocalPath(path, { reveal: true })}
              />
            </div>
          </section>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <ToggleRow
              label={tr('启用项目 MCP', locale)}
              checked={settings.mcp.enabled}
              onChange={(checked) => updateMcp({ enabled: checked })}
            />
            <button
              type="button"
              onClick={probeEnabledServers}
              disabled={probing || saving}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-bg-alt px-3 py-1.5 text-xs text-fg-dim hover:border-accent hover:text-fg disabled:opacity-50"
            >
              <Terminal size={13} />
              {probing ? tr('探测中...', locale) : tr('探测已启用 MCP', locale)}
            </button>
          </div>

          <ProjectSubTabBar
            active={mcpSubTab}
            onChange={setMcpSubTab}
            installedCount={settings.mcp.servers.length}
            registryCount={mcpRegistryCount}
          />

          {mcpSubTab === 'installed' ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={applyRecommended}
                    disabled={!scan || scan.suggestedMcpServers.length === 0 || saving}
                    className="rounded-md border border-border bg-bg-alt px-3 py-1.5 text-xs text-fg-dim hover:border-accent hover:text-fg disabled:opacity-50"
                  >
                    {locale === 'zh-CN' ? '应用推荐配置' : 'Apply recommended config'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setMcpSubTab('registry')}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-bg-alt px-3 py-1.5 text-xs text-fg-dim hover:border-accent hover:text-fg"
                  >
                    <Search size={13} />
                    {locale === 'zh-CN' ? '浏览仓库' : 'Browse registry'}
                  </button>
                  <button
                    type="button"
                    onClick={addCustomServer}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-bg-alt px-3 py-1.5 text-xs text-fg-dim hover:border-accent hover:text-fg"
                  >
                    <Plus size={13} />
                    {locale === 'zh-CN' ? '新增自定义' : 'Add custom'}
                  </button>
                </div>
              </div>

              <div className="grid gap-3">
                {settings.mcp.servers.length === 0 ? (
                  <div className="rounded-md border border-border-soft bg-bg-alt p-4 text-sm text-fg-faint">
                    {locale === 'zh-CN'
                      ? '当前项目未配置 MCP。切换到「仓库」浏览并安装。'
                      : 'This project has no MCP configured. Switch to “Registry” to browse and install.'}
                  </div>
                ) : (
                  settings.mcp.servers.map((server) => {
                    const commandId = fieldId('mcp-command', server.id);
                    const argsId = fieldId('mcp-args', server.id);
                    const urlId = fieldId('mcp-url', server.id);
                    const isStdioServer = server.transport === 'stdio';
                    return (
                      <section
                        key={server.id}
                        className="grid gap-3 rounded-md border border-border bg-panel-2 p-4"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <label className="flex min-w-0 items-center gap-2">
                            <input
                              type="checkbox"
                              checked={settings.mcp.enabled && server.enabled}
                              onChange={(event) =>
                                setMcpServerEnabled(
                                  server.id,
                                  event.currentTarget.checked,
                                )
                              }
                              className="h-4 w-4 shrink-0 accent-accent"
                            />
                            <span className="truncate text-sm font-semibold text-fg">
                              {server.label}
                            </span>
                            {server.serverVersion ? (
                              <span
                                className="shrink-0 rounded border border-border-soft bg-bg-alt px-1.5 py-0.5 text-[10px] text-fg-faint"
                                title={
                                  locale === 'zh-CN'
                                    ? `MCP 版本 ${server.serverVersion}`
                                    : `MCP version ${server.serverVersion}`
                                }
                              >
                                v{server.serverVersion}
                              </span>
                            ) : null}
                            {server.engineAssociation ? (
                              <span
                                className="shrink-0 rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent"
                                title={
                                  locale === 'zh-CN'
                                    ? `已对 Unreal Engine ${server.engineAssociation} 完成配置`
                                    : `Configured for Unreal Engine ${server.engineAssociation}`
                                }
                              >
                                {locale === 'zh-CN'
                                  ? `引擎 ${server.engineAssociation}`
                                  : `Engine ${server.engineAssociation}`}
                              </span>
                            ) : null}
                          </label>
                          <div className="flex items-center gap-2">
                            <ProbeBadge result={server.lastProbe} />
                            <button
                              type="button"
                              title={tr('卸载', locale)}
                              aria-label={tr('卸载', locale)}
                              onClick={() => removeServer(server.id)}
                              className="flex h-7 w-7 items-center justify-center rounded border border-border-soft bg-bg-alt text-fg-faint hover:border-red-400 hover:text-red-300"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </div>
                        {server.description ? (
                          <div className="text-xs text-fg-faint">{server.description}</div>
                        ) : null}
                        {isStdioServer ? (
                          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
                            <SettingsRow label={tr('命令', locale)}>
                              <input
                                id={commandId}
                                value={server.command ?? ''}
                                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                  updateServer(server.id, { command: event.currentTarget.value })
                                }
                                className="w-full rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-xs text-fg outline-none focus:border-accent"
                              />
                            </SettingsRow>
                            <SettingsRow label={tr('参数', locale)} hint={tr('空格分隔；工作区可用 {workspace}', locale)}>
                              <input
                                id={argsId}
                                value={server.args.join(' ')}
                                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                  updateServer(server.id, {
                                    args: event.currentTarget.value
                                      .split(' ')
                                      .map((item) => item.trim())
                                      .filter(Boolean),
                                  })
                                }
                                className="w-full rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-xs text-fg outline-none focus:border-accent"
                              />
                            </SettingsRow>
                          </div>
                        ) : (
                          <div className="grid gap-3 md:grid-cols-[minmax(0,1.4fr)_minmax(0,0.7fr)]">
                            <SettingsRow label="URL">
                              <input
                                id={urlId}
                                value={server.url ?? ''}
                                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                  updateServer(server.id, { url: event.currentTarget.value })
                                }
                                className="w-full rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-xs text-fg outline-none focus:border-accent"
                              />
                            </SettingsRow>
                            <SettingsRow label="Transport">
                              <input
                                value={server.transport}
                                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                  updateServer(server.id, {
                                    transport: event.currentTarget.value,
                                  })
                                }
                                className="w-full rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-xs text-fg outline-none focus:border-accent"
                              />
                            </SettingsRow>
                          </div>
                        )}
                        {server.env && Object.keys(server.env).length > 0 ? (
                          <div className="grid gap-2">
                            {Object.entries(server.env).map(([key, value]) => (
                              <SettingsRow key={key} label={key}>
                                <input
                                  value={value}
                                  type={/token|key|secret|password/i.test(key) ? 'password' : 'text'}
                                  placeholder={tr('填写环境变量值', locale)}
                                  onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                    updateServer(server.id, {
                                      env: { ...server.env, [key]: event.currentTarget.value },
                                    })
                                  }
                                  className="w-full rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-xs text-fg outline-none focus:border-accent"
                                />
                              </SettingsRow>
                            ))}
                          </div>
                        ) : null}
                        <div className="text-[11px] text-fg-faint">
                          {locale === 'zh-CN' ? '最近探测：' : 'Last probe: '}
                          {formatTime(server.lastProbe?.checkedAtMs, locale)}
                          {server.lastProbe ? ` · ${server.lastProbe.message}` : ''}
                        </div>
                      </section>
                    );
                  })
                )}
              </div>
            </>
          ) : (
            <McpRegistryView
              servers={rankedMcpServers}
              query={mcpQuery}
              onQueryChange={setMcpQuery}
              configuredIds={configuredMcpIds}
              loading={onlineMcpLoading}
              error={onlineMcpError}
              onRefresh={() => void loadOnlineMcpServers(undefined, mcpQuery.trim())}
              onInstall={installCatalogMcpServer}
              onUninstall={removeServer}
            />
          )}
        </div>
      );
    }

    if (tab === 'lsp') {
      const enabledCount = settings.lsp.enabled
        ? settings.lsp.servers.filter((server) => server.enabled).length
        : 0;
      const availableIds = new Set([
        ...settings.lsp.servers
          .filter((server) => server.lastProbe?.ok)
          .map((server) => server.id),
        ...Object.values(lspAvailabilityProbes)
          .filter((probe) => probe.ok)
          .map((probe) => probe.serverId),
      ]);
      const availableCount = availableIds.size;
      const languageText =
        languageScanLoading && languageScan.source === 'engine-fallback'
          ? locale === 'zh-CN'
            ? '扫描中...'
            : 'Scanning...'
          : languageScan.languages
              .slice(0, 12)
              .map((item) => `${item.label}${item.fileCount ? ` ${item.fileCount}` : ''}`)
              .join('、') || tr('未识别', locale);
      return (
        <div className="grid gap-4">
          <section className="rounded-md border border-border bg-panel-2 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-semibold text-fg">
                  <Languages size={16} className="text-accent" />
                  Language Server Protocol
                </div>
                <div className="mt-1 text-xs leading-relaxed text-fg-faint">
                  {locale === 'zh-CN'
                    ? `当前语言：${languageText}。推荐项按检测语言和推荐度排序；可搜索全部 LSP。`
                    : `Current languages: ${languageText}. Recommendations are ranked by detected language and relevance; search across all LSPs.`}
                </div>
                {languageScan.error ? (
                  <div className="mt-2 text-[11px] text-amber-300">
                    {locale === 'zh-CN'
                      ? `语言扫描降级：${languageScan.error}`
                      : `Language scan degraded: ${languageScan.error}`}
                  </div>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2 text-[11px]">
                <span className="rounded border border-border-soft bg-bg-alt px-2 py-1 text-fg-faint">
                  {languageScanLoading
                    ? locale === 'zh-CN'
                      ? '语言扫描中'
                      : 'Language scan running'
                    : locale === 'zh-CN'
                      ? `扫描 ${languageScan.filesScanned} 文件`
                      : `${languageScan.filesScanned} files scanned`}
                </span>
                <span className="rounded border border-accent/40 bg-accent/10 px-2 py-1 text-accent">
                  {locale === 'zh-CN'
                    ? `推荐 ${recommendedLspIds.size}`
                    : `${recommendedLspIds.size} recommended`}
                </span>
                <span className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-emerald-300">
                  {locale === 'zh-CN'
                    ? `已启用 ${enabledCount}`
                    : `${enabledCount} enabled`}
                </span>
                <span className="rounded border border-border-soft bg-bg-alt px-2 py-1 text-fg-faint">
                  {locale === 'zh-CN'
                    ? `可用 ${availableCount}`
                    : `${availableCount} available`}
                </span>
              </div>
            </div>
          </section>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <ToggleRow
              label={tr('启用项目 LSP', locale)}
              hint={tr('控制当前项目是否允许自动启动/使用已启用的 LSP 配置。', locale)}
              checked={settings.lsp.enabled}
              onChange={(checked) => updateLsp({ enabled: checked })}
            />
            <button
              type="button"
              onClick={probeEnabledLspServers}
              disabled={lspProbing || saving}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-bg-alt px-3 py-1.5 text-xs text-fg-dim hover:border-accent hover:text-fg disabled:opacity-50"
            >
              <Terminal size={13} />
              {lspProbing ? tr('检测中...', locale) : tr('检测已启用 LSP', locale)}
            </button>
          </div>

          <ProjectSubTabBar
            active={lspSubTab}
            onChange={setLspSubTab}
            installedCount={installedLspIds.size}
            registryCount={rankedLspServers.length}
          />

          {lspSubTab === 'installed' && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                onClick={applyRecommendedLsp}
                disabled={recommendedLspIds.size === 0 || saving}
                className="rounded-md border border-border bg-bg-alt px-3 py-1.5 text-xs text-fg-dim hover:border-accent hover:text-fg disabled:opacity-50"
              >
                {locale === 'zh-CN' ? '应用推荐 LSP' : 'Apply recommended LSP'}
              </button>
            </div>
          )}

          {lspSubTab === 'registry' && (
            <div className="relative">
              <Search
                size={14}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-faint"
              />
              <input
                type="text"
                value={lspQuery}
                onChange={(event) => setLspQuery(event.currentTarget.value)}
                placeholder={tr('搜索语言、LSP、命令或安装方式...', locale)}
                className="w-full rounded-lg border border-border bg-bg-alt py-2 pl-9 pr-3 text-sm text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none"
              />
            </div>
          )}

          {lspSubTab === 'registry' && languageScan.languages.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {languageScan.languages.slice(0, 18).map((language) => (
                <span
                  key={language.id}
                  className="rounded border border-border-soft bg-bg-alt px-2 py-0.5 text-[11px] text-fg-dim"
                  title={language.markers.join('、')}
                >
                  {language.label}
                  {language.fileCount ? ` · ${language.fileCount}` : ''}
                </span>
              ))}
              {languageScan.truncated ? (
                <span className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-300">
                  {locale === 'zh-CN' ? '扫描已截断' : 'Scan truncated'}
                </span>
              ) : null}
            </div>
          ) : null}

          {lspSubTab === 'installed' ? (
            installedLspIds.size === 0 ? (
              <p className="rounded-lg border border-border bg-bg-alt px-4 py-6 text-center text-xs text-fg-faint">
                {locale === 'zh-CN'
                  ? '暂无已安装的 LSP。切换到「仓库」tab 添加并安装，检测通过后会显示在这里。'
                  : 'No installed LSP yet. Switch to the “Registry” tab to add and install one; it appears here after a successful probe.'}
              </p>
            ) : (
              <div className="grid gap-2.5 lg:grid-cols-2 2xl:grid-cols-3">
                {rankedLspServers
                  .filter((server) => installedLspIds.has(server.id))
                  .map((server: RankedLspServerDefinition) => {
                    const config = configuredLspById.get(server.id);
                    const checked = settings.lsp.enabled && config?.enabled === true;
                    const recommended =
                      recommendedLspIds.has(server.id) && server.recommendationScore > 0;
                    const installResult = lspInstallResults[server.id];
                    const autoInstallCommand = server.installCommands?.[0];
                    const installing = lspInstallingId === server.id;
                    const autoProbing = lspAvailabilityProbingIds.includes(server.id);
                    const probeResult = config?.lastProbe ?? lspAvailabilityProbes[server.id];
                    const commandAvailable = probeResult?.ok === true;
                    const languageLabels = (
                      server.matchedLanguageIds.length > 0
                        ? server.matchedLanguageIds
                        : server.languageIds
                    ).map((id) => id);
                    return (
                      <section
                        key={server.id}
                        className={cn(
                          'flex min-h-[190px] flex-col gap-2.5 rounded-md border p-3',
                          recommended
                            ? 'border-accent/50 bg-accent/5'
                            : 'border-border bg-panel-2',
                        )}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <label className="flex min-w-0 flex-1 items-start gap-2">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(event) =>
                                setLspServerEnabled(server, event.currentTarget.checked)
                              }
                              className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
                            />
                            <span className="min-w-0">
                              <span className="flex min-w-0 items-center gap-1.5">
                                <span className="truncate text-sm font-semibold text-fg">
                                  {server.title}
                                </span>
                                {recommended ? (
                                  <span className="shrink-0 rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[10px] font-semibold text-accent">
                                    {locale === 'zh-CN' ? '推荐' : 'Recommended'}
                                  </span>
                                ) : null}
                              </span>
                              <span className="mt-1 block max-h-10 overflow-hidden text-xs leading-snug text-fg-faint">
                                {server.description}
                              </span>
                            </span>
                          </label>
                          <div className="flex shrink-0 items-center gap-1.5">
                            {autoProbing ? (
                              <span className="inline-flex items-center gap-1 rounded border border-border-soft bg-bg-alt px-2 py-0.5 text-[11px] text-fg-faint">
                                <RefreshCw size={11} className="animate-spin" />
                                {tr('检测中', locale)}
                              </span>
                            ) : (
                              <LspProbeBadge result={probeResult} />
                            )}
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {languageLabels.slice(0, 6).map((langId) => (
                            <span
                              key={langId}
                              className="rounded bg-bg-alt px-1.5 py-0.5 text-[10px] text-fg-faint"
                            >
                              {langId}
                            </span>
                          ))}
                        </div>
                        <div className="mt-auto flex flex-wrap items-center gap-1.5">
                          {autoInstallCommand && !commandAvailable ? (
                            <button
                              type="button"
                              disabled={installing || saving}
                              onClick={() => installLspServer(server)}
                              className="inline-flex items-center gap-1 rounded-md border border-border bg-bg-alt px-2.5 py-1 text-[11px] text-fg-dim hover:border-accent hover:text-fg disabled:opacity-50"
                            >
                              {installing ? (
                                <RefreshCw size={11} className="animate-spin" />
                              ) : (
                                <Download size={11} />
                              )}
                              {installing ? tr('安装中...', locale) : tr('安装', locale)}
                            </button>
                          ) : null}
                        <button
                            type="button"
                            disabled={autoProbing || saving}
                            onClick={() => probeEnabledLspServers()}
                            className="inline-flex items-center gap-1 rounded-md border border-border bg-bg-alt px-2.5 py-1 text-[11px] text-fg-dim hover:border-accent hover:text-fg disabled:opacity-50"
                          >
                            <Terminal size={11} />
                            {tr('检测', locale)}
                          </button>
                        </div>
                        <details className="group">
                          <summary className="cursor-pointer select-none text-[11px] text-fg-faint hover:text-fg">
                            {locale === 'zh-CN' ? '命令/参数' : 'Command / args'}
                          </summary>
                          <div className="mt-2 grid gap-2">
                            <SettingsRow label={tr('命令', locale)}>
                              <input
                                value={config?.command ?? server.command}
                                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                  updateLspServer(server, {
                                    command: event.currentTarget.value,
                                  })
                                }
                                className="w-full rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-xs text-fg outline-none focus:border-accent"
                              />
                            </SettingsRow>
                            <SettingsRow label={tr('参数', locale)} hint={tr('空格分隔；按 LSP stdio 启动参数填写', locale)}>
                              <input
                                value={(config?.args.length ? config.args : server.args).join(' ')}
                                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                  updateLspServer(server, {
                                    args: event.currentTarget.value
                                      .split(' ')
                                      .map((item) => item.trim())
                                      .filter(Boolean),
                                  })
                                }
                                className="w-full rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-xs text-fg outline-none focus:border-accent"
                              />
                            </SettingsRow>
                          </div>
                        </details>
                        <div className="grid gap-1 text-[11px] text-fg-faint">
                          {installResult ? (
                            <div
                              className={cn(
                                'truncate',
                                installResult.ok ? 'text-emerald-300' : 'text-red-300',
                              )}
                              title={[
                                installResult.commandLine,
                                installResult.stderr || installResult.stdout,
                              ]
                                .filter(Boolean)
                                .join('\n\n')}
                            >
                              {locale === 'zh-CN' ? '安装：' : 'Install: '}
                              {installResult.ok ? tr('成功', locale) : tr('失败', locale)} ·{' '}
                              {installResult.message}
                            </div>
                          ) : null}
                          <div>
                            {locale === 'zh-CN' ? '最近检测：' : 'Last probe: '}
                            {formatTime(probeResult?.checkedAtMs, locale)}
                            {probeResult ? ` · ${probeResult.message}` : ''}
                          </div>
                        </div>
                      </section>
                    );
                  })}
              </div>
            )
          ) : rankedLspServers.length === 0 ? (
            <p className="rounded-lg border border-border bg-bg-alt px-4 py-6 text-center text-xs text-fg-faint">
              {locale === 'zh-CN' ? '没有匹配的 LSP。' : 'No matching LSP.'}
            </p>
          ) : (
            <div className="grid gap-2.5 lg:grid-cols-2 2xl:grid-cols-3">
              {rankedLspServers.map((server: RankedLspServerDefinition) => {
                const config = configuredLspById.get(server.id);
                const checked = settings.lsp.enabled && config?.enabled === true;
                const recommended =
                  recommendedLspIds.has(server.id) && server.recommendationScore > 0;
                const installResult = lspInstallResults[server.id];
                const autoInstallCommand = server.installCommands?.[0];
                const installing = lspInstallingId === server.id;
                const autoProbing = lspAvailabilityProbingIds.includes(server.id);
                const probeResult = config?.lastProbe ?? lspAvailabilityProbes[server.id];
                const commandAvailable = probeResult?.ok === true;
                const languageLabels = (
                  server.matchedLanguageIds.length > 0
                    ? server.matchedLanguageIds
                    : server.languageIds
                ).map((id) => id);
                return (
                  <section
                    key={server.id}
                    className={cn(
                      'flex min-h-[190px] flex-col gap-2.5 rounded-md border p-3',
                      recommended
                        ? 'border-accent/50 bg-accent/5'
                        : 'border-border bg-panel-2',
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <label className="flex min-w-0 flex-1 items-start gap-2">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) =>
                            setLspServerEnabled(server, event.currentTarget.checked)
                          }
                          className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
                        />
                        <span className="min-w-0">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate text-sm font-semibold text-fg">
                              {server.title}
                            </span>
                            {recommended ? (
                              <span className="shrink-0 rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[10px] font-semibold text-accent">
                                {locale === 'zh-CN' ? '推荐' : 'Recommended'}
                              </span>
                            ) : null}
                          </span>
                          <span className="mt-1 block max-h-10 overflow-hidden text-xs leading-snug text-fg-faint">
                            {server.description}
                          </span>
                        </span>
                      </label>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {autoProbing ? (
                          <span className="inline-flex items-center gap-1 rounded border border-border-soft bg-bg-alt px-2 py-0.5 text-[11px] text-fg-faint">
                            <RefreshCw size={11} className="animate-spin" />
                            {tr('检测中', locale)}
                          </span>
                        ) : (
                          <LspProbeBadge result={probeResult} />
                        )}
                        <button
                          type="button"
                          onClick={() => void openExternal(server.sourceUrl)}
                          title={tr('打开来源', locale)}
                          aria-label={tr('打开来源', locale)}
                          className="flex h-7 w-7 items-center justify-center rounded border border-border-soft bg-bg-alt text-fg-faint hover:border-accent hover:text-fg"
                        >
                          <ExternalLink size={13} />
                        </button>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-1">
                      {languageLabels.map((id) => (
                        <span
                          key={`${server.id}-${id}`}
                          className={cn(
                            'rounded border px-1.5 py-0.5 text-[10px]',
                            server.matchedLanguageIds.includes(id)
                              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                              : 'border-border-soft bg-bg-alt text-fg-faint',
                          )}
                        >
                          {PROJECT_LANGUAGE_LABELS[id]}
                        </span>
                      ))}
                      <span className="rounded border border-border-soft bg-bg-alt px-1.5 py-0.5 text-[10px] text-fg-faint">
                        {server.trust === 'official'
                          ? tr('官方', locale)
                          : server.trust === 'curated'
                            ? tr('精选', locale)
                            : tr('社区', locale)}
                      </span>
                    </div>

                    <div className="mt-auto grid gap-2">
                      <div
                        className="truncate rounded border border-border-soft bg-bg-alt px-2 py-1 font-mono text-[11px] text-fg-dim"
                        title={autoInstallCommand ? installCommandText(autoInstallCommand) : server.install}
                      >
                        {autoInstallCommand
                          ? installCommandText(autoInstallCommand)
                          : server.install}
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => void installLspServer(server)}
                          disabled={
                            commandAvailable ||
                            !autoInstallCommand ||
                            lspInstallingId != null ||
                            saving
                          }
                          title={
                            commandAvailable
                              ? tr('命令已可用，无需安装', locale)
                              : autoInstallCommand
                              ? tr('一键安装并启用', locale)
                              : tr('该 LSP 暂不支持自动安装', locale)
                          }
                          className="inline-flex items-center gap-1 rounded-md border border-accent/60 bg-accent/10 px-2 py-1 text-[11px] font-semibold text-fg hover:bg-accent/20 disabled:border-border disabled:bg-bg-alt disabled:text-fg-faint"
                        >
                          {commandAvailable ? (
                            <Check size={12} />
                          ) : installing ? (
                            <RefreshCw size={12} className="animate-spin" />
                          ) : (
                            <Download size={12} />
                          )}
                          {commandAvailable
                            ? tr('已安装', locale)
                            : installing
                              ? tr('安装中', locale)
                              : tr('一键安装', locale)}
                        </button>
                        <button
                          type="button"
                          onClick={() => setLspServerEnabled(server, !checked)}
                          className="rounded-md border border-border bg-bg-alt px-2 py-1 text-[11px] text-fg-dim hover:border-accent hover:text-fg"
                        >
                          {checked
                            ? locale === 'zh-CN'
                              ? '关闭'
                              : 'Disable'
                            : tr('启用', locale)}
                        </button>
                      </div>
                      <details className="group">
                        <summary className="cursor-pointer select-none text-[11px] text-fg-faint hover:text-fg">
                          {locale === 'zh-CN' ? '命令/参数' : 'Command / args'}
                        </summary>
                        <div className="mt-2 grid gap-2">
                          <SettingsRow label={tr('命令', locale)}>
                            <input
                              value={config?.command ?? server.command}
                              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                updateLspServer(server, {
                                  command: event.currentTarget.value,
                                })
                              }
                              className="w-full rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-xs text-fg outline-none focus:border-accent"
                            />
                          </SettingsRow>
                          <SettingsRow label={tr('参数', locale)} hint={tr('空格分隔；按 LSP stdio 启动参数填写', locale)}>
                            <input
                              value={(config?.args.length ? config.args : server.args).join(' ')}
                              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                updateLspServer(server, {
                                  args: event.currentTarget.value
                                    .split(' ')
                                    .map((item) => item.trim())
                                    .filter(Boolean),
                                })
                              }
                              className="w-full rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-xs text-fg outline-none focus:border-accent"
                            />
                          </SettingsRow>
                        </div>
                      </details>
                    </div>

                    <div className="grid gap-1 text-[11px] text-fg-faint">
                      {installResult ? (
                        <div
                          className={cn(
                            'truncate',
                            installResult.ok ? 'text-emerald-300' : 'text-red-300',
                          )}
                          title={[
                            installResult.commandLine,
                            installResult.stderr || installResult.stdout,
                          ]
                            .filter(Boolean)
                            .join('\n\n')}
                        >
                          {locale === 'zh-CN' ? '安装：' : 'Install: '}
                          {installResult.ok ? tr('成功', locale) : tr('失败', locale)} ·{' '}
                          {installResult.message}
                        </div>
                      ) : null}
                      <div>
                        {locale === 'zh-CN' ? '最近检测：' : 'Last probe: '}
                        {formatTime(probeResult?.checkedAtMs, locale)}
                        {probeResult ? ` · ${probeResult.message}` : ''}
                      </div>
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </div>
      );
    }

    if (tab === 'skills') {
      const enabledRootIds = new Set(settings.skills.enabledRootIds);
      const projectSkillCount = (scan?.skillRoots ?? []).reduce(
        (total, root) => total + root.skillCount,
        0,
      );
      const globalSkillCount = globalSkillTargets.reduce(
        (total, target) => total + target.skillCount,
        0,
      );
      // Index skill summaries (from SKILL.md frontmatter) by skill folder name.
      // The backend sets each skill entry's `source` to its own directory, so the
      // trailing segment matches the folder names returned in skill roots/targets.
      const skillDescByFolder = new Map<string, SlashCatalogEntry>();
      for (const entry of skillCatalogEntries) {
        if (entry.kind !== 'skill') continue;
        const source = entry.source ?? '';
        const folder = source
          .replace(/[\\/]+$/, '')
          .split(/[\\/]/)
          .pop();
        if (folder) skillDescByFolder.set(folder.toLowerCase(), entry);
      }
      const skillDescriptionFor = (folder: string): string => {
        const entry = skillDescByFolder.get(folder.toLowerCase());
        return entry ? slashText(entry.detail, locale) : '';
      };
      return (
        <div className="grid gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs leading-relaxed text-fg-faint">
              {locale === 'zh-CN'
                ? '项目 Skill 的启用状态随项目配置保存；全局 Skill 对所有项目可见。'
                : 'Project Skill enablement is saved with the project config; global Skills are visible to all projects.'}
            </div>
            {tauriAvailable() ? (
              <button
                type="button"
                onClick={() => void loadGlobalSkillTargets()}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-bg-alt px-3 py-1.5 text-xs text-fg-dim hover:border-accent hover:text-fg"
              >
                <RefreshCw size={13} />
                {locale === 'zh-CN' ? '刷新全局' : 'Refresh global'}
              </button>
            ) : null}
          </div>

          <ProjectSubTabBar
            active={skillSubTab}
            onChange={changeSkillSubTab}
            installedCount={projectSkillCount + globalSkillCount}
          />

          {skillSubTab === 'installed' ? (
            <div className="grid gap-5">
              <section className="grid gap-3">
                <div className="flex items-center gap-2">
                  <Box size={14} className="text-accent" />
                  <span className="text-sm font-semibold text-fg">
                    {locale === 'zh-CN' ? '本项目 Skill' : 'This project’s Skills'}
                  </span>
                  <span className="rounded border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-300">
                    {tr('项目', locale)}
                  </span>
                </div>
                {(scan?.skillRoots ?? []).length === 0 ? (
                  <p className="rounded-md border border-border-soft bg-bg-alt px-3 py-4 text-center text-xs text-fg-faint">
                    {locale === 'zh-CN'
                      ? '未检测到项目 Skill 目录。'
                      : 'No project Skill directory detected.'}
                  </p>
                ) : (
                  (scan?.skillRoots ?? []).map((root) => {
                    const enabled = enabledRootIds.has(root.id);
                    return (
                      <div
                        key={root.id}
                        className="grid gap-3 rounded-md border border-border bg-panel-2 p-4"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <label className="flex min-w-0 items-center gap-2">
                            <input
                              type="checkbox"
                              checked={enabled}
                              onChange={(event) => {
                                const next = new Set(enabledRootIds);
                                if (event.currentTarget.checked) next.add(root.id);
                                else next.delete(root.id);
                                updateSkills({ enabledRootIds: [...next] });
                              }}
                              className="h-4 w-4 accent-accent"
                            />
                            <span className="truncate text-sm font-semibold text-fg">
                              {root.label}
                            </span>
                            <span className="rounded border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-300">
                              {tr('项目', locale)}
                            </span>
                          </label>
                          <span
                            className={cn(
                              'rounded border px-2 py-0.5 text-[11px]',
                              root.exists
                                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                                : 'border-border-soft bg-bg-alt text-fg-faint',
                            )}
                          >
                            {root.exists
                              ? locale === 'zh-CN'
                                ? `${root.skillCount} 个`
                                : `${root.skillCount}`
                              : tr('未创建', locale)}
                          </span>
                        </div>
                        {root.skills.length > 0 ? (
                          <>
                            <div
                              className="truncate font-mono text-[11px] text-fg-faint"
                              title={root.path}
                            >
                              {root.path}
                            </div>
                            <div className="grid gap-2.5 sm:grid-cols-2 2xl:grid-cols-3">
                              {root.skills.map((skill) => (
                                <InstalledSkillCard
                                  key={skill}
                                  name={skill}
                                  scope="project"
                                  enabled={enabled}
                                  description={skillDescriptionFor(skill)}
                                  path={joinSkillPath(root.path, skill)}
                                  locale={locale}
                                />
                              ))}
                            </div>
                          </>
                        ) : (
                          <p className="rounded-md border border-border-soft bg-bg-alt px-3 py-2 text-xs text-fg-faint">
                            {projectSkillEmptyText(root.label, locale)}
                          </p>
                        )}
                      </div>
                    );
                  })
                )}
              </section>

              <section className="grid gap-3">
                <div className="flex items-center gap-2">
                  <Boxes size={14} className="text-accent" />
                  <span className="text-sm font-semibold text-fg">
                    {locale === 'zh-CN' ? '全局 Skill' : 'Global Skills'}
                  </span>
                  <span className="rounded border border-violet-500/40 bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-300">
                    {tr('全局', locale)}
                  </span>
                </div>
                {!tauriAvailable() ? (
                  <p className="rounded-md border border-border-soft bg-bg-alt px-3 py-4 text-center text-xs text-fg-faint">
                    {locale === 'zh-CN'
                      ? '全局 Skill 仅在桌面应用中可见。'
                      : 'Global Skills are only visible in the desktop app.'}
                  </p>
                ) : globalSkillTargets.length === 0 ? (
                  <p className="rounded-md border border-border-soft bg-bg-alt px-3 py-4 text-center text-xs text-fg-faint">
                    {locale === 'zh-CN'
                      ? '未检测到全局 Skill 目录。'
                      : 'No global Skill directory detected.'}
                  </p>
                ) : (
                  globalSkillTargets.map((target) => (
                    <div
                      key={target.id}
                      className="grid gap-3 rounded-md border border-border bg-panel-2 p-4"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-semibold text-fg">
                            {target.label}
                          </span>
                          <span className="rounded border border-violet-500/40 bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-300">
                            {tr('全局', locale)}
                          </span>
                        </div>
                        <span
                          className={cn(
                            'rounded border px-2 py-0.5 text-[11px]',
                            target.exists
                              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                              : 'border-border-soft bg-bg-alt text-fg-faint',
                          )}
                        >
                          {target.exists
                            ? locale === 'zh-CN'
                              ? `${target.skillCount} 个`
                              : `${target.skillCount}`
                            : tr('未创建', locale)}
                        </span>
                      </div>
                      <div
                        className="truncate font-mono text-[11px] text-fg-faint"
                        title={target.path}
                      >
                        {target.path}
                      </div>
                      {target.skills.length > 0 ? (
                        <div className="grid gap-2.5 sm:grid-cols-2 2xl:grid-cols-3">
                          {target.skills.map((skill) => (
                            <InstalledSkillCard
                              key={skill}
                              name={skill}
                              scope="global"
                              enabled
                              description={skillDescriptionFor(skill)}
                              path={joinSkillPath(target.path, skill)}
                              locale={locale}
                            />
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ))
                )}
              </section>
            </div>
          ) : (
            <PluginStorePanel
              locale={locale}
              title={
                showGameFeatures
                  ? locale === 'zh-CN'
                    ? '游戏 Skill 推荐'
                    : 'Recommended Game Skills'
                  : undefined
              }
              description={
                showGameFeatures
                  ? locale === 'zh-CN'
                    ? '默认显示游戏开发相关 Skill；也可以切换来源查看全部仓库。'
                    : 'Shows game-development Skills by default; switch source to browse all registries.'
                  : undefined
              }
              defaultKind={showGameFeatures ? 'skill' : 'all'}
              defaultSourceId={
                showGameFeatures ? GAME_SKILL_RECOMMENDATION_SOURCE_ID : 'all'
              }
              projectRoot={workspacePath || null}
              onSkillInstalled={() => void loadGlobalSkillTargets()}
            />
          )}
        </div>
      );
    }

    return (
      <div className="grid gap-3">
        <ToggleRow
          label={tr('自动检测项目类型', locale)}
          checked={settings.automation.autoDetect}
          onChange={(checked) => updateAutomation({ autoDetect: checked })}
        />
        <ToggleRow
          label={tr('自动写入推荐 MCP 配置', locale)}
          hint={tr('只写项目配置，不安装第三方依赖。', locale)}
          checked={settings.automation.autoConfigureRecommendedMcp}
          onChange={(checked) =>
            updateAutomation({ autoConfigureRecommendedMcp: checked })
          }
        />
        <ToggleRow
          label={tr('允许自动启动项目 MCP', locale)}
          checked={settings.automation.autoStartMcp}
          onChange={(checked) => updateAutomation({ autoStartMcp: checked })}
        />
        <ToggleRow
          label={tr('允许第三方依赖安装', locale)}
          hint={tr('涉及 npm、uvx、插件安装时仍需确认。', locale)}
          checked={settings.automation.allowThirdPartyInstall}
          onChange={(checked) =>
            updateAutomation({ allowThirdPartyInstall: checked })
          }
        />
      </div>
    );
  })();

  // Embedded mode: render only the requested tab's content inline so the global
  // Settings modal can host MCP / LSP / Skills without duplicating any of the
  // project-scoped state, handlers, or scan/save lifecycle defined above. The
  // content is the exact same IIFE output as the in-modal tabs.
  if (embedTab) {
    if (loading) {
      return (
        <div className="flex min-h-[12rem] items-center justify-center text-sm text-fg-faint">
          {tr('检测中...', locale)}
        </div>
      );
    }
    return <div className="w-full">{content}</div>;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 sm:p-6"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-settings-title"
        className="flex h-[calc(100vh-2.5rem)] w-[calc(100vw-2.5rem)] max-w-[1600px] max-h-[1000px] flex-col overflow-hidden rounded-lg border border-border bg-panel shadow-2xl"
        style={{ transform: `translate(${dragOffset.x}px, ${dragOffset.y}px)` }}
        onClick={(event) => event.stopPropagation()}
      >
        <header
          className="shrink-0 cursor-move select-none border-b border-border-soft bg-bg-alt px-5 py-4"
          onPointerDown={handleHeaderPointerDown}
          onPointerMove={handleHeaderPointerMove}
          onPointerUp={handleHeaderPointerUp}
          onPointerCancel={handleHeaderPointerUp}
        >
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent text-bg">
              <SettingsIcon size={18} strokeWidth={2.2} />
            </span>
            <div className="min-w-0 flex-1">
              <h2 id="project-settings-title" className="truncate text-base font-semibold text-fg">
                {locale === 'zh-CN' ? '项目设置' : 'Project settings'} ·{' '}
                {record?.name ?? workspace.name}
              </h2>
              <p className="mt-1 truncate text-xs text-fg-faint" title={workspacePath}>
                {workspacePath || tr('未指定工作区', locale)}
              </p>
            </div>
            <button
              type="button"
              onClick={handleRefreshClick}
              disabled={loading}
              title={tr('重新检测', locale)}
              aria-label={tr('重新检测', locale)}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-panel-2 text-fg-faint transition-colors hover:border-accent hover:text-fg disabled:opacity-50"
            >
              <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
            </button>
            <button
              type="button"
              onClick={onClose}
              title={tr('关闭', locale)}
              aria-label={tr('关闭', locale)}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-panel-2 text-fg-faint transition-colors hover:border-accent hover:text-fg"
            >
              <X size={15} />
            </button>
          </div>
        </header>

        <div className="min-h-0 flex flex-1 flex-col bg-border-soft sm:flex-row">
          <nav className="w-full shrink-0 overflow-y-auto border-b border-border-soft bg-bg-alt p-3 sm:w-56 sm:border-b-0 sm:border-r">
            <div role="tablist" aria-orientation="vertical" className="grid gap-1">
              {visibleTabs.map((item) => {
                const active = item.id === tab;
                const Icon = item.Icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setTab(item.id)}
                    className={cn(
                      'flex items-center gap-2.5 rounded-md border px-3 py-2.5 text-left text-sm font-medium transition-colors',
                      active
                        ? 'border-accent bg-accent/15 text-fg'
                        : 'border-transparent text-fg-dim hover:bg-border-soft hover:text-fg',
                    )}
                  >
                    <Icon size={15} className={active ? 'text-accent' : 'text-fg-faint'} />
                    <span className="min-w-0 flex-1 truncate">{tr(item.label, locale)}</span>
                  </button>
                );
              })}
            </div>
          </nav>

          <main className="min-h-0 flex-1 overflow-y-auto bg-panel px-6 py-5 md:px-8 md:py-7">
            {loading ? (
              <div className="flex h-full items-center justify-center text-sm text-fg-faint">
                {tr('检测中...', locale)}
              </div>
            ) : (
              <div className="w-full max-w-[1180px]">{content}</div>
            )}
          </main>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border-soft bg-bg-alt px-5 py-3">
          <div className="min-w-0 flex-1 truncate text-xs text-fg-faint">
            {status ??
              (dirty
                ? tr('有未保存修改', locale)
                : tr('配置已同步', locale))}
          </div>
          <div className="flex flex-wrap gap-2">
            {workspacePath && !isRemoteWorkspace ? (
              <button
                type="button"
                onClick={() => void openLocalPath(workspacePath, { reveal: true })}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-panel-2 px-3 py-1.5 text-xs text-fg-dim hover:border-accent hover:text-fg"
              >
                <FileText size={13} />
                {locale === 'zh-CN' ? '打开位置' : 'Open location'}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void persistSettings(settings)}
              disabled={!dirty || saving}
              className="inline-flex items-center gap-1.5 rounded-md border border-accent bg-accent/15 px-3 py-1.5 text-xs font-semibold text-fg hover:bg-accent/25 disabled:border-border disabled:bg-panel-2 disabled:text-fg-faint"
            >
              <Check size={13} />
              {saving ? tr('保存中...', locale) : tr('保存', locale)}
            </button>
          </div>
        </footer>
      </div>
      {remoteDialogOpen && isRemoteWorkspace ? (
        <RemoteWorkspaceDialog
          locale={locale}
          existing={editableRemoteConfig}
          onClose={() => setRemoteDialogOpen(false)}
          onSaved={handleRemoteSaved}
        />
      ) : null}
    </div>
  );
}
