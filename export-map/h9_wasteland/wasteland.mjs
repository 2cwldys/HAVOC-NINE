// WASTELAND: a dead lakebed under a dust storm, the last ground two sides fight over. One place, six maps:
//
//   h9_te_wasteland    Team Elimination: the sides' forts and the ruins between them
//   h9_up_wasteland    Capture the Uplink: five control zones, the uplink's point in the central ruin
//   h9_ws_wasteland    Wave Survival: the survivors hold the north flat, the mutants come in from the rim
//   h9_mw_wasteland    Mech Warrior: the forts, the ruins, and room for Mechs
//   h9_as_wasteland    Assault: four capture points, one in each courtyard and one before each fort
//   h9_ctf_wasteland   Capture the Flag: a flag on the plinth at the back of each fort
//
// THE PLACE. A dry lakebed lies in a jagged bowl of canyon rock, some 3800 by 3400 units, its floor cracked
// sand and dust. A dry wash, 260 wide and one step down, runs east to west across the middle; the ruins stand
// over it on broken slabs. In the centre is the map's landmark: a roofless concrete ruin round a courtyard,
// two towers at its north corners and a broken upper slab over its north half. West and east, a second ruin
// each holds a walled courtyard, their gates facing the centre. Four smaller compounds cover the diagonal lanes,
// and the two forts stand at the north and south ends, each a broken walled yard with a flag plinth at its back.
// Beyond the play, a water tower, a radio mast and a fallen stretch of elevated road break the skyline.
//
// THE LOOK is the dust storm: a murky olive-brown sky with a low pale sun in the south-west (sky.mjs), sand and
// cracked lakebed underfoot, adobe and sun-bleached concrete in the ruins, rusted steel, timber and wire in what
// people left behind. The light is the storm's own, warm and flat, and fire barrels mark the places people hold.
//
// HOW IT IS BUILT. The bowl and the wash are spaces for SMAK's carvePlan, so what is not a space is rock and the
// map cannot leak. The ground is reliefOf's field of triangles in a func_detail, kept flat where anything stands
// or anyone starts. Every wall, slab, tower and prop is func_detail too; the sky is the map's own six sides.
// Each mode's entities are in its own map: the uplink zones never appear in the assault map, nor the flags in
// either, so a server cannot mistake one for another.
//
//   node wasteland.mjs                     write the six .map files, spawn configs, assault zones and .res lists,
//                                          check them, walk them, and draw the plans
//   node wasteland.mjs --compile [--xash]  and compile them (fast vis, bounced light)
//   node wasteland.mjs --views             and draw the compiled maps from inside, sky and all
//   node wasteland.mjs deploy              copy the maps, configs and sky into both H9 installs, backing up what
//                                          was there
//
// WASTE_ONLY=te (or up, ws, mw, as, ctf, or a comma list) builds only those; WASTE_THREADS sets the compilers'
// threads.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GAME_DIR, K, M } from "../lib.mjs";
import { SKY_FOLDER, SKY_NAME } from "./sky.mjs";
import { T, WADS } from "./textures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const COMPILERS = join(HERE, "..", "compilers");

// ---- the plan --------------------------------------------------------------------------------------
const RIM = 420; // the rock round the bowl stands this high; sky over it
const SKY_Z = 1024; // the open air's ceiling: the sky slab over everything
const WASH_Z = -16; // the dry wash's bed, one step down from the lakebed
const WASH_HALF = 130; // the wash runs y -WASH_HALF..WASH_HALF

/** The bowl's rim, in plan, anticlockwise. Jagged enough to read as a canyon, not a box. */
const BOWL = [
  [-1920, -900], [-1860, -1500], [-1400, -1710], [-700, -1760], [0, -1700],
  [700, -1760], [1400, -1710], [1860, -1500], [1920, -900], [1880, -200],
  [1940, 500], [1880, 1100], [1700, 1560], [1100, 1720], [300, 1680],
  [-400, 1740], [-1100, 1700], [-1700, 1540], [-1880, 1000], [-1940, 300],
];

/**
 * The mutants' pads round the rim: four behind each fort's wall, four each side. Behind the north and south forts the rim's
 * buttresses (rimCliffs, 150 thick) fill the ground, so those pads stand on the free ground in front of the wall.
 */
const MUTANTS = [
  [-900, 1500], [-200, 1480], [200, 1480], [900, 1500],
  [1600, -900], [1620, -300], [1600, 300], [1620, 900],
  [900, -1500], [200, -1480], [-200, -1480], [-900, -1500],
  [-1600, 900], [-1620, 300], [-1600, -300], [-1620, -900],
];

/** A rectangle's ring, anticlockwise from its least corner. */
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

const BOWL_SPACE = {
  name: "lakebed",
  outline: BOWL,
  floor: 0,
  ceiling: SKY_Z,
  horizon: RIM,
  texture: { floor: T.sand, wall: T.canyon, ceiling: T.sky },
};
const WASH_SPACE = {
  name: "wash",
  outline: rect(-1880, -WASH_HALF, 1880, WASH_HALF),
  floor: WASH_Z,
  ceiling: SKY_Z,
  horizon: RIM - WASH_Z,
  texture: { floor: T.sandCracked, wall: T.canyonB, ceiling: T.sky },
};

/** Flat ground kept for the forts, the ruins, the capture points, the spawn pads and the landmarks. */
const CLEAR = [
  { min: [-580, 920], max: [580, 1620] }, // north fort, flag and spawns
  { min: [-580, -1620], max: [580, -920] }, // south fort
  { min: [-390, -410], max: [390, 510] }, // central ruin and its courtyard
  { min: [-1410, -430], max: [-590, 490] }, // west courtyard ruin
  { min: [590, -430], max: [1410, 490] }, // east courtyard ruin
  { min: [-700, 430], max: [-350, 780] }, // north-west compound
  { min: [350, 430], max: [700, 780] }, // north-east compound
  { min: [-730, -930], max: [-380, -590] }, // south-west compound
  { min: [380, -930], max: [730, -590] }, // south-east compound
  { min: [-930, 780], max: [-690, 1020] }, // the north-west hut
  { min: [690, -1020], max: [930, -780] }, // the south-east hut
  { min: [-230, 530], max: [230, 990] }, // assault point 1 and its spawns
  { min: [-230, -990], max: [230, -530] }, // assault point 4
  { min: [-270, 530], max: [270, 950] }, // the survivors' flat
  { min: [-1380, -1080], max: [-1120, -820] }, // the water tower
  { min: [1360, 1110], max: [1540, 1290] }, // the radio mast
  { min: [1040, -1230], max: [1620, -1010] }, // the fallen elevated road
  { min: [-780, 200], max: [-700, 360] }, // the west wreck
  { min: [700, -500], max: [820, -340] }, // the east wreck
  { min: [-440, -980], max: [-280, -820] }, // the south-west wreck
  { min: [920, 620], max: [1080, 780] }, // the courtyard wreck
  // the rim pads the mutants come in on
  ...MUTANTS.map(([x, y]) => ({ min: [x - 80, y - 80], max: [x + 80, y + 80] })),
];

// ---- small tools -----------------------------------------------------------------------------------
/** A box from any two opposite corners, so a mirrored one is still a box. */
const box = (x0, y0, z0, x1, y1, z1, texture) =>
  M.box(
    [Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)],
    [Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)],
    texture,
  );
