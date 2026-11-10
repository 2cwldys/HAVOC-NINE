// check.mjs -- reads a .rcw that lay.mjs wrote beside the original and checks it on its own, without lay.mjs's state:
//
//   node check.mjs <map> <new.rcw> [--orig <original.rcw>] [--allow-doors] [--reach]
//
//   1. the file is one RCBot reads (SMAK's strict reader), is the map's, and has no more waypoints than the patched bot holds
//   2. nothing old changed: the first waypoints are the original ones (flags, origin), and each keeps its own paths in
//      order, with paths to NEW waypoints only after them
//   3. every new waypoint has flags 0, stands on a floor of the map (feet within 0.5 of one), is not in a hazard, in
//      water over the ankles or on something that breaks, and has no other waypoint within 20 units
//   --reach  and, as a second opinion that shares no code with lay.mjs, SMAK's own walk of the map (reachOf: steps, drops, jumps, ladders,
//            every door but the engineer doors open) from the bots' spawns: each new waypoint's floor must be walked or jumped to by it
//            (a warning, not a failure, for a waypoint in a room only a door the walk keeps shut opens)
//   4. every path with a new end: no duplicate, no self path, a way back, and the line walked both ways by a player (steps
//      of 18), with 12 units of room beside it (less near an end that stands in less), clear to a bot's eye, through no
//      door (doors shut, as the map starts; --allow-doors lets the paths that lay.mjs --through-doors made cross one)
// It prints one line a failure and ends with "ok" or "FAILED"; the exit code is 1 on a failure.
import { pathToFileURL } from "node:url";
import { M, FEET, MAX_WAYPOINTS, WP_DIR, flat, loadMap, makeWalker, objNearest, readWaypoints, reachFrom, spawnsOf } from "./h9wp.mjs";

