import { handleSerialization, type SerializationRequest, type SerializationResponse } from './serializeValue';
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<SerializationRequest>) => void;
  postMessage: (value: SerializationResponse) => void;
};
scope.onmessage = (event) => scope.postMessage(handleSerialization(event.data));
