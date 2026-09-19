export const presets = {
  fast: { frames: 24, steps: 2000, resolution: 768, maxSplats: 100000, shDegree: 1 },
  balanced: { frames: 32, steps: 5000, resolution: 960, maxSplats: 200000, shDegree: 2 },
  detailed: { frames: 48, steps: 10000, resolution: 1024, maxSplats: 300000, shDegree: 2 },
};

// Automatic frame counts grow with clip length so consecutive views keep
// overlapping, within a bound that keeps matching and training tractable.
export const frameCount = (setting, duration, preset) =>
  setting === 'auto' ? Math.min(96, Math.max(preset.frames, Math.round(duration * 1.5))) : Number(setting);

// Variance of the luminance Laplacian; compare nearby frames, not different scenes.
export function sharpness({ data, width, height }) {
  const gray = i => (data[i*4] + 2*data[i*4+1] + data[i*4+2]) / 4;
  let sum = 0, squares = 0, count = 0;
  for (let y = 1; y < height-1; y += 2) for (let x = 1; x < width-1; x += 2) {
    const i = y*width+x, value = gray(i-1) + gray(i+1) + gray(i-width) + gray(i+width) - 4*gray(i);
    sum += value; squares += value*value; count++;
  }
  return count ? Math.max(0, squares/count - (sum/count)**2) : 0;
}
