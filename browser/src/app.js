import { extractFrames } from './frames.js';
import { writeDataset } from './dataset.js';
import { train } from './train.js';

const $ = id => document.getElementById(id);
let aborter, viewer, downloadURL, reportURL;
const log = text => {
  $('status').textContent = text;
  const step = text.match(/^Training (\d+)\//);
  if (!step || Number(step[1]) % 100 === 0) {
    $('log').textContent += `${text}\n`;
    $('log').scrollTop = $('log').scrollHeight;
  }
};

function reconstruct(images, camera, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./sfm-worker.js', import.meta.url), { type: 'module' });
    const stop = () => { worker.terminate(); signal.removeEventListener('abort', cancel); };
    const cancel = () => { stop(); reject(signal.reason); };
    worker.onmessage = ({ data }) => {
      if (data.text) log(data.text);
      if (data.result) { stop(); resolve(data.result); }
      if (data.error) { stop(); reject(new Error(data.error)); }
    };
    worker.onerror = event => { stop(); reject(new Error(event.message)); };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) { cancel(); return; }
    worker.postMessage({ images, camera }, images.map(image => image.data.buffer));
  });
}

$('cancel').onclick = () => { aborter?.abort(); log('Cancelling…'); };
$('form').onsubmit = async event => {
  event.preventDefault();
  aborter = new AbortController();
  const { signal } = aborter;
  const started = performance.now();
  let dataset;
  $('start').disabled = true; $('cancel').disabled = false;
  document.querySelectorAll('input, select').forEach(input => { input.disabled = true; });
  $('status').removeAttribute('data-error'); $('log').textContent = '';
  $('download').hidden = true; $('report').hidden = true;
  $('progress').removeAttribute('value');
  viewer?.clear(); $('empty').hidden = false;
  URL.revokeObjectURL(downloadURL); URL.revokeObjectURL(reportURL);
  try {
    const count = Number($('frames').value), steps = Number($('steps').value);
    const frames = await extractFrames($('video').files[0], { count, signal, progress: log });
    const { width, height } = frames[0].image;
    const camera = { width, height, f: $('fov').value === 'auto' ? null : width / (2 * Math.tan(Number($('fov').value) * Math.PI / 360)) };
    log('Recovering camera positions…');
    const scene = await reconstruct(frames.map(f => f.image), camera, signal);
    log(`Reconstruction accepted: ${scene.report.registered}/${count} cameras; ${scene.report.fov.toFixed(0)}° lens; median error ${scene.report.medianError.toFixed(2)} px`);
    dataset = await writeDataset(scene, frames, signal);
    frames.length = 0;
    log('Loading Brush WebGPU trainer…');
    const result = await train(dataset.dir, { steps, signal, progress: (text, fraction) => {
      if (fraction !== undefined) $('progress').value = fraction;
      log(text);
    } });
    signal.throwIfAborted();
    downloadURL = URL.createObjectURL(result.blob);
    $('download').href = downloadURL; $('download').hidden = false;
    const report = { ...scene.report, camera: scene.camera, steps, splats: result.count, seconds: (performance.now() - started) / 1000, experimental: true };
    reportURL = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    $('report').href = reportURL; $('report').hidden = false;
    $('progress').value = 1;
    log(`Training complete: ${result.count.toLocaleString()} splats. Loading preview…`);
    try {
      viewer ??= (await import('./viewer.js')).createViewer($('viewer'));
      await viewer.loadSplat(downloadURL, scene);
      $('empty').hidden = true;
      log(`Complete · ${result.count.toLocaleString()} splats · ${report.seconds.toFixed(0)} seconds`);
    } catch (error) { log(`Training complete. Preview failed: ${error.message}. You can still download the PLY.`); }
  } catch (error) {
    $('progress').value = 0;
    if (!signal.aborted) $('status').setAttribute('data-error', '');
    log(signal.aborted ? 'Cancelled. No partial splat exported.' : (error.message || String(error)));
  } finally {
    try { await dataset?.cleanup(); } catch (error) { log(`Browser temporary-file cleanup failed: ${error.message}`); }
    $('start').disabled = false; $('cancel').disabled = true; aborter = null;
    document.querySelectorAll('input, select').forEach(input => { input.disabled = false; });
  }
};

try {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter?.features.has('subgroups') || !navigator.storage?.getDirectory) throw new Error('This prototype requires desktop Chrome/Edge with WebGPU subgroups and browser file storage.');
  log('Ready. Choose a short video to begin.');
} catch (error) { log(error.message); $('start').disabled = true; $('status').setAttribute('data-error', ''); }
