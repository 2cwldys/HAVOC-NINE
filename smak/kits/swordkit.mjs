// A sword from a description: blade, guard, grip and pommel, each a few numbers and a choice
// of material. Every blade made with it shares one hand.
//
//   sword({ seed, tall, blade, guard, grip, pommel, collar, extra }) -> { tris, image }
//
// x runs from the end of the pommel to the tip; the blade's width is along y, its thickness z.
//   blade:  { x0, x1, half(k) or edges(k) -> [lo, hi] (k: 0 at the guard, 1 at the tip; about the
//             centreline), curve(k) (how far the centreline bends in y), section: "diamond" |
//             "single" (one edge, on +y) | "fuller", thick, rust, tint ([r, g, b] or a function of
//             the point), fullerTo, bevel, paint(q), raw (the paint as it is: no ground edges),
//             px (pixels a unit, 36 unless told: a short blade can be painted finer),
//             glow (drawn additively in the game: ice), bright (solid, but the room's light does not
//             dim it: fire),
//             flames(q) (fire standing off the blade, on black: a skin over it that reaches `flameOut`
//             past each edge and `flameOn` of its length past the tip, and again across the blade, `flameCross` as wide; it glows and moves in the
//             game. q: x, t, k (past 1 beyond the tip), lo, hi, mid, out, past (0..1 beyond the tip)) }
//   guard:  { x, sections: [[y, half length, half thickness], ...], sweep(y), metal, gem: colour, paint(q) }
//           or { x, disc: radius, thick, flatten, metal } for a round one
//   grip:   { profile: [[x, radius], ...], flatten, wrap: "leather" | "cord" | "ivory" | "lattice" |
//             "ribbed", colour, paint(q) }
//   pommel: { profile, flatten, sides, metal }      collar: the same, a band between grip and blade
//   tall:   a taller texture (1024x384; 1024x1024 with flames, which are drawn in its lower half):
//           the guard is painted three times as fine in the band below, and `extra({ M, S, zone, seed })` may add parts of its own in what is left of it
// Metals: "steel", "gunmetal", "black", "brass", "bone", or a function (a, b, light, seed) -> colour.
import { sheet, shape, steel, iron, leatherWrap, cylinderLight, times, mix, bell, step, fbm, noise } from "../src/workshop.mjs";

const WIDTH = 1024;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v)), fract = (v) => v - Math.floor(v);

// ── metals ─────────────────────────────────────────────────────────────────
export const METALS = {
  steel: (a, b, light, seed) => times(iron(a, b, light, seed, -0.15), 1.7),
  gunmetal: (a, b, light, seed) => times(iron(a, b, light, seed, -0.3), 1.25),
  black: (a, b, light, seed) => times(iron(a, b, light, seed, -0.3), 0.72),
  brass: (a, b, light, seed) => {
    let c = mix([0.34, 0.23, 0.07], [0.80, 0.63, 0.26], clamp(0.5 * light - 0.05 + 0.3 * (fbm(a * 2, b * 2, seed, 3) - 0.5), 0, 1));
    c = mix(c, [0.20, 0.21, 0.12], 0.5 * step(0.55, 0.75, fbm(a * 1.2, b * 1.2, seed + 9, 3)));          // tarnish
    return times(c, 1 - 0.3 * step(0.64, 0.76, fbm(a * 20, b * 20, seed + 13, 2)));
  },
  bone: (a, b, light, seed) => times(mix([0.50, 0.45, 0.33], [0.84, 0.79, 0.64], fbm(a * 1.5, b * 4, seed, 3)), light * (1 - 0.25 * step(0.6, 0.72, fbm(a * 9, b * 3, seed + 5, 2)))),
};
const metalOf = (m) => (typeof m === "function" ? m : METALS[m ?? "steel"]);
/** Carved ivory: pale, with scrollwork cut into it and blackened, and a row of scales here and there. `x` along, `q` around (0..1). */
export function carved(x, q, light, seed) {
  let c = times(mix([0.62, 0.57, 0.42], [0.90, 0.86, 0.70], fbm(x * 1.2, q * 5, seed, 3)), light);
  const w = 2.6 * fbm(x * 0.55, q * 2.2, seed + 3, 2) + 0.6 * x, scroll = Math.abs(fract(w * 1.7) - 0.5), scales = step(0.52, 0.6, fbm(x * 0.4 + 5, q * 1.5, seed + 7, 2));
  const row = Math.floor(q * 12), arc = Math.hypot(fract(x * 2.6 + 0.5 * (row % 2)) - 0.5, fract(q * 12) - 0.9);
  const cut = Math.max(bell(scroll, 0.07) * (1 - scales), bell(arc - 0.5, 0.09) * scales);
  return mix(c, [0.09, 0.08, 0.06], 0.9 * cut);
}

