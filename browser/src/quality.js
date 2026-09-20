export const presets = {
  fast: { frames: 24, steps: 2000, resolution: 768, maxSplats: 100000, shDegree: 1 },
  balanced: { frames: 32, steps: 5000, resolution: 960, maxSplats: 200000, shDegree: 2 },
  detailed: { frames: 48, steps: 10000, resolution: 1024, maxSplats: 300000, shDegree: 2 },
};

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

// Small block-averaged luminance grid, mean-removed so exposure shifts do not read as motion.
export function thumbnail({ data, width, height }, size = 24) {
  const cols = Math.min(size, width), rows = Math.min(size, height), grid = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x0 = Math.floor(c * width / cols), x1 = Math.floor((c + 1) * width / cols);
    const y0 = Math.floor(r * height / rows), y1 = Math.floor((r + 1) * height / rows);
    let sum = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y*width+x)*4; sum += data[i] + 2*data[i+1] + data[i+2]; }
    grid[r*cols+c] = sum / (4 * (x1-x0) * (y1-y0));
  }
  const mean = grid.reduce((a, b) => a + b, 0) / grid.length;
  return grid.map(v => v - mean);
}
export const motion = (a, b) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0) / a.length;

// Choose `count` of the time-ordered candidates ({ sharpness, move }, where `move` is
// the image change since the previous candidate). Frames are spread evenly along a path
// that is mostly camera movement and partly time, so fast turns get more views and a
// paused camera fewer; within each slot the sharpest candidate wins. Frames much softer
// than their neighbours, or barely moved from the previous pick, are used only as a last resort.
export function selectFrames(candidates, count, { blur = 0.6, minGap = 0.35, window = 4 } = {}) {
  const n = candidates.length;
  if (n <= count) return candidates.map((_, i) => i);
  const total = candidates.reduce((sum, c, i) => sum + (i ? c.move : 0), 0);
  let travelled = 0;
  const position = candidates.map((c, i) => {
    if (i) travelled += c.move;
    return (total > 0 ? 0.7 * travelled / total : 0) + (total > 0 ? 0.3 : 1) * i / (n - 1);
  });
  const blurry = candidates.map((c, i) => {
    const near = candidates.slice(Math.max(0, i - window), i + window + 1).map(x => x.sharpness).sort((a, b) => a - b);
    return c.sharpness < blur * near[Math.floor(near.length / 2)];
  });
  const picked = [], used = new Set();
  for (let slot = 0; slot < count; slot++) {
    const low = slot / count, high = (slot + 1) / count, previous = picked.length ? position[picked.at(-1)] : -Infinity;
    const free = candidates.map((_, i) => i).filter(i => !used.has(i) && i > (picked.at(-1) ?? -1) && n - i >= count - slot);
    const inside = free.filter(i => position[i] >= low && (position[i] < high || slot === count - 1));
    const pool = [
      inside.filter(i => !blurry[i] && position[i] - previous >= minGap / count),
      inside.filter(i => !blurry[i]), inside,
    ].find(list => list.length);
    // An empty slot (one large jump in the footage) takes the nearest remaining frame.
    const choice = pool ? pool.reduce((a, b) => candidates[b].sharpness > candidates[a].sharpness ? b : a)
      : free.reduce((a, b) => Math.abs(position[b] - (low + high) / 2) < Math.abs(position[a] - (low + high) / 2) ? b : a);
    picked.push(choice); used.add(choice);
  }
  return picked;
}
