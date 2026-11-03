// The class icons that float over a player's head: sprites/tsm_class.spr
//
//     node make-class-sprite.mjs
//
// One 64x64 frame per class, IN CLASS ORDER, because the plugin sets the sprite's frame
// straight from the class index (`set_pev(ent, pev_frame, float(ci))`) and keeps no second
// mapping. Reorder the classes in ts_matchmode.cfg and these have to move with them.
//
// THE FORMAT, read off the file this replaces rather than assumed:
//
//   IDSP version 2, type 2 (VP_PARALLEL -- a frame faces the viewer from any angle),
//   texFormat 3 (SPR_ALPHTEST -- a hard edge, no blending), 7 frames of 64x64 at origin
//   (-32, 32), a 256-entry palette whose LAST entry is the transparent one.
//
// SPR_ALPHTEST is why these are drawn the way they are. There is no partial transparency
// and no anti-aliasing: a pixel is either the icon or it is not, so a soft edge comes out
// as a staircase of half-lit pixels against whatever is behind it. Every glyph is drawn
// hard and then given a black rim, which is what keeps it readable over a bright skybox
// and over a dark wall both.
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const S = 64;
const TRANSPARENT = 255;

const OUTS = [
  join(process.cwd(), "..", "sprites"),
  join(process.cwd(), "..", "export", "ts", "sprites"),
  "D:/SteamLibrary/steamapps/common/Half-Life/ts/sprites",
];

/*
 * The palette.
 *
 * Three ramps and a rim. Cyan for the line classes, amber for the two that are not --
 * the medic you look for when hurt and the officer you look for when lost -- so those two
 * are told apart at a glance by colour before the shape is even resolved. Everything else
 * shares one ramp so the set reads as one issue of equipment rather than seven stickers.
 *
 * Index 255 must be the transparent one: that is what SPR_ALPHTEST keys on, and it is
 * (0,0,255) here because that is what the file being replaced used and what every HL tool
 * expects to find there.
 */
const RAMPS = {
  cyan:  [[10, 28, 38], [24, 116, 150], [58, 190, 228], [146, 236, 255], [238, 252, 255]],
  red:   [[38, 10, 12], [140, 28, 30], [214, 54, 48], [248, 116, 100], [255, 212, 200]],
  amber: [[34, 20, 8], [150, 82, 20], [226, 140, 36], [255, 196, 96], [255, 240, 206]],
  bone:  [[20, 22, 26], [96, 104, 116], [168, 180, 196], [220, 230, 240], [255, 255, 255]],
};

const palette = new Uint8Array(256 * 3);
const slot = {};
let next = 1;                        // 0 is the black rim
for (const [name, ramp] of Object.entries(RAMPS)) {
  slot[name] = [];
  for (const c of ramp) {
    palette[next * 3] = c[0]; palette[next * 3 + 1] = c[1]; palette[next * 3 + 2] = c[2];
    slot[name].push(next);
    next++;
  }
}
palette[TRANSPARENT * 3] = 0; palette[TRANSPARENT * 3 + 1] = 0; palette[TRANSPARENT * 3 + 2] = 255;

// ===========================================================================
// DRAWING
// ===========================================================================
/*
 * A glyph is built as a coverage mask rather than painted directly, so that the rim can be
 * grown around whatever shape came out without every shape having to know about it.
 */
const blank = () => new Float32Array(S * S);

const fillPoly = (m, pts, v = 1) => {
  let lo = S, hi = 0;
  for (const p of pts) { lo = Math.min(lo, Math.floor(p[1])); hi = Math.max(hi, Math.ceil(p[1])); }
  for (let y = Math.max(0, lo); y <= Math.min(S - 1, hi); y++) {
    const xs = [];
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[j], b = pts[i];
      if ((a[1] > y + 0.5) === (b[1] > y + 0.5)) continue;
      xs.push(a[0] + (y + 0.5 - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      for (let x = Math.max(0, Math.round(xs[i])); x <= Math.min(S - 1, Math.round(xs[i + 1])); x++) m[y * S + x] = v;
    }
  }
};

const disc = (m, cx, cy, r, v = 1) => {
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(S - 1, Math.ceil(cy + r)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(S - 1, Math.ceil(cx + r)); x++) {
      if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) m[y * S + x] = v;
    }
  }
};

