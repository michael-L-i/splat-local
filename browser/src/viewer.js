import * as THREE from 'three';
import { SplatMesh } from '@sparkjsdev/spark';
import { createRig } from 'splat-viewer/core.js';
import { nerfTransform } from './geometry.js';

export function createViewer(canvas) {
  const rig = createRig(canvas);
  let mesh;
  const clear = () => {
    if (mesh) { rig.world.remove(mesh); mesh.dispose(); mesh = null; }
    rig.invalidate();
  };
  async function loadSplat(url, reconstruction) {
    clear();
    mesh = new SplatMesh({ url, fileType: 'ply' });
    await mesh.initialized;
    rig.world.add(mesh);
    const transform = new THREE.Matrix4().set(...nerfTransform(reconstruction.frames[0].pose).flat());
    rig.world.updateMatrixWorld();
    transform.premultiply(rig.world.matrixWorld);
    transform.decompose(rig.camera.position, rig.camera.quaternion, new THREE.Vector3());
    rig.camera.up.set(0, 1, 0).applyQuaternion(rig.camera.quaternion);
    rig.camera.fov = 360 / Math.PI * Math.atan(reconstruction.camera.height / (2 * reconstruction.camera.f));
    rig.camera.near = 0.01; rig.camera.far = 1000;
    rig.camera.updateProjectionMatrix();
    rig.controls.target.copy(rig.camera.position).add(rig.camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(3));
    rig.controls.update();
    rig.invalidate();
  }
  return { clear, loadSplat };
}
