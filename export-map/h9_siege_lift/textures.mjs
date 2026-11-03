// The lift's own textures, out\h9_lift.wad: what streams past the car while it climbs.
//
//   SCROLLCLOUD    wisps of red and ochre cloud drawn out along the picture's width
//   SCROLLSTREAK   thin streaks of rushing air, sparse
//   SCROLLTETHER   the tether: braided cable with a joint collar every half picture
//   CLOUDBANK      one soft cloud, for the cloud banks that drift down past the car
//
// The SCROLL ones go on func_conveyors, which scroll a texture along its width (U); the faces turn the picture so
// that its width runs up and down, and the world streams downward past the car. They are drawn on black and the
// cards wear them additive, so the black is nothing and only the glow shows. Every picture wraps round both ways
// with no seam -- its noise is laid on a lattice that repeats exactly once across it -- since a scrolling picture
// shows its seam once a cycle.
//
// Imported by lift.mjs, which writes the .wad beside the map (wadinclude puts the textures inside the .bsp).
import { CLOUD_LIT, HAZE, SEA } from "./sky.mjs";

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smooth = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a.map((v, k) => v + (b[k] - v) * t);

function hash(a, b, c) {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Value noise on a lattice of px by py cells that repeats: noise(x + px, y) is noise(x, y). */
function pnoise(x, y, px, py, seed) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const at = (a, b) => hash(((a % px) + px) % px, ((b % py) + py) % py, seed);
  const top = at(ix, iy) * (1 - sx) + at(ix + 1, iy) * sx;
  const bot = at(ix, iy + 1) * (1 - sx) + at(ix + 1, iy + 1) * sx;
  return top * (1 - sy) + bot * sy;
}

/** Several octaves of it, each with twice the cells, so the whole still repeats once across the picture. */
function pfbm(u, v, px, py, seed, octaves) {
  let sum = 0, amp = 0.5, norm = 0, k = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * pnoise(u * px * k, v * py * k, px * k, py * k, seed + o * 13);
    norm += amp;
    amp *= 0.5;
    k *= 2;
  }
  return sum / norm;
}

function picture(width, height, paint) {
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) rgb.set(paint(x / width, y / height).map((c) => Math.round(255 * clamp01(c))), (y * width + x) * 3);
  return { width, height, rgb };
}

// wisps: few cells along the width and many across it, so each mass is drawn out along the scroll
const cloud = picture(256, 256, (u, v) => {
  const body = pfbm(u, v, 2, 7, 11, 4);
  const fine = pfbm(u, v, 5, 22, 29, 3);
  const shape = body + (fine - 0.5) * 0.35;
  const dense = smooth(0.56, 0.8, shape);
  const lit = mix(SEA, CLOUD_LIT, smooth(0.55, 0.85, shape));
  return mix(lit, HAZE, 0.25 * fine).map((c) => c * dense * 0.95);
});

// streaks: hairlines of air along the width, each lit for part of its length
const streak = picture(256, 256, (u, v) => {
  const rows = 48;
  const row = Math.floor(v * rows);
  const inRow = 1 - Math.abs((v * rows - row) - 0.5) * 2;
  const line = smooth(0.82, 0.97, inRow);
  const on = hash(row, 0, 7) > 0.55 ? smooth(0.45, 0.7, pnoise(u * 3, row, 3, rows, 5 + row)) : 0;
  return [0.55, 0.32, 0.2].map((c) => c * line * on * (0.6 + 0.4 * hash(row, 1, 9)));
});

// the tether: braided cable along the width, a collar at 0 and at the half
const tether = picture(256, 64, (u, v) => {
  const across = Math.abs(v - 0.5) * 2; // 0 in the middle of the cable, 1 at its edges
  const round = Math.sqrt(Math.max(0, 1 - across * across)); // its curve, lit from the front
  const braid = 0.75 + 0.25 * Math.sin((u * 64 + v * 6) * Math.PI * 2);
  let c = [0.2, 0.17, 0.15].map((k) => k * (0.35 + 0.65 * round) * braid);
  const collar = Math.max(smooth(0.03, 0.015, Math.abs(u - 0.5)), smooth(0.03, 0.015, Math.min(u, 1 - u)));
  c = mix(c, [0.32, 0.26, 0.22].map((k) => k * (0.5 + 0.5 * round)), collar);
  // a red lamp on each collar, the sky's aviation red
  const lamp = Math.exp(-(((Math.min(Math.abs(u - 0.5), Math.min(u, 1 - u)) * 256) / 3) ** 2) - ((Math.abs(v - 0.5) * 64) / 3) ** 2);
  return c.map((k, i) => k + [1, 0.14, 0.08][i] * lamp);
});

// one soft cloud bank, round at its edges, for the drifting trains (not scrolled, so it need not wrap)
const bank = picture(256, 256, (u, v) => {
  const r = Math.hypot(u - 0.5, (v - 0.5) * 1.3) * 2;
  const shape = pfbm(u, v, 3, 3, 41, 4) - r * 0.55;
  const dense = smooth(0.08, 0.38, shape);
  return mix(SEA, CLOUD_LIT, smooth(0.25, 0.5, shape)).map((c) => c * dense);
});

/** The lift's textures, as writeWad takes them. */
export const LIFT_TEXTURES = [
  { name: "SCROLLCLOUD", image: cloud },
  { name: "SCROLLSTREAK", image: streak },
  { name: "SCROLLTETHER", image: tether },
  { name: "CLOUDBANK", image: bank },
];
