// Vectors, boxes and frames: the small arithmetic every other module shares.

// ── vectors ────────────────────────────────────────────────────────────────
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const unit = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const box = (points) => { const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9]; for (const p of points) for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], p[a]); mx[a] = Math.max(mx[a], p[a]); } return { mn, mx }; };
/** A frame { X, Y, Z, o }: a piece's own axes (+x its length, +y its width, +z its thickness) in some other space. */
export const out = (f, p) => [0, 1, 2].map((a) => f.o[a] + f.X[a] * p[0] + f.Y[a] * p[1] + f.Z[a] * p[2]);
export const into = (f, p) => { const d = sub(p, f.o); return [dot(d, f.X), dot(d, f.Y), dot(d, f.Z)]; };
export const uniq = (tris) => [...new Map(tris.flat().map((c) => [c.p.join(), c.p])).values()];
/** The two main directions of a cloud of weighted points [x, y, z, weight], and its centre. */
export function mainAxes(samples) {
  const total = samples.reduce((a, s) => a + s[3], 0), o = [0, 1, 2].map((a) => samples.reduce((s, p) => s + p[a] * p[3], 0) / total);
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of samples) { const d = sub(p, o); for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a][b] += p[3] * d[a] * d[b]; }
  const mul = (M, x) => M.map((r) => dot(r, x));
  const main = (M) => { let x = [0.31, 0.57, 0.76]; for (let k = 0; k < 400; k++) x = unit(mul(M, x)); return x; };
  const X = main(C), l1 = dot(X, mul(C, X));
  const e2 = main(C.map((r, a) => r.map((t, b) => t - l1 * X[a] * X[b])));
  return { X, Y: unit(sub(e2, X.map((t) => t * dot(e2, X)))), o };
}
