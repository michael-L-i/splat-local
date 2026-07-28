// The demo site's viewer: loads one finished splat and frames it well.
//
// Unlike the in-app viewer it never sees a sparse cloud, so it has to work out
// the framing from the splat itself — see fitToSplat. Scene setup, navigation
// and the frame loop come from the shared rig.
import * as THREE from "three";
import { SplatMesh } from "@sparkjsdev/spark";
import { createRig, LOD, percentile } from "splat-viewer/core.js";

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

export function createViewer(canvas, { idleSpin = false } = {}) {
  const rig = createRig(canvas, { idleSpin });
  const { world, camera, controls } = rig;

  let splat = null;

  // Frame the camera on a local-space (pre-flip) bounding box.
  function frameBox(min, max) {
    // world group is rotated 180deg about X: (x,y,z) -> (x,-y,-z)
    const cx = (min.x + max.x) / 2;
    const cy = -(min.y + max.y) / 2;
    const cz = -(min.z + max.z) / 2;
    const ex = Math.max(max.x - min.x, 0.05);
    const ey = Math.max(max.y - min.y, 0.05);
    const ez = Math.max(max.z - min.z, 0.05);
    rig.radius = Math.max(ex, ey, ez) / 2;

    // Back off along a fixed 3/4 direction, but never further than the box
    // itself: an interior walkthrough is enclosed, so an orbit-style camera at
    // 2.4x radius ends up outside the room staring through a wall. Clamping to
    // the box keeps rooms interior and still frames object-like scenes.
    // Distance is limited by the horizontal footprint only. Rooms are far
    // shorter than they are wide, so letting height into this clamp jams the
    // camera into the floor.
    const dir = new THREE.Vector3(0.55, 0.4, 0.75).normalize();
    const dist = Math.min(
      rig.radius * 2.4,
      Math.abs(ex * 0.5 / dir.x),
      Math.abs(ez * 0.5 / dir.z),
    );
    // Then keep the eye inside the room vertically, roughly at head height.
    const dy = Math.min(dir.y * dist, ey * 0.35);

    camera.position.set(cx + dir.x * dist, cy + dy, cz + dir.z * dist);
    camera.near = Math.max(rig.radius * 0.002, 0.001);
    camera.far = rig.radius * 60;
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

    const axis = (k) => {
      const a = new Array(n);
      for (let i = 0; i < n; i++) a[i] = pts[i * 3 + k];
      return a;
    };
    const centre = [axis(0), axis(1), axis(2)].map((c) => percentile(c, 0.5));

    const dist = new Array(n);
    for (let i = 0; i < n; i++) {
      dist[i] = Math.hypot(
        pts[i * 3] - centre[0], pts[i * 3 + 1] - centre[1], pts[i * 3 + 2] - centre[2],
      );
    }
    const keepRadius = percentile(dist.slice(), 0.75); // copy: dist is re-read by index below

    const kept = [[], [], []];
    for (let i = 0; i < n; i++) {
      if (dist[i] > keepRadius) continue;
      kept[0].push(pts[i * 3]);
      kept[1].push(pts[i * 3 + 1]);
      kept[2].push(pts[i * 3 + 2]);
    }
    if (kept[0].length < 8) return false;

    const lo = kept.map((c) => percentile(c, 0.02));
    const hi = kept.map((c) => percentile(c, 0.98));
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
    rig.resetView();
  }

  return { loadSplat, clear, stopSpin: rig.stopSpin };
}
