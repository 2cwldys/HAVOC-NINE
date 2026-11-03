// The real box of every brush: where the planes meet, not where the decompiler put the three points that
// describe each plane. A decompiled map's face points often sit far outside the solid, so point bounds make
// a small sky brush look a million units wide. `shapeOf` is the kit's own intersection.
//
//   node bounds.mjs            every city: legal-core box, what lies outside, the giant brushes named
import { readFileSync } from "node:fs";
import { M } from "../lib.mjs";
import { CITIES, readCity } from "./probe.mjs";

const LIMIT = 4096;

export function trueBox(brush) {
  const shape = M.shapeOf(brush);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const face of shape.faces)
    for (const point of face.polygon)
      for (let a = 0; a < 3; a++) {
        if (point[a] < min[a]) min[a] = point[a];
        if (point[a] > max[a]) max[a] = point[a];
      }
  return Number.isFinite(min[0]) ? { min, max, faults: shape.faults ?? [] } : null;
}

const inside = (box) => box && box.min.every((v) => v >= -LIMIT) && box.max.every((v) => v <= LIMIT);
const overlapLegal = (box) => box && box.min.every((v) => v <= LIMIT) && box.max.every((v) => v >= -LIMIT);

const r = (v) => Math.round(v);

for (const name of Object.keys(CITIES)) {
  const city = readCity(CITIES[name]);
  const map = city.map;
  const owned = new Map();
  for (const entity of map.entities ?? [])
    for (const brush of entity.brushes ?? []) owned.set(brush, entity);

  const rows = [];
  for (const brush of map.brushes ?? []) rows.push({ brush, entity: null, box: trueBox(brush) });
  for (const [brush, entity] of owned) rows.push({ brush, entity, box: trueBox(brush) });

  const good = rows.filter((r) => inside(r.box));
  const part = rows.filter((r) => r.box && !inside(r.box) && overlapLegal(r.box));
  const far = rows.filter((r) => r.box && !overlapLegal(r.box));

  const boxOf = (list) => {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const { box } of list)
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], box.min[a]);
        max[a] = Math.max(max[a], box.max[a]);
      }
    return Number.isFinite(min[0]) ? { min, max } : null;
  };
  const core = boxOf(good);
  const corePlus = boxOf([...good, ...part]);

  console.log(`\n=== ${city.file}`);
  console.log(`  brushes ${rows.length}: wholly legal ${good.length}, crossing the edge ${part.length}, entirely outside ${far.length}`);
  if (core) console.log(`  legal brushes box   min ${core.min.map(r).join(" ")}   max ${core.max.map(r).join(" ")}   size ${core.max.map((v, a) => r(v - core.min[a])).join(" x ")}`);
  if (corePlus) console.log(`  plus edge-crossers  min ${corePlus.min.map(r).join(" ")}   max ${corePlus.max.map(r).join(" ")}   size ${corePlus.max.map((v, a) => r(v - corePlus.min[a])).join(" x ")}`);

  const groups = new Map();
  for (const row of far) {
    const key = `${row.entity?.classname ?? "world"} | ${row.brush.faces[0]?.texture}`;
    const g = groups.get(key) ?? { key, count: 0, box: null, list: [] };
    g.count++;
    if (g.list.length < 2) g.list.push(row.box);
    groups.set(key, g);
  }
  console.log(`  outside, by class|texture:`);
  for (const g of groups.values())
    console.log(`    ${String(g.count).padStart(5)}  ${g.key}   e.g. ${g.list.map((b) => `${b.min.map(r).join(",")}..${b.max.map(r).join(",")}`).join("  ")}`);

  const crossing = new Map();
  for (const row of part) {
    const key = `${row.entity?.classname ?? "world"} | ${row.brush.faces[0]?.texture}`;
    crossing.set(key, (crossing.get(key) ?? 0) + 1);
  }
  if (crossing.size) {
    console.log(`  crossing the edge, by class|texture:`);
    for (const [key, count] of crossing) console.log(`    ${String(count).padStart(5)}  ${key}`);
  }
}
