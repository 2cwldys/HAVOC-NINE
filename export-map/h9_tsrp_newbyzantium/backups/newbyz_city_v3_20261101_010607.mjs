// h9_tsrp_newbyzantium: New Byzantium, Alexandria's sister city -- a sci-fi, dystopian roleplay city at night.
// STUDY.md is the brief and refs\ the three cities it is measured against; the plan builds it in slices.
//
// THE CORE: nine districts in a square, each built from the inside out -- the hab towers to the north, the
// market to the east, the works to the west, the slums to the south, the MSR Nexus in the middle -- and under
// all of them the sewer city: tunnels beneath every street line, a canal of foul water down each, chambers
// under the crossings, and manholes with ladders up to the streets. In a district every building is
// rooms first: a ground floor that is a shop, a bar, a lab or an MSR post, each with its own walls, floor and
// light, and a street door; flats above, two a floor, wood-panelled and carpeted and warm-lit, reached by
// stairs that switch back floor to floor; windows that glow from the rooms behind them. The outside is laid
// over that: Xenon's trim bands at every floor, a cornice and parapet, vents on the roof, the shops' signs
// with a neon light each. The streets are what is left between the buildings: a main street, a cross
// street, alleys, with grates, crates and debris, and a few coloured lamps under the night.
//
// The textures are the three cities' own (Alexandria's and Xenon's pulled out of their .bsp, Paradise's) and
// The Specialists' packs, never Valve's: the map embeds what it wears, and H9 ships no Valve content.
//
//   node city.mjs                 write out\h9_tsrp_newbyzantium.map, and check it
//   node city.mjs --compile       and compile it (Xash limits)
//   node city.mjs --views         draw the compiled map from street level, into out\views
//   node city.mjs deploy          copy the .bsp into H9XASH's and the game's ts\maps
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GAME_DIR, K, M } from "../lib.mjs";
import { WADS as CITY_WADS } from "../h9_tsrp_hive/wads.mjs";
import { SKY_NAME } from "./sky.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const NAME = "h9_tsrp_newbyzantium";
const COMPILERS = join(HERE, "..", "sdhlt-goldsrc-net", "tools");
const H9XASH_MAPS = join(HERE, "..", "..", "H9XASH", "ts", "maps");
/** The wads it builds from: the cities' and The Specialists', not Valve's (halflife, liquids, xeno, decals). */
const VALVE_WADS = new Set(["halflife", "liquids", "xeno", "decals"]);
const WADS = Object.fromEntries(Object.entries(CITY_WADS).filter(([name, path]) => !VALVE_WADS.has(name) && existsSync(path)));

// ---- the materials, from the reference pictures ----------------------------------------------------
const T = {
  sky: "sky",
  street: "Pavement001",
  grate: "e6basegrate",
  // outside
  shopFace: ["cyberwall2", "cyberwall4", "stec_panel3", "cyberwall6"],
  upperFace: ["stec_panel5", "cyberwall1", "metal_wall01b", "wall_grey05"],
  labFace: "cds_lab4",
  msrFace: "stec_panel5b",
  trim: "cyberwallpanel",
  cornice: "d_drkmtl_mpanel",
  roof: "flr_grey02",
  // inside
  flatWall: "cd_woodwall",
  flatFloor: ["cd_carpred", "cd_carpblue", "greencarpet"],
  shopWall: "cyberwall3",
  shopFloor: "cyberfloor",
  barWall: "cyberbar",
  labWall: "cds_lab7",
  labFloor: "flr_grey02",
  msrWall: "stec_panel3",
  msrFloor: "gratefloor",
  stair: "metal13dn",
  rail: "metal25dn",
  // the openings
  door: { shop: "cyberdoor", bar: "cyberdoor4", lab: "cds_whitedoor", msr: "bigcyberdoor", flat: "homedoor1dn" },
  shutter: "{pkf_shopgrate1",
  glass: "glass_a_03",
  // the street's dressing
  crate: ["xcrate11c", "xcrate11d", "bcrate09a"],
  rubble: ["PRXCNCRT10A", "PRXCNCRT5A", "pkf_concrete1"],
  vent: "machblank02b",
  monitor: "cypermonitor",
};
const SIGNS = ["{xc_guns", "{xc_gear", "{xc_skybar", "{xc_enjoy", "{xc_uncle", "{PC_BANK", "{PC_PAWNPRAWN", "{PC_SNACK", "{PC_SKYTECH", "{PC_GEARGUYS", "{PC_SUB", "{PC_CYB"];
const NEON = [[90, 230, 255], [190, 110, 255], [120, 255, 150], [255, 90, 160]];

// ---- the plan --------------------------------------------------------------------------------------
const HALF = 1280;            // the district reaches +/-HALF
const SKY_TOP = 2304;
const MAIN = 144;             // the main street, north to south, is 2 x MAIN wide
const CROSS = 128;            // the cross street, east to west
const ALLEY = 112;            // between the buildings of a quarter
const STOREY = 176;           // floor to floor: a person's height and a ceiling, as the cities measure
const SLAB = 16;              // a floor's thickness
const SKIN = 8;               // each of a wall's two layers
const WALL = SKIN * 2;
const DOOR = { w: 64, h: 112 };

