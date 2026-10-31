import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveToolsScope } from '../commands/tools';

/** Same read-only entrypoint as desktop. Never advertise to a text-only model. */
export function toolCatalogGuidance(env: NodeJS.ProcessEnv, windows = process.platform === 'win32'): string {
  if (!env.UGS_TOOLS_CLI || !env.UGS_TOOL_CATALOG_SCOPE) return '';
  try { resolveToolsScope({}, env); } catch { return ''; }
  const script = windows ? '"$env:UGS_TOOLS_CLI"' : '"$UGS_TOOLS_CLI"';
  return `【工具自动检索】
需要找工具时，由你自行查询，无需用户打开面板或选择工具。优先使用当前 Agent 原生的工具搜索、延迟加载或工具注册表。UGS 补充目录可通过终端查询：
node ${script} tools search "关键词"
node ${script} tools inspect '<工具ID>'
node ${script} tools list
会话身份和数据目录已由环境变量注入，无需填写工作区、会话、账号或模型。搜索先返回摘要，inspect 再取参数 Schema。目录是缓存证据；无快照、无匹配或覆盖未知不代表没有工具。只使用当前 Agent 实际暴露的调用通道与权限，不把目录查询当作工具执行。

`;
}

export function prepareToolCatalogAccess(env: NodeJS.ProcessEnv): string {
  if (!env.UGS_TOOL_CATALOG_SCOPE) return '';
  const here = fileURLToPath(import.meta.url);
  const candidates = [env.UGS_TOOLS_CLI, basename(here) === 'ugs.mjs' ? here : join(dirname(here), '..', 'dist', 'ugs.mjs')];
  const script = candidates.find((path): path is string => !!path && existsSync(path));
  if (!script) return '';
  env.UGS_TOOLS_CLI = script;
  return toolCatalogGuidance(env);
}
