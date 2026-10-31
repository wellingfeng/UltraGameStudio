import { SIMPLE_CHAT_SYSTEM, REMOTE_BACKGROUND_JOB_INSTRUCTION, buildAssetCapabilityBlock } from '@/lib/anthropic';
import { WORKSPACE_LAYOUT_DIRECTIVE } from '@/runtime';
import { isLocale, languageAdaptationPrompt, languageDirectiveReminder } from '@/lib/i18n';
import {
  preferredReadyImageProviderId,
} from '@/lib/imageGeneration';
import {
  preferredReadyMusicProviderId,
} from '@/lib/musicGeneration';
import {
  preferredReadySpeechProviderId,
} from '@/lib/speechGeneration';
import {
  preferredReadySpriteProviderId,
} from '@/lib/spriteGeneration';
import {
  preferredReadyThreeDProviderId,
} from '@/lib/threeDGeneration';
import {
  preferredReadyVideoProviderId,
} from '@/lib/videoGeneration';
import {
  preferredReadyAnimationProviderId,
} from '@/lib/animationGeneration';
import {
  listProviders,
} from '@/lib/apiConfig';
import { renderKnowledgeBaseContextForPrompt } from '@/lib/knowledgeBase';
import {
  getRemoteWorkspace,
  ensureRemoteWorkspaceProject,
  isClaudeFamilyModel,
  isRemoteRunnerProvider,
  notifyRemoteWorkspaceFilesUpdated,
  parseRemoteProviderId,
  readRemoteSecrets,
  resolveRemoteRunnerConnectionAsync,
  remoteWorkspaceIdFromPath,
  RunnerClient,
  type RemoteJob,
  type RemoteJobLogLine,
  type RemoteJobMessage,
  type RemoteJobStatus,
  type RemoteWorkspaceConfig,
} from '@/lib/remoteWorkspace';
import { shortId } from '@/lib/id';
import type { AiEditChannel } from './channelTypes';
import type { Message } from './types';
import type { IRGraph, IRRunStatus } from '@/core/ir';
import { REMOTE_JOB_TERMINAL_STATUSES, REMOTE_SKILL_HOST_ID } from '@ugs/protocol';
import { beginRemoteSkillForeground, finishRemoteLearning, requestRemoteContext } from '@/lib/remoteSkillLearning';
import type { FinishRemoteLearningOptions } from '@/lib/remoteSkillLearning';
import type { LoadedSkillContext } from '@/runtime/skills/context';
import type { SkillOrigin, SkillReviewState } from '@/runtime/skills/types';
import {
  encodeToolPatch,
  extractToolSentinels,
  mergeToolPatches,
  type ToolStatus,
} from '@/components/ai/lib/toolEvent';

export interface StartRemoteChatTurnOptions {
  ch: AiEditChannel;
  prompt: string;
  /** Exact user-message source captured at dispatch; never the active view. */
  sourceMessageId?: string;
  explicitSkillIds?: string[];
  /** Captured source session AND exact user-message persistence before job submission. */
  ready?: Promise<void>;
  /** Await durable source metadata before subscribing or finishing learning. */
  onSkillContext?: (context: NonNullable<Message['skillContext']>) => Promise<void>;
  onSkillReviewState?: (state: SkillReviewState) => void;
  workspacePath: string;
  locale: string;
  projectEngineGuidance: string;
  personalBlock: string;
  gameExpertBlock: string;
  knowledgeBaseMode: boolean;
  aiEditCommitMessages: (ch: AiEditChannel | null, persist: boolean) => void;
  commitAiChannelBlueprint: (ch: AiEditChannel, ir: IRGraph) => boolean;
  appendStartUserInputs: (ir: IRGraph, inputs: string[]) => IRGraph;
  syncAndPersistSessionRunStatus: (
    sessionKey: { workspaceId: string | null; sessionId: string | null },
    status: IRRunStatus | undefined,
  ) => void;
  formatClock: typeof import('@/runtime').formatClock;
  formatDuration: typeof import('@/runtime').formatDuration;
  removeAiEditChannel: (ch: AiEditChannel | null) => void;
}

const TERMINAL_STATUSES = new Set<RemoteJobStatus>(REMOTE_JOB_TERMINAL_STATUSES);

function compactLog(line: RemoteJobLogLine): string {
  // Model logs are raw CLI protocol (stream-json, hook responses, warnings).
  // Keep them for final answer parsing, but do not render them live.
  if (line.phase === 'model') return '';
  // Git progress ("Receiving objects: x%") rewrites a single line with carriage
  // returns rather than newlines. Keep only the final segment so the live view
  // shows the latest progress instead of a smeared one-liner.
  const collapsed = line.text?.replace(/\r\n/g, '\n').split('\r').pop();
  const text = collapsed?.trimEnd();
  if (!text) return '';
  const phase = line.phase ? `[${line.phase}] ` : '';
  const stream = line.stream === 'stderr' ? 'ERR ' : '';
  return `${phase}${stream}${text}`;
}

