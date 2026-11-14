import test from 'node:test';
import assert from 'node:assert/strict';
import { selectionGeometry, selectionHit, resizeSelection, rotateSelection, floatingPanelPosition, manualFrames } from '../public/collage.js';
import { createHistory } from '../public/history.js';
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('bulk add creates independent copies, preserves existing frames and undoes as one action', () => {
  const existing = [{ id: 'same', instanceId: 'old', x: 20, y: 20, width: 30, angle: 15 }];
  const before = structuredClone(existing), history = createHistory(); let sequence = 0;
  const frames = manualFrames([{ id: 'same' }, { id: 'another' }, { id: 'same' }], { width: 100, height: 100, photoSize: 45 }, existing, () => `new-${++sequence}`);
  assert.deepEqual(existing, before);
  assert.equal(new Set(frames.map(item => item.instanceId)).size, 3);
  assert.deepEqual(frames.map(item => item.id), ['same', 'another', 'same']);
  assert.ok(frames.every(item => item.x >= 10 && item.x <= 90 && item.y >= 10 && item.y <= 90 && item.width === 45));
  history.checkpoint(existing); const after = [...existing, ...frames];
  assert.deepEqual(history.undo(after), before);
  assert.deepEqual(history.redo(before), after);
});

test('resize preserves the opposite corner and aspect ratio at every rotation', () => {
  for (const angle of [0, 37, 90, -150]) for (const ratio of [.5, 1, 2]) {
    const start = { x: 300, y: 200, width: 120, angle }, border = 7;
    const before = selectionGeometry(start, ratio, border);
    for (const handle of before.corners) {
      const anchor = before.corners.find(c => c.sx === -handle.sx && c.sy === -handle.sy);
      const resized = { ...start, ...resizeSelection(start, handle, { x: handle.x + handle.sx * 40, y: handle.y + handle.sy * 50 }, ratio, border) };
      const after = selectionGeometry(resized, ratio, border).corners.find(c => c.sx === -handle.sx && c.sy === -handle.sy);
      near(after.x, anchor.x); near(after.y, anchor.y);
      assert.ok(resized.width >= 10 && resized.width <= 10000);
      near(resizeSelection(start, handle, handle, ratio, border).width, start.width);
    }
  }
});

test('selection grips keep the same target size at different preview scales', () => {
  const item = { x: 300, y: 200, width: 120, angle: 37 };
  for (const scale of [.2, 1, 2]) {
    const geometry = selectionGeometry(item, 1, 5, scale);
    near(Math.hypot(geometry.rotate.x - geometry.top.x, geometry.rotate.y - geometry.top.y) * scale, 26);
    assert.equal(selectionHit(geometry, geometry.corners[0], scale).type, 'resize');
    assert.equal(selectionHit(geometry, geometry.rotate, scale).type, 'rotate');
    assert.equal(selectionHit(geometry, { x: item.x, y: item.y }, scale), null);
  }
});

test('rotation handles wrap angles and support 15 degree snapping', () => {
  const item = { x: 0, y: 0, width: 100, angle: 170 };
  near(rotateSelection(item, { x: 0, y: 10 }, 0), -100);
  near(rotateSelection({ ...item, angle: 0 }, { x: 10, y: 2 }, 0, true), 15);
});

test('floating toolbar stays inside the workspace at all canvas edges', () => {
  const area = { width: 600, height: 300 }, panel = { width: 380, height: 56 };
  for (const bounds of [{ left: -50, right: 60, top: -40, bottom: 30 }, { left: 570, right: 800, top: 280, bottom: 400 }]) {
    const position = floatingPanelPosition(bounds, panel, area);
    assert.ok(position.x >= 10 && position.x + panel.width <= area.width - 10);
    assert.ok(position.y >= 10 && position.y + panel.height <= area.height - 10);
  }
  assert.equal(floatingPanelPosition({ left: 100, right: 300, top: 150, bottom: 200 }, panel, area).y, 82);
});
