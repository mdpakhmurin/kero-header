export function random(seed) {
  return () => { let t = seed += 0x6D2B79F5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
export function generate(photos, settings) {
  const r = random(settings.seed), pool = [...photos].sort((a, b) => a.id.localeCompare(b.id));
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const selected = settings.count ? pool.slice(0, settings.count) : pool;
  const cols = Math.max(1, Math.ceil(Math.sqrt(selected.length * settings.width / settings.height)));
  const rows = Math.max(1, Math.ceil(selected.length / cols));
  const spread = settings.scatter / 100;
  return selected.map((p, i) => ({ id: p.id, x: ((i % cols + 0.5) / cols * (1 - spread) + r() * spread) * settings.width,
    y: ((Math.floor(i / cols) + 0.5) / rows * (1 - spread) + r() * spread) * settings.height,
    width: Math.round(settings.minSize + r() * (settings.maxSize - settings.minSize)), angle: Math.round((r() * 2 - 1) * settings.rotation) }));
}
export function hitTest(item, ratio, x, y, border = 0) {
  const a = -item.angle * Math.PI / 180, dx = x - item.x, dy = y - item.y;
  return Math.abs(dx * Math.cos(a) - dy * Math.sin(a)) <= item.width / 2 + border && Math.abs(dx * Math.sin(a) + dy * Math.cos(a)) <= item.width * ratio / 2 + border;
}
