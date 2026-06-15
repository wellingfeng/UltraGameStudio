import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import {
  Check,
  DownloadCloud,
  ExternalLink,
  RefreshCw,
  Search,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import {
  isTauri,
  installSkillFromText,
  installSkillFromUrl,
  openExternal,
  refreshSlashCatalog,
  skillInstallTargets,
  type SkillInstallTarget,
} from '@/lib/tauri';
import {
  buildSkillInstallTextFromMarkdown,
  filterPluginStoreItems,
  loadPluginStoreCatalog,
  pluginStoreSources,
  slugFromName,
  type PluginStoreItem,
  type PluginStoreKind,
  type PluginStoreLoadResult,
} from '@/lib/pluginStore';
import {
  cachedPluginDescriptionTranslation,
  shouldTranslatePluginDescription,
  translatePluginDescriptionCached,
} from '@/lib/pluginStoreTranslation';
import {
  loadTranslationSettings,
  subscribeTranslationSettings,
  translationSettingsCacheKey,
  type TranslationSettings,
} from '@/lib/translationSettings';
import { t, type Locale } from '@/lib/i18n';

const INNER_TABLIST_CLASS =
  'flex w-full min-w-0 flex-wrap gap-1 rounded-lg border border-border-soft bg-bg p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]';
const INNER_TAB_CLASS =
  'min-h-11 min-w-[7rem] flex-1 basis-[8.5rem] rounded-md border px-5 py-2.5 text-sm font-semibold outline-none transition-[background-color,border-color,color,box-shadow] focus-visible:ring-1 focus-visible:ring-accent';

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function useTranslationSettingsState(): TranslationSettings {
  const [settings, setSettings] = useState<TranslationSettings>(() =>
    loadTranslationSettings(),
  );
  useEffect(() => subscribeTranslationSettings(setSettings), []);
  return settings;
}

const PLUGIN_STORE_KIND_FILTERS: Array<{
  id: PluginStoreKind | 'all';
  label: string;
}> = [
  { id: 'all', label: '全部' },
  { id: 'skill', label: 'Skills' },
  { id: 'plugin', label: '插件' },
  { id: 'index', label: '索引' },
];

function pluginStoreKindLabel(kind: PluginStoreKind): string {
  switch (kind) {
    case 'skill':
      return 'Skill';
    case 'plugin':
      return '插件';
    case 'index':
      return '索引';
  }
}

function pluginStoreTrustLabel(item: PluginStoreItem): string {
  switch (item.trust) {
    case 'official':
      return '官方';
    case 'curated':
      return '精选';
    case 'registry':
      return 'Registry';
    case 'community':
      return '社区';
  }
}

function pluginStoreActionLabel(item: PluginStoreItem): string {
  if (item.installKind === 'skill') return '安装';
  if (item.installKind === 'pluginManifest') return '复制清单';
  if (item.installKind === 'external') return '复制地址';
  return '打开来源';
}

export interface PluginStorePanelProps {
  locale: Locale;
  title?: string;
  description?: string;
  defaultKind?: PluginStoreKind | 'all';
  defaultSourceId?: string;
  /** Notified after a skill is installed so callers can refresh local views. */
  onSkillInstalled?: () => void;
  /**
   * Active workspace path. When provided, project-scoped skill install targets
   * (.codex/.agents/.claude under the project) are offered alongside global ones.
   */
  projectRoot?: string | null;
}

export function PluginStorePanel({
  locale,
  title,
  description,
  defaultKind = 'all',
  defaultSourceId = 'all',
  onSkillInstalled,
  projectRoot,
}: PluginStorePanelProps) {
  const translationSettings = useTranslationSettingsState();
  const translationKey = translationSettingsCacheKey(translationSettings);
  const [catalog, setCatalog] = useState<PluginStoreLoadResult>(() => ({
    loadedAtMs: 0,
    items: [],
    errors: [],
  }));
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<PluginStoreKind | 'all'>(defaultKind);
  const [sourceId, setSourceId] = useState(defaultSourceId);
  const [targets, setTargets] = useState<SkillInstallTarget[]>([]);
  const [targetId, setTargetId] = useState('');
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [status, setStatus] = useState<{ tone: 'ok' | 'err'; msg: string } | null>(
    null,
  );

  const loadCatalog = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setStatus(null);
    try {
      const next = await loadPluginStoreCatalog(signal);
      if (signal?.aborted) return;
      setCatalog(next);
    } catch (err) {
      if (signal?.aborted) return;
      setStatus({ tone: 'err', msg: `在线仓库加载失败: ${describeError(err)}` });
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadCatalog(controller.signal);
    return () => controller.abort();
  }, [loadCatalog]);

  const loadTargets = useCallback(async () => {
    const next = await skillInstallTargets(projectRoot);
    setTargets(next);
    setTargetId((current) => {
      if (current && next.some((target) => target.id === current)) return current;
      return next.find((target) => target.isDefault)?.id ?? next[0]?.id ?? '';
    });
  }, [projectRoot]);

  useEffect(() => {
    void loadTargets();
  }, [loadTargets]);
  const sourceOptions = useMemo(
    () => pluginStoreSources(catalog.items),
    [catalog.items],
  );
  const filtered = useMemo(
    () => filterPluginStoreItems(catalog.items, query, kind, sourceId),
    [catalog.items, kind, query, sourceId],
  );
  const kindCounts = useMemo(() => {
    const counts = new Map<PluginStoreKind | 'all', number>([
      ['all', catalog.items.length],
    ]);
    for (const item of catalog.items) {
      counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
    }
    return counts;
  }, [catalog.items]);

  const selectedTargetId =
    targetId || targets.find((target) => target.isDefault)?.id || targets[0]?.id || '';

  const copyText = async (item: PluginStoreItem, text: string, msg: string) => {
    await navigator.clipboard?.writeText(text);
    setCopiedId(item.id);
    setStatus({ tone: 'ok', msg });
    window.setTimeout(() => {
      setCopiedId((current) => (current === item.id ? null : current));
    }, 1500);
  };

  const handleInstall = useCallback(
    async (item: PluginStoreItem, overwrite: boolean) => {
      if (!item.installUrl) return;
      if (!selectedTargetId) {
        setStatus({ tone: 'err', msg: '未找到可用安装目标。' });
        return;
      }
      setInstallingId(item.id);
      setStatus(null);
      try {
        const installParams = {
          name: item.title,
          slug: item.name || slugFromName(item.title),
          targetId: selectedTargetId,
          overwrite,
          sourceUrl: item.sourceUrl ?? null,
          projectRoot,
        };
        const installed =
          item.installTransform === 'wrapMarkdownAsSkill'
            ? await installSkillFromText({
                ...installParams,
                text: buildSkillInstallTextFromMarkdown(
                  item,
                  await fetch(item.installUrl, { cache: 'no-store' }).then((response) => {
                    if (!response.ok) {
                      throw new Error(`${response.status} ${response.statusText}`);
                    }
                    return response.text();
                  }),
                ),
              })
            : await installSkillFromUrl({
                ...installParams,
                url: item.installUrl,
              });
        await refreshSlashCatalog();
        await loadTargets();
        onSkillInstalled?.();
        setStatus({
          tone: 'ok',
          msg: installed.overwritten
            ? `已覆盖安装 ${installed.name}。`
            : `已安装 ${installed.name}。`,
        });
      } catch (err) {
        const msg = describeError(err);
        if (!overwrite && msg.includes('已存在')) {
          setInstallingId(null);
          if (window.confirm(`目标 skill 已存在，覆盖安装「${item.title}」？`)) {
            await handleInstall(item, true);
          }
          return;
        }
        setStatus({ tone: 'err', msg: `安装失败: ${msg}` });
      } finally {
        setInstallingId((current) => (current === item.id ? null : current));
      }
    },
    [loadTargets, onSkillInstalled, projectRoot, selectedTargetId],
  );

  const handleAction = async (item: PluginStoreItem) => {
    if (item.installKind === 'skill' && item.installUrl) {
      await handleInstall(item, false);
      return;
    }
    if (item.installKind === 'none') {
      if (item.sourceUrl) void openExternal(item.sourceUrl);
      return;
    }
    const text = item.installUrl || item.sourceUrl;
    if (text) {
      await copyText(item, text, '已复制安装地址。');
      return;
    }
    if (item.sourceUrl) void openExternal(item.sourceUrl);
  };

  const handleRefreshLocal = async () => {
    setStatus(null);
    try {
      await refreshSlashCatalog();
      await loadTargets();
      onSkillInstalled?.();
      setStatus({ tone: 'ok', msg: '本地命令/技能目录已刷新。' });
    } catch (err) {
      setStatus({ tone: 'err', msg: `刷新失败: ${describeError(err)}` });
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-lg font-semibold text-fg">
            {title ?? t(locale, 'settings.pluginStoreTitle')}
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-fg-faint">
            {description ?? t(locale, 'settings.pluginStoreDescription')}
          </p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <button
            type="button"
            onClick={() => void loadCatalog()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded border border-border bg-panel px-2.5 py-1 text-xs text-fg-dim transition-colors hover:border-accent hover:text-fg disabled:cursor-wait disabled:opacity-60"
          >
            <RefreshCw size={13} strokeWidth={2.2} className={loading ? 'animate-spin' : ''} />
            刷新在线仓库
          </button>
          <button
            type="button"
            onClick={() => void handleRefreshLocal()}
            className="inline-flex items-center gap-1.5 rounded border border-border bg-panel px-2.5 py-1 text-xs text-fg-dim transition-colors hover:border-accent hover:text-fg"
          >
            <RefreshCw size={13} strokeWidth={2.2} />
            刷新本地目录
          </button>
        </div>
      </div>

      {status && (
        <p
          className={cn(
            'text-[11px] leading-relaxed',
            status.tone === 'ok' ? 'text-emerald-300' : 'text-rose-300',
          )}
        >
          {status.msg}
        </p>
      )}

      <div className="grid gap-3 rounded-lg border border-border-soft bg-bg-alt p-3 lg:grid-cols-[minmax(14rem,1fr)_12rem_15rem]">
        <div className="relative">
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-faint"
          />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索 skill、插件、来源…"
            className="w-full rounded-lg border border-border bg-bg py-2 pl-9 pr-3 text-sm text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none"
          />
        </div>

        <select
          value={sourceId}
          onChange={(event) => setSourceId(event.target.value)}
          className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-accent"
        >
          <option value="all">全部来源</option>
          {sourceOptions.map((source) => (
            <option key={source.id} value={source.id}>
              {source.name} ({source.count})
            </option>
          ))}
        </select>

        <select
          value={selectedTargetId}
          onChange={(event) => setTargetId(event.target.value)}
          disabled={targets.length === 0}
          className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-accent disabled:opacity-60"
        >
          {targets.length === 0 ? (
            <option value="">桌面版可安装</option>
          ) : (
            targets.map((target) => (
              <option key={target.id} value={target.id}>
                {target.scope === 'project' ? '项目' : '全局'} · {target.label} ({target.skillCount})
              </option>
            ))
          )}
        </select>
      </div>

      <div className={INNER_TABLIST_CLASS}>
        {PLUGIN_STORE_KIND_FILTERS.map((item) => {
          const active = kind === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setKind(item.id)}
              className={cn(
                INNER_TAB_CLASS,
                active
                  ? 'border-accent bg-accent/15 text-fg shadow-[0_0_0_1px_color-mix(in_oklab,var(--accent)_32%,transparent)]'
                  : 'border-transparent text-fg-dim hover:bg-panel hover:text-fg',
              )}
            >
              {item.label}
              <span className="ml-1 text-[11px] font-normal text-fg-faint">
                {kindCounts.get(item.id) ?? 0}
              </span>
            </button>
          );
        })}
      </div>

      {catalog.errors.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-100">
          部分来源加载失败：
          {catalog.errors.map((error) => `${error.sourceName}: ${error.message}`).join('；')}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 text-[11px] text-fg-faint">
        <span>
          共 {catalog.items.length} 项，当前显示 {filtered.length} 项
        </span>
        {catalog.loadedAtMs > 0 && (
          <span>{new Date(catalog.loadedAtMs).toLocaleString()}</span>
        )}
      </div>

      {loading && catalog.items.length === 0 ? (
        <p className="rounded-lg border border-border bg-bg-alt px-4 py-8 text-center text-xs text-fg-faint">
          正在加载在线仓库…
        </p>
      ) : filtered.length === 0 ? (
        <p className="rounded-lg border border-border bg-bg-alt px-4 py-8 text-center text-xs text-fg-faint">
          没有匹配的条目。
        </p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          {filtered.map((item) => (
            <PluginStoreItemCard
              key={item.id}
              item={item}
              locale={locale}
              translationKey={translationKey}
              desktop={isTauri()}
              installing={installingId === item.id}
              copied={copiedId === item.id}
              onAction={() => void handleAction(item)}
              onOpen={() => item.sourceUrl && void openExternal(item.sourceUrl)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PluginStoreItemCard({
  item,
  locale,
  translationKey,
  desktop,
  installing,
  copied,
  onAction,
  onOpen,
}: {
  item: PluginStoreItem;
  locale: Locale;
  translationKey: string;
  desktop: boolean;
  installing: boolean;
  copied: boolean;
  onAction: () => void;
  onOpen: () => void;
}) {
  const canInstallSkill = item.installKind === 'skill' && desktop;
  const primaryDisabled = item.installKind === 'skill' && !canInstallSkill;
  const actionLabel = primaryDisabled ? '桌面版安装' : pluginStoreActionLabel(item);
  const { descriptionRef, description } = useVisiblePluginDescription(
    item,
    locale,
    translationKey,
  );

  return (
    <div className="flex min-h-[13rem] flex-col rounded-lg border border-border bg-bg-alt px-4 py-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[10px] font-semibold text-accent">
          {pluginStoreKindLabel(item.kind)}
        </span>
        <span className="rounded border border-border bg-panel px-1.5 py-0.5 text-[10px] text-fg-faint">
          {pluginStoreTrustLabel(item)}
        </span>
        {item.category && (
          <span className="rounded border border-border bg-panel px-1.5 py-0.5 text-[10px] text-fg-faint">
            {item.category}
          </span>
        )}
      </div>

      <div className="mt-3 min-w-0 flex-1">
        <h4 className="truncate text-sm font-semibold text-fg">{item.title}</h4>
        <p
          ref={descriptionRef}
          className="mt-1 line-clamp-3 text-xs leading-relaxed text-fg-dim"
        >
          {description}
        </p>
        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-fg-faint">
          <span>{item.sourceName}</span>
          {item.author && <span>{item.author}</span>}
          {item.version && <span>v{item.version}</span>}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={onAction}
          disabled={installing || primaryDisabled}
          className="inline-flex items-center gap-1.5 rounded border border-accent bg-accent/15 px-2.5 py-1 text-xs font-medium text-fg transition-colors hover:bg-accent/25 disabled:cursor-not-allowed disabled:border-border disabled:bg-panel disabled:text-fg-faint"
        >
          {copied ? <Check size={13} /> : <DownloadCloud size={13} />}
          {installing ? '安装中…' : copied ? '已复制' : actionLabel}
        </button>
        {item.sourceUrl && (
          <button
            type="button"
            onClick={onOpen}
            className="inline-flex items-center gap-1.5 rounded border border-border bg-panel px-2.5 py-1 text-xs text-fg-dim transition-colors hover:border-accent hover:text-fg"
          >
            <ExternalLink size={13} />
            来源
          </button>
        )}
      </div>
    </div>
  );
}

function useVisiblePluginDescription(
  item: PluginStoreItem,
  locale: Locale,
  translationKey: string,
): {
  descriptionRef: RefObject<HTMLParagraphElement>;
  description: string;
} {
  const descriptionRef = useRef<HTMLParagraphElement>(null);
  const shouldTranslate = shouldTranslatePluginDescription(item.description, locale);
  const [visible, setVisible] = useState(false);
  const [description, setDescription] = useState(() => {
    if (!shouldTranslate) return item.description;
    return (
      cachedPluginDescriptionTranslation(item.id, item.description, locale) ??
      item.description
    );
  });

  useEffect(() => {
    if (!shouldTranslate) {
      setDescription(item.description);
      return;
    }
    setDescription(
      cachedPluginDescriptionTranslation(item.id, item.description, locale) ??
        item.description,
    );
  }, [item.description, item.id, locale, shouldTranslate, translationKey]);

  useEffect(() => {
    if (!shouldTranslate) return;
    if (visible) return;

    const node = descriptionRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setVisible(true);
        observer.disconnect();
      },
      { rootMargin: '120px 0px', threshold: 0.01 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [item.description, item.id, locale, shouldTranslate, translationKey, visible]);

  useEffect(() => {
    if (!shouldTranslate || !visible) return;
    let active = true;

    void translatePluginDescriptionCached(item.id, item.description, locale).then(
      (translated) => {
        if (active) setDescription(translated);
      },
    );

    return () => {
      active = false;
    };
  }, [item.description, item.id, locale, shouldTranslate, translationKey, visible]);

  return { descriptionRef, description };
}

export default PluginStorePanel;
