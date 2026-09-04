function waitFor(target, event, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(event, done);
      target.removeEventListener('error', fail);
      signal.removeEventListener('abort', abort);
    };
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error('Cannot decode this video. Try an H.264 MP4.')); };
    const abort = () => { cleanup(); reject(signal.reason); };
    const timer = setTimeout(fail, 20000);
    target.addEventListener(event, done, { once: true });
    target.addEventListener('error', fail, { once: true });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

export async function extractFrames(file, { count = 24, maxSize = 768, signal, progress }) {
  if (file.size > 200 * 1024 ** 2) throw new Error('Prototype limit: videos up to 200 MB.');
  const video = document.createElement('video');
  const url = URL.createObjectURL(file);
  video.muted = true; video.preload = 'auto'; video.playsInline = true;
  try {
    const ready = waitFor(video, 'loadeddata', signal);
    video.src = url;
    await ready;
    if (!Number.isFinite(video.duration) || video.duration < 1 || video.duration > 60) throw new Error('Choose a video between 1 and 60 seconds.');
    const scale = Math.min(1, maxSize / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const frames = [];
    for (let i = 0; i < count; i++) {
      signal.throwIfAborted();
      const seeked = waitFor(video, 'seeked', signal);
      video.currentTime = video.duration * (i + 0.5) / count;
      await seeked;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.94));
      if (!blob) throw new Error('Could not encode a video frame.');
      frames.push({ image, blob });
      progress(`Decoded frame ${i + 1}/${count}`);
    }
    return frames;
  } finally { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }
}
