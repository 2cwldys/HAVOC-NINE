// An axe from a description: a haft, the bits of its head and the turned fittings on it.
// Every axe made with it (a scythe too) shares one hand.
//
//   axe({ seed, haft, bits, turned, rings, extra }) -> { tris, image, haft: true }
//
// The haft runs along x from the butt (y = z = 0 is its middle: src/fit.mjs lays
// that line on the original's handle); the bits spread in y, their thickness is z.
//   haft:   { profile: [[x, radius], ...], flatten, sides, tone: [dark, light] (wood), paint(q),
//             parts: [{ from, to, kind: "leather" | "cord" | "ribbed" | "lattice" | "metal", colour, metal }] }
//   bits:   [{ x0, x1, edges(k) -> [lo, hi] (k: 0 at x0, 1 at x1; `hi` is the cutting edge, `lo`
//             the side towards the haft: inside it, or free where the bit hangs past its neck),
//             side: 1 | -1, mirror (both sides, one drawing), thick, thin, eye, bevel, metal,
//             edgeMetal, rust, tint, paint(q), veins(q) (what glows in the game, on black),
//             at(s, t, g, side) (to place it otherwise: the scythe's blade) }]
//   turned: [{ profile, sides, flatten, metal, paint(q), caps, at }]     sockets, collars, spikes, gems
//   rings:  [{ x, y, radius, tube, sides, metal }]                       a ring lying flat, at the butt
//   extra({ M, S, zone, seed })                                          parts of the piece's own
// Metals as in swordkit.mjs. The texture is 1024x512, or 1024x1024 when a bit has veins: what
// glows is drawn again in the lower half, on a skin just over the metal.
import { sheet, shape, steel, wood, leatherWrap, cylinderLight, times, mix, bell, step, fbm, noise } from "../src/workshop.mjs";
import { METALS } from "./swordkit.mjs";

const WIDTH = 1024, SKIN = 0.06;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v)), fract = (v) => v - Math.floor(v);
const metalOf = (m) => (typeof m === "function" ? m : METALS[m ?? "steel"]);

/** A bound stretch of a haft. `x` along it from where it starts, `q` around (0..1). */
export function wrap(p, x, q, light, seed) {
  if (p.kind === "metal") return metalOf(p.metal ?? "gunmetal")(x * 3, q * 4, light * 1.1, seed + 3);
  if (p.kind === "cord") {
    const a = fract(x * 1.5 + q * 2), c2 = fract(x * 1.5 - q * 2), over = a < 0.5 ? a : c2;
    return times(p.colour ?? [0.06, 0.06, 0.08], light * (0.65 + 0.75 * Math.sin(Math.PI * fract(over * 2)) ** 2) * (0.85 + 0.3 * noise(x * 40, q * 80, seed + 57)));
  }
  if (p.kind === "lattice") {
    const a = Math.abs(fract(x * 0.55 + q) - 0.5), c2 = Math.abs(fract(x * 0.55 - q) - 0.5), strap = Math.min(a, c2), base = p.colour ?? [0.36, 0.07, 0.06];
    const under = times(mix(base, times(base, 1.4), fbm(x * 2, q * 6, seed + 51, 3)), light * 1.2 * (1 - 0.5 * bell(strap - 0.13, 0.03)));
    return strap < 0.1 ? times(p.strap ?? [0.07, 0.06, 0.06], light * (0.8 + 1.2 * (1 - strap / 0.1) ** 0.5)) : under;
  }
  if (p.kind === "ribbed") {
    const f = fract(x / 1.05), base = p.colour ?? [0.30, 0.31, 0.18];
    return f < 0.24 ? times([0.07, 0.07, 0.06], light * (0.8 + 0.8 * Math.sin(Math.PI * f / 0.24)))
      : times(mix(base, times(base, 1.45), fbm(x * 3, q * 8, seed + 53, 3)), light * 1.15 * (0.78 + 0.3 * Math.sin(Math.PI * (f - 0.24) / 0.76)));
  }
  return times(leatherWrap(x, q, seed + 51, p.colour ?? [0.22, 0.12, 0.07]), light * 1.25);
}

