import test from 'node:test';
import assert from 'node:assert/strict';
import { imageViewport } from '../public/viewer.js';

test('viewer fits images and keeps panning within the visible photograph', () => {
  const photo = { width: 2000, height: 1000 }, viewport = { width: 1000, height: 500 };
  const fit = imageViewport(photo, viewport);
  assert.equal(fit.percent, 50); assert.equal(fit.canPan, false);
  const original = imageViewport(photo, viewport, 2, { x: 9999, y: -9999 });
  assert.equal(original.percent, 100); assert.equal(original.x, 500); assert.equal(original.y, -250);
  const panorama = imageViewport({ width: 1200, height: 300 }, { width: 600, height: 600 }, 2, { x: 9999, y: 9999 });
  assert.equal(panorama.x, 300); assert.equal(panorama.y, 0);
});

test('viewer can show a small original at 100% without forcing enlargement', () => {
  const view = imageViewport({ width: 400, height: 200 }, { width: 800, height: 600 }, .5);
  assert.equal(view.percent, 100); assert.equal(view.canPan, false);
  assert.equal(imageViewport({ width: 400, height: 200 }, { width: 800, height: 600 }, .01).zoom, .5);
});
