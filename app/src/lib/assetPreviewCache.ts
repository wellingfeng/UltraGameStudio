import { fileExists, readImageThumbnail } from './tauri';

const cache = new Map<string, Promise<string>>();
let active = 0;
const waiting: Array<() => void> = [];
async function acquire(): Promise<void> {
  if (active < 4) { active += 1; return; }
  await new Promise<void>(resolve => waiting.push(resolve));
}
function release(): void {
  const next = waiting.shift();
  if (next) next(); else active -= 1;
}

export async function probeAssetFile(path: string): Promise<boolean> {
  await acquire();
  try { return await fileExists(path); } finally { release(); }
}
/** Small thumbnails, four concurrent decodes and 120 cached requests. */
export function assetThumbnail(path: string, modifiedAt?: number): Promise<string> {
  const key = `${path}:${modifiedAt ?? 0}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const request = (async () => {
    await acquire();
    try {
      const thumb = await readImageThumbnail(path, { maxEdge: 480 });
      return `data:${thumb.mime};base64,${thumb.base64}`;
    } finally { release(); }
  })();
  cache.set(key, request);
  if (cache.size > 120) cache.delete(cache.keys().next().value!);
  void request.catch(() => cache.delete(key));
  return request;
}
