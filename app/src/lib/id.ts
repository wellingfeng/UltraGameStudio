/** Short, dependency-free id generator for nodes/edges/sessions/messages. */
let counter = 0;

export function shortId(prefix = 'id'): string {
  counter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  const time = Date.now().toString(36).slice(-4);
  return `${prefix}_${time}${rand}${counter.toString(36)}`;
}
