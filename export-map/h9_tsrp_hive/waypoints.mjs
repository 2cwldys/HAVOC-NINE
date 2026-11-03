// RCBot's waypoints for h9_tsrp_hive: the three cities as one set, joined by the six travel zones.
//
// SMAK lays them (M.waypointsOf) on the merged map's brush source: its walk reads brush source and compiled
// maps alike, and the kit's BSP reader takes v30 only, while this map is BSP2. The walk goes on through a
// trigger_teleport to where it leads, but lays no waypoint for one, so each travel zone gets one here: a
// waypoint in the middle of its trigger, flagged TELEPORT, whose only path goes to the waypoint at the arrival
// point in the city it leads to. RCBot's A* charges nothing for a path out of a TELEPORT waypoint
// (bot_navigate.cpp), so a bot bound for another city walks into the zone, and goes on from where it lands.
// No other waypoint stands in a zone and no other path crosses one, so no bot is sent by accident.
//
// DOORS AND BREAKABLES, as they stand in the game. A door that nothing in the map ever opens (its name fired
// by no target, killtarget or multi_manager) and that does not start open is shut to the walk, and the
// waypoints go round it; a door a button or trigger opens, or one with no name (it opens to the touch), is
// walked through. What breaks (func_breakable) is a wall, as SMAK has it unless told. The patched RCBot still
// shoots down a TS breakable door that stands shut in its way (rcbot-patch CHANGE 6).
//
// LIFTS AND TRAINS are not ridden: the walk does not take them, and RCBot cannot ride a func_train. A city's
// floors that hang on one (Xenon's, Alexandria's two halves) are reached by the portals only, so a bot does
// not get everywhere -- it roams what it walks to and goes on by any portal it comes to.
//
// THE CAP. The patched RCBot holds 4096 waypoints a map (rcbot-patch CHANGE 6); stock RCBot holds 1024 and
// reads a longer file past the end of its array. SMAK widens the spacing until the waypoints fit MOST, and its
// own .rcw writer stops at the stock 1024, so the file is written here, in the same layout (smak
// src/maps/rcbot.mjs), and read back with the kit's reader before anything is kept.
//
//   node waypoints.mjs            write out\h9_tsrp_hive.rcw and out\h9_tsrp_hive_waypoints.json
//   node waypoints.mjs deploy     and copy the .rcw into the bot folders RCBot reads
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GAME_DIR, M } from "../lib.mjs";
import { floorBelow, footing } from "./spots.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const NAME = "h9_tsrp_hive";
const MAP = join(OUT, `${NAME}.map`);
const SPAWNS = join(OUT, `tsm_spawns_${NAME}.cfg`);

const MOST = 4096; // the patched RCBot's MAX_WAYPOINTS
const SPACING = 160; // SMAK's own; it widens the spacing until the waypoints fit MOST
const CELL = 16; // the walk's grid (SMAK's own is 8): three cities' walk stays in bounds and quick
const FEET = 36; // a player's origin over his floor
const ZONE_CLEAR = 16; // a zone's trigger grown by a player's half-width: no other waypoint or path in it
const ZONE_LEADS = 4; // the most waypoints given a path into a zone
const ZONE_REACH = 256; // how far from a zone those waypoints may be
const STEP = 18; // the most a walk goes up or down without a jump
// The highest drop a path goes down (SMAK's own is 250). Paradise's portal to Xenon stands on a lower level
// whose only way down is a jump over the railing at the end of a tunnel: 233 under the tunnel's floor, 265
// from the top of the jump (a fall that costs about 16 health). Paths take it at this.
const DROP = 300;
const MAX_COORD = 4096; // RCBot takes a waypoint with x, y or z over this as deleted when it loads them
const CITIES = [
  ["Alexandria", -4040, -1488],
  ["Paradise City", -1488, 411],
  ["Xenon City", 411, 4040],
]; // merged z

/** Every place RCBot reads waypoints from: the bot folder beside each game folder that runs the map. */
const BOT_FOLDERS = [join(GAME_DIR, "rcbot"), join(HERE, "..", "..", "H9XASH", "rcbot")];

