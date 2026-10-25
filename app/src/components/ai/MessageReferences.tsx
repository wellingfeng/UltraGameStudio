import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { openExternal } from '@/lib/tauri';
import { referenceKey, type MessageReference } from '@/lib/messageReferences';
import './MessageReferences.css';

interface ReferenceContextValue {
  find: (url: string) => MessageReference | undefined;
  locate: (number: number) => void;
}
const ReferenceContext = createContext<ReferenceContextValue | null>(null);
export const useMessageReferences = () => useContext(ReferenceContext);

/** Lookup stays inside this bubble, even when several turns cite the same URL. */
export default function MessageReferences({ references, children }: { references: MessageReference[]; children: ReactNode }) {
  const panel = useRef<HTMLElement>(null);
  const context = useMemo(() => ({
    find: (url: string) => references.find((reference) => referenceKey(reference.url) === referenceKey(url)),
    locate: (number: number) => {
      const row = panel.current?.querySelector<HTMLElement>(`[data-reference-number="${number}"]`);
      row?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
      row?.focus({ preventScroll: true });
    },
  }), [references]);
  return <ReferenceContext.Provider value={context}>
    {children}
    {references.length > 0 && <section ref={panel} className="ai-references" aria-label="参考资料">
      <div className="ai-references__heading">参考资料 <span>{references.length}</span></div>
      <ol className="ai-references__list">
        {references.map((reference) => <li key={referenceKey(reference.url)} tabIndex={-1}
          data-reference-number={reference.number} className="ai-references__item">
          <span className="ai-references__number">{reference.number}</span>
          <a href={reference.url} target="_blank" rel="noopener noreferrer" title={reference.url}
            onClick={(event) => { event.preventDefault(); void openExternal(reference.url); }}>
            <span className="ai-references__title">{reference.title}</span>
            <span className="ai-references__url">{new URL(reference.url).hostname} · {reference.url}</span>
          </a>
          <ExternalLink size={13} aria-hidden="true" />
        </li>)}
      </ol>
    </section>}
  </ReferenceContext.Provider>;
}
