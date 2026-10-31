import type { ClipboardEventHandler } from 'react';
import { ArrowUp, X } from 'lucide-react';

export default function UserMessageEditor({ value, onChange, onCancel, onSave, onPaste, queued = false }: {
  value: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSave: () => void;
  onPaste?: ClipboardEventHandler<HTMLTextAreaElement>;
  queued?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2 text-left">
      <div className="relative">
      <textarea
        aria-label="编辑用户输入"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault(); onSave();
          }
        }}
        onPaste={onPaste}
        autoFocus
        rows={Math.min(12, Math.max(4, value.split('\n').length))}
        className="block max-h-80 min-h-28 w-full resize-y rounded-md border border-border bg-bg/70 px-2.5 pt-2 pb-10 text-sm leading-relaxed text-fg outline-none focus:border-accent"
      />
      <div className="absolute bottom-2 right-2 flex items-center gap-1">
        <button type="button" onClick={onCancel} aria-label="取消" title="取消（Esc）"
          className="flex h-7 w-7 items-center justify-center rounded-md text-fg-dim hover:bg-bg-soft hover:text-fg focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent">
          <X size={16} aria-hidden="true" />
        </button>
        <button type="button" onClick={onSave} disabled={!value.trim()} aria-label={queued ? '保存' : '保存并重新发送'}
          title={queued ? '保存（Ctrl/⌘+Enter）' : '保存并重新发送（Ctrl/⌘+Enter）'}
          className="flex h-7 w-7 items-center justify-center rounded-md text-fg-dim hover:bg-bg-soft hover:text-fg focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent disabled:opacity-40 disabled:cursor-not-allowed">
          <ArrowUp size={16} aria-hidden="true" />
        </button>
      </div>
      </div>
      {!queued && <p className="text-xs text-fg-faint">修订后作为插话发送，不停止当前任务；只显示这条输入的最新一次。</p>}
    </div>
  );
}
