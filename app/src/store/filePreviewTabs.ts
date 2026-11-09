import { create } from 'zustand';
import { displayFileRefPath, type FileRef } from '@/components/ai/lib/filePath';
import type { LocalFilePreview } from '@/lib/tauri';

export interface FilePreviewTab {
  id: string;
  scope: string;
  ref: FileRef;
  cwd?: string;
  previewFile: (path: string, opts?: { cwd?: string }) => Promise<LocalFilePreview>;
  diffEnabled: boolean;
  canOpenExternally: boolean;
}

export function filePreviewScope(workspace: string): string {
  const normalized = workspace.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

export interface BrowserPreviewTab {
  id: string;
  scope: string;
  expanded: boolean;
}

interface FilePreviewTabsState {
  tabs: FilePreviewTab[];
  activeByScope: Record<string, string | null>;
  browserTabs: BrowserPreviewTab[];
  chatOpenByScope: Record<string, boolean>;
  setPreviewChatOpen: (scope: string, open: boolean) => void;
  open: (tab: Omit<FilePreviewTab, 'id'>) => void;
  openBrowser: (scope: string) => void;
  closeBrowser: (id: string) => void;
  setBrowserExpanded: (id: string, expanded: boolean) => void;
  select: (scope: string, id: string | null) => void;
  close: (id: string) => void;
}

// Reader tabs are UI state, independent of conversation/history/model context.
let browserSequence = 0;
export const useFilePreviewTabs = create<FilePreviewTabsState>((set) => ({
  tabs: [],
  activeByScope: {},
  browserTabs: [],
  chatOpenByScope: {},
  setPreviewChatOpen: (scope, open) => set((state) => ({ chatOpenByScope: { ...state.chatOpenByScope, [scope]: open } })),
  open: (tab) => set((state) => {
    const path = filePreviewScope(displayFileRefPath(tab.ref, tab.cwd));
    const id = JSON.stringify([tab.scope, path]);
    const next = { ...tab, id };
    return {
      tabs: state.tabs.some((item) => item.id === id)
        ? state.tabs.map((item) => item.id === id ? next : item)
        : [...state.tabs, next],
      activeByScope: { ...state.activeByScope, [tab.scope]: id },
    };
  }),
  openBrowser: (scope) => set((state) => {
    const id = `${Date.now().toString(36)}-${++browserSequence}`;
    return {
      browserTabs: [...state.browserTabs.map((tab) => tab.scope === scope ? { ...tab, expanded: true } : tab),
        { id, scope, expanded: true }],
      activeByScope: { ...state.activeByScope, [scope]: id },
    };
  }),
  closeBrowser: (id) => set((state) => {
    const tab = state.browserTabs.find((item) => item.id === id);
    if (!tab) return state;
    const browserTabs = state.browserTabs.filter((item) => item.id !== id);
    const next = [...browserTabs].reverse().find((item) => item.scope === tab.scope && item.expanded);
    return {
      browserTabs,
      chatOpenByScope: !browserTabs.some((item) => item.scope === tab.scope && item.expanded) && !state.tabs.some((item) => item.scope === tab.scope)
        ? { ...state.chatOpenByScope, [tab.scope]: false } : state.chatOpenByScope,
      activeByScope: state.activeByScope[tab.scope] === id
        ? { ...state.activeByScope, [tab.scope]: next?.id ?? null }
        : state.activeByScope,
    };
  }),
  setBrowserExpanded: (id, expanded) => set((state) => {
    const target = state.browserTabs.find((item) => item.id === id);
    if (!target) return state;
    return {
      browserTabs: state.browserTabs.map((tab) => tab.id === id ? { ...tab, expanded }
        : !expanded && tab.scope === target.scope && !tab.expanded ? { ...tab, expanded: true } : tab),
      activeByScope: { ...state.activeByScope, [target.scope]: expanded ? id
        : state.activeByScope[target.scope] === id ? null : state.activeByScope[target.scope] },
    };
  }),
  select: (scope, id) => set((state) => ({
    activeByScope: { ...state.activeByScope, [scope]: id },
  })),
  close: (id) => set((state) => {
    const tab = state.tabs.find((item) => item.id === id);
    if (!tab) return state;
    const tabs = state.tabs.filter((item) => item.id !== id);
    return {
      tabs,
      chatOpenByScope: !tabs.some((item) => item.scope === tab.scope) && !state.browserTabs.some((item) => item.scope === tab.scope && item.expanded)
        ? { ...state.chatOpenByScope, [tab.scope]: false } : state.chatOpenByScope,
      activeByScope: state.activeByScope[tab.scope] === id
        ? { ...state.activeByScope, [tab.scope]: null }
        : state.activeByScope,
    };
  }),
}));
