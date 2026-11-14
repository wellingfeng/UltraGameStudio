import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { FileText, Globe2, X } from 'lucide-react';
import { displayFileRefPath } from './lib/filePath';
import { browserTabLabel, useFilePreviewTabs, type FilePreviewTab } from '@/store/filePreviewTabs';
import { fileSource } from '@/components/temporaryChat/context';
import TemporaryChatFrame from '@/components/temporaryChat/TemporaryChatFrame';
import { PreviewChatResizeHandle, usePreviewChatWidth } from '@/components/temporaryChat/PreviewChatResize';
import FilePreviewDrawer from './FilePreviewDrawer';
import './FilePreviewTabs.css';

export function FilePreviewTabs({ scope, children }: { scope: string; children: ReactNode }) {
  const tabs = useFilePreviewTabs((state) => state.tabs);
  const activeId = useFilePreviewTabs((state) => state.activeByScope[scope]);
  const select = useFilePreviewTabs((state) => state.select);
  const close = useFilePreviewTabs((state) => state.close);
  const browserTabs = useFilePreviewTabs((state) => state.browserTabs);
  const closeBrowser = useFilePreviewTabs((state) => state.closeBrowser);
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
    {browserTabs.filter((tab) => tab.scope === scope && tab.expanded).map((tab) => {
      const label = browserTabLabel(tab);
      return <div key={tab.id} className="ugs-preview-file-tab" data-active={activeId === tab.id}>
        <button type="button" role="tab" aria-label={label} aria-selected={activeId === tab.id}
          tabIndex={activeId === tab.id ? 0 : -1} title={label} onClick={() => select(scope, tab.id)}>
          <Globe2 size={13} aria-hidden="true" /><span>{label}</span>
        </button>
        <button type="button" className="ugs-preview-tab-close" aria-label={`关闭预览：${label}`}
          title="关闭预览" onClick={() => closeBrowser(tab.id)}><X size={12} /></button>
      </div>;
    })}
  </div>;
}

export function MainFilePreview({ scope }: { scope: string }) {
  const tabs = useFilePreviewTabs((state) => state.tabs);
  const activeId = useFilePreviewTabs((state) => state.activeByScope[scope]);
  const close = useFilePreviewTabs((state) => state.close);
  const chatOpenByScope = useFilePreviewTabs((state) => state.chatOpenByScope);
  const setChatOpen = useFilePreviewTabs((state) => state.setPreviewChatOpen);
  const { width: chatWidth, resize: setChatWidth } = usePreviewChatWidth();
  const active = tabs.find((tab) => tab.scope === scope && tab.id === activeId);
  if (!tabs.length) return null;
  return <div className="ugs-main-file-preview" hidden={!active} role="tabpanel" aria-label={`文件预览：${active?.ref.basename ?? ''}`}>
    {tabs.map((tab) => <MainFilePreviewContent key={tab.id}
      tab={tab} active={tab.scope === scope && tab.id === activeId} chatOpen={!!chatOpenByScope[tab.scope]} chatWidth={chatWidth} onResizeChat={setChatWidth}
      onOpenChat={() => setChatOpen(tab.scope, true)} onCloseChat={() => setChatOpen(tab.scope, false)} onClose={() => close(tab.id)} />)}
  </div>;
}

function MainFilePreviewContent({ tab, active, chatOpen, chatWidth, onResizeChat, onOpenChat, onCloseChat, onClose }: {
  tab: FilePreviewTab; active: boolean; chatOpen: boolean;
  chatWidth: number | null; onResizeChat: (width: number) => void;
  onOpenChat: () => void; onCloseChat: () => void; onClose: () => void;
}) {
  const [chatStarted, setChatStarted] = useState(false);
  useEffect(() => {
    if (active && chatOpen) setChatStarted(true);
  }, [active, chatOpen]);
  return <div className="ugs-main-file-preview-content" hidden={!active}>
    <FilePreviewDrawer refData={tab.ref} cwd={tab.cwd} previewFile={tab.previewFile}
      diffEnabled={tab.diffEnabled} canOpenExternally={tab.canOpenExternally}
      variant="main" active={active} onOpenChat={onOpenChat} onClose={onClose} />
    {(chatStarted || (active && chatOpen)) && <section className="ugs-preview-chat" hidden={!active || !chatOpen}
      data-resized={chatWidth !== null}
      style={chatWidth === null ? undefined : { '--ugs-preview-chat-width': `${Math.max(0, chatWidth)}px` } as CSSProperties}
      aria-label={`文件随手聊：${tab.ref.basename}`}>
      <PreviewChatResizeHandle onResize={onResizeChat} />
      <div className="ugs-preview-chat-heading">
        <span className="ugs-preview-chat-mark" aria-hidden="true">✦</span><span>随手聊</span>
        <button type="button" aria-label="关闭文件随手聊" title="关闭随手聊" onClick={onCloseChat}><X size={15} /></button>
      </div>
      <TemporaryChatFrame source={fileSource(tab.ref, tab.cwd)} title={`文件随手聊：${tab.ref.basename}`} fileTab />
    </section>}
  </div>;
}
