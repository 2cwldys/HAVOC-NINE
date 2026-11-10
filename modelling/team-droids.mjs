// The droids' first-person arms and kicking legs: two more sets beside msr, insurgent and default.
//
// WHO. A player whose model is one of the droids (models/player/msrdroid_bot, models/player/insdroid_bot) sees a droid's arms in
// every viewmodel and, in the kung fu kicks, a droid's legs, not the human merc's gloves and trousers. ts_matchmode.sma points the
// client at the set by the model the player wears (the msr droid set for an msrdroid, the insurgent one for an insdroid). The sets are
// written by team-hands.mjs, which calls this module, to models/matchmode/msrdroid/ and models/matchmode/insdroid/ beside the others.
//
// WHAT THEY LOOK LIKE. The plating is the droid's own: the colours of the droid model's forearm, upper arm, thigh and calf texels
// (sampled from models/player/<droid>/<droid>.mdl, its atlas through its UV layout, by brightness: steel grey with an olive cast for
// the msrdroid, bronze for the insdroid). The arm picture (arms256.bmp, 256 and the 512 of v_melee) is the same layout as the human
// sets' and is painted over the stock picture's own zones: the fingertips (segmented metal, a dark rubber pad at the tip), the back of
// the hand (knuckle plates, a plated back, a ridged wrist guard) and the forearm (a wrist ring, two plates with bolts and vents, a
// hydraulic piston down the middle, a cabled joint at the elbow end). The body picture of v_melee (seal_body.bmp) is painted by where
// each texel sits on the leg, in the idle pose: thigh plates, an exposed knee joint with a piston and hinge discs, shin plates with
// vents, an ankle joint, a metal foot with a plated instep and a grooved sole. The side shows in thin lights, not in the metal: the
// wrist band and a few status lights on the arm, a thin ring under the knee and one on the shin on the leg. MSR blue, insurgent green
// (the ramps of team-legs.mjs, the ones of the human sets' bands), so a droid's side still reads.
//
// HOW. Nothing is random: every pattern is a function of the texel (a hash for the grain), so the same inputs give the same bytes. The
// pictures are cut to 256 colours by team-legs.mjs's quantiser. The stock arms pictures are read from the game's own v_ak47.mdl (256)
// and v_melee.mdl (512), the layout every viewmodel shares.
//
//   node modelling/team-droids.mjs --sample <msrdroid_bot|insdroid_bot>     the droid's plating colours, as the ramp used here
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { K } from "./lib.mjs";
import { clamp, smooth, luma, hash, rampAt, quantise, KIND, texelMap, regionsOf, kneePoints, bleedMargin, BODY, BLUE, GREEN } from "./team-legs.mjs";

export const DROID_SETS = ["msrdroid", "insdroid"];
const PLAYERS = { msrdroid: "msrdroid_bot", insdroid: "insdroid_bot" };
const ACCENTS = { msrdroid: BLUE, insdroid: GREEN };
const IDLE = { seq: 1, frame: 0 };

// ---- the droids' plating, sampled -------------------------------------------------------------------------------------------
const samples = new Map();

/**
 * The colours of a droid player model's plating by brightness: the texels of its forearms, upper arms, thighs and calves (by the
 * bone each follows, standing pose), nine entries, the mean of a 2% window around the quantiles 3, 15, 30, 45, 60, 75, 88, 96, 99.5 %,
 * darkest first. { ramp, count }. Read once a run.
 */
export function sampleDroid(game, player) {
  const key = `${game}|${player}`;
  if (!samples.has(key)) samples.set(key, sampleOnce(game, player));
  return samples.get(key);
}

