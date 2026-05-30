import type { IRGraph } from '@/core/ir';
import { tauriAvailable } from './tauri';

/**
 * CONTRACT: file-level persistence for the workflow IR.
 *
 *   saveWorkflow(ir, path?) -> Promise<string | null>
 *       In Tauri: writes JSON to `path` (or prompts user for a path via
 *       @tauri-apps/plugin-dialog save dialog when omitted). Returns the
 *       absolute path written, or null if the user cancelled the dialog.
 *       In the browser: writes to localStorage under OWF_STORAGE_KEY and
 *       returns the synthetic 'localStorage://owf_workflow' sentinel so the
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
 * The .owf.json extension is the canonical OpenWorkflow file extension. The
 * IR is serialised with stable 2-space JSON so diffs are human-readable.
 */

/** localStorage key used as the no-backend autosave fallback. */
export const OWF_STORAGE_KEY = 'owf_workflow';
/** Sentinel returned by saveWorkflow/autosave when only localStorage was written. */
export const LOCAL_STORAGE_PATH = 'localStorage://owf_workflow';

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

/**
 * Dynamically load the fs plugin's read/write helpers (Tauri-only).
 *
 * Uses an opaque specifier + @vite-ignore so neither TypeScript nor Vite
 * tries to resolve the module at build/typecheck time — the plugin may or
 * may not be installed depending on the desktop build profile, and when it
 * isn't we silently fall back to the localStorage path in the caller.
 */
async function getFs(): Promise<{
  writeTextFile: (path: string, contents: string) => Promise<void>;
  readTextFile: (path: string) => Promise<string>;
}> {
  const specifier = '@tauri-apps/plugin-fs';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = (await import(/* @vite-ignore */ specifier)) as any;
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
): Promise<string | null> {
  const json = JSON.stringify(ir, null, 2);

  if (!tauriAvailable()) {
    safeLocalSet(OWF_STORAGE_KEY, json);
    return LOCAL_STORAGE_PATH;
  }

  let target = path && path !== LOCAL_STORAGE_PATH ? path : undefined;
  if (!target) {
    const save = await getSaveDialog();
    const picked = await save({
      title: '保存 Workflow',
      defaultPath: defaultFileName(ir),
      filters: [
        { name: 'OpenWorkflow', extensions: ['owf.json', 'json'] },
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
    safeLocalSet(OWF_STORAGE_KEY, json);
    return LOCAL_STORAGE_PATH;
  }
}

/**
 * Open a workflow IR from disk (Tauri) or localStorage (browser fallback).
 * Returns null if the user cancelled the picker or there is nothing to load.
 */
export async function openWorkflow(): Promise<{
  ir: IRGraph;
  path: string | null;
} | null> {
  if (!tauriAvailable()) {
    const raw = safeLocalGet(OWF_STORAGE_KEY);
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
    title: '打开 Workflow',
    multiple: false,
    directory: false,
    filters: [{ name: 'OpenWorkflow', extensions: ['owf.json', 'json'] }],
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

  safeLocalSet(OWF_STORAGE_KEY, json);
  return LOCAL_STORAGE_PATH;
}

/** Derive a sensible default file name from the IR meta. */
function defaultFileName(ir: IRGraph): string {
  const base = (ir.meta.name ?? 'workflow')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .toLowerCase();
  return `${base || 'workflow'}.owf.json`;
}

/**
 * Synchronously restore the last autosaved workflow from localStorage, if any.
 *
 * Used as the store's seed so a reload (or a "new workflow" followed by edits)
 * resumes the user's actual work instead of snapping back to a demo sample.
 * Returns null when there is nothing stored or the payload is corrupt.
 */
export function loadLocalWorkflow(): IRGraph | null {
  const raw = safeLocalGet(OWF_STORAGE_KEY);
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