function statusLabel(status: RemoteJobStatus): string {
  switch (status) {
    case 'queued':
      return '排队中';
    case 'cloning':
      return '克隆仓库';
    case 'running':
      return '远程执行';
    case 'diffing':
      return '生成 diff';
    case 'pushing':
      return '推送分支';
    case 'done':
      return '完成';
    case 'error':
      return '失败';
    case 'canceled':
      return '已取消';
    default:
      return status;
  }
}

function finalStatus(status: RemoteJobStatus): 'success' | 'error' | 'interrupted' {
  if (status === 'done') return 'success';
  if (status === 'canceled') return 'interrupted';
  return 'error';
}

function remoteProviderAdapter(adapter: unknown): 'claude' | 'codex' | 'gemini' {
  if (adapter === 'codex') return 'codex';
  if (adapter === 'gemini') return 'gemini';
  return 'claude';
}

/** 渠道（适配器）面向用户的显示名。 */
function adapterDisplayLabel(
  adapter: 'claude' | 'codex' | 'gemini' | undefined,
): string {
  if (adapter === 'codex') return 'Codex';
  if (adapter === 'gemini') return 'Gemini';
  return 'Claude Code';
}

/** 选中远程账号时，取其对应 provider 的显示名（如「腾讯云 · 账号A」）。 */
function providerDisplayName(
  providerId: string | null | undefined,
): string | undefined {
  const id = providerId?.trim();
  if (!id) return undefined;
  return listProviders().find((item) => item.id === id)?.name?.trim() || undefined;
}

/**
 * 远程任务信息流头部的路由标签：除「云端项目 · 名称」外，再带上具体渠道、
 * 选中的模型账号名以及实际使用的模型，让用户清楚云端任务跑在哪个大模型上。
 */
export function buildRemoteRouteLabel(args: {
  config: RemoteWorkspaceConfig | null;
  adapter: 'claude' | 'codex' | 'gemini' | undefined;
  providerName?: string;
  model?: string;
}): string {
  const parts: string[] = [
    args.config ? `云端项目 · ${args.config.label}` : '云端项目',
    adapterDisplayLabel(args.adapter),
  ];
  if (args.providerName) parts.push(args.providerName);
  const model = args.model?.trim();
  if (model && model.toLowerCase() !== 'default') parts.push(model);
  return parts.join(' · ');
}

function remoteJobModelForAdapter(
  adapter: 'claude' | 'codex' | 'gemini' | undefined,
  model: string | null | undefined,
): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;
  // A non-Claude adapter must never receive a Claude-family model — neither a
  // bare tier alias (haiku/sonnet/opus) nor a full id like claude-opus-4-8.
  if (adapter && adapter !== 'claude' && isClaudeFamilyModel(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function remoteUsage(job: RemoteJob): Message['usage'] | undefined {
  const usage = job.result?.usage;
  if (!usage || usage.totalTokens <= 0) return undefined;
  const input = usage.inputTokens || 0;
  const cached = usage.cachedInputTokens || 0;
  return {
    inputTokens: input,
    outputTokens: usage.outputTokens || 0,
    totalTokens: usage.totalTokens || 0,
    cachedInputTokens: cached,
    cachePercent: input > 0 ? Math.round((cached / input) * 100) : 0,
    estimated: false,
  };
}

const MAX_REMOTE_FINAL_OUTPUT_CHARS = 12000;
const MAX_REMOTE_LIVE_LOG_CHARS = 12000;

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const obj = objectValue(block);
      if (!obj) return '';
      if (obj.type === 'text') return stringValue(obj.text);
      return '';
    })
    .join('');
}

function textFromMessage(value: unknown): string {
  const message = objectValue(value);
  if (!message) return '';
  return (
    textFromContent(message.content) ||
    stringValue(message.text) ||
    stringValue(message.result) ||
    stringValue(message.output_text)
  );
}

function codexEventKind(event: Record<string, unknown>): string {
  return stringValue(event.method) || stringValue(event.type);
}

function codexCompletedItem(event: Record<string, unknown>): Record<string, unknown> | null {
  const kind = codexEventKind(event);
  if (kind !== 'item.completed' && kind !== 'item/completed') return null;
  const item = objectValue(event.item);
  if (item) return item;
  const params = objectValue(event.params);
  return objectValue(params?.item);
}

function parseAgentJsonOutput(output: string): string {
  let assistant = '';
  let result = '';

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    const item = codexCompletedItem(record);
    if (item?.type === 'agent_message') {
      assistant += stringValue(item.text);
      continue;
    }

    const type = stringValue(record.type);
    if (type === 'assistant') {
      assistant += textFromMessage(record.message) || textFromContent(record.content);
    } else if (
      type === 'message' &&
      (stringValue(record.role) === 'assistant' ||
        stringValue(objectValue(record.message)?.role) === 'assistant')
    ) {
      assistant += textFromMessage(record.message) || textFromContent(record.content);
    } else if (type === 'message_delta' || type === 'content_block_delta') {
      assistant +=
        stringValue(objectValue(record.delta)?.text) ||
        stringValue(objectValue(record.delta)?.content);
    } else if (type === 'response.output_text.delta') {
      assistant += stringValue(record.delta);
    } else if (type === 'response.completed') {
      result =
        stringValue(objectValue(record.response)?.output_text) ||
        textFromContent(objectValue(record.response)?.output) ||
        result;
    } else if (type === 'result') {
      result = stringValue(record.result) || result;
    }
  }

  return (result.trim() || assistant.trim()).trim();
}

