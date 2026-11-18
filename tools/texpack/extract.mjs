// texpack/extract.mjs -- pull every world texture out of the mod, once each.
//
// Reads the BSPs (their embedded textures) and the .wad files, converts each texture to RGBA,
// hashes the pixels, and writes one PNG per DISTINCT image to the work folder. Every place a
// texture appears is recorded, so the index can say what came from where.
//
// Reads only. Nothing in H9XASH or TSM is written; everything lands under --work.
//
//   node tools/texpack/extract.mjs                     the default scan
//   node tools/texpack/extract.mjs --work D:\temp\texpack
//   node tools/texpack/extract.mjs --limit 3           first 3 of each source, for a dry look
//   node tools/texpack/extract.mjs --no-png            scan and count, write no images
//
// Exit 0 = scanned, 1 = a source could not be read at all.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { readWad } from "../../SMAK/core/maps/wad.mjs";
import { readBsp, embeddedTexture } from "../../SMAK/core/maps/bsp.mjs";
import { rgbaOf, png } from "../../SMAK/core/image.mjs";
import { textureOf, texturesInside, withTextures } from "../../SMAK/core/mdl.mjs";
import { readSpr } from "../../SMAK/make/maps/sprites.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TS = path.join(REPO, "H9XASH", "ts");
const VALVE = path.join(REPO, "H9XASH", "valve");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const WORK = path.resolve(value("--work", path.join("D:", "temp", "texpack")));
const LIMIT = Number(value("--limit", "0")) || 0;
const WRITE_PNG = !flag("--no-png");

const KINDS = new Set(value("--kinds", "world,models,sprites").split(",").map((s) => s.trim()));

// The engine's own rule, mod_bmodel.c:2855-2857: only '*' becomes '!'. '{' is kept.
const safeName = (name) => (name.startsWith("*") ? "!" + name.slice(1) : name);
const isMasked = (name) => name.startsWith("{");

// ref/soft/r_studio.c:3016 -- a studio texture named DM_Base* or remap* is the team-colour remap
// path. gl_studio.c:3439 refuses a replacement for those ("colormaps must have the palette for
// properly work"), so they stay at original resolution and the index must say so.
const isColormap = (name) => /^(dm_base|remap)/i.test(name);

const occurrences = []; // one per place a texture is used
const images = new Map(); // sha256 -> { sha, width, height, bytes, masked }
const problems = [];

function note(texture, { kind, source, name, owner, status }) {
  if (!texture || !texture.width || !texture.height) {
    problems.push({ kind, source, name, reason: "no pixels" });
    return;
  }
  const masked = kind === "world" ? isMasked(name) : Boolean(texture.flags & 0x0040); // STUDIO_NF_MASKED
  let rgba;
  try {
    rgba = rgbaOf(texture, masked);
  } catch (e) {
    problems.push({ kind, source, name, reason: e.message.slice(0, 160) });
    return;
  }
  const sha = crypto.createHash("sha256").update(rgba).digest("hex");
  if (!images.has(sha)) images.set(sha, { sha, width: texture.width, height: texture.height, rgba, masked });
  occurrences.push({
    name,
    safe: safeName(name),
    kind,
    owner: owner ?? "",
    source: path.relative(REPO, source).replace(/\\/g, "/"),
    width: texture.width,
    height: texture.height,
    masked,
    status: status ?? "ok",
    sha,
  });
}

function scanWad(file) {
  let wad;
  try {
    wad = readWad(fs.readFileSync(file));
  } catch (e) {
    problems.push({ kind: "wad", source: file, name: "", reason: e.message.slice(0, 160) });
    return 0;
  }
  const list = LIMIT ? wad.textures.slice(0, LIMIT) : wad.textures;
  for (const texture of list) note(texture, { kind: "world", source: file, name: texture.name });
  return list.length;
}

function scanBsp(file) {
  let bsp;
  try {
    bsp = readBsp(fs.readFileSync(file));
  } catch (e) {
    problems.push({ kind: "bsp", source: file, name: "", reason: e.message.slice(0, 160) });
    return 0;
  }
  let n = 0;
  const entries = LIMIT ? bsp.textures.slice(0, LIMIT) : bsp.textures;
  for (const entry of entries) {
    if (entry.absent || !entry.embedded) continue; // WAD-sourced ones come from the wad scan
    const texture = embeddedTexture(bsp, entry.index);
    note(texture, { kind: "world", source: file, name: entry.name });
    n++;
  }
  return n;
}

