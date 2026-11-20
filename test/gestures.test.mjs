import test from 'node:test';
import assert from 'node:assert/strict';
import { touchPair, gestureFrame, swipeDirection } from '../public/gestures.js';
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);

test('two-finger edits keep the touched photo anchored while scaling, rotating and translating', () => {
  const from = touchPair([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
  const to = touchPair([{ x: 200, y: 100 }, { x: 200, y: 300 }]);
  const result = gestureFrame({ x: 75, y: 25, width: 100, angle: 15 }, from, to);
  near(result.width, 200); near(result.angle, 105); near(result.x, 150); near(result.y, 250);
  const unchanged = gestureFrame(result, to, to); for (const key of ['x','y','width','angle']) near(unchanged[key], result[key]);
});

test('pinch limits stay finite for overlapping fingers and rotation crosses the angle boundary smoothly', () => {
  assert.equal(touchPair([{ x: 0, y: 0 }]), null);
  const from = touchPair([{ x: 0, y: 0 }, { x: 0, y: 0 }]);
  const to = touchPair([{ x: 0, y: 0 }, { x: 1e9, y: 1e9 }]);
  const result = gestureFrame({ x: 0, y: 0, width: 100, angle: 0 }, from, to);
  assert.equal(result.width, 10000); assert.ok(Object.values(result).every(Number.isFinite));
  const rotate = gestureFrame({ x: 0, y: 0, width: 100, angle: 0 }, {x:0,y:0,distance:100,angle:179*Math.PI/180}, {x:0,y:0,distance:100,angle:-179*Math.PI/180});
  near(rotate.angle, 2);
});

test('swipes navigate only for deliberate horizontal movement, ignoring scrolls, taps and slow drags', () => {
  const start = {x:100,y:100,time:1000};
  assert.equal(swipeDirection(start, {x:20,y:110,time:1300}), 1);
  assert.equal(swipeDirection(start, {x:180,y:100,time:1300}), -1);
  for (const end of [{x:90,y:100,time:1100}, {x:20,y:180,time:1300}, {x:0,y:100,time:2000}]) assert.equal(swipeDirection(start,end), 0);
});
