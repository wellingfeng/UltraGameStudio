import { useEffect, useRef, type ReactNode } from 'react';
import { FileText, X } from 'lucide-react';
import { displayFileRefPath } from './lib/filePath';
import { useFilePreviewTabs } from '@/store/filePreviewTabs';
import FilePreviewDrawer from './FilePreviewDrawer';
import './FilePreviewTabs.css';

export function FilePreviewTabs({ scope, children }: { scope: string; children: ReactNode }) {
  const tabs = useFilePreviewTabs((state) => state.tabs);
  const activeId = useFilePreviewTabs((state) => state.activeByScope[scope]);
  const select = useFilePreviewTabs((state) => state.select);
  const close = useFilePreviewTabs((state) => state.close);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeId]);
  return <div ref={listRef} className="ugs-preview-tabs" role="tablist" aria-label="会话与文件预览"
    data-file-preview-ignore-outside-pointer="true"
    onDoubleClick={(event) => event.stopPropagation()}
    onKeyDown={(event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
      const current = items.findIndex((item) => item.contains(document.activeElement));
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : (current + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
      event.preventDefault();
      items[index]?.focus();
      items[index]?.click();
    }}>
    <div className="ugs-preview-chat-tab" role="tab" aria-label="会话信息流" aria-selected={!activeId}
      tabIndex={activeId ? -1 : 0}
      onClickCapture={(event) => {
        if (activeId) { event.stopPropagation(); select(scope, null); }
      }}
      onClick={() => select(scope, null)}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && ['Enter', ' '].includes(event.key)) {
          event.preventDefault(); select(scope, null);
        }
      }}>
      {children}
    </div>
    {tabs.filter((tab) => tab.scope === scope).map((tab) => <div key={tab.id} className="ugs-preview-file-tab" data-active={tab.id === activeId}>
      <button type="button" role="tab" aria-selected={tab.id === activeId} tabIndex={tab.id === activeId ? 0 : -1}
        title={displayFileRefPath(tab.ref, tab.cwd)} onClick={() => select(scope, tab.id)}>
        <FileText size={13} aria-hidden="true" /><span>{tab.ref.basename}</span>
      </button>
      <button type="button" className="ugs-preview-tab-close" aria-label={`关闭预览：${tab.ref.basename}`}
        title="关闭预览" onClick={() => close(tab.id)}><X size={12} /></button>
    </div>)}
  </div>;
}

export function MainFilePreview({ scope }: { scope: string }) {
  const tabs = useFilePreviewTabs((state) => state.tabs);
  const activeId = useFilePreviewTabs((state) => state.activeByScope[scope]);
  const close = useFilePreviewTabs((state) => state.close);
  const active = tabs.find((tab) => tab.scope === scope && tab.id === activeId);
  if (!tabs.some((tab) => tab.scope === scope)) return null;
  return <div className="ugs-main-file-preview" hidden={!active} role="tabpanel" aria-label={`文件预览：${active?.ref.basename ?? ''}`}>
    {tabs.filter((tab) => tab.scope === scope).map((tab) => <div key={tab.id}
      className="ugs-main-file-preview-content" hidden={tab.id !== activeId}>
      <FilePreviewDrawer refData={tab.ref} cwd={tab.cwd} previewFile={tab.previewFile}
        diffEnabled={tab.diffEnabled} canOpenExternally={tab.canOpenExternally}
        variant="main" active={tab.id === activeId} onClose={() => close(tab.id)} />
    </div>)}
  </div>;
}
