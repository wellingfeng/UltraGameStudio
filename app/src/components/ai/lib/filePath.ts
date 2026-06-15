/**
 * CONTRACT: pure helpers that detect/parse local file references in AI prose.
 *
 *   parseFileRef(s)  -> { path, basename, startLine?, endLine?, col? } | null
 *   looksLikePath(s) -> boolean   (cheap pre-filter before parseFileRef)
 *
 * Recognises the canonical `path:line:column` form plus `#L` anchors and line
 * ranges (`file.ts:10-20`, `file.ts#L10-L20`), and is Windows-drive aware so a
 * leading `C:\...` drive colon is not mistaken for the `:line` delimiter.
 *
 * Heuristics (load-bearing — keep false positives near zero so ordinary prose
 * like "version 2.0" or ratios like "16:9" never render as file chips):
 *   - the path part must contain a path separator OR end in a real-looking
 *     extension (1-8 word chars),
 *   - the whole token must match start-to-end (no partial matches inside words),
 *   - line/column, when present, are pure digits.
 */

export interface FileRef {
  /** The path portion, verbatim (may be relative, absolute, or Windows-style). */
  path: string;
  /** Last path segment, used as the chip label. */
  basename: string;
  /** 1-based start line, when the token carried `:line` / `#Lline`. */
  startLine?: number;
  /** End of a line range, when the token carried `:a-b` / `#La-Lb`. */
  endLine?: number;
  /** 1-based column, when the token carried `:line:col`. */
  col?: number;
}

export function fileRefLineSuffix(ref: Pick<FileRef, 'startLine' | 'endLine'>): string {
  return ref.startLine
    ? `:${ref.startLine}${ref.endLine ? `-${ref.endLine}` : ''}`
    : '';
}

export function isAbsoluteFileRefPath(path: string): boolean {
  return /^(?:[A-Za-z]:[/\\]|[/\\]|\\\\|~[/\\]|\$\w+[/\\])/.test(path.trim());
}

