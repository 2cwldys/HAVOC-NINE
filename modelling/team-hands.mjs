// The first-person hands (and the kicking legs), one set for each side: MSR, the Insurgents, and a default for anyone on neither,
// and one for each droid player model.
//
// WHAT IT MAKES. For every viewmodel in the game (the v_*.mdl in models/, and the ones H9 adds in models/h9/:
// the PPSh-41 and the laser rifle) and for each of the five sets, a copy of that model with the hands picture
// (`arms256.bmp`, inside the model: GoldSrc keeps a model's pictures in the .mdl) replaced by the set's picture. The
// copies go to models/matchmode/<set>/<the model's own path>, e.g.
//     models/matchmode/msr/v_ak47.mdl            models/matchmode/insurgent/h9/v_ppsh41.mdl
// The game's own models are never written: ts_matchmode (h9_customhands) points the client at the copy for the player's
// side, in the plugin's fw_updateclientdata_post.
//
// THE SETS (modelling/hands/*.bmp are the pictures; every one has a 256 version for the usual models and a 512 one
// for v_melee, whose hands picture is that size)
//     msr         black glove and sleeve with a BLUE cuff.
//     insurgent   the same with a GREEN cuff and red-brown wear flecks.
//     default     the msr picture with the cuff taken out, the stripe and the black line beside it, so the sleeve runs on with
//                 no band at all. Worn in normal TS play (h9_customhands on, the match mode off) and by a player on neither side.
// The pictures are 8-bit like the game's: the cuff is a handful of palette entries and a few rows, so the default is made from
// msr by noStripe() below (the stripe's entries take the sleeve's own colour and its rows are blended over from the sleeve above
// and below), not drawn again.
//
// THE LEGS. v_melee.mdl (the kicks) is the one viewmodel with a body: its second picture, `seal_body.bmp`, is the "seal" merc's
// atlas (vest, cargo pants, boots), and the kicking leg is on the screen in the kicks. A model that has that picture gets the
// set's body picture in each copy as well, beside the hands, made by team-legs.mjs from the stock picture (so hands/ holds no file
// for it):
//     default     black military cargo pants and glossy black boots.
//     msr         the RepuHeavy look: near-black cool pants, a gunmetal knee plate, the blue band under the knee, gunmetal boots.
//     insurgent   the XCCP look (XCCPSoldier-wartorn): dark grey digital camouflage pants, a dark knee plate, the green knee guard
//                 under it, grey boots.
// The gating is the hands': h9_customhands 0 is the stock model with its olive pants, 1 the side's copy, and normal TS play and a
// player on neither side wear the default.
//
// THE DROIDS. A player who wears a droid player model (models/player/msrdroid_bot, models/player/insdroid_bot) sees droid arms in every
// viewmodel and, in the kicks, droid legs, in place of his side's set: two more sets, msrdroid and insdroid, made by team-droids.mjs
// from the droid models' own plating (hands/ holds no file for them either). Metal forearms with a piston and a wrist band, segmented
// metal fingers, plated thighs and shins with an exposed knee joint, a metal foot; the side shows in thin lights only (MSR blue,
// insurgent green). ts_matchmode.sma picks the set by the model the player wears, and precaches these two only on a map that plays the
// match and whose class table lists a droid model for that side, since they add as much to the download as the other three together
// (the plugin's h9_customhands block says how much). A model that is not here falls back to the player's side set.
//
// A WEAPON ADDED TO THE GAME needs its model found here and named in ts_matchmode.sma's g_hand_files. Nothing to edit in
// this file: it takes every v_*.mdl in models/ and models/h9/. Run it again, then build the plugin.
//
// THE MECH'S VIEW MODELS ARE LEFT ALONE. v_mech*.mdl (the Mech's minigun and rocket launcher, models/h9/) have no hands: they are
// the Mech's own armoured arms, and their msr / insurgent / default sets differ in the colour of a band on the arm, which is
// painted by modelling/mech-arms/ (build-minigun.mjs and build-pod.mjs write all three sets). This generator would write a
// glove picture over a texture those models do not have, so it skips every v_mech*.mdl, here and in models/h9/.
//
// Nothing in it is random, and every picture comes from the stock models, hands/ and the droid player models: running it again
// gives the same bytes, and a copy already on disk with those bytes is left alone.
//
//   node modelling/team-hands.mjs                  build every set into the game's models/matchmode, checking each (the hands
//                                                  picture, the body picture, the size, GoldSrc's own checks)
//   node modelling/team-hands.mjs --dry            build and check, write nothing
//   node modelling/team-hands.mjs --only v_ak47,v_ppsh41 --preview     a few models and a picture of the three sets
//   node modelling/team-hands.mjs --only v_melee --preview             the kicks as the player sees them, stock + the five sets
//                                                  (out/team-hands/legs.png), and the body pictures (legs-<set>.bmp)
//   node modelling/team-hands.mjs --only v_ak47,v_mk23,v_m3,v_katana --preview     also out/team-hands/arms.png: those weapons'
//                                                  arms, stock + the five sets, as the player sees them
//   node modelling/team-droids.mjs --sample msrdroid_bot       the droid's plating colours (what team-droids.mjs paints with)
//   node modelling/team-hands.mjs --extract <set-dir> <msr|insurgent>   one-time: read the set's pictures out of an
//                                                  existing set folder into modelling/hands (how the first ones were taken)
//
// The game folder is H9XASH/ts beside this folder, or H9_GAME. Output pictures and a report: modelling/out/team-hands/.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { K, OUT } from "./lib.mjs";
import { legPictures, kickSheet, BODY } from "./team-legs.mjs";
import { droidHandPictures, droidBodyPictures, DROID_SETS } from "./team-droids.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GAME = resolve(process.env.H9_GAME ?? join(HERE, "..", "H9XASH", "ts"));
const MODELS = join(GAME, "models");
const SETS_AT = join(MODELS, "matchmode");
const HANDS = join(HERE, "hands");
const REPORT = join(OUT, "team-hands");
const TARGET = "arms256.bmp";
const SETS = ["msr", "insurgent", "default", ...DROID_SETS];

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const only = option("--only", null)?.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const dry = args.includes("--dry");
const preview = args.includes("--preview");
const hash = (buf) => createHash("sha256").update(buf).digest("hex");

