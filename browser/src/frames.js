import { sharpness, thumbnail, motion, selectFrames } from './quality.js';

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

export async function extractFrames(file, { count = 24, maxSize = 768, selectSharp = true, signal, progress }) {
  if (!file?.size) throw new Error('Choose a non-empty video first.');
  if (file.size > 200 * 1024 ** 2) throw new Error('Choose a video smaller than 200 MB.');
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
    const seek = async time => {
      signal.throwIfAborted();
      const seeked = waitFor(video, 'seeked', signal);
      video.currentTime = time;
      await seeked;
    };
    let times = Array.from({ length: count }, (_, i) => video.duration * (i + 0.5) / count);
    if (selectSharp) {
      // Survey three times as many small frames, then keep sharp ones spread along the camera's movement.
      const small = document.createElement('canvas'), shrink = Math.min(1, 320 / Math.max(canvas.width, canvas.height));
      small.width = Math.round(canvas.width * shrink); small.height = Math.round(canvas.height * shrink);
      const survey = small.getContext('2d', { willReadFrequently: true }), candidates = [];
      for (let i = 0; i < count * 3; i++) {
        await seek(video.duration * (i + 0.5) / (count * 3));
        survey.drawImage(video, 0, 0, small.width, small.height);
        const image = survey.getImageData(0, 0, small.width, small.height), thumb = thumbnail(image);
        candidates.push({ time: video.currentTime, sharpness: sharpness(image), thumb, move: i ? motion(thumb, candidates[i-1].thumb) : 0 });
        progress(`Surveying video ${i + 1}/${count * 3}`, 0.6 * (i + 1) / (count * 3));
      }
      times = selectFrames(candidates, count).map(i => candidates[i].time);
    }
    const frames = [], base = selectSharp ? 0.6 : 0;
    for (let i = 0; i < times.length; i++) {
      await seek(times[i]);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.94));
      if (!blob) throw new Error('Could not encode a video frame.');
      frames.push({ image, sharpness: sharpness(image), time: video.currentTime, blob });
      progress(`Selected frame ${i + 1}/${count}`, base + (1 - base) * (i + 1) / count);
    }
    return frames;
  } finally { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }
}