export function sword(spec) {
  const flamed = Boolean(spec.blade.flames), tall = spec.tall || flamed, HEIGHT = flamed ? 1024 : tall ? 384 : 256, S = sheet(WIDTH, HEIGHT, flamed ? [0, 0, 0] : undefined), M = shape(WIDTH, HEIGHT), seed = spec.seed ?? 1;
  const Z = {
    bladeA: { x: 8, yc: 64 }, bladeB: { x: 8, yc: 192 }, grip: { x: 848, y: 8, w: 168, h: 70 },
    pommel: { x: 848, y: 88, w: 100, h: 56 }, butt: { x: 960, y: 92, w: 48, h: 48 },
    discA: { x: 848, y: 154, w: 44, h: 44 }, discB: { x: 900, y: 154, w: 44, h: 44 }, discRim: { x: 952, y: 156, w: 60, h: 40 },
    // the guard: two strips beside the pommel, or the band below when the texture is tall
    guard: tall ? { A: { x: 8, yc: 320 }, B: { x: 424, yc: 320 }, up: 60, wide: 404, fine: 60 } : { A: { x: 848, yc: 176 }, B: { x: 848, yc: 224 }, up: 20, wide: 164, fine: 30 },
    collar: tall ? { x: 848, y: 156, w: 90, h: 60 } : { x: 848, y: 206, w: 60, h: 40 },
    extra: { x: 840, y: 262, w: 176, h: 116 },
  };

  // ── the blade ──
  const b = spec.blade, len = b.x1 - b.x0, K = (x) => clamp((x - b.x0) / len, 0, 1);
  const span = (k) => { const [lo, hi] = b.edges ? b.edges(k) : [-b.half(k), b.half(k)]; return hi - lo < 0.03 ? [(lo + hi) / 2 - 0.015, (lo + hi) / 2 + 0.015] : [lo, hi]; };
  const curve = b.curve ?? (() => 0), kind = b.section ?? "diamond", double = kind !== "single";
  let reach = 0, full = 0; for (let i = 0; i <= 40; i++) { const s = span(i / 40); reach = Math.max(reach, ...s.map(Math.abs)); full = Math.max(full, s[1] - s[0]); }
  const PX = Math.min(b.px ?? 36, 832 / len, 56 / reach);
  const stations = (b.stations ?? [0, 0.04, 0.1, 0.2, 0.32, 0.44, 0.56, 0.68, 0.78, 0.86, 0.92, 0.96, 0.985, 1]).map((k) => {
    const [lo, hi] = span(k), w = hi - lo, g = (b.thick ?? 0.24) * Math.min(1, w / (0.6 * full)), mid = (lo + hi) / 2;
    const pts = kind === "diamond" ? [[lo, 0], [(lo + mid) / 2, g * 0.62], [mid, g], [(mid + hi) / 2, g * 0.62], [hi, 0]]
      : kind === "single" ? [[lo, 0], [lo + 0.1 * w, g], [lo + (b.bevel ?? 0.6) * w, g], [hi, 0]]
      : [[lo, 0], [lo + 0.28 * w, g], [hi - 0.28 * w, g], [hi, 0]];
    return { s: b.x0 + k * len, pts };
  });
  const before = M.tris.length;
  M.plate(stations, Z.bladeA, Z.bladeB, { px: PX, s0: b.x0, at: (s, t, g) => [s, t + curve(K(s)), g] });
  if (b.glow) for (const t of M.tris.slice(before)) t.glow = true;
  if (b.bright) for (const t of M.tris.slice(before)) t.bright = true;
  for (const [z, side] of [[Z.bladeA, 1], [Z.bladeB, -1]]) {
    S.zone({ x: z.x, y: z.yc - 58, w: Math.ceil(len * PX), h: 116 }, (u, v) => {
      const x = b.x0 + u / PX, k = K(x), [lo, hi] = span(k), t = clamp((58 - v) / PX, lo, hi), rel = (t - lo) / (hi - lo), sd = seed + (side > 0 ? 13 : 37);
      // the painted volume, by the blade's section
      let light = 1;
      if (kind === "diamond") light = 1 + 0.13 * side * Math.sign(rel - 0.5) * step(0.02, 0.1, Math.abs(rel - 0.5)) + 0.16 * bell(rel - 0.5, 0.035);
      else if (kind === "single") { const e = b.bevel ?? 0.6; light = (rel < e ? 0.93 + 0.04 * side : 1.12) + 0.2 * bell(rel - e, 0.02) - 0.25 * bell(rel, 0.06); }
      else {
        // the groove narrows to nothing where it ends
        const to = b.fullerTo ?? 0.65, open = 0.2 * step(to, to - 0.14, k) * step(0.01, 0.05, k), f0 = 0.5 - open, f1 = 0.5 + open, inF = open > 0.01 && rel > f0 && rel < f1, q = (rel - f0) / (f1 - f0 || 1);
        light = inF ? 0.80 + 0.34 * (side > 0 ? q : 1 - q) : 1.03 + 0.06 * side * Math.sign(rel - 0.5);
        if (open > 0.01) light += 0.14 * bell(rel - f0, 0.02) + 0.14 * bell(rel - f1, 0.02);
      }
      light -= 0.10 * step(0.9, 0, x - b.x0);                                  // in the shadow of the guard
      const q = { x, t, k, rel, light, side, seed: sd, lo, hi };
      let c = b.paint ? b.paint(q) : times(steel(x * 0.9, t * 1.2, light, sd, b.rust ?? -0.38), 1 + 0.06 * (fbm(x * 2.4, t * 0.6, sd + 50, 2) - 0.5));
      const tint = typeof b.tint === "function" ? b.tint(q) : b.tint;
      if (tint) c = [c[0] * tint[0], c[1] * tint[1], c[2] * tint[2]];
      if (b.raw) return c;
      // the edges, ground bright
      const toEdge = Math.min(hi - t, double ? t - lo : Infinity), ew = Math.min(0.2, (hi - lo) * 0.16);
      c = mix(c, times(c, 1.38), step(ew, ew * 0.4, toEdge) * 0.8);
      return times(c, 1 - 0.25 * bell(toEdge - ew * 1.05, ew * 0.15));
    }, 0);
  }
  // ── its flames: a skin just over the blade, wider than it and longer, drawn 512 pixels lower ──
  if (flamed) {
    const out = b.flameOut ?? 0.8, on = b.flameOn ?? 0.12, lift = 0.04, n = b.flameStations ?? 28, PXF = Math.min(PX, 832 / (len * (1 + on)), 56 / (reach + out));
    const skin = Array.from({ length: n + 1 }, (_, i) => {
      const k = (1 + on) * i / n, [lo, hi] = span(Math.min(1, k)), past = clamp((k - 1) / on, 0, 1), w = out * (1 - past), g = (b.thick ?? 0.24) * (1 - past) + lift, mid = (lo + hi) / 2;
      return { s: b.x0 + k * len, pts: [[lo - w, 0], [lo - 0.04, g], [mid, g], [hi + 0.04, g], [hi + w, 0]] };
    });
    const first = M.tris.length, ZA = { x: Z.bladeA.x, yc: Z.bladeA.yc + 512 }, ZB = { x: Z.bladeB.x, yc: Z.bladeB.yc + 512 };
    M.plate(skin, ZA, ZB, { px: PXF, s0: b.x0, at: (s, t, g) => [s, t + curve(K(s)), g] });
    // and the same again across the blade, so that it is fire from its edge too (a knife is held edge-on to the eye)
    const cross = b.flameCross ?? 0.7;
    if (cross) M.plate(skin.map((q) => ({ s: q.s, pts: q.pts.map(([t, g]) => [t, g ? lift : 0]) })), ZA, ZB, { px: PXF, s0: b.x0, at: (s, t, g) => [s, curve(K(s)) + g, t * cross] });
    for (const t of M.tris.slice(first)) t.glow = t.flow = t.loose = true;   // loose: not part of the outline the piece is laid by
    for (const [z, side] of [[ZA, 1], [ZB, -1]]) S.zone({ x: z.x, y: z.yc - 60, w: Math.ceil(len * (1 + on) * PXF), h: 120 }, (u, v) => {
      const x = b.x0 + u / PXF, k = (x - b.x0) / len, [lo, hi] = span(clamp(k, 0, 1));
      return b.flames({ x, t: (60 - v) / PXF, k, lo, hi, mid: (lo + hi) / 2, out, past: clamp((k - 1) / on, 0, 1), side, seed: seed + (side > 0 ? 113 : 137) });
    }, 0);
  }

  // ── the guard ──
  const g = spec.guard;
  if (g?.disc) {
    const metal = metalOf(g.metal ?? "black"), th = g.thick ?? 0.24;
    M.lathe([[g.x - th / 2, g.disc * 0.94], [g.x, g.disc], [g.x + th / 2, g.disc * 0.94]], Z.discRim, { sides: 12, flatten: g.flatten ?? 1, px: 60, caps: [Z.discA, Z.discB] });
    // each face: a rim, a ring of cut-outs and the seat of the blade
    for (const z of [Z.discA, Z.discB]) S.zone(z, (u, v) => {
      const dx = (u - 22) / 22, dy = (v - 22) / 22, d = Math.hypot(dx, dy), a = Math.atan2(dy, dx);
      const hole = bell(d - 0.62, 0.1) * step(0.5, 0.8, Math.cos(a * 4));
      return times(metal(dx * 2, dy * 2, 1.05 - 0.2 * d + 0.3 * bell(d - 0.92, 0.06) - 0.3 * bell(d - 0.3, 0.1), seed + 81), 1 - 0.8 * hole);
    });
    S.zone(Z.discRim, (u, v) => metal(u / 10, v / 10, cylinderLight(v / Z.discRim.h, 0.5), seed + 83));
  } else if (g) {
    const metal = metalOf(g.metal), G = Z.guard, y0 = g.sections[0][0], spanY = g.sections.at(-1)[0] - y0, longest = Math.max(...g.sections.map((s) => s[1]));
    const PXQ = Math.min(G.fine, G.wide / spanY, (G.up - 1) / longest), sweep = g.sweep ?? (() => 0);
    M.plate(g.sections.map(([y, l, th]) => ({ s: y, pts: [[-l, 0], [-l * 0.5, th], [l * 0.5, th], [l, 0]] })), G.A, G.B, { px: PXQ, s0: y0, at: (s, t, th) => [g.x + t + sweep(s), s, th] });
    for (const [z, side] of [[G.A, 1], [G.B, -1]]) {
      S.zone({ x: z.x, y: z.yc - G.up, w: Math.ceil(spanY * PXQ), h: 2 * G.up }, (u, v) => {
        const y = y0 + u / PXQ, t = (G.up - v) / PXQ, sd = seed + (side > 0 ? 81 : 87);
        const light = 1.0 + 0.2 * side * t / longest + 0.12 * bell(y, spanY * 0.17) - 0.3 * bell(Math.abs(y) - 0.6, 0.08);
        let c = g.paint ? g.paint({ y, t, light, side, seed: sd, metal }) : metal(y * 1.1, t * 1.1, light, sd);
        if (g.gem) {                                               // a six-sided stone set in the middle
          const d = Math.max(Math.abs(t), Math.abs(t) * 0.5 + Math.abs(y) * 0.866) / 0.46;
          if (d < 1) c = times(mix(times(g.gem, 0.45), g.gem, 0.5 + 0.5 * side * (t - y) / 0.6), 1 + 0.9 * bell(Math.hypot(y + 0.14, t - 0.16), 0.1));
          else c = times(c, 1 - 0.7 * bell(d - 1.08, 0.1));
        }
        return c;
      }, 0);
    }
  }

  // ── the grip, the pommel and the collar ──
  const lathed = (part, zone, cap, paint) => {
    if (!part) return;
    let run = 0; part.profile.forEach(([x, r], i) => { if (i) run += Math.hypot(x - part.profile[i - 1][0], r - part.profile[i - 1][1]); });
    const px = Math.min(30, (zone.w - 2) / run);
    M.lathe(part.profile, zone, { sides: part.sides ?? 8, flatten: part.flatten ?? 1, px, caps: [cap ?? false, false], twist: part.sides === 4 ? Math.PI / 4 : 0 });
    S.zone(zone, (u, v) => paint(u / px, v / zone.h, run));
  };
  const gr = spec.grip;
  lathed(gr, Z.grip, null, (x, q, run) => {
    const light = cylinderLight(q) * (1 - 0.4 * bell(x, 0.15) - 0.4 * bell(x - run, 0.15));
    if (gr.paint) return gr.paint({ x, q, light, run, seed });
    if (gr.wrap === "cord") {                                  // flat braid crossed over ray skin, which shows in small diamonds
      const a = fract(x * 1.5 + q * 2), c2 = fract(x * 1.5 - q * 2), d = Math.abs(a - 0.5) + Math.abs(c2 - 0.5);
      if (d < 0.2) return times(mix([0.40, 0.38, 0.30], [0.58, 0.56, 0.46], noise(x * 30, q * 60, seed + 55)), light * (0.7 + 1.2 * d));
      const over = a < 0.5 ? a : c2, sheen = 0.65 + 0.75 * Math.sin(Math.PI * fract(over * 2)) ** 2;
      return times(gr.colour ?? [0.06, 0.06, 0.08], light * sheen * (0.85 + 0.3 * noise(x * 40, q * 80, seed + 57)));
    }
    if (gr.wrap === "ivory") return carved(x, q, light * 1.15, seed + 61);
    if (gr.wrap === "lattice") {                               // leather under black straps crossed over it
      const a = Math.abs(fract(x * 0.55 + q) - 0.5), c2 = Math.abs(fract(x * 0.55 - q) - 0.5), strap = Math.min(a, c2);
      const under = times(mix(gr.colour ?? [0.36, 0.07, 0.06], [0.5, 0.12, 0.09], fbm(x * 2, q * 6, seed + 51, 3)), light * 1.2 * (1 - 0.5 * bell(strap - 0.13, 0.03)));
      return strap < 0.1 ? times([0.07, 0.06, 0.06], light * (0.8 + 1.2 * (1 - strap / 0.1) ** 0.5)) : under;
    }
    if (gr.wrap === "ribbed") {                                // cloth bound down by dark rings
      const f = fract(x / 1.05), ring = f < 0.24;
      return ring ? times([0.07, 0.07, 0.06], light * (0.8 + 0.8 * Math.sin(Math.PI * f / 0.24)))
        : times(mix(gr.colour ?? [0.30, 0.31, 0.18], times(gr.colour ?? [0.30, 0.31, 0.18], 1.45), fbm(x * 3, q * 8, seed + 53, 3)), light * 1.15 * (0.78 + 0.3 * Math.sin(Math.PI * (f - 0.24) / 0.76)));
    }
    return times(leatherWrap(x, q, seed + 51, gr.colour ?? [0.22, 0.12, 0.07]), light * 1.25);
  });
  const pm = spec.pommel, pmMetal = metalOf(pm?.metal);
  lathed(pm, Z.pommel, Z.butt, (x, q) => pmMetal(x * 3.3, q * 4, cylinderLight(q, 0.5), seed + 71));
  if (pm) S.zone(Z.butt, (u, v) => { const d = Math.hypot(u - 24, v - 24) / 24; return pmMetal(u / 9, v / 9, 1.05 - 0.35 * d, seed + 73); });
  const co = spec.collar, coMetal = metalOf(co?.metal ?? "brass");
  lathed(co, Z.collar, null, (x, q, run) => coMetal(x * 3, q * 4, cylinderLight(q, 0.5) * (1 + 0.25 * bell(x - run / 2, run / 5)), seed + 91));

  if (spec.extra) spec.extra({ M, S, zone: Z.extra, seed });
  return { tris: M.tris, image: S.image() };
}

/** A straight blade's half width: `w0` at the guard, `w1` where the point starts (at `from`), then closing to the tip. */
export const taper = (w0, w1, from = 0.86, power = 0.8) => (k) => (k < from ? w0 + (w1 - w0) * k / from : w1 * Math.max(0, 1 - (k - from) / (1 - from)) ** power);