const textureFile = (set, size) => join(HANDS, `${set}-${size}.bmp`);

// ---- one-time: take a set's pictures out of finished models --------------------------------------------------------
if (args.includes("--extract")) {
  const dir = args[args.indexOf("--extract") + 1];
  const set = args[args.indexOf("--extract") + 2];
  if (!dir || !["msr", "insurgent"].includes(set)) {
    console.error("usage: --extract <folder of a finished set> <msr|insurgent>");
    process.exit(2);
  }
  mkdirSync(HANDS, { recursive: true });
  for (const [model, size] of [["v_ak47.mdl", 256], ["v_melee.mdl", 512]]) {
    const t = K.textureOf(readFileSync(join(dir, model)), TARGET);
    if (t.width !== size || t.height !== size) throw new Error(`${model}: ${t.width}x${t.height}, not ${size}`);
    writeFileSync(textureFile(set, size), K.bmp(t));
    console.log(`${textureFile(set, size)}  from ${join(dir, model)}`);
  }
  process.exit(0);
}

// ---- the pictures ---------------------------------------------------------------------------------------------------
/**
 * The cuff taken out, stripe and black line both. The art puts the coloured stripe between black lines, and a dark band on a dark sleeve
 * still reads as a stripe, so two things go:
 *   - every blue-dominant palette entry takes the sleeve's own colour (the mean of the picture a few rows under the stripe), so no blue
 *     pixel is left anywhere in the picture;
 *   - the rows the stripe and the black line beside it cover are filled from the sleeve above and below: each column blends the pixel over
 *     the band into the pixel under it, so the sleeve runs on unbroken. Unused black in the picture is left as it was.
 */
