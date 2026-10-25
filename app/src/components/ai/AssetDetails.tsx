import { useEffect, useState } from 'react';
import { X, Star, ExternalLink } from 'lucide-react';
import type { AssetEntry } from '@/lib/downloadRegistry';
import { updateAssetDetails } from '@/lib/downloadRegistry';
import { ASSET_SOURCE_LABELS } from '@/lib/assetHubModel';
import { regenerateAsset } from '@/lib/assetReuse';
import { saveAssetCopy } from '@/lib/assetCopy';
import { fileExists, openExternal, openLocalPath, readLocalFileForUpload, tauriAvailable } from '@/lib/tauri';
import { useStore } from '@/store/useStore';
import { parseFileRef } from './lib/filePath';
import FilePreviewDrawer from './FilePreviewDrawer';
import CopyButton from './CopyButton';
import { assetThumbnail } from '@/lib/assetPreviewCache';

export default function AssetDetails({ entry, onClose, onJump, onReuse, inline = false }: {
  inline?: boolean;
  entry: AssetEntry; onClose: () => void; onJump: (entry: AssetEntry) => void; onReuse: () => void;
}) {
  const appendDraft = useStore(s => s.appendComposerDraft);
  const generation = useStore(s => ({
    generateImagePrompt: s.generateImagePrompt, generateSpritePrompt: s.generateSpritePrompt,
    generateVideoPrompt: s.generateVideoPrompt, generateMusicPrompt: s.generateMusicPrompt,
    generateSpeechPrompt: s.generateSpeechPrompt, generateThreeDPrompt: s.generateThreeDPrompt,
  }));
  const [tags, setTags] = useState((entry.tags ?? []).join('，'));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const [available, setAvailable] = useState(entry.availability ?? 'unknown');
  const [thumbnail, setThumbnail] = useState(entry.previewUrl);
  useEffect(() => {
    setThumbnail(entry.previewUrl);
    if (entry.previewUrl || !entry.localPath || !['image', 'sprite'].includes(entry.kind) || !tauriAvailable()) return;
    let cancelled = false;
    void assetThumbnail(entry.localPath, entry.finishedAt).then(src => { if (!cancelled) setThumbnail(src ?? undefined); }).catch(() => {});
    return () => { cancelled = true; };
  }, [entry.previewUrl, entry.localPath, entry.kind, entry.finishedAt]);
  useEffect(() => {
    if (!entry.localPath || !tauriAvailable()) return;
    let cancelled = false;
    void fileExists(entry.localPath).then(exists => {
      if (cancelled) return;
      const next = exists ? 'available' : 'missing';
      setAvailable(next);
      if (entry.availability !== next) updateAssetDetails(entry.id, { availability: next });
    }).catch(e => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [entry.id, entry.localPath, entry.availability]);
  const verify = async () => {
    if (!entry.localPath) return;
    if (!tauriAvailable()) throw new Error('本地文件操作需要桌面端');
    if (!await fileExists(entry.localPath)) {
      setAvailable('missing');
      updateAssetDetails(entry.id, { availability: 'missing' });
      throw new Error('文件已缺失，请恢复原文件后重试');
    }
    setAvailable('available');
    if (entry.availability !== 'available') updateAssetDetails(entry.id, { availability: 'available' });
  };
  const run = async (action: () => Promise<void>) => {
    setError(''); setBusy(true);
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const saveCopy = async () => {
    await verify();
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeFile } = await import('@tauri-apps/plugin-fs');
    await saveAssetCopy(entry.localPath!, {
      choose: source => save({ title: '另存产物', defaultPath: source }),
      read: readLocalFileForUpload,
      write: writeFile,
    });
  };
  const buttonClass = 'rounded-md border border-border bg-panel-2 px-3 py-2 text-xs text-fg hover:border-accent disabled:opacity-40';
  const ref = entry.localPath ? parseFileRef(entry.localPath, { allowSpaces: true }) : null;
  return <div className={inline ? "artifact-detail-container" : "fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6"} onClick={inline ? undefined : onClose}>
    <section role={inline ? "region" : "dialog"} aria-modal={inline ? undefined : true} aria-label="产物详情" className={inline ? "artifact-detail-pane" : "max-h-[90vh] w-full max-w-2xl overflow-auto rounded-xl border border-border bg-panel p-5 text-fg shadow-2xl"} onClick={event => event.stopPropagation()}>
      <div className="flex items-center gap-3"><h3 className="min-w-0 flex-1 break-words text-base font-semibold">{entry.title}</h3>
        <button aria-label={entry.favorite ? '取消收藏' : '收藏产物'} onClick={() => updateAssetDetails(entry.id, { favorite: !entry.favorite })} className={buttonClass}><Star size={16} fill={entry.favorite ? 'currentColor' : 'none'} /></button>
        <button aria-label="关闭详情" className={buttonClass} onClick={onClose}><X size={16} /></button></div>
      {thumbnail && ['image', 'sprite'].includes(entry.kind) && <img src={thumbnail} alt={entry.title} className="artifact-detail-image" />}
      <dl className="mt-4 grid grid-cols-[5rem_1fr] gap-2 break-words text-xs leading-6">
        <dt className="text-fg-faint">来源</dt><dd>{entry.meta?.artifactType === 'link' ? '链接引用' : ASSET_SOURCE_LABELS[entry.source]} · {entry.provenance === 'inferred' ? '时间推断，尚未核实' : entry.provenance === 'answer' ? '回答引用' : '产出记录'}</dd>
        <dt className="text-fg-faint">文件路径</dt><dd className="break-all">{entry.localPath ?? entry.remoteUrl ?? '无本地文件'}</dd>
        <dt className="text-fg-faint">文件状态</dt><dd>{!entry.localPath ? '远程链接' : available === 'missing' ? '文件缺失，请恢复原文件' : available === 'available' ? '文件存在' : '尚未检查'}</dd>
        <dt className="text-fg-faint">来源会话</dt><dd>{entry.sessionTitle ?? entry.sessionId ?? '来源未知'}</dd>
        <dt className="text-fg-faint">项目</dt><dd>{entry.workspaceId ?? '归属未知'}</dd>
        <dt className="text-fg-faint">时间</dt><dd>{new Date(entry.finishedAt ?? entry.startedAt).toLocaleString('zh-CN')}</dd>
        {entry.provider && <><dt className="text-fg-faint">渠道 / 模型</dt><dd>{entry.provider} / {entry.model ?? '未记录'}</dd></>}
        {entry.prompt && <><dt className="text-fg-faint">提示词</dt><dd className="whitespace-pre-wrap">{entry.prompt}</dd></>}
      </dl>
      <label className="mt-4 block text-xs text-fg-dim">标签（逗号分隔）<input aria-label="产物标签" value={tags} onChange={e => setTags(e.target.value)} onBlur={() => updateAssetDetails(entry.id, { tags: tags.split(/[,，]/) })} className="mt-2 w-full rounded border border-border bg-panel-2 p-2 text-fg" /></label>
      <div className="mt-4 flex flex-wrap gap-2">
        {entry.remoteUrl && <button className={buttonClass} disabled={busy} onClick={() => void run(async () => { await openExternal(entry.remoteUrl!); })}><span className="inline-flex items-center gap-1"><ExternalLink size={12} />打开链接</span></button>}
        {ref && <button className={buttonClass} disabled={busy} data-file-preview-trigger="true" onClick={() => void run(async () => { await verify(); setPreview(true); })}>预览文件</button>}
        {entry.localPath && <><button className={buttonClass} disabled={busy} onClick={() => void run(async () => { await verify(); if (!await openLocalPath(entry.localPath!, { reveal: true })) throw new Error('无法在文件夹中定位该文件'); })}>定位文件</button>
          {available === 'missing' && <button className={buttonClass} disabled={busy} onClick={() => void run(verify)}>重新检查</button>}
          <button className={buttonClass} disabled={busy} onClick={() => void run(saveCopy)}>另存到…</button></>}
        <CopyButton value={entry.localPath ?? entry.remoteUrl ?? ''} label="复制路径" className={buttonClass} />
        <button className={buttonClass} disabled={busy || !entry.localPath} onClick={() => void run(async () => { await verify(); appendDraft(`\n${entry.localPath}\n`); onReuse(); })}>添加到当前会话</button>
        {entry.prompt && <button className={buttonClass} disabled={busy} onClick={() => void run(async () => { await regenerateAsset(entry, generation); onReuse(); })}>{busy ? '处理中…' : '再次生成'}</button>}
        {entry.prompt && <CopyButton value={entry.prompt} label="复制提示词" className={buttonClass} />}
        {entry.sessionId && <button className={buttonClass} onClick={() => onJump(entry)}>查看来源会话</button>}
      </div>
      {error && <p role="alert" className="mt-3 text-xs text-status-error">{error}</p>}
      <h4 className="mt-5 text-xs font-semibold text-fg-dim">产出与修改记录 · {entry.events?.length ?? 0}</h4>
      <p className="mt-1 text-[11px] text-fg-faint">记录操作和来源；文件覆盖后不保留旧内容。</p>
      <ul className="mt-2 space-y-2 text-xs">{entry.events?.map(event => <li key={event.id} className="rounded border border-border-soft p-2">{event.operation === 'referenced' ? '引用' : ASSET_SOURCE_LABELS[event.operation]} · {new Date(event.at).toLocaleString('zh-CN')} · {event.sessionId ?? '来源未知'}
        {event.sessionId && <button className="ml-2 text-accent" onClick={() => onJump({ ...entry, sessionId: event.sessionId, workspaceId: event.workspaceId, messageId: event.messageId, provenance: event.provenance })}>查看消息</button>}</li>)}</ul>
    </section>
    {preview && ref && <FilePreviewDrawer refData={ref} onClose={() => setPreview(false)} />}
  </div>;
}
