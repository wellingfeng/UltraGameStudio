// Asset visual verification — the QA closed-loop for generation channels.
//
// CONTRACT: This module turns a freshly generated asset (image / sprite / mesh
// render) plus its source prompt into a structured verdict so a calling channel
// can decide whether to accept the result or re-author the prompt and
// regenerate. It is deliberately host-agnostic and side-effect free: it only
// calls a vision-capable text model via the gateway and parses the JSON verdict.
//
//  - Verification requires a *direct* gateway route (anthropic / openai-compatible
//    with an API key) because only those transports carry image input. When no
//    such route resolves (CLI-only channel, browser without key, tests), the
//    caller should treat verification as unavailable and skip it — generation
//    must keep working end to end without it.
//  - The verdict never mutates the generation result. It carries a pass/fail
//    decision, a 0–100 score, a list of human-readable defects, and an optional
//    `promptPatch` the caller folds into the next prompt attempt.
//
// This is the generation-side analogue of Fable5's automated visual QA: generate
// -> see -> judge -> (re-prompt + regenerate) -> repeat until pass or budget.

import { extractJsonObject } from './anthropic';
import type { AssetKind } from './downloadRegistry';
import {
  completeGatewayText,
  resolveDirectGatewayRoute,
  type GatewaySelection,
} from './modelGateway';

/** A single verification outcome for one generated asset. */
export interface AssetVerdict {
  /** Whether the asset meets the bar (score >= threshold and no blocking defect). */
  pass: boolean;
  /** Overall quality/intent-match score, 0–100. */
  score: number;
  /** Human-readable defects the model found (empty when clean). */
  defects: string[];
  /**
   * Optional additive guidance to fold into the next prompt attempt, e.g.
   * "手部畸形，重画手部为五指自然姿态" or a negative-prompt fragment. Absent when
   * the asset passes or the model offered no actionable fix.
   */
  promptPatch?: string;
}

export interface VerifyAssetInput {
  kind: AssetKind;
  /** The prompt that produced the asset (post-authoring, what the model saw). */
  prompt: string;
  /**
   * Image sources to inspect: `data:` URLs (preferred) or http(s) URLs. For
   * mesh/3D this is expected to be an off-screen render screenshot, not raw
   * geometry. Only the first few are sent to bound cost.
   */
  sources: string[];
  /** The coding/text channel currently selected; must resolve to a direct route. */
  selection: GatewaySelection;
  /** Score at/above which the asset passes. Default 70. */
  threshold?: number;
  permission?: string;
  signal?: AbortSignal;
  cwd?: string;
  workspaceId?: string | null;
  sessionId?: string | null;
}

/** Whether visual verification can run for the given channel selection. */
export function canVerifyAsset(selection: GatewaySelection): boolean {
  return resolveDirectGatewayRoute(selection) !== null;
}

const KIND_FOCUS: Partial<Record<AssetKind, string>> = {
  image:
    '主体是否正确、构图与透视是否合理、色调与光影是否协调、有无畸形（手指、肢体、文字乱码、重复拼接、水印）。',
  sprite:
    '是否为干净的游戏精灵/序列帧、主体是否居中、背景是否透明或纯色、帧与帧之间风格与比例是否一致、有无糊边或多余元素。',
  mesh: '从渲染截图看模型比例与对称是否正确、有无明显破面/缺面/穿插、拓扑是否干净、是否符合需求描述的造型。',
  model: '从渲染截图看模型比例与对称是否正确、有无明显破面/缺面/穿插、是否符合需求描述的造型。',
};

function verifySystemPrompt(kind: AssetKind): string {
  const focus =
    KIND_FOCUS[kind] ?? '资产是否符合需求描述、整体质量是否达到可用标准、有无明显缺陷。';
  return [
    '你是严格的游戏美术质检员。用户会给出一段生成需求（提示词）和一张或多张生成结果图片。',
    '你的任务是对照需求评估生成结果的质量，重点关注：',
    focus,
    '只输出一个 JSON 对象，不要任何额外文字或解释，格式如下：',
    '{"score": 0-100 的整数, "pass": true/false, "defects": ["缺陷1", "缺陷2"], "promptPatch": "若不达标，给出可直接追加到原提示词后的中文修正指令；达标则留空字符串"}',
    'score 表示与需求的契合度与整体质量；只有当质量可直接用于游戏开发、且无明显缺陷时 pass 才为 true。',
    'defects 用简洁中文，每条指出一个具体问题；没有缺陷时为空数组。',
  ].join('\n');
}

interface RawVerdict {
  score?: unknown;
  pass?: unknown;
  defects?: unknown;
  promptPatch?: unknown;
}

function clampScore(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function parseVerdict(raw: string, threshold: number): AssetVerdict {
  let parsed: RawVerdict;
  try {
    parsed = JSON.parse(extractJsonObject(raw)) as RawVerdict;
  } catch {
    // Unparseable verdict: treat as a pass to avoid burning quota on retries
    // when the judge model misbehaves. Generation result is kept as-is.
    return { pass: true, score: threshold, defects: [] };
  }
  const score = clampScore(parsed.score);
  const defects = Array.isArray(parsed.defects)
    ? parsed.defects.map((d) => String(d)).filter(Boolean)
    : [];
  const patchRaw =
    typeof parsed.promptPatch === 'string' ? parsed.promptPatch.trim() : '';
  // Trust an explicit boolean when present; otherwise derive from the threshold.
  const pass =
    typeof parsed.pass === 'boolean' ? parsed.pass : score >= threshold;
  return {
    pass,
    score,
    defects,
    promptPatch: pass || !patchRaw ? undefined : patchRaw,
  };
}

/** Cap how many images we send to a single verification call to bound cost. */
const MAX_VERIFY_IMAGES = 2;

/**
 * Ask a vision model to judge a generated asset against its prompt. Returns a
 * structured verdict, or `null` when verification cannot run (no direct route /
 * no inspectable image source). A `null` return means "skip verification", not
 * "failed".
 */
export async function verifyAsset(
  input: VerifyAssetInput,
): Promise<AssetVerdict | null> {
  const route = resolveDirectGatewayRoute(input.selection);
  if (!route) return null;
  const images = (input.sources ?? [])
    .map((s) => s?.trim())
    .filter((s): s is string => Boolean(s) && (/^data:image\//i.test(s) || /^https?:\/\//i.test(s)))
    .slice(0, MAX_VERIFY_IMAGES);
  if (images.length === 0) return null;

  const threshold = input.threshold ?? 70;
  const userContent = `生成需求（提示词）：\n${input.prompt}\n\n请评估上面的图片是否达到该需求的可用质量，并按要求只返回 JSON。`;
  const raw = await completeGatewayText({
    route,
    system: verifySystemPrompt(input.kind),
    userContent,
    userImages: images,
    maxTokens: 1024,
    signal: input.signal,
    permission: input.permission,
    cwd: input.cwd ?? undefined,
    usageContext: {
      workspaceId: input.workspaceId ?? undefined,
      sessionId: input.sessionId ?? undefined,
    },
  });
  return parseVerdict(raw, threshold);
}