// `models/v_mp5.mdl` under ts/ -> the engine's model name `models/v_mp5`, which is the
// materials/ subfolder it looks in (gl_studio.c:3441).
function modelOwner(file) {
  return path.relative(TS, file).replace(/\\/g, "/").replace(/\.mdl$/i, "");
}

function scanMdl(file) {
  let src;
  try {
    src = fs.readFileSync(file);
  } catch (e) {
    problems.push({ kind: "mdl", source: file, name: "", reason: e.message.slice(0, 160) });
    return 0;
  }
  // a model with no textures of its own keeps them in <name>t.mdl beside it
  if (texturesInside(src) === 0) {
    const tfile = file.replace(/\.mdl$/i, "t.mdl");
    if (!fs.existsSync(tfile)) return 0; // no skins at all (a sequence-only model); not a problem
    try {
      src = withTextures(src, fs.readFileSync(tfile));
    } catch (e) {
      problems.push({ kind: "mdl", source: file, name: "", reason: `t.mdl: ${e.message.slice(0, 140)}` });
      return 0;
    }
  }
  const count = texturesInside(src);
  const owner = modelOwner(file);
  let n = 0;
  for (let i = 0; i < count; i++) {
    let texture;
    try {
      texture = textureOf(src, i);
    } catch (e) {
      problems.push({ kind: "mdl", source: file, name: `#${i}`, reason: e.message.slice(0, 160) });
      continue;
    }
    const status = isColormap(texture.name) ? "skipped_colormap" : "ok";
    note(texture, { kind: "model", source: file, name: texture.name, owner, status });
    n++;
  }
  return n;
}

function scanSpr(file) {
  let spr;
  try {
    spr = readSpr(fs.readFileSync(file));
  } catch (e) {
    problems.push({ kind: "spr", source: file, name: "", reason: e.message.slice(0, 160) });
    return 0;
  }
  // cl_sprite.c:252-253 -- sprite_name is the model name with the EXTENSION STRIPPED, so
  // sprites/foo.spr is looked up under materials/sprites/foo/. The frame file is
  // <group_suffix><N><N>.tga, and group_suffix is "frame", "group" or "angle" (lines 307-315).
  const owner = path.relative(TS, file).replace(/\\/g, "/").replace(/\.spr$/i, "");
  const grouped = new Set();
  for (const g of spr.groups ?? []) for (let i = 0; i < g.count; i++) grouped.add(g.first + i);
  const frames = LIMIT ? spr.frames.slice(0, LIMIT) : spr.frames;
  frames.forEach((frame, i) => {
    const suffix = grouped.has(i) ? "group" : "frame";
    // the engine formats the number as %i%i of num/10 and num%10, so 100+ frames would collide
    const nn = `${Math.floor(i / 10)}${i % 10}`;
    note({ width: frame.width, height: frame.height, pixels: frame.pixels, palette: spr.palette },
      { kind: "sprite", source: file, name: suffix + nn, owner, status: i >= 100 ? "frame_over_99" : "ok" });
  });
  return frames.length;
}

function filesUnder(dir, ext) {
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.toLowerCase().endsWith(ext)) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

function filesIn(dir, ext) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(ext))
      .map((f) => path.join(dir, f))
      .sort();
  } catch {
    return [];
  }
}

