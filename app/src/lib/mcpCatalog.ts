import type { CliPlatform } from '@/lib/tauri';
import type { ProjectMcpTransport } from '@/lib/projectSettings';

/** Coarse grouping used for filtering the MCP registry. */
export type McpServerCategory =
  | 'filesystem'
  | 'vcs'
  | 'web'
  | 'search'
  | 'database'
  | 'memory'
  | 'automation'
  | 'productivity'
  | 'communication'
  | 'cloud'
  | 'devtools'
  | 'game'
  | 'ai';

export const MCP_CATEGORY_LABELS: Record<McpServerCategory, string> = {
  filesystem: '文件系统',
  vcs: '版本控制',
  web: '网页抓取',
  search: '搜索',
  database: '数据库',
  memory: '记忆/知识',
  automation: '浏览器自动化',
  productivity: '效率工具',
  communication: '协作沟通',
  cloud: '云服务',
  devtools: '开发工具',
  game: '游戏 / 引擎 / 图形',
  ai: 'AI / 模型',
};

/** Optional prefetch command (npm -g / uv tool install) run before first use. */
export interface McpInstallCommand {
  label: string;
  command: string;
  args: string[];
  platforms?: CliPlatform[];
}

/** A required environment variable the user must fill before the server runs. */
export interface McpEnvVarSpec {
  key: string;
  label: string;
  /** Placeholder kept in the server env until the user supplies a real value. */
  placeholder: string;
  secret?: boolean;
}

export interface McpServerDefinition {
  id: string;
  title: string;
  category: McpServerCategory;
  description: string;
  transport: ProjectMcpTransport;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Remote MCP endpoint URL when the registry entry is not a local stdio server. */
  url?: string;
  /** Env vars that need user-provided secrets/config before connecting. */
  requiredEnv?: McpEnvVarSpec[];
  /** Human-readable install/runtime note. */
  install: string;
  /** Optional one-click prefetch commands. Most servers run via npx/uvx on demand. */
  installCommands?: McpInstallCommand[];
  sourceUrl: string;
  registryName?: string;
  connectionUrl?: string;
  version?: string;
  updatedAt?: string;
  /** Registry-only remote entries are discoverable, but not installable as local project MCP yet. */
  installable?: boolean;
  tags: string[];
  recommendationPriority: number;
  trust: 'official' | 'curated' | 'community' | 'registry';
  requiresUserApproval?: boolean;
}

export interface RankedMcpServerDefinition extends McpServerDefinition {
  searchScore: number;
}

