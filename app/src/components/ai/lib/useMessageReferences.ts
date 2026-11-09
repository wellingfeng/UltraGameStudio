import { useEffect, useMemo, useRef, useState } from 'react';
import { collectMessageReferences, type ReferenceSource, type MessageReference } from '@/lib/messageReferences';
import { ReferenceProjection } from './referenceProjection';
import { admitReferences, admitSources, sourceRevisionKey } from './referenceAdmission';

const EMPTY: MessageReference[] = [];
interface Snapshot { text: string; sourceKey: string; references: MessageReference[] }

/** Only streaming collection is asynchronous. No-worker/error/timeout renders
 * ordinary links until final; it never shifts full parsing back onto each UI
 * publication. Final still pays one authoritative full-document parse/revision.
 */
export function useMessageReferences(text: string, sourceInput: ReferenceSource[] | null, streaming: boolean, enabled: boolean): MessageReference[] {
  // Value revision, not array/object identity: native evidence can be amended.
  const admitted = admitSources(sourceInput);
  const valid = admitted !== null;
  const sourceKey = admitted ? sourceRevisionKey(admitted) : 'REJECTED';
  const sources = useMemo(() => admitted ?? [], [sourceKey]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const projection = useRef<ReferenceProjection | null>(null);
  const stable = useRef<MessageReference[]>(EMPTY);

  useEffect(() => {
    setSnapshot(null);
    if (!valid || !streaming || !enabled || !sources.length || typeof Worker === 'undefined') return;
    let owned: ReferenceProjection;
    try {
      owned = new ReferenceProjection(new Worker(new URL('./referenceAnalysis.worker.ts', import.meta.url), { type: 'module' }),
        (revision, references) => setSnapshot({ text: revision, sourceKey, references }), () => setSnapshot(null));
    } catch { return; }
    projection.current = owned;
    return () => { owned.dispose(); if (projection.current === owned) projection.current = null; };
  }, [sourceKey, sources, streaming, enabled, valid]);

  useEffect(() => { projection.current?.submit(text, sources); }, [text, sources, streaming, enabled]);

  const final = useMemo(() => valid && !streaming && enabled ? admitReferences(collectMessageReferences(text, sources)) ?? EMPTY : EMPTY,
    [text, sources, streaming, enabled, valid]);
  const next = !valid || !enabled ? EMPTY : !streaming ? final : snapshot?.sourceKey === sourceKey && text.startsWith(snapshot.text) ? snapshot.references : EMPTY;
  const old = stable.current;
  if (old.length !== next.length || next.some((item, i) => item.url !== old[i].url || item.title !== old[i].title ||
    item.number !== old[i].number || item.toolCallId !== old[i].toolCallId)) stable.current = next;
  return stable.current;
}
