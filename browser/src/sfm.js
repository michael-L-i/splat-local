import cv from '@techstark/opencv-js';
import { bootstrap, identityPose, reprojection, tolerance, triangulate } from './geometry.js';
import { refine } from './refine.js';

// OpenCV 4.x is a thenable, not a Promise; awaiting it directly loops forever.
export const cvReady = new Promise(resolve => {
  if (cv.Mat) resolve();
  else cv.onRuntimeInitialized = resolve;
});

const minimumViews = 5;

function scope(fn) {
  const objects = [];
  try { return fn(object => (objects.push(object), object)); }
  finally { objects.reverse().forEach(object => object.delete()); }
}

// Plain walls and floors yield few AKAZE responses at the default threshold;
// retry once with a lower one, and keep only the strongest responses so
// matching cost stays bounded on richly textured frames.
const maxFeatures = 1500;
function features(image, index) {
  return scope(use => {
    const rgba = use(cv.matFromImageData(image)), gray = use(new cv.Mat());
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    const detector = use(new cv.AKAZE()), keys = use(new cv.KeyPointVector()), all = use(new cv.Mat());
    const small = use(new cv.Mat());
    cv.resize(gray, small, new cv.Size(32, 32), 0, 0, cv.INTER_AREA);
    const thumb = Float32Array.from(small.data), mean = thumb.reduce((s, v) => s + v, 0) / thumb.length;
    const norm = Math.hypot(...thumb.map(v => v - mean)) || 1;
    thumb.forEach((v, i) => { thumb[i] = (v - mean) / norm; });
    for (const threshold of [0.001, 0.0002]) {
      detector.setThreshold(threshold);
      detector.detectAndCompute(gray, use(new cv.Mat()), keys, all);
      if (keys.size() >= 800) break;
    }
    const order = Array.from({ length: keys.size() }, (_, i) => i);
    if (order.length > maxFeatures) order.sort((a, b) => keys.get(b).response - keys.get(a).response).length = maxFeatures;
    const points = [], colors = [], stride = all.cols;
    const rows = new Uint8Array(order.length * stride);
    order.forEach((key, i) => {
      const { x, y } = keys.get(key).pt;
      points.push([x, y]);
      const offset = (Math.round(y) * image.width + Math.round(x)) * 4;
      colors.push(Array.from(image.data.slice(offset, offset + 3)));
      rows.set(all.data.subarray(key * stride, (key + 1) * stride), i * stride);
    });
    const desc = cv.matFromArray(order.length, stride, cv.CV_8U, rows);
    return { index, points, colors, desc, thumb, partners: new Set(), landmarks: new Map(), pose: null };
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
        if (m.distance < 0.8 * n.distance) matches.push({ ai: m.queryIdx, bi: m.trainIdx, distance: m.distance });
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
  if (correspondences.length < 15) return null;
  const limit = tolerance(camera);
  return scope(use => {
    const mat = (n, type, values) => use(cv.matFromArray(n, 1, type, values));
    const points = mat(correspondences.length, cv.CV_64FC3, correspondences.flatMap(c => c.xyz));
    const pixels = mat(correspondences.length, cv.CV_64FC2, correspondences.flatMap(c => c.xy));
    const K = use(cv.matFromArray(3, 3, cv.CV_64F, [camera.f, 0, camera.width/2, 0, camera.f, camera.height/2, 0, 0, 1]));
    const distortion = use(new cv.Mat()), r = use(new cv.Mat()), t = use(new cv.Mat()), inliers = use(new cv.Mat());
    const ok = cv.solvePnPRansac(points, pixels, K, distortion, r, t, false, 2000, limit, 0.999, inliers, cv.SOLVEPNP_EPNP);
    if (!ok || inliers.rows < 15) return null;
    const good = Array.from(inliers.data32S).map(i => correspondences[i]);
    const p = mat(good.length, cv.CV_64FC3, good.flatMap(c => c.xyz));
    const q = mat(good.length, cv.CV_64FC2, good.flatMap(c => c.xy));
    cv.solvePnPRefineLM(p, q, K, distortion, r, t);
    const R = use(new cv.Mat());
    cv.Rodrigues(r, R);
    const pose = { R: Array.from(R.data64F), t: Array.from(t.data64F) };
    const kept = good.filter(c => reprojection(pose, c.xyz, c.xy, camera) <= limit);
    // A pose supported by a small minority of its candidates is not trustworthy.
    return kept.length >= 15 && kept.length >= correspondences.length * 0.15 ? { pose, good: kept } : null;
  });
}

// Try a few seed pairs starting from several places in the clip: the opening
// seconds are often the least steady, and one bad start should not sink a run.
function seedPairs(count) {
  const anchors = [...new Set([0, Math.floor(count / 2), Math.floor(count / 4), Math.floor(count * 3 / 4)])];
  return anchors.flatMap(a => [2, 4, 1, 6].map(gap => [a, a + gap]).filter(([, b]) => b < count));
}

// Placed views a pending view may register against: its close neighbours in
// the clip, plus the placed views that look most alike (a cheap thumbnail
// correlation) so a walk that returns to an earlier part of the scene
// reconnects. Each view only ever matches a bounded number of partners,
// which keeps pairwise matching near-linear in the frame count.
const similarity = (a, b) => a.thumb.reduce((sum, v, i) => sum + v * b.thumb[i], 0);
function neighbours(frames, frame) {
  const placed = frames.filter(f => f.pose).sort((a, b) => Math.abs(a.index-frame.index) - Math.abs(b.index-frame.index));
  const close = placed.filter(f => Math.abs(f.index - frame.index) <= 3).slice(0, 6);
  const far = placed.filter(f => !close.includes(f) && (frame.partners.has(f) || frame.partners.size < 8))
    .map(f => [similarity(frame, f), f]).filter(([score]) => score > 0.5).sort((a, b) => b[0] - a[0]).slice(0, 2).map(([, f]) => f);
  const fallback = close.length || far.length ? [] : placed.filter(f => Math.abs(f.index - frame.index) <= 12).slice(0, 2);
  const chosen = [...close, ...far, ...fallback];
  chosen.forEach(f => { if (!close.includes(f)) frame.partners.add(f); });
  return chosen;
}

async function mapFrames(frames, camera, cachedMatch, progress) {
  const points = [];
  const addPoint = (a, b, m, xyz) => {
    const id = points.length;
    points.push({ xyz, rgb: a.colors[m.ai] });
    a.landmarks.set(m.ai, id); b.landmarks.set(m.bi, id);
  };
  frames.forEach(frame => { frame.pose = null; frame.landmarks.clear(); });
  let seed = null;
  for (const [a, b] of seedPairs(frames.length)) {
    progress(`Finding initial camera pair: ${a + 1} + ${b + 1}`);
    const result = bootstrap(cachedMatch(frames[a], frames[b]), camera);
    if (result) { seed = { ...result, first: frames[a], frame: frames[b] }; break; }
  }
  if (!seed) return null;
  seed.first.pose = identityPose(); seed.frame.pose = seed.pose;
  seed.points.forEach(p => addPoint(seed.first, seed.frame, p, p.xyz));

  // Grow outward from the seed: always register the pending view that shares
  // the most known points with nearby placed views, so one weak stretch of the
  // clip does not block everything after it. A failed view is retried only
  // once it has noticeably more candidates than when it last failed.
  const failed = new Map();
  const gather = frame => {
    const references = neighbours(frames, frame);
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
    return { frame, pairs, unique };
  };
  for (;;) {
    const pending = frames.filter(f => !f.pose).map(gather)
      .filter(({ frame, unique }) => unique.length >= 15 && (!failed.has(frame) || unique.length >= failed.get(frame) * 1.3))
      .sort((a, b) => b.unique.length - a.unique.length);
    if (!pending.length) break;
    const { frame, pairs, unique } = pending[0];
    const result = fitPose(unique, camera);
    if (!result) { failed.set(frame, unique.length); progress(`Camera ${frame.index + 1}: insufficient reliable tracks`); continue; }
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
      // A near-complete registration is not worth re-mapping for the remaining lenses.
      if (report.registered >= report.total * 0.95 && report.medianError < 1) break;
    }
    if (!best) throw new Error('No stable initial camera pair. Try a textured scene with sideways motion.');
    progress('Refining camera positions and scene geometry…');
    best = refine(best, best.tracks, { refineFocal: !camera.f, progress });
    const limit = tolerance(best.camera);
    const errors = best.tracks.flatMap((track, id) => track.map(o => reprojection(best.frames[o.frame].pose, best.points[id].xyz, o.xy, best.camera))).sort((a, b) => a - b);
    const { report } = best;
    report.initialMedianError = report.medianError;
    report.medianError = errors[Math.floor(errors.length / 2)];
    report.p90Error = errors[Math.floor(errors.length * 0.9)];
    report.fov = 360 / Math.PI * Math.atan(best.camera.width / (2 * best.camera.f));
    // Do not seed training with points that no longer agree with their views.
    best.points = best.points.filter((point, id) => best.tracks[id].filter(o => reprojection(best.frames[o.frame].pose, point.xyz, o.xy, best.camera) <= limit / 2).length >= 2);
    report.points = best.points.length;
    delete best.tracks;
    const summary = `${report.registered}/${report.total} cameras, median error ${report.medianError.toFixed(2)} px`;
    if (report.registered < minimumViews || report.points < 40) throw new Error(`Reconstruction rejected: ${summary}. Too few views could be placed. Try a shorter clip that moves slowly sideways past a textured scene.`);
    if (!Number.isFinite(report.medianError) || report.medianError > limit || report.p90Error > limit * 2) throw new Error(`Reconstruction rejected: ${summary}. The recovered cameras disagree with the footage. Try a steadier clip without zooming or cuts.`);
    report.warnings = [];
    if (report.registered < report.total * 0.75) report.warnings.push(`Only ${report.registered} of ${report.total} views could be placed; the splat will cover that part of the clip. Slower movement, more frames or a shorter clip usually helps.`);
    return best;
  } finally { frames.forEach(frame => frame.desc.delete()); }
}
