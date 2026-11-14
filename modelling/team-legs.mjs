// The body of the kung fu viewmodel, one set for each side: MSR, the Insurgents, and a default for anyone on neither.
//
// WHAT IT MAKES. v_melee.mdl (the kicks) is the one first-person model with a body: besides the hands picture (arms256.bmp) it
// carries seal_body.bmp, the "seal" merc's atlas (black vest, olive cargo pants with thigh straps and pouches, black laced
// boots). In first person only the kicking leg is ever on the screen: thigh with its straps, knee, boot. This module turns that
// atlas into one picture per set, with the stock picture's folds, straps, pouches and laces kept, and team-hands.mjs writes it
// into the model copy beside the set's hands picture (models/matchmode/<set>/v_melee.mdl). The game's own model is never written.
//
// THE SETS
//     default     black military cargo pants and glossy black jackboots; nothing else.
//     msr         the RepuHeavy look (models/player/RepuHeavy, the MSR team model): near-black cool pants, a gunmetal knee plate, and
//                 the blue band under the knee, where that model wears its blue glow; gunmetal boots.
//     insurgent   the XCCP look (models/player/XCCPSoldier-wartorn, the Insurgent team model): dark grey digital camouflage pants,
//                 a dark knee plate, and the GREEN knee guard under it, where that model wears its green; grey boots.
// The blue and the green are the donors' own colours (the ramps below are their pixels, by brightness): the same two hues as the cuffs
// of the msr and insurgent hands, so a side reads the same from the sleeve to the boot.
//
// HOW. The atlas is 8-bit and almost every palette entry is shared between the pants, the boots and the vest, so no palette edit
// can recolour the legs alone. The picture is rebuilt instead: each leg texel keeps its stock brightness (the folds), run through a
// tone curve per set, with the set's colour put on top; the knee plate and the band are drawn by where they sit on the body (the
// texel's point on the model, measured in the idle pose), so they follow the leg and not the layout of the atlas; and the
// result is cut back to 256 colours by a weighted k-means that spends its entries on the legs, the part that is ever on screen.
// Nothing is random: the same stock model gives the same bytes.
//
// The regions are found from the model itself (K.paint reports each texel's island, bone and point). The island numbers below are
// the ones of the stock atlas, and legPictures() refuses a model whose islands do not stand where they are expected.
//
//   node modelling/team-legs.mjs --donors <player model> <blue|green>     the donor's accent colours again (see BLUE and GREEN)
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { K } from "./lib.mjs";

export const BODY = "seal_body.bmp";
export const BODY_SETS = ["msr", "insurgent", "default"];

const IDLE = { seq: 0, frame: 0 };
// islands of the stock atlas: the trousers, the two hex caps at the hips, the boots (front and side), the soles, and the vest
// (front, back), whose olive undershirt is recoloured with the pants fabric so the whole atlas agrees, though no view model frame shows it
const ISLANDS = { fabric: [4, 8, 9], boot: [3, 5], sole: [6], vest: [2, 7] };
export const KIND = { none: 0, fabric: 1, boot: 2, sole: 3, shirt: 4 };
const MARGIN = 2;          // texels around an island that take the island's colours (the filter reads them at an island's edge)

// ---- the donors' colours -----------------------------------------------------------------------------------------------------
// Pixels of the donor's leg below the thigh (z under -12 in the standing pose) that are blue (RepuHeavy) or green
// (XCCPSoldier-wartorn), by brightness: the mean of a 2% window around each of the quantiles 2, 10, 25, 40, 55, 70, 85, 95, 99 %.
// `node modelling/team-legs.mjs --donors RepuHeavy blue` and `--donors XCCPSoldier-wartorn green` sample them again.
export const BLUE = [[4, 62, 121], [6, 75, 136], [12, 85, 144], [5, 95, 144], [19, 101, 163], [9, 134, 178], [22, 132, 186], [13, 171, 198], [15, 208, 215]];
export const GREEN = [[19, 75, 10], [27, 75, 23], [37, 90, 19], [35, 106, 18], [48, 115, 32], [71, 113, 60], [74, 129, 45], [95, 141, 76], [111, 161, 73]];

