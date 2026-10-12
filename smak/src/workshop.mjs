// The workshop: what every new piece shares. Seeded noise, painted materials, a sheet to
// paint the texture on and a shape builder that turns its own triangles to face outwards.
//
// A piece's axes: +x along its length (from the grip to the tip or the head), +y its width,
// +z its thickness. Units are the game's. The volume is painted into the texture; the
// engine adds only a soft light of its own.
//
// Plain arrays, no browser and no library.

// ── noise ──────────────────────────────────────────────────────────────────
export const rand = (x, y, s = 0) => { const n = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453; return n - Math.floor(n); };
export const smooth = (t) => t * t * (3 - 2 * t);
export const noise = (x, y, s = 0) => {
  const xi = Math.floor(x), yi = Math.floor(y), fx = smooth(x - xi), fy = smooth(y - yi);
  const a = rand(xi, yi, s), b = rand(xi + 1, yi, s), c = rand(xi, yi + 1, s), d = rand(xi + 1, yi + 1, s);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
};
export const fbm = (x, y, s = 0, n = 4) => { let v = 0, a = 0.5, t = 0; for (let i = 0; i < n; i++) { v += a * noise(x, y, s + i * 7); t += a; x *= 2.03; y *= 2.03; a *= 0.5; } return v / t; };
/** 0 below `a`, 1 above `b`, smooth in between (`a` may be the larger: then it falls). */
/** Noise in space, 0 to 1, for painting by place (src/place.mjs): three flat ones crossed. `k`: how many lumps a unit. */
export const fbm3 = (p, k = 1, s = 0, n = 4) => (fbm(p[0] * k, p[1] * k, s, n) + fbm(p[1] * k + 31, p[2] * k, s + 3, n) + fbm(p[2] * k + 57, p[0] * k, s + 5, n)) / 3;
/** A random number maker that gives the same numbers every run: `const r = seeded(7); r()` is 0 to 1. */
export const seeded = (a) => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
export const step = (a, b, x) => smooth(Math.min(1, Math.max(0, (x - a) / (b - a))));
export const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const times = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
export const bell = (d, width) => Math.exp(-((d / width) ** 2));

// ── painted materials ──────────────────────────────────────────────────────
const RUST_DARK = [0.20, 0.11, 0.07], RUST = [0.38, 0.21, 0.11], RUST_BRIGHT = [0.52, 0.30, 0.13];
export function rust(x, y, s) {
  let c = mix(RUST_DARK, RUST, step(0.3, 0.7, fbm(x * 2.2, y * 2.2, s + 40, 4)));
  c = mix(c, RUST_BRIGHT, step(0.58, 0.78, fbm(x * 6, y * 6, s + 60, 3)) * 0.7);
  return times(c, 1 - 0.45 * step(0.60, 0.74, fbm(x * 24, y * 24, s + 80, 2)));
}
/** Blade steel: light, scratched along x, with stains of rust. `much` (-1..1) raises or lowers the rust; -1 is a clean blade. */
export function steel(x, y, light, s, much = 0) {
  let v = (0.57 + 0.10 * (fbm(x * 0.7, y * 2.5, s) - 0.5) + 0.05 * (fbm(x * 6, y * 6, s + 5, 2) - 0.5)) * light;
  if (noise(x * 1.3, y * 75, s + 9) > 0.80) v += 0.045;
  if (noise(x * 0.8 + 30, y * 110, s + 11) > 0.86) v -= 0.05;
  let c = [v * 0.96, v * 0.98, v * 1.02];
  const r = fbm(x * 0.42, y * 1.3, s + 20) + much + 0.10 * (fbm(x * 3, y * 3, s + 25, 2) - 0.5), crust = step(0.46, 0.66, r);
  c = mix(c, times(RUST, 0.9), 0.28 * step(0.32, 0.52, r));
  c = mix(c, times(rust(x, y, s), Math.min(1.1, light)), crust * 0.92);
  return times(c, 1 - 0.18 * step(0.38, 0.46, r) * (1 - crust));
}
/** Forged iron, dark and pitted. */
export function iron(a, b, light, s, much = 0) {
  const v = (0.26 + 0.09 * (fbm(a * 1.4, b * 1.4, s) - 0.5) + 0.05 * (fbm(a * 7, b * 7, s + 3, 2) - 0.5)) * light;
  let c = [v, v * 0.98, v * 0.97];
  const r = fbm(a * 0.9, b * 0.9, s + 20) + much + 0.08 * (fbm(a * 4, b * 4, s + 22, 2) - 0.5);
  c = mix(c, times(rust(a, b, s), 0.75 * light), step(0.50, 0.64, r) * 0.9);
  return times(c, 1 - 0.3 * step(0.62, 0.74, fbm(a * 22, b * 22, s + 31, 2)));
}
/** Wood with the grain along `x`. `tone`: [dark, light]. */
export function wood(x, y, light, s, tone = [[0.30, 0.20, 0.12], [0.46, 0.33, 0.20]]) {
  const wave = fbm(x * 0.16, y * 0.9, s, 3), grain = 0.5 + 0.5 * Math.sin((y * 3.4 + wave * 9) * 2.2);
  let v = 0.82 + 0.22 * (grain - 0.5) * (0.5 + fbm(x * 0.3, y * 2, s + 9, 2)) + 0.10 * (fbm(x * 2.5, y * 9, s + 4, 2) - 0.5);
  if (noise(x * 0.9, y * 55, s + 11) > 0.83) v -= 0.10;
  return times(mix(tone[0], tone[1], fbm(x * 0.25, y * 0.6, s + 17, 3)), v * light);
}
/** Leather wound in a spiral. `u` along (units), `v` around (0..1). */
export function leatherWrap(u, v, s = 51, base = [0.25, 0.15, 0.09]) {
  const turn = u * 1.35 + v, b = turn - Math.floor(turn);
  let k = 0.62 + 0.42 * Math.sin(Math.PI * b) ** 0.7;
  if (b < 0.07 || b > 0.96) k *= 0.45;
  k *= 0.9 + 0.2 * (fbm(u * 5, v * 14, s, 3) - 0.5) * 2;
  if (noise(u * 3, v * 90, s + 10) > 0.84) k *= 0.85;
  const worn = step(0.52, 0.7, fbm(u * 0.9, v * 3, s + 6)) * step(0.2, 0.6, Math.sin(Math.PI * b));
  return times(mix(base, [base[0] * 1.7, base[1] * 1.9, base[2] * 2.0], worn), k);
}
/**
 * The painted light of a cylinder: `v` around (0..1). Soft on purpose: the piece is seen from
 * any side (in the hand, on the back, on the floor) and with much painted shadow the dark side,
 * when it is the one in view, leaves the piece almost black.
 */