function noStripe(tex) {
  const { width, height } = tex;
  const rgb = (i) => [tex.palette[i * 3], tex.palette[i * 3 + 1], tex.palette[i * 3 + 2]];
  const blue = (i) => {
    const [r, g, b] = rgb(i);
    return b > r + 25 && b > g + 8;
  };
  const hole = (i) => {
    const [r, g, b] = rgb(i);
    return r + g + b <= 1;
  };
  const luma = (i) => {
    const [r, g, b] = rgb(i);
    return r * 0.3 + g * 0.59 + b * 0.11;
  };
  const scale = height / 256;
  const reach = Math.max(1, Math.round(scale * 5));
  let r = 0, g = 0, b = 0, n = 0;
  let top = height, bot = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!blue(tex.pixels[y * width + x])) continue;
      top = Math.min(top, y);
      bot = Math.max(bot, y);
      const under = tex.pixels[Math.min(height - 1, y + reach) * width + x];
      if (blue(under)) continue;
      r += tex.palette[under * 3];
      g += tex.palette[under * 3 + 1];
      b += tex.palette[under * 3 + 2];
      n++;
    }
  }
  const sleeve = n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : [24, 26, 30];
  const palette = Uint8Array.from(tex.palette);
  let turned = 0;
  for (let i = 0; i < 256; i++) {
    if (!blue(i)) continue;
    palette[i * 3] = sleeve[0];
    palette[i * 3 + 1] = sleeve[1];
    palette[i * 3 + 2] = sleeve[2];
    turned++;
  }

  // the rows to blend over: the stripe's, and the black lines (rows far darker than the sleeve) touching it
  const pixels = Uint8Array.from(tex.pixels);
  let rows = null;
  if (bot >= top) {
    const rowLuma = (y) => {
      let s = 0, c = 0;
      for (let x = 0; x < width; x++) {
        const i = tex.pixels[y * width + x];
        if (hole(i)) continue;
        s += luma(i);
        c++;
      }
      return c ? s / c : 0;
    };
    const around = [];
    for (let y = Math.round(top - 20 * scale); y <= Math.round(top - 8 * scale); y++) if (y >= 0) around.push(rowLuma(y));
    for (let y = Math.round(bot + 8 * scale); y <= Math.round(bot + 20 * scale); y++) if (y < height) around.push(rowLuma(y));
    const sample = around.filter((v) => v > 0).sort((p, q) => p - q);
    const ref = sample.length ? sample[sample.length >> 1] : 0;
    const dark = (y) => {
      const v = rowLuma(y);
      return v > 0 && v < ref * 0.35;
    };
    let zTop = top, zBot = bot;
    while (zTop - 1 >= 0 && top - zTop < 8 * scale && dark(zTop - 1)) zTop--;
    while (zBot + 1 < height && zBot - bot < 8 * scale && dark(zBot + 1)) zBot++;
    if (zTop >= 1 && zBot + 1 < height) {
      const usable = [];
      for (let i = 0; i < 256; i++) if (!blue(i) && !hole(i)) usable.push(i);
      const nearest = (c) => {
        let best = usable[0], bd = Infinity;
        for (const i of usable) {
          const [pr, pg, pb] = rgb(i);
          const d = (pr - c[0]) ** 2 + (pg - c[1]) ** 2 + (pb - c[2]) ** 2;
          if (d < bd) {
            bd = d;
            best = i;
          }
        }
        return best;
      };
      for (let x = 0; x < width; x++) {
        const above = tex.pixels[(zTop - 1) * width + x];
        const below = tex.pixels[(zBot + 1) * width + x];
        if (hole(above) && hole(below)) continue;
        const ca = rgb(hole(above) ? below : above);
        const cb = rgb(hole(below) ? above : below);
        for (let y = zTop; y <= zBot; y++) {
          if (hole(tex.pixels[y * width + x])) continue;
          const t = (y - zTop + 1) / (zBot - zTop + 2);
          pixels[y * width + x] = nearest([0, 1, 2].map((k) => ca[k] + (cb[k] - ca[k]) * t));
        }
      }
      rows = [zTop, zBot];
    }
  }
  return { ...tex, palette, pixels, turned, sleeve, rows };
}

