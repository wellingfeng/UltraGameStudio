import {
  importProviders,
  listProviders,
  providerMetadataSignature,
  setActiveProviderId,
  type Provider,
} from '@/lib/apiConfig';
import {
  loadGatewayConfig,
  modelClassFromModelId,
  saveGatewayConfig,
  setActiveGatewaySelection,
} from '@/lib/gatewayConfig';
import {
  importCcSwitchClaude,
  isTauri,
  type ImportedProvider,
} from '@/lib/tauri';
import {
  flushRemoteProfileWrites,
  isRemoteProfileActive,
} from '@/lib/settingsProfile';
import type { GatewayProvider } from '@/lib/modelGateway/types';
import { historyStore } from '@/store/history/store';
import type {
  CcSwitchAutoImportRecord,
  CcSwitchAutoImportStatus,
} from '@/store/history/types';

export interface CcSwitchImportOutcome {
  status: CcSwitchAutoImportStatus;
  importedCount: number;
  skippedCount: number;
  reason?: string;
}

export interface CcSwitchImportOptions {
  /**
   * Manual imports preserve existing Settings behavior by promoting the active
   * Claude provider from cc-switch. Startup import leaves existing defaults
   * alone and only fills missing category defaults through importProviders().
   */
  promoteActiveAnthropic?: boolean;
}

type ProviderDraft = Omit<Provider, 'id'>;

let autoImportInFlight = false;

function importedProviderDraft(provider: ImportedProvider): ProviderDraft {
  return {
    kind: provider.kind,
    name: provider.name,
    apiKey: provider.apiKey,
    baseUrl: provider.baseUrl,
    transport: 'cli',
    model: provider.model,
  };
}

function providerToGatewayProvider(provider: Provider): GatewayProvider {
  const adapter =
    provider.kind === 'codex'
      ? 'codex'
      : provider.kind === 'gemini'
        ? 'gemini'
        : 'claude-code';
  const transport =
    provider.transport === 'cli' || provider.kind !== 'anthropic'
      ? 'cli'
      : 'anthropic';
  const model = provider.model?.trim() || undefined;
  return {
    id: provider.id,
    kind: provider.kind,
    name: provider.name,
    adapter,
    channels: [
      {
        id: 'default',
        name: model ?? 'Default',
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
        model,
        models: undefined,
        route: {
          transport,
          baseUrl: provider.baseUrl,
          model,
          models: undefined,
        },
      },
    ],
  };
}

function syncGatewayProviders(
  imported: ProviderDraft[],
  activeDraft?: ProviderDraft,
): void {
  const importedProviders = listProviders();
  const lookup = new Map(
    importedProviders.map((provider) => [providerMetadataSignature(provider), provider]),
  );
  const nextImported = imported
    .map((draft) => lookup.get(providerMetadataSignature(draft)))
    .filter((provider): provider is Provider => provider !== undefined);
  if (nextImported.length === 0) return;

  const current = loadGatewayConfig();
  // Drop gateway entries whose provider no longer exists in the (now deduped)
  // provider list — e.g. a stale duplicate folded away by importProviders'
  // collapseTransport. Gateway providers mirror provider ids, so an id that is
  // absent here is an orphan that would otherwise linger in the run selector.
  const validIds = new Set(importedProviders.map((provider) => provider.id));
  const nextProviders = current.providers.filter((provider) =>
    validIds.has(provider.id),
  );

  for (const provider of nextImported) {
    const gatewayProvider = providerToGatewayProvider(provider);
    const index = nextProviders.findIndex((candidate) => candidate.id === gatewayProvider.id);
    if (index >= 0) {
      nextProviders[index] = gatewayProvider;
    } else {
      nextProviders.push(gatewayProvider);
    }
  }

  saveGatewayConfig({
    version: 1,
    providers: nextProviders,
  });

  const active = activeDraft
    ? lookup.get(providerMetadataSignature(activeDraft))
    : undefined;
  if (active) {
    setActiveProviderId(active.id);
    setActiveGatewaySelection({
      adapter: providerToGatewayProvider(active).adapter,
      modelClass: modelClassFromModelId(active.model),
      providerId: active.id,
      channelId: 'default',
    });
  }
}

function normalizeErrorReason(error: unknown): string {
  if (error instanceof Error) {
    return error.message.trim() || error.name || 'Unknown error';
  }
  if (typeof error === 'string') return error.trim() || 'Unknown error';
  try {
    const json = JSON.stringify(error);
    if (json) return json;
  } catch {
    /* fall through */
  }
  return String(error).trim() || 'Unknown error';
}

function isMissingCcSwitchSource(reason: string): boolean {
  const normalized = reason.toLowerCase();
  return (
    reason.includes('未找到 cc-switch') ||
    normalized.includes('cc-switch database not found') ||
    normalized.includes('not found')
  );
}

function autoImportRecord(
  attemptedAt: string,
  outcome: CcSwitchImportOutcome,
): CcSwitchAutoImportRecord {
  return {
    version: 1,
    attemptedAt,
    status: outcome.status,
    importedCount: outcome.importedCount,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
  };
}

