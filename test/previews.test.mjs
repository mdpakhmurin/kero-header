import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePreview, previewCacheKey, createPreviewCache } from '../public/previews.js';

test('large photos with known dimensions are decoded straight to the preview size', async () => {
  const calls = [], image = { width: 1200, height: 600 };
  const decoded = await decodePreview('original', { width: 4800, height: 2400 }, async (...args) => { calls.push(args); return image; });
  assert.deepEqual(calls, [['original', { resizeWidth: 1200, resizeHeight: 600, resizeQuality: 'high' }]]);
  assert.deepEqual(decoded, { image, width: 4800, height: 2400 });
});

test('unknown local image dimensions are discovered and the full-sized bitmap is released', async () => {
  let closed = 0;
  const original = { width: 2000, height: 4000, close() { closed++; } }, resized = { width: 600, height: 1200 };
  const decoded = await decodePreview('blob', {}, async source => source === 'blob' ? original : resized);
  assert.deepEqual(decoded, { image: resized, width: 2000, height: 4000 });
  assert.equal(closed, 1);
  await assert.rejects(decodePreview('blob', {}, async source => { if (source === 'blob') return original; throw Error('decode failed'); }));
  assert.equal(closed, 2);
});

test('preview versions invalidate changed files and cached previews preserve original dimensions', async () => {
  const photo = { id: 'vk_-1_1', version: 'a'.repeat(64), available: true }, key = previewCacheKey(photo);
  assert.notEqual(key, previewCacheKey({ ...photo, version: 'b'.repeat(64) }));
  assert.equal(previewCacheKey({ id: photo.id }), null);
  const entries = new Map([[key, new Response('preview', { headers: { 'X-Original-Width': '2400', 'X-Original-Height': '4800', 'X-Preview-Bytes': '7' } })]]);
  const cache = { match: async key => entries.get(typeof key === 'string' ? key : new URL(key.url).pathname + new URL(key.url).search)?.clone(), delete: async key => entries.delete(typeof key === 'string' ? key : new URL(key.url).pathname + new URL(key.url).search), keys: async () => [...entries.keys()].map(key => ({ url: `http://localhost${key}` })) };
  const previews = createPreviewCache({ storage: { open: async () => cache } });
  const image = { width: 600, height: 1200 };
  assert.deepEqual(await previews.read(photo, async blob => { assert.equal(await blob.text(), 'preview'); return image; }), { image, width: 2400, height: 4800 });
  assert.equal(await previews.read({ ...photo, version: 'b'.repeat(64) }), null);
  await previews.prune([{ ...photo, available: false }]);
  assert.equal(entries.size, 0);
});

test('blocked storage or a damaged cached preview falls back to loading the original', async () => {
  const photo = { id: 'vk_-1_1', version: 'a'.repeat(64) };
  assert.equal(await createPreviewCache({ storage: { open: async () => { throw Error('blocked'); } } }).read(photo), null);
  let deleted = false;
  const previews = createPreviewCache({ storage: { open: async () => ({ match: async () => new Response('bad'), delete: async () => { deleted = true; } }) } });
  assert.equal(await previews.read(photo), null);
  assert.equal(deleted, true);
});

test('preview cleanup removes old file versions and keeps the cache within its byte budget', async () => {
  const photos = Array.from({ length: 3 }, (_, i) => ({ id: `vk_-1_${i}`, version: 'a'.repeat(64), available: true }));
  const entries = new Map(photos.map(photo => [previewCacheKey(photo), new Response('preview', { headers: { 'X-Preview-Bytes': String(70 * 1024 * 1024) } })]));
  const relative = key => typeof key === 'string' ? key : new URL(key.url).pathname + new URL(key.url).search;
  const cache = { keys: async () => [...entries.keys()].map(key => ({ url: `http://localhost${key}` })), match: async key => entries.get(relative(key)), delete: async key => entries.delete(relative(key)) };
  const previews = createPreviewCache({ storage: { open: async () => cache } });
  await previews.prune(photos);
  assert.deepEqual([...entries.keys()], [previewCacheKey(photos[2])]);
  await previews.prune([{ ...photos[2], version: 'b'.repeat(64) }]);
  assert.equal(entries.size, 0);
});