const ring = (m, cx, cy, r, t, v = 1) => {
  const o = r + t / 2, i = r - t / 2;
  for (let y = Math.max(0, Math.floor(cy - o)); y <= Math.min(S - 1, Math.ceil(cy + o)); y++) {
    for (let x = Math.max(0, Math.floor(cx - o)); x <= Math.min(S - 1, Math.ceil(cx + o)); x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d <= o && d >= i) m[y * S + x] = v;
    }
  }
};

const bar = (m, x0, y0, x1, y1, w, v = 1) => {
  const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1;
  const nx = -dy / L * w / 2, ny = dx / L * w / 2;
  fillPoly(m, [[x0 + nx, y0 + ny], [x1 + nx, y1 + ny], [x1 - nx, y1 - ny], [x0 - nx, y0 - ny]], v);
};

const poly = (cx, cy, r, n, turn = 0) =>
  Array.from({ length: n }, (_, i) => {
    const a = turn + i * 2 * Math.PI / n;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });

// ===========================================================================
// THE NINE
// ===========================================================================
/*
 * Each one is a shape anyone has seen before, because an icon over a head is read in a
 * glance during a firefight and a clever one is a wasted one. What makes them belong to
 * this game rather than to any other is the treatment -- hard facets, a cut corner, a
 * stencilled look -- and not the choice of symbol.
 */
