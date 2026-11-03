// kit.mjs: the pieces New Byzantium is built from.
//
// The city is a list of SPACES (rooms, streets, halls, shafts) carved out of rock with SMAK's carvePlan,
// tile by tile so that no carve is bigger than a district; FITTINGS stand in the spaces (galleries, stairs,
// furniture, columns, the Nexus); ENTITIES are its doors, glass, lights and starts. A Bag holds all four.
import { M } from "../lib.mjs";

export const STOREY = 176; // floor to floor
export const ROOM_H = 160; // floor to ceiling in a room
export const WALL = 16; // rock between two spaces
export const DOOR = { w: 64, h: 160 }; // as tall as the room: a doorway cuts no lintel, so a storey is two bands of rock
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
 * A sliding door in a doorway box [x0, y0, z0, x1, y1, z1] (the box runs across a wall): a leaf 8 thick in
 * the middle of the wall that slides along the wall into it, or up when told.
 */
export function door(b, tex, { up = false, speed = 150, wait = 4, mesh = false, name, use = false } = {}) {
  const [x0, y0, z0, x1, y1, z1] = b;
  const alongX = x1 - x0 >= y1 - y0; // the wall runs along x when the doorway is wider in x
  const leaf = alongX
    ? M.box([x0, (y0 + y1) / 2 - 4, z0], [x1, (y0 + y1) / 2 + 4, z1], tex)
    : M.box([(x0 + x1) / 2 - 4, y0, z0], [(x0 + x1) / 2 + 4, y1, z1], tex);
  const keys = { angles: up ? "-90 0 0" : alongX ? "0 0 0" : "0 90 0", speed, wait, lip: up ? 8 : 4, spawnflags: use ? 256 : 0 };
  if (mesh || tex.startsWith("{")) Object.assign(keys, { rendermode: 4, renderamt: 255 });
  if (name) keys.targetname = name;
  return M.brushEntity("func_door", [leaf], keys);
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
      // a plain flat has a kitchen or a couch, not both, so most of its floor stays clear; a poor one a bag of rubbish
      const kitchen = lux || (!poor && rng() < 0.5);
      if (sides[0] && kitchen) against(sides[0], 128, 32, 40, { top: rng() < 0.5 ? "kit_stove" : "sink", bottom: "kit_wood1", sides: "kit_cupboard1" }, 0.8);
      if (sides[0] && lux) against(sides[0], 40, 32, 80, { top: "metal5", bottom: "metal5", sides: "KITCHEN-FRIDGE0" }, 0.2);
      if (sides[1] && (lux || (!poor && !kitchen))) against(sides[1], lux ? 112 : 96, 40, 32, T("hocouch3"), 0.5);
      if (poor && sides[0] && rng() < 0.5) against(sides[0], 32, 24, 8, T("po_subtrash"), rng());
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
      // a broken pallet and, now and then, a few bags: an emptied room, not a warehouse of crates
      against(pick(rng, walls), 48, 40, 6, T("crapwood1c"), rng());
      if (rng() < 0.5) against(pick(rng, walls), 40, 24, 12, T("po_subtrash"), rng());
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
      for (let i = 0; i < 2; i++) {
        const s = pick(rng, walls);
        const h = 4 + Math.floor(rng() * 3) * 4;
        against(s, 32 + Math.floor(rng() * 3) * 16, 24 + Math.floor(rng() * 2) * 8, h, T("po_subtrash"), rng());
      }
      break;
    default:
      break;
  }
  return out;
}

/**
 * Litter strewn along a street's walls, low enough to walk past: bin bags, broken pallets, rubble. `clear(box)`
 * says whether a heap may lie there; the city keeps every doorway and opening clear with it.
 */
