export interface AssetCopyIO {
  choose(source: string): Promise<string | null>;
  read(source: string): Promise<{ bytesBase64: string }>;
  write(target: string, bytes: Uint8Array): Promise<void>;
}

/** The save dialog owns overwrite approval and grants destination fs scope. */
export async function saveAssetCopy(source: string, io: AssetCopyIO): Promise<string | null> {
  const target = await io.choose(source);
  if (!target) return null;
  if (target.replace(/\\/g, '/').toLowerCase() === source.replace(/\\/g, '/').toLowerCase()) throw new Error('请选择不同的目标文件');
  const payload = await io.read(source);
  const bytes = Uint8Array.from(atob(payload.bytesBase64), char => char.charCodeAt(0));
  await io.write(target, bytes);
  return target;
}
