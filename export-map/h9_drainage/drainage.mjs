// DRAINAGE: the city's storm-drain works, sunk in its streets: the test ground for the new modes. One place,
// three maps:
//
//   h9_up_drainage   Capture the Uplink: four control zones (tsm_cap_1..4) and the uplink's point (tsm_uplink);
//                    MSR on the north basin's platform, the Insurgents on the south's
//   h9_ws_drainage   Wave Survival: the survivors hold the pumping station, the mutants come from the basins and
//                    the far ends of the service galleries
//   h9_mw_drainage   Mech Warrior: the sides start as on h9_up_drainage, with no zones
//
// THE PLACE. A canal 704 deep runs north to south under the city, its concrete walls standing straight up to the
// street, where a parapet and a chain-link fence run along the edge, sodium lamps lean out over the drop and the
// city's blocks stand back from it. At each end the canal opens into a BASIN: a team's platform against the end
// wall under the great outfall pipe, whose water falls into the channel's head, and stairs up the side walls to
// a catwalk across the culvert's mouth. Between the basins and the middle the canal runs through two BOX
// CULVERTS -- runoff in a channel down the middle, gravel banks either side, a concrete ceiling slotted to let
// the light down -- with an open UPPER DECK over each between the canal's walls. In the middle stands the
// PUMPING STATION: a hall of pumps with a catwalk round it at the decks' height and doors onto both decks.
// Inside the canal's walls run the SERVICE GALLERIES, from basin to basin, with doors into the culverts and the
// hall, and off them the FILTER ROOM (west) and the GENERATOR ROOM (east). High over each basin the city's
// ELEVATED LINE crosses on a steel bridge from a tunnel under the street to another; every two minutes or so a
// train comes through, its rumble loud and the ground shaking under it all round the basin.
//
// THE LOOK is the h9 maps' own wherever people built (the station, the galleries, the decks and catwalks: riveted
// plate, black deck plate, grating, the neuropolis pipes and rails), stained concrete where the water runs, under
// the works' own sky of lit smog (sky.mjs). It is night: the sky gives little light, and the lamps give the rest,
// sodium in the open and cold light inside, their lit faces shining as texture lights.
//
// HOW IT IS BUILT. Every open space and room is a space for SMAK's carvePlan, so what is not a space is rock and
// the map cannot leak; the street over everything is one more, open to the sky. Everything that stands in the
// spaces -- stairs, catwalks, pumps, pipes, crates, the platforms, the city's blocks -- is func_detail, so it
// neither splits the world nor blocks vis. The fences and the grate over the channel's head are see-through
// func_walls; the falling water is a func_illusionary. Each train is a func_train, its lit windows a second one
// drawn additive that runs the same path beside it.
//
//   node drainage.mjs                      write out\h9_<mode>_drainage.map for each of the three, their spawn
//                                          configs and .res lists, check them, walk them, and draw the plan
//   node drainage.mjs --compile [--xash]   and compile them (draft vis, bounced light)
//   node drainage.mjs --views              and draw the compiled maps from inside, sky and all
//   node drainage.mjs deploy               copy the .bsp files and their .res lists to ts\maps and the spawn
//                                          configs to AMXX's configs (the sky goes with `node sky.mjs deploy`)
//
// DRAIN_ONLY=up (or ws, mw) does one map alone; DRAIN_THREADS sets the compilers' threads.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GAME_DIR, K, M, WADS } from "../lib.mjs";
import { SKY_FOLDER, SKY_NAME } from "./sky.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const COMPILERS = "D:/Downloads/TSM/export-map/sdhlt-goldsrc-net/tools";

// ---- the look ------------------------------------------------------------------------------------
const T = {
  // where the water runs: poured concrete, gravel, the runoff
  canalWall: "crete36",
  culvertWall: { name: "WETCRETE", scale: [2, 2] }, // its waterline along the foot of the wall
  culvertCeil: "CRETE4_FLR01",
  bank: "OUT_GRAVEL",
  channelBed: "mtl8_base_dirt1",
  water: "!WATERGREEN",
  fall: "+0WATERFALL1",
  basinFloor: "CRETE4_FLR02",
  barrier: "CRETE3_WALL01",
  // where people built: the h9 maps' dark metal
  wall: "STEC_PANEL3",
  deck: "CD_METALF_DARK",
  ceiling: "DRKMTLT_WALL010",
  trim: "DRKMTLT_WALL010",
  dark: "DRKMTLT_BORD10",
  grate: "matgrate_grey1",
  seeGrate: "{GRATE2",
  rail: "MOD_LABPIPE1A",
  pipe: "mod_metal1a",
  steps: "CD_METALF_DARK",
  hazard: "STRIPES1",
  doorTrim: "cd_doortrim",
  crate: ["CRATE09", "XCRATE1A", "BCRATE04", "CRATE13"],
  // the lamps' lit faces
  sodium: "~SPOTYELLOW",
  cold: "~LIGHT5A",
  red: "~LIGHT3A",
  // the street and the city's blocks
  street: "masphalt",
  fence: "{CHAINLINK",
  facade: ["windows001", "win3", "window006", "win2"],
  sky: "sky",
  // the elevated line: its bed (the ties between the rails, turned to run along the line) and the trains, Black
  // Mesa's own subway steel with lit panes in its windows
  trackBed: { name: "crtrack01", scale: [1.25, 1.25], rotation: 90 },
  curtain: "BLACK",
  bogie: "TRAIN_UND2",
  pane: "LITEPANEL1",
  headlamp: "lab_lite1nf",
  taillamp: "FLATBED_TLITE1",
};

// ---- the plan --------------------------------------------------------------------------------------
const X_CANAL = 256; // the canal's walls between the station and the basins: -X_CANAL..X_CANAL
const X_TRENCH = 96; // the runoff's channel, down the middle the whole length
const TRENCH = -16; // its bed: one step down from the banks
const WATER = 12; // how deep the runoff stands in it
const X_HALL = 320;
const Y_HALL = 320; // the pumping station's hall: -Y_HALL..Y_HALL
const HALL_CEIL = 448;
const Y_CULVERT = 960; // a culvert runs from the hall to its basin, Y_HALL..Y_CULVERT
const CULVERT_CEIL = 256;
const DECK = 288; // the upper decks over the culverts, and every catwalk, at this height
const Y_DECK = Y_HALL + 32; // a deck starts at the station's face
const MID = (Y_HALL + Y_CULVERT) / 2; // a culvert's middle
const SLOTS = [400, 528, 656, 784]; // the culvert's ceiling slots, each 24 across: too narrow to fall through
const X_BASIN = 640;
const Y_EDGE = 1600; // the basins run Y_CULVERT..Y_EDGE
const PLATFORM = 96; // a team's platform against its basin's end wall
const Y_PLATFORM = Y_EDGE - 160;
const TOP = 704; // the street: where the canal's walls end
const SKY_Z = 1600;
const X_GALLERY = [448, 576]; // a service gallery runs between these, either side
const Y_GALLERY = 896;
const GALLERY_CEIL = 160;
const ROOM = { x: [608, 896], y: 192, ceiling: 224 }; // the filter and generator rooms
const CITY = { x: 1216, y: 1920 }; // the street's reach
const OUTFALL = { z: 312, r: 120 }; // the outfall pipe's middle and radius
// the elevated line over each basin: the middle of its bed across the basin, the bed's top (the rails' foot,
// above the pipes along the side walls), half the bed's width, and its tunnels, out to x ±TRACK.tunnel under the
// street with their ceiling TRACK.roof, 16 under the street. TRACK.curtain into each tunnel from the basin's wall
// a black curtain closes it off, and a waiting train parks TRACK.park in, wholly behind it.
const TRACK = { y: 1280, z: 528, half: 80, tunnel: 2048, roof: 688, curtain: 192, park: 256 };

/** A rectangle in plan, from any two corners. */
const rect = (x0, y0, x1, y1) => {
  const [a, b] = [Math.min(x0, x1), Math.max(x0, x1)];
  const [c, d] = [Math.min(y0, y1), Math.max(y0, y1)];
  return [[a, c], [b, c], [b, d], [a, d]];
};
/** An outline turned half round about the middle: the north half's twin in the south. */
const half = (outline) => outline.map(([x, y]) => [-x, -y]);
const metalRoom = { floor: T.deck, wall: T.wall, ceiling: T.ceiling };

/** Every space of the works: carvePlan's input. */
function spaces() {
  const list = [];
  /** A space drawn for the north, and its twin turned into the south. */
  const twins = (name, outline, rest) => {
    list.push({ name: `north ${name}`, outline, ...rest });
    list.push({ name: `south ${name}`, outline: half(outline), ...rest });
  };

  // the basins, open above to the street and the sky
  twins("basin", rect(-X_BASIN, Y_CULVERT, X_BASIN, Y_EDGE), {
    floor: 0,
    ceiling: TOP,
    texture: { floor: T.basinFloor, wall: T.canalWall, ceiling: T.canalWall },
  });
  // the elevated line's tunnels, out of the basin's side walls under the street, as wide as its bed
  for (const s of [-1, 1])
    twins(`line tunnel ${s < 0 ? "west" : "east"}`, rect(s * X_BASIN, TRACK.y - TRACK.half, s * TRACK.tunnel, TRACK.y + TRACK.half), {
      floor: TRACK.z,
      ceiling: TRACK.roof,
      texture: { floor: T.trackBed, wall: T.canalWall, ceiling: T.canalWall },
    });
  // the runoff's channel, the whole length: through the basins, under the culverts, through the hall
  list.push({
    name: "channel",
    outline: rect(-X_TRENCH, -Y_EDGE, X_TRENCH, Y_EDGE),
    floor: TRENCH,
    ceiling: 0,
    texture: { floor: T.channelBed, wall: T.canalWall, ceiling: T.canalWall },
  });
  // the culverts, and the slots in their ceilings up to the decks
  twins("culvert", rect(-X_CANAL, Y_HALL, X_CANAL, Y_CULVERT), {
    floor: 0,
    ceiling: CULVERT_CEIL,
    texture: { floor: T.bank, wall: T.culvertWall, ceiling: T.culvertCeil },
  });
  for (const y of SLOTS)
    twins(`slot ${y}`, rect(-X_CANAL + 32, y, X_CANAL - 32, y + 24), { floor: CULVERT_CEIL, ceiling: DECK, texture: T.culvertCeil });
  // the decks over the culverts, between the canal's walls
  twins("deck", rect(-X_CANAL, Y_DECK, X_CANAL, Y_CULVERT), {
    floor: DECK,
    ceiling: TOP,
    texture: { floor: T.deck, wall: T.canalWall, ceiling: T.canalWall },
  });

  // the pumping station's hall, and its doors onto the decks at the catwalk's height
  list.push({ name: "hall", outline: rect(-X_HALL, -Y_HALL, X_HALL, Y_HALL), floor: 0, ceiling: HALL_CEIL, texture: metalRoom });
  twins("hall door", rect(-64, Y_HALL, 64, Y_DECK), { floor: DECK, ceiling: DECK + 112, texture: metalRoom });

  // the service galleries, and their doors
  for (const s of [-1, 1]) {
    const side = s < 0 ? "west" : "east";
    const gx = [s * X_GALLERY[0], s * X_GALLERY[1]];
    list.push({ name: `${side} gallery`, outline: rect(gx[0], -Y_GALLERY, gx[1], Y_GALLERY), floor: 0, ceiling: GALLERY_CEIL, texture: metalRoom });
    // into the basins, at both ends
    list.push({ name: `${side} gallery north door`, outline: rect(gx[0], Y_GALLERY, gx[1], Y_CULVERT), floor: 0, ceiling: 128, texture: metalRoom });
    list.push({ name: `${side} gallery south door`, outline: rect(gx[0], -Y_GALLERY, gx[1], -Y_CULVERT), floor: 0, ceiling: 128, texture: metalRoom });
    // into the culverts: short tunnels through the canal's wall at each culvert's middle
    for (const y of [MID, -MID])
      list.push({ name: `${side} culvert door ${y}`, outline: rect(s * X_CANAL, y - 56, s * X_GALLERY[0], y + 56), floor: 0, ceiling: 112, texture: metalRoom });
    // into the hall: the west door south of the middle, the east door north of it, clear of the hall's stairs
    const y0 = s < 0 ? -192 : 64;
    list.push({ name: `${side} hall door`, outline: rect(s * X_HALL, y0, s * X_GALLERY[0], y0 + 128), floor: 0, ceiling: 128, texture: metalRoom });
    // the room off its middle, by two doors: the filter room (west), the generator room (east)
    const room = s < 0 ? "filter room" : "generator room";
    list.push({
      name: room,
      outline: rect(s * ROOM.x[0], -ROOM.y, s * ROOM.x[1], ROOM.y),
      floor: 0,
      ceiling: ROOM.ceiling,
      texture: s < 0 ? { floor: "CRETE4_FLR01", wall: T.wall, ceiling: T.ceiling } : metalRoom,
    });
    for (const y of [-160, 64])
      list.push({ name: `${room} door ${y}`, outline: rect(s * X_GALLERY[1], y, s * ROOM.x[0], y + 96), floor: 0, ceiling: 128, texture: metalRoom });
  }

  // the street over all of it, open to the sky, its far edge a curb with the sky beyond
  list.push({
    name: "street",
    outline: rect(-CITY.x, -CITY.y, CITY.x, CITY.y),
    floor: TOP,
    ceiling: SKY_Z,
    horizon: 32,
    texture: { floor: T.street, wall: T.canalWall, ceiling: T.sky },
  });
  return list;
}

