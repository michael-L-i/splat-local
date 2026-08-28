# SH-truncated preview checkpoints for the live stream.
#
# Brush's mid-training exports carry the full training state: 59 float
# properties per splat, 45 of them the f_rest_* SH bands — and all but 9 of
# those hold second- and third-order shading detail a resolving preview cannot
# show. On the high preset checkpoints reach ~110 MB by growth_stop and land
# every 1000 steps, and the browser re-downloads, re-parses and re-uploads
# each one whole.
#
# Truncating the stream to SH degree 1 keeps first-order view dependence and
# drops the rest: 59 properties become 23, a 2.56x cut in what every checkpoint
# costs to fetch and parse. Only the stream is touched — export and eval read
# Brush's original files, and the run ends on the full-SH scene.

import re
from pathlib import Path

import numpy as np

# (degree+1)^2 - 1 rest coefficients per channel at degree 1. Degree 0 would
# cut 4.2x but visibly flattens materials; degree 1 is where the preview stops
# looking different from the full scene in motion.
_KEEP_PER_CHANNEL = 3

_F_REST = re.compile(r"^f_rest_(\d+)$")


class PartialFile(Exception):
    """The file does not yet hold the bytes its header promises — Brush is
    still writing it. Retry on the next scan."""


def _parse_header(src: Path):
    """(data_offset, vertex_count, property_names, comments), or None when the
    layout is not the single-element all-float PLY Brush writes."""
    with src.open("rb") as f:
        head = f.read(8192)
    end = head.find(b"end_header\n")
    if end == -1:
        if len(head) < 8192:
            raise PartialFile(src.name)
        return None  # a header this long is not one we recognize
    offset = end + len(b"end_header\n")

    count, names, comments = None, [], []
    for line in head[:end].decode("ascii", "replace").splitlines():
        p = line.split()
        if not p:
            continue
        if p[0] == "format" and p[1] != "binary_little_endian":
            return None
        elif p[0] == "comment":
            comments.append(line.partition(" ")[2])
        elif p[0] == "element":
            if p[1] != "vertex" or count is not None:
                return None  # multiple elements: offsets no longer add up
            count = int(p[2])
        elif p[0] == "property":
            if p[1] != "float":
                return None
            names.append(p[2])
    if count is None or not names:
        return None
    return offset, count, names, comments


def write_preview(src: Path, dst: Path) -> bool:
    """Write an SH1 copy of the checkpoint at src to dst. False means src is
    not worth (or not safe) truncating and the caller should stream it as-is;
    PartialFile means src is still being written and the caller should retry."""
    parsed = _parse_header(src)
    if parsed is None:
        return False
    offset, count, names, comments = parsed

    rest = sorted((int(m.group(1)), i) for i, n in enumerate(names) if (m := _F_REST.match(n)))
    if [k for k, _ in rest] != list(range(len(rest))) or len(rest) % 3:
        return False
    per_channel = len(rest) // 3
    if per_channel <= _KEEP_PER_CHANNEL:
        return False  # already degree <= 1

    base = [i for i, n in enumerate(names) if not _F_REST.match(n)]
    # f_rest is channel-major (the INRIA convention; Brush's export.rs writes
    # red's rest band, then green's, then blue's), so degree 1 keeps the first
    # three coefficients of each channel's stripe — not f_rest_0..8.
    keep = base + [rest[c * per_channel + j][1]
                   for c in range(3) for j in range(_KEEP_PER_CHANNEL)]

    data = np.fromfile(src, dtype="<f4", offset=offset)
    if data.size < count * len(names):
        raise PartialFile(src.name)
    data = data[: count * len(names)].reshape(count, len(names))

    out_names = [names[i] for i in base] + [f"f_rest_{k}" for k in range(3 * _KEEP_PER_CHANNEL)]
    comments = ["SH degree: 1" if c.startswith("SH degree:") else c for c in comments]
    header = "\n".join([
        "ply",
        "format binary_little_endian 1.0",
        *(f"comment {c}" for c in comments),
        f"element vertex {count}",
        *(f"property float {n}" for n in out_names),
        "end_header",
        "",
    ])
    with dst.open("wb") as f:
        f.write(header.encode("ascii"))
        f.write(np.ascontiguousarray(data[:, keep]).tobytes())
    return True
