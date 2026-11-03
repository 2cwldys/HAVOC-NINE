// roamwaypoints.mjs: where New Byzantium's citizens may walk. RCBot's roam waypoints for the map, laid in
// its public spaces only, and the places the citizens appear (tsrp_roambots.sma, rcbot-patch CHANGE 8).
//
//   node roamwaypoints.mjs            lay them from out\<map>.map and out\<map>.plan.json
//   node roamwaypoints.mjs deploy     and copy them where RCBot and the plugin read them
//
// city.mjs runs it with every build of the map (roamStep, the call marked ROAM WAYPOINTS there): with
// --compile, --roam or deploy, unless --noroam, in a node process of its own, which has the memory the
// walk needs to itself. Nothing in it is placed by hand: the plan says which spaces are public, SMAK's
// walk says where a body stands and goes in the built map.
//
// WHAT A CITIZEN MAY WALK. A space the plan exports as public (.plan.json's publicSpaces) whose kind is
// one of ROAM_KINDS (streets, alleys, plazas, courts, galleries, stairs, passages, halls, the Mese and the
// ways off it, the Well), and whose kind and name say nothing of the MSR or of anything private. A space
// with no kind, or a kind this file does not know, is kept out; so are public spaces that are no street
// (the sewers, the cistern, the canal quarter). Where a space a citizen may walk and one it may not
// overlap, the one it may not wins.
//
// HOW THEY ARE LAID.
//   1. The walk (SMAK's waypointsOf) from points on the citizens' floors, with every door shut -- a citizen
//      never opens one, so no path goes through a door, a checkpoint's included -- no jumps, no crouching,
//      and no drop higher than a kerb (DROP).
//   2. Every waypoint goes whose feet are not in a space a citizen may walk, or are under the streets'
//      level (LOWEST_FEET), and every ladder waypoint. A path stays only if its whole line runs through such
//      space (checked every SAMPLE units) -- one that would cut through a home, a shop or MSR space is
//      dropped even where the walk went that way -- and a player walks it (walksLine).
//   3. Only the largest set of waypoints that all reach one another is kept, so every goal a citizen
//      picks can be walked to and back. Whatever only private space joined to it falls away here.
//   4. The .rcw is written for the patched RCBot: up to MOST waypoints, x and y within +/-REACH_XY and z
//      within +/-REACH_Z (CHANGE 8 widened RCBot's waypoint table; stock it drops anything past +4096),
//      then read back with SMAK's reader before it is kept. It goes out only with its visibility file
//      (.rcv2) beside it and its header's W_FILE_FL_READ_VISIBILITY cleared, the table worked out here
//      (..\rcbot_vis.mjs), so RCBot never works it out at map load.
//   5. The spots: the kept waypoints on the open floor of a street, plaza, court, hall or the Mese (not
//      stairs, passages or galleries), each with its district, for the plugin to spread the citizens
//      with: configs\tsrp_roamspots_<map>.cfg.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GAME_DIR, K, M } from "../lib.mjs";
import { pairReady, writeWithVisibility } from "../rcbot_vis.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const TSM = join(HERE, "..", "..");
const NAME = "h9_tsrp_newbyzantium";

const MOST = 4096; // the patched RCBot's MAX_WAYPOINTS (rcbot-patch CHANGE 6)
const REACH_XY = 16384; // its waypoint table across the map, and up and down (CHANGE 8)
const REACH_Z = 4096;
const SPACING = 256; // waypoints this far apart by walk on open floor; RCBot looks 400 for the nearest
const CELL = 16; // the walk's grid
const DROP = 40; // the highest step down a path takes: a kerb, never a ledge
const STEP = 18; // the highest step up a player walks (the engine's stepsize)
// The walk's own step. On its grid (CELL) a body meets a stair's first riser and the ramp over it in one
// move: a riser of 16 and a CLIP ramp's lip on it come to 27 at once, where a player, moving a unit or two a
// frame, steps up 16 and walks on. With the engine's 18 the walk takes such stairs down and never up. So it
// walks with WALK_STEP, and every path is then walked again, a player's way (walksLine): FINE units at a
// time, never up more than STEP at once.
const WALK_STEP = 30;
const FINE = 2;
const STEEP = 0.7; // a floor steeper than this (the z of its normal) is slid down, not walked
const FEET = 36; // a standing player's origin over his feet
const SAMPLE = 16; // a path's line is checked this often
const SPOT_GROUND = 24; // a spot stands within this of its space's own floor (not on a gallery over it)
// The citizens keep to the streets' level and over it: nothing under it is a street (the stairwells that go
// down from the streets to the undercity are public, and their foot is the sewers' door).
const LOWEST_FEET = -64;

