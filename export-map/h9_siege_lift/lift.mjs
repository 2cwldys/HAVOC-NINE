// H9_SIEGE_LIFT: a siege inside a skylift car climbing its tether to orbit, over the burning city (after
// Voyager's "Rise"). The car carries urgent supplies and troops up; Insurgents have boarded underneath and mean
// to stop it -- blow the clamps, cut the power, wreck the drive -- and MSR must keep it climbing.
//
// THE CAR. A round car about 2200 across, the tether up its middle inside a sealed core, three decks stacked:
//   the CARGO deck (bottom)       crates and containers round the core; the tether CLAMPS (tsm_obj_1)
//   the PASSENGER deck (middle)   the troop cabin: seat rows, lockers, partitions; the POWER CORE (tsm_obj_2);
//                                 a band of windows all round
//   the DRIVE deck (top)          the control room and the traction DRIVE on the tether (tsm_obj_3); MSR start
//                                 here
// Under the cargo deck hangs the maintenance POD, where the Insurgents came aboard, with a boarding dock off it.
// Stairs run radially between the decks, two flights each, never stacked. Outside the hull at each deck's floor
// runs the GANTRY, a railed grating ring reached through hatches, its levels joined by ladders: the windy flank.
// Fall off it and you fall a long way (trigger_hurt).
//
// THE WORLD MOVES. No engine can scroll a skybox, so the sky (sky.mjs) stands still far off -- as the far world
// does from a fast lift -- and what is near streams downward past the car: two rings of tall cards of cloud and
// air streaks on func_conveyors (visual, not solid, additive), the tether above and below on another, and cloud
// banks on func_trains drifting down and starting again at the top. The drive's fall (tsm_obj_3's target)
// stops all of it; its reset relay starts it again for the next round.
//
// HOW IT IS BUILT. One space for SMAK's carvePlan -- the air, sky all round -- so the map cannot leak, and the
// car in it as world brushes, laid out in 24 sectors of 15 degrees (sector k spans k*15 to k*15+15, 0 east, 90
// north). Furniture and machinery are func_detail; the gantry gratings and the windows are func_walls.
//
//   node lift.mjs                     write the four maps' .map files (h9_siege_lift, h9_up_lift, h9_ws_lift,
//                                     h9_mw_lift), their spawn configs, .res lists and the .wad, check and walk
//                                     each, and draw the siege's plans, section and storeys (LIFT_ONLY=siege, up,
//                                     ws or mw does one alone)
//   node lift.mjs --compile [--xash]  and compile it
//   node lift.mjs --views             and draw the compiled map from inside, sky and all
//   node lift.mjs deploy              copy the .bsp and .res to ts\maps, the spawn config to AMXX's configs
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GAME_DIR, K, M, WADS } from "../lib.mjs";
import { SKY_FOLDER, SKY_NAME } from "./sky.mjs";
import { LIFT_TEXTURES } from "./textures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const NAME = "h9_siege_lift";
const COMPILERS = "D:/Downloads/TSM/export-map/sdhlt-goldsrc-net/tools";
const LIFT_WAD = join(OUT, "h9_lift.wad");

// ---- the look ------------------------------------------------------------------------------------
const T = {
  sky: "sky",
  hull: "metl_panel1",
  hullOut: "STEC_PANEL3",
  deck: "CD_METALF_DARK",
  ceiling: "cd_metalceil",
  slabEdge: "DRKMTLT_BORD10",
  core: "cd_metalcircle1",
  grating: "{mod_labgrate1",
  rail: "MOD_LABPIPE1A",
  glass: "cd_glass1",
  stairs: "CD_METALF_DARK",
  hazard: "cd_stripes1",
  door: "cd_metaldoor1",
  engDoor: "cd_ymetal3",
  vent: "{mod_labgrate1",
  crate: ["CRATE09", "XCRATE1A", "BCRATE04", "CRATE13"],
  container: "mtl8_cargo_door",
  bench: "benchseat2",
  locker: "cd_metallocker1",
  partition: "plas_panel1",
  console: "cd_controls1",
  monitor: "cd_monitor3",
  machine: "machpanel20a",
  drive: "TECH_GEN",
  power: "cd_controls2",
  clamp: "machpanel40a",
  ladder: "{aladder1",
  podWall: "metal_rusty5ccc",
  lampCold: "~LIGHT5A",
  lampRed: "~LIGHT3A",
  frame: "DRKMTLT_BORD10",
  pipe: "mod_labpipe1a",
  rack: "matgrate_grey1",
  table: "cd_metalf2",
  screen: "mod_screen1a",
  mast: "mod_metal1a",
};
/** Each deck's own surfaces: its hull's inner face, its floor, its ceiling. */
const LOOK = {
  cargo: { wall: "metal_rusty5ccc", floor: "CD_METALF_DARK", ceiling: "cd_metalceil" },
  passenger: { wall: "cyberwallpanel", floor: "flr_panel02", ceiling: "ceiling_panel1" },
  drive: { wall: "metl_panel1", floor: "cd_metalf", ceiling: "cd_metalceil" },
};
/** The deck a slab under a deck's floor is the ceiling of (the roof: the drive deck's). */
const BELOW = { cargo: null, passenger: "cargo", drive: "passenger" };

// ---- the plan --------------------------------------------------------------------------------------
const N = 24; // sectors
const STEP = 360 / N;
const R_CORE = 160; // the core round the tether: its outer face
const R_SHAFT = 128; // its inner face: the shaft the tether runs up, open top and bottom
/** Whether a deck's core wall has a window in its 30-degree piece j: not behind an objective's machine. */
const OBJECT_ON = { cargo: 7.5, passenger: 97.5, drive: 187.5 };
const coreWindow = (deck, j) => {
  const a = OBJECT_ON[deck];
  const d = Math.abs((((j * 30 + 15 - a) % 360) + 540) % 360 - 180);
  return d > 40;
};
const R_IN = 1056; // the hull's inner face
const R_OUT = 1088; // its outer face
const R_GANTRY = 1216; // the gantry's rail
const SLAB = 32;
/** The decks: floor height and ceiling height. Each floor is the top of a slab SLAB thick. */
const DECKS = {
  cargo: { floor: 0, ceiling: 320 },
  passenger: { floor: 352, ceiling: 608 },
  drive: { floor: 640, ceiling: 928 },
};
const ROOF = 960;
const POD = { floor: -256, sectors: [10, 14], r: [448, R_IN] }; // under the cargo deck, south-west
const AIR = { r: 3328, floor: -2816, ceiling: 3840 };
const RING_NEAR = 1600; // the near ring of streaming cards
const RING_FAR = 2400; // the far ring

// openings, by sector: stairs up from each deck (radial flights), hatches out to the gantry, ladders between
// gantry levels, windows
const STAIRS = [
  { sector: 1, from: "cargo", to: "passenger" },
  { sector: 13, from: "cargo", to: "passenger" },
  { sector: 7, from: "passenger", to: "drive" },
  { sector: 19, from: "passenger", to: "drive" },
];
const POD_STAIRS = [11, 14]; // up from the pod into the cargo deck (13 is the cargo deck's own flight up)
// a flight runs out along its sector's middle between these radii: long enough that the steepest (cargo to
// passenger, 352 up) climbs at about 38 degrees, well under the 45 a body can walk -- bots stall near the limit
const STAIR_R = [520, 968];
const HATCHES = { cargo: [5, 17], passenger: [9, 22], drive: [3, 15] };
const LADDERS = [
  { sector: 11, from: "cargo", to: "passenger" },
  { sector: 23, from: "cargo", to: "passenger" },
  { sector: 2, from: "passenger", to: "drive" },
  { sector: 14, from: "passenger", to: "drive" },
];
const WINDOWS = {
  cargo: [0, 8, 16],
  passenger: [0, 1, 2, 3, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 23],
  drive: [0, 1, 5, 6, 8, 9, 10, 11, 12, 16, 17, 18, 20, 21, 22],
};
/**
 * The objectives' rooms, on the siege map only: walled off round the core, entered three ways and no other. A
 * door a Breacher alone can force (named tsm_breach_*: nobody opens it on touch or +USE, ts_matchmode forces it
 * for a Breacher); a door in the other side wall only a Combat Engineer opens (tsm_eng_door); and low in the
 * wall a crawl vent behind a grate (lift_vent), which anyone can shoot or knife out and crouch through -- a bot
 * standing by it shoots it out. The other maps have no rooms: the machines stand in the open.
 */
/** The span of a room's walls in plan: [first angle, last angle], across 0 where it must. */
const roomSpan = (room) => [room.sectors[0] * STEP, (room.sectors.at(-1) + 1) * STEP].map((a, i) => (i === 0 && room.sectors[0] > room.sectors.at(-1) ? a - 360 : a));
const ROOMS = [
  // its vent where the cargo flight's foot leaves no room behind sector 1's wall: in sector 23
  { deck: "cargo", sectors: [23, 0, 1], r: 480, breach: 0, engWall: 30, vent: 23, door: "tsm_breach_clamps" },
  // its arc's far sector is the stairwell's head, so its Breacher door is in the side wall, at 75 degrees
  { deck: "passenger", sectors: [5, 6, 7], r: 500, open: 6, breachWall: 75, engWall: 120, vent: 5, door: "tsm_breach_power" },
  { deck: "drive", sectors: [11, 12, 13], r: 600, open: 11, breach: 13, engWall: 165, vent: 12, door: "tsm_breach_drive" },
];
/**
 * The maintenance shafts: a ladder up the hull's inside from one deck to the next, walled off, behind a door
 * at each end that only a Combat Engineer opens (tsm_eng_door): a flank round the stairs.
 */
const SHAFTS = [
  { sector: 20, from: "cargo", to: "passenger" },
  { sector: 4, from: "passenger", to: "drive" },
];
const SHAFT_R = 880;
/** The dock's ladder up to the cargo gantry, and how far either side of a ladder its hole in the grating runs. */
const DOCK_LADDER = 13;
const HOLE = 4;
const SILL = 48;
const WINDOW_HIGH = 176;

// ---- polar helpers ---------------------------------------------------------------------------------
const rad = (deg) => (deg * Math.PI) / 180;
const P = (r, deg) => [Math.round(r * Math.cos(rad(deg))), Math.round(r * Math.sin(rad(deg)))];
const mid = (k) => k * STEP + STEP / 2;
/** A sector's piece between two radii, as a convex outline in plan (a triangle where r0 is 0). */
function piece(r0, r1, a0, a1) {
  if (r0 <= 0) return [[0, 0], P(r1, a0), P(r1, a1)];
  return [P(r0, a0), P(r1, a0), P(r1, a1), P(r0, a1)];
}
const slab = (r0, r1, a0, a1, z0, z1, texture) => M.prism("z", piece(r0, r1, a0, a1), z0, z1, texture);
const sectorSlab = (k, r0, r1, z0, z1, texture) => slab(r0, r1, k * STEP, (k + 1) * STEP, z0, z1, texture);
const inPod = (k) => k >= POD.sectors[0] && k <= POD.sectors[1];
/** Brushes laid out along +x from the middle and turned to stand along a sector's middle. */
const alongSector = (brushes, k) => M.turned(brushes, mid(k), [0, 0, 0], { snap: 1 });

