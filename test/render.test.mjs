import test from 'node:test';
import assert from 'node:assert/strict';
import { previewDimensions, renderDimensions, fitCanvasSize } from '../public/render.js';

test('canvas previews fit both viewport axes without changing aspect ratio or export size', () => {
  assert.deepEqual(fitCanvasSize(900, 500, 3000, 3000), { width: 500, height: 500 });
  assert.deepEqual(fitCanvasSize(900, 500, 3000, 6000), { width: 250, height: 500 });
  assert.deepEqual(fitCanvasSize(900, 500, 6000, 1000), { width: 900, height: 150 });
  for (const [w, h] of [[3000, 3000], [1920, 768], [100, 8192], [8192, 100]]) {
    for (const [availableWidth, availableHeight] of [[900, 500], [1200, 500], [280, 300], [700, 200]]) {
      const fitted = fitCanvasSize(availableWidth, availableHeight, w, h);
      assert.ok(fitted.width <= availableWidth + 1e-8 && fitted.height <= availableHeight + 1e-8);
      assert.ok(Math.abs(fitted.width / fitted.height - w / h) < 1e-8);
    }
  }
});

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
