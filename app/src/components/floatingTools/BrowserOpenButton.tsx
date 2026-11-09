import { Globe2 } from 'lucide-react';
import { useFilePreviewTabs } from '@/store/filePreviewTabs';

export default function BrowserOpenButton({ scope }: { scope: string }) {
  return <button type="button" title="打开浏览器" aria-label="打开浏览器"
    data-file-preview-ignore-outside-pointer="true" onClick={() => useFilePreviewTabs.getState().openBrowser(scope)}>
    <Globe2 size={14} aria-hidden="true" />
  </button>;
}
