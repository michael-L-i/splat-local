let runtime;
async function getRuntime() {
  if (runtime) return runtime;
  if (!navigator.gpu) throw new Error('WebGPU is unavailable. Use desktop Chrome or Edge on HTTPS or localhost.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter?.features.has('subgroups')) throw new Error('Brush requires a GPU/browser with WebGPU subgroups support.');
  const url = new URL(`${import.meta.env.BASE_URL}brush/brush_js.js`, location.href).href;
  const brush = await import(/* @vite-ignore */ url);
  await brush.default();
  const app = new brush.BrushApp();
  await app.init();
  runtime = { app, kinds: brush.BrushMessageKind };
  return runtime;
}

export async function train(dir, { steps, signal, progress }) {
  const { app, kinds } = await getRuntime();
  signal.throwIfAborted();
  const training = app.startTrainingFromDirectory(dir, async config => ({
    ...config, 'total-train-iters': steps, 'max-resolution': 768,
    'max-splats': 100000, 'sh-degree': 1, 'render-mode': 'default',
    'refine-every': 100, 'growth-stop-iter': Math.floor(steps * 0.8),
    'max-scene-batch-cache-size': 256 * 1024 ** 2,
    'eval-split-every': null, 'eval-every': steps + 1,
  }));
  let done = false;
  try {
    while (!done) {
      signal.throwIfAborted();
      const messages = await training.trainSteps(5);
      if (!messages.length) throw new Error('Brush ended before reporting successful training.');
      for (const message of messages) {
        try {
          if (message.kind === kinds.Warning) progress(`Brush: ${message.text}`);
          if (message.kind === kinds.TrainStep) progress(`Training ${message.iter}/${steps}`, message.iter / steps);
          if (message.kind === kinds.DoneTraining) done = true;
        } finally { message.free(); }
      }
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    signal.throwIfAborted();
    progress('Exporting trained splats…');
    const splats = training.currentSplats();
    if (!splats || !splats.numSplats) throw new Error('Brush produced no splats.');
    try {
      const bytes = await splats.exportPly();
      signal.throwIfAborted();
      return { blob: new Blob([bytes], { type: 'application/octet-stream' }), count: splats.numSplats };
    } finally { splats.free(); }
  } finally { training.free(); }
}