function quoteArg(value: string): string {
  return /[\s"']/.test(value) ? JSON.stringify(value) : value;
}

export function mcpInstallCommandText(command: McpInstallCommand): string {
  return [command.command, ...command.args].map(quoteArg).join(' ');
}

/** Full command line preview for a catalog server (command + args). */
export function mcpCommandText(definition: McpServerDefinition): string {
  return [definition.command, ...definition.args].map(quoteArg).join(' ');
}

interface McpRegistryRemote {
  type?: string;
  url?: string;
}

interface McpRegistryRepository {
  url?: string;
  source?: string;
  subfolder?: string;
}

interface McpRegistryServer {
  name?: string;
  title?: string;
  description?: string;
  version?: string;
  websiteUrl?: string;
  repository?: McpRegistryRepository;
  remotes?: McpRegistryRemote[];
}

interface McpRegistryEntry {
  server?: McpRegistryServer;
  _meta?: Record<string, { isLatest?: boolean; updatedAt?: string; publishedAt?: string }>;
}

interface McpRegistryResponse {
  servers?: McpRegistryEntry[];
}

const MCP_REGISTRY_API = 'https://registry.modelcontextprotocol.io/v0/servers?limit=80';

function compactText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    signal,
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

function slugFromMcpName(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'mcp-server';
}

function mcpRegistryMeta(entry: McpRegistryEntry): {
  isLatest: boolean;
  updatedAt?: string;
} {
  const official = entry._meta?.['io.modelcontextprotocol.registry/official'];
  return {
    isLatest: official?.isLatest === true,
    updatedAt: official?.updatedAt || official?.publishedAt,
  };
}

function inferMcpCategory(server: McpRegistryServer): McpServerCategory {
  const text = [
    server.name,
    server.title,
    server.description,
    server.repository?.url,
    server.repository?.subfolder,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const includesAny = (patterns: RegExp[]) => patterns.some((pattern) => pattern.test(text));
  if (includesAny([/\bfile(system)?\b/, /\bstorage\b/, /\bs3\b/])) return 'filesystem';
  if (includesAny([/\bgit(hub|lab)?\b/, /\brepo(sitory)?\b/, /\bpull request\b/, /\bissue\b/])) {
    return 'vcs';
  }
  if (includesAny([/\bsearch\b/, /\bweb search\b/, /\bbrave\b/, /\btavily\b/])) return 'search';
  if (includesAny([/\bpostgres\b/, /\bsqlite\b/, /\bmysql\b/, /\bdatabase\b/, /\bsql\b/])) {
    return 'database';
  }
  if (includesAny([/\bmemory\b/, /\bknowledge\b/, /\bgraph\b/])) return 'memory';
  if (includesAny([/\bbrowser\b/, /\bplaywright\b/, /\bpuppeteer\b/, /\bautomation\b/])) {
    return 'automation';
  }
  if (includesAny([/\bslack\b/, /\bdiscord\b/, /\bemail\b/, /\bmail\b/, /\bchat\b/])) {
    return 'communication';
  }
  if (includesAny([/\bnotion\b/, /\bcalendar\b/, /\bdocs?\b/, /\bworkflow\b/])) {
    return 'productivity';
  }
  if (
    includesAny([
      /\bgame\b/,
      /\bunity\b/,
      /\bunreal\b/,
      /\bgodot\b/,
      /\bblender\b/,
      /\bshader\b/,
      /\brenderdoc\b/,
      /\bgraphics\b/,
      /\bgamedev\b/,
    ])
  ) {
    return 'game';
  }
  if (includesAny([/\bai\b/, /\bllm\b/, /\bmodel\b/, /\binference\b/, /\bagent\b/])) return 'ai';
  if (includesAny([/\bdev(tool)?s?\b/, /\bsdk\b/, /\bapi\b/])) return 'devtools';
  return 'cloud';
}

export async function loadMcpRegistryServers(
  signal?: AbortSignal,
): Promise<McpServerDefinition[]> {
  const catalog = await fetchJson<McpRegistryResponse>(MCP_REGISTRY_API, signal);
  const byName = new Map<string, McpRegistryEntry>();
  for (const entry of catalog.servers ?? []) {
    const name = compactText(entry.server?.name);
    if (!name) continue;
    const existing = byName.get(name);
    if (!existing || mcpRegistryMeta(entry).isLatest) {
      byName.set(name, entry);
    }
  }

  const servers = Array.from(byName.values()).map((entry) => {
    const server = entry.server ?? {};
    const name = compactText(server.name);
    const remote = server.remotes?.find((item) => compactText(item.url)) ?? null;
    const remoteUrl = compactText(remote?.url);
    const remoteType = compactText(remote?.type) || 'streamable-http';
    const sourceUrl =
      compactText(server.websiteUrl) ||
      compactText(server.repository?.url) ||
      remoteUrl ||
      'https://registry.modelcontextprotocol.io';
    const title = compactText(server.title) || name;
    const meta = mcpRegistryMeta(entry);
    return {
      id: `registry:${slugFromMcpName(name)}`,
      title,
      category: inferMcpCategory(server),
      description: compactText(server.description) || 'MCP Registry server.',
      transport: remoteType,
      command: '',
      args: [],
      env: {},
      url: remoteUrl || undefined,
      install: remoteUrl
        ? `远程 MCP（${remoteType}）：${remoteUrl}`
        : 'MCP Registry 条目；请查看来源获取连接方式。',
      sourceUrl,
      registryName: name,
      connectionUrl: remoteUrl || sourceUrl,
      version: compactText(server.version) || undefined,
      updatedAt: meta.updatedAt,
      installable: false,
      tags: [
        'mcp',
        'registry',
        remoteType,
        compactText(server.repository?.source),
        compactText(server.repository?.subfolder),
      ].filter(Boolean),
      recommendationPriority: 20,
      trust: 'registry',
    } satisfies McpServerDefinition;
  });

  return dedupeMcpServers(servers);
}

export const MCP_CATALOG: McpServerDefinition[] = [
  {
    id: 'filesystem',
    title: 'Filesystem',
    category: 'filesystem',
    description: '在指定目录内安全地读取、写入、搜索文件，是最常用的本地 MCP。',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '{workspace}'],
    env: {},
    install: '通过 npx 按需运行；首个参数为允许访问的目录（默认 {workspace}）。',
    sourceUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    tags: ['file', 'fs', 'read', 'write', '本地', 'official'],
    recommendationPriority: 100,
    trust: 'official',
  },
  {
    id: 'git',
    title: 'Git',
    category: 'vcs',
    description: '读取仓库状态、提交历史、diff 并执行常见 Git 操作。',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-git', '--repository', '{workspace}'],
    env: {},
    install: '需要本地安装 uv / Python；通过 uvx 按需运行。',
    sourceUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git',
    tags: ['git', 'vcs', 'commit', 'diff', 'official'],
    recommendationPriority: 95,
    trust: 'official',
  },
  {
    id: 'github',
    title: 'GitHub',
    category: 'vcs',
    description: '管理 GitHub 仓库、issue、PR，搜索代码与读取文件。',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' },
    requiredEnv: [
      {
        key: 'GITHUB_PERSONAL_ACCESS_TOKEN',
        label: 'GitHub Personal Access Token',
        placeholder: 'ghp_xxx',
        secret: true,
      },
    ],
    install: '需要 GitHub Personal Access Token；通过 npx 按需运行。',
    sourceUrl: 'https://github.com/github/github-mcp-server',
    tags: ['github', 'pr', 'issue', 'repo', 'official'],
    recommendationPriority: 92,
    trust: 'official',
    requiresUserApproval: true,
  },
  {
    id: 'fetch',
    title: 'Fetch',
    category: 'web',
    description: '抓取网页并转换为适合 LLM 阅读的 Markdown 内容。',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    env: {},
    install: '需要本地安装 uv / Python；通过 uvx 按需运行。',
    sourceUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    tags: ['fetch', 'web', 'http', 'scrape', 'markdown', 'official'],
    recommendationPriority: 88,
    trust: 'official',
  },
  {
    id: 'memory',
    title: 'Memory',
    category: 'memory',
    description: '基于知识图谱的持久记忆，让模型跨会话记住实体与关系。',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    env: {},
    install: '通过 npx 按需运行；记忆默认存放在本地。',
    sourceUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    tags: ['memory', 'knowledge', 'graph', '记忆', 'official'],
    recommendationPriority: 80,
    trust: 'official',
  },
  {
    id: 'sequential-thinking',
    title: 'Sequential Thinking',
    category: 'ai',
    description: '提供结构化的逐步推理工具，辅助复杂问题的分解与反思。',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    env: {},
    install: '通过 npx 按需运行，无需额外配置。',
    sourceUrl:
      'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
    tags: ['thinking', 'reasoning', 'plan', '推理', 'official'],
    recommendationPriority: 78,
    trust: 'official',
  },
  {
    id: 'everything',
    title: 'Everything (参考)',
    category: 'devtools',
    description: '官方参考服务器，演示 prompts / resources / tools 的全部能力，适合测试。',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-everything'],
    env: {},
    install: '通过 npx 按需运行；主要用于调试 MCP 客户端。',
    sourceUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/everything',
    tags: ['reference', 'demo', 'test', 'official'],
    recommendationPriority: 40,
    trust: 'official',
  },
  {
    id: 'playwright',
    title: 'Playwright',
    category: 'automation',
    description: 'Microsoft 官方浏览器自动化 MCP，可访问页面、点击、填写表单与截图。',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    env: {},
    install: '通过 npx 按需运行；首次使用会下载浏览器内核。',
    sourceUrl: 'https://github.com/microsoft/playwright-mcp',
    tags: ['browser', 'playwright', 'automation', 'e2e', '自动化', 'curated'],
    recommendationPriority: 85,
    trust: 'curated',
  },
  {
    id: 'puppeteer',
    title: 'Puppeteer',
    category: 'automation',
    description: '基于 Puppeteer 的浏览器自动化，支持导航、截图与执行 JS。',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    env: {},
    install: '通过 npx 按需运行；首次使用会下载 Chromium。',
    sourceUrl:
      'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/puppeteer',
    tags: ['browser', 'puppeteer', 'automation', 'screenshot', 'curated'],
    recommendationPriority: 70,
    trust: 'curated',
  },
  {
    id: 'brave-search',
    title: 'Brave Search',
    category: 'search',
    description: '通过 Brave Search API 进行网页与本地搜索。',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    env: { BRAVE_API_KEY: '' },
    requiredEnv: [
      {
        key: 'BRAVE_API_KEY',
        label: 'Brave Search API Key',
        placeholder: 'BSA...',
        secret: true,
      },
    ],
    install: '需要 Brave Search API Key；通过 npx 按需运行。',
    sourceUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search',
    tags: ['search', 'brave', 'web', '搜索', 'curated'],
    recommendationPriority: 75,
    trust: 'curated',
    requiresUserApproval: true,
  },
  {
    id: 'tavily',
    title: 'Tavily Search',
    category: 'search',
    description: '面向 LLM 优化的 Tavily 搜索与网页提取服务。',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'tavily-mcp@latest'],
    env: { TAVILY_API_KEY: '' },
    requiredEnv: [
      {
        key: 'TAVILY_API_KEY',
        label: 'Tavily API Key',
        placeholder: 'tvly-...',
        secret: true,
      },
    ],
    install: '需要 Tavily API Key；通过 npx 按需运行。',
    sourceUrl: 'https://github.com/tavily-ai/tavily-mcp',
    tags: ['search', 'tavily', 'web', 'rag', 'community'],
    recommendationPriority: 68,
    trust: 'community',
    requiresUserApproval: true,
  },
  {
    id: 'context7',
    title: 'Context7',
    category: 'devtools',
    description: '为模型按需提供最新的库 / 框架官方文档，减少 API 猜测。',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp@latest'],
    env: {},
    install: '通过 npx 按需运行；可选填写 Upstash API Key 提升额度。',
    sourceUrl: 'https://github.com/upstash/context7',
    tags: ['docs', 'context', 'library', 'reference', '文档', 'community'],
    recommendationPriority: 82,
    trust: 'community',
  },
  {
    id: 'postgres',
    title: 'PostgreSQL',
    category: 'database',
    description: '以只读方式查询 PostgreSQL，并暴露表结构作为资源。',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres', '{connectionString}'],
    env: {},
    requiredEnv: [
      {
        key: 'POSTGRES_CONNECTION_STRING',
        label: 'PostgreSQL 连接串',
        placeholder: 'postgresql://user:pass@host:5432/db',
        secret: true,
      },
    ],
    install: '将连接串作为最后一个参数；通过 npx 按需运行。',
    sourceUrl:
      'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/postgres',
    tags: ['database', 'postgres', 'sql', '数据库', 'curated'],
    recommendationPriority: 72,
    trust: 'curated',
    requiresUserApproval: true,
  },
  {
    id: 'sqlite',
    title: 'SQLite',
    category: 'database',
    description: '查询并分析本地 SQLite 数据库文件。',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-sqlite', '--db-path', '{workspace}/data.db'],
    env: {},
    install: '需要本地安装 uv / Python；通过 uvx 按需运行。',
    sourceUrl:
      'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/sqlite',
    tags: ['database', 'sqlite', 'sql', 'curated'],
    recommendationPriority: 64,
    trust: 'curated',
  },
  {
    id: 'slack',
    title: 'Slack',
    category: 'communication',
    description: '读取频道消息、发送消息并管理 Slack 工作区。',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    env: { SLACK_BOT_TOKEN: '', SLACK_TEAM_ID: '' },
    requiredEnv: [
      { key: 'SLACK_BOT_TOKEN', label: 'Slack Bot Token', placeholder: 'xoxb-...', secret: true },
      { key: 'SLACK_TEAM_ID', label: 'Slack Team ID', placeholder: 'T01234567' },
    ],
    install: '需要 Slack Bot Token 与 Team ID；通过 npx 按需运行。',
    sourceUrl:
      'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/slack',
    tags: ['slack', 'chat', 'communication', '协作', 'curated'],
    recommendationPriority: 55,
    trust: 'curated',
    requiresUserApproval: true,
  },
  {
    id: 'notion',
    title: 'Notion',
    category: 'productivity',
    description: '读取与更新 Notion 页面、数据库，整合知识库内容。',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server'],
    env: { NOTION_TOKEN: '' },
    requiredEnv: [
      { key: 'NOTION_TOKEN', label: 'Notion Integration Token', placeholder: 'ntn_...', secret: true },
    ],
    install: '需要 Notion Integration Token；通过 npx 按需运行。',
    sourceUrl: 'https://github.com/makenotion/notion-mcp-server',
    tags: ['notion', 'docs', 'productivity', '笔记', 'community'],
    recommendationPriority: 60,
    trust: 'community',
    requiresUserApproval: true,
  },
  {
    id: 'time',
    title: 'Time',
    category: 'devtools',
    description: '提供当前时间与时区换算，弥补模型对时间的盲区。',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-time'],
    env: {},
    install: '需要本地安装 uv / Python；通过 uvx 按需运行。',
    sourceUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time',
    tags: ['time', 'timezone', 'utility', 'official'],
    recommendationPriority: 50,
    trust: 'official',
  },
  // CATALOG_ENTRIES_PLACEHOLDER
  {
    id: 'blender-mcp',
    title: 'Blender MCP',
    category: 'game',
    description: '连接 Blender，用自然语言创建/编辑场景、材质与对象，并驱动 Python 脚本与渲染。',
    transport: 'stdio',
    command: 'uvx',
    args: ['blender-mcp'],
    env: {},
    install: '需要本地安装 uv / Python，并在 Blender 内安装 BlenderMCP 插件；通过 uvx 按需运行。',
    sourceUrl: 'https://github.com/ahujasid/blender-mcp',
    tags: ['blender', '3d', 'modeling', 'render', 'game', 'dcc', 'community'],
    recommendationPriority: 76,
    trust: 'community',
    requiresUserApproval: true,
  },
  {
    id: 'unity-mcp',
    title: 'Unity MCP',
    category: 'game',
    description: '与 Unity 编辑器交互：管理资产、场景、脚本与组件，读取控制台日志并执行编辑器操作。',
    transport: 'stdio',
    command: 'uvx',
    args: ['unity-mcp-server'],
    env: {},
    install: '需要 uv / Python，并在 Unity 内安装 MCP for Unity 包（Package Manager）；首次连接需在编辑器中授权。',
    sourceUrl: 'https://github.com/CoplayDev/unity-mcp',
    tags: ['unity', 'csharp', 'editor', 'game', 'engine', 'community'],
    recommendationPriority: 78,
    trust: 'community',
    requiresUserApproval: true,
  },
  {
    id: 'unreal-mcp',
    title: 'Unreal Engine MCP',
    category: 'game',
    description: '通过 Python/Remote Control 控制 Unreal 编辑器：创建 Actor、蓝图、关卡与编辑器自动化。',
    transport: 'stdio',
    command: 'uvx',
    args: ['unreal-mcp'],
    env: {},
    install: '需要 uv / Python，并在 UE 项目中启用 Python 与 Remote Control 插件；通过 uvx 按需运行。',
    sourceUrl: 'https://github.com/chongdashu/unreal-mcp',
    tags: ['unreal', 'ue5', 'cpp', 'blueprint', 'editor', 'game', 'engine', 'community'],
    recommendationPriority: 74,
    trust: 'community',
    requiresUserApproval: true,
  },
  {
    id: 'godot-mcp',
    title: 'Godot MCP',
    category: 'game',
    description: '驱动 Godot 引擎：运行项目、捕获调试输出、管理场景与脚本，辅助 GDScript 排错。',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/godot-mcp'],
    env: { GODOT_PATH: '' },
    requiredEnv: [
      {
        key: 'GODOT_PATH',
        label: 'Godot 可执行文件路径',
        placeholder: 'C:/Godot/Godot.exe 或 /usr/bin/godot',
      },
    ],
    install: '需要本地安装 Godot 并指向其可执行文件；通过 npx 按需运行。',
    sourceUrl: 'https://github.com/Coding-Solo/godot-mcp',
    tags: ['godot', 'gdscript', 'editor', 'game', 'engine', 'community'],
    recommendationPriority: 72,
    trust: 'community',
    requiresUserApproval: true,
  },
];

