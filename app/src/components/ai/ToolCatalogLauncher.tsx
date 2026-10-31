import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Wrench } from 'lucide-react';
import type { ToolCatalogScope } from '@/lib/tools/types';
import { ToolCatalogPanel } from './ToolCatalogPanel';

export function ToolCatalogLauncher({ scope, className }: { scope: ToolCatalogScope; className?: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" onClick={() => setOpen(true)} title="查看当前会话工具目录" aria-label="查看当前会话工具目录" className={className}><Wrench size={14} /><span>工具</span></button>
    {open && createPortal(<div className="fixed inset-0 z-[160] flex items-center justify-center bg-black/50 p-4" onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }} onMouseDown={e => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div role="dialog" aria-modal="true" aria-label="工具目录" className="w-full max-w-3xl"><ToolCatalogPanel key={JSON.stringify(scope)} scope={scope} onClose={() => setOpen(false)} /></div>
    </div>, document.body)}
  </>;
}