function sampleOnce(game, player) {
  const dir = join(game, "models", "player", player);
  const file = join(dir, `${player}.mdl`);
  if (!existsSync(file)) throw new Error(`no droid model at ${file}`);
  const raw = readFileSync(file);
  const textures = join(dir, `${player}t.mdl`);
  const mdl = existsSync(textures) ? K.withTextures(raw, readFileSync(textures)) : raw;
  const bones = K.bones(mdl).map((b) => b.name);
  const plating = /Avambraccio|Braccio superiore|Coscia|Polpaccio/;
  const seen = new Set();
  const found = [];
  K.paint(
    mdl,
    (q) => {
      if (!/droid\.bmp$/i.test(q.tex) || !plating.test(bones[q.boneIndex])) return undefined;
      const key = `${Math.floor(q.u)},${Math.floor(q.v)}`;
      if (seen.has(key)) return undefined;
      seen.add(key);
      found.push(q.rgb.map((v) => Math.round(v * 255)));
      return undefined;
    },
    { pose: IDLE },
  );
  if (found.length < 1000) throw new Error(`${player}: only ${found.length} plating texels found; is this the droid model?`);
  found.sort((a, b) => luma(...a) - luma(...b) || a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const ramp = [0.03, 0.15, 0.3, 0.45, 0.6, 0.75, 0.88, 0.96, 0.995].map((f) => {
    const i = Math.floor(found.length * f);
    const w = Math.max(1, Math.floor(found.length * 0.01));
    const part = found.slice(Math.max(0, i - w), Math.min(found.length, i + w));
    return [0, 1, 2].map((k) => Math.round(part.reduce((s, c) => s + c[k], 0) / part.length));
  });
  return { ramp, count: found.length };
}

/** What the painters use: the plating ramp as a function of a tone 0 (darkest) to 1 (lightest), and the side's glow. */
function lookOf(set, sampled) {
  const accent = ACCENTS[set];
  return {
    metal: (t) => rampAt(sampled.ramp, clamp(t)),
    // the side's light: the bright end of the side's ramp, brighter again at the core (k 1)
    glow: (k) => rampAt(accent, 0.55 + 0.45 * clamp(k)).map((v) => clamp(v * (1 + 0.55 * k), 0, 255)),
    accent,
  };
}

// ---- small drawing helpers ---------------------------------------------------------------------------------------------------
/** A pixel-scale grain: 0 at no grain, a value in [-1, 1] that holds over blocks of `block` texels. */
const grain = (x, y, seed, block = 1) => hash(Math.floor(x / block), Math.floor(y / block), seed) * 2 - 1;

/** The colour of one texel from a tone, a grain amplitude, and the texel. */
const metalAt = (look, t, x, y, amp = 0.05, seed = 7) => look.metal(t + grain(x, y, seed) * amp + grain(x, y, seed + 3, 2) * amp * 0.6);

// ---- the arms ----------------------------------------------------------------------------------------------------------------
/** The stock arms picture of a viewmodel read for painting: coverage, glove run of every column, finger gaps. */
function armInfo(game, file) {
  const mdl = readFileSync(join(game, "models", file));
  const tex = K.textureOf(mdl, "arms256.bmp");
  const W = tex.width, H = tex.height;
  const island = new Int16Array(W * H).fill(-1);
  K.paint(
    mdl,
    (q) => {
      const x = Math.floor(q.u), y = Math.floor(q.v);
      if (x >= 0 && y >= 0 && x < W && y < H && island[y * W + x] < 0) island[y * W + x] = q.island;
      return undefined;
    },
    { pose: { seq: 0, frame: 0 }, only: ["arms256.bmp"] },
  );
  // glove texels of the stock picture: dark and not reddish; skin is the rest
  const glove = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (island[i] < 0) continue;
    const r = tex.palette[tex.pixels[i] * 3], g = tex.palette[tex.pixels[i] * 3 + 1], b = tex.palette[tex.pixels[i] * 3 + 2];
    const Y = luma(r, g, b);
    glove[i] = !(r > b + 18 && r > g + 8 && Y > 45) && Y < 75 ? 1 : 0;
  }
  // per island and column: the first and last row covered, and the longest run of glove (gaps up to 3 rows closed)
  const ids = [...new Set(island)].filter((v) => v >= 0).sort((a, b) => a - b);
  const cols = new Map();
  for (const id of ids) {
    const list = new Array(W).fill(null);
    for (let x = 0; x < W; x++) {
      let top = -1, bot = -1, best = [0, -1, -1], run = null, gap = 0;
      for (let y = 0; y < H; y++) {
        const i = y * W + x;
        if (island[i] !== id) continue;
        if (top < 0) top = y;
        bot = y;
        if (glove[i]) {
          if (!run) run = [0, y, y];
          run[2] = y;
          run[0] = run[2] - run[1] + 1;
          gap = 0;
        } else if (run && ++gap > 3) {
          if (run[0] > best[0]) best = run;
          run = null;
          gap = 0;
        }
      }
      if (run && run[0] > best[0]) best = run;
      if (top >= 0) list[x] = { top, bot, g0: best[0] >= W / 16 ? best[1] : -1, g1: best[0] >= W / 16 ? best[2] : -1 };
    }
    // a column with no glove takes its nearest column's
    for (let x = 0; x < W; x++) {
      if (!list[x] || list[x].g0 >= 0) continue;
      for (let d = 1; d < W; d++) {
        const a = list[x - d], b = list[x + d];
        const c = a && a.g0 >= 0 ? a : b && b.g0 >= 0 ? b : null;
        if (c) {
          list[x] = { ...list[x], g0: c.g0, g1: c.g1 };
          break;
        }
      }
    }
    // the stock glove's edge wanders from column to column; the droid's plates follow its median over 13 texels of the 256 layout
    const reach = Math.round(6 * (W / 256));
    const median = (key, x) => {
      const v = [];
      for (let d = -reach; d <= reach; d++) if (list[x + d]) v.push(list[x + d][key]);
      v.sort((a, b) => a - b);
      return v[v.length >> 1];
    };
    const smoothed = list.map((c, x) => (c ? { ...c, g0: median("g0", x), g1: median("g1", x) } : c));
    for (let x = 0; x < W; x++) list[x] = smoothed[x];
    const xs = list.map((c, x) => (c ? x : -1)).filter((x) => x >= 0);
    cols.set(id, { list, xa: xs[0], xb: xs[xs.length - 1] });
  }
  return { W, H, island, cols, S: W / 256 };
}

