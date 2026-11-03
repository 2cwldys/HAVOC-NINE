// What the three cities are, before anything is joined: their size, their entities, what they aim at.
//
// The merge lives or dies on one engine fact: a GoldSrc position is a 16-bit number at 1/8 unit, so every
// corner of the finished map must sit within 4096 of the origin on each axis. This prints each city's box
// so the layout can be chosen from numbers rather than hope.
//
//   node probe.mjs                 all three, a summary each
//   node probe.mjs <name> [more]   only those, and every entity class with a count
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { M, TS_MAPS } from "../lib.mjs";

export const CITIES = {
  paradise: "paradisecity_revival.map",
  alexandria: "alexandria_msr_b4v3.map",
  xenon: "xenoncity_true_b3v2.map",
};

/*
 * WHERE THE SOURCES ARE. The .map files are the H9XASH copy of the mod in this workspace, not the one in
 * the Steam folder: the Steam install has the .bsp the server runs, the source lives with the project.
 * TS_MAPS stays last so a machine with the sources installed next to the game still works.
 */
export const SOURCE_DIRS = [
  join("D:/Downloads/TSM/H9XASH/ts/maps"),
  join("D:/GIT Storage/ts_h9_team_elimination/H9XASH/ts/maps"),
  TS_MAPS,
];

const AXES = ["x", "y", "z"];

/** The box of some brushes, read off their face points. */
export function brushBox(brushes) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const brush of brushes ?? [])
    for (const face of brush.faces ?? [])
      for (const point of face.points ?? [])
        for (let a = 0; a < 3; a++) {
          if (point[a] < min[a]) min[a] = point[a];
          if (point[a] > max[a]) max[a] = point[a];
        }
  return Number.isFinite(min[0]) ? { min, max } : null;
}

export const span = (box) => box.max.map((v, a) => v - box.min[a]);

export function readCity(file = CITIES.paradise) {
  const path = SOURCE_DIRS.map((dir) => join(dir, file)).find(existsSync);
  if (!path) throw new Error(`no ${file} in ${SOURCE_DIRS.join(", ")}`);
  return { file, path, map: M.readMap(readFileSync(path, "utf8")) };
}

const originOf = (entity) => {
  const origin = String(entity.origin ?? "").trim().split(/\s+/).filter(Boolean).map(Number);
  return origin.length === 3 && origin.every(Number.isFinite) ? origin : null;
};

export function report(city) {
  const { map } = city;
  const entities = map.entities ?? [];
  const classes = new Map();
  for (const entity of entities) classes.set(entity.classname, (classes.get(entity.classname) ?? 0) + 1);

  const modelEntities = entities.filter((e) => e.brushes?.length);
  const points = entities.map(originOf).filter(Boolean);

  const box = brushBox(map.brushes);
  const modelBox = brushBox(modelEntities.flatMap((e) => e.brushes));

  const named = entities.filter((e) => e.targetname);
  const aimed = entities.filter((e) => e.target);
  const wad = String(map.worldspawn?.wad ?? "").split(";").filter(Boolean);
  const textures = new Set();
  for (const brush of [...(map.brushes ?? []), ...modelEntities.flatMap((e) => e.brushes)])
    for (const face of brush.faces ?? []) textures.add(face.texture);

  const blank = (v, n = 3) => v.map((x) => String(Math.round(x)).padStart(n)).join(" ");
  const line = (label, b) => {
    if (!b) return `${label.padEnd(16)} none`;
    const s = span(b);
    return `${label.padEnd(16)} min ${blank(b.min)}   max ${blank(b.max)}   size ${blank(s, 4)}`;
  };

  console.log(`\n=== ${city.file}`);
  console.log(`  brushes ${map.brushes.length}  entities ${entities.length}  classes ${classes.size}  textures ${textures.size}`);
  console.log(`  ${line("world brushes", box)}`);
  console.log(`  ${line("brush entities", modelBox)}`);
  if (points.length) {
    const pbox = {
      min: AXES.map((_, a) => Math.min(...points.map((p) => p[a]))),
      max: AXES.map((_, a) => Math.max(...points.map((p) => p[a]))),
    };
    console.log(`  ${line("point origins", pbox)}`);
  }
  console.log(`  blank(no origin) ${entities.filter((e) => !originOf(e) && !e.brushes?.length).map((e) => e.classname).join(", ") || "none"}`);
  console.log(`  named ${named.length}  aimed ${aimed.length}  wads ${wad.length}`);
  console.log(`  worldspawn: ${Object.entries(map.worldspawn).filter(([k]) => k !== "wad" && k !== "classname").map(([k, v]) => `${k}='${String(v).slice(0, 60)}'`).join("  ") || "(nothing)"}`);
  console.log(`  wad: ${wad.map((w) => w.split(/[\\/]/).pop()).join("; ")}`);
  return { city, box, modelBox, classes, textures, wad, named, aimed, points };
}

const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const wanted = args.length ? args : Object.keys(CITIES);
const all = [];
const main = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (main) {
for (const want of wanted) {
  const file = CITIES[want] ?? Object.values(CITIES).find((f) => f.includes(want)) ?? want;
  const city = readCity(file);
  const info = report(city);
  all.push({ want, ...info });
  if (args.length) {
    console.log("  classes:");
    for (const [name, count] of [...info.classes].sort((a, b) => b[1] - a[1])) console.log(`    ${String(count).padStart(5)}  ${name}`);
  }
}

if (all.length > 1) {
  console.log("\n=== how they would sit, if moved to the origin one by one:");
  for (const { want, box } of all) {
    if (!box) continue;
    console.log(`  ${want.padEnd(12)} size ${span(box).map((v) => Math.round(v)).join(" x ")}`);
  }
  const total = [0, 1, 2].map((a) => all.reduce((sum, { box }) => sum + (box ? span(box)[a] : 0), 0));
  console.log(`  side by side on X: ${total[0]} wide (limit 8192 across the origin)   on Y: ${total[1]}`);
}
}