function autoImportStartedRecord(attemptedAt: string): CcSwitchAutoImportRecord {
  return {
    version: 1,
    attemptedAt,
    status: 'failed',
    reason: 'Auto-import attempt started but did not complete.',
  };
}

function logAutoImport(
  phase: string,
  message: string,
  details?: unknown,
  level: 'info' | 'warn' = 'info',
): void {
  const prefix = `[cc-switch:auto-import] ${phase}: ${message}`;
  if (details === undefined) {
    console[level](prefix);
    return;
  }
  console[level](prefix, details);
}

export async function importCcSwitchProviders(
  options: CcSwitchImportOptions = {},
): Promise<CcSwitchImportOutcome> {
  if (!isTauri()) {
    return {
      status: 'no-source',
      importedCount: 0,
      skippedCount: 0,
      reason: 'NO_BACKEND',
    };
  }

  try {
    const result = await importCcSwitchClaude();
    const providers = Array.isArray(result.providers) ? result.providers : [];
    if (providers.length === 0) {
      return {
        status: 'empty',
        importedCount: 0,
        skippedCount: 0,
      };
    }

    const activeAnthropic = options.promoteActiveAnthropic
      ? result.active?.anthropic
      : undefined;
    const activeMatch = activeAnthropic
      ? (incoming: ProviderDraft) =>
          providers.some(
            (provider) =>
              provider.ccId === activeAnthropic &&
              provider.name === incoming.name &&
              provider.apiKey === incoming.apiKey,
          )
      : undefined;
    const drafts = providers.map(importedProviderDraft);
    const { imported, skipped } = importProviders(drafts, activeMatch, {
      // cc-switch providers are CLI-backed; collapse a stale pre-`transport`
      // `direct` entry for the same relay instead of importing a duplicate.
      collapseTransport: true,
    });
    syncGatewayProviders(
      drafts,
      activeAnthropic
        ? providers
            .filter((provider) => provider.ccId === activeAnthropic)
            .map(importedProviderDraft)[0]
        : undefined,
    );

    // When a remote project profile is active, the writes above are persisted to
    // the remote account via write-behind. A fire-and-forget failure (server
    // unreachable, token expired) would otherwise leave the user believing the
    // copy synced. Await the in-flight remote writes and surface any failure so
    // the caller reports an honest error instead of a false success.
    if (isRemoteProfileActive()) {
      const writes = await flushRemoteProfileWrites();
      const failed = writes.filter((write) => !write.ok);
      if (failed.length > 0) {
        const detail = failed
          .map((write) => `${write.relPath}: ${write.error ?? 'unknown error'}`)
          .join('; ');
        return {
          status: 'failed',
          importedCount: imported,
          skippedCount: skipped,
          reason: `REMOTE_SYNC_FAILED: ${detail}`,
        };
      }
    }

    return {
      status: 'imported',
      importedCount: imported,
      skippedCount: skipped,
    };
  } catch (error) {
    const reason = normalizeErrorReason(error);
    if (reason === 'NO_BACKEND' || isMissingCcSwitchSource(reason)) {
      return {
        status: 'no-source',
        importedCount: 0,
        skippedCount: 0,
        reason,
      };
    }
    return {
      status: 'failed',
      importedCount: 0,
      skippedCount: 0,
      reason,
    };
  }
}

export async function maybeRunCcSwitchAutoImportOnFirstRun(): Promise<void> {
  if (autoImportInFlight) {
    logAutoImport('detect', 'auto-import already in flight; skipping');
    return;
  }
  autoImportInFlight = true;
  try {
    logAutoImport('detect', 'checking first-run marker');
    const config = await historyStore.getConfig();
    if (config.ccSwitchAutoImport?.version === 1) {
      logAutoImport('detect', 'already attempted; skipping', {
        attemptedAt: config.ccSwitchAutoImport.attemptedAt,
        status: config.ccSwitchAutoImport.status,
      });
      return;
    }

    const attemptedAt = new Date().toISOString();
    const startedRecord = autoImportStartedRecord(attemptedAt);
    await historyStore.patchConfig({ ccSwitchAutoImport: startedRecord });
    logAutoImport('write', 'reserved first-run marker', startedRecord);

    logAutoImport('invoke', 'reading providers from cc-switch', {
      attemptedAt,
    });
    const outcome = await importCcSwitchProviders();
    logAutoImport(
      'parse',
      `cc-switch import resolved as ${outcome.status}`,
      outcome,
      outcome.status === 'failed' ? 'warn' : 'info',
    );

    const record = autoImportRecord(attemptedAt, outcome);
    await historyStore.patchConfig({ ccSwitchAutoImport: record });
    logAutoImport('write', 'stored first-run marker', record);
  } catch (error) {
    logAutoImport(
      'failed',
      'unexpected startup import failure',
      normalizeErrorReason(error),
      'warn',
    );
  } finally {
    autoImportInFlight = false;
  }
}