function searchableMcpText(server: McpServerDefinition): string {
  return [
    server.id,
    server.title,
    server.description,
    server.category,
    MCP_CATEGORY_LABELS[server.category],
    server.registryName,
    server.command,
    ...server.args,
    server.connectionUrl,
    server.url,
    server.sourceUrl,
    ...server.tags,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function compactMcpKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
}

function normalizedMcpUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    return `${url.hostname.replace(/^www\./, '')}${url.pathname}`
      .replace(/\/+$/, '')
      .replace(/\.git$/i, '')
      .toLowerCase();
  } catch {
    return trimmed.replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
  }
}

function mcpDedupeKeys(server: McpServerDefinition): string[] {
  const keys = new Set<string>();
  const add = (prefix: string, value?: string) => {
    const compact = compactMcpKey(value ?? '');
    if (compact.length > 2) keys.add(`${prefix}:${compact}`);
  };
  add('id', server.id.replace(/^registry:/, ''));
  add('title', server.title);
  add('name', server.registryName);
  const source = normalizedMcpUrl(server.sourceUrl);
  const connection = normalizedMcpUrl(server.connectionUrl ?? server.url ?? '');
  if (source) add('url', source);
  if (connection) add('url', connection);
  return Array.from(keys);
}

export function dedupeMcpServers(
  servers: readonly McpServerDefinition[],
): McpServerDefinition[] {
  const seen = new Map<string, McpServerDefinition>();
  const out: McpServerDefinition[] = [];
  for (const server of servers) {
    const keys = mcpDedupeKeys(server);
    if (
      keys.some((key) => {
        const existing = seen.get(key);
        if (!existing) return false;
        return !(
          key.startsWith('title:') &&
          existing.trust === 'registry' &&
          server.trust === 'registry'
        );
      })
    ) {
      continue;
    }
    out.push(server);
    keys.forEach((key) => seen.set(key, server));
  }
  return out;
}

