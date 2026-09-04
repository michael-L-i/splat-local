import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const path = relative => fileURLToPath(new URL(relative, import.meta.url));
export default defineConfig({
  base: './',
  build: { target: 'esnext' },
  optimizeDeps: { include: ['@techstark/opencv-js', 'ml-matrix'] },
  plugins: [{
    name: 'browser-assets', apply: 'build',
    buildStart() {
      if (!process.env.SPLAT_JS_ONLY && !existsSync(path('./public/brush/brush_js_bg.wasm'))) {
        throw new Error('Brush WASM is missing. Run npm run build:brush first.');
      }
    },
    generateBundle() {
      for (const [name, source] of Object.entries({
        opencv: './node_modules/@techstark/opencv-js/LICENSE',
        matrix: './node_modules/ml-matrix/LICENSE',
        three: '../vendor/three/LICENSE', spark: '../vendor/spark/LICENSE',
      })) this.emitFile({ type: 'asset', fileName: `licenses/${name}.txt`, source: readFileSync(path(source), 'utf8') });
    },
  }],
  resolve: { alias: [
    { find: 'three/addons/controls/OrbitControls.js', replacement: path('../vendor/three/OrbitControls.js') },
    { find: 'three/addons/postprocessing/Pass.js', replacement: path('../vendor/three/Pass.js') },
    { find: /^three$/, replacement: path('../vendor/three/three.module.min.js') },
    { find: '@sparkjsdev/spark', replacement: path('../vendor/spark/spark.module.min.js') },
    { find: 'splat-viewer', replacement: path('../viewer') },
  ] },
  worker: { format: 'es' },
  server: { fs: { allow: [path('..')] } },
});
