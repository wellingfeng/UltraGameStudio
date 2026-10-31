import { tauriAvailable } from '../tauri';
import { describeCapabilities, validateSnapshot } from './catalog';
import type { ToolCatalogPort, ToolCatalogScope } from './types';

export const desktopToolCatalog: ToolCatalogPort = {
  describeCapabilities,
  async listCatalog(scope: ToolCatalogScope) {
    if (!tauriAvailable()) return null;
    const { invoke } = await import('@tauri-apps/api/core');
    return validateSnapshot(await invoke('tool_catalog_read', { scope }), scope);
  },
};

export async function cancelCatalogDiscovery(requestId: string): Promise<void> {
  if (!tauriAvailable()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('tool_catalog_cancel', { requestId });
}
