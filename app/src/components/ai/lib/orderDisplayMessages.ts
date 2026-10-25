import type { Message } from '@/store/types';

/**
 * Display-only chronological ordering for the AI-return stream.
 *
 * The store keeps messages merged by turn, so the raw array can be out of
 * `createdAt` order (e.g. an in-flight reply lands right after its own prompt,
 * even when a later user message was appended first). This sorts a copy by
 * `createdAt` so the stream reads top-down in real send time, leaving the
 * store array and the LLM-facing history untouched.
 *
 * Interjections use their persisted reply ID. Legacy records infer the latest
 * real reply started in their turn; local-only cards are never reply targets.
 * Insert before the reply after chronological sorting, without changing store
 * order or timestamps. This also repairs legacy trailing interjections.
 *
 * Pending prompts stay at the tail in queue FIFO order until execution starts.
 * They are not turn boundaries for legacy interjection inference.
 * Sort is skipped when the array is already monotonic, so steady-state
 * rendering stays O(n).
 */
export function orderDisplayMessages(
  messages: Message[],
  queuedMessageIds: readonly string[] = [],
): Message[] {
  if (queuedMessageIds.length > 0) {
    const byId = new Map(messages.map((message) => [message.id, message]));
    const queued = queuedMessageIds.flatMap((id) => {
      const message = byId.get(id);
      return message?.role === 'user' ? [message] : [];
    });
    if (queued.length > 0) {
      const queuedIds = new Set(queued.map((message) => message.id));
      const ordered = [
        ...orderDisplayMessages(messages.filter((message) => !queuedIds.has(message.id))),
        ...queued,
      ];
      return ordered.every((message, index) => message === messages[index]) ? messages : ordered;
    }
  }
  const isReply = (message: Message) =>
    message.role === 'assistant' && !message.localOnly && !message.skillLearning;
  const byId = new Map(messages.map((message) => [message.id, message]));
  const anchors = new Map<string, Message[]>();
  const anchoredIds = new Set<string>();
  for (const message of messages) {
    if (!message.interjected) continue;
    let reply = message.interjectedReplyId ? byId.get(message.interjectedReplyId) : undefined;
    if (reply && !isReply(reply)) reply = undefined;
    if (!reply) {
      const turnStart = messages.reduce((latest, candidate) =>
        candidate.role === 'user' && !candidate.interjected &&
        candidate.createdAt <= message.createdAt
          ? Math.max(latest, candidate.createdAt) : latest, -Infinity);
      for (const candidate of messages) {
        if (isReply(candidate) && candidate.createdAt >= turnStart &&
          candidate.createdAt <= message.createdAt &&
          (!reply || candidate.createdAt > reply.createdAt)) reply = candidate;
      }
    }
    if (!reply) continue;
    const group = anchors.get(reply.id) ?? [];
    group.push(message);
    anchors.set(reply.id, group);
    anchoredIds.add(message.id);
  }
  let sorted = true;
  for (let i = 1; i < messages.length; i += 1) {
    if (messages[i].createdAt < messages[i - 1].createdAt) {
      sorted = false;
      break;
    }
  }
  if (sorted && anchors.size === 0) return messages;
  const chronological = messages.filter((message) => !anchoredIds.has(message.id));
  chronological.sort((a, b) => a.createdAt - b.createdAt);
  const ordered = chronological.flatMap((message) => [...(anchors.get(message.id) ?? []), message]);
  return ordered.every((message, index) => message === messages[index]) ? messages : ordered;
}