/**
 * One arms picture of a droid: float RGB for every texel and the quantiser's weight of each. S is the picture's scale against the
 * 256 layout (1 or 2); every measure below is in 256 texels and multiplied by S.
 */
function paintArms(look, info) {
  const { W, H, island, cols, S } = info;
  const rgb = new Float32Array(W * H * 3);
  const covered = new Uint8Array(W * H);
  const dark = look.metal(0.02);
  for (let i = 0; i < W * H; i++) rgb.set(dark.map((v) => v * 0.6), i * 3);
  // the widest island is both arms side by side; any other is a thumb
  const ids = [...cols.keys()];
  const width = (id) => cols.get(id).xb - cols.get(id).xa;
  const mainId = ids.reduce((a, b) => (width(a) >= width(b) ? a : b));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const id = island[y * W + x];
      if (id < 0) continue;
      covered[y * W + x] = 1;
      const info2 = cols.get(id);
      const c = info2.list[x];
      // the arm this column belongs to, its middle and half width
      const main = ids.length > 1 && id === mainId;
      const xmid = (info2.xa + info2.xb) / 2;
      const left = !main || x < xmid;
      const xa = main ? (left ? info2.xa : xmid) : info2.xa;
      const xb = main ? (left ? xmid : info2.xb) : info2.xb;
      const u = ((x - (xa + xb) / 2) / S) | 0;                 // 256 texels from the arm's middle
      const hw = (xb - xa) / 2 / S;                              // its half width
      const un = (x - (xa + xb) / 2) / S / hw;                   // -1 .. 1 across the arm
      let col;
      if (y < c.g0) col = tipTexel(look, y - c.top, x, y, S, info2);
      else if (y <= c.g1) col = handTexel(look, y - c.g0, c.g1 - c.g0, x, y, S, info2, un);
      else col = forearmTexel(look, y - c.g1 - 1, c.bot - c.g1, x, y, S, un, hw, u);
      rgb.set(col, (y * W + x) * 3);
    }
  }
  return { rgb, covered };
}

