// RCBot's waypoints for the wasteland maps: one walk of the place, written under each map's name.
//
// SMAK lays them (M.waypointsOf) on the map's brush source, walking from every place a player starts in any of
// the six maps and from every place the modes send bots: the uplink's zones and point, the assault points and
// the flag pads. The maps are one place, so the walk is the same; each file carries its own map's name in its
// head, as RCBot checks it. Bots path by these waypoints and hunt, as they do on every H9 map.
//
// NEEDS A SMAK FROM BEFORE 0.39.0. SMAK 1.0 gave up laying waypoints (its CHANGELOG, 0.39.0: waypointsOf and `smak map-waypoints` were
// pruned; only the .rcw writer stayed). The last SMAK that lays them is the commit before that prune:
//     git -C SMAK archive d1a54ad^ | tar -x -C <a folder>      and run this with SMAK=<that folder> in the environment.
// The maps themselves are made with the SMAK the repository pins (wasteland.mjs); only this walk needs the older one.
//
//   node waypoints.mjs            write out\h9_<mode>_wasteland.rcw for each of the six, and check them
//   node waypoints.mjs deploy     and copy them into H9XASH\rcbot\waypoints\ts beside the generator (the
//                                 folder the bot reads, once the files are in the game's own H9XASH)
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { M } from "../lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const NAMES = ["te", "up", "ws", "mw", "as", "ctf"].map((v) => `h9_${v}_wasteland`);
const SPACING = 160; // RCBot holds 1024 waypoints: SMAK widens this until the map fits
const CELL = 16;
const FEET = 37; // a spawn config's origin over the floor, as wasteland.mjs writes it

const maps = Object.fromEntries(NAMES.map((name) => {
  const source = join(OUT, `${name}.map`);
  if (!existsSync(source)) throw new Error(`no ${source}: run node wasteland.mjs first`);
  return [name, M.readMap(readFileSync(source, "utf8"))];
}));
const walked = maps[NAMES[0]]; // the ground, the ruins and the forts are the same in all six

// the places the walk starts from: every spawn of every map, and the modes' goals
const starts = [];
for (const name of NAMES)
  for (const w of readFileSync(join(OUT, `tsm_spawns_${name}.cfg`), "utf8").split(/\r?\n/).map((line) => line.trim().split(/\s+/)))
    if (w[0] === "tsm_spawn") starts.push([Number(w[2]), Number(w[3]), Number(w[4]) - FEET]);
const goals = [];
for (const name of NAMES)
  for (const e of maps[name].entities ?? [])
    if (e.classname === "info_target" && /^tsm_(cap_\d|uplink|as_\d|flag_\d)$/.test(e.targetname ?? ""))
      goals.push({ name: `${name} ${e.targetname}`, at: String(e.origin).split(/\s+/).map(Number) });
for (const g of goals) starts.push([g.at[0], g.at[1], g.at[2]]);

console.log(`\n  walking the wasteland from ${starts.length} places (${goals.length} of them the modes' goals)...`);
const made = M.waypointsOf(walked, { from: starts, spacing: SPACING, cell: CELL, most: 1024 });
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
  if (n.d > made.spacing) problems.push(`${g.name}: the nearest waypoint is ${Math.round(n.d)} away`);
  else console.log(`     ${g.name}: waypoint ${n.index}, ${Math.round(n.d)} away`);
}
const lonely = waypoints.filter((w) => !w.paths.length).length;
if (lonely) problems.push(`${lonely} waypoint(s) with no path out`);
if (problems.length) {
  for (const p of problems) console.log(`  PROBLEM ${p}`);
  process.exit(1);
}

const files = NAMES.map((name) => {
  const bytes = M.writeRcw(waypoints, { mapName: name });
  const back = M.readRcw(bytes);
  if (back.waypoints.length !== waypoints.length) throw new Error(`${name}: the .rcw read back holds ${back.waypoints.length} waypoints, not ${waypoints.length}`);
  const file = join(OUT, `${name}.rcw`);
  writeFileSync(file, bytes);
  return file;
});
console.log(`\n  ${waypoints.length} waypoints, ${waypoints.reduce((s, w) => s + w.paths.length, 0)} paths, at a spacing of ${Math.round(made.spacing)}: ${files.length} files in ${OUT}`);

if (process.argv.includes("deploy")) {
  const dir = join(HERE, "..", "..", "H9XASH", "rcbot", "waypoints", "ts");
  mkdirSync(dir, { recursive: true });
  for (const file of files) copyFileSync(file, join(dir, file.split(/[\\/]/).pop()));
  console.log(`  deployed to ${dir}`);
}
