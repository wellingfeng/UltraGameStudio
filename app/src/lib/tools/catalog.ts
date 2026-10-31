import type { ProjectMcpServerConfig } from '../projectSettings';
import type { ToolCatalogCapabilities, ToolCatalogCoverage, ToolCatalogScope, ToolCatalogSnapshot, ToolDescriptor } from './types';

export function catalogScope(workspaceId: string | null, sessionId: string | null, selection: {
  adapter: string; providerId?: string; channelId?: string; modelOverride?: string; modelClass?: string;
}): ToolCatalogScope {
  return { workspaceId: workspaceId ?? '', sessionId: sessionId ?? '', agentId: selection.adapter,
    providerId: selection.providerId ?? '', channelId: selection.channelId ?? '', model: selection.modelOverride?.trim() || selection.modelClass?.trim() || '' };
}

export function scopeKey(scope: ToolCatalogScope): string {
  return JSON.stringify([scope.workspaceId, scope.sessionId, scope.agentId, scope.providerId, scope.channelId, scope.model]);
}

export function toolId(providerId: string, serverId: string | undefined, name: string): string {
  return JSON.stringify([providerId, serverId ?? '', name]);
}

export function describeCapabilities(agentId: string): ToolCatalogCapabilities {
  const claude = ['claude', 'claude-code'].includes(agentId);
  const codex = agentId === 'codex';
  return { sessionNames: claude, mcpMetadata: codex, schema: codex, policy: false, reload: false,
    reason: claude ? '会话启动事件提供工具名称；参数、暴露方式和逐工具权限由 Agent 管理。'
      : codex ? 'App Server 提供当前线程 MCP 元数据；内置工具没有完整枚举接口。'
        : '当前通道未提供完整目录；仅显示真实调用证据。直连文本通道没有工具执行循环。' };
}

export function projectCatalog(scope: ToolCatalogScope, servers: ProjectMcpServerConfig[], enabled: boolean): ToolCatalogSnapshot {
  const tools: ToolDescriptor[] = [];
  const coverage: ToolCatalogCoverage[] = [];
  let updatedAtMs = 0;
  for (const server of servers) {
    const probe = server.lastProbe;
    updatedAtMs = Math.max(updatedAtMs, probe?.checkedAtMs ?? 0);
    coverage.push({ source: server.id, level: probe?.catalogCoverage ?? 'unknown', reason:
      probe?.message ?? '尚未主动探测；项目配置不证明当前 Agent 已加载。' });
    for (const tool of probe?.tools ?? []) {
      tools.push({ toolId: toolId('project', server.id, tool.name), originalName: tool.name,
        providerId: 'project', serverId: server.id, origin: 'mcp', owner: 'ugs-probe',
        description: tool.description, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema, metadata: tool,
        discovery: 'cached', selected: enabled && server.enabled ? 'yes' : 'no', exposure: 'unknown',
        connection: 'unknown', permission: 'unknown', evidence: '项目主动探测 tools/list；不代表会话有效清单',
        lastSeenAtMs: probe!.checkedAtMs });
    }
  }
  return { schemaVersion: 1, scope, runId: '', startedAtMs: 0, updatedAtMs, revision: 0, active: false, tools, coverage };
}

export function isProtocolConnected(result: { ok: boolean; status: string } | undefined): boolean {
  return !!result?.ok && result.status === 'connected';
}

export function filterTools(tools: ToolDescriptor[], query: string): ToolDescriptor[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return tools.filter(tool => {
    const haystack = [tool.originalName, tool.wireName, tool.serverId, tool.providerId, tool.description].join(' ').toLocaleLowerCase();
    return words.every(word => haystack.includes(word));
  });
}

export function validateSnapshot(value: unknown, scope: ToolCatalogScope): ToolCatalogSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const snapshot = value as ToolCatalogSnapshot;
  if (snapshot.schemaVersion !== 1 || !snapshot.scope || scopeKey(snapshot.scope) !== scopeKey(scope)
    || !Array.isArray(snapshot.tools) || !Array.isArray(snapshot.coverage)
    || typeof snapshot.updatedAtMs !== 'number' || typeof snapshot.active !== 'boolean'
    || snapshot.coverage.some(row => !row || typeof row.source !== 'string' || typeof row.reason !== 'string'
      || !['full', 'names', 'observed', 'unknown'].includes(row.level))
    || snapshot.tools.some(tool => !tool || typeof tool.toolId !== 'string' || typeof tool.originalName !== 'string'
      || !['live', 'cached', 'observed', 'unknown'].includes(tool.discovery)
      || !['yes', 'no', 'unknown'].includes(tool.selected)
      || !['direct', 'search', 'code', 'unknown'].includes(tool.exposure))) return null;
  return snapshot;
}
