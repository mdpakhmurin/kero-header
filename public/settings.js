export function coverSizeLabel(size) {
  return `${size.width} × ${size.height}${size.name ? ` (${size.name})` : ''}`;
}

export function removeCoverSize(settings, size) {
  const index = settings.coverSizes.findIndex(saved => saved.width === size.width && saved.height === size.height);
  if (index < 0) return settings;
  if (settings.coverSizes.length === 1) throw new Error('Нужно оставить хотя бы один размер холста');
  const coverSizes = settings.coverSizes.filter((_, position) => position !== index);
  const current = settings.width === size.width && settings.height === size.height;
  const next = current ? coverSizes[Math.min(index, coverSizes.length - 1)] : settings;
  return { ...settings, width: next.width, height: next.height, coverSizes };
}

export function photoSizeRange(settings) {
  if (settings.photoSize === undefined) return { minSize: settings.minSize, maxSize: settings.maxSize };
  const deviation = settings.photoSize * (settings.sizeDeviation ?? 0) / 100;
  return { minSize: Math.max(20, Math.round(settings.photoSize - deviation)), maxSize: Math.round(settings.photoSize + deviation) };
}
