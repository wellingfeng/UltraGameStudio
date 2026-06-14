// Online 3D asset library catalog + search engine for the /mesh-search flow.
//
// CONTRACT: This module owns the *data* layer and network search for online 3D
// model libraries (Sketchfab, Poly Haven, Poly Pizza, Fab, Unity Asset Store,
// ...). The Project Settings "模型库" tab configures which libraries are enabled
// and stores per-library account API keys; the AIDock /mesh-search command and
// the store's startMeshSearchTurn consume searchMeshLibraries() to render
// results (thumbnails / previews / downloads) into the conversation.
//
// Libraries fall into three search kinds:
//   - 'public-api': free JSON search, no account (Poly Haven).
//   - 'api-key'   : JSON search behind a user-provided key (Sketchfab token,
//                   Poly Pizza key). Direct downloads when the API exposes them.
//   - 'link-out'  : no clean public search API; we deep-link the library's own
//                   search page with the query so the user can browse there
//                   (Fab, Unity Asset Store, CGTrader, TurboSquid, Free3D, ...).

export type MeshLibraryId =
  | 'polyhaven'
  | 'sketchfab'
  | 'poly-pizza'
  | 'fab'
  | 'unity-asset-store'
  | 'cgtrader'
  | 'turbosquid'
  | 'free3d'
  | 'thingiverse'
  | 'quaternius';

export type MeshLibrarySearchKind = 'public-api' | 'api-key' | 'link-out';
export type MeshLibraryCategory = 'free' | 'marketplace' | 'community';

export interface MeshLibraryDefinition {
  id: MeshLibraryId;
  label: string;
  category: MeshLibraryCategory;
  searchKind: MeshLibrarySearchKind;
  /** True when the library needs a user-provided API key/token to search or download. */
  needsKey: boolean;
  /** True when search results can carry a direct, downloadable model URL. */
  supportsDownload: boolean;
  homepageUrl: string;
  /** Where to get the API key/token. */
  credentialUrl?: string;
  keyLabel?: string;
  keyPlaceholder?: string;
  /** Link-out search URL template; {query} is replaced with the encoded query. */
  searchUrlTemplate: string;
  note: string;
}

export interface MeshLibraryAccountSettings {
  /** Libraries the user opted into for /mesh-search. */
  enabledIds: MeshLibraryId[];
  /** Per-library API key/token. */
  apiKeys: Partial<Record<MeshLibraryId, string>>;
  /** Auto-download direct-downloadable results into the workspace cache. */
  autoDownload: boolean;
  /** Max number of results to pull per library. */
  perLibraryLimit: number;
}

export interface MeshSearchResultItem {
  id: string;
  libraryId: MeshLibraryId;
  libraryLabel: string;
  title: string;
  author?: string;
  thumbnailUrl?: string;
  pageUrl: string;
  /** Direct, fetchable model URL when the library exposes one. */
  downloadUrl?: string;
  license?: string;
  format?: string;
  free: boolean;
}

export interface MeshSearchLinkOut {
  libraryId: MeshLibraryId;
  libraryLabel: string;
  searchUrl: string;
  /** Reason a configured library produced a link-out instead of results. */
  reason?: string;
}

export interface MeshSearchError {
  libraryId: MeshLibraryId;
  libraryLabel: string;
  message: string;
}

export interface MeshSearchResult {
  query: string;
  items: MeshSearchResultItem[];
  linkOuts: MeshSearchLinkOut[];
  errors: MeshSearchError[];
}

export interface MeshSearchQueryResolution {
  sourceQuery: string;
  searchQuery: string;
  translated: boolean;
  translatedQuery?: string;
  translationError?: string;
}

export type MeshSearchEnglishTranslator = (query: string) => Promise<string>;

const STORAGE_KEY = 'freeultracode.meshLibrary.v1';

export const MESH_LIBRARY_CATEGORY_LABELS: Record<MeshLibraryCategory, string> = {
  free: '免费 / CC0',
  marketplace: '商店 / 授权',
  community: '社区',
};

