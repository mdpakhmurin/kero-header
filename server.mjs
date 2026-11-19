import http from 'node:http';
import { readFile, stat, readdir, unlink, mkdir, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJSON, validateSettings, validId, digest, saveImage, imagePath, readImage, releaseWorkspace } from './lib/storage.mjs';
import { syncLibrary, createVK } from './lib/vk.mjs';
import { openFolder } from './lib/folder.mjs';
import { coverCommunity, coverImage, installCover } from './lib/cover.mjs';
import { createAccounts } from './lib/accounts.mjs';
import { createMediaStore } from './lib/media.mjs';
import { loadWorkspace } from './lib/workspaces.mjs';
import { openDatabase } from './lib/database.mjs';
import { redactToken } from './lib/token-vault.mjs';
import { acquireAppLock } from './lib/app-lock.mjs';
import { removeMigratedVKToken, updateNumericAdminIds } from './lib/legacy-env.mjs';
import { parsePublicOrigin, allowedRequest } from './lib/web-origin.mjs';

const here = dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(join(here, '.env')); } catch (e) { if (e.code !== 'ENOENT') throw e; }

export async function createApp(root = here, { vkFactory = createVK, folderOpener = openFolder, coverInstaller = installCover, requireAuth = true, imageDownloader, globalAdminIds, encryptionKey, legacyToken, publicOrigin } = {}) {
  root = resolve(root);
  const origin = parsePublicOrigin(publicOrigin ?? (root === here ? process.env.PUBLIC_ORIGIN : ''));
  globalAdminIds ??= root === here ? (process.env.GLOBAL_ADMIN_IDS || '').split(',') : [];
  const releaseLock = requireAuth ? acquireAppLock(root) : () => {};
  let accounts, shared, database;
  try {
    database = requireAuth ? await openDatabase(root, { encryptionKey, legacyToken: legacyToken ?? (root === here ? process.env.VK_TOKEN || '' : '') }) : null;
    if (database && root === here) { await removeMigratedVKToken(root, database); await updateNumericAdminIds(root, database); }
    accounts = requireAuth ? await createAccounts(root, { globalAdminIds, database, secureCookies: origin?.startsWith('https://') }) : null; shared = requireAuth ? await createMediaStore(root, database) : null;
  } catch (error) { database?.close(); releaseLock(); throw error; }
  const deletingUsers = new Set();
  const workspaces = new Map(), pendingSync = new Set();
  const legacy = requireAuth ? null : await loadWorkspace(root, { token: process.env.VK_TOKEN || '' });
  function workspaceFor(user) {
    if (!requireAuth) return legacy;
    if (deletingUsers.has(user.id)) throw Object.assign(new Error('Аккаунт удаляется'), { status: 401 });
    if (!workspaces.has(user.id)) workspaces.set(user.id, loadWorkspace(join(root, 'data/users', String(user.id)), { shared, database, userId: user.id, inheritLegacy: user.legacyOwner }).catch(error => { workspaces.delete(user.id); throw error; }));
    return workspaces.get(user.id);
  }
  let mutation = Promise.resolve();
  const userVK = token => {
    let call; try { call = vkFactory(token); } catch (error) { throw new Error(redactToken(error.message, token)); }
    return async (...args) => { try { return await call(...args); } catch (error) { throw new Error(redactToken(error.message, token)); } };
  };
  const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  async function body(req, maximum = 42_000_000) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Нужен Content-Type application/json');
    const chunks = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > maximum) throw new Error('Файл слишком большой'); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString());
  }
  async function api(req, res, path, workspace) {
    let { root, settings, exclusions, favorites, library, token, sync } = workspace;
    try {
    if (req.method === 'GET' && path === '/api/state') {
      const photos = await Promise.all(Object.values(library.photos).map(async p => {
        let available = false;
        try { available = p.stored !== false && (await stat(imagePath(root, p))).size > 0; } catch (e) { if (e.code !== 'ENOENT') throw e; }
        const { url, hash, ...publicPhoto } = p;
        return { ...publicPhoto, available, version: hash, src: `/images/${p.id}` };
      }));
      return json(res, 200, { settings, exclusions, favorites, photos, lastSync: library.lastSync, hasToken: Boolean(token), sync });
    }
    if (req.method === 'GET' && path === '/api/sync') return json(res, 200, sync);
    if (req.method !== 'POST') return json(res, 404, { error: 'Не найдено' });
    const input = await body(req);
    if (path === '/api/cover') {
      if (input.confirmed !== true) throw new Error('Подтвердите замену обложки сообщества');
      if (!token) throw new Error('Добавьте токен VK в настройках подключения. Ему нужен доступ к изменению обложки сообщества.');
      const community = coverCommunity(input.community), image = coverImage(input.data);
      return json(res, 200, await coverInstaller({ community, image, call: userVK(token) }));
    }
    if (path === '/api/settings') { const next = validateSettings(input); await writeJSON(join(root, 'config/settings.json'), next); settings = next; return json(res, 200, settings); }
    if (path === '/api/favorites') {
      if (!Array.isArray(input) || input.length > 100000 || !input.every(id => validId(id) && library.photos[id])) throw new Error('Выберите фотографии своей библиотеки');
      const next = [...new Set(input)].sort(); await writeJSON(join(root, 'config/favorites.json'), next); favorites = next;
      return json(res, 200, favorites);
    }
    if (path === '/api/images/open-folder') {
      if (workspace.shared) return json(res, 403, { error: 'Папки сервера недоступны из пользовательской библиотеки' });
      const directory = join(root, 'cache/images');
      await mkdir(directory, { recursive: true });
      await folderOpener(directory);
      return json(res, 200, { opened: true });
    }
    if (path === '/api/files/delete' || path === '/api/cache/clear') {
      if (!['vk', 'local'].includes(input.source)) throw new Error('Выберите источник файлов: vk или local');
      if (sync.running) return json(res, 409, { error: 'Дождитесь окончания синхронизации перед удалением файлов' });
      if (workspace.shared) {
        const ids = new Set(Object.values(library.photos).filter(photo => input.source === 'local' ? photo.source === 'local' || photo.id.startsWith('local_') : (photo.source === 'vk' || photo.id.startsWith('vk_')) && photo.community === settings.community).map(photo => photo.id));
        if (input.source === 'local') exclusions.filter(id => id.startsWith('local_')).forEach(id => ids.add(id));
        for (const id of ids) { if (input.source === 'local') delete library.photos[id]; else library.photos[id].stored = false; }
        if (input.source === 'local') exclusions = exclusions.filter(id => !ids.has(id));
        if (input.source === 'local') favorites = favorites.filter(id => !ids.has(id));
        if (workspace.database) {
          workspace.database.saveWorkspace(workspace.userId, { library, exclusions, favorites });
          await workspace.shared.commit(root, library);
        } else {
          await writeJSON(join(root, 'cache/library.json'), library);
          if (input.source === 'local') { await writeJSON(join(root, 'config/exclusions.json'), exclusions); await writeJSON(join(root, 'config/favorites.json'), favorites); }
        }
        await workspace.shared.collect();
        return json(res, 200, { removed: ids.size, ids: [...ids] });
      }
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
        favorites = favorites.filter(id => !ids.has(id));
        await writeJSON(join(root, 'config/favorites.json'), favorites);
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
      if (/[\u0000-\u0020\u007f]/.test(candidate)) throw new Error('Токен VK не должен содержать пробелы или переносы строк');
      if (sync.running) throw Object.assign(new Error('Дождитесь окончания синхронизации перед изменением токена'), { status: 409 });
      if (candidate) await userVK(candidate)('utils.resolveScreenName', { screen_name: settings.community });
      workspace.database?.setToken(workspace.userId, candidate);
      token = candidate;
      if (!sync.running) sync = { running: false, message: '', warnings: [] };
      return json(res, 200, { hasToken: Boolean(token), verified: Boolean(token) });
    }
    if (path === '/api/sync') {
      if (sync.running) return json(res, 409, { error: 'Синхронизация уже идёт' });
      if (!token) return json(res, 400, { error: 'Добавьте токен VK в настройках подключения' });
      sync = { running: true, done: 0, total: 0, downloaded: 0, cached: 0, skipped: 0, failed: 0, message: 'Подключаемся к VK…', warnings: [] };
      const task = syncLibrary({ root, settings: { ...settings }, token, library, exclusions: [...exclusions], status: sync, call: userVK(token), download: imageDownloader, reuseImage: workspace.shared ? photo => workspace.shared.reuse(root, photo) : undefined })
        .catch(e => { sync.error = redactToken(e.message, token); sync.message = sync.error; }).finally(() => { sync.running = false; pendingSync.delete(task); });
      pendingSync.add(task);
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
    } finally { Object.assign(workspace, { settings, exclusions, favorites, library, token, sync }); }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (!allowedRequest(req, server.address().port, origin)) return json(res, 403, { error: 'Недопустимый адрес или источник запроса' });
    if (req.method === 'POST' && req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Недопустимый источник запроса' });
    try {
      const path = new URL(req.url, `http://${req.headers.host}`).pathname;
      if (path === '/__local/stop' && req.method === 'POST' && requireAuth) {
        const input = await body(req, 1024);
        if (typeof input.nonce !== 'string' || input.nonce !== releaseLock.nonce) return json(res, 403, { error: 'Недостаточно прав для остановки приложения' });
        res.setHeader('Connection', 'close'); json(res, 200, { stopping: true }); if (server.listening) server.close(); return;
      }
      if (path.startsWith('/api/')) {
        const handle = async () => {
          if (path === '/api/auth/session' && req.method === 'GET') return json(res, 200, { user: requireAuth ? accounts.describe(accounts.current(req)) : { id: 'local-preview', login: 'Локальный просмотр', hasFullAccess: true } });
          if (path === '/api/auth/policy' && req.method === 'GET') return json(res, 200, requireAuth ? accounts.registrationPolicy() : { openRegistration: true });
          if (['/api/auth/register', '/api/auth/login'].includes(path) && req.method === 'POST' && requireAuth) return json(res, 200, { user: await accounts.authenticate(req, res, await body(req, 4096), path.endsWith('/register')) });
          if (path === '/api/auth/logout' && req.method === 'POST' && requireAuth) { await body(req, 4096); await accounts.logout(req, res); return json(res, 200, { loggedOut: true }); }
          const user = requireAuth ? accounts.current(req) : null;
          if (requireAuth && (!user || deletingUsers.has(user.id))) return json(res, 401, { error: 'Войдите в аккаунт или продолжите в демо-режиме' });
          if (path.startsWith('/api/admin/')) {
            if (!requireAuth) return json(res, 403, { error: 'Администрирование недоступно в тестовом режиме' });
            if (path === '/api/admin/state' && req.method === 'GET') return json(res, 200, accounts.adminState(user));
            if (req.method !== 'POST') return json(res, 404, { error: 'Не найдено' });
            const input = await body(req, 8192);
            if (path === '/api/admin/policy') return json(res, 200, await accounts.updatePolicy(user, input));
            if (path === '/api/admin/users/update') return json(res, 200, await accounts.updateUser(user, input));
            if (path === '/api/admin/keys/create') return json(res, 200, await accounts.createKey(user, input));
            if (path === '/api/admin/keys/revoke') return json(res, 200, await accounts.revokeKey(user, input.id));
            if (path === '/api/admin/token-key/rotate') {
              if (!accounts.describe(user).isGlobalAdmin) return json(res, 403, { error: 'Сменить ключ шифрования может только глобальный администратор' });
              if (input.confirmed !== true) throw new Error('Подтвердите создание нового ключа шифрования');
              const rotation = await database.rotateTokenKey();
              return json(res, 200, { ...accounts.adminState(user), tokenKeyRotation: rotation });
            }
            if (path === '/api/admin/users/delete') {
              const target = accounts.assertDelete(user, input.id);
              if (!Number.isSafeInteger(target.id) || target.id < 1) throw new Error('Некорректный ID пользователя');
              deletingUsers.add(target.id);
              try {
                const active = await workspaces.get(target.id);
                if (active?.sync.running) throw Object.assign(new Error('Дождитесь окончания синхронизации пользователя'), { status: 409 });
                await accounts.deleteUser(user, target.id);
                const userRoot = resolve(root, 'data/users', String(target.id)), parent = resolve(root, 'data/users');
                if (!userRoot.startsWith(parent + '/') && !userRoot.startsWith(parent + '\\')) throw new Error('Некорректная папка пользователя');
                await rm(userRoot, { recursive: true, force: true });
                await shared.forget(userRoot); await shared.collect(); workspaces.delete(target.id);
                return json(res, 200, accounts.adminState(user));
              } finally { deletingUsers.delete(target.id); }
            }
            return json(res, 404, { error: 'Не найдено' });
          }
          if (requireAuth && !accounts.describe(user).hasFullAccess) return json(res, 403, { error: 'Для аккаунта доступен только демо-режим', code: 'FULL_ACCESS_REQUIRED' });
          return api(req, res, path, await workspaceFor(user));
        };
        if (req.method === 'POST') { const task = mutation.then(handle); mutation = task.catch(() => {}); await task; }
        else await handle();
        return;
      }
      if (req.method !== 'GET') return json(res, 405, { error: 'Метод не поддерживается' });
      if (path.startsWith('/images/')) {
        const user = requireAuth ? accounts.current(req) : null;
        if (requireAuth && !user) return json(res, 401, { error: 'Войдите в аккаунт' });
        if (requireAuth && (deletingUsers.has(user.id) || !accounts.describe(user).hasFullAccess)) return json(res, 403, { error: 'Нет доступа к полному режиму', code: 'FULL_ACCESS_REQUIRED' });
        const workspace = await workspaceFor(user), library = workspace.library;
        const id = path.slice(8);
        if (!validId(id) || !library.photos[id] || library.photos[id].stored === false) return json(res, 404, { error: 'Фото не найдено' });
        const data = await readImage(workspace.root, library.photos[id]);
        res.writeHead(200, { 'Content-Type': library.photos[id].mime || 'application/octet-stream', 'Cache-Control': requireAuth ? 'private, no-store' : 'no-cache' }); res.end(data); return;
      }
      const routes = { '/': ['index.html', 'text/html'], '/favicon.svg': ['assets/favicon.svg', 'image/svg+xml'], '/assets/favicon.svg': ['assets/favicon.svg', 'image/svg+xml'], '/app.js': ['app.js', 'text/javascript'], '/demo.js': ['demo.js', 'text/javascript'], '/auth.js': ['auth.js', 'text/javascript'], '/admin.js': ['admin.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/assets/okak.png': ['assets/okak.png', 'image/png'], '/assets/pigeon.png': ['assets/pigeon.png', 'image/png'], '/collage.js': ['collage.js', 'text/javascript'], '/library.js': ['library.js', 'text/javascript'], '/render.js': ['render.js', 'text/javascript'], '/previews.js': ['previews.js', 'text/javascript'], '/settings.js': ['settings.js', 'text/javascript'], '/history.js': ['history.js', 'text/javascript'], '/coverage.js': ['coverage.js', 'text/javascript'], '/viewer.js': ['viewer.js', 'text/javascript'] };
      if (!routes[path]) return json(res, 404, { error: 'Не найдено' });
      const [file, type] = routes[path];
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' }); res.end(await readFile(join(here, 'public', file)));
    } catch (e) {
      if (!res.headersSent) json(res, e.status || (e.code === 'ENOENT' ? 404 : 400), { error: e.code === 'ENOENT' ? 'Файл не найден' : ['EACCES', 'EPERM', 'ENOSPC', 'EIO', 'ERR_SQLITE_ERROR'].includes(e.code) ? 'Не удалось записать данные в хранилище сервера' : e.message, ...(e.publicCode ? { code: e.publicCode } : {}) });
      else res.end();
    }
  });
  const cleanup = () => { for (const id of workspaces.keys()) releaseWorkspace(join(root, 'data/users', String(id))); database?.close(); releaseLock(); };
  server.once('close', () => { if (pendingSync.size) Promise.allSettled([...pendingSync]).then(cleanup); else cleanup(); });
  server.once('listening', () => releaseLock.setPort?.(server.address().port));
  server.once('error', () => { if (!server.listening) cleanup(); });
  server.database = database;
  return server;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const app = await createApp();
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { if (app.listening) app.close(); });
  app.listen(Number(process.env.PORT || 3210), process.env.HOST || '127.0.0.1', () => console.log(`Kero Header → ${process.env.PUBLIC_ORIGIN || `http://localhost:${app.address().port}`}`));
}