const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** A wall run from a to b with a jagged broken top, its foot sunk a little into the ground. */
function run(a, b, { bottom = -24, top, thick = 32, pieces, gaps = 0.14, rubble = 12, seed = 1, texture = T.block, low } = {}) {
  return M.brokenWall({
    from: a,
    to: b,
    thick,
    bottom,
    top,
    low,
    pieces: pieces ?? Math.max(2, Math.round(dist(a, b) / 110)),
    gaps,
    rubble,
    seed,
    texture,
  });
}

/** A square ruined tower, hollow and open at the top, its rims broken at four heights. */
function tower(cx, cy, size, top, seed = 1, texture = T.block) {
  const h = size / 2;
  const out = [];
  for (const [a, b, low] of [
    [[cx - h, cy - h], [cx + h, cy - h], 0],
    [[cx + h, cy - h], [cx + h, cy + h], 1],
    [[cx + h, cy + h], [cx - h, cy + h], 2],
    [[cx - h, cy + h], [cx - h, cy - h], 3],
  ])
    out.push(...run(a, b, { top: top - (low % 2) * 24, thick: 26, pieces: Math.max(2, Math.round(size / 48)), gaps: 0.2, seed: seed + low, texture }));
  out.push(box(cx - h + 10, cy - h + 10, -24, cx + h - 10, cy + h - 10, top - 8, { top: T.concreteC, sides: T.concrete, bottom: T.concrete }));
  // two dark window slits, one over the other, on the face that looks at the courtyard
  for (const z of [top * 0.42, top * 0.7])
    out.push(box(cx - 10, cy - h - 1, z, cx + 10, cy - h + 2, z + 38, T.window));
  return out;
}

/** A sandbag wall: two courses of bags, each bag its own brush, laid along x or y. */
function sandbags(a, b, { z = 0, high = 34, seed = 1, along = "x" } = {}) {
  const out = [];
  const length = along === "x" ? b[0] - a[0] : b[1] - a[1];
  const count = Math.max(2, Math.round(Math.abs(length) / 44));
  const thick = 15;
  for (let i = 0; i < count; i++)
    for (let course = 0; course < 2; course++) {
      const t0 = (i + (course ? 0.18 : 0)) / count;
      const t1 = (i + 0.94 + (course ? 0.18 : 0)) / count;
      const u0 = Math.min(1, t0);
      const u1 = Math.min(1, t1);
      const zz = z + course * 15;
      const n = (i + course * 3 + seed) % 3;
      const texture = n === 0 ? T.sandPale : n === 1 ? T.adobe : T.sandPaleB;
      if (along === "x") {
        const x0 = a[0] + (b[0] - a[0]) * u0;
        const x1 = a[0] + (b[0] - a[0]) * u1;
        out.push(box(x0, a[1] - thick, zz, x1, a[1] + thick, zz + 16, texture));
      } else {
        const y0 = a[1] + (b[1] - a[1]) * u0;
        const y1 = a[1] + (b[1] - a[1]) * u1;
        out.push(box(a[0] - thick, y0, zz, a[0] + thick, y1, zz + 16, texture));
      }
    }
  return out;
}

/** A heap of broken concrete: small boxes tipped and stacked, deterministic for a seed. */
function rubble(x, y, radius = 120, count = 10, seed = 1) {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [];
  for (let i = 0; i < count; i++) {
    const r = 18 + rnd() * 34;
    const px = x + (rnd() - 0.5) * radius * 1.5;
    const py = y + (rnd() - 0.5) * radius * 1.5;
    const h = 12 + rnd() * 34;
    out.push(box(px - r, py - r * 0.7, -12, px + r, py + r * 0.7, h, rnd() < 0.5 ? T.concrete : T.concreteC));
  }
  return out;
}

/** A boulder at the rim: an angular block, turned, half sunk. */
function boulder(x, y, size, high, seed = 1) {
  const b = box(x - size / 2, y - size * 0.36, -30, x + size / 2, y + size * 0.36, high, { top: T.rockB, sides: T.rock, bottom: T.rockC });
  return M.turned([b], (seed * 37) % 180, [x, y, 0]);
}

/**
 * The wreck of a car: a rusted body, a cabin, four wheels, all in the map's own coordinates round (x, y), then
 * turned about that point. (A turn keeps every point in the map's coordinates: a body drawn round the origin
 * would be carried somewhere else on the map and leave the wheels where they are.)
 */
function carWreck(x, y, degrees, seed = 1) {
  const part = (x0, y0, z0, x1, y1, z1, texture) => box(x + x0, y + y0, z0, x + x1, y + y1, z1, texture);
  const body = [
    part(-82, -34, 4, 82, 34, 36, { top: T.rustB, sides: T.rust, bottom: T.rust }),
    part(-76, -30, 36, -18, 30, 56, { top: T.rust, sides: T.rustB, bottom: T.rust }),
    part(-14, -30, 36, 40, 30, 62, { top: T.rustB, sides: T.rust, bottom: T.rust }),
    part(-70, -31, 40, -26, -28, 54, T.window),
    part(-70, 28, 40, -26, 31, 54, T.window),
    part(-10, -31, 40, 34, -28, 56, T.window),
    part(-10, 28, 40, 34, 31, 56, T.window),
  ];
  for (const [sx, sy] of [[-52, -34], [44, -34], [-52, 34], [44, 34]])
    body.push(M.cylinder("x", [y + sy, 18], 15, x + sx - 7, x + sx + 7, T.metal, { sides: 10, snap: 1 }));
  return M.turned(body, degrees, [x, y, 0]);
}

/** A telegraph pole with two crossarms; the wires are laid between them separately. */
function pole(x, y, high = 330) {
  const out = [
    box(x - 7, y - 7, -24, x + 7, y + 7, high, T.wood),
    box(x - 52, y - 4, high - 26, x + 52, y + 4, high - 18, T.woodB),
    box(x - 40, y - 3, high - 58, x + 40, y + 3, high - 52, T.woodB),
  ];
  for (const dx of [-44, -20, 20, 44])
    for (const dz of [high - 34, high - 64]) out.push(box(x + dx - 4, y - 4, dz, x + dx + 4, y + 4, dz + 8, T.rust));
  return out;
}

/** The water tower: four legs, cross-braced, under a rusted tank. */
function waterTower(x, y) {
  const out = [];
  for (const [dx, dy] of [[-84, -84], [84, -84], [84, 84], [-84, 84]])
    out.push(box(x + dx - 10, y + dy - 10, -24, x + dx + 10, y + dy + 10, 270, T.rust));
  for (const z of [80, 150, 220])
    for (const [ax, ay, bx, by] of [[-84, -84, 84, -84], [84, -84, 84, 84], [84, 84, -84, 84], [-84, 84, -84, -84]])
      out.push(box(x + Math.min(ax, bx) - 3, y + Math.min(ay, by) - 3, z, x + Math.max(ax, bx) + 3, y + Math.max(ay, by) + 3, z + 6, T.rustB));
  out.push(M.cylinder("z", [x, y], 112, 262, 372, T.rustB, { sides: 18, snap: 1 }));
  out.push(M.cylinder("z", [x, y], 118, 356, 372, T.rust, { sides: 18, snap: 1 }));
  out.push(M.cylinder("z", [x, y], 20, 372, 400, T.rust, { sides: 10, snap: 1 }));
  for (let k = 0; k < 4; k++) out.push(box(x - 118, y + (k * 58) - 116, 300, x + 118, y + (k * 58) - 112, 306, T.rust));
  return out;
}

