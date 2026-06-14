import {
  BACKUPS_DIR_NAME,
  DEFAULT_WORKSPACE_ID,
  DEFAULT_WORKSPACE_NAME,
  DELETED_DIR_NAME,
  HISTORY_ROOT_DIR,
  LEGACY_SESSION_ID_PATTERN,
  LEGACY_WORKSPACE_ID_PATTERN,
  MIGRATION_SESSION_ID_PREFIX,
  MIGRATIONS_DIR_NAME,
  QUARANTINE_DIR_NAME,
  ROOT_CONFIG_FILE,
  ROOT_INDEX_FILE,
  SESSION_ID_PATTERN,
  SESSIONS_DIR_NAME,
  SESSIONS_INDEX_FILE,
  TMP_DIR_NAME,
  UNASSIGNED_WORKSPACE_ID,
  UNASSIGNED_WORKSPACE_NAME,
  WORKSPACE_FILE,
  WORKSPACE_ID_PATTERN,
} from './constants';

const WINDOWS_RESERVED_BASENAME_PATTERN =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

interface ParsedWindowsPath {
  kind: 'drive' | 'unc' | 'relative';
  prefix: string;
  drive?: string;
  uncShare?: string;
  segments: string[];
}

interface ParsedPosixPath {
  kind: 'absolute' | 'home' | 'relative';
  prefix: string;
  segments: string[];
}

type ParsedWorkspacePath =
  | (ParsedWindowsPath & { family: 'windows' })
  | (ParsedPosixPath & { family: 'posix' });

function normalizePathSegments(segments: string[]): string[] {
  const normalized: string[] = [];

  for (const rawSegment of segments) {
    const segment = rawSegment.trim();
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      normalized.pop();
      continue;
    }
    normalized.push(segment);
  }

  return normalized;
}

