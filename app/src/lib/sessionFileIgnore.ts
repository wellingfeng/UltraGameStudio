/**
 * CONTRACT: buildSessionIgnorePredicate(roots) -> (path) => boolean
 *
 * Glue between the pure ignore matcher (ignoreRules.ts) and the session-files
 * panel. Given one matcher per workspace root, it produces a predicate that
 * decides whether a file the AI touched should be HIDDEN because it is not
 * under version control. All matching is local and pure — no git / p4 / svn.
 *
 * Session paths arrive verbatim from tool events: some absolute (under a known
 * root), some already relative. For each root we relativise the path and test
 * it against that root's matcher; a hit under ANY root hides the file.
 *
 * Pure module (no react / zustand / tauri) so it is unit-testable in isolation.
 */

import { buildIgnoreMatcher, type IgnoreSource } from './ignoreRules';

/** A workspace root plus the ignore matcher compiled from its ignore files. */
export interface SessionIgnoreRoot {
  /** Absolute workspace root path (any separator style). */
  root: string;
  /** Predicate over a root-relative path, from buildIgnoreMatcher. */
  matcher: (relativePath: string) => boolean;
}

function toPosixLower(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function isAbsolute(path: string): boolean {
  return /^(?:[a-z]:\/|\/|\\\\)/i.test(path.replace(/\\/g, '/'));
}

/**
 * Return `path` expressed relative to `root` (POSIX, original case preserved),
 * or null when `path` is absolute but not located under `root`. A path that is
 * already relative is returned unchanged (it applies to every root).
 */
export function relativizePath(path: string, root: string): string | null {
  const posixPath = path.replace(/\\/g, '/');
  if (!isAbsolute(posixPath)) return posixPath.replace(/^\.\/+/, '');

  const normRoot = toPosixLower(root);
  if (!normRoot) return null;
  const lowerPath = posixPath.toLowerCase();
  if (lowerPath === normRoot) return '';
  if (!lowerPath.startsWith(`${normRoot}/`)) return null;
  // Slice using the original-case string to keep the relative path readable.
  return posixPath.slice(normRoot.length + 1);
}

/**
 * Build the panel's ignore predicate from per-root matchers. A path is hidden
 * when, for some root it belongs to, that root's matcher flags its relative
 * path. With no roots the predicate hides nothing.
 */
export function buildSessionIgnorePredicate(
  roots: SessionIgnoreRoot[],
): (path: string) => boolean {
  if (roots.length === 0) return () => false;
  return (path: string): boolean => {
    for (const { root, matcher } of roots) {
      const relative = relativizePath(path, root);
      if (relative === null || relative === '') continue;
      if (matcher(relative)) return true;
    }
    return false;
  };
}

/** Convenience: build a single-root matcher from raw ignore-file contents. */
export function sessionIgnoreRootFromContents(
  root: string,
  contents: string[],
): SessionIgnoreRoot {
  const sources: IgnoreSource[] = contents
    .filter((content) => content.trim().length > 0)
    .map((content) => ({ baseDir: '', content }));
  return { root, matcher: buildIgnoreMatcher(sources) };
}