/** The radio mast: a tapered lattice of timber and steel, its top just under the rim. */
function radioMast(x, y) {
  const out = [box(x - 36, y - 36, -24, x + 36, y + 36, 44, T.concrete)];
  const pieces = [[22, 44, 300], [16, 300, 440], [10, 440, 570]];
  for (const [half, z0, z1] of pieces) out.push(box(x - half, y - half, z0, x + half, y + half, z1, { top: T.rust, sides: T.rustB, bottom: T.rust }));
  for (const [z, reach] of [[170, 86], [300, 66], [440, 44]])
    for (const [ax, ay, bx, by] of [[-reach, 0, reach, 0], [0, -reach, 0, reach]])
      out.push(box(x + ax - 4, y + ay - 4, z, x + bx + 4, y + by + 4, z + 8, T.rust));
  return out;
}

/** A fallen stretch of elevated road: two piers, a broken deck, and a parapet still standing on one side. */
function overpass(x0, x1, y) {
  const out = [];
  for (const px of [x0 + 90, x1 - 90]) {
    out.push(box(px - 26, y - 74, -24, px + 26, y + 74, 176, { top: T.concrete, sides: T.concreteC, bottom: T.concrete }));
    out.push(box(px - 40, y - 86, 160, px + 40, y + 86, 176, T.concreteC));
  }
  out.push(box(x0, y - 74, 176, x0 + 230, y + 74, 200, { top: T.asphalt, sides: T.concreteC, bottom: T.concrete }));
  out.push(box(x1 - 190, y - 74, 176, x1, y + 74, 200, { top: T.asphalt, sides: T.concreteC, bottom: T.concrete }));
  out.push(...run([x0 + 230, y - 74], [x1 - 190, y - 74], { bottom: 176, top: 232, thick: 14, pieces: 12, gaps: 0.4, seed: 71, texture: T.wire }));
  out.push(...run([x0 + 230, y + 74], [x1 - 190, y + 74], { bottom: 176, top: 232, thick: 14, pieces: 12, gaps: 0.5, seed: 72, texture: T.wire }));
  out.push(box(x0 + 230, y - 74, 176, x0 + 280, y + 74, 184, T.rust));
  out.push(box(x1 - 240, y - 74, 176, x1 - 190, y + 74, 184, T.rust));
  return out;
}

// ---- the ground ------------------------------------------------------------------------------------
/** The lakebed's hummocks, its banks against the rim, and the cracked patches in it. */
function ground() {
  const bowl = M.planSpace(BOWL_SPACE, 0);
  const wash = M.planSpace(WASH_SPACE, 1);
  const sides = BOWL.map((p, i) => ({ from: p, to: BOWL[(i + 1) % BOWL.length] }));
  const relief = M.reliefOf({
    space: bowl,
    others: [wash],
    sides,
    amp: 4,
    bank: 44,
    bankWide: 380,
    wide: 560,
    step: 96,
    fade: 180,
    seed: 11,
    texture: T.sand,
    clear: CLEAR,
    patches: [
      { texture: T.sandCracked, share: 0.18, wide: 220 },
    ],
    lift: 1,
  });
  return { brushes: relief.brushes, heightAt: relief.heightAt, steep: relief.steep };
}

// ---- the central ruin ------------------------------------------------------------------------------
const RUIN = { x: 344, north: 472, south: -328, apronX: 224, apronS: -280, apronN: 400 };

function centralRuin() {
  const out = [];
  const { x, north, south } = RUIN;
  // the slab the courtyard stands on, laid over the wash
  out.push(box(-RUIN.apronX, RUIN.apronS, -24, RUIN.apronX, RUIN.apronN, 0, { top: T.paving, sides: T.concreteC, bottom: T.concreteC }));
  // the courtyard's edge, broken where the wash runs on under it
  for (const s of [-1, 1])
    for (const [y0, y1] of [[-270, -150], [-110, 110], [150, 260]]) {
      const x0 = s * RUIN.apronX;
      out.push(box(Math.min(x0, x0 + s * 26), y0, -18, Math.max(x0, x0 + s * 26), y1, -6, T.concreteC));
      out.push(...rubble(s * (RUIN.apronX - 10), (y0 + y1) / 2, 40, 3, 90 + s + y0));
    }
  // the four walls, each with its breaches
  for (const s of [-1, 1]) {
    const wx = s * 328;
    out.push(...run([wx, -320], [wx, -120], { top: 220, seed: 10 + s, texture: T.blockB }));
    out.push(...run([wx, -60], [wx, 160], { top: 240, seed: 12 + s, texture: T.blockB }));
    out.push(...run([wx, 240], [wx, 440], { top: 200, seed: 14 + s, texture: T.blockB }));
    out.push(...run([-s * x, north], [-s * 100, north], { top: 270, seed: 16 + s, texture: T.concreteC }));
    out.push(...run([-s * x, south], [-s * 80, south], { top: 210, seed: 18 + s, texture: T.concreteC }));
    out.push(...tower(s * 270, 372, 128, s > 0 ? 330 : 368, 5 + s));
  }
  // the upper slab over the north half, on four columns, with a stair up from the courtyard
  out.push(box(-224, 120, 144, 224, 400, 160, { top: T.concrete, sides: T.concreteC, bottom: T.concreteC }));
  for (const [cx, cy] of [[-180, 160], [180, 160], [-180, 360], [180, 360]])
    out.push(box(cx - 18, cy - 18, -16, cx + 18, cy + 18, 144, { top: T.concreteC, sides: T.concrete, bottom: T.concrete }));
  out.push(...M.stairs([-64, -40, 0], [64, 120, 144], "+y", T.concreteC, { steps: 9, tread: 17, ramp: "CLIP" }));
  // the slab's broken parapet
  for (const s of [-1, 1])
    out.push(...run([s * 224, 120], [s * 224, 400], { bottom: 160, top: 198, thick: 20, pieces: 5, gaps: 0.35, seed: 31 + s, texture: T.concreteC }));
  out.push(...run([-224, 400], [224, 400], { bottom: 160, top: 206, thick: 20, pieces: 6, gaps: 0.3, seed: 33, texture: T.concreteC }));
  // a fallen column in the south breach, and shards at the corners
  out.push(M.turned([box(-150, -12, -8, 150, 12, 34, { top: T.concrete, sides: T.concreteC, bottom: T.concrete })], 8, [0, -328, 0]));
  for (const [dx, dy, size, high, seed] of [[-300, -290, 90, 80, 1], [300, -290, 76, 64, 2], [-390, 120, 70, 110, 3], [390, 120, 96, 72, 4], [0, -380, 70, 48, 5]])
    out.push(...M.turned([box(dx - size / 2, dy - size / 3, -16, dx + size / 2, dy + size / 3, high, T.concreteC)], 22 * seed, [dx, dy, 0]));
  // timber and rebar left in the courtyard
  for (const [bx, by, deg] of [[-180, -210, 22], [200, -150, -30], [-90, 80, 8]])
    out.push(M.turned([box(bx - 80, by - 5, 0, bx + 80, by + 5, 10, T.woodB)], deg, [bx, by, 0]));
  return out;
}

