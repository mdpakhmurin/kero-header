import { photoSizeRange } from './settings.js';

export function random(seed) {
  return () => { let t = seed += 0x6D2B79F5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
export function generate(photos, settings, seed = Math.floor(Math.random() * 4294967296)) {
  const r = random(seed), pool = [...photos].sort((a, b) => a.id.localeCompare(b.id));
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const selected = settings.count ? pool.slice(0, settings.count) : pool;
  if (!selected.length) return [];
  const width = settings.width, height = settings.height, border = settings.border || 0;
  const { minSize, maxSize } = photoSizeRange(settings);
  // Include the canvas edges in the coverage map, not just interior samples.
  // The bounded resolution keeps placement practical for large photo libraries.
  const cell = Math.max(1, Math.sqrt(width * height / 12000));
  const cols = Math.ceil(width / cell) + 1, rows = Math.ceil(height / cell) + 1;
  const stepX = width / (cols - 1), stepY = height / (rows - 1);
  const holes = Array.from({ length: cols * rows }, (_, index) => index);
  const holePositions = Int32Array.from(holes);
  const frames = selected.map(photo => {
    const ratio = photo.height / photo.width;
    const item = { id: photo.id, x: 0, y: 0, width: Math.round(minSize + r() * (maxSize - minSize)), angle: Math.round((r() * 2 - 1) * settings.rotation) };
    const halfW = item.width / 2 + border, halfH = item.width * (Number.isFinite(ratio) && ratio > 0 ? ratio : 1) / 2 + border;
    const angle = item.angle * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
    return { item, halfW, halfH, cos, sin, extentX: Math.abs(halfW * cos) + Math.abs(halfH * sin), extentY: Math.abs(halfW * sin) + Math.abs(halfH * cos) };
  }).sort((a, b) => b.halfW * b.halfH - a.halfW * a.halfH);

  function coverage(frame, x, y, mark = false) {
    const { halfW, halfH, cos, sin, extentX, extentY } = frame;
    const left = Math.max(0, Math.ceil((x - extentX - 1e-7) / stepX)), right = Math.min(cols - 1, Math.floor((x + extentX + 1e-7) / stepX));
    const top = Math.max(0, Math.ceil((y - extentY - 1e-7) / stepY)), bottom = Math.min(rows - 1, Math.floor((y + extentY + 1e-7) / stepY));
    let score = 0;
    for (let row = top; row <= bottom; row++) {
      const dy = row * stepY - y;
      let localX = (left * stepX - x) * cos + dy * sin;
      let localY = -(left * stepX - x) * sin + dy * cos;
      for (let col = left; col <= right; col++, localX += stepX * cos, localY -= stepX * sin) {
        const index = row * cols + col, position = holePositions[index];
        if (position < 0 || Math.abs(localX) > halfW + 1e-7 || Math.abs(localY) > halfH + 1e-7) continue;
        score++;
        if (mark) {
          const last = holes.pop();
          if (position < holes.length) { holes[position] = last; holePositions[last] = position; }
          holePositions[index] = -1;
        }
      }
    }
    return score;
  }
  function gridCoordinate(point, extent, length) {
    const count = Math.ceil(length / (2 * extent));
    if (count <= 1) return length / 2;
    const spacing = (length - 2 * extent) / (count - 1);
    return extent + Math.max(0, Math.min(count - 1, Math.round((point - extent) / spacing))) * spacing;
  }
  for (const frame of frames) {
    const { item, extentX, extentY } = frame;
    let best = { x: width / 2, y: height / 2, score: -1 };
    const consider = (x, y) => {
      x = Math.max(0, Math.min(width, x)); y = Math.max(0, Math.min(height, y));
      const score = coverage(frame, x, y);
      if (score > best.score) best = { x, y, score };
    };
    if (holes.length) {
      // Aligned candidates cover corners and tile equal-sized, unrotated photos.
      for (const x of [Math.min(extentX, width / 2), Math.max(width / 2, width - extentX)]) {
        for (const y of [Math.min(extentY, height / 2), Math.max(height / 2, height - extentY)]) consider(x, y);
      }
      for (let attempt = 0; attempt < 48; attempt++) {
        const hole = holes[Math.floor(r() * holes.length)];
        const x = (hole % cols) * stepX, y = Math.floor(hole / cols) * stepY;
        if (attempt < 16) consider(gridCoordinate(x, extentX, width), gridCoordinate(y, extentY, height));
        else if (attempt < 32) consider(x, y);
        else {
          const dx = (r() - .5) * frame.halfW, dy = (r() - .5) * frame.halfH;
          consider(x + dx * frame.cos - dy * frame.sin, y + dx * frame.sin + dy * frame.cos);
        }
      }
      coverage(frame, best.x, best.y, true);
    } else {
      best.x = Math.min(extentX, width / 2) + r() * Math.max(0, width - 2 * extentX);
      best.y = Math.min(extentY, height / 2) + r() * Math.max(0, height - 2 * extentY);
    }
    item.x = best.x; item.y = best.y;
  }
  return frames.map(frame => frame.item);
}
export function hitTest(item, ratio, x, y, border = 0) {
  const a = -item.angle * Math.PI / 180, dx = x - item.x, dy = y - item.y;
  return Math.abs(dx * Math.cos(a) - dy * Math.sin(a)) <= item.width / 2 + border && Math.abs(dx * Math.sin(a) + dy * Math.cos(a)) <= item.width * ratio / 2 + border;
}
