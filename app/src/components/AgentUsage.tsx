import { useEffect, useRef, useState } from 'react';
import { Activity } from 'lucide-react';
import type { Locale } from '@/lib/i18n';
import { localDayKey, migrateAgentUsageHistory, readActiveAgentUsage, readAgentUsageHistory, recentDayKeys, subscribeAgentUsageHistory, type ActiveAgentUsage, type AgentUsageRecord } from '@/lib/agentUsageHistory';
import './AgentUsage.css';

function applicationName(value: string): string {
  return ({ codex: 'Codex', 'claude-code': 'Claude Code', gemini: 'Gemini' } as Record<string, string>)[value] ?? (value || '—');
}

function tokenCount(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, notation: value >= 10000 ? 'compact' : 'standard' }).format(value);
}

export default function AgentUsage({ locale = 'zh-CN' }: { locale?: Locale }) {
  const zh = locale === 'zh-CN';
  const [open, setOpen] = useState(false);
  const [day, setDay] = useState('today');
  const [rows, setRows] = useState<AgentUsageRecord[]>([]);
  const [active, setActive] = useState<ActiveAgentUsage[]>([]);
  const [now, setNow] = useState(Date.now());
  const [panelMaxWidth, setPanelMaxWidth] = useState<number>();
  const wrapper = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();
  const suppressFocusOpen = useRef(false);

  useEffect(() => {
    migrateAgentUsageHistory();
    const refresh = () => { setNow(Date.now()); setRows(readAgentUsageHistory()); setActive(readActiveAgentUsage()); };
    refresh();
    const unsubscribe = subscribeAgentUsageHistory(refresh);
    const timer = setInterval(refresh, 60_000);
    return () => { unsubscribe(); clearInterval(timer); if (closeTimer.current) clearTimeout(closeTimer.current); };
  }, []);
  useEffect(() => {
    if (!open) return;
    const fitPanel = () => setPanelMaxWidth(Math.max(160, (wrapper.current?.getBoundingClientRect().right ?? window.innerWidth) - 10));
    fitPanel();
    window.addEventListener('resize', fitPanel);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      suppressFocusOpen.current = true;
      wrapper.current?.querySelector('button')?.focus();
      suppressFocusOpen.current = false;
    };
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('keydown', onKeyDown); window.removeEventListener('resize', fitPanel); };
  }, [open]);

  const show = () => { if (closeTimer.current) clearTimeout(closeTimer.current); if (!open) setDay('today'); setOpen(true); };
  const hide = () => { closeTimer.current = setTimeout(() => setOpen(false), 180); };
  const days = recentDayKeys(now);
  const selectedDay = day === 'today' ? days[0] : day;
  const completed = rows.filter((row) => localDayKey(row.recordedAt) === selectedDay);
  const running = selectedDay === days[0] ? active : [];
  const visible = [...running.map((row) => ({ ...row, running: true })), ...completed.map((row) => ({ ...row, running: false, hasUsage: true }))];
  const formatTime = (time: number) => new Date(time).toLocaleTimeString(zh ? 'zh-CN' : 'en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return <div className="ugs-agent-usage" data-tauri-drag-region="false" ref={wrapper} onMouseEnter={show} onMouseLeave={hide}
    onFocus={() => { if (!suppressFocusOpen.current) show(); }} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) hide(); }}>
    <button type="button" className="ugs-agent-usage-trigger" aria-label={zh ? 'Agent 使用情况' : 'Agent usage'}
      aria-expanded={open} aria-controls="ugs-agent-usage-panel" onClick={show}>
      <Activity size={15} aria-hidden="true" />
    </button>
    {open && <section id="ugs-agent-usage-panel" className="ugs-agent-usage-panel" style={{ maxWidth: panelMaxWidth }} aria-label={zh ? 'Agent 使用情况' : 'Agent usage'}>
      <div className="ugs-agent-usage-heading">
        <div className="ugs-agent-usage-icon"><Activity size={18} /></div>
        <div className="ugs-agent-usage-heading-copy"><strong>{zh ? 'Agent 使用情况' : 'Agent usage'}</strong><span>{zh ? '调用记录保留最近 7 天' : 'Calls are retained for 7 days'}</span></div>
        <label className="ugs-agent-usage-day"><span className="ugs-agent-usage-sr">{zh ? '选择日期' : 'Select date'}</span><select aria-label={zh ? '选择日期' : 'Select date'} value={day} onChange={(event) => setDay(event.target.value)}>
          <option value="today">{zh ? '今天' : 'Today'} · {days[0].slice(5)}</option>
          {days.slice(1).map((date) => <option value={date} key={date}>{date}</option>)}
        </select></label>
      </div>
      <div className="ugs-agent-usage-meta"><span>{zh ? `全部会话 · ${completed.length} 次调用${running.length ? ` · ${running.length} 进行中` : ''}` : `All sessions · ${completed.length} calls${running.length ? ` · ${running.length} running` : ''}`}</span><span>{zh ? '≈ 为估算；成本以渠道上报为准' : '≈ estimated; cost is provider-reported'}</span></div>
      <div className="ugs-agent-usage-list">
        {visible.length ? <table><thead><tr><th>{zh ? '时间' : 'Time'}</th><th>{zh ? '应用' : 'Agent'}</th><th>{zh ? '供应商' : 'Provider'}</th><th>{zh ? '模型' : 'Model'}</th><th>{zh ? '成本' : 'Cost'}</th><th>{zh ? '新增输入' : 'New input'}</th><th>{zh ? '输出' : 'Output'}</th><th>{zh ? '缓存命中' : 'Cached'}</th><th title={zh ? '输出 Token 除以调用总时长，包含工具执行和等待' : 'Output tokens divided by total call time, including tools and waiting'}>{zh ? '速度' : 'Speed'}</th><th title={zh ? '首次文本或 Agent 进度的等待时间' : 'Time to first text or agent progress'}>{zh ? '首响' : 'First'}</th></tr></thead>
          <tbody>{visible.map((row) => {
            const prefix = row.estimated ? '≈' : '';
            const elapsed = row.running ? now - row.recordedAt : row.elapsedMs;
            const speed = elapsed && row.outputTokens ? row.outputTokens * 1000 / elapsed : null;
            return <tr key={row.id} data-status={row.running ? 'running' : 'completed'}><td>{formatTime(row.recordedAt)}{row.running && <span className="ugs-agent-usage-running">{zh ? '进行中' : 'Running'}</span>}</td><td>{applicationName(row.application)}</td><td title={row.provider}>{row.provider || '—'}</td><td title={row.model}>{row.model || '—'}</td><td>{row.costUsd === undefined ? '—' : `$${row.costUsd.toFixed(4)}`}</td><td>{row.hasUsage ? `${prefix}${tokenCount(Math.max(0, row.inputTokens - row.cachedInputTokens))}` : '—'}</td><td>{row.hasUsage ? `${prefix}${tokenCount(row.outputTokens)}` : '—'}</td><td>{!row.hasUsage || row.estimated ? '—' : tokenCount(row.cachedInputTokens)}</td><td>{speed === null ? '—' : `≈${speed.toFixed(1)} tok/s`}</td><td>{row.firstResponseMs === undefined ? '—' : `≈${(row.firstResponseMs / 1000).toFixed(1)}s`}</td></tr>;
          })}</tbody></table> : <div className="ugs-agent-usage-empty">{zh ? '这一天暂无调用记录' : 'No calls recorded on this day'}</div>}
      </div>
      <div className="ugs-agent-usage-footer">{zh ? '历史记录按本地日期清理；旧记录仅可恢复各会话最后一次调用' : 'Records expire by local date; only the last call of each older session can be recovered'}</div>
    </section>}
  </div>;
}