// ---- small helpers ----------------------------------------------------------------------------------------------------------
export const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
export const mix = (a, b, t) => a + (b - a) * t;
export const smooth = (lo, hi, v) => {
  const t = clamp((v - lo) / (hi - lo));
  return t * t * (3 - 2 * t);
};
export const luma = (r, g, b) => r * 0.3 + g * 0.59 + b * 0.11;

/** A tone curve through [in, out] knots, straight between them. */
function curve(knots) {
  return (y) => {
    if (y <= knots[0][0]) return knots[0][1];
    for (let i = 1; i < knots.length; i++) {
      if (y <= knots[i][0]) {
        const [x0, y0] = knots[i - 1];
        const [x1, y1] = knots[i];
        return y0 + ((y - x0) / (x1 - x0)) * (y1 - y0);
      }
    }
    return knots[knots.length - 1][1];
  };
}

/** The colour a fraction t of the way through a list of colours. */
export function rampAt(list, t) {
  const x = clamp(t) * (list.length - 1);
  const i = Math.min(list.length - 2, Math.floor(x));
  const f = x - i;
  return [0, 1, 2].map((k) => mix(list[i][k], list[i + 1][k], f));
}

/** A number in [0, 1) from two integers and a seed: the same every time. */
export function hash(ix, iy, seed) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(seed | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export function valueNoise(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  return mix(
    mix(hash(ix, iy, seed), hash(ix + 1, iy, seed), sx),
    mix(hash(ix, iy + 1, seed), hash(ix + 1, iy + 1, seed), sx),
    sy,
  );
}
export function fbm(x, y, seed, octaves = 3) {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x * freq, y * freq, seed + o * 17);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

// ---- the sets ---------------------------------------------------------------------------------------------------------------
// Tone curves are [stock brightness, new brightness] knots. The stock pants run p5 8, p25 24, p50 33, p75 42, p95 53 (max 105, the
// buckles); the stock boots p50 10, p95 44 (max 89, the laces). Brightness is the 0.3 / 0.59 / 0.11 sum.
// The default is as dark as the stock vest (black, pants p50 17, boots p50 9 with highlights lifted for the gloss). The msr and
// insurgent pants are set to the donors' own brightness on their legs: RepuHeavy's trousers run mean 20 and p95 45, XCCP's mean 27 and
// p95 66-79 (its camouflage), both neutral grey; the result is p50 24 / p95 46 and p50 29 / p95 69, knee plates and camouflage included.
const SETS = {
  default: {
    fabric: curve([[0, 0], [6, 2], [12, 6], [24, 12], [33, 17], [42, 23], [53, 31], [75, 52], [105, 96], [255, 255]]),
    boot: curve([[0, 0], [4, 3], [10, 9], [18, 19], [30, 41], [46, 70], [70, 110], [89, 148], [255, 255]]),
    sole: curve([[0, 0], [10, 4], [26, 13], [48, 30], [72, 56], [255, 255]]),
    tint: [1, 1, 1],
  },
  msr: {
    fabric: curve([[0, 0], [6, 3], [12, 8], [24, 16], [33, 22], [42, 30], [53, 40], [75, 62], [105, 100], [255, 255]]),
    boot: curve([[0, 1], [4, 6], [10, 15], [18, 26], [30, 42], [46, 66], [70, 102], [89, 130], [255, 255]]),
    sole: curve([[0, 0], [10, 6], [26, 16], [48, 34], [72, 58], [255, 255]]),
    tint: [0.96, 0.99, 1.05],
    plate: { base: [38, 41, 47], rim: [13, 14, 18], light: [86, 92, 104], half: [3.1, 4.0], corner: 1.5, lift: -0.2 },
    band: { ramp: BLUE, top: 0.9, height: 5.6 },
  },
  insurgent: {
    fabric: curve([[0, 0], [6, 3], [12, 10], [24, 22], [33, 30], [42, 39], [53, 50], [75, 72], [105, 105], [255, 255]]),
    boot: curve([[0, 1], [4, 6], [10, 17], [18, 29], [30, 46], [46, 70], [70, 104], [89, 130], [255, 255]]),
    sole: curve([[0, 0], [10, 6], [26, 16], [48, 34], [72, 58], [255, 255]]),
    tint: [1, 1, 1],
    camo: { block: 6, factors: [0.62, 1, 1.65] },
    plate: { base: [30, 31, 31], rim: [11, 12, 12], light: [74, 76, 76], half: [3.1, 4.0], corner: 1.5, lift: -0.2 },
    band: { ramp: GREEN, top: 0.9, height: 5.6 },
  },
};

// ---- the stock atlas, read ---------------------------------------------------------------------------------------------------
/** Each texel of the picture as the model's triangles cover it, in the idle pose: island, point on the model, facing. */
export function texelMap(mdl, width, height) {
  const n = width * height;
  const map = { island: new Int16Array(n).fill(-1), p: new Float32Array(n * 3), n: new Float32Array(n * 3) };
  K.paint(
    mdl,
    (q) => {
      const x = Math.floor(q.u), y = Math.floor(q.v);
      if (x < 0 || y < 0 || x >= width || y >= height) return undefined;
      const i = y * width + x;
      if (map.island[i] >= 0) return undefined;       // the first triangle to reach a texel stands
      map.island[i] = q.island;
      map.p.set(q.p, i * 3);
      map.n.set(q.n, i * 3);
      return undefined;
    },
    { pose: IDLE, only: [BODY] },
  );
  return map;
}

/** Where the knee joints are in the idle pose: the origins of the two calf bones. */
export function kneePoints(mdl) {
  const names = K.bones(mdl).map((b) => b.name);
  const pose = K.poseAt(mdl, IDLE.seq, IDLE.frame);
  return ["Bone50", "Bone51"].map((name) => {
    const i = names.indexOf(name);
    if (i < 0) throw new Error(`${BODY}: the model has no bone ${name} (a calf)`);
    return [pose[i][0][3], pose[i][1][3], pose[i][2][3]];
  });
}

/** The texel kinds, with the islands checked against where the stock atlas has them. `stock` is the stock picture, float RGB. */
export function regionsOf(map, stock, width, height) {
  const n = width * height;
  const zs = new Map();
  for (let i = 0; i < n; i++) {
    const id = map.island[i];
    if (id < 0) continue;
    const z = map.p[i * 3 + 2];
    const e = zs.get(id) ?? { lo: Infinity, hi: -Infinity, n: 0 };
    e.lo = Math.min(e.lo, z);
    e.hi = Math.max(e.hi, z);
    e.n++;
    zs.set(id, e);
  }
  const want = (id, ok, what) => {
    const e = zs.get(id);
    if (!e || !ok(e)) throw new Error(`${BODY}: island ${id} is not ${what}; this recolour is made for the stock atlas`);
  };
  want(4, (e) => e.lo < -46 && e.hi > -25 && e.n > 30000, "the trousers (z -48 to -21, over 30000 texels)");
  for (const id of ISLANDS.boot) want(id, (e) => e.hi < -44 && e.lo < -64, "a boot (z -66 to -46)");
  want(6, (e) => e.lo < -64 && e.hi < -60, "the soles (z about -65)");
  for (const id of [8, 9]) want(id, (e) => e.lo > -14 && e.n < 3000, "a hip cap (above z -14)");
  for (const id of ISLANDS.vest) want(id, (e) => e.lo > -26 && e.n > 15000, "a vest panel (above z -26, over 15000 texels)");

  const kind = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const id = map.island[i];
    if (ISLANDS.fabric.includes(id)) kind[i] = KIND.fabric;
    else if (ISLANDS.boot.includes(id)) kind[i] = KIND.boot;
    else if (ISLANDS.sole.includes(id)) kind[i] = KIND.sole;
  }
  // the margin: which ring of texels around the islands each texel is (0 = covered by a triangle), and the kind it takes
  const ring = new Uint8Array(n);
  let frontier = kind.map((k) => (k ? 1 : 0));
  for (let r = 1; r <= MARGIN; r++) {
    const added = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (kind[i]) continue;
        const votes = [0, 0, 0, 0];
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
            const j = yy * width + xx;
            if (frontier[j] && kind[j]) votes[kind[j]]++;
          }
        }
        const best = votes.indexOf(Math.max(...votes.slice(1)), 1);
        if (votes[best] > 0) added.push([i, best]);
      }
    }
    for (const [i, k] of added) {
      kind[i] = k;
      ring[i] = r;
    }
    frontier = kind.map((k, i) => (k && ring[i] === r ? 1 : 0));
  }
  // the vest's olive undershirt and webbing: the olive texels of the vest islands that at least two of their neighbours are too (a lone
  // olive speckle in the black of the vest stays vest)
  const olive = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!ISLANDS.vest.includes(map.island[i])) continue;
    const r = stock[i * 3], g = stock[i * 3 + 1], b = stock[i * 3 + 2];
    if (luma(r, g, b) > 18 && g > 0 && (g - b) / g > 0.17 && Math.abs(r - g) / g < 0.2 && g >= r - 6) olive[i] = 1;
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!olive[i]) continue;
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < width && yy < height) count += olive[yy * width + xx];
        }
      }
      if (count >= 3) kind[i] = KIND.shirt;          // itself and two more of the nine
    }
  }
  return { kind, ring };
}

