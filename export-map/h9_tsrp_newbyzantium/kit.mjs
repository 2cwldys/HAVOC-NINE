// kit.mjs: the pieces New Byzantium is built from.
//
// The city is a list of SPACES (rooms, streets, halls, shafts) carved out of rock with SMAK's carvePlan,
// tile by tile so that no carve is bigger than a district; FITTINGS stand in the spaces (galleries, stairs,
// furniture, columns, the Nexus); ENTITIES are its doors, glass, lights and starts. A Bag holds all four.
import { M } from "../lib.mjs";

export const STOREY = 176; // floor to floor
export const ROOM_H = 160; // floor to ceiling in a room
export const WALL = 16; // rock between two spaces
// a door as the cities have them (Alexandria 56 x 96-99, Paradise 56 x 108, Xenon 58 x 86-98): shorter than the
// room, so the wall over it is a lintel
export const DOOR = { w: 56, h: 112 };
export const WIN = { lo: 48, hi: 112 };

/** A repeatable run of numbers from 0 to 1. */
export function numbers(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const pick = (rng, list) => list[Math.floor(rng() * list.length)];
export const snap = (v, g = 16) => Math.round(v / g) * g;
export const within = (rng, a, b, g = 16) => snap(a + rng() * (b - a), g);
export const chance = (rng, p) => rng() < p;

/** [x0, y0, x1, y1] as an outline. */
export const outlineOf = ([x0, y0, x1, y1]) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
/** A carved space from a box [x0, y0, z0, x1, y1, z1]. */
export function boxSpace(name, [x0, y0, z0, x1, y1, z1], texture) {
  return { name, outline: outlineOf([x0, y0, x1, y1]), floor: z0, ceiling: z1, texture };
}

// ---- where things are: boxes in a spatial hash --------------------------------------------------
export class Occupancy {
  constructor(cell = 512) {
    this.cell = cell;
    this.map = new Map();
  }
  keys([x0, y0, , x1, y1]) {
    const c = this.cell;
    const out = [];
    for (let i = Math.floor(x0 / c); i <= Math.floor((x1 - 1e-6) / c); i++)
      for (let j = Math.floor(y0 / c); j <= Math.floor((y1 - 1e-6) / c); j++) out.push(`${i},${j}`);
    return out;
  }
  add(box, info = {}) {
    const item = { box, ...info };
    for (const k of this.keys(box)) {
      if (!this.map.has(k)) this.map.set(k, []);
      this.map.get(k).push(item);
    }
    return item;
  }
  /** What a box comes nearer than `gap` to. */
  hits(box, gap = 0) {
    const g = [box[0] - gap, box[1] - gap, box[2] - gap, box[3] + gap, box[4] + gap, box[5] + gap];
    const seen = new Set();
    const out = [];
    for (const k of this.keys(g))
      for (const it of this.map.get(k) ?? []) {
        if (seen.has(it)) continue;
        seen.add(it);
        const b = it.box;
        if (b[0] < g[3] && b[3] > g[0] && b[1] < g[4] && b[4] > g[1] && b[2] < g[5] && b[5] > g[2]) out.push(it);
      }
    return out;
  }
  /** Whether a box keeps a whole wall from everything. */
  free(box, gap = WALL) {
    return this.hits(box, gap - 0.01).length === 0;
  }
}

// ---- the carve, tile by tile ------------------------------------------------------------------------
const EPS = 0.01;
const FAR = 1 << 17;

/** A brush cut by the upright plane `axis` = value, keeping the side below (or above) it; null when nothing is left. */
export function clipBrush(brush, axis, value, keepBelow, shape = M.shapeOf(brush)) {
  if (keepBelow) {
    if (shape.max[axis] <= value + EPS) return brush;
    if (shape.min[axis] >= value - EPS) return null;
  } else {
    if (shape.min[axis] >= value - EPS) return brush;
    if (shape.max[axis] <= value + EPS) return null;
  }
  const sky = brush.faces.some((f) => /^sky$/i.test(f.texture));
  const tex = sky ? "sky" : (brush.faces.find((f) => !/^(sky|null|clip)$/i.test(f.texture))?.texture ?? "NULL");
  const min = [-FAR, -FAR, -FAR];
  const max = [FAR, FAR, FAR];
  if (keepBelow) [min[axis], max[axis]] = [value - 1, value];
  else [min[axis], max[axis]] = [value, value + 1];
  const cut = M.box(min, max, tex).faces.find((f) => {
    const p = M.planeOf(f.points);
    return p && (keepBelow ? p.normal[axis] > 0.99 : p.normal[axis] < -0.99);
  });
  const next = { ...brush, faces: [...brush.faces, cut] };
  const after = M.shapeOf(next);
  const faces = next.faces.filter((_, i) => after.faces[i].area > 0.5);
  return faces.length >= 4 && after.volume > 1 ? { ...brush, faces } : null;
}

/** A brush kept inside the plan rectangle [x0, y0, x1, y1]. */
export function clipToRect(brush, [x0, y0, x1, y1]) {
  const shape = M.shapeOf(brush);
  if (shape.min[0] >= x0 - EPS && shape.max[0] <= x1 + EPS && shape.min[1] >= y0 - EPS && shape.max[1] <= y1 + EPS) return brush;
  if (shape.max[0] <= x0 + EPS || shape.min[0] >= x1 - EPS || shape.max[1] <= y0 + EPS || shape.min[1] >= y1 - EPS) return null;
  let b = brush;
  for (const [axis, value, below] of [[0, x0, false], [0, x1, true], [1, y0, false], [1, y1, true]]) {
    b = clipBrush(b, axis, value, below);
    if (!b) return null;
  }
  return b;
}

/**
 * carvePlan over a whole city: the plan cut into tiles, each tile carved with every space that reaches it
 * (whole, so the pictures line up across a seam) and its rock cut back to the tile. Each space is wrapped by
 * the tiles it is in, so the city is sealed as one carve would seal it.
 */
export function carveTiled(spaces, { tile = 2048, wall = 64, texture, log = () => {} } = {}) {
  const items = spaces.map((s) => {
    const pts = s.outline;
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return { s, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  });
  const gx0 = Math.floor(Math.min(...items.map((i) => i.x0)) / tile) * tile;
  const gy0 = Math.floor(Math.min(...items.map((i) => i.y0)) / tile) * tile;
  const gx1 = Math.ceil(Math.max(...items.map((i) => i.x1)) / tile) * tile;
  const gy1 = Math.ceil(Math.max(...items.map((i) => i.y1)) / tile) * tile;
  const out = [];
  for (let tx = gx0; tx < gx1; tx += tile)
    for (let ty = gy0; ty < gy1; ty += tile) {
      const rect = [tx, ty, tx + tile, ty + tile];
      const here = items.filter((i) => i.x0 <= rect[2] + 1 && i.x1 >= rect[0] - 1 && i.y0 <= rect[3] + 1 && i.y1 >= rect[1] - 1);
      if (!here.length) continue;
      const t = Date.now();
      const brushes = M.carvePlan(here.map((i) => i.s), wall, texture);
      let kept = 0;
      for (const b of brushes) {
        const c = clipToRect(b, rect);
        if (c) {
          out.push(c);
          kept++;
        }
      }
      log(`  tile ${tx},${ty}: ${here.length} spaces, ${kept} brushes, ${((Date.now() - t) / 1000).toFixed(1)}s`);
    }
  return out;
}

/**
 * The floor and ceiling of every carved rock face, worn again from the spaces themselves. carvePlan tags each
 * piece of rock by the space it sees over and under it, and where spaces overlap (two streets at a crossing,
 * a doorway into a room, the ward ring's corners) it can tag a piece as seeing none: its top then wears the
 * carve's own grey floor in the middle of a street's or a hall's. Here each face that looks up is given the
 * floor of the space standing on it (the one covering most of it), and each that looks down the ceiling of
 * the space under it; where one face is seen from two spaces of different pictures, the brush is cut in two
 * along the edge of one of them first. A brush of sky is left as it is. Returns { brushes, changed, split }.
 */
export function wearFromSpaces(brushes, spaces) {
  const CELL = 512;
  const grid = new Map();
  const items = spaces.map((s) => {
    const xs = s.outline.map((p) => p[0]);
    const ys = s.outline.map((p) => p[1]);
    const t = s.texture;
    const parts = t && typeof t === "object" && !t.name;
    const any = parts ? (t.wall ?? t.floor ?? t.ceiling) : t;
    return {
      x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), floor: s.floor, ceiling: s.ceiling,
      floorTex: parts ? (t.floor ?? any) : t,
      ceilingTex: parts ? (t.ceiling ?? any) : t,
    };
  });
  items.forEach((it, k) => {
    for (let i = Math.floor(it.x0 / CELL); i <= Math.floor(it.x1 / CELL); i++)
      for (let j = Math.floor(it.y0 / CELL); j <= Math.floor(it.y1 / CELL); j++) {
        const key = `${i},${j}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(k);
      }
  });
  const near = (x0, y0, x1, y1) => {
    const seen = new Set();
    for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++)
      for (let j = Math.floor(y0 / CELL); j <= Math.floor(y1 / CELL); j++) for (const k of grid.get(`${i},${j}`) ?? []) seen.add(k);
    return [...seen].map((k) => items[k]);
  };
  let changed = 0;
  let split = 0;
  /** One brush worn again; split in two where its top (or underside) is seen from spaces of two pictures. */
  const wearOne = (b, depth) => {
    if (b.faces.some((f) => /^sky$/i.test(f.texture))) return [b];
    const shape = M.shapeOf(b);
    for (let i = 0; i < shape.faces.length; i++) {
      const f = shape.faces[i];
      if (!f.normal || Math.abs(f.normal[2]) < 0.999 || f.area < 1) continue;
      const up = f.normal[2] > 0;
      const z = f.polygon[0][2];
      const xs = f.polygon.map((p) => p[0]);
      const ys = f.polygon.map((p) => p[1]);
      const [fx0, fx1, fy0, fy1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      const over = [];
      for (const it of near(fx0, fy0, fx1, fy1)) {
        if (Math.abs((up ? it.floor : it.ceiling) - z) > 0.5) continue;
        const ox = Math.min(fx1, it.x1) - Math.max(fx0, it.x0);
        const oy = Math.min(fy1, it.y1) - Math.max(fy0, it.y0);
        const want = up ? it.floorTex : it.ceilingTex;
        if (ox > 0.5 && oy > 0.5 && typeof want === "string" && !/^sky$/i.test(want)) over.push({ it, area: ox * oy, want });
      }
      if (!over.length) continue;
      over.sort((p, q) => q.area - p.area);
      const A = over[0];
      const other = over.find((o) => o.want !== A.want);
      if (other && depth < 6) {
        // cut along an edge of the space seen most that lies inside the face and parts it from the other
        const B = other.it;
        const cuts = [
          [0, A.it.x1, B.x0 >= A.it.x1 - 0.5], [0, A.it.x0, B.x1 <= A.it.x0 + 0.5],
          [1, A.it.y1, B.y0 >= A.it.y1 - 0.5], [1, A.it.y0, B.y1 <= A.it.y0 + 0.5],
        ].filter(([axis, v, parts]) => parts && v > (axis ? fy0 : fx0) + 0.5 && v < (axis ? fy1 : fx1) - 0.5);
        if (cuts.length) {
          const [axis, v] = cuts[0];
          const halves = [clipBrush(b, axis, v, true, shape), clipBrush(b, axis, v, false, shape)].filter(Boolean);
          if (halves.length === 2) {
            split++;
            return halves.flatMap((h) => wearOne(h, depth + 1));
          }
        }
      }
      if (b.faces[i].texture !== A.want) {
        b.faces[i] = { ...b.faces[i], texture: A.want };
        changed++;
      }
    }
    return [b];
  };
  const out = brushes.flatMap((b) => wearOne(b, 0));
  return { brushes: out, changed, split };
}

// ---- what a part of the city hands back -------------------------------------------------------------
export class Bag {
  constructor() {
    this.spaces = [];
    this.world = [];
    this.detail = [];
    this.entities = [];
    this.spawns = [];
    this.notes = [];
  }
  add(other) {
    for (const k of ["spaces", "world", "detail", "entities", "spawns", "notes"]) this[k].push(...other[k]);
    return this;
  }
}

// ---- the openings -------------------------------------------------------------------------------------
/**
 * Every picture a door wears, with its size in texels: a door's leaf shows its picture once, fitted to it.
 * Each is a door as it stands (a panel door, a shutter, a pair), never a wall picture tiled across a leaf.
 */
export const DOOR_PICTURES = {
  homedoor1dn: [64, 128], door006: [64, 128], cd_wooddoor: [128, 224], cds_labdoor1: [64, 112],
  cds_metaldoor1: [64, 112], cds_wooddoor: [64, 112], door002: [64, 112], metaldoor2dn: [64, 128], o_mtldoor3: [64, 128],
  mo_mtldoor1: [64, 128], gryrstdr1: [64, 128], mtl_door3: [64, 128], cds_wooddoor1: [128, 112], cds_labdoor2: [128, 112],
  cds_metaldoor2: [128, 112], garage01: [128, 128], garage02: [128, 128], garage03: [128, 128], garage05: [128, 128],
  garage08: [128, 128], MJSTDOOR01: [128, 128], MJSTDOOR02: [128, 128], MJSTDOOR03: [256, 128], bigcyberdoor: [128, 128],
  cyberdoor: [128, 128], mtl8_cargo_door: [256, 128], metaldoor14dn: [128, 128],
};
/** The plain trim a door's edges wear, by the picture's family. */
const doorTrim = (tex) => (/^MJST/.test(tex) ? "MJSTTRIM01" : /wood|home|door006/i.test(tex) ? "wooddark" : "metal5");

/**
 * A door in a doorway box [x0, y0, z0, x1, y1, z1] (the box runs across a wall): a leaf 8 thick in the middle
 * of the wall that slides along the wall into it, or up when told (a shutter). Its picture is fitted to the
 * leaf, once, on both broad faces; its edges wear a plain trim. `mesh`: a cell's bars, seen through (the only
 * door that is). `picture`: the box of a pair of leaves, so each shows its share of one picture. `name` goes
 * with `use` only: a door with a name opens when it is used or triggered, never at a touch.
 */
export function door(b, tex, { up = false, speed = 150, wait = 4, mesh = false, name, use = false, picture } = {}) {
  const [x0, y0, z0, x1, y1, z1] = b;
  const alongX = x1 - x0 >= y1 - y0; // the wall runs along x when the doorway is wider in x
  const min = alongX ? [x0, (y0 + y1) / 2 - 4, z0] : [(x0 + x1) / 2 - 4, y0, z0];
  const max = alongX ? [x1, (y0 + y1) / 2 + 4, z1] : [(x0 + x1) / 2 + 4, y1, z1];
  let wear = tex;
  if (!mesh) {
    const size = DOOR_PICTURES[tex];
    if (!size) throw new Error(`door: ${tex} is not a door picture (DOOR_PICTURES)`);
    // the picture over the whole of a pair: `picture` is the pair's box, so each leaf shows its own part
    const [pm, pM] = picture ?? [min, max];
    const fit = M.fitted(tex, size, pm, pM, { whole: true, faces: alongX ? ["north", "south"] : ["east", "west"], rest: doorTrim(tex) });
    wear = { ...fit, top: doorTrim(tex), bottom: doorTrim(tex) };
  }
  const leaf = M.box(min, max, wear);
  const keys = { angles: up ? "-90 0 0" : alongX ? "0 0 0" : "0 90 0", speed, wait, lip: up ? 8 : 4, spawnflags: use ? 256 : 0 };
  if (mesh) Object.assign(keys, { rendermode: 4, renderamt: 255 });
  if (name) keys.targetname = name;
  return M.brushEntity("func_door", [leaf], keys);
}

/**
 * A secret door: a leaf the wall's own thickness and its own picture, flush with both faces, that opens only for
 * who tries the wall (use), slides into it and comes back. `b` the doorway box across the wall.
 */
export function secretDoor(b, wallTex, name) {
  const [x0, y0, z0, x1, y1, z1] = b;
  const alongX = x1 - x0 >= y1 - y0;
  return M.brushEntity("func_door", [M.box([x0, y0, z0], [x1, y1, z1], wallTex)], { angles: alongX ? "0 0 0" : "0 90 0", speed: 60, wait: 6, lip: 4, spawnflags: 256, targetname: name });
}

/** Glass across an opening box: a thin pane, seen through. */
export function glass(b, tex = "glass_dark", amt = 70) {
  const [x0, y0, z0, x1, y1, z1] = b;
  const alongX = x1 - x0 >= y1 - y0;
  const pane = alongX
    ? M.box([x0, (y0 + y1) / 2 - 1, z0], [x1, (y0 + y1) / 2 + 1, z1], tex)
    : M.box([(x0 + x1) / 2 - 1, y0, z0], [(x0 + x1) / 2 + 1, y1, z1], tex);
  return M.brushEntity("func_wall", [pane], { rendermode: 2, renderamt: amt });
}

/** A see-through picture (a `{` texture) on a thin plate: signs, banners, grilles, cell bars. */
export function plate(min, max, tex, keys = {}) {
  return M.brushEntity("func_wall", [M.box(min, max, tex)], { rendermode: 4, renderamt: 255, ...keys });
}

export const lamp = (at, color, brightness = 160, keys = {}) =>
  M.light(at.map((v) => Math.round(v)), { color, brightness, ...keys });

// ---- furniture: a few boxes each, every one wearing the cities' own pictures ------------------------
const T = (sides, top = sides, bottom = top) => ({ top, bottom, sides });

/**
 * A room's things along its walls, keeping the middle and the way in clear. `r` is the room's inside
 * [x0, y0, x1, y1], `z` its floor, `doorSide` the wall the way in is on ("n", "s", "e", "w").
 */
export function furnish(kind, r, z, doorSide, rng) {
  const [x0, y0, x1, y1] = r;
  const w = x1 - x0;
  const d = y1 - y0;
  const out = [];
  // the walls a thing may stand against, the door's own last
  const walls = ["n", "s", "e", "w"].filter((s) => s !== doorSide);
  const against = (side, len, depth, height, tex, at = 0.5) => {
    // a box of `len` along the wall, `depth` out from it, at `at` (0..1) along it
    const runsX = side === "n" || side === "s";
    const span = runsX ? w : d;
    if (len > span - 32) len = span - 32;
    if (len < 16) return;
    const a = snap((runsX ? x0 : y0) + 16 + (span - 32 - len) * at, 4);
    if (side === "n") out.push(M.box([a, y1 - depth, z], [a + len, y1, z + height], tex));
    if (side === "s") out.push(M.box([a, y0, z], [a + len, y0 + depth, z + height], tex));
    if (side === "e") out.push(M.box([x1 - depth, a, z], [x1, a + len, z + height], tex));
    if (side === "w") out.push(M.box([x0, a, z], [x0 + depth, a + len, z + height], tex));
  };
  const back = { n: "s", s: "n", e: "w", w: "e" }[doorSide];
  const sides = walls.filter((s) => s !== back);
  if (w < 96 || d < 96) return out;
  switch (kind) {
    case "flat":
    case "flat_lux":
    case "flat_poor": {
      const poor = kind === "flat_poor";
      const lux = kind === "flat_lux";
      against(back, 112, 72, poor ? 12 : 24, poor ? T("mattress4") : T("au_bed", lux ? "au_bedg" : "mattress1", "wood3"), rng() < 0.5 ? 0.15 : 0.85);
      // a plain flat has a kitchen or a couch, not both, so most of its floor stays clear
      const kitchen = lux || (!poor && rng() < 0.5);
      if (sides[0] && kitchen) against(sides[0], 128, 32, 40, { top: rng() < 0.5 ? "kit_stove" : "sink", bottom: "kit_wood1", sides: "kit_cupboard1" }, 0.8);
      if (sides[0] && lux) against(sides[0], 40, 32, 80, { top: "metal5", bottom: "metal5", sides: "KITCHEN-FRIDGE0" }, 0.2);
      if (sides[1] && (lux || (!poor && !kitchen))) against(sides[1], lux ? 112 : 96, 40, 32, T("hocouch3"), 0.5);
      if (lux) {
        out.push(M.box([snap((x0 + x1) / 2 - 64, 4), snap((y0 + y1) / 2 - 48, 4), z], [snap((x0 + x1) / 2 + 64, 4), snap((y0 + y1) / 2 + 48, 4), z + 1], T("sinrug", "sinrug2")));
        against(back, 64, 2, 48, T(pick(rng, ["hopaint2", "ax_picture1", "ax_picture3", "ax_seaofice"])), 0.5);
      }
      break;
    }
    case "shop":
      against(back, 160, 24, 96, { top: "metal5", bottom: "metal5", sides: pick(rng, ["gp_shelf1", "gp_shelf2", "gp_fridgebeer"]) }, 0.5);
      if (d >= 160 && w >= 160) {
        const cx = snap((x0 + x1) / 2, 4);
        const cy = snap((y0 + y1) / 2, 4);
        out.push(M.box([cx - 56, cy - 16, z], [cx + 56, cy + 16, z + 40], T("booth_wood_1", "tabletops")));
      }
      break;
    case "bar":
      against(back, 192, 16, 96, T("sinbar2"), 0.5);
      against(back, 176, 40, 44, T("booth_wood_1", "wooddark"), 0.5);
      for (const s of sides) against(s, 96, 48, 32, T("hocouch3"), 0.5);
      break;
    case "clinic":
      against(back, 96, 64, 28, T("au_bedg", "mattress1", "metal5"), 0.2);
      against(back, 96, 64, 28, T("au_bedg", "mattress1", "metal5"), 0.8);
      if (sides[0]) against(sides[0], 96, 24, 72, T("cabnet02"), 0.5);
      break;
    case "office":
      against(back, 96, 48, 32, T("dsk2_06", "tabletops"), 0.3);
      if (sides[0]) against(sides[0], 96, 16, 96, T("book_c01"), 0.5);
      break;
    case "workshop":
      against(back, 160, 48, 40, T("lab1_paneli", "metal5"), 0.5);
      if (sides[1]) against(sides[1], 48, 48, 96, T("sinfuture3", "metal5"), 0.6);
      break;
    case "storage":
      // an emptied room: its boxes and pallets are models (furnishProps)
      break;
    case "msr":
      against(back, 112, 24, 88, T("armory11", "metal5"), 0.5);
      if (sides[0]) against(sides[0], 96, 48, 32, T("dsk2_06", "tabletops"), 0.5);
      if (sides[1]) against(sides[1], 64, 24, 64, T("wht_monitors"), 0.5);
      break;
    case "cell":
      against(back, 80, 40, 20, T("mattress4"), 0.5);
      break;
    case "slum":
      against(back, 80, 48, 10, T("mattress4"), rng());
      break;
    default:
      break;
  }
  return out;
}

/** A TS map prop (ts_model) standing at a point, turned by `yaw`: decoration, walked through, never in the way. */
export const prop = (model, [x, y, z], yaw = 0, keys = {}) =>
  M.pointEntity("ts_model", [Math.round(x), Math.round(y), Math.round(z)], { model: `models/${model}.mdl`, angles: `0 ${Math.round(yaw)} 0`, ...keys });

/**
 * The litter of the source cities, models from Paradise, Alexandria and the TS maps H9 plays: each with how
 * far it reaches along its own y (its long side) and its own x, from its origin on the floor.
 */
export const LITTER = {
  trash: { model: "h9/qk_trash", y: [-80, 97], x: [-34, 66] }, // bins, bags and paper along a wall
  dirt: { model: "h9/re_dirt", y: [-101, 126], x: [-127, 119] }, // scraps over a floor, flat
  pallet: { model: "CLANKILL3R/GPC_PALLET", y: [-38, 38], x: [-38, 38] },
  pallets: { model: "CLANKILL3R/GPC_PALLETS", y: [-86, 83], x: [-57, 46] },
  box: { model: "hammertime/cg_box01", y: [-19, 21], x: [-22, 21] },
  box2: { model: "hammertime/cg_box02", y: [-19, 21], x: [-22, 21] },
  boxes: { model: "hammertime/cg_box03", y: [-37, 47], x: [-23, 23] },
  dumpster: { model: "xen/xen_trashcanb", y: [-41, 52], x: [-16, 25] },
};

/**
 * A thing from LITTER laid against a wall: `along` the way the wall runs ("x" or "y"), `wall` where its face
 * is, `inward` +1 or -1 (the side of the floor), `u` how far along. Its long side lies along the wall, its
 * back a few units off it. Returns { entity, box } (the box it takes on the floor, for keeping doors clear).
 */
export function againstWall(kind, along, wall, inward, u, z) {
  const L = LITTER[kind];
  // the model's long side (its y) along the wall, its back (its least x) to the wall
  const yaw = along === "x" ? (inward > 0 ? 90 : 270) : inward > 0 ? 0 : 180;
  const off = wall + inward * (4 - L.x[0]);
  const at = along === "x" ? [u, off, z] : [off, u, z];
  // where its corners land, turned by a multiple of 90
  const turn = { 0: ([a, b]) => [a, b], 90: ([a, b]) => [-b, a], 180: ([a, b]) => [-a, -b], 270: ([a, b]) => [b, -a] }[yaw];
  const corners = [[L.x[0], L.y[0]], [L.x[1], L.y[1]]].map(turn);
  const xs = corners.map((c) => at[0] + c[0]);
  const ys = corners.map((c) => at[1] + c[1]);
  const box = [Math.min(...xs), Math.min(...ys), z, Math.max(...xs), Math.max(...ys), z + 64];
  return { entity: prop(L.model, at, yaw), box };
}

/**
 * Litter along a street's walls: bins and bags, scraps, boxes, pallets, now and then a dumpster (with a clip
 * box so it is solid), `count` heaps of it, kept off every doorway by `clear(box)`. Returns { entities, clips }.
 * `kinds` weighs what is strewn: { trash: 4, dirt: 2, ... }.
 */
export function litter(rect, along, z, count, rng, clear = () => true, kinds = { trash: 4, dirt: 2, boxes: 1, box: 1, pallets: 1, dumpster: 1 }) {
  const [x0, y0, x1, y1] = rect;
  const span = along === "x" ? x1 - x0 : y1 - y0;
  const entities = [];
  const clips = [];
  if (span < 320) return { entities, clips };
  const deck = Object.entries(kinds).flatMap(([k, n]) => Array(n).fill(k));
  const taken = [];
  for (let i = 0; i < count; i++) {
    const kind = pick(rng, deck);
    const low = rng() < 0.5;
    const u = snap((along === "x" ? x0 : y0) + 128 + rng() * (span - 256), 4);
    if (kind === "dirt") {
      // scraps lie across the floor, not against a wall
      const c = along === "x" ? [u, (y0 + y1) / 2 + within(rng, -32, 32, 4)] : [(x0 + x1) / 2 + within(rng, -32, 32, 4), u];
      const box = [c[0] - 128, c[1] - 128, z, c[0] + 128, c[1] + 128, z + 16];
      if (taken.some((t) => t[0] < box[3] && t[3] > box[0] && t[1] < box[4] && t[4] > box[1])) continue;
      taken.push(box);
      entities.push(prop(LITTER.dirt.model, [c[0], c[1], z], within(rng, 0, 360, 15)));
      continue;
    }
    const wall = along === "x" ? (low ? y0 : y1) : low ? x0 : x1;
    const placed = againstWall(kind, along, wall, low ? 1 : -1, u, z);
    if (!clear(placed.box) || taken.some((t) => t[0] < placed.box[3] && t[3] > placed.box[0] && t[1] < placed.box[4] && t[4] > placed.box[1])) continue;
    taken.push(placed.box);
    entities.push(placed.entity);
    if (kind === "dumpster") {
      const [bx0, by0, , bx1, by1] = placed.box;
      clips.push(M.box([bx0 + 2, by0 + 2, z], [bx1 - 2, by1 - 2, z + 56], "CLIP"));
    }
  }
  return { entities, clips };
}

/** What a room keeps that is a model, not a box: a store's boxes and pallets, a slum's rubbish, a bar's stools. */
export function furnishProps(kind, r, z, doorSide, rng) {
  const [x0, y0, x1, y1] = r;
  if (x1 - x0 < 128 || y1 - y0 < 128) return [];
  const out = [];
  const walls = ["n", "s", "e", "w"].filter((s) => s !== doorSide);
  const put = (k, side, t) => {
    const along = side === "n" || side === "s" ? "x" : "y";
    const wall = { n: y1, s: y0, e: x1, w: x0 }[side];
    const inward = side === "n" || side === "e" ? -1 : 1;
    const [a0, a1] = along === "x" ? [x0, x1] : [y0, y1];
    const L = LITTER[k];
    const u = snap(a0 - L.y[0] + 16 + t * (a1 - a0 - (L.y[1] - L.y[0]) - 32), 4);
    if (a1 - a0 < L.y[1] - L.y[0] + 32) return;
    out.push(againstWall(k, along, wall, inward, u, z).entity);
  };
  if (kind === "storage") {
    put(pick(rng, ["boxes", "pallets"]), pick(rng, walls), rng());
    if (rng() < 0.6) put(pick(rng, ["box", "box2", "pallet"]), pick(rng, walls), rng());
  } else if (kind === "slum") {
    if (rng() < 0.7) put("trash", pick(rng, walls), rng());
  } else if (kind === "flat_poor") {
    if (rng() < 0.25) put(pick(rng, ["box", "box2"]), pick(rng, walls), rng());
  } else if (kind === "workshop") {
    if (rng() < 0.5) put(pick(rng, ["boxes", "pallet"]), pick(rng, walls), rng());
  }
  return out;
}

/** A low bank of haze over a floor: H9's own fog sprite (sprites.mjs in h9_drainage), drifting slowly. */
export function fog([x, y, z], { scale = 2.5, amt = 150 } = {}) {
  return M.pointEntity("env_sprite", [Math.round(x), Math.round(y), Math.round(z)], {
    model: "sprites/h9_drain_fog.spr",
    rendermode: 2,
    renderamt: amt,
    rendercolor: [255, 255, 255],
    scale,
    framerate: 6,
    spawnflags: 1,
  });
}

/** A looping sound at a place: `radius` small, medium, large or everywhere; `volume` 0 to 10. */
export function sound(at, file, volume = 5, radius = "medium") {
  return M.pointEntity("ambient_generic", at.map((v) => Math.round(v)), {
    message: file,
    health: volume,
    pitch: 100,
    pitchstart: 100,
    spawnflags: { everywhere: 1, small: 2, medium: 4, large: 8 }[radius],
  });
}

/**
 * A ladder up one wall of a shaft [x0, y0, z0, x1, y1, z1]: rungs drawn on the wall `side` ("n", "s", "e",
 * "w") and the func_ladder a player climbs, 16 deep against that wall from the shaft's floor to its top, so a
 * player going down faces the rungs and climbs as on any GoldSrc ladder.
 */
export function shaftLadder(shaft, side, tex = "{aladder1") {
  const [x0, y0, z0, x1, y1, z1] = shaft;
  const across = side === "n" || side === "s";
  const [a0, a1] = across ? [x0 + 8, x1 - 8] : [y0 + 8, y1 - 8];
  // a slab d0..d1 out from the wall
  const slab = (d0, d1) =>
    side === "n" ? [a0, y1 - d1, z0, a1, y1 - d0, z1]
    : side === "s" ? [a0, y0 + d0, z0, a1, y0 + d1, z1]
    : side === "e" ? [x1 - d1, a0, z0, x1 - d0, a1, z1]
    : [x0 + d0, a0, z0, x0 + d1, a1, z1];
  const box = (b, t) => M.box([b[0], b[1], b[2]], [b[3], b[4], b[5]], t);
  return [
    M.brushEntity("func_ladder", [box(slab(0, 16), "AAATRIGGER")]),
    M.brushEntity("func_illusionary", [box(slab(1, 3), tex)], { rendermode: 4, renderamt: 255 }),
  ];
}

/** A grate a player breaks through by shooting, kicking or striking it: metal, its holes see-through. */
export function grate(box, tex = "{grate1", health = 30) {
  const brush = M.box([box[0], box[1], box[2]], [box[3], box[4], box[5]], tex);
  return M.brushEntity("func_breakable", [brush], { material: 2, health, spawnflags: 256, rendermode: 4, renderamt: 255 });
}

/**
 * A blade sign standing out from a wall: `box` thin along `thin` ("x" or "y"), the picture `name` of `size`
 * [w, h] texels stretched once across both broad faces, readable from either side, its edges metal.
 */
export function bladeSign(box, thin, name, size) {
  const min = [box[0], box[1], box[2]];
  const max = [box[3], box[4], box[5]];
  const faces = thin === "x" ? ["east", "west"] : ["north", "south"];
  const tex = M.fitted(name, size, min, max, { whole: true, faces, rest: "metal5" });
  return M.brushEntity("func_illusionary", [M.box(min, max, tex)], name.startsWith("{") ? { rendermode: 4, renderamt: 255 } : {});
}

/** A column with a base and a capital: an octagon of `r` from z0 to z1. */
export function column([x, y], r, z0, z1, shaft, trim) {
  return [
    M.cylinder("z", [x, y], r + 8, z0, z0 + 16, trim, { sides: 8, snap: 1 }),
    M.cylinder("z", [x, y], r, z0 + 16, z1 - 24, shaft, { sides: 8, snap: 1 }),
    M.cylinder("z", [x, y], r + 12, z1 - 24, z1, trim, { sides: 8, snap: 1 }),
  ];
}

/**
 * A ramp tower beside a street: two lanes, a ramp up one and back down the other a storey at a time, a
 * landing at each end, climbing `levels` storeys from `from`. Drawn in the tower's own frame: depth 0 at the
 * near end (by the street, where every storey's doorway is) to 416 at the far end, across 0 to 160.
 * `place(d0, a0, z0, d1, a1, z1)` turns such a box into a world box; `deeper(sign)` names the side that is
 * further from the street (sign 1) or nearer it (sign -1).
 */
export function rampCore(place, deeper, from, levels) {
  const out = [];
  const slope = (n) => (n[2] > 0.1 && n[2] < 0.99 ? { name: "sinfuturefloor", align: "face" } : n[2] < -0.5 ? "metal5" : "metal13dn");
  const box = (b, tex) => out.push(M.box([b[0], b[1], b[2]], [b[3], b[4], b[5]], tex));
  const wedge = (b, high) => out.push(M.wedge([b[0], b[1], b[2]], [b[3], b[4], b[5]], high, slope));
  for (let k = 0; k < levels; k++) {
    const f = from + k * STOREY;
    wedge(place(80, 0, f, 336, 80, f + 88), deeper(1));
    box(place(336, 0, f + 72, 416, 160, f + 88), { top: "gratefloor", bottom: "metal5", sides: "metal5" });
    wedge(place(80, 80, f + 88, 336, 160, f + STOREY), deeper(-1));
    box(place(0, 0, f + STOREY - 16, 80, 160, f + STOREY), { top: "gratefloor", bottom: "metal5", sides: "metal5" });
  }
  return out;
}

/**
 * A spiral stair in a square shaft centred on [cx, cy] from `from` up through `levels` storeys, arriving at
 * every storey on the side `face` ("n", "s", "e", "w") where its doorway is. Its brushes; the shaft is the caller's.
 */
export function spiralCore([cx, cy], from, levels, face, tex) {
  if (levels < 1) return [];
  const dir = { e: 0, n: 90, w: 180, s: 270 }[face];
  const tread = 32;
  const middle = 56;
  const sweep = (tread / middle) * (180 / Math.PI);
  // the step that lands on each storey ends at `start`: its middle points out of the doorway
  const start = dir + sweep / 2;
  const { brushes } = M.spiralStairs({ centre: [cx, cy], inner: 24, outer: 88, from, to: from + levels * STOREY, start, rise: 16, tread, thick: 16, texture: tex, columnTexture: tex });
  return brushes;
}
