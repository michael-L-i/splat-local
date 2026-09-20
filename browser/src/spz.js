import { transcodeSpz } from '@sparkjsdev/spark';

// SPZ quantizes and gzips the same splats, typically 10x smaller than the PLY.
export async function plyToSpz(blob) {
  const { fileBytes } = await transcodeSpz({ inputs: [{ fileBytes: new Uint8Array(await blob.arrayBuffer()), fileType: 'ply' }] });
  return new Blob([fileBytes], { type: 'application/octet-stream' });
}
