import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import WorkspaceMainSurface from '@/components/WorkspaceMainSurface';
import { useMainSurface } from '@/components/MainSurface';
import { filePreviewScope, useFilePreviewTabs } from '@/store/filePreviewTabs';
import { useStore } from '@/store/useStore';
import { PROJECT_RIGHT_PANEL_VISIBILITY_EVENT } from '@/panels/projectRightPanelEvents';
import { hasProjectFileDragData, nativeFileDropTarget } from '@/lib/projectFileDrag';
import { tauriAvailable } from '@/lib/tauri';
import BrowserPane from './BrowserPane';
import './floatingTools.css';

export default function WorkspaceToolsLayout() {
  const { surface } = useMainSurface();
  const scope = filePreviewScope(useStore((state) => state.composer.workspace));
  const browserTabs = useFilePreviewTabs((state) => state.browserTabs);
  const activePreviewId = useFilePreviewTabs((state) => state.activeByScope[scope]);
  const expandedActive = browserTabs.some((tab) => tab.scope === scope && tab.expanded && tab.id === activePreviewId);
  const [projectDragging, setProjectDragging] = useState(false);

  useEffect(() => {
    const start = (event: DragEvent) => {
      if (event.dataTransfer && hasProjectFileDragData(event.dataTransfer)) setProjectDragging(true);
    };
    const stop = () => setProjectDragging(false);
    window.addEventListener('dragstart', start);
    window.addEventListener('drop', stop, true);
    window.addEventListener('dragend', stop, true);
    return () => {
      window.removeEventListener('dragstart', start);
      window.removeEventListener('drop', stop, true);
      window.removeEventListener('dragend', stop, true);
    };
  }, []);

  useEffect(() => {
    if (!tauriAvailable()) return;
    let disposed = false;
    const openFiles = (panel: HTMLElement | null, paths: string[]) => {
      const id = panel?.dataset.ugsBrowserPanel;
      if (!disposed && id && !panel.hidden) useFilePreviewTabs.getState().openBrowserFiles(id, paths);
    };
    const unlistenMain = import('@tauri-apps/api/webview').then(({ getCurrentWebview }) =>
      getCurrentWebview().onDragDropEvent(({ payload }) => {
        if (payload.type === 'drop') {
          openFiles(nativeFileDropTarget(payload.position)?.closest<HTMLElement>('[data-ugs-browser-panel]') ?? null, payload.paths);
        }
      }),
    ).catch(() => undefined);
    const unlistenPage = listen<{ browserId: string; paths: string[] }>('ugs:browser-file-drop', ({ payload }) => {
      openFiles(document.getElementById(`ugs-floating-browser-${payload.browserId}`), payload.paths);
    }).catch(() => undefined);
    return () => {
      disposed = true;
      void unlistenMain.then((stop) => stop?.());
      void unlistenPage.then((stop) => stop?.());
    };
  }, []);

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
    {browserTabs.map((tab) => <BrowserPane key={tab.id} browserId={tab.id} scope={tab.scope} expanded={tab.expanded} file={tab.file} projectDragging={projectDragging}
      visible={surface === 'chat' && tab.scope === scope && (tab.expanded ? activePreviewId === tab.id : !expandedActive)}
      onExpandedChange={(expanded) => useFilePreviewTabs.getState().setBrowserExpanded(tab.id, expanded)}
      onClose={() => useFilePreviewTabs.getState().closeBrowser(tab.id)} />)}
  </div>;
}