/** Kinds of public space a citizen walks. Anything else, or nothing, it does not. */
export const ROAM_KINDS = new Set([
  "avenue", "ring", "outer", "street", "alley", "road", "sidewalk", "crossing", "plaza", "square", "court",
  "garden", "park", "gallery", "walkway", "stair", "stairs", "ramp", "ascent", "passage", "bridge", "mese",
  "upper", "arcade", "atrium", "hall", "public_hall", "market", "well",
]);
/** Kinds whose open floor a citizen may appear on. */
export const SPAWN_KINDS = new Set([
  "avenue", "ring", "outer", "street", "alley", "road", "sidewalk", "plaza", "square", "court", "garden",
  "park", "mese", "upper", "arcade", "atrium", "hall", "public_hall", "market", "well",
]);
/** A kind or a name that marks a space as the MSR's, or private, whatever else is said of it. */
const NEVER_BY_WORD = /msr|checkpoint|tunnel|jail|precinct|commander|private|secret|hidden/i;
/** Kinds of room a citizen never walks into. */
const NEVER_BY_KIND = /^(room|door|shaft|cell|cells|office|ward|armou?ry|interrogation|booking|lockers?|sewer|cistern|water|quarter)$/i;

/** Where the files go: the bot folder beside each game folder (as waypoints.mjs), and AMXX's configs. */
const BOT_FOLDERS = [join(GAME_DIR, "rcbot"), join(TSM, "H9XASH", "rcbot")];
const CONFIG_FOLDERS = [join(GAME_DIR, "ts", "addons", "amxmodx", "configs"), join(TSM, "H9XASH", "ts", "addons", "amxmodx", "configs")];

// ---- the plan's spaces ------------------------------------------------------------------------------------

/** Whether a citizen may walk a space the plan calls public: a known kind, not the MSR's, not private. */
export function citizenMayWalk(space) {
  if (!space || typeof space.kind !== "string" || !ROAM_KINDS.has(space.kind)) return false;
  if (space.public === false || space.private === true || space.msr === true) return false;
  if (NEVER_BY_KIND.test(space.kind)) return false;
  return !NEVER_BY_WORD.test(space.kind) && !NEVER_BY_WORD.test(space.name ?? "");
}

const outlineOfRect = ([x0, y0, x1, y1]) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

/**
 * The places of a plan export ({ spaces: [{ name, kind, outline, floor, ceiling }], publicSpaces: [{ name,
 * kind, rect, floor, ceiling, connections, district? }] }): every space, `open` where it is public and a
 * citizen may walk it. A public space with no entry among the spaces is taken from its own rect.
 */
export function placesOfPlanJson(plan) {
  const publicByName = new Map((plan.publicSpaces ?? []).map((space) => [space.name, space]));
  const places = [];
  const seen = new Set();
  const add = (space, outline, pub) => {
    if (!outline?.length || !Number.isFinite(space.floor) || !Number.isFinite(space.ceiling)) return;
    places.push({
      name: String(space.name ?? ""),
      kind: space.kind ?? null,
      district: pub?.district ?? space.district ?? null,
      connections: pub?.connections ?? [],
      open: Boolean(pub) && citizenMayWalk({ ...space, ...pub }),
      outline,
      floor: space.floor,
      ceiling: space.ceiling,
    });
  };
  for (const space of plan.spaces ?? []) {
    seen.add(space.name);
    add(space, space.outline ?? (space.rect ? outlineOfRect(space.rect) : null), publicByName.get(space.name));
  }
  for (const space of plan.publicSpaces ?? []) if (!seen.has(space.name)) add(space, space.rect ? outlineOfRect(space.rect) : space.outline, space);
  return places;
}

/**
 * Names the district of a point: the plan's districtAt when its plan.mjs gives one (and the Mese and the
 * Well by height and place), else the eight compass points round the Well and the middle.
 */