function parseWindowsPath(input: string): ParsedWindowsPath {
  const slashed = input.trim().replace(/\//g, '\\');
  if (!slashed) {
    return { kind: 'relative', prefix: '', segments: [] };
  }

  if (slashed.startsWith('\\\\')) {
    const parts = slashed.slice(2).split('\\').filter(Boolean);
    const server = parts.shift() ?? '';
    const share = parts.shift() ?? '';
    return {
      kind: 'unc',
      prefix: server && share ? `\\\\${server}\\${share}` : '\\\\',
      uncShare: share,
      segments: normalizePathSegments(parts),
    };
  }

  const driveMatch = /^([a-zA-Z]):(.*)$/u.exec(slashed);
  if (driveMatch) {
    const drive = driveMatch[1].toUpperCase();
    const rest = driveMatch[2].replace(/^\\+/u, '');
    return {
      kind: 'drive',
      prefix: `${drive}:\\`,
      drive,
      segments: normalizePathSegments(rest.split('\\')),
    };
  }

  return {
    kind: 'relative',
    prefix: '',
    segments: normalizePathSegments(slashed.split('\\')),
  };
}

function joinParsedPath(parsed: ParsedWindowsPath): string {
  const tail = parsed.segments.join('\\');
  if (!parsed.prefix) return tail;
  if (!tail) return parsed.prefix;
  return parsed.prefix.endsWith('\\')
    ? `${parsed.prefix}${tail}`
    : `${parsed.prefix}\\${tail}`;
}

function parsePosixPath(input: string): ParsedPosixPath {
  const slashed = input.trim().replace(/\\/g, '/');
  if (!slashed) {
    return { kind: 'relative', prefix: '', segments: [] };
  }

  if (slashed === '~' || slashed.startsWith('~/')) {
    return {
      kind: 'home',
      prefix: '~',
      segments: normalizePathSegments(slashed.slice(2).split('/')),
    };
  }

  if (slashed.startsWith('/')) {
    return {
      kind: 'absolute',
      prefix: '/',
      segments: normalizePathSegments(slashed.split('/')),
    };
  }

  return {
    kind: 'relative',
    prefix: '',
    segments: normalizePathSegments(slashed.split('/')),
  };
}

function joinParsedPosixPath(parsed: ParsedPosixPath): string {
  const tail = parsed.segments.join('/');
  if (parsed.prefix === '/') return tail ? `/${tail}` : '/';
  if (parsed.prefix === '~') return tail ? `~/${tail}` : '~';
  return tail;
}

/**
 * Opaque (non-filesystem) workspace identifiers such as `remote://<id>` must
 * survive identity/name normalization verbatim — they are not real paths and
 * the POSIX/Windows parsers would corrupt the scheme separator. Returns the
 * trimmed value when the input uses such a scheme, otherwise ''.
 */
function opaqueSchemePath(input: string): string {
  const trimmed = input.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : '';
}

function parseWorkspacePath(input: string): ParsedWorkspacePath {
  const trimmed = input.trim();
  if (
    /^([a-zA-Z]):/u.test(trimmed) ||
    trimmed.startsWith('\\\\') ||
    trimmed.includes('\\')
  ) {
    return { family: 'windows', ...parseWindowsPath(trimmed) };
  }
  return { family: 'posix', ...parsePosixPath(trimmed) };
}

function joinParsedWorkspacePath(parsed: ParsedWorkspacePath): string {
  return parsed.family === 'windows'
    ? joinParsedPath(parsed)
    : joinParsedPosixPath(parsed);
}

function leftRotate(value: number, bits: number): number {
  return (value << bits) | (value >>> (32 - bits));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function sha1Bytes(input: Uint8Array): Uint8Array {
  const bitLength = input.length * 8;
  const bufferLength = Math.ceil((input.length + 9) / 64) * 64;
  const buffer = new Uint8Array(bufferLength);
  buffer.set(input);
  buffer[input.length] = 0x80;

  const view = new DataView(buffer.buffer);
  view.setUint32(bufferLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(bufferLength - 4, bitLength >>> 0, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const words = new Uint32Array(80);

  for (let offset = 0; offset < bufferLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      words[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 80; i += 1) {
      words[i] = leftRotate(
        words[i - 3] ^ words[i - 8] ^ words[i - 14] ^ words[i - 16],
        1,
      );
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let i = 0; i < 80; i += 1) {
      let f = 0;
      let k = 0;

      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }

      const temp = (leftRotate(a, 5) + f + e + k + words[i]) >>> 0;
      e = d;
      d = c;
      c = leftRotate(b, 30) >>> 0;
      b = a;
      a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const digest = new Uint8Array(20);
  const digestView = new DataView(digest.buffer);
  digestView.setUint32(0, h0, false);
  digestView.setUint32(4, h1, false);
  digestView.setUint32(8, h2, false);
  digestView.setUint32(12, h3, false);
  digestView.setUint32(16, h4, false);
  return digest;
}

export async function sha1Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await globalThis.crypto?.subtle?.digest('SHA-1', bytes);
  return digest
    ? bytesToHex(new Uint8Array(digest))
    : bytesToHex(sha1Bytes(bytes));
}

export function normalizeWorkspaceIdentityPath(input: string): string {
  const opaque = opaqueSchemePath(input);
  if (opaque) return opaque;
  return joinParsedWorkspacePath(parseWorkspacePath(input));
}

export function workspaceIdentityHashInput(input: string): string {
  const opaque = opaqueSchemePath(input);
  if (opaque) return opaque;
  const parsed = parseWorkspacePath(input);
  const normalized = joinParsedWorkspacePath(parsed);
  return parsed.family === 'windows'
    ? normalized.toLocaleLowerCase('en-US')
    : normalized;
}

/** Legacy deterministic id helper for records imported from path-keyed storage. */
export async function deriveWorkspaceId(input: string): Promise<string> {
  const hashInput = workspaceIdentityHashInput(input);
  if (!hashInput) return DEFAULT_WORKSPACE_ID;
  return (await sha1Hex(hashInput)).slice(0, 16);
}

export function isWorkspaceId(value: string): boolean {
  return (
    WORKSPACE_ID_PATTERN.test(value) || LEGACY_WORKSPACE_ID_PATTERN.test(value)
  );
}

export function isCanonicalWorkspaceId(value: string): boolean {
  return WORKSPACE_ID_PATTERN.test(value);
}

export function isLegacyWorkspaceId(value: string): boolean {
  return LEGACY_WORKSPACE_ID_PATTERN.test(value);
}

export function assertWorkspaceId(value: string): string {
  if (!isWorkspaceId(value)) {
    throw new Error(`Invalid workspaceId: ${value}`);
  }
  return value;
}

export function normalizeWorkspaceId(value: string | null | undefined): string {
  const id = value?.trim();
  if (!id || id === UNASSIGNED_WORKSPACE_ID) return DEFAULT_WORKSPACE_ID;
  return id;
}

export function isSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value) || LEGACY_SESSION_ID_PATTERN.test(value);
}

export function isCanonicalSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}

export function isLegacySessionId(value: string): boolean {
  return LEGACY_SESSION_ID_PATTERN.test(value);
}

export function assertSessionId(value: string): string {
  if (!isSessionId(value)) {
    throw new Error(`Invalid sessionId: ${value}`);
  }
  return value;
}

export function isMigrationSessionId(value: string): boolean {
  return value.startsWith(MIGRATION_SESSION_ID_PREFIX) && isSessionId(value);
}

export function workspaceLeafName(input: string): string {
  const opaque = opaqueSchemePath(input);
  if (opaque) return opaque;
  const parsed = parseWorkspacePath(input);
  const lastSegment = parsed.segments[parsed.segments.length - 1];
  if (lastSegment) return lastSegment;
  if (parsed.family === 'windows') {
    if (parsed.kind === 'unc' && parsed.uncShare) return parsed.uncShare;
    if (parsed.kind === 'drive' && parsed.drive) return parsed.drive;
  }
  if (parsed.family === 'posix' && parsed.kind === 'home') return '~';
  return DEFAULT_WORKSPACE_NAME;
}

export function escapeHistoryPathSegment(value: string): string {
  const fallback = value.trim() || DEFAULT_WORKSPACE_NAME;
  const escaped = Array.from(fallback)
    .map((char) =>
      /^[A-Za-z0-9 ._-]$/u.test(char) ? char : encodeURIComponent(char),
    )
    .join('')
    .replace(/[. ]+$/u, (suffix) =>
      Array.from(suffix)
        .map((char) => encodeURIComponent(char))
        .join(''),
    );

  return WINDOWS_RESERVED_BASENAME_PATTERN.test(escaped)
    ? `${escaped}_`
    : escaped;
}

export function escapeWorkspaceLeaf(leafName: string): string {
  return escapeHistoryPathSegment(leafName || UNASSIGNED_WORKSPACE_NAME);
}

/** Canonical workspace directories are exactly the workspace id. */
export function workspaceDirectoryName(workspaceId: string): string {
  return assertWorkspaceId(normalizeWorkspaceId(workspaceId));
}

/** Legacy display-oriented directory name retained for migration tooling. */
export function buildWorkspaceDirectoryName(
  leafName: string,
  workspaceId: string,
): string {
  return `ws_${escapeWorkspaceLeaf(leafName)}--${assertWorkspaceId(workspaceId)}`;
}

/** Legacy path-derived directory helper retained for migration tooling. */
export async function workspaceDirectoryNameFromPath(
  workspacePath: string,
): Promise<string> {
  const identityPath = normalizeWorkspaceIdentityPath(workspacePath);
  const workspaceId = await deriveWorkspaceId(identityPath);
  return buildWorkspaceDirectoryName(workspaceLeafName(identityPath), workspaceId);
}

export function isWorkspaceDirectoryName(value: string): boolean {
  if (isWorkspaceId(value)) return true;
  if (!value.startsWith('ws_')) return false;
  const separatorIndex = value.lastIndexOf('--');
  if (separatorIndex <= 'ws_'.length) return false;
  return isWorkspaceId(value.slice(separatorIndex + 2));
}

export function sessionFileName(sessionId: string): string {
  return `${assertSessionId(sessionId)}.json`;
}

export function timestampFileName(timestamp: string): string {
  return `${timestamp}.json`;
}

export async function migrationSessionIdFromSourceKey(
  sourceKey: string,
): Promise<string> {
  return `${MIGRATION_SESSION_ID_PREFIX}${(await sha1Hex(sourceKey)).slice(0, 16)}`;
}

export function formatHistoryTimestamp(date = new Date()): string {
  const year = date.getUTCFullYear().toString().padStart(4, '0');
  const month = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = date.getUTCDate().toString().padStart(2, '0');
  const hour = date.getUTCHours().toString().padStart(2, '0');
  const minute = date.getUTCMinutes().toString().padStart(2, '0');
  const second = date.getUTCSeconds().toString().padStart(2, '0');
  const millis = date.getUTCMilliseconds().toString().padStart(3, '0');
  return `${year}${month}${day}T${hour}${minute}${second}${millis}Z`;
}

export function toHistoryIsoTimestamp(date = new Date()): string {
  return date.toISOString();
}

export function joinHistoryPath(
  ...segments: Array<string | null | undefined>
): string {
  return normalizePathSegments(
    segments.flatMap((segment) => {
      if (!segment) return [];
      return segment.split(/[\\/]+/u).filter(Boolean);
    }),
  ).join('\\');
}

export function historyRootPath(
  ...segments: Array<string | null | undefined>
): string {
  const relativePath = joinHistoryPath(...segments);
  return relativePath ? `${HISTORY_ROOT_DIR}\\${relativePath}` : HISTORY_ROOT_DIR;
}

export function configPath(): string {
  return ROOT_CONFIG_FILE;
}

export function rootIndexPath(): string {
  return ROOT_INDEX_FILE;
}

export function workspacesIndexPath(): string {
  return rootIndexPath();
}

export function migrationsPath(
  ...segments: Array<string | null | undefined>
): string {
  return joinHistoryPath(MIGRATIONS_DIR_NAME, ...segments);
}

export function backupsPath(...segments: Array<string | null | undefined>): string {
  return joinHistoryPath(BACKUPS_DIR_NAME, ...segments);
}

export function quarantinePath(
  ...segments: Array<string | null | undefined>
): string {
  return joinHistoryPath(QUARANTINE_DIR_NAME, ...segments);
}

export function tmpPath(...segments: Array<string | null | undefined>): string {
  return joinHistoryPath(TMP_DIR_NAME, ...segments);
}

export function rootBackupsPath(
  ...segments: Array<string | null | undefined>
): string {
  return backupsPath(...segments);
}

export function migrationBackupsPath(
  migrationId: string,
  runId: string,
  ...segments: Array<string | null | undefined>
): string {
  return backupsPath(MIGRATIONS_DIR_NAME, migrationId, runId, ...segments);
}

export function rootTrashPath(
  ...segments: Array<string | null | undefined>
): string {
  return joinHistoryPath(DELETED_DIR_NAME, ...segments);
}

export function rootTmpPath(
  ...segments: Array<string | null | undefined>
): string {
  return tmpPath(...segments);
}

export function workspacePath(workspaceId: string): string {
  return joinHistoryPath(workspaceDirectoryName(workspaceId));
}

export function workspaceRecordPath(workspaceId: string): string {
  return joinHistoryPath(workspaceDirectoryName(workspaceId), WORKSPACE_FILE);
}

export function sessionsPath(workspaceId: string): string {
  return joinHistoryPath(workspaceDirectoryName(workspaceId), SESSIONS_DIR_NAME);
}

export function sessionsIndexPath(workspaceId: string): string {
  return joinHistoryPath(
    workspaceDirectoryName(workspaceId),
    SESSIONS_DIR_NAME,
    SESSIONS_INDEX_FILE,
  );
}

export function sessionRecordPath(
  workspaceId: string,
  sessionId: string,
): string {
  return joinHistoryPath(
    workspaceDirectoryName(workspaceId),
    SESSIONS_DIR_NAME,
    sessionFileName(sessionId),
  );
}

export function deletedSessionsPath(
  workspaceId: string,
  ...segments: Array<string | null | undefined>
): string {
  return joinHistoryPath(
    workspaceDirectoryName(workspaceId),
    DELETED_DIR_NAME,
    ...segments,
  );
}

export function deletedSessionRecordPath(
  workspaceId: string,
  sessionId: string,
): string {
  return joinHistoryPath(
    workspaceDirectoryName(workspaceId),
    DELETED_DIR_NAME,
    sessionFileName(sessionId),
  );
}

export function workspaceBackupsPath(
  workspaceId: string,
  ...segments: Array<string | null | undefined>
): string {
  return backupsPath(workspaceDirectoryName(workspaceId), ...segments);
}

export function workspaceSessionBackupPath(
  workspaceId: string,
  sessionId: string,
  timestamp: string,
): string {
  return workspaceBackupsPath(
    workspaceId,
    SESSIONS_DIR_NAME,
    assertSessionId(sessionId),
    timestampFileName(timestamp),
  );
}

export function workspaceTrashPath(
  workspaceId: string,
  ...segments: Array<string | null | undefined>
): string {
  return deletedSessionsPath(workspaceId, ...segments);
}

export function workspaceTmpPath(
  workspaceId: string,
  ...segments: Array<string | null | undefined>
): string {
  return joinHistoryPath(workspaceDirectoryName(workspaceId), TMP_DIR_NAME, ...segments);
}
