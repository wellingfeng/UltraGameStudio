import type { ReactNode } from 'react';
import { Brain, ChevronRight } from 'lucide-react';

interface ReviewStripProps {
  label: string;
  meta?: string;
  diagnosticsLabel: string;
  children: ReactNode;
}

/** Quiet chat scaffolding; exact diagnostics stay available on demand. */
export default function ReviewStrip({ label, meta, diagnosticsLabel, children }: ReviewStripProps) {
  return <details data-ugs-review-diagnostics className="ugs-review-disclosure min-w-0">
    <summary className="ugs-review-summary" title={`${label}${meta ? ` · ${meta}` : ''} · ${diagnosticsLabel}`}>
      <span data-ugs-review-glyph className="ugs-review-glyph" aria-hidden="true"><Brain size={14} /></span>
      <span role="status" className="ugs-review-label">{label}</span>
      {meta && <><span className="ugs-review-separator" aria-hidden="true">·</span><span className="ugs-review-meta" title={meta}>{meta}</span></>}
      <ChevronRight className="ugs-review-chevron" size={12} aria-hidden="true" />
    </summary>
    <div data-ugs-review-body className="ugs-review-body min-w-0 space-y-2 text-fg-dim">{children}</div>
  </details>;
}
