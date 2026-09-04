import test from 'node:test';
import assert from 'node:assert/strict';
import { refine } from '../src/refine.js';
import { cameraPoint, center } from '../src/geometry.js';

function fixture(outliers = false) {
  const camera = { width: 768, height: 432, f: 600 };
  let seed = 7;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2**32);
  const rotation = angle => [Math.cos(angle), 0, Math.sin(angle), 0, 1, 0, -Math.sin(angle), 0, Math.cos(angle)];
  const frames = Array.from({ length: 6 }, (_, index) => ({ index, pose: { R: rotation(index*0.03), t: [-index*0.3, Math.sin(index)*0.1, index*0.05] } }));
  const points = Array.from({ length: 70 }, () => ({ xyz: [(random()-.5)*4, (random()-.5)*2, 4+random()*3], rgb: [1,2,3] }));
  const tracks = points.map(({ xyz }, id) => frames.map(({ pose }, frame) => {
    const [x,y,z] = cameraPoint(pose, xyz);
    return { frame, xy: [600*x/z + 384 + (outliers && id%12 === 0 && frame === 3 ? 30 : 0), 600*y/z + 216] };
  }));
  frames.slice(1).forEach(frame => {
    frame.pose.t = frame.pose.t.map(v => v + (random()-.5)*0.035);
    frame.pose.R = rotation(frame.index*0.03 + (random()-.5)*0.01);
  });
  points.forEach(point => { point.xyz = point.xyz.map(v => v + (random()-.5)*0.08); });
  return { scene: { camera, frames, points }, tracks };
}

test('joint refinement reduces error without changing input, origin or scale', () => {
  const { scene, tracks } = fixture(), before = structuredClone(scene);
  const result = refine(scene, tracks, { iterations: 25 });
  assert.deepEqual(scene, before);
  assert.deepEqual(result.frames[0], scene.frames[0]);
  assert.equal(result.camera.f, scene.camera.f, 'manual focal length stays fixed');
  assert.ok(Math.abs(Math.hypot(...center(result.frames[1].pose)) - Math.hypot(...center(scene.frames[1].pose))) < 1e-9);
  assert.ok(result.report.refinement.finalCost < result.report.refinement.initialCost * 0.01);
  assert.ok(result.points.every(p => p.xyz.every(Number.isFinite)));
});

test('robust refinement tolerates wrong observations and bounds focal length', () => {
  const { scene, tracks } = fixture(true);
  scene.camera.f *= 1.05;
  const result = refine(scene, tracks, { refineFocal: true, iterations: 25 });
  assert.ok(result.report.refinement.finalCost < result.report.refinement.initialCost * 0.3);
  assert.ok(result.camera.f > scene.camera.width * 0.3 && result.camera.f < scene.camera.width * 2);
});

test('degenerate or non-finite scenes keep the original reconstruction', () => {
  const { scene, tracks } = fixture();
  assert.equal(refine(scene, tracks.map(t => t.slice(0, 2))), scene);
  scene.points[0].xyz[2] = NaN;
  assert.equal(refine(scene, tracks), scene);
});
