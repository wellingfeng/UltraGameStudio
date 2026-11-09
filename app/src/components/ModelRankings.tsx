import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowUpRight, BarChart3, RefreshCw, Search } from 'lucide-react';
import { openExternal } from '@/lib/tauri';
import type { Locale } from '@/lib/i18n';
import { INTELLIGENCE_SOURCE, modelRankings } from '@/lib/modelRankings';
import './ModelRankings.css';

function price(value: number): string {
  return value === 0 ? '$0' : `$${new Intl.NumberFormat('en-US', { maximumFractionDigits: 9 }).format(value)}`;
}

export default function ModelRankings({ locale = 'zh-CN' }: { locale?: Locale }) {
  const zh = locale === 'zh-CN';
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();
  const wrapper = useRef<HTMLDivElement>(null);
  const suppressFocusOpen = useRef(false);
  const state = useSyncExternalStore(modelRankings.subscribe, modelRankings.getState);
  const current = state.intelligence;
  const refreshing = current.loading;

  useEffect(() => {
    modelRankings.start();
    return () => { modelRankings.stop(); if (closeTimer.current) clearTimeout(closeTimer.current); };
  }, []);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        suppressFocusOpen.current = true;
        wrapper.current?.querySelector('button')?.focus();
        suppressFocusOpen.current = false;
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const show = () => { if (closeTimer.current) clearTimeout(closeTimer.current); setOpen(true); };
  const hide = () => { closeTimer.current = setTimeout(() => setOpen(false), 180); };
  const filter = query.trim().toLocaleLowerCase();
  const intelligence = state.intelligence.entries.filter((entry) => `${entry.name} ${entry.creator}`.toLocaleLowerCase().includes(filter));
  const maxScore = state.intelligence.entries[0]?.score || 1;
  const lastUpdated = current.fetchedAt ? new Date(current.fetchedAt).toLocaleString(zh ? 'zh-CN' : 'en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : null;

  return (
    <div className="ugs-model-rankings" data-tauri-drag-region="false" ref={wrapper} onMouseEnter={show} onMouseLeave={hide} onFocus={() => { if (!suppressFocusOpen.current) show(); }}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) hide(); }}>
      <button type="button" className="ugs-model-rankings-trigger" aria-label={zh ? '模型榜单' : 'Model rankings'}
        aria-expanded={open} aria-controls="ugs-model-rankings-panel" onClick={show}>
        <BarChart3 size={15} aria-hidden="true" />
      </button>
      {open && <section id="ugs-model-rankings-panel" className="ugs-model-rankings-panel" aria-label={zh ? '模型榜单' : 'Model rankings'}>
        <div className="ugs-model-rankings-heading">
          <div className="ugs-model-rankings-icon"><BarChart3 size={18} /></div>
          <div className="ugs-model-rankings-heading-copy"><strong>{zh ? '模型榜单' : 'Model rankings'}</strong><span>{zh ? '看能力，也看价格' : 'Compare capability and price'}</span></div>
          <button type="button" className="ugs-model-rankings-refresh" aria-disabled={refreshing}
            onClick={() => { if (!refreshing) void modelRankings.refresh(); }} title={zh ? '立即刷新' : 'Refresh now'} aria-label={zh ? '立即刷新模型榜单' : 'Refresh model rankings'}>
            <RefreshCw size={15} className={refreshing ? 'ugs-model-rankings-spinning' : ''} />
          </button>
        </div>
        <div className="ugs-model-rankings-toolbar">
          <label className="ugs-model-rankings-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={zh ? '搜索模型或厂商' : 'Search models or providers'} aria-label={zh ? '搜索模型或厂商' : 'Search models or providers'} /></label>
        </div>
        <div className="ugs-model-rankings-meta">
          <span>{zh ? '独立评测 · 参考价：美元 / 百万 Token' : 'Independent evaluation · reference USD / 1M tokens'}</span>
          <button type="button" onClick={() => void openExternal(INTELLIGENCE_SOURCE)}>Artificial Analysis<ArrowUpRight size={12} /></button>
        </div>
        {current.error && <div className="ugs-model-rankings-error" role="status">{current.entries.length ? (zh ? '更新失败，显示上次缓存' : 'Update failed; showing cached data') : (zh ? '获取失败，请检查网络后刷新' : 'Could not load; check your connection and refresh')}</div>}
        <div className="ugs-model-rankings-list">
          {current.entries.length > 0 && <div className="ugs-model-rankings-column-header"><span>{zh ? '模型' : 'Model'}</span><span>{zh ? '智力' : 'Score'}</span><span>{zh ? '价格' : 'Price'}</span></div>}
          {intelligence.map((entry) => {
            const rank = state.intelligence.entries.indexOf(entry) + 1;
            const input = entry.pricing?.inputUsd == null ? '—' : price(entry.pricing.inputUsd);
            const output = entry.pricing?.outputUsd == null ? '—' : price(entry.pricing.outputUsd);
            const pricingLabel = zh ? `输入 ${input}，输出 ${output}，美元 / 百万 Token` : `Input ${input}, output ${output}, USD / 1M tokens`;
            return <div className="ugs-model-rankings-row" key={`${entry.name}:${entry.creator}`}>
              <span className={`ugs-model-rankings-rank ${rank <= 3 ? 'is-top' : ''}`}>{String(rank).padStart(2, '0')}</span>
              <div className="ugs-model-rankings-model"><strong title={entry.name}>{entry.name}</strong><span>{entry.creator}</span><div className="ugs-model-rankings-bar"><i style={{ width: `${Math.max(0, Math.min(100, entry.score / maxScore * 100))}%` }} /></div></div>
              <span className="ugs-model-rankings-score">{entry.score}</span>
              <div className="ugs-model-rankings-price" aria-label={pricingLabel} title={pricingLabel}>
                <span><small>{zh ? '输入' : 'In'}</small> {input}</span><span><small>{zh ? '输出' : 'Out'}</small> {output}</span>
              </div>
            </div>;
          })}
          {!current.entries.length && current.loading && <div className="ugs-model-rankings-empty">{zh ? '正在获取最新数据…' : 'Loading latest data…'}</div>}
          {current.entries.length > 0 && intelligence.length === 0 && <div className="ugs-model-rankings-empty">{zh ? '没有找到匹配的模型' : 'No matching models'}</div>}
        </div>
        <div className="ugs-model-rankings-footer"><span><i className={current.error ? 'is-error' : ''} />{current.loading ? (zh ? '更新中' : 'Updating') : lastUpdated ? `${zh ? '更新于' : 'Updated'} ${lastUpdated}` : (zh ? '尚无数据' : 'No data yet')}</span><span>{zh ? '每 2 小时更新' : 'Updates every 2 hours'}</span></div>
      </section>}
    </div>
  );
}
