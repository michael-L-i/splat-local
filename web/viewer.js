// The in-app viewer: shows a reconstruction as it is built.
//
// Three layers arrive in order, each replacing the last — the COLMAP sparse
// point cloud, the camera frusta, then training checkpoints as Brush exports
// them. Scene setup, navigation and the frame loop come from the shared rig.
import * as THREE from "three";
import { SplatMesh } from "@sparkjsdev/spark";
import { createRig, LOD, percentile } from "splat-viewer/core.js";
import { parsePLYAsync } from "splat-viewer/ply.js";

export function createViewer(canvas) {
  const rig = createRig(canvas);
  const { world, camera, controls } = rig;

  let pointCloud = null, frusta = null, splat = null;
  let frustaVisible = true;
  let loading = false, nextUrl = null, currentCheckpointUrl = null;

  // Drop a layer and free its GPU memory. SplatMesh owns its buffers and cleans
  // up after itself; plain three.js objects need their geometry and material
  // released by hand.
  function discard(obj) {
    if (!obj) return null;
    world.remove(obj);
    if (obj.dispose) obj.dispose();
    else { obj.geometry.dispose(); obj.material.dispose(); }
    return null;
  }

  // Frame the camera on the parsed (pre-flip) point positions, clamping outliers.
  function fitToPositions(positions) {
    const n = positions.length / 3;
    const xs = new Array(n), ys = new Array(n), zs = new Array(n);
    for (let i = 0; i < n; i++) {
      xs[i] = positions[i * 3];
      ys[i] = positions[i * 3 + 1];
      zs[i] = positions[i * 3 + 2];
    }
    const lo = [percentile(xs, 0.05), percentile(ys, 0.05), percentile(zs, 0.05)];
    const hi = [percentile(xs, 0.95), percentile(ys, 0.95), percentile(zs, 0.95)];
    // world group is rotated 180deg about X: (x,y,z) -> (x,-y,-z)
    const cx = (lo[0] + hi[0]) / 2, cy = -(lo[1] + hi[1]) / 2, cz = -(lo[2] + hi[2]) / 2;
    const size = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 0.05);
    rig.radius = size / 2;

    const dist = rig.radius * 2.4;
    camera.position.set(cx + dist * 0.55, cy + dist * 0.4, cz + dist * 0.75);
    camera.near = Math.max(rig.radius * 0.01, 0.001);
    camera.far = rig.radius * 60;
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
        const mat = new THREE.PointsMaterial({
          size: Math.max(rig.radius * 0.004, 0.004),
          vertexColors: true,
          sizeAttenuation: true,
        });
        pointCloud = discard(pointCloud);
        pointCloud = new THREE.Points(geo, mat);
        pointCloud.visible = !splat; // a checkpoint supersedes the sparse cloud
        world.add(pointCloud);
      })
      .catch((e) => console.error("sparse cloud load failed:", e));
  }

  function setCameras(cameras) {
    frusta = discard(frusta);
    if (!cameras || !cameras.length) return;
    const d = Math.max(rig.radius * 0.06, 0.05), hw = d * 0.5, hh = d * 0.375;
    const corners = [[-hw, -hh, -d], [hw, -hh, -d], [hw, hh, -d], [-hw, hh, -d]];
    const q = new THREE.Quaternion(), p = new THREE.Vector3(), v = new THREE.Vector3();
    const pos = [];
    for (const cam of cameras) {
      const [qw, qx, qy, qz] = cam.rotation;
      q.set(qx, qy, qz, qw); // reorder cam-to-world [qw,qx,qy,qz] -> THREE (x,y,z,w)
      p.set(cam.position[0], cam.position[1], cam.position[2]);
      const w = corners.map((c) => v.set(c[0], c[1], c[2]).applyQuaternion(q).add(p).clone());
      for (const c of w) pos.push(p.x, p.y, p.z, c.x, c.y, c.z); // apex -> corner
      for (let i = 0; i < 4; i++) { // base
        const a = w[i], b = w[(i + 1) % 4];
        pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    frusta = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ color: 0xe3a53d, transparent: true, opacity: 0.5 }),
    );
    frusta.visible = frustaVisible;
    world.add(frusta);
  }

  function setFrustaVisible(v) {
    frustaVisible = v;
    if (frusta) frusta.visible = v;
  }

  // Checkpoints can land faster than they decode; keep only the newest pending
  // one so the viewer never falls behind training.
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
      splat = discard(splat);
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
    pointCloud = discard(pointCloud);
    frusta = discard(frusta);
    splat = discard(splat);
    currentCheckpointUrl = null;
    nextUrl = null;
    loading = false;
    rig.resetView();
  }

  return { loadSparse, setCameras, setFrustaVisible, loadCheckpoint, reset };
}
