// Splat Local — shared viewer for the demo site.
//
// Adapted from web/viewer.js. Two differences from the in-app viewer:
//   1. Paths are relative, because GitHub Pages serves the site under
//      /<repo>/ rather than /.
//   2. It fits the camera to the splat's own bounds. The app never needed
//      this: it always loads sparse.ply first, which sets the framing.
import * as THREE from "three";
import { OrbitControls } from "../vendor/three/OrbitControls.js";
import { SplatMesh, SparkRenderer } from "@sparkjsdev/spark";

// Spark's SplatFileType values, keyed by extension. Needed because blob URLs
// (drag-and-drop) carry no extension for Spark to sniff.
export const FILE_TYPES = {
  ply: "ply",
  spz: "spz",
  splat: "splat",
  ksplat: "ksplat",
  sog: "pcsogszip",
  rad: "rad",
};

export function fileTypeFor(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  return FILE_TYPES[ext] || null;
}

// --- order statistics --------------------------------------------------------
// In-place quickselect (nth_element): partitions arr around its k-th smallest
// value and returns it, in O(n) expected time. Camera framing reads a handful
// of percentiles off hundreds of thousands of coordinates; full sorts spent
// O(n log n) per pass to produce one number each.
function select(arr, k) {
  const swap = (i, j) => { const t = arr[i]; arr[i] = arr[j]; arr[j] = t; };
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) {
    // Median-of-three pivot: splat coordinates arrive spatially clustered, and
    // a naive pivot would hit the O(n^2) path on runs like that.
    const mid = (lo + hi) >> 1;
    if (arr[mid] < arr[lo]) swap(mid, lo);
    if (arr[hi] < arr[lo]) swap(hi, lo);
    if (arr[hi] < arr[mid]) swap(hi, mid);
    const pivot = arr[mid];
    let i = lo, j = hi;
    while (i <= j) {
      while (arr[i] < pivot) i++;
      while (arr[j] > pivot) j--;
      if (i <= j) { swap(i, j); i++; j--; }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return arr[k];
  }
  return arr[k];
}

// The same value the old sort-then-index produced: the k-th smallest for
// k = min(len-1, floor(len * p)). Reorders arr, but preserves its contents, so
// repeated percentiles off one array stay correct -- pass a copy only when the
// original index order is still needed.
function pct(arr, p) {
  return select(arr, Math.min(arr.length - 1, Math.floor(arr.length * p)));
}

