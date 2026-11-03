// Checks the purple gfx.wad against the original: same WAD structure, same
// lump names/types/offsets/sizes, same char tables, and only palette colours
// changed (plus BACKTILE's grid and LAMBDA32's helmet pixels).
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const original = readFileSync(process.argv[2]);
const purple = readFileSync(process.argv[3]);
const out = process.argv[4] ?? "dist/VALIDATION.txt";

const problems = [];
const lines = [];
const sha = (b) => createHash("sha256").update(b).digest("hex").toUpperCase();

function lumps(b) {
  const n = b.readInt32LE(4);
  const t = b.readInt32LE(8);
  const list = [];
  for (let i = 0; i < n; i++) {
    const at = t + i * 32;
    list.push({
      name: b.toString("latin1", at + 16, at + 32).replace(/\0.*$/, ""),
      type: b[at + 12],
      filepos: b.readInt32LE(at),
      disk: b.readInt32LE(at + 4),
    });
  }
  return list;
}

lines.push("H9 purple gfx.wad validation");
lines.push(`original: ${sha(original)} (${original.length} bytes)`);
lines.push(`purple  : ${sha(purple)} (${purple.length} bytes)`);
lines.push("");

if (original.length !== purple.length) problems.push("file sizes differ");
if (original.toString("latin1", 0, 4) !== "WAD3") problems.push("original is not WAD3");
if (purple.toString("latin1", 0, 4) !== "WAD3") problems.push("purple is not WAD3");
if (original.readInt32LE(4) !== purple.readInt32LE(4)) problems.push("lump counts differ");
if (original.readInt32LE(8) !== purple.readInt32LE(8)) problems.push("directory offsets differ");

const a = lumps(original);
const b = lumps(purple);
if (a.length !== b.length) problems.push("parsed lump counts differ");

let totalDiff = 0;
for (let i = 0; i < Math.min(a.length, b.length); i++) {
  const la = a[i], lb = b[i];
  if (la.name !== lb.name) problems.push(`lump ${i} name ${la.name} != ${lb.name}`);
  if (la.type !== lb.type) problems.push(`lump ${i} type differs`);
  if (la.filepos !== lb.filepos) problems.push(`lump ${i} offset differs`);
  if (la.disk !== lb.disk) problems.push(`lump ${i} size differs`);

  const da = original.subarray(la.filepos, la.filepos + la.disk);
  const db = purple.subarray(lb.filepos, lb.filepos + lb.disk);
  let diff = 0;
  let first = -1;
  let last = -1;
  for (let k = 0; k < Math.min(da.length, db.length); k++) {
    if (da[k] !== db[k]) {
      diff++;
      if (first < 0) first = k;
      last = k;
    }
  }
  totalDiff += diff;

  let pixelRange = null;
  let palAt = -1;
  if (la.type === 0x42) {
    const w = da.readInt32LE(0);
    const h = da.readInt32LE(4);
    pixelRange = [8, 8 + w * h];
    palAt = 8 + w * h;
  } else if (la.type === 0x46) {
    const h = da.readInt32LE(4);
    pixelRange = [16 + 1024, 16 + 1024 + 256 * h];
    palAt = pixelRange[1];
  }

  // only the palette may differ, except BACKTILE's pixels
  let outside = 0;
  for (let k = 0; k < da.length; k++) {
    if (da[k] === db[k]) continue;
    const inPalette = palAt >= 0 && k >= palAt + 2 && k < palAt + 2 + 768;
    const inBacktilePixels = la.name === "BACKTILE" && k >= 8 && k < 8 + 64 * 64;
    const inLambda32Pixels = la.name === "LAMBDA32" && k >= 8 && k < 8 + 32 * 32;
    if (!inPalette && !inBacktilePixels && !inLambda32Pixels) outside++;
  }
  if (outside) problems.push(`${la.name}: ${outside} bytes changed outside palette/pixels`);

  // transparent key must be untouched
  if (palAt >= 0) {
    const oa = palAt + 2 + 255 * 3;
    if (da[oa] !== db[oa] || da[oa + 1] !== db[oa + 1] || da[oa + 2] !== db[oa + 2])
      problems.push(`${la.name}: index 255 palette entry changed`);
    if (da.readUInt16LE(palAt) !== db.readUInt16LE(palAt))
      problems.push(`${la.name}: palette count changed`);
  }

  lines.push(
    `${la.name.padEnd(12)} type=0x${la.type.toString(16)} bytes=${la.disk} changed=${diff}` +
      (diff ? ` (first=${first}, last=${last})` : "")
  );
}

lines.push("");
lines.push(`total changed bytes: ${totalDiff}`);
lines.push("");
if (problems.length) {
  lines.push("FAIL");
  for (const p of problems) lines.push(`  - ${p}`);
} else {
  lines.push("PASS: WAD3 structure, lump table, pixel data, char tables and");
  lines.push("      transparent key are unchanged; only palette colours (plus the");
  lines.push("      BACKTILE grid and LAMBDA32 helmet pixels) differ.");
}

const text = lines.join("\r\n") + "\r\n";
writeFileSync(out, text);
console.log(text);
process.exitCode = problems.length ? 1 : 0;
