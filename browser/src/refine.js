import { Matrix, CholeskyDecomposition } from 'ml-matrix';
import { cameraPoint, center, reprojection } from './geometry.js';

const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const zeros = n => Array(n).fill(0);
const matrix = n => Array.from({ length: n }, () => zeros(n));
const huber = error => error <= 2 ? error * error / 2 : 2 * error - 2;
const cost = (scene, tracks) => tracks.reduce((sum, track, i) => sum + track.reduce((s, o) =>
  s + huber(reprojection(scene.frames[o.frame].pose, scene.points[i].xyz, o.xy, scene.camera)), 0), 0);

function solve(A, b) {
  const factor = new CholeskyDecomposition(new Matrix(A));
  if (!factor.isPositiveDefinite()) throw new Error('Degenerate refinement system');
  return factor.solve(Matrix.columnVector(b)).getColumn(0);
}

// Left-multiply R by exp([rotation]x); translation has an independent update.
function rotate(R, rotation) {
  const angle = Math.hypot(...rotation);
  const a = angle < 1e-8 ? 1 : Math.sin(angle) / angle;
  const b = angle < 1e-8 ? 0.5 : (1 - Math.cos(angle)) / angle ** 2;
  const [x, y, z] = rotation, K = new Matrix([[0, -z, y], [z, 0, -x], [-y, x, 0]]);
  return Matrix.eye(3).add(K.clone().mul(a)).add(K.mmul(K).mul(b))
    .mmul(Matrix.from1DArray(3, 3, R)).to1DArray();
}

// Robust LM bundle adjustment. Eliminate 3D point blocks (Schur complement),
// leaving a small camera system. Fix the first pose and preserve baseline scale.
// Inputs are never mutated; rejected/non-finite steps cannot replace the scene.
export function refine(scene, tracks, { iterations = 15, refineFocal = false, progress = () => {} } = {}) {
  if (scene.frames.length < 3 || !tracks.some(t => t.length >= 3)) return scene;
  let current = structuredClone(scene), error = cost(current, tracks), damping = 0.001;
  const initial = error, n = (scene.frames.length - 1) * 6 + Number(refineFocal);
  const baseline = Math.hypot(...center(scene.frames[1].pose));
  if (!Number.isFinite(error) || baseline < 1e-8) return scene;
  let accepted = 0;
  for (let iteration = 0; iteration < iterations; iteration++) {
    const A = matrix(n), g = zeros(n), blocks = [];
    for (let id = 0; id < tracks.length; id++) {
      const B = matrix(3), h = zeros(3), cross = new Map();
      for (const { frame, xy } of tracks[id]) {
        const pose = current.frames[frame].pose, { f, width, height } = current.camera;
        const p = cameraPoint(pose, current.points[id].xyz), [x, y, z] = p;
        const residual = [f*x/z + width/2 - xy[0], f*y/z + height/2 - xy[1]];
        const weight = Math.min(1, 2 / Math.hypot(...residual));
        const projection = [[f/z, 0, -f*x/z**2], [0, f/z, -f*y/z**2]];
        const q = p.map((v, i) => v - pose.t[i]);
        const rotation = [[0, -q[2], q[1]], [q[2], 0, -q[0]], [-q[1], q[0], 0]];
        const indices = frame ? Array.from({ length: 6 }, (_, i) => (frame-1)*6+i) : [];
        if (refineFocal) indices.push(n-1);
        for (let axis = 0; axis < 2; axis++) {
          const Jp = [0, 1, 2].map(i => dot(projection[axis], [pose.R[i], pose.R[i+3], pose.R[i+6]]));
          const Jc = frame ? [...rotation.map(v => dot(projection[axis], v)), ...projection[axis]] : [];
          if (refineFocal) Jc.push(f * p[axis] / z);
          for (let i = 0; i < 3; i++) {
            h[i] += weight * Jp[i] * residual[axis];
            for (let j = 0; j < 3; j++) B[i][j] += weight * Jp[i] * Jp[j];
          }
          indices.forEach((row, i) => {
            g[row] += weight * Jc[i] * residual[axis];
            indices.forEach((col, j) => { A[row][col] += weight * Jc[i] * Jc[j]; });
            if (!cross.has(row)) cross.set(row, zeros(3));
            for (let j = 0; j < 3; j++) cross.get(row)[j] += weight * Jc[i] * Jp[j];
          });
        }
      }
      for (let i = 0; i < 3; i++) {
        B[i][i] += damping * Math.max(B[i][i], 1e-6);
        for (let j = 0; j < i; j++) B[i][j] = B[j][i] = (B[i][j] + B[j][i]) / 2;
      }
      blocks.push({ B, h, cross });
    }
    for (let i = 0; i < n; i++) A[i][i] += damping * Math.max(A[i][i], 1e-6);
    try {
      for (const block of blocks) {
        const { B, h, cross } = block;
        block.inverse = new CholeskyDecomposition(new Matrix(B)).solve(Matrix.eye(3)).to2DArray();
        const apply = v => block.inverse.map(row => dot(row, v));
        const Bh = apply(h), rows = [...cross].map(([i, v]) => [i, apply(v)]);
        for (const [i, v] of cross) {
          g[i] -= dot(v, Bh);
          for (const [j, w] of rows) A[i][j] -= dot(v, w);
        }
      }
      // Roundoff in point elimination can break exact symmetry.
      for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) A[i][j] = A[j][i] = (A[i][j] + A[j][i]) / 2;
      const step = solve(A, g.map(v => -v)), candidate = structuredClone(current);
      candidate.frames.slice(1).forEach((frame, i) => {
        const delta = step.slice(i*6, i*6+6);
        frame.pose.R = rotate(frame.pose.R, delta.slice(0, 3));
        frame.pose.t = frame.pose.t.map((v, j) => v + delta[j+3]);
      });
      blocks.forEach(({ h, cross, inverse }, id) => {
        const rhs = h.map((v, j) => -v - [...cross].reduce((s, [i, row]) => s + row[j]*step[i], 0));
        candidate.points[id].xyz = candidate.points[id].xyz.map((v, j) => v + dot(inverse[j], rhs));
      });
      if (refineFocal) candidate.camera.f *= Math.exp(Math.max(-0.05, Math.min(0.05, step[n-1])));
      const scale = baseline / Math.hypot(...center(candidate.frames[1].pose));
      candidate.frames.forEach(frame => { frame.pose.t = frame.pose.t.map(v => v * scale); });
      candidate.points.forEach(point => { point.xyz = point.xyz.map(v => v * scale); });
      const next = cost(candidate, tracks), ratio = candidate.camera.f / scene.camera.width;
      if (Number.isFinite(next) && next < error && ratio >= 0.3 && ratio <= 2) {
        const improvement = error - next;
        current = candidate; error = next; accepted++;
        damping = Math.max(1e-7, damping / 3);
        progress(`Refining cameras: ${iteration+1}/${iterations}`);
        if (improvement < 1e-6 * initial) break;
      } else damping *= 10;
    } catch { damping *= 10; }
    if (damping > 1e8) break;
  }
  current.report = { ...current.report, refinement: { initialCost: initial, finalCost: error, accepted } };
  return current;
}