export async function districtNamer() {
  let plan = {};
  try {
    plan = await import(pathToFileURL(join(HERE, "plan.mjs")).href);
  } catch {
    plan = {};
  }
  const well = Number.isFinite(plan.WELL) ? plan.WELL : 1664;
  const mese = Number.isFinite(plan.Z?.mese) ? plan.Z.mese : 1056;
  return (x, y, z) => {
    if (z >= mese - 64) return "mese";
    if (Math.abs(x) <= well && Math.abs(y) <= well) return "well";
    if (typeof plan.districtAt === "function") {
      const named = plan.districtAt(x, y);
      if (typeof named === "string" && named) return named;
    }
    const col = x < -well ? "w" : x > well ? "e" : "";
    const row = y < -well ? "s" : y > well ? "n" : "";
    return row + col || "middle";
  };
}

// ---- where a citizen may be, asked of a point ---------------------------------------------------------------

/** Whether (x, y) is inside a polygon, or on its edge. */
function insideOutline(outline, x, y) {
  let inside = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const [xi, yi] = outline[i];
    const [xj, yj] = outline[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  if (inside) return true;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const [xi, yi] = outline[i];
    const [xj, yj] = outline[j];
    const len = Math.hypot(xj - xi, yj - yi);
    if (len < 1e-9) continue;
    const t = Math.max(0, Math.min(1, ((x - xi) * (xj - xi) + (y - yi) * (yj - yi)) / (len * len)));
    if (Math.hypot(x - (xi + t * (xj - xi)), y - (yi + t * (yj - yi))) < 0.5) return true;
  }
  return false;
}

/**
 * The places in buckets of 256 across the map. It returns a function that gives the place a citizen with
 * its feet at `feet` stands in, or null: in no place, or in one a citizen may not walk (which wins over one
 * it may, where they overlap).
 */
