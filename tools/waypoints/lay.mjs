// lay.mjs -- adds the waypoints a map's objectives lack, and the paths that join them to the waypoints it has.
//
//   node lay.mjs <map>                      reads <WP_DIR>\<map>.rcw, writes <out>\rcbot\waypoints\ts\<map>.rcw and
//                                           <out>\_added\<map>.txt (what was added, and why)
//   node lay.mjs --all                      every objective map (the h9_as_, h9_up_ and h9_ctf_ maps)
//   node lay.mjs <map> --out D:\some\dir    where the new file goes (default .\out, or H9_WP_OUT); never the original
//   node lay.mjs <map> --in D:\some\file.rcw  the waypoints to start from
//   node lay.mjs <map> --through-doors      a room only a door opens to is joined through the door (see below)
//
// WHAT IT ADDS, for each objective the coverage measure (coverage.mjs) finds short:
//   ring   a capture point or control zone: waypoints on the walkable floor within 0.6 of its radius, spread so that the
//          bots the planner sends (up to 4) do not stack, up to ringWant(); the one nearest the middle first
//   uplink, pad  one waypoint on the mark itself; a pad also gets a guard ring of its own
//   spawn  a waypoint beside any spawn whose nearest waypoint is far (a bot spawns, and walks to its nearest)
// and joins each one both ways to its neighbours, and to the waypoints the bots already reach each other by, along lines a
// player walks (steps of 18 at most, in both directions, FINE units at a time) with room beside them (12 units), through no
// door (every door a wall) and over no drop. Where no such line reaches the waypoints it has, a chain of waypoints is laid
// along the floor a walk finds between them (Dijkstra over a grid of 16, away from walls) and joined the same way.
//
// WHAT IT NEVER DOES: move, delete, renumber or reflag a waypoint (new ones are appended, so the file's first 50, where the
// bots roam to, and every index stay as they are; an old waypoint only gains paths), join two old waypoints, cross a drop,
// cross a door (but with --through-doors), join a ladder, jump, crouch or any other special waypoint, or write anywhere but the
// folder it is told.
//
// A ROOM A DOOR SEALS. When no walk of any door-free kind joins an objective to the rest of the map (h9_as_neuropolis's two
// rooms behind the engineer doors, which only +USE opens) the room is waypointed inside and left unjoined; the report says so.
// --through-doors joins it through the door: a bot cannot open such a door, but follows a person who does.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  OBJ, WP_DIR, FEET, STEP, FLAGS, MAX_WAYPOINTS, flat, isGoal, isDeleted, objNearest, reachFrom, readWaypoints,
  writeWaypoints, loadMap, makeWalker, objectivesOf, objectiveMaps, spawnsOf,
} from "./h9wp.mjs";
import { ringWant, ITEM_NEAR } from "./coverage.mjs";

const CELL = 16;
const ROOM_LINE = 12; // a path keeps this much clear floor beside it
const ROOM_SPOT = 24; // a waypoint stands with this much (16 where there is no more)
const MAX_LINK = 400; // the longest path laid across the floor (the bot looks 400 for its nearest waypoint)
const NEIGHBOURS = 5; // paths laid from a new waypoint, at the most
const CHAIN_LEG = 160; // a chain's legs are no longer than this
const ROUNDABOUT = 1.1; // a path is not laid where two it has go round (SMAK's waypoints.mjs rule)
const SPAWN_NEAR = 200; // a spawn with no waypoint within this gets one

const key = (ix, iy, f) => (ix * 16384 + iy) * 8192 + Math.round((f + 2048) * 2);