// ---- what stands in the spaces ----------------------------------------------------------------------
const pick = (list, n) => list[((n % list.length) + list.length) % list.length];
const turnedHalf = (brushes) => M.turned(brushes, 180);
const turnedPoint = ([x, y, z]) => [-x, -y, z];

/** A stack of crates, one to three high, each a 48 or 64 cube a little off the one below. */
function crates(x, y, n, z = 0) {
  const out = [];
  let at = z;
  for (let k = 0; k < 1 + (n % 3); k++) {
    const size = (n + k) % 2 ? 48 : 64;
    const d = k ? ((n * 13 + k * 7) % 12) - 6 : 0;
    out.push(M.box([x + d, y + d, at], [x + d + size, y + d + size, at + size], pick(T.crate, n + k)));
    at += size;
  }
  return out;
}

/** An open railing along a line of points (each stretch along x or y) at floor height `z`: a top rail, a middle
 *  rail and a post every 64 or so, all thin, so the catwalks are seen through. */
function rail(points, z) {
  const out = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const [a, b] = [points[i], points[i + 1]];
    const along = a[0] === b[0] ? 1 : 0;
    const [lo, hi] = [Math.min(a[along], b[along]), Math.max(a[along], b[along])];
    const bar = (from, to, z0, z1) => {
      const min = [0, 0, z0];
      const max = [0, 0, z1];
      min[along] = from;
      max[along] = to;
      min[1 - along] = a[1 - along] - 2;
      max[1 - along] = a[1 - along] + 2;
      return M.box(min, max, T.rail);
    };
    out.push(bar(lo, hi, z + 36, z + 40), bar(lo, hi, z + 18, z + 21));
    const posts = Math.max(1, Math.round((hi - lo) / 64));
    for (let k = 0; k <= posts; k++) {
      const p = Math.round(lo + ((hi - lo) * k) / posts);
      out.push(bar(Math.max(lo, p - 2), Math.min(hi, p + 2), z, z + 36));
    }
  }
  return out;
}

/** A concrete barrier, waist high, 128 long along x or along y. */
const barrier = (x, y, alongX, z = 0) =>
  alongX ? [M.box([x, y, z], [x + 128, y + 24, z + 40], T.barrier)] : [M.box([x, y, z], [x + 24, y + 128, z + 40], T.barrier)];

/** A lamp's fitting: a plain dark box whose face toward `face` (top, bottom, north, south, east, west) is lit. */
const fitting = (min, max, face, lit) => M.box(min, max, { sides: T.pipe, top: T.pipe, bottom: T.pipe, [face]: lit });

/** The lamps' lit faces as texture lights, each its colour and brightness: an info_texlights in the map, which
 *  hlrad reads from there. Nothing else in the map wears these three. */
const LAMP_FACES = { [T.sodium]: [255, 160, 80, 3000], [T.cold]: [170, 200, 255, 1000], [T.red]: [255, 70, 50, 400] };
/** The light beside each lamp, as a share of its brightness: the lit face lights what it faces, and the light
 *  beside it rounds the rest out. The sodium lamps, out in the night, give the less. */
const FILL = { sodium: 0.6, cold: 0.8 };

/** A sign plate: the picture `name` (`size` its texels) whole on the face toward `face`, dark metal elsewhere. */
const sign = (name, size, min, max, face) => M.box(min, max, M.fitted(name, size, min, max, { whole: true, readable: true, faces: [face], rest: T.trim }));

/** One basin's furniture, built for the north and turned for the south. */
function basin() {
  const detail = [];
  const lights = [];
  const walls = []; // see-through
  const falls = [];
  // the platform, in two halves either side of the channel's head; its front edge in hazard stripes
  for (const [x0, x1] of [[-X_BASIN, -X_TRENCH], [X_TRENCH, X_BASIN]])
    detail.push(M.box([x0, Y_PLATFORM, 0], [x1, Y_EDGE, PLATFORM], { top: T.deck, south: T.hazard, sides: T.trim, bottom: T.trim }));
  // a grate across the channel's head between them, the outfall's water falling through it
  walls.push(M.box([-X_TRENCH, Y_PLATFORM, PLATFORM - 4], [X_TRENCH, Y_EDGE, PLATFORM], T.seeGrate));
  detail.push(M.box([-X_TRENCH, Y_PLATFORM - 8, PLATFORM - 16], [X_TRENCH, Y_PLATFORM, PLATFORM], T.trim));
  // stairs down the platform's front, one each side of the channel
  for (const x0 of [-448, 320])
    detail.push(...M.stairs([x0, Y_PLATFORM - 96, 0], [x0 + 128, Y_PLATFORM, PLATFORM], "+y", T.steps, { tread: 16, ramp: "CLIP" }));
  for (const [x0, x1] of [[-X_BASIN + 80, -448], [-320, 320], [448, X_BASIN - 80]]) detail.push(...rail([[x0, Y_PLATFORM + 4], [x1, Y_PLATFORM + 4]], PLATFORM));

  // up each side wall from the platform, and on along the wall to the catwalk across the culvert's mouth
  for (const s of [-1, 1]) {
    const [x0, x1] = s < 0 ? [-X_BASIN, -X_BASIN + 80] : [X_BASIN - 80, X_BASIN];
    detail.push(M.box([x0, 1248, 0], [x1, Y_PLATFORM, PLATFORM], T.trim));
    detail.push(...M.stairs([x0, 1248, PLATFORM], [x1, Y_PLATFORM, DECK], "-y", T.steps, { tread: 16, ramp: "CLIP" }));
    detail.push(M.box([x0, Y_CULVERT + 96, DECK - 16], [x1, 1248, DECK], T.grate));
    const inner = s < 0 ? x1 - 2 : x0 + 2;
    detail.push(...rail([[inner, Y_CULVERT + 96], [inner, 1248]], DECK));
  }
  // the catwalk across the culvert's mouth, at the deck's height: the deck runs on from it
  detail.push(M.box([-X_BASIN, Y_CULVERT, DECK - 16], [X_BASIN, Y_CULVERT + 96, DECK], T.grate));
  detail.push(...rail([[-X_BASIN + 80, Y_CULVERT + 94], [X_BASIN - 80, Y_CULVERT + 94]], DECK));
  for (const x of [-608, -352, 336, 592]) detail.push(M.box([x, Y_CULVERT, DECK - 40], [x + 16, Y_CULVERT + 88, DECK - 16], T.trim));

  // the culvert's mouth: a concrete pier either side, the full height of the wall, and the sluice gate's
  // guides and its raised edge inside it
  for (const s of [-1, 1]) {
    const [x0, x1] = s < 0 ? [-X_CANAL - 48, -X_CANAL] : [X_CANAL, X_CANAL + 48];
    detail.push(M.box([x0, Y_CULVERT, 0], [x1, Y_CULVERT + 32, TOP], T.canalWall));
    const [g0, g1] = s < 0 ? [-X_CANAL, -X_CANAL + 16] : [X_CANAL - 16, X_CANAL];
    detail.push(M.box([g0, Y_CULVERT - 16, 0], [g1, Y_CULVERT, CULVERT_CEIL], T.trim));
  }
  detail.push(M.box([-X_CANAL, Y_CULVERT - 16, CULVERT_CEIL - 24], [X_CANAL, Y_CULVERT, CULVERT_CEIL], T.trim));

  // the outfall over the channel's head: a great pipe out of the end wall, its collar, a grate over its mouth,
  // and its water falling into the channel
  detail.push(M.cylinder("y", [0, OUTFALL.z], OUTFALL.r, Y_EDGE - 64, Y_EDGE, T.trim, { sides: 16, snap: 1 }));
  detail.push(M.cylinder("y", [0, OUTFALL.z], OUTFALL.r + 16, Y_EDGE - 24, Y_EDGE, T.dark, { sides: 16, snap: 1 }));
  detail.push(M.cylinder("y", [0, OUTFALL.z], OUTFALL.r - 16, Y_EDGE - 68, Y_EDGE - 64, T.grate, { sides: 16, snap: 1 }));
  falls.push(M.box([-72, Y_EDGE - 74, TRENCH + WATER], [72, Y_EDGE - 70, OUTFALL.z - OUTFALL.r + 8], T.fall));
  // pilasters on the end wall, standing on the platform
  for (const x of [-456, -232, 184, 408]) detail.push(M.box([x, Y_EDGE - 24, PLATFORM], [x + 48, Y_EDGE, TOP], T.canalWall));

  // the elevated line's bridge, wall to wall over the basin: its bed between two deep plate girders that stand a
  // little proud of it, and under them a steel bent either side of the channel, standing on the basin's floor
  // clear of the platform's stairs (the rails, and the trains, are line()'s)
  const [yS, yN] = [TRACK.y - TRACK.half, TRACK.y + TRACK.half];
  detail.push(M.box([-X_BASIN, yS, TRACK.z - 16], [X_BASIN, yN, TRACK.z], { top: T.trackBed, sides: T.trim, bottom: T.trim }));
  for (const [y0, y1] of [[yS - 16, yS], [yN, yN + 16]]) detail.push(M.box([-X_BASIN, y0, TRACK.z - 32], [X_BASIN, y1, TRACK.z + 16], T.trim));
  for (const x of [-268, 244]) {
    for (const [y0, y1] of [[yS - 16, yS + 8], [yN - 8, yN + 16]]) detail.push(M.box([x, y0, 0], [x + 24, y1, TRACK.z - 56], T.trim));
    detail.push(M.box([x, yS - 16, TRACK.z - 56], [x + 24, yN + 16, TRACK.z - 32], T.trim));
    detail.push(M.box([x + 4, yS + 8, 200], [x + 20, yN - 8, 216], T.trim));
  }
  // pipes along its side walls over the catwalks, passing under the bridge
  for (const s of [-1, 1])
    for (const [z, r] of [[448, 14], [480, 10]])
      detail.push(M.cylinder("y", [s * (X_BASIN - 20), z], r, Y_CULVERT + 32, Y_EDGE, T.pipe, { sides: 8, snap: 1 }));

  // crates against the west wall; the middle of the floor is left open, from the platform's stairs to the
  // culvert's mouth
  detail.push(...crates(-560, 1104, 1), ...crates(-544, 1376, 3));

  // the signs over the galleries' doors
  for (const s of [-1, 1]) {
    const x0 = s < 0 ? -560 : 464;
    detail.push(sign("C2A5W_SIGN", [96, 64], [x0, Y_CULVERT, 140], [x0 + 96, Y_CULVERT + 4, 204], "north"));
  }

  // the light: sodium floods on the side walls, a cold lamp under the catwalk at the mouth, the outfall's red
  for (const s of [-1, 1])
    for (const y of [1152, 1472]) {
      const x1 = s * X_BASIN;
      detail.push(fitting([Math.min(x1, x1 - s * 16), y - 24, 380], [Math.max(x1, x1 - s * 16), y + 24, 404], "bottom", T.sodium));
      lights.push(M.light([s * (X_BASIN - 40), y, 372], { color: [255, 150, 70], brightness: 230 * FILL.sodium }));
    }
  detail.push(fitting([-32, Y_CULVERT + 8, DECK - 24], [32, Y_CULVERT + 24, DECK - 16], "bottom", T.cold));
  lights.push(M.light([0, Y_CULVERT + 48, DECK - 48], { color: [170, 200, 255], brightness: 150 * FILL.cold }));
  detail.push(fitting([-16, Y_EDGE - 8, 456], [16, Y_EDGE, 472], "south", T.red));
  lights.push(M.light([0, Y_EDGE - 48, 456], { color: [255, 70, 50], brightness: 80 }));
  lights.push(M.light([0, Y_EDGE - 120, 120], { color: [120, 255, 160], brightness: 70 }));
  return { detail, lights, walls, falls };
}

