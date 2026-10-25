import { isOutputAsset, type AssetEntry } from './downloadRegistry';

export type AssetCategory = 'all' | 'link' | 'image' | 'video' | 'audio' | 'mesh' | 'file' | 'input' | 'installed';
export type AssetScope = 'workspace' | 'session' | 'all';
export const ASSET_CATEGORIES: Array<{ id: AssetCategory; label: string }> = [
  { id: 'all', label: '全部产物' }, { id: 'image', label: '图片' }, { id: 'file', label: '文件' },
  { id: 'link', label: '链接' }, { id: 'video', label: '视频' }, { id: 'audio', label: '音频' }, { id: 'mesh', label: '模型' },
  { id: 'input', label: '输入素材' }, { id: 'installed', label: '已安装能力' },
];
export const ASSET_SOURCE_LABELS: Record<AssetEntry['source'], string> = {
  generated: '生成', downloaded: '下载', modified: '修改', searched: '搜索保存', input: '输入素材', installed: '安装',
};
export function assetCategory(entry: AssetEntry): AssetCategory {
  if (entry.source === 'input' || entry.source === 'installed') return entry.source;
  if (!entry.localPath && entry.remoteUrl && entry.kind === 'file') return 'link';
  if (entry.kind === 'sprite' || entry.kind === 'image') return 'image';
  if (['audio', 'music', 'speech'].includes(entry.kind)) return 'audio';
  if (entry.kind === 'mesh' || entry.kind === 'model') return 'mesh';
  return entry.kind === 'video' ? 'video' : 'file';
}
export function assetInScope(entry: AssetEntry, scope: AssetScope, workspaceId?: string | null, sessionId?: string | null): boolean {
  // Unknown ownership is only visible under all indexed projects.
  if (scope === 'all') return true;
  if (!workspaceId) return false;
  const inProject = entry.workspaceId === workspaceId || entry.events?.some(event => event.workspaceId === workspaceId);
  if (!inProject) return false;
  return scope !== 'session' || Boolean(sessionId && ((entry.sessionId === sessionId && entry.workspaceId === workspaceId) || entry.events?.some(event => event.sessionId === sessionId && event.workspaceId === workspaceId)));
}
export function filterHubAssets(entries: AssetEntry[], input: {
  scope: AssetScope; workspaceId?: string | null; sessionId?: string | null;
  category: AssetCategory; source: string; query: string; favoritesOnly: boolean; oldestFirst: boolean;
}): AssetEntry[] {
  const query = input.query.trim().toLowerCase();
  const filtered = entries.filter(entry => {
    if (!assetInScope(entry, input.scope, input.workspaceId, input.sessionId)) return false;
    if (input.category === 'all' ? !isOutputAsset(entry) : assetCategory(entry) !== input.category) return false;
    if (input.source !== 'all' && entry.source !== input.source) return false;
    if (input.favoritesOnly && !entry.favorite) return false;
    const text = [entry.title, entry.localPath, entry.remoteUrl, entry.sessionTitle, entry.prompt, entry.provider, entry.model, ...(entry.tags ?? [])].filter(Boolean).join(' ').toLowerCase();
    return !query || text.includes(query);
  });
  return filtered.sort((a, b) => {
    const delta = (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt);
    return input.oldestFirst ? -delta : delta;
  });
}
