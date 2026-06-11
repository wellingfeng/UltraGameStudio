import { useEffect, useMemo, useState } from 'react';
import { Database, Gauge, Hash, Zap } from 'lucide-react';
import { workflowDefaultGatewaySelection } from '@/lib/modelGateway/resolver';
import { resolveGatewayRoute } from '@/lib/modelGateway/resolver';
import {
  estimateContextUsage,
  formatCompactTokenCount,
  type ContextUsageTone,
} from '@/lib/contextUsage';
import { RUNTIME_ADAPTERS, type RuntimeAdapterId } from '@/lib/adapters';
import {
  readUsageMeterSnapshot,
  sessionCachePercent,
  subscribeUsageMeter,
} from '@/lib/usageMeter';
import { useStore } from '@/store/useStore';

function contextUsageTextColor(tone: ContextUsageTone): string {
  if (tone === 'danger') return 'text-[var(--status-error)]';
  if (tone === 'warn') return 'text-[var(--status-running)]';
  return 'text-[var(--status-success)]';
}


function formatPercent(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0%';
  if (value < 1) return '<1%';
  return `${Math.min(999, Math.round(value))}%`;
}

function formatCachePercent(value: number | null): string {
  if (value === null) return '--';
  return formatPercent(value);
}

function hostFromBaseUrl(baseUrl: string | undefined): string {
  const raw = baseUrl?.trim();
  if (!raw) return '';
  try {
    return new URL(raw).host;
  } catch {
    return raw.replace(/^https?:\/\//, '').split('/')[0] ?? raw;
  }
}

function isLocalHost(host: string): boolean {
  return /^(localhost|127\.0\.0\.1|\[?::1\]?)($|:)/i.test(host);
}

function displayHost(route: {
  baseUrl?: string;
  providerName?: string;
  adapter?: string;
}): string {
  const host = hostFromBaseUrl(route.baseUrl);
  if (host && !isLocalHost(host)) return host;
  return route.providerName || route.adapter || '模型';
}

function useGatewayVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const bump = () => setVersion((current) => current + 1);
    const onStorage = (event: StorageEvent) => {
      if (event.key) bump();
    };
    window.addEventListener('fuc:gateway-config-changed', bump);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('fuc:gateway-config-changed', bump);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return version;
}

export default function StatusBar() {
  const workflow = useStore((state) => state.workflow);
  const composerModel = useStore((state) => state.composer.model);
  const messages = useStore((state) => state.messages);
  const composerDraft = useStore((state) => state.composerDraft);
  const simpleChatMode = useStore(
    (state) => state.workflow.meta?.simple === true,
  );
  const activeWorkspaceId = useStore((state) => state.activeWorkspaceId);
  const activeSessionId = useStore((state) => state.activeSessionId);
  const gatewayVersion = useGatewayVersion();
  const usageContext = useMemo(
    () => ({ workspaceId: activeWorkspaceId, sessionId: activeSessionId }),
    [activeWorkspaceId, activeSessionId],
  );
  const [usage, setUsage] = useState(() =>
    readUsageMeterSnapshot(usageContext),
  );

  useEffect(() => {
    const refresh = () => setUsage(readUsageMeterSnapshot(usageContext));
    refresh();
    return subscribeUsageMeter(refresh);
  }, [usageContext]);

  const route = useMemo(() => {
    const selection = workflowDefaultGatewaySelection(workflow, composerModel);
    return resolveGatewayRoute({
      ...workflow,
      meta: {
        ...workflow.meta,
        gateway: { ...(workflow.meta.gateway ?? {}), defaults: selection },
      },
    });
  }, [workflow, composerModel, gatewayVersion]);

  const adapter: RuntimeAdapterId =
    RUNTIME_ADAPTERS.find((item) => item.id === route.adapter)?.id ??
    RUNTIME_ADAPTERS[0].id;
  // Mirror the AI-input estimate so the status bar shows the same context
  // budget percentage the composer used to render as a circular dial.
  const contextUsage = useMemo(
    () =>
      estimateContextUsage({
        messages,
        draft: composerDraft,
        adapter,
        model: route.model ?? composerModel,
        simpleChatMode,
      }),
    [messages, composerDraft, adapter, route.model, composerModel, simpleChatMode],
  );

  const host = displayHost(route);
  const isConfigured = route.mode === 'cli' || Boolean(route.apiKey?.trim());
  const statusLabel = isConfigured ? '在线' : '未配置';
  const statusTone =
    statusLabel === '在线'
      ? 'text-[var(--status-success)]'
      : 'text-fg-faint';
  const cachePercent = sessionCachePercent(usage);
  const contextUsageTitle = `上下文用量（估算）：已使用 ${formatCompactTokenCount(
    contextUsage.usedTokens,
  )} / ${formatCompactTokenCount(contextUsage.limitTokens)} tokens`;

  return (
    <footer className="flex h-7 shrink-0 items-center overflow-x-auto border-t border-border bg-panel px-3 text-[11px] leading-none text-fg-dim">
      <div className="flex min-w-max items-center gap-4">
        <span className="inline-flex items-center gap-1.5" title="当前模型通道状态">
          <span
            className={`h-2 w-2 rounded-full ${
              statusLabel === '在线'
                ? 'bg-[var(--status-success)]'
                : 'bg-fg-faint'
            }`}
          />
          <span className={statusTone}>{host} {statusLabel}</span>
        </span>
        <span
          className="inline-flex items-center gap-1.5"
          title={
            cachePercent === null
              ? '本会话尚未拿到服务端缓存用量'
              : '本会话累计缓存命中占比'
          }
        >
          <Zap size={12} className="text-[var(--accent-3)]" />
          <span>缓存</span>
          <span className="font-medium text-[var(--accent-4)]">
            {formatCachePercent(cachePercent)}
          </span>
        </span>
        <span className="inline-flex items-center gap-1.5" title="当前会话累计 token 用量">
          <Hash size={12} className="text-fg-faint" />
          <span>tokens</span>
          <span className="font-medium text-fg">
            {formatCompactTokenCount(usage.totals.totalTokens)}
          </span>
        </span>
        <span
          className="inline-flex items-center gap-1.5"
          title={contextUsageTitle}
          aria-label={contextUsageTitle}
        >
          <Gauge
            size={12}
            className={contextUsageTextColor(contextUsage.tone)}
          />
          <span>上下文</span>
          <span
            className={`font-medium tabular-nums ${contextUsageTextColor(
              contextUsage.tone,
            )}`}
          >
            {contextUsage.displayPercent}
          </span>
        </span>
        <span className="inline-flex items-center gap-1.5 text-fg-faint" title="本地累计调用次数">
          <Database size={12} />
          <span>{usage.totals.calls}</span>
        </span>
      </div>
    </footer>
  );
}
