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
  door, glass, plate, lamp, furnish, debris, column, spiralCore, rampCore,
} from "./kit.mjs";

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
    { wall: "stec_panel3", floor: "vaultfloor", ceiling: "wallvault2" },
  ],
  cell: [{ wall: "stec_panel3", floor: "vaultfloor", ceiling: "wallvault2" }],
  slum: [
    { wall: "po_rustmetalblu", floor: "po_subtrash", ceiling: "po_concretwall" },
    { wall: "sinbrickwall", floor: "singhettofloor", ceiling: "po_concretwall" },
  ],
};
const DOOR_TEX = {
  flat: "homedoor1dn", flat_poor: "home7dn", flat_lux: "cd_wooddoor", shop: "{pkf_shopgrate1", bar: "cyberdoor4",
  clinic: "cds_whitedoor", office: "cds_whitedoor", workshop: "metaldoor14dn", storage: "metaldoor2dn",
  msr: "bigcyberdoor", cell: "{grate1", slum: "woodlockdn",
};
const ROOM_LIGHT = {
  flat: [[255, 200, 140], 130], flat_poor: [[255, 170, 110], 85], flat_lux: [[255, 225, 185], 170],
  shop: [[205, 230, 255], 170], bar: [[200, 90, 255], 150], clinic: [[225, 240, 255], 210],
  office: [[215, 228, 255], 165], workshop: [[255, 165, 95], 140], storage: [[200, 200, 210], 75],
  msr: [[170, 115, 255], 175], cell: [[190, 190, 255], 70], slum: [[255, 150, 85], 70],
};
const SIGNS_MESH = ["{xc_guns", "{xc_gear", "{xc_skybar", "{xc_enjoy", "{xc_uncle", "{PC_BANK", "{PC_PAWNPRAWN", "{PC_SNACK", "{PC_SKYTECH", "{PC_GEARGUYS", "{PC_SUB", "{PC_CYB"];
const SIGNS_SOLID = ["sign_cocktails", "sign_coffee1", "sign_open", "jap_sign2", "hb_sign_028", "cd_sign_cafe"];
const NEON = [[90, 230, 255], [190, 110, 255], [120, 255, 150], [255, 90, 160], [255, 180, 60]];
const DEBRIS = {
  crates: ["xcrate10a", "xcrate11c", "xcrate11d", "bcrate09a"],
  rubble: ["PRXCNCRT10A", "PRXCNCRT5A", "pkf_concrete1", "po_subtrash"],
};

// ---- the districts --------------------------------------------------------------------------------
const W2 = (list) => list.flatMap(([v, n]) => Array(n).fill(v));
export const STYLES = {
  stacks: { name: "The Stacks", street: { floor: "po_slasphalblgr", wall: "wallvault1", ceiling: "ceilingpipec" }, ground: W2([["shop", 3], ["bar", 1], ["flat_poor", 2], ["storage", 1], ["workshop", 1]]), upper: W2([["flat", 3], ["flat_poor", 4]]), light: [205, 220, 255], alley: 0.3, drop: 0.1, gallery: 0.8, mess: 1.2, doors: 0.8, widths: [192, 224, 256], depths: [224, 288, 352] },
  heights: { name: "Spire Heights", street: { floor: "sintilesfloor", wall: "sinmarblewall", ceiling: "fap-ceiling03" }, ground: W2([["shop", 3], ["bar", 2], ["office", 2], ["clinic", 1]]), upper: W2([["flat_lux", 5], ["flat", 2]]), light: [255, 230, 190], alley: 0.1, drop: 0.15, gallery: 0.7, mess: 0.15, doors: 1, widths: [224, 256, 320], depths: [288, 352, 416] },
  bazaar: { name: "The Bazaar", street: { floor: "sintilesplain", wall: "cyberwall2", ceiling: "ceilingpipec" }, ground: W2([["shop", 6], ["bar", 3], ["storage", 1]]), upper: W2([["flat", 3], ["flat_poor", 2], ["storage", 1]]), light: [255, 200, 140], alley: 0.25, drop: 0.05, gallery: 0.7, mess: 1, doors: 0.6, widths: [160, 192, 224], depths: [224, 288] },
  infirmary: { name: "The Infirmary", street: { floor: "cds_tilefgray", wall: "wht_wall1", ceiling: "fap-ceiling03" }, ground: W2([["clinic", 4], ["office", 3], ["shop", 1]]), upper: W2([["office", 2], ["clinic", 2], ["flat", 2]]), light: [205, 235, 255], alley: 0.15, drop: 0.1, gallery: 0.6, mess: 0.3, doors: 0.9, widths: [192, 256], depths: [256, 320] },
  gate: { name: "Gate Ward", street: { floor: "Pavement001", wall: "bigcrete2", ceiling: "ceilingpipec" }, ground: W2([["storage", 3], ["shop", 2], ["bar", 2], ["workshop", 1]]), upper: W2([["flat_poor", 3], ["storage", 1]]), light: [255, 190, 120], alley: 0.3, drop: 0.1, gallery: 0.6, mess: 1.4, doors: 0.7, widths: [192, 256, 320], depths: [256, 352, 416] },
  foundry: { name: "The Foundry", street: { floor: "grey_creteflr", wall: "mo_rustwall1", ceiling: "ceilingpipec" }, ground: W2([["workshop", 4], ["storage", 3], ["bar", 1]]), upper: W2([["flat_poor", 3], ["workshop", 1]]), light: [255, 150, 90], alley: 0.35, drop: 0.15, gallery: 0.5, mess: 1.8, doors: 0.6, widths: [224, 256, 320], depths: [288, 352, 416] },
  works: { name: "The Works", street: { floor: "grey_creteflr2", wall: "po_concretwall", ceiling: "ceilingpipec" }, ground: W2([["workshop", 4], ["storage", 2], ["shop", 1]]), upper: W2([["flat_poor", 3], ["flat", 1]]), light: [185, 255, 175], alley: 0.3, drop: 0.12, gallery: 0.6, mess: 1.5, doors: 0.7, widths: [192, 256], depths: [256, 320, 384] },
  rookery: { name: "The Rookery", street: { floor: "po_slasphalblgr", wall: "sinbrickwall", ceiling: "po_concretwall" }, ground: W2([["slum", 5], ["bar", 1], ["shop", 1]]), upper: W2([["slum", 4], ["flat_poor", 2]]), light: [255, 170, 110], alley: 0.6, drop: 0.2, gallery: 0.5, mess: 2.6, doors: 0.35, widths: [128, 160, 192], depths: [160, 224, 256] },
  regal: { name: "The Mese", street: { floor: "marb", wall: "sinmarblewall", ceiling: "sinceiling3" }, ground: W2([["shop", 3], ["bar", 2], ["office", 1], ["flat_lux", 2]]), upper: W2([["flat_lux", 1]]), light: [255, 225, 190], alley: 0, drop: 0, gallery: 0, mess: 0, doors: 1, widths: [256, 320], depths: [288, 352] },
  sewer: { name: "The Undercity", street: { floor: "po_sewerfloor", wall: "po_sewerwall", ceiling: "po_concretwall" }, ground: W2([["slum", 3], ["bar", 1], ["storage", 2], ["workshop", 1]]), upper: [], light: [150, 220, 140], alley: 0, drop: 0, gallery: 0, mess: 2, doors: 0.3, widths: [160, 224], depths: [192, 256] },
  canal: { name: "The Canals", street: { floor: "pkf_concrete5a", wall: "bigcrete2", ceiling: "sky" }, ground: W2([["storage", 3], ["workshop", 2], ["bar", 1], ["slum", 2]]), upper: [], light: [255, 170, 90], alley: 0, drop: 0, gallery: 0, mess: 2, doors: 0.5, widths: [256, 320, 384], depths: [384, 448, 512] },
};
/** Which district a point of the lower city is in: the 3 x 3 squares round the well. */
export function districtAt(x, y) {
  const col = x < -WELL ? 0 : x > WELL ? 2 : 1;
  const row = y < -WELL ? 0 : y > WELL ? 2 : 1;
  return [["foundry", "gate", "infirmary"], ["works", null, "bazaar"], ["rookery", "stacks", "heights"]][row][col] ?? "stacks";
}