export function createViewer(canvas, opts = {}) {
  const { idleSpin = false } = opts;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0b0c);

  // COLMAP/Spark convention is +Y down; flip the whole world upright.
  const world = new THREE.Group();
  world.rotation.x = Math.PI;
  scene.add(world);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 1000);
  camera.position.set(2.2, 1.4, 3.2);

  // No MSAA: splats are alpha-blended point sprites with no geometric edges for
  // multisampling to resolve, so it buys nothing and costs bandwidth everywhere.
  // --- level of detail -------------------------------------------------------
  // Spark ships a full LOD implementation but only uses it when a SplatMesh is
  // constructed with `lod`; otherwise every splat is drawn every frame. With it
  // on, traversal costs O(rendered splats) and splats behind the camera or wide
  // of the view cone fall to coarser levels.
  //
  // `lod: 1.5` picks Spark's Tiny LoD build with a 1.5x ratio between levels --
  // smoother transitions than 2.0. (Spark reads any truthy non-"quality" value
  // as Tiny LoD and already defaults the ratio to 1.5; this just says so.)
  const LOD = 1.5;
  const MOBILE = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  const LOD_SPLAT_COUNT = MOBILE ? 4e5 : 1.5e6; // per-frame splat budget

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  // SparkRenderer is required for SplatMesh to draw at all.
  scene.add(new SparkRenderer({ renderer, lodSplatCount: LOD_SPLAT_COUNT }));

  // --- adaptive resolution ---------------------------------------------------
  // Rendering is fragment-bound, not splat-bound: every pixel blends dozens of
  // near-transparent splats, so cost tracks the pixel count almost linearly.
  // Cap the ceiling well below the old 2x, then render at 1x while the camera
  // is in motion and restore the ceiling once it settles. Sharpness only drops
  // while it isn't perceptible.
  const DPR_STILL = Math.min(window.devicePixelRatio || 1, 1.5);
  const DPR_MOVING = Math.min(DPR_STILL, 1);
  const SETTLE_MS = 200;
  let pixelRatio = DPR_STILL, pointerDown = false, lastMotion = -Infinity;
  const _prevPos = new THREE.Vector3(), _prevTarget = new THREE.Vector3();
  renderer.setPixelRatio(pixelRatio);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0, 0);

  let splat = null;
  let radius = 3;
  let spinning = idleSpin;
  let swayT = 0;

  // Any deliberate input stops the idle orbit for good.
  for (const ev of ["pointerdown", "wheel", "keydown"]) {
    canvas.addEventListener(ev, () => { spinning = false; }, { passive: true });
  }

  // --- keyboard fly navigation: WASD move, arrows turn/look (as in the app) --
  const NAV_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "w", "a", "s", "d"]);
  const keys = new Set();
  window.addEventListener("keydown", (e) => {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (!NAV_KEYS.has(k) || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = document.activeElement;
    if (t && /^(input|select|textarea|button)$/i.test(t.tagName)) return;
    keys.add(k);
    spinning = false;
    e.preventDefault();
  });
  window.addEventListener("keyup", (e) => keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key));
  window.addEventListener("blur", () => keys.clear());

  canvas.addEventListener("pointerdown", () => { pointerDown = true; }, { passive: true });
  window.addEventListener("pointerup", () => { pointerDown = false; }, { passive: true });
  window.addEventListener("pointercancel", () => { pointerDown = false; }, { passive: true });
  canvas.addEventListener("wheel", () => { lastMotion = performance.now(); }, { passive: true });

  const _dir = new THREE.Vector3(), _right = new THREE.Vector3(),
        _move = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);

  function updateNav(dt) {
    if (!keys.size) return;
    camera.getWorldDirection(_dir);
    _right.crossVectors(_dir, _up).normalize();
    _move.set(0, 0, 0);
    if (keys.has("w")) _move.add(_dir);
    if (keys.has("s")) _move.sub(_dir);
    if (keys.has("a")) _move.sub(_right);
    if (keys.has("d")) _move.add(_right);
    if (_move.lengthSq()) {
      _move.normalize().multiplyScalar(radius * 0.6 * dt); // cross the scene in a few seconds
      camera.position.add(_move);
      controls.target.add(_move);
    }
    const yaw = (keys.has("ArrowLeft") ? 1 : 0) - (keys.has("ArrowRight") ? 1 : 0);
    const pitch = (keys.has("ArrowUp") ? 1 : 0) - (keys.has("ArrowDown") ? 1 : 0);
    if (yaw || pitch) {
      const offset = controls.target.clone().sub(camera.position);
      if (yaw) offset.applyAxisAngle(_up, yaw * 1.5 * dt);
      if (pitch) {
        const pitched = offset.clone().applyAxisAngle(_right, pitch * 1.2 * dt);
        const angle = pitched.angleTo(_up);
        if (angle > 0.09 && angle < Math.PI - 0.09) offset.copy(pitched); // don't flip over the poles
      }
      controls.target.copy(camera.position).add(offset);
    }
  }

  function resize() {
    const el = canvas.parentElement;
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(canvas.parentElement);
  resize();

  function applyPixelRatio(r) {
    if (r === pixelRatio) return;
    pixelRatio = r;
    renderer.setPixelRatio(r);
    resize(); // re-size the drawing buffer for the new ratio
  }

  // Record the camera pose so updatePixelRatio can tell whether the frame moved
  // it. Called after the idle sway, deliberately: the sway is slow enough that
  // its softening would be visible, and it's the landing page's resting state.
  function markCameraPose() { _prevPos.copy(camera.position); _prevTarget.copy(controls.target); }

  function updatePixelRatio(now) {
    // Key/pointer state alone isn't enough: OrbitControls damping keeps nudging
    // the camera for a while after the input ends, so watch the pose too.
    const eps = Math.max(radius, 1e-3) * 1e-4;
    const moved = camera.position.distanceTo(_prevPos) > eps || controls.target.distanceTo(_prevTarget) > eps;
    if (moved || pointerDown || keys.size) lastMotion = now;
    applyPixelRatio(now - lastMotion < SETTLE_MS ? DPR_MOVING : DPR_STILL);
  }

  // Frame the camera on a local-space (pre-flip) bounding box.
  function frameBox(min, max) {
    // world group is rotated 180deg about X: (x,y,z) -> (x,-y,-z)
    const cx = (min.x + max.x) / 2;
    const cy = -(min.y + max.y) / 2;
    const cz = -(min.z + max.z) / 2;
    const ex = Math.max(max.x - min.x, 0.05);
    const ey = Math.max(max.y - min.y, 0.05);
    const ez = Math.max(max.z - min.z, 0.05);
    const size = Math.max(ex, ey, ez);
    radius = size / 2;

    // Back off along a fixed 3/4 direction, but never further than the box
    // itself: an interior walkthrough is enclosed, so an orbit-style camera at
    // 2.4x radius ends up outside the room staring through a wall. Clamping to
    // the box keeps rooms interior and still frames object-like scenes.
    // Distance is limited by the horizontal footprint only. Rooms are far
    // shorter than they are wide, so letting height into this clamp jams the
    // camera into the floor.
    const dir = new THREE.Vector3(0.55, 0.4, 0.75).normalize();
    const dist = Math.min(
      radius * 2.4,
      Math.abs(ex * 0.5 / dir.x),
      Math.abs(ez * 0.5 / dir.z),
    );
    // Then keep the eye inside the room vertically, roughly at head height.
    const dy = Math.min(dir.y * dist, ey * 0.35);

    camera.position.set(cx + dir.x * dist, cy + dy, cz + dir.z * dist);
    camera.near = Math.max(radius * 0.002, 0.001);
    camera.far = radius * 60;
    camera.updateProjectionMatrix();
    // Aim slightly above the centroid. Reconstructed floors are the blurriest
    // part of a walkthrough (they're closest to the camera path and seen at a
    // glancing angle), so looking at the centroid fills half the frame with mush.
    controls.target.set(cx, cy + ey * 0.15, cz);
    controls.update();
  }

  // Frame a splat by trimming outliers radially, then boxing what survives.
  //
  // A plain min/max box is useless here: trained scenes throw floaters a long
  // way out, and even a 5th/95th percentile box stays contaminated. Measured on
  // the demo scene, splat distance from the median centre runs 8.3 at p50 and
  // 10.8 at p70, then blows up to 221 by p95 — so anything looser than about
  // p75 frames mostly empty space.
  function fitToSplat(mesh) {
    const packed = mesh.packedSplats ?? mesh;
    if (typeof packed.forEachSplat !== "function") return false;

    const pts = [];
    try {
      packed.forEachSplat((index, center) => {
        if (!center || (index & 3)) return; // every 4th splat is plenty
        pts.push(center.x, center.y, center.z);
      });
    } catch (e) {
      console.warn("splat sampling failed, using default framing:", e);
      return false;
    }
    const n = pts.length / 3;
    if (n < 8) return false;

    const axis = (k) => { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = pts[i * 3 + k]; return a; };
    const cols = [axis(0), axis(1), axis(2)];
    const centre = cols.map((c) => pct(c, 0.5));

    const dist = new Array(n);
    for (let i = 0; i < n; i++) {
      dist[i] = Math.hypot(
        pts[i * 3] - centre[0], pts[i * 3 + 1] - centre[1], pts[i * 3 + 2] - centre[2],
      );
    }
    const keepRadius = pct(dist.slice(), 0.75); // copy: dist is re-read by index below

    const kept = [[], [], []];
    for (let i = 0; i < n; i++) {
      if (dist[i] > keepRadius) continue;
      kept[0].push(pts[i * 3]); kept[1].push(pts[i * 3 + 1]); kept[2].push(pts[i * 3 + 2]);
    }
    if (kept[0].length < 8) return false;

    const lo = kept.map((c) => pct(c, 0.02));
    const hi = kept.map((c) => pct(c, 0.98));
    frameBox({ x: lo[0], y: lo[1], z: lo[2] }, { x: hi[0], y: hi[1], z: hi[2] });
    return true;
  }

  async function loadSplat(url, fileType) {
    // nonLod keeps the un-decimated splats alongside the LOD tree; fitToSplat
    // samples them for framing, and without it the base PackedSplats comes back
    // empty and framing would silently fall back to the default pose.
    const opts = { url, lod: LOD, nonLod: true };
    if (fileType) opts.fileType = fileType;
    const mesh = new SplatMesh(opts);
    await mesh.initialized;
    world.add(mesh);
    if (splat) { world.remove(splat); splat.dispose(); }
    splat = mesh;
    fitToSplat(mesh);
    return mesh;
  }

  function clear() {
    if (splat) { world.remove(splat); splat.dispose(); splat = null; }
    radius = 3;
    camera.position.set(2.2, 1.4, 3.2);
    controls.target.set(0, 0, 0);
    controls.update();
  }

  let lastT = performance.now();
  (function animate(now = lastT) {
    requestAnimationFrame(animate);
    const dt = Math.min((now - lastT) / 1000, 0.1);
    lastT = now;
    if (spinning && splat) {
      // Sway, don't orbit. A continuous orbit drifts off the framing that
      // fitToSplat picked and ends up staring at a wall; this stays within a
      // few degrees of it while keeping the scene visibly alive.
      const SWAY = 0.13, RATE = 0.42; // radians amplitude, radians/sec
      swayT += dt;
      const offset = camera.position.clone().sub(controls.target);
      offset.applyAxisAngle(_up, SWAY * RATE * Math.cos(swayT * RATE) * dt);
      camera.position.copy(controls.target).add(offset);
    }
    markCameraPose();
    updateNav(dt);
    controls.update();
    updatePixelRatio(now);
    renderer.render(scene, camera);
  })();

  return { loadSplat, clear, stopSpin: () => { spinning = false; } };
}