export const MESH_LIBRARIES: MeshLibraryDefinition[] = [
  {
    id: 'polyhaven',
    label: 'Poly Haven',
    category: 'free',
    searchKind: 'public-api',
    needsKey: false,
    supportsDownload: true,
    homepageUrl: 'https://polyhaven.com/models',
    searchUrlTemplate: 'https://polyhaven.com/models?search={query}',
    note: '完全免费 CC0 模型库，公开 API，可直接下载 glTF/glb，无需账号。',
  },
  {
    id: 'sketchfab',
    label: 'Sketchfab',
    category: 'community',
    searchKind: 'api-key',
    needsKey: false,
    supportsDownload: true,
    homepageUrl: 'https://sketchfab.com/3d-models',
    credentialUrl: 'https://sketchfab.com/settings/password',
    keyLabel: 'Sketchfab API Token',
    keyPlaceholder: '可选；填写后可对可下载模型直接下载 glb',
    searchUrlTemplate: 'https://sketchfab.com/search?q={query}&type=models',
    note: '海量社区模型。搜索无需 Token；配置 API Token 后可对「可下载」模型直接下载 glb。',
  },
  {
    id: 'poly-pizza',
    label: 'Poly Pizza',
    category: 'free',
    searchKind: 'api-key',
    needsKey: true,
    supportsDownload: true,
    homepageUrl: 'https://poly.pizza/',
    credentialUrl: 'https://poly.pizza/api',
    keyLabel: 'Poly Pizza API Key',
    keyPlaceholder: '粘贴 API Key',
    searchUrlTemplate: 'https://poly.pizza/search/{query}',
    note: '免费低多边形模型库，需 API Key；返回可直接下载的 glb。',
  },
  {
    id: 'fab',
    label: 'Fab (Epic)',
    category: 'marketplace',
    searchKind: 'link-out',
    needsKey: false,
    supportsDownload: false,
    homepageUrl: 'https://www.fab.com/',
    credentialUrl: 'https://www.fab.com/',
    keyLabel: 'Epic 账号备注',
    keyPlaceholder: '可选；记录使用的 Epic 账号或备注',
    searchUrlTemplate: 'https://www.fab.com/search?q={query}',
    note: 'Epic 的 Fab 资产商店。无公开搜索 API，按关键字深链到 Fab 搜索页，下载在 Fab/Epic 账号内完成。',
  },
  {
    id: 'unity-asset-store',
    label: 'Unity Asset Store',
    category: 'marketplace',
    searchKind: 'link-out',
    needsKey: false,
    supportsDownload: false,
    homepageUrl: 'https://assetstore.unity.com/',
    credentialUrl: 'https://assetstore.unity.com/',
    keyLabel: 'Unity 账号备注',
    keyPlaceholder: '可选；记录使用的 Unity 账号或备注',
    searchUrlTemplate: 'https://assetstore.unity.com/?q={query}&category=3d',
    note: 'Unity 官方资产商店。授权模型需在 Unity 账号 / Package Manager 内获取，按关键字深链到商店搜索页。',
  },
  {
    id: 'cgtrader',
    label: 'CGTrader',
    category: 'marketplace',
    searchKind: 'link-out',
    needsKey: false,
    supportsDownload: false,
    homepageUrl: 'https://www.cgtrader.com/3d-models',
    searchUrlTemplate: 'https://www.cgtrader.com/3d-models?keywords={query}',
    note: '商用 3D 模型市场，含部分免费模型。按关键字深链到 CGTrader 搜索页。',
  },
  {
    id: 'turbosquid',
    label: 'TurboSquid',
    category: 'marketplace',
    searchKind: 'link-out',
    needsKey: false,
    supportsDownload: false,
    homepageUrl: 'https://www.turbosquid.com/',
    searchUrlTemplate: 'https://www.turbosquid.com/Search/3D-Models?keyword={query}',
    note: '老牌商用 3D 模型市场。按关键字深链到 TurboSquid 搜索页。',
  },
  {
    id: 'free3d',
    label: 'Free3D',
    category: 'community',
    searchKind: 'link-out',
    needsKey: false,
    supportsDownload: false,
    homepageUrl: 'https://free3d.com/',
    searchUrlTemplate: 'https://free3d.com/3d-models/{query}',
    note: '免费 / 付费混合社区模型站。按关键字深链到 Free3D 搜索页。',
  },
  {
    id: 'thingiverse',
    label: 'Thingiverse',
    category: 'community',
    searchKind: 'link-out',
    needsKey: false,
    supportsDownload: false,
    homepageUrl: 'https://www.thingiverse.com/',
    credentialUrl: 'https://www.thingiverse.com/developers',
    keyLabel: 'Thingiverse App Token',
    keyPlaceholder: '可选；记录 App Token 备注',
    searchUrlTemplate: 'https://www.thingiverse.com/search?q={query}&type=things',
    note: '偏 3D 打印 STL 的社区库。按关键字深链到 Thingiverse 搜索页。',
  },
  {
    id: 'quaternius',
    label: 'Quaternius',
    category: 'free',
    searchKind: 'link-out',
    needsKey: false,
    supportsDownload: false,
    homepageUrl: 'https://quaternius.com/',
    searchUrlTemplate: 'https://quaternius.com/packs.html',
    note: '免费 CC0 低多边形游戏资产包（角色、环境、武器等），按包下载，深链到官网浏览。',
  },
];

