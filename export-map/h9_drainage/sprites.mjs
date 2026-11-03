// The uplink mode's sprites and the drainage maps' rain, drawn by rule and written with SMAK (ts_uplink.sma
// names the mode's; drainage.mjs places the rain's).
//
//   tsm_zone_ring_0/1/2.spr  a control zone's ring on the ground: oriented (laid flat by the plugin's
//                            pitch of 90), additive, 128 px with the ring at 56 -- the plugin scales a
//                            zone of radius R to R / 56 (UPL_RING_PX). Neutral grey, MSR blue, Insurgent red.
//   tsm_zone_ring_cap.spr    the same ring while a zone is being taken: amber, faster.
//   tsm_zone_flag.spr        the control marker over a zone: three frames, the holder's (0 none, 1 MSR,
//                            2 Insurgents), each a hexagon badge with its side's mark.
//   tsm_uplink_mark.spr      the marker over the uplink's carrier, seen by both sides: two frames, the
//                            carrier's colour (0 MSR, 1 Insurgents), a chevron pointing down at him.
//   tsm_obj_mark.spr         the marker over a siege objective (ts_matchmode): two frames, the attacking
//                            side's (a red target reticle) and the defending side's (a blue shield).
//   h9_drain_rain.spr        a sheet of falling rain: upright (it turns about the vertical to face the eye),
//                            additive, 64 x 256, its streaks one tile of 128 lower over the loop.
//   h9_drain_splash.spr      the rain landing: oriented (laid flat), additive, 128 across, rings springing up
//                            and spreading where drops land, a soft circle round them.
//   h9_drain_fog.spr         the dirt in the air at the floor: upright, index alpha (it darkens and tints,
//                            it does not glow), 256 x 64, thickest along its foot and gone by its top, two
//                            layers of haze drifting past each other.
//
// EVERY ANIMATION IS A FRAME GROUP, played by the client's own clock: nothing on the server steps a frame,
// so a ring that pulses all round costs no network traffic at all. The plugin picks a group by its frame
// number (the flag's holder, the marker's side) and the client plays the frames inside it.
//
// The frames are painted here, the rest is SMAK's: quantiseFrames for the palette (a one-colour light gets
// 255 steps of its colour), writeSpr for the file, readSpr and measureSprite to check what was written,
// sheetOf and animationOf for the pictures beside it.
//
//   node sprites.mjs            write out\sprites\*.spr and their pictures, and print the checks
//   node sprites.mjs deploy     and copy the .spr files to TSM\sprites (what export.bat ships) and to the
//                               game's ts\sprites (what the server precaches)
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GAME_DIR, K, M, SMAK } from "../lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out", "sprites");
const TSM = join(HERE, "..", "..");

const kit = async (file) => import(pathToFileURL(join(SMAK, "src", "sprite", file)).href);
const { writeSpr } = await kit("spr.mjs");
const { quantiseFrames } = await kit("palette.mjs");
const { sheetOf, animationOf } = await kit("draw.mjs");
const { measureSprite } = await kit("measure.mjs");

// ---- the colours ---------------------------------------------------------------------------------
const NEUTRAL = [0.78, 0.8, 0.84];
const MSR = [0.25, 0.62, 1.0];
const INS = [1.0, 0.3, 0.24];
const AMBER = [1.0, 0.72, 0.16];

// ---- painting ------------------------------------------------------------------------------------
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smooth = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const bell = (d, w) => Math.exp(-((d / w) ** 2));

/**
 * A frame as SMAK's quantiser takes it: { width, height, rgb, a }, painted by `light(u, v)` -> [r, g, b]
 * (0 to 1, added: black is clear). u runs -1 to 1 left to right, v -1 to 1 bottom to top. The outer `edge`
 * pixels fade to nothing, so the frame's square never shows.
 */
function frame(size, light, edge = 2) {
  const rgb = new Float32Array(size * size * 3);
  const a = new Float32Array(size * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = ((x + 0.5) / size) * 2 - 1;
      const v = 1 - ((y + 0.5) / size) * 2;
      const fade = clamp01(Math.min(x + 0.5, size - x - 0.5) / edge) * clamp01(Math.min(y + 0.5, size - y - 0.5) / edge);
      const c = light(u, v).map((k) => clamp01(k * fade));
      const i = y * size + x;
      rgb.set(c, i * 3);
      a[i] = Math.max(...c);
    }
  return { width: size, height: size, rgb, a };
}

