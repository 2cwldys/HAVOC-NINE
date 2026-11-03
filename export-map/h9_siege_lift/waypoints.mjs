// RCBot's waypoints for the lift's maps: two walks, since the siege map has its objectives' rooms and the
// other three do not -- the siege's written as out\h9_siege_lift.rcw, the modes' one walk written under each of
// h9_up_lift, h9_ws_lift and h9_mw_lift.
//
// SMAK lays them (M.waypointsOf) on each map's brush source: a waypoint every SPACING units over everything
// walked -- the decks, the stairs, the pod -- joined where a body walks, climbs or drops between them. The bots
// travel and fight inside the lift: every waypoint outside the hull (the gantry, the dock) is left out, and the
// gantry stays the players' flank. The doors a bot cannot open are shut to the walk: the Breacher's (named
// tsm_breach_*) and the engineers' (tsm_eng_door). On the siege map the rooms' vents are open to it: a bot
// standing by a grate shoots it out (RCBot takes a breakable beside it for a target) and crouches through.
//
//   node waypoints.mjs            write the four .rcw files, and check them
//   node waypoints.mjs deploy     and copy them into the RCBot folders the game reads (the Steam install's
//                                 first: build.bat copies those over H9XASH's)
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GAME_DIR, M } from "../lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const SPACING = 128;
const CELL = 16;
const FEET = 37; // a spawn config's origin over the floor, as lift.mjs writes it
const HULL_OUT = 1088; // the hull's outer face: no waypoint past it
const SHUT = ["tsm_breach_clamps", "tsm_breach_power", "tsm_breach_drive", "tsm_eng_door"];

/**
 * The most waypoints our RCBot takes: rcbot-patch's CHANGE 6 raised it from stock's 1024 to 4096, and the
 * patched rcbot_mm.dll is the one every H9 install ships. SMAK's writeRcw holds to stock's 1024 (and the kit is
 * not ours to change), so the file is written here, in the same format (smak/src/maps/rcbot.mjs).
 */
const OUR_MOST = 4096;
const RCW_HEADER = 52, RCW_WAYPOINT = 16, RCW_VERSION = 4, RCW_READ_VISIBILITY = 1;
function writeRcw(list, mapName) {
  let size = RCW_HEADER + list.length * RCW_WAYPOINT;
  for (const w of list) size += 2 + w.paths.length * 2;
  const data = Buffer.alloc(size);
  data.write("RCBot", 0, "latin1");
  data.writeInt32LE(RCW_VERSION, 8);
  data.writeInt32LE(RCW_READ_VISIBILITY, 12);
  data.writeInt32LE(list.length, 16);
  data.write(mapName, 20, "latin1");
  let at = RCW_HEADER;
  for (const w of list) {
    data.writeInt32LE(w.flags | 0, at);
    data.writeFloatLE(w.origin[0], at + 4);
    data.writeFloatLE(w.origin[1], at + 8);
    data.writeFloatLE(w.origin[2], at + 12);
    at += RCW_WAYPOINT;
  }
  for (const w of list) {
    data.writeInt16LE(w.paths.length, at);
    at += 2;
    for (const to of w.paths) {
      data.writeInt16LE(to, at);
      at += 2;
    }
  }
  return data;
}

const readSource = (name) => {
  const file = join(OUT, `${name}.map`);
  if (!existsSync(file)) throw new Error(`no ${file}: run node lift.mjs first`);
  return M.readMap(readFileSync(file, "utf8"));
};
const spawnsOf = (name) =>
  readFileSync(join(OUT, `tsm_spawns_${name}.cfg`), "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/))
    .filter((w) => w[0] === "tsm_spawn");

/** The siege's objectives: the floor just in front of each machine. */
const objectivesOf = (map) =>
  map.entities
    .filter((e) => /^tsm_obj_\d$/.test(e.targetname ?? ""))
    .map((e) => {
      const pts = e.brushes.flatMap((b) => M.shapeOf(b).faces.flatMap((f) => f.polygon));
      const lo = [0, 1, 2].map((k) => Math.min(...pts.map((p) => p[k])));
      const hi = [0, 1, 2].map((k) => Math.max(...pts.map((p) => p[k])));
      // along the machine's middle, 48 past its farthest point from the core: clear floor in front of it
      const c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2];
      const far = Math.max(...pts.map((p) => Math.hypot(p[0], p[1]))) + 48;
      const r = Math.hypot(c[0], c[1]);
      return { name: e.targetname, at: [Math.round((c[0] / r) * far), Math.round((c[1] / r) * far), lo[2]] };
    });
/** The uplink's zones and its point, on their floors. */
const zonesOf = (map) =>
  map.entities
    .filter((e) => e.classname === "info_target" && /^tsm_(cap_\d|uplink)$/.test(e.targetname ?? ""))
    .map((e) => ({ name: e.targetname, at: String(e.origin).split(/\s+/).map(Number).map((v, k) => (k === 2 ? v - 16 : v)) }));