/** A fingertip: depth d (texels) from the top edge of the finger. */
function tipTexel(look, d, x, y, S, info2) {
  const dd = d / S;
  // where in the finger's width: the finger is the run of columns whose tip is at least 5 texels tall
  let a = x, b = x;
  const tall = (xx) => info2.list[xx] && info2.list[xx].g0 - info2.list[xx].top >= 5 * S;
  while (tall(a - 1)) a--;
  while (tall(b + 1)) b++;
  const fx = b > a ? (x - a) / (b - a) : 0.5;
  let t;
  if (dd < 1) t = 0.3;
  else if (dd < 5) t = 0.1 + 0.03 * Math.sin(dd * 2);          // the dark rubber pad at the tip
  else if (dd < 6) t = 0.02;                                    // a joint
  else if (dd < 15) t = 0.62;                                   // the distal segment
  else if (dd < 16) t = 0.02;
  else t = 0.54;                                                // the proximal segment
  if (dd >= 6) {
    t += 0.13 * (1 - smooth(0, 0.22, fx));                      // a light edge on one side
    t -= 0.22 * smooth(0.78, 1, fx);                            // a shadow on the other
    if (dd > 6 && dd < 7) t += 0.1;
  }
  const bolt = dd >= 9.5 && dd < 10.5 && Math.abs(fx - 0.5) < 0.12;
  if (bolt) t = 0.98;
  return metalAt(look, t, x, y, 0.035, 11);
}

/** The back of the hand: v texels below the top of the glove run, vh its height. */
function handTexel(look, v, vh, x, y, S, info2, un) {
  const vv = v / S, h = vh / S;
  // a seam at the middle of every gap between fingers: columns whose tip is short
  const tall = (xx) => info2.list[xx] && info2.list[xx].g0 - info2.list[xx].top >= 5 * S;
  let seam = false;
  if (!tall(x)) {
    let a = x, b = x;
    while (a > info2.xa && !tall(a - 1)) a--;
    while (b < info2.xb && !tall(b + 1)) b++;
    seam = Math.abs(x - (a + b) / 2) <= 0.5 * S && b - a < 12 * S;
  }
  let t;
  if (vv < 3) t = 0.8;                                           // the knuckle ridge
  else if (vv < 4) t = 0.03;
  else if (vv < 24) t = 0.5 + 0.1 * (1 - smooth(4, 8, vv));      // the knuckle plates
  else if (vv < 25) t = 0.03;
  else if (vv < h - 13) {                                        // the plated back of the hand
    t = 0.56;
    const m = Math.abs(un);
    if (vv > 31 && vv < h - 20 && m < 0.55) t = 0.4 + 0.05 * Math.sin(vv * 0.7);   // a recessed panel
    if (vv > 30.5 && vv < 31.5 && m < 0.58) t = 0.8;
    if (Math.abs(un) > 0.58 && Math.abs(un) < 0.62 && vv > 31 && vv < h - 20) t = 0.05;
  } else if (vv < h - 12) t = 0.03;
  else t = 0.16 + 0.12 * (Math.floor(vv / 2) % 2);               // the wrist guard: ridges
  if (seam && vv < 24) t = 0.03;
  // bolts in the plates
  const bolt = (vv > 12 && vv < 14 && !seam) || (vv > 36 && vv < 38 && Math.abs(Math.abs(un) - 0.4) < 0.04 * 3);
  if (bolt && Math.abs(((x / S) % 16) - 8) < 1.1) t = 0.97;
  return metalAt(look, t, x, y, 0.04, 13);
}