function main() {
  const wads = KINDS.has("world")
    ? [...filesIn(TS, ".wad"), ...filesIn(path.join(TS, "maps"), ".wad"), ...filesIn(VALVE, ".wad")]
    : [];
  const bsps = KINDS.has("world") ? filesIn(path.join(TS, "maps"), ".bsp") : [];
  // t.mdl files are texture stores for their own .mdl, never scanned on their own
  const mdls = KINDS.has("models")
    ? filesUnder(path.join(TS, "models"), ".mdl").filter((f) => !/t\.mdl$/i.test(f))
    : [];
  const sprs = KINDS.has("sprites") ? filesUnder(path.join(TS, "sprites"), ".spr") : [];

  console.log(`scanning ${wads.length} wad(s), ${bsps.length} bsp(s), ${mdls.length} mdl(s), ${sprs.length} spr(s)`);
  let fromWads = 0;
  for (const f of wads) fromWads += scanWad(f);
  let fromBsps = 0;
  for (const f of bsps) fromBsps += scanBsp(f);
  let fromMdls = 0;
  for (const f of mdls) fromMdls += scanMdl(f);
  let fromSprs = 0;
  for (const f of sprs) fromSprs += scanSpr(f);

  // Name collisions: the same name with different pixels cannot share materials/common. Only
  // world textures share that one folder -- model and sprite textures are namespaced by their
  // own model/sprite, so identical names there are not a collision.
  const byName = new Map();
  for (const o of occurrences) {
    if (o.kind !== "world") continue;
    const key = o.safe.toLowerCase();
    if (!byName.has(key)) byName.set(key, new Set());
    byName.get(key).add(o.sha);
  }
  const collisions = [...byName.entries()].filter(([, shas]) => shas.size > 1);

  if (WRITE_PNG) {
    const outDir = path.join(WORK, "source");
    fs.mkdirSync(outDir, { recursive: true });
    for (const img of images.values()) {
      const out = path.join(outDir, `${img.sha}.png`);
      // "wx" creates the file only if it is absent, in ONE operation the OS does not interrupt.
      // Asking existsSync first and writing afterwards leaves a gap: a second run of this scan,
      // or an upscale reading the folder, can see the file between the two. The name is the hash
      // of the pixels so the content would be the same either way -- but a half-written PNG is
      // not the same as anything, and the upscaler would read it as a damaged source.
      try {
        fs.writeFileSync(out, png(img.width, img.height, img.rgba), { flag: "wx" });
      } catch (e) {
        if (e.code !== "EEXIST") throw e; // already extracted by an earlier run, which is normal
      }
    }
  }

  const manifest = {
    scannedAt: null, // stamped by the caller; Date is avoided here on purpose
    counts: {
      wads: wads.length,
      bsps: bsps.length,
      mdls: mdls.length,
      sprs: sprs.length,
      occurrences: occurrences.length,
      fromWads,
      fromBsps,
      fromMdls,
      fromSprs,
      distinctImages: images.size,
      distinctNames: byName.size,
      nameCollisions: collisions.length,
      masked: occurrences.filter((o) => o.masked).length,
      skippedColormap: occurrences.filter((o) => o.status === "skipped_colormap").length,
      problems: problems.length,
    },
    collisions: collisions.map(([name, shas]) => ({ name, variants: shas.size })),
    problems,
    occurrences,
  };
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(path.join(WORK, "extract.json"), JSON.stringify(manifest, null, 1));

  const bytes = [...images.values()].reduce((a, i) => a + i.width * i.height * 4, 0);
  const c = manifest.counts;
  console.log("");
  console.log(`  occurrences       ${c.occurrences}`);
  console.log(`    world           ${c.fromWads} from wads + ${c.fromBsps} embedded in bsps`);
  console.log(`    models          ${c.fromMdls} skins across ${c.mdls} mdl`);
  console.log(`    sprites         ${c.fromSprs} frames across ${c.sprs} spr`);
  console.log(`  distinct images   ${c.distinctImages}   <- the real upscale batch`);
  console.log(`  world names       ${c.distinctNames}`);
  console.log(`  name collisions   ${c.nameCollisions}  (same world name, different pixels -- need a per-map folder)`);
  console.log(`  masked / alpha    ${c.masked}`);
  console.log(`  colormap skins    ${c.skippedColormap}  (DM_Base*/remap* -- engine refuses a replacement)`);
  console.log(`  problems          ${c.problems}`);
  console.log(`  source RGBA       ${(bytes / 1048576).toFixed(1)} MiB at 1x`);
  console.log(`  at 4x it would be ${((bytes * 16) / 1073741824).toFixed(2)} GiB of raw RGBA`);
  console.log("");
  console.log(`  wrote ${path.join(WORK, "extract.json")}${WRITE_PNG ? ` and ${images.size} png(s)` : " (no png)"}`);
  return problems.length && !occurrences.length ? 1 : 0;
}

process.exit(main());
