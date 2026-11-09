/** LRU text derivations. Oversize inputs are never retained; revisions replace
 * naturally and the byte budget includes both source and derived text. */
export function createBoundedTextCache<T>(maxEntries = 128, maxChars = 1_000_000) {
  const entries = new Map<string, { value: T; cost: number }>();
  let chars = 0;
  return {
    get(key: string, derive: () => T, valueChars: (value: T) => number = () => 0): T {
      const found = entries.get(key);
      if (found) {
        entries.delete(key);
        entries.set(key, found);
        return found.value;
      }
      const value = derive();
      const cost = key.length + valueChars(value);
      if (cost <= maxChars) {
        entries.set(key, { value, cost });
        chars += cost;
        while (entries.size > maxEntries || chars > maxChars) {
          const oldest = entries.keys().next().value!;
          chars -= entries.get(oldest)!.cost;
          entries.delete(oldest);
        }
      }
      return value;
    },
  };
}
