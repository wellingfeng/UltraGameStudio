import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowLeft, Check, ExternalLink, Loader2, MessageCircle, Power, QrCode, RefreshCw, Save, Send, ShieldCheck, Search } from 'lucide-react';
import {
  MESSAGE_PLATFORMS, connectMessagePlatform, getMessagePlatformSnapshot, loadMessagePlatforms,
  requestMessagePlatform, saveMessagePlatform, stopMessagePlatform, subscribeMessagePlatforms,
  type MessagePlatformConfig, type MessagePlatformId,
} from '@/lib/messagePlatforms';
import { useStore } from '@/store/useStore';
import { tauriAvailable } from '@/lib/tauri';
import './MessagePlatformsPanel.css';

const inputClass = 'w-full rounded-md border border-border bg-bg px-3 py-2.5 text-sm text-fg outline-none focus:border-accent placeholder:text-fg-faint';
const buttonClass = 'inline-flex items-center justify-center gap-2 rounded-md border border-border bg-panel-2 px-3 py-2 text-xs text-fg-dim hover:border-accent hover:text-fg disabled:cursor-not-allowed disabled:opacity-50';
const statusLabel = { stopped: '已停止', connecting: '连接中', connected: '已连接', error: '连接失败' };

export default function MessagePlatformsPanel({ onClose }: { onClose: () => void }) {
  const snapshot = useSyncExternalStore(subscribeMessagePlatforms, getMessagePlatformSnapshot);
  const workspaces = useStore((s) => s.workspaces);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const [selected, setSelected] = useState<MessagePlatformId>('feishu');
  const [query, setQuery] = useState('');
  const initial = snapshot.configs.find((c) => c.id === 'feishu')!;
  const [draft, setDraft] = useState<MessagePlatformConfig>({ ...initial, workspaceId: initial.workspaceId || activeWorkspaceId || '' });
  const [secret, setSecret] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [users, setUsers] = useState(initial.allowedUsers.join('\n'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [qr, setQr] = useState<{ qrcode: string; image: string; url: string } | null>(null);
  const [qrStatus, setQrStatus] = useState('');
  const panel = useRef<HTMLElement>(null);
  const platform = MESSAGE_PLATFORMS.find((p) => p.id === selected)!;
  const status = snapshot.statuses[selected];
  const notificationOnly = selected === 'wecom' || selected === 'dingtalk';

  useEffect(() => {
    if (tauriAvailable()) void loadMessagePlatforms().catch((err) => setError(String(err)));
    panel.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !busy) onClose();
    };
    const element = panel.current;
    element?.addEventListener('keydown', onKey);
    return () => { element?.removeEventListener('keydown', onKey); };
  }, [onClose, busy]);
  useEffect(() => {
    const config = snapshot.configs.find((c) => c.id === selected)!;
    setDraft({ ...config, workspaceId: config.workspaceId || activeWorkspaceId || '' });
    setUsers(config.allowedUsers.join('\n')); setSecret(''); setSigningSecret('');
  }, [selected, snapshot.configs, activeWorkspaceId]);
  useEffect(() => {
    if (!qr || selected !== 'wechat') return;
    let disposed = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await requestMessagePlatform<{ status: string; config?: MessagePlatformConfig }>('wechat', 'checkQr', { qrcode: qr.qrcode });
        if (disposed) return;
        if (result.status === 'confirmed' && result.config) {
          await loadMessagePlatformsAfterQr(result.config);
          setQr(null); setNotice('微信扫码成功。已将扫码用户加入允许名单，保存并连接后即可对话。'); return;
        }
        if (result.status === 'expired') { setQrStatus('二维码已过期，请刷新。'); return; }
        setQrStatus(result.status === 'scaned' ? '已扫码，请在手机上确认。' : '等待微信扫码');
        timer = setTimeout(poll, 2000);
      } catch (err) { if (!disposed) { setError(String(err)); setQrStatus('扫码状态查询失败，请刷新重试。'); } }
    };
    timer = setTimeout(poll, 1000);
    return () => { disposed = true; clearTimeout(timer); };
  }, [qr, selected]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (err) { setError(String(err).replace(/^Error: /, '')); } finally { setBusy(false); }
  };
  const persist = async (enabled = draft.enabled) => {
    const credential = selected === 'dingtalk' && secret.trim() && signingSecret.trim()
      ? JSON.stringify({ webhook: secret.trim(), signingSecret: signingSecret.trim() }) : secret;
    const saved = await saveMessagePlatform({ ...draft, enabled, allowedUsers: users.split(/[\n,，]/).map((s) => s.trim()).filter(Boolean) }, credential);
    setDraft(saved); setSecret(''); setSigningSecret(''); return saved;
  };
  const select = (id: MessagePlatformId) => { setSelected(id); setError(''); setNotice(''); setQr(null); };

  return <section ref={panel} tabIndex={-1} aria-labelledby="message-platforms-title" data-ugs-message-platforms className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-bg outline-none">
      <header className="flex shrink-0 items-center gap-2.5 border-b border-border-soft px-5 py-3">
        <MessageCircle size={16} className="text-fg-dim" /><h2 id="message-platforms-title" className="text-sm font-medium text-fg">消息平台</h2>
        <span className="hidden text-xs text-fg-faint sm:block">在常用通信软件中使用 UGS</span><div className="flex-1" />
        <button type="button" onClick={onClose} disabled={busy} className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs text-fg-faint hover:bg-panel-2 hover:text-fg disabled:opacity-50" aria-label="返回对话"><ArrowLeft size={14} />返回对话</button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <nav aria-label="通信平台" className="flex shrink-0 flex-col border-b border-border-soft bg-panel/20 p-2 sm:w-52 sm:border-b-0 sm:border-r">
          <label className="relative mb-3 block"><Search size={13} className="pointer-events-none absolute left-2 top-2.5 text-fg-faint" /><input type="search" aria-label="搜索消息平台" placeholder="搜索平台…" value={query} onChange={(e) => setQuery(e.target.value)} className="h-8 w-full rounded border border-transparent bg-transparent pl-7 pr-2 text-xs text-fg outline-none placeholder:text-fg-faint focus:border-border" /></label>
          <div className="flex overflow-x-auto sm:flex-col">
          {MESSAGE_PLATFORMS.filter((p) => `${p.name} ${p.id} ${p.mode}`.toLowerCase().includes(query.trim().toLowerCase())).map((p) => <button key={p.id} type="button" disabled={busy} onClick={() => select(p.id)} aria-pressed={selected === p.id} className={`mb-1 flex min-w-[128px] items-center gap-2.5 rounded border px-2.5 py-2 text-left text-xs ${selected === p.id ? 'border-border bg-panel-2/70 text-fg' : 'border-transparent text-fg-dim hover:bg-panel-2/40'}`}>
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] font-semibold text-white" style={{ background: p.color }}>{p.short}</span>
            <span className="min-w-0 flex-1 truncate">{p.name}</span>
            <span aria-label={statusLabel[snapshot.statuses[p.id]?.state ?? 'stopped']} className={`h-1.5 w-1.5 rounded-full ${snapshot.statuses[p.id]?.state === 'connected' ? 'bg-status-success' : snapshot.statuses[p.id]?.state === 'error' ? 'bg-status-error' : snapshot.statuses[p.id]?.state === 'connecting' ? 'animate-pulse bg-accent' : 'bg-fg-faint/40'}`} />
          </button>)}
          </div>
          {!MESSAGE_PLATFORMS.some((p) => `${p.name} ${p.id} ${p.mode}`.toLowerCase().includes(query.trim().toLowerCase())) && <p className="px-2 py-3 text-xs text-fg-faint">未找到平台</p>}
          <div className="mt-auto hidden border-t border-border-soft px-2 pt-4 text-[11px] leading-5 text-fg-faint sm:block">连接在桌面端运行。<br />退出 UGS 后停止收发消息。</div>
        </nav>
        <div className="message-platforms-content min-h-0 min-w-0 flex-1 overflow-y-auto">
          <div className="message-platforms-detail w-full pb-8">
          <div className="flex flex-wrap items-center gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-lg text-sm font-semibold text-white" style={{ background: platform.color }}>{platform.short}</span><h3 className="text-lg font-semibold text-fg">{platform.name}</h3>
            <span className={`rounded-full border px-2 py-0.5 text-[11px] ${status?.state === 'connected' ? 'border-status-success/30 text-status-success' : status?.state === 'error' ? 'border-status-error/30 text-status-error' : 'border-border text-fg-faint'}`}>{statusLabel[status?.state ?? 'stopped']}</span>
            <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-fg-faint">{platform.mode}</span>
          </div>
          <p className="mt-3 text-xs leading-6 text-fg-dim">{platform.description}</p>
          {status?.detail && <p className="mt-1 text-xs text-fg-faint">{status.detail}</p>}
          {!tauriAvailable() && <p className="mt-4 rounded-lg border border-border bg-panel-2 p-3 text-xs text-fg-dim">当前为浏览器预览。请在 UGS 桌面版中配置和连接消息平台。</p>}
          {error && <p role="alert" className="mt-4 rounded-lg border border-status-error/30 bg-status-error/5 p-3 text-xs text-status-error">{error}</p>}
          {notice && <p role="status" className="mt-4 flex gap-2 rounded-lg border border-status-success/30 bg-status-success/5 p-3 text-xs text-status-success"><Check size={14} />{notice}</p>}

          <section className="mt-6 rounded-lg border border-border bg-bg/30 p-4">
            <h4 className="flex items-center gap-2 text-sm font-medium text-fg">{selected === 'wechat' ? <QrCode size={15} className="text-accent" /> : <ShieldCheck size={15} className="text-accent" />}{selected === 'wechat' ? '扫码连接' : '快速设置'}</h4>
            <p className="mt-2 text-xs leading-6 text-fg-dim">{selected === 'feishu' ? '创建企业自建应用，启用机器人；订阅「接收消息 im.message.receive_v1」，选择长连接接收事件并发布应用。开启单聊消息读取、群聊 @ 消息读取、以应用身份发送消息权限。' : selected === 'wechat' ? '使用手机微信扫描二维码并确认登录，无需填写 API Key。接入的是 iLink 机器人私信；普通个人微信聊天和群聊不在当前范围内。' : '在目标群中添加自定义机器人，复制 Webhook 地址。保存后发送测试通知，确认机器人权限及安全设置。'} </p>
            <a href={platform.guide} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs text-accent hover:underline">打开设置指南<ExternalLink size={11} /></a>
            {selected === 'wechat' && <div className="mt-3">
              <button type="button" disabled={busy || !tauriAvailable()} onClick={() => void run(async () => { setQr(null); const result = await requestMessagePlatform<{ qrcode: string; image: string; url: string }>('wechat', 'qr'); setQr(result); setQrStatus('等待微信扫码'); })} className={buttonClass}><RefreshCw size={13} />{qr ? '刷新二维码' : '获取登录二维码'}</button>
              {qr && <div className="mt-4 flex flex-wrap items-center gap-5"><img src={qr.image} alt="微信登录二维码" width={180} height={180} className="rounded-lg bg-white" /><p className="text-xs text-fg-dim">{qrStatus}</p></div>}
              {draft.accountId && <p className="mt-3 break-all text-xs text-fg-dim">已登录账号：{draft.accountId}</p>}
            </div>}
          </section>

          <fieldset disabled={busy} className="message-platforms-fields mt-6">
            {selected === 'feishu' && <label className="block text-xs text-fg-dim">应用 ID<span className="mb-2 mt-1 block text-[11px] text-fg-faint">飞书开放平台的 App ID</span><input className={inputClass} placeholder="cli_…" value={draft.appId} onChange={(e) => setDraft({ ...draft, appId: e.target.value })} /></label>}
            {selected !== 'wechat' && <label className="block text-xs text-fg-dim">{selected === 'feishu' ? '应用密钥' : '机器人 Webhook'}<span className="mb-2 mt-1 block text-[11px] text-fg-faint">{draft.hasSecret ? '已有凭据。留空保留；输入新值替换。' : '凭据保存到操作系统安全存储。'}</span><input type="password" autoComplete="new-password" className={inputClass} placeholder={selected === 'feishu' ? '输入 App Secret' : '输入群机器人 HTTPS Webhook 地址'} value={secret} onChange={(e) => setSecret(e.target.value)} /></label>}
            {selected === 'dingtalk' && <label className="block text-xs text-fg-dim">加签密钥（可选）<input type="password" autoComplete="new-password" className={`${inputClass} mt-2`} placeholder="机器人使用加签时，与 Webhook 一起填写 SEC…" value={signingSecret} onChange={(e) => setSigningSecret(e.target.value)} /></label>}
            {notificationOnly && <>
              <label className="block text-xs text-fg-dim">通知使用的项目<select className={`${inputClass} mt-2`} value={draft.workspaceId} onChange={(e) => setDraft({ ...draft, workspaceId: e.target.value })}><option value="">选择项目</option>{workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
              <label className="flex items-start gap-2 text-xs text-fg-dim"><input type="checkbox" className="mt-0.5 accent-accent" checked={draft.notifyOnCompletion} onChange={(e) => setDraft({ ...draft, notifyOnCompletion: e.target.checked })} /><span>会话完成后发送结果到群<span className="mt-1 block text-[11px] leading-5 text-fg-faint">只发送所选项目的新回复，包含定时任务结果。开启后，回复内容会对群成员可见。</span></span></label>
            </>}
            {!notificationOnly && <>
              <label className="block text-xs text-fg-dim">消息使用的项目<span className="mb-2 mt-1 block text-[11px] text-fg-faint">每位发送者拥有独立会话，使用 UGS 当前模型和所选项目的工作目录。</span><select className={inputClass} value={draft.workspaceId} onChange={(e) => setDraft({ ...draft, workspaceId: e.target.value })}><option value="">选择项目</option>{workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
              <label className="block text-xs text-fg-dim">允许的用户 ID<span className="mb-2 mt-1 block text-[11px] text-fg-faint">每行一个。飞书填写 open_id；微信扫码用户自动加入。</span><textarea rows={3} className={inputClass} placeholder={selected === 'feishu' ? 'ou_…' : '微信 iLink 用户 ID'} value={users} onChange={(e) => setUsers(e.target.value)} /></label>
              <label className="flex items-start gap-2 text-xs text-fg-dim"><input type="checkbox" className="mt-0.5 accent-accent" checked={draft.allowAllUsers} onChange={(e) => setDraft({ ...draft, allowAllUsers: e.target.checked })} /><span>允许所有用户<span className="mt-1 block text-[11px] leading-5 text-fg-faint">开启后，任何能联系机器人的用户都可以调用所选项目的模型和工具。</span></span></label>
              {selected === 'feishu' && <label className="flex items-center gap-2 text-xs text-fg-dim"><input type="checkbox" className="accent-accent" checked={draft.groupMentionOnly} onChange={(e) => setDraft({ ...draft, groupMentionOnly: e.target.checked })} />群聊仅响应 @ 机器人</label>}
            </>}
          </fieldset>
          <div className="mt-7 flex flex-wrap gap-2 border-t border-border-soft pt-5">
            <button type="button" disabled={busy || !tauriAvailable()} className={buttonClass} onClick={() => void run(async () => { await persist(); if (draft.enabled) await connectMessagePlatform(selected); setNotice('配置已保存。'); })}><Save size={13} />保存配置</button>
            <button type="button" disabled={busy || !tauriAvailable()} className={`${buttonClass} border-accent/40 bg-accent/10 text-accent`} onClick={() => void run(async () => { await persist(true); await connectMessagePlatform(selected); setNotice(notificationOnly ? '地址已校验，请发送测试通知。' : '连接已启动，状态会持续更新。'); })}>{busy ? <Loader2 size={13} className="animate-spin" /> : <Power size={13} />}保存并连接</button>
            <button type="button" disabled={busy || !tauriAvailable() || !draft.enabled} className={buttonClass} onClick={() => void run(async () => { await persist(false); await stopMessagePlatform(selected); setNotice('连接已停止。'); })}><Power size={13} />停止连接</button>
            {notificationOnly && <button type="button" disabled={busy || status?.state !== 'connected'} className={buttonClass} onClick={() => void run(async () => { await requestMessagePlatform(selected, 'send', { text: 'UGS 测试通知：消息平台连接成功。' }); setNotice('测试通知已送达。'); })}><Send size={13} />发送测试通知</button>}
          </div>
          {!notificationOnly && <p className="mt-4 text-[11px] leading-6 text-fg-faint">连接后，向机器人发送文字。UGS 自动创建独立会话，处理完成后回复原聊天。当前支持文字收发；图片、语音、文件暂不处理。</p>}
          </div>
        </div>
      </div>
  </section>;
}
async function loadMessagePlatformsAfterQr(config: MessagePlatformConfig) { await saveMessagePlatform(config); }