/**
 * The floor either side of a flight's opening, out to the sector's edges: laid along +x and turned to the
 * sector, each piece running a little into the floor before and beyond the opening so no sliver opens between.
 * The flight and its rails take |y| < STAIR_HALF.
 */
const STAIR_HALF = 60;
function stairSides(k, z0, z1, texture) {
  const [x0, x1] = [STAIR_R[0] - 16, STAIR_R[1] + 16];
  const edge = (x) => Math.ceil(x * Math.tan(rad(STEP / 2))) + 2;
  return alongSector(
    [1, -1].map((s) => {
      const quad = [[x0, s * STAIR_HALF], [x1, s * STAIR_HALF], [x1, s * edge(x1)], [x0, s * edge(x0)]];
      return M.prism("z", s > 0 ? quad : quad.reverse(), z0, z1, texture);
    }),
    k,
  );
}

/**
 * A piece of the hull between two angles and heights, in two skins: `inside` (the deck's own plate) on a thin
 * inner layer, and the hull's own plate on the rest, so the car's outside is one plate all round whatever each
 * deck wears within.
 */
const SKIN = 8;
const skins = (a0, a1, z0, z1, inside) => [slab(R_IN, R_IN + SKIN, a0, a1, z0, z1, inside), slab(R_IN + SKIN, R_OUT, a0, a1, z0, z1, T.hull)];

// ---- the car's shell ---------------------------------------------------------------------------------
function shell() {
  const world = [];
  const glass = [];
  const hatchDoors = [];
  const deckNames = Object.keys(DECKS);
  // the core, floor to roof, and up past the roof and down past the pod as a sealed column
  // the core: a shaft round the tether, its wall R_SHAFT..R_CORE, with a band of windows on every deck (none
  // behind an objective's machine) through which the tether, its collars and its rollers are seen at work
  for (let j = 0; j < 12; j++) {
    const [a0, a1] = [j * 30, (j + 1) * 30];
    let z = POD.floor - SLAB;
    for (const [name, deck] of Object.entries(DECKS)) {
      if (!coreWindow(name, j)) continue;
      const [w0, w1] = [deck.floor + 104, deck.floor + 200];
      world.push(slab(R_SHAFT, R_CORE, a0, a1, z, w0, T.core));
      glass.push(slab(R_SHAFT + 8, R_CORE - 8, a0, a1, w0, w1, T.glass));
      z = w1;
    }
    world.push(slab(R_SHAFT, R_CORE, a0, a1, z, ROOF, T.core));
  }

  // the slabs: under each deck's floor, and the roof; with the stair openings cut out of the slab over each
  // flight's top, and the pod's stair openings out of the cargo floor
  for (const [name, deck] of Object.entries(DECKS)) {
    const look = { top: LOOK[name].floor, bottom: BELOW[name] ? LOOK[BELOW[name]].ceiling : T.hull, sides: T.hull };
    for (let k = 0; k < N; k++) {
      const z0 = deck.floor - SLAB, z1 = deck.floor;
      const opening =
        STAIRS.some((s) => s.to === name && s.sector === k) || (name === "cargo" && POD_STAIRS.includes(k));
      const shaft = SHAFTS.some((sh) => sh.to === name && sh.sector === k);
      if (shaft) {
        world.push(sectorSlab(k, R_CORE - 16, SHAFT_R, z0, z1, look));
        world.push(sectorSlab(k, R_IN, R_OUT, z0, z1, look));
      } else if (opening) {
        world.push(sectorSlab(k, R_CORE - 16, STAIR_R[0], z0, z1, look));
        world.push(sectorSlab(k, STAIR_R[1], R_OUT, z0, z1, look));
        // the opening is only as wide as the flight and its rails: the rest of the sector is floor
        world.push(...stairSides(k, z0, z1, look));
      } else world.push(sectorSlab(k, R_CORE - 16, R_OUT, z0, z1, look));
    }
  }
  for (let k = 0; k < N; k++) world.push(sectorSlab(k, R_CORE - 16, R_OUT, ROOF - SLAB, ROOF, { top: T.hull, bottom: LOOK.drive.ceiling, sides: T.hull }));

  // the hull, deck by deck: solid, or a hatch (a door 112 high), or a window (sill, glass, head)
  for (const [name, deck] of Object.entries(DECKS)) {
    const z0 = deck.floor, z1 = deck.floor + (deck.ceiling - deck.floor) + SLAB; // up to the next slab's top
    const top = name === "drive" ? ROOF - SLAB : DECKS[deckNames[deckNames.indexOf(name) + 1]].floor - SLAB;
    const plate = LOOK[name].wall;
    for (let k = 0; k < N; k++) {
      const wall = (a, b) => skins(k * STEP, (k + 1) * STEP, a, b, plate);
      if (HATCHES[name].includes(k)) {
        // a hatch in the middle third of the sector; solid either side of it and over it
        const a0 = k * STEP, a1 = (k + 1) * STEP, h0 = a0 + STEP / 3, h1 = a1 - STEP / 3;
        world.push(...skins(a0, h0, z0, top, plate), ...skins(h1, a1, z0, top, plate));
        world.push(...skins(h0, h1, z0 + 112, top, plate));
        hatchDoors.push(plainDoor(slab(R_IN + 4, R_OUT - 4, h0, h1, z0, z0 + 112, T.door)));
      } else if (WINDOWS[name].includes(k)) {
        world.push(wall(z0, z0 + SILL), wall(z0 + WINDOW_HIGH, top));
        glass.push(sectorSlab(k, R_IN + 8, R_OUT - 8, z0 + SILL, z0 + WINDOW_HIGH, T.glass));
      } else world.push(wall(z0, top));
      void z1;
    }
  }

  // the pod: its floor, its outer wall with a door onto the dock, its sides and its inner wall
  const [p0, p1] = POD.sectors;
  const pa0 = p0 * STEP, pa1 = (p1 + 1) * STEP;
  for (let k = p0; k <= p1; k++) {
    world.push(sectorSlab(k, POD.r[0], R_OUT, POD.floor - SLAB, POD.floor, T.deck));
    if (k === 12) {
      const a0 = k * STEP, a1 = (k + 1) * STEP, h0 = a0 + STEP / 3, h1 = a1 - STEP / 3;
      world.push(...skins(a0, h0, POD.floor, -SLAB, T.podWall), ...skins(h1, a1, POD.floor, -SLAB, T.podWall));
      world.push(...skins(h0, h1, POD.floor + 112, -SLAB, T.podWall));
      hatchDoors.push(plainDoor(slab(R_IN + 4, R_OUT - 4, h0, h1, POD.floor, POD.floor + 112, T.door)));
    } else world.push(...skins(k * STEP, (k + 1) * STEP, POD.floor, -SLAB, T.podWall));
    world.push(sectorSlab(k, POD.r[0] - 32, POD.r[0], POD.floor, -SLAB, T.podWall));
  }
  for (const a of [pa0, pa1]) {
    const d = [Math.cos(rad(a)), Math.sin(rad(a))];
    const n = [-d[1] * 16, d[0] * 16];
    const outline = [
      [d[0] * (POD.r[0] - 32) - n[0], d[1] * (POD.r[0] - 32) - n[1]],
      [d[0] * R_OUT - n[0], d[1] * R_OUT - n[1]],
      [d[0] * R_OUT + n[0], d[1] * R_OUT + n[1]],
      [d[0] * (POD.r[0] - 32) + n[0], d[1] * (POD.r[0] - 32) + n[1]],
    ].map(([x, y]) => [Math.round(x), Math.round(y)]);
    world.push(M.prism("z", outline, POD.floor, -SLAB, T.podWall));
  }
  return { world, glass, hatchDoors };
}

// ---- the objectives' rooms and the maintenance shafts --------------------------------------------------------
/** A doorway in a wall piece of one sector between radii r0..r1: the pieces either side and over it, and the gap. */
function doorway(k, r0, r1, z0, z1, texture) {
  // the gap is most of the sector: near the core a sector is narrow, and a third of it would not let a player by
  const a0 = k * STEP, a1 = (k + 1) * STEP, h0 = a0 + STEP * 0.15, h1 = a1 - STEP * 0.15;
  return {
    walls: [slab(r0, r1, a0, h0, z0, z1, texture), slab(r0, r1, h1, a1, z0, z1, texture), slab(r0, r1, h0, h1, z0 + 112, z1, texture)],
    gap: slab(r0 + 2, r1 - 2, h0, h1, z0, z0 + 112, texture),
  };
}
/** A wall standing along a line out from the core at angle a, from radius r0 to r1. */
function radialWall(a, r0, r1, z0, z1, texture) {
  const d = [Math.cos(rad(a)), Math.sin(rad(a))];
  const n = [-d[1] * 8, d[0] * 8];
  const outline = [[r0, -1], [r1, -1], [r1, 1], [r0, 1]].map(([r, s]) => [Math.round(d[0] * r + n[0] * s), Math.round(d[1] * r + n[1] * s)]);
  return M.prism("z", outline, z0, z1, texture);
}
/** A door's brush: the gap's shape, worn in one texture. */
const doorBrush = (gap, texture) => ({ ...gap, faces: gap.faces.map((f) => ({ ...f, texture })) });
/** The Breacher's door: named tsm_breach_*, so it opens for nobody on touch or +USE; forced, it stays open. */
const breachDoor = (gap, name) => M.brushEntity("func_door", [doorBrush(gap, T.hazard)], { targetname: name, angle: -1, speed: 160, wait: -1, lip: 4, movesnd: 3, stopsnd: 1 });
/** An ordinary door: no name, so it opens for anyone who walks into it or uses it, and shuts again. */
const plainDoor = (gap) => M.brushEntity("func_door", [doorBrush(gap, T.door)], { angle: -1, speed: 200, wait: 3, lip: 4, movesnd: 3, stopsnd: 1 });
/** The engineers' door: tsm_eng_door, opened by +USE (Use Only) and only for a Combat Engineer; it shuts again. */
const engDoor = (gap) => M.brushEntity("func_door", [doorBrush(gap, T.engDoor)], { targetname: "tsm_eng_door", angle: -1, speed: 160, wait: 4, lip: 4, spawnflags: 256, movesnd: 3, stopsnd: 1 });
function roomsAndShafts(siege) {
  const world = [];
  const doors = [];
  const vents = [];
  for (const room of siege ? ROOMS : []) {
    const deck = DECKS[room.deck];
    const [z0, z1] = [deck.floor, deck.ceiling];
    for (const k of room.sectors) {
      if (k === room.breach) {
        const d = doorway(k, room.r, room.r + 16, z0, z1, T.partition);
        world.push(...d.walls);
        doors.push(breachDoor(d.gap, room.door));
      } else if (k === room.vent) {
        // the crawl vent: a low opening, 96 wide and 56 high (a body crouches through, standing it does not
        // fit), a grate across it that breaks
        const a0 = k * STEP, a1 = (k + 1) * STEP, c = mid(k), half = (48 / room.r) * (180 / Math.PI);
        world.push(slab(room.r, room.r + 16, a0, c - half, z0, z1, T.partition), slab(room.r, room.r + 16, c + half, a1, z0, z1, T.partition));
        world.push(slab(room.r, room.r + 16, c - half, c + half, z0 + 56, z1, T.partition));
        vents.push(M.brushEntity("func_breakable", [slab(room.r + 6, room.r + 10, c - half, c + half, z0, z0 + 56, T.vent)], { targetname: "lift_vent", material: 2, health: 30, rendermode: 4, renderamt: 255, explodemagnitude: 0 }));
      } else world.push(sectorSlab(k, room.r, room.r + 16, z0, z1, T.partition));
    }
    for (const a of roomSpan(room)) {
      const kind = a === room.breachWall ? "breach" : a === room.engWall ? "eng" : null;
      if (!kind) {
        world.push(radialWall(a, R_CORE, room.r + 16, z0, z1, T.partition));
        continue;
      }
      // a door in this side wall, 96 wide, halfway out: the Breacher's, or the engineers'
      const [g0, g1] = [Math.round((R_CORE + room.r) / 2) - 48, Math.round((R_CORE + room.r) / 2) + 48];
      world.push(radialWall(a, R_CORE, g0, z0, z1, T.partition), radialWall(a, g1, room.r + 16, z0, z1, T.partition), radialWall(a, g0, g1, z0 + 112, z1, T.partition));
      const gap = radialWall(a, g0 + 2, g1 - 2, z0, z0 + 112, T.hazard);
      doors.push(kind === "breach" ? breachDoor(gap, room.door) : engDoor(gap));
    }
  }
  for (const sh of SHAFTS) {
    const low = DECKS[sh.from], high = DECKS[sh.to];
    const k = sh.sector;
    // the shaft's inner wall, floor of the lower deck to the ceiling of the upper, a door in it on each deck
    for (const deck of [low, high]) {
      const d = doorway(k, SHAFT_R - 16, SHAFT_R, deck.floor, deck.ceiling, T.hull);
      world.push(...d.walls);
      doors.push(engDoor(d.gap));
    }
    world.push(sectorSlab(k, SHAFT_R - 16, SHAFT_R, low.ceiling, high.floor, T.hull));
    // its sides, the whole height
    for (const a of [k * STEP, (k + 1) * STEP]) world.push(radialWall(a, SHAFT_R - 16, R_IN, low.floor, high.ceiling, T.hull));
  }
  return { world, doors: [...doors, ...vents] };
}