export function mergedMcpCatalog(
  registryServers: readonly McpServerDefinition[] = [],
): McpServerDefinition[] {
  return dedupeMcpServers([...MCP_CATALOG, ...registryServers]);
}

/** Filter + rank the registry by a free-text query. Empty query keeps catalog order. */
export function rankMcpServers(
  query = '',
  registryServers: readonly McpServerDefinition[] = [],
): RankedMcpServerDefinition[] {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  return mergedMcpCatalog(registryServers).map((server) => {
    const haystack = searchableMcpText(server);
    const matchedTerms = terms.filter((term) => haystack.includes(term)).length;
    const titleBoost = terms.some((term) =>
      server.title.toLowerCase().includes(term),
    )
      ? 50
      : 0;
    const searchScore =
      terms.length === 0
        ? server.recommendationPriority
        : matchedTerms * 100 + titleBoost + server.recommendationPriority;
    return { ...server, searchScore };
  })
    .filter((server) => {
      if (terms.length === 0) return true;
      const haystack = searchableMcpText(server);
      return terms.every((term) => haystack.includes(term));
    })
    .sort(
      (a, b) =>
        b.searchScore - a.searchScore ||
        b.recommendationPriority - a.recommendationPriority ||
        a.title.localeCompare(b.title, 'zh-CN'),
    );
}

export function mcpServerById(id: string): McpServerDefinition | undefined {
  return MCP_CATALOG.find((server) => server.id === id);
}
