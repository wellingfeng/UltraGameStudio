/** @schema 2.10 */
const step = 26;
const w = pencil.width, h = pencil.height;
const minor = "#1a212b";
const major = "#222b36";
const nodes = [];
let i = 0;
for (let x = 0; x <= w; x += step) {
  nodes.push({ type: "rectangle", x: x, y: 0, width: 1, height: h, fill: (i % 4 === 0 ? major : minor) });
  i++;
}
i = 0;
for (let y = 0; y <= h; y += step) {
  nodes.push({ type: "rectangle", x: 0, y: y, width: w, height: 1, fill: (i % 4 === 0 ? major : minor) });
  i++;
}
return nodes;