class Heap {
  constructor() { this.a = []; }
  push(cost, item) {
    const a = this.a;
    a.push([cost, item]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        let l = 2 * i + 1, r = l + 1, m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
  get size() { return this.a.length; }
}

export function layMap(map, { input = join(WP_DIR, `${map}.rcw`), throughDoors = false, log = console.log, verbose = false } = {}) {
  const bsp = loadMap(map);
  const obj = objectivesOf(map, bsp);
  const walker = makeWalker(bsp, { doors: "closed" });
  const doorWalker = throughDoors ? makeWalker(bsp, { doors: "open", shut: [] }) : null;
  const orig = readWaypoints(input);
  const w = orig.waypoints.map((x) => ({ flags: x.flags, origin: [...x.origin], paths: [...x.paths] }));
  const nOrig = w.length;
  const spawns = spawnsOf(map);
  const report = { map, added: [], links: 0, chains: [], sealed: [], warnings: [], doorLinks: [] };
  const say = (m) => { if (verbose) log(`  ${m}`); };

  const feet = (i) => [w[i].origin[0], w[i].origin[1], w[i].origin[2] - FEET];
  const hasPath = (a, b) => w[a].paths.includes(b);
  const addPath = (a, b) => { if (!hasPath(a, b)) w[a].paths.push(b); };
  // a waypoint a new path may join: nothing special about it but what only informs (an item near it, a place to defend)
  const INFO = FLAGS.HEALTH | FLAGS.ARMOR | FLAGS.AMMO | FLAGS.WEAPON | FLAGS.IMPORTANT | FLAGS.RESCUE | FLAGS.DEFEND_ZONE;
  const plain = (i) => !isDeleted(w[i]) && (w[i].flags & ~INFO) === 0;

  const baseStarts = () => {
    const s = new Set();
    for (const sp of spawns) if (sp.tier === 0) { const n = objNearest(w, sp.at, walker.space); if (n) s.add(n.index); }
    return [...s];
  };
  const coreSet = () => {
    const starts = baseStarts();
    const f = reachFrom(w, starts);
    const b = reachFrom(w, starts, true);
    const core = new Uint8Array(w.length);
    for (let i = 0; i < w.length; i++) core[i] = f[i] && b[i] ? 1 : 0;
    return core;
  };

  const newWaypoint = (feetPos, why) => {
    if (w.length >= MAX_WAYPOINTS) throw new Error(`${map}: ${MAX_WAYPOINTS} waypoints reached`);
    w.push({ flags: 0, origin: [feetPos[0], feetPos[1], feetPos[2] + FEET], paths: [] });
    report.added.push({ index: w.length - 1, why, at: [...feetPos] });
    return w.length - 1;
  };

  /** Whether a path both ways between two waypoints is a line a player walks with room, through no door. */
  const canLink = (a, b, wk = walker) => {
    const fa = feet(a), fb = feet(b);
    if (flat(fa, fb) > MAX_LINK || Math.abs(fa[2] - fb[2]) > 2 * STEP) return false;
    // a player walks it both ways with room beside it, and a bot at one waypoint sees the other (the line between their origins is clear)
    return wk.walksLine(fa, fb) && wk.walksLine(fb, fa) && wk.lineRoom(fa, fb, ROOM_LINE) && wk.space.sees(w[a].origin, w[b].origin) && !wk.lineUnsafe(fa, fb);
  };
  const link = (a, b) => {
    addPath(a, b);
    addPath(b, a);
    report.links++;
  };

  /** Joins a new waypoint to the plain waypoints near it, nearest first, skipping a path two shorter ones go round. */
  const linkNear = (n) => {
    const here = feet(n);
    const cand = [];
    for (let i = 0; i < w.length; i++) {
      if (i === n || !plain(i)) continue;
      const f = feet(i);
      if (flat(f, here) > MAX_LINK || Math.abs(f[2] - here[2]) > 2 * STEP) continue;
      cand.push([flat(f, here), i]);
    }
    cand.sort((a, b) => a[0] - b[0]);
    const taken = [];
    for (const [d, i] of cand) {
      if (taken.length >= NEIGHBOURS) break;
      if (taken.some(([d1, j]) => d1 + flat(feet(j), feet(i)) <= ROUNDABOUT * d)) continue;
      if (canLink(n, i)) {
        link(n, i);
        taken.push([d, i]);
      }
    }
    return taken.length;
  };

  /** The floor a player stands on at (x, y) nearest `z`, within 72 of it; null when none. */
  const floorNear = (x, y, z) => {
    let best = null;
    for (const t of walker.floorsAt(x, y)) if (Math.abs(t - z) <= OBJ.Z_RANGE && (best === null || Math.abs(t - z) < Math.abs(best - z))) best = t;
    return best;
  };
  /** The nearest column with such a floor, searched in rings of the grid out to `reach`. */
  const standingNear = (x, y, z, reach = 96) => {
    const f = floorNear(x, y, z);
    if (f !== null) return [x, y, f];
    for (let r = CELL; r <= reach; r += CELL)
      for (let dx = -r; dx <= r; dx += CELL)
        for (let dy = -r; dy <= r; dy += CELL) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const g = floorNear(x + dx, y + dy, z);
          if (g !== null) return [x + dx, y + dy, g];
        }
    return null;
  };

  /** The floor the walk covers within `hold` of a mark, flooded from it on the grid: [{ x, y, f, d }] (feet at (x, y, f), d from the mark). */
  const flood = (cx, cy, start, hold) => {
    const out = [];
    const seen = new Set();
    const q = [];
    const push = (ix, iy, f) => {
      const k = key(ix, iy, f);
      if (seen.has(k)) return;
      seen.add(k);
      q.push([ix, iy, f]);
    };
    push(Math.round(start[0] / CELL), Math.round(start[1] / CELL), start[2]);
    for (let h = 0; h < q.length; h++) {
      const [ix, iy, f] = q[h];
      const x = ix * CELL, y = iy * CELL;
      const d = Math.hypot(x - cx, y - cy);
      if (d > hold) continue;
      out.push({ x, y, f, d });
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const g = walker.floorFrom(x + dx * CELL, y + dy * CELL, f);
        if (g !== null && Math.abs(g - start[2]) <= 40) push(ix + dx, iy + dy, g);
      }
    }
    return out;
  };