/** A repeatable run of numbers from 0 to 1. */
function numbers(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rng, list) => list[Math.floor(rng() * list.length)];
const snap = (v, g = 16) => Math.round(v / g) * g;

/**
 * A wall along x (axis "x": from a0 to a1 at y = at, t thick into +y) or along y (axis "y": at x = at), with
 * holes cut in it, each { from, to, bottom, top } along its length and height. The boxes round the holes.
 */
function wall(axis, a0, a1, at, t, z0, z1, holes, tex) {
  const boxes = [];
  const box = (s0, s1, h0, h1) => {
    if (s1 - s0 < 1 || h1 - h0 < 1) return;
    boxes.push(axis === "x" ? M.box([s0, at, h0], [s1, at + t, h1], tex) : M.box([at, s0, h0], [at + t, s1, h1], tex));
  };
  const cuts = holes.filter((h) => h.to > a0 && h.from < a1).sort((p, q) => p.from - q.from);
  let s = a0;
  for (const h of cuts) {
    box(s, h.from, z0, z1);
    box(h.from, h.to, z0, h.bottom);
    box(h.from, h.to, h.top, z1);
    s = h.to;
  }
  box(s, a1, z0, z1);
  return boxes;
}

/**
 * One building, rooms first. lot [x0, y0, x1, y1]; front, the side on its street ("n", "s", "e", "w"); kind
 * "shop" | "bar" | "lab" | "msr"; floors 1 to 4. Its brushes and entities by kind.
 */
