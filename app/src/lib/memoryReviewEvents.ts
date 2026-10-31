import type { MemoryReviewJournalJob } from './memoryConfig';

/** Advisory renderer state only. Never grants host authority or writes chat history. */
export interface MemoryReviewChatState extends Omit<MemoryReviewJournalJob, 'phase'> {
  phase: MemoryReviewJournalJob['phase'] | 'queued' | 'admitting' | 'disabled' | 'skipped' | 'unconfirmed';
  detail?: string;
}
const states = new Map<string, MemoryReviewChatState>();
const listeners = new Set<(state: MemoryReviewChatState) => void>();
export function memoryReviewIdentity(state: Pick<MemoryReviewChatState, 'source'>): string {
  const source = state.source;
  return JSON.stringify([source.hostId, source.namespaceId, source.workspaceId, source.sessionId,
    source.turnId, source.sourceMessageId, source.runId, source.cwd]);
}
export function getMemoryReviewStates(): MemoryReviewChatState[] {
  return structuredClone([...states.values()]);
}
export function subscribeMemoryReview(listener: (state: MemoryReviewChatState) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
/** Only the real review producer publishes; observer failures cannot change commits. */
export function publishMemoryReview(state: MemoryReviewChatState): void {
  const key = memoryReviewIdentity(state);
  states.delete(key);
  states.set(key, structuredClone(state));
  while (states.size > 100) states.delete(states.keys().next().value!);
  for (const listener of [...listeners]) {
    if (!listeners.has(listener)) continue;
    try { listener(structuredClone(state)); } catch { /* UI is not authority. */ }
  }
}
