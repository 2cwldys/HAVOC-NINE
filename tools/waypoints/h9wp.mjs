// h9wp.mjs -- what coverage.mjs and lay.mjs share: where the project's files are, the objectives of a map as the
// mode plugins read them, RCBot's waypoint file, RCBot's own tests of a waypoint (copied from rcbot-patch\src\bot.cpp,
// CHANGE 11), and a player's walk over a compiled map (SMAK's space, read only).
//
// Nothing here writes anywhere but the folder a caller names. SMAK is only read.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// ---- where things are (environment variables move them) ----------------------------------------------------
export const TSM = (process.env.H9_TSM ?? "D:/Downloads/TSM").replace(/\\/g, "/");
export const SMAK = (process.env.SMAK ?? `${TSM}/smak`).replace(/\\/g, "/");
export const MAPS_DIR = process.env.H9_MAPS ?? `${TSM}/H9XASH/ts/maps`;
export const CFG_DIR = process.env.H9_CFG ?? `${TSM}/H9XASH/ts/addons/amxmodx/configs`;
export const MAPCFG_DIR = process.env.H9_MAPCFG ?? `${TSM}/H9XASH/ts/mapconfigs`;
export const WP_DIR = process.env.H9_WAYPOINTS ?? `${TSM}/H9XASH/rcbot/waypoints/ts`;

const K = await import(pathToFileURL(`${SMAK}/src/index.mjs`).href);
export const M = K.maps;
export const FLAGS = M.RCW_FLAGS;

// ---- RCBot's numbers (rcbot-patch\src\bot.cpp, the OBJ_ constants, and waypoint.h) -------------------------------
export const OBJ = {
  RING_SHARE: 0.6, // a ring's waypoints lie within this share of its radius
  Z_RANGE: 72, // and within this of the ring's floor + WPT_HEIGHT
  WPT_HEIGHT: 36, // a waypoint is this far over the floor
  GUARD_RADIUS: 192, // a flag's guard ring (its waypoints within 0.6 of this)
  NEAR_RANGE: 400, // the nearest waypoint to a mark with none inside, at most this far
  HERE_SHARE: 0.6, // a bot is at a ring within this share of its radius
  STRAIGHT_FLAT: 160, // within this across the floor a bot walks straight to its mark
  STRAIGHT_HEIGHT: 64, // and within this of its height
  AT_GOAL: 96, // a bot is at its goal waypoint within this
  RING_WPTS: 12, // at most this many ring waypoints are kept
  PAD_RADIUS: 72, // tsm_cf_pad_radius
  UPLINK_PICKUP: 44, // ts_uplink.sma UPL_PICKUP
  FLAG_PICKUP: 48, // ts_ctf.sma CF_PICKUP
};
// the flags that keep a waypoint from being an objective's goal (ObjWaypointUsable)
const NOT_GOAL =
  FLAGS.DELETED | FLAGS.LADDER | FLAGS.LIFT | FLAGS.JUMP | FLAGS.CROUCH | FLAGS.TELEPORT | FLAGS.UNREACHABLE |
  FLAGS.AIMING | FLAGS.WAIT_FOR_LIFT | FLAGS.FLY | FLAGS.HUMAN_TOWER | FLAGS.OPENS_LATER | FLAGS.STUNT | FLAGS.PUSHABLE;
// what NearestWaypoint(.., bIsBot) never returns, besides deleted and unreachable
const NOT_FOR_BOT = FLAGS.JUMP | FLAGS.CROUCHJUMP | FLAGS.FLY;
export const MAX_WAYPOINTS = 4096; // rcbot-patch CHANGE 6

export const isDeleted = (w) => (w.flags & FLAGS.DELETED) !== 0 || (w.flags & FLAGS.UNREACHABLE) !== 0;
export const isGoal = (w) => (w.flags & NOT_GOAL) === 0;
const botMay = (w) => !isDeleted(w) && (w.flags & NOT_FOR_BOT) === 0;

