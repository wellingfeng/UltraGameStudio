import { characterEntities } from 'character-entities';

/** Vite's browser condition selects remark's DOM-based named-entity decoder,
 * even in workers. Provide only that decoder's inert `i` element contract,
 * using the very same HTML entity table as its non-DOM package entry. No HTML
 * rendering, DOM traversal or document content exists in this worker.
 */
if (typeof document === 'undefined') {
  const decoderDocument = {
    createElement(tag: string) {
      if (tag !== 'i') throw new Error('REFERENCE_WORKER_UNEXPECTED_DOM_ACCESS');
      let text = '';
      return {
        set innerHTML(value: string) {
          const name = /^&([^;]+);$/.exec(value)?.[1];
          text = name && Object.prototype.hasOwnProperty.call(characterEntities, name) ? characterEntities[name] : value;
        },
        get textContent() { return text; },
      };
    },
  };
  Object.defineProperty(globalThis, 'document', { value: decoderDocument, configurable: true });
}