// ---- drawing the legs --------------------------------------------------------------------------------------------------------
/** The pixel's colour for a tone-curved brightness and a tint (a ratio of the three channels, brightness kept). */
function tinted(y, tint) {
  const t = luma(...tint);
  return [(y * tint[0]) / t, (y * tint[1]) / t, (y * tint[2]) / t];
}

/** The digital camouflage factor at a texel: blocks of the set's size, three tones, two scales of blotch. */
function camoFactor(camo, x, y) {
  const bx = Math.floor(x / camo.block), by = Math.floor(y / camo.block);
  const v = 0.6 * valueNoise(bx / 3.1, by / 3.1, 11) + 0.4 * valueNoise(bx / 1.3, by / 1.3, 23);
  return v < 0.43 ? camo.factors[0] : v > 0.56 ? camo.factors[2] : camo.factors[1];
}

/** The knee plate over a pants colour: a rounded plate on the front of the knee, a rim, a bevel light from above. */
function overPlate(col, plate, p, knee, grain) {
  if (p[0] < knee[0] + 1.0) return col;                         // the back of the leg
  const a = p[1] - knee[1];
  const b = p[2] - (knee[2] + plate.lift);
  const qx = Math.abs(a) - (plate.half[0] - plate.corner);
  const qy = Math.abs(b) - (plate.half[1] - plate.corner);
  const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - plate.corner;
  const cover = 1 - smooth(-0.12, 0.12, d);
  if (cover <= 0) return col;
  const rim = smooth(-0.6, 0.0, d);                              // 1 along the edge
  const bevel = Math.exp(-(((d + 0.95) / 0.28) ** 2)) * (0.5 + 0.5 * clamp(-b / plate.half[1], -1, 1));
  const out = [0, 1, 2].map((k) => {
    let v = plate.base[k] * mix(1, grain, 0.4);
    v = mix(v, plate.rim[k], rim * 0.85);
    v = mix(v, plate.light[k], bevel * 0.7);
    return mix(col[k], v, cover);
  });
  return out;
}

