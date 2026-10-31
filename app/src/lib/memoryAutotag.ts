/**
 * CONTRACT: one-shot "AI 自动打标" pass for legacy/unrated memory entries.
 *
 * The importance tier was introduced after the memory feature itself, so every
 * entry written before it (and anything else that slips through without a
 * tier) shows as [未标记] in the Memory settings panel forever — the review
 * loop only ever touches entries named in a new add/replace op.
 *
 * This module closes that gap: it loads the target store, batches every
 * UNTAGGED entry to a cheap model call that assigns must/important/minor, and
 * applies the tiers via setMemoryImportance() — which only touches the
 * importance field, never the text or updatedAt. Already-tagged entries are
 * left alone (the user's manual override wins). Failures are best-effort:
 * one bad batch never aborts the others.
 */

import { readMemoryBase, setMemoryImportances, type MemoryTarget } from '@/lib/memoryStore';
import { checkMemoryCancelled } from './memoryTransactions';

export interface AutotagMemoryOptions {
  signal?: AbortSignal;
  target: MemoryTarget;
  workspaceId?: string;
  /** Runs one model call; returns raw text. */
  invokeModel: (system: string, userContent: string) => Promise<string>;
  /** Max entries per model call (default 30). */
  batchSize?: number;
}

export interface AutotagMemoryResult {
  /** Entries that had no tier before this run. */
  candidates: number;
  /** Entries successfully tagged by the model. */
  tagged: number;
}

export const AUTOTAG_SYSTEM =
  '你是记忆标记员。下面给你若干条长期记忆条目（带序号）。请为每条判断重要度并只输出 JSON：\n' +
  '{"tags":[{"n":序号,"importance":"must|important|minor"}]}\n' +
  '评级标准：must=用户明确纠正/硬性偏好/违反会导致返工的约定；important=默认（环境、引擎、约定、工作流等稳定事实）；minor=琐碎细节，可被最先淘汰。\n' +
  '必须覆盖每一个序号，不要遗漏，不要输出 JSON 以外的内容。';

const DEFAULT_BATCH_SIZE = 30;

/** Tolerant JSON extraction: models may wrap the payload in prose or fences. */
function parseTags(raw: string): { n: number; importance: string }[] {
  const start = raw.search(/[[{]/);
  if (start < 0) return [];
  const open = raw[start];
  const close = open === '[' ? ']' : '}';
  const end = raw.lastIndexOf(close);
  if (end <= start) return [];
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
    if (!parsed || typeof parsed !== 'object' || (!Array.isArray(parsed) && Object.keys(parsed).some((key) => key !== 'tags'))) return [];
    const list = Array.isArray(parsed)
      ? parsed
      : (parsed as { tags?: unknown })?.tags;
    if (!Array.isArray(list)) return [];
    if (list.some((item) => !item || typeof item !== 'object' || Object.keys(item).some((key) => key !== 'n' && key !== 'importance') ||
        !Number.isInteger(item.n) || typeof item.importance !== 'string' || !normalize(item.importance))) return [];
    return list
      .map((item) => item as { n?: unknown; importance?: unknown })
      .filter(
        (item): item is { n: number; importance: string } =>
          typeof item?.n === 'number' && typeof item?.importance === 'string',
      );
  } catch {
    return [];
  }
}

export async function autotagMemoryEntries(
  options: AutotagMemoryOptions,
): Promise<AutotagMemoryResult> {
  options = { ...options };
  const usage = await readMemoryBase(options.target, options.workspaceId);
  // Only UNTAGGED entries — a tier the model or user already set stays put.
  const untagged = usage.entries.filter((e) => !e.importance);
  if (!untagged.length) return { candidates: 0, tagged: 0 };

  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  let tagged = 0;
  for (let i = 0; i < untagged.length; i += batchSize) {
    checkMemoryCancelled(options.signal);
    const base = i === 0 ? usage : await readMemoryBase(options.target, options.workspaceId);
    const batch = untagged.slice(i, i + batchSize);
    const listing = batch
      .map((e, j) => `${j + 1}. ${e.text}`)
      .join('\n');
    let raw = '';
    try {
      raw = await options.invokeModel(
        AUTOTAG_SYSTEM,
        `请为以下 ${batch.length} 条记忆条目评级：\n\n${listing}`,
      );
    } catch {
      checkMemoryCancelled(options.signal);
      continue; // best-effort: a failed batch leaves its entries untagged
    }
    checkMemoryCancelled(options.signal);
    // Index (1-based within the batch) → tier, then one exact-CAS metadata commit.
    const parsedTags = parseTags(raw);
    const byIndex = new Map(parsedTags.map((t) => [t.n, t.importance]));
    if (parsedTags.length !== batch.length || byIndex.size !== batch.length ||
        parsedTags.some((tag) => tag.n < 1 || tag.n > batch.length)) continue;
    const tags: { text: string; importance: 'must' | 'important' | 'minor' }[] = [];
    for (let j = 0; j < batch.length; j += 1) {
      const tier = normalize(byIndex.get(j + 1) ?? '');
      if (!tier) continue;
      // Match by the entry's full text — setMemoryImportance requires a unique
      // substring, and full text is unique by construction (dedup on add).
      tags.push({ text: batch[j].text, importance: tier });
    }
    tagged += await setMemoryImportances(options.target, tags, options.workspaceId, base.raw, options.signal);
  }
  return { candidates: untagged.length, tagged };
}

/** Accept 中英文 tiers locally so a model quirk never blocks the write. */
function normalize(value: string): 'must' | 'important' | 'minor' | undefined {
  switch (value.trim().toLowerCase()) {
    case 'must':
    case 'critical':
    case '必须':
      return 'must';
    case 'important':
    case '重要':
      return 'important';
    case 'minor':
    case 'low':
    case 'trivial':
    case '不重要':
      return 'minor';
    default:
      return undefined;
  }
}
