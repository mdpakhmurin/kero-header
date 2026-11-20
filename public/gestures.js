export function touchPair(points) {
  const [a, b] = [...points]; if (!a || !b) return null;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.max(.001, Math.hypot(b.x - a.x, b.y - a.y)), angle: Math.atan2(b.y - a.y, b.x - a.x) };
}

export function gestureFrame(start, from, to) {
  const width = Math.max(10, Math.min(10000, start.width * to.distance / from.distance)), scale = width / start.width;
  const angle = Math.atan2(Math.sin(to.angle - from.angle), Math.cos(to.angle - from.angle));
  const dx = (start.x - from.x) * scale, dy = (start.y - from.y) * scale;
  return { width, angle: (start.angle + angle * 180 / Math.PI) % 360, x: Math.max(-10000, Math.min(20000, to.x + dx * Math.cos(angle) - dy * Math.sin(angle))), y: Math.max(-10000, Math.min(20000, to.y + dx * Math.sin(angle) + dy * Math.cos(angle))) };
}

export function swipeDirection(start, end) {
  const dx = end.x - start.x, dy = end.y - start.y;
  return end.time - start.time <= 700 && Math.abs(dx) >= 50 && Math.abs(dx) > Math.abs(dy) * 1.4 ? dx < 0 ? 1 : -1 : 0;
}