export function displayFileRefPath(ref: FileRef, cwd?: string): string {
  const path = ref.path.trim();
  const root = cwd?.trim().replace(/[\\/]+$/, '') ?? '';
  if (!path || !root || isAbsoluteFileRefPath(path)) return ref.path;

  const separator = root.includes('\\') ? '\\' : '/';
  const relative = path.replace(/^\.[/\\]+/, '');
  const normalizedRelative =
    separator === '\\' ? relative.replace(/\//g, '\\') : relative.replace(/\\/g, '/');

  return `${root}${separator}${normalizedRelative}`;
}

export function displayFileRefLabel(ref: FileRef, cwd?: string): string {
  return `${displayFileRefPath(ref, cwd)}${fileRefLineSuffix(ref)}`;
}

export interface FileRefParseOptions {
  /** Markdown links / inline code are explicit file surfaces, so spaces are OK. */
  allowSpaces?: boolean;
}

// path  :  (windows drive prefix | anything not : or #)   then optional :line[:col] or -range or #Lline
const FILE_REF =
  /^([A-Za-z]:[^:#\r\n]*|[^:#\r\n]+?)(?:[:#]L?(\d+)(?:[-:]L?(\d+))?)?$/;

/**
 * Known source/code/config/doc/image extensions. A token WITHOUT a path
 * separator must end in one of these to count as a file (so prose like `2.0`,
 * `1.5.0`, or `react.useState` is never mistaken for a path). Tokens WITH a
 * separator are usually accepted; Unicode prose with a stray slash still needs
 * a known filename identity.
 */
const KNOWN_EXT = new Set([
  // web / js / ts
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc',
  'json5', 'map', 'webmanifest', 'ipynb', 'html', 'htm', 'xhtml', 'shtml',
  'xht', 'hta', 'mht', 'mhtml', 'mjml', 'css', 'scss', 'sass', 'less',
  'pcss', 'postcss', 'styl', 'vue', 'svelte', 'astro',
  // backend / systems
  'rs', 'go', 'py', 'rb', 'java', 'kt', 'kts', 'c', 'h', 'cc', 'cpp', 'cxx',
  'c++', 'hh', 'hpp', 'hxx', 'h++', 'mm', 'cs', 'fs', 'fsx', 'vb',
  'php', 'phtml', 'swift', 'scala', 'sc', 'groovy', 'gvy', 'clj', 'cljs',
  'cljc', 'edn', 'ex', 'exs', 'erl', 'hrl', 'dart', 'lua', 'r', 'jl', 'nim',
  'zig', 'odin', 'vala', 'pas', 'pp', 'inc', 'asm', 'ml', 'mli', 'hs', 'lhs',
  'elm', 'sol', 'move',
  // API / schema / DB
  'sql', 'graphql', 'gql', 'proto', 'thrift', 'avsc', 'prisma',
  // shell / config / data
  'sh', 'bash', 'zsh', 'fish', 'ksh', 'ps1', 'psm1', 'psd1', 'bat', 'cmd',
  'awk', 'sed', 'toml', 'yaml', 'yml', 'ini', 'cfg', 'conf', 'config',
  'properties', 'props', 'targets', 'env', 'envrc', 'lock', 'hcl', 'tf',
  'tfvars', 'nomad', 'rego', 'nix', 'dhall', 'ron', 'plist', 'desktop',
  'service', 'timer', 'xml', 'xsd', 'xsl', 'xslt', 'dtd', 'rss', 'atom',
  'wsdl', 'csproj', 'fsproj', 'vbproj', 'vcxproj',
  // text data / docs
  'csv', 'tsv', 'ssv', 'psv', 'ndjson', 'jsonl', 'geojson', 'topojson',
  'har', 'http', 'rest', 'md', 'mdx', 'txt', 'text', 'rst', 'adoc',
  'asciidoc', 'markdown', 'mkd', 'mkdn', 'mdown', 'mdwn', 'mdtxt',
  'mdtext', 'rmd', 'qmd', 'tex', 'ltx', 'bib', 'org', 'wiki', 'log',
  'patch', 'diff', 'rej', 'mmd', 'mermaid', 'puml', 'plantuml', 'dot', 'gv',
  'drawio', 'dio', 'prompt', 'prompty',
  // templates / build files
  'ejs', 'hbs', 'handlebars', 'mustache', 'njk', 'jinja', 'jinja2', 'twig',
  'liquid', 'erb', 'haml', 'pug', 'jade', 'cshtml', 'razor', 'cmake', 'mak',
  'mk', 'bazel', 'bzl', 'buck', 'gradle', 'tpl', 'tmpl', 'snippet',
  'snippets', 'code-snippets', 'code-workspace', 'sublime-project',
  'sublime-workspace', 'rules', 'mdc',
  // shaders / GPU
  'glsl', 'vert', 'frag', 'geom', 'tesc', 'tese', 'comp', 'hlsl', 'fx', 'fxh',
  'wgsl', 'metal', 'shader', 'slang',
  // browser-previewable images
  'png', 'apng', 'jpg', 'jpeg', 'jpe', 'jfif', 'pjpeg', 'pjp', 'gif', 'webp',
  'bmp', 'dib', 'ico', 'cur', 'svg', 'avif',
  // 3D model assets
  'glb', 'gltf', 'obj', 'stl', 'fbx', 'ply', 'usdz', 'blend',
]);

const KNOWN_BASENAME = new Set([
  '.babelrc', '.browserslistrc', '.dockerignore', '.editorconfig',
  '.eslintignore', '.eslintrc', '.gitattributes', '.gitignore', '.gitmodules',
  '.npmrc', '.prettierignore', '.prettierrc', '.stylelintrc', '.yarnrc',
  'brewfile', 'containerfile', 'dockerfile', 'gemfile', 'justfile', 'makefile',
  'podfile', 'procfile', 'rakefile', 'taskfile', 'vagrantfile',
  'cmakelists.txt', 'go.mod', 'go.sum', 'pipfile', 'pipfile.lock',
  'poetry.lock', 'readme', 'license', 'licence', 'copying', 'notice',
  'changelog', 'changes', 'authors', 'contributors', 'todo',
]);

function basenameFromToken(token: string): string {
  const noLine = token.split(/[:#]/, 1)[0]; // drop any :line / #L suffix
  const clean = noLine.replace(/[\\/]+$/, '');
  const idx = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  return idx === -1 ? clean : clean.slice(idx + 1);
}

function extensionOf(token: string): string | null {
  const base = basenameFromToken(token);
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return null;
  return base.slice(dot + 1).toLowerCase();
}

function knownBasename(token: string): boolean {
  const base = basenameFromToken(token).toLowerCase();
  if (!base) return false;
  return (
    KNOWN_BASENAME.has(base) ||
    /^\.env(?:[.-].+)?$/.test(base) ||
    /^(?:readme|license|licence|copying|notice|changelog|changes|todo)(?:[._-].+)?$/.test(
      base,
    )
  );
}

function decodePercentPath(raw: string): string {
  if (!raw.includes('%')) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function stripFileMentionPrefix(path: string): string {
  return path.startsWith('@') ? path.slice(1) : path;
}

function pathFromFileUrl(raw: string): string | null {
  if (!/^file:\/\//i.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'file:') return null;
    let path = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    if (url.hostname) path = `//${url.hostname}${path}`;
    if (/^#L?\d/i.test(url.hash)) path += url.hash;
    return path;
  } catch {
    return null;
  }
}

/** Cheap pre-filter: reject obvious non-paths before the precise regex. */
export function looksLikePath(raw: string, opts: FileRefParseOptions = {}): boolean {
  const s = decodePercentPath(raw.trim());
  if (!s || s.length > 240) return false;
  if (!opts.allowSpaces && /\s/.test(s)) return false;
  const fileUrlPath = pathFromFileUrl(s);
  if (fileUrlPath) return looksLikePath(fileUrlPath, opts);
  const candidate = stripFileMentionPrefix(s);
  if (!candidate) return false;
  if (/^[a-z]+:\/\//i.test(candidate)) return false; // url scheme -> not a file chip
  if (/[\\/]/.test(candidate)) return true; // a path separator is strong evidence
  // No separator: require a recognised file extension so `2.0` / `react.foo`
  // are not mistaken for files, or a known extensionless config/build filename.
  const ext = extensionOf(candidate);
  return (ext != null && KNOWN_EXT.has(ext)) || knownBasename(candidate);
}

function basenameOf(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, '');
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return idx === -1 ? cleaned : cleaned.slice(idx + 1);
}

function hasKnownFileIdentity(path: string): boolean {
  return KNOWN_EXT.has(extensionOf(path) ?? '') || knownBasename(path);
}

function containsNonAscii(path: string): boolean {
  return Array.from(path).some((ch) => ch.charCodeAt(0) > 0x7f);
}

/**
 * Parse a candidate token into a {@link FileRef}, or return null when it is not
 * a plausible local file reference. The path part must look like a file (see
 * {@link looksLikePath}); a bare word such as `config` is rejected, while
 * `config.ts`, `./config`, or `src/store/useStore.ts:42` are accepted.
 */
export function parseFileRef(
  raw: string,
  opts: FileRefParseOptions = {},
): FileRef | null {
  const trimmed = raw.trim();
  const s = pathFromFileUrl(trimmed) ?? decodePercentPath(trimmed);
  if (!looksLikePath(s, opts)) return null;
  const candidate = stripFileMentionPrefix(s);

  const m = FILE_REF.exec(candidate);
  if (!m) return null;

  const rawPath = m[1];
  const path = rawPath;
  // The path on its own must still look like a file (the line/col may have
  // consumed a trailing number, so re-check the captured path part): a
  // separator, or a recognised file extension.
  const hasSep = /[\\/]/.test(path);
  const knownFile = hasKnownFileIdentity(path);
  if (!hasSep && !knownFile) {
    return null;
  }
  if (hasSep && !knownFile && containsNonAscii(path)) {
    return null;
  }

  const basename = basenameOf(path);
  if (!basename) return null; // e.g. "C:\" — nothing to label the chip with

  const startLine = m[2] ? Number(m[2]) : undefined;
  const second = m[3] ? Number(m[3]) : undefined;

  // `a:b:c` => line:col ; `a:b-c` / `a#La-Lb` => line range. We disambiguate by
  // the separator the regex matched: `-` means range, `:`/`#` second means col.
  // The regex collapses both into group 3, so decide from the raw string.
  let endLine: number | undefined;
  let col: number | undefined;
  if (second !== undefined) {
    const tail = candidate.slice(rawPath.length);
    if (/-/.test(tail)) endLine = second;
    else col = second;
  }

  return {
    path,
    basename,
    startLine,
    endLine,
    col,
  };
}