// ---- getting about: stairs, the gantry, ladders --------------------------------------------------------
function access() {
  const detail = [];
  const gratings = [];
  const ladders = [];
  const clips = [];
  const flight = (k, fromZ, toZ) => {
    const half = 52;
    const run = STAIR_R[1] - STAIR_R[0];
    // the flight climbs inward: its low end at the hull side, its top at the opening's core side
    const steps = Math.round((toZ - fromZ) / 16);
    const tread = Math.floor(run / steps);
    const brushes = M.stairs([STAIR_R[0], -half, fromZ], [STAIR_R[1], half, toZ], "-x", T.stairs, { tread, ramp: "CLIP" });
    // side rails up its length
    const rails = [-1, 1].map((s) => M.box([STAIR_R[0], s * (half + 4) - 4, fromZ], [STAIR_R[1], s * (half + 4) + 4, toZ + 40], T.rail));
    detail.push(...alongSector([...brushes, ...rails], k));
  };
  for (const s of STAIRS) flight(s.sector, DECKS[s.from].floor, DECKS[s.to].floor);
  for (const k of POD_STAIRS) flight(k, POD.floor, DECKS.cargo.floor);

  // the gantry: a grating ring outside each deck's floor, and the dock off the pod; where a ladder comes up
  // from below, the sector's grating leaves a hole over it to climb out through
  const holes = Object.fromEntries(Object.keys(DECKS).map((name) => [name, LADDERS.filter((l) => l.to === name).map((l) => l.sector)]));
  holes.cargo.push(DOCK_LADDER);
  for (const [name, deck] of Object.entries(DECKS)) {
    for (let k = 0; k < N; k++) {
      const [z0, z1] = [deck.floor - 16, deck.floor];
      if (!holes[name].includes(k)) {
        gratings.push(sectorSlab(k, R_OUT, R_GANTRY, z0, z1, T.grating));
        continue;
      }
      const [h0, h1] = [mid(k) - HOLE, mid(k) + HOLE];
      gratings.push(slab(R_OUT, R_GANTRY, k * STEP, h0, z0, z1, T.grating), slab(R_OUT, R_GANTRY, h1, (k + 1) * STEP, z0, z1, T.grating));
      gratings.push(slab(R_OUT + 72, R_GANTRY, h0, h1, z0, z1, T.grating));
    }
    const ring = Array.from({ length: N + 1 }, (_, i) => P(R_GANTRY - 8, i * STEP));
    detail.push(...M.railing(ring, { z: deck.floor, height: 44, thick: 8, texture: T.rail }));
  }
  for (const k of [11, 12, 13]) gratings.push(sectorSlab(k, R_OUT, R_GANTRY + 96, POD.floor - 16, POD.floor, T.grating));
  const dockRail = [11, 12, 13, 14].map((i) => P(R_GANTRY + 88, i * STEP));
  detail.push(...M.railing(dockRail, { z: POD.floor, height: 44, thick: 8, texture: T.rail }));
  // and along its two sides, on its very edges, back to the hull: nothing else stands between them and the drop
  for (const a of [11 * STEP + 0.4, 14 * STEP - 0.4])
    detail.push(...M.railing([P(R_OUT, a), P(R_GANTRY + 92, a)], { z: POD.floor, height: 44, thick: 8, texture: T.rail }));

  // CLIP behind every rail, up to well over a head: nobody stands on a rail's top or steps over it, and the
  // bots' waypoints, which walk what a player can stand on, never lead along one. Leaving the car is a hole in
  // the grating, not a slip off the edge.
  for (const deck of Object.values(DECKS))
    for (let k = 0; k < N; k++) clips.push(sectorSlab(k, R_GANTRY - 12, R_GANTRY + 8, deck.floor, deck.floor + 200, "CLIP"));
  for (const k of [11, 12, 13]) clips.push(sectorSlab(k, R_GANTRY + 84, R_GANTRY + 104, POD.floor, POD.floor + 200, "CLIP"));
  for (const a of [11 * STEP, 14 * STEP]) {
    const d = [Math.cos(rad(a)), Math.sin(rad(a))];
    const n = [-d[1] * 10, d[0] * 10];
    const outline = [[R_OUT, -1], [R_GANTRY + 104, -1], [R_GANTRY + 104, 1], [R_OUT, 1]].map(([r, t]) => [Math.round(d[0] * r + n[0] * t), Math.round(d[1] * r + n[1] * t)]);
    clips.push(M.prism("z", outline, POD.floor, POD.floor + 200, "CLIP"));
  }

  // ladders up the hull's outside between gantry levels, and one from the dock to the cargo gantry
  // up the hull's outside at the sector's middle, through the hole, a little past the grating to step off
  const ladder = (k, z0, z1) => {
    detail.push(...alongSector([M.box([R_OUT, -24, z0], [R_OUT + 12, 24, z1 + 8], T.ladder)], k));
    ladders.push(alongSector([M.box([R_OUT, -24, z0], [R_OUT + 24, 24, z1 + 40], "AAATRIGGER")], k)[0]);
  };
  for (const l of LADDERS) ladder(l.sector, DECKS[l.from].floor, DECKS[l.to].floor);
  // inside each maintenance shaft, up the hull's inner face
  for (const sh of SHAFTS) {
    const [z0, z1] = [DECKS[sh.from].floor, DECKS[sh.to].floor];
    detail.push(...alongSector([M.box([R_IN - 12, -24, z0], [R_IN, 24, z1 + 8], T.ladder)], sh.sector));
    ladders.push(alongSector([M.box([R_IN - 20, -24, z0], [R_IN, 24, z1 + 16], "AAATRIGGER")], sh.sector)[0]);
  }
  ladder(DOCK_LADDER, POD.floor, DECKS.cargo.floor);
  return { detail, gratings, ladders, clips };
}

// ---- what stands on the decks ------------------------------------------------------------------------
const pick = (list, n) => list[((n % list.length) + list.length) % list.length];
const freeSector = (k, deck) =>
  !STAIRS.some((s) => s.sector === k && (s.from === deck || s.to === deck)) &&
  !(deck === "cargo" && POD_STAIRS.includes(k)) &&
  !SHAFTS.some((sh) => sh.sector === k && (sh.from === deck || sh.to === deck));

function furniture() {
  const detail = [];
  // CARGO: containers lying radially, crate stacks between, clear of the stairs and the clamps (east)
  const cz = DECKS.cargo.floor;
  for (let k = 0; k < N; k++) {
    if (!freeSector(k, "cargo") || k === 0 || k === 23) continue;
    if (k % 3 === 0) detail.push(...alongSector([M.box([560, -56, cz], [880, 56, cz + 128], T.container)], k));
    else if (k % 3 === 1) {
      const h = 64 + 32 * (k % 2);
      detail.push(...alongSector([M.box([400, -40, cz], [480, 40, cz + h], pick(T.crate, k)), M.box([400, -32, cz + h], [464, 32, cz + h + 56], pick(T.crate, k + 1))], k));
    }
  }
  // PASSENGER: rows of seats in arcs, lockers on the core, low partitions every fourth sector
  const pz = DECKS.passenger.floor;
  for (let k = 0; k < N; k++) {
    if (!freeSector(k, "passenger")) continue;
    for (const r of [640, 768])
      if (k % 4 !== 0) detail.push(...alongSector([M.box([r, -48, pz], [r + 40, 48, pz + 44], T.bench)], k));
    if (k % 4 === 0) detail.push(...M.turned([M.box([640, -8, pz], [840, 8, pz + 128], T.partition)], k * STEP, [0, 0, 0], { snap: 1 }));
    if (k % 2 === 1 && k !== 5) detail.push(...alongSector([M.box([R_CORE, -32, pz], [R_CORE + 32, 32, pz + 96], T.locker)], k));
  }
  // DRIVE: the control room's console arc (north-east), monitors over it, the drive's machinery round the core
  const dz = DECKS.drive.floor;
  for (let k = 3; k <= 6; k++) {
    if (!freeSector(k, "drive")) continue;
    detail.push(...alongSector([M.box([640, -48, dz], [704, 48, dz + 40], T.console), M.box([704, -48, dz], [720, 48, dz + 96], T.monitor)], k));
  }
  for (const k of [9, 10, 20, 21, 22]) detail.push(...alongSector([M.box([R_CORE, -48, dz], [R_CORE + 96, 48, dz + 160], T.machine)], k));
  return detail;
}

// ---- dressing ------------------------------------------------------------------------------------------
/**
 * What makes the car a place: ribs up the hull at every sector's edge (framing the windows), a conduit
 * running round under each ceiling, luggage racks over the seats, mess tables, monitors on the core and over
 * the consoles, warning beacons by the gantry hatches, masts and beacons on the roof. And a lamp fitting
 * wherever a light hangs, its face shining (LAMP_FACES).
 */
