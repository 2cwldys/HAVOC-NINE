// The first-person hands, sleeves and feet of the proletarian player models: three more sets beside msr, insurgent, default and the
// droids.
//
// WHO. A player on a roleplay map who wears one of the proletarian models (models/player/proletarian, proletarian_healthy, prole_fem,
// prole_bfem) sees that model's own arms in every viewmodel, and in the kung fu kicks that model's trousers and shoes, instead of the
// stock bare forearm and fingerless glove. ts_matchmode.sma picks the set by the model name (tsm_rp_hands_prole, _prolehealthy and
// _prolefem); the sets are written by team-hands.mjs, which calls this module, to models/matchmode/<set>/ beside the others.
//
// THE SETS. One for every look the arms have, not one for every model:
//     prole         proletarian. A bare hand in the model's mottled, sunburnt brown (a tan gone dirty, blotched to almost black), the navy
//                   work-shirt sleeve with its cuff at the wrist. Black trousers over the ankle, black shoes.
//     prolehealthy  proletarian_healthy. The same shirt and cuff and trousers on the agent's own skin: a pale, even hand with nails.
//     prolefem      prole_fem and prole_bfem. A navy fitted sleeve into a dark glove that covers the hand and the fingers; black trousers
//                   and black boots. The two models share the sleeve texels, the glove texels and the leg texels (their hair and their face
//                   are all that differ), so they share the set (the --sample output of both agrees).
// proletarian_dirty has the same hands and the same shirt as proletarian, the sleeve a little darker toward the cuff (the --sample ramps of
// the two are within 2 levels on the hand and 15 on the sleeve); the plugin's word proletarian names it too, so it wears the prole set.
//
// WHAT IT PAINTS. The arm picture (arms256.bmp, 256, and v_melee's of 512) has the layout every viewmodel shares: the fingers, the glove
// across the back of the hand, the bare forearm. It is read the way team-droids.mjs reads it (armInfo: the islands, and for every column the
// row where the glove starts and ends) and painted over zone by zone:
//     fingers and hand   the stock picture's own brightness (nails, creases, the knuckles) put through the model's skin colours, or its glove
//                        colours; the back of the hand, which the stock glove covers, takes the brightness of the forearm skin a fixed
//                        distance below, so it has real skin detail. The proletarian's blotching is laid over it as noise of the size of the
//                        model's own.
//     cuff               a black band at the wrist and the lighter lip of the cuff over it (the glove's edge on prolefem).
//     sleeve             the model's sleeve colours, shaded by the stock forearm's soft light and dark so the arm still reads as round.
// The body picture of v_melee (seal_body.bmp, the kicking leg) is repainted over the stock atlas with team-legs.mjs's regions: trousers with
// the cargo straps and pockets taken out (the stock brightness flattened), the shoe or the boot, the sole; on the male sets the trouser leg
// comes down over the ankle with a hem and only the foot is a shoe.
//
// WHERE THE COLOURS COME FROM. The player models themselves: the left forearm, hand, thigh, calf and foot texels of each model, by
// brightness, nine entries a ramp (the mean of a 2% window around the quantiles below), as team-droids.mjs samples its plating:
//     hand      the texels of the hand and fingers (below the wrist): skin, or the glove
//     sleeve    the texels of the sleeve between the cuff and the elbow
//     trousers  the texels of the thigh and calf (on the female models the texels of legs.bmp)
//     shoes     the texels of the foot (on the female models the texels of the boots)
//
// Nothing is random: every pattern is a function of the texel, so the same inputs give the same bytes. The pictures are cut to 256 colours
// by team-legs.mjs's quantiser. The stock arms pictures are read from the game's own v_ak47.mdl (256) and v_melee.mdl (512).
//
//   node modelling/team-proles.mjs --sample <player model>     the ramps this module paints with (proletarian, prole_bfem ...)
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { K } from "./lib.mjs";
import { clamp, mix, smooth, luma, hash, fbm, rampAt, quantise, KIND, texelMap, regionsOf, bleedMargin, BODY } from "./team-legs.mjs";
import { armInfo, bleed } from "./team-droids.mjs";

export const PROLE_SETS = ["prole", "prolehealthy", "prolefem"];

