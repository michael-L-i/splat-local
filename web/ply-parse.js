// --- tiny inline PLY point-cloud parser: x,y,z + optional r,g,b -------------
// Supports ascii and binary_little_endian/big_endian, any property order.
//
// Lives in its own module so ply-worker.js can run it off the main thread.
export function parsePLY(buffer) {
  const SIZES = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2,
    int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };
  const head = new TextDecoder("ascii").decode(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 20000)));
  const end = head.indexOf("end_header");
  if (end === -1) throw new Error("not a PLY file");
  const headerEnd = end + "end_header\n".length;
  const lines = head.slice(0, end).split("\n").map((l) => l.trim()).filter(Boolean);

  let format = "ascii", count = 0, inVertex = false;
  const props = [];
  for (const line of lines) {
    const p = line.split(/\s+/);
    if (p[0] === "format") format = p[1];
    else if (p[0] === "element") { inVertex = p[1] === "vertex"; if (inVertex) count = +p[2]; }
    else if (p[0] === "property" && inVertex) props.push({ type: p[1], name: p[2] });
  }
  const find = (re) => props.findIndex((p) => re.test(p.name));
  const xi = find(/^x$/), yi = find(/^y$/), zi = find(/^z$/);
  const ri = find(/^(red|r)$/), gi = find(/^(green|g)$/), bi = find(/^(blue|b)$/);
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const setColor = (v, c) => colors.set(ri >= 0 ? [c[ri] / 255, c[gi] / 255, c[bi] / 255] : [0.72, 0.72, 0.72], v * 3);

  if (format === "ascii") {
    const rows = new TextDecoder("ascii").decode(buffer.slice(headerEnd)).trim().split("\n");
    for (let v = 0; v < count; v++) {
      const f = rows[v].trim().split(/\s+/).map(Number);
      positions.set([f[xi], f[yi], f[zi]], v * 3);
      setColor(v, f);
    }
  } else {
    const little = format === "binary_little_endian";
    const dv = new DataView(buffer, headerEnd);
    let o = 0;
    const readers = {
      float: () => dv.getFloat32(o, little), float32: () => dv.getFloat32(o, little),
      double: () => dv.getFloat64(o, little), float64: () => dv.getFloat64(o, little),
      uchar: () => dv.getUint8(o), uint8: () => dv.getUint8(o),
      char: () => dv.getInt8(o), int8: () => dv.getInt8(o),
      ushort: () => dv.getUint16(o, little), uint16: () => dv.getUint16(o, little),
      short: () => dv.getInt16(o, little), int16: () => dv.getInt16(o, little),
      uint: () => dv.getUint32(o, little), uint32: () => dv.getUint32(o, little),
      int: () => dv.getInt32(o, little), int32: () => dv.getInt32(o, little),
    };
    for (let v = 0; v < count; v++) {
      const vals = new Array(props.length);
      for (let p = 0; p < props.length; p++) { vals[p] = readers[props[p].type](); o += SIZES[props[p].type]; }
      positions.set([vals[xi], vals[yi], vals[zi]], v * 3);
      setColor(v, vals);
    }
  }
  return { positions, colors, count };
}
