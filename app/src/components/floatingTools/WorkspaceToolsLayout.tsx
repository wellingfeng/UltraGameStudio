import { useEffect, useRef, useState } from 'react';
import { FileDiff, FolderOpen, Globe2, MessageCircleMore } from 'lucide-react';
import WorkspaceMainSurface from '@/components/WorkspaceMainSurface';
import { useMainSurface } from '@/components/MainSurface';
import { requestTemporaryChat } from '@/components/temporaryChat/TemporaryChatWindows';
import { browserSource } from '@/components/temporaryChat/context';
import {
  PROJECT_RIGHT_PANEL_VISIBILITY_EVENT,
  requestProjectRightPanelClose,
  requestProjectRightPanelTab,
} from '@/panels/projectRightPanelEvents';
import BrowserPane from './BrowserPane';
import './floatingTools.css';

type FileTab = 'session' | 'files';
const COLLAPSE_DELAY_MS = 1000;

export default function WorkspaceToolsLayout() {
  const { surface } = useMainSurface();
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserExpanded, setBrowserExpanded] = useState(false);
  const [fileTab, setFileTab] = useState<FileTab | null>(null);
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const toolsRef = useRef<HTMLDivElement>(null);
  const pointerInsideTools = useRef(false);
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelCollapse = () => {
    if (collapseTimer.current !== null) clearTimeout(collapseTimer.current);
    collapseTimer.current = null;
  };
  const scheduleCollapse = () => {
    cancelCollapse();
    collapseTimer.current = setTimeout(() => {
      collapseTimer.current = null;
      const focused = document.activeElement;
      const keyboardFocusInside = focused instanceof HTMLElement
        && toolsRef.current?.contains(focused) && focused.matches(':focus-visible');
      if (!pointerInsideTools.current && !keyboardFocusInside) {
        if (focused instanceof HTMLElement && toolsRef.current?.querySelector('.ugs-floating-tools-more')?.contains(focused)) {
          focused.blur();
          cancelCollapse();
        }
        setToolsExpanded(false);
      }
    }, COLLAPSE_DELAY_MS);
  };

  useEffect(() => () => cancelCollapse(), []);

  useEffect(() => {
    const onVisibility = (event: Event) => {
      const detail = (event as CustomEvent<{ open: boolean; tab?: FileTab }>).detail;
      setFileTab(detail?.open ? detail.tab ?? null : null);
      if (detail?.open) { setBrowserOpen(false); setBrowserExpanded(false); }
    };
    window.addEventListener(PROJECT_RIGHT_PANEL_VISIBILITY_EVENT, onVisibility);
    return () => window.removeEventListener(PROJECT_RIGHT_PANEL_VISIBILITY_EVENT, onVisibility);
  }, []);

  useEffect(() => {
    if (surface !== 'chat') {
      setBrowserOpen(false); setBrowserExpanded(false);
      pointerInsideTools.current = false;
      cancelCollapse();
      setToolsExpanded(false);
    }
  }, [surface]);

  useEffect(() => {
    if (browserExpanded) {
      pointerInsideTools.current = false;
      cancelCollapse();
      setToolsExpanded(false);
    }
  }, [browserExpanded]);

  const selectFiles = (tab: FileTab) => {
    setBrowserOpen(false);
    setBrowserExpanded(false);
    requestProjectRightPanelTab(tab);
  };
  const toggleBrowser = () => {
    requestProjectRightPanelClose();
    setBrowserExpanded(false);
    setBrowserOpen((open) => !open);
  };

  return <>
    <div className="ugs-workspace-chat-region" style={browserOpen && browserExpanded ? { display: 'none' } : undefined}>
      <WorkspaceMainSurface />
      {surface === 'chat' && <div ref={toolsRef} className="ugs-floating-tools" role="toolbar" aria-label="快捷工具"
        data-expanded={toolsExpanded}
        onMouseEnter={() => { pointerInsideTools.current = true; cancelCollapse(); setToolsExpanded(true); }}
        onMouseLeave={() => { pointerInsideTools.current = false; scheduleCollapse(); }}
        onFocus={() => { cancelCollapse(); setToolsExpanded(true); }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget) && !pointerInsideTools.current) scheduleCollapse();
        }}>
        <button type="button" title="浏览器（鼠标靠近展开快捷工具）" aria-label="浏览器" aria-controls="ugs-floating-browser"
          aria-pressed={browserOpen} onClick={toggleBrowser}><Globe2 size={15} /></button>
        <div className="ugs-floating-tools-more" aria-hidden={!toolsExpanded}>
          <div className="ugs-floating-tools-more-content">
            <button type="button" title="会话文件" aria-label="会话文件" aria-controls="ugs-project-file-panel"
              tabIndex={toolsExpanded ? 0 : -1} aria-pressed={fileTab === 'session'} onClick={() => selectFiles('session')}><FileDiff size={15} /></button>
            <button type="button" title="项目文件" aria-label="项目文件" aria-controls="ugs-project-file-panel"
              tabIndex={toolsExpanded ? 0 : -1} aria-pressed={fileTab === 'files'} onClick={() => selectFiles('files')}><FolderOpen size={15} /></button>
            <span className="ugs-floating-tools-divider" />
            {/* Moon Modified: keep the active preview available when opening chat. */}
            <button type="button" title="新建临时聊天" aria-label="新建临时聊天" data-file-preview-ignore-outside-pointer="true"
              tabIndex={toolsExpanded ? 0 : -1} onClick={() => requestTemporaryChat(browserOpen ? browserSource() : undefined)}><MessageCircleMore size={15} /></button>
          </div>
        </div>
      </div>}
    </div>
    {browserOpen && surface === 'chat' && <BrowserPane expanded={browserExpanded} onExpandedChange={setBrowserExpanded}
      onClose={() => { setBrowserOpen(false); setBrowserExpanded(false); }} />}
  </>;
}