function indexOf(places) {
  const BUCKET = 256;
  const buckets = new Map();
  places.forEach((place, number) => {
    const xs = place.outline.map((p) => p[0]);
    const ys = place.outline.map((p) => p[1]);
    place.min = [Math.min(...xs), Math.min(...ys)];
    place.max = [Math.max(...xs), Math.max(...ys)];
    for (let i = Math.floor(place.min[0] / BUCKET); i <= Math.floor(place.max[0] / BUCKET); i++)
      for (let j = Math.floor(place.min[1] / BUCKET); j <= Math.floor(place.max[1] / BUCKET); j++) {
        const key = `${i},${j}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(number);
      }
  });
  return (feet) => {
    const list = buckets.get(`${Math.floor(feet[0] / BUCKET)},${Math.floor(feet[1] / BUCKET)}`);
    if (!list) return null;
    let found = null;
    for (const number of list) {
      const place = places[number];
      if (feet[2] < place.floor - 2 || feet[2] > place.ceiling - 2) continue;
      if (feet[0] < place.min[0] || feet[0] > place.max[0] || feet[1] < place.min[1] || feet[1] > place.max[1]) continue;
      if (!insideOutline(place.outline, feet[0], feet[1])) continue;
      if (!place.open) return null;
      found ??= place;
    }
    return found;
  };
}

// ---- laying them ----------------------------------------------------------------------------------------------

/**
 * Where a player's feet come to at (x, y) from feet at `from`: the highest floor he can step onto (no more
 * than STEP up) that is no further down than DROP and not too steep to stand on; null where there is none.
 */
function floorFrom(space, x, y, from) {
  let best = null;
  let slant = 1;
  for (const [, top, lie] of space.blocked(x, y, "standing")) {
    if (top > from + STEP + 0.01) continue;
    if (best === null || top > best) {
      best = top;
      slant = lie ?? 1;
    }
  }
  if (best === null || best < from - DROP - 0.01) return null;
  if (best > from + 0.5 && slant < STEEP) return null;
  return best;
}

/** Whether a player walks the straight line from feet at `a` to feet at `b`, FINE units at a time. */
function walksLine(space, a, b) {
  let floor = floorFrom(space, a[0], a[1], a[2]);
  if (floor === null) return false;
  const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / FINE));
  for (let k = 1; k <= steps; k++) {
    const t = k / steps;
    floor = floorFrom(space, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, floor);
    if (floor === null) return false;
  }
  return Math.abs(floor - b[2]) <= STEP;
}

/** The largest set of waypoints that all reach one another along their paths (Kosaraju, without recursion). */
function largestReachingSet(count, pathsOf) {
  const order = [];
  const seen = new Uint8Array(count);
  for (let start = 0; start < count; start++) {
    if (seen[start]) continue;
    const stack = [[start, 0]];
    seen[start] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1];
      const out = pathsOf[top[0]];
      if (top[1] < out.length) {
        const next = out[top[1]++];
        if (!seen[next]) {
          seen[next] = 1;
          stack.push([next, 0]);
        }
      } else {
        order.push(top[0]);
        stack.pop();
      }
    }
  }
  const back = Array.from({ length: count }, () => []);
  pathsOf.forEach((out, from) => out.forEach((to) => back[to].push(from)));
  const group = new Int32Array(count).fill(-1);
  const sizes = [];
  for (let k = order.length - 1; k >= 0; k--) {
    const root = order[k];
    if (group[root] >= 0) continue;
    const g = sizes.length;
    let size = 0;
    const stack = [root];
    group[root] = g;
    while (stack.length) {
      const at = stack.pop();
      size++;
      for (const from of back[at])
        if (group[from] < 0) {
          group[from] = g;
          stack.push(from);
        }
    }
    sizes.push(size);
  }
  const biggest = sizes.length ? sizes.indexOf(Math.max(...sizes)) : -1;
  return { keep: (number) => group[number] === biggest, sets: sizes.length, size: sizes[biggest] ?? 0 };
}

/**
 * The roam waypoints of a built map (brush source, as city.mjs writes it) and its places (placesOfPlanJson):
 * { waypoints: [{ origin, flags, paths, kind, place }], spots: [{ district, origin }], facts, warnings,
 * places, spacing }. `districtOf(x, y, z)` names a spot's district where its place names none; `spacing` is
 * how far apart the walk lays waypoints on open floor (SPACING unless told).
 */
export function layRoamWaypoints(map, placeList, { districtOf = () => "city", spacing = SPACING } = {}) {
  const places = placeList.map((place) => ({ ...place }));
  const walkableAt = indexOf(places);
  const facts = [];
  const warnings = [];

  // where the walk starts: along the middle of every floor a citizen may appear on
  const from = [];
  for (const place of places) {
    if (!place.open || !SPAWN_KINDS.has(place.kind)) continue;
    const [x0, y0] = place.min;
    const [x1, y1] = place.max;
    const along = x1 - x0 >= y1 - y0;
    for (const t of [0.25, 0.5, 0.75]) {
      const point = along ? [x0 + (x1 - x0) * t, (y0 + y1) / 2, place.floor] : [(x0 + x1) / 2, y0 + (y1 - y0) * t, place.floor];
      if (walkableAt(point)) from.push(point);
    }
  }
  if (!from.length) throw new Error("no floor a citizen may stand on to start the walk from: the plan exports no public street, plaza, court, hall or Mese");

  const started = Date.now();
  // the walk covers private space too (the filter below takes it out), so it is given room for more than MOST
  const made = M.waypointsOf(map, { from, doors: "closed", cell: CELL, spacing, step: WALK_STEP, jump: false, crouch: false, drop: DROP, most: MOST * 2 });
  const space = made.reach.graph.space;
  facts.push(`walked from ${from.length} points on the citizens' floors, every door shut, in ${Math.round((Date.now() - started) / 1000)} s: ${made.waypoints.length} waypoints at a spacing of ${Math.round(made.spacing)}`);
  // SMAK counts against stock RCBot, whose table stops at +4096; the patched one reaches REACH_XY (CHANGE 8)
  for (const warning of made.warnings) if (!/over 4096 on an axis/.test(warning)) warnings.push(warning);

  // 2. feet where a citizen may walk, no ladders; paths whose whole line is such space
  const NOT_ROAM = M.RCW_FLAGS.LADDER | M.RCW_FLAGS.JUMP | M.RCW_FLAGS.CROUCH | M.RCW_FLAGS.LIFT | M.RCW_FLAGS.TELEPORT;
  const feetOf = (waypoint) => [waypoint.origin[0], waypoint.origin[1], waypoint.origin[2] - FEET];
  const placeOfWaypoint = made.waypoints.map((waypoint) => (waypoint.flags & NOT_ROAM || feetOf(waypoint)[2] < LOWEST_FEET ? null : walkableAt(feetOf(waypoint))));
  // the places a line passes through, in order; null when it leaves the citizens' space
  const placesAlong = (a, b) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / SAMPLE));
    const passed = [];
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      const place = point[2] < LOWEST_FEET ? null : walkableAt(point);
      if (!place) return null;
      if (passed[passed.length - 1] !== place) passed.push(place);
    }
    return passed;
  };
  const joined = (p, q) => p === q || p.connections?.includes(q.name) || q.connections?.includes(p.name);
  let pathsCut = 0;
  let pathsUnwalked = 0;
  const unlisted = new Set();
  const pathsOf = made.waypoints.map((waypoint, number) => {
    if (!placeOfWaypoint[number]) return [];
    return waypoint.paths.filter((to, k) => {
      const why = waypoint.ways?.[k] ?? "walk";
      if (!placeOfWaypoint[to] || why === "ladder" || why === "jump") return false;
      const passed = placesAlong(feetOf(waypoint), feetOf(made.waypoints[to]));
      if (!passed) {
        pathsCut++;
        return false;
      }
      if (!walksLine(space, feetOf(waypoint), feetOf(made.waypoints[to]))) {
        pathsUnwalked++;
        return false;
      }
      for (let k2 = 1; k2 < passed.length; k2++)
        if (!joined(passed[k2 - 1], passed[k2])) unlisted.add([passed[k2 - 1].name, passed[k2].name].sort().join(" / "));
      return true;
    });
  });
  const walkable = placeOfWaypoint.filter(Boolean).length;
  facts.push(`${made.waypoints.length - walkable} waypoints left out (in no space a citizen may walk, or a ladder); of the paths between the rest, ${pathsCut} cut where their line left that space and ${pathsUnwalked} where a player could not walk it (a step over ${STEP} or a drop over ${DROP} on the way)`);
  if (unlisted.size) facts.push(`${unlisted.size} pairs of spaces a path walks between that the plan does not list as connected (kept: no private space lies between them): ${[...unlisted].slice(0, 6).join("; ")}${unlisted.size > 6 ? "; ..." : ""}`);

  // 3. the largest set that all reach one another
  const reaching = largestReachingSet(made.waypoints.length, pathsOf);
  const kept = [];
  const renumber = new Map();
  made.waypoints.forEach((waypoint, number) => {
    if (!placeOfWaypoint[number] || !reaching.keep(number)) return;
    renumber.set(number, kept.length);
    kept.push(number);
  });
  facts.push(`${kept.length} kept: the largest set that all reach one another (${walkable - kept.length} more in smaller sets or alone left out)`);
  const leftOutKinds = {};
  made.waypoints.forEach((waypoint, number) => {
    if (placeOfWaypoint[number] && !renumber.has(number)) leftOutKinds[placeOfWaypoint[number].kind] = (leftOutKinds[placeOfWaypoint[number].kind] ?? 0) + 1;
  });
  if (Object.keys(leftOutKinds).length) facts.push(`left out by kind of space: ${Object.entries(leftOutKinds).map(([kind, n]) => `${kind} ${n}`).join(", ")}`);

  const waypoints = kept.map((number) => {
    const waypoint = made.waypoints[number];
    return {
      origin: waypoint.origin.map((value) => Math.round(value * 10) / 10),
      flags: waypoint.flags & ~NOT_ROAM,
      paths: pathsOf[number].filter((to) => renumber.has(to)).map((to) => renumber.get(to)),
      kind: waypoint.kind,
      place: placeOfWaypoint[number],
    };
  });

  // 5. the spots: open floor of a space a citizen may appear in, on that space's own floor
  const SPOT_KINDS = new Set(["floor", "start", "corner", "near"]);
  const spots = waypoints
    .filter((waypoint) => SPOT_KINDS.has(waypoint.kind) && SPAWN_KINDS.has(waypoint.place.kind) && waypoint.origin[2] - FEET - waypoint.place.floor <= SPOT_GROUND)
    .map((waypoint) => ({
      district: String(waypoint.place.district ?? districtOf(waypoint.origin[0], waypoint.origin[1], waypoint.origin[2] - FEET)).replace(/[^A-Za-z0-9_-]+/g, "_"),
      origin: waypoint.origin,
    }));

  return { waypoints, spots, facts, warnings, places, spacing: made.spacing };
}