export function debris(rect, along, z, count, rng, palette, clear = () => true) {
  const [x0, y0, x1, y1] = rect;
  const out = [];
  for (let i = 0; i < count; i++) {
    const t = rng();
    const side = rng() < 0.5;
    const u = along === "x" ? x0 + 48 + t * (x1 - x0 - 96) : y0 + 48 + t * (y1 - y0 - 96);
    const v = along === "x" ? (side ? y0 + 8 : y1 - 56) : side ? x0 + 8 : x1 - 56;
    const [px, py] = along === "x" ? [snap(u, 4), snap(v, 4)] : [snap(v, 4), snap(u, 4)];
    if (!clear([px - 16, py - 16, z, px + 64, py + 64, z + 64])) continue;
    const roll = rng();
    if (roll < 0.4) {
      const bags = 2 + Math.floor(rng() * 2);
      for (let b = 0; b < bags; b++) {
        const s = 16 + Math.floor(rng() * 3) * 4;
        const ox = snap(rng() * 24, 4);
        const oy = snap(rng() * 24, 4);
        out.push(M.box([px + ox, py + oy, z], [px + ox + s, py + oy + s - 4, z + 8 + Math.floor(rng() * 3) * 4], "po_subtrash"));
      }
    } else if (roll < 0.6) {
      out.push(M.box([px, py, z], [px + 48, py + 40, z + 6], T("crapwood1c")));
    } else if (roll < 0.9) {
      for (let j = 0; j < 3; j++) {
        const dx = snap((rng() - 0.5) * 48, 4);
        const dy = snap((rng() - 0.5) * 48, 4);
        const s = 4 + Math.floor(rng() * 3) * 4;
        out.push(M.box([px + 24 + dx, py + 24 + dy, z], [px + 24 + dx + s * 2, py + 24 + dy + s + 4, z + s], pick(rng, palette.rubble)));
      }
    }
  }
  return out;
}

/**
 * Trash along a street's walls: dumpsters, piles of bags, broken pallets and litter, `count` heaps of it.
 * `along` "x" or "y", the street box; returns detail brushes.
 */
export function trash(rect, along, z, count, rng, clear = () => true) {
  const [x0, y0, x1, y1] = rect;
  const out = [];
  const span = along === "x" ? x1 - x0 : y1 - y0;
  if (span < 160) return out;
  // a dumpster's side panel across its long faces and its end panel on its ends, each picture fitted to the box
  const longs = along === "x" ? ["north", "south"] : ["east", "west"];
  const ends = along === "x" ? ["east", "west"] : ["north", "south"];
  const dumpster = (lo, hi) => {
    const side = M.fitted("out_dmp2a", [80, 48], lo, hi, { whole: true, faces: longs, rest: "metal5" });
    const end = M.fitted("out_dmp2b", [48, 64], lo, hi, { whole: true, faces: ends, rest: "metal5" });
    return { ...end, ...Object.fromEntries(longs.map((f) => [f, side[f]])) };
  };
  for (let i = 0; i < count; i++) {
    const t = rng();
    const low = rng() < 0.5;
    const u = (along === "x" ? x0 : y0) + 64 + t * (span - 160);
    const wall = along === "x" ? (low ? y0 : y1) : low ? x0 : x1;
    const inward = low ? 1 : -1;
    const [f0, f1] = [Math.min(wall, wall + inward * 80), Math.max(wall, wall + inward * 80)];
    if (!clear(along === "x" ? [u - 16, f0, z, u + 136, f1, z + 64] : [f0, u - 16, z, f1, u + 136, z + 64])) continue;
    /** A box d deep off the wall, w along it, h high, starting at u: in world terms. `tex` may be a function of the box. */
    const piece = (du, w, d, h, tex, off = 0) => {
      const a0 = snap(u + du, 4);
      const n0 = wall + inward * off;
      const n1 = wall + inward * (off + d);
      const [m0, m1] = [Math.min(n0, n1), Math.max(n0, n1)];
      const lo = along === "x" ? [a0, m0, z] : [m0, a0, z];
      const hi = along === "x" ? [a0 + w, m1, z + h] : [m1, a0 + w, z + h];
      out.push(M.box(lo, hi, typeof tex === "function" ? tex(lo, hi) : tex));
    };
    const roll = rng();
    if (roll < 0.08) {
      piece(0, 72, 40, 48, dumpster, 4);
      if (rng() < 0.6) piece(80, 24, 20, 16, "po_subtrash", 6);
    } else if (roll < 0.62) {
      const bags = 2 + Math.floor(rng() * 3);
      for (let b = 0; b < bags; b++) {
        const s = 16 + Math.floor(rng() * 3) * 4;
        piece(b * 18 + snap(rng() * 8, 4), s, s - 4, 8 + Math.floor(rng() * 3) * 4, "po_subtrash", snap(rng() * 16, 4));
      }
    } else if (roll < 0.8) {
      piece(0, 48, 40, 6, { top: "crapwood1c", bottom: "crapwood1c", sides: "crapwood1c" }, 8);
      if (rng() < 0.5) piece(4, 40, 36, 12, { top: "crapwood1c", bottom: "crapwood1c", sides: "crapwood1c" }, 10);
    } else {
      for (let b = 0; b < 3; b++) piece(b * 40 + snap(rng() * 24, 4), 24, 16, 1, "po_subtrash", 24 + snap(rng() * 40, 4));
    }
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
