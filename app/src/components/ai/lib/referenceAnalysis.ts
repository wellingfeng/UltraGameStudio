import { collectMessageReferences, type MessageReference, type ReferenceSource } from '@/lib/messageReferences';
import { admitAnalysisInput, admitReferences, ownData } from './referenceAdmission';

export interface ReferenceAnalysisRequest { id: number; text: string; sources: ReferenceSource[] }
export interface ReferenceAnalysisResponse { id: number; references?: MessageReference[]; error?: string }

/** The worker uses the same authoritative parser as final/history collection. */
export function analyzeReferenceRequest(request: unknown): ReferenceAnalysisResponse {
  const rawId = ownData(request, 'id');
  const id = typeof rawId === 'number' && Number.isSafeInteger(rawId) && rawId > 0 ? rawId : 0;
  try {
    const input = id ? admitAnalysisInput(ownData(request, 'text'), ownData(request, 'sources')) : null;
    if (!input) return { id, error: 'REFERENCE_ANALYSIS_FAILED' };
    const references = admitReferences(collectMessageReferences(input.text, input.sources, true));
    return references ? { id, references } : { id, error: 'REFERENCE_ANALYSIS_FAILED' };
  }
  catch { return { id, error: 'REFERENCE_ANALYSIS_FAILED' }; }
}
