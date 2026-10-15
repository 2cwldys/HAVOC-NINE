// The whole loop, in one run: read the base map, grow the city onto it, check it, draw it,
// compile it, and say what came back.
//
//     node make.mjs              check and draw only -- seconds, no compile
//     node make.mjs compile      and compile it, into out/
//     node make.mjs compile fast a rough draft: hlvis and hlrad at their quickest
//     node make.mjs deploy       compile, then copy the .bsp into the game (asks nothing: be sure)
//
// The order is SMAK's own, from docs/MAPS-MAKING.md, and the point of it is that the cheap checks
// come first: checkPlan and the pictures take a tenth of a second and catch what a compile would
// take minutes to tell you, or would not tell you at all.
import { writeFileSync, readFileSync, copyFileSync, mkdirSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { K, M, OUT, COMPILERS, TS_MAPS, GAME_DIR, MAP_NAME, BASE_MAP, readBase, wadList, spawnPoints } from "./lib.mjs";
import { grow } from "./city.mjs";

const mode = new Set(process.argv.slice(2));
mkdirSync(OUT, { recursive: true });

// ---- read, and grow ----------------------------------------------------------------------
const base = readBase();
const before = { brushes: base.brushes.length, entities: base.entities.length };
const map = grow(base, { spawns: spawnPoints() });
console.log(`\n  base      ${before.brushes} brushes, ${before.entities} entities`);
console.log(`  grown     ${map.brushes.length} brushes, ${map.entities.length} entities` +
  `  (+${map.brushes.length - before.brushes} brushes, +${map.entities.length - before.entities} entities)`);

const file = join(OUT, `${MAP_NAME}.map`);
writeFileSync(file, M.writeMap(map));
console.log(`  wrote     ${file}`);

// ---- check, before anything slow ----------------------------------------------------------
const wads = wadList();
const textures = new Set();
for (const wad of wads) {
  try {
    for (const name of M.wadTextureNames(readFileSync(wad))) textures.add(name);
  } catch (error) {
    console.log(`  WARN      ${wad}: ${error.message}`);
  }
}
const plan = M.checkPlan(map, { textures: [...textures] });
console.log(`\n  checkPlan: ${plan.errors.length} error(s), ${plan.warnings.length} warning(s)`);
for (const f of plan.facts ?? []) console.log(`     ${f}`);
for (const w of plan.warnings) console.log(`     WARN  ${w}`);
for (const e of plan.errors) console.log(`     ERROR ${e}`);
if (plan.errors.length) {
  console.log("\n  Errors are things the compilers refuse, or mend without telling you. Fix them first.\n");
  process.exit(1);
}

// ---- look at it ----------------------------------------------------------------------------
const png = (name, picture) => {
  const to = join(OUT, name);
  writeFileSync(to, K.png(picture.width, picture.height, picture.rgba));
  console.log(`     ${to}`);
};
console.log("\n  pictures:");
png(`${MAP_NAME}_plan.png`, M.planOfSource(map));
const reach = M.reachOf(map);
png(`${MAP_NAME}_reach.png`, M.planOfSource(map, { reach, heights: true }));
console.log(`\n  walk test: ${reach.unreachable?.length ?? 0} entit(y/ies) not reachable on foot` +
  `${reach.inSolid?.length ? `, ${reach.inSolid.length} in solid` : ""}`);
for (const e of (reach.inSolid ?? []).slice(0, 8)) console.log(`     IN SOLID  ${e.classname ?? e.at ?? e}`);

if (!mode.has("compile") && !mode.has("deploy")) {
  console.log("\n  Checked and drawn. `node make.mjs compile` to build the .bsp.\n");
  process.exit(0);
}

// ---- compile -------------------------------------------------------------------------------
console.log(`\n  compiling (${mode.has("fast") ? "draft" : "full"})...`);
const started = Date.now();
const result = M.compileMap(file, {
  compilers: { folder: COMPILERS },
  wads,
  // The base map was built with -nowadtextures, which puts every texture INSIDE the .bsp so the
  // server needs no .wad beside it. This is SMAK's name for the same thing.
  wadinclude: true,
  fast: mode.has("fast"),
  out: join(OUT, `${MAP_NAME}.bsp`),
  keep: true,
});
console.log(`  ${Math.round((Date.now() - started) / 1000)}s`);
for (const l of result.logs) console.log(`     ${l.tool.padEnd(6)} code ${l.code}  ${l.seconds}s`);
for (const w of result.warnings) console.log(`     WARN  ${w}`);
for (const e of result.errors) console.log(`     ERROR ${e}`);
if (result.leak) {
  console.log(`\n  LEAK from ${result.leak.entity?.classname ?? "?"} at ${result.leak.at}` +
    `${result.leak.nearest ? `, nearest entity ${result.leak.nearest.classname}` : ""}`);
}
if (!result.bsp) {
  console.log(`\n  No .bsp: the compile failed and nothing was written.${result.work ? ` Logs kept in ${result.work}` : ""}\n`);
  process.exit(1);
}
console.log(`\n  ${result.bsp}  ${statSync(result.bsp).size} bytes`);

// ---- deploy --------------------------------------------------------------------------------
if (mode.has("deploy")) {
  const live = join(TS_MAPS, `${MAP_NAME}.bsp`);
  if (existsSync(live)) {
    const backup = join(OUT, `${MAP_NAME}.bsp.before-smak`);
    if (!existsSync(backup)) {
      copyFileSync(live, backup);
      console.log(`  kept the old one: ${backup}`);
    }
  }
  copyFileSync(result.bsp, live);
  console.log(`  deployed  ${live}`);

  /*
   * AND THE BUILT .map BESIDE IT, UNDER A DIFFERENT NAME.
   *
   * The .bsp is the compiler's output and cannot be read back or edited, so on its own it leaves no
   * record of what the map actually IS. The .map is every brush and entity as text, it is what the
   * compilers were fed, and it opens in J.A.C.K. like any other, so the map stays workable by hand
   * and not only by this script. Shipping it next to the .bsp keeps the two from drifting apart.
   *
   * THE NAME MATTERS, AND GETTING IT WRONG DESTROYS THE PIPELINE. ts/maps/<name>.map is the BASE
   * map -- the hand-built original this whole thing reads as its starting point, through
   * lib.mjs's BASE_MAP. Writing the generated map to that path overwrites it, and the next build
   * then grows a city on top of a city that already has one, compounding on every run with no
   * error to say so. So the built map goes out as <name>_built.map and the original is never
   * touched. The check below refuses the write outright rather than trusting this comment.
   */
  const liveMap = join(TS_MAPS, `${MAP_NAME}_built.map`);
  if (resolve(liveMap) === resolve(BASE_MAP)) {
    console.log(`  REFUSED to write the built map over the base map at ${BASE_MAP}`);
  } else {
    copyFileSync(file, liveMap);
    console.log(`  deployed  ${liveMap}  (the source it was built from)`);
  }

  /*
   * AND THE SKY, which is not in the .bsp.
   *
   * Textures travel inside a compiled map; a skybox never does. It is six loose .tga files the
   * engine loads from gfx/env by the skyname key, and when they are missing it falls back to the
   * default desert sky without a word -- which is exactly what happened the first time this was
   * tested in game: a sunlit canyon over an undersea city.
   *
   * They have to reach every PLAYER too, not just the server, so they belong in whatever pack the
   * map is handed out in.
   */
  const skyFrom = join(OUT, "gfx", "env");
  const skyTo = join(GAME_DIR, "ts", "gfx", "env");
  if (existsSync(skyFrom)) {
    mkdirSync(skyTo, { recursive: true });
    let n = 0;
    for (const face of readdirSync(skyFrom)) {
      copyFileSync(join(skyFrom, face), join(skyTo, face));
      n++;
    }
    console.log(`  deployed  ${n} skybox file(s) -> ${skyTo}`);
  } else {
    console.log(`  NOTE: no skybox in ${skyFrom} -- run \`node sky.mjs\` or the map falls back to the default sky`);
  }
}
console.log("");
