import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { coverCommunity, coverImage, installCover } from '../lib/cover.mjs';
import { createApp } from '../server.mjs';
import { defaults, writeJSON } from '../lib/storage.mjs';

const png = await readFile(new URL('../public/assets/pigeon.png', import.meta.url));
const image = coverImage(png.toString('base64'));

test('cover target accepts VK names and links but rejects other sites and deep links', () => {
  for (const name of ['kero_comics', 'https://vk.ru/kero_comics/', 'https://www.vk.com/kero_comics?from=test', 'vk.com/kero_comics']) assert.equal(coverCommunity(name), 'kero_comics');
  for (const name of ['', 'https://example.com/kero', 'https://vk.ru.evil.com/kero', 'https://vk.ru/kero/photos', 'https://user:pass@vk.ru/kero']) assert.throws(() => coverCommunity(name));
  assert.equal(image.width > 100, true);
  assert.throws(() => coverImage('broken PNG'));
  assert.throws(() => coverImage(Buffer.from('not an image').toString('base64')));
  const huge = Buffer.from(png); huge.writeUInt32BE(100000, 16);
  assert.throws(() => coverImage(huge.toString('base64')), /размер/);
});

test('cover upload uses full PNG dimensions and saves only the accepted upload', async () => {
  const calls = [];
  const call = async (method, params) => {
    calls.push([method, params]);
    if (method === 'utils.resolveScreenName') return { type: 'group', object_id: 123 };
    if (method === 'photos.getOwnerCoverPhotoUploadServer') return { upload_url: 'https://pu.vk.com/upload?target=123' };
    if (method === 'photos.saveOwnerCoverPhoto') return { images: [{ url: 'https://vk.com/cover.png' }] };
    throw new Error('Unexpected call');
  };
  const fetcher = async (url, options) => {
    assert.equal(url, 'https://pu.vk.com/upload?target=123');
    assert.equal(options.method, 'POST');
    const file = options.body.get('photo');
    assert.equal(file.name, 'cover.png'); assert.equal(file.type, 'image/png');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), png);
    return Response.json({ hash: 'accepted-hash', photo: 'accepted-photo' });
  };
  const result = await installCover({ community: 'https://vk.ru/kero_comics', image, call, fetcher });
  assert.equal(result.installed, true); assert.equal(result.page, 'https://vk.ru/club123');
  assert.deepEqual(calls[1][1], { group_id: 123, crop_x: 0, crop_y: 0, crop_x2: image.width, crop_y2: image.height });
  assert.deepEqual(calls[2], ['photos.saveOwnerCoverPhoto', { hash: 'accepted-hash', photo: 'accepted-photo' }]);
  calls.length = 0;
  await installCover({ community: 'public123', image, call, fetcher });
  assert.equal(calls[0][0], 'photos.getOwnerCoverPhotoUploadServer');
});

test('cover upload rejects profiles, unsafe servers and failed uploads before saving', async () => {
  let uploads = 0, saves = 0;
  const fetcher = async () => { uploads++; return Response.json({ error: 'failed', hash: '', photo: '' }); };
  await assert.rejects(installCover({ community: 'someone', image, fetcher, call: async () => ({ type: 'user', object_id: 1 }) }), /личную страницу/);
  assert.equal(uploads, 0);
  for (const url of ['http://pu.vk.com/upload', 'https://vk.com.evil.com/upload', 'https://127.0.0.1/upload']) {
    await assert.rejects(installCover({ community: 'club123', image, fetcher, call: async () => ({ upload_url: url }) }), /адрес/);
  }
  assert.equal(uploads, 0);
  await assert.rejects(installCover({ community: 'club123', image, fetcher, call: async method => {
    if (method === 'photos.saveOwnerCoverPhoto') saves++;
    return { upload_url: 'https://pu.vk.com/upload' };
  } }), /не принял/);
  assert.equal(uploads, 1); assert.equal(saves, 0);
});

test('cover endpoint requires confirmation and token, keeps the sync community unchanged', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kero-cover-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeJSON(join(root, 'config/settings.json'), defaults);
  let installed = 0;
  const server = await createApp(root, {
    vkFactory: () => async () => ({ type: 'group', object_id: 123 }),
    coverInstaller: async input => {
      installed++; assert.equal(input.community, 'other_public');
      assert.equal(input.image.width, image.width);
      return { installed: true, page: 'https://vk.ru/club123' };
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, data) => fetch(`${base}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  // Explicitly clear any token inherited from the developer's environment.
  await post('token', { token: '' });
  const payload = { community: 'https://vk.ru/other_public', data: png.toString('base64'), confirmed: true };
  assert.equal((await post('cover', payload)).status, 400);
  await post('token', { token: 'test-only-token' });
  assert.equal((await post('cover', { ...payload, confirmed: false })).status, 400);
  assert.equal((await post('cover', { ...payload, data: 'bad' })).status, 400);
  assert.equal(installed, 0);
  assert.equal((await (await post('cover', payload)).json()).installed, true);
  assert.equal(installed, 1);
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.settings.community, defaults.community);
  assert.equal(JSON.stringify(state).includes('test-only-token'), false);
});
