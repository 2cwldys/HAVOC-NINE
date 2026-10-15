// Everywhere in the map a player cannot walk to.
//
//     node steps.mjs
//
// A player walks up 18 and no more. A flight of stairs whose top does not meet its landing is
// therefore not a cosmetic fault: whatever is above it becomes unreachable, and you climb a dozen
// treads to stand against a wall.
//
// So this does not hunt for tall steps -- a tall step beside a building is a building, and the open
// side of a staircase is somewhere you walk OFF. It samples the floor across the whole map, walks
// out from the spawn points obeying the 18, and reports the floor it never arrives at. Those are
// the stairs that lead nowhere, the landings with no way up and the catwalks cut off at both ends,
// found wherever they are rather than wherever somebody happened to look.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { M, OUT, MAP_NAME, spawnPoints } from "./lib.mjs";

const STEP = 18;   // what a player walks up without jumping
const GRID = 8;    // finer than the shortest tread in the map (16), so no step is sampled across
const SMALL = 6;   // clusters under this many samples are ledges and sills, not places
const EYE = 36;    // hull 1 rests the MIDDLE of the player's box: his feet are this much lower

/*
 * The map is storeys stacked on storeys and a drop only ever finds the first floor under it, so one
 * sweep from the sky would map the city and never see the undercity at all. These are the heights
 * to drop FROM: one inside each storey, plus one just under each deck and landing level.
 */
/*
 * 110 and 60 are not spare: the gate tunnels are 160 tall, and hull 1 is a 72-tall box placed about
 * its MIDDLE, so a drop from 180 puts the player inside the header over the door and finds nothing
 * at all. Without a height that fits inside them the two halls look sealed off from the city and
 * every square of it is reported as unreachable.
 */
const FROM = [1180, 700, 420, 180, 110, 60, -60, -210, -300, -420, -660, -860, -1010];

const bsp = M.readBsp(readFileSync(join(OUT, `${MAP_NAME}.bsp`)));
const world = bsp.models[0];
const lo = [0, 1].map((i) => Math.ceil(world.mins[i] / GRID) * GRID);
const hi = [0, 1].map((i) => Math.floor(world.maxs[i] / GRID) * GRID);
const nx = (hi[0] - lo[0]) / GRID + 1;
const ny = (hi[1] - lo[1]) / GRID + 1;

// ---- where the floor is ------------------------------------------------------------------------
/** cell index -> the floor heights found there, low to high. One cell can have three. */
const floors = new Map();
const cell = (ix, iy) => ix * ny + iy;
let samples = 0;
for (let ix = 0; ix < nx; ix++) {
  const x = lo[0] + ix * GRID;
  for (let iy = 0; iy < ny; iy++) {
    const y = lo[1] + iy * GRID;
    let found = null;
    for (const from of FROM) {
      const at = M.floorUnder(bsp, [x, y, from], { hull: 1, reach: 4096 });
      if (at === null) continue;
      const feet = Math.round((at - EYE) * 4) / 4;
      if (found === null) found = [feet];
      else if (!found.some((h) => Math.abs(h - feet) < 1)) found.push(feet);
    }
    if (found) {
      found.sort((a, b) => a - b);
      floors.set(cell(ix, iy), found);
      samples += found.length;
    }
  }
}
console.log(`\n  ${samples} places to stand, over ${floors.size} of ${nx * ny} squares of ground`);

// ---- walk out from the spawns ------------------------------------------------------------------
const seen = new Set();                                   // "cell:slot"
const key = (c, slot) => `${c}:${slot}`;
const queue = [];

/** The nearest standing place to a point, as a (cell, slot), or null. */
const nodeAt = (p) => {
  const ix = Math.round((p[0] - lo[0]) / GRID);
  const iy = Math.round((p[1] - lo[1]) / GRID);
  const hs = floors.get(cell(ix, iy));
  if (!hs) return null;
  let best = 0;
  for (let i = 1; i < hs.length; i++) if (Math.abs(hs[i] - p[2]) < Math.abs(hs[best] - p[2])) best = i;
  return [cell(ix, iy), best];
};

let seeded = 0;
for (const s of spawnPoints()) {
  const n = nodeAt(s.at);
  if (!n) continue;
  if (seen.has(key(...n))) continue;
  seen.add(key(...n));
  queue.push(n);
  seeded++;
}
console.log(`  walking out from ${seeded} spawn point(s)`);

while (queue.length) {
  const [c, slot] = queue.pop();
  const ix = Math.floor(c / ny);
  const iy = c % ny;
  const h = floors.get(c)[slot];
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const jx = ix + dx;
    const jy = iy + dy;
    if (jx < 0 || jy < 0 || jx >= nx || jy >= ny) continue;
    const d = cell(jx, jy);
    const hs = floors.get(d);
    if (!hs) continue;
    for (let i = 0; i < hs.length; i++) {
      // up to a step, or down any distance: a drop is never what stops you
      if (hs[i] - h > STEP) continue;
      if (h - hs[i] > 400) continue;    // not a fall that would hurt enough to call a route
      const k = key(d, i);
      if (seen.has(k)) continue;
      seen.add(k);
      queue.push([d, i]);
    }
  }
}
console.log(`  reached ${seen.size} of ${samples} (${Math.round((100 * seen.size) / samples)}%)`);

// ---- what was never reached --------------------------------------------------------------------
/** The leftovers, gathered into places rather than listed as ten thousand squares. */
const left = new Set();
for (const [c, hs] of floors) for (let i = 0; i < hs.length; i++) if (!seen.has(key(c, i))) left.add(key(c, i));

const clusters = [];
const done = new Set();
for (const start of left) {
  if (done.has(start)) continue;
  const group = [];
  const stack = [start];
  done.add(start);
  while (stack.length) {
    const k = stack.pop();
    const [cs, is] = k.split(":").map(Number);
    const ix = Math.floor(cs / ny);
    const iy = cs % ny;
    const h = floors.get(cs)[is];
    group.push({ x: lo[0] + ix * GRID, y: lo[1] + iy * GRID, z: h });
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const d = cell(ix + dx, iy + dy);
      const hs = floors.get(d);
      if (!hs) continue;
      for (let i = 0; i < hs.length; i++) {
        const nk = key(d, i);
        if (done.has(nk) || !left.has(nk)) continue;
        if (Math.abs(hs[i] - h) > 64) continue;
        done.add(nk);
        stack.push(nk);
      }
    }
  }
  if (group.length < SMALL) continue;
  const at = (f) => {
    let min = Infinity;
    let max = -Infinity;
    for (const g of group) {
      if (g[f] < min) min = g[f];
      if (g[f] > max) max = g[f];
    }
    return [min, max];
  };
  clusters.push({ n: group.length, x: at("x"), y: at("y"), z: at("z") });
}
clusters.sort((a, b) => b.n - a.n);

console.log(`\n  ${clusters.length} place(s) with no way in on foot:`);
const pad = (v, w) => String(Math.round(v)).padStart(w);
for (const c of clusters.slice(0, 40)) {
  console.log(
    `     ${pad(c.n * GRID * GRID, 7)} sq   x ${pad(c.x[0], 6)}..${pad(c.x[1], 5)}` +
      `   y ${pad(c.y[0], 6)}..${pad(c.y[1], 5)}   z ${pad(c.z[0], 6)}..${pad(c.z[1], 6)}`,
  );
}
console.log("");
