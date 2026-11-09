import { useState } from 'react';
import type { BackgroundJobDetail } from '@/lib/chatTasks';
import type { Locale } from '@/lib/i18n';
import type { OpenFileFn } from './FileChip';
import FileChip from './FileChip';
import TerminalLog from './TerminalLog';

function JobEntry({ job, locale, cwd, onOpenFile }: {
  job: BackgroundJobDetail; locale: Locale; cwd?: string; onOpenFile?: OpenFileFn;
}) {
  const [open, setOpen] = useState(false);
  const zh = locale === 'zh-CN';
  const status = job.status === 'success' ? (zh ? '已完成' : 'Completed')
    : job.status === 'failed' ? (zh ? '失败' : 'Failed') : (zh ? '进行中' : 'Running');
  const logPath = job.manifest.progressFile;
  const artifact = job.manifest.done.artifactPath;
  const file = (path: string) => <FileChip refData={{ path, basename: path.replace(/\\/g, '/').split('/').pop()! }} onOpenFile={onOpenFile} cwd={cwd} />;
  return <details className="rounded border border-border-soft" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className="flex cursor-pointer items-center gap-2 px-2 py-1.5">
      <span className="min-w-0 flex-1 break-words">{job.manifest.label}</span>
      <span className="shrink-0 text-fg-faint">{new Date(job.manifest.startedAt).toLocaleString(zh ? 'zh-CN' : 'en-US')} · {status}</span>
    </summary>
    {open && <div className="space-y-2 px-2 pb-2">
      {logPath && <div className="flex items-center gap-2">{zh ? '完整日志' : 'Full log'} {file(logPath)}</div>}
      {artifact && <div className="flex items-center gap-2">{zh ? '产物' : 'Artifact'} {file(artifact)}</div>}
      <TerminalLog text={job.progressTail || (zh ? '没有可用的日志尾部。' : 'No log tail available.')} streaming={job.status === 'running'} />
    </div>}
  </details>;
}

/** Historical job manifests are evidence, not a reconstruction of model output. */
export default function ChatJobHistory({ jobs, locale, cwd, onOpenFile }: {
  jobs: BackgroundJobDetail[]; locale: Locale; cwd?: string; onOpenFile?: OpenFileFn;
}) {
  const [open, setOpen] = useState(false);
  if (!jobs.length) return null;
  const zh = locale === 'zh-CN';
  const ordered = [...jobs].sort((left, right) => left.manifest.startedAt - right.manifest.startedAt);
  return <details data-ugs-job-history className="mb-1 shrink-0 rounded-md border border-border-soft bg-panel text-xs" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer px-2 py-2 text-fg-dim">{zh ? `会话后台任务记录 · ${jobs.length} 项` : `Session background jobs · ${jobs.length}`}</summary>
    {open && <div className="max-h-[min(24rem,55vh)] space-y-1 overflow-y-auto p-2">
      <p className="text-fg-faint">{zh ? '来自本会话的任务清单；日志尾部和产物可查看，不代表完整对话记录。' : 'From this session’s job manifests; logs are not a complete conversation.'}</p>
      {ordered.map((job) => <JobEntry key={job.manifest.id} job={job} locale={locale} cwd={cwd} onOpenFile={onOpenFile} />)}
    </div>}
  </details>;
}
