// The wads the merged map compiles against, and the one it still needs.
//
// Alexandria's and xenon's pixels were pulled back out of their .bsp already (the *_generated.wad beside the
// sources). Paradise was compiled against eleven wads, one of which (sdhlt.wad) is not on this machine, plus
// a handful of names no installed wad answers -- but its .bsp carries them. This extracts exactly those
// missing names into h9_tsrp_hive/wads/paradise_missing.wad, so no stock picture is shadowed by a copy.
//
//   node wads.mjs           report, and write the paradise wad if it is needed
//   node wads.mjs --check   report only
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GAME_DIR, M } from "../lib.mjs";
import { CITIES, SOURCE_DIRS, readCity } from "./probe.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAPS = SOURCE_DIRS.find((d) => existsSync(join(d, CITIES.paradise)));
const WAD_OUT = join(HERE, "wads");

/** Tool textures the compilers answer for; they need no wad but zhlt.wad must still be listed. */
export const TOOL = new Set(["NULL", "CLIP", "SKIP", "HINT", "AAATRIGGER", "ORIGIN", "BEVEL", "SOLID"]);

export const WADS = {
  halflife: join(GAME_DIR, "valve", "halflife.wad"),
  liquids: join(GAME_DIR, "valve", "liquids.wad"),
  xeno: join(GAME_DIR, "valve", "xeno.wad"),
  decals: join(GAME_DIR, "valve", "decals.wad"),
  avp2: join(GAME_DIR, "ts", "avp2.wad"),
  cyberdynamics: join(GAME_DIR, "ts", "cyberdynamics.wad"),
  specialists: join(GAME_DIR, "ts", "specialists.wad"),
  submerged: join(GAME_DIR, "ts", "submerged.wad"),
  techno: join(GAME_DIR, "ts", "techno.wad"),
  io_v1: join(GAME_DIR, "ts", "io_v1.wad"),
  alexandria: join(MAPS, "alexandria_msr_b4v3_generated.wad"),
  xenon: join(MAPS, "xenoncity_true_b3v2_generated.wad"),
  paradise: join(WAD_OUT, "paradise_missing.wad"),
  zhlt: join(HERE, "..", "compilers", "zhlt.wad"),
};

/** Every texture a map's faces wear, tool names included. */
export function texturesOf(map) {
  const names = new Set();
  const take = (brushes) => {
    for (const brush of brushes ?? []) for (const face of brush.faces ?? []) names.add(face.texture);
  };
  take(map.brushes);
  for (const entity of map.entities ?? []) take(entity.brushes);
  return names;
}

function available() {
  const answers = new Map();
  for (const [label, path] of Object.entries(WADS)) {
    if (!existsSync(path)) continue;
    for (const name of M.wadTextureNames(readFileSync(path))) {
      const key = name.toUpperCase();
      if (!answers.has(key)) answers.set(key, []);
      answers.get(key).push(label);
    }
  }
  return answers;
}

/** The names a city wears that no wad on hand answers, tool textures aside. */
export function missingFor(map, answers = available()) {
  return [...texturesOf(map)]
    .filter((name) => !TOOL.has(name.toUpperCase()))
    .filter((name) => !answers.has(name.toUpperCase()))
    .sort();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const checkOnly = process.argv.includes("--check");
  let answers = available();

  for (const name of Object.keys(CITIES)) {
    const city = readCity(CITIES[name]);
    const missing = missingFor(city.map, answers);
    console.log(`${name.padEnd(12)} ${String(texturesOf(city.map).size).padStart(4)} names, ${missing.length} unanswered${missing.length ? ": " + missing.slice(0, 8).join(" ") + (missing.length > 8 ? " ..." : "") : ""}`);
  }

  const paradise = readCity(CITIES.paradise);
  const missing = missingFor(paradise.map, answers);
  if (!missing.length) {
    console.log("\nparadise is covered; nothing to extract.");
  } else if (checkOnly) {
    console.log(`\n${missing.length} names still unanswered (--check: nothing written).`);
  } else {
    const bspPath = join(MAPS, "paradisecity_revival_final.bsp");
    if (!existsSync(bspPath)) throw new Error(`no ${bspPath}`);
    const bsp = M.readBsp(readFileSync(bspPath));
    const wanted = new Set(missing.map((n) => n.toUpperCase()));
    const take = [];
    const found = new Set();
    for (const texture of bsp.textures ?? []) {
      if (!texture?.name || !texture.embedded || texture.absent) continue;
      if (!wanted.has(texture.name.toUpperCase())) continue;
      const pixels = M.embeddedTexture(bsp, texture.index);
      if (!pixels) continue;
      take.push({ ...pixels, name: texture.name });
      found.add(texture.name.toUpperCase());
    }
    mkdirSync(WAD_OUT, { recursive: true });
    writeFileSync(WADS.paradise, M.writeWad(take));
    const still = missing.filter((n) => !found.has(n.toUpperCase()));
    console.log(`\nwrote ${take.length} of ${missing.length} missing textures to ${WADS.paradise}`);
    if (still.length) console.log(`still unanswered (the .bsp has no pixels for them either): ${still.join(" ")}`);
  }

  answers = available();
  console.log("\nwads the compile will use:");
  for (const [label, path] of Object.entries(WADS)) console.log(`  ${existsSync(path) ? "ok  " : "MISS"}  ${label.padEnd(14)} ${path}`);
  for (const name of Object.keys(CITIES)) {
    const city = readCity(CITIES[name]);
    console.log(`  ${name}: ${missingFor(city.map, answers).length} unanswered`);
  }
}