const deploy = process.argv.includes("deploy");
const cityOf = (z) => CITIES.find(([, low, high]) => z - FEET >= low && z - FEET < high)?.[0] ?? "outside";
const valueOf = (value) => String(value ?? "").trim().split(/\s+/).map(Number);

function boundsOf(brushes) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const brush of brushes)
    for (const face of M.shapeOf(brush).faces)
      for (const point of face.polygon)
        for (let a = 0; a < 3; a++) {
          min[a] = Math.min(min[a], point[a]);
          max[a] = Math.max(max[a], point[a]);
        }
  return { min, max };
}

/** Whether the segment a-b, in plan, passes through the box (grown by `grow`) and the box's height band. */
function crossesBox(a, b, box, grow) {
  const lo = [box.min[0] - grow, box.min[1] - grow];
  const hi = [box.max[0] + grow, box.max[1] + grow];
  if (Math.max(a[2], b[2]) - FEET < box.min[2] - STEP * 2 || Math.min(a[2], b[2]) - FEET > box.max[2]) return false;
  // Liang-Barsky in plan
  let t0 = 0;
  let t1 = 1;
  const d = [b[0] - a[0], b[1] - a[1]];
  for (let axis = 0; axis < 2; axis++) {
    if (Math.abs(d[axis]) < 1e-9) {
      if (a[axis] < lo[axis] || a[axis] > hi[axis]) return false;
      continue;
    }
    let near = (lo[axis] - a[axis]) / d[axis];
    let far = (hi[axis] - a[axis]) / d[axis];
    if (near > far) [near, far] = [far, near];
    t0 = Math.max(t0, near);
    t1 = Math.min(t1, far);
    if (t0 > t1) return false;
  }
  return true;
}

/** Whether a standing body walks the straight line from one waypoint's floor to a point's, no jump, no drop. */
function walks(space, from, to) {
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  let floor = from[2] - FEET;
  for (let travelled = 8; travelled < length + 8; travelled += 8) {
    const t = Math.min(1, travelled / length);
    const x = from[0] + (to[0] - from[0]) * t;
    const y = from[1] + (to[1] - from[1]) * t;
    const next = floorBelow(space, x, y, floor + STEP + 1, STEP * 2 + 1);
    if (next === null || Math.abs(next - floor) > STEP) return false;
    if (!footing(space, x, y, next, { slack: 1 })) return false;
    floor = next;
  }
  return Math.abs(floor - (to[2] - FEET)) <= STEP;
}

/** The .rcw, in the layout of SMAK's writeRcw (its head says what each part is), without its 1024 cap. */
function rcwOf(waypoints, mapName) {
  let size = M.RCW_HEADER + waypoints.length * M.RCW_WAYPOINT;
  for (const waypoint of waypoints) size += 2 + waypoint.paths.length * 2;
  const data = Buffer.alloc(size);
  data.write("RCBot", 0, "latin1");
  data.writeInt32LE(M.RCW_VERSION, 8);
  data.writeInt32LE(M.RCW_READ_VISIBILITY, 12);
  data.writeInt32LE(waypoints.length, 16);
  data.write(mapName, 20, "latin1");
  let at = M.RCW_HEADER;
  for (const waypoint of waypoints) {
    data.writeInt32LE(waypoint.flags | 0, at);
    for (let axis = 0; axis < 3; axis++) data.writeFloatLE(waypoint.origin[axis], at + 4 + axis * 4);
    at += M.RCW_WAYPOINT;
  }
  for (const waypoint of waypoints) {
    data.writeInt16LE(waypoint.paths.length, at);
    at += 2;
    for (const to of waypoint.paths) {
      data.writeInt16LE(to, at);
      at += 2;
    }
  }
  return data;
}

// ---- the map, its zones and the places the walk starts from ----------------------------------------------
if (!existsSync(MAP)) throw new Error(`no ${MAP}: run node merge.mjs first`);
if (!existsSync(SPAWNS)) throw new Error(`no ${SPAWNS}: run node spawns.mjs first`);
const map = M.readMap(readFileSync(MAP, "utf8"));

