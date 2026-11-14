import { imageType } from './storage.mjs';
import { connectionError } from './vk.mjs';

export function coverCommunity(value) {
  if (typeof value !== 'string') throw new Error('Укажите ссылку на сообщество VK');
  let name = value.trim();
  if (/^(?:https?:\/\/|(?:www\.|m\.)?vk\.(?:com|ru)\/)/i.test(name)) {
    let url;
    try { url = new URL(/^https?:\/\//i.test(name) ? name : `https://${name}`); } catch {}
    if (!url || !['https:', 'http:'].includes(url.protocol) || !/^(?:(?:www|m)\.)?vk\.(?:com|ru)$/i.test(url.hostname) || url.username || url.password || url.port) throw new Error('Нужна ссылка на сообщество на vk.ru или vk.com');
    name = url.pathname.replace(/^\//, '').replace(/\/$/, '');
  }
  if (!/^[\w.-]{1,100}$/.test(name)) throw new Error('Укажите короткое имя или ссылку на сообщество VK');
  return name;
}

export function coverImage(encoded) {
  if (typeof encoded !== 'string' || !encoded.length || encoded.length > 40_000_000 || encoded.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('Некорректный PNG обложки');
  const data = Buffer.from(encoded, 'base64');
  if (data.length > 30_000_000) throw new Error('Обложка должна быть меньше 30 МБ');
  if (data.length < 33 || imageType(data) !== 'image/png' || data.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Обложка должна быть в формате PNG');
  const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
  if (width < 100 || height < 100 || width > 8192 || height > 8192 || width * height > 32_000_000) throw new Error('Некорректный размер обложки');
  return { data, width, height };
}

export async function installCover({ community, image, call, fetcher = fetch }) {
  const name = coverCommunity(community);
  const direct = /^(?:club|public|event)?([1-9]\d*)$/.exec(name);
  const group = direct ? { type: 'group', object_id: Number(direct[1]) } : await call('utils.resolveScreenName', { screen_name: name });
  if (group?.type !== 'group' || !Number.isSafeInteger(group.object_id) || group.object_id < 1) throw new Error('Ссылка должна вести на сообщество VK, а не на личную страницу');
  const upload = await call('photos.getOwnerCoverPhotoUploadServer', { group_id: group.object_id, crop_x: 0, crop_y: 0, crop_x2: image.width, crop_y2: image.height });
  let url;
  try { url = new URL(upload.upload_url); } catch {}
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.port || !/(?:^|\.)(?:vk\.com|vk\.ru|userapi\.com|vkuserphoto\.ru)$/i.test(url.hostname)) throw new Error('VK вернул некорректный адрес загрузки обложки');
  const form = new FormData();
  form.append('photo', new Blob([image.data], { type: 'image/png' }), 'cover.png');
  let uploaded;
  try {
    const response = await fetcher(url.href, { method: 'POST', body: form, signal: AbortSignal.timeout(60000), redirect: 'error' });
    if (!response.ok) throw new Error(`Сервер загрузки обложки VK вернул HTTP ${response.status}`);
    uploaded = await response.json();
  } catch (error) {
    if (error.message.startsWith('Сервер загрузки')) throw error;
    throw new Error(`Не удалось загрузить обложку. ${connectionError(error)}`);
  }
  if (uploaded?.error || typeof uploaded?.hash !== 'string' || !uploaded.hash || typeof uploaded?.photo !== 'string' || !uploaded.photo) throw new Error('VK не принял изображение обложки. Проверьте размер холста и права токена.');
  const result = await call('photos.saveOwnerCoverPhoto', { hash: uploaded.hash, photo: uploaded.photo });
  if (!Array.isArray(result?.images) || !result.images.length) throw new Error('VK не подтвердил установку обложки. Проверьте страницу сообщества перед повторной попыткой.');
  return { installed: true, community: name, page: `https://vk.ru/club${group.object_id}` };
}