/** The checks the bot's limits make of a set of waypoints: a sentence each, none when they pass. */
function problemsOf(waypoints) {
  const problems = [];
  if (waypoints.length > MOST) problems.push(`${waypoints.length} waypoints, over the ${MOST} the patched RCBot holds`);
  if (waypoints.length < 2) problems.push(`${waypoints.length} waypoints: a citizen has nowhere to walk`);
  const outside = waypoints.findIndex((w) => Math.abs(w.origin[0]) > REACH_XY || Math.abs(w.origin[1]) > REACH_XY || Math.abs(w.origin[2]) > REACH_Z);
  if (outside >= 0) problems.push(`waypoint ${outside} at ${waypoints[outside].origin.join(" ")} is past what RCBot's waypoint table reaches`);
  return problems;
}

/** The .rcw, in the layout of SMAK's writeRcw (smak src/maps/rcbot.mjs), without its stock 1024 cap. */
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

/** The citizens' spots, as tsrp_roambots.sma reads them. */
function spotsFileOf(spots, mapName) {
  const lines = [
    `// tsrp_roamspots_${mapName}.cfg -- where tsrp_roambots.sma puts a citizen who has just spawned.`,
    "// Written by export-map\\h9_tsrp_newbyzantium\\roamwaypoints.mjs with the map's roam waypoints: do not edit.",
    "// roamspot <district> <x> <y> <z>   (a standing player's origin)",
  ];
  for (const spot of spots) lines.push(`roamspot ${spot.district} ${spot.origin.map((v) => Math.round(v)).join(" ")}`);
  return `${lines.join("\r\n")}\r\n`;
}