// ---- the elevated line -------------------------------------------------------------------------------
/** The line's rails, over the bridge and through both its tunnels; the black curtain that closes each tunnel
 *  TRACK.curtain in from the basin, so the tunnel reads as going dark and a train waiting behind it is never
 *  seen (a train runs through it, out of the dark); and a red lamp on each tunnel's wall just before its curtain.
 *  Built for the north basin and turned for the south. */
function line() {
  const detail = [];
  const lights = [];
  for (const y of [TRACK.y - 24, TRACK.y + 24]) detail.push(M.box([-TRACK.tunnel, y - 2, TRACK.z], [TRACK.tunnel, y + 2, TRACK.z + 8], T.pipe));
  for (const s of [-1, 1]) {
    const [c0, c1] = [s * (X_BASIN + TRACK.curtain), s * (X_BASIN + TRACK.curtain + 8)];
    detail.push(M.box([Math.min(c0, c1), TRACK.y - TRACK.half, TRACK.z], [Math.max(c0, c1), TRACK.y + TRACK.half, TRACK.roof], T.curtain));
    const [l0, l1] = [s * (X_BASIN + TRACK.curtain - 32), s * (X_BASIN + TRACK.curtain - 16)];
    detail.push(fitting([Math.min(l0, l1), TRACK.y + TRACK.half - 8, TRACK.z + 92], [Math.max(l0, l1), TRACK.y + TRACK.half, TRACK.z + 108], "south", T.red));
    lights.push(M.light([s * (X_BASIN + TRACK.curtain - 24), TRACK.y + 40, TRACK.z + 100], { color: [255, 60, 40], brightness: 40 }));
  }
  return { detail, lights };
}

/**
 * A train of three cars, built standing on the north bridge with its middle over the channel, where it takes its
 * light. Each car is Black Mesa's subway steel: down each side a door, two window sections and a door, each
 * picture fitted whole to its own panel; its frame and two bogies under it, a steel roof and the roof's spine; a
 * gangway between each two cars, and the cab's front on both ends of the train. `glow` is apart from the rest, to
 * be drawn additive so it shines in the dark: a lit pane in every window frame, the headlamp of the west cab,
 * which leads over the north basin, and the red tail lamps of the east one.
 */
function train() {
  const body = [];
  const glow = [];
  const K = 0.75; // the subway pictures' scale: their 128 texels make a body 96 tall
  const [DOOR, BAY, GAP, W] = [80 * K, 144 * K, 24, 56]; // a door's width, a window section's, the gangway, half the width
  const CAR = 2 * DOOR + 2 * BAY;
  const [y, z0] = [TRACK.y, TRACK.z + 8]; // the line's middle, the rails' top
  const [zb, zt] = [z0 + 32, z0 + 32 + 128 * K]; // the body's foot and top
  const cars = [0, 1, 2].map((k) => -(3 * CAR + 2 * GAP) / 2 + k * (CAR + GAP));
  /** A thin panel with a picture fitted whole on its face toward `face`. */
  const panel = (min, max, name, size, face) => M.box(min, max, M.fitted(name, size, min, max, { whole: true, readable: true, faces: [face], rest: T.trim }));
  /** The lit panes in a window section from `x0` to `x1`, both sides: inside the picture's two frames, texels
   *  u0..u1 across it and v0..v1 down it, to the nearest unit. A picture read from the north runs east to west. */
  const panes = (x0, x1) =>
    [[20, 75], [83, 137]].flatMap(([u0, u1]) => {
      const [lo, hi] = [Math.round(zt - 81 * K), Math.round(zt - 30 * K)];
      const north = [Math.round(x1 - u1 * K), Math.round(x1 - u0 * K)];
      const south = [Math.round(x0 + u0 * K), Math.round(x0 + u1 * K)];
      return [M.box([north[0], y + W, lo], [north[1], y + W + 1, hi], T.pane), M.box([south[0], y - W - 1, lo], [south[1], y - W, hi], T.pane)];
    });
  for (const x0 of cars) {
    const x1 = x0 + CAR;
    for (const b of [x0 + 32, x1 - 96]) body.push(M.box([b, y - 40, z0], [b + 64, y + 40, z0 + 24], T.bogie));
    body.push(M.box([x0, y - W, z0 + 24], [x1, y + W, zb], T.dark));
    body.push(M.box([x0, y - W + 1, zb], [x1, y + W - 1, zt], T.trim));
    body.push(M.box([x0 + 4, y - W + 6, zt], [x1 - 4, y + W - 6, zt + 12], T.pipe));
    body.push(M.box([x0 + 48, y - 20, zt + 12], [x1 - 48, y + 20, zt + 16], T.pipe));
    let at = x0;
    for (const [name, size, width] of [["SUBWAY_DOOR", [80, 128], DOOR], ["SUBWAY_OUTSIDE", [144, 128], BAY], ["SUBWAY_OUTSIDE", [144, 128], BAY], ["SUBWAY_DOOR", [80, 128], DOOR]]) {
      body.push(panel([at, y + W - 1, zb], [at + width, y + W, zt], name, size, "north"));
      body.push(panel([at, y - W, zb], [at + width, y - W + 1, zt], name, size, "south"));
      if (name === "SUBWAY_OUTSIDE") glow.push(...panes(at, at + width));
      at += width;
    }
  }
  for (const x0 of cars.slice(1)) body.push(M.box([x0 - GAP, y - 40, z0 + 28], [x0, y + 40, zt - 8], T.dark));
  // the cab fronts, the picture 160 by 144: its headlamp at texel (80, 113), its red lamps at (46, 124) and (113, 124)
  const [west, east] = [cars[0], cars[2] + CAR];
  body.push(panel([west - 1, y - W, zb], [west, y + W, zt], "SUBWAY_OUTEND", [160, 144], "west"));
  body.push(panel([east, y - W, zb], [east + 1, y + W, zt], "SUBWAY_OUTEND", [160, 144], "east"));
  const down = (v) => Math.round(zt - (v * (zt - zb)) / 144);
  glow.push(M.box([west - 2, y - 7, down(122)], [west - 1, y + 7, down(104)], T.headlamp));
  for (const u of [46, 113]) {
    const at = Math.round(y - W + (u * 2 * W) / 160);
    glow.push(M.box([east + 1, at - 4, down(130)], [east + 2, at + 4, down(118)], T.taillamp));
  }
  return { body, glow };
}

/** The box round some brushes: [min, max]. */
function boundsOf(brushes) {
  const points = brushes.flatMap((b) => M.shapeOf(b).faces.flatMap((f) => f.polygon));
  const bound = (pick) => [0, 1, 2].map((k) => pick(...points.map((p) => p[k])));
  return [bound(Math.min), bound(Math.max)];
}

/** Seconds each basin's train waits in its tunnel between crossings, the two apart so they keep no beat. */
const LINE_WAIT = { n: 110, s: 136 };

/**
 * Both basins' trains and what they set off. Each train and its windows are two func_trains on paths of their own,
 * the same length and run at the same speed, so they move as one: from the tunnel at one end of the bridge across
 * to the other's, and back through the rock in a jump (a path_corner's teleport), out of sight. The north train
 * runs west, the south's east. As a train leaves its tunnel the corner it waited at fires its pass: the rumble,
 * loud and heard all round the basin, and the ground shaking under everyone near (env_shake, not over the whole
 * map). The trains are func_trains: GoldSrc starts each at its first corner when the map does.
 */
function trains() {
  const out = [];
  const { body, glow } = train();
  const [lo, hi] = boundsOf([...body, ...glow]);
  const reach = X_BASIN + Math.ceil((hi[0] - lo[0]) / 2) + TRACK.park; // this far along a train waits behind the curtain
  for (const [half, turn] of [["n", false], ["s", true]]) {
    const wait = LINE_WAIT[half];
    const place = (p) => (turn ? turnedPoint(p) : p);
    const pass = `line_${half}_pass`;
    for (const [part, brushes, keys] of [
      ["", body, { speed: 400, movesnd: 10, volume: 1, dmg: 200, _minlight: 0.2 }],
      ["_glow", glow, { speed: 400, spawnflags: 8, rendermode: 5, renderamt: 255 }],
    ]) {
      // a func_train puts the middle of its box on each corner
      const [min, max] = boundsOf(brushes);
      const mid = [0, 1, 2].map((k) => (min[k] + max[k]) / 2);
      const [end, start] = [`line_${half}${part}_end`, `line_${half}${part}_start`];
      out.push(M.brushEntity("func_train", turn ? M.turned(brushes, 180) : brushes, { target: end, ...keys }));
      out.push(M.pointEntity("path_corner", place([mid[0] - reach, mid[1], mid[2]]), { targetname: end, target: start, wait: 0 }));
      out.push(M.pointEntity("path_corner", place([mid[0] + reach, mid[1], mid[2]]), { targetname: start, target: end, wait, spawnflags: 2, ...(part ? {} : { message: pass }) }));
    }
    out.push(M.pointEntity("multi_manager", place([0, TRACK.y, 380]), { targetname: pass, [`line_${half}_rumble`]: wait - 1.5, [`line_${half}_shake`]: wait }));
    out.push(M.pointEntity("ambient_generic", place([0, TRACK.y, 440]), { targetname: `line_${half}_rumble`, message: "ambience/cg_rdmsubway.wav", health: 10, pitch: 92, spawnflags: HEARD.large + START_SILENT + ONCE }));
    out.push(M.pointEntity("env_shake", place([0, TRACK.y, 300]), { targetname: `line_${half}_shake`, amplitude: 6, frequency: 40, duration: 7, radius: 1100, spawnflags: 4 }));
  }
  return out;
}

