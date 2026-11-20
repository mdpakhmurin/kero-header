import test from 'node:test';
import assert from 'node:assert/strict';
import { generate, generateAsync, shuffleSources, hitTest, random } from '../public/collage.js';

test('shuffling an empty canvas uses the library; a filled canvas preserves only its frames and copies', () => {
  const photos = [{ id: 'a', width: 200, height: 100 }, { id: 'b', width: 100, height: 200 }, { id: 'unused', width: 100, height: 100 }];
  assert.deepEqual(shuffleSources(photos, []), photos);
  const frames = [{ id: 'a', instanceId: 'a1' }, { id: 'b', instanceId: 'b1' }, { id: 'a', instanceId: 'a2' }];
  const input = shuffleSources(photos, frames);
  assert.deepEqual(input.map(item => item.id), ['a', 'b', 'a']);
  const result = generate(input, { width: 600, height: 400, photoSize: 200, sizeDeviation: 30, rotation: 15 }, 42);
  assert.equal(result.length, 3);
  assert.deepEqual(result.map(item => item.instanceId).sort(), ['a1', 'a2', 'b1']);
  assert.equal(result.filter(item => item.id === 'a').length, 2);
  assert.equal(result.some(item => item.id === 'unused'), false);
});

test('date layout priorities compare VK dates with local import dates and keep unknown dates behind', () => {
  const photos = [
    { id: 'old', source: 'vk', date: 1000, width: 100, height: 100 },
    { id: 'local_a', source: 'local', addedAt: 2000000, width: 100, height: 100 },
    { id: 'new', source: 'vk', date: 3000, width: 100, height: 100 },
    { id: 'unknown', source: 'vk', width: 100, height: 100 },
  ];
  const settings = { width: 100, height: 100, photoSize: 100, sizeDeviation: 0, rotation: 0 };
  const newest = generate(photos, { ...settings, layoutOrder: 'newest' }, 42);
  const oldest = generate(photos, { ...settings, layoutOrder: 'oldest' }, 42);
  assert.deepEqual(newest.map(item => item.id), ['unknown', 'old', 'local_a', 'new']);
  assert.deepEqual(oldest.map(item => item.id), ['unknown', 'new', 'local_a', 'old']);
  assert.equal(generate(photos, { ...settings, count: 1, layoutOrder: 'newest' }, 42)[0].id, 'new');
  assert.equal(generate(photos, { ...settings, count: 1, layoutOrder: 'oldest' }, 42)[0].id, 'old');
  assert.equal(photos[0].id, 'old');
});

test('asynchronous generation yields to the UI and reports actual frame progress', async () => {
  const settings = { width: 800, height: 400, photoSize: 200, sizeDeviation: 30, rotation: 20, border: 4 };
  const photos = Array.from({ length: 12 }, (_, i) => ({ id: `frame-${i}`, width: 300, height: 200 + i * 10 }));
  const progress = []; let yielded = false;
  const timer = new Promise(resolve => setTimeout(() => { yielded = true; resolve(); }, 0));
  const actual = await generateAsync(photos, settings, (done, total) => progress.push({ done, total }), 42);
  assert.equal(yielded, true);
  await timer;
  assert.deepEqual(actual, generate(photos, settings, 42));
  assert.deepEqual(progress, Array.from({ length: 13 }, (_, done) => ({ done, total: 12 })));
  assert.deepEqual(await generateAsync([], settings), []);
});

function coveredFraction(items, photos, settings) {
  const ratios = new Map(photos.map(photo => [photo.id, photo.height / photo.width]));
  let covered = 0;
  // Check actual rotated rectangles on a separate grid, including all four edges.
  for (let row = 0; row <= 60; row++) {
    for (let col = 0; col <= 120; col++) {
      if (items.some(item => hitTest(item, ratios.get(item.id), col * settings.width / 120, row * settings.height / 60, settings.border))) covered++;
    }
  }
  return covered / (121 * 61);
}

test('equal unrotated frames cover the entire canvas, including corners', () => {
  const settings = { width: 800, height: 400, minSize: 200, maxSize: 200, rotation: 0, border: 0 };
  const photos = Array.from({ length: 8 }, (_, index) => ({ id: `photo-${index}`, width: 200, height: 200 }));
  for (const seed of [1, 42, 999]) {
    const items = generate(photos, settings, seed);
    assert.equal(coveredFraction(items, photos, settings), 1);
    assert.equal(new Set(items.map(item => item.id)).size, 8);
  }
});

test('placement accounts for portrait aspect ratios', () => {
  const settings = { width: 200, height: 400, minSize: 200, maxSize: 200, rotation: 0, border: 0 };
  const photos = [{ id: 'portrait', width: 100, height: 200 }];
  const items = generate(photos, settings, 42);
  assert.equal(coveredFraction(items, photos, settings), 1);
  assert.equal(items[0].width, 200);
});

test('mixed rotated photos target empty space while keeping sizes and IDs', () => {
  const settings = { width: 1200, height: 600, minSize: 170, maxSize: 260, rotation: 35, border: 7 };
  const photos = Array.from({ length: 30 }, (_, index) => ({ id: `photo-${index}`, width: 100, height: [50, 100, 150, 200][index % 4] }));
  const items = generate(photos, settings, 42);
  assert.ok(coveredFraction(items, photos, settings) > .98);
  assert.equal(new Set(items.map(item => item.id)).size, photos.length);
  assert.ok(items.every(item => item.width >= settings.minSize && item.width <= settings.maxSize && Math.abs(item.angle) <= settings.rotation));
});

test('scarce photos spread their usable area without increasing their size', () => {
  const settings = { width: 1920, height: 768, minSize: 180, maxSize: 440, rotation: 24, border: 7 };
  const photos = Array.from({ length: 12 }, (_, index) => ({ id: `photo-${index}`, width: 100, height: index % 2 ? 125 : 75 }));
  const items = generate(photos, settings, 42);
  const r = random(42), randomPositions = items.map(item => ({ ...item, x: r() * settings.width, y: r() * settings.height }));
  assert.ok(coveredFraction(items, photos, settings) > coveredFraction(randomPositions, photos, settings) + .1);
  assert.ok(items.every(item => item.width <= settings.maxSize));
});

test('name and date direction choose priority photos consistently without changing coverage rules', () => {
  const photos = [{ id: 'one', title: 'Кадр 10', width: 100, height: 100, date: 100 }, { id: 'two', title: 'Кадр 2', width: 100, height: 100, date: 200 }];
  const settings = { width: 500, height: 300, photoSize: 200, sizeDeviation: 0, rotation: 0, border: 0 };
  assert.deepEqual(generate(photos, { ...settings, layoutOrder: 'name', layoutDirection: 'asc' }, 1).map(frame => frame.id), ['one', 'two']);
  assert.deepEqual(generate(photos, { ...settings, layoutOrder: 'name', layoutDirection: 'desc' }, 1).map(frame => frame.id), ['two', 'one']);
  assert.deepEqual(generate(photos, { ...settings, layoutOrder: 'date', layoutDirection: 'asc' }, 1).map(frame => frame.id), ['two', 'one']);
  assert.deepEqual(generate(photos, { ...settings, layoutOrder: 'date', layoutDirection: 'desc' }, 1).map(frame => frame.id), ['one', 'two']);
});
