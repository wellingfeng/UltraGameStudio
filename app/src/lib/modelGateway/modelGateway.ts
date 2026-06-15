import { primeCliRuntime, resolveCliInvocation } from '@/lib/cliConfig';
import { aiEditViaCli, isTauri } from '@/lib/tauri';
import {
  estimateGatewayUsage,
  mergeUsageReports,
  recordModelUsageForRoute,
  type ModelUsageReport,
  usageReportFromCliUsage,
} from '@/lib/usageMeter';
import { completeAnthropic } from './adapters/anthropic';
import { completeOpenAICompatible } from './adapters/openaiCompatible';
import {
  mergeGatewaySelection,
  nodeGatewayOverride,
  resolveGatewayRoute,
} from './resolver';
import type {
  GatewaySelection,
  GatewayTextRequest,
  NodeGatewayOverride,
  ResolvedGatewayRoute,
} from './types';

export async function completeGatewayText(
  request: GatewayTextRequest,
): Promise<string> {
  if (request.forceCli && isTauri()) {
    return completeGatewayTextViaCli(request);
  }

  if (request.route.transport === 'anthropic' && request.route.apiKey) {
    try {
      return await completeDirectWithUsage(request, completeAnthropic);
    } catch (error) {
      if (!shouldFallbackDirectFetchToCli(error, request.route)) {
        throw error;
      }
      return completeGatewayTextViaCli(request);
    }
  }
  if (
    request.route.transport === 'openai-compatible' &&
    request.route.apiKey
  ) {
    try {
      return await completeDirectWithUsage(request, completeOpenAICompatible);
    } catch (error) {
      if (!shouldFallbackDirectFetchToCli(error, request.route)) {
        throw error;
      }
      return completeGatewayTextViaCli(request);
    }
  }

  return completeGatewayTextViaCli(request);
}

async function completeDirectWithUsage(
  request: GatewayTextRequest,
  complete: (request: GatewayTextRequest) => Promise<string>,
): Promise<string> {
  let usage: ModelUsageReport | null = null;
  const text = await complete({
    ...request,
    onUsage: (report) => {
      usage = mergeUsageReports(usage, report);
      request.onUsage?.(report);
    },
  });
  recordModelUsageForRoute(
    request.route,
    usage ?? estimateGatewayUsage(request.system, request.userContent, text),
    { estimated: !usage, context: request.usageContext },
  );
  return text;
}

async function completeGatewayTextViaCli(
  request: GatewayTextRequest,
): Promise<string> {
  if (!isTauri()) {
    throw new Error(
      request.route.transport === 'simulator'
        ? 'SIMULATOR_ONLY'
        : 'NO_MODEL_GATEWAY_BACKEND',
    );
  }

  const cli = await resolveCliForRoute(request.route);
  const prompt = `${request.system}\n\n${request.userContent}`;
  let usage: ModelUsageReport | null = null;
  const text = await aiEditViaCli(prompt, request.route.adapter, {
    permission: request.permission ?? 'full',
    cwd: request.cwd,
    model: request.route.model,
    cliCommand: cli.command,
    // Inject the channel's credentials (e.g. a Codex relay key/base url) so the
    // local CLI targets the selected provider. See gatewayRouteEnv (cli branch).
    env: request.route.env,
    timeoutSeconds: request.timeoutSeconds,
    idleTimeoutSeconds: request.idleTimeoutSeconds,
    runId: request.runId,
    onUsage: (rawUsage) => {
      const report = usageReportFromCliUsage(rawUsage);
      if (!report) return;
      usage = mergeUsageReports(usage, report);
      request.onUsage?.(report);
    },
  });
  recordModelUsageForRoute(
    request.route,
    usage ?? estimateGatewayUsage(request.system, request.userContent, text),
    { estimated: !usage, context: request.usageContext },
  );
  return text;
}

function shouldFallbackDirectFetchToCli(
  error: unknown,
  route: ResolvedGatewayRoute,
): boolean {
  if (!isTauri()) return false;
  if (route.transport !== 'anthropic' && route.transport !== 'openai-compatible') {
    return false;
  }
  if (!route.apiKey && !route.baseUrl) return false;
  if (error instanceof TypeError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return (
    message === 'Failed to fetch' ||
    message.includes('NetworkError') ||
    message.includes('Load failed')
  );
}

export { nodeGatewayOverride };

export function applyGatewayOverride(
  selection: GatewaySelection,
  override?: NodeGatewayOverride,
): GatewaySelection {
  return mergeGatewaySelection(selection, override);
}

export function resolveDirectGatewayRoute(
  selection: GatewaySelection,
): ResolvedGatewayRoute | null {
  const route = resolveGatewayRoute(selectionWorkflow(selection));
  if (
    (route.transport === 'anthropic' ||
      route.transport === 'openai-compatible') &&
    route.apiKey
  ) {
    return route;
  }
  return null;
}

export async function resolveCliGatewayRoute(
  selection: GatewaySelection,
): Promise<ResolvedGatewayRoute & { cliCommand: string }> {
  const route = resolveGatewayRoute(selectionWorkflow(selection));
  const cli = await resolveCliForRoute(route);
  return { ...route, cliCommand: cli.command };
}

async function resolveCliForRoute(route: ResolvedGatewayRoute) {
  if (route.channelId) {
    const runtime = await primeCliRuntime();
    const candidate = runtime.candidates.find(
      (item) =>
        item.id === route.channelId &&
        item.adapter === route.adapter &&
        item.status === 'available',
    );
    if (candidate) {
      return {
        adapter: route.adapter,
        command: candidate.path ?? candidate.command,
        status: 'ready' as const,
        source: candidate.source,
        candidate,
      };
    }
  }

  const cli = await resolveCliInvocation(route.adapter);
  if (cli.status === 'invalid') {
    throw new Error(cli.error ?? 'CLI 路径不可用，请重新选择。');
  }
  return cli;
}

function selectionWorkflow(selection: GatewaySelection) {
  return {
    version: 1,
    meta: {
      adapter: selection.adapter,
      gateway: { defaults: selection },
    },
    nodes: [],
    edges: [],
  };
}
