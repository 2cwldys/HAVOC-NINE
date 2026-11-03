// What the base map is actually made of, in numbers.
//
//     node probe.mjs
//
// The plan picture shows the shape; this gives the coordinates to build against. Every brush is
// worked out the way the compiler does it (shapeOf: each face is a sheet on its plane, cut by the
// others), so what it reports is the solid the compiler will see, not what was intended.
import { M, readBase, spawnPoints } from "./lib.mjs";

const base = readBase();
const num = (n) => String(Math.round(n)).padStart(6);
const boxOf = (s) => `${num(s.min[0])}${num(s.min[1])}${num(s.min[2])}  ..${num(s.max[0])}${num(s.max[1])}${num(s.max[2])}`;

console.log("\n  WORLD BRUSHES (the rock)\n");
const shapes = base.brushes.map((b) => M.shapeOf(b));
shapes
  .map((s, i) => ({ s, i }))
  .sort((a, b) => a.s.min[0] - b.s.min[0])
  .forEach(({ s, i }) => {
    const faults = s.faults?.length ? `  FAULTS: ${s.faults.join("; ")}` : "";
    const tex = [...new Set(s.faces.map((f) => f.texture))].slice(0, 3).join(",");
    console.log(`   ${String(i).padStart(3)}  ${boxOf(s)}   ${tex}${faults}`);
  });

for (const e of base.entities) {
  if (!e.brushes?.length) continue;
  console.log(`\n  ${e.classname}`);
  for (const b of e.brushes) console.log(`        ${boxOf(M.shapeOf(b))}`);
}

console.log("\n  POINT ENTITIES\n");
for (const e of base.entities) {
  if (e.brushes?.length) continue;
  console.log(`   ${e.classname.padEnd(20)} ${e.origin ?? "(no origin)"}`);
}

// Where the open space is: the box the spawns sit in tells where play actually happens, which is
// what any new district has to connect to.
const spawns = spawnPoints();
if (spawns.length) {
  console.log("\n  SPAWN POINTS (from the plugin's config, NOT in the map)\n");
  for (const team of [1, 2]) {
    const mine = spawns.filter((s) => s.team === team);
    if (!mine.length) continue;
    const lo = [0, 1, 2].map((a) => Math.min(...mine.map((s) => s.at[a])));
    const hi = [0, 1, 2].map((a) => Math.max(...mine.map((s) => s.at[a])));
    console.log(`   team ${team}: ${mine.length} points, ${boxOf({ min: lo, max: hi })}`);
  }
}

const all = shapes.reduce(
  (acc, s) => ({
    min: [0, 1, 2].map((a) => Math.min(acc.min[a], s.min[a])),
    max: [0, 1, 2].map((a) => Math.max(acc.max[a], s.max[a])),
  }),
  { min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9] },
);
console.log(`\n  the world: ${boxOf(all)}`);
console.log(`  room to grow before the 4096 limit: x to ${4096 - all.max[0]} east, y to ${4096 - all.max[1]} north, z to ${4096 - all.max[2]} up\n`);
