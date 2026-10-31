import type { SkillOrigin } from '../skills/types';
import type { InteractionAnswer } from '@/core/interaction';

const foreground = new Set<symbol>();
let background: { controller: AbortController; owner: string } | undefined;
const availableListeners = new Set<() => void>();
const cancellationListeners = new Set<(owner?: string) => void>();
let availabilityQueued = false;
/** Event-driven admission; never synchronously re-enter a live scheduler. */
function notifyReviewAvailable(): void {
  if (availabilityQueued || foreground.size || background) return;
  availabilityQueued = true;
  queueMicrotask(() => {
    availabilityQueued = false;
    if (foreground.size || background) return;
    for (const listener of [...availableListeners]) {
      if (!availableListeners.has(listener)) continue;
      try { listener(); } catch { /* One observer cannot strand other queues. */ }
    }
  });
}
export function subscribeReviewAvailable(listener: () => void): () => void {
  availableListeners.add(listener);
  return () => { availableListeners.delete(listener); };
}
/** Explicit caller/config cancellation also reaches undispatched waiters. */
export function subscribeReviewCancellation(listener: (owner?: string) => void): () => void {
  cancellationListeners.add(listener);
  return () => { cancellationListeners.delete(listener); };
}
/** Foreground preemption aborts dispatched work, never pending admission. */
export function preemptReviewBackground(owner?: string): void {
  if (!owner || background?.owner === owner) background?.controller.abort();
}
export function cancelReviewBackground(owner?: string): void {
  preemptReviewBackground(owner);
  for (const listener of [...cancellationListeners]) {
    if (!cancellationListeners.has(listener)) continue;
    try { listener(owner); } catch { /* Cancellation observers are not authority. */ }
  }
}
export function cancelMemoryReviews(): void { cancelReviewBackground('memory'); }
export function beginReviewForeground(_key: string): () => void {
  const token = Symbol(); foreground.add(token);
  // Preempt a dispatched review, but retain jobs only waiting for admission.
  preemptReviewBackground();
  return () => { if (foreground.delete(token)) notifyReviewAvailable(); };
}
export function acquireReviewBackground(owner = 'memory'): { signal: AbortSignal; release: () => void } | undefined {
  if (foreground.size || background) return;
  const slot = { controller: new AbortController(), owner }; background = slot;
  return { signal: slot.controller.signal, release: () => {
    if (background !== slot) return;
    background = undefined;
    notifyReviewAvailable();
  } };
}

export interface MemoryReviewMessage { id: string; role: string; text: string; sourceMessageId?: string }
/** Derived transcript view, not a fabricated persisted user message. */
export function buildMemoryReviewMessages(messages: (MemoryReviewMessage & {
  localOnly?: boolean; interaction?: { prompt: string }; interactionStatus?: string; interactionAnswer?: InteractionAnswer;
})[]): MemoryReviewMessage[] {
  return messages.filter((message) => !message.localOnly && (message.role === 'user' || message.role === 'assistant'))
    .flatMap((message) => {
      const view: MemoryReviewMessage = { id: message.id, role: message.role, text: message.text };
      if (message.interactionStatus !== 'answered' || !message.interaction || !message.interactionAnswer) return [view];
      return [view, { id: `${message.id}:answer`, sourceMessageId: message.id, role: 'user',
        text: `${message.interaction.prompt}\n用户实际回答：${JSON.stringify(message.interactionAnswer)}` }];
    });
}
export interface MemoryReviewJob {
  source: SkillOrigin & { namespaceId?: string; sourceMessageId?: string };
  config: { reviewEnabled: boolean; writeEnabled: boolean; reviewMinMessages: number; reviewMinIntervalMinutes: number };
  messages: MemoryReviewMessage[];
}
export interface MemoryReviewReservation { id: string; job: MemoryReviewJob }
export interface MemoryReviewSchedulerState {
  consumed: [string, string[]][];
  attempted: string[];
  lastCompleted: [string, number][];
  consumedFence?: number[];
  attemptedFence?: number[];
}

/** Bounded replay tombstones: false positives skip old/delayed work, never rebill it. */
class ReplayFence {
  private bits: Uint32Array;
  constructor(state?: number[]) { this.bits = Uint32Array.from(state?.slice(0, 2048) ?? Array(2048).fill(0)); }
  private positions(key: string): number[] {
    let first = 2166136261, second = 5381;
    for (let i = 0; i < key.length; i++) {
      first = Math.imul(first ^ key.charCodeAt(i), 16777619);
      second = Math.imul(second, 33) ^ key.charCodeAt(i);
    }
    return [first >>> 0, second >>> 0, (first ^ second) >>> 0].map((hash) => hash % 65536);
  }
  has(key: string): boolean { return this.positions(key).every((bit) => (this.bits[bit >>> 5] & (1 << (bit & 31))) !== 0); }
  add(key: string): void { for (const bit of this.positions(key)) this.bits[bit >>> 5] |= 1 << (bit & 31); }
  snapshot(): number[] { return [...this.bits]; }
}

