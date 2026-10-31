import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { Message } from '@/store/types';

export default function ChatRevisionControls({ message, disabled, onSelect }: {
  message: Message;
  disabled: boolean;
  onSelect: (messageId: string, index: number) => boolean;
}) {
  if (!message.chatRevisions?.length) return null;
  const count = message.chatRevisions.length + 1;
  const index = message.chatRevisionIndex ?? count - 1;
  return (
    <span className="flex shrink-0 items-center gap-1 text-xs text-fg-dim" data-ugs-chat-revisions={message.id}>
      <button type="button" aria-label="上一个对话版本" title="上一个对话版本" disabled={disabled || index === 0}
        onClick={() => onSelect(message.id, index - 1)} className="rounded p-1 hover:text-accent disabled:opacity-30"><ChevronLeft size={12} /></button>
      <span aria-label="当前对话版本">{index + 1} / {count}</span>
      <button type="button" aria-label="下一个对话版本" title="下一个对话版本" disabled={disabled || index === count - 1}
        onClick={() => onSelect(message.id, index + 1)} className="rounded p-1 hover:text-accent disabled:opacity-30"><ChevronRight size={12} /></button>
    </span>
  );
}