function dressing() {
  const detail = [];
  const lamps = [];
  for (const [name, deck] of Object.entries(DECKS)) {
    for (let k = 0; k < N; k++) {
      // a rib at the sector's edge, against the hull, floor to ceiling
      detail.push(...M.turned([M.box([R_IN - 20, -10, deck.floor], [R_IN, 10, deck.ceiling], T.frame)], k * STEP, [0, 0, 0], { snap: 1 }));
      // the conduit under the ceiling, one length a sector, along the chord (none through a shaft open above)
      if (SHAFTS.some((sh) => sh.from === name && sh.sector === k)) continue;
      const a = P(R_IN - 56, k * STEP), b = P(R_IN - 56, (k + 1) * STEP);
      const run = Math.hypot(b[0] - a[0], b[1] - a[1]);
      detail.push(
        ...M.turned([M.cylinder("x", [0, deck.ceiling - 12], 9, 0, Math.round(run), T.pipe, { sides: 6 })], k * STEP + STEP / 2 + 90, [0, 0, 0], { snap: 1 }).map((brush) =>
          M.moved([brush], [a[0], a[1], 0])[0],
        ),
      );
    }
    // the deck's lamp fittings, where lights() hangs its lights
    for (const l of LIGHT_RINGS.filter((l) => l.deck === name))
      for (let i = 0; i < l.count; i++) {
        const [x, y] = P(l.r, l.turn + (360 * i) / l.count);
        if (ceilingOpen(name, x, y)) continue;
        lamps.push(M.box([x - 24, y - 24, deck.ceiling - 6], [x + 24, y + 24, deck.ceiling], l.face));
      }
  }
  // passenger deck: luggage racks over the seat rows, mess tables on the south-east
  const pz = DECKS.passenger.floor;
  for (let k = 0; k < N; k++) {
    if (!freeSector(k, "passenger") || k % 4 === 0) continue;
    // a rack, and four rods up to the ceiling it hangs from
    const rods = [[612, -48], [612, 40], [820, -48], [820, 40]].map(([x, y]) => M.box([x, y, pz + 176], [x + 8, y + 8, DECKS.passenger.ceiling], T.mast));
    detail.push(...alongSector([M.box([600, -56, pz + 168], [840, 56, pz + 176], T.rack), ...rods], k));
  }
  for (const k of [16, 17]) detail.push(...alongSector([M.box([360, -48, pz + 36], [456, 48, pz + 40], T.table), M.box([400, -8, pz], [416, 8, pz + 36], T.mast)], k));
  // the drive deck's screens over its consoles, on the hull
  const dz = DECKS.drive.floor;
  for (const k of [5, 6]) detail.push(...alongSector([M.box([R_IN - 28, -72, dz + 96], [R_IN - 20, 72, dz + 176], T.screen)], k));
  // a red beacon each side of every gantry hatch, outside
  for (const [name, deck] of Object.entries(DECKS))
    for (const k of HATCHES[name])
      for (const side of [-1, 1]) {
        const [x, y] = P(R_OUT + 6, mid(k) + side * 5.5);
        lamps.push(M.box([x - 6, y - 6, deck.floor + 120], [x + 6, y + 6, deck.floor + 132], T.lampRed));
      }
  // the roof: two masts with beacons, a ring of red lamps round its rim
  for (const a of [45, 225]) {
    const [x, y] = P(700, a);
    detail.push(M.cylinder("z", [x, y], 12, ROOF, ROOF + 320, T.mast, { sides: 8 }));
    lamps.push(M.box([x - 10, y - 10, ROOF + 320], [x + 10, y + 10, ROOF + 340], T.lampRed));
  }
  for (let i = 0; i < 12; i++) {
    const [x, y] = P(R_OUT - 24, i * 30);
    lamps.push(M.box([x - 8, y - 8, ROOF], [x + 8, y + 8, ROOF + 8], T.lampRed));
  }
  // the pod: crates against its walls
  // (12 is the pod's door to the dock, 11 and 14 its stairs)
  for (const k of [10, 13]) detail.push(...alongSector([M.box([960, -40, POD.floor], [1040, 40, POD.floor + 64], pick(T.crate, k))], k));
  return { detail, lamps };
}
/**
 * The mess a war leaves in a working car: Paradise City's litter (an h9 model is a point to the game, nothing to
 * walk into) -- bins and their spill, paper and sticks -- strewn on every deck and in the pod; stains of the
 * game's own decals.wad on the floors and up the hull (rust, oil drips, cracks); and the car's own furniture
 * models: the control room's consoles and chairs on the drive deck, stools at the mess tables.
 */
const prop = (model, at, yaw) => M.pointEntity("ts_model", at, { model: `models/h9/${model}.mdl`, angles: [0, Math.round(yaw), 0] });
const stain = (texture, at) => M.pointEntity("infodecal", at, { texture });
function debris() {
  const out = [];
  const TRASH = ["qk_trash", "re_dirt", "gpc_envtrash2", "re_dirt"];
  // litter: on each deck, at a few spots clear of the stairs, the shafts and the objectives' rooms
  const spots = {
    cargo: [[620, 52], [700, 128], [560, 172], [880, 232], [960, 280], [640, 322]],
    passenger: [[900, 36], [880, 132], [700, 214], [600, 248], [860, 336]],
    drive: [[760, 22], [600, 142], [820, 238], [680, 340]],
  };
  let n = 0;
  for (const [deck, list] of Object.entries(spots))
    for (const [r, a] of list) {
      const [x, y] = P(r, a);
      out.push(prop(TRASH[n % TRASH.length], [x, y, DECKS[deck].floor], a + 90 + (n % 3) * 40));
      n++;
    }
  for (const a of [160, 200]) {
    const [x, y] = P(820, a);
    out.push(prop(a === 160 ? "qk_trash" : "re_dirt", [x, y, POD.floor], a));
  }
  // stains on the floors, a unit over them
  const FLOOR = ["{RUST001", "{RUST002", "{CRACK2", "{FAULT01", "{RUST003", "{FAULT04", "{RUST004", "{FAULT02"];
  for (const [i, deck] of Object.keys(DECKS).entries())
    for (let j = 0; j < 8; j++) {
      const [x, y] = P(420 + ((j * 137) % 400), j * 45 + i * 17 + 7);
      out.push(stain(FLOOR[(i + j) % FLOOR.length], [x, y, DECKS[deck].floor + 1]));
    }
  // drips and rust down the hull's inner face, a unit off it
  const WALL = ["{DRIPS1", "{DRIP2", "{DRIP3", "{DRIP4", "{RUST001", "{RUST003"];
  for (const [i, deck] of Object.keys(DECKS).entries())
    for (let j = 0; j < 6; j++) {
      const k = (j * 4 + i * 2 + 1) % N;
      if (WINDOWS[deck].includes(k)) continue;
      // the hull is flat between a sector's corners: mid-sector its face stands in from R_IN
      const [x, y] = P(Math.floor(R_IN * Math.cos(rad(STEP / 2))) - 1, mid(k));
      out.push(stain(WALL[(i + j) % WALL.length], [x, y, DECKS[deck].floor + 90]));
    }
  // the control room's consoles, facing the hull, a chair at each; stools at the mess tables
  for (const a of [52, 82]) {
    const [x, y] = P(560, a);
    out.push(prop("d3_maincontrol", [x, y, DECKS.drive.floor], a));
    const [cx, cy] = P(500, a);
    out.push(prop("blackmesachair", [cx, cy, DECKS.drive.floor], a + 180));
  }
  for (const a of [242, 250, 258]) {
    const [x, y] = P(330, a);
    out.push(prop("barstool", [x, y, DECKS.passenger.floor], a));
  }
  return out;
}

/** How each lit face shines: [r, g, b, intensity] for hlrad's texture lights. */
const LAMP_FACES = { "~LIGHT5A": [255, 225, 200, 260], "~LIGHT3A": [255, 60, 40, 220] };

// ---- the objectives ------------------------------------------------------------------------------------
/**
 * A siege objective: a func_wall named tsm_obj_n (one entity of all its parts, so it falls as one), firing
 * `target` at its fall. Each is a machine of several parts, laid out along +x from the core and turned to its
 * sector.
 */
const objective = (n, brushes, target, siege) =>
  M.brushEntity("func_wall", brushes, siege ? { targetname: `tsm_obj_${n}`, target } : {});
function objectives(siege = true) {
  const c = DECKS.cargo.floor, p = DECKS.passenger.floor, d = DECKS.drive.floor;
  const R = R_CORE;
  // THE TETHER CLAMPS (cargo deck, east): a heavy housing on the core, two jaws biting the core either side of
  // it, a hydraulic ram along each jaw, a hazard-striped collar
  const clamps = [
    M.box([R, -40, c], [R + 112, 40, c + 176], T.clamp),
    M.box([R - 8, -52, c + 40], [R + 48, -40, c + 136], T.machine),
    M.box([R - 8, 40, c + 40], [R + 48, 52, c + 136], T.machine),
    M.cylinder("x", [-46, c + 88], 10, R + 48, R + 152, T.rail, { sides: 8 }),
    M.cylinder("x", [46, c + 88], 10, R + 48, R + 152, T.rail, { sides: 8 }),
    M.box([R + 112, -40, c + 152], [R + 136, 40, c + 176], T.hazard),
    M.box([R + 112, -40, c], [R + 136, 40, c + 24], T.hazard),
  ];
  // THE POWER CORE (passenger deck, north): three capacitor columns on a plinth, a coil round each, a conduit
  // from each up into the ceiling
  const power = [M.box([R, -48, p], [R + 160, 48, p + 16], T.machine)];
  for (const [x, y] of [[R + 56, -34], [R + 56, 34], [R + 120, 0]]) {
    power.push(M.cylinder("z", [x, y], 22, p + 16, p + 200, T.power, { sides: 10 }));
    power.push(M.cylinder("z", [x, y], 27, p + 96, p + 128, T.hazard, { sides: 10 }));
    power.push(M.cylinder("z", [x, y], 8, p + 200, DECKS.passenger.ceiling, T.rail, { sides: 6 }));
  }
  // THE DRIVE (drive deck, west): the traction motor's drum lying across, its gearbox on the core, the cable
  // spool between, a fan housing on top
  const drive = [
    M.box([R, -48, d], [R + 96, 48, d + 224], T.drive),
    M.cylinder("y", [R + 176, d + 112], 96, -64, 64, T.drive, { sides: 12 }),
    M.cylinder("y", [R + 176, d + 112], 104, -72, -60, T.hazard, { sides: 12 }),
    M.cylinder("y", [R + 176, d + 112], 104, 60, 72, T.hazard, { sides: 12 }),
    M.box([R + 96, -40, d + 176], [R + 176, 40, d + 216], T.machine),
    M.box([R + 120, -64, d], [R + 232, 64, d + 24], T.machine),
  ];
  const made = [
    objective(1, alongSector(clamps, 0), "lift_clamps_blown", siege),
    objective(2, alongSector(power, 6), "lift_power_cut", siege),
    objective(3, alongSector(drive, 12), "lift_stall", siege),
  ];
  // every point of each machine inside its room's walls, with room to spare: a part through a wall is
  // within reach of a satchel from outside the room
  made.forEach((entity, i) => {
    const room = ROOMS[i];
    const [a0, a1] = roomSpan(room);
    for (const p of entity.brushes.flatMap((b) => M.shapeOf(b).faces.flatMap((face) => face.polygon))) {
      const r = Math.hypot(p[0], p[1]);
      if (r < R_CORE + 8) continue; // inside the core itself, which nobody reaches
      let a = (Math.atan2(p[1], p[0]) * 180) / Math.PI;
      while (a < a0 - 180) a += 360;
      while (a > a1 + 180) a -= 360;
      const clear = Math.min(r * Math.sin(rad(a - a0)), r * Math.sin(rad(a1 - a)));
      if (clear < 12 || r > room.r - 12)
        throw new Error(`objective ${i + 1} reaches through its room's wall at ${p.map(Math.round).join(" ")} (${Math.round(clear)} clear of a side wall, radius ${Math.round(r)})`);
    }
  });
  return made;
}

