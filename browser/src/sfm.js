import cv from '@techstark/opencv-js';
import { bootstrap, identityPose, reprojection, triangulate } from './geometry.js';
import { refine } from './refine.js';

// OpenCV 4.x is a thenable, not a Promise; awaiting it directly loops forever.
export const cvReady = new Promise(resolve => {
  if (cv.Mat) resolve();
  else cv.onRuntimeInitialized = resolve;
});

function scope(fn) {
  const objects = [];
  try { return fn(object => (objects.push(object), object)); }
  finally { objects.reverse().forEach(object => object.delete()); }
}

function features(image, index) {
  return scope(use => {
    const rgba = use(cv.matFromImageData(image)), gray = use(new cv.Mat());
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    const detector = use(new cv.AKAZE()), keys = use(new cv.KeyPointVector());
    const desc = new cv.Mat();
    try { detector.detectAndCompute(gray, use(new cv.Mat()), keys, desc); }
    catch (error) { desc.delete(); throw error; }
    const points = [], colors = [];
    for (let i = 0; i < keys.size(); i++) {
      const { x, y } = keys.get(i).pt;
      points.push([x, y]);
      const offset = (Math.round(y) * image.width + Math.round(x)) * 4;
      colors.push(Array.from(image.data.slice(offset, offset + 3)));
    }
    return { index, points, colors, desc, landmarks: new Map(), pose: null };
  });
}

function match(a, b) {
  if (a.desc.rows < 2 || b.desc.rows < 2) return [];
  return scope(use => {
    const matcher = use(new cv.BFMatcher(cv.NORM_HAMMING, false));
    const pairs = use(new cv.DMatchVectorVector());
    matcher.knnMatch(a.desc, b.desc, pairs, 2);
    const matches = [], targets = new Set();
    for (let i = 0; i < pairs.size(); i++) {
      const pair = pairs.get(i);
      if (pair.size() === 2) {
        const m = pair.get(0), n = pair.get(1);
        if (m.distance < 0.75 * n.distance) matches.push({ ai: m.queryIdx, bi: m.trainIdx, distance: m.distance });
      }
      pair.delete();
    }
    return matches.sort((x, y) => x.distance - y.distance).filter(m => {
      if (targets.has(m.bi)) return false;
      targets.add(m.bi);
      m.a = a.points[m.ai]; m.b = b.points[m.bi];
      return true;
    });
  });
}

function fitPose(correspondences, camera) {
  if (correspondences.length < 12) return null;
  return scope(use => {
    const mat = (n, type, values) => use(cv.matFromArray(n, 1, type, values));
    const points = mat(correspondences.length, cv.CV_64FC3, correspondences.flatMap(c => c.xyz));
    const pixels = mat(correspondences.length, cv.CV_64FC2, correspondences.flatMap(c => c.xy));
    const K = use(cv.matFromArray(3, 3, cv.CV_64F, [camera.f, 0, camera.width/2, 0, camera.f, camera.height/2, 0, 0, 1]));
    const distortion = use(new cv.Mat()), r = use(new cv.Mat()), t = use(new cv.Mat()), inliers = use(new cv.Mat());
    const ok = cv.solvePnPRansac(points, pixels, K, distortion, r, t, false, 300, 3, 0.999, inliers, cv.SOLVEPNP_EPNP);
    if (!ok || inliers.rows < 12 || inliers.rows < correspondences.length * 0.4) return null;
    const good = Array.from(inliers.data32S).map(i => correspondences[i]);
    const p = mat(good.length, cv.CV_64FC3, good.flatMap(c => c.xyz));
    const q = mat(good.length, cv.CV_64FC2, good.flatMap(c => c.xy));
    cv.solvePnPRefineLM(p, q, K, distortion, r, t);
    const R = use(new cv.Mat());
    cv.Rodrigues(r, R);
    const pose = { R: Array.from(R.data64F), t: Array.from(t.data64F) };
    return { pose, good: good.filter(c => reprojection(pose, c.xyz, c.xy, camera) <= 3) };
  });
}

