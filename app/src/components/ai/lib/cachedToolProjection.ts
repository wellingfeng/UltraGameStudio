import { createBoundedTextCache } from './boundedTextCache';
import { extractToolSentinels, TOOL_CLOSE, type ExtractToolSentinelsOptions, type ToolSentinelSplit } from './toolEvent';

const closedPrefixes = createBoundedTextCache<ToolSentinelSplit>(64, 1_000_000);

/** Cache only the closed prefix. Half-written JSON must always go through the
 * existing streaming decoder, so an updated status/subject is never stale. */
export function cachedToolProjection(text: string, options: ExtractToolSentinelsOptions = {}): ToolSentinelSplit {
  const close = text.lastIndexOf(TOOL_CLOSE);
  if (close < 0) return extractToolSentinels(text, options);
  const end = close + TOOL_CLOSE.length;
  const prefix = closedPrefixes.get(text.slice(0, end), () => extractToolSentinels(text.slice(0, end)),
    (value) => value.text.length + JSON.stringify(value.patches).length);
  const tail = extractToolSentinels(text.slice(end), options);
  const parts = [...prefix.parts];
  for (const part of tail.parts) {
    const last = parts.at(-1);
    if ('text' in part && last && 'text' in last) parts[parts.length - 1] = { text: last.text + part.text };
    else parts.push(part);
  }
  return { text: (prefix.text + tail.text).replace(/\n{3,}/g, '\n\n'), patches: [...prefix.patches, ...tail.patches], parts };
}
