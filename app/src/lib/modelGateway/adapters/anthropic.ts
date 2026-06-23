import { streamAnthropic } from '@/lib/anthropic';
import type { GatewayTextRequest } from '../types';

export async function completeAnthropic(
  request: GatewayTextRequest,
): Promise<string> {
  return streamAnthropic({
    apiKey: request.route.apiKey,
    baseUrl: request.route.baseUrl,
    model: request.route.model,
    system: request.system,
    userContent: request.userContent,
    userImages: request.userImages,
    maxTokens: request.maxTokens,
    signal: request.signal,
    onDelta: request.onDelta,
    onUsage: request.onUsage,
  });
}
