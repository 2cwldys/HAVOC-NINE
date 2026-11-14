// coverage.mjs -- how well a map's waypoints cover its objectives, measured as RCBot's objective play meets them
// (rcbot-patch README CHANGE 11, src\bot.cpp ObjAddRing / ObjAddUplink / ObjAddFlag / ObjFillRingWaypoints).
//
//   node coverage.mjs                         every objective map (the h9_as_, h9_up_ and h9_ctf_ maps)
//   node coverage.mjs h9_as_neuropolis ...    these maps
//   node coverage.mjs --rcw-dir D:\path       read <map>.rcw from this folder instead of the game's rcbot\waypoints\ts
//   node coverage.mjs --json out.json         also write the numbers
//
// One block a map, one row an objective:
//   ring   a capture point (Assault) or control zone (Uplink): the goal waypoints within 0.6 of its radius and +-72 of its
//          floor + 36 (the ones the bots walk to and stand on), the nearest of them, and the status
//   uplink the loose uplink: the waypoint a bot paths to (nearest, one in sight preferred, within 400) and how far the
//          last stretch is that it walks straight
//   pad    a flag pad: the same for the flag standing on it, and the guard ring (0.6 of 192) around it
// reach/back: "R" the goal waypoints are reached along the paths from the side's base spawns (tier 0) and the way back is
// there too; "r" only there; "b" only back; "-" neither. Spawns: the sides' spawn sets, by tier (a point's forward base).
//
// STATUS   OK        goal waypoints inside, enough of them, reached from both bases
//          THIN      reached, but fewer waypoints than a ring wants (so that bots spread)
//          OUTSIDE   none inside: the bots walk the last stretch straight from the nearest waypoint (it says how far)
//          NONE      no waypoint within 400: the bots are given no such post
//          UNREACHED the goal waypoints are not reached from a base (or no way back)
//          FAR       an item whose nearest waypoint is farther than the bots' straight walk or without a clear line
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  OBJ, WP_DIR, flat, dist3, isGoal, isDeleted, objNearest, ringWaypoints, reachFrom, readWaypoints, loadMap, makeWalker,
  objectiveMaps, objectivesOf, spawnsOf, FEET,
} from "./h9wp.mjs";

/** How many goal waypoints a ring of this hold distance wants, so that its bots spread (the planner sends up to 4). */
export const ringWant = (hold) => Math.max(3, Math.min(6, Math.round(hold / 40)));
/** An item or pad is covered when a waypoint within this across the floor sees it (the bot's own "here" range at a pad). */
export const ITEM_NEAR = 60;

