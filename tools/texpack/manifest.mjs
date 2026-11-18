// texpack/manifest.mjs -- the record of what has been upscaled, so the next run only does what
// changed.
//
// Every image is keyed by the sha256 of its PIXELS, not by its name or its file. Two maps that
// share a wall texture are one entry; a map recompiled with the same art produces the same key and
// is not redone. That is the dedupe.
//
// The delta part is the RECIPE. An output is only reusable if it was made by the same model, at
// the same scale, with the same settings. Change the model and every entry is stale, correctly,
// instead of silently keeping four thousand old textures.
//
//   node tools/texpack/manifest.mjs            report: fresh / stale / missing / orphaned
//   node tools/texpack/manifest.mjs --write    write the manifest from what is on disk now
//   node tools/texpack/manifest.mjs --prune    delete orphaned outputs (asks nothing, so look first)
//
// manifest.json lives with the work, because it describes files on this disk.
// docs/TEXTURE_UPSCALE_INDEX.csv is the committed half: one row per place a texture is used.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const value = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const WORK = path.resolve(value("--work", path.join("D:", "temp", "texpack")));
const SRC = path.join(WORK, "source");
const OUT = path.join(WORK, "out");
const MODEL = path.resolve(value("--model", path.join(WORK, "model", "4xLSDIRplus.pth")));
const MANIFEST = path.join(WORK, "manifest.json");

const sha256File = (p) => {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(p));
  return h.digest("hex");
};

// The recipe. Anything here that changes makes every existing output stale.
function recipe() {
  if (!fs.existsSync(MODEL)) throw new Error(`no model at ${MODEL}`);
  const modelSha = sha256File(MODEL);
  return {
    model: path.basename(MODEL),
    modelSha256: modelSha,
    scale: 4,
    format: "tga",
    compression: "rle",
    bits: 32,
    alpha: "bleed4+bicubic+threshold128",
    // one short string that stands for all of it; the entries carry it so a mismatch is visible
    id: crypto.createHash("sha256")
      .update([modelSha, 4, "tga", "rle", 32, "bleed4+bicubic+threshold128"].join("|"))
      .digest("hex")
      .slice(0, 16),
  };
}

const r = recipe();
const sources = new Map(); // sha -> bytes
for (const f of fs.existsSync(SRC) ? fs.readdirSync(SRC) : []) {
  if (f.endsWith(".png")) sources.set(f.slice(0, -4), fs.statSync(path.join(SRC, f)).size);
}
const outputs = new Map();
for (const f of fs.existsSync(OUT) ? fs.readdirSync(OUT) : []) {
  if (f.endsWith(".tga")) outputs.set(f.slice(0, -4), fs.statSync(path.join(OUT, f)).size);
}

const old = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, "utf8")) : { recipe: null, images: {} };
const oldImages = old.images ?? {};

// names, so a human can read the manifest; from extract.json when it is there
const nameOf = new Map();
const extractPath = path.join(WORK, "extract.json");
if (fs.existsSync(extractPath)) {
  const m = JSON.parse(fs.readFileSync(extractPath, "utf8"));
  for (const o of m.occurrences) if (!nameOf.has(o.sha)) nameOf.set(o.sha, o);
}

const fresh = [], stale = [], todo = [], orphan = [];
for (const [sha, srcBytes] of sources) {
  const have = outputs.has(sha);
  const entry = oldImages[sha];
  if (!have) {
    todo.push(sha);
  } else if (entry && entry.recipe === r.id) {
    fresh.push(sha);
  } else {
    // an output exists but the manifest cannot vouch for how it was made
    stale.push(sha);
  }
  void srcBytes;
}
for (const sha of outputs.keys()) if (!sources.has(sha)) orphan.push(sha);

if (flag("--write")) {
  const images = {};
  for (const sha of sources.keys()) {
    if (!outputs.has(sha)) continue;
    const o = nameOf.get(sha);
    const prev = oldImages[sha];
    images[sha] = {
      name: o?.name ?? "",
      kind: o?.kind ?? "",
      owner: o?.owner ?? "",
      src: { bytes: sources.get(sha), w: o?.width ?? 0, h: o?.height ?? 0 },
      out: { bytes: outputs.get(sha), w: (o?.width ?? 0) * r.scale, h: (o?.height ?? 0) * r.scale },
      // a run that produced it under THIS recipe keeps its stamp; anything else is re-stamped now
      recipe: prev && prev.recipe === r.id ? prev.recipe : r.id,
    };
  }
  fs.writeFileSync(MANIFEST, JSON.stringify({ recipe: r, images }, null, 1));
}

if (flag("--prune")) {
  for (const sha of orphan) fs.rmSync(path.join(OUT, `${sha}.tga`), { force: true });
}

const sum = (list, map) => list.reduce((a, s) => a + (map.get(s) ?? 0), 0);
console.log(`recipe      ${r.id}   ${r.model} x${r.scale} ${r.bits}-bit ${r.compression}`);
console.log(`  model sha ${r.modelSha256.slice(0, 16)}...`);
console.log("");
console.log(`sources     ${sources.size}`);
console.log(`outputs     ${outputs.size}   ${(sum([...outputs.keys()], outputs) / 1073741824).toFixed(2)} GiB`);
console.log(`  fresh     ${fresh.length}   made by this recipe, reusable`);
console.log(`  stale     ${stale.length}   output exists but the manifest cannot vouch for it`);
console.log(`  to do     ${todo.length}   no output yet`);
console.log(`  orphaned  ${orphan.length}   output with no source any more${flag("--prune") ? " (deleted)" : ""}`);
if (old.recipe && old.recipe.id !== r.id) {
  console.log("");
  console.log(`the recipe CHANGED: was ${old.recipe.id}, now ${r.id}`);
  console.log("  every output made under the old one is stale and should be redone");
}
if (flag("--write")) console.log(`\nwrote ${MANIFEST}`);
