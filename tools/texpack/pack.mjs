// texpack/pack.mjs -- lay out what the website serves: the manifest and the blob store.
//
// The client never downloads a folder of named textures. It downloads BLOBS, each named by the
// sha256 of its own bytes, and builds the named files itself from the manifest. That is what
// makes an update small: change fifty textures and fifty blobs move, not ten gigabytes.
//
//   downloads/files/
//     hd-pack.json           the manifest. The source of truth, and the LAST thing to upload.
//     hd/<ab>/<sha256>.tga   the blobs, sharded by the first two characters of the hash
//     H9XASH-HD.sha256       checksums, in the shape SHA256SUMS.txt uses
//
// Sharding matters: 6,182 files in one directory is miserable for a filesystem and for some
// webservers. Two characters gives 256 folders of about 24 files each.
//
// DEPLOY ORDER, and it is not optional: upload the blobs FIRST and swap hd-pack.json LAST. A
// manifest that names blobs which are not there yet gives every client that polls in between a
// run of 404s.
//
//   node tools/texpack/pack.mjs --out D:\temp\texpack\site
//   node tools/texpack/pack.mjs --out ... --link     hard link instead of copying (same volume)
//   node tools/texpack/pack.mjs --dry
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const value = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const WORK = path.resolve(value("--work", path.join("D:", "temp", "texpack")));
const BLOBS = path.resolve(value("--blobs", path.join(WORK, "out")));
const OUT = path.resolve(value("--out", path.join(WORK, "site")));
const DRY = flag("--dry");
const LINK = flag("--link");

// the pack manifest place.mjs wrote, beside the materials tree it laid out
const packPath = value("--manifest", path.join(WORK, "pack", "ts", "materials", "hd-pack.json"));
if (!fs.existsSync(packPath)) {
  console.error(`no manifest at ${packPath}; run place.mjs first`);
  process.exit(1);
}
const pack = JSON.parse(fs.readFileSync(packPath, "utf8"));

const shas = [...new Set(Object.values(pack.files))];
console.log(`${Object.keys(pack.files).length} installed file(s) from ${shas.length} blob(s)`);

let copied = 0, missing = 0, bytes = 0;
const sums = [];
for (const sha of shas) {
  const from = path.join(BLOBS, `${sha}.tga`);
  if (!fs.existsSync(from)) { missing++; continue; }
  const size = fs.statSync(from).size;
  bytes += size;
  sums.push(`${sha}  hd/${sha.slice(0, 2)}/${sha}.tga`);
  if (DRY) continue;
  const to = path.join(OUT, "hd", sha.slice(0, 2), `${sha}.tga`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (fs.existsSync(to)) { copied++; continue; }
  if (LINK) {
    try { fs.linkSync(from, to); } catch { fs.copyFileSync(from, to); }
  } else {
    fs.copyFileSync(from, to);
  }
  copied++;
}

if (!DRY) {
  fs.mkdirSync(OUT, { recursive: true });
  // the manifest the client diffs against; upload this LAST
  fs.writeFileSync(path.join(OUT, "hd-pack.json"), JSON.stringify(pack));
  fs.writeFileSync(path.join(OUT, "H9XASH-HD.sha256"), sums.join("\r\n") + "\r\n");
}

console.log(`  blobs laid out   ${copied}${LINK ? " (hard linked)" : ""}`);
if (missing) console.log(`  MISSING          ${missing} blob(s) the manifest names but out/ does not hold`);
console.log(`  blob bytes       ${(bytes / 1073741824).toFixed(2)} GiB`);
console.log(`  shard folders    ${new Set(shas.map((s) => s.slice(0, 2))).size} of a possible 256`);
console.log(DRY ? "  (dry run: nothing written)" : `  wrote ${OUT}`);
if (!DRY) {
  console.log("");
  console.log("  upload order: hd/** first, then hd-pack.json. Never the other way round.");
}
