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
  Bone,
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
  Settings as SettingsIcon,
  SlashSquare,
  SlidersHorizontal,
  Terminal,
  Trash2,
  TriangleAlert,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { basename, pickFolder } from '@/lib/folderPicker';
import { uniqueWorkspaceHistory, workspacePathKey } from '@/lib/workspaceHistory';
import {
  dedupeFolders,
  mergeRecommendedMcpServers,
  projectEngineLabel,
  projectHealth,
  projectSettingsFromMetadata,
  projectSettingsPatch,
  preferUnrealMcpServer,
  isGameProjectEngine,
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
  GAME_PROJECT_COMMAND_NAMES,
  buildSlashSuggestions,
  isGameProjectCommandName,
  slashText,
  type SlashSuggestion,
} from '@/lib/slashCommands';
import {
  MCP_CATEGORY_LABELS,
  loadMcpRegistryServers,
  mcpCommandText,
  rankMcpServers,
  type McpServerDefinition,
  type RankedMcpServerDefinition,
} from '@/lib/mcpCatalog';
import {
  loadThreeDGenerationSettings,
  saveThreeDGenerationSettings,
} from '@/lib/threeDGeneration';
import {
  MESH_LIBRARIES,
  MESH_LIBRARY_CATEGORY_LABELS,
  loadMeshLibrarySettings,
  meshLibraryReady,
  meshLibraryUsability,
  meshLibraryUsable,
  saveMeshLibrarySettings,
  type MeshLibraryAccountSettings,
  type MeshLibraryDefinition,
  type MeshLibraryId,
} from '@/lib/meshLibrary';
import {
  listWorkspaceDirectory,
  installProjectLspServer,
  openExternal,
  openLocalPath,
  probeProjectLspServer,
  probeProjectMcpServer,
  scanProjectEnvironment,
  ueMcpEnsureBinary,
  ueMcpSetupProject,
  tauriAvailable,
  UE_MCP_SERVER_ID,
  skillInstallTargets,
  slashCatalog,
  onSlashCatalogUpdated,
  type ProjectEnvironmentScan,
  type ProjectLspInstallResult,
  type ProjectLspProbeResult,
  type ProjectMcpProbeResult,
  type SkillInstallTarget,
  type SlashCatalogEntry,
  type UeMcpSetupResult,
} from '@/lib/tauri';
import { historyStore } from '@/store/history/store';
import type { WorkspaceRecord, WorkspaceSummary } from '@/store/history/types';
import { useStore } from '@/store/useStore';
import { PluginStorePanel } from '@/panels/PluginStorePanel';
import { type Locale } from '@/lib/i18n';
import {
  cachedPluginDescriptionTranslation,
  shouldTranslatePluginDescription,
  translatePluginDescriptionCached,
} from '@/lib/pluginStoreTranslation';
import {
  ThreeDGenerationSettingsPanel,
  RiggingSettingsPanel,
  GameExpertSettingsPanel,
} from '@/panels/SettingsModal';

type ProjectSettingsTab =
  | 'overview'
  | 'mesh'
  | 'meshLibrary'
  | 'rigging'
  | 'gameExperts'
  | 'commands'
  | 'mcp'
  | 'lsp'
  | 'skills'
  | 'automation';

const tabs: { id: ProjectSettingsTab; label: string; Icon: LucideIcon }[] = [
  { id: 'overview', label: '概览', Icon: Info },
  { id: 'mesh', label: 'Mesh 渠道', Icon: Box },
  { id: 'meshLibrary', label: '模型库', Icon: Boxes },
  { id: 'rigging', label: '绑定渠道', Icon: Bone },
  { id: 'gameExperts', label: '游戏专家', Icon: Gamepad2 },
  { id: 'commands', label: '命令', Icon: SlashSquare },
  { id: 'mcp', label: 'MCP', Icon: Terminal },
  { id: 'lsp', label: 'LSP', Icon: Languages },
  { id: 'skills', label: 'Skills', Icon: Box },
  { id: 'automation', label: '权限/自动化', Icon: SlidersHorizontal },
];