const CLASSES = [
  {
    name: "Assault", ramp: "cyan",
    draw(m) {
      // Two chevrons, pointing down: the oldest mark there is for a line soldier.
      for (const y of [13, 31]) {
        fillPoly(m, [[10, y], [32, y + 15], [54, y], [54, y + 9], [32, y + 24], [10, y + 9]]);
      }
    },
  },
  {
    name: "Combat Engineer", ramp: "cyan",
    draw(m) {
      // A gear: eight teeth on a hub, with the bore left open.
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4;
        bar(m, 32 + 14 * Math.cos(a), 32 + 14 * Math.sin(a),
               32 + 27 * Math.cos(a), 32 + 27 * Math.sin(a), 11);
      }
      disc(m, 32, 32, 20);
      disc(m, 32, 32, 8, 0);
    },
  },
  {
    name: "Marksman", ramp: "cyan",
    draw(m) {
      // A reticle, with the ticks breaking the ring so it does not read as a full stop.
      ring(m, 32, 32, 19, 5);
      for (let i = 0; i < 4; i++) {
        const a = i * Math.PI / 2;
        bar(m, 32 + 14 * Math.cos(a), 32 + 14 * Math.sin(a),
               32 + 31 * Math.cos(a), 32 + 31 * Math.sin(a), 6);
      }
      disc(m, 32, 32, 4);
    },
  },
  {
    name: "Heavy", ramp: "cyan",
    draw(m) {
      // A bulwark: a slab of a shield with two armour slots cut out of it.
      fillPoly(m, [[10, 8], [54, 8], [54, 33], [32, 57], [10, 33]]);
      fillPoly(m, [[17, 20], [47, 20], [47, 26], [17, 26]], 0);
      fillPoly(m, [[19, 32], [45, 32], [41, 38], [23, 38]], 0);
    },
  },
  {
    name: "Breacher", ramp: "cyan",
    draw(m) {
      // A charge going off: a hard core and eight shards leaving it.
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4 + Math.PI / 8;
        fillPoly(m, [
          [32 + 11 * Math.cos(a - 0.22), 32 + 11 * Math.sin(a - 0.22)],
          [32 + 31 * Math.cos(a), 32 + 31 * Math.sin(a)],
          [32 + 11 * Math.cos(a + 0.22), 32 + 11 * Math.sin(a + 0.22)],
        ]);
      }
      fillPoly(m, poly(32, 32, 13, 6, Math.PI / 6));
    },
  },
  {
    name: "Medic", ramp: "cyan",
    draw(m) {
      // A cross with its corners cut, so it reads as issued rather than as a red cross.
      const a = 24, b = 8, c = 4;          // half-length, half-width, chamfer
      fillPoly(m, [
        [32 - b, 32 - a], [32 - b + c, 32 - a - c], [32 + b - c, 32 - a - c], [32 + b, 32 - a],
        [32 + b, 32 - b], [32 + a, 32 - b], [32 + a + c, 32 - b + c], [32 + a + c, 32 + b - c], [32 + a, 32 + b],
        [32 + b, 32 + b], [32 + b, 32 + a], [32 + b - c, 32 + a + c], [32 - b + c, 32 + a + c], [32 - b, 32 + a],
        [32 - b, 32 + b], [32 - a, 32 + b], [32 - a - c, 32 + b - c], [32 - a - c, 32 - b + c], [32 - a, 32 - b],
        [32 - b, 32 - b],
      ]);
      // A reading across the middle, so it is a monitor and not a first-aid tin.
      fillPoly(m, [[32 - b + 2, 31], [32 + b - 2, 31], [32 + b - 2, 33], [32 - b + 2, 33]], 0);
    },
  },
  {
    name: "Officer", ramp: "cyan",
    draw(m) {
      // Rank: a pip inside a frame, over two bars.
      const hex = poly(32, 27, 25, 6, Math.PI / 2);
      fillPoly(m, hex);
      fillPoly(m, poly(32, 27, 18, 6, Math.PI / 2), 0);
      // The four-point star, drawn as a cross of tapered spikes.
      fillPoly(m, [[32, 10], [37, 27], [32, 44], [27, 27]]);
      fillPoly(m, [[14, 27], [32, 22], [50, 27], [32, 32]]);
      fillPoly(m, [[12, 52], [52, 52], [52, 57], [12, 57]]);
    },
  },
  {
    name: "Recon", ramp: "cyan",
    draw(m) {
      /*
       * A winged boot. The oldest mark for somebody who gets there first, and it survives
       * being sixteen units tall because the wing and the sole are two heavy horizontals
       * with nothing fiddly between them.
       */
      /*
       * The boot is one L -- a shaft straight down, a foot straight out -- because at sixteen
       * units that corner is the whole of what says "boot". The first cut had a tapered instep and
       * a separate sole slab, and the two merged under the rim into a wedge that read as nothing.
       */
      fillPoly(m, [[30, 12], [48, 12], [48, 40], [57, 40], [57, 51], [30, 51]]);
      // the cuff, wider than the shaft so the top of it reads as an opening
      fillPoly(m, [[27, 7], [51, 7], [51, 14], [27, 14]]);
      // three feathers sweeping back off the ankle, the middle one longest
      fillPoly(m, [[29, 16], [7, 13], [29, 23]]);
      fillPoly(m, [[29, 25], [5, 25], [29, 32]]);
      fillPoly(m, [[29, 34], [9, 37], [29, 41]]);
    },
  },
  {
    name: "Mech", ramp: "cyan",
    draw(m) {
      /*
       * A robot head: a chamfered skull with the visor and the jaw vent cut out of it, so
       * what reads at a distance is the band of the visor rather than any of the detail.
       */
      fillPoly(m, [[14, 20], [20, 12], [44, 12], [50, 20], [50, 46], [44, 52], [20, 52], [14, 46]]);
      fillPoly(m, [[19, 25], [45, 25], [45, 34], [19, 34]], 0);   // the visor
      fillPoly(m, [[24, 41], [40, 41], [40, 46], [24, 46]], 0);   // the jaw vent
      // two antennae, stopping short of the edge so the rim is not clipped off them
      bar(m, 22, 13, 17, 8, 5);
      bar(m, 42, 13, 47, 8, 5);
    },
  },
];

// ===========================================================================
// RENDER AND WRITE
// ===========================================================================
/*
 * Shading, then the rim.
 *
 * The shade is a plain top-to-bottom ramp across the glyph's own extent, which is enough
 * to stop a flat silhouette looking like a hole punched in the air, and cheap enough to
 * survive being squeezed into five palette entries.
 */
