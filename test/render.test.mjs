import test from 'node:test';
import assert from 'node:assert/strict';
import { previewDimensions, renderDimensions } from '../public/render.js';

test('preview follows the screen pixel density independently of export dimensions', () => {
  assert.deepEqual(previewDimensions(800, 1920, 768, 1), { width: 800, height: 320 });
  assert.deepEqual(previewDimensions(800, 1920, 768, 2), { width: 1600, height: 640 });
  const large = previewDimensions(4000, 1920, 768, 3);
  assert.ok(large.width * large.height <= 4_010_000);
  assert.ok(Math.abs(large.width / large.height - 1920 / 768) < .01);
});

test('supersampling keeps large valid exports within the rendering budget', () => {
  assert.deepEqual(renderDimensions(1920, 768), { width: 3840, height: 1536 });
  assert.deepEqual(renderDimensions(8000, 4000), { width: 8000, height: 4000 });
  const middle = renderDimensions(4000, 2000);
  assert.ok(middle.width > 4000 && middle.width < 8000);
  assert.ok(middle.width * middle.height <= 16_010_000);
  assert.ok(Math.abs(middle.width / middle.height - 2) < .001);
});
