// plan.mjs: New Byzantium as a plan -- every space, fitting, door and light of the city.
//
// THE WELL is the middle: an open shaft to the night sky, the MSR Nexus standing in it on its grand steps,
// its spire rising out of the well. Round it, the city is roofed, as Alexandria, Paradise and Xenon are:
//   the LOWER CITY (street level 0): four avenues out from the well's gates, a ring road, an outer road and
//     a grid of streets and alleys between them, every frontage packed with shops, flats and workshops,
//     galleries along the canyons with flats over the shops, in eight districts of their own character;
//   the WARD LEVEL (704): the Nexus's own corridors. Enclosed bridges cross the well to a ring round it,
//     wings run out over the avenues to a second ring, and from it a precinct drops into every district,
//     so the MSR reaches every part of the city without walking its streets;
//   the UPPER CITY (1056): the Mese, a marble and gold arcade round the well that looks into it, open
//     bridges to the Nexus hall, a basilica, palace flats, the ministry and the exchange; four grand
//     stair halls climb to it from the avenues;
//   the UNDERCITY (-704): sewer mains under the avenues and the ring, a city of dens along them, and under
//     the well the great cistern, its vaults on columns over black water;
//   the CANALS beyond the south gate: open to the sky, the quays, the barges and the shanties where the
//     insurgents keep house.
import { M } from "../lib.mjs";
import {
  STOREY, ROOM_H, WALL, DOOR, WIN, numbers, pick, snap, within, chance, outlineOf, boxSpace, Occupancy, Bag,
  door, glass, plate, lamp, furnish, furnishProps, litter, prop, column, spiralCore, rampCore, fog, sound,
  shaftLadder, grate, bladeSign, secretDoor,
} from "./kit.mjs";
import { FRAMES, fbox, COMPASS, boundsOf } from "./geo.mjs";
import { wellSpaces, buildNexus } from "./nexus.mjs";

// ---- heights -------------------------------------------------------------------------------------
export const Z = {
  cistern: -880, cisternWater: -896, cisternBed: -944,
  sewer: -704, sewerTop: -352, canalBed: -800, canalWater: -736,
  street: 0, avenueTop: 528, ringTop: 352, streetTop: 352, alleyTop: 336,
  ward: 704, wardTop: 896,
  mese: 1056, meseTop: 1504,
  courtSky: 2304, canalSky: 2560, wellSky: 4352,
};
export const WELL = 1664; // the well reaches +/-WELL
const CHAMFER = 448;
const LINES = [-4864, -4096, -3200, -2432, -1152, 0, 1152, 2432, 3200, 4096, 4864];

// ---- what rooms wear --------------------------------------------------------------------------------
const ROOM_TEX = {
  flat: [
    { wall: "cd_woodwall", floor: "cd_carpred", ceiling: "fap-ceiling03" },
    { wall: "howall3b", floor: "WOODFLOOR02_256", ceiling: "fap-ceiling03" },
    { wall: "cd_woodwall", floor: "cd_carpblue", ceiling: "fap-ceiling03" },
    { wall: "howall3b", floor: "greencarpet", ceiling: "RD_CEILING01" },
  ],
  flat_poor: [
    { wall: "singhettowallwo", floor: "singhettofloor", ceiling: "RD_CEILING01" },
    { wall: "po_concretwall", floor: "singhettofloor", ceiling: "RD_CEILING01" },
  ],
  flat_lux: [
    { wall: "sinwoodwallluxu", floor: "sinwoodenfloor5", ceiling: "sinceiling3" },
    { wall: "sinwall32", floor: "sinpalacefloor", ceiling: "sinceiling3" },
    { wall: "sinmarblewall", floor: "marb062", ceiling: "sinceiling3" },
  ],
  shop: [
    { wall: "cyberwall3", floor: "cyberfloor", ceiling: "fap-ceiling03" },
    { wall: "stec_panel3", floor: "sintilesfloor", ceiling: "fap-ceiling03" },
  ],
  bar: [
    { wall: "cyberbar", floor: "sinfloor1", ceiling: "RD_CEILING01" },
    { wall: "sinwall32", floor: "sinfloor1", ceiling: "RD_CEILING01" },
  ],
  clinic: [
    { wall: "wht_wall1", floor: "cds_tilefwhite", ceiling: "fap-ceiling03" },
    { wall: "cds_lab7", floor: "cds_tilefwhite", ceiling: "fap-ceiling03" },
  ],
  office: [
    { wall: "cds_lab4", floor: "mod_labcarpet1a", ceiling: "fap-ceiling03" },
    { wall: "wallvault1", floor: "mod_labcarpet1b", ceiling: "fap-ceiling03" },
  ],
  workshop: [
    { wall: "mo_rustwall1", floor: "grey_creteflr", ceiling: "ceilingpipec" },
    { wall: "po_concretwall", floor: "grey_creteflr2", ceiling: "ceilingpipec" },
  ],
  storage: [{ wall: "po_concretwall", floor: "grey_creteflr2", ceiling: "crete3_ceil03c" }],
  msr: [
    { wall: "stec_panel5b", floor: "gratefloor", ceiling: "wallvault2" },
    { wall: "MJSTWALL04", floor: "MJSTFLOOR01", ceiling: "MJSTFLAT01" },
    { wall: "MJSTLRBLUE", floor: "MJSTFLOOR01", ceiling: "MJSTFLAT03" },
  ],
  cell: [{ wall: "stec_panel3", floor: "vaultfloor", ceiling: "wallvault2" }],
  slum: [
    { wall: "po_rustmetalblu", floor: "po_subtrash", ceiling: "po_concretwall" },
    { wall: "sinbrickwall", floor: "singhettofloor", ceiling: "po_concretwall" },
  ],
};
// each kind's door: a picture of a door as it stands, fitted to the leaf (kit.mjs DOOR_PICTURES); a shop's is a
// rolling shutter that goes up, a bar's a pair of wooden doors, the MSR's its own blast door; only a cell's is bars
// each district's own rooms: the kinds it builds wear its palette (the Mese's marble and gold, the Heights' pale
// marble and wood, the Stacks' brick and concrete, the Bazaar's tile, the Infirmary's white tile and steel, Gate
// Ward's rough concrete, the Foundry's and the Works' rust and grey concrete, the Rookery's brick and tin, the
// undercity's sewer stone); a kind it does not name wears the city's (ROOM_TEX)
const DISTRICT_ROOMS = {
  regal: {
    shop: [{ wall: "sinmarblewall", floor: "marb", ceiling: "sinceiling3" }, { wall: "sinwall32", floor: "sinpalacefloor", ceiling: "sinceiling3" }],
    bar: [{ wall: "sinwoodwallluxu", floor: "sinpalacefloor", ceiling: "sinceiling3" }],
    office: [{ wall: "sinwoodwallluxu", floor: "sinwoodenfloor2", ceiling: "sinceiling3" }],
  },
  heights: {
    flat: [{ wall: "sinwall32", floor: "sinwoodenfloor5", ceiling: "fap-ceiling03" }, { wall: "sinwoodwallluxu", floor: "WOODFLOOR02_256", ceiling: "fap-ceiling03" }],
    shop: [{ wall: "sinwall32", floor: "sinpalacefloor", ceiling: "sinceiling3" }],
    bar: [{ wall: "sinwoodwallluxu", floor: "sinwoodenfloor2", ceiling: "sinceiling3" }],
    office: [{ wall: "sinmarblewall", floor: "marb062", ceiling: "fap-ceiling03" }],
    clinic: [{ wall: "sinmarblewall", floor: "cds_tilefwhite", ceiling: "fap-ceiling03" }],
  },
  stacks: {
    flat: [{ wall: "sinbrickwall", floor: "WOODFLOOR02_256", ceiling: "RD_CEILING01" }, { wall: "howall3b", floor: "WOODFLOOR02_256", ceiling: "RD_CEILING01" }],
    flat_poor: [{ wall: "po_concretwall", floor: "singhettofloor", ceiling: "RD_CEILING01" }, { wall: "singhettowallwo", floor: "singhettofloor", ceiling: "RD_CEILING01" }],
    shop: [{ wall: "po_concretwall", floor: "sintilesfloor", ceiling: "fap-ceiling03" }],
    bar: [{ wall: "sinbrickwall", floor: "sinfloor1", ceiling: "RD_CEILING01" }],
  },
  bazaar: {
    shop: [{ wall: "cyberwall3", floor: "cyberfloor", ceiling: "fap-ceiling03" }, { wall: "stec_panel3", floor: "sintilesfloor", ceiling: "fap-ceiling03" }],
    bar: [{ wall: "cyberbar", floor: "sinfloor1", ceiling: "RD_CEILING01" }],
    flat: [{ wall: "howall3b", floor: "greencarpet", ceiling: "RD_CEILING01" }, { wall: "cd_woodwall", floor: "cd_carpred", ceiling: "fap-ceiling03" }],
  },
  infirmary: {
    flat: [{ wall: "wht_wall1", floor: "cds_tilefgray", ceiling: "fap-ceiling03" }],
    shop: [{ wall: "wht_wall1", floor: "cds_tilefwhite", ceiling: "fap-ceiling03" }],
    office: [{ wall: "cds_lab4", floor: "cds_tilefgray", ceiling: "fap-ceiling03" }],
  },
  gate: {
    flat_poor: [{ wall: "bigcrete2", floor: "singhettofloor", ceiling: "crete3_ceil03c" }],
    storage: [{ wall: "bigcrete2", floor: "Pavement001", ceiling: "crete3_ceil03c" }],
    shop: [{ wall: "bigcrete2", floor: "sintilesplain", ceiling: "fap-ceiling03" }],
    bar: [{ wall: "bigcrete2", floor: "sinfloor1", ceiling: "RD_CEILING01" }],
  },
  foundry: {
    flat_poor: [{ wall: "mo_rustwall1", floor: "singhettofloor", ceiling: "ceilingpipec" }],
    workshop: [{ wall: "mo_rustwall1", floor: "grey_creteflr", ceiling: "ceilingpipec" }],
    storage: [{ wall: "mo_rustwall1", floor: "grey_creteflr", ceiling: "ceilingpipec" }],
    bar: [{ wall: "mo_rustwall1", floor: "sinfloor1", ceiling: "ceilingpipec" }],
  },
  works: {
    flat_poor: [{ wall: "po_concretwall", floor: "singhettofloor", ceiling: "ceilingpipec" }],
    workshop: [{ wall: "po_concretwall", floor: "grey_creteflr2", ceiling: "ceilingpipec" }, { wall: "lab1_paneli", floor: "grey_creteflr", ceiling: "ceilingpipec" }],
    shop: [{ wall: "po_concretwall", floor: "grey_creteflr", ceiling: "fap-ceiling03" }],
  },
  rookery: {
    slum: [{ wall: "po_rustmetalblu", floor: "singhettofloor", ceiling: "po_concretwall" }, { wall: "sinbrickwall", floor: "singhettofloor", ceiling: "po_concretwall" }],
    bar: [{ wall: "sinbrickwall", floor: "singhettofloor", ceiling: "po_concretwall" }],
    shop: [{ wall: "sinbrickwall", floor: "singhettofloor", ceiling: "po_concretwall" }],
  },
  sewer: {
    slum: [{ wall: "po_sewerwall", floor: "po_sewerfloor", ceiling: "po_concretwall" }],
    bar: [{ wall: "po_sewerwall", floor: "singhettofloor", ceiling: "po_concretwall" }],
    storage: [{ wall: "po_sewerwall", floor: "po_sewerfloor", ceiling: "po_concretwall" }],
    workshop: [{ wall: "po_sewerwall", floor: "grey_creteflr", ceiling: "po_concretwall" }],
  },
};
/** A room's pictures: its district's for its kind, or the city's. */
const roomTex = (rng, style, kind) => pick(rng, DISTRICT_ROOMS[style]?.[kind] ?? ROOM_TEX[kind]);
// a shop's or bar's front: the pilasters and the fascia over it, by district
const TRIM = { regal: "sintrim", heights: "sintrim", stacks: "po_concretwall", bazaar: "cyberwall2", infirmary: "wht_wall1", gate: "bigcrete2", foundry: "mo_rustwall1", works: "metal5", rookery: "sinbrickwall", sewer: "po_sewerwall", canal: "bigcrete2" };
const FASCIA = { regal: "singold", heights: "singold" };
const DOOR_TEX = {
  flat: "homedoor1dn", flat_poor: "door006", flat_lux: "cd_wooddoor", shop: "garage03", bar: "cds_wooddoor1",
  clinic: "cds_labdoor1", office: "cds_metaldoor1", workshop: "metaldoor2dn", storage: "o_mtldoor3",
  msr: "MJSTDOOR02", cell: "{grate1", slum: "mo_mtldoor1",
};
// how wide each kind's doorway is: a shutter and a pair of doors take two leaves' width, the MSR's a square
const DOOR_W = { shop: 96, bar: 96, msr: 112 };
const doorWidth = (kind) => DOOR_W[kind] ?? DOOR.w;
const ROOM_LIGHT = {
  flat: [[255, 200, 140], 130], flat_poor: [[255, 170, 110], 85], flat_lux: [[255, 225, 185], 170],
  shop: [[205, 230, 255], 170], bar: [[200, 90, 255], 150], clinic: [[225, 240, 255], 210],
  office: [[215, 228, 255], 165], workshop: [[255, 165, 95], 140], storage: [[200, 200, 210], 75],
  msr: [[170, 115, 255], 175], cell: [[190, 190, 255], 70], slum: [[255, 150, 85], 70],
};
// every shop and bar sign in the cities' wads, with its picture's size in texels, so each sign is cut to its own shape
const SIGNS = {
  "{xc_guns": [256, 128], "{xc_gear": [256, 128], "{xc_skybar": [256, 128], "{xc_enjoy": [256, 128], "{xc_uncle": [128, 64],
  "{PC_BANK": [128, 128], "{PC_PAWNPRAWN": [128, 128], "{PC_SNACK": [128, 128], "{PC_SKYTECH": [128, 128],
  "{PC_GEARGUYS": [128, 128], "{PC_SUB": [128, 128], "{PC_CYB": [128, 128], "{PC_AMOEBA": [128, 128],
  "{PC_AVALON": [128, 128], "{PC_MR": [256, 256], "{PC_PCN": [128, 128], "{PC_UNCLEPIKKY": [128, 128],
  sign_cocktails: [128, 128], sign_coffee1: [256, 256], sign_open: [256, 128], jap_sign2: [256, 128],
  hb_sign_028: [256, 256], cd_sign_cafe: [96, 48],
};
const NEON = [[90, 230, 255], [190, 110, 255], [120, 255, 150], [255, 90, 160], [255, 180, 60]];
// what plays in a bar, each bar the next tune in turn; the keep step below never lets one play twice in earshot
const BAR_MUSIC = [
  "alexandria/waltzfordeb.wav", "alexandria/musicfor.wav", "alexandria/places.wav", "alexandria/asyoucame.wav",
  "alexandria/thedig.wav", "alexandria/gumnaam.wav", "amethyst/ipanemaa.wav", "paradise/olympia.wav",
  "paradise/ksong.wav", "ambience/qk_jazz.wav", "ambience/antro_music_2.wav", "ambience/cg_rstr01.wav",
];
// each district's own sound down its streets, and an alley's; every file loops (GoldSrc's ambient_generic only
// repeats a file with a cue point), and none is Half-Life's own
// a district's own quiet bed down its streets: never a tune (music plays only where a radio stands) and never a
// thing that has to be seen to be heard (a fire's crackle with no fire)
const DISTRICT_SOUNDS = {
  stacks: ["ambience/fortran_city.wav", "paradise/city2.wav"],
  heights: ["paradise/air.wav", "ambience/3dm_grn_bird.wav"],
  bazaar: ["paradise/city2.wav", "ambience/po_city1.wav"],
  infirmary: ["ambience/computer_ambience.wav", "paradise/air.wav"],
  gate: ["ambience/torn_ambience.wav", "paradise/air.wav"],
  foundry: ["paradise/enginermAMB.wav", "paradise/ind1.wav", "alexandria/flarestack_b1.wav"],
  works: ["ambience/3dm_grn_mach.wav", "paradise/ind1.wav"],
  rookery: ["ambience/torn_ambience.wav", "paradise/air.wav"],
};
const ALLEY_SOUNDS = ["ambience/torn_ambience.wav", "paradise/air.wav"];
/** Every file that is a tune, not a place's sound: the source cities play these in their clubs and cafes. */
export const MUSIC = [
  ...BAR_MUSIC, "paradise/darkw.wav", "paradise/newcafe.wav", "ambience/cg_rdmstamb01.wav", "ambience/cg_rdmchowy.wav",
  "ambience/cg_rdmkjun01.wav",
];
// a room's own sound, now and then, quiet and close: a home's murmur, a workshop's machine, a clinic's monitors
const ROOM_SOUNDS = {
  flat: { p: 0.12, volume: 2, files: ["ambience/3dm_grn_hous.wav"] },
  flat_lux: { p: 0.12, volume: 2, files: ["ambience/3dm_grn_hous.wav", "paradise/air.wav"] },
  flat_poor: { p: 0.1, volume: 2, files: ["ambience/torn_ambience.wav"] },
  slum: { p: 0.15, volume: 2, files: ["ambience/torn_ambience.wav"] },
  workshop: { p: 0.25, volume: 3, files: ["paradise/ind1.wav", "ambience/3dm_grn_mach.wav"] },
  clinic: { p: 0.25, volume: 2, files: ["ambience/computer_ambience.wav"] },
  office: { p: 0.15, volume: 2, files: ["paradise/air.wav"] },
  shop: { p: 0.08, volume: 2, files: ["amethyst/erhum.wav"] },
  msr: { p: 0.3, volume: 2, files: ["ambience/computer_ambience.wav"] },
};
// how many of a district's street fronts are blank: a building whose door is not on this street, its windows lit
// or dark. The undercity's mains are mostly sewer wall, with a den here and there
const BLANK = { sewer: 0.3, rookery: 0.12, gate: 0.15, foundry: 0.15, works: 0.12, stacks: 0.08, heights: 0.1, bazaar: 0.06, infirmary: 0.1, regal: 0.05, canal: 0.12 };
/** The middle of a rectangle [x0, y0, x1, y1]. */
const mid2 = ([x0, y0, x1, y1]) => [(x0 + x1) / 2, (y0 + y1) / 2];
/** A copy of `list` in a random order. */
function shuffled(list, rng) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---- the districts --------------------------------------------------------------------------------
const W2 = (list) => list.flatMap(([v, n]) => Array(n).fill(v));
export const STYLES = {
  stacks: { name: "The Stacks", street: { floor: "po_slasphalblgr", wall: "wallvault1", ceiling: "ceilingpipec" }, ground: W2([["shop", 2], ["bar", 1], ["flat_poor", 3], ["flat", 2], ["workshop", 1]]), upper: W2([["flat", 3], ["flat_poor", 4]]), light: [205, 220, 255], alley: 0.3, drop: 0.1, gallery: 0.8, mess: 1.2, doors: 0.8, widths: [192, 224, 256], depths: [224, 288, 352] },
  heights: { name: "Spire Heights", street: { floor: "sintilesfloor", wall: "sinmarblewall", ceiling: "fap-ceiling03" }, ground: W2([["shop", 2], ["bar", 1], ["office", 1], ["clinic", 1], ["flat_lux", 3]]), upper: W2([["flat_lux", 5], ["flat", 2]]), light: [255, 230, 190], alley: 0.1, drop: 0.15, gallery: 0.7, mess: 0.15, doors: 1, widths: [224, 256, 320], depths: [288, 352, 416] },
  bazaar: { name: "The Bazaar", street: { floor: "sintilesplain", wall: "cyberwall2", ceiling: "ceilingpipec" }, ground: W2([["shop", 5], ["bar", 2], ["storage", 1], ["flat", 2]]), upper: W2([["flat", 3], ["flat_poor", 2]]), light: [255, 200, 140], alley: 0.25, drop: 0.05, gallery: 0.7, mess: 1, doors: 0.6, widths: [160, 192, 224], depths: [224, 288] },
  infirmary: { name: "The Infirmary", street: { floor: "cds_tilefgray", wall: "wht_wall1", ceiling: "fap-ceiling03" }, ground: W2([["clinic", 3], ["office", 2], ["shop", 1], ["flat", 2]]), upper: W2([["office", 1], ["clinic", 1], ["flat", 3]]), light: [205, 235, 255], alley: 0.15, drop: 0.1, gallery: 0.6, mess: 0.3, doors: 0.9, widths: [192, 256], depths: [256, 320] },
  gate: { name: "Gate Ward", street: { floor: "Pavement001", wall: "bigcrete2", ceiling: "ceilingpipec" }, ground: W2([["storage", 2], ["shop", 1], ["bar", 1], ["workshop", 1], ["flat_poor", 2]]), upper: W2([["flat_poor", 3]]), light: [255, 190, 120], alley: 0.3, drop: 0.1, gallery: 0.6, mess: 1.4, doors: 0.7, widths: [192, 256, 320], depths: [256, 352, 416] },
  foundry: { name: "The Foundry", street: { floor: "grey_creteflr", wall: "mo_rustwall1", ceiling: "ceilingpipec" }, ground: W2([["workshop", 3], ["storage", 2], ["bar", 1], ["flat_poor", 2]]), upper: W2([["flat_poor", 3]]), light: [255, 150, 90], alley: 0.35, drop: 0.15, gallery: 0.5, mess: 1.8, doors: 0.6, widths: [224, 256, 320], depths: [288, 352, 416] },
  works: { name: "The Works", street: { floor: "grey_creteflr2", wall: "po_concretwall", ceiling: "ceilingpipec" }, ground: W2([["workshop", 3], ["storage", 1], ["shop", 1], ["flat_poor", 2]]), upper: W2([["flat_poor", 3], ["flat", 1]]), light: [185, 255, 175], alley: 0.3, drop: 0.12, gallery: 0.6, mess: 1.5, doors: 0.7, widths: [192, 256], depths: [256, 320, 384] },
  rookery: { name: "The Rookery", street: { floor: "po_slasphalblgr", wall: "sinbrickwall", ceiling: "po_concretwall" }, ground: W2([["slum", 5], ["bar", 1], ["shop", 1]]), upper: W2([["slum", 4], ["flat_poor", 2]]), light: [255, 170, 110], alley: 0.6, drop: 0.2, gallery: 0.5, mess: 2.6, doors: 0.35, widths: [128, 160, 192], depths: [160, 224, 256] },
  regal: { name: "The Mese", street: { floor: "marb", wall: "sinmarblewall", ceiling: "sinceiling3" }, ground: W2([["shop", 3], ["bar", 2], ["office", 1], ["flat_lux", 2]]), upper: W2([["flat_lux", 1]]), light: [255, 225, 190], alley: 0, drop: 0, gallery: 0, mess: 0, doors: 1, widths: [256, 320], depths: [288, 352] },
  sewer: { name: "The Undercity", street: { floor: "po_sewerfloor", wall: "po_sewerwall", ceiling: "po_concretwall" }, ground: W2([["slum", 3], ["bar", 1], ["storage", 1], ["workshop", 1]]), upper: [], light: [150, 220, 140], alley: 0, drop: 0, gallery: 0, mess: 2, doors: 0.3, widths: [160, 224], depths: [192, 256] },
  canal: { name: "The Canals", street: { floor: "pkf_concrete5a", wall: "bigcrete2", ceiling: "sky" }, ground: W2([["storage", 3], ["workshop", 2], ["bar", 1], ["slum", 2]]), upper: [], light: [255, 170, 90], alley: 0, drop: 0, gallery: 0, mess: 2, doors: 0.5, widths: [256, 320, 384], depths: [384, 448, 512] },
};
/** Which district a point of the lower city is in: the 3 x 3 squares round the well. */
export function districtAt(x, y) {
  const col = x < -WELL ? 0 : x > WELL ? 2 : 1;
  const row = y < -WELL ? 0 : y > WELL ? 2 : 1;
  return [["foundry", "gate", "infirmary"], ["works", null, "bazaar"], ["rookery", "stacks", "heights"]][row][col] ?? "stacks";
}

