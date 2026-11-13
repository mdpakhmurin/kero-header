import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';
import { cacheValid, saveImage, writeJSON } from './storage.mjs';

export function connectionError(error) {
  const codes = [error.code, error.cause?.code, ...(error.cause?.errors ?? []).map(e => e.code)];
  if (codes.some(code => ['EACCES', 'EPERM'].includes(code))) return 'Доступ сервера к сети заблокирован (EACCES/EPERM). Запустите npm start в обычном локальном терминале или разрешите сетевой доступ процессу Node.js.';
  if (codes.some(code => ['ENOTFOUND', 'EAI_AGAIN'].includes(code))) return 'Не удалось найти api.vk.ru через DNS. Проверьте подключение и настройки DNS.';
  if (error.name === 'TimeoutError' || codes.some(code => ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(code))) return 'Истекло время подключения к API VK. Проверьте доступ к api.vk.ru и настройки VPN или прокси.';
  if (codes.some(code => ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(code))) return 'Не удалось проверить TLS-сертификат API VK. Проверьте сертификаты системы и настройки сетевого прокси.';
  if (Number.isInteger(error.httpStatus)) return `API VK вернул HTTP ${error.httpStatus}. Повторите позже или проверьте ограничения сети.`;
  if (error instanceof SyntaxError) return 'Вместо JSON API VK вернул неожиданный ответ. Возможна страница блокировки со стороны сети или прокси.';
  return 'Не удалось установить соединение с API VK. Проверьте доступ сервера к api.vk.ru и настройки VPN или прокси.';
}

