import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { answerActionText } from '@/components/ai/lib/messageText';
import { protectWindowsPaths } from '@/components/ai/lib/protectWindowsPaths';
import { displayFileRefPath, parseFileRef, type FileRef } from '@/components/ai/lib/filePath';
import { scanFileRefs } from '@/components/ai/lib/fileScan';

export interface TurnArtifact {
  ref: FileRef;
  label: string;
}

const parser = unified().use(remarkParse);
const DELIVERABLE = /\.(?:docx?|pdf|rtf|odt|xlsx?|pptx?|html?|md|markdown|txt|csv|tsv|json|png|jpe?g|webp|gif|svg|apng|jfif|avif|bmp|ico|mp4|webm|mov|m4v|mp3|wav|ogg|flac|aac|m4a|zip|glb|gltf|obj|stl|fbx|bvh|asf|amc|ply|usdz|blend)$/i;
interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  identifier?: string;
  children?: MarkdownNode[];
}
const nodeText = (node: MarkdownNode): string => node.value ?? node.children?.map(nodeText).join('') ?? '';

/** Derive deliverables from the visible answer so saved sessions need no migration.
 * Tool logs, reasoning, fenced snippets and source line references are excluded. */
export function collectTurnArtifacts(text: string, cwd?: string): TurnArtifact[] {
  const tree = parser.parse(protectWindowsPaths(answerActionText(text))) as MarkdownNode;
  const definitions = new Map<string, string>();
  const files = new Map<string, TurnArtifact>();
  const walk = (node: MarkdownNode, visit: (node: MarkdownNode) => void) => {
    visit(node);
    node.children?.forEach((child) => walk(child, visit));
  };
  walk(tree, (node) => {
    if (node.type === 'definition' && node.identifier && node.url) definitions.set(node.identifier.toLowerCase(), node.url);
  });
  const add = (raw: string, label: string, explicit: boolean) => {
    const ref = parseFileRef(raw, { allowSpaces: true });
    if (!ref || ref.startLine || ref.endLine || ref.col) return;
    const outputPath = /(?:^|[\\/])(?:\.ultragamestudio[\\/](?:docs|temp|assets|model-assets|sprites?|clipboard-images|session-captures)|reports|outputs|artifacts)[\\/]/i.test(ref.path);
    if (!DELIVERABLE.test(ref.path) && !(explicit && /(?:下载|生成|脚本|download|generated|script)/i.test(label))) return;
    if (!explicit && !outputPath) return;
    const resolved = displayFileRefPath(ref, cwd).replace(/\\/g, '/');
    const key = /^(?:[A-Za-z]:\/|\/\/)/.test(resolved) ? resolved.toLowerCase() : resolved;
    if (!files.has(key)) files.set(key, { ref, label: label.trim() || ref.basename });
  };
  const visit = (node: MarkdownNode) => {
    if (node.type === 'code' || node.type === 'definition') return;
    if (node.type === 'link' || node.type === 'image' || node.type === 'linkReference') {
      const url = node.url ?? definitions.get(node.identifier?.toLowerCase() ?? '');
      if (url) add(url, nodeText(node), true);
      return;
    }
    if (node.type === 'inlineCode') { add(node.value ?? '', '', false); return; }
    if (node.type === 'text') {
      for (const ref of scanFileRefs(node.value ?? '')) if (typeof ref !== 'string') add(ref.path, '', false);
    }
    node.children?.forEach(visit);
  };
  visit(tree);
  return [...files.values()];
}