const MESH_LIBRARY_BY_ID = new Map<MeshLibraryId, MeshLibraryDefinition>(
  MESH_LIBRARIES.map((library) => [library.id, library]),
);

export const DEFAULT_MESH_LIBRARY_SETTINGS: MeshLibraryAccountSettings = {
  enabledIds: ['polyhaven', 'sketchfab'],
  apiKeys: {},
  autoDownload: true,
  perLibraryLimit: 6,
};

export function meshLibraryById(id: MeshLibraryId): MeshLibraryDefinition | undefined {
  return MESH_LIBRARY_BY_ID.get(id);
}

function isMeshLibraryId(value: unknown): value is MeshLibraryId {
  return typeof value === 'string' && MESH_LIBRARY_BY_ID.has(value as MeshLibraryId);
}

function hasStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage;
}

export function normalizeMeshLibrarySettings(value: unknown): MeshLibraryAccountSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_MESH_LIBRARY_SETTINGS };
  }
  const source = value as Partial<MeshLibraryAccountSettings>;
  const enabledIds = Array.isArray(source.enabledIds)
    ? Array.from(new Set(source.enabledIds.filter(isMeshLibraryId)))
    : [...DEFAULT_MESH_LIBRARY_SETTINGS.enabledIds];
  const apiKeys: Partial<Record<MeshLibraryId, string>> = {};
  if (source.apiKeys && typeof source.apiKeys === 'object' && !Array.isArray(source.apiKeys)) {
    for (const [key, raw] of Object.entries(source.apiKeys)) {
      if (!isMeshLibraryId(key) || typeof raw !== 'string') continue;
      const trimmed = raw.trim();
      if (trimmed) apiKeys[key] = trimmed;
    }
  }
  const perLibraryLimit =
    typeof source.perLibraryLimit === 'number' && Number.isFinite(source.perLibraryLimit)
      ? Math.min(Math.max(Math.round(source.perLibraryLimit), 1), 24)
      : DEFAULT_MESH_LIBRARY_SETTINGS.perLibraryLimit;
  return {
    enabledIds,
    apiKeys,
    autoDownload:
      typeof source.autoDownload === 'boolean'
        ? source.autoDownload
        : DEFAULT_MESH_LIBRARY_SETTINGS.autoDownload,
    perLibraryLimit,
  };
}

export function loadMeshLibrarySettings(): MeshLibraryAccountSettings {
  if (!hasStorage()) return { ...DEFAULT_MESH_LIBRARY_SETTINGS };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return normalizeMeshLibrarySettings(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_MESH_LIBRARY_SETTINGS };
  }
}

export function saveMeshLibrarySettings(settings: MeshLibraryAccountSettings): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(normalizeMeshLibrarySettings(settings)),
    );
    window.dispatchEvent(new Event('fuc:mesh-library-settings-changed'));
  } catch {
    /* non-fatal */
  }
}

export function meshLibraryReady(
  id: MeshLibraryId,
  settings = loadMeshLibrarySettings(),
): boolean {
  const library = meshLibraryById(id);
  if (!library) return false;
  if (library.needsKey) return !!settings.apiKeys[id]?.trim();
  return true;
}

