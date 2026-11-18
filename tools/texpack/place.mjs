// texpack/place.mjs -- work out where every upscaled texture has to live, and put it there.
//
// The engine finds a replacement by NAME, in a folder that depends on what kind of thing wears it:
//
//   world, shared     materials/common/<name>.tga            mod_bmodel.c:2645 subdirs[1]
//   world, per map    materials/maps/<map>.bsp/<name>.tga    mod_bmodel.c:2645 subdirs[0] = mod->name
//   studio model      materials/models/<model>/<tex>.tga     gl_studio.c:3441
//   sprite            materials/sprites/<spr>/frame00.tga    cl_sprite.c:173 (name has no .spr)
//
// A world name goes in common/ when it means one picture everywhere. When the same name holds
// DIFFERENT pictures in different maps -- 74 of them do -- common/ cannot serve both, so each map
// that disagrees gets its own copy under its own folder.
//
//   node tools/texpack/place.mjs --dry          work it out and report, write nothing
//   node tools/texpack/place.mjs                place the files
//   node tools/texpack/place.mjs --link         hard link instead of copying (same volume only)
//
// Reads D:\temp\texpack\extract.json and the upscaled TGAs; writes under --dest and the index.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const value = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const WORK = path.resolve(value("--work", path.join("D:", "temp", "texpack")));
const UP = path.resolve(value("--up", path.join(WORK, "out")));
const DEST = path.resolve(value("--dest", path.join(WORK, "pack", "ts", "materials")));
const DRY = flag("--dry");
const LINK = flag("--link");

const manifest = JSON.parse(fs.readFileSync(path.join(WORK, "extract.json"), "utf8"));

// which world names mean one picture everywhere, and which disagree between maps
const worldShas = new Map();
for (const o of manifest.occurrences) {
  if (o.kind !== "world") continue;
  const k = o.safe.toLowerCase();
  if (!worldShas.has(k)) worldShas.set(k, new Set());
  worldShas.get(k).add(o.sha);
}

const bspName = (source) => path.basename(source); // "h9_tsrp_hive.bsp"

function destinationsFor(o) {
  if (o.kind === "model") return [path.posix.join(o.owner, `${o.name}.tga`)];
  if (o.kind === "sprite") return [path.posix.join(o.owner, `${o.name}.tga`)];
  // Decals are their own lookup: cl_tent.c:2983 builds "materials/decals/%s.tga" and never looks
  // in common/. decals.wad holds them, so anything out of that file goes there instead. The '{'
  // stays -- the engine's example path is literally materials/decals/{shot2.tga.
  if (/decals\.wad$/i.test(o.source)) return [path.posix.join("decals", `${o.safe}.tga`)];
  // world
  const shared = worldShas.get(o.safe.toLowerCase())?.size === 1;
  if (shared) return [path.posix.join("common", `${o.safe}.tga`)];
  // a contested name: it can only be right inside the map it came from
  if (/\.bsp$/i.test(o.source)) return [path.posix.join("maps", bspName(o.source), `${o.safe}.tga`)];
  // it came from a wad, so there is no one map to pin it to; common/ is the best we can do and the
  // index records that it is contested, so a MISS in the engine log points straight at it
  return [path.posix.join("common", `${o.safe}.tga`)];
}

const rows = [];
const wanted = new Map(); // destination -> sha
for (const o of manifest.occurrences) {
  for (const rel of destinationsFor(o)) {
    const contested = o.kind === "world" && worldShas.get(o.safe.toLowerCase())?.size > 1;
    const prev = wanted.get(rel);
    if (prev && prev !== o.sha) {
      rows.push({ ...o, dest: rel, status: "collision_unresolved" });
      continue;
    }
    wanted.set(rel, o.sha);
    rows.push({ ...o, dest: rel, status: o.status !== "ok" ? o.status : contested ? "contested" : "ok" });
  }
}

