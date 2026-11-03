// The waist of ins_medic, measured so that a belt can follow the body instead of
// clipping through it.
//
//     node waist.mjs           prints the cross-sections
//     import { profile }       gives a radius(angle) to build against
//
// merc's body is 592 vertices for the whole figure, so a band of z holds only a
// dozen and fixed angle buckets come back mostly empty. Each radius below is
// therefore the furthest point within a +/-35 degree WINDOW, which fills the gaps
// at the cost of rounding off real corners -- right for a belt, which is a band
// round the outside and wants the rounding anyway.
//
// The limbs are excluded, as docs/PLAYER-MODELS.md warns: at belt height the widest
// thing in the band is the hands, at radius ~10.6 against the torso's ~6.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { K, POSE } from "./lib.mjs";

const base = readFileSync(join("..", "export-mdl", "ins_medic", "ins_medic.mdl"));
const surf = K.surface(base, POSE);
const N = 16, WINDOW = 35 * Math.PI / 180;

/** The raw measurement across a band of z: a centre, and `N` radii round it. */
export function section(z0, z1, trunkMax = 8.5) {
  const band = surf.filter((s) => s.p[2] >= z0 && s.p[2] < z1);
  if (band.length < 8) return null;
  const span = (k, ps) => { const v = ps.map((p) => p[k]); return [Math.min(...v), Math.max(...v)]; };

  // The centre comes from the bounding box, not the mean: the mean follows wherever
  // the vertices happen to be dense, which on this model is the front of the torso.
  // It is then settled on the trunk alone over a few passes, because the first box
  // still has the arms in it.
  let [x0, x1] = span(0, band.map((s) => s.p)), [y0, y1] = span(1, band.map((s) => s.p));
  let cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  for (let i = 0; i < 4; i++) {
    const t = band.filter((s) => Math.hypot(s.p[0] - cx, s.p[1] - cy) < trunkMax).map((s) => s.p);
    if (t.length < 8) break;
    [x0, x1] = span(0, t); [y0, y1] = span(1, t);
    cx = (x0 + x1) / 2; cy = (y0 + y1) / 2;
  }

  const trunk = band
    .filter((s) => Math.hypot(s.p[0] - cx, s.p[1] - cy) < trunkMax)
    .map((s) => ({ a: Math.atan2(s.p[1] - cy, s.p[0] - cx), r: Math.hypot(s.p[0] - cx, s.p[1] - cy) }));
  if (trunk.length < 8) return null;

  const ring = Array.from({ length: N }, (_, k) => {
    const a0 = 2 * Math.PI * k / N;
    let r = 0;
    for (const t of trunk) {
      let d = Math.abs(t.a - a0);
      if (d > Math.PI) d = 2 * Math.PI - d;
      if (d <= WINDOW && t.r > r) r = t.r;
    }
    return r;
  });
  return { cx, cy, ring, n: trunk.length };
}

/**
 * A radius(angle) for the band, with the gaps filled and the seams evened out.
 *
 * Gaps are real: a spoke with no vertex inside its window reads 0, and a belt built
 * straight off the raw ring would collapse to the body axis there.
 */
export function profile(z0, z1, trunkMax = 8.5) {
  const s = section(z0, z1, trunkMax);
  if (!s) throw new Error(`no surface to measure between z ${z0} and z ${z1}`);

  const r = s.ring.slice();
  for (let pass = 0; pass < N; pass++) {
    let settled = true;
    for (let k = 0; k < N; k++) {
      if (r[k] > 0) continue;
      const a = r[(k + N - 1) % N], b = r[(k + 1) % N];
      if (a > 0 && b > 0) r[k] = (a + b) / 2;
      else if (a > 0) r[k] = a;
      else if (b > 0) r[k] = b;
      else settled = false;
    }
    if (settled) break;
  }
  // Evening the seams must never pull a spoke IN. A plain average does: where the body
  // is widest the neighbours are narrower, so the peak gets shaved -- the measured 6.1
  // at his back quarters comes out 5.7, and a strap built on that is a tenth of a unit
  // inside his shirt all the way round the back. Smoothing fills the dips only.
  const sm = r.map((_, k) => Math.max(r[k], (r[(k + N - 1) % N] + 2 * r[k] + r[(k + 1) % N]) / 4));

  return {
    cx: s.cx, cy: s.cy, ring: sm, n: s.n,
    /** Radius at an angle in radians, read between the measured spokes. */
    at(a) {
      const t = ((a / (2 * Math.PI) * N) % N + N) % N, i = Math.floor(t), f = t - i;
      return sm[i] * (1 - f) + sm[(i + 1) % N] * f;
    },
  };
}

if (process.argv[1] && process.argv[1].includes("waist")) {
  for (const [z0, z1] of [[8, 11], [5, 8], [2, 7], [1, 4], [-1, 2], [-3, 0]]) {
    const s = section(z0, z1);
    if (!s) { console.log(`z ${String(z0).padStart(3)}..${String(z1).padStart(3)}  too few points`); continue; }
    console.log(`z ${String(z0).padStart(3)}..${String(z1).padStart(3)}  centre x ${s.cx.toFixed(2)} y ${s.cy.toFixed(2)}  n ${String(s.n).padStart(3)}  ` +
                `r ${s.ring.map((r) => r.toFixed(1).padStart(5)).join("")}`);
  }
  const p = profile(2, 7);
  console.log(`\nbelt band, filled and evened:  centre x ${p.cx.toFixed(2)} y ${p.cy.toFixed(2)}`);
  console.log(`r ${p.ring.map((r) => r.toFixed(1).padStart(5)).join("")}`);
  console.log("\nk=0 is +x (his front), k=4 is +y (his left), k=8 is -x (his back), k=12 is -y (his right)");
}