/**
 * Usability classifies whether a library can actually run an in-app search and
 * surface real (downloadable) results — not merely whether it has been toggled
 * on. This powers the "已启用" tab, which only lists libraries that genuinely
 * work end to end:
 *   - 'usable'    : in-app JSON search works now (key configured where needed).
 *   - 'needs-key' : in-app search is supported but the required key is missing.
 *   - 'link-only' : no public search API; can only deep-link to the site.
 */
export type MeshLibraryUsability = 'usable' | 'needs-key' | 'link-only';

export function meshLibraryUsability(
  id: MeshLibraryId,
  settings = loadMeshLibrarySettings(),
): MeshLibraryUsability {
  const library = meshLibraryById(id);
  if (!library) return 'link-only';
  if (library.searchKind === 'link-out') return 'link-only';
  if (library.needsKey && !settings.apiKeys[id]?.trim()) return 'needs-key';
  return 'usable';
}

/** True only when the library can actually search/download from inside the app. */
export function meshLibraryUsable(
  id: MeshLibraryId,
  settings = loadMeshLibrarySettings(),
): boolean {
  return meshLibraryUsability(id, settings) === 'usable';
}

export function meshLibrarySearchUrl(library: MeshLibraryDefinition, query: string): string {
  return library.searchUrlTemplate.replace('{query}', encodeURIComponent(query.trim()));
}

/** Strip the /mesh-search command prefix and surrounding noise from raw input. */
export function stripMeshSearchCommand(text: string): string {
  return text
    .trim()
    .replace(/^\/(?:mesh-search|model-search|asset-search|搜模型|搜索模型|找模型)\s*/iu, '')
    .trim();
}

export function looksLikeMeshSearchRequest(text: string): boolean {
  return /^\/(?:mesh-search|model-search|asset-search|搜模型|搜索模型|找模型)(?:\s|$)/iu.test(
    text.trim(),
  );
}

export function meshSearchQueryNeedsEnglish(query: string): boolean {
  // Auto-detecting ASCII-only non-English text (for example Spanish without
  // accents) is unreliable without a language model/API, so /mesh-search lets
  // the public translator normalize every non-empty query toward English. When
  // the input is already English, resolveMeshSearchQuery treats the unchanged
  // translated result as a normal, untranslated search.
  return query.trim().length > 0;
}