/** One culvert and its deck: built for the north and turned for the south. */
function culvert() {
  const detail = [];
  const lights = [];
  // gravel heaped against the walls, low enough to walk over
  for (const s of [-1, 1])
    for (const y of [368, 768]) {
      const [x0, x1] = s < 0 ? [-X_CANAL, -X_CANAL + 96] : [X_CANAL - 96, X_CANAL];
      detail.push(M.wedge([x0, y, 0], [x1, y + 112, 16], s < 0 ? "-x" : "+x", T.bank));
    }
  // pipes along both walls under the ceiling, turning up into it at the hall's end
  for (const s of [-1, 1]) {
    detail.push(M.cylinder("y", [s * (X_CANAL - 18), 200], 12, Y_HALL + 16, Y_CULVERT - 16, T.pipe, { sides: 8, snap: 1 }));
    detail.push(M.cylinder("y", [s * (X_CANAL - 18), 228], 8, Y_HALL + 16, Y_CULVERT - 16, T.pipe, { sides: 8, snap: 1 }));
    detail.push(M.cylinder("z", [s * (X_CANAL - 18), Y_HALL + 16], 12, 188, CULVERT_CEIL, T.pipe, { sides: 8, snap: 1 }));
  }
  // a grate footbridge over the channel half way, for the dry crossing
  detail.push(M.box([-X_TRENCH, MID - 32, -4], [X_TRENCH, MID + 32, 0], T.grate));
  // the light: caged lamps on the walls, and the green off the water
  for (const s of [-1, 1])
    for (const y of [448, 832]) {
      const x1 = s * X_CANAL;
      detail.push(fitting([Math.min(x1, x1 - s * 12), y - 16, 168], [Math.max(x1, x1 - s * 12), y + 16, 184], s < 0 ? "east" : "west", T.cold));
      lights.push(M.light([s * (X_CANAL - 40), y, 176], { color: [200, 215, 255], brightness: 115 * FILL.cold }));
    }
  lights.push(M.light([0, Y_HALL + 160, 20], { color: [110, 255, 150], brightness: 55 }));
  lights.push(M.light([0, Y_CULVERT - 160, 20], { color: [110, 255, 150], brightness: 55 }));

  // on the deck: cover, and floods on the walls
  detail.push(...crates(-200, 432, 5, DECK), ...crates(120, 840, 6, DECK), ...barrier(-64, 680, true, DECK), ...barrier(150, 560, false, DECK));
  for (const s of [-1, 1]) {
    const x1 = s * X_CANAL;
    detail.push(fitting([Math.min(x1, x1 - s * 16), MID - 24, 548], [Math.max(x1, x1 - s * 16), MID + 24, 572], "bottom", T.sodium));
    lights.push(M.light([s * (X_CANAL - 40), MID, 540], { color: [255, 150, 70], brightness: 190 * FILL.sodium }));
  }

  // the station's face on the deck: plate over the concrete, a band of dark windows, its door framed and signed
  for (const [x0, x1] of [[-X_CANAL, -80], [80, X_CANAL]]) detail.push(M.box([x0, Y_DECK, DECK], [x1, Y_DECK + 8, 640], T.wall));
  detail.push(M.box([-80, Y_DECK, DECK + 128], [80, Y_DECK + 8, 640], T.wall));
  for (const x of [-80, 64]) detail.push(M.box([x, Y_DECK, DECK], [x + 16, Y_DECK + 16, DECK + 128], T.doorTrim));
  detail.push(M.box([-80, Y_DECK, DECK + 112], [80, Y_DECK + 16, DECK + 128], T.doorTrim));
  detail.push(M.box([-X_CANAL + 32, Y_DECK + 8, 512], [X_CANAL - 32, Y_DECK + 12, 592], { north: "win2", sides: T.trim }));
  detail.push(M.box([-X_CANAL, Y_DECK, 640], [X_CANAL, Y_DECK + 24, 656], T.trim));
  detail.push(sign("em_drain", [128, 64], [-64, Y_DECK + 8, DECK + 136], [64, Y_DECK + 12, DECK + 200], "north"));
  detail.push(fitting([-24, Y_DECK + 8, DECK + 208], [24, Y_DECK + 20, DECK + 216], "bottom", T.cold));
  lights.push(M.light([0, Y_DECK + 40, DECK + 180], { color: [170, 200, 255], brightness: 110 * FILL.cold }));
  return { detail, lights };
}

/** The pumping station: pumps, the catwalk round its upper floor and the stairs to it, the crossings over the
 *  channel, pipes overhead, the signs, its lights. It is its own twin turned. */
function station() {
  const detail = [];
  const lights = [];
  // four pumps, two either side of the channel, each with its riser to the roof
  for (const [x, y] of [[-176, -160], [-176, 160], [176, -160], [176, 160]]) {
    detail.push(M.cylinder("z", [x, y], 48, 0, 144, T.pipe, { sides: 12, snap: 1 }));
    detail.push(M.cylinder("z", [x, y], 36, 144, 176, T.trim, { sides: 12, snap: 1 }));
    detail.push(M.cylinder("z", [x, y], 12, 176, HALL_CEIL, T.pipe, { sides: 8, snap: 1 }));
  }
  // the catwalks along the north and south walls at the decks' height, railed, and the stairs up to them:
  // up the west wall to the north catwalk, up the east wall to the south
  detail.push(M.box([-X_HALL, Y_HALL - 64, DECK - 16], [X_HALL, Y_HALL, DECK], T.grate));
  detail.push(M.box([-X_HALL, -Y_HALL, DECK - 16], [X_HALL, -Y_HALL + 64, DECK], T.grate));
  detail.push(...rail([[-X_HALL + 64, Y_HALL - 62], [X_HALL, Y_HALL - 62]], DECK));
  detail.push(...rail([[-X_HALL, -Y_HALL + 62], [X_HALL - 64, -Y_HALL + 62]], DECK));
  detail.push(...M.stairs([-X_HALL, -32, 0], [-X_HALL + 64, Y_HALL - 64, DECK], "+y", T.steps, { tread: 16, ramp: "CLIP" }));
  detail.push(...M.stairs([X_HALL - 64, -Y_HALL + 64, 0], [X_HALL, 32, DECK], "-y", T.steps, { tread: 16, ramp: "CLIP" }));
  // grate crossings over the channel
  for (const y of [-224, 0, 224]) detail.push(M.box([-X_TRENCH, y - 40, -4], [X_TRENCH, y + 40, 0], T.grate));
  // pipes along the hall overhead
  detail.push(M.cylinder("x", [-96, 396], 16, -X_HALL, X_HALL, T.pipe, { sides: 8, snap: 1 }));
  detail.push(M.cylinder("x", [96, 418], 12, -X_HALL, X_HALL, T.pipe, { sides: 8, snap: 1 }));
  // the drainage valve's sign over each catwalk, beside the culvert's mouth
  detail.push(sign("em_drain", [128, 64], [128, Y_HALL - 4, DECK + 48], [256, Y_HALL, DECK + 112], "south"));
  detail.push(sign("em_drain", [128, 64], [-256, -Y_HALL, DECK + 48], [-128, -Y_HALL + 4, DECK + 112], "north"));
  // the lights: cold overhead, over the floor and over each catwalk, and a warning red at each stair's foot
  for (const [x, y] of [[-160, 0], [160, 0], [0, -208], [0, 208], [-224, 288], [224, -288]]) {
    detail.push(fitting([x - 32, y - 8, HALL_CEIL - 16], [x + 32, y + 8, HALL_CEIL - 8], "bottom", T.cold));
    lights.push(M.light([x, y, HALL_CEIL - 40], { color: [160, 185, 240], brightness: 175 * FILL.cold }));
  }
  for (const [x, y, face] of [[-X_HALL, -48, "east"], [X_HALL, 48, "west"]]) {
    detail.push(fitting([Math.min(x, x - Math.sign(x) * 8), y - 8, 120], [Math.max(x, x - Math.sign(x) * 8), y + 8, 136], face, T.red));
    lights.push(M.light([x - Math.sign(x) * 32, y, 128], { color: [255, 80, 60], brightness: 70 }));
  }
  return { detail, lights };
}

/** The galleries and their rooms: pipes under their ceilings, lamps, crates, the filter beds and the generators,
 *  the generator room's sign. Their own twins turned. */
function galleries() {
  const detail = [];
  const lights = [];
  for (const s of [-1, 1]) {
    const mid = (s * (X_GALLERY[0] + X_GALLERY[1])) / 2;
    detail.push(M.cylinder("y", [s * (X_GALLERY[1] - 12), 146], 8, -Y_GALLERY, Y_GALLERY, T.pipe, { sides: 8, snap: 1 }));
    for (let y = -Y_GALLERY + 128; y < Y_GALLERY; y += 256) {
      detail.push(fitting([mid - 24, y - 6, GALLERY_CEIL - 8], [mid + 24, y + 6, GALLERY_CEIL], "bottom", T.cold));
      lights.push(M.light([mid, y, GALLERY_CEIL - 24], { color: [170, 195, 255], brightness: 110 * FILL.cold }));
    }
    // crates stood against the inner wall, clear of the doors
    for (const [n, y] of [[7, -400], [8, 336]]) detail.push(...crates(s < 0 ? -X_GALLERY[0] - 64 : X_GALLERY[0], s * y, n));
  }
  // the filter room (west): two filter beds along its sides and a tank at its far wall
  for (const y of [-160, 96]) detail.push(M.box([-ROOM.x[1] + 32, y, 0], [-ROOM.x[0] - 64, y + 64, 40], { top: T.grate, sides: T.trim, bottom: T.trim }));
  detail.push(M.cylinder("z", [-ROOM.x[1] + 64, 0], 40, 0, 160, T.pipe, { sides: 12, snap: 1 }));
  detail.push(M.cylinder("z", [-ROOM.x[1] + 64, 0], 12, 160, ROOM.ceiling, T.pipe, { sides: 8, snap: 1 }));
  const west = -(ROOM.x[0] + ROOM.x[1]) / 2;
  detail.push(fitting([west - 32, -8, ROOM.ceiling - 8], [west + 32, 8, ROOM.ceiling], "bottom", T.cold));
  lights.push(M.light([west, 0, ROOM.ceiling - 32], { color: [120, 255, 170], brightness: 160 * FILL.cold }));
  // the generator room (east): two generators in circuit-plated housings with grated tops and their
  // exhaust stacks, their cable pipe, a lit control panel on the far wall, and its sign in the gallery
  for (const y of [-136, 56]) {
    detail.push(M.box([ROOM.x[0] + 96, y, 0], [ROOM.x[1] - 64, y + 80, 88], { top: T.grate, sides: "DRKMTLT_WALL07", bottom: T.trim }));
    detail.push(M.box([ROOM.x[0] + 88, y + 8, 0], [ROOM.x[0] + 96, y + 72, 12], T.hazard));
    for (const x of [ROOM.x[0] + 120, ROOM.x[1] - 88]) detail.push(M.cylinder("z", [x, y + 40], 8, 88, ROOM.ceiling, T.pipe, { sides: 8, snap: 1 }));
  }
  detail.push(M.cylinder("y", [ROOM.x[1] - 32, 200], 10, -ROOM.y, ROOM.y, T.pipe, { sides: 8, snap: 1 }));
  detail.push(sign("cd_labcomp3lgt", [256, 128], [ROOM.x[1] - 4, -48, 56], [ROOM.x[1], 48, 104], "west"));
  detail.push(sign("cd_sign_genr", [96, 48], [X_GALLERY[1] - 4, -48, 92], [X_GALLERY[1], 48, 140], "west"));
  detail.push(fitting([-west - 32, -8, ROOM.ceiling - 8], [-west + 32, 8, ROOM.ceiling], "bottom", T.cold));
  lights.push(M.light([-west, 0, ROOM.ceiling - 32], { color: [255, 200, 120], brightness: 220 * FILL.cold }));
  lights.push(M.light([ROOM.x[1] - 40, 0, 96], { color: [120, 200, 255], brightness: 90 }));
  return { detail, lights };
}

