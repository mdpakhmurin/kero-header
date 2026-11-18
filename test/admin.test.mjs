import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server.mjs';
import { createAccounts } from '../lib/accounts.mjs';

const password = 'admin test password 123!';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=', 'base64');
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'kero-admin-test-')), globalAdminIds = [];
  let server, base;
  const start = async () => { server = await createApp(root, { ...options, globalAdminIds }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`; };
  const stop = async () => { if (server.listening) await new Promise(resolve => server.close(resolve)); };
  await start(); t.after(async () => { await stop(); await rm(root, { recursive: true, force: true }); });
  function client() {
    let cookie;
    return {
      async call(path, input) {
        const res = await fetch(base + '/api/' + path, { method: input === undefined ? 'GET' : 'POST', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
        const changed = res.headers.get('set-cookie'); if (changed) cookie = changed.split(';')[0]; return res;
      },
      async register(login, registrationKey) { const res = await this.call('auth/register', { login, password, registrationKey }); assert.equal(res.status, 200); this.user = (await res.json()).user; return this.user; },
      async import() { const res = await this.call('import', { name: 'test.png', data: png.toString('base64') }); assert.equal(res.status, 200); return (await res.json()).id; },
      async image(id) { return fetch(base + '/images/' + id, { headers: { Cookie: cookie } }); },
    };
  }
  const global = client(); const user = await global.register('global_owner'); globalAdminIds.push(user.id);
  await stop(); await start();
  return { root, client, global, restart: async () => { await stop(); await start(); } };
}

test('only configured global admins can assign administrators; regular admins cannot elevate or delete peers', async t => {
  const f = await fixture(t), regular = f.client(), delegated = f.client();
  await regular.register('regular'); await delegated.register('delegated');
  assert.equal((await f.client().call('admin/state')).status, 401);
  assert.equal((await regular.call('admin/state')).status, 403);
  assert.equal((await regular.call('admin/users/update', { id: regular.user.id, admin: true })).status, 403);
  let res = await f.global.call('admin/users/update', { id: delegated.user.id, admin: true }); assert.equal(res.status, 200);
  assert.equal((await (await delegated.call('auth/session')).json()).user.isAdmin, true);
  assert.equal((await delegated.call('admin/users/update', { id: regular.user.id, admin: true })).status, 403);
  assert.equal((await delegated.call('admin/users/delete', { id: f.global.user.id })).status, 403);
  assert.equal((await f.global.call('admin/users/delete', { id: f.global.user.id })).status, 400);
  assert.equal((await f.global.call('admin/users/update', { id: f.global.user.id, admin: false })).status, 403);
  res = await f.global.call('admin/state'); const data = await res.json();
  assert.equal(data.users.length, 3); assert.equal(data.users.find(user => user.id === f.global.user.id).isGlobalAdmin, true);
  assert.equal(JSON.stringify(data).includes('passwordHash'), false); assert.equal(JSON.stringify(data).includes('salt'), false);
  assert.equal((await delegated.call('admin/users/delete', { id: regular.user.id })).status, 200);
  assert.equal((await regular.call('state')).status, 401);
  assert.equal((await f.global.call('admin/policy', { globalAdminIds: [regular.user.id] })).status, 400);
  await f.restart(); assert.equal((await (await delegated.call('auth/session')).json()).user.isAdmin, true);
  await f.global.call('admin/policy', { grantAllRegistered: false });
  assert.equal((await delegated.call('state')).status, 200);
  await f.global.call('admin/users/update', { id: delegated.user.id, admin: false });
  assert.equal((await delegated.call('admin/state')).status, 403); assert.equal((await delegated.call('state')).status, 403);
});

test('full access is enforced for all data and originals, and individual access is restored without a new login', async t => {
  const f = await fixture(t), user = f.client(); await user.register('restricted'); const id = await user.import();
  assert.equal((await f.global.call('admin/policy', { grantAllRegistered: false })).status, 200);
  const denied = await user.call('state'); assert.equal(denied.status, 403); assert.equal((await denied.json()).code, 'FULL_ACCESS_REQUIRED');
  assert.equal((await user.image(id)).status, 403); assert.equal((await user.call('settings', {})).status, 403);
  assert.equal((await (await user.call('auth/session')).json()).user.hasFullAccess, false);
  assert.equal((await f.global.call('state')).status, 200);
  const forged = f.client(); const forgedRegistration = await forged.call('auth/register', { login: 'forged_access', password, fullAccess: true, admin: true });
  assert.equal(forgedRegistration.status, 200); const forgedUser = (await forgedRegistration.json()).user;
  assert.equal(forgedUser.isAdmin, false); assert.equal(forgedUser.hasFullAccess, false); assert.equal((await forged.call('state')).status, 403);
  assert.equal((await f.global.call('admin/users/update', { id: user.user.id, fullAccess: true })).status, 200);
  assert.equal((await user.call('state')).status, 200); assert.equal((await user.image(id)).status, 200);
  await f.global.call('admin/users/update', { id: user.user.id, fullAccess: false });
  await f.global.call('admin/policy', { grantAllRegistered: true }); assert.equal((await user.call('state')).status, 200);
  await f.global.call('admin/policy', { grantAllRegistered: false }); await f.restart(); assert.equal((await user.call('state')).status, 403);
});

test('closed registration uses hashed single-use keys atomically and never consumes them on invalid registration', async t => {
  const f = await fixture(t); await f.global.call('admin/policy', { openRegistration: false });
  assert.deepEqual(await (await f.client().call('auth/policy')).json(), { openRegistration: false });
  const missing = await f.client().call('auth/register', { login: 'missing_key', password }); assert.equal(missing.status, 400); assert.equal((await missing.json()).code, 'REGISTRATION_KEY_REQUIRED');
  const created = await (await f.global.call('admin/keys/create', { type: 'single', label: 'For one user' })).json();
  assert.match(created.code, /^kr_/);
  assert.equal((await readFile(join(f.root, 'data/accounts.json'), 'utf8')).includes(created.code), false);
  const invalid = await f.client().call('auth/register', { login: 'invalid_pass', password: 'short', registrationKey: created.code }); assert.equal(invalid.status, 400);
  const responses = await Promise.all([f.client().call('auth/register', { login: 'invite_one', password, registrationKey: created.code }), f.client().call('auth/register', { login: 'invite_two', password, registrationKey: created.code })]);
  assert.deepEqual(responses.map(res => res.status).sort(), [200, 400]);
  const data = await (await f.global.call('admin/state')).json(); assert.equal(data.keys[0].uses, 1); assert.equal(data.keys[0].active, false);
  assert.equal(JSON.stringify(data).includes(created.code), false); assert.equal(Object.hasOwn(data.keys[0], 'hash'), false);
  await f.restart(); assert.equal((await f.client().call('auth/register', { login: 'after_restart', password, registrationKey: created.code })).status, 400);
  await f.global.call('admin/policy', { openRegistration: true }); assert.equal((await f.client().call('auth/register', { login: 'open_again', password })).status, 200);
});

test('temporary keys expire, permanent keys allow multiple registrations, and revoked keys cannot be used', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kero-key-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  let clock = 1000, token; const ids = [];
  const service = await createAccounts(root, { now: () => clock, globalAdminIds: ids });
  const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res = { setHeader: (_, value) => { token = value.split(';')[0]; } };
  const owner = await service.authenticate(req, res, { login: 'key_owner', password }, true);
  const configured = await createAccounts(root, { now: () => clock, globalAdminIds: [owner.id] }); req.headers.cookie = token;
  const actor = configured.current(req); await configured.updatePolicy(actor, { openRegistration: false });
  const temporary = await configured.createKey(actor, { type: 'temporary', hours: 1 });
  clock += 2 * 3600000;
  const register = (login, code) => configured.authenticate({ headers: {}, socket: req.socket }, { setHeader() {} }, { login, password, registrationKey: code }, true);
  await assert.rejects(register('expired_key', temporary.code), /ключ/);
  const permanent = await configured.createKey(actor, { type: 'permanent' });
  await register('permanent_one', permanent.code); await register('permanent_two', permanent.code);
  assert.equal(configured.adminState(actor).keys.find(key => key.type === 'permanent').uses, 2);
  await configured.revokeKey(actor, permanent.keys.find(key => key.type === 'permanent').id);
  await assert.rejects(register('revoked_key', permanent.code), /ключ/);
});

test('deleting users revokes sessions and removes only their references to shared originals', async t => {
  const f = await fixture(t), alice = f.client(), bob = f.client(); await alice.register('delete_alice'); await bob.register('keep_bob');
  const id = await alice.import(); assert.equal(await bob.import(), id);
  assert.equal((await readdir(join(f.root, 'data/blobs'))).length, 1);
  assert.equal((await f.global.call('admin/users/delete', { id: alice.user.id })).status, 200);
  assert.equal((await alice.call('auth/session')).status, 200); assert.equal((await (await alice.call('auth/session')).json()).user, null);
  assert.equal((await alice.call('state')).status, 401); assert.equal((await bob.image(id)).status, 200);
  await assert.rejects(stat(join(f.root, 'data/users', alice.user.id)), { code: 'ENOENT' });
  assert.equal((await readdir(join(f.root, 'data/blobs'))).length, 1);
  await f.global.call('admin/users/delete', { id: bob.user.id }); assert.equal((await readdir(join(f.root, 'data/blobs'))).length, 0);
});

test('deleting a user waits for active VK synchronization to finish', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { vkFactory: () => async method => method === 'utils.resolveScreenName' ? { type: 'group', object_id: 42 } : method === 'photos.getAll' ? { count: 1, items: [{ owner_id: -42, id: 1, sizes: [{ width: 1, height: 1, url: 'https://example.com/a.png' }] }] } : { count: 0, items: [] }, imageDownloader: async () => { await gate; return png; } });
  const user = f.client(); await user.register('syncing_user'); await user.call('token', { token: 'test' });
  assert.equal((await user.call('sync', {})).status, 202);
  assert.equal((await f.global.call('admin/users/delete', { id: user.user.id })).status, 409); assert.equal((await user.call('state')).status, 200);
  release();
  for (let i = 0; i < 100; i++) { if (!(await (await user.call('sync')).json()).running) break; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal((await f.global.call('admin/users/delete', { id: user.user.id })).status, 200);
  assert.equal((await user.call('state')).status, 401);
});
