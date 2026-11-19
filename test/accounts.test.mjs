import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { defaults, saveImage, writeJSON, digest, imagePath } from '../lib/storage.mjs';
import { createMediaStore } from '../lib/media.mjs';
import { createAccounts } from '../lib/accounts.mjs';
import { DatabaseSync } from 'node:sqlite';

const password = 'A private test password 123!';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=', 'base64');
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'kero-accounts-test-'));
  const { prepare, ...appOptions } = options; if (prepare) await prepare(root);
  let server, base;
  async function start() { server = await createApp(root, appOptions); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`; }
  async function stop() { if (server?.listening) await new Promise(resolve => server.close(resolve)); }
  await start(); t.after(async () => { await stop(); await rm(root, { recursive: true, force: true }); });
  const client = () => {
    let cookie;
    return {
      async call(path, input, headers = {}) {
        const response = await fetch(base + path, { method: input === undefined ? 'GET' : 'POST', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
        const changed = response.headers.get('set-cookie'); if (changed) cookie = changed.split(';')[0];
        return response;
      },
      async register(login) { const response = await this.call('/api/auth/register', { login, password }); assert.equal(response.status, 200); return (await response.json()).user; },
      async state() { const response = await this.call('/api/state'); assert.equal(response.status, 200); return response.json(); },
      async import() { const response = await this.call('/api/import', { name: 'photo.png', data: png.toString('base64') }); assert.equal(response.status, 200); return (await response.json()).id; },
      cookie: () => cookie,
    };
  };
  return { root, client, restart: async () => { await stop(); await start(); } };
}
async function blobs(root) { return readdir(join(root, 'data/blobs')).catch(error => { if (error.code === 'ENOENT') return []; throw error; }); }

test('account routes gate all private data, protect cookies, hash passwords and revoke sessions', async t => {
  const f = await fixture(t), alice = f.client(), stranger = f.client();
  assert.equal((await stranger.call('/api/state')).status, 401);
  assert.equal((await stranger.call('/api/import', {})).status, 401);
  assert.equal((await stranger.call(`/images/local_${digest(png)}`)).status, 401);
  assert.deepEqual(await (await stranger.call('/api/auth/session')).json(), { user: null });
  assert.equal((await stranger.call('/api/auth/register', { login: 'intruder', password }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await stranger.call('/api/auth/register', { login: 'intruder', password }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const registered = await alice.call('/api/auth/register', { login: 'Alice', password });
  assert.equal(registered.status, 200);
  assert.match(registered.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.match(registered.headers.get('set-cookie'), /Path=\//);
  const user = (await registered.json()).user;
  assert.deepEqual(Object.keys(user).sort(), ['hasFullAccess', 'id', 'isAdmin', 'isGlobalAdmin', 'login']); assert.equal(user.login, 'alice');
  assert.equal((await stranger.call('/api/auth/register', { login: 'ALICE', password })).status, 409);
  assert.equal((await stranger.call('/api/auth/login', { login: 'alice', password: 'wrong' })).status, 401);
  assert.equal((await stranger.call('/api/auth/register', { login: 'weak', password: 'short' })).status, 400);
  const connection = new DatabaseSync(join(f.root, 'data/kero.sqlite'), { readOnly: true });
  const users = connection.prepare('SELECT salt,password_hash FROM users').all(), sessions = connection.prepare('SELECT * FROM sessions').all(); connection.close();
  const stored = JSON.stringify({ users, sessions });
  assert.equal(stored.includes(password), false); assert.equal(stored.includes(alice.cookie().split('=')[1]), false);
  assert.equal(users[0].salt.length, 32);
  assert.equal((await stranger.call('/data/accounts.json')).status, 404);
  await f.restart(); assert.equal((await alice.state()).photos.length, 0);
  assert.equal((await alice.call('/api/auth/logout', {})).status, 200);
  assert.equal((await alice.call('/api/state')).status, 401);
  assert.equal((await alice.call('/api/auth/login', { login: 'alice', password })).status, 200);
  assert.equal((await alice.call('/api/auth/session')).status, 200);
});

test('registration accepts eight-character passwords and rejects seven-character passwords', async t => {
  const f = await fixture(t), user = f.client();
  const rejected = await user.call('/api/auth/register', { login: 'short_boundary', password: 'test123' });
  assert.equal(rejected.status, 400);
  const accepted = await user.call('/api/auth/register', { login: 'short_boundary', password: 'test1234' });
  assert.equal(accepted.status, 200);
  await user.call('/api/auth/logout', {});
  await f.restart();
  assert.equal((await user.call('/api/auth/login', { login: 'short_boundary', password: 'test1234' })).status, 200);
  assert.equal((await user.state()).photos.length, 0);
});

test('the first account receives the legacy project; other accounts have isolated settings and image ACLs', async t => {
  const id = `local_${digest(png)}`; let metadata;
  const f = await fixture(t, { prepare: async root => {
    metadata = await saveImage(root, id, png);
    await writeJSON(join(root, 'config/settings.json'), { ...defaults, rotation: 42 });
    await writeJSON(join(root, 'cache/library.json'), { photos: { [id]: { id, source: 'local', title: 'Legacy photo', ...metadata } } });
    await writeJSON(join(root, 'config/exclusions.json'), [id]);
  } });
  const alice = f.client(), bob = f.client(); const owner = await alice.register('owner');
  const own = await alice.state(); assert.equal(own.settings.rotation, 42); assert.deepEqual(own.exclusions, [id]); assert.equal(own.photos[0].available, true);
  assert.deepEqual(await readFile(imagePath(f.root, { id, ...metadata })), png);
  await bob.register('second'); const other = await bob.state();
  assert.equal(other.photos.length, 0); assert.equal(other.settings.rotation, defaults.rotation); assert.deepEqual(other.exclusions, []); assert.equal(other.hasToken, false);
  assert.equal((await bob.call(`/images/${id}?user=${owner.id}`)).status, 404);
  assert.deepEqual(Buffer.from(await (await alice.call(`/images/${id}`)).arrayBuffer()), png);
  const changed = await bob.call('/api/settings', { ...other.settings, rotation: 70 }); assert.equal(changed.status, 200);
  assert.equal((await alice.state()).settings.rotation, 42); assert.equal((await bob.state()).settings.rotation, 70);
  assert.equal((await bob.call('/api/images/open-folder', {})).status, 403);
  await f.restart(); assert.equal((await alice.state()).photos.length, 1); assert.equal((await bob.state()).photos.length, 0);
});

test('identical uploads have one physical copy; excluded references protect it until the final user removes it', async t => {
  const f = await fixture(t), alice = f.client(), bob = f.client();
  await alice.register('alpha'); await bob.register('bravo');
  const [first, second] = await Promise.all([alice.import(), bob.import()]);
  assert.equal(first, second); assert.equal((await blobs(f.root)).length, 1);
  await alice.call('/api/exclusions', [first]);
  const deleted = await bob.call('/api/files/delete', { source: 'local' }); assert.equal((await deleted.json()).removed, 1);
  assert.equal((await bob.state()).photos.length, 0); assert.equal((await blobs(f.root)).length, 1);
  assert.deepEqual(Buffer.from(await (await alice.call(`/images/${first}`)).arrayBuffer()), png);
  assert.equal((await bob.call(`/images/${first}`)).status, 404);
  await f.restart(); assert.equal((await alice.state()).photos[0].available, true);
  await alice.call('/api/files/delete', { source: 'local' }); assert.equal((await blobs(f.root)).length, 0);
  assert.deepEqual((await alice.state()).exclusions, []);
});

test('VK originals are reused between authorized libraries; clearing one user never clears another', async t => {
  let downloads = 0;
  const f = await fixture(t, { vkFactory: token => async method => {
    if (method === 'utils.resolveScreenName') return { type: 'group', object_id: 17 };
    if (token === 'denied') throw Error('Нет доступа к альбому');
    return { count: 1, items: [{ owner_id: -17, id: 1, sizes: [{ width: 1, height: 1, url: 'https://example.com/photo.png' }] }] };
  }, imageDownloader: async () => { downloads++; return png; } });
  const alice = f.client(), bob = f.client(); await alice.register('vk_alpha'); await bob.register('vk_bravo');
  async function sync(user) {
    const settings = (await user.state()).settings;
    await user.call('/api/settings', { ...settings, source: 'albums' }); await user.call('/api/token', { token: 'test-token' });
    assert.equal((await user.call('/api/sync', {})).status, 202);
    for (let i = 0; i < 100; i++) { const state = await (await user.call('/api/sync')).json(); if (!state.running) { assert.equal(state.error, undefined); assert.equal(state.failed, 0); return; } await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.fail('Sync did not finish');
  }
  await sync(alice); assert.equal((await bob.state()).hasToken, false);
  await sync(bob); assert.equal(downloads, 1); assert.equal((await blobs(f.root)).length, 1);
  const outsider = f.client(); await outsider.register('vk_outsider');
  await outsider.call('/api/settings', { ...(await outsider.state()).settings, source: 'albums' });
  await outsider.call('/api/token', { token: 'denied' }); await outsider.call('/api/sync', {});
  for (let i = 0; i < 100; i++) { if (!(await (await outsider.call('/api/sync')).json()).running) break; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal((await outsider.state()).photos.length, 0); assert.equal((await outsider.call('/images/vk_-17_1')).status, 404); assert.equal(downloads, 1);
  const id = 'vk_-17_1'; await alice.call('/api/files/delete', { source: 'vk' });
  assert.equal((await alice.state()).photos[0].available, false); assert.equal((await bob.state()).photos[0].available, true);
  assert.equal((await alice.call(`/images/${id}`)).status, 404); assert.equal((await bob.call(`/images/${id}`)).status, 200);
  await bob.call('/api/files/delete', { source: 'vk' }); assert.equal((await blobs(f.root)).length, 0);
});

test('in-flight attachments are retained during garbage collection', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kero-media-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = await createMediaStore(root), userA = join(root, 'a'), userB = join(root, 'b');
  const original = await store.put(userA, 'photo', png, 'image/png'); await store.commit(userA, { photos: { photo: original } });
  const second = await store.put(userB, 'photo', png, 'image/png');
  await store.commit(userA, { photos: {} }); await store.collect();
  assert.deepEqual(await readFile(store.path(second)), png);
  await store.commit(userB, { photos: { photo: second } }); await store.collect(); assert.equal((await blobs(root)).length, 1);
  await store.commit(userB, { photos: {} }); await store.collect(); assert.equal((await blobs(root)).length, 0);
});

test('sessions have an absolute expiration and never contain raw passwords', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kero-session-test-'));
  let clock = 1000, cookie;
  const service = await createAccounts(root, { now: () => clock });
  t.after(async () => { service.close(); await rm(root, { recursive: true, force: true }); });
  const req = { headers: {}, socket: { remoteAddress: '127.0.0.1', encrypted: true } }, res = { setHeader: (_, value) => { cookie = value; } };
  await service.authenticate(req, res, { login: 'expiry', password }, true);
  assert.match(cookie, /; Secure$/); req.headers.cookie = cookie.split(';')[0]; assert.equal(service.current(req).login, 'expiry');
  clock += 31 * 24 * 60 * 60 * 1000; assert.equal(service.current(req), null);
});

test('authentication attempts are rate-limited without storing credentials in the limit counters', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kero-rate-test-'));
  const service = await createAccounts(root), req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res = { setHeader() {} };
  t.after(async () => { service.close(); await rm(root, { recursive: true, force: true }); });
  await service.authenticate(req, res, { login: 'limited', password }, true);
  for (let i = 0; i < 14; i++) await assert.rejects(service.authenticate(req, res, { login: 'limited', password }, true), error => error.status === 409);
  await assert.rejects(service.authenticate(req, res, { login: 'limited', password }, false), error => error.status === 429);
});
