import { nerfTransform } from './geometry.js';

export function transforms(reconstruction) {
  const { camera: { width, height, f, k1 = 0, k2 = 0 }, frames } = reconstruction;
  return {
    w: width, h: height, fl_x: f, fl_y: f, cx: width / 2, cy: height / 2,
    camera_model: 'OPENCV', k1, k2, p1: 0, p2: 0, ply_file_path: 'points.ply',
    frames: frames.map(({ index, pose }) => ({ file_path: `images/${index}.jpg`, transform_matrix: nerfTransform(pose) })),
  };
}

export function sparsePly(points) {
  return 'ply\nformat ascii 1.0\nelement vertex ' + points.length + '\n' +
    ['float x', 'float y', 'float z', 'uchar red', 'uchar green', 'uchar blue'].map(p => `property ${p}\n`).join('') +
    'end_header\n' + points.map(({ xyz, rgb }) => [...xyz, ...rgb].join(' ')).join('\n') + '\n';
}

export async function writeDataset(reconstruction, frames, signal) {
  const root = await navigator.storage.getDirectory();
  const name = `splat-local-${crypto.randomUUID()}`;
  const cleanup = () => root.removeEntry(name, { recursive: true });
  const dir = await root.getDirectoryHandle(name, { create: true });
  const write = async (folder, name, data) => {
    signal.throwIfAborted();
    const file = await folder.getFileHandle(name, { create: true });
    const stream = await file.createWritable();
    try { await stream.write(data); await stream.close(); }
    catch (error) { await stream.abort(); throw error; }
  };
  try {
    const images = await dir.getDirectoryHandle('images', { create: true });
    for (const { index } of reconstruction.frames) await write(images, `${index}.jpg`, frames[index].blob);
    await write(dir, 'transforms.json', JSON.stringify(transforms(reconstruction)));
    await write(dir, 'points.ply', sparsePly(reconstruction.points));
    return { dir, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
