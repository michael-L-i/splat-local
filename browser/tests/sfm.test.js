import test from 'node:test';
import assert from 'node:assert/strict';
import { reconstruct } from '../src/sfm.js';

test('textureless video is rejected without inventing cameras', async () => {
  const frames = Array.from({ length: 4 }, () => ({ width: 128, height: 96, data: new Uint8ClampedArray(128*96*4).fill(255) }));
  await assert.rejects(reconstruct(frames, { width: 128, height: 96, f: null }), /No stable initial camera pair/);
});