export function axe(spec) {
  const veined = spec.bits.some((b) => b.veins), HEIGHT = veined ? 1024 : 512, S = sheet(WIDTH, HEIGHT, veined ? [0, 0, 0] : undefined), M = shape(WIDTH, HEIGHT), seed = spec.seed ?? 1;

  /** A turned part, painted by where it is along x (not along its skin) and around. */
  const lathed = (part, zone, paint) => {
    const pr = part.profile; let run = 0; const runs = pr.map(([x, r], i) => (i ? (run += Math.hypot(x - pr[i - 1][0], r - pr[i - 1][1])) : 0));
    const px = Math.min(part.px ?? 40, (zone.w - 2) / run);
    const xOf = (u) => { let i = 1; while (i < runs.length - 1 && runs[i] < u) i++; return pr[i - 1][0] + (pr[i][0] - pr[i - 1][0]) * clamp((u - runs[i - 1]) / (runs[i] - runs[i - 1] || 1), 0, 1); };
    M.lathe(pr, zone, { sides: part.sides ?? 8, flatten: part.flatten ?? 1, px, caps: part.caps ?? [false, false], twist: part.twist ?? (part.sides === 4 ? Math.PI / 4 : 0), at: part.at });
    S.zone(zone, (u, v) => paint(xOf(clamp(u / px, 0, run)), clamp(v / zone.h, 0, 1)));
  };

  // ── the haft ──
  const h = spec.haft, parts = h.parts ?? [];
  lathed({ caps: [true, true], ...h, px: 24 }, { x: 8, y: 8, w: 1008, h: 56 }, (x, q) => {
    const light = cylinderLight(q), p = parts.find((r) => x >= r.from && x <= r.to);
    if (p) return wrap(p, x - p.from, q, light * (1 - 0.35 * bell(x - p.from, 0.12) - 0.35 * bell(x - p.to, 0.12)), seed + 60 + parts.indexOf(p) * 5);
    let shade = 1; for (const r of parts) shade -= 0.3 * (bell(x - r.from, 0.18) + bell(x - r.to, 0.18));
    return h.paint ? h.paint({ x, q, light: light * shade, seed }) : wood(x, q * 3.2, light * shade * 1.15, seed + 41, h.tone);
  });

  // ── the bits ──
  const bits = spec.bits.map((b) => {
    const len = b.x1 - b.x0, span = (k) => { const [lo, hi] = b.edges(k); return hi - lo < 0.03 ? [(lo + hi) / 2 - 0.015, (lo + hi) / 2 + 0.015] : [lo, hi]; };
    let tmin = Infinity, tmax = -Infinity, full = 0; for (let i = 0; i <= 60; i++) { const [lo, hi] = span(i / 60); tmin = Math.min(tmin, lo); tmax = Math.max(tmax, hi); full = Math.max(full, hi - lo); }
    return { b, len, span, tmin, tmax, full };
  });
  // every face of every bit gets the same room: the layout that leaves them the most pixels
  const R = { x: 8, y: 76, w: 696, h: 428 }, faces = bits.length * 2, maxS = Math.max(...bits.map((q) => q.len)), maxT = Math.max(...bits.map((q) => q.tmax - q.tmin));
  let lay = null; for (let cols = 1; cols <= faces; cols++) { const rows = Math.ceil(faces / cols), px = Math.min((R.w / cols - 10) / maxS, (R.h / rows - 10) / maxT); if (!lay || px > lay.px) lay = { cols, rows, px }; }
  const PX = Math.min(40, lay.px);
  bits.forEach(({ b, len, span, tmin, tmax, full }, n) => {
    const eye = b.eye ?? 0.8, bevel = b.bevel ?? 1.2, T = b.thick ?? 0.5, thin = b.thin ?? 0.4;
    const cell = (i) => ({ x: R.x + (i % lay.cols) * R.w / lay.cols + 4, y: R.y + Math.floor(i / lay.cols) * R.h / lay.rows + 4 });
    const zones = [0, 1].map((f) => { const c = cell(n * 2 + f); return { x: Math.round(c.x), yc: Math.round(c.y) + 1 + tmax * PX }; });
    // the section: full at the eye, thinning towards the edge, ground to nothing in the bevel
    const body = (t) => T * (1 - (1 - thin) * step(eye, tmax - bevel, t));
    const stations = (b.stations ?? b.edges.stations ?? [0, 0.03, 0.08, 0.16, 0.26, 0.36, 0.46, 0.54, 0.64, 0.74, 0.84, 0.92, 0.97, 1]).map((k) => {
      const [lo, hi] = span(k), w = hi - lo, free = lo > eye + 0.05, close = Math.min(1, w / (0.25 * full));
      const fr = [0, free ? 0.12 : 0.2, 0.5, Math.max(0.6, 1 - bevel / w), 1];
      return { s: b.x0 + k * len, pts: fr.map((f, i) => { const t = lo + f * w; return [t, i === 4 || (free && i === 0) ? 0 : body(t) * close * (i === 3 && bevel / w > 0.4 ? 0.8 : 1)]; }) };
    });
    const sides = b.mirror ? [1, -1] : [b.side ?? 1];
    for (const sg of sides) {
      const at = b.at ? (s, t, g) => b.at(s, t, g, sg) : (s, t, g) => [s, sg * t, g];
      M.plate(stations, zones[0], zones[1], { px: PX, s0: b.x0, at });
      if (b.veins) {
        const before = M.tris.length, skin = stations.map((q) => ({ s: q.s, pts: q.pts.map(([t, g]) => [t, g > 0 ? g + SKIN : g]) }));
        M.plate(skin, { ...zones[0], yc: zones[0].yc + 512 }, { ...zones[1], yc: zones[1].yc + 512 }, { px: PX, s0: b.x0, at });
        for (const t of M.tris.slice(before)) t.glow = t.flow = true;
      }
    }
    zones.forEach((z, f) => {
      const side = f ? -1 : 1, sd = seed + n * 20 + (f ? 37 : 13), body2 = metalOf(b.metal ?? "gunmetal");
      const point = (u, v) => { const s = b.x0 + u / PX, k = clamp((s - b.x0) / len, 0, 1), [lo, hi] = span(k), t = clamp(tmax - v / PX, lo, hi); return { s, k, lo, hi, t, rel: (t - lo) / (hi - lo), toEdge: hi - t, side, seed: sd, bevel, eye }; };
      const rect = { x: z.x, y: Math.round(z.yc - tmax * PX), w: Math.ceil(len * PX), h: Math.ceil((tmax - tmin) * PX) };
      S.zone(rect, (u, v) => {
        const q = point(u, v), { s, t, lo, toEdge } = q, ground = step(bevel * 1.05, bevel * 0.92, toEdge);
        q.light = (0.94 + 0.05 * side) * (1 - 0.16 * bell(t - eye, 0.5)) + 0.2 * bell(toEdge - bevel, 0.07) - 0.16 * bell(toEdge - bevel * 1.18, 0.1)
          - 0.2 * bell(toEdge - bevel * 1.55, 0.045) + 0.1 * bell(toEdge - bevel * 1.55 - 0.09, 0.04);   // a line cut along the edge
        const cheek = times(body2(s * 1.0, t * 1.0, q.light, sd), 1 + 0.16 * (fbm(s * 1.7, t * 1.7, sd + 7, 2) - 0.5));
        const edge = times((b.edgeMetal ? metalOf(b.edgeMetal) : (a, c, l, e) => steel(a * 0.9, c * 1.2, l, e, b.rust ?? -0.45))(s, t, 1.16 + 0.1 * side * (toEdge / bevel - 0.5), sd + 3), 1 + 0.3 * step(0.22, 0.05, toEdge));
        q.c = mix(cheek, edge, ground); q.ground = ground;
        let c = b.paint ? b.paint(q) : q.c;
        const tint = typeof b.tint === "function" ? b.tint(q) : b.tint;
        if (tint) c = [c[0] * tint[0], c[1] * tint[1], c[2] * tint[2]];
        return lo > eye + 0.05 ? times(c, 1 + 0.25 * bell(t - lo, 0.07)) : c;                    // the free side catches a little light
      }, 3);
      if (b.veins) S.zone({ ...rect, y: rect.y + 512 }, (u, v) => b.veins(point(u, v)), 3);
    });
  });

  // ── the fittings ──
  const turned = spec.turned ?? [], rings = spec.rings ?? [], row = (i) => ({ x: 716, y: 76 + i * 44, w: 300, h: 38 });
  turned.forEach((p, i) => {
    const metal = metalOf(p.metal), sd = seed + 100 + i * 7;
    lathed(p, row(i), (x, q) => (p.paint ? p.paint({ x, q, light: cylinderLight(q, 0.5), seed: sd, metal }) : metal(x * 3, q * 4, cylinderLight(q, 0.5), sd)));
  });
  rings.forEach((r, i) => {
    const zone = row(turned.length + i), n = r.sides ?? 6, m = 6, tube = r.tube ?? 0.25, metal = metalOf(r.metal), cy = r.y ?? 0;
    const corner = (a, j) => { const th = 2 * Math.PI * a / n + Math.PI / n, ph = 2 * Math.PI * j / m, d = r.radius + tube * Math.cos(ph); return M.V([r.x + d * Math.cos(th), cy + d * Math.sin(th), tube * (r.flatten ?? 1) * Math.sin(ph)], [zone.x + zone.w * a / n, zone.y + zone.h * j / m]); };
    for (let a = 0; a < n; a++) for (let j = 0; j < m; j++) {
      const th = 2 * Math.PI * (a + 0.5) / n + Math.PI / n;
      M.quad(corner(a, j), corner(a + 1, j), corner(a + 1, j + 1), corner(a, j + 1), [r.x + r.radius * Math.cos(th), cy + r.radius * Math.sin(th), 0]);
    }
    S.zone(zone, (u, v) => metal(u / 12, v / 12, 0.8 + 0.4 * Math.cos(2 * Math.PI * (v / zone.h - 0.2)), seed + 150 + i * 7));
  });
  const used = turned.length + rings.length;
  if (spec.extra) spec.extra({ M, S, zone: { x: 716, y: 76 + used * 44, w: 300, h: 504 - (76 + used * 44) }, seed });
  return { tris: M.tris, image: S.image(), haft: true };
}

