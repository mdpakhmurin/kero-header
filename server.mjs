import http from 'node:http';
import { readFile, stat, readdir, unlink, mkdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaults, readJSON, writeJSON, validateSettings, validId, digest, saveImage, imagePath, readImage, migrateImageFiles, migrateLocalDates } from './lib/storage.mjs';
import { syncLibrary, createVK } from './lib/vk.mjs';
import { openFolder } from './lib/folder.mjs';
import { coverCommunity, coverImage, installCover } from './lib/cover.mjs';

const here = dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(join(here, '.env')); } catch (e) { if (e.code !== 'ENOENT') throw e; }

export async function createApp(root = here, { vkFactory = createVK, folderOpener = openFolder, coverInstaller = installCover } = {}) {
  let settings = validateSettings(await readJSON(join(root, 'config/settings.json'), defaults));
  let exclusions = await readJSON(join(root, 'config/exclusions.json'), []);
  let library = await readJSON(join(root, 'cache/library.json'), { photos: {}, lastSync: null });
  await migrateImageFiles(root, library);
  await migrateLocalDates(root, library);
  let token = process.env.VK_TOKEN || '';
  let sync = { running: false, message: '', warnings: [] };
  let mutation = Promise.resolve();
  const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  async function body(req) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Нужен Content-Type application/json');
    const chunks = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 42_000_000) throw new Error('Файл слишком большой'); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString());
  }
  async function api(req, res, path) {
    if (req.method === 'GET' && path === '/api/state') {
      const photos = await Promise.all(Object.values(library.photos).map(async p => {
        let available = false;
        try { available = (await stat(imagePath(root, p))).size > 0; } catch (e) { if (e.code !== 'ENOENT') throw e; }
        const { url, hash, ...publicPhoto } = p;
        return { ...publicPhoto, available, src: `/images/${p.id}` };
      }));
      return json(res, 200, { settings, exclusions, photos, lastSync: library.lastSync, hasToken: Boolean(token), sync });
    }
    if (req.method === 'GET' && path === '/api/sync') return json(res, 200, sync);
    if (req.method !== 'POST') return json(res, 404, { error: 'Не найдено' });
    const input = await body(req);
    if (path === '/api/cover') {
      if (input.confirmed !== true) throw new Error('Подтвердите замену обложки сообщества');
      if (!token) throw new Error('Добавьте токен VK в настройках подключения. Ему нужен доступ к изменению обложки сообщества.');
      const community = coverCommunity(input.community), image = coverImage(input.data);
      return json(res, 200, await coverInstaller({ community, image, call: vkFactory(token) }));
    }
    if (path === '/api/settings') { const next = validateSettings(input); await writeJSON(join(root, 'config/settings.json'), next); settings = next; return json(res, 200, settings); }
    if (path === '/api/images/open-folder') {
      const directory = join(root, 'cache/images');
      await mkdir(directory, { recursive: true });
      await folderOpener(directory);
      return json(res, 200, { opened: true });
    }
    if (path === '/api/files/delete' || path === '/api/cache/clear') {
      if (!['vk', 'local'].includes(input.source)) throw new Error('Выберите источник файлов: vk или local');
      if (sync.running) return json(res, 409, { error: 'Дождитесь окончания синхронизации перед удалением файлов' });
      const directory = join(root, 'cache/images');
      const files = await readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
      const ids = new Set(Object.values(library.photos).filter(photo => input.source === 'local' ? photo.source === 'local' || photo.id.startsWith('local_') : photo.source === 'vk' && photo.community === settings.community).map(photo => photo.id));
      if (input.source === 'local') exclusions.filter(id => id.startsWith('local_')).forEach(id => ids.add(id));
      let removed = 0;
      for (const file of files) {
        const match = /^(.*)\.(?:img|png|jpg|webp)$/.exec(file.name);
        if ((!file.isFile() && !file.isSymbolicLink()) || !match || !validId(match[1])) continue;
        if (input.source === 'local' && match[1].startsWith('local_')) ids.add(match[1]);
        if (!ids.has(match[1])) continue;
        try { await unlink(join(directory, file.name)); removed++; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (input.source === 'local') {
        for (const id of ids) delete library.photos[id];
        exclusions = exclusions.filter(id => !ids.has(id));
        await writeJSON(join(root, 'cache/library.json'), library);
        await writeJSON(join(root, 'config/exclusions.json'), exclusions);
      }
      return json(res, 200, { removed, ids: [...ids] });
    }
    if (path === '/api/exclusions') {
      if (!Array.isArray(input) || input.length > 100000 || !input.every(validId)) throw new Error('Некорректный список исключений');
      const next = [...new Set(input)].sort();
      await writeJSON(join(root, 'config/exclusions.json'), next); exclusions = next;
      return json(res, 200, exclusions);
    }
    if (path === '/api/token') {
      if (typeof input.token !== 'string' || input.token.length > 4096) throw new Error('Некорректный токен');
      const candidate = input.token.trim();
      if (candidate) await vkFactory(candidate)('utils.resolveScreenName', { screen_name: settings.community });
      token = candidate;
      if (!sync.running) sync = { running: false, message: '', warnings: [] };
      return json(res, 200, { hasToken: Boolean(token), verified: Boolean(token) });
    }
    if (path === '/api/sync') {
      if (sync.running) return json(res, 409, { error: 'Синхронизация уже идёт' });
      if (!token) return json(res, 400, { error: 'Добавьте токен VK в настройках подключения' });
      sync = { running: true, done: 0, total: 0, downloaded: 0, cached: 0, skipped: 0, failed: 0, message: 'Подключаемся к VK…', warnings: [] };
      syncLibrary({ root, settings: { ...settings }, token, library, exclusions: [...exclusions], status: sync })
        .catch(e => { sync.error = e.message; sync.message = e.message; }).finally(() => { sync.running = false; });
      return json(res, 202, sync);
    }
    if (path === '/api/import') {
      if (sync.running) return json(res, 409, { error: 'Дождитесь окончания синхронизации' });
      if (typeof input.data !== 'string' || input.data.length > 40_000_000) throw new Error('Максимум 30 МБ на файл');
      const data = Buffer.from(input.data, 'base64');
      if (data.length > 30_000_000) throw new Error('Максимум 30 МБ на файл');
      const id = `local_${digest(data)}`;
      const metadata = await saveImage(root, id, data);
      const previousDate = library.photos[id]?.addedAt;
      const addedAt = Number.isFinite(previousDate) && previousDate > 0 ? previousDate : Date.now();
      const photo = { id, source: 'local', addedAt, title: String(input.name || 'Изображение').slice(0, 200), ...metadata };
      library.photos[id] = photo;
      await writeJSON(join(root, 'cache/library.json'), library);
      return json(res, 200, { id });
    }
    return json(res, 404, { error: 'Не найдено' });
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const allowed = new Set([`localhost:${server.address().port}`, `127.0.0.1:${server.address().port}`]);
    if (!allowed.has(req.headers.host) || (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)) return json(res, 403, { error: 'Доступ разрешён только локальному приложению' });
    try {
      const path = new URL(req.url, `http://${req.headers.host}`).pathname;
      if (path.startsWith('/api/')) {
        if (req.method === 'POST') { const task = mutation.then(() => api(req, res, path)); mutation = task.catch(() => {}); await task; }
        else await api(req, res, path);
        return;
      }
      if (req.method !== 'GET') return json(res, 405, { error: 'Метод не поддерживается' });
      if (path.startsWith('/images/')) {
        const id = path.slice(8);
        if (!validId(id) || !library.photos[id]) return json(res, 404, { error: 'Фото не найдено' });
        const data = await readImage(root, library.photos[id]);
        res.writeHead(200, { 'Content-Type': library.photos[id].mime || 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(data); return;
      }
      const routes = { '/': ['index.html', 'text/html'], '/favicon.svg': ['assets/favicon.svg', 'image/svg+xml'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/assets/okak.png': ['assets/okak.png', 'image/png'], '/assets/pigeon.png': ['assets/pigeon.png', 'image/png'], '/collage.js': ['collage.js', 'text/javascript'], '/library.js': ['library.js', 'text/javascript'], '/render.js': ['render.js', 'text/javascript'], '/settings.js': ['settings.js', 'text/javascript'], '/history.js': ['history.js', 'text/javascript'], '/coverage.js': ['coverage.js', 'text/javascript'], '/viewer.js': ['viewer.js', 'text/javascript'] };
      if (!routes[path]) return json(res, 404, { error: 'Не найдено' });
      const [file, type] = routes[path];
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' }); res.end(await readFile(join(here, 'public', file)));
    } catch (e) { if (!res.headersSent) json(res, e.code === 'ENOENT' ? 404 : 400, { error: e.message }); else res.end(); }
  });
  return server;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const app = await createApp();
  app.listen(Number(process.env.PORT || 3210), '127.0.0.1', () => console.log(`Kero Header → http://localhost:${app.address().port}`));
}
