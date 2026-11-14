/** Complete approval batches bound to their original exact target. Unknown reads fail closed. */
import { normalizeMemoryRequests } from '@/core/memoryProtocol';
import { applyMemoryBatch, readMemoryBase, type MemoryBase, type MemoryOp, type MemoryTarget } from './memoryStore';
import { checkMemoryCancelled, compareExchangeMemoryJson, readMemoryJson, withMemoryLock } from './memoryTransactions';
import { readPersistedSkillSourceSession } from './skills';
import type { Message } from '@/store/types';

const REL_PATH = 'memories/pending.json';
export type MemoryWriteSource = 'review' | 'refresh';
export interface MemoryReviewSource {
  hostId: string; namespaceId: string; workspaceId: string; sessionId: string;
  turnId: string; sourceMessageId: string; runId: string; cwd?: string;
}
export interface PendingMemoryWrite {
  id: string;
  target: MemoryTarget;
  /** Compatibility preview ONLY. Approval always executes operations in full. */
  op: MemoryOp;
  operations: MemoryOp[];
  source: MemoryWriteSource;
  proposedAt: number;
  workspaceId?: string;
  reviewSource?: MemoryReviewSource;
  sourceConfirmation?: MemorySourceConfirmation;
  base?: MemoryBase;
  status: 'awaiting_approval' | 'needs_source_confirmation' | 'needs_base_confirmation';
}
interface PendingFile { version: 2; writes: PendingMemoryWrite[]; raw: string | null }
export interface PendingBatchContext {
  signal?: AbortSignal;
  reviewSource?: MemoryReviewSource;
  bases?: Partial<Record<MemoryTarget, MemoryBase>>;
}
const makeId = () => `pw_${crypto.randomUUID()}`;
export interface MemorySourceLocator { workspaceId: string; sessionId: string; sourceMessageId: string }
export interface MemorySourceConfirmation extends MemorySourceLocator {
  provenance: 'user_confirmed_rebinding'; legacyId: string; confirmedAt: number; message: Message;
}
export interface PendingMemoryConfirmationPreview {
  queueRaw: string | null; batch: PendingMemoryWrite; base: MemoryBase;
  source: MemorySourceLocator & { message: Message };
}
async function readConfirmationSource(locator: MemorySourceLocator): Promise<MemorySourceLocator & { message: Message }> {
  const record = await readPersistedSkillSourceSession(locator.workspaceId, locator.sessionId);
  const matches = record?.messages.filter((message) => message.id === locator.sourceMessageId) ?? [];
  if (!record || record.workspaceId !== locator.workspaceId || (record.sessionId ?? record.id) !== locator.sessionId || record.deletedAt ||
      matches.length !== 1 || matches[0].role !== 'user' || typeof matches[0].text !== 'string') throw new Error('Original user source is not persisted');
  return { ...locator, message: structuredClone(matches[0]) };
}
/** A user rebinding is a new proposal, never proof of the missing legacy provenance. */
export async function preparePendingMemoryConfirmation(id: string, locator: MemorySourceLocator): Promise<PendingMemoryConfirmationPreview> {
  const selected = { workspaceId: locator.workspaceId, sessionId: locator.sessionId, sourceMessageId: locator.sourceMessageId };
  const file = await readPending();
  const batch = file.writes.find((entry) => entry.id === id);
  if (!batch || batch.status === 'awaiting_approval') throw new Error('Legacy proposal is unavailable');
  const knownWorkspace = batch.workspaceId ?? batch.reviewSource?.workspaceId;
  if (knownWorkspace !== undefined && knownWorkspace !== selected.workspaceId) throw new Error('Original workspace mismatch');
  const source = await readConfirmationSource(selected);
  const base = await readMemoryBase(batch.target, batch.target === 'memory' ? selected.workspaceId : undefined);
  return { queueRaw: file.raw, batch: structuredClone(batch), base, source };
}
export async function confirmPendingMemorySource(preview: PendingMemoryConfirmationPreview, explicitConfirmation: boolean): Promise<PendingMemoryWrite> {
  const frozen = structuredClone(preview);
  if (explicitConfirmation !== true) throw new Error('Explicit whole-batch/source/base confirmation required');
  return withMemoryLock(REL_PATH, async () => {
    const fresh = await preparePendingMemoryConfirmation(frozen.batch.id, frozen.source);
    if (fresh.queueRaw !== frozen.queueRaw || JSON.stringify(fresh.batch) !== JSON.stringify(frozen.batch) ||
        fresh.base.raw !== frozen.base.raw || JSON.stringify(fresh.source) !== JSON.stringify(frozen.source)) throw new Error('Memory confirmation CAS conflict: source, queue or base changed');
    const rebuilt: PendingMemoryWrite = { ...fresh.batch, id: makeId(), proposedAt: Date.now(), status: 'awaiting_approval',
      workspaceId: fresh.batch.target === 'memory' ? fresh.source.workspaceId : undefined, base: fresh.base,
      sourceConfirmation: { ...fresh.source, provenance: 'user_confirmed_rebinding', legacyId: fresh.batch.id, confirmedAt: Date.now() } };
    const file = await readPending();
    if (file.raw !== fresh.queueRaw) throw new Error('Memory confirmation queue CAS conflict');
    await writePending(file.writes.map((entry) => entry.id === fresh.batch.id ? rebuilt : entry), file.raw);
    return rebuilt;
  });
}