function lineLooksLikeJsonObject(line: string): boolean {
  if (!line.startsWith('{')) return false;
  try {
    return objectValue(JSON.parse(line)) != null;
  } catch {
    return false;
  }
}

function plainOutputFallback(output: string): string {
  return output
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return (
        trimmed &&
        !lineLooksLikeJsonObject(trimmed) &&
        !/\[DEP\d+\]\s+DeprecationWarning|node --trace-deprecation/i.test(trimmed)
      );
    })
    .join('\n')
    .trim();
}

export function outputLooksLikeProtocolNoise(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  // A single JSON object/array left as the "answer" is unparsed protocol, not prose.
  if (/^[{[][\s\S]*[}\]]$/.test(trimmed) && lineLooksLikeJsonObject(trimmed.split(/\r?\n/, 1)[0])) {
    return true;
  }
  // Known CLI protocol event keys. Do NOT classify by template-literal syntax
  // (`${...}`) — a game-dev coding agent legitimately quotes TS/JS in answers,
  // and that guard silently dropped every such answer (leaving only the raw diff).
  if (/hook_response|turn\.completed|item\.completed|session_id|DeprecationWarning/i.test(trimmed)) {
    return true;
  }
  return false;
}

/**
 * Wrap arbitrary text in a fenced code block whose fence is guaranteed longer
 * than any backtick run inside the body. A git diff (or any code) can itself
 * contain ``` runs (e.g. it edited a file that prints markdown), and a fixed
 * 3-backtick fence would terminate early — the rest of the diff then re-parses
 * as prose, which is exactly how source/`${...}`/regex leaked into the stream.
 */
