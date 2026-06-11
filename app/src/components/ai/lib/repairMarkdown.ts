/**
 * CONTRACT: repair(md) -> markdown with balanced code fences and inline ticks.
 *
 * AI output streams in token-by-token, so the last bubble is frequently
 * mid-token: an unclosed ``` fence or a dangling `inline` backtick. Feeding that
 * straight to react-markdown makes the whole subtree flip layout on every chunk
 * (a half-open fence swallows the rest of the document as code). We close the
 * dangling constructs on a *copy* of the text before parsing so the live bubble
 * renders stably; the real text in the store is never mutated.
 *
 * Pure + synchronous so it can run on every render of the streaming bubble.
 */

/**
 * Balance an odd number of ``` fences only.
 *
 * Applied on EVERY render (streaming and final), not just live bubbles: a
 * finalized message can still carry an unbalanced fence (the CLI was
 * interrupted/truncated, or the prose mentions a stray ```), and an open fence
 * swallows the rest of the document into one code block. With `rehype-highlight`
 * on for final renders, that makes the whole message render as a garbled wall of
 * syntax-highlighted text. Closing the fence is purely corrective — balanced
 * input is returned unchanged.
 */
export function repairFences(md: string): string {
  const fences = (md.match(/```/g) ?? []).length;
  if (fences % 2 === 1) {
    return md + (md.endsWith('\n') ? '' : '\n') + '```';
  }
  return md;
}

/** Balance an odd number of ``` fences and a trailing inline backtick. */
export function repairMarkdown(md: string): string {
  // 1. Close a dangling triple-fence (``` count is odd).
  let out = repairFences(md);

  // 2. Close a dangling single inline backtick. Strip complete fenced blocks
  // first (step 1 guarantees fences are now balanced) so their inner backticks
  // don't skew the inline count.
  const withoutFences = out.replace(/```[\s\S]*?```/g, '');
  const singles = (withoutFences.match(/`/g) ?? []).length;
  if (singles % 2 === 1) out += '`';

  return out;
}
