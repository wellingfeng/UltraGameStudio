/**
 * CONTRACT: protectWindowsPaths(md) -> md with Windows path backslashes doubled.
 *
 * CommonMark treats a backslash before ASCII punctuation as an escape and drops
 * it (`\.` -> `.`, `\(` -> `(`). A Windows path such as
 * `E:\OpenWorkflow\.omc\clipboard-images\shot.png` therefore renders as
 * `E:\OpenWorkflow.omc\clipboard-images\shot.png` — the `\.` segment loses its
 * separator, so the resulting file chip points at a path that does not exist and
 * the in-app preview fails to open. (Clipboard images always live under `\.omc\`,
 * so every pasted screenshot path hits this.)
 *
 * This pure pre-pass finds Windows-style path tokens (drive-letter `X:\…` and
 * UNC `\\server\…`) outside code regions and doubles their backslashes. CommonMark
 * then collapses each `\\` back to a single literal `\`, so the chip and preview
 * see the original path. Code fences and inline code are masked out first because
 * backslashes there are already literal and must not be touched.
 */

const FENCE = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]*`/g;

// A Windows path token: a drive-letter path (`E:\…`) or a UNC path (`\\host\…`),
// followed by a run of path-ish characters. Backslashes inside the token are the
// separators we need to protect. We stop the run at whitespace and characters
// that never appear unescaped inside a path token.
const WIN_PATH = /(?:[A-Za-z]:\\|\\\\)[^\s"'`<>|?*\r\n]*/g;

// Opaque placeholder (private-use char) to mask code spans during the rewrite.
const MARK = '';

/**
 * Double the backslashes in Windows-style path tokens so CommonMark's
 * escape-collapse leaves them intact. Returns the input unchanged when it
 * contains no backslash (the common case for non-Windows output).
 */
export function protectWindowsPaths(md: string): string {
  if (!md.includes('\\')) return md;

  const stash: string[] = [];
  const mask = (s: string): string => {
    stash.push(s);
    return `${MARK}${stash.length - 1}${MARK}`;
  };

  let out = md.replace(FENCE, mask).replace(INLINE_CODE, mask);

  out = out.replace(WIN_PATH, (token) => token.replace(/\\/g, '\\\\'));

  out = out.replace(
    new RegExp(`${MARK}(\\d+)${MARK}`, 'g'),
    (_m, i: string) => stash[Number(i)] ?? _m,
  );
  return out;
}
