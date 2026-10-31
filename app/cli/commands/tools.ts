import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { describeCapabilities, filterTools, validateSnapshot } from '../../src/lib/tools/catalog';
import { workspaceIdentityHashInput } from '../../src/store/history/paths';
import type { ToolCatalogScope, ToolCatalogSnapshot } from '../../src/lib/tools/types';

export interface ToolsOptions {
  workspace?: string;
  session?: string;
  agent?: string;
  provider?: string;
  channel?: string;
  model?: string;
  format?: string;
  home?: string;
  limit?: string;
}

const defaultRoot = () => process.env.UGS_HOME || join(homedir(), '.ultragamestudio');

/** Resolve registered desktop workspaces without creating or changing history. */
export function resolveToolWorkspaceId(value: string, root = defaultRoot()): string {
  const input = value.trim();
  if (!input) throw new Error('工作区不能为空');
  if (!/[\\/]/.test(input) && input !== '.' && input !== '..') return input;
  const path = isAbsolute(input) || /^[A-Za-z]:[\\/]/.test(input) ? input : resolve(input);
  let index: unknown;
  try { index = JSON.parse(readFileSync(join(root, 'workspaces', 'index.json'), 'utf8')); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('工作区路径未登记；请使用面板中的工作区 ID');
    throw new Error('工作区索引读取失败');
  }
  if (!Array.isArray(index)) throw new Error('工作区索引格式无效');
  const key = workspaceIdentityHashInput(path);
  const matches = index.filter((row): row is { id: string; path: string } => !!row
    && typeof row.id === 'string' && typeof row.path === 'string'
    && workspaceIdentityHashInput(row.path) === key);
  if (matches.length !== 1) throw new Error(matches.length ? '工作区路径对应多个记录；请指定工作区 ID' : '工作区路径未登记；请使用面板中的工作区 ID');
  return matches[0].id;
}

export function readToolCatalog(scope: ToolCatalogScope, root = defaultRoot()): ToolCatalogSnapshot | null {
  const key = createHash('sha256').update(JSON.stringify([scope.workspaceId, scope.sessionId, scope.agentId, scope.providerId, scope.channelId, scope.model])).digest('hex');
  let raw: string;
  try { raw = readFileSync(join(root, 'tools', 'catalogs', `${key}.json`), 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  const snapshot = validateSnapshot(JSON.parse(raw), scope);
  if (!snapshot) throw new Error('工具目录缓存损坏或作用域不一致');
  // CLI reads persisted evidence, not a liveness RPC.
  return { ...snapshot, active: false };
}

export function resolveToolsScope(opts: ToolsOptions, env: NodeJS.ProcessEnv): ToolCatalogScope {
  const explicit = [opts.workspace, opts.session, opts.agent, opts.provider, opts.channel, opts.model].some(v => v !== undefined);
  if (!explicit && env.UGS_TOOL_CATALOG_SCOPE) {
    let scope: ToolCatalogScope;
    try { scope = JSON.parse(env.UGS_TOOL_CATALOG_SCOPE); }
    catch { throw new Error('注入的工具目录作用域格式无效'); }
    if (!scope || !['workspaceId', 'sessionId', 'agentId', 'providerId', 'channelId', 'model'].every(k => typeof scope[k as keyof ToolCatalogScope] === 'string')
      || !scope.workspaceId || !scope.sessionId || !scope.agentId) throw new Error('注入的工具目录作用域无效');
    return scope;
  }
  if (!opts.workspace || !opts.session || !opts.agent) throw new Error('未注入当前会话作用域；必须指定 --workspace --session --agent，账号、渠道和模型需与会话一致');
  return { workspaceId: resolveToolWorkspaceId(opts.workspace, opts.home ?? env.UGS_HOME), sessionId: opts.session, agentId: opts.agent,
    providerId: opts.provider ?? '', channelId: opts.channel ?? '', model: opts.model ?? '' };
}

export async function runTools(action: string, tool: string | undefined, opts: ToolsOptions, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (action === 'capabilities') {
    const agent = opts.agent ?? (env.UGS_TOOL_CATALOG_SCOPE ? resolveToolsScope({}, env).agentId : 'unknown');
    process.stdout.write(JSON.stringify(describeCapabilities(agent), null, 2) + '\n'); return 0;
  }
  if (!['list', 'search', 'inspect'].includes(action)) throw new Error('支持的工具目录命令：list、search、inspect、capabilities');
  if (opts.format && !['json', 'text'].includes(opts.format)) throw new Error('--format 仅支持 json 或 text');
  if (action === 'inspect' && !tool) throw new Error('inspect 必须指定工具 ID');
  if (action === 'search' && !tool?.trim()) throw new Error('search 必须指定关键词');
  const limit = Number(opts.limit ?? 20);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('--limit 必须为 1–100 的整数');
  const scope = resolveToolsScope(opts, env);
  const snapshot = readToolCatalog(scope, opts.home ?? env.UGS_HOME);
  if (!snapshot) {
    if (action === 'inspect') throw new Error('尚无此作用域的目录快照');
    const empty: ToolCatalogSnapshot = { schemaVersion: 1, scope, runId: '', startedAtMs: 0, updatedAtMs: 0, revision: 0,
      active: false, tools: [], coverage: [{ source: 'session', level: 'unknown', reason: '尚无此作用域的目录快照' }] };
    const result = action === 'search' ? { ...empty, query: tool, totalMatches: 0, truncated: false } : empty;
    process.stdout.write(opts.format === 'text' ? '尚无此作用域的目录快照（不代表 0 个可用工具）\n' : JSON.stringify(result, null, 2) + '\n');
    return 0;
  }
  if (action === 'inspect') {
    const found = snapshot.tools.find(t => t.toolId === tool);
    if (!found) throw new Error('工具 ID 未在此作用域的快照中找到');
    process.stdout.write(JSON.stringify(found, null, 2) + '\n'); return 0;
  }
  if (action === 'search') {
    const matches = filterTools(snapshot.tools, tool!);
    const tools = matches.slice(0, limit).map(({ inputSchema: _input, outputSchema: _output, metadata: _metadata, ...summary }) => summary);
    process.stdout.write(opts.format === 'text'
      ? `工具目录搜索 · 仅缓存证据 · 匹配 ${matches.length} 项\n` + tools.map(t => `${t.toolId}\t${t.originalName}\t${t.description ?? ''}\t${t.evidence}`).join('\n') + '\n'
      : JSON.stringify({ ...snapshot, tools, query: tool, totalMatches: matches.length, truncated: matches.length > limit }, null, 2) + '\n');
    return 0;
  }
  if (opts.format === 'text') {
    process.stdout.write(`工具目录 · ${scope.agentId} · 仅缓存证据\n` + snapshot.tools.map(t => `${t.originalName}\t${t.serverId ?? t.providerId}\t${t.evidence}`).join('\n') + '\n');
  } else process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
  return 0;
}