export const cylinderLight = (v, strength = 0.34) => 0.84 + strength * 0.65 * Math.cos(2 * Math.PI * (v - 0.22));
/** A rivet at (cx, cy) of radius `rad`: `{light}` inside, `{shadow}` in the ring round it, `null` outside. */
export function rivet(x, y, cx, cy, rad) {
  const dx = (x - cx) / rad, dy = (y - cy) / rad, d = Math.hypot(dx, dy);
  if (d > 1.5) return null;
  if (d > 1) return { shadow: 0.35 * (1 - (d - 1) / 0.5) * Math.max(0, 0.3 + (dx - dy) * 0.7) };
  return { light: 0.85 + 0.75 * Math.max(0, (-dx + dy) * 0.7) * (1 - d * 0.4) - 0.25 * d };
}

// ── the sheet: the texture being painted ───────────────────────────────────
export function sheet(width, height, ground = [0.2, 0.18, 0.17]) {
  const rgb = new Uint8Array(width * height * 3);
  const put = (px, py, c) => { if (px < 0 || py < 0 || px >= width || py >= height) return; const i = (py * width + px) * 3; for (let k = 0; k < 3; k++) rgb[i + k] = Math.max(0, Math.min(255, c[k] * 255)); };
  for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) put(px, py, ground);
  return {
    width, height,
    /** Paints a zone `{x, y, w, h}` (and `bleed` pixels round it) by calling `fn(u, v)` with `u`, `v` in pixels inside it. */
    zone(z, fn, bleed = 4) { for (let py = z.y - bleed; py < z.y + z.h + bleed; py++) for (let px = z.x - bleed; px < z.x + z.w + bleed; px++) { const c = fn(px - z.x, py - z.y); if (c) put(px, py, c); } },
    image() { return { width, height, rgb }; },
  };
}

