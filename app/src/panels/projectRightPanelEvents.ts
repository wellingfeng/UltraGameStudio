import type { FileRef } from '@/components/ai/lib/filePath';

export const TOGGLE_PROJECT_RIGHT_PANEL_EVENT = 'ugs:project-right-panel-toggle';
export const PROJECT_RIGHT_PANEL_VISIBILITY_EVENT = 'ugs:project-right-panel-visibility';
export const OPEN_PROJECT_RIGHT_PANEL_SESSION_FILES_EVENT =
  'ugs:project-right-panel-open-session-files';
export const SELECT_PROJECT_RIGHT_PANEL_TAB_EVENT = 'ugs:project-right-panel-select-tab';
export const CLOSE_PROJECT_RIGHT_PANEL_EVENT = 'ugs:project-right-panel-close';

export function requestProjectRightPanelTab(tab: 'session' | 'files'): void {
  window.dispatchEvent(new CustomEvent(SELECT_PROJECT_RIGHT_PANEL_TAB_EVENT, { detail: { tab } }));
}

export function requestProjectRightPanelClose(): void {
  window.dispatchEvent(new Event(CLOSE_PROJECT_RIGHT_PANEL_EVENT));
}

export function requestProjectRightPanelSessionFiles(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(OPEN_PROJECT_RIGHT_PANEL_SESSION_FILES_EVENT));
  }
}

export function requestProjectRightPanelToggle(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(TOGGLE_PROJECT_RIGHT_PANEL_EVENT));
  }
}

export const OPEN_PROJECT_RIGHT_PANEL_FILE_PREVIEW_EVENT =
  'ugs:project-right-panel-open-file-preview';

export interface OpenProjectRightPanelFilePreviewEventDetail {
  ref: FileRef;
  cwd?: string;
}

export function requestProjectRightPanelFilePreview(
  detail: OpenProjectRightPanelFilePreviewEventDetail,
): boolean {
  if (typeof window === 'undefined') return false;

  const event =
    new CustomEvent<OpenProjectRightPanelFilePreviewEventDetail>(
      OPEN_PROJECT_RIGHT_PANEL_FILE_PREVIEW_EVENT,
      { cancelable: true, detail },
    );
  return !window.dispatchEvent(event);
}
