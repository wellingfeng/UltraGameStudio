// ComfyUI native API client + graph model.
//
// CONTRACT: This module owns the *data + transport* layer for the embedded
// ComfyUI node-graph feature. It speaks ComfyUI's native HTTP/WS protocol
// (POST /prompt, GET /history, GET /view, GET /object_info, WS /ws) against a
// local server (default http://127.0.0.1:8188). The chat-stream rendering
// (ComfyGraphBlock) and the React Flow projection (core/comfyToFlow.ts) are
// pure transforms over the {@link ComfyPromptGraph} shape defined here.
//
// A ComfyUI "prompt graph" is a flat map of node-id -> node. Each node carries
// a `class_type` (the registered node name, e.g. "KSampler") and an `inputs`
// map whose values are either literals or `[fromNodeId, outputIndex]` links.
// This is exactly what POST /prompt accepts, so the block body is stored
// verbatim and submitted without translation.

import {
  imageProviderBaseUrl,
  loadImageGenerationSettings,
  type ImageGenerationSettings,
} from './imageGeneration';

export interface ComfyNodeInputs {
  [key: string]: ComfyInputValue;
}

/** A node input is either a literal, or a link `[sourceNodeId, outputIndex]`. */
export type ComfyInputValue =
  | string
  | number
  | boolean
  | null
  | [string, number];

export interface ComfyNode {
  class_type: string;
  inputs: ComfyNodeInputs;
  /** Optional UI hints ComfyUI persists in exported workflows. */
  _meta?: { title?: string };
}

/** The canonical prompt-graph shape accepted by POST /prompt. */
export interface ComfyPromptGraph {
  [nodeId: string]: ComfyNode;
}

export interface ComfyOutputImage {
  filename: string;
  subfolder: string;
  type: string;
  /** Resolved /view URL for direct <img src>. */
  url: string;
}

export interface ComfyRunProgress {
  /** Currently executing node id, or null between nodes. */
  node: string | null;
  /** 0..1 sampler step progress for the active node, when reported. */
  value: number;
  max: number;
  /** Terminal images, populated once the run finishes. */
  images: ComfyOutputImage[];
  status: 'pending' | 'running' | 'done' | 'error';
  error?: string;
}

const STORAGE_KEY = 'freeultracode.comfyui.v1';
const DEFAULT_BASE_URL = 'http://127.0.0.1:8188';

export interface ComfyUiSettings {
  baseUrl: string;
}

export const DEFAULT_COMFYUI_SETTINGS: ComfyUiSettings = {
  baseUrl: DEFAULT_BASE_URL,
};

function hasStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage;
}

export function loadComfyUiSettings(): ComfyUiSettings {
  if (!hasStorage()) return DEFAULT_COMFYUI_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_COMFYUI_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<ComfyUiSettings>;
    const baseUrl =
      typeof parsed.baseUrl === 'string' && parsed.baseUrl.trim()
        ? parsed.baseUrl.trim().replace(/\/+$/, '')
        : DEFAULT_BASE_URL;
    return { baseUrl };
  } catch {
    return DEFAULT_COMFYUI_SETTINGS;
  }
}

export function saveComfyUiSettings(settings: ComfyUiSettings): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ baseUrl: settings.baseUrl.trim().replace(/\/+$/, '') }),
    );
    window.dispatchEvent(new Event('fuc:comfyui-settings-changed'));
  } catch {
    /* non-fatal */
  }
}

export function comfyBaseUrl(
  settings = loadComfyUiSettings(),
  imageSettings: ImageGenerationSettings = loadImageGenerationSettings(),
): string {
  // Prefer the shared image-generation "ComfyUI" channel so a single place
  // configures both simple image generation and the embedded node-graph
  // runner. A value explicitly saved in the standalone ComfyUI settings (one
  // that differs from the built-in localhost default) still wins as an override.
  const own = (settings.baseUrl || '').replace(/\/+$/, '');
  if (own && own !== DEFAULT_BASE_URL) return own;
  const channel = imageProviderBaseUrl('local-comfyui', imageSettings).replace(/\/+$/, '');
  return channel || own || DEFAULT_BASE_URL;
}

/**
 * API key/token for the configured ComfyUI endpoint, sourced from the shared
 * image-generation `local-comfyui` channel. Empty for the typical unauthenticated
 * local server; populated when pointing at an authenticated remote/cloud ComfyUI.
 */
export function comfyApiKey(
  imageSettings: ImageGenerationSettings = loadImageGenerationSettings(),
): string {
  return imageSettings.providerKeys['local-comfyui']?.trim() ?? '';
}

/** Authorization headers for the ComfyUI endpoint (empty when no key is set). */
export function comfyAuthHeaders(apiKey = comfyApiKey()): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function newClientId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `comfy-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Build a /view URL for an output image record. */
export function comfyViewUrl(
  baseUrl: string,
  image: { filename: string; subfolder?: string; type?: string },
): string {
  const params = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder ?? '',
    type: image.type ?? 'output',
  });
  return `${baseUrl}/view?${params.toString()}`;
}

/**
 * Parse a fenced ` ```comfyui ` block body into a prompt graph. The body may be
 * either the bare prompt-map ({id: {class_type, inputs}}) or a wrapper object
 * carrying it under `prompt` / `workflow`. Returns null on invalid JSON so the
 * renderer can fall back to a raw code view instead of throwing.
 */
export function parseComfyGraph(raw: string): ComfyPromptGraph | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const candidate = isPromptGraph(obj.prompt)
    ? (obj.prompt as ComfyPromptGraph)
    : isPromptGraph(obj.workflow)
      ? (obj.workflow as ComfyPromptGraph)
      : isPromptGraph(obj)
        ? (obj as ComfyPromptGraph)
        : null;
  return candidate;
}