// ---- the builder ---------------------------------------------------------------------------------------
export function buildCity({ seed = 0xb12a, log = () => {} } = {}) {
  const rng = numbers(seed);
  const occ = new Occupancy(512);
  const bag = new Bag();
  const streets = [];
  const roomsMade = { count: 0, doors: 0, byKind: {} };
  /** One more room that is somebody's: a home, a shop, a bar, an office, a workshop, a store. */
  const countRoom = (kind) => {
    roomsMade.count++;
    roomsMade.byKind[kind] = (roomsMade.byKind[kind] ?? 0) + 1;
  };
  // the city's sounds, each with how much it matters: the engine keeps 256 looping at once, so the least are
  // left out when there are more
  const heard = [];
  // `source`: the thing that plays it (a radio, a gramophone), placed only when the sound is kept
  const say = (at, file, volume, radius, rank, source) => heard.push({ at, file, volume, radius, rank, source });
  let barTune = Math.floor(rng() * BAR_MUSIC.length);

  const reserve = (box, kind) => occ.add(box, { kind });
  const space = (name, box, texture) => {
    bag.spaces.push(boxSpace(name, box, texture));
    return box;
  };
  /** A carved space that has to keep a wall from everything else: added only if it does. */
  const spaceIfFree = (name, box, texture, kind = name) => {
    if (!occ.free(box)) return null;
    reserve(box, kind);
    return space(name, box, texture);
  };
  /** A space of any convex outline, labelled with its kind, its box reserved. */
  const addOutline = (name, outline, floor, ceiling, texture, kind) => {
    bag.spaces.push({ name, outline, floor, ceiling, texture, kind });
    const [x0, y0, x1, y1] = boundsOf(outline);
    reserve([x0, y0, floor, x1, y1, ceiling], kind ?? name);
  };
  // an opening is a doorway's or a passage's hole; it is noted, so litter is never dropped in front of it
  const opening = (name, box, texture) => {
    space(name, box, texture);
    occ.add(box, { kind: "door" });
  };
  const clearOfDoors = (b) => !occ.hits(b, 48).some((h) => h.kind === "door");
  const clipBoxes = [];
  // the hidden places: rooms behind secret doors and the passages that wind between them, for the walk test
  const hidden = { backs: 0, places: [] };

  /** A street: its space, its place, and what is built along it later. */
  function addStreet(s) {
    s.axis ??= s.rect[2] - s.rect[0] >= s.rect[3] - s.rect[1] ? "x" : "y";
    s.floor ??= 0;
    s.galleries ??= [];
    const [x0, y0, x1, y1] = s.rect;
    space(s.name, [x0, y0, s.floor, x1, y1, s.ceiling], s.tex ?? STYLES[s.style].street);
    const item = reserve([x0, y0, s.floor, x1, y1, s.ceiling], "street");
    item.tex = s.tex ?? STYLES[s.style].street;
    streets.push(s);
    return s;
  }

  // ======== THE WELL ===================================================================================
  const wellOutline = [
    [-WELL + CHAMFER, -WELL], [WELL - CHAMFER, -WELL], [WELL, -WELL + CHAMFER], [WELL, WELL - CHAMFER],
    [WELL - CHAMFER, WELL], [-WELL + CHAMFER, WELL], [-WELL, WELL - CHAMFER], [-WELL, -WELL + CHAMFER],
  ];
  // the well's open air, in pieces round the Nexus: the podium and the hall are rock, carved from inside (nexus.mjs)
  wellSpaces({ add: (name, outline, floor, ceiling, texture) => bag.spaces.push({ name, outline, floor, ceiling, texture }), wellOutline, Z });
  reserve([-WELL, -WELL, -176, WELL, WELL, Z.wellSky], "well");

  // ======== THE STREETS: avenues, the ring, the outer road, and the grid between ==========================
  const MINOR = [-4480, -3648, 3648, 4480];
  const ALL = [...LINES, ...MINOR].sort((a, b) => a - b);
  const lineKind = (v) => (v === 0 ? "avenue" : Math.abs(v) === 3200 ? "ring" : Math.abs(v) === 4864 ? "outer" : MINOR.includes(v) ? "minor" : "street");
  const HALF = { avenue: 192, ring: 128, outer: 112, street: 112, minor: 64 };
  // each street line sits off its even place by its own amount, so no two blocks are alike
  const OFFSET = {
    x: { "-4096": 64, "-2432": 160, "-1152": -64, 1152: 96, 2432: -128, 4096: -96, "-4480": 32, "-3648": -48, 3648: 48, 4480: -32 },
    y: { "-4096": -96, "-2432": -128, "-1152": 96, 1152: -64, 2432: 160, 4096: 64, "-4480": -32, "-3648": 48, 3648: -48, 4480: 32 },
  };
  const at = (orient, v) => v + (OFFSET[orient][v] ?? 0);
  // the lower city's landmarks keep their plots: no street or alley runs through one
  const PLOTS = [
    [-960, 3520, -384, 4352], [-4544, 3840, -3584, 4416], [3456, -1040, 4672, -256], [-4608, -4608, -3456, -3840],
    [3584, 3904, 4480, 4672],
    ...["n", "e", "s", "w"].flatMap((d) => [fbox(FRAMES[d], [2064, 208, 0, 2576, 592, 0]), fbox(FRAMES[d], [2576, -720, 0, 3040, -208, 0])]).map((b) => [b[0], b[1], b[3], b[4]]),
    ...[[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([sx, sy]) => [Math.min(sx * 3344, sx * 4048), Math.min(sy * 3344, sy * 3808), Math.max(sx * 3344, sx * 4048), Math.max(sy * 3344, sy * 3808)]),
  ];
  const inPlot = (r) => PLOTS.some((p) => r[0] < p[2] + 16 && r[2] > p[0] - 16 && r[1] < p[3] + 16 && r[3] > p[1] - 16);
  for (const orient of ["x", "y"])
    for (const v0 of ALL)
      for (let i = 0; i + 1 < ALL.length; i++) {
        const other = orient === "x" ? "y" : "x";
        const kind0 = lineKind(v0);
        const v = at(orient, v0);
        let a = at(other, ALL[i]);
        let b = at(other, ALL[i + 1]);
        let extA = HALF[lineKind(ALL[i])];
        let extB = HALF[lineKind(ALL[i + 1])];
        // the well: avenues end at its edge, other lines stop short of it
        if (Math.abs(v) < WELL) {
          if (a >= -WELL && b <= WELL) continue;
          if (a < -WELL && b > -WELL) [b, extB] = kind0 === "avenue" ? [-WELL, 0] : [-WELL - 32, 0];
          if (a < WELL && b > WELL) [a, extA] = kind0 === "avenue" ? [WELL, 0] : [WELL + 32, 0];
        }
        const mid = (a + b) / 2;
        const [mx, my] = orient === "x" ? [v, mid] : [mid, v];
        const styleName = districtAt(mx, my);
        const style = STYLES[styleName];
        let kind = kind0;
        if (kind === "street") {
          const r = rng();
          if (r < style.drop) continue;
          if (r < style.drop + style.alley) kind = "alley";
        }
        if (kind === "minor") {
          if (rng() < 0.5) continue;
          kind = "alley";
        }
        const width = { avenue: 384, ring: 256, outer: 224, street: pick(rng, [192, 224]), alley: pick(rng, [112, 128]) }[kind];
        const ceiling = { avenue: Z.avenueTop, ring: Z.ringTop, outer: Z.ringTop, street: Z.streetTop, alley: Z.alleyTop }[kind];
        const galleries = { avenue: [176, 352], ring: [176], outer: [176], street: chance(rng, style.gallery) ? [176] : [], alley: [] }[kind];
        const jitter = kind === "street" || kind === "alley" ? pick(rng, [-32, -16, 0, 16, 32]) : 0;
        const c0 = v + jitter - width / 2;
        const c1 = v + jitter + width / 2;
        const rect = orient === "x" ? [c0, a - extA, c1, b + extB] : [a - extA, c0, b + extB, c1];
        if ((kind === "street" || kind === "alley") && inPlot(rect)) continue;
        const tex = kind === "avenue"
          ? { floor: "sinfuturefloor", wall: "stec_panel5b", ceiling: "ceilingpipec" }
          : kind === "ring" || kind === "outer" ? { floor: "Pavement001", wall: "wallvault2", ceiling: "ceilingpipec" } : undefined;
        addStreet({ name: `${kind}${orient}${v0}_${ALL[i]}`, rect, ceiling, galleries, style: styleName, kind, tex });
      }
  // the four squares where the avenues cross the ring
  for (const d of ["n", "e", "s", "w"]) {
    const box = fbox(FRAMES[d], [3056, -384, 0, 3456, 384, Z.avenueTop]);
    addStreet({ name: `ringplaza_${d}`, rect: [box[0], box[1], box[3], box[4]], ceiling: Z.avenueTop, style: districtAt(...FRAMES[d].p(3200, 0)), kind: "plaza", tex: { floor: "sintilesfloor", wall: "stec_panel5b", ceiling: "ceilingpipec" } });
    const [cx, cy] = FRAMES[d].p(3200, 0);
    bag.detail.push(...column([cx, cy], 40, -8, 400, "marb", "singold"));
    bag.entities.push(lamp([cx, cy, 440], [175, 120, 255], 320));
  }
  log(`  streets: ${streets.length}`);

  // ======== THE MSR: precincts in every district, the ward level, the cores between ======================
  const wardTex = { floor: "MJSTFLOOR01", wall: "MJSTWALL10", ceiling: "MJSTFLAT03" };
  const msrTex = pick(rng, ROOM_TEX.msr);
  const room = (name, box, kind, opts = {}) => {
    const tex = opts.tex ?? pick(rng, ROOM_TEX[kind]);
    const made = opts.force ? (reserve(box, kind), space(name, box, tex)) : spaceIfFree(name, box, tex, kind);
    if (!made) return null;
    countRoom(kind);
    const [x0, y0, z0, x1, y1] = box;
    const [c, b] = ROOM_LIGHT[kind] ?? [[255, 255, 255], 120];
    bag.entities.push(lamp([(x0 + x1) / 2, (y0 + y1) / 2, z0 + ROOM_H - 24], c, b));
    if (opts.furnish !== false) bag.detail.push(...furnish(kind, [x0, y0, x1, y1], z0, opts.doorSide ?? "s", rng));
    return box;
  };
  const doorway = (name, box, tex, doorOpts) => {
    opening(name, box, tex);
    if (doorOpts) {
      bag.entities.push(door(box, doorOpts.tex, doorOpts));
      roomsMade.doors++;
    }
  };

  // ---- the MSR's network: its own door (named, opened by use, for the game to lock), a checkpoint's gate (a
  // portcullis that stands open and drops when a button in the checkpoint is used), a holding cell
  const MSR_DOOR = "MJSTDOOR02";
  const msrDoor = (name, b, tex = MSR_DOOR, wall = msrTex) => {
    opening(name, b, wall);
    bag.entities.push(door(b, tex, { use: true, name }));
  };
  /** A portcullis across a box (bars, see-through), raised `rise` when open; a button at `at` drops and raises it. */
  const portcullis = (name, b, button, buttonFace) => {
    const [x0, y0, z0, x1, y1, z1] = b;
    const leaf = M.box([x0, y0, z0], [x1, y1, z1], "{grate2");
    bag.entities.push(M.brushEntity("func_door", [leaf], { targetname: name, angles: "-90 0 0", speed: 80, wait: -1, lip: 16, spawnflags: 1 + 32, rendermode: 4, renderamt: 255 }));
    const [bx, by, bz] = button;
    const half = 6;
    const bb = { north: [bx - half, by, bz, bx + half, by + 2, bz + 12], south: [bx - half, by - 2, bz, bx + half, by, bz + 12], east: [bx, by - half, bz, bx + 2, by + half, bz + 12], west: [bx - 2, by - half, bz, bx, by + half, bz + 12] }[buttonFace];
    bag.entities.push(M.brushEntity("func_button", [M.box([bb[0], bb[1], bb[2]], [bb[3], bb[4], bb[5]], M.fitted("cd_elevbtn1", [96, 96], [bb[0], bb[1], bb[2]], [bb[3], bb[4], bb[5]], { whole: true, faces: [buttonFace], rest: "metal5" }))], { target: name, spawnflags: 1, wait: 1, speed: 5, lip: 1, angles: "0 0 0" }));
  };
  /** A holding cell's grate door, opened by use. */
  const cellDoor = (name, b) => {
    opening(name, b, ROOM_TEX.cell[0]);
    bag.entities.push(door(b, "{grate1", { mesh: true, use: true, name }));
  };
  /** A booth's counter with glass over it: `b` the counter's box. */
  const counter = (b, alongX) => {
    bag.detail.push(M.box([b[0], b[1], b[2]], [b[3], b[4], b[2] + 44], { top: "tabletops", bottom: "metal5", sides: "MJSTWALL04" }));
    const g = alongX ? [b[0], (b[1] + b[4]) / 2 - 1, b[2] + 44, b[3], (b[1] + b[4]) / 2 + 1, b[2] + 108] : [(b[0] + b[3]) / 2 - 1, b[1], b[2] + 44, (b[0] + b[3]) / 2 + 1, b[4], b[2] + 108];
    bag.entities.push(M.brushEntity("func_wall", [M.box([g[0], g[1], g[2]], [g[3], g[4], g[5]], "glass_dark")], { rendermode: 2, renderamt: 70 }));
  };
  const MSR_LIGHT = [175, 120, 255];
  /**
   * The Mese's checkpoint at the head of the Nexus's bridge (frame d): the guard post in the block on the +v
   * side, its door and window onto the bridgeway, a stair down to the ward ring; a holding cell in the block on
   * the -v side; the portcullis across the bridge's mouth in the well's wall.
   */
  function meseCheckpoint(d) {
    const f = FRAMES[d];
    const B = (b) => fbox(f, b);
    const post = B([1712, 112, Z.mese, 1888, 256, Z.mese + ROOM_H]);
    space(`checkpoint_mese_${d}`, post, msrTex);
    reserve(post, "msr");
    msrDoor(`checkpoint_mese_${d}_door`, B([1776, 96, Z.mese, 1888, 112, Z.mese + DOOR.h]));
    opening(`checkpoint_mese_${d}_window`, B([1712, 96, Z.mese + 48, 1760, 112, Z.mese + 112]), msrTex);
    bag.entities.push(glass(B([1712, 96, Z.mese + 48, 1760, 112, Z.mese + 112]), "glass_dark", 80));
    // the stair down to the ward ring under the Mese
    const shaft = B([1696, 272, Z.ward, 1888, 464, Z.mese + ROOM_H + 32]);
    space(`checkpoint_mese_${d}_stair`, shaft, msrTex);
    reserve(shaft, "msr");
    opening(`checkpoint_mese_${d}_stairdoor`, B([1760, 256, Z.mese, 1816, 272, Z.mese + DOOR.h]), msrTex);
    const [sx, sy] = f.p(1792, 368);
    bag.detail.push(...spiralCore([sx, sy], Z.ward, 2, f.face["-v"], "metal13dn"));
    // its guard's desk and screens, the MSR's mark, its light
    const desk = B([1728, 176, Z.mese, 1872, 208, Z.mese]);
    counter(desk, desk[3] - desk[0] > desk[4] - desk[1]);
    const dr = B([1720, 240, Z.mese + 48, 1800, 248, Z.mese + 96]);
    bag.detail.push(M.box([dr[0], dr[1], dr[2]], [dr[3], dr[4], dr[5]], { top: "metal5", bottom: "metal5", sides: "wht_monitors" }));
    bag.entities.push(lamp([...f.p(1800, 184), Z.mese + 136], MSR_LIGHT, 130));
    bag.entities.push(lamp([...f.p(1792, 368), Z.mese + 140], MSR_LIGHT, 110));
    // the holding cell in the other block, its bars onto the bridgeway
    const cell = B([1712, -256, Z.mese, 1888, -112, Z.mese + 128]);
    space(`checkpoint_mese_${d}_cell`, cell, ROOM_TEX.cell[0]);
    reserve(cell, "msr");
    cellDoor(`cell_mese_${d}`, B([1776, -112, Z.mese, 1824, -96, Z.mese + DOOR.h]));
    bag.entities.push(lamp([...f.p(1800, -184), Z.mese + 100], [190, 190, 255], 60));
    // the gate across the bridge's mouth, its button on the guard post's wall by the window
    const g = B([1676, -96, Z.mese, 1684, 96, Z.mese + ROOM_H]);
    const bp = f.p(1712, 136);
    portcullis(`gate_mese_${d}`, g, [bp[0], bp[1], Z.mese + 64], COMPASS[f.face["+u"]]);
    // its signs on the blocks' ends, facing along the arcade both ways
    for (const [v0, v1, way] of [[480, 482, "+v"], [-482, -480, "-v"]]) {
      const sb = B([1752, v0, Z.mese + 176, 1848, v1, Z.mese + 224]);
      bag.entities.push(M.brushEntity("func_illusionary", [M.box([sb[0], sb[1], sb[2]], [sb[3], sb[4], sb[5]], M.fitted("d_area", [128, 64], [sb[0], sb[1], sb[2]], [sb[3], sb[4], sb[5]], { whole: true, faces: [COMPASS[f.face[way]]], rest: "null" }))]));
    }
    bag.entities.push(lamp([...f.p(1920, 0), Z.mese + 200], MSR_LIGHT, 160));
  }

  // the cardinal precincts, beside each avenue just inside the ring. Each is the street's checkpoint (a lobby,
  // the front desk across it, three holding cells behind), its core a stair from the undercity's checkpoint up
  // through the tunnels and the street to the ward; under the lobby the undercity's checkpoint on the sewer main
  // (a guard post, its door and window onto the main, a holding cell, the portcullis across the main)
  for (const d of ["n", "e", "s", "w"]) {
    const f = FRAMES[d];
    const B = (b) => fbox(f, b);
    const lobby = room(`precinct_${d}_lobby`, B([2576, -720, 0, 2832, -208, ROOM_H]), "msr", { tex: msrTex, force: true, furnish: false });
    bag.detail.push(...furnish("msr", [lobby[0], lobby[1], lobby[3], lobby[4]], 0, f.face["+v"], rng));
    doorway(`precinct_${d}_door`, B([2648, -208, 0, 2760, -192, DOOR.h]), msrTex, { tex: MSR_DOOR });
    bag.entities.push(plate(...(() => { const b = B([2640, -192, 120, 2768, -188, 168]); return [[b[0], b[1], b[2]], [b[3], b[4], b[5]]]; })(), "{ax_detfac"));
    // the front desk across the lobby: the public's side by the street door, the MSR's behind it
    const desk = B([2576, -344, 0, 2768, -320, 0]);
    counter(desk, desk[3] - desk[0] > desk[4] - desk[1]);
    bag.entities.push(door(B([2768, -344, 0, 2832, -320, DOOR.h]), "cds_metaldoor1", { use: true, name: `precinct_${d}_desk` }));
    bag.entities.push(lamp([...f.p(2704, -264), 136], MSR_LIGHT, 140));
    // the core: from the undercity's checkpoint up to the ward, its door behind the desk
    const core = B([2848, -400, Z.sewer, 3040, -208, Z.ward + ROOM_H + 32]);
    reserve(core, "core");
    space(`precinct_${d}_core`, core, msrTex);
    msrDoor(`precinct_${d}_coredoor`, B([2832, -392, 0, 2848, -336, DOOR.h]), "cds_metaldoor1");
    const [ccx, ccy] = f.p(2944, -304);
    bag.detail.push(...spiralCore([ccx, ccy], Z.sewer, 8, f.face["+v"], "metal13dn"));
    for (const z of [-600, -100, 400, 800]) bag.entities.push(lamp([ccx, ccy, z], MSR_LIGHT, 110));
    for (let k = 0; k < 3; k++) {
      const cell = room(`precinct_${d}_cell${k}`, B([2848, -720 + 96 * k, 0, 3040, -640 + 96 * k, ROOM_H]), "cell", { force: true, doorSide: f.face["-u"] });
      if (cell) doorway(`precinct_${d}_celldoor${k}`, B([2832, -704 + 96 * k, 0, 2848, -656 + 96 * k, DOOR.h]), ROOM_TEX.cell[0], { tex: "{grate1", mesh: true, use: true, name: `cell_${d}_${k}` });
    }
    // the undercity's checkpoint under the lobby
    const post = B([2576, -528, Z.sewer, 2832, -224, Z.sewer + ROOM_H]);
    space(`checkpoint_sewer_${d}`, post, msrTex);
    reserve(post, "msr");
    opening(`checkpoint_sewer_${d}_core`, B([2832, -392, Z.sewer, 2848, -336, Z.sewer + DOOR.h]), msrTex);
    msrDoor(`checkpoint_sewer_${d}_door`, B([2672, -224, Z.sewer, 2784, -160, Z.sewer + DOOR.h]));
    reserve(B([2672, -224, Z.sewer, 2784, -160, Z.sewer + DOOR.h]), "door");
    opening(`checkpoint_sewer_${d}_window`, B([2600, -224, Z.sewer + 48, 2648, -160, Z.sewer + 112]), msrTex);
    bag.entities.push(glass(B([2600, -224, Z.sewer + 48, 2648, -160, Z.sewer + 112]), "glass_dark", 80));
    const sdesk = B([2592, -304, Z.sewer, 2784, -280, Z.sewer]);
    counter(sdesk, sdesk[3] - sdesk[0] > sdesk[4] - sdesk[1]);
    const scell = B([2576, -720, Z.sewer, 2720, -544, Z.sewer + 128]);
    space(`checkpoint_sewer_${d}_cell`, scell, ROOM_TEX.cell[0]);
    reserve(scell, "msr");
    cellDoor(`cell_sewer_${d}`, B([2624, -544, Z.sewer, 2672, -528, Z.sewer + DOOR.h]));
    portcullis(`gate_sewer_${d}`, B([2552, -160, Z.sewer, 2560, 160, Z.sewer + 192]), [...f.p(2576, -400), Z.sewer + 64], COMPASS[f.face["+u"]]);
    bag.entities.push(lamp([...f.p(2704, -376), Z.sewer + 136], MSR_LIGHT, 130));
    bag.entities.push(lamp([...f.p(2704, -120), Z.sewer + 140], MSR_LIGHT, 150));
    bag.entities.push(lamp([...f.p(2640, -632), Z.sewer + 100], [190, 190, 255], 60));
    const sg = B([2800, -162, Z.sewer + 48, 2896, -160, Z.sewer + 96]);
    bag.entities.push(M.brushEntity("func_illusionary", [M.box([sg[0], sg[1], sg[2]], [sg[3], sg[4], sg[5]], M.fitted("d_area", [128, 64], [sg[0], sg[1], sg[2]], [sg[3], sg[4], sg[5]], { whole: true, faces: [COMPASS[f.face["+v"]]], rest: "null" }))]));
    // the ward spur from the wing over the avenue to the core
    space(`ward_spur_${d}`, B([2880, -208, Z.ward, 3008, -64, Z.wardTop]), wardTex);
    reserve(B([2880, -208, Z.ward, 3008, -64, Z.wardTop]), "ward");
  }
  // the corner precincts, outside the ring's corners: the same three, their undercity's checkpoint on the ring
  // sewer's corner
  for (const [sx, sy] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) {
    const P = (x0, y0, x1, y1, z0, z1) => [Math.min(sx * x0, sx * x1), Math.min(sy * y0, sy * y1), z0, Math.max(sx * x0, sx * x1), Math.max(sy * y0, sy * y1), z1];
    const tag = `${sx > 0 ? "e" : "w"}${sy > 0 ? "n" : "s"}`;
    const core = P(3344, 3344, 3536, 3536, Z.sewer, Z.ward + ROOM_H + 32);
    reserve(core, "core");
    space(`precinct_${tag}_core`, core, msrTex);
    bag.detail.push(...spiralCore([sx * 3440, sy * 3440], Z.sewer, 8, sy > 0 ? "s" : "n", "metal13dn"));
    for (const z of [-600, -100, 400, 800]) bag.entities.push(lamp([sx * 3440, sy * 3440, z], MSR_LIGHT, 110));
    const lobby = room(`precinct_${tag}_lobby`, P(3552, 3344, 4048, 3600, 0, ROOM_H), "msr", { tex: msrTex, doorSide: sy > 0 ? "s" : "n" });
    if (lobby) {
      doorway(`precinct_${tag}_door`, P(3736, 3328, 3848, 3344, 0, DOOR.h), msrTex, { tex: MSR_DOOR });
      msrDoor(`precinct_${tag}_coredoor`, P(3536, 3472, 3552, 3528, 0, DOOR.h), "cds_metaldoor1");
      const desk = P(3616, 3456, 4048, 3472, 0, 0);
      counter(desk, true);
      bag.entities.push(door(P(3552, 3456, 3616, 3472, 0, DOOR.h), "cds_metaldoor1", { use: true, name: `precinct_${tag}_desk` }));
      for (let k = 0; k < 2; k++) {
        const cell = room(`precinct_${tag}_cell${k}`, P(3552 + 112 * k, 3616, 3648 + 112 * k, 3808, 0, ROOM_H), "cell", { doorSide: sy > 0 ? "s" : "n" });
        if (cell) doorway(`precinct_${tag}_celldoor${k}`, P(3576 + 112 * k, 3600, 3624 + 112 * k, 3616, 0, DOOR.h), ROOM_TEX.cell[0], { tex: "{grate1", mesh: true, use: true, name: `cell_${tag}_${k}` });
      }
      const pb = P(3740, 3326, 3844, 3328, 120, 168);
      bag.entities.push(plate([pb[0], pb[1], pb[2]], [pb[3], pb[4], pb[5]], "{ax_detfac"));
      bag.entities.push(lamp([sx * 3792, sy * 3392, 136], MSR_LIGHT, 140));
    } else opening(`precinct_${tag}_streetdoor`, P(3408, 3328, 3472, 3344, 0, DOOR.h), msrTex);
    // the undercity's checkpoint on the ring sewer's corner, between it and the core
    const post = P(3344, 3072, 3600, 3328, Z.sewer, Z.sewer + ROOM_H);
    space(`checkpoint_sewer_${tag}`, post, msrTex);
    reserve(post, "msr");
    msrDoor(`checkpoint_sewer_${tag}_door`, P(3328, 3136, 3344, 3248, Z.sewer, Z.sewer + DOOR.h));
    opening(`checkpoint_sewer_${tag}_window`, P(3328, 3264, 3344, 3312, Z.sewer + 48, Z.sewer + 112), msrTex);
    bag.entities.push(glass(P(3328, 3264, 3344, 3312, Z.sewer + 48, Z.sewer + 112), "glass_dark", 80));
    opening(`checkpoint_sewer_${tag}_core`, P(3400, 3328, 3456, 3344, Z.sewer, Z.sewer + DOOR.h), msrTex);
    counter(P(3384, 3120, 3408, 3304, Z.sewer, Z.sewer), false);
    const scell = P(3616, 3072, 3744, 3200, Z.sewer, Z.sewer + 128);
    space(`checkpoint_sewer_${tag}_cell`, scell, ROOM_TEX.cell[0]);
    reserve(scell, "msr");
    cellDoor(`cell_sewer_${tag}`, P(3600, 3112, 3616, 3160, Z.sewer, Z.sewer + DOOR.h));
    bag.entities.push(lamp([sx * 3480, sy * 3200, Z.sewer + 136], MSR_LIGHT, 130));
    bag.entities.push(lamp([sx * 3240, sy * 3192, Z.sewer + 140], MSR_LIGHT, 140));
    const sg = P(3326, 3256, 3328, 3320, Z.sewer + 120, Z.sewer + 152);
    bag.entities.push(plate([sg[0], sg[1], sg[2]], [sg[3], sg[4], sg[5]], "d_area"));
    const spur = P(3136, 3200, 3344, 3440, Z.ward, Z.wardTop);
    space(`ward_spur_${tag}`, spur, wardTex);
    reserve(spur, "ward");
  }
  // the ward level: a ring round the well, wings over the avenues, a ring over the ring road
  for (const d of ["n", "e", "s", "w"]) {
    const f = FRAMES[d];
    const ring = fbox(f, [1696, -1888, Z.ward, 1888, 1888, Z.wardTop]);
    space(`ward_ring_${d}`, ring, wardTex);
    reserve(ring, "ward");
    const wing = fbox(f, [1888, -64, Z.ward, 3136, 64, Z.wardTop]);
    space(`ward_wing_${d}`, wing, wardTex);
    reserve(wing, "ward");
    const outer = fbox(f, [3136, -3264, Z.ward, 3264, 3264, Z.wardTop]);
    space(`ward_outer_${d}`, outer, wardTex);
    reserve(outer, "ward");
    // the doorway out onto the bridge across the well, and slits that watch the well
    opening(`ward_bridge_${d}`, fbox(f, [1664, -64, Z.ward, 1696, 64, Z.wardTop]), wardTex);
    for (const v of [-1024, -512, 512, 1024]) {
      const slit = fbox(f, [1664, v - 32, Z.ward + 64, 1696, v + 32, Z.ward + 128]);
      opening(`ward_slit_${d}${v}`, slit, wardTex);
      bag.entities.push(glass(slit, "glass_dark", 90));
    }
    for (let u = 1792; u <= 3136; u += 448) bag.entities.push(lamp([...f.p(u, 0), Z.wardTop - 24], [170, 110, 255], 150));
    for (let v = -3072; v <= 3072; v += 768) bag.entities.push(lamp([...f.p(3200, v), Z.wardTop - 24], [170, 110, 255], 140));
    for (let v = -1536; v <= 1536; v += 768) bag.entities.push(lamp([...f.p(1792, v), Z.wardTop - 24], [170, 110, 255], 140));
  }

  // ======== THE ASCENTS: four stair halls from the undercity through the avenues up to the Mese ============
  /**
   * A grand stair hall's flights: 512 along its street and 384 back from it, a flight a storey high in each of
   * two lanes in turn, switching back at landings that span both lanes at both ends, from `z0` through `count`
   * storeys. `place(a0, b0, z0, a1, b1, z1)` turns a box in the hall's frame (a along the street from its near
   * end, b back from the street) into a world box; `way(sign)` is the world direction of +a (1) or -a (-1).
   */
  const flights = (place, way, z0, count, light, { steps = { top: "marb", bottom: "sinceiling3", sides: "sinmarblewall" }, landing = { top: "marb", bottom: "sinceiling3", sides: "singold" } } = {}) => {
    for (let k = 0; k < count; k++) {
      const laneA = k % 2 === 0;
      const zk = z0 + k * STOREY;
      const sb = place(128, laneA ? 0 : 192, zk, 392, laneA ? 192 : 384, zk + STOREY);
      bag.detail.push(...M.stairs([sb[0], sb[1], sb[2]], [sb[3], sb[4], sb[5]], way(laneA ? 1 : -1), steps, { tread: 24, ramp: "CLIP" }));
      const land = laneA ? place(392, 0, zk + STOREY - 16, 512, 384, zk + STOREY) : place(0, 0, zk + STOREY - 16, 128, 384, zk + STOREY);
      bag.detail.push(M.box([land[0], land[1], land[2]], [land[3], land[4], land[5]], landing));
      const lp = place(256, 192, zk + STOREY + 120, 256, 192, zk + STOREY + 120);
      bag.entities.push(lamp([lp[0], lp[1], lp[2]], light, 180));
    }
  };
  /** A level sign (Xenon City's green LEVEL I, II, III) on a wall: `at` a point on the wall's face, `facing` the way it looks. */
  const levelSign = (level, at, facing, width = 96) => {
    const name = `{xc_level${level}`;
    const h = width / 2;
    const [x, y, z] = at;
    const b = {
      north: [x - width / 2, y + 1, z, x + width / 2, y + 3, z + h], south: [x - width / 2, y - 3, z, x + width / 2, y - 1, z + h],
      east: [x + 1, y - width / 2, z, x + 3, y + width / 2, z + h], west: [x - 3, y - width / 2, z, x - 1, y + width / 2, z + h],
    }[facing];
    const tex = M.fitted(name, [128, 64], [b[0], b[1], b[2]], [b[3], b[4], b[5]], { whole: true, faces: [facing], rest: "null" });
    bag.entities.push(M.brushEntity("func_illusionary", [M.box([b[0], b[1], b[2]], [b[3], b[4], b[5]], tex)], { rendermode: 4, renderamt: 255 }));
  };
  const ASCENT_TEX = { floor: "sintilesfloor", wall: "sinmarblewall", ceiling: "sinceiling3" };
  for (const d of ["n", "e", "s", "w"]) {
    const f = FRAMES[d];
    const B = (b) => fbox(f, b);
    // from the sewer main under the avenue, past the street, to the Mese: ten flights in one hall
    const hall = B([2064, 208, Z.sewer, 2576, 592, Z.mese + ROOM_H]);
    reserve(hall, "ascent");
    space(`ascent_${d}`, hall, ASCENT_TEX);
    // its three ways in: a wide arch from the avenue, one from the sewer main, one onto the Mese
    opening(`ascent_${d}_street`, B([2072, 192, 0, 2184, 208, 144]), ASCENT_TEX);
    opening(`ascent_${d}_sewer`, B([2072, 160, Z.sewer, 2184, 208, Z.sewer + 144]), ASCENT_TEX);
    reserve(B([2072, 160, Z.sewer, 2184, 208, Z.sewer + 144]), "door");
    opening(`ascent_${d}_mese`, B([2048, 272, Z.mese, 2064, 528, Z.mese + ROOM_H]), { floor: "marb", wall: "sinmarblewall", ceiling: "sinceiling3" });
    flights((a0, b0, z0, a1, b1, z1) => B([2064 + a0, 208 + b0, z0, 2064 + a1, 208 + b1, z1]), (sign) => f.dir[sign > 0 ? "+u" : "-u"], Z.sewer, 10, [255, 220, 180]);
    // signed from each level it reaches, and lit at each way in
    const compass = { n: "north", s: "south", e: "east", w: "west" };
    const facing = compass[f.face["-v"]];
    const sp = (u, v, z) => [...f.p(u, v), z];
    levelSign(2, sp(2128, 192, 152), facing);
    levelSign(1, sp(2128, 160, Z.sewer + 152), facing);
    bag.entities.push(lamp(sp(2128, 120, 120), [255, 225, 190], 220));
    bag.entities.push(lamp(sp(2128, 100, Z.sewer + 120), [150, 230, 140], 200));
    levelSign(3, sp(2048, 400, Z.mese + 168), compass[f.face["-u"]]);
    // the ward's checkpoint off the landing at the ward level: from the public stair into the MSR's wing over the
    // avenue, through a guard post, a holding cell at its end
    const wpost = B([2064, 80, Z.ward, 2432, 192, Z.ward + ROOM_H]);
    space(`checkpoint_ward_${d}`, wpost, msrTex);
    reserve(wpost, "msr");
    msrDoor(`checkpoint_ward_${d}_door`, B([2080, 192, Z.ward, 2192, 208, Z.ward + DOOR.h]), MSR_DOOR, ASCENT_TEX);
    msrDoor(`checkpoint_ward_${d}_wing`, B([2240, 64, Z.ward, 2352, 80, Z.ward + DOOR.h]));
    const wdesk = B([2208, 128, Z.ward, 2224, 192, Z.ward]);
    counter(wdesk, wdesk[3] - wdesk[0] > wdesk[4] - wdesk[1]);
    const wcell = B([2448, 80, Z.ward, 2560, 192, Z.ward + 128]);
    space(`checkpoint_ward_${d}_cell`, wcell, ROOM_TEX.cell[0]);
    reserve(wcell, "msr");
    cellDoor(`cell_ward_${d}`, B([2432, 112, Z.ward, 2448, 160, Z.ward + DOOR.h]));
    bag.entities.push(lamp(sp(2300, 136, Z.ward + 136), MSR_LIGHT, 130));
    const wsg = B([2088, 208, Z.ward + 120, 2184, 210, Z.ward + 168]);
    bag.entities.push(M.brushEntity("func_illusionary", [M.box([wsg[0], wsg[1], wsg[2]], [wsg[3], wsg[4], wsg[5]], M.fitted("d_area", [128, 64], [wsg[0], wsg[1], wsg[2]], [wsg[3], wsg[4], wsg[5]], { whole: true, faces: [compass[f.face["+v"]]], rest: "null" }))]));
  }

  // ======== THE UPPER CITY: the Mese and what opens off it ================================================
  const regal = STYLES.regal.street;
  for (const d of ["n", "e", "s", "w"]) {
    const f = FRAMES[d];
    const B = (b) => fbox(f, b);
    // the arcade in three pieces round two blocks of stone at the head of the Nexus's bridge: the MSR's checkpoint
    // stands in them, and the arcade's long run is broken there by them and the way out onto the bridge
    for (const [part, r] of [["a", [1696, -2048, 2048, -480]], ["b", [1696, 480, 2048, 2048]], ["c", [1904, -480, 2048, 480]]]) {
      const side = B([r[0], r[1], Z.mese, r[2], r[3], Z.meseTop]);
      const s = addStreet({ name: `mese_${d}${part}`, rect: [side[0], side[1], side[3], side[4]], floor: Z.mese, ceiling: Z.meseTop, style: "regal", kind: "mese", tex: regal });
      s.frontSide = { n: "hi", e: "hi", s: "lo", w: "lo" }[d]; // the outer side
    }
    const way = B([1696, -96, Z.mese, 1904, 96, Z.meseTop]);
    space(`mese_${d}_bridgeway`, way, regal);
    reserve(way, "street");
    opening(`mese_bridge_${d}`, B([1664, -96, Z.mese, 1696, 96, Z.mese + ROOM_H]), regal);
    for (const v of [-1216, -704, 704, 1216]) opening(`mese_arch_${d}${v}`, B([1664, v - 96, Z.mese + 96, 1696, v + 96, Z.mese + 384]), regal);
    meseCheckpoint(d);
    // the colonnades (not where the blocks stand), the chandeliers, the banners
    for (let v = -1792; v <= 1792; v += 256) {
      if (Math.abs(v) < 160) continue;
      for (const u of [1760, 1984]) if (u > 1904 || Math.abs(v) > 480) bag.detail.push(...column(f.p(u, v), 20, Z.mese, Z.meseTop, "marb", "singold"));
    }
    for (const v of [-1024, 0, 1024]) {
      const [cx, cy] = f.p(1872, v);
      const ch = M.chandelier({ centre: [cx, cy], top: Z.meseTop, drop: 96, radius: 40, tiers: 3, glass: "glass_yellow1", metal: "singold" });
      bag.detail.push(...ch.brushes);
      bag.entities.push(lamp(ch.light, [255, 225, 180], 340));
    }
    // lamps down both colonnades, between the chandeliers, so the arcade is lit end to end
    for (let v = -1792; v <= 1792; v += 512)
      for (const u of [1760, 1984]) bag.entities.push(lamp([...f.p(u, v + 128), Z.mese + 300], [255, 215, 170], 210));
    for (const v of [-512, 512]) {
      const b = B([1868, v - 48, Z.meseTop - 224, 1876, v + 48, Z.meseTop - 32]);
      bag.entities.push(plate([b[0], b[1], b[2]], [b[3], b[4], b[5]], "{ax_msr"));
    }
  }
  // the four ways off the Mese's corners, each to its landmark
  const upper = (name, rect, ceiling = Z.mese + 320) => addStreet({ name, rect, floor: Z.mese, ceiling, style: "regal", kind: "upper", tex: regal });
  upper("palace_row", [2048, 1792, 3264, 1984]).mix = ["flat_lux"];
  upper("ministry_row", [-3264, -1984, -2048, -1792]).mix = ["office", "office", "flat_lux"];
  upper("exchange_way", [-1984, 2048, -1792, 2944]).mix = ["office", "bar", "shop"];
  upper("basilica_way", [1792, -2560, 1984, -2048]).mix = ["shop", "office"];
  // the Basilica: a nave on two colonnades, the crossing domed in three steps
  {
    const nave = [1536, -3456, Z.mese, 2240, -2576, Z.mese + 800];
    reserve(nave, "basilica");
    space("basilica", nave, { floor: "sinpalacefloor", wall: "sinmarblewall", ceiling: "sinceiling3" });
    const oct = (r) => [[r, r * 0.4142], [r * 0.4142, r], [-r * 0.4142, r], [-r, r * 0.4142], [-r, -r * 0.4142], [-r * 0.4142, -r], [r * 0.4142, -r], [r, -r * 0.4142]].map(([x, y]) => [Math.round(1888 + x), Math.round(-3016 + y)]);
    [[304, 0], [224, 96], [144, 192]].forEach(([r, h], k) => bag.spaces.push({ name: `basilica_dome${k}`, outline: oct(r), floor: Z.mese + 700, ceiling: Z.mese + 896 + h, texture: { floor: "sinpalacefloor", wall: "sinceiling3", ceiling: "sinceiling3" } }));
    for (let y = -3392; y <= -2640; y += 128) for (const x of [1664, 2112]) bag.detail.push(...column([x, y], 24, Z.mese, Z.mese + 640, "marb", "singold"));
    for (let y = -3328; y <= -2768; y += 80) for (const x of [1712, 1952]) bag.detail.push(M.box([x, y, Z.mese], [x + 128, y + 24, Z.mese + 20], { top: "wooddark", bottom: "wooddark", sides: "sinfinewood" }));
    bag.detail.push(M.box([1824, -3440, Z.mese], [1952, -3392, Z.mese + 48], { top: "singold", bottom: "singold", sides: "sinmarblewall" }));
    bag.entities.push(plate([1856, -3455, Z.mese + 160], [1920, -3451, Z.mese + 400], "{ax_msr"));
    for (const x of [1552, 2224]) for (const y of [-3200, -2880]) bag.entities.push(plate([x === 1552 ? 1537 : 2235, y - 64, Z.mese + 240], [x === 1552 ? 1541 : 2239, y + 64, Z.mese + 520], "glass_blue1", { rendermode: 2, renderamt: 160 }));
    const ch = M.chandelier({ centre: [1888, -3016], top: Z.mese + 896 + 192, drop: 320, radius: 72, tiers: 4, glass: "glass_yellow1", metal: "singold" });
    bag.detail.push(...ch.brushes);
    bag.entities.push(lamp(ch.light, [255, 220, 170], 420));
    for (const y of [-3300, -2700]) bag.entities.push(lamp([1888, y, Z.mese + 560], [190, 140, 255], 260));
    opening("basilica_door", [1824, -2576, Z.mese, 1952, -2560, Z.mese + 192], regal);
  }
  // the Exchange's banking hall and the Ministry's court
  {
    const bank = spaceIfFree("exchange_hall", [-2240, 2960, Z.mese, -1536, 3584, Z.mese + 384], { floor: "marb062", wall: "sinbankbrick", ceiling: "sinceiling3" }, "hall");
    if (bank) {
      opening("exchange_door", [-1952, 2944, Z.mese, -1824, 2960, Z.mese + 192], regal);
      bag.detail.push(M.box([-2176, 3328, Z.mese], [-1600, 3360, Z.mese + 44], { top: "marb", bottom: "marb", sides: "sinfinewood" }));
      const vault = room("exchange_vault", [-2080, 3600, Z.mese, -1696, 3840, Z.mese + ROOM_H], "storage", { tex: { floor: "vaultfloor", wall: "wallvault1", ceiling: "wallvault2" }, doorSide: "s" });
      if (vault) doorway("exchange_vaultdoor", [-1944, 3584, Z.mese, -1832, 3600, Z.mese + DOOR.h], { floor: "vaultfloor", wall: "wallvault1", ceiling: "wallvault2" }, { tex: "bigcyberdoor" });
      for (const x of [-2080, -1696]) bag.entities.push(lamp([x, 3272, Z.mese + 340], [255, 225, 180], 260));
    }
    const court = spaceIfFree("ministry_court", [-3840, -2240, Z.mese, -3280, -1536, Z.mese + 384], { floor: "sinwoodenfloor2", wall: "sinwoodwallluxu", ceiling: "sinceiling3" }, "hall");
    if (court) {
      opening("ministry_courtdoor", [-3280, -1952, Z.mese, -3264, -1824, Z.mese + 160], regal);
      bag.detail.push(M.box([-3824, -1984, Z.mese], [-3712, -1792, Z.mese + 64], { top: "wooddark", bottom: "wooddark", sides: "sinfinewood" }));
      for (let x = -3616; x <= -3360; x += 64) bag.detail.push(M.box([x, -2176, Z.mese], [x + 32, -1600, Z.mese + 20], { top: "wooddark", bottom: "wooddark", sides: "sinfinewood" }));
      bag.entities.push(plate([-3839, -1952, Z.mese + 128], [-3835, -1824, Z.mese + 320], "{ax_msr"));
      bag.entities.push(lamp([-3560, -1888, Z.mese + 340], [255, 220, 170], 280));
    }
  }

  // ======== THE LANDMARKS OF THE LOWER CITY ===============================================================
  // The Stacks' well: an open shaft of galleried flats, six storeys round a light well
  const stack = { name: "stacks_well", rect: [-960, 3520, -384, 4352], floor: 0, ceiling: Z.courtSky, axis: "y", galleries: [176, 352, 528, 704, 880], style: "stacks", kind: "atrium", tex: { floor: "po_slasphalblgr", wall: "wallvault1", ceiling: "sky" } };
  addStreet(stack).levels = [0, 176, 352, 528, 704, 880];
  stack.both = true;
  opening("stacks_gate", [-384, 3904, 0, -192, 4032, Z.alleyTop], STYLES.stacks.street);
  // the Rookery: an old hall, its roof fallen in, the shacks built inside it
  const rook = addStreet({ name: "rookery_hall", rect: [-4544, 3840, -3584, 4416], ceiling: 768, style: "rookery", kind: "hall", tex: { floor: "po_slasphalblgr", wall: "sinbrickwall", ceiling: "po_concretwall" } });
  bag.spaces.push(boxSpace("rookery_sky", [-4288, 3968, 768, -3840, 4352, Z.courtSky], { floor: "po_slasphalblgr", wall: "sinbrickwall", ceiling: "sky" }));
  reserve([-4288, 3968, 768, -3840, 4352, Z.courtSky], "sky");
  rook.shacks = true;
  opening("rookery_gate_e", [-3584, 3904, 0, -3312, 4032, Z.alleyTop], STYLES.rookery.street);
  // the Bazaar's market hall, stalls in rows under a high roof
  const bazaar = addStreet({ name: "bazaar_hall", rect: [3456, -1040, 4672, -256], ceiling: 528, style: "bazaar", kind: "hall", tex: { floor: "sintilesplain", wall: "cyberwall2", ceiling: "ceilingpipec" } });
  bazaar.stalls = true;
  opening("bazaar_door", [3840, -256, 0, 4096, -192, 352], STYLES.bazaar.street);
  // the Foundry's casting hall
  const foundry = addStreet({ name: "foundry_hall", rect: [-4608, -4608, -3456, -3840], ceiling: 704, style: "foundry", kind: "hall", tex: { floor: "grey_creteflr", wall: "mo_rustwall1", ceiling: "ceilingpipec" } });
  foundry.machines = true;
  opening("foundry_gate", [-3456, -4096, 0, -3328, -3904, Z.alleyTop], STYLES.foundry.street);
  // Spire Heights' garden, open to the sky
  const garden = addStreet({ name: "heights_garden", rect: [3584, 3904, 4480, 4672], ceiling: Z.courtSky, style: "heights", kind: "court", tex: { floor: "cd_grass", wall: "sinmarblewall", ceiling: "sky" } });
  garden.both = true;
  opening("garden_gate", [3328, 4160, 0, 3584, 4288, Z.alleyTop], STYLES.heights.street);
  // courtyards in the outer blocks: light wells with doors onto them
  for (const [cx, cy] of [[-4480, 2816], [4480, -2816], [-2816, -4480], [2816, 4480], [4480, 1664], [-4480, -1664]]) {
    const r = [cx - 224, cy - 224, cx + 224, cy + 224];
    if (!occ.free([r[0], r[1], 0, r[2], r[3], Z.courtSky])) continue;
    const c = addStreet({ name: `court${cx}_${cy}`, rect: r, ceiling: Z.courtSky, style: districtAt(cx, cy), kind: "court", tex: { ...STYLES[districtAt(cx, cy)].street, ceiling: "sky" } });
    c.both = true;
    // a passage out to the nearest street, along whichever way finds one first
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const p = dx ? [dx > 0 ? r[2] : r[0] - 480, cy - 64, dx > 0 ? r[2] + 480 : r[0], cy + 64] : [cx - 64, dy > 0 ? r[3] : r[1] - 480, cx + 64, dy > 0 ? r[3] + 480 : r[1]];
      const hits = occ.hits([p[0], p[1], 0, p[2], p[3], Z.alleyTop], 0).filter((h) => h.kind === "street");
      if (!hits.length) continue;
      // cut the passage back to where it meets the street
      const h = hits[0].box;
      const q = dx > 0 ? [r[2], p[1], h[0] + 8, p[3]] : dx < 0 ? [h[3] - 8, p[1], r[0], p[3]] : dy > 0 ? [p[0], r[3], p[2], h[1] + 8] : [p[0], h[4] - 8, p[2], r[1]];
      if (q[2] - q[0] < 8 || q[3] - q[1] < 8) continue;
      if (!occ.free([q[0], q[1], 0, q[2], q[3], Z.alleyTop], 8)) {
        const others = occ.hits([q[0], q[1], 0, q[2], q[3], Z.alleyTop], 0).filter((o) => o.kind !== "street" && o.box !== c.rect);
        if (others.length) continue;
      }
      space(`court${cx}_${cy}_way`, [q[0], q[1], 0, q[2], q[3], Z.alleyTop], c.tex);
      reserve([q[0], q[1], 0, q[2], q[3], Z.alleyTop], "street");
      break;
    }
  }

  // ======== THE UNDERCITY: sewer mains, the ring sewer, the cistern, the dens =============================
  const sewerTex = STYLES.sewer.street;
  for (const d of ["n", "e", "s", "w"]) {
    const f = FRAMES[d];
    const reach = d === "s" ? 5248 : 4800;
    const main = fbox(f, [1536, -160, Z.sewer, reach, 160, Z.sewerTop]);
    const s = addStreet({ name: `sewer_main_${d}`, rect: [main[0], main[1], main[3], main[4]], floor: Z.sewer, ceiling: Z.sewerTop, style: "sewer", kind: "sewer", tex: sewerTex });
    s.frontage = d !== "s";
    const channel = fbox(f, [1536, -48, Z.canalBed, reach, 48, Z.sewer]);
    space(`sewer_channel_${d}`, channel, sewerTex);
    bag.world.push(M.box([channel[0], channel[1], Z.canalBed], [channel[3], channel[4], Z.canalWater], "!gwater3"));
    // manholes up to the avenue, every 1024
    for (let u = 2304; u < 4700; u += 1024) {
      const mh = fbox(f, [u, 128, Z.sewerTop, u + 64, 192, 0]);
      space(`manhole_${d}${u}`, mh, sewerTex);
      reserve(mh, "manhole");
      bag.entities.push(...shaftLadder([mh[0], mh[1], Z.sewer, mh[3], mh[4], 0], f.face["+v"]));
      bag.entities.push(grate([mh[0], mh[1], -16, mh[3], mh[4], 0]));
    }
    for (let u = 1792; u < reach; u += 512) bag.entities.push(lamp([...f.p(u, 120), Z.sewerTop - 32], [140, 210, 120], 110));
    // the ring sewer under the ring road
    const ring = fbox(f, [3072, -3328, Z.sewer, 3328, 3328, Z.sewerTop]);
    addStreet({ name: `sewer_ring_${d}`, rect: [ring[0], ring[1], ring[3], ring[4]], floor: Z.sewer, ceiling: Z.sewerTop, style: "sewer", kind: "sewer", tex: sewerTex });
    for (let v = -3072; v <= 3072; v += 768) bag.entities.push(lamp([...f.p(3200, v), Z.sewerTop - 32], [150, 215, 130], 100));
    // stairs down from the main into the cistern
    const st = fbox(f, [1184, -128, Z.cistern, 1536, 128, Z.sewer]);
    bag.detail.push(...M.stairs([st[0], st[1], st[2]], [st[3], st[4], st[5]], f.dir["+u"], "po_sewerfloor", { tread: 32, ramp: "CLIP" }));
  }
  // the cistern: vaults on columns over black water
  {
    const cis = [-1536, -1536, Z.cistern, 1536, 1536, Z.sewerTop];
    space("cistern", cis, { floor: "stonewall1", wall: "granite1", ceiling: "stonewall1" });
    reserve(cis, "cistern");
    for (const [a, b] of [[[-1536, -112], [1536, 112]], [[-112, -1536], [112, 1536]]]) {
      space(`cistern_channel${a[0]}`, [a[0], a[1], Z.cisternBed, b[0], b[1], Z.cistern], { floor: "stonewall1", wall: "granite1", ceiling: "stonewall1" });
      bag.world.push(M.box([a[0], a[1], Z.cisternBed], [b[0], b[1], Z.cisternWater], "!gwater3"));
    }
    for (let x = -1344; x <= 1344; x += 384)
      for (let y = -1344; y <= 1344; y += 384) {
        bag.detail.push(...column([x, y], 40, Z.cistern, Z.sewerTop, "granite1", "stonewall1"));
        if ((x + y) % 768 === 0) bag.entities.push(lamp([x + 64, y + 64, Z.cistern + 120], [255, 170, 80], 170));
      }
    for (const [x, y] of [[0, 0], [-768, 768], [768, -768], [768, 768], [-768, -768]]) bag.entities.push(lamp([x, y, Z.sewerTop - 48], [120, 200, 140], 260));
  }
  // two stairwells from the well's floor down into the cistern, between the Nexus's steps and the well's wall,
  // each a spiral in a railed shaft that opens towards the Nexus
  for (const [sx, face] of [[1, "w"], [-1, "e"]]) {
    const [cx, cy] = [sx * 1056, sx * 1056];
    const shaft = [cx - 96, cy - 96, Z.cistern, cx + 96, cy + 96, 0];
    space(`well_stair_${face}`, shaft, { floor: "stonewall1", wall: "granite1", ceiling: "stonewall1" });
    reserve(shaft, "core");
    bag.detail.push(...spiralCore([cx, cy], Z.cistern, Math.round((0 - Z.cistern) / STOREY), face, "metal13dn"));
    // the railing round the opening, left open on the side the stair arrives at
    for (const side of ["n", "s", "e", "w"]) {
      if (side === face) continue;
      const r = side === "n" ? [cx - 96, cy + 92, cx + 96, cy + 96] : side === "s" ? [cx - 96, cy - 96, cx + 96, cy - 92]
        : side === "e" ? [cx + 92, cy - 96, cx + 96, cy + 96] : [cx - 96, cy - 96, cx - 92, cy + 96];
      bag.detail.push(M.box([r[0], r[1], 0], [r[2], r[3], 40], "metal25dn"));
    }
    for (const z of [Z.cistern + 120, -400, -120]) bag.entities.push(lamp([cx, cy, z], [150, 215, 130], 150));
  }

  // ======== THE CANALS beyond the south gate ===============================================================
  const canal = { y0: -8448, y1: -5632, x0: -3584, x1: 3584, water0: -7296, water1: -6656 };
  {
    const quarter = addStreet({ name: "canal_quarter", rect: [canal.x0, canal.y0, canal.x1, canal.y1], ceiling: Z.canalSky, style: "canal", kind: "quarter", tex: { floor: "pkf_concrete5a", wall: "bigcrete2", ceiling: "sky" } });
    quarter.frontSide = "hi";
    space("canal_cut", [canal.x0, canal.water0, -256, canal.x1, canal.water1, 0], { floor: "po_sewerfloor", wall: "po_sewerwall", ceiling: "sky" });
    bag.world.push(M.box([canal.x0, canal.water0, -256], [canal.x1, canal.water1, -96], "!gwater3"));
    // the south gate through the city wall
    space("south_gate", [-192, canal.y1 - 16, 0, 192, -4976 + 8, 352], { floor: "Pavement001", wall: "bigcrete2", ceiling: "ceilingpipec" });
    reserve([-192, canal.y1 - 16, 0, 192, -4976 + 8, 352], "street");
    // the gate: one great MSR door its picture's shape (twice as wide as tall) under a lintel across the tunnel
    bag.detail.push(M.box([-192, -5424, 192], [192, -5376, 352], "bigcrete2"));
    for (const y of [-5480, -5320]) bag.entities.push(lamp([0, y, 180], [255, 200, 150], 160));
    bag.entities.push(M.brushEntity("func_door", [M.box([-192, -5408, 0], [192, -5392, 192], { ...M.fitted("MJSTDOOR03", [256, 128], [-192, -5408, 0], [192, -5392, 192], { whole: true, faces: ["north", "south"], rest: "MJSTTRIM01" }), top: "MJSTTRIM01", bottom: "MJSTTRIM01" })], { angles: "-90 0 0", speed: 90, wait: 6, lip: 16 }));
    // bridges over the canal, the barges moored in it
    for (const x of [-2048, 0, 2048])
      bag.detail.push(...M.bridge({ from: [x, canal.water1], to: [x, canal.water0], z: 0, width: 192, thick: 24, rails: 40, piers: 2, ground: -256, texture: "pkf_concrete5a", railTexture: "metal25dn", pierTexture: "bigcrete2" }));
    for (const x of [-3072, -1024, 1280]) {
      bag.detail.push(M.box([x, -7104, -160], [x + 448, -6848, 8], { top: "po_rustmetalblu", bottom: "po_rustmetalblu", sides: "mo_rustwall1" }));
      bag.detail.push(M.box([x + 304, -7072, 8], [x + 432, -6880, 120], { top: "po_concretwall", bottom: "po_rustmetalblu", sides: "po_rustmetalblu" }));
      bag.detail.push(M.box([x + 32, -7056, 8], [x + 160, -6896, 72], "xcrate10a"));
    }
    // lamps along both quays
    for (let x = canal.x0 + 256; x < canal.x1; x += 640)
      for (const y of [canal.water1 + 48, canal.water0 - 48]) {
        bag.detail.push(M.cylinder("z", [x, y], 6, 0, 256, "metal5", { sides: 8, snap: 1 }));
        bag.detail.push(M.box([x - 16, y - 16, 256], [x + 16, y + 16, 268], { top: "metal5", bottom: "glass_yellow1", sides: "metal5" }));
        bag.entities.push(lamp([x, y, 240], [255, 165, 70], 230));
      }
    // the sewer's outfall: down the shaft from the south main, along the culvert, out under the water
    space("outfall_shaft", [-64, -5376, Z.sewer, 64, -5248, -160], sewerTex);
    reserve([-64, -5376, Z.sewer, 64, -5248, -160], "manhole");
    bag.entities.push(...shaftLadder([-64, -5376, Z.sewer, 64, -5248, -160], "s"));
    space("outfall", [-64, canal.water1, -256, 64, -5376, -128], sewerTex);
    reserve([-64, canal.water1, -256, 64, -5376, -128], "manhole");
    bag.world.push(M.box([-64, canal.water1, -256], [64, canal.water1 + 256, -128], "!gwater3"));
    // the insurgents' pump house and the shanties on the south quay
    bag.add(pumpHouse([-640, -8320], rng));
    for (let k = 0; k < 10; k++) {
      const x = canal.x0 + 384 + k * 640 + within(rng, -96, 96);
      if (Math.abs(x + 160) < 700) continue;
      bag.add(shack([x, within(rng, -8256, -7808)], rng));
    }
    bag.entities.push(M.brushEntity("func_door", [M.box([-256, canal.y0 + 8, 0], [256, canal.y0 + 24, 448], { ...M.fitted("bigcyberdoor", [128, 128], [-256, canal.y0 + 8, 0], [256, canal.y0 + 24, 448], { whole: true, faces: ["north", "south"], rest: "metal5" }), top: "metal5", bottom: "metal5" })], { angles: "-90 0 0", speed: 60, wait: -1, lip: 16, targetname: "outlands_gate" }));
    bag.entities.push(lamp([0, canal.y0 + 96, 300], [255, 180, 120], 200));
  }

  // ======== THE DESCENTS: a stair hall from the ring road down to the ring sewer in each corner district =======
  // Beside the ring road, its near end against the road: a wide arch in from the road at the top, another out
  // into the ring sewer under the road at the bottom, four flights between, lit and signed LEVEL II and LEVEL I.
  const DESCENT_TEX = { floor: "grey_creteflr", wall: "wallvault1", ceiling: "ceilingpipec" };
  for (const [sx, sy] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) {
    let made = null;
    for (const along of ["x", "y"])
      for (const side of [-1, 1])
        for (let a = 1856; a <= 2496 && !made; a += 64) {
          // in the corner's own terms: `a` along the road (|x| for a road along x), `b` back from its edge
          const across = (b) => (side < 0 ? 3056 - b : 3344 + b);
          const place = (a0, b0, z0, a1, b1, z1) => {
            const [p0, p1] = [a + a0, a + a1];
            const [q0, q1] = [across(b0), across(b1)].sort((m, n) => m - n);
            const [xs, ys] = along === "x" ? [[p0, p1], [q0, q1]] : [[q0, q1], [p0, p1]];
            const X = xs.map((v) => v * sx).sort((m, n) => m - n);
            const Y = ys.map((v) => v * sy).sort((m, n) => m - n);
            return [X[0], Y[0], z0, X[1], Y[1], z1];
          };
          const hall = place(0, 0, Z.sewer, 512, 384, 192);
          if (!occ.free(hall)) continue;
          // the road has to be there, in front of the arch
          const road = place(8, -64, 0, 120, -16, 64);
          if (!occ.hits(road, 0).some((h) => h.kind === "street")) continue;
          made = { place, along, side, a };
        }
    if (!made) {
      bag.notes.push(`no room for a descent in the ${sx > 0 ? "e" : "w"}${sy > 0 ? "n" : "s"} corner`);
      continue;
    }
    const { place, along } = made;
    const tag = `${sx > 0 ? "e" : "w"}${sy > 0 ? "n" : "s"}`;
    const hall = place(0, 0, Z.sewer, 512, 384, 192);
    reserve(hall, "descent");
    space(`descent_${tag}`, hall, DESCENT_TEX);
    opening(`descent_${tag}_street`, place(8, -16, 0, 120, 0, 144), DESCENT_TEX);
    opening(`descent_${tag}_sewer`, place(8, -16, Z.sewer, 120, 0, Z.sewer + 144), DESCENT_TEX);
    // +a runs out from the corner's middle along the road
    const plusA = along === "x" ? (sx > 0 ? "+x" : "-x") : sy > 0 ? "+y" : "-y";
    const minusA = { "+x": "-x", "-x": "+x", "+y": "-y", "-y": "+y" }[plusA];
    flights(place, (sign) => (sign > 0 ? plusA : minusA), Z.sewer, 4, [170, 230, 150], { steps: { top: "grey_creteflr", bottom: "ceilingpipec", sides: "bigcrete2" }, landing: { top: "grey_creteflr", bottom: "ceilingpipec", sides: "metal5" } });
    // a rail where the street's landing ends over the lane that falls away below it
    const rail = place(128, 0, 0, 132, 192, 40);
    bag.detail.push(M.box([rail[0], rail[1], rail[2]], [rail[3], rail[4], rail[5]], "metal25dn"));
    // the signs on the road's wall and the sewer's, facing out of the hall, and the lamps over the arches
    const outward = (() => {
      const n = place(64, -16, 0, 64, -16, 0);
      const c = place(64, 192, 0, 64, 192, 0);
      const dx = n[0] - c[0];
      const dy = n[1] - c[1];
      return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "east" : "west") : dy > 0 ? "north" : "south";
    })();
    const face = (b, z) => {
      const p = place(64, b, z, 64, b, z);
      return [p[0], p[1], p[2]];
    };
    levelSign(2, face(-16, 152), outward);
    levelSign(1, face(-16, Z.sewer + 152), outward);
    bag.entities.push(lamp(face(-80, 120), [255, 225, 190], 220));
    bag.entities.push(lamp(face(-80, Z.sewer + 120), [150, 230, 140], 200));
  }

  // ======== ROADS: the avenues, the ring and the outer road carry a carriageway for cars ======================
  // The middle of each, 8 lower than its pavements: a space of its own laid over the street, so the carve drops
  // the floor there and the step at its edge is the kerb. The pavements keep the district's floor.
  const ROAD = { floor: "asphalt04", wall: "pkf_trimpavemen", ceiling: "ceilingpipec" };
  for (const s of streets) {
    const lane = { avenue: 128, ring: 80, outer: 64 }[s.kind];
    if (!lane) continue;
    const [x0, y0, x1, y1] = s.rect;
    const c = s.axis === "x" ? (y0 + y1) / 2 : (x0 + x1) / 2;
    const r = s.axis === "x" ? [x0, c - lane, x1, c + lane] : [c - lane, y0, c + lane, y1];
    bag.spaces.push({ ...boxSpace(`${s.name}_road`, [r[0], r[1], -8, r[2], r[3], 16], ROAD), kind: "road" });
  }

  // ======== HIDDEN PLACES: secret rooms off the Mese, smugglers' dens off the sewers, winding passages =========
  // A secret door is a leaf in the wall's own picture that opens for who uses it; behind it a room, or a passage.
  {
    const free = (b) => occ.free(b);
    // off the Mese's outer wall: a hidden study, a passage winding out and round to a den
    for (const d of ["n", "e", "s", "w"]) {
      const f = FRAMES[d];
      const B = (b) => fbox(f, b);
      for (const v0 of [1400, -1560, 1000, -1160]) {
        const parts = [
          B([2064, v0, Z.mese, 2288, v0 + 160, Z.mese + ROOM_H]),
          B([2304, v0 + 48, Z.mese, 2560, v0 + 112, Z.mese + 128]),
          B([2496, v0 + 128, Z.mese, 2560, v0 + 384, Z.mese + 128]),
          B([2448, v0 + 400, Z.mese, 2656, v0 + 560, Z.mese + ROOM_H]),
        ];
        if (!parts.every(free)) continue;
        const names = ["study", "way", "bend", "den"].map((k) => `hidden_mese_${d}_${k}`);
        parts.forEach((b, k) => {
          space(names[k], b, k === 0 ? { floor: "sinwoodenfloor2", wall: "sinwoodwallluxu", ceiling: "sinceiling3" } : { floor: "singhettofloor", wall: "sinbrickwall", ceiling: "po_concretwall" });
          reserve(b, "hidden");
        });
        opening(`hidden_mese_${d}_j1`, B([2288, v0 + 48, Z.mese, 2304, v0 + 112, Z.mese + DOOR.h]), { floor: "singhettofloor", wall: "sinbrickwall", ceiling: "po_concretwall" });
        opening(`hidden_mese_${d}_j2`, B([2496, v0 + 112, Z.mese, 2560, v0 + 128, Z.mese + DOOR.h]), { floor: "singhettofloor", wall: "sinbrickwall", ceiling: "po_concretwall" });
        opening(`hidden_mese_${d}_j3`, B([2496, v0 + 384, Z.mese, 2560, v0 + 400, Z.mese + DOOR.h]), { floor: "singhettofloor", wall: "sinbrickwall", ceiling: "po_concretwall" });
        const sd = B([2048, v0 + 52, Z.mese, 2064, v0 + 108, Z.mese + DOOR.h]);
        opening(`hidden_mese_${d}_door`, sd, regal);
        bag.entities.push(secretDoor(sd, regal.wall, `secret_mese_${d}`));
        const [sx, sy] = f.p(2176, v0 + 80);
        bag.entities.push(prop("alex-hlru/bookcase", [sx, sy, Z.mese], 0), lamp([sx, sy, Z.mese + 136], [255, 200, 140], 70));
        const [dx, dy] = f.p(2552, v0 + 480);
        bag.entities.push(prop("hammertime/cg_box03", [dx, dy, Z.mese], 30), prop("h9/bed1", [dx - 40, dy + 20, Z.mese], 90), lamp([dx, dy, Z.mese + 136], [255, 170, 100], 60));
        const [wx, wy] = f.p(2528, v0 + 240);
        bag.entities.push(lamp([wx, wy, Z.mese + 100], [255, 160, 90], 35));
        hidden.places.push(names[0], names[3]);
        break;
      }
    }
    // off each sewer main: a smugglers' den behind the sewer's own wall
    for (const d of ["n", "e", "s", "w"]) {
      const f = FRAMES[d];
      const B = (b) => fbox(f, b);
      for (const u0 of [3900, 3700, 4100]) {
        const den = B([u0, 208, Z.sewer, u0 + 224, 432, Z.sewer + ROOM_H]);
        if (!free(den)) continue;
        space(`hidden_sewer_${d}`, den, { floor: "po_sewerfloor", wall: "po_sewerwall", ceiling: "po_concretwall" });
        reserve(den, "hidden");
        const sd = B([u0 + 84, 160, Z.sewer, u0 + 140, 208, Z.sewer + DOOR.h]);
        opening(`hidden_sewer_${d}_door`, sd, STYLES.sewer.street);
        reserve(sd, "door");
        bag.entities.push(secretDoor(B([u0 + 84, 160, Z.sewer, u0 + 140, 176, Z.sewer + DOOR.h]), "po_sewerwall", `secret_sewer_${d}`));
        const [cx, cy] = f.p(u0 + 112, 360);
        bag.entities.push(prop("alex-hlru/f3_crate", [cx, cy, Z.sewer], 0), prop("hammertime/cg_box01", [cx + 60, cy - 60, Z.sewer], 20), prop("CLANKILL3R/GPC_PALLETS", [cx - 60, cy - 80, Z.sewer], 90));
        bag.entities.push(lamp([cx, cy, Z.sewer + 136], [255, 160, 80], 70));
        hidden.places.push(`hidden_sewer_${d}`);
        break;
      }
    }
    // passages through the blocks between two streets, winding round a jog, those between two districts first: the
    // first few behind secret doors at both ends, the rest open
    const PASS = { floor: "singhettofloor", wall: "sinbrickwall", ceiling: "po_concretwall" };
    const candidates = [];
    for (const s of streets.filter((st) => st.floor === 0 && /^(street|alley)$/.test(st.kind))) {
      const [x0, y0, x1, y1] = s.rect;
      const along = s.axis;
      const len = along === "x" ? x1 - x0 : y1 - y0;
      for (const side of [1, -1])
        for (const t of [0.3, 0.5, 0.7]) {
          const edge = along === "x" ? (side > 0 ? y1 : y0) : side > 0 ? x1 : x0;
          const a = (along === "x" ? x0 : y0) + Math.round((len * t) / 16) * 16;
          // the nearest street on the far side, within 1100
          const reach = 1100;
          const probe = along === "x" ? [a - 32, Math.min(edge, edge + side * reach), 0, a + 192, Math.max(edge, edge + side * reach), 128] : [Math.min(edge, edge + side * reach), a - 32, 0, Math.max(edge, edge + side * reach), a + 192, 128];
          const far = occ.hits(probe, 0).filter((h) => h.kind === "street" && h.box[2] === 0 && !(h.box[0] === x0 && h.box[1] === y0 && h.box[3] === x1 && h.box[4] === y1));
          if (!far.length) continue;
          const nearEdge = (b) => (along === "x" ? (side > 0 ? b[1] : b[4]) : side > 0 ? b[0] : b[3]);
          const ahead = far.filter((h) => side * (nearEdge(h.box) - edge) > 0);
          if (!ahead.length) continue;
          const targetItem = ahead.sort((p, q) => Math.abs(nearEdge(p.box) - edge) - Math.abs(nearEdge(q.box) - edge))[0];
          const target = targetItem.box;
          const dist = Math.abs(nearEdge(target) - edge);
          if (dist < 256 || dist > reach) continue;
          // in the passage's own frame: w across it (along the street), t out from the street
          const P = (w0, w1, t0, t1, z1 = 128) => {
            const [m0, m1] = [edge + side * t0, edge + side * t1].sort((p, q) => p - q);
            return along === "x" ? [a + w0, m0, 0, a + w1, m1, z1] : [m0, a + w0, 0, m1, a + w1, z1];
          };
          const midT = Math.round(dist / 2 / 16) * 16;
          const pieces = [P(0, 64, 16, midT), P(0, 160, midT - 64, midT), P(96, 160, midT - 64, dist - 16)];
          const between = districtAt(...mid2(s.rect)) !== districtAt(...mid2([target[0], target[1], target[3], target[4]]));
          candidates.push({ s, targetItem, P, pieces, dist, midT, between });
        }
    }
    candidates.sort((p, q) => (q.between - p.between) || p.dist - q.dist);
    let made = 0;
    for (const c of candidates) {
      if (made >= 12) break;
      const inner = c.pieces.map((b) => [b[0] + 1, b[1] + 1, 0, b[3] - 1, b[4] - 1, 128]);
      if (!inner.every((b) => occ.free(b))) continue;
      const secret = made < 4;
      const name = `${secret ? "hidden" : "cut"}_passage${made}`;
      c.pieces.forEach((b, k) => {
        space(`${name}_${k}`, b, PASS);
        reserve(b, secret ? "hidden" : "street");
      });
      const d0 = c.P(0, 64, 0, 16, DOOR.h);
      const d1 = c.P(96, 160, c.dist - 16, c.dist, DOOR.h);
      opening(`${name}_in`, d0, PASS);
      opening(`${name}_out`, d1, PASS);
      if (secret) {
        bag.entities.push(secretDoor(d0, (c.s.tex ?? STYLES[c.s.style].street).wall, `secret_passage${made}_in`));
        bag.entities.push(secretDoor(d1, c.targetItem.tex?.wall ?? "sinbrickwall", `secret_passage${made}_out`));
        hidden.places.push(`${name}_1`);
      }
      const mp = c.P(0, 160, c.midT - 64, c.midT);
      bag.entities.push(lamp([(mp[0] + mp[3]) / 2, (mp[1] + mp[4]) / 2, 108], [255, 170, 100], 50));
      made++;
    }
    hidden.passages = made;

  }

  // ======== STAIRS UP TO THE GALLERIES =====================================================================
  for (const s of streets) {
    if (!s.galleries.length || s.kind === "mese") continue;
    const [x0, y0, x1, y1] = s.rect;
    const len = s.axis === "x" ? x1 - x0 : y1 - y0;
    if (len < 640) continue;
    for (const side of s.both || s.kind === "avenue" ? ["lo", "hi"] : [pick(rng, ["lo", "hi"])]) {
      const top = s.galleries[s.galleries.length - 1];
      // a ramp tower: 160 along the street, 416 deep, its near end a wall back from the street
      const away = side === "lo" ? -1 : 1;
      const near = side === "lo" ? (s.axis === "x" ? y0 : x0) - WALL : (s.axis === "x" ? y1 : x1) + WALL;
      for (let tries = 0; tries < 8; tries++) {
        const u = snap((s.axis === "x" ? x0 : y0) + 160 + rng() * (len - 480), 16);
        const place = (d0, a0, z0, d1, a1, z1) => {
          const [c0, c1] = [near + away * d0, near + away * d1].sort((p, q) => p - q);
          return s.axis === "x" ? [u + a0, c0, z0, u + a1, c1, z1] : [c0, u + a0, z0, c1, u + a1, z1];
        };
        const deeper = (sign) => (s.axis === "x" ? (away * sign > 0 ? "+y" : "-y") : away * sign > 0 ? "+x" : "-x");
        const shaft = place(0, 0, s.floor, 416, 160, s.floor + top + ROOM_H);
        if (!occ.free(shaft)) continue;
        reserve(shaft, "core");
        const coreTex = { floor: "grey_creteflr2", wall: "po_concretwall", ceiling: "crete3_ceil03c" };
        space(`${s.name}_ramp${side}`, shaft, coreTex);
        for (const lvl of [0, ...s.galleries]) opening(`${s.name}_ramp${side}${lvl}`, place(-WALL, 48, s.floor + lvl, 0, 112, s.floor + lvl + DOOR.h), coreTex);
        bag.detail.push(...rampCore(place, deeper, s.floor, s.galleries.length));
        const mid = place(200, 80, 0, 216, 80, 0);
        bag.entities.push(lamp([(mid[0] + mid[3]) / 2, (mid[1] + mid[4]) / 2, s.floor + top + ROOM_H - 32], [220, 220, 200], 120));
        break;
      }
    }
  }

  // ======== THE FRONTAGES: rooms along every street, stacked a storey over another ========================
  for (const s of streets) {
    if (s.kind === "hall" || s.frontage === false) continue;
    const style = STYLES[s.style];
    const levels = (s.levels ?? [0, ...s.galleries]).map((lvl) => s.floor + lvl);
    const ground = s.mix ?? style.ground;
    const upperMix = s.mix ?? style.upper;
    for (const side of s.frontSide ? [s.frontSide] : ["lo", "hi"]) frontage(s, s.axis, side, levels, ground, upperMix, style);
    if (s.both) for (const side of ["lo", "hi"]) frontage(s, s.axis === "x" ? "y" : "x", side, levels, ground, upperMix, style);
  }
  bag.notes.push(`hidden: ${hidden.backs} back rooms behind secret doors, ${hidden.places.length} hidden places in all; ${hidden.passages} passages through blocks`);
  log(`  rooms: ${roomsMade.count} (${Object.entries(roomsMade.byKind).map(([k, n]) => `${k} ${n}`).join(", ")}), doors: ${roomsMade.doors}`);

  /**
   * Units along one side of a street: each a footprint a wall back from the street, its rooms stacked a
   * storey over another as high as the street has floors to reach them (the street itself, then its
   * galleries). Each room is a space that runs up to the one over it, the floor between them a slab worn on
   * both faces; each has its doorway (and a door), a glass front beside it when it is wide, its things and
   * its light, and now and then a room behind it.
   */
  function frontage(s, axis, side, levels, groundMix, upperMix, style) {
    if (!groundMix?.length) return;
    const [x0, y0, x1, y1] = s.rect;
    const start = axis === "x" ? x0 : y0;
    const end = axis === "x" ? x1 : y1;
    const edge = axis === "x" ? (side === "lo" ? y0 : y1) : side === "lo" ? x0 : x1;
    const out = side === "lo" ? -1 : 1;
    const doorSide = axis === "x" ? (side === "lo" ? "n" : "s") : side === "lo" ? "e" : "w";
    const backSide = { n: "s", s: "n", e: "w", w: "e" }[doorSide];
    /** A plan rectangle [a0, b0, a1, b1] (a along the street, b across it) as a box at height z0..z1. */
    const at = (a0, a1, b0, b1, z0, z1) => (axis === "x" ? [a0, b0, z0, a1, b1, z1] : [b0, a0, z0, b1, a1, z1]);
    const across = (d) => (out < 0 ? [edge - WALL - d, edge - WALL] : [edge + WALL, edge + WALL + d]);
    // a street under the upper city, overhung by galleries, an alley or a sewer: its doors get a lamp of their own
    const shaded = s.kind === "alley" || s.style === "sewer" || s.galleries.length > 0 ||
      (Math.min(Math.abs(x0), Math.abs(x1)) < 2112 && Math.min(Math.abs(y0), Math.abs(y1)) < 2112);
    let u = start + 32;
    while (u < end - 128) {
      // what stands at the street decides the width: a shop or a bar two bays wide, a home one
      const groundKind = pick(rng, groundMix);
      const wide2 = groundKind === "shop" || groundKind === "bar";
      const w = snap(pick(rng, style.widths) * (wide2 ? 1.5 : 1), 16);
      const a1 = Math.min(u + w, end - 16);
      if (a1 - u < 128) break;
      // the deepest footprint that is free at the street's own level
      let depth = 0;
      const deep = [...style.depths].sort((a, b) => b - a);
      for (const d of deep.slice(Math.floor(rng() * deep.length))) {
        const [b0, b1] = across(d);
        if (occ.free(at(u, a1, b0, b1, levels[0], levels[0] + ROOM_H))) {
          depth = d;
          break;
        }
      }
      if (!depth) {
        u += 64;
        continue;
      }
      const [b0, b1] = across(depth);
      // as many storeys as stay free
      let n = 1;
      while (n < levels.length && occ.free(at(u, a1, b0, b1, levels[n], levels[n] + ROOM_H))) n++;
      const zTop = levels[n - 1] + ROOM_H;
      reserve(at(u, a1, b0, b1, levels[0], zTop), "unit");
      /** A depth range out from the wall's street face into the street. */
      const proud = (d0, d1) => (out < 0 ? [edge + d0, edge + d1] : [edge - d1, edge - d0]);
      const P = (a, n, z) => (axis === "x" ? [a, n, z] : [n, a, z]);
      const streetFace = { n: "north", s: "south", e: "east", w: "west" }[doorSide];
      /** A window on the wall's face at a storey: a pane lit or dark, `w0..w1` along the street. */
      const pane = (w0, w1, z, litChance) => {
        if (w1 - w0 < 48) return;
        const wb = at(w0, w1, ...proud(0, 2), z + 48, z + 128);
        bag.detail.push(M.box([wb[0], wb[1], wb[2]], [wb[3], wb[4], wb[5]], { top: "metal5", bottom: "metal5", sides: "metal5", [streetFace]: chance(rng, litChance) ? "glass_yellow1" : "glass_dark" }));
      };
      // a blank front: the building is there, its windows lit or dark, but nobody's door is on this street
      if (chance(rng, BLANK[s.style === "sewer" ? "sewer" : s.style] ?? 0.2)) {
        if (s.style !== "sewer") for (let i = 0; i < n; i++) for (let a = u + 32; a + 96 <= a1 - 16; a += 160) pane(a, a + 96, levels[i], 0.3);
        u = a1 + WALL;
        continue;
      }
      const du = snap(u + 32 + rng() * Math.max(0, a1 - u - 64 - 112), 16);
      const [g0, g1] = out < 0 ? [edge - WALL, edge] : [edge, edge + WALL];
      // a room behind, the same storeys high, for a flat's bedroom or a shop's store: part of the same home or
      // shop, through an inner doorway
      const d2 = pick(rng, [160, 192, 224]);
      const [c0, c1] = out < 0 ? [b0 - WALL - d2, b0 - WALL] : [b1 + WALL, b1 + WALL + d2];
      const backBox = at(u, a1, c0, c1, levels[0], zTop);
      const withBack = chance(rng, 0.2) && occ.free(backBox);
      if (withBack) reserve(backBox, "unit");
      const kinds = [];
      const slabs = [];
      for (let i = 0; i < n; i++) {
        const z = levels[i];
        // above the street's own level most storeys are homes; now and then one is a shut front with a window,
        // so a gallery passes homes and blank walls in turn
        if (i > 0 && !chance(rng, 0.8)) {
          kinds.push(kinds[kinds.length - 1]);
          pane(u + 32, Math.min(u + 128, a1 - 32), z, 0.35);
          continue;
        }
        const kind = i === 0 ? groundKind : pick(rng, upperMix?.length ? upperMix : groundMix);
        const tex = roomTex(rng, s.style, kind);
        kinds.push({ kind, tex });
        const roof = i + 1 < n ? levels[i + 1] : z + ROOM_H;
        space(`${s.name}_${side}${u}_${i}`, at(u, a1, b0, b1, z, roof), tex);
        countRoom(kind);
        const dw = Math.max(DOOR.w, Math.min(doorWidth(kind), a1 - 32 - du));
        const doorBox = at(du, du + dw, g0, g1, z, z + DOOR.h);
        doorway(`${s.name}_${side}${u}_${i}d`, doorBox, tex, { tex: DOOR_TEX[kind], up: kind === "shop", mesh: DOOR_TEX[kind].startsWith("{") });
        if (i === 0) {
          // a lamp over the door, outside, so no door is a black hole: brighter in the shade of the upper city,
          // under a gallery, in an alley or a sewer
          const [o0] = proud(40, 40);
          bag.entities.push(lamp(P(du + dw / 2, o0, z + DOOR.h + 20), [255, 210, 160], shaded ? 60 : 40));
        }
        // the front. A shop or a bar at the street: its goods (or its bottles) behind display glass beside the
        // door, a frame of pilasters, a fascia over it all, an awning where no gallery overhangs it. Up the
        // galleries, a flat's or an office's window, lit or dark. The glass is a face on the wall, not a hole in it.
        const [gl0, gl1] = du - u > (a1 - u) / 2 ? [u + 24, du - 16] : [du + dw + 16, a1 - 24];
        const wide = Math.min(gl1 - gl0, 256);
        const front = (kind === "shop" || kind === "bar") && i === 0;
        if (front) {
          const trim = TRIM[s.style] ?? "d_drkmtl_mpanel";
          if (wide >= 48) {
            const goods = kind === "bar" ? "sinbar2" : pick(rng, ["gp_shelf1", "gp_shelf2", "gp_fridgebeer"]);
            const gb = at(gl0, gl0 + wide, ...proud(0, 2), z + 16, z + 128);
            bag.detail.push(M.box([gb[0], gb[1], gb[2]], [gb[3], gb[4], gb[5]], { top: "metal5", bottom: "metal5", sides: "metal5", [streetFace]: goods }));
          }
          for (const [p0, p1] of [[u, u + 16], [a1 - 16, a1]]) {
            const pb = at(p0, p1, ...proud(0, 8), z, z + ROOM_H);
            bag.detail.push(M.box([pb[0], pb[1], pb[2]], [pb[3], pb[4], pb[5]], trim));
          }
          const fb = at(u, a1, ...proud(0, 6), z + 128, z + ROOM_H);
          bag.detail.push(M.box([fb[0], fb[1], fb[2]], [fb[3], fb[4], fb[5]], FASCIA[s.style] ?? trim));
          if (!s.galleries.length && s.kind !== "mese" && wide >= 48) {
            const [n0] = proud(6, 6);
            const [, n1] = proud(0, 56);
            const zt = z + 124;
            const pts = [];
            for (const a of [gl0 - 8, gl0 + wide + 8]) pts.push(P(a, n0, zt), P(a, n0, zt - 4), P(a, n1, zt - 26), P(a, n1, zt - 30));
            bag.detail.push(M.solid(pts, pick(rng, ["redcarpet", "hocouch3", "sinrug"])));
          }
        } else if (/^(flat|flat_lux|flat_poor|office|clinic|slum)$/.test(kind) && wide >= 48 && chance(rng, 0.7)) {
          pane(gl0, gl0 + Math.min(wide, 96), z, kind === "flat_poor" || kind === "slum" ? 0.4 : 0.65);
        }
        const inner = axis === "x" ? [u, b0, a1, b1] : [b0, u, b1, a1];
        bag.detail.push(...furnish(kind, inner, z, doorSide, rng));
        bag.entities.push(...furnishProps(kind, inner, z, doorSide, rng));
        const [c, b] = ROOM_LIGHT[kind];
        bag.entities.push(lamp([(inner[0] + inner[2]) / 2, (inner[1] + inner[3]) / 2, z + ROOM_H - 24], c, b));
        // the floor over it, when another room stands on it
        if (i + 1 < n) {
          const next = levels[i + 1];
          const sl = at(u, a1, b0, b1, z + ROOM_H, next);
          slabs.push(M.box([sl[0], sl[1], sl[2]], [sl[3], sl[4], sl[5]], { top: "__next__", bottom: tex.ceiling, sides: tex.wall }));
        }
        if (withBack) {
          const kind2 = kind.startsWith("flat") || kind === "slum" ? kind : "storage";
          const tex2 = kind2 === kind ? tex : roomTex(rng, s.style, kind2);
          space(`${s.name}_${side}${u}_${i}b`, at(u, a1, c0, c1, z, roof), tex2);
          const [h0, h1] = out < 0 ? [b0 - WALL, b0] : [b1, b1 + WALL];
          // the inner doorway: the back room is the same home's or shop's, not a property of its own; in a few,
          // a secret door in the wall's own picture hides it, found only by who tries the wall
          const ib = Math.min(du, a1 - 32 - DOOR.w);
          const inner2Door = at(ib, ib + DOOR.w, h0, h1, z, z + DOOR.h);
          opening(`${s.name}_${side}${u}_${i}bd`, inner2Door, tex);
          if (hidden.backs < 8 && /^(flat|flat_lux|flat_poor|shop|bar|slum)$/.test(kind) && chance(rng, 0.1)) {
            bag.entities.push(secretDoor(inner2Door, tex.wall, `secret_back_${hidden.backs++}`));
            hidden.places.push(`${s.name}_${side}${u}_${i}b`);
          }
          const inner2 = axis === "x" ? [u, c0, a1, c1] : [c0, u, c1, a1];
          bag.detail.push(...furnish(kind2, inner2, z, doorSide, rng));
          bag.entities.push(...furnishProps(kind2, inner2, z, doorSide, rng));
          const [cc, bb] = ROOM_LIGHT[kind2];
          bag.entities.push(lamp([(inner2[0] + inner2[2]) / 2, (inner2[1] + inner2[3]) / 2, z + ROOM_H - 24], cc, bb * 0.8));
          if (i + 1 < n) {
            const sl = at(u, a1, c0, c1, z + ROOM_H, levels[i + 1]);
            slabs.push(M.box([sl[0], sl[1], sl[2]], [sl[3], sl[4], sl[5]], { top: "__next2__", bottom: tex2.ceiling, sides: tex2.wall }));
          }
          kinds[i].tex2 = tex2;
        }
        // a shop's or a bar's sign: a blade standing out from the wall beside its door, read from along the street,
        // cut to its picture's shape and readable both ways. Each street deals its signs from its own shuffled
        // deck, so none repeats along it, and some fronts go without one.
        if ((kind === "shop" || kind === "bar") && i === 0 && s.kind !== "mese" && chance(rng, 0.6)) {
          s.signDeck ??= shuffled(Object.keys(SIGNS), rng);
          const sign = s.signDeck.pop();
          if (sign) {
            const [tw, th] = SIGNS[sign];
            const len = Math.min(96, Math.round((56 * tw) / th));
            const high = Math.round((len * th) / tw);
            const [n0, n1] = out < 0 ? [edge + 8, edge + 8 + len] : [edge - 8 - len, edge - 8];
            const sb = at(du - 12, du - 8, n0, n1, z + 96, z + 96 + high);
            bag.entities.push(bladeSign(sb, axis, sign, [tw, th]));
            const off = out < 0 ? 40 : -40;
            bag.entities.push(lamp(axis === "x" ? [du + 32, edge + off, z + 136] : [edge + off, du + 32, z + 136], pick(rng, NEON), 150));
          }
        }
        // a bar's music: a radio or a gramophone on its counter at the back wall, playing quietly, heard in the bar
        // and at its door, not down the street
        if (kind === "bar" && i === 0 && chance(rng, 0.45)) {
          const [ix0, iy0, ix1, iy1] = inner;
          const spot = { n: [(ix0 + ix1) / 2, iy1 - 20, 270], s: [(ix0 + ix1) / 2, iy0 + 20, 90], e: [ix1 - 20, (iy0 + iy1) / 2, 180], w: [ix0 + 20, (iy0 + iy1) / 2, 0] }[backSide];
          const set = [spot[0], spot[1], z + 44];
          say([set[0], set[1], z + 64], BAR_MUSIC[barTune++ % BAR_MUSIC.length], 3, "small", 3, prop(pick(rng, ["hammertime/cg_radio01", "h9/grammo"]), set, spot[2]));
        }
        // a room's own sound, only in a room big enough to keep it in
        const rs = ROOM_SOUNDS[kind];
        if (rs && a1 - u >= 256 && depth >= 256 && chance(rng, rs.p)) {
          const c = axis === "x" ? [(u + a1) / 2, (b0 + b1) / 2] : [(b0 + b1) / 2, (u + a1) / 2];
          say([c[0], c[1], z + 64], pick(rng, rs.files), rs.volume, "small", 4);
        }
      }
      // each slab's top wears the floor of the room that stands on it; the slabs are detail, so a room and the
      // one over it are one column to the compiler, as the carve already made them
      for (const brush of slabs)
        for (const face of brush.faces) {
          if (face.texture !== "__next__" && face.texture !== "__next2__") continue;
          const lvl = levels.findIndex((z) => Math.abs(z - face.points[0][2]) < 1);
          const k = kinds[lvl] ?? kinds[kinds.length - 1];
          face.texture = face.texture === "__next__" ? k.tex.floor : (k.tex2 ?? k.tex).floor;
        }
      bag.detail.push(...slabs);
      u = a1 + WALL;
    }
  }

  // ======== WHAT STANDS IN THE STREETS: galleries, lamps, litter, stalls, machines, shacks ==================
  for (const s of streets) {
    const [x0, y0, x1, y1] = s.rect;
    const style = STYLES[s.style];
    const top = s.ceiling;
    // the galleries' walkways along both walls, at every gallery level. A street walked on all four sides keeps
    // its y walkways between the x ones, so no corner is doubled; and where another street crosses a walkway at
    // its height, the walkway stops at that street's edge and starts again past it, never running through it
    if (s.kind !== "mese") {
      for (const g of s.galleries) {
        const z = s.floor + g;
        const runs = s.both
          ? [["x", "lo"], ["x", "hi"], ["y", "lo"], ["y", "hi"]]
          : [[s.axis, "lo"], [s.axis, "hi"]];
        for (const [ax, side] of runs) {
          const [a0, a1] = ax === "x" ? [x0, x1] : s.both ? [y0 + 64, y1 - 64] : [y0, y1];
          const band = ax === "x" ? (side === "lo" ? [y0, y0 + 64] : [y1 - 64, y1]) : side === "lo" ? [x0, x0 + 64] : [x1 - 64, x1];
          const cuts = [];
          for (const o of streets) {
            if (o === s || z < o.floor || z > o.ceiling) continue;
            const [ox0, oy0, ox1, oy1] = o.rect;
            const [b0, b1, c0, c1] = ax === "x" ? [oy0, oy1, ox0, ox1] : [ox0, ox1, oy0, oy1];
            if (b1 <= band[0] || b0 >= band[1] || c1 <= a0 || c0 >= a1) continue;
            cuts.push([Math.max(c0, a0), Math.min(c1, a1)]);
          }
          cuts.sort((p, q) => p[0] - q[0]);
          const pieces = [];
          let from = a0;
          for (const [c0, c1] of cuts) {
            if (c0 > from) pieces.push([from, c0]);
            from = Math.max(from, c1);
          }
          if (a1 > from) pieces.push([from, a1]);
          for (const [p0, p1] of pieces) {
            if (p1 - p0 < 64) continue;
            const wb = ax === "x" ? [p0, band[0], z - 16, p1, band[1], z] : [band[0], p0, z - 16, band[1], p1, z];
            bag.detail.push(M.box([wb[0], wb[1], wb[2]], [wb[3], wb[4], wb[5]], { top: "sinfuturefloor", bottom: "metal5", sides: "metal5" }));
            const rb = ax === "x"
              ? side === "lo" ? [p0, y0 + 60, z, p1, y0 + 64, z + 40] : [p0, y1 - 64, z, p1, y1 - 60, z + 40]
              : side === "lo" ? [x0 + 60, p0, z, x0 + 64, p1, z + 40] : [x1 - 64, p0, z, x1 - 60, p1, z + 40];
            bag.detail.push(M.box([rb[0], rb[1], rb[2]], [rb[3], rb[4], rb[5]], "metal25dn"));
          }
        }
      }
    }
    // the street's lamps down its middle
    if (s.kind !== "mese" && s.kind !== "quarter" && s.kind !== "court") {
      const n = Math.max(1, Math.floor((s.axis === "x" ? x1 - x0 : y1 - y0) / 448));
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n;
        const [lx, ly] = s.axis === "x" ? [x0 + (x1 - x0) * t, (y0 + y1) / 2] : [(x0 + x1) / 2, y0 + (y1 - y0) * t];
        const lz = Math.min(top, s.floor + 640) - 40;
        const colour = s.kind === "avenue" ? [180, 130, 255] : s.style === "sewer" ? [140, 210, 120] : style.light;
        bag.entities.push(lamp([lx, ly, lz], colour, s.kind === "avenue" ? 240 : 190));
        // its fitting on the ceiling, where there is a ceiling over it (not where a taller street crosses)
        const fx = snap(lx, 4);
        const fy = snap(ly, 4);
        const over = occ.hits([fx - 24, fy - 8, top + 1, fx + 24, fy + 8, top + 8], 0).filter((h) => h.box !== s.box);
        if (top - s.floor < 900 && !over.length) bag.detail.push(M.box([fx - 24, fy - 8, top - 6], [fx + 24, fy + 8, top], s.kind === "avenue" ? "CeilingLightBlu" : "holight7"));
      }
    }
    const len = s.axis === "x" ? x1 - x0 : y1 - y0;
    if (s.stalls) bag.add(stalls(s, rng));
    if (s.machines) bag.add(machines(s, rng));
    if (s.shacks) for (let k = 0; k < 7; k++) bag.add(shack([within(rng, x0 + 160, x1 - 320), within(rng, y0 + 160, y1 - 288)], rng));
    if (s.kind === "court" && s.style === "heights") {
      for (const [cx, cy] of [[3808, 4128], [4256, 4448], [4032, 4288]]) bag.detail.push(M.cylinder("z", [cx, cy], 96, 0, 24, { top: "cd_grass", bottom: "stonewall1", sides: "sinmarblewall" }, { sides: 12, snap: 1 }));
      bag.detail.push(...column([4032, 4288], 24, 24, 256, "sinmarblewall", "singold"));
    }
    // litter: the source cities' own models (bins and bags, scraps, boxes, pallets, a dumpster now and then)
    // along the walls, heaped in the alleys, thickest where the city is poorest; in the sewers along the
    // walkways only, the channel down their middle
    const heaps = /^(court|mese|upper|quarter|hall|atrium|plaza)$/.test(s.kind) ? 0
      : s.kind === "alley" ? Math.round(len / 480)
        : s.style === "sewer" ? Math.round(len / 900)
          : Math.round((len / 1100) * style.mess);
    if (heaps > 0) {
      const kindsOf = s.style === "sewer" ? { trash: 3, boxes: 1, pallets: 1 } : /^(avenue|ring|outer)$/.test(s.kind) ? { trash: 4, boxes: 1, box: 1, pallets: 1, dumpster: 1 } : undefined;
      const { entities, clips } = litter(s.rect, s.axis, s.floor, heaps, rng, clearOfDoors, kindsOf);
      bag.entities.push(...entities);
      bag.world.push(...clips);
      clipBoxes.push(...clips.map((b) => M.shapeOf(b)));
    }
    // now and then a bank of haze lies along a street, thickest where the city is poorest and in the sewers
    const fogChance = { rookery: 0.95, sewer: 0.9, foundry: 0.85, works: 0.75, gate: 0.75, stacks: 0.7, bazaar: 0.55, infirmary: 0.45, heights: 0.4 }[s.style] ?? 0.35;
    if (!/^(mese|upper|quarter)$/.test(s.kind) && rng() < (s.kind === "alley" ? Math.max(0.7, fogChance) : fogChance)) {
      const banks = 1 + Math.floor(rng() * Math.min(5, len / 400));
      for (let k = 0; k < banks; k++) {
        const t = 0.15 + rng() * 0.7;
        const p = s.axis === "x" ? [x0 + (x1 - x0) * t, (y0 + y1) / 2] : [(x0 + x1) / 2, y0 + (y1 - y0) * t];
        bag.entities.push(fog([p[0], p[1], s.floor + 60], { scale: 2 + rng(), amt: 110 + Math.floor(rng() * 50) }));
      }
    }
    // its sound: the city's hum down the avenues and roads, the district's own down its streets, water in the sewers
    const mid = (t) => (s.axis === "x" ? [x0 + (x1 - x0) * t, (y0 + y1) / 2, s.floor + 96] : [(x0 + x1) / 2, y0 + (y1 - y0) * t, s.floor + 96]);
    const CITY = ["ambience/po_city1.wav", "paradise/city2.wav", "ambience/fortran_city.wav", "paradise/air.wav"];
    if (/^(avenue|ring|outer|plaza)$/.test(s.kind)) {
      const n = Math.max(1, Math.round(len / 1800));
      for (let k = 0; k < n; k++) say(mid((k + 0.5) / n), CITY[(Math.round(x0 + y0) / 16 + k) & 3], 3, "medium", 2);
    } else if (s.style === "sewer") {
      const n = Math.max(1, Math.round(len / 1400));
      for (let k = 0; k < n; k++) say(mid((k + 0.5) / n), k % 2 ? "ambience/3dm_grn_wtr.wav" : "ambience/georfwater.wav", 3, "medium", 2);
    } else if (s.kind === "street" && DISTRICT_SOUNDS[s.style] && chance(rng, 0.45)) say(mid(0.5), pick(rng, DISTRICT_SOUNDS[s.style]), 2, "medium", 3);
    else if (s.kind === "alley" && len >= 640 && chance(rng, 0.25)) say(mid(0.5), pick(rng, ALLEY_SOUNDS), 2, "small", 5);
    else if (s.kind === "mese") {
      say(mid(0.5), "paradise/air.wav", 2, "medium", 3);
    } else if (s.kind === "upper") say(mid(0.5), "ambience/windambient4.wav", 2, "medium", 4);
    else if (s.kind === "court") say([(x0 + x1) / 2 + 96, (y0 + y1) / 2 - 96, s.floor + 160], s.style === "heights" ? "ambience/birds_outside1.wav" : "ambience/windy.wav", 3, "medium", 2);
    else if (s.kind === "atrium") {
      say([(x0 + x1) / 2, (y0 + y1) / 2, 200], "ambience/fortran_city.wav", 3, "medium", 1);
      say([(x0 + x1) / 2, (y0 + y1) / 2, 900], "ambience/windambient4.wav", 3, "medium", 1);
    } else if (s.stalls) {
      say([x0 + (x1 - x0) * 0.3, (y0 + y1) / 2, 160], "paradise/t_kitchen.wav", 3, "medium", 1);
      // the radio on the first stall's counter, at the hall's far end from its door
      say([x0 + 256, y0 + 176, 64], "ambience/cg_rdmkjun01.wav", 3, "small", 1, prop("hammertime/cg_radio01", [x0 + 256, y0 + 176, 40], 90));
    } else if (s.machines) {
      say([x0 + (x1 - x0) * 0.3, y0 + (y1 - y0) * 0.3, 96], "ambience/3dm_grn_mach.wav", 4, "medium", 1);
      say([x0 + (x1 - x0) * 0.7, y0 + (y1 - y0) * 0.7, 96], "paradise/enginermAMB.wav", 3, "medium", 1);
    } else if (s.shacks) {
      say([(x0 + x1) / 2, (y0 + y1) / 2, 600], "ambience/windy.wav", 3, "medium", 1);
      say([x0 + 200, y0 + 200, 80], "ambience/torn_ambience.wav", 3, "medium", 1);
    }
  }

  // ======== THE NEXUS, standing in the well: the MSR's headquarters, its jail, its tunnels ===================
  buildNexus({ bag, Z, WELL, add: addOutline, opening, say });

  // ======== THE PLACES' OWN SOUNDS, then all of them that the engine can keep ================================
  say([0, -1200, 2600], "ambience/windambient4.wav", 4, "large", 1);
  say([0, 0, Z.cistern + 120], "ambience/toxicambience1.wav", 3, "large", 1);
  for (const [x, y] of [[-768, 0], [768, 0], [0, -768], [0, 768]]) say([x, y, Z.cistern + 40], "ambience/georfwater.wav", 3, "medium", 2);
  for (const d of ["n", "e", "s", "w"]) {
    say([...FRAMES[d].p(1792, 0), Z.ward + 96], "ambience/computer_ambience.wav", 2, "medium", 2);
    say([...FRAMES[d].p(2704, -464), 96], "ambience/computer_ambience.wav", 2, "small", 3);
  }
  say([1888, -3016, Z.mese + 400], "ambience/windambient4.wav", 2, "large", 2);
  // over the open water, clear of the barges moored at -3072, -1024 and 1280
  for (const x of [-3300, -1800, -300, 900, 2400]) say([x, -6976, -60], "ambience/3dm_grn_wtr.wav", 3, "medium", 1);
  for (const x of [-2100, 700]) say([x, -6976, 0], "ambience/rd_waves.wav", 4, "medium", 1);
  for (const x of [-3000, 2600]) say([x, -7200, -40], "paradise/amb_frogs00.wav", 3, "small", 2);
  for (const [x, y] of [[-2400, -6000], [2400, -7900]]) say([x, y, 400], "ambience/windy.wav", 3, "large", 1);
  say([0, -7000, 900], "paradise/wind_bass.wav", 3, "large", 2);
  say([-128, -8000, 96], "ambience/torn_ambience.wav", 3, "medium", 1);
  // haze over the canal's water and the cistern's, and the canal's quays strewn with what the city throws out
  for (const x of [-3000, -1800, -600, 600, 1800, 3000]) bag.entities.push(fog([x, -6976, -40], { scale: 3.5, amt: 120 }));
  for (const [x, y] of [[-700, -700], [700, 700], [-700, 700], [700, -700]]) bag.entities.push(fog([x, y, Z.cistern + 40], { scale: 3, amt: 140 }));
  {
    const { entities, clips } = litter([-3584, -8448, 3584, -5632], "x", 0, 16, rng, clearOfDoors, { trash: 3, boxes: 2, pallets: 2, pallet: 1, dumpster: 1 });
    bag.entities.push(...entities);
    bag.world.push(...clips);
  }
  // the most important first; a sound is left out when another already plays within 600 units of it (a tune in
  // its own room, 320), or the same file within 1800 (one tune twice in earshot), up to the 240 the engine has
  // room for
  heard.sort((p, q) => p.rank - q.rank);
  const kept = [];
  const apart = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  for (const h of heard) {
    if (kept.length >= 240) break;
    const room = h.source ? 320 : 600;
    if (kept.some((k) => apart(k.at, h.at) < room || (k.file === h.file && apart(k.at, h.at) < 1800))) continue;
    kept.push(h);
  }
  for (const h of kept) {
    bag.entities.push(sound(h.at, h.file, h.volume, h.radius));
    if (h.source) bag.entities.push(h.source);
  }
  bag.sounds = [...new Set(kept.map((h) => h.file))];
  bag.notes.push(`${kept.length} sounds of ${heard.length} wanted`);

  // ======== WHERE PLAYERS START ============================================================================
  // In the city's public ways only, spread over every district and level: on a street's middle (a road's or a
  // sewer's walkway, off the carriageway and the channel), clear of every doorway and stair, out of the litter,
  // looking along the street. At least 72 of them, for 64 players.
  const SPAWN_KINDS = /^(avenue|ring|outer|street|alley|plaza|court|mese|upper|sewer|atrium)$/;
  const OFF = { avenue: 160, ring: 104, outer: 88, plaza: 160, sewer: 104 };
  const spawns = [];
  const tooNear = (p) => spawns.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1], (q[2] - p[2]) * 2) < 560);
  const clearAt = ([x, y, z]) =>
    !occ.hits([x - 56, y - 56, z, x + 56, y + 56, z + 72], 0).some((h) => h.kind === "door") &&
    !clipBoxes.some((c) => c.min[0] < x + 24 && c.max[0] > x - 24 && c.min[1] < y + 24 && c.max[1] > y - 24);
  // the undercity's mains and ring first, so the sewers have their share; then every other street in a shuffled order
  const spawnable = streets.filter((st) => SPAWN_KINDS.test(st.kind) && !st.stalls && !st.machines && !st.shacks);
  const spawnStreets = [...spawnable.filter((st) => st.kind === "sewer"), ...shuffled(spawnable.filter((st) => st.kind !== "sewer"), rng)];
  for (const ts of [[0.5], [0.25, 0.75], [0.12, 0.38, 0.62, 0.88]])
    for (const st of spawnStreets) {
      if (spawns.length >= 104) break;
      const [x0, y0, x1, y1] = st.rect;
      const len = st.axis === "x" ? x1 - x0 : y1 - y0;
      if (len < 320) continue;
      // the sewers' long runs take three at once, the first time round
      for (const t of st.kind === "sewer" && ts.length === 1 ? [0.2, 0.5, 0.8] : ts) {
        // a main's middle is its channel; the ring sewer has none
        const off = (spawns.length % 2 ? 1 : -1) * (/^sewer_ring/.test(st.name) ? 0 : OFF[st.kind] ?? 0);
        const a = (st.axis === "x" ? x0 : y0) + len * t;
        const c = (st.axis === "x" ? (y0 + y1) / 2 : (x0 + x1) / 2) + off;
        const p = st.axis === "x" ? [snap(a), snap(c), st.floor] : [snap(c), snap(a), st.floor];
        if (tooNear(p) || !clearAt(p)) continue;
        // along the street, towards its longer end from here
        const yaw = st.axis === "x" ? (t < 0.5 ? 0 : 180) : t < 0.5 ? 90 : 270;
        spawns.push([...p, yaw]);
        // an avenue's upper gallery, over its pavement, for the galleries' share
        const g = [p[0], p[1], st.floor + 352];
        if (st.kind === "avenue" && t === 0.5 && !tooNear(g) && clearAt(g)) spawns.push([...g, (yaw + 180) % 360]);
      }
    }
  // the well's plaza round the Nexus's steps, facing it; the canal's quays; the cistern's vaults
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * 2 * Math.PI;
    spawns.push([Math.round(1400 * Math.cos(a + Math.PI / 8)), Math.round(1400 * Math.sin(a + Math.PI / 8)), 0, Math.round(((a + Math.PI / 8) * 180) / Math.PI + 180) % 360]);
  }
  for (const [x, y, yaw] of [[-2560, -6000, 270], [2560, -6000, 270], [-1800, -7450, 90], [1800, -7450, 90], [-640, -6000, 270]]) spawns.push([x, y, 0, yaw]);
  for (const [x, y] of [[-384, -768], [384, 768]]) spawns.push([x, y, Z.cistern, 45]);
  // the Bazaar's hall, inside its door, between it and the first row of stalls
  for (const x of [3700, 4400]) spawns.push([x, -330, 0, 270]);
  for (const [x, y, z, yaw] of spawns) bag.entities.push(M.playerStart([x, y, z], yaw, "info_player_deathmatch"));
  bag.notes.push(`${roomsMade.count} rooms, ${roomsMade.doors} doors, ${streets.length} streets, ${spawns.length} places to start`);
  // ======== WHAT EACH SPACE IS, AND THE CITY'S PUBLIC WAYS ================================================
  // Every space is labelled with its kind. The public ones (streets, galleries' streets, plazas, halls, stair
  // halls, passages, the sewers) are listed with their box and floor and the public spaces each one opens into:
  // what the roaming citizens walk. Rooms, doorways into rooms, and everything of the MSR's (kind msr*) are never
  // public.
  const streetKind = new Map(streets.map((st) => [st.name, st.kind]));
  for (const sp of bag.spaces) sp.kind ??= kindOf(sp.name, streetKind);
  const publicSpaces = bag.spaces.filter((sp) => PUBLIC_KINDS.has(sp.kind)).map((sp) => {
    const xs = sp.outline.map((q) => q[0]);
    const ys = sp.outline.map((q) => q[1]);
    return { name: sp.name, kind: sp.kind, rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], floor: sp.floor, ceiling: sp.ceiling, connections: [] };
  });
  {
    const CELL = 512;
    const grid = new Map();
    publicSpaces.forEach((p, k) => {
      for (let i = Math.floor(p.rect[0] / CELL); i <= Math.floor(p.rect[2] / CELL); i++)
        for (let j = Math.floor(p.rect[1] / CELL); j <= Math.floor(p.rect[3] / CELL); j++) {
          const key = `${i},${j}`;
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key).push(k);
        }
    });
    publicSpaces.forEach((p, k) => {
      const seen = new Set();
      for (let i = Math.floor(p.rect[0] / CELL); i <= Math.floor(p.rect[2] / CELL); i++)
        for (let j = Math.floor(p.rect[1] / CELL); j <= Math.floor(p.rect[3] / CELL); j++)
          for (const m of grid.get(`${i},${j}`) ?? []) {
            if (m <= k || seen.has(m)) continue;
            seen.add(m);
            const o = publicSpaces[m];
            // they touch or overlap in plan, and share at least a player's height of air
            const ox = Math.min(p.rect[2], o.rect[2]) - Math.max(p.rect[0], o.rect[0]);
            const oy = Math.min(p.rect[3], o.rect[3]) - Math.max(p.rect[1], o.rect[1]);
            const oz = Math.min(p.ceiling, o.ceiling) - Math.max(p.floor, o.floor);
            if (ox < 0 || oy < 0 || oz < 72 || Math.max(ox, oy) < 32) continue;
            p.connections.push(o.name);
            o.connections.push(p.name);
          }
    });
  }
  return { bag, streets, occ, publicSpaces };
}