interface ProjectSettingsModalProps {
  workspace: WorkspaceSummary;
  onClose: () => void;
  onWorkspaceUpdated?: (workspace: WorkspaceSummary) => void;
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

function formatTime(ms?: number | null): string {
  if (!ms) return '未探测';
  return new Date(ms).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function syncProjectGameFeaturesToRuntime(settings: ProjectSettings): void {
  const currentThreeD = loadThreeDGenerationSettings();
  saveThreeDGenerationSettings({
    ...currentThreeD,
    enabled: settings.gameFeatures.meshGeneration,
    rigging: {
      ...currentThreeD.rigging,
      enabled: settings.gameFeatures.rigging,
    },
  });

  useStore.getState().setGameExpertSettings({
    enabled: settings.gameFeatures.gameExperts,
    engine: settings.gameFeatures.gameExpertEngine,
  });
}

// Game-only tabs (Mesh / Rigging / Game Experts / Commands) only make sense for
// recognized game engines (Unity / Unreal / Godot). For non-game projects they
// stay hidden unless a feature was explicitly turned on for this project.
function shouldShowGameFeatures(
  settings: ProjectSettings,
  scan: ProjectEnvironmentScan | null,
): boolean {
  const detectedEngine = scan?.engine.engine ?? settings.engine;
  return (
    isGameProjectEngine(detectedEngine) ||
    settings.gameFeatures.meshGeneration ||
    settings.gameFeatures.rigging ||
    settings.gameFeatures.gameExperts
  );
}

const GAME_FEATURE_TABS: ReadonlySet<ProjectSettingsTab> = new Set([
  'mesh',
  'meshLibrary',
  'rigging',
  'gameExperts',
  'commands',
]);

function fieldId(prefix: string, id: string): string {
  return `${prefix}-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
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

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (directoriesScanned >= maxDirectories || paths.length >= maxFiles) {
      truncated = true;
      break;
    }
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

const PROJECT_SUB_TAB_LABELS: Record<ProjectSubTabId, string> = {
  installed: '已安装',
  registry: '仓库',
};

/** Append a skill folder name to its root path, picking the right separator. */
function joinSkillPath(root: string, skill: string): string {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  const trimmed = root.replace(/[\\/]+$/, '');
  return `${trimmed}${sep}${skill}`;
}

function projectSkillEmptyText(label: string): string {
  const family = label.replace(/\s*项目\s*Skill\s*$/, '').trim() || label;
  return `项目中 ${family} Skill 数目是 0`;
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
  const scopeLabel = scope === 'project' ? '项目' : '全局';
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
            {PROJECT_SUB_TAB_LABELS[item.id]}
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

function ProjectCommandsSettings() {
  const [query, setQuery] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const commands = useMemo(() => {
    const order = new Map(
      GAME_PROJECT_COMMAND_NAMES.map((name, index) => [name.toLowerCase(), index]),
    );
    return buildSlashSuggestions([], 'zh-CN')
      .filter((item) => isGameProjectCommandName(item.name))
      .sort(
        (a, b) =>
          (order.get(a.name.toLowerCase()) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(b.name.toLowerCase()) ?? Number.MAX_SAFE_INTEGER),
      );
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((item) => item.searchText.includes(q));
  }, [commands, query]);

  const copyName = (item: SlashSuggestion) => {
    void navigator.clipboard?.writeText(item.name).then(
      () => {
        setCopiedId(item.id);
        window.setTimeout(() => {
          setCopiedId((current) => (current === item.id ? null : current));
        }, 1500);
      },
      () => {},
    );
  };

  return (
    <div className="grid gap-4">
      <section className="rounded-md border border-border bg-panel-2 p-4">
        <div className="text-sm font-semibold text-fg">游戏命令</div>
        <div className="mt-1 text-xs leading-relaxed text-fg-faint">
          当前项目可用的游戏 slash command。非游戏项目不会显示此 tab。
        </div>
      </section>

      <div className="relative">
        <Search
          size={14}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-faint"
        />
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="搜索命令或用途..."
          className="w-full rounded-lg border border-border bg-bg-alt py-2 pl-9 pr-3 text-sm text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none"
        />
      </div>

      {filtered.length === 0 ? (
        <p className="rounded-lg border border-border bg-bg-alt px-4 py-6 text-center text-xs text-fg-faint">
          没有匹配的命令。
        </p>
      ) : (
        <div className="space-y-2">
          {filtered.map((item) => (
            <ProjectCommandRow
              key={item.id}
              item={item}
              copied={copiedId === item.id}
              onCopy={() => copyName(item)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectCommandRow({
  item,
  copied,
  onCopy,
}: {
  item: SlashSuggestion;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="group grid gap-2 rounded-lg border border-border bg-bg-alt px-4 py-3 md:grid-cols-[minmax(10rem,16rem)_minmax(0,1fr)] md:items-start">
      <div className="flex min-w-0 items-center gap-2">
        <code className="truncate font-mono text-sm font-medium text-accent">
          {item.name}
        </code>
        <button
          type="button"
          onClick={onCopy}
          aria-label="复制命令名"
          title="复制命令名"
          className="ml-auto shrink-0 rounded p-1 text-fg-faint opacity-0 transition-opacity hover:text-fg focus:opacity-100 group-hover:opacity-100"
        >
          {copied ? (
            <Check size={13} className="text-accent-2" />
          ) : (
            <Copy size={13} />
          )}
        </button>
      </div>
      <div className="min-w-0">
        {item.label && item.label !== item.name && (
          <div className="text-sm font-medium text-fg">{item.label}</div>
        )}
        {item.detail && (
          <p className="mt-0.5 text-xs leading-relaxed text-fg-faint">
            {item.detail}
          </p>
        )}
      </div>
    </div>
  );
}

function MeshLibraryCard({
  library,
  settings,
  onToggle,
  onKeyChange,
}: {
  library: MeshLibraryDefinition;
  settings: MeshLibraryAccountSettings;
  onToggle: (enabled: boolean) => void;
  onKeyChange: (value: string) => void;
}) {
  const enabled = settings.enabledIds.includes(library.id);
  const ready = meshLibraryReady(library.id, settings);
  const usability = meshLibraryUsability(library.id, settings);
  const keyValue = settings.apiKeys[library.id] ?? '';
  const searchKindLabel =
    library.searchKind === 'public-api'
      ? '免费 API'
      : library.searchKind === 'api-key'
        ? 'API Key 搜索'
        : '深链搜索页';
  return (
    <section className="flex flex-col gap-2.5 rounded-md border border-border bg-panel-2 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-fg">{library.label}</span>
            <span className="shrink-0 rounded border border-border-soft bg-bg-alt px-1.5 py-0.5 text-[10px] text-fg-faint">
              {MESH_LIBRARY_CATEGORY_LABELS[library.category]}
            </span>
          </div>
          <span className="mt-1 block max-h-12 overflow-hidden text-xs leading-snug text-fg-faint">
            {library.note}
          </span>
        </div>
        <button
          type="button"
          onClick={() => void openExternal(library.homepageUrl)}
          title="打开来源"
          aria-label="打开来源"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border-soft bg-bg-alt text-fg-faint hover:border-accent hover:text-fg"
        >
          <ExternalLink size={13} />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        <span className="rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">
          {searchKindLabel}
        </span>
        {usability === 'usable' ? (
          <span className="rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-300">
            真正可用
          </span>
        ) : usability === 'needs-key' ? (
          <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300">
            待配置 Key
          </span>
        ) : (
          <span className="rounded border border-border-soft bg-bg-alt px-1.5 py-0.5 text-[10px] text-fg-faint">
            仅深链浏览
          </span>
        )}
        {library.supportsDownload ? (
          <span className="rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-300">
            可直接下载
          </span>
        ) : (
          <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300">
            账号内下载
          </span>
        )}
        {library.needsKey ? (
          <span
            className={cn(
              'rounded border px-1.5 py-0.5 text-[10px]',
              ready
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                : 'border-amber-500/40 bg-amber-500/10 text-amber-300',
            )}
          >
            {ready ? '已配置 Key' : '需 API Key'}
          </span>
        ) : null}
      </div>

      {(library.needsKey || library.keyLabel) && (
        <label className="grid gap-1">
          <span className="text-[11px] font-semibold text-fg-dim">
            {library.keyLabel ?? 'API Key'}
          </span>
          <input
            type="password"
            value={keyValue}
            placeholder={library.keyPlaceholder ?? '粘贴 API Key / Token'}
            onChange={(event) => onKeyChange(event.currentTarget.value)}
            className="w-full rounded-md border border-border bg-bg-alt px-2.5 py-1.5 text-xs text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none"
          />
          {library.credentialUrl ? (
            <button
              type="button"
              onClick={() => void openExternal(library.credentialUrl!)}
              className="justify-self-start text-[11px] text-accent hover:underline"
            >
              获取 / 管理凭据
            </button>
          ) : null}
        </label>
      )}

      <label className="mt-auto flex items-center justify-between gap-2 rounded border border-border-soft bg-bg-alt px-2.5 py-2">
        <span className="text-xs font-semibold text-fg">在 /mesh-search 中启用</span>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => onToggle(event.currentTarget.checked)}
          className="h-4 w-4 shrink-0 accent-accent"
        />
      </label>
    </section>
  );
}

function MeshLibrarySettings() {
  const [settings, setSettings] = useState<MeshLibraryAccountSettings>(() =>
    loadMeshLibrarySettings(),
  );
  const [query, setQuery] = useState('');
  const [innerTab, setInnerTab] = useState<'enabled' | 'repository'>('enabled');

  const persist = useCallback((next: MeshLibraryAccountSettings) => {
    setSettings(next);
    saveMeshLibrarySettings(next);
  }, []);

  const toggleLibrary = useCallback(
    (id: MeshLibraryId, enabled: boolean) => {
      persist({
        ...settings,
        enabledIds: enabled
          ? Array.from(new Set([...settings.enabledIds, id]))
          : settings.enabledIds.filter((value) => value !== id),
      });
    },
    [persist, settings],
  );

  const setKey = useCallback(
    (id: MeshLibraryId, value: string) => {
      const apiKeys = { ...settings.apiKeys };
      const trimmed = value.trim();
      if (trimmed) apiKeys[id] = value;
      else delete apiKeys[id];
      persist({ ...settings, apiKeys });
    },
    [persist, settings],
  );

  // "已启用" only lists libraries that genuinely work end to end: toggled on AND
  // actually able to run an in-app search/download (key configured where the API
  // requires one). Toggling a library on without its key keeps it out of here.
  const usableLibraries = useMemo(
    () =>
      MESH_LIBRARIES.filter(
        (library) =>
          settings.enabledIds.includes(library.id) &&
          meshLibraryUsable(library.id, settings),
      ),
    [settings],
  );

  // Enabled-but-not-yet-usable libraries (e.g. toggled on but missing API key)
  // so the user understands why they are not in the working set.
  const pendingLibraries = useMemo(
    () =>
      MESH_LIBRARIES.filter(
        (library) =>
          settings.enabledIds.includes(library.id) &&
          !meshLibraryUsable(library.id, settings),
      ),
    [settings],
  );

  const filteredRepository = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return MESH_LIBRARIES;
    return MESH_LIBRARIES.filter((library) =>
      `${library.label} ${library.note} ${MESH_LIBRARY_CATEGORY_LABELS[library.category]}`
        .toLowerCase()
        .includes(q),
    );
  }, [query]);

  const usableCount = usableLibraries.length;
  const enabledCount = settings.enabledIds.length;

  return (
    <div className="grid gap-4">
      <section className="rounded-md border border-border bg-panel-2 p-4">
        <div className="text-sm font-semibold text-fg">在线模型库</div>
        <div className="mt-1 text-xs leading-relaxed text-fg-faint">
          配置 /mesh-search 使用的在线 3D 模型库。在 AI 输入框发送
          <code className="mx-1 rounded bg-bg-alt px-1 py-0.5 font-mono text-accent">
            /mesh-search 关键字
          </code>
          会按关键字搜索「已启用」中真正可用的库；可直接下载的结果会下载到工作区并在会话中预览。
        </div>
        <div className="mt-2 text-[11px] text-fg-faint">
          可用 {usableCount} 个 · 已开启 {enabledCount} 个 · 仓库共 {MESH_LIBRARIES.length} 个
        </div>
      </section>

      <div className="flex gap-1 rounded-lg border border-border bg-panel-2 p-1">
        {(
          [
            { id: 'enabled' as const, label: '已启用', count: usableCount },
            { id: 'repository' as const, label: '仓库', count: MESH_LIBRARIES.length },
          ]
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setInnerTab(tab.id)}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors',
              innerTab === tab.id
                ? 'bg-accent/15 text-accent'
                : 'text-fg-faint hover:text-fg',
            )}
          >
            <span>{tab.label}</span>
            <span
              className={cn(
                'rounded px-1.5 py-0.5 text-[10px]',
                innerTab === tab.id
                  ? 'bg-accent/20 text-accent'
                  : 'bg-bg-alt text-fg-faint',
              )}
            >
              {tab.count}
            </span>
          </button>
        ))}
      </div>

      {innerTab === 'enabled' ? (
        <MeshLibraryEnabledTab
          usableLibraries={usableLibraries}
          pendingLibraries={pendingLibraries}
          settings={settings}
          onToggle={toggleLibrary}
          onKeyChange={setKey}
          onBrowseRepository={() => setInnerTab('repository')}
        />
      ) : (
        <MeshLibraryRepositoryTab
          libraries={filteredRepository}
          settings={settings}
          query={query}
          onQueryChange={setQuery}
          onToggle={toggleLibrary}
          onKeyChange={setKey}
        />
      )}

      <div className="grid gap-2 rounded-md border border-border bg-panel-2 p-3 sm:grid-cols-2">
        <label className="flex items-center justify-between gap-2 rounded border border-border-soft bg-bg-alt px-3 py-2">
          <span className="text-xs font-semibold text-fg">自动下载可下载结果</span>
          <input
            type="checkbox"
            checked={settings.autoDownload}
            onChange={(event) =>
              persist({ ...settings, autoDownload: event.currentTarget.checked })
            }
            className="h-4 w-4 shrink-0 accent-accent"
          />
        </label>
        <label className="flex items-center justify-between gap-2 rounded border border-border-soft bg-bg-alt px-3 py-2">
          <span className="text-xs font-semibold text-fg">每个库返回上限</span>
          <input
            type="number"
            min={1}
            max={24}
            value={settings.perLibraryLimit}
            onChange={(event) =>
              persist({
                ...settings,
                perLibraryLimit: Number(event.currentTarget.value) || 6,
              })
            }
            className="w-16 rounded-md border border-border bg-bg px-2 py-1 text-xs text-fg focus:border-accent focus:outline-none"
          />
        </label>
      </div>
    </div>
  );
}

function MeshLibraryEnabledTab({
  usableLibraries,
  pendingLibraries,
  settings,
  onToggle,
  onKeyChange,
  onBrowseRepository,
}: {
  usableLibraries: MeshLibraryDefinition[];
  pendingLibraries: MeshLibraryDefinition[];
  settings: MeshLibraryAccountSettings;
  onToggle: (id: MeshLibraryId, enabled: boolean) => void;
  onKeyChange: (id: MeshLibraryId, value: string) => void;
  onBrowseRepository: () => void;
}) {
  if (usableLibraries.length === 0 && pendingLibraries.length === 0) {
    return (
      <div className="grid gap-2 rounded-lg border border-border bg-bg-alt px-4 py-8 text-center">
        <p className="text-xs text-fg-faint">
          还没有真正可用的模型库。前往「仓库」开启并配置好 API Key 后，能真正搜索 / 下载的库会出现在这里。
        </p>
        <button
          type="button"
          onClick={onBrowseRepository}
          className="justify-self-center rounded-md border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs font-semibold text-accent hover:bg-accent/20"
        >
          去仓库添加
        </button>
      </div>
    );
  }
  return (
    <div className="grid gap-3">
      {usableLibraries.length > 0 ? (
        <div className="grid gap-2.5 lg:grid-cols-2 2xl:grid-cols-3">
          {usableLibraries.map((library) => (
            <MeshLibraryCard
              key={library.id}
              library={library}
              settings={settings}
              onToggle={(enabled) => onToggle(library.id, enabled)}
              onKeyChange={(value) => onKeyChange(library.id, value)}
            />
          ))}
        </div>
      ) : null}

      {pendingLibraries.length > 0 ? (
        <section className="grid gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
          <div className="text-[11px] font-semibold text-amber-300">
            已开启但还不能用（需补全 API Key）
          </div>
          <div className="grid gap-2.5 lg:grid-cols-2 2xl:grid-cols-3">
            {pendingLibraries.map((library) => (
              <MeshLibraryCard
                key={library.id}
                library={library}
                settings={settings}
                onToggle={(enabled) => onToggle(library.id, enabled)}
                onKeyChange={(value) => onKeyChange(library.id, value)}
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function MeshLibraryRepositoryTab({
  libraries,
  settings,
  query,
  onQueryChange,
  onToggle,
  onKeyChange,
}: {
  libraries: MeshLibraryDefinition[];
  settings: MeshLibraryAccountSettings;
  query: string;
  onQueryChange: (value: string) => void;
  onToggle: (id: MeshLibraryId, enabled: boolean) => void;
  onKeyChange: (id: MeshLibraryId, value: string) => void;
}) {
  return (
    <div className="grid gap-3">
      <div className="relative">
        <Search
          size={14}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-faint"
        />
        <input
          type="text"
          value={query}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          placeholder="搜索模型库名称、用途..."
          className="w-full rounded-lg border border-border bg-bg-alt py-2 pl-9 pr-3 text-sm text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none"
        />
      </div>

      {libraries.length === 0 ? (
        <p className="rounded-lg border border-border bg-bg-alt px-4 py-6 text-center text-xs text-fg-faint">
          没有匹配的模型库。
        </p>
      ) : (
        <div className="grid gap-2.5 lg:grid-cols-2 2xl:grid-cols-3">
          {libraries.map((library) => (
            <MeshLibraryCard
              key={library.id}
              library={library}
              settings={settings}
              onToggle={(enabled) => onToggle(library.id, enabled)}
              onKeyChange={(value) => onKeyChange(library.id, value)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ProbeBadge({ result }: { result?: ProjectMcpProbeResult }) {
  if (!result) {
    return (
      <span className="rounded border border-border-soft bg-bg-alt px-2 py-0.5 text-[11px] text-fg-faint">
        未探测
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
      {result.ok ? '已连接' : '失败'}
    </span>
  );
}

function LspProbeBadge({ result }: { result?: ProjectLspProbeResult }) {
  if (!result) {
    return (
      <span className="rounded border border-border-soft bg-bg-alt px-2 py-0.5 text-[11px] text-fg-faint">
        未检测
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
      {result.ok ? '命令可用' : '未找到'}
    </span>
  );
}

function McpTrustBadge({ trust }: { trust: McpServerDefinition['trust'] }) {
  return (
    <span className="shrink-0 rounded border border-border-soft bg-bg-alt px-1.5 py-0.5 text-[10px] text-fg-faint">
      {trust === 'official'
        ? '官方'
        : trust === 'curated'
          ? '精选'
          : trust === 'registry'
            ? 'Registry'
            : '社区'}
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
            placeholder="搜索 MCP 名称、用途、命令、URL 或分类..."
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
          刷新在线 MCP
        </button>
      </div>

      {error ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-100">
          在线 MCP Registry 加载失败：{error}
        </div>
      ) : null}

      {loading ? (
        <div className="rounded-lg border border-border-soft bg-bg-alt px-3 py-2 text-[11px] text-fg-faint">
          正在加载在线 MCP Registry...
        </div>
      ) : null}

      {servers.length === 0 ? (
        <p className="rounded-lg border border-border bg-bg-alt px-4 py-6 text-center text-xs text-fg-faint">
          没有匹配的 MCP。
        </p>
      ) : (
        <div className="grid gap-2.5 lg:grid-cols-2 2xl:grid-cols-3">
          {servers.map((server) => {
            const installed = configuredIds.has(server.id);
            const installable =
              server.installable !== false &&
              server.transport === 'stdio' &&
              server.command.trim().length > 0;
            const connectionText = installable
              ? mcpCommandText(server)
              : server.connectionUrl ?? server.url ?? server.sourceUrl;
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
                    title="打开来源"
                    aria-label="打开来源"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border-soft bg-bg-alt text-fg-faint hover:border-accent hover:text-fg"
                  >
                    <ExternalLink size={13} />
                  </button>
                </div>

                <div className="flex flex-wrap gap-1">
                  <span className="rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">
                    {MCP_CATEGORY_LABELS[server.category]}
                  </span>
                  {!installable ? (
                    <span className="rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-300">
                      远程 {server.transport}
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
                      title={`需要配置 ${spec.label}`}
                    >
                      需 {spec.label}
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
                          已安装
                        </span>
                        <button
                          type="button"
                          onClick={() => onUninstall(server.id)}
                          className="inline-flex items-center gap-1 rounded-md border border-border bg-bg-alt px-2 py-1 text-[11px] text-fg-dim hover:border-red-400 hover:text-red-300"
                        >
                          <Trash2 size={12} />
                          卸载
                        </button>
                      </>
                    ) : installable ? (
                      <button
                        type="button"
                        onClick={() => onInstall(server)}
                        className="inline-flex items-center gap-1 rounded-md border border-accent/60 bg-accent/10 px-2 py-1 text-[11px] font-semibold text-fg hover:bg-accent/20"
                      >
                        <Download size={12} />
                        安装
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void copyConnection(server, connectionText)}
                        className="inline-flex items-center gap-1 rounded-md border border-accent/60 bg-accent/10 px-2 py-1 text-[11px] font-semibold text-fg hover:bg-accent/20"
                      >
                        {copied ? <Check size={12} /> : <Copy size={12} />}
                        {copied ? '已复制' : '复制地址'}
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

function UnrealMcpQuickSetup({
  busy,
  step,
  result,
  error,
  onRun,
  onOpenFile,
}: {
  busy: boolean;
  step: string | null;
  result: UeMcpSetupResult | null;
  error: string | null;
  onRun: () => void;
  onOpenFile: (path: string) => void;
}) {
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
    <section className="grid gap-3 rounded-md border border-accent/40 bg-accent/5 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-fg">
            <Rocket size={16} className="text-accent" />
            一键配置 Unreal MCP
          </div>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-fg-faint">
            自动下载并校验版本无关的 Unreal MCP 服务（支持 UE 4.25–5.8），在 .uproject
            中启用 RemoteControl / EditorScripting / Python 插件，写入 RemoteControl
            自启动、远程 Python 执行和控制台命令权限，并合并项目 .mcp.json、登记到本项目的
            MCP 列表。全程无需手动操作。
          </p>
        </div>
        <button
          type="button"
          onClick={onRun}
          disabled={busy || !desktop}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-accent bg-accent/20 px-3 py-2 text-xs font-semibold text-fg hover:bg-accent/30 disabled:opacity-50"
        >
          {busy ? (
            <RefreshCw size={14} className="animate-spin" />
          ) : (
            <Download size={14} />
          )}
          {busy ? '配置中...' : '一键安装并配置'}
        </button>
      </div>

      {!desktop ? (
        <div className="rounded border border-border-soft bg-bg-alt px-3 py-2 text-[11px] text-fg-faint">
          一键安装需要在桌面应用中运行（浏览器环境无法下载二进制或写入工程配置）。
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
            配置完成
            {result.engineAssociation ? `（引擎 ${result.engineAssociation}）` : ''}
          </div>
          {result.configuredPlugins.length > 0 ? (
            <div>
              已启用插件：
              <span className="text-fg">{result.configuredPlugins.join('、')}</span>
            </div>
          ) : null}
          {result.changedFiles.length > 0 ? (
            <div className="grid gap-1">
              <span>已写入/更新：</span>
              <ul className="grid gap-0.5">
                {result.changedFiles.map((file) => (
                  <li key={file} className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => onOpenFile(file)}
                      title="在文件管理器中显示"
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
                  ? '已检测到 Unreal Editor 正在运行或启动中；插件或 RemoteControl / Python 权限配置已变更，必须重启 Unreal Editor 后生效。'
                  : '插件或 RemoteControl / Python 权限配置已写入；如果 Unreal Editor 已经打开，请重启后生效，未打开则下次启动自动生效。'}
                MCP 服务支持懒连接，无需手动重启 CLI。
              </span>
            </div>
          ) : null}
          {result.notes.length > 0 ? (
            <div className="text-fg-faint">
              说明：{result.notes.join('；')}
            </div>
          ) : null}
          {visibleWarnings.length > 0 ? (
            <div className="text-amber-300/90">
              提示：{visibleWarnings.join('；')}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export default function ProjectSettingsModal({
  workspace,
  onClose,
  onWorkspaceUpdated,
}: ProjectSettingsModalProps) {
  const [tab, setTab] = useState<ProjectSettingsTab>('overview');
  const locale = useStore((s) => s.locale);
  const gameExpertSettings = useStore((s) => s.gameExpertSettings);
  const setGameExpertSettings = useStore((s) => s.setGameExpertSettings);

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
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [lspQuery, setLspQuery] = useState('');
  const [lspSubTab, setLspSubTab] = useState<'installed' | 'registry'>('installed');
  const [skillSubTab, setSkillSubTab] = useState<'installed' | 'registry'>(
    'installed',
  );
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
  const [onlineMcpLoading, setOnlineMcpLoading] = useState(false);
  const [onlineMcpError, setOnlineMcpError] = useState<string | null>(null);
  const [languageScan, setLanguageScan] = useState<ProjectLanguageScan>(() =>
    fallbackLanguageScanForEngine(projectSettingsFromMetadata(workspace.metadata).engine),
  );
  const [ueSetupBusy, setUeSetupBusy] = useState(false);
  const [ueSetupStep, setUeSetupStep] = useState<string | null>(null);
  const [ueSetupResult, setUeSetupResult] = useState<UeMcpSetupResult | null>(null);
  const [ueSetupError, setUeSetupError] = useState<string | null>(null);

  const workspacePath = record?.path || workspace.path || '';
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
  const showGameFeatures = shouldShowGameFeatures(settings, scan);
  const visibleTabs = useMemo(
    () =>
      tabs.filter((item) => !GAME_FEATURE_TABS.has(item.id) || showGameFeatures),
    [showGameFeatures],
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

  const updateGameFeatures = useCallback(
    (patch: Partial<ProjectSettings['gameFeatures']>) => {
      setSettings((current) => ({
        ...current,
        gameFeatures: { ...current.gameFeatures, ...patch },
      }));
      setDirty(true);
    },
    [],
  );

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

  const refresh = useCallback(async () => {
    setLoading(true);
    setStatus(null);
    try {
      const latestRecord = await historyStore.getWorkspace(workspace.id);
      setRecord(latestRecord);
      const baseSettings = projectSettingsFromMetadata(
        latestRecord?.metadata ?? workspace.metadata,
      );
      let nextScan: ProjectEnvironmentScan | null = null;
      if ((latestRecord?.path || workspace.path || '').trim()) {
        nextScan = await scanProjectEnvironment(latestRecord?.path || workspace.path);
        setScan(nextScan);
        if (tauriAvailable()) {
          try {
            const nextLanguageScan = await scanWorkspaceLanguages(
              latestRecord?.path || workspace.path,
              nextScan,
            );
            setLanguageScan(nextLanguageScan);
          } catch (err) {
            setLanguageScan({
              ...fallbackLanguageScanForEngine(nextScan.engine.engine),
              error: describeError(err),
            });
          }
        } else {
          setLanguageScan(fallbackLanguageScanForEngine(nextScan.engine.engine));
        }
      } else {
        setScan(null);
        setLanguageScan(fallbackLanguageScanForEngine(baseSettings.engine));
      }
      const nextSettings = nextScan
        ? settingsWithDetectedGameFeatures(baseSettings, nextScan)
        : baseSettings;
      setSettings(nextSettings);
      syncProjectGameFeaturesToRuntime(nextSettings);
      setDirty(false);
    } catch (err) {
      setStatus(`检测失败：${describeError(err)}`);
    } finally {
      setLoading(false);
    }
  }, [workspace.id, workspace.metadata, workspace.path]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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

  const loadOnlineMcpServers = useCallback(async (signal?: AbortSignal) => {
    setOnlineMcpLoading(true);
    setOnlineMcpError(null);
    try {
      const servers = await loadMcpRegistryServers(signal);
      if (signal?.aborted) return;
      setOnlineMcpServers(servers);
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
    void loadOnlineMcpServers(controller.signal);
    return () => controller.abort();
  }, [loadOnlineMcpServers, mcpSubTab, onlineMcpServers.length, tab]);

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
    if (GAME_FEATURE_TABS.has(tab) && !showGameFeatures) {
      setTab('overview');
    }
  }, [showGameFeatures, tab]);

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
    candidateIds.forEach((id) => lspAvailabilityProbingRef.current.add(id));
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
      candidateIds.forEach((id) => lspAvailabilityProbingRef.current.delete(id));
      setLspAvailabilityProbingIds((current) =>
        current.filter((id) => !candidateIds.includes(id)),
      );
    })();

    return () => {
      cancelled = true;
      candidateIds.forEach((id) => lspAvailabilityProbingRef.current.delete(id));
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
        syncProjectGameFeaturesToRuntime(savedSettings);
        useStore.setState((state) => ({
          workspaces: state.workspaces.map((item) =>
            item.id === summary.id ? summary : item,
          ),
        }));
        onWorkspaceUpdated?.(summary);
        setDirty(false);
        setStatus('已保存');
      } catch (err) {
        setStatus(`保存失败：${describeError(err)}`);
      } finally {
        setSaving(false);
      }
    },
    [onWorkspaceUpdated, workspace.id],
  );

  const applyRecommended = useCallback(async () => {
    if (!scan) return;
    const next = mergeRecommendedMcpServers(settings, scan);
    setSettings(next);
    await persistSettings(next);
    setStatus('推荐 MCP 配置已应用');
  }, [persistSettings, scan, settings]);

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
    const picked = await pickFolder('选择要加入项目的文件夹');
    if (!picked) return;
    const existingKeys = new Set(
      [workspacePath, ...settings.folders].map(workspacePathKey),
    );
    if (existingKeys.has(workspacePathKey(picked))) {
      setStatus('该文件夹已在项目中');
      return;
    }
    await persistFolders([...settings.folders, picked]);
    setStatus('已添加项目文件夹');
  }, [persistFolders, settings.folders, workspacePath]);

  const removeFolder = useCallback(
    async (path: string) => {
      const key = workspacePathKey(path);
      await persistFolders(
        settings.folders.filter((item) => workspacePathKey(item) !== key),
      );
      setStatus('已移除项目文件夹');
    },
    [persistFolders, settings.folders],
  );

  const addCustomServer = useCallback(() => {
    const id = `custom-${Date.now().toString(36)}`;
    updateMcp({
      enabled: true,
      servers: [
        ...settings.mcp.servers,
        {
          id,
          label: '自定义 MCP',
          source: 'custom',
          enabled: true,
          transport: 'stdio',
          command: '',
          args: [],
          env: {},
        },
      ],
    });
  }, [settings.mcp.servers, updateMcp]);

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
        definition.transport !== 'stdio' ||
        !definition.command.trim()
      ) {
        setStatus(`${definition.title} 是远程 MCP Registry 条目；已提供地址复制，不写入项目配置。`);
        return;
      }
      if (configuredMcpIds.has(definition.id)) {
        setStatus(`${definition.title} 已在已安装列表中`);
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
        requiresUserApproval: definition.requiresUserApproval,
      };
      updateMcp({
        enabled: true,
        servers: [...settings.mcp.servers, serverConfig],
      });
      const needsEnv = (definition.requiredEnv ?? []).length > 0;
      setStatus(
        needsEnv
          ? `${definition.title} 已添加；请在「已安装」中填写所需环境变量后再探测。`
          : `${definition.title} 已添加到已安装列表`,
      );
      setMcpSubTab('installed');
    },
    [configuredMcpIds, settings.mcp.servers, updateMcp],
  );

  const probeEnabledServers = useCallback(async () => {
    const enabledServers = settings.mcp.enabled
      ? settings.mcp.servers.filter((server) => server.enabled)
      : [];
    if (!workspacePath.trim() || enabledServers.length === 0) {
      setStatus('没有可探测的 MCP server');
      return;
    }
    setProbing(true);
    setStatus('探测中...');
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
    setStatus(`探测完成：${okCount}/${results.length} 已连接`);
    setProbing(false);
  }, [persistSettings, settings, workspacePath]);

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
      setStatus('没有可应用的 LSP 推荐');
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
    setStatus(`已应用 ${additions.length} 个 LSP 推荐`);
  }, [
    configuredLspById,
    lspConfigFromDefinition,
    languageScan.languages,
    persistSettings,
    recommendedLspIds,
    settings,
  ]);

  const probeEnabledLspServers = useCallback(async () => {
    const enabledServers = settings.lsp.enabled
      ? settings.lsp.servers.filter((server) => server.enabled)
      : [];
    if (enabledServers.length === 0) {
      setStatus('没有可检测的 LSP');
      return;
    }
    setLspProbing(true);
    setStatus('LSP 检测中...');
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
    setStatus(`LSP 检测完成：${okCount}/${results.length} 命令可用`);
    setLspProbing(false);
  }, [persistSettings, settings]);

  const installLspServer = useCallback(
    async (definition: RankedLspServerDefinition) => {
      const commands = definition.installCommands ?? [];
      if (commands.length === 0) {
        setStatus(`${definition.title} 暂不支持一键安装，请按安装说明手动安装。`);
        return;
      }
      if (!tauriAvailable()) {
        setStatus('一键安装需要在桌面应用中运行。');
        return;
      }
      const commandPreview = commands.map(installCommandText).join('\n');
      if (
        !settings.automation.allowThirdPartyInstall &&
        typeof window !== 'undefined' &&
        !window.confirm(
          `将安装 ${definition.title}，可能会下载第三方依赖。\n\n将按当前平台选择并执行：\n${commandPreview}\n\n继续？`,
        )
      ) {
        return;
      }

      setLspInstallingId(definition.id);
      setStatus(`正在安装 ${definition.title}...`);
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
          setStatus(`${definition.title} 安装失败：${installResult.message}`);
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
            ? `${definition.title} 已安装并启用`
            : `${definition.title} 已安装；检测未通过：${probe.message}`,
        );
      } catch (err) {
        setStatus(`${definition.title} 安装失败：${describeError(err)}`);
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
    ],
  );

  const isUnrealProject =
    (scan?.engine.engine ?? settings.engine) === 'unreal';

  // True one-click flow: download+verify binary → run --setup-project →
  // register/update the project MCP server → probe → surface a restart hint.
  const setupUnrealMcp = useCallback(async () => {
    if (!tauriAvailable()) {
      setUeSetupError('一键安装需要在桌面应用中运行。');
      return;
    }
    if (!workspacePath.trim()) {
      setUeSetupError('未指定工作区路径。');
      return;
    }
    setUeSetupBusy(true);
    setUeSetupError(null);
    setUeSetupResult(null);
    setStatus(null);
    try {
      setUeSetupStep('正在下载并校验 UE MCP 二进制...');
      const binary = await ueMcpEnsureBinary();

      setUeSetupStep('正在配置工程（启用插件 / 写入 RemoteControl 与 .mcp.json）...');
      const result = await ueMcpSetupProject({
        rootPath: workspacePath,
        serverCommand: binary.path,
        enablePython: true,
        writeMcpConfig: true,
      });
      setUeSetupResult(result);
      if (!result.ok) {
        setUeSetupError(result.error || 'UE MCP 配置失败。');
        return;
      }

      // Register / update the project MCP server so it persists + is probeable.
      const serverConfig: ProjectMcpServerConfig = {
        id: UE_MCP_SERVER_ID,
        label: 'Unreal MCP (全版本)',
        description: `版本无关的 Unreal RemoteControl MCP（${binary.version}），支持 UE 4.25–5.8。`,
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
      setUeSetupStep('正在探测 MCP 连接...');
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
        ? '请重启 Unreal Editor 后再连接。'
        : ueConfigChanged
          ? '如 Unreal Editor 已经打开，请重启后生效。'
          : '';
      setStatus(
        probe.ok
          ? `Unreal MCP 已配置并连接成功。${restartHint}`
          : `Unreal MCP 已配置；等待 Unreal Editor 启动后即可连接。${restartHint}`,
      );
    } catch (err) {
      setUeSetupError(describeError(err));
    } finally {
      setUeSetupBusy(false);
      setUeSetupStep(null);
    }
  }, [persistSettings, settings, workspacePath]);

  const content = (() => {
    if (tab === 'overview') {
      const detectedEngine = scan?.engine.engine ?? 'unknown';
      const folderEntries = uniqueWorkspaceHistory([
        workspacePath,
        ...settings.folders,
      ]);
      return (
        <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
          <section className="rounded-md border border-border bg-panel-2 p-4 lg:col-span-2">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-semibold text-fg">
                  <FolderOpen size={16} className="text-accent-2" />
                  工作区文件夹
                </div>
                <div className="mt-1 text-xs leading-relaxed text-fg-faint">
                  这里管理项目包含的文件夹。第一个为主目录，其余作为附加目录一起授权给
                  AI。之后新建对话会自动继承这些文件夹。
                </div>
              </div>
              <button
                type="button"
                onClick={() => void addFolder()}
                disabled={saving}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-accent/60 bg-accent/10 px-3 py-1.5 text-xs font-semibold text-fg hover:bg-accent/20 disabled:opacity-50"
              >
                <FolderPlus size={14} />
                添加文件夹
              </button>
            </div>
            <ul className="mt-3 grid gap-2">
              {folderEntries.length === 0 ? (
                <li className="rounded-md border border-dashed border-border-soft bg-bg-alt px-3 py-4 text-center text-xs text-fg-faint">
                  尚未指定文件夹。添加后新建对话会自动使用这些目录。
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
                        {isPrimary ? '主目录' : '附加'}
                      </span>
                      {removable ? (
                        <button
                          type="button"
                          onClick={() => void removeFolder(path)}
                          disabled={saving}
                          title="从项目中移除该文件夹"
                          aria-label="从项目中移除该文件夹"
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

          <section className="rounded-md border border-border bg-panel-2 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-xs font-semibold text-fg-faint">项目类型</div>
                <div className="mt-1 flex items-center gap-2 text-lg font-semibold text-fg">
                  <Gamepad2 size={18} className="text-accent" />
                  {scan?.engine.label ?? '检测中'}
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
            <div className="mt-4 grid gap-2 text-xs text-fg-dim">
              <div className="truncate" title={workspacePath}>
                工作区：{workspacePath || '未指定'}
              </div>
              <div>标记：{scan?.engine.markers.join('、') || '无'}</div>
              <div>推荐 MCP：{scan?.suggestedMcpServers.length ?? 0}</div>
              <div>
                检测语言：
                {languageScan.languages.map((item) => item.label).join('、') || '未识别'}
              </div>
              <div>推荐 LSP：{recommendedLspIds.size}</div>
            </div>
          </section>

          <section className="grid gap-3 rounded-md border border-border bg-panel-2 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-fg">项目 MCP</div>
                <div className="mt-1 text-xs text-fg-faint">{health.detail}</div>
              </div>
              <button
                type="button"
                onClick={() => setTab('mcp')}
                className="rounded-md border border-border bg-bg-alt px-3 py-1.5 text-xs text-fg-dim hover:border-accent hover:text-fg"
              >
                配置
              </button>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="rounded border border-border-soft bg-bg-alt p-3">
                <div className="text-[11px] text-fg-faint">已配置</div>
                <div className="mt-1 text-lg font-semibold text-fg">
                  {settings.mcp.servers.length}
                </div>
              </div>
              <div className="rounded border border-border-soft bg-bg-alt p-3">
                <div className="text-[11px] text-fg-faint">已启用</div>
                <div className="mt-1 text-lg font-semibold text-fg">
                  {settings.mcp.enabled
                    ? settings.mcp.servers.filter((server) => server.enabled).length
                    : 0}
                </div>
              </div>
              <div className="rounded border border-border-soft bg-bg-alt p-3">
                <div className="text-[11px] text-fg-faint">已连接</div>
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
                <div className="text-sm font-semibold text-fg">项目 LSP</div>
                <div className="mt-1 text-xs text-fg-faint">
                  {languageScan.languages.length > 0
                    ? `基于 ${languageScan.languages.length} 种语言排序推荐`
                    : '尚未识别编程语言'}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setTab('lsp')}
                className="rounded-md border border-border bg-bg-alt px-3 py-1.5 text-xs text-fg-dim hover:border-accent hover:text-fg"
              >
                配置
              </button>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="rounded border border-border-soft bg-bg-alt p-3">
                <div className="text-[11px] text-fg-faint">已配置</div>
                <div className="mt-1 text-lg font-semibold text-fg">
                  {settings.lsp.servers.length}
                </div>
              </div>
              <div className="rounded border border-border-soft bg-bg-alt p-3">
                <div className="text-[11px] text-fg-faint">已启用</div>
                <div className="mt-1 text-lg font-semibold text-fg">
                  {settings.lsp.enabled
                    ? settings.lsp.servers.filter((server) => server.enabled).length
                    : 0}
                </div>
              </div>
              <div className="rounded border border-border-soft bg-bg-alt p-3">
                <div className="text-[11px] text-fg-faint">命令可用</div>
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

    if (tab === 'mesh') {
      const detectedEngine = scan?.engine.engine ?? 'unknown';
      const autoMode = settings.automation.autoDetect;
      return (
        <div className="grid gap-4">
          <section className="rounded-md border border-border bg-panel-2 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-fg">Mesh 渠道</div>
                <div className="mt-1 text-xs leading-relaxed text-fg-faint">
                  当前检测：{scan?.engine.label ?? '未识别'}。自动检测开启时，UE /
                  Unity / Godot 项目会默认开启 Mesh 渠道；非游戏项目默认关闭。
                </div>
              </div>
              <span
                className={cn(
                  'rounded border px-2 py-0.5 text-[11px]',
                  detectedEngine === 'unknown'
                    ? 'border-border-soft bg-bg-alt text-fg-faint'
                    : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
                )}
              >
                {autoMode ? '自动检测' : '手动设置'}
              </span>
            </div>
          </section>

          <ToggleRow
            label="启用 Mesh 渠道"
            hint="控制当前项目是否启用 3D 模型生成入口。"
            checked={settings.gameFeatures.meshGeneration}
            onChange={(checked) => updateGameFeatures({ meshGeneration: checked })}
          />

          <div className="rounded-md border border-border bg-panel-2 p-4 text-xs text-fg-faint">
            <span className="inline-flex items-center gap-1 rounded border border-border-soft bg-bg-alt px-2 py-1">
              <Box size={12} />
              Mesh：{settings.gameFeatures.meshGeneration ? '开启' : '关闭'}
            </span>
          </div>

          <ThreeDGenerationSettingsPanel locale={locale} embedded />
        </div>
      );
    }

    if (tab === 'meshLibrary') {
      return <MeshLibrarySettings />;
    }

    if (tab === 'rigging') {
      const detectedEngine = scan?.engine.engine ?? 'unknown';
      const autoMode = settings.automation.autoDetect;
      return (
        <div className="grid gap-4">
          <section className="rounded-md border border-border bg-panel-2 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-fg">绑定渠道</div>
                <div className="mt-1 text-xs leading-relaxed text-fg-faint">
                  当前检测：{scan?.engine.label ?? '未识别'}。自动检测开启时，UE /
                  Unity / Godot 项目会默认开启自动骨骼绑定；非游戏项目默认关闭。
                </div>
              </div>
              <span
                className={cn(
                  'rounded border px-2 py-0.5 text-[11px]',
                  detectedEngine === 'unknown'
                    ? 'border-border-soft bg-bg-alt text-fg-faint'
                    : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
                )}
              >
                {autoMode ? '自动检测' : '手动设置'}
              </span>
            </div>
          </section>

          <ToggleRow
            label="启用绑定渠道"
            hint="控制当前项目是否启用自动绑骨流程。"
            checked={settings.gameFeatures.rigging}
            onChange={(checked) => updateGameFeatures({ rigging: checked })}
          />

          <div className="rounded-md border border-border bg-panel-2 p-4 text-xs text-fg-faint">
            <span className="inline-flex items-center gap-1 rounded border border-border-soft bg-bg-alt px-2 py-1">
              <Bone size={12} />
              绑定：{settings.gameFeatures.rigging ? '开启' : '关闭'}
            </span>
          </div>

          <RiggingSettingsPanel locale={locale} embedded />
        </div>
      );
    }

    if (tab === 'gameExperts') {
      const detectedEngine = scan?.engine.engine ?? 'unknown';
      const autoMode = settings.automation.autoDetect;
      return (
        <div className="grid gap-4">
          <section className="rounded-md border border-border bg-panel-2 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-fg">游戏专家</div>
                <div className="mt-1 text-xs leading-relaxed text-fg-faint">
                  当前检测：{scan?.engine.label ?? '未识别'}。自动检测开启时，UE /
                  Unity / Godot 项目会默认开启游戏专家，并自动选择对应引擎。
                </div>
              </div>
              <span
                className={cn(
                  'rounded border px-2 py-0.5 text-[11px]',
                  detectedEngine === 'unknown'
                    ? 'border-border-soft bg-bg-alt text-fg-faint'
                    : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
                )}
              >
                {autoMode ? '自动检测' : '手动设置'}
              </span>
            </div>
          </section>

          <ToggleRow
            label="启用游戏专家"
            hint="控制当前项目是否启用游戏专家，并在游戏项目中自动选择对应引擎。"
            checked={settings.gameFeatures.gameExperts}
            onChange={(checked) => updateGameFeatures({ gameExperts: checked })}
          />

          <div className="grid gap-3 rounded-md border border-border bg-panel-2 p-4">
            <SettingsRow
              label="游戏专家引擎"
              hint="自动检测开启时会跟随项目类型；非游戏项目使用自动。"
            >
              <select
                value={settings.gameFeatures.gameExpertEngine}
                onChange={(event) => {
                  const gameExpertEngine = event.currentTarget
                    .value as ProjectSettings['gameFeatures']['gameExpertEngine'];
                  updateGameFeatures({
                    gameExpertEngine,
                  });
                }}
                className="h-9 w-full rounded-md border border-border bg-bg px-2 text-sm text-fg outline-none focus:border-accent"
              >
                <option value="auto">自动</option>
                <option value="unity">Unity</option>
                <option value="unreal">Unreal / UE</option>
                <option value="godot">Godot</option>
              </select>
            </SettingsRow>
            <div className="flex flex-wrap gap-2 text-[11px] text-fg-faint">
              <span className="inline-flex items-center gap-1 rounded border border-border-soft bg-bg-alt px-2 py-1">
                <Gamepad2 size={12} />
                专家：{settings.gameFeatures.gameExperts ? '开启' : '关闭'}
              </span>
            </div>
          </div>

          <GameExpertSettingsPanel
            locale={locale}
            settings={gameExpertSettings}
            setSettings={setGameExpertSettings}
            embedded
          />
        </div>
      );
    }

    if (tab === 'commands') {
      return <ProjectCommandsSettings />;
    }

    if (tab === 'mcp') {
      return (
        <div className="grid gap-4">
          {isUnrealProject ? (
            <UnrealMcpQuickSetup
              busy={ueSetupBusy}
              step={ueSetupStep}
              result={ueSetupResult}
              error={ueSetupError}
              onRun={setupUnrealMcp}
              onOpenFile={(path) => void openLocalPath(path, { reveal: true })}
            />
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <ToggleRow
              label="启用项目 MCP"
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
              {probing ? '探测中...' : '探测已启用 MCP'}
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
                    应用推荐配置
                  </button>
                  <button
                    type="button"
                    onClick={() => setMcpSubTab('registry')}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-bg-alt px-3 py-1.5 text-xs text-fg-dim hover:border-accent hover:text-fg"
                  >
                    <Search size={13} />
                    浏览仓库
                  </button>
                  <button
                    type="button"
                    onClick={addCustomServer}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-bg-alt px-3 py-1.5 text-xs text-fg-dim hover:border-accent hover:text-fg"
                  >
                    <Plus size={13} />
                    新增自定义
                  </button>
                </div>
              </div>

              <div className="grid gap-3">
                {settings.mcp.servers.length === 0 ? (
                  <div className="rounded-md border border-border-soft bg-bg-alt p-4 text-sm text-fg-faint">
                    当前项目未配置 MCP。切换到「仓库」浏览并安装。
                  </div>
                ) : (
                  settings.mcp.servers.map((server) => {
                    const commandId = fieldId('mcp-command', server.id);
                    const argsId = fieldId('mcp-args', server.id);
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
                                title={`MCP 版本 ${server.serverVersion}`}
                              >
                                v{server.serverVersion}
                              </span>
                            ) : null}
                            {server.engineAssociation ? (
                              <span
                                className="shrink-0 rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent"
                                title={`已对 Unreal Engine ${server.engineAssociation} 完成配置`}
                              >
                                引擎 {server.engineAssociation}
                              </span>
                            ) : null}
                          </label>
                          <div className="flex items-center gap-2">
                            <ProbeBadge result={server.lastProbe} />
                            <button
                              type="button"
                              title="卸载"
                              aria-label="卸载"
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
                        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
                          <SettingsRow label="命令">
                            <input
                              id={commandId}
                              value={server.command ?? ''}
                              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                updateServer(server.id, { command: event.currentTarget.value })
                              }
                              className="w-full rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-xs text-fg outline-none focus:border-accent"
                            />
                          </SettingsRow>
                          <SettingsRow label="参数" hint="空格分隔；工作区可用 {workspace}">
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
                        {server.env && Object.keys(server.env).length > 0 ? (
                          <div className="grid gap-2">
                            {Object.entries(server.env).map(([key, value]) => (
                              <SettingsRow key={key} label={key}>
                                <input
                                  value={value}
                                  type={/token|key|secret|password/i.test(key) ? 'password' : 'text'}
                                  placeholder="填写环境变量值"
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
                          最近探测：{formatTime(server.lastProbe?.checkedAtMs)}
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
              onRefresh={() => void loadOnlineMcpServers()}
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
        languageScan.languages
          .slice(0, 12)
          .map((item) => `${item.label}${item.fileCount ? ` ${item.fileCount}` : ''}`)
          .join('、') || '未识别';
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
                  当前语言：{languageText}。推荐项按检测语言和推荐度排序；可搜索全部 LSP。
                </div>
                {languageScan.error ? (
                  <div className="mt-2 text-[11px] text-amber-300">
                    语言扫描降级：{languageScan.error}
                  </div>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2 text-[11px]">
                <span className="rounded border border-border-soft bg-bg-alt px-2 py-1 text-fg-faint">
                  扫描 {languageScan.filesScanned} 文件
                </span>
                <span className="rounded border border-accent/40 bg-accent/10 px-2 py-1 text-accent">
                  推荐 {recommendedLspIds.size}
                </span>
                <span className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-emerald-300">
                  已启用 {enabledCount}
                </span>
                <span className="rounded border border-border-soft bg-bg-alt px-2 py-1 text-fg-faint">
                  可用 {availableCount}
                </span>
              </div>
            </div>
          </section>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <ToggleRow
              label="启用项目 LSP"
              hint="控制当前项目是否允许自动启动/使用已启用的 LSP 配置。"
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
              {lspProbing ? '检测中...' : '检测已启用 LSP'}
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
                应用推荐 LSP
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
                placeholder="搜索语言、LSP、命令或安装方式..."
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
                  扫描已截断
                </span>
              ) : null}
            </div>
          ) : null}

          {lspSubTab === 'installed' ? (
            installedLspIds.size === 0 ? (
              <p className="rounded-lg border border-border bg-bg-alt px-4 py-6 text-center text-xs text-fg-faint">
                暂无已安装的 LSP。切换到「仓库」tab 添加并安装，检测通过后会显示在这里。
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
                                    推荐
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
                                检测中
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
                              {installing ? '安装中...' : '安装'}
                            </button>
                          ) : null}
                        <button
                            type="button"
                            disabled={autoProbing || saving}
                            onClick={() => probeEnabledLspServers()}
                            className="inline-flex items-center gap-1 rounded-md border border-border bg-bg-alt px-2.5 py-1 text-[11px] text-fg-dim hover:border-accent hover:text-fg disabled:opacity-50"
                          >
                            <Terminal size={11} />
                            检测
                          </button>
                        </div>
                        <details className="group">
                          <summary className="cursor-pointer select-none text-[11px] text-fg-faint hover:text-fg">
                            命令/参数
                          </summary>
                          <div className="mt-2 grid gap-2">
                            <SettingsRow label="命令">
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
                            <SettingsRow label="参数" hint="空格分隔；按 LSP stdio 启动参数填写">
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
                              安装：{installResult.ok ? '成功' : '失败'} · {installResult.message}
                            </div>
                          ) : null}
                          <div>
                            最近检测：{formatTime(probeResult?.checkedAtMs)}
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
              没有匹配的 LSP。
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
                                推荐
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
                            检测中
                          </span>
                        ) : (
                          <LspProbeBadge result={probeResult} />
                        )}
                        <button
                          type="button"
                          onClick={() => void openExternal(server.sourceUrl)}
                          title="打开来源"
                          aria-label="打开来源"
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
                          ? '官方'
                          : server.trust === 'curated'
                            ? '精选'
                            : '社区'}
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
                              ? '命令已可用，无需安装'
                              : autoInstallCommand
                              ? '一键安装并启用'
                              : '该 LSP 暂不支持自动安装'
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
                          {commandAvailable ? '已安装' : installing ? '安装中' : '一键安装'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setLspServerEnabled(server, !checked)}
                          className="rounded-md border border-border bg-bg-alt px-2 py-1 text-[11px] text-fg-dim hover:border-accent hover:text-fg"
                        >
                          {checked ? '关闭' : '启用'}
                        </button>
                      </div>
                      <details className="group">
                        <summary className="cursor-pointer select-none text-[11px] text-fg-faint hover:text-fg">
                          命令/参数
                        </summary>
                        <div className="mt-2 grid gap-2">
                          <SettingsRow label="命令">
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
                          <SettingsRow label="参数" hint="空格分隔；按 LSP stdio 启动参数填写">
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
                          安装：{installResult.ok ? '成功' : '失败'} · {installResult.message}
                        </div>
                      ) : null}
                      <div>
                        最近检测：{formatTime(probeResult?.checkedAtMs)}
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
              项目 Skill 的启用状态随项目配置保存；全局 Skill 对所有项目可见。
            </div>
            {tauriAvailable() ? (
              <button
                type="button"
                onClick={() => void loadGlobalSkillTargets()}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-bg-alt px-3 py-1.5 text-xs text-fg-dim hover:border-accent hover:text-fg"
              >
                <RefreshCw size={13} />
                刷新全局
              </button>
            ) : null}
          </div>

          <ProjectSubTabBar
            active={skillSubTab}
            onChange={setSkillSubTab}
            installedCount={projectSkillCount + globalSkillCount}
          />

          {skillSubTab === 'installed' ? (
            <div className="grid gap-5">
              <section className="grid gap-3">
                <div className="flex items-center gap-2">
                  <Box size={14} className="text-accent" />
                  <span className="text-sm font-semibold text-fg">本项目 Skill</span>
                  <span className="rounded border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-300">
                    项目
                  </span>
                </div>
                {(scan?.skillRoots ?? []).length === 0 ? (
                  <p className="rounded-md border border-border-soft bg-bg-alt px-3 py-4 text-center text-xs text-fg-faint">
                    未检测到项目 Skill 目录。
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
                              项目
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
                            {root.exists ? `${root.skillCount} 个` : '未创建'}
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
                            {projectSkillEmptyText(root.label)}
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
                  <span className="text-sm font-semibold text-fg">全局 Skill</span>
                  <span className="rounded border border-violet-500/40 bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-300">
                    全局
                  </span>
                </div>
                {!tauriAvailable() ? (
                  <p className="rounded-md border border-border-soft bg-bg-alt px-3 py-4 text-center text-xs text-fg-faint">
                    全局 Skill 仅在桌面应用中可见。
                  </p>
                ) : globalSkillTargets.length === 0 ? (
                  <p className="rounded-md border border-border-soft bg-bg-alt px-3 py-4 text-center text-xs text-fg-faint">
                    未检测到全局 Skill 目录。
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
                            全局
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
                          {target.exists ? `${target.skillCount} 个` : '未创建'}
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
          label="自动检测项目类型"
          checked={settings.automation.autoDetect}
          onChange={(checked) => updateAutomation({ autoDetect: checked })}
        />
        <ToggleRow
          label="自动写入推荐 MCP 配置"
          hint="只写项目配置，不安装第三方依赖。"
          checked={settings.automation.autoConfigureRecommendedMcp}
          onChange={(checked) =>
            updateAutomation({ autoConfigureRecommendedMcp: checked })
          }
        />
        <ToggleRow
          label="允许自动启动项目 MCP"
          checked={settings.automation.autoStartMcp}
          onChange={(checked) => updateAutomation({ autoStartMcp: checked })}
        />
        <ToggleRow
          label="允许第三方依赖安装"
          hint="涉及 npm、uvx、插件安装时仍需确认。"
          checked={settings.automation.allowThirdPartyInstall}
          onChange={(checked) =>
            updateAutomation({ allowThirdPartyInstall: checked })
          }
        />
      </div>
    );
  })();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 sm:p-6"
      onClick={onClose}
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
                项目设置 · {record?.name ?? workspace.name}
              </h2>
              <p className="mt-1 truncate text-xs text-fg-faint" title={workspacePath}>
                {workspacePath || '未指定工作区'}
              </p>
            </div>
            <button
              type="button"
              onClick={refresh}
              disabled={loading}
              title="重新检测"
              aria-label="重新检测"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-panel-2 text-fg-faint transition-colors hover:border-accent hover:text-fg disabled:opacity-50"
            >
              <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
            </button>
            <button
              type="button"
              onClick={onClose}
              title="关闭"
              aria-label="关闭"
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
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  </button>
                );
              })}
            </div>
          </nav>

          <main className="min-h-0 flex-1 overflow-y-auto bg-panel px-6 py-5 md:px-8 md:py-7">
            {loading ? (
              <div className="flex h-full items-center justify-center text-sm text-fg-faint">
                检测中...
              </div>
            ) : (
              <div className="w-full max-w-[1180px]">{content}</div>
            )}
          </main>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border-soft bg-bg-alt px-5 py-3">
          <div className="min-w-0 flex-1 truncate text-xs text-fg-faint">
            {status ?? (dirty ? '有未保存修改' : '配置已同步')}
          </div>
          <div className="flex flex-wrap gap-2">
            {workspacePath ? (
              <button
                type="button"
                onClick={() => void openLocalPath(workspacePath, { reveal: true })}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-panel-2 px-3 py-1.5 text-xs text-fg-dim hover:border-accent hover:text-fg"
              >
                <FileText size={13} />
                打开位置
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void persistSettings(settings)}
              disabled={!dirty || saving}
              className="inline-flex items-center gap-1.5 rounded-md border border-accent bg-accent/15 px-3 py-1.5 text-xs font-semibold text-fg hover:bg-accent/25 disabled:border-border disabled:bg-panel-2 disabled:text-fg-faint"
            >
              <Check size={13} />
              {saving ? '保存中...' : '保存'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