function building(lot, front, kind, floors, rng, style) {
  const [x0, y0, x1, y1] = lot;
  const out = { world: [], detail: [], glass: [], doors: [], lights: [], signs: [], spawns: [] };
  const H = floors * STOREY;
  const outside = kind === "lab" ? T.labFace : kind === "msr" ? T.msrFace : pick(rng, style.shopFace);
  const upper = kind === "lab" ? T.labFace : kind === "msr" ? T.msrFace : pick(rng, style.upperFace);
  const groundWall = { shop: T.shopWall, bar: T.barWall, lab: T.labWall, msr: T.msrWall }[kind];
  const groundFloor = { shop: T.shopFloor, bar: T.shopFloor, lab: T.labFloor, msr: T.msrFloor }[kind];
  const groundLight = { shop: pick(rng, NEON), bar: [200, 90, 255], lab: [200, 230, 255], msr: [170, 110, 255] }[kind];
  const flatFloor = pick(rng, T.flatFloor);
  const along = front === "n" || front === "s"; // the front wall runs along x
  const inner = [x0 + WALL, y0 + WALL, x1 - WALL, y1 - WALL];

  const frontAt = { n: y1 - WALL, s: y0, e: x1 - WALL, w: x0 }[front];
  const frontSpan = along ? [x0, x1] : [y0, y1];
  const mid = snap((frontSpan[0] + frontSpan[1]) / 2);
  const wide = kind === "shop" || kind === "bar" ? 128 : DOOR.w;
  const dh = DOOR.h + (wide > 64 ? 16 : 0);
  const windows = (span, z) => {
    const holes = [];
    for (let s = span[0] + 96; s + 64 <= span[1] - 96; s += 160) holes.push({ from: s, to: s + 64, bottom: z + 64, top: z + 128 });
    return holes;
  };
  // the stairs: two strips by the side wall, used in turn, so each flight comes up beside the next
  const strip = (n) => {
    const w = 64, run = 11 * 24;
    if (along) {
      const sx = n % 2 === 0 ? inner[0] : inner[0] + w;
      return { box: [sx, inner[1] + 48, sx + w, inner[1] + 48 + run], high: n % 2 ? "-y" : "+y" };
    }
    const sy = n % 2 === 0 ? inner[1] : inner[1] + w;
    return { box: [inner[0] + 48, sy, inner[0] + 48 + run, sy + w], high: n % 2 ? "-x" : "+x" };
  };

  for (let k = 0; k < floors; k++) {
    const z = k * STOREY;
    const zTop = z + STOREY;
    const skinOut = k === 0 ? outside : upper;
    const skinIn = k === 0 ? groundWall : T.flatWall;
    // the four walls, each two skins: the street's material outside, the room's inside
    for (const side of ["n", "s", "e", "w"]) {
      const runsX = side === "n" || side === "s";
      const span = runsX ? [x0, x1] : [y0 + WALL, y1 - WALL];
      const at = { n: y1 - WALL, s: y0, e: x1 - WALL, w: x0 }[side];
      let holes = [];
      if (side === front) {
        holes = k === 0
          ? [{ from: mid - wide / 2, to: mid + wide / 2, bottom: z + SLAB, top: z + SLAB + dh }, ...windows(span, z).filter((h) => h.to < mid - wide / 2 - 32 || h.from > mid + wide / 2 + 32)]
          : windows(span, z);
      } else if (k > 0) {
        holes = windows(span, z).filter((_, i) => i % 2 === 0);
      }
      const outerAt = side === "n" || side === "e" ? at + SKIN : at;
      const innerAt = side === "n" || side === "e" ? at : at + SKIN;
      out.world.push(...wall(runsX ? "x" : "y", span[0], span[1], outerAt, SKIN, z, zTop, holes, skinOut));
      out.world.push(...wall(runsX ? "x" : "y", span[0], span[1], innerAt, SKIN, z, zTop, holes, skinIn));
      // glass in every window, in the middle of the wall
      for (const h of holes.filter((h) => h.bottom > z + SLAB)) {
        const c = at + WALL / 2;
        out.glass.push(runsX ? M.box([h.from, c - 1, h.bottom], [h.to, c + 1, h.top], T.glass) : M.box([c - 1, h.from, h.bottom], [c + 1, h.to, h.top], T.glass));
      }
    }

    if (k === 0) {
      out.world.push(M.box([inner[0], inner[1], 0], [inner[2], inner[3], SLAB], groundFloor));
    } else {
      // the floor slab, holed where the flight from below comes up, and railed round the hole but at its top
      const s = strip(k - 1);
      const st = s.box;
      const parts = [
        [inner[0], inner[1], inner[2], st[1]],
        [inner[0], st[3], inner[2], inner[3]],
        [inner[0], st[1], st[0], st[3]],
        [st[2], st[1], inner[2], st[3]],
      ];
      for (const [a, b, c, d] of parts) if (c - a > 1 && d - b > 1) out.world.push(M.box([a, b, z], [c, d, z + SLAB], flatFloor));
      const rz = [z + SLAB, z + SLAB + 40];
      if (along) {
        out.detail.push(M.box([st[2], st[1], rz[0]], [st[2] + 4, st[3], rz[1]], T.rail));
        if (s.high !== "-y") out.detail.push(M.box([st[0], st[1] - 4, rz[0]], [st[2], st[1], rz[1]], T.rail));
        if (s.high !== "+y") out.detail.push(M.box([st[0], st[3], rz[0]], [st[2], st[3] + 4, rz[1]], T.rail));
      } else {
        out.detail.push(M.box([st[0], st[3], rz[0]], [st[2], st[3] + 4, rz[1]], T.rail));
        if (s.high !== "-x") out.detail.push(M.box([st[0] - 4, st[1], rz[0]], [st[0], st[3], rz[1]], T.rail));
        if (s.high !== "+x") out.detail.push(M.box([st[2], st[1], rz[0]], [st[2] + 4, st[3], rz[1]], T.rail));
      }
    }
    if (k < floors - 1) {
      const s = strip(k);
      out.detail.push(...M.stairs([s.box[0], s.box[1], z + SLAB], [s.box[2], s.box[3], zTop], s.high, T.stair, { tread: 24, ramp: "CLIP" }));
    }

    if (k > 0) {
      // two flats a floor, a wall between with a door in it, each warm-lit
      const split = along ? snap((inner[0] + inner[2]) / 2) + 64 : snap((inner[1] + inner[3]) / 2) + 64;
      const d0 = (along ? inner[1] : inner[0]) + 96;
      const door = { from: d0, to: d0 + DOOR.w, bottom: z + SLAB, top: z + SLAB + DOOR.h };
      out.world.push(...wall(along ? "y" : "x", along ? inner[1] : inner[0], along ? inner[3] : inner[2], split, WALL, z + SLAB, zTop, [door], T.flatWall));
      const leaf = along ? M.box([split + 4, door.from, door.bottom], [split + WALL - 4, door.to, door.top], T.door.flat)
        : M.box([door.from, split + 4, door.bottom], [door.to, split + WALL - 4, door.top], T.door.flat);
      out.doors.push(M.brushEntity("func_door", [leaf], { angles: "-90 0 0", speed: 120, wait: 3, lip: 8 }));
      const warm = [255, 190 + Math.floor(rng() * 30), 120];
      const c1 = along ? [(inner[0] + split) / 2, (inner[1] + inner[3]) / 2] : [(inner[0] + inner[2]) / 2, (inner[1] + split) / 2];
      const c2 = along ? [(split + WALL + inner[2]) / 2, (inner[1] + inner[3]) / 2] : [(inner[0] + inner[2]) / 2, (split + WALL + inner[3]) / 2];
      for (const [cx, cy] of [c1, c2]) out.lights.push(M.light([snap(cx), snap(cy), zTop - 24], { color: warm, brightness: 150 }));
    } else {
      // the ground floor: one room in its own light, with a counter or a console so it reads as what it is
      const [cx, cy] = [snap((x0 + x1) / 2), snap((y0 + y1) / 2)];
      out.lights.push(M.light([cx, cy, STOREY - 24], { color: groundLight, brightness: 200 }));
      const counter = kind === "lab" || kind === "msr" ? T.monitor : kind === "bar" ? T.barWall : T.shopWall;
      out.detail.push(M.box([cx - 64, cy - 16, SLAB], [cx + 64, cy + 16, SLAB + 40], counter));
      out.spawns.push([cx + (along ? 0 : 96), cy + (along ? 96 : 0), SLAB + 36]);
    }
    if (k === floors - 1) out.world.push(M.box([x0, y0, zTop - SLAB], [x1, y1, zTop], T.roof));
  }

  // the street door: a shutter for a shop or a bar, a door for the rest
  const doorTex = kind === "shop" || kind === "bar" ? T.shutter : T.door[kind];
  const db = along ? M.box([mid - wide / 2, frontAt + 4, SLAB], [mid + wide / 2, frontAt + WALL - 4, SLAB + dh], doorTex)
    : M.box([frontAt + 4, mid - wide / 2, SLAB], [frontAt + WALL - 4, mid + wide / 2, SLAB + dh], doorTex);
  out.doors.push(M.brushEntity("func_door", [db], { angles: "-90 0 0", speed: 140, wait: 4, lip: 8, rendermode: doorTex.startsWith("{") ? 4 : 0, renderamt: 255 }));

  // the outside: a trim band at every floor line, the cornice at the top, a parapet, a vent on the roof
  for (let k = 1; k <= floors; k++) {
    const z = k * STOREY - 24;
    const tex = k === floors ? T.cornice : T.trim;
    const o = k === floors ? 24 : 8;
    const h = k === floors ? 40 : 16;
    out.detail.push(M.box([x0 - o, y0 - o, z], [x1 + o, y0, z + h], tex), M.box([x0 - o, y1, z], [x1 + o, y1 + o, z + h], tex));
    out.detail.push(M.box([x0 - o, y0, z], [x0, y1, z + h], tex), M.box([x1, y0, z], [x1 + o, y1, z + h], tex));
  }
  out.detail.push(M.box([x0, y0, H], [x1, y0 + 12, H + 40], T.cornice), M.box([x0, y1 - 12, H], [x1, y1, H + 40], T.cornice));
  out.detail.push(M.box([x0, y0 + 12, H], [x0 + 12, y1 - 12, H + 40], T.cornice), M.box([x1 - 12, y0 + 12, H], [x1, y1 - 12, H + 40], T.cornice));
  const vx = snap(x0 + 48 + rng() * Math.max(16, x1 - x0 - 160)), vy = snap(y0 + 48 + rng() * Math.max(16, y1 - y0 - 160));
  out.detail.push(M.box([vx, vy, H], [vx + 64, vy + 48, H + 56], T.vent));

  // the sign over a shop's or a bar's door, and its neon
  if (kind === "shop" || kind === "bar") {
    const sign = pick(rng, SIGNS);
    const colour = pick(rng, NEON);
    const sz = SLAB + dh + 16;
    const off = front === "n" || front === "e" ? WALL + 4 : -4;
    const sb = along ? M.box([mid - 80, frontAt + off - 2, sz], [mid + 80, frontAt + off + 2, sz + 56], sign)
      : M.box([frontAt + off - 2, mid - 80, sz], [frontAt + off + 2, mid + 80, sz + 56], sign);
    out.signs.push(M.brushEntity("func_wall", [sb], { rendermode: 4, renderamt: 255 }));
    const lo = front === "n" || front === "e" ? 56 : -48;
    out.lights.push(M.light(along ? [mid, frontAt + lo, sz + 24] : [frontAt + lo, mid, sz + 24], { color: colour, brightness: 210 }));
  }
  return out;
}