// ---- the west and east courtyard ruins -------------------------------------------------------------
/** A walled courtyard ruin, its gate facing the centre; `cx` is its centre, negative west. */
function courtRuin(cx, seed) {
  const out = [];
  const s = Math.sign(cx); // +1 east, -1 west
  const near = cx - s * 330; // the wall towards the centre
  const far = cx + s * 350; // the wall away from it
  const half = 350;
  const y0 = -360;
  const y1 = 440;
  // the slab over the wash, and its broken lip
  out.push(box(cx - 320, -300, -24, cx + 320, 380, 0, { top: T.paving, sides: T.concreteC, bottom: T.concreteC }));
  for (const yy of [-290, -120, 120, 290]) out.push(...rubble(cx + (yy % 2 ? 300 : -300), yy, 36, 3, seed + yy));
  // the far wall, the two side walls with their breaches, the near wall with its gate
  out.push(...run([far, y0], [far, y1], { top: 250, seed, texture: T.blockC }));
  out.push(...run([cx - half, y0], [cx + half, y0], { top: 180, gaps: 0.34, seed: seed + 1, texture: T.blockB }));
  out.push(...run([cx - half, y1], [cx + half, y1], { top: 240, gaps: 0.28, seed: seed + 2, texture: T.blockB }));
  out.push(...run([near, y0], [near, -110], { top: 210, seed: seed + 3, texture: T.blockC }));
  out.push(...run([near, 110], [near, y1], { top: 230, seed: seed + 4, texture: T.blockC }));
  // the gate's pillars and a lintel with a piece fallen out of it
  for (const yy of [-110, 110]) out.push(box(near - 26, yy - 16, -24, near + 26, yy + 16, 220, { top: T.concreteC, sides: T.concrete, bottom: T.concrete }));
  out.push(...run([near, -96], [near, 96], { bottom: 190, top: 236, thick: 28, pieces: 4, gaps: 0.32, seed: seed + 5, texture: T.concreteC }));
  // two towers on the far corners
  out.push(...tower(far + s * 24, -330, 112, 328, seed + 6));
  out.push(...tower(far + s * 24, 410, 112, 292, seed + 7));
  // the fallen roof over the north third, on four columns
  out.push(box(cx - 250, 190, 124, cx + 250, 390, 140, { top: T.concrete, sides: T.concreteC, bottom: T.concreteC }));
  for (const [dx, dy] of [[-210, 220], [210, 220], [-210, 360], [210, 360]])
    out.push(box(cx + dx - 16, dy - 16, -16, cx + dx + 16, dy + 16, 124, { top: T.concreteC, sides: T.concrete, bottom: T.concrete }));
  for (const dx of [-190, 190]) out.push(...rubble(cx + dx, 300, 60, 6, seed + 10 + dx));
  // the courtyard's own debris, clear of the capture point's middle
  out.push(...rubble(cx - 260, 40, 70, 8, seed + 20));
  out.push(...rubble(cx + 260, -40, 70, 8, seed + 21));
  for (const [dx, dy, deg] of [[-170, -220, 18], [190, -200, -24], [220, 120, 40]])
    out.push(M.turned([box(cx + dx - 70, dy - 5, 0, cx + dx + 70, dy + 5, 10, T.woodB)], deg, [cx + dx, dy, 0]));
  return out;
}

// ---- the smaller compounds on the diagonal lanes ---------------------------------------------------
/** A roofless compound of `half` units square, one side open, a few gaps in the rest; `roof` covers the half
 *  away from the opening, on the walls and two posts, the way the huts in the lanes were left standing. */
function compound(cx, cy, openSide, seed, { half = 140, roof = false } = {}) {
  const out = [];
  const h = half;
  for (const [side, a, b] of [
    ["north", [cx - h, cy + h], [cx + h, cy + h]],
    ["south", [cx - h, cy - h], [cx + h, cy - h]],
    ["west", [cx - h, cy - h], [cx - h, cy + h]],
    ["east", [cx + h, cy - h], [cx + h, cy + h]],
  ]) {
    if (side === openSide) continue;
    out.push(...run(a, b, { top: side === "north" ? 170 : 140, gaps: 0.3, seed: seed + side.length, texture: T.blockB }));
  }
  out.push(...rubble(cx - 30, cy + 10, 60, 8, seed + 44));
  out.push(M.turned([box(cx - 60, cy - 24, 0, cx + 60, cy + 24, 30, { top: T.rustB, sides: T.rust, bottom: T.rust })], 18, [cx, cy, 0]));
  if (roof) {
    // the slab over the half away from the opening, and the two posts that carry its free edge
    const over = {
      south: [cx - h, cy, cx + h, cy + h],
      north: [cx - h, cy - h, cx + h, cy],
      east: [cx, cy - h, cx + h, cy + h],
      west: [cx - h, cy - h, cx, cy + h],
    }[openSide];
    out.push(box(over[0], over[1], 124, over[2], over[3], 140, { top: T.concrete, sides: T.concreteC, bottom: T.concreteC }));
    for (const [px, py] of {
      south: [[cx - h + 16, cy + 16], [cx + h - 16, cy + 16]],
      north: [[cx - h + 16, cy - 16], [cx + h - 16, cy - 16]],
      east: [[cx + 16, cy - h + 16], [cx + 16, cy + h - 16]],
      west: [[cx - 16, cy - h + 16], [cx - 16, cy + h - 16]],
    }[openSide])
      out.push(box(px - 10, py - 10, 0, px + 10, py + 10, 124, T.wood));
    out.push(...rubble(cx + (openSide === "east" ? -h / 2 : openSide === "west" ? h / 2 : 0), cy + (openSide === "north" ? h / 2 : openSide === "south" ? -h / 2 : 0), 50, 4, seed + 55));
  }
  return out;
}

/** A lane ruin: the footings of a house stripped by the storm, its two long walls broken low, one end wall
 *  still standing, and its rubble. `deg` turns it about its centre. */
function laneRuin(cx, cy, deg, { length = 300, wide = 180, top = 120, seed = 1 } = {}) {
  const out = [];
  const pieces = Math.max(2, Math.round(length / 110));
  out.push(...run([-length / 2, -wide / 2], [length / 2, -wide / 2], { top, thick: 26, gaps: 0.4, pieces, seed, texture: T.blockB }));
  out.push(...run([-length / 2, wide / 2], [length / 2, wide / 2], { top: top - 28, thick: 26, gaps: 0.5, pieces, seed: seed + 1, texture: T.blockB }));
  out.push(...run([-length / 2, -wide / 2], [-length / 2, wide / 2], { top: top + 26, thick: 26, gaps: 0.3, pieces: 2, seed: seed + 2, texture: T.blockC }));
  out.push(...rubble(length / 2 - 30, 0, 90, 7, seed + 3));
  return M.turned(out, deg, [cx, cy, 0]);
}