// ---- what a space is, by its name ------------------------------------------------------------------------
/** The kinds a citizen may walk: every other kind is private (a room, a doorway into one, the MSR's own). */
export const PUBLIC_KINDS = new Set(["avenue", "ring", "outer", "street", "alley", "plaza", "court", "hall", "atrium", "mese", "upper", "quarter", "sewer", "well", "stair", "passage", "cistern", "public_hall", "road"]);
/** A space's kind from its name, for the spaces that are not streets (streets know their own). */
export function kindOf(name, streetKind = new Map()) {
  if (streetKind.has(name)) return streetKind.get(name);
  // windows: a hole to see through, not a way to walk
  if (/_window(_[a-z]+)?$|^ward_slit_|^mese_arch_/.test(name)) return "window";
  if (/^(precinct|ward|msr|checkpoint|tunnel|jail|commander|hq_|gate_|cell_|mese_bridge_)/.test(name)) return "msr";
  if (/^mese_[nesw]_bridgeway$/.test(name)) return "passage";
  if (/^cut_passage\d+_(\d|in|out)$/.test(name)) return "passage";
  if (/^(hidden_|secret_)/.test(name)) return "hidden";
  if (/^(ascent|descent)_[nesw]{1,2}$/.test(name) || /_ramp(lo|hi)$/.test(name) || /^well_stair_/.test(name)) return "stair";
  if (/^(ascent|descent)_[nesw]{1,2}_(street|sewer|mese)$/.test(name) || /_ramp(lo|hi)-?\d+$/.test(name)) return "passage";
  if (/^(stacks_gate|rookery_gate_e|bazaar_door|foundry_gate|garden_gate|basilica_door|exchange_door|ministry_courtdoor|south_gate)$/.test(name)) return "passage";
  if (/^(mese_bridge|mese_arch)_/.test(name) || /^court-?\d+_-?\d+_way$/.test(name)) return "passage";
  // the plaza, the steps' band, the terrace and the rim of the upper tier by the hall are floor to walk; the rest of
  // the well is air
  if (/^well_(plaza|steps|terrace|hallside|hallcorner)/.test(name)) return "well";
  if (/^well_(air|roof)/.test(name)) return "air";
  if (/^cistern_channel/.test(name)) return "water";
  if (/^cistern/.test(name)) return "cistern";
  if (/^(basilica|exchange_hall|ministry_court)$/.test(name)) return "public_hall";
  if (/^basilica_dome/.test(name)) return "air";
  if (/^(manhole|outfall|sewer_channel|canal_cut|rookery_sky)/.test(name)) return "shaft";
  if (/d$/.test(name) && /_\d+b?d$/.test(name)) return "door";
  return "room";
}