/** The zone ring at phase p (0 to 1 round the loop): the rim, a turning dashed band, a pulse running out. */
function ringLight(colour, p, { pulses = 1, turns = 1, bright = 1 } = {}) {
  const RIM = 56 / 64; // the ring's radius: 56 px of the 64 to the frame's edge, clear of the border
  const DASHES = 10;
  return (u, v) => {
    const r = Math.hypot(u, v);
    const around = (Math.atan2(v, u) / (2 * Math.PI) + 1) % 1;
    const rim = bell(r - RIM, 0.032);
    // the dashes turn one dash's width round the loop (times `turns`), so the loop closes exactly
    const d = (around * DASHES + p * turns) % 1;
    const dash = bell(r - (RIM - 0.13), 0.022) * smooth(0.05, 0.15, d) * (1 - smooth(0.45, 0.55, d));
    // a pulse from the middle out to the rim, fading as it goes, `pulses` of them a loop
    let pulse = 0;
    for (let k = 0; k < pulses; k++) {
      const q = (p * pulses + k / pulses) % 1;
      const at = 0.22 + (RIM - 0.22) * q;
      pulse += bell(r - at, 0.045) * (1 - q) ** 1.3 * 0.55;
    }
    const inside = r < RIM ? 0.045 * (1 - smooth(RIM - 0.08, RIM, r)) : 0;
    const e = clamp01((rim + 0.75 * dash + pulse + inside) * bright);
    return colour.map((c) => c * e);
  };
}

/** Distance from (u, v) to a flat-topped hexagon of circumradius R: under 0 inside. */
function hexDistance(u, v, R) {
  const x = Math.abs(u);
  const y = Math.abs(v);
  const k = Math.sqrt(3) / 2;
  return Math.max(x * k + y * 0.5, y) - R * k;
}

/** Distance from a point to a segment. */
function toSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = clamp01(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1));
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
}

/** A stroke between two points, w its half width, soft over a pixel or so. */
const stroke = (u, v, a, b, w) => 1 - smooth(w * 0.7, w * 1.3, toSegment(u, v, a[0], a[1], b[0], b[1]));

/** The control flag over a zone: a hexagon badge, hollow when nobody holds it, filled and marked when a side does. */
function flagLight(holder, p) {
  const colour = holder === 1 ? MSR : holder === 2 ? INS : NEUTRAL;
  const breathe = 0.88 + 0.12 * Math.cos(2 * Math.PI * p);
  return (u, v) => {
    const d = hexDistance(u, v, 0.8);
    const outline = bell(d, 0.045);
    const fill = holder ? (d < 0 ? 0.32 : 0) * (1 - smooth(-0.06, 0, d)) : 0;
    let mark = 0;
    if (holder === 1) {
      // MSR: a chevron pointing up
      mark = Math.max(stroke(u, v, [-0.4, -0.18], [0, 0.26], 0.09), stroke(u, v, [0.4, -0.18], [0, 0.26], 0.09));
    } else if (holder === 2) {
      // the Insurgents: a cross
      mark = Math.max(stroke(u, v, [-0.32, -0.32], [0.32, 0.32], 0.085), stroke(u, v, [-0.32, 0.32], [0.32, -0.32], 0.085));
    } else {
      // nobody: a small dot in the middle
      mark = bell(Math.hypot(u, v), 0.09) * 0.8;
    }
    const e = clamp01((outline + fill + mark) * breathe);
    return colour.map((c) => c * e);
  };
}

/** The carrier's marker: a chevron pointing down at him, bobbing and breathing, with a soft glow behind it. */
function markLight(colour, p) {
  const bob = 0.07 * Math.sin(2 * Math.PI * p);
  const breathe = 0.85 + 0.15 * Math.cos(2 * Math.PI * p);
  return (u, v) => {
    const y = v - bob;
    const chevron = Math.max(stroke(u, y, [-0.5, 0.28], [0, -0.3], 0.11), stroke(u, y, [0.5, 0.28], [0, -0.3], 0.11));
    const glow = 0.35 * bell(Math.hypot(u, y + 0.02), 0.42);
    const e = clamp01((chevron + glow) * breathe);
    return colour.map((c) => c * e);
  };
}