export function normalizeMeshSearchKeywords(query: string): string {
  return query
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]+/gu, '')
    .normalize('NFKC')
    .replace(/[“”„]/gu, '"')
    .replace(/[‘’]/gu, "'")
    .replace(/\b(?:please\s+)?(?:search|find|look\s+for)\b/giu, ' ')
    .replace(/\b(?:a|an|the)\s+3d\s+models?\s+(?:of|for)\b/giu, ' ')
    .replace(/\b3d\s+models?\s+(?:of|for)\b/giu, ' ')
    .replace(/\b3d\s+models?\b/giu, ' ')
    .replace(/\blow\s*[- ]?\s*polygon(?:al)?\b/giu, 'low poly')
    .replace(/\blowpoly\b/giu, 'low poly')
    .replace(/[()[\]{}"<>]+/gu, ' ')
    .replace(/[，。、“”‘’：；！？,.:;!?]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function containsNonAsciiCharacters(text: string): boolean {
  for (const char of text) {
    if ((char.codePointAt(0) ?? 0) > 0x7f) return true;
  }
  return false;
}

export async function resolveMeshSearchQuery(
  query: string,
  translateToEnglish: MeshSearchEnglishTranslator,
): Promise<MeshSearchQueryResolution> {
  const sourceQuery = query.trim();
  if (!sourceQuery) {
    return { sourceQuery, searchQuery: '', translated: false };
  }

  const normalizedSourceQuery =
    normalizeMeshSearchKeywords(sourceQuery) || sourceQuery;

  try {
    const translatedQuery = normalizeMeshSearchKeywords(
      await translateToEnglish(sourceQuery),
    );
    if (!translatedQuery || containsNonAsciiCharacters(translatedQuery)) {
      return {
        sourceQuery,
        searchQuery: normalizedSourceQuery,
        translated: false,
        translatedQuery: translatedQuery || undefined,
      };
    }
    const sourceKey = normalizedSourceQuery.toLocaleLowerCase();
    const translatedKey = translatedQuery.toLocaleLowerCase();
    return {
      sourceQuery,
      searchQuery: translatedQuery,
      translated: translatedKey !== sourceKey,
      translatedQuery:
        translatedKey !== sourceKey ? translatedQuery : undefined,
    };
  } catch (err) {
    return {
      sourceQuery,
      searchQuery: normalizedSourceQuery,
      translated: false,
      translationError: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Search engine
// ---------------------------------------------------------------------------

interface PolyHavenAssetEntry {
  name?: string;
  type?: number;
  categories?: string[];
  authors?: Record<string, string>;
}

interface SketchfabModelEntry {
  uid?: string;
  name?: string;
  viewerUrl?: string;
  isDownloadable?: boolean;
  user?: { displayName?: string; username?: string };
  thumbnails?: { images?: Array<{ url?: string; width?: number }> };
  license?: { label?: string } | null;
}

interface SketchfabSearchResponse {
  results?: SketchfabModelEntry[];
}

interface PolyPizzaModelEntry {
  ID?: string;
  Title?: string;
  Thumbnail?: string;
  Download?: string;
  Attribution?: string;
  Creator?: { Username?: string; DPURL?: string } | string;
  Licence?: string;
}

interface PolyPizzaSearchResponse {
  results?: PolyPizzaModelEntry[];
}

async function fetchJson<T>(url: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { ...init, signal, cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

function pickSketchfabThumbnail(entry: SketchfabModelEntry): string | undefined {
  const images = entry.thumbnails?.images ?? [];
  if (images.length === 0) return undefined;
  const sorted = [...images].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  const medium = sorted.find((image) => (image.width ?? 0) >= 256) ?? sorted[sorted.length - 1];
  return medium?.url;
}

async function searchPolyHaven(
  library: MeshLibraryDefinition,
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<MeshSearchResultItem[]> {
  const assets = await fetchJson<Record<string, PolyHavenAssetEntry>>(
    'https://api.polyhaven.com/assets?type=models',
    { headers: { Accept: 'application/json' } },
    signal,
  );
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = Object.entries(assets)
    .filter(([slug, asset]) => {
      const haystack = `${slug} ${asset.name ?? ''} ${(asset.categories ?? []).join(' ')}`.toLowerCase();
      return terms.length === 0 || terms.every((term) => haystack.includes(term));
    })
    .slice(0, limit);
  return matches.map(([slug, asset]) => ({
    id: `polyhaven:${slug}`,
    libraryId: library.id,
    libraryLabel: library.label,
    title: asset.name ?? slug,
    author: asset.authors ? Object.keys(asset.authors).join(', ') : undefined,
    thumbnailUrl: `https://cdn.polyhaven.com/asset_img/thumbs/${slug}.png?width=256&height=256`,
    pageUrl: `https://polyhaven.com/a/${slug}`,
    downloadUrl: `https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/${slug}/${slug}_1k.gltf`,
    license: 'CC0',
    format: 'gltf',
    free: true,
  }));
}

async function searchSketchfab(
  library: MeshLibraryDefinition,
  query: string,
  limit: number,
  token: string | undefined,
  signal?: AbortSignal,
): Promise<MeshSearchResultItem[]> {
  const params = new URLSearchParams({
    type: 'models',
    q: query,
    count: String(Math.min(limit, 24)),
    sort_by: '-likeCount',
  });
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Token ${token}`;
  const data = await fetchJson<SketchfabSearchResponse>(
    `https://api.sketchfab.com/v3/search?${params.toString()}`,
    { headers },
    signal,
  );
  return (data.results ?? []).slice(0, limit).map((entry) => ({
    id: `sketchfab:${entry.uid ?? entry.name ?? Math.random().toString(36)}`,
    libraryId: library.id,
    libraryLabel: library.label,
    title: entry.name ?? '(untitled)',
    author: entry.user?.displayName ?? entry.user?.username,
    thumbnailUrl: pickSketchfabThumbnail(entry),
    pageUrl: entry.viewerUrl ?? `https://sketchfab.com/3d-models/${entry.uid ?? ''}`,
    // Direct download needs the OAuth download endpoint; only expose when the
    // model is downloadable and a token is configured.
    downloadUrl:
      token && entry.isDownloadable && entry.uid
        ? `https://api.sketchfab.com/v3/models/${entry.uid}/download`
        : undefined,
    license: entry.license?.label ?? undefined,
    free: entry.isDownloadable === true,
  }));
}

async function searchPolyPizza(
  library: MeshLibraryDefinition,
  query: string,
  limit: number,
  key: string,
  signal?: AbortSignal,
): Promise<MeshSearchResultItem[]> {
  const data = await fetchJson<PolyPizzaSearchResponse>(
    `https://api.poly.pizza/v1.1/search/${encodeURIComponent(query)}?Limit=${Math.min(limit, 24)}`,
    { headers: { 'x-auth-token': key, Accept: 'application/json' } },
    signal,
  );
  return (data.results ?? []).slice(0, limit).map((entry) => {
    const creator =
      typeof entry.Creator === 'string' ? entry.Creator : entry.Creator?.Username;
    return {
      id: `poly-pizza:${entry.ID ?? entry.Title ?? Math.random().toString(36)}`,
      libraryId: library.id,
      libraryLabel: library.label,
      title: entry.Title ?? '(untitled)',
      author: creator,
      thumbnailUrl: entry.Thumbnail,
      pageUrl: entry.ID ? `https://poly.pizza/m/${entry.ID}` : library.homepageUrl,
      downloadUrl: entry.Download,
      license: entry.Licence,
      format: 'glb',
      free: true,
    };
  });
}

/**
 * Search every enabled library for `query`. API-backed libraries return real
 * results; link-out libraries (and configured-but-keyless API libraries)
 * contribute a deep-linked search URL the user can open. Network failures are
 * captured per-library so one source failing never aborts the others.
 */
export async function searchMeshLibraries(
  query: string,
  settings = loadMeshLibrarySettings(),
  signal?: AbortSignal,
): Promise<MeshSearchResult> {
  const trimmed = query.trim();
  const enabled = MESH_LIBRARIES.filter((library) =>
    settings.enabledIds.includes(library.id),
  );
  const items: MeshSearchResultItem[] = [];
  const linkOuts: MeshSearchLinkOut[] = [];
  const errors: MeshSearchError[] = [];

  if (!trimmed) {
    return { query: trimmed, items, linkOuts, errors };
  }

  const tasks = enabled.map(async (library) => {
    const key = settings.apiKeys[library.id]?.trim();
    const searchUrl = meshLibrarySearchUrl(library, trimmed);
    try {
      if (library.searchKind === 'public-api') {
        const found = await searchPolyHaven(library, trimmed, settings.perLibraryLimit, signal);
        items.push(...found);
        return;
      }
      if (library.searchKind === 'api-key') {
        if (library.id === 'sketchfab') {
          const found = await searchSketchfab(
            library,
            trimmed,
            settings.perLibraryLimit,
            key,
            signal,
          );
          items.push(...found);
          return;
        }
        if (library.id === 'poly-pizza') {
          if (!key) {
            linkOuts.push({
              libraryId: library.id,
              libraryLabel: library.label,
              searchUrl,
              reason: '未配置 API Key，已改为深链搜索页',
            });
            return;
          }
          const found = await searchPolyPizza(
            library,
            trimmed,
            settings.perLibraryLimit,
            key,
            signal,
          );
          items.push(...found);
          return;
        }
      }
      // link-out
      linkOuts.push({
        libraryId: library.id,
        libraryLabel: library.label,
        searchUrl,
      });
    } catch (err) {
      if (signal?.aborted) return;
      errors.push({
        libraryId: library.id,
        libraryLabel: library.label,
        message: err instanceof Error ? err.message : String(err),
      });
      // Fall back to a link-out so the user still has a path forward.
      linkOuts.push({
        libraryId: library.id,
        libraryLabel: library.label,
        searchUrl,
        reason: '在线搜索失败，已改为深链搜索页',
      });
    }
  });

  await Promise.all(tasks);
  return { query: trimmed, items, linkOuts, errors };
}




