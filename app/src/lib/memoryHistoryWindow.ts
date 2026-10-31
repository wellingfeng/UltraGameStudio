/** Message-time boundary for memory review, never a session.updatedAt substitute. */
export function isMemoryReviewMessageInWindow(
  message: { role: string; text?: string; createdAt?: number }, cutoff: number, now: number,
): boolean {
  return Number.isFinite(cutoff) && Number.isFinite(now) && cutoff <= now &&
    (message.role === 'user' || message.role === 'assistant') && typeof message.text === 'string' && !!message.text.trim() &&
    typeof message.createdAt === 'number' && Number.isFinite(message.createdAt) &&
    message.createdAt >= cutoff && message.createdAt <= now;
}
