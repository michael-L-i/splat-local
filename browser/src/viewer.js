import * as THREE from 'three';
import { SplatMesh } from '@sparkjsdev/spark';
import { createRig } from 'splat-viewer/core.js';
import { cameraPoint, nerfTransform } from './geometry.js';

export function createViewer(canvas) {
  const rig = createRig(canvas);
  let mesh, reconstruction, viewIndex = 0;
  const clear = () => {
    if (mesh) { rig.world.remove(mesh); mesh.dispose(); mesh = null; }
    rig.invalidate();
  };
  const showView = (index = 0) => {
    if (!reconstruction) return;
    viewIndex = (index + reconstruction.frames.length) % reconstruction.frames.length;
    const { pose } = reconstruction.frames[viewIndex];
    const transform = new THREE.Matrix4().set(...nerfTransform(pose).flat());
    rig.world.updateMatrixWorld();
    transform.premultiply(rig.world.matrixWorld);
    transform.decompose(rig.camera.position, rig.camera.quaternion, new THREE.Vector3());
    rig.camera.up.set(0, 1, 0).applyQuaternion(rig.camera.quaternion);
    rig.camera.fov = 360 / Math.PI * Math.atan(reconstruction.camera.height / (2 * reconstruction.camera.f));
    rig.camera.near = 0.01; rig.camera.far = 1000;
    rig.camera.updateProjectionMatrix();
    const depths = reconstruction.points.map(p => cameraPoint(pose, p.xyz)[2]).filter(z => z > 0).sort((a, b) => a-b);
    const distance = depths[Math.floor(depths.length/2)] || 3;
    rig.controls.target.copy(rig.camera.position).add(rig.camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(distance));
    rig.controls.update();
    rig.invalidate();
    return `View ${viewIndex+1} / ${reconstruction.frames.length}`;
  };
  async function loadSplat(url, scene) {
    const next = new SplatMesh({ url, fileType: 'ply' });
    try { await next.initialized; }
    catch (error) { next.dispose(); throw error; }
    clear(); mesh = next; reconstruction = scene;
    rig.world.add(mesh);
    showView();
  }
  return { clear, loadSplat, reset: () => showView(), move: delta => showView(viewIndex + delta) };
}
