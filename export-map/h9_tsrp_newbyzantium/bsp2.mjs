// bsp2.mjs: reads a compiled map in either format the compilers write: GoldSrc's version 30, or Xash's BSP2
// (the version word "BSP2"), which the whole city needs for its counts past 16-bit numbers.
//
// SMAK's readBsp reads version 30 only. A BSP2 file has the same fifteen lumps in the same order; only six of
// them are laid out wider (32-bit numbers, float bounds). So a copy of the file is read as version 30 for the
// lumps the two share, and those six are read again here in BSP2's own layout, into the same shapes readBsp
// gives, so everything that draws or walks a version 30 map works on the city as it is.
import { M } from "../lib.mjs";

const BSP2 = 0x32505342; // "BSP2", little-endian

const each = (bytes, lump, size, read) => {
  const out = [];
  for (let at = lump.offset; at + size <= lump.offset + lump.length; at += size) out.push(read(at));
  return out;
};
const floats3 = (b, at) => [b.readFloatLE(at), b.readFloatLE(at + 4), b.readFloatLE(at + 8)];

/** A map read from its bytes: what M.readBsp gives, for a version 30 file or a BSP2 one. */
export function readAnyBsp(bytes) {
  if (bytes.readInt32LE(0) !== BSP2) return M.readBsp(bytes);
  const copy = Buffer.from(bytes);
  copy.writeInt32LE(30, 0);
  const bsp = M.readBsp(copy);
  const b = copy;
  const L = bsp.lumps;
  // dnode2_t: planenum, children[2], float mins[3], float maxs[3], firstface, numfaces (44 bytes)
  bsp.nodes = each(b, L.nodes, 44, (at) => ({
    plane: b.readInt32LE(at),
    children: [b.readInt32LE(at + 4), b.readInt32LE(at + 8)],
    mins: floats3(b, at + 12),
    maxs: floats3(b, at + 24),
    firstFace: b.readInt32LE(at + 36),
    faceCount: b.readInt32LE(at + 40),
  }));
  // dleaf2_t: contents, visofs, float mins[3], float maxs[3], firstmarksurface, nummarksurfaces, ambient[4] (44)
  bsp.leaves = each(b, L.leaves, 44, (at) => ({
    contents: b.readInt32LE(at),
    visOffset: b.readInt32LE(at + 4),
    mins: floats3(b, at + 8),
    maxs: floats3(b, at + 20),
    firstMarkSurface: b.readInt32LE(at + 32),
    markSurfaceCount: b.readInt32LE(at + 36),
    ambient: [...b.subarray(at + 40, at + 44)],
  }));
  // dface_t: planenum, side, firstedge, numedges, texinfo, styles[4], lightofs (28)
  bsp.faces = each(b, L.faces, 28, (at) => ({
    plane: b.readInt32LE(at),
    side: b.readInt32LE(at + 4),
    firstEdge: b.readInt32LE(at + 8),
    edgeCount: b.readInt32LE(at + 12),
    texinfo: b.readInt32LE(at + 16),
    styles: [...b.subarray(at + 20, at + 24)],
    lightOffset: b.readInt32LE(at + 24),
  }));
  bsp.edges = each(b, L.edges, 8, (at) => [b.readUInt32LE(at), b.readUInt32LE(at + 4)]);
  bsp.marksurfaces = each(b, L.marksurfaces, 4, (at) => b.readUInt32LE(at));
  bsp.clipnodes = each(b, L.clipnodes, 12, (at) => ({ plane: b.readInt32LE(at), children: [b.readInt32LE(at + 4), b.readInt32LE(at + 8)] }));
  bsp.bsp2 = true;
  return bsp;
}