// ---- the street ----------------------------------------------------------------------------------
/** The canal's edge at the street, the north half: each a line along the edge, the way the street lies from it. */
const RIM = [
  { from: [-X_CANAL, Y_DECK], to: [X_CANAL, Y_DECK], out: [0, -1] }, // over the station's face
  { from: [X_CANAL, Y_DECK], to: [X_CANAL, Y_CULVERT], out: [1, 0] }, // the deck's east wall
  { from: [X_CANAL, Y_CULVERT], to: [X_BASIN, Y_CULVERT], out: [0, -1] }, // the basin's south wall, east of the deck
  { from: [X_BASIN, Y_CULVERT], to: [X_BASIN, Y_EDGE], out: [1, 0] }, // the basin's east wall
  { from: [X_BASIN, Y_EDGE], to: [-X_BASIN, Y_EDGE], out: [0, 1] }, // its end wall
  { from: [-X_BASIN, Y_EDGE], to: [-X_BASIN, Y_CULVERT], out: [-1, 0] },
  { from: [-X_BASIN, Y_CULVERT], to: [-X_CANAL, Y_CULVERT], out: [0, -1] },
  { from: [-X_CANAL, Y_CULVERT], to: [-X_CANAL, Y_DECK], out: [-1, 0] },
];
/** Where the canal's edge turns outward, and which way the street lies there: the square two parapets leave. */
const RIM_CORNERS = [
  [-X_CANAL, Y_DECK, -1, -1],
  [X_CANAL, Y_DECK, 1, -1],
  [X_BASIN, Y_CULVERT, 1, -1],
  [-X_BASIN, Y_CULVERT, -1, -1],
  [X_BASIN, Y_EDGE, 1, 1],
  [-X_BASIN, Y_EDGE, -1, 1],
];

/** The box between a line along the rim, from `a` to `b` units out from it, `z0` to `z1` high, `grow` longer at
 *  both ends. */
function rimBox({ from, to, out }, a, b, z0, z1, texture, grow = 0) {
  const along = from[0] === to[0] ? 1 : 0;
  const across = 1 - along;
  const c0 = from[across] + out[across] * a;
  const c1 = from[across] + out[across] * b;
  const min = [0, 0, z0];
  const max = [0, 0, z1];
  min[along] = Math.min(from[along], to[along]) - grow;
  max[along] = Math.max(from[along], to[along]) + grow;
  min[across] = Math.min(c0, c1);
  max[across] = Math.max(c0, c1);
  return M.box(min, max, texture);
}

/** A sodium lamp on a post at the street's edge, leaning out over the canal: its post `at` (in plan), its head
 *  `reach` units out over the drop the way `over` points. */
function lamp(at, over, reach = 56) {
  const [x, y] = at;
  const head = [x + over[0] * reach, y + over[1] * reach];
  const top = TOP + 136;
  const detail = [M.box([x - 4, y - 4, TOP], [x + 4, y + 4, top], T.trim)];
  detail.push(M.box([Math.min(x, head[0]) - 3, Math.min(y, head[1]) - 3, top - 6], [Math.max(x, head[0]) + 3, Math.max(y, head[1]) + 3, top], T.trim));
  detail.push(fitting([head[0] - 12, head[1] - 12, top - 14], [head[0] + 12, head[1] + 12, top - 4], "bottom", T.sodium));
  return { detail, lights: [M.light([head[0], head[1], top - 30], { color: [255, 150, 70], brightness: 320 * FILL.sodium })] };
}

/** A block of the city: a tower on the street, its windows its walls, dark bands across it every few floors, a
 *  tank or a mast with a red lamp on some roofs. */
function block(x0, y0, x1, y1, high, n) {
  const top = TOP + high;
  const detail = [M.box([x0, y0, TOP], [x1, y1, top], { top: T.trim, bottom: T.trim, sides: pick(T.facade, n) })];
  for (let z = TOP + 128; z < top - 32; z += 128 + 64 * (n % 2)) detail.push(M.box([x0 - 4, y0 - 4, z], [x1 + 4, y1 + 4, z + 8], T.trim));
  detail.push(M.box([x0 - 4, y0 - 4, top], [x1 + 4, y1 + 4, top + 16], T.trim));
  if (n % 3 === 0) detail.push(M.cylinder("z", [(x0 + x1) / 2 + 24, (y0 + y1) / 2], 40, top + 16, top + 80, T.pipe, { sides: 10, snap: 1 }));
  if (n % 3 === 1) {
    const [mx, my] = [x0 + 32, y0 + 32];
    detail.push(M.box([mx - 3, my - 3, top + 16], [mx + 3, my + 3, top + 176], T.trim));
    detail.push(fitting([mx - 5, my - 5, top + 176], [mx + 5, my + 5, top + 186], "top", T.red));
  }
  return { detail, lights: [] };
}

/** The street's furniture, the north half: parapet and fence along the edge, lamps, the city's blocks. */
function street() {
  const detail = [];
  const lights = [];
  const walls = [];
  for (const edge of RIM) {
    detail.push(rimBox(edge, 0, 16, TOP, TOP + 24, T.barrier));
    walls.push(rimBox(edge, 7, 9, TOP + 24, TOP + 120, T.fence, 9));
    // the fence's posts
    const along = edge.from[0] === edge.to[0] ? 1 : 0;
    const across = 1 - along;
    const c = edge.from[across] + edge.out[across] * 8;
    for (let p = Math.min(edge.from[along], edge.to[along]); p <= Math.max(edge.from[along], edge.to[along]); p += 128) {
      const min = [0, 0, TOP + 24];
      const max = [0, 0, TOP + 124];
      min[along] = p - 2;
      max[along] = p + 2;
      min[across] = c - 2;
      max[across] = c + 2;
      detail.push(M.box(min, max, T.rail));
    }
  }
  for (const [x, y, sx, sy] of RIM_CORNERS)
    detail.push(M.box([Math.min(x, x + sx * 16), Math.min(y, y + sy * 16), TOP], [Math.max(x, x + sx * 16), Math.max(y, y + sy * 16), TOP + 24], T.barrier));

  // the lamps: post on the street, head over the drop
  const lamps = [
    ...[480, 832].flatMap((y) => [lamp([X_CANAL + 28, y], [-1, 0]), lamp([-X_CANAL - 28, y], [1, 0])]),
    ...[1136, 1456].flatMap((y) => [lamp([X_BASIN + 28, y], [-1, 0]), lamp([-X_BASIN - 28, y], [1, 0])]),
    ...[-320, 320].map((x) => lamp([x, Y_EDGE + 28], [0, -1])),
    ...[-384, 384].map((x) => lamp([x, Y_CULVERT - 28], [0, 1])),
    lamp([0, Y_DECK - 28], [0, 1]),
  ];
  for (const l of lamps) {
    detail.push(...l.detail);
    lights.push(...l.lights);
  }

  // the city's blocks, standing back from the edge: tall beside the canal, low beyond its end so the spire
  // (north) and the works (south) still show over the end walls
  const blocks = [
    block(448, 400, 704, 640, 512, 0),
    block(464, 704, 640, 928, 352, 1),
    block(-704, 448, -448, 704, 416, 2),
    block(-672, 768, -464, 920, 288, 3),
    block(832, 1008, 1088, 1264, 608, 4),
    block(800, 1344, 1024, 1600, 416, 5),
    block(-1056, 1056, -800, 1328, 480, 6),
    block(-1024, 1408, -832, 1632, 352, 7),
    block(-576, 1760, -224, 1856, 160, 8),
    block(224, 1728, 608, 1856, 128, 9),
  ];
  for (const b of blocks) detail.push(...b.detail);
  return { detail, lights, walls };
}

/** The blocks beside the station, in the middle: neither has a twin. */
function streetMiddle() {
  return { detail: [block(448, -256, 672, 256, 672, 10), block(-672, -224, -448, 224, 544, 11)].flatMap((b) => b.detail), lights: [] };
}

// ---- the sound of it -------------------------------------------------------------------------------
/** ambient_generic's spawnflags: how far it is heard (small about 500 units, medium 800, large 1250), whether it
 *  waits to be fired, and whether it plays once each time it is fired instead of looping. */
const HEARD = { everywhere: 1, small: 2, medium: 4, large: 8 };
const START_SILENT = 16;
const ONCE = 32;

/** A looping sound at `at`, heard `heard` far, at `volume` (0 to 10). Every file is the game's own, in
 *  valve\sound or ts\sound of both the Steam game and H9XASH, so nothing has to be sent to a player. */
const loop = (file, at, volume, heard, pitch = 100) => M.pointEntity("ambient_generic", at, { message: file, health: volume, pitch, spawnflags: HEARD[heard] });

/** The reverb a player hears within `radius` of `at` (env_sound's room type: 1 generic, 4 metal, 6 tunnel, 21 the
 *  big open echo a walled canal gives). A player is held by the nearest one in range that can see him, so two
 *  places of different types must not overlap where nobody would expect the sound to change. */
const room = (at, radius, roomtype) => M.pointEntity("env_sound", at, { radius, roomtype });

/** The north half's sounds, turned for the south: the outfall, the channel, the drips, the wind and the
 *  city's drone over the open canal, and each place's reverb. */
function soundsOfHalf() {
  return [
    loop("ambience/waterfall2.wav", [0, Y_EDGE - 90, OUTFALL.z - 40], 10, "medium"),
    loop("ambience/waterfall3.wav", [0, Y_PLATFORM + 40, 40], 7, "small"),
    loop("ambience/georfwater.wav", [0, 1200, 24], 5, "small"),
    loop("ambience/waterfall1.wav", [0, Y_HALL + 160, 24], 5, "small"),
    loop("ambience/waterfall1.wav", [0, Y_CULVERT - 160, 24], 5, "small", 94),
    loop("ambience/drips.wav", [-200, 560, 200], 6, "small"),
    loop("ambience/drips.wav", [200, 760, 200], 6, "small", 90),
    loop("ambience/wind2.wav", [0, 1120, 520], 4, "large"),
    loop("ambience/wind1.wav", [0, MID, 560], 3, "medium"),
    loop("ambience/fortran_city.wav", [0, 1280, 680], 4, "large"),
    room([0, 1280, 300], 700, 21),
    // the deck's echo and the culvert's tunnel, each smaller than the 264 between a culvert floor's eyes and the
    // deck's, so neither reaches the other level through the slots in the culvert's ceiling
    room([0, MID, 400], 330, 21),
    room([0, Y_HALL + 160, 60], 250, 6),
    room([0, Y_CULVERT - 160, 60], 250, 6),
  ];
}

/** The middle's sounds: the pumping station, the galleries, the two rooms, and their reverb. */
function soundsOfMiddle() {
  const west = -(ROOM.x[0] + ROOM.x[1]) / 2;
  const out = [
    loop("ambience/pumper.wav", [-176, 0, 100], 8, "medium", 96),
    loop("ambience/pumper.wav", [176, 0, 100], 8, "medium", 104),
    loop("ambience/dronemachine3.wav", [0, 0, 400], 4, "medium"),
    loop("ambience/steamjet1.wav", [176, 160, 420], 3, "small"),
    loop("ambience/georfwater.wav", [0, 0, 24], 4, "small", 92),
    // the rooms' own sounds at their far walls, so they fade before they reach the galleries
    loop("ambience/3dm_grn_wtr.wav", [-ROOM.x[1] + 36, 0, 60], 5, "small"),
    loop("ambience/drips.wav", [-ROOM.x[1] + 36, 140, 180], 3, "small", 110),
    loop("ambience/industrial2.wav", [ROOM.x[1] - 36, 0, 80], 5, "small"),
    room([0, 0, 220], 420, 4),
    // the side rooms and the galleries all one mild type: a player passing between them hears no change
    room([west, 0, 100], 200, 1),
    room([-west, 0, 100], 200, 1),
  ];
  for (const s of [-1, 1]) {
    const mid = (s * (X_GALLERY[0] + X_GALLERY[1])) / 2;
    out.push(loop("ambience/drips.wav", [mid, s * 420, 120], 3, "small", 100 + s * 8));
    out.push(loop("ambience/techamb2.wav", [mid, -s * 300, 120], 2, "small"));
    for (const y of [-448, 448]) out.push(room([mid, y, 80], 480, 1));
  }
  return out;
}