/** The coloured band under the knee, on the top of the boot: mottled donor colour, a dark line at each edge, a light one inside. */
function overBand(col, band, zTop, p, x, y) {
  const zt = (zTop - band.top - p[2]) / band.height;             // 0 at the band's top edge, 1 at its bottom edge
  const cover = smooth(-0.04, 0.05, zt) * (1 - smooth(0.95, 1.04, zt));
  if (cover <= 0) return col;
  let t = fbm(x / 2.6, y / 2.6, 5, 3);
  t = smooth(0.22, 0.82, t);
  const base = rampAt(band.ramp, 0.08 + 0.84 * t);
  let shade = 0.72 + 0.4 * Math.sin(Math.PI * clamp(zt));
  if (zt < 0.1 || zt > 0.9) shade *= 0.5;                       // the dark line at each edge
  else if (zt < 0.17) shade *= 1.28;                            // the light just inside the top
  const out = base.map((v) => v * shade);
  return [0, 1, 2].map((k) => mix(col[k], out[k], cover));
}

/** Paints one set over the stock atlas: float RGB for every texel, and the quantiser's weight of each. */
function paintSet(spec, ctx) {
  const { width, height, stock, map, kind, ring, knees, zBootTop } = ctx;
  const n = width * height;
  const out = Float32Array.from(stock);
  for (let i = 0; i < n; i++) {
    if (!kind[i] || ring[i]) continue;
    const x = i % width, y = (i / width) | 0;
    const Y = luma(stock[i * 3], stock[i * 3 + 1], stock[i * 3 + 2]);
    const p = [map.p[i * 3], map.p[i * 3 + 1], map.p[i * 3 + 2]];
    let col;
    if (kind[i] === KIND.fabric) {
      let y2 = spec.fabric(Y);
      // the camouflage tints the cloth, not the metal of the buckles (stock brightness over 60 is metal, not cloth)
      if (spec.camo) y2 *= mix(camoFactor(spec.camo, x, y), 1, smooth(60, 95, Y));
      col = tinted(y2, spec.tint);
      if (spec.plate && p[2] > -49) {
        const knee = knees.reduce((best, k) => (Math.abs(k[1] - p[1]) < Math.abs(best[1] - p[1]) ? k : best));
        col = overPlate(col, spec.plate, p, knee, clamp(Y / 33, 0.55, 1.5));
      }
    } else if (kind[i] === KIND.boot) {
      col = tinted(spec.boot(Y), spec.tint);
      if (spec.band) col = overBand(col, spec.band, zBootTop, p, x, y);
    } else if (kind[i] === KIND.shirt) {
      col = tinted(spec.fabric(Y), spec.tint);
    } else {
      col = tinted(spec.sole(Y), spec.tint);
    }
    out.set(col, i * 3);
  }
  bleedMargin(out, kind, ring, width, height);
  return out;
}

