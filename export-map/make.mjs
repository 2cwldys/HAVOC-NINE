// The whole loop, in one run: read the base map, grow the city onto it, check it, draw it,
// compile it, and say what came back.
//
//     node make.mjs              check and draw only -- seconds, no compile
//     node make.mjs compile      and compile it, into out/
//     node make.mjs compile fast a rough draft: hlvis and hlrad at their quickest
//     node make.mjs deploy       compile, then copy the .bsp into the game (asks nothing: be sure)
//     node make.mjs compile siege   the siege copy instead, h9_siege_neuropolis: the same map with its three
//                                   objectives (additions.mjs); every other word works with it the same way
//
// The order is SMAK's own, from docs/MAPS-MAKING.md, and the point of it is that the cheap checks
// come first: checkPlan and the pictures take a tenth of a second and catch what a compile would
// take minutes to tell you, or would not tell you at all.
import { writeFileSync, readFileSync, copyFileSync, mkdirSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { K, M, OUT, COMPILERS, TS_MAPS, GAME_DIR, MAP_NAME, BASE_MAP, readBase, wadList, spawnPoints } from "./lib.mjs";
import { addOns } from "./additions.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

/*
 * DEPLOYING A VERSION ALREADY BUILT: `node make.mjs deploy 02`.
 *
 * Building a version keeps it; it does not install it. Without this the only way to play one was
 * to copy the files by hand, which is exactly the sort of step that gets skipped and then looks
 * like the build did nothing.
 *
 * Handled before anything else because there is no map to make: the .bsp already exists.
 */
/*
 * `window` POPS THE BUILD OUT INTO A CONSOLE OF ITS OWN and leaves this one free.
 *
 * A full compile is four minutes of hlvis and hlrad with nothing to show for most of it, and run
 * from somewhere the output cannot be seen it is impossible to tell apart from a build that has
 * hung. This hands the same command to build-map.bat in a new window, which prints as it goes and
 * stays open at the end.
 */
if (process.argv.includes("window")) {
  const rest = process.argv.slice(2).filter((a) => a !== "window");
  /*
   * `start` TAKES ITS FIRST QUOTED ARGUMENT AS THE WINDOW TITLE, which is why the empty "" is
   * there and is not tidy-uppable. Given `start "map build" foo.bat`, cmd reads "map build" as the
   * title and then looks for a program called foo.bat with no quoting of its own; given
   * `start "map" build.bat` it reads "map" as the title and tries to run `build`, which is the
   * "Windows cannot find build" this produced the first time.
   *
   * Run through the shell as one string, because cmd's own parser is the only thing that gets
   * start's argument rules right.
   */
  const cmd = 'start "" "' + join(HERE, "build-map.bat") + '" ' + rest.join(" ");
  spawnSync(cmd, { shell: true, cwd: HERE });
  console.log("");
  console.log("  opened a window for: node make.mjs " + rest.join(" "));
  console.log("  it prints as it goes and stays open at the end.");
  console.log("");
  process.exit(0);
}


const wanted = process.argv.slice(2).find((a) => /^[0-9]{1,3}$/.test(a));
if (wanted && process.argv.includes("deploy")) {
  const n = wanted.padStart(2, "0");
  const dir = join(HERE, "versions", n);
  const from = join(dir, `${MAP_NAME}.bsp`);
  if (!existsSync(from)) {
    console.log("");
    console.log("  there is no version " + n + " at " + dir);
    const have = existsSync(join(HERE, "versions")) ? readdirSync(join(HERE, "versions")).join(", ") : "(none)";
    console.log("  versions built so far: " + have);
    console.log("");
    process.exit(1);
  }
  copyFileSync(from, join(TS_MAPS, `${MAP_NAME}.bsp`));
  const src = join(dir, `${MAP_NAME}.map`);
  if (existsSync(src)) copyFileSync(src, join(TS_MAPS, `${MAP_NAME}_built.map`));
  console.log("");
  console.log("  version " + n + " -> " + join(TS_MAPS, MAP_NAME + ".bsp"));
  if (existsSync(join(dir, "NOTES.txt"))) {
    for (const line of readFileSync(join(dir, "NOTES.txt"), "utf8").split(String.fromCharCode(10))) {
      if (line.trim()) console.log("     " + line);
    }
  }
  console.log("");
  process.exit(0);
}


const mode = new Set(process.argv.slice(2));
const argv = process.argv.slice(2);
// The siege copy is h9_siege_neuropolis; the map itself, h9_te_neuropolis, is team elimination and has no objectives.
const NAME = mode.has("siege") ? MAP_NAME.replace(/^h9_te_/, "h9_siege_") : MAP_NAME;
mkdirSync(OUT, { recursive: true });

// ---- read, and add --------------------------------------------------------------------------
const base = readBase();
const before = { brushes: base.brushes.length, entities: base.entities.length };
console.log(`
  base      ${before.brushes} brushes, ${before.entities} entities`);

/*
 * ADD, DO NOT GROW, AND REFUSE TO GROW ONTO A FINISHED MAP.
 *
 * city.mjs builds the whole city from a bare shell. The map is long past that -- it is a developed
 * city built by hand in an editor -- so growing onto it appends a SECOND city and cuts up the
 * first one on the way past. Run once by accident it turned 2635 brushes into 3840 and destroyed
 * 67 of the base's own, and nothing in the output said anything was wrong.
 *
 * A bare shell is under a hundred brushes. Anything more is somebody's map.
 */
const SHELL = 100;
let map;
if (mode.has("grow")) {
  if (before.brushes > SHELL) {
    console.log("");
    console.log("  REFUSED. `grow` builds the entire city, and this base already holds "
      + before.brushes + " brushes");
    console.log("  -- a finished map, not a shell. Growing onto it would put a second city on");
    console.log("  top of the first. Use the default, which adds only this project's own work.");
    console.log("");
    process.exit(1);
  }
  const { grow } = await import("./city.mjs");
  map = grow(base, { spawns: spawnPoints() });
  console.log(`  grown     ${map.brushes.length} brushes, ${map.entities.length} entities`);
} else {
  const r = addOns(base, { spawns: spawnPoints(), siege: mode.has("siege") });
  map = r.map;
  console.log(`  added     ${r.added} brush(es), ${r.entities} entit(y/ies)`
    + `  -> ${map.brushes.length} brushes, ${map.entities.length} entities`);
  for (const n of r.notes) console.log(`     ${n}`);
}

const file = join(OUT, `${NAME}.map`);
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
png(`${NAME}_plan.png`, M.planOfSource(map));
const reach = M.reachOf(map);
png(`${NAME}_reach.png`, M.planOfSource(map, { reach, heights: true }));
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
  out: join(OUT, `${NAME}.bsp`),
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

// ---- keep it as a numbered version ----------------------------------------------------------
/*
 * WHY VERSIONS AND NOT JUST out/.
 *
 * out/ holds one build and the next compile overwrites it, so two ways of laying something out can
 * never be compared -- by the time the second exists the first is gone. A numbered version is a
 * build kept whole: the .bsp to play, the .map it came from, and a line saying what was tried.
 *
 * Numbered rather than named because the numbers put themselves in order, and the order is the
 * point: it is how the map got from one idea to the next.
 */
if (mode.has("version")) {
  const root = join(HERE, "versions");
  mkdirSync(root, { recursive: true });
  const used = readdirSync(root).filter((d) => /^[0-9]+$/.test(d)).map(Number);
  const n = String((used.length ? Math.max(...used) : 0) + 1).padStart(2, "0");
  const dir = join(root, n);
  mkdirSync(dir, { recursive: true });

  copyFileSync(result.bsp, join(dir, `${NAME}.bsp`));
  copyFileSync(file, join(dir, `${NAME}.map`));

  const why = argv.filter((a) => !["compile", "deploy", "fast", "version", "grow", "siege"].includes(a)).join(" ");
  const note = [
    `version ${n}`,
    `built   ${new Date().toISOString().replace("T", " ").slice(0, 19)}`,
    `base    ${before.brushes} brushes, ${before.entities} entities`,
    `built   ${map.brushes.length} brushes, ${map.entities.length} entities`,
    `bsp     ${statSync(result.bsp).size} bytes${mode.has("fast") ? "  (DRAFT lighting)" : ""}`,
    "",
    why || "(say what was tried in this version here)",
    "",
  ].join(String.fromCharCode(10));
  writeFileSync(join(dir, "NOTES.txt"), note);

  console.log(`  kept as  versions/${n}/   (.bsp, .map and NOTES.txt)`);
}


// ---- deploy --------------------------------------------------------------------------------
if (mode.has("deploy")) {
  const live = join(TS_MAPS, `${NAME}.bsp`);
  if (existsSync(live)) {
    const backup = join(OUT, `${NAME}.bsp.before-smak`);
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
  const liveMap = join(TS_MAPS, `${NAME}_built.map`);
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