  /** Whether feet at `p` are within 28 across of a door's box of the walk `wk` (doors it takes as open, which a closed walk makes walls). */
  const nearDoor = (wk, p) => wk.space.doors.some((d) => p[0] > d.min[0] - 28 && p[0] < d.max[0] + 28 && p[1] > d.min[1] - 28 && p[1] < d.max[1] + 28 && p[2] + 72 > d.min[2] && p[2] < d.max[2]);

  /** The doors (by name) a line from feet a to feet b passes through, when every door is open. */
  const doorsOnLine = (space, a, b) => {
    const found = new Set();
    const len = Math.max(1, Math.ceil(flat(a, b) / 8));
    for (let k = 0; k <= len; k++) {
      const t = k / len;
      const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      for (const d of space.doors)
        if (p[0] > d.min[0] - 17 && p[0] < d.max[0] + 17 && p[1] > d.min[1] - 17 && p[1] < d.max[1] + 17 && p[2] + 72 > d.min[2] && p[2] < d.max[2])
          found.add(`${d.classname} ${d.targetname ?? "#" + d.number}`);
    }
    return [...found];
  };

  /**
   * A chain of waypoints from the nearest of `from` (new waypoints) to the core of the graph: Dijkstra over the grid of 16
   * from their floor to any plain waypoint the bots reach and leave by (within 48 of a grid cell and joined to it by a line
   * a player walks), the cost the length, more where there is little room. The cells are pulled tight into legs of at most
   * CHAIN_LEG that a straight line walks with room, and a waypoint is laid at the end of each. `wk` is the walk: the one with
   * every door shut, or (--through-doors) the one with every door open, whose door crossings are written down.
   */
  const bridge = (from, wk, why) => {
    const core = coreSet();
    const targets = new Map();
    for (let i = 0; i < w.length; i++) {
      if (!core[i] || !plain(i)) continue;
      const f = feet(i);
      const k = `${Math.floor(f[0] / 64)},${Math.floor(f[1] / 64)}`;
      if (!targets.has(k)) targets.set(k, []);
      targets.get(k).push(i);
    }
    const nearTargets = (x, y, f) => {
      const out = [];
      for (let bx = Math.floor((x - 48) / 64); bx <= Math.floor((x + 48) / 64); bx++)
        for (let by = Math.floor((y - 48) / 64); by <= Math.floor((y + 48) / 64); by++)
          for (const i of targets.get(`${bx},${by}`) ?? []) {
            const t = feet(i);
            if (flat(t, [x, y]) <= 48 && Math.abs(t[2] - f) <= STEP) out.push(i);
          }
      return out;
    };
    const dist = new Map();
    const parent = new Map();
    const where = new Map();
    const source = new Map();
    const heap = new Heap();
    const clearOf = new Map();
    const room = (ix, iy, f) => {
      const k = key(ix, iy, f);
      let r = clearOf.get(k);
      if (r === undefined) { r = wk.clearance(ix * CELL, iy * CELL, f); clearOf.set(k, r); }
      return r;
    };
    for (const n of from) {
      const f = feet(n);
      const ix = Math.round(f[0] / CELL), iy = Math.round(f[1] / CELL);
      const k = key(ix, iy, f[2]);
      dist.set(k, 0);
      parent.set(k, null);
      source.set(k, n);
      where.set(k, [ix * CELL, iy * CELL, f[2]]);
      heap.push(0, [ix, iy, f[2]]);
    }
    const limit = 2600;
    let found = null;
    let pops = 0;
    const origin = feet(from[0]);
    while (heap.size && pops < 300000) {
      const [cost, [ix, iy, f]] = heap.pop();
      const k = key(ix, iy, f);
      if (cost > dist.get(k)) continue;
      pops++;
      const x = ix * CELL, y = iy * CELL;
      if (flat([x, y], origin) > limit) continue;
      for (const t of nearTargets(x, y, f)) {
        if (wk.walksLine([x, y, f], feet(t)) && wk.walksLine(feet(t), [x, y, f])) { found = { k, t }; break; }
      }
      if (found) break;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const nx = x + dx * CELL, ny = y + dy * CELL;
        const g = wk.floorFrom(nx, ny, f);
        if (g === null || wk.unsafe(nx, ny, g)) continue;
        if (dx && dy) {
          const a = wk.floorFrom(x + dx * CELL, y, f), b = wk.floorFrom(x, y + dy * CELL, f);
          if (a === null || b === null || Math.abs(a - f) > STEP || Math.abs(b - f) > STEP) continue;
        }
        const r = room(ix + dx, iy + dy, g);
        const step = Math.hypot(dx, dy) * CELL * (r >= 32 ? 1 : r >= 24 ? 1.3 : r >= 16 ? 2.5 : 6);
        const nk = key(ix + dx, iy + dy, g);
        const c = cost + step;
        if (c < (dist.get(nk) ?? Infinity)) {
          dist.set(nk, c);
          parent.set(nk, k);
          where.set(nk, [nx, ny, g]);
          heap.push(c, [ix + dx, iy + dy, g]);
        }
      }
    }
    if (!found) return null;
    // the cells, from the cluster's own waypoint to the core, by their parents
    const cells = [];
    let root = found.k;
    for (let at = found.k; at !== null; at = parent.get(at)) { cells.push(where.get(at)); root = at; }
    cells.reverse();
    const start = source.get(root);
    cells[0] = feet(start);
    cells.push(feet(found.t));
    // pull tight: each leg as long as a line a player walks with room allows
    const chain = [];
    for (let i = 0; i < cells.length - 1; ) {
      let j = i + 1;
      while (
        j + 1 < cells.length && flat(cells[i], cells[j + 1]) <= CHAIN_LEG && Math.abs(cells[i][2] - cells[j + 1][2]) <= 2 * STEP &&
        wk.walksLine(cells[i], cells[j + 1]) && wk.walksLine(cells[j + 1], cells[i]) && wk.lineRoom(cells[i], cells[j + 1], ROOM_LINE)
      ) j++;
      // never in a doorway: back off to a cell 28 or more clear of every door
      while (j > i + 1 && j < cells.length - 1 && nearDoor(wk, cells[j])) j--;
      if (j < cells.length - 1) chain.push(cells[j]);
      i = j;
    }
    // lay them and join each to the one before; the first joins the cluster's waypoint, the last the core's
    const laid = [];
    const through = wk !== walker;
    const joinWith = (a, b) => {
      if (!canLink(a, b, wk)) { report.warnings.push(`${map}: chain leg ${a} <-> ${b} is not a walked line`); return; }
      link(a, b);
      if (through) {
        const doors = doorsOnLine(wk.space, feet(a), feet(b));
        if (doors.length) report.doorLinks.push({ a, b, doors });
      }
    };
    let prev = start;
    for (const pos of chain) {
      const n = newWaypoint(pos, `chain: ${why}`);
      laid.push(n);
      joinWith(prev, n);
      prev = n;
    }
    joinWith(prev, found.t);
    for (const n of laid) linkNear(n);
    report.chains.push({ why, waypoints: laid, from: start, to: found.t, cost: Math.round(dist.get(found.k)) });
    return laid;
  };


  /** Whether a waypoint of any kind (a ladder's, a jump's, a crouch's too) already stands within 24 of feet (x, y, f). */
  const crowded = (x, y, f) => {
    for (const p of w) if (!isDeleted(p) && Math.hypot(p.origin[0] - x, p.origin[1] - y) < 24 && Math.abs(p.origin[2] - FEET - f) < 40) return true;
    return false;
  };

  /** Places `count` waypoints on the walked floor within `hold` of (cx, cy), farthest from each other, away from walls. */
  const spread = (cx, cy, z, hold, have, count, minSep, why) => {
    const start = standingNear(cx, cy, z);
    if (!start) return { made: [], start: null };
    // the flood may climb a step or two; a waypoint stands on the ring's own floor (within 20 of it), not on a ledge over it
    const cells = flood(cx, cy, start, hold - 4).filter((c) => c.d <= hold - 4 && Math.abs(c.f - start[2]) <= 20);
    const wide = (c) => walker.clearance(c.x, c.y, c.f);
    for (const c of cells) c.room = wide(c);
    // never on a belt, a moving platform, a hurt or push brush, or in water
    for (let i = cells.length - 1; i >= 0; i--) if (walker.unsafe(cells[i].x, cells[i].y, cells[i].f) || crowded(cells[i].x, cells[i].y, cells[i].f)) cells.splice(i, 1);
    const placed = [];
    const pos = have.map((i) => feet(i));
    const far = (c) => Math.min(...pos.map((p) => (Math.abs(p[2] - c.f) <= 2 * STEP ? flat(p, [c.x, c.y]) : 1e9)), 1e9);
    for (let k = 0; k < count; k++) {
      let best = null;
      for (const need of [ROOM_SPOT, 16, 8]) {
        for (const c of cells) {
          if (c.room < need) continue;
          const d = far(c);
          if (d < minSep) continue;
          // the middle first, then the farthest from what stands; the middle of a roomy cell over its edge
          const score = (pos.length === 0 ? -c.d : Math.min(d, 160) - 0.15 * c.d) + c.room * 0.05;
          if (best === null || score > best.score) best = { c, score };
        }
        if (best) break;
      }
      if (!best) break;
      const n = newWaypoint([best.c.x, best.c.y, best.c.f], why);
      placed.push(n);
      pos.push(feet(n));
    }
    return { made: placed, start };
  };
  /**
   * Joins new waypoints to the graph: to those near them, and for any that still do not reach the core a chain (all the
   * unjoined at once, from the cheapest of them). Returns the new waypoints that are still out of the core.
   */
  const attach = (made, why, label) => {
    for (const n of made) linkNear(n);
    for (let round = 0; round < 4; round++) {
      let core = coreSet();
      const out = made.filter((n) => !core[n]);
      if (!out.length) return [];
      // a new waypoint a line reaches one that is in the core by
      const inCore = made.filter((m) => core[m]);
      for (const n of out) {
        inCore.sort((a, b) => flat(feet(a), feet(n)) - flat(feet(b), feet(n)));
        for (const m of inCore) if (canLink(n, m)) { link(n, m); break; }
      }
      core = coreSet();
      const still = made.filter((n) => !core[n]);
      if (!still.length) return [];
      if (bridge(still, walker, label ?? why)) continue;
      if (doorWalker && bridge(still, doorWalker, `${label ?? why} (through a door)`)) continue;
      return still;
    }
    const core = coreSet();
    return made.filter((n) => !core[n]);
  };

  // ---- the objectives -------------------------------------------------------------------------------------
  for (const r of obj.rings) {
    const hold = r.r * OBJ.RING_SHARE;
    const want = ringWant(hold);
    const core0 = coreSet();
    const existing = [];
    for (let i = 0; i < w.length; i++) {
      if (isDeleted(w[i]) || !isGoal(w[i])) continue;
      if (flat(w[i].origin, [r.x, r.y]) <= hold && Math.abs(w[i].origin[2] - (r.z + OBJ.WPT_HEIGHT)) <= OBJ.Z_RANGE && core0[i]) existing.push(i);
    }
    if (existing.length >= want) { say(`${r.label}: ${existing.length} waypoints inside, enough`); continue; }
    const minSep = Math.max(48, Math.min(112, hold * 0.45));
    const { made, start } = spread(r.x, r.y, r.z, hold, existing, want - existing.length, minSep, `${r.label} ring`);
    if (!start) { report.warnings.push(`${r.label}: no walkable floor within 96 of its middle at z ${r.z}`); continue; }
    if (!made.length && !existing.length) { report.warnings.push(`${r.label}: no floor within ${Math.round(hold)} of the middle to stand a waypoint on`); continue; }
    const lost = attach(made, `${r.label} ring`, r.label);
    if (lost.length) report.sealed.push(`${r.label}: ${lost.length} of ${made.length} new waypoints inside it are not joined to the rest of the map`);
    say(`${r.label}: ${made.length} added, ${lost.length ? lost.length + " NOT joined" : "joined"}`);
  }

  /** The free floor nearest (x, y) within `reach`: standing, with room, not crowded by a waypoint, no hazard; null for none. */
  const placeNear = (x, y, z, reach) => {
    const start = standingNear(x, y, z, reach);
    if (!start) return null;
    let best = null;
    for (const c of flood(x, y, start, reach)) {
      if (Math.abs(c.f - start[2]) > 20 || crowded(c.x, c.y, c.f) || walker.unsafe(c.x, c.y, c.f)) continue;
      const room = walker.clearance(c.x, c.y, c.f);
      if (room < 16) continue;
      const score = c.d - room * 0.1;
      if (best === null || score < best.score) best = { score, at: [c.x, c.y, c.f] };
    }
    // the mark's own column when it is free (the flood is on the grid of 16)
    if (!crowded(start[0], start[1], start[2]) && !walker.unsafe(start[0], start[1], start[2]) && walker.clearance(start[0], start[1], start[2]) >= 16) return start;
    return best ? best.at : null;
  };

  const markSpot = (label, x, y, z, markZ, guardHold, guardWant) => {
    // a waypoint on the mark itself, so that the straight walk to it is nothing; and a guard ring where the flag stands
    const core0 = coreSet();
    const near = objNearest(w, [x, y, markZ], walker.space);
    const okNear = near && near.sight && flat(w[near.index].origin, [x, y]) <= ITEM_NEAR && core0[near.index] && walker.walksLine([w[near.index].origin[0], w[near.index].origin[1], w[near.index].origin[2] - FEET], [x, y, z]);
    let made = [];
    if (!okNear) {
      const spot = placeNear(x, y, z, 64);
      if (!spot) { report.warnings.push(`${label}: no free floor within 64 of its mark`); return; }
      made = [newWaypoint(spot, `${label} mark`)];
    }
    if (guardWant) {
      const core1 = coreSet();
      const inside = [];
      for (let i = 0; i < w.length; i++) {
        if (isDeleted(w[i]) || !isGoal(w[i]) || !core1[i]) continue;
        if (flat(w[i].origin, [x, y]) <= guardHold && Math.abs(w[i].origin[2] - (z + OBJ.WPT_HEIGHT)) <= OBJ.Z_RANGE) inside.push(i);
      }
      const have = [...inside, ...made];
      if (have.length < guardWant) {
        const more = spread(x, y, z, guardHold, have, guardWant - have.length, 48, `${label} guard`);
        made = [...made, ...more.made];
      }
    }
    if (made.length) {
      const lost = attach(made, label, label);
      if (lost.length) report.sealed.push(`${label}: ${lost.length} of ${made.length} new waypoints are not joined to the rest of the map`);
      say(`${label}: ${made.length} added, ${lost.length ? lost.length + " NOT joined" : "joined"}`);
    }
  };
  if (obj.uplink) markSpot("UPLINK", obj.uplink.x, obj.uplink.y, obj.uplink.z - 16, obj.uplink.z + OBJ.WPT_HEIGHT, 0, 0);
  for (const p of obj.pads) markSpot(`PAD${p.side}`, p.x, p.y, p.z, p.z + OBJ.WPT_HEIGHT, OBJ.GUARD_RADIUS * OBJ.RING_SHARE, 2);

  // spawns whose nearest waypoint is far
  for (const sp of spawns) {
    const near = objNearest(w, sp.at, walker.space);
    if (near && near.dist <= SPAWN_NEAR) continue;
    const at = [sp.at[0], sp.at[1], sp.at[2] - FEET];
    const recent = report.added.find((a) => a.why.startsWith("spawn") && flat(a.at, at) < 160 && Math.abs(a.at[2] - at[2]) < 40);
    if (recent) continue;
    const start = standingNear(at[0], at[1], at[2], 48);
    if (!start) continue;
    const n = newWaypoint(start, `spawn side ${sp.side} tier ${sp.tier}`);
    const lost = attach([n], `spawn side ${sp.side} tier ${sp.tier}`, `spawn side ${sp.side} tier ${sp.tier}`);
    if (lost.length) report.sealed.push(`spawn side ${sp.side} tier ${sp.tier} at ${at.map(Math.round).join(" ")}: not joined`);
  }

  return { w, nOrig, filetype: orig.filetype, report, walker, obj, orig };
}