/**
 * The marker over a siege objective (ts_matchmode, tsm_obj_mark.spr): group 0 for the side that attacks it, a
 * red target reticle; group 1 for the side that defends it, a blue shield. Each side is sent only its own.
 */
const OBJ_ATTACK = [1.0, 0.36, 0.14];
const OBJ_DEFEND = [0.3, 0.7, 1.0];
function objLight(attack, p) {
  const bob = 0.05 * Math.sin(2 * Math.PI * p);
  const breathe = 0.82 + 0.18 * Math.cos(2 * Math.PI * p);
  return (u, v) => {
    const y = v - bob;
    let shape;
    if (attack) {
      const d = Math.hypot(u, y);
      const ring = stroke(d, 0, [0.42, 0], [0.42, 0], 0.07);
      const ticks = Math.max(
        stroke(u, y, [0, 0.62], [0, 0.26], 0.07), stroke(u, y, [0, -0.62], [0, -0.26], 0.07),
        stroke(u, y, [0.62, 0], [0.26, 0], 0.07), stroke(u, y, [-0.62, 0], [-0.26, 0], 0.07),
      );
      const dot = bell(d, 0.08);
      shape = Math.max(ring, ticks, dot);
    } else {
      const pts = [[-0.45, 0.5], [0.45, 0.5], [0.45, 0.02], [0, -0.58], [-0.45, 0.02]];
      let edge = 0;
      for (let i = 0; i < pts.length; i++) edge = Math.max(edge, stroke(u, y, pts[i], pts[(i + 1) % pts.length], 0.075));
      const bar = stroke(u, y, [-0.2, 0.12], [0.2, 0.12], 0.07);
      shape = Math.max(edge, bar);
    }
    const glow = 0.3 * bell(Math.hypot(u, y), 0.5);
    const e = clamp01((shape + glow) * breathe);
    return (attack ? OBJ_ATTACK : OBJ_DEFEND).map((c) => c * e);
  };
}

// ---- the rain --------------------------------------------------------------------------------------
const RAIN = [0.62, 0.68, 0.76];

/** A repeatable run of numbers from 0 to 1. */
function numbers(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A frame as the quantiser takes it from a field of light `a` (0 to 1) in the rain's colour. */
const rainFrame = (width, height, a) => {
  const rgb = new Float32Array(width * height * 3);
  for (let i = 0; i < width * height; i++) rgb.set(RAIN.map((c) => c * a[i]), i * 3);
  return { width, height, rgb, a };
};

/**
 * The rain sheet's frames: streaks of every length and brightness, each brightest at its head and fading up its
 * tail, falling down a tile `tile` high that repeats down the sheet. Over the loop the field falls one tile, so
 * the last frame runs on into the first. The sheet fades out at its edges, so no line of it shows.
 */
function rainFrames(count, { width = 64, height = 256, tile = 128, streaks = 44, seed = 7 } = {}) {
  const rnd = numbers(seed);
  const field = Array.from({ length: streaks }, () => ({ x: rnd() * width, y: rnd() * tile, len: 10 + rnd() * 30, bright: 0.25 + 0.75 * rnd() ** 1.5, w: 0.45 + 0.4 * rnd() }));
  return Array.from({ length: count }, (_, f) => {
    const a = new Float32Array(width * height);
    for (const s of field) {
      const head = (s.y + (f / count) * tile) % tile;
      for (let rep = -1; rep <= height / tile; rep++) {
        const hy = head + rep * tile;
        for (let y = Math.floor(hy - s.len); y <= Math.ceil(hy); y++) {
          if (y < 0 || y >= height) continue;
          const along = (hy - y) / s.len;
          if (along < 0 || along > 1) continue;
          const fade = (1 - along) ** 1.4 * s.bright;
          for (let x = Math.floor(s.x - 2); x <= Math.ceil(s.x + 2); x++) {
            const i = y * width + (((x % width) + width) % width);
            a[i] = Math.min(1, a[i] + Math.exp(-(((x + 0.5 - s.x) / s.w) ** 2)) * fade);
          }
        }
      }
    }
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) a[y * width + x] *= clamp01(Math.min(y, height - 1 - y) / 24) * clamp01(Math.min(x, width - 1 - x) / 6);
    return rainFrame(width, height, a);
  });
}

