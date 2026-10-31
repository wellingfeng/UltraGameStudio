import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, RefreshCw, Search, Wrench, X } from 'lucide-react';
import { desktopToolCatalog } from '@/lib/tools/client';
import { filterTools, scopeKey } from '@/lib/tools/catalog';
import type { ToolCatalogPort, ToolCatalogScope, ToolCatalogSnapshot, ToolDescriptor } from '@/lib/tools/types';

const exposure = { direct: '直接可见', search: '搜索后加载', code: '代码模式可达', unknown: '暴露方式未知' };
const discovery = { live: '会话实时证据', cached: '仅上次发现', observed: '本会话曾调用', unknown: '尚未发现' };

export function ToolCatalogPanel({ scope, snapshot: provided, port = desktopToolCatalog, mode = 'session', onClose }: {
  scope: ToolCatalogScope;
  snapshot?: ToolCatalogSnapshot;
  port?: ToolCatalogPort;
  mode?: 'session' | 'project';
  onClose?: () => void;
}) {
  const [loaded, setLoaded] = useState<ToolCatalogSnapshot | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  const key = scopeKey(scope);
  useEffect(() => {
    setLoaded(null); setError(''); setSelectedId(''); setQuery('');
    if (provided) return;
    const current = ++generation.current;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      setLoading(true);
      try {
        const value = await port.listCatalog(scope);
        if (disposed || generation.current !== current) return;
        setLoaded(previous => previous && value && previous.startedAtMs === value.startedAtMs && previous.revision > value.revision ? previous : value);
        setError('');
        timer = setTimeout(() => void read(), 2000);
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : String(e));
      } finally { if (!disposed) setLoading(false); }
    };
    void read();
    return () => { disposed = true; generation.current++; clearTimeout(timer); };
  // Scope is represented by its complete identity; no old response can cross it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, port, provided, refresh]);

  const snapshot = provided ?? (loaded && scopeKey(loaded.scope) === key ? loaded : null);
  const tools = useMemo(() => filterTools(snapshot?.tools ?? [], query), [snapshot, query]);
  const selected = tools.find(tool => tool.toolId === selectedId) ?? tools[0];
  const groups = useMemo(() => {
    const grouped = new Map<string, ToolDescriptor[]>();
    for (const tool of tools) {
      const label = tool.serverId ? `MCP · ${tool.serverId}` : tool.origin === 'builtin' ? '内置工具' : 'Agent 工具';
      grouped.set(label, [...(grouped.get(label) ?? []), tool]);
    }
    return [...grouped];
  }, [tools]);
  const exportCatalog = () => {
    if (!snapshot) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `tools-${scope.agentId}.json`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return <section aria-label={mode === 'session' ? '当前会话工具目录' : '项目发现工具目录'} className="flex min-h-0 flex-col rounded-lg border border-border bg-panel text-fg shadow-xl">
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border-soft p-4">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-sm font-semibold"><Wrench size={16} />{mode === 'session' ? '当前会话工具目录' : '项目发现工具目录'}</h2>
        <p className="mt-1 break-all text-xs text-fg-faint">{scope.agentId} · {scope.model || '默认模型'} · {snapshot?.tools.length ?? 0} 项</p>
        <p className="mt-1 break-all text-[11px] text-fg-faint">工作区 {scope.workspaceId || '未选择'} · 会话 {scope.sessionId || '项目配置'}{scope.channelId ? ` · 渠道 ${scope.channelId}` : ''}</p>
        <p className="mt-1 text-[11px] text-fg-faint">{snapshot?.updatedAtMs ? `快照 ${new Date(snapshot.updatedAtMs).toLocaleString('zh-CN')}` : '尚无目录快照'} · {snapshot?.active ? '当前运行' : '仅缓存／历史证据'}</p>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" onClick={exportCatalog} disabled={!snapshot} aria-label="导出工具目录" title="导出工具目录" className="rounded border border-border-soft p-1.5 hover:border-accent disabled:opacity-40"><Download size={14} /></button>
        {!provided && <button type="button" onClick={() => setRefresh(n => n + 1)} disabled={loading} aria-label="刷新会话目录" title="读取最新会话证据，不启动 MCP" className="rounded border border-border-soft p-1.5 hover:border-accent disabled:opacity-40"><RefreshCw size={14} className={loading ? 'animate-spin' : ''} /></button>}
        {onClose && <button type="button" onClick={onClose} aria-label="关闭工具目录" className="rounded border border-border-soft p-1.5 hover:border-accent"><X size={14} /></button>}
      </div>
    </header>
    <div className="border-b border-border-soft p-3 text-xs text-fg-dim">
      <p>{mode === 'project' ? '项目主动探测结果；配置启用不代表当前 Agent 已加载。' : port.describeCapabilities(scope.agentId).reason}</p>
      {snapshot?.coverage.map((row, i) => <p key={`${row.source}:${i}`} className="mt-1 break-words text-[11px] text-fg-faint"><span className="font-medium text-fg-dim">{row.source} · {{ full: '全量', names: '仅名称', observed: '仅调用记录', unknown: '未提供' }[row.level]}</span>：{row.reason}</p>)}
      {error && <p role="alert" className="mt-2 text-status-error">{error}</p>}
    </div>
    <label className="m-3 flex items-center gap-2 rounded border border-border bg-bg px-2 py-1.5"><Search size={14} className="text-fg-faint" /><input autoFocus value={query} onChange={e => setQuery(e.target.value)} aria-label="搜索工具" placeholder="搜索名称、服务器、描述" className="min-w-0 flex-1 bg-transparent text-xs outline-none" /></label>
    <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto sm:grid-cols-[minmax(160px,0.9fr)_minmax(0,1.4fr)]">
      <div className="min-h-[120px] overflow-auto border-r border-border-soft px-3 pb-3 sm:max-h-[52vh]">
        {tools.length === 0 && <p className="p-3 text-xs text-fg-faint">{query ? '没有匹配工具。' : loading ? '正在读取会话证据…' : '尚无工具证据。启动 Agent 会话后可读取；MCP 主动探测位于项目设置。'}</p>}
        {groups.map(([label, rows]) => <div key={label} className="mb-3"><h3 className="mb-1 break-all text-[11px] font-semibold text-fg-faint">{label} · {rows.length}</h3>{rows.map(tool => <button type="button" key={tool.toolId} onClick={() => setSelectedId(tool.toolId)} aria-pressed={selected?.toolId === tool.toolId} className={`mb-1 block w-full rounded border px-2 py-2 text-left ${selected?.toolId === tool.toolId ? 'border-accent/50 bg-accent/10' : 'border-transparent hover:bg-bg-alt'}`}>
          <span className="block break-all font-mono text-xs">{tool.originalName}</span><span className="mt-1 block text-[10px] text-fg-faint">{snapshot?.active ? discovery[tool.discovery] : tool.discovery === 'observed' ? discovery.observed : '仅上次发现'}</span>
        </button>)}</div>)}
      </div>
      {selected && <div className="min-w-0 overflow-auto p-3 pt-0 text-xs sm:max-h-[52vh]">
        <h3 className="break-all font-mono font-semibold">{selected.originalName}</h3>
        <p className="mt-2 whitespace-pre-wrap break-words text-fg-dim">{selected.description || '上游未提供描述。'}</p>
        <dl className="mt-3 grid grid-cols-[5rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-[11px]">
          <dt className="text-fg-faint">来源</dt><dd className="break-all">{selected.serverId ?? selected.providerId} · {selected.owner === 'agent' ? 'Agent 持有' : 'UGS 探测'}</dd>
          <dt className="text-fg-faint">选择</dt><dd>{{ yes: '配置选择', no: '配置未选择', unknown: '上游未提供' }[selected.selected]}</dd>
          <dt className="text-fg-faint">暴露</dt><dd>{exposure[selected.exposure]}</dd>
          <dt className="text-fg-faint">执行许可</dt><dd>{selected.permission === 'agent-managed' ? '由 Agent 管理' : '未知'}</dd>
          <dt className="text-fg-faint">连接</dt><dd>{snapshot?.active && selected.connection === 'connected' ? '当前连接' : '未验证当前连接'}</dd>
          <dt className="text-fg-faint">证据</dt><dd className="break-words">{selected.evidence}</dd>
          {selected.lastCall && <><dt className="text-fg-faint">最近调用</dt><dd>{new Date(selected.lastCall.atMs).toLocaleTimeString('zh-CN')} · {selected.lastCall.status === 'begin' ? '开始' : selected.lastCall.status === 'end' ? '结束' : '已观察'}</dd></>}
        </dl>
        <h4 className="mb-1 mt-4 font-medium">输入参数</h4>
        {selected.inputSchema ? <pre className="overflow-auto rounded border border-border-soft bg-bg p-2 text-[11px]">{JSON.stringify(selected.inputSchema, null, 2)}</pre> : <p className="text-fg-faint">上游未提供参数 Schema。</p>}
        {selected.outputSchema && <><h4 className="mb-1 mt-3 font-medium">输出参数</h4><pre className="overflow-auto rounded border border-border-soft bg-bg p-2 text-[11px]">{JSON.stringify(selected.outputSchema, null, 2)}</pre></>}
      </div>}
    </div>
  </section>;
}