// ---- the tether and the mechanism on it --------------------------------------------------------------------
/**
 * The tether, top to bottom of the sky and through the car's core: the cable itself and three guide cables round
 * it, each streaming downward (func_conveyor, the texture running at the climb's speed); joint collars sliding
 * down it one after another, through the car and on below (func_trains, started a moment apart, teleported back
 * to the top); and roller wheels gripping it, four at a time -- in the shaft at the cargo and drive decks, on
 * the roof and under the pod -- spinning (func_rotating). Each is named, so the drive's fall stops it and the
 * round's reset starts it again. The climb is seen in the moving parts, not the light.
 */
const CLIMB = 600; // units a second
const COLLARS = 16;
const COLLAR_GAP = 0.6; // seconds between one collar and the next
function tetherMechanism(names) {
  const out = [];
  const [bottom, top] = [AIR.floor + 64, AIR.ceiling - 64];
  out.push(M.brushEntity("func_conveyor", [M.cylinder("z", [0, 0], 40, bottom, top, SCROLL("SCROLLTETHER"), { sides: 12 })], { targetname: "lift_world_tether", speed: CLIMB, spawnflags: 3 }));
  for (const a of [30, 150, 270]) {
    const [x, y] = P(66, a);
    out.push(M.brushEntity("func_conveyor", [M.cylinder("z", [x, y], 7, bottom, top, SCROLL("SCROLLTETHER"), { sides: 6 })], { targetname: "lift_world_tether", speed: CLIMB, spawnflags: 3 }));
  }
  names.push("lift_world_tether");

  // the collars: a square frame round the cable, striped, sliding down it one after another, the whole length
  // of the tether: from the sky's top to its floor, where each goes back to the top
  const [cTop, cBottom] = [top - 16, bottom + 16];
  out.push(M.pointEntity("path_corner", [0, 0, cTop], { targetname: "lift_collar_top", target: "lift_collar_bottom", spawnflags: 2 }));
  out.push(M.pointEntity("path_corner", [0, 0, cBottom], { targetname: "lift_collar_bottom", target: "lift_collar_top" }));
  const go = {};
  for (let i = 1; i <= COLLARS; i++) {
    const z = cTop;
    const frame = [
      M.box([-80, -80, z - 12], [80, -48, z + 12], T.hazard),
      M.box([-80, 48, z - 12], [80, 80, z + 12], T.hazard),
      M.box([-80, -48, z - 12], [-48, 48, z + 12], T.hazard),
      M.box([48, -48, z - 12], [80, 48, z + 12], T.hazard),
    ];
    const name = `lift_collar_${i}`;
    out.push(M.brushEntity("func_train", frame, { targetname: name, target: "lift_collar_bottom", speed: CLIMB, spawnflags: 8 }));
    go[name] = +((i - 1) * COLLAR_GAP).toFixed(2);
    names.push(name);
  }
  out.push(M.pointEntity("multi_manager", [64, -64, ROOF + 96], { targetname: "lift_collars_go", ...go }));
  out.push(M.pointEntity("trigger_auto", [64, -96, ROOF + 96], { target: "lift_collars_go", delay: 1, triggerstate: 2, spawnflags: 1 }));

  // the rollers: four wheels round the cable at each grip, each turning on its own axle, the rim at the cable
  // rolling down with it
  const grips = [DECKS.cargo.floor + 150, DECKS.drive.floor + 150, ROOF + 48, POD.floor - SLAB - 48];
  const WHEEL = { r: 34, at: 76, half: 10 };
  const spin = Math.round((CLIMB / (2 * Math.PI * WHEEL.r)) * 360);
  grips.forEach((z, g) => {
    for (const a of [0, 90, 180, 270]) {
      const [cx, cy] = P(WHEEL.at, a);
      const alongX = a === 90 || a === 270; // the axle runs across the radius
      const wheel = alongX
        ? M.cylinder("x", [cy, z], WHEEL.r, cx - WHEEL.half, cx + WHEEL.half, T.machine, { sides: 12 })
        : M.cylinder("y", [cx, z], WHEEL.r, cy - WHEEL.half, cy + WHEEL.half, T.machine, { sides: 12 });
      const axle = alongX
        ? M.cylinder("x", [cy, z], 6, cx - 28, cx + 28, T.rail, { sides: 6 })
        : M.cylinder("y", [cx, z], 6, cy - 28, cy + 28, T.rail, { sides: 6 });
      const name = `lift_roller_${g}`;
      // the rim nearest the cable must run down: which way that is depends on the side
      const reverse = a === 0 || a === 90 ? 2 : 0;
      out.push(
        M.brushEntity("func_rotating", [wheel, axle, M.originBrush([cx, cy, z], 8)], {
          targetname: name,
          speed: spin,
          spawnflags: 1 + (alongX ? 4 : 8) + reverse + 64,
        }),
      );
      if (!names.includes(name)) names.push(name);
    }
  });
  return out;
}

// ---- the world streaming past -------------------------------------------------------------------------
const SCROLL = (name) => ({ name, rotation: 90, scale: [2, 2] });
function streaming() {
  const out = [];
  const names = [];
  // the cards: tall thin slabs round the car, each a conveyor on its own, visual and not solid (spawnflags 3),
  // drawn additive so only their glow shows
  const ring = (r, count, width, texture, speed, turn, tag, amount) => {
    for (let i = 0; i < count; i++) {
      const a = turn + (360 * i) / count;
      const d = [Math.cos(rad(a)), Math.sin(rad(a))];
      const t = [-d[1], d[0]];
      const corner = (s, u) => [Math.round(d[0] * (r + s) + t[0] * u), Math.round(d[1] * (r + s) + t[1] * u)];
      const outline = [corner(-4, -width / 2), corner(4, -width / 2), corner(4, width / 2), corner(-4, width / 2)];
      const name = `lift_world_${tag}`;
      out.push(
        M.brushEntity("func_conveyor", [M.prism("z", outline, AIR.floor + 64, AIR.ceiling - 64, SCROLL(texture))], {
          targetname: name,
          speed,
          spawnflags: 3,
          rendermode: 5,
          renderamt: amount,
        }),
      );
      if (!names.includes(name)) names.push(name);
    }
  };
  ring(RING_NEAR, 6, 640, "SCROLLCLOUD", 600, 7, "near", 80);
  ring(RING_NEAR - 160, 8, 512, "SCROLLSTREAK", 900, 30, "streak", 170);
  ring(RING_FAR, 10, 896, "SCROLLCLOUD", 280, 0, "far", 60);
  out.push(...tetherMechanism(names));
  // the cloud banks: flat cards drifting down past the car at different speeds, starting again at the top
  const banks = [
    { a: 20, r: 1300, speed: 620 },
    { a: 65, r: 1450, speed: 480 },
    { a: 110, r: 1280, speed: 760 },
    { a: 160, r: 1400, speed: 540 },
    { a: 205, r: 1320, speed: 680 },
    { a: 250, r: 1480, speed: 450 },
    { a: 295, r: 1290, speed: 820 },
    { a: 340, r: 1420, speed: 580 },
  ];
  banks.forEach((b, i) => {
    const d = [Math.cos(rad(b.a)), Math.sin(rad(b.a))];
    const t = [-d[1], d[0]];
    const c = [d[0] * b.r, d[1] * b.r];
    const corner = (s, u) => [Math.round(c[0] + d[0] * s + t[0] * u), Math.round(c[1] + d[1] * s + t[1] * u)];
    const outline = [corner(-4, -384), corner(4, -384), corner(4, 384), corner(-4, 384)];
    const top = AIR.ceiling - 640, bottom = AIR.floor + 256;
    const name = `lift_bank_${i}`;
    out.push(
      M.brushEntity("func_train", [M.prism("z", outline, top - 256, top + 256, { name: "CLOUDBANK", scale: [3, 2] })], {
        targetname: "lift_banks",
        target: `${name}_top`,
        speed: b.speed,
        spawnflags: 8, // not solid
        rendermode: 5,
        renderamt: 220,
      }),
      // a train's origin is its box's middle: the corners are where that middle goes
      // down past the car, and back to the top at once: the top corner is the one the train is teleported to
      M.pointEntity("path_corner", [Math.round(c[0]), Math.round(c[1]), top], { targetname: `${name}_top`, target: `${name}_bottom`, spawnflags: 2 }),
      M.pointEntity("path_corner", [Math.round(c[0]), Math.round(c[1]), bottom], { targetname: `${name}_bottom`, target: `${name}_top` }),
    );
  });
  names.push("lift_banks");
  // the drive's fall stops all of it, and the round's reset starts it again: each use toggles them
  // the drive's hum and rollers, and the alarm, toggle with them: on the fall the hum and rollers stop and the
  // alarm starts, and the reset turns each back; the spin-down plays on the fall alone
  const toggle = Object.fromEntries([...names, "lift_drivehum", "lift_rollers_drive", "lift_alarm"].map((n) => [n, 0]));
  out.push(M.pointEntity("multi_manager", [0, 0, ROOF + 64], { targetname: "lift_stall", ...toggle, lift_spindown: 0 }));
  out.push(M.pointEntity("multi_manager", [0, 64, ROOF + 64], { targetname: "tsm_obj_3_reset", ...toggle }));
  return out;
}

// ---- the sound of it -------------------------------------------------------------------------------------
/** ambient_generic's spawnflags: how far it is heard (small ~500, medium ~800, large ~1250, or everywhere at one
 *  volume), whether it waits to be fired, and whether it plays once each time it is fired instead of looping. */
const HEARD = { everywhere: 1, small: 2, medium: 4, large: 8 };
const START_SILENT = 16;
const ONCE = 32;
const loop = (file, at, volume, heard, keys = {}) =>
  M.pointEntity("ambient_generic", at, { message: file, health: volume, pitch: 100, spawnflags: HEARD[heard], ...keys });
const once = (targetname, file, at, volume, heard, pitch = 100) =>
  M.pointEntity("ambient_generic", at, { targetname, message: file, health: volume, pitch, spawnflags: HEARD[heard] + START_SILENT + ONCE });