/** The forearm: w texels below the wrist, L the length to the end of the picture, u texels across from the arm's middle. */
function forearmTexel(look, w, L, x, y, S, un, hw, u) {
  const ww = w / S, LL = L / S;
  const m = Math.abs(un);
  let t = 0.5;
  let glow = -1;
  if (ww < 1) t = 0.02;
  else if (ww < 3.6) glow = 1 - Math.abs(ww - 2.3) / 1.6;      // the wrist band: the side's light
  else if (ww < 5) t = 0.03;
  else if (ww < 13) t = 0.16 + 0.14 * (Math.floor(ww / 1.5) % 2); // the wrist ring: ridges
  else if (ww < 14) t = 0.03;
  else if (ww < 66) {                                            // plate A
    t = 0.58 + 0.06 * Math.sin(ww * 0.15);
    if (ww < 15) t = 0.85;
    if (ww > 24 && ww < 45 && m < 0.5 && m > 0.14) t = (ww - 24) % 3 < 1.4 ? 0.02 : t * 0.9;   // the vent slits, beside the piston
    if (ww > 64.5) t = 0.1;
  } else if (ww < 69) t = ww < 67 ? 0.03 : 0.78;                 // the seam
  else if (ww < LL - 30) {                                       // plate B
    t = 0.5 + 0.05 * Math.sin(ww * 0.11 + 1);
    if (ww > 76 && ww < LL - 40 && m > 0.62 && m < 0.9) t = 0.4;
    if (Math.abs(m - 0.62) < 0.012) t = 0.05;
  } else if (ww < LL - 29) t = 0.03;
  else {                                                          // the joint end: cables
    t = 0.14 + 0.1 * (Math.floor(u / 3) % 2 === 0 ? 1 : 0);
    if (Math.abs(((u + 40) % 11)) < 1.2) t = 0.34;
  }
  // the piston down the middle of the arm: a housing, a rod with rings
  if (ww > 14 && ww < LL - 30 && Math.abs(u) < 7 * 1.0) {
    const a = Math.abs(u);
    if (a < 5) {
      t = 0.78 - 0.5 * (a / 5) ** 2 + 0.12 * (1 - smooth(0, 2, Math.abs(u + 1.5)));
      if (Math.floor(ww / 9) !== Math.floor((ww + 1) / 9)) t = 0.12;
    } else t = 0.08;
  }
  // the sides of the arm fall away
  if (glow < 0) t *= 1 - 0.28 * smooth(0.72, 1, m);
  // bolts at the plates' corners, status lights at the wrist
  const bx = Math.abs(Math.abs(u) - 0.8 * hw * 0.7) < 1.1;
  if (glow < 0 && bx && (Math.abs(ww - 19) < 1 || Math.abs(ww - 61) < 1 || Math.abs(ww - 74) < 1)) t = 0.97;
  let col = metalAt(look, t, x, y, 0.04, 17);
  if (glow >= 0) col = look.glow(clamp(glow));
  const led = Math.abs(Math.abs(u) - hw * 0.45) < 1.6 && Math.abs(ww - 9) < 1.6;
  if (led) col = look.glow(1);
  return col;
}

/** Grows the painted texels outwards `rings` texels into the margin (the nearest colours), so a filtered edge is metal, and darkens the rest. */
function bleed(rgb, covered, W, H, rings) {
  const ring = new Uint8Array(W * H);
  let frontier = Uint8Array.from(covered);
  const have = Uint8Array.from(covered);
  for (let r = 1; r <= rings; r++) {
    const added = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (have[i]) continue;
        const sum = [0, 0, 0];
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
            const j = yy * W + xx;
            if (!frontier[j]) continue;
            for (let k = 0; k < 3; k++) sum[k] += rgb[j * 3 + k];
            n++;
          }
        }
        if (n) added.push([i, sum.map((v) => v / n)]);
      }
    }
    frontier = new Uint8Array(W * H);
    for (const [i, c] of added) {
      rgb.set(c, i * 3);
      have[i] = 1;
      ring[i] = r;
      frontier[i] = 1;
    }
  }
  return ring;
}

/**
 * The droid hands pictures: { "msrdroid-256", "msrdroid-512", "insdroid-256", "insdroid-512" } as 8-bit pictures ({ width, height, pixels,
 * palette }), and a report of what was sampled and how well each fits 256 colours.
 */