/** The jagged faces that stand along the rim's foot, their tops breaking the flat line of the rock. */
function rimCliffs() {
  const out = [];
  for (let i = 0; i < BOWL.length; i++) {
    const [ax, ay] = BOWL[i];
    const [bx, by] = BOWL[(i + 1) % BOWL.length];
    const length = Math.hypot(bx - ax, by - ay);
    if (length < 300) continue;
    const ux = (bx - ax) / length;
    const uy = (by - ay) / length;
    // the bowl is anticlockwise, so its inside is to the left of each edge; the buttress straddles the rim
    const nx = -uy;
    const ny = ux;
    const a = [ax + ux * 24 + nx * 24, ay + uy * 24 + ny * 24];
    const b = [ax + ux * (length - 24) + nx * 24, ay + uy * (length - 24) + ny * 24];
    out.push(
      ...run(a, b, {
        bottom: -24,
        top: RIM + 50 - (i % 3) * 30,
        low: RIM - 90 + (i % 4) * 20,
        thick: 150,
        pieces: Math.max(3, Math.round(length / 120)),
        gaps: 0.06,
        rubble: 24,
        seed: i + 1,
        texture: i % 4 === 0 ? T.rockB : T.canyonB,
      }),
    );
  }
  return out;
}

// ---- the forts -------------------------------------------------------------------------------------
/** A fort at one end: a broken walled yard, two towers at its back, a flag plinth and the spawn ground. */
function fort(side, seed) {
  const out = [];
  const Y = (v) => side * v;
  // the front wall, with a 320 gate: two stretches and two pillars
  for (const s of [-1, 1])
    out.push(...run([s * 160, Y(980)], [s * 520, Y(980)], { top: 170, gaps: 0.2, seed: seed + s, texture: T.blockB }));
  for (const s of [-1, 1])
    out.push(box(s * 144, Math.min(Y(962), Y(998)), -24, s * 176, Math.max(Y(962), Y(998)), 220, { top: T.concreteC, sides: T.adobe, bottom: T.adobe }));
  out.push(...run([-176, Y(980)], [176, Y(980)], { bottom: 188, top: 230, thick: 30, pieces: 5, gaps: 0.34, seed: seed + 3, texture: T.concreteC }));
  // the side walls and the back wall
  for (const s of [-1, 1])
    out.push(...run([s * 512, Y(980)], [s * 512, Y(1540)], { top: 210, gaps: 0.22, seed: seed + 4 + s, texture: T.blockB }));
  out.push(...run([-520, Y(1540)], [520, Y(1540)], { top: 250, gaps: 0.14, seed: seed + 6, texture: T.blockC }));
  // the towers at the back corners
  out.push(...tower(-440, Y(1500), 112, 306, seed + 7));
  out.push(...tower(440, Y(1500), 112, 280, seed + 8));
  // the scree bank between the back wall and the rim, so the strip behind the fort is no trap
  out.push(...run([-620, Y(1640)], [620, Y(1640)], { bottom: -24, top: 190, low: 100, thick: 220, pieces: 10, gaps: 0, rubble: 0, seed: seed + 12, texture: T.rock }));
  // the flag plinth, its corner posts, and the broken arch over it
  out.push(box(-64, Y(1406), -24, 64, Y(1534), 8, { top: T.paving, sides: T.concreteC, bottom: T.concreteC }));
  for (const dx of [-52, 52])
    for (const dy of [-52, 52]) out.push(box(dx - 8, Y(1470 + dy) - 8, 8, dx + 8, Y(1470 + dy) + 8, 54, T.block));
  for (const s of [-1, 1]) out.push(box(s * 108 - 12, Y(1470) - 12, -24, s * 108 + 12, Y(1470) + 12, 196, { top: T.adobe, sides: T.block, bottom: T.block }));
  out.push(...run([-108, Y(1470)], [108, Y(1470)], { bottom: 174, top: 212, thick: 24, pieces: 5, gaps: 0.3, seed: seed + 9, texture: T.adobe }));
  // sandbags inside the gate, crates along the side walls, barrels in the corners
  out.push(...sandbags([-260, Y(1000)], [-60, Y(1000)], { seed: seed + 10, high: 36 }));
  out.push(...sandbags([60, Y(1000)], [260, Y(1000)], { seed: seed + 11, high: 36 }));
  for (const [x, y, w, d, h] of [[-470, 1120, 56, 56, 42], [-420, 1190, 44, 60, 36], [430, 1140, 60, 50, 48], [470, 1240, 44, 44, 30], [320, 1470, 50, 40, 34]])
    out.push(box(x - w / 2, Y(y) - d / 2, 0, x + w / 2, Y(y) + d / 2, h, { top: T.wood, sides: T.woodB, bottom: T.wood }));
  for (const [x, y] of [[-390, 1450], [390, 1450]])
    out.push(M.cylinder("z", [x, Y(y)], 22, 0, 62, T.rust, { sides: 12, snap: 1 }));
  return out;
}

// ---- everything that stands in the bowl ------------------------------------------------------------
function dressing() {
  const detail = [];
  const lights = [];
  const glows = [];
  const g = ground();
  detail.push(...g.brushes);
  detail.push(...centralRuin());
  detail.push(...courtRuin(-980, 40));
  detail.push(...courtRuin(980, 40));
  for (const side of [1, -1]) detail.push(...fort(side, side > 0 ? 100 : 200));
  detail.push(...compound(-520, 600, "south", 300));
  detail.push(...compound(520, 600, "south", 320));
  detail.push(...compound(-560, -760, "north", 340));
  detail.push(...compound(560, -760, "north", 360));
  // the two huts that still have half a roof, in the lanes behind the side compounds
  detail.push(...compound(-810, 900, "south", 380, { half: 100, roof: true }));
  detail.push(...compound(810, -900, "north", 400, { half: 100, roof: true }));
  detail.push(...rimCliffs());
  // the footings of houses along the four diagonal lanes
  for (const [x, y, deg, seed] of [[-1120, 980, 18, 12], [1120, 980, -24, 13], [-1120, -980, -30, 14], [1120, -980, 24, 15]])
    detail.push(...laneRuin(x, y, deg, { length: 300 + (seed % 2) * 60, wide: 180, top: 110 + (seed % 3) * 18, seed }));
  detail.push(...waterTower(-1250, -950));
  detail.push(...radioMast(1450, 1200));
  detail.push(...overpass(1080, 1580, -1120));
  for (const [x, y, deg, seed] of [[-760, 280, 30, 1], [760, -420, -25, 2], [-360, -900, 60, 3], [1000, 700, 110, 4]])
    detail.push(...carWreck(x, y, deg, seed));
  // the telegraph lines down the west and east sides, wires between the poles
  for (const x of [-1520, 1520]) {
    for (const y of [-1200, -800, -400, 0, 400, 800, 1200]) detail.push(...pole(x, y));
    for (let i = 0; i < 6; i++) {
      const y0 = -1200 + i * 400;
      const y1 = y0 + 400;
      for (const dx of [-24, 24]) detail.push(box(x + dx - 1, y0, 298, x + dx + 1, y1, 300, T.wire));
    }
  }
  // boulders along the foot of the rim
  for (let i = 0; i < BOWL.length; i++) {
    const [ax, ay] = BOWL[i];
    const [bx, by] = BOWL[(i + 1) % BOWL.length];
    const runLength = Math.hypot(bx - ax, by - ay);
    const count = Math.max(1, Math.round(runLength / 260));
    for (let k = 0; k < count; k++) {
      const t = (k + 0.5) / count;
      const x = ax + (bx - ax) * t;
      const y = ay + (by - ay) * t;
      // inward: the bowl is anticlockwise, so the inside is to the left of each edge
      const nx = -(by - ay) / runLength;
      const ny = (bx - ax) / runLength;
      const inward = 60 + ((i * 37 + k * 53) % 90);
      const size = 46 + ((i * 31 + k * 47) % 90);
      const px = x + nx * inward;
      const py = y + ny * inward;
      if (MUTANTS.some(([mx, my]) => Math.hypot(px - mx, py - my) < 150)) continue;
      detail.push(...boulder(px, py, size, 34 + ((i * 17 + k * 29) % 120), i * 7 + k));
    }
  }
  // rubble and the barrels that mark the held places
  for (const [x, y, r, n, s] of [[-680, -180, 140, 12, 1], [680, 200, 140, 12, 2], [-430, 1150, 100, 9, 3], [430, -1150, 100, 9, 4], [-1240, 680, 120, 10, 5], [1240, -680, 120, 10, 6], [0, 300, 90, 7, 7]])
    detail.push(...rubble(x, y, r, n, s));
  for (const [x, y, s] of [[-160, 1000, 1], [160, 1000, 2], [-160, -1000, 3], [160, -1000, 4], [-900, 200, 5], [900, 200, 6], [-270, 700, 7], [270, -700, 8], [90, -80, 9], [-1250, -800, 10]])
    detail.push(M.cylinder("z", [x, y], 18, 0, 46, s % 2 ? T.rust : T.rustB, { sides: 12, snap: 1 }));
  // the fire barrels: their light warm and flickering low over the sand, their flames drawn by sprites
  for (const [x, y] of [[-160, 1000], [160, 1000], [-160, -1000], [160, -1000], [-900, 200], [900, 200], [-270, 700], [270, -700], [90, -80], [-1250, -800]]) {
    lights.push(M.light([x, y, 62], { color: [255, 150, 70], brightness: 95, style: 10 }));
    glows.push(M.pointEntity("env_sprite", [x, y, 58], { model: "sprites/fire.spr", rendermode: 5, renderamt: 255, framerate: 12, scale: 0.55, spawnflags: 1 }));
    glows.push(M.pointEntity("env_sprite", [x, y, 52], { model: "sprites/glow04.spr", rendermode: 5, renderamt: 55, rendercolor: [255, 158, 84], scale: 1.6, framerate: 0, spawnflags: 1 }));
  }
  return { detail, lights, glows, heightAt: g.heightAt, steep: g.steep };
}

