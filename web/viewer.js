import * as THREE from "three";
import { OrbitControls } from "/vendor/three/OrbitControls.js";
import { SplatMesh, SparkRenderer } from "@sparkjsdev/spark";
import { parsePLY } from "./ply-parse.js";

// Run the PLY decode in a Worker, handing over the ArrayBuffer so nothing is
// copied. Sparse clouds run 30-106 MB and the parser reads every property
// through a DataView closure per value, which stalls the render loop for
// hundreds of milliseconds when done inline.
function parsePLYAsync(buffer) {
  let worker;
  try {
    worker = new Worker(new URL("./ply-worker.js", import.meta.url), { type: "module" });
  } catch (e) {
    return Promise.resolve(parsePLY(buffer)); // no worker available: parse inline
  }
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      worker.terminate();
      if (data.error) reject(new Error(data.error)); else resolve(data);
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || "ply worker failed")); };
    worker.postMessage({ buffer }, [buffer]);
  });
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
    // Median-of-three pivot: point coordinates arrive spatially ordered often
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

// The same value the old sort-then-index produced: the k-th smallest for
// k = min(len-1, floor(len * p)). Reorders arr, but preserves its contents, so
// repeated percentiles off one array stay correct.
function percentile(arr, p) {
  return select(arr, Math.min(arr.length - 1, Math.floor(arr.length * p)));
}