export function droidHandPictures(game) {
  const infos = { 256: armInfo(game, "v_ak47.mdl"), 512: armInfo(game, "v_melee.mdl") };
  const out = { report: {} };
  for (const set of DROID_SETS) {
    const sampled = sampleDroid(game, PLAYERS[set]);
    const look = lookOf(set, sampled);
    for (const size of [256, 512]) {
      const info = infos[size];
      const { rgb, covered } = paintArms(look, info);
      const ring = bleed(rgb, covered, info.W, info.H, 3 * info.S);
      const weight = new Float32Array(info.W * info.H);
      for (let i = 0; i < weight.length; i++) weight[i] = covered[i] ? 1 : ring[i] ? 0.3 : 0.01;
      const q = quantise(rgb, weight);
      out[`${set}-${size}`] = { width: info.W, height: info.H, pixels: q.pixels, palette: q.palette };
      out.report[`${set}-${size}`] = { colours: q.used, error: +q.error.legs.toFixed(2), plating: sampled.count };
    }
  }
  return out;
}

// ---- the legs ----------------------------------------------------------------------------------------------------------------
/** The droid body picture for a stock model: { msrdroid, insdroid } as 8-bit textures, and a report. */
export function droidBodyPictures(game, mdl) {
  const old = K.textureOf(mdl, BODY);
  const { width, height } = old;
  const n = width * height;
  const stock = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) stock[i * 3 + k] = old.palette[old.pixels[i] * 3 + k];
  const map = texelMap(mdl, width, height);
  const { kind, ring } = regionsOf(map, stock, width, height);
  const knees = kneePoints(mdl);
  const weight = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const leg = kind[i] && kind[i] !== KIND.shirt;
    weight[i] = leg ? (ring[i] ? 0.3 : 1) : map.island[i] >= 0 ? 0.05 : 0.01;
  }
  const out = { report: {} };
  for (const set of DROID_SETS) {
    const look = lookOf(set, sampleDroid(game, PLAYERS[set]));
    const rgb = Float32Array.from(stock);
    for (let i = 0; i < n; i++) {
      if (!kind[i] || ring[i]) continue;
      const x = i % width, y = (i / width) | 0;
      const p = [map.p[i * 3], map.p[i * 3 + 1], map.p[i * 3 + 2]];
      const nrm = [map.n[i * 3], map.n[i * 3 + 1], map.n[i * 3 + 2]];
      const Y = luma(stock[i * 3], stock[i * 3 + 1], stock[i * 3 + 2]);
      rgb.set(legTexel(look, kind[i], x, y, p, nrm, Y, knees), i * 3);
    }
    bleedMargin(rgb, kind, ring, width, height);
    const q = quantise(rgb, weight);
    out[set] = { width, height, pixels: q.pixels, palette: q.palette, flags: old.flags };
    out.report[set] = { colours: q.used, errorLegs: +q.error.legs.toFixed(2), errorRest: +q.error.rest.toFixed(2) };
  }
  return out;
}

