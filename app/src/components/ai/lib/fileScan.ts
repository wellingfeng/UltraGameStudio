/**
 * CONTRACT: scanFileRefs(text) -> Array<string | FileRef>
 *
 * Splits a run of prose into alternating plain-text strings and detected file
 * references, so a bare `Sidebar.tsx` or `app/src/store/useStore.ts:42` sitting
 * in ordinary text (not inside backticks or a markdown link) can be rendered as
 * a clickable chip.
 *
 * Detection scans for maximal runs of path-ish characters, including Unicode
 * letters for generated filenames such as `Moon亮晶分析.html`. Each run is
 * trimmed of trailing sentence
 * punctuation, then validated by {@link parseFileRef}, which stays strict (known
 * extension or a real separator) so prose like `2.0` or `react.useState` is
 * never matched. The colon introducing a `:line` suffix is preserved.
 */

import { parseFileRef, type FileRef } from './filePath';

export type FileScanPart = string | FileRef;

// A maximal run of path-ish characters. Whitespace, quotes, pipes, and most
// punctuation end the run; parseFileRef keeps false positives low.
const PATH_RUN = /[\p{L}\p{N}._~$@+%\-/\\:#]+/gu;

// Trailing punctuation to peel off a token before validation (but NOT a digit
// after ':' — that is a line number). We only strip from the very end.
const TRAILING = /[.,;:!?]+$/;

/** Cheap whole-string gate: does the text contain any path-ish punctuation? */
function mightContainPath(text: string): boolean {
  return text.includes('.') || /[\\/]/.test(text);
}

export function scanFileRefs(text: string): FileScanPart[] {
  if (!mightContainPath(text)) return [text];

  const out: FileScanPart[] = [];
  let cursor = 0;

  const pushText = (s: string) => {
    if (!s) return;
    const last = out[out.length - 1];
    if (typeof last === 'string') out[out.length - 1] = last + s;
    else out.push(s);
  };

  PATH_RUN.lastIndex = 0;
  for (let m = PATH_RUN.exec(text); m; m = PATH_RUN.exec(text)) {
    const run = m[0];
    const start = m.index;

    // Peel trailing sentence punctuation, but never strip a `:NN` line suffix.
    let core = run;
    let trailing = '';
    const hasLineSuffix = /[:#]L?\d/.test(core);
    if (!hasLineSuffix) {
      const tm = core.match(TRAILING);
      if (tm) {
        trailing = tm[0];
        core = core.slice(0, core.length - trailing.length);
      }
    }

    const ref = core.length > 1 ? parseFileRef(core) : null;
    if (ref) {
      pushText(text.slice(cursor, start));
      out.push(ref);
      if (trailing) pushText(trailing);
      cursor = start + run.length;
    }
    // No match: leave the run in the pending plain-text span (flushed below).
  }

  pushText(text.slice(cursor));

  // Collapse to the original string when nothing matched (lets callers skip the
  // chip path entirely).
  if (out.length === 0) return [text];
  if (out.length === 1 && typeof out[0] === 'string') return [text];
  return out;
}

/** True when the text contains at least one detectable file reference. */
export function hasFileRef(text: string): boolean {
  return scanFileRefs(text).some((p) => typeof p !== 'string');
}
