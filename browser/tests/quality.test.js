import test from 'node:test';
import assert from 'node:assert/strict';
import { frameCount, sharpness, presets } from '../src/quality.js';

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

test('automatic frame counts grow with clip length within bounds', () => {
  assert.equal(frameCount('auto', 10, presets.balanced), 32);
  assert.equal(frameCount('auto', 59, presets.balanced), 89);
  assert.equal(frameCount('auto', 120, presets.detailed), 96);
  assert.equal(frameCount('24', 120, presets.detailed), 24);
});

test('quality presets have increasing detail and explicit resource caps', () => {
  assert.ok(presets.fast.resolution < presets.balanced.resolution);
  assert.ok(presets.balanced.frames < presets.detailed.frames);
  for (const preset of Object.values(presets)) {
    assert.ok(preset.maxSplats <= 300000 && preset.resolution <= 1024 && preset.steps <= 10000);
  }
});
