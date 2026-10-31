import { tauriAvailable } from '@/lib/tauri';
import { SCHEDULED_TASK_SCOPE, SCHEDULED_TASK_HISTORY_DIR } from '@/lib/scheduledTaskScope';
import type { SessionRecord } from '@/store/history/types';
import type {
  SkillCatalog, SkillEntry, SkillEvidence, SkillHostPort, SkillLearningMode,
  SkillMutationResult, SkillOrigin, SkillProposal, SkillReadResult,
} from '@/runtime/skills/types';

/** Transport envelope constructed by the app, never accepted from a model. */
export interface SkillServiceRequest {
  action: 'list' | 'view' | 'manage' | 'approve' | 'reject' | 'rollback' | 'history' |
    'set_policy' | 'usage' | 'archive' | 'restore' | 'import';
  origin: SkillOrigin;
  mode: SkillLearningMode;
  evidence?: SkillEvidence[];
  proposal?: SkillProposal;
  skillId?: string;
  filePath?: string;
  batchId?: string;
  rollbackId?: string;
  kind?: 'viewed' | 'delivered' | 'used-with-evidence';
  evidenceIds?: string[];
  policy?: { autoEditable?: boolean; contentLocked?: boolean; pinned?: boolean };
  sourceSkillId?: string;
}
export type SkillRequestTransport = <T>(request: SkillServiceRequest) => Promise<T>;

/** App-only authority envelope; never supplied by a model. */
export interface SkillRunBindingRequest {
  origin: SkillOrigin;
  mode: SkillLearningMode;
  actor: 'background' | 'user';
  evidence: SkillEvidence[];
}
export type SkillBindTransport = (request: SkillRunBindingRequest) => Promise<unknown>;
export type SkillRevokeTransport = (origin: SkillOrigin) => Promise<unknown>;

export interface CreateSkillHostOptions {
  origin: SkillOrigin;
  mode: SkillLearningMode;
  evidence: SkillEvidence[];
  signal?: AbortSignal;
  ready?: Promise<void>;
  request?: SkillRequestTransport;
  /** Custom request transports may already own a binding. */
  bind?: SkillBindTransport;
  revoke?: SkillRevokeTransport;
  /** User-only list/history/control host; manage never gains user authority. */
  actor?: 'background' | 'user';
}

export interface SkillControlHost extends SkillHostPort {
  revoke(): Promise<void>;
  approve(batchId: string): Promise<SkillMutationResult>;
  reject(batchId: string): Promise<SkillMutationResult>;
  rollback(rollbackId: string): Promise<SkillMutationResult>;
  history(): Promise<{ results: SkillMutationResult[] }>;
  setPolicy(skillId: string, policy: NonNullable<SkillServiceRequest['policy']>): Promise<SkillEntry>;
  archive(skillId: string): Promise<SkillEntry>;
  restore(skillId: string): Promise<SkillEntry>;
  importSkill(sourceSkillId: string): Promise<SkillEntry>;
}

/** App-only adoption ingress; never exposed by the model-facing SkillHostPort. */
export interface SkillExecutionHost extends SkillControlHost {
  recordVerifiedUsage(skillId: string, evidence: readonly SkillEvidence[]): Promise<void>;
}

async function localSkillRequest<T>(request: SkillServiceRequest): Promise<T> {
  if (!tauriAvailable()) throw new Error('SKILL_HOST_UNAVAILABLE');
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>('skills_request', { request });
}

