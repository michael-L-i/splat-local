import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrap, cameraPoint, identityPose, nerfTransform, triangulate } from '../src/geometry.js';
import { sparsePly, transforms } from '../src/dataset.js';

const camera = { width: 768, height: 432, f: 650 };
const project = (pose, xyz) => { const [x, y, z] = cameraPoint(pose, xyz); return [camera.f*x/z + camera.width/2, camera.f*y/z + camera.height/2]; };
const first = identityPose(), second = { ...identityPose(), t: [-1, 0, 0] };

test('triangulation and camera conventions agree', () => {
  const p = [0.3, -0.6, 5];
  const xyz = triangulate(first, second, project(first, p), project(second, p), camera);
  xyz.forEach((value, i) => assert.ok(Math.abs(value-p[i]) < 1e-7));
  assert.deepEqual(nerfTransform(second).map(row => row.map(v => v || 0)), [[1,0,0,1],[0,-1,0,0],[0,0,-1,0],[0,0,0,1]]);
});

test('degenerate motion cannot triangulate', () => {
  assert.equal(triangulate(first, first, [300,200], [300,200], camera), null);
  assert.equal(bootstrap([], camera), null);
});

test('bootstrap recovers translation with outlier matches', () => {
  let seed = 9;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2**32);
  const matches = Array.from({ length: 120 }, (_, i) => {
    const xyz = [(random()-.5)*4, (random()-.5)*2, 4+random()*4];
    return { a: project(first, xyz), b: i % 5 ? project(second, xyz) : [random()*768, random()*432] };
  });
  const result = bootstrap(matches, camera);
  assert.ok(result, 'a valid two-view reconstruction');
  assert.ok(result.points.length >= 85);
  assert.ok(result.pose.t[0] < -0.98);
});

test('dataset preserves image indices, intrinsics and sparse colors', () => {
  const data = transforms({ camera, frames: [{ index: 7, pose: second }] });
  assert.equal(data.frames[0].file_path, 'images/7.jpg');
  assert.equal(data.fl_x, 650);
  assert.match(sparsePly([{ xyz: [1,2,3], rgb: [255,0,80] }]), /end_header\n1 2 3 255 0 80\n$/);
});
