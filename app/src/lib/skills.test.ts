import { describe, expect, it, vi } from 'vitest';
import { createSkillControlHost, createSkillHost, type SkillServiceRequest } from './skills';
import type { SkillCatalog, SkillOrigin, SkillProposal } from '@/runtime/skills/types';

const native = vi.hoisted(() => ({ invoke: vi.fn(), getSession: vi.fn() }));
vi.mock('@/lib/tauri', () => ({ tauriAvailable: () => true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@/store/history/store', () => ({ historyStore: { getSession: native.getSession } }));

const origin = (): SkillOrigin => ({
  hostId: 'local', workspaceId: 'workspace-a', sessionId: 'session-a',
  turnId: 'turn-a', runId: 'run-a', cwd: 'E:/project-a',
});
const proposal: SkillProposal = {
  version: 1, kind: 'propose', lesson: 'Read the manifest before choosing dependencies.',
  evidenceIds: ['verification-a'], operations: [{
    action: 'create', name: 'manifest-first',
    content: '---\nname: manifest-first\ndescription: Use when selecting dependencies.\n---\nRead the project manifest first.\n',
  }],
};

describe('origin-bound skill host', () => {
  it('awaits native revoke acknowledgement without waiting for a pending bind and denies late dispatch', async () => {
    let releaseBind!: () => void;
    let acknowledge!: () => void;
    const bindGate = new Promise<void>((resolve) => { releaseBind = resolve; });
    const revokeGate = new Promise<void>((resolve) => { acknowledge = resolve; });
    let tombstone = false;
    native.invoke.mockReset().mockImplementation(async (command) => {
      if (command === 'history_read_json') return JSON.stringify({ id: 'session-a', workspaceId: 'workspace-a',
        messages: [{ id: 'turn-a', role: 'user', text: 'Persisted source.' }] });
      if (command === 'skills_bind_run') { await bindGate; if (tombstone) throw new Error('run authority revoked'); }
      if (command === 'skills_revoke_run') { await revokeGate; tombstone = true; }
      return { revision: 'empty', entries: [] };
    });
    const host = createSkillHost({ origin: origin(), mode: 'auto-safe', evidence: [] });
    const list = host.list(); void list.catch(() => {});
    await vi.dynamicImportSettled();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(native.invoke.mock.calls.some(([command]) => command === 'skills_bind_run')).toBe(true);
    let settled = false;
    const revoked = host.revoke().then(() => { settled = true; });
    await vi.dynamicImportSettled();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    const revokeDispatchedBeforeBind = native.invoke.mock.calls.some(([command]) => command === 'skills_revoke_run');
    expect(settled).toBe(false);
    acknowledge();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    const revokedBeforeBind = settled;
    releaseBind(); await revoked; await list.catch(() => {});
    expect({ revokeDispatchedBeforeBind, revokedBeforeBind }).toEqual({ revokeDispatchedBeforeBind: true, revokedBeforeBind: true });
    expect(tombstone).toBe(true);
    expect(native.invoke.mock.calls.some(([command]) => command === 'skills_request')).toBe(false);
    await expect(host.manage(proposal)).rejects.toThrow('SKILL_REVIEW_CANCELLED');
  });

  it('does not assume that a custom revoke prevents a late custom bind', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const bind = vi.fn(async () => { await gate; });
    const revoke = vi.fn(async () => {});
    const request = vi.fn(async () => ({}));
    const host = createSkillHost({ origin: origin(), mode: 'auto-safe', evidence: [], bind, revoke,
      request: async <T>(): Promise<T> => await request() as T });
    const list = host.list(); void list.catch(() => {});
    for (let i = 0; i < 10; i++) await Promise.resolve();
    let settled = false; const revoked = host.revoke().then(() => { settled = true; });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(settled).toBe(false); expect(revoke).not.toHaveBeenCalled();
    release(); await revoked; await expect(list).rejects.toThrow('SKILL_REVIEW_CANCELLED');
    expect(revoke).toHaveBeenCalledTimes(1); expect(request).not.toHaveBeenCalled();
  });

  it('refuses native authority for an empty persisted session even when ready resolves', async () => {
    native.invoke.mockReset().mockImplementation(async (command) => command === 'history_read_json'
      ? JSON.stringify({ id: 'session-a', workspaceId: 'workspace-a', messages: [] }) : { revision: 'empty', entries: [] });
    native.getSession.mockReset().mockResolvedValue({ id: 'session-a', workspaceId: 'workspace-a', messages: [] });
    const host = createSkillHost({ origin: origin(), mode: 'auto-safe', evidence: [], ready: Promise.resolve() });
    await expect(host.list()).rejects.toThrow('SKILL_SOURCE_MESSAGE_NOT_PERSISTED');
    expect(native.invoke.mock.calls.map(([command]) => command)).toEqual(['history_read_json']);
  });

  it('re-reads native storage instead of granting authority from a stale session cache', async () => {
    native.getSession.mockReset().mockResolvedValue({ id: 'session-a', workspaceId: 'workspace-a',
      messages: [{ id: 'turn-a', role: 'user', text: 'Cached but absent on disk.' }] });
    native.invoke.mockReset().mockImplementation(async (command) => command === 'history_read_json'
      ? JSON.stringify({ id: 'session-a', workspaceId: 'workspace-a', messages: [] }) : { revision: 'empty', entries: [] });
    const host = createSkillHost({ origin: origin(), mode: 'auto-safe', evidence: [], ready: Promise.resolve() });
    await expect(host.list()).rejects.toThrow('SKILL_SOURCE_MESSAGE_NOT_PERSISTED');
    expect(native.invoke.mock.calls.some(([command]) => command === 'skills_bind_run')).toBe(false);
  });

  it('awaits persisted-session readiness and binds once before any local request', async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    const bind = vi.fn(async (binding: unknown) => { calls.push('bind'); return binding; });
    const host = createSkillHost({
      origin: origin(), mode: 'auto-safe', evidence: [], ready, bind,
      request: async <T>(): Promise<T> => { calls.push('request'); return { revision: 'one', entries: [] } as T; },
    });
    const catalog = host.list();
    await Promise.resolve();
    expect(calls).toEqual([]);
    release();
    await catalog;
    await host.list();
    expect(calls).toEqual(['bind', 'request', 'request']);
    expect(bind).toHaveBeenCalledWith({ origin: origin(), mode: 'auto-safe', actor: 'background', evidence: [] });
  });

  it('snapshots policy and nested evidence before asynchronous binding or transport mutation', async () => {
    const owner = origin();
    const evidence = [{ evidenceId: 'real', origin: owner, occurredAt: 1, kind: 'correction' as const,
      provenance: 'user-input' as const, status: 'success' as const, summary: 'Read manifests first.' }];
    const requests: SkillServiceRequest[] = [];
    const options = {
      origin: owner, mode: 'auto-safe' as const, evidence,
      request: async <T>(request: SkillServiceRequest): Promise<T> => {
        requests.push(structuredClone(request));
        if (request.evidence) request.evidence[0].summary = 'transport mutation';
        return {} as T;
      },
    };
    const host = createSkillHost(options);
    Object.assign(options, { mode: 'off' });
    evidence[0].summary = 'caller mutation';
    owner.sessionId = 'other-session';
    await host.manage(proposal);
    await host.manage(proposal);
    expect(requests.map((request) => request.mode)).toEqual(['auto-safe', 'auto-safe']);
    expect(requests.map((request) => request.evidence?.[0])).toEqual([
      { ...evidence[0], summary: 'Read manifests first.', origin: origin() },
      { ...evidence[0], summary: 'Read manifests first.', origin: origin() },
    ]);
  });

  it('binds explicit controls as user without upgrading the background review binding', async () => {
    const bindings: unknown[] = [];
    const host = createSkillHost({
      origin: origin(), mode: 'approve-all', evidence: [],
      bind: async (binding) => { bindings.push(binding); },
      request: async <T>(): Promise<T> => ({ status: 'applied' }) as T,
    });
    await host.list();
    await host.approve('batch-a');
    await host.reject('batch-b');
    expect(bindings).toEqual([
      { origin: origin(), mode: 'approve-all', actor: 'background', evidence: [] },
      { origin: origin(), mode: 'approve-all', actor: 'user', evidence: [] },
    ]);
  });

  it('checks cancellation again after asynchronous bind and immediately before manage dispatch', async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const controller = new AbortController();
    const request = vi.fn(async () => ({}));
    const host = createSkillHost({ origin: origin(), mode: 'auto-safe', evidence: [], ready,
      signal: controller.signal, bind: async () => {}, request: async <T>(): Promise<T> => await request() as T });
    const mutation = host.manage(proposal);
    controller.abort();
    release();
    await expect(mutation).rejects.toThrow('SKILL_REVIEW_CANCELLED');
    expect(request).not.toHaveBeenCalled();
  });

  it('exposes user-only catalog and history even when learning is off', async () => {
    const bindings: unknown[] = [];
    const requests: SkillServiceRequest[] = [];
    const host = createSkillControlHost({ origin: origin(), mode: 'off',
      bind: async (binding) => { bindings.push(binding); },
      request: async <T>(request: SkillServiceRequest): Promise<T> => {
        requests.push(request); return { results: [] } as T;
      },
    });
    await host.history();
    await host.list();
    expect(bindings).toEqual([{ origin: origin(), mode: 'off', actor: 'user', evidence: [] }]);
    expect(requests.map((request) => request.action)).toEqual(['history', 'list']);
  });

  it('revokes only background authority while later user controls remain available', async () => {
    const bindings: unknown[] = [];
    const revocations: SkillOrigin[] = [];
    const host = createSkillHost({ origin: origin(), mode: 'approve-all', evidence: [],
      bind: async (binding) => { bindings.push(binding); },
      revoke: async (owner) => { revocations.push(owner); },
      request: async <T>(): Promise<T> => ({ status: 'applied' }) as T,
    });
    await host.list();
    await host.revoke();
    await host.revoke();
    await expect(host.manage(proposal)).rejects.toThrow('SKILL_REVIEW_CANCELLED');
    await expect(host.approve('batch-a')).resolves.toEqual({ status: 'applied' });
    expect(revocations).toEqual([origin()]);
    expect(bindings).toEqual([
      { origin: origin(), mode: 'approve-all', actor: 'background', evidence: [] },
      { origin: origin(), mode: 'approve-all', actor: 'user', evidence: [] },
    ]);
  });

  it('never creates a late background grant after a source was revoked before persistence', async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const bind = vi.fn(async () => {});
    const request = vi.fn(async () => ({ revision: 'empty', entries: [] }));
    const host = createSkillHost({ origin: origin(), mode: 'auto-safe', evidence: [], ready, bind,
      request: async <T>(): Promise<T> => await request() as T });
    const list = host.list();
    void list.catch(() => {});
    const revoked = host.revoke();
    release();
    await revoked;
    await expect(list).rejects.toThrow('SKILL_REVIEW_CANCELLED');
    expect(bind).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('freezes the original workspace and never lets proposal data select a root', async () => {
    const owner = origin();
    const requests: SkillServiceRequest[] = [];
    const host = createSkillHost({
      origin: owner, mode: 'auto-safe', evidence: [],
      request: async <T>(request: SkillServiceRequest): Promise<T> => {
        requests.push(request);
        return { revision: 'catalog-1', entries: [] } as T;
      },
    });
    owner.workspaceId = 'workspace-b';
    owner.cwd = 'E:/project-b';
    await host.list();
    expect(requests).toEqual([{ action: 'list', origin: origin(), mode: 'auto-safe' }]);
    expect(await host.list()).toEqual({ revision: 'catalog-1', entries: [] } satisfies SkillCatalog);
  });

  it('refuses a cancelled mutation before it reaches the filesystem transport', async () => {
    const controller = new AbortController();
    let calls = 0;
    const host = createSkillHost({
      origin: origin(), mode: 'auto-safe', evidence: [], signal: controller.signal,
      request: async <T>(): Promise<T> => { calls += 1; return {} as T; },
    });
    controller.abort();
    await expect(host.manage(proposal)).rejects.toThrow('SKILL_REVIEW_CANCELLED');
    expect(calls).toBe(0);
  });

  it('retains a real dispatched manage result when cancellation and revocation arrive during commit', async () => {
    const controller = new AbortController();
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const host = createSkillHost({ origin: origin(), mode: 'auto-safe', evidence: [], signal: controller.signal,
      bind: async () => {}, revoke: async () => {}, request: async <T>(): Promise<T> => {
        enter(); await gate; return { status: 'applied', batchId: 'actual-committed-batch', origin: origin(), operationsApplied: 1 } as T;
      } });
    const result = host.manage(proposal);
    await entered;
    controller.abort();
    await host.revoke();
    release();
    await expect(result).resolves.toMatchObject({ status: 'applied', batchId: 'actual-committed-batch', operationsApplied: 1 });
  });

  it('keeps explicit archive and restore on the frozen user grant after background revocation', async () => {
    const owner = origin();
    const bindings: unknown[] = [];
    const requests: SkillServiceRequest[] = [];
    const host = createSkillHost({ origin: owner, mode: 'off', evidence: [],
      bind: async (binding) => { bindings.push(structuredClone(binding)); }, revoke: async () => {},
      request: async <T>(request: SkillServiceRequest): Promise<T> => { requests.push(request); return {} as T; } });
    await host.list();
    await host.revoke();
    owner.workspaceId = 'different-active-workspace';
    await host.archive('opaque-skill-id');
    await host.restore('opaque-skill-id');
    expect(bindings).toEqual([
      { origin: origin(), mode: 'off', actor: 'background', evidence: [] },
      { origin: origin(), mode: 'off', actor: 'user', evidence: [] },
    ]);
    expect(requests.slice(1)).toEqual([
      { action: 'archive', origin: origin(), mode: 'off', skillId: 'opaque-skill-id' },
      { action: 'restore', origin: origin(), mode: 'off', skillId: 'opaque-skill-id' },
    ]);
  });

  it('keeps verified-adoption facts detached from a binding transport that mutates its input', async () => {
    const facts = [{ evidenceId: 'adoption', origin: origin(), occurredAt: 1, kind: 'skill-use' as const,
      provenance: 'host-check' as const, status: 'success' as const, exitCode: 0,
      toolCallId: 'check', skillId: 'skill-a', revision: 'revision-a', summary: 'Trusted immutable adoption.' }];
    const requests: SkillServiceRequest[] = [];
    const host = createSkillHost({ origin: origin(), mode: 'auto-safe', evidence: [],
      bind: async (binding) => { if (binding.evidence.length) binding.evidence[0].summary = 'binding transport mutation'; },
      request: async <T>(request: SkillServiceRequest): Promise<T> => { requests.push(structuredClone(request)); return {} as T; } });
    await host.view({ skillId: 'skill-a' });
    await host.recordVerifiedUsage('skill-a', facts);
    expect(requests.at(-1)?.evidence).toEqual(facts);
  });

  it('keeps lifecycle usage scoped to the frozen source and its evidence', async () => {
    const requests: SkillServiceRequest[] = [];
    const host = createSkillHost({
      origin: origin(), mode: 'auto-safe', evidence: [],
      request: async <T>(request: SkillServiceRequest): Promise<T> => {
        requests.push(request); return undefined as T;
      },
    });
    await host.recordUsage?.('opaque-skill-id', 'used-with-evidence', ['verification-a']);
    expect(requests).toEqual([{
      action: 'usage', origin: origin(), mode: 'auto-safe', skillId: 'opaque-skill-id',
      kind: 'used-with-evidence', evidenceIds: ['verification-a'], evidence: [],
    }]);
  });

  it('approves the frozen batch in its owning workspace instead of the active UI workspace', async () => {
    const owner = origin();
    const requests: SkillServiceRequest[] = [];
    const host = createSkillHost({
      origin: owner, mode: 'approve-all', evidence: [],
      request: async <T>(request: SkillServiceRequest): Promise<T> => {
        requests.push(request); return { status: 'applied', batchId: 'batch-a' } as T;
      },
    });
    owner.workspaceId = 'workspace-b';
    await host.approve('batch-a');
    expect(requests).toEqual([{
      action: 'approve', origin: origin(), mode: 'approve-all', batchId: 'batch-a',
    }]);
  });
});
