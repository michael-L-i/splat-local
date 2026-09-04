import { reconstruct } from './sfm.js';

self.onmessage = async ({ data: { images, camera } }) => {
  try {
    const result = await reconstruct(images, camera, text => self.postMessage({ text }));
    self.postMessage({ result });
  } catch (error) { self.postMessage({ error: error.message || String(error) }); }
};