/**
 * The splash patch's frames: drops landing all over it, each a bright point that springs into a ring and spreads
 * and fades. Each lands at its own moment, the moments spread evenly over the loop so that every frame holds
 * about as many rings, and the loop has no beat. A soft circle round the patch hides its square.
 */
function splashFrames(count, { size = 128, drops = 56, seed = 11 } = {}) {
  const rnd = numbers(seed);
  const field = Array.from({ length: drops }, (_, k) => ({ x: 8 + rnd() * (size - 16), y: 8 + rnd() * (size - 16), born: (k + rnd()) / drops, r: 3 + rnd() * 5, bright: 0.4 + 0.6 * rnd() }));
  const LIFE = 0.35;
  return Array.from({ length: count }, (_, f) => {
    const p = f / count;
    const a = new Float32Array(size * size);
    for (const d of field) {
      const age = (((p - d.born) % 1) + 1) % 1;
      if (age > LIFE) continue;
      const t = age / LIFE;
      const radius = t * d.r;
      for (let y = Math.floor(d.y - d.r - 2); y <= Math.ceil(d.y + d.r + 2); y++)
        for (let x = Math.floor(d.x - d.r - 2); x <= Math.ceil(d.x + d.r + 2); x++) {
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          const dist = Math.hypot(x + 0.5 - d.x, y + 0.5 - d.y);
          const ring = Math.exp(-(((dist - radius) / 0.7) ** 2)) * (1 - t) ** 1.5;
          const dot = t < 0.15 ? Math.exp(-((dist / 1.2) ** 2)) * (1 - t / 0.15) : 0;
          const i = y * size + x;
          a[i] = Math.min(1, a[i] + (ring + dot) * d.bright);
        }
    }
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) a[y * size + x] *= 1 - smooth(0.78, 0.98, Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2));
    return rainFrame(size, size, a);
  });
}

// ---- the dirt in the air -------------------------------------------------------------------------------
const DIRT = [0.36, 0.33, 0.27];

/** Smooth noise over a lattice that repeats every `period` cells along x, so a field of it tiles sideways. */
function wrappedNoise(x, y, period, seed) {
  const hash = (i, j) => {
    let h = Math.imul(((i % period) + period) % period, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(seed + 1, 1274126177);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const [ix, iy] = [Math.floor(x), Math.floor(y)];
  const [fx, fy] = [x - ix, y - iy];
  const [sx, sy] = [fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)];
  const top = hash(ix, iy) + (hash(ix + 1, iy) - hash(ix, iy)) * sx;
  const bottom = hash(ix, iy + 1) + (hash(ix + 1, iy + 1) - hash(ix, iy + 1)) * sx;
  return top + (bottom - top) * sy;
}

/**
 * The fog's frames: haze that is thickest along the sheet's foot and thins to nothing by its top, its ends faded
 * so the sheet's edges never show. Two layers of it, each tiling sideways, drift past each other -- one a whole
 * tile one way over the loop, the other a whole tile back -- so it stirs and the last frame runs into the first.
 */
function fogFrames(count, { width = 256, height = 64, cells = 8, most = 0.62, seed = 5 } = {}) {
  const layer = (x, y, shift, s) => {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    for (let k = 0; k < 3; k++) {
      const scale = cells * 2 ** k;
      sum += amp * wrappedNoise(((x / width) * scale + shift * scale) % scale, (y / height) * (scale / 4) + k * 7.3, scale, s + k);
      norm += amp;
      amp *= 0.5;
    }
    return sum / norm;
  };
  return Array.from({ length: count }, (_, f) => {
    const p = f / count;
    const a = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      const up = 1 - (y + 0.5) / height; // 0 at the foot, 1 at the top
      const thick = (1 - smooth(0.12, 0.95, up)) ** 1.3;
      for (let x = 0; x < width; x++) {
        const u = (x + 0.5) / width;
        const ends = smooth(0, 0.2, u) * (1 - smooth(0.8, 1, u));
        const haze = 0.6 * layer(x, y, p, seed) + 0.4 * layer(x, y, -p, seed + 11);
        a[y * width + x] = clamp01(most * thick * ends * (0.35 + 0.9 * (haze - 0.3)));
      }
    }
    const rgb = new Float32Array(width * height * 3);
    for (let i = 0; i < width * height; i++) rgb.set(DIRT.map((c) => c * a[i]), i * 3);
    return { width, height, rgb, a };
  });
}

