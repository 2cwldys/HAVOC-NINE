// A blunt weapon from a description: a haft and the turned parts on it (a head, its spikes,
// collars, caps): maces, hammers, mauls, clubs, bats.
//
//   blunt({ seed, haft, parts, rings }) -> { tris, image, haft: true }
//
// The haft runs along x from the butt (y = z = 0 is its middle: src/fit.mjs lays
// that line on the original's handle).
//   haft:  as in axekit.mjs: { profile, flatten, sides, tone, paint(q), parts: [bound stretches] }
//   parts: [{ profile: [[s, radius], ...], sides, flatten, twist, caps: [start, end] (flat ends),
//             at(s, a, b) (where it stands: along x unless told; `toward` makes one),
//             copies: [at, ...] (the same part several times, one drawing: spikes, studs),
//             metal, paint(q), cap(q) (its flat ends), veins(q) (what glows in the game, on black;
//             `still`: it glows without moving), px (pixels a unit), h (pixels round it) }]
//          `q` of paint: { x (along its axis), q (round it, 0..1), a, b (the same in units), r,
//          face, f (across the face, 0..1), edge (1 on the edge between two faces), light, seed, metal }
//          `q` of cap:   { u, v (-1..1 across the end), d (0 in its middle, 1 on its rim), end, r, light, seed, metal }
//          A part of six sides or fewer is faceted: each face has a light of its own and bright edges.
//   rings: [{ x, y, radius, tube, sides, metal }]     a ring lying flat, at the butt
// The texture is 1024x512, or 1024x1024 when a part has veins: what glows is drawn again in
// the lower half, on a skin just over the part. The parts find their own room in it.
import { sheet, shape, wood, cylinderLight, bell } from "../src/workshop.mjs";
import { METALS } from "./swordkit.mjs";
import { wrap } from "./axekit.mjs";

const WIDTH = 1024, SKIN = 0.06, GAP = 9;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const metalOf = (m) => (typeof m === "function" ? m : METALS[m ?? "steel"]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(...a) || 1; return a.map((v) => v / l); };