/** Fresh storage read, never historyStore's optimistic/session-record cache. */
export async function readPersistedSkillSourceSession(workspaceId: string, sessionId: string): Promise<SessionRecord | null> {
  if ([workspaceId, sessionId].some((id) => !id || id.length > 256 || /[\\/:\u0000]/.test(id) || id === '.' || id === '..')) {
    throw new Error('SKILL_SOURCE_NOT_PERSISTED');
  }
  // Match the existing history backend, including its separate cron bucket.
  const directory = workspaceId === SCHEDULED_TASK_SCOPE
    ? `${SCHEDULED_TASK_HISTORY_DIR}/sessions` : `workspaces/${workspaceId}/sessions`;
  const relPath = `${directory}/${sessionId}.json`;
  const raw = tauriAvailable()
    ? await (await import('@tauri-apps/api/core')).invoke<string | null>('history_read_json', { relPath })
    : typeof window === 'undefined' ? null : window.localStorage.getItem(`ultragamestudio.history.v1:${relPath}`);
  if (raw === null) return null;
  if (typeof raw !== 'string') throw new Error('SKILL_SOURCE_MESSAGE_NOT_PERSISTED');
  const record: SessionRecord = JSON.parse(raw);
  if (!record || !Array.isArray(record.messages)) throw new Error('SKILL_SOURCE_MESSAGE_NOT_PERSISTED');
  return record;
}

async function localSkillBind(request: SkillRunBindingRequest): Promise<void> {
  if (!tauriAvailable()) throw new Error('SKILL_HOST_UNAVAILABLE');
  if (request.actor === 'background') {
    const { workspaceId, sessionId, turnId } = request.origin;
    const record = await readPersistedSkillSourceSession(workspaceId, sessionId);
    const matches = record?.messages.filter((message) => message.id === turnId) ?? [];
    if (!record || record.workspaceId !== workspaceId || (record.sessionId ?? record.id) !== sessionId || record.deletedAt ||
      matches.length !== 1 || matches[0].role !== 'user' || typeof matches[0].text !== 'string') {
      throw new Error('SKILL_SOURCE_MESSAGE_NOT_PERSISTED');
    }
    // Disk is authoritative. Do not add sourceMessage to this deny-unknown-
    // fields IPC contract: native host independently reads the same source ID.
  }
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('skills_bind_run', { request });
}

async function localSkillRevoke(origin: SkillOrigin): Promise<void> {
  if (!tauriAvailable()) throw new Error('SKILL_HOST_UNAVAILABLE');
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('skills_revoke_run', { origin });
}

export type CreateSkillControlHostOptions = Omit<CreateSkillHostOptions, 'actor' | 'evidence' | 'signal'>;

/** Explicit controls retain their own user grant when background work is revoked. */
export function createSkillControlHost(options: CreateSkillControlHostOptions): SkillControlHost {
  return createSkillHost({ ...options, actor: 'user', evidence: [] });
}