// ---- the pieces that stand in a hall or in the open ------------------------------------------------------
/** The Bazaar's stalls: counters under striped awnings, in rows down the hall. */
function stalls(s, rng) {
  const out = new Bag();
  const [x0, y0, x1, y1] = s.rect;
  for (let x = x0 + 192; x < x1 - 192; x += 256)
    for (let y = y0 + 160; y < y1 - 160; y += 224) {
      if (rng() < 0.15 && !(x === x0 + 192 && y === y0 + 160)) continue;
      out.detail.push(M.box([x, y, 0], [x + 128, y + 32, 40], { top: "tabletops", bottom: "wood3", sides: "booth_wood_1" }));
      out.detail.push(M.box([x - 8, y - 24, 104], [x + 136, y + 56, 108], { top: "cd_stripes1", bottom: "cd_stripes1", sides: "metal5" }));
      for (const px of [x, x + 124]) out.detail.push(M.box([px, y + 28, 0], [px + 4, y + 32, 104], "metal5"));
      if (rng() < 0.6) out.detail.push(M.box([x + 16, y + 4, 40], [x + 64, y + 28, 64], { top: pick(rng, ["gp_shelf1", "gp_shelf2", "gp_fridgebeer"]), bottom: "wood3", sides: "xcrate10a" }));
      if (rng() < 0.35) out.entities.push(lamp([x + 64, y + 16, 96], pick(rng, NEON), 90));
    }
  return out;
}

