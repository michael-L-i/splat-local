import test from 'node:test';
import assert from 'node:assert/strict';
import { sharpness, presets, thumbnail, motion, selectFrames } from '../src/quality.js';

test('sharpness distinguishes sharp and soft edges, with finite uniform scores', () => {
  const image = smooth => {
    const width = 64, height = 48, data = new Uint8ClampedArray(width*height*4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const value = smooth ? 128 + 80*Math.sin(x/4) : (Math.floor(x/12)%2)*255;
      data.set([value, value, value, 255], (y*width+x)*4);
    }
    return { width, height, data };
  };
  assert.ok(sharpness(image(false)) > sharpness(image(true))*10);
  assert.equal(sharpness({ width: 8, height: 8, data: new Uint8ClampedArray(256).fill(255) }), 0);
  assert.equal(sharpness({ width: 1, height: 1, data: new Uint8ClampedArray(4) }), 0);
});

test('quality presets have increasing detail and explicit resource caps', () => {
  assert.ok(presets.fast.resolution < presets.balanced.resolution);
  assert.ok(presets.balanced.frames < presets.detailed.frames);
  for (const preset of Object.values(presets)) {
    assert.ok(preset.maxSplats <= 300000 && preset.resolution <= 1024 && preset.steps <= 10000);
  }
});

test('frame selection rejects blur, follows camera movement and keeps order', () => {
  // 60 candidates: the camera pauses for the middle third; every fifth frame is blurred.
  const candidates = Array.from({ length: 60 }, (_, i) => ({
    sharpness: i % 5 === 2 ? 20 : 100 + (i % 3), move: i >= 20 && i < 40 ? 0.05 : 4,
  }));
  const picked = selectFrames(candidates, 20);
  assert.equal(picked.length, 20);
  assert.equal(new Set(picked).size, 20);
  assert.deepEqual(picked, [...picked].sort((a, b) => a - b));
  assert.ok(picked.every(i => i % 5 !== 2), 'blurred frames are skipped when alternatives exist');
  const paused = picked.filter(i => i >= 20 && i < 40).length;
  assert.ok(paused >= 1 && paused <= 4, `paused stretch keeps a few views, got ${paused}`);
});

test('frame selection degrades gracefully', () => {
  const still = Array.from({ length: 12 }, () => ({ sharpness: 5, move: 0 }));
  assert.deepEqual(selectFrames(still, 4).length, 4);
  assert.deepEqual(selectFrames(still.slice(0, 3), 4), [0, 1, 2]);
  // One abrupt jump leaves slots empty; they are filled with the nearest remaining frames.
  const jump = Array.from({ length: 12 }, (_, i) => ({ sharpness: 50, move: i === 6 ? 100 : 0.01 }));
  const picked = selectFrames(jump, 8);
  assert.equal(new Set(picked).size, 8);
  assert.deepEqual(picked, [...picked].sort((a, b) => a - b));
});

test('thumbnails ignore exposure and respond to image shifts', () => {
  const image = (shift, gain) => {
    const width = 96, height = 54, data = new Uint8ClampedArray(width*height*4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const value = 100 + 60*Math.sin((x + shift)/9) + gain;
      data.set([value, value, value, 255], (y*width+x)*4);
    }
    return { width, height, data };
  };
  const base = thumbnail(image(0, 0));
  assert.ok(motion(base, thumbnail(image(0, 25))) < 0.5);
  assert.ok(motion(base, thumbnail(image(12, 0))) > motion(base, thumbnail(image(3, 0))) * 2);
});