/** One map's coverage: { map, mode, count, rows: [...], spawns: [...] }, from `rcwFile`. */
export function measureMap(map, rcwFile = join(WP_DIR, `${map}.rcw`)) {
  const bsp = loadMap(map);
  const obj = objectivesOf(map, bsp);
  const walker = makeWalker(bsp);
  const space = walker.space;
  const out = { map, mode: obj.mode, rcw: rcwFile, count: 0, rows: [], spawns: [], note: null };
  if (!existsSync(rcwFile)) {
    out.note = "no waypoint file";
    return out;
  }
  const file = readWaypoints(rcwFile);
  const wps = file.waypoints;
  out.count = wps.length;
  out.fileFlags = file.fileFlags;

  // the bots' own start: where each side's spawns are, and the waypoint a bot there makes for
  const spawns = spawnsOf(map);
  const groups = new Map();
  for (const s of spawns) {
    const key = `${s.side}/${s.tier}`;
    if (!groups.has(key)) groups.set(key, { side: s.side, tier: s.tier, n: 0, none: 0, starts: new Set(), flatNear: [] });
    const g = groups.get(key);
    g.n++;
    const near = objNearest(wps, s.at, space);
    if (!near) g.none++;
    else {
      g.starts.add(near.index);
      g.flatNear.push(near.dist);
    }
  }
  const baseStarts = (side) => [...(groups.get(`${side}/0`)?.starts ?? [])];
  const fwd = { 1: reachFrom(wps, baseStarts(1)), 2: reachFrom(wps, baseStarts(2)) };
  const bwd = { 1: reachFrom(wps, baseStarts(1), true), 2: reachFrom(wps, baseStarts(2), true) };
  const reachMark = (goals) => {
    const mark = (side) => {
      if (!goals.length) return "-";
      const f = goals.every((g) => fwd[side][g]);
      const b = goals.every((g) => bwd[side][g]);
      return f && b ? "R" : f ? "r" : b ? "b" : "-";
    };
    return mark(1) + mark(2);
  };

  for (const r of obj.rings) {
    const hold = r.r * OBJ.RING_SHARE;
    const ring = ringWaypoints(wps, [r.x, r.y], r.z, hold);
    const mark = [r.x, r.y, r.z + OBJ.WPT_HEIGHT];
    const row = { kind: "ring", label: r.label, at: [r.x, r.y, r.z], radius: r.r, hold, want: ringWant(hold), inside: ring.length };
    let goals = ring.map((g) => g.index);
    let nearest = null;
    if (!ring.length) {
      const near = objNearest(wps, mark, space);
      if (near && isGoal(wps[near.index])) {
        goals = [near.index];
        nearest = near;
      }
    } else nearest = { index: ring[0].index, dist: dist3(wps[ring[0].index].origin, mark) };
    // the nearest waypoint of any kind, for the picture
    let any = null;
    wps.forEach((w, i) => {
      const d = dist3(w.origin, mark);
      if (!isDeleted(w) && (any === null || d < any.dist)) any = { index: i, dist: d };
    });
    row.nearest = nearest ? { index: nearest.index, flat: flat(wps[nearest.index].origin, mark), dist: nearest.dist, sight: nearest.sight } : null;
    row.anyNearest = any ? { index: any.index, flat: flat(wps[any.index].origin, mark), dist: any.dist } : null;
    row.reach = reachMark(goals);
    if (!ring.length && nearest && goals.length) {
      const w = wps[goals[0]].origin;
      row.lastStretch = flat(w, mark);
      row.straightWalk = walker.walksLine([w[0], w[1], w[2] - FEET], [mark[0], mark[1], r.z]);
    }
    if (!goals.length) row.status = "NONE";
    else if (row.reach !== "RR") row.status = "UNREACHED";
    else if (!ring.length) row.status = "OUTSIDE";
    else if (ring.length < row.want) row.status = "THIN";
    else row.status = "OK";
    out.rows.push(row);
  }

  const itemRow = (kind, label, at, mark, extra = {}) => {
    const near = objNearest(wps, mark, space);
    const row = { kind, label, at, ...extra };
    row.nearest = near ? { index: near.index, flat: flat(wps[near.index].origin, mark), dist: near.dist, sight: near.sight } : null;
    row.reach = near ? reachMark([near.index]) : "--";
    if (near) {
      const w = wps[near.index].origin;
      row.lastStretch = flat(w, mark);
      row.straightWalk = walker.walksLine([w[0], w[1], w[2] - FEET], [mark[0], mark[1], at[2] - (kind === "uplink" ? 16 : 0)]);
    }
    if (!near) row.status = "NONE";
    else if (row.reach !== "RR") row.status = "UNREACHED";
    else if (row.nearest.flat > ITEM_NEAR || !row.nearest.sight || row.straightWalk === false) row.status = "FAR";
    else row.status = "OK";
    return row;
  };
  if (obj.uplink) {
    const u = obj.uplink;
    out.rows.push(itemRow("uplink", "UPLINK", [u.x, u.y, u.z], [u.x, u.y, u.z + OBJ.WPT_HEIGHT]));
  }
  for (const p of obj.pads) {
    const row = itemRow("pad", `PAD${p.side}/FLAG${p.side}`, [p.x, p.y, p.z], [p.x, p.y, p.z + OBJ.WPT_HEIGHT]);
    const guard = ringWaypoints(wps, [p.x, p.y], p.z, OBJ.GUARD_RADIUS * OBJ.RING_SHARE);
    row.guard = guard.length;
    row.guardReach = reachMark(guard.map((g) => g.index));
    if (row.status === "OK" && guard.length < 2) row.status = "THIN";
    out.rows.push(row);
  }

  for (const g of [...groups.values()].sort((a, b) => a.tier - b.tier || a.side - b.side)) {
    const starts = [...g.starts];
    const f = reachFrom(wps, starts);
    const b = reachFrom(wps, starts, true);
    out.spawns.push({
      side: g.side, tier: g.tier, n: g.n, none: g.none, farthest: g.flatNear.length ? Math.max(...g.flatNear) : null,
      // how many waypoints the group's waypoints reach, and are reached from, of all the usable ones
      forward: f.reduce((a, v) => a + v, 0), back: b.reduce((a, v) => a + v, 0),
      starts: starts.length,
    });
  }
  return out;
}

