import type { Locale } from '@/lib/i18n';
import './SidebarToggleButton.css';

export default function SidebarToggleButton({
  side, open, onClick, controls, locale = 'zh-CN', className = '',
}: {
  side: 'left' | 'right';
  open: boolean;
  onClick: () => void;
  controls: string;
  locale?: Locale;
  className?: string;
}) {
  const label = locale === 'zh-CN'
    ? `${open ? '隐藏' : '显示'}${side === 'left' ? '左' : '右'}侧栏`
    : `${open ? 'Hide' : 'Show'} ${side} sidebar`;
  return (
    <button
      type="button"
      data-ugs-sidebar-toggle={side}
      {...(side === 'right' ? { 'data-ugs-file-panel-toggle': true } : {})}
      className={`ugs-sidebar-toggle ${className}`}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-expanded={open}
      aria-controls={controls}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="2" y="2.5" width="12" height="11" rx="2" stroke="currentColor" strokeWidth="1.3" />
        <path d={side === 'left' ? 'M4 2.5H6V13.5H4Q2 13.5 2 11.5V4.5Q2 2.5 4 2.5Z' : 'M12 2.5H10V13.5H12Q14 13.5 14 11.5V4.5Q14 2.5 12 2.5Z'} fill="currentColor" />
      </svg>
    </button>
  );
}
