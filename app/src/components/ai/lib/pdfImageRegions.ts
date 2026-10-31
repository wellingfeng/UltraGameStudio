/** pdf.js records three normalized corners for each visible image. */
export function pdfImageRegions(coordinates: ArrayLike<number> | null): Array<{ x: number; y: number; width: number; height: number }> {
  if (!coordinates) return [];
  const regions: Array<{ x: number; y: number; width: number; height: number }> = [];
  for (let i = 0; i + 5 < coordinates.length; i += 6) {
    const [x0, y0, x1, y1, x2, y2] = Array.from({ length: 6 }, (_, offset) => coordinates[i + offset]);
    const xs = [x0, x1, x2, x1 + x2 - x0];
    const ys = [y0, y1, y2, y1 + y2 - y0];
    const left = Math.max(0, Math.min(...xs));
    const top = Math.max(0, Math.min(...ys));
    const right = Math.min(1, Math.max(...xs));
    const bottom = Math.min(1, Math.max(...ys));
    if (right > left && bottom > top) regions.push({ x: left, y: top, width: right - left, height: bottom - top });
  }
  return regions;
}