// Which player model each set is painted from, which others wear it (`also`: their colours are compared with the model's and reported), and
// how: `glove` puts the hand in a glove, `mottle` blotches the skin, `hem` is the height (in the idle pose of the kicking leg) under which
// the shoe starts and over which the trouser leg hangs; null keeps the boot to its top.
const LOOKS = {
  prole: { player: "proletarian", also: ["proletarian_dirty"], glove: false, mottle: true, hem: -62.0 },
  prolehealthy: { player: "proletarian_healthy", also: [], glove: false, mottle: false, hem: -62.0 },
  prolefem: { player: "prole_fem", also: ["prole_bfem"], glove: true, mottle: false, hem: null },
};

const IDLE = { seq: 1, frame: 0 };
const FRACTIONS = [0.03, 0.15, 0.3, 0.45, 0.6, 0.75, 0.88, 0.96, 0.995];
const WRIST_Z = 0.8;                 // standing pose: the hand's texels lie under this height
const SLEEVE_Z = [3.4, 13.2];        // and the sleeve's between the cuff and the elbow
const CUFF = 7;                      // rows of the cuff under the hand, in 256 texels

// ---- the models' colours, sampled -----------------------------------------------------------------------------------------------
const samples = new Map();

/**
 * The colours of a proletarian player model by brightness: { hand, sleeve, trousers, shoes } ramps of nine [r, g, b], darkest first, and
 * the number of texels each was taken from. Read once a run.
 */
export function sampleProle(game, player) {
  const key = `${game}|${player}`;
  if (!samples.has(key)) samples.set(key, sampleOnce(game, player));
  return samples.get(key);
}

function rampOf(list) {
  list.sort((a, b) => luma(...a) - luma(...b) || a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  return FRACTIONS.map((f) => {
    const i = Math.floor(list.length * f);
    const w = Math.max(1, Math.floor(list.length * 0.01));
    const part = list.slice(Math.max(0, i - w), Math.min(list.length, i + w));
    return [0, 1, 2].map((k) => Math.round(part.reduce((s, c) => s + c[k], 0) / part.length));
  });
}

/** How far apart two models' sampled colours are: for each group, the largest difference of any channel of any ramp entry, in levels. */
function likeness(a, b) {
  const out = {};
  for (const k of ["hand", "sleeve", "trousers", "shoes"]) out[k] = Math.max(...a[k].flatMap((c, i) => c.map((v, j) => Math.abs(v - b[k][i][j]))));
  return out;
}

function sampleOnce(game, player) {
  const dir = join(game, "models", "player", player);
  const file = join(dir, `${player}.mdl`);
  if (!existsSync(file)) throw new Error(`no player model at ${file}`);
  const raw = readFileSync(file);
  const textures = join(dir, `${player}t.mdl`);
  const mdl = existsSync(textures) ? K.withTextures(raw, readFileSync(textures)) : raw;
  const bones = K.bones(mdl).map((b) => b.name);
  const female = K.readMdl(mdl).textures.some((t) => /^legs\.bmp$/i.test(t.name));
  const seen = new Set();
  const groups = { hand: [], sleeve: [], trousers: [], shoes: [] };
  K.paint(
    mdl,
    (q) => {
      const bone = bones[q.boneIndex];
      const arm = /SX (Avambraccio|Mano)|Dito mano SX/.test(bone);
      const leg = /SX (Coscia|Polpaccio|Piede)/.test(bone);
      if ((!arm && !leg) || q.p[1] <= 0) return undefined;
      const at = `${q.tex}|${Math.floor(q.u)},${Math.floor(q.v)}`;
      if (seen.has(at)) return undefined;
      seen.add(at);
      const z = q.p[2];
      const rgb = q.rgb.map((v) => v * 255);
      if (arm) {
        // the bare hand's texels are the warm ones: the black border the picture keeps round the hand is not skin
        if (z < WRIST_Z) {
          if (female || rgb[0] > rgb[2] + 6) groups.hand.push(rgb);
        } else if (z > SLEEVE_Z[0] && z < SLEEVE_Z[1] && /Avambraccio/.test(bone)) groups.sleeve.push(rgb);
      } else if (female) {
        if (/^legs\.bmp$/i.test(q.tex)) groups.trousers.push(rgb);
        else if (/Polpaccio|Piede/.test(bone)) groups.shoes.push(rgb);
      } else if (/Piede/.test(bone)) {
        groups.shoes.push(rgb);
      } else if (z < -8 && rgb[2] < rgb[0] + 14) {
        groups.trousers.push(rgb);                               // not the shirt tail at the hip, which is blue
      }
      return undefined;
    },
    { pose: IDLE },
  );
  const counts = {};
  const out = { counts };
  for (const [name, list] of Object.entries(groups)) {
    if (list.length < 300) throw new Error(`${player}: only ${list.length} ${name} texels found; is this a proletarian model?`);
    counts[name] = list.length;
    out[name] = rampOf(list);
  }
  return out;
}

// ---- small helpers --------------------------------------------------------------------------------------------------------------
/** Box sums of `src` over a window of radius r each way (separable, running sums). */
function boxSum(src, W, H, r) {
  const tmp = new Float64Array(W * H);
  const out = new Float64Array(W * H);
  for (let y = 0; y < H; y++) {
    let s = 0;
    for (let x = 0; x < Math.min(r, W); x++) s += src[y * W + x];
    for (let x = 0; x < W; x++) {
      if (x + r < W) s += src[y * W + x + r];
      if (x - r - 1 >= 0) s -= src[y * W + x - r - 1];
      tmp[y * W + x] = s;
    }
  }
  for (let x = 0; x < W; x++) {
    let s = 0;
    for (let y = 0; y < Math.min(r, H); y++) s += tmp[y * W + x];
    for (let y = 0; y < H; y++) {
      if (y + r < H) s += tmp[(y + r) * W + x];
      if (y - r - 1 >= 0) s -= tmp[(y - r - 1) * W + x];
      out[y * W + x] = s;
    }
  }
  return out;
}

/** `values` smoothed over the texels `mask` holds (a box of radius r each way); texels outside the mask get the nearest answer there is, else 0. */
function blurMasked(values, mask, W, H, r) {
  const v = new Float64Array(W * H);
  const m = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (mask[i]) {
      v[i] = values[i];
      m[i] = 1;
    }
  }
  const sv = boxSum(v, W, H, r);
  const sm = boxSum(m, W, H, r);
  const out = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = sm[i] > 0 ? sv[i] / sm[i] : 0;
  return out;
}