export const flat = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// ---- configs -----------------------------------------------------------------------------------------------------
const lines = (file) =>
  existsSync(file) ? readFileSync(file, "latin1").split(/\r?\n/).map((l) => l.split("//")[0].trim()).filter(Boolean) : [];

/** The last value a cfg file sets a cvar to (a line `name value` or `name "value"`), or `fallback`. */
export function cvarOf(name, fallback, map) {
  let value = fallback;
  const files = [
    ...["ts_assault.cfg", "ts_uplink.cfg", "ts_ctf.cfg"].map((f) => join(CFG_DIR, f)),
    ...(map ? [join(MAPCFG_DIR, `${map}.cfg`)] : []),
  ];
  for (const file of files)
    for (const line of lines(file)) {
      const m = /^(\S+)\s+"?([^"\s]+)"?/.exec(line);
      if (m && m[1] === name) value = Number(m[2]);
    }
  return value;
}

const val = (entity, key) => entity.find((p) => p[0] === key)?.[1];
const numbers = (text) => (text ?? "").trim().split(/\s+/).map(Number);

/** A tsm_ entity of the map: a point's origin, or a brush's footprint (its box's middle at its floor, as wide as it is). */
function entityPlace(bsp, entity, defaultRadius) {
  const model = /^\*(\d+)$/.exec(val(entity, "model") ?? "");
  if (model && bsp.models[Number(model[1])]) {
    const b = bsp.models[Number(model[1])];
    const o = numbers(val(entity, "origin") ?? "0 0 0");
    const min = b.mins.map((v, i) => v + o[i]);
    const max = b.maxs.map((v, i) => v + o[i]);
    const r = Math.max((max[0] - min[0]) / 2, (max[1] - min[1]) / 2);
    return { x: (min[0] + max[0]) / 2, y: (min[1] + max[1]) / 2, z: min[2], r };
  }
  const o = numbers(val(entity, "origin"));
  return { x: o[0], y: o[1], z: o[2], r: defaultRadius };
}

export function mapBspFile(map) {
  return join(MAPS_DIR, `${map}.bsp`);
}

/** The maps with objectives of a mode plugin: the h9_as_, h9_up_ and h9_ctf_ maps, and any with its own mode config. */
export function objectiveMaps() {
  const names = new Set();
  for (const f of readdirSync(MAPS_DIR)) {
    const m = /^(h9_(?:as|up|ctf)_.+)\.bsp$/.exec(f);
    if (m) names.add(m[1]);
  }
  for (const f of readdirSync(CFG_DIR)) {
    const m = /^tsm_(?:assault|uplink|ctf)_(.+)\.cfg$/.exec(f);
    if (m && existsSync(mapBspFile(m[1]))) names.add(m[1]);
  }
  return [...names].sort();
}

/** The mode a map is played in, as the plugins claim it: the name's prefix first, then which config the map has. */
export function modeOf(map, bsp) {
  if (/^h9_as_/.test(map)) return "assault";
  if (/^h9_ctf_/.test(map)) return "ctf";
  if (/^h9_up_/.test(map)) return "uplink";
  if (existsSync(join(CFG_DIR, `tsm_assault_${map}.cfg`))) return "assault";
  if (existsSync(join(CFG_DIR, `tsm_ctf_${map}.cfg`))) return "ctf";
  if (existsSync(join(CFG_DIR, `tsm_uplink_${map}.cfg`))) return "uplink";
  const has = (re) => bsp.entities.some((e) => re.test(val(e, "targetname") ?? ""));
  if (has(/^tsm_as_\d+$/)) return "assault";
  if (has(/^tsm_flag_[12]$/)) return "ctf";
  if (has(/^tsm_cap_\d+$/)) return "uplink";
  return null;
}

/**
 * The objectives of a map, from the data the mode plugin itself reads: the map's config (tsm_assault_<map>.cfg,
 * tsm_uplink_<map>.cfg, tsm_ctf_<map>.cfg), and for what the config does not place, the map's own entities (tsm_as_N,
 * tsm_cap_N, tsm_uplink, tsm_flag_N). The config wins, as in scan_map of each plugin.
 *   { map, mode, rings: [{ label, number, x, y, z, r }], uplink: {x, y, z} | null, pads: [{ side, x, y, z }], padRadius }
 */