/**
 * Lightning running through a metal: 0 away from a bolt, 1 on its core. The bolts are the lines
 * where a cloud of noise crosses its middle, `width` units wide (the cloud's slope tells how far
 * off the line a point is, so that they do not pool where the cloud is flat); finer ones branch off.
 */
export function bolts(x, y, seed, scale = 0.2, width = 0.12) {
  const line = (f, w) => { const e = 0.06, v = f(x, y), d = Math.abs(v - 0.5) / (Math.hypot(f(x + e, y) - v, f(x, y + e) - v) / e + 0.02); return step(w, w * 0.25, d); };
  return Math.max(line((p, q) => fbm(p * scale, q * scale, seed, 4), width), 0.55 * line((p, q) => fbm(p * scale * 2.4 + 9, q * scale * 2.4, seed + 31, 3), width * 0.7));
}

/**
 * The edges of a crescent bit: a round edge that reaches `reach` at `mid` and comes back towards
 * the haft at both ends, down to `tip0` (at `x0`) and `tip1` (at `x1`); a neck on the haft from
 * `n0` to `n1`, and between the neck and each tip a hollow, `hollow0` and `hollow1` deep.
 */
export function crescent({ x0, x1, n0, n1, mid = (n0 + n1) / 2, reach, tip0, tip1, hollow0, hollow1, root = 0.3, neck = 1.3, round = 0.55 }) {
  const edges = (k) => {
    const x = x0 + k * (x1 - x0), low = x < mid, tip = low ? tip0 : tip1, u = low ? (mid - x) / (mid - x0) : (x - mid) / (x1 - mid), hi = tip + (reach - tip) * Math.max(0, 1 - u * u) ** round;
    if (x >= n0 && x <= n1) return [root, hi];
    const r = low ? (n0 - x) / (n0 - x0) : (x - n1) / (x1 - n1), lo = neck + (tip - 0.08 - neck) * r + (low ? hollow0 : hollow1) * Math.sin(Math.PI * r) ** 0.8;
    return [Math.min(lo, hi), hi];
  };
  const a = (n0 - x0) / (x1 - x0), b = (n1 - x0) / (x1 - x0), between = (p, q, n) => Array.from({ length: n }, (_, i) => p + (q - p) * (i + 1) / (n + 1));
  edges.stations = [0, 0.012, ...between(0.012, a, 6), a - 0.004, a + 0.004, ...between(a, b, 2), b - 0.004, b + 0.004, ...between(b, 0.988, 5), 0.988, 1];
  return edges;
}