const room = (at, radius, roomtype) => M.pointEntity("env_sound", at, { radius, roomtype });
const atDeck = (deck, r, deg, up = 96) => [...P(r, deg), DECKS[deck].floor + up];

/**
 * The car alive while it climbs. Loops: the wind round the gantry (loudest out there, faint through the
 * hatches); the drive's hum through the whole car, strongest on the drive deck; the tether rollers' clatter at
 * the clamps and at the drive; the tether singing by the core; under everything, heard everywhere, the slow
 * swell of wind and tether stress -- the car rocking. One-shots, at no steady beat: the hull groaning and
 * creaking, the clank and shudder of a tether joint passing through the rollers, gusts howling round the hull,
 * a chime on the passenger deck, and far below the war going on.
 *
 * GoldSrc has no timer that picks a random time, so pairs of multi_managers fire the one-shots, each of a pair
 * passing the turn to the other at the end of its pass (a manager that fires itself is never run again); the
 * pairs' cycles keep no beat together, so it does not seem to repeat. Every custom file is sound\h9lift\.
 */
function soundscape() {
  const out = [];
  // the wind, round each gantry level, and faintly inside each hatch
  const winds = ["ambience/wind1.wav", "ambience/wind2.wav", "ambience/windy.wav"];
  for (const [i, deck] of Object.keys(DECKS).entries()) {
    for (let j = 0; j < 6; j++) out.push(loop(winds[(i + j) % 3], atDeck(deck, R_OUT + 64, j * 60 + i * 20, 64), 7, "medium"));
    for (const k of HATCHES[deck]) out.push(loop("ambience/wind2.wav", atDeck(deck, R_IN - 48, mid(k), 64), 3, "small"));
  }
  // the drive: loud on its own deck, felt through the rest
  for (let j = 0; j < 4; j++) out.push(loop("h9lift/drive_hum.wav", atDeck("drive", 520, j * 90 + 45, 120), 7, "large", { targetname: "lift_drivehum" }));
  out.push(loop("h9lift/drive_hum.wav", atDeck("passenger", 400, 200, 120), 3, "large", { targetname: "lift_drivehum" }));
  out.push(loop("h9lift/drive_hum.wav", atDeck("cargo", 400, 20, 120), 2, "large", { targetname: "lift_drivehum" }));
  // the rollers on the tether, at the clamps and at the drive
  out.push(loop("h9lift/rollers.wav", [...P(R_CORE + 80, 7), 120], 8, "medium", { targetname: "lift_rollers_cargo" }));
  out.push(loop("h9lift/rollers.wav", [...P(R_CORE + 120, 187), DECKS.drive.floor + 120], 7, "medium", { targetname: "lift_rollers_drive" }));
  // the tether singing, by the core on each deck
  for (const deck of Object.keys(DECKS)) out.push(loop("h9lift/cable_sing.wav", atDeck(deck, R_CORE + 40, 270, 140), 4, "small"));
  // under everything: the car rocking
  out.push(loop("h9lift/stress_rumble.wav", atDeck("passenger", 640, 300, 100), 7, "everywhere"));
  // each deck's own hum
  out.push(loop("ambience/industrial2.wav", atDeck("cargo", 700, 100), 3, "small"));
  out.push(loop("ambience/techamb2.wav", atDeck("passenger", 700, 300), 3, "small", { targetname: "lift_cabinhum" }));
  out.push(loop("ambience/dronemachine3.wav", atDeck("drive", 700, 60), 3, "small"));
  // each deck a metal room; out on the gantry the open air
  for (const deck of Object.keys(DECKS)) for (const a of [30, 150, 270]) out.push(room(atDeck(deck, 600, a, 64), 420, 4));

  // the one-shots, each fired by name
  const SHOTS = {
    lift_groan1: ["h9lift/groan1.wav", atDeck("cargo", 900, 140), 8, "large"],
    lift_groan2: ["h9lift/groan2.wav", atDeck("passenger", 900, 320), 8, "large"],
    lift_groan3: ["h9lift/groan3.wav", atDeck("drive", 900, 230), 8, "large"],
    lift_creak1: ["h9lift/creak1.wav", atDeck("passenger", 700, 40), 6, "medium"],
    lift_creak2: ["h9lift/creak2.wav", atDeck("cargo", 700, 250), 6, "medium"],
    lift_creak3: ["h9lift/creak1.wav", atDeck("drive", 700, 120), 6, "medium"],
    lift_gust1: ["h9lift/gust1.wav", atDeck("passenger", R_OUT + 64, 60, 64), 9, "large"],
    lift_gust2: ["h9lift/gust2.wav", atDeck("cargo", R_OUT + 64, 210, 64), 9, "large"],
    lift_gust3: ["h9lift/gust1.wav", atDeck("drive", R_OUT + 64, 330, 64), 9, "large"],
    lift_joint: ["h9lift/joint.wav", atDeck("passenger", 640, 300, 100), 7, "everywhere"],
    lift_chime: ["h9lift/pa_chime.wav", atDeck("passenger", R_CORE + 60, 180, 200), 5, "large"],
    lift_war1: ["h9lift/war1.wav", [0, 0, -400], 3, "everywhere"],
    lift_war2: ["h9lift/war2.wav", [0, 0, -400], 3, "everywhere"],
  };
  for (const [name, [file, at, volume, heard]] of Object.entries(SHOTS)) out.push(once(name, file, at, volume, heard));
  // a tether joint passing through the rollers: its clank and the car's shudder
  out.push(M.pointEntity("env_shake", atDeck("passenger", 640, 300, 100), { targetname: "lift_joint", amplitude: 3.5, frequency: 30, duration: 1.6, radius: 4000, spawnflags: 1 }));
  // the car swaying: each groan rolls everyone's view, slow and deep; each creak a small tremor; and a sway of
  // its own between them (spawnflags 1: everyone, wherever they are)
  for (const g of ["lift_groan1", "lift_groan2", "lift_groan3"])
    out.push(M.pointEntity("env_shake", atDeck("passenger", 640, 300, 100), { targetname: g, amplitude: 4, frequency: 6, duration: 2.6, radius: 4000, spawnflags: 1 }));
  for (const c of ["lift_creak1", "lift_creak2", "lift_creak3"])
    out.push(M.pointEntity("env_shake", atDeck("passenger", 640, 300, 100), { targetname: c, amplitude: 1.5, frequency: 14, duration: 1.2, radius: 4000, spawnflags: 1 }));
  out.push(M.pointEntity("env_shake", atDeck("passenger", 640, 300, 100), { targetname: "lift_sway", amplitude: 2, frequency: 3, duration: 4, radius: 4000, spawnflags: 1 }));
  const PASSES = {
    lift_pass_a: { next: "lift_pass_b", after: 29, fire: { lift_groan1: 2.5, lift_creak1: 6.5, lift_sway: 9, lift_creak2: 12, lift_joint: 15.5, lift_groan2: 19, lift_creak3: 23, lift_war1: 26 } },
    lift_pass_b: { next: "lift_pass_a", after: 34, fire: { lift_creak2: 3, lift_groan3: 7.5, lift_sway: 11, lift_creak1: 15, lift_gust2: 17, lift_groan1: 21.5, lift_joint: 25, lift_creak3: 29, lift_war2: 31 } },
    lift_pass_c: { next: "lift_pass_d", after: 47, fire: { lift_gust1: 5, lift_sway: 18, lift_chime: 30, lift_gust3: 38 } },
    lift_pass_d: { next: "lift_pass_c", after: 53, fire: { lift_groan2: 9, lift_gust1: 24, lift_sway: 33, lift_chime: 44 } },
  };
  for (const [targetname, { next, after, fire }] of Object.entries(PASSES))
    out.push(M.pointEntity("multi_manager", [0, 0, ROOF + 96], { targetname, ...fire, [next]: after }));
  out.push(M.pointEntity("trigger_auto", [0, 32, ROOF + 96], { target: "lift_pass_a", delay: 6, triggerstate: 2, spawnflags: 1 }));
  out.push(M.pointEntity("trigger_auto", [0, -32, ROOF + 96], { target: "lift_pass_c", delay: 11, triggerstate: 2, spawnflags: 1 }));

  // the objectives' falls, and their resets (fired at the next round start only for those that fell)
  out.push(once("lift_shriek", "h9lift/shriek.wav", [...P(R_CORE + 80, 7), 100], 10, "large"));
  out.push(once("lift_crackle", "h9lift/crackle.wav", [...P(R_CORE + 80, 97), DECKS.passenger.floor + 120], 10, "large"));
  out.push(once("lift_spindown", "h9lift/spindown.wav", [...P(R_CORE + 120, 187), DECKS.drive.floor + 120], 10, "everywhere"));
  out.push(loop("h9lift/alarm.wav", atDeck("passenger", 640, 300, 200), 5, "everywhere", { targetname: "lift_alarm", spawnflags: HEARD.everywhere + START_SILENT }));
  out.push(M.pointEntity("multi_manager", [64, 0, ROOF + 96], { targetname: "lift_clamps_blown", lift_shriek: 0, lift_rollers_cargo: 0.4, lift_joint: 0.1 }));
  out.push(M.pointEntity("multi_manager", [64, 32, ROOF + 96], { targetname: "tsm_obj_1_reset", lift_rollers_cargo: 0 }));
  out.push(M.pointEntity("multi_manager", [64, 64, ROOF + 96], { targetname: "lift_power_cut", lift_crackle: 0, lift_cabinhum: 0.2 }));
  out.push(M.pointEntity("multi_manager", [64, 96, ROOF + 96], { targetname: "tsm_obj_2_reset", lift_cabinhum: 0 }));
  return out;
}

// ---- the haze outside -------------------------------------------------------------------------------------
/**
 * The radiated hellfire the climb drags up the tether, clinging to the car's outside: sprites.mjs's
 * h9_lift_haze, glowing red, hung in drifts round every gantry ring, along the dock and over the roof's rim.
 * Only outside -- GoldSrc's fog is the whole map's, so the haze is sprites, and the car's inside stays clear.
 */
const HAZE_SPRITE = "sprites/h9_lift_haze.spr";
const haze = (at, scale = 1.2, amount = 150) =>
  M.pointEntity("env_sprite", at, { model: HAZE_SPRITE, rendermode: 5, renderamt: amount, rendercolor: [255, 255, 255], scale, framerate: 0, spawnflags: 1 });
function hazeOutside() {
  const out = [];
  for (const [i, deck] of Object.values(DECKS).entries())
    for (let j = 0; j < 14; j++) {
      const a = j * (360 / 14) + i * 9;
      const [x, y] = P((R_OUT + R_GANTRY) / 2 + ((j % 3) - 1) * 24, a);
      out.push(haze([x, y, deck.floor + 60 + (j % 2) * 24], 1.1 + (j % 3) * 0.15, 130 + (j % 4) * 15));
    }
  for (const a of [172, 187, 202]) {
    const [x, y] = P(R_GANTRY + 40, a);
    out.push(haze([x, y, POD.floor + 60], 1.3, 160));
  }
  for (let j = 0; j < 10; j++) {
    const [x, y] = P(R_OUT - 40, j * 36 + 12);
    out.push(haze([x, y, ROOF + 50], 1.4, 120));
  }
  return out;
}