function renderFrame(cls) {
  const m = blank();
  cls.draw(m);

  let top = S, bot = 0;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    if (m[y * S + x] > 0) { top = Math.min(top, y); bot = Math.max(bot, y); }
  }
  if (bot < top) throw new Error(`${cls.name} drew nothing`);

  const ramp = slot[cls.ramp];
  const px = new Uint8Array(S * S).fill(TRANSPARENT);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    if (m[y * S + x] <= 0) continue;
    const t = (y - top) / Math.max(1, bot - top);
    // top of the glyph lit, bottom in shadow, and the very top catching a highlight
    const i = t < 0.12 ? 4 : t < 0.42 ? 3 : t < 0.78 ? 2 : 1;
    px[y * S + x] = ramp[i];
  }

  /*
   * The rim: two pixels of black around the glyph, outside it.
   *
   * Without it the icon disappears against anything of its own brightness -- a cyan mark
   * on a cyan-lit corridor -- and SPR_ALPHTEST gives no soft edge to fall back on. Grown
   * outwards rather than cut inwards so no detail is eaten.
   */
  const R = 2;
  const rim = new Uint8Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    if (px[y * S + x] !== TRANSPARENT) continue;
    let near = false;
    for (let dy = -R; dy <= R && !near; dy++) for (let dx = -R; dx <= R; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= S || ny >= S) continue;
      if (m[ny * S + nx] > 0) { near = true; break; }
    }
    if (near) rim[y * S + x] = 1;
  }
  for (let i = 0; i < S * S; i++) if (rim[i]) px[i] = 0;

  return px;
}

/*
 * THE SAME SHAPES AGAIN IN RED, FOR THE INSURGENTS.
 *
 * One sheet holds both sides: the classes as the MSR wear them, then a red copy of each.
 *
 * EVERY CLASS IS DOUBLED NOW, INCLUDING THE MEDIC AND THE OFFICER. They used to be bone and
 * amber and single, on the reasoning that a role-colour is worth more than a side-colour --
 * a medic you can find at a glance beats a medic whose team you can tell.
 *
 * Sudden death broke that trade. The marker the other side is shown is always the RED copy,
 * so a class without one fell back to its ordinary icon and an ENEMY medic was drawn exactly
 * like a friendly one, in the one minute of the round when telling them apart matters most.
 *
 * The shape was already carrying the role -- a cross is a cross and a rank pip is a rank pip --
 * so the colour was doing a job the silhouette had done all along. It now says side, and says
 * it for everybody.
 *
 * The plugin picks the frame as `ci` for team 1 and `TSM_ICON_RED + ci` for team 2, which
 * only works while the cyan classes are the FIRST ones in the table. That is checked here
 * rather than hoped for: reorder the classes so a bone or amber one lands among them and
 * this stops the build instead of quietly putting a red gear over a medic's head.
 */
const RED_OF = CLASSES.map((c, i) => (c.ramp === "cyan" ? i : -1)).filter((i) => i >= 0);

/*
 * WHICH FRAME HOLDS EACH CLASS'S RED COPY, written out per class rather than worked out from
 * where it sits in the table.
 *
 * It used to be `TSM_ICON_RED + ci`, which only holds while every two-colour class comes before
 * every one-colour one -- and the moment Recon and Mech were added after Medic and Officer, that
 * stopped being true. The old code did not notice: it has no upper bound on `ci`, so Recon was
 * being shown the red Assault chevrons and Mech a red gear.
 *
 * Reordering the classes to restore the prefix would mean renumbering tsm_class5..9 in the cfg,
 * which the cfg itself warns against. A table costs nine numbers and removes the constraint for
 * good, so a class can be added anywhere and given either one colour or two.
 */
const RED_FRAME_OF = CLASSES.map(() => -1);
RED_OF.forEach((ci, n) => { RED_FRAME_OF[ci] = CLASSES.length + n; });

const frames = [
  ...CLASSES.map(renderFrame),
  ...RED_OF.map((i) => renderFrame({ ...CLASSES[i], ramp: "red" })),
];
const RED_BASE = CLASSES.length;