/** The Foundry's machines: furnaces glowing, presses, a catwalk round the walls. */
function machines(s, rng) {
  const out = new Bag();
  const [x0, y0, x1, y1] = s.rect;
  for (let k = 0; k < 6; k++) {
    const x = snap(x0 + 192 + rng() * (x1 - x0 - 448));
    const y = snap(y0 + 192 + rng() * (y1 - y0 - 448));
    const h = within(rng, 128, 320, 32);
    out.detail.push(M.box([x, y, 0], [x + 160, y + 128, h], { top: "metal5", bottom: "metal5", sides: pick(rng, ["sinfuture", "sinfuture2", "sinfuture3", "lab1_paneli"]) }));
    if (rng() < 0.5) out.entities.push(lamp([x + 80, y - 32, 64], [255, 110, 40], 220));
  }
  for (const [a, b] of [[[x0, y0], [x1, y0 + 96]], [[x0, y1 - 96], [x1, y1]]]) {
    out.detail.push(M.box([a[0], a[1], 352], [b[0], b[1], 368], { top: "sinfuturefloor", bottom: "metal5", sides: "metal5" }));
  }
  out.detail.push(...M.stairs([x1 - 128, y0 + 96, 0], [x1 - 32, y0 + 96 + 528, 352], "-y", "metal13dn", { tread: 24, ramp: "CLIP" }));
  out.entities.push(lamp([(x0 + x1) / 2, (y0 + y1) / 2, 560], [255, 150, 90], 300));
  return out;
}

