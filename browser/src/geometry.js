import { Matrix, SingularValueDecomposition as SVD, determinant } from 'ml-matrix';

export const identityPose = () => ({ R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] });
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const mul = (R, x) => [0, 1, 2].map(i => dot(R.slice(i * 3, i * 3 + 3), x));
export const cameraPoint = ({ R, t }, x) => mul(R, x).map((v, i) => v + t[i]);
export const center = ({ R, t }) => [0, 1, 2].map(i => -dot([R[i], R[i + 3], R[i + 6]], t));
export const normalize = ([x, y], { f, width, height }) => [(x - width / 2) / f, (y - height / 2) / f];
export function reprojection(pose, point, xy, camera) {
  const p = cameraPoint(pose, point);
  if (p[2] <= 0) return Infinity;
  const q = normalize(xy, camera);
  return Math.hypot(p[0] / p[2] - q[0], p[1] / p[2] - q[1]) * camera.f;
}

function nullVector(rows) {
  const A = new Matrix(rows);
  return new SVD(A.transpose().mmul(A)).rightSingularVectors.getColumn(rows[0].length - 1);
}

// Linear triangulation; reject points with weak parallax or negative depth.
export function triangulate(a, b, xyA, xyB, camera, minAngle = 0.5) {
  const rows = [];
  for (const [pose, xy] of [[a, xyA], [b, xyB]]) {
    const p = normalize(xy, camera);
    for (let i = 0; i < 2; i++) rows.push([
      ...[0, 1, 2].map(j => p[i] * pose.R[6 + j] - pose.R[i * 3 + j]),
      p[i] * pose.t[2] - pose.t[i],
    ]);
  }
  const h = nullVector(rows);
  const point = h.slice(0, 3).map(v => v / h[3]);
  if (!point.every(Number.isFinite)) return null;
  if (reprojection(a, point, xyA, camera) > 3 || reprojection(b, point, xyB, camera) > 3) return null;
  const rays = [a, b].map(p => point.map((v, i) => v - center(p)[i]));
  const cosine = dot(...rays) / (Math.hypot(...rays[0]) * Math.hypot(...rays[1]));
  if (Math.acos(Math.max(-1, Math.min(1, cosine))) < minAngle * Math.PI / 180) return null;
  return point;
}

function essential(pairs) {
  const v = nullVector(pairs.map(([a, b]) => [b[0]*a[0], b[0]*a[1], b[0], b[1]*a[0], b[1]*a[1], b[1], a[0], a[1], 1]));
  const { leftSingularVectors: U, rightSingularVectors: V } = new SVD(Matrix.from1DArray(3, 3, v));
  return U.mmul(Matrix.diag([1, 1, 0])).mmul(V.transpose()).to1DArray();
}

function sampson(E, [a, b]) {
  const x = [...a, 1], y = [...b, 1];
  const Ex = mul(E, x);
  const Ety = [0, 1, 2].map(i => dot([E[i], E[i+3], E[i+6]], y));
  return dot(y, Ex) ** 2 / (Ex[0] ** 2 + Ex[1] ** 2 + Ety[0] ** 2 + Ety[1] ** 2);
}

// Calibrated eight-point RANSAC. A fixed seed makes failures reproducible.
export function bootstrap(matches, camera) {
  if (matches.length < 40) return null;
  const pairs = matches.map(m => [normalize(m.a, camera), normalize(m.b, camera)]);
  let seed = 42, best = [];
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2**32);
  for (let iter = 0, limit = 1500; iter < limit; iter++) {
    const indices = new Set();
    while (indices.size < 8) indices.add(Math.floor(random() * pairs.length));
    const E = essential([...indices].map(i => pairs[i]));
    const inliers = pairs.flatMap((p, i) => sampson(E, p) < (1.5 / camera.f) ** 2 ? [i] : []);
    if (inliers.length > best.length) {
      best = inliers;
      limit = Math.min(limit, Math.max(100, Math.ceil(Math.log(0.001) / Math.log(1 - (best.length / pairs.length) ** 8))));
    }
  }
  if (best.length < 40) return null;
  const E = essential(best.map(i => pairs[i]));
  const { leftSingularVectors: U, rightSingularVectors: V } = new SVD(Matrix.from1DArray(3, 3, E));
  if (determinant(U) < 0) U.setColumn(2, U.getColumn(2).map(v => -v));
  if (determinant(V) < 0) V.setColumn(2, V.getColumn(2).map(v => -v));
  const W = new Matrix([[0, -1, 0], [1, 0, 0], [0, 0, 1]]);
  let result = null;
  for (const w of [W, W.transpose()]) for (const sign of [1, -1]) {
    const pose = { R: U.mmul(w).mmul(V.transpose()).to1DArray(), t: U.getColumn(2).map(v => sign * v) };
    const points = best.flatMap(i => {
      const xyz = triangulate(identityPose(), pose, matches[i].a, matches[i].b, camera);
      return xyz ? [{ ...matches[i], xyz }] : [];
    });
    if (!result || points.length > result.points.length) result = { pose, points };
  }
  return result?.points.length >= 40 ? result : null;
}

// OpenCV world-to-camera -> NeRF/OpenGL camera-to-world (Y/Z flipped).
export function nerfTransform({ R, t }) {
  const c = center({ R, t });
  return [0, 1, 2].map(i => [R[i], -R[i + 3], -R[i + 6], c[i]]).concat([[0, 0, 0, 1]]);
}