async function readPending(): Promise<PendingFile> {
  const raw = await readMemoryJson(REL_PATH);
  if (raw === null) return { version: 2, writes: [], raw };
  const parsed = JSON.parse(raw);
  if (!parsed || ![1, 2].includes(parsed.version) || !Array.isArray(parsed.writes)) {
    throw new Error('Unknown pending JSON; refusing overwrite');
  }
  const seen = new Set<string>();
  const writes = parsed.writes.map((value: PendingMemoryWrite): PendingMemoryWrite => {
    if (!value || typeof value.id !== 'string' || !value.id || seen.has(value.id) ||
        !Number.isFinite(value.proposedAt) || !['review', 'refresh'].includes(value.source)) {
      throw new Error('Invalid pending identity; refusing partial queue');
    }
    seen.add(value.id);
    if (value.workspaceId !== undefined && typeof value.workspaceId !== 'string') throw new Error('Invalid pending workspace identity');
    const requests = normalizeMemoryRequests([{ target: value.target, operations: parsed.version === 1 ? [value.op] : value.operations }]);
    if (!requests) throw new Error('Invalid pending batch; refusing partial queue');
    const operations = requests[0].operations;
    if (parsed.version === 1) return {
      id: value.id, target: value.target, source: value.source, proposedAt: value.proposedAt,
      op: operations[0], operations, ...(value.workspaceId !== undefined ? { workspaceId: value.workspaceId } : {}),
      status: value.target === 'memory' ? 'needs_source_confirmation' : 'needs_base_confirmation',
    };
    if (!['awaiting_approval', 'needs_source_confirmation', 'needs_base_confirmation'].includes(value.status)) {
      throw new Error('Invalid pending state');
    }
    if (value.status === 'awaiting_approval' && (!value.base || value.base.target !== value.target ||
        (value.target === 'memory' && value.base.workspaceId !== value.workspaceId) ||
        (value.base.raw !== null && typeof value.base.raw !== 'string') || !Array.isArray(value.base.entries))) {
      throw new Error('Invalid pending exact base');
    }
    return { ...value, op: operations[0], operations };
  });
  return { version: 2, writes, raw };
}

async function writePending(writes: PendingMemoryWrite[], expectedRaw: string | null, signal?: AbortSignal): Promise<void> {
  await compareExchangeMemoryJson(REL_PATH, expectedRaw, JSON.stringify({ version: 2, writes }, null, 2), signal);
}
export async function listPendingMemoryWrites(): Promise<PendingMemoryWrite[]> {
  return (await readPending()).writes.sort((a, b) => a.proposedAt - b.proposedAt);
}
export async function countPendingMemoryWrites(): Promise<number> { return (await readPending()).writes.length; }