export function createVK(token, { fetcher = fetch, delay = 360 } = {}) {
  let last = 0;
  return async (method, params) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      await sleep(Math.max(0, delay - (Date.now() - last)));
      last = Date.now();
      let data;
      try {
        const response = await fetcher(`https://api.vk.ru/method/${method}`, {
          method: 'POST', body: new URLSearchParams({ ...params, access_token: token, v: '5.199' }), signal: AbortSignal.timeout(30000)
        });
        if (!response.ok) throw Object.assign(new Error('VK HTTP error'), { httpStatus: response.status });
        data = await response.json();
      } catch (error) {
        if (['EACCES', 'EPERM'].includes(error.code) || ['EACCES', 'EPERM'].includes(error.cause?.code)) throw new Error(connectionError(error));
        if (attempt < 3) { await sleep(800 * (attempt + 1)); continue; }
        throw new Error(connectionError(error));
      }
      if ([6, 9, 10, 29].includes(data.error?.error_code) && attempt < 3) { await sleep(1200 * (attempt + 1)); continue; }
      if (data.error) {
        const code = data.error.error_code;
        // Never include request_params: VK echoes the access token there.
        let detail = String(data.error.error_msg || 'Причина не указана');
        for (const secret of [token, encodeURIComponent(token)]) if (secret) detail = detail.replaceAll(secret, '[токен скрыт]');
        detail = detail.replace(/https?:\/\/\S+/gi, '[адрес скрыт]').replace(/[\r\n]/g, ' ').slice(0, 350);
        const hint = [5, 27, 28].includes(code) ? 'VK не авторизовал этот запрос. Подробность выше — ответ VK; один код ошибки не определяет причину отказа.' : [7, 15, 203].includes(code) ? 'Токену недоступен этот метод или сообщество.' : 'Проверьте права токена и доступность сообщества.';
        throw new Error(`VK: ошибка ${code} в ${method}. ${detail}. ${hint}`);
      }
      if (data.response === undefined) throw new Error('VK вернул неожиданный ответ');
      return data.response;
    }
  };
}
export async function paginate(call, method, params, count, onPage) {
  for (let offset = 0; ; ) {
    const page = await call(method, { ...params, count, offset });
    if (!Array.isArray(page.items) || !Number.isFinite(page.count)) throw new Error(`Некорректный ответ ${method}`);
    await onPage(page.items, offset, page.count);
    offset += page.items.length;
    if (offset >= page.count) return;
    if (!page.items.length) throw new Error(`${method}: список изменился во время загрузки; повторите синхронизацию`);
  }
}
export function wallPhotos(post) {
  return [...(post.attachments ?? []).filter(a => a.type === 'photo').map(a => a.photo), ...(post.copy_history ?? []).flatMap(wallPhotos)];
}
function record(photo, community) {
  const size = [...(photo.sizes ?? [])].filter(s => s.url && s.width && s.height).sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (!size || !Number.isInteger(photo.owner_id) || !Number.isInteger(photo.id)) return null;
  return { id: `vk_${photo.owner_id}_${photo.id}`, source: 'vk', community, url: size.url, width: size.width, height: size.height, title: `Фото ${photo.owner_id}_${photo.id}`, page: `https://vk.ru/photo${photo.owner_id}_${photo.id}`, date: photo.date };
}
export async function downloadImage(url, fetcher = fetch) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('Некорректный адрес изображения VK');
  const response = await fetcher(url, { signal: AbortSignal.timeout(45000) });
  if (!response.ok) throw new Error(`Фото недоступно (HTTP ${response.status})`);
  if (Number(response.headers.get('content-length')) > 30_000_000) throw new Error('Фото больше 30 МБ');
  const parts = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 30_000_000) throw new Error('Фото больше 30 МБ');
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}
export async function syncLibrary({ root, settings, token, library, exclusions, status, call = createVK(token), download = downloadImage }) {
  status.message = 'Определяем сообщество…';
  const resolved = await call('utils.resolveScreenName', { screen_name: settings.community });
  if (resolved.type !== 'group') throw new Error('Адрес должен вести на сообщество VK');
  const owner_id = -resolved.object_id;
  const found = new Map();
  const collect = photo => { const p = record(photo, settings.community); if (p) found.set(p.id, p); };
  const warnings = [];
  let completed = 0;
  if (settings.source !== 'wall') {
    try {
      await paginate(call, 'photos.getAll', { owner_id, photo_sizes: 1, no_service_albums: 0 }, 200, (items, offset, total) => {
        items.forEach(collect); status.message = `Альбомы: ${offset + items.length} / ${total}`;
      });
      completed++;
    } catch (e) { warnings.push(e.message); }
  }
  if (settings.source !== 'albums') {
    try {
      await paginate(call, 'wall.get', { owner_id, filter: 'all' }, 100, (items, offset, total) => {
        items.flatMap(wallPhotos).forEach(collect); status.message = `Посты: ${offset + items.length} / ${total}`;
      });
      completed++;
    } catch (e) { warnings.push(e.message); }
  }
  if (!completed && !found.size) throw new Error(warnings.join(' '));
  status.total = found.size;
  const excluded = new Set(exclusions);
  for (const photo of found.values()) {
    const old = library.photos[photo.id];
    const current = { ...old, ...photo };
    library.photos[photo.id] = current;
    status.message = `Проверяем кеш: ${status.done + 1} / ${status.total}`;
    try {
      if (excluded.has(photo.id)) status.skipped++;
      else if (old && await cacheValid(root, old)) status.cached++;
      else {
        Object.assign(current, await saveImage(root, photo.id, await download(photo.url)));
        status.downloaded++;
      }
    } catch (e) { status.failed++; if (warnings.length < 20) warnings.push(`${photo.title}: ${e.message}`); }
    status.done++;
    if (status.done % 20 === 0) await writeJSON(join(root, 'cache/library.json'), library);
  }
  // Repair cached photos no longer listed by VK when their known URL is still usable.
  for (const photo of Object.values(library.photos)) {
    if (photo.source !== 'vk' || photo.community !== settings.community || found.has(photo.id) || excluded.has(photo.id)) continue;
    if (!await cacheValid(root, photo)) {
      try { Object.assign(photo, await saveImage(root, photo.id, await download(photo.url))); status.downloaded++; }
      catch { status.failed++; if (warnings.length < 20) warnings.push(`${photo.title}: отсутствует в кеше и недоступно по сохранённому адресу.`); }
    }
  }
  library.lastSync = new Date().toISOString();
  await writeJSON(join(root, 'cache/library.json'), library);
  status.warnings = warnings;
  status.message = `Готово: загружено ${status.downloaded}, уже в кеше ${status.cached}, исключено ${status.skipped}, ошибок ${status.failed}`;
}