const pad = (s, n) => String(s).padEnd(n);
const num = (v) => (v === null || v === undefined ? "-" : Math.round(v));

export function formatReport(r) {
  const o = [];
  o.push(`${r.map}  (${r.mode ?? "no mode"})  ${r.count} waypoints${r.note ? `  -- ${r.note}` : ""}`);
  o.push(
    `  ${pad("objective", 12)}${pad("floor at", 18)}${pad("R", 5)}${pad("hold", 5)}${pad("inside", 7)}${pad("want", 5)}` +
      `${pad("nearest wp (flat/3D)", 24)}${pad("reach", 6)}${pad("status", 10)}note`,
  );
  for (const x of r.rows) {
    const at = `${num(x.at[0])} ${num(x.at[1])} ${num(x.at[2])}`;
    const near = x.nearest ? `#${x.nearest.index} ${num(x.nearest.flat)}/${num(x.nearest.dist)}${x.nearest.sight === false ? " (no sight)" : ""}` : "none within 400";
    let note = "";
    if (x.kind === "ring" && x.status === "OUTSIDE") note = `last stretch ${num(x.lastStretch)} straight, walkable: ${x.straightWalk ? "yes" : "NO"}`;
    if (x.kind === "ring" && x.status === "NONE") note = `nearest of any kind ${num(x.anyNearest?.dist)}`;
    if (x.kind !== "ring" && x.nearest) note = `last stretch ${num(x.lastStretch)}, walkable: ${x.straightWalk ? "yes" : "NO"}`;
    if (x.kind === "pad") note += `; guard ring ${x.guard} (${x.guardReach})`;
    o.push(
      `  ${pad(x.label, 12)}${pad(at, 18)}${pad(x.radius ?? "", 5)}${pad(x.hold !== undefined ? num(x.hold) : "", 5)}` +
        `${pad(x.inside ?? "", 7)}${pad(x.want ?? "", 5)}${pad(near, 24)}${pad(x.reach, 6)}${pad(x.status, 10)}${note}`,
    );
  }
  for (const s of r.spawns) {
    o.push(
      `  spawns side ${s.side} tier ${s.tier}: ${s.n} spawns, ${s.none} with no waypoint within 400, farthest ${num(s.farthest)}, ` +
        `waypoints reached from them ${s.forward}, that reach them ${s.back}`,
    );
  }
  return o.join("\n");
}

// ---- the command line ----
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  let dir = WP_DIR;
  let json = null;
  const maps = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--rcw-dir") dir = args[++i];
    else if (args[i] === "--json") json = args[++i];
    else if (args[i] === "--all") continue;
    else maps.push(args[i]);
  }
  const names = maps.length ? maps : objectiveMaps();
  const all = [];
  for (const map of names) {
    const r = measureMap(map, join(dir, `${map}.rcw`));
    all.push(r);
    console.log(formatReport(r));
    console.log("");
  }
  if (json) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(json, JSON.stringify(all, null, 1));
  }
}