/** The lots: in each quarter between the two streets, a row along each street and a corner building. */
function lots(rng) {
  const list = [];
  for (const sx of [-1, 1])
    for (const sy of [-1, 1]) {
      const qx0 = sx > 0 ? MAIN : -HALF + 64, qx1 = sx > 0 ? HALF - 64 : -MAIN;
      const qy0 = sy > 0 ? CROSS : -HALF + 64, qy1 = sy > 0 ? HALF - 64 : -CROSS;
      const depth = 448 + Math.round(rng() * 4) * 32;
      const mainX0 = sx > 0 ? qx0 : qx1 - depth, mainX1 = sx > 0 ? qx0 + depth : qx1;
      // along the main street, out from the corner
      let y = sy > 0 ? qy0 + 256 + ALLEY : qy1 - 256 - ALLEY;
      while (sy > 0 ? y < qy1 - 320 : y > qy0 + 320) {
        const len = 384 + Math.round(rng() * 4) * 64;
        const a = sy > 0 ? y : Math.max(y - len, qy0), b = sy > 0 ? Math.min(y + len, qy1) : y;
        list.push({ lot: [mainX0, a, mainX1, b], front: sx > 0 ? "w" : "e" });
        y = sy > 0 ? b + ALLEY : a - ALLEY;
      }
      // along the cross street, past the main street's row and an alley
      let x = sx > 0 ? mainX1 + ALLEY : mainX0 - ALLEY;
      const crossY0 = sy > 0 ? qy0 : qy1 - depth, crossY1 = sy > 0 ? qy0 + depth : qy1;
      while (sx > 0 ? x < qx1 - 320 : x > qx0 + 320) {
        const len = 384 + Math.round(rng() * 4) * 64;
        const a = sx > 0 ? x : Math.max(x - len, qx0), b = sx > 0 ? Math.min(x + len, qx1) : x;
        list.push({ lot: [a, crossY0, b, crossY1], front: sy > 0 ? "s" : "n" });
        x = sx > 0 ? b + ALLEY : a - ALLEY;
      }
      // the corner building, on both streets
      list.push({ lot: [sx > 0 ? qx0 : qx1 - 256, sy > 0 ? qy0 : qy1 - 256, sx > 0 ? qx0 + 256 : qx1, sy > 0 ? qy0 + 256 : qy1], front: sy > 0 ? "s" : "n" });
    }
  return list;
}

