// Copies dist/gfx.wad into H9XASH\valve. An existing gfx.wad is backed up
// first and the report names the file that was overwritten.
//
// Usage:
//   node tools/install.mjs [dist/gfx.wad] [target valve folder] [backups folder]
//
// Defaults:
//   source:  dist/gfx.wad
//   target:  D:\Downloads\TSM\H9XASH\valve
//   backups: D:\Downloads\TSM\backups

import {
  readFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

const DIST = process.argv[2] ?? "dist/gfx.wad";
const TARGET_DIR = process.argv[3] ?? "D:\\Downloads\\TSM\\H9XASH\\valve";
const BACKUPS = process.argv[4] ?? "D:\\Downloads\\TSM\\backups";
const TARGET = join(TARGET_DIR, "gfx.wad");

const sha = (buf) => createHash("sha256").update(buf).digest("hex").toUpperCase();

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

if (!existsSync(DIST)) {
  console.error(`missing source: ${resolve(DIST)}`);
  process.exit(1);
}

const src = readFileSync(DIST);
const srcSha = sha(src);

mkdirSync(TARGET_DIR, { recursive: true });

const lines = [];
lines.push("H9 purple gfx.wad install");
lines.push(`source : ${resolve(DIST)} (${src.length} bytes, ${srcSha})`);
lines.push(`target : ${resolve(TARGET)}`);

let backup = null;
if (existsSync(TARGET)) {
  const old = readFileSync(TARGET);
  const oldSha = sha(old);

  const base = `valve_gfx_${stamp()}`;
  let dir = join(BACKUPS, base);
  for (let n = 2; existsSync(dir); n++) dir = join(BACKUPS, `${base}-${n}`);
  mkdirSync(dir, { recursive: true });
  backup = join(dir, "gfx.wad");
  copyFileSync(TARGET, backup);

  const backupSha = sha(readFileSync(backup));
  if (backupSha !== oldSha) {
    console.error(`backup verification failed: ${backup}`);
    process.exit(1);
  }

  lines.push(`backup : ${backup} (${old.length} bytes, ${oldSha})`);
  lines.push("action : OVERWROTE existing gfx.wad (backup above)");
} else {
  lines.push("action : created gfx.wad (no existing file)");
}

copyFileSync(DIST, TARGET);

const written = readFileSync(TARGET);
const writtenSha = sha(written);
lines.push(`result : ${written.length} bytes, ${writtenSha}`);

if (written.length !== src.length || writtenSha !== srcSha) {
  lines.push("verify : FAILED - target does not match source");
  console.log(lines.join("\r\n"));
  process.exit(1);
}

lines.push("verify : OK - target matches source byte for byte");
console.log(lines.join("\r\n"));
