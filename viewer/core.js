// The shared viewer rig.
//
// Two front ends draw splats: the app's live reconstruction viewer
// (web/viewer.js) and the demo site's (site/assets/viewer.js). Everything they
// do identically lives here — scene setup, level of detail, adaptive
// resolution, fly navigation, and the frame loop — so the tuning below has one
// home instead of two that drift. Each front end adds its own scene loading and
// camera framing on top.
//
// Pages reach this module through an import map ("splat-viewer/"), which is why
// nothing here resolves a path itself: the app serves it from /viewer/, the
// static site from ./viewer/.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SparkRenderer } from "@sparkjsdev/spark";

// Spark ships a full LOD implementation but only uses it when a SplatMesh is
// constructed with `lod`; otherwise every splat is drawn every frame. With it
// on, traversal costs O(rendered splats) and splats behind the camera or wide
// of the view cone fall to coarser levels.
//
// 1.5 picks Spark's Tiny LoD build with a 1.5x ratio between levels — smoother
// transitions than 2.0. (Spark reads any truthy non-"quality" value as Tiny LoD
// and already defaults the ratio to 1.5; this just says so.)
export const LOD = 1.5;

const MOBILE = window.matchMedia?.("(pointer: coarse)").matches ?? false;
const LOD_SPLAT_COUNT = MOBILE ? 4e5 : 1.5e6; // per-frame splat budget

const HOME_POSITION = new THREE.Vector3(2.2, 1.4, 3.2);
const DEFAULT_RADIUS = 3;

// --- order statistics --------------------------------------------------------
// In-place quickselect (nth_element): partitions arr around its k-th smallest
// value and returns it, in O(n) expected time. Camera framing reads a handful
// of percentiles off hundreds of thousands of coordinates; full sorts spent
// O(n log n) per pass to produce one number each.
function select(arr, k) {
  const swap = (i, j) => { const t = arr[i]; arr[i] = arr[j]; arr[j] = t; };
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) {
    // Median-of-three pivot: point coordinates arrive spatially clustered often
    // enough that a naive pivot would hit the O(n^2) path.
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

// The k-th smallest for k = min(len-1, floor(len * p)). Reorders arr but
// preserves its contents, so repeated percentiles off one array stay correct —
// pass a copy only when the original index order is still needed.
export function percentile(arr, p) {
  return select(arr, Math.min(arr.length - 1, Math.floor(arr.length * p)));
}

// --- rig ---------------------------------------------------------------------
export function createRig(canvas, { idleSpin = false } = {}) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0b0c);

  // COLMAP/Spark convention is +Y down; flip the whole world upright.
  const world = new THREE.Group();
  world.rotation.x = Math.PI;
  scene.add(world);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 1000);
  camera.position.copy(HOME_POSITION);

  // No MSAA: splats are alpha-blended point sprites with no geometric edges for
  // multisampling to resolve, so it buys nothing and costs bandwidth everywhere.
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  // SparkRenderer is required for SplatMesh to draw at all.
  scene.add(new SparkRenderer({ renderer, lodSplatCount: LOD_SPLAT_COUNT }));

  // --- resolution ------------------------------------------------------------
  // Full device resolution, always. Rendering is fragment-bound rather than
  // splat-bound — every pixel blends dozens of near-transparent splats — so
  // this is the single largest lever on GPU cost, and for a while it was turned
  // down: 1.5x at rest, 1x while the camera moved.
  //
  // Measured on an M5 Pro (Metal) at a 1728x1117 viewport, orbiting inside the
  // 135,575-splat demo scene, one frame costs 1.39 ms at 1x, 4.04 ms at 1.5x
  // and 7.19 ms at 2x — linear in pixel count, and all three hold 120 fps with
  // budget to spare. Softening the image while touring bought headroom nothing
  // was asking for, and touring is exactly when the scene is being looked at.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0, 0);

  // Scene scale, set by whichever framing the front end uses. Drives fly speed
  // and the front ends' own point/frustum sizing.
  let radius = DEFAULT_RADIUS;
  let spinning = idleSpin;
  let swayT = 0;
  const frameHooks = [];

  // --- fly navigation: WASD move, arrows turn and look -----------------------
  const NAV_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "w", "a", "s", "d"]);
  const keys = new Set();
  const normKey = (e) => (e.key.length === 1 ? e.key.toLowerCase() : e.key);

  window.addEventListener("keydown", (e) => {
    const k = normKey(e);
    if (!NAV_KEYS.has(k) || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = document.activeElement;
    if (t && /^(input|select|textarea|button)$/i.test(t.tagName)) return;
    keys.add(k);
    spinning = false;
    e.preventDefault();
  });
  window.addEventListener("keyup", (e) => keys.delete(normKey(e)));
  window.addEventListener("blur", () => keys.clear());

  // Any deliberate input ends the landing page's idle sway for good.
  canvas.addEventListener("pointerdown", () => { spinning = false; }, { passive: true });
  canvas.addEventListener("wheel", () => { spinning = false; }, { passive: true });

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

  function idleSway(dt) {
    // Sway, don't orbit. A continuous orbit drifts off the framing the front end
    // picked and ends up staring at a wall; this stays within a few degrees of
    // it while keeping the scene visibly alive.
    const SWAY = 0.13, RATE = 0.42; // radians amplitude, radians/sec
    swayT += dt;
    const offset = camera.position.clone().sub(controls.target);
    offset.applyAxisAngle(_up, SWAY * RATE * Math.cos(swayT * RATE) * dt);
    camera.position.copy(controls.target).add(offset);
  }

  let lastT = performance.now();
  (function animate(now = lastT) {
    requestAnimationFrame(animate);
    const dt = Math.min((now - lastT) / 1000, 0.1);
    lastT = now;
    for (const hook of frameHooks) hook(dt);
    if (spinning) idleSway(dt);
    updateNav(dt);
    controls.update();
    renderer.render(scene, camera);
  })();

  return {
    scene, world, camera, controls, renderer,
    get radius() { return radius; },
    set radius(v) { radius = Math.max(v, 1e-6); },
    // Run fn(dt) at the top of every frame, before the camera is read.
    onFrame(fn) { frameHooks.push(fn); },
    stopSpin() { spinning = false; },
    resetView() {
      radius = DEFAULT_RADIUS;
      camera.position.copy(HOME_POSITION);
      camera.near = 0.01;
      camera.far = 1000;
      camera.updateProjectionMatrix();
      controls.target.set(0, 0, 0);
      controls.update();
    },
  };
}