/**
 * A plan of them from above, to look at: spaces a citizen walks grey, the rest dark red, paths green, a
 * waypoint white, a spot yellow. Higher floors are drawn over lower ones.
 */
function pictureOf(waypoints, spots, places) {
  const min = [Infinity, Infinity];
  const max = [-Infinity, -Infinity];
  for (const place of places)
    for (let a = 0; a < 2; a++) {
      min[a] = Math.min(min[a], place.min[a]);
      max[a] = Math.max(max[a], place.max[a]);
    }
  const width = 1600;
  const scale = width / (max[0] - min[0]);
  const height = Math.max(1, Math.ceil((max[1] - min[1]) * scale));
  const rgba = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) rgba.set([18, 18, 22, 255], p * 4);
  const px = (x, y) => [Math.round((x - min[0]) * scale), Math.round((max[1] - y) * scale)];
  const dot = (x, y, colour) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    rgba.set(colour, (y * width + x) * 4);
  };
  const line = (a, b, colour) => {
    let [x0, y0] = a;
    const [x1, y1] = b;
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (let guard = 0; guard < 10000; guard++) {
      dot(x0, y0, colour);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  };
  for (const place of [...places].sort((a, b) => a.floor - b.floor)) {
    const colour = place.open ? [70, 70, 78, 255] : [90, 22, 22, 255];
    place.outline.forEach((point, k) => line(px(...point), px(...place.outline[(k + 1) % place.outline.length]), colour));
  }
  const order = waypoints.map((w, n) => n).sort((a, b) => waypoints[a].origin[2] - waypoints[b].origin[2]);
  for (const n of order)
    for (const to of waypoints[n].paths) line(px(waypoints[n].origin[0], waypoints[n].origin[1]), px(waypoints[to].origin[0], waypoints[to].origin[1]), [60, 200, 60, 255]);
  for (const n of order) {
    const [x, y] = px(waypoints[n].origin[0], waypoints[n].origin[1]);
    for (let d = -1; d <= 1; d++) {
      dot(x + d, y, [235, 235, 235, 255]);
      dot(x, y + d, [235, 235, 235, 255]);
    }
  }
  for (const spot of spots) {
    const [x, y] = px(spot.origin[0], spot.origin[1]);
    dot(x, y, [255, 210, 40, 255]);
  }
  return K.png(width, height, rgba);
}

/** Copies a file into each folder, keeping what was there under TSM\backups first. */
/**
 * Whether a bot folder's RCBot is the roam build (rcbot-patch CHANGE 8, which reads tsrp_roambots_active). Only that
 * build keeps waypoints past +/-4096. Any other RCBot drops much of this map's set, and, finding no visibility file,
 * traces the whole visibility table at map load: minutes in which a listen server is frozen.
 */
function roamBuildIn(bot) {
  const dll = join(bot, "dlls", "rcbot_mm.dll");
  return existsSync(dll) && readFileSync(dll).includes("tsrp_roambots_active");
}