async function mapFrames(frames, camera, cachedMatch, progress) {
  const points = [];
  const addPoint = (a, b, m, xyz) => {
    const id = points.length;
    points.push({ xyz, rgb: a.colors[m.ai] });
    a.landmarks.set(m.ai, id); b.landmarks.set(m.bi, id);
  };
  frames.forEach(frame => { frame.pose = null; frame.landmarks.clear(); });
  const first = frames[0];
  let seed = null;
  for (const i of [2, 4, 1, 6].filter(i => i < frames.length)) {
    progress(`Finding initial camera pair: 1 + ${i + 1}`);
    const result = bootstrap(cachedMatch(first, frames[i]), camera);
    if (result) { seed = { ...result, frame: frames[i] }; break; }
  }
  if (!seed) return null;
  first.pose = identityPose(); seed.frame.pose = seed.pose;
  seed.points.forEach(p => addPoint(first, seed.frame, p, p.xyz));

  // Revisit skipped frames once more, using the nearest registered views.
  for (let pass = 0; pass < 2; pass++) for (const frame of frames) {
    if (frame.pose) continue;
    const references = frames.filter(f => f.pose).sort((a, b) => Math.abs(a.index-frame.index) - Math.abs(b.index-frame.index)).slice(0, 3);
    const pairs = references.map(ref => ({ ref, matches: cachedMatch(ref, frame) }));
    const candidates = pairs.flatMap(({ ref, matches }) => matches.flatMap(m => {
      const id = ref.landmarks.get(m.ai);
      return id === undefined ? [] : [{ id, bi: m.bi, xyz: points[id].xyz, xy: m.b, distance: m.distance }];
    })).sort((a, b) => a.distance - b.distance);
    const usedPoints = new Set(), usedPixels = new Set();
    const unique = candidates.filter(c => {
      if (usedPoints.has(c.id) || usedPixels.has(c.bi)) return false;
      usedPoints.add(c.id); usedPixels.add(c.bi); return true;
    });
    const result = fitPose(unique, camera);
    if (!result || result.good.length < 12) { progress(`Camera ${frame.index + 1}: insufficient reliable tracks`); continue; }
    frame.pose = result.pose;
    result.good.forEach(c => frame.landmarks.set(c.bi, c.id));
    for (const { ref, matches } of pairs) for (const m of matches) {
      if (frame.landmarks.has(m.bi) || ref.landmarks.has(m.ai)) continue;
      const xyz = triangulate(ref.pose, frame.pose, m.a, m.b, camera);
      if (xyz) addPoint(ref, frame, m, xyz);
    }
    progress(`Camera ${frame.index + 1}: ${result.good.length} inliers; ${points.length} sparse points`);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  const registered = frames.filter(f => f.pose);
  const tracks = points.map(() => []);
  registered.forEach((f, frame) => [...f.landmarks].forEach(([key, id]) => tracks[id].push({ frame, xy: f.points[key] })));
  const errors = registered.flatMap(f => [...f.landmarks].map(([key, id]) => reprojection(f.pose, points[id].xyz, f.points[key], camera))).sort((a, b) => a - b);
  const fov = 360 / Math.PI * Math.atan(camera.width / (2 * camera.f));
  const report = { registered: registered.length, total: frames.length, points: points.length, medianError: errors[Math.floor(errors.length/2)], fov };
  return { camera, frames: registered.map(({ index, pose }) => ({ index, pose })), points, report, tracks };
}

export async function reconstruct(images, camera, progress = () => {}) {
  await cvReady;
  const frames = [], cache = new Map();
  const cachedMatch = (a, b) => {
    const key = `${a.index}:${b.index}`;
    if (!cache.has(key)) cache.set(key, match(a, b));
    return cache.get(key);
  };
  try {
    for (let i = 0; i < images.length; i++) {
      frames.push(features(images[i], i));
      images[i] = null;
      progress(`Features ${i + 1}/${images.length}: ${frames[i].points.length}`);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    const candidates = camera.f ? [camera.f] : [60, 75, 90, 105, 45].map(deg => camera.width / (2 * Math.tan(deg * Math.PI/360)));
    let best = null, bestScore = -Infinity;
    for (const f of candidates) {
      progress(`Testing lens: ${(360 / Math.PI * Math.atan(camera.width / (2*f))).toFixed(0)}° horizontal field of view`);
      const result = await mapFrames(frames, { ...camera, f }, cachedMatch, progress);
      if (!result) continue;
      const { report } = result;
      progress(`Lens ${report.fov.toFixed(0)}°: ${report.registered}/${report.total} cameras; median error ${report.medianError.toFixed(2)} px`);
      const score = report.registered / report.total - report.medianError * 0.05;
      if (score > bestScore) { best = result; bestScore = score; }
    }
    if (!best) throw new Error('No stable initial camera pair. Try a textured scene with sideways motion.');
    progress('Refining camera positions and scene geometry…');
    best = refine(best, best.tracks, { refineFocal: !camera.f, progress });
    const errors = best.tracks.flatMap((track, id) => track.map(o => reprojection(best.frames[o.frame].pose, best.points[id].xyz, o.xy, best.camera))).sort((a, b) => a - b);
    const { report } = best;
    report.initialMedianError = report.medianError;
    report.medianError = errors[Math.floor(errors.length / 2)];
    report.p90Error = errors[Math.floor(errors.length * 0.9)];
    report.fov = 360 / Math.PI * Math.atan(best.camera.width / (2 * best.camera.f));
    // Do not seed training with points that no longer agree with their views.
    best.points = best.points.filter((point, id) => best.tracks[id].filter(o => reprojection(best.frames[o.frame].pose, point.xyz, o.xy, best.camera) <= 2).length >= 2);
    report.points = best.points.length;
    delete best.tracks;
    if (report.registered < 4 || report.registered / report.total < 0.75 || report.points < 40 || !Number.isFinite(report.medianError) || report.medianError > 2 || report.p90Error > 4) throw new Error(`Reconstruction rejected: ${report.registered}/${report.total} cameras, median error ${report.medianError.toFixed(2)} px. Try a shorter clip with more overlap.`);
    return best;
  } finally { frames.forEach(frame => frame.desc.delete()); }
}