// --- viewer ------------------------------------------------------------------
export function createViewer(canvas) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0b0c);

  // COLMAP/Spark convention is +Y down; flip the whole world upright.
  const world = new THREE.Group();
  world.rotation.x = Math.PI;
  scene.add(world);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 1000);
  camera.position.set(2.2, 1.4, 3.2);

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

  // No MSAA: splats are alpha-blended point sprites with no geometric edges for
  // multisampling to resolve, so it buys nothing and costs bandwidth everywhere.
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

  let pointCloud = null, frusta = null, splat = null;
  let radius = 3, frustaVisible = true;
  let loading = false, nextUrl = null, currentCheckpointUrl = null;

  // --- keyboard fly navigation: arrows/WASD move, left/right arrows turn ---
  const NAV_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "w", "a", "s", "d"]);
  const keys = new Set();
  window.addEventListener("keydown", (e) => {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (!NAV_KEYS.has(k) || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = document.activeElement;
    if (t && /^(input|select|textarea|button)$/i.test(t.tagName)) return;
    keys.add(k);
    e.preventDefault();
  });
  window.addEventListener("keyup", (e) => keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key));
  window.addEventListener("blur", () => keys.clear());

  canvas.addEventListener("pointerdown", () => { pointerDown = true; }, { passive: true });
  window.addEventListener("pointerup", () => { pointerDown = false; }, { passive: true });
  window.addEventListener("pointercancel", () => { pointerDown = false; }, { passive: true });
  canvas.addEventListener("wheel", () => { lastMotion = performance.now(); }, { passive: true });

  const _dir = new THREE.Vector3(), _right = new THREE.Vector3(), _move = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
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

  // Record the camera pose at the top of a frame so updatePixelRatio can tell
  // whether the frame actually moved it.
  function markCameraPose() { _prevPos.copy(camera.position); _prevTarget.copy(controls.target); }

  function updatePixelRatio(now) {
    // Key/pointer state alone isn't enough: OrbitControls damping keeps nudging
    // the camera for a while after the input ends, so watch the pose too.
    const eps = Math.max(radius, 1e-3) * 1e-4;
    const moved = camera.position.distanceTo(_prevPos) > eps || controls.target.distanceTo(_prevTarget) > eps;
    if (moved || pointerDown || keys.size) lastMotion = now;
    applyPixelRatio(now - lastMotion < SETTLE_MS ? DPR_MOVING : DPR_STILL);
  }

  // fit camera to the parsed (pre-flip) point positions, clamping outliers
  function fitToPositions(positions) {
    const n = positions.length / 3;
    const xs = new Array(n), ys = new Array(n), zs = new Array(n);
    for (let i = 0; i < n; i++) { xs[i] = positions[i * 3]; ys[i] = positions[i * 3 + 1]; zs[i] = positions[i * 3 + 2]; }
    const lo = [percentile(xs, 0.05), percentile(ys, 0.05), percentile(zs, 0.05)];
    const hi = [percentile(xs, 0.95), percentile(ys, 0.95), percentile(zs, 0.95)];
    // world group is rotated 180deg about X: (x,y,z) -> (x,-y,-z)
    const cx = (lo[0] + hi[0]) / 2, cy = -(lo[1] + hi[1]) / 2, cz = -(lo[2] + hi[2]) / 2;
    const size = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 0.05);
    radius = size / 2;
    const dist = radius * 2.4;
    camera.position.set(cx + dist * 0.55, cy + dist * 0.4, cz + dist * 0.75);
    camera.near = Math.max(radius * 0.01, 0.001);
    camera.far = radius * 60;
    camera.updateProjectionMatrix();
    controls.target.set(cx, cy, cz);
    controls.update();
  }

  function loadSparse(url) {
    fetch(url)
      .then((r) => r.arrayBuffer())
      .then(parsePLYAsync)
      .then(({ positions, colors }) => {
        fitToPositions(positions);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
        const mat = new THREE.PointsMaterial({ size: Math.max(radius * 0.004, 0.004), vertexColors: true, sizeAttenuation: true });
        if (pointCloud) { world.remove(pointCloud); pointCloud.geometry.dispose(); pointCloud.material.dispose(); }
        pointCloud = new THREE.Points(geo, mat);
        pointCloud.visible = !splat;
        world.add(pointCloud);
      })
      .catch((e) => console.error("sparse cloud load failed:", e));
  }

  function setCameras(cameras) {
    if (frusta) { world.remove(frusta); frusta.geometry.dispose(); frusta.material.dispose(); frusta = null; }
    if (!cameras || !cameras.length) return;
    const d = Math.max(radius * 0.06, 0.05), hw = d * 0.5, hh = d * 0.375;
    const corners = [[-hw, -hh, -d], [hw, -hh, -d], [hw, hh, -d], [-hw, hh, -d]];
    const q = new THREE.Quaternion(), p = new THREE.Vector3(), v = new THREE.Vector3();
    const pos = [];
    for (const cam of cameras) {
      const [qw, qx, qy, qz] = cam.rotation;
      q.set(qx, qy, qz, qw); // reorder cam-to-world [qw,qx,qy,qz] -> THREE (x,y,z,w)
      p.set(cam.position[0], cam.position[1], cam.position[2]);
      const w = corners.map((c) => v.set(c[0], c[1], c[2]).applyQuaternion(q).add(p).clone());
      for (const c of w) pos.push(p.x, p.y, p.z, c.x, c.y, c.z); // apex -> corner
      for (let i = 0; i < 4; i++) { const a = w[i], b = w[(i + 1) % 4]; pos.push(a.x, a.y, a.z, b.x, b.y, b.z); } // base
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    frusta = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xe3a53d, transparent: true, opacity: 0.5 }));
    frusta.visible = frustaVisible;
    world.add(frusta);
  }

  function setFrustaVisible(v) { frustaVisible = v; if (frusta) frusta.visible = v; }

  function loadCheckpoint(url) {
    if (url === currentCheckpointUrl) return;
    if (loading) { nextUrl = url; return; }
    loading = true;
    doLoadCheckpoint(url);
  }

  async function doLoadCheckpoint(url) {
    try {
      const mesh = new SplatMesh({ url, lod: LOD });
      await mesh.initialized;
      world.add(mesh);
      if (splat) { world.remove(splat); splat.dispose(); }
      splat = mesh;
      currentCheckpointUrl = url;
      if (pointCloud) pointCloud.visible = false;
    } catch (e) {
      console.error("checkpoint load failed:", e);
    } finally {
      loading = false;
      if (nextUrl) { const u = nextUrl; nextUrl = null; loadCheckpoint(u); }
    }
  }

  function reset() {
    if (pointCloud) { world.remove(pointCloud); pointCloud.geometry.dispose(); pointCloud.material.dispose(); pointCloud = null; }
    if (frusta) { world.remove(frusta); frusta.geometry.dispose(); frusta.material.dispose(); frusta = null; }
    if (splat) { world.remove(splat); splat.dispose(); splat = null; }
    currentCheckpointUrl = null; nextUrl = null; loading = false; radius = 3;
    camera.position.set(2.2, 1.4, 3.2);
    controls.target.set(0, 0, 0);
    controls.update();
  }

  let lastT = performance.now();
  (function animate(now = lastT) {
    requestAnimationFrame(animate);
    const dt = Math.min((now - lastT) / 1000, 0.1);
    lastT = now;
    markCameraPose();
    updateNav(dt);
    controls.update();
    updatePixelRatio(now);
    renderer.render(scene, camera);
  })();

  return { loadSparse, setCameras, setFrustaVisible, loadCheckpoint, reset };
}
