import { tauriAvailable } from '@/lib/tauri';

export async function copyConversationText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  try {
    textarea.select();
    if (!document.execCommand('copy')) throw new Error('Clipboard unavailable');
  } finally {
    textarea.remove();
  }
}

export async function exportConversationText(text: string, title: string): Promise<boolean> {
  const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
  const filename = `${safeTitle || 'conversation'}.md`;
  if (tauriAvailable()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const picked = await save({
      defaultPath: filename,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (!picked) return false;
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    await writeTextFile(typeof picked === 'string' ? picked : String(picked), text);
  } else {
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    try {
      link.click();
    } finally {
      link.remove();
      URL.revokeObjectURL(url);
    }
  }
  return true;
}
