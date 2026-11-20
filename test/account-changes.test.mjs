import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

const password = 'test password 12345';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=', 'base64');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'kero-changes-')); let server, base;
  const start = async () => { server = await createApp(root, { globalAdminIds: [1, 2] }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}/api/`; };
  const stop = () => new Promise(resolve => server.close(resolve));
  await start(); t.after(async () => { await stop(); await rm(root, { recursive: true, force: true }); });
  function client() {
    let cookie;
    return {
      async call(path, input) {
        const res = await fetch(base + path, { method: input === undefined ? 'GET' : 'POST', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
        const next = res.headers.get('set-cookie'); if (next) cookie = next.split(';')[0];
        return { status: res.status, data: await res.json() };
      },
      async register(login) { const result = await this.call('auth/register', { login, password }); assert.equal(result.status, 200); this.user = result.data.user; return this; },
    };
  }
  return { root, client, restart: async () => { await stop(); await start(); } };
}

test('self credential changes verify the old password, enforce unique logins, revoke other sessions and persist a secret-free audit', async t => {
  const f = await fixture(t), owner = await f.client().register('owner'), peer = await f.client().register('peer'), second = f.client();
  await second.call('auth/login', { login: 'owner', password });
  assert.equal((await owner.call('auth/change', { kind: 'password', oldPassword: 'wrong', newPassword: 'new password 123' })).status, 400);
  assert.equal((await owner.call('auth/change', { kind: 'password', oldPassword: password, newPassword: 'short' })).status, 400);
  assert.equal((await owner.call('auth/change', { kind: 'login', oldPassword: password, login: 'PEER' })).status, 409);
  let changed = await owner.call('auth/change', { kind: 'login', oldPassword: password, login: 'New_Owner' }); assert.equal(changed.status, 200); assert.equal(changed.data.user.login, 'new_owner');
  assert.equal((await second.call('auth/session')).data.user, null);
  changed = await owner.call('auth/change', { kind: 'password', oldPassword: password, newPassword: 'new password 123' }); assert.equal(changed.status, 200);
  assert.equal((await owner.call('auth/session')).data.user.id, owner.user.id);
  const fresh = f.client(); assert.equal((await fresh.call('auth/login', { login: 'new_owner', password })).status, 401);
  assert.equal((await fresh.call('auth/login', { login: 'new_owner', password: 'new password 123' })).status, 200);
  await f.restart();
  const audit = (await owner.call('admin/state')).data.audit;
  assert.equal(audit.length, 2); assert.equal(audit[0].kind, 'password'); assert.equal(audit[1].kind, 'login');
  assert.equal(audit[1].oldLogin, 'owner'); assert.equal(audit[1].newLogin, 'new_owner');
  for (const event of audit) { assert.equal(event.actorId, owner.user.id); assert.equal(event.targetId, owner.user.id); assert.ok(event.createdAt > 0); }
  assert.doesNotMatch(JSON.stringify(audit), /test password|new password|passwordHash|salt/);
  assert.equal((await peer.call('auth/change', { kind: 'login', oldPassword: password, login: 'NEW_OWNER' })).status, 409);
});

test('admin credential permissions apply equally to login and password, including other global admins; audit survives target deletion', async t => {
  const f = await fixture(t), owner = await f.client().register('owner'), global = await f.client().register('global'), admin = await f.client().register('admin'), user = await f.client().register('reader');
  await owner.call('admin/users/update', { id: admin.user.id, admin: true });
  for (const kind of ['login', 'password']) {
    const value = kind === 'login' ? { login: 'renamed' } : { newPassword: 'reset password 123' };
    for (const target of [owner, global, admin]) assert.equal((await admin.call('admin/users/credentials', { id: target.user.id, kind, ...value })).status, 403);
    assert.equal((await owner.call('admin/users/credentials', { id: owner.user.id, kind, ...value })).status, 403);
    assert.equal((await user.call('admin/users/credentials', { id: admin.user.id, kind, ...value })).status, 403);
  }
  assert.equal((await admin.call('admin/users/credentials', { id: user.user.id, kind: 'login', login: 'reader_new' })).status, 200);
  assert.equal((await user.call('auth/session')).data.user, null);
  assert.equal((await admin.call('admin/users/credentials', { id: user.user.id, kind: 'password', newPassword: 'reset password 123' })).status, 200);
  assert.equal((await owner.call('admin/users/credentials', { id: global.user.id, kind: 'password', newPassword: 'global reset 123' })).status, 200);
  assert.equal((await global.call('auth/session')).data.user, null);
  await owner.call('admin/users/delete', { id: user.user.id }); await f.restart();
  const audit = (await owner.call('admin/state')).data.audit;
  assert.equal(audit.length, 3); assert.equal(audit.filter(event => event.targetId === user.user.id).length, 2);
  assert.ok(audit.some(event => event.actorId === admin.user.id && event.targetId === user.user.id));
});

test('photo names and selected deletion are personal even when originals are shared', async t => {
  const f = await fixture(t), one = await f.client().register('first'), two = await f.client().register('second');
  const upload = { name: 'original.png', data: png.toString('base64') };
  const id = (await one.call('import', upload)).data.id; await two.call('import', upload);
  assert.equal((await one.call('photos/rename', { id, title: 'Моя фотография.png' })).status, 200);
  for (const title of ['Моя фотография.jpg','Без расширения']) assert.equal((await one.call('photos/rename', {id,title})).status,400);
  assert.equal((await two.call('state')).data.photos[0].title, 'original.png');
  await f.restart(); assert.equal((await one.call('state')).data.photos[0].title, 'Моя фотография.png');
  assert.equal((await one.call('photos/rename', { id, title: ' \n ' })).status, 400);
  assert.equal((await one.call('photos/delete', { ids: ['vk_1_123'] })).status, 400);
  await one.call('favorites', [id]); await one.call('exclusions', [id]);
  assert.equal((await one.call('photos/delete', { ids: [id] })).status, 200);
  const state = (await one.call('state')).data; assert.equal(state.photos.length, 0); assert.deepEqual(state.favorites, []); assert.deepEqual(state.exclusions, []);
  assert.equal((await two.call('state')).data.photos[0].available, true);
  assert.equal((await readdir(join(f.root, 'data/blobs'))).length, 1);
  await two.call('photos/delete', { ids: [id] }); assert.equal((await readdir(join(f.root, 'data/blobs'))).length, 0);
});
