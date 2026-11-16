import test from 'node:test';
import assert from 'node:assert/strict';
import { previewDimensions, renderDimensions, fitCanvasSize, createFrameScheduler, createTransformLayers } from '../public/render.js';

test('mouse events share one animation frame and work queued during rendering gets another frame', () => {
  const pending = new Map(); let handle = 0, renders = 0;
  const scheduler = createFrameScheduler(() => { renders++; if (renders === 1) scheduler.schedule(); }, callback => { pending.set(++handle, callback); return handle; }, id => pending.delete(id));
  for (let i = 0; i < 100; i++) scheduler.schedule();
  assert.equal(pending.size, 1);
  const first = pending.get(1); pending.delete(1); first();
  assert.equal(renders, 1); assert.equal(pending.size, 1);
  scheduler.cancel(); assert.equal(pending.size, 0);
  scheduler.schedule(); const next = pending.get(3); pending.delete(3); next();
  assert.equal(renders, 2);
});

function layerFixture() {
  const calls = [], surfaces = [];
  const context = label => ({ setTransform() {}, clearRect() {}, fillRect() {}, save() {}, restore() {}, drawImage(surface) { calls.push(`${label}:composite:${surface.label}`); } });
  const layers = createTransformLayers(() => {
    const label = `layer${surfaces.length}`, ctx = context(label), surface = { label, width: 0, height: 0, getContext: () => ctx };
    ctx.label = label; surfaces.push(surface); return surface;
  });
  const main = context('main'); main.label = 'main';
  return { calls, surfaces, layers, main, drawPhoto: (ctx, frame) => calls.push(`${ctx.label}:photo:${frame.instanceId}`) };
}

test('transform layers preserve stacking and distinguish repeated copies of the same photograph', () => {
  const f = layerFixture(), frames = ['back', 'selected', 'front'].map(instanceId => ({ id: 'same-photo', instanceId }));
  const input = { context: f.main, frames, images: new Map([['same-photo', {}]]), settings: { width: 1000, height: 400, background: '#fff' }, selected: 'selected', width: 1000, height: 400, revision: 1, drawPhoto: f.drawPhoto };
  assert.equal(f.layers.render(input), true);
  assert.deepEqual(f.calls, ['layer0:photo:back', 'layer1:photo:front', 'main:composite:layer0', 'main:photo:selected', 'main:composite:layer1']);
  f.calls.length = 0; frames[1].x = 200; frames[1].angle = 45; frames[1].width = 300;
  f.layers.render(input);
  assert.deepEqual(f.calls, ['main:composite:layer0', 'main:photo:selected', 'main:composite:layer1']);
  f.calls.length = 0; f.layers.render({ ...input, revision: 2 });
  assert.equal(f.calls.filter(call => call.includes(':photo:')).length, 3);
  f.calls.length = 0; f.layers.render({ ...input, revision: 2, width: 2000, height: 800 });
  assert.equal(f.calls.filter(call => call.includes(':photo:')).length, 3);
  f.layers.invalidate(); assert.ok(f.surfaces.every(surface => surface.width === 0 && surface.height === 0));
  assert.equal(f.layers.render({ ...input, selected: 'missing' }), false);
});

test('dragging one of 120 frames reuses the 119 static photo and shadow renders', () => {
  const f = layerFixture(), frames = Array.from({ length: 120 }, (_, i) => ({ id: 'photo', instanceId: String(i) }));
  const input = { context: f.main, frames, images: new Map([['photo', {}]]), settings: { width: 1000, height: 400, background: '#fff' }, selected: '60', width: 1000, height: 400, revision: 1, drawPhoto: f.drawPhoto };
  for (let frame = 0; frame < 60; frame++) { frames[60].x = frame; f.layers.render(input); }
  assert.equal(f.calls.filter(call => call.includes(':photo:')).length, 119 + 60);
});

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