const named = (targetname) => map.entities.find((e) => e.targetname === targetname);
const zones = map.entities
  .filter((e) => e.classname === "trigger_teleport" && /^hive_[a-z]+_pad_[a-z]+$/.test(e.targetname ?? ""))
  .map((e) => {
    const box = boundsOf(e.brushes ?? []);
    const arrival = named(e.target);
    if (!arrival) throw new Error(`${e.targetname}: no ${e.target}`);
    const floor = box.min[2] - 1; // merge.mjs's travelZone stands the trigger 1 over the floor
    return {
      name: e.targetname,
      box,
      at: [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, floor + FEET],
      lands: valueOf(arrival.origin), // a player's origin, as the destination is placed
    };
  });
if (zones.length !== 6) throw new Error(`${zones.length} travel zones in ${MAP}, not 6`);

const spawns = readFileSync(SPAWNS, "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim().split(/\s+/))
  .filter((w) => w[0] === "tsm_spawn")
  .map((w) => ({ team: Number(w[1]), feet: [Number(w[2]), Number(w[3]), Number(w[4]) - FEET] }));

const fired = new Set();
for (const e of map.entities) {
  if (e.target) fired.add(e.target);
  if (e.killtarget) fired.add(e.killtarget);
  if (e.classname === "multi_manager") for (const key of Object.keys(e)) fired.add(key.replace(/#\d+$/, ""));
}
const neverOpens = (e) =>
  /^func_door/.test(e.classname ?? "") && e.targetname && !fired.has(e.targetname) && !(Number(e.spawnflags ?? 0) & 1);
const shut = [...new Set(map.entities.filter(neverOpens).map((e) => e.targetname))];

// ---- the walk, and the waypoints laid on it ----------------------------------------------------------------
console.log(`\n  ${NAME}: walking from ${spawns.length} spawns and ${zones.length} arrival points (${shut.length} door names that never open, shut)...`);
const started = Date.now();
const made = M.waypointsOf(map, {
  from: [...spawns.map((spawn) => spawn.feet), ...zones.map((zone) => [zone.lands[0], zone.lands[1], zone.lands[2] - FEET])],
  shut,
  spacing: SPACING,
  cell: CELL,
  most: MOST,
  drop: DROP,
});
console.log(`  walked and laid in ${Math.round((Date.now() - started) / 1000)} s, at a spacing of ${Math.round(made.spacing)}`);
for (const fact of made.facts) console.log(`     ${fact}`);
for (const warning of made.warnings) console.log(`     WARN  ${warning}`);
const space = made.reach.graph.space;

// ---- the zones: nothing else in them, one TELEPORT waypoint each -------------------------------------------
const inZone = (origin) =>
  zones.some(({ box }) =>
    origin[0] > box.min[0] - ZONE_CLEAR && origin[0] < box.max[0] + ZONE_CLEAR &&
    origin[1] > box.min[1] - ZONE_CLEAR && origin[1] < box.max[1] + ZONE_CLEAR &&
    origin[2] - FEET > box.min[2] - STEP * 2 && origin[2] - FEET < box.max[2]);
const kept = made.waypoints.map((waypoint, index) => ({ ...waypoint, index })).filter((waypoint) => !inZone(waypoint.origin));
const renumber = new Map(kept.map((waypoint, index) => [waypoint.index, index]));
const waypoints = kept.map((waypoint) => ({
  origin: waypoint.origin,
  flags: waypoint.flags,
  kind: waypoint.kind,
  paths: waypoint.paths
    .filter((to) => renumber.has(to))
    .map((to) => renumber.get(to))
    .filter((to) => !zones.some((zone) => crossesBox(waypoint.origin, kept[to].origin, zone.box, ZONE_CLEAR))),
}));
const removed = { waypoints: made.waypoints.length - kept.length, paths: 0 };
removed.paths = made.waypoints.reduce((sum, w) => sum + w.paths.length, 0) - waypoints.reduce((sum, w) => sum + w.paths.length, 0);

const nearest = (point) => {
  let best = -1;
  let far = Infinity;
  waypoints.forEach((waypoint, index) => {
    const d = Math.hypot(waypoint.origin[0] - point[0], waypoint.origin[1] - point[1], waypoint.origin[2] - point[2]);
    if (d < far) [best, far] = [index, d];
  });
  return { index: best, far };
};

const report = [];
const zoneIndex = new Map();
for (const zone of zones) {
  zoneIndex.set(zone.name, waypoints.length);
  waypoints.push({ origin: zone.at, flags: M.RCW_FLAGS.TELEPORT, kind: "teleport", paths: [] });
}
for (const zone of zones) {
  const at = zoneIndex.get(zone.name);
  // the walk puts a waypoint at each place it starts from, on its grid: within a cell of the point
  const arrival = nearest(zone.lands);
  if (arrival.far > CELL) throw new Error(`${zone.name}: no waypoint at its arrival point ${zone.lands.join(" ")} (nearest ${Math.round(arrival.far)} off)`);
  waypoints[at].paths = [arrival.index]; // the only path out of a TELEPORT waypoint
  const leads = waypoints
    .map((waypoint, index) => ({ index, d: Math.hypot(waypoint.origin[0] - zone.at[0], waypoint.origin[1] - zone.at[1], waypoint.origin[2] - zone.at[2]) }))
    .filter(({ index, d }) => d <= ZONE_REACH && !(waypoints[index].flags & M.RCW_FLAGS.TELEPORT))
    .sort((a, b) => a.d - b.d)
    .filter(({ index }) => walks(space, waypoints[index].origin, zone.at))
    .filter(({ index }) => !zones.some((other) => other !== zone && crossesBox(waypoints[index].origin, zone.at, other.box, ZONE_CLEAR)))
    .slice(0, ZONE_LEADS);
  if (!leads.length) throw new Error(`${zone.name}: no waypoint within ${ZONE_REACH} walks into it`);
  for (const { index } of leads) waypoints[index].paths.push(at);
  report.push(`${zone.name.padEnd(16)} ${leads.length} in, out to ${zone.lands.map(Math.round).join(" ")} (${cityOf(zone.lands[2])})`);
}

// ---- the drops the walk takes and the paths do not -----------------------------------------------------------
// SMAK joins two waypoints across a drop when the straight line between them drops. A drop through a hole that
// the line between no two waypoints crosses (Paradise's way down to its portal to Xenon) is joined here, along
// the walk's own route to each zone the teams' paths do not reach: a waypoint at the edge, one where the fall
// lands, a path down between them, and paths in from the waypoints the bot walks to the edge from and out to
// the ones it walks on to. Where the route jumps there instead (its point over the hole is in the air: a jump
// over a railing), the place it jumps from gets a JUMP waypoint whose path goes to the landing: RCBot jumps
// towards the next waypoint on touching one. A drop is a fall at least twice as long as the step across it (the
// steps of a ramp are not), to floor the teams' paths do not reach yet.
const pathReach = (starts) => {
  const seen = new Set(starts);
  const queue = [...starts];
  for (let at = 0; at < queue.length; at++)
    for (const to of waypoints[queue[at]].paths)
      if (!seen.has(to)) {
        seen.add(to);
        queue.push(to);
      }
  return seen;
};
const spawnStarts = spawns.map((spawn) => nearest([spawn.feet[0], spawn.feet[1], spawn.feet[2] + FEET]).index);
const stitched = [];
const unreachedZones = () => { const seen = pathReach(spawnStarts); return zones.filter((zone) => !seen.has(zoneIndex.get(zone.name))); };
if (unreachedZones().length) {
  const goals = unreachedZones();
  const walk = M.reachOf(map, { from: spawns.map((spawn) => spawn.feet), cell: CELL, shut, jump: 45, parts: false, to: goals.map((zone) => [zone.at[0], zone.at[1], zone.at[2] - FEET]) });
  for (const route of walk.routes ?? []) {
    const points = route.points ?? [];
    for (let k = 1; k < points.length; k++) {
      const [a, b] = [points[k - 1], points[k]];
      const plan = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const fall = a[2] - b[2];
      if (plan > 64 || fall <= 48 || fall < plan * 2 || fall > DROP) continue; // a hop, a walk, a ramp, or too high
      const floorAt = (p) => floorBelow(space, p[0], p[1], p[2] + STEP + 1, 64 + STEP);
      const bottom = floorAt(b);
      if (bottom === null) continue;
      const landing = [b[0], b[1], bottom + FEET];
      const reach = pathReach(spawnStarts);
      if (reach.has(nearest(landing).index) && nearest(landing).far <= CELL) continue; // already reached
      // walk off an edge the route stands on, or jump from where it came from when it is in the air there
      const top = floorAt(a);
      const before = k >= 2 ? points[k - 2] : null;
      const beforeFloor = before && Math.hypot(before[0] - a[0], before[1] - a[1]) <= 96 ? floorAt(before) : null;
      let chain;
      if (top !== null && a[2] - top <= STEP) chain = [{ origin: [a[0], a[1], top + FEET], flags: 0, kind: "drop" }];
      else if (beforeFloor !== null) chain = [{ origin: [before[0], before[1], beforeFloor + FEET], flags: M.RCW_FLAGS.JUMP, kind: "jump" }];
      else continue;
      const way = chain[0].origin; // where the bot walks to from the waypoints it already reaches
      // the walk's own route stood here, so a short clear line to it is walked even where the strict test is not
      // (a body at the foot of a railing)
      const goes = (from, to) => walks(space, from, to) || (Math.hypot(...from.map((v, axis) => v - to[axis])) <= 96 && space.sees(from, to));
      const into = waypoints
        .map((waypoint, index) => ({ index, d: Math.hypot(...waypoint.origin.map((v, axis) => v - way[axis])) }))
        .filter(({ index, d }) => d <= SPACING * 1.5 && reach.has(index) && goes(waypoints[index].origin, way))
        .sort((x, y) => x.d - y.d)
        .slice(0, 2);
      const onto = waypoints
        .map((waypoint, index) => ({ index, d: Math.hypot(...waypoint.origin.map((v, axis) => v - landing[axis])) }))
        .filter(({ index, d }) => d <= SPACING * 1.5 && !(waypoints[index].flags & M.RCW_FLAGS.TELEPORT) && goes(landing, waypoints[index].origin))
        .sort((x, y) => x.d - y.d)
        .slice(0, 2);
      if (!into.length || !onto.length) continue;
      const first = waypoints.length;
      chain.forEach((waypoint, i) => waypoints.push({ ...waypoint, paths: [first + i + 1] }));
      waypoints.push({ origin: landing, flags: 0, kind: "landing", paths: onto.map(({ index }) => index) });
      for (const { index } of into) waypoints[index].paths.push(first);
      stitched.push(`${chain[0].kind === "jump" ? "a jump from" : "a drop off"} ${way.map(Math.round).join(" ")} down ${Math.round(way[2] - landing[2])} to ${landing.map(Math.round).join(" ")}`);
    }
  }
}

// ---- checks: the bot's limits, and a portal within a bot's reach wherever it starts or lands ---------------
// The cities hang their floors on lifts and trains, which bots do not ride, so a bot does not get everywhere:
// what is asked is that it leaves home by a portal, and that wherever a portal puts it, another one is in reach.
// All checks are made before any is told, and the plan of the waypoints is written either way, to look at.
const problems = [];
if (waypoints.length > MOST) problems.push(`${waypoints.length} waypoints, over the ${MOST} the patched RCBot holds`);
const outside = waypoints.findIndex((waypoint) => waypoint.origin.some((v) => Math.abs(v) > MAX_COORD));
if (outside >= 0) problems.push(`waypoint ${outside} at ${waypoints[outside].origin.join(" ")}: past ${MAX_COORD}, RCBot drops it`);
// the zones a set of waypoints walks into, without going through any zone first
const zonesWalkedTo = (starts) => {
  const seen = new Set(starts);
  const queue = [...starts];
  const found = [];
  for (let at = 0; at < queue.length; at++) {
    if (waypoints[queue[at]].flags & M.RCW_FLAGS.TELEPORT) {
      found.push(zones.find((zone) => zoneIndex.get(zone.name) === queue[at]).name);
      continue;
    }
    for (const to of waypoints[queue[at]].paths)
      if (!seen.has(to)) {
        seen.add(to);
        queue.push(to);
      }
  }
  return found;
};
const reached = {};
const leavesBy = {};
for (const team of [1, 2]) {
  const starts = spawns.filter((spawn) => spawn.team === team).map((spawn) => nearest([spawn.feet[0], spawn.feet[1], spawn.feet[2] + FEET]).index);
  reached[team] = pathReach(starts);
  leavesBy[team] = zonesWalkedTo(starts);
  if (!leavesBy[team].length) problems.push(`team ${team}'s spawns walk to no portal`);
}
const onwardFrom = {};
for (const zone of zones) {
  const landing = waypoints[zoneIndex.get(zone.name)].paths[0];
  onwardFrom[zone.name] = zonesWalkedTo([landing]);
  if (!onwardFrom[zone.name].length) problems.push(`a bot that ${zone.name} lands walks to no portal from there`);
}
writeFileSync(
  join(OUT, `${NAME}_waypoints.json`),
  JSON.stringify({
    spacing: Math.round(made.spacing),
    problems,
    waypoints: waypoints.map(({ origin, flags, kind, paths }, index) => ({
      origin: origin.map((v) => Math.round(v * 10) / 10),
      flags,
      kind,
      paths,
      teams: [1, 2].filter((team) => reached[team].has(index)),
    })),
  }),
);
if (problems.length) throw new Error(`the waypoints fail ${problems.length} check(s) (out\\${NAME}_waypoints.json has them):\n  ${problems.join("\n  ")}`);

// ---- the file, read back --------------------------------------------------------------------------------
const bytes = rcwOf(waypoints, NAME);
const back = M.readRcw(bytes);
if (back.waypoints.length !== waypoints.length || back.mapName !== NAME || back.fileFlags !== M.RCW_READ_VISIBILITY)
  throw new Error("the .rcw does not read back as written");
back.waypoints.forEach((waypoint, index) => {
  if (waypoint.paths.join() !== waypoints[index].paths.join() || waypoint.flags !== (waypoints[index].flags | 0))
    throw new Error(`waypoint ${index} does not read back as written`);
});
const rcw = join(OUT, `${NAME}.rcw`);
writeFileSync(rcw, bytes);

const kinds = {};
for (const waypoint of waypoints) kinds[waypoint.kind] = (kinds[waypoint.kind] ?? 0) + 1;
console.log(`\n  ${waypoints.length} waypoints (${removed.waypoints} taken out of the zones, ${removed.paths} paths through them dropped):`);
for (const [city] of CITIES) console.log(`     ${city.padEnd(14)} ${waypoints.filter((waypoint) => cityOf(waypoint.origin[2]) === city).length}`);
console.log(`     kinds: ${Object.entries(kinds).map(([kind, count]) => `${kind} ${count}`).join(", ")}`);
console.log(`     paths: ${waypoints.reduce((sum, waypoint) => sum + waypoint.paths.length, 0)}`);
console.log("  travel zones:");
for (const line of report) console.log(`     ${line}`);
console.log(`  drops joined from the walk: ${stitched.length ? stitched.join("; ") : "none needed"}`);
console.log("  where bots get on foot:");
for (const team of [1, 2]) {
  const cities = CITIES.map(([city]) => `${city} ${[...reached[team]].filter((index) => cityOf(waypoints[index].origin[2]) === city).length}`).join(", ");
  console.log(`     team ${team} leaves home by ${leavesBy[team].join(", ")}; reaches waypoints in ${cities}`);
}
for (const zone of zones) console.log(`     landed by ${zone.name.padEnd(16)} -> walks on to ${onwardFrom[zone.name].join(", ")}`);
console.log(`  wrote ${rcw}  (${bytes.length} bytes, read back whole)`);

// ---- deploy, when asked: every bot folder, keeping a copy of what was there ------------------------------
if (deploy) {
  for (const bot of BOT_FOLDERS) {
    const to = join(bot, "waypoints", "ts", `${NAME}.rcw`);
    if (existsSync(to)) {
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "_").slice(0, 15);
      const keep = join(HERE, "..", "..", "backups", `waypoints-${NAME}-${stamp}`);
      mkdirSync(keep, { recursive: true });
      copyFileSync(to, join(keep, `${NAME}.rcw`));
      console.log(`  kept the old one: ${join(keep, `${NAME}.rcw`)}`);
    }
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(rcw, to);
    console.log(`  deployed  ${to}`);
  }
  console.log("  RCBot works out the visibility table (rcbot\\visibility\\ts\\h9_tsrp_hive.rcv2) on the map's first load.");
} else {
  console.log("  `node waypoints.mjs deploy` copies it into the bot folders.");
}
console.log("");