/** The edges of a flared bit: a neck on the haft from `n0` to `n1`, spreading to an edge from `x0` to `x1` that reaches `reach` (bulging by `bulge` in the middle). `lower`, `upper`: how the two horns sweep (smaller = more hollow). */
export function flared({ x0, x1, n0, n1, reach, bulge = 1, root = 0.3, neck = 1.0, lower = 0.6, upper = 0.6 }) {
  const mid = (x0 + x1) / 2, half = (x1 - x0) / 2, hiAt = (x) => reach - bulge * ((x - mid) / half) ** 2, tip0 = hiAt(x0) - 0.1, tip1 = hiAt(x1) - 0.1;
  const edges = (k) => {
    const x = x0 + k * (x1 - x0), hi = hiAt(x);
    const lo = x < n0 ? neck + (tip0 - neck) * ((n0 - x) / (n0 - x0)) ** lower : x > n1 ? neck + (tip1 - neck) * ((x - n1) / (x1 - n1)) ** upper : root;
    return [Math.min(lo, hi), hi];
  };
  // a station each side of where the neck ends, so that the horns start sharp
  const a = (n0 - x0) / (x1 - x0), b = (n1 - x0) / (x1 - x0), between = (p, q, n) => Array.from({ length: n }, (_, i) => p + (q - p) * (i + 1) / (n + 1));
  edges.stations = [0, ...between(0, a, 4), a - 0.004, a + 0.004, ...between(a, b, 2), b - 0.004, b + 0.004, ...between(b, 1, 4), 1].filter((k) => k >= 0 && k <= 1).sort((p, q) => p - q);
  return edges;
}
