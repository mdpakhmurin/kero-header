import { mkdir, readFile, writeFile, rename, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export { defaults, validateSettings } from '../public/settings.js';
export const validId = id => typeof id === 'string' && /^(?:vk_-?\d+_\d+|local_[a-f0-9]{64})$/.test(id);
export const digest = buffer => createHash('sha256').update(buffer).digest('hex');
export async function migrateLocalDates(root, library) {
  let changed = false;
  for (const photo of Object.values(library.photos)) {
    if (!(photo.source === 'local' || photo.id.startsWith('local_')) || Number.isFinite(photo.addedAt) && photo.addedAt > 0) continue;
    try {
      const info = await stat(imagePath(root, photo));
      const time = info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs;
      if (Number.isFinite(time) && time > 0) { photo.addedAt = Math.floor(time); changed = true; }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (changed) await writeJSON(join(root, 'cache/library.json'), library);
}

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
const imageExtensions = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
export function imagePath(root, photo) {
  return join(root, 'cache/images', `${photo.id}.${imageExtensions[photo.mime] || 'img'}`);
}
export async function readImage(root, photo) {
  try { return await readFile(imagePath(root, photo)); }
  catch (error) {
    if (error.code !== 'ENOENT' || !imageExtensions[photo.mime]) throw error;
    return readFile(join(root, 'cache/images', `${photo.id}.img`));
  }
}
export async function migrateImageFiles(root, library) {
  const directory = join(root, 'cache/images');
  const files = await readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith('.img')) continue;
    const id = file.name.slice(0, -4), photo = library.photos[id];
    if (!validId(id) || !photo || !imageExtensions[photo.mime]) continue;
    try { await stat(imagePath(root, photo)); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await rename(join(directory, file.name), imagePath(root, photo));
    }
  }
}
export async function cacheValid(root, photo) {
  try {
    const data = await readImage(root, photo);
    return data.length > 0 && imageType(data) !== null && digest(data) === photo.hash;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
export async function saveImage(root, id, data) {
  const mime = imageType(data);
  if (!mime) throw new Error('Поддерживаются JPEG, PNG и WebP');
  const folder = join(root, 'cache', 'images');
  await mkdir(folder, { recursive: true });
  const file = imagePath(root, { id, mime }), temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, data);
  await rename(temp, file);
  return { hash: digest(data), mime, bytes: data.length };
}