/**
 * The city beyond the walls: shots and bursts, mortars, a heavy gun, a siren, a jet, each an ambient_generic
 * heard everywhere, fired by name. (The trains are near, not distant: trains() gives each its own.) GoldSrc has no timer that picks a random time, so
 * two pairs of multi_managers fire them, the two of a pair passing the turn back and forth at the end of each
 * pass (a manager that fires itself is never run again: it takes no use until its pass is done). The pairs'
 * cycles, 100 and 160 seconds, keep no beat together, so the city does not seem to repeat. A trigger_auto
 * starts each pair a few seconds into the map. The siren's file loops, so it is fired twice: on, then off.
 */
const DISTANT = {
  far_mg1: { file: "ambience/mgun_burst1.wav", volume: 4 },
  far_mg1b: { file: "ambience/mgun_burst1.wav", volume: 3, pitch: 88 },
  far_mg2: { file: "ambience/mgun_burst2.wav", volume: 3, pitch: 94 },
  far_mg3: { file: "ambience/mgun_burst3.wav", volume: 4, pitch: 106 },
  far_mg4: { file: "ambience/mgun_burst4.wav", volume: 4 },
  far_rifle1: { file: "ambience/rifle1.wav", volume: 3 },
  far_rifle1b: { file: "ambience/rifle1.wav", volume: 3, pitch: 90 },
  far_rifle2: { file: "ambience/rifle2.wav", volume: 3 },
  far_mortar1: { file: "ambience/distantmortar1.wav", volume: 4 },
  far_mortar2: { file: "ambience/distantmortar2.wav", volume: 4 },
  far_mortar3: { file: "ambience/distantmortar3.wav", volume: 4 },
  far_gun: { file: "ambience/biggun2.wav", volume: 3, pitch: 82 },
  far_jet: { file: "ambience/jetflyby1.wav", volume: 4, pitch: 90 },
  far_siren: { file: "ambience/siren.wav", volume: 3, looped: true },
};
const PASSES = {
  far_a: { next: "far_b", after: 47, fire: { far_mg1: 3.2, far_rifle2: 11.5, far_mg3: 12.4, far_mortar2: 24.8, far_rifle1: 33, far_mg4: 39.7 } },
  far_b: { next: "far_a", after: 53, fire: { far_mg2: 6.1, far_rifle1b: 14.3, far_mortar1: 20.2, far_mg1b: 28.6, "far_rifle2#2": 36.9, "far_mg3#2": 37.6, far_gun: 45 } },
  far_c: { next: "far_d", after: 71, fire: { far_jet: 30, far_siren: 55, "far_siren#2": 66.5 } },
  far_d: { next: "far_c", after: 89, fire: { far_mortar3: 48, "far_mg4#2": 70 } },
};

function distantCity() {
  const out = Object.entries(DISTANT).map(([targetname, { file, volume, pitch = 100, looped }]) =>
    M.pointEntity("ambient_generic", [0, 0, SKY_Z - 128], { targetname, message: file, health: volume, pitch, spawnflags: HEARD.everywhere + START_SILENT + (looped ? 0 : ONCE) }),
  );
  for (const [targetname, { next, after, fire }] of Object.entries(PASSES))
    out.push(M.pointEntity("multi_manager", [0, 0, SKY_Z - 160], { targetname, ...fire, [next]: after }));
  out.push(M.pointEntity("trigger_auto", [0, 0, SKY_Z - 192], { target: "far_a", delay: 8, triggerstate: 2, spawnflags: 1 }));
  out.push(M.pointEntity("trigger_auto", [32, 0, SKY_Z - 192], { target: "far_c", delay: 15, triggerstate: 2, spawnflags: 1 }));
  return out;
}

/** Point entities drawn for the north half, and their twins turned into the south. */
const withTwins = (entities) => [...entities, ...entities.map((e) => ({ ...e, origin: turnedPoint(String(e.origin).split(/\s+/).map(Number)).join(" ") }))];

/** Every sound entity: the north half's, turned for the south, the middle's and the city's. */
const soundscape = () => [...withTwins([...soundsOfHalf(), ...rainOfHalf().sounds]), ...soundsOfMiddle(), ...distantCity()];

// ---- the rain --------------------------------------------------------------------------------------
/** A sheet of falling rain standing at `at` (its middle): sprites.mjs's h9_drain_rain, turning about the upright
 *  to face the eye, 192 across and 768 tall. Its frames are one group, played by the client's clock, so the
 *  server never steps them. */
const rainSheet = (at) => M.pointEntity("env_sprite", at, { model: "sprites/h9_drain_rain.spr", rendermode: 5, renderamt: 90, rendercolor: [255, 255, 255], scale: 3, framerate: 0 });
/** The rain landing on a floor or the runoff at `at`: h9_drain_splash laid flat, 320 across. */
const splash = (at) => M.pointEntity("env_sprite", at, { model: "sprites/h9_drain_splash.spr", rendermode: 5, renderamt: 130, rendercolor: [255, 255, 255], scale: 2.5, framerate: 0, angles: [90, 0, 0] });

/** The north half's rain: sheets over the basin either side of the bridge and over the deck, splashes on the
 *  floors the bridge leaves open, the platform, the catwalk and the runoff, and the sound of it (TS's own rain and
 *  thunder). */
function rainOfHalf() {
  const sprites = [];
  for (const [k, x] of [-512, -256, 0, 256, 512].entries())
    for (const [j, y] of [1100, 1480].entries()) sprites.push(rainSheet([x + ((k + j) % 2 ? 40 : -40), y + (k % 2 ? 48 : 0), 400]));
  for (const x of [-128, 128]) for (const y of [480, 700, 900]) sprites.push(rainSheet([x, y + (x > 0 ? 60 : 0), DECK + 384]));
  // a tier higher, over the line and the street and on up toward the sky, so the rain is seen falling from far
  // above, not starting over the trains
  for (const [k, x] of [-512, -256, 0, 256, 512].entries())
    for (const [j, y] of [1150, 1450].entries()) sprites.push(rainSheet([x + ((k + j) % 2 ? -40 : 40), y + (k % 2 ? 0 : 48), 1168]));
  for (const x of [-128, 128]) for (const y of [520, 860]) sprites.push(rainSheet([x, y + (x > 0 ? 60 : 0), 1320]));
  for (const x of [-416, 416]) sprites.push(splash([x, 1100, 2]));
  for (const y of [1100, 1420]) sprites.push(splash([0, y, TRENCH + WATER + 1]));
  sprites.push(splash([-352, Y_EDGE - 80, PLATFORM + 2]), splash([352, Y_EDGE - 80, PLATFORM + 2]), splash([-420, Y_CULVERT + 48, DECK + 2]));
  sprites.push(splash([-96, 560, DECK + 2]), splash([96, 820, DECK + 2]));
  const sounds = [loop("ambience/thunder_rain.wav", [0, 1280, 260], 6, "large"), loop("ambience/thunder_rain.wav", [0, MID, 420], 4, "medium", 96)];
  return { sprites, sounds };
}

// ---- the grime ---------------------------------------------------------------------------------------
/** A heap of the city's litter as Paradise City strews it: an h9 model on a floor (a ts_model is a point to the
 *  game, nothing to walk into). qk_trash is two bins and their spill, re_dirt a scatter of paper and sticks. */
const litter = (model, at, yaw) => M.pointEntity("ts_model", at, { model: `models/h9/${model}.mdl`, angles: [0, yaw, 0] });
/** A stain stuck to the surface a unit from `at`: an infodecal of the game's own decals.wad. */
const stain = (texture, at) => M.pointEntity("infodecal", at, { texture });

/** The north half's grime, turned for the south: litter, and stains on the canal's walls, floors and ceilings. */
function grimeOfHalf() {
  return [
    litter("qk_trash", [-400, 990, 0], 0),
    litter("re_dirt", [-480, 1300, 0], 90),
    litter("re_dirt", [360, 1120, 0], -108),
    litter("re_dirt", [-520, Y_EDGE - 80, PLATFORM], 180),
    litter("re_dirt", [-180, 560, 0], -87),
    litter("re_dirt", [176, 912, 0], 90),
    litter("qk_trash", [190, 400, DECK], 180),
    litter("re_dirt", [-60, 820, DECK], 0),
    // the basin: moss along the foot of its walls, lime run down from the street, rust under the outfall and the
    // pipes, drips under the catwalk, graffiti, and oil, puddles and cracks on its floor and its platform
    stain("{MOSS001", [X_BASIN - 1, 1100, 36]),
    stain("{MOSS003", [X_BASIN - 1, 1200, 60]),
    stain("{MOSS002", [X_BASIN - 1, 1520, 130]),
    stain("{MOSS004", [-X_BASIN + 1, 1060, 44]),
    stain("{MOSS001", [-X_BASIN + 1, 1180, 30]),
    stain("{MOSS003", [-X_BASIN + 1, 1530, 140]),
    stain("{LIME001", [X_BASIN - 1, 1150, 520]),
    stain("{LIME003", [X_BASIN - 1, 1420, 420]),
    stain("{LIME002", [-X_BASIN + 1, 1300, 480]),
    stain("{LIME004", [-X_BASIN + 1, 1050, 560]),
    stain("{RUST002", [0, Y_EDGE - 1, 160]),
    stain("{RUST004", [-80, Y_EDGE - 1, 470]),
    stain("{RUST001", [90, Y_EDGE - 1, 480]),
    stain("{LIME003", [300, Y_EDGE - 1, 560]),
    stain("{GRAF003", [-380, Y_CULVERT + 1, 110]),
    stain("{GRAF001", [608, Y_CULVERT + 1, 150]),
    stain("{DRIPS1", [-460, Y_CULVERT + 1, 240]),
    stain("{DRIP2", [460, Y_CULVERT + 1, 230]),
    stain("{OIL1", [-300, 1250, 1]),
    stain("{OIL2", [420, 1340, 1]),
    stain("{WATER1", [-150, 1100, 1]),
    stain("{WATER2", [200, 1380, 1]),
    stain("{WATER3", [-480, 1420, 1]),
    stain("{FAULT02", [300, 1060, 1]),
    stain("{FAULT05", [-240, 1400, 1]),
    stain("{CRACK2", [100, 1200, 1]),
    stain("{OIL2", [450, 1500, PLATFORM + 1]),
    stain("{FAULT04", [-300, 1560, PLATFORM + 1]),
    // the deck and the station's face
    stain("{LIME002", [X_CANAL - 1, 600, 560]),
    stain("{MOSS003", [-X_CANAL + 1, 780, 320]),
    stain("{RUST003", [-X_CANAL + 1, 520, 480]),
    stain("{GRAF004", [X_CANAL - 1, 860, 340]),
    stain("{WATER2", [-80, 640, DECK + 1]),
    stain("{OIL1", [120, 480, DECK + 1]),
    stain("{WATER1", [60, 900, DECK + 1]),
    stain("{RUST001", [150, Y_DECK + 9, 500]),
    // the culvert: moss at the waterline, lime and drips, a tag, drip stains on the ceiling, oil and a puddle
    stain("{MOSS001", [-X_CANAL + 1, 420, 30]),
    stain("{MOSS004", [X_CANAL - 1, 520, 24]),
    stain("{LIME003", [-X_CANAL + 1, 800, 150]),
    stain("{LIME001", [X_CANAL - 1, 380, 160]),
    stain("{DRIPS1", [-X_CANAL + 1, 880, 200]),
    stain("{GRAF005", [X_CANAL - 1, 900, 100]),
    stain("{DRIP3", [-120, 560, CULVERT_CEIL - 1]),
    stain("{DRIP4", [140, 700, CULVERT_CEIL - 1]),
    stain("{WATER3", [-170, 700, 1]),
    stain("{OIL1", [160, 460, 1]),
  ];
}

