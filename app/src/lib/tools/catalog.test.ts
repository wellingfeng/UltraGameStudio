import { describe, expect, it } from 'vitest';
import { catalogScope, describeCapabilities, filterTools, projectCatalog, scopeKey, toolId, validateSnapshot } from './catalog';
import type { ProjectMcpServerConfig } from '../projectSettings';

describe('tool catalog evidence and isolation', () => {
  it('isolates workspace, session, account and model; unknown is explicit', () => {
    const scope = catalogScope('w', 'a', { adapter: 'codex', providerId: 'one', modelOverride: 'm' });
    for (const patch of [{ workspaceId: 'other' }, { sessionId: 'other' }, { providerId: 'two' }, { channelId: 'two' }, { model: 'n' }, { agentId: 'claude' }]) {
      expect(scopeKey(scope)).not.toBe(scopeKey({ ...scope, ...patch }));
    }
    expect(toolId('p', 'a', 'same')).not.toBe(toolId('p', 'b', 'same'));
    expect(describeCapabilities('pi').policy).toBe(false);
  });
  it('preserves schemas and never calls cached discovery a session connection', () => {
    const server: ProjectMcpServerConfig = { id: 's', label: '测试服务', source: 'custom', enabled: true, transport: 'stdio', args: [], env: {},
      lastProbe: { serverId: 's', ok: true, status: 'connected', message: '发现完成', checkedAtMs: 100, toolsCount: 1, catalogCoverage: 'full', tools: [
        { name: 'lookup', description: '查找资料', inputSchema: { $defs: { item: { type: 'string' } }, properties: { q: { $ref: '#/$defs/item' } } }, _meta: { custom: true } },
      ] } };
    const scope = catalogScope('w', null, { adapter: 'project' });
    const snapshot = projectCatalog(scope, [server], true);
    expect(snapshot.tools[0]).toMatchObject({ discovery: 'cached', selected: 'yes', exposure: 'unknown', connection: 'unknown', permission: 'unknown' });
    expect(snapshot.tools[0].inputSchema?.properties).toEqual({ q: { $ref: '#/$defs/item' } });
    expect(projectCatalog(scope, [server], false).tools[0].selected).toBe('no');
    expect(filterTools(snapshot.tools, 'lookup 资料')).toHaveLength(1);
    expect(validateSnapshot(snapshot, { ...scope, sessionId: 'other' })).toBeNull();
  });
  it('legacy count-only probes stay unknown; zero tools requires real full evidence', () => {
    const server: ProjectMcpServerConfig = { id: 's', label: '旧服务', source: 'custom', enabled: true, transport: 'http', args: [], env: {},
      lastProbe: { serverId: 's', ok: true, status: 'reachable', message: '仅端点响应', checkedAtMs: 1, toolsCount: 8 } };
    const result = projectCatalog(catalogScope('w', null, { adapter: 'project' }), [server], true);
    expect(result.tools).toEqual([]);
    expect(result.coverage[0].level).toBe('unknown');
  });
});
