// A bow from a description: a stave bent along a line, its string, and whatever is tied to it.
//
//   bow({ seed, L, centre(x), thick(x), wide(x), sides, stations, paint(q), string, extra }) -> { tris, image, rig: "nearest" }
//
// x runs from tip to tip (-L to L); the back of the bow looks to +y and the string is on -y.
//   centre(x): where the middle of the stave is (y);  thick(x): its half thickness in the plane
//   of the bow;  wide(x): its half width across it (z);  stations: the x of each ring (0..L, mirrored)
//   paint(q):  q = { x, d (|x|), q (round the stave, 0..1: 0 its back, 0.5 its belly, which the
//              archer sees), light, seed }
//   string:    { x (where it is tied, from the middle), drop (how far under the stave there),
//              colour, r }
//   extra({ M, S, zone, seed, centre }): parts of its own, in what is left of the texture (1008 x 62)
// The texture is 1024x256.
//
// `rig: "nearest"`: in the game a bow is not one rigid thing. The middle of the string hangs
// from the bone that draws it and, in the finer originals, each limb from bones that bend it.
// Every corner of the new bow takes the bone of the original's nearest corner
// (as src/build.mjs does with `rig: "nearest"`), so it is drawn and bends as the original did.
import { sheet, shape, cylinderLight, times } from "../src/workshop.mjs";

const WIDTH = 1024, HEIGHT = 256;

export function bow(spec) {
  const S = sheet(WIDTH, HEIGHT), M = shape(WIDTH, HEIGHT), seed = spec.seed ?? 1, L = spec.L;
  const Z = { stave: { x: 8, y: 8, w: 1008, h: 150 }, string: { x: 8, y: 168, w: 1000, h: 8 }, extra: { x: 8, y: 186, w: 1008, h: 62 } };
  const px = (Z.stave.w - 4) / (2 * L), slope = (x) => (spec.centre(x + 0.05) - spec.centre(x - 0.05)) / 0.1;
  const half = [...new Set((spec.stations ?? Array.from({ length: 14 }, (_, i) => L * i / 13)).map((x) => +Math.min(L, Math.abs(x)).toFixed(3)))].sort((a, b) => a - b);
  const xs = [...half.filter((x) => x > 0).map((x) => -x).reverse(), ...half];
  // the section leans with the stave: without it the bow thins where it slopes most
  M.lathe(xs.map((x) => [x, 1]), Z.stave, { sides: spec.sides ?? 8, px, caps: [true, true],
    at: (s, p, q) => [s, spec.centre(s) + p * spec.thick(s) * Math.min(1.6, Math.hypot(1, slope(s))), q * spec.wide(s)] });
  S.zone(Z.stave, (u, v) => { const x = Math.min(L, Math.max(-L, -L + u / px)), q = Math.min(1, Math.max(0, v / Z.stave.h)); return spec.paint({ x, d: Math.abs(x), q, light: cylinderLight(q, 0.36), seed }); });

  // the string: from each tip to its middle
  const st = spec.string, r = st.r ?? 0.07, yEnd = spec.centre(st.x) - st.drop, yMid = st.mid ?? yEnd;
  const corner = (x, y, k) => M.V([x + (k === 0 || k === 3 ? -r : r) * 0.3, y + (k < 2 ? r : -r), k === 1 || k === 2 ? r : -r], [0, 0]);
  for (const side of [-1, 1]) {
    const xa = side * st.x, run = Math.min(Z.string.w, Math.hypot(xa, yEnd - yMid) * 40), A = [0, 1, 2, 3].map((k) => corner(xa, yEnd, k)), B = [0, 1, 2, 3].map((k) => corner(0, yMid, k));
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4, v0 = Z.string.y + (k % 2 ? 1 : 5), v1 = Z.string.y + (k % 2 ? 5 : 1);
      M.quad({ ...A[k], t: [Z.string.x, v0] }, { ...B[k], t: [Z.string.x + run, v0] }, { ...B[k2], t: [Z.string.x + run, v1] }, { ...A[k2], t: [Z.string.x, v1] }, [xa / 2, (yEnd + yMid) / 2, 0]);
    }
  }
  S.zone(Z.string, (u, v) => times(st.colour ?? [0.62, 0.57, 0.46], 0.75 + 0.15 * Math.sin(u * 0.9 + v) + 0.25 * (v < 4 ? 1 : 0)), 2);

  if (spec.extra) spec.extra({ M, S, zone: Z.extra, seed, centre: spec.centre });
  return { tris: M.tris, image: S.image(), rig: "nearest" };
}

/** A line through points [[x, y], ...] (x rising), smooth between them; `x` beyond the ends keeps the end's value. */
export function through(points) {
  return (x) => {
    const d = Math.abs(x); let i = 1; while (i < points.length - 1 && points[i][0] < d) i++;
    const [x0, y0] = points[i - 1], [x1, y1] = points[i], t = Math.min(1, Math.max(0, (d - x0) / (x1 - x0)));
    // the slope at each point: that of its two neighbours (a Catmull-Rom spline)
    const m = (j) => { const a = points[Math.max(0, j - 1)], b = points[Math.min(points.length - 1, j + 1)]; return (b[1] - a[1]) / (b[0] - a[0] || 1); };
    const h = x1 - x0, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * h * m(i - 1) + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * h * m(i);
  };
}