/** The streets' dressing: gutter grates, crate stacks and rubble against the walls, coloured lamps. */
function streets(rng, mess = 1) {
  const detail = [];
  const lights = [];
  for (let y = -HALF + 160; y < HALF - 160; y += 320)
    for (const x of [-MAIN + 8, MAIN - 72]) if (Math.abs(y) > CROSS + 64) detail.push(M.box([x, y, 0], [x + 64, y + 64, 2], T.grate));
  for (let i = 0; i < Math.round(26 * mess); i++) {
    const onMain = i % 2 === 0;
    const side = rng() > 0.5 ? 1 : -1;
    const t = snap((rng() * 2 - 1) * (HALF - 200));
    if (Math.abs(t) < CROSS + 96) continue;
    const [x, y] = onMain ? [side * (MAIN - 48), t] : [t, side * (CROSS - 48)];
    if (rng() > 0.4) {
      const tex = pick(rng, T.crate);
      detail.push(M.box([x - 24, y - 24, 0], [x + 24, y + 24, 48], tex));
      if (rng() > 0.5) detail.push(M.box([x - 16, y - 16, 48], [x + 16, y + 16, 80], tex));
    } else {
      for (let j = 0; j < 4; j++) {
        const dx = snap((rng() - 0.5) * 64, 4), dy = snap((rng() - 0.5) * 64, 4), s = 4 + Math.round(rng() * 3) * 4;
        detail.push(M.box([x + dx, y + dy, 0], [x + dx + s * 2, y + dy + s, s], pick(rng, T.rubble)));
      }
    }
  }
  let n = 0;
  for (let t = -HALF + 320; t < HALF - 200; t += 512) {
    for (const [x, y] of [[MAIN - 16, t], [-MAIN + 16, t + 256], [t, CROSS - 16], [t + 256, -CROSS + 16]]) {
      if (Math.abs(x) <= MAIN && Math.abs(y) <= CROSS + 64) continue;
      detail.push(M.box([x - 4, y - 4, 0], [x + 4, y + 4, 224], T.rail));
      lights.push(M.light([x, y, 210], { color: NEON[n++ % 3], brightness: 260 }));
    }
  }
  return { detail, lights };
}

/**
 * The districts' styles: the faces their buildings wear, the kinds of ground floor in turn, how tall they
 * stand, how much the streets are strewn. The hab towers house; the market trades; the works make; the
 * slums get by.
 */
const STYLES = {
  hab: { shopFace: ["stec_panel3", "cyberwall2", "wall_grey05"], upperFace: ["stec_panel5", "wall_grey05", "metal_wall01b"], kinds: ["shop", "shop", "bar", "shop", "msr"], floors: [3, 4], mess: 0.6 },
  market: { shopFace: T.shopFace, upperFace: T.upperFace, kinds: ["shop", "shop", "bar", "shop", "lab", "shop", "msr", "shop", "bar", "lab"], floors: [1, 3], mess: 1 },
  works: { shopFace: ["metal_wall01b", "d_drkmtl_mpanel", "stec_panel5b"], upperFace: ["metal_wall01b", "d_drkmtl_mpanel", "cyberwall6"], kinds: ["lab", "shop", "lab", "msr", "shop"], floors: [1, 3], mess: 1.6 },
  slums: { shopFace: ["pkf_concrete1", "PRXCNCRT5A", "cyberwall6"], upperFace: ["pkf_concrete5a", "PRXCNCRT10A", "pkf_concrete1"], kinds: ["shop", "bar", "shop", "shop"], floors: [1, 2], mess: 2.6 },
};
const SPAN = HALF * 2;              // a district's width; the Core is three by three of them
const CORE = SPAN * 1.5;            // the Core reaches +/-CORE
const LAYOUT = [
  ["hab", -1, 1], ["hab", 0, 1], ["hab", 1, 1],
  ["works", -1, 0], ["nexus", 0, 0], ["market", 1, 0],
  ["works", -1, -1], ["slums", 0, -1], ["slums", 1, -1],
];