export function objectivesOf(map, bsp) {
  const mode = modeOf(map, bsp);
  const out = { map, mode, rings: [], uplink: null, pads: [], padRadius: cvarOf("tsm_cf_pad_radius", OBJ.PAD_RADIUS, map) };
  if (mode === "assault") {
    const R = cvarOf("tsm_as_radius", 384, map);
    const zones = new Map();
    for (const line of lines(join(CFG_DIR, `tsm_assault_${map}.cfg`))) {
      const t = line.split(/\s+/);
      if (t[0] === "tsm_as_zone" && t.length >= 5)
        zones.set(Number(t[1]), { x: +t[2], y: +t[3], z: +t[4], r: t[5] !== undefined ? +t[5] : R });
    }
    for (let n = 1; n <= 24; n++) {
      if (zones.has(n)) continue;
      const e = bsp.entities.find((x) => val(x, "targetname") === `tsm_as_${n}`);
      if (e) zones.set(n, entityPlace(bsp, e, R));
    }
    for (const [n, z] of [...zones].sort((a, b) => a[0] - b[0]))
      out.rings.push({ label: `AS${n}`, number: n, ...z, r: Math.max(z.r, 32) });
  } else if (mode === "uplink") {
    const R = cvarOf("tsm_cap_radius", 128, map);
    const zones = new Map();
    let home = null;
    for (const line of lines(join(CFG_DIR, `tsm_uplink_${map}.cfg`))) {
      const t = line.split(/\s+/);
      if (t[0] === "tsm_cap" && t.length >= 5) zones.set(Number(t[1]), { x: +t[2], y: +t[3], z: +t[4], r: t[5] !== undefined ? +t[5] : R });
      if (t[0] === "tsm_uplink_at" && t.length >= 4) home = { x: +t[1], y: +t[2], z: +t[3] };
    }
    for (let n = 1; n <= 9; n++) {
      if (zones.has(n)) continue;
      const e = bsp.entities.find((x) => val(x, "targetname") === `tsm_cap_${n}`);
      if (e) zones.set(n, entityPlace(bsp, e, R));
    }
    if (!home) {
      const e = bsp.entities.find((x) => val(x, "targetname") === "tsm_uplink");
      if (e) {
        const o = numbers(val(e, "origin"));
        home = { x: o[0], y: o[1], z: o[2] };
      }
    }
    for (const [n, z] of [...zones].sort((a, b) => a[0] - b[0])) out.rings.push({ label: `CAP${n}`, number: n, ...z, r: Math.max(z.r, 16) });
    out.uplink = home;
  } else if (mode === "ctf") {
    const pads = new Map();
    for (const line of lines(join(CFG_DIR, `tsm_ctf_${map}.cfg`))) {
      const t = line.split(/\s+/);
      if (t[0] === "tsm_cf_pad" && t.length >= 5) pads.set(Number(t[1]), { x: +t[2], y: +t[3], z: +t[4] });
    }
    for (const s of [1, 2]) {
      if (pads.has(s)) continue;
      const e = bsp.entities.find((x) => val(x, "targetname") === `tsm_flag_${s}`);
      if (e) {
        const o = numbers(val(e, "origin"));
        pads.set(s, { x: o[0], y: o[1], z: o[2] });
      }
    }
    for (const [s, p] of [...pads].sort((a, b) => a[0] - b[0])) out.pads.push({ side: s, ...p });
  }
  return out;
}

/** A map's spawn points: [{ side, tier, at: [x, y, z] }], z being a player's middle. */
export function spawnsOf(map) {
  const out = [];
  for (const line of lines(join(CFG_DIR, `tsm_spawns_${map}.cfg`))) {
    const t = line.split(/\s+/);
    if (t[0] === "tsm_spawn" && t.length >= 6) out.push({ side: Number(t[1]), tier: t[7] !== undefined ? Number(t[7]) : 0, at: [+t[2], +t[3], +t[4]] });
  }
  return out;
}

