import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistory, historyShortcut } from '../public/history.js';

test('undoing to an empty canvas retains the photos needed for immediate redo', () => {
  const history = createHistory(3), frames = [{ id: 'a', instanceId: 'a-1' }, { id: 'a', instanceId: 'a-2' }, { id: 'b', instanceId: 'b-1' }];
  history.checkpoint([]);
  assert.deepEqual(history.undo(frames), []);
  assert.deepEqual([...history.nearbyPhotoIds()].sort(), ['a', 'b']);
  assert.deepEqual(history.redo([]), frames);
  history.checkpoint(frames);
  assert.deepEqual([...history.nearbyPhotoIds()].sort(), ['a', 'b']);
  history.clear(); assert.equal(history.nearbyPhotoIds().size, 0);
  history.checkpoint([{ id: 'old' }]); history.checkpoint([{ id: 'recent' }]);
  assert.deepEqual([...history.nearbyPhotoIds()], ['recent']);
});

test('undo shortcuts work with Russian layouts and both redo combinations', () => {
  assert.equal(historyShortcut({ ctrlKey: true, code: 'KeyZ', key: 'я' }), 'undo');
  assert.equal(historyShortcut({ ctrlKey: true, shiftKey: true, code: 'KeyZ', key: 'Я' }), 'redo');
  assert.equal(historyShortcut({ ctrlKey: true, code: 'KeyY', key: 'н' }), 'redo');
  assert.equal(historyShortcut({ metaKey: true, code: 'KeyZ' }), 'undo');
  assert.equal(historyShortcut({ ctrlKey: true, key: 'z' }), 'undo');
  assert.equal(historyShortcut({ code: 'KeyZ' }), null);
  assert.equal(historyShortcut({ ctrlKey: true, altKey: true, code: 'KeyZ' }), null);
  assert.equal(historyShortcut({ ctrlKey: true, isComposing: true, code: 'KeyZ' }), null);
});

test('layout order defaults to random and accepts only known priorities', () => {
  assert.equal(validateSettings({}).layoutOrder, 'random');
  for (const value of ['random', 'newest', 'oldest']) assert.equal(validateSettings({ layoutOrder: value }).layoutOrder, value);
  assert.throws(() => validateSettings({ layoutOrder: 'unsupported' }), /порядок кадров/);
});
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

test('copies of one photo keep independent transforms and survive clearing, undo and redo', () => {
  const history = createHistory();
  const images = new Map([['photo', { width: 100, height: 100 }]]);
  const settings = { width: 200, height: 100, border: 0 };
  const frames = [
    { id: 'photo', instanceId: 'copy-1', x: 50, y: 50, width: 100, angle: 0 },
    { id: 'photo', instanceId: 'copy-2', x: 150, y: 50, width: 100, angle: 0 },
  ];
  assert.equal(emptySpacePercent(frames, images, settings), 0);
  history.checkpoint(frames);
  frames.find(item => item.instanceId === 'copy-2').angle = 35;
  assert.equal(frames[0].angle, 0);
  assert.equal(frames[1].angle, 35);
  history.checkpoint(frames);
  const restored = history.undo([]);
  assert.deepEqual(restored, frames);
  assert.deepEqual(history.redo(restored), []);
  const afterClearUndo = history.undo([]);
  assert.deepEqual(history.undo(afterClearUndo).map(frame => frame.angle), [0, 0]);
  assert.equal(emptySpacePercent([], images, settings), 100);
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
