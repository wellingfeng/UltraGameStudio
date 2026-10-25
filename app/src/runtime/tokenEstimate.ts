/** Shared heuristic for preflight budgets; provider-reported usage remains authoritative. */
export function estimateTokenCount(text: string): number {
  if (!text.trim()) return 0;
  const cjk = text.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g)?.length ?? 0;
  const ascii = Math.max(0, text.length - cjk);
  return Math.ceil(cjk * 1.25 + ascii / 4);
}