// ---- the waypoint file --------------------------------------------------------------------------------------------
/** A .rcw as { filetype, fileFlags, mapName, waypoints: [{ flags, origin, paths }] } (SMAK's reader, which refuses a damaged file). */
export function readWaypoints(file) {
  return M.readRcw(readFileSync(file));
}

/**
 * The bytes of a .rcw, in the bot's layout (rcbot-patch\src\waypoint.cpp, WaypointLoad/WaypointSave): a 52-byte header, the
 * 16-byte records, then each waypoint's path count and paths. SMAK's own writer stops at 1024 waypoints; the patched bot
 * holds MAX_WAYPOINTS (4096), and h9_as_lift has 1263.
 */
export function writeWaypoints({ filetype, fileFlags = 1, mapName, waypoints }) {
  if (waypoints.length > MAX_WAYPOINTS) throw new Error(`${waypoints.length} waypoints: the patched bot holds ${MAX_WAYPOINTS}`);
  if (Buffer.byteLength(mapName, "latin1") > 31) throw new Error("map name over 31 letters");
  let size = 52 + waypoints.length * 16;
  for (const w of waypoints) size += 2 + w.paths.length * 2;
  const data = Buffer.alloc(size);
  if (filetype) Buffer.from(filetype).copy(data, 0, 0, 8);
  else data.write("RCBot", 0, "latin1");
  data.writeInt32LE(4, 8);
  data.writeInt32LE(fileFlags, 12);
  data.writeInt32LE(waypoints.length, 16);
  data.write(mapName, 20, "latin1");
  let at = 52;
  for (const w of waypoints) {
    data.writeInt32LE(w.flags | 0, at);
    data.writeFloatLE(w.origin[0], at + 4);
    data.writeFloatLE(w.origin[1], at + 8);
    data.writeFloatLE(w.origin[2], at + 12);
    at += 16;
  }
  for (const w of waypoints) {
    data.writeInt16LE(w.paths.length, at);
    at += 2;
    for (const to of w.paths) {
      if (!Number.isInteger(to) || to < 0 || to >= waypoints.length) throw new Error(`a path to ${to}, not one of ${waypoints.length} waypoints`);
      data.writeInt16LE(to, at);
      at += 2;
    }
  }
  return data;
}

// ---- RCBot's own searches (the location table of waypoint.cpp, and the objective code of bot.cpp) ----------------
const bucketXY = (c) => Math.floor((c + 16384) / 256);
const bucketZ = (c) => Math.floor((c + 4096) / 256);

/**
 * CWaypointLocations::NearestWaypoint(origin, 400, -1, visible, false, bIsBot): only waypoints in the 3 x 3 x 3 buckets of 256
 * around the point count, never one farther than `range`; with `visible` one the point sees (a trace the world stops). A bot's
 * call skips jump, crouch-jump and fly waypoints. Returns { index, dist } or null.
 */
export function nearestWaypoint(wps, point, { range = OBJ.NEAR_RANGE, visible = true, space = null } = {}) {
  const bi = bucketXY(point[0]), bj = bucketXY(point[1]), bk = bucketZ(point[2]);
  let best = null;
  let bd = range;
  for (let i = 0; i < wps.length; i++) {
    const w = wps[i];
    if (!botMay(w)) continue;
    const o = w.origin;
    if (Math.abs(bucketXY(o[0]) - bi) > 1 || Math.abs(bucketXY(o[1]) - bj) > 1 || Math.abs(bucketZ(o[2]) - bk) > 1) continue;
    const d = dist3(o, point);
    if (d >= bd) continue;
    if (visible && space && !space.sees(point, o)) continue;
    best = i;
    bd = d;
  }
  return best === null ? null : { index: best, dist: bd };
}