/** Takes a waypoint file out of a bot folder whose RCBot is not the roam build, keeping a copy in backups. */
function holdBack(folder, file) {
  const at = join(folder, file);
  if (!existsSync(at)) {
    console.log(`  held back ${at}: that folder's RCBot is not the roam build`);
    return;
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "_").slice(0, 15);
  const keep = join(TSM, "backups", `roamwaypoints-held-${stamp}`, folder.replace(/[:\\/]+/g, "_"));
  mkdirSync(keep, { recursive: true });
  copyFileSync(at, join(keep, file));
  unlinkSync(at);
  console.log(`  removed   ${at}: that folder's RCBot is not the roam build (kept in ${keep})`);
}

function deployTo(file, folders, keepAs) {
  for (const folder of folders) {
    const to = join(folder, keepAs);
    if (existsSync(to)) {
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "_").slice(0, 15);
      const keep = join(TSM, "backups", `roamwaypoints-${stamp}`, folder.replace(/[:\\/]+/g, "_"));
      mkdirSync(keep, { recursive: true });
      copyFileSync(to, join(keep, keepAs));
    }
    mkdirSync(folder, { recursive: true });
    copyFileSync(file, to);
    console.log(`  deployed  ${to}`);
  }
}

/**
 * Checks what layRoamWaypoints laid, writes <name>.rcw (read back first), tsrp_roamspots_<name>.cfg and a
 * picture and summary of them into `out`, and copies the two files into place when `deploy`.
 */