/** A shanty: four walls of rusted sheet, a gap for a door, a roof, a mattress and a light. */
function shack([x, y], rng) {
  const out = new Bag();
  const w = within(rng, 160, 224, 16);
  const d = within(rng, 128, 192, 16);
  const h = within(rng, 112, 144, 16);
  const tex = pick(rng, ["po_rustmetalblu", "mo_rustwall1", "sinbrickwall", "po_concretwall"]);
  const t = 8;
  const dx = snap(x + w / 2 - 32, 4);
  out.detail.push(M.box([x, y, 0], [dx, y + t, h], tex), M.box([dx + 64, y, 0], [x + w, y + t, h], tex));
  out.detail.push(M.box([x, y + d - t, 0], [x + w, y + d, h], tex));
  out.detail.push(M.box([x, y + t, 0], [x + t, y + d - t, h], tex), M.box([x + w - t, y + t, 0], [x + w, y + d - t, h], tex));
  out.detail.push(M.box([x - 8, y - 16, h], [x + w + 8, y + d + 8, h + 8], { top: "po_rustmetalblu", bottom: "po_rustmetalblu", sides: "mo_rustwall1" }));
  out.detail.push(M.box([x + 16, y + d - 64, 0], [x + 96, y + d - 16, 10], "mattress4"));
  out.entities.push(lamp([x + w / 2, y + d / 2, h - 24], [255, 150, 80], 60));
  return out;
}

