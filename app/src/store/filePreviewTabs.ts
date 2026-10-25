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

interface FilePreviewTabsState {
  tabs: FilePreviewTab[];
  activeByScope: Record<string, string | null>;
  open: (tab: Omit<FilePreviewTab, 'id'>) => void;
  select: (scope: string, id: string | null) => void;
  close: (id: string) => void;
}

// Reader tabs are UI state, independent of conversation/history/model context.
export const useFilePreviewTabs = create<FilePreviewTabsState>((set) => ({
  tabs: [],
  activeByScope: {},
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
  select: (scope, id) => set((state) => ({
    activeByScope: { ...state.activeByScope, [scope]: id },
  })),
  close: (id) => set((state) => {
    const tab = state.tabs.find((item) => item.id === id);
    if (!tab) return state;
    const tabs = state.tabs.filter((item) => item.id !== id);
    return {
      tabs,
      activeByScope: state.activeByScope[tab.scope] === id
        ? { ...state.activeByScope, [tab.scope]: null }
        : state.activeByScope,
    };
  }),
}));
