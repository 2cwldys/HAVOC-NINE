// Neuropolis: the city itself.
//
// Not corridors. A city on the sea floor under a dome -- towers with streets between them, roofs
// you can cross, and the sea overhead through the glass. Team elimination is played over the top of
// it, which is why the streets run several ways and the roofline is reachable.
//
// HOW IT JOINS THE HAND-BUILT HALL. The base map is a hall running north to south, x -960..-64,
// y -1024..1024, floor at z 0, with a water window along its west wall. Both teams spawn in it:
// team 1 at the north end, team 2 at the south. The dome is built EAST of it and two gates are cut
// through the hall's east wall, so the city is a second way between the bases -- a flank at a
// different height rather than one more corridor.
//
// WHAT IT CHANGES OF THE BASE. Two brushes, and only where the gates pass through them: the east
// wall (x 0..64) and the low trim in front of it (x -64..0, z 0..64). Everything else is passed
// through untouched, face for face. `cutBase` names the ones it rebuilt on every run.
//
// THE SEA IS THE SKY. The dome's ceiling wears the SKY texture, so it is a hole onto the skybox in
// gfx/env (sky.mjs draws it: shafts of light overhead, dust in the water, the dark below). That is
// why it has depth instead of being a blue pane a few units up. Bands of SKY stand in the upper
// walls as well, so the sea is on three sides too.
import { box, carve, light, stairs, subtract, shapeOf } from "../smak/src/maps/source.mjs";
import { SKY_NAME } from "./sky.mjs";

// ---- the look --------------------------------------------------------------------------------
/* Chosen from what the base already wears plus the city sets in cyberdynamics and avp2, so the
 * hall and the city read as one place. */
const T = {
  floor: "cd_mrbblack",   // black tile, through the city and both halls
  ceiling: "C1A3FLOOR02",
  street: "CD_METALF_DARK",
  wall: "STEC_PANEL3",
  sky: "SKY",
  podium: "DRKMTLT_WALL010",
  trim: "DRKMTLT_WALL010",
  // doors look like doors: an elevator shutter for the leaf, its own trim for the frames
  door: "cd_elevdoor",
  doorTrim: "cd_doortrim",
  tower: "STEC_PANEL3",
  towerAlt: "CD_METALF_DARK",
  window: "cd_offcomp",
  cap: "CD_METALF_DARK",
  walk: "CD_METALF_DARK",
  rail: "MOD_LABPIPE1A",
  glass: "CD_GLASS2",
  lamp: "PILOT_03_LIGHTS",
  // down in the sewer
  /*
   * NOT FROSTSEWER. That is the purple one, and it was turning up on tunnel walls, on the stairwells
   * that drop to the shanty and anywhere else below the city -- the "purple textures" complaint,
   * three times over. Dark metal plate instead: grimy, neutral, and already used elsewhere below.
   */
  sewerWall: "DRKMTLT_WALL010",
  sewerFloor: "GRATE_RUST",
  sewerCeil: "DRKMTLT_WALL010",
  /*
   * What the south slums' shacks are run up out of: boards and rusted sheet.
   *
   * The crate textures in `scrap` are deliberately not here. A crate texture on a box looks like a
   * crate however it is arranged, and a floor with crates standing on it is a store room rather
   * than a slum -- which is the same thing that was learnt about the trash boxes in the undercity.
   */
  board: ["TRRM_WOOD", "TRRM_WOOD2", "GRATE_RUST"],
  /*
   * The engineer route's own surfaces: the corridor out of each hall and the run joining the two
   * slums. It is a BUILT passage and not a dug one, so it is metal the whole way -- riveted plate
   * on the walls, deck underfoot, dark plate overhead -- with no rock or concrete anywhere in it.
   * The slums it links keep their salvage; this is the thing that was put there to reach them.
   */
  routeWall: "STEC_PANEL3",
  routeFloor: "CD_METALF_DARK",
  routeCeil: "DRKMTLT_WALL010",
  // the shanty is cut out of rock far below the sewer, and should not wear the sewer's walls
  shantyWall: "TNNL_C1",
  shantyFloor: "C1A3FLOOR02",
  shantyCeil: "DRKMTLT_WALL010",
  grate: "matgrate_grey1",
  rungs: "{RUSTYRUNGS",
  bin: "CD_METALF_DARK",
  // what the shanty is built out of: salvage, not the sewer's own walls
  scrap: ["TRRM_WOOD", "CRATE05", "GRATE_RUST", "TRRM_WOOD2", "CRATE09", "XCRATE1A"],
  tarp: "cd_bedsheet1",
  corrugate: "GRATE_RUST",
  water: "!WATERGREEN",   // the ! is what makes the engine treat a brush as liquid
  ledge: "matgrate_grey1",
};

// ---- the dome ----------------------------------------------------------------------------------
const WALL = 64;
/** The air the city stands in. Everything must stay within 4096 of the origin on each axis. */
/*
 * The dome stops at 3040, not 3712, so the east hall and its own rock fit inside the 4096 the engine
 * reaches. Everything must be within 4096 of the origin on each axis: GoldSrc sends a position in 16
 * bits at eighths of a unit, and that is as far as it counts.
 */
/*
 * The dome STOPS at the top of the steps, 2340. It has to.
 *
 * Carving the Nexus's rooms while the dome's own room still ran to 3008 gave the Nexus no walls at
 * all: both are rooms in the same carve, and a room inside a room is simply one space. The building
 * existed as a plan and not as a thing. Everything north of 2340 is now solid rock with the Nexus
 * cut into it, which is what makes it a building rather than a marked-out area of the floor.
 */
const DOME = { min: [192, -1792, 0], max: [3040, 2340, 1216] };

/** The hall on the far side, the mirror of the hand-built one: the other side's way in. */
const EAST_HALL = { min: [3168, -1024, 0], max: [4000, 1024, 512] };

/** The two ways in from the hand-built hall, at floor level so there is no step up. */
/*
 * 192 tall, with the door only 160 of it. The top 32 is a solid header across the whole tunnel.
 *
 * A func_door that rolls up slides into the rock above its opening, and a brush ENTITY inside solid
 * is still drawn while the rock around it is not -- so looking up through the doorway you saw the
 * door's underside hanging in blackness. The header gives it something to go behind.
 */
const GATES = [
  { min: [-64, 384, 0], max: [256, 512, 192] },
  { min: [-64, -512, 0], max: [256, -384, 192] },
];
const DOOR_H = 160;
/** And the two from the east hall, in the same places, so neither side has the shorter way. */
const EAST_GATES = [
  { min: [DOME.max[0] - 64, 384, 0], max: [EAST_HALL.min[0] + 64, 512, 192] },
  { min: [DOME.max[0] - 64, -512, 0], max: [EAST_HALL.min[0] + 64, -384, 192] },
];

/*
 * THE UNDERCITY. Tunnels beneath the streets, 192 high and lit by almost nothing -- where whoever
 * the dome was not built for ended up. It is a third way across the map, under both the streets and
 * the high road, and it comes up through shafts in the road with ladders in them.
 *
 * Its ceiling is at -192 and the city's floor slab runs -64 to 0, so there is 128 of rock between
 * the two: enough that no shaft or tunnel opens into a street by accident.
 */
/*
 * 320 deep, not 192. A catwalk 128 up needs headroom over it AND room to walk underneath, and at
 * the first depth there was only enough for one of the two.
 */
const SEWER_Z = [-512, -192];
/** The deck of the catwalks, and how wide they run. */
const CATWALK_Z = -384;
const CATWALK_W = 128;
/*
 * 320 across, not 224. At 224 a catwalk's 128 left under 100 to walk past it, so the deck WAS the
 * tunnel and everything underground was single file. 320 leaves a clear 192 beside the deck.
 */
const SEWER_W = 416;
const sewerSpine = (x0, x1, y0, y1) => ({ min: [x0, y0, SEWER_Z[0]], max: [x1, y1, SEWER_Z[1]] });

/** Where the streets and the blocks sit. */
const BLOCK = 448;
const STREET = 256;
const COLS = 4;
const ROWS = 5;
const SPAN = COLS * BLOCK + (COLS - 1) * STREET;
const X0 = DOME.min[0] + Math.round((DOME.max[0] - DOME.min[0] - SPAN) / 2);
const Y0 = -Math.round((ROWS * BLOCK + (ROWS - 1) * STREET) / 2);
/** The roofs, varied so the skyline is not a comb and so roofs can be crossed between. */
const HIGH = [384, 576, 320, 704, 448, 640, 352, 512, 768, 416, 608, 288, 544, 672, 400, 480, 736, 336, 592, 464, 624, 392, 528, 688, 360];
/*
 * THE NEXUS, at the north end.
 *
 * The city's blocks stop at y 1632; everything past that is the approach. A single flight of very
 * long, very shallow steps runs the FULL WIDTH of the city with no doorway in it, so there is no
 * way up but across the whole front -- you cannot funnel it, and holding it means holding a face
 * 2800 wide. Then the door, then the building.
 */
const CITY_MID_X = X0 + SPAN / 2;
/** 640 of run for 256 of rise: sixteen steps of 40, which is as shallow as stairs get. */
/*
 * The steps start at 1908, not 1700.
 *
 * The last row of blocks ends at 1632, so at 1700 there were 68 units between a building's wall and
 * the first tread -- you came out of a street and were immediately climbing. 1908 leaves 276 of
 * flat ground across the whole width: somewhere to stand, to fight over, and to see the approach
 * from. The flight is 432 long and still 16 treads, which makes each one 27 and the rise 16.
 */
const NEXUS_STEPS = { min: [X0 - 128, 1908, 0], max: [X0 + SPAN + 128, 2340, 256] };
/** The way in: one opening, filled by a door that rolls up. */
const NEXUS_GATE = { min: [CITY_MID_X - 192, 2340, 256], max: [CITY_MID_X + 192, 2496, 640] };
const NEXUS_HALL = { min: [CITY_MID_X - 784, 2432, 256], max: [CITY_MID_X + 784, 2816, 736] };
/** Behind the hall: two offices and the cryo bay between them. */
const NEXUS_BACK = [
  { min: [CITY_MID_X - 704, 2816, 256], max: [CITY_MID_X - 288, 2944, 512] },
  { min: [CITY_MID_X + 288, 2816, 256], max: [CITY_MID_X + 704, 2944, 512] },
  { min: [CITY_MID_X - 224, 2816, 256], max: [CITY_MID_X + 224, 2944, 576] },
];

/*
 * The high road does not stop at the city wall: it carries on north, over the steps, and in through
 * the Nexus's upper storey. That gives the building two ways in at different heights -- the door at
 * the foot of the steps, and this -- which is what keeps the whole north end from being one choke
 * point in front of one door.
 */
const NEXUS_BRIDGE_X = 2320;
const NEXUS_BRIDGE = { min: [NEXUS_BRIDGE_X - 80, 2148, 432], max: [NEXUS_BRIDGE_X + 80, 2496, 608] };

/*
 * THE WAYS DOWN FROM THE HALLS, and the way from the west hall to the Nexus.
 *
 * Both sides get into the undercity from their own hall without crossing the city first, and the
 * west side gets a corridor of its own through to the Nexus. That is not symmetry for its own sake:
 * the two spawns are at opposite ends and whichever one has to walk further to reach a place has
 * already lost the fight for it.
 */
/*
 * THE HAND-BUILT HALL, AS A ROOM.
 *
 * It is not carved -- its walls and floor are the base map's own brushes -- but carve has to be
 * TOLD it is empty space, because carve fills everything inside its block that is not a room. Once
 * rooms were added west of the dome the block reached over the hall, and the hall filled with rock
 * with the player's start entity inside it.
 *
 * Listing it changes nothing about the hall: the room is hollowed, the base's brushes stay exactly
 * where they were, and they go on being its walls.
 *
 * IT MUST COVER THE HALL'S WHOLE EXTENT, not just the part you walk in. At -960 it stopped short of
 * the west wall, and once the new rooms pushed the carve block out to -1024 the strip between the
 * two filled with rock -- which is where the hand-built water window is. The window did not get
 * removed; it got buried. -1216 to -64 is everything the base map occupies, water view included.
 */
const WEST_HALL = { min: [-1216, -1088, -64], max: [-64, 1088, 576] };

const HALL_WELL_W = 320;
const HALL_WELL_L = 448;
/** Under the west hall, and under the east: a stairwell and the tunnel joining it to the network. */
const WEST_WELL = { min: [-800, -224, -512], max: [-800 + HALL_WELL_W, -224 + HALL_WELL_L, 0] };
const EAST_WELL = { min: [3400, -224, -512], max: [3400 + HALL_WELL_W, -224 + HALL_WELL_L, 0] };
const WEST_LINK = { min: [-640, -112, -512], max: [448, 112, -192] };
const EAST_LINK = { min: [2784, -112, -512], max: [3560, 112, -192] };

/*
 * The west hall's own way to the Nexus: up out of the hall, north past the dome in rock, then east
 * into the back of the Nexus hall. It runs at the Nexus's floor height the whole way, so the only
 * climb is the one flight at the start.
 */
const WEST_RISE = { min: [-900, 640, 0], max: [-644, 1024, 320] };
const WEST_CORR_N = { min: [-836, 1000, 256], max: [-660, 2600, 448] };
const WEST_CORR_E = { min: [-836, 2440, 256], max: [900, 2600, 448] };

/*
 * THE SHANTY. A level below the undercity, where the people the dome was not built for ended up
 * after even the sewers were taken from them. It is one wide low space rather than tunnels: the
 * undercity is infrastructure, this is somewhere people live in.
 */
const SHANTY_Z = [-1088, -704];
const SHANTY = { min: [640, -1664, SHANTY_Z[0]], max: [2592, 1664, SHANTY_Z[1]] };
/** The one way down into it, from the undercity's north-south spine. */
/*
 * INSIDE the shanty's own footprint, which it was not.
 *
 * The well ran from the undercity down to -1088 at y 1280..1728 while the shanty stops at y 1216 --
 * so it dropped past the shanty entirely and ended against solid rock. The only way down led
 * nowhere. Its top still lands in the north-south spine, which is what it has to reach above.
 */
/*
 * THREE ways down, not one. All in the north-south spine, spread along its length, and all landing
 * inside the shanty's own footprint -- which the first one did not, so it dropped past the shanty
 * and ended against rock.
 */