/** The insurgents' house: a gutted pump house on the south quay, a loft over half of it, fires, crates. */
function pumpHouse([x, y], rng) {
  const out = new Bag();
  const [w, d, h] = [1024, 640, 384];
  const tex = { top: "po_concretwall", bottom: "po_concretwall", sides: "bigcrete2" };
  const t = 24;
  // walls with gaps: a door on the north side to the quay, holes knocked through elsewhere
  const runs = [
    [[x, y + d - t], [x + 448, y + d]], [[x + 576, y + d - t], [x + w, y + d]],
    [[x, y], [x + 320, y + t]], [[x + 448, y], [x + w, y + t]],
    [[x, y + t], [x + t, y + 256]], [[x, y + 384], [x + t, y + d - t]],
    [[x + w - t, y + t], [x + w, y + d - t]],
  ];
  for (const [a, b] of runs) out.detail.push(M.box([a[0], a[1], 0], [b[0], b[1], h], tex));
  for (const [a, b] of [[[x + 448, y + d - t], [x + 576, y + d]], [[x + 320, y], [x + 448, y + t]]]) out.detail.push(M.box([a[0], a[1], 160], [b[0], b[1], h], tex));
  // the roof is half gone
  out.detail.push(M.box([x - 16, y - 16, h], [x + 544, y + d + 16, h + 16], tex));
  out.detail.push(M.box([x + 736, y - 16, h], [x + w + 16, y + 224, h + 16], tex));
  // the loft and its stair
  out.detail.push(M.box([x + t, y + t, 176], [x + 448, y + d - t, 192], { top: "singhettofloor", bottom: "po_concretwall", sides: "po_concretwall" }));
  out.detail.push(...M.stairs([x + 448, y + t, 0], [x + 512, y + t + 264, 176], "-y", "metal13dn", { tread: 24, ramp: "CLIP" }));
  // what they keep there
  out.detail.push(M.box([x + 640, y + 96, 0], [x + 864, y + 128, 44], { top: "tabletops", bottom: "wood3", sides: "booth_wood_1" }));
  for (let k = 0; k < 5; k++) out.detail.push(M.box([x + 64 + k * 72, y + 64, 192], [x + 128 + k * 72, y + 112, 202], "mattress4"));
  for (let k = 0; k < 6; k++) {
    const cx = snap(x + 560 + rng() * 380, 4);
    const cy = snap(y + 200 + rng() * 360, 4);
    out.detail.push(M.box([cx, cy, 0], [cx + 48, cy + 48, 48], pick(rng, ["xcrate10a", "xcrate11c", "xcrate11d"])));
  }
  for (const [fx, fy] of [[x + 640, y + 384], [x + 512, y + d + 160]]) {
    out.detail.push(M.cylinder("z", [fx, fy], 20, 0, 8, "stonewall1", { sides: 8, snap: 1 }));
    out.entities.push(M.pointEntity("env_sprite", [fx, fy, 40], { model: "sprites/fire.spr", rendermode: 5, renderamt: 255, framerate: 12, scale: 0.6, spawnflags: 1 }));
    out.entities.push(lamp([fx, fy, 64], [255, 130, 50], 260));
  }
  out.entities.push(lamp([x + 256, y + 320, 330], [255, 140, 70], 120));
  out.entities.push(plate([x + 600, y + d - t - 4, 96], [x + 760, y + d - t, 200], "{ax_msr", { rendercolor: "255 60 60" }));
  return out;
}
