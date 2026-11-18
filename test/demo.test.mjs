import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { initialMode, createClient, createDemoBackend } from '../public/demo.js';
import { defaults } from '../public/settings.js';
import { photoSource } from '../public/library.js';

function memoryStore() {
  const meta = new Map(), photos = new Map();
  return {
    async read() { return structuredClone({ settings: meta.get('settings'), exclusions: meta.get('exclusions'), favorites: meta.get('favorites'), photos: [...photos.values()] }); },
    async saveMeta(key, value) { meta.set(key, structuredClone(value)); },
    async putPhoto(photo) { photos.set(photo.id, structuredClone({ ...photo, addedAt: photos.get(photo.id)?.addedAt || photo.addedAt })); },
    async clearPhotos() { const ids = [...photos.keys()]; photos.clear(); meta.set('exclusions', []); meta.set('favorites', []); return ids; },
  };
}
function fixture(store = memoryStore()) {
  const revoked = []; let counter = 0, network = 0;
  const demo = createDemoBackend({ store, digest: bytes => webcrypto.subtle.digest('SHA-256', bytes), urls: { createObjectURL: () => `blob:demo/${++counter}`, revokeObjectURL: url => revoked.push(url) } });
  const client = createClient({ demoMode: true, demo, fetcher: async () => { network++; throw Error('Network must not be used'); } });
  return { demo, client, revoked, network: () => network, store };
}
const file = () => new File([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=', 'base64')], 'Локальный голубь.png', { type: 'image/png' });

test('demo mode is selected before startup requests; explicit URL mode overrides browser preference', () => {
  assert.equal(initialMode('?mode=demo', 'local'), 'demo');
  assert.equal(initialMode('?mode=local', 'demo'), 'local');
  assert.equal(initialMode('', 'demo'), 'demo');
  assert.equal(initialMode('?mode=unknown', null), 'local');
});

test('demo imports, persists, reads and exports originals entirely within browser storage', async () => {
  const f = fixture();
  assert.equal((await f.client.request('state')).photos.length, 0);
  const original = file(), { id } = await f.client.request('import', { file: original, dimensions: { width: 1, height: 1 } });
  let state = await f.client.request('state');
  assert.match(id, /^local_[a-f0-9]{64}$/);
  assert.equal(state.photos[0].title, original.name);
  assert.match(state.photos[0].src, /^blob:/);
  assert.equal(photoSource(state.photos[0]).href, state.photos[0].src);
  assert.deepEqual(await (await f.client.photoBlob(state.photos[0])).arrayBuffer(), await original.arrayBuffer());
  const url = state.photos[0].src, addedAt = state.photos[0].addedAt;
  await f.client.request('import', { file: original, dimensions: { width: 1, height: 1 } });
  state = await f.client.request('state');
  assert.equal(state.photos.length, 1); assert.equal(state.photos[0].src, url); assert.equal(state.photos[0].addedAt, addedAt);
  const nextPage = fixture(f.store);
  assert.equal((await nextPage.client.request('state')).photos[0].id, id);
  assert.equal(f.network(), 0); assert.equal(nextPage.network(), 0);
});

test('demo settings, named sizes and exclusions survive reload; clear affects browser files only', async () => {
  const f = fixture(), { id } = await f.client.request('import', { file: file(), dimensions: { width: 1, height: 1 } });
  const settings = { ...defaults, width: 1200, height: 500, coverSizes: [{ width: 1200, height: 500, name: 'Браузер' }], rotation: 40 };
  await f.client.request('settings', settings);
  await f.client.request('exclusions', [id]);
  const nextPage = fixture(f.store), state = await nextPage.client.request('state');
  assert.deepEqual(state.settings, settings); assert.deepEqual(state.exclusions, [id]);
  const deleted = await nextPage.client.request('files/delete', { source: 'local' });
  assert.deepEqual(deleted, { removed: 1, ids: [id] });
  const empty = await nextPage.client.request('state');
  assert.equal(empty.photos.length, 0); assert.deepEqual(empty.exclusions, []); assert.equal(empty.settings.rotation, 40);
  assert.equal(nextPage.revoked.length, 1); assert.equal(nextPage.network(), 0);
});

test('demo refuses every server-only endpoint and never falls back to network after storage failure', async () => {
  const f = fixture();
  for (const route of ['sync', 'token', 'cover', 'images/open-folder', 'unknown']) await assert.rejects(f.client.request(route, {}), /демо-режиме/);
  await assert.rejects(f.client.request('files/delete', { source: 'vk' }), /демо-режиме/);
  await assert.rejects(f.client.request('import', { file: new Blob(['not an image']), dimensions: { width: 1, height: 1 } }), /JPEG/);
  await assert.rejects(f.client.request('settings', { width: 0 }), /width/);
  const blocked = fixture({ read: async () => { throw Error('Storage blocked'); } });
  await assert.rejects(blocked.client.request('state'), /Storage blocked/);
  await assert.rejects(blocked.client.photoBlob({ id: 'missing', src: '/images/missing' }), /браузера/);
  assert.equal(f.network(), 0); assert.equal(blocked.network(), 0);
});

test('normal mode keeps using the project API and original image URLs', async () => {
  const calls = [], client = createClient({ demoMode: false, fetcher: async (url, options) => { calls.push({ url, options }); return new Response(url.startsWith('/api/') ? '{"ok":true}' : 'original', { headers: { 'Content-Type': url.startsWith('/api/') ? 'application/json' : 'image/png' } }); } });
  assert.deepEqual(await client.request('state'), { ok: true });
  await client.request('settings', { width: 1920 });
  assert.equal(await (await client.photoBlob({ src: '/images/photo' })).text(), 'original');
  assert.equal(calls[0].url, '/api/state'); assert.equal(calls[1].options.method, 'POST'); assert.equal(calls[2].url, '/images/photo');
});

test('demo favorites and their canvas order persist locally without network requests', async () => {
  const f = fixture(), { id } = await f.client.request('import', { file: file(), dimensions: { width: 1, height: 1 } });
  await f.client.request('state'); await f.client.request('favorites', [id]);
  await f.client.request('settings', { ...defaults, favoritesFirst: true });
  const reload = fixture(f.store), state = await reload.client.request('state');
  assert.deepEqual(state.favorites, [id]); assert.equal(state.settings.favoritesFirst, true);
  await reload.client.request('favorites', []); assert.deepEqual((await reload.client.request('state')).favorites, []);
  await reload.client.request('favorites', [id]); await reload.client.request('files/delete', { source: 'local' });
  assert.deepEqual((await reload.client.request('state')).favorites, []);
  assert.equal(f.network(), 0); assert.equal(reload.network(), 0);
});
