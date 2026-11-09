import type { GatewaySelection } from '@/core/ir';
import { listProviders } from '@/lib/apiConfig';
import { FREE_CHANNEL_AUTO_ID, FREE_CHANNELS, isFreeChannelSelection } from '@/lib/freeChannels';
import { editableModelOptions, freeChannelModelCacheKey, providerModelCacheKey, refreshFreeChannelModels, refreshProviderModels } from '@/lib/modelLists';
import { resolveCliGatewayRoute } from '@/lib/modelGateway/modelGateway';
import type { ResolvedGatewayRoute } from '@/lib/modelGateway/types';
import { listCodexModels, listZcodeModels, type CodexCatalogModel } from '@/lib/tauri';
import { declaredLevelsFor, parseThinkingLevelOverrides, thinkingLevelOptions } from '@/lib/thinkingLevels';

const NON_CHAT = /embedding|rerank|moderation|whisper|speech|tts|image|audio|video|transcri|realtime|(^|[-/])live([-/]|$)/i;

function family(model: string, adapter: string): string {
  const id = model.toLowerCase().split('/').pop() ?? '';
  if (/^(gpt|o\d|codex)/.test(id)) return 'openai';
  if (/^(claude|opus|sonnet|haiku)/.test(id)) return 'claude';
  if (/^gemini/.test(id)) return 'gemini';
  if (/^(deepseek|dsh)/.test(id)) return 'deepseek';
  if (/^(kimi|k\d)/.test(id)) return 'kimi';
  if (/^(glm|chatglm)/.test(id)) return 'glm';
  if (/^grok/.test(id)) return 'grok';
  if (/^qwen/.test(id)) return 'qwen';
  if (!id || id === 'default' || id === 'auto') return ({ codex: 'openai', 'claude-code': 'claude', 'deepseek-harness': 'deepseek', zcode: 'glm' } as Record<string, string>)[adapter] ?? adapter;
  return id.split(/[-_.\d]/)[0];
}

/** Rank capability hints, then version, within a model family; never compare unrelated providers. */
function modelRank(id: string, description = ''): number[] {
  const text = `${id} ${description}`.toLowerCase();
  const version = id.toLowerCase().match(/(?:^|\D)(?:v|k)?(\d+)(?:[.-](\d+))?/);
  const major = version ? Number(version[1]) : 0;
  const minor = version?.[2] ? Number(version[2]) : 0;
  const tier = /frontier|most demanding|\bastra\b/.test(text) ? 5
    : /\b(opus|pro|max|ultra)\b/.test(text) ? 4
    : /\b(sol|sonnet|plus)\b|workhorse/.test(text) ? 3
    : /\b(flash|mini|nano|lite|haiku|luna|terra|turbo)\b/.test(text) ? 1 : 2;
  return [major, tier, minor];
}

function compareRank(a: number[], b: number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

export function strongestHandoffModel(models: string[], reference: string, adapter: string, catalog: CodexCatalogModel[] = []): string | undefined {
  const wanted = family(reference, adapter);
  const metadata = new Map(catalog.map((entry) => [entry.id.toLowerCase(), entry]));
  return models.filter((id) => id.trim() && !NON_CHAT.test(id) && family(id, adapter) === wanted)
    .sort((a, b) => compareRank(modelRank(b, metadata.get(b.toLowerCase())?.description), modelRank(a, metadata.get(a.toLowerCase())?.description)))[0];
}

export async function resolveHandoffSelection(
  selection: GatewaySelection,
  route: ResolvedGatewayRoute,
  thinkingOverrides: string,
  cwd: string,
): Promise<GatewaySelection> {
  const freeId = isFreeChannelSelection(selection);
  const provider = listProviders().find((item) => item.id === (route.providerId ?? selection.providerId));
  const reference = selection.modelOverride || route.model || provider?.model || selection.modelClass;
  let models: string[] = [];
  let catalog: CodexCatalogModel[] = [];

  if (selection.adapter === 'codex') {
    try {
      const cli = await resolveCliGatewayRoute(selection);
      catalog = await listCodexModels(cli.cliCommand);
    } catch {
      // The channel's own list below remains authoritative for availability.
    }
  }
  if (selection.adapter === 'zcode') {
    const cli = await resolveCliGatewayRoute(selection);
    catalog = await listZcodeModels(cwd, cli.cliCommand);
  }
  if (freeId) {
    const channel = FREE_CHANNELS.find((item) => item.id === freeId);
    if (!channel || channel.id === FREE_CHANNEL_AUTO_ID) throw new Error('自动渠道无法确定交接模型，请选择具体渠道后重试。');
    const result = await refreshFreeChannelModels(channel);
    const available = result.availableModels ?? result.models;
    const visible = new Set(editableModelOptions(freeChannelModelCacheKey(channel.id), available).map((id) => id.toLowerCase()));
    models = available.filter((id) => visible.has(id.toLowerCase()));
  } else if (provider) {
    const result = await refreshProviderModels(provider);
    const available = result.availableModels ?? result.models;
    const visible = new Set(editableModelOptions(providerModelCacheKey(provider), available).map((id) => id.toLowerCase()));
    models = available.filter((id) => visible.has(id.toLowerCase()));
  } else if (selection.systemDefault && selection.adapter === 'claude-code') {
    // Claude's CLI resolves this tier alias to its current highest-tier model.
    models = ['opus'];
  } else {
    models = catalog.map((item) => item.id);
  }

  if (selection.adapter === 'zcode') {
    const registered = new Set(catalog.map((item) => item.id.toLowerCase()));
    models = models.filter((id) => registered.has(id.toLowerCase()));
  }

  const model = strongestHandoffModel(models, reference, selection.adapter, catalog);
  if (!model) throw new Error('无法从当前渠道确定可用的交接模型，请检查该渠道的模型目录。');
  const entry = catalog.find((item) => item.id.toLowerCase() === model.toLowerCase());
  const declared = declaredLevelsFor(model, parseThinkingLevelOverrides(thinkingOverrides));
  const geminiLevelsSupported = selection.adapter === 'gemini' && /^gemini-(?:[3-9]|\d{2,})(?:[.-]|$)/i.test(model);
  const levels = declared ?? (entry?.reasoningEfforts.length ? entry.reasoningEfforts : thinkingLevelOptions({
    adapter: selection.adapter, model, baseUrl: route.baseUrl,
    transport: selection.adapter === 'grok' || selection.adapter === 'zcode' || geminiLevelsSupported ? 'openai-compatible' : route.transport,
  }).map((option) => option.id));
  const thinkingLevel = levels.filter((level) => {
    if (/^(off|none|default|disabled)$/i.test(level)) return false;
    // Codex catalogs may include coordination modes alongside reasoning levels.
    // Use their runtime descriptions, so future pure-depth levels still work.
    const description = entry?.reasoningEffortDescriptions?.[level] ?? '';
    return selection.adapter !== 'codex' || !/(delegat|multi[\s_-]*agent|sub[\s_-]*agent|自动委派|多智能体|子代理)/i.test(description);
  }).at(-1);
  const modelOverride = selection.adapter === 'zcode' && entry?.providerId ? `${entry.providerId}/${model}` : model;
  return { ...selection, modelOverride, thinkingLevel };
}
