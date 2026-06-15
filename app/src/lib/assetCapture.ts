// Bridges model-generation results into the unified Asset Hub.
//
// CONTRACT: This module is the single place that turns a generation result's
// media list (data URLs and/or remote URLs) into persisted, registered
// `AssetEntry` rows. Generation turns in the store call
// `captureGeneratedAssets` after a successful run; tracking is best-effort and
// never changes the turn's success/failure contract.
//
//  - data: URLs are decoded and written to the workspace asset cache via the
//    `save_generated_asset` backend command, then registered with the resolved
//    local path (falling back to the inline preview when no desktop backend is
//    available, e.g. in the browser or tests).
//  - remote http(s) URLs are registered as-is with `remoteUrl`/`previewUrl`, so
//    the Asset Hub can preview and re-open them without forcing a download.

import {
  markAssetDone,
  markAssetFailed,
  registerAsset,
  type AssetKind,
  type AssetOrigin,
} from './downloadRegistry';
import { saveGeneratedAsset, tauriAvailable } from './tauri';

export interface CaptureGeneratedAssetsInput {
  kind: AssetKind;
  /** Media sources from the generation result (data: or http(s) URLs). */
  sources: string[];
  origin?: AssetOrigin;
  provider?: string;
  model?: string;
  prompt?: string;
  sessionId?: string;
  workspaceId?: string | null;
  messageId?: string;
  cwd?: string;
  /** Human title stem; an index is appended when there is more than one item. */
  titlePrefix?: string;
  /** Existing pending entry to complete with the first generated source. */
  pendingAssetId?: string;
  /** Extra type-specific fields stored on each entry. */
  meta?: Record<string, unknown>;
}

interface ParsedDataUrl {
  mime: string;
  base64: string;
}

function parseDataUrl(src: string): ParsedDataUrl | null {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(src.trim());
  if (!match) return null;
  const mime = match[1] || 'application/octet-stream';
  const isBase64 = Boolean(match[2]);
  const payload = match[3] ?? '';
  if (!isBase64) {
    // Non-base64 (percent-encoded) data URLs are rare for binary media; skip
    // disk persistence and let the caller register the inline preview instead.
    return null;
  }
  return { mime, base64: payload };
}

function extForKind(kind: AssetKind): string {
  switch (kind) {
    case 'image':
    case 'sprite':
      return 'png';
    case 'video':
      return 'mp4';
    case 'audio':
    case 'music':
    case 'speech':
      return 'mp3';
    case 'mesh':
    case 'model':
      return 'glb';
    default:
      return 'bin';
  }
}

function titleFor(prefix: string, kind: AssetKind, index: number, total: number): string {
  const base = prefix.trim() || kind;
  const suffix = total > 1 ? `-${index + 1}` : '';
  return `${base}${suffix}.${extForKind(kind)}`;
}

/**
 * Register every media source from a generation result into the Asset Hub,
 * persisting inline data URLs to disk when a desktop backend is available.
 * Best-effort: failures are recorded on the entry but never thrown.
 */
export async function captureGeneratedAssets(
  input: CaptureGeneratedAssetsInput,
): Promise<void> {
  const { kind, sources } = input;
  if (!sources?.length) {
    if (input.pendingAssetId) markAssetFailed(input.pendingAssetId, 'No generated asset output.');
    return;
  }
  const prefix = input.titlePrefix ?? `generated-${kind}`;
  const total = sources.length;

  await Promise.all(
    sources.map(async (src, index) => {
      if (typeof src !== 'string' || !src.trim()) return;
      const title = titleFor(prefix, kind, index, total);
      const isRemote = /^https?:\/\//i.test(src);
      const pendingId = index === 0 ? input.pendingAssetId : undefined;

      if (isRemote) {
        if (pendingId) {
          markAssetDone(pendingId, {
            remoteUrl: src,
            previewUrl: src,
            title,
            meta: input.meta,
          });
          return;
        }
        registerAsset({
          kind,
          source: 'generated',
          origin: input.origin ?? 'remote',
          title,
          status: 'success',
          remoteUrl: src,
          previewUrl: src,
          provider: input.provider,
          model: input.model,
          prompt: input.prompt,
          sessionId: input.sessionId,
          workspaceId: input.workspaceId,
          messageId: input.messageId,
          meta: input.meta,
        });
        return;
      }

      const parsed = src.startsWith('data:') ? parseDataUrl(src) : null;

      // No desktop backend (browser/tests) or non-persistable source: keep the
      // inline preview so the asset is still discoverable in the hub.
      if (!parsed || !tauriAvailable()) {
        if (pendingId) {
          markAssetDone(pendingId, {
            previewUrl: src.startsWith('data:') ? src : undefined,
            title,
            meta: input.meta,
          });
          return;
        }
        registerAsset({
          kind,
          source: 'generated',
          origin: input.origin ?? 'local',
          title,
          status: 'success',
          previewUrl: src.startsWith('data:') ? src : undefined,
          provider: input.provider,
          model: input.model,
          prompt: input.prompt,
          sessionId: input.sessionId,
          workspaceId: input.workspaceId,
          messageId: input.messageId,
          meta: input.meta,
        });
        return;
      }

      const id =
        pendingId ??
        registerAsset({
          kind,
          source: 'generated',
          origin: input.origin ?? 'local',
          title,
          previewUrl: src,
          provider: input.provider,
          model: input.model,
          prompt: input.prompt,
          sessionId: input.sessionId,
          workspaceId: input.workspaceId,
          messageId: input.messageId,
          meta: input.meta,
        });
      try {
        const saved = await saveGeneratedAsset({
          bytesBase64: parsed.base64,
          mime: parsed.mime,
          kind,
          fileName: title,
          cwd: input.cwd,
        });
        markAssetDone(id, {
          localPath: saved.path,
          sizeBytes: saved.sizeBytes,
          title: saved.fileName,
        });
      } catch (err) {
        markAssetFailed(id, err instanceof Error ? err.message : String(err));
      }
    }),
  );
}