/** The fraction of the sorted list that lies under `v` (0 to 1). */
function rankIn(sorted, v) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return sorted.length ? lo / sorted.length : 0.5;
}

const grain = (x, y, seed) => hash(x, y, seed) - 0.5;

// ---- the arms ---------------------------------------------------------------------------------------------------------------------
/** The proletarian's blotching: dark patches of two sizes, 0 (none) to 1, in 256 texels. */
function blotch(x, y, S) {
  const u = x / S, v = y / S;
  const a = clamp((fbm(u / 3.4, v / 3.4, 29, 3) - 0.46) / 0.12);
  const b = clamp((fbm(u / 1.5, v / 1.5, 53, 2) - 0.5) / 0.1);
  return clamp(a * 0.75 + b * 0.4);
}

/**
 * One arms picture of a set: float RGB for every texel and which texels an island covers. `stock` is the stock picture of the same size
 * (a texture), `info` its islands and glove runs (armInfo); S is the picture's scale against the 256 layout (1 or 2) and every measure
 * below is in 256 texels, multiplied by S.
 */
function paintArms(spec, sampled, info, stock) {
  const { W, H, island, cols, S } = info;
  const n = W * H;
  const Y = new Float32Array(n);
  const skin = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const e = stock.pixels[i] * 3;
    const r = stock.palette[e], g = stock.palette[e + 1], b = stock.palette[e + 2];
    Y[i] = luma(r, g, b);
    skin[i] = island[i] >= 0 && r > b + 18 && r > g + 8 && Y[i] > 45 ? 1 : 0;      // armInfo's test: the rest of an island is glove
  }
  // the wrist is one straight line across an island: the stock glove's lower edge, as the median of the columns that have a glove run (the
  // outermost columns, where an edge of the island cuts the glove short, are not trusted)
  const wrist = new Map();
  for (const [id, c] of cols) {
    const ends = c.list.filter((e) => e && e.g0 >= 0 && e.g1 - e.g0 >= 30 * S).map((e) => e.g1).sort((a, b) => a - b);
    wrist.set(id, ends.length ? ends[ends.length >> 1] : Math.max(...c.list.filter(Boolean).map((e) => e.g1)));
  }
  const wristOf = (x, y) => {
    const id = island[y * W + x];
    return Math.max(cols.get(id).list[x].g1, wrist.get(id));
  };
  const zoneOf = (x, y) => {
    if (y < cols.get(island[y * W + x]).list[x].g0) return "tip";
    const g1 = wristOf(x, y);
    if (y <= g1) return "hand";
    return y - g1 - 1 < CUFF * S ? "cuff" : "sleeve";
  };

  // the stock brightness of skin, to rank a texel among the skin there is; of glove, among the glove
  const skinY = [], gloveY = [];
  const soft = new Uint8Array(n);                            // the stock forearm skin, which shades the sleeve
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (island[i] < 0) continue;
      const zone = zoneOf(x, y);
      if (skin[i]) skinY.push(Y[i]);
      else if (zone === "hand") gloveY.push(Y[i]);
      if (skin[i] && (zone === "sleeve" || zone === "cuff")) soft[i] = 1;
    }
  }
  skinY.sort((a, b) => a - b);
  gloveY.sort((a, b) => a - b);
  const shade = blurMasked(Y, soft, W, H, Math.round(5 * S));
  const fine = blurMasked(Y, soft, W, H, Math.round(2 * S));      // the forearm without its single-texel hairs, for the back of the hand
  let meanShade = 0, count = 0;
  for (let i = 0; i < n; i++) if (soft[i]) { meanShade += shade[i]; count++; }
  meanShade /= Math.max(1, count);

  // the skin of the hand's back: the forearm skin a fixed distance below, in the same column (the nearest skin of that row where the
  // column has none)
  const back = Math.round(80 * S);
  const skinAt = (x, y) => {
    const yy = Math.min(H - 1, y + back);
    const ok = (xx) => xx >= 0 && xx < W && skin[yy * W + xx] && zoneOf(xx, yy) !== "tip";
    for (let d = 0; d < 60 * S; d++) {
      for (const xx of d ? [x - d, x + d] : [x]) {
        if (!ok(xx)) continue;
        // a column outside the forearm takes the skin the same distance inside its edge, not the edge's own texel repeated
        const mirror = xx + (xx - x);
        return fine[yy * W + (d && ok(mirror) ? mirror : xx)];
      }
    }
    return 100;
  };

  const rgb = new Float32Array(n * 3);
  const covered = new Uint8Array(n);
  const dark = rampAt(sampled.sleeve, 0).map((v) => v * 0.5);
  for (let i = 0; i < n; i++) rgb.set(dark, i * 3);
  const handRamp = sampled.hand, sleeveRamp = sampled.sleeve;
  const bandBlack = rampAt(sleeveRamp, 0).map((v) => v * 0.45);
  const lip = rampAt(sleeveRamp, 1).map((v) => v * 1.22);

  // the hand: skin (a rank among the stock skin, blotched on the proletarian) or glove (the stock glove, and a flattened rank on the fingers).
  // A fingertip texel that is not skin (the shadow the stock glove's top edge casts) is the hand's back, like the rest under it.
  const handColour = (x, y, zone, i) => {
    const back = zone === "hand" || !skin[i];
    let t;
    if (spec.glove) {
      t = zone === "hand" && !skin[i] ? rankIn(gloveY, Y[i]) * 0.8 + 0.1 : 0.3 + 0.36 * rankIn(skinY, back ? skinAt(x, y) : Y[i]);
    } else {
      const rank = rankIn(skinY, back ? skinAt(x, y) : Y[i]);
      t = spec.mottle ? mix(0.3 + 0.7 * rank, 0.03 + 0.3 * rank, blotch(x, y, S)) : rank;
    }
    t = clamp(t + grain(x, y, 5) * 0.03);
    return rampAt(handRamp, t);
  };

  const sleeveColour = (x, y, i, below) => {
    const along = (below - CUFF * S) / S;                      // 256 texels down the sleeve from the cuff
    const cloth = 0.42 + 0.2 * smooth(0, 25, along) - 0.1 * smooth(110, 150, along);
    const light = clamp((shade[i] / meanShade - 1) * 1.6, -0.5, 0.5);
    const mottle = (fbm(x / S / 9, y / S / 17, 83, 3) - 0.5) * 0.5;
    return rampAt(sleeveRamp, clamp(cloth + light * 0.6 + mottle + grain(x, y, 9) * 0.06));
  };

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (island[i] < 0) continue;
      covered[i] = 1;
      const zone = zoneOf(x, y);
      const below = y - wristOf(x, y) - 1;                     // rows under the hand (negative above its lower edge)
      let col;
      if (zone === "tip" || zone === "hand") {
        col = handColour(x, y, zone, i);
      } else if (zone === "cuff") {
        const d = below / S;
        if (spec.glove) col = d < 3 ? rampAt(sleeveRamp, 0.04).map((v) => v * 0.85) : sleeveColour(x, y, i, below).map((v) => v * 0.9);
        else if (d < 2.5) col = bandBlack;
        else if (d < 5) col = lip.map((v) => v * (0.92 + 0.16 * hash(x, y, 3)));
        else col = rampAt(sleeveRamp, 0.06);
      } else {
        col = sleeveColour(x, y, i, below);
      }
      rgb.set(col, i * 3);
    }
  }
  return { rgb, covered };
}