export function checkMap(map, newFile, origFile = `${WP_DIR}/${map}.rcw`, { allowDoors = false, reach = false } = {}) {
  const warnings = [];
  const problems = [];
  const fail = (m) => problems.push(m);
  const bsp = loadMap(map);
  const walker = makeWalker(bsp);
  const opened = allowDoors ? makeWalker(bsp, { doors: "open" }) : null;
  const doorEdges = [];
  const nw = readWaypoints(newFile);
  const old = readWaypoints(origFile);
  const w = nw.waypoints;
  const o = old.waypoints;
  if (nw.mapName !== map) fail(`header map name is "${nw.mapName}", not "${map}"`);
  if (w.length > MAX_WAYPOINTS) fail(`${w.length} waypoints, over the ${MAX_WAYPOINTS} the patched bot holds`);
  if (w.length < o.length) fail(`fewer waypoints than the original (${w.length} < ${o.length})`);
  const n = Math.min(o.length, w.length);
  for (let i = 0; i < n; i++) {
    if (w[i].flags !== o[i].flags || w[i].origin.some((v, k) => v !== o[i].origin[k])) fail(`waypoint ${i} changed (flags or origin)`);
    const kept = o[i].paths;
    if (kept.some((p, k) => w[i].paths[k] !== p)) fail(`waypoint ${i}: its old paths are not the start of its list`);
    for (const p of w[i].paths.slice(kept.length)) if (p < o.length) fail(`waypoint ${i}: a new path to the old waypoint ${p}`);
  }
  const feet = (i) => [w[i].origin[0], w[i].origin[1], w[i].origin[2] - FEET];
  for (let i = o.length; i < w.length; i++) {
    if (w[i].flags !== 0) fail(`new waypoint ${i} has flags ${w[i].flags}`);
    const f = feet(i);
    const onFloor = (wk) => wk.floorsAt(f[0], f[1]).some((t) => Math.abs(t - f[2]) < 0.5);
    if (!onFloor(walker) && !(opened && onFloor(opened))) fail(`new waypoint ${i} at ${w[i].origin.map(Math.round)} does not stand on a floor`);
    const bad = walker.unsafe(f[0], f[1], f[2]);
    if (bad) fail(`new waypoint ${i}: ${bad}`);
    for (let j = 0; j < w.length; j++) if (j !== i && flat(w[j].origin, w[i].origin) < 20 && Math.abs(w[j].origin[2] - w[i].origin[2]) < 40 && (j < i || j < o.length)) fail(`new waypoint ${i} is within 20 of waypoint ${j}`);
  }
  let checked = 0;
  for (let a = 0; a < w.length; a++) {
    if (new Set(w[a].paths).size !== w[a].paths.length) fail(`waypoint ${a} lists a path twice`);
    for (const b of w[a].paths) {
      if (b === a) fail(`waypoint ${a} has a path to itself`);
      if (b < 0 || b >= w.length) { fail(`waypoint ${a}: a path to ${b}, which is not a waypoint`); continue; }
      if (a < o.length && b < o.length) continue;
      checked++;
      if (!w[b].paths.includes(a)) fail(`path ${a} -> ${b} has no way back`);
      if (a > b) continue;
      const fa = feet(a), fb = feet(b);
      let wk = walker;
      if (!walker.walksLine(fa, fb) || !walker.walksLine(fb, fa)) {
        if (!allowDoors) { fail(`path ${a} <-> ${b} is not a line a player walks both ways`); continue; }
        if (!opened.walksLine(fa, fb) || !opened.walksLine(fb, fa)) { fail(`path ${a} <-> ${b} is not walked even with every door open`); continue; }
        wk = opened;
        doorEdges.push(`${a} <-> ${b}`);
      }
      if (!wk.lineRoom(fa, fb, 12)) fail(`path ${a} <-> ${b} has no room beside it`);
      if (!wk.space.sees(w[a].origin, w[b].origin) || !wk.space.sees(w[b].origin, w[a].origin)) fail(`path ${a} <-> ${b}: the line between the waypoints is not clear`);
      const un = wk.lineUnsafe(fa, fb);
      if (un) fail(`path ${a} <-> ${b} runs through a place that is no good: ${un}`);
    }
  }
  // the new waypoints and the bots' own start
  const starts = [];
  for (const s of spawnsOf(map)) if (s.tier === 0) { const near = objNearest(w, s.at, walker.space); if (near) starts.push(near.index); }
  const fwd = reachFrom(w, starts), bwd = reachFrom(w, starts, true);
  const out = [];
  for (let i = o.length; i < w.length; i++) if (!(fwd[i] && bwd[i])) out.push(i);
  if (reach) {
    const from = spawnsOf(map).filter((s) => s.tier === 0).map((s) => [s.at[0], s.at[1], s.at[2] - FEET]);
    const res = M.reachOf(bsp, { from, shut: ["tsm_eng_door"], cell: 16, jump: true, doors: "open" });
    for (let i = o.length; i < w.length; i++) {
      const f = feet(i);
      const on = res.on(f[0], f[1], f[2] + 20);
      if (!(on.walked || on.jumped) || Math.abs(on.floor - f[2]) > 1) warnings.push(`new waypoint ${i} at ${w[i].origin.map(Math.round)}: SMAK's walk from the spawns does not reach its floor`);
    }
  }
  return { problems, warnings, doorEdges, checked, added: w.length - o.length, notInCore: out };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const pos = [];
  let orig;
  let allowDoors = false;
  let reach = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--orig") orig = args[++i];
    else if (args[i] === "--allow-doors") allowDoors = true;
    else if (args[i] === "--reach") reach = true;
    else pos.push(args[i]);
  }
  const [map, file] = pos;
  if (!map || !file) {
    console.log("  node check.mjs <map> <new.rcw> [--orig <original.rcw>] [--allow-doors] [--reach]");
    process.exit(2);
  }
  const r = checkMap(map, file, orig, { allowDoors, reach });
  for (const p of r.problems) console.log(`  FAIL ${p}`);
  for (const p of r.warnings) console.log(`  WARN ${p}`);
  for (const p of r.doorEdges) console.log(`  DOOR path ${p} is walked only with a door open`);
  console.log(`${map}: ${r.added} new waypoints, ${r.checked} path ends with a new waypoint checked, ${r.notInCore.length} new waypoints out of the bots' reach (${r.notInCore.join(" ") || "none"})`);
  console.log(r.problems.length ? "FAILED" : "ok");
  process.exit(r.problems.length ? 1 : 0);
}
