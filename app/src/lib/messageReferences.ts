import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { segmentMessage } from '@/components/ai/lib/segmenter';
import { extractToolSentinels, mergeToolPatches } from '@/components/ai/lib/toolEvent';
import type { SkillNativeToolEvent } from '@/runtime/skills/types';
import type { Message } from '@/store/types';

/** Sources observed in successful web-tool output, never inferred from prose. */
export interface ReferenceSource {
  url: string;
  title: string;
  toolCallId: string;
}
export interface MessageReference extends ReferenceSource {
  number: number;
}

export function referenceKey(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_|^(?:fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
    }
    return url.href;
  } catch { return null; }
}

export function mergeReferenceSources(...groups: ReferenceSource[][]): ReferenceSource[] {
  const sources = new Map<string, ReferenceSource>();
  for (const source of groups.flat()) {
    const key = referenceKey(source.url);
    if (!key) continue;
    const previous = sources.get(key);
    if (!previous) sources.set(key, source);
    else if (previous.title === previous.url && source.title !== source.url) sources.set(key, { ...previous, title: source.title });
  }
  return [...sources.values()];
}

/** Keep this gate narrow: URLs in shell output, source code and failed calls are not web evidence. */
export function sourcesFromTool(event: Pick<SkillNativeToolEvent, 'toolCallId' | 'toolName' | 'phase' | 'status' | 'args' | 'result'>): ReferenceSource[] {
  const args = event.args && typeof event.args === 'object' ? event.args as Record<string, unknown> : undefined;
  const toolName = `${event.toolName} ${typeof args?.tool === 'string' ? args.tool : ''}`;
  if (event.phase !== 'end' || event.status !== 'success' || !/(?:web|search|browse|fetch|crawl)/i.test(toolName)) return [];
  const sources: ReferenceSource[] = [];
  const add = (url: unknown, title?: unknown) => {
    if (typeof url !== 'string' || !referenceKey(url)) return;
    sources.push({ url, title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 300) : url, toolCallId: event.toolCallId });
  };
  const scanText = (text: string) => {
    for (const match of text.matchAll(/\[([^\]\n]+)\]\(<?(https?:\/\/[^\s>]+?)>?\)/g)) add(match[2], match[1]);
    for (const match of text.matchAll(/https?:\/\/[^\s<>[\]"'`\\]+/g)) add(match[0].replace(/[.,;!?)，。；！）]+$/, ''));
  };
  const walk = (value: unknown, depth = 0) => {
    if (depth > 12) return;
    if (typeof value === 'string') {
      try { walk(JSON.parse(value), depth + 1); } catch { scanText(value); }
    } else if (Array.isArray(value)) value.forEach((item) => walk(item, depth + 1));
    else if (value && typeof value === 'object') {
      const object = value as Record<string, unknown>;
      add(object.url ?? object.link ?? object.href, object.title ?? object.name);
      Object.values(object).forEach((item) => walk(item, depth + 1));
    }
  };
  walk(event.result);
  // A successful page read confirms its requested URL even when the body has no links.
  if (/(?:fetch|browse|crawl|web.*(?:open|read)|WebFetch)/i.test(toolName) && event.result?.trim()) {
    add(args?.url);
  }
  return mergeReferenceSources(sources);
}

export function sourcesFromMessageTools(text: string): ReferenceSource[] {
  if (!text.includes('<<UGS_TOOL>>')) return [];
  return mergeReferenceSources(...mergeToolPatches(extractToolSentinels(text).patches).map((tool) =>
    (tool.provenance && tool.provenance !== 'native-tool') || (tool.evidenceStatus && tool.evidenceStatus !== 'success') ? [] : sourcesFromTool({ toolCallId: tool.id, toolName: tool.name,
      phase: 'end', status: tool.status === 'done' ? 'success' : 'error', args: tool.args, result: tool.result })));
}

interface MarkdownNode {
  type: string;
  url?: string;
  value?: string;
  identifier?: string;
  children?: MarkdownNode[];
}
const parser = unified().use(remarkParse);
const nodeText = (node: MarkdownNode): string => node.value ?? node.children?.map(nodeText).join('') ?? '';

export function isReferenceCitationLink(url: string, label: string): boolean {
  return !/(?:下载|download)/i.test(label) && !/\.(?:png|jpe?g|gif|webp|mp4|mp3|wav|glb|gltf|fbx|zip)(?:[?#]|$)/i.test(url);
}

/** First-use order, answers only. Code, images and unverified model links stay ordinary content. */
export function collectMessageReferences(text: string, sources: ReferenceSource[], streaming = false): MessageReference[] {
  if (!sources.length) return [];
  const available = new Map(sources.map((source) => [referenceKey(source.url), source]));
  const cited = new Map<string, MessageReference>();
  for (const segment of segmentMessage(text, streaming)) {
    if (segment.type !== 'answer') continue;
    const tree = parser.parse(segment.text) as MarkdownNode;
    const definitions = new Map<string, string>();
    const walk = (node: MarkdownNode, visit: (node: MarkdownNode) => void) => {
      visit(node); node.children?.forEach((child) => walk(child, visit));
    };
    walk(tree, (node) => {
      if (node.type === 'definition' && node.identifier && node.url) definitions.set(node.identifier.toLowerCase(), node.url);
    });
    const visit = (node: MarkdownNode) => {
      if (['code', 'inlineCode', 'image', 'imageReference', 'definition'].includes(node.type)) return;
      if (node.type === 'link' || node.type === 'linkReference') {
        const url = node.url ?? definitions.get(node.identifier?.toLowerCase() ?? '');
        const label = nodeText(node).trim();
        if (!isReferenceCitationLink(url ?? '', label)) return;
        const key = url ? referenceKey(url) : null;
        const source = key ? available.get(key) : undefined;
        if (source && key && !cited.has(key)) {
          cited.set(key, { ...source, title: source.title === source.url && label && !/^\[?\d+\]?$/.test(label) ? label : source.title, number: cited.size + 1 });
        }
        return;
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  }
  return [...cited.values()];
}

export function withMessageReferences(message: Message): Message {
  if (message.role !== 'assistant' || message.localOnly) return message;
  const sources = mergeReferenceSources(message.referenceSources ?? message.references ?? [], sourcesFromMessageTools(message.text));
  if (!sources.length && !message.references?.length) return message;
  return { ...message, referenceSources: sources, references: collectMessageReferences(message.text, sources) };
}
