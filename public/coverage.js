// Estimate the union of rotated photo rectangles on a bounded sampling grid.
// Borders cover the background; shadows and the selection outline do not.
export function emptySpacePercent(items, images, settings) {
  const { width, height, border = 0 } = settings;
  const cell = Math.max(1, Math.sqrt(width * height / 40000));
  const cols = Math.ceil(width / cell), rows = Math.ceil(height / cell);
  const stepX = width / cols, stepY = height / rows;
  const covered = new Uint8Array(cols * rows);
  let count = 0;
  for (const item of items) {
    const image = images.get(item.id);
    if (!image) continue;
    const halfW = item.width / 2 + border, halfH = item.width * image.height / image.width / 2 + border;
    const radians = item.angle * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
    const extentX = Math.abs(halfW * cos) + Math.abs(halfH * sin), extentY = Math.abs(halfW * sin) + Math.abs(halfH * cos);
    const left = Math.max(0, Math.ceil((item.x - extentX) / stepX - .5)), right = Math.min(cols - 1, Math.floor((item.x + extentX) / stepX - .5));
    const top = Math.max(0, Math.ceil((item.y - extentY) / stepY - .5)), bottom = Math.min(rows - 1, Math.floor((item.y + extentY) / stepY - .5));
    for (let row = top; row <= bottom; row++) {
      const dy = (row + .5) * stepY - item.y;
      let localX = ((left + .5) * stepX - item.x) * cos + dy * sin;
      let localY = -((left + .5) * stepX - item.x) * sin + dy * cos;
      for (let col = left; col <= right; col++, localX += stepX * cos, localY -= stepX * sin) {
        const index = row * cols + col;
        if (covered[index] || Math.abs(localX) > halfW + 1e-7 || Math.abs(localY) > halfH + 1e-7) continue;
        covered[index] = 1; count++;
      }
    }
    if (count === covered.length) return 0;
  }
  return (1 - count / covered.length) * 100;
}