// ---- the modes' points -----------------------------------------------------------------------------
/** The four places both assault and uplink fight over, and the uplink's own point in the central ruin. */
const POINTS = {
  tsm_as_1: [0, 760, 0],
  tsm_as_2: [-980, 40, 0],
  tsm_as_3: [980, 40, 0],
  tsm_as_4: [0, -760, 0],
};
const UPLINK = {
  tsm_cap_1: POINTS.tsm_as_1,
  tsm_cap_2: POINTS.tsm_as_2,
  tsm_cap_3: POINTS.tsm_as_3,
  tsm_cap_4: POINTS.tsm_as_4,
  tsm_cap_5: [0, -140, 0],
  tsm_uplink: [0, -140, 0],
};

/** The base spawns: four rows of four behind each gate, facing the middle. */
function basePoints(side) {
  return [1040, 1148, 1256, 1364].flatMap((y) =>
    [-192, -64, 64, 192].map((x) => ({ team: side > 0 ? 1 : 2, at: [x, side * y, 0], yaw: side > 0 ? 270 : 90, tier: 0 })),
  );
}

/** Four spawns round a point, on its courtyard or its clear ground, each facing it. */
function aroundPoint([x, y, z], team, tier) {
  return [[x, y - 120], [x, y + 120], [x - 120, y], [x + 120, y]].map(([px, py]) => ({
    team,
    at: [px, py, z],
    yaw: (Math.atan2(y - py, x - px) * 180) / Math.PI,
    tier,
  }));
}

/** Where each side starts in a variant, and every spawn set its spawn config carries. */
function spawnPoints(variant) {
  if (variant === "ws") {
    const out = [];
    for (const y of [720, 790, 860, 930])
      for (const x of [-192, -64, 64, 192])
        out.push({ team: 1, at: [x, y, 0], yaw: 90, tier: 0 });
    for (const [x, y] of MUTANTS)
      out.push({ team: 2, at: [x, y, 2], yaw: (Math.atan2(-y, -x) * 180) / Math.PI, tier: 0 });
    return out;
  }
  const out = [...basePoints(1), ...basePoints(-1)];
  if (variant === "as")
    Object.entries(POINTS).forEach(([, point], n) => {
      for (const team of [1, 2]) out.push(...aroundPoint(point, team, n + 1));
    });
  return out;
}

/** The map's spawn entities: each side's own class, and a deathmatch one beside it for TS's fallback. */
const spawnEntities = (variant) =>
  spawnPoints(variant).flatMap(({ team, at, yaw }) => [M.playerStart(at, yaw, `info_player_team${team}`), M.playerStart(at, yaw, "info_player_deathmatch")]);

/** ts_matchmode's spawn config: tsm_spawn <team> <x> <y> <z> <pitch> <yaw> <tier>, z the origin. */
const spawnConfig = (name, variant) =>
  [
    `// ts_matchmode spawn points for ${name} -- written by export-map/h9_wasteland/wasteland.mjs`,
    "// tsm_spawn <team> <x> <y> <z> <pitch> <yaw> <tier>",
    ...spawnPoints(variant).map(
      ({ team, at, yaw, tier }) => `tsm_spawn ${team} ${at[0].toFixed(2)} ${at[1].toFixed(2)} ${(at[2] + 37).toFixed(2)} 0.00 ${yaw.toFixed(2)} ${tier}`,
    ),
    "",
  ].join("\r\n");

/** The assault points, for the map config the plugin reads before the map's own entities. */
const assaultConfig = (name) =>
  [
    `// ts_assault capture points for ${name} -- written by export-map/h9_wasteland/wasteland.mjs`,
    "// tsm_as_zone <n> <x> <y> <z> <radius>   (point n's spawn set is tier n of the map's tsm_spawns file)",
    "tsm_as_zone 1 0.00 760.00 0.00 180.00   // the north gate flat, before the fort",
    "tsm_as_zone 2 -980.00 40.00 0.00 320.00   // the west courtyard",
    "tsm_as_zone 3 980.00 40.00 0.00 320.00   // the east courtyard",
    "tsm_as_zone 4 0.00 -760.00 0.00 180.00   // the south gate flat, before the fort",
    "",
  ].join("\r\n");

/** What the server sends a player along with the map: the six sides of its sky. */
const resList = (name) =>
  [`// ${name}: sent with the map to a player who joins without it`, ...M.SKY_SIDES.map((side) => `gfx/env/${SKY_NAME}${side}.tga`), ""].join("\r\n");

/** What each map is called in the game's own title for it. */
const TITLES = {
  te: "Wasteland -- Team Elimination",
  up: "Wasteland -- Capture the Uplink",
  ws: "Wasteland -- Wave Survival",
  mw: "Wasteland -- Mech Warrior",
  as: "Wasteland -- Assault",
  ctf: "Wasteland -- Capture the Flag",
};