/** An entity moved by [dx, dy]: its brushes, or its origin. */
function shifted(e, dx, dy) {
  if (e.brushes) return { ...e, brushes: M.moved(e.brushes, [dx, dy, 0]) };
  if (e.origin) {
    const [x, y, z] = String(e.origin).split(/\s+/).map(Number);
    return { ...e, origin: `${x + dx} ${y + dy} ${z}` };
  }
  return e;
}

/** One district of a style, built round the origin and moved to its place. */
function district(type, cx, cy, rng) {
  const style = STYLES[type];
  const world = [], detail = [], entities = [], spawns = [];
  lots(rng).forEach((l, i) => {
    const kind = style.kinds[i % style.kinds.length];
    const floors = kind === "msr" ? 2 : style.floors[0] + Math.floor(rng() * (style.floors[1] - style.floors[0] + 1));
    const b = building(l.lot, l.front, kind, Math.min(5, floors), rng, style);
    world.push(...b.world);
    detail.push(...b.detail);
    entities.push(...b.lights, ...b.doors, ...b.signs, ...b.glass.map((g) => M.brushEntity("func_wall", [g], { rendermode: 2, renderamt: 90 })));
    spawns.push(...b.spawns.map(([x, y, z]) => [x + cx, y + cy, z]));
  });
  const st = streets(rng, style.mess);
  detail.push(...st.detail);
  entities.push(...st.lights);
  return {
    world: M.moved(world, [cx, cy, 0]),
    detail: M.moved(detail, [cx, cy, 0]),
    entities: entities.map((e) => shifted(e, cx, cy)),
    spawns,
  };
}

/** The MSR Nexus's tile: a plaza, the compound wall with four gates, the spire and its crown. */
function nexus() {
  const world = [], entities = [];
  const R = 900, H = 384;
  world.push(M.box([-HALF + 64, -HALF + 64, 0], [HALF - 64, HALF - 64, 8], "flr_panel02"));
  const pieces = 16;
  for (let i = 0; i < pieces; i++) {
    const deg = (i + 0.5) * (360 / pieces);
    if ([0, 90, 180, 270].some((g) => Math.abs(((deg - g + 540) % 360) - 180) < 360 / pieces / 2 + 1)) continue;
    const a0 = (i / pieces) * 2 * Math.PI, a1 = ((i + 1) / pieces) * 2 * Math.PI;
    const ring = [[R, a0], [R + 64, a0], [R + 64, a1], [R, a1]].map(([r, a]) => [Math.round(r * Math.cos(a)), Math.round(r * Math.sin(a))]);
    world.push(M.prism("z", ring, 8, H, T.msrFace));
  }
  world.push(M.cylinder("z", [0, 0], 420, 8, 3600, "d_drkmtl_mpanel", { sides: 12 }));
  for (let z = 480; z < 3400; z += 560) world.push(M.cylinder("z", [0, 0], 436, z, z + 96, "cyberwallpanel", { sides: 12 }));
  world.push(M.cylinder("z", [0, 0], 120, 3600, 4200, "d_drkmtl_mpanel", { sides: 8 }));
  entities.push(M.light([0, 0, 4300], { color: [170, 110, 255], brightness: 900 }));
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * 2 * Math.PI;
    entities.push(M.light([Math.round(700 * Math.cos(a)), Math.round(700 * Math.sin(a)), 96], { color: [170, 110, 255], brightness: 220 }));
  }
  return { world, entities };
}

/**
 * The sewer city's spaces, carved with the streets in one plan: a tunnel under every street line of the
 * Core, a canal down its middle, a chamber under each district's crossing, and the manhole shafts up.
 */
