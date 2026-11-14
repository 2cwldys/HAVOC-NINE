// show.mjs -- a text picture of the floor around an objective, to look at what coverage.mjs measured and lay.mjs laid.
//
//   node show.mjs <map> <label> [--rcw FILE] [--span 320] [--cell 16] [--orig FILE]
//   node show.mjs <map> x,y,z   [...]        any point instead of an objective's label (AS1, CAP2, UPLINK, PAD1 ...)
//
//   .  floor a player walks, at the objective's level (within 40 of it)
//   :  no floor at that level (wall, hole, another level)
//   o  a waypoint of the file (within 72 of the level); N one that is not in --orig (a new one); X the objective's mark
//   ,  the ring's hold line (0.6 of the radius) where the picture has nothing else; the line is where a ring's waypoints end
// Each row is a y, each column an x; north (+y) at the top, east (+x) to the right. Under the picture: every waypoint shown.
import { pathToFileURL } from "node:url";
import { WP_DIR, OBJ, FEET, flat, loadMap, makeWalker, objectivesOf, readWaypoints } from "./h9wp.mjs";

export function show(map, target, { rcw = `${WP_DIR}/${map}.rcw`, orig = `${WP_DIR}/${map}.rcw`, span = 320, cell = 16 } = {}) {
  const bsp = loadMap(map);
  const obj = objectivesOf(map, bsp);
  const walker = makeWalker(bsp);
  let at = null;
  let radius = 0;
  const label = target.toUpperCase();
  for (const r of obj.rings) if (r.label === label) { at = [r.x, r.y, r.z]; radius = r.r; }
  if (!at && label === "UPLINK" && obj.uplink) at = [obj.uplink.x, obj.uplink.y, obj.uplink.z - 16];
  for (const p of obj.pads) if (label === `PAD${p.side}`) at = [p.x, p.y, p.z];
  if (!at) {
    const t = target.split(",").map(Number);
    if (t.length === 3 && t.every(Number.isFinite)) at = t;
  }
  if (!at) throw new Error(`${target}: not an objective of ${map}, nor x,y,z`);
  const file = readWaypoints(rcw).waypoints;
  const old = readWaypoints(orig).waypoints.length;
  // the level: the floor nearest the mark
  let level = at[2];
  const floors = walker.floorsAt(at[0], at[1]).filter((f) => Math.abs(f - at[2]) <= 72);
  if (floors.length) level = floors.sort((a, b) => Math.abs(a - at[2]) - Math.abs(b - at[2]))[0];
  const lines = [];
  const half = Math.floor(span / cell);
  const hold = radius * OBJ.RING_SHARE;
  const here = new Map();
  file.forEach((w, i) => {
    const f = w.origin[2] - FEET;
    if (Math.abs(f - level) > 72) return;
    const ix = Math.round((w.origin[0] - at[0]) / cell), iy = Math.round((w.origin[1] - at[1]) / cell);
    if (Math.abs(ix) > half || Math.abs(iy) > half) return;
    const k = `${ix},${iy}`;
    if (!here.has(k) || i >= old) here.set(k, i >= old ? "N" : "o");
  });
  for (let iy = half; iy >= -half; iy--) {
    let row = "";
    for (let ix = -half; ix <= half; ix++) {
      const x = at[0] + ix * cell, y = at[1] + iy * cell;
      const k = `${ix},${iy}`;
      if (ix === 0 && iy === 0) { row += "X"; continue; }
      if (here.has(k)) { row += here.get(k); continue; }
      const f = walker.floorsAt(x, y).filter((g) => Math.abs(g - level) <= 40);
      const d = flat([x, y], at);
      if (radius && Math.abs(d - hold) < cell / 2) row += ",";
      else row += f.length ? "." : ":";
    }
    lines.push(row);
  }
  const out = [`${map} ${target} at ${at.map(Math.round).join(" ")}, level ${level}, hold ${Math.round(hold)}, cell ${cell}, span +-${half * cell}`, ...lines];
  file.forEach((w, i) => {
    if (flat(w.origin, at) <= span * 1.2 && Math.abs(w.origin[2] - FEET - level) <= 72)
      out.push(`  ${i >= old ? "N" : "o"} #${i} ${w.origin.map(Math.round).join(" ")} flags ${w.flags} paths ${w.paths.length} flat ${Math.round(flat(w.origin, at))}`);
  });
  return out.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--rcw") opt.rcw = args[++i];
    else if (args[i] === "--orig") opt.orig = args[++i];
    else if (args[i] === "--span") opt.span = Number(args[++i]);
    else if (args[i] === "--cell") opt.cell = Number(args[++i]);
    else pos.push(args[i]);
  }
  console.log(show(pos[0], pos[1], opt));
}