function isPromptGraph(value: unknown): value is ComfyPromptGraph {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.values(value as Record<string, unknown>);
  if (entries.length === 0) return false;
  return entries.every(
    (node) =>
      !!node &&
      typeof node === 'object' &&
      !Array.isArray(node) &&
      typeof (node as ComfyNode).class_type === 'string',
  );
}

/** Serialize a graph back into a stable, pretty block body for write-back. */
export function stringifyComfyGraph(graph: ComfyPromptGraph): string {
  return JSON.stringify(graph, null, 2);
}

/**
 * Strip a leading ComfyUI slash command / mode marker from a user message,
 * leaving the bare image/workflow description. Mirrors stripImageCommand.
 */
export function stripComfyCommand(text: string): string {
  return text
    .trim()
    .replace(/^\/(?:comfyui|comfy)(?:-mode-(?:start|end))?\s*/iu, '')
    .trim();
}

// ── Transport ──────────────────────────────────────────────────────────────

interface ComfyHistoryEntry {
  outputs?: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }> }>;
  status?: { status_str?: string; completed?: boolean };
}

/** Brief node-type summary from /object_info, used to constrain AI authoring. */
export interface ComfyObjectInfoSummary {
  /** Registered class_type names available on the server. */
  classTypes: string[];
}

/**
 * Fetch the available node definitions so the authoring model can be told which
 * `class_type`s actually exist (otherwise it invents non-existent nodes), and
 * so the editor can validate before submit. Returns class-type names only to
 * keep the payload small; callers can re-fetch full schema on demand.
 */
export async function fetchComfyObjectInfo(
  baseUrl = comfyBaseUrl(),
  signal?: AbortSignal,
): Promise<ComfyObjectInfoSummary> {
  const response = await fetch(`${baseUrl}/object_info`, {
    headers: comfyAuthHeaders(),
    signal,
  });
  if (!response.ok) {
    throw new Error(`ComfyUI /object_info ${response.status} ${response.statusText}`);
  }
  const json = (await response.json()) as Record<string, unknown>;
  return { classTypes: Object.keys(json) };
}

/**
 * Submit a prompt graph to ComfyUI and resolve once an output image is ready.
 * Uses POST /prompt to enqueue, then polls GET /history/{id} until the run
 * completes (a WS subscription would give finer progress; polling keeps the
 * first cut dependency-free and robust to reconnects). `onProgress` is invoked
 * with coarse status transitions.
 */
export async function runComfyGraph(
  graph: ComfyPromptGraph,
  options: {
    baseUrl?: string;
    signal?: AbortSignal;
    onProgress?: (progress: ComfyRunProgress) => void;
  } = {},
): Promise<ComfyOutputImage[]> {
  const baseUrl = options.baseUrl ?? comfyBaseUrl();
  const clientId = newClientId();
  const authHeaders = comfyAuthHeaders();
  const { signal, onProgress } = options;
  const emit = (p: Partial<ComfyRunProgress>) =>
    onProgress?.({
      node: null,
      value: 0,
      max: 0,
      images: [],
      status: 'running',
      ...p,
    });

  emit({ status: 'pending' });
  const startResponse = await fetch(`${baseUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify({ prompt: graph, client_id: clientId }),
    signal,
  });
  if (!startResponse.ok) {
    const text = await startResponse.text().catch(() => '');
    throw new Error(
      `ComfyUI /prompt ${startResponse.status} ${startResponse.statusText}${
        text ? `: ${text}` : ''
      }`,
    );
  }
  const started = (await startResponse.json()) as { prompt_id?: string };
  const promptId = started.prompt_id;
  if (!promptId) throw new Error('ComfyUI did not return a prompt_id.');

  emit({ status: 'running' });
  for (let i = 0; i < 300; i += 1) {
    await delay(1000, signal);
    const historyResponse = await fetch(
      `${baseUrl}/history/${encodeURIComponent(promptId)}`,
      { headers: authHeaders, signal },
    );
    if (!historyResponse.ok) continue;
    const history = (await historyResponse.json()) as Record<string, ComfyHistoryEntry>;
    const entry = history[promptId];
    if (!entry) continue;
    const statusStr = entry.status?.status_str;
    if (statusStr === 'error') {
      emit({ status: 'error', error: 'ComfyUI reported an execution error.' });
      throw new Error('ComfyUI execution failed.');
    }
    const images = imagesFromHistory(entry, baseUrl);
    if (images.length > 0 || entry.status?.completed) {
      emit({ status: 'done', images });
      return images;
    }
  }
  emit({ status: 'error', error: 'ComfyUI job timed out.' });
  throw new Error('ComfyUI job timed out before an image was ready.');
}

function imagesFromHistory(entry: ComfyHistoryEntry, baseUrl: string): ComfyOutputImage[] {
  const out: ComfyOutputImage[] = [];
  for (const node of Object.values(entry.outputs ?? {})) {
    for (const image of node.images ?? []) {
      out.push({
        filename: image.filename,
        subfolder: image.subfolder,
        type: image.type,
        url: comfyViewUrl(baseUrl, image),
      });
    }
  }
  return out;
}

/** Quick reachability probe for the configured ComfyUI server. */
export async function pingComfyUi(
  baseUrl = comfyBaseUrl(),
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/system_stats`, {
      headers: comfyAuthHeaders(),
      signal,
    });
    return response.ok;
  } catch {
    return false;
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}