/** ObjNearestWaypoint: one in line of sight if there is one, else any. `sight` says which it was. */
export function objNearest(wps, point, space) {
  const seen = nearestWaypoint(wps, point, { visible: true, space });
  if (seen) return { ...seen, sight: true };
  const any = nearestWaypoint(wps, point, { visible: false });
  return any ? { ...any, sight: false } : null;
}

/** ObjFillRingWaypoints: the goal waypoints within `hold` across the floor and 72 of floor + 36, nearest first, at most 12. */
export function ringWaypoints(wps, center, floorZ, hold) {
  const found = [];
  for (let i = 0; i < wps.length; i++) {
    const w = wps[i];
    if (isDeleted(w) || !isGoal(w)) continue;
    const f = flat(w.origin, center);
    if (f > hold || Math.abs(w.origin[2] - (floorZ + OBJ.WPT_HEIGHT)) > OBJ.Z_RANGE) continue;
    found.push({ index: i, flat: f });
  }
  found.sort((a, b) => a.flat - b.flat);
  return found.slice(0, OBJ.RING_WPTS);
}

// ---- the graph ----------------------------------------------------------------------------------------------------
/** The indexes a directed walk along the paths from `starts` reaches (deleted and unreachable ones never). */
export function reachFrom(wps, starts, reverse = false) {
  const n = wps.length;
  let adj = null;
  if (reverse) {
    adj = Array.from({ length: n }, () => []);
    wps.forEach((w, i) => w.paths.forEach((p) => p >= 0 && p < n && adj[p].push(i)));
  }
  const seen = new Uint8Array(n);
  const queue = [];
  for (const s of starts) if (s !== null && s !== undefined && !isDeleted(wps[s]) && !seen[s]) { seen[s] = 1; queue.push(s); }
  for (let q = 0; q < queue.length; q++) {
    const u = queue[q];
    for (const v of reverse ? adj[u] : wps[u].paths) {
      if (v < 0 || v >= n || seen[v] || isDeleted(wps[v])) continue;
      seen[v] = 1;
      queue.push(v);
    }
  }
  return seen;
}

// ---- a player's walk over the compiled map ------------------------------------------------------------------------
export const STEP = 18; // the highest step up a player walks (the engine's stepsize)
export const DROP = 18; // the highest step down a new path takes: a path is walked both ways, so none falls further
export const STEEP = 0.7; // a floor steeper than this (the z of its normal) is slid down, not walked
export const FINE = 2; // a line is walked this many units at a time
export const FEET = 36; // a standing player's origin over his feet

export function loadMap(map) {
  const bsp = M.readBsp(readFileSync(mapBspFile(map)));
  return bsp;
}

/**
 * The walk of a map: SMAK's space of the compiled map, every door a wall where it stands (a bot opens none on purpose), and
 * a breakable a wall. `doors: "open"` for the check of where a door would let a body through.
 */
