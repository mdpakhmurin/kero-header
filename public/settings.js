export function photoSizeRange(settings) {
  if (settings.photoSize === undefined) return { minSize: settings.minSize, maxSize: settings.maxSize };
  const deviation = settings.photoSize * (settings.sizeDeviation ?? 0) / 100;
  return { minSize: Math.max(20, Math.round(settings.photoSize - deviation)), maxSize: Math.round(settings.photoSize + deviation) };
}