/** Every new path, checked again on its own: walked both ways by a player with room, through no door. Returns the failures. */
export function verifyNew({ w, nOrig, walker, report }) {
  const bad = [];
  const doorPair = new Set((report?.doorLinks ?? []).flatMap((d) => [`${d.a}-${d.b}`, `${d.b}-${d.a}`]));
  const feet = (i) => [w[i].origin[0], w[i].origin[1], w[i].origin[2] - FEET];
  for (let a = nOrig; a < w.length; a++)
    for (const b of w[a].paths) {
      if (b < nOrig && !w[b].paths.includes(a)) bad.push(`${a} -> ${b}: no way back`);
      if (doorPair.has(`${a}-${b}`)) continue;
      if (b >= a || b < nOrig) {
        if (!walker.walksLine(feet(a), feet(b)) || !walker.walksLine(feet(b), feet(a))) bad.push(`${a} <-> ${b}: not walked both ways`);
        else if (!walker.lineRoom(feet(a), feet(b), ROOM_LINE)) bad.push(`${a} <-> ${b}: no room`);
        else if (walker.lineUnsafe(feet(a), feet(b))) bad.push(`${a} <-> ${b}: ${walker.lineUnsafe(feet(a), feet(b))}`);
        else if (!walker.space.sees(w[a].origin, w[b].origin) || !walker.space.sees(w[b].origin, w[a].origin)) bad.push(`${a} <-> ${b}: no line of sight`);
      }
    }
  return bad;
}