/*
 * Up to the sewer's FLOOR at -512, not its ceiling at -192.
 *
 * Run to the ceiling the shaft went straight through the tunnel floor and carried on climbing, so
 * each one showed up as an unexplained hole in the middle of the undercity with a staircase rising
 * out of it into the roof. A way down should end where the floor it starts from is.
 */
/*
 * -1500, -224 and 400, spread down the spine and ALL CLEAR OF THE TREATMENT HALL.
 *
 * The third was at 1052, which put it straight through the water pit (x 1360..1872, y 1252..1764):
 * the stairwell was carved through the pit's floor, so the pit drained into an open hole dropping to
 * the shanty and the ledges across it ran into the staircase. A way down has to be cut somewhere
 * there is floor to cut it in.
 */
const SHANTY_WELLS = [-1500, -224, 400].map((y) => ({
  min: [1488, y, SHANTY_Z[0]],
  // 432 long, because the drop is 576: two flights of 288, eighteen steps of 16, and 432 divides by
  // eighteen to give exactly 24 of run. At 448 every tread landed on a fraction.
  max: [1744, y + 432, SEWER_Z[0]],
}));
/** A chamber round the foot of each, so you step off the stairs into a room and not a corridor. */
const SHANTY_WELL_ROOMS = SHANTY_WELLS.map((w) => ({
  min: [w.min[0] - 192, w.min[1] - 192, SHANTY_Z[0]],
  max: [w.max[0] + 192, w.max[1] + 192, SHANTY_Z[1]],
}));
/** And the same round the two hall wells, which had none at all. */
const HALL_WELL_ROOMS = [
  { min: [-992, -416, -512], max: [-352, 416, -192] },
  { min: [3256, -416, -512], max: [3896, 416, -192] },
];

/*
 * THE SOUTH SLUMS. One behind each spawn hall, down a corridor out of its south wall.
 *
 * Both halls stop at y -1024 and everything south of them was rock out to the edge of the carve.
 * These put a pocket of the shanty in it -- the same salvage, the same burning drums -- at street
 * level, one for each side.
 *
 * The two are NOT joined to each other. A corridor running the length of the map behind the city
 * would be a fourth way between the spawns and a different map; these are somewhere to go, with one
 * door in and no way on.
 *
 * 384 of headroom, which is the shanty's own, and 192 for the corridors, which is the gate tunnels'.
 */
const SOUTH_SLUM_H = 384;
const SOUTH_CORR_H = 192;
const SOUTH_CORR_W = { min: [-640, -1536, 0], max: [-384, -1088, SOUTH_CORR_H] };
const SOUTH_SLUM_W = { min: [-1024, -2688, 0], max: [-192, -1536, SOUTH_SLUM_H] };
const SOUTH_CORR_E = { min: [3456, -1536, 0], max: [3712, -1024, SOUTH_CORR_H] };
/*
 * The east slum stops at x 3136 and goes no further west. The dome's wall is at 3040 and carve
 * needs rock between two rooms or they are one room: a slum reaching past it would be a hole in the
 * dome's south-east corner rather than a room behind the hall.
 */
const SOUTH_SLUM_E = { min: [3136, -2688, 0], max: [3968, -1536, SOUTH_SLUM_H] };
/*
 * And the run that joins the two, which is what makes this a ROUTE rather than two pockets: an
 * engineer leaves one spawn by its door, crosses the south of the map under the dome's foundations
 * and comes out at the other.
 *
 * IT HAS TO STAY SOUTH OF -1856. The dome's room begins at y -1792 and carve needs rock between two
 * rooms or they are one room, so a run that reached any further north would open into the city
 * somewhere along the dome's south wall -- and a third way in is the end of the whole idea, because
 * then anyone can walk the route and the doors guard nothing. Its north wall is at -2048, which
 * leaves 256 of solid.
 *
 * It meets each slum inside that slum's own east or west wall, so the only openings anywhere on the
 * route are the two doors at the spawns.
 */
const SOUTH_LINK = { min: [-192, -2432, 0], max: [3136, -2048, 256] };
/*
 * The hand-built hall's south wall is one of the BASE map's brushes (x -1024..0, y -1088..-1024),
 * which carve never touches -- so a corridor carved up to it still ends against solid, the same way
 * the Nexus route ended against the north wall. This is the hole cut through it.
 *
 * The east hall needs none: it is carved, so a room that touches it opens into it.
 */
const SOUTH_HOLE_W = { min: [-640, -1088, 0], max: [-384, -1024, SOUTH_CORR_H] };
/** Each way south: the corridor, the slum it arrives at, and the face of the hall it leaves by. */
const SOUTH_WAYS = [
  { corridor: SOUTH_CORR_W, slum: SOUTH_SLUM_W, mouth: SOUTH_HOLE_W.max[1] },
  { corridor: SOUTH_CORR_E, slum: SOUTH_SLUM_E, mouth: EAST_HALL.min[1] },
];

/** The height the walkway network runs at, and the roofs it links. */
const WALK_Z = 448;
/** Where the shafts from the undercity come up. Kept off the block grid so they land in streets. */
/*
 * A stairwell is as WIDE as a street and runs 384 ALONG it.
 *
 * It cannot be square. The streets are 256 across and the blocks fill everything else, so a 384
 * square well cut straight through the buildings beside it -- the hole was carved and the building
 * was then built back over the top of it. 256 by 384 fits a street exactly, and a north-south
 * street is clear for its whole length, which is why they all go in one.
 *
 * Two flights of 128 wide sit side by side across that 256, each climbing 256 in sixteen steps:
 * 16 of rise and 24 of run, inside the 18 a player walks up without jumping.
 */
const WELL_W = 256;
const WELL_L = 384;
/** How far a stairwell's chamber opens out past the flights, below the city's floor slab. */
const WELL_ROOM = 224;

/**
 * The base's brushes, with holes cut where the gates pass.
 *
 * A brush no gate touches is passed through EXACTLY as it was read -- the same faces, textures and
 * alignment. Only one in the way is rebuilt, and then from its own box, so the hand-built map keeps
 * its shape. The same function cuts the new rock, so one pass makes the tunnel through both.
 */
function cutBase(brushes, holes) {
  const out = [];
  const cut = [];
  brushes.forEach((brush, index) => {
    const shape = shapeOf(brush);
    const hit = holes.filter((h) => [0, 1, 2].every((i) => shape.min[i] < h.max[i] && h.min[i] < shape.max[i]));
    if (!hit.length) {
      out.push(brush);
      return;
    }
    const tally = {};
    for (const face of shape.faces) tally[face.texture] = (tally[face.texture] ?? 0) + 1;
    const texture = Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0];
    let pieces = [{ min: shape.min, max: shape.max }];
    for (const hole of hit) pieces = pieces.flatMap((p) => subtract(p, hole));
    for (const p of pieces) out.push(box(p.min, p.max, texture));
    cut.push(`${index} -> ${pieces.length}`);
  });
  return { brushes: out, cut };
}

/**
 * One building: a podium it stands on, the shaft, bands of lit window, and a cap over the top.
 *
 * The bands stand 4 units proud of the shaft rather than being flush with it. A face flush with
 * another is one face in a different texture and reads as a flat sticker; standing it out catches
 * the light down one edge and casts a line of shadow, which is what makes a wall look built.
 */
function building(x, y, w, d, high, kind) {
  const out = [];
  const shaft = kind % 2 ? T.towerAlt : T.tower;

  // the podium: wider than the shaft, so the tower sits on something
  out.push(box([x - 16, y - 16, 0], [x + w + 16, y + d + 16, 64], T.podium));
  out.push(box([x, y, 0], [x + w, y + d, high], shaft));

  // window bands up two sides, every 96 units, stopping short of the cap
  for (let z = 160; z < high - 64; z += 96) {
    out.push(box([x - 4, y + 48, z], [x + w + 4, y + d - 48, z + 32], T.window));
  }
  // and a vertical run up the other pair of faces, so the two sides do not match
  if (kind % 3 === 0) {
    for (let o = 64; o < w - 48; o += 128) {
      out.push(box([x + o, y - 4, 96], [x + o + 48, y + d + 4, high - 64], T.window));
    }
  }

  // the cap, and a lit lip under it
  // 16 and not 24: a player walks up 18 at most, so a 24 lip round every roof was a wall round
  // every roof. At 16 a roof can be crossed.
  out.push(box([x - 20, y - 20, high], [x + w + 20, y + d + 20, high + 16], T.cap));
  out.push(box([x - 12, y - 12, high - 16], [x + w + 12, y + d + 12, high], T.lamp));
  return out;
}