/** The middle's grime: the hall, the galleries and the two rooms. */
function grimeOfMiddle() {
  return [
    litter("qk_trash", [232, 264, 0], 180),
    litter("qk_trash", [-232, -264, 0], 0),
    litter("re_dirt", [-200, 40, 0], -87),
    litter("re_dirt", [200, -40, 0], 93),
    litter("re_dirt", [512, 560, 0], 0),
    litter("re_dirt", [-512, -560, 0], 180),
    litter("re_dirt", [-512, 240, 0], 90),
    litter("re_dirt", [512, -240, 0], -90),
    litter("qk_trash", [830, 160, 0], 180),
    litter("re_dirt", [-700, 0, 0], 0),
    stain("{OIL1", [-176, -60, 1]),
    stain("{OIL2", [176, 60, 1]),
    stain("{FAULT01", [-140, 230, 1]),
    stain("{SCORCH2", [230, -150, 1]),
    stain("{RUST004", [-X_HALL + 1, -250, 200]),
    stain("{RUST002", [X_HALL - 1, 250, 220]),
    stain("{LIME004", [100, Y_HALL - 1, 400]),
    stain("{LIME002", [-100, -Y_HALL + 1, 400]),
    stain("{DRIPS1", [X_GALLERY[0] + 1, -700, 120]),
    stain("{RUST001", [X_GALLERY[1] - 1, 300, 110]),
    stain("{GRAF002", [X_GALLERY[0] + 1, 420, 80]),
    stain("{DRIPS1", [-X_GALLERY[0] - 1, 700, 120]),
    stain("{RUST003", [-X_GALLERY[1] + 1, -300, 110]),
    stain("{GRAF003", [-X_GALLERY[0] - 1, -420, 80]),
    stain("{WATER1", [512, -450, 1]),
    stain("{WATER2", [-512, 450, 1]),
    stain("{WATER3", [-700, -40, 1]),
    stain("{MOSS002", [-ROOM.x[1] + 1, 60, 40]),
    stain("{OIL2", [740, 0, 1]),
    stain("{SCORCH1", [650, -100, 1]),
  ];
}

// ---- the dirt in the air ---------------------------------------------------------------------------------
/** A low drift of dirty haze standing on the floor at `at` (x, y, the floor's height): sprites.mjs's h9_drain_fog,
 *  turning about the upright to face the eye, 640 across and 160 tall, thickest at its foot, which sits a little
 *  under the floor so its edge never shows. It darkens and tints what is behind it; it does not glow. */
const fog = ([x, y, floor]) =>
  M.pointEntity("env_sprite", [x, y, floor + 68], { model: "sprites/h9_drain_fog.spr", rendermode: 2, renderamt: 170, rendercolor: [255, 255, 255], scale: 2.5, framerate: 0 });

/** The north half's floors: the basin's, the platform's and the culvert's banks. */
const fogOfHalf = () => [
  ...[-416, 0, 416].flatMap((x) => [1060, 1300].map((y) => fog([x, y + (x ? 0 : 60), 0]))),
  fog([0, Y_EDGE - 80, PLATFORM]),
  ...[Y_HALL + 160, Y_CULVERT - 160].map((y) => fog([0, y, 0])),
];

/** The middle's: the hall either side of its channel, the galleries' lengths, the two side rooms. */
const fogOfMiddle = () => [
  ...[-150, 150].map((y) => fog([0, y, 0])),
  ...[-1, 1].flatMap((s) => [-600, 0, 600].map((y) => fog([(s * (X_GALLERY[0] + X_GALLERY[1])) / 2, y, 0]))),
  ...[-1, 1].map((s) => fog([(s * (ROOM.x[0] + ROOM.x[1])) / 2, 0, 0])),
];

/** The rain's sprites, the dirt in the air and all the grime: the north half's with their twins, and the middle's. */
const weatherAndGrime = () => [...withTwins([...rainOfHalf().sprites, ...fogOfHalf(), ...grimeOfHalf()]), ...fogOfMiddle(), ...grimeOfMiddle()];

/** All of it: the north half's basin, culvert and street, turned to make the south's, and the middle. */
function dressing() {
  const detail = [];
  const lights = [];
  const walls = [];
  const falls = [];
  const take = (part, twin) => {
    detail.push(...part.detail);
    lights.push(...part.lights);
    walls.push(...(part.walls ?? []));
    falls.push(...(part.falls ?? []));
    if (!twin) return;
    detail.push(...turnedHalf(part.detail));
    lights.push(...part.lights.map((l) => ({ ...l, origin: turnedPoint(String(l.origin).split(/\s+/).map(Number)).join(" ") })));
    walls.push(...turnedHalf(part.walls ?? []));
    falls.push(...turnedHalf(part.falls ?? []));
  };
  take(basin(), true);
  take(line(), true);
  take(culvert(), true);
  take(street(), true);
  take(station(), false);
  take(galleries(), false);
  take(streetMiddle(), false);
  // the runoff, the length of the channel
  const water = M.box([-X_TRENCH, -Y_EDGE, TRENCH], [X_TRENCH, Y_EDGE, TRENCH + WATER], T.water);
  return { detail, lights, walls, falls, water };
}

// ---- the three maps ------------------------------------------------------------------------------
/**
 * Where each side starts: [{ team, at (the floor point), yaw }]. The map's spawn entities are written from these,
 * and so is ts_matchmode's spawn config for the map (tsm_spawns_<map>.cfg), which it reads before the map's
 * entities: without it the core sorts deathmatch spawns into two clusters by distance, which is wrong for
 * survival, where one side starts in the middle.
 */
function spawnPoints(variant) {
  const out = [];
  // two rows of eight across a platform, 128 apart along a row and 64 between the rows: ts_matchmode keeps a
  // spawn 64 clear of anyone standing there, so sixteen land on it with nobody on anybody
  const platformRows = (s) => [Y_EDGE - 112, Y_EDGE - 48].flatMap((y) => [-544, -416, -288, -160, 160, 288, 416, 544].map((x) => [s * x, s * y, PLATFORM]));
  // and two rows 96 apart on the basin's floor in front of it, behind the foot of the platform's stairs: the
  // near row from the side wall's stair block to the channel, the far one clear of the bridge's bents and, by
  // the west wall, the crates. With the platform, 34 a side
  const basinRows = (s) => [
    ...[-528, -432, -336, -240, -144, 144, 240, 336, 432, 528].map((x) => [s * x, s * (Y_PLATFORM - 144), 0]),
    ...[-528, -432, -336, -144, 144, 336, 432, 528].map((x) => [s * x, s * (Y_PLATFORM - 240), 0]),
  ];
  if (variant === "up" || variant === "mw") {
    // MSR on the north platform and the basin's floor before it, the Insurgents on the south's, facing down
    // the works
    for (const at of [...platformRows(1), ...basinRows(1)]) out.push({ team: 1, at, yaw: 270 });
    for (const at of [...platformRows(-1), ...basinRows(-1)]) out.push({ team: 2, at, yaw: 90 });
  } else {
    // the survivors in the station, 34 of them. On its floor either side of the channel, clear of the pumps,
    // the stairs and the doors to the galleries: four round its middle, a band of three under each catwalk
    // (80 apart, the most the hall's width between wall and channel takes) and one beside each pump by the
    // channel; the west half is listed, and the east is the same turned, as the station is. On its catwalks,
    // from each stair's head to the catwalk's dead end.
    const west = [[-232, 64], [-144, 64], [-232, -64], [-144, -64], [-296, 296], [-216, 296], [-136, 296], [-296, -296], [-216, -296], [-136, -296], [-128, 216], [-128, -216]];
    const floor = [...west, ...west.map(([x, y]) => [-x, -y])].map(([x, y]) => [x, y, 0]);
    const catwalks = [-192, -64, 64, 192, 288].flatMap((x) => [[x, Y_HALL - 32, DECK], [-x, -Y_HALL + 32, DECK]]);
    for (const [x, y, z] of [...floor, ...catwalks]) out.push({ team: 1, at: [x, y, z], yaw: y >= 0 ? 90 : 270 });
    // the mutants: both platforms, and the galleries' far ends, two to each
    for (const s of [1, -1]) {
      for (const at of platformRows(s)) out.push({ team: 2, at, yaw: s > 0 ? 270 : 90 });
      for (const gx of [-(X_GALLERY[0] + X_GALLERY[1]) / 2, (X_GALLERY[0] + X_GALLERY[1]) / 2])
        for (const back of [64, 160]) out.push({ team: 2, at: [gx, s * (Y_GALLERY - back), 0], yaw: s > 0 ? 270 : 90 });
    }
  }
  return out;
}

/** The map's spawn entities: each side's own class, and a deathmatch one beside it for TS's fallback. */
const spawnEntities = (variant) =>
  spawnPoints(variant).flatMap(({ team, at, yaw }) => [M.playerStart(at, yaw, `info_player_team${team}`), M.playerStart(at, yaw, "info_player_deathmatch")]);

/** ts_matchmode's spawn config for the map: tsm_spawn <team> <x> <y> <z> <pitch> <yaw> <tier>, z the origin. */
const spawnConfig = (name, variant) =>
  [
    `// ts_matchmode spawn points for ${name} -- written by export-map/h9_drainage/drainage.mjs`,
    "// tsm_spawn <team> <x> <y> <z> <pitch> <yaw> <tier>",
    ...spawnPoints(variant).map(({ team, at, yaw }) => `tsm_spawn ${team} ${at[0].toFixed(2)} ${at[1].toFixed(2)} ${(at[2] + 37).toFixed(2)} 0.00 ${yaw.toFixed(2)} 0`),
    "",
  ].join("\r\n");

/** What the server sends a player along with the map, past what the map's entities ask for: the sky's six sides. */
const resList = (name) =>
  [`// ${name}: sent with the map to a player who joins without it`, ...M.SKY_SIDES.map((side) => `gfx/env/${SKY_NAME}${side}.tga`), ""].join("\r\n");

/** The zones (the north culvert, the filter room, the south culvert, the generator room) and the uplink's point
 *  in the station. The side rooms' zones are each other's twins turned, so neither side is nearer either. */
const ZONES = {
  tsm_cap_1: [0, MID, 0],
  tsm_cap_2: [-(ROOM.x[0] + ROOM.x[1]) / 2, 0, 0],
  tsm_cap_3: [0, -MID, 0],
  tsm_cap_4: [(ROOM.x[0] + ROOM.x[1]) / 2, 0, 0],
  tsm_uplink: [160, 0, 16],
};

function entitiesFor(variant) {
  const out = [...spawnEntities(variant)];
  if (variant === "up") for (const [targetname, at] of Object.entries(ZONES)) out.push(M.pointEntity("info_target", at, { targetname }));
  return out;
}

/** A face given another texture, its picture's axes and fit worked out as SMAK's own faces are. */
function refit(face, normal, texture) {
  const fit = M.textureFor(texture, normal);
  const scale = Array.isArray(fit.scale) ? fit.scale : [fit.scale ?? 1, fit.scale ?? 1];
  const offset = fit.offset ?? [0, 0];
  const rotation = fit.rotation ?? 0;
  const axes = M.textureAxes(normal, { align: fit.align, rotation });
  return { ...face, texture: fit.name, u: [...axes.u, offset[0]], v: [...axes.v, offset[1]], rotation, scale: [...scale] };
}

