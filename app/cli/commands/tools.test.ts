// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { catalogScope, projectCatalog } from '../../src/lib/tools/catalog';
import { readToolCatalog, resolveToolWorkspaceId, runTools } from './tools';
const temp: string[] = [];
afterEach(() => { vi.restoreAllMocks(); temp.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });
describe('CLI tool catalogue', () => {
  it('uses the desktop identity hash, enforces exact scope and marks disk reads cached', () => {
    const root = mkdtempSync(join(tmpdir(), 'ugs-tools-')); temp.push(root);
    const scope = catalogScope('w', 's', { adapter: 'codex', providerId: 'account', modelOverride: 'm' });
    const key = createHash('sha256').update(JSON.stringify(['w', 's', 'codex', 'account', '', 'm'])).digest('hex');
    mkdirSync(join(root, 'tools', 'catalogs'), { recursive: true });
    const path = join(root, 'tools', 'catalogs', `${key}.json`);
    writeFileSync(path, JSON.stringify({ ...projectCatalog(scope, [], true), active: true }));
    expect(readToolCatalog(scope, root)?.active).toBe(false);
    expect(readToolCatalog({ ...scope, providerId: 'other' }, root)).toBeNull();
    writeFileSync(path, JSON.stringify({ ...projectCatalog({ ...scope, sessionId: 'wrong' }, [], true) }));
    expect(() => readToolCatalog(scope, root)).toThrow('作用域不一致');
  });
  it('resolves Windows paths through the desktop registry and rejects ambiguous records', () => {
    const root = mkdtempSync(join(tmpdir(), 'ugs-tools-')); temp.push(root);
    mkdirSync(join(root, 'workspaces'));
    const index = join(root, 'workspaces', 'index.json');
    writeFileSync(index, JSON.stringify([{ id: 'desktop-workspace', path: 'E:\\Game\\Client' }]));
    expect(resolveToolWorkspaceId('e:/game/client/', root)).toBe('desktop-workspace');
    expect(resolveToolWorkspaceId('desktop-workspace', root)).toBe('desktop-workspace');
    expect(() => resolveToolWorkspaceId('E:/other', root)).toThrow('未登记');
    writeFileSync(index, JSON.stringify([{ id: 'a', path: 'E:/Game/Client' }, { id: 'b', path: 'E:/Game/Client' }]));
    expect(() => resolveToolWorkspaceId('E:/Game/Client', root)).toThrow('多个记录');
  });
  it('keeps unknown empty listings machine-readable and treats missing inspect evidence as failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ugs-tools-')); temp.push(root);
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const opts = { workspace: 'w', session: 's', agent: 'codex', home: root };
    await runTools('list', undefined, opts);
    const result = JSON.parse(String(write.mock.calls[0][0]));
    expect(result).toMatchObject({ schemaVersion: 1, active: false, coverage: [{ level: 'unknown' }] });
    await expect(runTools('inspect', 'absent-tool', opts)).rejects.toThrow('尚无');
    await expect(runTools('inspect', undefined, opts)).rejects.toThrow('工具 ID');
  });
  it('lets an agent search its injected scope without manually supplying identity and inspect the schema', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ugs-tools-')); temp.push(root);
    const scope = catalogScope('w', 's', { adapter: 'codex', providerId: 'account', channelId: 'channel', modelOverride: 'm' });
    const snapshot = projectCatalog(scope, [{ id: 'rider', label: 'Rider', source: 'custom', enabled: true, transport: 'stdio', args: [], env: {},
      lastProbe: { serverId: 'rider', ok: true, status: 'connected', checkedAtMs: 10, message: '完成', catalogCoverage: 'full', tools: [
        { name: 'build_project', description: '编译项目', inputSchema: { type: 'object', properties: { project: { type: 'string' } } } },
        { name: 'read_file', description: '读取文件', inputSchema: { type: 'object' } },
      ] } }], true);
    const key = createHash('sha256').update(JSON.stringify(['w', 's', 'codex', 'account', 'channel', 'm'])).digest('hex');
    mkdirSync(join(root, 'tools', 'catalogs'), { recursive: true });
    writeFileSync(join(root, 'tools', 'catalogs', `${key}.json`), JSON.stringify(snapshot));
    const env = { UGS_HOME: root, UGS_TOOL_CATALOG_SCOPE: JSON.stringify(scope) };
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await runTools('search', 'rider 编译', {}, env);
    const result = JSON.parse(String(write.mock.calls[0][0]));
    expect(result.scope).toEqual(scope);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]).toMatchObject({ originalName: 'build_project', connection: 'unknown', discovery: 'cached' });
    expect(result.tools[0].inputSchema).toBeUndefined();
    expect(result.totalMatches).toBe(1);
    await runTools('inspect', result.tools[0].toolId, {}, env);
    expect(JSON.parse(String(write.mock.calls[1][0])).inputSchema).toEqual(snapshot.tools[0].inputSchema);
    await runTools('list', undefined, { workspace: 'w', session: 'other', agent: 'codex' }, env);
    expect(JSON.parse(String(write.mock.calls[2][0])).tools).toEqual([]);
    await expect(runTools('list', undefined, {}, { UGS_TOOL_CATALOG_SCOPE: '{' })).rejects.toThrow('作用域');
    await expect(runTools('search', undefined, {}, env)).rejects.toThrow('关键词');
  });
});