/** Where a part stands when its axis starts at `o` and runs towards `d`: an `at` for it. */
export function toward(o, d) {
  const D = unit(d), A = unit(cross(Math.abs(D[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], D)), B = cross(D, A);
  return (s, a, b) => [0, 1, 2].map((k) => o[k] + D[k] * s + A[k] * a + B[k] * b);
}

export function blunt(spec) {
  const parts = spec.parts ?? [], rings = spec.rings ?? [], veined = parts.some((p) => p.veins), HEIGHT = veined ? 1024 : 512;
  const S = sheet(WIDTH, HEIGHT, veined ? [0, 0, 0] : undefined), M = shape(WIDTH, HEIGHT), seed = spec.seed ?? 1;

  // ── the haft ──
  const runOf = (pr) => { let run = 0; const runs = pr.map(([x, r], i) => (i ? (run += Math.hypot(x - pr[i - 1][0], r - pr[i - 1][1])) : 0)); return { run, runs }; };
  /** Where a point of the strip is on the profile: its place along the axis and the radius there. */
  const along = (pr, runs, u) => { let i = 1; while (i < runs.length - 1 && runs[i] < u) i++; const k = clamp((u - runs[i - 1]) / (runs[i] - runs[i - 1] || 1), 0, 1); return [pr[i - 1][0] + (pr[i][0] - pr[i - 1][0]) * k, pr[i - 1][1] + (pr[i][1] - pr[i - 1][1]) * k]; };
  const h = spec.haft;
  if (h) {
    const bound = h.parts ?? [], { run, runs } = runOf(h.profile), zone = { x: 8, y: 8, w: 1008, h: 56 }, px = Math.min(24, (zone.w - 2) / run);
    M.lathe(h.profile, zone, { sides: h.sides ?? 8, flatten: h.flatten ?? 1, px, caps: h.caps ?? [true, true], at: h.at });
    S.zone(zone, (u, v) => {
      const [x] = along(h.profile, runs, clamp(u / px, 0, run)), q = clamp(v / zone.h, 0, 1), light = cylinderLight(q), p = bound.find((r) => x >= r.from && x <= r.to);
      if (p) return wrap(p, x - p.from, q, light * (1 - 0.35 * bell(x - p.from, 0.12) - 0.35 * bell(x - p.to, 0.12)), seed + 60 + bound.indexOf(p) * 5);
      let shade = 1; for (const r of bound) shade -= 0.3 * (bell(x - r.from, 0.18) + bell(x - r.to, 0.18));
      return h.paint ? h.paint({ x, q, light: light * shade, seed }) : wood(x, q * 3.2, light * shade * 1.15, seed + 41, h.tone);
    });
  }

  // ── the room each part asks for in the texture, and where it gets it ──
  const asks = [];
  const measured = parts.map((p, i) => {
    const pr = p.profile, { run, runs } = runOf(pr), rmax = Math.max(...pr.map((q) => q[1])), px = p.px ?? 12, sides = p.sides ?? 8, girth = 2 * Math.PI * rmax * (1 + (p.flatten ?? 1)) / 2;
    const m = { p, pr, run, runs, px, sides, girth, twist: p.twist ?? (sides === 4 ? Math.PI / 4 : 0), zone: { w: Math.ceil(run * px) + 2, h: p.h ?? Math.round(clamp(girth * px * 0.55, 20, 150)) }, caps: [null, null], seed: seed + 100 + i * 7 };
    asks.push(m.zone);
    (p.caps ?? [false, false]).forEach((c, e) => { if (!c) return; const side = Math.ceil(2 * pr[e ? pr.length - 1 : 0][1] * (p.capPx ?? px * 1.3)); asks.push(m.caps[e] = { w: side, h: Math.max(8, Math.round(side * (p.flatten ?? 1))) }); });
    return m;
  });
  const ringZones = rings.map(() => { const z = { w: 150, h: 34 }; asks.push(z); return z; });
  let x = 8, y = 76, shelf = 0;
  for (const z of [...asks].sort((a, b) => b.h - a.h)) {
    if (x + z.w > WIDTH - 8) { x = 8; y += shelf + GAP; shelf = 0; }
    if (y + z.h > 504) throw new Error("bluntkit: the parts do not fit in the texture (lower some `px`)");
    z.x = x; z.y = y; x += z.w + GAP; shelf = Math.max(shelf, z.h);
  }

  // ── the parts ──
  for (const { p, pr, run, runs, px, sides, girth, twist, zone, caps, seed: sd } of measured) {
    const metal = metalOf(p.metal), faceted = p.faceted ?? sides <= 6, flatten = p.flatten ?? 1;
    for (const at of p.copies ?? [p.at]) {
      M.lathe(pr, zone, { sides, flatten, px, twist, at, caps: caps.map((c) => c ?? false) });
      if (p.veins) {
        const before = M.tris.length;
        M.lathe(pr.map(([s, r]) => [s, r > 0 ? r + SKIN : r]), { ...zone, y: zone.y + 512 }, { sides, flatten, px, twist, at });
        for (const t of M.tris.slice(before)) { t.glow = true; if (!p.still) t.flow = true; }
      }
    }
    const point = (u, v) => {
      const [xx, r] = along(pr, runs, clamp(u / px, 0, run)), q = clamp(v / zone.h, 0, 1), fa = q * sides, face = Math.min(sides - 1, Math.floor(fa)), f = fa - face;
      const edge = faceted ? bell(Math.min(f, 1 - f), 0.07) : 0;
      const light = faceted ? 0.8 + 0.2 * Math.cos(2 * Math.PI * (face + 0.5) / sides + twist - 1.0) + 0.28 * edge : cylinderLight(q, 0.5);
      return { x: xx, q, a: xx, b: q * girth, r, face, f, edge, light, seed: sd, metal };
    };
    S.zone(zone, (u, v) => { const q = point(u, v); return p.paint ? p.paint(q) : metal(q.a * 1.5, q.b * 1.5, q.light, sd); });
    if (p.veins) S.zone({ ...zone, y: zone.y + 512 }, (u, v) => p.veins(point(u, v)), 3);
    caps.forEach((c, end) => {
      if (!c) return;
      const r = pr[end ? pr.length - 1 : 0][1], k = Math.cos(Math.PI / sides);
      S.zone(c, (u, v) => {
        const u0 = (u - c.w / 2) / (c.w / 2), v0 = (v - c.h / 2) / (c.h / 2), q = { u: u0 / k, v: v0 / k, d: sides === 4 ? Math.max(Math.abs(u0), Math.abs(v0)) / k : Math.hypot(u0, v0) / k, end, r, light: 1, seed: sd + 3 + end, metal };
        return p.cap ? p.cap(q) : metal(q.u * r * 1.5, q.v * r * 1.5, 1.05 - 0.3 * bell(q.d - 1, 0.2), q.seed);
      });
    });
  }
  rings.forEach((r, i) => {
    const zone = ringZones[i], n = r.sides ?? 8, m = 6, tube = r.tube ?? 0.25, metal = metalOf(r.metal), cy = r.y ?? 0;
    const corner = (a, j) => { const th = 2 * Math.PI * a / n + Math.PI / n, ph = 2 * Math.PI * j / m, d = r.radius + tube * Math.cos(ph); return M.V([r.x + d * Math.cos(th), cy + d * Math.sin(th), tube * Math.sin(ph)], [zone.x + zone.w * a / n, zone.y + zone.h * j / m]); };
    for (let a = 0; a < n; a++) for (let j = 0; j < m; j++) {
      const th = 2 * Math.PI * (a + 0.5) / n + Math.PI / n;
      M.quad(corner(a, j), corner(a + 1, j), corner(a + 1, j + 1), corner(a, j + 1), [r.x + r.radius * Math.cos(th), cy + r.radius * Math.sin(th), 0]);
    }
    S.zone(zone, (u, v) => metal(u / 12, v / 12, 0.8 + 0.4 * Math.cos(2 * Math.PI * (v / zone.h - 0.2)), seed + 150 + i * 7));
  });
  return { tris: M.tris, image: S.image(), haft: true };
}
