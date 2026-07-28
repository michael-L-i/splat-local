// Parses sparse point clouds off the main thread. The decode reads every
// property through a DataView closure per value, which on the 30-106 MB files
// this app produces stalls rendering for hundreds of milliseconds.
import { parsePLY } from "./ply.js";

self.onmessage = ({ data }) => {
  try {
    const { positions, colors, count } = parsePLY(data.buffer);
    self.postMessage({ positions, colors, count }, [positions.buffer, colors.buffer]);
  } catch (e) {
    self.postMessage({ error: e.message || String(e) });
  }
};