export function createSkillHost(options: CreateSkillHostOptions): SkillExecutionHost {
  const origin: SkillOrigin = { ...options.origin };
  const mode = options.mode;
  const evidence = structuredClone(options.evidence);
  const { ready, signal } = options;
  const transport = options.request ?? localSkillRequest;
  const bind = options.bind ?? (options.request ? undefined : localSkillBind);
  const revoke = options.revoke ?? (options.request ? undefined : localSkillRevoke);
  // The native host confirms a tombstone under its commit/grant lock. An
  // arbitrary injected transport does not promise to reject a later bind.
  const nativeRevocation = !options.request && !options.bind && !options.revoke;
  let revoked = false;
  let revocation: Promise<void> | undefined;
  const bindings = new Map<'background' | 'user', Promise<unknown>>();
  let backgroundBound = false;
  let backgroundSettled = false;
  const requestFor = (actor: 'background' | 'user'): SkillRequestTransport => async <T>(payload: SkillServiceRequest): Promise<T> => {
    const snapshot = structuredClone(payload);
    let bound = bindings.get(actor);
    if (!bound) {
      bound = (async () => {
        await ready;
        if (actor === 'background' && (revoked || signal?.aborted)) throw new Error('SKILL_REVIEW_CANCELLED');
        await bind?.({ origin: { ...origin }, mode, actor, evidence: actor === 'background' ? structuredClone(evidence) : [] });
        if (actor === 'background') backgroundBound = true;
      })();
      bindings.set(actor, bound);
      if (actor === 'background') {
        backgroundSettled = false;
        void bound.then(() => { backgroundSettled = true; }, () => { backgroundSettled = true; });
      }
    }
    await bound;
    if (actor === 'background' && (revoked || signal?.aborted)) throw new Error('SKILL_REVIEW_CANCELLED');
    return transport<T>(snapshot);
  };
  const request = requestFor(options.actor ?? 'background');
  const backgroundRequest = requestFor('background');
  const controlRequest = requestFor('user');
  return {
    revoke: () => {
      revoked = true;
      revocation ??= (async () => {
        const background = bindings.get('background');
        if (!background) return;
        if (backgroundSettled && !backgroundBound) return;
        if (nativeRevocation) {
          try {
            await revoke!({ ...origin });
            void background.catch(() => {});
            return;
          } catch {
            // Unconfirmed cancellation cannot release a still-pending grant.
            // Fall back to actual binding completion and ordinary revocation.
          }
        }
        await background.catch(() => {});
        if (!backgroundBound) return;
        await revoke?.({ ...origin });
      })();
      return revocation;
    },
    approve: (batchId) => controlRequest<SkillMutationResult>({
      action: 'approve', origin: { ...origin }, mode, batchId,
    }),
    reject: (batchId) => controlRequest<SkillMutationResult>({
      action: 'reject', origin: { ...origin }, mode, batchId,
    }),
    rollback: (rollbackId) => controlRequest<SkillMutationResult>({
      action: 'rollback', origin: { ...origin }, mode, rollbackId,
    }),
    history: () => request<{ results: SkillMutationResult[] }>({
      action: 'history', origin: { ...origin }, mode,
    }),
    setPolicy: (skillId, policy) => controlRequest<SkillEntry>({
      action: 'set_policy', origin: { ...origin }, mode, skillId, policy,
    }),
    archive: (skillId) => controlRequest<SkillEntry>({ action: 'archive', origin: { ...origin }, mode, skillId }),
    restore: (skillId) => controlRequest<SkillEntry>({ action: 'restore', origin: { ...origin }, mode, skillId }),
    importSkill: (sourceSkillId) => controlRequest<SkillEntry>({
      action: 'import', origin: { ...origin }, mode, sourceSkillId,
    }),
    list: () => request<SkillCatalog>({ action: 'list', origin: { ...origin }, mode }),
    view: (read) => request<SkillReadResult>({
      action: 'view', origin: { ...origin }, mode,
      skillId: read.skillId, ...(read.filePath === undefined ? {} : { filePath: read.filePath }),
    }),
    manage: async (proposal) => {
      if (revoked || signal?.aborted) throw new Error('SKILL_REVIEW_CANCELLED');
      // Once dispatched, the host finishes its transaction/recovery. Do not
      // turn a real applied result into a fake cancellation after the commit.
      return backgroundRequest<SkillMutationResult>({
        action: 'manage', origin: { ...origin }, mode, proposal, evidence,
      });
    },
    recordVerifiedUsage: async (skillId, adoption) => {
      const facts = structuredClone([...adoption]);
      const prior = bindings.get('background');
      if (!prior) throw new Error('SKILL_USAGE_REQUIRES_FOREGROUND_READ');
      // Existing host bindings merge immutable facts without changing authority
      // or the execution origin that owns the actual full-read receipt.
      const registration = prior.then(async () => {
        if (revoked || signal?.aborted) throw new Error('SKILL_REVIEW_CANCELLED');
        await bind?.({ origin: { ...origin }, mode, actor: 'background', evidence: structuredClone(facts) });
      });
      bindings.set('background', registration);
      backgroundSettled = false;
      void registration.then(() => { backgroundSettled = true; }, () => { backgroundSettled = true; });
      await registration;
      await backgroundRequest<unknown>({ action: 'usage', origin: { ...origin }, mode, skillId,
        kind: 'used-with-evidence', evidenceIds: facts.map((item) => item.evidenceId), evidence: facts });
    },
    recordUsage: async (skillId, kind, evidenceIds = []) => {
      await request<unknown>({
        action: 'usage', origin: { ...origin }, mode, skillId,
        kind, evidenceIds: [...evidenceIds], evidence,
      });
    },
  };
}
