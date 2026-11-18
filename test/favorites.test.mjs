import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { canvasLayerOrder } from '../public/library.js';
import { defaults, validateSettings } from '../public/settings.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=', 'base64');
test('favorites are private, persist after restart and remain marked when excluded or reused by another user', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kero-favorite-test-')); let server, base;
  const start = async () => { server = await createApp(root, { globalAdminIds: [] }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`; };
  await start(); t.after(async () => { if (server.listening) await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  function client() {
    let cookie;
    return async (path, input) => {
      const response = await fetch(base + '/api/' + path, { method: input === undefined ? 'GET' : 'POST', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0]; return response;
    };
  }
  const a = client(), b = client();
  for (const [request, login] of [[a, 'favorite_a'], [b, 'favorite_b']]) assert.equal((await request('auth/register', { login, password: 'test-password-123' })).status, 200);
  const id = (await (await a('import', { name: 'original.png', data: png.toString('base64') })).json()).id;
  assert.equal((await b('favorites', [id])).status, 400);
  assert.equal((await a('favorites', [id, id])).status, 200);
  await a('exclusions', [id]);
  assert.deepEqual((await (await a('state')).json()).favorites, [id]);
  await b('import', { name: 'same.png', data: png.toString('base64') });
  assert.deepEqual((await (await b('state')).json()).favorites, []);
  await a('settings', { ...defaults, favoritesFirst: true });
  await new Promise(resolve => server.close(resolve)); await start();
  const restored = await (await a('state')).json(); assert.deepEqual(restored.favorites, [id]); assert.equal(restored.settings.favoritesFirst, true);
  await a('files/delete', { source: 'local' }); assert.deepEqual((await (await a('state')).json()).favorites, []);
  assert.equal((await (await b('state')).json()).photos[0].available, true);
});

test('favorite layer priority is stable, applies to every copy and can be disabled without mutating frames', () => {
  const frames = [{ id: 'fav', instanceId: 'a' }, { id: 'normal', instanceId: 'b' }, { id: 'fav', instanceId: 'c' }, { id: 'other', instanceId: 'd' }];
  const ordered = canvasLayerOrder(frames, ['fav'], true);
  assert.deepEqual(ordered.map(frame => frame.instanceId), ['b', 'd', 'a', 'c']);
  assert.equal(ordered[3], frames[2]); assert.equal(ordered.length, 4);
  assert.deepEqual(frames.map(frame => frame.instanceId), ['a', 'b', 'c', 'd']);
  assert.equal(canvasLayerOrder(frames, ['fav'], false), frames);
  assert.equal(validateSettings({}).favoritesFirst, false);
  assert.throws(() => validateSettings({ favoritesFirst: 'true' }), /избранного/);
});