/**
 * Each wall of the carved rock worn as the space it faces over most of its own area.
 *
 * carvePlan votes a wall's texture by five points along its piece of rock's side, and rock facing only rock
 * counts for half: a piece that runs on past the room it walls (over the galleries the rock runs the canal's
 * whole length) can lose that vote to the rock and wear the carve's own concrete in a hall of metal. Here the
 * vote is taken across the face itself, a point every 16 units or so, and rock has no vote. Each face changed
 * is lined up on its space's floor and corner as carvePlan lines up its walls. Returns how many changed.
 */
function wornAsSeen(brushes, list, fallback) {
  const made = list.map((space, nth) => M.planSpace(space, nth));
  const wallOf = (texture) => {
    if (texture === undefined) return fallback.wall;
    if (typeof texture === "object" && !texture.name) return texture.wall ?? texture.floor ?? texture.ceiling ?? fallback.wall;
    return texture;
  };
  const nameOf = (texture) => (typeof texture === "string" ? texture : texture.name);
  const least = made.map((space) => [0, 1].map((k) => Math.min(...space.areas.flat(2).map((p) => p[k]))));
  let changed = 0;
  for (const brush of brushes) {
    const shape = M.shapeOf(brush);
    shape.faces.forEach((face, i) => {
      if (!face.normal || Math.abs(face.normal[2]) > 0.01 || face.polygon.length < 3) return;
      // the axis the wall runs along, and its extent along it and up it
      const along = Math.abs(face.normal[0]) >= Math.abs(face.normal[1]) ? 1 : 0;
      const runs = face.polygon.map((p) => p[along]);
      const ups = face.polygon.map((p) => p[2]);
      const [a0, a1, z0, z1] = [Math.min(...runs), Math.max(...runs), Math.min(...ups), Math.max(...ups)];
      const [na, nz] = [Math.max(1, Math.round((a1 - a0) / 16)), Math.max(1, Math.round((z1 - z0) / 16))];
      const votes = new Map();
      for (let ka = 0; ka < na; ka++)
        for (let kz = 0; kz < nz; kz++) {
          const p = [0, 0, z0 + ((kz + 0.5) * (z1 - z0)) / nz];
          p[along] = a0 + ((ka + 0.5) * (a1 - a0)) / na;
          p[1 - along] = face.polygon[0][1 - along] + face.normal[1 - along] * 0.5;
          const nth = M.spaceAt(made, p);
          if (nth >= 0) votes.set(nth, (votes.get(nth) ?? 0) + 1);
        }
      if (!votes.size) return;
      const best = [...votes.entries()].sort((p, q) => q[1] - p[1])[0][0];
      const want = wallOf(made[best].texture);
      if (nameOf(want) === brush.faces[i].texture) return;
      brush.faces[i] = refit(brush.faces[i], face.normal, M.onFloor(want, made[best].floor, least[best][along]));
      changed++;
    });
  }
  return changed;
}

/** What each map is called in the game's own title for it (worldspawn's message). */
const TITLES = { up: "Drainage -- Capture the Uplink", ws: "Drainage -- Wave Survival", mw: "Drainage -- Mech Warrior" };

function build(variant) {
  const { detail, lights, walls, falls, water } = dressing();
  const list = spaces();
  const fallback = { floor: T.basinFloor, wall: T.canalWall, ceiling: T.canalWall };
  const rock = M.carvePlan(list, 64, fallback);
  const rewalled = wornAsSeen(rock, list, fallback);
  return {
    rewalled,
    worldspawn: {
      wad: Object.values(WADS).filter(existsSync),
      skyname: SKY_NAME,
      MaxRange: 8192,
      message: TITLES[variant],
    },
    brushes: [...rock, water],
    entities: [
      // the night over the city: a faint light down from the smog, and its fainter glow all round; the lamps,
      // their lit faces shining (LAMP_FACES), give the rest
      M.sunLight([0, 0, SKY_Z - 64], { pitch: -65, yaw: 110, color: [150, 128, 112], brightness: 16, _diffuse_light: [110, 92, 82, 9] }),
      M.textureLights([0, 0, SKY_Z - 224], LAMP_FACES),
      ...lights,
      M.brushEntity("func_detail", detail),
      // each fence and grate, and each fall, an entity of its own: one spread over the map would be drawn from
      // everywhere (hlvis gives an entity whose box spans too many leaves the engine's coarsest test)
      ...walls.map((brush) => M.brushEntity("func_wall", [brush], { rendermode: 4, renderamt: 255 })),
      ...falls.map((brush) => M.brushEntity("func_illusionary", [brush], { rendermode: 2, renderamt: 170 })),
      ...trains(),
      ...soundscape(),
      ...weatherAndGrime(),
      ...entitiesFor(variant),
    ],
  };
}

// ---- write, check, walk, draw ------------------------------------------------------------------------
mkdirSync(OUT, { recursive: true });
const flags = process.argv.slice(2);
const textures = new Set(Object.values(WADS).filter(existsSync).flatMap((w) => M.wadTextureNames(readFileSync(w))));
const save = (name, img) => writeFileSync(join(OUT, name), K.png(img.width, img.height, img.rgba));

const maps = {};
for (const variant of ["up", "ws", "mw"].filter((v) => !process.env.DRAIN_ONLY || v === process.env.DRAIN_ONLY)) {
  const name = `h9_${variant}_drainage`;
  const { rewalled, ...map } = build(variant);
  maps[name] = map;
  writeFileSync(join(OUT, `${name}.map`), M.writeMap(map));
  writeFileSync(join(OUT, `tsm_spawns_${name}.cfg`), spawnConfig(name, variant));
  writeFileSync(join(OUT, `${name}.res`), resList(name));
  const plan = M.checkPlan(map, { textures: [...textures] });
  console.log(`\n${name}: ${map.brushes.length} world brushes, ${map.entities.length} entities, ${rewalled} walls worn as the room they face`);
  for (const e of plan.errors) console.log(`  ERROR ${e}`);
  for (const w of plan.warnings.slice(0, 12)) console.log(`  warn  ${w}`);
  if (plan.leak) console.log(`  LEAK  ${JSON.stringify(plan.leak).slice(0, 200)}`);
  const reach = M.reachOf(map, { jump: true, markers: variant === "up" ? Object.keys(ZONES) : [] });
  console.log(`  walk: ${reach.unreached?.length ?? 0} unreached, ${reach.stuck?.length ?? 0} stuck, ${reach.hanging?.length ?? 0} hanging, ${reach.oneWay?.length ?? 0} one-way`);
  for (const w of reach.warnings.slice(0, 12)) console.log(`    ${w}`);
  if (variant === "up") {
    for (const e of reach.entities.filter((e) => /^tsm_/.test(e.targetname ?? "")))
      console.log(`    ${e.targetname}: ${e.reached ? `reached by ${e.how}, ${Math.round(e.far)} units` : `NOT reached (${e.why})`}`);
    save(`${name}-plan.png`, M.planOfSource(map, { reach }));
    save(`${name}-plan-decks.png`, M.planOfSource(map, { reach, z: DECK + 36 }));
  }
}

if (flags.includes("--compile")) {
  const xash = flags.includes("--xash");
  for (const name of Object.keys(maps)) {
    console.log(`\ncompiling ${name}${xash ? " (Xash)" : ""}...`);
    const eng = xash ? ["-engine", "xash"] : [];
    const perTool = [...eng, "-threads", String(process.env.DRAIN_THREADS ?? 6)];
    const result = M.compileMap(join(OUT, `${name}.map`), {
      wads: Object.values(WADS).filter(existsSync),
      wadinclude: true,
      out: join(OUT, `${name}.bsp`),
      compilers: { folder: COMPILERS },
      args: { hlcsg: perTool, hlbsp: perTool, hlvis: [...perTool, "-fast"], hlrad: perTool },
      fast: false,
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
  // the landmarks at a player's height, drawn with the map's own baked light and its own sky
  const VIEWS = [
    ["north-basin", [200, Y_EDGE - 80, PLATFORM + 60], [0, Y_CULVERT, 160]],
    ["north-basin-up", [-420, 1300, 64], [500, 1100, 1000]],
    ["north-catwalk", [-560, 1200, DECK + 64], [0, Y_CULVERT + 48, DECK + 40]],
    ["north-line", [-200, Y_EDGE - 60, PLATFORM + 64], [0, TRACK.y, TRACK.z + 90]],
    ["north-line-tunnel", [200, Y_EDGE - 60, PLATFORM + 64], [X_BASIN, TRACK.y, TRACK.z + 90]],
    ["north-culvert", [-150, Y_CULVERT - 40, 60], [60, Y_HALL + 40, 40]],
    ["north-culvert-back", [150, Y_HALL + 40, 60], [-50, Y_CULVERT, 60]],
    ["north-deck", [0, Y_CULVERT - 24, DECK + 64], [0, Y_DECK, DECK + 160]],
    ["deck-spire", [0, Y_DECK + 64, DECK + 64], [0, 3200, 1500]],
    ["hall", [-40, -300, 120], [40, 320, 200]],
    ["hall-catwalk", [-200, Y_HALL - 32, DECK + 64], [200, -Y_HALL + 40, 100]],
    ["west-gallery", [-512, -Y_GALLERY + 40, 64], [-512, 0, 64]],
    ["filter-room", [-ROOM.x[0] - 16, -ROOM.y + 24, 80], [-ROOM.x[1] + 32, ROOM.y - 32, 40]],
    ["generator-room", [ROOM.x[0] + 16, ROOM.y - 24, 80], [ROOM.x[1] - 32, -ROOM.y + 32, 40]],
    ["south-basin", [-200, -Y_EDGE + 80, PLATFORM + 60], [0, -Y_CULVERT, 160]],
    ["deck-works", [0, -Y_DECK - 64, DECK + 64], [0, -3200, 1200]],
    ["overview", [-2100, -2700, 2300], [0, 0, 0]],
  ];
  const folders = [SKY_FOLDER, join(GAME_DIR, "ts"), join(GAME_DIR, "valve")];
  const dir = join(OUT, "views");
  mkdirSync(dir, { recursive: true });
  for (const name of Object.keys(maps)) {
    const bspFile = join(OUT, `${name}.bsp`);
    if (!existsSync(bspFile)) continue;
    const bsp = M.readBsp(readFileSync(bspFile));
    for (const [label, from, to] of name.startsWith("h9_up") ? VIEWS : VIEWS.slice(7, 9)) {
      try {
        const img = M.drawMap(bsp, { from, to, width: 640, height: 420, brightness: 1.6, folders, entities: "game", labels: false, models: true });
        writeFileSync(join(dir, `${name}-${label}.png`), K.png(img.width, img.height, img.rgba));
      } catch (e) {
        console.log(`  ${label}: FAILED -- ${e.message}`);
      }
    }
    console.log(`drew ${name} into ${dir}`);
  }
}

if (flags.includes("deploy")) {
  // the maps and their .res lists into the game's ts\maps; the spawn configs beside ts_matchmode's own, where
  // export.bat collects every tsm_spawns_*.cfg for the package
  const dir = join(GAME_DIR, "ts", "maps");
  const configs = join(GAME_DIR, "ts", "addons", "amxmodx", "configs");
  for (const name of Object.keys(maps)) {
    const bspFile = join(OUT, `${name}.bsp`);
    if (!existsSync(bspFile)) {
      console.log(`no ${name}.bsp to deploy -- compile first`);
      continue;
    }
    copyFileSync(bspFile, join(dir, `${name}.bsp`));
    copyFileSync(join(OUT, `${name}.res`), join(dir, `${name}.res`));
    copyFileSync(join(OUT, `tsm_spawns_${name}.cfg`), join(configs, `tsm_spawns_${name}.cfg`));
    console.log(`deployed ${name}.bsp and ${name}.res to ${dir}, tsm_spawns_${name}.cfg to ${configs}`);
  }
}