export class MemoryReviewScheduler {
  private consumed = new Map<string, Set<string>>();
  private active = new Map<string, MemoryReviewReservation>();
  private attempted = new Set<string>();
  private lastCompleted = new Map<string, number>();
  private consumedFence = new ReplayFence();
  private attemptedFence = new ReplayFence();
  constructor(state?: MemoryReviewSchedulerState) {
    if (!state) return;
    this.consumed = new Map(state.consumed.map(([key, ids]) => [key, new Set(ids)]));
    this.attempted = new Set(state.attempted);
    this.lastCompleted = new Map(state.lastCompleted);
    this.consumedFence = new ReplayFence(state.consumedFence);
    this.attemptedFence = new ReplayFence(state.attemptedFence);
    for (const [session, ids] of this.consumed) for (const id of ids) this.consumedFence.add(JSON.stringify([session, id]));
    for (const id of this.attempted) this.attemptedFence.add(id);
  }
  snapshot(): MemoryReviewSchedulerState {
    return { consumed: [...this.consumed].map(([key, ids]) => [key, [...ids]]),
      attempted: [...this.attempted], lastCompleted: [...this.lastCompleted],
      consumedFence: this.consumedFence.snapshot(), attemptedFence: this.attemptedFence.snapshot() };
  }
  private scopeKey(source: MemoryReviewJob['source']): string { return JSON.stringify([source.hostId, source.namespaceId, source.workspaceId]); }
  private sessionKey(source: MemoryReviewJob['source']): string { return JSON.stringify([source.hostId, source.namespaceId, source.workspaceId, source.sessionId]); }
  reserve(job: MemoryReviewJob, terminal: 'running' | 'completed' | 'cancelled' | 'failed', now: number): MemoryReviewReservation | null {
    const scope = this.scopeKey(job.source);
    if ([...this.active.values()].some((reservation) => this.scopeKey(reservation.job.source) === scope)) return null;
    const lastCompleted = this.lastCompleted.get(scope);
    if (lastCompleted !== undefined && now < lastCompleted + job.config.reviewMinIntervalMinutes * 60000) return null;
    const consumed = this.consumed.get(this.sessionKey(job.source));
    const messages = job.messages.filter((message) => !consumed?.has(message.id) &&
      !this.consumedFence.has(JSON.stringify([this.sessionKey(job.source), message.id])));
    if (terminal !== 'completed' || !job.config.reviewEnabled || !job.config.writeEnabled || messages.length < job.config.reviewMinMessages) return null;
    const reservation = { id: JSON.stringify([job.source.hostId, job.source.namespaceId, job.source.workspaceId, job.source.sessionId, job.source.turnId]), job: structuredClone({ ...job, messages }) };
    if (this.attempted.has(reservation.id) || this.attemptedFence.has(reservation.id)) return null;
    this.attempted.add(reservation.id);
    this.attemptedFence.add(reservation.id);
    while (this.attempted.size > 256) this.attempted.delete(this.attempted.values().next().value!);
    this.active.set(reservation.id, structuredClone(reservation));
    return reservation;
  }
  finish(id: string, status: 'applied' | 'awaiting_approval' | 'noop' | 'failed' | 'cancelled', now: number): void {
    const reservation = this.active.get(id);
    if (!reservation) return;
    this.active.delete(id);
    if (status === 'failed' || status === 'cancelled') return;
    this.lastCompleted.set(this.scopeKey(reservation.job.source), now);
    const key = this.sessionKey(reservation.job.source);
    const consumed = this.consumed.get(key) ?? new Set<string>();
    for (const message of reservation.job.messages) {
      consumed.add(message.id);
      this.consumedFence.add(JSON.stringify([key, message.id]));
    }
    while (consumed.size > 256) consumed.delete(consumed.values().next().value!);
    this.consumed.set(key, consumed);
    while (this.consumed.size > 128) this.consumed.delete(this.consumed.keys().next().value!);
    while (this.lastCompleted.size > 128) this.lastCompleted.delete(this.lastCompleted.keys().next().value!);
  }
}
