import { scanFileRefs } from './lib/fileScan';
import FileChip, { type OpenFileFn } from './FileChip';

export default function FileText({
  text,
  onOpenFile,
  cwd,
}: {
  text: string;
  onOpenFile?: OpenFileFn;
  cwd?: string;
}) {
  const parts = scanFileRefs(text);
  if (parts.length === 1 && typeof parts[0] === 'string') return text;

  return parts.map((part, index) =>
    typeof part === 'string' ? (
      <span key={index}>{part}</span>
    ) : (
      <FileChip key={index} refData={part} onOpenFile={onOpenFile} cwd={cwd} />
    ),
  );
}
