// RCBot's waypoints for the drainage maps: one walk of the place, written under each map's name.
//
// SMAK lays them (M.waypointsOf) on the map's brush source, walking from every place a player starts in
// any of the maps and from every place the modes send bots: the four control zones and the uplink's point.
// The maps are one place, so the walk is the same; each file carries its own map's name in its head, as
// RCBot checks it.
//
// Bots path by these waypoints and hunt: no rcbot change plays the uplink's objective yet, so on an uplink map
// they fight over the zones' ground like anywhere else, as the survival mode's mutants and Mech Warrior's mechs
// do. Nothing here is special to any mode: a waypoint every SPACING units over everything walked, joined where
// a body walks or drops between them. The zones and the uplink's point are walked to all the same, so a bot
// made to play the objective finds a waypoint at each.
//
//   node waypoints.mjs            write out\h9_<mode>_drainage.rcw for each of the three, and check them
//   node waypoints.mjs deploy     and copy them into the RCBot folders the game reads (the Steam install's
//                                 first: build.bat copies those over H9XASH's)
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GAME_DIR, M } from "../lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const NAMES = ["h9_up_drainage", "h9_ws_drainage", "h9_mw_drainage"];
const SPACING = 128;
const CELL = 16;
const FEET = 37; // a spawn config's origin over the floor, as drainage.mjs writes it

const source = join(OUT, `${NAMES[0]}.map`);
if (!existsSync(source)) throw new Error(`no ${source}: run node drainage.mjs first`);
const map = M.readMap(readFileSync(source, "utf8"));

// the places the walk starts from: every spawn of every map, and the zones and the uplink's point
const starts = [];
for (const name of NAMES) {
  const cfg = join(OUT, `tsm_spawns_${name}.cfg`);
  for (const w of readFileSync(cfg, "utf8").split(/\r?\n/).map((line) => line.trim().split(/\s+/)))
    if (w[0] === "tsm_spawn") starts.push([Number(w[2]), Number(w[3]), Number(w[4]) - FEET]);
}
const goals = map.entities
  .filter((e) => e.classname === "info_target" && /^tsm_(cap_\d|uplink)$/.test(e.targetname ?? ""))
  .map((e) => ({ name: e.targetname, at: String(e.origin).split(/\s+/).map(Number) }));
for (const g of goals) starts.push([g.at[0], g.at[1], g.at[2] - 16]);

console.log(`\n  walking drainage from ${starts.length} places (${goals.length} of them the modes' goals)...`);
const made = M.waypointsOf(map, { from: starts, spacing: SPACING, cell: CELL, most: 1024 });
for (const fact of made.facts) console.log(`     ${fact}`);
for (const warning of made.warnings) console.log(`     WARN  ${warning}`);
const waypoints = made.waypoints;

// every goal must have a waypoint near it, or a bot sent there never arrives
const problems = [];
const nearest = (p) =>
  waypoints.reduce((best, w, index) => {
    const d = Math.hypot(w.origin[0] - p[0], w.origin[1] - p[1], w.origin[2] - p[2]);
    return d < best.d ? { index, d } : best;
  }, { index: -1, d: Infinity });
for (const g of goals) {
  const n = nearest([g.at[0], g.at[1], g.at[2] + 20]);
  if (n.d > SPACING) problems.push(`${g.name}: the nearest waypoint is ${Math.round(n.d)} away`);
  else console.log(`     ${g.name}: waypoint ${n.index}, ${Math.round(n.d)} away`);
}
const lonely = waypoints.filter((w) => !w.paths.length).length;
if (lonely) problems.push(`${lonely} waypoint(s) with no path out`);
if (problems.length) {
  for (const p of problems) console.log(`  PROBLEM ${p}`);
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });
const files = NAMES.map((name) => {
  const bytes = M.writeRcw(waypoints, { mapName: name });
  const back = M.readRcw(bytes);
  if (back.waypoints.length !== waypoints.length) throw new Error(`${name}: the .rcw read back holds ${back.waypoints.length} waypoints, not ${waypoints.length}`);
  const file = join(OUT, `${name}.rcw`);
  writeFileSync(file, bytes);
  return file;
});
console.log(`\n  ${waypoints.length} waypoints, ${waypoints.reduce((s, w) => s + w.paths.length, 0)} paths, at a spacing of ${Math.round(made.spacing)}: ${files.join(", ")}`);

if (process.argv.includes("deploy")) {
  const folders = [join(GAME_DIR, "rcbot", "waypoints", "ts"), join(GAME_DIR, "ts", "addons", "rcbot", "waypoints", "ts")];
  for (const dir of folders) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    for (const file of files) copyFileSync(file, join(dir, file.split(/[\\/]/).pop()));
    console.log(`  deployed to ${dir}`);
  }
}