// ---- the sprites ---------------------------------------------------------------------------------

/** Frames for one group: `count` of them round a loop, each `step` seconds. */
const loop = (count, make) => Array.from({ length: count }, (_, n) => make(n / count));

/** One group a list of frames, each frame `step` seconds: the cumulative ends the file wants. */
const groupsOf = (lists, step) => {
  let first = 0;
  return lists.map((list) => {
    const g = { first, count: list.length, ends: list.map((_, k) => +(step * (k + 1)).toFixed(4)) };
    first += list.length;
    return g;
  });
};

const SPRITES = [
  ...[NEUTRAL, MSR, INS].map((colour, n) => ({
    name: `tsm_zone_ring_${n}`,
    type: "oriented",
    lists: [loop(10, (p) => frame(128, ringLight(colour, p)))],
    step: 0.1,
  })),
  {
    name: "tsm_zone_ring_cap",
    type: "oriented",
    lists: [loop(8, (p) => frame(128, ringLight(AMBER, p, { pulses: 2, turns: 2, bright: 1.15 })))],
    step: 0.07,
  },
  {
    name: "tsm_zone_flag",
    type: "parallel",
    lists: [0, 1, 2].map((holder) => loop(8, (p) => frame(64, flagLight(holder, p)))),
    step: 0.15,
  },
  {
    name: "tsm_uplink_mark",
    type: "parallel",
    lists: [MSR, INS].map((colour) => loop(8, (p) => frame(64, markLight(colour, p)))),
    step: 0.1,
  },
  {
    name: "tsm_obj_mark",
    type: "parallel",
    lists: [true, false].map((attack) => loop(8, (p) => frame(64, objLight(attack, p)))),
    step: 0.12,
  },
  { name: "h9_drain_rain", type: "upright", lists: [rainFrames(16)], step: 0.05 },
  { name: "h9_drain_splash", type: "oriented", lists: [splashFrames(12)], step: 0.06 },
  { name: "h9_drain_fog", type: "upright", format: "index alpha", colour: DIRT, lists: [fogFrames(32)], step: 0.3 },
];

mkdirSync(OUT, { recursive: true });
const written = [];
for (const s of SPRITES) {
  const frames = s.lists.flat();
  // additive unless the sprite says otherwise; an index alpha sprite is one colour, its pixels the alpha
  const format = s.format ?? "additive";
  const { palette, pixels, colours } = quantiseFrames(frames, format, { colour: s.colour });
  const bytes = writeSpr({
    type: s.type,
    format,
    palette,
    frames: frames.map((f, i) => ({ width: f.width, height: f.height, pixels: pixels[i] })),
    groups: groupsOf(s.lists, s.step),
  });
  const file = join(OUT, `${s.name}.spr`);
  writeFileSync(file, bytes);

  // Read back, as the engine would, and measured: every group a loop.
  const spr = M.readSpr(bytes);
  const sheet = sheetOf(spr, { cols: 10, cell: 96 });
  writeFileSync(join(OUT, `${s.name}-sheet.png`), K.png(sheet.width, sheet.height, sheet.rgba));
  writeFileSync(join(OUT, `${s.name}-animated.png`), animationOf(spr, { fps: Math.round(1 / s.step), cell: 160, loop: true }));
  const m = measureSprite(spr, { loop: true });
  console.log(
    `${s.name}.spr  ${bytes.length} bytes  ${spr.type}  groups ${s.lists.length} x ${s.lists[0].length} frames  ${colours} colours` +
      `  border max ${m.border?.max?.toFixed?.(3) ?? "?"}  wrap ${m.wrap?.toFixed?.(2) ?? "?"}  jitter ${m.jitter?.toFixed?.(2) ?? "?"}`,
  );
  written.push(file);
}

if (process.argv.includes("deploy")) {
  const targets = [join(TSM, "sprites"), join(GAME_DIR, "ts", "sprites")];
  for (const dir of targets) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    for (const file of written) copyFileSync(file, join(dir, file.split(/[\\/]/).pop()));
    console.log(`deployed ${written.length} sprite(s) to ${dir}`);
  }
}
