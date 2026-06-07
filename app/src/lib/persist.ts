import type { IRGraph } from '@/core/ir';
import { tauriAvailable } from './tauri';

/**
 * CONTRACT: file-level persistence for the workflow IR.
 *
 *   saveWorkflow(ir, path?) -> Promise<string | null>
 *       In Tauri: writes JSON to `path` (or prompts user for a path via
 *       @tauri-apps/plugin-dialog save dialog when omitted). Returns the
 *       absolute path written, or null if the user cancelled the dialog.
 *       In the browser: writes to localStorage under FUC_STORAGE_KEY and
 *       returns the synthetic 'localStorage://fuc_workflow' sentinel so the
 *       caller can treat it as a stable identifier.
 *
 *   openWorkflow() -> Promise<{ ir: IRGraph; path: string | null } | null>
 *       In Tauri: opens a file picker, reads the chosen file, and parses it.
 *       Returns null on cancellation.
 *       In the browser: reads from localStorage (returns null when empty).
 *
 *   autosave(ir, path?) -> Promise<string | null>
 *       Non-interactive variant used by the autosave subscriber. In Tauri,
 *       writes to `path` if provided; otherwise it falls back to localStorage
 *       so a fresh, never-saved graph still survives a reload.
 *
 * The .fuc.json extension is the canonical FreeUltraCode file extension. The
 * IR is serialised with stable 2-space JSON so diffs are human-readable.
 */

/** localStorage key used as the no-backend autosave fallback. */
export const FUC_STORAGE_KEY = 'fuc_workflow';
/** Sentinel returned by saveWorkflow/autosave when only localStorage was written. */
export const LOCAL_STORAGE_PATH = 'localStorage://fuc_workflow';

/** Dynamically load the plugin-dialog save dialog (Tauri-only). */
async function getSaveDialog() {
  const { save } = await import('@tauri-apps/plugin-dialog');
  return save;
}

/** Dynamically load the plugin-dialog open dialog (Tauri-only). */
async function getOpenDialog() {
  const { open } = await import('@tauri-apps/plugin-dialog');
  return open;
}

/** Dynamically load the fs plugin's read/write helpers (Tauri-only). */
async function getFs(): Promise<{
  writeTextFile: (path: string, contents: string) => Promise<void>;
  readTextFile: (path: string) => Promise<string>;
}> {
  const mod = await import('@tauri-apps/plugin-fs');
  return {
    writeTextFile: mod.writeTextFile,
    readTextFile: mod.readTextFile,
  };
}

/**
 * Persist the IR to disk (Tauri) or localStorage (browser fallback).
 *
 * @param ir   The workflow IR to write.
 * @param path Optional pre-known destination path. When omitted and running
 *             inside Tauri, the user is prompted via a save dialog.
 * @returns    The path written (or LOCAL_STORAGE_PATH for the browser
 *             fallback); null if the user cancelled the save dialog.
 */
export async function saveWorkflow(
  ir: IRGraph,
  path?: string,
  title = '保存 Workflow',
): Promise<string | null> {
  const json = JSON.stringify(ir, null, 2);

  if (!tauriAvailable()) {
    safeLocalSet(FUC_STORAGE_KEY, json);
    return LOCAL_STORAGE_PATH;
  }

  let target = path && path !== LOCAL_STORAGE_PATH ? path : undefined;
  if (!target) {
    const save = await getSaveDialog();
    const picked = await save({
      title,
      defaultPath: defaultFileName(ir),
      filters: [
        { name: 'FreeUltraCode', extensions: ['fuc.json', 'json'] },
      ],
    });
    if (!picked) return null;
    target = typeof picked === 'string' ? picked : String(picked);
  }

  try {
    const fs = await getFs();
    await fs.writeTextFile(target, json);
    return target;
  } catch {
    // If the fs plugin isn't registered, fall back to localStorage so the
    // user still loses no work. The toolbar will keep showing "已保存"
    // because we return a non-null path.
    safeLocalSet(FUC_STORAGE_KEY, json);
    return LOCAL_STORAGE_PATH;
  }
}

/**
 * Open a workflow IR from disk (Tauri) or localStorage (browser fallback).
 * Returns null if the user cancelled the picker or there is nothing to load.
 */
export async function openWorkflow(title = '打开 Workflow'): Promise<{
  ir: IRGraph;
  path: string | null;
} | null> {
  if (!tauriAvailable()) {
    const raw = safeLocalGet(FUC_STORAGE_KEY);
    if (!raw) return null;
    try {
      const ir = JSON.parse(raw) as IRGraph;
      return { ir, path: LOCAL_STORAGE_PATH };
    } catch {
      return null;
    }
  }

  const open = await getOpenDialog();
  const picked = await open({
    title,
    multiple: false,
    directory: false,
    filters: [{ name: 'FreeUltraCode', extensions: ['fuc.json', 'json'] }],
  });
  if (!picked) return null;
  const target = Array.isArray(picked)
    ? String(picked[0])
    : typeof picked === 'string'
      ? picked
      : String(picked);

  try {
    const fs = await getFs();
    const text = await fs.readTextFile(target);
    const ir = JSON.parse(text) as IRGraph;
    return { ir, path: target };
  } catch {
    return null;
  }
}

/**
 * Non-interactive save used by the autosave subscriber. Never opens a dialog:
 * if `path` is known we write to it, otherwise we write to localStorage so a
 * brand-new graph still survives a reload.
 */
export async function autosave(
  ir: IRGraph,
  path?: string | null,
): Promise<string | null> {
  const json = JSON.stringify(ir, null, 2);

  if (tauriAvailable() && path && path !== LOCAL_STORAGE_PATH) {
    try {
      const fs = await getFs();
      await fs.writeTextFile(path, json);
      return path;
    } catch {
      // fall through to localStorage
    }
  }

  safeLocalSet(FUC_STORAGE_KEY, json);
  return LOCAL_STORAGE_PATH;
}

