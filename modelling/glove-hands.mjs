// Put one pair of hands on every weapon in the game.
//
// THERE IS NO SHARED HAND TEXTURE TO SWAP. GoldSrc keeps a model's pictures inside the
// .mdl itself, and each of the 38 viewmodels carries its own copy of `arms256.bmp`. So a
// single file cannot be replaced in one place: the same atlas has to be written into each
// model. That is what this script does, in one pass, without touching geometry, bones,
// animations or UVs. Every replacement is the same size as the picture it replaces, so
// the file does not grow and the meshes keep their corners.
//
// The donor is the black glove already shipped on v_ruger, v_fnh_akimbo and v_glock22.
// `--donor` and `--texture` point it at another model or another picture in that model.
//
//   node modelling/glove-hands.mjs
//       build all 38 into modelling/out/glove-hands, checking each
//
//   node modelling/glove-hands.mjs --deploy "D:/.../H9XASH/ts/models"
//       build, back the originals up, then copy the new models in
//
//   node modelling/glove-hands.mjs --only v_ak47,v_m16 --preview
//       a few models, and a before/after contact sheet
//
// Never writes to the game until --deploy is given. A deployed model's original is kept
// in modelling/out/glove-hands/backup-<time>/.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { K, OUT } from "./lib.mjs";

const MODELS = process.env.H9_VIEWMODELS ?? "D:/GIT Storage/ts_h9_team_elimination/H9XASH/ts/models";
const HERE = join(OUT, "glove-hands");
const TARGET = "arms256.bmp";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const donorName = option("--donor", "v_ruger.mdl");
const donorTexture = option("--texture", "arms256_glove.bmp");
const only = option("--only", null)
  ?.split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const deployTo = option("--deploy", null);
const preview = args.includes("--preview");

const hash = (buf) => createHash("sha256").update(buf).digest("hex");

/** The same picture at another size, nearest-neighbour: a glove has no fine detail to lose. */
function resize(texture, width, height) {
  // Never hand back the donor object itself: it carries the donor's `name`, and replaceTexture
  // would rename the target texture to it. The model's own name has to stay.
  if (texture.width === width && texture.height === height) {
    return { width, height, pixels: texture.pixels, palette: texture.palette, flags: texture.flags };
  }
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(texture.height - 1, Math.floor((y * texture.height) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(texture.width - 1, Math.floor((x * texture.width) / width));
      pixels[y * width + x] = texture.pixels[sy * texture.width + sx];
    }
  }
  return { width, height, pixels, palette: texture.palette, flags: texture.flags };
}

const donorBuf = readFileSync(join(MODELS, donorName));
const donor = K.textureOf(donorBuf, donorTexture);
console.log(`donor: ${donorName} ${donorTexture} ${donor.width}x${donor.height}`);

if (!existsSync(HERE)) mkdirSync(HERE, { recursive: true });

const files = readdirSync(MODELS)
  .filter((f) => /^v_.*\.mdl$/i.test(f))
  .filter((f) => !only || only.includes(basename(f, ".mdl").toLowerCase()))
  .sort();

if (!files.length) {
  console.error("no viewmodels matched");
  process.exit(1);
}

const built = [];
const failures = [];
for (const file of files) {
  const src = readFileSync(join(MODELS, file));
  const info = K.readMdl(src);
  const at = info.textures.findIndex((t) => t.name.toLowerCase() === TARGET.toLowerCase());
  if (at < 0) {
    failures.push(`${file}: no ${TARGET}`);
    continue;
  }
  const old = info.textures[at];
  const glove = resize(donor, old.width, old.height);
  let out;
  try {
    out = K.replaceTexture(src, TARGET, glove);
    const check = K.check(out, "goldsrc");
    if (check.errors.length) throw new Error(check.errors.join("; "));
    if (check.warnings.length) console.log(`  ${file}: ${check.warnings.length} warning(s)`);
    const got = K.textureOf(out, TARGET);
    if (hash(Buffer.from(got.pixels)) !== hash(Buffer.from(glove.pixels))) {
      throw new Error("the picture read back is not the one written");
    }
    writeFileSync(join(HERE, file), out);
    built.push({ file, before: src.length, after: out.length, srcHash: hash(src), outHash: hash(out) });
    console.log(`  ${file}: ${old.width}x${old.height} replaced, ${out.length} bytes`);
  } catch (e) {
    failures.push(`${file}: ${e.message}`);
  }
}

writeFileSync(
  join(HERE, "report.txt"),
  [
    `donor ${donorName} ${donorTexture}`,
    `models ${MODELS}`,
    ...built.map((b) => `${b.file} ${b.before} -> ${b.after} ${b.srcHash} -> ${b.outHash}`),
    ...failures.map((f) => `FAIL ${f}`),
  ].join("\n") + "\n",
);

if (failures.length) {
  console.error(`\n${failures.length} failed:`);
  for (const f of failures) console.error(`  ${f}`);
}
console.log(`\n${built.length} model(s) written to ${HERE}`);

if (preview && built.length) {
  const picks = built
    .filter((b) => ["v_ak47.mdl", "v_m16.mdl", "v_skorpion.mdl", "v_melee.mdl", "v_ruger.mdl", "v_glock22.mdl"].includes(b.file))
    .slice(0, 6);
  const list = [];
  for (const b of picks) {
    list.push([`${b.file} before`, readFileSync(join(MODELS, b.file))]);
    list.push([`${b.file} glove`, readFileSync(join(HERE, b.file))]);
  }
  if (list.length) {
    const img = K.lineup(list, { yaws: [20], pitch: 6, zoom: 1.25, width: 300, height: 420, cols: 4 });
    const png = join(HERE, "before-after.png");
    writeFileSync(png, K.png(img.width, img.height, img.rgba));
    console.log(`preview: ${png}`);
  }
}

if (deployTo) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = join(HERE, `backup-${stamp}`);
  mkdirSync(backup, { recursive: true });
  for (const b of built) {
    const from = join(HERE, b.file);
    const to = join(deployTo, b.file);
    if (!existsSync(to)) {
      failures.push(`${b.file}: no file at ${to}`);
      continue;
    }
    const current = readFileSync(to);
    if (hash(current) !== b.srcHash) {
      console.log(`  ${b.file}: deployed copy differs from the build input; keeping it as backup`);
    }
    copyFileSync(to, join(backup, b.file));
    copyFileSync(from, to);
    console.log(`  ${b.file}: deployed`);
  }
  console.log(`originals: ${backup}`);
}

if (failures.length) process.exit(1);
