import { useEffect } from 'react';
import WorkspaceMainSurface from '@/components/WorkspaceMainSurface';
import { useMainSurface } from '@/components/MainSurface';
import { filePreviewScope, useFilePreviewTabs } from '@/store/filePreviewTabs';
import { useStore } from '@/store/useStore';
import { PROJECT_RIGHT_PANEL_VISIBILITY_EVENT } from '@/panels/projectRightPanelEvents';
import BrowserPane from './BrowserPane';
import './floatingTools.css';

export default function WorkspaceToolsLayout() {
  const { surface } = useMainSurface();
  const scope = filePreviewScope(useStore((state) => state.composer.workspace));
  const browserTabs = useFilePreviewTabs((state) => state.browserTabs);
  const activePreviewId = useFilePreviewTabs((state) => state.activeByScope[scope]);
  const expandedActive = browserTabs.some((tab) => tab.scope === scope && tab.expanded && tab.id === activePreviewId);

  useEffect(() => {
    const onVisibility = (event: Event) => {
      const detail = (event as CustomEvent<{ open: boolean }>).detail;
      if (detail?.open) {
        useFilePreviewTabs.getState().browserTabs.filter((tab) => tab.scope === scope && !tab.expanded)
          .forEach((tab) => useFilePreviewTabs.getState().closeBrowser(tab.id));
      }
    };
    window.addEventListener(PROJECT_RIGHT_PANEL_VISIBILITY_EVENT, onVisibility);
    return () => window.removeEventListener(PROJECT_RIGHT_PANEL_VISIBILITY_EVENT, onVisibility);
  }, [scope]);

  useEffect(() => {
    if (surface !== 'chat') {
      useFilePreviewTabs.getState().browserTabs.filter((tab) => tab.scope === scope && !tab.expanded)
        .forEach((tab) => useFilePreviewTabs.getState().closeBrowser(tab.id));
    }
  }, [scope, surface]);

  return <div className="ugs-workspace-tools-layout">
    <div className="ugs-workspace-chat-region">
      <WorkspaceMainSurface />
    </div>
    {browserTabs.map((tab) => <BrowserPane key={tab.id} browserId={tab.id} scope={tab.scope} expanded={tab.expanded}
      visible={surface === 'chat' && tab.scope === scope && (tab.expanded ? activePreviewId === tab.id : !expandedActive)}
      onExpandedChange={(expanded) => useFilePreviewTabs.getState().setBrowserExpanded(tab.id, expanded)}
      onClose={() => useFilePreviewTabs.getState().closeBrowser(tab.id)} />)}
  </div>;
}