/**
 * Export the current workflow to a user-chosen file so it can be shared or
 * backed up. Unlike {@link saveWorkflow}, the browser fallback performs a real
 * file download (not a localStorage write) and the per-run snapshot is stripped
 * so the exported file is a clean, portable blueprint.
 *
 * @returns The path written (Tauri), the EXPORT_DOWNLOAD_PATH sentinel (browser
 *          download), or null when the user cancelled / nothing happened.
 */
export async function exportWorkflowToFile(
  ir: IRGraph,
  title = '导出 Workflow',
): Promise<string | null> {
  const clean = stripRunSnapshot(ir);
  const json = JSON.stringify(clean, null, 2);
  const fileName = defaultFileName(clean);

  if (!tauriAvailable()) {
    return browserDownload(fileName, json) ? EXPORT_DOWNLOAD_PATH : null;
  }

  const save = await getSaveDialog();
  const picked = await save({
    title,
    defaultPath: fileName,
    filters: [{ name: 'FreeUltraCode', extensions: ['fuc.json', 'json'] }],
  });
  if (!picked) return null;
  const target = typeof picked === 'string' ? picked : String(picked);

  try {
    const fs = await getFs();
    await fs.writeTextFile(target, json);
    return target;
  } catch {
    return browserDownload(fileName, json) ? EXPORT_DOWNLOAD_PATH : null;
  }
}

/**
 * Import a workflow from a user-chosen file. Mirrors {@link exportWorkflowToFile}:
 * the browser fallback opens a real file picker (not localStorage). Returns null
 * when the user cancelled or the file was not a valid workflow IR.
 */
export async function importWorkflowFromFile(title = '导入 Workflow'): Promise<{
  ir: IRGraph;
  path: string | null;
} | null> {
  if (!tauriAvailable()) {
    const text = await browserPickFile();
    if (text == null) return null;
    const ir = parseWorkflowJson(text);
    return ir ? { ir, path: null } : null;
  }

  const open = await getOpenDialog();
  const picked = await open({
    title,
    multiple: false,
    directory: false,
    filters: [{ name: 'FreeUltraCode', extensions: ['fuc.json', 'json'] }],
  });
  if (!picked) return null;
  const target = Array.isArray(picked)
    ? String(picked[0])
    : typeof picked === 'string'
      ? picked
      : String(picked);

  try {
    const fs = await getFs();
    const text = await fs.readTextFile(target);
    const ir = parseWorkflowJson(text);
    return ir ? { ir, path: target } : null;
  } catch {
    return null;
  }
}

/** Sentinel path returned after a browser export triggered a file download. */
export const EXPORT_DOWNLOAD_PATH = 'download://fuc_workflow';

/** Strip the per-run snapshot from the IR so exports are clean blueprints. */
function stripRunSnapshot(ir: IRGraph): IRGraph {
  if (!ir.meta?.run) return ir;
  const meta = { ...ir.meta };
  delete meta.run;
  return { ...ir, meta };
}

/** Parse + shape-guard a workflow JSON string. Returns null when not an IR. */
function parseWorkflowJson(text: string): IRGraph | null {
  try {
    const ir = JSON.parse(text) as IRGraph;
    if (ir && Array.isArray(ir.nodes) && Array.isArray(ir.edges)) return ir;
    return null;
  } catch {
    return null;
  }
}

/** Trigger a browser file download for the given contents. Returns success. */
function browserDownload(fileName: string, contents: string): boolean {
  try {
    if (typeof document === 'undefined' || typeof URL === 'undefined') {
      return false;
    }
    const blob = new Blob([contents], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke on the next tick so the click has a chance to start the download.
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Open a hidden <input type="file"> and resolve the selected file's text.
 * Resolves null on error. (Picker cancellation simply never resolves — the
 * caller treats a no-op as "nothing imported", which is the desired behaviour.)
 */
function browserPickFile(): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      if (typeof document === 'undefined') {
        resolve(null);
        return;
      }
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,.fuc.json,application/json';
      input.style.display = 'none';
      input.onchange = () => {
        const file = input.files?.[0];
        input.remove();
        if (!file) {
          resolve(null);
          return;
        }
        const reader = new FileReader();
        reader.onload = () =>
          resolve(typeof reader.result === 'string' ? reader.result : null);
        reader.onerror = () => resolve(null);
        reader.readAsText(file);
      };
      document.body.appendChild(input);
      input.click();
    } catch {
      resolve(null);
    }
  });
}

/** Derive a sensible default file name from the IR meta. */
function defaultFileName(ir: IRGraph): string {
  const base = (ir.meta.name ?? 'workflow')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .toLowerCase();
  return `${base || 'workflow'}.fuc.json`;
}

/**
 * Synchronously restore the last autosaved workflow from localStorage, if any.
 *
 * Used as the store's seed so a reload (or a "new workflow" followed by edits)
 * resumes the user's actual work instead of snapping back to a demo sample.
 * Returns null when there is nothing stored or the payload is corrupt.
 */
export function loadLocalWorkflow(): IRGraph | null {
  const raw = safeLocalGet(FUC_STORAGE_KEY);
  if (!raw) return null;
  try {
    const ir = JSON.parse(raw) as IRGraph;
    // Minimal shape guard — must look like an IRGraph.
    if (ir && Array.isArray(ir.nodes) && Array.isArray(ir.edges)) return ir;
    return null;
  } catch {
    return null;
  }
}

function safeLocalGet(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeLocalSet(key: string, value: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, value);
  } catch {
    /* ignore quota / disabled storage */
  }
}
