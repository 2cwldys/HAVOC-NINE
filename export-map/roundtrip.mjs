// THE GATE. Nothing else in this folder is safe until this passes.
//
//     node roundtrip.mjs
//
// The whole approach here is to read the hand-built map, add to it, and write it out again. That
// is only sound if reading and writing leaves what is already there untouched -- so this proves
// it before anything is grown, rather than discovering it after a day of building.
//
// SMAK promises the round trip for a file IT wrote ("what writeMap wrote comes back from
// writeMap(readMap(text)) letter for letter"). This file was written by J.A.C.K., which is a
// different claim: the same brushes and keys, but not necessarily the same bytes -- a different
// number of decimals, a different order of keys, its own comments. So this compares what the map
// MEANS, not how it is spelt:
//
//   brush count, and every brush's planes and textures
//   entity count, and every entity's classname and keys
//   worldspawn's keys
//
// A difference in any of those is a real loss and this says so and stops.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { M, OUT, BASE_MAP, readBase, MAP_NAME } from "./lib.mjs";

const fail = [];
const note = (ok, what) => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) fail.push(what);
};

console.log(`\n  reading ${BASE_MAP}\n`);
const first = readBase();

// ---- what it holds ----------------------------------------------------------------------
const brushes = first.brushes.length;
const entities = first.entities.length;
console.log(`  ${brushes} world brush(es), ${entities} entit(y/ies), ${Object.keys(first.worldspawn).length} worldspawn key(s)`);
const classes = {};
for (const e of first.entities) classes[e.classname] = (classes[e.classname] ?? 0) + 1;
for (const [c, n] of Object.entries(classes)) console.log(`     ${n} x ${c}`);

const textures = new Set();
const faceCount = (list) => list.reduce((n, b) => n + b.faces.length, 0);
for (const b of first.brushes) for (const f of b.faces) textures.add(f.texture);
for (const e of first.entities) for (const b of e.brushes ?? []) for (const f of b.faces) textures.add(f.texture);
console.log(`  ${faceCount(first.brushes)} world face(s), ${textures.size} distinct texture(s)\n`);

// ---- write it straight back, and read that --------------------------------------------
mkdirSync(OUT, { recursive: true });
const text = M.writeMap(first);
const copy = join(OUT, `${MAP_NAME}.roundtrip.map`);
writeFileSync(copy, text);
const second = M.readMap(text);

// ---- compare what it means -------------------------------------------------------------
note(second.brushes.length === brushes, `world brushes kept (${second.brushes.length} of ${brushes})`);
note(second.entities.length === entities, `entities kept (${second.entities.length} of ${entities})`);
note(faceCount(second.brushes) === faceCount(first.brushes), `world faces kept (${faceCount(second.brushes)} of ${faceCount(first.brushes)})`);

/** Every plane and texture of a brush list, as comparable text. */
const shape = (list) =>
  list
    .map((b) => b.faces.map((f) => `${f.texture}|${f.points.flat().join(",")}|${f.u.join(",")}|${f.v.join(",")}|${f.rotation}|${f.scale.join(",")}`).join(";"))
    .join("\n");
note(shape(second.brushes) === shape(first.brushes), "every world brush plane, texture and alignment identical");

const keysOf = (o) => Object.entries(o).filter(([k]) => k !== "brushes").sort().map(([k, v]) => `${k}=${v}`).join("|");
note(keysOf(second.worldspawn) === keysOf(first.worldspawn), "worldspawn keys identical");

let entitiesSame = true;
for (let i = 0; i < Math.min(first.entities.length, second.entities.length); i++) {
  if (keysOf(first.entities[i]) !== keysOf(second.entities[i])) {
    entitiesSame = false;
    console.log(`        entity ${i} differs:\n          was ${keysOf(first.entities[i])}\n          now ${keysOf(second.entities[i])}`);
  }
  if (shape(first.entities[i].brushes ?? []) !== shape(second.entities[i].brushes ?? [])) {
    entitiesSame = false;
    console.log(`        entity ${i} (${first.entities[i].classname}) brushes differ`);
  }
}
note(entitiesSame, "every entity's classname, keys and brushes identical");

// A third pass must equal the second exactly: once it is in SMAK's own spelling it is stable,
// which is what makes repeated grow-and-write runs safe.
note(M.writeMap(second) === text, "stable: writing it a second time gives the same text");

console.log(`\n  wrote ${copy}`);
if (fail.length) {
  console.log(`\n  THE GATE IS SHUT: ${fail.length} difference(s). Do not grow this map until they are understood.\n`);
  process.exit(1);
}
console.log("\n  The gate is open: the base map survives a read and a write unchanged.\n");
