import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { toolId, validateSnapshot } from '../../src/lib/tools/catalog';
import type { ToolCatalogScope, ToolCatalogSnapshot, ToolDescriptor } from '../../src/lib/tools/types';

/** Passive Node route evidence. Same identity and cache contract as desktop. */
export function captureToolCatalog(env: NodeJS.ProcessEnv, adapter: string, model: string | undefined, runId: string) {
  let scope: ToolCatalogScope;
  try {
    scope = env.UGS_TOOL_CATALOG_SCOPE ? JSON.parse(env.UGS_TOOL_CATALOG_SCOPE) : {
      workspaceId: env.UGS_WORKSPACE_ID ?? '', sessionId: env.UGS_SESSION_ID ?? '', agentId: adapter, providerId: '', channelId: '', model: model ?? '',
    };
  } catch { return undefined; }
  if (!scope || !['workspaceId', 'sessionId', 'agentId', 'providerId', 'channelId', 'model'].every(k => typeof scope[k as keyof ToolCatalogScope] === 'string') || !scope.workspaceId || !scope.sessionId) return undefined;
  const hash = createHash('sha256').update(JSON.stringify([scope.workspaceId, scope.sessionId, scope.agentId, scope.providerId, scope.channelId, scope.model])).digest('hex');
  const dir = join(env.UGS_HOME || join(homedir(), '.ultragamestudio'), 'tools', 'catalogs');
  const path = join(dir, `${hash}.json`);
  const now = Date.now();
  const snapshot: ToolCatalogSnapshot = { schemaVersion: 1, scope, runId, startedAtMs: now, updatedAtMs: now, revision: 0, active: true,
    tools: [], coverage: [{ source: 'session', level: 'unknown', reason: '当前通道未提供完整目录；等待原生事件' }] };
  const write = (initial = false) => {
    try {
      mkdirSync(dir, { recursive: true });
      if (!initial) {
        const current = validateSnapshot(JSON.parse(readFileSync(path, 'utf8')), scope);
        if (current?.runId !== runId) return;
      }
      snapshot.updatedAtMs = Date.now(); snapshot.revision++;
      const temp = join(dir, `${hash}.${randomUUID()}.tmp`);
      writeFileSync(temp, JSON.stringify(snapshot)); renameSync(temp, path);
    } catch { /* Catalogue I/O never breaks the foreground Agent. */ }
  };
  const descriptor = (name: string): ToolDescriptor => ({ toolId: toolId(scope.agentId, undefined, name), originalName: name,
    providerId: scope.agentId, origin: 'unknown', owner: 'agent', discovery: 'observed', selected: 'unknown',
    exposure: 'unknown', connection: 'unknown', permission: 'agent-managed', evidence: '本会话原生工具调用事件（不是完整目录）', lastSeenAtMs: Date.now() });
  write(true);
  return {
    init(event: Record<string, unknown>) {
      if (event.type !== 'system' || event.subtype !== 'init' || !Array.isArray(event.tools)) return;
      snapshot.tools = event.tools.filter((name): name is string => typeof name === 'string').map(name => ({
        ...descriptor(name), discovery: 'live', evidence: 'Claude system/init.tools（仅名称）',
      }));
      snapshot.coverage = [{ source: 'session', level: 'names', reason: '会话启动工具名称；Schema、逐工具权限与延迟加载方式未提供' }]; write();
    },
    observe(event: { toolName: string; phase: string }) {
      let tool = snapshot.tools.find(tool => tool.originalName === event.toolName);
      if (!tool) { tool = descriptor(event.toolName); snapshot.tools.push(tool); }
      tool.lastCall = { atMs: Date.now(), status: event.phase }; write();
    },
    finish() { snapshot.active = false; write(); },
  };
}
