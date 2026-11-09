import './referenceWorkerEntities';
import { analyzeReferenceRequest, type ReferenceAnalysisRequest, type ReferenceAnalysisResponse } from './referenceAnalysis';
import { referenceEventData } from './referenceAdmission';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<ReferenceAnalysisRequest>) => void) | null;
  postMessage: (response: ReferenceAnalysisResponse) => void;
};
scope.onmessage = (event) => scope.postMessage(analyzeReferenceRequest(referenceEventData(event)));
