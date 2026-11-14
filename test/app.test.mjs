import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { defaults, validateSettings, validateLayout, cacheValid } from '../lib/storage.mjs';
import { syncLibrary, paginate, wallPhotos, createVK, connectionError } from '../lib/vk.mjs';
import { createApp } from '../server.mjs';
import { generate, hitTest } from '../public/collage.js';
import { photoSource } from '../public/library.js';
import { photoSizeRange } from '../public/settings.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=', 'base64');
async function fixture(t) { const root = await mkdtemp(join(tmpdir(), 'kero-test-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
const status = () => ({ done: 0, total: 0, downloaded: 0, cached: 0, skipped: 0, failed: 0, warnings: [] });
const photo = id => ({ owner_id: -123, id, sizes: [{ width: 100, height: 100, url: `https://example.com/${id}.png` }] });

test('network errors explain the cause without exposing request secrets', async () => {
  let calls = 0;
  const call = createVK('private-token', { delay: 0, fetcher: async () => {
    calls++;
    throw Object.assign(new Error('private-token'), { cause: { code: 'EACCES' } });
  } });
  await assert.rejects(call('utils.resolveScreenName', {}), e => /EACCES/.test(e.message) && !e.message.includes('private-token'));
  assert.equal(calls, 1);
  assert.match(connectionError({ cause: { code: 'ENOTFOUND' } }), /DNS/);
  assert.match(connectionError({ name: 'TimeoutError' }), /время/);
  assert.match(connectionError({ httpStatus: 503 }), /HTTP 503/);
  assert.match(connectionError(new SyntaxError('private-token')), /JSON/);
});

test('generation uses fresh randomness, supports explicit seeds and respects ranges', t => {
  const photos = Array.from({ length: 120 }, (_, i) => ({ id: `vk_-1_${i}` }));
  const a = generate(photos, defaults, 42), b = generate([...photos].reverse(), defaults, 42);
  assert.deepEqual(a, b); assert.equal(new Set(a.map(i => i.id)).size, 120);
  const range = photoSizeRange(defaults);
  assert.ok(a.every(i => i.width >= range.minSize && i.width <= range.maxSize && Math.abs(i.angle) <= defaults.rotation));
  assert.notDeepEqual(a, generate(photos, defaults, 43));
  let draw = 0;
  t.mock.method(Math, 'random', () => ++draw / 4);
  assert.notDeepEqual(generate(photos, defaults), generate(photos, defaults));
  t.mock.restoreAll();
  assert.equal(generate(photos, { ...defaults, count: 7 }).length, 7);
  assert.deepEqual(generate([], defaults), []);
});
test('hit testing respects rotation and image aspect ratio', () => {
  const item = { x: 100, y: 100, width: 100, angle: 90 };
  assert.ok(hitTest(item, .2, 100, 140)); assert.ok(!hitTest(item, .2, 140, 100));
});
test('settings and layout reject invalid dimensions and path-like IDs', () => {
  assert.throws(() => validateSettings({ ...defaults, width: 8192, height: 8192 }));
  assert.throws(() => validateSettings({ ...defaults, photoSize: 999 }));
  assert.throws(() => validateSettings({ ...defaults, sizeDeviation: 301 }));
  assert.throws(() => validateLayout({ items: [{ id: '../../.env', x: 1, y: 1, width: 100, angle: 0 }] }));
  assert.equal(validateSettings({ ...defaults, community: 'https://vk.ru/kero_comics' }).community, 'kero_comics');
  assert.equal('scatter' in validateSettings({ ...defaults, scatter: 100 }), false);
});

test('saved cover sizes are validated, deduplicated and include the current dimensions', () => {
  const migrated = validateSettings({ width: 1200, height: 500 });
  assert.deepEqual(migrated.coverSizes, [...defaults.coverSizes, { width: 1200, height: 500 }]);
  const settings = validateSettings({ ...defaults, coverSizes: [...defaults.coverSizes, defaults.coverSizes[0]] });
  assert.deepEqual(settings.coverSizes, defaults.coverSizes);
  for (const size of [{ width: 0, height: 400 }, { width: 1200.5, height: 500 }, { width: 8192, height: 8192 }, null]) {
    assert.throws(() => validateSettings({ ...defaults, coverSizes: [size] }), /размер обложки/);
  }
  assert.throws(() => validateSettings({ ...defaults, coverSizes: '1200x500' }));
  assert.throws(() => validateSettings({ ...defaults, coverSizes: Array(101).fill(defaults.coverSizes[0]) }));
});
test('pagination continues across pages; repost attachments are included', async () => {
  const offsets = [], result = [];
  await paginate(async (_, args) => { offsets.push(args.offset); return { count: 5, items: Array.from({ length: Math.min(2, 5 - args.offset) }, (_, i) => i + args.offset) }; }, 'photos.getAll', {}, 2, items => result.push(...items));
  assert.deepEqual(offsets, [0, 2, 4]); assert.deepEqual(result, [0, 1, 2, 3, 4]);
  assert.equal(wallPhotos({ attachments: [{ type: 'photo', photo: photo(1) }], copy_history: [{ attachments: [{ type: 'photo', photo: photo(2) }] }] }).length, 2);
  await assert.rejects(paginate(async () => ({ count: 5, items: [] }), 'wall.get', {}, 100, () => {}));
});
test('sync downloads and repairs excluded photos as well as active photos', async t => {
  const root = await fixture(t), library = { photos: {} }; let downloads = 0;
  const call = async method => method === 'utils.resolveScreenName' ? { type: 'group', object_id: 123 } : method === 'photos.getAll' ? { count: 2, items: [photo(1), photo(2)] } : { count: 1, items: [{ attachments: [{ type: 'photo', photo: photo(1) }] }] };
  const run = async exclusions => { const s = status(); await syncLibrary({ root, settings: defaults, library, exclusions, status: s, call, download: async () => { downloads++; return png; } }); return s; };
  assert.equal((await run(['vk_-123_2'])).downloaded, 2); assert.equal(downloads, 2);
  assert.equal((await run([])).cached, 2); assert.equal(downloads, 2);
  await unlink(join(root, 'cache/images/vk_-123_1.png'));
  assert.equal((await run([])).downloaded, 1); assert.equal(downloads, 3);
  await writeFile(join(root, 'cache/images/vk_-123_1.png'), 'broken');
  assert.equal((await run([])).downloaded, 1); assert.equal(downloads, 4);
  await unlink(join(root, 'cache/images/vk_-123_2.png'));
  assert.equal((await run(['vk_-123_2'])).downloaded, 1); assert.equal(downloads, 5);
  assert.ok(await cacheValid(root, library.photos['vk_-123_1']));
  assert.ok(await cacheValid(root, library.photos['vk_-123_2']));
  assert.equal((await run([])).downloaded, 0);
  library.photos['vk_-123_3'] = { ...library.photos['vk_-123_2'], id: 'vk_-123_3', url: 'https://example.com/3.png' };
  assert.equal((await run(['vk_-123_3'])).downloaded, 1);
  assert.ok(await cacheValid(root, library.photos['vk_-123_3']));
});
test('partial VK access retains photos and reports warnings', async t => {
  const root = await fixture(t), s = status(), library = { photos: {} };
  await syncLibrary({ root, settings: defaults, library, exclusions: [], status: s, call: async method => {
    if (method === 'utils.resolveScreenName') return { type: 'group', object_id: 123 };
    if (method === 'photos.getAll') throw new Error('No album access');
    return { count: 1, items: [{ attachments: [{ type: 'photo', photo: photo(3) }] }] };
  }, download: async () => png });
  assert.equal(s.downloaded, 1); assert.match(s.warnings[0], /No album access/);
});

test('VK sources retain post links through deduplication, reposts and album-only sync', async t => {
  const root = await fixture(t), library = { photos: {} };
  const call = async method => {
    if (method === 'utils.resolveScreenName') return { type: 'group', object_id: 123 };
    if (method === 'photos.getAll') return { count: 2, items: [photo(1), photo(2)] };
    return { count: 2, items: [
      { owner_id: -123, id: 10, attachments: [{ type: 'photo', photo: photo(1) }], copy_history: [
        { owner_id: -456, id: 20, attachments: [{ type: 'photo', photo: photo(3) }] },
      ] },
      { owner_id: -123, id: 9, attachments: [{ type: 'photo', photo: photo(1) }] },
    ] };
  };
  const run = async settings => syncLibrary({ root, settings, library, exclusions: [], status: status(), call, download: async () => png });
  await run(defaults);
  assert.equal(Object.keys(library.photos).length, 3);
  assert.equal(library.photos['vk_-123_1'].postPage, 'https://vk.ru/wall-123_10');
  assert.equal(library.photos['vk_-123_3'].postPage, 'https://vk.ru/wall-456_20');
  assert.equal(library.photos['vk_-123_2'].page, 'https://vk.ru/photo-123_2');
  assert.equal(library.photos['vk_-123_2'].postPage, undefined);
  await run({ ...defaults, source: 'albums' });
  const saved = JSON.parse(await readFile(join(root, 'cache/library.json'), 'utf8'));
  assert.equal(saved.photos['vk_-123_1'].postPage, 'https://vk.ru/wall-123_10');
  assert.equal(photoSource(saved.photos['vk_-123_1']).href, 'https://vk.ru/wall-123_10');
});

test('library links open VK posts, old VK photos and available local originals', () => {
  assert.equal(photoSource({ id: 'vk_-123_1', postPage: 'https://vk.ru/wall-123_10' }).href, 'https://vk.ru/wall-123_10');
  assert.equal(photoSource({ id: 'vk_-123_1', available: false }).href, 'https://vk.ru/photo-123_1');
  assert.equal(photoSource({ id: 'vk_123_1', postPage: 'javascript:alert(1)' }).href, 'https://vk.ru/photo123_1');
  const id = `local_${'a'.repeat(64)}`;
  assert.equal(photoSource({ id, available: true }).href, `/images/${id}`);
  assert.equal(photoSource({ id, available: false }), null);
});
test('VK token is sent in POST body, API errors do not leak it', async () => {
  const call = createVK('secret-fixture', { delay: 0, fetcher: async (url, options) => {
    assert.equal(url, 'https://api.vk.ru/method/photos.getAll');
    assert.ok(!url.includes('secret')); assert.equal(options.body.get('access_token'), 'secret-fixture');
    return { ok: true, json: async () => ({ error: { error_code: 5, error_msg: 'secret-fixture' } }) };
  } });
  await assert.rejects(call('photos.getAll', {}), e => e.message.includes('ошибка 5') && !e.message.includes('secret'));
});
test('HTTP import, persistence, missing-file detection and local-only protection', async t => {
  const root = await fixture(t);
  const checks = [];
  const vkFactory = candidate => async (method, params) => {
    checks.push({ candidate, method, params });
    if (candidate !== 'test-secret') throw new Error('VK: ошибка 5. Test authorization denied');
    return { type: 'group', object_id: 123 };
  };
  const openedFolders = [], folderOpener = async directory => openedFolders.push(directory);
  let server = await createApp(root, { vkFactory, folderOpener });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  let base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, value, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) });
  assert.equal((await fetch(base)).status, 200);
  assert.equal((await fetch(base + '/library.js')).status, 200);
  assert.equal((await fetch(base + '/render.js')).status, 200);
  for (const route of ['/settings.js', '/history.js', '/coverage.js', '/viewer.js', '/favicon.svg']) assert.equal((await fetch(base + route)).status, 200);
  assert.match((await fetch(base + '/favicon.svg')).headers.get('content-type'), /image\/svg\+xml/);
  assert.equal((await post('/api/images/open-folder', {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal(openedFolders.length, 0);
  assert.deepEqual(await (await post('/api/images/open-folder', { path: 'C:/unrelated' })).json(), { opened: true });
  assert.deepEqual(openedFolders, [join(root, 'cache/images')]);
  assert.equal((await post('/api/settings', defaults, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(base + '/.env')).status, 404);
  assert.equal((await post('/api/import', { name: 'x.svg', data: Buffer.from('<svg></svg>').toString('base64') })).status, 400);
  const { id } = await (await post('/api/import', { name: 'test.png', data: png.toString('base64') })).json();
  assert.match(id, /^local_/); assert.equal((await fetch(base + '/images/' + id)).headers.get('content-type'), 'image/png');
  const coverSizes = [...defaults.coverSizes, { width: 1600, height: 600 }];
  const savedSettings = await (await post('/api/settings', { ...defaults, rotation: 50, seed: 42, scatter: 100, width: 1600, height: 600, coverSizes })).json();
  assert.equal('seed' in savedSettings, false);
  const savedFile = JSON.parse(await readFile(join(root, 'config/settings.json'), 'utf8'));
  assert.equal('seed' in savedFile, false);
  assert.equal('scatter' in savedSettings, false); assert.equal('scatter' in savedFile, false);
  assert.equal(savedFile.width, 1600); assert.equal(savedFile.height, 600);
  assert.deepEqual(savedFile.coverSizes, coverSizes);
  assert.equal((await post('/api/layout', { items: [{ id, x: 120, y: 80, width: 200, angle: -25 }] })).status, 404);
  await assert.rejects(readFile(join(root, 'config/layout.json')), { code: 'ENOENT' });
  await post('/api/exclusions', [id]);
  assert.equal((await post('/api/token', { token: 'invalid-fixture' })).status, 400);
  assert.equal((await (await fetch(base + '/api/state')).json()).hasToken, Boolean(process.env.VK_TOKEN));
  assert.equal((await (await post('/api/token', { token: ' test-secret ' })).json()).verified, true);
  assert.equal(checks.at(-1).candidate, 'test-secret');
  assert.equal(checks.at(-1).method, 'utils.resolveScreenName');
  assert.equal(checks.at(-1).params.screen_name, defaults.community);
  let state = await (await fetch(base + '/api/state')).json();
  assert.equal(state.hasToken, true); assert.ok(!JSON.stringify(state).includes('test-secret')); assert.equal(state.photos[0].available, true);
  assert.equal(JSON.parse(await readFile(join(root, 'config/exclusions.json'), 'utf8'))[0], id);
  assert.equal('layout' in state, false);
  // Old layout files must not affect startup or be returned to the browser.
  await writeFile(join(root, 'config/layout.json'), 'obsolete layout');
  server.close(); await once(server, 'close'); server = await createApp(root, { vkFactory });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`;
  state = await (await fetch(base + '/api/state')).json();
  assert.equal(state.settings.rotation, 50); assert.equal('seed' in state.settings, false); assert.equal('layout' in state, false); assert.deepEqual(state.exclusions, [id]);
  assert.equal(state.settings.width, 1600); assert.equal(state.settings.height, 600);
  assert.deepEqual(state.settings.coverSizes, coverSizes);
  const invalidSize = await post('/api/settings', { ...state.settings, coverSizes: [{ width: 8192, height: 8192 }] });
  assert.equal(invalidSize.status, 400);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'config/settings.json'), 'utf8')).coverSizes, coverSizes);
  await writeFile(join(root, 'cache/images/keep.txt'), 'unrelated file');
  assert.equal((await post('/api/cache/clear', {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await (await post('/api/cache/clear', {})).json()).removed, 1);
  assert.equal((await (await post('/api/cache/clear', {})).json()).removed, 0);
  state = await (await fetch(base + '/api/state')).json();
  assert.equal(state.photos[0].available, false); assert.equal(state.photos.length, 1);
  assert.equal(state.settings.rotation, 50); assert.deepEqual(state.exclusions, [id]);
  assert.equal(await readFile(join(root, 'cache/images/keep.txt'), 'utf8'), 'unrelated file');
});