/**
 * The hands pictures of the proletarian sets: { "<set>-256", "<set>-512" } as 8-bit pictures ({ width, height, pixels, palette }), and a
 * report of what was sampled and how well each fits 256 colours.
 */
export function proleHandPictures(game) {
  const stocks = {};
  const infos = {};
  for (const [size, file] of [[256, "v_ak47.mdl"], [512, "v_melee.mdl"]]) {
    infos[size] = armInfo(game, file);
    stocks[size] = K.textureOf(readFileSync(join(game, "models", file)), "arms256.bmp");
  }
  const out = { report: {} };
  for (const set of PROLE_SETS) {
    const spec = LOOKS[set];
    const sampled = sampleProle(game, spec.player);
    for (const size of [256, 512]) {
      const info = infos[size];
      const { rgb, covered } = paintArms(spec, sampled, info, stocks[size]);
      const ring = bleed(rgb, covered, info.W, info.H, 3 * info.S);
      const weight = new Float32Array(info.W * info.H);
      for (let i = 0; i < weight.length; i++) weight[i] = covered[i] ? 1 : ring[i] ? 0.3 : 0.01;
      const q = quantise(rgb, weight);
      out[`${set}-${size}`] = { width: info.W, height: info.H, pixels: q.pixels, palette: q.palette };
      out.report[`${set}-${size}`] = {
        colours: q.used,
        error: +q.error.legs.toFixed(2),
        hand: sampled.counts.hand,
        sleeve: sampled.counts.sleeve,
        from: spec.player,
        also: spec.also.map((player) => ({ player, apart: likeness(sampled, sampleProle(game, player)) })),
      };
    }
  }
  return out;
}