/** The margin takes the colours of the texels inside it, ring by ring, so an island's edge filters into its own colour. */
export function bleedMargin(out, kind, ring, width, height) {
  for (let r = 1; r <= MARGIN; r++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (ring[i] !== r) continue;
        const sum = [0, 0, 0];
        let count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
            const j = yy * width + xx;
            if (kind[j] !== kind[i] || ring[j] >= r) continue;
            for (let k = 0; k < 3; k++) sum[k] += out[j * 3 + k];
            count++;
          }
        }
        if (count) for (let k = 0; k < 3; k++) out[i * 3 + k] = sum[k] / count;
      }
    }
  }
}

// ---- 256 colours ------------------------------------------------------------------------------------------------------------
const CW = [1, 1, 0.85];                                       // channel weights of the quantiser's colour distance
const perceptual = (c) => Math.sqrt(c / 255);

/**
 * The picture cut to 256 colours: weighted k-means over the colours it uses (in a square-root space, so the dark colours this
 * atlas is made of keep their steps), started from the weighted farthest-point choice; each pixel then takes the nearest of the
 * rounded palette colours. `weight` is how much each pixel counts. Returns { palette, pixels, error } where error is the mean
 * absolute error in levels, over the pixels of weight 1 and over the others.
 */
export function quantise(rgb, weight, colours = 256) {
  const n = weight.length;
  const key = new Uint32Array(n);
  const bins = new Map();
  for (let i = 0; i < n; i++) {
    const r = Math.round(clamp(rgb[i * 3], 0, 255)), g = Math.round(clamp(rgb[i * 3 + 1], 0, 255)), b = Math.round(clamp(rgb[i * 3 + 2], 0, 255));
    key[i] = (r << 16) | (g << 8) | b;
    bins.set(key[i], (bins.get(key[i]) ?? 0) + weight[i]);
  }
  const uniq = [...bins.keys()].sort((a, b) => a - b);
  const m = uniq.length;
  const raw = uniq.map((k) => [k >> 16, (k >> 8) & 255, k & 255]);
  const pts = raw.map((c) => c.map((v, k) => perceptual(v) * CW[k]));
  const w = uniq.map((k) => bins.get(k));
  const dist = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

  let centres;
  if (m <= colours) {
    centres = pts.map((p) => p.slice());
  } else {
    centres = [];
    const near = new Float64Array(m).fill(Infinity);
    let next = w.indexOf(Math.max(...w));
    while (centres.length < colours) {
      const c = pts[next].slice();
      centres.push(c);
      let best = -1, bestScore = -1;
      for (let i = 0; i < m; i++) {
        near[i] = Math.min(near[i], dist(pts[i], c));
        const score = w[i] * near[i];
        if (score > bestScore) {
          bestScore = score;
          best = i;
        }
      }
      next = best;
    }
    const owner = new Int32Array(m);
    for (let iter = 0; iter < 30; iter++) {
      let moved = 0;
      const sum = centres.map(() => [0, 0, 0, 0]);
      for (let i = 0; i < m; i++) {
        let bestC = 0, bestD = Infinity;
        for (let c = 0; c < centres.length; c++) {
          const d = dist(pts[i], centres[c]);
          if (d < bestD) {
            bestD = d;
            bestC = c;
          }
        }
        if (owner[i] !== bestC) moved++;
        owner[i] = bestC;
        const s = sum[bestC];
        s[0] += pts[i][0] * w[i];
        s[1] += pts[i][1] * w[i];
        s[2] += pts[i][2] * w[i];
        s[3] += w[i];
      }
      centres.forEach((c, k) => {
        if (sum[k][3] > 0) {
          c[0] = sum[k][0] / sum[k][3];
          c[1] = sum[k][1] / sum[k][3];
          c[2] = sum[k][2] / sum[k][3];
        }
      });
      if (!moved) break;
    }
  }
  // the palette: the centres back in RGB, rounded, dark to light
  const palette = centres
    .map((c) => c.map((v, k) => Math.round(clamp((v / CW[k]) ** 2 * 255, 0, 255))))
    .sort((a, b) => luma(...a) - luma(...b) || a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const pal = palette.map((c) => c.map((v, k) => perceptual(v) * CW[k]));
  const entryOf = new Map();
  uniq.forEach((k, idx) => {
    let bestC = 0, bestD = Infinity;
    for (let c = 0; c < pal.length; c++) {
      const d = dist(pts[idx], pal[c]);
      if (d < bestD) {
        bestD = d;
        bestC = c;
      }
    }
    entryOf.set(k, bestC);
  });
  const pixels = new Uint8Array(n);
  const pbytes = new Uint8Array(768);
  palette.forEach((c, i) => pbytes.set(c, i * 3));
  const err = { legs: [0, 0], rest: [0, 0] };
  for (let i = 0; i < n; i++) {
    const e = entryOf.get(key[i]);
    pixels[i] = e;
    const at = weight[i] >= 0.9 ? err.legs : err.rest;
    at[0] += (Math.abs(pbytes[e * 3] - rgb[i * 3]) + Math.abs(pbytes[e * 3 + 1] - rgb[i * 3 + 1]) + Math.abs(pbytes[e * 3 + 2] - rgb[i * 3 + 2])) / 3;
    at[1]++;
  }
  return {
    palette: pbytes,
    pixels,
    error: { legs: err.legs[0] / Math.max(1, err.legs[1]), rest: err.rest[0] / Math.max(1, err.rest[1]) },
    used: palette.length,
  };
}

// ---- the pictures --------------------------------------------------------------------------------------------------------------
/**
 * The three body pictures for a stock model: { msr, insurgent, default } as 8-bit textures ({ width, height, pixels, palette,
 * flags }) the size of the stock seal_body.bmp, and a report of how well each fits its 256 colours.
 */
export function legPictures(mdl) {
  const old = K.textureOf(mdl, BODY);
  const { width, height } = old;
  const n = width * height;
  const stock = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) stock[i * 3 + k] = old.palette[old.pixels[i] * 3 + k];
  }
  const map = texelMap(mdl, width, height);
  const { kind, ring } = regionsOf(map, stock, width, height);
  const knees = kneePoints(mdl);
  let zBootTop = -Infinity;
  for (let i = 0; i < n; i++) if (kind[i] === KIND.boot && !ring[i]) zBootTop = Math.max(zBootTop, map.p[i * 3 + 2]);

  // what the quantiser spends its colours on: the legs (and the margin the filter reads), then what the model shows elsewhere, then nothing
  const weight = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const leg = kind[i] && kind[i] !== KIND.shirt;
    weight[i] = leg ? (ring[i] ? 0.3 : 1) : map.island[i] >= 0 ? 0.05 : 0.01;
  }

  const ctx = { width, height, stock, map, kind, ring, knees, zBootTop };
  const out = { report: {} };
  for (const set of BODY_SETS) {
    const rgb = paintSet(SETS[set], ctx);
    const q = quantise(rgb, weight);
    out[set] = { width, height, pixels: q.pixels, palette: q.palette, flags: old.flags };
    out.report[set] = { colours: q.used, errorLegs: +q.error.legs.toFixed(2), errorRest: +q.error.rest.toFixed(2) };
  }
  return out;
}

