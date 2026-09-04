import { extractFrames } from './frames.js';
import { writeDataset } from './dataset.js';
import { train } from './train.js';
import { presets } from './quality.js';

const $ = id => document.getElementById(id);
let aborter, viewer, downloadURL, reportURL, sourceURL, stage = 0;
const log = text => {
  const step = text.match(/^Training (\d+)\//);
  if (step && Number(step[1]) % 25 !== 0) return;
  $('status').textContent = text;
  if (!step || Number(step[1]) % 100 === 0) {
    $('log').textContent += `${text}\n`;
    $('log').scrollTop = $('log').scrollHeight;
  }
};
function setStage(index) {
  stage = index; $('progress').value = index / 4;
  document.querySelectorAll('#stages li').forEach((item, i) => {
    item.dataset.state = i < index ? 'done' : i === index ? 'active' : '';
    if (i === index) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  });
}
const progress = (text, fraction = 0) => { $('progress').value = (stage + fraction) / 4; log(text); };
const settings = () => ({ ...presets[$('quality').value], frames: Number($('frames').value), steps: Number($('steps').value), selectSharp: $('sharp').checked, evaluate: $('evaluate').checked });
const describeQuality = () => {
  const { frames, steps, resolution } = settings();
  $('quality-info').textContent = `${frames} frames · ${resolution} px · ${steps.toLocaleString()} steps. Speed depends on your GPU.`;
};
$('quality').onchange = () => {
  const preset = presets[$('quality').value];
  $('frames').value = preset.frames; $('steps').value = preset.steps;
  describeQuality();
};
$('frames').onchange = $('steps').onchange = describeQuality;
describeQuality();
$('video').onchange = () => {
  URL.revokeObjectURL(sourceURL);
  const file = $('video').files[0];
  $('source').hidden = !file;
  $('source').removeAttribute('src');
  if (file) {
    sourceURL = URL.createObjectURL(file); $('source').src = sourceURL;
    $('file-info').textContent = `${file.name} · ${(file.size / 1024**2).toFixed(1)} MB`;
  } else $('file-info').textContent = '1–60 seconds · up to 200 MB';
};
$('reset-view').onclick = () => { $('camera-view').textContent = viewer.reset(); };
$('previous-view').onclick = () => { $('camera-view').textContent = viewer.move(-1); };
$('next-view').onclick = () => { $('camera-view').textContent = viewer.move(1); };
window.addEventListener('beforeunload', event => {
  if (aborter) { event.preventDefault(); event.returnValue = ''; }
});

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
  if (aborter) return;
  aborter = new AbortController();
  const { signal } = aborter;
  const started = performance.now();
  let dataset, wakeLock;
  const timer = setInterval(() => { $('elapsed').textContent = `${Math.floor((performance.now()-started)/1000)} seconds elapsed · keep this tab open`; }, 1000);
  $('elapsed').hidden = false; $('elapsed').textContent = 'Starting…';
  $('source').pause();
  $('start').disabled = true; $('cancel').disabled = false;
  document.querySelectorAll('input, select').forEach(input => { input.disabled = true; });
  $('status').removeAttribute('data-error'); $('log').textContent = '';
  $('result-title').textContent = downloadURL ? 'Previous result · creating a new scene' : 'Creating your scene';
  setStage(0);
  try {
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* Optional; not available in every browser. */ }
    signal.throwIfAborted();
    const options = settings(), { frames: count, steps } = options;
    const frames = await extractFrames($('video').files[0], { count, maxSize: options.resolution, selectSharp: options.selectSharp, signal, progress });
    const samples = frames.map(({ time, sharpness }) => ({ time, sharpness }));
    const { width, height } = frames[0].image;
    const camera = { width, height, f: $('fov').value === 'auto' ? null : width / (2 * Math.tan(Number($('fov').value) * Math.PI / 360)) };
    log('Recovering camera positions…');
    setStage(1);
    const scene = await reconstruct(frames.map(f => f.image), camera, signal);
    log(`Reconstruction accepted: ${scene.report.registered}/${count} cameras; ${scene.report.fov.toFixed(0)}° lens; median error ${scene.report.medianError.toFixed(2)} px`);
    dataset = await writeDataset(scene, frames, signal);
    frames.length = 0;
    log('Loading Brush WebGPU trainer…');
    setStage(2);
    const result = await train(dataset.dir, { ...options, signal, progress });
    signal.throwIfAborted();
    $('cancel').disabled = true;
    URL.revokeObjectURL(downloadURL); URL.revokeObjectURL(reportURL);
    downloadURL = URL.createObjectURL(result.blob);
    $('download').href = downloadURL; $('download').hidden = false;
    const report = { ...scene.report, camera: scene.camera, settings: options, samples, steps, splats: result.count, validation: result.validation, seconds: (performance.now() - started) / 1000, experimental: true };
    reportURL = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    $('report').href = reportURL; $('report').hidden = false;
    $('result').hidden = false;
    $('stats').textContent = `${result.count.toLocaleString()} splats · ${scene.report.registered}/${count} cameras · ${scene.report.medianError.toFixed(2)} px camera error`;
    $('result-title').textContent = 'Your reconstruction';
    setStage(3);
    log(`Training complete: ${result.count.toLocaleString()} splats. Loading preview…`);
    try {
      viewer ??= (await import('./viewer.js')).createViewer($('viewer'));
      $('scene').style.setProperty('--aspect', width / height);
      await viewer.loadSplat(downloadURL, scene);
      $('reset-view').disabled = false;
      $('previous-view').disabled = $('next-view').disabled = false;
      $('camera-view').textContent = `View 1 / ${scene.frames.length}`;
      $('empty').hidden = true;
      setStage(4);
      log(`Complete · ${result.count.toLocaleString()} splats · ${report.seconds.toFixed(0)} seconds`);
    } catch (error) {
      $('result-title').textContent = 'New download ready · preview unavailable';
      viewer?.clear(); $('reset-view').disabled = true;
      $('previous-view').disabled = $('next-view').disabled = true;
      $('empty').hidden = false;
      $('empty').querySelector('h2').textContent = 'Your download is ready.';
      $('empty').querySelector('p').textContent = 'The preview could not load. Open the PLY in a splat viewer.';
      log(`Training complete. Preview failed: ${error.message}. You can still download the PLY.`);
    }
  } catch (error) {
    setStage(-1); $('progress').value = 0;
    $('result-title').textContent = downloadURL ? 'Previous result · kept safe' : 'Your workspace';
    if (!signal.aborted) $('status').setAttribute('data-error', '');
    const message = error.message || String(error);
    log(signal.aborted ? 'Cancelled. No partial splat exported.' : /device.*lost|out.of.memory|allocation failed/i.test(message)
      ? 'The GPU ran out of resources or disconnected. Reload this page and try Quick preview.' : message);
  } finally {
    clearInterval(timer); $('elapsed').textContent = `${Math.floor((performance.now()-started)/1000)} seconds elapsed`;
    await wakeLock?.release().catch(() => {});
    try { await dataset?.cleanup(); } catch (error) { $('log').textContent += `Temporary-file cleanup failed: ${error.message}\n`; }
    $('start').disabled = false; $('cancel').disabled = true; aborter = null;
    document.querySelectorAll('input, select').forEach(input => { input.disabled = false; });
  }
};

try {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter?.features.has('subgroups') || !navigator.storage?.getDirectory) throw new Error('This prototype requires desktop Chrome/Edge with WebGPU subgroups and browser file storage.');
  log('Ready. Choose a short video to begin.');
  $('start').disabled = false;
} catch (error) { log(error.message); $('start').disabled = true; $('status').setAttribute('data-error', ''); }
