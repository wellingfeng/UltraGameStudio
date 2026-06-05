import defaultsConfig from '@/config/personalInstructionsDefaults.json';
import type { GatewaySelection } from './ir';

/**
 * Pure formatting helpers for user-level personal defaults. Storage lives in
 * lib/composerStorage so runtime code can stay browser-agnostic.
 */
export type PersonalInstructionsByModel = Record<string, string>;

interface PersonalInstructionsDefaultsConfig {
  requiredSection: string[];
  base: string[];
  profiles: Record<string, string[]>;
  adapterProfiles: Record<string, string>;
  providerProfiles: Record<string, string>;
  defaultSelections: Array<Partial<GatewaySelection>>;
}

const PERSONAL_INSTRUCTIONS_DEFAULTS =
  defaultsConfig as PersonalInstructionsDefaultsConfig;

const LARKDOC_PERSONAL_INSTRUCTIONS_SECTION =
  PERSONAL_INSTRUCTIONS_DEFAULTS.requiredSection.join('\n');

const BASE_PERSONAL_INSTRUCTIONS_SAMPLE =
  PERSONAL_INSTRUCTIONS_DEFAULTS.base.join('\n');

const DEFAULT_PERSONAL_INSTRUCTIONS_SELECTIONS =
  PERSONAL_INSTRUCTIONS_DEFAULTS.defaultSelections;

function normalized(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

function defaultProfileId(
  selection: Partial<GatewaySelection> | null | undefined,
): string {
  const providerId = normalized(selection?.providerId);
  const channelId = normalized(selection?.channelId);
  const providerProfiles = PERSONAL_INSTRUCTIONS_DEFAULTS.providerProfiles;
  const channelProfile =
    providerId && channelId ? providerProfiles[`${providerId}/${channelId}`] : '';
  if (channelProfile) return channelProfile;
  const providerProfile = providerId ? providerProfiles[providerId] : '';
  if (providerProfile) return providerProfile;
  const adapter = normalized(selection?.adapter) || 'claude-code';
  return (
    PERSONAL_INSTRUCTIONS_DEFAULTS.adapterProfiles[adapter] ??
    PERSONAL_INSTRUCTIONS_DEFAULTS.adapterProfiles['claude-code'] ??
    'claude-code'
  );
}

function profileSuffix(profileId: string): string {
  return PERSONAL_INSTRUCTIONS_DEFAULTS.profiles[profileId]?.join('\n') ?? '';
}

function keyPart(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim() || fallback;
  return encodeURIComponent(trimmed.toLowerCase());
}

export function personalInstructionsKey(
  selection: Partial<GatewaySelection> | null | undefined,
): string {
  const model =
    typeof selection?.modelOverride === 'string' && selection.modelOverride.trim()
      ? selection.modelOverride
      : selection?.modelClass;
  return [
    keyPart(selection?.adapter, 'claude-code'),
    selection?.systemDefault ? 'system' : keyPart(selection?.providerId, 'system'),
    selection?.systemDefault ? 'default' : keyPart(selection?.channelId, 'default'),
    keyPart(model, 'default'),
  ].join('|');
}

function decodeKeyPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function selectionFromPersonalInstructionsKey(
  key: string,
): GatewaySelection | null {
  const [adapter, provider, channel, model] = key.split('|');
  if (!adapter || !provider || !channel || !model) return null;
  const systemDefault = provider === 'system' && channel === 'default';
  return {
    adapter: decodeKeyPart(adapter),
    modelClass: decodeKeyPart(model),
    ...(systemDefault
      ? { systemDefault: true }
      : {
          providerId: decodeKeyPart(provider),
          channelId: decodeKeyPart(channel),
        }),
  };
}

export function personalInstructionsForSelection(
  byModel: PersonalInstructionsByModel | null | undefined,
  selection: Partial<GatewaySelection> | null | undefined,
): string {
  return byModel?.[personalInstructionsKey(selection)] ?? '';
}

export function withPersonalInstructionsForSelection(
  byModel: PersonalInstructionsByModel,
  selection: Partial<GatewaySelection> | null | undefined,
  instructions: string,
): PersonalInstructionsByModel {
  const key = personalInstructionsKey(selection);
  if (!instructions.trim()) {
    const next = { ...byModel };
    delete next[key];
    return next;
  }
  return {
    ...byModel,
    [key]: ensureRequiredPersonalInstructions(instructions),
  };
}

export function ensureRequiredPersonalInstructions(instructions: string): string {
  const trimmed = instructions.trim();
  if (!trimmed) return '';
  const hasLarkDoc = /\blarkdoc\b/i.test(trimmed);
  const hasNoEnterprisePermission = /企业权限|enterprise permission/i.test(trimmed);
  if (hasLarkDoc && hasNoEnterprisePermission) return trimmed;
  return `${trimmed}\n\n${LARKDOC_PERSONAL_INSTRUCTIONS_SECTION}`;
}

export function personalInstructionsSample(
  selection: Partial<GatewaySelection> | null | undefined,
): string {
  const suffix = profileSuffix(defaultProfileId(selection));
  return ensureRequiredPersonalInstructions(
    `${BASE_PERSONAL_INSTRUCTIONS_SAMPLE}${suffix}`,
  );
}

export function defaultPersonalInstructionsByModel(
  selections: ReadonlyArray<Partial<GatewaySelection> | null | undefined> = [],
): PersonalInstructionsByModel {
  const out: PersonalInstructionsByModel = {};
  for (const selection of [
    ...DEFAULT_PERSONAL_INSTRUCTIONS_SELECTIONS,
    ...selections,
  ]) {
    if (!selection) continue;
    const key = personalInstructionsKey(selection);
    if (out[key]?.trim()) continue;
    out[key] = personalInstructionsSample(selection);
  }
  return out;
}

export function shouldInjectPersonalInstructions(
  adapter: string | null | undefined,
): boolean {
  return (adapter ?? '').trim().toLowerCase() !== 'codex';
}

export function personalInstructionsBlock(
  instructions: string | null | undefined,
  adapter?: string | null,
): string {
  if (!shouldInjectPersonalInstructions(adapter)) return '';
  const trimmed = instructions?.trim();
  if (!trimmed) return '';
  return [
    '',
    '---',
    '【用户个人默认指令（低优先级）】',
    '以下内容来自「设置 > 个性化」。请尽量遵守；若与 FreeUltraCode 系统规则、workflow 模式约束、工具安全规则或本轮用户最新指令冲突，以后者为准。',
    trimmed,
  ].join('\n');
}

export function appendPersonalInstructions(
  prompt: string,
  instructions: string | null | undefined,
  adapter?: string | null,
): string {
  const block = personalInstructionsBlock(instructions, adapter);
  return block ? `${prompt}${block}` : prompt;
}