// ---- place ----------------------------------------------------------------
let placed = 0, missing = 0, bytes = 0;
const missingShas = new Set();
for (const [rel, sha] of wanted) {
  const src = path.join(UP, `${sha}.tga`);
  if (!fs.existsSync(src)) {
    missing++;
    missingShas.add(sha);
    continue;
  }
  bytes += fs.statSync(src).size;
  if (DRY) continue;
  const out = path.join(DEST, rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.rmSync(out, { force: true }); // force: absent is not an error, so there is no check to race
  if (LINK) {
    try {
      fs.linkSync(src, out);
    } catch {
      fs.copyFileSync(src, out);
    }
  } else {
    fs.copyFileSync(src, out);
  }
  placed++;
}

// ---- the index ------------------------------------------------------------
const csv = ["name,kind,owner,source,width,height,masked,status,sha256,destination"];
for (const r of rows.sort((a, b) => a.dest.localeCompare(b.dest))) {
  const cell = (s) => (/[",]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
  csv.push([r.name, r.kind, r.owner, r.source, r.width, r.height, r.masked ? 1 : 0, r.status, r.sha, r.dest].map(cell).join(","));
}
const indexPath = path.join(REPO, "docs", "TEXTURE_UPSCALE_INDEX.csv");
if (!DRY) fs.writeFileSync(indexPath, csv.join("\r\n") + "\r\n");

// ---- the pack manifest, which ships INSIDE the zip -------------------------
// This is the client's half of the delta. It maps every file the pack installs to the blob that
// fills it. Because a blob is named by the sha256 of its bytes, the server can keep one copy of
// each distinct texture and the client can build the duplicate paths itself: 9,765 files out of
// 6,182 blobs, so an install pulls about half what a path-by-path copy would.
//
// An update is then the same diff we use here: fetch the blobs whose sha the client does not
// already hold, write the paths that changed, drop the paths that went away.
const blobs = new Map();
for (const sha of wanted.values()) {
  if (blobs.has(sha)) continue;
  const f = path.join(UP, `${sha}.tga`);
  if (fs.existsSync(f)) blobs.set(sha, fs.statSync(f).size);
}
const pack = {
  format: 1,
  kind: "h9-hd-textures",
  root: "ts/materials",
  files: Object.fromEntries([...wanted].sort(([a], [b]) => a.localeCompare(b))),
  blobs: Object.fromEntries([...blobs].sort(([a], [b]) => a.localeCompare(b))),
  totals: {
    files: wanted.size,
    blobs: blobs.size,
    blobBytes: [...blobs.values()].reduce((a, b) => a + b, 0),
  },
};
if (!DRY) {
  fs.mkdirSync(DEST, { recursive: true });
  fs.writeFileSync(path.join(DEST, "hd-pack.json"), JSON.stringify(pack, null, 1));
}

const byKind = {};
for (const r of rows) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
const contested = rows.filter((r) => r.status === "contested").length;

console.log(`index rows        ${rows.length}   (${Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join(", ")})`);
console.log(`destination files ${wanted.size}   <- what the pack actually holds`);
console.log(`distinct images   ${new Set([...wanted.values()]).size}`);
console.log(`duplication       ${(wanted.size / new Set([...wanted.values()]).size).toFixed(2)}x`);
console.log(`contested names   ${contested}  (same world name, different pixels)`);
if (missing) console.log(`not upscaled yet  ${missing} destination(s), ${missingShas.size} image(s)`);
if (bytes) console.log(`pack size         ${(bytes / 1073741824).toFixed(2)} GiB  as separate files`);
console.log(`blobs to ship     ${pack.totals.blobs}  ${(pack.totals.blobBytes / 1073741824).toFixed(2)} GiB  <- what a client downloads`);
if (wanted.size) console.log(`saved by hashing  ${(100 - (pack.totals.blobs / wanted.size) * 100).toFixed(0)}% fewer downloads than file-by-file`);
if (!DRY) {
  console.log(`placed            ${placed} file(s) under ${DEST}${LINK ? " (hard linked)" : ""}`);
  console.log(`index             ${indexPath}`);
} else {
  console.log("(dry run: nothing written)");
}