// ---- turning a piece drawn for the north avenue to any of the four -----------------------------------
// local u runs out from the well along the avenue, v across it (v > 0 east for the north one)
const FRAMES = {
  n: { p: (u, v) => [v, u], dir: { "+u": "+y", "-u": "-y", "+v": "+x", "-v": "-x" }, face: { "+u": "n", "-u": "s", "+v": "e", "-v": "w" } },
  e: { p: (u, v) => [u, -v], dir: { "+u": "+x", "-u": "-x", "+v": "-y", "-v": "+y" }, face: { "+u": "e", "-u": "w", "+v": "s", "-v": "n" } },
  s: { p: (u, v) => [-v, -u], dir: { "+u": "-y", "-u": "+y", "+v": "-x", "-v": "+x" }, face: { "+u": "s", "-u": "n", "+v": "w", "-v": "e" } },
  w: { p: (u, v) => [-u, v], dir: { "+u": "-x", "-u": "+x", "+v": "+y", "-v": "-y" }, face: { "+u": "w", "-u": "e", "+v": "n", "-v": "s" } },
};
/** A local box [u0, v0, z0, u1, v1, z1] as a world box. */
function fbox(f, [u0, v0, z0, u1, v1, z1]) {
  const a = f.p(u0, v0);
  const b = f.p(u1, v1);
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), z0, Math.max(a[0], b[0]), Math.max(a[1], b[1]), z1];
}