// ---- light ---------------------------------------------------------------------------------------------
/**
 * Whether a deck's ceiling is open over a point: a flight up to the next deck, or a shaft, goes through it there.
 * Nothing hangs from a ceiling that is not there.
 */
function ceilingOpen(deck, x, y) {
  const r = Math.hypot(x, y);
  const a = (Math.atan2(y, x) * 180) / Math.PI;
  const local = (k) => {
    const t = rad(a - mid(k));
    return [r * Math.cos(t), r * Math.sin(t)];
  };
  for (const st of STAIRS.filter((st) => st.from === deck)) {
    const [lx, ly] = local(st.sector);
    if (lx > STAIR_R[0] - 48 && lx < STAIR_R[1] + 48 && Math.abs(ly) < STAIR_HALF + 48) return true;
  }
  for (const sh of SHAFTS.filter((sh) => sh.from === deck)) {
    const [lx, ly] = local(sh.sector);
    if (lx > SHAFT_R - 48 && Math.abs(ly) < lx * Math.tan(rad(STEP / 2)) + 24) return true;
  }
  return false;
}
/** Where the decks' lights hang: a ring of them under each ceiling, each under a lamp fitting of `face`. */
const LIGHT_RINGS = [
  { deck: "cargo", r: 640, colour: [255, 160, 120], brightness: 260, count: 12, turn: 9, face: "~LIGHT5A" },
  { deck: "cargo", r: 360, colour: [255, 170, 130], brightness: 200, count: 8, turn: 52, face: "~LIGHT5A" },
  { deck: "passenger", r: 380, colour: [255, 215, 180], brightness: 170, count: 8, turn: 52, face: "~LIGHT5A" },
  { deck: "drive", r: 400, colour: [210, 225, 255], brightness: 200, count: 8, turn: 52, face: "~LIGHT5A" },
  { deck: "passenger", r: 640, colour: [255, 210, 170], brightness: 170, count: 12, turn: 4, face: "~LIGHT5A" },
  { deck: "passenger", r: 900, colour: [255, 200, 160], brightness: 110, count: 12, turn: 19, face: "~LIGHT5A" },
  { deck: "drive", r: 680, colour: [200, 220, 255], brightness: 220, count: 10, turn: 13, face: "~LIGHT5A" },
];
function lights() {
  const out = [];
  for (const l of LIGHT_RINGS) {
    const z = DECKS[l.deck].ceiling - 24;
    for (let i = 0; i < l.count; i++) {
      const [x, y] = P(l.r, l.turn + (360 * i) / l.count);
      if (ceilingOpen(l.deck, x, y)) continue;
      out.push(M.light([x, y, z], { color: l.colour, brightness: l.brightness }));
    }
  }
  out.push(M.textureLights([0, 0, ROOF + 128], LAMP_FACES));
  // a work light over each objective, warm and strong, so the machine reads from its doorways
  for (const room of ROOMS) {
    const k = room.sectors[Math.floor(room.sectors.length / 2)];
    const [x, y] = P(room.r - 120, room.sectors.length === 2 ? 0 : mid(k));
    out.push(M.light([x, y, DECKS[room.deck].ceiling - 32], { color: [255, 190, 140], brightness: 320 }));
  }
  // inside the core's shaft, at each deck's windows: cold light on the moving tether
  for (const deck of Object.values(DECKS)) out.push(M.light([0, 96, deck.floor + 150], { color: [200, 220, 255], brightness: 160 }));
  // the pod: a few red work lights
  for (const k of [10, 12, 14]) {
    const [x, y] = P(760, mid(k));
    out.push(M.light([x, y, -64], { color: [255, 70, 50], brightness: 160 }));
  }
  // the gantry rings, lit dimly from the hull
  for (const deck of Object.values(DECKS))
    for (let i = 0; i < 8; i++) {
      const [x, y] = P(R_OUT + 40, i * 45 + 22);
      out.push(M.light([x, y, deck.floor + 96], { color: [255, 120, 80], brightness: 90 }));
    }
  // the world's own light, from the burning city below and the smog overhead
  out.push(M.sunLight([0, 0, AIR.ceiling - 128], { pitch: -40, yaw: 200, color: [255, 110, 60], brightness: 40, _diffuse_light: [200, 70, 50, 14] }));
  return out;
}

// ---- the four maps -------------------------------------------------------------------------------------
/**
 * One car, four maps, as the drainage works are three: the siege, and the same lift for the other modes, with
 * no siege objectives -- the machines stand where they stood, scenery, and nothing on them can be planted.
 *   h9_siege_lift   the siege: MSR on the drive deck, the Insurgents from the pod, forward spawns as it falls
 *   h9_up_lift      Capture the Uplink: four zones (the clamp bay, the power room, the drive room, the mess) and
 *                   the uplink on the passenger deck; MSR on the drive deck, the Insurgents in the pod and the
 *                   cargo deck's south
 *   h9_ws_lift      Wave Survival: the survivors hold the passenger deck; the hordes come from the pod, the
 *                   cargo deck and the drive deck
 *   h9_mw_lift      Mech Warrior: the sides start as on h9_up_lift, with no zones
 */
const VARIANTS = {
  siege: { name: "h9_siege_lift", title: "The Lift -- Siege" },
  up: { name: "h9_up_lift", title: "The Lift -- Capture the Uplink" },
  ws: { name: "h9_ws_lift", title: "The Lift -- Wave Survival" },
  mw: { name: "h9_mw_lift", title: "The Lift -- Mech Warrior" },
};

/** The uplink's zones and its point: each in a room's middle, on its floor. */
const ZONES = {
  tsm_cap_1: [...P(320, 7.5), DECKS.cargo.floor + 16],
  tsm_cap_2: [...P(380, 97.5), DECKS.passenger.floor + 16],
  tsm_cap_3: [...P(420, 187.5), DECKS.drive.floor + 16],
  tsm_cap_4: [...P(420, 247.5), DECKS.passenger.floor + 16],
  tsm_uplink: [...P(800, 330), DECKS.passenger.floor + 16],
};

// ---- spawns --------------------------------------------------------------------------------------------
/**
 * [{ team, at (floor point), yaw, tier }]: on the siege, a tier-n point is used once objective n has fallen.
 * A forward tier replaces tier 0 for the side's respawns, so each set holds a whole side of 32 on its own, and
 * every point stands 96 or more from the next, on open floor, clear of the stairs, their openings and the
 * furniture (tools\spawns64.py checks them against the compiled map).
 */
function spawnPoints(variant) {
  const out = [];
  const facingIn = (a) => (a + 180) % 360;
  const facingOut = (a) => a;
  /** n angles evenly across the arc a0..a1. */
  const spread = (a0, a1, n) => Array.from({ length: n }, (_, i) => a0 + ((i + 0.5) * (a1 - a0)) / n);
  /** n angles across sector k: its middle for one, a quarter sector either side of it for two. */
  const across = (k, n) => spread(k * STEP, (k + 1) * STEP, n);
  const put = (team, floor, r, angles, tier, facing) => {
    for (const a of angles) out.push({ team, at: [...P(r, a), floor], yaw: facing(a), tier });
  };
  /** two points to each of `sectors` at radius r, facing the core. */
  const pairs = (team, deck, sectors, r, tier = 0) => put(team, DECKS[deck].floor, r, sectors.flatMap((k) => across(k, 2)), tier, facingIn);
  const msrOnDrive = () => {
    for (let k = 0; k < N; k++) if (freeSector(k, "drive")) for (const r of [880, 960]) put(1, DECKS.drive.floor, r, [mid(k)], 0, facingIn);
  };
  // the pod: rows 100 apart from its inner wall out to the hull, facing out, the way its stairs start. The
  // innermost row runs the pod's whole width, inside the flights' top ends; further out the flights up
  // (sectors 11 and 14) take their sectors, and each row puts its points across sector 10 and across the arc
  // between the two flights, a body clear of their rails. None stands at a flight's foot, and the outer row's
  // pairs stand either side of the crates by the hull in 10 and 13.
  const inPodRows = (team) => {
    const between = (r, n) => {
      const clear = (Math.asin((STAIR_HALF + 16) / r) * 180) / Math.PI;
      return spread(mid(POD_STAIRS[0]) + clear, mid(POD_STAIRS[1]) - clear, n);
    };
    const rows = [
      [492, spread(POD.sectors[0] * STEP, (POD.sectors[1] + 1) * STEP, 6)],
      [592, [mid(10), ...between(592, 3)]],
      [692, [mid(10), ...between(692, 4)]],
      [792, [...across(10, 2), ...between(792, 4)]],
      [892, [...across(10, 2), ...between(892, 5)]],
      [992, [10, 12, 13].flatMap((k) => across(k, 2))],
    ];
    for (const [r, angles] of rows) put(team, POD.floor, r, angles, 0, facingOut);
  };
  if (variant === "siege") {
    msrOnDrive();
    inPodRows(2);
    // tier 1, the clamps fallen: the cargo deck's south and west. Pairs round the hull, clear of the flight up
    // (13) and the pod stairs' openings (11, 14); a row inside the hull's where no container lies; one inside
    // the containers, where no crates stand; and a ring round the core
    pairs(2, "cargo", [6, 7, 8, 9, 10, 12, 15, 16, 17, 18], 1000, 1);
    put(2, DECKS.cargo.floor, 904, [7, 8, 10, 16, 17].map(mid), 1, facingIn);
    put(2, DECKS.cargo.floor, 432, [6, 9, 12, 15, 18].map(mid), 1, facingIn);
    put(2, DECKS.cargo.floor, 288, [6, 8, 10, 12, 14, 16, 18].map(mid), 1, facingIn);
    // tier 2, the power core fallen: the passenger deck's south and west, two rings of pairs outside the seat
    // rows, clear of the opening the cargo deck's flight comes up through (13)
    pairs(2, "passenger", [8, 9, 10, 11, 12, 14, 15, 16, 17, 18], 1000, 2);
    pairs(2, "passenger", [9, 10, 11, 12, 14, 15, 16, 17], 880, 2);
  } else if (variant === "ws") {
    // the survivors: the passenger deck's every free sector, on two rings outside the seat rows
    const free = [];
    for (let k = 0; k < N; k++) if (freeSector(k, "passenger")) free.push(k);
    for (const r of [880, 1000]) put(1, DECKS.passenger.floor, r, free.map(mid), 0, facingIn);
    // the hordes: the pod, and pairs round the hull of the cargo deck and the drive deck
    inPodRows(2);
    pairs(2, "cargo", [3, 6, 9, 10, 12, 15, 16, 21], 960);
    pairs(2, "drive", [0, 6, 9, 16, 21], 960);
  } else {
    msrOnDrive();
    inPodRows(2);
    pairs(2, "cargo", [9, 10, 12, 15, 16], 960);
  }
  return out;
}

const spawnEntities = (variant) =>
  spawnPoints(variant)
    .filter((s) => s.tier === 0)
    .flatMap(({ team, at, yaw }) => [M.playerStart(at, yaw, `info_player_team${team}`), M.playerStart(at, yaw, "info_player_deathmatch")]);

