// The Mech arms' paint: flat, hand-painted dark gunmetal with hazard-yellow accents, drawn into zones of one picture.
// Every function takes pixels of its zone (u along, v round) and gives a colour (0 to 1); nothing here is another
// author's work.
import * as K from "file:///D:/Downloads/TSM/smak/src/index.mjs";

export const W = K.workshop;
const { fbm, noise, mix, times, cylinderLight } = W;
export { mix, times, noise, fbm, cylinderLight };

export const STEEL = [0.2, 0.215, 0.24];
export const DARK = [0.06, 0.065, 0.075];
export const WORN = [0.52, 0.54, 0.58];
export const YELLOW = [0.86, 0.66, 0.1];
export const BRASS = [0.66, 0.48, 0.16];
export const RUBBER = [0.075, 0.08, 0.09];
export const AMBER = [0.95, 0.6, 0.15];

/** A shelf packer: zones of the given sizes laid left to right, a shelf at a time, in a picture of `size` square. */
export function pack(size, list, gap = 8) {
  const zones = {};
  let x = gap, y = gap, shelf = 0;
  for (const [name, w, h] of list) {
    if (x + w + gap > size) { x = gap; y += shelf + gap; shelf = 0; }
    if (y + h + gap > size) throw new Error(`the picture is full at ${name} (y ${y}, h ${h})`);
    zones[name] = { x, y, w, h };
    x += w + gap;
    shelf = Math.max(shelf, h);
  }
  return zones;
}

/** Dark gunmetal: a faint grain, long scratches and a few bright chips, `light` times as bright. */
export function gunmetal(u, v, seed = 1, light = 1, tone = STEEL) {
  let k = 0.97 + 0.05 * (fbm(u * 0.1, v * 0.1, seed, 3) - 0.5) * 2;
  k += 0.025 * (noise(u * 1.3, v * 1.3, seed + 3) - 0.5);
  let c = times(tone, k * light);
  if (noise(u * 0.16, v * 12, seed + 9) > 0.92) c = mix(c, WORN, 0.2);
  if (noise(u * 8 + 4, v * 0.2, seed + 11) > 0.95) c = times(c, 0.8);
  if (noise(u * 0.8, v * 0.8, seed + 13) > 0.975) c = mix(c, WORN, 0.3);
  return c;
}
/** 1 on an edge of a zone (or of a rectangle `z` = { w, h }), 0 inside, over `w` pixels. */
export const edge = (u, v, z, w = 2) => 1 - Math.min(1, Math.min(u, v, z.w - 1 - u, z.h - 1 - v) / w);
/** A rivet or bolt head at (x, y): bright on its upper left, dark round it. */
export function bolt(c, u, v, x, y, r = 2.2) {
  const d = Math.hypot(u - x, v - y);
  if (d > r * 1.5) return c;
  if (d > r) return times(c, 0.62);
  return times(c, 1.22 + 0.3 * Math.max(0, (x - u + (y - v)) / (2 * r)));
}
/** A groove: dark line `w` wide where `d` is 0, with a bright lip on its far side. */
export function groove(c, d, w = 1.1) {
  if (Math.abs(d) < w) return times(c, 0.45);
  if (d > w && d < w + 0.9) return times(c, 1.22);
  return c;
}
/** A box `l` by `t` centred at (x, y): `fill` inside it, a bright lip along its lower edge. */
export function inset(c, u, v, x, y, l, t, fill) {
  const du = Math.abs(u - x), dv = v - y;
  if (du < l / 2 && Math.abs(dv) < t / 2) return fill;
  if (du < l / 2 + 0.8 && dv >= t / 2 && dv < t / 2 + 1.1) return times(c, 1.3);
  return c;
}
/** Diagonal hazard stripes: yellow and black, `w` pixels a stripe. */
export function hazard(u, v, w = 7, slant = 1) {
  return Math.floor((u + v * slant) / w) % 2 === 0 ? [0.84, 0.64, 0.1] : times(DARK, 1.25);
}
/** A cylinder's shading across it (`across` 0 to 1 round the zone's v), for a pipe or a round bar. */
export const roundShade = (across, strength = 0.5) => 0.62 + 0.75 * cylinderLight(across, strength);

/** Brass casing, lit round its length: lighter along one side, a darker ring at the base. */
export function brass(u, v, z) {
  const across = v / z.h;
  let c = times(BRASS, 0.42 + 0.62 * cylinderLight(across, 0.55));
  if (u / z.w < 0.1) c = times(c, 0.55);
  if (u / z.w > 0.88) c = mix(c, [0.45, 0.3, 0.12], 0.7);
  return c;
}

/**
 * The side accent, a band across a zone: `across` is the pixel across the stripe (0 to `width`), `along` the pixel
 * down its length. default: hazard yellow and black. msr and insurgent: the side's colour as a flat band with a dark
 * rim and a lit lip, a rivet every 20 pixels.
 */
export function accent(across, along, width, rgb) {
  if (across < 1.5 || across > width - 2.5) return times(DARK, 1.2);
  if (!rgb) return hazard(across, along, 6, 1);
  let c = rgb;
  if (across < 3.4) c = times(c, 1.1);
  if (across > width - 5) c = times(c, 0.84);
  const d = Math.hypot(across - width / 2, (along % 20) - 10);
  if (d < 2.4) c = times(c, 0.55 + 0.25 * (d / 2.4));
  return c;
}