export function grow(base, opts = {}) {
  const { spawns = [] } = opts;
  const added = [];
  // Declared with `added` because everything from here down puts lamps in as it builds.
  const lights = [];
  /** Sounds the map plays of its own accord: see the Nexus's, further down. */
  const ambients = [];

  // ---- the shell ------------------------------------------------------------------------------
  /*
   * The gate rooms given to carve start at x 128, not at the hall. That is the whole trick of
   * joining the two: carve's rock reaches `wall` beyond its westmost room, so rooms at 128 put the
   * rock's west face at exactly 64 -- flush against the outer face of the hall's own east wall,
   * with no gap to leak through. Rooms further west would push rock INTO the hall, which is open
   * above z 64. The 64-to-128 plug left across the gates is cut out below.
   */
  const carveGates = GATES.map((g) => ({ min: [128, g.min[1], g.min[2]], max: [g.max[0], g.max[1], g.max[2]] }));

  /*
   * THE UNDERCITY, as rooms. Two spines crossing under the streets, and shafts up to the road.
   *
   * They go into the SAME carve as the dome and the halls. That is the point of carve: one block of
   * rock wrapping every room, with the rooms taken out of it. Everything between them -- the slab
   * under the streets, the rock between the tunnels -- is left solid without anyone working out
   * where it goes, and the whole thing cannot leak.
   */
  const midY = 0;
  const midX = Math.round((DOME.min[0] + DOME.max[0]) / 2);
  const sewerRooms = [
    sewerSpine(DOME.min[0] + 256, DOME.max[0] - 256, midY - SEWER_W / 2, midY + SEWER_W / 2),
    sewerSpine(midX - SEWER_W / 2, midX + SEWER_W / 2, DOME.min[1] + 256, DOME.max[1] - 256),
    // galleries off the spines, so it is a place and not a pipe you run down
    sewerSpine(DOME.min[0] + 512, DOME.min[0] + 1152, -832, -608),
    sewerSpine(DOME.max[0] - 1152, DOME.max[0] - 512, 608, 832),
    // and the cross-passages that join them, which is what makes it a network
    sewerSpine(DOME.min[0] + 768, DOME.min[0] + 992, -832, midY - SEWER_W / 2),
    sewerSpine(DOME.max[0] - 992, DOME.max[0] - 768, midY + SEWER_W / 2, 832),
    sewerSpine(DOME.min[0] + 256, midX - SEWER_W / 2, -1216, -992),
    sewerSpine(midX + SEWER_W / 2, DOME.max[0] - 256, 992, 1216),
    sewerSpine(DOME.min[0] + 256, DOME.min[0] + 480, -1216, -832),
    sewerSpine(DOME.max[0] - 480, DOME.max[0] - 256, 832, 1216),
  ];

  /*
   * THE TREATMENT HALL. The one room down here with a drop in it.
   *
   * Its floor is the tunnels' floor, and a pit goes on down 192 below that, filled to within 48 of
   * the lip with whatever the city sends down. Narrow grate ledges cross it. Falling in is death --
   * a trigger_hurt in the water, not a long drop -- so the ledges are a real decision and the room
   * is worth routing around or through.
   */
  const TREAT = {
    min: [midX - 384, DOME.max[1] - 1216, SEWER_Z[0]],
    max: [midX + 384, DOME.max[1] - 448, SEWER_Z[1]],
  };
  /*
   * THE PIT STOPS 64 SHORT OF THE SHANTY'S CEILING, and it did not.
   *
   * At 192 deep its floor sat at exactly SHANTY_Z[1] -- the shanty's ceiling -- so the two voids
   * met along a plane with no rock between them and the carve joined them into one space. The water
   * had nothing underneath it: you dropped into the pit, through where its bottom should have been,
   * and out of the shanty's ceiling. From below it read as a dark green panel in the middle of the
   * grid, which is the underside of the water seen through the hole.
   *
   * 128 deep leaves 64 of solid between the two, which closes it and gives the shanty a real
   * ceiling there -- retextured with the rest of it, so it matches the grid around it.
   */
  const PIT = {
    min: [TREAT.min[0] + 128, TREAT.min[1] + 128, SEWER_Z[0] - 128],
    max: [TREAT.max[0] - 128, TREAT.max[1] - 128, SEWER_Z[0]],
  };
  sewerRooms.push(TREAT, PIT);
  // the way in from the north-south spine
  sewerRooms.push(sewerSpine(midX - SEWER_W / 2, midX + SEWER_W / 2, TREAT.min[1] - 256, TREAT.min[1] + 8));
  /*
   * Where the stairwells go: the middle of a north-south street, over the east-west spine.
   *
   * Worked out from the block grid rather than written down, so they stay in the streets if the
   * grid ever changes. A street's centre is one block and one half-street past the column before it.
   */
  const streetMid = (k) => X0 + k * (BLOCK + STREET) + BLOCK + STREET / 2;
  const shaftsAt = [0, 1, 2].map((k) => [streetMid(k), midY]);
  /*
   * A stairwell is two rooms stacked, not one shaft.
   *
   * The top is only as wide as the street, because that is all the room there is between the
   * buildings. Below the city's floor slab there is no such limit, so it opens out into a chamber
   * half again as wide: you come off the bottom step into a room and walk away in any direction,
   * instead of being posted down a chimney into a corridor.
   */
  const shafts = shaftsAt.map(([x, y]) => ({
    min: [x - WELL_W / 2, y - WELL_L / 2, SEWER_Z[1]],
    max: [x + WELL_W / 2, y + WELL_L / 2, 0],
  }));
  const wellRooms = shaftsAt.map(([x, y]) => ({
    min: [x - WELL_W / 2 - WELL_ROOM, y - WELL_L / 2 - WELL_ROOM, SEWER_Z[0]],
    max: [x + WELL_W / 2 + WELL_ROOM, y + WELL_L / 2 + WELL_ROOM, SEWER_Z[1]],
  }));

  const rock = carve([DOME, EAST_HALL, ...carveGates, ...EAST_GATES, ...sewerRooms,
      ...shafts,
      ...wellRooms,
      WEST_HALL, WEST_WELL, EAST_WELL, WEST_LINK, EAST_LINK,
      WEST_RISE, WEST_CORR_N, WEST_CORR_E,
      SHANTY, ...SHANTY_WELLS, ...SHANTY_WELL_ROOMS, ...HALL_WELL_ROOMS,
      SOUTH_CORR_W, SOUTH_SLUM_W, SOUTH_LINK, SOUTH_SLUM_E, SOUTH_CORR_E,
      NEXUS_STEPS, NEXUS_GATE, NEXUS_BRIDGE, NEXUS_HALL,
      ...NEXUS_BACK], WALL, {
    floor: T.floor,
    ceiling: T.sky, // the sea overhead
    wall: T.wall,
  });

  /*
   * A face's REAL extent, not its plane's.
   *
   * brush.faces[i].points are the three points that define the face's PLANE. They lie anywhere on
   * it and say nothing about where the face actually is -- a wall of a room can be written with
   * points hundreds of units below its floor. Judging "is this face underground" from them put
   * purple sewer texture up the walls of the east hall, two storeys above the sewer.
   *
   * shapeOf works each face out the way the compiler does, by cutting its plane against all the
   * others, and hands back the polygon that is really drawn. That is what the test needs.
   */
  const byPolygon = (brushes, decide) =>
    brushes.map((brush) => {
      const shape = shapeOf(brush);
      return {
        ...brush,
        faces: brush.faces.map((face, i) => {
          const polygon = shape.faces[i]?.polygon;
          if (!polygon?.length) return face;
          const texture = decide(face, polygon);
          return texture && texture !== face.texture ? { ...face, texture } : face;
        }),
      };
    });

  /*
   * THE UNDERCITY IS NOT UNDER THE SKY, and it has surfaces of its own.
   *
   * carve takes ONE set of textures for every room it cuts, so the sewer came out wearing the
   * dome's sky ceiling -- a tunnel under the streets with open water overhead. Anything at or below
   * the sewer's CEILING gets sewer surfaces instead. The boundary is that ceiling and not street
   * level, because the city's own floor slab runs -64 to 0 and is not undercity.
   */
  const underground = (brushes) =>
    byPolygon(brushes, (face, polygon) => {
      const z = polygon.map((pt) => pt[2]);
      if (Math.max(...z) > SEWER_Z[1]) return null; // the city above
      const flat = Math.max(...z) - Math.min(...z) < 1;
      /*
       * Two levels down here, not one, and they are not the same place.
       *
       * Everything below the sewer's floor is the shanty, and it was coming out in FROSTSEWER -- the
       * sewer's own purple wall -- because one rule covered both. The shanty is a cavern under the
       * drains: tunnel rock and concrete, not tiled municipal sewer.
       */
      if (Math.max(...z) <= SEWER_Z[0] - 1) {
        if (!flat) return T.shantyWall;
        return Math.max(...z) <= SHANTY_Z[0] + 1 ? T.shantyFloor : T.shantyCeil;
      }
      if (!flat) return T.sewerWall;
      return Math.max(...z) <= SEWER_Z[0] + 1 ? T.sewerFloor : T.sewerCeil;
    });

  /*
   * SKY ONLY AT THE DOME'S OWN ROOF.
   *
   * carve takes one ceiling texture for every room it cuts, and that was SKY -- so the Nexus's
   * corridor, its hall, the head of the steps, the stairwells and the east hall all came out with
   * open water overhead. Standing in a corridor buried in rock and looking straight up into the sea
   * is the symptom; one texture applied to thirty rooms is the cause.
   *
   * Only a horizontal face at the dome's ceiling height stays sky. The vertical SKY bands around
   * the dome's walls are untouched, because they are walls and this only looks at flat faces.
   */
  const skyOnlyAtDomeRoof = (brushes) =>
    byPolygon(brushes, (face, polygon) => {
      if (face.texture !== T.sky) return null;
      const z = polygon.map((pt) => pt[2]);
      if (Math.max(...z) - Math.min(...z) > 1) return null; // a wall: leave it
      return Math.abs(z[0] - DOME.max[2]) < 1 ? null : T.ceiling;
    });

  /*
   * THE SOUTH SLUMS ARE NOT THE CITY either, and one carve gave them the city's surfaces.
   *
   * They came out in the dome's black tile and its panelling -- a clean municipal corridor, which
   * is the opposite of what they are. They wear the shanty's rock, concrete and ceiling instead, so
   * both of them read as the same kind of place as the one under the city.
   *
   * Which ROOM a face belongs to, not how high it is. `underground` can go by height because
   * everything below the sewer's ceiling is underground; these two sit at street level, where there
   * is no height that tells them apart from the halls. So a face counts when it lies IN one of a
   * room's own six planes and covers some of that room -- which is every floor, wall and ceiling
   * the room has, and nothing else. A rock face that carries on past the room is retextured along
   * its whole length and that is harmless: the rest of it is buried in the rock beyond and is never
   * drawn.
   */
  /**
   * Is this polygon one of `room`'s own surfaces: a floor, a wall or a ceiling of it?
   *
   * Two tests, and the second is the one that was learnt the hard way. It has to LIE IN one of the
   * room's six planes, and it has to COVER some of the room rather than merely touch its edge --
   * because the slums and the run between them share planes where they meet, and a test that
   * accepts an edge hands each room the other's walls to retexture.
   */
  const facesRoom = (room, lo, hi) => {
    const flat = [0, 1, 2].findIndex(
      (i) => hi[i] - lo[i] < 1 && (Math.abs(lo[i] - room.min[i]) < 1 || Math.abs(lo[i] - room.max[i]) < 1),
    );
    if (flat < 0) return false;
    return [0, 1, 2].every((i) => i === flat || (lo[i] < room.max[i] - 1 && room.min[i] + 1 < hi[i]));
  };
  const extentOf = (polygon) => [
    [0, 1, 2].map((i) => Math.min(...polygon.map((pt) => pt[i]))),
    [0, 1, 2].map((i) => Math.max(...polygon.map((pt) => pt[i]))),
  ];

  const southSlums = (brushes) =>
    byPolygon(brushes, (face, polygon) => {
      const [lo, hi] = extentOf(polygon);
      const room = [SOUTH_SLUM_W, SOUTH_SLUM_E].find((r) => facesRoom(r, lo, hi));
      if (!room) return null;
      if (hi[2] - lo[2] > 1) return T.shantyWall;
      return hi[2] <= room.min[2] + 1 ? T.shantyFloor : T.shantyCeil;
    });

  /*
   * AND THE ROUTE ITSELF IS METAL, where carve left it in the city's panelling and the shanty's
   * rock.
   *
   * The corridor out of each hall and the run joining the two slums are the one thing down here
   * that was BUILT: plate on the walls, deck underfoot and dark plate overhead, the whole way from
   * one door to the other. Mixing rock or concrete into it reads as a patch rather than as a
   * passage, which is exactly what one unretextured wall looked like.
   */
  const southMetal = (brushes) =>
    byPolygon(brushes, (face, polygon) => {
      const [lo, hi] = extentOf(polygon);
      const room = [SOUTH_CORR_W, SOUTH_CORR_E, SOUTH_LINK].find((r) => facesRoom(r, lo, hi));
      if (!room) return null;
      if (hi[2] - lo[2] > 1) return T.routeWall;
      return hi[2] <= room.min[2] + 1 ? T.routeFloor : T.routeCeil;
    });

  /*
   * The hall's water window becomes a window onto the SEA.
   *
   * The hand-built hall has a block of WATER4B behind its glass -- a flat blue pane a few units
   * away, which is as much depth as a texture can give. Retextured to SKY it becomes a hole onto
   * the skybox instead, and the water behind the glass runs away into the dark like the rest of it.
   * Matched by texture rather than by brush number so it survives the base being edited.
   */
  const seaView = base.brushes.map((brush) => {
    const shape = shapeOf(brush);
    if (!shape.faces.every((f) => f.texture.toUpperCase() === "WATER4B")) return brush;
    console.log(`  city: the hall's water block is now a view of the sea`);
    return box(shape.min, shape.max, T.sky);
  });

  /*
   * The base's own floor has to be cut for the west stairwell, not just its wall for the gates.
   *
   * carve hollowed the well, but the hand-built hall's floor slab is one of ITS brushes and carve
   * never touches those -- so the shaft was carved and then capped by the floor over it. The same
   * cut that opens the wall opens the floor.
   */
  /*
   * And the corridor's way out through the hall's NORTH WALL.
   *
   * WEST_CORR_N starts at y 1000 and the hand-built hall's north wall stands at 1024..1088 -- one of
   * the base's own brushes, which carve never touches. So the flight up out of the hall climbed
   * neatly into a solid wall. Every route that leaves the hand-built map has to be cut out of it,
   * and this is the fourth: two gates, the stairwell, and now this.
   */
  const WEST_CORR_HOLE = { min: [-836, 1000, 256], max: [-660, 1100, 448] };
  /*
   * And the headroom over that flight.
   *
   * The hand-built hall has a ceiling beam at z 320..512 running across x -1024..-768, and the stairs
   * out of the spawn top out at 256 -- 64 of clearance under it, where a standing player needs 72.
   * The route was sealed by a beam nobody had reason to look at. Cut only where the flight and its
   * door pass; the rest of the beam is left exactly as it was.
   */
  const WEST_RISE_HEAD = { min: [-900, 640, 256], max: [-644, 1100, 560] };
  const baseHoles = [...GATES, WEST_WELL, WEST_RISE, WEST_RISE_HEAD, WEST_CORR_HOLE, SOUTH_HOLE_W];
  const { brushes: kept, cut } = cutBase(seaView, baseHoles);
  const { brushes: rockCut } = cutBase(southMetal(southSlums(skyOnlyAtDomeRoof(underground(rock)))), baseHoles);
  if (cut.length) console.log(`  city: cut ${cut.length} base brush(es) for the gates -- ${cut.join("; ")}`);

  /*
   * A floor under each gate: the hall's slab stops at x 0 and the dome's rock begins at 64, so the
   * tunnel between them had nothing underneath and was open to the void. The wall that was there
   * had been doing the sealing.
   */
  for (const g of GATES) added.push(box([0, g.min[1], -64], [128, g.max[1], 0], T.floor));

  // ---- the sea at the sides -------------------------------------------------------------------
  /*
   * Above the roofline the dome's wall is SKY, and a pane of glass stands just inside it.
   *
   * It has to be that way round. A SKY face is a hole onto the skybox and must be a WORLD brush --
   * the compilers only treat the world that way. Glass must be a brush ENTITY, because only an
   * entity can be see-through (rendermode 2 with a renderamt): a world brush is always solid. So
   * the sky is the wall and the glass is a separate pane in front of it, which is exactly how the
   * hand-built hall does its own water window.
   *
   * The west side stays rock: the hall is behind it.
   */
  const BAND_Z = 832;
  const t = 16;
  const SKY_BANDS = [
    [[DOME.min[0], DOME.max[1] - t, BAND_Z], [DOME.max[0], DOME.max[1], DOME.max[2]]],
    [[DOME.min[0], DOME.min[1], BAND_Z], [DOME.max[0], DOME.min[1] + t, DOME.max[2]]],
    [[DOME.max[0] - t, DOME.min[1], BAND_Z], [DOME.max[0], DOME.max[1], DOME.max[2]]],
  ];
  for (const [lo, hi] of SKY_BANDS) added.push(box(lo, hi, T.sky));

  // the panes, set 24 in from the sky so there is depth between the two
  const panes = [];
  const GAP = 24;
  panes.push(box([DOME.min[0], DOME.max[1] - t - GAP, BAND_Z], [DOME.max[0], DOME.max[1] - t - GAP + 8, DOME.max[2] - 8], T.glass));
  panes.push(box([DOME.min[0], DOME.min[1] + t + GAP - 8, BAND_Z], [DOME.max[0], DOME.min[1] + t + GAP, DOME.max[2] - 8], T.glass));
  panes.push(box([DOME.max[0] - t - GAP, DOME.min[1], BAND_Z], [DOME.max[0] - t - GAP + 8, DOME.max[1], DOME.max[2] - 8], T.glass));
  /*
   * THE ROOF IS GLAZED, IN BAYS, WITH A FRAME BETWEEN THEM.
   *
   * It began as one sheet of glass 2656 by 3200 hanging over the whole city, which from the street
   * read as a broken slab floating between the towers, so it was taken out and the ceiling left as
   * bare SKY. That is worse. With nothing between the city and the sea the dome does not look
   * enclosed at all -- it looks like the water is free to come in, which is exactly how it was
   * reported.
   *
   * What the single sheet was missing was not less glass but a FRAME. A dome is glazed in panes
   * with mullions between them, and a pane with an edge to belong to reads as glass where an
   * unframed sheet that size reads as a mistake. So the roof is tiled into bays, and the mullions
   * hang just under the glass as world brushes, which is what gives the roof its structure.
   *
   * The glass stops 8 short of the SKY face rather than meeting it. Two surfaces in the same plane
   * leave the engine no way to choose between them, which shows as the roof flickering as you walk
   * -- the same fault the lit strips over the doors had.
   */
  const ROOF_Z = DOME.max[2];
  const BAY = 512;    // how far apart the mullions run
  const MULL = 16;    // how thick they are

  for (let x = DOME.min[0]; x < DOME.max[0]; x += BAY) {
    const x1 = Math.min(x + BAY, DOME.max[0]);
    for (let y = DOME.min[1]; y < DOME.max[1]; y += BAY) {
      const y1 = Math.min(y + BAY, DOME.max[1]);
      panes.push(box([x, y, ROOF_Z - 16], [x1, y1, ROOF_Z - 8], T.glass));
    }
  }
  // the mullions, hung under the glass so the two never share a plane
  for (let x = DOME.min[0] + BAY; x < DOME.max[0]; x += BAY) {
    added.push(box([x - MULL / 2, DOME.min[1], ROOF_Z - 32], [x + MULL / 2, DOME.max[1], ROOF_Z - 16], T.trim));
  }
  for (let y = DOME.min[1] + BAY; y < DOME.max[1]; y += BAY) {
    added.push(box([DOME.min[0], y - MULL / 2, ROOF_Z - 32], [DOME.max[0], y + MULL / 2, ROOF_Z - 16], T.trim));
  }

  /*
   * The east hall's own window onto the sea: a band of SKY in its outer wall with a pane of glass
   * in front, which is the hand-built hall's water window done the same way round.
   */
  const EH_WIN = [160, 320];
  added.push(box([EAST_HALL.max[0] - 16, EAST_HALL.min[1], EH_WIN[0]], [EAST_HALL.max[0], EAST_HALL.max[1], EH_WIN[1]], T.sky));
  panes.push(box([EAST_HALL.max[0] - 40, EAST_HALL.min[1], EH_WIN[0]], [EAST_HALL.max[0] - 32, EAST_HALL.max[1], EH_WIN[1]], T.glass));

  // ---- the blocks ------------------------------------------------------------------------------
  const plots = [];
  let n = 0;
  for (let cx = 0; cx < COLS; cx++) {
    for (let cy = 0; cy < ROWS; cy++) {
      const x = X0 + cx * (BLOCK + STREET);
      const y = Y0 + cy * (BLOCK + STREET);
      const high = HIGH[n % HIGH.length];
      n++;
      // the plaza: the middle block is left open, so the city has a centre worth holding
      if (cx === 2 && cy === 2) {
        plots.push({ x, y, high: 0, plaza: true });
        continue;
      }
      plots.push({ x, y, high });
      added.push(...building(x, y, BLOCK, BLOCK, high, n));
    }
  }

  // ---- the plaza -------------------------------------------------------------------------------
  const plaza = plots.find((p) => p.plaza);
  // a low stepped dais in the middle of it, something to fight over and to stand on
  added.push(box([plaza.x + 96, plaza.y + 96, 0], [plaza.x + BLOCK - 96, plaza.y + BLOCK - 96, 32], T.street));
  added.push(box([plaza.x + 160, plaza.y + 160, 32], [plaza.x + BLOCK - 160, plaza.y + BLOCK - 160, 64], T.podium));
  /*
   * The beacon runs all the way up to the high road and carries it.
   *
   * It stopped at 320 and the walkway crossed above it at 448, so a lit column stood in the middle
   * of the plaza holding nothing up while a catwalk floated over it. Taking it to the deck makes it
   * the thing the deck stands on, which is what it looked like it ought to be.
   */
  added.push(box([plaza.x + 192, plaza.y + 192, 64], [plaza.x + BLOCK - 192, plaza.y + BLOCK - 192, WALK_Z + 16], T.lamp));
  // a collar where it meets the deck, so it lands on something rather than just touching
  added.push(box([plaza.x + 176, plaza.y + 176, WALK_Z - 24], [plaza.x + BLOCK - 176, plaza.y + BLOCK - 176, WALK_Z], T.cap));

  // ---- the high road ---------------------------------------------------------------------------
  /*
   * A walkway over the streets, so there is a way across the city as well as along it. Team
   * elimination turns on flanking and on breaking a hold, and one flat plane of streets gives
   * neither.
   *
   * It runs down the MIDDLE OF TWO STREETS rather than over the blocks. That is not decoration: the
   * blocks are 288 to 768 tall, so a walkway at one height would pass through half of them. The
   * streets are empty all the way, which is the only continuous line through the city at a height.
   */
  const WALK_W = 128;
  const streetY = Y0 + 1 * (BLOCK + STREET) + BLOCK + STREET / 2;
  const streetX = X0 + 2 * (BLOCK + STREET) + BLOCK + STREET / 2;
  /*
   * 1088, so the flight below comes out on whole numbers: it runs 896 from x 192, and 28 steps of
   * 16 rise then measure exactly 32 each. At 1024 the run was 29.714 and every step landed off the
   * grid -- which the plan check reports, because two brushes that should share a plane can get
   * planes a hair apart and open a crack between them.
   */
  const ewFrom = DOME.min[0] + 1088;

  /*
   * A rail in pieces, with a gap where the other walkway crosses.
   *
   * Run whole, the two walkways' rails fenced their own junction off: you could walk to the middle
   * of the city on the high road and not step across to the other one. A rail is there to stop a
   * fall, not to stop the route it is on.
   */
  const CROSS_GAP = 112;
  const railRun = (fromAt, toAt, gapAt, lo, hi, axis) => {
    const spans = [[fromAt, gapAt - CROSS_GAP], [gapAt + CROSS_GAP, toAt]];
    for (const [s0, s1] of spans) {
      if (s1 - s0 < 32) continue;
      const min = [0, 0, WALK_Z + 16];
      const max = [0, 0, WALK_Z + 56];
      min[axis] = s0; max[axis] = s1;
      min[1 - axis] = lo; max[1 - axis] = hi;
      added.push(box(min, max, T.rail));
    }
  };
  const walkway = (min, max, gapAt) => {
    added.push(box(min, [max[0], max[1], WALK_Z + 16], T.walk));
    const alongX = max[0] - min[0] > max[1] - min[1];
    if (alongX) {
      railRun(min[0], max[0], gapAt, min[1], min[1] + 8, 0);
      railRun(min[0], max[0], gapAt, max[1] - 8, max[1], 0);
    } else {
      railRun(min[1], max[1], gapAt, min[0], min[0] + 8, 1);
      railRun(min[1], max[1], gapAt, max[0] - 8, max[0], 1);
    }
  };
  /*
   * The walkways run right up to the dome's walls.
   *
   * They stopped 192 short, which left a deck ending in mid-air over the street with nothing at its
   * end -- a bridge to nowhere. A walkway that has no landing to arrive at should at least die
   * against a wall, so it reads as a gantry rather than as something unfinished.
   */
  walkway([ewFrom, streetY - WALK_W / 2, WALK_Z], [DOME.max[0], streetY + WALK_W / 2, WALK_Z], streetX);
  walkway([streetX - WALK_W / 2, DOME.min[1], WALK_Z], [streetX + WALK_W / 2, NEXUS_BRIDGE.min[1] + 16, WALK_Z], streetY);
  // the bridge deck itself, carrying it over the steps and in through the wall
  added.push(box([NEXUS_BRIDGE.min[0], NEXUS_BRIDGE.min[1], WALK_Z], [NEXUS_BRIDGE.max[0], NEXUS_BRIDGE.max[1], WALK_Z + 16], T.walk));
  added.push(box([NEXUS_BRIDGE.min[0], NEXUS_BRIDGE.min[1], WALK_Z + 16], [NEXUS_BRIDGE.min[0] + 8, NEXUS_BRIDGE.max[1] - 96, WALK_Z + 56], T.rail));
  added.push(box([NEXUS_BRIDGE.max[0] - 8, NEXUS_BRIDGE.min[1], WALK_Z + 16], [NEXUS_BRIDGE.max[0], NEXUS_BRIDGE.max[1] - 96, WALK_Z + 56], T.rail));

  /*
   * The way up, at the west end: a flight climbing east that STOPS where the walkway starts. An
   * earlier go had the stairs under their own walkway, which is a staircase into a ceiling.
   */
  added.push(
    ...stairs(
      [DOME.min[0] + 192, streetY - WALK_W / 2, 0],
      [ewFrom, streetY + WALK_W / 2, WALK_Z],
      "+x",
      T.street,
      { rise: 16 },
    ),
  );

  // ---- the gate doors ----------------------------------------------------------------------------
  /*
   * A door in each of the four ways between a hall and the city, and a lintel over it.
   *
   * They roll UP, like the Nexus's: angles "-1 0 0" is func_door's way of being told "straight up",
   * since a real pitch of -90 could not be told apart from pointing down. No targetname, so walking
   * into one opens it; wait 3 closes it again behind you.
   *
   * The lintel matters as much as the door. The tunnels are 160 tall inside rock that goes up to the
   * dome's ceiling, so the head of each opening was just unlit rock receding -- a black slot over
   * the doorway with nothing to say where the opening stopped.
   */
  /*
   * ONE ENTITY PER DOOR, not one entity holding four leaves.
   *
   * Every brush of a func_door is part of the same door and moves with it, so the four gate leaves
   * in one entity meant walking into any of them opened all four -- including the two at the far
   * end of the map. A door is a door.
   */
  const doors = [];
  /** A leaf that rolls up, with its own header, jambs and light. */
  /*
   * A DOOR LOOKS LIKE A DOOR. Giving the leaf the wall's own panel was the wrong reading of
   * "match the other side": it made the doors disappear into the walls they sit in, so an opening
   * you are meant to walk up to and open looked like a bit of unfinished panelling. cd_elevdoor is
   * a shutter, which is what these are -- and a box textures every face alike, so both sides of the
   * leaf match each other anyway.
   */
  /*
   * `keys` is for a door something outside the map has to find or treat differently -- a targetname
   * for a plugin, a spawnflag. It is spread before `brushes` so a door cannot accidentally be given
   * a different leaf through it.
   */
  const rollingDoor = (lo, hi, leafHigh, skin = T.door, keys = {}) => {
    doors.push({
      classname: "func_door",
      /*
       * "0 -1 0" is UP, and "-1 0 0" is not.
       *
       * CBaseToggle::SetMovedir in the SDK tests the angles vector against (0, -1, 0) for up and
       * (0, -2, 0) for down -- the special value lives in YAW, because the map format's old `angle`
       * key wrote to angles.y. A pitch of -1 is not special at all: it falls through to
       * UTIL_MakeVectors and gives a forward vector of about (0.9998, 0, 0.0175), so every one of
       * these doors was sliding SIDEWAYS along +x by its own thickness instead of rolling up. One
       * happened to slide into clear space and looked like it worked; the rest just stayed shut.
       */
      angles: "0 -1 0",
      speed: "60",
      wait: "3",
      lip: "8",
      rendercolor: "0 0 0",
      ...keys,
      brushes: [box(lo, [hi[0], hi[1], leafHigh], skin)],
    });
  };

  /**
   * The lit strip at the head of a doorway: one on each FACE of the wall, and none in the opening.
   *
   * It was a single brush laid across the opening at the leaf's top, which put it in two places it
   * could not be. Inside the HEADER, which is a world brush filling that same opening above the leaf
   * -- two solids in one space, and where their faces meet the engine cannot choose between them,
   * which is the flickering band of light along the top of the door. And in the LEAF'S PATH, so a
   * door that rolls up carries the strip inside it.
   *
   * The opening belongs to the leaf and nothing else may stand in it. These sit outside it, on the
   * wall either side, where the jambs already are -- which is where a light over a door goes anyway.
   */
  const headLights = [];
  /*
   * Given as boxes rather than worked out from an opening, because the four doors do not all face
   * the same way. The hall gates are a leaf across a tunnel that runs along X; the other three sit
   * in walls that face along Y. Deriving the two strips from one axis put the gates' pair inside
   * the rock beside the tunnel, where they lit nothing and were never seen.
   */
  const headLight = (...boxes) => {
    for (const [lo, hi] of boxes) {
      // where it is and where it sits in `added`, so the check at the end can skip itself
      headLights.push({ lo, hi, at: added.length });
      added.push(box(lo, hi, T.lamp));
    }
  };

  for (const g of [...GATES, ...EAST_GATES]) {
    const midX = (g.min[0] + g.max[0]) / 2;
    const leaf = [midX - 16, midX + 16];
    rollingDoor([leaf[0], g.min[1], g.min[2]], [leaf[1], g.max[1], g.max[2]], DOOR_H);

    /*
     * The header: a WORLD brush right across the tunnel, filling the 32 above the door. World, not
     * entity, so it is part of the map's own solid and the engine culls what is behind it -- which
     * is the whole point. The door opens up into the rock behind this and is no longer in sight.
     */
    added.push(box([g.min[0], g.min[1], DOOR_H], [g.max[0], g.max[1], g.max[2]], T.doorTrim));
    /*
     * A lit strip on each face, capping the jambs. 4 thick: PILOT_03_LIGHTS is named in the base
     * map's info_texlights and actually EMITS, so a deep one reads as a blown-out lintel rather
     * than as a light fitting.
     */
    headLight(
      [[leaf[0] - 24, g.min[1], DOOR_H - 4], [leaf[0], g.max[1], DOOR_H]],
      [[leaf[1], g.min[1], DOOR_H - 4], [leaf[1] + 24, g.max[1], DOOR_H]],
    );
    // jambs down each side of the leaf
    added.push(box([leaf[0] - 24, g.min[1] - 16, g.min[2]], [leaf[1] + 24, g.min[1], DOOR_H], T.doorTrim));
    added.push(box([leaf[0] - 24, g.max[1], g.min[2]], [leaf[1] + 24, g.max[1] + 16, DOOR_H], T.doorTrim));
    lights.push(light([midX, (g.min[1] + g.max[1]) / 2, DOOR_H - 40], { color: [200, 230, 255], brightness: 150 }));
  }
  /*
   * And one inside the Nexus, where the west corridor arrives. The MSR side comes through its own
   * hall, its own corridor and its own door -- so the building has three ways in at three heights
   * and no single place to stand that holds all of them.
   */
  {
    const dy = [WEST_CORR_E.min[1] + 40, WEST_CORR_E.max[1] - 40];
    const dx = [NEXUS_HALL.min[0] - 24, NEXUS_HALL.min[0] + 8];
    const top = WEST_CORR_E.max[2];
    rollingDoor([dx[0], dy[0], WEST_CORR_E.min[2]], [dx[1], dy[1], top], top - 32);
    // its header and jambs, world brushes so what is behind them is culled
    added.push(box([dx[0] - 8, dy[0], top - 32], [dx[1] + 8, dy[1], top], T.trim));
    added.push(box([dx[0] - 8, dy[0] - 40, WEST_CORR_E.min[2]], [dx[1] + 8, dy[0], top], T.trim));
    added.push(box([dx[0] - 8, dy[1], WEST_CORR_E.min[2]], [dx[1] + 8, dy[1] + 40, top], T.trim));
    lights.push(light([dx[1] + 80, (dy[0] + dy[1]) / 2, top - 72], { color: [205, 228, 255], brightness: 170 }));
  }

  /*
   * And one where the high road arrives on the upper floor.
   *
   * It sits in the thickness of the Nexus's own wall -- the rock between the dome ending at 2340 and
   * the hall starting at 2432 -- so the bridge runs up to a door in the building's face rather than
   * straight through an opening. That makes all three ways in doors: the main one at the foot of the
   * steps, the west corridor's, and this.
   *
   * It stands on the deck at 464 rather than on the room's floor, because the deck IS the floor here.
   */
  {
    const dy = [2372, 2404];
    const dx = [NEXUS_BRIDGE.min[0] + 16, NEXUS_BRIDGE.max[0] - 16];
    const sill = WALK_Z + 16;
    const head = NEXUS_BRIDGE.max[2];
    rollingDoor([dx[0], dy[0], sill], [dx[1], dy[1], head], head - 32);
    // header and jambs, world brushes so the door is culled once it has rolled up behind them
    added.push(box([dx[0] - 16, dy[0], head - 32], [dx[1] + 16, dy[1], head], T.trim));
    added.push(box([dx[0] - 16, dy[0] - 24, sill], [dx[0], dy[1] + 24, head], T.trim));
    added.push(box([dx[1], dy[0] - 24, sill], [dx[1] + 16, dy[1] + 24, head], T.trim));
    headLight(
      [[dx[0], dy[0] - 24, head - 32], [dx[1], dy[0], head - 28]],
      [[dx[0], dy[1], head - 32], [dx[1], dy[1] + 24, head - 28]],
    );
    lights.push(light([(dx[0] + dx[1]) / 2, dy[1] + 96, head - 64], { color: [205, 228, 255], brightness: 170 }));
  }

  /*
   * The door the MSR side walks up to, at the head of their own stairs.
   *
   * It is in the thickness of the hall's north wall, so the climb out of the spawn ends at a door
   * rather than at an opening -- and it is the first of the three on that route, before the corridor
   * and before the Nexus itself.
   */
  {
    const dy = [1036, 1068];
    const dx = [WEST_CORR_HOLE.min[0] + 8, WEST_CORR_HOLE.max[0] - 8];
    const sill = WEST_CORR_HOLE.min[2];
    const head = WEST_CORR_HOLE.max[2];
    rollingDoor([dx[0], dy[0], sill], [dx[1], dy[1], head], head - 32);
    added.push(box([dx[0] - 8, dy[0], head - 32], [dx[1] + 8, dy[1], head], T.doorTrim));
    added.push(box([dx[0] - 8, dy[0] - 24, sill], [dx[0], dy[1] + 24, head], T.doorTrim));
    added.push(box([dx[1], dy[0] - 24, sill], [dx[1] + 8, dy[1] + 24, head], T.doorTrim));
    headLight(
      [[dx[0], dy[0] - 24, head - 32], [dx[1], dy[0], head - 28]],
      [[dx[0], dy[1], head - 32], [dx[1], dy[1] + 24, head - 28]],
    );
    lights.push(light([(dx[0] + dx[1]) / 2, dy[0] - 96, head - 64], { color: [205, 228, 255], brightness: 170 }));
  }

  /*
   * THE TWO DOORS INTO THE SOUTH SLUMS, and the frames round the openings their corridors leave the
   * halls by.
   *
   * These are the only doors in the map with a targetname. ts_matchmode looks for "tsm_eng_door"
   * and refuses the Use for anyone who is not a combat engineer, so the name is a contract with the
   * plugin and not decoration: change it here and the doors open for everybody.
   *
   * spawnflags 256 is SF_DOOR_USE_ONLY (hlsdk_const.inc: "Door must be opened by player's use
   * button"). It does two things that matter. CBaseDoor::Spawn drops the door's touch function, so
   * walking into one no longer opens it -- without that the plugin would be refusing a +USE that
   * was never needed. And CBaseDoor::ObjectCaps adds FCAP_IMPULSE_USE when the flag is set, which
   * is what puts the door under a player's +USE at all.
   */
  for (const { corridor, slum, mouth } of SOUTH_WAYS) {
    const sill = corridor.min[2];
    const head = corridor.max[2];
    // the leaf, at the corridor's south end where it arrives at the slum
    const dx = [corridor.min[0] + 32, corridor.max[0] - 32];
    const dy = [slum.max[1], slum.max[1] + 32];
    rollingDoor([dx[0], dy[0], sill], [dx[1], dy[1], head], head - 32, T.door, {
      targetname: "tsm_eng_door",
      spawnflags: "256",
    });
    // the header filling the opening above the leaf, world so the leaf is culled behind it
    added.push(box([dx[0], dy[0], head - 32], [dx[1], dy[1], head], T.doorTrim));
    /*
     * The jambs carry the frame out to the corridor's own walls. A door that does not reach them
     * leaves a slot beside the leaf, and a slot in a door is a door that is open.
     */
    added.push(box([corridor.min[0], dy[0] - 24, sill], [dx[0], dy[1] + 24, head], T.doorTrim));
    added.push(box([dx[1], dy[0] - 24, sill], [corridor.max[0], dy[1] + 24, head], T.doorTrim));
    headLight(
      [[dx[0], dy[0] - 24, head - 32], [dx[1], dy[0], head - 28]],
      [[dx[0], dy[1], head - 32], [dx[1], dy[1] + 24, head - 28]],
    );
    lights.push(light([(dx[0] + dx[1]) / 2, dy[0] - 96, head - 64], { color: [255, 186, 130], brightness: 150 }));
    lights.push(light([(dx[0] + dx[1]) / 2, dy[1] + 96, head - 64], { color: [205, 228, 255], brightness: 150 }));

    /*
     * And the frame round the far end, standing 8 proud of the hall's wall. Without it the way out
     * of a spawn is a 256 by 192 hole in a flat wall, which reads as damage rather than as a door.
     */
    const post = 24;
    added.push(box([corridor.min[0] - post, mouth, sill], [corridor.min[0], mouth + 8, head + post], T.doorTrim));
    added.push(box([corridor.max[0], mouth, sill], [corridor.max[0] + post, mouth + 8, head + post], T.doorTrim));
    added.push(box([corridor.min[0] - post, mouth, head], [corridor.max[0] + post, mouth + 8, head + post], T.doorTrim));
    lights.push(light([(corridor.min[0] + corridor.max[0]) / 2, mouth + 96, head - 48], { color: [200, 222, 255], brightness: 150 }));

    // down the corridor itself, which is otherwise the one unlit stretch between the two
    for (let y = corridor.min[1] + 160; y < corridor.max[1] - 64; y += 256) {
      lights.push(light([(corridor.min[0] + corridor.max[0]) / 2, y, head - 48], { color: [186, 202, 220], brightness: 100 }));
    }
  }

  // ---- the Nexus ---------------------------------------------------------------------------------
  /*
   * The steps, the door, and what is behind it.
   *
   * The steps are carved as one room and filled with a single flight the full width of the city --
   * sixteen treads of 40, which is as shallow as stairs get and the reason they read as a civic
   * approach rather than a staircase. There is no doorway in them on purpose: the only way up is
   * across the whole face.
   */
  /*
   * The flight stops 96 short of the top and the landing fills that, FLUSH with the last tread.
   *
   * The landing used to be a slab laid over the finished flight, so it stood 16 proud of the top
   * steps and every tread under it had a lip hanging over the one below -- the stairs looked like
   * they were sliding downhill. A landing is part of the staircase, not something put on top of it.
   *
   * 336 of run over 16 treads is 21 each, with the rise still 16.
   */
  const LANDING = 96;
  added.push(
    ...stairs(
      [NEXUS_STEPS.min[0], NEXUS_STEPS.min[1], 0],
      [NEXUS_STEPS.max[0], NEXUS_STEPS.max[1] - LANDING, NEXUS_STEPS.max[2]],
      "+y",
      T.street,
      { rise: 16 },
    ),
  );

  /*
   * A landing at the head of the steps.
   *
   * Sixteen treads arriving straight at a door leaves nowhere to stand: the last tread IS the
   * threshold, so you are still climbing when the door opens. A flat 96 across the whole width
   * gives the approach somewhere to end, and the door something to open onto.
   */
  /*
   * Solid from the floor up, not a 16-thick slab laid at the top.
   *
   * As a slab it had 240 of open air under it, so its front edge stood proud over nothing and the
   * whole landing read as a platform jutting out past the end of the stairs. A landing is the top of
   * the staircase and should be as solid as the rest of it.
   */
  added.push(box([NEXUS_STEPS.min[0], NEXUS_STEPS.max[1] - LANDING, 0], [NEXUS_STEPS.max[0], NEXUS_STEPS.max[1], NEXUS_STEPS.max[2]], T.street));

  /*
   * The door. It rolls UP, which is what angles "-1 0 0" means to func_door -- a pitch of -1 is the
   * engine's way of saying "straight up", because a real pitch of -90 would be indistinguishable
   * from pointing down. lip is how much of it stays showing when open, so the lintel keeps a
   * header rather than the door vanishing into the ceiling.
   */
  const DOOR_Y = [2400, 2432];
  /*
   * A DOOR IN A WALL, not a slab filling the opening.
   *
   * It was the full 384 of the gate, wearing the roof-cap texture, with a lit brush laid across the
   * very space it rises into. From the foot of the steps that reads as a wall with a panel in it --
   * which is what you see when you look at the top of the approach and cannot tell there is a way in.
   *
   * Now: a 288 leaf standing on the landing, a solid WORLD header above it, and the frame round it.
   * The header is world so the engine culls the door once it has rolled up behind it, which is the
   * same reason the gate tunnels have one.
   */
  const NEXUS_DOOR_H = NEXUS_GATE.min[2] + 288;
  rollingDoor(
    [NEXUS_GATE.min[0], DOOR_Y[0], NEXUS_GATE.min[2]],
    [NEXUS_GATE.max[0], DOOR_Y[1], NEXUS_GATE.max[2]],
    NEXUS_DOOR_H,
  );
  // the header, filling the opening above the leaf
  added.push(box([NEXUS_GATE.min[0], DOOR_Y[0], NEXUS_DOOR_H], [NEXUS_GATE.max[0], DOOR_Y[1], NEXUS_GATE.max[2]], T.doorTrim));
  // a lit strip on each face, so the head of the opening reads from the bottom of the steps
  headLight(
    [[NEXUS_GATE.min[0], DOOR_Y[0] - 8, NEXUS_DOOR_H], [NEXUS_GATE.max[0], DOOR_Y[0], NEXUS_DOOR_H + 4]],
    [[NEXUS_GATE.min[0], DOOR_Y[1], NEXUS_DOOR_H], [NEXUS_GATE.max[0], DOOR_Y[1] + 8, NEXUS_DOOR_H + 4]],
  );
  // and the jambs
  added.push(box([NEXUS_GATE.min[0] - 32, DOOR_Y[0] - 8, NEXUS_GATE.min[2]], [NEXUS_GATE.min[0], DOOR_Y[1] + 8, NEXUS_GATE.max[2]], T.doorTrim));
  added.push(box([NEXUS_GATE.max[0], DOOR_Y[0] - 8, NEXUS_GATE.min[2]], [NEXUS_GATE.max[0] + 32, DOOR_Y[1] + 8, NEXUS_GATE.max[2]], T.doorTrim));

  /*
   * A bin burning at the foot of the steps, with a real flame: env_sprite drawing valve's fire.spr,
   * additive so the black of the sprite drops out and only the fire shows. TS has no fire sprite of
   * its own; valve/ is where the engine looks when a mod lacks a file, so this resolves.
   */
  /*
   * In the strip between the last row of blocks (which ends at 1632) and the foot of the steps. At
   * 96 back they stood inside a building, which the plan check reports as an entity in a world
   * brush -- a lamp or a sprite in solid lights and shows nothing.
   */
  const binY = NEXUS_STEPS.min[1] - 36;
  const binAt = [
    [NEXUS_STEPS.min[0] + 192, binY],
    [NEXUS_STEPS.max[0] - 192, binY],
  ];
  const flames = [];
  /**
   * A flame standing at a point: valve's fire.spr, additive so the black around it drops out.
   *
   * Every drum in the map burns through this one, so they all animate at the same rate and drop
   * their background the same way. rendermode 5 is additive and rendercolor is ignored by it.
   */
  const flame = (x, y, z, scale) => {
    flames.push({
      classname: "env_sprite",
      origin: `${x} ${y} ${z}`,
      model: "sprites/fire.spr",
      rendermode: "5",
      renderamt: "255",
      rendercolor: "0 0 0",
      scale: `${scale}`,
      framerate: "12",
      spawnflags: "1", // start on
    });
  };
  for (const [bx, by] of binAt) {
    added.push(box([bx - 24, by - 24, 0], [bx + 24, by + 24, 64], T.bin));
    added.push(box([bx - 18, by - 18, 64], [bx + 18, by + 18, 70], T.lamp));
    flame(bx, by, 108, 2);
    lights.push(light([bx, by, 128], { color: [255, 150, 60], brightness: 220 }));
  }

  /*
   * THE UPPER FLOOR, which is what the high road arrives on.
   *
   * A gallery round the north and east of the hall at the bridge's own height, with one flight down
   * to the floor at the far end. So the two ways into the Nexus land in different places and a
   * player holding the door is not also holding the bridge -- and anyone who takes the gallery has
   * to cross the whole hall in the open to get down.
   */
  const MEZZ_Z = WALK_Z;
  const mezzEast = [2208, NEXUS_HALL.max[0]];
  const mezzNorth = [2624, NEXUS_HALL.max[1]];
  // the deck along the east wall, which the bridge comes in over
  added.push(box([mezzEast[0], NEXUS_HALL.min[1], MEZZ_Z], [mezzEast[1], mezzNorth[0], MEZZ_Z + 16], T.walk));
  // and along the north wall, back to the stairs
  added.push(box([NEXUS_HALL.min[0] + 312, mezzNorth[0], MEZZ_Z], [mezzEast[1], mezzNorth[1], MEZZ_Z + 16], T.walk));
  // rails on the two open edges, stopping short of where the stairs meet them
  added.push(box([mezzEast[0], NEXUS_HALL.min[1] + 96, MEZZ_Z + 16], [mezzEast[0] + 8, mezzNorth[0], MEZZ_Z + 56], T.rail));
  added.push(box([NEXUS_HALL.min[0] + 312, mezzNorth[0], MEZZ_Z + 16], [mezzEast[0], mezzNorth[0] + 8, MEZZ_Z + 56], T.rail));

  // the one way down, at the far end from the bridge
  added.push(
    ...stairs(
      [NEXUS_HALL.min[0], mezzNorth[0] + 64, NEXUS_HALL.min[2]],
      [NEXUS_HALL.min[0] + 312, mezzNorth[1], MEZZ_Z + 16],
      "+x",
      T.ledge,
      { rise: 16 },
    ),
  );
  lights.push(light([mezzEast[0] + 96, mezzNorth[0] + 96, MEZZ_Z + 160], { color: [200, 228, 255], brightness: 190 }));
  lights.push(light([NEXUS_HALL.min[0] + 192, mezzNorth[0] + 96, MEZZ_Z + 96], { color: [200, 228, 255], brightness: 160 }));
  for (let x = NEXUS_BRIDGE.min[0] - 640; x < NEXUS_BRIDGE.max[0]; x += 320) {
    lights.push(light([x, NEXUS_BRIDGE.min[1] + 120, WALK_Z + 112], { color: [190, 215, 255], brightness: 150 }));
  }

  /*
   * Inside: two offices and the cryo bay between them, open to the hall rather than doored. carve
   * joins rooms that touch into one space, so the back rooms meeting the hall's wall IS the opening
   * -- no doorway brush needed, and nothing to get stuck in during a firefight.
   */
  const [officeW, officeE, cryo] = NEXUS_BACK;
  for (const office of [officeW, officeE]) {
    const ox = (office.min[0] + office.max[0]) / 2;
    // a desk and a seat behind it
    added.push(box([ox - 96, office.min[1] + 40, 256], [ox + 96, office.min[1] + 96, 288], T.cap));
    added.push(box([ox - 88, office.min[1] + 40, 288], [ox + 88, office.min[1] + 48, 320], T.window));
    added.push(box([ox - 24, office.min[1] + 104, 256], [ox + 24, office.min[1] + 136, 296], T.bin));
    // a bank of screens on the back wall
    added.push(box([ox - 128, office.max[1] - 8, 320], [ox + 128, office.max[1], 432], T.window));
    lights.push(light([ox, (office.min[1] + office.max[1]) / 2, 440], { color: [200, 225, 255], brightness: 170 }));
  }

  /*
   * The cryo pods: a drum stood on end with a lit face, in two rows down the bay. Not hollow -- what
   * matters is that they read as occupied, and a pod a player can stand inside is a place to hide
   * in a room this small.
   */
  const cryoMid = (cryo.min[1] + cryo.max[1]) / 2;
  for (let i = 0; i < 6; i++) {
    const px = cryo.min[0] + 56 + i * 68;
    for (const py of [cryoMid - 44, cryoMid + 44]) {
      added.push(box([px - 26, py - 26, 256], [px + 26, py + 26, 272], T.cap));
      added.push(box([px - 24, py - 24, 272], [px + 24, py + 24, 416], T.podium));
      // the lit window down the front of the pod
      added.push(box([px - 14, py - 28, 288], [px + 14, py - 24, 400], T.window));
      added.push(box([px - 26, py - 26, 416], [px + 26, py + 26, 432], T.lamp));
    }
  }
  lights.push(light([(cryo.min[0] + cryo.max[0]) / 2, cryoMid, 480], { color: [150, 215, 255], brightness: 200 }));

  // the hall itself
  for (let x = NEXUS_HALL.min[0] + 192; x < NEXUS_HALL.max[0]; x += 384) {
    lights.push(light([x, (NEXUS_HALL.min[1] + NEXUS_HALL.max[1]) / 2, 640], { color: [205, 230, 255], brightness: 230 }));
  }
  // and the approach, so the steps are lit from the top
  for (let x = NEXUS_STEPS.min[0] + 256; x < NEXUS_STEPS.max[0]; x += 512) {
    lights.push(light([x, NEXUS_STEPS.max[1] - 64, 384], { color: [190, 215, 255], brightness: 190 }));
  }

  // ---- light -----------------------------------------------------------------------------------
  /*
   * A city needs far more light than a room, and the first draft proved it: eight lamps at z 640
   * lit almost nothing, because most were ABOVE the towers and the streets sat in their shadow.
   * GoldSrc bakes light once from the entities that are there, and a SKY face gives none of its own
   * unless a light_environment says so -- which would be daylight, and there is none down here.
   *
   * So: a lamp at every step along the streets, under the roofline where it reaches the ground, and
   * a colder, sparser grid high up so the dome itself glows.
   */
  const solids = added.filter((b) => b.faces).map((b) => shapeOf(b));
  const inSolid = (p) => solids.some((s) => [0, 1, 2].every((i) => p[i] > s.min[i] - 32 && p[i] < s.max[i] + 32));

  const STEP = 256;
  for (let x = DOME.min[0] + 128; x < DOME.max[0]; x += STEP) {
    for (let y = DOME.min[1] + 128; y < DOME.max[1]; y += STEP) {
      if (inSolid([x, y, 192])) continue;
      lights.push(light([x, y, 208], { color: [180, 220, 255], brightness: 200 }));
    }
  }
  for (let x = DOME.min[0] + 448; x < DOME.max[0]; x += 896) {
    for (let y = DOME.min[1] + 448; y < DOME.max[1]; y += 896) {
      lights.push(light([x, y, DOME.max[2] - 96], { color: [120, 188, 255], brightness: 360 }));
    }
  }
  /*
   * Along the high road. The street grid above only lights to z 208, so the deck at 448 was a dark
   * ribbon between lit rooftops -- you could see where it went and not where you were standing.
   */
  for (let x = ewFrom; x < DOME.max[0] - 192; x += 384) {
    lights.push(light([x, streetY, WALK_Z + 96], { color: [205, 232, 255], brightness: 180 }));
  }
  for (let y = DOME.min[1] + 192; y < DOME.max[1] - 192; y += 384) {
    lights.push(light([streetX, y, WALK_Z + 96], { color: [205, 232, 255], brightness: 180 }));
  }
  // and up the stairs, so the climb is not into the dark
  for (let x = DOME.min[0] + 256; x < ewFrom; x += 320) {
    lights.push(light([x, streetY, 240 + ((x - DOME.min[0]) / 896) * WALK_Z], { color: [200, 230, 255], brightness: 120 }));
  }

  // Off the column, not inside it: the beacon now fills the middle of the plaza all the way to the
  // high road, so a lamp at its centre is a lamp in solid.
  lights.push(light([plaza.x + BLOCK / 2, plaza.y + 96, 300], { color: [220, 240, 255], brightness: 360 }));
  lights.push(light([plaza.x + BLOCK / 2, plaza.y + BLOCK - 96, 300], { color: [220, 240, 255], brightness: 360 }));
  for (const g of [...GATES, ...EAST_GATES]) {
    lights.push(light([(g.min[0] + g.max[0]) / 2, (g.min[1] + g.max[1]) / 2, 112], { color: [255, 230, 190], brightness: 160 }));
  }

  /*
   * The east hall. It was carved and never lit, and came out as a black room -- which no check
   * catches, because an unlit map is a perfectly valid one.
   *
   * Lit to match the hand-built hall it mirrors: a cool line down the middle, so neither side's
   * approach feels like the better one.
   */
  for (let y = EAST_HALL.min[1] + 128; y < EAST_HALL.max[1]; y += 256) {
    for (const x of [EAST_HALL.min[0] + 208, EAST_HALL.max[0] - 208]) {
      lights.push(light([x, y, 360], { color: [190, 220, 255], brightness: 230 }));
    }
  }
  // and a lit band down its length, as the hall has
  added.push(box([EAST_HALL.min[0] + 32, EAST_HALL.min[1], 352], [EAST_HALL.min[0] + 48, EAST_HALL.max[1], 384], T.lamp));
  added.push(box([EAST_HALL.max[0] - 48, EAST_HALL.min[1], 352], [EAST_HALL.max[0] - 32, EAST_HALL.max[1], 384], T.lamp));
  void spawns;

  // ---- the undercity --------------------------------------------------------------------------
  /*
   * What is down there: a ladder up every shaft, bins burning at the crossings, and almost no light.
   *
   * The dark is the point. The streets above are lit every 256 units; down here it is one dim lamp a
   * gallery and the fires, so a player coming up a shaft has been somewhere different. It also makes
   * the undercity worth taking as a route -- you are hard to see in it.
   */
  /*
   * STAIRWELLS, NOT LADDERS.
   *
   * This was a func_ladder twice and threw the player off both times. func_ladder works by putting
   * CONTENTS_LADDER in the world and leaving the rest to the engine's movement code -- and TS
   * replaces that movement wholesale for its dives, wall-runs and slow motion. Whether its pmove
   * handles ladder contents the way stock Half-Life does is not something that can be established
   * from outside the mod, and it does not need to be: stairs are ordinary solid brushes, and solid
   * brushes behave the same in every mod there is.
   *
   * Each well is 384 square and drops 512 in two flights of sixteen steps with a landing between,
   * which is 16 of rise and 24 of run a step -- inside the 18 a player walks up without jumping.
   */
  for (const shaft of shafts) {
    const x0 = shaft.min[0];
    const y0 = shaft.min[1];
    const half = WELL_W / 2;
    const mid = SEWER_Z[0] / 2; // the landing, halfway up

    /*
     * THE LANDING STARTS WHERE THE FLIGHT ARRIVES.
     *
     * The same fault the hall stairwells had, and it survived the fix there because these street
     * shafts are built by their own loop. The lower flight ran the whole 384 of the well and the
     * landing was then laid over its last 96 -- but a flight is only at the landing's height at its
     * very END, so across those 96 the landing stood as a 64-tall block on top of the four steps
     * underneath it. You climb a dozen treads and meet a wall.
     *
     * So the flight stops short by the landing's depth and the landing fills what is left, its top
     * flush with the last tread. 96 divides the remaining 288 into the 16 steps evenly, which is
     * what keeps every tread on the grid.
     */
    const land = 96;
    // the lower flight, up the west half, climbing north out of the tunnel
    added.push(...stairs([x0, y0, SEWER_Z[0]], [x0 + half, y0 + WELL_L - land, mid], "+y", T.ledge, { rise: 16 }));
    // the landing they turn on, across the full width
    added.push(box([x0, y0 + WELL_L - land, mid - 16], [x0 + WELL_W, y0 + WELL_L, mid], T.ledge));
    // the upper flight, up the east half, climbing back south to the street
    added.push(...stairs([x0 + half, y0, mid], [x0 + WELL_W, y0 + WELL_L, 0], "-y", T.ledge, { rise: 16 }));

    // a kerb round the hole in the road, so it is seen before it is fallen into
    added.push(box([x0 - 16, y0 - 16, -8], [x0 + WELL_W + 16, y0, 8], T.grate));
    added.push(box([x0 - 16, y0 + WELL_L, -8], [x0 + WELL_W + 16, y0 + WELL_L + 16, 8], T.grate));
    added.push(box([x0 - 16, y0, -8], [x0, y0 + WELL_L, 8], T.grate));

    lights.push(light([x0 + half, y0 + WELL_L / 2, -64], { color: [190, 210, 230], brightness: 140 }));
    lights.push(light([x0 + half, y0 + WELL_L / 2, mid + 72], { color: [170, 190, 210], brightness: 120 }));
  }

  // ---- the halls' own ways down, and the west corridor --------------------------------------------
  /** Two flights with a landing between, filling `room` from zBottom to zTop. */
  const stairwell = (room, zBottom, zTop, tex) => {
    const half = (room.max[0] - room.min[0]) / 2;
    const mid = (zBottom + zTop) / 2;
    const run = room.max[1] - room.min[1];

    /*
     * THE LANDING STARTS WHERE THE FLIGHT ARRIVES, and it did not.
     *
     * The lower flight was run the whole length of the well and the landing then laid over its last
     * 96 -- but a flight only reaches the landing's height at its very END, so for those last 96 the
     * landing stood as a 64-tall block on top of the steps underneath it. One ordinary step, then a
     * wall you cannot walk up. That is the climb this was blocking.
     *
     * So the flight is shortened by the landing's depth and the landing fills what is left, flush
     * with the top tread.
     *
     * The depth is chosen, not fixed: the remaining run has to divide evenly by the number of steps
     * or every tread lands on a fraction, which is what the plan check reports as planes off the
     * grid. It starts at 96 and comes down in eights until it divides.
     */
    const steps = Math.round((mid - zBottom) / 16);
    let land = 96;
    while (land > 16 && (run - land) % steps !== 0) land -= 8;

    added.push(...stairs([room.min[0], room.min[1], zBottom], [room.min[0] + half, room.max[1] - land, mid], "+y", tex, { rise: 16 }));
    added.push(box([room.min[0], room.max[1] - land, mid - 16], [room.max[0], room.max[1], mid], tex));
    added.push(...stairs([room.min[0] + half, room.min[1], mid], [room.max[0], room.max[1], zTop], "-y", tex, { rise: 16 }));
    const cx = (room.min[0] + room.max[0]) / 2;
    const cy = (room.min[1] + room.max[1]) / 2;
    lights.push(light([cx, cy, zTop - 96], { color: [190, 212, 235], brightness: 120 }));
    lights.push(light([cx, cy, mid + 72], { color: [170, 192, 215], brightness: 85 }));
    // a kerb round the opening so the hole in the floor is seen before it is fallen into
    added.push(box([room.min[0] - 16, room.min[1] - 16, zTop - 8], [room.max[0] + 16, room.min[1], zTop + 8], T.grate));
    added.push(box([room.min[0] - 16, room.max[1], zTop - 8], [room.max[0] + 16, room.max[1] + 16, zTop + 8], T.grate));
  };

  // both spawns reach the undercity from their own hall, without crossing the city to do it
  stairwell(WEST_WELL, -512, 0, T.ledge);
  stairwell(EAST_WELL, -512, 0, T.ledge);
  // and the one down to the shanty, from the north end of the undercity's spine
  for (const w of SHANTY_WELLS) stairwell(w, SHANTY_Z[0], SEWER_Z[0], T.ledge);

  // the west hall's climb up to its corridor: one flight, 16 treads of 24
  added.push(
    ...stairs([WEST_RISE.min[0], WEST_RISE.min[1], 0], [WEST_RISE.max[0], WEST_RISE.max[1], 256], "+y", T.street, { rise: 16 }),
  );
  for (let y = WEST_CORR_N.min[1] + 192; y < WEST_CORR_N.max[1]; y += 384) {
    lights.push(light([(WEST_CORR_N.min[0] + WEST_CORR_N.max[0]) / 2, y, 400], { color: [200, 222, 255], brightness: 160 }));
  }
  for (let x = WEST_CORR_E.min[0] + 192; x < WEST_CORR_E.max[0]; x += 384) {
    lights.push(light([x, (WEST_CORR_E.min[1] + WEST_CORR_E.max[1]) / 2, 400], { color: [200, 222, 255], brightness: 160 }));
  }

  // ---- the shanty ----------------------------------------------------------------------------------
  /*
   * Below the undercity: one wide low space with shacks built in it out of whatever the city threw
   * away. It is deliberately NOT tunnels -- the undercity is infrastructure and this is somewhere
   * people live, so it is a floor with things standing on it and lanes between them.
   *
   * The shacks are solid and varied in height so the lanes are not sightlines, and the only light is
   * what is burning.
   */
  /*
   * Shacks, not boxes.
   *
   * Each is run up out of whatever was to hand -- its walls in one salvaged texture, its lean-to in
   * tarp or corrugate, a crate or a drum against it -- and no two the same, because nothing down here
   * was built to a plan. The sewer's own wall texture is deliberately NOT used: that is the city's
   * material and this place was not given any.
   */
  const SHACK = 192;
  const LANE = 192;
  /** Nothing is placed where something already stands: see the fire bins for why that matters. */
  let rockBoxes = null;
  const clearOf = (lo, hi) => {
    /*
     * The ROCK counts too, and it did not before. A fixture outside a tunnel is not overlapping
     * anything we built -- it is simply buried in the wall, which is how six lamps ended up inside
     * the carve's own brushes while this said they were fine.
     *
     * The rock never changes once carved, so its shapes are worked out once; `added` is still read
     * live because it grows as the city is built.
     */
    rockBoxes ??= rockCut.map(shapeOf);
    const hits = (sh) => [0, 1, 2].every((i) => lo[i] < sh.max[i] - 1 && sh.min[i] + 1 < hi[i]);
    return !rockBoxes.some(hits) && !added.some((b) => hits(shapeOf(b)));
  };

  for (let x = SHANTY.min[0] + 160; x < SHANTY.max[0] - SHACK; x += SHACK + LANE) {
    for (let y = SHANTY.min[1] + 160; y < SHANTY.max[1] - SHACK; y += SHACK + LANE) {
      const n = Math.abs(Math.round(Math.sin(x * 0.013 + y * 0.021) * 1000));
      if (n % 5 === 0) continue; // a gap in the row: a lane, or a plot already burnt out
      const high = 96 + (n % 4) * 28;
      const w = SHACK - (n % 3) * 28;
      const lo = [x, y, SHANTY_Z[0]];
      const hi = [x + w, y + w, SHANTY_Z[0] + high + 14];
      if (!clearOf(lo, hi)) continue;

      added.push(box(lo, [x + w, y + w, SHANTY_Z[0] + high], T.scrap[n % T.scrap.length]));
      // the lean-to over it, overhanging and not square to the walls
      const sag = n % 2 ? 10 : 18;
      added.push(box([x - sag, y - 10, SHANTY_Z[0] + high], [x + w + 10, y + w + sag, SHANTY_Z[0] + high + 10], n % 3 ? T.tarp : T.corrugate));
      // a sheet hung down one side as a door
      if (n % 3 === 1) added.push(box([x - 4, y + 32, SHANTY_Z[0] + 8], [x + 2, y + w - 32, SHANTY_Z[0] + high - 16], T.tarp));
      // and something stacked against it
      if (n % 4 === 2) {
        const cx = x + w + 20;
        if (clearOf([cx, y, SHANTY_Z[0]], [cx + 44, y + 44, SHANTY_Z[0] + 80]))
          added.push(box([cx, y, SHANTY_Z[0]], [cx + 44, y + 44, SHANTY_Z[0] + 44], T.scrap[(n + 2) % T.scrap.length]));
      }
      if (n % 4 === 0) {
        const bx = x + w + 56;
        const by = y + w / 2;
        if (bx < SHANTY.max[0] - 48 && clearOf([bx - 18, by - 18, SHANTY_Z[0]], [bx + 18, by + 18, SHANTY_Z[0] + 56])) {
          /*
           * The drum has NO lit texture on it, only a light above it.
           *
           * PILOT_03_LIGHTS is named in the base map's info_texlights, so it does not merely look
           * bright -- every face wearing it EMITS. Capping a shanty drum with it put a glowing white
           * panel in the middle of a slum and lit the wall behind it, which is the "random glowing
           * texture" in there. Down here the only light should be the fire, and the fire is the
           * light entity.
           */
          added.push(box([bx - 18, by - 18, SHANTY_Z[0]], [bx + 18, by + 18, SHANTY_Z[0] + 44], T.bin));
          flame(bx, by, SHANTY_Z[0] + 80, 1.4);
          lights.push(light([bx, by, SHANTY_Z[0] + 80], { color: [255, 146, 56], brightness: 150 }));
        }
      }
    }
  }

  // the barest working light, so the place has a shape without having a colour
  for (let x = SHANTY.min[0] + 320; x < SHANTY.max[0]; x += 704) {
    for (let y = SHANTY.min[1] + 320; y < SHANTY.max[1]; y += 704) {
      lights.push(light([x, y, SHANTY_Z[1] - 48], { color: [138, 155, 172], brightness: 52 }));
    }
  }

  // ---- the south slums -----------------------------------------------------------------------------
  /*
   * NOTHING STANDS IN THE OPEN FLOOR, and that is the whole rule down here.
   *
   * This is the route an engineer flanks by: one door at each spawn, a slum behind each of them and
   * a run joining the two. A clear lane from end to end is worth more than anything standing in it,
   * because somebody is going to move its whole length under fire. And clutter in the middle of a
   * floor reads as crates dumped in a store room whatever is drawn on it -- the same lesson the
   * undercity's trash boxes taught. Pushed into the corners the identical shapes read as the backs
   * of shacks, which is what they are for.
   *
   * So: a handful per room, every one of them leaning on a wall, and their heights chosen to be
   * useful. One to lose somebody behind, one to jump up on, and nothing in between.
   *
   * Built HERE rather than beside the doors because clearOf() reads `added` as it stands, and by
   * now that holds the door frames, the jambs and the lit strips.
   */
  /** A drum with a fire in it, which is most of the light that gets to the floor down here. */
  const slumDrum = (x, y, z) => {
    if (!clearOf([x - 18, y - 18, z], [x + 18, y + 18, z + 56])) return;
    added.push(box([x - 18, y - 18, z], [x + 18, y + 18, z + 44], T.bin));
    flame(x, y, z + 80, 1.4);
    lights.push(light([x, y, z + 80], { color: [255, 146, 56], brightness: 150 }));
  };

  for (const { slum } of SOUTH_WAYS) {
    const x0 = slum.min[0];
    const y0 = slum.min[1];
    const z0 = slum.min[2];
    const x1 = slum.max[0];
    const y1 = slum.max[1];

    /*
     * The south wall is the one with nothing cut through it in either room -- the door is in the
     * north wall and the run leaves through one of the sides -- so it is where the shacks go.
     *
     * Each sits FLUSH with the wall rather than inside it: clearOf() refuses anything that overlaps
     * the rock, and flush is near enough that there is no slot behind it. Their roofs overhang on
     * the open sides only, for the same reason.
     */
    // the south-west corner, tall enough to lose somebody behind
    added.push(box([x0, y0, z0], [x0 + 216, y0 + 216, z0 + 224], T.board[0]));
    added.push(box([x0, y0, z0 + 224], [x0 + 228, y0 + 228, z0 + 234], T.corrugate));
    // the south-east corner, low enough to jump onto and shoot over
    added.push(box([x1 - 184, y0, z0], [x1, y0 + 184, z0 + 88], T.board[1]));
    added.push(box([x1 - 196, y0, z0 + 88], [x1, y0 + 196, z0 + 98], T.tarp));
    // a loading dock along the wall between the two
    added.push(box([x0 + 264, y0, z0], [x1 - 216, y0 + 88, z0 + 48], T.corrugate));
    // and one more against the north wall, in the corner furthest from the door
    added.push(box([x1 - 184, y1 - 184, z0], [x1, y1, z0 + 176], T.board[2]));
    added.push(box([x1 - 196, y1 - 196, z0 + 176], [x1, y1, z0 + 186], T.tarp));

    slumDrum(x0 + 288, y0 + 148, z0);
    slumDrum(x1 - 232, y1 - 256, z0);

    // and the same barest working light the shanty has: a shape without a colour
    for (let x = x0 + 256; x < x1; x += 576) {
      for (let y = y0 + 256; y < y1; y += 576) {
        lights.push(light([x, y, slum.max[2] - 48], { color: [138, 155, 172], brightness: 52 }));
      }
    }
  }

  /*
   * THE NEXUS HAS A VOICE: an ambient_generic standing in the middle of its hall.
   *
   * `message` is the path under sound/ with no "sound/" on the front and the extension kept, and
   * the file has to be a WAV -- GoldSrc loads MP3 for the music player alone and will not play one
   * from an entity in the world. It loops because the WAV carries a "cue " chunk: there is no key
   * on the entity that asks for a loop, so a file without the chunk plays once and stops.
   *
   * health is the volume, 0 to 10, and it is at 10 because anything less was not heard.
   *
   * radius is how far it carries, and it does more for this than the volume does: it sets how
   * slowly the sound falls away, so raising it is what makes something audible from across the
   * city rather than only in the room it stands in. The FGD's presets are 500 small, 1250 medium
   * and 2500 large. At 1250 it was already fading by the far wall of a hall 1568 across. 2500
   * carries it down the steps and out over the north of the city, which is far enough to draw
   * somebody towards the building -- and it still dies out well before the south wall, so the
   * sound stays the Nexus's own rather than something playing everywhere.
   *
   * It is placed HERE, below the Nexus's own section, because clearOf() is declared with the shanty
   * and an entity standing in solid is heard from nowhere at all.
   */
  {
    const at = [CITY_MID_X, (NEXUS_HALL.min[1] + NEXUS_HALL.max[1]) / 2, NEXUS_HALL.min[2] + 64];
    if (clearOf([at[0] - 8, at[1] - 8, at[2] - 8], [at[0] + 8, at[1] + 8, at[2] + 8])) {
      ambients.push({
        classname: "ambient_generic",
        origin: `${at[0]} ${at[1]} ${at[2]}`,
        message: "callhascome.wav",
        health: "10",
        radius: "2500",
        spawnflags: "0",
        preset: "0",
      });
    } else {
      console.log(`  city: WARNING the Nexus sound at ${at} is inside solid -- it would be heard from nowhere`);
    }
  }

  /*
   * The run between the two, which is 3328 long and gets almost nothing.
   *
   * Four service boxes over its whole length, each flush against a side wall and alternating
   * sides, so there is something to break the line down it without ever narrowing the lane below
   * 312. They are METAL, like the passage they stand in: boards and tarpaulin belong to the slums
   * at either end, and a wooden shack in a plated service tunnel reads as something dropped there
   * rather than as part of it.
   */
  {
    const ly0 = SOUTH_LINK.min[1];
    const ly1 = SOUTH_LINK.max[1];
    const lz = SOUTH_LINK.min[2];
    let piece = 0;
    for (let x = SOUTH_LINK.min[0] + 384; x < SOUTH_LINK.max[0] - 384; x += 832) {
      const north = piece % 2 === 0;
      const lo = north ? ly1 - 72 : ly0;
      const hi = north ? ly1 : ly0 + 72;
      // one to vault over, one to lose somebody behind, and nothing in between
      const high = piece % 3 === 0 ? 64 : 168;
      added.push(box([x, lo, lz], [x + 192, hi, lz + high], T.routeWall));
      added.push(box([x - 8, lo, lz + high], [x + 200, hi, lz + high + 10], T.routeFloor));
      piece++;
    }
    for (let x = SOUTH_LINK.min[0] + 800; x < SOUTH_LINK.max[0] - 320; x += 1100) {
      slumDrum(x, ly0 + 56, lz);
    }
    for (let x = SOUTH_LINK.min[0] + 192; x < SOUTH_LINK.max[0]; x += 448) {
      lights.push(light([x, (ly0 + ly1) / 2, SOUTH_LINK.max[2] - 48], { color: [162, 180, 200], brightness: 78 }));
    }
  }

  // ---- catwalks and vents ----------------------------------------------------------------------
  /*
   * A deck down one side of every tunnel, 128 above the floor, with a rail on the open side and a
   * flight up to it at one end -- 128 is seven times what a player steps up, so without the stairs
   * it would be scenery. Ducts run along the ceiling with grilles let into them.
   *
   * It gives the undercity two levels of its own, which is what stops it being a drain pipe you run
   * down: someone on the deck and someone on the floor are in the same tunnel and cannot easily
   * reach each other.
   */
  /** True when a stairwell comes down into this room: then nothing else may be built in it. */
  const hasShaft = (room) =>
    shafts.some((sh) => [0, 1].every((i) => room.min[i] < sh.max[i] && sh.min[i] < room.max[i]));

  for (const room of sewerRooms) {
    const alongX = room.max[0] - room.min[0] > room.max[1] - room.min[1];
    const a = alongX ? 0 : 1;
    const b = alongX ? 1 : 0;
    const from = room.min[a] + 64;
    const to = room.max[a] - 64;
    /*
     * Long enough for a flight at EACH end, or no catwalk at all.
     *
     * The threshold was 512, so anything between 512 and 1024 got a deck with stairs at one end and
     * the tunnel wall at the other -- a catwalk leading to nothing, which is exactly what it looked
     * like. A deck you have to turn round on is not a route and should not be built.
     */
    if (to - from <= 1024) continue;
    /*
     * THE TUNNELS THE STAIRWELLS COME DOWN INTO GET NOTHING ELSE.
     *
     * A tunnel is 224 across and a catwalk takes 128 of it, which leaves less than a well is wide:
     * the two cannot share a tunnel. They did, and the result was a way down buried inside the
     * catwalk's own staircase. The spines give up their catwalks; the galleries, the cross-passages
     * and the treatment hall keep theirs, which is most of them.
     */
    if (hasShaft(room)) continue;

    /** A box given in along/across terms, so one piece of code does both directions. */
    const put = (lo, hi, lo2, hi2, z0, z1, tex) => {
      const min = [0, 0, z0];
      const max = [0, 0, z1];
      min[a] = lo; max[a] = hi;
      min[b] = lo2; max[b] = hi2;
      added.push(box(min, max, tex));
    };

    /*
     * THE DECK STARTS INSIDE THE ROCK, by 8, and both of its edges are measured from the wall.
     *
     * Stand it clear of the wall and that clearance is a SLOT: the deck and both its flights are
     * built from this one pair of numbers, so the gap runs the whole length of the walkway, shows
     * the tunnel floor through it and is wide enough to put a foot in. Stand it exactly AT the wall
     * and its edge is coplanar with the rock's own face, which is the one place two world brushes
     * should not meet. Buried, the edge is never drawn and what stands in the tunnel is still
     * exactly CATWALK_W across.
     */
    const deckFrom = room.min[b] - 8;
    const deckTo = room.min[b] + CATWALK_W;
    const deckStart = from + 288;
    const deckEnd = to - 288;
    put(deckStart, deckEnd, deckFrom, deckTo, CATWALK_Z, CATWALK_Z + 16, T.grate);
    put(deckStart, deckEnd, deckTo - 8, deckTo, CATWALK_Z + 16, CATWALK_Z + 56, T.rail);

    /** A flight between the floor and the deck, climbing toward `side`. */
    const flight = (lo0, hi0, side) => {
      const lo = [0, 0, SEWER_Z[0]];
      const hi = [0, 0, CATWALK_Z + 16];
      lo[a] = lo0; hi[a] = hi0;
      lo[b] = deckFrom; hi[b] = deckTo;
      added.push(...stairs(lo, hi, side, T.grate, { rise: 16 }));
    };
    // up at the near end...
    flight(from, deckStart, alongX ? "+x" : "+y");
    /*
     * ...and DOWN again at the far end, where there was a wall.
     *
     * Without it the deck simply stopped against the end of the tunnel: you walked the length of it
     * and had to turn round and walk back, which is what "stairs that lead into walls" was. A route
     * with one way on and one way off is a route; one with the same way on and off is a shelf.
     */
    flight(deckEnd, to, alongX ? "-x" : "-y");

    // ducts along the ceiling on the other side, with a grille let in every so often
    const ductFrom = room.max[b] - 112;
    put(from, to, ductFrom, ductFrom + 96, SEWER_Z[1] - 56, SEWER_Z[1], T.sewerCeil);
    for (let at = from + 128; at < to - 64; at += 384) {
      put(at, at + 64, ductFrom - 6, ductFrom, SEWER_Z[1] - 48, SEWER_Z[1] - 8, T.grate);
    }
  }

  // ---- the treatment hall ------------------------------------------------------------------------
  /*
   * The water, the thing in it that kills you, and the ledges across.
   *
   * The water is a WORLD brush whose texture begins with "!" -- that is the whole of how GoldSrc is
   * told a brush is liquid, and it is why the name matters more than the picture. It stops 48 short
   * of the lip so there is a rim to see over.
   *
   * What kills is a trigger_hurt filling the same space, not the fall: 192 is survivable, and a pit
   * you can climb out of is scenery rather than a decision.
   */
  /*
   * The water is just water now. No trigger_hurt in it.
   *
   * It was 1000 damage so that falling in was a decision rather than an inconvenience, but a pit
   * that kills on touch in the middle of a route people have to cross is a pit that decides fights
   * by accident. The drop and the climb back out are cost enough.
   */
  added.push(box(PIT.min, [PIT.max[0], PIT.max[1], PIT.max[2] - 48], T.water));

  const midPitX = (PIT.min[0] + PIT.max[0]) / 2;
  const midPitY = (PIT.min[1] + PIT.max[1]) / 2;
  added.push(box([midPitX - 48, PIT.min[1], PIT.max[2] - 16], [midPitX + 48, PIT.max[1], PIT.max[2]], T.ledge));
  added.push(box([PIT.min[0], midPitY - 48, PIT.max[2] - 16], [PIT.max[0], midPitY + 48, PIT.max[2]], T.ledge));
  lights.push(light([midPitX, midPitY, PIT.max[2] + 96], { color: [120, 255, 150], brightness: 160 }));
  for (const corner of [
    [TREAT.min[0] + 96, TREAT.min[1] + 96],
    [TREAT.max[0] - 96, TREAT.min[1] + 96],
    [TREAT.min[0] + 96, TREAT.max[1] - 96],
    [TREAT.max[0] - 96, TREAT.max[1] - 96],
  ]) {
    lights.push(light([corner[0], corner[1], SEWER_Z[1] - 64], { color: [150, 180, 170], brightness: 110 }));
  }

  /** A bin with a fire in it: the drum, the flame standing in it, and the light it throws. */
  const fireBin = (x, y) => {
    added.push(box([x - 20, y - 20, SEWER_Z[0]], [x + 20, y + 20, SEWER_Z[0] + 56], T.bin));
    /*
     * A REAL FLAME, where there was a lit cap standing in for one.
     *
     * The drum was capped with a slab of PILOT_03_LIGHTS, which the base map's info_texlights makes
     * an emitter: a white glowing square on top of a rusty drum, standing in for fire because there
     * was none. With fire.spr in it the cap has no job left and would only show as a hard white disc
     * under the flame, so it goes and the sprite takes its place.
     */
    flame(x, y, SEWER_Z[0] + 92, 1.5);
    lights.push(light([x, y, SEWER_Z[0] + 96], { color: [255, 146, 54], brightness: 185 }));
  };

  /*
   * FIRES AT JUNCTIONS AND DEAD ENDS, not every 384 units.
   *
   * A bin was placed by the yard along every tunnel, which put twenty-four glowing drums down here
   * -- a corridor lined with them is not a slum, it is a runway. A fire is somewhere people gather,
   * so it belongs where tunnels meet or where one stops.
   *
   * Candidates are each room's two ends and the middle of every overlap between two rooms. They are
   * then thinned by distance, so a junction of three tunnels gets ONE fire rather than three, and so
   * does a dead end that two rooms happen to share.
   */
  const FIRE_APART = 420;
  const candidates = [];
  for (const room of sewerRooms) {
    if (room === TREAT || room === PIT) continue;   // its floor is mostly the hole
    const alongX = room.max[0] - room.min[0] > room.max[1] - room.min[1];
    const a2 = alongX ? 0 : 1;
    const b2 = alongX ? 1 : 0;
    // the far side of the tunnel: the near one carries the catwalk deck and its stairs
    const side = room.max[b2] - 68;
    for (const at of [room.min[a2] + 96, room.max[a2] - 96]) {
      const p = [0, 0];
      p[a2] = at;
      p[b2] = side;
      candidates.push(p);
    }
  }
  for (let i = 0; i < sewerRooms.length; i++) {
    for (let j = i + 1; j < sewerRooms.length; j++) {
      const r = sewerRooms[i], q = sewerRooms[j];
      if (r === TREAT || r === PIT || q === TREAT || q === PIT) continue;
      if (![0, 1].every((k) => r.min[k] < q.max[k] && q.min[k] < r.max[k])) continue;
      // the middle of the overlap, which is the junction
      candidates.push([0, 1].map((k) => (Math.max(r.min[k], q.min[k]) + Math.min(r.max[k], q.max[k])) / 2));
    }
  }

  const taken = [];
  for (const c of candidates) {
    if (taken.some((t) => Math.hypot(t[0] - c[0], t[1] - c[1]) < FIRE_APART)) continue;
    /*
     * Not in a staircase, a deck or a wall. A junction's middle is a fine place for a fire until the
     * junction is also where a flight comes down, and then the drum stands in the steps -- which is
     * the "light fixture stuck in the stairs" that has been reported before. The sweep at the end
     * would take its flame and its light away and leave the drum sitting there.
     */
    if (!clearOf([c[0] - 24, c[1] - 24, SEWER_Z[0]], [c[0] + 24, c[1] + 24, SEWER_Z[0] + 64])) continue;
    taken.push(c);
    fireBin(c[0], c[1]);
  }
  console.log(`  city: ${taken.length} fire(s) underground, from ${candidates.length} junction and dead-end candidates`);

  for (const room of sewerRooms) {
    if (room === TREAT || room === PIT) continue;
    const alongX = room.max[0] - room.min[0] > room.max[1] - room.min[1];
    const from = alongX ? room.min[0] : room.min[1];
    const to = alongX ? room.max[0] : room.max[1];
    const across = alongX ? (room.min[1] + room.max[1]) / 2 : (room.min[0] + room.max[0]) / 2;

    /*
     * No trash boxes. They were small cubes of wall texture scattered along the floor and that is
     * exactly what they looked like in game -- "random cubes everywhere" -- because a box with a
     * wall on it is a box. Trash wants a decal or a model, not geometry, and neither is worth
     * putting a player's feet through in a corridor this narrow.
     */

    // one dim lamp between the fires, hung at the ceiling
    for (let at = from + 576; at < to - 128; at += 640) {
      // Clear of the ducts: at -24 from the ceiling the lamp was INSIDE one, which lights
      // nothing and which the plan check reports as an entity in a world brush.
      const p = alongX ? [at, across, SEWER_Z[1] - 80] : [across, at, SEWER_Z[1] - 80];
      // Not inside a duct, a deck or a flight of stairs: a lamp in solid lights nothing at all.
      if (!clearOf([p[0] - 8, p[1] - 8, p[2] - 8], [p[0] + 8, p[1] + 8, p[2] + 8])) continue;
      /*
       * Dimmer than it was. The undercity is meant to be lit BY its fixtures -- the bins and these
       * few lamps -- and not by an ambient wash, so that carrying no light is a real disadvantage
       * and the fires are worth standing near.
       */
      lights.push(light(p, { color: [146, 164, 182], brightness: 48 }));
    }
  }


  /*
   * One func_wall holding every pane. The keys are the hall's own glass, copied: rendermode 2 is
   * "texture" and renderamt 80 is how much of it is there, which is see-through enough to read the
   * sky behind and solid enough to read as glass.
   */
  const glass = {
    classname: "func_wall",
    zhlt_lightflags: "0",
    rendercolor: "0 0 0",
    rendermode: "2",
    renderfx: "0",
    renderamt: "80",
    brushes: panes,
  };

  /*
   * THE LAST SWEEP: anything inside solid is dropped.
   *
   * Fixtures are placed by rules -- every so many units along a tunnel, at the middle of a plaza --
   * and a rule cannot know what was built there afterwards. The result was lamps buried in
   * staircases and ducts, lighting the inside of a brush and showing as a fixture floating with its
   * stand sunk in the floor.
   *
   * Guarding each placement helps and is still done, but it only guards what has ALREADY been built
   * when that line runs. This runs when everything is built, so it catches the rest -- and it is the
   * same test the plan check uses to report them, applied before the map is written instead of
   * after.
   */
  const standsInSolid = (e) => {
    const at = String(e.origin ?? "").trim().split(/\s+/).map(Number);
    if (at.length !== 3 || at.some((n) => !Number.isFinite(n))) return false;
    return !clearOf([at[0] - 4, at[1] - 4, at[2] - 4], [at[0] + 4, at[1] + 4, at[2] + 4]);
  };
  /*
   * NO HEAD LIGHT IS INSIDE ANYTHING, and this is measured rather than looked at.
   *
   * Twice now a strip over a door has been found in game sharing its space with the header or with
   * the leaf itself, and both times it was visible only as a flicker along one edge -- the kind of
   * fault a screenshot catches and a build does not. So the build catches it: every strip is tested
   * against every other world brush, and against the whole column each door sweeps through on its
   * way up, not merely where its leaf is standing.
   */
  const overlaps = (sh, h) => [0, 1, 2].every((i) => h.lo[i] < sh.max[i] - 1 && sh.min[i] + 1 < h.hi[i]);
  const sweeps = doors.flatMap((d) =>
    d.brushes.map((b) => {
      const sh = shapeOf(b);
      return { min: sh.min, max: [sh.max[0], sh.max[1], sh.max[2] + (sh.max[2] - sh.min[2])] };
    }),
  );
  rockBoxes ??= rockCut.map(shapeOf);
  const buried = headLights.filter(
    (h) =>
      added.some((b, i) => i !== h.at && overlaps(shapeOf(b), h)) ||
      // the rock as well, which is where the gates' pair was hiding: outside everything we built,
      // and simply inside the wall the tunnel is cut through
      rockBoxes.some((sh) => overlaps(sh, h)) ||
      sweeps.some((sw) => overlaps(sw, h)),
  );
  if (buried.length) {
    for (const h of buried) console.log(`  city: WARNING door head light at ${h.lo} is inside other solid`);
  } else {
    console.log(`  city: ${headLights.length} door head light(s), none inside a brush or in a door's path`);
  }

  const keptFlames = flames.filter((e) => !standsInSolid(e));
  if (keptFlames.length !== flames.length) {
    console.log(`  city: WARNING ${flames.length - keptFlames.length} flame(s) are inside solid -- a drum with no fire in it`);
  }
  const placed = [...lights, ...flames].filter((e) => !standsInSolid(e));
  const dropped = lights.length + flames.length - placed.length;
  if (dropped) console.log(`  city: dropped ${dropped} fixture(s) that ended up inside a wall`);

  /*
   * The sounds go through the same sweep. A sound entity inside solid is not a cosmetic fault: it
   * is silent everywhere, and nothing in the game says so -- which is exactly the kind of thing
   * this build reports rather than leaves to be noticed in play.
   */
  const heard = ambients.filter((e) => !standsInSolid(e));
  if (heard.length !== ambients.length) {
    console.log(`  city: WARNING ${ambients.length - heard.length} sound(s) are inside solid -- audible from nowhere`);
  } else if (heard.length) {
    console.log(`  city: ${heard.length} ambient sound(s), none inside a brush`);
  }

  return {
    worldspawn: {
      ...base.worldspawn,
      // skyname is what picks the six pictures in gfx/env: see sky.mjs.
      skyname: SKY_NAME,
      /*
       * HOW FAR THE GAME DRAWS, and the reason the far side of the city was not there.
       *
       * MaxRange is worldspawn's far clip -- the engine draws nothing beyond it. The hand-built
       * hall set 4096, which was ample for a room 2176 long. The city is 5344 across, so standing
       * in one hall the far end simply was not drawn: not a detail setting, not the player's
       * hardware, the map telling the engine to stop.
       *
       * 8192 covers the whole map with room over. It costs drawing: everything inside it is
       * considered, which is what hlvis's work is for -- the buildings block sight of each other,
       * so a street only ever draws its own stretch of city.
       */
      MaxRange: "8192",
    },
    brushes: [...kept, ...rockCut, ...added],
    entities: [...base.entities, glass, ...doors, ...placed, ...heard],
  };
}
