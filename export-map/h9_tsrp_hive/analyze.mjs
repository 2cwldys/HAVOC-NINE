// How a city uses its height, and which brushes are its shell.
//
// Three cities that each fill the ±4096 box horizontally can only be brought together by stacking them, and
// stacking needs their solid volumes to be disjoint in Z. This prints, for each city, how much brush volume
// lies in each 256-unit slice of height, the biggest solids by volume, and the brush that spans the most of
// the footprint (its sky seal, if it has one).
import { M } from "../lib.mjs";
import { CITIES, readCity } from "./probe.mjs";
import { trueBox } from "./bounds.mjs";

const SIZE = 256;
const r = (v) => Math.round(v);

for (const name of Object.keys(CITIES)) {
  const city = readCity(CITIES[name]);
  const map = city.map;
  const entities = new Map();
  for (const entity of map.entities ?? []) for (const brush of entity.brushes ?? []) entities.set(brush, entity);

  const rows = [];
  for (const brush of map.brushes) rows.push({ brush, entity: null, box: trueBox(brush) });
  for (const [brush, entity] of entities) rows.push({ brush, entity, box: trueBox(brush) });
  const live = rows.filter((r) => r.box);

  const zmin = Math.floor(Math.min(...live.map((r) => r.box.min[2])) / SIZE) * SIZE;
  const zmax = Math.ceil(Math.max(...live.map((r) => r.box.max[2])) / SIZE) * SIZE;

  console.log(`\n=== ${city.file}   ${live.length} solids, z ${zmin} .. ${zmax}`);
  for (let z = zmin; z < zmax; z += SIZE) {
    let touching = 0;
    let volume = 0;
    let floorArea = 0;
    for (const { box } of live) {
      const lo = Math.max(z, box.min[2]);
      const hi = Math.min(z + SIZE, box.max[2]);
      if (hi <= lo) continue;
      touching++;
      const area = (box.max[0] - box.min[0]) * (box.max[1] - box.min[1]);
      volume += area * (hi - lo);
      floorArea += area;
    }
    const bar = "#".repeat(Math.min(60, Math.round(Math.sqrt(volume) / 400)));
    console.log(`  z ${String(z).padStart(6)}  solids ${String(touching).padStart(5)}  area ${String(r(floorArea / 1000)).padStart(7)}k  ${bar}`);
  }

  const volumeOf = ({ box }) => (box.max[0] - box.min[0]) * (box.max[1] - box.min[1]) * (box.max[2] - box.min[2]);
  console.log(`  biggest solids:`);
  for (const row of [...live].sort((a, b) => volumeOf(b) - volumeOf(a)).slice(0, 10)) {
    const b = row.box;
    console.log(`    ${String(r(volumeOf(row) / 1e6)).padStart(7)}M  ${(row.entity?.classname ?? "world").padEnd(18)} ${String(row.brush.faces[0]?.texture).padEnd(20)} ${b.min.map(r).join(",")} .. ${b.max.map(r).join(",")}`);
  }

  const area = ({ box }) => (box.max[0] - box.min[0]) * (box.max[1] - box.min[1]);
  console.log(`  widest in plan:`);
  for (const row of [...live].sort((a, b) => area(b) - area(a)).slice(0, 5)) {
    const b = row.box;
    console.log(`    ${String(r(area(row) / 1e6)).padStart(7)}M² ${(row.entity?.classname ?? "world").padEnd(18)} ${String(row.brush.faces[0]?.texture).padEnd(20)} ${b.min.map(r).join(",")} .. ${b.max.map(r).join(",")}`);
  }
}
