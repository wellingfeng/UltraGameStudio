import { SIMPLE_CHAT_SYSTEM, buildAssetCapabilityBlock } from '@/lib/anthropic';
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
  listProviders,
} from '@/lib/apiConfig';
import {
  getRemoteWorkspace,
  ensureRemoteWorkspaceProject,
  notifyRemoteWorkspaceFilesUpdated,
  parseRemoteProviderId,
  readRemoteSecrets,
  resolveRemoteRunnerConnection,
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
import { REMOTE_JOB_TERMINAL_STATUSES } from '@ugs/protocol';
import {
  encodeToolPatch,
  extractToolSentinels,
  mergeToolPatches,
  type ToolStatus,
} from '@/components/ai/lib/toolEvent';

export interface StartRemoteChatTurnOptions {
  ch: AiEditChannel;
  prompt: string;
  workspacePath: string;
  locale: string;
  projectEngineGuidance: string;
  personalBlock: string;
  gameExpertBlock: string;
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

const CLAUDE_TIER_ALIASES = new Set(['haiku', 'sonnet', 'opus']);

function remoteJobModelForAdapter(
  adapter: 'claude' | 'codex' | 'gemini' | undefined,
  model: string | null | undefined,
): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;
  if (
    adapter &&
    adapter !== 'claude' &&
    CLAUDE_TIER_ALIASES.has(trimmed.toLowerCase())
  ) {
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

function buildRemotePrompt(options: StartRemoteChatTurnOptions): string {
  const assetCapabilityBlock = buildAssetCapabilityBlock({
    image: preferredReadyImageProviderId() != null,
    music: preferredReadyMusicProviderId() != null,
    threeD: preferredReadyThreeDProviderId() != null,
    video: preferredReadyVideoProviderId() != null,
    speech: preferredReadySpeechProviderId() != null,
    sprite: preferredReadySpriteProviderId() != null,
  });
  const system = [
    SIMPLE_CHAT_SYSTEM,
    options.locale === 'zh-CN'
      ? '\n除非用户明确要求换用其他语言，所有面向用户的说明必须用简体中文。'
      : '',
    options.personalBlock,
    options.gameExpertBlock,
    assetCapabilityBlock,
    options.projectEngineGuidance,
    '\n你运行在云端项目工作区。可以修改该项目仓库；回答需总结改动、风险、验证。不要输出 workflow 蓝图。',
  ].join('');
  return `${system}\n\n用户：${options.prompt}`;
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

export function startRemoteChatTurn(options: StartRemoteChatTurnOptions): void {
  const workspaceId = remoteWorkspaceIdFromPath(options.workspacePath);
  let config = getRemoteWorkspace(workspaceId);
  const secrets = readRemoteSecrets(workspaceId);
  const remoteProvider = parseRemoteProviderId(options.ch.gatewaySelection?.providerId);
  const selectedAccountId =
    remoteProvider?.workspaceId === workspaceId ? remoteProvider.accountId : undefined;
  const gatewayModel =
    options.ch.gatewaySelection?.modelOverride?.trim()
    || options.ch.gatewaySelection?.modelClass?.trim();
  const startedAt = Date.now();
  const routeLabel = config ? `云端项目 · ${config.label}` : '云端项目';
  const messageId = shortId('m');
  let currentStatus: RemoteJobStatus = 'queued';
  let logText = '';
  let assistantText = '';
  let liveLogs: RemoteJobLogLine[] = [];
  let liveMessages: RemoteJobMessage[] = [];
  let unsubscribe: (() => void) | null = null;
  let finalJob: RemoteJob | null = null;

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
    finalJob = job;
    unsubscribe?.();
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
      { workspaceId: options.ch.workspaceId, sessionId: options.ch.sessionId },
      finalStatus(status),
    );
    options.removeAiEditChannel(options.ch);
  };
  const fail = (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    setMessage(render(`✗ 远程任务启动失败：${msg}`), true);
    options.syncAndPersistSessionRunStatus(
      { workspaceId: options.ch.workspaceId, sessionId: options.ch.sessionId },
      'error',
    );
    options.removeAiEditChannel(options.ch);
  };

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
    const connection = resolveRemoteRunnerConnection(config);
    if (!connection) throw new Error('云端服务未配置。请先配置服务器地址和访问 Token。');
    const client = new RunnerClient(connection.serverUrl, connection.token);
    if (config.projectId || config.repoUrl) {
      config = await ensureRemoteWorkspaceProject(config, client);
    }
    const jobAdapter = selectedAccountId
      ? remoteProviderAdapter(options.ch.gatewaySelection?.adapter)
      : config.adapter;
    const selectedModel = remoteJobModelForSelection(
      config,
      selectedAccountId,
      options.ch.gatewaySelection?.providerId,
      gatewayModel,
      jobAdapter,
    );
    const job = await client.createJob({
      prompt: buildRemotePrompt(options),
      projectId: config.projectId,
      repoUrl: config.projectId ? undefined : config.repoUrl,
      branch: config.branch,
      adapter: jobAdapter,
      model: selectedModel === 'default' ? undefined : selectedModel,
      pushBranch: config.pushBranch,
      accountId: selectedAccountId,
      apiKey: config.useOwnModelKey ? secrets.apiKey : undefined,
      baseUrl: config.useOwnModelKey ? secrets.baseUrl : undefined,
      gitToken: config.projectId ? undefined : secrets.gitToken,
    });
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
    });
    options.ch.abortController.signal.addEventListener(
      'abort',
      () => {
        if (finalJob) return;
        void client.cancelJob(job.id).catch(() => {});
      },
      { once: true },
    );
  })().catch(fail);
}