/** Validates the entire payload; user/project are explicitly separate atomic batches. */
export async function queuePendingMemoryWrites(
  writes: { target: MemoryTarget; operations: MemoryOp[] }[],
  source: MemoryWriteSource,
  workspaceId?: string,
  context?: PendingBatchContext,
): Promise<number> {
  const requests = normalizeMemoryRequests(writes);
  if (!requests) throw new Error('Invalid memory proposal payload');
  // Freeze caller-owned objects before the first await. Model output never supplies identity.
  const signal = context?.signal;
  const frozen: Pick<PendingBatchContext, 'reviewSource' | 'bases'> = context ? structuredClone({ reviewSource: context.reviewSource, bases: context.bases }) : {};
  checkMemoryCancelled(signal);
  if (frozen.reviewSource && frozen.reviewSource.workspaceId !== (workspaceId ?? '')) {
    throw new Error('Memory source/workspace mismatch');
  }
  const batches: Omit<PendingMemoryWrite, 'id' | 'proposedAt'>[] = [];
  for (const target of ['user', 'memory'] as const) {
    const operations = requests.filter((req) => req.target === target).flatMap((req) => req.operations);
    if (!operations.length) continue;
    const ws = target === 'memory' ? workspaceId : undefined;
    const base = frozen.bases?.[target] ?? await readMemoryBase(target, ws);
    if (base.target !== target || (target === 'memory' && base.workspaceId !== ws)) throw new Error('Memory base/target mismatch');
    batches.push({ target, operations, op: operations[0], source, workspaceId: ws,
      reviewSource: frozen.reviewSource, base, status: 'awaiting_approval' });
  }
  const added = await withMemoryLock(REL_PATH, async () => {
    checkMemoryCancelled(signal);
    const file = await readPending();
    checkMemoryCancelled(signal);
    let count = 0;
    for (const batch of batches) {
      if (file.writes.some((w) => w.status === 'awaiting_approval' && w.target === batch.target &&
          w.workspaceId === batch.workspaceId && w.source === source && w.base?.raw === batch.base?.raw &&
          JSON.stringify(w.operations) === JSON.stringify(batch.operations))) continue;
      file.writes.push({ ...batch, id: makeId(), proposedAt: Date.now() });
      count += batch.operations.length;
    }
    if (count) await writePending(file.writes, file.raw, signal);
    return count;
  });
  if (added) scheduleAutoTriage();
  return added;
}

export interface PendingResolution {
  resolvedIds: string[];
  outcomes: { id: string; status: 'applied' | 'skipped' | 'rejected' | 'conflicted' | 'failed' | 'needs_source_confirmation'; appliedCount: number; skippedCount: number; error?: string }[];
}