const pictures = {};
for (const size of [256, 512]) {
  for (const set of ["msr", "insurgent"]) {
    const file = textureFile(set, size);
    if (!existsSync(file)) {
      console.error(`missing ${file} (modelling/hands holds msr-256, msr-512, insurgent-256 and insurgent-512 .bmp)`);
      process.exit(1);
    }
    pictures[`${set}-${size}`] = K.unbmp(readFileSync(file));
  }
  const n = noStripe(pictures[`msr-${size}`]);
  pictures[`default-${size}`] = n;
  console.log(`default-${size}: ${n.turned} blue palette entries given the sleeve's colour ${n.sleeve.join(",")}, cuff rows ${n.rows ? n.rows.join("-") + " blended" : "not found"}`);
}
// the droids' pictures are painted (team-droids.mjs), from the droid player models and the stock arms layout
const droidHands = droidHandPictures(GAME);
for (const set of DROID_SETS) {
  for (const size of [256, 512]) {
    pictures[`${set}-${size}`] = droidHands[`${set}-${size}`];
    const r = droidHands.report[`${set}-${size}`];
    console.log(`${set}-${size}: painted from ${r.plating} plating texels of the droid model, ${r.colours} colours, mean error ${r.error} levels`);
  }
}

// ---- the models -----------------------------------------------------------------------------------------------------
const found = [];
for (const [folder, prefix] of [[MODELS, ""], [join(MODELS, "h9"), "h9/"]]) {
  if (!existsSync(folder)) continue;
  for (const f of readdirSync(folder).filter((n) => /^v_.*\.mdl$/i.test(n)).sort()) {
    if (/^v_mech/i.test(f)) continue;                 // the Mech's arms: their sets are modelling/mech-arms/'s (see the header)
    if (only && !only.includes(basename(f, ".mdl").toLowerCase())) continue;
    found.push({ rel: prefix + f, file: join(folder, f) });
  }
}
if (!found.length) {
  console.error("no viewmodels matched");
  process.exit(1);
}

/** Whether a texture read back out of a model is the picture that was written into it. */
const sameTexture = (got, pic) =>
  hash(Buffer.from(got.pixels)) === hash(Buffer.from(pic.pixels)) && hash(Buffer.from(got.palette)) === hash(Buffer.from(pic.palette));

const built = [];
const failures = [];
const bodies = [];                                   // the body pictures made, for the report: { rel, set, report }
for (const m of found) {
  const src = readFileSync(m.file);
  let old;
  try {
    old = K.textureOf(src, TARGET);
  } catch (e) {
    failures.push(`${m.rel}: no ${TARGET}`);
    continue;
  }
  // a model with a body picture (v_melee's seal_body.bmp) gets the set's body as well as its hands
  let legs = null;
  if (K.readMdl(src).textures.some((t) => t.name.toLowerCase() === BODY)) {
    try {
      legs = legPictures(src);
      const droidLegs = droidBodyPictures(GAME, src);
      for (const set of DROID_SETS) legs[set] = droidLegs[set];
      Object.assign(legs.report, droidLegs.report);
    } catch (e) {
      failures.push(`${m.rel}: ${BODY}: ${e.message}`);
      continue;
    }
  }
  for (const set of SETS) {
    const pic = pictures[`${set}-${old.width}`];
    if (!pic || old.width !== old.height) {
      failures.push(`${m.rel}: ${TARGET} is ${old.width}x${old.height}, and there is no ${set} picture of that size`);
      continue;
    }
    try {
      const tex = { width: pic.width, height: pic.height, pixels: pic.pixels, palette: pic.palette, flags: old.flags };
      let out = K.replaceTexture(src, TARGET, tex, { quiet: true });
      if (legs) out = K.replaceTexture(out, BODY, legs[set], { quiet: true });
      const check = K.check(out, "goldsrc");
      if (check.errors.length) throw new Error(check.errors.join("; "));
      if (!sameTexture(K.textureOf(out, TARGET), pic)) throw new Error("the picture read back is not the one written");
      if (legs && !sameTexture(K.textureOf(out, BODY), legs[set])) throw new Error(`the ${BODY} read back is not the one written`);
      if (out.length !== src.length) throw new Error(`the model changed size, ${src.length} -> ${out.length}`);
      built.push({ rel: m.rel, set, out, srcHash: hash(src), outHash: hash(out) });
      if (legs) bodies.push({ rel: m.rel, set, tex: legs[set], report: legs.report[set] });
    } catch (e) {
      failures.push(`${m.rel} (${set}): ${e.message}`);
    }
  }
}

