import test from 'node:test';
import assert from 'node:assert/strict';
import { generate, hitTest, random } from '../public/collage.js';

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