// ---- the command line ----
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  let out = process.env.H9_WP_OUT ?? "out";
  let input = null;
  let through = false;
  let all = false;
  const maps = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out") out = args[++i];
    else if (args[i] === "--in") input = args[++i];
    else if (args[i] === "--through-doors") through = true;
    else if (args[i] === "--all") all = true;
    else maps.push(args[i]);
  }
  for (const map of all ? objectiveMaps() : maps) {
    const file = input ?? join(WP_DIR, `${map}.rcw`);
    const res = layMap(map, { input: file, throughDoors: through, verbose: true });
    const bad = verifyNew(res);
    const target = join(out, "rcbot", "waypoints", "ts", `${map}.rcw`);
    if (resolveSame(target, file)) throw new Error(`refusing to overwrite the original: ${file} is where the result would go`);
    if (res.w.length === res.nOrig) {
      console.log(`${map}: nothing to add (${res.nOrig} waypoints), no file written`);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, writeWaypoints({ filetype: res.filetype, fileFlags: 1, mapName: map, waypoints: res.w }));
    console.log(`${map}: ${res.w.length - res.nOrig} waypoints added (${res.nOrig} -> ${res.w.length}), ${res.report.links} paths laid, ${res.report.chains.length} chains -> ${target}`);
    // what was added and why, beside the output folder's rcbot tree (never inside it: that is what gets copied)
    const list = [`${map}: ${res.w.length - res.nOrig} waypoints added to ${res.nOrig}, ${res.report.links} paths laid`, ...res.report.added.map((a) => `  #${a.index}  ${a.at.map((v) => Math.round(v * 100) / 100).join(" ")} (feet)  ${a.why}`), ""];
    mkdirSync(join(out, "_added"), { recursive: true });
    writeFileSync(join(out, "_added", `${map}.txt`), list.join("\r\n"));
    for (const c of res.report.chains) console.log(`  CHAIN ${c.why}: ${c.waypoints.length} waypoints #${c.waypoints.join(" #")} from #${c.from} to #${c.to} (walk cost ${c.cost})`);
    for (const x of res.report.warnings) console.log(`  WARN ${x}`);
    for (const x of res.report.sealed) console.log(`  SEALED ${x}`);
    for (const d of res.report.doorLinks) console.log(`  DOOR EDGE ${d.a} <-> ${d.b} through ${d.doors.join(", ")}`);
    for (const x of bad) console.log(`  BAD EDGE ${x}`);
  }
}
/** Whether two paths name the same file (Windows: not by case). */
function resolveSame(a, b) {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}
