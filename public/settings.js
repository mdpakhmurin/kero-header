export const defaults = { community: 'kero_comics', source: 'both', layoutOrder: 'random', layoutDirection: 'desc', favoritesFirst: false, width: 1920, height: 768, coverSizes: [{ width: 1920, height: 768, name: 'VK' }, { width: 1400, height: 280, name: 'Пикабу' }], photoSize: 310, sizeDeviation: 42, rotation: 24, count: 0, background: '#e3e3e3', border: 7, shadow: 24 };

export function validateSettings(value) {
  const s = { ...defaults };
  if (value.photoSize === undefined && (value.minSize !== undefined || value.maxSize !== undefined)) {
    const min = value.minSize ?? 180, max = value.maxSize ?? 440;
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 20 || max > 4000 || min > max) throw new Error('Некорректный диапазон размеров фото');
    value = { ...value, photoSize: Math.max(20, Math.min(800, Math.round((min + max) / 2))), sizeDeviation: Math.min(300, Math.round((max - min) / (min + max) * 100)) };
  }
  for (const [key, min, max] of [['width', 100, 8192], ['height', 100, 8192], ['photoSize', 20, 800], ['sizeDeviation', 0, 300], ['rotation', 0, 180], ['count', 0, 10000], ['border', 0, 60], ['shadow', 0, 100]]) {
    const n = value[key] ?? defaults[key];
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Некорректное значение ${key}`);
    s[key] = n;
  }
  if (s.width * s.height > 32_000_000) throw new Error('Холст не должен превышать 32 мегапикселя');
  const coverSizes = value.coverSizes ?? defaults.coverSizes;
  if (!Array.isArray(coverSizes) || coverSizes.length > 100) throw new Error('Можно сохранить до 100 размеров обложки');
  s.coverSizes = [];
  for (const size of [...coverSizes, { width: s.width, height: s.height }]) {
    if (!size || !Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width < 100 || size.width > 8192 || size.height < 100 || size.height > 8192 || size.width * size.height > 32_000_000) throw new Error('Некорректный размер обложки');
    const name = size.name === undefined ? defaults.coverSizes.find(saved => saved.width === size.width && saved.height === size.height)?.name ?? '' : size.name;
    if (typeof name !== 'string' || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('Название размера должно быть строкой до 80 символов без переносов');
    if (!s.coverSizes.some(saved => saved.width === size.width && saved.height === size.height)) s.coverSizes.push({ width: size.width, height: size.height, name: name.trim() });
  }
  if (s.coverSizes.length > 100) throw new Error('Можно сохранить до 100 размеров обложки');
  s.community = String(value.community ?? defaults.community).trim().replace(/^https?:\/\/(?:www\.)?vk\.(?:com|ru)\//, '').replace(/\/$/, '');
  if (!/^[\w.-]{1,100}$/.test(s.community)) throw new Error('Укажите короткое имя сообщества, например kero_comics');
  s.layoutOrder = value.layoutOrder ?? defaults.layoutOrder;
  s.layoutDirection = value.layoutDirection ?? (s.layoutOrder === 'oldest' ? 'asc' : 'desc');
  if (['newest', 'oldest'].includes(s.layoutOrder)) s.layoutOrder = 'date';
  if (!['random', 'date', 'name'].includes(s.layoutOrder) || !['asc', 'desc'].includes(s.layoutDirection)) throw new Error('Некорректный порядок кадров');
  s.favoritesFirst = value.favoritesFirst ?? false;
  if (typeof s.favoritesFirst !== 'boolean') throw new Error('Некорректный порядок избранного');
  s.source = value.source ?? defaults.source;
  if (!['both', 'albums', 'wall'].includes(s.source)) throw new Error('Неизвестный источник');
  s.background = typeof value.background === 'string' && ['#f0eadf', '#e3e1de'].includes(value.background.toLowerCase()) ? defaults.background : value.background ?? defaults.background;
  if (!/^#[a-f\d]{6}$/i.test(s.background)) throw new Error('Некорректный цвет фона');
  return s;
}
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
