/**
 * CONTRACT: buildIgnoreMatcher(sources) -> (path) => boolean
 *
 * A tiny, dependency-free matcher for VCS ignore files — `.gitignore`,
 * `.p4ignore`, and `.svnignore` (a.k.a. the `svn:ignore` glob syntax). It is
 * used by the "session files" panel to HIDE files that are not under version
 * control, WITHOUT ever calling git / p4 / svn. We only ever READ the ignore
 * files' text and match locally, so there is zero VCS traffic.
 *
 * Supported syntax (gitignore semantics, the common superset):
 *   - blank lines and `#` comments are skipped
 *   - `!pattern` negates (un-ignores) a previously matched path
 *   - a trailing `/` marks a directory-only pattern
 *   - a leading `/` anchors the pattern to the ignore file's own directory
 *   - `*` matches within a path segment, `**` spans segments, `?` one char
 *   - `[abc]` / `[a-z]` character classes
 *   - patterns without a slash (other than a trailing one) match at ANY depth
 *
 * `.p4ignore` shares gitignore syntax for our purposes. `svn:ignore` is a
 * plain glob-per-line list with no `!`, `/`, or `**`; those simply never
 * appear there, so the same engine handles it as a strict subset.
 *
 * Pure module (no react / zustand / tauri) so it is unit-testable in isolation.
 */

/** One parsed ignore rule. */
interface IgnoreRule {
  /** Compiled matcher against a normalised, root-relative POSIX path. */
  re: RegExp;
  /** `!pattern` — flips the decision when it matches. */
  negated: boolean;
  /** Trailing-slash patterns only ignore directories; we treat files leniently. */
  dirOnly: boolean;
}

/** A single ignore file: its rules plus the dir (relative to root) it governs. */
export interface IgnoreSource {
  /**
   * POSIX-style directory of the ignore file, RELATIVE to the workspace root,
   * '' for a root-level ignore file. Rules only apply to paths under here.
   */
  baseDir: string;
  /** Raw file contents (one pattern per line). */
  content: string;
}

/** Normalise any path to lowercase POSIX with no leading `./` or trailing `/`. */
function normalizePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * Translate a single gitignore glob into a RegExp source that matches a
 * root-relative POSIX path. `anchored` means the pattern was tied to baseDir
 * (had an interior or leading slash); otherwise it may match at any depth.
 */
function globToRegExpSource(pattern: string, anchored: boolean): string {
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**` — spans path segments. Consume an optional following slash.
        i += 1;
        if (pattern[i + 1] === '/') i += 1;
        re += '(?:.*/)?';
      } else {
        // `*` — anything but a separator.
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if (ch === '[') {
      // Character class — copy through to the matching `]`.
      let j = i + 1;
      if (pattern[j] === '!') j += 1; // gitignore uses `[!...]`; regex wants `[^...]`
      if (pattern[j] === ']') j += 1;
      while (j < pattern.length && pattern[j] !== ']') j += 1;
      if (j >= pattern.length) {
        // Unterminated class → treat `[` literally.
        re += '\\[';
      } else {
        let body = pattern.slice(i + 1, j);
        if (body.startsWith('!')) body = `^${body.slice(1)}`;
        re += `[${body}]`;
        i = j;
      }
    } else {
      // Escape every regex metachar.
      re += ch.replace(/[.+^${}()|\\]/g, '\\$&');
    }
  }

  // An unanchored pattern (no interior slash) may sit at any directory depth.
  const prefix = anchored ? '' : '(?:.*/)?';
  // Allow the rule to match a directory and everything beneath it.
  return `^${prefix}${re}(?:/.*)?$`;
}

/** Parse one ignore-file line into a rule, or null for blanks/comments. */
function parseLine(rawLine: string, baseDir: string): IgnoreRule | null {
  // Strip a trailing CR (CRLF files) and surrounding spaces, but keep escaped
  // trailing spaces — rare enough that we ignore that gitignore subtlety.
  let line = rawLine.replace(/\r$/, '').replace(/^\s+/, '').replace(/\s+$/, '');
  if (!line || line.startsWith('#')) return null;

  let negated = false;
  if (line.startsWith('!')) {
    negated = true;
    line = line.slice(1);
  }
  // `\#` / `\!` escape a literal leading marker.
  if (line.startsWith('\\#') || line.startsWith('\\!')) line = line.slice(1);
  if (!line) return null;

  let dirOnly = false;
  if (line.endsWith('/')) {
    dirOnly = true;
    line = line.slice(0, -1);
  }

  // A leading or interior slash anchors the pattern to baseDir; otherwise it
  // floats to any depth. A trailing-only slash does NOT anchor.
  const interiorSlash = line.replace(/\/$/, '').includes('/');
  const anchored = interiorSlash;
  const cleaned = line.replace(/^\/+/, '');
  if (!cleaned) return null;

  const base = baseDir ? `${normalizePath(baseDir)}/` : '';
  const baseSource = base.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = globToRegExpSource(cleaned.toLowerCase(), anchored);
  // Splice the (already-anchored) body onto the baseDir prefix.
  const source = anchored
    ? body.replace(/^\^/, `^${baseSource}`)
    : base
      ? body.replace(/^\^\(\?:\.\*\/\)\?/, `^${baseSource}(?:.*/)?`)
      : body;

  return { re: new RegExp(source), negated, dirOnly };
}

/** Build the rule list from a set of ignore files. */
function compileRules(sources: IgnoreSource[]): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const source of sources) {
    const lines = source.content.split('\n');
    for (const line of lines) {
      const rule = parseLine(line, source.baseDir);
      if (rule) rules.push(rule);
    }
  }
  return rules;
}

/**
 * Build a predicate that returns true when a ROOT-RELATIVE path should be
 * ignored (i.e. hidden because it is not tracked). Later rules win, and a
 * negation (`!`) can rescue a path an earlier rule ignored — matching git's
 * last-match-wins semantics. Returns a function that always says "not ignored"
 * when there are no rules.
 */
export function buildIgnoreMatcher(
  sources: IgnoreSource[],
): (relativePath: string) => boolean {
  const rules = compileRules(sources);
  if (rules.length === 0) return () => false;

  return (relativePath: string): boolean => {
    const path = normalizePath(relativePath);
    if (!path) return false;
    let ignored = false;
    for (const rule of rules) {
      if (rule.re.test(path)) {
        ignored = !rule.negated;
      }
    }
    return ignored;
  };
}

/** The ignore-file basenames we read (never via a VCS command — plain reads). */
export const IGNORE_FILE_NAMES = ['.gitignore', '.p4ignore', '.svnignore'] as const;