let changed = 0;
if (!dry) {
  for (const b of built) {
    const to = join(SETS_AT, b.set, b.rel);
    // a copy already on disk with these bytes is left alone, its time too: nothing downstream sees a change
    if (existsSync(to) && readFileSync(to).equals(b.out)) continue;
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, b.out);
    changed++;
  }
}
mkdirSync(REPORT, { recursive: true });
const bodyLines = bodies.map((b) => `body ${b.set}/${b.rel} ${BODY} ${b.report.colours} colours, mean error ${b.report.errorLegs} levels on the legs, ${b.report.errorRest} elsewhere`);
writeFileSync(
  join(REPORT, "report.txt"),
  [`game ${GAME}`, `models ${found.length}, sets ${SETS.join(" ")}`, ...built.map((b) => `${b.set}/${b.rel} ${b.srcHash.slice(0, 12)} -> ${b.outHash.slice(0, 12)}`), ...bodyLines, ...failures.map((f) => `FAIL ${f}`)].join("\n") + "\n",
);
for (const b of bodies) writeFileSync(join(REPORT, `legs-${b.set}.bmp`), K.bmp(b.tex));
console.log(`${built.length} model(s) ${dry ? "built (nothing written)" : `built, ${changed} written under ${SETS_AT}`}, ${failures.length} failed`);
for (const line of bodyLines) console.log("  " + line);
for (const f of failures) console.error("  " + f);

if (preview) {
  const picks = built.filter((b) => ["v_ak47", "v_m16", "v_melee", "v_ppsh41", "v_laserrifle"].includes(basename(b.rel, ".mdl")));
  const list = [];
  for (const rel of [...new Set(picks.map((p) => p.rel))]) {
    for (const set of SETS) {
      const b = picks.find((p) => p.rel === rel && p.set === set);
      if (b) list.push([`${basename(rel, ".mdl")} ${set}`, b.out]);
    }
  }
  if (list.length) {
    const img = K.lineup(list, { yaws: [20], pitch: 6, zoom: 1.25, width: 300, height: 420, cols: 3 });
    writeFileSync(join(REPORT, "sets.png"), K.png(img.width, img.height, img.rgba));
    console.log(`preview: ${join(REPORT, "sets.png")}`);
  }
  // the kicks, as the player sees them: the stock model, then the three sets
  const melee = found.find((m) => /^v_melee\.mdl$/i.test(m.rel));
  if (melee) {
    const kicks = [["stock", readFileSync(melee.file)]];
    for (const set of ["default", "msr", "insurgent", ...DROID_SETS]) {
      const b = built.find((p) => p.rel === melee.rel && p.set === set);
      if (b) kicks.push([set, b.out]);
    }
    const sheet = kickSheet(kicks, { width: 260, height: 195 });
    writeFileSync(join(REPORT, "legs.png"), K.png(sheet.width, sheet.height, sheet.rgba));
    console.log(`preview: ${join(REPORT, "legs.png")}`);
  }
  // the arms of a few weapons as the player sees them: a row for each weapon, the stock model and then each set
  const shots = [];
  const names = [];
  const sets = ["default", "msr", "insurgent", ...DROID_SETS];
  for (const m of found.filter((f) => /^(v_ak47|v_mk23|v_m3|v_katana)\.mdl$/i.test(f.rel))) {
    const row = [["stock", readFileSync(m.file)]];
    for (const set of sets) {
      const b = built.find((p) => p.rel === m.rel && p.set === set);
      if (b) row.push([set, b.out]);
    }
    if (row.length < sets.length + 1) continue;
    for (const [name, model] of row) {
      shots.push(K.render(model, { view: "first", seq: 0, frame: 0, width: 260, height: 195, fov: 90, near: 4 }));
      names.push(`${basename(m.rel, ".mdl")} ${name}`);
    }
  }
  if (shots.length) {
    const sheet = K.tile(shots, sets.length + 1, names);
    writeFileSync(join(REPORT, "arms.png"), K.png(sheet.width, sheet.height, sheet.rgba));
    console.log(`preview: ${join(REPORT, "arms.png")}`);
  }
}
if (failures.length) process.exit(1);