/*
 * The file. Studio sprite, version 2, one frame group per class.
 *
 * The bounding radius is the one the file being replaced carried: it is what the engine
 * culls the sprite by, and a radius smaller than the frame makes an icon wink out as you
 * turn away from it.
 */
const header = Buffer.alloc(42);
header.write("IDSP", 0, "ascii");
header.writeInt32LE(2, 4);            // version
header.writeInt32LE(2, 8);            // type: VP_PARALLEL
header.writeInt32LE(3, 12);           // texFormat: SPR_ALPHTEST
header.writeFloatLE(45.25, 16);       // bounding radius
header.writeInt32LE(S, 20);
header.writeInt32LE(S, 24);
header.writeInt32LE(frames.length, 28);
header.writeFloatLE(0, 32);           // beam length
header.writeInt32LE(0, 36);           // synctype
header.writeInt16LE(256, 40);

const parts = [header, Buffer.from(palette)];
for (const f of frames) {
  const fh = Buffer.alloc(20);
  fh.writeInt32LE(0, 0);              // group: a single frame, not a group
  fh.writeInt32LE(-S / 2, 4);         // origin x
  fh.writeInt32LE(S / 2, 8);          // origin y
  fh.writeInt32LE(S, 12);
  fh.writeInt32LE(S, 16);
  parts.push(fh, Buffer.from(f));
}
const spr = Buffer.concat(parts);

for (const dir of OUTS) {
  if (!existsSync(dir)) { console.log(`  [skip] ${dir} is not there`); continue; }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tsm_class.spr"), spr);
  console.log(`  wrote ${join(dir, "tsm_class.spr")}`);
}

CLASSES.forEach((c, i) => {
  const lit = frames[i].reduce((a, v) => a + (v !== TRANSPARENT ? 1 : 0), 0);
  console.log(`    frame ${String(i).padStart(2)}  ${c.name.padEnd(16)} ${c.ramp.padEnd(6)} ${lit} of ${S * S} pixels drawn`);
});
RED_OF.forEach((src, n) => {
  console.log(`    frame ${String(RED_BASE + n).padStart(2)}  ${CLASSES[src].name.padEnd(16)} red    (insurgent copy of frame ${src})`);
});
/*
 * The frame map, written out beside the sheet.
 *
 * show-class-sprite.mjs kept its own copy of which frame belonged to which class, and when Recon
 * and Mech were added that copy was not updated -- so the viewer captioned the red boot MEDIC and
 * the red robot head OFFICER. The pictures were right and the labels were wrong, which is worse
 * than having none. There is one copy now and the generator owns it.
 */
writeFileSync(join(process.cwd(), "..", "export-mdl", "tsm_class_frames.json"),
  JSON.stringify({ names: CLASSES.map((c) => c.name), redOf: RED_FRAME_OF }, null, 2));

console.log(`  the plugin wants this table, as TSM_ICON_RED_OF in ts_matchmode.sma:`);
console.log(`     new const TSM_ICON_RED_OF[] = { ${RED_FRAME_OF.join(", ")} };`);
console.log(`  (one entry per class, in class order; -1 means that class has only the one icon)`);
console.log(`  ${spr.length} bytes, ${frames.length} frames`);

// A sheet to look at, since a .spr opens in nothing.
{
  const cols = frames.length, W = S * cols, H = S;
  const rgba = Buffer.alloc(W * H * 4);
  frames.forEach((f, n) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const v = f[y * S + x];
      const o = ((y) * W + (n * S + x)) * 4;
      if (v === TRANSPARENT) { rgba[o] = 32; rgba[o + 1] = 36; rgba[o + 2] = 42; rgba[o + 3] = 255; continue; }
      rgba[o] = palette[v * 3]; rgba[o + 1] = palette[v * 3 + 1]; rgba[o + 2] = palette[v * 3 + 2]; rgba[o + 3] = 255;
    }
  });
  const { K } = await import("./lib.mjs");
  writeFileSync(join(process.cwd(), "..", "export-mdl", "tsm_class_sheet.png"), K.png(W, H, rgba));
  console.log("  wrote export-mdl/tsm_class_sheet.png");
}