const SEWER = { floor: -512, ceiling: -176, half: 160, canalHalf: 48, canalFloor: -592, water: -536 };
function sewerSpaces() {
  const spaces = [];
  const tex = { floor: "pkf_concrete5a", wall: "PRXCNCRT10A", ceiling: "PRXCNCRT5A" };
  const lines = [-SPAN, 0, SPAN];
  for (const c of lines) {
    spaces.push({ name: `sewer-x${c}`, outline: [[c - SEWER.half, -CORE + 128], [c + SEWER.half, -CORE + 128], [c + SEWER.half, CORE - 128], [c - SEWER.half, CORE - 128]], floor: SEWER.floor, ceiling: SEWER.ceiling, texture: tex });
    spaces.push({ name: `sewer-y${c}`, outline: [[-CORE + 128, c - SEWER.half], [CORE - 128, c - SEWER.half], [CORE - 128, c + SEWER.half], [-CORE + 128, c + SEWER.half]], floor: SEWER.floor, ceiling: SEWER.ceiling, texture: tex });
    spaces.push({ name: `canal-x${c}`, outline: [[c - SEWER.canalHalf, -CORE + 128], [c + SEWER.canalHalf, -CORE + 128], [c + SEWER.canalHalf, CORE - 128], [c - SEWER.canalHalf, CORE - 128]], floor: SEWER.canalFloor, ceiling: SEWER.floor + 8, texture: tex });
    spaces.push({ name: `canal-y${c}`, outline: [[-CORE + 128, c - SEWER.canalHalf], [CORE - 128, c - SEWER.canalHalf], [CORE - 128, c + SEWER.canalHalf], [-CORE + 128, c + SEWER.canalHalf]], floor: SEWER.canalFloor, ceiling: SEWER.floor + 8, texture: tex });
  }
  // a chamber under every crossing, taller and wider: the undercity's halls
  for (const x of lines)
    for (const y of lines) spaces.push({ name: `chamber${x},${y}`, outline: [[x - 448, y - 448], [x + 448, y - 448], [x + 448, y + 448], [x - 448, y + 448]], floor: SEWER.floor, ceiling: -32, texture: tex });
  // the manholes: a shaft up from the tunnel beside the canal, into the street's gutter
  const holes = [];
  for (const c of lines)
    for (const t of [-SPAN - 640, -640, 640, SPAN + 640]) {
      holes.push([c + SEWER.half - 72, t]);
      holes.push([t, c + SEWER.half - 72]);
    }
  for (const [x, y] of holes) spaces.push({ name: `manhole${x},${y}`, outline: [[x - 32, y - 32], [x + 32, y - 32], [x + 32, y + 32], [x - 32, y + 32]], floor: SEWER.floor, ceiling: 64, texture: tex });
  return { spaces, holes };
}

/** What lives in the sewers: the canal's water, the ladders up the manholes, a dim light every so far. */
function sewerFittings(holes) {
  const world = [], entities = [];
  const lines = [-SPAN, 0, SPAN];
  for (const c of lines) {
    world.push(M.box([c - SEWER.canalHalf, -CORE + 128, SEWER.canalFloor], [c + SEWER.canalHalf, CORE - 128, SEWER.water], "!wtr_bl_drt"));
    world.push(M.box([-CORE + 128, c - SEWER.canalHalf, SEWER.canalFloor], [CORE - 128, c + SEWER.canalHalf, SEWER.water], "!wtr_bl_drt"));
    for (let t = -CORE + 384; t < CORE - 256; t += 640) {
      entities.push(M.light([c + 96, t, SEWER.ceiling - 24], { color: [110, 200, 120], brightness: 110 }));
      entities.push(M.light([t, c - 96, SEWER.ceiling - 24], { color: [110, 200, 120], brightness: 110 }));
    }
  }
  for (const x of lines) for (const y of lines) entities.push(M.light([x, y, -96], { color: [150, 220, 140], brightness: 260 }));
  for (const [x, y] of holes) {
    entities.push(M.brushEntity("func_ladder", [M.box([x + 16, y - 16, SEWER.floor], [x + 32, y + 16, 0], "AAATRIGGER")]));
    world.push(M.box([x + 24, y - 16, SEWER.floor], [x + 32, y + 16, 0], "metal25dn"));
  }
  return { world, entities };
}

function build() {
  const rng = numbers(0xb12a);
  const { spaces, holes } = sewerSpaces();
  const air = [{
    name: "core",
    outline: [[-CORE, -CORE], [CORE, -CORE], [CORE, CORE], [-CORE, CORE]],
    floor: 0,
    ceiling: SKY_TOP,
    texture: { floor: T.street, wall: T.sky, ceiling: T.sky },
  }, ...spaces];
  const shell = M.carvePlan(air, 64, { floor: T.street, wall: T.sky, ceiling: T.sky });

  const world = [], detail = [], entities = [], spawns = [];
  for (const [type, i, j] of LAYOUT) {
    if (type === "nexus") {
      const nx = nexus();
      world.push(...nx.world);
      entities.push(...nx.entities);
      continue;
    }
    const d = district(type, i * SPAN, j * SPAN, rng);
    world.push(...d.world);
    detail.push(...d.detail);
    entities.push(...d.entities);
    spawns.push(...d.spawns);
  }
  const sewer = sewerFittings(holes);

  const all = [
    M.pointEntity("light_environment", [0, 0, SKY_TOP - 64], { angles: "-60 140 0", pitch: -60, _light: "70 90 140 34" }),
    ...entities,
    ...sewer.entities,
    M.brushEntity("func_detail", detail),
  ];
  // spawns in the shops of every district, a few each, and round the Nexus plaza
  const per = {};
  for (const [x, y, z] of spawns) {
    const key = `${Math.round(x / SPAN)},${Math.round(y / SPAN)}`;
    if ((per[key] = (per[key] ?? 0) + 1) > 4) continue;
    all.push(M.pointEntity("info_player_deathmatch", [snap(x), snap(y), z], { angles: "0 0 0" }));
  }
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * 2 * Math.PI;
    all.push(M.pointEntity("info_player_deathmatch", [Math.round(1100 * Math.cos(a)), Math.round(1100 * Math.sin(a)), 48], { angles: `0 ${Math.round(((a * 180) / Math.PI + 180) % 360)} 0` }));
  }

  return {
    worldspawn: { wad: Object.values(WADS), skyname: SKY_NAME, MaxRange: 16000, message: "New Byzantium" },
    brushes: [...shell, ...world, ...sewer.world],
    entities: all,
  };
}

