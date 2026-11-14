import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistory } from '../public/history.js';
import { emptySpacePercent } from '../public/coverage.js';
import { photoSizeRange } from '../public/settings.js';
import { validateSettings } from '../lib/storage.mjs';
import { generate } from '../public/collage.js';
import { mkdtemp, writeFile, rename, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveImage, cacheValid, readImage, migrateImageFiles } from '../lib/storage.mjs';

test('percentage deviation allows 0–300% and migrates pixel-based settings', () => {
  assert.deepEqual(photoSizeRange({ photoSize: 300, sizeDeviation: 50 }), { minSize: 150, maxSize: 450 });
  assert.deepEqual(photoSizeRange({ photoSize: 300, sizeDeviation: 0 }), { minSize: 300, maxSize: 300 });
  assert.deepEqual(photoSizeRange({ photoSize: 800, sizeDeviation: 300 }), { minSize: 20, maxSize: 3200 });
  const migrated = validateSettings({ minSize: 150, maxSize: 450 });
  assert.equal(migrated.photoSize, 300); assert.equal(migrated.sizeDeviation, 50);
  assert.equal('minSize' in migrated, false); assert.equal('maxSize' in migrated, false);
  const settings = validateSettings({ photoSize: 800, sizeDeviation: 300 });
  const layout = generate(Array.from({ length: 20 }, (_, index) => ({ id: String(index) })), settings, 42);
  assert.ok(layout.every(item => item.width >= 20 && item.width <= 3200));
  assert.ok(layout.some(item => item.width > 800));
});

test('empty percentage measures the union, clips canvas edges and ignores shadows', () => {
  const s = { width: 200, height: 100, border: 0, shadow: 100 };
  const images = new Map([['a', { width: 100, height: 100 }], ['b', { width: 100, height: 100 }]]);
  const left = { id: 'a', x: 50, y: 50, width: 100, angle: 0 };
  assert.equal(emptySpacePercent([], images, s), 100);
  assert.equal(emptySpacePercent([left], images, s), 50);
  assert.equal(emptySpacePercent([left, { ...left, id: 'b' }], images, s), 50);
  assert.equal(emptySpacePercent([left, { ...left, id: 'b', x: 150 }], images, s), 0);
  assert.equal(emptySpacePercent([{ ...left, x: 0 }], images, s), 75);
  assert.equal(emptySpacePercent([{ ...left, x: -1000 }], images, s), 100);
  assert.ok(emptySpacePercent([left], images, { ...s, border: 10 }) < 50);
  images.set('a', { width: 100, height: 200 });
  assert.equal(emptySpacePercent([{ ...left, x: 100, angle: 90 }], images, s), 0);
});

test('undo and redo restore snapshots; a new edit discards the redo branch', () => {
  const history = createHistory(2);
  const first = [{ id: 'a', x: 10 }], second = [{ id: 'a', x: 20 }], third = [{ id: 'a', x: 30 }];
  history.checkpoint(first); first[0].x = 999;
  history.checkpoint(second);
  assert.deepEqual(history.undo(third), second);
  assert.equal(history.canRedo, true);
  assert.deepEqual(history.redo(second), third);
  assert.deepEqual(history.undo(third), second);
  assert.deepEqual(history.undo(second), [{ id: 'a', x: 10 }]);
  assert.equal(history.canUndo, false);
  history.checkpoint(third);
  assert.equal(history.canRedo, false);
  history.checkpoint(second); history.checkpoint(third);
  history.undo([]); history.undo([]);
  assert.equal(history.undo([]), null);
  history.clear(); assert.equal(history.canRedo, false);
});

test('image cache uses normal extensions and migrates legacy files without replacing originals', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kero-image-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=', 'base64');
  const photo = { id: 'vk_-123_1', ...await saveImage(root, 'vk_-123_1', png) };
  const regular = join(root, 'cache/images/vk_-123_1.png'), legacy = join(root, 'cache/images/vk_-123_1.img');
  assert.deepEqual(await readFile(regular), png);
  await rename(regular, legacy);
  assert.deepEqual(await readImage(root, photo), png);
  await migrateImageFiles(root, { photos: { [photo.id]: photo } });
  assert.deepEqual(await readFile(regular), png);
  await assert.rejects(readFile(legacy), { code: 'ENOENT' });
  assert.equal(await cacheValid(root, photo), true);
  await writeFile(legacy, 'old duplicate');
  await migrateImageFiles(root, { photos: { [photo.id]: photo } });
  assert.deepEqual(await readFile(regular), png);
  assert.equal(await readFile(legacy, 'utf8'), 'old duplicate');
});
