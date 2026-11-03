// What the three cities wear, and which wad answers for it.
//
// A compile from .map needs every texture name on a face to be in a wad: a missing one is a black face at
// best, a stopped compile at worst. These maps were built with their pixels inside the .bsp, which is why
// there are *_generated.wad files beside the sources. This says, name by name, who answers.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GAME_DIR, M } from "../lib.mjs";
import { CITIES, SOURCE_DIRS, readCity } from "./probe.mjs";

const MAPS = SOURCE_DIRS.find((d) => existsSync(join(d, CITIES.paradise)));
const TOOL = new Set(["NULL", "CLIP", "SKIP", "HINT", "AAATRIGGER", "ORIGIN", "BEVEL", "SOLID", "SKY", "SKYVIS"]);

const sources = [
  { label: "halflife", path: join(GAME_DIR, "valve", "halflife.wad") },
  { label: "liquids", path: join(GAME_DIR, "valve", "liquids.wad") },
  { label: "xeno", path: join(GAME_DIR, "valve", "xeno.wad") },
  { label: "decals", path: join(GAME_DIR, "valve", "decals.wad") },
  { label: "avp2", path: join(GAME_DIR, "ts", "avp2.wad") },
  { label: "cyberdynamics", path: join(GAME_DIR, "ts", "cyberdynamics.wad") },
  { label: "specialists", path: join(GAME_DIR, "ts", "specialists.wad") },
  { label: "submerged", path: join(GAME_DIR, "ts", "submerged.wad") },
  { label: "techno", path: join(GAME_DIR, "ts", "techno.wad") },
  { label: "io_v1", path: join(GAME_DIR, "ts", "io_v1.wad") },
  { label: "alexandria", path: join(MAPS, "alexandria_msr_b4v3_generated.wad") },
  { label: "xenon", path: join(MAPS, "xenoncity_true_b3v2_generated.wad") },
];

const answers = new Map(); // texture name -> [wad labels]
for (const source of sources) {
  if (!existsSync(source.path)) {
    console.log(`  (no ${source.label}.wad at ${source.path})`);
    continue;
  }
  for (const name of M.wadTextureNames(readFileSync(source.path))) {
    const key = name.toUpperCase();
    if (!answers.has(key)) answers.set(key, []);
    answers.get(key).push(source.label);
  }
}

for (const name of Object.keys(CITIES)) {
  const city = readCity(CITIES[name]);
  const map = city.map;
  const textures = new Set();
  const use = (brushes) => {
    for (const brush of brushes ?? []) for (const face of brush.faces ?? []) textures.add(face.texture);
  };
  use(map.brushes);
  for (const entity of map.entities ?? []) use(entity.brushes);

  const missing = [];
  const borrowed = [];
  const own = [];
  for (const texture of [...textures].sort()) {
    const key = texture.toUpperCase();
    if (TOOL.has(key) || key.startsWith("{")) continue;
    const who = answers.get(key);
    if (!who) missing.push(texture);
    else if (who.some((w) => w === "alexandria" || w === "xenon")) own.push(`${texture}<${who.filter((w) => w === "alexandria" || w === "xenon").join(",")}>`);
    else borrowed.push(texture);
  }
  console.log(`\n=== ${city.file}: ${textures.size} names`);
  console.log(`  from stock wads: ${borrowed.length}`);
  console.log(`  from the generated wads: ${own.length}${own.length ? " -> " + own.slice(0, 12).join(" ") + (own.length > 12 ? " ..." : "") : ""}`);
  console.log(`  MISSING: ${missing.length}${missing.length ? " -> " + missing.slice(0, 30).join(" ") : ""}`);
}

console.log("\n=== skies");
const env = join(GAME_DIR, "valve", "gfx", "env");
const skyDirs = [env, join(GAME_DIR, "ts", "gfx", "env")];
for (const name of Object.keys(CITIES)) {
  const city = readCity(CITIES[name]);
  const sky = city.map.worldspawn?.skyname ?? "(none)";
  const files = skyDirs.flatMap((dir) => ["bk", "dn", "ft", "lf", "rt", "up"].map((side) => join(dir, `${sky}${side}.tga`)));
  console.log(`  ${name.padEnd(12)} skyname '${sky}'  files present: ${files.filter(existsSync).length}/6`);
}
