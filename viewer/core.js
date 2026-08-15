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

// --- render scheduling -------------------------------------------------------
// The loop used to draw every frame forever. A still scene costs the same as a
// moving one that way — 7.19 ms of GPU per frame at 2x pixel ratio (see the
// resolution note below), 120 times a second, to re-draw an image nobody
// changed. Sitting idle with the viewer open was the single largest thing this
// page did to a laptop.
//
// So drawing is now demand-driven: the loop still ticks, but `renderer.render`
// only runs when something actually changed. The awkward part of any such
// scheme is a change nobody announced — Spark decodes and depth-sorts splats
// asynchronously inside a minified bundle we don't control, so "the camera
// didn't move" does not prove the picture is final. Two guards make a missed
// signal cost a few late frames instead of a viewer stuck on a stale image:
//
//   SETTLE_FRAMES  keep drawing briefly after the last known change, so async
//                  work landing just after it still reaches the screen
//   IDLE_HZ        a floor, not a target: redraw this often even when idle
//
// IDLE_HZ costs ~4% of the old always-on load and buys the guarantee that
// anything missed self-corrects within 200 ms.
const SETTLE_FRAMES = 3;
const IDLE_HZ = 5;

// Escape hatch: ?render=always restores unconditional drawing. If a scene ever
// looks frozen or half-loaded, compare against this — if the flag fixes it, the
// bug is a missing invalidate() and not the renderer.
const FORCE_RENDER = /[?&]render=always\b/.test(location.search);

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
  // this is the largest lever on the cost of a frame that does get drawn, and
  // for a while it was turned down: 1.5x at rest, 1x while the camera moved.
  // (How many frames get drawn at all is now the larger lever; see the render
  // scheduling note above. The two compose: at rest almost nothing is drawn, so
  // resolution only bills while the scene is actually moving.)
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

  // Frames still owed to the screen. Positive means draw; invalidate() tops it
  // back up. Starts full so the first frames after construction always land.
  let settle = SETTLE_FRAMES;
  let lastDrawT = 0;
  let framesDrawn = 0;

  // Announce a change the loop cannot detect on its own — a mesh added or
  // removed, a visibility toggle, a camera moved directly rather than through
  // OrbitControls. Cheap and idempotent: call it whenever in doubt.
  const invalidate = () => { settle = SETTLE_FRAMES; };

  // --- wakefulness -----------------------------------------------------------
  // Two independent ways to be off-screen, and they need different listeners.
  //
  // Scrolled out of view: the window is visible, the canvas is not. Only
  // IntersectionObserver sees this, and it is the landing page's case — the
  // hero canvas kept drawing at full rate while you read the page below it.
  //
  // Window hidden: another Space (three-finger swipe), minimised, or a
  // background tab. Geometry is unchanged, so IntersectionObserver is blind to
  // it; the Page Visibility API is what fires. Browsers generally stop serving
  // requestAnimationFrame to hidden documents anyway, which makes this partly
  // belt-and-braces — but it is two lines, it stops the idle sway banking time
  // it never rendered, and it does not depend on that behaviour holding.
  let onScreen = true;
  let pageVisible = document.visibilityState !== "hidden";
  const awake = () => FORCE_RENDER || (onScreen && pageVisible);

  new IntersectionObserver(([entry]) => {
    onScreen = entry.isIntersecting;
    if (onScreen) invalidate();
  }).observe(canvas);

  document.addEventListener("visibilitychange", () => {
    pageVisible = document.visibilityState !== "hidden";
    if (pageVisible) invalidate();
  });

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
    invalidate();
    e.preventDefault();
  });
  window.addEventListener("keyup", (e) => keys.delete(normKey(e)));
  window.addEventListener("blur", () => keys.clear());

  // Any deliberate input ends the landing page's idle sway for good.
  canvas.addEventListener("pointerdown", () => { spinning = false; invalidate(); }, { passive: true });
  canvas.addEventListener("wheel", () => { spinning = false; invalidate(); }, { passive: true });

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
    invalidate(); // a resized drawing buffer comes back cleared
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

    // Off-screen: no simulation, no draw. dt is clamped above, so the jump on
    // the way back cannot fling the camera.
    if (!awake()) return;

    // Everything below is CPU-cheap and runs every tick even when the frame is
    // not drawn — skipping it would stall OrbitControls' damping and swallow
    // the change that should have woken the renderer in the first place.
    for (const hook of frameHooks) hook(dt);
    if (spinning) { idleSway(dt); invalidate(); }
    if (keys.size) { updateNav(dt); invalidate(); }
    // Returns true when it actually moved the camera, which covers both the
    // drag itself and the damped glide afterwards.
    if (controls.update()) invalidate();

    let draw = settle > 0;
    if (draw) settle--;
    else if (now - lastDrawT >= 1000 / IDLE_HZ) draw = true; // safety net
    if (!draw && !FORCE_RENDER) return;

    lastDrawT = now;
    framesDrawn++;
    renderer.render(scene, camera);
  })();

  const rig = {
    scene, world, camera, controls, renderer,
    get radius() { return radius; },
    set radius(v) { radius = Math.max(v, 1e-6); },
    // Run fn(dt) at the top of every frame, before the camera is read. A hook
    // that changes the scene must call invalidate() to get it on screen.
    onFrame(fn) { frameHooks.push(fn); },
    invalidate,
    // Frames actually drawn. The loop runs at display rate regardless, so this
    // is the only honest measure of what the viewer costs — watch it flatten
    // when the scene goes still. Exposed for tests and for hand-checking that
    // an idle viewer really has gone quiet.
    get framesDrawn() { return framesDrawn; },
    stopSpin() { spinning = false; },
    resetView() {
      radius = DEFAULT_RADIUS;
      camera.position.copy(HOME_POSITION);
      camera.near = 0.01;
      camera.far = 1000;
      camera.updateProjectionMatrix();
      controls.target.set(0, 0, 0);
      controls.update();
      invalidate();
    },
  };

  // Modules have no console-reachable scope. `__splatRig.framesDrawn` twice a
  // few seconds apart is the quickest check that an idle viewer is idle.
  window.__splatRig = rig;
  return rig;
}