// ---- write, check, compile, draw, deploy ------------------------------------------------------------
mkdirSync(OUT, { recursive: true });
const map = build();
writeFileSync(join(OUT, `${NAME}.map`), M.writeMap(map));
console.log(`  wrote ${NAME}.map: ${map.brushes.length} world brushes, ${map.entities.length} entities`);
// big-world coordinates (engine-h9-bigworld.patch and ts\delta.lst) reach +/-32768
const plan = M.checkPlan(map, { range: 32768 });
for (const line of (plan.errors ?? []).slice(0, 10)) console.log(`  PLAN ERROR ${line}`);
for (const line of (plan.warnings ?? []).slice(0, 6)) console.log(`  plan warn  ${line}`);

const flags = process.argv.slice(2);
if (flags.includes("--compile")) {
  const perTool = ["-engine", "xash", "-threads", "6"];
  const result = M.compileMap(join(OUT, `${NAME}.map`), {
    wads: Object.values(WADS),
    wadinclude: true,
    out: join(OUT, `${NAME}.bsp`),
    compilers: { folder: COMPILERS },
    args: { hlcsg: perTool, hlbsp: perTool, hlvis: [...perTool, "-fast"], hlrad: perTool },
    fast: flags.includes("--fast"),
    vis: true,
    light: true,
    timeout: { hlcsg: 900000, hlbsp: 900000, hlvis: 1800000, hlrad: 2400000 },
    keep: false,
  });
  console.log(`  bsp: ${result.bsp ?? "none"}`);
  for (const line of result.errors) console.log(`  ERROR ${line}`);
  for (const line of result.warnings.slice(0, 10)) console.log(`  warn  ${line}`);
  if (result.leak) console.log(`  LEAK from ${result.leak.entity?.classname} at ${result.leak.at}`);
  for (const log of result.logs) console.log(`  ${log.tool}: ${log.code ?? "?"} in ${log.seconds.toFixed(1)}s`);
}
if (flags.includes("--views")) {
  const VIEWS = [
    ["main-street", [0, -1150, 64], [0, 400, 120]],
    ["main-street-north", [0, 1150, 64], [0, -200, 140]],
    ["cross-street", [-1150, 0, 64], [400, 0, 140]],
    ["crossing", [96, -260, 64], [-300, 260, 150]],
    ["from-above", [-1100, -1100, 1200], [0, 0, 100]],
    ["core-skyline", [-3700, -3700, 2000], [0, 0, 600]],
    ["nexus", [0, -1400, 80], [0, 0, 900]],
    ["sewer-tunnel", [0, -CORE + 300, SEWER.floor + 64], [0, 0, SEWER.floor + 40]],
    ["sewer-chamber", [-380, -380, SEWER.floor + 80], [200, 200, SEWER.floor + 40]],
    ["alley", [MAIN + 560, -CROSS - 380, 64], [MAIN + 560, -HALF + 100, 100]],
  ];
  // and from inside: the first ground floor, and the flat over it
  const spawn = map.entities.find((e) => e.classname === "info_player_deathmatch");
  if (spawn) {
    const [sx, sy, sz] = String(spawn.origin).split(/\s+/).map(Number);
    VIEWS.push(["inside-ground", [sx, sy, sz + 20], [sx + 200, sy - 120, sz + 10]]);
    VIEWS.push(["inside-flat", [sx - 60, sy, sz + STOREY + 20], [sx + 200, sy + 60, sz + STOREY + 10]]);
  }
  const folders = [join(HERE, "..", "out"), join(GAME_DIR, "ts"), join(GAME_DIR, "valve")];
  const dir = join(OUT, "views");
  mkdirSync(dir, { recursive: true });
  const bsp = M.readBsp(readFileSync(join(OUT, `${NAME}.bsp`)));
  for (const [label, from, to] of VIEWS) {
    try {
      const img = M.drawMap(bsp, { from, to, width: 640, height: 400, brightness: 1.5, folders, entities: "game", labels: false });
      writeFileSync(join(dir, `${NAME}-${label}.png`), K.png(img.width, img.height, img.rgba));
    } catch (e) {
      console.log(`  ${label}: FAILED -- ${e.message}`);
    }
  }
  console.log(`  drew ${VIEWS.length} views into ${dir}`);
}
if (flags.includes("deploy")) {
  for (const dir of [H9XASH_MAPS, join(GAME_DIR, "ts", "maps")]) {
    copyFileSync(join(OUT, `${NAME}.bsp`), join(dir, `${NAME}.bsp`));
    console.log(`  deployed to ${dir}`);
  }
}