/** The match each map is built for: the settings ts\h9_autoconfig applies from ts\mapconfigs on load. */
const MAP_CONFIG = {
  te: {
    note: "Team Elimination needs no more than the map: the sides' forts, their spawns and the ruins between them.",
    lines: [],
  },
  up: {
    note: "The uplink mode takes the map by the zones and the point it carries (tsm_cap_1..5, tsm_uplink); the round is long enough to carry the uplink through the ruins and hold all five.",
    lines: ["tsm_respawns 1", "tsm_roundtime 480"],
  },
  ws: {
    note: "The survival mode takes the map by its name (h9_ws_): the survivors hold the north flat, the mutants come in from the rim.",
    lines: ["tsm_respawns 1", "tsm_bots 12"],
  },
  mw: {
    note: "The Mech Warrior mode takes the map by its name (h9_mw_): room for the Mechs between the forts and the ruins, and a round long enough for them to cross it.",
    lines: ["tsm_respawns 1", "tsm_roundtime 480"],
  },
  as: {
    note: "The assault mode takes the map by its capture points (configs/tsm_assault_<map>.cfg) and the spawn tiers in its tsm_spawns file.",
    lines: ["tsm_respawns 1", "tsm_roundtime 900"],
  },
  ctf: {
    note: "The flag mode takes the map by the two pads it carries (tsm_flag_1 and tsm_flag_2), one at the back of each fort.",
    lines: ["tsm_respawns 1", "tsm_roundtime 600"],
  },
};
const mapConfig = (name, variant) =>
  [
    `// h9_autoconfig map config for ${name}: ${TITLES[variant].replace("Wasteland -- ", "")}.`,
    `// ${MAP_CONFIG[variant].note}`,
    "// ts_matchmode.cfg sets these back on the next map.",
    "",
    `echo "[h9_autoconfig] ${name}.cfg applied"`,
    "",
    ...MAP_CONFIG[variant].lines,
    "",
  ].join("\r\n");

/** The mode's own entities, and the map's spawns. */
function entitiesFor(variant) {
  const out = [...spawnEntities(variant)];
  if (variant === "up")
    for (const [targetname, at] of Object.entries(UPLINK)) out.push(M.pointEntity("info_target", at, { targetname }));
  if (variant === "as")
    for (const [targetname, at] of Object.entries(POINTS)) out.push(M.pointEntity("info_target", at, { targetname }));
  if (variant === "ctf") {
    out.push(M.pointEntity("info_target", [0, 1470, 8], { targetname: "tsm_flag_1" }));
    out.push(M.pointEntity("info_target", [0, -1470, 8], { targetname: "tsm_flag_2" }));
  }
  return out;
}

/** The place's sounds: the storm over everything, its gusts in the ruins, and old battle far off. */
const HEARD = { everywhere: 1, small: 2, medium: 4, large: 8 };
const START_SILENT = 16;
const ONCE = 32;
const loop = (file, at, volume, heard, pitch = 100) =>
  M.pointEntity("ambient_generic", at, { message: file, health: volume, pitch, spawnflags: HEARD[heard] });

function sounds() {
  return [
    loop("ambience/des_wind1.wav", [0, 0, 320], 5, "everywhere", 96),
    loop("ambience/des_wind2.wav", [-1200, -900, 200], 4, "medium", 92),
    loop("ambience/des_wind3.wav", [1200, 900, 200], 4, "medium", 104),
    loop("ambience/des_wind1.wav", [0, -1400, 160], 3, "small", 110),
    loop("ambience/des_wind2.wav", [1400, -300, 160], 3, "small", 88),
    // the map is one open bowl: one long echo, and a duller one in the courtyards
    M.pointEntity("env_sound", [0, 0, 240], { radius: 1600, roomtype: 21 }),
    M.pointEntity("env_sound", [-980, 40, 100], { radius: 420, roomtype: 21 }),
    M.pointEntity("env_sound", [980, 40, 100], { radius: 420, roomtype: 21 }),
    // two old bursts out beyond the rim, fired once each as the map opens
    M.pointEntity("ambient_generic", [0, 0, 480], { targetname: "waste_far_1", message: "ambience/distantmortar1.wav", health: 4, spawnflags: HEARD.everywhere + START_SILENT + ONCE }),
    M.pointEntity("ambient_generic", [0, 0, 480], { targetname: "waste_far_2", message: "ambience/mgun_burst3.wav", health: 3, pitch: 88, spawnflags: HEARD.everywhere + START_SILENT + ONCE }),
    M.pointEntity("trigger_auto", [0, 0, 480], { target: "waste_far_1", delay: 17, triggerstate: 2 }),
    M.pointEntity("trigger_auto", [32, 0, 480], { target: "waste_far_2", delay: 43, triggerstate: 2 }),
  ];
}

// ---- build -----------------------------------------------------------------------------------------
function build(variant) {
  const { detail, lights, glows } = dressing();
  const spaces = [BOWL_SPACE, WASH_SPACE];
  const rock = M.carvePlan(spaces, 64, { floor: T.sand, wall: T.canyon, ceiling: T.sky });
  return {
    worldspawn: {
      wad: Object.values(WADS).filter(existsSync),
      skyname: SKY_NAME,
      MaxRange: 8192,
      message: TITLES[variant],
    },
    brushes: [...rock],
    entities: [
      // the storm's light: a low warm sun in the south-west, and the haze's dull fill from every side
      M.sunLight([0, 0, SKY_Z - 96], {
        pitch: -22,
        yaw: 30,
        color: [255, 216, 166],
        brightness: 200,
        _diffuse_light: [150, 128, 96, 120],
      }),
      ...lights,
      ...glows,
      M.brushEntity("func_detail", detail),
      ...sounds(),
      ...entitiesFor(variant),
    ],
  };
}

// ---- write, check, walk, draw ----------------------------------------------------------------------
mkdirSync(OUT, { recursive: true });
mkdirSync(join(OUT, "mapconfigs"), { recursive: true });
const flags = process.argv.slice(2);
const only = (process.env.WASTE_ONLY ?? "").split(",").map((v) => v.trim()).filter(Boolean);
const wanted = ["te", "up", "ws", "mw", "as", "ctf"];
const textures = new Set(Object.values(WADS).filter(existsSync).flatMap((w) => M.wadTextureNames(readFileSync(w))));
const save = (name, img) => writeFileSync(join(OUT, name), K.png(img.width, img.height, img.rgba));