/**
 * Contact sheet of the kicks as the player sees them (the kit's first-person view), one column for each model of `list`
 * ([[name, model], ...]) and one row for each of the kick frames below.
 */
export const KICK_FRAMES = [[5, 4], [5, 7], [6, 5], [8, 4], [8, 7]];
export function kickSheet(list, { width = 320, height = 240 } = {}) {
  const shots = [];
  const names = [];
  for (const [seq, frame] of KICK_FRAMES) {
    for (const [name, mdl] of list) {
      shots.push(K.render(mdl, { view: "first", seq, frame, width, height, fov: 90, near: 4 }));
      names.push(`${name} ${K.sequences(mdl)[seq].name} ${frame}`);
    }
  }
  return K.tile(shots, list.length, names);
}

// ---- the donors' colours, sampled again ----------------------------------------------------------------------------------------
const HERE = dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const at = process.argv.indexOf("--donors");
  const [name, kind] = at >= 0 ? process.argv.slice(at + 1) : [];
  if (!name || !["blue", "green"].includes(kind)) {
    console.error("usage: node modelling/team-legs.mjs --donors <player model, e.g. RepuHeavy> <blue|green>");
    process.exit(2);
  }
  const dir = join(resolve(process.env.H9_GAME ?? join(HERE, "..", "H9XASH", "ts")), "models", "player", name);
  const file = join(dir, `${name}.mdl`);
  if (!existsSync(file)) {
    console.error(`no model at ${file}`);
    process.exit(1);
  }
  const raw = readFileSync(file);
  const textures = join(dir, `${name}t.mdl`);
  const donor = existsSync(textures) ? K.withTextures(raw, readFileSync(textures)) : raw;
  const bones = K.bones(donor).map((b) => b.name);
  const isLeg = (b) => /Coscia|Polpaccio|Piede/.test(bones[b]);
  const wanted = kind === "blue" ? (r, g, b) => b > r + 40 && b > g + 5 && b > 80 : (r, g, b) => g > r + 30 && g > b + 30 && g > 70;
  const found = [];
  K.paint(
    donor,
    (q) => {
      const [r, g, b] = q.rgb.map((v) => v * 255);
      if (isLeg(q.boneIndex) && q.p[2] < -12 && wanted(r, g, b)) found.push([r, g, b]);
      return undefined;
    },
    { pose: { seq: 1, frame: 0 } },
  );
  found.sort((a, b) => luma(...a) - luma(...b));
  const ramp = [0.02, 0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 0.95, 0.99].map((f) => {
    const i = Math.floor(found.length * f);
    const w = Math.max(1, Math.floor(found.length * 0.01));
    const part = found.slice(Math.max(0, i - w), Math.min(found.length, i + w));
    return [0, 1, 2].map((k) => Math.round(part.reduce((s, c) => s + c[k], 0) / part.length));
  });
  console.log(`${name}: ${found.length} ${kind} pixels on the leg`);
  console.log(`const ${kind.toUpperCase()} = ${JSON.stringify(ramp).replace(/\],\[/g, "], [")};`);
}