/** One texel of a droid leg: kind (team-legs KIND), texel, its point and facing in the idle pose, the stock brightness. */
function legTexel(look, kind, x, y, p, n, Y, knees) {
  if (kind === KIND.shirt) return metalAt(look, 0.3 + Y / 400, x, y, 0.03, 5);
  const knee = knees.reduce((best, k) => (Math.abs(k[1] - p[1]) < Math.abs(best[1] - p[1]) ? k : best));
  const z = p[2];
  const phi = Math.atan2(p[1] - knee[1], p[0] - knee[0]);        // 0 at the front of the leg, +-pi/2 at its sides
  const s = phi * 4.6;                                           // along the way round, in units
  const front = Math.cos(phi);
  const edge = (zb) => Math.abs(z - zb);
  let t;
  let glow = -1;
  if (kind === KIND.sole) {                                      // the sole: grooved dark steel
    t = 0.1 + 0.07 * (Math.floor(y / 3) % 2);
    return metalAt(look, t, x, y, 0.03, 23);
  }
  if (z > -26.5) t = 0.2 + 0.12 * (Y / 50);                        // the hip: dark steel
  else if (z > -41.5) {                                          // the thigh: two plates, vents on the front of the lower one
    t = z > -32.5 ? 0.62 : 0.54;
    t += 0.1 * smooth(0.0, 1.0, front) - 0.18 * smooth(0.5, 1, Math.abs(Math.sin(phi)));
    if (edge(-32.5) < 0.17) t = 0.04;
    else if (z < -32.5 && z > -32.9) t = 0.86;
    if (z < -34.4 && z > -39.2 && Math.abs(s) < 2.2 && Math.abs(s) > 0.5 && Math.floor((z + 40) * 2.2) % 2 === 0) t = 0.06;   // the vents
    if (Math.abs(Math.abs(s) - 2.9) < 0.16 && z < -27.2 && z > -41) t = 0.05;   // vertical seams
  } else if (z > -46.2) {                                        // the knee joint: dark steel, hinge discs, a piston at the front
    t = 0.14 + 0.1 * (Math.floor(z * 2.6) % 2);
    const dh = Math.hypot((Math.abs(phi) - Math.PI / 2) * 4.6, z + 43.8);
    if (dh < 1.55) t = dh < 0.5 ? 0.9 : dh < 1.0 ? 0.3 : 0.62;
    if (Math.abs(s) < 0.9) t = 0.72 - 0.4 * (Math.abs(s) / 0.9) ** 2;   // the piston rod
    if (edge(-41.5) < 0.17) t = 0.03;
  } else if (z > -48.25) {                                       // under the knee: the hem ring
    t = 0.2 + 0.1 * (Math.floor(z * 3.2) % 2);
    if (edge(-46.2) < 0.17) t = 0.03;
  } else if (z > -48.85) {                                       // the side's thin ring, directly under the hem
    glow = 1 - Math.abs(z + 48.55) / 0.3;
    t = 0.05;
  } else if (z > -59.4) {                                        // the shin: a long plate, ridges, vents at the top, a seam
    t = 0.6 + 0.08 * front - 0.16 * smooth(0.5, 1, Math.abs(Math.sin(phi)));
    if (Math.abs(Math.abs(s) - 2.3) < 0.2) t = 0.8 - 0.55 * (Math.abs(Math.abs(s) - 2.3) / 0.2);   // the ridges
    if (z > -53.3 && z < -50.0 && Math.abs(s) < 1.7 && Math.floor((z + 54) * 2.6) % 2 === 0) t = 0.06;   // the vents
    if (edge(-55.6) < 0.17) t = 0.04;
    else if (z < -55.6 && z > -56.0) t = 0.84;
    // one status light, on the front, low on the shin
    if (Math.abs(s) < 0.7 && z < -57.3 && z > -58.1) glow = 1;
  } else if (z > -62.0) {                                        // the ankle joint
    t = 0.14 + 0.1 * (Math.floor(z * 2.6) % 2);
    const dh = Math.hypot((Math.abs(phi) - Math.PI / 2) * 4.6, z + 60.7);
    if (dh < 1.3) t = dh < 0.45 ? 0.9 : dh < 0.9 ? 0.3 : 0.62;
    if (edge(-59.4) < 0.17) t = 0.03;
    if (z < -61.5) glow = 0.3;
  } else {                                                       // the foot: a plated instep and toe, dark sides and sole
    const up = n[2];
    t = up > 0.55 ? 0.6 + 0.1 * Math.sin(p[0] * 1.4) : up < -0.5 ? 0.1 : 0.32;
    if (up > 0.55 && p[0] > -3.4 && Math.floor((p[0] + 3.4) * 2.2) % 3 === 0) t -= 0.08;
    if (edge(-62.0) < 0.17) t = 0.03;
  }
  let col = metalAt(look, t, x, y, 0.035, 29);
  if (glow >= 0) col = look.glow(clamp(glow));
  return col;
}

// ---- the plating, sampled again ----------------------------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const at = process.argv.indexOf("--sample");
  const player = at >= 0 ? process.argv[at + 1] : null;
  if (!player) {
    console.error("usage: node modelling/team-droids.mjs --sample <msrdroid_bot|insdroid_bot>");
    process.exit(2);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const game = resolve(process.env.H9_GAME ?? join(here, "..", "H9XASH", "ts"));
  const s = sampleDroid(game, player);
  console.log(`${player}: ${s.count} plating texels`);
  console.log(JSON.stringify(s.ramp).replace(/\],\[/g, "], ["));
}