const maps = {};
for (const variant of wanted.filter((v) => !only.length || only.includes(v))) {
  const name = `h9_${variant}_wasteland`;
  const map = build(variant);
  maps[name] = map;
  writeFileSync(join(OUT, `${name}.map`), M.writeMap(map));
  writeFileSync(join(OUT, `tsm_spawns_${name}.cfg`), spawnConfig(name, variant));
  writeFileSync(join(OUT, `${name}.res`), resList(name));
  writeFileSync(join(OUT, "mapconfigs", `${name}.cfg`), mapConfig(name, variant));
  if (variant === "as") writeFileSync(join(OUT, `tsm_assault_${name}.cfg`), assaultConfig(name));
  const plan = M.checkPlan(map, { textures: [...textures] });
  console.log(`\n${name}: ${map.brushes.length} world brushes, ${map.entities.length} entities`);
  for (const e of plan.errors) console.log(`  ERROR ${e}`);
  for (const w of plan.warnings.slice(0, 12)) console.log(`  warn  ${w}`);
  if (plan.leak) console.log(`  LEAK  ${JSON.stringify(plan.leak).slice(0, 200)}`);
  const markers = variant === "up" ? Object.keys(UPLINK) : variant === "as" ? Object.keys(POINTS) : variant === "ctf" ? ["tsm_flag_1", "tsm_flag_2"] : [];
  const reach = M.reachOf(map, { jump: true, markers });
  console.log(`  walk: ${reach.unreached?.length ?? 0} unreached, ${reach.stuck?.length ?? 0} stuck, ${reach.hanging?.length ?? 0} hanging, ${reach.oneWay?.length ?? 0} one-way`);
  for (const w of reach.warnings.slice(0, 12)) console.log(`    ${w}`);
  for (const e of (reach.entities ?? []).filter((e) => /^tsm_/.test(e.targetname ?? "")))
    console.log(`    ${e.targetname}: ${e.reached ? `reached by ${e.how}, ${Math.round(e.far)} units` : `NOT reached (${e.why})`}`);
  if (variant === "te" || variant === "as") {
    save(`${name}-plan.png`, M.planOfSource(map, { reach }));
    if (variant === "as") save(`${name}-plan-high.png`, M.planOfSource(map, { reach, z: 120 }));
  }
}

if (flags.includes("--compile")) {
  const xash = flags.includes("--xash");
  for (const name of Object.keys(maps)) {
    console.log(`\ncompiling ${name}${xash ? " (Xash)" : ""}...`);
    const eng = xash ? ["-engine", "xash"] : [];
    const perTool = [...eng, "-threads", String(process.env.WASTE_THREADS ?? 6)];
    const result = M.compileMap(join(OUT, `${name}.map`), {
      wads: Object.values(WADS).filter(existsSync),
      wadinclude: true,
      out: join(OUT, `${name}.bsp`),
      compilers: { folder: COMPILERS },
      args: { hlcsg: perTool, hlbsp: perTool, hlvis: [...perTool, "-fast"], hlrad: perTool },
      fast: false,
      vis: true,
      light: true,
      timeout: { hlcsg: 900000, hlbsp: 900000, hlvis: 1800000, hlrad: 3600000 },
      keep: false,
    });
    console.log(`  bsp: ${result.bsp ?? "none"}`);
    for (const line of result.errors) console.log(`  ERROR ${line}`);
    for (const line of result.warnings.slice(0, 10)) console.log(`  warn  ${line}`);
    if (result.leak) console.log(`  LEAK from ${result.leak.entity?.classname} at ${result.leak.at}`);
    for (const log of result.logs) console.log(`  ${log.tool}: ${log.code ?? "?"} in ${log.seconds.toFixed(1)}s`);
  }
}

if (flags.includes("--views")) {
  const VIEWS = [
    ["north-gate", [0, 900, 64], [0, 0, 120]],
    ["courtyard", [0, -120, 64], [0, 300, 90]],
    ["courtyard-slab", [0, 40, 160], [0, 420, 140]],
    ["west-court", [-700, 40, 64], [-1240, 40, 90]],
    ["east-court", [700, 40, 64], [1240, 40, 90]],
    ["south-gate", [0, -900, 64], [0, 0, 120]],
    ["wash", [-1500, 0, 44], [900, 0, 50]],
    ["rim", [0, 1200, 100], [1300, 1500, 260]],
    ["overview", [-1500, -1500, 900], [200, 200, 0]],
    ["overview-north", [0, 1200, 800], [0, -1200, 0]],
  ];
  const folders = [SKY_FOLDER, join(GAME_DIR, "ts"), join(GAME_DIR, "valve")];
  const dir = join(OUT, "views");
  mkdirSync(dir, { recursive: true });
  for (const name of Object.keys(maps)) {
    const bspFile = join(OUT, `${name}.bsp`);
    if (!existsSync(bspFile)) continue;
    const bsp = M.readBsp(readFileSync(bspFile));
    for (const [label, from, to] of name.startsWith("h9_te") ? VIEWS : VIEWS.slice(0, 2)) {
      try {
        const img = M.drawMap(bsp, { from, to, width: 640, height: 420, brightness: 1.5, folders, entities: "game", labels: false, models: true });
        writeFileSync(join(dir, `${name}-${label}.png`), K.png(img.width, img.height, img.rgba));
      } catch (e) {
        console.log(`  ${label}: FAILED -- ${e.message}`);
      }
    }
    console.log(`drew ${name} into ${dir}`);
  }
}

if (flags.includes("deploy")) {
  // Both H9 installs: the repo's and the copy under Downloads. Back up anything already there first.
  const t = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const backup = join(OUT, "backups", t);
  const keep = (file) => {
    if (!existsSync(file)) return;
    mkdirSync(backup, { recursive: true });
    const flat = file.split(/[\\/]/).slice(-2).join("_");
    copyFileSync(file, join(backup, flat));
  };
  const installs = [
    join(HERE, "..", "..", "H9XASH", "ts"),
    "D:/Downloads/TSM/H9XASH/ts",
  ];
  // the sky's six sides go beside the game's own, from the shared out\gfx\env
  const envFrom = join(SKY_FOLDER, "gfx", "env");
  let count = 0;
  for (const ts of installs) {
    if (!existsSync(ts)) {
      console.log(`no install at ${ts} -- skipped`);
      continue;
    }
    const mapsDir = join(ts, "maps");
    const configs = join(ts, "addons", "amxmodx", "configs");
    const mapconfigs = join(ts, "mapconfigs");
    const env = join(ts, "gfx", "env");
    mkdirSync(mapsDir, { recursive: true });
    mkdirSync(configs, { recursive: true });
    mkdirSync(mapconfigs, { recursive: true });
    mkdirSync(env, { recursive: true });
    for (const name of Object.keys(maps)) {
      const bspFile = join(OUT, `${name}.bsp`);
      if (!existsSync(bspFile)) {
        console.log(`no ${name}.bsp to deploy -- compile first`);
        continue;
      }
      for (const [from, to] of [
        [bspFile, join(mapsDir, `${name}.bsp`)],
        [join(OUT, `${name}.res`), join(mapsDir, `${name}.res`)],
        [join(OUT, `tsm_spawns_${name}.cfg`), join(configs, `tsm_spawns_${name}.cfg`)],
      ]) {
        keep(to);
        copyFileSync(from, to);
      }
      if (existsSync(join(OUT, `tsm_assault_${name}.cfg`))) {
        const to = join(configs, `tsm_assault_${name}.cfg`);
        keep(to);
        copyFileSync(join(OUT, `tsm_assault_${name}.cfg`), to);
      }
      if (existsSync(join(OUT, "mapconfigs", `${name}.cfg`))) {
        const to = join(mapconfigs, `${name}.cfg`);
        keep(to);
        copyFileSync(join(OUT, "mapconfigs", `${name}.cfg`), to);
      }
      count++;
    }
    for (const side of M.SKY_SIDES) {
      const to = join(env, `${SKY_NAME}${side}.tga`);
      keep(to);
      copyFileSync(join(envFrom, `${SKY_NAME}${side}.tga`), to);
    }
    console.log(`deployed to ${ts}`);
  }
  console.log(`${count} maps deployed; replaced files kept in ${backup}`);
}
