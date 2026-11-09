import type { ToolEvent } from './toolEvent';

export interface SkillActivity {
  kind: 'used' | 'read';
  name: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function skillFileName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.trim().match(/(?:^|[\\/])skills[\\/]([^\\/]+)[\\/]SKILL\.md$/i)?.[1];
}

function skillFileFromReadCommand(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const read = /\b(?:get-content|cat|type|head)\b\s+(?:-[\w-]+\s+)*['"]?([^'"\r\n;|]*?skills[\\/]([^\\/\s'";|]+)[\\/]SKILL\.md)(?=['"\s;|]|$)/i.exec(value);
  return read?.[2];
}

function resultEntry(result: string | undefined): Record<string, unknown> | undefined {
  if (!result) return undefined;
  try {
    const parsed = object(JSON.parse(result));
    const content = Array.isArray(parsed?.content) ? object(parsed.content[0]) : undefined;
    if (typeof content?.text === 'string') return resultEntry(content.text);
    return object(parsed?.entry);
  } catch {
    return undefined;
  }
}

/** Show only native calls with an explicit successful outcome, not catalog selection. */
export function skillActivity(event: ToolEvent): SkillActivity | undefined {
  if (event.status !== 'done' || event.provenance !== 'native-tool' ||
      (event.evidenceStatus !== 'success' && event.exitCode !== 0)) return undefined;
  const args = object(event.args);
  const tool = event.name.split(/[:./]/).at(-1)?.toLowerCase() ?? '';
  if (tool === 'skill') {
    const name = args?.skill ?? args?.skill_name ?? args?.name;
    if (typeof name === 'string' && /^[\w:.-]+$/.test(name.trim())) return { kind: 'used', name: name.trim() };
  }
  if (/(?:^|_)skill_view$/.test(tool)) {
    const entry = resultEntry(event.result);
    if (typeof entry?.name === 'string' && entry.name.trim()) return { kind: 'read', name: entry.name.trim() };
  }
  if (/^(?:read|read_file|file_read)$/.test(tool)) {
    const name = skillFileName(args?.file_path ?? args?.path ?? event.subject);
    if (name) return { kind: 'read', name };
  }
  if (/^(?:commandexecution|command_execution|bash|shell)$/.test(tool)) {
    const name = skillFileFromReadCommand(args?.command);
    if (name) return { kind: 'read', name };
  }
  return undefined;
}