// ---- the builder ---------------------------------------------------------------------------------------
export function buildCity({ seed = 0xb12a, log = () => {} } = {}) {
  const rng = numbers(seed);
  const occ = new Occupancy(512);
  const bag = new Bag();
  const streets = [];
  const roomsMade = { count: 0, doors: 0 };
  const starts = [];

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
  const opening = (name, box, texture) => space(name, box, texture);

  /** A street: its space, its place, and what is built along it later. */
  function addStreet(s) {
    s.axis ??= s.rect[2] - s.rect[0] >= s.rect[3] - s.rect[1] ? "x" : "y";
    s.floor ??= 0;
    s.galleries ??= [];
    const [x0, y0, x1, y1] = s.rect;
    space(s.name, [x0, y0, s.floor, x1, y1, s.ceiling], s.tex ?? STYLES[s.style].street);
    reserve([x0, y0, s.floor, x1, y1, s.ceiling], "street");
    streets.push(s);
    return s;
  }

  // ======== THE WELL ===================================================================================
  const wellOutline = [
    [-WELL + CHAMFER, -WELL], [WELL - CHAMFER, -WELL], [WELL, -WELL + CHAMFER], [WELL, WELL - CHAMFER],
    [WELL - CHAMFER, WELL], [-WELL + CHAMFER, WELL], [-WELL, WELL - CHAMFER], [-WELL, -WELL + CHAMFER],
  ];
  bag.spaces.push({ name: "well", outline: wellOutline, floor: 0, ceiling: Z.wellSky, texture: { floor: "hMarb_surfaced3", wall: "wallvault1", ceiling: "sky" } });
  reserve([-WELL, -WELL, 0, WELL, WELL, Z.wellSky], "well");

  // ======== THE STREETS: avenues, the ring, the outer road, and the grid between ==========================
  const lineKind = (v) => (v === 0 ? "avenue" : Math.abs(v) === 3200 ? "ring" : Math.abs(v) === 4864 ? "outer" : "street");
  const HALF = { avenue: 192, ring: 128, outer: 112, street: 112 };
  // segments left out so that a landmark has its block: "x" lines run along y, "y" lines along x
  const LEFT_OUT = new Set([
    "x:-4096:3200", "x:-4096:4096", "y:4096:-4096", "y:4096:-4864", // the Rookery's hall
    "x:-1152:3200", "x:-1152:4096", "y:4096:-1152", // the Stacks
    "x:4096:-1152", // the Bazaar's hall
    "x:-4096:-4096", "x:-4096:-4864", "y:-4096:-4096", "y:-4096:-4864", // the Foundry
    "x:4096:3200", "x:4096:4096", "y:4096:3200", "y:4096:4096", // the Heights' garden
    "y:2432:0", "x:2432:-1152", "y:-2432:-1152", "x:-2432:0", // the Ascents' halls
  ]);
  for (const orient of ["x", "y"])
    for (const v of LINES)
      for (let i = 0; i + 1 < LINES.length; i++) {
        let a = LINES[i];
        let b = LINES[i + 1];
        const kind0 = lineKind(v);
        const key = `${orient}:${v}:${a}`;
        if (LEFT_OUT.has(key)) continue;
        let extA = HALF[lineKind(a)];
        let extB = HALF[lineKind(b)];
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
        const width = { avenue: 384, ring: 256, outer: 224, street: pick(rng, [192, 224]), alley: pick(rng, [112, 128]) }[kind];
        const ceiling = { avenue: Z.avenueTop, ring: Z.ringTop, outer: Z.ringTop, street: Z.streetTop, alley: Z.alleyTop }[kind];
        const galleries = { avenue: [176, 352], ring: [176], outer: [176], street: chance(rng, style.gallery) ? [176] : [], alley: [] }[kind];
        const jitter = kind === "street" || kind === "alley" ? pick(rng, [-32, -16, 0, 16, 32]) : 0;
        const c0 = v + jitter - width / 2;
        const c1 = v + jitter + width / 2;
        const rect = orient === "x" ? [c0, a - extA, c1, b + extB] : [a - extA, c0, b + extB, c1];
        const tex = kind === "avenue"
          ? { floor: "sinfuturefloor", wall: "stec_panel5b", ceiling: "ceilingpipec" }
          : kind === "ring" || kind === "outer" ? { floor: "Pavement001", wall: "wallvault2", ceiling: "ceilingpipec" } : undefined;
        addStreet({ name: `${kind}${orient}${v}_${a}`, rect, ceiling, galleries, style: styleName, kind, tex });
      }
  // the four squares where the avenues cross the ring
  for (const d of ["n", "e", "s", "w"]) {
    const box = fbox(FRAMES[d], [2944, -384, 0, 3456, 384, Z.avenueTop]);
    addStreet({ name: `ringplaza_${d}`, rect: [box[0], box[1], box[3], box[4]], ceiling: Z.avenueTop, style: districtAt(...FRAMES[d].p(3200, 0)), kind: "plaza", tex: { floor: "sintilesfloor", wall: "stec_panel5b", ceiling: "ceilingpipec" } });
    const [cx, cy] = FRAMES[d].p(3200, 0);
    bag.detail.push(...column([cx, cy], 40, 0, 400, "marb", "singold"));
    bag.entities.push(lamp([cx, cy, 440], [175, 120, 255], 320));
  }
  log(`  streets: ${streets.length}`);

  // ======== THE MSR: precincts in every district, the ward level, the cores between ======================
  const wardTex = { floor: "gratefloor", wall: "stec_panel5b", ceiling: "wallvault2" };
  const msrTex = pick(rng, ROOM_TEX.msr);
  const room = (name, box, kind, opts = {}) => {
    const tex = opts.tex ?? pick(rng, ROOM_TEX[kind]);
    const made = opts.force ? (reserve(box, kind), space(name, box, tex)) : spaceIfFree(name, box, tex, kind);
    if (!made) return null;
    roomsMade.count++;
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

  // the cardinal precincts, beside each avenue just inside the ring
  for (const d of ["n", "e", "s", "w"]) {
    const f = FRAMES[d];
    const B = (b) => fbox(f, b);
    const lobby = room(`precinct_${d}_lobby`, B([2576, -720, 0, 2832, -208, ROOM_H]), "msr", { tex: msrTex, force: true, furnish: false });
    bag.detail.push(...furnish("msr", [lobby[0], lobby[1], lobby[3], lobby[4]], 0, f.face["+v"], rng));
    doorway(`precinct_${d}_door`, B([2672, -208, 0, 2736, -192, DOOR.h]), msrTex, { tex: "bigcyberdoor" });
    bag.entities.push(plate(...(() => { const b = B([2640, -192, 120, 2768, -188, 168]); return [[b[0], b[1], b[2]], [b[3], b[4], b[5]]]; })(), "{ax_detfac"));
    // the core: a stair up to the ward level, a ladder down to the sewer main
    const core = B([2848, -400, 0, 3040, -208, Z.ward + ROOM_H + 32]);
    reserve(core, "core");
    space(`precinct_${d}_core`, core, msrTex);
    opening(`precinct_${d}_coredoor`, B([2832, -336, 0, 2848, -272, DOOR.h]), msrTex);
    const [ccx, ccy] = f.p(2944, -304);
    bag.detail.push(...spiralCore([ccx, ccy], 0, 4, f.face["+v"], "metal13dn"));
    for (let k = 0; k < 3; k++) {
      const cell = room(`precinct_${d}_cell${k}`, B([2848, -720 + 96 * k, 0, 3040, -640 + 96 * k, ROOM_H]), "cell", { force: true, doorSide: f.face["-u"] });
      if (cell) doorway(`precinct_${d}_celldoor${k}`, B([2832, -704 + 96 * k, 0, 2848, -656 + 96 * k, DOOR.h]), ROOM_TEX.cell[0], { tex: "{grate1", mesh: true, use: true });
    }
    const hatch = B([2592, -272, Z.sewer, 2656, -208, 0]);
    reserve(hatch, "hatch");
    space(`precinct_${d}_hatch`, hatch, msrTex);
    opening(`precinct_${d}_drain`, B([2592, -208, Z.sewer, 2656, -160, Z.sewer + ROOM_H]), STYLES.sewer.street);
    reserve(B([2592, -208, Z.sewer, 2656, -160, Z.sewer + ROOM_H]), "drain");
    bag.entities.push(M.brushEntity("func_ladder", [M.box([hatch[0] + 8, hatch[1] + 8, Z.sewer], [hatch[3] - 8, hatch[4] - 8, -8], "AAATRIGGER")]));
    bag.entities.push(door([hatch[0], hatch[1], -16, hatch[3], hatch[4], 0], "{grate1", { mesh: true, use: true }));
    // the ward spur from the wing over the avenue to the core
    space(`ward_spur_${d}`, B([2880, -208, Z.ward, 3008, -64, Z.wardTop]), wardTex);
    reserve(B([2880, -208, Z.ward, 3008, -64, Z.wardTop]), "ward");
  }
  // the corner precincts, outside the ring's corners
  for (const [sx, sy] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) {
    const P = (x0, y0, x1, y1, z0, z1) => [Math.min(sx * x0, sx * x1), Math.min(sy * y0, sy * y1), z0, Math.max(sx * x0, sx * x1), Math.max(sy * y0, sy * y1), z1];
    const tag = `${sx > 0 ? "e" : "w"}${sy > 0 ? "n" : "s"}`;
    const core = P(3344, 3344, 3536, 3536, 0, Z.ward + ROOM_H + 32);
    reserve(core, "core");
    space(`precinct_${tag}_core`, core, msrTex);
    bag.detail.push(...spiralCore([sx * 3440, sy * 3440], 0, 4, sy > 0 ? "s" : "n", "metal13dn"));
    const lobby = room(`precinct_${tag}_lobby`, P(3552, 3344, 4048, 3600, 0, ROOM_H), "msr", { tex: msrTex, doorSide: sy > 0 ? "s" : "n" });
    if (lobby) {
      doorway(`precinct_${tag}_door`, P(3760, 3328, 3824, 3344, 0, DOOR.h), msrTex, { tex: "bigcyberdoor" });
      opening(`precinct_${tag}_coredoor`, P(3536, 3408, 3552, 3472, 0, DOOR.h), msrTex);
      const hatch = P(3968, 3344, 4032, 3408, Z.sewer, 0);
      reserve(hatch, "hatch");
      space(`precinct_${tag}_hatch`, hatch, msrTex);
      opening(`precinct_${tag}_drain`, P(3968, 3328, 4032, 3344, Z.sewer, Z.sewer + ROOM_H), STYLES.sewer.street);
      reserve(P(3968, 3328, 4032, 3344, Z.sewer, Z.sewer + ROOM_H), "drain");
      bag.entities.push(M.brushEntity("func_ladder", [M.box([hatch[0] + 8, hatch[1] + 8, Z.sewer], [hatch[3] - 8, hatch[4] - 8, -8], "AAATRIGGER")]));
      bag.entities.push(door([hatch[0], hatch[1], -16, hatch[3], hatch[4], 0], "{grate1", { mesh: true, use: true }));
      for (let k = 0; k < 2; k++) {
        const cell = room(`precinct_${tag}_cell${k}`, P(3552 + 112 * k, 3616, 3648 + 112 * k, 3808, 0, ROOM_H), "cell", { doorSide: sy > 0 ? "s" : "n" });
        if (cell) doorway(`precinct_${tag}_celldoor${k}`, P(3576 + 112 * k, 3600, 3624 + 112 * k, 3616, 0, DOOR.h), ROOM_TEX.cell[0], { tex: "{grate1", mesh: true, use: true });
      }
    } else opening(`precinct_${tag}_streetdoor`, P(3408, 3328, 3472, 3344, 0, DOOR.h), msrTex);
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

  // ======== THE ASCENTS: four stair halls from the avenues up to the Mese ===============================
  for (const d of ["n", "e", "s", "w"]) {
    const f = FRAMES[d];
    const B = (b) => fbox(f, b);
    const hall = B([2064, 208, 0, 2576, 592, Z.mese + ROOM_H]);
    reserve(hall, "ascent");
    space(`ascent_${d}`, hall, { floor: "sintilesfloor", wall: "sinmarblewall", ceiling: "sinceiling3" });
    opening(`ascent_${d}_street`, B([2096, 192, 0, 2160, 208, DOOR.h]), { floor: "sintilesfloor", wall: "sinmarblewall", ceiling: "sinceiling3" });
    opening(`ascent_${d}_mese`, B([2048, 272, Z.mese, 2064, 528, Z.mese + ROOM_H]), { floor: "marb", wall: "sinmarblewall", ceiling: "sinceiling3" });
    for (let k = 0; k < 6; k++) {
      const laneA = k % 2 === 0;
      const z0 = k * STOREY;
      const [v0, v1] = laneA ? [208, 400] : [400, 592];
      const sb = B([2192, v0, z0, 2456, v1, z0 + STOREY]);
      const high = f.dir[laneA ? "+u" : "-u"];
      bag.detail.push(...M.stairs([sb[0], sb[1], sb[2]], [sb[3], sb[4], sb[5]], high, "sinmarblewall", { tread: 24, ramp: "CLIP" }));
      const land = laneA ? B([2456, 208, z0 + STOREY - 16, 2576, 592, z0 + STOREY]) : B([2064, 208, z0 + STOREY - 16, 2192, 592, z0 + STOREY]);
      bag.detail.push(M.box([land[0], land[1], land[2]], [land[3], land[4], land[5]], { top: "marb", bottom: "sinceiling3", sides: "singold" }));
      bag.entities.push(lamp([...f.p(2320, 400), z0 + STOREY + 120], [255, 220, 180], 180));
    }
  }

  // ======== THE UPPER CITY: the Mese and what opens off it ================================================
  const regal = STYLES.regal.street;
  for (const d of ["n", "e", "s", "w"]) {
    const f = FRAMES[d];
    const B = (b) => fbox(f, b);
    const side = B([1696, -2048, Z.mese, 2048, 2048, Z.meseTop]);
    const s = addStreet({ name: `mese_${d}`, rect: [side[0], side[1], side[3], side[4]], floor: Z.mese, ceiling: Z.meseTop, style: "regal", kind: "mese", tex: regal });
    s.frontSide = { n: "hi", e: "hi", s: "lo", w: "lo" }[d]; // the outer side
    opening(`mese_bridge_${d}`, B([1664, -96, Z.mese, 1696, 96, Z.mese + ROOM_H]), regal);
    for (const v of [-960, -448, 448, 960]) opening(`mese_arch_${d}${v}`, B([1664, v - 96, Z.mese + 96, 1696, v + 96, Z.mese + 384]), regal);
    // the colonnades, the chandeliers, the banners
    for (let v = -1792; v <= 1792; v += 256) {
      if (Math.abs(v) < 160) continue;
      for (const u of [1760, 1984]) bag.detail.push(...column(f.p(u, v), 20, Z.mese, Z.meseTop, "marb", "singold"));
    }
    for (const v of [-1024, 0, 1024]) {
      const [cx, cy] = f.p(1872, v);
      const ch = M.chandelier({ centre: [cx, cy], top: Z.meseTop, drop: 96, radius: 40, tiers: 3, glass: "glass_yellow1", metal: "singold" });
      bag.detail.push(...ch.brushes);
      bag.entities.push(lamp(ch.light, [255, 225, 180], 260));
    }
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
      if (vault) doorway("exchange_vaultdoor", [-1920, 3584, Z.mese, -1856, 3600, Z.mese + DOOR.h], { wall: "wallvault1" }, { tex: "bigcyberdoor" });
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
  const rook = addStreet({ name: "rookery_hall", rect: [-4544, 3456, -3584, 4416], ceiling: 768, style: "rookery", kind: "hall", tex: { floor: "po_slasphalblgr", wall: "sinbrickwall", ceiling: "po_concretwall" } });
  bag.spaces.push(boxSpace("rookery_sky", [-4288, 3712, 768, -3840, 4160, Z.courtSky], { floor: "po_slasphalblgr", wall: "sinbrickwall", ceiling: "sky" }));
  reserve([-4288, 3712, 768, -3840, 4160, Z.courtSky], "sky");
  rook.shacks = true;
  opening("rookery_gate_e", [-3584, 3904, 0, -3312, 4032, Z.alleyTop], STYLES.rookery.street);
  // the Bazaar's market hall, stalls in rows under a high roof
  const bazaar = addStreet({ name: "bazaar_hall", rect: [3456, -1040, 4672, -256], ceiling: 528, style: "bazaar", kind: "hall", tex: { floor: "sintilesplain", wall: "cyberwall2", ceiling: "ceilingpipec" } });
  bazaar.stalls = true;
  opening("bazaar_door", [3840, -256, 0, 4096, -192, 352], STYLES.bazaar.street);
  // the Foundry's casting hall
  const foundry = addStreet({ name: "foundry_hall", rect: [-4608, -4608, -3456, -3456], ceiling: 704, style: "foundry", kind: "hall", tex: { floor: "grey_creteflr", wall: "mo_rustwall1", ceiling: "ceilingpipec" } });
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
      const mh = fbox(f, [u, 96, Z.sewerTop, u + 64, 160, 0]);
      space(`manhole_${d}${u}`, mh, sewerTex);
      reserve(mh, "manhole");
      bag.entities.push(M.brushEntity("func_ladder", [M.box([mh[0] + 8, mh[1] + 8, Z.sewer], [mh[3] - 8, mh[4] - 8, -8], "AAATRIGGER")]));
      bag.entities.push(door([mh[0], mh[1], -16, mh[3], mh[4], 0], "{grate1", { mesh: true, use: true }));
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
        if ((x + y) % 768 === 0) bag.entities.push(lamp([x + 64, y + 64, Z.cistern + 96], [255, 170, 80], 90));
      }
    for (const [x, y] of [[0, 0], [-768, 768], [768, -768]]) bag.entities.push(lamp([x, y, Z.sewerTop - 48], [120, 200, 140], 160));
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
    bag.entities.push(M.brushEntity("func_door", [M.box([-192, -5408, 0], [192, -5392, 352], "bigcyberdoor")], { angles: "-90 0 0", speed: 90, wait: 6, lip: 16 }));
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
    bag.entities.push(M.brushEntity("func_ladder", [M.box([-56, -5368, Z.sewer], [56, -5360, -168], "AAATRIGGER")]));
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
    bag.entities.push(M.brushEntity("func_door", [M.box([-256, canal.y0 + 8, 0], [256, canal.y0 + 24, 448], "bigcyberdoor")], { angles: "-90 0 0", speed: 60, wait: -1, lip: 16, targetname: "outlands_gate" }));
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

  // ======== THE FRONTAGES: rooms along every street, at every level it has ================================
  for (const s of streets) {
    if (s.kind === "hall" || s.frontage === false) continue;
    const style = STYLES[s.style];
    const levels = s.levels ?? [0, ...s.galleries];
    const sides = s.frontSide ? [s.frontSide] : ["lo", "hi"];
    for (const side of sides)
      for (const lvl of levels) frontage(s, s.axis, side, s.floor + lvl, lvl === 0 ? s.mix ?? style.ground : s.mix ?? style.upper, style);
    if (s.both) for (const side of ["lo", "hi"]) for (const lvl of levels) frontage(s, s.axis === "x" ? "y" : "x", side, s.floor + lvl, lvl === 0 ? style.ground : style.upper, style);
  }
  log(`  rooms: ${roomsMade.count}, doors: ${roomsMade.doors}`);

  /**
   * Rooms along one side of a street at one level: each a space a wall back from the street, its doorway (and
   * a door), a window beside it when it is wide, a room behind it now and then, its things and its light.
   */
  function frontage(s, axis, side, z, mix, style) {
    if (!mix?.length) return;
    const [x0, y0, x1, y1] = s.rect;
    const start = axis === "x" ? x0 : y0;
    const end = axis === "x" ? x1 : y1;
    const edge = axis === "x" ? (side === "lo" ? y0 : y1) : side === "lo" ? x0 : x1;
    const out = side === "lo" ? -1 : 1;
    const doorSide = axis === "x" ? (side === "lo" ? "n" : "s") : side === "lo" ? "e" : "w";
    let u = start + 32;
    while (u < end - 128) {
      const w = pick(rng, style.widths);
      let placed = null;
      const deep = [...style.depths].sort((a, b) => b - a);
      for (const d of deep.slice(Math.floor(rng() * deep.length))) {
        const a0 = out < 0 ? edge - WALL - d : edge + WALL;
        const a1 = out < 0 ? edge - WALL : edge + WALL + d;
        const box = axis === "x" ? [u, a0, z, Math.min(u + w, end - 16), a1, z + ROOM_H] : [a0, u, z, a1, Math.min(u + w, end - 16), z + ROOM_H];
        if ((axis === "x" ? box[3] - box[0] : box[4] - box[1]) < 128) break;
        if (occ.free(box)) {
          placed = { box, d };
          break;
        }
      }
      if (!placed) {
        u += 64;
        continue;
      }
      const kind = pick(rng, mix);
      const { box } = placed;
      const tex = pick(rng, ROOM_TEX[kind]);
      reserve(box, kind);
      space(`${s.name}_${side}${z}_${u}`, box, tex);
      roomsMade.count++;
      const width = axis === "x" ? box[3] - box[0] : box[4] - box[1];
      const du = snap((axis === "x" ? box[0] : box[1]) + 32 + rng() * (width - 128), 16);
      const dw = axis === "x"
        ? [du, out < 0 ? edge - WALL : edge, z, du + DOOR.w, out < 0 ? edge : edge + WALL, z + DOOR.h]
        : [out < 0 ? edge - WALL : edge, du, z, out < 0 ? edge : edge + WALL, du + DOOR.w, z + DOOR.h];
      const withDoor = chance(rng, style.doors);
      doorway(`${s.name}_${side}${z}_${u}_d`, dw, tex, withDoor ? { tex: DOOR_TEX[kind], up: kind === "shop", mesh: DOOR_TEX[kind].startsWith("{") } : null);
      // a window as tall as the door beside it: a shop's glass front, a flat's glazed door to the gallery
      if (width >= 224 && /^(shop|bar|flat|flat_lux|office|clinic)$/.test(kind) && chance(rng, 0.6)) {
        const wu = du - (axis === "x" ? box[0] : box[1]) > width / 2 ? (axis === "x" ? box[0] : box[1]) + 32 : du + DOOR.w + 32;
        const wl = Math.min(96, (axis === "x" ? box[3] : box[4]) - wu - 24);
        if (wl >= 48) {
          const wb = axis === "x"
            ? [wu, out < 0 ? edge - WALL : edge, z, wu + wl, out < 0 ? edge : edge + WALL, z + DOOR.h]
            : [out < 0 ? edge - WALL : edge, wu, z, out < 0 ? edge : edge + WALL, wu + wl, z + DOOR.h];
          opening(`${s.name}_${side}${z}_${u}_w`, wb, tex);
          bag.entities.push(glass(wb, "glass_dark", 60));
        }
      }
      const inner = [box[0], box[1], box[3], box[4]];
      bag.detail.push(...furnish(kind, inner, z, doorSide, rng));
      const [c, b] = ROOM_LIGHT[kind];
      bag.entities.push(lamp([(box[0] + box[3]) / 2, (box[1] + box[4]) / 2, z + ROOM_H - 24], c, b));
      if (z === s.floor && starts.length < 400 && chance(rng, 0.3)) starts.push([(box[0] + box[3]) / 2, (box[1] + box[4]) / 2, z]);
      // a room behind, through a door, for a flat or a shop's back room
      if (chance(rng, kind.startsWith("flat") ? 0.55 : 0.25)) {
        const d2 = pick(rng, [160, 192, 224]);
        const b0 = out < 0 ? box[axis === "x" ? 1 : 0] - WALL - d2 : box[axis === "x" ? 4 : 3] + WALL;
        const back = axis === "x" ? [box[0], b0, z, box[3], b0 + d2, z + ROOM_H] : [b0, box[1], z, b0 + d2, box[4], z + ROOM_H];
        if (occ.free(back)) {
          const kind2 = kind.startsWith("flat") || kind === "slum" ? kind : "storage";
          const tex2 = kind2 === kind ? tex : pick(rng, ROOM_TEX[kind2]);
          reserve(back, kind2);
          space(`${s.name}_${side}${z}_${u}_b`, back, tex2);
          roomsMade.count++;
          const wall0 = out < 0 ? back[axis === "x" ? 4 : 3] : back[axis === "x" ? 1 : 0] - WALL;
          const ib = axis === "x" ? [du, wall0, z, du + DOOR.w, wall0 + WALL, z + DOOR.h] : [wall0, du, z, wall0 + WALL, du + DOOR.w, z + DOOR.h];
          doorway(`${s.name}_${side}${z}_${u}_bd`, ib, tex, chance(rng, 0.5) ? { tex: DOOR_TEX[kind2] ?? "homedoor1dn" } : null);
          bag.detail.push(...furnish(kind2, [back[0], back[1], back[3], back[4]], z, doorSide, rng));
          const [c2, b2] = ROOM_LIGHT[kind2];
          bag.entities.push(lamp([(back[0] + back[3]) / 2, (back[1] + back[4]) / 2, z + ROOM_H - 24], c2, b2 * 0.8));
        }
      }
      // a shop's or a bar's sign: a blade standing out from the wall beside its door, read from along the street
      if ((kind === "shop" || kind === "bar") && z === s.floor && s.kind !== "mese") {
        const sign = chance(rng, 0.65) ? pick(rng, SIGNS_MESH) : pick(rng, SIGNS_SOLID);
        const [n0, n1] = out < 0 ? [edge + 8, edge + 88] : [edge - 88, edge - 8];
        const sb = axis === "x" ? [du - 12, n0, z + 96, du - 8, n1, z + 152] : [n0, du - 12, z + 96, n1, du - 8, z + 152];
        bag.entities.push(M.brushEntity("func_illusionary", [M.box([sb[0], sb[1], sb[2]], [sb[3], sb[4], sb[5]], sign)], sign.startsWith("{") ? { rendermode: 4, renderamt: 255 } : {}));
        const off = out < 0 ? 40 : -40;
        bag.entities.push(lamp(axis === "x" ? [du + 32, edge + off, z + 136] : [edge + off, du + 32, z + 136], pick(rng, NEON), 150));
      }
      u = (axis === "x" ? box[3] : box[4]) + WALL;
    }
  }

  // ======== WHAT STANDS IN THE STREETS: galleries, lamps, debris, stalls, machines, shacks ==================
  for (const s of streets) {
    const [x0, y0, x1, y1] = s.rect;
    const style = STYLES[s.style];
    const top = s.ceiling;
    // the galleries' walkways along both walls, at every gallery level
    if (s.kind !== "mese") {
      const levels = s.kind === "atrium" ? s.galleries : s.galleries;
      for (const g of levels) {
        const z = s.floor + g;
        const runs = s.both
          ? [["x", "lo"], ["x", "hi"], ["y", "lo"], ["y", "hi"]]
          : [[s.axis, "lo"], [s.axis, "hi"]];
        for (const [ax, side] of runs) {
          const wb = ax === "x"
            ? side === "lo" ? [x0, y0, z - 16, x1, y0 + 64, z] : [x0, y1 - 64, z - 16, x1, y1, z]
            : side === "lo" ? [x0, y0, z - 16, x0 + 64, y1, z] : [x1 - 64, y0, z - 16, x1, y1, z];
          bag.detail.push(M.box([wb[0], wb[1], wb[2]], [wb[3], wb[4], wb[5]], { top: "sinfuturefloor", bottom: "metal5", sides: "metal5" }));
          const rb = ax === "x"
            ? side === "lo" ? [x0, y0 + 60, z, x1, y0 + 64, z + 40] : [x0, y1 - 64, z, x1, y1 - 60, z + 40]
            : side === "lo" ? [x0 + 60, y0, z, x0 + 64, y1, z + 40] : [x1 - 64, y0, z, x1 - 60, y1, z + 40];
          bag.detail.push(M.box([rb[0], rb[1], rb[2]], [rb[3], rb[4], rb[5]], "metal25dn"));
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
        if (top - s.floor < 900) bag.detail.push(M.box([snap(lx, 4) - 24, snap(ly, 4) - 8, top - 6], [snap(lx, 4) + 24, snap(ly, 4) + 8, top], s.kind === "avenue" ? "CeilingLightBlu" : "holight7"));
      }
    }
    // the mess on the floor
    const len = s.axis === "x" ? x1 - x0 : y1 - y0;
    if (style.mess > 0 && s.kind !== "court") bag.detail.push(...debris(s.rect, s.axis, s.floor, Math.round((len / 640) * style.mess), rng, DEBRIS));
    if (s.stalls) bag.add(stalls(s, rng));
    if (s.machines) bag.add(machines(s, rng));
    if (s.shacks) for (let k = 0; k < 7; k++) bag.add(shack([within(rng, x0 + 160, x1 - 320), within(rng, y0 + 160, y1 - 288)], rng));
    if (s.kind === "court" && s.style === "heights") {
      for (const [cx, cy] of [[3808, 4128], [4256, 4448], [4032, 4288]]) bag.detail.push(M.cylinder("z", [cx, cy], 96, 0, 24, { top: "cd_grass", bottom: "stonewall1", sides: "sinmarblewall" }, { sides: 12, snap: 1 }));
      bag.detail.push(...column([4032, 4288], 24, 24, 256, "sinmarblewall", "singold"));
    }
  }

  // ======== THE NEXUS, standing in the well ================================================================
  bag.add(nexus());

  // ======== WHERE PLAYERS START ============================================================================
  const spread = [];
  for (const p of starts) if (spread.every((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) > 900)) spread.push(p);
  for (const [x, y, z] of spread.slice(0, 40)) bag.entities.push(M.playerStart([snap(x), snap(y), z], within(rng, 0, 360, 45), "info_player_deathmatch"));
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * 2 * Math.PI + Math.PI / 8;
    bag.entities.push(M.playerStart([Math.round(1450 * Math.cos(a)), Math.round(1450 * Math.sin(a)), 0], Math.round(((a * 180) / Math.PI + 180) % 360), "info_player_deathmatch"));
  }
  for (const [x, y] of [[-2560, -6000], [2560, -6000], [-1800, -7700], [1800, -7700]]) bag.entities.push(M.playerStart([x, y, 0], 90, "info_player_deathmatch"));
  bag.notes.push(`${roomsMade.count} rooms, ${roomsMade.doors} doors, ${streets.length} streets, ${spread.length} spread starts`);
  return { bag, streets, occ };
}

// ---- the pieces that stand in a hall or in the open ------------------------------------------------------
/** The Bazaar's stalls: counters under striped awnings, in rows down the hall. */
function stalls(s, rng) {
  const out = new Bag();
  const [x0, y0, x1, y1] = s.rect;
  for (let x = x0 + 192; x < x1 - 192; x += 256)
    for (let y = y0 + 160; y < y1 - 160; y += 224) {
      if (rng() < 0.15) continue;
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
  for (const [fx, fy] of [[x + 640, y + 384], [x + 256, y - 128]]) {
    out.detail.push(M.cylinder("z", [fx, fy], 20, 0, 8, "stonewall1", { sides: 8, snap: 1 }));
    out.entities.push(M.pointEntity("env_sprite", [fx, fy, 40], { model: "sprites/fire.spr", rendermode: 5, renderamt: 255, framerate: 12, scale: 0.6, spawnflags: 1 }));
    out.entities.push(lamp([fx, fy, 64], [255, 130, 50], 260));
  }
  out.entities.push(lamp([x + 256, y + 320, 330], [255, 140, 70], 120));
  out.entities.push(plate([x + 600, y + d - t - 4, 96], [x + 760, y + d - t, 200], "{ax_msr", { rendercolor: "255 60 60" }));
  return out;
}

/** The MSR Nexus: the grand steps, the domed hall, the spire, and the bridges out to the well's walls. */
function nexus() {
  const out = new Bag();
  const MARBLE = { top: "marb", bottom: "marb", sides: "sinmarblewall" };
  const STEEL = "stec_panel5b";
  const GOLD = "singold";
  // the two tiers and the grand steps on all four sides
  out.world.push(M.box([-928, -928, 0], [928, 928, 176], MARBLE));
  out.world.push(M.box([-576, -576, 176], [576, 576, 352], MARBLE));
  for (const d of ["n", "e", "s", "w"]) {
    const f = FRAMES[d];
    for (const [u0, u1, z0] of [[928, 1280, 0], [576, 928, 176]]) {
      const b = fbox(f, [u0, -256, z0, u1, 256, z0 + 176]);
      out.world.push(...M.stairs([b[0], b[1], b[2]], [b[3], b[4], b[5]], f.dir["-u"], { top: "marb", bottom: "marb", sides: "sinmarblewall" }, { tread: 32, ramp: "CLIP" }));
    }
    // pedestals with lamps at the foot and the head of the steps
    for (const [u, z] of [[1312, 0], [960, 176], [608, 352]])
      for (const v of [-320, 320]) {
        const p = fbox(f, [u, v - 40, z, u + 80, v + 40, z + 96]);
        out.detail.push(M.box([p[0], p[1], p[2]], [p[3], p[4], p[5]], { top: GOLD, bottom: "marb", sides: "sinmarblewall" }));
        out.entities.push(lamp([(p[0] + p[3]) / 2, (p[1] + p[4]) / 2, z + 128], [190, 140, 255], 200));
      }
  }
  // the hall: an octagon of walls on the upper tier, doors on the four steps, a ward door and an upper door over each
  const t = (a) => Math.round(a * 0.414214);
  const verts = (a) => [[a, t(a)], [t(a), a], [-t(a), a], [-a, t(a)], [-a, -t(a)], [-t(a), -a], [t(a), -a], [a, -t(a)]];
  const [IN, OUTER] = [448, 480];
  const vi = verts(IN);
  const vo = verts(OUTER);
  const hallWall = { top: STEEL, bottom: "sinceiling3", sides: "sinmarblewall" };
  const [Z0, Z1] = [352, 1408];
  for (let k = 0; k < 8; k++) {
    const q = [vi[k], vi[(k + 1) % 8], vo[(k + 1) % 8], vo[k]];
    if (k % 2 === 0) {
      out.world.push(M.prism("z", q, Z0, Z1, hallWall));
      continue;
    }
    // a flat wall: the corner pieces whole, the middle cut by the doors
    const d = { 1: "n", 3: "w", 5: "s", 7: "e" }[k];
    const f = FRAMES[d];
    const L = (u0, v0, u1, v1, z0, z1) => {
      const b = fbox(f, [u0, v0, z0, u1, v1, z1]);
      out.world.push(M.box([b[0], b[1], b[2]], [b[3], b[4], b[5]], hallWall));
    };
    // corner pieces as prisms in the frame: from the octagon's corner to the middle span
    for (const sgn of [-1, 1]) {
      const pts = [[IN, sgn * t(IN)], [IN, sgn * 96], [OUTER, sgn * 96], [OUTER, sgn * t(OUTER)]].map(([u, v]) => f.p(u, v));
      out.world.push(M.prism("z", pts, Z0, Z1, hallWall));
    }
    L(IN, -96, OUTER, 96, 608, 704);
    L(IN, -96, OUTER, -64, 704, 896);
    L(IN, 64, OUTER, 96, 704, 896);
    L(IN, -96, OUTER, 96, 896, 1056);
    L(IN, -96, OUTER, 96, 1216, Z1);
    // the great doors: two gates of wrought iron that swing in
    for (const sgn of [-1, 1]) {
      const leaf = fbox(f, [IN + 8, sgn > 0 ? 0 : -96, Z0, IN + 16, sgn > 0 ? 96 : 0, 608]);
      const hinge = f.p(IN + 12, sgn * 96);
      out.entities.push(M.brushEntity("func_door_rotating", [M.box([leaf[0], leaf[1], leaf[2]], [leaf[3], leaf[4], leaf[5]], "{cxgate"), M.originBrush([hinge[0], hinge[1], 480])], { distance: 90, speed: 70, wait: 6, rendermode: 4, renderamt: 255, spawnflags: sgn > 0 ? 0 : 2 }));
    }
    // the ward bridge: an enclosed tube to the well's wall, its windows glazed
    const tube = (u0, v0, u1, v1, z0, z1, tex) => {
      const b = fbox(f, [u0, v0, z0, u1, v1, z1]);
      out.world.push(M.box([b[0], b[1], b[2]], [b[3], b[4], b[5]], tex));
    };
    tube(OUTER, -80, WELL, 80, 688, 704, { top: "gratefloor", bottom: STEEL, sides: STEEL });
    tube(OUTER, -80, WELL, 80, 896, 912, STEEL);
    for (const v0 of [-80, 64]) {
      tube(OUTER, v0, WELL, v0 + 16, 704, 752, STEEL);
      tube(OUTER, v0, WELL, v0 + 16, 848, 896, STEEL);
      for (let u = OUTER; u < WELL; u += 192) tube(u, v0, Math.min(u + 16, WELL), v0 + 16, 752, 848, STEEL);
      const g = fbox(f, [OUTER, v0 + 7, 752, WELL, v0 + 9, 848]);
      out.entities.push(M.brushEntity("func_wall", [M.box([g[0], g[1], g[2]], [g[3], g[4], g[5]], "glass_dark")], { rendermode: 2, renderamt: 80 }));
    }
    tube(1440, -48, 1504, 48, 0, 688, { top: STEEL, bottom: STEEL, sides: "wallvault2" });
    for (let u = 640; u < WELL; u += 448) out.entities.push(lamp([...f.p(u, 0), 872], [170, 110, 255], 120));
    // the upper bridge: open, railed, lamplit, from the Mese to the hall
    tube(OUTER, -96, WELL, 96, 1040, 1056, { top: "marb", bottom: STEEL, sides: GOLD });
    for (const v0 of [-96, 92]) tube(OUTER, v0, WELL, v0 + 4, 1056, 1096, GOLD);
    for (const u of [800, 1300])
      for (const v of [-84, 84]) {
        const [px, py] = f.p(u, v);
        out.detail.push(M.cylinder("z", [px, py], 5, 1056, 1248, GOLD, { sides: 8, snap: 1 }));
        out.entities.push(lamp([px, py, 1236], [255, 220, 170], 160));
      }
  }
  // the hall's floors round its walls: a balcony at the ward level and one at the upper city's
  const ring = (a0, a1, z0, z1, tex, skip = []) => {
    const p = verts(a0);
    const q = verts(a1);
    for (let k = 0; k < 8; k++) if (!skip.includes(k)) out.detail.push(M.prism("z", [p[k], p[(k + 1) % 8], q[(k + 1) % 8], q[k]], z0, z1, tex));
  };
  ring(352, IN, 688, 704, { top: "marb", bottom: "sinceiling3", sides: GOLD });
  ring(352, IN, 1040, 1056, { top: "marb", bottom: "sinceiling3", sides: GOLD });
  // the railings stop where the two stairs come up, in the north-east and south-west corners
  ring(344, 352, 704, 744, GOLD, [0, 4]);
  ring(344, 352, 1056, 1096, GOLD, [0, 4]);
  // the stairs between them, in two corners
  for (const deg of [45, 225]) {
    const a = (deg * Math.PI) / 180;
    const sweep = (32 / 56) * (180 / Math.PI);
    const { brushes } = M.spiralStairs({ centre: [Math.round(250 * Math.cos(a)), Math.round(250 * Math.sin(a))], inner: 24, outer: 88, from: 352, to: 1056, start: deg + sweep / 2, rise: 16, tread: 32, thick: 16, texture: "sinmarblewall", columnTexture: GOLD });
    out.detail.push(...brushes);
  }
  // columns at the corners, the dais and its seat, banners, sconces, the chandelier
  for (let k = 0; k < 8; k++) {
    const a = ((22.5 + 45 * k) * Math.PI) / 180;
    out.detail.push(...column([Math.round(400 * Math.cos(a)), Math.round(400 * Math.sin(a))], 22, 352, Z1, "marb", GOLD));
  }
  out.detail.push(M.cylinder("z", [0, 0], 176, 352, 368, { top: "sinpalacefloor", bottom: "marb", sides: GOLD }, { sides: 8, snap: 1 }));
  out.detail.push(M.box([-40, 72, 368], [40, 120, 400], { top: "redcarpet", bottom: "redcarpet", sides: GOLD }));
  out.detail.push(M.box([-40, 120, 368], [40, 136, 496], { top: GOLD, bottom: GOLD, sides: "redcarpet" }));
  for (const deg of [135, 315]) {
    const a = (deg * Math.PI) / 180;
    const c = [Math.round(440 * Math.cos(a)), Math.round(440 * Math.sin(a))];
    const banner = M.turned([M.box([c[0] - 2, c[1] - 64, 392], [c[0] + 2, c[1] + 64, 664], "{ax_msr")], deg, [c[0], c[1], 0], { lock: true, snap: 1 });
    out.entities.push(M.brushEntity("func_wall", banner, { rendermode: 4, renderamt: 255 }));
  }
  for (let k = 0; k < 8; k++) {
    const a = ((45 * k) * Math.PI) / 180;
    out.entities.push(lamp([Math.round(420 * Math.cos(a)), Math.round(420 * Math.sin(a)), 560], [175, 110, 255], 170));
  }
  // the dome: six rings stepping in over the hall, gold underneath, steel on top, and its cap
  for (let k = 0; k < 6; k++) {
    const p = verts(448 - 56 * k);
    const q = verts(480 - 40 * k);
    const z0 = Z1 + 64 * k;
    for (let i = 0; i < 8; i++) {
      const mid = (((i + 0.5) * 45 + 22.5) * Math.PI) / 180;
      const way = [Math.cos(mid), Math.sin(mid)];
      out.world.push(M.prism("z", [p[i], p[(i + 1) % 8], q[(i + 1) % 8], q[i]], z0, z0 + 64, (n) => (n[2] < -0.5 ? "sinceiling3" : n[2] > 0.5 ? STEEL : n[0] * way[0] + n[1] * way[1] < 0 ? "sinceiling3" : STEEL)));
    }
  }
  const capZ = Z1 + 384;
  out.world.push(M.prism("z", verts(288), capZ, capZ + 32, { top: STEEL, bottom: "sinceiling3", sides: GOLD }));
  const ch = M.chandelier({ centre: [0, 0], top: capZ, drop: 360, radius: 80, tiers: 4, glass: "glass_yellow1", metal: GOLD });
  out.detail.push(...ch.brushes);
  out.entities.push(lamp(ch.light, [235, 210, 255], 520));
  // the spire, banded in gold, crowned, a beacon on top
  const spire0 = capZ + 32;
  out.world.push(M.cylinder("z", [0, 0], 112, spire0, 3584, STEEL, { sides: 8, snap: 1 }));
  for (let z = spire0 + 192; z < 3500; z += 256) out.detail.push(M.cylinder("z", [0, 0], 128, z, z + 32, GOLD, { sides: 8, snap: 1 }));
  for (const d of ["n", "e", "s", "w"]) {
    const f = FRAMES[d];
    const fin = [[112, -8], [288, -8], [288, 8], [112, 8]].map(([u, v]) => f.p(u, v));
    out.detail.push(M.prism("z", fin, spire0, spire0 + 384, STEEL));
  }
  out.detail.push(M.cone("z", [0, 0], 144, 3584, 3968, GOLD, { sides: 8 }));
  out.entities.push(lamp([0, 0, 3700], [190, 120, 255], 900));
  out.entities.push(M.pointEntity("env_sprite", [0, 0, 3990], { model: "sprites/flare6.spr", rendermode: 5, renderamt: 255, rendercolor: "200 140 255", scale: 3, spawnflags: 1 }));
  // the well's own walls: lit windows in rows, the MSR's banners, a screen on every corner
  for (const d of ["n", "e", "s", "w"]) {
    const f = FRAMES[d];
    let lit = 0;
    for (let z = 1600; z < 4000; z += 352)
      for (let v = -1152; v <= 1152; v += 384) {
        if (z < 2300 && Math.abs(v) < 400) continue;
        const b = fbox(f, [WELL - 2, v - 32, z, WELL, v + 32, z + 96]);
        out.detail.push(M.box([b[0], b[1], b[2]], [b[3], b[4], b[5]], lit++ % 4 === 3 ? "glass_dark" : "glass_yellow1"));
      }
    const bb = fbox(f, [WELL - 6, -160, 1600, WELL - 2, 160, 2240]);
    out.entities.push(plate([bb[0], bb[1], bb[2]], [bb[3], bb[4], bb[5]], "{ax_msr"));
    for (let z = 1504; z < 4200; z += 704) {
      const tb = fbox(f, [WELL - 8, -1216, z, WELL, 1216, z + 16]);
      out.detail.push(M.box([tb[0], tb[1], tb[2]], [tb[3], tb[4], tb[5]], GOLD));
    }
    out.entities.push(lamp([...f.p(WELL - 200, 0), 2400], [180, 120, 255], 500));
  }
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * 2 * Math.PI + Math.PI / 8;
    const [x, y] = [Math.round(1480 * Math.cos(a)), Math.round(1480 * Math.sin(a))];
    out.detail.push(M.cylinder("z", [x, y], 8, 0, 320, "metal5", { sides: 8, snap: 1 }));
    out.detail.push(M.box([x - 20, y - 20, 320], [x + 20, y + 20, 336], { top: "metal5", bottom: "glass_yellow1", sides: GOLD }));
    out.entities.push(lamp([x, y, 300], [215, 190, 255], 260));
  }
  out.entities.push(M.pointEntity("light_environment", [0, 0, Z.wellSky - 64], { angles: "-70 140 0", pitch: -70, _light: "55 65 115 30" }));
  return out;
}
