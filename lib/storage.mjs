import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export const defaults = { community: 'kero_comics', source: 'both', width: 1920, height: 768, coverSizes: [{ width: 1920, height: 768 }, { width: 1590, height: 400 }], minSize: 180, maxSize: 440, rotation: 24, count: 0, background: '#f0eadf', border: 7, shadow: 24 };
export const validId = id => typeof id === 'string' && /^(?:vk_-?\d+_\d+|local_[a-f0-9]{64})$/.test(id);
export const digest = buffer => createHash('sha256').update(buffer).digest('hex');
export async function readJSON(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return structuredClone(fallback); throw error; }
}
export async function writeJSON(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n');
  await rename(temp, file);
}
export function validateSettings(value) {
  const s = { ...defaults };
  for (const [key, min, max] of [['width', 100, 8192], ['height', 100, 8192], ['minSize', 20, 4000], ['maxSize', 20, 4000], ['rotation', 0, 180], ['count', 0, 10000], ['border', 0, 60], ['shadow', 0, 100]]) {
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
    if (!s.coverSizes.some(saved => saved.width === size.width && saved.height === size.height)) s.coverSizes.push({ width: size.width, height: size.height });
  }
  if (s.coverSizes.length > 100) throw new Error('Можно сохранить до 100 размеров обложки');
  if (s.minSize > s.maxSize) throw new Error('Минимальный размер больше максимального');
  s.community = String(value.community ?? defaults.community).trim().replace(/^https?:\/\/(?:www\.)?vk\.(?:com|ru)\//, '').replace(/\/$/, '');
  if (!/^[\w.-]{1,100}$/.test(s.community)) throw new Error('Укажите короткое имя сообщества, например kero_comics');
  s.source = value.source ?? defaults.source;
  if (!['both', 'albums', 'wall'].includes(s.source)) throw new Error('Неизвестный источник');
  s.background = value.background ?? defaults.background;
  if (!/^#[a-f\d]{6}$/i.test(s.background)) throw new Error('Некорректный цвет фона');
  return s;
}
export function validateLayout(value) {
  if (!Array.isArray(value.items) || value.items.length > 10000) throw new Error('Некорректный макет');
  const ids = new Set();
  return { items: value.items.map(item => {
    if (!validId(item.id) || ids.has(item.id)) throw new Error('Некорректный или повторяющийся ID');
    ids.add(item.id);
    for (const key of ['x', 'y', 'width', 'angle']) if (!Number.isFinite(item[key])) throw new Error('Некорректная геометрия');
    if (Math.abs(item.x) > 50000 || Math.abs(item.y) > 50000 || item.width < 10 || item.width > 10000 || Math.abs(item.angle) > 36000) throw new Error('Геометрия вне диапазона');
    return { id: item.id, x: item.x, y: item.y, width: item.width, angle: item.angle };
  }) };
}
export function imageType(data) {
  if (data.length < 12) return null;
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
export async function cacheValid(root, photo) {
  try {
    const data = await readFile(join(root, 'cache', 'images', `${photo.id}.img`));
    return data.length > 0 && imageType(data) !== null && digest(data) === photo.hash;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
export async function saveImage(root, id, data) {
  const mime = imageType(data);
  if (!mime) throw new Error('Поддерживаются JPEG, PNG и WebP');
  const folder = join(root, 'cache', 'images');
  await mkdir(folder, { recursive: true });
  const file = join(folder, `${id}.img`), temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, data);
  await rename(temp, file);
  return { hash: digest(data), mime, bytes: data.length };
}