// ── the shape: the mesh being built ────────────────────────────────────────
export function shape(width, height) {
  const tris = [];
  /** a corner: position, texture pixel and, when the piece moves in parts, which bone it goes on (0 = the main one) */
  const V = (p, t, part = 0) => ({ p, t, part });
  /** a triangle; `inside` is a point within the piece, so that it faces outwards */
  const tri = (a, b, c, inside) => {
    const u = [b.p[0] - a.p[0], b.p[1] - a.p[1], b.p[2] - a.p[2]], w = [c.p[0] - a.p[0], c.p[1] - a.p[1], c.p[2] - a.p[2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    if (Math.hypot(...n) < 1e-9) return;
    const m = [0, 1, 2].map((k) => (a.p[k] + b.p[k] + c.p[k]) / 3 - inside[k]);
    tris.push((n[0] * m[0] + n[1] * m[1] + n[2] * m[2] >= 0 ? [a, b, c] : [a, c, b]).map((q) => ({ p: [...q.p], uv: [q.t[0] / width, q.t[1] / height], part: q.part ?? 0 })));
  };
  const quad = (a, b, c, d, inside) => { tri(a, b, c, inside); tri(a, c, d, inside); };
  /**
   * A lathe. `profile`: [[s, radius], ...] along the axis; `zone` {x, y, w, h}: `s` runs left to
   * right (`px` pixels a unit, from the first point) and the turn runs top to bottom.
   * `at(s, a, b)` places the point: the axis is x unless told. `flatten` squashes it in z.
   * `caps`: [start, end], each `true` or a zone `{x, y, w, h}` where it is drawn flat.
   * Returns the length of the profile.
   */
  const lathe = (profile, zone, { sides = 10, flatten = 1, px = 48, at = (s, a, b) => [s, a, b], caps = [false, false], twist = 0, part = 0 } = {}) => {
    let length = 0; const us = profile.map(([s, r], i) => (i ? (length += Math.hypot(s - profile[i - 1][0], r - profile[i - 1][1])) : 0));
    const rings = profile.map(([s, r], i) => Array.from({ length: sides + 1 }, (_, k) => {
      const a = 2 * Math.PI * k / sides + twist;
      return V(at(s, r * Math.cos(a), r * flatten * Math.sin(a)), [zone.x + us[i] * px, zone.y + zone.h * k / sides], part);
    }));
    for (let i = 0; i + 1 < rings.length; i++) for (let k = 0; k < sides; k++) quad(rings[i][k], rings[i + 1][k], rings[i + 1][k + 1], rings[i][k + 1], at((profile[i][0] + profile[i + 1][0]) / 2, 0, 0));
    caps.forEach((cap, which) => {
      if (!cap) return;
      const i = which ? profile.length - 1 : 0, end = rings[i], s = profile[i][0], inside = at(s + (which ? -1 : 1) * 0.5 * Math.sign(profile[profile.length - 1][0] - profile[0][0]), 0, 0);
      // a cap with a zone of its own is laid flat (a disc); otherwise it is a point of the strip
      const flat = (k) => { const a = 2 * Math.PI * k / sides + twist; return [cap.x + cap.w / 2 + Math.cos(a) * cap.w / 2, cap.y + cap.h / 2 - Math.sin(a) * cap.h / 2]; };
      for (let k = 0; k < sides; k++) {
        if (cap.w) tri(V(end[k].p, flat(k), part), V(end[k + 1].p, flat(k + 1), part), V(at(s, 0, 0), [cap.x + cap.w / 2, cap.y + cap.h / 2], part), inside);
        else tri(end[k], end[k + 1], V(at(s, 0, 0), [end[k].t[0] + (which ? 5 : -5), (end[k].t[1] + end[k + 1].t[1]) / 2], part), inside);
      }
    });
    return length;
  };
  /**
   * A plate: stations along `s`, each with its half section `[[t, g], ...]` (from one edge to the
   * other, `g` >= 0 the half thickness). Side A (g) goes in `zoneA` and side B (-g) in `zoneB`,
   * laid flat: `u = zone.x + (s - s0) * px`, `v = zone.yc - t * px`.
   * `at(s, t, g)` places the point (x, y, z unless told).
   */
  const plate = (stations, zoneA, zoneB, { px = 48, s0 = stations[0].s, at = (s, t, g) => [s, t, g], part = 0 } = {}) => {
    const uv = (z, s, t) => [z.x + (s - s0) * px, z.yc - t * px];
    const face = (z, sign) => stations.map((q) => q.pts.map(([t, g]) => V(at(q.s, t, sign * g), uv(z, q.s, t), part)));
    for (const [z, sign] of [[zoneA, 1], [zoneB, -1]]) {
      const c = face(z, sign);
      for (let i = 0; i + 1 < c.length; i++) {
        const tm = (stations[i].pts[0][0] + stations[i].pts.at(-1)[0] + stations[i + 1].pts[0][0] + stations[i + 1].pts.at(-1)[0]) / 4;
        const inside = at((stations[i].s + stations[i + 1].s) / 2, tm, 0);
        for (let k = 0; k + 1 < c[i].length; k++) quad(c[i][k], c[i + 1][k], c[i + 1][k + 1], c[i][k + 1], inside);
      }
    }
  };
  return { V, tri, quad, lathe, plate, tris };
}

// ── outlines ───────────────────────────────────────────────────────────────
/** How far (x, y) is from the edge of a polygon [[x, y], ...]: positive inside, negative outside. */
export function polyDist(x, y, poly) {
  let d = Infinity, inside = false;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.min(1, Math.max(0, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    d = Math.min(d, Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy));
    if ((a[1] > y) !== (b[1] > y) && x < a[0] + (y - a[1]) / (b[1] - a[1]) * dx) inside = !inside;
  }
  return inside ? d : -d;
}
