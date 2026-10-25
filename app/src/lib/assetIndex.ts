import type { AssetEntry } from './downloadRegistry';

export interface AssetIndexSnapshot {
  version: 2;
  entries: AssetEntry[];
  dismissedPaths: string[];
}
export interface AssetIndexIO {
  read(path: string): Promise<string | null>;
  write(path: string, json: string): Promise<void>;
}
const ROOT = 'assets';
const bucket = (workspaceId?: string | null) => workspaceId
  ? `workspace-${encodeURIComponent(workspaceId).replace(/\./g, '%2E')}` : 'unassigned';

/** Reuse history's atomic replacement, backup and quarantine primitives. */
export function desktopAssetIndexIO(): AssetIndexIO | null {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return null;
  return {
    async read(relPath) {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke<string | null>('history_read_json', { relPath });
    },
    async write(relPath, json) {
      const { invoke } = await import('@tauri-apps/api/core');
      // Rust serde rejects lone UTF-16 surrogates; retain valid pairs.
      json = json.replace(/\\u(d[89ab][0-9a-f]{2})(\\ud[c-f][0-9a-f]{2})?|\\ud[c-f][0-9a-f]{2}/gi,
        (_match, _high, low) => low ? _match : '\\ufffd');
      await invoke('history_write_json', { relPath, json });
    },
  };
}

export async function readAssetIndex(io: AssetIndexIO): Promise<AssetIndexSnapshot | null> {
  const raw = await io.read(`${ROOT}/catalog.v2.json`);
  if (!raw) return null;
  const catalog = JSON.parse(raw) as { version: number; buckets: string[]; dismissedPaths: string[] };
  if (catalog.version !== 2 || !Array.isArray(catalog.buckets) || !Array.isArray(catalog.dismissedPaths)) {
    throw new Error('资产索引格式错误');
  }
  const entries: AssetEntry[] = [];
  for (const name of catalog.buckets) {
    if (!/^(?:unassigned|workspace-[A-Za-z0-9_%!-]+)$/.test(name)) throw new Error('资产索引分区错误');
    const shard = await io.read(`${ROOT}/${name}/index.v2.json`);
    if (!shard) throw new Error(`资产索引分区缺失：${name}`);
    const parsed = JSON.parse(shard) as { entries: AssetEntry[] };
    if (!Array.isArray(parsed.entries)) throw new Error('资产索引条目错误');
    entries.push(...parsed.entries);
  }
  return { version: 2, entries, dismissedPaths: catalog.dismissedPaths };
}

export async function writeAssetIndex(io: AssetIndexIO, snapshot: AssetIndexSnapshot): Promise<void> {
  const groups = new Map<string, AssetEntry[]>();
  for (const entry of snapshot.entries) {
    if (entry.status === 'pending') continue;
    const name = bucket(entry.workspaceId);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name)!.push(entry);
  }
  // Write shards before publishing the catalog; empty removed shards are no
  // longer discoverable. Each replacement is atomic and backed up by Rust.
  for (const [name, entries] of groups) {
    await io.write(`${ROOT}/${name}/index.v2.json`, JSON.stringify({ version: 2, entries }));
  }
  await io.write(`${ROOT}/catalog.v2.json`, JSON.stringify({
    version: 2, buckets: [...groups.keys()], dismissedPaths: snapshot.dismissedPaths,
  }));
}