const spawnConfig = (variant) =>
  [
    `// ts_matchmode spawn points for ${VARIANTS[variant].name} -- written by export-map/h9_siege_lift/lift.mjs`,
    "// tsm_spawn <team> <x> <y> <z> <pitch> <yaw> <tier>",
    ...spawnPoints(variant).map(({ team, at, yaw, tier }) => `tsm_spawn ${team} ${at[0].toFixed(2)} ${at[1].toFixed(2)} ${(at[2] + 37).toFixed(2)} 0.00 ${yaw.toFixed(2)} ${tier}`),
    "",
  ].join("\r\n");

const resList = (name) => [`// ${name}: sent with the map to a player who joins without it`, ...M.SKY_SIDES.map((side) => `gfx/env/${SKY_NAME}${side}.tga`), HAZE_SPRITE, ""].join("\r\n");

// ---- the map -------------------------------------------------------------------------------------------
function build(variant) {
  const air = [{ name: "air", outline: M.circle([0, 0], AIR.r, { sides: 16 }), floor: AIR.floor, ceiling: AIR.ceiling, texture: { floor: T.sky, wall: T.sky, ceiling: T.sky } }];
  const rock = M.carvePlan(air, 64, { floor: T.sky, wall: T.sky, ceiling: T.sky });
  const { world, glass, hatchDoors } = shell();
  const { detail: accessDetail, gratings, ladders, clips } = access();
  const rooms = roomsAndShafts(variant === "siege");
  const dressed = dressing();
  return {
    worldspawn: {
      wad: [...Object.values(WADS).filter(existsSync), LIFT_WAD],
      skyname: SKY_NAME,
      MaxRange: 12000,
      message: VARIANTS[variant].title,
    },
    brushes: [...rock, ...world, ...rooms.world, ...clips],
    entities: [
      ...lights(),
      M.brushEntity("func_detail", [...accessDetail, ...furniture(), ...dressed.detail, ...dressed.lamps]),
      ...glass.map((b) => M.brushEntity("func_wall", [b], { rendermode: 2, renderamt: 70 })),
      ...gratings.map((b) => M.brushEntity("func_wall", [b], { rendermode: 4, renderamt: 255 })),
      ...ladders.map((b) => M.brushEntity("func_ladder", [b])),
      ...objectives(variant === "siege"),
      ...rooms.doors,
      ...hatchDoors,
      ...streaming(),
      ...soundscape(),
      ...debris(),
      ...hazeOutside(),
      // a fall off the gantry: far below the car, nobody lives
      M.brushEntity("trigger_hurt", [M.box([-AIR.r + 96, -AIR.r + 96, AIR.floor + 64], [AIR.r - 96, AIR.r - 96, -1400], "AAATRIGGER")], { dmg: 1000, damagetype: 32 }),
      ...(variant === "up" ? Object.entries(ZONES).map(([targetname, at]) => M.pointEntity("info_target", at, { targetname })) : []),
      ...spawnEntities(variant),
    ],
  };
}

// ---- write, check, walk, draw ----------------------------------------------------------------------------
mkdirSync(OUT, { recursive: true });
writeFileSync(LIFT_WAD, M.writeWad(LIFT_TEXTURES));
const flags = process.argv.slice(2);
const textures = new Set([...Object.values(WADS).filter(existsSync), LIFT_WAD].flatMap((w) => M.wadTextureNames(readFileSync(w))));
const save = (name, img) => writeFileSync(join(OUT, name), K.png(img.width, img.height, img.rgba));
const only = process.env.LIFT_ONLY;
const doing = Object.keys(VARIANTS).filter((v) => !only || v === only);

for (const variant of doing) {
  const name = VARIANTS[variant].name;
  const map = build(variant);
  writeFileSync(join(OUT, `${name}.map`), M.writeMap(map));
  writeFileSync(join(OUT, `tsm_spawns_${name}.cfg`), spawnConfig(variant));
  writeFileSync(join(OUT, `${name}.res`), resList(name));
  const plan = M.checkPlan(map, { textures: [...textures] });
  console.log(`\n${name}: ${map.brushes.length} world brushes, ${map.entities.length} entities`);
  for (const e of plan.errors) console.log(`  ERROR ${e}`);
  for (const w of plan.warnings.slice(0, 6)) console.log(`  warn  ${w}`);
  if (plan.leak) console.log(`  LEAK  ${JSON.stringify(plan.leak).slice(0, 200)}`);
  const markers = variant === "siege" ? ["tsm_obj_1", "tsm_obj_2", "tsm_obj_3"] : variant === "up" ? Object.keys(ZONES) : [];
  const reach = M.reachOf(map, { jump: true, markers });
  console.log(`  walk: ${reach.unreached?.length ?? 0} unreached, ${reach.stuck?.length ?? 0} stuck, ${reach.hanging?.length ?? 0} hanging, ${reach.oneWay?.length ?? 0} one-way`);
  for (const w of reach.warnings.slice(0, 8)) console.log(`    ${w}`);
  for (const e of reach.entities.filter((e) => /^tsm_/.test(e.targetname ?? "")))
    console.log(`    ${e.targetname}: ${e.reached ? `reached by ${e.how}, ${Math.round(e.far)} units` : `NOT reached (${e.why})`}`);
  if (variant === "siege") {
    const area = { min: [-R_GANTRY - 160, -R_GANTRY - 160], max: [R_GANTRY + 160, R_GANTRY + 160] };
    for (const [deck, z] of [["pod", POD.floor + 40], ["cargo", DECKS.cargo.floor + 40], ["passenger", DECKS.passenger.floor + 40], ["drive", DECKS.drive.floor + 40]])
      save(`${name}-plan-${deck}.png`, M.planOfSource(map, { reach, z, area }));
    save(`${name}-section.png`, M.sectionOf(map, { from: [-R_GANTRY - 200, 0], to: [R_GANTRY + 200, 0] }));
    save(`${name}-storeys.png`, M.storeysOf(map, { z: [POD.floor + 40, DECKS.cargo.floor + 40, DECKS.passenger.floor + 40, DECKS.drive.floor + 40], area }));
  }
}

if (flags.includes("--compile")) {
  const xash = flags.includes("--xash");
  for (const variant of doing) {
    const name = VARIANTS[variant].name;
    console.log(`\ncompiling ${name}${xash ? " (Xash)" : ""}...`);
    const eng = xash ? ["-engine", "xash"] : [];
    const perTool = [...eng, "-threads", String(process.env.LIFT_THREADS ?? 6)];
    const result = M.compileMap(join(OUT, `${name}.map`), {
      wads: [...Object.values(WADS).filter(existsSync), LIFT_WAD],
      wadinclude: true,
      out: join(OUT, `${name}.bsp`),
      compilers: { folder: COMPILERS },
      args: { hlcsg: perTool, hlbsp: perTool, hlvis: [...perTool, "-fast"], hlrad: perTool },
      fast: flags.includes("--fast"),
      vis: true,
      light: true,
      timeout: { hlcsg: 600000, hlbsp: 600000, hlvis: 1200000, hlrad: 1800000 },
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
  const at = (deck, r, deg, up = 64) => [...P(r, deg), DECKS[deck].floor + up];
  const VIEWS = [
    ["passenger-window", at("passenger", 600, 200), at("passenger", R_OUT + 600, 200, 80)],
    ["passenger-cabin", at("passenger", 960, 100), at("passenger", 500, 150, 40)],
    ["drive-control", at("drive", 900, 60), at("drive", 300, 80, 60)],
    ["drive-objective", at("drive", 560, 172), [...P(R_CORE + 120, 187), DECKS.drive.floor + 110]],
    ["cargo", at("cargo", 950, 190), at("cargo", 300, 0, 60)],
    ["cargo-clamps", at("cargo", 600, 20), [...P(R_CORE + 60, 7), 80]],
    ["pod", [...P(900, 185), POD.floor + 60], [...P(500, 170), POD.floor + 40]],
    ["gantry", at("passenger", R_OUT + 64, 150), at("passenger", R_OUT + 64, 200, 40)],
    ["gantry-down", at("cargo", R_OUT + 64, 150), [...P(R_OUT + 600, 150), -1500]],
    ["gantry-up", at("drive", R_OUT + 64, 330), [...P(R_OUT + 300, 330), 3000]],
    ["outside", [...P(2000, 225), 900], [0, 0, 400]],
    ["ladder-below", at("cargo", R_OUT + 110, mid(11) - 6, 40), [...P(R_OUT + 20, mid(11)), DECKS.passenger.floor + 40]],
    ["ladder-top", at("passenger", R_OUT + 120, mid(11) + 10, 64), [...P(R_OUT + 30, mid(11)), DECKS.cargo.floor + 40]],
    ["pod-door", [...P(700, 187), POD.floor + 60], [...P(R_GANTRY + 60, 187), POD.floor + 40]],
    ["power-room-doors", at("passenger", 760, 92, 64), [...P(400, 90), DECKS.passenger.floor + 50]],
    ["power-room-breach", at("passenger", 420, 62, 64), [...P(400, 76), DECKS.passenger.floor + 50]],
    ["clamp-vent", at("cargo", 620, 22, 40), [...P(480, 22.5), DECKS.cargo.floor + 20]],
  ];
  const folders = [SKY_FOLDER, join(GAME_DIR, "ts"), join(GAME_DIR, "valve")];
  const dir = join(OUT, "views");
  mkdirSync(dir, { recursive: true });
  const bspFile = join(OUT, `${NAME}.bsp`);
  if (existsSync(bspFile)) {
    const bsp = M.readBsp(readFileSync(bspFile));
    for (const [label, from, to] of VIEWS) {
      try {
        const img = M.drawMap(bsp, { from, to, width: 640, height: 420, brightness: 1.6, folders, entities: "game", labels: false, models: true });
        writeFileSync(join(dir, `${NAME}-${label}.png`), K.png(img.width, img.height, img.rgba));
      } catch (e) {
        console.log(`  ${label}: FAILED -- ${e.message}`);
      }
    }
    console.log(`drew ${NAME} into ${dir}`);
  } else console.log("no .bsp to draw -- compile first");
}

if (flags.includes("deploy")) {
  const dir = join(GAME_DIR, "ts", "maps");
  const configs = join(GAME_DIR, "ts", "addons", "amxmodx", "configs");
  for (const variant of doing) {
    const name = VARIANTS[variant].name;
    const bspFile = join(OUT, `${name}.bsp`);
    if (!existsSync(bspFile)) {
      console.log(`no ${name}.bsp to deploy -- compile first`);
      continue;
    }
    copyFileSync(bspFile, join(dir, `${name}.bsp`));
    copyFileSync(join(OUT, `${name}.res`), join(dir, `${name}.res`));
    copyFileSync(join(OUT, `tsm_spawns_${name}.cfg`), join(configs, `tsm_spawns_${name}.cfg`));
    console.log(`deployed ${name}.bsp and .res to ${dir}, tsm_spawns_${name}.cfg to ${configs}`);
  }
}
