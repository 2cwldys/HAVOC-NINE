// geo.mjs: plan geometry New Byzantium's pieces share: the four frames an avenue's piece is drawn in, regular
// octagons, and convex outlines cut by straight lines.

// local u runs out from the well along the avenue, v across it (v > 0 east for the north one)
export const FRAMES = {
  n: { p: (u, v) => [v, u], dir: { "+u": "+y", "-u": "-y", "+v": "+x", "-v": "-x" }, face: { "+u": "n", "-u": "s", "+v": "e", "-v": "w" } },
  e: { p: (u, v) => [u, -v], dir: { "+u": "+x", "-u": "-x", "+v": "-y", "-v": "+y" }, face: { "+u": "e", "-u": "w", "+v": "s", "-v": "n" } },
  s: { p: (u, v) => [-v, -u], dir: { "+u": "-y", "-u": "+y", "+v": "-x", "-v": "+x" }, face: { "+u": "s", "-u": "n", "+v": "w", "-v": "e" } },
  w: { p: (u, v) => [-u, v], dir: { "+u": "-x", "-u": "+x", "+v": "+y", "-v": "-y" }, face: { "+u": "w", "-u": "e", "+v": "n", "-v": "s" } },
};
/** A local box [u0, v0, z0, u1, v1, z1] as a world box. */
export function fbox(f, [u0, v0, z0, u1, v1, z1]) {
  const a = f.p(u0, v0);
  const b = f.p(u1, v1);
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), z0, Math.max(a[0], b[0]), Math.max(a[1], b[1]), z1];
}
/** The compass word for a face letter: the way a sign on it looks. */
export const COMPASS = { n: "north", s: "south", e: "east", w: "west" };

const T = (a) => Math.round(a * 0.414214);
/** A regular octagon whose flat sides stand `a` from the middle, along the axes and the diagonals. */
export const octagon = (a, [cx, cy] = [0, 0]) =>
  [[a, T(a)], [T(a), a], [-T(a), a], [-a, T(a)], [-a, -T(a)], [-T(a), -a], [T(a), -a], [a, -T(a)]].map(([x, y]) => [cx + x, cy + y]);

/** The side of a line [a, b, c] (a x + b y + c >= 0) a convex outline keeps: Sutherland-Hodgman, one line. */
function clipLine(poly, [a, b, c]) {
  const out = [];
  const side = (p) => a * p[0] + b * p[1] + c;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const sp = side(p);
    const sq = side(q);
    if (sp >= 0) out.push(p);
    if ((sp >= 0) !== (sq >= 0)) {
      const t = sp / (sp - sq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  // the corners cut exactly, and none twice
  const clean = out.map((p) => p.map((v) => Math.round(v * 1000) / 1000));
  return clean.filter((p, i) => {
    const q = clean[(i + 1) % clean.length];
    return Math.abs(p[0] - q[0]) > 1e-6 || Math.abs(p[1] - q[1]) > 1e-6;
  });
}
/** Half-planes to cut with: x >= v, x <= v, y >= v, y <= v. */
export const H = {
  xge: (v) => [1, 0, -v],
  xle: (v) => [-1, 0, v],
  yge: (v) => [0, 1, -v],
  yle: (v) => [0, -1, v],
};
/** A convex outline cut by every half-plane given; null when nothing (or no area) is left. */
export function cut(poly, ...lines) {
  let p = poly;
  for (const l of lines) {
    p = clipLine(p, l);
    if (p.length < 3) return null;
  }
  let area = 0;
  for (let i = 0; i < p.length; i++) area += p[i][0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * p[i][1];
  return Math.abs(area) / 2 > 64 ? p : null;
}
/** A rectangle [x0, y0, x1, y1] as an outline. */
export const rect = ([x0, y0, x1, y1]) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
/** An outline's bounding box [x0, y0, x1, y1]. */
export function boundsOf(outline) {
  const xs = outline.map((p) => p[0]);
  const ys = outline.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