export function fencedBlock(body: string, info: string): string {
  let longestRun = 0;
  for (const match of body.matchAll(/`+/g)) {
    longestRun = Math.max(longestRun, match[0].length);
  }
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `\n\n${fence}${info}\n${body}\n${fence}`;
}

function clipRemoteFinalOutput(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_REMOTE_FINAL_OUTPUT_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_REMOTE_FINAL_OUTPUT_CHARS).trimEnd()}\n\n…（远程输出过长，已截断）`;
}

function appendRemoteLogText(current: string, next: string): string {
  const combined = `${current}${current ? '\n' : ''}${next}`;
  if (combined.length <= MAX_REMOTE_LIVE_LOG_CHARS) return combined;
  const clipped = combined.slice(-MAX_REMOTE_LIVE_LOG_CHARS);
  const firstBreak = clipped.indexOf('\n');
  return firstBreak === -1 ? clipped : clipped.slice(firstBreak + 1);
}

function toolStatusFromRemote(status: string | undefined): ToolStatus {
  const normalized = status?.toLowerCase() ?? '';
  if (normalized === 'error' || normalized === 'failed' || normalized === 'failure') {
    return 'error';
  }
  if (
    normalized === 'running' ||
    normalized === 'started' ||
    normalized === 'in_progress'
  ) {
    return 'running';
  }
  return 'done';
}

function splitToolText(text: string): { name: string | null; detail: string } {
  const match = text.match(/^\s*([A-Za-z][A-Za-z0-9_.-]{0,80})\s*:\s*([\s\S]*)$/);
  if (!match) return { name: null, detail: text.trim() };
  return { name: match[1].trim(), detail: match[2].trim() };
}

export function remoteMessageLogText(
  message: Pick<RemoteJobMessage, 'args' | 'kind' | 'role' | 'status' | 'text' | 'toolName'>,
  id: string,
): string {
  const text = message.text?.trimEnd();
  if (!text) return '';
  if (message.role !== 'tool' && message.kind !== 'tool') return `[model] ${text}`;

  const parsed = splitToolText(text);
  const name = message.toolName?.trim() || parsed.name || 'tool';
  const subject =
    parsed.name && parsed.name.toLowerCase() === name.toLowerCase()
      ? parsed.detail
      : text.trim();

  return encodeToolPatch({
    id,
    name,
    subject: subject || undefined,
    args: message.args,
    status: toolStatusFromRemote(message.status),
  }).trim();
}

export function remoteSessionFileSentinelsForJob(
  job: Pick<RemoteJob, 'id' | 'result'>,
): string {
  const patch = job.result?.patch?.trim();
  if (!patch) return '';
  return encodeToolPatch({
    id: `remote-session-files-${job.id}`,
    name: 'file_change',
    status: 'done',
    result: patch,
    ephemeral: true,
  });
}

export function closeRunningRemoteToolCards(
  text: string,
  terminalStatus: Exclude<ToolStatus, 'running'>,
): string {
  const patches = extractToolSentinels(text).patches;
  if (patches.length === 0) return text;

  const runningTools = mergeToolPatches(patches).filter(
    (tool) => tool.status === 'running',
  );
  if (runningTools.length === 0) return text;

  const closingPatches = runningTools.map((tool) =>
    encodeToolPatch({
      id: tool.id,
      name: tool.name,
      subject: tool.subject,
      status: terminalStatus,
    }),
  );

  return `${text}${closingPatches.join('')}`;
}

function mergeRemoteLogs(
  liveLogs: readonly RemoteJobLogLine[],
  jobLogs: readonly RemoteJobLogLine[],
): RemoteJobLogLine[] {
  const out: RemoteJobLogLine[] = [];
  const seen = new Set<string>();
  for (const line of [...liveLogs, ...jobLogs]) {
    const key = `${line.at}\u0000${line.phase ?? ''}\u0000${line.stream ?? ''}\u0000${line.text ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

function extractRemoteAssistantText(logs: readonly RemoteJobLogLine[]): string {
  const stdout = logs
    .filter((line) => line.phase === 'model' && line.stream !== 'stderr' && line.text)
    .map((line) => line.text ?? '')
    .join('');
  if (!stdout.trim()) return '';
  const parsed = parseAgentJsonOutput(stdout);
  return clipRemoteFinalOutput(parsed || plainOutputFallback(stdout));
}

function extractRemoteModelError(logs: readonly RemoteJobLogLine[]): string {
  const stdout = logs
    .filter((line) => line.phase === 'model' && line.stream !== 'stderr' && line.text)
    .map((line) => line.text ?? '')
    .join('');
  let fallback = '';
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = stringValue(record.type);
    const message =
      type === 'turn.failed'
        ? stringValue(objectValue(record.error)?.message)
        : type === 'error'
          ? stringValue(record.message)
          : '';
    const clean = message.trim();
    if (!clean) continue;
    fallback = clean;
    if (!clean.toLowerCase().startsWith('reconnecting...')) return clean;
  }
  return fallback;
}

function remoteErrorTextForJob(
  job: RemoteJob,
  liveLogs: readonly RemoteJobLogLine[],
): string {
  const primary = job.error?.trim() ?? '';
  const detail = extractRemoteModelError(mergeRemoteLogs(liveLogs, job.logs));
  if (!primary && !detail) return '';
  if (!detail || primary.includes(detail)) return `\n\n错误：${primary}`;
  if (!primary) return `\n\n错误：${detail}`;
  return `\n\n错误：${primary}\n详细原因：${detail}`;
}

function remoteAssistantBlockForJob(
  job: RemoteJob,
  liveLogs: readonly RemoteJobLogLine[],
  liveMessages: readonly RemoteJobMessage[],
): string {
  if (job.status !== 'done') return '';
  const messageText = extractRemoteAssistantMessages(liveMessages, job.messages ?? []);
  const assistantText =
    messageText || extractRemoteAssistantText(mergeRemoteLogs(liveLogs, job.logs));
  if (!assistantText || outputLooksLikeProtocolNoise(assistantText)) return '';
  return `\n\n${assistantText}`;
}

function mergeRemoteMessages(
  liveMessages: readonly RemoteJobMessage[],
  jobMessages: readonly RemoteJobMessage[],
): RemoteJobMessage[] {
  const out: RemoteJobMessage[] = [];
  const seen = new Set<string>();
  for (const message of [...liveMessages, ...jobMessages]) {
    const key = `${message.at}\u0000${message.role}\u0000${message.kind}\u0000${message.text ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(message);
  }
  return out;
}

function extractRemoteAssistantMessages(
  liveMessages: readonly RemoteJobMessage[],
  jobMessages: readonly RemoteJobMessage[],
): string {
  const messages = mergeRemoteMessages(liveMessages, jobMessages)
    .filter((message) => message.role === 'assistant' && message.text)
    .map((message) => message.text ?? '');
  return clipRemoteFinalOutput(messages.join('').trim());
}

async function buildRemotePrompt(options: StartRemoteChatTurnOptions): Promise<string> {
  const assetCapabilityBlock = buildAssetCapabilityBlock({
    image: preferredReadyImageProviderId() != null,
    music: preferredReadyMusicProviderId() != null,
    threeD: preferredReadyThreeDProviderId() != null,
    video: preferredReadyVideoProviderId() != null,
    animation: preferredReadyAnimationProviderId() != null,
    speech: preferredReadySpeechProviderId() != null,
    sprite: preferredReadySpriteProviderId() != null,
  });
  const knowledgeContext = options.knowledgeBaseMode
    ? await renderKnowledgeBaseContextForPrompt({
        workspacePath: options.workspacePath,
        query: options.prompt,
      }).catch(() => '')
    : '';
  const system = [
    SIMPLE_CHAT_SYSTEM,
    // 远程 Claude Code CLI 同样会启动后台任务（p4 sync、长编译、whisper 等），
    // 必须带上后台任务硬规则，否则远端模型一样会"已启动就交差"。
    // 用 remote 专用版本：去掉本地 ugs-job 包装器说明（远端没有这个 CLI），
    // 只保留"后台任务不到终态不准结束回合"这条核心约束。
    REMOTE_BACKGROUND_JOB_INSTRUCTION,
    languageAdaptationPrompt(isLocale(options.locale) ? options.locale : 'zh-CN'),
    options.personalBlock,
    options.gameExpertBlock,
    assetCapabilityBlock,
    options.projectEngineGuidance,
    knowledgeContext,
    '\n你运行在云端项目工作区。可以修改该项目仓库；回答需总结改动、风险、验证。不要输出 workflow 蓝图。',
    // 与本地直聊对齐：云端工作区同样禁止把副产物散落在项目根目录。
    WORKSPACE_LAYOUT_DIRECTIVE,
  ].join('');
  const locale = isLocale(options.locale) ? options.locale : 'zh-CN';
  // Recency reminder: a long agentic remote run accumulates lots of English
  // tool output between the front-loaded system block and the actual
  // question, which dilutes it. Repeating a compact directive right after
  // the question (where models weight context most) measurably helps.
  return `${system}\n\n用户：${options.prompt}${languageDirectiveReminder(locale)}`;
}

function configuredProviderModels(
  providerId: string | null | undefined,
): string[] | null {
  const id = providerId?.trim();
  if (!id) return null;
  const provider = listProviders().find((item) => item.id === id);
  if (!provider) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [provider.model, ...(provider.models ?? [])]) {
    const model = raw?.trim();
    if (!model) continue;
    const key = model.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(model);
  }
  return out;
}

function remoteJobModelForSelection(
  config: RemoteWorkspaceConfig | null,
  selectedAccountId: string | undefined,
  providerId: string | null | undefined,
  gatewayModel: string | undefined,
  adapter: 'claude' | 'codex' | 'gemini' | undefined,
): string | undefined {
  const configModel = remoteJobModelForAdapter(adapter, config?.model);
  const selected = remoteJobModelForAdapter(adapter, gatewayModel);
  if (!selectedAccountId) return configModel;

  const rawProviderModels = configuredProviderModels(providerId);
  if (rawProviderModels === null) return selected ?? configModel;

  const providerModels = rawProviderModels
    .map((model) => remoteJobModelForAdapter(adapter, model))
    .filter((model): model is string => Boolean(model));
  if (providerModels.length === 0) return configModel;
  if (!selected) return configModel ?? providerModels[0];

  const known = providerModels.some(
    (model) => model.toLowerCase() === selected.toLowerCase(),
  );
  return known ? selected : configModel ?? providerModels[0];
}

/** 普通编程渠道的 provider.kind → 远程任务 adapter。 */
function providerKindToRemoteAdapter(
  kind: unknown,
): 'claude' | 'codex' | 'gemini' {
  if (kind === 'codex') return 'codex';
  if (kind === 'gemini') return 'gemini';
  return 'claude';
}

/**
 * 远程任务的渠道/模型解析。把当前会话选中的渠道归到三类之一：
 *   1. 绑定本工作区的 `remote-runner:` 服务端执行账号 —— 走 accountId，模型在
 *      账号自带模型集合内校验。
 *   2. 普通编程渠道（已随 /user-settings 同步到服务端，key 内联）—— 用该渠道的
 *      adapter + 选中模型，并把渠道自带的 key/baseUrl 按任务下发（服务端没有对应
 *      account，必须靠 per-job 凭证才能跑起来）。这是「设置/输入框选的渠道与模型」
 *      真正生效的路径。
 *   3. 系统默认 / 免费渠道 / 未选 —— 回退到项目配置的 adapter + model。
 */
interface ResolvedRemoteRoute {
  adapter: 'claude' | 'codex' | 'gemini';
  model: string | undefined;
  accountId: string | undefined;
  providerName: string | undefined;
  /** 普通同步渠道按任务下发的凭证；账号/默认路径下为 undefined。 */
  apiKey: string | undefined;
  baseUrl: string | undefined;
}

export function resolveRemoteRoute(
  config: RemoteWorkspaceConfig | null,
  workspaceId: string,
  selection: AiEditChannel['gatewaySelection'],
): ResolvedRemoteRoute {
  const remote = parseRemoteProviderId(selection?.providerId);
  const selectedAccountId =
    remote?.workspaceId === workspaceId ? remote.accountId : undefined;
  const gatewayModel =
    selection?.modelOverride?.trim() || selection?.modelClass?.trim();

  // 1) 服务端执行账号。
  if (selectedAccountId) {
    const adapter = remoteProviderAdapter(selection?.adapter);
    return {
      adapter,
      model: remoteJobModelForSelection(
        config,
        selectedAccountId,
        selection?.providerId,
        gatewayModel,
        adapter,
      ),
      accountId: selectedAccountId,
      providerName: providerDisplayName(selection?.providerId),
      apiKey: undefined,
      baseUrl: undefined,
    };
  }

  // 2) 普通编程渠道（同步到服务端，key 内联）。
  const provider = selection?.providerId
    ? listProviders().find((item) => item.id === selection.providerId)
    : undefined;
  if (provider && !isRemoteRunnerProvider(provider)) {
    const adapter = providerKindToRemoteAdapter(provider.kind);
    const selected = remoteJobModelForAdapter(adapter, gatewayModel);
    const fallback = remoteJobModelForAdapter(adapter, provider.model);
    const apiKey = provider.apiKey.trim();
    const baseUrl = provider.baseUrl.trim();
    return {
      adapter,
      model:
        selected ?? fallback ?? remoteJobModelForAdapter(adapter, config?.model),
      accountId: undefined,
      providerName: provider.name.trim() || undefined,
      apiKey: apiKey && apiKey !== 'remote-runner' ? apiKey : undefined,
      baseUrl: baseUrl || undefined,
    };
  }

  // 3) 系统默认 / 免费渠道 / 未选 —— 回退项目配置。
  const adapter = remoteProviderAdapter(config?.adapter);
  return {
    adapter,
    model: remoteJobModelForAdapter(adapter, config?.model),
    accountId: undefined,
    providerName: undefined,
    apiKey: undefined,
    baseUrl: undefined,
  };
}

export function startRemoteChatTurn(options: StartRemoteChatTurnOptions): void {
  const sourceSessionId = options.ch.sessionId;
  const sourceSessionKey = Object.freeze({ workspaceId: options.ch.workspaceId, sessionId: sourceSessionId });
  const sourceMessageId = options.sourceMessageId;
  const hasSource = typeof sourceSessionId === 'string' && sourceSessionId.length > 0 && sourceSessionId.length <= 200 &&
    typeof sourceMessageId === 'string' && sourceMessageId.length > 0 && sourceMessageId.length <= 200 &&
    options.ch.messages.some((message) => message.id === sourceMessageId && message.role === 'user');
  const sourceReady = options.ready;
  void sourceReady?.catch(() => {});
  const explicitSkillIds = options.explicitSkillIds ? [...options.explicitSkillIds] : undefined;
  const selection = options.ch.gatewaySelection ? { ...options.ch.gatewaySelection } : undefined;
  const userPrompt = options.prompt;
  const workspaceId = remoteWorkspaceIdFromPath(options.workspacePath);
  let config = getRemoteWorkspace(workspaceId);
  const secrets = readRemoteSecrets(workspaceId);
  const startedAt = Date.now();
  // 信息流头部先按当前选择估算渠道/模型；真正提交任务后再用解析出的模型刷新。
  const initialRoute = resolveRemoteRoute(
    config,
    workspaceId,
    options.ch.gatewaySelection,
  );
  let routeLabel = buildRemoteRouteLabel({
    config,
    adapter: initialRoute.adapter,
    providerName: initialRoute.providerName,
    model: initialRoute.model,
  });
  const messageId = shortId('m');
  let currentStatus: RemoteJobStatus = 'queued';
  let logText = '';
  let assistantText = '';
  let liveLogs: RemoteJobLogLine[] = [];
  let liveMessages: RemoteJobMessage[] = [];
  let unsubscribe: (() => void) | null = null;
  let finalJob: RemoteJob | null = null;
  let learningSource: Omit<FinishRemoteLearningOptions, 'finalAnswer'> | undefined;
  const releaseForeground = beginRemoteSkillForeground();
  const signal = options.ch.abortController.signal;
  let foregroundEnded = false;
  let submittedJob: { client: RunnerClient; id: string } | undefined;
  let cancellationSent = false;
  let settleForeground!: (job?: RemoteJob) => void;
  const foregroundDone = new Promise<RemoteJob | undefined>((resolve) => { settleForeground = resolve; });
  const cleanupForeground = () => {
    unsubscribe?.();
    signal.removeEventListener('abort', onAbort);
    releaseForeground();
  };
  const cancelSubmittedJob = () => {
    if (!submittedJob || cancellationSent) return;
    cancellationSent = true;
    void submittedJob.client.cancelJob(submittedJob.id).catch(() => {});
  };
  const onAbort = () => {
    if (foregroundEnded) return;
    foregroundEnded = true;
    cancelSubmittedJob();
    settleForeground();
  };

  const render = (body: string): string => {
    const elapsed = `${options.formatClock(startedAt)} → ${options.formatClock(Date.now())} · 耗时 ${options.formatDuration(Date.now() - startedAt)}`;
    return `⏱ ${elapsed}\n⚙ 路由：${routeLabel}\n${body}`;
  };
  const setMessage = (text: string, persist: boolean, usage?: Message['usage']) => {
    options.ch.messages = options.ch.messages.map((message) =>
      message.id === messageId
        ? {
            ...message,
            text,
            routeLabel,
            ...(usage ? { usage } : {}),
          }
        : message,
    );
    options.aiEditCommitMessages(options.ch, persist);
  };
  const appendLog = (line: RemoteJobLogLine) => {
    liveLogs = [...liveLogs, line];
    const text = compactLog(line);
    if (!text) return;
    logText = appendRemoteLogText(logText, text);
    const assistantBlock = assistantText.trim()
      ? `\n\n${clipRemoteFinalOutput(assistantText)}`
      : '';
    setMessage(
      render(`⟳ ${statusLabel(currentStatus)}…${assistantBlock}\n\n${logText}`),
      false,
    );
  };
  const appendRemoteMessage = (message: RemoteJobMessage) => {
    liveMessages = [...liveMessages, message];
    if (message.role === 'assistant' && message.text) {
      if (message.kind === 'final') assistantText = message.text.trim();
      else assistantText = `${assistantText}${message.text}`;
    } else if ((message.role === 'tool' || message.role === 'system') && message.text) {
      const text = remoteMessageLogText(message, `remote-${message.at}-${liveMessages.length}`);
      if (text) logText = appendRemoteLogText(logText, text);
    }
    const assistantBlock = assistantText.trim()
      ? `\n\n${clipRemoteFinalOutput(assistantText)}`
      : '';
    setMessage(
      render(`⟳ ${statusLabel(currentStatus)}…${assistantBlock}${logText ? `\n\n${logText}` : ''}`),
      false,
    );
  };
  const finish = (job: RemoteJob) => {
    if (foregroundEnded || finalJob || !TERMINAL_STATUSES.has(job.status)) return;
    foregroundEnded = true;
    finalJob = job;
    try {
    const status = job.status;
    const patch = job.result?.patch?.trim();
    const pushed = job.result?.pushed
      ? `\n\n已推送分支：${job.result.pushBranch ?? config?.pushBranch ?? ''}`
      : '';
    const patchBlock = patch ? fencedBlock(patch, 'diff') : '';
    const error = remoteErrorTextForJob(job, liveLogs);
    const assistantBlock = remoteAssistantBlockForJob(job, liveLogs, liveMessages);
    // A failed job may still have edited files; label the diff as a partial
    // result rather than presenting it as a clean change set.
    const patchSection =
      patch && status !== 'done' ? `\n\n（任务未成功，以下为当前改动）${patchBlock}` : patchBlock;
    const visibleBody =
      status === 'done'
        ? `✓ 远程任务完成${assistantBlock}${pushed}${patchBlock}`
        : `✗ 远程任务${status === 'canceled' ? '已取消' : '失败'}${error}${assistantBlock}${patchSection}`;
    const body = `${remoteSessionFileSentinelsForJob(job)}${visibleBody}`;
    setMessage(
      render(closeRunningRemoteToolCards(body, status === 'done' ? 'done' : 'error')),
      true,
      remoteUsage(job),
    );
    notifyRemoteWorkspaceFilesUpdated({
      workspaceId,
      workspacePath: options.workspacePath,
      projectId: job.projectId ?? config?.projectId ?? null,
      jobId: job.id,
    });
    options.commitAiChannelBlueprint(
      options.ch,
      options.appendStartUserInputs(options.ch.workflow, [options.prompt]),
    );
    options.syncAndPersistSessionRunStatus(
      sourceSessionKey,
      finalStatus(status),
    );
    options.removeAiEditChannel(options.ch);
    } finally {
      settleForeground(job);
    }
  };
  const fail = (err: unknown) => {
    if (foregroundEnded) return;
    foregroundEnded = true;
    try {
      const msg = err instanceof Error ? err.message : String(err);
      setMessage(render(`✗ 远程任务启动失败：${msg}`), true);
      options.syncAndPersistSessionRunStatus(sourceSessionKey, 'error');
      options.removeAiEditChannel(options.ch);
    } finally {
      cancelSubmittedJob();
      settleForeground();
    }
  };

  signal.addEventListener('abort', onAbort, { once: true });
  void (async () => {
    let job: RemoteJob | undefined;
    try { job = await foregroundDone; }
    finally { cleanupForeground(); }
    if (learningSource && job && !signal.aborted) {
      await finishRemoteLearning({ ...learningSource,
        finalAnswer: extractRemoteAssistantMessages(liveMessages, job.messages ?? []) });
    }
  })().catch(() => {
    // Learning is advisory and must not rewrite the actual task result.
  });
  if (signal.aborted) { onAbort(); return; }

  options.ch.messages = [
    ...options.ch.messages,
    {
      id: messageId,
      role: 'assistant',
      text: render('⟳ 正在提交远程任务…'),
      routeLabel,
      createdAt: startedAt,
    },
  ];
  options.ch.ownedMessageIds?.add(messageId);
  options.aiEditCommitMessages(options.ch, false);

  void (async () => {
    if (!config) throw new Error('云端项目不存在。');
    const connection = await resolveRemoteRunnerConnectionAsync(config);
    if (foregroundEnded) return;
    if (!connection) throw new Error('云端服务未配置。请先配置服务器地址和访问 Token。');
    const client = new RunnerClient(connection.serverUrl, connection.token);
    if (config.projectId || config.repoUrl) {
      config = await ensureRemoteWorkspaceProject(config, client);
    }
    if (foregroundEnded) return;
    // config 可能在上面被 ensureRemoteWorkspaceProject 补全过，按最新 config 重解。
    const route = resolveRemoteRoute(
      config,
      workspaceId,
      selection,
    );
    // Pre-task receipts stay scoped to this read-only run; the review reads anew.
    let skillContext: LoadedSkillContext = { prompt: userPrompt, loadedSkills: [], catalogRevision: '' };
    const skillSource = hasSource && sourceReady
      ? Object.freeze({ sessionId: sourceSessionId, turnId: sourceMessageId }) : undefined;
    if (explicitSkillIds?.length && (!skillSource || !config.projectId)) throw new Error('REMOTE_SKILL_SOURCE_UNAVAILABLE');
    if (skillSource && config.projectId) {
      await sourceReady;
      if (foregroundEnded) return;
      const prelaunchOrigin: SkillOrigin = Object.freeze({ hostId: REMOTE_SKILL_HOST_ID,
        workspaceId: config.projectId, ...skillSource, runId: shortId('skill-prelaunch') });
      try {
        skillContext = await requestRemoteContext({ client, projectId: config.projectId,
          origin: prelaunchOrigin, prompt: userPrompt, explicitSkillIds, signal: options.ch.abortController.signal });
      } catch (error) {
        if (explicitSkillIds?.length || options.ch.abortController.signal.aborted) throw error;
        // Automatic reuse is advisory; a failed read never supplies partial context.
      }
    }
    if (foregroundEnded) return;
    // 用最终解析出的渠道/模型刷新头部路由标签。
    routeLabel = buildRemoteRouteLabel({
      config,
      adapter: route.adapter,
      providerName: route.providerName,
      model: route.model,
    });
    const prompt = await buildRemotePrompt({ ...options, prompt: skillContext.prompt });
    await sourceReady;
    if (foregroundEnded) return;
    const job = await client.createJob({
      prompt,
      projectId: config.projectId,
      ...(skillSource ? { skillSource } : {}),
      repoUrl: config.projectId ? undefined : config.repoUrl,
      branch: config.branch,
      adapter: route.adapter,
      model: route.model === 'default' ? undefined : route.model,
      pushBranch: config.pushBranch,
      accountId: route.accountId,
      // 普通同步渠道：用渠道自带的 key/baseUrl 按任务下发（服务端无对应 account）。
      // 否则沿用项目「使用自己的模型 Key」设置。
      apiKey: route.apiKey ?? (config.useOwnModelKey ? secrets.apiKey : undefined),
      baseUrl:
        route.baseUrl ?? (config.useOwnModelKey ? secrets.baseUrl : undefined),
      gitToken: config.projectId ? undefined : secrets.gitToken,
    });
    submittedJob = { client, id: job.id };
    if (foregroundEnded) { cancelSubmittedJob(); return; }
    if (skillSource && config.projectId) {
      const expectedOrigin: SkillOrigin = { hostId: REMOTE_SKILL_HOST_ID,
        workspaceId: config.projectId, ...skillSource, runId: job.id };
      if (job.projectId !== config.projectId || !job.skillOrigin || Object.keys(job.skillOrigin).length !== 5 ||
        Object.entries(expectedOrigin).some(([key, value]) => job.skillOrigin![key as keyof SkillOrigin] !== value)) {
        throw new Error('REMOTE_SKILL_JOB_ORIGIN_MISMATCH');
      }
      if (options.onSkillContext) {
        const sourceSession = Object.freeze({ workspaceId: sourceSessionKey.workspaceId!, sessionId: sourceSessionId!, serverUrl: client.serverUrl });
        await options.onSkillContext({ origin: structuredClone(job.skillOrigin), sourceSession,
          loadedSkills: structuredClone(skillContext.loadedSkills), catalogRevision: skillContext.catalogRevision });
        if (foregroundEnded) return;
        learningSource = { client, projectId: config.projectId, origin: Object.freeze({ ...job.skillOrigin }),
          userText: userPrompt, loadedSkills: structuredClone(skillContext.loadedSkills), selection,
          signal: options.ch.abortController.signal,
          onState: (state) => options.onSkillReviewState?.({ ...structuredClone(state), sourceSession: { ...sourceSession } }) };
      }
    }
    currentStatus = job.status;
    setMessage(render(`⟳ ${statusLabel(job.status)}…\n任务 ID：${job.id}`), true);
    unsubscribe = client.streamJob(job.id, {
      onLog: appendLog,
      onMessage: appendRemoteMessage,
      onStatus: (status) => {
        currentStatus = status;
        if (!TERMINAL_STATUSES.has(status)) {
          const assistantBlock = assistantText.trim()
            ? `\n\n${clipRemoteFinalOutput(assistantText)}`
            : '';
          setMessage(
            render(`⟳ ${statusLabel(status)}…${assistantBlock}${logText ? `\n\n${logText}` : ''}`),
            false,
          );
        }
      },
      onResult: finish,
      onError: fail,
      onClose: () => {
        if (foregroundEnded) return;
        // EOF is not a task result. Read the exact submitted job once; do not
        // resubmit, poll or infer success from a terminal status event alone.
        const lookup = new AbortController();
        const timeout = globalThis.setTimeout(() => {
          stopLookup();
          fail(new Error('远程事件流已结束，读取任务终态超时。'));
        }, 10_000);
        const cleanupLookup = () => {
          globalThis.clearTimeout(timeout);
          signal.removeEventListener('abort', stopLookup);
        };
        const stopLookup = () => { lookup.abort(); cleanupLookup(); };
        signal.addEventListener('abort', stopLookup, { once: true });
        void (async () => {
          try {
            const savedJob = await client.getJob(job.id, { signal: lookup.signal });
            if (foregroundEnded) return;
            if (savedJob.id !== job.id || !TERMINAL_STATUSES.has(savedJob.status)) {
              fail(new Error('远程事件流已结束，但未取得该任务的终态；请检查服务端任务记录。'));
              return;
            }
            finish(savedJob);
          } catch (error) {
            if (!foregroundEnded) fail(error);
          } finally { cleanupLookup(); }
        })().catch(() => {
          // Observer failures must not retain the already-settled foreground.
        });
      },
    });

  })().catch(fail);
}
