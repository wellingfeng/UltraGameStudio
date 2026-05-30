import { isTauri } from '@tauri-apps/api/core';

/**
 * Open a native folder-selection dialog and return the chosen path, or null if
 * the user cancelled / no picker is available.
 *
 * - In the Tauri desktop shell: uses the native dialog plugin and returns the
 *   absolute path of the selected directory.
 * - In a plain browser (dev / fallback): uses the File System Access API
 *   (`window.showDirectoryPicker`) which only exposes the folder *name*, not a
 *   full path. If unavailable, returns null without throwing.
 */
export async function pickFolder(): Promise<string | null> {
  if (isTauri()) {
    // Dynamic import so the browser build never tries to resolve the plugin's
    // IPC at load time.
    const { open } = await import('@tauri-apps/plugin-dialog');
    const result = await open({
      directory: true,
      multiple: false,
      title: '选择工作区文件夹',
    });
    return typeof result === 'string' ? result : null;
  }

  const picker = (
    window as unknown as {
      showDirectoryPicker?: () => Promise<{ name: string }>;
    }
  ).showDirectoryPicker;
  if (typeof picker === 'function') {
    try {
      const handle = await picker();
      return handle.name || null;
    } catch {
      // User dismissed the picker.
      return null;
    }
  }

  return null;
}

/** Last path segment, splitting on both POSIX and Windows separators. */
export function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
