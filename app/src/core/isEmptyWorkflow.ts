import type { IRGraph } from './ir';
import { PLACEHOLDER_PROMPTS } from './defaultBlueprint';

/**
 * CONTRACT: isEmptyWorkflow(ir) -> boolean.
 *
 * True when the graph is a fresh/empty starter the user hasn't meaningfully
 * authored yet. Used by the AI input box (store.sendPrompt) to decide whether
 * to frame an instruction as "新建一个 workflow" vs "继续修改 workflow".
 *
 * A graph counts as empty when, after dropping the start/end sentinels, either:
 *   - there are no remaining nodes, or
 *   - there is exactly one `agent` node whose prompt is blank or matches a known
 *     placeholder (the default blueprint's starter step).
 *
 * Any other content (a second node, a non-agent node, a real prompt, etc.)
 * makes it a non-empty workflow.
 */
export function isEmptyWorkflow(ir: IRGraph): boolean {
  const meaningful = ir.nodes.filter(
    (n) => n.type !== 'start' && n.type !== 'end',
  );
  if (meaningful.length === 0) return true;
  if (meaningful.length > 1) return false;

  const only = meaningful[0];
  if (only.type !== 'agent') return false;

  const prompt = String(only.params?.prompt ?? '').trim();
  if (prompt === '') return true;
  return (PLACEHOLDER_PROMPTS as readonly string[]).includes(prompt);
}