export function makeWalker(bsp, { doors = "closed", shut = [] } = {}) {
  const space = M.spaceOf(bsp, { doors, shut });
  const cache = new Map();
  const column = (x, y) => {
    const key = `${Math.round(x * 4)},${Math.round(y * 4)}`;
    let v = cache.get(key);
    if (!v) {
      v = space.blocked(x, y, "standing");
      if (cache.size > 400000) cache.clear();
      cache.set(key, v);
    }
    return v;
  };
  /** Where a player's feet come to at (x, y) from feet at `from`: the highest floor no more than `up` above and `down` below. */
  const floorFrom = (x, y, from, up = STEP, down = DROP) => {
    let best = null;
    let slant = 1;
    for (const [, top, lie] of column(x, y)) {
      if (top > from + up + 0.01) continue;
      if (best === null || top > best) {
        best = top;
        slant = lie ?? 1;
      }
    }
    if (best === null || best < from - down - 0.01) return null;
    if (slant < STEEP) return null;
    return best;
  };
  /** The floors a player may stand on at (x, y): the tops of the stretches his feet are blocked in. */
  const floorsAt = (x, y) => column(x, y).filter((s) => (s[2] ?? 1) >= STEEP).map((s) => s[1]);
  /** Whether a player walks the straight line from feet a to feet b, FINE units at a time, never up or down more than a step. */
  const walksLine = (a, b) => {
    let floor = floorFrom(a[0], a[1], a[2]);
    if (floor === null) return false;
    const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / FINE));
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      floor = floorFrom(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, floor);
      if (floor === null) return false;
    }
    return Math.abs(floor - b[2]) <= STEP;
  };
  const DIRS = [[1, 0], [0.7071, 0.7071], [0, 1], [-0.7071, 0.7071], [-1, 0], [-0.7071, -0.7071], [0, -1], [0.7071, -0.7071]];
  /** How much room a standing player has about feet at (x, y, f): the least distance (to 40, steps of 8) at which a step is not walkable. */
  const clearance = (x, y, f) => {
    let least = 40;
    for (const [dx, dy] of DIRS)
      for (let d = 8; d <= least; d += 8) {
        const g = floorFrom(x + dx * d, y + dy * d, f);
        if (g === null || Math.abs(g - f) > STEP) {
          least = d - 8;
          break;
        }
      }
    return least;
  };
  /**
   * Whether the line has room (at least `room`) at every `every` units along it. Near a waypoint that stands in less room (a
   * doorway, the foot of a stair) the line is asked for no more than that and as much again as it has gone from it.
   */
  const lineRoom = (a, b, room = 16, every = 16) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.ceil(len / every));
    const c0 = clearance(a[0], a[1], a[2]);
    const c1 = clearance(b[0], b[1], b[2]);
    let floor = a[2];
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const x = a[0] + (b[0] - a[0]) * t;
      const y = a[1] + (b[1] - a[1]) * t;
      const f = floorFrom(x, y, floor, STEP, 40);
      if (f === null) return false;
      floor = f;
      const s = t * len;
      if (clearance(x, y, f) < Math.min(room, c0 + s, c1 + (len - s))) return false;
    }
    return true;
  };
  // places a bot must not be sent through: moving platforms and belts, things that hurt or push, water
  const HAZARD = /^(func_conveyor|trigger_hurt|trigger_push|func_rotating|func_pendulum|func_train|func_plat|func_platrot|func_tracktrain|func_water|trigger_teleport|trigger_changelevel)$/;
  const hazards = space.areas.filter((a) => HAZARD.test(a.classname));
  // a floor that gives way: the top of a breakable or a pushable (a waypoint there falls with it)
  const gives = space.areas.filter((a) => a.gives && a.solid);
  /** Why feet at (x, y, f) are no place for a waypoint, or null: in a hazard's box (grown 20 across, 8 up and down), on the top of something that breaks, or in water deeper than the ankles. */
  const unsafe = (x, y, f) => {
    for (const h of hazards)
      if (x > h.min[0] - 20 && x < h.max[0] + 20 && y > h.min[1] - 20 && y < h.max[1] + 20 && f + 72 > h.min[2] - 8 && f < h.max[2] + 8) return "hazard";
    // water up to the ankles is walked (the engine's waterlevel 1); water over the player's middle is swum
    for (const g of gives)
      if (x > g.min[0] - 8 && x < g.max[0] + 8 && y > g.min[1] - 8 && y < g.max[1] + 8 && Math.abs(f - g.max[2]) < 4) return "on something that breaks";
    for (const [from, to, kind] of space.cut(x, y)) if (kind === "liquid" && to > f + 28 && from < f + 72) return "liquid";
    return null;
  };
  /** Whether any place along the line (every 16 units) is unsafe. */
  const lineUnsafe = (a, b, every = 16) => {
    const len = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / every));
    let floor = a[2];
    for (let k = 0; k <= len; k++) {
      const t = k / len;
      const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
      const f = floorFrom(x, y, floor, STEP, 40);
      if (f === null) return "no floor";
      floor = f;
      const u = unsafe(x, y, f);
      if (u) return u;
    }
    return null;
  };
  return { space, floorFrom, floorsAt, walksLine, clearance, lineRoom, column, unsafe, lineUnsafe };
}