/** Current page workspace is ignored. Only confirmed whole batches may leave the queue. */
export async function resolvePendingMemoryWrites(
  ids: string[], action: 'approve' | 'reject', _currentWorkspaceId?: string,
  opts?: { evictOnOverflow?: boolean; safetyScan?: 'reject' | 'skip' | 'off' },
): Promise<PendingResolution> {
  return withMemoryLock(REL_PATH, async () => {
    const file = await readPending();
    const result: PendingResolution = { resolvedIds: [], outcomes: [] };
    for (const w of file.writes.filter((w) => ids.includes(w.id))) {
      if (action === 'reject') {
        result.resolvedIds.push(w.id);
        result.outcomes.push({ id: w.id, status: 'rejected', appliedCount: 0, skippedCount: 0 });
        continue;
      }
      if (w.status !== 'awaiting_approval' || !w.base) {
        result.outcomes.push({ id: w.id, status: 'needs_source_confirmation', appliedCount: 0, skippedCount: 0,
          error: 'Legacy proposal requires explicit source/base confirmation; current workspace is not a source' });
        continue;
      }
      // No approval bypass for hard safety findings. No hidden destructive eviction.
      try {
        const applied = await applyMemoryBatch(w.target, w.operations, w.workspaceId,
          { expectedRaw: w.base.raw, rebaseUnchangedTargets: true, transactionId: w.id, reviewSource: w.reviewSource, sourceConfirmation: w.sourceConfirmation, evictOnOverflow: false, safetyScan: 'reject' });
        const skippedCount = applied.skippedCount ?? applied.skipped?.length ?? 0;
        const appliedCount = applied.success ? (applied.appliedCount ?? w.operations.length - skippedCount) : 0;
        result.outcomes.push({ id: w.id, status: applied.success ? (appliedCount ? 'applied' : 'skipped') :
          /conflict/i.test(applied.error ?? '') ? 'conflicted' : 'failed', appliedCount, skippedCount, error: applied.error });
        if (applied.success) result.resolvedIds.push(w.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.outcomes.push({ id: w.id, status: /conflict/i.test(message) ? 'conflicted' : 'failed', appliedCount: 0, skippedCount: 0, error: message });
      }
    }
    // All applied results have passed target readback before this queue CAS.
    if (result.resolvedIds.length) await writePending(file.writes.filter((w) => !result.resolvedIds.includes(w.id)), file.raw);
    void opts; // retained for callers; approval does not widen frozen policy
    return result;
  });
}

/**
 * Render one queued write as a single review line for the triage model.
 * Kept terse: the model sees many of these and only judges keep/drop.
 */
export function formatPendingForTriage(w: PendingMemoryWrite): string {
  // JSON quoting prevents entry content masquerading as another proposal ID.
  return JSON.stringify({ id: w.id, target: w.target, workspaceId: w.workspaceId ?? null,
    source: w.reviewSource ?? null, status: w.status, operations: w.operations });
}

/** System prompt for the AI pre-screen pass over the pending queue. */
export const TRIAGE_SYSTEM =
  '你是长期记忆的「预审批员」，标准严格。下面给你一批待人工审批的记忆写入提案。' +
  '你的任务：替用户先做一轮严格筛查——默认拒绝（drop），只有真正值得跨会话保存的条目才放行（keep），' +
  '让用户终审时看到的每一条都有明确价值。\n\n' +
  '必须拒绝的（drop）：\n' +
  '- 环境型失败（缺二进制、命令找不到、未装依赖、未配置凭据）。\n' +
  '- 对工具/功能的负面断言（"X 坏了""无法 Y"）。\n' +
  '- 会话内已解决的临时错误、一次性任务叙述、过程流水账。\n' +
  '- 琐碎、零碎的片段：单一命令片段、单个参数名、可从代码/git 历史随手重新发现的事实。\n' +
  '- 空泛、无信息量的条目（"用户很忙""项目很重要""要认真"这类）。\n' +
  '- 信息密度低、只值半句话的条目——这类应已在审阅阶段被合并，漏到这里就拒绝。\n\n' +
  '可以保留的（keep），必须同时满足：\n' +
  '- 内容具体、信息密度高，一句话说清一个事实；AND\n' +
  '- 属于：用户的身份/偏好/明确纠正/沟通风格，或项目引擎/约定/资源目录/工具链怪癖/踩过的坑等稳定事实；AND\n' +
  '- 跨会话仍然有用，一个月后看到仍值得执行。\n\n' +
  '拿不准时倾向拒绝——漏掉一条事实的代价远低于让用户审批一堆垃圾的代价。' +
  '只有当某条目明显独特、具体、可执行时才放行。\n\n' +
  '只输出一个 JSON 对象，不要任何解释、不要代码块标记：\n' +
  '{"drop":["要拒绝的提案id",...],"keep":["要保留的提案id",...]}\n' +
  '每个提案 id 必须恰好出现一次（要么在 drop 要么在 keep），不要遗漏、不要新增 id。';

/** Build the triage user prompt from the current queue. */
export function buildTriageUserPrompt(writes: PendingMemoryWrite[]): string {
  const lines = writes.map(formatPendingForTriage);
  return `以下是 ${writes.length} 条待审批记忆写入，请按系统指令筛查：\n\n${lines.join('\n')}`;
}

/** Parse the triage model's JSON verdict; returns null on any malformed output. */
export function parseTriageVerdict(
  raw: string,
  validIds: Set<string>,
): { drop: string[]; keep: string[] } | null {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (Object.keys(obj).some((key) => key !== 'drop' && key !== 'keep')) return null;
  if (!Array.isArray(obj.drop) || !Array.isArray(obj.keep)) return null;
  if ([...obj.drop, ...obj.keep].some((id) => typeof id !== 'string')) return null;
  const drop = obj.drop as string[];
  const keep = obj.keep as string[];
  const seen = new Set<string>();
  for (const id of [...drop, ...keep]) {
    if (!validIds.has(id) || seen.has(id)) return null; // unknown or duplicated id → distrust
    seen.add(id);
  }
  return seen.size === validIds.size ? { drop, keep } : null;
}

/**
 * Run one AI triage pass over the queue: the model judges every pending write
 * keep/drop, drops are REJECTED (removed, never applied), keeps stay queued for
 * the human's final pass. Conservative by construction — the triage prompt
 * tells the model to keep anything uncertain, and this function rejects the
 * whole verdict (dropping nothing) unless every queued id is accounted for.
 *
 * Returns counts for the settings panel to report.
 */
export async function triagePendingMemoryWrites(
  invokeModel: (system: string, userContent: string) => Promise<string>,
  options: { signal?: AbortSignal } = {},
): Promise<{ total: number; dropped: number; kept: number; verdictOk: boolean }> {
  const signal = options.signal;
  checkMemoryCancelled(signal);
  const snapshot = await readPending();
  const writes = snapshot.writes;
  if (!writes.length) return { total: 0, dropped: 0, kept: 0, verdictOk: true };
  const validIds = new Set(writes.map((w) => w.id));

  let verdict: { drop: string[]; keep: string[] } | null = null;
  try {
    checkMemoryCancelled(signal);
    const out = await invokeModel(TRIAGE_SYSTEM, buildTriageUserPrompt(writes));
    checkMemoryCancelled(signal);
    verdict = parseTriageVerdict(out, validIds);
  } catch {
    checkMemoryCancelled(signal);
    verdict = null;
  }
  // Unparseable / incomplete verdict → drop nothing, keep everything.
  if (!verdict) {
    return { total: writes.length, dropped: 0, kept: writes.length, verdictOk: false };
  }
  const trusted = verdict;
  const confirmed = await withMemoryLock(REL_PATH, async () => {
    checkMemoryCancelled(signal);
    const current = await readPending();
    if (current.raw !== snapshot.raw) return false;
    if (trusted.drop.length) await writePending(current.writes.filter((write) => !trusted.drop.includes(write.id)), current.raw, signal);
    return true;
  });
  if (!confirmed) return { total: writes.length, dropped: 0, kept: writes.length, verdictOk: false };
  return { total: writes.length, dropped: verdict.drop.length, kept: verdict.keep.length, verdictOk: true };
}

// --- auto-triage -------------------------------------------------------------
// The pending queue is populated by background review (useStore) and manual
// refresh (memoryRefresh) — two separate call sites. Rather than threading a
// triage hook through both, `queuePendingMemoryWrites` schedules a triage pass
// itself (debounced, fire-and-forget) whenever new writes land while the user's
// config opts in. The user then only ever sees what survived the AI pass.

const AUTO_TRIAGE_DEBOUNCE_MS = 2000;
let autoTriageTimer: ReturnType<typeof setTimeout> | null = null;
let autoTriageRunning = false;
let autoTriageAgain = false;

async function runAutoTriage(): Promise<void> {
  if (autoTriageRunning) {
    autoTriageAgain = true;
    return;
  }
  autoTriageRunning = true;
  try {
    do {
      autoTriageAgain = false;
      const { loadMemoryConfig } = await import('./memoryConfig');
      const { makeReviewInvoker, completeReview } = await import('./memoryRefresh');
      const config = loadMemoryConfig();
      if (!config.approvalRequired || !config.triageAutoRun) break;
      await triagePendingMemoryWrites(makeReviewInvoker(config, completeReview)).catch(
        () => undefined,
      );
    } while (autoTriageAgain);
  } finally {
    autoTriageRunning = false;
  }
}

/** Schedule an automatic triage pass (debounced, no-op when disabled in config). */
export function scheduleAutoTriage(): void {
  // Vitest: no gateway is reachable and the debounce timer would outlive the
  // test. queuePendingMemoryWrites callers in tests never expect a triage.
  if (typeof process !== 'undefined' && process.env?.VITEST) return;
  if (autoTriageTimer) clearTimeout(autoTriageTimer);
  autoTriageTimer = setTimeout(() => {
    autoTriageTimer = null;
    void runAutoTriage();
  }, AUTO_TRIAGE_DEBOUNCE_MS);
}
