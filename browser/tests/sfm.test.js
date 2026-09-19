import test from 'node:test';
import assert from 'node:assert/strict';
import { reconstruct } from '../src/sfm.js';

test('textureless video is rejected without inventing cameras', async () => {
  const frames = Array.from({ length: 4 }, () => ({ width: 128, height: 96, data: new Uint8ClampedArray(128*96*4).fill(255) }));
  await assert.rejects(reconstruct(frames, { width: 128, height: 96, f: null }), /No stable initial camera pair/);
});

import { cameraPoint } from '../src/geometry.js';

// A synthetic room: random textured patches at random depths, seen by a camera
// sliding sideways. The last frames are blank so they can never be placed.
function render(count, blank) {
  const width = 320, height = 240, f = 300;
  let seed = 3;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2**32);
  const patches = Array.from({ length: 400 }, () => ({
    xyz: [(random()-.5)*6, (random()-.5)*4, 4 + random()*4], size: 0.05 + random()*0.1,
    texture: Array.from({ length: 16 }, () => 40 + Math.floor(random()*200)),
  }));
  return Array.from({ length: count }, (_, i) => {
    const data = new Uint8ClampedArray(width*height*4).fill(255);
    if (i < count - blank) {
      const pose = { R: [1,0,0,0,1,0,0,0,1], t: [-i*0.12, 0, 0] };
      for (const p of patches) {
        const [x, y, z] = cameraPoint(pose, p.xyz);
        const cx = f*x/z + width/2, cy = f*y/z + height/2, r = f*p.size/z;
        for (let py = Math.max(0, Math.floor(cy - r)); py < Math.min(height, cy + r); py++)
        for (let px = Math.max(0, Math.floor(cx - r)); px < Math.min(width, cx + r); px++) {
          const u = Math.floor((px - (cx - r)) / (2*r) * 4), v = Math.floor((py - (cy - r)) / (2*r) * 4);
          const value = p.texture[Math.min(15, Math.max(0, v*4+u))];
          data.set([value, value, value, 255], (py*width+px)*4);
        }
      }
    }
    return { width, height, data };
  });
}

test('partial coverage is accepted with a note; blank views are skipped', async () => {
  const scene = await reconstruct(render(10, 3), { width: 320, height: 240, f: null });
  assert.equal(scene.report.registered, 7);
  assert.ok(scene.report.warnings.length === 1 && /7 of 10/.test(scene.report.warnings[0]));
  assert.ok(scene.report.medianError < 2);
});