export function writeRoamFiles(laid, { name = NAME, out = OUT, deploy = false, map = null, dryRun = false } = {}) {
  const problems = problemsOf(laid.waypoints);
  const summary = {
    map: name,
    spacing: Math.round(laid.spacing),
    problems,
    facts: laid.facts,
    waypoints: laid.waypoints.length,
    paths: laid.waypoints.reduce((sum, w) => sum + w.paths.length, 0),
    spots: laid.spots.length,
    byKind: {},
    spotsByDistrict: {},
  };
  for (const w of laid.waypoints) summary.byKind[w.place.kind] = (summary.byKind[w.place.kind] ?? 0) + 1;
  for (const s of laid.spots) summary.spotsByDistrict[s.district] = (summary.spotsByDistrict[s.district] ?? 0) + 1;
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${name}_roamwaypoints.json`), JSON.stringify({ ...summary, list: laid.waypoints.map((w) => ({ origin: w.origin, flags: w.flags, paths: w.paths, kind: w.kind, space: w.place.name })) }));
  writeFileSync(join(out, `${name}_roamwaypoints.png`), pictureOf(laid.waypoints, laid.spots, laid.places));
  if (problems.length) throw new Error(`the roam waypoints fail ${problems.length} check(s):\n  ${problems.join("\n  ")}`);

  const bytes = rcwOf(laid.waypoints, name);
  const back = M.readRcw(bytes);
  if (back.waypoints.length !== laid.waypoints.length || back.mapName !== name || back.fileFlags !== M.RCW_READ_VISIBILITY)
    throw new Error("the .rcw does not read back as written");
  back.waypoints.forEach((waypoint, index) => {
    if (waypoint.paths.join() !== laid.waypoints[index].paths.join() || waypoint.flags !== (laid.waypoints[index].flags | 0))
      throw new Error(`waypoint ${index} does not read back as written`);
  });
  const rcw = join(out, `${name}.rcw`);
  const rcv2 = join(out, `${name}.rcv2`);
  if (!map) throw new Error("no map to work the visibility table out against: the .rcw is not written without its .rcv2");
  const vis = writeWithVisibility({ rcw: bytes, origins: laid.waypoints.map((w) => w.origin), map, rcwFile: rcw, rcv2File: rcv2, job: `roam waypoints of ${name} (RCBot visibility table)` });
  const spotsName = `tsrp_roamspots_${name}.cfg`;
  const spotsFile = join(out, spotsName);
  writeFileSync(spotsFile, spotsFileOf(laid.spots, name));

  console.log(`     ${summary.waypoints} waypoints, ${summary.paths} paths, ${summary.spots} spots`);
  console.log(`     by kind of space: ${Object.entries(summary.byKind).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  console.log(`     spots by district: ${Object.entries(summary.spotsByDistrict).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  console.log(`  wrote ${rcw} (${bytes.length} bytes, read back whole), its .rcv2 (${vis.rcv2Bytes.length} bytes, ${vis.seen} pairs seen, worked out in ${vis.seconds} s, read back), ${spotsFile}, and ${name}_roamwaypoints.png/.json`);

  if (deploy) {
    for (const bot of BOT_FOLDERS) {
      const folder = join(bot, "waypoints", "ts");
      const refused = pairReady(rcw, rcv2);
      const roam = roamBuildIn(bot);
      if (dryRun)
        console.log(`  dry run: ${bot}: ${!roam ? "held back, its RCBot is not the roam build" : refused.length ? `refused (${refused.join("; ")})` : "would get the .rcv2 and then the .rcw"}`);
      else if (roam && !refused.length) {
        deployTo(rcv2, [join(bot, "visibility", "ts")], `${name}.rcv2`);
        deployTo(rcw, [folder], `${name}.rcw`);
      } else holdBack(folder, `${name}.rcw`);
    }
    if (dryRun) console.log(`  dry run: ${spotsName} would go to ${CONFIG_FOLDERS.join(" and ")}`);
    else deployTo(spotsFile, CONFIG_FOLDERS, spotsName);
  }
  return summary;
}

/** Lays, checks, writes and (when asked) deploys the roam waypoints of out\<name>.map and its .plan.json. */
export async function main({ name = NAME, deploy = false, dryRun = false } = {}) {
  const mapFile = join(OUT, `${name}.map`);
  const planFile = join(OUT, `${name}.plan.json`);
  if (!existsSync(mapFile)) throw new Error(`no ${mapFile}: run node city.mjs first`);
  if (!existsSync(planFile)) throw new Error(`no ${planFile}: the plan exports no public spaces, so a citizen has nowhere it may walk`);
  console.log(`\n  ${name}: roam waypoints for the citizens (tsrp_roambots)...`);
  const t0 = Date.now();
  const map = M.readMap(readFileSync(mapFile, "utf8"));
  const places = placesOfPlanJson(JSON.parse(readFileSync(planFile, "utf8")));
  const open = places.filter((place) => place.open);
  console.log(`     ${places.length} spaces in the plan, ${open.length} a citizen may walk (${[...new Set(open.map((p) => p.kind))].join(", ")})`);
  const districtOf = await districtNamer();
  // more than the bot holds: laid again, a quarter further apart each time
  let spacing = SPACING;
  let laid = layRoamWaypoints(map, places, { districtOf, spacing });
  for (let again = 0; again < 3 && laid.waypoints.length > MOST; again++) {
    console.log(`     ${laid.waypoints.length} waypoints at a spacing of ${Math.round(spacing)}, over the ${MOST} RCBot holds: laid again further apart`);
    spacing *= 1.25;
    laid = layRoamWaypoints(map, places, { districtOf, spacing });
  }
  for (const fact of laid.facts) console.log(`     ${fact}`);
  for (const warning of laid.warnings.slice(0, 12)) console.log(`     WARN  ${warning}`);
  const summary = writeRoamFiles(laid, { name, deploy, map, dryRun });
  console.log(`     (${Math.round((Date.now() - t0) / 1000)} s)`);
  return summary;
}

/**
 * city.mjs's step (ROAM WAYPOINTS there), once the .map and .plan.json are written: with --compile, --roam
 * or deploy (not --noroam), main() in a node process of its own. A failure is told and the build goes on:
 * the map does not need its citizens to compile.
 */
export function roamStep({ name = NAME, flags = [] } = {}) {
  if (flags.includes("--noroam")) return;
  if (!flags.includes("--compile") && !flags.includes("--roam") && !flags.includes("deploy")) {
    console.log("  roam waypoints: laid with --compile, --roam or deploy");
    return;
  }
  const run = spawnSync(process.execPath, ["--max-old-space-size=8192", "--stack-size=60000", fileURLToPath(import.meta.url), "--name", name, ...(flags.includes("deploy") ? ["deploy"] : [])], { stdio: "inherit" });
  if (run.status !== 0) console.log(`  ROAM WAYPOINTS FAILED (exit ${run.status}): the map builds on without new ones`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--name");
  try {
    await main({ name: at >= 0 ? args[at + 1] : NAME, deploy: args.includes("deploy"), dryRun: args.includes("--dry-run") });
  } catch (error) {
    console.error(`  roam waypoints: ${error.message}`);
    process.exit(1);
  }
}