/**
 * One walk of a map, from every spawn of `names` and every goal, inside the hull; checked so that every spawn
 * reaches every goal along the paths. Returns the waypoints, or exits with the problems.
 */
function walk(label, map, names, goals, open) {
  const starts = names.flatMap((name) => spawnsOf(name).map((w) => [Number(w[2]), Number(w[3]), Number(w[4]) - FEET]));
  for (const g of goals) starts.push(g.at);
  console.log(`\n  walking ${label} from ${starts.length} places (${goals.length} of them goals)...`);
  const made = M.waypointsOf(map, { from: starts, spacing: SPACING, cell: CELL, most: OUR_MOST, shut: SHUT, open });
  for (const warning of made.warnings) console.log(`     WARN  ${warning}`);
  const keep = made.waypoints.map((wp) => Math.hypot(wp.origin[0], wp.origin[1]) <= HULL_OUT);
  const renumber = [];
  let kept = 0;
  keep.forEach((k, i) => (renumber[i] = k ? kept++ : -1));
  const waypoints = made.waypoints
    .filter((_, i) => keep[i])
    .map((wp) => ({ ...wp, paths: wp.paths.map((p) => renumber[p]).filter((p) => p >= 0) }));
  console.log(`     inside the lift: ${waypoints.length} of ${made.waypoints.length} waypoints kept`);

  const problems = [];
  const nearest = (p) =>
    waypoints.reduce((best, w, index) => {
      const d = Math.hypot(w.origin[0] - p[0], w.origin[1] - p[1], w.origin[2] - p[2]);
      return d < best.d ? { index, d } : best;
    }, { index: -1, d: Infinity });
  const goalPoints = goals.map((g) => ({ name: g.name, ...nearest([g.at[0], g.at[1], g.at[2] + 20]) }));
  for (const g of goalPoints)
    if (g.d > SPACING) problems.push(`${g.name}: the nearest waypoint is ${Math.round(g.d)} away`);
    else console.log(`     ${g.name}: waypoint ${g.index}, ${Math.round(g.d)} away`);
  const reachFrom = (from) => {
    const seen = new Set([from]);
    const queue = [from];
    while (queue.length) for (const next of waypoints[queue.shift()].paths) if (!seen.has(next)) (seen.add(next), queue.push(next));
    return seen;
  };
  const rows = names.flatMap((name) => spawnsOf(name));
  let cut = 0;
  for (const w of rows) {
    const seen = reachFrom(nearest([Number(w[2]), Number(w[3]), Number(w[4]) - FEET + 20]).index);
    for (const g of goalPoints) if (!seen.has(g.index) && cut++ < 8) problems.push(`team ${w[1]} tier ${w[7]} spawn at ${w[2]} ${w[3]} ${w[4]}: no path to ${g.name}`);
  }
  if (cut) console.log(`     ${cut} spawn-to-goal routes missing`);
  else console.log(`     every spawn (${rows.length}) has a path to every goal`);
  const lonely = waypoints.filter((w) => !w.paths.length).length;
  if (lonely) problems.push(`${lonely} waypoint(s) with no path out`);
  if (problems.length) {
    for (const p of problems) console.log(`  PROBLEM ${p}`);
    process.exit(1);
  }
  console.log(`     ${waypoints.length} waypoints, ${waypoints.reduce((s, w) => s + w.paths.length, 0)} paths`);
  return waypoints;
}

const siegeMap = readSource("h9_siege_lift");
const siege = walk("h9_siege_lift", siegeMap, ["h9_siege_lift"], objectivesOf(siegeMap), ["lift_vent"]);
const upMap = readSource("h9_up_lift");
const modes = walk("the mode maps", upMap, ["h9_up_lift", "h9_ws_lift", "h9_mw_lift"], zonesOf(upMap), []);

mkdirSync(OUT, { recursive: true });
const files = [
  ["h9_siege_lift", siege],
  ["h9_up_lift", modes],
  ["h9_ws_lift", modes],
  ["h9_mw_lift", modes],
].map(([name, list]) => {
  const bytes = writeRcw(list, name);
  if (bytes.readInt32LE(16) !== list.length) throw new Error("the .rcw's count is not the waypoints'");
  const file = join(OUT, `${name}.rcw`);
  writeFileSync(file, bytes);
  return file;
});
console.log(`\n  written: ${files.map((f) => f.split(/[\\/]/).pop()).join(", ")}`);

if (process.argv.includes("deploy")) {
  const folders = [join(GAME_DIR, "rcbot", "waypoints", "ts"), join(GAME_DIR, "ts", "addons", "rcbot", "waypoints", "ts")];
  for (const dir of folders) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    for (const file of files) copyFileSync(file, join(dir, file.split(/[\\/]/).pop()));
    console.log(`  deployed to ${dir}`);
  }
}