// ---- the legs ---------------------------------------------------------------------------------------------------------------------
/**
 * The body pictures of the proletarian sets for a stock model: { prole, prolehealthy, prolefem } as 8-bit textures ({ width, height, pixels,
 * palette, flags }) the size of the stock seal_body.bmp, and a report. The stock trousers' straps, pockets and buckles are flattened (the
 * stock brightness clamped to the cloth and blurred), the rest of the brightness kept as the folds.
 */
export function proleBodyPictures(game, mdl) {
  const old = K.textureOf(mdl, BODY);
  const { width, height } = old;
  const n = width * height;
  const stock = new Float32Array(n * 3);
  const Y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) stock[i * 3 + k] = old.palette[old.pixels[i] * 3 + k];
    Y[i] = luma(stock[i * 3], stock[i * 3 + 1], stock[i * 3 + 2]);
  }
  const map = texelMap(mdl, width, height);
  const { kind, ring } = regionsOf(map, stock, width, height);

  // the cloth with its straps taken out: the brightness clamped to the cloth's, then blurred over the trousers' own texels
  const cloth = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (kind[i] === KIND.fabric && !ring[i]) cloth[i] = 1;
  const sorted = [];
  for (let i = 0; i < n; i++) if (cloth[i]) sorted.push(Y[i]);
  sorted.sort((a, b) => a - b);
  const cap = sorted[Math.floor(sorted.length * 0.8)];
  const clamped = Float32Array.from(Y, (v) => Math.min(v, cap));
  const flat = blurMasked(clamped, cloth, width, height, 8);
  let meanFlat = 0, cnt = 0;
  for (let i = 0; i < n; i++) if (cloth[i]) { meanFlat += flat[i]; cnt++; }
  meanFlat /= Math.max(1, cnt);

  // the stock boots' brightness, to rank a texel of the foot among the leather there is
  const bootY = [];
  for (let i = 0; i < n; i++) if (kind[i] === KIND.boot && !ring[i]) bootY.push(Y[i]);
  bootY.sort((a, b) => a - b);
  const bootFlat = blurMasked(Y, Uint8Array.from(kind, (k, i) => (k === KIND.boot && !ring[i] ? 1 : 0)), width, height, 3);

  const weight = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const leg = kind[i] && kind[i] !== KIND.shirt;
    weight[i] = leg ? (ring[i] ? 0.3 : 1) : map.island[i] >= 0 ? 0.05 : 0.01;
  }

  const out = { report: {} };
  for (const set of PROLE_SETS) {
    const spec = LOOKS[set];
    const sampled = sampleProle(game, spec.player);
    const trousers = (x, y, t0) => rampAt(sampled.trousers, clamp(t0 + 0.14 * (fbm(x / 9, y / 9, 71, 3) - 0.5) + grain(x, y, 13) * 0.08, 0, 0.82));
    const rgb = Float32Array.from(stock);
    for (let i = 0; i < n; i++) {
      if (!kind[i] || ring[i]) continue;
      const x = i % width, yy = (i / width) | 0;
      const z = map.p[i * 3 + 2];
      let col;
      if (kind[i] === KIND.fabric || kind[i] === KIND.shirt) {
        col = trousers(x, yy, clamp(0.45 + 1.8 * (flat[i] / meanFlat - 1)));
      } else if (kind[i] === KIND.sole) {
        col = rampAt(sampled.shoes, 0.08 + 0.12 * (Y[i] / 60));
      } else if (spec.hem !== null && z > spec.hem) {
        // the trouser leg over the ankle: plain cloth, a hem, a little shadow over the shoe
        const fold = 0.45 + 0.2 * (fbm(x / 6, yy / 14, 97, 2) - 0.5);
        col = trousers(x, yy, fold);
        if (z < spec.hem + 0.35) col = col.map((v) => v * 0.6);
      } else {
        const t = rankIn(bootY, bootFlat[i]);
        col = rampAt(sampled.shoes, clamp(0.12 + 0.8 * t + grain(x, yy, 19) * 0.05));
      }
      rgb.set(col, i * 3);
    }
    bleedMargin(rgb, kind, ring, width, height);
    const q = quantise(rgb, weight);
    out[set] = { width, height, pixels: q.pixels, palette: q.palette, flags: old.flags };
    out.report[set] = { colours: q.used, errorLegs: +q.error.legs.toFixed(2), errorRest: +q.error.rest.toFixed(2) };
  }
  return out;
}

// ---- the models' colours, sampled again ----------------------------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const at = process.argv.indexOf("--sample");
  const player = at >= 0 ? process.argv[at + 1] : null;
  if (!player) {
    console.error("usage: node modelling/team-proles.mjs --sample <player model, e.g. proletarian>");
    process.exit(2);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const game = resolve(process.env.H9_GAME ?? join(here, "..", "H9XASH", "ts"));
  const s = sampleProle(game, player);
  console.log(`${player}: ${Object.entries(s.counts).map(([k, v]) => `${v} ${k}`).join(", ")} texels`);
  for (const k of ["hand", "sleeve", "trousers", "shoes"]) console.log(`${k.padEnd(9)} ${JSON.stringify(s[k]).replace(/\],\[/g, "], [")}`);
}
